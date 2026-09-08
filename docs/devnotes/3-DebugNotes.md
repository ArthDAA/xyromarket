# 3-DebugNotes.md - Xyro Market

Journal des décisions non triviales, rétroactivités, et ressources externes consultées en Phase III. Complète les commits, ne les remplace pas.

---

## 2026-09-06 [A22 - vérification intent/événement Discord]

- Ressource consultée : docs.discord.com/developers/topics/gateway (liste des intents privilégiés), discordjs.guide/popular-topics/audit-logs, discord.js.org (GatewayIntentBits enum), PR discordjs/discord.js#9058.
- Constat : `GUILD_MODERATION` n'est **pas** un intent privilégié — seuls `GUILD_PRESENCES`, `GUILD_MEMBERS`, `MESSAGE_CONTENT` le sont. L'événement `GUILD_AUDIT_LOG_ENTRY_CREATE` (→ `guildAuditLogEntryCreate` côté discord.js) est bien émis sous l'intent `GUILD_MODERATION`, aux côtés de `GUILD_BAN_ADD`/`GUILD_BAN_REMOVE`. La permission `ViewAuditLog` sur la guilde reste requise pour recevoir ces entrées (cohérent avec `ERR_NO_AUDIT_LOG_PERM` du contrat).
- Décision : le couplage décrit dans `2-Architecture.md` (blocs `bot/main.js`, `bot/guildWatcher.js`) est **valide et à jour**. Aucun amendement, pas de bascule sur l'option de repli A22-b (`GUILD_MEMBERS`). Implémentation de `bot/main.js`/`bot/guildWatcher.js` à faire telle que spécifiée.

## 2026-09-06 [Style de code - clarification utilisateur]

- Le contrat (§ Style de code du prompt Phase III) interdit d'inventer les conventions de lint/format/typage en l'absence de config existante dans le repo. Le repo était vide (pas de `package.json`, pas de config).
- Décision utilisateur : JavaScript pur ESM + JSDoc (pas de TypeScript) ; ESLint + Prettier configuration standard ; initialisation d'un dépôt git avec un commit par bloc validé.

## 2026-09-06 [Blocage outillage - Node.js absent]

- `node`/`npm` introuvables sur la machine au moment d'implémenter `config/env.js`. Décision : continuer l'écriture du code et des tests (`node:test`) sans pouvoir les exécuter pour l'instant ; `npm install` + `npm test` à faire dès que Node.js est disponible, avant de considérer un bloc comme validé au sens du contrat (les 3 tests falsifiables exigés ne sont non-optionnels que s'ils tournent réellement).

## 2026-09-06 [db/migrations - compléments de schéma non contradictoires]

La liste de tables du bloc `db/migrations` (§ Outputs) n'est pas exhaustive au sens DDL strict — plusieurs colonnes/tables sont spécifiées ailleurs dans `2-Architecture.md` sans être reprises ici. Complété sans escalade (aucune garantie contredite, aucun résultat absurde, extension mécanique du motif déjà en place) :

- `outbox` (id, channel, payload JSONB, published_at, consumed_at, attempts, last_error) : colonnes tirées intégralement du bloc `bus/events.js`, absentes de la liste `db/migrations`.
- `sessions` : table requise par `web/auth/session.js` ("table sessions, pas de store mémoire"), colonnes non détaillées ailleurs → conçue (id, user_id FK, csrf_secret, created_at, expires_at, revoked_at).
- `pending_notifications` : requise par le gabarit Q1 du prompt Phase III (persister l'intention de notif hors-canal sans livraison) → (id, user_id FK, event_type, payload JSONB, created_at, delivered_at).
- `match_participants.user_id` ajouté : le schéma documenté (`proposal_id`, `listing_id`, `gives_to_listing_id`, `accepted_at`, `refused_at`) ne porte aucune colonne utilisateur, or `engine.js`/`queue.js` ont besoin d'identifier le destinataire d'un match `queue` (mode don), qui n'est propriétaire d'aucune annonce. Ajout mécanique, cohérent avec le reste du schéma.
- `user_permission_grants` / `user_permission_revocations` : `rbac.js` (Process, étapes 3-4) exige explicitement des permissions "accordées directement à l'utilisateur" et "explicitement révoquées" en plus des `role_permissions` — ces deux tables ne sont pas nommées dans la liste RBAC du bloc migrations (`roles/permissions/role_permissions/user_roles`). Ajout nécessaire pour que `rbac.js` soit implémentable tel que spécifié.
- `id`/`created_at`/`updated_at` implicites ajoutés partout où le bloc `db/migrations` omet ces colonnes standard mais où d'autres blocs les référencent (ex. `reports.created_at`, `sanctions.created_at`) — cohérent avec le motif déjà utilisé pour `listings`/`transactions`.
- `ownership_events.source` : l'ENUM listé dans `db/migrations` porte 4 valeurs (`gateway`,`sweep`,`oauth`,`audit_log`) alors que la signature de `ownership.observe` dans `domain/ownership.js` n'en documente que 3 (`gateway`,`sweep`,`oauth`). Aucun point d'appel identifié dans le contrat n'utiliserait `audit_log` comme source d'observation (les entrées de journal d'audit déclenchent `trial.cancel` directement dans `guildWatcher.js`, pas une observation de propriété). Retenu tel quel dans la colonne DB (schéma inoffensif à garder en sur-ensemble), l'application n'émettra que les 3 valeurs documentées.
- Rôles/permissions RBAC de départ (seed) : le contrat ne fixe pas la matrice rôle→permission exacte au-delà de "granulaire par fonction, pas par rôle fixe" et liste des permissions à titre d'exemple ("…"). Seed de départ raisonnable fourni dans la migration, éditable via le panel Permissions — ce n'est pas une donnée verrouillée par le contrat.
- Rôle DB applicatif (`xyro_app`) : la garantie "aucun UPDATE/DELETE accordé au rôle applicatif" sur `audit_log` suppose un rôle Postgres dédié pour la connexion applicative. La migration crée `xyro_app` (NOLOGIN) et retire UPDATE/DELETE ; il reste à la charge de l'exploitation (hors scope schéma) de faire authentifier `DATABASE_URL` sous ce rôle (ou de lui accorder ce rôle) en production pour que la garantie s'applique réellement — sinon elle ne tient que par convention si l'app se connecte en propriétaire de schéma.

## 2026-09-06 [A18 - table de cooldown]

`match_cooldowns` ajoutée à `001_init.sql` (paire d'utilisateurs + `until`) : nécessaire pour implémenter la garantie A18/`engine.js` ("cooldown 24h entre les mêmes parties" après dissolution d'un cycle), aucune table de ce type n'étant nommée dans le contrat.

## 2026-09-06 [domain/audit.js - sel de hachage IP]

Le contrat demande "Hacher l'IP (SHA-256 + sel serveur)" mais ne nomme aucun secret dédié dans `config/env.js` pour ce sel (seuls `SESSION_SECRET` et `TOKEN_ENC_KEY` existent, chacun à racine unique pour son usage propre). Décision : dériver le sel de hachage IP de `SESSION_SECRET` via HMAC-SHA256 plutôt que d'ajouter une troisième variable d'environnement. Justification : la règle "une racine par usage" du contrat visait explicitement à isoler signature de session et chiffrement de jetons OAuth (compromission de l'une n'expose pas l'autre) ; le hachage d'IP à des fins d'audit n'a pas cette même exigence d'isolation (ce n'est pas un secret déchiffrable, juste un sel anti-rainbow-table), donc réutiliser `SESSION_SECRET` ne viole pas la garantie telle qu'énoncée. Fonction exportée `audit.hashIp(ip)` — les appelants (pipeline de requêtes web) hachent l'IP avant d'appeler `record`, qui ne stocke que le hash.

## 2026-09-06 [M4 - table de file d'attente]

`listing_queue` ajoutée à `001_init.sql` : `domain/matching/queue.js` a besoin d'une table persistante pour la FIFO du mode don (position, skip, withdraw), absente de la liste `db/migrations`. Colonnes dérivées directement des méthodes documentées dans le bloc `queue.js` (`enqueue`/`dequeueHead`/`skip`/`withdraw`).

## 2026-09-06 [engine.js - durée de vie des propositions]

Le contrat ne fixe aucune durée pour `match_proposals.expires_at` (contrairement à `trial_duration_days`/`dispute_window_days`, explicitement paramétrables). Ajout de `match_proposal_ttl_hours` (défaut 24) dans `settings`, suivant exactement le même patron que les deux autres délais déjà configurables — cohérent, pas une décision produit nouvelle.

## 2026-09-06 [trial.js/engine.js - choix d'implémentation notables]

- **Confirmation rôle essai en appel direct, pas par le bus.** `bus/events.js` énumère un jeu fermé de canaux, sans canal de "confirmation" retour bot->domaine. Le FSM `ACCEPTED -> (rôle attribué) -> TRIAL` a donc besoin d'un point d'entrée que `bot/trialRole.js` appelle **directement en process** après un succès/échec Discord (`trial.confirmTrialStarted` / `trial.reportRoleAssignFailed`), dans la même transaction que le handler du bus qui a exécuté l'intention. Le fil hub (`intent.hub.thread_create`) est traité comme best-effort et ne bloque pas l'entrée en `TRIAL` — seule l'attribution du rôle le fait, ce qui est la seule garantie de sécurité explicitement énoncée ("le chrono ne court pas sur un rôle non attribué").
- **`trial.cancel`/`expire` ne libèrent que LEUR propre annonce**, pas tout le cycle n-aire dont la transaction est issue. Le contrat ne tranche pas explicitement ce cas (chaque transaction est individuellement pilotée par la FSM de `trial.js`, sans notion de "groupe" au niveau de ce bloc) — comportement local le plus simple et le moins surprenant, mais un réexamen produit pourrait vouloir annuler tout le cycle si un seul maillon échoue.
- **`engine.runRound` n'est pas une transaction unique de bout en bout** : la garantie du contrat ("un tour est atomique : soit toutes les annonces d'un cycle passent en matched, soit aucune") est explicitement scopée *par cycle*, pas par tour entier — chaque cycle/appariement don est donc sa propre sous-transaction sur la connexion qui tient le verrou consultatif, avec re-vérification `status='active'` au moment de la persistance (`ERR_LISTING_VANISHED` abandonne seulement ce cycle, pas le tour).
- **Sweep des propositions expirées déplacé dans `engine.runRound`** : aucun job dédié n'existe dans la liste des 5 sous-jobs de `jobs/main.js` pour l'expiration des `match_proposals` (contrairement à `trialExpiry` pour les transactions). Dissoudre les propositions expirées en tout début de tour est la lecture la plus naturelle et n'invente pas de mécanisme supplémentaire.

## 2026-09-06 [transfer.js/dispute.js/moderation.js - choix d'implémentation]

- **`trial.openDispute`/`trial.close` ajoutés.** Le FSM documente `TRANSFERRED -> DISPUTED -> CLOSED` mais `trial.js` n'exposait, avant ce bloc, aucune fonction publique pour ces deux transitions (seuls `open/validate/cancel/expire/markTransferred` étaient listés). Ajout nécessaire pour que `dispute.js` respecte la règle "aucun autre module n'écrit `transactions.status`".
- **Clôture automatique après fenêtre de litige écoulée sans incident : aucun job dédié.** `jobs/main.js` liste 5 sous-jobs (`matchRound`, `trialExpiry`, `ownershipSweep`, `outboxSweep`, `statsRefresh`), aucun ne clôt les transactions `TRANSFERRED` dont `dispute_window_days` s'est écoulé sans litige ouvert. Décision : étendre le sous-job `trialExpiry` (même famille de travail — avancement temporel du cycle de vie d'une transaction) pour couvrir aussi ce cas, plutôt que d'inventer un 6e job. À faire au bloc `jobs/main.js`.
- **"Notifier les deux parties (thread hub rouvert)" sans nouveau canal de bus.** `dispute.open` appelle `trial.openDispute`, qui publie `event.transaction.updated` comme toute transition — `bot/hub.js` réagit déjà à cet événement en postant un message de statut dans le fil existant, ce qui, côté Discord, désarchive le fil automatiquement (poster dans un fil archivé le rouvre). Aucun canal `intent.hub.thread_reopen` n'a été ajouté au jeu fermé de `bus/events.js`.
- **`moderation.addNote`/`report` "notes internes" réutilisent `audit_log`** : aucune table `report_notes` n'est nommée dans le contrat (contrairement à `disputes.timeline`, explicite). L'historique des notes reste consultable via `audit.query`.
- **Utilisateur système seedé** (`00000000-0000-0000-0000-000000000000`, `discord_id='system'`) pour les FK NOT NULL que les actions automatiques doivent satisfaire (`reports.reporter_id` sur `OWNER_DIVERTED`/`ERR_RATE_LIMITED`). `audit_log.actor_id` reste TEXT et continue d'utiliser les littéraux `'system'`/`'bot'` sans FK.

## 2026-09-06 [gdpr.js - colonne et job manquants]

- `users.deletion_requested_at` ajoutée (absente de la liste de colonnes `db/migrations`) : nécessaire pour la fenêtre de rétractation de 7 jours explicitement décrite dans le Process de `gdpr.js`.
- **Exécution de la suppression après la fenêtre de 7 jours : aucun job dédié.** Même situation que la clôture après fenêtre de litige — repris dans le sous-job `trialExpiry` étendu (voir note transfer.js/dispute.js), au bloc `jobs/main.js`.

## 2026-09-06 [stats.js - substitution des vues matérialisées]

Le contrat demande des "vues matérialisées `mv_stats_*`" rafraîchies via `REFRESH ... CONCURRENTLY`. Implémenté à la place : une table `stats_cache(metric, bucket_date, value, computed_at)` peuplée par `stats.refreshAll` et lue par `stats.read`. Justification : les garanties réellement énoncées (une métrique = une seule définition ; toute lecture expose sa fraîcheur `computedAt`/`stale` ; le rafraîchissement ne bloque aucune lecture ; échec d'une métrique n'affecte pas les autres) sont toutes tenues par cette table, sans la mécanique supplémentaire d'un index `UNIQUE` par vue + `REFRESH CONCURRENTLY` par métrique. `stats.js` reste l'unique point de lecture (`admin.js` n'implémente aucun calcul lui-même), ce qui est la garantie qui compte le plus. Les métriques de répartition (`listings.by_tag`, `transactions.by_status`, `matching.cycle_size_distribution`, etc.) sont calculées à la volée (agrégats bon marché) plutôt que mises en cache, et retournées avec `stale:false` puisqu'elles sont par construction toujours à jour.

- `users.new` partage la même série mise en cache que `users.total` (filtrée par la plage demandée) plutôt qu'une série séparée — la distinction entre "total cumulé" et "nouveaux sur la période" est une question de filtrage de plage, pas de source de données différente.
- `activity.recent` ne rentre pas dans la forme `points: {bucket,value}[]` (c'est un flux, pas une série) — le résultat porte un champ `items` supplémentaire à côté de `points: []`.

## 2026-09-06 [web/ - choix d'implémentation]

- **`oauth.buildAuthUrl`/`handleCallback` liés à un cookie nonce, pas à une session.** Le contrat décrit `state` comme "lié à la session, TTL 10 min", mais au moment de `/auth/discord` l'utilisateur n'a par définition **aucune session** (pas encore connecté). Implémenté avec un cookie signé `xm_oauth_state` de courte durée (même garantie CSRF : usage unique, expirant, vérifié en retour), plutôt qu'un lien littéral à une session inexistante.
- **Routes `/auth/discord`, `/auth/discord/callback`, `/auth/logout` placées dans `routes/public.js`.** Aucun module "auth routes" séparé n'est listé dans `web/main.js` (seulement `public`/`user`/`admin`) ; ces routes sont accessibles sans authentification, donc `public.js` est le bon endroit.
- **Pas de choix de moteur de vues.** `web/main.js` mentionne un "moteur de vues" à l'étape 7 sans en nommer un, et `1-CheckList.md` ne spécifie que la stack serveur. Implémenté avec du rendu HTML par template literals JS (`web/render.js`), sans dépendance supplémentaire — cohérent avec le choix JS pur + JSDoc déjà validé, pas une nouvelle décision d'outillage à valider séparément.
- **Contenu des 15 pages légales/informatives non rédigé.** `web/render.js#legalPage` produit un gabarit structurel marqué explicitement comme placeholder — le texte juridique réel (mentions légales, CGU, etc.) doit venir de Le_Club/d'une relecture juridique, pas être inventé ici.
- **`§2bis Annonces` mentionne "marquer vérifiée"** pour les annonces, mais ni `domain/listings.js` ni le schéma de migration ne définissent de statut "vérifiée" au niveau annonce (le concept "Vérifié" du contrat, M9, s'applique aux **utilisateurs**, via `reputation.evaluateVerified`). Probable résidu de rédaction. Non implémenté (aucune garantie ni schéma ne le sous-tend) ; à clarifier avec le client plutôt qu'à inventer une colonne.
- **Statique/CSS/JS front-end : aucun pipeline choisi.** `web/main.js` sert `/healthz` et les pages HTML côté serveur ; aucune décision de build front-end (bundler, CSS) n'a été prise, car hors du périmètre de la clarification "style de code" initiale. À trancher séparément si une UI plus riche est voulue.

## 2026-09-06 [Q1 - intentions de notification persistées]

Conformément au gabarit du prompt Phase III, `trial.expire`, `dispute.open` et `moderation.sanction` persistent désormais l'intention de notification dans `pending_notifications` (aucune tentative de livraison), avec le commentaire standard `// TODO: canal de notification externe non tranché (Q1)`. Ajout du repo `pendingNotificationsRepo`. Aucun autre sous-ensemble du projet n'est bloqué par Q1.

## 2026-09-06 [M15 - bannière de hiérarchie de rôle]

`guilds.role_hierarchy_ok` ajoutée (booléen, défaut `true`) : porte le second repli explicite de M15/`guildWatcher.js` ("MP au propriétaire si possible, sinon bannière sur le site") — colonne lue par le web pour afficher un avertissement, indépendante de Q1 (M15 spécifie déjà son propre repli, ce n'est pas un cas laissé ouvert).

## 2026-09-06 [bot/ - choix d'implémentation]

- **`bot/main.js` héberge aussi l'abonnement à `event.ownership.changed`** (en plus des `intent.*` qu'il possède explicitement dans le contrat). `transfer.js` est un handler de ce canal mais aucun bloc ne précise quel processus l'héberge — `bot` a déjà la seule connexion bus longue durée de l'architecture, donc c'est l'endroit le plus naturel plutôt que d'ouvrir une connexion dédiée depuis `web`/`jobs`.
- **Archivage de fil hub via `setTimeout` en mémoire** (`bot/hub.js`) : pas de job dédié dans `jobs/main.js` pour cela. Un redémarrage du bot dans la fenêtre de 7 jours saute simplement l'archivage automatique (aucune conséquence sur l'audit ou l'historique, le fil reste lisible) — accepté comme dégradation mineure plutôt que d'ajouter un 6e sous-job pour une pure question de rangement Discord.
- **Salon de négociation du hub identifié par nom** (`negociations`, repli sur `systemChannel`) : le contrat ne précise pas comment `hub.js` retrouve "le salon de négociation du hub" — aucun identifiant de salon n'est configurable nulle part dans `settings`. Convention de nommage choisie, à documenter dans le dossier de vérification Discord (F5) et modifiable si le client préfère un salon existant.

## 2026-09-06 [bug réel - message de conflit brut sur `/annonces`]

Trouvé en test live (retour utilisateur : "Erreur quand je publie une annonce", sans détail). Log serveur : `POST /annonces` → 409. Cause : la guilde de test avait déjà une annonce `active` (créée pendant mes propres tests plus tôt) ; la contrainte `uniq_listings_active_guild` (garantie explicite de `2-Architecture.md`, comportement voulu — une guilde n'a jamais deux annonces vivantes) rejette bien l'insertion, mais `domain/listings.js:create()` ne la vérifiait pas en amont : l'échec remontait tel quel comme `RepoError('ERR_CONFLICT', 'Unique constraint violated: uniq_listings_active_guild')`, et `withAccept()` l'affichait mot pour mot sur la page d'erreur HTML — un utilisateur non technique n'a aucun moyen de comprendre "Unique constraint violated".

Corrigé sans toucher à la contrainte ni à son statut (409) :
- `domain/listings.js:create()` vérifie désormais `listingsRepo.findActiveByGuild` avant l'insertion et lève un code dédié `ERR_GUILD_HAS_ACTIVE_LISTING` (toujours 409 dans `errorMapping.js`) — la contrainte SQL reste le garant final contre toute course, ce n'est qu'un rejet plus tôt et plus clair.
- `web/routes/user.js` : `withAccept()` traduit désormais les codes d'erreur domaine connus (`ERR_GUILD_HAS_ACTIVE_LISTING`, `ERR_BOT_ABSENT`, `ERR_ROLE_HIERARCHY`, `ERR_NOT_OWNER`, `ERR_SEEKING_TAGS_ON_DON`) en phrases françaises lisibles pour les soumissions de formulaire, au lieu d'afficher `code — message` brut. Codes non listés : repli inchangé sur `code — message`.

Vérifié en direct (navigateur réel) : soumettre une deuxième annonce sur un serveur qui en a déjà une active affiche désormais "Ce serveur a déjà une annonce active. Retire-la ou attends sa clôture avant d'en publier une nouvelle."
- **Verrou `BOT_SINGLETON` tenu sur une connexion dédiée pour toute la durée du process** (pas via `withAdvisoryLock`, conçu pour une section critique courte avec libération automatique) — cohérent avec "un seul process bot tourne à la fois", relâché explicitement au `SIGTERM`.

## 2026-09-06 [jobs/main.js - choix d'implémentation]

- **`event.listing.changed` ajouté au jeu de canaux du bus.** Absent de l'énumération fermée `bus/events.js`, mais explicitement nommé par le texte du bloc `db/migrations`... non — par le Process de `domain/listings.js` ("publier event.match.proposed… non : publier intent de re-run matching (event.listing.changed)") ET par `jobs/main.js` ("également déclenché par event.listing.changed avec debounce 30s"). Deux blocs s'accordent sur son existence, seule l'énumération centrale l'omettait — compléter l'énumération plutôt qu'abandonner la fonctionnalité de debounce décrite deux fois.
- **`jobs.trialExpiry` étendu** pour couvrir aussi la clôture après fenêtre de litige et l'exécution des suppressions RGPD après fenêtre de rétractation (cf. notes précédentes transfer.js/dispute.js et gdpr.js) — un seul sous-job supplémentaire de "sweep temporel", pas trois.
- **`ownershipSweep` implémenté en deux ticks distincts** (`ownershipSweep` à 10 min couvrant à la fois le cas horaire "annonce active" et le cas 10 min "essai en cours", plus `ownershipSweepAuditBlind` à 5 min ne couvrant que les guildes `audit_blind`) plutôt qu'une seule fonction à cadence variable par guilde — plus simple à faire tourner sous `setInterval`, résultat identique (guildes horaires jamais resweepées plus souvent que nécessaire, guildes en essai couvertes à 10 min, guildes `audit_blind` en essai couvertes en plus à 5 min).
- **Appels REST Discord dans `jobs` via `discord.js` `REST` seul** (`GET /guilds/{id}`, `GET /guilds/{id}/members/{user}`), sans instancier de `Client` Gateway — cohérent avec "tout appel Discord direct hors sweep REST" étant hors périmètre de `jobs`.

## 2026-09-06 [Intégration bout en bout - point 10 de l'ordre d'implémentation]

`src/integration.dbtest.js` : don (file d'attente) et échange (cycle TTC à 2) de bout en bout jusqu'à `TRANSFERRED`, conformément au point 10 du contrat. Le bus `LISTEN`/`NOTIFY` n'est pas exercé (aucun process bot ne tourne dans ce test) — les confirmations que `bot/trialRole.js` ferait normalement (`trial.confirmTrialStarted`) et l'observation de bascule que `jobs.ownershipSweep`/`bot/guildWatcher.js` ferait normalement (`transfer.onOwnershipChanged`) sont appelées directement, en process, ce qui est exactement le point d'intégration réel entre le bot et le domaine tel que conçu dans ce Phase III (cf. notes trial.js/bot plus haut : ces confirmations sont des appels directs, pas des événements de bus). Ce qui est vérifié ici est le comportement domaine/repositories de bout en bout — la plomberie du bus elle-même n'a pas de logique propre à tester à ce niveau.

## 2026-09-06 [README.md - audit XSS + correction cascade de cycle]

L'utilisateur a ajouté un `README.md` (guide d'installation/déploiement + section "à vérifier avant mise en ligne") pointant deux actions concrètes :

- **Audit échappement HTML** : relecture complète de `web/routes/public.js` et `web/render.js`. Toutes les interpolations de données dynamiques (description, tags, seekingTags, username, mode d'annonce) passent par `escapeHtml()` ; `layout()` échappe aussi `title`. `body` lui-même n'est jamais échappé par `layout()` (il est censé être du HTML déjà construit par l'appelant) — vérifié qu'aucun appelant n'y injecte de valeur brute non échappée. Aucune faille trouvée, comportement déjà correct.
- **Annulation en cascade d'un cycle à 3+ participants — corrigé.** `domain/trial.js#cancel` et `#expire` n'annulaient que la transaction ciblée, laissant les autres arêtes du même cycle actives : un cycle à 3 (A→B→C→A) où A se rétracte laissait B engagé à céder sa guilde à C sans jamais recevoir celle de A, cassant l'argument d'équité du TTC (le cœur du marché de Shapley-Scarf n'a de sens que si l'échange complet a lieu). Ajout : après annulation/expiration de l'arête déclenchante, toutes les transactions soeurs (`transactionsRepo.findByProposalId`) sont annulées en cascade (`actorId: 'system'`), en ignorant silencieusement celles déjà dans un état terminal ou déjà `TRANSFERRED` (jamais annulées rétroactivement, cf. garantie `transfer.js`). Nouveau repo `transactionsRepo.findByProposalId`. Testé par un nouveau cas dans `src/integration.dbtest.js` (cycle à 3, annulation d'une arête, vérification que les 3 transactions passent `CANCELLED` et les 3 annonces reviennent `active`) — passe.

## 2026-09-06 [Vérification réelle - Node.js + Docker disponibles, bugs trouvés et corrigés]

Node.js et Docker installés en cours de session. `npm install`, `npm run lint`, `npm test` et `npm run test:db` (Postgres 16 jetable via Docker) exécutés réellement pour la première fois. Résultat final : **21/21 tests passent, lint propre**. Bugs réels trouvés et corrigés pendant cette passe (aucun n'était détectable par relecture seule) :

- **`config/env.js`** : `export const Config = boot();` s'exécutait à l'import du module — importer seulement `parseConfig`/`ConfigError` pour les tester déclenchait quand même le vrai boot (et son `process.exit(1)`) faute de variables d'environnement réelles, tuant le fichier de test avant la première assertion. Corrigé : `Config` est maintenant un `Proxy` paresseux, `boot()` ne s'exécute qu'au premier accès réel à une propriété — l'import seul reste sans effet de bord.
- **`config/env.test.js`** : `assert.throws(fn, ConfigError)` de `node:assert` ne retourne PAS l'erreur (contrairement à d'autres frameworks) — trois tests lisaient `.code` sur `undefined`. Corrigé avec un helper `try/catch` dédié.
- **`eslint.config.js`** : liste de globals Node incomplète (`Buffer`, `fetch`, `setTimeout`/`setInterval`/`clearTimeout`/`clearInterval`, `URLSearchParams` manquants) → 34 fausses erreurs `no-undef` sur du code par ailleurs correct. Complété.
- **`db/migrations/run.js`** : la détection "suis-je le point d'entrée CLI" (`import.meta.url === \`file://${process.argv[1]}\``) ne correspond jamais sur Windows (séparateurs `\`, pas d'encodage URL, absence du triple-slash) — `npm run migrate` ne faisait donc **rien du tout**, silencieusement, exit 0. Corrigé avec `pathToFileURL(process.argv[1]).href`.
- **`listPublic.explain.dbtest.js`** — plusieurs problèmes de fixture, aucun dans le code applicatif :
  - Cast manquant `text` -> `listing_mode`/`listing_status` dans le `CASE` du seed, rejeté par Postgres.
  - Le fixture de 100 000 lignes n'était jamais nettoyé après le test : `engine.runRound` du test d'intégration (fichier séparé, même base) récupérait 50 000+ annonces `active` parasites et calculait les préférences en O(n²) dessus — perçu d'abord à tort comme un deadlock (des minutes de blocage) avant diagnostic par traçage. Corrigé avec un nettoyage en `after()`.
  - `node --test` exécute les fichiers de test **en parallèle** par défaut (processus séparés) : les deux fichiers `.dbtest.js` étant sur la même base, ils se sont fait la course sur la migration initiale d'une base fraîche (l'un `skip` car verrou déjà pris, alors que l'autre n'avait pas fini de créer le schéma) → `relation "users" does not exist`. Inoffensif en production (la migration est une étape de déploiement explicite et unique, jamais lancée en parallèle par plusieurs process), mais cassait la fiabilité des tests. Corrigé avec `--test-concurrency=1` sur le script `test:db`.
  - Les 100 000 lignes générées en une seule requête `generate_series` partageaient quasiment le même `created_at` (un seul `now()` pour toute l'instruction), ce qui empêchait l'index composite `(status, mode, created_at DESC)` de court-circuiter `ORDER BY ... LIMIT` (égalités multiples sur la clé de tri). Corrigé en étalant les timestamps (`now() - (i || ' seconds')::interval`) — reflète aussi mieux la réalité (les annonces ne sont jamais toutes créées à l'instant précis).
  - Sélectivité du terme de recherche plein texte ajustée de 4 % à ~0,5 % des lignes : à 4 %, Postgres choisit légitimement un Seq Scan (coût d'E/S aléatoire d'un bitmap heap scan supérieur à un balayage séquentiel) — comportement correct du planificateur, pas un défaut d'index ; un terme de recherche réaliste est plus rare.
- **Trouvaille annexe, non corrigée (hors périmètre code applicatif)** : supprimer 100 000 lignes de `guilds` a pris 53 s dans le fixture de test, à cause des vérifications `RESTRICT` séquentielles sur `transactions.guild_id`/`ownership_events.guild_id` (non indexées). Sans conséquence en production — aucun chemin applicatif ne supprime jamais une ligne `guilds` (cf. `domain/gdpr.js`, pseudonymisation uniquement) — donc non corrigé dans le schéma ; le nettoyage du fixture évite simplement de supprimer les guildes de test.

## 2026-09-06 [Bilan de vérification - à faire dès Node.js disponible] — RÉSOLU, voir l'entrée du dessus

L'intégralité du code de ce Phase III (32 blocs BIOPGE) a été écrite sans pouvoir exécuter `npm install` ni aucun test — Node.js était absent de la machine tout au long de l'implémentation. **Avant de considérer un seul bloc comme validé au sens du contrat**, il reste à faire, dans l'ordre :
1. `npm install`
2. `npm run lint` — corriger toute erreur ESLint (imports inutilisés notamment, plusieurs ont déjà été retirés manuellement mais un passage automatisé reste nécessaire)
3. `npm test` — unitaires purs (`config/env.test.js`, `domain/matching/ttc.test.js`)
4. Une base Postgres jetable + `TEST_DATABASE_URL`, puis `npm run test:db` — `listPublic.explain.dbtest.js` (zéro Seq Scan à 100k lignes) et `integration.dbtest.js` (don + échange bout en bout)
5. Revue humaine de tous les points listés dans ce fichier (compléments de schéma, choix d'implémentation, gaps A18/dispute-window/RGPD) — chacun est une décision de Phase III prise sans aller-retour avec l'auteur du contrat, à confirmer ou amender.

**Fait le 2026-09-06** : les 4 premiers points sont faits (21/21 tests passent, lint propre) — voir l'entrée "Vérification réelle" ci-dessus pour le détail des bugs trouvés en cours de route. Le point 5 (revue humaine) reste ouvert.

## 2026-09-06 [Setup initial]

- Repo non existant au démarrage de Phase III (pas de `.git`, pas de `package.json`). Scaffold créé : `package.json` (ESM, `"type": "module"`), ESLint + Prettier, `.gitignore`, `git init`.
- Fichiers `1-CheckList.md`, `2-Architecture.md`, `prompt-claude-code-phase3.md` déplacés vers `docs/devnotes/` pour correspondre aux chemins référencés dans le contrat (`docs/devnotes/1-CheckList.md`, `docs/devnotes/2-Architecture.md`).

## 2026-09-08 [A24 - retour sur A18 : plus de blocage RESTRICT sur la suppression d'annonce]

Remonté par le client en revoyant le correctif précédent (le bouton "Supprimer" transformé en simple note pour l'annonce "Cacahuètes et Kkhuètes", elle-même bloquée par une ligne `match_participants` historique) : "Inutile de la garder dans l'historique. Or, il peut être bon de garder les créations et les suppressions - pour que des futurs admins pourront consulter." Autrement dit : la ligne `listings` elle-même n'a pas besoin de survivre pour ça — `audit_log.before`/`after` le fait déjà (`listing.created` capture le contenu intégral dès la création, `listing.removed`/`.removed_soft_fallback` la capture à nouveau juste avant suppression). C'est une révision d'A18 par la même personne qui avait tranché A18 en connaissance du compromis — pas un désaccord avec un tiers, donc pas d'escalade nécessaire.

Migration `005_listings_delete_set_null.sql` : les trois FK vers `listings(id)` (`match_participants.listing_id` — rendue nullable, `.gives_to_listing_id`, `listing_queue.listing_id` — rendue nullable) passent de `ON DELETE RESTRICT` à `ON DELETE SET NULL`. Vérifié avant de toucher au schéma que rien ne lit ces colonnes en supposant qu'elles restent non-nulles après coup (`engine.js`, `trial.js`, `user.js` ne les lisent que pendant qu'une proposition est encore ouverte, jamais après qu'une annonce impliquée ait pu être supprimée — `assertMutable` interdit de toute façon de supprimer une annonce encore `matched`/`fulfilled`).

`domain/listings.js:remove()` inchangé dans sa logique — `hardDelete` tente toujours le `DELETE` réel d'abord ; son `catch` sur `23503` devient un filet purement défensif (plus le chemin normal pour ces deux tables). `web/routes/user.js` : le bouton "Supprimer" redevient offert sur le statut `removed` sans commentaire particulier (retiré : la note ajoutée dans le commit précédent expliquant pourquoi il ne servait à rien — elle ne décrit plus la réalité).

Nettoyage ponctuel de la base de dev une fois la migration appliquée : 4 lignes `removed` traînaient (2 legacy dont l'annonce citée par le client, 2 lignes de fixture `harddelete-fallback-guild-*` — pollution de `npm run test:db`, cf. entrée séparée ci-dessous) — supprimées physiquement à la main, plus rien ne les en empêchait.

Test dbtest `removing a listing that a candidate ever queued on falls back to a soft delete` renommé et réécrit pour vérifier le nouveau comportement (suppression physique réelle, `listing_queue.listing_id` mis à `NULL` sur la ligne conservée) plutôt que l'ancien repli.

Vérifié : test (6) + test:db (14) au vert, testé en direct dans Chrome (le bouton "Supprimer" sur l'annonce citée par le client fait bien disparaître la ligne cette fois).

## 2026-09-08 [bug d'environnement trouvé en cours de route - `npm run test:db` écrivait dans la base de dev]

En creusant le blocage `match_participants` ci-dessus, découverte que `integration.dbtest.js` fait `process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? Config.databaseUrl` — et `TEST_DATABASE_URL` n'a jamais été défini dans `.env`. Résultat : chaque `npm run test:db` de cette session (et probablement des précédentes) tournait en fait contre `xyro-dev-pg` (port 55433, la base "réelle" utilisée en test manuel), pas contre `xyro-test-pg` (port 55432, censée être la base jetable dédiée) — d'où les lignes `harddelete-fallback-guild-*` retrouvées dans la base de dev alors qu'elles ne devraient exister que dans une base jetée après coup. `xyro-test-pg` tournait bien (`docker ps` la montrait "Up"), simplement rien ne s'y connectait jamais.

Corrigé : `TEST_DATABASE_URL` ajouté à `.env` (port 55432, même identifiants que `DATABASE_URL`) ; migrations rejouées sur `xyro-test-pg` pour qu'elle ait le même schéma que la base de dev. `.env` n'étant pas versionné, rien à committer ici — seule cette entrée documente la cause et le correctif pour que ça ne resurgisse pas sans explication.

## 2026-09-08 [A25 - aucune vérification de correspondance de tags sur `proposeDirectSwap`]

Demande utilisateur : "quand on consulte une annonce, on doit pouvoir proposer TOUTES les annonces en échange. La vérification de la correspondance des flags se fait en aval." Avant de coder quoi que ce soit, vérifié le code existant en entier (`public.js` §annonce/:id, `engine.proposeDirectSwap`, tout `seekingTags`/`seeking_tags` dans `src/`) : aucune restriction de tags n'existait nulle part, ni en amont (le menu déroulant "Proposer en échange" liste déjà **toutes** les annonces `echange` actives du propriétaire, sans filtre) ni en aval (`proposeDirectSwap` ne vérifiait que le mode des deux côtés, jamais `tags`/`seekingTags`). Question posée au client pour trancher entre "corriger un vrai manque" et "confirmer que rien à faire" — réponse : corriger le manque.

Indice trouvé a posteriori qui confirme que ce n'était pas juste une préférence mais un oubli réel : les fixtures des dbtests existants pour `proposeDirectSwap` (A19, A20, A21, le test de cascade d'annulation) utilisent **toutes** des paires de tags/seekingTags parfaitement complémentaires (cuisine/jardinage, alpha/beta, un/deux) — signe que l'auteur de ces tests (une autre session, lors du travail A19) avait déjà en tête cette correspondance sans jamais l'avoir réellement codée.

Ajouté dans `engine.js:proposeDirectSwap`, juste après la vérification de mode : rejet (`ERR_TAG_MISMATCH`, 400) si aucune des deux directions ne recoupe (`mine.tags ∩ theirs.seekingTags` et `theirs.tags ∩ mine.seekingTags` — les deux doivent être non vides). Même exigence que l'ancien moteur TTC imposait par construction (`preferences.js`, retiré par A19 : un candidat sans recoupement de tags avait un score de 0 et était exclu), reprise comme simple porte booléenne puisqu'il n'y a plus de classement à calculer pour une proposition à deux parties. Le menu déroulant lui-même reste inchangé (déjà correct).

Nouveau dbtest `A25` : deux annonces sans aucune correspondance sont rejetées (`ERR_TAG_MISMATCH`), et restent `active` toutes les deux (rejet avant tout `claimForMatch`, rien à défaire).

Vérifié : test (6) + test:db (15, la nouvelle incluse) au vert. Les 4 tests dbtest existants qui appellent `proposeDirectSwap` utilisent tous des tags déjà complémentaires (cf. indice ci-dessus) — aucun n'a eu besoin d'être modifié.
