/** Minimal, dependency-free server-side HTML rendering — no view-engine choice is specified by the contract. */

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
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

/**
 * `unsafeInline: false` (M8/web/main.js's CSP guarantee): this layout never
 * emits a `<script>` tag with inline content — pages are static markup, and
 * any interactivity a route needs must ship as an external asset.
 */
export function layout({ title, body, noindex = false }) {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${noindex ? '<meta name="robots" content="noindex">' : ''}
<title>${escapeHtml(title)} · Xyro Market</title>
</head>
<body>
<header><a href="/">Xyro Market</a></header>
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
export function legalPage(title) {
  return layout({
    title,
    body: `<h1>${escapeHtml(title)}</h1>
<p><em>Contenu à rédiger — cette page est un gabarit structurel, pas un texte juridique final.</em></p>`,
  });
}
