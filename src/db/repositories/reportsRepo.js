import { mapRow, paginateKeyset } from './shared.js';

/** Data access for the `reports` aggregate. */
export const reportsRepo = {
  async insert(tx, { reporterId, targetType, targetId, reason, body, status = 'open' }) {
    const { rows } = await tx.query(
      `INSERT INTO reports (reporter_id, target_type, target_id, reason, body, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [reporterId, targetType, targetId, reason, body, status],
    );
    return mapRow(rows[0]);
  },

  async findById(tx, id) {
    const { rows } = await tx.query('SELECT * FROM reports WHERE id = $1', [id]);
    return mapRow(rows[0]) ?? null;
  },

  async listFiltered(tx, { status } = {}, { limit = 20, cursor } = {}) {
    const conditions = ['1 = 1'];
    const baseParams = [];
    if (status) {
      baseParams.push(status);
      conditions.push(`status = $${baseParams.length}`);
    }
    const whereSql = conditions.join(' AND ');
    return paginateKeyset(tx, {
      selectSql: `SELECT * FROM reports WHERE ${whereSql}`,
      countSql: `SELECT count(*)::int AS total FROM reports WHERE ${whereSql}`,
      baseParams,
      limit,
      cursor,
    });
  },

  async assign(tx, id, assigneeId) {
    const { rows } = await tx.query(
      "UPDATE reports SET assignee_id = $2, status = 'assigned' WHERE id = $1 RETURNING *",
      [id, assigneeId],
    );
    return mapRow(rows[0]) ?? null;
  },

  async resolve(tx, id) {
    const { rows } = await tx.query(
      "UPDATE reports SET status = 'resolved', resolved_at = now() WHERE id = $1 RETURNING *",
      [id],
    );
    return mapRow(rows[0]) ?? null;
  },

  async markStale(tx, id) {
    const { rows } = await tx.query("UPDATE reports SET status = 'stale' WHERE id = $1 RETURNING *", [
      id,
    ]);
    return mapRow(rows[0]) ?? null;
  },

  async countOpen(tx) {
    const { rows } = await tx.query("SELECT count(*)::int AS count FROM reports WHERE status = 'open'");
    return rows[0].count;
  },
};
