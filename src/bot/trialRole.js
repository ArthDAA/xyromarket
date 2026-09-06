import { PermissionFlagsBits } from 'discord.js';
import { withTransaction } from '../db/pool.js';
import { transactionsRepo } from '../db/repositories/transactionsRepo.js';
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
  if (!member) return fail(pool, transactionId, 'ERR_MEMBER_NOT_IN_GUILD');

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
