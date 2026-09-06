import { REST, Routes } from 'discord.js';
import pino from 'pino';
import { Config } from '../config/env.js';
import { LOCK_KEYS, jobLockKey } from '../config/lockKeys.js';
import { createPool, closePool, withAdvisoryLock, withTransaction } from '../db/pool.js';
import { hasPendingMigrations } from '../db/migrations/run.js';
import { createBusListener, sweepOutbox, CHANNELS } from '../bus/events.js';
import { guildsRepo } from '../db/repositories/guildsRepo.js';
import { transactionsRepo } from '../db/repositories/transactionsRepo.js';
import { usersRepo } from '../db/repositories/usersRepo.js';
import { settingsRepo } from '../db/repositories/settingsRepo.js';
import * as engine from '../domain/matching/engine.js';
import * as trial from '../domain/trial.js';
import * as gdpr from '../domain/gdpr.js';
import * as stats from '../domain/stats.js';
import * as ownership from '../domain/ownership.js';
import * as reputation from '../domain/reputation.js';

const logger = pino({ level: Config.logLevel });
const rest = new REST({ version: '10' }).setToken(Config.discordBotToken);

const consecutiveFailures = new Map();

async function runTick(pool, name, fn) {
  const result = await withAdvisoryLock(pool, jobLockKey(name), fn, { transactional: false });
  if (result === null) return; // another instance already holds this job's lock — skip, never stack
  consecutiveFailures.set(name, 0);
}

async function guardedTick(pool, name, fn) {
  try {
    await runTick(pool, name, fn);
  } catch (err) {
    const failures = (consecutiveFailures.get(name) ?? 0) + 1;
    consecutiveFailures.set(name, failures);
    logger.error({ job: name, err: err.message, failures }, 'ERR_JOB_FAILED');
    if (failures >= 3) {
      logger.fatal({ job: name }, 'job failed 3 times consecutively — alerting admin');
    }
  }
}

// ---------------------------------------------------------------- matchRound

async function matchRoundTick(pool) {
  const result = await engine.runRound(pool);
  logger.info(result, 'matchRound tick');
}

let matchRoundDebounceTimer = null;
function scheduleDebouncedMatchRound(pool) {
  if (matchRoundDebounceTimer) clearTimeout(matchRoundDebounceTimer);
  matchRoundDebounceTimer = setTimeout(() => {
    guardedTick(pool, 'matchRound', () => matchRoundTick(pool));
  }, 30_000);
  matchRoundDebounceTimer.unref();
}

// ---------------------------------------------------------------- trialExpiry
// Also covers two closely-related time-based lifecycle sweeps with no
// dedicated job of their own in the contract (see DebugNotes): closing a
// TRANSFERRED transaction whose dispute window elapsed uneventfully, and
// executing a GDPR deletion whose 7-day retraction window elapsed.

async function trialExpiryTick(pool) {
  const now = new Date();

  const expiredTrials = await withTransaction(pool, (tx) => transactionsRepo.findExpiredTrials(tx, now));
  for (const t of expiredTrials) {
    await withTransaction(pool, (tx) => trial.expire(tx, t.id)).catch((err) =>
      logger.error({ err: err.message, transactionId: t.id }, 'trial.expire failed'),
    );
  }

  const disputeWindowDays = await withTransaction(pool, (tx) => settingsRepo.get(tx, 'dispute_window_days'));
  const disputeCutoff = new Date(now.getTime() - disputeWindowDays * 86_400_000);
  const dueForClose = await withTransaction(pool, (tx) =>
    transactionsRepo.findTransferredWithoutOpenDispute(tx, disputeCutoff),
  );
  for (const t of dueForClose) {
    await withTransaction(pool, (tx) => trial.close(tx, t.id)).catch((err) =>
      logger.error({ err: err.message, transactionId: t.id }, 'trial.close (dispute window) failed'),
    );
  }

  const dueForDeletion = await withTransaction(pool, (tx) => usersRepo.findDueForDeletion(tx, gdpr.RETRACTION_WINDOW_MS));
  for (const u of dueForDeletion) {
    await withTransaction(pool, (tx) => gdpr.executeDeletion(tx, u.id)).catch((err) =>
      logger.error({ err: err.message, userId: u.id }, 'gdpr.executeDeletion failed'),
    );
  }
}

// ------------------------------------------------------------- ownershipSweep

async function fetchGuildRest(guildId) {
  try {
    return await rest.get(Routes.guild(guildId));
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function fetchMemberRest(guildId, userId) {
  try {
    return await rest.get(Routes.guildMember(guildId, userId));
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function sweepGuildOwnership(pool, guildId) {
  const remote = await fetchGuildRest(guildId);
  if (!remote) return; // bot no longer in the guild — guildDelete (if received) already handled presence
  await withTransaction(pool, (tx) =>
    ownership.observe(tx, {
      guildId,
      ownerDiscordId: remote.owner_id,
      source: 'sweep',
      observedAt: new Date(),
    }),
  );
}

async function sweepTrialIntegrity(pool, transaction) {
  const toUser = await withTransaction(pool, (tx) => usersRepo.findById(tx, transaction.toUserId));
  if (!toUser || !transaction.trialRoleId) return;

  const member = await fetchMemberRest(transaction.guildId, toUser.discordId);
  if (!member) {
    await withTransaction(pool, (tx) => trial.cancel(tx, 'bot', transaction.id, 'TRIAL_RECIPIENT_REMOVED'));
    return;
  }
  if (!member.roles?.includes(transaction.trialRoleId)) {
    await withTransaction(pool, (tx) => trial.cancel(tx, 'bot', transaction.id, 'TRIAL_ROLE_REMOVED'));
  }
}

async function ownershipSweepTick(pool) {
  const activeGuilds = await withTransaction(pool, (tx) => guildsRepo.listWithActiveListing(tx));
  const trialTransactions = await withTransaction(pool, (tx) => transactionsRepo.findAllInTrial(tx));
  const trialGuildIds = new Set(trialTransactions.map((t) => t.guildId));

  // Hourly baseline for every guild carrying an active listing, skipping ones already
  // covered below at a tighter cadence.
  for (const guild of activeGuilds) {
    if (trialGuildIds.has(guild.id)) continue;
    await sweepGuildOwnership(pool, guild.id).catch((err) => logger.error({ err: err.message, guildId: guild.id }, 'ownershipSweep failed'));
  }

  // Tighter cadence (10min, or 5min if audit_blind) for guilds in an active trial —
  // this tick itself runs every 10 min; audit_blind guilds are additionally re-checked
  // by the 5-minute interval registered separately below.
  for (const transaction of trialTransactions) {
    await sweepGuildOwnership(pool, transaction.guildId).catch((err) =>
      logger.error({ err: err.message, guildId: transaction.guildId }, 'ownershipSweep (trial) failed'),
    );
    await sweepTrialIntegrity(pool, transaction).catch((err) =>
      logger.error({ err: err.message, transactionId: transaction.id }, 'sweepTrialIntegrity failed'),
    );
  }
}

async function auditBlindOwnershipSweepTick(pool) {
  const guilds = await withTransaction(pool, (tx) => guildsRepo.listWithActiveListing(tx));
  const trialTransactions = await withTransaction(pool, (tx) => transactionsRepo.findAllInTrial(tx));
  const blindTrialGuildIds = new Set(
    guilds.filter((g) => g.auditBlind).map((g) => g.id),
  );
  for (const transaction of trialTransactions) {
    if (!blindTrialGuildIds.has(transaction.guildId)) continue;
    await sweepTrialIntegrity(pool, transaction).catch((err) =>
      logger.error({ err: err.message, transactionId: transaction.id }, 'auditBlind sweepTrialIntegrity failed'),
    );
  }
}

// ---------------------------------------------------------------- outboxSweep

async function outboxSweepTick(pool) {
  const reemitted = await sweepOutbox(pool, { olderThanMs: 60_000 });
  if (reemitted > 0) logger.info({ reemitted }, 'outboxSweep re-notified stalled events');
}

// --------------------------------------------------------------- statsRefresh

async function statsRefreshTick(pool) {
  await withTransaction(pool, (tx) => stats.refreshAll(tx, { logger }));

  // Re-evaluates the Vérifié tag for every user with at least one completed transaction —
  // cheap enough at v1 scale; revisit with a targeted query if this ever needs to scale further.
  const userIds = await withTransaction(pool, (tx) => transactionsRepo.listUserIdsWithCompletedTransaction(tx));
  for (const userId of userIds) {
    await withTransaction(pool, (tx) => reputation.evaluateVerified(tx, userId)).catch((err) =>
      logger.error({ err: err.message, userId }, 'evaluateVerified failed'),
    );
  }
}

// ---------------------------------------------------------------------- main

async function main() {
  const pool = await createPool('jobs', { logger });

  if (await hasPendingMigrations(pool)) {
    logger.fatal('pending migrations found — run `npm run migrate` before starting jobs');
    await closePool(pool);
    process.exit(1);
  }

  const singletonClient = await pool.connect();
  const { rows } = await singletonClient.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEYS.JOBS_SINGLETON]);
  if (!rows[0].locked) {
    logger.info('ERR_JOBS_SINGLETON_HELD — another jobs process is running, exiting');
    singletonClient.release();
    await closePool(pool);
    process.exit(0);
  }

  const bus = createBusListener(pool, { logger });
  bus.subscribe(CHANNELS.EVENT_LISTING_CHANGED, () => {
    scheduleDebouncedMatchRound(pool);
  });
  await bus.start();

  const intervals = [
    setInterval(() => guardedTick(pool, 'matchRound', () => matchRoundTick(pool)), 5 * 60 * 1000),
    setInterval(() => guardedTick(pool, 'trialExpiry', () => trialExpiryTick(pool)), 10 * 60 * 1000),
    setInterval(() => guardedTick(pool, 'ownershipSweep', () => ownershipSweepTick(pool)), 10 * 60 * 1000),
    setInterval(() => guardedTick(pool, 'ownershipSweepAuditBlind', () => auditBlindOwnershipSweepTick(pool)), 5 * 60 * 1000),
    setInterval(() => guardedTick(pool, 'outboxSweep', () => outboxSweepTick(pool)), 60 * 1000),
    setInterval(() => guardedTick(pool, 'statsRefresh', () => statsRefreshTick(pool)), 15 * 60 * 1000),
  ];

  // Fire each once immediately so the process is useful right after boot, not just after the first interval elapses.
  await guardedTick(pool, 'matchRound', () => matchRoundTick(pool));
  await guardedTick(pool, 'outboxSweep', () => outboxSweepTick(pool));

  const shutdown = async () => {
    logger.info('shutting down jobs');
    for (const interval of intervals) clearInterval(interval);
    await bus.stop();
    await singletonClient.query('SELECT pg_advisory_unlock($1)', [LOCK_KEYS.JOBS_SINGLETON]).catch(() => {});
    singletonClient.release();
    await closePool(pool);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'jobs process failed to start');
  process.exit(1);
});
