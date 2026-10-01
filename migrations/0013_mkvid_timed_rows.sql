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
