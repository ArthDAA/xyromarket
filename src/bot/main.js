import { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder } from 'discord.js';
import pino from 'pino';
import { Config } from '../config/env.js';
import { LOCK_KEYS } from '../config/lockKeys.js';
import { createPool, closePool, withTransaction } from '../db/pool.js';
import { hasPendingMigrations } from '../db/migrations/run.js';
import { createBusListener, CHANNELS } from '../bus/events.js';
import * as guildWatcher from './guildWatcher.js';
import * as trialRole from './trialRole.js';
import * as hub from './hub.js';
import * as announce from './announce.js';
import * as transfer from '../domain/transfer.js';

const logger = pino({ level: Config.logLevel });

const SIGNALER_COMMAND = new SlashCommandBuilder()
  .setName('signaler')
  .setDescription('Signaler un problème à la modération Xyro Market')
  .addStringOption((opt) => opt.setName('cible').setDescription('Id Discord de la personne concernée').setRequired(false))
  .addStringOption((opt) => opt.setName('raison').setDescription('Raison du signalement').setRequired(false));

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(Config.discordBotToken);
  await rest.put(Routes.applicationGuildCommands(Config.discordClientId, Config.discordHubGuildId), {
    body: [SIGNALER_COMMAND.toJSON()],
  });
}

async function main() {
  const pool = await createPool('bot', { logger });

  if (await hasPendingMigrations(pool)) {
    logger.fatal('pending migrations found — run `npm run migrate` before starting bot');
    await closePool(pool);
    process.exit(1);
  }

  // Single bot process at a time (no double announcement, no double role assignment) — held for
  // the whole process lifetime, so we take it on a dedicated connection rather than through
  // `withAdvisoryLock` (which is scoped to release when its callback returns).
  const singletonClient = await pool.connect();
  const { rows: lockRows } = await singletonClient.query('SELECT pg_try_advisory_lock($1) AS locked', [
    LOCK_KEYS.BOT_SINGLETON,
  ]);
  if (!lockRows[0].locked) {
    logger.info('ERR_SINGLETON_HELD — another bot process is running, exiting');
    singletonClient.release();
    await closePool(pool);
    process.exit(0);
  }

  // discord.js v14: only Guilds + GuildModeration, neither privileged — see docs/devnotes/3-DebugNotes.md (A22).
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildModeration] });

  const bus = createBusListener(pool, { logger });
  bus.subscribe(CHANNELS.INTENT_TRIAL_ASSIGN, (payload) => trialRole.onIntentTrialAssign(pool, client, payload));
  bus.subscribe(CHANNELS.INTENT_TRIAL_REVOKE, (payload) => trialRole.onIntentTrialRevoke(pool, client, payload));
  bus.subscribe(CHANNELS.INTENT_HUB_THREAD_CREATE, (payload) => hub.onIntentHubThreadCreate(pool, client, payload));
  bus.subscribe(CHANNELS.INTENT_HUB_THREAD_ARCHIVE, (payload) => hub.onIntentHubThreadArchive(pool, client, payload));
  bus.subscribe(CHANNELS.INTENT_ANNOUNCE_HANDOVER, (payload) => announce.onIntentAnnounceHandover(pool, client, payload));
  bus.subscribe(CHANNELS.EVENT_TRANSACTION_UPDATED, (payload) => hub.onEventTransactionUpdated(pool, client, payload));
  // transfer.js's handler is pure domain logic (DB + further intents, no Discord calls of its
  // own) — hosted here because bot already holds the one long-lived bus connection; see
  // DebugNotes for why no other process subscribes to event.ownership.changed.
  bus.subscribe(CHANNELS.EVENT_OWNERSHIP_CHANGED, (payload) => withTransaction(pool, (tx) => transfer.onOwnershipChanged(tx, payload)));

  client.on(Events.ClientReady, async () => {
    logger.info('bot ready, reconciling guild cache');
    await guildWatcher.onReady(pool, client);
    await bus.start();
  });
  client.on(Events.GuildCreate, (guild) => guildWatcher.onGuildCreate(pool, guild).catch((err) => logger.error({ err }, 'onGuildCreate failed')));
  client.on(Events.GuildUpdate, (oldGuild, newGuild) => guildWatcher.onGuildUpdate(pool, oldGuild, newGuild).catch((err) => logger.error({ err }, 'onGuildUpdate failed')));
  client.on(Events.GuildDelete, (guild) => guildWatcher.onGuildDelete(pool, guild).catch((err) => logger.error({ err }, 'onGuildDelete failed')));
  client.on(Events.GuildAuditLogEntryCreate, (entry, guild) =>
    guildWatcher.onGuildAuditLogEntryCreate(pool, entry, guild).catch((err) => logger.error({ err }, 'onGuildAuditLogEntryCreate failed')),
  );
  client.on(Events.InteractionCreate, (interaction) => {
    if (interaction.isChatInputCommand() && interaction.commandName === 'signaler') {
      hub.onSignalerCommand(pool, interaction).catch((err) => logger.error({ err }, 'onSignalerCommand failed'));
    }
  });
  client.on(Events.ShardResume, async () => {
    logger.warn('ERR_GATEWAY_RESUME_FAILED-adjacent: gateway resumed, reconciling');
    await guildWatcher.onReady(pool, client);
  });
  client.on(Events.Error, (err) => logger.error({ err }, 'gateway client error'));

  try {
    await registerCommands();
    await client.login(Config.discordBotToken);
  } catch (err) {
    logger.fatal({ err }, 'ERR_TOKEN_INVALID');
    singletonClient.release();
    await closePool(pool);
    process.exit(1);
  }

  const shutdown = async () => {
    logger.info('shutting down bot');
    await bus.stop();
    client.destroy();
    await singletonClient.query('SELECT pg_advisory_unlock($1)', [LOCK_KEYS.BOT_SINGLETON]).catch(() => {});
    singletonClient.release();
    await closePool(pool);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'bot process failed to start');
  process.exit(1);
});
