import { withTransaction } from '../db/pool.js';
import { settingsRepo } from '../db/repositories/settingsRepo.js';

/**
 * In-memory cache of `settings.hub_invite_url`, for the header's "Rejoindre
 * le Discord" button (`render.js:layout`) — that function is synchronous
 * and runs on every single response, so it can't itself await a DB read.
 * Refreshed at boot and on a slow interval (`main.js`), not per request:
 * the value only changes when the bot regenerates its permanent invite
 * (`bot/hub.js:ensureHubInvite`), which is essentially never.
 */
let cached = null;

export function getCachedHubInviteUrl() {
  return cached;
}

export async function refreshHubInviteUrl(pool) {
  cached = await withTransaction(pool, (tx) => settingsRepo.get(tx, 'hub_invite_url'));
  return cached;
}
