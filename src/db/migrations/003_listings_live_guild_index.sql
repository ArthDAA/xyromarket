-- Étend la garantie "une guilde ne porte jamais deux annonces vivantes
-- simultanément" à `pending_bot` : une annonce en attente d'invitation du
-- bot compte comme vivante, sinon rien n'empêcherait d'en publier une
-- deuxième sur la même guilde pendant l'attente. Renommé pour refléter
-- que ce n'est plus seulement `active`.
DROP INDEX uniq_listings_active_guild;
CREATE UNIQUE INDEX uniq_listings_live_guild ON listings (guild_id) WHERE status IN ('active', 'pending_bot');
