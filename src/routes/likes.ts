import { createRoute, type RouteHandler } from '@hono/zod-openapi'
import { LikesRequest, LikesResponse, ErrorResponse } from '../schemas'
import type { Env } from '../types'
import { extractVideoId } from '../lib/youtube'
import { getAccessToken, GoogleOAuthRefreshFailed } from '../lib/google-oauth'
import { rateVideo } from '../lib/youtube-likes'
import { YouTubeApiError } from '../lib/youtube-playlists'
import { bearerAuth } from '../middleware/auth'
import { makeLogger, errorFields } from '../lib/log'

export const likesRoute = createRoute({
  method: 'post',
  path: '/likes',
  middleware: [bearerAuth] as const,
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: LikesRequest } }, required: true },
  },
  responses: {
    200: { content: { 'application/json': { schema: LikesResponse } }, description: 'Rating applied (idempotent)' },
    400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Validation failure / unparseable YouTube URL' },
    401: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Missing/invalid bearer token' },
    502: { content: { 'application/json': { schema: ErrorResponse } }, description: 'YouTube API rejected the call (quota, video not found, ...)' },
    503: { content: { 'application/json': { schema: ErrorResponse } }, description: 'No YouTube account connected (or its refresh token was revoked)' },
  },
})

/**
 * Like / unlike a YouTube video on the connected account — i.e. add it to or
 * remove it from YouTube Music's "Liked songs". Idempotent: liking an
 * already-liked video (or unliking one that isn't) is a no-op 200.
 *
 * Uses the same OAuth tokens the /subscriptions playlist sync uses. When there
 * are none (never connected, or Google revoked the refresh token) this returns
 * 503 `youtube_not_connected` so the phone can show a "reconnect" toast rather
 * than silently doing nothing.
 */
export const likesHandler: RouteHandler<typeof likesRoute, { Bindings: Env }> = async (c) => {
  const reqId = c.req.raw.headers.get('cf-ray') ?? `local-${Math.random().toString(36).slice(2, 10)}`
  const log = makeLogger({ reqId, route: 'likes' })
  const tStart = Date.now()
  const body = c.req.valid('json')

  const videoId = extractVideoId(body.videoUrl)
  if (!videoId) {
    log.warn('likes.bad_url', { videoUrl: body.videoUrl })
    return c.json({ error: 'invalid_url', message: `could not parse a YouTube video id from "${body.videoUrl}"` }, 400)
  }

  let accessToken: string
  try {
    const tok = await getAccessToken(c.env)
    if (!tok) {
      log.warn('likes.not_connected', { videoId })
      return c.json({ error: 'youtube_not_connected', message: 'connect a YouTube account at /subscriptions first' }, 503)
    }
    accessToken = tok.accessToken
  } catch (e) {
    log.error('likes.token_failed', { videoId, ...errorFields(e) })
    if (e instanceof GoogleOAuthRefreshFailed && e.invalidGrant) {
      return c.json({ error: 'youtube_not_connected', message: 'YouTube refresh token was revoked; reconnect at /subscriptions' }, 503)
    }
    return c.json({ error: 'upstream_error', message: `oauth: ${(e as Error).message}` }, 502)
  }

  try {
    await rateVideo(videoId, body.liked ? 'like' : 'none', accessToken)
  } catch (e) {
    log.error('likes.rate_failed', { videoId, liked: body.liked, ...errorFields(e) })
    const reason = e instanceof YouTubeApiError ? e.reason : null
    return c.json({ error: 'upstream_error', message: `youtube videos.rate failed${reason ? ` (${reason})` : ''}: ${(e as Error).message}` }, 502)
  }

  log.info('likes.done', { videoId, liked: body.liked, totalMs: Date.now() - tStart })
  return c.json({ videoId, liked: body.liked }, 200)
}
