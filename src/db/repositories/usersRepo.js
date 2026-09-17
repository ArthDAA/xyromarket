import { randomUUID } from 'node:crypto';
import { mapPgError, mapRow } from './shared.js';

/** Data access for the `users` aggregate. No business rule lives here. */
export const usersRepo = {
  async findById(tx, id) {
    const { rows } = await tx.query('SELECT * FROM users WHERE id = $1', [id]);
    return mapRow(rows[0]) ?? null;
  },

  async findByDiscordId(tx, discordId) {
    const { rows } = await tx.query('SELECT * FROM users WHERE discord_id = $1', [discordId]);
    return mapRow(rows[0]) ?? null;
  },

  /** Batch lookup for rendering a page of listings without an N+1 (public search/listing rows now show the owner's alias, A28). */
  async findByIds(tx, ids) {
    if (ids.length === 0) return [];
    const { rows } = await tx.query('SELECT * FROM users WHERE id = ANY($1::uuid[])', [ids]);
    return rows.map(mapRow);
  },

  /** Substring match on `username` — GIN trigram index (migration 006), used by admin search. */
  async searchByUsername(tx, term, { limit = 20 } = {}) {
    const { rows } = await tx.query(
      "SELECT * FROM users WHERE deleted_at IS NULL AND username ILIKE '%' || $1 || '%' ORDER BY username LIMIT $2",
      [term, limit],
    );
    return rows.map(mapRow);
  },

  /** Upserts the user seen at OAuth login, keyed by their stable Discord id. */
  async upsertFromOAuth(tx, { discordId, username, avatarHash }) {
    try {
      const { rows } = await tx.query(
        `INSERT INTO users (discord_id, username, avatar_hash)
         VALUES ($1, $2, $3)
         ON CONFLICT (discord_id)
         DO UPDATE SET username = EXCLUDED.username, avatar_hash = EXCLUDED.avatar_hash
         RETURNING *`,
        [discordId, username, avatarHash],
      );
      return mapRow(rows[0]);
    } catch (err) {
      throw mapPgError(err);
    }
  },

  async setVerified(tx, id, isVerified) {
    const { rows } = await tx.query(
      'UPDATE users SET is_verified = $2 WHERE id = $1 RETURNING *',
      [id, isVerified],
    );
    return mapRow(rows[0]) ?? null;
  },

  /** Denormalized ban state for fast session-gate reads; source of truth remains `sanctions`. */
  async setBanState(tx, id, { bannedUntil = null, bannedPermanently = false } = {}) {
    const { rows } = await tx.query(
      'UPDATE users SET banned_until = $2, banned_permanently = $3 WHERE id = $1 RETURNING *',
      [id, bannedUntil, bannedPermanently],
    );
    return mapRow(rows[0]) ?? null;
  },

  async requestDeletion(tx, id) {
    const { rows } = await tx.query(
      'UPDATE users SET deletion_requested_at = now() WHERE id = $1 AND deletion_requested_at IS NULL RETURNING *',
      [id],
    );
    return mapRow(rows[0]) ?? null;
  },

  /** Accounts whose 7-day retraction window has elapsed and are not yet pseudonymized. */
  async findDueForDeletion(tx, retractionWindowMs) {
    const { rows } = await tx.query(
      `SELECT * FROM users
       WHERE deletion_requested_at IS NOT NULL
         AND deletion_requested_at < $1
         AND deleted_at IS NULL`,
      [new Date(Date.now() - retractionWindowMs)],
    );
    return rows.map(mapRow);
  },

  /**
   * GDPR pseudonymization: replaces the Discord identity with a
   * non-reversible opaque token, clears display data, marks `deleted_at`.
   * Never a physical DELETE — FKs from transactions/reviews/audit_log stay valid.
   */
  async pseudonymize(tx, id) {
    const opaqueId = `deleted:${randomUUID()}`;
    const { rows } = await tx.query(
      `UPDATE users
       SET discord_id = $2, username = 'Compte supprimé', avatar_hash = NULL, deleted_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, opaqueId],
    );
    return mapRow(rows[0]) ?? null;
  },
};
