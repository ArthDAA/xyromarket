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
  // TRUNCATE rather than ON CONFLICT DO NOTHING for listings: re-running this fixture with an
  // edited description/tag pattern must actually replace the previous run's rows, not skip them.
  await pool.query("DELETE FROM listings WHERE guild_id LIKE 'seed-guild-%'");
  await pool.query(
    `INSERT INTO listings (user_id, guild_id, mode, description, tags, seeking_tags, status, created_at)
     SELECT
       $1,
       'seed-guild-' || i,
       (CASE WHEN i % 2 = 0 THEN 'don' ELSE 'echange' END)::listing_mode,
       'Description de test numero ' || i ||
         CASE WHEN i % 200 = 0 THEN ' mention speciale zorglub' ELSE ' communaute active et sympathique' END,
       ARRAY['tag' || (i % 50), 'commun'],
       CASE WHEN i % 2 = 0 THEN ARRAY[]::text[] ELSE ARRAY['tag' || ((i + 1) % 50)] END,
       'active'::listing_status,
       -- Bulk-generated rows would otherwise all share one now(), defeating the
       -- (status, mode, created_at DESC) index's LIMIT short-circuit for ties —
       -- real listings are created one at a time, over months, never at one instant.
       now() - (i || ' seconds')::interval
     FROM generate_series(1, $2) AS i
     ON CONFLICT DO NOTHING`,
    [SEED_USER_ID, ROW_COUNT],
  );
  await pool.query('ANALYZE listings');
});

after(async () => {
  // This fixture's 100k listings must not leak into other *.dbtest.js files sharing the same
  // database (they did once — engine.runRound in integration.dbtest.js picked up 50k+ stray
  // "active" listings from here and ground through an O(n^2) preference build). The 100k
  // `seed-guild-*` rows themselves are left in place: nothing in the app ever deletes a guild
  // (GDPR pseudonymizes, never cascades — see domain/gdpr.js), so no other test reads them, and
  // deleting them here would mean Postgres sequentially re-scanning transactions/
  // ownership_events per row to enforce their RESTRICT FKs — real, but only because of this
  // artificial bulk fixture, not a path production code ever takes.
  await pool.query("DELETE FROM listings WHERE guild_id LIKE 'seed-guild-%'");
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
  { name: 'full-text q only', filters: { q: 'zorglub' } },
  { name: 'mode + tags', filters: { mode: 'echange', tags: ['tag12'] } },
  { name: 'mode + tags + q', filters: { mode: 'echange', tags: ['tag12'], q: 'zorglub' } },
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
