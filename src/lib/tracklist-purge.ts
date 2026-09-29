import type { Env } from '../types'
import { dbOf } from './db'
import { IPBlockedError, CloudflareChallengeError } from './fetch'
import { errorFields, type Logger } from './log'
import { getJson } from './cache'
import { findTracklistUrlByVideoId } from './sync-store'
import { DecoyTracklistError, normalizeTracklistUrl } from './tracklists1001'
import { deleteCachedTracklist, readCachedTracklist, tracklistCacheKey, tracklistSlug, type CachedTracklist } from './tracklist-cache'
import { resolveTracklistPage } from './tracklist-resolve'
import { UpstreamHttpError, UpstreamPausedError, UpstreamUnavailableError } from './upstream1001'
import { extractVideoId } from './youtube'

/**
 * Purge one parsed tracklist from the cache and fetch it again right away at
 * priority `phone` (spec decision 20). Behind `POST /tracklist/purge` (bearer),
 * `POST /subscriptions/api/tracklist/purge` (Access, the viewer's "Refresh
 * track list" button) and `/now-playing` with `refresh: true`.
 *
 * The entry is deleted BEFORE the refetch, so a refetch that fails leaves the
 * cache empty and the next read fetches again; a stale list is never kept
 * around as a fallback.
 */

/**
 * Cache version of /now-playing's "1001tl search by YouTube URL" entries
 * (`s1001:v<N>:<videoId>`). Lives here so a purge by video id can read the same
 * key the phone path wrote. v2: rejects the site's text-search fallback.
 */
export const SEARCH_URL_CV = 2

export const searchByUrlCacheKey = (videoId: string) => `s1001:v${SEARCH_URL_CV}:${videoId}`

/** Exactly one of these names the tracklist to purge. */
export type PurgeTarget = { url?: string; slug?: string; videoId?: string }

export type ResolvedTarget =
  | { ok: true; tracklistUrl: string; via: 'url' | 'slug' | 'video' }
  | { ok: false; status: 400 | 404; error: string; message: string }

const SLUG_RE = /^[a-z0-9]{4,16}$/i

/**
 * Turn the caller's identifier into a tracklist URL, from what tracked already
 * knows: a slug through the cached entry or D1, a YouTube video through the
 * set the sync resolved it to (D1, mkvid uploads included) or the phone's
 * cached 1001tl search. Nothing here asks 1001tracklists: an unknown slug or
 * video is a 404, not a guess at a URL.
 */
export async function resolvePurgeTarget(env: Env, t: PurgeTarget): Promise<ResolvedTarget> {
  if (t.url) {
    const tracklistUrl = normalizeTracklistUrl(t.url)
    if (!tracklistUrl) return { ok: false, status: 400, error: 'invalid_url', message: 'not a 1001tracklists tracklist URL' }
    return { ok: true, tracklistUrl, via: 'url' }
  }
  if (t.slug) {
    const slug = t.slug.trim()
    if (!SLUG_RE.test(slug)) return { ok: false, status: 400, error: 'invalid_slug', message: 'a tracklist slug is the short id in /tracklist/<slug>/…' }
    const fromCache = (await readCachedTracklist(env, slug))?.tracklistUrl
    if (fromCache) return { ok: true, tracklistUrl: fromCache, via: 'slug' }
    const like = `%/tracklist/${slug}/%`
    const db = dbOf(env)
    const row =
      (await db.prepare('SELECT url FROM tracklists WHERE url LIKE ? LIMIT 1').bind(like).first<{ url: string }>()) ??
      (await db.prepare('SELECT set_url AS url FROM mkvid_requests WHERE set_url LIKE ? LIMIT 1').bind(like).first<{ url: string }>())
    const tracklistUrl = row ? normalizeTracklistUrl(row.url) : null
    if (tracklistUrl) return { ok: true, tracklistUrl, via: 'slug' }
    return { ok: false, status: 404, error: 'unknown_slug', message: `no known tracklist for slug ${slug} — pass the full tracklist URL instead` }
  }
  if (t.videoId) {
    const videoId = extractVideoId(t.videoId)
    if (!videoId) return { ok: false, status: 400, error: 'invalid_video', message: 'not a YouTube video id or URL' }
    const fromDb = await findTracklistUrlByVideoId(env, videoId)
    const fromSearch = fromDb ? null : (await getJson<{ tracklistUrl: string | null }>(env.CACHE, searchByUrlCacheKey(videoId)))?.tracklistUrl
    const tracklistUrl = normalizeTracklistUrl(fromDb ?? fromSearch ?? '')
    if (tracklistUrl) return { ok: true, tracklistUrl, via: 'video' }
    return { ok: false, status: 404, error: 'unknown_video', message: `no known tracklist for YouTube video ${videoId}` }
  }
  return { ok: false, status: 400, error: 'invalid_request', message: 'one of url, slug or videoId is required' }
}

export type PurgeSummary = {
  tracklistUrl: string
  slug: string
  /** Every page row, anonymous "ID - ID" rows included. */
  rowCount: number
  /** Named rows (what /tracklist returns). */
  trackCount: number
  /** Named rows that are not "ID". */
  identifiedCount: number
  fetchedAt: string | null
  /** How long the fresh entry is cached; null when it was not cached (empty parse). */
  ttlSeconds: number | null
}

export type PurgeResult =
  | { ok: true; summary: PurgeSummary }
  | { ok: false; status: 404 | 502 | 503; error: string; message: string; tracklistUrl: string }

/**
 * An upstream failure as the HTTP answer the purge routes give. A real 404/410
 * is the URL's own answer; a pause is 503 (retry later); the rest is 502.
 */
export function describeFetchError(e: unknown): { status: 404 | 502 | 503; error: string; message: string } {
  if (e instanceof UpstreamHttpError) return { status: 404, error: 'not_found', message: e.message }
  if (e instanceof UpstreamPausedError) return { status: 503, error: 'paused', message: e.message }
  if (e instanceof IPBlockedError) return { status: 502, error: 'upstream_error', message: `1001 scrape: ip_blocked (${e.clientIp ?? 'unknown'})` }
  if (e instanceof CloudflareChallengeError) return { status: 502, error: 'upstream_error', message: `1001 scrape: cf_challenge — ${e.message}` }
  if (e instanceof DecoyTracklistError) return { status: 502, error: 'decoy', message: `1001 scrape: ${e.message}` }
  if (e instanceof UpstreamUnavailableError) return { status: 502, error: 'upstream_error', message: e.message }
  return { status: 502, error: 'upstream_error', message: `1001 scrape: ${e instanceof Error ? e.message : String(e)}` }
}

/**
 * Delete the cached list for `tracklistUrl` and fetch it again now at priority
 * phone. Returns the fresh list (written back to the cache unless empty);
 * throws what the fetch throws. /now-playing's `refresh: true` uses this.
 */
export async function refreshTracklistPage(env: Env, tracklistUrl: string, log: Logger): Promise<CachedTracklist> {
  const slug = tracklistSlug(tracklistUrl)
  await deleteCachedTracklist(env, slug)
  log.info('tracklist.purge', { key: tracklistCacheKey(slug), tracklistUrl })
  return resolveTracklistPage(env, tracklistUrl, log, { force: true, priority: 'phone' })
}

/** Purge + refetch, summarized for the purge routes; failures become an HTTP answer. */
export async function purgeAndRefetch(env: Env, tracklistUrl: string, log: Logger): Promise<PurgeResult> {
  const slug = tracklistSlug(tracklistUrl)
  try {
    const fresh = await refreshTracklistPage(env, tracklistUrl, log)
    if (fresh.tracks.length === 0) {
      log.warn('tracklist.purge.empty', { tracklistUrl })
      return { ok: false, status: 502, error: 'upstream_error', message: 'parsed 0 tracks (likely a transient captcha) — try again shortly', tracklistUrl }
    }
    const summary: PurgeSummary = {
      tracklistUrl,
      slug,
      rowCount: fresh.rows?.length ?? fresh.tracks.length,
      trackCount: fresh.tracks.length,
      identifiedCount: fresh.tracks.filter((t) => !t.isUnidentified).length,
      fetchedAt: fresh.fetchedAt ?? null,
      ttlSeconds: fresh.ttlSeconds ?? null,
    }
    log.info('tracklist.purge.done', { ...summary })
    return { ok: true, summary }
  } catch (e) {
    const d = describeFetchError(e)
    log.error('tracklist.purge.failed', { tracklistUrl, status: d.status, error: d.error, ...errorFields(e) })
    return { ok: false, ...d, tracklistUrl }
  }
}
