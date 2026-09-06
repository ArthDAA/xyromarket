import { mapRow, paginateKeyset } from './shared.js';

/** Data access for the `sanctions` aggregate — platform-only sanctions, never Discord actions. */
export const sanctionsRepo = {
  async insert(tx, { userId, kind, reason, actorId, endsAt = null }) {
    const { rows } = await tx.query(
      `INSERT INTO sanctions (user_id, kind, reason, actor_id, ends_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [userId, kind, reason, actorId, endsAt],
    );
    return mapRow(rows[0]);
  },

  async findById(tx, id) {
    const { rows } = await tx.query('SELECT * FROM sanctions WHERE id = $1', [id]);
    return mapRow(rows[0]) ?? null;
  },

  /** Active sanctions blocking session access — `session.js`'s gate. */
  async findActiveByUser(tx, userId) {
    const { rows } = await tx.query(
      `SELECT * FROM sanctions
       WHERE user_id = $1 AND revoked_at IS NULL AND (ends_at IS NULL OR ends_at > now())
       ORDER BY starts_at DESC`,
      [userId],
    );
    return rows.map(mapRow);
  },

  async findActiveOfKind(tx, userId, kind) {
    const { rows } = await tx.query(
      `SELECT * FROM sanctions
       WHERE user_id = $1 AND kind = $2 AND revoked_at IS NULL AND (ends_at IS NULL OR ends_at > now())`,
      [userId, kind],
    );
    return mapRow(rows[0]) ?? null;
  },

  async listByUser(tx, userId, { limit = 20, cursor } = {}) {
    return paginateKeyset(tx, {
      selectSql: 'SELECT *, starts_at AS created_at FROM sanctions WHERE user_id = $1',
      countSql: 'SELECT count(*)::int AS total FROM sanctions WHERE user_id = $1',
      baseParams: [userId],
      limit,
      cursor,
    });
  },

  async revoke(tx, id, revokedBy) {
    const { rows } = await tx.query(
      'UPDATE sanctions SET revoked_at = now(), revoked_by = $2 WHERE id = $1 RETURNING *',
      [id, revokedBy],
    );
    return mapRow(rows[0]) ?? null;
  },
};
