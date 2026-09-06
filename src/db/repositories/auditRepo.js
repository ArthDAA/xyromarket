import { mapPgError, mapRow, paginateKeyset } from './shared.js';

/**
 * Data access for the append-only `audit_log`. No method here exposes
 * UPDATE or DELETE — the table's GRANTs enforce that at the database level.
 */
export const auditRepo = {
  async record(tx, { actorId, action, targetType, targetId, before = {}, after = {}, ipHash = null }) {
    try {
      const { rows } = await tx.query(
        `INSERT INTO audit_log (actor_id, action, target_type, target_id, before, after, ip_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [actorId, action, targetType, targetId, JSON.stringify(before), JSON.stringify(after), ipHash],
      );
      return mapRow(rows[0]);
    } catch (err) {
      throw mapPgError(err);
    }
  },

  async query(tx, { actorId, action, targetType, from, to } = {}, { limit = 50, cursor } = {}) {
    const conditions = ['1 = 1'];
    const baseParams = [];
    if (actorId) {
      baseParams.push(actorId);
      conditions.push(`actor_id = $${baseParams.length}`);
    }
    if (action) {
      baseParams.push(action);
      conditions.push(`action = $${baseParams.length}`);
    }
    if (targetType) {
      baseParams.push(targetType);
      conditions.push(`target_type = $${baseParams.length}`);
    }
    if (from) {
      baseParams.push(from);
      conditions.push(`at >= $${baseParams.length}`);
    }
    if (to) {
      baseParams.push(to);
      conditions.push(`at <= $${baseParams.length}`);
    }
    const whereSql = conditions.join(' AND ');
    return paginateKeyset(tx, {
      selectSql: `SELECT * FROM audit_log WHERE ${whereSql}`,
      countSql: `SELECT count(*)::int AS total FROM audit_log WHERE ${whereSql}`,
      baseParams,
      limit,
      cursor,
      orderColumn: 'at',
    });
  },

  /** Bounded feed behind `stats.js`'s `activity.recent` metric. */
  async recentActivity(tx, limit = 100) {
    const { rows } = await tx.query('SELECT * FROM audit_log ORDER BY at DESC LIMIT $1', [limit]);
    return rows.map(mapRow);
  },
};
