-- Pre-save matches (lib/presave-match.ts): a pre-saved track with no YouTube
-- link on 1001tracklists is searched for elsewhere by mkvid - YouTube Music
-- (innertube search, no API quota) and, once enabled, Soulseek (slskd) - and
-- each candidate is compared by audio with the track's official previews
-- (Apple, Deezer, Spotify, Beatport, SoundCloud). tracked decides: auto
-- approve, auto reject (never analysed again), or the owner's approval queue
-- (/ui/presave-matches). Times are unix MS (like presaves).

-- One row per presave and search kind: when it was searched, when it is due again.
-- status: claimed (mkvid is on it) | done | failed (retried at next_at)
CREATE TABLE IF NOT EXISTS presave_match_searches (
  presave_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                -- ytm | slsk
  status TEXT NOT NULL,
  searches INTEGER NOT NULL DEFAULT 0, -- completed searches
  attempts INTEGER NOT NULL DEFAULT 0, -- consecutive failures
  claimed_at INTEGER,
  next_at INTEGER,                   -- due again (NULL = never: maxSearches reached)
  last_error TEXT,
  last_at INTEGER,                   -- last complete or fail
  candidates_seen INTEGER NOT NULL DEFAULT 0,
  refs TEXT,                         -- JSON [{ kind, url, ok, clipKey, durationSeconds, error }] of the last search
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (presave_id, kind)
);
CREATE INDEX IF NOT EXISTS presave_match_searches_due ON presave_match_searches (kind, next_at);

-- One row per candidate ever posted for a presave; the unique key is what
-- keeps a rejected candidate from ever being analysed again (every claim
-- sends the known external ids, mkvid skips them).
-- decision: review | approved | rejected | auto_approved | auto_rejected | superseded
-- outcome:  found (the presave's video) | rip_queued (track_uploads) | rip_not_queued
CREATE TABLE IF NOT EXISTS presave_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  presave_id INTEGER NOT NULL,
  source TEXT NOT NULL,              -- ytm | slsk | spotify
  external_id TEXT NOT NULL,         -- video id | soulseek user + path key | spotify track id
  url TEXT,
  title TEXT,
  artist TEXT,
  album TEXT,
  channel_title TEXT,
  video_type TEXT,                   -- innertube MUSIC_VIDEO_TYPE_* (ATV = Topic art track)
  is_topic INTEGER,                  -- 1/0, null = unknown
  comments_off INTEGER,              -- 1/0, null = unknown (videos.list statistics.commentCount absent = off)
  duration_seconds REAL,
  name_score REAL,
  audio_score REAL,                  -- best over the references, null = none could be scored
  scores TEXT,                       -- JSON [{ ref, score, ber, offsetSeconds, overlapSeconds }]
  extra TEXT,                        -- JSON: soulseek { username, filename, size, bitRate, bitDepth, sampleRate, length }
  clip_key TEXT,                     -- R2 IMAGES presave-clips/<key> (non-YouTube candidates)
  decision TEXT NOT NULL,
  decided_by TEXT,                   -- auto | owner
  reason TEXT,                       -- why decideMatch chose it (one line)
  outcome TEXT,
  track_upload_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS presave_matches_key ON presave_matches (presave_id, source, external_id);
CREATE INDEX IF NOT EXISTS presave_matches_decision ON presave_matches (decision, created_at);

-- The candidate a track upload rips (an approved match), null for 1001tl-link rips.
ALTER TABLE track_uploads ADD COLUMN match_id INTEGER;
