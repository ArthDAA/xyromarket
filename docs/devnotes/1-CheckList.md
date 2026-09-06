# 1-CheckList.md - Xyro Market

| PACT Phase I -> Procedure for Architecture Contracts and Typing
| Author: Arthus De Assis-Allix
| Subject: Mission AllôStaff — plateforme d'échange/don de serveurs Discord (client: Le_Club)
| Date: 2026-09-04 -> Ready for Phase II : `2-Architecture.md`
| Statut : LOCKED — prêt pour Phase II

---

## 1. Formats

| # | Element | Value | Source |
|---|---|---|---|
| F1 | Hébergement | By-Hoster, VPS KVM Proxmox — projet infra from scratch, pas de reprise de l'existant Cloudflare Workers | Contrainte perso Arthus + confirmation client |
| F2 | Stack bot | Node.js + discord.js, Gateway persistante (pas interactions HTTP-only) | Décision dev, cohérente avec F1 |
| F3 | Base de données | PostgreSQL local sur le VPS | Décision dev |
| F4 | Paiement | Zéro système de paiement — don/troc uniquement | Client (msg 19) + footer légal ("actuellement gratuit") |
| F5 | Vérification Discord | Dossier de vérification app à préparer avant 100 guildes | Contrainte plateforme Discord |
| F6 | Nom du projet | Xyro Market | Client — corrige "Xparia" (obsolète) |
| F7 | Domaine | Nouveau nom de domaine à définir/acquérir, hors architecture v1 sauf précision ultérieure | Client — tâche différée |

## 2. Mandatory

| # | Item | Source |
|---|---|---|
| M1 | OAuth2 (`identify`+`guilds`) — lister les serveurs possédés par l'utilisateur | Conception dev |
| M2 | Bot ajouté à chaque guilde listée — vérification continue de `owner_id` | Conception dev |
| M3 | Listing : thème (tags libres, hashtag) + description + mode (`don`\|`échange`) + taille communauté (informatif) + critères recherchés (échange uniquement) | Client (msg 27) + A1/A2/A11 |
| M4 | Moteur de matching : file d'attente simple (don), graphe + cycles n-aires TTC (échange) — les deux dès v1 | Client (msg 27) + A6/A8 |
| M5 | Chat : threads privés dans un serveur hub Discord, contrôlé par le bot | Client (msg 24, 27) + A4 |
| M6 | Témoin de transfert : bot observe et horodate le bascule `owner_id` des deux côtés | Conception dev |
| M7 | Annonce automatique de passation postée par le bot dans le serveur repris | A5 |
| M8 | Pages légales/RGPD : mentions légales, CGU, confidentialité, cookies + gestion, propriété intellectuelle, données personnelles, exercice droits RGPD, suppression données, politique sécurité, règlement Xyro Market, règles Discord, anti-fraude, anti-abus, signalement, droit de rétractation (clause "gratuit pour l'instant") | Client (footer fourni) |
| M9 | Système de réputation : notes après transaction, avis/commentaires, total avis, moyenne, historique par utilisateur, tag "Vérifié" à conditions paramétrables par l'admin (retirable/modifiable), protection anti-faux-avis et anti-auto-évaluation | Client (doc détaillé) — réouverture de A3 |
| M10 | Panel administrateur complet — voir §2bis pour le détail | Client (doc détaillé) |
| M11 | Période d'essai avant transfert définitif : le bot crée/assigne un rôle "Administrateur (essai)" au destinataire pendant une durée configurable (défaut proposé : 7 jours, `[ASSUMED]` — voir A15), sans transfert réel de `owner_id` | Client (msg trial) + A14 |
| M12 | À l'issue de la période, si les deux parties valident : transfert réel effectué manuellement par le propriétaire (contrainte API inchangée, jamais automatisable) — le bot bascule alors en mode témoin (cf. M6) | Client (msg trial) + A14 |
| M13 | Annulation pendant la période d'essai : le bot révoque le rôle "Administrateur (essai)" — le propriétaire réel garde la priorité de hiérarchie sur ce rôle et peut le révoquer unilatéralement à tout moment, sans dépendre du consentement de l'autre partie | Client (msg trial) + A14 |
| M14 | Mécanisme d'enregistrement/litige pour le cas plus rare d'une annulation demandée *après* le transfert réel (`owner_id` déjà basculé) : enregistrer la demande, notifier les deux parties, vérification par l'équipe, retour effectif toujours manuel, historique complet | Client (doc détaillé) — reprend l'intention initiale du "droit de rétractation" |
| M15 | Vérification au moment de l'ajout du bot sur une guilde listée : son rôle doit être positionné au-dessus du rôle "Administrateur (essai)" qu'il devra attribuer — alerte si absent, sinon M11 échoue silencieusement | Contrainte technique Discord (hiérarchie des rôles) |

~~Snapshot cron post-transfert~~ reste retiré — sa seule fonction était de mesurer l'issue pour un scoring de réputation basé sur la croissance, ce que le système d'avis (M9) ne nécessite pas.

### 2bis. Mandatory — Panel Admin (détail)

| Domaine | Fonctions |
|---|---|
| Utilisateurs | Liste, recherche, profil, annonces, historique, ban temporaire, ban définitif, débannir, suspendre, réactiver, modifier compte, gérer permissions/rôles, statut vérifié, consulter signalements — ban = plateforme uniquement (cf. A13), aucune action réelle sur Discord |
| Annonces | Liste, recherche, modifier, masquer, supprimer, restaurer, valider/refuser, marquer vérifiée, historique modifications, gérer tags (cf. A11 — gestion des hashtags, pas de taxonomie séparée) |
| Modération/Signalements | Liste/filtre signalements, ouvrir/traiter/classer un dossier, sanctionner (plateforme uniquement), notes internes, historique sanctions + traitants |
| Avis/Réputation | Liste avis, suppression avis frauduleux, signalement d'avis, statut d'avis, gestion utilisateurs vérifiés, statistiques de réputation |
| Permissions (RBAC) | Rôles Administrateur / Modérateur / Support / Gestionnaire / Propriétaire ; permissions granulaires par fonction, pas seulement par rôle fixe |
| Transactions | Liste, parties, statut, demandes de retour, dossiers de litige, notes internes, résolution, historique complet |
| Configuration site | Tags/hashtags, règles, textes affichés, rôles/permissions, paramètres modération/avis/annonces |
| Statistiques | Nb utilisateurs / annonces / transactions / signalements / bans / avis, activité récente |
| Logs/audit | Qui, quelle action, sur quoi, quand, ancienne/nouvelle valeur — trace de toute action admin importante |

## 3. Bonus

| # | Item | Targeted? | Source |
|---|---|---|---|
| B1 | Preview sans bot via `GET /invites/{code}?with_counts=true` (onboarding léger) | deferred | Conception dev |

## 4. Open Points

| # | Item | Decision | Rationale |
|---|---|---|---|
| O1 | Ratio présence/membres comme filtre de tri | Écarté | La plateforme cible des communautés endormies — l'inertie est le cas d'usage, pas l'anomalie |
| O2 | Mécanisme de chat | Threads privés en hub, pas de DM relay | Fiabilité (403 sur DM fermés/pas de guilde commune) |
| O3 | Intent `GUILD_MEMBERS` | Non demandé | Pas de scoring nécessitant le filtrage des bots dans le ratio |

## 5. Ambiguities

| # | Question | Resolution | Rationale |
|---|---|---|---|
| A1 | Taxonomie des thèmes | Tags libres, système hashtag | Réponse client |
| A2 | Taille de communauté : critère de matching ou informatif ? | Purement informatif, jamais utilisé pour matcher | Réponse client |
| A3 | Délai d'évaluation réputation | **Réouverte** — système de réputation confirmé requis (voir M9), delai d'evaluation non applicable (pas de mécanique de croissance a évaluer) | Réponse client (doc détaillé) |
| A4 | Modération du hub Discord | 100% bot | Réponse client |
| A5 | Annonce de passation | Automatique | Réponse client |
| A6 | Scope MVP (dons/échanges, n-cycles) | Don + échange dès v1, matching n-cycles dès v1, pas de version allégée | Réponse client (confirmation directe) |
| A7 | Statut juridique du projet | Aucun statut formel — responsabilité RGPD reste sur Le_Club en tant que personne physique | Réponse client — documenté dans M8 |
| A8 | Périmètre v1 | Scope complet | Réponse client |
| A9 | Nommage du projet | Xyro Market — "Xparia" (transcript msg 11) était un nom obsolète/reliquat | Réponse client |
| A10 | Infra existante (Cloudflare Workers) vs mandat By-Hoster | Projet from scratch chez By-Hoster, aucune migration/reprise de l'ancien sous-domaine | Réponse client |
| A11 | "Catégories" (doc panel) vs tags (A1) | Même mécanisme — hashtags. "Gérer les catégories" du panel = gestion des tags, pas une taxonomie séparée | Réponse client |
| A12 | "Publication directe" + "modération en amont" (contradictoires tels quels) | Publication directe, modération **en aval** (post-publication) — "valider/refuser" du panel est une action a posteriori, pas une file d'attente pré-publication | Réponse client |
| A13 | Portée du "ban" (site ou Discord réel) | Ban = plateforme uniquement, pas d'action sur le serveur Discord | Réponse client |
| A14 | Mécanisme de retour/rétractation — escrow via propriété bot demandé | Confirmé : rôle "Administrateur (essai)" pendant une période paramétrable, transfert réel manuel seulement après validation des deux parties en fin de période (cf. M11-M13) | Réponse client — confirme et étend la proposition dev |
| A15 | Durée de la période d'essai (M11) | `[ASSUMED]` : 7 jours par défaut, ensuite configurable via le panel admin (§2bis, Configuration du site) | Pas de valeur donnée par le client ("x jours") — proposition dev à valider ou ajuster |
