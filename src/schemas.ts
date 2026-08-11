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
  })
  .openapi('ResponseTrack')

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
    isMashupLinked: z.boolean().openapi({ description: 'True when this row is a "w/" mashup sibling of the previous row (shares its cue position).' }),
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
