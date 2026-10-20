-- The sets a track's 1001tracklists page lists (lib/track-sets.ts), and the
-- crawl that reads them. A track page shows the 15 newest sets that played
-- the track and loads older ones through the same /ajax/get_data.php scroll
-- the DJ pages use (type=track). The crawl walks each track of the followed
-- DJs' sets (the search index's tracks) back to the stop year, a few page
-- views a cron tick at pool priority backfill; the Recommended sets page
-- ranks the sets it saw by how many of those tracks list them.
--
-- Tracks are keyed by the track PAGE id (/track/<id>/), never the medialink
-- id; sets by their tracklist id (/tracklist/<id>/).

-- One row per (track, set) the track's page listed.
CREATE TABLE IF NOT EXISTS track_sets (
  track_page_id TEXT NOT NULL,
  set_id        TEXT NOT NULL,
  seen_at       INTEGER NOT NULL,          -- unix s it was first seen there
  PRIMARY KEY (track_page_id, set_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS track_sets_set ON track_sets (set_id);

-- One row per set any track page listed: what the row showed, and how many
-- crawled tracks list it.
--   followed     1 = a followed DJ's set: in `tracklists` (by id), or the DJ
--                part of its title names a followed DJ. Set when the row is
--                written and refreshed once a day; the page leaves these out.
CREATE TABLE IF NOT EXISTS track_set_lists (
  set_id        TEXT PRIMARY KEY,
  set_url       TEXT NOT NULL,
  title         TEXT NOT NULL,
  set_date      TEXT,                      -- YYYY-MM-DD as the row showed it
  creator       TEXT,                      -- the 1001tracklists user who made the list
  track_count   INTEGER NOT NULL DEFAULT 0,
  followed      INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL,          -- unix s
  updated_at    INTEGER NOT NULL           -- unix s
);
CREATE INDEX IF NOT EXISTS track_set_lists_rank ON track_set_lists (followed, track_count);

-- The crawl queue: one row per track page.
--   weight        followed sets the track is in (from the search index): more first
--   next_at       unix s it is due; a running drain pushes it out while it holds the row
--   cursor_pos/id where an unfinished walk goes on (null: from page 1)
--   walks         walks finished; a later walk (a recrawl) stops at a set it already has
--   steps         scroll steps of the current walk
CREATE TABLE IF NOT EXISTS track_set_crawl (
  track_page_id TEXT PRIMARY KEY,
  track_url     TEXT NOT NULL,
  weight        INTEGER NOT NULL DEFAULT 0,
  queued_at     INTEGER NOT NULL,
  next_at       INTEGER NOT NULL DEFAULT 0,
  cursor_pos    INTEGER,
  cursor_id     TEXT,
  steps         INTEGER NOT NULL DEFAULT 0,
  walks         INTEGER NOT NULL DEFAULT 0,
  sets_seen     INTEGER NOT NULL DEFAULT 0, -- distinct sets stored for the track
  oldest_date   TEXT,                       -- oldest set date the walks reached
  stop_reason   TEXT,                       -- why the last walk ended
  attempts      INTEGER NOT NULL DEFAULT 0, -- failed steps in a row
  last_error    TEXT,
  crawled_at    INTEGER                     -- unix s the last walk ended
);
CREATE INDEX IF NOT EXISTS track_set_crawl_new ON track_set_crawl (walks, weight);
CREATE INDEX IF NOT EXISTS track_set_crawl_due ON track_set_crawl (next_at);
CREATE INDEX IF NOT EXISTS track_set_crawl_mid ON track_set_crawl (cursor_id) WHERE cursor_id IS NOT NULL;

-- A followed set by its tracklist id ('https://www.1001tracklists.com/tracklist/'
-- is 41 characters): set ids survive the renames that change a set's URL.
CREATE INDEX IF NOT EXISTS tracklists_set_id
  ON tracklists (substr(url, 42, instr(substr(url, 42), '/') - 1));
