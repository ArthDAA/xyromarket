import { ChannelType } from 'discord.js';
import { withTransaction } from '../db/pool.js';
import { transactionsRepo } from '../db/repositories/transactionsRepo.js';
import { usersRepo } from '../db/repositories/usersRepo.js';
import { settingsRepo } from '../db/repositories/settingsRepo.js';
import { Config } from '../config/env.js';
import * as moderation from '../domain/moderation.js';

const NEGOTIATION_CHANNEL_NAME = 'negociations';

async function getNegotiationChannel(client) {
  const hubGuild = await client.guilds.fetch(Config.discordHubGuildId);
  const named = hubGuild.channels.cache.find(
    (c) => c.name === NEGOTIATION_CHANNEL_NAME && c.type === ChannelType.GuildText,
  );
  return named ?? hubGuild.systemChannel ?? null; // ERR_MISSING_PERMISSIONS if neither exists
}

/**
 * A22: nothing before this ever gave an owner a way to actually *join* the
 * hub — `thread.members.add()` in `onIntentHubThreadCreate` below only
 * works on someone already a hub member, and its fallback (a `@mention`
 * posted inside the thread) is unreachable by someone who isn't a member:
 * you cannot see a channel's content in a server you haven't joined. Called
 * once at bot boot (`Events.ClientReady` in `bot/main.js`) — reuses an
 * existing non-expiring invite on the negotiation channel if the bot
 * already made one (survives restarts), otherwise creates one and persists
 * it to `settings.hub_invite_url` so `web/*` can display it without ever
 * touching Discord itself.
 */
export async function ensureHubInvite(pool, client, logger) {
  const channel = await getNegotiationChannel(client);
  if (!channel) return; // ERR_MISSING_PERMISSIONS — same fallback as thread creation, alerted separately

  try {
    // `unique: false` (the default) has Discord return an existing matching invite instead of
    // minting a new one each boot — no separate fetch-then-check needed, and no `MANAGE_GUILD`
    // permission required (unlike listing a guild's invites, which fetching ourselves would).
    const invite = await channel.createInvite({ maxAge: 0, maxUses: 0, unique: false });
    // `updated_by` is a real FK to `users(id)`, not a free-text actor label like `audit_log.actor_id`
    // — null here, this is a bot-initiated system value with no admin user behind it.
    await withTransaction(pool, (tx) => settingsRepo.set(tx, 'hub_invite_url', invite.url, null));
  } catch (err) {
    // ERR_MISSING_PERMISSIONS (CREATE_INSTANT_INVITE likely absent from the hub bot's role —
    // not in the permission set README.md documents) — never fatal, `bus.start()` must still
    // run right after this call, but must not go completely silent either: without this link
    // the whole hub-chat mechanism is unreachable for anyone not already a hub member (A22).
    logger?.warn({ err: err.message }, 'ensureHubInvite failed — no hub_invite_url will be shown on the site');
  }
}

/**
 * A23: the in-thread `@mention` fallback below is structurally invisible to
 * exactly the person it's for — you can't see a channel's content in a
 * server you haven't joined, which is the whole reason `thread.members.add`
 * just failed. A DM is the only channel that can reach them directly with
 * the actual invite. Best-effort only: Discord 403s a DM if the recipient's
 * privacy settings close it (O2's exact reasoning for ruling DM out as the
 * *chat* mechanism itself — this is a one-off notification, not a relay) —
 * `settings.hub_invite_url` shown on the site (A22) remains the guaranteed
 * fallback if the DM itself fails or was never delivered.
 */
async function notifyMissingHubMember(pool, client, thread, discordId) {
  await thread
    .send(`<@${discordId}> — rejoignez ce fil depuis votre espace Xyro Market si vous n'êtes pas déjà membre du hub.`)
    .catch(() => {});

  const inviteUrl = await withTransaction(pool, (tx) => settingsRepo.get(tx, 'hub_invite_url'));
  try {
    const user = await client.users.fetch(discordId);
    await user.send(
      inviteUrl
        ? `Tu as une mise en contact sur Xyro Market — rejoins le serveur hub Discord pour en discuter : ${inviteUrl}`
        : 'Tu as une mise en contact sur Xyro Market — connecte-toi sur le site pour en savoir plus.',
    );
  } catch {
    // DM closed to non-friends/no shared server, or the id no longer resolves to a user —
    // no further automatic retry, the site link (A22) is the fallback of last resort.
  }
}

/** `intent.hub.thread_create` handler. A participant absent from the hub never blocks thread creation. */
export async function onIntentHubThreadCreate(pool, client, { transactionId, participantDiscordIds }) {
  const channel = await getNegotiationChannel(client);
  if (!channel) return; // ERR_MISSING_PERMISSIONS — alerted separately via admin/ops monitoring

  const thread = await channel.threads.create({
    name: `transaction-${transactionId.slice(0, 8)}`,
    type: ChannelType.PrivateThread,
    invitable: false,
  });
  await withTransaction(pool, (tx) => transactionsRepo.setHubThread(tx, transactionId, thread.id));

  for (const discordId of participantDiscordIds) {
    if (!discordId) continue;
    try {
      await thread.members.add(discordId);
    } catch {
      await notifyMissingHubMember(pool, client, thread, discordId);
    }
  }

  const transaction = await withTransaction(pool, (tx) => transactionsRepo.findById(tx, transactionId));
  await thread.send(
    `Négociation ouverte pour la guilde \`${transaction.guildId}\`. Utilisez \`/signaler\` en cas de problème — la modération est entièrement automatisée sur ce fil (A4).`,
  );
}

/** Posted on every `event.transaction.updated` — a message into an archived thread un-archives it (used by `dispute.open`). */
export async function onEventTransactionUpdated(pool, client, { transactionId, to }) {
  const transaction = await withTransaction(pool, (tx) => transactionsRepo.findById(tx, transactionId));
  if (!transaction?.hubThreadId) return;
  const thread = await client.channels.fetch(transaction.hubThreadId).catch(() => null);
  if (!thread) return;
  await thread.send(`Statut de la transaction : **${to}**.`).catch(() => {});
}

/**
 * `intent.hub.thread_archive` handler. Scheduled in-process — if the bot
 * restarts within `delayDays`, the archive is simply skipped (Discord UI
 * tidiness only, never a correctness or audit concern: the thread's history
 * remains intact and readable either way).
 */
export async function onIntentHubThreadArchive(pool, client, { transactionId, delayDays }) {
  const timer = setTimeout(async () => {
    const transaction = await withTransaction(pool, (tx) => transactionsRepo.findById(tx, transactionId));
    if (!transaction?.hubThreadId) return;
    const thread = await client.channels.fetch(transaction.hubThreadId).catch(() => null);
    await thread?.setArchived(true).catch(() => {});
  }, delayDays * 86_400_000);
  timer.unref();
}

/** `/signaler` — the only human-in-the-loop moderation surface on the hub (A4/A16), no message content ever read. */
export async function onSignalerCommand(pool, interaction) {
  const targetId = interaction.options.getString('cible') ?? interaction.user.id;
  const reason = interaction.options.getString('raison') ?? 'Signalement via /signaler';

  const reporter = await withTransaction(pool, (tx) => usersRepo.findByDiscordId(tx, interaction.user.id));
  if (!reporter) {
    return interaction.reply({
      content: 'Connectez-vous sur le site Xyro Market avant de signaler.',
      ephemeral: true,
    });
  }

  await withTransaction(pool, (tx) =>
    moderation.report(tx, reporter.id, { targetType: 'user', targetId, reason, body: '' }),
  );
  return interaction.reply({ content: 'Signalement transmis à la modération.', ephemeral: true });
}
