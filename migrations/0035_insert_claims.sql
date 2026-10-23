-- Short-lived claims (lib/insert-claims.ts): whoever writes the row first does
-- the work, everybody else for the next few minutes leaves it alone. Taken
-- before a playlistItems.insert (key `pl <playlistId> <videoId>`), so two runs
-- that both read a snapshot without the video do not both insert it (the
-- duplicates of 2026-10), and for one mkvid completion at a time
-- (`mkvid.complete <requestId>`). A claim older than its window is free again;
-- rows are only ever this small and are pruned with the audit.
CREATE TABLE IF NOT EXISTS insert_claims (
  k TEXT PRIMARY KEY,
  at INTEGER NOT NULL           -- unix seconds the claim was taken
);
CREATE INDEX IF NOT EXISTS insert_claims_at ON insert_claims (at);
