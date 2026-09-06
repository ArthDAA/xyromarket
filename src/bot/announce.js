import { EmbedBuilder, ChannelType, PermissionFlagsBits } from 'discord.js';
import { withTransaction } from '../db/pool.js';
import { transactionsRepo } from '../db/repositories/transactionsRepo.js';

function pickChannel(guild) {
  const canWrite = (c) => c.type === ChannelType.GuildText && c.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.SendMessages);
  if (guild.systemChannel && canWrite(guild.systemChannel)) return guild.systemChannel;
  const candidates = [...guild.channels.cache.values()].filter(canWrite).sort((a, b) => a.position - b.position);
  return candidates[0] ?? null;
}

/**
 * `intent.announce.handover` handler. Automatic, no human validation (A5).
 * Idempotent: `announced_at` already set means a bus replay, not a new
 * handover — never doubles the message. A failure here never invalidates
 * the transfer itself (the announcement is a consequence, not a condition).
 */
export async function onIntentAnnounceHandover(pool, client, { guildId, transactionId, previousOwnerId, newOwnerId, transferredAt }) {
  const existing = await withTransaction(pool, (tx) => transactionsRepo.findById(tx, transactionId));
  if (existing?.announcedAt) return; // idempotent

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return; // ERR_GUILD_LEFT — abandoned definitively, nothing to announce into

  const channel = pickChannel(guild);
  if (!channel) return; // ERR_NO_WRITABLE_CHANNEL / ERR_FORBIDDEN(50013)

  const embed = new EmbedBuilder()
    .setTitle('Passation de propriété — Xyro Market')
    .setDescription(`Ce serveur a changé de main via Xyro Market.`)
    .addFields(
      { name: 'Ancien propriétaire', value: `<@${previousOwnerId}>`, inline: true },
      { name: 'Nouveau propriétaire', value: `<@${newOwnerId}>`, inline: true },
      { name: 'Date', value: new Date(transferredAt).toLocaleString('fr-FR'), inline: false },
    )
    .setColor(0x2ecc71);

  try {
    await channel.send({ embeds: [embed] });
    await withTransaction(pool, (tx) => transactionsRepo.setAnnounced(tx, transactionId, new Date()));
  } catch {
    // ERR_ANNOUNCE_FAILED — journalisé côté logs bot, jamais propagé au transfert.
  }
}
