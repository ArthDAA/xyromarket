import { withTransaction } from '../../db/pool.js';
import { Config } from '../../config/env.js';
import * as listings from '../../domain/listings.js';
import * as reputation from '../../domain/reputation.js';
import { usersRepo } from '../../db/repositories/usersRepo.js';
import { guildsRepo } from '../../db/repositories/guildsRepo.js';
import { listingsRepo } from '../../db/repositories/listingsRepo.js';
import { listingQueueRepo } from '../../db/repositories/listingQueueRepo.js';
import {
  layout,
  legalPage,
  escapeHtml,
  guildIconHtml,
  userAvatarHtml,
  listingCardHtml,
  pillHtml,
  verifiedBadgeHtml,
  bannerImgHtml,
  userBannerUrl,
  starsHtml,
  reviewHtml,
} from '../render.js';
import * as oauth from '../auth/oauth.js';
import * as session from '../auth/session.js';
import { attachAvgColors } from '../iconColor.js';

const OAUTH_STATE_COOKIE = 'xm_oauth_state';

const LEGAL_PAGES = {
  '/mentions-legales': 'Mentions légales',
  '/cgu': 'Conditions générales d’utilisation',
  '/confidentialite': 'Politique de confidentialité',
  '/cookies': 'Cookies et traceurs',
  '/propriete-intellectuelle': 'Propriété intellectuelle',
  '/donnees-personnelles': 'Données personnelles',
  '/droits-rgpd': 'Exercice de vos droits RGPD',
  '/suppression-donnees': 'Suppression de vos données',
  '/securite': 'Politique de sécurité',
  '/reglement': 'Règlement Xyro Market',
  '/regles-discord': 'Règles Discord',
  '/anti-fraude': 'Politique anti-fraude',
  '/anti-abus': 'Politique anti-abus',
  '/signalement': 'Signaler un contenu ou un utilisateur',
  '/retractation': 'Droit de rétractation (service actuellement gratuit)',
};

/**
 * Batch-fetches the guild/owner rows a page of listings references, for
 * display — one query per table, never one per row. Server name + owner
 * alias are public since A28 (deliberate: makes them searchable via
 * `listingsRepo.search`, so hiding them again on the list itself would be
 * inconsistent — a visitor who found a listing by its server name would
 * otherwise not see that name confirmed anywhere).
 */
async function lookupMaps(tx, items) {
  const guildIds = [...new Set(items.map((l) => l.guildId))];
  const userIds = [...new Set(items.map((l) => l.userId))];
  const [guilds, users] = await Promise.all([guildsRepo.findByIds(tx, guildIds), usersRepo.findByIds(tx, userIds)]);
  const guildsWithColor = await attachAvgColors(guilds);
  return {
    guildById: new Map(guildsWithColor.map((g) => [g.id, g])),
    userById: new Map(users.map((u) => [u.id, u])),
  };
}

/** Shared `<ul class="cards">` grid for a page of public listings — used by both `/` (preview) and `/annonces` (full list/search results). */
function listingsListHtml(items, { guildById, userById }) {
  if (items.length === 0) return '<p>Aucune annonce publiée pour l\'instant.</p>';
  return `<ul class="cards">${items
    .map((l) => listingCardHtml(l, { guild: guildById.get(l.guildId), owner: userById.get(l.userId) }))
    .join('')}</ul>`;
}

/** 404 with an actual explanation instead of a bare "404" — same shape as `renderFormError` in user.js. */
function notFoundPage(reply, message, user, caps) {
  return reply
    .code(404)
    .type('text/html')
    .send(
      layout({
        title: 'Introuvable',
        user,
        caps,
        body: `<h1>Introuvable</h1><p>${escapeHtml(message)}</p><p><a href="/">Retour à l'accueil</a></p>`,
      }),
    );
}

/**
 * Showcase, public listing search and every legal page (M8). No mutation
 * lives here — every route is a GET, and a hidden/removed listing 404s
 * rather than leaking a partial view.
 */
export default async function publicRoutes(app, { pool }) {
  // Every route below wants `req.user` for the header's search bar / profile menu (A38)
  // — most didn't previously authenticate at all. `tryAuth` never blocks, so scoping it
  // here (this plugin's own encapsulated context, not main.js) doesn't touch `user.js`'s
  // or `admin.js`'s routes, which already guarantee `req.user` via their own `requireAuth`.
  app.addHook('preHandler', session.tryAuth(pool));

  for (const [path, title] of Object.entries(LEGAL_PAGES)) {
    app.get(path, async (req, reply) => {
      // Was `public, max-age=3600` — no longer safe now that the header (A38) varies by
      // session: a shared/proxy cache serving one visitor's logged-in header to the next
      // anonymous one would be a real leak, however unlikely on this app's current single-VPS
      // deployment. The legal *content* itself is still static; only the caching directive changed.
      reply.header('Cache-Control', 'private, max-age=0');
      reply.type('text/html').send(legalPage(title, req.user, req.caps));
    });
  }

  app.get('/robots.txt', async (_req, reply) => {
    reply.type('text/plain').send('User-agent: *\nAllow: /\nSitemap: /sitemap.xml\n');
  });

  app.get('/sitemap.xml', async (_req, reply) => {
    const staticPaths = ['/', '/annonces', ...Object.keys(LEGAL_PAGES)];
    const urls = staticPaths
      .map((p) => `<url><loc>${escapeHtml(`${Config.publicBaseUrl}${p}`)}</loc></url>`)
      .join('');
    reply.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
  });

  app.get('/auth/discord', async (_req, reply) => {
    const { url, state } = oauth.buildAuthUrl();
    reply.setCookie(OAUTH_STATE_COOKIE, state, {
      signed: true,
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: oauth.STATE_TTL_MS / 1000,
      path: '/',
    });
    reply.redirect(url);
  });

  app.get('/auth/discord/callback', async (req, reply) => {
    const raw = req.cookies?.[OAUTH_STATE_COOKIE];
    const unsigned = raw ? req.unsignCookie(raw) : null;
    reply.clearCookie(OAUTH_STATE_COOKIE);

    try {
      const { user } = await withTransaction(pool, (tx) =>
        oauth.handleCallback(tx, {
          code: req.query.code,
          state: req.query.state,
          expectedState: unsigned?.valid ? unsigned.value : null,
        }),
      );
      const { id, csrfSecret, expiresAt } = await session.createSession(pool, user.id);
      reply.setCookie(session.SESSION_COOKIE, id, {
        signed: true,
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        expires: expiresAt,
      });
      reply.header('X-Csrf-Token', session.issueCsrfToken(csrfSecret));
      reply.redirect('/tableau-de-bord');
    } catch (err) {
      req.log.warn({ err }, 'oauth callback failed');
      reply.code(400).type('text/html').send(layout({ title: 'Connexion échouée', user: req.user, caps: req.caps, body: '<h1>Connexion échouée</h1>' }));
    }
  });

  app.post('/auth/logout', async (req, reply) => {
    const raw = req.cookies?.[session.SESSION_COOKIE];
    const unsigned = raw ? req.unsignCookie(raw) : null;
    if (unsigned?.valid) {
      await session.destroySession(pool, unsigned.value);
    }
    reply.clearCookie(session.SESSION_COOKIE);
    reply.redirect('/');
  });

  app.get('/', async (req, reply) => {
    const { page, guildById, userById } = await withTransaction(pool, async (tx) => {
      const p = await listings.listPublic(tx, {}, {});
      return { page: p, ...(await lookupMaps(tx, p.items)) };
    });

    reply.header('Cache-Control', 'private, max-age=0');
    reply.type('text/html').send(
      layout({
        title: 'Accueil',
        user: req.user,
        caps: req.caps,
        body: `<h1>Xyro Market</h1>
<p>Échangez ou donnez votre serveur Discord. <a href="/annonces">Rechercher / filtrer les annonces</a></p>
<h2>Annonces</h2>
${listingsListHtml(page.items, { guildById, userById })}
${page.cursor ? `<p><a href="/annonces?cursor=${encodeURIComponent(page.cursor)}">Voir plus</a></p>` : ''}`,
      }),
    );
  });

  app.get('/annonces', async (req, reply) => {
    const { tags, mode, q, search, cursor } = req.query;
    if (typeof search === 'string' && search.trim().length > 0) {
      const term = search.trim().toLowerCase();
      const { hits, guildById, userById, userHits } = await withTransaction(pool, async (tx) => {
        const [h, uh] = await Promise.all([
          listingsRepo.search(tx, term, { status: 'active', limit: 20 }),
          usersRepo.searchByUsername(tx, term, { limit: 10 }),
        ]);
        return { hits: h, userHits: uh, ...(await lookupMaps(tx, h)) };
      });
      reply.header('Cache-Control', 'private, max-age=0');
      return reply.type('text/html').send(
        layout({
          title: 'Recherche',
          user: req.user,
        caps: req.caps,
          searchQuery: search.trim(),
          body: `<h1>Recherche : ${escapeHtml(search.trim())}</h1>
<h2>Utilisateurs (${userHits.length})</h2>
${
  userHits.length === 0
    ? '<p>Aucun.</p>'
    : `<ul>${userHits.map((u) => `<li>${userAvatarHtml(u)}<a href="/u/${u.id}">${escapeHtml(u.username)}</a>${u.isVerified ? ` ${verifiedBadgeHtml()}` : ''}</li>`).join('')}</ul>`
}
<h2>Annonces (${hits.length})</h2>
${listingsListHtml(hits, { guildById, userById })}`,
        }),
      );
    }
    const filters = {
      tags: typeof tags === 'string' && tags.length > 0 ? tags.split(',') : undefined,
      mode: mode === 'don' || mode === 'echange' ? mode : undefined,
      q: typeof q === 'string' && q.length > 0 ? q : undefined,
    };
    const { page, guildById, userById } = await withTransaction(pool, async (tx) => {
      const p = await listings.listPublic(tx, filters, { cursor });
      return { page: p, ...(await lookupMaps(tx, p.items)) };
    });

    reply.header('Cache-Control', 'private, max-age=0');
    reply.type('text/html').send(
      layout({
        title: 'Annonces',
        user: req.user,
        caps: req.caps,
        body: `<h1>Annonces</h1>
${listingsListHtml(page.items, { guildById, userById })}
${page.cursor ? `<p><a href="/annonces?cursor=${encodeURIComponent(page.cursor)}">Suivant</a></p>` : ''}`,
      }),
    );
  });

  /**
   * Contact happens only through the matching flow (M5, O2 — no DM relay, no direct
   * messaging on the site): join the file d'attente for a `don`, or manually propose
   * a direct swap for an `echange` (A19 — replaces the old automatic TTC discovery,
   * find a compatible listing yourself via `/annonces?mode=echange&tags=...`) — the
   * bot opens a private hub thread only once the two sides are actually matched.
   */
  app.get('/annonces/:id', async (req, reply) => {
    const result = await withTransaction(pool, async (tx) => {
      const listing = await listingsRepo.findById(tx, req.params.id);
      if (!listing || listing.status === 'hidden' || listing.status === 'removed') return null;
      const [guild, owner] = await Promise.all([
        guildsRepo.findById(tx, listing.guildId),
        usersRepo.findById(tx, listing.userId),
      ]);
      const isOwner = req.user?.id === listing.userId;
      const alreadyQueued =
        req.user && !isOwner && listing.mode === 'don'
          ? Boolean(await listingQueueRepo.findActiveEntry(tx, listing.id, req.user.id))
          : false;
      // Candidates to offer in a swap: my own active `echange` listings, elsewhere.
      const myEchangeListings =
        req.user && !isOwner && listing.mode === 'echange'
          ? (await listingsRepo.listByUser(tx, req.user.id, { limit: 50 })).items.filter(
              (l) => l.mode === 'echange' && l.status === 'active' && l.id !== listing.id,
            )
          : [];
      return { listing, guild, owner, isOwner, alreadyQueued, myEchangeListings };
    });
    if (!result) {
      return notFoundPage(reply, 'Cette annonce n\'existe pas, ou a été retirée par son propriétaire.', req.user, req.caps);
    }
    const { listing, guild, owner, isOwner, alreadyQueued, myEchangeListings } = result;

    let contactSection;
    if (isOwner) {
      contactSection = `<p>C'est ton annonce. <a href="/annonces/${listing.id}/modifier">Modifier</a> · <a href="/tableau-de-bord">Retirer</a></p>`;
    } else if (!req.user) {
      contactSection = `<p><a href="/auth/discord">Se connecter avec Discord</a> pour manifester ton intérêt.</p>`;
    } else if (listing.mode === 'echange') {
      const csrfToken = session.issueCsrfToken(req.csrfSecret);
      contactSection =
        myEchangeListings.length === 0
          ? `<p>Pour proposer un échange, publie d'abord ta propre annonce en mode "échange" — <a href="/annonces/nouvelle">créer une annonce</a>.</p>`
          : `<form method="POST" action="/annonces/${listing.id}/echanger">
<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
<label for="myListingId">Proposer en échange :</label>
<select id="myListingId" name="myListingId" required>
${myEchangeListings.map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.description.slice(0, 60))}</option>`).join('')}
</select>
<button type="submit">Proposer cet échange</button>
</form>
<p>Pas de message direct : si le propriétaire accepte, une discussion privée s'ouvre automatiquement sur le serveur hub Discord.</p>`;
    } else if (alreadyQueued) {
      const csrfToken = session.issueCsrfToken(req.csrfSecret);
      contactSection = `<p>Tu es déjà dans la file d'attente pour cette annonce.</p>
<form method="POST" action="/annonces/${listing.id}/file/quitter">
<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
<button type="submit">Me retirer de la file</button>
</form>`;
    } else {
      const csrfToken = session.issueCsrfToken(req.csrfSecret);
      contactSection = `<form method="POST" action="/annonces/${listing.id}/file">
<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
<button type="submit">Je suis intéressé(e)</button>
</form>
<p>Pas de message direct : le propriétaire choisit dans l'ordre d'arrivée, et une discussion privée s'ouvre automatiquement sur le serveur hub Discord une fois sélectionné(e).</p>`;
    }

    reply.header('Cache-Control', 'private, max-age=0');
    reply.type('text/html').send(
      layout({
        title: guild?.name || 'Annonce',
        user: req.user,
        caps: req.caps,
        body: `<h1>${guildIconHtml(guild)}${escapeHtml(guild?.name || listing.guildId)}</h1>
<p><span class="pill">${listing.mode === 'don' ? 'Don' : 'Échange'}</span>${owner ? ` publiée par ${userAvatarHtml(owner)}<a href="/u/${owner.id}">${escapeHtml(owner.username)}</a>` : ''}</p>
<p>${escapeHtml(listing.description)}</p>
<p>${listing.tags.map(pillHtml).join('')}</p>
${listing.mode === 'echange' ? `<p><strong>Recherché :</strong> ${listing.seekingTags.map(pillHtml).join('')}</p>` : ''}
<p>Taille de la communauté (informatif) : ${guild?.memberCountCached ?? 'inconnue'}</p>
${contactSection}`,
      }),
    );
  });

  app.get('/u/:id', async (req, reply) => {
    const result = await withTransaction(pool, async (tx) => {
      const user = await usersRepo.findById(tx, req.params.id);
      if (!user || user.deletedAt) return null;
      const [aggregate, activeListings, reviewPage] = await Promise.all([
        reputation.aggregate(tx, user.id),
        listingsRepo.listByUser(tx, user.id, { status: 'active', limit: 50 }),
        reputation.history(tx, user.id, { limit: 10 }),
      ]);
      const guilds = await guildsRepo.findByIds(tx, [...new Set(activeListings.items.map((l) => l.guildId))]);
      const guildsWithColor = await attachAvgColors(guilds);
      const authors = await usersRepo.findByIds(tx, [...new Set(reviewPage.items.map((r) => r.authorId))]);
      return {
        user,
        aggregate,
        listings: activeListings.items,
        guildById: new Map(guildsWithColor.map((g) => [g.id, g])),
        reviews: reviewPage.items,
        authorById: new Map(authors.map((a) => [a.id, a])),
      };
    });
    if (!result) {
      return notFoundPage(reply, 'Ce profil n\'existe pas, ou son compte a été supprimé.', req.user, req.caps);
    }
    const { user, aggregate, listings, guildById, reviews, authorById } = result;
    reply.type('text/html').send(
      layout({
        title: user.username,
        user: req.user, // the visitor's own session (header nav) — distinct from the `user` being viewed below
        caps: req.caps,
        // No raw discord_id shown as text on a public profile — userAvatarHtml/userBannerUrl only
        // ever use it inside a CDN image URL, structurally required, never as visible text.
        body: `<div class="profile-header">
<div class="profile-banner">${bannerImgHtml(userBannerUrl(user, 600))}</div>
<div class="profile-identity">
${userAvatarHtml(user, { requestSize: 256 })}
<h1>${escapeHtml(user.username)}${user.isVerified ? ` ${verifiedBadgeHtml()}` : ''}</h1>
</div>
<div class="profile-body">
<p>${starsHtml(Math.round(aggregate.average ?? 0))} ${aggregate.count} avis${aggregate.average != null ? ` (moyenne ${aggregate.average.toFixed(1)}/5)` : ''}</p>
</div>
</div>
<h2>Serveurs (${listings.length})</h2>
${
  listings.length === 0
    ? '<p>Aucune annonce active pour l\'instant.</p>'
    : `<ul class="cards">${listings.map((l) => listingCardHtml(l, { guild: guildById.get(l.guildId) })).join('')}</ul>`
}
<h2>Avis (${aggregate.count})</h2>
${
  reviews.length === 0
    ? '<p>Aucun avis pour l\'instant.</p>'
    : `<ul>${reviews.map((r) => reviewHtml(r, authorById.get(r.authorId))).join('')}</ul>`
}`,
      }),
    );
  });
}
