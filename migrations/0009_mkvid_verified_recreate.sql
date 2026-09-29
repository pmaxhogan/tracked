-- Verified-only renders, the 7-day ID wait, and delete-and-recreate
-- (lib/mkvid-readiness.ts, lib/mkvid-recreate.ts).

-- Unidentified rows in the stored list (wire rows with isId = true), so the
-- claim can hold a list that still has IDs until the set is 7 days old
-- without parsing the JSON. NULL = not counted yet (treated as "count it").
ALTER TABLE mkvid_request_tracks ADD COLUMN id_rows INTEGER;
UPDATE mkvid_request_tracks
   SET id_rows = (SELECT COUNT(*) FROM json_each(mkvid_request_tracks.tracks) WHERE json_extract(value, '$.isId') = 1)
 WHERE json_valid(tracks);

-- track_count / ided_count used to leave anonymous "ID - ID" rows out of both
-- (the parser only returns them in `rows`). From now on they count every page
-- row, and ided_count is the rows that are identified. Backfilled from the
-- stored list where there is one.
UPDATE mkvid_requests
   SET track_count = (SELECT t.track_count FROM mkvid_request_tracks t WHERE t.request_id = mkvid_requests.id),
       ided_count = (SELECT t.track_count - t.id_rows FROM mkvid_request_tracks t WHERE t.request_id = mkvid_requests.id)
 WHERE EXISTS (SELECT 1 FROM mkvid_request_tracks t WHERE t.request_id = mkvid_requests.id AND t.id_rows IS NOT NULL);

-- The panel's "Render now": this request skips the 7-day wait for IDs (it
-- still needs a verified list).
ALTER TABLE mkvid_requests ADD COLUMN skip_id_wait INTEGER NOT NULL DEFAULT 0;
-- The visual style mkvid reports the current video was made with
-- ('static' | 'waves' | 'scene'). NULL = unknown = an old-style video.
ALTER TABLE mkvid_requests ADD COLUMN style TEXT;
-- Set while a "Delete and recreate" is under way: the video being replaced.
-- It stays on YouTube and in the playlists until the new one is delivered.
ALTER TABLE mkvid_requests ADD COLUMN replaces_video_id TEXT;

-- Old mkvid videos a recreation replaced: out of the playlists, waiting for
-- mkvid to delete them from YouTube (POST <MKVID_URL>/api/videos/<id>/delete).
-- A failed delete is retried by the cron with a backoff and shown on the panel.
CREATE TABLE IF NOT EXISTS mkvid_old_videos (
  video_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  set_url TEXT NOT NULL,
  style TEXT,                          -- the style the old video was made with (NULL = unknown)
  replaced_by TEXT NOT NULL,           -- the new video id
  state TEXT NOT NULL,                 -- pending | deleted | refused (mkvid would not delete it: not its upload)
  attempts INTEGER NOT NULL DEFAULT 0,
  next_try_at INTEGER NOT NULL,        -- unix seconds
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS mkvid_old_videos_due ON mkvid_old_videos (state, next_try_at);
