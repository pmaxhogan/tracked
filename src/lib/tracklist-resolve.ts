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
  tracklist: 1, // parsed tracklist page → { tracks, setAppleLink }
  medialink: 1, // per-track Apple/YouTube links
} as const

export type CachedTracklist = { tracks: ParsedTrack[]; setAppleLink: string | null }

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
  // hit one of those, normalize and ignore the (missing) setAppleLink — it'll
  // be picked up on the next refresh after TTL expires.
  const cached = await getJson<CachedTracklist | ParsedTrack[]>(env.CACHE, key)
  if (cached) {
    log.counters.cacheHits++
    if (Array.isArray(cached)) {
      log.info('cache.hit', { key, trackCount: cached.length, schema: 'legacy' })
      return { tracks: cached, setAppleLink: null }
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
    const value: CachedTracklist = { tracks: result.tracks, setAppleLink: result.setAppleLink }
    await putJson(env.CACHE, key, value, TTL.TRACKLIST_PAGE)
    log.info('cache.put', { key, trackCount: result.tracks.length, setAppleLink: result.setAppleLink, ttlSeconds: TTL.TRACKLIST_PAGE })
    return value
  }
  log.warn('cache.skip_empty', { key, reason: 'parsed 0 tracks; likely a transient captcha — not caching' })
  return { tracks: [], setAppleLink: result.setAppleLink }
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
