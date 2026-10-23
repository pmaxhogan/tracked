-- Set and track page metadata (lib/set-meta.ts): everything a 1001tracklists
-- set page or track page says that the app did not keep before. The parts the
-- app queries are columns (a set's genres, in set_genres); the rest is a JSON
-- document whose shape can grow without a migration (`format` says which
-- parser wrote it).

-- One row per set page URL, written on every fetch of the page and by the
-- stored-pages backfill (R2).
CREATE TABLE IF NOT EXISTS set_meta (
  set_url TEXT PRIMARY KEY,
  tl_id TEXT,
  genres TEXT NOT NULL DEFAULT '[]',     -- JSON array of genre names, the page's order
  meta TEXT NOT NULL,                    -- JSON: SetMetaDoc
  format INTEGER NOT NULL,
  source TEXT NOT NULL,                  -- 'sync' | 'page' | 'pages' (R2 backfill)
  fetched_at INTEGER NOT NULL,           -- unix seconds of the fetch the page came from
  updated_at INTEGER NOT NULL
);

-- Set x genre. genre_key is 1001tracklists' own genre slug (/genre/<key>/).
CREATE TABLE IF NOT EXISTS set_genres (
  set_url TEXT NOT NULL,
  genre_key TEXT NOT NULL,
  genre_name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL,
  PRIMARY KEY (set_url, genre_key)
);
CREATE INDEX IF NOT EXISTS set_genres_genre ON set_genres (genre_key, set_url);

-- One row per track page id (/track/<id>/), written on every fetch of the page.
CREATE TABLE IF NOT EXISTS track_meta (
  track_page_id TEXT PRIMARY KEY,
  track_url TEXT NOT NULL,
  genre TEXT,
  meta TEXT NOT NULL,                    -- JSON: TrackMetaDoc
  format INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL
);
