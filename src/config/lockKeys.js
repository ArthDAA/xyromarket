/**
 * Postgres advisory locks take a single bigint key. This module is the one
 * place that turns a human-readable lock name into a deterministic bigint,
 * so every advisory lock used across `web`/`bot`/`jobs` is guaranteed
 * collision-free by construction instead of by convention.
 */

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

/** Deterministic 64-bit FNV-1a hash of `input`, reinterpreted as signed (Postgres `bigint`). */
export function hashToLockKey(input) {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of Buffer.from(input, 'utf8')) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & UINT64_MASK;
  }
  return BigInt.asIntN(64, hash);
}

/** Fixed, well-known advisory locks — one per singleton resource. */
export const LOCK_KEYS = {
  MIGRATION: hashToLockKey('xyro:migration'),
  MATCH_ROUND: hashToLockKey('xyro:match-round'),
  BOT_SINGLETON: hashToLockKey('xyro:bot-singleton'),
  JOBS_SINGLETON: hashToLockKey('xyro:jobs-singleton'),
};

/** Per-listing queue lock (`domain/matching/queue.js`). */
export function listingLockKey(listingId) {
  return hashToLockKey(`xyro:listing:${listingId}`);
}

/** Per-job lock, so one slow tick never overlaps the next (`jobs/main.js`). */
export function jobLockKey(jobName) {
  return hashToLockKey(`xyro:job:${jobName}`);
}
