-- Idle refresh of tracks (lib/track-refresh.ts): a scheduler tick's free slots
-- look a pre-save candidate's links up again (the medialink XHR), stalest
-- first, so one whose set is not fetched for a while still leaves the list
-- once 1001tracklists has its YouTube or Spotify link.
--   links_checked_at  unix ms of the last idle-refresh lookup (done or failed;
--                     the claim sets it). A candidate is stale by the later
--                     of this and updated_at (the last set fetch that saw it).
ALTER TABLE presave_candidates ADD COLUMN links_checked_at INTEGER;
