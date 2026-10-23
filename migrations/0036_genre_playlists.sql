-- Genre playlists (lib/genre-playlists.ts): one YouTube playlist per genre
-- (set_genres.genre_key, migration 0033), holding the videos of the followed
-- DJs' sets of that genre, in set-date order.

-- One row per genre the owner touched or that has a playlist. A genre with no
-- row follows the automatic rule (genres.minSets in the app settings).
CREATE TABLE IF NOT EXISTS genre_playlists (
  genre_key TEXT PRIMARY KEY,
  genre_name TEXT NOT NULL,
  enabled INTEGER,                       -- NULL = automatic, 1 = on, 0 = off (the owner's choice)
  playlist_id TEXT,
  created_at INTEGER,                    -- unix seconds the playlist was created or found
  last_run_at INTEGER,
  last_stats TEXT,                       -- JSON: the last run's counts and why it stopped
  updated_at INTEGER NOT NULL
);

-- What tracked put into (or could not put into) each genre playlist.
--   state  in          inserted, or found there
--          failed      an insert failed; tried again (attempts) until MAX_ATTEMPTS
--          unavailable the video cannot be inserted (deleted, private): never tried again
--          removed     it was in, and is gone from the playlist: the owner took it out, never put back
CREATE TABLE IF NOT EXISTS genre_playlist_items (
  genre_key TEXT NOT NULL,
  video_id TEXT NOT NULL,
  set_url TEXT,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (genre_key, video_id)
);
