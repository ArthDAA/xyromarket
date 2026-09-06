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

## 2026-09-06 [Setup initial]

- Repo non existant au démarrage de Phase III (pas de `.git`, pas de `package.json`). Scaffold créé : `package.json` (ESM, `"type": "module"`), ESLint + Prettier, `.gitignore`, `git init`.
- Fichiers `1-CheckList.md`, `2-Architecture.md`, `prompt-claude-code-phase3.md` déplacés vers `docs/devnotes/` pour correspondre aux chemins référencés dans le contrat (`docs/devnotes/1-CheckList.md`, `docs/devnotes/2-Architecture.md`).
