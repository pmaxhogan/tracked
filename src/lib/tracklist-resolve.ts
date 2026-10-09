import type { Env } from '../types'
import { fetchTracklist, fetchMediaLinks, DecoyTracklistError, type MediaLinks, type FetchTracklistOpts } from './tracklists1001'
import { TTL, getJson, putJson } from './cache'
import type { Logger } from './log'
import { recordPageFacts } from './playlist-hygiene'
import type { PoolPriority } from './pool'
import { fetchOptsFromEnv } from './upstream1001'
import { MEDIALINK_CACHE_VERSION, mediaLinksCacheKey } from './medialinks-all'
import { presaveOnSetParsed } from './presave'
import type { PageRow } from './tracklists1001'
import {
  TRACKLIST_CACHE_VERSION,
  cacheAgeSeconds,
  cacheParsedTracklist,
  readCachedTracklist,
  tracklistCacheKey,
  tracklistSlug,
  type CachedTracklist,
} from './tracklist-cache'

export type { CachedTracklist } from './tracklist-cache'

/**
 * Cache-key versions for the shared 1001tracklists resolve helpers. Every
 * cached value embeds the version of the logic that produced it
 * (`family:v<N>:…`), so bumping the number here makes stale entries from the
 * old code age out via TTL instead of being served. Bump the family whose
 * shape or semantics changed.
 *
 * These live here (not in a route file) because both `/now-playing` and
 * `/tracklist` resolve the same underlying data and must share the same cache
 * keys — a bump in one place must invalidate for both callers. The tracklist
 * family's history is in lib/tracklist-cache.ts.
 */
export const TRACKLIST_CV = {
  tracklist: TRACKLIST_CACHE_VERSION, // parsed tracklist page → CachedTracklist
  medialink: MEDIALINK_CACHE_VERSION, // per-track Apple/YouTube links (lib/medialinks-all.ts writes the same key)
} as const

/** Fetch priority (spec: phone, new, verify, recheck, backfill), handed to tlpool. */
export type FetchPriority = PoolPriority

export type ResolveTracklistOpts = {
  /** Skip the cache read and fetch now (the purge path). The result is still written. */
  force?: boolean
  /** Handed to the fetch layer. Default 'phone': every caller here is a person waiting. */
  priority?: FetchPriority
}

/**
 * Scrape (or serve from cache) the full parsed tracklist for a 1001tracklists
 * tracklist URL. Cached by the URL's slug so `/now-playing` and `/tracklist`
 * share one entry, for the TTL lib/tracklist-cache.ts picks (3 days fully
 * identified, 6 hours with ID rows or a set under 2 days old). A zero-track
 * parse (usually a transient captcha) is NOT cached, so the next call retries
 * instead of serving an empty set; a decoy page throws DecoyTracklistError.
 */
export async function resolveTracklistPage(env: Env, tracklistUrl: string, log: Logger, opts: ResolveTracklistOpts = {}): Promise<CachedTracklist> {
  const slug = tracklistSlug(tracklistUrl)
  const key = tracklistCacheKey(slug)
  if (!opts.force) {
    // Older entries may be a bare ParsedTrack[]; readCachedTracklist normalizes them.
    const cached = await readCachedTracklist(env, slug)
    if (cached) {
      log.counters.cacheHits++
      log.info('cache.hit', { key, trackCount: cached.tracks.length, setAppleLink: cached.setAppleLink, ageSeconds: cacheAgeSeconds(cached), ttlSeconds: cached.ttlSeconds ?? null })
      return cached
    }
    log.counters.cacheMisses++
    log.info('cache.miss', { key })
  } else {
    log.info('cache.bypass', { key, reason: 'force' })
  }
  const fetchOpts: FetchTracklistOpts = fetchOptsFromEnv(env, log, { priority: opts.priority ?? 'phone' })
  const { result, html } = await fetchTracklist(tracklistUrl, fetchOpts)
  // The page's media facts (W6's full-recording rule reads them) from every set page fetch.
  await recordPageFacts(env, tracklistUrl, html, log)
  // With the html, the set date also comes from the page (datePublished / title), as in the sync.
  const written = await cacheParsedTracklist(env, tracklistUrl, result, log, { source: 'resolve', html })
  if (written.cached) {
    // Pre-saved ID rows of this set look for their row on the fresh page (never throws).
    await presaveOnSetParsed(env, tracklistUrl, result, log)
    return written.value
  }
  if (written.reason === 'decoy') {
    // Never cache and never serve: the names are randomized (see
    // DecoySignal). fetchTracklist already logged the details.
    throw new DecoyTracklistError(tracklistUrl, result.decoy)
  }
  return { tracks: [], setAppleLink: result.setAppleLink, setYoutubeLink: result.setYoutubeLink, setSoundcloudLink: result.setSoundcloudLink }
}

/** Most per-track link lookups one /tracklist call makes (the rest answer null links). */
export const MAX_LINK_LOOKUPS_PER_REQUEST = 25

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
  /** This track's index in `rows` (every page row); null for a cache entry older than the rows. */
  rowIndex: number | null
}

/** One page row, anonymous "ID - ID" rows included: what a pre-save of an ID row names. */
export type RowOut = {
  rowIndex: number
  /** The row's own cue (a "w/" row's printed time, else the cue it shares). */
  cueSeconds: number | null
  startTime: string
  artist: string
  title: string
  /** The medialink id; null on an anonymous row or a named one with no media id (its data-id is a page position, not a track). */
  trackId: string | null
  trackUrl: string | null
  artworkUrl: string | null
  isUnidentified: boolean
  idStatus: string | null
  isMashupLinked: boolean
  anonymous: boolean
}

export function rowsOut(rows: readonly PageRow[] | undefined): RowOut[] {
  return (rows ?? []).map((r, rowIndex) => ({
    rowIndex,
    cueSeconds: r.ownStartSeconds ?? r.startSeconds ?? null,
    startTime: r.startTime,
    artist: r.artist,
    title: r.title,
    // mediaId undefined: a list cached before the field, whose trackId may be a page position (data-id), not a track. No id.
    trackId: r.anonymous ? null : (r.mediaId ?? null),
    trackUrl: r.trackUrl,
    artworkUrl: r.artworkUrl,
    isUnidentified: r.isUnidentified,
    idStatus: r.idStatus,
    isMashupLinked: r.isMashupLinked,
    anonymous: r.anonymous,
  }))
}

/** For each of `tracks` (the named rows, in order), its index in `rows`; nulls when the entry has no rows. */
export function trackRowIndexes(trackCount: number, rows: readonly PageRow[] | undefined): Array<number | null> {
  const named: number[] = []
  rows?.forEach((r, i) => {
    if (!r.anonymous) named.push(i)
  })
  return Array.from({ length: trackCount }, (_, k) => (rows && named.length === trackCount ? named[k]! : null))
}

export type FullTracklist = {
  slug: string
  setAppleLink: string | null
  setYoutubeLink: string | null
  setSoundcloudLink: string | null
  tracks: TracklistTrackOut[]
  /** Every page row, anonymous ones included ([] for a cache entry older than the rows). */
  rows: RowOut[]
  /** When the list was fetched from 1001tracklists (ISO), null for an entry older than the stamp. */
  fetchedAt: string | null
  /** Seconds since fetchedAt, null when unknown. */
  cacheAgeSeconds: number | null
}

/**
 * Scrape a tracklist and flatten it to the API/UI output shape: one object per
 * track with name, artist, id, cue timestamps and (optionally) Apple/YouTube
 * deep links. Shared by the bearer-gated `/tracklist` route and the CF
 * Access-gated `/ui/api/tracklist` endpoint so both stay identical.
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
  const slug = tracklistSlug(tracklistUrl)

  // Only rows with a numeric medialink id are eligible for link enrichment
  // (mirrors /now-playing); unidentified rows and rows keyed by a non-numeric
  // data-id are skipped. Dedupe ids so a track repeated in the set is fetched once.
  const links = new Map<string, MediaLinks>()
  if (opts.resolveLinks) {
    const ids = [...new Set(scraped.tracks.filter((t) => !t.isUnidentified && t.trackId && /^\d+$/.test(t.trackId)).map((t) => t.trackId!))]
    const planned = ids.slice(0, MAX_LINK_LOOKUPS_PER_REQUEST)
    log.info('tracklist.links.plan', { eligible: ids.length, planned: planned.length })
    // One at a time, never a burst of pool fetches (review W4 #4); cached ids cost nothing.
    for (const id of planned) {
      try {
        links.set(id, await resolveTrackMediaLinks(env, id, log))
      } catch (e) {
        log.warn('tracklist.links.stopped', { done: links.size, planned: planned.length, error: (e as Error).message })
        break
      }
    }
  }

  const rowIdx = trackRowIndexes(scraped.tracks.length, scraped.rows)
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
      rowIndex: rowIdx[index] ?? null,
    }
  })

  return {
    slug,
    setAppleLink: scraped.setAppleLink,
    setYoutubeLink: scraped.setYoutubeLink,
    setSoundcloudLink: scraped.setSoundcloudLink,
    tracks,
    rows: rowsOut(scraped.rows),
    fetchedAt: scraped.fetchedAt ?? null,
    cacheAgeSeconds: cacheAgeSeconds(scraped),
  }
}

/**
 * Resolve (or serve from cache) the per-track Apple Music + YouTube deep links
 * for a 1001tracklists internal track id. Cached by track id for 30 days
 * (TTL.MEDIALINK): one budgeted pool page view per track per month at most.
 * `priority` is `phone` for /now-playing, `recheck` for the admin viewer's
 * lazy per-row lookups (nobody on the road is waiting on those).
 */
export async function resolveTrackMediaLinks(env: Env, trackId: string, log: Logger, priority: FetchPriority = 'phone'): Promise<MediaLinks> {
  const key = mediaLinksCacheKey(trackId)
  const cached = await getJson<MediaLinks>(env.CACHE, key)
  if (cached) {
    log.counters.cacheHits++
    log.info('cache.hit', { key, value: cached })
    return cached
  }
  log.counters.cacheMisses++
  log.info('cache.miss', { key })
  // Through the pool (kind medialink, one budgeted view per call). A failed
  // lookup is not cached, so a pool refusal cannot poison the entry.
  const { result, failed } = await fetchMediaLinks(trackId, fetchOptsFromEnv(env, log, { priority }))
  if (failed) return result
  await putJson(env.CACHE, key, result, TTL.MEDIALINK)
  log.info('cache.put', { key, value: result, ttlSeconds: TTL.MEDIALINK })
  return result
}
