import { z } from '@hono/zod-openapi'

export const NowPlayingRequest = z
  .object({
    videoTitle: z.string().min(1).optional().openapi({
      example: 'Matroda @ Club Space Miami, United States 2023-08-05',
      description:
        'Title from the YouTube media notification. Required if videoUrl is not given. When set, the server resolves the URL via YouTube Data API (100 quota units).',
    }),
    videoUrl: z.string().min(1).optional().openapi({
      example: 'https://www.youtube.com/watch?v=79n8BaQAL2Q',
      description:
        'Direct YouTube URL or video id. If provided, skips the YouTube Data API lookup. Accepts youtube.com/watch?v=, youtu.be/, m.youtube.com, music.youtube.com, /embed/, /shorts/, /live/, /v/, or a bare 11-character id.',
    }),
    videoDurationSeconds: z.number().int().positive().optional().openapi({
      example: 5286,
      description:
        'Duration of the source video in seconds. Used as a tie-breaker when resolving via videoTitle. Ignored when videoUrl is given.',
    }),
    currentSeconds: z.number().int().nonnegative().openapi({
      example: 4590,
      description: 'Current playback offset (seconds from start of the video)',
    }),
    refresh: z.boolean().optional().openapi({
      example: false,
      description:
        'When true, the cached track list for the resolved set is purged and fetched again right now (same as POST /tracklist/purge) before the current track is picked. Costs one upstream fetch; use it when the list looks stale or wrong.',
    }),
  })
  .refine((d) => Boolean(d.videoTitle || d.videoUrl), {
    message: 'Either videoTitle or videoUrl is required',
    path: ['videoTitle'],
  })
  .openapi('NowPlayingRequest')

export const ResponseTrackSchema = z
  .object({
    title: z.string(),
    artist: z.string(),
    startTime: z.string(),
    startSeconds: z.number().int().nullable(),
    durationSeconds: z.number().int().nullable().openapi({
      example: 270,
      description:
        "Length the track occupies in the set: nextGroupStart - thisGroupStart, except the last group uses videoDurationSeconds (request body) as its end if provided. Mashup-linked siblings share their group's duration. null when the next-group start or set-end is unknown.",
    }),
    durationTime: z.string().openapi({
      example: '4:30',
      description: "Same as durationSeconds formatted 'M:SS' / 'H:MM:SS'. Empty string when null.",
    }),
    isCurrent: z.boolean(),
    isUnidentified: z.boolean(),
    idStatus: z.string().nullable().openapi({
      example: 'ID Remix',
      description:
        'Non-null when this row is a partial-ID variant of a known base track ("ID Remix", "ID Edit", "ID Bootleg", "ID Rework"). The artist, title, appleLink, youtubeLink, and trackUrl all describe the BASE track; the actual playing version is not yet identified and may differ.',
    }),
    appleLink: z.string().nullable(),
    youtubeLink: z.string().nullable(),
    trackUrl: z.string().nullable().openapi({
      example: 'https://www.1001tracklists.com/track/1hf79cg5/tobehonest-where-ya-at/index.html',
      description: 'Canonical 1001tracklists track page (for opening track details, feedback, alt links). null when unidentified.',
    }),
    artworkUrl: z.string().nullable().openapi({
      example: 'https://geo-media.beatport.com/image_size/300x300/8702a65a-cfa7-4890-9476-4a346d36f169.jpg',
      description: 'Square 300×300 album art (normalized — Beatport via image_size/300x300, SoundCloud via t300x300). null when only the 1001tl placeholder was embedded; clients should show their own no-art indicator.',
    }),
    youtubeLiked: z.boolean().nullable().openapi({
      example: false,
      description:
        'Whether the connected YouTube account (see /subscriptions) has liked the youtubeLink video — i.e. it is in YouTube Music "Liked songs". null when no YouTube account is connected, the track has no youtubeLink, or the rating lookup failed. Toggle with POST /likes.',
    }),
  })
  .openapi('ResponseTrack')

export const TracklistCacheInfo = z
  .object({
    fetchedAt: z.string().nullable().openapi({ example: '2026-09-29T14:03:11.000Z', description: 'When the list was fetched from 1001tracklists. null for an entry cached before this was recorded.' }),
    ageSeconds: z.number().int().nullable().openapi({ example: 5400, description: 'Seconds since fetchedAt (null when unknown).' }),
    ttlSeconds: z.number().int().nullable().openapi({ example: 21600, description: 'How long the entry is cached: 259200 (3 days) when every row is identified, 21600 (6 hours) with ID rows or a set under 2 days old.' }),
    refreshed: z.boolean().openapi({ description: 'True when this request purged and refetched the list (refresh: true).' }),
  })
  .openapi('TracklistCacheInfo')

export const NowPlayingResponse = z
  .object({
    status: z.enum(['ok', 'no_video', 'no_tracklist', 'unidentified', 'upstream_error']),
    videoUrl: z.string().nullable(),
    tracklistUrl: z.string().nullable(),
    /** Apple Music album/playlist URL for the entire DJ set when 1001tracklists has one (parallels videoUrl for YouTube). */
    setAppleLink: z.string().nullable().openapi({
      example: 'https://music.apple.com/us/album/max-styler-at-edc-las-vegas-2025-circuit-grounds-stage-dj-mix/1818472775?app=music&at=1000lwkw',
      description: 'Apple Music album link for the whole DJ set (when 1001tracklists has one). Parallel to videoUrl. null otherwise.',
    }),
    tracks: z.array(ResponseTrackSchema),
    message: z.string().optional(),
    cache: TracklistCacheInfo.nullable().optional().openapi({
      description: 'Age of the cached track list the answer came from. Present once a tracklist was resolved and read.',
    }),
  })
  .openapi('NowPlayingResponse')

export const ErrorResponse = z
  .object({ error: z.string(), message: z.string().optional() })
  .openapi('ErrorResponse')

// ─── GET-a-whole-tracklist endpoint ─────────────────────────────────────────

export const TracklistRequest = z
  .object({
    url: z.string().min(1).openapi({
      example: 'https://www.1001tracklists.com/tracklist/l3uw499/matroda-club-space-miami-united-states-2023-08-05.html',
      description:
        'A 1001tracklists tracklist URL. The scheme and leading "www." are optional; any query string or fragment is ignored. Must point at /tracklist/<id>/... — DJ pages and other hosts are rejected with 400.',
    }),
    resolveLinks: z.boolean().optional().default(true).openapi({
      example: true,
      description:
        'When true (default) each identified track is enriched with its Apple Music and YouTube deep links via 1001tracklists’ medialink API (one extra upstream call per track, cached 30 days). Set false to skip that and return only what the tracklist page itself yields (still includes trackUrl + artworkUrl), which is faster for large sets.',
    }),
  })
  .openapi('TracklistRequest')

export const TracklistTrackSchema = z
  .object({
    index: z.number().int().openapi({ description: 'Zero-based position of the track within the set.' }),
    artist: z.string(),
    title: z.string(),
    startTime: z.string().openapi({ example: '1:16:30', description: 'Cue time as shown on the page ("H:MM:SS" / "M:SS"). Empty string when the row has no cue.' }),
    startSeconds: z.number().int().nullable().openapi({ description: 'Cue time in seconds. null when the row is uncued (e.g. a mashup-linked sibling or a trailing untimed extra).' }),
    trackId: z.string().nullable().openapi({ description: 'Internal 1001tracklists track id (used for the medialink API). null when unextractable.' }),
    trackUrl: z.string().nullable().openapi({ example: 'https://www.1001tracklists.com/track/1hf79cg5/tobehonest-where-ya-at/index.html', description: 'Canonical 1001tracklists track page. null when the row carries no track meta url.' }),
    artworkUrl: z.string().nullable().openapi({ description: 'Square 300×300 album art (Beatport/SoundCloud CDN, normalized). null when only the 1001tl placeholder was present.' }),
    appleLink: z.string().nullable().openapi({ description: 'Apple Music deep link. Always null when resolveLinks is false or the track is unidentified.' }),
    youtubeLink: z.string().nullable().openapi({ description: 'YouTube deep link. Always null when resolveLinks is false or the track is unidentified.' }),
    soundcloudLink: z.string().nullable().openapi({ description: 'SoundCloud widget-player URL — plays free (with ads) in the browser and is downloadable by yt-dlp without cookies. Always null when resolveLinks is false or the track has no SoundCloud source.' }),
    isUnidentified: z.boolean().openapi({ description: 'True only when the playing track is fully anonymous (e.g. "Cave Studio - ID"). Partial-ID variants set idStatus instead and keep their base-track fields.' }),
    idStatus: z.string().nullable().openapi({ example: 'ID Remix', description: 'Non-null when this row is a partial-ID variant of a known base track ("ID Remix", "ID Edit", ...). The artist/title/links describe the BASE track; the playing version may differ.' }),
    isMashupLinked: z.boolean().openapi({ description: 'True when this row is a "w/" mashup sibling of the previous row (shares its cue position). False on the first row, and when the row it was played with is an anonymous "ID - ID" row (those are not listed).' }),
    youtubeLiked: z.boolean().nullable().openapi({ description: 'Whether the connected YouTube account has liked the youtubeLink video. null when not connected, no youtubeLink, or the lookup failed.' }),
  })
  .openapi('TracklistTrack')

export const TracklistResponse = z
  .object({
    tracklistUrl: z.string().openapi({ description: 'The canonical tracklist URL that was scraped.' }),
    slug: z.string().openapi({ example: 'l3uw499', description: "1001tracklists' short id for the tracklist." }),
    setAppleLink: z.string().nullable().openapi({ description: 'Apple Music album link for the whole DJ set, when 1001tracklists embeds one. null otherwise.' }),
    setYoutubeLink: z.string().nullable().openapi({ description: 'YouTube watch URL for the set’s primary recording, when 1001tracklists embeds one. null otherwise.' }),
    setSoundcloudLink: z.string().nullable().openapi({ description: 'SoundCloud widget-player URL for the whole set’s recording, when 1001tracklists embeds one. null otherwise.' }),
    linksResolved: z.boolean().openapi({ description: 'Whether per-track Apple/YouTube links were resolved (echoes the request’s resolveLinks).' }),
    trackCount: z.number().int(),
    tracks: z.array(TracklistTrackSchema),
  })
  .openapi('TracklistResponse')

// ─── Like / unlike a video on the connected YouTube account ─────────────────

export const LikesRequest = z
  .object({
    videoUrl: z.string().min(1).openapi({
      example: 'https://www.youtube.com/watch?v=79n8BaQAL2Q',
      description: 'YouTube URL or bare 11-character video id (same shapes /now-playing accepts for videoUrl).',
    }),
    liked: z.boolean().openapi({
      example: true,
      description: 'true → rate "like" (adds to YouTube Music "Liked songs"); false → rate "none" (removes the like). Idempotent.',
    }),
  })
  .openapi('LikesRequest')

export const LikesResponse = z
  .object({
    videoId: z.string().openapi({ example: '79n8BaQAL2Q' }),
    liked: z.boolean().openapi({ description: 'Echoes the requested state after YouTube accepted it.' }),
  })
  .openapi('LikesResponse')

export const LikedSongsQuery = z
  .object({
    durations: z
      .enum(['0', '1'])
      .optional()
      .openapi({
        example: '1',
        description:
          'Default "1": batch every videoId through videos.list (1 quota unit per 50) and attach duration/durationSeconds. "0" skips that pass; playlistItems alone never carries duration.',
      }),
    pageToken: z.string().optional().openapi({ description: 'Resume from a nextPageToken returned by an earlier call that hit maxPages.' }),
    maxPages: z.coerce.number().int().min(1).max(200).optional().openapi({
      example: 20,
      description: 'Cap on playlistItems pages (50 songs each) walked in one call. Omit to walk the whole playlist.',
    }),
  })
  .openapi('LikedSongsQuery')

export const LikedSongSchema = z
  .object({
    videoId: z.string().openapi({ example: '79n8BaQAL2Q' }),
    duration: z.string().nullable().openapi({ example: 'PT4M30S', description: 'ISO 8601 as YouTube emits it; null when durations=0 or the video is unavailable.' }),
    durationSeconds: z.number().nullable().openapi({ example: 270 }),
    unavailable: z.boolean().openapi({
      description: 'true when the video is deleted/private: videos.list did not return it, or the playlistItem title is "Deleted video"/"Private video".',
    }),
    item: z.record(z.string(), z.unknown()).openapi({
      description: 'The raw youtube#playlistItem resource (parts id, snippet, contentDetails, status), verbatim.',
    }),
  })
  .openapi('LikedSong')

export const LikedSongsResponse = z
  .object({
    playlistId: z.literal('LL'),
    count: z.number().int(),
    nextPageToken: z.string().nullable().openapi({ description: 'Non-null only when maxPages stopped the walk early; pass back as ?pageToken= to continue.' }),
    quotaUnits: z.number().int().openapi({ description: 'YouTube Data API quota this call spent (1 per playlistItems page + 1 per 50 videos when durations=1).' }),
    items: z.array(LikedSongSchema),
  })
  .openapi('LikedSongsResponse')

// ─── /mkvid/claim (mkvid's work queue; bearer MKVID_TOKEN, not API_TOKEN) ───

export const MkvidClaimBody = z
  .object({
    accounts: z.array(z.enum(['primary', 'shared'])).max(2).optional().openapi({
      description: 'Accounts mkvid can upload through right now; default ["primary"]. The primary fills first, then the shared one.',
    }),
  })
  .openapi('MkvidClaimBody')

export const MkvidTrackSchema = z
  .object({
    cueSeconds: z.number().int().nullable().openapi({
      example: 754,
      description: 'Cue on the tracklist, seconds from the start of the set; null when the row is not cued. On a layered row, only a cue printed on that row itself (null when it has none: start it with its base track).',
    }),
    artist: z.string().nullable().openapi({ example: 'Matroda', description: 'null for an anonymous "ID" artist, and for every row when tracksTrusted is false.' }),
    title: z.string().nullable().openapi({ example: 'Bad Habit', description: 'null for an anonymous "ID" title, and for every row when tracksTrusted is false.' }),
    artworkUrl: z.string().nullable().openapi({ description: '300×300 album art (Beatport / SoundCloud CDN) when the row has any. Real even on a decoy page.' }),
    isId: z.boolean().openapi({
      description:
        'The playing track is unidentified on 1001tracklists: an anonymous "ID - ID" row (then artist, title and artworkUrl are always null; show "ID") or a named artist with an "ID" title. NOT reliable when tracksTrusted is false: a decoy page shows a random 15–35% of identified rows as "ID - ID", so on an untrusted list isId=true may be a known track.',
    }),
    layered: z.boolean().openapi({
      description:
        'A 1001tracklists "w/" row: plays on top of the previous track in this list (mashup, acapella over an instrumental, tracks played together) rather than replacing it. Its base is the nearest earlier row with layered=false; several layered rows in a row share one base. Never true on the first row. Real even when tracksTrusted is false (it comes from the page layout, not the names).',
    }),
  })
  .openapi('MkvidTrack')

export const MkvidClaimedRequest = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    setUrl: z.string(),
    artistName: z.string().nullable(),
    setTitle: z.string().nullable(),
    setDate: z.string().nullable(),
    source: z.enum(['soundcloud', 'hearthis']),
    sourceUrl: z.string(),
    lastCueSeconds: z.number().int().nullable(),
    trackCount: z.number().int().nullable(),
    idedCount: z.number().int().nullable(),
    account: z.enum(['primary', 'shared']).openapi({ description: 'Google Cloud project to upload through: primary = mkvid-uploads, shared = tracked-youtube.' }),
    attempts: z.number().int(),
    tracks: z.array(MkvidTrackSchema).max(300).openapi({ description: 'The set\'s track list: every row of the page in order, anonymous "ID - ID" rows included (at most 300 rows); [] when none is stored.' }),
    tracksTrusted: z.boolean().openapi({
      description:
        'true only when the list came from a page that passed the decoy check with evidence (≥3 rows compared, none contradicting itself). Since ~2026-09-22 1001tracklists serves our accounts pages with real cues/artwork and randomized names, and shows a random 15–35% of identified rows as "ID - ID"; an untrusted list carries no names, and its isId cannot be believed (cueSeconds, artworkUrl and layered still can). false when the list is empty.',
    }),
  })
  .passthrough()
  .openapi('MkvidClaimedRequest')

export const MkvidClaimResponse = z
  .object({ request: MkvidClaimedRequest.nullable().openapi({ description: 'null when nothing is claimable (queue empty, daily cap reached, no account offered).' }) })
  .openapi('MkvidClaimResponse')

// ─── purge one cached tracklist ─────────────────────────────────────────────

export const TracklistPurgeRequest = z
  .object({
    url: z.string().min(1).optional().openapi({
      example: 'https://www.1001tracklists.com/tracklist/l3uw499/matroda-club-space-miami-united-states-2023-08-05.html',
      description: 'A 1001tracklists tracklist URL.',
    }),
    slug: z.string().min(1).optional().openapi({
      example: 'l3uw499',
      description: 'The short id in /tracklist/<slug>/…, for a set tracked already knows (cached, synced or queued for mkvid).',
    }),
    videoId: z.string().min(1).optional().openapi({
      example: '79n8BaQAL2Q',
      description: 'A YouTube video id or URL that maps to a set (synced or mkvid-uploaded, or found by an earlier /now-playing).',
    }),
  })
  .refine((d) => [d.url, d.slug, d.videoId].filter(Boolean).length === 1, {
    message: 'exactly one of url, slug or videoId is required',
    path: ['url'],
  })
  .openapi('TracklistPurgeRequest')

export const TracklistPurgeResponse = z
  .object({
    tracklistUrl: z.string(),
    slug: z.string(),
    rowCount: z.number().int().openapi({ description: 'Every page row, anonymous "ID - ID" rows included.' }),
    trackCount: z.number().int().openapi({ description: 'Named rows (what /tracklist returns).' }),
    identifiedCount: z.number().int().openapi({ description: 'Named rows that are not ID.' }),
    fetchedAt: z.string().nullable(),
    ttlSeconds: z.number().int().nullable().openapi({ description: 'How long the fresh list is cached (259200 or 21600).' }),
  })
  .openapi('TracklistPurgeResponse')
