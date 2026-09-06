import { mapRow } from './shared.js';

/** Data access for RBAC: roles, permissions, and per-user direct overrides. */
export const rbacRepo = {
  async listRoles(tx) {
    const { rows } = await tx.query('SELECT * FROM roles ORDER BY key');
    return rows.map(mapRow);
  },

  async listPermissions(tx) {
    const { rows } = await tx.query('SELECT * FROM permissions ORDER BY key');
    return rows.map(mapRow);
  },

  async getRoleKeysForUser(tx, userId) {
    const { rows } = await tx.query('SELECT role_key FROM user_roles WHERE user_id = $1', [userId]);
    return rows.map((r) => r.role_key);
  },

  async getPermissionKeysForRoles(tx, roleKeys) {
    if (roleKeys.length === 0) return [];
    const { rows } = await tx.query(
      'SELECT DISTINCT permission_key FROM role_permissions WHERE role_key = ANY($1::text[])',
      [roleKeys],
    );
    return rows.map((r) => r.permission_key);
  },

  async getDirectGrants(tx, userId) {
    const { rows } = await tx.query(
      'SELECT permission_key FROM user_permission_grants WHERE user_id = $1',
      [userId],
    );
    return rows.map((r) => r.permission_key);
  },

  async getDirectRevocations(tx, userId) {
    const { rows } = await tx.query(
      'SELECT permission_key FROM user_permission_revocations WHERE user_id = $1',
      [userId],
    );
    return rows.map((r) => r.permission_key);
  },

  async assignRole(tx, userId, roleKey, grantedBy) {
    await tx.query(
      `INSERT INTO user_roles (user_id, role_key, granted_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, role_key) DO NOTHING`,
      [userId, roleKey, grantedBy],
    );
  },

  async revokeRole(tx, userId, roleKey) {
    await tx.query('DELETE FROM user_roles WHERE user_id = $1 AND role_key = $2', [userId, roleKey]);
  },

  async grantPermissionDirectly(tx, userId, permissionKey, grantedBy) {
    await tx.query(
      `INSERT INTO user_permission_grants (user_id, permission_key, granted_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, permission_key) DO NOTHING`,
      [userId, permissionKey, grantedBy],
    );
    await tx.query(
      'DELETE FROM user_permission_revocations WHERE user_id = $1 AND permission_key = $2',
      [userId, permissionKey],
    );
  },

  async revokePermissionDirectly(tx, userId, permissionKey, revokedBy) {
    await tx.query(
      `INSERT INTO user_permission_revocations (user_id, permission_key, revoked_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, permission_key) DO NOTHING`,
      [userId, permissionKey, revokedBy],
    );
    await tx.query('DELETE FROM user_permission_grants WHERE user_id = $1 AND permission_key = $2', [
      userId,
      permissionKey,
    ]);
  },

  async isRoleRevocable(tx, roleKey) {
    const { rows } = await tx.query('SELECT revocable FROM roles WHERE key = $1', [roleKey]);
    return rows[0] ? rows[0].revocable : true;
  },

  async countUsersWithRole(tx, roleKey) {
    const { rows } = await tx.query('SELECT count(*)::int AS count FROM user_roles WHERE role_key = $1', [
      roleKey,
    ]);
    return rows[0].count;
  },
};
