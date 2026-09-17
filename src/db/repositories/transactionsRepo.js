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

  /** Every transaction born from the same proposal — the edges of one TTC cycle (or the single edge of a queue match). */
  async findByProposalId(tx, proposalId) {
    const { rows } = await tx.query('SELECT * FROM transactions WHERE proposal_id = $1', [proposalId]);
    return rows.map(mapRow);
  },

  async findOpenByGuild(tx, guildId) {
    const { rows } = await tx.query(
      `SELECT * FROM transactions WHERE guild_id = $1 AND status NOT IN (${TERMINAL_STATUSES.map((_, i) => `$${i + 2}`).join(', ')})`,
      [guildId, ...TERMINAL_STATUSES],
    );
    return mapRow(rows[0]) ?? null;
  },

  /** TRANSFERRED transactions whose dispute window has elapsed with no open dispute — `jobs.trialExpiry`'s auto-close sweep. */
  async findTransferredWithoutOpenDispute(tx, cutoffDate) {
    const { rows } = await tx.query(
      `SELECT t.* FROM transactions t
       WHERE t.status = 'TRANSFERRED' AND t.transferred_at < $1
         AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.transaction_id = t.id AND d.status <> 'resolved')`,
      [cutoffDate],
    );
    return rows.map(mapRow);
  },

  async findExpiredTrials(tx, now) {
    const { rows } = await tx.query(
      "SELECT * FROM transactions WHERE status = 'TRIAL' AND trial_ends_at < $1",
      [now],
    );
    return rows.map(mapRow);
  },

  /** All transactions currently `TRIAL` — `jobs.ownershipSweep`'s tighter-cadence scope. */
  async findAllInTrial(tx) {
    const { rows } = await tx.query("SELECT * FROM transactions WHERE status = 'TRIAL'");
    return rows.map(mapRow);
  },

  /** Distinct user ids with at least one completed transaction — `jobs.statsRefresh`'s Vérifié re-evaluation scope. */
  async listUserIdsWithCompletedTransaction(tx) {
    const { rows } = await tx.query(
      `SELECT DISTINCT user_id FROM (
         SELECT from_user_id AS user_id FROM transactions WHERE status IN ('TRANSFERRED', 'CLOSED')
         UNION
         SELECT to_user_id AS user_id FROM transactions WHERE status IN ('TRANSFERRED', 'CLOSED')
       ) ids`,
    );
    return rows.map((r) => r.user_id);
  },

  /** Completed (TRANSFERRED or CLOSED) transactions involving `userId`, either side. */
  async countCompletedByUser(tx, userId) {
    const { rows } = await tx.query(
      `SELECT count(*)::int AS count FROM transactions
       WHERE (from_user_id = $1 OR to_user_id = $1) AND status IN ('TRANSFERRED', 'CLOSED')`,
      [userId],
    );
    return rows[0].count;
  },

  /**
   * Admin moderation read (`GET /admin/transactions`) — until now the only way to reach a
   * transaction from the panel was already knowing its UUID (a report, a notification, the
   * audit log). Optional `status`/`guildId` filters, no forced scope unlike `listByUser`.
   */
  async listForModeration(tx, { status, guildId } = {}, { limit = 20, cursor } = {}) {
    const conditions = [];
    const baseParams = [];
    if (status) {
      baseParams.push(status);
      conditions.push(`status = $${baseParams.length}`);
    }
    if (guildId) {
      baseParams.push(guildId);
      conditions.push(`guild_id = $${baseParams.length}`);
    }
    const whereSql = conditions.length > 0 ? conditions.join(' AND ') : '1 = 1';
    return paginateKeyset(tx, {
      selectSql: `SELECT * FROM transactions WHERE ${whereSql}`,
      countSql: `SELECT count(*)::int AS total FROM transactions WHERE ${whereSql}`,
      baseParams,
      limit,
      cursor,
    });
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

  /** ACCEPTED transactions whose trial hasn't started — still waiting on the recipient to join the target guild (A34). */
  async findAcceptedAwaitingTrial(tx) {
    const { rows } = await tx.query("SELECT * FROM transactions WHERE status = 'ACCEPTED' AND trial_started_at IS NULL");
    return rows.map(mapRow);
  },

  /** TRIAL transactions ending at or before `before`, not yet reminded (A34 — `jobs.trialReminderTick`). */
  async findTrialsEndingSoon(tx, before) {
    const { rows } = await tx.query(
      "SELECT * FROM transactions WHERE status = 'TRIAL' AND trial_ends_at <= $1 AND trial_reminder_sent_at IS NULL",
      [before],
    );
    return rows.map(mapRow);
  },

  async setInviteSent(tx, id, at) {
    await tx.query('UPDATE transactions SET invite_sent_at = $2 WHERE id = $1', [id, at]);
  },

  async setTrialReminderSent(tx, id, at) {
    await tx.query('UPDATE transactions SET trial_reminder_sent_at = $2 WHERE id = $1', [id, at]);
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
