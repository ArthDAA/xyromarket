import { mapPgError, mapRow } from './shared.js';

/** Data access for the `disputes` aggregate. `timeline` is append-only JSONB. */
export const disputesRepo = {
  async insert(tx, { transactionId, openedBy, reason }) {
    try {
      const { rows } = await tx.query(
        `INSERT INTO disputes (transaction_id, opened_by, reason, timeline)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [
          transactionId,
          openedBy,
          reason,
          JSON.stringify([{ at: new Date().toISOString(), actorId: openedBy, event: 'opened', reason }]),
        ],
      );
      return mapRow(rows[0]);
    } catch (err) {
      throw mapPgError(err);
    }
  },

  async findById(tx, id) {
    const { rows } = await tx.query('SELECT * FROM disputes WHERE id = $1', [id]);
    return mapRow(rows[0]) ?? null;
  },

  async findOpenByTransaction(tx, transactionId) {
    const { rows } = await tx.query(
      "SELECT * FROM disputes WHERE transaction_id = $1 AND status <> 'resolved'",
      [transactionId],
    );
    return mapRow(rows[0]) ?? null;
  },

  async appendTimelineEntry(tx, id, entry) {
    const { rows } = await tx.query(
      `UPDATE disputes SET timeline = timeline || $2::jsonb WHERE id = $1 RETURNING *`,
      [id, JSON.stringify([{ at: new Date().toISOString(), ...entry }])],
    );
    return mapRow(rows[0]) ?? null;
  },

  async setStatus(tx, id, status) {
    const { rows } = await tx.query('UPDATE disputes SET status = $2 WHERE id = $1 RETURNING *', [
      id,
      status,
    ]);
    return mapRow(rows[0]) ?? null;
  },

  async resolve(tx, id, { outcome, resolution, resolvedBy }) {
    const { rows } = await tx.query(
      `UPDATE disputes
       SET status = 'resolved', outcome = $2, resolution = $3, resolved_by = $4, resolved_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, outcome, resolution, resolvedBy],
    );
    return mapRow(rows[0]) ?? null;
  },
};
