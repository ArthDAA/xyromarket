/**
 * Well-known `users` row for automated actions that need a real FK target
 * (e.g. `reports.reporter_id`, NOT NULL) but have no human behind them —
 * `OWNER_DIVERTED`, `ERR_RATE_LIMITED` auto-reports. Audit log entries use
 * the plain string `'system'`/`'bot'` instead (its `actor_id` is TEXT, not
 * an FK), so this constant is only needed where a genuine FK applies.
 */
export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
