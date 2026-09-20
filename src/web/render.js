/** Minimal, dependency-free server-side HTML rendering — no view-engine choice is specified by the contract. */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getCachedHubInviteUrl } from './hubInvite.js';

/**
 * `/static/*` is served with `immutable, max-age=30d` (`web/main.js`) — fine
 * for content that never changes post-deploy, wrong for a hand-edited
 * stylesheet with no build step: without a cache-buster, a browser that
 * loaded an older `style.css` would keep it for 30 days regardless of what
 * ships next. A content hash (computed once at boot, not per-request) beats
 * a manually bumped version number — it can't go stale by forgetting to
 * bump it.
 */
const STYLE_VERSION = createHash('sha1')
  .update(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', 'style.css')))
  .digest('hex')
  .slice(0, 8);

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Discord CDN icon URL for a guild row, or `null` if it has none (never invented — `iconFallbackHtml` covers that case). Animated hashes (`a_...`) need `.gif`, everything else `.png` (CSP `img-src` already allows `cdn.discordapp.com`). */
export function guildIconUrl(guild, size = 64) {
  if (!guild?.iconHash) return null;
  const ext = guild.iconHash.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/icons/${guild.id}/${guild.iconHash}.${ext}?size=${size}`;
}

/**
 * Discord CDN avatar URL for a user row — always resolves, same as Discord's
 * own client: falls back to one of the 6 flat-color default avatars keyed
 * off the account id (post-discriminator formula: `(id >> 22) % 6`). The raw
 * `discordId` only ever appears inside this URL, never as visible text (cf.
 * A31's public-profile rule) — required structurally, Discord's CDN has no
 * other way to address an avatar.
 */
const SNOWFLAKE_RE = /^\d{17,20}$/;

export function userAvatarUrl(user, size = 64) {
  const isSnowflake = typeof user?.discordId === 'string' && SNOWFLAKE_RE.test(user.discordId);
  if (user?.avatarHash && isSnowflake) {
    const ext = user.avatarHash.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${user.discordId}/${user.avatarHash}.${ext}?size=${size}`;
  }
  // A non-snowflake discordId is dev-fixture data, never a real Discord account
  // (OAuth always writes a real snowflake) — falls back to the plain default
  // avatar rather than crashing `BigInt(...)` on it.
  const index = isSnowflake ? Number((BigInt(user.discordId) >> 22n) % 6n) : 0;
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

/**
 * Discord CDN banner URL — guilds and users live under the same
 * `/banners/{id}/{hash}` CDN path, so one function covers both. A guild
 * falls back from `bannerHash` to `splashHash` (the invite-page background,
 * far more commonly set — a real guild `banner` needs a boost tier most
 * small servers never reach) by simply passing whichever hash resolves.
 */
export function bannerUrl(id, hash, size = 480) {
  if (!id || !hash) return null;
  const ext = hash.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/banners/${id}/${hash}.${ext}?size=${size}`;
}

export function guildBannerUrl(guild, size = 480) {
  return bannerUrl(guild?.id, guild?.bannerHash ?? guild?.splashHash, size);
}

/** `null` for the same non-snowflake dev-fixture case `userAvatarUrl` guards against — there's no default banner to fall back to, so this is allowed to resolve to nothing. */
export function userBannerUrl(user, size = 480) {
  const isSnowflake = typeof user?.discordId === 'string' && SNOWFLAKE_RE.test(user.discordId);
  return isSnowflake ? bannerUrl(user.discordId, user.bannerHash, size) : null;
}

/** `<img>` filling a `.card-banner`/`.profile-banner` div when a real Discord banner/splash exists, or `''` to let the CSS gradient placeholder show through underneath. */
export function bannerImgHtml(url) {
  return url ? `<img class="banner-img" src="${url}" alt="">` : '';
}

/**
 * A flat-color `.banner-img` from a hex string (e.g. `guild.avgColorHex`,
 * `iconColor.js`) — a 1×1 SVG data URI, not a CSS `background-color`: the
 * color is only known per-request/per-guild, and CSP (`style-src 'self'`,
 * no `unsafe-inline`) forbids an inline `style="background:…"` attribute.
 * `img-src` already allows `data:` for exactly this. `''` (nothing rendered,
 * CSS gradient shows through) when there's no color to fall back to.
 */
export function solidColorImgHtml(hex) {
  if (!hex) return '';
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'><rect width='1' height='1' fill='${hex}'/></svg>`;
  return `<img class="banner-img" src="data:image/svg+xml,${encodeURIComponent(svg)}" alt="">`;
}

/**
 * Every guild without an icon/banner/splash was rendering the exact same
 * flat blurple — a wall of identical cards. `guildHueClass` picks one of 8
 * curated gradients deterministically from `guild.id` (a stable hash, not
 * random — the same guild always gets the same hue, across requests and
 * processes), applied to both the banner placeholder and the letter
 * fallback so a card's two placeholder pieces stay visually coordinated.
 * Scoped to guild cards only (not user profiles) — that's what was asked.
 */
const HUE_COUNT = 8;

function guildHueClass(guild) {
  const key = guild?.id ?? '';
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return `hue-${Math.abs(hash) % HUE_COUNT}`;
}

/** `<img>` for a guild icon, or a one-letter fallback (`.icon-fallback`, styled in `style.css`, tinted via `guildHueClass`) when the guild has none. `requestSize` is the CDN fetch size — bump it for a context that displays the icon larger than the default 32px inline slot (CSS does the actual display sizing; this only controls source resolution). */
export function guildIconHtml(guild, { requestSize = 64 } = {}) {
  const url = guildIconUrl(guild, requestSize);
  if (url) return `<img src="${url}" alt="" width="32" height="32">`;
  const letter = escapeHtml((guild?.name || '?').trim().charAt(0).toUpperCase() || '?');
  return `<span class="icon-fallback ${guildHueClass(guild)}">${letter}</span>`;
}

/** `<img>` for a user avatar — `userAvatarUrl` always resolves, so this never needs a fallback branch. See `guildIconHtml` for `requestSize`. */
export function userAvatarHtml(user, { requestSize = 64 } = {}) {
  return `<img src="${userAvatarUrl(user, requestSize)}" alt="" width="32" height="32">`;
}

/** A tag as a rounded chip (`.pill` in `style.css`) — used for listing tags and "recherché" tags. */
export function pillHtml(text) {
  return `<span class="pill">${escapeHtml(text)}</span>`;
}

/** The green "✓ Vérifié" chip (`.badge-verified`) next to a username. */
export function verifiedBadgeHtml() {
  return '<span class="badge-verified">✓ Vérifié</span>';
}

export const MODE_LABELS = { don: 'Don', echange: 'Échange' };

/**
 * Low-level Discord-Discover-style card shell — gradient banner, guild icon
 * cut into it, a title, optional body, optional footer. `listingCardHtml`
 * below is the public-browsing instance (home, `/annonces`, search, a
 * profile's server list); `user.js`'s dashboard builds its own instances
 * directly on top of this same shell for its own actions (créer une
 * annonce / modifier / supprimer) — one visual component, browsing and
 * management just fill it differently, the way Discord's own Discover card
 * and a server's member-list row share a look without being the same job.
 * `titleHtml`/`bodyHtml`/`footerHtml` are trusted pre-escaped HTML — callers
 * must `escapeHtml` any raw text themselves before passing it in.
 */
export function cardHtml({ guild, titleHtml, bodyHtml = '', footerHtml = '', href, requestSize = 128 }) {
  const bannerContent = bannerImgHtml(guildBannerUrl(guild, 480)) || solidColorImgHtml(guild?.avgColorHex);
  const bannerHueClass = bannerContent ? '' : ` ${guildHueClass(guild)}`;
  const top = `<div class="card-banner${bannerHueClass}">${bannerContent}</div>
<div class="card-icon">${guildIconHtml(guild, { requestSize })}</div>
<div class="card-body">
<p class="card-title">${titleHtml}</p>
${bodyHtml}
</div>`;
  return `<li>
${href ? `<a class="card-link" href="${href}">${top}</a>` : top}
${footerHtml ? `<div class="card-footer">${footerHtml}</div>` : ''}
</li>`;
}

/** A listing as a card (see `cardHtml`) — description as the body, mode + owner as the footer. */
export function listingCardHtml(listing, { guild, owner } = {}) {
  const modeLabel = MODE_LABELS[listing.mode] ?? escapeHtml(listing.mode);
  return cardHtml({
    guild,
    titleHtml: escapeHtml(guild?.name || listing.guildId),
    bodyHtml: `<p class="card-desc">${escapeHtml(listing.description)}</p>`,
    footerHtml: `<span><span class="dot dot-${listing.mode}"></span>${modeLabel}</span>
${owner ? `<span>${userAvatarHtml(owner)}<a href="/u/${owner.id}">${escapeHtml(owner.username)}</a></span>` : ''}`,
    href: `/annonces/${listing.id}`,
  });
}

/** ★☆ star rating as plain characters — no image, CSP-safe by construction. */
export function starsHtml(rating) {
  return `<span class="stars" aria-label="${rating} sur 5">${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}</span>`;
}

/** One review row (`.review`) — author avatar, stars, date, body. `author` may be `null` (deleted account). */
export function reviewHtml(review, author) {
  return `<li class="review">
${author ? userAvatarHtml(author) : '<span class="icon-fallback">?</span>'}
<div>
<p class="review-meta">${author ? `<a href="/u/${author.id}">${escapeHtml(author.username)}</a>` : 'Utilisateur supprimé'} ${starsHtml(review.rating)} <span class="review-date">${new Date(review.createdAt).toLocaleDateString('fr-FR')}</span></p>
${review.body ? `<p class="review-body">${escapeHtml(review.body)}</p>` : ''}
</div>
</li>`;
}

const LEGAL_LINKS = [
  ['/mentions-legales', 'Mentions légales'],
  ['/cgu', 'CGU'],
  ['/confidentialite', 'Confidentialité'],
  ['/cookies', 'Cookies'],
  ['/propriete-intellectuelle', 'Propriété intellectuelle'],
  ['/donnees-personnelles', 'Données personnelles'],
  ['/droits-rgpd', 'Droits RGPD'],
  ['/suppression-donnees', 'Suppression des données'],
  ['/securite', 'Sécurité'],
  ['/reglement', 'Règlement Xyro Market'],
  ['/regles-discord', 'Règles Discord'],
  ['/anti-fraude', 'Anti-fraude'],
  ['/anti-abus', 'Anti-abus'],
  ['/retractation', 'Droit de rétractation'],
];

/** The Discord "Clyde" glyph, inline (not an `<img>`) — no CSP concern either way, but an inline SVG needs no `img-src` allowance and can inherit `currentColor`. */
const DISCORD_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.522 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/></svg>';

/** Header button to the hub server's permanent invite (`settings.hub_invite_url`, cf. `hubInvite.js`) — `''` while the cache hasn't warmed up yet (a few seconds after boot at most) rather than a dead link. */
function discordJoinButtonHtml() {
  const url = getCachedHubInviteUrl();
  if (!url) return '';
  return `<a class="discord-join" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="Rejoindre le serveur Discord" aria-label="Rejoindre le serveur Discord">${DISCORD_ICON_SVG}</a>`;
}

/**
 * Right side of the header: a login link, or — logged in — an avatar button
 * that looks like it opens the profile but actually opens a `<details>`
 * dropdown (no JS anywhere in this app; `<details>`/`<summary>` is the only
 * native, keyboard-accessible way to get a menu without one) to "Mon
 * profil", "Mes annonces" and "Se déconnecter". `/auth/logout` has never
 * required CSRF (cf. its handler) — this form doesn't invent that requirement.
 */
function headerAccountHtml(user) {
  if (!user) return '<a href="/auth/discord" class="header-login">Se connecter</a>';
  return `<details class="profile-menu">
<summary>${userAvatarHtml(user)}</summary>
<div class="profile-menu-panel">
<a href="/u/${user.id}">Mon profil</a>
<a href="/tableau-de-bord">Mes annonces</a>
<form method="POST" action="/auth/logout"><button type="submit">Se déconnecter</button></form>
</div>
</details>`;
}

/**
 * `unsafeInline: false` (M8/web/main.js's CSP guarantee): this layout never
 * emits a `<script>` tag with inline content — pages are static markup, and
 * any interactivity a route needs must ship as an external asset. `user`
 * (the caller's `req.user`, or `undefined`/`null` when signed out) drives
 * the header's account slot — every route wires this through so the search
 * bar and profile menu are consistent site-wide, not per-page ad hoc markup.
 */
export function layout({ title, body, user, searchQuery, noindex = false }) {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${noindex ? '<meta name="robots" content="noindex">' : ''}
<title>${escapeHtml(title)} · Xyro Market</title>
<link rel="stylesheet" href="/static/style.css?v=${STYLE_VERSION}">
</head>
<body>
<header>
<a href="/" class="brand">Xyro Market</a>
${discordJoinButtonHtml()}
<form method="GET" action="/annonces" class="header-search">
<input type="search" name="search" value="${escapeHtml(searchQuery ?? '')}" placeholder="Rechercher..." aria-label="Rechercher un utilisateur, un serveur ou un tag">
<button type="submit">Chercher</button>
</form>
${headerAccountHtml(user)}
</header>
<main>${body}</main>
<footer>
<nav>${LEGAL_LINKS.map(([href, label]) => `<a href="${href}">${escapeHtml(label)}</a>`).join(' · ')}</nav>
<p>Xyro Market — service actuellement gratuit.</p>
</footer>
</body>
</html>`;
}

/**
 * Static legal page shell. Content is a placeholder: the contract
 * (`web/routes/public.js`) explicitly excludes drafting legal copy from
 * this bloc — real text for Le_Club must come from the client / legal
 * review before production, not be invented here.
 */
export function legalPage(title, user) {
  return layout({
    title,
    user,
    body: `<h1>${escapeHtml(title)}</h1>
<p><em>Contenu à rédiger — cette page est un gabarit structurel, pas un texte juridique final.</em></p>`,
  });
}
