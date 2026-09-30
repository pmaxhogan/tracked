import type { Env } from '../types'
import { dbOf } from './db'
import { IPBlockedError, CloudflareChallengeError } from './fetch'
import { errorFields, type Logger } from './log'
import { getJson, putJson } from './cache'
import { getPoolSettings } from './pool-settings'
import { findTracklistUrlByVideoId } from './sync-store'
import { DecoyTracklistError, normalizeTracklistUrl } from './tracklists1001'
import { readCachedTracklist, tracklistCacheKey, tracklistSlug, type CachedTracklist } from './tracklist-cache'
import { resolveTracklistPage } from './tracklist-resolve'
import { UpstreamHttpError, UpstreamPausedError, UpstreamUnavailableError } from './upstream1001'
import { extractVideoId } from './youtube'

/**
 * Purge one parsed tracklist from the cache and fetch it again right away at
 * priority `phone` (spec decision 20). Behind `POST /tracklist/purge` (bearer),
 * `POST /ui/api/tracklist/purge` (Access, the viewer's "Refresh
 * track list" button) and `/now-playing` with `refresh: true`.
 *
 * The refetch happens first, bypassing the cache read; only a clean,
 * non-empty parse replaces the cached entry. When it fails (paused, budget,
 * challenge, decoy, timeout) the old entry is KEPT, still served, and the
 * answer says so: `stale: true` with the kept entry's `fetchedAt`.
 */

/**
 * Cache version of /now-playing's "1001tl search by YouTube URL" entries
 * (`s1001:v<N>:<videoId>`). Lives here so a purge by video id can read the same
 * key the phone path wrote. v2: rejects the site's text-search fallback.
 */
export const SEARCH_URL_CV = 2

export const searchByUrlCacheKey = (videoId: string) => `s1001:v${SEARCH_URL_CV}:${videoId}`

/**
 * Every YouTube video /now-playing resolved to a set, whichever step found it
 * (the synced set, the 1001tl URL search or a title search), for 30 days:
 * `tlv:v1:<videoId>` → `{ tracklistUrl }`. A purge by video id reads it, so it
 * refreshes exactly the list the phone showed.
 */
export const videoTracklistKey = (videoId: string) => `tlv:v1:${videoId}`
const VIDEO_TRACKLIST_TTL = 30 * 86400

export async function rememberVideoTracklist(env: Env, videoId: string, tracklistUrl: string): Promise<void> {
  await putJson(env.CACHE, videoTracklistKey(videoId), { tracklistUrl }, VIDEO_TRACKLIST_TTL)
}

/** Exactly one of these names the tracklist to purge. */
export type PurgeTarget = { url?: string; slug?: string; videoId?: string }

export type ResolvedTarget =
  | { ok: true; tracklistUrl: string; via: 'url' | 'slug' | 'video' }
  | { ok: false; status: 400 | 404; error: string; message: string }

const SLUG_RE = /^[a-z0-9]{4,16}$/i

/**
 * Turn the caller's identifier into a tracklist URL, from what tracked already
 * knows: a slug through the cached entry or D1, a YouTube video through the
 * set the sync resolved it to (D1, mkvid uploads included), else the set
 * /now-playing last resolved it to (any search step), else the phone's cached
 * 1001tl URL search. Nothing here asks 1001tracklists: an unknown slug or
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
    const fromPhone = fromDb ? null : (await getJson<{ tracklistUrl: string | null }>(env.CACHE, videoTracklistKey(videoId)))?.tracklistUrl
    const fromSearch = fromDb || fromPhone ? null : (await getJson<{ tracklistUrl: string | null }>(env.CACHE, searchByUrlCacheKey(videoId)))?.tracklistUrl
    const tracklistUrl = normalizeTracklistUrl(fromDb ?? fromPhone ?? fromSearch ?? '')
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
  /** False when the refetch was skipped (cooldown or daily cap) and the cached list answered. */
  refreshed: boolean
  /** Set when skipped by the per-set cooldown: seconds until a refetch of this set is allowed. */
  cooldownSeconds?: number
  /** Set when skipped because today's forced refetches are used up. */
  dailyCapReached?: boolean
}

export type PurgeResult =
  | { ok: true; summary: PurgeSummary }
  | {
      ok: false
      status: 404 | 502 | 503
      error: string
      message: string
      tracklistUrl: string
      /** True when an older cached list was kept (and is still served). */
      stale: boolean
      /** That kept entry's fetchedAt (null when none, or it predates the stamp). */
      fetchedAt: string | null
    }

/**
 * An upstream failure as the HTTP answer the purge routes give. A real 404/410
 * is the URL's own answer; a pause is 503 (retry later); the rest is 502.
 */
export function describeFetchError(e: unknown): { status: 404 | 502 | 503; error: string; message: string } {
  if (e instanceof EmptyParseError) return { status: 502, error: 'upstream_error', message: e.message }
  if (e instanceof UpstreamHttpError) return { status: 404, error: 'not_found', message: e.message }
  if (e instanceof UpstreamPausedError) return { status: 503, error: 'paused', message: e.message }
  if (e instanceof IPBlockedError) return { status: 502, error: 'upstream_error', message: `1001 scrape: ip_blocked (${e.clientIp ?? 'unknown'})` }
  if (e instanceof CloudflareChallengeError) return { status: 502, error: 'upstream_error', message: `1001 scrape: cf_challenge — ${e.message}` }
  if (e instanceof DecoyTracklistError) return { status: 502, error: 'decoy', message: `1001 scrape: ${e.message}` }
  if (e instanceof UpstreamUnavailableError) return { status: 502, error: 'upstream_error', message: e.message }
  return { status: 502, error: 'upstream_error', message: `1001 scrape: ${e instanceof Error ? e.message : String(e)}` }
}

/** The refetch parsed zero tracks (usually a captcha shell). Nothing was written. */
export class EmptyParseError extends Error {
  constructor() {
    super('parsed 0 tracks (likely a transient captcha) — try again shortly')
    this.name = 'EmptyParseError'
  }
}

/**
 * A refresh whose refetch failed. `previous` is the cached entry that was kept
 * (undefined when there was none); `reason` is what the fetch threw.
 */
export class RefreshFailedError extends Error {
  readonly reason: unknown
  readonly previous: CachedTracklist | undefined
  constructor(reason: unknown, previous: CachedTracklist | undefined) {
    super(reason instanceof Error ? reason.message : String(reason))
    this.name = 'RefreshFailedError'
    this.reason = reason
    this.previous = previous
  }
}

export type RefreshResult = {
  list: CachedTracklist
  /** False when the refetch was skipped and `list` is the cached one (or a plain cached read). */
  refreshed: boolean
  cooldownSeconds?: number
  dailyCapReached?: boolean
}

const cooldownKey = (slug: string) => `tlrefresh:v1:${slug}`
const dayKey = (nowMs: number) => `tlrefresh:v1:day:${new Date(nowMs).toISOString().slice(0, 10)}`

/**
 * Fetch the list for `tracklistUrl` again now at priority phone, bypassing the
 * cache read. Success replaces the cached entry. Any failure (paused, blocked,
 * challenge, decoy, empty parse, timeout) KEEPS the old entry and throws
 * RefreshFailedError carrying it. /now-playing's `refresh: true` uses this.
 *
 * Limits (pool settings `forcedRefetch`, review W5 #1): a second forced
 * refetch of the same set within the cooldown, or any beyond the daily cap,
 * is not made; the cached list answers (`refreshed: false` plus
 * `cooldownSeconds` or `dailyCapReached`), or a plain cached read when there
 * is none.
 */
export async function refreshTracklistPage(env: Env, tracklistUrl: string, log: Logger, opts: { nowMs?: number } = {}): Promise<RefreshResult> {
  const nowMs = opts.nowMs ?? Date.now()
  const slug = tracklistSlug(tracklistUrl)
  const previous = await readCachedTracklist(env, slug)
  const { forcedRefetch } = await getPoolSettings(env)
  const lastAt = Number((await env.CACHE.get(cooldownKey(slug))) ?? 0) || 0
  const left = lastAt ? Math.ceil(lastAt / 1000 + forcedRefetch.cooldownSeconds - nowMs / 1000) : 0
  const usedToday = Number((await env.CACHE.get(dayKey(nowMs))) ?? 0) || 0
  const skip: Pick<RefreshResult, 'cooldownSeconds' | 'dailyCapReached'> | null =
    left > 0 ? { cooldownSeconds: left } : usedToday >= forcedRefetch.dailyCap ? { dailyCapReached: true } : null
  if (skip) {
    log.warn('tracklist.refresh_skipped', { tracklistUrl, ...skip, usedToday, hadEntry: !!previous })
    const list = previous && previous.tracks.length > 0 ? previous : await resolveTracklistPage(env, tracklistUrl, log, { priority: 'phone' })
    return { list, refreshed: false, ...skip }
  }
  // Counted before the fetch: a failed refetch still spent a page view.
  await env.CACHE.put(cooldownKey(slug), String(nowMs), { expirationTtl: Math.max(60, forcedRefetch.cooldownSeconds) })
  await env.CACHE.put(dayKey(nowMs), String(usedToday + 1), { expirationTtl: 2 * 86400 })
  log.info('tracklist.refresh', { key: tracklistCacheKey(slug), tracklistUrl, hadEntry: !!previous, previousFetchedAt: previous?.fetchedAt ?? null, usedToday: usedToday + 1 })
  let fresh: CachedTracklist
  try {
    // Writes the entry only for a clean, non-empty parse (cacheParsedTracklist),
    // so a decoy or empty page never replaces a good entry.
    fresh = await resolveTracklistPage(env, tracklistUrl, log, { force: true, priority: 'phone' })
  } catch (e) {
    throw new RefreshFailedError(e, previous)
  }
  if (fresh.tracks.length === 0) throw new RefreshFailedError(new EmptyParseError(), previous)
  return { list: fresh, refreshed: true }
}

/** Refresh, summarized for the purge routes; a failure becomes an HTTP answer with the kept entry's age. */
export async function purgeAndRefetch(env: Env, tracklistUrl: string, log: Logger): Promise<PurgeResult> {
  const slug = tracklistSlug(tracklistUrl)
  try {
    const r = await refreshTracklistPage(env, tracklistUrl, log)
    const fresh = r.list
    const summary: PurgeSummary = {
      tracklistUrl,
      slug,
      rowCount: fresh.rows?.length ?? fresh.tracks.length,
      trackCount: fresh.tracks.length,
      identifiedCount: fresh.tracks.filter((t) => !t.isUnidentified).length,
      fetchedAt: fresh.fetchedAt ?? null,
      ttlSeconds: fresh.ttlSeconds ?? null,
      refreshed: r.refreshed,
      ...(r.cooldownSeconds !== undefined ? { cooldownSeconds: r.cooldownSeconds } : {}),
      ...(r.dailyCapReached ? { dailyCapReached: true } : {}),
    }
    log.info('tracklist.purge.done', { ...summary })
    return { ok: true, summary }
  } catch (e) {
    const reason = e instanceof RefreshFailedError ? e.reason : e
    const previous = e instanceof RefreshFailedError ? e.previous : undefined
    const d = describeFetchError(reason)
    const stale = !!previous && previous.tracks.length > 0
    log.error('tracklist.purge.failed', { tracklistUrl, status: d.status, error: d.error, stale, ...errorFields(reason) })
    return { ok: false, ...d, tracklistUrl, stale, fetchedAt: stale ? (previous!.fetchedAt ?? null) : null }
  }
}
