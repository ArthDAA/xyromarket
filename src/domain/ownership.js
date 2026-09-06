import { ownershipRepo } from '../db/repositories/ownershipRepo.js';
import { usersRepo } from '../db/repositories/usersRepo.js';
import { guildsRepo } from '../db/repositories/guildsRepo.js';
import { publish, CHANNELS } from '../bus/events.js';
import * as audit from './audit.js';

export class OwnershipError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OwnershipError';
    this.code = code;
  }
}

let staleObservationCount = 0;
export function getStaleObservationCount() {
  return staleObservationCount;
}

/**
 * Reconciles one observation of a guild's owner against the stored
 * reference value. The only writer of `guilds.owner_discord_id` in the
 * system — `bot/guildWatcher.js`, `jobs.ownershipSweep` and
 * `web/auth/oauth.js` all funnel through here.
 *
 * @returns {Promise<{ changed: boolean, previousOwnerId: string | null }>}
 */
export async function observe(tx, { guildId, ownerDiscordId, source, observedAt }) {
  let guild = await ownershipRepo.lockGuild(tx, guildId);
  if (!guild) {
    // ERR_GUILD_UNKNOWN: not a failure — insert on the fly, bot presence unknown yet.
    guild = await ownershipRepo.insertGuildUnlocked(tx, { guildId, ownerDiscordId });
  }

  if (guild.ownerDiscordId === ownerDiscordId) {
    // Idempotent: replaying the same observation touches last_seen_at at most, never an event.
    if (!guild.lastSeenAt || observedAt > guild.lastSeenAt) {
      await ownershipRepo.touchLastSeen(tx, guildId, observedAt);
    }
    return { changed: false, previousOwnerId: guild.ownerDiscordId };
  }

  if (guild.lastSeenAt && observedAt < guild.lastSeenAt) {
    // ERR_STALE_OBSERVATION: a regressive, contradicting observation — ignored silently.
    staleObservationCount += 1;
    return { changed: false, previousOwnerId: guild.ownerDiscordId };
  }

  const previousOwnerId = guild.ownerDiscordId;
  await ownershipRepo.insertEvent(tx, { guildId, previousOwnerId, newOwnerId: ownerDiscordId, observedAt, source });
  await ownershipRepo.setOwner(tx, guildId, ownerDiscordId, observedAt);
  await publish(tx, CHANNELS.EVENT_OWNERSHIP_CHANGED, {
    guildId,
    previousOwnerId,
    newOwnerId: ownerDiscordId,
    observedAt,
    source,
  });
  await audit.record(tx, {
    actorId: 'bot',
    action: 'ownership.changed',
    targetType: 'guild',
    targetId: guildId,
    before: { ownerDiscordId: previousOwnerId },
    after: { ownerDiscordId },
  });

  return { changed: true, previousOwnerId };
}

/** Reads the stored reference value — never calls the Discord API, never locks the row. */
export async function isOwner(tx, userId, guildId) {
  const [user, guild] = await Promise.all([usersRepo.findById(tx, userId), guildsRepo.findById(tx, guildId)]);
  if (!user || !guild) return false;
  return user.discordId === guild.ownerDiscordId;
}

export async function assertOwnershipForListing(tx, userId, guildId) {
  if (!(await isOwner(tx, userId, guildId))) {
    throw new OwnershipError('ERR_NOT_OWNER', `User ${userId} is not the observed owner of guild ${guildId}`);
  }
}
