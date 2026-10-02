/**
 * Read-only views over the scheduler for the Scheduler page (ui/pages/scheduler.ts):
 * where its slots went in the last 24 h (from `scheduler_ticks`, lib/tick-history.ts),
 * which DJs' discovery and backfill are overdue (`dj_schedule`), and the tick list
 * itself with a label per set.
 *
 * Everything here reaches a browser. Tick rows hold set URLs and DJ slugs (public),
 * but `error` is an arbitrary throw's message and the stop reasons come from
 * upstream, so both pass through `redactText` first: no URL other than
 * 1001tracklists, no bearer or token value.
 */
import type { Env } from '../types'
import { dbOf } from './db'
import { labelFromSetUrl } from './activity'
import { listSchedulerTicks, type TickHistoryRow } from './tick-history'

export const SCHEDULER_CLASSES = ['new', 'verify', 'recheck', 'backfill'] as const
export const SCHEDULER_KINDS = ['discovery', 'set', 'verify', 'render_feed', 'recheck', 'dj_backfill'] as const
const DAY = 86400
/** Ticks scanned back (newest first) for "last ran" beyond the 24 h window: 14 days of 5-minute ticks. */
const LAST_RUN_SCAN = 4100
const MAX_TEXT = 300

/** Outcomes that mean the item did its job (sync 'ok', a backfill step that moved or finished). */
const GOOD_OUTCOMES = new Set(['ok', 'stepped', 'done', 'no_cursor'])

/**
 * Strips anything secret-looking from a free-text reason or error: URLs other
 * than 1001tracklists (the pool's own address can ride on a fetch error),
 * `Bearer x`, `token=x` style pairs. Caps the length.
 */
export function redactText(s: string | null | undefined): string | null {
  if (s == null) return null
  let out = String(s)
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (u) => {
      try {
        const h = new URL(u).hostname.toLowerCase()
        if (h === '1001tracklists.com' || h.endsWith('.1001tracklists.com')) return u.split(/[?#]/)[0]!
      } catch {
        // not a URL after all: redact it anyway
      }
      return '[url]'
    })
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/\b(token|key|secret|password|passwd|pwd|auth|authorization|apikey|api_key|sig|signature)\s*[=:]\s*[^\s&,;"']+/gi, '$1=[redacted]')
  if (out.length > MAX_TEXT) out = out.slice(0, MAX_TEXT) + '…'
  return out
}

export type TickItemView = {
  kind: string
  cls: string
  slug: string
  url: string | null
  /** The set's label from its URL, or null for a DJ-level item (discovery, backfill). */
  label: string | null
  outcome: string
  stopReason: string | null
}

export type TickView = Omit<TickHistoryRow, 'items' | 'stoppedBy' | 'error'> & {
  stoppedBy: string | null
  error: string | null
  items: TickItemView[]
}

function viewOf(t: TickHistoryRow): TickView {
  return {
    id: t.id,
    at: t.at,
    ms: t.ms,
    skipped: t.skipped,
    drawn: t.drawn,
    ran: t.ran,
    due: t.due,
    stoppedBy: redactText(t.stoppedBy),
    error: redactText(t.error),
    items: (Array.isArray(t.items) ? t.items : []).map((x) => {
      const url = typeof x.url === 'string' && x.url ? x.url : null
      return {
        kind: String(x.kind ?? ''),
        cls: String(x.cls ?? ''),
        slug: String(x.slug ?? ''),
        url,
        label: url ? labelFromSetUrl(url) : null,
        outcome: String(x.outcome ?? ''),
        stopReason: redactText(x.stopReason),
      }
    }),
  }
}

/** One page of ticks, newest first; `nextBefore` is the id to pass as `before` for the next page, null at the end. */
export async function schedulerTicksPage(env: Env, opts: { limit?: number; before?: number | null } = {}): Promise<{ ticks: TickView[]; nextBefore: number | null }> {
  const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)))
  const rows = await listSchedulerTicks(env, { limit, before: opts.before ?? null })
  return { ticks: rows.map(viewOf), nextBefore: rows.length === limit ? rows[rows.length - 1]!.id : null }
}

type Counts = Record<string, number>
const bump = (m: Counts, k: string, n = 1) => { m[k] = (m[k] ?? 0) + n }
const zeros = (keys: readonly string[]): Counts => Object.fromEntries(keys.map((k) => [k, 0]))

export type LastRun = { picked: number | null; ok: number | null }

export type SchedulerSummary = {
  now: number
  windowSeconds: number
  ticks: number
  /** Ticks that picked at least one item. */
  ranTicks: number
  skippedTicks: number
  skipped: Counts
  /** Ticks that threw (recorded with an error and no result). */
  errored: number
  drawn: number
  items: number
  byClass: Counts
  byKind: Counts
  outcomes: Counts
  /** Outcomes per kind: where the failures are. */
  outcomesByKind: Record<string, Counts>
  stopReasons: Counts
  /** When an item of each class / kind was last picked, and last went well (unix seconds), over the whole history. */
  lastRun: { byClass: Record<string, LastRun>; byKind: Record<string, LastRun> }
  /** The newest tick that counted what was due (a floor per class), or null. */
  latestDue: { at: number; due: Record<string, number> } | null
  /** The oldest tick on record (history is kept 14 days), or null when there is none. */
  oldestTickAt: number | null
}

export async function schedulerSummary(env: Env, nowSec = Math.floor(Date.now() / 1000)): Promise<SchedulerSummary> {
  const db = dbOf(env)
  const since = nowSec - DAY
  const recent = await listWindow(env, since)
  const s: SchedulerSummary = {
    now: nowSec,
    windowSeconds: DAY,
    ticks: recent.length,
    ranTicks: 0,
    skippedTicks: 0,
    skipped: {},
    errored: 0,
    drawn: 0,
    items: 0,
    byClass: zeros(SCHEDULER_CLASSES),
    byKind: zeros(SCHEDULER_KINDS),
    outcomes: {},
    outcomesByKind: {},
    stopReasons: {},
    lastRun: { byClass: {}, byKind: {} },
    latestDue: null,
    oldestTickAt: null,
  }
  for (const t of recent) {
    s.drawn += t.drawn || 0
    if (t.error) s.errored++
    if (t.skipped) { s.skippedTicks++; bump(s.skipped, t.skipped) }
    if (t.items.length) s.ranTicks++
    const stop = redactText(t.stoppedBy)
    if (stop) bump(s.stopReasons, stop)
    for (const x of t.items) {
      s.items++
      bump(s.byClass, String(x.cls))
      bump(s.byKind, String(x.kind))
      bump(s.outcomes, String(x.outcome))
      bump((s.outcomesByKind[String(x.kind)] ??= {}), String(x.outcome))
    }
  }

  // Last run per class/kind: newest ticks that ran anything, until every one is seen.
  for (const k of SCHEDULER_CLASSES) s.lastRun.byClass[k] = { picked: null, ok: null }
  for (const k of SCHEDULER_KINDS) s.lastRun.byKind[k] = { picked: null, ok: null }
  const open = () => [...Object.values(s.lastRun.byClass), ...Object.values(s.lastRun.byKind)].some((r) => r.picked === null || r.ok === null)
  const scan = await db
    .prepare('SELECT at, items FROM scheduler_ticks WHERE ran > 0 ORDER BY id DESC LIMIT ?')
    .bind(LAST_RUN_SCAN)
    .all<{ at: number; items: string | null }>()
  for (const r of scan.results) {
    let items: TickHistoryRow['items'] = []
    try { const v = JSON.parse(r.items || '[]'); if (Array.isArray(v)) items = v } catch { /* skip a bad row */ }
    for (const x of items) {
      const good = GOOD_OUTCOMES.has(String(x.outcome))
      for (const rec of [(s.lastRun.byClass[String(x.cls)] ??= { picked: null, ok: null }), (s.lastRun.byKind[String(x.kind)] ??= { picked: null, ok: null })]) {
        if (rec.picked === null) rec.picked = r.at
        if (good && rec.ok === null) rec.ok = r.at
      }
    }
    if (!open()) break
  }

  const due = await db.prepare('SELECT at, due FROM scheduler_ticks WHERE due IS NOT NULL ORDER BY id DESC LIMIT 1').first<{ at: number; due: string }>()
  if (due) {
    try {
      const d = JSON.parse(due.due)
      if (d && typeof d === 'object') s.latestDue = { at: due.at, due: Object.fromEntries(Object.entries(d).map(([k, v]) => [k, Number(v) || 0])) }
    } catch { /* leave null */ }
  }
  const oldest = await db.prepare('SELECT MIN(at) AS at FROM scheduler_ticks').first<{ at: number | null }>()
  s.oldestTickAt = oldest?.at ?? null
  return s
}

/** Every tick since `since`, newest first, paged through listSchedulerTicks (288 a day at a 5-minute cron). */
async function listWindow(env: Env, since: number): Promise<TickHistoryRow[]> {
  const out: TickHistoryRow[] = []
  let before: number | null = null
  for (let i = 0; i < 10; i++) {
    const page = await listSchedulerTicks(env, { limit: 500, before })
    for (const t of page) {
      if (t.at < since) return out
      out.push(t)
    }
    if (page.length < 500) return out
    before = page[page.length - 1]!.id
  }
  return out
}

export type DjStarvationRow = {
  slug: string
  /** The DJ's name as the last sync saw it, or null. */
  name: string | null
  nextDiscoveryAt: number | null
  nextBackfillAt: number | null
  /** now − next_*_at when that time has passed (seconds), 0 or less when not yet due, null when not scheduled. */
  discoveryOverdue: number | null
  backfillOverdue: number | null
}

/** Every subscribed DJ's discovery and backfill due times, most overdue first. */
export async function djStarvation(env: Env, nowSec = Math.floor(Date.now() / 1000)): Promise<DjStarvationRow[]> {
  const res = await dbOf(env)
    .prepare(
      `SELECT s.slug AS slug, ss.artist_name AS name, d.next_discovery_at AS nd, d.next_backfill_at AS nb
         FROM subscriptions s
         LEFT JOIN dj_schedule d ON d.slug = s.slug
         LEFT JOIN sub_sync ss ON ss.slug = s.slug
        ORDER BY s.position`,
    )
    .all<{ slug: string; name: string | null; nd: number | null; nb: number | null }>()
  const rows = res.results.map((r) => ({
    slug: r.slug,
    name: r.name ?? null,
    nextDiscoveryAt: r.nd ?? null,
    nextBackfillAt: r.nb ?? null,
    discoveryOverdue: r.nd == null ? null : nowSec - r.nd,
    backfillOverdue: r.nb == null ? null : nowSec - r.nb,
  }))
  const worst = (r: DjStarvationRow) => Math.max(r.discoveryOverdue ?? -Infinity, r.backfillOverdue ?? -Infinity)
  return rows.sort((a, b) => worst(b) - worst(a) || a.slug.localeCompare(b.slug))
}
