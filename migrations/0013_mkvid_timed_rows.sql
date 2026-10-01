-- How much of a stored mkvid list has cue times (lib/mkvid-readiness.ts).
-- 1001tracklists sets often time only a few rows; mkvid can place the others
-- by spreading them between timed neighbours, but only when they are few. A
-- list whose base rows (every row but a "w/" one) are under 90 % timed is
-- held: the request stays pending, no attempt used, until a recheck finds the
-- times filled in. Row 0 counts as timed (mkvid starts it at 0).
ALTER TABLE mkvid_request_tracks ADD COLUMN base_rows INTEGER;
ALTER TABLE mkvid_request_tracks ADD COLUMN timed_rows INTEGER;
UPDATE mkvid_request_tracks
   SET base_rows = (SELECT COUNT(*) FROM json_each(mkvid_request_tracks.tracks)
                     WHERE COALESCE(json_extract(value, '$.layered'), 0) != 1),
       timed_rows = (SELECT COUNT(*) FROM json_each(mkvid_request_tracks.tracks)
                      WHERE COALESCE(json_extract(value, '$.layered'), 0) != 1
                        AND (CAST(key AS INTEGER) = 0 OR json_type(value, '$.cueSeconds') IN ('integer', 'real')));
-- Sets held by this today keep their schedule due within a week, as
-- pullInHeldRecheck does from now on (an old set may be due in 90 days, or never),
-- spread at random over that week so they do not all come due at once.
UPDATE set_schedule
   SET next_due_at = CAST(strftime('%s', 'now') AS INTEGER) + ABS(RANDOM() % (7 * 86400)),
       updated_at = CAST(strftime('%s', 'now') AS INTEGER)
 WHERE url IN (SELECT r.set_url FROM mkvid_requests r JOIN mkvid_request_tracks t ON t.request_id = r.id
                WHERE r.status = 'pending' AND NOT COALESCE(t.base_rows > 0 AND t.timed_rows * 10 >= t.base_rows * 9, 0))
   AND (next_due_at IS NULL OR next_due_at > CAST(strftime('%s', 'now') AS INTEGER) + 7 * 86400);
