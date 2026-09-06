# Prompt Claude Code — Xyro Market V1 (PACT Phase III)

## Contexte

Tu implémentes la V1 de Xyro Market, une plateforme d'échange/don de serveurs Discord. L'architecture est entièrement spécifiée et verrouillée. Ton rôle ici est **Phase III du protocole PACT : traduire un contrat déjà validé en code, pas concevoir**.

## Documents de référence — lecture intégrale obligatoire avant tout code

- `docs/devnotes/1-CheckList.md` (LOCKED)
- `docs/devnotes/2-Architecture.md` (Rév. b, 32 blocs BIOPGE)

S'ils ne sont pas présents dans le repo, arrête-toi et demande-les avant de continuer. Ne code rien à partir d'un résumé ou d'une supposition sur leur contenu.

## Discipline de cadre — non négociable

- Implémente ce que le contrat spécifie. Ne redesigne pas, même si tu vois une meilleure façon de faire — propose-la en commentaire de PR, n'improvise pas en silence.
- Le BIOPGE est de la documentation, jamais du code.
  - **Interdit dans le code source** : tableaux BIOPGE reproduits, labels `Boundary:`/`Inputs:`/`Outputs:`/`Process:`/`Guarantees:`/`Errors:` en commentaire ou docstring, tags `# BIOPGE block: ...`.
  - **Autorisé et attendu** : docstrings/JSDoc standards décrivant ce que fait la fonction pour un lecteur qui n'a jamais vu le contrat ; commentaires ponctuels sur la logique non évidente.
- **Erreur de syntaxe** (typo, import faux, mauvais cast, off-by-one, oubli de return) → corrige sur place, reste en Phase III.
- **Erreur de logique** (flux faux, garantie impossible à tenir, cas manquant, invariant faux, type qui ne matche pas entre deux blocs) → **STOP**, ne corrige pas silencieusement le contrat, remonte avec le gabarit ci-dessous et attends.
- **Incohérence systémique** (l'architecture produit quelque chose d'absurde, plusieurs blocs devraient être réécrits) → STOP, escalade explicite à revoir en Phase I.

### Gabarit — erreur de logique

```
LOGIC ERROR - Phase II required
Block  : [nom du fichier/bloc]
Issue  : [ce qui cloche dans le contrat]
Impact : [ce qui casse si ignoré]
Fix    : [amendement suggéré à 2-Architecture.md]
Action : Bloc en pause. Attends validation avant de continuer.
```

## Statut des points ouverts — à respecter tel quel, pas à trancher

**Q1 (bloquant, décision produit) — NON RÉSOLU.** Aucun canal de notification hors plateforme n'est décidé (ni e-mail, ni DM). N'implémente **aucun** canal de livraison autre que le thread hub Discord et le site. Pour tout événement qui *devrait* notifier hors plateforme (`trial.expire`, `dispute.open`, `moderation.sanction`) : persiste l'intention (ex. table `pending_notifications`) sans tenter de livraison, avec un commentaire standard `// TODO: canal de notification externe non tranché (Q1)`. Le reste de l'implémentation continue normalement — Q1 ne bloque que ce sous-ensemble, pas le projet entier.

**A16-A19, A21, A22 (non bloquants)** : implémente les défauts retenus tels que listés dans `2-Architecture.md` § OPEN niveau 2. Ne les redécide pas, ne les optimise pas différemment.

**A22 — vérification obligatoire avant codage.** Avant d'écrire `bot/guildWatcher.js` et le mapping intent `GuildModeration` → événement `guildAuditLogEntryCreate`, vérifie ce couplage contre la documentation Discord et discord.js **actuelle**. Si le couplage a changé ou n'existe pas tel que décrit dans le contrat, ne code pas de contournement en silence : flag comme erreur de logique (le contrat suppose un fait d'API qui ne tient plus) et propose l'option de repli déjà documentée dans A22 (`GUILD_MEMBERS` privilégié).

## Ordre d'implémentation recommandé

Dépendances d'abord, point d'entrée en dernier :

1. `config/env.js`, `db/pool.js`, `db/migrations/` (avec les index de recherche spécifiés)
2. `db/repositories/`, `bus/events.js`
3. `domain/rbac.js`, `domain/audit.js`, `domain/ownership.js`
4. `domain/listings.js`, `domain/matching/{preferences,queue,ttc,engine}.js`
5. `domain/trial.js`, `domain/transfer.js`, `domain/dispute.js`
6. `domain/reputation.js`, `domain/moderation.js`, `domain/gdpr.js`, `domain/stats.js`
7. `web/main.js`, `web/auth/*`, `web/routes/*`
8. `bot/main.js`, `bot/guildWatcher.js`, `bot/hub.js`, `bot/trialRole.js`, `bot/announce.js`
9. `jobs/main.js`
10. Intégration bout en bout : un tour de matching complet (don + échange) jusqu'au témoin de transfert

## Tests explicitement exigés par le contrat — non optionnels

Ces trois tests sont des garanties falsifiables inscrites dans `2-Architecture.md`. Leur absence est une non-conformité au contrat, pas un oubli mineur :

- **`db/migrations`** : `EXPLAIN` sur `listPublic` filtré par tags/mode/texte, sur un jeu de 100 000 annonces — zéro `Seq Scan` sur `listings` toléré.
- **`domain/matching/ttc.js`** : compteur global d'avancées de curseur ≤ Σ|prefs| sur l'exécution complète — la complexité `O(n + Σ|prefs|)` annoncée est une propriété du codage, pas de l'algorithme, elle doit être vérifiée.
- **`config/env.js`** : le boot doit échouer si `SESSION_SECRET === TOKEN_ENC_KEY`.

## Style de code

`1-CheckList.md` ne spécifie que la stack (Node.js ESM, Fastify, discord.js, PostgreSQL). Rien n'est dit sur lint, formatage, ou conventions de commentaires. **Ne les invente pas** : si le repo ne contient pas déjà une config (ESLint, Prettier, JSDoc systématique ou non, JS pur ou TypeScript), demande avant d'écrire le premier fichier plutôt que de choisir seul.

## `3-DebugNotes.md`

Ouvre `docs/devnotes/3-DebugNotes.md` dès le premier bloc codé. Une entrée par décision non triviale, retroactivité, ou ressource externe consultée (notamment la vérification A22) :

```
## [date] [bloc/sujet]
- [décision / retroactivité / ressource / rationale courte]
```

Un commit par bloc validé est recommandé pour la traçabilité — `3-DebugNotes.md` complète les commits, ne les remplace pas.

## Livrable

Code fonctionnel et auditable où chaque fonction se retrace, via la documentation seule, à un bloc BIOPGE de `2-Architecture.md`. Le code reste propre, sans aucune contamination croisée entre le contrat et le source.
