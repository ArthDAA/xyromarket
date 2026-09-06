import { mapRow } from './shared.js';

/**
 * Data access for `pending_notifications` — see the Phase III prompt's Q1
 * handling: no off-platform delivery channel is decided yet, so
 * `trial.expire`, `dispute.open` and `moderation.sanction` (and similarly
 * time-sensitive events) persist the intent here instead of attempting
 * delivery.
 * // TODO: canal de notification externe non tranché (Q1)
 */
export const pendingNotificationsRepo = {
  async insert(tx, { userId, eventType, payload = {} }) {
    const { rows } = await tx.query(
      `INSERT INTO pending_notifications (user_id, event_type, payload) VALUES ($1, $2, $3) RETURNING *`,
      [userId, eventType, JSON.stringify(payload)],
    );
    return mapRow(rows[0]);
  },

  async listUndeliveredForUser(tx, userId) {
    const { rows } = await tx.query(
      'SELECT * FROM pending_notifications WHERE user_id = $1 AND delivered_at IS NULL ORDER BY created_at DESC',
      [userId],
    );
    return rows.map(mapRow);
  },
};
