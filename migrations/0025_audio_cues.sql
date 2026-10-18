-- Audio cue estimation (lib/audio-cues.ts, lib/audio-backstop.ts, routes/mkvid-audio.ts).
-- A held mkvid list (too few cue times, after the Apple Music backstop had its
-- pass) may get cue times estimated from audio: mkvid fingerprints each
-- identified track's audio against the set's recording and places the rows in
-- their known order. Only rows that pass the confidence gate are stored, and
-- they only ever fill rows with no 1001tl or Apple cue.
--   audio_estimates   JSON array of the gated estimates of the last run
--                     ({ index, key, cueSeconds, share, onset, votes, source });
--                     re-applied on every save of the list, dropped when the
--                     1001tl cues alone reach 90 %
--   audio_cues        how many cues of the stored list came from audio
--   audio_note        the last run's outcome or the running job's progress, in plain words
--   audio_stats       JSON of the last run: rows, withAudio, gated, sources, setSeconds
--   audio_claimed_at  when mkvid claimed (or last renewed) the job; NULL = not running
--   audio_next_at     not handed out again before this (retry backoff, or the redo after a run)
--   audio_attempts    failed runs in a row (reset by a completed run)
--   audio_ran_at      when the last run completed
ALTER TABLE mkvid_request_tracks ADD COLUMN audio_estimates TEXT;
ALTER TABLE mkvid_request_tracks ADD COLUMN audio_cues INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mkvid_request_tracks ADD COLUMN audio_note TEXT;
ALTER TABLE mkvid_request_tracks ADD COLUMN audio_stats TEXT;
ALTER TABLE mkvid_request_tracks ADD COLUMN audio_claimed_at INTEGER;
ALTER TABLE mkvid_request_tracks ADD COLUMN audio_next_at INTEGER;
ALTER TABLE mkvid_request_tracks ADD COLUMN audio_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mkvid_request_tracks ADD COLUMN audio_ran_at INTEGER;
