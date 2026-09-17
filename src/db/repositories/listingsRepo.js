import { mapPgError, mapRow, paginateKeyset } from './shared.js';

const DEFAULT_PAGE_SIZE = 20;

/**
 * Data access for the `listings` aggregate. Tag normalization, ownership
 * checks and visibility rules live in `domain/listings.js` — this module
 * only persists and reads what it's given.
 */
export const listingsRepo = {
  async insert(tx, { userId, guildId, mode, description, tags, seekingTags, status = 'active' }) {
    try {
      const { rows } = await tx.query(
        `INSERT INTO listings (user_id, guild_id, mode, description, tags, seeking_tags, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [userId, guildId, mode, description, tags, seekingTags, status],
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

  /**
   * Physically deletes the row — `true` on success. Returns `false` (never
   * throws) on a `23503` (foreign_key_violation): `match_participants`/
   * `listing_queue` reference this listing under `ON DELETE RESTRICT` (a
   * past cancelled match, or anyone who ever joined its file d'attente,
   * even briefly withdrawn) and Postgres refuses the delete — the caller
   * falls back to a soft `removed` in that case (A18). A `SAVEPOINT` keeps
   * that refusal from poisoning the rest of the caller's transaction.
   */
  async hardDelete(tx, id) {
    await tx.query('SAVEPOINT listing_hard_delete');
    try {
      await tx.query('DELETE FROM listings WHERE id = $1', [id]);
      await tx.query('RELEASE SAVEPOINT listing_hard_delete');
      return true;
    } catch (err) {
      await tx.query('ROLLBACK TO SAVEPOINT listing_hard_delete');
      if (err?.code === '23503') return false;
      throw err;
    }
  },

  async findActiveByGuild(tx, guildId) {
    const { rows } = await tx.query(
      "SELECT * FROM listings WHERE guild_id = $1 AND status = 'active'",
      [guildId],
    );
    return mapRow(rows[0]) ?? null;
  },

  /**
   * `active`, `pending_bot`, or `matched` — the three "live" statuses
   * `uniq_listings_live_guild` also enforces (A21). `matched` is included
   * because a guild mid-proposal (claimed but not yet accepted/refused) is
   * exactly as unavailable for a new listing as an active or pending one —
   * without it, a second listing could be created on the same guild while
   * the first sits `matched`, and both could end up with an open
   * `transactions` row for that guild at once, tripping
   * `uniq_transactions_open_guild` (a guild-level constraint that assumes
   * at most one listing is ever live per guild).
   */
  async findLiveByGuild(tx, guildId) {
    const { rows } = await tx.query(
      "SELECT * FROM listings WHERE guild_id = $1 AND status IN ('active', 'pending_bot', 'matched')",
      [guildId],
    );
    return mapRow(rows[0]) ?? null;
  },

  async findPendingBotByGuild(tx, guildId) {
    const { rows } = await tx.query(
      "SELECT * FROM listings WHERE guild_id = $1 AND status = 'pending_bot'",
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

  /** Atomically claims a listing for a match, only if it's still `active`. `null` if it moved under us. */
  async claimForMatch(tx, id) {
    const { rows } = await tx.query(
      "UPDATE listings SET status = 'matched', updated_at = now() WHERE id = $1 AND status = 'active' RETURNING *",
      [id],
    );
    return mapRow(rows[0]) ?? null;
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

  /** `status` optional — every caller but the public profile (A31) wants every status, so it's left unfiltered by default. */
  async listByUser(tx, userId, { limit = DEFAULT_PAGE_SIZE, cursor, status } = {}) {
    const whereSql = status ? 'user_id = $1 AND status = $2' : 'user_id = $1';
    const baseParams = status ? [userId, status] : [userId];
    return paginateKeyset(tx, {
      selectSql: `SELECT * FROM listings WHERE ${whereSql}`,
      countSql: `SELECT count(*)::int AS total FROM listings WHERE ${whereSql}`,
      baseParams,
      limit,
      cursor,
    });
  },

  /**
   * Admin moderation read (`GET /admin/listings`) — deliberately separate
   * from `listPublic`: that one hardcodes `status = 'active'` (it's the
   * public directory), which would make a `hidden` listing impossible to
   * ever find again to `restore()` it. No forced status here; an optional
   * one narrows the view instead. `guildId` optional too — the landing
   * point for a guild hit from admin search (`GET /admin/search`).
   */
  async listForModeration(tx, { status, guildId } = {}, { limit = DEFAULT_PAGE_SIZE, cursor } = {}) {
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
      selectSql: `SELECT * FROM listings WHERE ${whereSql}`,
      countSql: `SELECT count(*)::int AS total FROM listings WHERE ${whereSql}`,
      baseParams,
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

  /**
   * Free-text search across tag, guild name, and owner username (`GET
   * /annonces?search=` and `GET /admin/search`) — see `buildSearchSql`
   * below for why this is a `UNION` of independently-indexed branches
   * rather than one `OR`ed `WHERE`. `status: null` (admin) searches every
   * status; `status: 'active'` (public) matches `listPublic`'s visibility.
   * No keyset pagination — a flat top-N, like any search box, not a browse.
   */
  async search(tx, term, { status = null, limit = 20 } = {}) {
    const { sql, params } = buildSearchSql({ term, status, limit });
    const { rows } = await tx.query(sql, params);
    return rows.map(mapRow);
  },
};

/**
 * Four independently-indexed branches, `UNION`ed (not `OR`ed in one WHERE —
 * an `OR` across a GIN array-contains, two GIN trigram `ILIKE`s on other
 * tables, and a GIN full-text match would push Postgres toward a sequential
 * scan for at least one of them; a `UNION` lets the planner pick the best
 * index for each branch independently, verified by
 * `search.explain.dbtest.js`). `UNION` (not `UNION ALL`) also dedupes a
 * listing that happens to match on more than one branch for free.
 */
export function buildSearchSql({ term, status, limit }) {
  const statusClause = 'AND ($1::text IS NULL OR status = $1::text::listing_status)';
  const branches = [
    // `@>` (array-contains), not `= ANY(tags)` — the only array comparison the GIN `array_ops`
    // index on `tags` actually accelerates; `= ANY` degenerates into a Seq Scan.
    `SELECT * FROM listings WHERE tags @> ARRAY[lower($2)]::text[] ${statusClause}`,
    // Driven from `guilds` (small match set via its trigram index), joined back to `listings`
    // by `guild_id` (`idx_listings_guild_id`, migration 006) — the other way around (a Seq Scan
    // of every listing, EXISTS-checking each one's guild) was the actual failure caught by
    // `search.explain.dbtest.js`: `status` alone isn't selective enough to avoid it.
    `SELECT l.* FROM listings l WHERE l.guild_id IN (SELECT g.id FROM guilds g WHERE g.name ILIKE '%' || $2 || '%') ${statusClause.replace('status', 'l.status')}`,
    `SELECT l.* FROM listings l WHERE l.user_id IN (SELECT u.id FROM users u WHERE u.username ILIKE '%' || $2 || '%') ${statusClause.replace('status', 'l.status')}`,
    `SELECT * FROM listings WHERE search_tsv @@ plainto_tsquery('french', $2) ${statusClause}`,
  ];
  return {
    sql: `${branches.join(' UNION ')} ORDER BY created_at DESC, id DESC LIMIT $3`,
    params: [status, term, limit],
  };
}

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
