-- Queue of sets that have no YouTube recording on 1001tracklists but do have a
-- full SoundCloud / hearthis.at recording: mkvid (the NAS service) polls this,
-- renders the audio to a waveform video, uploads it unlisted and reports the
-- video id back, which the Worker then adds to the artist + combined playlists.
CREATE TABLE IF NOT EXISTS mkvid_requests (
  id TEXT PRIMARY KEY,                       -- uuid
  slug TEXT NOT NULL,
  set_url TEXT NOT NULL UNIQUE,              -- one request per set, ever (retry = reset in place)
  artist_name TEXT,
  set_title TEXT,                            -- the 1001tl page title, used as the video title
  source TEXT NOT NULL,                      -- 'soundcloud' | 'hearthis'
  source_url TEXT NOT NULL,                  -- what mkvid hands to yt-dlp
  last_cue_seconds INTEGER,                  -- last cue on the tracklist: a recording shorter than this is not the full set
  track_count INTEGER,
  ided_count INTEGER,                        -- tracks that are not fully-anonymous "ID"s
  status TEXT NOT NULL,                      -- pending | claimed | done | failed | superseded
  attempts INTEGER NOT NULL DEFAULT 0,       -- claims so far
  not_before INTEGER,                        -- unix seconds; a failed attempt waits this long before it can be claimed again
  claimed_at INTEGER,
  job_id TEXT,                               -- mkvid's job id for the current/last attempt
  video_id TEXT,
  video_url TEXT,
  privacy TEXT,                              -- privacy YouTube actually applied (an unverified OAuth app can force private)
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mkvid_requests_status ON mkvid_requests (status, created_at);
CREATE INDEX IF NOT EXISTS mkvid_requests_slug ON mkvid_requests (slug, set_url);
