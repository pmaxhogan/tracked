-- The track list mkvid draws per-track titles and artwork from, one row per
-- request, kept apart from mkvid_requests so the panel's `SELECT *` listings
-- do not drag ~20 KB of JSON per row along. Written by the sync when it
-- queues (or re-checks) a set; read once per claim (lib/mkvid.ts).
--
-- `tracks` is the wire format /mkvid/claim sends: a JSON array of
-- { cueSeconds, artist, title, artworkUrl, isId, layered }, every page row in
-- order, anonymous "ID - ID" rows included (isId, no names or art), so
-- `track_count` here can exceed mkvid_requests.track_count, which leaves them out;
-- `layered` = a "w/" row played on top of the row before it, whose cueSeconds
-- is only a cue of its own (null when it has none). `trusted` = 1 only when the
-- page it came from passed the decoy check with evidence (>= 3 rows compared,
-- none contradicting itself); an untrusted list is stored with artist/title
-- nulled, because since ~2026-09-22 1001tracklists serves our accounts pages
-- with real cues and artwork but randomized names. `named` / `mismatched` are
-- the detector's counts, kept for auditing the decision.
CREATE TABLE IF NOT EXISTS mkvid_request_tracks (
  request_id TEXT PRIMARY KEY REFERENCES mkvid_requests(id),
  tracks TEXT NOT NULL,
  track_count INTEGER NOT NULL,
  trusted INTEGER NOT NULL DEFAULT 0,
  named INTEGER NOT NULL DEFAULT 0,
  mismatched INTEGER NOT NULL DEFAULT 0,
  scraped_at INTEGER NOT NULL                -- unix seconds of the page fetch the list came from
);
