# 4-Audit.md - Xyro Market

| Audit de clôture Phase III — PACT final
| Date : 2026-09-17
| Base : code réel extrait de l'archive de travail (pas seulement `git log`), `1-CheckList.md` (A1-A32), `2-Architecture.md` (Rév. a-n), `3-DebugNotes.md`
| Méthode : lecture directe du code (routes, échappement HTML, intents, tests), exécution réelle de `npm run lint` et `npm test`, vérification externe d'A22 contre la documentation Discord courante. `npm run test:db` et l'intégration bout en bout **non exécutables dans cet environnement d'audit** (pas de Postgres, pas de réseau) — statut déclaré par `3-DebugNotes.md`, non re-vérifié ici.

---

## 1. État d'exécution vérifié

| Vérification | Résultat | Comment |
|---|---|---|
| `npm run lint` | ✅ propre | Exécuté réellement |
| `npm test` (unitaires) | ✅ 6/6 | Exécuté réellement — `ttc.test.js` a disparu avec A19, aucun remplaçant unitaire pour `proposeDirectSwap`/`ERR_TAG_MISMATCH` (A25) |
| `npm run test:db` (EXPLAIN, intégration) | ⚠ non vérifié ici | Pas de Postgres dans cet environnement. Dernier statut connu (`3-DebugNotes.md`, avant A24-A32) : vert. À rejouer avant Étape 1 — le schéma a changé quatre fois depuis (migrations 002-006) |
| Échappement HTML (`web/render.js` + tous les points d'interpolation de `description`/`tags`/`username`/`name`) | ✅ systématique | Vérifié par grep exhaustif sur `public.js`/`user.js`/`admin.js` — aucune fuite trouvée |
| Intent Discord A22 (`GuildModeration` non privilégié, `guildAuditLogEntryCreate`) | ✅ confirmé à nouveau | Vérifié indépendamment contre `docs.discord.com` (recherche web, 2026-09-17) |
| Historique git vs arbre de travail | ❌ **divergent** | `git log` s'arrête au commit A25. `git status` : 29 fichiers modifiés/supprimés/non suivis — la totalité d'A19 (retrait TTC) à A32 (lien panel admin) n'existe que dans l'arbre de travail. `ttc.js`/`preferences.js` sont encore le HEAD git alors que supprimés en local. |

---

## 2. Couverture fonctionnelle — Mandatory (`1-CheckList.md`)

| # | Exigence | Statut | Note |
|---|---|---|---|
| M1 | OAuth2 identify+guilds | ✅ | `web/auth/oauth.js` |
| M2 | Bot ajouté, `owner_id` vérifié en continu | ✅ | `ownership.js`, `guildWatcher.js`, `jobs.ownershipSweep` |
| M3 | Listing (tags/description/mode/taille/critères) | ✅ | `domain/listings.js` |
| M4 | Matching don + échange, n-cycles dès v1 | ⚠ **révisé par A19 — validé** | File d'attente (don) intacte. Échange n-aire **retiré**, remplacé par proposition manuelle à 2 parties (`engine.proposeDirectSwap`). Contredit M4/A6/A8 tels que verrouillés en Phase I. **Signé par Le_Club le 2026-09-17** (cf. `1-CheckList.md` A19) — reste un écart technique au contrat original, mais plus un gap de mandat. |
| M5 | Chat — threads privés hub | ✅ | `bot/hub.js`, corrigé par A20 (ouverture à la proposition, pas à l'acceptation), complété par A22/A23 (invite + MP de repli) |
| M6 | Témoin de transfert | ✅ | `ownership.js` + `transfer.js` |
| M7 | Annonce automatique de passation | ✅ | `bot/announce.js` |
| M8 | Pages légales/RGPD | ⚠ **structure complète, contenu absent** | 14 routes existent, `render.js#legalPage` explicitement un gabarit — "Contenu à rédiger" |
| M9 | Réputation (avis, moyenne, tag Vérifié) | ✅ | `domain/reputation.js` (non re-audité ligne à ligne cette passe, statut hérité de la revue précédente) |
| M10 | Panel admin complet | ✅ **avec un gap** | 9 domaines exposés, RBAC granulaire réel (pas de test en dur sur un nom de rôle), interface HTML (A27). Gap : voir §3 |
| M11 | Période d'essai, rôle "Administrateur (essai)" | ✅ | `trial.js`, `bot/trialRole.js` |
| M12 | Transfert réel manuel + bot témoin | ✅ | `transfer.js` |
| M13 | Annulation unilatérale par le propriétaire réel | ✅ | Cascade sur les transactions sœurs confirmée par le git log (`c5c4a0e`), antérieure même à A19 |
| M14 | Litige post-transfert | ✅ | `dispute.js`, route `POST /transactions/:id/litige` (utilisateur) + `/admin/disputes/:id/resolve` |
| M15 | Vérification hiérarchie de rôle du bot | ✅ | Portée par `listings.js`/`trialRole.js`/`guildWatcher.js` |

## 3. Couverture fonctionnelle — Panel admin (§2bis)

| Domaine | Statut | Note |
|---|---|---|
| Utilisateurs | ✅ | Recherche, profil, ban/suspend/lift, rôles — tout présent |
| Annonces | ⚠ | Liste, recherche, masquer, restaurer, tags : présents. **"Valider/refuser" n'existe pas comme action nommée distincte** — probablement non-problème (A12 a supprimé la notion de file de pré-publication, donc "valider" n'a plus d'objet), mais le libellé du contrat n'a jamais été corrigé en conséquence. À clarifier pour lever l'ambiguïté, pas un vrai manque fonctionnel. |
| Modération/Signalements | ✅ | Liste, filtre, assignation, notes, résolution |
| Avis/Réputation | ✅ | Liste, masquage, statistiques |
| Permissions (RBAC) | ✅ | Rôles + permissions granulaires, garde-fous corrigés par A27 |
| **Transactions** | ✅ **résolu 2026-09-17 (A33)** | `GET /admin/transactions?status=&guildId=` ajoutée (`transactionsRepo.listForModeration`), plus le lien "Transactions" sur l'index `/admin` qui manquait aussi. Au moment de cet audit : seule `GET /admin/transactions/:id` (lookup par UUID connu) existait, aucune liste/filtre — le domaine le plus sensible du panel (litiges) était le moins navigable. |
| Configuration site | ✅ | |
| Statistiques | ✅ | |
| Logs/audit | ✅ | |

## 4. Ce qui manque, par ordre de conséquence

1. ~~A19 non signé par Le_Club.~~ **Résolu 2026-09-17** — validé par le client (cf. `1-CheckList.md` A19). Le renversement le plus important du projet (plus de matching n-aire automatique) n'était pas encore validé par celui qui avait explicitement verrouillé l'exigence contraire au moment de cet audit ; ce n'était pas un gap technique mais un gap de mandat, désormais levé.
2. ~~29 fichiers non committés~~ **Résolu 2026-09-17** — commit `32fd155` (31 fichiers, A16→A33). Pas encore poussé sur un remote, mais le risque de perte locale immédiate (disque, `git checkout .` malheureux) est levé.
3. ~~Aucune liste de transactions côté admin.~~ **Résolu 2026-09-17 (A33).**
4. **Pages légales toujours placeholder.** Bloquant pour une mise en ligne réelle, indépendamment d'Étape 1.
5. **Q1 (notification hors plateforme) toujours ouvert.** Mode d'échec documenté, pas théorique.
6. **Bootstrap du premier admin** toujours manuel (`INSERT` SQL direct), aucune régression depuis A27/A32.
7. ~~`npm run test:db` non rejoué depuis 4 migrations.~~ **Résolu 2026-09-17** — rejoué sur le schéma actuel (post-migration 006) : 19/19 au vert, lint propre.

## 5. Ce qui est solide

Lint propre, tests unitaires verts, échappement HTML systématique et vérifié directement (pas supposé), witness de transfert et FSM d'essai cohérents avec le contrat, cascade d'annulation sur cycle déjà en place, RBAC réellement granulaire (pas de test de rôle en dur), plusieurs bugs réels trouvés et corrigés par du test en conditions réelles plutôt que par relecture (A20, A21, A26, A27). La discipline PACT elle-même a été respectée dans le contenu — chaque écart est documenté avec sa raison — seule sa **propagation** vers `2-Architecture.md` et vers git a pris du retard.

## 6. Recommandation

Avant Étape 1 (mise en production) :

1. ~~Committer les 29 fichiers~~ **fait** (`32fd155`).
2. ~~Envoyer A19 à Le_Club pour validation explicite~~ **fait, validé 2026-09-17**.
3. ~~Rejouer `npm run test:db` sur le schéma actuel~~ **fait, 19/19 au vert**.
4. ~~Ajouter une route de liste pour `2bis Transactions`~~ **fait (A33)**.
5. Contenu réel des pages légales.

Bootstrap admin : **tranché, 2026-09-17** (cf. `1-CheckList.md` E10) — Arthus devient le `proprietaire` originel via `INSERT` SQL manuel, puis attribue le rôle admin à Le_Club depuis le panel. Choix conscient, pas de mécanisme self-service construit.

Le reste (Q1, contenu légal encore en attente du client) peut attendre un premier déploiement restreint, à condition que ce soit un choix conscient et non un oubli.
