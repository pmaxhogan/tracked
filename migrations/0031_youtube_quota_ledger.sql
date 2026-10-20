-- YouTube quota pool (lib/youtube-pool.ts): the units tracked itself spent per
-- quota day, project and consumer (the part of the code that made the call), so
-- the pool can pick the Google project with the most left and the Scheduler
-- page can show where the quota goes.
--   day    quotaDayStart() of the Pacific quota day, unix seconds
--   units  quota units charged (lib/youtube-pool.ts unitCost)
--   calls  API calls made
CREATE TABLE youtube_quota_ledger (
  day INTEGER NOT NULL,
  project TEXT NOT NULL,
  consumer TEXT NOT NULL,
  units INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, project, consumer)
);
