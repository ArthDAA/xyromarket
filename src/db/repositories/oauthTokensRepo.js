import { mapRow } from './shared.js';

/** Data access for `oauth_tokens`. Values are already encrypted ciphertext by the time they arrive here. */
export const oauthTokensRepo = {
  async upsert(tx, { userId, accessTokenEnc, refreshTokenEnc, expiresAt, scopes }) {
    const { rows } = await tx.query(
      `INSERT INTO oauth_tokens (user_id, access_token_enc, refresh_token_enc, expires_at, scopes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE SET
         access_token_enc = EXCLUDED.access_token_enc,
         refresh_token_enc = EXCLUDED.refresh_token_enc,
         expires_at = EXCLUDED.expires_at,
         scopes = EXCLUDED.scopes,
         updated_at = now()
       RETURNING *`,
      [userId, accessTokenEnc, refreshTokenEnc, expiresAt, scopes],
    );
    return mapRow(rows[0]);
  },

  async findByUserId(tx, userId) {
    const { rows } = await tx.query('SELECT * FROM oauth_tokens WHERE user_id = $1', [userId]);
    return mapRow(rows[0]) ?? null;
  },

  async deleteByUserId(tx, userId) {
    await tx.query('DELETE FROM oauth_tokens WHERE user_id = $1', [userId]);
  },
};
