-- The render feeder (lib/fetch-scheduler.ts): first fetches for sets mkvid
-- is waiting on that have no verified list and no verification started.
--
-- One row per set the feeder has fed. It is both the day's count (rows whose
-- last_attempt_at falls on the UTC day; a set is fed at most once per
-- cooldown, so one row = one feed fetch) and the per-set brake: a set is not
-- fed again before next_feed_at, whatever the outcome of its last feed fetch,
-- and a set whose feed fetch failed 3 times in a row (a 404, a 5xx) is given
-- up on (gave_up = 1). A pool refusal fetched nothing and is undone.
CREATE TABLE IF NOT EXISTS render_feed (
  url TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,     -- feed fetches run for this set
  failures INTEGER NOT NULL DEFAULT 0,     -- consecutive failed ones (reset by a successful fetch)
  last_attempt_at INTEGER,                 -- unix seconds of the last feed fetch
  next_feed_at INTEGER NOT NULL,           -- not fed again before this (2 d after a fetch, doubling after failures, 14 d at most)
  gave_up INTEGER NOT NULL DEFAULT 0,      -- 1 = failed too often: never fed again (its recheck by age still runs)
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS render_feed_attempt ON render_feed (last_attempt_at);
