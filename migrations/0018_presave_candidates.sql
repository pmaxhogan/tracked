-- Pre-save candidates (lib/presave-candidates.ts): rows of verified set
-- pages that 1001tracklists shows a Spotify "Pre-Save N" badge for (N >= 1:
-- people pre-saved the Spotify release, so it is not out) and that have
-- neither a YouTube nor a Spotify link. Refreshed by every set fetch whose
-- list is the set's verified one; a row that gets either link, or loses its
-- badge, is deleted by the next fetch of the set it was last seen in.
--
-- key: 'track:<medialink id>' for a track, 'row:<page row id>' for an ID row
-- (its badge is keyed to the row, idTLP). A track seen in several sets is one
-- candidate (the latest fetch's count and set win).
CREATE TABLE IF NOT EXISTS presave_candidates (
  key TEXT PRIMARY KEY,
  track_id TEXT,                    -- medialink id (null for an ID row)
  track_url TEXT,
  artist TEXT,
  title TEXT,
  artwork_url TEXT,
  label TEXT,
  is_id INTEGER NOT NULL DEFAULT 0, -- 1 = an unidentified row (anonymous, or "Artist - ID")
  presave_count INTEGER NOT NULL,
  set_url TEXT NOT NULL,            -- the set it was last seen in
  row_index INTEGER,                -- 0-based page row there (anonymous rows included)
  cue_seconds INTEGER,
  dj_slug TEXT,
  first_seen_at INTEGER NOT NULL,   -- unix ms
  updated_at INTEGER NOT NULL       -- unix ms: the last fetch that saw it
);
CREATE INDEX IF NOT EXISTS presave_candidates_count ON presave_candidates (presave_count);
CREATE INDEX IF NOT EXISTS presave_candidates_set ON presave_candidates (set_url);
CREATE INDEX IF NOT EXISTS presave_candidates_track ON presave_candidates (track_id);
