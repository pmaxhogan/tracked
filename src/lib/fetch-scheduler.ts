/**
 * The fetch scheduler: decides WHAT is due from 1001tracklists and in which
 * order, and hands it to tlpool a little at a time (quest decisions 10-13).
 *
 * The 5-minute cron is only a heartbeat. Each tick submits a small random
 * number of items (`tick.minItems..maxItems`, default 0-3), highest class
 * first (`priorities.order`, default new → verify → recheck → backfill), and
 * stops at the first refusal — `budget_exhausted` is normal and simply ends
 * the tick (with a KV backoff when the pool says how long). tlpool owns the
 * budget, the pacing and which account serves each fetch.
 *
 * What can be due:
 *   - new          a DJ's listing page (discovery, once a day ± jitter per DJ,
 *                  spread around the clock) and never-fetched sets up to
 *                  `newSetMaxAgeDays` old
 *   - verify       the second fetch of a pending verification (lib/verification.ts),
 *                  then the render feeder: the FIRST fetch of a set mkvid is
 *                  waiting on that has no verified list and no verification
 *                  started (oldest request first, `renderFeedPerDay` a UTC
 *                  day, paced across the day, one per tick at most; each set
 *                  cools down 2 d after a feed fetch, longer after failures,
 *                  and is given up after 3 failures: D1 `render_feed`)
 *   - recheck      a processed set whose `set_schedule.next_due_at` passed
 *                  (pace by set age, lib/pool-settings.ts `recheckIntervalSeconds`)
 *   - backfill     never-fetched older sets, and one "older sets" step of a DJ
 *                  whose history is incomplete (the paced DJ backfill)
 *
 * Set pages still go through `syncOne` (lib/sync.ts) — playlist inserts,
 * swaps, mkvid queueing all stay there — with an explicit selection instead
 * of its own todo/recheck windows.
 *
 * Spreading: schedule rows are created lazily here. A set whose natural due
 * time already passed (every set, after the pause) gets a random due time
 * inside one interval, so the ~2,100 known sets come due gradually; every
 * later interval is jittered by ±`recheck.jitterFraction`.
 */

import type { Env } from '../types'
import { dbOf } from './db'
import { djScrollStep, type DjCrawlResult } from './dj-index'
import { getAccessToken } from './google-oauth'
import { errorFields, makeLogger, type Logger } from './log'
import { poolConfigFromEnv, type PoolConfig, type PoolPriority } from './pool'
import {
  firstFetchClass,
  getPoolSettings,
  jitter,
  recheckIntervalSeconds,
  setAgeDays,
  setDateFromUrl,
  type PoolSettings,
  type ScheduledClass,
} from './pool-settings'
import { isPaused } from './ban-state'
import { listSubscriptions, type Subscription } from './subscriptions'
import { loadDjBackfill, loadSubState, saveDjBackfill, saveSubState } from './sync-store'
import { parseTracklist, type ScrapedTracklist } from './tracklists1001'
import { fetchOptsFromEnv, isStopTheBatchError } from './upstream1001'
import { deferVerification, dueVerifications, noteSetFetch, type VerificationResult } from './verification'
import { syncOne, type SyncOneResult } from './sync'
import { queueSearchIndex } from './search/index'
import { MKVID_MAX_ATTEMPTS } from './mkvid'
import { DISCOVERED_SQL, ID_WAIT_SECONDS } from './mkvid-readiness'

const nowSeconds = () => Math.floor(Date.now() / 1000)
const HOUR = 3600

/** A recheck/verify claimed by a tick waits this long before it can be picked again if the fetch fails. */
const CLAIM_RECHECK_SECONDS = 6 * HOUR
const CLAIM_VERIFY_SECONDS = 2 * HOUR
/** KV key (CACHE) holding the time before which ticks stand down, set from the pool's retryAfterSeconds. */
export const TICK_BACKOFF_KEY = 'pool:tick_backoff_until'
const MAX_BACKOFF_SECONDS = 6 * HOUR
/** Schedule rows created per tick at most (the first ticks after launch spread the backlog in a few passes). */
const INIT_BATCH = 500
/** An overdue set with a pending mkvid request is spread over at most this, not its whole interval (its render waits on verification). */
const MKVID_WAITING_SPREAD_SECONDS = 2 * 24 * HOUR
/** A discovery / backfill step that did not complete is retried after about this long, not a whole interval later. */
const DJ_RETRY_SECONDS = HOUR
/** CACHE KV: when ensureSetSchedules last ran (unix seconds). */
export const ENSURE_STAMP_KEY = 'scheduler:ensure_at'
/** The render feeder submits at most this many first fetches per tick. */
export const RENDER_FEED_MAX_PER_TICK = 1
/**
 * A set fetched this recently (by anything) is not fed; a set the feeder fed
 * is not fed again for this long whatever the outcome, doubling after each
 * failed feed fetch up to RENDER_FEED_MAX_COOLDOWN_SECONDS.
 */
export const RENDER_FEED_REFETCH_COOLDOWN_SECONDS = 2 * 24 * HOUR
export const RENDER_FEED_MAX_COOLDOWN_SECONDS = 14 * 24 * HOUR
/** After this many feed fetches in a row fail (404, 5xx), the feeder gives the set up. */
export const RENDER_FEED_MAX_FAILURES = 3
/** CACHE KV: the feeder found no candidate; the query is not run again before this (unix seconds). */
export const RENDER_FEED_EMPTY_KEY = 'scheduler:render_feed_empty_until'
const RENDER_FEED_EMPTY_SECONDS = 30 * 60

// ─── set schedules ──────────────────────────────────────────────────────────

/**
 * Create `set_schedule` rows for processed sets that have none, spreading
 * overdue ones at random across one interval. A set older than the last age
 * band whose ID rows are unknown is scheduled as if it had some (the 90-day
 * exception) until its first fetch tells.
 */
export async function ensureSetSchedules(env: Env, settings: PoolSettings, nowSec = nowSeconds(), random: () => number = Math.random, limit = INIT_BATCH): Promise<number> {
  const db = dbOf(env)
  const res = await db
    .prepare(
      `SELECT t.url AS url, MIN(COALESCE(t.checked_at, 0)) AS checked_at,
              MAX(CASE WHEN t.video_known = 1 AND t.video_id IS NULL THEN 1 ELSE 0 END) AS no_video,
              EXISTS (SELECT 1 FROM mkvid_requests m WHERE m.set_url = t.url AND m.status IN ('pending', 'claimed')) AS mkvid_waiting
         FROM tracklists t LEFT JOIN set_schedule s ON s.url = t.url
        WHERE t.processed = 1 AND t.abandoned = 0 AND s.url IS NULL AND t.slug IN (SELECT slug FROM subscriptions)
        GROUP BY t.url LIMIT ?`,
    )
    .bind(limit)
    .all<{ url: string; checked_at: number; no_video: number; mkvid_waiting: number }>()
  if (res.results.length === 0) return 0
  const insert = db.prepare(
    `INSERT OR IGNORE INTO set_schedule (url, set_date, next_due_at, last_fetched_at, has_id_rows, no_good_video, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
  )
  const statements = res.results.map((r) => {
    const setDate = setDateFromUrl(r.url)
    const interval = recheckIntervalSeconds(settings, setAgeDays(setDate, nowSec), { noGoodVideo: Number(r.no_video) === 1, hasIdRows: true })
    let next: number | null = null
    if (interval !== null) {
      const checked = Number(r.checked_at) || 0
      const natural = checked + jitter(interval, settings.recheck.jitterFraction, random)
      // Overdue: somewhere inside one interval - or within two days for a set
      // mkvid is waiting on, whose render needs a verified list first.
      const spread = Number(r.mkvid_waiting) === 1 ? Math.min(interval, MKVID_WAITING_SPREAD_SECONDS) : interval
      next = natural > nowSec ? natural : nowSec + Math.floor(random() * spread)
    }
    return insert.bind(r.url, setDate, next, Number(r.checked_at) || null, Number(r.no_video) === 1 ? 1 : 0, nowSec)
  })
  for (let i = 0; i < statements.length; i += 100) await db.batch(statements.slice(i, i + 100))
  return statements.length
}

/** After a successful fetch of a set page: its next due time by age (jittered), or never. */
export async function scheduleAfterFetch(
  env: Env,
  settings: PoolSettings,
  f: { url: string; videoId: string | null; hasIdRows: boolean; nowSec?: number; random?: () => number },
): Promise<number | null> {
  const nowSec = f.nowSec ?? nowSeconds()
  const setDate = setDateFromUrl(f.url)
  const interval = recheckIntervalSeconds(settings, setAgeDays(setDate, nowSec), { noGoodVideo: !f.videoId, hasIdRows: f.hasIdRows })
  const next = interval === null ? null : nowSec + jitter(interval, settings.recheck.jitterFraction, f.random)
  await dbOf(env)
    .prepare(
      `INSERT INTO set_schedule (url, set_date, next_due_at, last_fetched_at, has_id_rows, no_good_video, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET set_date = excluded.set_date, next_due_at = excluded.next_due_at,
         last_fetched_at = excluded.last_fetched_at, has_id_rows = excluded.has_id_rows,
         no_good_video = excluded.no_good_video, retry_at = NULL, updated_at = excluded.updated_at`,
    )
    .bind(f.url, setDate, next, nowSec, f.hasIdRows ? 1 : 0, f.videoId ? 0 : 1, nowSec)
    .run()
  return next
}

/**
 * Make a set due for a recheck at `atSec` (default now) whatever its age —
 * for other modules that learn a set needs another look (an owner removed its
 * video, a dead video, a purge). Creates the row if needed.
 */
export async function markSetDue(env: Env, url: string, atSec = nowSeconds()): Promise<void> {
  await dbOf(env)
    .prepare(
      `INSERT INTO set_schedule (url, set_date, next_due_at, last_fetched_at, has_id_rows, no_good_video, updated_at)
       VALUES (?, ?, ?, NULL, 0, 0, ?)
       ON CONFLICT(url) DO UPDATE SET next_due_at = excluded.next_due_at, retry_at = NULL, updated_at = excluded.updated_at`,
    )
    .bind(url, setDateFromUrl(url), atSec, nowSeconds())
    .run()
}

/** Most fetch attempts of one set page per UTC day (review W4 #3): a set that keeps failing is not refetched every tick. */
export const MAX_SET_ATTEMPTS_PER_DAY = 3
/** Wait after the Nth attempt before the next one: 15 min, 30 min, 60 min, … capped at 6 h. */
export function attemptBackoffSeconds(attempt: number): number {
  return Math.min(6 * HOUR, 15 * 60 * 2 ** Math.max(0, attempt - 1))
}
const utcDay = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10)

/**
 * Claim one fetch attempt of a set page before the tick runs it (new set,
 * recheck or verification): it will not be picked again before `retry_at`,
 * and not at all once it has had MAX_SET_ATTEMPTS_PER_DAY attempts today. A
 * completed fetch clears `retry_at` (scheduleAfterFetch). Returns the attempt
 * number for today.
 */
export async function claimSetAttempt(env: Env, url: string, nowSec = nowSeconds()): Promise<number> {
  const day = utcDay(nowSec)
  const db = dbOf(env)
  const cur = await db.prepare('SELECT attempt_day, attempts_today FROM set_schedule WHERE url = ?').bind(url).first<{ attempt_day: string | null; attempts_today: number }>()
  const attempt = cur && cur.attempt_day === day ? Number(cur.attempts_today) + 1 : 1
  await db
    .prepare(
      `INSERT INTO set_schedule (url, set_date, next_due_at, last_fetched_at, has_id_rows, no_good_video, updated_at, retry_at, attempt_day, attempts_today)
       VALUES (?, ?, NULL, NULL, 0, 0, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET retry_at = excluded.retry_at, attempt_day = excluded.attempt_day,
         attempts_today = excluded.attempts_today, updated_at = excluded.updated_at`,
    )
    .bind(url, setDateFromUrl(url), nowSec, nowSec + attemptBackoffSeconds(attempt), day, attempt)
    .run()
  return attempt
}

/** SQL: the set (alias `s` = its set_schedule row, may be NULL) is not waiting out an attempt and has attempts left today. Binds now, today. */
const ATTEMPT_OK_SQL = `(s.retry_at IS NULL OR s.retry_at <= ?) AND NOT (COALESCE(s.attempt_day, '') = ? AND s.attempts_today >= ${MAX_SET_ATTEMPTS_PER_DAY})`

async function deferSetSchedule(env: Env, url: string, untilSec: number): Promise<void> {
  await dbOf(env).prepare('UPDATE set_schedule SET next_due_at = ? WHERE url = ? AND next_due_at IS NOT NULL AND next_due_at < ?').bind(untilSec, url, untilSec).run()
}

// ─── per-fetch bookkeeping (called by syncOne) ──────────────────────────────

export type SetFetchRecord = { parsed: ScrapedTracklist | null; verification: VerificationResult | null }

/**
 * Everything the scheduler needs to learn from one successful set-page fetch:
 * fold it into the verification state (first, so `isVerified` is current for
 * the mkvid track list saved right after) and schedule the next recheck.
 * Never throws — bookkeeping must not fail the set.
 */
export async function recordSetFetch(
  env: Env,
  f: {
    setUrl: string
    html: string
    /** The page already parsed by the caller (null = no rows); undefined = parse it here. */
    parsed?: ScrapedTracklist | null
    videoId: string | null
    accountId?: string | null
    fetchedAt?: string | null
    settings?: PoolSettings
    pool?: PoolConfig | null
    log?: Logger
  },
): Promise<SetFetchRecord> {
  const out: SetFetchRecord = { parsed: null, verification: null }
  try {
    const settings = f.settings ?? (await getPoolSettings(env))
    // No track rows at all (an error page, a stub): nothing to verify, and no
    // ID rows to know about. Skips a pointless parse.
    const parsed = f.parsed !== undefined ? f.parsed : /tlpItem/.test(f.html) ? parseTracklist(f.setUrl, f.html) : null
    out.parsed = parsed
    const fetchedMs = f.fetchedAt ? Date.parse(f.fetchedAt) : NaN
    const fetchedAt = Number.isFinite(fetchedMs) ? Math.floor(fetchedMs / 1000) : nowSeconds()
    if (parsed && parsed.rows.length > 0) {
      out.verification = await noteSetFetch(env, {
        setUrl: f.setUrl,
        parsed,
        accountId: f.accountId,
        fetchedAt,
        settings,
        pool: f.pool === undefined ? poolConfigFromEnv(env) : f.pool,
        log: f.log,
      })
      // Search index (lib/search/index.ts): verified lists only, fire-and-forget, drained via waitUntil.
      queueSearchIndex(env, { setUrl: f.setUrl, html: f.html, parsed, videoId: f.videoId, log: f.log }, out.verification.outcome)
    }
    const hasIdRows = parsed ? parsed.rows.some((r) => r.anonymous || r.isUnidentified) : false
    await scheduleAfterFetch(env, settings, { url: f.setUrl, videoId: f.videoId, hasIdRows })
  } catch (e) {
    f.log?.warn('scheduler.record_fetch_failed', { setUrl: f.setUrl, ...errorFields(e) })
  }
  return out
}

// ─── DJ discovery + paced backfill ──────────────────────────────────────────

async function ensureDjSchedules(env: Env, settings: PoolSettings, slugs: string[], nowSec: number, random: () => number): Promise<void> {
  if (slugs.length === 0) return
  const db = dbOf(env)
  const have = new Set((await db.prepare('SELECT slug FROM dj_schedule').all<{ slug: string }>()).results.map((r) => r.slug))
  const missing = slugs.filter((s) => !have.has(s))
  if (missing.length === 0) return
  const insert = db.prepare('INSERT OR IGNORE INTO dj_schedule (slug, next_discovery_at, next_backfill_at, updated_at) VALUES (?, ?, ?, ?)')
  await db.batch(
    missing.map((slug) =>
      insert.bind(
        slug,
        nowSec + Math.floor(random() * settings.discovery.intervalHours * HOUR),
        nowSec + Math.floor(random() * settings.backfill.stepIntervalHours * HOUR),
        nowSec,
      ),
    ),
  )
}

async function setDjDue(env: Env, column: 'next_discovery_at' | 'next_backfill_at', slug: string, at: number, nowSec: number): Promise<void> {
  await dbOf(env).prepare(`UPDATE dj_schedule SET ${column} = ?, updated_at = ? WHERE slug = ?`).bind(at, nowSec, slug).run()
}

function nextIn(hours: number, jitterHours: number, nowSec: number, random: () => number): number {
  return nowSec + Math.max(15 * 60, Math.round(hours * HOUR + (random() * 2 - 1) * jitterHours * HOUR))
}

/**
 * Remember page 1's scroll keys (and, the first time, where the head walk
 * stopped) so the paced backfill can take its steps without fetching page 1.
 * Called after every crawl.
 */
export async function rememberDjScrollKeys(env: Env, slug: string, crawl: Pick<DjCrawlResult, 'keys' | 'tail' | 'stopReason'>): Promise<void> {
  if (!crawl.keys) return
  const bf = await loadDjBackfill(env, slug)
  const at = nowSeconds()
  if (!bf) {
    const done = crawl.stopReason === 'end' || crawl.tail === null
    await saveDjBackfill(env, slug, { cursor: done ? null : crawl.tail, done, at, keys: crawl.keys })
  } else if (!bf.keys || bf.keys.idScrollObject !== crawl.keys.idScrollObject || bf.keys.type !== crawl.keys.type) {
    await saveDjBackfill(env, slug, { ...bf, keys: crawl.keys })
  }
}

export type BackfillStepResult = { slug: string; status: 'done' | 'no_cursor' | 'stepped' | 'soft_failed' | 'stopped'; added?: number; stopReason?: string; retryAfterSeconds?: number | null }

/** One "older sets" step for `slug` at priority backfill; new URLs join the DJ's discovered sets. */
export async function runDjBackfillStep(env: Env, slug: string, log: Logger): Promise<BackfillStepResult> {
  const bf = await loadDjBackfill(env, slug)
  if (!bf || bf.done) return { slug, status: 'done' }
  if (!bf.keys || !bf.cursor) return { slug, status: 'no_cursor' }
  let step: Awaited<ReturnType<typeof djScrollStep>>
  try {
    step = await djScrollStep(slug, bf.keys, bf.cursor, fetchOptsFromEnv(env, log, { priority: 'backfill' }))
  } catch (e) {
    if (isStopTheBatchError(e)) return { slug, status: 'stopped', stopReason: e instanceof Error ? e.message : String(e), retryAfterSeconds: retryAfterOf(e) }
    log.warn('scheduler.backfill_step_failed', { slug, ...errorFields(e) })
    return { slug, status: 'soft_failed' }
  }
  if (!step) return { slug, status: 'soft_failed' }
  const state = await loadSubState(env, slug, log)
  let added = 0
  if (state) {
    const since = structuredClone(state)
    const discovered = [...(state.discoveredTracklistUrls ?? [])]
    const seen = new Set(discovered)
    for (const u of step.urls) {
      if (!seen.has(u)) {
        seen.add(u)
        discovered.push(u)
        added++
      }
    }
    if (added > 0) await saveSubState(env, slug, { ...state, discoveredTracklistUrls: discovered }, { since })
  }
  await saveDjBackfill(env, slug, { cursor: step.end ? null : step.next, done: step.end, at: nowSeconds(), keys: bf.keys })
  log.info('scheduler.backfill_step', { slug, listed: step.urls.length, added, end: step.end })
  return { slug, status: 'stepped', added }
}

function retryAfterOf(e: unknown): number | null {
  const r = (e as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds
  return typeof r === 'number' && Number.isFinite(r) ? r : null
}

// ─── the render feeder ──────────────────────────────────────────────────────

/**
 * Sets mkvid is waiting on whose list can only become verified once someone
 * fetches them: a `pending` mkvid request whose set has no `set_verification`
 * row at all. Without this they wait for their recheck by age, which for old
 * sets is weeks away. Oldest request first.
 *
 * Only requests the claim could take once verified (lib/mkvid.ts
 * tryClaimRow, lib/mkvid-readiness.ts): not banned / superseded / failed /
 * done / claimed, attempts left, the set (under the request's own DJ) still
 * processed, not abandoned, subscribed, and not resolving to a YouTube video
 * (the claim would supersede it; a set whose only video fails the
 * full-recording rule has none). Also left out: a set still inside the 7-day
 * ID wait whose last known list has ID rows (it is young, so its 12 h / 1 d
 * recheck fetches it anyway), one whose longest audio player is known to be
 * shorter than the last cue (mkvid would refuse it as incomplete), one whose
 * known list is under 90 % timed (held; lib/mkvid-readiness.ts
 * pullInHeldRecheck keeps its set due within a week), one whose
 * set-page fetch is waiting out a failed attempt or is out of attempts today
 * (set_schedule.retry_at / attempts_today; a request's own mkvid retry
 * backoff does not matter here), one fetched by anything within
 * RENDER_FEED_REFETCH_COOLDOWN_SECONDS, and one the feeder already fed whose
 * `render_feed.next_feed_at` has not come, or that it gave up on.
 */
export async function renderFeedCandidates(env: Env, nowSec: number, limit: number): Promise<Array<{ url: string; slug: string }>> {
  if (limit <= 0) return []
  const res = await dbOf(env)
    .prepare(
      `SELECT r.set_url AS url, MIN(r.slug) AS slug, MIN(r.created_at) AS created, MIN(r.rowid) AS rid
         FROM mkvid_requests r
         JOIN tracklists t ON t.slug = r.slug AND t.url = r.set_url AND t.processed = 1 AND t.abandoned = 0
         LEFT JOIN set_schedule s ON s.url = r.set_url
         LEFT JOIN mkvid_request_tracks k ON k.request_id = r.id
         LEFT JOIN set_media_facts f ON f.set_url = r.set_url
         LEFT JOIN render_feed rf ON rf.url = r.set_url
        WHERE r.status = 'pending' AND r.attempts < ${MKVID_MAX_ATTEMPTS}
          AND (rf.url IS NULL OR (rf.gave_up = 0 AND rf.next_feed_at <= ?))
          AND r.slug IN (SELECT slug FROM subscriptions)
          AND NOT EXISTS (SELECT 1 FROM set_verification v WHERE v.url = r.set_url)
          AND (t.video_id IS NULL OR (t.video_source = 'mkvid' AND t.video_id = r.replaces_video_id))
          AND NOT COALESCE(k.base_rows > 0 AND k.timed_rows * 10 < k.base_rows * 9, 0)
          AND NOT (f.audio_max_seconds IS NOT NULL AND r.last_cue_seconds IS NOT NULL AND f.audio_max_seconds < r.last_cue_seconds)
          AND NOT (r.skip_id_wait = 0
                   AND COALESCE(k.id_rows, r.track_count - r.ided_count, 1) > 0
                   AND (CASE WHEN r.set_date IS NOT NULL AND r.set_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                             THEN CAST(strftime('%s', r.set_date) AS INTEGER) ELSE ${DISCOVERED_SQL} END) > ?)
          AND (s.last_fetched_at IS NULL OR s.last_fetched_at <= ?)
          AND ${ATTEMPT_OK_SQL}
        GROUP BY r.set_url ORDER BY created, rid LIMIT ?`,
    )
    .bind(nowSec, nowSec - ID_WAIT_SECONDS, nowSec - RENDER_FEED_REFETCH_COOLDOWN_SECONDS, nowSec, utcDay(nowSec), limit)
    .all<{ url: string; slug: string }>()
  return res.results.map((r) => ({ url: r.url, slug: r.slug }))
}

const dayStart = (nowSec: number) => Math.floor(nowSec / 86400) * 86400

/**
 * The pacing limits at `nowSec`: `soFar` = feed fetches allowed since UTC
 * midnight (the day's even share up to now, plus one, capped at
 * `renderFeedPerDay`), `perHour` = feed fetches allowed in any rolling hour
 * (the even rate rounded up, plus one), so a feeder that fell behind (a pause,
 * a backoff) catches up gently instead of at one per tick.
 */
export function renderFeedLimits(settings: PoolSettings, nowSec: number): { soFar: number; perHour: number } {
  const cap = settings.renderFeedPerDay
  if (!(cap > 0)) return { soFar: 0, perHour: 0 }
  const intoDay = nowSec - dayStart(nowSec)
  return { soFar: Math.min(cap, Math.floor((cap * intoDay) / 86400) + 1), perHour: Math.ceil(cap / 24) + 1 }
}

/** Feed fetches counted on `nowSec`'s UTC day, and in the hour before `nowSec`. */
export async function renderFeedUsage(env: Env, nowSec: number): Promise<{ today: number; lastHour: number }> {
  const row = await dbOf(env)
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN last_attempt_at >= ? THEN 1 ELSE 0 END), 0) AS today,
              COALESCE(SUM(CASE WHEN last_attempt_at > ? THEN 1 ELSE 0 END), 0) AS last_hour
         FROM render_feed WHERE last_attempt_at >= ?`,
    )
    .bind(dayStart(nowSec), nowSec - HOUR, Math.min(dayStart(nowSec), nowSec - HOUR))
    .first<{ today: number; last_hour: number }>()
  return { today: Number(row?.today ?? 0), lastHour: Number(row?.last_hour ?? 0) }
}

/** Feed fetches counted on `nowSec`'s UTC day. */
export async function renderFeedUsed(env: Env, nowSec: number): Promise<number> {
  return (await renderFeedUsage(env, nowSec)).today
}

/**
 * How many render-feeder items this tick may submit: within the day's even
 * share so far and the rolling-hour limit (renderFeedLimits), and
 * RENDER_FEED_MAX_PER_TICK at most. 40 a day is about one every 36 minutes,
 * never a burst after midnight; after a pause it catches up at 3 an hour.
 */
export async function renderFeedAllowance(env: Env, settings: PoolSettings, nowSec: number): Promise<number> {
  const { soFar, perHour } = renderFeedLimits(settings, nowSec)
  if (soFar <= 0) return 0
  const used = await renderFeedUsage(env, nowSec)
  return Math.max(0, Math.min(RENDER_FEED_MAX_PER_TICK, soFar - used.today, perHour - used.lastHour))
}

export type RenderFeedRow = { url: string; attempts: number; failures: number; last_attempt_at: number | null; next_feed_at: number; gave_up: number; updated_at: number }

/**
 * Take one feed fetch for `url` before running it — atomically, in one D1
 * statement: only while the day's share and the rolling-hour limit have room
 * and the set is not cooling down or given up. Two overlapping ticks cannot
 * both feed the same set, or both take the last slot. Returns the row as it
 * was before (null = none), to undo the claim if the pool refuses, or
 * `false` when the claim was not granted.
 */
export async function claimRenderFeed(env: Env, settings: PoolSettings, url: string, nowSec: number): Promise<RenderFeedRow | null | false> {
  const { soFar, perHour } = renderFeedLimits(settings, nowSec)
  if (soFar <= 0) return false
  const db = dbOf(env)
  const before = await db.prepare('SELECT * FROM render_feed WHERE url = ?').bind(url).first<RenderFeedRow>()
  const res = await db
    .prepare(
      `INSERT INTO render_feed (url, attempts, failures, last_attempt_at, next_feed_at, gave_up, updated_at)
       SELECT ?, 1, 0, ?, ?, 0, ?
        WHERE (SELECT COUNT(*) FROM render_feed WHERE last_attempt_at >= ?) < ?
          AND (SELECT COUNT(*) FROM render_feed WHERE last_attempt_at > ?) < ?
       ON CONFLICT(url) DO UPDATE SET attempts = render_feed.attempts + 1, last_attempt_at = excluded.last_attempt_at,
         next_feed_at = excluded.next_feed_at, updated_at = excluded.updated_at
        WHERE render_feed.gave_up = 0 AND render_feed.next_feed_at <= ?`,
    )
    .bind(url, nowSec, nowSec + RENDER_FEED_REFETCH_COOLDOWN_SECONDS, nowSec, dayStart(nowSec), soFar, nowSec - HOUR, perHour, nowSec)
    .run()
  return (res.meta.changes ?? 0) > 0 ? before : false
}

/** The pool refused: nothing was fetched, so the claim is undone (it neither counts nor cools the set down). */
async function undoRenderFeed(env: Env, url: string, before: RenderFeedRow | null): Promise<void> {
  const db = dbOf(env)
  if (!before) {
    await db.prepare('DELETE FROM render_feed WHERE url = ?').bind(url).run()
    return
  }
  await db
    .prepare('UPDATE render_feed SET attempts = ?, last_attempt_at = ?, next_feed_at = ?, updated_at = ? WHERE url = ?')
    .bind(before.attempts, before.last_attempt_at, before.next_feed_at, before.updated_at, url)
    .run()
}

/**
 * After a feed fetch ran: a success resets the failure count (the set cools
 * down RENDER_FEED_REFETCH_COOLDOWN_SECONDS); a failure (404, 5xx, a page
 * that could not be processed) doubles the cooldown per consecutive failure,
 * up to RENDER_FEED_MAX_COOLDOWN_SECONDS, and after RENDER_FEED_MAX_FAILURES
 * the set is given up on. Its recheck by age is not affected.
 */
async function settleRenderFeed(env: Env, url: string, ok: boolean, nowSec: number, log: Logger): Promise<void> {
  const db = dbOf(env)
  if (ok) {
    await db.prepare('UPDATE render_feed SET failures = 0, updated_at = ? WHERE url = ?').bind(nowSec, url).run()
    return
  }
  const row = await db.prepare('SELECT failures FROM render_feed WHERE url = ?').bind(url).first<{ failures: number }>()
  const failures = Number(row?.failures ?? 0) + 1
  const gaveUp = failures >= RENDER_FEED_MAX_FAILURES
  const cooldown = Math.min(RENDER_FEED_MAX_COOLDOWN_SECONDS, RENDER_FEED_REFETCH_COOLDOWN_SECONDS * 2 ** (failures - 1))
  await db
    .prepare('UPDATE render_feed SET failures = ?, gave_up = ?, next_feed_at = ?, updated_at = ? WHERE url = ?')
    .bind(failures, gaveUp ? 1 : 0, nowSec + cooldown, nowSec, url)
    .run()
  if (gaveUp) log.warn('scheduler.render_feed_gave_up', { setUrl: url, failures })
  else log.info('scheduler.render_feed_failed', { setUrl: url, failures, nextFeedAt: nowSec + cooldown })
}

// ─── picking a tick ─────────────────────────────────────────────────────────

export type TickItem =
  | { cls: ScheduledClass; kind: 'set'; slug: string; url: string }
  | { cls: 'verify'; kind: 'verify'; slug: string; url: string; excludeAccounts: string[] }
  | { cls: 'verify'; kind: 'render_feed'; slug: string; url: string }
  | { cls: 'recheck'; kind: 'recheck'; slug: string; url: string }
  | { cls: 'new'; kind: 'discovery'; slug: string }
  | { cls: 'backfill'; kind: 'dj_backfill'; slug: string }

/**
 * What is due now, `n` items at most, filled class by class in
 * `priorities.order`. `feedAllowance` = render-feeder items allowed this tick
 * (default: renderFeedAllowance, i.e. the daily cap and its pacing).
 */
export async function pickTickItems(
  env: Env,
  settings: PoolSettings,
  n: number,
  slugs: ReadonlySet<string>,
  nowSec = nowSeconds(),
  feedAllowance?: number,
  /** Filled with how many items were due per class (before `n` cut them): tick history. */
  dueOut?: Record<ScheduledClass, number>,
): Promise<TickItem[]> {
  if (n <= 0) return []
  const db = dbOf(env)
  const lim = Math.max(n * 4, 20)
  const buckets: Record<ScheduledClass, TickItem[]> = { new: [], verify: [], recheck: [], backfill: [] }

  // DJ listing pages (discovery = new, older-sets step = backfill).
  const djs = await db
    .prepare('SELECT slug, next_discovery_at, next_backfill_at FROM dj_schedule WHERE next_discovery_at <= ? OR next_backfill_at <= ?')
    .bind(nowSec, nowSec)
    .all<{ slug: string; next_discovery_at: number | null; next_backfill_at: number | null }>()
  const dueDiscovery = djs.results.filter((r) => slugs.has(r.slug) && r.next_discovery_at !== null && r.next_discovery_at <= nowSec).sort((a, b) => a.next_discovery_at! - b.next_discovery_at!)
  const dueBackfill = djs.results.filter((r) => slugs.has(r.slug) && r.next_backfill_at !== null && r.next_backfill_at <= nowSec).sort((a, b) => a.next_backfill_at! - b.next_backfill_at!)
  for (const r of dueDiscovery) buckets.new.push({ cls: 'new', kind: 'discovery', slug: r.slug })

  // Never-fetched sets: youngest first; old ones are backfill.
  // Unsubscribed DJs' rows are filtered in SQL, before the LIMIT (review W4 #2).
  const today = utcDay(nowSec)
  const pending = await db
    .prepare(
      `SELECT t.slug AS slug, t.url AS url FROM tracklists t LEFT JOIN set_schedule s ON s.url = t.url
        WHERE t.processed = 0 AND t.abandoned = 0 AND t.slug IN (SELECT slug FROM subscriptions) AND ${ATTEMPT_OK_SQL}
        ORDER BY t.discovered_at DESC, t.position ASC LIMIT 1000`,
    )
    .bind(nowSec, today)
    .all<{ slug: string; url: string }>()
  const pend = pending.results
    .filter((r) => slugs.has(r.slug))
    .map((r) => ({ ...r, age: setAgeDays(setDateFromUrl(r.url), nowSec) }))
    .sort((a, b) => (a.age ?? -1) - (b.age ?? -1))
  const seenUrl = new Set<string>()
  for (const r of pend) {
    if (seenUrl.has(r.url)) continue
    seenUrl.add(r.url)
    const cls = firstFetchClass(settings, r.age)
    buckets[cls].push({ cls, kind: 'set', slug: r.slug, url: r.url })
  }

  for (const v of await dueVerifications(env, nowSec, lim)) {
    if (!slugs.has(v.slug) || seenUrl.has(v.url)) continue
    seenUrl.add(v.url)
    buckets.verify.push({ cls: 'verify', kind: 'verify', slug: v.slug, url: v.url, excludeAccounts: v.excludeAccounts })
  }

  // The render feeder: first fetches for sets mkvid waits on, in the verify
  // class right after the second fetches (completing a pair beats opening one).
  const feed = feedAllowance ?? (await renderFeedAllowance(env, settings, nowSec))
  // Nothing to feed a moment ago: do not scan the requests again on every tick.
  const feedEmptyUntil = feed > 0 ? Number((await env.CACHE.get(RENDER_FEED_EMPTY_KEY)) ?? 0) || 0 : 0
  if (feed > 0 && feedEmptyUntil <= nowSec) {
    let added = 0
    const cands = await renderFeedCandidates(env, nowSec, feed + 10)
    if (cands.length === 0) await env.CACHE.put(RENDER_FEED_EMPTY_KEY, String(nowSec + RENDER_FEED_EMPTY_SECONDS), { expirationTtl: 2 * RENDER_FEED_EMPTY_SECONDS })
    for (const c of cands) {
      if (added >= feed) break
      if (!slugs.has(c.slug) || seenUrl.has(c.url)) continue
      seenUrl.add(c.url)
      buckets.verify.push({ cls: 'verify', kind: 'render_feed', slug: c.slug, url: c.url })
      added++
    }
  }

  // Due by schedule - or marked due by hand: `checked_at = 0` is how
  // "Invalidate & resync" and playlist hygiene (owner removed / dead video)
  // ask for a recheck, and those go first.
  const rechecks = await db
    .prepare(
      `SELECT t.url AS url, MIN(t.slug) AS slug, MIN(CASE WHEN t.checked_at = 0 THEN 0 ELSE COALESCE(s.next_due_at, 0) END) AS due
         FROM tracklists t LEFT JOIN set_schedule s ON s.url = t.url
        WHERE t.processed = 1 AND t.abandoned = 0 AND t.slug IN (SELECT slug FROM subscriptions)
          AND (t.checked_at = 0 OR (s.next_due_at IS NOT NULL AND s.next_due_at <= ?))
          AND ${ATTEMPT_OK_SQL}
        GROUP BY t.url ORDER BY due LIMIT ?`,
    )
    .bind(nowSec, nowSec, today, lim)
    .all<{ url: string; slug: string }>()
  for (const r of rechecks.results) {
    if (!slugs.has(r.slug) || seenUrl.has(r.url)) continue
    seenUrl.add(r.url)
    buckets.recheck.push({ cls: 'recheck', kind: 'recheck', slug: r.slug, url: r.url })
  }

  for (const r of dueBackfill) buckets.backfill.push({ cls: 'backfill', kind: 'dj_backfill', slug: r.slug })

  if (dueOut) for (const cls of Object.keys(buckets) as ScheduledClass[]) dueOut[cls] = buckets[cls].length
  const out: TickItem[] = []
  // Starvation guard: the most overdue DJ step (past overdueSlotHours) takes the
  // first slot, one per tick. Backfill is last in the order, and the classes
  // above it (verify + the render feeder, rechecks) can fill every slot for days.
  const overdueSlot = settings.backfill.overdueSlotHours
  if (overdueSlot > 0) {
    const late = dueBackfill.find((r) => r.next_backfill_at! <= nowSec - overdueSlot * HOUR)
    if (late) {
      const i = buckets.backfill.findIndex((b) => b.kind === 'dj_backfill' && b.slug === late.slug)
      if (i >= 0) out.push(...buckets.backfill.splice(i, 1))
    }
  }
  for (const cls of settings.priorities.order) {
    for (const item of buckets[cls]) {
      if (out.length >= n) return out
      out.push(item)
    }
  }
  return out
}

// ─── the tick ───────────────────────────────────────────────────────────────

export type TickItemResult = { item: TickItem; outcome: string; stopReason?: string }

export type TickResult = {
  skipped?: 'paused' | 'backoff' | 'pool_not_configured' | 'youtube_not_connected' | 'nothing_due' | 'zero_draw'
  drawn: number
  items: TickItemResult[]
  /** Set when a pool refusal (budget, challenge, outage) ended the tick early. */
  stoppedBy?: string
  /** Items due per class when the tick picked (lib/tick-history.ts). */
  due?: Record<ScheduledClass, number>
}

const PRIORITY_OF: Record<ScheduledClass, PoolPriority> = { new: 'new', verify: 'verify', recheck: 'recheck', backfill: 'backfill' }

/**
 * One heartbeat: draw how many items to submit, pick them, run them in
 * priority order, stop at the first pool refusal. `random` / `now` are
 * injectable for tests.
 */
export async function runSchedulerTick(env: Env, opts: { log?: Logger; random?: () => number; now?: number } = {}): Promise<TickResult> {
  const log = opts.log ?? makeLogger({ task: 'scheduler.tick' })
  const random = opts.random ?? Math.random
  const nowSec = opts.now ?? nowSeconds()
  const pause = await isPaused(env)
  if (pause) {
    log.info('scheduler.paused', { until: pause.until, reason: pause.reason })
    return { skipped: 'paused', drawn: 0, items: [] }
  }
  const backoff = Number((await env.CACHE.get(TICK_BACKOFF_KEY)) ?? 0) || 0
  if (backoff > nowSec) {
    log.info('scheduler.backoff', { until: new Date(backoff * 1000).toISOString() })
    return { skipped: 'backoff', drawn: 0, items: [] }
  }
  const pool = poolConfigFromEnv(env)
  if (!pool) {
    log.warn('scheduler.pool_not_configured')
    return { skipped: 'pool_not_configured', drawn: 0, items: [] }
  }
  const settings = await getPoolSettings(env)
  const subs = await listSubscriptions(env)
  const bySlug = new Map<string, Subscription>(subs.map((s) => [s.slug, s]))
  await ensureDjSchedules(env, settings, subs.map((s) => s.slug), nowSec, random)
  // Creating missing schedules scans tracklists: at most hourly, not every tick (review W4 #7).
  const lastEnsure = Number((await env.CACHE.get(ENSURE_STAMP_KEY)) ?? 0) || 0
  if (nowSec - lastEnsure >= HOUR) {
    const created = await ensureSetSchedules(env, settings, nowSec, random)
    if (created > 0) log.info('scheduler.schedules_created', { created })
    // A full batch means more are missing: look again next tick.
    await env.CACHE.put(ENSURE_STAMP_KEY, String(created >= INIT_BATCH ? 0 : nowSec), { expirationTtl: 2 * HOUR })
  }

  const { minItems, maxItems } = settings.tick
  const drawn = minItems + Math.floor(random() * (maxItems - minItems + 1))
  if (drawn <= 0) {
    log.info('scheduler.zero_draw')
    return { skipped: 'zero_draw', drawn: 0, items: [] }
  }
  const due = { new: 0, verify: 0, recheck: 0, backfill: 0 } as Record<ScheduledClass, number>
  const items = await pickTickItems(env, settings, drawn, new Set(bySlug.keys()), nowSec, undefined, due)
  if (items.length === 0) {
    log.info('scheduler.nothing_due', { drawn })
    return { skipped: 'nothing_due', drawn, items: [], due }
  }
  const tokenInfo = await getAccessToken(env)
  if (!tokenInfo) {
    log.warn('scheduler.youtube_not_connected', { due: items.length })
    return { skipped: 'youtube_not_connected', drawn, items: [], due }
  }

  log.info('scheduler.tick_start', { drawn, picked: items.map((i) => `${i.kind}:${i.cls}`) })
  const results: TickItemResult[] = []
  let stoppedBy: string | undefined
  for (const item of items) {
    const sub = bySlug.get(item.slug)!
    let r: TickItemResult
    let retryAfter: number | null = null
    /** Set once a render_feed item holds its D1 claim (the row as it was before). */
    let feedClaim: { before: RenderFeedRow | null } | null = null
    try {
      if (item.kind === 'dj_backfill') {
        // Claim for a short while; only a completed step earns the full interval.
        await setDjDue(env, 'next_backfill_at', item.slug, nowSec + DJ_RETRY_SECONDS, nowSec)
        const b = await runDjBackfillStep(env, item.slug, log)
        if (b.status === 'stepped' || b.status === 'done' || b.status === 'no_cursor') {
          await setDjDue(env, 'next_backfill_at', item.slug, nextIn(settings.backfill.stepIntervalHours, settings.backfill.jitterHours, nowSec, random), nowSec)
        } else if (b.status === 'soft_failed') {
          await setDjDue(env, 'next_backfill_at', item.slug, nowSec + 6 * HOUR, nowSec)
        }
        r = { item, outcome: b.status, ...(b.stopReason ? { stopReason: b.stopReason } : {}) }
        retryAfter = b.retryAfterSeconds ?? null
      } else {
        let res: SyncOneResult
        if (item.kind === 'discovery') {
          await setDjDue(env, 'next_discovery_at', item.slug, nowSec + DJ_RETRY_SECONDS, nowSec)
          res = await syncOne(env, sub, tokenInfo.accessToken, { log, trigger: 'cron.discovery', priority: 'new', selection: { newUrls: [], recheckUrls: [] }, settings })
          if (res.crawlStopReason === 'fetch_failed' && !res.stoppedBy) {
            // The crawl swallows its fetch errors (a pool refusal included):
            // end the tick rather than ask again, and retry this DJ in an hour.
            res = { ...res, stoppedBy: { reason: 'discovery page fetch failed', retryAfterSeconds: null } }
          } else if (!res.stoppedBy) {
            await setDjDue(env, 'next_discovery_at', item.slug, nextIn(settings.discovery.intervalHours, settings.discovery.jitterHours, nowSec, random), nowSec)
          }
        } else if (item.kind === 'recheck') {
          await deferSetSchedule(env, item.url, nowSec + CLAIM_RECHECK_SECONDS)
          await claimSetAttempt(env, item.url, nowSec)
          res = await syncOne(env, sub, tokenInfo.accessToken, { log, trigger: 'cron.tick', skipDjCrawl: true, priority: 'recheck', selection: { newUrls: [], recheckUrls: [item.url] }, settings })
        } else if (item.kind === 'render_feed') {
          // Claimed in D1 first (the day's share, the hourly limit and the
          // set's cooldown, atomically): an overlapping tick that got there
          // first means this one skips it.
          const before = await claimRenderFeed(env, settings, item.url, nowSec)
          if (before === false) {
            log.info('scheduler.render_feed_not_claimed', { setUrl: item.url })
            results.push({ item, outcome: 'skipped' })
            continue
          }
          feedClaim = { before }
          // A first fetch, by any account: noteSetFetch records it as pending
          // and the verify class asks a different account >= 2 h later.
          await claimSetAttempt(env, item.url, nowSec)
          res = await syncOne(env, sub, tokenInfo.accessToken, {
            log,
            trigger: 'cron.render_feed',
            skipDjCrawl: true,
            priority: 'verify',
            selection: { newUrls: [], recheckUrls: [item.url] },
            settings,
          })
          // syncOne reports ok for the run even when this one set failed: the
          // set counts as fetched only when its recheck completed.
          if (!res.stoppedBy && res.ok && res.stats.tracklistsRechecked < 1) res = { ...res, ok: false }
        } else if (item.kind === 'verify') {
          await deferVerification(env, item.url, nowSec + CLAIM_VERIFY_SECONDS)
          await claimSetAttempt(env, item.url, nowSec)
          res = await syncOne(env, sub, tokenInfo.accessToken, {
            log,
            trigger: 'cron.verify',
            skipDjCrawl: true,
            priority: 'verify',
            excludeAccounts: item.excludeAccounts,
            selection: { newUrls: [], recheckUrls: [item.url] },
            settings,
          })
        } else {
          await claimSetAttempt(env, item.url, nowSec)
          res = await syncOne(env, sub, tokenInfo.accessToken, { log, trigger: 'cron.tick', skipDjCrawl: true, priority: PRIORITY_OF[item.cls], selection: { newUrls: [item.url], recheckUrls: [] }, settings })
        }
        r = { item, outcome: res.stoppedBy ? 'stopped' : res.ok ? 'ok' : 'failed', ...(res.stoppedBy ? { stopReason: res.stoppedBy.reason } : {}) }
        retryAfter = res.stoppedBy?.retryAfterSeconds ?? null
      }
    } catch (e) {
      log.error('scheduler.item_threw', { kind: item.kind, slug: item.slug, ...errorFields(e) })
      r = { item, outcome: 'threw' }
    }
    if (feedClaim && item.kind === 'render_feed') {
      // A pool refusal fetched nothing: undo the claim (no count, no cooldown).
      // Anything else was a feed fetch: settle it, a failure backing the set off.
      try {
        if (r.outcome === 'stopped') await undoRenderFeed(env, item.url, feedClaim.before)
        else await settleRenderFeed(env, item.url, r.outcome === 'ok', nowSec, log)
      } catch (e) {
        log.warn('scheduler.render_feed_settle_failed', { setUrl: item.url, ...errorFields(e) })
      }
    }
    results.push(r)
    if (r.outcome === 'stopped') {
      stoppedBy = r.stopReason
      if (retryAfter !== null && retryAfter > 0) {
        const until = nowSec + Math.min(MAX_BACKOFF_SECONDS, Math.ceil(retryAfter))
        await env.CACHE.put(TICK_BACKOFF_KEY, String(until), { expirationTtl: Math.max(60, until - nowSec + 60) })
      }
      log.info('scheduler.tick_stopped', { reason: stoppedBy, retryAfterSeconds: retryAfter, done: results.length, left: items.length - results.length })
      break
    }
  }
  log.info('scheduler.tick_done', { drawn, ran: results.length, outcomes: results.map((x) => `${x.item.kind}:${x.outcome}`), stoppedBy: stoppedBy ?? null })
  return { drawn, items: results, due, ...(stoppedBy ? { stoppedBy } : {}) }
}
