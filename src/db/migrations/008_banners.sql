-- Discord CDN banners (A35 follow-up) — same idempotent-hash pattern as
-- `icon_hash`/`avatar_hash` (006/pre-existing), just for the banner asset.
-- `guilds.splash_hash` is a second, more commonly-set banner-shaped asset
-- (the invite-page background) used as a fallback when `banner_hash` is
-- absent — Discord's `BANNER` guild feature requires a boost level most
-- small servers never reach, `splash` does not.
ALTER TABLE users ADD COLUMN banner_hash TEXT;
ALTER TABLE guilds ADD COLUMN banner_hash TEXT;
ALTER TABLE guilds ADD COLUMN splash_hash TEXT;
