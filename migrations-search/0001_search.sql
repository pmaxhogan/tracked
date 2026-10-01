-- Search index (docs/superpowers/specs/2026-09-30-tracked-ui-redesign-design.md §9),
-- in its own D1 database: FTS5 virtual tables would stop `wrangler d1 export`
-- working for the main database. Everything here is rebuildable from verified
-- lists (src/lib/search/index.ts), so this database is never exported.
-- FTS rows are keyed by the base row's integer id (rowid). Text in the FTS
-- columns is already normalized (src/lib/search/normalize.ts); display text
-- comes from the base tables.
CREATE TABLE search_sets (
  id INTEGER PRIMARY KEY,
  set_url TEXT NOT NULL UNIQUE,
  dj_slug TEXT NOT NULL,
  dj_name TEXT NOT NULL,
  title TEXT NOT NULL,
  set_date TEXT,
  video_id TEXT,
  video_source TEXT,
  track_count INTEGER NOT NULL DEFAULT 0,
  ided_count INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'page',      -- 'page' (a verified fetch) | 'mkvid' (backfill from a trusted mkvid list)
  indexed_at INTEGER NOT NULL               -- unix seconds
);
CREATE TABLE search_tracks (
  id INTEGER PRIMARY KEY,
  track_key TEXT NOT NULL UNIQUE,           -- 't:<1001tl track id>' or 'h:<hash of normalized artist + title>'
  track_id TEXT,
  track_url TEXT,
  artist TEXT NOT NULL,
  title TEXT NOT NULL,
  label TEXT,
  youtube_link TEXT,
  sets_count INTEGER NOT NULL DEFAULT 0,    -- 0 = orphaned by a re-index; never returned
  updated_at INTEGER NOT NULL
);
CREATE INDEX search_tracks_track_id ON search_tracks(track_id) WHERE track_id IS NOT NULL;
CREATE TABLE search_track_sets (
  track_key TEXT NOT NULL,
  set_url TEXT NOT NULL,
  pos INTEGER NOT NULL,
  cue_seconds INTEGER,
  layered INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (track_key, set_url)
);
CREATE INDEX search_track_sets_set ON search_track_sets(set_url);
CREATE TABLE search_vocab (
  id INTEGER PRIMARY KEY,
  term TEXT NOT NULL UNIQUE,
  df INTEGER NOT NULL DEFAULT 0             -- index writes that carried the term; approximate, orders correction candidates
);
CREATE VIRTUAL TABLE sets_fts USING fts5(title, dj, slug_words, tokenize='unicode61 remove_diacritics 2');
-- Column order is the bm25() weight order: artist 3, title 3, label 1, djs 2, set_titles 1.
CREATE VIRTUAL TABLE tracks_fts USING fts5(artist, title, label, djs, set_titles, tokenize='unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE vocab_fts USING fts5(term, tokenize='trigram');
