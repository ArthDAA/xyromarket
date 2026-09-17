import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { withTransaction } from '../db/pool.js';
import { transactionsRepo } from '../db/repositories/transactionsRepo.js';
import { mapRow } from '../db/repositories/shared.js';
import * as trial from '../domain/trial.js';

const TRIAL_ROLE_NAME = 'Administrateur (essai)';
const TRIAL_ROLE_COLOR = 0xe67e22;
const MISSING_PERMISSIONS_CODE = 50013;

/** The bot's own top role must sit strictly above where the trial role will be created (M15). */
export function assertHierarchy(guild) {
  const botPosition = guild.members.me?.roles.highest.position ?? 0;
  return botPosition > 0;
}

async function fail(pool, transactionId, code) {
  return withTransaction(pool, (tx) => trial.reportRoleAssignFailed(tx, transactionId, code));
}

/** Same shape as `bot/announce.js:pickChannel`, but for `CreateInstantInvite` rather than `SendMessages`. */
function pickInviteChannel(guild) {
  const canInvite = (c) => c.type === ChannelType.GuildText && c.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.CreateInstantInvite);
  if (guild.systemChannel && canInvite(guild.systemChannel)) return guild.systemChannel;
  const candidates = [...guild.channels.cache.values()].filter(canInvite).sort((a, b) => a.position - b.position);
  return candidates[0] ?? null;
}

/**
 * Atomically claims the "send this transaction's invite" slot: `UPDATE ...
 * WHERE invite_sent_at IS NULL RETURNING *` in one round trip, instead of a
 * separate fetch-then-check-then-write — each of those would be its own
 * `withTransaction(pool, ...)` call (its own connection checked out from
 * the pool), and a bus handler already runs inside `processRow`'s own open
 * transaction/connection. Stacking several more per event is exactly what
 * starved the bot's pool (max 5, `pool.js`) under a small concurrent burst
 * during testing — two events processing at once each trying to open 3
 * nested connections was enough to deadlock it (every connection either
 * blocked holding an outer transaction, or blocked waiting for one to free
 * up). One combined round trip keeps this bounded regardless of volume.
 * Marks the slot claimed unconditionally (attempted, not confirmed-sent) —
 * best-effort only, same as every other Discord notification in this
 * codebase (A23) — a later permission fix on the target guild won't
 * retroactively retry the invite itself, only the role assignment
 * (`jobs.acceptedInviteRetryTick`, once the recipient is actually in).
 */
async function claimInviteSlot(pool, transactionId) {
  return withTransaction(pool, async (tx) => {
    const { rows } = await tx.query(
      'UPDATE transactions SET invite_sent_at = now() WHERE id = $1 AND invite_sent_at IS NULL RETURNING *',
      [transactionId],
    );
    return mapRow(rows[0]) ?? null;
  });
}

/**
 * A34: the recipient of a trial role is almost never already a member of
 * the guild they're about to receive — two strangers matched by the
 * marketplace have no prior reason to share a server, and until now
 * `ERR_MEMBER_NOT_IN_GUILD` just gave up silently (one audit log line,
 * nothing else) — the transaction stayed stuck at `ACCEPTED` forever with
 * no visible signal to either party. Sends a one-time invite instead,
 * DM'd directly and posted into the hub thread too so the other party can
 * see it went out and share it manually if the DM is closed (A23's exact
 * reasoning, applied to the target guild instead of the hub). This
 * function only sends the invite once — `jobs.acceptedInviteRetryTick` is
 * what actually notices the recipient joined later and re-fires
 * `intent.trial.assign`.
 */
async function inviteRecipient(pool, client, guild, memberDiscordId, transactionId) {
  const claimed = await claimInviteSlot(pool, transactionId);
  if (!claimed) return; // already sent once, or the transaction no longer exists

  const channel = pickInviteChannel(guild);
  if (!channel) return; // ERR_NO_WRITABLE_CHANNEL / ERR_MISSING_PERMISSIONS — best-effort only

  let inviteUrl;
  try {
    const invite = await channel.createInvite({ maxAge: 7 * 86_400, unique: true });
    inviteUrl = invite.url;
  } catch {
    return; // CreateInstantInvite likely absent from the bot's role on this guild — nothing more to do
  }

  if (claimed.hubThreadId) {
    const thread = await client.channels.fetch(claimed.hubThreadId).catch(() => null);
    await thread
      ?.send(`<@${memberDiscordId}> — pour démarrer la période d'essai, rejoins d'abord le serveur concerné : ${inviteUrl}`)
      .catch(() => {});
  }
  try {
    const user = await client.users.fetch(memberDiscordId);
    await user.send(`Pour démarrer la période d'essai sur Xyro Market, rejoins d'abord ce serveur : ${inviteUrl}`);
  } catch {
    // DM closed to non-friends/no shared server — the hub thread message above is the fallback.
  }
}

/**
 * `intent.trial.assign` handler. Confirms success/failure back into the FSM
 * via a direct, same-transaction call to `domain/trial.js` — there is no
 * bot-to-domain confirmation channel in the bus's fixed channel set (see
 * DebugNotes), so this in-process call is the mechanism the FSM relies on.
 */
export async function onIntentTrialAssign(pool, client, { guildId, memberDiscordId, transactionId }) {
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return fail(pool, transactionId, 'ERR_GUILD_UNAVAILABLE');

  await guild.members.me.fetch();
  if (!assertHierarchy(guild)) return fail(pool, transactionId, 'ERR_HIERARCHY_TOO_LOW');

  const member = await guild.members.fetch(memberDiscordId).catch(() => null);
  if (!member) {
    await inviteRecipient(pool, client, guild, memberDiscordId, transactionId);
    return fail(pool, transactionId, 'ERR_MEMBER_NOT_IN_GUILD');
  }

  try {
    const role = await guild.roles.create({
      name: TRIAL_ROLE_NAME,
      permissions: [PermissionFlagsBits.Administrator],
      mentionable: false,
      hoist: true,
      color: TRIAL_ROLE_COLOR,
    });
    await role.setPosition(guild.members.me.roles.highest.position - 1);
    await member.roles.add(role);
    await withTransaction(pool, (tx) => trial.confirmTrialStarted(tx, transactionId, role.id));
  } catch (err) {
    const code = err.code === MISSING_PERMISSIONS_CODE ? 'ERR_MISSING_MANAGE_ROLES' : 'ERR_ROLE_ASSIGN_FAILED';
    await fail(pool, transactionId, code);
  }
}

/** `intent.trial.revoke` handler. Idempotent: an already-absent role is a success, not an error. */
export async function onIntentTrialRevoke(pool, client, { guildId, memberDiscordId, transactionId }) {
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  const transaction = await withTransaction(pool, (tx) => transactionsRepo.findById(tx, transactionId));
  if (!transaction?.trialRoleId) return;

  const role = guild.roles.cache.get(transaction.trialRoleId) ?? (await guild.roles.fetch(transaction.trialRoleId).catch(() => null));
  if (!role) return; // ERR_ROLE_DELETED_EXTERNALLY — already reconciled by guildWatcher/ownershipSweep

  const member = await guild.members.fetch(memberDiscordId).catch(() => null);
  if (member) {
    await member.roles.remove(role).catch(() => {});
  }
  if (role.members.size === 0) {
    await role.delete('Xyro Market: trial ended').catch(() => {});
  }
}
