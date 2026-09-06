import { statsRepo } from '../db/repositories/statsRepo.js';
import { auditRepo } from '../db/repositories/auditRepo.js';

export class StatsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StatsError';
    this.code = code;
  }
}

/** The 19 metrics named in `2-Architecture.md` §2bis Statistiques + domain/stats.js. */
export const METRIC_KEYS = Object.freeze([
  'users.total',
  'users.new',
  'users.active',
  'users.verified',
  'users.sanctioned',
  'listings.total',
  'listings.active_by_mode',
  'listings.by_tag',
  'transactions.by_status',
  'transactions.completed',
  'transactions.median_time_to_transfer',
  'transactions.trial_expiry_rate',
  'reviews.total',
  'reviews.average',
  'reports.open',
  'reports.median_resolution_time',
  'disputes.open',
  'matching.cycle_size_distribution',
  'activity.recent',
]);

/** Metrics backed by the daily `stats_cache` and refreshed by `refreshAll` — time series, in the strict sense. */
const CACHED_TIME_SERIES = new Set([
  'users.total',
  'users.new', // same source series as users.total; range filtering distinguishes them
  'listings.total',
  'transactions.completed',
  'reviews.total',
]);

const REFRESH_INTERVAL_MS = 15 * 60 * 1000; // matches jobs.statsRefresh's cadence
const STALE_THRESHOLD_MS = 2 * REFRESH_INTERVAL_MS;
const MAX_RANGE_DAYS = 730;

function toDateOnly(d) {
  return new Date(d).toISOString().slice(0, 10);
}

/**
 * Reads one metric over `range`. Every reader goes through here — no admin
 * route recomputes a count on its own, so a number never diverges between
 * two screens. Time-series reads expose `computedAt`/`stale` from the
 * cache; breakdown/point-in-time reads are computed live and always fresh.
 */
export async function read(tx, metric, range = {}) {
  if (!METRIC_KEYS.includes(metric)) {
    throw new StatsError('ERR_UNKNOWN_METRIC', `Unknown metric: ${metric}`);
  }

  const from = range.from ?? new Date(Date.now() - 30 * 86_400_000);
  const to = range.to ?? new Date();
  const rangeDays = (to - from) / 86_400_000;
  if (range.granularity === 'day' && rangeDays > MAX_RANGE_DAYS) {
    throw new StatsError('ERR_RANGE_TOO_WIDE', `Range exceeds ${MAX_RANGE_DAYS} days at day granularity`);
  }

  if (metric === 'activity.recent') {
    const items = await auditRepo.recentActivity(tx, 100);
    return Object.freeze({ metric, points: [], items, computedAt: new Date(), stale: false });
  }

  if (CACHED_TIME_SERIES.has(metric)) {
    const sourceMetric = metric === 'users.new' ? 'users.total' : metric;
    const rows = await statsRepo.readSeries(tx, sourceMetric, { from: toDateOnly(from), to: toDateOnly(to) });
    const computedAt = await statsRepo.latestComputedAt(tx, sourceMetric);
    const stale = !computedAt || Date.now() - new Date(computedAt).getTime() > STALE_THRESHOLD_MS;
    const points = rows.map((r) => ({ bucket: r.bucketDate, value: Number(r.value) }));
    return Object.freeze({ metric, points, computedAt: computedAt ?? null, stale });
  }

  // Live breakdowns and point-in-time values — cheap aggregates, always fresh by construction.
  const points = await readLive(tx, metric);
  return Object.freeze({ metric, points, computedAt: new Date(), stale: false });
}

async function readLive(tx, metric) {
  switch (metric) {
    case 'users.verified':
      return [{ bucket: 'total', value: await statsRepo.usersVerifiedTotal(tx) }];
    case 'users.sanctioned':
      return [{ bucket: 'total', value: await statsRepo.usersSanctionedTotal(tx) }];
    case 'listings.active_by_mode':
      return (await statsRepo.listingsActiveByMode(tx)).map((r) => ({ bucket: r.bucket, value: r.value }));
    case 'listings.by_tag':
      return (await statsRepo.listingsByTag(tx)).map((r) => ({ bucket: r.bucket, value: r.value }));
    case 'transactions.by_status':
      return (await statsRepo.transactionsByStatus(tx)).map((r) => ({ bucket: r.bucket, value: r.value }));
    case 'transactions.median_time_to_transfer':
      return [{ bucket: 'median_hours', value: await statsRepo.transactionsMedianTimeToTransferHours(tx) }];
    case 'transactions.trial_expiry_rate':
      return [{ bucket: 'rate', value: await statsRepo.transactionsTrialExpiryRate(tx) }];
    case 'reviews.average':
      return [{ bucket: 'average', value: await statsRepo.reviewsAverageOverall(tx) }];
    case 'reports.open':
      return [{ bucket: 'total', value: await statsRepo.reportsOpenCount(tx) }];
    case 'reports.median_resolution_time':
      return [{ bucket: 'median_hours', value: await statsRepo.reportsMedianResolutionHours(tx) }];
    case 'disputes.open':
      return [{ bucket: 'total', value: await statsRepo.disputesOpenCount(tx) }];
    case 'matching.cycle_size_distribution':
      return (await statsRepo.matchingCycleSizeDistribution(tx)).map((r) => ({ bucket: r.bucket, value: r.value }));
    default:
      return [];
  }
}

/**
 * Refreshes every cached time-series metric, one at a time, logging
 * duration and row count — a failure on one metric never blocks the others
 * (`ERR_REFRESH_FAILED`: that metric simply keeps serving `stale: true`).
 */
export async function refreshAll(tx, { logger } = {}) {
  const sources = [
    ['users.total', statsRepo.usersTotalByDay],
    ['listings.total', statsRepo.listingsTotalByDay],
    ['transactions.completed', statsRepo.transactionsCompletedByDay],
    ['reviews.total', statsRepo.reviewsTotalByDay],
  ];

  const results = [];
  for (const [metric, fetcher] of sources) {
    const startedAt = Date.now();
    try {
      const rows = await fetcher(tx);
      for (const row of rows) {
        await statsRepo.upsertDailyValue(tx, metric, row.bucket, row.value);
      }
      results.push({ metric, ok: true, rows: rows.length, durationMs: Date.now() - startedAt });
    } catch (err) {
      logger?.error({ metric, err: err.message }, 'ERR_REFRESH_FAILED');
      results.push({ metric, ok: false, error: err.message, durationMs: Date.now() - startedAt });
    }
  }
  return results;
}
