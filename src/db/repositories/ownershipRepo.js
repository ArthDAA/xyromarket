import { mapRow } from './shared.js';

/**
 * Owns the single writable path to `guilds.owner_discord_id` and the
 * `ownership_events` history. `domain/ownership.js` is the only caller.
 */
export const ownershipRepo = {
  /** Locks the guild row (`FOR UPDATE`) so a concurrent observation can't race the comparison. */
  async lockGuild(tx, guildId) {
    const { rows } = await tx.query('SELECT * FROM guilds WHERE id = $1 FOR UPDATE', [guildId]);
    return mapRow(rows[0]) ?? null;
  },

  async insertGuildUnlocked(tx, { guildId, ownerDiscordId }) {
    const { rows } = await tx.query(
      `INSERT INTO guilds (id, name, owner_discord_id, bot_present)
       VALUES ($1, '', $2, false)
       ON CONFLICT (id) DO NOTHING
       RETURNING *`,
      [guildId, ownerDiscordId],
    );
    if (rows[0]) return mapRow(rows[0]);
    return ownershipRepo.lockGuild(tx, guildId);
  },

  async setOwner(tx, guildId, ownerDiscordId, observedAt) {
    const { rows } = await tx.query(
      'UPDATE guilds SET owner_discord_id = $2, last_seen_at = $3 WHERE id = $1 RETURNING *',
      [guildId, ownerDiscordId, observedAt],
    );
    return mapRow(rows[0]) ?? null;
  },

  async touchLastSeen(tx, guildId, observedAt) {
    await tx.query('UPDATE guilds SET last_seen_at = $2 WHERE id = $1', [guildId, observedAt]);
  },

  async insertEvent(tx, { guildId, previousOwnerId, newOwnerId, observedAt, source }) {
    const { rows } = await tx.query(
      `INSERT INTO ownership_events (guild_id, previous_owner_id, new_owner_id, observed_at, source)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [guildId, previousOwnerId, newOwnerId, observedAt, source],
    );
    return mapRow(rows[0]);
  },
};
