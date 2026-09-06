import { withTransaction } from '../../db/pool.js';
import { Config } from '../../config/env.js';
import * as listings from '../../domain/listings.js';
import * as reputation from '../../domain/reputation.js';
import { usersRepo } from '../../db/repositories/usersRepo.js';
import { guildsRepo } from '../../db/repositories/guildsRepo.js';
import { listingsRepo } from '../../db/repositories/listingsRepo.js';
import { layout, legalPage, escapeHtml } from '../render.js';
import * as oauth from '../auth/oauth.js';
import * as session from '../auth/session.js';

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
 * Showcase, public listing search and every legal page (M8). No mutation
 * lives here — every route is a GET, and a hidden/removed listing 404s
 * rather than leaking a partial view.
 */
export default async function publicRoutes(app, { pool }) {
  for (const [path, title] of Object.entries(LEGAL_PAGES)) {
    app.get(path, async (_req, reply) => {
      reply.header('Cache-Control', 'public, max-age=3600');
      reply.type('text/html').send(legalPage(title));
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
      reply.code(400).type('text/html').send(layout({ title: 'Connexion échouée', body: '<h1>Connexion échouée</h1>' }));
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

  app.get('/', { preHandler: [session.tryAuth(pool)] }, async (req, reply) => {
    const accountLine = req.user
      ? `Connecté en tant que <strong>${escapeHtml(req.user.username)}</strong> ·
         <a href="/tableau-de-bord">Mon tableau de bord</a> ·
         <form method="POST" action="/auth/logout" style="display:inline">
           <button type="submit">Se déconnecter</button>
         </form>`
      : `<a href="/auth/discord">Se connecter avec Discord</a>`;

    reply.type('text/html').send(
      layout({
        title: 'Accueil',
        body: `<h1>Xyro Market</h1>
<p>Échangez ou donnez votre serveur Discord.</p>
<p><a href="/annonces">Voir les annonces</a> · ${accountLine}</p>`,
      }),
    );
  });

  app.get('/annonces', async (req, reply) => {
    const { tags, mode, q, cursor } = req.query;
    const filters = {
      tags: typeof tags === 'string' && tags.length > 0 ? tags.split(',') : undefined,
      mode: mode === 'don' || mode === 'echange' ? mode : undefined,
      q: typeof q === 'string' && q.length > 0 ? q : undefined,
    };
    const page = await withTransaction(pool, (tx) => listings.listPublic(tx, filters, { cursor }));

    reply.header('Cache-Control', 'private, max-age=0');
    reply.type('text/html').send(
      layout({
        title: 'Annonces',
        body: `<h1>Annonces</h1><ul>${page.items
          .map(
            (l) =>
              `<li><a href="/annonces/${l.id}">${escapeHtml(l.description.slice(0, 80))}</a> — ${escapeHtml(l.mode)}</li>`,
          )
          .join('')}</ul>${page.cursor ? `<a href="/annonces?cursor=${encodeURIComponent(page.cursor)}">Suivant</a>` : ''}`,
      }),
    );
  });

  app.get('/annonces/:id', async (req, reply) => {
    const result = await withTransaction(pool, async (tx) => {
      const listing = await listingsRepo.findById(tx, req.params.id);
      if (!listing || listing.status === 'hidden' || listing.status === 'removed') return null;
      const guild = await guildsRepo.findById(tx, listing.guildId);
      return { listing, guild };
    });
    if (!result) {
      return reply.code(404).type('text/html').send(layout({ title: 'Introuvable', body: '<h1>404</h1>' }));
    }
    const { listing, guild } = result;
    reply.header('Cache-Control', 'private, max-age=0');
    reply.type('text/html').send(
      layout({
        title: 'Annonce',
        body: `<h1>${escapeHtml(listing.mode)}</h1>
<p>${escapeHtml(listing.description)}</p>
<p>Tags : ${listing.tags.map(escapeHtml).join(', ')}</p>
${listing.mode === 'echange' ? `<p>Recherché : ${listing.seekingTags.map(escapeHtml).join(', ')}</p>` : ''}
<p>Taille de la communauté (informatif) : ${guild?.memberCountCached ?? 'inconnue'}</p>`,
      }),
    );
  });

  app.get('/u/:id', async (req, reply) => {
    const result = await withTransaction(pool, async (tx) => {
      const user = await usersRepo.findById(tx, req.params.id);
      if (!user || user.deletedAt) return null;
      const aggregate = await reputation.aggregate(tx, user.id);
      return { user, aggregate };
    });
    if (!result) {
      return reply.code(404).type('text/html').send(layout({ title: 'Introuvable', body: '<h1>404</h1>' }));
    }
    const { user, aggregate } = result;
    reply.type('text/html').send(
      layout({
        title: user.username,
        // No raw discord_id on a public profile — internal id only.
        body: `<h1>${escapeHtml(user.username)}${user.isVerified ? ' ✓ Vérifié' : ''}</h1>
<p>Avis : ${aggregate.count} (moyenne ${aggregate.average ?? 'N/A'})</p>`,
      }),
    );
  });
}
