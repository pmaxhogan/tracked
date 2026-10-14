-- Uploader channels and channel bans (lib/channel-bans.ts,
-- docs/superpowers/specs/2026-10-14-bad-videos-design.md).
--
-- video_meta: the uploader channel from videos.list part=snippet (same 1 unit
-- per 50 ids), or from a playlist listing's snippet.videoOwnerChannelId. A row
-- written from a listing alone has fetched_at = 0, so every reader that needs
-- duration or orientation still looks the video up. channel_checked = 1: the
-- row came from a videos.list call that asked for the snippet (a row from
-- before this migration is re-read once by the next lookup that wants it).
ALTER TABLE video_meta ADD COLUMN channel_id TEXT;
ALTER TABLE video_meta ADD COLUMN channel_title TEXT;
ALTER TABLE video_meta ADD COLUMN channel_checked INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS video_meta_channel ON video_meta (channel_id);

-- removed_videos: the channel of the removed video (filled when known, or
-- later by the ban queue), and whether the ban queue has looked at this row
-- yet (0 = an owner/button removal not yet turned into a question).
ALTER TABLE removed_videos ADD COLUMN channel_id TEXT;
ALTER TABLE removed_videos ADD COLUMN channel_title TEXT;
ALTER TABLE removed_videos ADD COLUMN ban_noted INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS removed_videos_channel ON removed_videos (channel_id);

-- One row per channel the owner was asked about.
-- state            pending | banned | declined | lifted
-- strikes          distinct videos of the channel the owner removed (owner/button), when last asked
-- last_*           the newest removal that asked
-- asked_at         unix s the question was (re)opened
-- decided_at       unix s of the last Ban / Not banned / Lift ban
-- notified         1 once a Web Push for the open question reached a device
CREATE TABLE IF NOT EXISTS channel_bans (
  channel_id TEXT PRIMARY KEY,
  channel_title TEXT,
  state TEXT NOT NULL,
  strikes INTEGER NOT NULL DEFAULT 0,
  last_video_id TEXT,
  last_playlist_id TEXT,
  last_slug TEXT,
  last_set_url TEXT,
  last_removal_at INTEGER,
  asked_at INTEGER,
  decided_at INTEGER,
  notified INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS channel_bans_state ON channel_bans (state);
