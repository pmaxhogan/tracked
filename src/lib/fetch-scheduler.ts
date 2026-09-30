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
 *   - verify       the second fetch of a pending verification (lib/verification.ts)
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

// ─── picking a tick ─────────────────────────────────────────────────────────

export type TickItem =
  | { cls: ScheduledClass; kind: 'set'; slug: string; url: string }
  | { cls: 'verify'; kind: 'verify'; slug: string; url: string; excludeAccounts: string[] }
  | { cls: 'recheck'; kind: 'recheck'; slug: string; url: string }
  | { cls: 'new'; kind: 'discovery'; slug: string }
  | { cls: 'backfill'; kind: 'dj_backfill'; slug: string }

/** What is due now, `n` items at most, filled class by class in `priorities.order`. */
export async function pickTickItems(env: Env, settings: PoolSettings, n: number, slugs: ReadonlySet<string>, nowSec = nowSeconds()): Promise<TickItem[]> {
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

  const out: TickItem[] = []
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
  const items = await pickTickItems(env, settings, drawn, new Set(bySlug.keys()), nowSec)
  if (items.length === 0) {
    log.info('scheduler.nothing_due', { drawn })
    return { skipped: 'nothing_due', drawn, items: [] }
  }
  const tokenInfo = await getAccessToken(env)
  if (!tokenInfo) {
    log.warn('scheduler.youtube_not_connected', { due: items.length })
    return { skipped: 'youtube_not_connected', drawn, items: [] }
  }

  log.info('scheduler.tick_start', { drawn, picked: items.map((i) => `${i.kind}:${i.cls}`) })
  const results: TickItemResult[] = []
  let stoppedBy: string | undefined
  for (const item of items) {
    const sub = bySlug.get(item.slug)!
    let r: TickItemResult
    let retryAfter: number | null = null
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
  return { drawn, items: results, ...(stoppedBy ? { stoppedBy } : {}) }
}
