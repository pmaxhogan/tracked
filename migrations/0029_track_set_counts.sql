-- Recommended sets (lib/track-sets.ts): what a track page's row shows for the
-- set besides its title, as of the last time a crawled page listed it. NULL
-- until then (rows stored before this migration).
--   views   the list's view count
--   likes   its likes (0 when the row's likes badge is hidden)
--   genres  its music styles as the row writes them ("Tech House, Techno")
ALTER TABLE track_set_lists ADD COLUMN views INTEGER;
ALTER TABLE track_set_lists ADD COLUMN likes INTEGER;
ALTER TABLE track_set_lists ADD COLUMN genres TEXT;
