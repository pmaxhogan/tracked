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
    transitionWindowSeconds: z.number().int().nonnegative().max(120).optional().openapi({
      example: 15,
      description: 'How close to a track boundary (seconds) to also return the adjacent track. Default 15.',
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
  .object({ error: z.string() })
  .openapi('ErrorResponse')
