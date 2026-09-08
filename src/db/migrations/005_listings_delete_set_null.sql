-- `listings.remove()` (domain/listings.js) always hard-deletes when it can, but
-- three FKs (ON DELETE RESTRICT) blocked it for any listing that ever appeared
-- in a match or a queue — falling back to a soft `removed` row kept alive
-- forever just to satisfy the constraint. Requested by the client: no need to
-- keep the listing row itself around for that — the actual history worth
-- keeping (who created/removed what, and its full content at the time) is
-- already captured independently in `audit_log.before`/`after` on the
-- `listing.created` / `listing.removed`(`_soft_fallback`) entries, which
-- outlive the row and stay queryable by a future admin panel regardless.
-- SET NULL instead of RESTRICT: match_participants / listing_queue rows (and
-- the match/queue history they represent) are kept exactly as they were —
-- only the now-meaningless pointer to a deleted listing is cleared.
ALTER TABLE match_participants
  ALTER COLUMN listing_id DROP NOT NULL,
  DROP CONSTRAINT match_participants_listing_id_fkey,
  ADD CONSTRAINT match_participants_listing_id_fkey
    FOREIGN KEY (listing_id) REFERENCES listings (id) ON DELETE SET NULL;

ALTER TABLE match_participants
  DROP CONSTRAINT match_participants_gives_to_listing_id_fkey,
  ADD CONSTRAINT match_participants_gives_to_listing_id_fkey
    FOREIGN KEY (gives_to_listing_id) REFERENCES listings (id) ON DELETE SET NULL;

ALTER TABLE listing_queue
  ALTER COLUMN listing_id DROP NOT NULL,
  DROP CONSTRAINT listing_queue_listing_id_fkey,
  ADD CONSTRAINT listing_queue_listing_id_fkey
    FOREIGN KEY (listing_id) REFERENCES listings (id) ON DELETE SET NULL;
