-- Pre-saved tracks are liked on the owner's YouTube account once they have a
-- video (lib/presave-like.ts): found on 1001tracklists, at once or by a later
-- check, or uploaded by mkvid. A like is what puts it in YouTube Music's
-- "Liked songs".
--
-- liked_at         unix ms the like was made (or seen already made)
-- like_attempts    tries so far (a try is claimed before YouTube is asked)
-- like_error       why the last try did not like it: '<kind>: <detail>', kind =
--                  quota | budget | rate_limit | transient | not_connected | gone
--                  (tried again at like_next_at), rating_disabled |
--                  purchase_required | email_not_verified | forbidden | rejected |
--                  disliked (not tried again)
-- like_next_at     unix ms the like is due; NULL = never asked for, liked, or stopped
-- like_claimed_at  unix ms a run took the try (released when it ends; stale after 10 min)
ALTER TABLE presaves ADD COLUMN liked_at INTEGER;
ALTER TABLE presaves ADD COLUMN like_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE presaves ADD COLUMN like_error TEXT;
ALTER TABLE presaves ADD COLUMN like_next_at INTEGER;
ALTER TABLE presaves ADD COLUMN like_claimed_at INTEGER;
CREATE INDEX IF NOT EXISTS presaves_like_due ON presaves (like_next_at) WHERE like_next_at IS NOT NULL;
