/**
 * Durable audit trail of every /now-playing call — the data behind the admin
 * panel's "Recent requests" view. One `now_playing_audit` row per request:
 * the full record (inputs, YouTube resolution, tracklist search plan, the
 * selection made) plus a compact summary the list view renders without
 * parsing the record.
 *
 * Retention is 90 days (`pruneNowPlayingAudit`, run by the daily cron) — the
 * same horizon the old `np:` KV rows had via TTL, and for the same reason:
 * timestamp/selection bugs are often noticed weeks later.
 */

import type { Env } from '../types'
import { dbOf, parseJson } from './db'
import { decodeCursor, encodeCursor, type AuditPage } from './audit-cursor'

export const NOW_PLAYING_AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

export type NowPlayingAuditSummary = {
  t: string
  status: string
  title: string
  cs: number | null
  dur: number | null
  via: string | null
  skew: number | null
  impossible: boolean
  ms: number | null
}

export async function writeNowPlayingAudit(
  env: Env,
  opts: { reqId: string; record: Record<string, unknown> & { t: string; status: string }; summary: NowPlayingAuditSummary },
): Promise<void> {
  await dbOf(env)
    .prepare('INSERT INTO now_playing_audit (t, ts, req_id, status, legacy_key, summary, record) VALUES (?, ?, ?, ?, NULL, ?, ?)')
    .bind(opts.record.t, Date.parse(opts.record.t) || Date.now(), opts.reqId, opts.record.status, JSON.stringify(opts.summary), JSON.stringify(opts.record))
    .run()
}

type ListRow = { id: number; ts: number; summary: string }

/** Newest-first page of summaries. Each record carries `key` (the row id) for the detail endpoint. */
export async function listNowPlayingAudit(env: Env, opts: { limit: number; cursor?: string | null }): Promise<AuditPage> {
  const limit = Math.min(Math.max(opts.limit, 1), 200)
  const cur = decodeCursor(opts.cursor)
  const stmt = cur
    ? dbOf(env)
        .prepare('SELECT id, ts, summary FROM now_playing_audit WHERE ts < ? OR (ts = ? AND id < ?) ORDER BY ts DESC, id DESC LIMIT ?')
        .bind(cur.ts, cur.ts, cur.id, limit + 1)
    : dbOf(env).prepare('SELECT id, ts, summary FROM now_playing_audit ORDER BY ts DESC, id DESC LIMIT ?').bind(limit + 1)
  const rows = (await stmt.all<ListRow>()).results
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  return {
    records: page.map((r) => ({ key: String(r.id), expiration: null, ...parseJson<Record<string, unknown>>(r.summary, {}) })),
    cursor: rows.length > limit && last ? encodeCursor(last.ts, last.id) : null,
  }
}

export async function getNowPlayingAudit(env: Env, key: string): Promise<Record<string, unknown> | null> {
  const id = Number(key)
  if (!Number.isInteger(id) || id <= 0) return null
  const row = await dbOf(env).prepare('SELECT record FROM now_playing_audit WHERE id = ?').bind(id).first<{ record: string }>()
  return row ? parseJson<Record<string, unknown> | null>(row.record, null) : null
}

/** Drop rows past the retention horizon. Returns how many went. */
export async function pruneNowPlayingAudit(env: Env, now = Date.now()): Promise<number> {
  const r = await dbOf(env).prepare('DELETE FROM now_playing_audit WHERE ts < ?').bind(now - NOW_PLAYING_AUDIT_RETENTION_MS).run()
  return r.meta.changes ?? 0
}
