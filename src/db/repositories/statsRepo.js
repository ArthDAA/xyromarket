import { mapRow } from './shared.js';

/** Data access for `domain/stats.js` — the cache table plus the raw source aggregations it refreshes from. */
export const statsRepo = {
  async upsertDailyValue(tx, metric, bucketDate, value) {
    await tx.query(
      `INSERT INTO stats_cache (metric, bucket_date, value, computed_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (metric, bucket_date) DO UPDATE SET value = EXCLUDED.value, computed_at = now()`,
      [metric, bucketDate, value],
    );
  },

  async readSeries(tx, metric, { from, to }) {
    const { rows } = await tx.query(
      'SELECT bucket_date, value, computed_at FROM stats_cache WHERE metric = $1 AND bucket_date BETWEEN $2 AND $3 ORDER BY bucket_date',
      [metric, from, to],
    );
    return rows.map(mapRow);
  },

  async latestComputedAt(tx, metric) {
    const { rows } = await tx.query('SELECT max(computed_at) AS at FROM stats_cache WHERE metric = $1', [
      metric,
    ]);
    return rows[0].at;
  },

  // --- raw source aggregations, one per time-series metric refreshAll populates ---

  async usersTotalByDay(tx) {
    const { rows } = await tx.query(
      `SELECT date_trunc('day', created_at)::date AS bucket, count(*)::int AS value
       FROM users GROUP BY bucket ORDER BY bucket`,
    );
    return rows;
  },
  async usersVerifiedTotal(tx) {
    const { rows } = await tx.query("SELECT count(*)::int AS value FROM users WHERE is_verified = true");
    return rows[0].value;
  },
  async usersSanctionedTotal(tx) {
    const { rows } = await tx.query(
      'SELECT count(DISTINCT user_id)::int AS value FROM sanctions WHERE revoked_at IS NULL',
    );
    return rows[0].value;
  },
  async listingsTotalByDay(tx) {
    const { rows } = await tx.query(
      `SELECT date_trunc('day', created_at)::date AS bucket, count(*)::int AS value
       FROM listings GROUP BY bucket ORDER BY bucket`,
    );
    return rows;
  },
  async transactionsCompletedByDay(tx) {
    const { rows } = await tx.query(
      `SELECT date_trunc('day', transferred_at)::date AS bucket, count(*)::int AS value
       FROM transactions WHERE transferred_at IS NOT NULL GROUP BY bucket ORDER BY bucket`,
    );
    return rows;
  },
  async reviewsTotalByDay(tx) {
    const { rows } = await tx.query(
      `SELECT date_trunc('day', created_at)::date AS bucket, count(*)::int AS value
       FROM reviews GROUP BY bucket ORDER BY bucket`,
    );
    return rows;
  },
  async reviewsAverageOverall(tx) {
    const { rows } = await tx.query('SELECT avg(rating)::float AS value FROM reviews WHERE hidden_at IS NULL');
    return rows[0].value ?? 0;
  },

  // --- live breakdown/point-in-time reads (no caching needed, cheap aggregates) ---

  async listingsActiveByMode(tx) {
    const { rows } = await tx.query(
      "SELECT mode AS bucket, count(*)::int AS value FROM listings WHERE status = 'active' GROUP BY mode",
    );
    return rows;
  },
  async listingsByTag(tx) {
    const { rows } = await tx.query(
      `SELECT unnest(tags) AS bucket, count(*)::int AS value FROM listings
       WHERE status = 'active' GROUP BY bucket ORDER BY value DESC LIMIT 50`,
    );
    return rows;
  },
  async transactionsByStatus(tx) {
    const { rows } = await tx.query('SELECT status AS bucket, count(*)::int AS value FROM transactions GROUP BY status');
    return rows;
  },
  async transactionsMedianTimeToTransferHours(tx) {
    const { rows } = await tx.query(
      `SELECT percentile_cont(0.5) WITHIN GROUP (
         ORDER BY EXTRACT(EPOCH FROM (transferred_at - created_at)) / 3600
       ) AS value
       FROM transactions WHERE transferred_at IS NOT NULL`,
    );
    return rows[0].value ?? null;
  },
  async transactionsTrialExpiryRate(tx) {
    const { rows } = await tx.query(
      `SELECT
         count(*) FILTER (WHERE status = 'EXPIRED')::float
           / NULLIF(count(*) FILTER (WHERE trial_started_at IS NOT NULL), 0) AS value
       FROM transactions`,
    );
    return rows[0].value ?? 0;
  },
  async reportsOpenCount(tx) {
    const { rows } = await tx.query("SELECT count(*)::int AS value FROM reports WHERE status = 'open'");
    return rows[0].value;
  },
  async reportsMedianResolutionHours(tx) {
    const { rows } = await tx.query(
      `SELECT percentile_cont(0.5) WITHIN GROUP (
         ORDER BY EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600
       ) AS value
       FROM reports WHERE resolved_at IS NOT NULL`,
    );
    return rows[0].value ?? null;
  },
  async disputesOpenCount(tx) {
    const { rows } = await tx.query("SELECT count(*)::int AS value FROM disputes WHERE status <> 'resolved'");
    return rows[0].value;
  },
  async matchingCycleSizeDistribution(tx) {
    const { rows } = await tx.query(
      `SELECT member_count AS bucket, count(*)::int AS value FROM (
         SELECT proposal_id, count(*) AS member_count FROM match_participants
         INNER JOIN match_proposals mp ON mp.id = proposal_id AND mp.kind = 'cycle'
         GROUP BY proposal_id
       ) sizes
       GROUP BY member_count ORDER BY member_count`,
    );
    return rows;
  },
};
