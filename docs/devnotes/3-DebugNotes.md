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

## 2026-09-06 [Setup initial]

- Repo non existant au démarrage de Phase III (pas de `.git`, pas de `package.json`). Scaffold créé : `package.json` (ESM, `"type": "module"`), ESLint + Prettier, `.gitignore`, `git init`.
- Fichiers `1-CheckList.md`, `2-Architecture.md`, `prompt-claude-code-phase3.md` déplacés vers `docs/devnotes/` pour correspondre aux chemins référencés dans le contrat (`docs/devnotes/1-CheckList.md`, `docs/devnotes/2-Architecture.md`).
