-- Recommended sets (lib/track-sets.ts): a set's length and its DJs, so the
-- page can rank by the share of the set the followed tracks make up (a
-- 1,000-track countdown matches many tracks by being long, not by style).
--   total_tracks  the row's "IDed tracks / total tracks" total; NULL until a
--                 crawled page lists the set again
--   djs           the DJ part of the title (before " @ " or " - ")
ALTER TABLE track_set_lists ADD COLUMN total_tracks INTEGER;
ALTER TABLE track_set_lists ADD COLUMN djs TEXT;
UPDATE track_set_lists SET djs = trim(CASE
    WHEN instr(title, ' @ ') > 0 AND (instr(title, ' - ') = 0 OR instr(title, ' @ ') < instr(title, ' - '))
      THEN substr(title, 1, instr(title, ' @ ') - 1)
    WHEN instr(title, ' - ') > 0 THEN substr(title, 1, instr(title, ' - ') - 1)
    ELSE title
  END);
