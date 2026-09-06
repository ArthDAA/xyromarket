import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import pino from 'pino';
import { Config } from '../../config/env.js';
import { LOCK_KEYS } from '../../config/lockKeys.js';
import { closePool, createPool, withAdvisoryLock } from '../pool.js';

const MIGRATIONS_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_FILE_RE = /^\d+_.*\.sql$/;

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function listMigrationFiles() {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((f) => MIGRATION_FILE_RE.test(f)).sort();
}

/**
 * Applies every migration file not yet recorded in `schema_migrations`, one
 * file per transaction, in lexicographic order, while holding the
 * `MIGRATION` advisory lock. Returns `{ applied: string[] }`, or `{ applied:
 * [] , skipped: true }` if another process is already migrating.
 */
export async function runMigrations(pool, { logger = pino({ level: Config.logLevel }) } = {}) {
  const result = await withAdvisoryLock(pool, LOCK_KEYS.MIGRATION, async (client) => {
    await ensureMigrationsTable(client);

    const diskVersions = new Set(await listMigrationFiles());
    const { rows } = await client.query('SELECT version FROM schema_migrations ORDER BY version');
    const appliedVersions = rows.map((r) => r.version);

    const diverged = appliedVersions.filter((v) => !diskVersions.has(v));
    if (diverged.length > 0) {
      logger.fatal({ diverged }, 'MIGRATION_DIVERGED: applied version missing from disk');
      process.exit(1);
    }

    const appliedSet = new Set(appliedVersions);
    const pending = [...diskVersions].filter((f) => !appliedSet.has(f)).sort();

    for (const file of pending) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        logger.info({ file }, 'migration applied');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        logger.fatal({ file, err: err.message }, 'MIGRATION_FAILED');
        process.exit(1);
      }
    }

    return { applied: pending };
  });

  if (result === null) {
    logger.info('another process is already migrating, skipping');
    return { applied: [], skipped: true };
  }
  return result;
}

/**
 * Read-only check used by `web/main.js`/`bot/main.js`/`jobs/main.js` at
 * boot: the process must not start if any migration on disk hasn't been
 * applied yet. Does not apply anything itself.
 */
export async function hasPendingMigrations(pool) {
  const diskVersions = new Set(await listMigrationFiles());
  const { rows } = await pool.query(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists",
  );
  if (!rows[0].exists) return diskVersions.size > 0;
  const { rows: applied } = await pool.query('SELECT version FROM schema_migrations');
  const appliedSet = new Set(applied.map((r) => r.version));
  return [...diskVersions].some((v) => !appliedSet.has(v));
}

// CLI entry point (`npm run migrate`).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = await createPool('migrate');
  try {
    await runMigrations(pool);
  } finally {
    await closePool(pool);
  }
}
