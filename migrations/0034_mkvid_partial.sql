-- Partially broken recordings (lib/mkvid.ts failMkvidRequest, mkvid lib/partial.ts).
-- A SoundCloud source can serve a few of its HLS fragments empty; mkvid then
-- fails the job as `partial_source: ...`. A recording with a small gap is used
-- only when the set has no other recording to try.
--   mkvid_requests.allow_partial   1 = no other recording is left: the claim says `allowPartial`
--                                  and mkvid uses a source with a small gap
--   mkvid_requests.partial_tried   JSON [{ kind, url }]: the recordings that came back partial,
--                                  first one first (the one used if no alternative works)
--   mkvid_requests.partial_note    the gap of the recording the video was made from, one line
--                                  ("~20 s missing at 20:49"); shown as info, never a problem
--   set_media_facts.audio_sources  JSON [{ kind, url }]: every recording mkvid could use on the
--                                  set page, best first (NULL = page not read since this column)
ALTER TABLE mkvid_requests ADD COLUMN allow_partial INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mkvid_requests ADD COLUMN partial_tried TEXT;
ALTER TABLE mkvid_requests ADD COLUMN partial_note TEXT;
ALTER TABLE set_media_facts ADD COLUMN audio_sources TEXT;
