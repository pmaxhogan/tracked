-- Pre-saved tracks (lib/presave.ts): a track 1001tracklists has identified (or
-- not yet) that has no YouTube link, watched until one turns up.
--
-- Identity is what was known when it was saved:
--   * track_id   — 1001tracklists' numeric medialink id. Rechecked with the
--                  medialink AJAX (one pool view). Unique while set.
--   * set_url + row_index (+ cue_seconds, prev/next track ids as anchors) —
--                  a row of a set that has no id yet (anonymous "ID - ID", or
--                  "Artist - ID"). Rechecked by re-reading the set page; once
--                  the row is identified the presave takes its track_id and
--                  moves on to the links stage.
--
-- stage: identify (no track id yet) → links (waiting for a YouTube link) →
--        found (1001tracklists has a YouTube link) | uploaded (mkvid ripped and
--        uploaded it, track_uploads) ; dismissed (the owner stopped watching).
CREATE TABLE IF NOT EXISTS presaves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id TEXT,                     -- numeric 1001tl medialink id
  track_url TEXT,                    -- https://www.1001tracklists.com/track/<id>/<slug>/index.html
  set_url TEXT,                      -- the set it was saved from (context; identity for identify-stage rows)
  row_index INTEGER,                 -- 0-based page row (anonymous rows included) in set_url
  cue_seconds INTEGER,               -- the row's cue, the primary anchor when rows shift
  prev_track_id TEXT,                -- anchors: the identified neighbours when it was saved
  next_track_id TEXT,
  artist TEXT,
  title TEXT,
  artwork_url TEXT,
  label TEXT,
  dj_slug TEXT,                      -- the set's DJ, when known
  stage TEXT NOT NULL DEFAULT 'links',
  links TEXT,                        -- JSON [{ source, name, url, playerId, duration }] from the last good lookup
  link_sources TEXT,                 -- ',spotify,apple,' — the link names, for filtering
  link_count INTEGER NOT NULL DEFAULT 0,
  duration_seconds INTEGER,          -- from the medialink entries (max of the reported durations)
  youtube_video_id TEXT,             -- the video, found on 1001tl or uploaded by mkvid
  source TEXT NOT NULL DEFAULT 'ui', -- ui | tasker | api
  created_at INTEGER NOT NULL,       -- unix ms
  updated_at INTEGER NOT NULL,
  last_checked_at INTEGER,
  next_check_at INTEGER,             -- due for the scheduled recheck (null = never: found / uploaded / dismissed)
  check_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0, -- consecutive failed checks (pool refused, parse error)
  last_result TEXT,                  -- the last check's result code (presave_checks.result)
  last_error TEXT,
  identified_at INTEGER,
  found_at INTEGER,
  notified_at INTEGER,
  dismissed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS presaves_track ON presaves (track_id) WHERE track_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS presaves_row ON presaves (set_url, row_index) WHERE track_id IS NULL;
CREATE INDEX IF NOT EXISTS presaves_due ON presaves (next_check_at) WHERE next_check_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS presaves_stage ON presaves (stage, created_at);
CREATE INDEX IF NOT EXISTS presaves_set ON presaves (set_url);

-- Every check of a presave, newest last: what triggered it and what it found.
-- result: found | no_youtube | identified | still_id | row_missing | uploaded |
--         pool_refused | error | added
CREATE TABLE IF NOT EXISTS presave_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  presave_id INTEGER NOT NULL,
  at INTEGER NOT NULL,               -- unix ms
  trigger TEXT NOT NULL,             -- scheduled | manual | add | set_fetch | upload
  result TEXT NOT NULL,
  stage_before TEXT,
  stage_after TEXT,
  link_count INTEGER,
  link_sources TEXT,
  youtube_video_id TEXT,
  error TEXT,
  ms INTEGER,
  detail TEXT                        -- JSON, free-form
);
CREATE INDEX IF NOT EXISTS presave_checks_presave ON presave_checks (presave_id, at);
CREATE INDEX IF NOT EXISTS presave_checks_at ON presave_checks (at);
