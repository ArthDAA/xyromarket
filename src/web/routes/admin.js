import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { withTransaction } from '../../db/pool.js';
import { requireAuth, requirePermission, requireCsrf, issueCsrfToken } from '../auth/session.js';
import { mapDomainError } from '../errorMapping.js';
import { layout, escapeHtml } from '../render.js';
import * as listings from '../../domain/listings.js';
import * as moderation from '../../domain/moderation.js';
import * as rbac from '../../domain/rbac.js';
import * as disputeDomain from '../../domain/dispute.js';
import * as audit from '../../domain/audit.js';
import * as stats from '../../domain/stats.js';
import { usersRepo } from '../../db/repositories/usersRepo.js';
import { guildsRepo } from '../../db/repositories/guildsRepo.js';
import { listingsRepo } from '../../db/repositories/listingsRepo.js';
import { reportsRepo } from '../../db/repositories/reportsRepo.js';
import { reviewsRepo } from '../../db/repositories/reviewsRepo.js';
import { rbacRepo } from '../../db/repositories/rbacRepo.js';
import { sanctionsRepo } from '../../db/repositories/sanctionsRepo.js';
import { transactionsRepo } from '../../db/repositories/transactionsRepo.js';
import { disputesRepo } from '../../db/repositories/disputesRepo.js';
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

/** Human-readable French text for domain/RBAC errors an admin acting from a form can actually understand. */
const ADMIN_ERROR_MESSAGES = {
  ERR_FORBIDDEN: 'Tu n\'as pas la permission nécessaire pour effectuer cette action.',
  ERR_ESCALATION: 'Tu ne peux pas accorder un rôle ou une permission que tu ne possèdes pas toi-même.',
  ERR_LAST_OWNER: 'Impossible de retirer le rôle "Propriétaire" au dernier compte qui le détient.',
  ERR_SELF_SANCTION: 'Tu ne peux pas te sanctionner toi-même.',
  ERR_ALREADY_SANCTIONED: 'Une sanction de ce type est déjà active pour cet utilisateur.',
  ERR_TARGET_MISSING: 'Utilisateur cible introuvable.',
  NOT_FOUND: 'Introuvable.',
  ERR_LISTING_LOCKED: 'Cette annonce est engagée dans une transaction en cours.',
  ERR_DUPLICATE_DISPUTE: 'Un litige est déjà ouvert pour cette transaction.',
  ERR_WINDOW_CLOSED: 'Le délai pour ouvrir un litige est dépassé.',
  ERR_NOT_TRANSFERRED: 'Cette transaction n\'a pas encore été transférée.',
  ERR_NOT_PARTY: 'Acteur non partie à cette transaction.',
  ERR_SETTING_INVALID: 'Valeur de réglage invalide.',
  ERR_UNKNOWN_METRIC: 'Métrique inconnue.',
  ERR_RANGE_TOO_WIDE: 'Plage de dates trop large pour cette granularité.',
  ERR_CSRF: 'Jeton de sécurité invalide ou expiré — recharge la page et réessaie.',
};

/** A plain HTML `<form>` (no fetch/JS) always posts this content type — same signal as `web/routes/user.js`. */
function isFormSubmission(req) {
  return Boolean(req.headers['content-type']?.includes('application/x-www-form-urlencoded'));
}

/** Browser navigation (GET) and plain `<form>` POSTs both want HTML back; only an explicit `Accept: application/json` gets JSON. */
function wantsJson(req) {
  return Boolean(req.headers.accept?.includes('application/json'));
}

function adminLayout({ title, body, user, caps }) {
  return layout({
    title: `Admin — ${title}`,
    user,
    caps,
    noindex: true,
    body: `<p><a href="/admin">← Panel admin</a></p>${body}`,
  });
}

function renderFormError(reply, message, status = 422, user, caps) {
  return reply.code(status).type('text/html').send(
    adminLayout({
      title: 'Erreur',
      user,
      caps,
      body: `<h1>Une erreur est survenue</h1><p>${escapeHtml(message)}</p>`,
    }),
  );
}

function withAccept(handler) {
  return async (req, reply) => {
    try {
      return await handler(req, reply);
    } catch (err) {
      if (err instanceof z.ZodError) {
        const message = err.issues.map((i) => i.message).join(' — ');
        if (wantsJson(req)) return reply.code(422).send({ error: 'ERR_VALIDATION', issues: err.issues });
        return renderFormError(reply, message, 422, req.user, req.caps);
      }
      const correlationId = randomUUID();
      const mapped = mapDomainError(err, correlationId);
      if (mapped.status === 500) req.log.error({ err, correlationId }, 'unexpected admin error');
      if (wantsJson(req)) return reply.code(mapped.status).send(mapped.body);
      const message = ADMIN_ERROR_MESSAGES[err?.code] ?? `${err?.code ?? 'ERR_UNEXPECTED'} — ${err?.message ?? ''}`;
      return renderFormError(reply, message, mapped.status, req.user, req.caps);
    }
  };
}

const SANCTION_LABELS = { ban_temp: 'Ban temporaire', ban_perm: 'Ban définitif', suspend: 'Suspension', warn: 'Avertissement' };
const REPORT_STATUS_LABELS = { open: 'Ouvert', assigned: 'Assigné', resolved: 'Résolu', stale: 'Périmé' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SNOWFLAKE_RE = /^\d{17,20}$/;

/** `actorId`/`targetId` are sometimes a literal token (`'bot'`, `'system'`) rather than a real user row — only linkify an actual UUID. */
function targetLink(targetType, targetId) {
  const id = escapeHtml(targetId ?? '');
  if (!targetId || !UUID_RE.test(targetId)) return id;
  if (targetType === 'user') return `<a href="/admin/users/${id}">${id}</a>`;
  if (targetType === 'listing') return `<a href="/admin/listings">${id}</a> (annonce)`;
  return id;
}

function csrfField(token) {
  return `<input type="hidden" name="_csrf" value="${escapeHtml(token)}">`;
}

/** `URLSearchParams` stringifies `undefined` as the literal text "undefined" — drop empty entries first. */
function paginationLinks(basePath, query, cursor) {
  if (!cursor) return '';
  const clean = Object.fromEntries(Object.entries(query).filter(([, v]) => v != null && v !== ''));
  const params = new URLSearchParams(clean);
  params.set('cursor', cursor);
  return `<p><a href="${basePath}?${params.toString()}">Page suivante →</a></p>`;
}

/**
 * The 9 §2bis domains, each gated by a granular permission — an admin route
 * never tests a role name. Every mutation here is delegated to `src/domain/`,
 * which already writes its own `audit_log` entry in the same transaction;
 * this file adds no second audit write on top (except two reads-with-a-
 * side-effect, `reviews.hide` and `settings.set`, which have no domain
 * wrapper of their own and so audit inline, same as before this page layer
 * was added).
 *
 * Every GET here also serves HTML by default (browser navigation) and JSON
 * only on an explicit `Accept: application/json` — see `wantsJson`. Every
 * mutation accepts a plain `<form>` POST (redirects back, CSRF-protected,
 * no JS) alongside the original JSON body shape for API callers.
 */
export default async function adminRoutes(app, { pool }) {
  const guard = (permission) => [requireAuth(pool), requirePermission(pool, permission)];
  const csrf = requireCsrf();

  // --- Index ---
  app.get('/admin', { preHandler: requireAuth(pool) }, withAccept(async (req, reply) => {
    const caps = req.caps;
    const openReports = caps.has('reports.read') ? await withTransaction(pool, (tx) => reportsRepo.countOpen(tx)) : null;
    const links = [
      ['reports.read', '/admin/reports', 'Signalements (point d\'entrée pour trouver un utilisateur/une annonce à examiner)'],
      ['listings.read', '/admin/listings', 'Annonces'],
      ['transactions.read', '/admin/transactions', 'Transactions'],
      ['rbac.read', '/admin/rbac', 'Rôles et permissions'],
      ['settings.read', '/admin/settings', 'Réglages du site'],
      ['stats.read', '/admin/stats', 'Statistiques'],
      ['audit.read', '/admin/audit', 'Journal d\'audit'],
    ].filter(([perm]) => caps.has(perm));

    reply.type('text/html').send(
      adminLayout({ user: req.user, caps: req.caps,
        title: 'Panel admin',
        body: `<h1>Panel admin</h1>
<form method="GET" action="/admin/search">
<label>Rechercher un utilisateur, un alias, un serveur ou un tag <input type="text" name="q" required></label>
<button type="submit">Chercher</button>
</form>
${openReports !== null ? `<p><strong>${openReports}</strong> signalement(s) ouvert(s).</p>` : ''}
<ul>${links.map(([, href, label]) => `<li><a href="${href}">${escapeHtml(label)}</a></li>`).join('')}</ul>`,
      }),
    );
  }));

  /**
   * Free-text lookup (A28) — the panel's only other entry point to a user
   * or guild used to be a signalement/annonce/audit row. Each result
   * category is shown only if the caller holds the matching `*.read`
   * capability — same rule as the index's own link list above.
   */
  app.get('/admin/search', { preHandler: requireAuth(pool) }, withAccept(async (req, reply) => {
    const term = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!term) return reply.redirect('/admin', 303);
    const caps = req.caps;

    const data = await withTransaction(pool, async (tx) => {
      const [exactUserById, exactUserByDiscordId, exactGuildById, users, guilds, listingHits] = await Promise.all([
        caps.has('users.read') && UUID_RE.test(term) ? usersRepo.findById(tx, term) : null,
        caps.has('users.read') && SNOWFLAKE_RE.test(term) ? usersRepo.findByDiscordId(tx, term) : null,
        caps.has('listings.read') && SNOWFLAKE_RE.test(term) ? guildsRepo.findById(tx, term) : null,
        caps.has('users.read') ? usersRepo.searchByUsername(tx, term, { limit: 20 }) : [],
        caps.has('listings.read') ? guildsRepo.searchByName(tx, term, { limit: 20 }) : [],
        caps.has('listings.read') ? listingsRepo.search(tx, term.toLowerCase(), { limit: 20 }) : [],
      ]);
      const exactUsers = [exactUserById, exactUserByDiscordId].filter(Boolean);
      const byId = new Map(exactUsers.map((u) => [u.id, u]));
      for (const u of users) byId.set(u.id, u);
      // `listingHits` includes tag matches (A29: "flags"/tags a server carries via its current
      // live listing, e.g. searching "gaming" finds every server whose active annonce is tagged
      // gaming) — fetched here so each hit shows *which server* it matched on, not just its id.
      const hitGuilds = listingHits.length > 0 ? await guildsRepo.findByIds(tx, [...new Set(listingHits.map((l) => l.guildId))]) : [];
      const hitGuildById = new Map(hitGuilds.map((g) => [g.id, g]));
      return {
        users: [...byId.values()],
        guilds: exactGuildById ? [exactGuildById, ...guilds.filter((g) => g.id !== exactGuildById.id)] : guilds,
        listingHits,
        hitGuildById,
      };
    });

    reply.type('text/html').send(
      adminLayout({ user: req.user, caps: req.caps,
        title: `Recherche — ${term}`,
        body: `<h1>Recherche : ${escapeHtml(term)}</h1>
<form method="GET" action="/admin/search">
<input type="text" name="q" value="${escapeHtml(term)}" required>
<button type="submit">Chercher</button>
</form>
<h2>Utilisateurs (${data.users.length})</h2>
${
  data.users.length === 0
    ? '<p>Aucun.</p>'
    : `<ul>${data.users.map((u) => `<li><a href="/admin/users/${u.id}">${escapeHtml(u.username)}</a> — ${escapeHtml(u.discordId)}</li>`).join('')}</ul>`
}
<h2>Serveurs (${data.guilds.length})</h2>
${
  data.guilds.length === 0
    ? '<p>Aucun.</p>'
    : `<ul>${data.guilds.map((g) => `<li><a href="/admin/listings?guildId=${g.id}">${escapeHtml(g.name || g.id)}</a> — ${escapeHtml(g.id)}</li>`).join('')}</ul>`
}
<h2>Serveurs par annonce (tag, nom de serveur ou pseudo propriétaire correspondant) — ${data.listingHits.length}</h2>
${
  data.listingHits.length === 0
    ? '<p>Aucun.</p>'
    : `<ul>${data.listingHits
        .map((l) => {
          const guild = data.hitGuildById.get(l.guildId);
          return `<li><a href="/admin/listings?guildId=${l.guildId}">${escapeHtml(guild?.name || l.guildId)}</a> — ${escapeHtml(l.description.slice(0, 60))} (tags : ${l.tags.map(escapeHtml).join(', ') || '—'}) — ${escapeHtml(l.status)} — <a href="/admin/users/${l.userId}">${escapeHtml(l.userId)}</a></li>`;
        })
        .join('')}</ul>`
}`,
      }),
    );
  }));

  // --- Utilisateurs ---
  app.get('/admin/users/:id', { preHandler: guard('users.read') }, withAccept(async (req, reply) => {
    const data = await withTransaction(pool, async (tx) => {
      const user = await usersRepo.findById(tx, req.params.id);
      if (!user) return null;
      const [sanctions, roleKeys, allRoles, allPermissions, directGrants, directRevocations] = await Promise.all([
        sanctionsRepo.listByUser(tx, req.params.id, { limit: 50 }),
        rbacRepo.getRoleKeysForUser(tx, req.params.id),
        rbacRepo.listRoles(tx),
        rbacRepo.listPermissions(tx),
        rbacRepo.getDirectGrants(tx, req.params.id),
        rbacRepo.getDirectRevocations(tx, req.params.id),
      ]);
      return { user, sanctions, roleKeys, allRoles, allPermissions, directGrants, directRevocations };
    });
    if (!data) {
      if (wantsJson(req)) return reply.code(404).send({ error: 'NOT_FOUND' });
      return reply.code(404).type('text/html').send(adminLayout({ user: req.user, caps: req.caps, title: 'Introuvable', body: '<h1>404</h1><p>Utilisateur introuvable.</p>' }));
    }
    if (wantsJson(req)) return reply.send({ user: data.user });

    const { user, sanctions, roleKeys, allRoles, allPermissions, directGrants, directRevocations } = data;
    const csrfToken = issueCsrfToken(req.csrfSecret);
    const activeSanctions = sanctions.items.filter((s) => !s.revokedAt && (!s.endsAt || new Date(s.endsAt) > new Date()));

    reply.type('text/html').send(
      adminLayout({ user: req.user, caps: req.caps,
        title: user.username,
        body: `<h1>${escapeHtml(user.username)}</h1>
<p>Discord ID : ${escapeHtml(user.discordId)} · Vérifié : ${user.isVerified ? 'oui' : 'non'} · Banni définitivement : ${user.bannedPermanently ? 'oui' : 'non'}${user.bannedUntil ? ` · Banni jusqu'au ${escapeHtml(new Date(user.bannedUntil).toLocaleString('fr-FR'))}` : ''}</p>

<h2>Sanctions actives</h2>
${
  activeSanctions.length === 0
    ? '<p>Aucune.</p>'
    : `<ul>${activeSanctions
        .map(
          (s) => `<li>${escapeHtml(SANCTION_LABELS[s.kind] ?? s.kind)} — ${escapeHtml(s.reason)}${s.endsAt ? ` (jusqu'au ${escapeHtml(new Date(s.endsAt).toLocaleString('fr-FR'))})` : ''}
<form method="POST" action="/admin/sanctions/${s.id}/lift" class="inline">
${csrfField(csrfToken)}
<input type="text" name="reason" placeholder="Motif de la levée" required>
<button type="submit">Lever</button>
</form></li>`,
        )
        .join('')}</ul>`
}
<details><summary>Prononcer une sanction</summary>
<form method="POST" action="/admin/users/${user.id}/sanction">
${csrfField(csrfToken)}
<p><label>Type<br><select name="kind" required>
${Object.entries(SANCTION_LABELS).map(([k, label]) => `<option value="${k}">${escapeHtml(label)}</option>`).join('')}
</select></label></p>
<p><label>Motif<br><input type="text" name="reason" required></label></p>
<p><label>Durée en jours (laisser vide = illimité, ignoré pour un avertissement)<br><input type="number" name="durationDays" min="1"></label></p>
<p><button type="submit">Sanctionner</button></p>
</form></details>

<h2>Historique des sanctions (${sanctions.total})</h2>
${
  sanctions.items.length === 0
    ? '<p>Aucune.</p>'
    : `<table><tr><th>Type</th><th>Motif</th><th>Depuis</th><th>Fin</th><th>Levée</th></tr>
${sanctions.items
  .map(
    (s) => `<tr><td>${escapeHtml(SANCTION_LABELS[s.kind] ?? s.kind)}</td><td>${escapeHtml(s.reason)}</td><td>${escapeHtml(new Date(s.startsAt).toLocaleString('fr-FR'))}</td><td>${s.endsAt ? escapeHtml(new Date(s.endsAt).toLocaleString('fr-FR')) : '—'}</td><td>${s.revokedAt ? escapeHtml(new Date(s.revokedAt).toLocaleString('fr-FR')) : '—'}</td></tr>`,
  )
  .join('')}</table>`
}

<h2>Rôles</h2>
<ul>${roleKeys
  .map(
    (key) => `<li>${escapeHtml(allRoles.find((r) => r.key === key)?.label ?? key)}
<form method="POST" action="/admin/users/${user.id}/roles/${encodeURIComponent(key)}/retirer" class="inline">
${csrfField(csrfToken)}
<button type="submit">Retirer</button>
</form></li>`,
  )
  .join('') || '<li>Aucun.</li>'}</ul>
<details><summary>Attribuer un rôle</summary>
<form method="POST" action="/admin/users/${user.id}/roles">
${csrfField(csrfToken)}
<p><label>Rôle<br><select name="roleKey" required>
${allRoles.filter((r) => !roleKeys.includes(r.key)).map((r) => `<option value="${escapeHtml(r.key)}">${escapeHtml(r.label)}</option>`).join('')}
</select></label></p>
<p><button type="submit">Attribuer</button></p>
</form></details>

<h2>Permissions accordées directement (hors rôle)</h2>
<ul>${directGrants
  .map(
    (key) => `<li>${escapeHtml(allPermissions.find((p) => p.key === key)?.label ?? key)}
<form method="POST" action="/admin/users/${user.id}/permissions/${encodeURIComponent(key)}/retirer" class="inline">
${csrfField(csrfToken)}
<button type="submit">Retirer</button>
</form></li>`,
  )
  .join('') || '<li>Aucune.</li>'}</ul>
${directRevocations.length > 0 ? `<p>Révoquées explicitement (retirent une permission normalement héritée d'un rôle) : ${directRevocations.map((k) => escapeHtml(allPermissions.find((p) => p.key === k)?.label ?? k)).join(', ')}</p>` : ''}
<details><summary>Accorder une permission directe</summary>
<form method="POST" action="/admin/users/${user.id}/permissions">
${csrfField(csrfToken)}
<p><label>Permission<br><select name="permissionKey" required>
${allPermissions.map((p) => `<option value="${escapeHtml(p.key)}">${escapeHtml(p.label)}</option>`).join('')}
</select></label></p>
<p><button type="submit">Accorder</button></p>
</form></details>`,
      }),
    );
  }));

  app.post('/admin/users/:id/sanction', { preHandler: [...guard('moderation.sanction'), csrf] }, withAccept(async (req, reply) => {
    const raw = isFormSubmission(req)
      ? {
          kind: req.body.kind,
          reason: req.body.reason,
          endsAt: req.body.durationDays ? new Date(Date.now() + Number(req.body.durationDays) * 86_400_000).toISOString() : undefined,
        }
      : req.body;
    const body = sanctionSchema.parse(raw);
    const sanction = await withTransaction(pool, (tx) => moderation.sanction(tx, req.user.id, req.params.id, body));
    if (isFormSubmission(req)) return reply.redirect(`/admin/users/${req.params.id}`, 303);
    reply.code(201).send({ sanction });
  }));

  app.post('/admin/sanctions/:id/lift', { preHandler: [...guard('moderation.sanction'), csrf] }, withAccept(async (req, reply) => {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';
    const sanction = await withTransaction(pool, (tx) => moderation.lift(tx, req.user.id, req.params.id, reason));
    if (isFormSubmission(req)) return reply.redirect(`/admin/users/${sanction.userId}`, 303);
    reply.send({ sanction });
  }));

  app.post('/admin/users/:id/roles', { preHandler: [...guard('rbac.grant'), csrf] }, withAccept(async (req, reply) => {
    const { roleKey } = roleAssignSchema.parse(req.body);
    await withTransaction(pool, (tx) => rbac.assignRole(tx, req.user.id, req.params.id, roleKey));
    if (isFormSubmission(req)) return reply.redirect(`/admin/users/${req.params.id}`, 303);
    reply.code(204).send();
  }));

  app.delete('/admin/users/:id/roles/:roleKey', { preHandler: [...guard('rbac.grant'), csrf] }, withAccept(async (req, reply) => {
    await withTransaction(pool, (tx) => rbac.revokeRole(tx, req.user.id, req.params.id, req.params.roleKey));
    reply.code(204).send();
  }));

  /** Form-friendly equivalent of `DELETE /admin/users/:id/roles/:roleKey` — a plain `<form>` can't submit DELETE. */
  app.post('/admin/users/:id/roles/:roleKey/retirer', { preHandler: [...guard('rbac.grant'), csrf] }, withAccept(async (req, reply) => {
    await withTransaction(pool, (tx) => rbac.revokeRole(tx, req.user.id, req.params.id, req.params.roleKey));
    return reply.redirect(`/admin/users/${req.params.id}`, 303);
  }));

  // --- Annonces ---
  app.get('/admin/listings', { preHandler: guard('listings.read') }, withAccept(async (req, reply) => {
    const guildId = req.query.guildId || undefined;
    const page = await withTransaction(pool, (tx) =>
      listingsRepo.listForModeration(tx, { status: req.query.status || undefined, guildId }, { cursor: req.query.cursor }),
    );
    if (wantsJson(req)) return reply.send(page);
    const csrfToken = issueCsrfToken(req.csrfSecret);
    const statuses = ['active', 'pending_bot', 'matched', 'fulfilled', 'hidden', 'removed'];

    reply.type('text/html').send(
      adminLayout({ user: req.user, caps: req.caps,
        title: 'Annonces',
        body: `<h1>Annonces (${page.total})</h1>
${guildId ? `<p>Filtré sur la guilde ${escapeHtml(guildId)} — <a href="/admin/listings">retirer ce filtre</a></p>` : ''}
<form method="GET" action="/admin/listings">
${guildId ? `<input type="hidden" name="guildId" value="${escapeHtml(guildId)}">` : ''}
<label>Statut <select name="status">
<option value="">Tous</option>
${statuses.map((s) => `<option value="${s}"${req.query.status === s ? ' selected' : ''}>${escapeHtml(s)}</option>`).join('')}
</select></label>
<button type="submit">Filtrer</button>
</form>
<table><tr><th>Description</th><th>Mode</th><th>Statut</th><th>Propriétaire</th><th>Action</th></tr>
${page.items
  .map(
    (l) => `<tr><td>${escapeHtml(l.description.slice(0, 60))}</td><td>${escapeHtml(l.mode)}</td><td>${escapeHtml(l.status)}</td><td><a href="/admin/users/${l.userId}">${escapeHtml(l.userId)}</a></td><td>
${
  l.status === 'hidden'
    ? `<form method="POST" action="/admin/listings/${l.id}/restore" class="inline">${csrfField(csrfToken)}<button type="submit">Restaurer</button></form>`
    : l.status === 'active' || l.status === 'pending_bot'
      ? `<form method="POST" action="/admin/listings/${l.id}/hide" class="inline">${csrfField(csrfToken)}<button type="submit">Masquer</button></form>`
      : '—'
}
</td></tr>`,
  )
  .join('')}
</table>
${paginationLinks('/admin/listings', { status: req.query.status, guildId }, page.cursor)}`,
      }),
    );
  }));

  app.post('/admin/listings/:id/hide', { preHandler: [...guard('listings.hide'), csrf] }, withAccept(async (req, reply) => {
    const listing = await withTransaction(pool, (tx) => listings.hide(tx, req.user.id, req.params.id));
    if (isFormSubmission(req)) return reply.redirect('/admin/listings', 303);
    reply.send({ listing });
  }));

  app.post('/admin/listings/:id/restore', { preHandler: [...guard('listings.hide'), csrf] }, withAccept(async (req, reply) => {
    const listing = await withTransaction(pool, (tx) => listings.restore(tx, req.user.id, req.params.id));
    if (isFormSubmission(req)) return reply.redirect('/admin/listings', 303);
    reply.send({ listing });
  }));

  // --- Modération / Signalements ---
  app.get('/admin/reports', { preHandler: guard('reports.read') }, withAccept(async (req, reply) => {
    const page = await withTransaction(pool, (tx) =>
      reportsRepo.listFiltered(tx, { status: req.query.status }, { cursor: req.query.cursor }),
    );
    if (wantsJson(req)) return reply.send(page);
    const csrfToken = issueCsrfToken(req.csrfSecret);

    reply.type('text/html').send(
      adminLayout({ user: req.user, caps: req.caps,
        title: 'Signalements',
        body: `<h1>Signalements (${page.total})</h1>
<form method="GET" action="/admin/reports">
<label>Statut <select name="status">
<option value="">Tous</option>
${Object.entries(REPORT_STATUS_LABELS).map(([k, label]) => `<option value="${k}"${req.query.status === k ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}
</select></label>
<button type="submit">Filtrer</button>
</form>
${page.items
  .map(
    (r) => `<div><p><strong>${escapeHtml(REPORT_STATUS_LABELS[r.status] ?? r.status)}</strong> — ${escapeHtml(r.reason)} — cible : ${targetLink(r.targetType, r.targetId)} (${escapeHtml(r.targetType)})</p>
<p>${escapeHtml(r.body ?? '')}</p>
<form method="POST" action="/admin/reports/${r.id}/assign" class="inline">
${csrfField(csrfToken)}
<input type="text" name="assigneeId" placeholder="UUID de l'assigné" required>
<button type="submit">Assigner</button>
</form>
<form method="POST" action="/admin/reports/${r.id}/resolve" class="inline">
${csrfField(csrfToken)}
<button type="submit">Résoudre</button>
</form>
<form method="POST" action="/admin/reports/${r.id}/notes" class="inline">
${csrfField(csrfToken)}
<input type="text" name="body" placeholder="Note interne" required>
<button type="submit">Ajouter une note</button>
</form>
<p><a href="/admin/audit?targetType=report&amp;action=report.note">Voir les notes de signalements dans l'audit</a> (pas filtré à ce signalement précis — l'audit ne se filtre pas par cible)</p>
<hr></div>`,
  )
  .join('') || '<p>Aucun signalement.</p>'}
${paginationLinks('/admin/reports', { status: req.query.status }, page.cursor)}`,
      }),
    );
  }));

  app.post('/admin/reports/:id/assign', { preHandler: [...guard('reports.assign'), csrf] }, withAccept(async (req, reply) => {
    const report = await withTransaction(pool, (tx) => moderation.assign(tx, req.user.id, req.params.id, req.body.assigneeId));
    if (isFormSubmission(req)) return reply.redirect('/admin/reports', 303);
    reply.send({ report });
  }));

  app.post('/admin/reports/:id/resolve', { preHandler: [...guard('reports.assign'), csrf] }, withAccept(async (req, reply) => {
    const report = await withTransaction(pool, (tx) => moderation.resolve(tx, req.user.id, req.params.id));
    if (isFormSubmission(req)) return reply.redirect('/admin/reports', 303);
    reply.send({ report });
  }));

  app.post('/admin/reports/:id/notes', { preHandler: [...guard('reports.assign'), csrf] }, withAccept(async (req, reply) => {
    await withTransaction(pool, (tx) => moderation.addNote(tx, req.user.id, req.params.id, req.body.body ?? ''));
    if (isFormSubmission(req)) return reply.redirect('/admin/reports', 303);
    reply.code(204).send();
  }));

  // --- Avis / Réputation ---
  app.get('/admin/reviews/:userId', { preHandler: guard('reviews.read') }, withAccept(async (req, reply) => {
    const page = await withTransaction(pool, (tx) => reviewsRepo.history(tx, req.params.userId, { cursor: req.query.cursor }));
    if (wantsJson(req)) return reply.send(page);
    const csrfToken = issueCsrfToken(req.csrfSecret);

    reply.type('text/html').send(
      adminLayout({ user: req.user, caps: req.caps,
        title: 'Avis reçus',
        body: `<h1>Avis reçus par <a href="/admin/users/${escapeHtml(req.params.userId)}">${escapeHtml(req.params.userId)}</a> (${page.total})</h1>
${page.items
  .map(
    (r) => `<div><p>${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)} — ${escapeHtml(r.body ?? '')}</p>
<form method="POST" action="/admin/reviews/${r.id}/hide">${csrfField(csrfToken)}<button type="submit">Masquer (frauduleux)</button></form>
<hr></div>`,
  )
  .join('') || '<p>Aucun avis.</p>'}
${paginationLinks(`/admin/reviews/${req.params.userId}`, {}, page.cursor)}`,
      }),
    );
  }));

  app.post('/admin/reviews/:id/hide', { preHandler: [...guard('reviews.delete'), csrf] }, withAccept(async (req, reply) => {
    const review = await withTransaction(pool, (tx) => reviewsRepo.hide(tx, req.params.id, req.user.id));
    await withTransaction(pool, (tx) =>
      audit.record(tx, { actorId: req.user.id, action: 'review.hidden', targetType: 'review', targetId: req.params.id }),
    );
    if (isFormSubmission(req)) return reply.redirect(review?.targetId ? `/admin/reviews/${review.targetId}` : '/admin', 303);
    reply.send({ review });
  }));

  // --- Permissions (RBAC) ---
  app.get('/admin/rbac/roles', { preHandler: guard('rbac.read') }, withAccept(async (req, reply) => {
    reply.send({ roles: await withTransaction(pool, (tx) => rbacRepo.listRoles(tx)) });
  }));

  app.get('/admin/rbac/permissions', { preHandler: guard('rbac.read') }, withAccept(async (req, reply) => {
    reply.send({ permissions: await withTransaction(pool, (tx) => rbacRepo.listPermissions(tx)) });
  }));

  /** Reference page — read-only. Mutations happen on the target user's own page (`/admin/users/:id`). */
  app.get('/admin/rbac', { preHandler: guard('rbac.read') }, withAccept(async (req, reply) => {
    const [roles, permissions] = await withTransaction(pool, (tx) => Promise.all([rbacRepo.listRoles(tx), rbacRepo.listPermissions(tx)]));
    if (wantsJson(req)) return reply.send({ roles, permissions });

    reply.type('text/html').send(
      adminLayout({ user: req.user, caps: req.caps,
        title: 'Rôles et permissions',
        body: `<h1>Rôles et permissions</h1>
<p>Pour attribuer un rôle ou une permission à quelqu'un, passe par sa fiche utilisateur (<code>/admin/users/:id</code>).</p>
<h2>Rôles</h2>
<table><tr><th>Clé</th><th>Libellé</th><th>Révocable</th></tr>
${roles.map((r) => `<tr><td>${escapeHtml(r.key)}</td><td>${escapeHtml(r.label)}</td><td>${r.revocable ? 'oui' : 'non'}</td></tr>`).join('')}
</table>
<h2>Permissions</h2>
<table><tr><th>Clé</th><th>Libellé</th></tr>
${permissions.map((p) => `<tr><td>${escapeHtml(p.key)}</td><td>${escapeHtml(p.label)}</td></tr>`).join('')}
</table>`,
      }),
    );
  }));

  app.post('/admin/users/:id/permissions', { preHandler: [...guard('rbac.grant'), csrf] }, withAccept(async (req, reply) => {
    const { permissionKey } = permissionSchema.parse(req.body);
    await withTransaction(pool, (tx) => rbac.grantPermission(tx, req.user.id, req.params.id, permissionKey));
    if (isFormSubmission(req)) return reply.redirect(`/admin/users/${req.params.id}`, 303);
    reply.code(204).send();
  }));

  app.delete('/admin/users/:id/permissions/:permissionKey', { preHandler: [...guard('rbac.grant'), csrf] }, withAccept(async (req, reply) => {
    await withTransaction(pool, (tx) => rbac.revokePermission(tx, req.user.id, req.params.id, req.params.permissionKey));
    reply.code(204).send();
  }));

  /** Form-friendly equivalent of the DELETE above. */
  app.post('/admin/users/:id/permissions/:permissionKey/retirer', { preHandler: [...guard('rbac.grant'), csrf] }, withAccept(async (req, reply) => {
    await withTransaction(pool, (tx) => rbac.revokePermission(tx, req.user.id, req.params.id, req.params.permissionKey));
    return reply.redirect(`/admin/users/${req.params.id}`, 303);
  }));

  // --- Transactions ---
  /** List/filter (A33) — until now the only way to reach a transaction was already knowing its UUID. */
  app.get('/admin/transactions', { preHandler: guard('transactions.read') }, withAccept(async (req, reply) => {
    const guildId = req.query.guildId || undefined;
    const page = await withTransaction(pool, (tx) =>
      transactionsRepo.listForModeration(tx, { status: req.query.status || undefined, guildId }, { cursor: req.query.cursor }),
    );
    if (wantsJson(req)) return reply.send(page);
    const statuses = ['PROPOSED', 'ACCEPTED', 'TRIAL', 'TRIAL_VALIDATED', 'TRANSFERRED', 'DISPUTED', 'CANCELLED', 'EXPIRED', 'CLOSED'];

    reply.type('text/html').send(
      adminLayout({ user: req.user, caps: req.caps,
        title: 'Transactions',
        body: `<h1>Transactions (${page.total})</h1>
${guildId ? `<p>Filtré sur la guilde ${escapeHtml(guildId)} — <a href="/admin/transactions">retirer ce filtre</a></p>` : ''}
<form method="GET" action="/admin/transactions">
${guildId ? `<input type="hidden" name="guildId" value="${escapeHtml(guildId)}">` : ''}
<label>Statut <select name="status">
<option value="">Tous</option>
${statuses.map((s) => `<option value="${s}"${req.query.status === s ? ' selected' : ''}>${escapeHtml(s)}</option>`).join('')}
</select></label>
<button type="submit">Filtrer</button>
</form>
<table><tr><th>Guilde</th><th>De</th><th>Vers</th><th>Statut</th><th></th></tr>
${page.items
  .map(
    (t) => `<tr><td>${escapeHtml(t.guildId)}</td><td><a href="/admin/users/${t.fromUserId}">${escapeHtml(t.fromUserId)}</a></td><td><a href="/admin/users/${t.toUserId}">${escapeHtml(t.toUserId)}</a></td><td>${escapeHtml(t.status)}</td><td><a href="/admin/transactions/${t.id}">Détail</a></td></tr>`,
  )
  .join('')}
</table>
${paginationLinks('/admin/transactions', { status: req.query.status, guildId }, page.cursor)}`,
      }),
    );
  }));

  app.get('/admin/transactions/:id', { preHandler: guard('transactions.read') }, withAccept(async (req, reply) => {
    const data = await withTransaction(pool, async (tx) => {
      const transaction = await transactionsRepo.findById(tx, req.params.id);
      if (!transaction) return null;
      const dispute = await disputesRepo.findOpenByTransaction(tx, transaction.id);
      return { transaction, dispute };
    });
    if (!data) {
      if (wantsJson(req)) return reply.code(404).send({ error: 'NOT_FOUND' });
      return reply.code(404).type('text/html').send(adminLayout({ user: req.user, caps: req.caps, title: 'Introuvable', body: '<h1>404</h1><p>Transaction introuvable.</p>' }));
    }
    if (wantsJson(req)) return reply.send({ transaction: data.transaction });

    const { transaction: t, dispute } = data;
    const csrfToken = issueCsrfToken(req.csrfSecret);

    reply.type('text/html').send(
      adminLayout({ user: req.user, caps: req.caps,
        title: 'Transaction',
        body: `<h1>Transaction ${escapeHtml(t.id)}</h1>
<p>Statut : <strong>${escapeHtml(t.status)}</strong> · Guilde : ${escapeHtml(t.guildId)}</p>
<p>De <a href="/admin/users/${t.fromUserId}">${escapeHtml(t.fromUserId)}</a> vers <a href="/admin/users/${t.toUserId}">${escapeHtml(t.toUserId)}</a></p>
${t.trialEndsAt ? `<p>Fin de période d'essai : ${escapeHtml(new Date(t.trialEndsAt).toLocaleString('fr-FR'))}</p>` : ''}
${t.transferredAt ? `<p>Transférée le : ${escapeHtml(new Date(t.transferredAt).toLocaleString('fr-FR'))}</p>` : ''}
${
  dispute
    ? `<h2>Litige ouvert</h2>
<p>Statut : ${escapeHtml(dispute.status)} — Raison : ${escapeHtml(dispute.reason)}</p>
${
  dispute.status !== 'resolved'
    ? `<form method="POST" action="/admin/disputes/${dispute.id}/resolve">
${csrfField(csrfToken)}
<p><label>Décision<br><select name="outcome" required>
<option value="return_expected">Retour attendu (rendre la guilde)</option>
<option value="rejected">Rejeté</option>
<option value="settled">Réglé</option>
</select></label></p>
<p><label>Détails<br><textarea name="body" maxlength="2000"></textarea></label></p>
<p><button type="submit">Trancher</button></p>
</form>`
    : ''
}`
    : '<p>Aucun litige ouvert.</p>'
}`,
      }),
    );
  }));

  app.post('/admin/disputes/:id/resolve', { preHandler: [...guard('transactions.resolve'), csrf] }, withAccept(async (req, reply) => {
    const body = resolveDisputeSchema.parse(req.body);
    const dispute = await withTransaction(pool, (tx) => disputeDomain.resolve(tx, req.user.id, req.params.id, body));
    if (isFormSubmission(req)) return reply.redirect(`/admin/transactions/${dispute.transactionId}`, 303);
    reply.send({ dispute });
  }));

  // --- Configuration site ---
  app.get('/admin/settings', { preHandler: guard('settings.read') }, withAccept(async (req, reply) => {
    const settingsList = await withTransaction(pool, (tx) => settingsRepo.getAll(tx));
    if (wantsJson(req)) return reply.send({ settings: settingsList });
    const csrfToken = issueCsrfToken(req.csrfSecret);

    reply.type('text/html').send(
      adminLayout({ user: req.user, caps: req.caps,
        title: 'Réglages',
        body: `<h1>Réglages du site</h1>
${settingsList
  .map(
    (s) => `<h2>${escapeHtml(s.key)}</h2>
<form method="POST" action="/admin/settings/${encodeURIComponent(s.key)}/modifier">
${csrfField(csrfToken)}
<p><textarea name="value" rows="4" cols="60">${escapeHtml(JSON.stringify(s.value, null, 2))}</textarea></p>
<p><button type="submit">Enregistrer</button></p>
</form>`,
  )
  .join('<hr>')}`,
      }),
    );
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

  /** Form-friendly equivalent of `PUT /admin/settings/:key` — the value comes in as JSON text from a `<textarea>`, a plain `<form>` can't submit PUT either. */
  app.post('/admin/settings/:key/modifier', { preHandler: [...guard('settings.write'), csrf] }, withAccept(async (req, reply) => {
    let value;
    try {
      value = JSON.parse(req.body.value);
    } catch {
      return renderFormError(reply, 'JSON invalide dans le champ valeur.', 422, req.user, req.caps);
    }
    if (req.params.key === 'trial_duration_days' && (value < 1 || value > 90)) {
      return renderFormError(reply, ADMIN_ERROR_MESSAGES.ERR_SETTING_INVALID, 422, req.user, req.caps);
    }
    await withTransaction(pool, (tx) => settingsRepo.set(tx, req.params.key, value, req.user.id));
    await withTransaction(pool, (tx) =>
      audit.record(tx, { actorId: req.user.id, action: 'settings.updated', targetType: 'setting', targetId: req.params.key, after: { value } }),
    );
    return reply.redirect('/admin/settings', 303);
  }));

  // --- Statistiques ---
  app.get('/admin/stats', { preHandler: guard('stats.read') }, withAccept(async (req, reply) => {
    reply.type('text/html').send(
      adminLayout({ user: req.user, caps: req.caps,
        title: 'Statistiques',
        body: `<h1>Statistiques</h1>
<ul>${stats.METRIC_KEYS.map((m) => `<li><a href="/admin/stats/${m}">${escapeHtml(m)}</a></li>`).join('')}</ul>`,
      }),
    );
  }));

  app.get('/admin/stats/:metric', { preHandler: guard('stats.read') }, withAccept(async (req, reply) => {
    const result = await withTransaction(pool, (tx) =>
      stats.read(tx, req.params.metric, { from: req.query.from, to: req.query.to, granularity: req.query.granularity }),
    );
    if (wantsJson(req)) return reply.send(result);

    const rows = result.items ?? result.points;
    reply.type('text/html').send(
      adminLayout({ user: req.user, caps: req.caps,
        title: req.params.metric,
        body: `<h1>${escapeHtml(req.params.metric)}</h1>
<p>${result.computedAt ? `Calculé le ${escapeHtml(new Date(result.computedAt).toLocaleString('fr-FR'))}` : 'Jamais encore calculé'}${result.stale ? ' — <strong>périmé</strong> (en attente du prochain rafraîchissement par le process `jobs`)' : ''}</p>
${
  rows.length === 0
    ? '<p>Aucune donnée.</p>'
    : `<table>
${rows.map((r) => `<tr>${Object.entries(r).map(([k, v]) => `<td>${escapeHtml(k)}: ${escapeHtml(typeof v === 'object' ? JSON.stringify(v) : String(v))}</td>`).join('')}</tr>`).join('')}
</table>`
}`,
      }),
    );
  }));

  // --- Logs / audit ---
  app.get('/admin/audit', { preHandler: guard('audit.read') }, withAccept(async (req, reply) => {
    const page = await withTransaction(pool, (tx) =>
      audit.query(
        tx,
        { actorId: req.query.actorId || undefined, action: req.query.action || undefined, targetType: req.query.targetType || undefined },
        { cursor: req.query.cursor },
      ),
    );
    if (wantsJson(req)) return reply.send(page);

    reply.type('text/html').send(
      adminLayout({ user: req.user, caps: req.caps,
        title: 'Journal d\'audit',
        body: `<h1>Journal d'audit (${page.total})</h1>
<form method="GET" action="/admin/audit">
<label>Acteur (id) <input type="text" name="actorId" value="${escapeHtml(req.query.actorId ?? '')}"></label>
<label>Action <input type="text" name="action" value="${escapeHtml(req.query.action ?? '')}"></label>
<label>Type de cible <input type="text" name="targetType" value="${escapeHtml(req.query.targetType ?? '')}"></label>
<button type="submit">Filtrer</button>
</form>
<table><tr><th>Date</th><th>Acteur</th><th>Action</th><th>Cible</th><th>Avant</th><th>Après</th></tr>
${page.items
  .map(
    (e) => `<tr><td>${escapeHtml(new Date(e.at).toLocaleString('fr-FR'))}</td><td>${targetLink('user', e.actorId)}</td><td>${escapeHtml(e.action)}</td><td>${targetLink(e.targetType, e.targetId)}</td><td><pre>${escapeHtml(JSON.stringify(e.before))}</pre></td><td><pre>${escapeHtml(JSON.stringify(e.after))}</pre></td></tr>`,
  )
  .join('')}
</table>
${paginationLinks('/admin/audit', { actorId: req.query.actorId, action: req.query.action, targetType: req.query.targetType }, page.cursor)}`,
      }),
    );
  }));
}
