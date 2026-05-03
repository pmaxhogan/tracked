import { z } from '@hono/zod-openapi'

export const NowPlayingRequest = z
  .object({
    videoTitle: z.string().min(1).openapi({
      example: 'Matroda @ Club Space Miami, United States 2023-08-05',
      description: 'Title from the YouTube media notification',
    }),
    videoDurationSeconds: z.number().int().positive().optional().openapi({
      example: 7080,
      description: 'Duration of the source video in seconds; used as a tie-breaker when YouTube returns multiple matches',
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
  .openapi('NowPlayingRequest')

export const ResponseTrackSchema = z
  .object({
    title: z.string(),
    artist: z.string(),
    startTime: z.string(),
    startSeconds: z.number().int().nullable(),
    isCurrent: z.boolean(),
    isUnidentified: z.boolean(),
    appleLink: z.string().nullable(),
    youtubeLink: z.string().nullable(),
  })
  .openapi('ResponseTrack')

export const NowPlayingResponse = z
  .object({
    status: z.enum(['ok', 'no_video', 'no_tracklist', 'unidentified', 'upstream_error']),
    videoUrl: z.string().nullable(),
    tracklistUrl: z.string().nullable(),
    tracks: z.array(ResponseTrackSchema),
    message: z.string().optional(),
  })
  .openapi('NowPlayingResponse')

export const ErrorResponse = z
  .object({ error: z.string() })
  .openapi('ErrorResponse')
