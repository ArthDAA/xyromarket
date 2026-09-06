import pg from 'pg';
import pino from 'pino';
import { Config } from '../config/env.js';

const { Pool } = pg;

/** Pool sizing per process, per the architecture contract's global solution. */
const POOL_SIZE_BY_PROCESS = { web: 10, bot: 5, jobs: 3, migrate: 1 };

/** Postgres error codes this module reacts to directly. */
export const PG_ERROR = {
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
};

const MAX_TX_ATTEMPTS = 3;
const SLOW_QUERY_THRESHOLD_MS = 500;
const CONNECT_RETRY_ATTEMPTS = 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps `target.query` (a Pool or a checked-out Client) to log any query
 * taking longer than the slow-query threshold. Logs the parameterized SQL
 * text only — never bound values, which may carry sensitive data such as
 * encrypted OAuth tokens.
 */
function instrumentQuery(target, logger) {
  if (target.__xyroInstrumented) return target;
  target.__xyroInstrumented = true;
  const originalQuery = target.query.bind(target);
  target.query = async (...args) => {
    const startedAt = process.hrtime.bigint();
    try {
      return await originalQuery(...args);
    } finally {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
        const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
        logger.warn({ durationMs: Math.round(durationMs), text }, 'slow query');
      }
    }
  };
  return target;
}

async function connectWithRetry(pool, logger) {
  let lastErr;
  for (let attempt = 1; attempt <= CONNECT_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      lastErr = err;
      logger.warn({ err: err.message, attempt }, 'database unavailable, retrying');
      if (attempt < CONNECT_RETRY_ATTEMPTS) {
        await sleep(2 ** attempt * 100);
      }
    }
  }
  logger.fatal({ err: lastErr?.message }, 'DB_UNAVAILABLE: could not connect after retries');
  process.exit(1);
}

/**
 * Creates and connects the process-scoped pg Pool. `processName` selects the
 * pool size mandated by the contract (10 web / 5 bot / 3 jobs) — there is
 * exactly one pool per process, created once at boot.
 */
export async function createPool(processName, { config = Config, logger } = {}) {
  const max = POOL_SIZE_BY_PROCESS[processName];
  if (!max) {
    throw new Error(`Unknown process name for pool sizing: ${processName}`);
  }
  const log = logger ?? pino({ level: config.logLevel });
  const pool = new Pool({ connectionString: config.databaseUrl, max });
  pool.on('error', (err) => {
    log.error({ err: err.message }, 'idle client error on pool');
  });
  instrumentQuery(pool, log);
  pool.__xyroLogger = log;
  await connectWithRetry(pool, log);
  return pool;
}

/**
 * Closes the pool cleanly. Callers (each process's main.js) are responsible
 * for wiring this to SIGTERM after they've stopped accepting new work.
 */
export async function closePool(pool) {
  await pool.end();
}

/**
 * Runs `fn` inside a single transaction on a dedicated client. `fn` receives
 * the checked-out client (`tx`) and MUST propagate it to every repository
 * call it makes — never pass the pool itself into a code path that is
 * already inside a transaction, as `withTransaction` is not re-entrant.
 *
 * On SERIALIZATION_FAILURE (40001) or DEADLOCK_DETECTED (40P01), `fn` is
 * re-run from scratch up to `MAX_TX_ATTEMPTS` times before the error
 * propagates to the caller.
 *
 * @template T
 * @param {pg.Pool} pool
 * @param {(tx: pg.PoolClient) => Promise<T>} fn
 * @param {{ isolation?: 'read committed' | 'serializable' }} [opts]
 * @returns {Promise<T>}
 */
export async function withTransaction(pool, fn, opts = {}) {
  const isolation = opts.isolation ?? 'read committed';
  const logger = pool.__xyroLogger ?? pino({ level: Config.logLevel });
  const client = await pool.connect();
  instrumentQuery(client, logger);
  try {
    for (let attempt = 1; attempt <= MAX_TX_ATTEMPTS; attempt += 1) {
      try {
        await client.query('BEGIN');
        if (isolation === 'serializable') {
          await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
        }
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        const retryable =
          err.code === PG_ERROR.SERIALIZATION_FAILURE || err.code === PG_ERROR.DEADLOCK_DETECTED;
        if (retryable && attempt < MAX_TX_ATTEMPTS) continue;
        throw err;
      }
    }
    // Unreachable: the loop always returns or throws.
    return undefined;
  } finally {
    client.release();
  }
}

/**
 * Runs `fn` while holding a Postgres advisory lock keyed by `key` (BigInt).
 * Non-blocking: if the lock is already held elsewhere, returns `null`
 * immediately without running `fn` — callers such as `jobs/main.js` rely on
 * this so ticks never stack up behind a slow previous run.
 *
 * @template T
 * @param {pg.Pool} pool
 * @param {bigint} key
 * @param {(tx: pg.PoolClient) => Promise<T>} fn
 * @returns {Promise<T | null>}
 */
export async function withAdvisoryLock(pool, key, fn) {
  const logger = pool.__xyroLogger ?? pino({ level: Config.logLevel });
  const client = await pool.connect();
  instrumentQuery(client, logger);
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [key]);
    if (!rows[0].locked) {
      return null;
    }
    try {
      return await fn(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [key]);
    }
  } finally {
    client.release();
  }
}
