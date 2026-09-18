-- Manual queue order. sort_key defaults to the set date as a Julian day
-- (undated -> 0), so the queue stays newest-set-first and a set the sync
-- queues later still lands in date order among hand-sorted rows; the panel's
-- top / up / down / bottom rewrite the key (lib/mkvid.ts moveMkvidRequest).
ALTER TABLE mkvid_requests ADD COLUMN sort_key REAL NOT NULL DEFAULT 0;
UPDATE mkvid_requests SET sort_key = COALESCE(julianday(set_date), 0);
CREATE INDEX IF NOT EXISTS mkvid_requests_order ON mkvid_requests (status, sort_key, created_at);
