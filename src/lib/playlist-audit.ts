/**
 * Durable audit trail for playlist additions — the data behind the admin
 * panel's "Recent playlist additions" view.
 *
 * Mirrors the trail /now-playing writes for requests: one `playlist_additions`
 * row per tracklist the sync decided an outcome for, with the full record and
 * a compact summary the list view renders directly. Retention is 90 days
 * (`prunePlaylistAdditions`, run by the daily cron).
 *
 * Rows are buffered during a run and flushed in one batch at the end
 * (`flushPlaylistAdditions`) rather than written inside the set loop: a run
 * processes up to 30 sets and sequential writes would eat a slice of the 25 s
 * sync deadline. The tradeoff is that a run killed mid-loop loses its rows —
 * fine, because this is diagnostics only. Idempotency and progress live in
 * the per-sub state (see lib/sync-store.ts), never here.
 */

import type { Env } from '../types'
import { batchChunked, dbOf, parseJson } from './db'
import { decodeCursor, encodeCursor, type AuditPage } from './audit-cursor'
import type { CombinedAdditionStatus } from './combined-playlist'
import { errorFields, type Logger } from './log'

export const PLAYLIST_AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

/**
 * Outcome for one tracklist the sync looked at:
 *  - `added`      the set's video was inserted into the playlist
 *  - `duplicate`  the video was already in the playlist (nothing inserted)
 *  - `replaced`   a recheck found the set's YouTube recording swapped on
 *                 1001tracklists: the old video was removed and the new one
 *                 inserted (`previousVideoId` names the old one)
 *  - `no_youtube` the set page has no YouTube recording to add
 *  - `failed`     the set errored this run (a later run retries it)
 *  - `abandoned`  errored too many times in a row; the cron gives up on it
 *
 * `failed` and `abandoned` are what the panel's "problems only" filter keeps.
 * Rechecks that find nothing changed write no row at all — at one recheck per
 * set every few days they would drown the rows that matter.
 */
export type PlaylistAdditionStatus = 'added' | 'duplicate' | 'replaced' | 'no_youtube' | 'failed' | 'abandoned'

export type PlaylistAdditionRecord = {
  /** ISO timestamp of the moment the outcome was decided. */
  t: string
  status: PlaylistAdditionStatus
  /** Subscription slug, e.g. `lillypalmer`. */
  slug: string
  artistName: string | null
  /** 1001tracklists tracklist URL this row is about. */
  setUrl: string
  videoId: string | null
  videoUrl: string | null
  /** On `replaced` rows: the video this set resolved to before, now removed. */
  previousVideoId?: string | null
  playlistId: string | null
  playlistTitle: string | null
  /**
   * What happened to the same video on its way into the combined all-artists
   * playlist. `unavailable` means that playlist couldn't be opened at all this
   * run — the combined backfill picks the video up later either way, which is
   * why a combined miss never fails the set. null on rows with no video.
   */
  combinedStatus: CombinedAdditionStatus | null
  /** Which scrape path served the set page — `home-proxy` / `unlocker` / `direct` — or `mkvid` for an upload mkvid delivered. */
  via: string | null
  /** What kicked off the run, e.g. `cron.daily`, `manual.one`. */
  trigger: string | null
  /** Error message on `failed` / `abandoned`; a note on other rows (e.g. "queued for mkvid"). */
  message: string | null
  /** Consecutive failures recorded for this set URL (failure rows only). */
  failureCount: number | null
  meta: { ms: number | null }
}

/** Compact form the list view renders (short keys kept from the KV-metadata days). */
export type PlaylistAdditionSummary = {
  t: string
  status: PlaylistAdditionStatus
  slug: string
  artist: string | null
  set: string
  vid: string | null
  via: string | null
  trg: string | null
  msg: string | null
  ms: number | null
  /** Combined-playlist outcome — see PlaylistAdditionRecord.combinedStatus. */
  cmb: CombinedAdditionStatus | null
  /** Superseded video id on `replaced` rows. */
  prev?: string | null
}

export function playlistAdditionSummary(r: PlaylistAdditionRecord): PlaylistAdditionSummary {
  return {
    t: r.t,
    status: r.status,
    slug: r.slug,
    artist: r.artistName ? r.artistName.slice(0, 100) : null,
    set: r.setUrl.slice(0, 200),
    vid: r.videoId,
    via: r.via,
    trg: r.trigger,
    msg: r.message ? r.message.slice(0, 160) : null,
    ms: r.meta.ms,
    cmb: r.combinedStatus,
    ...(r.previousVideoId ? { prev: r.previousVideoId } : {}),
  }
}

/**
 * Write a run's buffered rows. Best-effort by contract: a D1 failure here must
 * never fail the sync that produced the rows, so everything is swallowed into
 * a warn log.
 */
export async function flushPlaylistAdditions(env: Env, records: PlaylistAdditionRecord[], log: Logger): Promise<void> {
  if (records.length === 0) return
  try {
    const db = dbOf(env)
    await batchChunked(
      db,
      records.map((r) => insertStatement(db, r, null)),
    )
  } catch (e) {
    log.warn('playlist_audit.flush_threw', { total: records.length, ...errorFields(e) })
  }
}

/** The INSERT for one record; `legacyKey` is the KV key it was imported from (null for live rows). */
export function insertStatement(db: D1Database, r: PlaylistAdditionRecord, legacyKey: string | null, summary?: PlaylistAdditionSummary): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO playlist_additions (t, ts, status, slug, set_url, video_id, legacy_key, summary, record)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(r.t, Date.parse(r.t) || Date.now(), r.status, r.slug, r.setUrl, r.videoId ?? null, legacyKey, JSON.stringify(summary ?? playlistAdditionSummary(r)), JSON.stringify(r))
}

type ListRow = { id: number; ts: number; summary: string }

/** Newest-first page of summaries. Each record carries `key` (the row id) for the detail endpoint. */
export async function listPlaylistAdditions(env: Env, opts: { limit: number; cursor?: string | null }): Promise<AuditPage> {
  const limit = Math.min(Math.max(opts.limit, 1), 200)
  const cur = decodeCursor(opts.cursor)
  const stmt = cur
    ? dbOf(env)
        .prepare('SELECT id, ts, summary FROM playlist_additions WHERE ts < ? OR (ts = ? AND id < ?) ORDER BY ts DESC, id DESC LIMIT ?')
        .bind(cur.ts, cur.ts, cur.id, limit + 1)
    : dbOf(env).prepare('SELECT id, ts, summary FROM playlist_additions ORDER BY ts DESC, id DESC LIMIT ?').bind(limit + 1)
  const rows = (await stmt.all<ListRow>()).results
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  return {
    records: page.map((r) => ({ key: String(r.id), expiration: null, ...parseJson<Record<string, unknown>>(r.summary, {}) })),
    cursor: rows.length > limit && last ? encodeCursor(last.ts, last.id) : null,
  }
}

export async function getPlaylistAddition(env: Env, key: string): Promise<PlaylistAdditionRecord | null> {
  const id = Number(key)
  if (!Number.isInteger(id) || id <= 0) return null
  const row = await dbOf(env).prepare('SELECT record FROM playlist_additions WHERE id = ?').bind(id).first<{ record: string }>()
  return row ? parseJson<PlaylistAdditionRecord | null>(row.record, null) : null
}

/**
 * The latest outcome recorded for each set of `slug` (newest row per set URL),
 * as the compact summary. Used to seed recheck baselines for state that
 * predates them (see lib/sync.ts `seedTracklistVideosFromAudit`).
 */
export async function latestAdditionPerSet(env: Env, slug: string): Promise<Map<string, PlaylistAdditionSummary>> {
  const res = await dbOf(env)
    .prepare('SELECT set_url, summary FROM playlist_additions WHERE slug = ? ORDER BY ts DESC, id DESC')
    .bind(slug)
    .all<{ set_url: string; summary: string }>()
  const out = new Map<string, PlaylistAdditionSummary>()
  for (const r of res.results) {
    if (out.has(r.set_url)) continue
    const s = parseJson<PlaylistAdditionSummary | null>(r.summary, null)
    if (s) out.set(r.set_url, s)
  }
  return out
}

/** `failed` / `abandoned` summaries since `sinceMs`, newest first. */
export async function failureRowsSince(env: Env, sinceMs: number): Promise<PlaylistAdditionSummary[]> {
  const res = await dbOf(env)
    .prepare("SELECT summary FROM playlist_additions WHERE status IN ('failed', 'abandoned') AND ts >= ? ORDER BY ts DESC, id DESC")
    .bind(sinceMs)
    .all<{ summary: string }>()
  return res.results.map((r) => parseJson<PlaylistAdditionSummary | null>(r.summary, null)).filter((s): s is PlaylistAdditionSummary => !!s)
}

/** Drop rows past the retention horizon. Returns how many went. */
export async function prunePlaylistAdditions(env: Env, now = Date.now()): Promise<number> {
  const r = await dbOf(env).prepare('DELETE FROM playlist_additions WHERE ts < ?').bind(now - PLAYLIST_AUDIT_RETENTION_MS).run()
  return r.meta.changes ?? 0
}
