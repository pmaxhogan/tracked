import { createRoute, type RouteHandler } from '@hono/zod-openapi'
import { TracklistPurgeRequest, TracklistPurgeResponse, TracklistPurgeError, ErrorResponse } from '../schemas'
import type { Env } from '../types'
import { bearerAuth } from '../middleware/auth'
import { makeLogger } from '../lib/log'
import { purgeAndRefetch, resolvePurgeTarget } from '../lib/tracklist-purge'

export const tracklistPurgeRoute = createRoute({
  method: 'post',
  path: '/tracklist/purge',
  middleware: [bearerAuth] as const,
  security: [{ bearerAuth: [] }],
  summary: 'Purge one cached track list and fetch it again now',
  request: {
    body: { content: { 'application/json': { schema: TracklistPurgeRequest } }, required: true },
  },
  responses: {
    200: { content: { 'application/json': { schema: TracklistPurgeResponse } }, description: 'The freshly fetched list, summarized' },
    400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Not exactly one of url/slug/videoId, or not a valid one' },
    401: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Missing/invalid bearer token' },
    404: { content: { 'application/json': { schema: TracklistPurgeError } }, description: 'Unknown slug/video, or the tracklist is gone on 1001tracklists (404/410)' },
    502: { content: { 'application/json': { schema: TracklistPurgeError } }, description: 'Upstream fetch/parse failure; the older cached list is kept (stale: true)' },
    503: { content: { 'application/json': { schema: TracklistPurgeError } }, description: 'Fetching is paused; the older cached list is kept (stale: true)' },
  },
})

/**
 * Refetch the parsed list for one set at priority phone and replace the cached
 * entry. A failed refetch keeps the old entry and answers stale: true.
 */
export const tracklistPurgeHandler: RouteHandler<typeof tracklistPurgeRoute, { Bindings: Env }> = async (c) => {
  const reqId = c.req.raw.headers.get('cf-ray') ?? `local-${Math.random().toString(36).slice(2, 10)}`
  const log = makeLogger({ reqId, route: 'tracklist.purge' })
  const body = c.req.valid('json')
  const target = await resolvePurgeTarget(c.env, body)
  if (!target.ok) {
    log.warn('tracklist.purge.bad_target', { error: target.error, body })
    return c.json({ error: target.error, message: target.message, stale: false, fetchedAt: null }, target.status)
  }
  const r = await purgeAndRefetch(c.env, target.tracklistUrl, log)
  if (!r.ok) return c.json({ error: r.error, message: r.message, stale: r.stale, fetchedAt: r.fetchedAt }, r.status)
  return c.json(r.summary, 200)
}
