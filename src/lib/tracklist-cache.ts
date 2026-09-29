import type { Env, ParsedTrack } from '../types'
import { getJson, putJson } from './cache'
import type { Logger } from './log'
import { errorFields } from './log'
import { extractSetDate } from './mkvid'
import { parseTracklist, type PageRow, type ScrapedTracklist } from './tracklists1001'

/**
 * The parsed-tracklist KV cache (`tl:v<N>:<slug>`), shared by every path that
 * fetches a set page: the phone (/now-playing), /tracklist and the viewer
 * (through resolveTracklistPage), and the sync's new-set and recheck fetches
 * (through cacheTracklistFromHtml). A phone press after a sync fetch is then
 * served from here and costs no request.
 *
 * Only a page that passes the decoy check and parses to at least one track is
 * ever written. How long it lives (spec decision 19):
 *   - 3 days when every row is identified (no "ID" track, no anonymous row),
 *   - 6 hours when any row is unidentified, or the set is under 2 days old
 *     (fresh lists fill in fast).
 * A set whose date cannot be read (radio-show URLs carry none) is treated as
 * not new.
 */

/**
 * Cache-key version of the parsed tracklist page. Every cached value embeds
 * the version of the logic that produced it, so bumping it makes old entries
 * age out via TTL instead of being served.
 *   3: 2026-09-26, so the decoy pages cached before the detector existed age out.
 *   4: 2026-09-28, entries carry `rows` (anonymous "ID - ID" rows included) for /now-playing.
 *      2026-09-29: entries also carry `fetchedAt`, `ttlSeconds`, `tracklistUrl`
 *      (additive, older v4 entries still read; their age is unknown).
 */
export const TRACKLIST_CACHE_VERSION = 4

export const TRACKLIST_TTL = {
  /** Every row identified and the set at least 2 days old. */
  FULL: 60 * 60 * 24 * 3,
  /** Any unidentified row, or a set under 2 days old. */
  SHORT: 60 * 60 * 6,
} as const

/** A set younger than this is cached for the short TTL whatever its rows say. */
export const NEW_SET_AGE_SECONDS = 60 * 60 * 24 * 2

export type CachedTracklist = {
  tracks: ParsedTrack[]
  /**
   * Every page row, anonymous "ID - ID" rows included (ScrapedTracklist.rows).
   * Only /now-playing reads it, to end a track's slot where an anonymous row
   * starts. Absent on entries written before it existed.
   */
  rows?: PageRow[]
  setAppleLink: string | null
  setYoutubeLink: string | null
  setSoundcloudLink: string | null
  /** ISO time the page was fetched. Absent on entries written before 2026-09-29. */
  fetchedAt?: string
  /** TTL the entry was written with. */
  ttlSeconds?: number
  /** The tracklist URL the entry was fetched from (lets a purge by slug refetch). */
  tracklistUrl?: string
  /** Set date (YYYY-MM-DD) when one could be read, else null. */
  setDate?: string | null
}

/** 1001tracklists' short id from a tracklist URL (`/tracklist/<slug>/…`), or the input. */
export function tracklistSlug(tracklistUrl: string): string {
  return tracklistUrl.match(/\/tracklist\/([^/]+)\//)?.[1] ?? tracklistUrl
}

export function tracklistCacheKey(slug: string): string {
  return `tl:v${TRACKLIST_CACHE_VERSION}:${slug}`
}

/** Whether every row of the list is identified: no "ID" track and no anonymous row. */
export function fullyIdentified(list: { tracks: readonly ParsedTrack[]; rows?: readonly PageRow[] }): boolean {
  if (list.tracks.some((t) => t.isUnidentified)) return false
  if (list.rows?.some((r) => r.anonymous || r.isUnidentified)) return false
  return true
}

/** The TTL decision 19 gives a list. `setDate` is YYYY-MM-DD or null (unknown = not new). */
export function tracklistCacheTtl(
  list: { tracks: readonly ParsedTrack[]; rows?: readonly PageRow[] },
  setDate: string | null,
  nowMs: number = Date.now(),
): number {
  if (!fullyIdentified(list)) return TRACKLIST_TTL.SHORT
  if (setDate) {
    const t = Date.parse(`${setDate}T00:00:00Z`)
    if (Number.isFinite(t) && nowMs - t < NEW_SET_AGE_SECONDS * 1000) return TRACKLIST_TTL.SHORT
  }
  return TRACKLIST_TTL.FULL
}

/** Why a parse was not cached, or the entry that was. */
export type CacheWriteResult =
  | { cached: true; key: string; value: CachedTracklist; ttlSeconds: number }
  | { cached: false; key: string; reason: 'decoy' | 'empty' }

/**
 * Write one parsed page to the cache (the only writer of `tl:` entries).
 * Refuses a decoy page and a zero-track parse (usually a captcha shell).
 * `html`, when the caller has it, lets the set date come from the page's
 * meta/title too; otherwise only the URL is read.
 */
export async function cacheParsedTracklist(
  env: Env,
  tracklistUrl: string,
  scraped: Pick<ScrapedTracklist, 'tracks' | 'rows' | 'setAppleLink' | 'setYoutubeLink' | 'setSoundcloudLink' | 'decoy'>,
  log: Logger,
  opts: { html?: string; source?: string; nowMs?: number } = {},
): Promise<CacheWriteResult> {
  const key = tracklistCacheKey(tracklistSlug(tracklistUrl))
  if (scraped.decoy.suspected) {
    log.warn('cache.skip_decoy', { key, source: opts.source ?? null, named: scraped.decoy.named, mismatched: scraped.decoy.mismatched })
    return { cached: false, key, reason: 'decoy' }
  }
  if (scraped.tracks.length === 0) {
    log.warn('cache.skip_empty', { key, source: opts.source ?? null, reason: 'parsed 0 tracks; likely a transient captcha — not caching' })
    return { cached: false, key, reason: 'empty' }
  }
  const nowMs = opts.nowMs ?? Date.now()
  const setDate = extractSetDate(tracklistUrl, opts.html ?? '')
  const ttlSeconds = tracklistCacheTtl(scraped, setDate, nowMs)
  const value: CachedTracklist = {
    tracks: scraped.tracks,
    rows: scraped.rows,
    setAppleLink: scraped.setAppleLink,
    setYoutubeLink: scraped.setYoutubeLink,
    setSoundcloudLink: scraped.setSoundcloudLink,
    fetchedAt: new Date(nowMs).toISOString(),
    ttlSeconds,
    tracklistUrl,
    setDate,
  }
  await putJson(env.CACHE, key, value, ttlSeconds)
  log.info('cache.put', {
    key,
    source: opts.source ?? null,
    trackCount: scraped.tracks.length,
    unidentifiedCount: scraped.tracks.filter((t) => t.isUnidentified).length,
    setDate,
    ttlSeconds,
  })
  return { cached: true, key, value, ttlSeconds }
}

/**
 * Write-through for callers that fetched a set page's raw html themselves (the
 * sync's new-set and recheck loops). Parses, then caches under the same rules.
 * Best effort: never throws, so a parse problem cannot fail the caller's work.
 */
export async function cacheTracklistFromHtml(env: Env, tracklistUrl: string, html: string, log: Logger, source: string): Promise<CacheWriteResult | null> {
  if (!/\/tracklist\/[^/]+\//.test(tracklistUrl)) return null
  try {
    return await cacheParsedTracklist(env, tracklistUrl, parseTracklist(tracklistUrl, html), log, { html, source })
  } catch (e) {
    log.warn('cache.write_through_failed', { tracklistUrl, source, ...errorFields(e) })
    return null
  }
}

/** Seconds since `fetchedAt`, or null when the entry predates the stamp. */
export function cacheAgeSeconds(value: Pick<CachedTracklist, 'fetchedAt'>, nowMs: number = Date.now()): number | null {
  if (!value.fetchedAt) return null
  const t = Date.parse(value.fetchedAt)
  return Number.isFinite(t) ? Math.max(0, Math.round((nowMs - t) / 1000)) : null
}

/** The cached entry for a slug, if any. Legacy bare-array entries are normalized. */
export async function readCachedTracklist(env: Env, slug: string): Promise<CachedTracklist | undefined> {
  const cached = await getJson<CachedTracklist | ParsedTrack[]>(env.CACHE, tracklistCacheKey(slug))
  if (!cached) return undefined
  if (Array.isArray(cached)) return { tracks: cached, setAppleLink: null, setYoutubeLink: null, setSoundcloudLink: null }
  return cached
}

export async function deleteCachedTracklist(env: Env, slug: string): Promise<void> {
  await env.CACHE.delete(tracklistCacheKey(slug))
}
