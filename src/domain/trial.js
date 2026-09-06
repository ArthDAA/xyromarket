import { transactionsRepo } from '../db/repositories/transactionsRepo.js';
import { matchRepo } from '../db/repositories/matchRepo.js';
import { listingsRepo } from '../db/repositories/listingsRepo.js';
import { usersRepo } from '../db/repositories/usersRepo.js';
import { settingsRepo } from '../db/repositories/settingsRepo.js';
import { pendingNotificationsRepo } from '../db/repositories/pendingNotificationsRepo.js';
import { publish, CHANNELS } from '../bus/events.js';
import * as audit from './audit.js';

export class TrialError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TrialError';
    this.code = code;
  }
}

/** Exhaustive, closed transition table — nothing outside this is a legal move. */
const TRANSITIONS = {
  PROPOSED: ['ACCEPTED', 'CANCELLED'],
  ACCEPTED: ['TRIAL', 'CANCELLED'],
  TRIAL: ['TRIAL_VALIDATED', 'TRANSFERRED', 'CANCELLED', 'EXPIRED'], // TRIAL->TRANSFERRED: early transfer, transfer.js
  TRIAL_VALIDATED: ['TRANSFERRED'],
  TRANSFERRED: ['DISPUTED', 'CLOSED'],
  DISPUTED: ['CLOSED'],
  CANCELLED: [],
  EXPIRED: [],
  CLOSED: [],
};

function assertTransition(current, next) {
  if (!(TRANSITIONS[current] ?? []).includes(next)) {
    throw new TrialError('ERR_BAD_TRANSITION', `Cannot transition from ${current} to ${next}`);
  }
}

async function applyTransition(tx, transaction, next, { actorId = 'system' } = {}) {
  assertTransition(transaction.status, next);
  const updated = await transactionsRepo.setStatus(tx, transaction.id, next);
  await publish(tx, CHANNELS.EVENT_TRANSACTION_UPDATED, {
    transactionId: transaction.id,
    from: transaction.status,
    to: next,
  });
  await audit.record(tx, {
    actorId,
    action: 'transaction.status_changed',
    targetType: 'transaction',
    targetId: transaction.id,
    before: { status: transaction.status },
    after: { status: next },
  });
  return updated;
}

async function resolveDiscordId(tx, userId) {
  const user = await usersRepo.findById(tx, userId);
  return user?.discordId ?? null;
}

/** Finds the listing that made up this transaction's edge, to release it back to `active`. */
async function restoreListingForTransaction(tx, transaction) {
  const found = await matchRepo.getProposal(tx, transaction.proposalId);
  if (!found) return;
  for (const participant of found.participants) {
    if (participant.userId !== transaction.fromUserId) continue;
    const listing = await listingsRepo.findById(tx, participant.listingId);
    if (listing && listing.guildId === transaction.guildId && listing.status === 'matched') {
      await listingsRepo.updateFields(tx, listing.id, { status: 'active' });
    }
    return;
  }
}

/**
 * Creates one transaction per guild handover implied by a fully-accepted
 * proposal (one for `queue`, one per edge of a `cycle`), and immediately
 * moves each to ACCEPTED. `fromUserId` is always the guild's real, current
 * owner — `toUserId` the recipient who will receive the trial role.
 */
export async function open(tx, proposalId) {
  const found = await matchRepo.getProposal(tx, proposalId);
  if (!found) throw new TrialError('NOT_FOUND', 'Proposal not found');
  const { proposal, participants } = found;

  const edges = [];
  if (proposal.kind === 'queue') {
    const listing = await listingsRepo.findById(tx, participants[0].listingId);
    const giver = participants.find((p) => p.userId === listing.userId);
    const receiver = participants.find((p) => p.userId !== listing.userId);
    edges.push({ fromUserId: giver.userId, toUserId: receiver.userId, guildId: listing.guildId });
  } else {
    const listingCache = new Map();
    async function listingOf(id) {
      if (!listingCache.has(id)) listingCache.set(id, await listingsRepo.findById(tx, id));
      return listingCache.get(id);
    }
    for (const participant of participants) {
      const ownListing = await listingOf(participant.listingId);
      const targetListing = await listingOf(participant.givesToListingId);
      edges.push({ fromUserId: participant.userId, toUserId: targetListing.userId, guildId: ownListing.guildId });
    }
  }

  const created = [];
  for (const edge of edges) {
    const transaction = await transactionsRepo.insert(tx, {
      proposalId,
      fromUserId: edge.fromUserId,
      toUserId: edge.toUserId,
      guildId: edge.guildId,
      status: 'PROPOSED',
    });
    const accepted = await applyTransition(tx, transaction, 'ACCEPTED');

    const [fromDiscordId, toDiscordId] = await Promise.all([
      resolveDiscordId(tx, edge.fromUserId),
      resolveDiscordId(tx, edge.toUserId),
    ]);
    await publish(tx, CHANNELS.INTENT_HUB_THREAD_CREATE, {
      transactionId: accepted.id,
      participantDiscordIds: [fromDiscordId, toDiscordId],
    });
    await publish(tx, CHANNELS.INTENT_TRIAL_ASSIGN, {
      guildId: edge.guildId,
      memberDiscordId: toDiscordId,
      transactionId: accepted.id,
    });
    created.push(accepted);
  }
  return created;
}

/**
 * Called in-process by `bot/trialRole.js` once the Discord role assignment
 * for this transaction actually succeeded. Starts the trial clock — never
 * before this confirmation (a role never assigned must never be timed).
 */
export async function confirmTrialStarted(tx, transactionId, roleId) {
  const transaction = await transactionsRepo.lockById(tx, transactionId);
  if (!transaction) throw new TrialError('NOT_FOUND', 'Transaction not found');
  if (transaction.status === 'TRIAL') return transaction; // idempotent replay
  const trialDurationDays = await settingsRepo.get(tx, 'trial_duration_days');
  const trialStartedAt = new Date();
  const trialEndsAt = new Date(trialStartedAt.getTime() + trialDurationDays * 86_400_000);
  await transactionsRepo.setTrialWindow(tx, transactionId, { trialStartedAt, trialEndsAt, trialRoleId: roleId });
  return applyTransition(tx, transaction, 'TRIAL', { actorId: 'bot' });
}

/** Called in-process by `bot/trialRole.js` on ERR_ROLE_ASSIGN_FAILED / ERR_HIERARCHY_TOO_LOW / ERR_MEMBER_NOT_IN_GUILD. */
export async function reportRoleAssignFailed(tx, transactionId, reason) {
  const transaction = await transactionsRepo.lockById(tx, transactionId);
  if (!transaction || transaction.status !== 'ACCEPTED') return; // nothing to roll back — clock never started
  await audit.record(tx, {
    actorId: 'bot',
    action: 'trial.role_assign_failed',
    targetType: 'transaction',
    targetId: transactionId,
    after: { reason },
  });
}

/** Bilateral validation. Idempotent: revalidating one's own side is a no-op, not an error. */
export async function validate(tx, userId, transactionId) {
  const transaction = await transactionsRepo.lockById(tx, transactionId);
  if (!transaction) throw new TrialError('NOT_FOUND', 'Transaction not found');
  if (transaction.fromUserId !== userId && transaction.toUserId !== userId) {
    throw new TrialError('ERR_NOT_PARTY', 'Actor is not a party to this transaction');
  }

  const side = transaction.fromUserId === userId ? 'from' : 'to';
  const alreadyValidated = side === 'from' ? transaction.validatedByFromAt : transaction.validatedByToAt;
  if (alreadyValidated) {
    return transaction; // ERR_ALREADY_VALIDATED -> idempotent no-op, 200
  }
  if (transaction.status !== 'TRIAL') {
    throw new TrialError('ERR_BAD_TRANSITION', `Cannot validate from ${transaction.status}`);
  }

  const updated = await transactionsRepo.recordValidation(tx, transactionId, side);
  if (updated.validatedByFromAt && updated.validatedByToAt) {
    return applyTransition(tx, updated, 'TRIAL_VALIDATED');
  }
  return updated;
}

async function cancelOne(tx, actorId, transactionId, reason) {
  const transaction = await transactionsRepo.lockById(tx, transactionId);
  if (!transaction) throw new TrialError('NOT_FOUND', 'Transaction not found');
  if (!['system', 'bot'].includes(actorId) && transaction.fromUserId !== actorId && transaction.toUserId !== actorId) {
    throw new TrialError('ERR_NOT_PARTY', 'Actor is not a party to this transaction');
  }
  assertTransition(transaction.status, 'CANCELLED');

  const wasInTrial = transaction.status === 'TRIAL';
  await transactionsRepo.resetValidation(tx, transactionId);
  const updated = await applyTransition(tx, transaction, 'CANCELLED', { actorId });

  if (wasInTrial) {
    await publish(tx, CHANNELS.INTENT_TRIAL_REVOKE, {
      guildId: transaction.guildId,
      memberDiscordId: await resolveDiscordId(tx, transaction.toUserId),
      transactionId,
      reason,
    });
  }
  await restoreListingForTransaction(tx, transaction);
  return updated;
}

/**
 * Cancels a transaction still in PROPOSED/ACCEPTED/TRIAL. `actorId` is
 * either party, or `'bot'`/`'system'` for automated cancellations
 * (`TRIAL_RECIPIENT_REMOVED`, `TRIAL_ROLE_REMOVED`, trial expiry's sibling
 * path). Revokes the trial role if one was assigned, and releases the
 * underlying listing back to `active`.
 *
 * A cycle's fairness (TTC's core-allocation guarantee) only holds if every
 * edge happens together: cancelling one edge of a 3+-party cycle without
 * cancelling the rest would strand a party who already gave up what they
 * were promised while still owing their own guild. So this cascades to
 * every sibling transaction born from the same proposal — a sibling that
 * can no longer legally reach CANCELLED (already TRANSFERRED, or already
 * terminal on its own) is left untouched, not forced backwards.
 */
export async function cancel(tx, actorId, transactionId, reason) {
  const cancelled = await cancelOne(tx, actorId, transactionId, reason);

  const siblings = await transactionsRepo.findByProposalId(tx, cancelled.proposalId);
  for (const sibling of siblings) {
    if (sibling.id === transactionId) continue;
    try {
      await cancelOne(tx, 'system', sibling.id, `cascade:${reason}`);
    } catch (err) {
      if (err instanceof TrialError && err.code === 'ERR_BAD_TRANSITION') continue; // already resolved on its own
      throw err;
    }
  }

  return cancelled;
}

/** `jobs.trialExpiry`: a trial past `trial_ends_at` without double validation. */
export async function expire(tx, transactionId) {
  const transaction = await transactionsRepo.lockById(tx, transactionId);
  if (!transaction) throw new TrialError('NOT_FOUND', 'Transaction not found');
  if (transaction.status !== 'TRIAL') return transaction; // idempotent: already moved on

  await transactionsRepo.resetValidation(tx, transactionId);
  const updated = await applyTransition(tx, transaction, 'EXPIRED');
  await publish(tx, CHANNELS.INTENT_TRIAL_REVOKE, {
    guildId: transaction.guildId,
    memberDiscordId: await resolveDiscordId(tx, transaction.toUserId),
    transactionId,
    reason: 'TRIAL_EXPIRED',
  });
  await restoreListingForTransaction(tx, transaction);

  // No off-platform delivery channel decided yet (Q1) — persist intent only.
  // TODO: canal de notification externe non tranché (Q1)
  for (const userId of [transaction.fromUserId, transaction.toUserId]) {
    await pendingNotificationsRepo.insert(tx, {
      userId,
      eventType: 'trial.expire',
      payload: { transactionId },
    });
  }

  // Same cycle-fairness cascade as cancel(): one edge timing out must not strand the
  // other edges of a 3+-party cycle mid-trade. Those edges are cancelled, not expired
  // themselves — their own clock didn't run out, this one's did.
  const siblings = await transactionsRepo.findByProposalId(tx, transaction.proposalId);
  for (const sibling of siblings) {
    if (sibling.id === transactionId) continue;
    try {
      await cancelOne(tx, 'system', sibling.id, 'cascade:TRIAL_EXPIRED');
    } catch (err) {
      if (err instanceof TrialError && err.code === 'ERR_BAD_TRANSITION') continue;
      throw err;
    }
  }

  return updated;
}

/** Opens a post-transfer dispute — called by `dispute.open`, never writes `transactions.status` elsewhere. */
export async function openDispute(tx, transactionId) {
  const transaction = await transactionsRepo.lockById(tx, transactionId);
  if (!transaction) throw new TrialError('NOT_FOUND', 'Transaction not found');
  return applyTransition(tx, transaction, 'DISPUTED', { actorId: 'system' });
}

/** Terminal close — either the dispute window elapsed uneventfully, or a dispute resolved. */
export async function close(tx, transactionId) {
  const transaction = await transactionsRepo.lockById(tx, transactionId);
  if (!transaction) throw new TrialError('NOT_FOUND', 'Transaction not found');
  if (transaction.status === 'CLOSED') return transaction; // idempotent
  await applyTransition(tx, transaction, 'CLOSED', { actorId: 'system' });
  return transactionsRepo.setClosed(tx, transactionId, new Date());
}

/**
 * The only path to TRANSFERRED — driven exclusively by `transfer.js`
 * reacting to an `ownership.js` observation, never by a party's declaration.
 */
export async function markTransferred(tx, transactionId, observedAt) {
  const transaction = await transactionsRepo.lockById(tx, transactionId);
  if (!transaction) throw new TrialError('NOT_FOUND', 'Transaction not found');
  if (transaction.transferredAt) return transaction; // idempotent: already recorded
  assertTransition(transaction.status, 'TRANSFERRED');

  await transactionsRepo.setTransferred(tx, transactionId, observedAt);
  return applyTransition(tx, transaction, 'TRANSFERRED', { actorId: 'bot' });
}
