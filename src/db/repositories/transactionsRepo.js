import { mapRow, paginateKeyset } from './shared.js';

const TERMINAL_STATUSES = ['CANCELLED', 'EXPIRED', 'CLOSED'];

/**
 * Data access for the `transactions` aggregate. `domain/trial.js` is the
 * only caller allowed to mutate `status` — this module exposes narrow,
 * explicit setters rather than a generic patch, so a reset to NULL (e.g.
 * validation state on cancellation) is always deliberate.
 */
export const transactionsRepo = {
  async insert(tx, { proposalId, fromUserId, toUserId, guildId, status = 'PROPOSED' }) {
    const { rows } = await tx.query(
      `INSERT INTO transactions (proposal_id, from_user_id, to_user_id, guild_id, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [proposalId, fromUserId, toUserId, guildId, status],
    );
    return mapRow(rows[0]);
  },

  async findById(tx, id) {
    const { rows } = await tx.query('SELECT * FROM transactions WHERE id = $1', [id]);
    return mapRow(rows[0]) ?? null;
  },

  /** Locks the row for the duration of an FSM transition. */
  async lockById(tx, id) {
    const { rows } = await tx.query('SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [id]);
    return mapRow(rows[0]) ?? null;
  },

  async findOpenByGuild(tx, guildId) {
    const { rows } = await tx.query(
      `SELECT * FROM transactions WHERE guild_id = $1 AND status NOT IN (${TERMINAL_STATUSES.map((_, i) => `$${i + 2}`).join(', ')})`,
      [guildId, ...TERMINAL_STATUSES],
    );
    return mapRow(rows[0]) ?? null;
  },

  async findExpiredTrials(tx, now) {
    const { rows } = await tx.query(
      "SELECT * FROM transactions WHERE status = 'TRIAL' AND trial_ends_at < $1",
      [now],
    );
    return rows.map(mapRow);
  },

  async listByUser(tx, userId, { limit = 20, cursor } = {}) {
    return paginateKeyset(tx, {
      selectSql: 'SELECT * FROM transactions WHERE from_user_id = $1 OR to_user_id = $1',
      countSql: 'SELECT count(*)::int AS total FROM transactions WHERE from_user_id = $1 OR to_user_id = $1',
      baseParams: [userId],
      limit,
      cursor,
    });
  },

  async setStatus(tx, id, status) {
    const { rows } = await tx.query(
      'UPDATE transactions SET status = $2, updated_at = now() WHERE id = $1 RETURNING *',
      [id, status],
    );
    return mapRow(rows[0]) ?? null;
  },

  async setTrialWindow(tx, id, { trialStartedAt, trialEndsAt, trialRoleId }) {
    const { rows } = await tx.query(
      `UPDATE transactions
       SET trial_started_at = $2, trial_ends_at = $3, trial_role_id = $4, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, trialStartedAt, trialEndsAt, trialRoleId],
    );
    return mapRow(rows[0]) ?? null;
  },

  async recordValidation(tx, id, side) {
    const column = side === 'from' ? 'validated_by_from_at' : 'validated_by_to_at';
    const { rows } = await tx.query(
      `UPDATE transactions SET ${column} = now(), updated_at = now() WHERE id = $1 RETURNING *`,
      [id],
    );
    return mapRow(rows[0]) ?? null;
  },

  async resetValidation(tx, id) {
    const { rows } = await tx.query(
      `UPDATE transactions
       SET validated_by_from_at = NULL, validated_by_to_at = NULL, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id],
    );
    return mapRow(rows[0]) ?? null;
  },

  async setHubThread(tx, id, hubThreadId) {
    await tx.query('UPDATE transactions SET hub_thread_id = $2, updated_at = now() WHERE id = $1', [
      id,
      hubThreadId,
    ]);
  },

  async setTransferred(tx, id, transferredAt) {
    const { rows } = await tx.query(
      'UPDATE transactions SET transferred_at = $2, updated_at = now() WHERE id = $1 RETURNING *',
      [id, transferredAt],
    );
    return mapRow(rows[0]) ?? null;
  },

  async setAnnounced(tx, id, announcedAt) {
    await tx.query('UPDATE transactions SET announced_at = $2, updated_at = now() WHERE id = $1', [
      id,
      announcedAt,
    ]);
  },

  async setClosed(tx, id, closedAt) {
    const { rows } = await tx.query(
      'UPDATE transactions SET closed_at = $2, updated_at = now() WHERE id = $1 RETURNING *',
      [id, closedAt],
    );
    return mapRow(rows[0]) ?? null;
  },
};
