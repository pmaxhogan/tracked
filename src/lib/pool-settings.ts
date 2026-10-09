/**
 * The fetch scheduler's settings: recheck pace by set age (quest decision 13),
 * the priority order work is submitted in (decision 12), and how much a cron
 * tick may submit. One JSON document in SUBS KV (`pool:settings`, durable),
 * merged over the defaults below on every read, edited through
 * `GET/PUT /ui/api/pool/settings` (routes/pool-api.ts; the admin
 * page is W8's).
 *
 * Budget, pacing and the phone's reserved share are NOT here: tlpool owns
 * those (its own GET/PUT /settings). This is only what the Worker decides:
 * what is due, and in which order it asks.
 */

import { z } from 'zod'
import type { Env } from '../types'

export const POOL_SETTINGS_KEY = 'pool:settings'

/** Work classes the scheduler submits, i.e. every pool priority but `phone` (which only interactive routes use). */
export const SCHEDULED_CLASSES = ['new', 'verify', 'recheck', 'backfill'] as const
export type ScheduledClass = (typeof SCHEDULED_CLASSES)[number]

const Band = z.object({
  /** Sets up to this age (days, exclusive) use this band. */
  maxAgeDays: z.number().positive().max(3650),
  intervalHours: z.number().positive().max(24 * 3650),
})

export const PoolSettingsSchema = z.object({
  recheck: z.object({
    /** Ascending by maxAgeDays. Default: 0-2 d 12 h, 2-7 d 1 d, 7-30 d 5 d, 30-180 d 30 d. */
    bands: z.array(Band).min(1).max(12),
    /** Older than the last band: interval in hours, or null = never (default never). */
    beyondIntervalHours: z.number().positive().max(24 * 3650).nullable(),
    /** Older than the last band but without a good video, or with ID rows (default 90 d). */
    beyondExceptionIntervalHours: z.number().positive().max(24 * 3650).nullable(),
    /** A set whose date cannot be read from its URL (default 5 d). */
    unknownAgeIntervalHours: z.number().positive().max(24 * 3650),
    /** Every interval is multiplied by 1 ± this, so due times never re-cluster (default 0.15). */
    jitterFraction: z.number().min(0).max(0.5),
    /** An overdue set with a pending mkvid request is spread over at most this, not its whole interval (default 48 h). */
    mkvidWaitingSpreadHours: z.number().positive().max(24 * 30),
  }),
  priorities: z.object({
    /** Order the scheduler fills a tick in when there is more due than it submits. Must list each class once. */
    order: z
      .array(z.enum(SCHEDULED_CLASSES))
      .length(SCHEDULED_CLASSES.length)
      .refine((a) => new Set(a).size === a.length, 'each class exactly once'),
    /** A never-fetched set up to this age is `new`; older ones (typically found by the DJ backfill) are `backfill`. */
    newSetMaxAgeDays: z.number().min(0).max(3650),
  }),
  tick: z
    .object({
      /** Each 5-minute cron tick submits a random number of items in [minItems, maxItems]. */
      minItems: z.number().int().min(0).max(20),
      maxItems: z.number().int().min(0).max(20),
      /**
       * A tick's items start at random moments spread over its first this-many
       * seconds (default 150; 0 = back to back), so the pool's fetches do not
       * all land in the minute after each cron. Kept under the 5-minute tick.
       */
      spreadSeconds: z.number().int().min(0).max(240),
    })
    .refine((t) => t.maxItems >= t.minItems, 'maxItems must be >= minItems'),
  verify: z.object({
    /** The second fetch waits at least this long after the first (decision 2: 2 h). */
    minGapHours: z.number().min(2).max(24 * 30),
    /** Plus a random 0..this, so second fetches do not line up (default 2 h). */
    jitterHours: z.number().min(0).max(24 * 7),
  }),
  discovery: z.object({
    /** Each DJ's listing page is re-read about this often (default 24 h) ... */
    intervalHours: z.number().positive().max(24 * 30),
    /** ... ± this (default 4 h), spread across the day rather than at 06:00. */
    jitterHours: z.number().min(0).max(24 * 7),
  }),
  backfill: z.object({
    /** One "older sets" step (10 sets) per DJ about this often while its history is incomplete (default 24 h). */
    stepIntervalHours: z.number().positive().max(24 * 30),
    jitterHours: z.number().min(0).max(24 * 7),
    /**
     * A DJ whose step is this many hours overdue gets the first slot of a tick
     * (one per tick), ahead of the priority order: backfill is last in it and
     * the classes above it can fill every slot for days (default 12 h, 0 = off).
     */
    overdueSlotHours: z.number().min(0).max(24 * 30),
  }),
  /** 1001tracklists fetches one manual button press (sync / resync) may spend (default 10). */
  manualMaxFetches: z.number().int().min(0).max(200),
  /**
   * How long one fetch of a manual button press (sync / resync) may wait for
   * a free pool browser, re-asking tlpool (`queueSeconds`, lib/pool.ts) while
   * it says queued/running (default 600; 0 = one ask, like the scheduler).
   * 2026-10-07: twelve sync clicks at once outran tlpool's 4 browsers and six
   * failed after 20 s.
   */
  manualQueueSeconds: z.number().int().min(0).max(900),
  /**
   * Forced refetches of one set's list (purge routes, the viewer's Refresh,
   * /now-playing `refresh: true`): a repeat for the same set within
   * `cooldownSeconds` (default 120) is answered from the cache, and at most
   * `dailyCap` (default 40) run per UTC day across all sets.
   */
  forcedRefetch: z.object({
    cooldownSeconds: z.number().int().min(0).max(86400),
    dailyCap: z.number().int().min(0).max(1000),
  }),
  /**
   * The render feeder (lib/fetch-scheduler.ts): first fetches per UTC day, at
   * most, for sets mkvid is waiting on that have no verified list and no
   * verification started (default 40; 0 = off). Paced across the day.
   */
  renderFeedPerDay: z.number().int().min(0).max(500),
  /**
   * Reports of a suspect account to tlpool (lib/verification.ts), each of
   * which rests that account: at most `maxPerDay` per UTC day (default 6;
   * 0 = never report), and none while more than `maxRestingShare` (default
   * 0.5) of the non-passive pool already rests. 2026-10-07: false reports had
   * 28 of 33 accounts resting at once.
   */
  reports: z.object({
    maxPerDay: z.number().int().min(0).max(100),
    maxRestingShare: z.number().min(0).max(1),
  }),
  /** Retries and backoffs of the scheduler (lib/fetch-scheduler.ts); formerly constants. */
  retry: z.object({
    /** Fetch attempts of one set page per UTC day at most (default 3). */
    maxSetAttemptsPerDay: z.number().int().min(1).max(50),
    /** Wait after a failed attempt: base × 2^(n-1), capped (defaults 15 min, 6 h). */
    attemptBackoffBaseMinutes: z.number().positive().max(24 * 60),
    attemptBackoffMaxHours: z.number().positive().max(24 * 7),
    /** A claimed recheck / verification whose fetch failed is picked again after this (defaults 6 h, 2 h). */
    claimRecheckHours: z.number().positive().max(24 * 7),
    claimVerifyHours: z.number().positive().max(24 * 7),
    /** A DJ discovery / backfill step that did not complete is retried after this (default 60 min). */
    djRetryMinutes: z.number().positive().max(24 * 60),
    /** Ticks stand down for the pool's retryAfter, at most this (default 6 h). */
    poolBackoffMaxHours: z.number().positive().max(48),
    /** A tick whose every item was refused item-scoped stands down at most this (default 10 min). */
    itemScopedBackoffMinutes: z.number().positive().max(24 * 60),
  }),
  /** The render feeder's pacing besides renderFeedPerDay; formerly constants. */
  renderFeed: z.object({
    /** First fetches per tick at most (default 1). */
    maxPerTick: z.number().int().min(0).max(10),
    /** A set fetched or fed this recently is not fed (default 48 h), doubling per failed feed up to maxCooldownDays (default 14). */
    cooldownHours: z.number().positive().max(24 * 60),
    maxCooldownDays: z.number().positive().max(365),
    /** After this many failed feed fetches in a row the set is given up (default 3). */
    maxFailures: z.number().int().min(1).max(20),
  }),
  /**
   * The search index catch-up (lib/fetch-scheduler.ts indexCatchUpCandidates):
   * sets last fetched before the search index's format date, or never
   * verified, are fetched again so they get verified and indexed (search only
   * takes verified lists). On top of the drawn items: at most `perTick`
   * (default 1) a tick and `perDay` (default 200; 0 = off) a UTC day, newest
   * set first; a set fetched within `cooldownHours` (default 72) waits.
   */
  indexCatchUp: z.object({
    perDay: z.number().int().min(0).max(2000),
    perTick: z.number().int().min(0).max(10),
    cooldownHours: z.number().positive().max(24 * 60),
  }),
})

export type PoolSettings = z.infer<typeof PoolSettingsSchema>

export const DEFAULT_POOL_SETTINGS: PoolSettings = {
  recheck: {
    bands: [
      { maxAgeDays: 2, intervalHours: 12 },
      { maxAgeDays: 7, intervalHours: 24 },
      { maxAgeDays: 30, intervalHours: 5 * 24 },
      { maxAgeDays: 180, intervalHours: 30 * 24 },
    ],
    beyondIntervalHours: null,
    beyondExceptionIntervalHours: 90 * 24,
    unknownAgeIntervalHours: 5 * 24,
    jitterFraction: 0.15,
    mkvidWaitingSpreadHours: 48,
  },
  priorities: { order: ['new', 'verify', 'recheck', 'backfill'], newSetMaxAgeDays: 14 },
  tick: { minItems: 0, maxItems: 3, spreadSeconds: 150 },
  verify: { minGapHours: 2, jitterHours: 2 },
  discovery: { intervalHours: 24, jitterHours: 4 },
  backfill: { stepIntervalHours: 24, jitterHours: 6, overdueSlotHours: 12 },
  manualMaxFetches: 10,
  manualQueueSeconds: 600,
  forcedRefetch: { cooldownSeconds: 120, dailyCap: 40 },
  renderFeedPerDay: 40,
  reports: { maxPerDay: 6, maxRestingShare: 0.5 },
  retry: {
    maxSetAttemptsPerDay: 3,
    attemptBackoffBaseMinutes: 15,
    attemptBackoffMaxHours: 6,
    claimRecheckHours: 6,
    claimVerifyHours: 2,
    djRetryMinutes: 60,
    poolBackoffMaxHours: 6,
    itemScopedBackoffMinutes: 10,
  },
  renderFeed: { maxPerTick: 1, cooldownHours: 48, maxCooldownDays: 14, maxFailures: 3 },
  indexCatchUp: { perDay: 200, perTick: 1, cooldownHours: 72 },
}

type Plain = Record<string, unknown>
const isPlain = (x: unknown): x is Plain => !!x && typeof x === 'object' && !Array.isArray(x)

/** Deep merge for plain objects; arrays and scalars in `patch` replace. */
export function mergeSettings<T>(base: T, patch: unknown): T {
  if (!isPlain(base) || !isPlain(patch)) return (patch === undefined ? base : (patch as T))
  const out: Plain = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    out[k] = isPlain(v) && isPlain((base as Plain)[k]) ? mergeSettings((base as Plain)[k], v) : v
  }
  return out as T
}

function normalise(s: PoolSettings): PoolSettings {
  return { ...s, recheck: { ...s.recheck, bands: [...s.recheck.bands].sort((a, b) => a.maxAgeDays - b.maxAgeDays) } }
}

/** Current settings: stored document over the defaults. A stored document that no longer validates is ignored (defaults win). */
export async function getPoolSettings(env: Pick<Env, 'SUBS'>): Promise<PoolSettings> {
  let stored: unknown = null
  try {
    stored = await env.SUBS.get(POOL_SETTINGS_KEY, 'json')
  } catch {
    stored = null
  }
  if (!stored) return DEFAULT_POOL_SETTINGS
  const parsed = PoolSettingsSchema.safeParse(mergeSettings(DEFAULT_POOL_SETTINGS, stored))
  return parsed.success ? normalise(parsed.data) : DEFAULT_POOL_SETTINGS
}

export type SettingsUpdate = { ok: true; settings: PoolSettings } | { ok: false; issues: string[] }

/** Apply a partial update (deep-merged over the current settings), validate, store. */
export async function updatePoolSettings(env: Pick<Env, 'SUBS'>, patch: unknown): Promise<SettingsUpdate> {
  if (!isPlain(patch)) return { ok: false, issues: ['body: expected a JSON object'] }
  const current = await getPoolSettings(env)
  const parsed = PoolSettingsSchema.safeParse(mergeSettings(current, patch))
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) }
  const settings = normalise(parsed.data)
  await env.SUBS.put(POOL_SETTINGS_KEY, JSON.stringify(settings))
  return { ok: true, settings }
}

// ─── schedule arithmetic (pure) ─────────────────────────────────────────────

const DAY = 24 * 60 * 60

/** The set's date from its 1001tracklists URL (every set slug ends in -YYYY-MM-DD.html), or null. */
export function setDateFromUrl(url: string): string | null {
  const m = url.match(/-(\d{4})-(\d{2})-(\d{2})\.html(?:[?#].*)?$/)
  if (!m) return null
  const iso = `${m[1]}-${m[2]}-${m[3]}`
  return Number.isFinite(Date.parse(`${iso}T00:00:00Z`)) ? iso : null
}

/** Age in days at `nowSec` (never negative), or null without a date. */
export function setAgeDays(setDate: string | null, nowSec: number): number | null {
  if (!setDate) return null
  const t = Date.parse(`${setDate}T00:00:00Z`)
  if (!Number.isFinite(t)) return null
  return Math.max(0, (nowSec - t / 1000) / DAY)
}

export type SetFlags = {
  /** The set has no good video (none found, or one the playlist rules reject). */
  noGoodVideo?: boolean
  /** The list still has unidentified (ID) rows. */
  hasIdRows?: boolean
}

/** Decision 13: the recheck interval (seconds) for a set of this age, or null = never. No jitter. */
export function recheckIntervalSeconds(settings: PoolSettings, ageDays: number | null, flags: SetFlags = {}): number | null {
  const r = settings.recheck
  if (ageDays === null) return r.unknownAgeIntervalHours * 3600
  for (const b of r.bands) if (ageDays < b.maxAgeDays) return b.intervalHours * 3600
  const hours = flags.noGoodVideo || flags.hasIdRows ? r.beyondExceptionIntervalHours : r.beyondIntervalHours
  return hours === null ? null : hours * 3600
}

/** `seconds` × (1 ± jitterFraction), from `random` in [0, 1). */
export function jitter(seconds: number, fraction: number, random: () => number = Math.random): number {
  return Math.max(60, Math.round(seconds * (1 + (random() * 2 - 1) * fraction)))
}

/** Which class a never-fetched set's first fetch belongs to. Unknown date counts as new. */
export function firstFetchClass(settings: PoolSettings, ageDays: number | null): 'new' | 'backfill' {
  return ageDays === null || ageDays <= settings.priorities.newSetMaxAgeDays ? 'new' : 'backfill'
}
