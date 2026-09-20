/**
 * One-off bootstrap: grants the `proprietaire` role to the account whose
 * Discord ID is `BOOTSTRAP_ADMIN_DISCORD_ID`. No self-service admin
 * mechanism exists (cf. `docs/devnotes/1-CheckList.md`, gap noted under
 * A27/A32/E10) — this is the manual bootstrap, made runnable as a deploy
 * step rather than requiring direct DB access, which the target platform
 * doesn't expose outside its own apps (blitz.cloud, A41).
 *
 * Idempotent (`ON CONFLICT DO NOTHING`) — safe to leave wired into a start
 * command permanently, or run by hand once and remove.
 *
 * Usage (as an app's start command, or a one-off):
 *   BOOTSTRAP_ADMIN_DISCORD_ID=<snowflake> node scripts/grant-admin.mjs
 */
import { createPool, closePool, withTransaction } from '../src/db/pool.js';

const discordId = process.env.BOOTSTRAP_ADMIN_DISCORD_ID;
if (!discordId) {
  console.error('[grant-admin] BOOTSTRAP_ADMIN_DISCORD_ID is not set — nothing to do.');
  process.exit(1);
}

const pool = await createPool('migrate');
try {
  const granted = await withTransaction(pool, async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO user_roles (user_id, role_key, granted_by)
       SELECT id, 'proprietaire', NULL
       FROM users
       WHERE discord_id = $1
       ON CONFLICT (user_id, role_key) DO NOTHING
       RETURNING user_id`,
      [discordId],
    );
    return rows[0]?.user_id ?? null;
  });

  if (granted) {
    console.log(`[grant-admin] granted proprietaire to user ${granted} (discord_id ${discordId})`);
  } else {
    console.log(
      `[grant-admin] no-op — either discord_id ${discordId} has no user row yet (they must log in at least once first), or it already has proprietaire`,
    );
  }
} finally {
  await closePool(pool);
}
