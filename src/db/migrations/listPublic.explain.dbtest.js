import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../../config/env.js';
import { closePool, createPool } from '../pool.js';
import { runMigrations } from './run.js';
import { buildListPublicWhere } from '../repositories/listingsRepo.js';

/**
 * Contract-mandated non-regression test (`2-Architecture.md`, bloc
 * `db/migrations`): EXPLAIN on `listPublic` filtered by tags/mode/text, on a
 * 100 000-row fixture, must show zero Seq Scan on `listings`. Requires a
 * disposable Postgres reachable via TEST_DATABASE_URL (falls back to
 * Config.databaseUrl) — run via `npm run test:db`, not `npm test`.
 */

const SEED_USER_ID = '00000000-0000-0000-0000-000000000001';
const ROW_COUNT = 100_000;

let pool;

before(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? Config.databaseUrl;
  pool = await createPool('migrate');
  await runMigrations(pool);

  await pool.query(
    `INSERT INTO users (id, discord_id, username) VALUES ($1, 'seed-user', 'Seed User')
     ON CONFLICT (id) DO NOTHING`,
    [SEED_USER_ID],
  );
  await pool.query(
    `INSERT INTO guilds (id, name, owner_discord_id, bot_present)
     SELECT 'seed-guild-' || i, 'Guild ' || i, 'seed-user', true
     FROM generate_series(1, $1) AS i
     ON CONFLICT (id) DO NOTHING`,
    [ROW_COUNT],
  );
  await pool.query(
    `INSERT INTO listings (user_id, guild_id, mode, description, tags, seeking_tags, status)
     SELECT
       $1,
       'seed-guild-' || i,
       CASE WHEN i % 2 = 0 THEN 'don' ELSE 'echange' END,
       'Description de test numero ' || i || ' pour la recherche en francais',
       ARRAY['tag' || (i % 50), 'commun'],
       CASE WHEN i % 2 = 0 THEN ARRAY[]::text[] ELSE ARRAY['tag' || ((i + 1) % 50)] END,
       'active'
     FROM generate_series(1, $2) AS i
     ON CONFLICT DO NOTHING`,
    [SEED_USER_ID, ROW_COUNT],
  );
  await pool.query('ANALYZE listings');
});

after(async () => {
  await closePool(pool);
});

async function explainListPublic(filters) {
  const { whereSql, baseParams } = buildListPublicWhere(filters);
  const { rows } = await pool.query(
    `EXPLAIN SELECT * FROM listings WHERE ${whereSql} ORDER BY created_at DESC, id DESC LIMIT 20`,
    baseParams,
  );
  return rows.map((r) => r['QUERY PLAN']).join('\n');
}

const FILTER_CASES = [
  { name: 'mode only', filters: { mode: 'don' } },
  { name: 'tags only', filters: { tags: ['tag7'] } },
  { name: 'full-text q only', filters: { q: 'francais' } },
  { name: 'mode + tags', filters: { mode: 'echange', tags: ['tag12'] } },
  { name: 'mode + tags + q', filters: { mode: 'echange', tags: ['tag12'], q: 'test' } },
];

for (const { name, filters } of FILTER_CASES) {
  test(`listPublic (${name}) never Seq Scans listings at 100k rows`, async () => {
    const plan = await explainListPublic(filters);
    assert.ok(
      !/Seq Scan on listings/i.test(plan),
      `expected an index-driven plan, got:\n${plan}`,
    );
  });
}
