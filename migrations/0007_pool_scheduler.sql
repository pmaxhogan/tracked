-- The pool era (2026-09-29): every 1001tracklists request goes through tlpool,
-- a budgeted browser pool, so the Worker has to decide carefully what is due.

-- When each set page is next due for a recheck (quest decision 13: pace by set
-- age). One row per set URL (a b2b set listed under two DJs is fetched once).
-- Rows are created lazily by the scheduler (lib/fetch-scheduler.ts) with the
-- first due time spread at random across one interval, so the ~2,100 sets
-- known when the pool starts do not all come due in the same tick; every
-- later interval is jittered too.
CREATE TABLE IF NOT EXISTS set_schedule (
  url TEXT PRIMARY KEY,
  set_date TEXT,                          -- YYYY-MM-DD from the URL; NULL = unknown age
  next_due_at INTEGER,                    -- unix seconds; NULL = never (old set, good video, no ID rows)
  last_fetched_at INTEGER,                -- unix seconds of the last successful fetch through the scheduler/sync
  has_id_rows INTEGER NOT NULL DEFAULT 0, -- the list had unidentified rows at the last fetch
  no_good_video INTEGER NOT NULL DEFAULT 0, -- the set had no usable YouTube video at the last fetch
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS set_schedule_due ON set_schedule (next_due_at);

-- Hand-marked and failing rechecks (checked_at = 0, or a fetch that did not
-- complete) are claimed per attempt: retry_at backs off after each attempt,
-- and at most 3 attempts per set per UTC day (lib/fetch-scheduler.ts).
ALTER TABLE set_schedule ADD COLUMN retry_at INTEGER;          -- unix seconds; NULL = no attempt pending
ALTER TABLE set_schedule ADD COLUMN attempt_day TEXT;          -- YYYY-MM-DD (UTC) of attempts_today
ALTER TABLE set_schedule ADD COLUMN attempts_today INTEGER NOT NULL DEFAULT 0;

-- The pending/recheck queries read tracklists by these columns on every tick.
CREATE INDEX IF NOT EXISTS tracklists_queue ON tracklists (processed, abandoned, discovered_at);

-- Lists stored for mkvid before verification existed were trusted on the
-- in-page decoy check alone. From now on trusted = 1 means "saved while the
-- set was verified" (lib/verification.ts), so every older row starts over.
UPDATE mkvid_request_tracks SET trusted = 0;

-- Verification (decision 2): a list is `verified` only when a second fetch,
-- at least 2 h after the first and by a DIFFERENT pool account, passes the
-- decoy detector and matches the first on every row. `fingerprint` is a
-- SHA-256 over the rows (normalised artist + title, cue, own cue, layering,
-- anonymous flag; lib/verification.ts). Account ids are tlpool's opaque
-- acct-N, never usernames.
CREATE TABLE IF NOT EXISTS set_verification (
  url TEXT PRIMARY KEY,
  state TEXT NOT NULL,                    -- 'pending' (first fetch recorded, awaiting the second) | 'verified'
  fingerprint TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  first_account TEXT NOT NULL,
  first_fetched_at INTEGER NOT NULL,      -- unix seconds
  verify_due_at INTEGER,                  -- earliest time for the second fetch (NULL once verified)
  second_account TEXT,
  second_fetched_at INTEGER,
  verified_at INTEGER,
  exclude_accounts TEXT NOT NULL DEFAULT '[]', -- JSON: accounts the second fetch must not use
  mismatches INTEGER NOT NULL DEFAULT 0,  -- verification pairs that disagreed so far
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS set_verification_due ON set_verification (state, verify_due_at);

-- Per-DJ pacing of the listing-page reads: daily discovery (page 1, spread
-- around the clock instead of a 06:00 burst) and the paced backfill of older
-- sets (one "older sets" step at a time; its cursor stays in SUBS KV
-- djbackfill:<slug>).
CREATE TABLE IF NOT EXISTS dj_schedule (
  slug TEXT PRIMARY KEY,
  next_discovery_at INTEGER,
  next_backfill_at INTEGER,
  updated_at INTEGER NOT NULL
);

-- Events tlpool posts to POST /pool/events (challenge created/solved/expired,
-- account flagged/created), and whether each one was pushed to the owner.
-- `payload` is a whitelisted subset of the event (ids, types, times), never
-- credentials or usernames.
CREATE TABLE IF NOT EXISTS pool_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT UNIQUE,                   -- tlpool's id when it sends one (dedupes retries)
  type TEXT NOT NULL,
  challenge_id TEXT,
  account_id TEXT,
  payload TEXT NOT NULL,
  received_at INTEGER NOT NULL,           -- unix seconds
  push_status TEXT NOT NULL,              -- none | sent | failed | not_configured
  pushed_at INTEGER,
  push_attempts INTEGER NOT NULL DEFAULT 0 -- deliveries tried (a failed one is retried by the cron, 5 at most)
);
CREATE INDEX IF NOT EXISTS pool_events_challenge ON pool_events (challenge_id);
CREATE INDEX IF NOT EXISTS pool_events_received ON pool_events (received_at);
CREATE INDEX IF NOT EXISTS pool_events_push ON pool_events (push_status, received_at);
