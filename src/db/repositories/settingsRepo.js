import { mapRow } from './shared.js';

/** Coded defaults used when a key is absent from the `settings` table. */
const DEFAULTS = {
  trial_duration_days: 7,
  dispute_window_days: 14,
  verified_rules: { minTransactions: 3, minAverage: 4, minAccountAgeDays: 30, noActiveSanction: true },
};

/** Data access for the `settings` key-value store. `get` never returns `undefined`. */
export const settingsRepo = {
  async get(tx, key) {
    const { rows } = await tx.query('SELECT value FROM settings WHERE key = $1', [key]);
    if (rows[0]) return rows[0].value;
    if (key in DEFAULTS) return DEFAULTS[key];
    return null;
  },

  async getAll(tx) {
    const { rows } = await tx.query('SELECT * FROM settings ORDER BY key');
    return rows.map(mapRow);
  },

  async set(tx, key, value, updatedBy) {
    const { rows } = await tx.query(
      `INSERT INTO settings (key, value, updated_by, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING *`,
      [key, JSON.stringify(value), updatedBy],
    );
    return mapRow(rows[0]);
  },
};
