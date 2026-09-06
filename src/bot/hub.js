import { ChannelType } from 'discord.js';
import { withTransaction } from '../db/pool.js';
import { transactionsRepo } from '../db/repositories/transactionsRepo.js';
import { usersRepo } from '../db/repositories/usersRepo.js';
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
 * `intent.hub.thread_create` handler. A participant absent from the hub
 * never blocks thread creation — they get an invite link posted instead
 * (O2: no DM relay, everything happens in this one thread).
 */
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
      await thread.send(
        `<@${discordId}> — rejoignez ce fil depuis votre espace Xyro Market si vous n'êtes pas déjà membre du hub.`,
      );
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
