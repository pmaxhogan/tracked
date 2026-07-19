import { createRoute, type RouteHandler } from '@hono/zod-openapi'
import { TracklistRequest, TracklistResponse, ErrorResponse } from '../schemas'
import type { Env } from '../types'
import { normalizeTracklistUrl } from '../lib/tracklists1001'
import { resolveFullTracklist } from '../lib/tracklist-resolve'
import { bearerAuth } from '../middleware/auth'
import { makeLogger, errorFields } from '../lib/log'
import { IPBlockedError, CloudflareChallengeError } from '../lib/fetch'

export const tracklistRoute = createRoute({
  method: 'post',
  path: '/tracklist',
  middleware: [bearerAuth] as const,
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: TracklistRequest } }, required: true },
  },
  responses: {
    200: { content: { 'application/json': { schema: TracklistResponse } }, description: 'Parsed tracklist (every track)' },
    400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Not a valid 1001tracklists tracklist URL' },
    401: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Missing/invalid bearer token' },
    502: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Upstream 1001tracklists fetch/parse failure' },
  },
})

/**
 * Resolve a whole 1001tracklists tracklist to JSON: one object per track with
 * name, artist, id, cue timestamps, and links. This is the "dump the set"
 * counterpart to /now-playing (which returns only the track(s) playing at a
 * given offset). Both share the same underlying scrape + cache via
 * lib/tracklist-resolve, so a set fetched by one endpoint is warm for the other.
 */
export const tracklistHandler: RouteHandler<typeof tracklistRoute, { Bindings: Env }> = async (c) => {
  const reqId = c.req.raw.headers.get('cf-ray') ?? `local-${Math.random().toString(36).slice(2, 10)}`
  const log = makeLogger({ reqId, route: 'tracklist' })
  const tStart = Date.now()

  const body = c.req.valid('json')
  const env = c.env
  const resolveLinks = body.resolveLinks ?? true

  const tracklistUrl = normalizeTracklistUrl(body.url)
  if (!tracklistUrl) {
    log.warn('tracklist.bad_url', { url: body.url })
    return c.json({ error: 'invalid_url', message: 'not a 1001tracklists tracklist URL' }, 400)
  }
  log.info('tracklist.start', { tracklistUrl, resolveLinks })

  let full
  try {
    full = await resolveFullTracklist(env, tracklistUrl, { resolveLinks }, log)
  } catch (e) {
    if (e instanceof IPBlockedError) {
      log.error('tracklist.ip_blocked', { tracklistUrl, clientIp: e.clientIp })
      return c.json({ error: 'upstream_error', message: `1001 scrape: ip_blocked (${e.clientIp ?? 'unknown'})` }, 502)
    }
    if (e instanceof CloudflareChallengeError) {
      log.error('tracklist.cf_challenge', { tracklistUrl, errorMessage: e.message })
      return c.json({ error: 'upstream_error', message: `1001 scrape: cf_challenge — ${e.message}` }, 502)
    }
    log.error('tracklist.scrape_throw', { tracklistUrl, ...errorFields(e) })
    return c.json({ error: 'upstream_error', message: `1001 scrape: ${(e as Error).message}` }, 502)
  }

  // A zero-track parse is the fingerprint of a captcha/CF-shell that slipped
  // past the block detectors, not a real empty set — surface it as upstream so
  // the caller retries rather than trusting an empty list.
  if (full.tracks.length === 0) {
    log.warn('tracklist.empty', { tracklistUrl })
    return c.json({ error: 'upstream_error', message: 'parsed 0 tracks (likely a transient captcha) — try again shortly' }, 502)
  }

  const payload = {
    tracklistUrl,
    slug: full.slug,
    setAppleLink: full.setAppleLink,
    linksResolved: resolveLinks,
    trackCount: full.tracks.length,
    tracks: full.tracks,
  }
  log.info('tracklist.done', {
    tracklistUrl,
    trackCount: full.tracks.length,
    unidentifiedCount: full.tracks.filter((t) => t.isUnidentified).length,
    linksResolved: resolveLinks,
    totalMs: Date.now() - tStart,
    counters: log.counters,
  })
  return c.json(payload, 200)
}
