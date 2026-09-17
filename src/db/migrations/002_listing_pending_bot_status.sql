-- Nouveau statut intermédiaire : une annonce peut désormais être publiée
-- avant que le bot ait rejoint la guilde (cf. domain/listings.js:create,
-- bot/guildWatcher.js:onGuildCreate). ADD VALUE ne peut pas être consommé
-- dans la même transaction que celle qui l'ajoute (contrainte Postgres) —
-- c'est pourquoi l'index qui l'utilise vit dans 003, pas ici.
ALTER TYPE listing_status ADD VALUE 'pending_bot';
