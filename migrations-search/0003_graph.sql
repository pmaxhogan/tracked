-- The Graph tab (docs/superpowers/specs/2026-10-14-graph-tab-design.md):
-- sources, set heading artists, track credits and remix / rework bases, all
-- parsed from verified set pages (src/lib/tracklist-credits.ts, written by
-- src/lib/graph/store.ts). Like the rest of this database, rebuildable.
--
-- Tracks here are keyed by the 1001tracklists track PAGE id (/track/<id>/),
-- not the medialink id in search_tracks.track_id; search_tracks.page_id links
-- the two. Artists are keyed by a slug of their display name.

-- The page id of an indexed track, from its track_url
-- ('https://www.1001tracklists.com/track/' is 37 characters).
ALTER TABLE search_tracks ADD COLUMN page_id TEXT;
UPDATE search_tracks
   SET page_id = substr(track_url, 38, instr(substr(track_url, 38), '/') - 1)
 WHERE track_url LIKE 'https://www.1001tracklists.com/track/%/%';
CREATE INDEX search_tracks_page_id ON search_tracks(page_id) WHERE page_id IS NOT NULL;

CREATE TABLE search_artists (
  key TEXT PRIMARY KEY,                     -- nameSlug(display name)
  name TEXT NOT NULL,
  tl_path TEXT,                             -- a 1001tl artist page path, when a credit linked one
  dj_slug TEXT,                             -- the 1001tl DJ page slug, when a set heading linked one
  updated_at INTEGER NOT NULL
);
CREATE INDEX search_artists_dj ON search_artists(dj_slug) WHERE dj_slug IS NOT NULL;

-- Every track seen in credits, bases included (a base that was never played is only here).
CREATE TABLE search_graph_tracks (
  page_id TEXT PRIMARY KEY,
  artist TEXT,
  title TEXT,
  tl_path TEXT,
  label TEXT,
  label_path TEXT,
  genre TEXT,
  duration_s INTEGER,
  version TEXT,                             -- 'Remix', 'Edit', ... from span.remixValue
  updated_at INTEGER NOT NULL
);

CREATE TABLE search_track_artists (
  page_id TEXT NOT NULL,
  artist_key TEXT NOT NULL,
  role TEXT NOT NULL,                       -- main | featured | remixer
  pos INTEGER NOT NULL,
  PRIMARY KEY (page_id, artist_key, role)
);
CREATE INDEX search_track_artists_artist ON search_track_artists(artist_key);

CREATE TABLE search_track_bases (
  page_id TEXT NOT NULL,                    -- the remix / rework
  base_id TEXT NOT NULL,                    -- the track it was made from
  kind TEXT NOT NULL,                       -- remix | rework
  PRIMARY KEY (page_id, base_id)
);
CREATE INDEX search_track_bases_base ON search_track_bases(base_id);

CREATE TABLE search_sources (
  id TEXT PRIMARY KEY,                      -- /source/<id>/<slug>/
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE search_set_sources (
  set_url TEXT NOT NULL,
  source_id TEXT NOT NULL,
  pos INTEGER NOT NULL,
  PRIMARY KEY (set_url, source_id)
);
CREATE INDEX search_set_sources_source ON search_set_sources(source_id);

CREATE TABLE search_set_artists (
  set_url TEXT NOT NULL,
  artist_key TEXT NOT NULL,
  pos INTEGER NOT NULL,
  PRIMARY KEY (set_url, artist_key)
);
CREATE INDEX search_set_artists_artist ON search_set_artists(artist_key);

-- Sets whose page was read for the graph, and from where (fetch | pages).
CREATE TABLE search_graph_sets (
  set_url TEXT PRIMARY KEY,
  format INTEGER NOT NULL,
  parsed_at INTEGER NOT NULL,
  origin TEXT NOT NULL
);
