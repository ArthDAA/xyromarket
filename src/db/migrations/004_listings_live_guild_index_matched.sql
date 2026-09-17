-- A21 : une annonce `matched` (guilde déjà réclamée par une proposition, acceptée
-- ou non) est tout aussi "vivante" qu'une annonce `active`/`pending_bot` — sans ça,
-- une deuxième annonce peut être créée sur la même guilde pendant qu'une première
-- reste `matched`, et les deux peuvent finir par vouloir chacune une ligne
-- `transactions` ouverte pour cette guilde, ce qui viole `uniq_transactions_open_guild`
-- (contrainte au niveau guilde, qui suppose qu'une seule annonce y est jamais vivante).
DROP INDEX uniq_listings_live_guild;
CREATE UNIQUE INDEX uniq_listings_live_guild ON listings (guild_id) WHERE status IN ('active', 'pending_bot', 'matched');
