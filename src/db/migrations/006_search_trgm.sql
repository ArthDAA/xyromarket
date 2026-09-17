-- Recherche légère (utilisateur/alias/serveur/tag) côté public et admin.
-- `pg_trgm` accélère un `ILIKE '%terme%'` via un index GIN — sans ça, une
-- recherche par nom de serveur ou pseudo dégénère en Seq Scan dès que
-- `guilds`/`users` grossit (même discipline que les index GIN de 001 sur
-- `listings.tags`/`search_tsv`, cf. `listPublic.explain.dbtest.js`).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX idx_guilds_name_trgm ON guilds USING GIN (name gin_trgm_ops);
CREATE INDEX idx_users_username_trgm ON users USING GIN (username gin_trgm_ops);

-- Neither FK is auto-indexed by Postgres. Without these, the guild-name/
-- username search branches below find their (few) matching guilds/users
-- via the trigram indexes above, then Seq Scan all of `listings` to join
-- back to them — see `search.explain.dbtest.js`.
CREATE INDEX idx_listings_guild_id ON listings (guild_id);
CREATE INDEX idx_listings_user_id ON listings (user_id);
