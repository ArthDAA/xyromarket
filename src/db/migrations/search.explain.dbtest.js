import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Config, loadDotEnvInto } from '../../config/env.js';
import { closePool, createPool } from '../pool.js';
import { runMigrations } from './run.js';
import { buildSearchSql } from '../repositories/listingsRepo.js';

/**
 * Non-regression test for `listingsRepo.search` (A28, migration 006): each
 * of the four `UNION`ed branches (tag, guild name, owner username,
 * description) must be served by an index — a `UNION` of Seq Scans is just
 * as slow as one big `OR`'d Seq Scan. Same pattern and row count as
 * `listPublic.explain.dbtest.js` — tried a smaller (20k) fixture first, but
 * `users` (narrower rows than `guilds`, more fit per page) stayed below the
 * row count where Postgres prefers a Seq Scan over its trigram index; 100k
 * matches the sibling test's already-established, proven-reliable figure
 * instead of hunting for a smaller one that happens to work today.
 * Requires a disposable Postgres reachable via TEST_DATABASE_URL (falls
 * back to Config.databaseUrl) — run via `npm run test:db`, not `npm test`.
 */

const SEED_USER_ID = '00000000-0000-0000-0000-000000000002';
const ROW_COUNT = 100_000;

let pool;

before(async () => {
  loadDotEnvInto(process.env);
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? Config.databaseUrl;
  pool = await createPool('migrate');
  await runMigrations(pool);

  await pool.query(
    `INSERT INTO users (id, discord_id, username) VALUES ($1, 'search-seed-user', 'Seed User')
     ON CONFLICT (id) DO NOTHING`,
    [SEED_USER_ID],
  );
  await pool.query(
    `INSERT INTO users (id, discord_id, username)
     SELECT ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
            'search-user-' || i,
            CASE WHEN i % 500 = 0 THEN 'ZorglubOwner' || i ELSE 'RandomOwner' || i END
     FROM generate_series(1, $1) AS i
     ON CONFLICT (id) DO NOTHING`,
    [ROW_COUNT],
  );
  await pool.query(
    `INSERT INTO guilds (id, name, owner_discord_id, bot_present)
     SELECT 'search-guild-' || i,
            CASE WHEN i % 500 = 0 THEN 'ZorglubServer ' || i ELSE 'Random Server ' || i END,
            'search-seed-user', true
     FROM generate_series(1, $1) AS i
     ON CONFLICT (id) DO NOTHING`,
    [ROW_COUNT],
  );
  await pool.query("DELETE FROM listings WHERE guild_id LIKE 'search-guild-%'");
  await pool.query(
    `INSERT INTO listings (user_id, guild_id, mode, description, tags, seeking_tags, status, created_at)
     SELECT
       ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
       'search-guild-' || i,
       'don'::listing_mode,
       'Description de recherche numero ' || i ||
         CASE WHEN i % 500 = 0 THEN ' mention speciale zorglubtxt' ELSE ' communaute active et sympathique' END,
       CASE WHEN i % 500 = 0 THEN ARRAY['zorglubtag'] ELSE ARRAY['tag' || (i % 50)] END,
       ARRAY[]::text[],
       'active'::listing_status,
       now() - (i || ' seconds')::interval
     FROM generate_series(1, $1) AS i
     ON CONFLICT DO NOTHING`,
    [ROW_COUNT],
  );
  await pool.query('ANALYZE listings');
  await pool.query('ANALYZE guilds');
  await pool.query('ANALYZE users');
});

after(async () => {
  await pool.query("DELETE FROM listings WHERE guild_id LIKE 'search-guild-%'");
  await closePool(pool);
});

async function explainSearch(term) {
  const { sql, params } = buildSearchSql({ term, status: 'active', limit: 20 });
  const { rows } = await pool.query(`EXPLAIN ${sql}`, params);
  return rows.map((r) => r['QUERY PLAN']).join('\n');
}

const SEARCH_CASES = [
  { name: 'tag branch', term: 'zorglubtag' },
  { name: 'guild name branch', term: 'ZorglubServer' },
  { name: 'owner username branch', term: 'ZorglubOwner' },
  { name: 'description branch', term: 'zorglubtxt' },
];

for (const { name, term } of SEARCH_CASES) {
  test(`listingsRepo.search (${name}) never Seq Scans listings/guilds/users at 100k rows`, async () => {
    const plan = await explainSearch(term);
    assert.ok(!/Seq Scan on listings/i.test(plan), `expected an index-driven plan for listings, got:\n${plan}`);
    assert.ok(!/Seq Scan on guilds/i.test(plan), `expected an index-driven plan for guilds, got:\n${plan}`);
    assert.ok(!/Seq Scan on users/i.test(plan), `expected an index-driven plan for users, got:\n${plan}`);
  });
}
