import { usersRepo } from '../db/repositories/usersRepo.js';
import { oauthTokensRepo } from '../db/repositories/oauthTokensRepo.js';
import { listingsRepo } from '../db/repositories/listingsRepo.js';
import { listingQueueRepo } from '../db/repositories/listingQueueRepo.js';
import { transactionsRepo } from '../db/repositories/transactionsRepo.js';
import { reviewsRepo } from '../db/repositories/reviewsRepo.js';
import { reportsRepo } from '../db/repositories/reportsRepo.js';
import { Config } from '../config/env.js';
import * as audit from './audit.js';

export class GdprError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GdprError';
    this.code = code;
  }
}

/** 7-day cooling-off period before a deletion request actually executes. */
export const RETRACTION_WINDOW_MS = 7 * 24 * 3600 * 1000;

const NON_TERMINAL_STATUSES = new Set([
  'PROPOSED',
  'ACCEPTED',
  'TRIAL',
  'TRIAL_VALIDATED',
  'TRANSFERRED',
  'DISPUTED',
]);

/**
 * Full export of the subject's own data. Third parties are represented only
 * where the subject has a legitimate interest (reviews they received), and
 * only pseudonymized (the author identity of a received review is never
 * exposed here).
 */
export async function exportData(tx, userId) {
  const user = await usersRepo.findById(tx, userId);
  if (!user) throw new GdprError('NOT_FOUND', 'User not found');

  const [listings, transactions, reviewsGiven, reviewsReceived, reports] = await Promise.all([
    listingsRepo.listByUser(tx, userId, { limit: 10_000 }),
    transactionsRepo.listByUser(tx, userId, { limit: 10_000 }),
    reviewsRepo.listByAuthor(tx, userId, { limit: 10_000 }),
    reviewsRepo.history(tx, userId, { limit: 1000 }),
    reportsRepo.listByReporter(tx, userId, { limit: 10_000 }),
  ]);

  return Object.freeze({
    profile: { id: user.id, discordId: user.discordId, username: user.username, createdAt: user.createdAt },
    listings,
    transactions: transactions.items,
    reviewsAuthored: reviewsGiven,
    reviewsReceived: reviewsReceived.items.map((r) => ({ ...r, authorId: undefined, author: 'utilisateur tiers' })),
    reportsFiled: reports,
    exportedAt: new Date().toISOString(),
  });
}

/** Limited to the profile fields a user can legitimately have corrected — Discord remains the source of truth for the rest. */
export async function rectify(tx, userId, patch) {
  const user = await usersRepo.findById(tx, userId);
  if (!user) throw new GdprError('NOT_FOUND', 'User not found');
  const updated = await usersRepo.upsertFromOAuth(tx, {
    discordId: user.discordId,
    username: patch.username ?? user.username,
    avatarHash: patch.avatarHash ?? user.avatarHash,
    bannerHash: patch.bannerHash ?? user.bannerHash,
  });
  await audit.record(tx, {
    actorId: userId,
    action: 'gdpr.rectified',
    targetType: 'user',
    targetId: userId,
    before: user,
    after: updated,
  });
  return updated;
}

export async function requestDeletion(tx, userId) {
  const blocking = (await transactionsRepo.listByUser(tx, userId, { limit: 1000 })).items.filter((t) =>
    NON_TERMINAL_STATUSES.has(t.status),
  );
  if (blocking.length > 0) {
    throw new GdprError('ERR_ACTIVE_TRANSACTION', JSON.stringify(blocking.map((t) => t.id)));
  }

  const updated = await usersRepo.requestDeletion(tx, userId);
  if (!updated) {
    return usersRepo.findById(tx, userId); // ERR_ALREADY_DELETED-adjacent: request already pending, idempotent
  }
  await audit.record(tx, {
    actorId: userId,
    action: 'gdpr.deletion_requested',
    targetType: 'user',
    targetId: userId,
    after: { deletionRequestedAt: updated.deletionRequestedAt },
  });
  return updated;
}

async function revokeDiscordToken(refreshTokenEnc) {
  // Best-effort: revocation failure never blocks pseudonymization (ERR_REVOKE_FAILED).
  try {
    await fetch('https://discord.com/api/oauth2/token/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: refreshTokenEnc,
        client_id: Config.discordClientId,
        client_secret: Config.discordClientSecret,
      }),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Executes a pending deletion: pseudonymizes the account, purges OAuth
 * tokens, hides listings, withdraws queue entries. Idempotent — a
 * once-deleted account is a no-op. `transactions`/`reviews`/`disputes`/
 * `audit_log` are never touched (FKs are RESTRICT): they keep pointing at
 * the now-pseudonymized account.
 */
export async function executeDeletion(tx, userId) {
  const user = await usersRepo.findById(tx, userId);
  if (!user) throw new GdprError('NOT_FOUND', 'User not found');
  if (user.deletedAt) return user; // ERR_ALREADY_DELETED -> idempotent no-op

  const tokens = await oauthTokensRepo.findByUserId(tx, userId);
  let revoked = true;
  if (tokens) {
    revoked = await revokeDiscordToken(tokens.refreshTokenEnc);
    await oauthTokensRepo.deleteByUserId(tx, userId);
  }

  const { items: listings } = await listingsRepo.listByUser(tx, userId, { limit: 1000 });
  for (const listing of listings) {
    if (listing.status === 'active') {
      await listingsRepo.updateFields(tx, listing.id, { status: 'hidden' });
    }
  }
  await listingQueueRepo.withdrawAllForUser(tx, userId);

  const pseudonymized = await usersRepo.pseudonymize(tx, userId);
  await audit.record(tx, {
    actorId: userId,
    action: 'gdpr.deletion_executed',
    targetType: 'user',
    targetId: userId,
    before: { discordId: user.discordId },
    after: { pseudonymized: true, discordRevoked: revoked },
  });
  return pseudonymized;
}
