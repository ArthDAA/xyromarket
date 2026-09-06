import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { withTransaction } from '../../db/pool.js';
import { requireAuth, requireCsrf, issueCsrfToken } from '../auth/session.js';
import { mapDomainError } from '../errorMapping.js';
import { layout, escapeHtml } from '../render.js';
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
import { listingsRepo } from '../../db/repositories/listingsRepo.js';
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

/** Human-readable French text for domain errors a form submitter can actually act on. */
const FORM_ERROR_MESSAGES = {
  ERR_GUILD_HAS_ACTIVE_LISTING: 'Ce serveur a déjà une annonce active. Retire-la ou attends sa clôture avant d\'en publier une nouvelle.',
  ERR_BOT_ABSENT: 'Le bot Xyro Market n\'est pas encore présent sur ce serveur — invite-le avant de publier une annonce.',
  ERR_ROLE_HIERARCHY: 'Le rôle du bot Xyro Market doit être positionné au-dessus du rôle d\'essai sur ce serveur.',
  ERR_NOT_OWNER: 'Tu dois être propriétaire de ce serveur Discord pour effectuer cette action.',
  ERR_SEEKING_TAGS_ON_DON: 'Une annonce en mode "don" ne peut pas avoir de tags recherchés.',
};

function withAccept(handler) {
  return async (req, reply) => {
    try {
      return await handler(req, reply);
    } catch (err) {
      if (err instanceof z.ZodError) {
        if (isFormSubmission(req)) {
          return renderFormError(reply, err.issues.map((i) => i.message).join(' — '));
        }
        return reply.code(422).send({ error: 'ERR_VALIDATION', issues: err.issues });
      }
      const correlationId = randomUUID();
      const mapped = mapDomainError(err, correlationId);
      if (mapped.status === 500) {
        req.log.error({ err, correlationId }, 'unexpected error');
      }
      if (isFormSubmission(req)) {
        const message = FORM_ERROR_MESSAGES[err.code] ?? `${err.code ?? 'ERR_UNEXPECTED'} — ${err.message ?? ''}`;
        return renderFormError(reply, message, mapped.status);
      }
      return reply.code(mapped.status).send(mapped.body);
    }
  };
}

/** A plain HTML `<form>` (no fetch/JS) always posts this content type — used to pick HTML vs JSON responses. */
function isFormSubmission(req) {
  return Boolean(req.headers['content-type']?.includes('application/x-www-form-urlencoded'));
}

function renderFormError(reply, message, status = 422) {
  // No `javascript:` back-link: CSP's script-src ('self' only, no unsafe-inline) blocks it anyway.
  return reply
    .code(status)
    .type('text/html')
    .send(
      layout({
        title: 'Erreur',
        body: `<h1>Une erreur est survenue</h1><p>${escapeHtml(message)}</p><p><a href="/tableau-de-bord">Retour au tableau de bord</a></p>`,
      }),
    );
}

/** Comma-separated tag inputs (plain `<form>` has no native array field) split into a clean array. */
function splitTags(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Every mutating route here is a thin adapter into `src/domain/` — no business rule lives in this file. */
export default async function userRoutes(app, { pool }) {
  const auth = requireAuth(pool);
  const csrf = requireCsrf();

  /** Syncs owned guilds against Discord at most once/min/user, then returns the stored list. */
  async function ownedGuilds(userId, discordId) {
    const last = lastGuildSyncAt.get(userId) ?? 0;
    if (Date.now() - last > 60_000) {
      lastGuildSyncAt.set(userId, Date.now());
      await withTransaction(pool, (tx) => oauth.syncOwnedGuilds(tx, userId));
    }
    return withTransaction(pool, (tx) => guildsRepo.listOwnedByDiscordId(tx, discordId));
  }

  app.get('/me', { preHandler: [auth] }, withAccept(async (req, reply) => {
    reply.send({ user: req.user });
  }));

  app.get('/me/serveurs', { preHandler: [auth] }, withAccept(async (req, reply) => {
    const guilds = await ownedGuilds(req.user.id, req.user.discordId);
    reply.send({ guilds });
  }));

  /** Authenticated home: own listings, owned Discord guilds, entry point to create a listing. */
  app.get('/tableau-de-bord', { preHandler: [auth] }, withAccept(async (req, reply) => {
    const [guilds, myListings] = await Promise.all([
      ownedGuilds(req.user.id, req.user.discordId),
      withTransaction(pool, (tx) => listingsRepo.listByUser(tx, req.user.id, { limit: 50 })),
    ]);

    reply.type('text/html').send(
      layout({
        title: 'Tableau de bord',
        noindex: true,
        body: `<h1>Bonjour ${escapeHtml(req.user.username)}</h1>
<p><a href="/annonces/nouvelle">Créer une annonce</a> · <a href="/me/export">Exporter mes données</a> ·
<form method="POST" action="/auth/logout" style="display:inline"><button type="submit">Se déconnecter</button></form></p>
<h2>Mes serveurs Discord (dont je suis propriétaire)</h2>
${
  guilds.length === 0
    ? '<p>Aucun serveur détecté. Assure-toi de posséder au moins un serveur Discord avec ce compte.</p>'
    : `<ul>${guilds
        .map(
          (g) =>
            `<li>${escapeHtml(g.name || g.id)} (${escapeHtml(g.id)})${g.botPresent ? '' : ' — <strong>le bot Xyro Market n\'y est pas encore invité</strong>'}</li>`,
        )
        .join('')}</ul>`
}
<h2>Mes annonces</h2>
${
  myListings.items.length === 0
    ? '<p>Aucune annonce pour l\'instant.</p>'
    : `<ul>${myListings.items
        .map(
          (l) =>
            `<li><a href="/annonces/${l.id}">${escapeHtml(l.description.slice(0, 60))}</a> — ${escapeHtml(l.mode)} — ${escapeHtml(l.status)}</li>`,
        )
        .join('')}</ul>`
}`,
      }),
    );
  }));

  /** Plain HTML form to create a listing — no JS, submits as application/x-www-form-urlencoded. */
  app.get('/annonces/nouvelle', { preHandler: [auth] }, withAccept(async (req, reply) => {
    const guilds = await ownedGuilds(req.user.id, req.user.discordId);
    const csrfToken = issueCsrfToken(req.csrfSecret);

    reply.type('text/html').send(
      layout({
        title: 'Nouvelle annonce',
        noindex: true,
        body: `<h1>Créer une annonce</h1>
${guilds.length === 0 ? '<p>Aucun serveur détecté sur ton compte — reviens une fois propriétaire d\'un serveur Discord.</p>' : ''}
<form method="POST" action="/annonces">
<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
<p>
<label for="guildId">Serveur</label><br>
<select id="guildId" name="guildId" required>
${guilds.map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name || g.id)}</option>`).join('')}
</select>
</p>
<p>
<label for="mode">Mode</label><br>
<select id="mode" name="mode" required>
<option value="don">Don</option>
<option value="echange">Échange</option>
</select>
</p>
<p>
<label for="description">Description (20 à 2000 caractères)</label><br>
<textarea id="description" name="description" minlength="20" maxlength="2000" required rows="5" cols="60"></textarea>
</p>
<p>
<label for="tags">Tags (séparés par des virgules, ex. gaming,minecraft)</label><br>
<input id="tags" name="tags" type="text" required>
</p>
<p>
<label for="seekingTags">Recherché — mode échange uniquement (séparés par des virgules)</label><br>
<input id="seekingTags" name="seekingTags" type="text">
</p>
<p><button type="submit">Publier l'annonce</button></p>
</form>`,
      }),
    );
  }));

  app.post('/annonces', { preHandler: [auth, csrf] }, withAccept(async (req, reply) => {
    const raw = isFormSubmission(req)
      ? { ...req.body, tags: splitTags(req.body.tags), seekingTags: splitTags(req.body.seekingTags) }
      : req.body;
    const body = listingCreateSchema.parse(raw);
    const listing = await withTransaction(pool, (tx) => listings.create(tx, req.user.id, body));
    if (isFormSubmission(req)) {
      return reply.redirect(`/annonces/${listing.id}`, 303);
    }
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
