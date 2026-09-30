-- Evidence of what tracked itself put into (or took out of) each managed
-- playlist (lib/playlist-blocklist.ts markInPlaylist / markOutOfPlaylist).
-- The 6-hourly comparison (lib/playlist-hygiene.ts) expects a video in an
-- artist playlist only when it has state 'in' here — written on a confirmed
-- playlistItems.insert, or seen in a complete listing — or when the audit
-- log shows a successful insert and tracked never took it out ('out').
-- A video the sync never managed to insert is therefore never recorded as
-- removed by the owner.
CREATE TABLE IF NOT EXISTS playlist_confirmed (
  playlist_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  state TEXT NOT NULL,          -- in | out
  source TEXT NOT NULL,         -- sync | mkvid | undo | listing | sweep | button | swap | recreate
  at INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, video_id)
);
