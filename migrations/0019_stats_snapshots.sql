-- Stats page (lib/stats.ts): an hourly snapshot of the headline numbers, so
-- the page can draw them over time (most of them, e.g. sets with a video or
-- searchable sets, have no history of their own). Written by the 5-minute
-- cron at most once an hour; kept 400 days.
CREATE TABLE IF NOT EXISTS stats_snapshots (
  at INTEGER PRIMARY KEY,  -- unix s, the start of the hour
  data TEXT NOT NULL       -- JSON { <metric>: number }
);
