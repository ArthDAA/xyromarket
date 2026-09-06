import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { withTransaction } from '../../db/pool.js';
import { requireAuth, requirePermission, requireCsrf } from '../auth/session.js';
import { mapDomainError } from '../errorMapping.js';
import * as listings from '../../domain/listings.js';
import * as moderation from '../../domain/moderation.js';
import * as rbac from '../../domain/rbac.js';
import * as disputeDomain from '../../domain/dispute.js';
import * as audit from '../../domain/audit.js';
import * as stats from '../../domain/stats.js';
import { usersRepo } from '../../db/repositories/usersRepo.js';
import { reportsRepo } from '../../db/repositories/reportsRepo.js';
import { reviewsRepo } from '../../db/repositories/reviewsRepo.js';
import { rbacRepo } from '../../db/repositories/rbacRepo.js';
import { transactionsRepo } from '../../db/repositories/transactionsRepo.js';
import { settingsRepo } from '../../db/repositories/settingsRepo.js';

const sanctionSchema = z.object({
  kind: z.enum(['ban_temp', 'ban_perm', 'suspend', 'warn']),
  reason: z.string().min(1),
  endsAt: z.string().datetime().optional(),
});
const settingSchema = z.object({ value: z.unknown() });
const roleAssignSchema = z.object({ roleKey: z.string() });
const permissionSchema = z.object({ permissionKey: z.string() });
const resolveDisputeSchema = z.object({
  outcome: z.enum(['return_expected', 'rejected', 'settled']),
  body: z.string().max(2000).optional(),
});

function withAccept(handler) {
  return async (req, reply) => {
    try {
      return await handler(req, reply);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.code(422).send({ error: 'ERR_VALIDATION', issues: err.issues });
      }
      const correlationId = randomUUID();
      const mapped = mapDomainError(err, correlationId);
      if (mapped.status === 500) req.log.error({ err, correlationId }, 'unexpected admin error');
      return reply.code(mapped.status).send(mapped.body);
    }
  };
}

/**
 * The 9 §2bis domains, each gated by a granular permission — an admin route
 * never tests a role name. Every mutation here is delegated to `src/domain/`,
 * which already writes its own `audit_log` entry in the same transaction;
 * this file adds no second audit write on top.
 */
export default async function adminRoutes(app, { pool }) {
  const guard = (permission) => [requireAuth(pool), requirePermission(pool, permission)];
  const csrf = requireCsrf();

  // --- Utilisateurs ---
  app.get('/admin/users/:id', { preHandler: guard('users.read') }, withAccept(async (req, reply) => {
    const user = await withTransaction(pool, (tx) => usersRepo.findById(tx, req.params.id));
    if (!user) return reply.code(404).send({ error: 'NOT_FOUND' });
    reply.send({ user });
  }));

  app.post('/admin/users/:id/sanction', { preHandler: [...guard('users.ban'), csrf] }, withAccept(async (req, reply) => {
    const body = sanctionSchema.parse(req.body);
    const sanction = await withTransaction(pool, (tx) => moderation.sanction(tx, req.user.id, req.params.id, body));
    reply.code(201).send({ sanction });
  }));

  app.post('/admin/sanctions/:id/lift', { preHandler: [...guard('users.ban'), csrf] }, withAccept(async (req, reply) => {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';
    const sanction = await withTransaction(pool, (tx) => moderation.lift(tx, req.user.id, req.params.id, reason));
    reply.send({ sanction });
  }));

  app.post('/admin/users/:id/roles', { preHandler: [...guard('users.manage_roles'), csrf] }, withAccept(async (req, reply) => {
    const { roleKey } = roleAssignSchema.parse(req.body);
    await withTransaction(pool, (tx) => rbac.assignRole(tx, req.user.id, req.params.id, roleKey));
    reply.code(204).send();
  }));

  app.delete('/admin/users/:id/roles/:roleKey', { preHandler: [...guard('users.manage_roles'), csrf] }, withAccept(async (req, reply) => {
    await withTransaction(pool, (tx) => rbac.revokeRole(tx, req.user.id, req.params.id, req.params.roleKey));
    reply.code(204).send();
  }));

  // --- Annonces ---
  app.get('/admin/listings', { preHandler: guard('listings.read') }, withAccept(async (req, reply) => {
    const page = await withTransaction(pool, (tx) => listings.listPublic(tx, {}, { cursor: req.query.cursor }));
    reply.send(page);
  }));

  app.post('/admin/listings/:id/hide', { preHandler: [...guard('listings.hide'), csrf] }, withAccept(async (req, reply) => {
    const listing = await withTransaction(pool, (tx) => listings.hide(tx, req.user.id, req.params.id));
    reply.send({ listing });
  }));

  app.post('/admin/listings/:id/restore', { preHandler: [...guard('listings.hide'), csrf] }, withAccept(async (req, reply) => {
    const listing = await withTransaction(pool, (tx) => listings.restore(tx, req.user.id, req.params.id));
    reply.send({ listing });
  }));

  // --- Modération / Signalements ---
  app.get('/admin/reports', { preHandler: guard('reports.read') }, withAccept(async (req, reply) => {
    const page = await withTransaction(pool, (tx) =>
      reportsRepo.listFiltered(tx, { status: req.query.status }, { cursor: req.query.cursor }),
    );
    reply.send(page);
  }));

  app.post('/admin/reports/:id/assign', { preHandler: [...guard('reports.assign'), csrf] }, withAccept(async (req, reply) => {
    const report = await withTransaction(pool, (tx) => moderation.assign(tx, req.user.id, req.params.id, req.body.assigneeId));
    reply.send({ report });
  }));

  app.post('/admin/reports/:id/resolve', { preHandler: [...guard('reports.assign'), csrf] }, withAccept(async (req, reply) => {
    const report = await withTransaction(pool, (tx) => moderation.resolve(tx, req.user.id, req.params.id));
    reply.send({ report });
  }));

  app.post('/admin/reports/:id/notes', { preHandler: [...guard('reports.assign'), csrf] }, withAccept(async (req, reply) => {
    await withTransaction(pool, (tx) => moderation.addNote(tx, req.user.id, req.params.id, req.body.body ?? ''));
    reply.code(204).send();
  }));

  // --- Avis / Réputation ---
  app.get('/admin/reviews/:userId', { preHandler: guard('reviews.read') }, withAccept(async (req, reply) => {
    const page = await withTransaction(pool, (tx) => reviewsRepo.history(tx, req.params.userId, { cursor: req.query.cursor }));
    reply.send(page);
  }));

  app.post('/admin/reviews/:id/hide', { preHandler: [...guard('reviews.delete'), csrf] }, withAccept(async (req, reply) => {
    const review = await withTransaction(pool, (tx) => reviewsRepo.hide(tx, req.params.id, req.user.id));
    await withTransaction(pool, (tx) =>
      audit.record(tx, { actorId: req.user.id, action: 'review.hidden', targetType: 'review', targetId: req.params.id }),
    );
    reply.send({ review });
  }));

  // --- Permissions (RBAC) ---
  app.get('/admin/rbac/roles', { preHandler: guard('rbac.read') }, withAccept(async (req, reply) => {
    reply.send({ roles: await withTransaction(pool, (tx) => rbacRepo.listRoles(tx)) });
  }));

  app.get('/admin/rbac/permissions', { preHandler: guard('rbac.read') }, withAccept(async (req, reply) => {
    reply.send({ permissions: await withTransaction(pool, (tx) => rbacRepo.listPermissions(tx)) });
  }));

  app.post('/admin/users/:id/permissions', { preHandler: [...guard('rbac.grant'), csrf] }, withAccept(async (req, reply) => {
    const { permissionKey } = permissionSchema.parse(req.body);
    await withTransaction(pool, (tx) => rbac.grantPermission(tx, req.user.id, req.params.id, permissionKey));
    reply.code(204).send();
  }));

  app.delete('/admin/users/:id/permissions/:permissionKey', { preHandler: [...guard('rbac.grant'), csrf] }, withAccept(async (req, reply) => {
    await withTransaction(pool, (tx) => rbac.revokePermission(tx, req.user.id, req.params.id, req.params.permissionKey));
    reply.code(204).send();
  }));

  // --- Transactions ---
  app.get('/admin/transactions/:id', { preHandler: guard('transactions.read') }, withAccept(async (req, reply) => {
    const transaction = await withTransaction(pool, (tx) => transactionsRepo.findById(tx, req.params.id));
    if (!transaction) return reply.code(404).send({ error: 'NOT_FOUND' });
    reply.send({ transaction });
  }));

  app.post('/admin/disputes/:id/resolve', { preHandler: [...guard('transactions.resolve'), csrf] }, withAccept(async (req, reply) => {
    const body = resolveDisputeSchema.parse(req.body);
    const dispute = await withTransaction(pool, (tx) => disputeDomain.resolve(tx, req.user.id, req.params.id, body));
    reply.send({ dispute });
  }));

  // --- Configuration site ---
  app.get('/admin/settings', { preHandler: guard('settings.read') }, withAccept(async (req, reply) => {
    reply.send({ settings: await withTransaction(pool, (tx) => settingsRepo.getAll(tx)) });
  }));

  app.put('/admin/settings/:key', { preHandler: [...guard('settings.write'), csrf] }, withAccept(async (req, reply) => {
    const { value } = settingSchema.parse(req.body);
    if (req.params.key === 'trial_duration_days' && (value < 1 || value > 90)) {
      return reply.code(422).send({ error: 'ERR_SETTING_INVALID' });
    }
    const setting = await withTransaction(pool, (tx) => settingsRepo.set(tx, req.params.key, value, req.user.id));
    await withTransaction(pool, (tx) =>
      audit.record(tx, { actorId: req.user.id, action: 'settings.updated', targetType: 'setting', targetId: req.params.key, after: { value } }),
    );
    reply.send({ setting });
  }));

  // --- Statistiques ---
  app.get('/admin/stats/:metric', { preHandler: guard('stats.read') }, withAccept(async (req, reply) => {
    const result = await withTransaction(pool, (tx) =>
      stats.read(tx, req.params.metric, { from: req.query.from, to: req.query.to, granularity: req.query.granularity }),
    );
    reply.send(result);
  }));

  // --- Logs / audit ---
  app.get('/admin/audit', { preHandler: guard('audit.read') }, withAccept(async (req, reply) => {
    const page = await withTransaction(pool, (tx) =>
      audit.query(
        tx,
        { actorId: req.query.actorId, action: req.query.action, targetType: req.query.targetType },
        { cursor: req.query.cursor },
      ),
    );
    reply.send(page);
  }));
}
