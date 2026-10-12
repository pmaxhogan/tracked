/**
 * A pre-saved track that has a YouTube video is liked on the owner's account
 * (videos.rate, which is what puts it in YouTube Music's "Liked songs"), with
 * the same OAuth token the playlist sync and POST /likes use (D1 `presaves`
 * columns liked_at / like_attempts / like_error / like_next_at, migration 0020).
 *
 * A pre-save gets its video in three ways, and all of them end in one of the
 * two calls of `onPresaveResolved` in lib/presave.ts:
 *   - found at once, by the check that runs on save       (checkLinks, trigger add)
 *   - found later, by a scheduled or manual check         (checkLinks)
 *   - ripped and uploaded by mkvid                        (markPresaveUploaded)
 * The video liked is always `presaves.youtube_video_id` as that transition
 * wrote it; nothing here matches a track to a video by any other id.
 *
 * A like that fails never touches the pre-save itself: the failure is kept in
 * like_error and tried again from the 5-minute cron (`retryDuePresaveLikes`).
 * Out of quota waits for the quota day to roll over and moves every other
 * waiting like there too; a video that is gone (400 / 404), a refusal that is
 * not about quota (403) and a video the owner disliked are not tried again.
 *
 * Quota: videos.rate 50 units, videos.getRating 1 unit per 50 ids. The hook
 * and the retries call videos.rate only; the backfill asks getRating first so
 * a video already liked costs nothing more.
 *
 * Imports neither lib/presave nor lib/track-uploads (both import this).
 */

import type { Env } from '../types'
import { dbOf } from './db'
import { errorFields, makeLogger, type Logger } from './log'
import { getAppSettings } from './app-settings'
import { fetchWithTimeout } from './fetch'
import { getAccessToken } from './google-oauth'
import { getRatings, rateVideo, type Rating } from './youtube-likes'
import { isQuotaError, YouTubeApiError } from './youtube-playlists'
import { quotaDayEnd } from './mkvid'

/** Google must not hold a save or a scheduler tick: every call here is cut off after this. */
const LIKE_TIMEOUT_MS = 8000
const timedFetch: typeof fetch = (input, init) => fetchWithTimeout(input as RequestInfo, { ...(init ?? {}), timeoutMs: LIKE_TIMEOUT_MS })

/** A try is claimed for this long, so an overlapping run does not rate the same video twice. */
const CLAIM_MS = 10 * 60_000
/** A transient failure is tried again after RETRY_MS × 2^(tries − 1), at most a day. */
const RETRY_MS = 15 * 60_000
const RETRY_MAX_MS = 24 * 3600_000
/** Likes the cron retries per tick (50 units each). */
const RETRIES_PER_TICK = 2
/** videos.rate calls one backfill request makes at most (a Worker's subrequests are limited). */
export const BACKFILL_MAX_LIKES = 20
/** Pre-saves one backfill request reads: one videos.getRating call. */
const BACKFILL_PAGE = 50

/** Pre-saves the backfill covers: they have their video and no like yet. A dismissed one is left alone. */
export const RESOLVED_UNLIKED_SQL = "stage IN ('found', 'uploaded') AND youtube_video_id IS NOT NULL AND liked_at IS NULL"
/** …and were not given up on (gone / forbidden / disliked: tries made, none scheduled). */
const NOT_STOPPED_SQL = '(like_attempts = 0 OR like_next_at IS NOT NULL)'

export type LikeFailKind = 'quota' | 'transient' | 'not_connected' | 'gone' | 'forbidden' | 'disliked'
export type LikeOutcome = 'liked' | 'skipped' | LikeFailKind

/** The like columns of a `presaves` row. */
export type PresaveLikeFields = { liked_at: number | null; like_attempts: number; like_error: string | null; like_next_at: number | null }

type LikeRow = PresaveLikeFields & { id: number; stage: string; youtube_video_id: string | null }

/** The one place a YouTube error is read as "out of quota" for likes. */
export const isLikeQuotaError = (e: unknown): boolean => isQuotaError(e)

/** What a failed videos.rate means for the retry. 5xx, a timeout and a persisting 401 are transient. */
export function likeFailKind(e: unknown): LikeFailKind {
  if (isLikeQuotaError(e)) return 'quota'
  if (e instanceof YouTubeApiError) {
    if (e.status === 400 || e.status === 404) return 'gone'
    if (e.status === 403) return 'forbidden'
  }
  return 'transient'
}

/** When a failed like is tried again (unix ms); null = it is not. */
export function likeRetryAt(kind: LikeFailKind, attempts: number, now: number): number | null {
  if (kind === 'quota') return quotaDayEnd(now) * 1000
  if (kind === 'transient' || kind === 'not_connected') return now + Math.min(RETRY_MS * 2 ** Math.min(Math.max(0, attempts - 1), 20), RETRY_MAX_MS)
  return null
}

const errText = (kind: LikeFailKind, detail: string): string => `${kind}: ${detail}`.slice(0, 500)

async function likeFields(env: Env, id: number): Promise<PresaveLikeFields | null> {
  return dbOf(env).prepare('SELECT liked_at, like_attempts, like_error, like_next_at FROM presaves WHERE id = ?').bind(id).first<PresaveLikeFields>()
}

export type LikeResult = { outcome: LikeOutcome; videoId: string | null; error?: string }
type LikeOpts = { log?: Logger; now?: number; fetcher?: typeof fetch; accessToken?: string; force?: boolean }

/**
 * Like one pre-save's video. Skipped when it has none, is not found / uploaded,
 * is liked already, or another run holds the try (`force`, the backfill's,
 * ignores a retry that is not due yet). May throw on a D1 error; the callers
 * below catch.
 */
export async function likePresaveVideo(env: Env, presaveId: number, opts: LikeOpts = {}): Promise<LikeResult> {
  const log = opts.log ?? makeLogger({ task: 'presave.like', id: presaveId })
  const now = opts.now ?? Date.now()
  const fetcher = opts.fetcher ?? timedFetch
  const db = dbOf(env)
  const p = await db.prepare('SELECT id, stage, youtube_video_id, liked_at, like_attempts, like_error, like_next_at FROM presaves WHERE id = ?').bind(presaveId).first<LikeRow>()
  if (!p || !p.youtube_video_id || p.liked_at !== null || (p.stage !== 'found' && p.stage !== 'uploaded')) return { outcome: 'skipped', videoId: p?.youtube_video_id ?? null }
  const videoId = p.youtube_video_id
  const attempts = (Number(p.like_attempts) || 0) + 1

  const fail = async (kind: LikeFailKind, detail: string): Promise<LikeResult> => {
    const next = likeRetryAt(kind, attempts, now)
    const error = errText(kind, detail)
    await db.prepare('UPDATE presaves SET like_error = ?, like_next_at = ? WHERE id = ? AND liked_at IS NULL').bind(error, next, p.id).run()
    // Out of quota: every other like waiting for its retry would be refused the same way today.
    if (kind === 'quota') await db.prepare('UPDATE presaves SET like_next_at = ? WHERE liked_at IS NULL AND like_next_at IS NOT NULL AND like_next_at < ?').bind(next, next).run()
    log.warn('presave.like_failed', { id: p.id, videoId, kind, attempts, retryAt: next, detail: detail.slice(0, 300) })
    return { outcome: kind, videoId, error }
  }

  // Claimed first: the try is counted and its retry is in place before YouTube is asked.
  const claim = await db
    .prepare(`UPDATE presaves SET like_attempts = like_attempts + 1, like_next_at = ? WHERE id = ? AND youtube_video_id = ? AND liked_at IS NULL${opts.force ? '' : ' AND (like_next_at IS NULL OR like_next_at <= ?)'}`)
    .bind(...(opts.force ? [now + CLAIM_MS, p.id, videoId] : [now + CLAIM_MS, p.id, videoId, now]))
    .run()
  if ((claim.meta.changes ?? 0) === 0) return { outcome: 'skipped', videoId }

  let accessToken = opts.accessToken
  if (!accessToken) {
    try {
      const tok = await getAccessToken(env, fetcher)
      if (!tok) return await fail('not_connected', 'no YouTube account is connected')
      accessToken = tok.accessToken
    } catch (e) {
      return await fail('not_connected', `the YouTube token could not be refreshed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  try {
    await rateVideo(videoId, 'like', accessToken, fetcher)
  } catch (e) {
    return await fail(likeFailKind(e), e instanceof Error ? e.message : String(e))
  }
  await db.prepare('UPDATE presaves SET liked_at = ?, like_error = NULL, like_next_at = NULL WHERE id = ?').bind(now, p.id).run()
  log.info('presave.liked', { id: p.id, videoId, attempts })
  return { outcome: 'liked', videoId }
}

/**
 * The transition hook: a pre-save just got its YouTube video (found on
 * 1001tracklists or uploaded by mkvid). Likes it unless presave.likeOnYouTube
 * is off. Never throws and never changes anything but the like columns, which
 * it returns as they are afterwards (null when nothing was read).
 */
export async function onPresaveResolved(env: Env, presaveId: number, log?: Logger, opts: { now?: number; fetcher?: typeof fetch } = {}): Promise<PresaveLikeFields | null> {
  try {
    if (!(await getAppSettings(env)).presave.likeOnYouTube) return null
    await likePresaveVideo(env, presaveId, { log, now: opts.now, fetcher: opts.fetcher })
    return await likeFields(env, presaveId)
  } catch (e) {
    ;(log ?? makeLogger({ task: 'presave.like', id: presaveId })).warn('presave.like_threw', { id: presaveId, ...errorFields(e) })
    return null
  }
}

/**
 * The cron's part: likes whose retry is due, oldest first, a few per tick.
 * Only pre-saves a like was already tried for have a retry time, so nothing
 * that was resolved before this existed is liked from here (that is the
 * backfill's). Stops at the first out-of-quota answer. Never throws.
 */
export async function retryDuePresaveLikes(env: Env, log: Logger, opts: { now?: number; fetcher?: typeof fetch; limit?: number } = {}): Promise<{ tried: number; liked: number; stoppedBy: 'quota' | null }> {
  const out = { tried: 0, liked: 0, stoppedBy: null as 'quota' | null }
  try {
    if (!env.DB) return out
    const now = opts.now ?? Date.now()
    const due = (
      await dbOf(env)
        .prepare(`SELECT id FROM presaves WHERE like_next_at IS NOT NULL AND like_next_at <= ? AND ${RESOLVED_UNLIKED_SQL} ORDER BY like_next_at, id LIMIT ?`)
        .bind(now, opts.limit ?? RETRIES_PER_TICK)
        .all<{ id: number }>()
    ).results
    if (due.length === 0 || !(await getAppSettings(env)).presave.likeOnYouTube) return out
    for (const d of due) {
      const r = await likePresaveVideo(env, d.id, { log, now, fetcher: opts.fetcher })
      if (r.outcome === 'skipped') continue
      out.tried++
      if (r.outcome === 'liked') out.liked++
      if (r.outcome === 'quota') {
        out.stoppedBy = 'quota'
        break
      }
    }
  } catch (e) {
    log.warn('presave.like_retries_threw', errorFields(e))
  }
  return out
}

// ─── the backfill (POST /presave/like-backfill, scripts/presave-like-backfill.mjs) ───

export type LikeBackfillItem = {
  id: number
  artist: string | null
  title: string | null
  stage: string
  videoId: string
  /** videos.getRating's answer; `unknown` when it was not asked, failed, or did not name the video (deleted / private). */
  rating: Rating | 'unknown'
  action: 'would_like' | 'liked' | 'already_liked' | 'left_disliked' | 'failed' | 'not_tried'
  error?: string
}

export type LikeBackfillResult = {
  dryRun: boolean
  /** Pre-saves with a video and no like, before this request. */
  total: number
  items: LikeBackfillItem[]
  liked: number
  alreadyLiked: number
  wouldLike: number
  failed: number
  /** Quota units: `getRating` spent by this request (a dry run spends them too), `rate` spent (live) or needed (dry run). */
  units: { getRating: number; rate: number }
  /** quota: YouTube is out of quota, run again after midnight Pacific. */
  stoppedBy: 'quota' | 'not_connected' | 'error' | null
  message?: string
  /** Pass as `afterId` for the next page; null when this was the last one. */
  nextAfterId: number | null
}

export type LikeBackfillInput = { dryRun?: boolean; limit?: number; afterId?: number; includeStopped?: boolean }

/**
 * One bounded page of the backfill: up to 50 resolved pre-saves with no like,
 * by id after `afterId`. Their ratings are read with one videos.getRating
 * call; one already liked is marked liked (live) at no further cost, one the
 * owner disliked is left alone, and the rest are liked, at most `limit`
 * (default and maximum 20) per request. A dry run (the default) writes nothing
 * and likes nothing. Out of quota stops the page; a failed like is recorded
 * like the hook's and the page goes on.
 */
export async function backfillPresaveLikes(env: Env, input: LikeBackfillInput = {}, opts: { log?: Logger; now?: number; fetcher?: typeof fetch } = {}): Promise<LikeBackfillResult> {
  const log = opts.log ?? makeLogger({ task: 'presave.like_backfill' })
  const now = opts.now ?? Date.now()
  const fetcher = opts.fetcher ?? timedFetch
  const dryRun = input.dryRun !== false
  const limit = Math.min(Math.max(0, Math.floor(input.limit ?? BACKFILL_MAX_LIKES)), BACKFILL_MAX_LIKES)
  const afterId = Math.max(0, Math.floor(input.afterId ?? 0))
  const where = `${RESOLVED_UNLIKED_SQL}${input.includeStopped ? '' : ` AND ${NOT_STOPPED_SQL}`}`
  const db = dbOf(env)

  const total = Number((await db.prepare(`SELECT COUNT(*) AS n FROM presaves WHERE ${where}`).first<{ n: number }>())?.n) || 0
  const rows = (
    await db
      .prepare(`SELECT id, artist, title, stage, youtube_video_id FROM presaves WHERE ${where} AND id > ? ORDER BY id LIMIT ?`)
      .bind(afterId, BACKFILL_PAGE + 1)
      .all<{ id: number; artist: string | null; title: string | null; stage: string; youtube_video_id: string }>()
  ).results
  const more = rows.length > BACKFILL_PAGE
  const page = rows.slice(0, BACKFILL_PAGE)
  const out: LikeBackfillResult = { dryRun, total, items: [], liked: 0, alreadyLiked: 0, wouldLike: 0, failed: 0, units: { getRating: 0, rate: 0 }, stoppedBy: null, nextAfterId: null }
  const item = (r: (typeof page)[number], rating: LikeBackfillItem['rating'], action: LikeBackfillItem['action'], error?: string): LikeBackfillItem => ({
    id: r.id, artist: r.artist, title: r.title, stage: r.stage, videoId: r.youtube_video_id, rating, action, ...(error ? { error } : {}),
  })
  if (page.length === 0) return out

  // Without the ratings a dry run still lists everything, as if none were liked yet.
  const blind = (stoppedBy: LikeBackfillResult['stoppedBy'], message: string): LikeBackfillResult => {
    out.stoppedBy = stoppedBy
    out.message = message
    out.items = page.map((r) => item(r, 'unknown', dryRun ? 'would_like' : 'not_tried'))
    if (dryRun) {
      out.wouldLike = page.length
      out.units.rate = 50 * page.length
      out.nextAfterId = more ? page[page.length - 1]!.id : null
    }
    return out
  }

  let accessToken: string
  try {
    const tok = await getAccessToken(env, fetcher)
    if (!tok) return blind('not_connected', 'no YouTube account is connected')
    accessToken = tok.accessToken
  } catch (e) {
    return blind('not_connected', `the YouTube token could not be refreshed: ${e instanceof Error ? e.message : String(e)}`)
  }
  let ratings: Map<string, Rating>
  try {
    ratings = await getRatings(page.map((r) => r.youtube_video_id), accessToken, fetcher)
    out.units.getRating = 1
  } catch (e) {
    log.warn('presave.like_backfill_ratings_failed', { quota: isLikeQuotaError(e), ...errorFields(e) })
    return blind(isLikeQuotaError(e) ? 'quota' : 'error', `videos.getRating failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`)
  }

  let rated = 0
  let last = afterId
  let cut = false
  for (const r of page) {
    const rating = ratings.get(r.youtube_video_id) ?? 'unknown'
    if (rating === 'like') {
      if (!dryRun) await db.prepare('UPDATE presaves SET liked_at = ?, like_error = NULL, like_next_at = NULL WHERE id = ? AND liked_at IS NULL').bind(now, r.id).run()
      out.alreadyLiked++
      out.items.push(item(r, rating, 'already_liked'))
    } else if (rating === 'dislike') {
      // The owner's own verdict on that video: not overridden, and not asked about again.
      if (!dryRun) await db.prepare("UPDATE presaves SET like_error = ?, like_next_at = NULL, like_attempts = MAX(like_attempts, 1) WHERE id = ? AND liked_at IS NULL").bind(errText('disliked', 'disliked on YouTube; left alone'), r.id).run()
      out.items.push(item(r, rating, 'left_disliked'))
    } else if (dryRun) {
      out.wouldLike++
      out.units.rate += 50
      out.items.push(item(r, rating, 'would_like'))
    } else {
      if (rated >= limit) {
        cut = true
        break
      }
      rated++
      const res = await likePresaveVideo(env, r.id, { log, now, fetcher, accessToken, force: true })
      if (res.outcome === 'quota') {
        out.stoppedBy = 'quota'
        out.message = res.error
        out.items.push(item(r, rating, 'failed', res.error))
        out.failed++
        break
      }
      // A videos.rate call YouTube answered with an error is counted as spent too (the upper bound).
      if (res.outcome !== 'skipped') out.units.rate += 50
      if (res.outcome === 'liked') out.liked++
      else if (res.outcome !== 'skipped') out.failed++
      out.items.push(item(r, rating, res.outcome === 'liked' ? 'liked' : res.outcome === 'skipped' ? 'not_tried' : 'failed', res.error))
    }
    last = r.id
  }
  if (!out.stoppedBy) out.nextAfterId = cut || more ? last : null
  log.info('presave.like_backfill', { dryRun, total, page: page.length, liked: out.liked, alreadyLiked: out.alreadyLiked, wouldLike: out.wouldLike, failed: out.failed, stoppedBy: out.stoppedBy, units: out.units })
  return out
}
