-- The Pre-saves playlist (lib/presave-playlist.ts): every pre-save that has a
-- YouTube video goes into one playlist, inserted by the cron.
--   presave_playlist_status    null (no video yet) | pending | added | failed
--   presave_playlist_item_id   reserved (playlistItems.insert's reply is not read); always null
--   presave_playlist_next_at   unix ms the insert is due (pending only)
--   presave_playlist_error     the last failure, one line
--   presave_playlist_attempts  failed tries, for the backoff (failed after 5)
ALTER TABLE presaves ADD COLUMN presave_playlist_status TEXT;
ALTER TABLE presaves ADD COLUMN presave_playlist_item_id TEXT;
ALTER TABLE presaves ADD COLUMN presave_playlist_next_at INTEGER;
ALTER TABLE presaves ADD COLUMN presave_playlist_error TEXT;
ALTER TABLE presaves ADD COLUMN presave_playlist_attempts INTEGER NOT NULL DEFAULT 0;

-- Backfill: every pre-save that already has a video waits to be added.
UPDATE presaves
   SET presave_playlist_status = 'pending', presave_playlist_next_at = 0
 WHERE youtube_video_id IS NOT NULL;
