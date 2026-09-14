-- Durable, queryable state that used to live as JSON blobs in the SUBS / CACHE
-- KV namespaces. Caches stay in KV (see README "Storage"); everything here is
-- either the sync's source of truth or an audit trail that gets queried.
--
-- Apply with `npm run d1:migrate` (wrangler d1 migrations apply --remote)
-- BEFORE pushing code that depends on it — Workers Builds only runs
-- `wrangler deploy`, it never applies migrations.

-- The DJ subscription list (was `subs:list` + `subs:item:<slug>`).
CREATE TABLE IF NOT EXISTS subscriptions (
  slug TEXT PRIMARY KEY,
  source_url TEXT NOT NULL,
  added_at INTEGER NOT NULL,            -- unix seconds
  position INTEGER NOT NULL             -- insertion order (the old list order)
);

-- Per-subscription sync summary (the scalar half of the old `subs:state:<slug>` blob).
CREATE TABLE IF NOT EXISTS sub_sync (
  slug TEXT PRIMARY KEY,
  playlist_id TEXT,
  artist_name TEXT,
  last_run_at INTEGER,                  -- unix seconds
  last_error TEXT,
  last_run_stats TEXT                   -- JSON, SubState.lastRunStats
);

-- One row per tracklist URL the sync has ever discovered for a DJ (the
-- per-URL half of the old blob: discovered / processed / abandoned /
-- failureCounts / tracklistVideos).
CREATE TABLE IF NOT EXISTS tracklists (
  slug TEXT NOT NULL,
  url TEXT NOT NULL,
  position INTEGER NOT NULL,            -- discovery order within the sub; the todo + recheck windows follow it
  discovered_at INTEGER NOT NULL,       -- unix seconds
  processed INTEGER NOT NULL DEFAULT 0, -- 1 once the set page has been resolved (video or no video)
  abandoned INTEGER NOT NULL DEFAULT 0, -- 1 after ABANDON_AFTER_FAILURES consecutive failures
  failure_count INTEGER NOT NULL DEFAULT 0,
  video_known INTEGER NOT NULL DEFAULT 0, -- 1 = baseline recorded (video_id NULL then means "the page had none")
  video_id TEXT,
  video_source TEXT,                    -- '1001tl' (embedded on the set page) | 'mkvid' (rendered + uploaded by mkvid)
  checked_at INTEGER,                   -- unix seconds of the last set-page fetch; 0 = due now; NULL = never recorded
  PRIMARY KEY (slug, url)
);
CREATE INDEX IF NOT EXISTS tracklists_pending ON tracklists (slug, processed, abandoned);
CREATE INDEX IF NOT EXISTS tracklists_recheck ON tracklists (slug, checked_at);
CREATE INDEX IF NOT EXISTS tracklists_video ON tracklists (video_id);

-- /now-playing audit trail (was `np:<invertedTs>:<reqId>` in CACHE, 90-day TTL).
CREATE TABLE IF NOT EXISTS now_playing_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  t TEXT NOT NULL,                      -- ISO timestamp
  ts INTEGER NOT NULL,                  -- epoch ms, for ordering + retention
  req_id TEXT,
  status TEXT NOT NULL,
  legacy_key TEXT UNIQUE,               -- the KV key a row was imported from (makes the import idempotent)
  summary TEXT NOT NULL,                -- JSON: the compact list-view fields
  record TEXT NOT NULL                  -- JSON: the full record
);
CREATE INDEX IF NOT EXISTS now_playing_audit_ts ON now_playing_audit (ts, id);

-- Playlist-addition audit trail (was `pladd:<invertedTs>:<slug>:<i>` in CACHE, 90-day TTL).
CREATE TABLE IF NOT EXISTS playlist_additions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  t TEXT NOT NULL,
  ts INTEGER NOT NULL,
  status TEXT NOT NULL,
  slug TEXT NOT NULL,
  set_url TEXT NOT NULL,
  video_id TEXT,
  legacy_key TEXT UNIQUE,
  summary TEXT NOT NULL,
  record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS playlist_additions_ts ON playlist_additions (ts, id);
CREATE INDEX IF NOT EXISTS playlist_additions_slug_set ON playlist_additions (slug, set_url, ts);
