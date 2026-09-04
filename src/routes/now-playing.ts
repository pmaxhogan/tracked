import { createRoute, type RouteHandler } from '@hono/zod-openapi'
import { NowPlayingRequest, NowPlayingResponse, ErrorResponse } from '../schemas'
import type { Env, ParsedTrack, ResponseTrack, Status } from '../types'
import { resolveVideo, extractVideoId } from '../lib/youtube'
import { searchByYouTubeUrl, searchByTitle } from '../lib/tracklists1001'
import { resolveTracklistPage, resolveTrackMediaLinks } from '../lib/tracklist-resolve'
import { lookupAppleLink } from '../lib/itunes'
import { selectCurrent } from '../lib/timestamp'
import { TTL, getJson, invertedTs, putJson, sha1Hex } from '../lib/cache'
import { bearerAuth } from '../middleware/auth'
import { makeLogger, errorFields, type Logger } from '../lib/log'
import { IPBlockedError, CloudflareChallengeError } from '../lib/fetch'
import { attachYoutubeLiked } from '../lib/liked-status'

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

/** Which signal resolved the tracklist — logged for triage. */
type TracklistVia = 'youtube_url' | 'youtube_title' | 'posted_title'

const watchUrl = (videoId: string) => `https://www.youtube.com/watch?v=${videoId}`

/**
 * Cache-key versions. Every cached value embeds the version of the logic that
 * produced it (`family:v<N>:...`), so when that logic changes we bump the number
 * and stale entries from the old code are ignored — they age out via TTL instead
 * of being served. This is the fix for the class of bug where we shipped a
 * correct change but a cached wrong value (e.g. a `null` tracklist from the old
 * over-strict ranking) kept being returned. Bump the family whose shape or
 * semantics changed; leave the rest.
 */
const CV = {
  yt: 1, // YouTube resolve → { videoId, matchTitle }
  searchUrl: 2, // 1001tl search by YouTube URL — v2: rejects the site's text-search fallback (multi-hyphen video ids)
  searchTitle: 2, // 1001tl search by title — v2: IDF-weighted ranking (v1 over-rejected valid matches)
  apple: 1, // iTunes Apple-link fallback
  // NB: the `tracklist` (parsed page) and `medialink` (per-track links) cache
  // families moved to lib/tracklist-resolve.ts (TRACKLIST_CV) so /now-playing
  // and /tracklist share the same cache keys.
} as const

export const nowPlayingHandler: RouteHandler<typeof nowPlayingRoute, { Bindings: Env }> = async (c) => {
  const reqId = c.req.raw.headers.get('cf-ray') ?? `local-${Math.random().toString(36).slice(2, 10)}`
  const log = makeLogger({ reqId })
  const tStart = Date.now()

  const body = c.req.valid('json')
  const env = c.env

  // Pull CF request metadata for regional triage. cf is undefined on non-CF
  // (e.g. Miniflare dev) so guard everything.
  const cf = (c.req.raw as Request & { cf?: IncomingRequestCfProperties }).cf
  log.info('req.start', {
    method: c.req.method,
    path: c.req.path,
    body,
    colo: cf?.colo ?? null,
    country: cf?.country ?? null,
  })

  // Mutable audit context, filled in as each phase completes. bgAudit reads it
  // at write time, so even an early error return records whatever we managed to
  // resolve before bailing (e.g. the YouTube match on a later no_tracklist).
  const audit: {
    youtube?: { videoId: string | null; videoUrl: string | null; matchTitle: string | null; error: string | null }
    search?: { attempts: Array<{ via: TracklistVia; query: string }>; via: TracklistVia | null; tracklistUrl: string | null }
    select?: {
      currentStartSeconds: number | null
      currentSkewSeconds: number | null
      trackCount: number | null
      unidentifiedCount: number | null
      currentTracks: Array<{ artist: string; title: string; startTime: string; startSeconds: number | null }>
    }
  } = {}

  // Durable, best-effort audit record (90-day TTL) so a request is still
  // diagnosable long after Workers Logs ages out — this is the data behind the
  // admin panel's "Recent requests" view. Never blocks or breaks the response —
  // runs after it via waitUntil, and swallows its own errors.
  const bgAudit = (final: { status: Status; message?: string | null }) => {
    const cs = body.currentSeconds
    const dur = body.videoDurationSeconds ?? null
    // A reported position past the video's own length is physically impossible
    // and the fingerprint of a client-side bug (e.g. the Tasker `* 1.5` that
    // inflated the position). Flag it so the panel can highlight it.
    const impossibleTimestamp = dur != null && cs > dur
    const record = {
      t: new Date().toISOString(),
      reqId,
      status: final.status,
      message: final.message ?? null,
      input: { videoTitle: body.videoTitle ?? null, videoUrl: body.videoUrl ?? null, currentSeconds: cs, videoDurationSeconds: dur },
      impossibleTimestamp,
      youtube: audit.youtube ?? null,
      search: audit.search ?? null,
      select: audit.select ?? null,
      meta: { colo: cf?.colo ?? null, country: cf?.country ?? null, totalMs: Date.now() - tStart },
    }
    // Compact summary stored in KV metadata so the admin list view is a single
    // list() round-trip (no per-row get). Must stay under KV's 1024-byte cap —
    // hence the title truncation and short field names.
    const summary = {
      t: record.t,
      status: final.status,
      title: (body.videoTitle ?? body.videoUrl ?? '').slice(0, 100),
      cs,
      dur,
      via: audit.search?.via ?? null,
      skew: audit.select?.currentSkewSeconds ?? null,
      impossible: impossibleTimestamp,
      ms: record.meta.totalMs,
    }
    // Inverted-timestamp key (see lib/cache.ts): ascending KV order becomes
    // newest-first, so the panel fetches the most recent N in one page even
    // past 1000 total records.
    const invTs = invertedTs(Date.now())
    const p = env.CACHE
      .put(`np:${invTs}:${reqId}`, JSON.stringify(record), { expirationTtl: TTL.AUDIT, metadata: summary })
      .catch((e) => log.warn('audit.write_failed', errorFields(e)))
    try {
      c.executionCtx.waitUntil(p)
    } catch {
      /* no executionCtx (dev/tests): let it run fire-and-forget */
    }
  }

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
    log.info('req.end', { status, totalMs: Date.now() - tStart, counters: log.counters, response: payload })
    bgAudit({ status, message: message ?? null })
    return c.json(payload, 200)
  }

  // Phase 1 (step a) — best-effort resolve a YouTube video from the notif data.
  // A miss here is NO LONGER fatal: we fall through to searching 1001tracklists
  // by title (steps c/d) so a YouTube-side hiccup (duration tie-break outside
  // tolerance, the exact upload missing from the top results, a quota/5xx blip)
  // can't block a set that 1001tl actually has.
  const originalTitle = body.videoTitle ?? null
  let videoId: string | null = null
  let videoUrl: string | null = null
  let ytMatchTitle: string | null = null // title of the matched YT video (may differ from the notification title)
  let ytError: string | null = null // set if the YouTube lookup threw; folded into the final message, not fatal
  if (body.videoUrl) {
    videoId = extractVideoId(body.videoUrl)
    if (videoId) {
      videoUrl = watchUrl(videoId)
      log.info('phase.video.from_url', { input: body.videoUrl, videoId })
    } else {
      log.warn('phase.video.unparseable_url', { input: body.videoUrl })
    }
  } else if (originalTitle) {
    log.info('phase.video.from_title', { videoTitle: originalTitle, videoDurationSeconds: body.videoDurationSeconds })
    try {
      const yt = await resolveYouTube(env, originalTitle, body.videoDurationSeconds, log)
      if (yt) {
        videoId = yt.videoId
        videoUrl = watchUrl(yt.videoId)
        ytMatchTitle = yt.matchTitle || null
        log.info('phase.video.resolved', { videoId, videoUrl, matchTitle: ytMatchTitle })
      } else {
        log.warn('phase.video.no_match', { videoTitle: originalTitle, videoDurationSeconds: body.videoDurationSeconds })
      }
    } catch (e) {
      ytError = (e as Error).message
      log.error('phase.video.youtube_throw', errorFields(e))
    }
  } else {
    log.error('phase.video.no_input')
    return respond('no_video', {}, 'videoUrl or videoTitle is required')
  }
  audit.youtube = { videoId, videoUrl, matchTitle: ytMatchTitle, error: ytError }

  // Phase 2 (steps b→d) — find a tracklist, trying each available signal until
  // one hits: (b) the resolved YouTube URL, (c) the resolved video's title,
  // (d) the original POSTed notification title.
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')
  type Attempt = { via: TracklistVia; kind: 'url' | 'title'; query: string }
  const attempts: Attempt[] = []
  if (videoUrl && videoId) attempts.push({ via: 'youtube_url', kind: 'url', query: videoUrl })
  if (ytMatchTitle) attempts.push({ via: 'youtube_title', kind: 'title', query: ytMatchTitle })
  if (originalTitle && !(ytMatchTitle && norm(ytMatchTitle) === norm(originalTitle))) {
    attempts.push({ via: 'posted_title', kind: 'title', query: originalTitle })
  }
  log.info('phase.search.plan', { attempts: attempts.map((a) => ({ via: a.via, query: a.query })) })
  audit.search = { attempts: attempts.map((a) => ({ via: a.via, query: a.query })), via: null, tracklistUrl: null }

  let tracklistUrl: string | null = null
  let tracklistVia: TracklistVia | null = null
  for (const a of attempts) {
    try {
      const url =
        a.kind === 'url'
          ? await resolveTracklistByUrl(env, videoId!, a.query, log)
          : await resolveTracklistByTitle(env, a.query, log)
      log.info('phase.search.attempt', { via: a.via, kind: a.kind, query: a.query, tracklistUrl: url })
      if (url) {
        tracklistUrl = url
        tracklistVia = a.via
        break
      }
    } catch (e) {
      // An IP block / CF challenge will hit every subsequent attempt too, so
      // stop and surface it as the (transient, retryable) upstream error.
      if (e instanceof IPBlockedError) {
        log.error('phase.search.ip_blocked', { via: a.via, clientIp: e.clientIp })
        return respond('upstream_error', { videoUrl }, `1001 search: ip_blocked (${e.clientIp ?? 'unknown'})`)
      }
      log.error('phase.search.attempt_throw', { via: a.via, kind: a.kind, query: a.query, ...errorFields(e) })
      // Other errors are per-attempt; try the next signal.
    }
  }
  if (audit.search) {
    audit.search.via = tracklistVia
    audit.search.tracklistUrl = tracklistUrl
  }

  if (!tracklistUrl) {
    const searched = attempts.map((a) => a.via)
    if (videoId) {
      // We DID find a YouTube video; 1001tl just has no tracklist for it.
      const msg = `matched YouTube video${ytMatchTitle ? ` "${ytMatchTitle}"` : ''} but 1001tracklists has no tracklist for it (searched: ${searched.join(', ') || 'none'})`
      log.info('phase.search.no_tracklist', { videoId, videoUrl, searched })
      return respond('no_tracklist', { videoUrl }, msg)
    }
    // No YouTube video AND no title match on 1001tl — say which, so the toast is actionable.
    const bits: string[] = []
    if (originalTitle) bits.push(`no confident YouTube match for "${originalTitle}"`)
    else if (body.videoUrl) bits.push(`could not parse a video id from "${body.videoUrl}" (and no videoTitle to search by)`)
    if (ytError) bits.push(`youtube lookup errored (${ytError})`)
    if (originalTitle) bits.push(`1001tracklists title search found nothing`)
    const msg = bits.join('; ') || 'could not resolve a video or tracklist'
    log.warn('phase.search.no_video_no_tracklist', { originalTitle, ytError, searched })
    return respond('no_video', {}, msg)
  }
  log.info('phase.search.resolved', { tracklistUrl, via: tracklistVia })

  // Phase 3 — scrape the tracklist
  let parsedTracks: ParsedTrack[]
  let setAppleLink: string | null = null
  try {
    const scraped = await resolveTracklistPage(env, tracklistUrl, log)
    parsedTracks = scraped.tracks
    setAppleLink = scraped.setAppleLink
  } catch (e) {
    if (e instanceof IPBlockedError) {
      log.error('phase.scrape.ip_blocked', { tracklistUrl, clientIp: e.clientIp })
      return respond('upstream_error', { videoUrl, tracklistUrl }, `1001 scrape: ip_blocked (${e.clientIp ?? 'unknown'})`)
    }
    if (e instanceof CloudflareChallengeError) {
      log.error('phase.scrape.cf_challenge', { tracklistUrl, errorMessage: e.message })
      return respond('upstream_error', { videoUrl, tracklistUrl }, `1001 scrape: cf_challenge — ${e.message}`)
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
  const cued = parsedTracks.map((t) => t.startSeconds).filter((s): s is number => s !== null)
  const currentStartSeconds = sel.picked.find((t) => t.isCurrent)?.startSeconds ?? null
  audit.select = {
    currentStartSeconds,
    currentSkewSeconds: currentStartSeconds !== null ? body.currentSeconds - currentStartSeconds : null,
    trackCount: parsedTracks.length,
    unidentifiedCount: parsedTracks.filter((t) => t.isUnidentified).length,
    currentTracks: sel.picked
      .filter((t) => t.isCurrent)
      .map((t) => ({ artist: t.artist, title: t.title, startTime: t.startTime, startSeconds: t.startSeconds })),
  }
  log.info('phase.select.done', {
    currentSeconds: body.currentSeconds,
    setEndSeconds: body.videoDurationSeconds ?? null,
    // The current group's own cue, and how far the reported playback position
    // sits past it. A large positive skew here with an otherwise-sensible
    // tracklist is the fingerprint of a bad currentSeconds from the phone.
    currentStartSeconds,
    currentSkewSeconds: currentStartSeconds !== null ? body.currentSeconds - currentStartSeconds : null,
    firstCueSeconds: cued.length ? cued[0] : null,
    lastCueSeconds: cued.length ? cued[cued.length - 1] : null,
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

  // Phase 6 — mark which tracks the connected YouTube account has already
  // liked (drives the filled/outlined thumbs-up in the Tasker scene). Best
  // effort: null everywhere when YouTube isn't connected or the lookup fails.
  const tracks = await attachYoutubeLiked(env, enriched, log)

  const status: Status = sel.anyUnidentified ? 'unidentified' : 'ok'
  const payload = { status, videoUrl, tracklistUrl, setAppleLink, tracks } satisfies Res
  log.info('req.end', { status, totalMs: Date.now() - tStart, counters: log.counters, response: payload })
  bgAudit({ status })
  return c.json(payload, 200)
}

type YouTubeMatch = { videoId: string; matchTitle: string }

async function resolveYouTube(env: Env, title: string, dur: number | undefined, log: Logger): Promise<YouTubeMatch | null> {
  const key = `yt:v${CV.yt}:${await sha1Hex(title)}:${dur ?? 'x'}`
  // Older cache entries stored only { videoId }; matchTitle is optional so they
  // still deserialize (step c just gets skipped for those until the TTL rolls).
  const cached = await getJson<{ videoId: string | null; matchTitle?: string | null }>(env.CACHE, key)
  if (cached) {
    log.counters.cacheHits++
    log.info('cache.hit', { key, value: cached })
    return cached.videoId ? { videoId: cached.videoId, matchTitle: cached.matchTitle ?? '' } : null
  }
  log.counters.cacheMisses++
  log.info('cache.miss', { key })
  log.counters.youtubeApiCalls++
  const r = await resolveVideo(title, dur, env.YOUTUBE_API_KEY, log)
  const value = { videoId: r?.videoId ?? null, matchTitle: r?.matchTitle ?? null }
  await putJson(env.CACHE, key, value, TTL.YT_VIDEO)
  log.info('cache.put', { key, value, ttlSeconds: TTL.YT_VIDEO })
  return r ? { videoId: r.videoId, matchTitle: r.matchTitle } : null
}

/** search 1001tl by the resolved YouTube URL (media-source pinned — exact). Cached by videoId. */
async function resolveTracklistByUrl(env: Env, videoId: string, videoUrl: string, log: Logger): Promise<string | null> {
  const key = `s1001:v${CV.searchUrl}:${videoId}`
  const cached = await getJson<{ tracklistUrl: string | null }>(env.CACHE, key)
  if (cached) {
    log.counters.cacheHits++
    log.info('cache.hit', { key, value: cached })
    return cached.tracklistUrl
  }
  log.counters.cacheMisses++
  log.info('cache.miss', { key })
  const { result } = await searchByYouTubeUrl(videoUrl, undefined, log)
  await putJson(env.CACHE, key, { tracklistUrl: result.tracklistUrl }, TTL.TRACKLIST_SEARCH)
  log.info('cache.put', { key, value: result, ttlSeconds: TTL.TRACKLIST_SEARCH })
  return result.tracklistUrl
}

/** search 1001tl by free-text title (ranked). Cached by normalized title hash. */
async function resolveTracklistByTitle(env: Env, title: string, log: Logger): Promise<string | null> {
  const key = `s1001t:v${CV.searchTitle}:${await sha1Hex(title.trim().toLowerCase())}`
  const cached = await getJson<{ tracklistUrl: string | null }>(env.CACHE, key)
  if (cached) {
    log.counters.cacheHits++
    log.info('cache.hit', { key, value: cached })
    return cached.tracklistUrl
  }
  log.counters.cacheMisses++
  log.info('cache.miss', { key })
  const { result } = await searchByTitle(title, undefined, log)
  await putJson(env.CACHE, key, { tracklistUrl: result.tracklistUrl }, TTL.TRACKLIST_SEARCH)
  log.info('cache.put', { key, value: result, ttlSeconds: TTL.TRACKLIST_SEARCH })
  return result.tracklistUrl
}

async function resolveLinks(env: Env, parsed: ParsedTrack | undefined, t: ResponseTrack, log: Logger): Promise<{ appleLink: string | null; youtubeLink: string | null }> {
  if (t.isUnidentified) {
    log.info('links.skip_unidentified', { artist: t.artist, title: t.title })
    return { appleLink: null, youtubeLink: null }
  }

  let apple: string | null = null
  let youtube: string | null = null

  if (parsed?.trackId && /^\d+$/.test(parsed.trackId)) {
    const ml = await resolveTrackMediaLinks(env, parsed.trackId, log)
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

async function lookupAppleCached(env: Env, artist: string, title: string, log: Logger): Promise<string | null> {
  const key = `am:v${CV.apple}:${await sha1Hex(`${artist}|${title}`)}`
  const cached = await getJson<{ url: string | null }>(env.CACHE, key)
  if (cached) {
    log.counters.cacheHits++
    log.info('cache.hit', { key, value: cached })
    return cached.url
  }
  log.counters.cacheMisses++
  log.info('cache.miss', { key })
  log.counters.itunesCalls++
  const url = await lookupAppleLink(artist, title, log)
  await putJson(env.CACHE, key, { url }, TTL.APPLE)
  log.info('cache.put', { key, value: { url }, ttlSeconds: TTL.APPLE })
  return url
}
