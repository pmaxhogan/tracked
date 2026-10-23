/**
 * The catalogue of YouTube quota consumers, in the owner's default rank order
 * (settings.quota.order reorders them; the copy below is what the settings
 * page shows). Owner actions (the like button, undo, a manual sync) are not
 * here: they bypass ranking and always go first.
 */

export type QuotaConsumerInfo = {
  key: string;
  label: string;
  description: string;
  /** What one action costs, in words, for the page. */
  perAction: string;
  /** Units one waiting item holds back from lower ranks; null when the work is not countable up front. */
  waitingCost: number | null;
};

export const QUOTA_CONSUMERS: ReadonlyArray<QuotaConsumerInfo> = [
  {
    key: "likes",
    label: "Pre-save likes",
    description: "Likes the video of a pre-saved track on your YouTube account once it has one.",
    perAction: "videos.getRating 1 + videos.rate 50",
    waitingCost: 51,
  },
  {
    key: "presave_playlists",
    label: "Pre-saves into playlists",
    description:
      'Adds every pre-save with a video to "Pre-saves" and ripped tracks to "Track uploads"; creates those playlists when missing.',
    perAction: "playlistItems.insert 50; creating a playlist 50",
    waitingCost: 50,
  },
  {
    key: "dj_playlists",
    label: "DJ playlists",
    description:
      "Adds the videos of sets to each DJ's playlist, creates the playlists, and swaps a video on recheck.",
    perAction: "insert 50; playlists.insert 50 + list 1/page; recheck swap 51",
    waitingCost: 50,
  },
  {
    key: "hygiene",
    label: "Playlist hygiene",
    description: "Compares playlists with YouTube and removes dead or wrong videos.",
    perAction: "comparison read 1/page; removal 51",
    waitingCost: null,
  },
  {
    key: "mkvid_uploads",
    label: "mkvid set uploads",
    description:
      "Uploads of sets through mkvid. They use the upload bucket, not this pool, so ranking only shows them for reference.",
    perAction: "upload bucket only (nothing from this pool)",
    waitingCost: null,
  },
  {
    key: "mkvid_recreate",
    label: "mkvid gone check and recreate",
    description: "Checks that uploaded videos still exist and removes the ones that are gone.",
    perAction: "videos.list 1; removal 51",
    waitingCost: 51,
  },
  {
    key: "genre_playlists",
    label: "Genre playlists",
    description:
      "Adds the videos of the followed DJs' sets to one playlist per genre (Genres page), creates those playlists, in set-date order.",
    perAction: "playlistItems.insert 50; creating a playlist 50 + list 1/page",
    waitingCost: 50,
  },
  {
    key: "combined",
    label: 'Combined "all artists" playlist',
    description: "Adds videos that are missing from the combined playlist.",
    perAction: "playlistItems.insert 50",
    waitingCost: 50,
  },
  {
    key: "renames",
    label: "Playlist renames",
    description: "Fixes playlist titles that no longer match.",
    perAction: "playlists.list 1, update 50",
    waitingCost: 50,
  },
  {
    key: "ordering",
    label: "Set-date ordering",
    description: "Moves videos in the artist playlists into set-date order.",
    perAction: "update 50 per move; list 1/page",
    waitingCost: null,
  },
];
