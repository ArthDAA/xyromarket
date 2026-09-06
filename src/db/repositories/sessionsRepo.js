import { mapRow } from './shared.js';

/** Data access for `sessions` — the single source of truth `web/auth/session.js` reads per request. */
export const sessionsRepo = {
  async insert(tx, { id, userId, csrfSecret, expiresAt }) {
    const { rows } = await tx.query(
      `INSERT INTO sessions (id, user_id, csrf_secret, expires_at) VALUES ($1, $2, $3, $4) RETURNING *`,
      [id, userId, csrfSecret, expiresAt],
    );
    return mapRow(rows[0]);
  },

  async findValid(tx, id) {
    const { rows } = await tx.query(
      'SELECT * FROM sessions WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()',
      [id],
    );
    return mapRow(rows[0]) ?? null;
  },

  async renew(tx, id, expiresAt) {
    await tx.query('UPDATE sessions SET expires_at = $2 WHERE id = $1', [id, expiresAt]);
  },

  async revoke(tx, id) {
    await tx.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [id]);
  },

  async revokeAllForUser(tx, userId) {
    await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  },
};
