-- Set uploads whose playlist insert failed (lib/mkvid-playlist.ts).
-- /mkvid/complete used to fail as a whole when YouTube refused the artist
-- playlist insert (quota, a rate limit, a 5xx), so mkvid redelivered the
-- finished upload every minute and the set stayed undelivered. Now the
-- request is `done` either way, and the insert is tried again by the cron.
--   playlist_status  NULL = done before 0026 (in the playlists); 'added' /
--                    'duplicate' = in the artist playlist; 'pending' = the
--                    insert failed and the cron tries it again at `not_before`;
--                    'failed' = YouTube refused the video for good
--   playlist_tries   failed inserts so far (the transient backoff grows with it)
-- A recreation whose new video is still waiting keeps `replaces_video_id`: the
-- old video stays in the playlists until the new one is in, then it is retired.
ALTER TABLE mkvid_requests ADD COLUMN playlist_status TEXT;
ALTER TABLE mkvid_requests ADD COLUMN playlist_tries INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS mkvid_requests_playlist_due ON mkvid_requests (playlist_status, not_before) WHERE playlist_status = 'pending';
