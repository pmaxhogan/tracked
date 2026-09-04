import { createRoute, type RouteHandler } from '@hono/zod-openapi'
import { LikedSongsQuery, LikedSongsResponse, ErrorResponse } from '../schemas'
import type { Env } from '../types'
import { getAccessToken, GoogleOAuthRefreshFailed } from '../lib/google-oauth'
import {
  LIKED_VIDEOS_PLAYLIST_ID,
  YouTubeApiError,
  getVideoDurations,
  listPlaylistItems,
  type RawPlaylistItem,
} from '../lib/youtube-playlists'
import { likedSongsAuth } from '../middleware/auth'
import { makeLogger, errorFields } from '../lib/log'

export const likedSongsRoute = createRoute({
  method: 'get',
  path: '/liked-songs',
  middleware: [likedSongsAuth] as const,
  security: [{ likedSongsAuth: [] }],
  request: { query: LikedSongsQuery },
  responses: {
    200: {
      content: { 'application/json': { schema: LikedSongsResponse } },
      description: 'Every item in the connected account\'s Liked videos (= YouTube Music "Liked songs") playlist, newest-liked first',
    },
    400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Bad query parameter' },
    401: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Missing/invalid LIKED_SONGS_TOKEN bearer' },
    502: { content: { 'application/json': { schema: ErrorResponse } }, description: 'YouTube API rejected the call (quota, ...)' },
    500: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Server misconfiguration (LIKED_SONGS_TOKEN / OAuth client missing)' },
    503: { content: { 'application/json': { schema: ErrorResponse } }, description: 'No YouTube account connected (or its refresh token was revoked)' },
  },
})

function videoIdOf(it: RawPlaylistItem): string | null {
  return it.contentDetails?.videoId ?? it.snippet?.resourceId?.videoId ?? null
}

/**
 * Dump the connected account's "Liked songs" as JSON for downstream agents.
 * Read-only; gated by its own LIKED_SONGS_TOKEN so the token can be handed to
 * an agent without also granting the Tasker write routes.
 *
 * Each item carries the raw playlistItem plus `durationSeconds` (from a
 * second videos.list pass, since playlistItems never includes duration) so a
 * client can filter by length without another API call.
 */
export const likedSongsHandler: RouteHandler<typeof likedSongsRoute, { Bindings: Env }> = async (c) => {
  const reqId = c.req.raw.headers.get('cf-ray') ?? `local-${Math.random().toString(36).slice(2, 10)}`
  const log = makeLogger({ reqId, route: 'liked-songs' })
  const tStart = Date.now()
  const q = c.req.valid('query')
  const wantDurations = q.durations !== '0'

  let accessToken: string
  try {
    const tok = await getAccessToken(c.env)
    if (!tok) {
      log.warn('liked_songs.not_connected')
      return c.json({ error: 'youtube_not_connected', message: 'connect a YouTube account at /subscriptions first' }, 503)
    }
    accessToken = tok.accessToken
  } catch (e) {
    log.error('liked_songs.token_failed', errorFields(e))
    if (e instanceof GoogleOAuthRefreshFailed && e.invalidGrant) {
      return c.json({ error: 'youtube_not_connected', message: 'YouTube refresh token was revoked; reconnect at /subscriptions' }, 503)
    }
    if (/not configured/.test((e as Error).message)) {
      return c.json({ error: 'misconfigured', message: (e as Error).message }, 500)
    }
    return c.json({ error: 'upstream_error', message: `oauth: ${(e as Error).message}` }, 502)
  }

  try {
    const listed = await listPlaylistItems(LIKED_VIDEOS_PLAYLIST_ID, accessToken, {
      pageToken: q.pageToken,
      maxPages: q.maxPages,
    })
    let quotaUnits = listed.pages
    const ids = listed.items.map(videoIdOf).filter((x): x is string => !!x)
    const durations = wantDurations
      ? await getVideoDurations(ids, accessToken)
      : new Map<string, { duration: string; durationSeconds: number | null }>()
    if (wantDurations) quotaUnits += Math.ceil(new Set(ids).size / 50)

    const items = listed.items.map((item) => {
      const videoId = videoIdOf(item) ?? ''
      const d = durations.get(videoId)
      const title = (item.snippet as { title?: string } | undefined)?.title
      const titledUnavailable = title === 'Deleted video' || title === 'Private video'
      return {
        videoId,
        duration: d?.duration ?? null,
        durationSeconds: d?.durationSeconds ?? null,
        unavailable: titledUnavailable || (wantDurations && !d),
        item,
      }
    })

    log.info('liked_songs.done', {
      count: items.length,
      pages: listed.pages,
      durations: wantDurations,
      quotaUnits,
      totalMs: Date.now() - tStart,
    })
    return c.json({ playlistId: 'LL' as const, count: items.length, nextPageToken: listed.nextPageToken, quotaUnits, items }, 200)
  } catch (e) {
    log.error('liked_songs.list_failed', errorFields(e))
    const reason = e instanceof YouTubeApiError ? e.reason : null
    return c.json(
      { error: 'upstream_error', message: `youtube liked-songs listing failed${reason ? ` (${reason})` : ''}: ${(e as Error).message}` },
      502,
    )
  }
}
