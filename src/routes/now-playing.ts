import { createRoute, type RouteHandler } from '@hono/zod-openapi'
import { NowPlayingRequest, NowPlayingResponse, ErrorResponse } from '../schemas'
import type { Env, ParsedTrack, ResponseTrack, Status } from '../types'
import { resolveVideo, extractVideoId } from '../lib/youtube'
import { searchByYouTubeUrl, searchByTitle, DecoyTracklistError, keepRows } from '../lib/tracklists1001'
import { fetchOptsFromEnv } from '../lib/upstream1001'
import { resolveTracklistPage, resolveTrackMediaLinks, type CachedTracklist } from '../lib/tracklist-resolve'
import { lookupAppleLink } from '../lib/itunes'
import { selectCurrent } from '../lib/timestamp'
import { TTL, getJson, putJson, sha1Hex } from '../lib/cache'
import { writeNowPlayingAudit } from '../lib/now-playing-audit'
import { bearerAuth } from '../middleware/auth'
import { makeLogger, errorFields, type Logger } from '../lib/log'
import { IPBlockedError, CloudflareChallengeError } from '../lib/fetch'
import { attachYoutubeLiked } from '../lib/liked-status'
import { findMkvidUploadByTitle } from '../lib/mkvid'
import { findTracklistUrlByVideoId } from '../lib/sync-store'
import { SEARCH_URL_CV, RefreshFailedError, refreshTracklistPage, rememberVideoTracklist } from '../lib/tracklist-purge'
import { cacheAgeSeconds } from '../lib/tracklist-cache'

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

/**
 * Which signal resolved the tracklist — logged for triage. `tracked_db` is
 * tracked's own D1: a set the sync already resolved to this video (including
 * every set mkvid uploaded), answered without asking 1001tracklists.
 */
type TracklistVia = 'tracked_db' | 'youtube_url' | 'youtube_title' | 'posted_title'

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
  searchUrl: SEARCH_URL_CV, // 1001tl search by YouTube URL — v2: rejects the site's text-search fallback (multi-hyphen video ids); shared with the purge-by-video lookup
  searchTitle: 3, // 1001tl search by title — v3: dates/episode codes tokenized, query-coverage floor (v2 under-scored dated titles)
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
      // Cued anonymous "ID - ID" rows selected from alongside the named tracks,
      // and whether the current group is one — so an answer that came from an
      // anonymous row reads apart from a named "ID" row in the audit log.
      anonymousRowCount: number
      currentFromAnonymousRow: boolean
      // trackUrl/artworkUrl since 2026-09-26: they are what stays real when
      // 1001tracklists serves decoy names, so a "wrong name" report can be
      // checked against the row's id and art instead of only its name.
      currentTracks: Array<{ artist: string; title: string; startTime: string; startSeconds: number | null; trackUrl: string | null; artworkUrl: string | null }>
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
    // One D1 row (lib/now-playing-audit.ts). Runs after the response and
    // swallows its own errors: a D1 hiccup must never fail a Tasker call.
    const p = writeNowPlayingAudit(env, { reqId, record, summary }).catch((e) => log.warn('audit.write_failed', errorFields(e)))
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
  // A tracklist tracked already knows for this video, from its own D1. Set
  // when the title names an mkvid upload (below) or the video id is on a
  // synced tracklists row (phase 2); either way phase 2 skips 1001tracklists.
  let knownTracklistUrl: string | null = null
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
    // Sets mkvid uploaded are unlisted, and the YouTube Data API's search.list
    // never returns unlisted videos — so for those the search below comes back
    // empty every time (and a `null` gets cached for the title). Ask D1 first:
    // the mkvid request row has the video *and* the tracklist it was rendered
    // from, so this also settles phase 2.
    // D1 is best-effort here like every other lookup in this handler: this
    // route always answers 200 with a `status`, so a D1 hiccup must fall
    // through to the upstream path, not escape as a bare 500 with no audit row.
    let own: Awaited<ReturnType<typeof findMkvidUploadByTitle>> = null
    try {
      own = await findMkvidUploadByTitle(env, originalTitle)
    } catch (e) {
      log.warn('phase.video.mkvid_lookup_failed', { videoTitle: originalTitle, ...errorFields(e) })
    }
    if (own) {
      videoId = own.videoId
      videoUrl = watchUrl(own.videoId)
      ytMatchTitle = own.setTitle
      knownTracklistUrl = own.setUrl
      log.info('phase.video.from_mkvid_upload', { videoId, videoUrl, setUrl: own.setUrl, slug: own.slug, matchTitle: own.setTitle })
    } else {
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
    }
  } else {
    log.error('phase.video.no_input')
    return respond('no_video', {}, 'videoUrl or videoTitle is required')
  }
  audit.youtube = { videoId, videoUrl, matchTitle: ytMatchTitle, error: ytError }

  // Phase 2 (steps b→d) — find a tracklist, trying each available signal until
  // one hits: (b) the resolved YouTube URL, (c) the resolved video's title,
  // (d) the original POSTed notification title.
  //
  // Step (0) first: a video the sync has already resolved a set to — any
  // synced set, and every mkvid upload — is answered from D1. For an mkvid
  // upload this is the only way: 1001tracklists has never seen that (unlisted)
  // URL, so (b) cannot hit, and the title steps are redundant.
  if (videoId && !knownTracklistUrl) {
    try {
      knownTracklistUrl = await findTracklistUrlByVideoId(env, videoId)
    } catch (e) {
      log.warn('phase.search.known_video_lookup_failed', { videoId, ...errorFields(e) })
    }
  }
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')
  type Attempt = { via: TracklistVia; kind: 'url' | 'title'; query: string }
  const attempts: Attempt[] = []
  if (knownTracklistUrl) {
    // Already answered; recorded as an attempt (with its outcome, below) so the
    // audit trail reads the same as any other resolution.
    attempts.push({ via: 'tracked_db', kind: 'url', query: videoUrl ?? watchUrl(videoId!) })
    log.info('phase.search.attempt', { via: 'tracked_db', kind: 'url', query: attempts[0]!.query, tracklistUrl: knownTracklistUrl })
  } else {
    if (videoUrl && videoId) attempts.push({ via: 'youtube_url', kind: 'url', query: videoUrl })
    if (ytMatchTitle) attempts.push({ via: 'youtube_title', kind: 'title', query: ytMatchTitle })
    if (originalTitle && !(ytMatchTitle && norm(ytMatchTitle) === norm(originalTitle))) {
      attempts.push({ via: 'posted_title', kind: 'title', query: originalTitle })
    }
  }
  log.info('phase.search.plan', { attempts: attempts.map((a) => ({ via: a.via, query: a.query })) })
  audit.search = { attempts: attempts.map((a) => ({ via: a.via, query: a.query })), via: null, tracklistUrl: null }

  let tracklistUrl: string | null = knownTracklistUrl
  let tracklistVia: TracklistVia | null = knownTracklistUrl ? 'tracked_db' : null
  for (const a of knownTracklistUrl ? [] : attempts) {
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
  // Whatever step found it: a purge by this video id then refreshes this same list.
  if (videoId) {
    try {
      await rememberVideoTracklist(env, videoId, tracklistUrl)
    } catch (e) {
      log.warn('phase.search.remember_failed', { videoId, ...errorFields(e) })
    }
  }

  // Phase 3 — scrape the tracklist
  let parsedTracks: ParsedTrack[]
  // What the current track is picked from: the named tracks plus every
  // anonymous "ID - ID" row with a cue of its own, which ends the slot of the
  // track before it. An anonymous row without a cue cannot bound anything and
  // is left out, as all of them were before (and as they are on cache entries
  // written before `rows` existed).
  let selectable: Array<ParsedTrack & { anonymous?: boolean; rowIndex?: number; mediaId?: string | null }>
  let setAppleLink: string | null = null
  // Age of the cached list the answer comes from (`refresh: true` refetches first;
  // when that fails a kept list still answers, stale: true with refreshError).
  let cache: Res['cache'] = null
  try {
    let scraped: CachedTracklist
    if (body.refresh) {
      try {
        const r = await refreshTracklistPage(env, tracklistUrl, log)
        scraped = r.list
        cache = {
          fetchedAt: scraped.fetchedAt ?? null,
          ageSeconds: cacheAgeSeconds(scraped),
          ttlSeconds: scraped.ttlSeconds ?? null,
          refreshed: r.refreshed,
          ...(r.cooldownSeconds !== undefined ? { cooldownSeconds: r.cooldownSeconds } : {}),
          ...(r.dailyCapReached ? { dailyCapReached: true } : {}),
        }
      } catch (err) {
        const kept = err instanceof RefreshFailedError ? err.previous : undefined
        if (!kept || kept.tracks.length === 0) throw err
        // Decision 19: the phone serves from cache. The kept list answers; the error rides along.
        scraped = kept
        cache = { fetchedAt: kept.fetchedAt ?? null, ageSeconds: cacheAgeSeconds(kept), ttlSeconds: kept.ttlSeconds ?? null, refreshed: false, stale: true, refreshError: (err as Error).message.slice(0, 300) }
        log.warn('phase.scrape.refresh_failed_served_cache', { tracklistUrl, keptFetchedAt: kept.fetchedAt ?? null, error: (err as Error).message })
      }
    } else {
      scraped = await resolveTracklistPage(env, tracklistUrl, log)
      cache = { fetchedAt: scraped.fetchedAt ?? null, ageSeconds: cacheAgeSeconds(scraped), ttlSeconds: scraped.ttlSeconds ?? null, refreshed: false }
    }
    parsedTracks = scraped.tracks
    // Each row keeps its page index (rowIndex in the answer: what POST /presave names an ID row by).
    selectable = scraped.rows
      ? keepRows(scraped.rows.map((r, rowIndex) => ({ ...r, rowIndex })), (r) => !r.anonymous || (!r.isMashupLinked && r.startSeconds !== null))
      : parsedTracks
    setAppleLink = scraped.setAppleLink
  } catch (err) {
    let e = err
    if (err instanceof RefreshFailedError) {
      e = err.reason
      const kept = err.previous
      cache = { fetchedAt: kept?.fetchedAt ?? null, ageSeconds: kept ? cacheAgeSeconds(kept) : null, ttlSeconds: kept?.ttlSeconds ?? null, refreshed: false, stale: true }
      log.warn('phase.scrape.refresh_failed', { tracklistUrl, keptEntry: !!kept, keptFetchedAt: kept?.fetchedAt ?? null })
    }
    if (e instanceof IPBlockedError) {
      log.error('phase.scrape.ip_blocked', { tracklistUrl, clientIp: e.clientIp })
      return respond('upstream_error', { videoUrl, tracklistUrl, cache }, `1001 scrape: ip_blocked (${e.clientIp ?? 'unknown'})`)
    }
    if (e instanceof CloudflareChallengeError) {
      log.error('phase.scrape.cf_challenge', { tracklistUrl, errorMessage: e.message })
      return respond('upstream_error', { videoUrl, tracklistUrl, cache }, `1001 scrape: cf_challenge — ${e.message}`)
    }
    if (e instanceof DecoyTracklistError) {
      log.error('phase.scrape.decoy', { tracklistUrl, named: e.named, mismatched: e.mismatched })
      return respond('upstream_error', { videoUrl, tracklistUrl, cache }, `1001 scrape: ${e.message}`)
    }
    log.error('phase.scrape.throw', { tracklistUrl, ...errorFields(e) })
    return respond('upstream_error', { videoUrl, tracklistUrl, cache }, `1001 scrape: ${(e as Error).message}`)
  }
  log.info('phase.scrape.resolved', {
    tracklistUrl,
    trackCount: parsedTracks.length,
    unidentifiedCount: parsedTracks.filter((t) => t.isUnidentified).length,
    setAppleLink,
  })

  // Phase 4 — pick current tracks (videoDurationSeconds caps the last group's
  // duration when present; harmless to omit otherwise)
  const sel = selectCurrent(selectable, body.currentSeconds, body.videoDurationSeconds ?? null)
  const anonymousRowCount = selectable.filter((t) => t.anonymous).length
  const cued = parsedTracks.map((t) => t.startSeconds).filter((s): s is number => s !== null)
  const currentStartSeconds = sel.picked.find((t) => t.isCurrent)?.startSeconds ?? null
  audit.select = {
    currentStartSeconds,
    currentSkewSeconds: currentStartSeconds !== null ? body.currentSeconds - currentStartSeconds : null,
    trackCount: parsedTracks.length,
    unidentifiedCount: parsedTracks.filter((t) => t.isUnidentified).length,
    anonymousRowCount,
    currentFromAnonymousRow: sel.currentAnonymous,
    currentTracks: sel.picked
      .filter((t) => t.isCurrent)
      .map((t) => ({ artist: t.artist, title: t.title, startTime: t.startTime, startSeconds: t.startSeconds, trackUrl: t.trackUrl, artworkUrl: t.artworkUrl })),
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
    anonymousRowCount,
    currentFromAnonymousRow: sel.currentAnonymous,
    pickedTitles: sel.picked.map((t) => `${t.startTime} ${t.artist} - ${t.title} (${t.durationTime || '?'})${t.isCurrent ? ' *' : ''}`),
  })
  if (sel.picked.length === 0) {
    log.warn('phase.select.empty', { currentSeconds: body.currentSeconds, totalTracks: parsedTracks.length })
    return respond('no_tracklist', { videoUrl, tracklistUrl, cache })
  }

  // Phase 5 — enrich with deep links
  const enriched = await Promise.all(
    sel.picked.map(async (t) => {
      const parsed = selectable.find((p) => p.title === t.title && p.startSeconds === t.startSeconds)
      const links = await resolveLinks(env, parsed, t, log)
      // trackId / rowIndex: what POST /presave takes (an anonymous row's data-id is a page position, not a track id).
      // mediaId undefined = a list cached before the field: its trackId may be a page position, so no id (the save goes by row).
      const ids = { trackId: parsed && !parsed.anonymous ? (parsed.mediaId ?? null) : null, rowIndex: parsed?.rowIndex ?? null }
      return { ...t, ...links, ...ids } satisfies ResponseTrack & typeof ids
    }),
  )

  // Phase 6 — mark which tracks the connected YouTube account has already
  // liked (drives the filled/outlined thumbs-up in the Tasker scene). Best
  // effort: null everywhere when YouTube isn't connected or the lookup fails.
  const tracks = await attachYoutubeLiked(env, enriched, log)

  const status: Status = sel.anyUnidentified ? 'unidentified' : 'ok'
  const payload = { status, videoUrl, tracklistUrl, setAppleLink, tracks, cache } satisfies Res
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
  const { result } = await searchByYouTubeUrl(videoUrl, fetchOptsFromEnv(env, log))
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
  const { result } = await searchByTitle(title, fetchOptsFromEnv(env, log))
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
