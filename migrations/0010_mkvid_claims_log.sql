-- mkvid daily caps from an append-only claims log (W7 review, blocker 1).
--
-- The day's usage used to be counted from mkvid_requests' current state
-- (claimed/done rows claimed since midnight Pacific). "Delete and recreate"
-- resets a done row to pending, so every recreated upload of the day gave its
-- slot back and the cap could be exceeded. From now on every claim appends a
-- row here; recreation never touches this table. A claim mkvid gives back
-- through /mkvid/fail (refused before or during the render, so nothing was
-- uploaded) is marked `refunded_at` and stops counting, as before.
CREATE TABLE IF NOT EXISTS mkvid_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  account TEXT NOT NULL,               -- primary | shared
  claimed_at INTEGER NOT NULL,         -- unix seconds
  recreate INTEGER NOT NULL DEFAULT 0, -- 1 = the claim of a delete-and-recreate
  refunded_at INTEGER                  -- set once, when mkvid reports the claim failed
);
CREATE INDEX IF NOT EXISTS mkvid_claims_day ON mkvid_claims (account, claimed_at);
CREATE INDEX IF NOT EXISTS mkvid_claims_request ON mkvid_claims (request_id);

-- Seed the log with the claims the old count saw, so a deploy in the middle
-- of a quota day does not hand out today's slots a second time.
INSERT INTO mkvid_claims (request_id, account, claimed_at, recreate)
SELECT id, COALESCE(account, 'primary'), claimed_at, CASE WHEN replaces_video_id IS NULL THEN 0 ELSE 1 END
  FROM mkvid_requests
 WHERE status IN ('claimed', 'done') AND claimed_at IS NOT NULL AND claimed_at >= CAST(strftime('%s', 'now') AS INTEGER) - 2 * 86400;

-- Failures whose reason tracked does not know (a newer mkvid) go back to
-- pending with a backoff, without using an attempt, the first 3 times.
ALTER TABLE mkvid_requests ADD COLUMN unknown_failures INTEGER NOT NULL DEFAULT 0;

-- A recreation's old video is recorded from the moment Recreate is pressed
-- (mkvid_old_videos.state = 'awaiting_replacement', replaced_by = ''), so its
-- id survives every path; it becomes 'pending' (delete it) once the new video
-- is in, or once the set is superseded by an official recording.
INSERT OR IGNORE INTO mkvid_old_videos (video_id, request_id, slug, set_url, style, replaced_by, state, attempts, next_try_at, created_at, updated_at)
SELECT replaces_video_id, id, slug, set_url, style, '', 'awaiting_replacement', 0, 0,
       CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)
  FROM mkvid_requests
 WHERE replaces_video_id IS NOT NULL;
