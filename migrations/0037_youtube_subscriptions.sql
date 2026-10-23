-- YouTube channel subscriptions for the followed DJs (lib/youtube-subscriptions.ts):
-- the linked YouTube account subscribes to each followed DJ's own channel, and
-- unsubscribes when the DJ is unfollowed, but only from subscriptions tracked
-- made itself.

-- The DJ's own YouTube channel, as tracked found it: the first YouTube channel
-- link in the DJ's own artist box on their set pages (set_meta.meta boxes,
-- migration 0033). One row per followed DJ the resolver has looked at.
CREATE TABLE IF NOT EXISTS dj_youtube_channels (
  slug TEXT PRIMARY KEY,
  channel_id TEXT,                       -- UC...; NULL = none known (reason says why)
  candidates TEXT NOT NULL DEFAULT '[]', -- JSON array of every channel id the box links, the page's order
  artist_path TEXT,                      -- the artist box's page (/artist/<x>/tracklists.html)
  reason TEXT,                           -- why channel_id is NULL: no_set_meta | no_artist_box | no_youtube_link
  checked_at INTEGER NOT NULL,           -- unix seconds of the last look
  updated_at INTEGER NOT NULL            -- unix seconds channel_id last changed
);

-- The subscription state per channel (two DJs can share one).
--   origin  tracked  tracked made the subscription: removed when no followed DJ wants it
--           owner    it was there before (found by the list, or a duplicate insert): never removed
--   state   subscribed | unsubscribed (tracked removed it) | failed (retried at next_at) | not_found (channel gone)
CREATE TABLE IF NOT EXISTS youtube_channel_subs (
  channel_id TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  state TEXT NOT NULL,
  subscription_id TEXT,                  -- YouTube's id of the subscription (what subscriptions.delete takes)
  slug TEXT,                             -- the followed DJ it was made for (the last one)
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  next_at INTEGER,                       -- unix seconds a failed one is tried again; NULL = not before a change
  at INTEGER NOT NULL                    -- unix seconds of the last change
);
