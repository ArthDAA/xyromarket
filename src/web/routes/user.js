import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { withTransaction } from '../../db/pool.js';
import { requireAuth, requireCsrf, issueCsrfToken } from '../auth/session.js';
import { mapDomainError } from '../errorMapping.js';
import { layout, escapeHtml } from '../render.js';
import * as listings from '../../domain/listings.js';
import * as ownership from '../../domain/ownership.js';
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
import { settingsRepo } from '../../db/repositories/settingsRepo.js';
import { usersRepo } from '../../db/repositories/usersRepo.js';
import { disputesRepo } from '../../db/repositories/disputesRepo.js';
import { reviewsRepo } from '../../db/repositories/reviewsRepo.js';

const lastGuildSyncAt = new Map(); // userId -> ms epoch, in-process rate limit (1/min)

const listingCreateSchema = z.object({
  guildId: z.string().regex(/^\d{17,20}$/),
  mode: z.enum(['don', 'echange']),
  description: z.string().min(20).max(2000),
  tags: z.array(z.string()).min(1).max(10),
  seekingTags: z.array(z.string()).max(10).optional(),
});
const listingUpdateSchema = listingCreateSchema.partial().omit({ guildId: true, mode: true });
const proposeSwapSchema = z.object({ myListingId: z.string().uuid() });
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
  ERR_GUILD_HAS_ACTIVE_LISTING: 'Ce serveur a déjà une annonce active ou en attente. Retire-la ou attends sa clôture avant d\'en publier une nouvelle.',
  ERR_ROLE_HIERARCHY: 'Le rôle du bot Xyro Market doit être positionné au-dessus du rôle d\'essai sur ce serveur.',
  ERR_NOT_OWNER: 'Tu dois être propriétaire de ce serveur Discord pour effectuer cette action.',
  ERR_SEEKING_TAGS_ON_DON: 'Une annonce en mode "don" ne peut pas avoir de tags recherchés.',
  ERR_LISTING_LOCKED: 'Cette annonce est engagée dans une transaction en cours — retire-la une fois celle-ci terminée.',
  ERR_SELF_QUEUE: 'Tu ne peux pas manifester ton intérêt pour ta propre annonce.',
  ERR_ALREADY_QUEUED: 'Tu es déjà dans la file d\'attente pour cette annonce.',
  ERR_BANNED: 'Ton compte est actuellement suspendu et ne peut pas effectuer cette action.',
  ERR_INVALID_DESCRIPTION: 'La description doit faire entre 20 et 2000 caractères.',
  ERR_INVALID_TAG: 'Un des tags fournis est invalide (lettres minuscules, chiffres et tirets, 2 à 24 caractères) — ou aucun tag n\'a été fourni.',
  ERR_TOO_MANY_TAGS: 'Trop de tags — 10 maximum.',
  ERR_SELF_SWAP: 'Tu ne peux pas proposer un échange avec ta propre annonce.',
  ERR_MODE_MISMATCH: 'Les deux annonces doivent être en mode "échange".',
  ERR_COOLDOWN: 'Un refus récent entre vous deux empêche une nouvelle proposition pour l\'instant.',
  ERR_NOT_PARTICIPANT: 'Tu ne fais pas partie de cette proposition.',
  ERR_PROPOSAL_EXPIRED: 'Cette proposition a expiré ou n\'est plus ouverte.',
  ERR_NOT_PARTY: 'Tu ne fais pas partie de cette transaction.',
  ERR_BAD_TRANSITION: 'Cette action n\'est plus possible — le statut de la transaction a changé entre-temps.',
  ERR_NO_TRANSACTION: 'Aucune transaction terminée ne correspond — impossible de laisser un avis.',
  ERR_ALREADY_REVIEWED: 'Tu as déjà laissé un avis pour cette transaction.',
  ERR_SELF_REVIEW: 'Tu ne peux pas te noter toi-même.',
  ERR_DUPLICATE_DISPUTE: 'Un litige est déjà ouvert pour cette transaction.',
  ERR_WINDOW_CLOSED: 'Le délai pour ouvrir un litige est dépassé.',
  ERR_NOT_TRANSFERRED: 'Cette transaction n\'a pas encore été transférée.',
};

const TRANSACTION_STATUS_LABELS = {
  PROPOSED: 'Proposée',
  ACCEPTED: 'Acceptée — assignation du rôle d\'essai en cours',
  TRIAL: 'Période d\'essai en cours',
  TRIAL_VALIDATED: 'Validée par les deux parties — transfert en cours',
  TRANSFERRED: 'Transférée',
  DISPUTED: 'Litige en cours',
  CANCELLED: 'Annulée',
  EXPIRED: 'Expirée',
  CLOSED: 'Clôturée',
};

const CANCELLABLE_TRANSACTION_STATUSES = new Set(['PROPOSED', 'ACCEPTED', 'TRIAL']);
const TERMINAL_TRANSACTION_STATUSES = new Set(['CANCELLED', 'EXPIRED', 'CLOSED']);

// 'removed' included too (A18): remove() now hard-deletes when it can, so re-offering
// the button on an already-removed listing lets the owner purge a legacy soft-deleted
// row left over from before that change — retrying is harmless either way.
const REMOVABLE_STATUSES = new Set(['active', 'pending_bot', 'hidden', 'removed']);
// No point editing a listing that's already (soft-)removed — matches `assertMutable`
// minus 'removed', unlike REMOVABLE_STATUSES which deliberately keeps it (A18 retry).
const EDITABLE_STATUSES = new Set(['active', 'pending_bot', 'hidden']);

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

/** guildId -> its `active`/`pending_bot` listing, if any — a guild has at most one (uniq_listings_live_guild). */
function liveListingsByGuild(myListings) {
  const byGuild = new Map();
  for (const l of myListings) {
    if (l.status === 'active' || l.status === 'pending_bot') byGuild.set(l.guildId, l);
  }
  return byGuild;
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
    const [guilds, myListings, hubInviteUrl, myTransactions] = await Promise.all([
      ownedGuilds(req.user.id, req.user.discordId),
      withTransaction(pool, (tx) => listingsRepo.listByUser(tx, req.user.id, { limit: 50 })),
      withTransaction(pool, (tx) => settingsRepo.get(tx, 'hub_invite_url')),
      withTransaction(pool, (tx) => transactionsRepo.listByUser(tx, req.user.id, { limit: 50 })),
    ]);

    const liveByGuild = liveListingsByGuild(myListings.items);
    const unpublished = guilds.filter((g) => liveByGuild.get(g.id)?.status !== 'active');
    const guildNameById = new Map(guilds.map((g) => [g.id, g.name || g.id]));
    const csrfToken = issueCsrfToken(req.csrfSecret);

    // Only the non-terminal ones: this is where a party goes to act (valider/annuler), not a full history.
    const ongoing = myTransactions.items.filter((t) => !TERMINAL_TRANSACTION_STATUSES.has(t.status));
    const ongoingDetails = await withTransaction(pool, async (tx) => {
      const out = [];
      for (const t of ongoing) {
        const otherPartyId = t.fromUserId === req.user.id ? t.toUserId : t.fromUserId;
        const [otherParty, guild] = await Promise.all([
          usersRepo.findById(tx, otherPartyId),
          guildsRepo.findById(tx, t.guildId),
        ]);
        out.push({ transaction: t, otherParty, guild });
      }
      return out;
    });

    reply.type('text/html').send(
      layout({
        title: 'Tableau de bord',
        noindex: true,
        body: `<h1>Bonjour ${escapeHtml(req.user.username)}</h1>
<p><a href="/annonces/nouvelle">Créer une annonce</a> · <a href="/matchs">Mes propositions</a> · <a href="/me/export">Exporter mes données</a> ·
<form method="POST" action="/auth/logout" style="display:inline"><button type="submit">Se déconnecter</button></form></p>
${
  hubInviteUrl
    ? `<p><strong>Rejoins le serveur hub Discord</strong> pour pouvoir discuter dès qu'une mise en contact a lieu : <a href="${escapeHtml(hubInviteUrl)}">${escapeHtml(hubInviteUrl)}</a></p>`
    : ''
}
<h2>Mes échanges en cours</h2>
${
  ongoingDetails.length === 0
    ? '<p>Aucun échange en cours.</p>'
    : `<ul>${ongoingDetails
        .map(
          ({ transaction: t, otherParty, guild }) =>
            `<li>${escapeHtml(guild?.name || t.guildId)} — avec ${escapeHtml(otherParty?.username ?? 'utilisateur supprimé')} — <a href="/transactions/${t.id}">${escapeHtml(TRANSACTION_STATUS_LABELS[t.status] ?? t.status)}</a></li>`,
        )
        .join('')}</ul>`
}
${
  guilds.length === 0
    ? '<h2>Mes serveurs Discord (dont je suis propriétaire)</h2><p>Aucun serveur détecté. Assure-toi de posséder au moins un serveur Discord avec ce compte.</p>'
    : `<h2>Serveurs sans annonce publiée</h2>
${
  unpublished.length === 0
    ? '<p>Chacun de tes serveurs a déjà une annonce publiée.</p>'
    : `<ul>${unpublished
        .map((g) => {
          const live = liveByGuild.get(g.id);
          if (live?.status === 'pending_bot') {
            return `<li>${escapeHtml(g.name || g.id)} (${escapeHtml(g.id)}) — <strong>annonce en attente</strong> :
<a href="${escapeHtml(oauth.buildBotInviteUrl(g.id))}">compléter l'invitation du bot</a></li>`;
          }
          return `<li>${escapeHtml(g.name || g.id)} (${escapeHtml(g.id)}) — <a href="/annonces/nouvelle">créer une annonce</a></li>`;
        })
        .join('')}</ul>`
}`
}
<h2>Mes annonces</h2>
${
  myListings.items.length === 0
    ? '<p>Aucune annonce pour l\'instant.</p>'
    : `<ul>${myListings.items
        .map(
          (l) =>
            `<li>${escapeHtml(guildNameById.get(l.guildId) ?? l.guildId)} — <a href="/annonces/${l.id}">${escapeHtml(l.description.slice(0, 60))}</a> — ${escapeHtml(l.mode)} — ${escapeHtml(l.status)}${
              EDITABLE_STATUSES.has(l.status) ? ` — <a href="/annonces/${l.id}/modifier">Modifier</a>` : ''
            }${
              REMOVABLE_STATUSES.has(l.status)
                ? ` — <form method="POST" action="/annonces/${l.id}/supprimer" style="display:inline">
<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
<button type="submit">Supprimer</button></form>`
                : ''
            }</li>`,
        )
        .join('')}</ul>`
}`,
      }),
    );
  }));

  /** Plain HTML form to create a listing — no JS, submits as application/x-www-form-urlencoded. */
  app.get('/annonces/nouvelle', { preHandler: [auth] }, withAccept(async (req, reply) => {
    const [allGuilds, myListings] = await Promise.all([
      ownedGuilds(req.user.id, req.user.discordId),
      withTransaction(pool, (tx) => listingsRepo.listByUser(tx, req.user.id, { limit: 50 })),
    ]);
    // Only guilds without a live (active/pending_bot) listing already — picking one of the
    // others here would just bounce back as ERR_GUILD_HAS_ACTIVE_LISTING.
    const liveByGuild = liveListingsByGuild(myListings.items);
    const guilds = allGuilds.filter((g) => !liveByGuild.has(g.id));
    const csrfToken = issueCsrfToken(req.csrfSecret);

    reply.type('text/html').send(
      layout({
        title: 'Nouvelle annonce',
        noindex: true,
        body: `<h1>Créer une annonce</h1>
${guilds.length === 0 ? '<p>Aucun serveur disponible — chaque serveur dont tu es propriétaire a déjà une annonce active ou en attente. Reviens une fois propriétaire d\'un nouveau serveur Discord.</p>' : ''}
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

  /** Plain HTML form to edit an existing listing — description/tags/seekingTags only, guild and mode are fixed at creation. */
  app.get('/annonces/:id/modifier', { preHandler: [auth] }, withAccept(async (req, reply) => {
    const listing = await withTransaction(pool, async (tx) => {
      const l = await listingsRepo.findById(tx, req.params.id);
      if (!l) throw new listings.ListingError('NOT_FOUND', 'Listing not found');
      await ownership.assertOwnershipForListing(tx, req.user.id, l.guildId);
      return l;
    });
    const csrfToken = issueCsrfToken(req.csrfSecret);

    reply.type('text/html').send(
      layout({
        title: 'Modifier l\'annonce',
        noindex: true,
        body: `<h1>Modifier l'annonce</h1>
<p>Mode : ${escapeHtml(listing.mode)} (non modifiable — retire l'annonce depuis le <a href="/tableau-de-bord">tableau de bord</a> et recrée-la pour changer de mode)</p>
<form method="POST" action="/annonces/${listing.id}/modifier">
<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
<p>
<label for="description">Description (20 à 2000 caractères)</label><br>
<textarea id="description" name="description" minlength="20" maxlength="2000" required rows="5" cols="60">${escapeHtml(listing.description)}</textarea>
</p>
<p>
<label for="tags">Tags (séparés par des virgules)</label><br>
<input id="tags" name="tags" type="text" value="${escapeHtml(listing.tags.join(','))}" required>
</p>
${
  listing.mode === 'echange'
    ? `<p>
<label for="seekingTags">Recherché (séparés par des virgules)</label><br>
<input id="seekingTags" name="seekingTags" type="text" value="${escapeHtml(listing.seekingTags.join(','))}">
</p>`
    : ''
}
<p><button type="submit">Enregistrer</button></p>
</form>`,
      }),
    );
  }));

  /** Form-friendly equivalent of `PATCH /annonces/:id` — same schema, same domain call. */
  app.post('/annonces/:id/modifier', { preHandler: [auth, csrf] }, withAccept(async (req, reply) => {
    const raw = isFormSubmission(req)
      ? { ...req.body, tags: splitTags(req.body.tags), seekingTags: splitTags(req.body.seekingTags) }
      : req.body;
    const body = listingUpdateSchema.parse(raw);
    await withTransaction(pool, (tx) => listings.update(tx, req.user.id, req.params.id, body));
    if (isFormSubmission(req)) {
      return reply.redirect(`/annonces/${req.params.id}`, 303);
    }
    reply.send({ ok: true });
  }));

  app.post('/annonces', { preHandler: [auth, csrf] }, withAccept(async (req, reply) => {
    const raw = isFormSubmission(req)
      ? { ...req.body, tags: splitTags(req.body.tags), seekingTags: splitTags(req.body.seekingTags) }
      : req.body;
    const body = listingCreateSchema.parse(raw);
    const listing = await withTransaction(pool, (tx) => listings.create(tx, req.user.id, body));
    if (listing.status === 'pending_bot') {
      const botInviteUrl = oauth.buildBotInviteUrl(listing.guildId);
      if (isFormSubmission(req)) {
        return reply.redirect(botInviteUrl, 303);
      }
      return reply.code(201).send({ listing, botInviteUrl });
    }
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

  /** Same as `DELETE /annonces/:id` — a plain `<form>` can only submit GET/POST, never DELETE. */
  app.post('/annonces/:id/supprimer', { preHandler: [auth, csrf] }, withAccept(async (req, reply) => {
    await withTransaction(pool, (tx) => listings.remove(tx, req.user.id, req.params.id));
    return reply.redirect('/tableau-de-bord', 303);
  }));

  app.post('/annonces/:id/file', { preHandler: [auth, csrf] }, withAccept(async (req, reply) => {
    const result = await withTransaction(pool, (tx) => queue.enqueue(tx, req.params.id, req.user.id));
    if (isFormSubmission(req)) {
      return reply.redirect(`/annonces/${req.params.id}`, 303);
    }
    reply.code(201).send(result);
  }));

  app.delete('/annonces/:id/file', { preHandler: [auth, csrf] }, withAccept(async (req, reply) => {
    await withTransaction(pool, (tx) => queue.withdraw(tx, req.params.id, req.user.id));
    reply.code(204).send();
  }));

  /** Same as `DELETE /annonces/:id/file` — a plain `<form>` can only submit GET/POST, never DELETE. */
  app.post('/annonces/:id/file/quitter', { preHandler: [auth, csrf] }, withAccept(async (req, reply) => {
    await withTransaction(pool, (tx) => queue.withdraw(tx, req.params.id, req.user.id));
    return reply.redirect(`/annonces/${req.params.id}`, 303);
  }));

  /** A19: manually propose a direct 1:1 swap with `:id` — replaces the automatic TTC engine. */
  app.post('/annonces/:id/echanger', { preHandler: [auth, csrf] }, withAccept(async (req, reply) => {
    const { myListingId } = proposeSwapSchema.parse(req.body);
    const result = await withTransaction(pool, (tx) =>
      engine.proposeDirectSwap(tx, req.user.id, myListingId, req.params.id),
    );
    if (isFormSubmission(req)) {
      return reply.redirect('/matchs', 303);
    }
    reply.code(201).send(result);
  }));

  /** HTML page (A19): the only place a proposal — queue match or manually-proposed swap — can be accepted/refused from the browser. */
  app.get('/matchs', { preHandler: [auth] }, withAccept(async (req, reply) => {
    const [proposals, hubInviteUrl] = await Promise.all([
      withTransaction(pool, (tx) => matchRepo.findOpenProposalsForUser(tx, req.user.id)),
      withTransaction(pool, (tx) => settingsRepo.get(tx, 'hub_invite_url')),
    ]);
    const detailed = await withTransaction(pool, async (tx) => {
      const out = [];
      for (const p of proposals) {
        const { participants } = await matchRepo.getProposal(tx, p.id);
        const withListings = [];
        for (const part of participants) {
          withListings.push({ ...part, listing: await listingsRepo.findById(tx, part.listingId) });
        }
        out.push({ proposal: p, participants: withListings });
      }
      return out;
    });
    const csrfToken = issueCsrfToken(req.csrfSecret);

    reply.type('text/html').send(
      layout({
        title: 'Mes propositions',
        noindex: true,
        body: `<h1>Mes propositions</h1>
${
  detailed.length === 0 || !hubInviteUrl
    ? ''
    : `<p>La conversation avec l'autre partie se passe dans un fil privé sur le serveur hub Discord — <strong>rejoins-le si ce n'est pas déjà fait</strong> : <a href="${escapeHtml(hubInviteUrl)}">${escapeHtml(hubInviteUrl)}</a></p>`
}
${
  detailed.length === 0
    ? '<p>Aucune proposition en cours.</p>'
    : `<ul>${detailed
        .map(({ proposal, participants }) => {
          const mine = participants.find((p) => p.userId === req.user.id);
          const rows = participants
            .map(
              (p) =>
                `<li>${p.userId === req.user.id ? 'Toi' : 'L\'autre partie'} — ${escapeHtml(p.listing?.description.slice(0, 60) ?? '?')} — ${p.acceptedAt ? '✓ accepté' : p.refusedAt ? 'refusé' : 'en attente'}</li>`,
            )
            .join('');
          return `<li>
<p>${escapeHtml(proposal.kind === 'queue' ? 'Don' : 'Échange')} — expire le ${escapeHtml(new Date(proposal.expiresAt).toLocaleString('fr-FR'))}</p>
<ul>${rows}</ul>
${
  mine?.acceptedAt
    ? ''
    : `<form method="POST" action="/matchs/${proposal.id}/accepter" style="display:inline">
<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
<button type="submit">Accepter</button>
</form>
<form method="POST" action="/matchs/${proposal.id}/refuser" style="display:inline">
<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
<button type="submit">Refuser</button>
</form>`
}
</li>`;
        })
        .join('')}</ul>`
}`,
      }),
    );
  }));

  app.post('/matchs/:id/accepter', { preHandler: [auth, csrf] }, withAccept(async (req, reply) => {
    const result = await withTransaction(pool, (tx) => engine.accept(tx, req.user.id, req.params.id));
    if (isFormSubmission(req)) {
      return reply.redirect('/matchs', 303);
    }
    reply.send(result);
  }));

  app.post('/matchs/:id/refuser', { preHandler: [auth, csrf] }, withAccept(async (req, reply) => {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
    await withTransaction(pool, (tx) => engine.refuse(tx, req.user.id, req.params.id, reason));
    if (isFormSubmission(req)) {
      return reply.redirect('/matchs', 303);
    }
    reply.code(204).send();
  }));

  /** HTML page: everything a party can do with one transaction — status, valider/annuler, litige, avis. */
  app.get('/transactions/:id', { preHandler: [auth] }, withAccept(async (req, reply) => {
    const data = await withTransaction(pool, async (tx) => {
      const transaction = await transactionsRepo.findById(tx, req.params.id);
      if (!transaction || (transaction.fromUserId !== req.user.id && transaction.toUserId !== req.user.id)) {
        return null;
      }
      const otherPartyId = transaction.fromUserId === req.user.id ? transaction.toUserId : transaction.fromUserId;
      const [otherParty, guild, myReview, openDispute] = await Promise.all([
        usersRepo.findById(tx, otherPartyId),
        guildsRepo.findById(tx, transaction.guildId),
        reviewsRepo.findByTransactionAndAuthor(tx, transaction.id, req.user.id),
        disputesRepo.findOpenByTransaction(tx, transaction.id),
      ]);
      return { transaction, otherParty, guild, myReview, openDispute };
    });
    if (!data) {
      return reply.code(404).type('text/html').send(
        layout({ title: 'Introuvable', body: '<h1>404</h1><p><a href="/tableau-de-bord">Retour au tableau de bord</a></p>' }),
      );
    }
    const { transaction: t, otherParty, guild, myReview, openDispute } = data;
    const iAmFrom = t.fromUserId === req.user.id;
    const myValidated = iAmFrom ? t.validatedByFromAt : t.validatedByToAt;
    const otherValidated = iAmFrom ? t.validatedByToAt : t.validatedByFromAt;
    const csrfToken = issueCsrfToken(req.csrfSecret);

    reply.type('text/html').send(
      layout({
        title: 'Transaction',
        noindex: true,
        body: `<h1>${escapeHtml(guild?.name || t.guildId)}</h1>
<p>Avec : ${escapeHtml(otherParty?.username ?? 'utilisateur supprimé')} · Statut : <strong>${escapeHtml(TRANSACTION_STATUS_LABELS[t.status] ?? t.status)}</strong></p>
${t.status === 'TRIAL' && t.trialEndsAt ? `<p>Fin de la période d'essai : ${escapeHtml(new Date(t.trialEndsAt).toLocaleString('fr-FR'))}</p>` : ''}
${
  t.status === 'TRIAL'
    ? `<p>Toi : ${myValidated ? '✓ validé' : 'pas encore validé'} — L'autre partie : ${otherValidated ? '✓ validé' : 'pas encore validé'}</p>`
    : ''
}
${
  t.status === 'TRIAL' && !myValidated
    ? `<form method="POST" action="/transactions/${t.id}/valider" style="display:inline">
<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
<button type="submit">Valider le transfert</button>
</form> `
    : ''
}
${
  CANCELLABLE_TRANSACTION_STATUSES.has(t.status)
    ? `<form method="POST" action="/transactions/${t.id}/annuler" style="display:inline">
<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
<button type="submit">Annuler l'échange</button>
</form>`
    : ''
}
${
  openDispute
    ? '<p><strong>Un litige est ouvert sur cette transaction.</strong> La modération a été notifiée.</p>'
    : t.status === 'TRANSFERRED'
      ? `<details><summary>Ouvrir un litige</summary>
<form method="POST" action="/transactions/${t.id}/litige">
<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
<p><label for="reason">Raison</label><br><input id="reason" name="reason" type="text" required></p>
<p><label for="disputeBody">Détails (optionnel)</label><br><textarea id="disputeBody" name="body" maxlength="2000"></textarea></p>
<p><button type="submit">Ouvrir le litige</button></p>
</form></details>`
      : ''
}
${
  ['TRANSFERRED', 'CLOSED'].includes(t.status) && !myReview
    ? `<details><summary>Laisser un avis</summary>
<form method="POST" action="/transactions/${t.id}/avis">
<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
<p><label for="rating">Note (1 à 5)</label><br>
<select id="rating" name="rating" required>
<option value="5">5</option><option value="4">4</option><option value="3">3</option><option value="2">2</option><option value="1">1</option>
</select></p>
<p><label for="reviewBody">Commentaire (optionnel)</label><br><textarea id="reviewBody" name="body" maxlength="1000"></textarea></p>
<p><button type="submit">Envoyer l'avis</button></p>
</form></details>`
    : ''
}
<p><a href="/tableau-de-bord">Retour au tableau de bord</a></p>`,
      }),
    );
  }));

  app.post('/transactions/:id/valider', { preHandler: [auth, csrf] }, withAccept(async (req, reply) => {
    const transaction = await withTransaction(pool, (tx) => trial.validate(tx, req.user.id, req.params.id));
    if (isFormSubmission(req)) {
      return reply.redirect(`/transactions/${req.params.id}`, 303);
    }
    reply.send({ transaction });
  }));

  app.post('/transactions/:id/annuler', { preHandler: [auth, csrf] }, withAccept(async (req, reply) => {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'user_requested';
    const transaction = await withTransaction(pool, (tx) => trial.cancel(tx, req.user.id, req.params.id, reason));
    if (isFormSubmission(req)) {
      return reply.redirect(`/transactions/${req.params.id}`, 303);
    }
    reply.send({ transaction });
  }));

  app.post('/transactions/:id/litige', { preHandler: [auth, csrf] }, withAccept(async (req, reply) => {
    const body = disputeOpenSchema.parse(req.body);
    const dispute = await withTransaction(pool, (tx) => disputeDomain.open(tx, req.user.id, req.params.id, body));
    if (isFormSubmission(req)) {
      return reply.redirect(`/transactions/${req.params.id}`, 303);
    }
    reply.code(201).send({ dispute });
  }));

  app.post('/transactions/:id/avis', { preHandler: [auth, csrf] }, withAccept(async (req, reply) => {
    const raw = isFormSubmission(req) ? { ...req.body, rating: Number(req.body.rating) } : req.body;
    const body = reviewSchema.parse(raw);
    const review = await withTransaction(pool, (tx) => reputation.submit(tx, req.user.id, req.params.id, body));
    if (isFormSubmission(req)) {
      return reply.redirect(`/transactions/${req.params.id}`, 303);
    }
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
