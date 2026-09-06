import { rbacRepo } from '../db/repositories/rbacRepo.js';
import * as audit from './audit.js';

export class RbacError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RbacError';
    this.code = code;
  }
}

const CACHE_TTL_MS = 60_000;
/** userId -> { caps: Set<string>, expiresAt: number } — invalidated on every RBAC write. */
const cache = new Map();

export function invalidateCache(userId) {
  cache.delete(userId);
}

/** Full cache flush — wired to `event.moderation.action` by whichever process resolves RBAC. */
export function invalidateAllCaches() {
  cache.clear();
}

/**
 * Resolves the full, frozen permission set for a user: role permissions,
 * union direct grants, minus explicit revocations. Cached 60s per user.
 */
export async function resolve(tx, userId) {
  const cached = cache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.caps;
  }

  const roleKeys = await rbacRepo.getRoleKeysForUser(tx, userId);
  const rolePerms = await rbacRepo.getPermissionKeysForRoles(tx, roleKeys);
  const directGrants = await rbacRepo.getDirectGrants(tx, userId);
  const revocations = await rbacRepo.getDirectRevocations(tx, userId);

  const caps = new Set([...rolePerms, ...directGrants]);
  for (const revoked of revocations) {
    caps.delete(revoked);
  }
  const frozen = Object.freeze(caps);
  cache.set(userId, { caps: frozen, expiresAt: Date.now() + CACHE_TTL_MS });
  return frozen;
}

/**
 * Pure capability check. Never compares a role name — every gate in the
 * codebase goes through `can`, so RBAC stays granular by function. When the
 * caller knows both ids, pass `{ actorId, targetUserId }`: acting on oneself
 * is never permitted through this gate, regardless of capability.
 */
export function can(caps, permission, ctx) {
  if (ctx?.actorId && ctx?.targetUserId && ctx.actorId === ctx.targetUserId) {
    return false;
  }
  return caps.has(permission);
}

function forbidden(message = 'Missing capability') {
  return new RbacError('ERR_FORBIDDEN', message);
}

/**
 * Grants `roleKey` to `userId`. An actor can only grant a role whose
 * permissions are already a subset of their own — never an escalation.
 */
export async function assignRole(tx, actorId, userId, roleKey) {
  const actorCaps = await resolve(tx, actorId);
  if (!can(actorCaps, 'rbac.grant')) throw forbidden();

  const rolePerms = await rbacRepo.getPermissionKeysForRoles(tx, [roleKey]);
  const missing = rolePerms.filter((p) => !actorCaps.has(p));
  if (missing.length > 0) {
    await audit.record(tx, {
      actorId,
      action: 'rbac.escalation_attempt',
      targetType: 'user',
      targetId: userId,
      after: { roleKey, missing },
    });
    throw new RbacError('ERR_ESCALATION', `Actor lacks permissions required by role ${roleKey}`);
  }

  await rbacRepo.assignRole(tx, userId, roleKey, actorId);
  invalidateCache(userId);
  await audit.record(tx, {
    actorId,
    action: 'rbac.role_assigned',
    targetType: 'user',
    targetId: userId,
    after: { roleKey },
  });
}

/** Revokes `roleKey` from `userId`. Refuses to remove the last `proprietaire`. */
export async function revokeRole(tx, actorId, userId, roleKey) {
  const actorCaps = await resolve(tx, actorId);
  if (!can(actorCaps, 'rbac.grant')) throw forbidden();

  if (roleKey === 'proprietaire') {
    const count = await rbacRepo.countUsersWithRole(tx, 'proprietaire');
    if (count <= 1) {
      throw new RbacError('ERR_LAST_OWNER', 'Cannot revoke the last proprietaire');
    }
  }

  await rbacRepo.revokeRole(tx, userId, roleKey);
  invalidateCache(userId);
  await audit.record(tx, {
    actorId,
    action: 'rbac.role_revoked',
    targetType: 'user',
    targetId: userId,
    before: { roleKey },
  });
}

/** Grants a single permission directly to `userId`, bypassing roles. Same escalation guard as `assignRole`. */
export async function grantPermission(tx, actorId, userId, permissionKey) {
  const actorCaps = await resolve(tx, actorId);
  if (!can(actorCaps, 'rbac.grant') || !actorCaps.has(permissionKey)) {
    await audit.record(tx, {
      actorId,
      action: 'rbac.escalation_attempt',
      targetType: 'user',
      targetId: userId,
      after: { permissionKey },
    });
    throw new RbacError('ERR_ESCALATION', `Actor lacks permission ${permissionKey}`);
  }

  await rbacRepo.grantPermissionDirectly(tx, userId, permissionKey, actorId);
  invalidateCache(userId);
  await audit.record(tx, {
    actorId,
    action: 'rbac.permission_granted',
    targetType: 'user',
    targetId: userId,
    after: { permissionKey },
  });
}

export async function revokePermission(tx, actorId, userId, permissionKey) {
  const actorCaps = await resolve(tx, actorId);
  if (!can(actorCaps, 'rbac.grant')) throw forbidden();

  await rbacRepo.revokePermissionDirectly(tx, userId, permissionKey, actorId);
  invalidateCache(userId);
  await audit.record(tx, {
    actorId,
    action: 'rbac.permission_revoked',
    targetType: 'user',
    targetId: userId,
    before: { permissionKey },
  });
}
