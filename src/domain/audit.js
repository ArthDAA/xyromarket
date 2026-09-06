import { createHmac } from 'node:crypto';
import { Config } from '../config/env.js';
import { auditRepo } from '../db/repositories/auditRepo.js';

const SENSITIVE_KEY_RE = /token|secret|password|email|_enc$/i;

function redact(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj ?? {})) {
    out[key] = SENSITIVE_KEY_RE.test(key) ? '[REDACTED]' : value;
  }
  return out;
}

/** Keeps only the fields that actually changed between `before` and `after`. */
function diffOnlyChanged(before, after) {
  const beforeOut = {};
  const afterOut = {};
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const key of keys) {
    const b = before?.[key];
    const a = after?.[key];
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      beforeOut[key] = b ?? null;
      afterOut[key] = a ?? null;
    }
  }
  return { before: beforeOut, after: afterOut };
}

/**
 * SHA-256(HMAC) of a raw IP under a server-side salt derived from
 * `SESSION_SECRET`. Callers (e.g. the web request pipeline) hash the IP
 * with this before it ever reaches `record` — the audit log only ever
 * stores the hash, never the raw address.
 */
export function hashIp(ip) {
  return createHmac('sha256', Config.sessionSecret).update(ip).digest('hex');
}

/**
 * Appends one entry to the audit log, in the same transaction as the action
 * it describes. If the insert fails, the error propagates and the caller's
 * `withTransaction` rolls back the whole business transaction — an
 * unauditable action does not happen, by construction.
 */
export async function record(tx, { actorId, action, targetType, targetId, before, after, ipHash }) {
  const { before: changedBefore, after: changedAfter } = diffOnlyChanged(before, after);
  return auditRepo.record(tx, {
    actorId,
    action,
    targetType,
    targetId,
    before: redact(changedBefore),
    after: redact(changedAfter),
    ipHash: ipHash ?? null,
  });
}

export async function query(tx, filters, page) {
  return auditRepo.query(tx, filters, page);
}
