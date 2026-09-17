# 2-Architecture.md - Xyro Market

| PACT Phase II -> Procedure for Architecture Contracts and Typing
| Author: Arthus De Assis-Allix
| Based on: `1-CheckList.md` (2026-09-04, LOCKED)
| Date: 2026-09-04 -> Ready for Phase III : `src/` + `3-DebugNotes.md`
| Gate : 32 interfaces non triviales, 3 frontières de process -> **BIOPGE complet obligatoire**
| Rév. b — revue critique : garanties TTC affaiblies, complexité conditionnée, événements membres, secrets séparés, bloc `stats.js` ajouté, index de recherche spécifiés
| Rév. c (2026-09-06, A19) — TTC/`preferences.js`/`ttc.js` retirés (décision utilisateur revenant sur M4/A6, confirmés client) ; `echange` initié manuellement via `engine.proposeDirectSwap`, cf. `1-CheckList.md` A19 et `3-DebugNotes.md`
| Rév. d (2026-09-06, A20) — thread hub ouvert à la création de la proposition au lieu de l'acceptation complète (`trial.js` : `open` scindée en `createTransactions`/`confirmAccepted`), pour `don` et `echange` — cf. `1-CheckList.md` A20
| Rév. e (2026-09-06, A21) — bug réel trouvé en test à deux comptes réels : `matched` ajouté aux statuts "vivants" bloquant une deuxième annonce sur la même guilde (`uniq_listings_live_guild` étendu, migration 004), sinon `uniq_transactions_open_guild` pouvait être violée depuis A20 — cf. `1-CheckList.md` A21
| Rév. f (2026-09-07, A22) — invite Discord permanente vers le hub créée au boot et affichée sur le site (`bot/hub.js:ensureHubInvite`, `settings.hub_invite_url`) — sans elle, un propriétaire pas déjà membre du hub n'avait aucun moyen de rejoindre son thread — cf. `1-CheckList.md` A22
| Rév. g (2026-09-07, A23) — `bot/hub.js:notifyMissingHubMember` envoie en plus un MP direct avec le lien d'invite quand un participant n'est pas dans le hub (best-effort, le site reste le filet garanti) — cf. `1-CheckList.md` A23
| Rév. h (2026-09-14, A24) — `match_participants.listing_id`/`.gives_to_listing_id`, `listing_queue.listing_id` passent de `RESTRICT` à `SET NULL` (migration 005) : suppression physique d'une annonce possible, l'historique de match/file survit sans la référence pendante — `audit_log.before`/`after` reste le filet de contenu, pas la ligne `listings` — cf. `1-CheckList.md` A24
| Rév. i (2026-09-14, A25) — `engine.proposeDirectSwap` (A19) rejette désormais une proposition sans recoupement de tags dans au moins un sens (`ERR_TAG_MISMATCH`) — l'équivalent du filtrage à score nul de l'ancien `preferences.js`, jamais réintroduit après le retrait du TTC — cf. `1-CheckList.md` A25
| Rév. j (2026-09-14, A26) — `web/auth/oauth.js:syncOwnedGuilds` désassigne (`ownership.observe`, source `oauth`, sentinel `''`) toute guilde disparue de la liste Discord fraîche de l'utilisateur, sauf si une transaction non terminale y est ouverte (signal faisant autorité : le bot, pas une liste OAuth périmée) — cf. `1-CheckList.md` A26
| Rév. k (2026-09-15, A27) — `web/routes/admin.js` gagne une interface HTML pour les 9 domaines du panel (JSON conservé sur `Accept: application/json`), formulaires sans JS inline (CSP inchangée). Deux gardes RBAC recalés sur la permission réellement vérifiée côté domaine (`listings.hide`, `rbac.grant`) ; `listingsRepo.listForModeration` ajoutée (statut non forcé, contrairement à `listPublic`) — cf. `1-CheckList.md` A27
| Rév. l (2026-09-16, A28-A31) — Moteur de recherche léger (`listingsRepo.search`, migration 006, `pg_trgm`) sur utilisateur/serveur/tag/description, exposé côté admin (`GET /admin/search`) et public (`GET /annonces?search=`, section utilisateurs incluse) ; **décision produit prise en session, hors verrouillage Phase I** : nom de serveur et pseudo propriétaire désormais affichés publiquement sur toute fiche/liste d'annonce — cf. `1-CheckList.md` A28-A31
| Rév. m (2026-09-17, A32) — Lien "Panel admin" sur le tableau de bord, conditionné à `req.caps.size > 0` — aucun mécanisme de bootstrap self-service pour le premier `proprietaire` (gap noté, non résolu) — cf. `1-CheckList.md` A32
| Rév. n (2026-09-17) — **Audit de clôture Phase III** : voir `4-Audit.md`. Constat principal : ce journal de révisions (Rév. c-m) documente fidèlement le code jusqu'à A32, mais aucun commit git ne va au-delà d'A25 — ~29 fichiers, dont l'intégralité du panel admin et du moteur de recherche, n'existaient que dans l'arbre de travail au moment de l'audit. `Écarts assumés` et `Exit Condition` mis à jour en conséquence ci-dessous.
| Rév. o (2026-09-17) — Tout le travail non committé au moment de l'audit (A16-A33) committé (`32fd155`, puis `b465a61`) ; A19 validé par Le_Club — le gap de mandat que Rév. n/`4-Audit.md` plaçaient en tête de liste est levé, cf. `1-CheckList.md` A19. `GET /admin/transactions?status=&guildId=` ajoutée (A33, dernier gap fonctionnel confirmé par l'audit).
| Rév. p (2026-09-17, A34) — Invitation Discord + retry (`bot/trialRole.js`, `jobs.acceptedInviteRetryTick`), rappel J-1 (`jobs.trialReminderTick`, nouveau canal `intent.trial.reminder`), message de clôture `TRANSFERRED`/`EXPIRED` distinct dans le thread hub, `trial_duration_days` 3j (migration 007). Trois bugs pré-existants trouvés et corrigés en testant, sans rapport avec le code écrit pour A34 : pool de connexions `bot` sous-dimensionné (5 -> 10, un deadlock complet était reproductible avec seulement 2-3 événements bus concurrents) ; `buildBotInviteUrl` sans le scope `applications.commands` (empêchait tout enregistrement de commande slash, et faisait planter tout le process bot au boot faute d'isolation) ; `ensureHubInvite` laissait une partie de son propre appel hors try/catch, bloquant `bus.start()` en silence si la guilde hub devient injoignable. Cf. `1-CheckList.md` A34 et `3-DebugNotes.md` pour le détail complet.

---

## GLOBAL SOLUTION

Trois process Node.js (ESM) sur le VPS KVM, supervisés par systemd, partageant une seule base PostgreSQL locale : `web` (Fastify — OAuth2, site public, API utilisateur, panel admin), `bot` (discord.js, Gateway persistante — vérification `owner_id`, threads hub, rôle d'essai, témoin de transfert), `jobs` (scheduler — moteur de matching, expiration des essais, sweep de propriété). Aucun broker externe : le bus inter-process est `LISTEN`/`NOTIFY` PostgreSQL, ce qui garantit qu'un événement n'est jamais publié sans que la transaction qui le motive soit committée. Le domaine (`src/domain/`) est pur : aucune dépendance à Fastify ni à discord.js, il reçoit des repositories et un port d'effets Discord injectés — `web` et `jobs` ne parlent jamais à l'API Discord directement, ils émettent une intention sur le bus que `bot` consomme. Toute mutation d'état d'une transaction traverse la FSM de `src/domain/trial.js` ; aucun autre module n'écrit `transactions.status`.

```txt
src/config/env.js                 -> Contrat d'environnement, fail-fast au boot
src/db/pool.js                    -> Pool pg, helper transactionnel, advisory locks
src/db/migrations/                -> Contrat relationnel (tables, contraintes, index)
src/db/repositories/              -> Accès données typé, un repo par agrégat
src/bus/events.js                 -> Bus LISTEN/NOTIFY transactionnel inter-process
src/domain/rbac.js                -> Permissions granulaires, résolution rôle -> capacités
src/domain/audit.js               -> Journal d'audit append-only
src/domain/ownership.js           -> Vérité sur `owner_id`, réconciliation 3 sources
src/domain/listings.js            -> Cycle de vie des annonces, tags, visibilité
src/domain/matching/queue.js      -> File d'attente FIFO (mode don)
src/domain/matching/engine.js     -> Tour de matching (don) + proposeDirectSwap (echange, A19)
src/domain/trial.js               -> FSM transaction + période d'essai
src/domain/transfer.js            -> Témoin de bascule `owner_id`, horodatage
src/domain/dispute.js             -> Litiges post-transfert, retour manuel
src/domain/reputation.js          -> Avis, moyennes, anti-fraude, tag Vérifié
src/domain/moderation.js          -> Signalements, dossiers, sanctions plateforme
src/domain/gdpr.js                -> Export, rectification, suppression/pseudonymisation
src/domain/stats.js               -> Définition des métriques, vues matérialisées, fraîcheur
src/web/main.js                   -> Entrée HTTP, montage plugins et routes
src/web/auth/oauth.js             -> Flow OAuth2 Discord, refresh, révocation
src/web/auth/session.js           -> Session cookie signée, CSRF
src/web/routes/public.js          -> Vitrine, annonces publiques, pages légales
src/web/routes/user.js            -> Espace authentifié : annonces, matchs, avis, RGPD
src/web/routes/admin.js           -> Panel admin, 9 domaines fonctionnels
src/bot/main.js                   -> Entrée Gateway, registre de handlers
src/bot/guildWatcher.js           -> Événements guilde, détection bascule propriétaire
src/bot/hub.js                    -> Threads privés du serveur hub
src/bot/trialRole.js              -> Rôle "Administrateur (essai)", hiérarchie
src/bot/announce.js               -> Annonce automatique de passation
src/jobs/main.js                  -> Scheduler, 7 jobs périodiques
```

---

## LOGICAL SOLUTION

### `src/config/env.js`

"Contrat d'environnement"

| Field | Content |
|---|---|
| **Boundary** | Possède : lecture et validation de `process.env`, exposition d'un objet gelé `Config`. NE possède PAS : secrets en dur, valeurs métier configurables (celles-ci vivent en base, table `settings`, cf. §2bis Configuration site). |
| **Inputs** | `process.env` : `DATABASE_URL` (URI postgres), `DISCORD_CLIENT_ID` (snowflake), `DISCORD_CLIENT_SECRET` (str), `DISCORD_BOT_TOKEN` (str), `DISCORD_HUB_GUILD_ID` (snowflake), `SESSION_SECRET` (str, >=32o — **signature de session uniquement**), `TOKEN_ENC_KEY` (base64, 32o exactement — **chiffrement des jetons OAuth uniquement**, racine indépendante), `PUBLIC_BASE_URL` (URL https), `NODE_ENV` (`development`\|`production`), `WEB_PORT` (u16, def. 3000), `LOG_LEVEL` (enum pino, def. `info`). |
| **Outputs** | `Config` : objet gelé, champs typés. Effet de bord : `process.exit(1)` si invalide. |
| **Process** | 1. Charger `.env` si `NODE_ENV !== production` -> 2. Valider chaque clé contre son schéma (Zod) -> 3. Normaliser (`PUBLIC_BASE_URL` sans slash final) -> 4. `Object.freeze` -> 5. Exporter. |
| **Guarantees** | Aucun module n'accède à `process.env` en dehors d'ici ; `Config` immuable après import ; échec au boot, jamais à chaud ; les secrets ne sont jamais loggés (redaction pino sur `*_SECRET`, `*_TOKEN`, `*_KEY`) ; **une racine cryptographique par usage** — `SESSION_SECRET` et `TOKEN_ENC_KEY` sont deux valeurs indépendantes, jamais dérivées l'une de l'autre : la compromission de la signature de session n'expose pas les jetons OAuth au repos, et la rotation de l'une n'invalide pas l'autre ; le boot échoue si les deux valeurs sont égales. |
| **Errors** | `ENV_MISSING`: clé absente -> log fatal listant **toutes** les clés manquantes (pas la première) puis exit 1. `ENV_INVALID`: format invalide -> idem. `ENV_SECRET_REUSE`: `SESSION_SECRET === TOKEN_ENC_KEY` -> exit 1. |

> Covers : F1, F2, F3

---

### `src/db/pool.js`

"Passerelle Postgres"

| Field | Content |
|---|---|
| **Boundary** | Possède : pool `pg`, helper `withTransaction`, advisory locks, journal des requêtes lentes. NE possède PAS : SQL métier (dans `repositories/`), migrations (dans `migrations/`), logique domaine. |
| **Inputs** | `Config.DATABASE_URL`; `withTransaction(fn: (tx: Client) => Promise<T>, opts?: { isolation: 'read committed'\|'serializable' })`; `withAdvisoryLock(key: bigint, fn)`. |
| **Outputs** | `Pool`; `T` retourné par `fn`; effet : `COMMIT` ou `ROLLBACK`. |
| **Process** | 1. Instancier le pool (max 10 web, 10 bot — relevé de 5, A34, voir Guarantees — 3 jobs) -> 2. Sur `withTransaction`, acquérir un client -> 3. `BEGIN` (niveau demandé) -> 4. Exécuter `fn(tx)` -> 5. `COMMIT` -> 6. `finally` release -> 7. Sur throw, `ROLLBACK` puis re-throw. |
| **Guarantees** | Aucun client n'est jamais laissé hors du pool, y compris sur exception ou timeout ; `withTransaction` est non ré-entrant (le `tx` reçu doit être propagé, jamais le pool) ; toute requête > 500ms est loggée avec son texte paramétré ; le pool se ferme proprement sur `SIGTERM` avant exit. **A34** : un handler du bus (`bot/*`) ne reçoit jamais le `tx` que `processRow` tient déjà ouvert pour toute la durée de l'appel — chaque accès DB dans un handler rouvre donc sa propre connexion via `withTransaction(pool, ...)`, en plus de celle déjà retenue par `processRow`. Reproduit en direct : une seule action domaine cascadant sur plusieurs canaux presque simultanément (`trial.expire`/`cancel` avec un seul sibling) suffisait à épuiser un pool à 5 connexions et à le bloquer net — chaque connexion attendait soit une transaction externe, soit un appel imbriqué qu'aucune des transactions externes ne pouvait libérer. `bot` relevé à 10 en conséquence ; un vrai correctif de fond (ne jamais tenir une connexion ouverte pendant tout un appel de handler) reste hors du périmètre d'A34. |
| **Errors** | `DB_UNAVAILABLE`: connexion impossible au boot -> retry exponentiel 5 tentatives puis exit 1. `SERIALIZATION_FAILURE` (40001): -> relance automatique de `fn`, max 3 fois, puis propagation. `DEADLOCK_DETECTED` (40P01): idem. `LOCK_BUSY`: advisory lock déjà tenu -> retourne `null` sans attendre (les jobs ne s'empilent pas). |

> Covers : F3

---

### `src/db/migrations/`

"Contrat relationnel"

| Field | Content |
|---|---|
| **Boundary** | Possède : définition des relations, contraintes, index, et l'ordre de migration versionné et irréversible en avant. NE possède PAS : données de seed métier hors `settings` par défaut et rôles RBAC de base. |
| **Inputs** | Fichiers numérotés `NNN_nom.sql`, appliqués en ordre lexicographique, une fois, dans une transaction, avec table `schema_migrations(version, applied_at)`. |
| **Outputs** | Schéma : `users`(id PK, discord_id UNIQUE, username, avatar_hash, created_at, banned_until, banned_permanently, is_verified, deleted_at) ; `oauth_tokens`(user_id FK, access_token_enc, refresh_token_enc, expires_at, scopes[]) ; `guilds`(id PK = snowflake, name, icon_hash, member_count_cached, owner_discord_id, bot_present, bot_role_position, last_seen_at) ; `listings`(id PK, user_id FK, guild_id FK, mode ENUM(`don`,`echange`), description, tags[], seeking_tags[], status ENUM(`active`,`matched`,`hidden`,`removed`,`fulfilled`,`pending_bot` — ajouté 002/003, A16), created_at, updated_at) ; `match_proposals`(id, kind ENUM(`queue`,`cycle`), created_at, expires_at, status) ; `match_participants`(proposal_id FK, listing_id FK, gives_to_listing_id, accepted_at, refused_at) ; `transactions`(id PK, proposal_id FK, from_user_id, to_user_id, guild_id, status ENUM(cf. `trial.js`), trial_started_at, trial_ends_at, trial_role_id, validated_by_from_at, validated_by_to_at, transferred_at, closed_at) ; `reviews`(id, transaction_id FK, author_id, target_id, rating u8 1..5, body, created_at, hidden_at, hidden_by) ; `reports`(id, reporter_id, target_type, target_id, reason, body, status, assignee_id, resolved_at) ; `sanctions`(id, user_id, kind, reason, actor_id, starts_at, ends_at, revoked_at) ; `disputes`(id, transaction_id FK, opened_by, reason, status, resolution, resolved_by, timeline JSONB) ; `settings`(key PK, value JSONB, updated_by, updated_at) ; `roles`/`permissions`/`role_permissions`/`user_roles` (RBAC) ; `audit_log`(id, actor_id, action, target_type, target_id, before JSONB, after JSONB, at, ip_hash) ; `ownership_events`(id, guild_id, previous_owner_id, new_owner_id, observed_at, source ENUM(`gateway`,`sweep`,`oauth`,`audit_log`)). **Index de recherche** : GIN sur `listings.tags` et `listings.seeking_tags` (`array_ops`, sert `&&` et `@>` — **jamais** `= ANY(tags)`, non indexable par cet opclass) ; colonne générée `search_tsv tsvector` = `to_tsvector('french', description)` + GIN dessus pour le paramètre `q` ; index composite `(status, mode, created_at DESC)` pour la pagination par curseur ; GIN sur `audit_log.before`/`after` (`jsonb_path_ops`) ; B-tree sur `transactions(status, trial_ends_at)` pour `trialExpiry` ; B-tree sur `outbox(consumed_at, published_at) WHERE consumed_at IS NULL` pour `outboxSweep` ; extension `pg_trgm` + GIN trigram sur `guilds.name` et `users.username`, plus B-tree sur `listings.guild_id`/`listings.user_id` (aucun des deux FK n'est auto-indexé par Postgres) — migration 006, sert `listingsRepo.search` (A28, `web/routes/admin.js`/`public.js`). |
| **Process** | 1. `withAdvisoryLock(MIGRATION_KEY)` -> 2. Lire `schema_migrations` -> 3. Sélectionner les versions non appliquées -> 4. Pour chacune : `BEGIN`, exécuter, insérer la version, `COMMIT` -> 5. Log du delta appliqué. |
| **Guarantees** | `reviews` : `CHECK (author_id <> target_id)` + `UNIQUE (transaction_id, author_id)` — l'auto-évaluation et le double avis sont impossibles au niveau base, pas seulement applicatif (M9) ; `listings` : index partiel `uniq_listings_live_guild` `UNIQUE (guild_id) WHERE status IN ('active','pending_bot','matched')` — une guilde n'a jamais deux annonces vivantes, y compris pendant l'attente d'invitation du bot (A16 ; renommé et étendu par 003 pour `pending_bot`, `matched` ajouté par 004/A21 — sans lui, une annonce restée `matched` indéfiniment (proposition jamais acceptée/refusée) n'empêchait pas la création d'une deuxième annonce sur la même guilde, ce qui violait ensuite `uniq_transactions_open_guild` ci-dessous ; l'index s'appelait `uniq_listings_active_guild` avant 003 et ne couvrait que `active`) ; `transactions` : index partiel `UNIQUE (guild_id) WHERE status NOT IN ('cancelled','expired','closed')` — un seul essai en cours par guilde, garantie qui **suppose** qu'une guilde ne porte jamais deux annonces vivantes en même temps (d'où l'importance de l'index précédent, A21) ; `audit_log` : aucun `UPDATE`/`DELETE` accordé au rôle applicatif (append-only garanti par GRANT, pas par convention) ; toutes les FK vers `users` sont `ON DELETE RESTRICT` — la suppression RGPD passe par pseudonymisation (cf. `gdpr.js`), jamais par cascade ; `match_participants.listing_id`/`.gives_to_listing_id` et `listing_queue.listing_id` sont `ON DELETE SET NULL` vers `listings(id)` (migration 005, A24 — `RESTRICT` jusque-là, cf. A18) : une annonce ayant un historique de match (même annulé) ou de file d'attente (même retirée) peut désormais toujours être supprimée physiquement — la ligne de match/file d'attente elle-même est conservée, seule la référence désormais pendante vers l'annonce disparue est effacée ; l'historique réellement consultable par un futur admin n'a jamais été la ligne `listings` mais `audit_log.before`/`after` (`listing.created`/`listing.removed`), qui survit à la ligne dans tous les cas ; **aucun chemin de lecture publique ne dégénère en balayage séquentiel** : tout filtre de `listPublic` (tags, mode, texte) est servi par un index déclaré ci-dessus, et un test de non-régression en Phase III vérifie le plan (`EXPLAIN`) sur un jeu de 100 000 annonces — un `Seq Scan` sur `listings` fait échouer le test. |
| **Errors** | `MIGRATION_FAILED`: erreur SQL -> `ROLLBACK` de la seule migration fautive, versions précédentes conservées, exit 1, aucun process applicatif ne démarre. `MIGRATION_DIVERGED`: version appliquée absente du disque -> exit 1 sans tenter de réparer. `ERR_EXTENSION_MISSING`: extension requise (`pg_trgm` si le `tsvector` français s'avère insuffisant pour la recherche partielle) absente -> exit 1, l'extension est déclarée dans la migration initiale, pas installée à chaud. |

> Covers : M3, M9, M11, M14, M8, A11, A13, A18, A21

---

### `src/db/repositories/`

"Accès données"

| Field | Content |
|---|---|
| **Boundary** | Possède : traduction entre lignes SQL et objets domaine, un module par agrégat. NE possède PAS : décision métier, appel Discord, validation d'entrée utilisateur (faite en amont par les schémas de route). |
| **Inputs** | Chaque méthode reçoit `(tx \| pool)` en premier paramètre, puis des paramètres typés. Modules : `usersRepo`, `guildsRepo`, `listingsRepo`, `matchRepo`, `transactionsRepo`, `reviewsRepo`, `reportsRepo`, `sanctionsRepo`, `disputesRepo`, `settingsRepo`, `rbacRepo`, `auditRepo`, `ownershipRepo`. |
| **Outputs** | Objets domaine typés (JS objects gelés), jamais de `Row` brut ni de `Client` fuité. Listes paginées : `{ items: T[], total: number, cursor: string \| null }`. |
| **Process** | 1. Recevoir l'exécuteur -> 2. Construire une requête **paramétrée** -> 3. Exécuter -> 4. Mapper `snake_case` -> `camelCase` et types (`bigint` snowflake -> `string`) -> 5. Geler -> 6. Retourner. |
| **Guarantees** | Zéro concaténation de valeur dans le SQL ; les snowflakes traversent l'application en `string`, jamais en `number` (perte de précision > 2^53) ; toute lecture de liste est paginée par curseur, jamais par `OFFSET` ; `settingsRepo.get(key)` retourne toujours une valeur (défaut codé si la clé est absente en base). |
| **Errors** | `NOT_FOUND`: retour `null`, jamais un throw — la décision d'échouer appartient au domaine. `UNIQUE_VIOLATION` (23505): -> mappé en `ERR_CONFLICT` typé avec le nom de la contrainte, propagé. `CHECK_VIOLATION` (23514): -> `ERR_INVARIANT`, propagé, journalisé en `error` (ne devrait jamais atteindre la base si l'applicatif est correct). |

> Covers : M3, M9, M10

---

### `src/bus/events.js`

"Bus inter-process"

| Field | Content |
|---|---|
| **Boundary** | Possède : publication et consommation d'événements entre `web`, `bot` et `jobs` via `LISTEN`/`NOTIFY`, plus la table de relais `outbox` pour les charges > 8 ko et la durabilité. NE possède PAS : logique métier, garantie d'ordre global entre canaux distincts. |
| **Inputs** | `publish(tx, channel: Channel, payload: object)` où `Channel` ∈ { `intent.trial.assign`, `intent.trial.revoke`, `intent.trial.reminder` (A34), `intent.hub.thread_create`, `intent.hub.thread_archive`, `intent.announce.handover`, `intent.guild.leave` (A17), `event.ownership.changed`, `event.match.proposed`, `event.transaction.updated`, `event.moderation.action` } ; `subscribe(channel, handler: (payload) => Promise<void>)`. |
| **Outputs** | Effet : ligne `outbox(id, channel, payload JSONB, published_at, consumed_at, attempts, last_error)` + `pg_notify(channel, id)`. Côté consommateur : invocation du handler avec le payload désérialisé. |
| **Process** | 1. `publish` insère dans `outbox` **dans la transaction appelante** -> 2. `pg_notify` émis via trigger `AFTER INSERT` (donc post-commit) -> 3. Le consommateur reçoit l'id -> 4. `SELECT ... FOR UPDATE SKIP LOCKED` sur la ligne -> 5. Exécute le handler -> 6. Marque `consumed_at` -> 7. Sur échec, incrémente `attempts` et laisse la ligne pour le job de rattrapage. |
| **Guarantees** | Un événement n'est jamais visible si la transaction qui l'a produit a rollback (outbox transactionnel) ; livraison **au moins une fois** — tous les handlers doivent être idempotents, c'est une pré-condition contractuelle, pas une recommandation ; `SKIP LOCKED` garantit qu'un événement n'est traité que par un seul consommateur même en cas de double instance ; un `NOTIFY` perdu (redémarrage du consommateur) est rattrapé par `jobs.outboxSweep` sous 60 s. |
| **Errors** | `HANDLER_FAILED`: throw du handler -> `attempts++`, backoff 1/5/30/300 s, `attempts >= 5` -> statut `dead`, alerte admin, aucune nouvelle tentative automatique. `PAYLOAD_TOO_LARGE`: > 8 ko -> le `NOTIFY` ne transporte que l'id (toujours le cas par conception), donc sans objet. `LISTEN_DROPPED`: connexion perdue -> reconnexion et `LISTEN` réémis, puis sweep immédiat de l'outbox non consommé. |

> Covers : F2, F3, M6, M7, M11, M13, A17, A34

---

### `src/domain/rbac.js`

"Permissions granulaires"

| Field | Content |
|---|---|
| **Boundary** | Possède : résolution `user -> Set<Permission>`, vérification d'une capacité, garde d'escalade. NE possède PAS : authentification (cf. `session.js`), rôles Discord (cf. `trialRole.js`) — les rôles RBAC sont plateforme uniquement. |
| **Inputs** | `resolve(tx, userId)` ; `can(caps: Set<Permission>, permission: Permission, ctx?: { targetUserId })` ; `Permission` = chaîne `domaine.action` sur 9 domaines (`users.ban`, `listings.hide`, `reports.assign`, `reviews.delete`, `transactions.resolve`, `settings.write`, `rbac.grant`, `audit.read`, `stats.read`, …). Rôles fournis : `proprietaire`, `administrateur`, `moderateur`, `support`, `gestionnaire`. |
| **Outputs** | `Set<Permission>` gelé ; `boolean` pour `can`. |
| **Process** | 1. Charger `user_roles` -> 2. Union des `role_permissions` -> 3. Union des permissions accordées directement à l'utilisateur -> 4. Retirer les permissions explicitement révoquées -> 5. Geler et mettre en cache 60 s (invalidé par `event.moderation.action` et toute écriture RBAC). |
| **Guarantees** | Les rôles sont des agrégats de permissions, jamais des tests en dur — aucune comparaison `role === 'admin'` n'existe ailleurs dans le code (M10, RBAC granulaire par fonction) ; un acteur ne peut jamais accorder une permission qu'il ne possède pas lui-même ; `proprietaire` est le seul rôle non révocable et il en existe toujours au moins un (contrainte vérifiée avant toute révocation) ; `ctx.targetUserId === actorId` bloque les actions de sanction sur soi-même. |
| **Errors** | `ERR_FORBIDDEN`: capacité absente -> 403, aucune fuite d'information sur l'existence de la ressource. `ERR_ESCALATION`: tentative d'accorder une permission non détenue -> 403 + entrée `audit_log` en niveau `warn`. `ERR_LAST_OWNER`: retrait du dernier `proprietaire` -> 409, refus. |

> Covers : M10, §2bis Permissions

---

### `src/domain/audit.js`

"Journal d'audit"

| Field | Content |
|---|---|
| **Boundary** | Possède : écriture append-only de toute action administrative ou automatique significative, et lecture filtrée. NE possède PAS : logs techniques (pino/stdout), métriques. |
| **Inputs** | `record(tx, { actorId: string \| 'system' \| 'bot', action: string, targetType, targetId, before?: object, after?: object, ipHash?: string })` ; `query(tx, filters: { actorId?, action?, targetType?, from?, to? }, page)`. |
| **Outputs** | Ligne `audit_log` ; liste paginée en lecture. |
| **Process** | 1. Normaliser `before`/`after` en ne conservant que les champs modifiés -> 2. Rédiger les champs sensibles (tokens, e-mails) -> 3. Hacher l'IP (SHA-256 + sel serveur) -> 4. Insérer **dans la transaction de l'action auditée**. |
| **Guarantees** | L'audit et l'action qu'il décrit committent ensemble ou pas du tout — pas d'action non tracée, pas de trace d'action annulée ; `before`/`after` sont toujours des objets JSON parseables, jamais `undefined` ; aucune donnée personnelle brute (IP en clair, token) n'entre dans la table ; les entrées ne sont ni modifiables ni supprimables, y compris par un `proprietaire` (GRANT au niveau base, cf. migrations). |
| **Errors** | `ERR_AUDIT_WRITE`: échec d'insertion -> **abort de la transaction métier**. Une action non auditable n'a pas lieu ; c'est un choix explicite, pas un effet de bord. |

> Covers : M10, §2bis Logs/audit

---

### `src/domain/ownership.js`

"Vérité sur owner_id"

| Field | Content |
|---|---|
| **Boundary** | Possède : la valeur de référence de `guilds.owner_discord_id`, la réconciliation entre trois sources d'observation, l'émission de `event.ownership.changed`. NE possède PAS : les appels Discord (fournis par `bot/guildWatcher.js` et le port REST), la décision de ce qu'une bascule déclenche (cf. `transfer.js`). |
| **Inputs** | `observe(tx, { guildId: string, ownerDiscordId: string, source: 'gateway' \| 'sweep' \| 'oauth', observedAt: Date })` ; `isOwner(tx, userId, guildId)` ; `assertOwnershipForListing(tx, userId, guildId)` ; constante `UNOWNED` (`''`) — valeur sentinelle passée à `observe` en `ownerDiscordId` quand une source constate positivement qu'un propriétaire enregistré ne l'est plus (A26 : guilde supprimée/quittée, détecté par `oauth.syncOwnedGuilds`) ; sûre car `owner_discord_id` est `NOT NULL` et aucun snowflake Discord réel n'est jamais la chaîne vide, donc aucune collision possible avec un vrai utilisateur. |
| **Outputs** | `{ changed: boolean, previousOwnerId: string \| null }` ; ligne `ownership_events` si changement ; `publish(event.ownership.changed)` si changement. |
| **Process** | 1. Verrouiller la ligne `guilds` (`FOR UPDATE`) -> 2. Comparer `ownerDiscordId` à la valeur stockée -> 3. Si identique, mettre à jour `last_seen_at` et sortir (`changed: false`) -> 4. Si différent, insérer `ownership_events` -> 5. Écrire la nouvelle valeur -> 6. Publier l'événement -> 7. Auditer avec `actorId: 'bot'`. |
| **Guarantees** | Idempotent : rejouer la même observation ne produit ni doublon d'événement ni entrée d'historique ; une observation dont `observedAt` est antérieur à `last_seen_at` est ignorée (pas de régression sur événement Gateway retardé) ; les trois sources écrivent par ce point unique — aucun autre module ne met à jour `owner_discord_id` ; `isOwner` lit l'état stocké, jamais l'API Discord (pas d'appel réseau dans un chemin de requête HTTP). |
| **Errors** | `ERR_GUILD_UNKNOWN`: guilde absente en base -> insertion à la volée avec `bot_present: false`, pas d'échec. `ERR_STALE_OBSERVATION`: `observedAt` régressif -> ignoré silencieusement, compteur métrique incrémenté. |

> Covers : M2, M6, M12

---

### `src/domain/listings.js`

"Cycle de vie des annonces"

| Field | Content |
|---|---|
| **Boundary** | Possède : création, édition, masquage, suppression, restauration d'annonce ; normalisation des tags ; règles de visibilité publique. NE possède PAS : le matching (cf. `matching/`), la modération a posteriori (cf. `moderation.js`), la vérification de propriété (déléguée à `ownership.js`). |
| **Inputs** | `create(tx, userId, { guildId, mode: 'don'\|'echange', description: string 20..2000, tags: string[] 1..10, seekingTags: string[] 0..10 })` ; `update`, `hide`, `remove`, `restore` ; `listPublic(tx, { tags?, mode?, q? }, page)`. |
| **Outputs** | `Listing` gelé ; liste paginée avec `guild.memberCountCached` en champ **informatif uniquement**. |
| **Process** | 1. Vérifier `ownership.assertOwnershipForListing` -> 2. Déterminer le statut initial : `active` si `guilds.bot_present` (et alors vérifier `bot_role_position` via `trialRole.assertHierarchy`), sinon `pending_bot` — le bot absent ne bloque plus la création (A16) -> 3. Normaliser les tags (NFKC, minuscules, sans `#`, `[a-z0-9-]{2,24}`, dédupliqués) -> 4. Rejeter `seekingTags` non vide si `mode === 'don'` -> 5. Rejeter si la guilde porte déjà une annonce vivante (`active` ou `pending_bot`) -> 6. Insérer avec le statut déterminé à l'étape 2 -> 7. Auditer -> 8. Si `active`, publier l'`intent` de re-run matching (`event.listing.changed`) — inutile tant que `pending_bot`, `listActive()`/`listPublic()` l'ignorent déjà. |
| **Guarantees** | Publication directe : une annonce **existe et est visible dans le tableau de bord de son propriétaire** dès la création, quel que soit son statut (A12) — seul `active` la rend publique/matchable ; le nombre de membres n'entre dans aucune décision de matching, seulement dans l'affichage (A2) ; une guilde ne porte jamais deux annonces **vivantes** (`active`, `pending_bot` **ou** `matched`) simultanément (contrainte base, `uniq_listings_live_guild`, A16/A21 — `matched` inclus depuis A21, sinon une annonce `matched` sans transaction encore acceptée n'empêchait pas une deuxième annonce sur la même guilde) ; une annonce `pending_bot` bascule en `active` uniquement via `activatePendingForGuild`, appelé par `bot/guildWatcher.js` au moment où le bot rejoint effectivement la guilde — jamais par une déclaration du propriétaire ; les tags sont l'unique taxonomie — pas de table `categories` (A11) ; `remove` supprime physiquement la ligne (A18, remplace l'ancien soft-delete permanent) — `match_participants`/`listing_queue` ne la bloquent plus (A24, migration 005 : `ON DELETE SET NULL` remplace `RESTRICT`), donc ce n'est plus qu'un repli défensif (`hardDelete` intercepte encore un `23503` générique, au cas où une référence encore inconnue apparaîtrait un jour) et non le chemin attendu ; dans tous les cas le contenu intégral part dans `audit_log.before` avant suppression — rien n'est perdu même quand la ligne disparaît (`action: 'listing.created'` porte déjà ce même contenu depuis la création, de toute façon) — c'est cette trace-là, pas la survie de la ligne `listings`, qui reste consultable par un futur admin (demande explicite, A24) ; `restore` reste toujours possible tant qu'aucune transaction terminale ne référence l'annonce **et que la ligne existe encore** — sur une annonce réellement supprimée, `restore` échoue en `NOT_FOUND` comme sur n'importe quel id inconnu ; `remove` publie `intent.guild.leave` si `guilds.bot_present` — le bot n'a plus de raison de rester une fois la seule annonce vivante de la guilde retirée (A17) ; `restore` ne remet jamais `active` en aveugle : elle rejoue `initialStatusForGuild` (même logique que `create`), donc une guilde dont le bot est reparti entre-temps (retiré par `remove`, ou kické manuellement) restaure sur `pending_bot`, jamais sur un `active` sans bot. |
| **Errors** | `ERR_NOT_OWNER`: `owner_id` ne correspond plus -> 403 + passage de toutes les annonces de la guilde en `hidden` + notification. `ERR_ROLE_HIERARCHY`: bot déjà présent mais rôle trop bas -> 409 avec instruction de repositionnement (M15) ; si le bot n'est simplement pas encore présent, aucune erreur — l'annonce est créée `pending_bot` (A16). `ERR_GUILD_HAS_ACTIVE_LISTING`: la guilde porte déjà une annonce `active` ou `pending_bot` -> 409, message dédié plutôt que la contrainte SQL brute (cf. 3-DebugNotes.md, fix du 2026-09-06). `ERR_LISTING_LOCKED`: annonce engagée dans une transaction non terminale -> 409 sur `update`/`remove`. `23503` (Postgres) sur le `DELETE` de `remove` : jamais remonté à l'appelant — capturé via `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` dans `listingsRepo.hardDelete`, la transaction continue et `remove` retombe sur le soft-delete (A18). |

> Covers : M1, M2, M3, M15, A1, A2, A11, A12, A16, A17, A18, A21

---

### `src/domain/matching/preferences.js` — retiré (A19)

**Supprimé.** Ce module construisait l'ordre de préférence dérivé des tags pour `ttc.js`. Les deux existaient uniquement pour servir le moteur de matching automatique TTC des échanges, lui-même retiré par A19 (`1-CheckList.md`) — initier un échange est désormais une action manuelle (`engine.proposeDirectSwap`, cf. `engine.js` ci-dessous), il n'y a plus d'ordre de préférence à calculer ni de cycle à extraire. Décision utilisateur revenant explicitement sur une exigence confirmée par le client (M4, A6 — "matching n-cycles dès v1, pas de version allégée") ; voir `3-DebugNotes.md` pour la discussion complète et l'avertissement donné avant exécution. Tout le contenu historique de cette section (ordre strict tronqué, garanties de rationalité individuelle, non-manipulabilité) reste consultable dans l'historique git de ce fichier si le TTC devait un jour revenir.

---

### `src/domain/matching/queue.js`

"File d'attente (don)"

| Field | Content |
|---|---|
| **Boundary** | Possède : gestion FIFO des candidats sur une annonce en mode `don`. NE possède PAS : le matching `echange` (cf. `engine.js` — `proposeDirectSwap`, A19), la création de transaction (cf. `engine.js`). |
| **Inputs** | `enqueue(tx, listingId, candidateUserId)` ; `dequeueHead(tx, listingId)` ; `skip(tx, listingId, candidateUserId, reason)` ; `withdraw(tx, listingId, candidateUserId)`. |
| **Outputs** | `{ position: number }` à l'inscription ; `{ candidateUserId } \| null` en tête de file. |
| **Process** | 1. Verrouiller la file de l'annonce (advisory lock sur `listingId`) -> 2. Rejeter si le candidat est déjà présent, banni, ou propriétaire de l'annonce -> 3. Insérer avec `position = max + 1` -> 4. `dequeueHead` retourne le premier candidat non retiré et non sauté -> 5. `skip` marque et laisse la position aux suivants. |
| **Guarantees** | Ordre d'arrivée strictement respecté — aucun tri par réputation, taille de communauté ou ancienneté de compte (M4 : « file d'attente simple ») ; un utilisateur n'occupe jamais deux positions sur la même annonce ; un `skip` par le donneur ne réordonne pas la file, il avance la tête ; retrait d'un candidat -> les positions restent stables (pas de renumérotation). |
| **Errors** | `ERR_ALREADY_QUEUED`: 409. `ERR_SELF_QUEUE`: candidat = propriétaire -> 400. `ERR_BANNED`: sanction plateforme active -> 403. `ERR_QUEUE_EMPTY`: `dequeueHead` -> `null`, pas de throw. |

> Covers : M4, A6

---

### `src/domain/matching/ttc.js` — retiré (A19)

**Supprimé**, avec `preferences.js` ci-dessus, à la même décision (A19). Ce module implémentait Top Trading Cycles (marche sur graphe fonctionnel, curseur monotone, cœur de Shapley-Scarf) pour découvrir automatiquement des cycles d'échange n-aires. Il n'existe plus aucun mécanisme n-aire dans le produit : `engine.proposeDirectSwap` (cf. `engine.js`) ne crée que des propositions à 2 parties, initiées manuellement. Le fichier de test associé (`ttc.test.js`, 9 cas — terminaison, disjonction, rationalité individuelle, non-régression de complexité) a été supprimé avec lui. Historique complet dans git et dans `3-DebugNotes.md` (entrée A19).

---

### `src/domain/matching/engine.js`

"Tour de matching (don) + propositions"

| Field | Content |
|---|---|
| **Boundary** | Possède : tour de matching `don` (FIFO), création de proposition manuelle pour `echange` (`proposeDirectSwap`, A19), acceptation/refus, promotion en transaction. NE possède PAS : l'algorithme de file (délégué à `queue.js`), la découverte automatique de partenaire `echange` — **retirée** (A19, c'était `preferences.js`/`ttc.js`), la période d'essai (cf. `trial.js`). |
| **Inputs** | `runRound(pool)` ; `accept(tx, userId, proposalId)` ; `refuse(tx, userId, proposalId, reason?)` ; `proposeDirectSwap(tx, actorUserId, myListingId, theirListingId)`. |
| **Outputs** | `{ proposalsCreated: number }` (`runRound`) ; propositions `match_proposals` + `match_participants` ; `publish(event.match.proposed)` ; **dès la création de la proposition** (A20), appel `trial.createTransactions` — transactions `PROPOSED` + thread hub ouverts immédiatement, plus seulement sur acceptation complète ; sur acceptation complète, appel `trial.confirmAccepted` (promotion, pas création) ; `proposeDirectSwap` retourne `{ proposal, allAccepted }`. |
| **Process** | **`runRound`** : 1. `withAdvisoryLock(MATCH_ROUND_KEY)` — sinon sortie immédiate -> 2. Balayer et dissoudre les propositions expirées (don **et** échange) -> 3. Pour chaque annonce `don` `active` ayant une file non vide et aucune proposition ouverte, `dequeueHead`, créer une proposition `kind: 'queue'`, puis **immédiatement** `trial.createTransactions` (A20 — thread hub ouvert avant que le donneur n'ait rien accepté) -> 4. Publier. **`proposeDirectSwap`** (A19, remplace l'ancienne étape 3 "échange" de `runRound`) : 1. Valider existence, propriété (`myListingId` doit appartenir à l'acteur), mode (`echange` des deux côtés), non-réflexivité (pas soi-même) -> 1bis. Vérifier la correspondance des tags (A25) : mes `tags` doivent recouper ses `seekingTags` **et** ses `tags` doivent recouper mes `seekingTags` — sinon `ERR_TAG_MISMATCH`. Seule vérification de compatibilité de tout le flux ; le choix de la cible et de l'annonce offerte reste entièrement libre en amont (`GET /annonces/:id` liste toutes les annonces `echange` actives de l'acteur, sans présélection par tags) -> 2. Vérifier l'absence de cooldown entre les deux propriétaires (`matchRepo.isOnCooldown`) -> 3. `claimForMatch` sur les deux annonces (atomique, `WHERE status = 'active'` — un échec fait échouer toute la transaction appelante, l'autre claim est annulé avec) -> 4. Créer une proposition `kind: 'cycle'` à exactement 2 participants (mécaniquement un cycle de longueur 2, forme identique à ce que produisait l'ancien TTC) -> 5. `trial.createTransactions` (A20) -> 6. Publier -> 7. Appeler `accept` pour le compte du proposeur lui-même — proposer vaut consentement, seul l'autre côté doit encore décider. **`accept`/`refuse`** (agnostiques de `kind`) : enregistrement, `accept` appelle `trial.confirmAccepted` si complet (A20 — ne crée plus rien, promeut les transactions déjà ouvertes), `refuse`/expiration dissout (`dissolveProposal`, A20 — délègue à `trial.cancel` dès qu'une transaction existe pour la proposition, plutôt que de remettre les annonces à `active` à la main) et applique un cooldown de 24 h entre les mêmes parties. |
| **Guarantees** | Deux tours de `runRound` ne s'exécutent jamais en parallèle (advisory lock) ; une annonce n'appartient jamais à deux propositions ouvertes (`claimForMatch` est l'unique porte d'entrée en `matched`) ; l'acceptation est **all-or-nothing** — même à 2 parties, une proposition ne s'exécute que si les deux acceptent, un seul refus la dissout entièrement ; le cooldown empêche qu'une proposition dissoute soit reproposée à l'identique juste après ; `proposeDirectSwap` ne dépend d'aucune notion de "cycle découvert" — c'est une action, pas un calcul, donc rien à recalculer, rien à invalider entre deux tours ; **le thread hub existe dès la création de la proposition, jamais après** (A20) — `don` et `echange` traités identiquement sur ce point, aucun cas spécial par `kind`. **Ancienne garantie retirée avec le TTC (A19)** : don et échange ne "coexistent" plus au sens d'un seul moteur symétrique — `don` reste automatique (file d'attente), `echange` est désormais 100 % initié par un propriétaire. **A25** : deux annonces `echange` sans aucune correspondance de tags dans un sens ou l'autre ne peuvent jamais former de proposition — la même exigence que l'ancien TTC imposait par construction (`preferences.js`, score de recoupement nul = candidat exclu), reprise comme simple porte binaire côté `proposeDirectSwap` puisqu'il n'y a plus de cycle à classer. |
| **Errors** | `ERR_ROUND_BUSY`: lock tenu -> retour `{ proposalsCreated: 0 }`, pas d'erreur. `ERR_NOT_PARTICIPANT`: `accept`/`refuse` par un tiers -> 403. `ERR_PROPOSAL_EXPIRED`: -> 409, annonces déjà remises en pool. `ERR_SELF_SWAP`: `theirListingId === myListingId`, ou même propriétaire des deux côtés -> 400. `ERR_NOT_OWNER`: `myListingId` n'appartient pas à l'acteur -> 403. `ERR_MODE_MISMATCH`: l'une des deux annonces n'est pas en mode `echange` -> 400. `ERR_COOLDOWN`: refus récent entre les deux propriétaires -> 409. `ERR_LISTING_LOCKED`: l'une des deux annonces n'est plus `active` au moment du `claimForMatch` (déjà engagée ailleurs entre-temps) -> 409, rien n'est écrit. |

> Covers : M4, A6, A8, A19, A20

---

### `src/domain/trial.js`

"FSM transaction"

| Field | Content |
|---|---|
| **Boundary** | Possède : **l'unique** point d'écriture de `transactions.status`, la période d'essai, la validation bilatérale, l'annulation. NE possède PAS : l'attribution effective du rôle Discord (intention émise sur le bus, exécutée par `bot/trialRole.js`), le témoin de bascule (cf. `transfer.js`). |
| **Inputs** | `createTransactions(tx, proposalId)` (A20) ; `confirmAccepted(tx, proposalId)` (A20, remplace l'ancien `open`) ; `validate(tx, userId, transactionId)` ; `cancel(tx, actorId, transactionId, reason)` ; `expire(tx, transactionId)` ; `markTransferred(tx, transactionId, observedAt)`. |
| **Outputs** | `Transaction` gelée ; intentions `intent.trial.assign` / `intent.trial.revoke` / `intent.hub.thread_create` / `intent.announce.handover` ; `publish(event.transaction.updated)`. |
| **Process** | 1. Charger et verrouiller la transaction -> 2. Vérifier que la transition demandée est autorisée depuis l'état courant -> 3. Appliquer -> 4. Émettre les intentions correspondantes -> 5. Auditer -> 6. Retourner l'état. **`createTransactions`** (A20, appelée par `engine.js` dès qu'une proposition est créée — `don` et `echange`, pas seulement une fois acceptée) : calcule les arêtes (une par annonce `don`, une par participant d'un `cycle`), insère une transaction par arête en `PROPOSED`, publie `intent.hub.thread_create` immédiatement — **avant** toute acceptation. **`confirmAccepted`** (appelée par `engine.accept` une fois tous les participants d'accord) : retrouve les transactions déjà créées (`transactionsRepo.findByProposalId`), les fait passer `PROPOSED` -> `ACCEPTED`, publie `intent.trial.assign` — ne crée plus jamais de transaction ni de thread, les deux existent déjà. |
| **Sub-FSM: Transaction** | `PROPOSED` (thread hub déjà ouvert, A20 — les parties peuvent discuter avant de s'engager) -> (n acceptations) -> `ACCEPTED` -> (rôle essai attribué) -> `TRIAL` -> (validation des 2 parties) -> `TRIAL_VALIDATED` -> (bascule `owner_id` observée) -> `TRANSFERRED` -> (fenêtre de litige écoulée ou litige résolu) -> `CLOSED`. Sorties latérales : `PROPOSED`\|`ACCEPTED`\|`TRIAL` -> `CANCELLED` (révocation du rôle si un a été attribué — jamais le cas depuis `PROPOSED`) ; `TRIAL` -> (`trial_ends_at` atteint sans double validation) -> `EXPIRED` (révocation du rôle) ; `TRANSFERRED` -> `DISPUTED` (cf. `dispute.js`) -> `CLOSED`. |
| **Sub-FSM: Validation** | `NONE` -> `validate(from)` -> `FROM_ONLY` -> `validate(to)` -> `BOTH` ; et `NONE` -> `validate(to)` -> `TO_ONLY` -> `validate(from)` -> `BOTH`. Toute annulation par l'une des parties réinitialise à `NONE` et sort de la FSM transaction vers `CANCELLED`. |
| **Guarantees** | Aucune transition non déclarée n'est possible — la table de transitions est exhaustive et fermée ; `TRIAL` n'implique **jamais** de transfert de `owner_id` : le destinataire reçoit un rôle à permission Administrateur, ce qui exclut par construction les actions réservées au propriétaire (supprimer la guilde, transférer la propriété) — l'escrow tient donc sans confiance mutuelle (M11) ; l'annulation en essai est **unilatérale** côté propriétaire réel et ne dépend d'aucun consentement (M13) — précision de portée : l'unilatéralité porte sur l'**accès** (le propriétaire surclasse toute hiérarchie de rôles, y compris hors plateforme et bot éteint), tandis que la mise à jour de l'**état plateforme** est bornée par la détection décrite dans `bot/guildWatcher.js`, jamais instantanée par construction ; la durée d'essai est lue dans `settings.trial_duration_days` (défaut 3, A15 puis A34 — abaissé de 7 à 3 jours, nouveau défaut global appliqué par migration aux réglages existants, cf. `007_trial_reminders_and_default.sql`), jamais codée en dur ; le passage à `TRANSFERRED` n'est déclenché que par une observation de `ownership.js`, jamais par une déclaration d'une partie (M6/M12) ; `trial_ends_at` est fixé à l'entrée en `TRIAL`, un changement ultérieur du réglage n'affecte pas les essais en cours ; **le thread hub existe dès `PROPOSED`** (A20) — les deux parties peuvent échanger avant de s'engager, ce n'est plus une récompense de l'engagement mutuel ; `createTransactions` ne s'exécute jamais deux fois pour la même proposition (`persistQueueMatch`/`proposeDirectSwap` l'appellent une seule fois, juste après `matchRepo.createProposal`), et `confirmAccepted` ne crée jamais de nouvelle transaction — elle ne fait que promouvoir celles qui existent déjà, retrouvées via `transactionsRepo.findByProposalId`. |
| **Errors** | `ERR_BAD_TRANSITION`: transition non autorisée -> 409 avec l'état courant, aucune écriture. `ERR_NOT_PARTY`: acteur hors des deux parties -> 403. `ERR_ROLE_ASSIGN_FAILED` (remonté du bot) -> transaction ramenée en `ACCEPTED`, notification aux deux parties, essai non démarré (le chrono ne court pas sur un rôle non attribué). `ERR_ALREADY_VALIDATED`: revalidation -> no-op idempotent, 200. |

> Covers : M11, M12, M13, M15, A14, A15, A20, A34

---

### `src/domain/transfer.js`

"Témoin de bascule"

| Field | Content |
|---|---|
| **Boundary** | Possède : interprétation d'un `event.ownership.changed` au regard des transactions en cours, horodatage certifié du transfert, déclenchement de l'annonce de passation. NE possède PAS : l'exécution du transfert — impossible par l'API Discord, toujours manuelle (M12), c'est une contrainte, pas une limite d'implémentation. |
| **Inputs** | Handler de `event.ownership.changed` : `{ guildId, previousOwnerId, newOwnerId, observedAt, source }`. |
| **Outputs** | Appel `trial.markTransferred` ; `intent.announce.handover` ; `intent.trial.revoke` (le rôle d'essai n'a plus d'objet) ; `intent.hub.thread_archive` (différé de 7 j) ; ligne `audit_log` `actor: 'bot'`. |
| **Process** | 1. Chercher une transaction non terminale sur `guildId` -> 2. Si absente, enregistrer l'événement en historique et sortir (bascule hors plateforme, non hostile) -> 3. Si `newOwnerId === transaction.to_user.discord_id` et état `TRIAL_VALIDATED`, appeler `markTransferred(observedAt)` -> 4. Si état `TRIAL` (transfert anticipé, avant double validation), accepter la bascule, marquer `TRANSFERRED` et journaliser un écart `EARLY_TRANSFER` -> 5. Si `newOwnerId` est un tiers, marquer `CANCELLED` avec motif `OWNER_DIVERTED` et ouvrir un signalement automatique -> 6. Révoquer le rôle d'essai -> 7. Publier l'annonce. |
| **Guarantees** | L'horodatage retenu est celui de l'observation Gateway quand elle existe, sinon celui du sweep, jamais une valeur déclarée par un utilisateur ; les deux côtés sont couverts : le départ chez l'ancien propriétaire et l'arrivée chez le nouveau sont la même observation atomique de `owner_id` (M6) ; un transfert anticipé n'est jamais annulé rétroactivement — l'état réel Discord prime toujours sur l'état plateforme ; idempotent : rejouer l'événement ne reposte pas l'annonce (`transferred_at` déjà renseigné -> sortie). |
| **Errors** | `ERR_NO_TRANSACTION`: aucune transaction -> historisation seule, pas d'erreur. `ERR_OWNER_DIVERTED`: bascule vers un tiers -> annulation + signalement automatique assigné à la modération. `ERR_ANNOUNCE_FAILED`: cf. `announce.js` — n'invalide jamais le transfert. |

> Covers : M6, M7, M12, A5

---

### `src/domain/dispute.js`

"Litiges post-transfert"

| Field | Content |
|---|---|
| **Boundary** | Possède : ouverture, instruction et clôture d'un litige après bascule réelle de `owner_id`. NE possède PAS : l'annulation pendant l'essai (cf. `trial.cancel`, chemin nominal et automatique), l'exécution d'un retour — toujours manuelle (M14). |
| **Inputs** | `open(tx, actorId, transactionId, { reason, body })` ; `assign(tx, actorId, disputeId, assigneeId)` ; `addNote(tx, actorId, disputeId, body, visibility: 'internal'\|'parties')` ; `resolve(tx, actorId, disputeId, { outcome: 'return_expected'\|'rejected'\|'settled', body })` ; `confirmReturn(tx, disputeId)`. |
| **Outputs** | `Dispute` avec `timeline` JSONB ; notifications aux deux parties ; transaction en `DISPUTED` puis `CLOSED`. |
| **Process** | 1. Vérifier `status === 'TRANSFERRED'` et fenêtre `settings.dispute_window_days` non écoulée -> 2. Créer le dossier, passer la transaction en `DISPUTED` -> 3. Notifier les deux parties (thread hub rouvert) -> 4. Instruction par l'équipe : notes, pièces, décision -> 5. Sur `return_expected`, attendre une observation `ownership.changed` ramenant `owner_id` vers l'ancien propriétaire -> 6. `confirmReturn` sur cette observation -> 7. Clôturer. |
| **Guarantees** | Le retour effectif n'est jamais réputé fait sur déclaration : seule une observation de `owner_id` par le bot le confirme (même mécanisme que M6) ; la timeline est append-only, chaque entrée horodatée et attribuée ; les deux parties sont notifiées à chaque changement d'état, sans exception ; un litige n'invalide jamais l'historique de transaction — rien n'est réécrit, on empile ; les avis restent publiés pendant le litige, mais le dossier est visible côté panel (M9/M14). |
| **Errors** | `ERR_WINDOW_CLOSED`: hors fenêtre -> 409, orientation vers le support. `ERR_NOT_TRANSFERRED`: transaction non basculée -> 409, redirection vers `trial.cancel`. `ERR_DUPLICATE_DISPUTE`: dossier déjà ouvert -> 409 avec l'id existant. `ERR_RETURN_NOT_OBSERVED`: clôture demandée sans observation -> refus, le dossier reste ouvert. |

> Covers : M14, A14

---

### `src/domain/reputation.js`

"Avis et anti-fraude"

| Field | Content |
|---|---|
| **Boundary** | Possède : dépôt d'avis, calcul des agrégats, règles anti-fraude, attribution du tag « Vérifié ». NE possède PAS : la suppression d'avis par l'admin (traversée par `moderation.js` pour l'audit), la croissance de communauté — aucune métrique de croissance n'existe (A3). |
| **Inputs** | `submit(tx, authorId, transactionId, { rating: 1..5, body: string 0..1000 })` ; `aggregate(tx, userId)` ; `history(tx, userId, page)` ; `evaluateVerified(tx, userId)`. |
| **Outputs** | `Review` ; `{ count: number, average: number \| null, distribution: number[5], asGiver, asReceiver }` ; `boolean` pour le statut vérifié. |
| **Process** | 1. Vérifier `transaction.status ∈ { TRANSFERRED, CLOSED }` -> 2. Vérifier que l'auteur est l'une des deux parties -> 3. Vérifier `author_id <> target_id` (redondant avec le `CHECK` base, volontairement) -> 4. Vérifier l'absence d'avis existant sur ce couple -> 5. Insérer -> 6. Recalculer l'agrégat -> 7. Réévaluer le tag vérifié -> 8. Auditer. |
| **Guarantees** | Un avis exige une transaction **aboutie** dont l'auteur est partie — il n'existe aucun chemin de création d'avis hors transaction, ce qui rend le faux avis coûteux plutôt qu'interdit par heuristique (M9) ; l'auto-évaluation est impossible à deux niveaux (applicatif + `CHECK` base) ; un avis masqué reste en base et sort des agrégats — jamais de suppression physique ; la moyenne est `null` et non `0` en l'absence d'avis (un compte neuf n'est pas un mauvais compte) ; les conditions du tag « Vérifié » sont lues dans `settings.verified_rules` (`{ minTransactions, minAverage, minAccountAgeDays, noActiveSanction }`) et sont modifiables à chaud par l'admin, le tag étant recalculé et donc **retirable** automatiquement (M9). |
| **Errors** | `ERR_NO_TRANSACTION`: 403. `ERR_NOT_PARTY`: 403. `ERR_SELF_REVIEW`: 400. `ERR_ALREADY_REVIEWED`: 409. `ERR_RATE_LIMITED`: > 5 avis / 24 h pour un même auteur -> 429 + signalement automatique. |

> Covers : M9, A3, §2bis Avis/Réputation

---

### `src/domain/moderation.js`

"Signalements et sanctions"

| Field | Content |
|---|---|
| **Boundary** | Possède : réception des signalements, cycle de vie des dossiers, sanctions **plateforme uniquement**. NE possède PAS : toute action sur un serveur Discord réel — un ban Xyro Market n'expulse personne d'un serveur, ne retire aucun rôle hors essai en cours (A13). |
| **Inputs** | `report(tx, reporterId, { targetType: 'user'\|'listing'\|'review'\|'message', targetId, reason: enum, body })` ; `assign`, `resolve`, `addNote` ; `sanction(tx, actorId, userId, { kind: 'ban_temp'\|'ban_perm'\|'suspend'\|'warn', reason, endsAt? })` ; `lift(tx, actorId, sanctionId, reason)`. |
| **Outputs** | `Report`, `Sanction` ; `publish(event.moderation.action)` ; invalidation du cache RBAC et de session. |
| **Process** | 1. Vérifier la capacité via `rbac.can` -> 2. Enregistrer -> 3. Sur sanction : masquer les annonces actives de l'utilisateur, le retirer des files d'attente, dissoudre ses propositions ouvertes -> 4. **Ne pas** toucher aux transactions en `TRIAL` ou postérieures : elles suivent leur FSM, un ban n'annule pas un engagement en cours (il est traité en litige si besoin) -> 5. Auditer avec `before`/`after` -> 6. Publier. |
| **Guarantees** | Aucune sanction plateforme n'entraîne d'appel d'API Discord modifiant un serveur tiers (A13) — la seule exception est la révocation du rôle d'essai, et elle passe par la FSM, pas par ici ; toute sanction est réversible et l'historique conserve l'acteur, le motif et le traitant (§2bis Modération) ; un utilisateur banni conserve l'accès à ses données personnelles (droits RGPD non suspendus par sanction) ; les signalements automatiques (`OWNER_DIVERTED`, `ERR_RATE_LIMITED`) entrent par le même point que les signalements humains. |
| **Errors** | `ERR_FORBIDDEN`: capacité absente -> 403. `ERR_SELF_SANCTION`: 400. `ERR_TARGET_MISSING`: cible supprimée -> dossier créé en `stale`, pas d'échec. `ERR_ALREADY_SANCTIONED`: sanction active de même nature -> 409 avec proposition de prolongation. |

> Covers : M10, A13, §2bis Modération/Signalements |

---

### `src/domain/gdpr.js`

"Droits des personnes"

| Field | Content |
|---|---|
| **Boundary** | Possède : export, rectification, suppression de compte par pseudonymisation, révocation OAuth, purge des jetons. NE possède PAS : le contenu rédactionnel des pages légales (statique, cf. `routes/public.js`), le rôle de responsable de traitement — assumé par Le_Club en personne physique (A7). |
| **Inputs** | `exportData(tx, userId)` ; `rectify(tx, userId, patch)` ; `requestDeletion(tx, userId)` ; `executeDeletion(tx, userId)`. |
| **Outputs** | Archive JSON (profil, annonces, transactions, avis, signalements émis, historique) ; effet : `users` pseudonymisé, `oauth_tokens` supprimés. |
| **Process** | 1. Marquer `deletion_requested_at` -> 2. Fenêtre de rétractation de 7 j pendant laquelle le compte est suspendu -> 3. À l'échéance, remplacer `discord_id` par un jeton opaque non réversible, vider `username`/`avatar_hash`, poser `deleted_at` -> 4. Supprimer les jetons OAuth et révoquer côté Discord -> 5. Masquer les annonces, retirer des files -> 6. Conserver `transactions`, `reviews`, `disputes`, `audit_log` en pointant sur le compte pseudonymisé -> 7. Auditer. |
| **Guarantees** | Aucune donnée personnelle identifiante ne subsiste après exécution, mais l'intégrité des transactions et des avis de tiers est préservée — les FK sont `RESTRICT`, la suppression est une pseudonymisation, jamais un `DELETE` en cascade ; une demande de suppression avec une transaction non terminale est refusée avec motif explicite (obligation contractuelle en cours) ; l'export contient toutes les données du sujet et aucune donnée d'un tiers (les corps d'avis reçus sont inclus, les identités des auteurs sont pseudonymisées). |
| **Errors** | `ERR_ACTIVE_TRANSACTION`: 409, liste des transactions bloquantes. `ERR_ALREADY_DELETED`: no-op idempotent. `ERR_REVOKE_FAILED`: échec côté Discord -> pseudonymisation effectuée quand même, jeton purgé localement, réessai journalisé. |

> Covers : M8, A7

---

### `src/domain/stats.js`

"Définition des métriques"

| Field | Content |
|---|---|
| **Boundary** | Possède : la **définition** de chaque métrique du panel (§2bis Statistiques), les vues matérialisées qui les portent, leur horizon de fraîcheur et sa restitution à l'appelant. NE possède PAS : l'ordonnancement du rafraîchissement (déclenché par `jobs/main.js`), le rendu (cf. `admin.js`), les agrégats de réputation par utilisateur (cf. `reputation.aggregate` — lecture temps réel, pas une statistique de plateforme). |
| **Inputs** | `read(tx, metric: MetricKey, range: { from, to, granularity: 'day' \| 'week' \| 'month' })` ; `refreshAll(tx)` ; `MetricKey` ∈ { `users.total`, `users.new`, `users.active`, `users.verified`, `users.sanctioned`, `listings.total`, `listings.active_by_mode`, `listings.by_tag`, `transactions.by_status`, `transactions.completed`, `transactions.median_time_to_transfer`, `transactions.trial_expiry_rate`, `reviews.total`, `reviews.average`, `reports.open`, `reports.median_resolution_time`, `disputes.open`, `matching.cycle_size_distribution`, `activity.recent` }. |
| **Outputs** | `{ metric, points: { bucket: Date, value: number }[], computedAt: Date, stale: boolean }` ; vues matérialisées `mv_stats_*` ; `activity.recent` retourne un flux dérivé de `audit_log` et `transactions`, borné aux 100 dernières entrées. |
| **Process** | 1. Résoudre la vue portant la métrique -> 2. Lire `computedAt` -> 3. Marquer `stale: true` si l'écart dépasse deux fois la période de rafraîchissement -> 4. Filtrer par `range` -> 5. Retourner. `refreshAll` : rafraîchit chaque vue en `CONCURRENTLY`, en séquence, en journalisant durée et lignes produites. |
| **Guarantees** | Une métrique a **une seule** définition, ici et nulle part ailleurs — aucune route admin ne recalcule un compteur par une requête ad hoc, ce qui interdit qu'un même chiffre diverge entre deux écrans ; toute lecture expose sa fraîcheur (`computedAt`, `stale`) : le panel affiche un chiffre daté, jamais un chiffre présenté comme temps réel alors qu'il ne l'est pas ; `REFRESH ... CONCURRENTLY` garantit qu'aucune lecture n'est bloquée pendant un rafraîchissement ; les métriques sont calculées sur données pseudonymisées comprises — un compte supprimé au sens RGPD reste compté dans les totaux historiques sans être ré-identifiable (cohérent avec `gdpr.js`) ; aucune métrique de croissance de communauté n'existe (A3, snapshot cron retiré en Phase I). |
| **Errors** | `ERR_UNKNOWN_METRIC`: clé hors énumération -> 400, jamais d'interpolation d'un nom de vue depuis l'entrée utilisateur. `ERR_REFRESH_FAILED`: échec sur une vue -> les autres sont rafraîchies quand même, la vue en échec reste servie avec `stale: true`, alerte après 3 échecs consécutifs. `ERR_RANGE_TOO_WIDE`: > 730 jours en granularité `day` -> 422 avec proposition de granularité supérieure. |

> Covers : M10, §2bis Statistiques

---

### `src/web/main.js`

"Entrée HTTP"

| Field | Content |
|---|---|
| **Boundary** | Possède : instanciation Fastify, ordre des plugins, arrêt propre, exposition `/healthz`. NE possède PAS : logique de route (déléguée), accès direct à discord.js (interdit dans ce process). |
| **Inputs** | `Config` ; modules de routes. |
| **Outputs** | Serveur en écoute sur `Config.WEB_PORT` derrière un reverse proxy TLS. |
| **Process** | 1. Logger (pino, redaction) -> 2. `trustProxy` -> 3. Helmet + CSP stricte -> 4. Rate limit global (100 req/min/IP) -> 5. Cookies signés + session -> 6. CSRF -> 7. Moteur de vues -> 8. Statique avec cache long + hash -> 9. Routes `public`, `user`, `admin` -> 10. Handler d'erreur unique -> 11. `listen` -> 12. Sur `SIGTERM`, arrêt des nouvelles connexions puis fermeture du pool. |
| **Guarantees** | CSP sans `unsafe-inline` — aucun script inline dans les vues ; toute erreur non capturée retourne une page ou un JSON générique, jamais une stack trace, et est loggée avec un identifiant de corrélation rendu à l'utilisateur ; les routes admin ne sont montées qu'après le middleware de session et RBAC ; le process ne démarre pas si les migrations en attente ne sont pas nulles. |
| **Errors** | `ERR_PORT_IN_USE`: exit 1. `ERR_UNCAUGHT`: log fatal + exit 1 (systemd relance) — jamais de reprise silencieuse. `ERR_RATE_LIMITED`: 429 avec `Retry-After`. |

> Covers : F1, F2, M8, M10

---

### `src/web/auth/oauth.js`

"OAuth2 Discord"

| Field | Content |
|---|---|
| **Boundary** | Possède : flow OAuth2 code grant avec `identify` + `guilds`, stockage chiffré des jetons, rafraîchissement, synchronisation des guildes possédées. NE possède PAS : la session applicative (cf. `session.js`), l'appel bot (jeton distinct). |
| **Inputs** | `buildAuthUrl(state)` ; `handleCallback({ code, state })` ; `refresh(tx, userId)` ; `syncOwnedGuilds(tx, userId)` ; `buildBotInviteUrl(guildId)` — colocalisé ici pour la seule raison pratique qu'il lit `Config.discordClientId` comme `buildAuthUrl`, mais ce n'est pas un flow OAuth : pas de `state`, pas de `handleCallback`, Discord ne redirige nulle part après consentement (A16). |
| **Outputs** | `{ user: User, ownedGuilds: Guild[] }` ; lignes `oauth_tokens` chiffrées ; observations vers `ownership.observe(source: 'oauth')`, y compris désassignation (`ownership.UNOWNED`, A26) ; pour `buildBotInviteUrl`, une simple URL — aucun état stocké, aucune écriture. |
| **Process** | `handleCallback` : 1. Générer `state` aléatoire lié à la session, TTL 10 min -> 2. Rediriger vers Discord avec les deux scopes exactement -> 3. Au retour, vérifier `state` -> 4. Échanger le code -> 5. `GET /users/@me` et `GET /users/@me/guilds` -> 6. Filtrer `owner === true` -> 7. Upsert `users` et `guilds` -> 8. Pour chaque guilde possédée, `ownership.observe` -> 9. Chiffrer et stocker les jetons -> 10. Ouvrir la session. `syncOwnedGuilds` (A26) : 1-2. Mêmes étapes 5-6 ci-dessus (refresh du jeton d'abord si expiré) -> 3. `ownership.observe` pour chaque guilde actuellement possédée (comme ci-dessus) -> 4. Comparer à `guildsRepo.listOwnedByDiscordId` (état stocké pour cet utilisateur) -> 5. Pour toute guilde qui y figurait mais n'apparaît plus dans la liste Discord fraîche, et qui n'a pas de transaction ouverte (`transactionsRepo.findOpenByGuild` — le signal de transfert en cours fait autorité via le bot, pas via cette liste périmée), `ownership.observe(ownerDiscordId: UNOWNED)`. |
| **Guarantees** | Scopes minimaux : `identify` + `guilds` uniquement, jamais `email` ni `guilds.join` (M1) ; `state` à usage unique, lié à la session, expirant — CSRF sur le callback impossible ; les jetons sont chiffrés au repos en AES-256-GCM sous `Config.TOKEN_ENC_KEY` — racine distincte de la signature de session, jamais dérivée d'elle — et ne sortent jamais du process web ; chaque ciphertext porte un préfixe de version de clé (`v1:`) et un nonce unique, ce qui rend la rotation possible sans migration en une passe (déchiffrement multi-version, rechiffrement paresseux au prochain refresh) ; la liste des guildes possédées via OAuth est une observation parmi trois, jamais la vérité seule (elle peut être périmée de plusieurs minutes) ; un refresh échoué déconnecte proprement plutôt que de servir des données périmées ; `buildBotInviteUrl` verrouille toujours `guild_id` + `disable_guild_select=true` — le propriétaire ne peut pas ajouter le bot à un autre serveur que celui pour lequel il vient de publier une annonce (A16) ; `syncOwnedGuilds` réconcilie aussi les guildes qui disparaissent de la liste Discord (A26) — une guilde supprimée, quittée, ou dont l'ownership a été transférée hors-plateforme ne reste plus jamais indéfiniment listée dans "Mes serveurs" pour son ancien propriétaire. **A34** : `BOT_INVITE_PERMISSIONS` inclut désormais le bit `Create Instant Invite` (nécessaire à `trialRole.inviteRecipient`, cf. bloc `bot/trialRole.js`) et le scope demandé passe de `bot` seul à `bot applications.commands` (nécessaire à l'enregistrement des commandes slash, cf. bloc `bot/main.js`) — n'affecte que les invitations **futures** du bot ; les guildes où le bot est déjà installé conservent l'ancien jeu de permissions/scopes jusqu'à une réinvitation. |
| **Errors** | `ERR_STATE_MISMATCH`: 400, session invalidée. `ERR_KEY_VERSION_UNKNOWN`: préfixe de version absent du trousseau -> jeton traité comme illisible, déconnexion et reconnexion OAuth demandée, aucune tentative de déchiffrement en aveugle. `ERR_CODE_EXCHANGE`: 502 + retry manuel proposé. `ERR_TOKEN_EXPIRED`: refresh transparent ; si le refresh échoue -> déconnexion + reconnexion demandée. `ERR_DISCORD_RATE_LIMIT` (429): respect de `retry_after`, backoff, jamais de boucle serrée. |

> Covers : M1, M2, A16, A34

---

### `src/web/auth/session.js`

"Session et CSRF"

| Field | Content |
|---|---|
| **Boundary** | Possède : cookie de session signé, chargement de l'identité et des capacités par requête, garde d'authentification. NE possède PAS : les permissions elles-mêmes (cf. `rbac.js`), le flow OAuth. |
| **Inputs** | Cookie `xm_sid` ; `requireAuth(req)` ; `requirePermission(permission)`. |
| **Outputs** | `req.user: { id, discordId, username, isVerified, sanctions }` ; `req.caps: Set<Permission>`. |
| **Process** | 1. Lire et vérifier la signature du cookie -> 2. Charger la session (table `sessions`, pas de store mémoire — trois process, un seul état) -> 3. Charger l'utilisateur -> 4. Rejeter si sanction bloquante active -> 5. Résoudre les capacités -> 6. Renouveler le TTL glissant (30 j). |
| **Guarantees** | Cookie `HttpOnly`, `Secure`, `SameSite=Lax`, signé — pas de donnée applicative dans le cookie, seulement un identifiant opaque ; la session est révocable côté serveur, donc un ban prend effet à la requête suivante et non à l'expiration du cookie ; `requirePermission` appelle toujours `rbac.can`, aucune route ne teste un nom de rôle ; toute mutation d'état passe par une vérification CSRF (jeton par session, comparé en temps constant). |
| **Errors** | `ERR_UNAUTHENTICATED`: 302 vers le flow OAuth (HTML) ou 401 (JSON). `ERR_SESSION_REVOKED`: cookie effacé + 302. `ERR_CSRF`: 403, aucune écriture. `ERR_SANCTIONED`: 403 avec motif et échéance. |

> Covers : M1, M10, A13

---

### `src/web/routes/public.js`

"Vitrine et légal"

| Field | Content |
|---|---|
| **Boundary** | Possède : pages accessibles sans authentification — accueil, recherche/filtre d'annonces, recherche libre (A28), fiche annonce, profil public, et **l'intégralité des pages légales**. NE possède PAS : toute mutation d'état. |
| **Inputs** | `GET /`, `/annonces?tags=&mode=&q=&search=&cursor=` (`search` non vide bascule sur `listingsRepo.search` + `usersRepo.searchByUsername` (A30 — pseudo substring seulement, pas de correspondance exacte par UUID/Discord ID, sans objet pour un visiteur public), top-N sans curseur, exclusif des autres filtres — A28), `/annonces/:id`, `/u/:id`, `/mentions-legales`, `/cgu`, `/confidentialite`, `/cookies`, `/propriete-intellectuelle`, `/donnees-personnelles`, `/droits-rgpd`, `/suppression-donnees`, `/securite`, `/reglement`, `/regles-discord`, `/anti-fraude`, `/anti-abus`, `/signalement`, `/retractation`. |
| **Outputs** | HTML rendu serveur ; `robots.txt`, `sitemap.xml`. |
| **Process** | 1. Valider les paramètres de requête -> 2. Interroger `listingsRepo.listPublic`/`.search` / `reputation.aggregate` -> 2bis. Batch-fetch (`lookupMaps`, un aller-retour par table, jamais un par ligne) le nom de guilde et le pseudo propriétaire des annonces affichées (A28) -> 3. Rendre -> 4. Poser les en-têtes de cache (annonces : `private, max-age=0` ; légal : `public, max-age=3600`). |
| **Guarantees** | Les 14 pages légales de M8 existent et sont atteignables depuis le footer de toute page ; `/retractation` porte explicitement la clause « service actuellement gratuit » (F4) ; aucun `discord_id` brut n'est exposé sur un profil public — identifiant interne uniquement ; les annonces masquées ou supprimées renvoient 404, jamais un contenu partiel ; la bannière cookies est requise avant tout dépôt non essentiel, et aucun traceur tiers n'est chargé. **Depuis A28** : le nom du serveur Discord et le pseudo du propriétaire sont publics — décision produit prise en session (rien avant ça ne les exposait, y compris sur la fiche annonce elle-même), toujours affichés ensemble avec la même paire de données (jamais l'un sans l'autre, jamais le `discord_id`), de façon cohérente entre le browse par défaut, la recherche et la fiche annonce — pas juste dans les résultats de recherche. **Depuis A31** : `/u/:id` liste aussi les serveurs de l'utilisateur, filtrés à `status = 'active'` — la même règle de visibilité que partout ailleurs sur le site public ; une annonce `hidden`/`removed`/`matched`/`pending_bot` n'apparaît pas plus ici qu'ailleurs. |
| **Errors** | `ERR_NOT_FOUND`: 404 page dédiée. `ERR_BAD_QUERY`: paramètre invalide -> ignoré avec valeur par défaut, jamais 400 sur une page publique. |

> Covers : M8, F4, A7, A28, A30, A31

---

### `src/web/routes/user.js`

"Espace authentifié"

| Field | Content |
|---|---|
| **Boundary** | Possède : les routes d'action de l'utilisateur connecté. NE possède PAS : la logique — chaque route est un adaptateur mince vers `src/domain/`. |
| **Inputs** | `GET /me` ; `GET /me/serveurs` ; `POST /annonces` ; `PATCH /annonces/:id` ; `DELETE /annonces/:id` ; `POST /annonces/:id/supprimer` (A17 — équivalent form-friendly de `DELETE /annonces/:id`, un `<form>` HTML ne sait poster qu'en GET/POST) ; `POST /annonces/:id/file` (rejoindre la file, mode don) ; `DELETE /annonces/:id/file` ; `GET /matchs` ; `POST /matchs/:id/accepter` ; `POST /matchs/:id/refuser` ; `GET /transactions/:id` ; `POST /transactions/:id/valider` ; `POST /transactions/:id/annuler` ; `POST /transactions/:id/litige` ; `POST /transactions/:id/avis` ; `POST /signalements` ; `GET /me/export` ; `POST /me/suppression`. |
| **Outputs** | HTML ou JSON selon `Accept` ; redirections POST/Redirect/GET. |
| **Process** | 1. `requireAuth` -> 2. Valider le corps (schéma Zod par route) -> 3. `withTransaction` -> 4. Appeler la fonction domaine -> 5. Mapper l'erreur domaine en code HTTP -> 6. Rendre. |
| **Guarantees** | Une route n'écrit jamais en base directement ni ne décide d'une règle métier ; toute route mutante est en POST/PATCH/DELETE, protégée CSRF, et exécutée dans une transaction unique ; `GET /me/serveurs` déclenche `syncOwnedGuilds` au plus une fois par minute et par utilisateur (débit maîtrisé côté Discord) ; les erreurs domaine ont un mapping HTTP unique et documenté, aucune route n'invente son propre code. `GET /tableau-de-bord` (HTML) sépare les serveurs possédés en "publiés" (annonce `active`) et "non publiés" (aucune annonce, ou `pending_bot` avec un lien direct vers `oauth.buildBotInviteUrl`) ; `GET /annonces/nouvelle` ne propose que les serveurs sans annonce vivante (A16) ; `POST /annonces`, si le résultat est `pending_bot`, redirige (soumission formulaire) ou renvoie `botInviteUrl` (JSON) au lieu de la page de confirmation habituelle ; le bouton "Supprimer" du tableau de bord apparaît sur tout statut que `remove` accepte (`active`/`pending_bot`/`hidden`/`removed`, cf. `assertMutable`) — jamais sur `matched`/`fulfilled` (A17) ; `removed` reste cliquable exprès (A18) : `remove` supprime physiquement dès que possible, donc une annonce déjà `removed` (ligne héritée d'avant A24, ou d'un repli défensif désormais rarissime) peut être re-soumise pour retenter la suppression réelle — et y parvient désormais dans tous les cas connus (A24, migration 005). Depuis A32, `GET /tableau-de-bord` affiche un lien "Panel admin" quand `req.caps.size > 0` (déjà résolu par `requireAuth`, aucun appel supplémentaire) — jusque-là le panel (A27) n'était atteignable qu'en connaissant `/admin` de mémoire, aucune page du site n'y menait. Toujours pas de self-service pour devenir le tout premier admin (gap noté sous A27, non résolu). |
| **Errors** | Mapping fixe : `ERR_FORBIDDEN`/`ERR_NOT_PARTY`/`ERR_NOT_OWNER` -> 403 ; `ERR_CONFLICT`/`ERR_BAD_TRANSITION`/`ERR_ALREADY_*` -> 409 ; `ERR_*_MISSING`/`NOT_FOUND` -> 404 ; validation -> 422 avec le détail des champs ; `ERR_RATE_LIMITED` -> 429 ; inattendu -> 500 + identifiant de corrélation. |

> Covers : M1, M3, M4, M9, M11, M12, M13, M14, M8, A16, A17, A18, A32 |

---

### `src/web/routes/admin.js`

"Panel administrateur"

| Field | Content |
|---|---|
| **Boundary** | Possède : les 9 domaines fonctionnels du panel (§2bis), montés sous `/admin`, chacun gardé par une permission granulaire ; le rendu HTML de chaque route (A27 — avant ça, ces 24 routes n'existaient qu'en JSON brut, sans interface, même trou que `/matchs` avant A17) ; la recherche libre (A28, `GET /admin/search`). NE possède PAS : la logique métier — délégation intégrale au domaine ; aucune action Discord réelle n'est exposée (A13) ; un mécanisme de bootstrap pour le tout premier `proprietaire` (`rbac.assignRole` exige déjà `rbac.grant`, donc déjà posséder un rôle — fait aujourd'hui par `INSERT` SQL direct). |
| **Inputs** | `Utilisateurs` (`/admin/users/:id`) : profil, sanctionner (ban temp/perm, suspension, avertissement — durée saisie en jours, jamais en date exacte), lever une sanction, historique, attribuer/retirer un rôle, accorder/retirer une permission directe. `Annonces` (`/admin/listings?status=&guildId=`) : liste filtrable par statut (tous statuts, pas seulement `active` — `listingsRepo.listForModeration`, distincte de la vitrine publique `listPublic`) et par guilde (A28 — la destination d'un résultat "serveur" en recherche), masquer, restaurer. Il n'existe pas de "valider/refuser" séparé : `listings.moderate` est une permission seedée mais aucune route/domaine ne la vérifie aujourd'hui — la modération d'annonce ne passe que par masquer/restaurer (A12, a posteriori). `Signalements` (`/admin/reports`) : liste filtrable par statut, assigner, résoudre, note interne. `Avis` (`/admin/reviews/:userId`) : historique, masquer (frauduleux). `Permissions` (`/admin/rbac`) : référence lecture seule des rôles/permissions — l'attribution elle-même se fait depuis la fiche utilisateur cible. `Transactions` (`/admin/transactions?status=&guildId=`, liste — A33, comblait un vrai trou : seul le détail par UUID connu existait jusque-là ; `/admin/transactions/:id`) : détail, litige ouvert -> trancher (retour attendu/rejeté/réglé). `Configuration` (`/admin/settings`) : une valeur JSON libre par clé, éditée comme texte brut (`JSON.parse` côté serveur) plutôt qu'un formulaire par clé — générique, couvre toute clé présente ou future sans code dédié. `Statistiques` (`/admin/stats`) : un index de liens vers chacune des 19 `METRIC_KEYS`, puis une table des points/items retournés par `stats.read`. `Logs` (`/admin/audit`) : table filtrable par acteur/action/type de cible (pas par cible précise — l'API ne le permet pas). `Recherche` (`/admin/search?q=`, A28) : utilisateurs (pseudo substring, UUID exact, Discord ID exact — `usersRepo.searchByUsername`/`findById`/`findByDiscordId`), serveurs (nom substring, snowflake exact — `guildsRepo.searchByName`/`findById`, chaque résultat pointe vers `/admin/listings?guildId=`), annonces (`listingsRepo.search`, toutes tags/serveur/propriétaire confondus, tous statuts — un serveur trouvé par le tag de son annonce vivante actuelle, A29 ; chaque ligne affiche le nom du serveur en tête, batch-fetché via `guildsRepo.findByIds`, plus les tags ayant matché — pas juste le `guildId` brut). Chaque catégorie de résultat filtrée par la capacité `*.read` correspondante, comme les liens de l'index. |
| **Outputs** | HTML par défaut (navigation, formulaires `<form>` classiques) ; JSON sur `Accept: application/json` explicite (`wantsJson`) — même route, double sortie, comme `web/routes/user.js`. Pas d'export CSV. Toute mutation qui passe par le domaine produit une ligne `audit_log` dans la même transaction (`reviews.hide` et `settings.set` n'ont pas de wrapper domaine dédié et auditent inline, comme avant A27). |
| **Process** | 1. `requireAuth` -> 2. `requirePermission(<domaine>.<action>)`, avec la **même** permission que celle vérifiée côté domaine (A27 a corrigé 3 routes où ce n'était pas le cas : sanction/lever gardées par `users.ban` alors que `moderation.js` vérifie `moderation.sanction` ; attribution/retrait de rôle gardées par `users.manage_roles` alors que `rbac.js` vérifie `rbac.grant`) -> 3. Valider (zod, ou transformer un champ de formulaire — ex. "durée en jours" -> `endsAt` ISO — avant validation) -> 4. `withTransaction` -> 5. Appeler le domaine -> 6. `audit.record` dans la **même** transaction -> 7. Rendre (redirection 303 vers la page d'origine pour un `<form>`, JSON sinon). `listings.hide`/`restore` vérifient une capacité RBAC (`listings.hide`) directement en domaine plutôt que l'ownership Discord de la guilde (A27 — avant ça, ces deux fonctions réutilisaient `ownership.assertOwnershipForListing`, la même garde que `update`/`remove` en self-service, ce qui aurait bloqué tout modérateur non propriétaire Discord de la guilde du contrevenant). |
| **Guarantees** | Aucune route admin n'écrit sans audit — la garantie est structurelle (`audit.record` participe à la transaction, cf. `audit.js`) ; « masquer/restaurer » agit **a posteriori** sur une annonce déjà publiée, il n'existe aucune file de pré-modération (A12) ; « gérer les catégories » est servi par la gestion des tags, il n'existe pas de table de taxonomie (A11) ; les bans sont plateforme uniquement, l'interface l'indique explicitement (A13) ; les statistiques ne sont **jamais** calculées ici : `admin.js` appelle `stats.read` et affiche la valeur avec sa date de calcul (ou "Jamais encore calculé" si `computedAt` est `null` — pas de métrique jamais rafraîchie tant que `jobs` n'a pas tourné), il n'écrit aucune agrégation en propre ; aucun `<script>` ni attribut `on*=` inline (CSP `script-src 'self'` sans `unsafe-inline`, M8) — chaque filtre de liste est un `<form method="GET">` avec un bouton explicite, jamais un auto-submit JS. |
| **Errors** | `ERR_FORBIDDEN`: 403, l'entrée de menu n'est même pas rendue si la capacité manque. `ERR_LAST_OWNER`: 409. `ERR_SETTING_INVALID`: valeur hors bornes (`trial_duration_days` ∈ 1..90) -> 422, aucune écriture. Un JSON invalide dans le champ "valeur" d'un réglage -> 422, message dédié, aucune écriture. |

> Covers : M10, §2bis Utilisateurs, §2bis Annonces, §2bis Modération/Signalements, §2bis Avis/Réputation, §2bis Permissions, §2bis Transactions, §2bis Configuration site, §2bis Statistiques (via `domain/stats.js`), §2bis Logs/audit (via `domain/audit.js`), A11, A12, A13, A15, A27, A28, A29, A33

---

### `src/bot/main.js`

"Entrée Gateway"

| Field | Content |
|---|---|
| **Boundary** | Possède : client discord.js, intents, enregistrement des handlers Gateway et bus, arrêt propre. NE possède PAS : logique métier (déléguée au domaine), HTTP entrant. |
| **Inputs** | `Config.DISCORD_BOT_TOKEN`, `Config.DISCORD_HUB_GUILD_ID`. |
| **Outputs** | Session Gateway persistante ; abonnements aux canaux `intent.*`. |
| **Process** | 1. Instancier le client avec intents `Guilds` **et** `GuildModeration` — tous deux non privilégiés ; `GuildMembers` reste **non** demandé (O3) -> 2. Enregistrer les handlers `ready`, `guildCreate`, `guildUpdate`, `guildDelete`, `guildAuditLogEntryCreate` -> 3. Abonner les handlers de bus (`intent.trial.*` y compris `intent.trial.reminder` (A34) -> `hub.onIntentTrialReminder`, `intent.hub.*`, `intent.announce.*`, `intent.guild.leave` (A17)) -> 4. `registerCommands()` puis `login()`, **dans deux blocs `try/catch` distincts depuis A34** (cf. Errors) -> 5. Sur `ready`, réconcilier le cache des guildes, puis `hub.ensureHubInvite` (cf. `1-CheckList.md` A22 — **pas** la même chose que l'A22 de la table interne ci-dessous, collision de numérotation pré-existante entre ce fichier et `1-CheckList.md`) avant `bus.start()` — **depuis A34, chacune de ces trois étapes du `ClientReady` est isolée par son propre `.catch()`** plutôt que de partager un seul bloc englobant (cf. Guarantees) -> 6. Sur `SIGTERM`, détruire le client puis fermer le pool. |
| **Guarantees** | Un seul process bot tourne à la fois (advisory lock `BOT_SINGLETON` pris au boot, exit si tenu) — pas de double annonce ni de double attribution de rôle ; **aucun intent privilégié n'est requis**, ce qui allège le dossier de vérification F5 : la modération du hub repose sur AutoMod et une commande de signalement (`[ASSUMED]`, cf. §OPEN A16), et la surveillance des actions du propriétaire sur le rôle d'essai passe par le journal d'audit de la guilde plutôt que par les événements membres (qui, eux, exigeraient `GUILD_MEMBERS`) ; **conséquence assumée** : sans `GUILD_MEMBERS`, `guildMemberRemove` et `guildMemberUpdate` ne sont pas reçus — la détection d'un kick ou d'un retrait de rôle repose donc sur `guildAuditLogEntryCreate` en premier recours et sur `ownershipSweep` en filet, jamais sur un événement membre direct ; les handlers de bus sont idempotents (pré-condition du bus) ; une déconnexion Gateway déclenche une réconciliation complète au retour, pas une reprise aveugle. **A34** : l'échec d'une des trois étapes du `ClientReady` (réconciliation, `ensureHubInvite`, `bus.start()`) n'empêche plus les suivantes de s'exécuter — avant A34, une exception non catchée dans `getNegotiationChannel` (appelée par `ensureHubInvite`, cf. bloc `bot/hub.js`) empêchait silencieusement `bus.start()` de jamais s'exécuter : le bot restait connecté à la Gateway mais ne traitait plus aucun intent, sans qu'aucune erreur ne le signale. De même, un échec de `registerCommands()` (ex. 403 « Missing Access » sur une guilde sans le scope `applications.commands`) ne fait plus échouer `login()` — avant A34 les deux partageaient un seul `try/catch`, si bien qu'un problème d'enregistrement de commandes, sans rapport avec l'authentification, faisait planter tout le process bot sous le faux diagnostic `ERR_TOKEN_INVALID`. |
| **Errors** | `ERR_TOKEN_INVALID`: exit 1 — **depuis A34, ne recouvre plus que l'échec réel de `login()`**, plus celui de `registerCommands()`. `ERR_COMMAND_REGISTRATION_FAILED` (A34) : `registerCommands()` échoue (ex. 403, scope `applications.commands` manquant sur une guilde déjà installée avant A34 — cf. `web/auth/oauth.js`) -> `logger.error`, jamais fatal, le process continue vers `login()`. `ERR_SINGLETON_HELD`: exit 0 avec log info. `ERR_GATEWAY_RESUME_FAILED`: reconnexion complète + sweep de propriété immédiat. `ERR_SHARD_REQUIRED`: > 2 500 guildes -> sharding requis, log fatal, exit 1 (v1 mono-shard assumé). `ERR_INTENT_MAPPING_INVALID`: `guildAuditLogEntryCreate` non reçu alors que `GuildModeration` est actif -> le couplage intent/événement est un détail d'API Discord susceptible d'évoluer, il doit être **vérifié en Phase III contre la documentation courante avant tout autre travail sur la détection** ; en cas d'invalidation, bascule sur l'option A22-b (`GUILD_MEMBERS` privilégié) ou dégradation assumée sur le sweep seul. |

> Covers : F2, F5, M2, M5, M6, M13, O3, A17, A22, A34

---

### `src/bot/guildWatcher.js`

"Détection de bascule"

| Field | Content |
|---|---|
| **Boundary** | Possède : traduction des événements Gateway de guilde en observations de propriété et en état de présence du bot, **plus** `intent.guild.leave` (A17) — une action sortante, pas une traduction d'événement entrant, colocalisée ici faute d'un fichier dédié pour une action d'appartenance à la guilde d'une seule ligne. NE possède PAS : la décision métier sur une bascule (cf. `transfer.js`) ; NE possède PAS non plus la décision de *pourquoi* quitter une guilde — ça reste à `domain/listings.js:remove()`, ce module exécute seulement l'ordre. |
| **Inputs** | `guildCreate(guild)`, `guildUpdate(oldGuild, newGuild)`, `guildDelete(guild)`, `ready(client)`, `guildAuditLogEntryCreate(entry, guild)`, `onIntentGuildLeave(pool, client, { guildId })` sur `intent.guild.leave`. |
| **Outputs** | `ownership.observe(source: 'gateway')` ; mise à jour `guilds.bot_present`, `member_count_cached`, `bot_role_position`. |
| **Process** | 1. Sur `guildCreate` : upsert la guilde, `bot_present: true`, observer `ownerId`, vérifier la hiérarchie de rôles (M15) et alerter le propriétaire si insuffisante, puis `listings.activatePendingForGuild` — bascule en `active` une annonce publiée avant l'arrivée du bot (A16) -> 2. Sur `guildUpdate` : si `ownerId` diffère, observer -> 3. Sur `guildDelete` : `bot_present: false`, masquer les annonces de la guilde, alerter les transactions en cours -> 4. Sur `ready` : itérer le cache, observer chaque guilde et rejouer `activatePendingForGuild` (rattrapage des événements et des activations manqués hors ligne — `guildCreate` ne se redéclenche pas pour une guilde déjà rejointe avant la coupure) -> 5. Sur `guildAuditLogEntryCreate`, si la guilde porte une transaction en `TRIAL` et que la cible de l'entrée est le destinataire : `MEMBER_KICK` ou `MEMBER_BAN_ADD` -> `trial.cancel(reason: 'TRIAL_RECIPIENT_REMOVED')` ; `MEMBER_ROLE_UPDATE` retirant `trial_role_id` -> `trial.cancel(reason: 'TRIAL_ROLE_REMOVED')` ; `ROLE_DELETE` sur `trial_role_id` -> idem ; dans tous les cas, notification des deux parties dans le thread hub -> 6. Sur `intent.guild.leave` : `client.guilds.fetch(guildId)`, `no-op` si déjà absente (kick manuel, ou invite jamais complétée), sinon `guild.leave()` — ne touche jamais la DB directement, c'est le `guildDelete` déclenché en retour par Discord (étape 3) qui le fait, comme pour n'importe quel départ (A17). |
| **Guarantees** | Toute bascule survenue pendant une coupure du bot est rattrapée au `ready` suivant — la fenêtre d'aveuglement est bornée par la durée de coupure, pas illimitée ; la même garantie couvre l'activation d'une annonce `pending_bot` (A16) : au pire le temps d'une coupure, jamais indéfiniment ; `guildDelete` ne provoque jamais l'annulation automatique d'une transaction en `TRIAL` : le bot retiré peut l'être par erreur, la décision revient à la modération ou à l'expiration ; l'observation de propriété est déléguée, ce module ne compare jamais et n'écrit jamais `owner_discord_id` lui-même ; **révocation hors plateforme — comportement documenté** : quand le propriétaire réel kicke le destinataire ou lui retire le rôle directement depuis Discord, la révocation est **immédiate côté Discord** (M13 est vraie au sens des permissions, sans condition) et le reflet côté plateforme est borné par le premier des trois : entrée de journal d'audit reçue (secondes, chemin nominal), `ownershipSweep` sur guilde en essai (<= 10 min, filet), `trialExpiry` (<= 10 min après `trial_ends_at`, autoguérison de dernier recours). Le contrat public ne promet donc pas une synchronisation instantanée de l'état plateforme, seulement une révocation d'accès instantanée ; quitter une guilde sur `intent.guild.leave` ne distingue pas *pourquoi* le bot était là (annonce simplement retirée, ou tout autre historique) — `domain/listings.js:remove()` ne le déclenche que lorsque `assertMutable` a déjà garanti qu'aucune transaction, passée ou en cours, n'en a plus besoin (A17). |
| **Errors** | `ERR_HIERARCHY_TOO_LOW`: rôle du bot sous le rôle d'essai au moment du join -> MP au propriétaire si possible, sinon bannière sur le site (M15). `activatePendingForGuild` ne dépend pas de ce résultat : une annonce `pending_bot` passe `active` que la hiérarchie soit bonne ou non (A16) — seule l'assignation du rôle d'essai la re-vérifiera plus tard ; une annonce créée directement sur une guilde où le bot est déjà présent avec une hiérarchie déjà connue mauvaise reste, elle, bloquée par `ERR_ROLE_HIERARCHY` dans `domain/listings.js`. `ERR_GUILD_UNAVAILABLE`: outage Discord (`unavailable: true`) -> aucune écriture, la guilde n'est pas marquée absente. `ERR_NO_AUDIT_LOG_PERM`: permission `ViewAuditLog` absente (elle doit figurer dans l'URL d'invitation du bot) -> aucun `guildAuditLogEntryCreate` reçu sur cette guilde, dégradation **silencieuse mais mesurée** : la guilde est marquée `audit_blind: true`, sa fréquence de sweep passe à 5 min et le propriétaire reçoit un avertissement à la création de l'annonce. |

> Covers : M2, M6, M13, M15, A5, A16, A17, A22

---

### `src/bot/hub.js`

"Threads privés du hub"

| Field | Content |
|---|---|
| **Boundary** | Possède : création, peuplement, archivage des threads privés dans le serveur hub, et la commande de signalement. Possède aussi, depuis A23, un MP ponctuel d'invitation quand un participant n'est pas dans le hub — **ce n'est pas** le relais de DM écarté en O2 : O2 parlait du **mécanisme de chat lui-même** (jamais de conversation par DM, toujours le thread), pas d'une notification unique "voici comment rejoindre". NE possède PAS : la lecture du contenu des messages. |
| **Inputs** | `intent.hub.thread_create { transactionId, participantDiscordIds: string[] }` ; `intent.hub.thread_archive { transactionId, delayDays }` ; `intent.trial.reminder { transactionId, trialEndsAt }` (A34) ; commande `/signaler` ; `ensureHubInvite(pool, client, logger)` — appelée une fois au boot (`bot/main.js`, `Events.ClientReady`), pas un handler d'intent ; `notifyMissingHubMember(pool, client, thread, discordId)` (A23) — appelée en interne par `onIntentHubThreadCreate`, pas un handler séparé. |
| **Outputs** | `threads.id` stocké sur la transaction ; messages d'en-tête et de statut postés par le bot ; `moderation.report` sur `/signaler` ; `settings.hub_invite_url` (A22). |
| **Process** | 1. Créer un thread privé dans le salon de négociation du hub, **dès `intent.hub.thread_create`, reçu à la création de la proposition (A20) — bien avant qu'un essai n'existe** -> 2. Ajouter les participants (échec possible si l'utilisateur n'est pas dans le hub -> `notifyMissingHubMember`, A23 : mention dans le thread **et** MP direct best-effort) -> 3. Poster l'en-tête (guilde concernée, rappel `/signaler`) — volontairement générique, aucune info de transaction/essai n'existe encore à cet instant -> 4. Poster un message de statut à chaque `event.transaction.updated` (`PROPOSED` -> `ACCEPTED` y compris — c'est là que les parties apprennent que l'essai démarre ; `TRANSFERRED`/`EXPIRED` reçoivent depuis A34 un message "Échange terminé" dédié plutôt que le statut brut — même signal de clôture dans les deux cas, raison différente) -> 5. Sur `intent.trial.reminder` (A34, publié une fois par `jobs.trialReminderTick` ~24h avant `trial_ends_at`) : poster un rappel dans le thread -> 6. Archiver `delayDays` après un état terminal. **`ensureHubInvite`** (A22, indépendant du flux ci-dessus) : au boot, `channel.createInvite({ maxAge: 0, maxUses: 0, unique: false })` sur le salon de négociation — `unique: false` fait retourner une invite existante équivalente plutôt que d'en créer une nouvelle à chaque redémarrage, pas de gestion d'état manuelle nécessaire — puis persiste l'URL dans `settings.hub_invite_url` (`updated_by: null`, cette colonne référence `users(id)`, pas un acteur texte libre comme `audit_log.actor_id`). |
| **Guarantees** | Le fil est la trace de la négociation et n'est jamais supprimé, seulement archivé — l'historique reste consultable par la modération (M5) ; les échanges passent par le hub, jamais par DM, ce qui élimine les échecs 403 sur DM fermés (O2) ; la modération est 100 % bot : règles AutoMod du hub + commande `/signaler` ouvrant un dossier plateforme, sans intervention humaine dans le fil (A4) ; un participant absent du hub n'empêche pas la création du thread ; **le fil existe avant tout engagement des deux parties** (A20) — si la proposition est refusée ou expire sans jamais être acceptée, le fil reste ouvert mais reçoit le message de statut terminal (`CANCELLED`/`EXPIRED`) comme n'importe quelle autre transition, puis s'archive normalement à son tour. **A22, corrige un trou réel** : la mention postée dans le thread pour un participant absent du hub (étape 2) est **structurellement invisible** pour son destinataire — on ne voit pas le contenu d'un serveur Discord dont on n'est pas membre. `settings.hub_invite_url` (affiché sur `/tableau-de-bord` en permanence et sur `/matchs` à côté des propositions) est donc la **seule** voie réellement utilisable pour qu'un propriétaire rejoigne le hub avant ou après une mise en contact ; sans elle, tout le mécanisme M5 était inatteignable pour quiconque n'était pas déjà membre du hub. **A34** : `ensureHubInvite` catch désormais l'intégralité de son propre corps, y compris le fetch de la guilde hub elle-même (`getNegotiationChannel`) — avant, seul `createInvite` était protégé, et une guilde hub devenue injoignable (constaté en direct, cause distincte non résolue) remontait une exception non catchée qui empêchait `bus.start()` de s'exécuter **du tout** dans `bot/main.js` : le bot restait connecté à la gateway sans plus jamais traiter un seul intent, silencieusement. `bot/main.js` isole aussi désormais chaque étape du `ClientReady` séparément (même filet `.catch` que tous les autres listeners du fichier). |
| **Errors** | `ERR_MEMBER_NOT_IN_HUB`: -> `notifyMissingHubMember` (A23) : mention postée dans le thread (inchangé, inutile seule mais inoffensive) **et** MP direct best-effort avec `hub_invite_url` via `client.users.fetch(discordId)` — si le MP échoue aussi (403, DMs fermés — le cas exact que O2 écartait pour le *mécanisme de chat*, pas pour une notification ponctuelle), `settings.hub_invite_url` affiché sur le site (A22) reste le filet de sécurité garanti. `ERR_THREAD_LIMIT`: quota de threads actifs atteint -> archivage anticipé des plus anciens terminés, puis réessai. `ERR_MISSING_PERMISSIONS`: permissions du bot insuffisantes sur le hub -> alerte admin critique, transaction maintenue en `ACCEPTED`. `ensureHubInvite` échoue (ex. `CREATE_INSTANT_INVITE` absente du rôle du bot, ou la guilde hub elle-même injoignable depuis A34) -> `logger.warn`, jamais fatal (`bus.start()` doit démarrer quoi qu'il arrive), mais `hub_invite_url` reste alors absent et rien n'est affiché sur le site ni envoyable par MP — dégradation silencieuse à surveiller, pas une erreur utilisateur. |

> Covers : M5, A4, O2, A20, A22, A23, A34

---

### `src/bot/trialRole.js`

"Rôle Administrateur (essai)"

| Field | Content |
|---|---|
| **Boundary** | Possède : création, positionnement, attribution et révocation du rôle d'essai sur la guilde cédée, et la vérification de hiérarchie. NE possède PAS : le chronomètre d'essai (cf. `trial.js` + `jobs`), le transfert de propriété (impossible par API). |
| **Inputs** | `intent.trial.assign { guildId, memberDiscordId, transactionId }` ; `intent.trial.revoke { guildId, memberDiscordId, transactionId, reason }` ; `assertHierarchy(guildId)`. |
| **Outputs** | `roleId` persisté sur la transaction ; confirmation ou échec publié en retour sur le bus. |
| **Process** | 1. `assertHierarchy` : la position du plus haut rôle du bot doit être strictement supérieure à celle du rôle d'essai à créer -> 2. Récupérer le membre par REST ; absent -> `inviteRecipient` (A34, voir Guarantees) puis `ERR_MEMBER_NOT_IN_GUILD` -> 3. Créer le rôle « Administrateur (essai) » avec permission `Administrator`, couleur distincte, `mentionable: false`, `hoist: true` -> 4. Le positionner juste sous le plus haut rôle du bot -> 5. Attribuer -> 6. Confirmer sur le bus ; à la révocation : retirer le rôle puis supprimer le rôle si plus aucun porteur. |
| **Guarantees** | Le rôle confère `Administrator` mais **pas** la propriété — supprimer la guilde et transférer la propriété restent réservés au propriétaire réel : c'est ce qui rend l'essai réversible sans confiance (M11) ; le propriétaire réel n'est soumis à aucune hiérarchie de rôles, il peut donc révoquer unilatéralement à tout moment, y compris hors plateforme (M13) ; la vérification de hiérarchie est faite deux fois — à la création de l'annonce et juste avant l'attribution — car la position peut avoir changé entre les deux (M15) ; la révocation est idempotente : rôle déjà absent -> succès. **A34** : `inviteRecipient` envoie une invite vers la guilde cible (DM + repli dans le thread hub, un seul essai — `invite_sent_at`, `claimInviteSlot` en un aller-retour DB atomique plutôt que fetch-puis-check-puis-write, pour ne pas empiler les connexions imbriquées au-delà de ce que `processRow` tient déjà ouvert) — deux inconnus mis en contact par le marketplace n'ont sinon aucune raison d'être déjà membres l'un du serveur de l'autre, et avant A34 la transaction restait bloquée à `ACCEPTED` indéfiniment sans aucun signal. `jobs.acceptedInviteRetryTick` (REST uniquement, 10 min) revérifie ensuite l'appartenance et refait `intent.trial.assign` une fois le destinataire effectivement rejoint. |
| **Errors** | `ERR_HIERARCHY_TOO_LOW`: -> `ERR_ROLE_ASSIGN_FAILED` sur le bus, transaction ramenée en `ACCEPTED`, chrono non démarré. `ERR_MISSING_MANAGE_ROLES`: idem, avec instruction explicite. `ERR_MEMBER_NOT_IN_GUILD`: destinataire absent de la guilde -> invite envoyée une fois (A34), attribution différée, chrono non démarré, `jobs.acceptedInviteRetryTick` retente dès que le destinataire a rejoint. `ERR_ROLE_DELETED_EXTERNALLY`: rôle supprimé ou retiré manuellement, ou destinataire kické -> détecté en premier lieu par `guildAuditLogEntryCreate` (secondes), sinon par `ownershipSweep` (<= 10 min sur guilde en essai) ; essai marqué `CANCELLED` motif `TRIAL_ROLE_REMOVED` ou `TRIAL_RECIPIENT_REMOVED`, les deux parties notifiées. |

> Covers : M11, M13, M15, A14, A34

---

### `src/bot/announce.js`

"Annonce de passation"

| Field | Content |
|---|---|
| **Boundary** | Possède : composition et publication du message de passation dans le serveur repris. NE possède PAS : le choix du moment (déclenché par `transfer.js`), le contenu personnalisé par l'utilisateur en v1. |
| **Inputs** | `intent.announce.handover { guildId, transactionId, previousOwnerId, newOwnerId, transferredAt }`. |
| **Outputs** | Message posté ; `announced_at` sur la transaction. |
| **Process** | 1. Choisir le salon : `systemChannel` si le bot peut y écrire, sinon le premier salon textuel accessible par ordre de position -> 2. Composer l'embed (ancien propriétaire, nouveau, date, mention de Xyro Market) -> 3. Poster -> 4. Enregistrer `announced_at` et l'id du message. |
| **Guarantees** | L'annonce est automatique, sans validation humaine (A5/M7) ; idempotente — `announced_at` renseigné -> sortie immédiate, un rejeu du bus ne double jamais le message ; aucune donnée personnelle au-delà des mentions Discord des deux parties ; un échec d'annonce n'invalide jamais le transfert (l'annonce est une conséquence, pas une condition). |
| **Errors** | `ERR_NO_WRITABLE_CHANNEL`: aucun salon accessible -> échec journalisé, notification dans le thread hub, transaction inchangée. `ERR_FORBIDDEN` (50013): idem. `ERR_GUILD_LEFT`: bot retiré avant l'annonce -> abandon définitif, journalisé. |

> Covers : M7, A5

---

### `src/jobs/main.js`

"Scheduler"

| Field | Content |
|---|---|
| **Boundary** | Possède : ordonnancement des tâches périodiques, chacune protégée par un advisory lock. NE possède PAS : la logique des tâches (déléguée au domaine), tout appel Discord direct hors sweep REST. |
| **Inputs** | Table de planification interne ; `Config`. |
| **Outputs** | Effets des jobs ; métriques d'exécution (durée, succès, éléments traités). |
| **Process** | 1. Au boot, prendre `JOBS_SINGLETON` -> 2. Planifier -> 3. Chaque tick : `withAdvisoryLock(jobKey)`, exécuter, journaliser, relâcher. |
| **Sub-job: matchRound** | Toutes les 5 min -> `engine.runRound` ; également déclenché par `event.listing.changed` avec debounce 30 s. |
| **Sub-job: trialExpiry** | Toutes les 10 min -> transactions en `TRIAL` dont `trial_ends_at < now()` et validation incomplète -> `trial.expire` -> révocation du rôle + notification des deux parties. |
| **Sub-job: ownershipSweep** | Toutes les heures pour les guildes avec annonce active ; **toutes les 10 min** pour les guildes portant une transaction en `TRIAL`, **toutes les 5 min** si `audit_blind: true`. `GET /guilds/{id}` REST par lots respectant le rate limit -> `ownership.observe(source: 'sweep')`. Vérifie en outre, pour les guildes en essai : existence du rôle d'essai, présence du destinataire dans la guilde, et possession effective du rôle par le destinataire (`GET /guilds/{id}/members/{user}` — lecture REST, aucun intent requis) -> tout écart déclenche `trial.cancel` avec le motif correspondant. |
| **Sub-job: outboxSweep** | Toutes les 60 s -> événements `outbox` non consommés depuis > 60 s -> réémission ; > 5 tentatives -> `dead` + alerte. |
| **Sub-job: statsRefresh** | Toutes les 15 min -> `stats.refreshAll` (vues `mv_stats_*`, définitions détenues par `domain/stats.js`) + réévaluation des tags « Vérifié » via `reputation.evaluateVerified`. Ce job **ordonnance** le rafraîchissement, il ne définit aucune métrique. |
| **Sub-job: acceptedInviteRetryTick** (A34) | Toutes les 10 min -> transactions `ACCEPTED` dont l'essai n'a jamais démarré (`transactionsRepo.findAcceptedAwaitingTrial`) -> vérifie via `fetchMemberRest` (même lecture REST que `ownershipSweep`, pas d'intent membres) si le destinataire a depuis rejoint la guilde cible -> si oui, republie `intent.trial.assign` pour relancer le flux (attribution du rôle, démarrage de l'essai) — rattrape le cas où l'invitation envoyée par `trialRole.inviteRecipient` (cf. bloc `bot/trialRole.js`) a été acceptée entre deux cycles. |
| **Sub-job: trialReminderTick** (A34) | Toutes les 60 min -> transactions `TRIAL` dont `trial_ends_at` tombe dans la fenêtre des 24 h suivantes et jamais rappelées (`transactionsRepo.findTrialsEndingSoon`, filtre `trial_reminder_sent_at IS NULL`) -> publie `intent.trial.reminder` et marque `trial_reminder_sent_at` **dans la même transaction atomique** que la lecture, pour qu'un rappel ne puisse jamais partir deux fois même si deux ticks se chevauchaient (protection redondante avec le lock non bloquant du job lui-même, mais peu coûteuse et plus sûre en cas de changement futur de la politique de lock). |
| **Guarantees** | Un job ne se recouvre jamais avec lui-même (lock non bloquant : si tenu, le tick est sauté, pas mis en file) ; `trialExpiry` est la seule source d'expiration — aucun autre module ne compare `trial_ends_at` à l'heure courante ; `ownershipSweep` ne remplace ni la Gateway ni le journal d'audit, il les rattrape : une détection par sweep porte `source: 'sweep'` et reste distinguable en audit d'une détection temps réel ; **la fenêtre maximale d'incohérence entre l'état Discord et l'état plateforme sur une guilde en essai est de 10 minutes** (5 si `audit_blind`), et cette borne est une garantie de niveau système, pas une propriété d'un module isolé ; toutes les tâches sont idempotentes et rejouables sans effet cumulatif. **A34** : `acceptedInviteRetryTick` est le filet de rattrapage du flux d'invitation — sans lui, une transaction `ACCEPTED` dont le destinataire rejoint la guilde après l'échec initial de `trialRole.onIntentTrialAssign` restait bloquée indéfiniment (c'était le bug bloquant qui empêchait toute validation d'échange avant A34) ; `trialReminderTick` ne peut jamais envoyer deux rappels pour un même essai (marquage atomique avec la lecture qui le sélectionne). |
| **Errors** | `ERR_JOBS_SINGLETON_HELD`: exit 0. `ERR_JOB_FAILED`: exception -> journalisée, tick suivant non affecté, 3 échecs consécutifs -> alerte admin. `ERR_DISCORD_RATE_LIMIT`: -> respect de `retry_after`, lot repris au tick suivant, jamais de perte. |

> Covers : M4, M6, M9, M11, M12, M13, M15, A15, A22, A34

---

## OPEN — remontées Phase I

Deux niveaux, à ne pas confondre.

**Niveau 1 — décision produit, bloquante.** Un défaut retenu ici change ce que vit l'utilisateur, pas la façon dont c'est codé. Il ne peut pas rester `[ASSUMED]` en bas d'un fichier d'architecture : il demande un aller-retour explicite avec Le_Club.

| # | Question | Défaut provisoire | Ce que le défaut coûte | Bloc impacté |
|---|---|---|---|---|
| **Q1** (ex-A20) | Canal de notification hors plateforme. Aucun canal sortant n'existe aujourd'hui dans l'architecture : ni e-mail (scope OAuth `email` non demandé, M1), ni DM (écarté), seulement le thread hub et le site. | À trancher — pas de défaut retenu | Un utilisateur qui ne revient pas sur le site **et** n'est pas membre du hub peut manquer : la fin de sa période d'essai (`EXPIRED` sans qu'il ait validé), l'ouverture d'un litige contre lui, une sanction. Sur un cycle de 7 jours avec transfert manuel obligatoire, c'est un mode d'échec courant, pas marginal. | `bot/hub.js`, `web/routes/user.js`, `domain/trial.js`, `web/auth/oauth.js` |

Trois options, non exclusives :

| Option | Effet | Coût |
|---|---|---|
| **a. DM Discord best-effort + repli hub/site** | Couvre la majorité des cas | O2 écartait le DM comme **mécanisme de chat bidirectionnel**, pour cause de 403 sur DM fermés. Une notification sortante unique avec repli garanti n'est pas le même objet : O2 ne l'interdit pas, mais la distinction doit être actée par le client, pas décidée en Phase II. |
| **b. Scope OAuth `email` + notifications transactionnelles** | Couvre tous les cas | Casse la garantie de scopes minimaux de `oauth.js` (M1), ajoute une donnée personnelle au registre RGPD (M8, pages `/confidentialite` et `/donnees-personnelles` à amender), impose un service d'envoi et sa délivrabilité. |
| **c. Adhésion au hub rendue obligatoire avant matching** | Rend le thread hub réellement universel | Friction d'onboarding sur le parcours principal, et ne couvre pas l'utilisateur qui quitte le hub. |

**Niveau 2 — détail d'implémentation, non bloquant.** Chacun porte un défaut `[ASSUMED]` fonctionnel, explicité dans le bloc concerné. À valider, pas à débattre.

| # | Question | Défaut retenu en Phase II | Bloc impacté |
|---|---|---|---|
| A16 | Modération du hub à 100 % bot (A4) : par lecture des messages (intent privilégié `MESSAGE_CONTENT`, à justifier au dossier F5) ou par AutoMod + commande `/signaler` ? | AutoMod + `/signaler`, aucun intent privilégié — cohérent avec O3, allège F5 | `bot/main.js`, `bot/hub.js` |
| A17 | Fin de période d'essai sans double validation | `EXPIRED` : révocation du rôle, annonces remises en pool, aucune sanction | `domain/trial.js`, `jobs/main.js` |
| A18 | Refus d'un participant dans une proposition à 2 parties (n-aire retiré, cf. `1-CheckList.md` A19) | Dissolution totale de la proposition + cooldown 24 h entre les mêmes parties | `domain/matching/engine.js` |
| A19 | Fenêtre d'ouverture de litige post-transfert (M14) | 14 jours après `transferred_at`, configurable (`dispute_window_days`) | `domain/dispute.js` |
| A21 | Langue de l'interface | FR uniquement en v1, textes du panel « Configuration site » non i18n | `web/routes/*` |
| A22 | Détection des actions du propriétaire sur le rôle d'essai (kick, retrait de rôle) sans intent privilégié | `guildAuditLogEntryCreate` sous intent `GuildModeration` (non privilégié) + permission `ViewAuditLog` dans l'invitation ; repli sur `ownershipSweep` à 10 min. Le couplage intent/événement est un détail d'API Discord : **à vérifier contre la documentation courante en tout premier lieu en Phase III**. Si invalidé -> option b : `GUILD_MEMBERS` privilégié (`guildMemberRemove`/`guildMemberUpdate`), au prix d'une justification supplémentaire au dossier F5. | `bot/main.js`, `bot/guildWatcher.js`, `jobs/main.js` |

---

## Écarts assumés — à ne pas reformuler en garantie

| Sujet | Ce qui est vrai | Ce qui ne l'est pas |
|---|---|---|
| ~~TTC~~ / ~~Complexité TTC~~ | Ces deux lignes documentaient `ttc.js`/`preferences.js`, retirés par A19 (`1-CheckList.md`) — plus de cycles, plus d'ordre dérivé, donc plus rien à dire ici de non-manipulabilité ou de complexité amortie. Conservées barrées plutôt que supprimées : si le TTC revient un jour, ces deux écarts redeviennent pertinents tels quels. | — |
| M13 (révocation unilatérale) | Révocation d'**accès** immédiate, sans condition, bot éteint compris — le propriétaire surclasse toute hiérarchie de rôles | Une synchronisation instantanée de l'**état plateforme** : celle-ci est bornée à 10 min (5 si `audit_blind`), jamais nulle. |

---

## Exit Condition

- [x] Gate appliqué : 32 interfaces, 3 frontières de process -> BIOPGE complet
- [x] 32 blocs complets, un par unité logique
- [x] `> Covers :` renseigné et **explicite** — F1-F5, M1-M15, les 9 domaines de §2bis nommés un par un, A1-A15, O2, O3 couverts par au moins un bloc
- [x] Types cohérents entre blocs : snowflakes en `string`, exécuteur `tx` propagé, erreurs domaine mappées une seule fois en HTTP
- [x] Garanties falsifiables : toute affirmation théorique est soit démontrée dans son domaine, soit dégradée en écart assumé
- [x] Zéro code écrit — **superseded par l'implémentation réelle, Phase III largement exécutée, cf. `4-Audit.md`**
- [x] A22 vérifié contre la documentation Discord courante (2026-09-06, confirmé à nouveau à l'audit de clôture 2026-09-17) — couplage `GuildModeration`/`guildAuditLogEntryCreate` toujours valide
- [x] A16-A18, A21 validés par l'usage (aucun n'a bloqué l'implémentation)
- [~] **Q1 (canal de notification hors plateforme)** — toujours non tranché par Le_Club. Non bloquant pour le fonctionnement du site (intentions persistées, `pending_notifications`), mais reste un mode d'échec réel pour un utilisateur absent du hub et du site. À trancher avant un volume d'utilisateurs significatif.
- [ ] **A19 (retrait du moteur TTC, `1-CheckList.md`) — décision produit prise par le développeur, jamais validée par Le_Club.** Revient sur une exigence que le client avait explicitement confirmée verrouillée (M4/A6/A8 : "pas de version allégée"). C'est l'écart le plus important entre ce contrat et ce que le client a demandé — à faire signer avant toute mise en production, pas après.
- [ ] **~29 fichiers (A19-A32) jamais committés** au moment de l'audit (2026-09-17) — voir `4-Audit.md`. Le HEAD git ne reflète que jusqu'à A25 ; `ttc.js`/`preferences.js` y existent encore alors qu'ils sont supprimés dans l'arbre de travail.
- [ ] Gap `2bis Transactions` : aucune route de liste/filtre (`GET /admin/transactions/:id` existe, pas de `GET /admin/transactions`) — un admin ne peut atteindre une transaction qu'en connaissant déjà son UUID.
- [ ] M8 (pages légales) : structure complète (14 routes), contenu toujours un gabarit placeholder — texte réel à obtenir de Le_Club avant mise en ligne réelle.
- [ ] Bootstrap du premier `proprietaire` : aucun mécanisme self-service, uniquement par `INSERT` SQL direct (gap connu depuis A27, non résolu par A32).
