import { mapPgError, mapRow, paginateKeyset } from './shared.js';

/** Data access for the `reviews` aggregate. */
export const reviewsRepo = {
  async insert(tx, { transactionId, authorId, targetId, rating, body }) {
    try {
      const { rows } = await tx.query(
        `INSERT INTO reviews (transaction_id, author_id, target_id, rating, body)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [transactionId, authorId, targetId, rating, body],
      );
      return mapRow(rows[0]);
    } catch (err) {
      throw mapPgError(err);
    }
  },

  async findByTransactionAndAuthor(tx, transactionId, authorId) {
    const { rows } = await tx.query(
      'SELECT * FROM reviews WHERE transaction_id = $1 AND author_id = $2',
      [transactionId, authorId],
    );
    return mapRow(rows[0]) ?? null;
  },

  async countRecentByAuthor(tx, authorId, since) {
    const { rows } = await tx.query(
      'SELECT count(*)::int AS count FROM reviews WHERE author_id = $1 AND created_at > $2',
      [authorId, since],
    );
    return rows[0].count;
  },

  /** `{ count, average, distribution, asGiver, asReceiver }` — average is `null` with zero reviews. */
  async aggregateForUser(tx, userId) {
    const { rows: totals } = await tx.query(
      `SELECT
         count(*)::int AS count,
         avg(rating)::float AS average,
         avg(rating) FILTER (WHERE t.from_user_id = $1)::float AS as_giver_average,
         count(*) FILTER (WHERE t.from_user_id = $1)::int AS as_giver_count,
         avg(rating) FILTER (WHERE t.to_user_id = $1)::float AS as_receiver_average,
         count(*) FILTER (WHERE t.to_user_id = $1)::int AS as_receiver_count
       FROM reviews r
       JOIN transactions t ON t.id = r.transaction_id
       WHERE r.target_id = $1 AND r.hidden_at IS NULL`,
      [userId],
    );
    const { rows: byRating } = await tx.query(
      `SELECT rating, count(*)::int AS count FROM reviews
       WHERE target_id = $1 AND hidden_at IS NULL GROUP BY rating`,
      [userId],
    );
    const distribution = [0, 0, 0, 0, 0];
    for (const row of byRating) {
      distribution[row.rating - 1] = row.count;
    }
    const t = totals[0];
    return Object.freeze({
      count: t.count,
      average: t.count > 0 ? t.average : null,
      distribution,
      asGiver: { count: t.as_giver_count, average: t.as_giver_count > 0 ? t.as_giver_average : null },
      asReceiver: {
        count: t.as_receiver_count,
        average: t.as_receiver_count > 0 ? t.as_receiver_average : null,
      },
    });
  },

  async history(tx, userId, { limit = 20, cursor } = {}) {
    return paginateKeyset(tx, {
      selectSql: 'SELECT * FROM reviews WHERE target_id = $1 AND hidden_at IS NULL',
      countSql: 'SELECT count(*)::int AS total FROM reviews WHERE target_id = $1 AND hidden_at IS NULL',
      baseParams: [userId],
      limit,
      cursor,
    });
  },

  async hide(tx, id, hiddenBy) {
    const { rows } = await tx.query(
      'UPDATE reviews SET hidden_at = now(), hidden_by = $2 WHERE id = $1 RETURNING *',
      [id, hiddenBy],
    );
    return mapRow(rows[0]) ?? null;
  },
};
