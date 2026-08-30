import type { Env, ParsedTrack } from '../types'
import { fetchTracklist, fetchMediaLinks, type MediaLinks } from './tracklists1001'
import { TTL, getJson, putJson } from './cache'
import type { Logger } from './log'

/**
 * Cache-key versions for the shared 1001tracklists resolve helpers. Every
 * cached value embeds the version of the logic that produced it
 * (`family:v<N>:…`), so bumping the number here makes stale entries from the
 * old code age out via TTL instead of being served. Bump the family whose
 * shape or semantics changed.
 *
 * These live here (not in a route file) because both `/now-playing` and
 * `/tracklist` resolve the same underlying data and must share the same cache
 * keys — a bump in one place must invalidate for both callers.
 */
export const TRACKLIST_CV = {
  tracklist: 2, // parsed tracklist page → { tracks, setAppleLink, setYoutubeLink, setSoundcloudLink }
  medialink: 1, // per-track Apple/YouTube links
} as const

export type CachedTracklist = {
  tracks: ParsedTrack[]
  setAppleLink: string | null
  setYoutubeLink: string | null
  setSoundcloudLink: string | null
}

/**
 * Scrape (or serve from cache) the full parsed tracklist for a 1001tracklists
 * tracklist URL. Cached by the URL's slug so `/now-playing` and `/tracklist`
 * share one entry. A zero-track parse (usually a transient captcha) is NOT
 * cached, so the next call retries instead of serving an empty set for the TTL.
 */
export async function resolveTracklistPage(env: Env, tracklistUrl: string, log: Logger): Promise<CachedTracklist> {
  const slug = tracklistUrl.match(/\/tracklist\/([^/]+)\//)?.[1] ?? tracklistUrl
  const key = `tl:v${TRACKLIST_CV.tracklist}:${slug}`
  // Backwards compat: older cache entries were a bare ParsedTrack[]. If we
  // hit one of those, normalize and ignore the (missing) set-level links —
  // they'll be picked up on the next refresh after TTL expires.
  const cached = await getJson<CachedTracklist | ParsedTrack[]>(env.CACHE, key)
  if (cached) {
    log.counters.cacheHits++
    if (Array.isArray(cached)) {
      log.info('cache.hit', { key, trackCount: cached.length, schema: 'legacy' })
      return { tracks: cached, setAppleLink: null, setYoutubeLink: null, setSoundcloudLink: null }
    }
    log.info('cache.hit', { key, trackCount: cached.tracks.length, setAppleLink: cached.setAppleLink })
    return cached
  }
  log.counters.cacheMisses++
  log.info('cache.miss', { key })
  const { result } = await fetchTracklist(tracklistUrl, {
    brightdataApiKey: env.BRIGHTDATA_API_KEY,
    homeProxyUrl: env.HOME_PROXY_URL,
    homeProxyToken: env.HOME_PROXY_TOKEN,
    log,
  })
  if (result.tracks.length > 0) {
    const value: CachedTracklist = {
      tracks: result.tracks,
      setAppleLink: result.setAppleLink,
      setYoutubeLink: result.setYoutubeLink,
      setSoundcloudLink: result.setSoundcloudLink,
    }
    await putJson(env.CACHE, key, value, TTL.TRACKLIST_PAGE)
    log.info('cache.put', { key, trackCount: result.tracks.length, setAppleLink: result.setAppleLink, ttlSeconds: TTL.TRACKLIST_PAGE })
    return value
  }
  log.warn('cache.skip_empty', { key, reason: 'parsed 0 tracks; likely a transient captcha — not caching' })
  return { tracks: [], setAppleLink: result.setAppleLink, setYoutubeLink: result.setYoutubeLink, setSoundcloudLink: result.setSoundcloudLink }
}

/** One track in the flattened, link-enriched output shape. */
export type TracklistTrackOut = {
  index: number
  artist: string
  title: string
  startTime: string
  startSeconds: number | null
  trackId: string | null
  trackUrl: string | null
  artworkUrl: string | null
  appleLink: string | null
  youtubeLink: string | null
  soundcloudLink: string | null
  isUnidentified: boolean
  idStatus: string | null
  isMashupLinked: boolean
  /** Whether the connected YouTube account has liked youtubeLink (filled by the routes, null here). */
  youtubeLiked: boolean | null
}

export type FullTracklist = {
  slug: string
  setAppleLink: string | null
  setYoutubeLink: string | null
  setSoundcloudLink: string | null
  tracks: TracklistTrackOut[]
}

/**
 * Scrape a tracklist and flatten it to the API/UI output shape: one object per
 * track with name, artist, id, cue timestamps and (optionally) Apple/YouTube
 * deep links. Shared by the bearer-gated `/tracklist` route and the CF
 * Access-gated `/subscriptions/api/tracklist` endpoint so both stay identical.
 *
 * Propagates IPBlockedError / CloudflareChallengeError from the scrape; a
 * zero-track parse comes back as `tracks: []` for the caller to surface.
 */
export async function resolveFullTracklist(
  env: Env,
  tracklistUrl: string,
  opts: { resolveLinks: boolean },
  log: Logger,
): Promise<FullTracklist> {
  const scraped = await resolveTracklistPage(env, tracklistUrl, log)
  const slug = tracklistUrl.match(/\/tracklist\/([^/]+)\//)?.[1] ?? tracklistUrl

  // Only rows with a numeric medialink id are eligible for link enrichment
  // (mirrors /now-playing); unidentified rows and rows keyed by a non-numeric
  // data-id are skipped. Dedupe ids so a track repeated in the set is fetched once.
  const links = new Map<string, MediaLinks>()
  if (opts.resolveLinks) {
    const ids = [...new Set(scraped.tracks.filter((t) => !t.isUnidentified && t.trackId && /^\d+$/.test(t.trackId)).map((t) => t.trackId!))]
    log.info('tracklist.links.plan', { eligible: ids.length })
    const resolved = await Promise.all(ids.map(async (id) => [id, await resolveTrackMediaLinks(env, id, log)] as const))
    for (const [id, ml] of resolved) links.set(id, ml)
  }

  const tracks: TracklistTrackOut[] = scraped.tracks.map((t, index) => {
    const ml = t.trackId ? links.get(t.trackId) : undefined
    return {
      index,
      artist: t.artist,
      title: t.title,
      startTime: t.startTime,
      startSeconds: t.startSeconds,
      trackId: t.trackId,
      trackUrl: t.trackUrl,
      artworkUrl: t.artworkUrl,
      appleLink: ml?.appleLink ?? null,
      youtubeLink: ml?.youtubeLink ?? null,
      soundcloudLink: ml?.soundcloudLink ?? null,
      isUnidentified: t.isUnidentified,
      idStatus: t.idStatus,
      isMashupLinked: t.isMashupLinked,
      youtubeLiked: null,
    }
  })

  return {
    slug,
    setAppleLink: scraped.setAppleLink,
    setYoutubeLink: scraped.setYoutubeLink,
    setSoundcloudLink: scraped.setSoundcloudLink,
    tracks,
  }
}

/**
 * Resolve (or serve from cache) the per-track Apple Music + YouTube deep links
 * for a 1001tracklists internal track id. Cached by track id.
 */
export async function resolveTrackMediaLinks(env: Env, trackId: string, log: Logger): Promise<MediaLinks> {
  const key = `ml:v${TRACKLIST_CV.medialink}:${trackId}`
  const cached = await getJson<MediaLinks>(env.CACHE, key)
  if (cached) {
    log.counters.cacheHits++
    log.info('cache.hit', { key, value: cached })
    return cached
  }
  log.counters.cacheMisses++
  log.info('cache.miss', { key })
  // medialink primary path is direct fetch; brightdata is only the timeout
  // fallback. Counter is bumped on the actual unlocker call (see lib).
  const { result } = await fetchMediaLinks(trackId, { log, brightdataApiKey: env.BRIGHTDATA_API_KEY })
  await putJson(env.CACHE, key, result, TTL.MEDIALINK)
  log.info('cache.put', { key, value: result, ttlSeconds: TTL.MEDIALINK })
  return result
}
