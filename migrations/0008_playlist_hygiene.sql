-- Playlist hygiene (lib/full-recording.ts, lib/video-meta.ts, lib/playlist-hygiene.ts):
-- the full-recording rule, the paced sweep that removes non-full recordings
-- already in playlists, the 6-hourly comparison that notices videos the owner
-- removed by hand (or that died), and the "remove and replace" button.

-- YouTube Data API facts per video (videos.list part=contentDetails,player,status),
-- cached so a video is looked up once, not on every sync or sweep. The raw
-- embed dimensions are kept (not just a derived flag) so a wrong orientation
-- call can be audited from one row. alive = 0: videos.list did not return the
-- id (deleted, or private to someone else) or reported it rejected/deleted.
CREATE TABLE IF NOT EXISTS video_meta (
  video_id TEXT PRIMARY KEY,
  duration_seconds INTEGER,
  embed_width INTEGER,
  embed_height INTEGER,
  privacy TEXT,
  upload_status TEXT,
  alive INTEGER NOT NULL DEFAULT 1,
  fetched_at INTEGER NOT NULL             -- unix seconds
);

-- What a set page says about its recordings, written on every page fetch the
-- sync makes (first processing and rechecks). The sweep cannot fetch
-- 1001tracklists, so rules (a) notice, (b) last cue and (c) audio source
-- are only evaluable for a playlist video once its set page has been seen here.
CREATE TABLE IF NOT EXISTS set_media_facts (
  set_url TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  video_id TEXT,                          -- the YouTube video the page linked when fetched
  no_full_notice INTEGER NOT NULL DEFAULT 0,
  last_cue_seconds INTEGER,
  audio_max_seconds INTEGER,              -- longest SoundCloud / Mixcloud player on the page
  audio_kind TEXT,                        -- mkvid source kind ('soundcloud' | 'hearthis'), when the page has one
  audio_url TEXT,                         -- what mkvid would hand to yt-dlp
  set_title TEXT,
  set_date TEXT,
  last_cue_known INTEGER NOT NULL DEFAULT 0,
  track_count INTEGER,
  ided_count INTEGER,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS set_media_facts_video ON set_media_facts (video_id);

-- Never re-add: a video the owner removed from a managed playlist by hand, one
-- that died (deleted/private), or one taken out with "remove and replace".
-- Per playlist: removal from the combined playlist only blocks the combined one.
CREATE TABLE IF NOT EXISTS removed_videos (
  playlist_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  slug TEXT,
  set_url TEXT,
  reason TEXT NOT NULL,                   -- 'owner' | 'dead' | 'button'
  at INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, video_id)
);
CREATE INDEX IF NOT EXISTS removed_videos_video ON removed_videos (video_id);

-- Every removal the hygiene code made or would make, with the reason. The
-- /subscriptions/removed page lists these and offers undo (re-add).
-- status: would_remove (dry run) | removed | failed | undone | recorded
-- (recorded = an owner/dead removal noticed by the comparison: nothing deleted).
CREATE TABLE IF NOT EXISTS playlist_removals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  source TEXT NOT NULL,                   -- 'sweep' | 'owner' | 'dead' | 'button'
  status TEXT NOT NULL,
  slug TEXT,
  set_url TEXT,
  video_id TEXT NOT NULL,
  playlist_id TEXT NOT NULL,
  playlist_kind TEXT NOT NULL,            -- 'artist' | 'combined'
  reason TEXT NOT NULL,
  detail TEXT,
  UNIQUE (source, video_id, playlist_id)
);
CREATE INDEX IF NOT EXISTS playlist_removals_at ON playlist_removals (at, id);

-- Owner overrides from the undo button: the full-recording rule is not applied
-- to these videos again (the sweep would otherwise remove them a second time).
CREATE TABLE IF NOT EXISTS video_overrides (
  video_id TEXT PRIMARY KEY,
  allow INTEGER NOT NULL DEFAULT 1,
  at INTEGER NOT NULL
);

-- Last complete listing of each managed playlist. The combined playlist is
-- compared against this (its backfill lags by design, so "what the sync
-- added" cannot be derived for it), and the combined backfill skips ids that
-- were here but are gone now, so an owner removal is not undone before the
-- comparison sees it.
CREATE TABLE IF NOT EXISTS playlist_members (
  playlist_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, video_id)
);
