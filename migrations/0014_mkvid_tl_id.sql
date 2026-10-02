-- The 1001tracklists id of a request's set (`/tracklist/<id>/<name>.html`,
-- lib/mkvid.ts tracklistIdOf). 1001tl renames a set's <name> part and a DJ page
-- can list the old and the new URL side by side; both are one set, so enqueue
-- and claim look for a twin request by this id (indexed: an equality seek, not
-- a LIKE scan per recheck). NULL when the URL has no id.
ALTER TABLE mkvid_requests ADD COLUMN tl_id TEXT;
UPDATE mkvid_requests
   SET tl_id = substr(substr(set_url, instr(set_url, '/tracklist/') + 11), 1,
                      instr(substr(set_url, instr(set_url, '/tracklist/') + 11), '/') - 1)
 WHERE instr(set_url, '/tracklist/') > 0
   AND instr(substr(set_url, instr(set_url, '/tracklist/') + 11), '/') > 1;
CREATE INDEX IF NOT EXISTS idx_mkvid_requests_tl_id ON mkvid_requests(tl_id);
