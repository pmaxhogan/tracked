-- mkvid uploads through two Google Cloud projects, each with its own YouTube
-- quota day: 'primary' is mkvid's own (mkvid-uploads), 'shared' is the sync's
-- (tracked-youtube). A claim is stamped with the account it was handed out
-- for, so the per-account daily caps can be counted from D1.
ALTER TABLE mkvid_requests ADD COLUMN account TEXT NOT NULL DEFAULT 'primary';
