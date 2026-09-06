import { withAdvisoryLock } from '../../db/pool.js';
import { LOCK_KEYS } from '../../config/lockKeys.js';
import { listingsRepo } from '../../db/repositories/listingsRepo.js';
import { matchRepo } from '../../db/repositories/matchRepo.js';
import { settingsRepo } from '../../db/repositories/settingsRepo.js';
import { publish, CHANNELS } from '../../bus/events.js';
import * as preferences from './preferences.js';
import * as ttc from './ttc.js';
import * as queue from './queue.js';
import * as trial from '../trial.js';

const COOLDOWN_MS = 24 * 3600 * 1000;

export class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

function pairKey(a, b) {
  return [a, b].sort().join(':');
}

/** Exported for `moderation.sanction`, which must dissolve a sanctioned user's open proposals too. */
export async function dissolveProposal(tx, proposal, participants, terminalStatus) {
  await matchRepo.setProposalStatus(tx, proposal.id, terminalStatus);
  const listingIds = [...new Set(participants.map((p) => p.listingId))];
  for (const listingId of listingIds) {
    await listingsRepo.updateFields(tx, listingId, { status: 'active' });
  }
  const userIds = participants.map((p) => p.userId);
  await matchRepo.setCooldownForGroup(tx, userIds, new Date(Date.now() + COOLDOWN_MS));
}

/** Persists one TTC cycle as a proposal. Re-checks every member is still `active` — if any
 *  vanished between computation and persistence (ERR_LISTING_VANISHED), the whole cycle is
 *  abandoned and nothing about it is written; it is simply recomputed next round. */
async function persistCycle(tx, members, byId, ttlHours) {
  await tx.query('BEGIN');
  try {
    for (const listingId of members) {
      const claimed = await listingsRepo.claimForMatch(tx, listingId);
      if (!claimed) {
        await tx.query('ROLLBACK');
        return false;
      }
    }
    const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);
    const participants = members.map((listingId, i) => ({
      listingId,
      userId: byId.get(listingId).userId,
      givesToListingId: members[(i + 1) % members.length],
    }));
    const { proposal } = await matchRepo.createProposal(tx, { kind: 'cycle', expiresAt, participants });
    await publish(tx, CHANNELS.EVENT_MATCH_PROPOSED, {
      proposalId: proposal.id,
      kind: 'cycle',
      listingIds: members,
    });
    await tx.query('COMMIT');
    return true;
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

async function persistQueueMatch(tx, listing, ttlHours) {
  const existingProposal = await matchRepo.findOpenProposalForListing(tx, listing.id);
  if (existingProposal) return false;

  await tx.query('BEGIN');
  try {
    const head = await queue.dequeueHead(tx, listing.id);
    if (!head) {
      await tx.query('ROLLBACK');
      return false;
    }
    const claimed = await listingsRepo.claimForMatch(tx, listing.id);
    if (!claimed) {
      await tx.query('ROLLBACK');
      return false;
    }
    const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);
    const { proposal } = await matchRepo.createProposal(tx, {
      kind: 'queue',
      expiresAt,
      participants: [
        { listingId: listing.id, userId: listing.userId, givesToListingId: null },
        { listingId: listing.id, userId: head.candidateUserId, givesToListingId: null },
      ],
    });
    await publish(tx, CHANNELS.EVENT_MATCH_PROPOSED, {
      proposalId: proposal.id,
      kind: 'queue',
      listingIds: [listing.id],
    });
    await tx.query('COMMIT');
    return true;
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/**
 * Runs one complete matching round: don (FIFO) and échange (TTC) together,
 * v1 scope, no lighter version (A6/A8). Two rounds never run concurrently
 * (advisory lock) — a round already in progress returns `{ cyclesFound: 0,
 * proposalsCreated: 0 }` immediately rather than queuing up.
 */
export async function runRound(pool) {
  const result = await withAdvisoryLock(pool, LOCK_KEYS.MATCH_ROUND, async (tx) => {
    const now = new Date();

    // No dedicated job exists for proposal expiry (jobs/main.js lists 5
    // sub-jobs, none of them this) — a round is the natural place to sweep
    // expired proposals back into the pool before computing a new one.
    const expiredProposals = await matchRepo.findExpiredOpenProposals(tx, now);
    for (const proposal of expiredProposals) {
      const { participants } = await matchRepo.getProposal(tx, proposal.id);
      await dissolveProposal(tx, proposal, participants, 'expired');
    }

    const echangeListings = await listingsRepo.listActive(tx, { mode: 'echange' });
    const donListings = await listingsRepo.listActive(tx, { mode: 'don' });
    const cooldownPairs = await matchRepo.listActiveCooldownPairs(tx, now);
    const cooldownSet = new Set(cooldownPairs.map(([a, b]) => pairKey(a, b)));
    const ttlHours = await settingsRepo.get(tx, 'match_proposal_ttl_hours');

    let cyclesFound = 0;
    let proposalsCreated = 0;

    if (echangeListings.length > 0) {
      const byId = new Map(echangeListings.map((l) => [l.id, l]));
      const prefs = new Map();
      for (const listing of echangeListings) {
        const candidates = echangeListings.filter(
          (c) => c.id !== listing.id && !cooldownSet.has(pairKey(listing.userId, c.userId)),
        );
        prefs.set(listing.id, preferences.build(listing, candidates));
      }
      const cycles = ttc.run(echangeListings, prefs);
      cyclesFound = cycles.length;

      for (const cycle of cycles) {
        if (await persistCycle(tx, cycle.members, byId, ttlHours)) {
          proposalsCreated += 1;
        }
      }
    }

    for (const listing of donListings) {
      if (await persistQueueMatch(tx, listing, ttlHours)) {
        proposalsCreated += 1;
      }
    }

    return { cyclesFound, proposalsCreated };
  });

  return result ?? { cyclesFound: 0, proposalsCreated: 0 }; // ERR_ROUND_BUSY
}

export async function accept(tx, userId, proposalId) {
  const found = await matchRepo.getProposal(tx, proposalId);
  if (!found) throw new EngineError('NOT_FOUND', 'Proposal not found');
  const { proposal, participants } = found;

  if (!participants.some((p) => p.userId === userId)) {
    throw new EngineError('ERR_NOT_PARTICIPANT', 'Actor is not a party to this proposal');
  }
  if (proposal.status !== 'open') {
    throw new EngineError('ERR_PROPOSAL_EXPIRED', 'Proposal is no longer open');
  }
  if (new Date(proposal.expiresAt) < new Date()) {
    await dissolveProposal(tx, proposal, participants, 'expired');
    throw new EngineError('ERR_PROPOSAL_EXPIRED', 'Proposal expired');
  }

  const updated = await matchRepo.recordAcceptance(tx, proposalId, userId);
  const allAccepted = updated.every((p) => p.acceptedAt);
  if (allAccepted) {
    await matchRepo.setProposalStatus(tx, proposalId, 'accepted');
    await trial.open(tx, proposalId);
  }
  return { allAccepted };
}

export async function refuse(tx, userId, proposalId, reason) {
  const found = await matchRepo.getProposal(tx, proposalId);
  if (!found) throw new EngineError('NOT_FOUND', 'Proposal not found');
  const { proposal, participants } = found;

  if (!participants.some((p) => p.userId === userId)) {
    throw new EngineError('ERR_NOT_PARTICIPANT', 'Actor is not a party to this proposal');
  }
  await matchRepo.recordRefusal(tx, proposalId, userId, reason);
  await dissolveProposal(tx, proposal, participants, 'refused');
}
