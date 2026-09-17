import { mapRow } from './shared.js';

/**
 * Data access for the `guilds` aggregate: presence, metadata, bot role
 * position. The reference `owner_discord_id` value itself is written only
 * through `ownershipRepo` — this module reads it but never decides it.
 */
export const guildsRepo = {
  async findById(tx, id) {
    const { rows } = await tx.query('SELECT * FROM guilds WHERE id = $1', [id]);
    return mapRow(rows[0]) ?? null;
  },

  /** Inserts a guild the first time it's observed, without touching ownership if it already exists. */
  async ensureExists(tx, { id, name, ownerDiscordId, botPresent = false }) {
    const { rows } = await tx.query(
      `INSERT INTO guilds (id, name, owner_discord_id, bot_present)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING
       RETURNING *`,
      [id, name, ownerDiscordId, botPresent],
    );
    if (rows[0]) return mapRow(rows[0]);
    return guildsRepo.findById(tx, id);
  },

  async updatePresence(
    tx,
    id,
    { name, iconHash, memberCountCached, botPresent, botRolePosition, auditBlind, roleHierarchyOk },
  ) {
    const { rows } = await tx.query(
      `UPDATE guilds SET
         name = COALESCE($2, name),
         icon_hash = COALESCE($3, icon_hash),
         member_count_cached = COALESCE($4, member_count_cached),
         bot_present = COALESCE($5, bot_present),
         bot_role_position = COALESCE($6, bot_role_position),
         audit_blind = COALESCE($7, audit_blind),
         role_hierarchy_ok = COALESCE($8, role_hierarchy_ok)
       WHERE id = $1
       RETURNING *`,
      [id, name, iconHash, memberCountCached, botPresent, botRolePosition, auditBlind, roleHierarchyOk],
    );
    return mapRow(rows[0]) ?? null;
  },

  /** Guilds this Discord user currently owns, per the stored reference value — used by `GET /me/serveurs`. */
  async listOwnedByDiscordId(tx, ownerDiscordId) {
    const { rows } = await tx.query('SELECT * FROM guilds WHERE owner_discord_id = $1', [ownerDiscordId]);
    return rows.map(mapRow);
  },

  /** Batch lookup for rendering a page of listings without an N+1 (public search/listing rows now show the guild name, A28). */
  async findByIds(tx, ids) {
    if (ids.length === 0) return [];
    const { rows } = await tx.query('SELECT * FROM guilds WHERE id = ANY($1::text[])', [ids]);
    return rows.map(mapRow);
  },

  /** Substring match on `name` — GIN trigram index (migration 006), used by admin search. */
  async searchByName(tx, term, { limit = 20 } = {}) {
    const { rows } = await tx.query(
      "SELECT * FROM guilds WHERE name ILIKE '%' || $1 || '%' ORDER BY name LIMIT $2",
      [term, limit],
    );
    return rows.map(mapRow);
  },

  async listWithActiveListing(tx) {
    const { rows } = await tx.query(
      `SELECT DISTINCT g.* FROM guilds g
       INNER JOIN listings l ON l.guild_id = g.id AND l.status = 'active'`,
    );
    return rows.map(mapRow);
  },
};
