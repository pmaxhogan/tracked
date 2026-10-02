-- One row per scheduler tick (lib/tick-history.ts): what it drew, how much was
-- due per class before the draw cut it, what it picked and how each item went,
-- and why it skipped or stopped. Read with GET /ops/scheduler/ticks; the daily
-- cron prunes rows older than 14 days.
CREATE TABLE IF NOT EXISTS scheduler_ticks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  ms INTEGER,
  skipped TEXT,
  drawn INTEGER NOT NULL DEFAULT 0,
  ran INTEGER NOT NULL DEFAULT 0,
  stopped_by TEXT,
  due TEXT,
  items TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_scheduler_ticks_at ON scheduler_ticks(at);
