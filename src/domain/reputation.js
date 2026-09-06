import { reviewsRepo } from '../db/repositories/reviewsRepo.js';
import { transactionsRepo } from '../db/repositories/transactionsRepo.js';
import { sanctionsRepo } from '../db/repositories/sanctionsRepo.js';
import { usersRepo } from '../db/repositories/usersRepo.js';
import { settingsRepo } from '../db/repositories/settingsRepo.js';
import * as moderation from './moderation.js';
import * as audit from './audit.js';
import { SYSTEM_USER_ID } from '../config/systemUser.js';

export class ReputationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReputationError';
    this.code = code;
  }
}

const RATE_LIMIT_WINDOW_MS = 24 * 3600 * 1000;
const RATE_LIMIT_MAX = 5;

/**
 * Deposits a review. The only path to a review requires a *completed*
 * transaction whose author is a party — there is no way to create one
 * outside a transaction, which makes a fake review costly rather than
 * merely heuristically detected (M9).
 */
export async function submit(tx, authorId, transactionId, { rating, body = '' }) {
  const transaction = await transactionsRepo.findById(tx, transactionId);
  if (!transaction || !['TRANSFERRED', 'CLOSED'].includes(transaction.status)) {
    throw new ReputationError('ERR_NO_TRANSACTION', 'No completed transaction to review');
  }
  if (transaction.fromUserId !== authorId && transaction.toUserId !== authorId) {
    throw new ReputationError('ERR_NOT_PARTY', 'Actor is not a party to this transaction');
  }
  const targetId = transaction.fromUserId === authorId ? transaction.toUserId : transaction.fromUserId;
  if (authorId === targetId) {
    // Redundant with the DB CHECK (author_id <> target_id) — kept as a fast, explicit path.
    throw new ReputationError('ERR_SELF_REVIEW', 'Cannot review yourself');
  }

  const existing = await reviewsRepo.findByTransactionAndAuthor(tx, transactionId, authorId);
  if (existing) {
    throw new ReputationError('ERR_ALREADY_REVIEWED', 'A review already exists for this transaction');
  }

  const recentCount = await reviewsRepo.countRecentByAuthor(tx, authorId, new Date(Date.now() - RATE_LIMIT_WINDOW_MS));
  if (recentCount >= RATE_LIMIT_MAX) {
    await moderation.report(tx, SYSTEM_USER_ID, {
      targetType: 'user',
      targetId: authorId,
      reason: 'ERR_RATE_LIMITED',
      body: `More than ${RATE_LIMIT_MAX} reviews submitted by this user in 24h.`,
    });
    throw new ReputationError('ERR_RATE_LIMITED', 'Too many reviews in the last 24h');
  }

  const review = await reviewsRepo.insert(tx, { transactionId, authorId, targetId, rating, body });
  await evaluateVerified(tx, targetId);
  await audit.record(tx, {
    actorId: authorId,
    action: 'review.submitted',
    targetType: 'review',
    targetId: review.id,
    after: review,
  });
  return review;
}

export async function aggregate(tx, userId) {
  return reviewsRepo.aggregateForUser(tx, userId);
}

export async function history(tx, userId, page) {
  return reviewsRepo.history(tx, userId, page);
}

/**
 * Recomputes the "Vérifié" tag against `settings.verified_rules` — always
 * both grantable and revocable, never a one-way badge (M9).
 */
export async function evaluateVerified(tx, userId) {
  const rules = await settingsRepo.get(tx, 'verified_rules');
  const user = await usersRepo.findById(tx, userId);
  if (!user) return false;

  const [completedCount, ratingAgg, activeSanctions] = await Promise.all([
    transactionsRepo.countCompletedByUser(tx, userId),
    reviewsRepo.aggregateForUser(tx, userId),
    sanctionsRepo.findActiveByUser(tx, userId),
  ]);

  const accountAgeDays = (Date.now() - new Date(user.createdAt).getTime()) / 86_400_000;
  const eligible =
    completedCount >= rules.minTransactions &&
    (ratingAgg.average ?? 0) >= rules.minAverage &&
    accountAgeDays >= rules.minAccountAgeDays &&
    (!rules.noActiveSanction || activeSanctions.length === 0);

  if (eligible !== user.isVerified) {
    await usersRepo.setVerified(tx, userId, eligible);
    await audit.record(tx, {
      actorId: 'system',
      action: 'reputation.verified_recomputed',
      targetType: 'user',
      targetId: userId,
      before: { isVerified: user.isVerified },
      after: { isVerified: eligible },
    });
  }
  return eligible;
}
