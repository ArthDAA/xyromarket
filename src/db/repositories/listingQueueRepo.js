import { mapPgError, mapRow } from './shared.js';

/** Data access for `listing_queue` — the FIFO backing `domain/matching/queue.js`. */
export const listingQueueRepo = {
  async findActiveEntry(tx, listingId, candidateUserId) {
    const { rows } = await tx.query(
      `SELECT * FROM listing_queue
       WHERE listing_id = $1 AND candidate_user_id = $2 AND skipped_at IS NULL AND withdrawn_at IS NULL`,
      [listingId, candidateUserId],
    );
    return mapRow(rows[0]) ?? null;
  },

  async nextPosition(tx, listingId) {
    const { rows } = await tx.query(
      'SELECT COALESCE(max(position), 0) + 1 AS next FROM listing_queue WHERE listing_id = $1',
      [listingId],
    );
    return rows[0].next;
  },

  async insert(tx, { listingId, candidateUserId, position }) {
    try {
      const { rows } = await tx.query(
        `INSERT INTO listing_queue (listing_id, candidate_user_id, position)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [listingId, candidateUserId, position],
      );
      return mapRow(rows[0]);
    } catch (err) {
      throw mapPgError(err);
    }
  },

  /** First entry not skipped or withdrawn, in FIFO order. */
  async head(tx, listingId) {
    const { rows } = await tx.query(
      `SELECT * FROM listing_queue
       WHERE listing_id = $1 AND skipped_at IS NULL AND withdrawn_at IS NULL
       ORDER BY position ASC LIMIT 1`,
      [listingId],
    );
    return mapRow(rows[0]) ?? null;
  },

  async hasAnyActive(tx, listingId) {
    const head = await listingQueueRepo.head(tx, listingId);
    return head !== null;
  },

  async skip(tx, listingId, candidateUserId) {
    const { rows } = await tx.query(
      `UPDATE listing_queue SET skipped_at = now()
       WHERE listing_id = $1 AND candidate_user_id = $2 AND skipped_at IS NULL AND withdrawn_at IS NULL
       RETURNING *`,
      [listingId, candidateUserId],
    );
    return mapRow(rows[0]) ?? null;
  },

  async withdraw(tx, listingId, candidateUserId) {
    const { rows } = await tx.query(
      `UPDATE listing_queue SET withdrawn_at = now()
       WHERE listing_id = $1 AND candidate_user_id = $2 AND withdrawn_at IS NULL
       RETURNING *`,
      [listingId, candidateUserId],
    );
    return mapRow(rows[0]) ?? null;
  },
};
