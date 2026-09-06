import { randomUUID, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { Config } from '../../config/env.js';
import { withTransaction } from '../../db/pool.js';
import { sessionsRepo } from '../../db/repositories/sessionsRepo.js';
import { usersRepo } from '../../db/repositories/usersRepo.js';
import { sanctionsRepo } from '../../db/repositories/sanctionsRepo.js';
import * as rbac from '../../domain/rbac.js';

export const SESSION_COOKIE = 'xm_sid';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const BLOCKING_SANCTION_KINDS = new Set(['ban_temp', 'ban_perm', 'suspend']);

/** Creates a session row after a successful OAuth callback. Cookie itself is set by the route (signed, HttpOnly, Secure, SameSite=Lax). */
export async function createSession(pool, userId) {
  const id = randomUUID();
  const csrfSecret = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await withTransaction(pool, (tx) => sessionsRepo.insert(tx, { id, userId, csrfSecret, expiresAt }));
  return { id, csrfSecret, expiresAt };
}

/** A per-session CSRF token derived from the session's own secret — never the secret itself. */
export function issueCsrfToken(csrfSecret) {
  return createHmac('sha256', Config.sessionSecret).update(csrfSecret).digest('base64url');
}

export function verifyCsrfToken(csrfSecret, token) {
  if (!csrfSecret || !token) return false;
  const expected = Buffer.from(issueCsrfToken(csrfSecret));
  const actual = Buffer.from(String(token));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function respondUnauthenticated(req, reply) {
  if (req.headers.accept?.includes('application/json')) {
    return reply.code(401).send({ error: 'ERR_UNAUTHENTICATED' });
  }
  return reply.redirect('/auth/discord');
}

/**
 * Fastify preHandler: verifies the signed `xm_sid` cookie, loads the
 * session (server-revocable — a ban takes effect on the very next request,
 * not at cookie expiry), the user, active sanctions and RBAC capabilities.
 * Renews the sliding 30-day TTL on every valid request.
 */
export function requireAuth(pool) {
  return async function requireAuthHandler(req, reply) {
    const raw = req.cookies?.[SESSION_COOKIE];
    const unsigned = raw ? req.unsignCookie(raw) : null;
    if (!unsigned?.valid) {
      return respondUnauthenticated(req, reply);
    }

    const result = await withTransaction(pool, async (tx) => {
      const session = await sessionsRepo.findValid(tx, unsigned.value);
      if (!session) return null;
      const user = await usersRepo.findById(tx, session.userId);
      if (!user || user.deletedAt) return null;

      const activeSanctions = await sanctionsRepo.findActiveByUser(tx, user.id);
      const blocking = activeSanctions.find((s) => BLOCKING_SANCTION_KINDS.has(s.kind));
      const caps = await rbac.resolve(tx, user.id);
      await sessionsRepo.renew(tx, session.id, new Date(Date.now() + SESSION_TTL_MS));
      return { session, user, activeSanctions, blocking, caps };
    });

    if (!result) {
      reply.clearCookie(SESSION_COOKIE);
      return respondUnauthenticated(req, reply); // ERR_SESSION_REVOKED
    }
    if (result.blocking) {
      return reply
        .code(403)
        .send({ error: 'ERR_SANCTIONED', reason: result.blocking.reason, endsAt: result.blocking.endsAt });
    }

    req.user = {
      id: result.user.id,
      discordId: result.user.discordId,
      username: result.user.username,
      isVerified: result.user.isVerified,
      sanctions: result.activeSanctions,
    };
    req.caps = result.caps;
    req.csrfSecret = result.session.csrfSecret;
  };
}

/**
 * Best-effort session read for public pages that adapt their content to
 * login state (e.g. the homepage showing "Se connecter" vs "Se déconnecter")
 * without forcing a redirect the way `requireAuth` does. Sets `req.user` if
 * a valid session exists, otherwise leaves it `undefined` — never blocks.
 */
export function tryAuth(pool) {
  return async function tryAuthHandler(req) {
    const raw = req.cookies?.[SESSION_COOKIE];
    const unsigned = raw ? req.unsignCookie(raw) : null;
    if (!unsigned?.valid) return;

    const result = await withTransaction(pool, async (tx) => {
      const session = await sessionsRepo.findValid(tx, unsigned.value);
      if (!session) return null;
      const user = await usersRepo.findById(tx, session.userId);
      if (!user || user.deletedAt) return null;
      return { user };
    });

    if (result) {
      req.user = {
        id: result.user.id,
        discordId: result.user.discordId,
        username: result.user.username,
        isVerified: result.user.isVerified,
      };
    }
  };
}

/** Composes `requireAuth` with an RBAC gate. Never compares a role name — always `rbac.can`. */
export function requirePermission(pool, permission) {
  const authHandler = requireAuth(pool);
  return async function requirePermissionHandler(req, reply) {
    await authHandler(req, reply);
    if (reply.sent) return;
    if (!rbac.can(req.caps, permission)) {
      reply.code(403).send({ error: 'ERR_FORBIDDEN' });
    }
  };
}

/** Fastify preHandler for every mutating route: compares in constant time, never writes on mismatch. */
export function requireCsrf() {
  return async function requireCsrfHandler(req, reply) {
    const token = req.headers['x-csrf-token'] ?? req.body?._csrf;
    if (!verifyCsrfToken(req.csrfSecret, token)) {
      reply.code(403).send({ error: 'ERR_CSRF' });
    }
  };
}

export async function destroySession(pool, sessionId) {
  await withTransaction(pool, (tx) => sessionsRepo.revoke(tx, sessionId));
}
