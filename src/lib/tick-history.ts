/**
 * Scheduler tick history (migration 0015): one row per runSchedulerTick, so
 * "why has this DJ's backfill not run for two days?" has an answer. Rows hold
 * set URLs and DJ slugs only (public data), never account or pool details.
 */
import type { Env } from '../types'
import { dbOf, parseJson } from './db'
import type { TickResult } from './fetch-scheduler'

export const TICK_HISTORY_DAYS = 14
const MAX_TEXT = 300

export type TickHistoryRow = {
  id: number
  at: number
  ms: number | null
  skipped: string | null
  drawn: number
  ran: number
  stoppedBy: string | null
  /** Items due per class when the tick picked (before the draw cut them). A floor, not the backlog: the class queries have their own LIMITs. */
  due: Record<string, number> | null
  items: Array<{ kind: string; cls: string; slug: string; url?: string; outcome: string; stopReason?: string }>
  error: string | null
}

/** Never throws: history must not break the tick it describes. */
export async function recordSchedulerTick(env: Env, at: number, ms: number, r: TickResult | null, error: string | null = null): Promise<void> {
  try {
    const items = (r?.items ?? []).map((x) => ({
      kind: x.item.kind,
      cls: x.item.cls,
      slug: x.item.slug,
      ...('url' in x.item && x.item.url ? { url: x.item.url } : {}),
      outcome: x.outcome,
      ...(x.stopReason ? { stopReason: x.stopReason.slice(0, MAX_TEXT) } : {}),
    }))
    await dbOf(env)
      .prepare('INSERT INTO scheduler_ticks (at, ms, skipped, drawn, ran, stopped_by, due, items, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(
        at,
        Math.round(ms),
        r?.skipped ?? null,
        r?.drawn ?? 0,
        items.length,
        r?.stoppedBy ? r.stoppedBy.slice(0, MAX_TEXT) : null,
        r?.due ? JSON.stringify(r.due) : null,
        JSON.stringify(items),
        error ? error.slice(0, MAX_TEXT) : null,
      )
      .run()
  } catch {
    // Before migration 0015, or a D1 blip: the log line still has it.
  }
}

/** Newest first; `before` (an id) pages further back. */
export async function listSchedulerTicks(env: Env, opts: { limit?: number; before?: number | null } = {}): Promise<TickHistoryRow[]> {
  const limit = Math.min(500, Math.max(1, Math.floor(opts.limit ?? 50)))
  const before = opts.before && opts.before > 0 ? Math.floor(opts.before) : null
  const res = await dbOf(env)
    .prepare(`SELECT * FROM scheduler_ticks ${before ? 'WHERE id < ?' : ''} ORDER BY id DESC LIMIT ?`)
    .bind(...(before ? [before, limit] : [limit]))
    .all<{ id: number; at: number; ms: number | null; skipped: string | null; drawn: number; ran: number; stopped_by: string | null; due: string | null; items: string | null; error: string | null }>()
  return res.results.map((x) => ({
    id: x.id,
    at: x.at,
    ms: x.ms,
    skipped: x.skipped,
    drawn: x.drawn,
    ran: x.ran,
    stoppedBy: x.stopped_by,
    due: parseJson<Record<string, number> | null>(x.due, null),
    items: parseJson<TickHistoryRow['items']>(x.items, []),
    error: x.error,
  }))
}

export async function pruneSchedulerTicks(env: Env, nowSec = Math.floor(Date.now() / 1000)): Promise<number> {
  const r = await dbOf(env).prepare('DELETE FROM scheduler_ticks WHERE at < ?').bind(nowSec - TICK_HISTORY_DAYS * 86400).run()
  return r.meta.changes ?? 0
}
