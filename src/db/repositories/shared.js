/**
 * Cross-cutting helpers for the repository layer: error mapping, row
 * mapping (snake_case -> camelCase, frozen), and opaque cursor pagination.
 * No module in `repositories/` concatenates a value into SQL text — every
 * query here goes through parameterized placeholders.
 */

export class RepoError extends Error {
  constructor(code, message, { constraint, cause } = {}) {
    super(message);
    this.name = 'RepoError';
    this.code = code;
    this.constraint = constraint;
    this.cause = cause;
  }
}

const PG_UNIQUE_VIOLATION = '23505';
const PG_CHECK_VIOLATION = '23514';

/**
 * Maps a raw pg error to a typed RepoError for the domain to interpret, or
 * returns it unchanged if it isn't one of the two mapped classes.
 */
export function mapPgError(err, logger) {
  if (err?.code === PG_UNIQUE_VIOLATION) {
    return new RepoError('ERR_CONFLICT', `Unique constraint violated: ${err.constraint}`, {
      constraint: err.constraint,
      cause: err,
    });
  }
  if (err?.code === PG_CHECK_VIOLATION) {
    logger?.error({ constraint: err.constraint }, 'CHECK_VIOLATION reached the database');
    return new RepoError('ERR_INVARIANT', `Check constraint violated: ${err.constraint}`, {
      constraint: err.constraint,
      cause: err,
    });
  }
  return err;
}

function toCamel(key) {
  return key.replace(/_([a-z0-9])/g, (_match, c) => c.toUpperCase());
}

/** Maps a raw pg row to a frozen, camelCase domain object. `null` stays `null`. */
export function mapRow(row) {
  if (row == null) return null;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[toCamel(key)] = value;
  }
  return Object.freeze(out);
}

export function mapRows(rows) {
  return rows.map(mapRow);
}

/** Encodes a cursor payload (plain object) as an opaque, URL-safe string. */
export function encodeCursor(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** Decodes a cursor produced by `encodeCursor`. Returns `null` on any malformed input. */
export function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** Builds the `{ items, total, cursor }` shape mandated for every paginated list read. */
export function buildPage(items, total, nextCursor) {
  return Object.freeze({ items, total, cursor: nextCursor });
}

/**
 * Shared keyset pagination on `(created_at DESC, id DESC)` — the pattern
 * behind every list read in the repository layer. Never `OFFSET`: the
 * cursor carries the last row's `(created_at, id)` and the next page asks
 * for strictly-less rows.
 *
 * @param {string} selectSql - `SELECT * FROM t WHERE ...` (no ORDER BY/LIMIT), using `baseParams`.
 * @param {string} countSql - `SELECT count(*)::int AS total FROM t WHERE ...`, using only `baseParams`.
 */
export async function paginateKeyset(
  tx,
  { selectSql, countSql, baseParams = [], limit = 20, cursor, orderColumn = 'created_at' },
) {
  const decoded = decodeCursor(cursor);
  const params = [...baseParams];
  let cursorClause = '';
  if (decoded) {
    params.push(decoded.order, decoded.id);
    cursorClause = `AND (${orderColumn}, id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(limit + 1);

  const { rows } = await tx.query(
    `${selectSql} ${cursorClause} ORDER BY ${orderColumn} DESC, id DESC LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore
    ? encodeCursor({ order: page[page.length - 1][orderColumn], id: page[page.length - 1].id })
    : null;

  const { rows: countRows } = await tx.query(countSql, baseParams);
  return buildPage(mapRows(page), countRows[0].total, nextCursor);
}
