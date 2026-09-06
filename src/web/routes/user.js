import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { withTransaction } from '../../db/pool.js';
import { requireAuth, requireCsrf } from '../auth/session.js';
import { mapDomainError } from '../errorMapping.js';
import * as listings from '../../domain/listings.js';
import * as queue from '../../domain/matching/queue.js';
import * as engine from '../../domain/matching/engine.js';
import * as trial from '../../domain/trial.js';
import * as disputeDomain from '../../domain/dispute.js';
import * as reputation from '../../domain/reputation.js';
import * as moderation from '../../domain/moderation.js';
import * as gdpr from '../../domain/gdpr.js';
import * as oauth from '../auth/oauth.js';
import { guildsRepo } from '../../db/repositories/guildsRepo.js';
import { transactionsRepo } from '../../db/repositories/transactionsRepo.js';
import { matchRepo } from '../../db/repositories/matchRepo.js';

const lastGuildSyncAt = new Map(); // userId -> ms epoch, in-process rate limit (1/min)

const listingCreateSchema = z.object({
  guildId: z.string().regex(/^\d{17,20}$/),
  mode: z.enum(['don', 'echange']),
  description: z.string().min(20).max(2000),
  tags: z.array(z.string()).min(1).max(10),
  seekingTags: z.array(z.string()).max(10).optional(),
});
const listingUpdateSchema = listingCreateSchema.partial().omit({ guildId: true, mode: true });
const reviewSchema = z.object({ rating: z.number().int().min(1).max(5), body: z.string().max(1000).optional() });
const reportSchema = z.object({
  targetType: z.enum(['user', 'listing', 'review', 'message']),
  targetId: z.string(),
  reason: z.string().min(1),
  body: z.string().max(2000).optional(),
});
const disputeOpenSchema = z.object({ reason: z.string().min(1), body: z.string().max(2000).optional() });

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
      if (mapped.status === 500) {
        req.log.error({ err, correlationId }, 'unexpected error');
      }
      return reply.code(mapped.status).send(mapped.body);
    }
  };
}

/** Every mutating route here is a thin adapter into `src/domain/` — no business rule lives in this file. */
export default async function userRoutes(app, { pool }) {
  const auth = requireAuth(pool);
  const csrf = requireCsrf();

  app.get('/me', { preHandler: [auth] }, withAccept(async (req, reply) => {
    reply.send({ user: req.user });
  }));

  app.get('/me/serveurs', { preHandler: [auth] }, withAccept(async (req, reply) => {
    const last = lastGuildSyncAt.get(req.user.id) ?? 0;
    if (Date.now() - last > 60_000) {
      lastGuildSyncAt.set(req.user.id, Date.now());
      await withTransaction(pool, (tx) => oauth.syncOwnedGuilds(tx, req.user.id));
    }
    const guilds = await withTransaction(pool, (tx) => guildsRepo.listOwnedByDiscordId(tx, req.user.discordId));
    reply.send({ guilds });
  }));

  app.post('/annonces', { preHandler: [auth, csrf] }, withAccept(async (req, reply) => {
    const body = listingCreateSchema.parse(req.body);
    const listing = await withTransaction(pool, (tx) => listings.create(tx, req.user.id, body));
    reply.code(201).send({ listing });
  }));

  app.patch('/annonces/:id', { preHandler: [auth, csrf] }, withAccept(async (req, reply) => {
    const body = listingUpdateSchema.parse(req.body);
    const listing = await withTransaction(pool, (tx) => listings.update(tx, req.user.id, req.params.id, body));
    reply.send({ listing });
  }));

  app.delete('/annonces/:id', { preHandler: [auth, csrf] }, withAccept(async (req, reply) => {
    const listing = await withTransaction(pool, (tx) => listings.remove(tx, req.user.id, req.params.id));
    reply.send({ listing });
  }));

  app.post('/annonces/:id/file', { preHandler: [auth, csrf] }, withAccept(async (req, reply) => {
    const result = await withTransaction(pool, (tx) => queue.enqueue(tx, req.params.id, req.user.id));
    reply.code(201).send(result);
  }));

  app.delete('/annonces/:id/file', { preHandler: [auth, csrf] }, withAccept(async (req, reply) => {
    await withTransaction(pool, (tx) => queue.withdraw(tx, req.params.id, req.user.id));
    reply.code(204).send();
  }));

  app.get('/matchs', { preHandler: [auth] }, withAccept(async (req, reply) => {
    const proposals = await withTransaction(pool, (tx) => matchRepo.findOpenProposalsForUser(tx, req.user.id));
    reply.send({ proposals });
  }));

  app.post('/matchs/:id/accepter', { preHandler: [auth, csrf] }, withAccept(async (req, reply) => {
    const result = await withTransaction(pool, (tx) => engine.accept(tx, req.user.id, req.params.id));
    reply.send(result);
  }));

  app.post('/matchs/:id/refuser', { preHandler: [auth, csrf] }, withAccept(async (req, reply) => {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
    await withTransaction(pool, (tx) => engine.refuse(tx, req.user.id, req.params.id, reason));
    reply.code(204).send();
  }));

  app.get('/transactions/:id', { preHandler: [auth] }, withAccept(async (req, reply) => {
    const transaction = await withTransaction(pool, (tx) => transactionsRepo.findById(tx, req.params.id));
    if (!transaction || (transaction.fromUserId !== req.user.id && transaction.toUserId !== req.user.id)) {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }
    reply.send({ transaction });
  }));

  app.post('/transactions/:id/valider', { preHandler: [auth, csrf] }, withAccept(async (req, reply) => {
    const transaction = await withTransaction(pool, (tx) => trial.validate(tx, req.user.id, req.params.id));
    reply.send({ transaction });
  }));

  app.post('/transactions/:id/annuler', { preHandler: [auth, csrf] }, withAccept(async (req, reply) => {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'user_requested';
    const transaction = await withTransaction(pool, (tx) => trial.cancel(tx, req.user.id, req.params.id, reason));
    reply.send({ transaction });
  }));

  app.post('/transactions/:id/litige', { preHandler: [auth, csrf] }, withAccept(async (req, reply) => {
    const body = disputeOpenSchema.parse(req.body);
    const dispute = await withTransaction(pool, (tx) => disputeDomain.open(tx, req.user.id, req.params.id, body));
    reply.code(201).send({ dispute });
  }));

  app.post('/transactions/:id/avis', { preHandler: [auth, csrf] }, withAccept(async (req, reply) => {
    const body = reviewSchema.parse(req.body);
    const review = await withTransaction(pool, (tx) => reputation.submit(tx, req.user.id, req.params.id, body));
    reply.code(201).send({ review });
  }));

  app.post('/signalements', { preHandler: [auth, csrf] }, withAccept(async (req, reply) => {
    const body = reportSchema.parse(req.body);
    const report = await withTransaction(pool, (tx) => moderation.report(tx, req.user.id, body));
    reply.code(201).send({ report });
  }));

  app.get('/me/export', { preHandler: [auth] }, withAccept(async (req, reply) => {
    const data = await withTransaction(pool, (tx) => gdpr.exportData(tx, req.user.id));
    reply.header('Content-Disposition', 'attachment; filename="xyro-market-export.json"');
    reply.send(data);
  }));

  app.post('/me/suppression', { preHandler: [auth, csrf] }, withAccept(async (req, reply) => {
    const user = await withTransaction(pool, (tx) => gdpr.requestDeletion(tx, req.user.id));
    reply.send({ user });
  }));
}
