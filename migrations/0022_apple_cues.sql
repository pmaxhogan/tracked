-- Apple Music timing backstop (lib/apple-cues.ts, lib/apple-backstop.ts).
-- A held mkvid list (under 90 % of its base rows timed) may get cue times
-- from the set's Apple Music "DJ mix" album: rows with no 1001tl cue are
-- filled from the album's track lengths, aligned to the real cues around them.
--   apple_album_url  the set page's Apple Music album link (setAppleLink), kept
--                    here because the parsed-page KV cache expires
--   apple_cues       how many cues of the stored list came from Apple Music
--   apple_note       why the album was or was not used, in plain words
--                    ("length mismatch: album 58:10 vs source 1:02:45")
ALTER TABLE mkvid_request_tracks ADD COLUMN apple_album_url TEXT;
ALTER TABLE mkvid_request_tracks ADD COLUMN apple_cues INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mkvid_request_tracks ADD COLUMN apple_note TEXT;
