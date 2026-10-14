-- Per-track link lookups waiting to be done ahead of a phone tap
-- (lib/link-prewarm.ts): a set page the sync parses queues its identified
-- tracks' medialink ids, and the 5-minute cron looks a few of them up at pool
-- priority backfill, so a What's playing tap finds every track's links in the
-- ml:v1:<id> cache. One row per track id: a track on several sets is queued once.
--
-- set_url      the set that queued it first (for the log only)
-- queued_at    unix s it was queued
-- attempts     lookups that failed (not counting a pool refusal, which charges nothing)
-- next_at      unix s it is due; a running drain pushes it out while it holds the row
-- last_error   why the last lookup failed
CREATE TABLE IF NOT EXISTS link_prewarm (
  track_id   TEXT PRIMARY KEY,
  set_url    TEXT,
  queued_at  INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  next_at    INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS link_prewarm_due ON link_prewarm (next_at, queued_at);
