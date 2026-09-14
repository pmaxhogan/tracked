-- The mkvid queue is served newest set first, so each request carries the
-- set's date (ISO YYYY-MM-DD, from the 1001tracklists URL slug or page).
-- Undated requests go last, then most recently queued first.
ALTER TABLE mkvid_requests ADD COLUMN set_date TEXT;
-- Backfill from the URL: every 1001tracklists set slug ends in -YYYY-MM-DD.html.
UPDATE mkvid_requests
   SET set_date = substr(set_url, -15, 10)
 WHERE set_date IS NULL
   AND set_url GLOB '*-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].html';
CREATE INDEX IF NOT EXISTS mkvid_requests_queue ON mkvid_requests (status, set_date, created_at);
