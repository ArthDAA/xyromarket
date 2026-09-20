import { AuditLogEvent, PermissionsBitField } from 'discord.js';
import { withTransaction } from '../db/pool.js';
import { guildsRepo } from '../db/repositories/guildsRepo.js';
import { transactionsRepo } from '../db/repositories/transactionsRepo.js';
import { usersRepo } from '../db/repositories/usersRepo.js';
import * as ownership from '../domain/ownership.js';
import * as listings from '../domain/listings.js';
import * as trial from '../domain/trial.js';

const VIEW_AUDIT_LOG = PermissionsBitField.Flags.ViewAuditLog;
const RECIPIENT_REMOVAL_ACTIONS = new Set([AuditLogEvent.MemberKick, AuditLogEvent.MemberBanAdd]);

function botRolePosition(guild) {
  return guild.members.me?.roles.highest.position ?? null;
}

/**
 * Checked at guild add and again right before role assignment in
 * `bot/trialRole.js` (position can change between the two, M15). Persists
 * the result on `guilds.role_hierarchy_ok` for the site banner fallback,
 * and best-effort DMs the owner — the DM is a one-off outbound notice, not
 * the bidirectional relay O2 ruled out.
 */
async function assertHierarchyAndAlert(pool, guild) {
  const position = botRolePosition(guild);
  const ok = position !== null && position > 0;
  await withTransaction(pool, (tx) =>
    guildsRepo.updatePresence(tx, guild.id, { roleHierarchyOk: ok, botRolePosition: position }),
  );
  if (!ok) {
    try {
      const owner = await guild.fetchOwner();
      await owner.send(
        'Xyro Market : le rôle du bot doit être positionné au-dessus du rôle "Administrateur (essai)" pour que les annonces de ce serveur fonctionnent.',
      );
    } catch {
      // Best-effort only — the site banner (role_hierarchy_ok) is the guaranteed fallback.
    }
  }
  return ok;
}

async function observeAndUpsert(pool, guild, { botPresent = true } = {}) {
  const hasAuditLogPerm = guild.members.me?.permissions.has(VIEW_AUDIT_LOG) ?? false;
  await withTransaction(pool, async (tx) => {
    await guildsRepo.ensureExists(tx, {
      id: guild.id,
      name: guild.name,
      ownerDiscordId: guild.ownerId,
      botPresent,
    });
    await guildsRepo.updatePresence(tx, guild.id, {
      name: guild.name,
      iconHash: guild.icon,
      bannerHash: guild.banner,
      splashHash: guild.splash,
      memberCountCached: guild.memberCount,
      botPresent,
      auditBlind: !hasAuditLogPerm,
    });
    await ownership.observe(tx, {
      guildId: guild.id,
      ownerDiscordId: guild.ownerId,
      source: 'gateway',
      observedAt: new Date(),
    });
  });
}

export async function onGuildCreate(pool, guild) {
  await observeAndUpsert(pool, guild, { botPresent: true });
  await assertHierarchyAndAlert(pool, guild);
  await withTransaction(pool, (tx) => listings.activatePendingForGuild(tx, guild.id));
}

export async function onGuildUpdate(pool, oldGuild, newGuild) {
  await withTransaction(pool, async (tx) => {
    await guildsRepo.updatePresence(tx, newGuild.id, {
      name: newGuild.name,
      iconHash: newGuild.icon,
      bannerHash: newGuild.banner,
      splashHash: newGuild.splash,
      memberCountCached: newGuild.memberCount,
    });
    if (oldGuild.ownerId !== newGuild.ownerId) {
      await ownership.observe(tx, {
        guildId: newGuild.id,
        ownerDiscordId: newGuild.ownerId,
        source: 'gateway',
        observedAt: new Date(),
      });
    }
  });
}

/** A guild removal never auto-cancels a TRIAL transaction — the bot may have been kicked by mistake (M13/M11 balance). */
export async function onGuildDelete(pool, guild) {
  await withTransaction(pool, async (tx) => {
    await guildsRepo.updatePresence(tx, guild.id, { botPresent: false });
    await listings.hideAllForGuild(tx, guild.id, 'BOT_REMOVED');
  });
}

/** Catches up on every guild after a reconnect — the blind window is bounded by the outage, not open-ended. */
export async function onReady(pool, client) {
  for (const guild of client.guilds.cache.values()) {
    await observeAndUpsert(pool, guild, { botPresent: true });
    await assertHierarchyAndAlert(pool, guild);
    // `guildCreate` never fires for a guild the bot already joined before this reconnect —
    // this is the only other place a `pending_bot` annonce published during the outage gets activated.
    await withTransaction(pool, (tx) => listings.activatePendingForGuild(tx, guild.id));
  }
}

/**
 * `intent.guild.leave` handler — a plain guild-membership action requested by
 * `domain/listings.js:remove()` once nothing on the guild needs the bot
 * there anymore. Colocated here rather than in a dedicated file for a single
 * action; signature matches every other `intent.*` handler (`pool` unused,
 * kept for consistency). Leaving fires Discord's own `guildDelete`, which
 * `onGuildDelete` above already handles (`bot_present: false`, hide
 * listings) — this function only asks Discord to leave, never touches the DB.
 */
export async function onIntentGuildLeave(pool, client, { guildId }) {
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return; // Already gone (kicked manually, or the invite never completed) — nothing to do.
  await guild.leave();
}

/**
 * Primary detection path for an owner acting on the trial role or recipient
 * directly from Discord (A22) — `ownershipSweep` is the <=10min filet, not
 * the first line.
 */
export async function onGuildAuditLogEntryCreate(pool, entry, guild) {
  await withTransaction(pool, async (tx) => {
    const transaction = await transactionsRepo.findOpenByGuild(tx, guild.id);
    if (!transaction || transaction.status !== 'TRIAL') return;
    const recipient = await usersRepo.findById(tx, transaction.toUserId);
    if (!recipient) return;

    if (RECIPIENT_REMOVAL_ACTIONS.has(entry.action) && entry.targetId === recipient.discordId) {
      await trial.cancel(tx, 'bot', transaction.id, 'TRIAL_RECIPIENT_REMOVED');
      return;
    }

    const removedTrialRole =
      entry.action === AuditLogEvent.MemberRoleUpdate &&
      entry.targetId === recipient.discordId &&
      entry.changes?.some(
        (c) => c.key === '$remove' && c.new?.some((r) => r.id === transaction.trialRoleId),
      );
    if (removedTrialRole) {
      await trial.cancel(tx, 'bot', transaction.id, 'TRIAL_ROLE_REMOVED');
      return;
    }

    if (entry.action === AuditLogEvent.RoleDelete && entry.targetId === transaction.trialRoleId) {
      await trial.cancel(tx, 'bot', transaction.id, 'TRIAL_ROLE_REMOVED');
    }
  });
}
