-- Thumbnails (search results): the source image URL of a track's artwork and
-- of a set's page image (og:image), as the set page gave them. The images
-- themselves are copied into R2 (binding IMAGES, bucket tracked-images) the
-- first time /ui/img/<key> is asked for one; search_images maps that key
-- (32 hex of sha256(src)) back to its source.
ALTER TABLE search_tracks ADD COLUMN artwork_url TEXT;
ALTER TABLE search_sets ADD COLUMN image_url TEXT;
CREATE TABLE search_images (key TEXT PRIMARY KEY, src TEXT NOT NULL);
