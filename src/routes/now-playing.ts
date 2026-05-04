import { createRoute, type RouteHandler } from '@hono/zod-openapi'
import { NowPlayingRequest, NowPlayingResponse, ErrorResponse } from '../schemas'
import type { Env, ParsedTrack, ResponseTrack, Status } from '../types'
import { resolveVideo, extractVideoId } from '../lib/youtube'
import { searchByYouTubeUrl, fetchTracklist, fetchMediaLinks, type MediaLinks } from '../lib/tracklists1001'
import { lookupAppleLink } from '../lib/itunes'
import { selectCurrent } from '../lib/timestamp'
import { TTL, getJson, putJson, sha1Hex } from '../lib/cache'
import { bearerAuth } from '../middleware/auth'
import { makeLogger, errorFields, type Logger } from '../lib/log'
import { IPBlockedError } from '../lib/fetch'

export const nowPlayingRoute = createRoute({
  method: 'post',
  path: '/now-playing',
  middleware: [bearerAuth] as const,
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: NowPlayingRequest } }, required: true },
  },
  responses: {
    200: { content: { 'application/json': { schema: NowPlayingResponse } }, description: 'Resolved tracks (or status flag)' },
    401: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Missing/invalid bearer token' },
    400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Validation failure' },
    500: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Server misconfiguration' },
  },
})

type Res = typeof NowPlayingResponse._type

export const nowPlayingHandler: RouteHandler<typeof nowPlayingRoute, { Bindings: Env }> = async (c) => {
  const reqId = c.req.raw.headers.get('cf-ray') ?? `local-${Math.random().toString(36).slice(2, 10)}`
  const log = makeLogger({ reqId })
  const tStart = Date.now()

  const body = c.req.valid('json')
  const env = c.env

  log.info('req.start', { method: c.req.method, path: c.req.path, body })

  const respond = (status: Status, extras: Partial<Res> = {}, message?: string) => {
    const payload = {
      status,
      videoUrl: null,
      tracklistUrl: null,
      setAppleLink: null,
      tracks: [],
      ...(message ? { message } : {}),
      ...extras,
    } satisfies Res
    log.info('req.end', { status, totalMs: Date.now() - tStart, response: payload })
    return c.json(payload, 200)
  }

  // Phase 1 — resolve videoId
  let videoId: string | null = null
  if (body.videoUrl) {
    videoId = extractVideoId(body.videoUrl)
    log.info('phase.video.from_url', { input: body.videoUrl, videoId })
    if (!videoId) {
      log.error('phase.video.unparseable_url', { input: body.videoUrl })
      return respond('no_video', {}, 'could not parse a YouTube video id from videoUrl')
    }
  } else if (body.videoTitle) {
    log.info('phase.video.from_title', { videoTitle: body.videoTitle, videoDurationSeconds: body.videoDurationSeconds })
    try {
      videoId = await resolveYouTube(env, body.videoTitle, body.videoDurationSeconds, log)
    } catch (e) {
      log.error('phase.video.youtube_throw', errorFields(e))
      return respond('upstream_error', {}, `youtube: ${(e as Error).message}`)
    }
    if (!videoId) {
      log.warn('phase.video.no_match', { videoTitle: body.videoTitle, videoDurationSeconds: body.videoDurationSeconds })
      return respond('no_video')
    }
  } else {
    log.error('phase.video.no_input')
    return respond('no_video', {}, 'videoUrl or videoTitle is required')
  }
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`
  log.info('phase.video.resolved', { videoId, videoUrl })

  // Phase 2 — find a tracklist
  let tracklistUrl: string | null = null
  try {
    tracklistUrl = await resolveTracklistUrl(env, videoId, videoUrl, log)
  } catch (e) {
    if (e instanceof IPBlockedError) {
      log.error('phase.search.ip_blocked', { videoId, videoUrl, clientIp: e.clientIp })
      return respond('upstream_error', { videoUrl }, `1001 search: ip_blocked (${e.clientIp ?? 'unknown'})`)
    }
    log.error('phase.search.throw', { videoId, videoUrl, ...errorFields(e) })
    return respond('upstream_error', { videoUrl }, `1001 search: ${(e as Error).message}`)
  }
  if (!tracklistUrl) {
    log.info('phase.search.no_tracklist', { videoId, videoUrl })
    return respond('no_tracklist', { videoUrl })
  }
  log.info('phase.search.resolved', { tracklistUrl })

  // Phase 3 — scrape the tracklist
  let parsedTracks: ParsedTrack[]
  let setAppleLink: string | null = null
  try {
    const scraped = await resolveTracklist(env, tracklistUrl, log)
    parsedTracks = scraped.tracks
    setAppleLink = scraped.setAppleLink
  } catch (e) {
    if (e instanceof IPBlockedError) {
      log.error('phase.scrape.ip_blocked', { tracklistUrl, clientIp: e.clientIp })
      return respond('upstream_error', { videoUrl, tracklistUrl }, `1001 scrape: ip_blocked (${e.clientIp ?? 'unknown'})`)
    }
    log.error('phase.scrape.throw', { tracklistUrl, ...errorFields(e) })
    return respond('upstream_error', { videoUrl, tracklistUrl }, `1001 scrape: ${(e as Error).message}`)
  }
  log.info('phase.scrape.resolved', {
    tracklistUrl,
    trackCount: parsedTracks.length,
    unidentifiedCount: parsedTracks.filter((t) => t.isUnidentified).length,
    setAppleLink,
  })

  // Phase 4 — pick current tracks (videoDurationSeconds caps the last group's
  // duration when present; harmless to omit otherwise)
  const sel = selectCurrent(parsedTracks, body.currentSeconds, body.videoDurationSeconds ?? null)
  log.info('phase.select.done', {
    currentSeconds: body.currentSeconds,
    setEndSeconds: body.videoDurationSeconds ?? null,
    pickedCount: sel.picked.length,
    currentCount: sel.picked.filter((t) => t.isCurrent).length,
    anyUnidentified: sel.anyUnidentified,
    pickedTitles: sel.picked.map((t) => `${t.startTime} ${t.artist} - ${t.title} (${t.durationTime || '?'})${t.isCurrent ? ' *' : ''}`),
  })
  if (sel.picked.length === 0) {
    log.warn('phase.select.empty', { currentSeconds: body.currentSeconds, totalTracks: parsedTracks.length })
    return respond('no_tracklist', { videoUrl, tracklistUrl })
  }

  // Phase 5 — enrich with deep links
  const enriched = await Promise.all(
    sel.picked.map(async (t) => {
      const parsed = parsedTracks.find((p) => p.title === t.title && p.startSeconds === t.startSeconds)
      const links = await resolveLinks(env, parsed, t, log)
      return { ...t, ...links } satisfies ResponseTrack
    }),
  )

  const status: Status = sel.anyUnidentified ? 'unidentified' : 'ok'
  const payload = { status, videoUrl, tracklistUrl, setAppleLink, tracks: enriched } satisfies Res
  log.info('req.end', { status, totalMs: Date.now() - tStart, response: payload })
  return c.json(payload, 200)
}

async function resolveYouTube(env: Env, title: string, dur: number | undefined, log: Logger): Promise<string | null> {
  const key = `yt:${await sha1Hex(title)}:${dur ?? 'x'}`
  const cached = await getJson<{ videoId: string | null }>(env.CACHE, key)
  if (cached) {
    log.info('cache.hit', { key, value: cached })
    return cached.videoId
  }
  log.info('cache.miss', { key })
  const r = await resolveVideo(title, dur, env.YOUTUBE_API_KEY, log)
  const videoId = r?.videoId ?? null
  await putJson(env.CACHE, key, { videoId }, TTL.YT_VIDEO)
  log.info('cache.put', { key, value: { videoId }, ttlSeconds: TTL.YT_VIDEO })
  return videoId
}

async function resolveTracklistUrl(env: Env, videoId: string, videoUrl: string, log: Logger): Promise<string | null> {
  const key = `s1001:${videoId}`
  const cached = await getJson<{ tracklistUrl: string | null }>(env.CACHE, key)
  if (cached) {
    log.info('cache.hit', { key, value: cached })
    return cached.tracklistUrl
  }
  log.info('cache.miss', { key })
  const { result } = await searchByYouTubeUrl(videoUrl, undefined, log)
  await putJson(env.CACHE, key, { tracklistUrl: result.tracklistUrl }, TTL.TRACKLIST_SEARCH)
  log.info('cache.put', { key, value: result, ttlSeconds: TTL.TRACKLIST_SEARCH })
  return result.tracklistUrl
}

type CachedTracklist = { tracks: ParsedTrack[]; setAppleLink: string | null }

async function resolveTracklist(env: Env, tracklistUrl: string, log: Logger): Promise<CachedTracklist> {
  const slug = tracklistUrl.match(/\/tracklist\/([^/]+)\//)?.[1] ?? tracklistUrl
  const key = `tl:${slug}`
  // Backwards compat: older cache entries were a bare ParsedTrack[]. If we
  // hit one of those, normalize and ignore the (missing) setAppleLink — it'll
  // be picked up on the next refresh after TTL expires.
  const cached = await getJson<CachedTracklist | ParsedTrack[]>(env.CACHE, key)
  if (cached) {
    if (Array.isArray(cached)) {
      log.info('cache.hit', { key, trackCount: cached.length, schema: 'legacy' })
      return { tracks: cached, setAppleLink: null }
    }
    log.info('cache.hit', { key, trackCount: cached.tracks.length, setAppleLink: cached.setAppleLink })
    return cached
  }
  log.info('cache.miss', { key })
  const { result } = await fetchTracklist(tracklistUrl, { brightdataApiKey: env.BRIGHTDATA_API_KEY, log })
  if (result.tracks.length > 0) {
    const value: CachedTracklist = { tracks: result.tracks, setAppleLink: result.setAppleLink }
    await putJson(env.CACHE, key, value, TTL.TRACKLIST_PAGE)
    log.info('cache.put', { key, trackCount: result.tracks.length, setAppleLink: result.setAppleLink, ttlSeconds: TTL.TRACKLIST_PAGE })
    return value
  }
  log.warn('cache.skip_empty', { key, reason: 'parsed 0 tracks; likely a transient captcha — not caching' })
  return { tracks: [], setAppleLink: result.setAppleLink }
}

async function resolveLinks(env: Env, parsed: ParsedTrack | undefined, t: ResponseTrack, log: Logger): Promise<{ appleLink: string | null; youtubeLink: string | null }> {
  if (t.isUnidentified) {
    log.info('links.skip_unidentified', { artist: t.artist, title: t.title })
    return { appleLink: null, youtubeLink: null }
  }

  let apple: string | null = null
  let youtube: string | null = null

  if (parsed?.trackId && /^\d+$/.test(parsed.trackId)) {
    const ml = await getMediaLinks(env, parsed.trackId, log)
    apple = ml.appleLink
    youtube = ml.youtubeLink
    log.info('links.medialink_result', { trackId: parsed.trackId, artist: t.artist, title: t.title, apple, youtube })
  } else {
    log.info('links.no_medialink_id', { artist: t.artist, title: t.title, parsedTrackId: parsed?.trackId ?? null })
  }

  if (!apple && t.artist && t.title) {
    apple = await lookupAppleCached(env, t.artist, t.title, log)
    log.info('links.itunes_fallback_result', { artist: t.artist, title: t.title, apple })
  }
  return { appleLink: apple, youtubeLink: youtube }
}

async function getMediaLinks(env: Env, trackId: string, log: Logger): Promise<MediaLinks> {
  const key = `ml:${trackId}`
  const cached = await getJson<MediaLinks>(env.CACHE, key)
  if (cached) {
    log.info('cache.hit', { key, value: cached })
    return cached
  }
  log.info('cache.miss', { key })
  const { result } = await fetchMediaLinks(trackId, { log, brightdataApiKey: env.BRIGHTDATA_API_KEY })
  await putJson(env.CACHE, key, result, TTL.MEDIALINK)
  log.info('cache.put', { key, value: result, ttlSeconds: TTL.MEDIALINK })
  return result
}

async function lookupAppleCached(env: Env, artist: string, title: string, log: Logger): Promise<string | null> {
  const key = `am:${await sha1Hex(`${artist}|${title}`)}`
  const cached = await getJson<{ url: string | null }>(env.CACHE, key)
  if (cached) {
    log.info('cache.hit', { key, value: cached })
    return cached.url
  }
  log.info('cache.miss', { key })
  const url = await lookupAppleLink(artist, title, log)
  await putJson(env.CACHE, key, { url }, TTL.APPLE)
  log.info('cache.put', { key, value: { url }, ttlSeconds: TTL.APPLE })
  return url
}
