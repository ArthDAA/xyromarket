import pino from 'pino';
import { Config } from '../config/env.js';
import { withTransaction } from '../db/pool.js';

/** Fixed set of inter-process channels. Never publish/subscribe a string outside this list. */
export const CHANNELS = Object.freeze({
  INTENT_TRIAL_ASSIGN: 'intent.trial.assign',
  INTENT_TRIAL_REVOKE: 'intent.trial.revoke',
  INTENT_HUB_THREAD_CREATE: 'intent.hub.thread_create',
  INTENT_HUB_THREAD_ARCHIVE: 'intent.hub.thread_archive',
  INTENT_ANNOUNCE_HANDOVER: 'intent.announce.handover',
  INTENT_GUILD_LEAVE: 'intent.guild.leave',
  EVENT_LISTING_CHANGED: 'event.listing.changed',
  EVENT_OWNERSHIP_CHANGED: 'event.ownership.changed',
  EVENT_MATCH_PROPOSED: 'event.match.proposed',
  EVENT_TRANSACTION_UPDATED: 'event.transaction.updated',
  EVENT_MODERATION_ACTION: 'event.moderation.action',
});

const MAX_ATTEMPTS = 5;
const BACKOFF_SCHEDULE_MS = [1_000, 5_000, 30_000, 300_000];

/**
 * Publishes `payload` on `channel`, inside the caller's transaction. The row
 * only becomes visible to consumers if `tx` commits — `outbox` is
 * transactional by construction, an event is never observed for work that
 * got rolled back.
 */
export async function publish(tx, channel, payload) {
  const { rows } = await tx.query('INSERT INTO outbox (channel, payload) VALUES ($1, $2) RETURNING id', [
    channel,
    JSON.stringify(payload),
  ]);
  return rows[0].id;
}

/**
 * Re-emits `pg_notify` for outbox rows still unconsumed after `olderThanMs`
 * — the catch-up path for a `NOTIFY` that never reached a listener (dropped
 * connection, restart). Does not run handlers itself; it only nudges
 * whichever process is currently subscribed to try again.
 */
export async function sweepOutbox(pool, { olderThanMs = 60_000, limit = 500 } = {}) {
  const cutoff = new Date(Date.now() - olderThanMs);
  const { rows } = await pool.query(
    `SELECT id, channel, pg_notify(channel, id::text) FROM outbox
     WHERE consumed_at IS NULL AND attempts < $1 AND published_at < $2
     ORDER BY published_at
     LIMIT $3`,
    [MAX_ATTEMPTS, cutoff, limit],
  );
  return rows.length;
}

/**
 * Creates a bus consumer bound to `pool`. Register handlers with
 * `subscribe(channel, handler)` before calling `start()`. Handlers must be
 * idempotent — delivery is at-least-once by contract.
 */
export function createBusListener(pool, { logger = pino({ level: Config.logLevel }) } = {}) {
  const handlers = new Map();
  let listenClient = null;
  let stopped = false;

  function subscribe(channel, handler) {
    handlers.set(channel, handler);
  }

  async function processRow(id) {
    if (stopped) return;
    await withTransaction(pool, async (tx) => {
      const { rows } = await tx.query(
        'SELECT * FROM outbox WHERE id = $1 AND consumed_at IS NULL FOR UPDATE SKIP LOCKED',
        [id],
      );
      const row = rows[0];
      if (!row) return; // already consumed, or another instance holds the lock
      const handler = handlers.get(row.channel);
      if (!handler) return;

      try {
        await handler(row.payload);
        await tx.query('UPDATE outbox SET consumed_at = now() WHERE id = $1', [id]);
      } catch (err) {
        const attempts = row.attempts + 1;
        await tx.query('UPDATE outbox SET attempts = $2, last_error = $3 WHERE id = $1', [
          id,
          attempts,
          String(err?.message ?? err),
        ]);
        const dead = attempts >= MAX_ATTEMPTS;
        logger.error({ channel: row.channel, id, attempts, dead, err: err.message }, 'HANDLER_FAILED');
        if (dead) {
          logger.fatal({ channel: row.channel, id }, 'outbox event dead, no further automatic retry');
        } else {
          const delay = BACKOFF_SCHEDULE_MS[Math.min(attempts - 1, BACKOFF_SCHEDULE_MS.length - 1)];
          setTimeout(() => {
            processRow(id).catch((e) => logger.error({ err: e.message }, 'scheduled retry failed'));
          }, delay).unref?.();
        }
      }
    });
  }

  async function reconcileBacklog() {
    const { rows } = await pool.query(
      'SELECT id FROM outbox WHERE consumed_at IS NULL AND attempts < $1 AND channel = ANY($2::text[]) ORDER BY published_at',
      [MAX_ATTEMPTS, [...handlers.keys()]],
    );
    for (const row of rows) {
      await processRow(row.id);
    }
  }

  async function attachListenClient() {
    const client = await pool.connect();
    client.on('notification', (msg) => {
      if (handlers.has(msg.channel)) {
        processRow(msg.payload).catch((err) => logger.error({ err: err.message }, 'processRow failed'));
      }
    });
    client.on('error', (err) => {
      logger.error({ err: err.message }, 'LISTEN_DROPPED, reconnecting');
      client.release(err);
      if (!stopped) attachListenClient().then(reconcileBacklog).catch((e) => logger.fatal({ err: e.message }, 'bus reconnect failed'));
    });
    for (const channel of handlers.keys()) {
      await client.query(`LISTEN "${channel}"`);
    }
    listenClient = client;
  }

  async function start() {
    await attachListenClient();
    await reconcileBacklog();
  }

  async function stop() {
    stopped = true;
    if (listenClient) {
      for (const channel of handlers.keys()) {
        await listenClient.query(`UNLISTEN "${channel}"`).catch(() => {});
      }
      listenClient.release();
      listenClient = null;
    }
  }

  return { subscribe, start, stop };
}
