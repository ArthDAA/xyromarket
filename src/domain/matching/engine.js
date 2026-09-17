import { withAdvisoryLock } from '../../db/pool.js';
import { LOCK_KEYS } from '../../config/lockKeys.js';
import { listingsRepo } from '../../db/repositories/listingsRepo.js';
import { matchRepo } from '../../db/repositories/matchRepo.js';
import { transactionsRepo } from '../../db/repositories/transactionsRepo.js';
import { settingsRepo } from '../../db/repositories/settingsRepo.js';
import { publish, CHANNELS } from '../../bus/events.js';
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

function hasOverlap(a, b) {
  const setB = new Set(b);
  return a.some((tag) => setB.has(tag));
}

/**
 * Exported for `moderation.sanction`, which must dissolve a sanctioned user's
 * open proposals too. Since A20, every open proposal already has its
 * `PROPOSED`/`ACCEPTED` transaction(s) and hub thread(s) — cancelling one
 * cascades to every sibling transaction born from the same proposal
 * (`trial.cancel`), which also restores each listing to `active` and posts
 * the outcome into the thread the parties were already using. The manual
 * listing-restore loop only runs as a defensive fallback for a proposal
 * that somehow has no transaction yet.
 */
export async function dissolveProposal(tx, proposal, participants, terminalStatus) {
  await matchRepo.setProposalStatus(tx, proposal.id, terminalStatus);

  const transactions = await transactionsRepo.findByProposalId(tx, proposal.id);
  const openTransaction = transactions.find((t) => !['CANCELLED', 'EXPIRED'].includes(t.status));
  if (openTransaction) {
    await trial.cancel(tx, 'system', openTransaction.id, terminalStatus);
  } else {
    const listingIds = [...new Set(participants.map((p) => p.listingId))];
    for (const listingId of listingIds) {
      await listingsRepo.updateFields(tx, listingId, { status: 'active' });
    }
  }

  const userIds = participants.map((p) => p.userId);
  await matchRepo.setCooldownForGroup(tx, userIds, new Date(Date.now() + COOLDOWN_MS));
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
    // A20: hub thread opens now, not after both accept — the giver and the queued
    // candidate can talk before either commits, not only once already locked in.
    await trial.createTransactions(tx, proposal.id);
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
 * Runs one matching round for `don` (FIFO) listings, plus the proposal-expiry
 * sweep shared with `echange`. `échange` no longer has an automatic discovery
 * step here — A19 replaced the TTC n-cycle engine with `proposeDirectSwap`,
 * a deliberate action an owner takes after finding a compatible listing
 * themselves (`/annonces?mode=echange&tags=...`). Two rounds never run
 * concurrently (advisory lock) — a round already in progress returns
 * `{ proposalsCreated: 0 }` immediately rather than queuing up.
 */
export async function runRound(pool) {
  const result = await withAdvisoryLock(pool, LOCK_KEYS.MATCH_ROUND, async (tx) => {
    const now = new Date();

    // No dedicated job exists for proposal expiry (jobs/main.js lists 5
    // sub-jobs, none of them this) — a round is the natural place to sweep
    // expired proposals back into the pool before computing a new one. Still
    // needed post-A19: a manually-proposed direct swap can expire unanswered
    // just like a queue match could.
    const expiredProposals = await matchRepo.findExpiredOpenProposals(tx, now);
    for (const proposal of expiredProposals) {
      const { participants } = await matchRepo.getProposal(tx, proposal.id);
      await dissolveProposal(tx, proposal, participants, 'expired');
    }

    const donListings = await listingsRepo.listActive(tx, { mode: 'don' });
    const ttlHours = await settingsRepo.get(tx, 'match_proposal_ttl_hours');

    let proposalsCreated = 0;
    for (const listing of donListings) {
      if (await persistQueueMatch(tx, listing, ttlHours)) {
        proposalsCreated += 1;
      }
    }

    return { proposalsCreated };
  });

  return result ?? { proposalsCreated: 0 }; // ERR_ROUND_BUSY
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
    // The transaction(s) and hub thread(s) already exist since `createTransactions`
    // ran at proposal creation (A20) — this only promotes them to ACCEPTED.
    await trial.confirmAccepted(tx, proposalId);
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

/**
 * A19: replaces the automatic TTC n-cycle engine. Initiating an `echange` is
 * now always a deliberate 1:1 action — the actor found `theirListingId`
 * themselves (typically via `/annonces?mode=echange&tags=...`) and offers
 * `myListingId` in return. Mechanically this is just a 2-member cycle —
 * identical `match_proposals`/`match_participants` shape to what the old TTC
 * engine produced (`kind: 'cycle'`), so `accept`/`refuse` above need no
 * change at all to handle it.
 */
export async function proposeDirectSwap(tx, actorUserId, myListingId, theirListingId) {
  if (myListingId === theirListingId) {
    throw new EngineError('ERR_SELF_SWAP', 'Cannot propose a swap with your own listing');
  }
  const mine = await listingsRepo.findById(tx, myListingId);
  const theirs = await listingsRepo.findById(tx, theirListingId);
  if (!mine || !theirs) throw new EngineError('NOT_FOUND', 'Listing not found');
  if (mine.userId !== actorUserId) throw new EngineError('ERR_NOT_OWNER', 'Not your listing');
  if (theirs.userId === actorUserId) {
    throw new EngineError('ERR_SELF_SWAP', 'Cannot propose a swap with your own listing');
  }
  if (mine.mode !== 'echange' || theirs.mode !== 'echange') {
    throw new EngineError('ERR_MODE_MISMATCH', 'Both listings must be in échange mode');
  }
  // Any of the actor's own échange listings can be offered here (A19's browse-and-propose
  // flow never filters the picker by tags) — this is the one place the trade is actually
  // validated, downstream of that free choice: each side must offer something the other is
  // seeking, both ways, or there is nothing to trade. Same correspondence the old TTC engine
  // required per edge (`preferences.js`, removed by A19), just as a plain gate instead of a
  // ranking now that there is no cycle to score.
  if (!hasOverlap(mine.tags, theirs.seekingTags) || !hasOverlap(theirs.tags, mine.seekingTags)) {
    throw new EngineError('ERR_TAG_MISMATCH', 'Neither listing offers what the other is seeking');
  }
  if (await matchRepo.isOnCooldown(tx, mine.userId, theirs.userId, new Date())) {
    throw new EngineError('ERR_COOLDOWN', 'A recent refusal between these two owners is still on cooldown');
  }

  // `claimForMatch` is the atomicity guard (`WHERE status = 'active'`) — if either fails,
  // throwing here rolls back the caller's transaction, undoing the other claim too.
  const claimedMine = await listingsRepo.claimForMatch(tx, myListingId);
  if (!claimedMine) throw new EngineError('ERR_LISTING_LOCKED', 'Your listing is no longer active');
  const claimedTheirs = await listingsRepo.claimForMatch(tx, theirListingId);
  if (!claimedTheirs) throw new EngineError('ERR_LISTING_LOCKED', 'The target listing is no longer active');

  const ttlHours = await settingsRepo.get(tx, 'match_proposal_ttl_hours');
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);
  const { proposal } = await matchRepo.createProposal(tx, {
    kind: 'cycle',
    expiresAt,
    participants: [
      { listingId: myListingId, userId: actorUserId, givesToListingId: theirListingId },
      { listingId: theirListingId, userId: theirs.userId, givesToListingId: myListingId },
    ],
  });
  // A20: opens the hub thread right now, before either side has committed — the whole
  // point of proposing a *specific* swap is to be able to discuss it, not to be connected
  // only after a blind accept. `confirmAccepted` (via `accept` below) still gates the
  // trial role assignment on both sides actually agreeing.
  await trial.createTransactions(tx, proposal.id);
  await publish(tx, CHANNELS.EVENT_MATCH_PROPOSED, {
    proposalId: proposal.id,
    kind: 'cycle',
    listingIds: [myListingId, theirListingId],
  });

  // Proposing is itself the proposer's consent — only the other side still has a decision
  // to make. Reuses `accept` rather than duplicating its participant/expiry checks.
  const { allAccepted } = await accept(tx, actorUserId, proposal.id);
  return { proposal, allAccepted };
}
