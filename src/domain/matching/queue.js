import { advisoryXactLock } from '../../db/pool.js';
import { listingLockKey } from '../../config/lockKeys.js';
import { listingQueueRepo } from '../../db/repositories/listingQueueRepo.js';
import { listingsRepo } from '../../db/repositories/listingsRepo.js';
import { sanctionsRepo } from '../../db/repositories/sanctionsRepo.js';

export class QueueError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'QueueError';
    this.code = code;
  }
}

/**
 * Adds `candidateUserId` to the FIFO for `listingId` (mode `don`). Arrival
 * order is the only ordering — no reputation, community size or account age
 * ever breaks a tie (M4).
 */
export async function enqueue(tx, listingId, candidateUserId) {
  await advisoryXactLock(tx, listingLockKey(listingId));

  const listing = await listingsRepo.findById(tx, listingId);
  if (listing && listing.userId === candidateUserId) {
    throw new QueueError('ERR_SELF_QUEUE', 'Owner cannot queue on their own listing');
  }

  const activeSanction = await sanctionsRepo.findActiveOfKind(tx, candidateUserId, 'ban_perm');
  const activeTempBan = await sanctionsRepo.findActiveOfKind(tx, candidateUserId, 'ban_temp');
  if (activeSanction || activeTempBan) {
    throw new QueueError('ERR_BANNED', 'Candidate has an active platform ban');
  }

  const existing = await listingQueueRepo.findActiveEntry(tx, listingId, candidateUserId);
  if (existing) {
    throw new QueueError('ERR_ALREADY_QUEUED', 'Candidate is already queued on this listing');
  }

  const position = await listingQueueRepo.nextPosition(tx, listingId);
  await listingQueueRepo.insert(tx, { listingId, candidateUserId, position });
  return { position };
}

/** First non-skipped, non-withdrawn candidate, or `null` if the queue is empty. */
export async function dequeueHead(tx, listingId) {
  await advisoryXactLock(tx, listingLockKey(listingId));
  const head = await listingQueueRepo.head(tx, listingId);
  return head ? { candidateUserId: head.candidateUserId } : null;
}

/** The giver skips a candidate: advances the head, never reorders the rest of the queue. */
export async function skip(tx, listingId, candidateUserId, _reason) {
  await advisoryXactLock(tx, listingLockKey(listingId));
  await listingQueueRepo.skip(tx, listingId, candidateUserId);
}

/** A candidate withdraws: positions of everyone else stay stable, never renumbered. */
export async function withdraw(tx, listingId, candidateUserId) {
  await advisoryXactLock(tx, listingLockKey(listingId));
  await listingQueueRepo.withdraw(tx, listingId, candidateUserId);
}
