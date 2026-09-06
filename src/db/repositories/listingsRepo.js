import { mapPgError, mapRow, paginateKeyset } from './shared.js';

const DEFAULT_PAGE_SIZE = 20;

/**
 * Data access for the `listings` aggregate. Tag normalization, ownership
 * checks and visibility rules live in `domain/listings.js` — this module
 * only persists and reads what it's given.
 */
export const listingsRepo = {
  async insert(tx, { userId, guildId, mode, description, tags, seekingTags }) {
    try {
      const { rows } = await tx.query(
        `INSERT INTO listings (user_id, guild_id, mode, description, tags, seeking_tags)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [userId, guildId, mode, description, tags, seekingTags],
      );
      return mapRow(rows[0]);
    } catch (err) {
      throw mapPgError(err);
    }
  },

  async findById(tx, id) {
    const { rows } = await tx.query('SELECT * FROM listings WHERE id = $1', [id]);
    return mapRow(rows[0]) ?? null;
  },

  async findActiveByGuild(tx, guildId) {
    const { rows } = await tx.query(
      "SELECT * FROM listings WHERE guild_id = $1 AND status = 'active'",
      [guildId],
    );
    return mapRow(rows[0]) ?? null;
  },

  /** All active listings, optionally restricted to a mode — the matching engine's candidate pool. */
  async listActive(tx, { mode } = {}) {
    const { rows } = mode
      ? await tx.query("SELECT * FROM listings WHERE status = 'active' AND mode = $1", [mode])
      : await tx.query("SELECT * FROM listings WHERE status = 'active'");
    return rows.map(mapRow);
  },

  async updateFields(tx, id, patch) {
    const { rows } = await tx.query(
      `UPDATE listings SET
         description = COALESCE($2, description),
         tags = COALESCE($3, tags),
         seeking_tags = COALESCE($4, seeking_tags),
         status = COALESCE($5, status),
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, patch.description ?? null, patch.tags ?? null, patch.seekingTags ?? null, patch.status ?? null],
    );
    return mapRow(rows[0]) ?? null;
  },

  async listByUser(tx, userId, { limit = DEFAULT_PAGE_SIZE, cursor } = {}) {
    return paginateKeyset(tx, {
      selectSql: 'SELECT * FROM listings WHERE user_id = $1',
      countSql: 'SELECT count(*)::int AS total FROM listings WHERE user_id = $1',
      baseParams: [userId],
      limit,
      cursor,
    });
  },

  /**
   * Public directory read. Every combination of `tags`/`mode`/`q` is served
   * by a declared index (composite btree for status+mode+created_at, GIN for
   * tags/full-text) — no code path here degenerates into a sequential scan
   * on `listings`, verified by `listPublic.explain.dbtest.js` against a
   * 100k-row fixture, using the exact WHERE clause built by
   * `buildListPublicWhere` below.
   */
  async listPublic(tx, filters = {}, { limit = DEFAULT_PAGE_SIZE, cursor } = {}) {
    const { whereSql, baseParams } = buildListPublicWhere(filters);
    return paginateKeyset(tx, {
      selectSql: `SELECT * FROM listings WHERE ${whereSql}`,
      countSql: `SELECT count(*)::int AS total FROM listings WHERE ${whereSql}`,
      baseParams,
      limit,
      cursor,
    });
  },
};

/**
 * Builds the WHERE clause + params for `listPublic`, shared with the EXPLAIN
 * regression test so the plan checked there is exactly the plan production
 * traffic gets.
 */
export function buildListPublicWhere({ tags, mode, q } = {}) {
  const conditions = ["status = 'active'"];
  const baseParams = [];

  if (mode) {
    baseParams.push(mode);
    conditions.push(`mode = $${baseParams.length}`);
  }
  if (tags && tags.length > 0) {
    baseParams.push(tags);
    conditions.push(`tags && $${baseParams.length}`);
  }
  if (q) {
    baseParams.push(q);
    conditions.push(`search_tsv @@ plainto_tsquery('french', $${baseParams.length})`);
  }

  return { whereSql: conditions.join(' AND '), baseParams };
}
