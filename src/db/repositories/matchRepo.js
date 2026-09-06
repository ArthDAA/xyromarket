import { mapRow } from './shared.js';

/** Data access for `match_proposals`, `match_participants` and cooldowns. */
export const matchRepo = {
  async createProposal(tx, { kind, expiresAt, participants }) {
    const { rows: proposalRows } = await tx.query(
      `INSERT INTO match_proposals (kind, expires_at) VALUES ($1, $2) RETURNING *`,
      [kind, expiresAt],
    );
    const proposal = mapRow(proposalRows[0]);

    const participantRows = [];
    for (const p of participants) {
      const { rows } = await tx.query(
        `INSERT INTO match_participants (proposal_id, listing_id, user_id, gives_to_listing_id)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [proposal.id, p.listingId, p.userId, p.givesToListingId ?? null],
      );
      participantRows.push(mapRow(rows[0]));
    }
    return { proposal, participants: participantRows };
  },

  async getProposal(tx, proposalId) {
    const { rows: proposalRows } = await tx.query('SELECT * FROM match_proposals WHERE id = $1', [
      proposalId,
    ]);
    if (!proposalRows[0]) return null;
    const { rows: participantRows } = await tx.query(
      'SELECT * FROM match_participants WHERE proposal_id = $1',
      [proposalId],
    );
    return { proposal: mapRow(proposalRows[0]), participants: participantRows.map(mapRow) };
  },

  async findOpenProposalsForUser(tx, userId) {
    const { rows } = await tx.query(
      `SELECT DISTINCT mp.* FROM match_proposals mp
       INNER JOIN match_participants pt ON pt.proposal_id = mp.id
       WHERE pt.user_id = $1 AND mp.status = 'open'`,
      [userId],
    );
    return rows.map(mapRow);
  },

  async findOpenProposalForListing(tx, listingId) {
    const { rows } = await tx.query(
      `SELECT mp.* FROM match_proposals mp
       INNER JOIN match_participants pt ON pt.proposal_id = mp.id
       WHERE pt.listing_id = $1 AND mp.status = 'open'
       LIMIT 1`,
      [listingId],
    );
    return mapRow(rows[0]) ?? null;
  },

  async recordAcceptance(tx, proposalId, userId) {
    await tx.query(
      `UPDATE match_participants SET accepted_at = now()
       WHERE proposal_id = $1 AND user_id = $2 AND accepted_at IS NULL`,
      [proposalId, userId],
    );
    const { rows } = await tx.query('SELECT * FROM match_participants WHERE proposal_id = $1', [
      proposalId,
    ]);
    return rows.map(mapRow);
  },

  async recordRefusal(tx, proposalId, userId) {
    await tx.query(
      `UPDATE match_participants SET refused_at = now()
       WHERE proposal_id = $1 AND user_id = $2 AND refused_at IS NULL`,
      [proposalId, userId],
    );
  },

  async setProposalStatus(tx, proposalId, status) {
    const { rows } = await tx.query(
      'UPDATE match_proposals SET status = $2 WHERE id = $1 RETURNING *',
      [proposalId, status],
    );
    return mapRow(rows[0]) ?? null;
  },

  async findExpiredOpenProposals(tx, now) {
    const { rows } = await tx.query(
      "SELECT * FROM match_proposals WHERE status = 'open' AND expires_at < $1",
      [now],
    );
    return rows.map(mapRow);
  },

  /** All pairs currently in cooldown, for building an in-memory lookup set before a match round. */
  async listActiveCooldownPairs(tx, now) {
    const { rows } = await tx.query('SELECT user_id_a, user_id_b FROM match_cooldowns WHERE until > $1', [
      now,
    ]);
    return rows.map((r) => [r.user_id_a, r.user_id_b]);
  },

  /** True if the unordered pair (userIdA, userIdB) is currently in cooldown. */
  async isOnCooldown(tx, userIdA, userIdB, now) {
    const [a, b] = [userIdA, userIdB].sort();
    const { rows } = await tx.query(
      'SELECT 1 FROM match_cooldowns WHERE user_id_a = $1 AND user_id_b = $2 AND until > $3',
      [a, b, now],
    );
    return rows.length > 0;
  },

  /** Sets a pairwise cooldown between every pair of the given user ids. */
  async setCooldownForGroup(tx, userIds, until) {
    const uniqueIds = [...new Set(userIds)];
    for (let i = 0; i < uniqueIds.length; i += 1) {
      for (let j = i + 1; j < uniqueIds.length; j += 1) {
        const [a, b] = [uniqueIds[i], uniqueIds[j]].sort();
        await tx.query(
          `INSERT INTO match_cooldowns (user_id_a, user_id_b, until) VALUES ($1, $2, $3)
           ON CONFLICT (user_id_a, user_id_b) DO UPDATE SET until = GREATEST(match_cooldowns.until, EXCLUDED.until)`,
          [a, b, until],
        );
      }
    }
  },
};
