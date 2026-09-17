import { randomBytes, createCipheriv, createDecipheriv, randomUUID } from 'node:crypto';
import { Config } from '../../config/env.js';
import { usersRepo } from '../../db/repositories/usersRepo.js';
import { guildsRepo } from '../../db/repositories/guildsRepo.js';
import { oauthTokensRepo } from '../../db/repositories/oauthTokensRepo.js';
import { transactionsRepo } from '../../db/repositories/transactionsRepo.js';
import * as ownership from '../../domain/ownership.js';

export class OAuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
  }
}

const SCOPES = 'identify guilds';
export const STATE_TTL_MS = 10 * 60 * 1000;
const KEY_VERSION = 'v1';

/**
 * Generates a fresh `state` and the Discord authorize URL. The caller (the
 * `/auth/discord` route) is responsible for binding `state` to the visitor
 * — via a short-lived signed cookie, since there is no session yet at this
 * point in the flow — and for passing that same value back into
 * `handleCallback` as `expectedState`.
 */
export function buildAuthUrl() {
  const state = randomUUID();
  const url = new URL('https://discord.com/api/oauth2/authorize');
  url.searchParams.set('client_id', Config.discordClientId);
  url.searchParams.set('redirect_uri', `${Config.publicBaseUrl}/auth/discord/callback`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', state);
  return { url: url.toString(), state };
}

// Manage Roles (M15) + View Audit Log (M6/A22) + Send Messages, Manage Threads,
// Create Private Threads, Send Messages in Threads (hub) + Create Instant Invite
// (A34 — inviting a trial recipient who isn't yet a member of the target guild)
// — cf. README §Configuration Discord.
const BOT_INVITE_PERMISSIONS = '361045690497';

/**
 * Discord invite URL for a specific guild, pre-selected and locked
 * (`guild_id` + `disable_guild_select`) so the owner can't accidentally add
 * the bot to the wrong server. Used to send an owner straight to the invite
 * screen right after publishing an annonce whose guild doesn't have the bot
 * yet (`listing.status === 'pending_bot'`).
 */
export function buildBotInviteUrl(guildId) {
  const url = new URL('https://discord.com/api/oauth2/authorize');
  url.searchParams.set('client_id', Config.discordClientId);
  // `applications.commands` alongside `bot` — without it, Discord refuses any guild-scoped
  // slash command registration on that guild (`PUT .../guilds/{id}/commands` -> 50001 Missing
  // Access, cf. `bot/main.js:registerCommands`). Every guild invited before this fix is still
  // missing it and needs a fresh invite (or a manual grant) to actually get `/signaler`.
  url.searchParams.set('scope', 'bot applications.commands');
  url.searchParams.set('permissions', BOT_INVITE_PERMISSIONS);
  url.searchParams.set('guild_id', guildId);
  url.searchParams.set('disable_guild_select', 'true');
  return url.toString();
}

function consumeState(state, expectedState) {
  if (!expectedState || state !== expectedState) {
    throw new OAuthError('ERR_STATE_MISMATCH', 'OAuth state is missing, expired, or does not match');
  }
}

/** AES-256-GCM under TOKEN_ENC_KEY, versioned so key rotation never requires a one-shot migration. */
function encryptToken(plaintext) {
  const key = Buffer.from(Config.tokenEncKey, 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${KEY_VERSION}:${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

export function decryptToken(stored) {
  const [version, ivB64, tagB64, ctB64] = stored.split(':');
  if (version !== KEY_VERSION) {
    throw new OAuthError('ERR_KEY_VERSION_UNKNOWN', `Unknown token key version: ${version}`);
  }
  const key = Buffer.from(Config.tokenEncKey, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

async function exchangeCode(code) {
  const response = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: Config.discordClientId,
      client_secret: Config.discordClientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${Config.publicBaseUrl}/auth/discord/callback`,
    }),
  });
  if (!response.ok) {
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after') ?? '1');
      throw new OAuthError('ERR_DISCORD_RATE_LIMIT', `Retry after ${retryAfter}s`);
    }
    throw new OAuthError('ERR_CODE_EXCHANGE', `Discord token exchange failed: ${response.status}`);
  }
  return response.json();
}

async function discordFetch(path, accessToken) {
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after') ?? '1');
    throw new OAuthError('ERR_DISCORD_RATE_LIMIT', `Retry after ${retryAfter}s`);
  }
  if (!response.ok) {
    throw new OAuthError('ERR_CODE_EXCHANGE', `Discord API call failed: ${path} -> ${response.status}`);
  }
  return response.json();
}

/**
 * Completes the OAuth2 code grant: exchanges the code, fetches identity and
 * owned guilds (`owner === true` only), upserts `users`/`guilds`, observes
 * ownership for each owned guild, and stores encrypted tokens.
 */
export async function handleCallback(tx, { code, state, expectedState }) {
  consumeState(state, expectedState);
  const tokenResponse = await exchangeCode(code);

  const [me, guilds] = await Promise.all([
    discordFetch('/users/@me', tokenResponse.access_token),
    discordFetch('/users/@me/guilds', tokenResponse.access_token),
  ]);

  const user = await usersRepo.upsertFromOAuth(tx, {
    discordId: me.id,
    username: me.username,
    avatarHash: me.avatar,
  });

  const ownedGuilds = guilds.filter((g) => g.owner === true);
  for (const g of ownedGuilds) {
    await guildsRepo.ensureExists(tx, { id: g.id, name: g.name, ownerDiscordId: me.id });
    await ownership.observe(tx, {
      guildId: g.id,
      ownerDiscordId: me.id,
      source: 'oauth',
      observedAt: new Date(),
    });
  }

  await oauthTokensRepo.upsert(tx, {
    userId: user.id,
    accessTokenEnc: encryptToken(tokenResponse.access_token),
    refreshTokenEnc: encryptToken(tokenResponse.refresh_token),
    expiresAt: new Date(Date.now() + tokenResponse.expires_in * 1000),
    scopes: SCOPES.split(' '),
  });

  return { user, ownedGuilds };
}

/** Transparent refresh; a failed refresh means "disconnect and ask to reconnect", never stale data served silently. */
export async function refresh(tx, userId) {
  const tokens = await oauthTokensRepo.findByUserId(tx, userId);
  if (!tokens) throw new OAuthError('ERR_TOKEN_EXPIRED', 'No stored tokens for this user');

  const response = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: Config.discordClientId,
      client_secret: Config.discordClientSecret,
      grant_type: 'refresh_token',
      refresh_token: decryptToken(tokens.refreshTokenEnc),
    }),
  });
  if (!response.ok) {
    throw new OAuthError('ERR_TOKEN_EXPIRED', 'Refresh failed — reconnection required');
  }
  const data = await response.json();
  return oauthTokensRepo.upsert(tx, {
    userId,
    accessTokenEnc: encryptToken(data.access_token),
    refreshTokenEnc: encryptToken(data.refresh_token),
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
    scopes: SCOPES.split(' '),
  });
}

/** Rate-limited by the caller (`web/routes/user.js`) to at most once/minute/user. */
export async function syncOwnedGuilds(tx, userId) {
  const user = await usersRepo.findById(tx, userId);
  if (!user) throw new OAuthError('ERR_TOKEN_EXPIRED', 'User not found');
  let tokens = await oauthTokensRepo.findByUserId(tx, userId);
  if (!tokens) throw new OAuthError('ERR_TOKEN_EXPIRED', 'No stored tokens for this user');

  if (new Date(tokens.expiresAt) < new Date()) {
    tokens = await refresh(tx, userId);
  }

  const guilds = await discordFetch('/users/@me/guilds', decryptToken(tokens.accessTokenEnc));
  const ownedGuilds = guilds.filter((g) => g.owner === true);
  const ownedIds = new Set(ownedGuilds.map((g) => g.id));
  const observedAt = new Date();
  for (const g of ownedGuilds) {
    await guildsRepo.ensureExists(tx, { id: g.id, name: g.name, ownerDiscordId: user.discordId });
    await ownership.observe(tx, {
      guildId: g.id,
      ownerDiscordId: user.discordId,
      source: 'oauth',
      observedAt,
    });
  }

  // A guild we previously recorded as owned by this user but that Discord no longer
  // attributes to them (deleted, left, or ownership transferred off-platform) — clear
  // the stale reference so `GET /me/serveurs` / `/tableau-de-bord` stop listing it.
  // Skipped for guilds with an open transaction: that guild's real owner-of-record
  // is still in flux there (`domain/transfer.js:onOwnershipChanged`), and the
  // authoritative signal for it comes from the bot (gateway/sweep), not this user's
  // own guild list going stale.
  const previouslyOwned = await guildsRepo.listOwnedByDiscordId(tx, user.discordId);
  for (const g of previouslyOwned) {
    if (ownedIds.has(g.id)) continue;
    if (await transactionsRepo.findOpenByGuild(tx, g.id)) continue;
    await ownership.observe(tx, {
      guildId: g.id,
      ownerDiscordId: ownership.UNOWNED,
      source: 'oauth',
      observedAt,
    });
  }

  return ownedGuilds;
}
