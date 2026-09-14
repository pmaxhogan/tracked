/**
 * One-way import of the pre-D1 KV data into D1, run from the cron handler
 * until it is done and a no-op afterwards.
 *
 * Three things move:
 *   - the subscription list (`subs:list` / `subs:item:*`) — see lib/subscriptions.ts
 *   - each DJ's sync state blob (`subs:state:<slug>`) — see lib/sync-store.ts;
 *     also imported lazily on first touch, this pass just front-loads it so the
 *     5-minute drain cron (which only looks at D1 counts) sees every DJ's
 *     backlog straight after the deploy
 *   - the two audit trails (`np:` and `pladd:` in CACHE), in bounded pages per
 *     tick: the list gives the summary, but every full record is a separate KV
 *     `get`, and a Worker invocation only gets so many subrequests. Progress
 *     lives at `migrate:d1:audit` in SUBS; `INSERT OR IGNORE` on `legacy_key`
 *     makes a re-run of any page harmless.
 *
 * Nothing is deleted from KV. Once every flag says done the old keys simply
 * age out (the audit rows had 90-day TTLs; the state blobs stay as a backup).
 */

import type { Env } from '../types'
import { batchChunked, dbOf } from './db'
import { errorFields, type Logger } from './log'
import { listSubscriptions } from './subscriptions'
import { importSubStateFromKv } from './sync-store'
import { insertStatement, type PlaylistAdditionRecord, type PlaylistAdditionSummary } from './playlist-audit'

const STATES_FLAG = 'migrate:d1:states'
const AUDIT_PROGRESS_KEY = 'migrate:d1:audit'
/** KV keys handled per trail per tick — each costs one `get` on top of the list. */
export const AUDIT_ROWS_PER_TICK = 40

type AuditProgress = {
  /** KV list cursor to resume from; `null` = not started; `'done'` = finished. */
  np: string | null
  pladd: string | null
  imported: { np: number; pladd: number }
  startedAt?: string
  finishedAt?: string
}

export type MigrationTickResult = {
  states: { imported: number; skipped: number } | 'done'
  audit: { np: number; pladd: number; done: boolean }
}

/** Run one bounded slice of the migration. Safe to call every cron tick. */
export async function runKvMigrationTick(env: Env, log: Logger): Promise<MigrationTickResult> {
  const states = await importAllSubStates(env, log)
  const audit = await importAuditPage(env, log)
  return { states, audit }
}

/**
 * Import every subscribed DJ's KV state blob that D1 doesn't have yet. Runs
 * once (flagged in KV) — later subscriptions are born in D1.
 */
export async function importAllSubStates(env: Env, log: Logger): Promise<{ imported: number; skipped: number } | 'done'> {
  if ((await env.SUBS.get(STATES_FLAG)) !== null) return 'done'
  const subs = await listSubscriptions(env)
  const db = dbOf(env)
  let imported = 0
  let skipped = 0
  for (const sub of subs) {
    const has = await db.prepare('SELECT 1 AS x FROM sub_sync WHERE slug = ? LIMIT 1').bind(sub.slug).first()
    const hasRows = has ?? (await db.prepare('SELECT 1 AS x FROM tracklists WHERE slug = ? LIMIT 1').bind(sub.slug).first())
    if (hasRows) {
      skipped += 1
      continue
    }
    // Throws on a KV/D1 failure: better to retry next tick than to record
    // "migrated" over a DJ whose history never made it across.
    if (await importSubStateFromKv(env, sub.slug, log)) imported += 1
    else skipped += 1
  }
  await env.SUBS.put(STATES_FLAG, JSON.stringify({ at: new Date().toISOString(), imported, skipped }))
  log.info('migrate.states_done', { imported, skipped })
  return { imported, skipped }
}

async function loadProgress(env: Env): Promise<AuditProgress> {
  const raw = (await env.SUBS.get(AUDIT_PROGRESS_KEY, 'json')) as AuditProgress | null
  return raw ?? { np: null, pladd: null, imported: { np: 0, pladd: 0 } }
}

/** One page of each audit trail. Returns how many rows each trail imported this tick and whether both are finished. */
export async function importAuditPage(env: Env, log: Logger, rowsPerTick = AUDIT_ROWS_PER_TICK): Promise<{ np: number; pladd: number; done: boolean }> {
  const progress = await loadProgress(env)
  if (progress.np === 'done' && progress.pladd === 'done') return { np: 0, pladd: 0, done: true }
  if (!progress.startedAt) progress.startedAt = new Date().toISOString()
  const db = dbOf(env)
  let np = 0
  let pladd = 0

  if (progress.np !== 'done') {
    const page = await env.CACHE.list<Record<string, unknown>>({ prefix: 'np:', limit: rowsPerTick, cursor: progress.np ?? undefined })
    const statements: D1PreparedStatement[] = []
    for (const k of page.keys) {
      const record = (await env.CACHE.get(k.name, 'json')) as Record<string, any> | null
      if (!record) continue
      const summary = k.metadata ?? legacyNowPlayingSummary(record)
      const t = typeof record.t === 'string' ? record.t : new Date(0).toISOString()
      statements.push(
        db
          .prepare('INSERT OR IGNORE INTO now_playing_audit (t, ts, req_id, status, legacy_key, summary, record) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(t, Date.parse(t) || 0, typeof record.reqId === 'string' ? record.reqId : null, String(record.status ?? 'unknown'), k.name, JSON.stringify(summary), JSON.stringify(record)),
      )
    }
    await batchChunked(db, statements)
    np = statements.length
    progress.imported.np += np
    progress.np = page.list_complete ? 'done' : page.cursor
  }

  if (progress.pladd !== 'done') {
    const page = await env.CACHE.list<PlaylistAdditionSummary>({ prefix: 'pladd:', limit: rowsPerTick, cursor: progress.pladd ?? undefined })
    const statements: D1PreparedStatement[] = []
    for (const k of page.keys) {
      const record = (await env.CACHE.get(k.name, 'json')) as PlaylistAdditionRecord | null
      if (!record || typeof record.t !== 'string' || typeof record.setUrl !== 'string') continue
      statements.push(insertStatement(db, record, k.name, k.metadata ?? undefined))
    }
    await batchChunked(db, statements)
    pladd = statements.length
    progress.imported.pladd += pladd
    progress.pladd = page.list_complete ? 'done' : page.cursor
  }

  const done = progress.np === 'done' && progress.pladd === 'done'
  if (done) progress.finishedAt = new Date().toISOString()
  await env.SUBS.put(AUDIT_PROGRESS_KEY, JSON.stringify(progress))
  log.info(done ? 'migrate.audit_done' : 'migrate.audit_page', { np, pladd, totals: progress.imported, done })
  return { np, pladd, done }
}

/** Summary for an `np:` record written before metadata summaries existed (flat shape). */
function legacyNowPlayingSummary(v: Record<string, any>): Record<string, unknown> {
  return {
    t: v.t,
    status: v.status,
    title: String(v.videoTitle ?? v.input?.videoTitle ?? v.videoUrl ?? v.input?.videoUrl ?? '').slice(0, 100),
    cs: v.currentSeconds ?? v.input?.currentSeconds ?? null,
    dur: v.videoDurationSeconds ?? v.input?.videoDurationSeconds ?? null,
    via: v.tracklistVia ?? v.search?.via ?? null,
    skew: v.select?.currentSkewSeconds ?? null,
    impossible: v.impossibleTimestamp ?? false,
    ms: v.meta?.totalMs ?? null,
  }
}

/** Read-only view of migration progress for the admin panel / logs. */
export async function migrationStatus(env: Env): Promise<{ subs: unknown; states: unknown; audit: AuditProgress }> {
  const [subs, states, audit] = await Promise.all([
    env.SUBS.get('migrate:d1:subs', 'json'),
    env.SUBS.get(STATES_FLAG, 'json'),
    loadProgress(env),
  ])
  return { subs, states, audit }
}

/** Swallow-everything wrapper for the cron: a migration hiccup must never stop a sync tick. */
export async function runKvMigrationTickSafely(env: Env, log: Logger): Promise<void> {
  try {
    const r = await runKvMigrationTick(env, log)
    if (r.states !== 'done' || !r.audit.done) log.info('migrate.tick', r)
  } catch (e) {
    log.error('migrate.tick_threw', errorFields(e))
  }
}
