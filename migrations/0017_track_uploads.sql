-- mkvid track uploads (lib/track-uploads.ts): a presave watched for
-- trackUploads.minWatchDays with no YouTube link but a link on a site yt-dlp
-- can download is handed to mkvid, which rips it, renders it with the track
-- visualizer and uploads it; the Worker adds it to the "Track uploads"
-- playlist. Same pull model as mkvid_requests (POST /mkvid/track/*).
--
-- status: pending → claimed → done | failed ; banned (the owner banned its
-- source URL) ; superseded (1001tracklists got a YouTube link meanwhile, or
-- the presave was dismissed).
CREATE TABLE IF NOT EXISTS track_uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  presave_id INTEGER NOT NULL,
  track_id TEXT,
  artist TEXT,
  title TEXT,
  artwork_url TEXT,
  track_url TEXT,
  source_name TEXT NOT NULL,         -- soundcloud | bandcamp | hearthis | mixcloud | …
  source_url TEXT NOT NULL,          -- handed to yt-dlp as-is
  expected_duration_seconds INTEGER, -- from the medialink entries; mkvid refuses a much shorter rip (a preview)
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before INTEGER,                -- unix s: backoff after a retryable failure
  claimed_at INTEGER,                -- unix s
  account TEXT,                      -- primary | shared (the upload project)
  job_id TEXT,
  video_id TEXT,
  privacy TEXT,
  playlist_item_id TEXT,
  playlist_status TEXT,              -- added | duplicate | failed
  error TEXT,
  created_at INTEGER NOT NULL,       -- unix s
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  notified_at INTEGER
);
CREATE INDEX IF NOT EXISTS track_uploads_status ON track_uploads (status, not_before);
CREATE INDEX IF NOT EXISTS track_uploads_presave ON track_uploads (presave_id);
-- One live request per presave.
CREATE UNIQUE INDEX IF NOT EXISTS track_uploads_live ON track_uploads (presave_id) WHERE status IN ('pending', 'claimed');

-- Source URLs the owner banned: never handed to mkvid again (any presave).
CREATE TABLE IF NOT EXISTS track_upload_bans (
  url TEXT PRIMARY KEY,
  source_name TEXT,
  reason TEXT,
  upload_id INTEGER,
  presave_id INTEGER,
  banned_at INTEGER NOT NULL         -- unix s
);
