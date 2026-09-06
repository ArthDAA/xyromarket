# Xyro Market

Plateforme de don et d'échange de serveurs Discord. Le site gère les annonces, le matching et les transactions ; un bot Discord (serveur hub) gère la mise en contact et sert de témoin technique aux transferts de propriété.

Architecture complète, décisions et journal de développement : `docs/devnotes/1-CheckList.md`, `2-Architecture.md`, `3-DebugNotes.md`.

## Stack

- Node.js (ESM), JavaScript pur + JSDoc
- Fastify (web), discord.js (bot), PostgreSQL
- Trois process indépendants supervisés par systemd : `web`, `bot`, `jobs`
- Bus inter-process via `LISTEN`/`NOTIFY` PostgreSQL — aucun broker externe

## Prérequis

- Node.js 20 LTS ou supérieur
- PostgreSQL 16 ou supérieur
- Docker (pour les tests d'intégration en base jetable)
- Une application Discord (voir configuration ci-dessous)

## Installation

```bash
git clone <url-du-repo>
cd xyro-market
npm install
```

## Variables d'environnement

Créer un fichier `.env` à la racine (non committé) :

| Variable | Description |
|---|---|
| `DATABASE_URL` | URI PostgreSQL, ex. `postgres://user:pass@localhost:5432/xyro_market` |
| `DISCORD_CLIENT_ID` | Client ID de l'application Discord |
| `DISCORD_CLIENT_SECRET` | Client Secret de l'application Discord |
| `DISCORD_BOT_TOKEN` | Token du bot |
| `DISCORD_HUB_GUILD_ID` | ID du serveur Discord servant de hub de négociation |
| `SESSION_SECRET` | Chaîne aléatoire ≥ 32 octets, signature de session **uniquement** |
| `TOKEN_ENC_KEY` | Clé base64 de 32 octets exactement, chiffrement des jetons OAuth **uniquement** — racine indépendante de `SESSION_SECRET`, le boot échoue si les deux sont identiques |
| `PUBLIC_BASE_URL` | URL publique du site, sans slash final, ex. `https://xyromarket.example` |
| `NODE_ENV` | `development` ou `production` |
| `WEB_PORT` | Port d'écoute du process web (défaut `3000`) |
| `LOG_LEVEL` | Niveau pino (défaut `info`) |

Générer les deux secrets :

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"   # SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"      # TOKEN_ENC_KEY
```

## Configuration Discord

### Application et bot

1. Créer l'application sur [discord.com/developers/applications](https://discord.com/developers/applications).
2. Onglet **OAuth2** : récupérer Client ID / Client Secret. Ajouter en Redirect URL : `${PUBLIC_BASE_URL}/auth/discord/callback`.
3. Onglet **Bot** : créer le bot, copier le token. **Ne rien activer sous "Privileged Gateway Intents"** — le bot ne demande que `Guilds` et `GuildModeration`, tous deux non privilégiés.
4. Générer l'URL d'invitation (OAuth2 > URL Generator), scope `bot`, permissions minimales : `Manage Roles`, `View Audit Log`, `Send Messages`, `Create Private Threads`, `Send Messages in Threads`, `Manage Threads`.

### Hiérarchie des rôles (par serveur cédé)

Un bot fraîchement invité est placé bas dans la hiérarchie des rôles par défaut. **Le propriétaire de chaque serveur listé doit remonter manuellement le rôle du bot** au-dessus de la position où sera créé le rôle « Administrateur (essai) », sinon la création d'annonce échoue (`ERR_ROLE_HIERARCHY`, cf. `2-Architecture.md` bloc `listings.js`/M15).

### Serveur hub

1. Créer un serveur Discord dédié aux négociations, y inviter le bot avec les mêmes permissions que ci-dessus.
2. Créer un salon texte nommé exactement `negociations` — convention actuellement en dur dans `bot/hub.js` (repli automatique sur le salon système si absent).
3. Récupérer l'ID du serveur → `DISCORD_HUB_GUILD_ID`.

## Base de données

```bash
npm run migrate
```

Applique `db/migrations/*.sql`. Crée entre autres le rôle Postgres `xyro_app`, privé d'`UPDATE`/`DELETE` sur `audit_log`.

**Étape obligatoire avant la mise en production**, non couverte par la migration : faire authentifier `DATABASE_URL` sous le rôle `xyro_app` (ou lui accorder ce rôle) plutôt que sous le propriétaire du schéma. Sans ça, la garantie d'audit en lecture seule ne tient que par convention.

## Développement local

```bash
node src/web/main.js
node src/bot/main.js
node src/jobs/main.js
```

(adapter aux scripts `npm run dev:*` définis dans `package.json` si présents)

## Tests

```bash
npm run lint
npm test                                          # unitaires purs (node:test)
TEST_DATABASE_URL=postgres://... npm run test:db  # nécessite une base Postgres jetable
```

Les tests `test:db` partagent une base et doivent tourner en série (`--test-concurrency=1`, déjà configuré). Deux d'entre eux sont des garanties contractuelles, pas de simples tests unitaires :

- `listPublic.explain.dbtest.js` : zéro `Seq Scan` sur `listings` à 100 000 annonces.
- `domain/matching/ttc.test.js` : le compteur d'avancées de curseur ne dépasse jamais Σ|prefs| sur l'exécution.

## Déploiement (VPS By-Hoster, KVM)

1. Provisionner le VPS, installer Node.js 20 LTS, PostgreSQL, git.
2. Cloner le repo, `npm ci --omit=dev`.
3. `.env` de production avec les secrets réels (jamais committé).
4. `npm run migrate`, puis configurer le rôle `xyro_app` comme décrit ci-dessus.
5. Un service systemd par process (`web`, `bot`, `jobs`). Exemple pour `web` :

```ini
# /etc/systemd/system/xyro-web.service
[Unit]
Description=Xyro Market - web
After=network.target postgresql.service

[Service]
Type=simple
WorkingDirectory=/opt/xyro-market
EnvironmentFile=/opt/xyro-market/.env
ExecStart=/usr/bin/node src/web/main.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Dupliquer pour `xyro-bot.service` (`src/bot/main.js`) et `xyro-jobs.service` (`src/jobs/main.js`).

6. Reverse proxy TLS devant `web` (Caddy recommandé pour la simplicité de configuration).

## À vérifier avant toute mise en ligne réelle

Points identifiés en Phase III, non bloquants pour le développement mais non résolus :

- **Contenu des pages légales** : actuellement des gabarits placeholder (`web/render.js#legalPage`). Le texte réel doit venir de Le_Club ou d'une relecture juridique.
- **Q1 — canal de notification hors plateforme** : non tranché. Les événements concernés (fin d'essai, litige, sanction) persistent l'intention sans la délivrer (`pending_notifications`).
- **Nom du salon hub** : convention `negociations` à documenter dans le setup, ou rendre configurable.

Points vérifiés/corrigés depuis (2026-09-06) :

- ✅ **Échappement HTML** : audité dans `web/routes/public.js` et `web/render.js` — toute donnée dynamique (description, tags, username, mode) passe par `escapeHtml()` avant interpolation ; `layout()` échappe aussi `title`. Aucune faille XSS trouvée.
- ✅ **Annulation d'un cycle à 3+ participants** : corrigé. `domain/trial.js#cancel`/`expire` propagent maintenant l'annulation à toutes les transactions soeurs du même `proposal_id` (une seule partie qui se rétracte ne peut plus laisser les autres coincées mi-échange). Testé par `cancelling one edge of a 3-party cycle cascades to every sibling edge` dans `src/integration.dbtest.js`.

## Structure

```
src/config/env.js          Contrat d'environnement
src/db/                    Pool, migrations, repositories
src/bus/events.js          Bus inter-process
src/domain/                Logique métier pure
src/web/                   Fastify — OAuth2, site public, panel admin
src/bot/                   discord.js — Gateway, hub, rôle d'essai
src/jobs/                  Scheduler
docs/devnotes/             Contrat PACT (CheckList, Architecture, DebugNotes)
```
