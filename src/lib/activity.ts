// Unified activity log (spec "Activity (phase 2)"): one SELECT per source,
// merged in the Worker. Rows sort by `ts` DESC, then by source rank ASC (index
// in `ACTIVITY_SOURCES`), then by key DESC. Keys of `audit`, `addition`,
// `removal`, `claim`, `pool` are integer row ids compared numerically; keys of
// `mkvid` (request uuid), `sync` (slug) and `ban` (KV key) compare as strings.
// A row is "after" cursor `(cts, csrc, ckey)` when `ts < cts`, or `ts = cts`
// and (its rank > rank(csrc), or same source and key < ckey). Each source
// turns that into SQL: rank(S) > rank(csrc) → `T <= cts`; S = csrc →
// `(T < cts OR (T = cts AND K < ckey))`; rank(S) < rank(csrc) → `T < cts`,
// where `T` is the source's ms expression and `K` its key column. Each source
// SELECTs `limit + 1` rows ordered `T DESC, K DESC`; the Worker concatenates,
// sorts with the same comparator, keeps `limit`, and returns a cursor of the
// last kept row when more than `limit` rows came back in total.
// Read-only: nothing here writes D1 or KV.
import type { Env } from '../types'
import { dbOf, parseJson } from './db'
import { REASON_LABELS } from './playlist-hygiene'

export const ACTIVITY_KINDS = ['request', 'playlist', 'hygiene', 'mkvid', 'pool', 'sync', 'ban'] as const
export type ActivityKind = (typeof ACTIVITY_KINDS)[number]
export const ACTIVITY_SOURCES = ['audit', 'addition', 'removal', 'mkvid', 'claim', 'pool', 'sync', 'ban'] as const
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number]
export type ActivityRow = { ts: number; kind: ActivityKind; status: string; problem: boolean; title: string; detail: string | null; dj: string | null; setUrl: string | null; videoId: string | null; ref: { kind: ActivitySource; key: string } }
export type ActivityCursor = { ts: number; src: ActivitySource; key: string }
export type ActivityQuery = { kinds: ActivityKind[]; problems: boolean; dj: string | null; since: number | null; cursor: ActivityCursor | null; limit: number }

const NUMERIC_KEYS: ReadonlySet<ActivitySource> = new Set(['audit', 'addition', 'removal', 'claim', 'pool'])
const rank = (s: ActivitySource) => ACTIVITY_SOURCES.indexOf(s)
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/i
const ACCT_RE = /^acct-\d+$/
const DETAIL_MAX = 200
/** Ban episode keys are `ban:ep:<invertedTs(ms)>` (lib/cache.ts invertedTs). */
const BAN_PREFIX = 'ban:ep:'
const BAN_SCAN = 100
const INVERT_BASE = 10_000_000_000_000

export function encodeActivityCursor(c: ActivityCursor): string {
  return `${c.ts}|${c.src}|${c.key}`
}

export function decodeActivityCursor(s: string): ActivityCursor | null {
  const m = /^(\d{1,15})\|([a-z]+)\|(.{1,200})$/.exec(s)
  if (!m) return null
  const src = m[2] as ActivitySource
  if (!ACTIVITY_SOURCES.includes(src)) return null
  if (NUMERIC_KEYS.has(src) && !/^\d+$/.test(m[3]!)) return null
  return { ts: Number(m[1]), src, key: m[3]! }
}

export function parseActivityQuery(p: URLSearchParams): ActivityQuery | { error: string } {
  const kindsRaw = (p.get('kind') || '').split(',').map((k) => k.trim()).filter(Boolean)
  for (const k of kindsRaw) if (!ACTIVITY_KINDS.includes(k as ActivityKind)) return { error: `unknown kind: ${k}` }
  const dj = p.get('dj') || null
  if (dj && !SLUG_RE.test(dj)) return { error: 'bad dj' }
  const sinceRaw = p.get('since')
  if (sinceRaw && !/^\d{1,15}$/.test(sinceRaw)) return { error: 'bad since' }
  const limitRaw = p.get('limit')
  if (limitRaw && !/^\d{1,6}$/.test(limitRaw)) return { error: 'bad limit' }
  const cursorRaw = p.get('cursor')
  const cursor = cursorRaw ? decodeActivityCursor(cursorRaw) : null
  if (cursorRaw && !cursor) return { error: 'bad cursor' }
  return {
    kinds: kindsRaw.length ? (kindsRaw as ActivityKind[]) : [...ACTIVITY_KINDS],
    problems: p.get('problems') === '1',
    dj,
    since: sinceRaw ? Number(sinceRaw) : null,
    cursor,
    limit: Math.min(Math.max(limitRaw ? Number(limitRaw) : DEFAULT_LIMIT, 1), MAX_LIMIT),
  }
}

/** Server twin of setLabel in src/ui/runtime.ts. */
export function labelFromSetUrl(u: string | null): string {
  if (!u) return '(unknown set)'
  try {
    const seg = new URL(u).pathname.split('/').filter(Boolean).pop() || ''
    const name = seg.replace(/\.html?$/i, '').replace(/[-_]+/g, ' ').trim()
    return name || u
  } catch {
    return u
  }
}

/** The keyset WHERE for one source, given its ms expression and key column. */
function keyset(src: ActivitySource, T: string, K: string, c: ActivityCursor | null): { sql: string; binds: (string | number)[] } {
  if (!c) return { sql: '1 = 1', binds: [] }
  const key: string | number = NUMERIC_KEYS.has(src) ? Number(c.key) : c.key
  if (rank(src) > rank(c.src)) return { sql: `${T} <= ?`, binds: [c.ts] }
  if (rank(src) < rank(c.src)) return { sql: `${T} < ?`, binds: [c.ts] }
  return { sql: `(${T} < ? OR (${T} = ? AND ${K} < ?))`, binds: [c.ts, c.ts, key] }
}

function compare(a: ActivityRow, b: ActivityRow): number {
  if (a.ts !== b.ts) return b.ts - a.ts
  const r = rank(a.ref.kind) - rank(b.ref.kind)
  if (r !== 0) return r
  if (NUMERIC_KEYS.has(a.ref.kind)) return Number(b.ref.key) - Number(a.ref.key)
  return a.ref.key < b.ref.key ? 1 : a.ref.key > b.ref.key ? -1 : 0
}

type Where = { parts: string[]; binds: (string | number)[] }
function where(q: ActivityQuery, src: ActivitySource, T: string, K: string, problemSql: string | null, djCol: string | null): Where {
  const ks = keyset(src, T, K, q.cursor)
  const w: Where = { parts: [ks.sql], binds: [...ks.binds] }
  if (q.since != null) { w.parts.push(`${T} >= ?`); w.binds.push(q.since) }
  if (q.problems && problemSql) w.parts.push(`(${problemSql})`)
  if (q.dj && djCol) { w.parts.push(`${djCol} = ?`); w.binds.push(q.dj) }
  return w
}

// ── formatting helpers ──

/** `m:ss` or `h:mm:ss`; `?` for null. Server twin of `clock` in src/ui/runtime.ts. */
function clock(s: unknown): string {
  if (typeof s !== 'number' || !Number.isFinite(s)) return '?'
  let n = Math.round(s)
  const neg = n < 0
  n = Math.abs(n)
  const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), sec = n % 60
  const mm = h ? String(m).padStart(2, '0') : String(m)
  return (neg ? '-' : '') + (h ? `${h}:` : '') + `${mm}:${String(sec).padStart(2, '0')}`
}

/** `Xh Ym` or `Ym`. */
function duration(ms: number): string {
  const total = Math.round(ms / 60_000)
  const h = Math.floor(total / 60), m = total % 60
  return h ? `${h}h ${m}m` : `${m}m`
}

const clip = (s: string | null | undefined): string | null => (s ? s.slice(0, DETAIL_MAX) : null)
const joinParts = (parts: Array<string | null | undefined | false>): string | null => {
  const kept = parts.filter((p): p is string => typeof p === 'string' && p !== '')
  return kept.length ? kept.join(' · ') : null
}
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

// ── sources ──

const AUDIT_PROBLEM_STATUSES = ['no_video', 'no_tracklist', 'upstream_error']

function auditDetail(s: Record<string, unknown>): string | null {
  const skew = typeof s.skew === 'number' ? s.skew : null
  return joinParts([
    clock(s.cs) + (s.dur ? ` / ${clock(s.dur)}` : ''),
    str(s.via) && `via ${s.via}`,
    s.impossible === true && 'position past end of video',
    skew != null && Math.abs(skew) > 600 && `Δ${clock(skew)} from track start`,
  ])
}

async function auditSource(env: Env, q: ActivityQuery): Promise<ActivityRow[]> {
  if (q.dj) return []
  const problemSql = "status IN ('no_video','no_tracklist','upstream_error') OR json_extract(summary, '$.impossible') = 1"
  const w = where(q, 'audit', 'ts', 'id', problemSql, null)
  const res = await dbOf(env)
    .prepare(`SELECT id, ts, status, summary FROM now_playing_audit WHERE ${w.parts.join(' AND ')} ORDER BY ts DESC, id DESC LIMIT ?`)
    .bind(...w.binds, q.limit + 1)
    .all<{ id: number; ts: number; status: string; summary: string }>()
  return res.results.map((r) => {
    const s = parseJson<Record<string, unknown>>(r.summary, {})
    const impossible = s.impossible === true
    return {
      ts: Number(r.ts), kind: 'request', status: r.status,
      problem: AUDIT_PROBLEM_STATUSES.includes(r.status) || impossible,
      title: str(s.title) ?? '(no title)',
      detail: auditDetail(s), dj: null, setUrl: null, videoId: null,
      ref: { kind: 'audit', key: String(r.id) },
    }
  })
}

async function additionSource(env: Env, q: ActivityQuery): Promise<ActivityRow[]> {
  const w = where(q, 'addition', 'ts', 'id', "status IN ('failed','abandoned')", 'slug')
  const res = await dbOf(env)
    .prepare(`SELECT id, ts, status, slug, set_url, video_id, summary FROM playlist_additions WHERE ${w.parts.join(' AND ')} ORDER BY ts DESC, id DESC LIMIT ?`)
    .bind(...w.binds, q.limit + 1)
    .all<{ id: number; ts: number; status: string; slug: string; set_url: string; video_id: string | null; summary: string }>()
  return res.results.map((r) => {
    const s = parseJson<Record<string, unknown>>(r.summary, {})
    const cmb = s.cmb === 'failed' || s.cmb === 'unavailable' ? `combined ${s.cmb}` : null
    return {
      ts: Number(r.ts), kind: 'playlist', status: r.status,
      problem: r.status === 'failed' || r.status === 'abandoned',
      title: labelFromSetUrl(r.set_url),
      detail: joinParts([str(s.msg) ?? (r.video_id ? `video ${r.video_id}` : null), cmb]),
      dj: r.slug, setUrl: r.set_url, videoId: r.video_id,
      ref: { kind: 'addition', key: String(r.id) },
    }
  })
}

const REMOVAL_SOURCE_LABEL: Record<string, string> = { sweep: 'Sweep', owner: 'Removed by owner', dead: 'Video died', button: 'Remove and replace' }

async function removalSource(env: Env, q: ActivityQuery): Promise<ActivityRow[]> {
  const T = 'at * 1000'
  const w = where(q, 'removal', T, 'id', "status = 'failed'", 'slug')
  const res = await dbOf(env)
    .prepare(`SELECT id, ${T} AS ms, source, status, slug, set_url, video_id, playlist_kind, reason, detail FROM playlist_removals WHERE ${w.parts.join(' AND ')} ORDER BY ${T} DESC, id DESC LIMIT ?`)
    .bind(...w.binds, q.limit + 1)
    .all<{ id: number; ms: number; source: string; status: string; slug: string | null; set_url: string | null; video_id: string; playlist_kind: string; reason: string; detail: string | null }>()
  return res.results.map((r) => ({
    ts: Number(r.ms), kind: 'hygiene', status: r.status,
    problem: r.status === 'failed',
    title: `${REMOVAL_SOURCE_LABEL[r.source] ?? r.source}: ${REASON_LABELS[r.reason] ?? r.reason}`,
    detail: joinParts([clip(r.detail), `${r.playlist_kind} playlist`]),
    dj: r.slug, setUrl: r.set_url, videoId: r.video_id,
    ref: { kind: 'removal', key: String(r.id) },
  }))
}

/**
 * Why an mkvid request was superseded, from the error text stored when it was.
 * Only a 1001tracklists recording counts as "an official recording"; the
 * duplicate-URL causes (claim-time twin guard, manual twin cleanup) and a set
 * that already resolves to an mkvid video say so. Unknown text falls through.
 */
export function supersededReason(error: string | null | undefined): string {
  const e = (error ?? '').trim()
  if (!e) return 'superseded'
  let m = /^same tracklist as (\S+), already rendered as (\S+)$/.exec(e)
  if (m) return `duplicate URL: kept under ${m[1]} (${m[2]})`
  if (/^duplicate of the same 1001tracklists id under another URL/.test(e)) return 'duplicate URL: kept under another URL'
  m = /^set already resolves to (\S+) \((1001tl|mkvid)\)$/.exec(e)
  if (m) return m[2] === 'mkvid' ? `set already has mkvid video ${m[1]}` : `superseded by an official recording (${m[1]})`
  m = /^1001tracklists now has (\S+)$/.exec(e)
  if (m) return `superseded by an official recording (${m[1]})`
  return clip(e) ?? 'superseded'
}

function mkvidDetail(r: { status: string; video_id: string | null; error: string | null }): string | null {
  switch (r.status) {
    case 'done': return r.video_id ? `uploaded ${r.video_id}` : 'uploaded'
    case 'failed': return r.error
    case 'banned': return 'banned from mkvid'
    case 'superseded': return supersededReason(r.error)
    default: return null
  }
}

async function mkvidSource(env: Env, q: ActivityQuery): Promise<ActivityRow[]> {
  const T = 'updated_at * 1000'
  const w = where(q, 'mkvid', T, 'id', "status IN ('failed','banned')", 'slug')
  w.parts.push("status IN ('done','failed','banned','superseded')")
  const res = await dbOf(env)
    .prepare(`SELECT id, ${T} AS ms, status, slug, set_url, set_title, video_id, error FROM mkvid_requests WHERE ${w.parts.join(' AND ')} ORDER BY ${T} DESC, id DESC LIMIT ?`)
    .bind(...w.binds, q.limit + 1)
    .all<{ id: string; ms: number; status: string; slug: string; set_url: string; set_title: string | null; video_id: string | null; error: string | null }>()
  return res.results.map((r) => ({
    ts: Number(r.ms), kind: 'mkvid', status: r.status,
    problem: r.status === 'failed' || r.status === 'banned',
    title: r.set_title || labelFromSetUrl(r.set_url),
    detail: mkvidDetail(r),
    dj: r.slug, setUrl: r.set_url, videoId: r.video_id,
    ref: { kind: 'mkvid', key: r.id },
  }))
}

async function claimSource(env: Env, q: ActivityQuery): Promise<ActivityRow[]> {
  if (q.problems) return [] // a claim is never a problem
  const T = 'c.claimed_at * 1000'
  const w = where(q, 'claim', T, 'c.id', null, 'r.slug')
  const res = await dbOf(env)
    .prepare(`SELECT c.id, ${T} AS ms, c.account, c.recreate, c.refunded_at, r.slug, r.set_url, r.set_title, r.video_id FROM mkvid_claims c LEFT JOIN mkvid_requests r ON r.id = c.request_id WHERE ${w.parts.join(' AND ')} ORDER BY ${T} DESC, c.id DESC LIMIT ?`)
    .bind(...w.binds, q.limit + 1)
    .all<{ id: number; ms: number; account: string; recreate: number; refunded_at: number | null; slug: string | null; set_url: string | null; set_title: string | null; video_id: string | null }>()
  return res.results.map((r) => {
    const refunded = r.refunded_at != null
    return {
      ts: Number(r.ms), kind: 'mkvid', status: refunded ? 'refunded' : 'claimed',
      problem: false,
      title: (Number(r.recreate) ? 'Recreate claimed: ' : 'Claimed for render: ') + (r.set_title || labelFromSetUrl(r.set_url)),
      detail: `${r.account} account` + (refunded ? ' · given back (failed before upload)' : ''),
      dj: r.slug, setUrl: r.set_url, videoId: r.video_id,
      ref: { kind: 'claim', key: String(r.id) },
    }
  })
}

const POOL_TITLES: Record<string, string> = {
  'challenge.created': 'Challenge opened',
  'challenge.solved': 'Challenge solved',
  'challenge.expired': 'Challenge expired',
  'account.flagged': 'Account flagged',
  'account.created': 'Account created',
  'account.retired': 'Account retired',
  'account.rested': 'Account rested',
}
/** A pool event's free-text reason, only when it cannot carry an address and is short. */
const POOL_REASON_MAX = 120
const poolReason = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' && !v.includes('@') && v.length <= POOL_REASON_MAX ? v : null
const POOL_PROBLEM_TYPES = ['account.flagged', 'account.retired', 'challenge.expired']

async function poolSource(env: Env, q: ActivityQuery): Promise<ActivityRow[]> {
  if (q.dj) return []
  const T = 'received_at * 1000'
  const problemSql = "type IN ('account.flagged','account.retired','challenge.expired') OR push_status = 'failed'"
  const w = where(q, 'pool', T, 'id', problemSql, null)
  const res = await dbOf(env)
    .prepare(`SELECT id, ${T} AS ms, type, challenge_id, account_id, payload, push_status FROM pool_events WHERE ${w.parts.join(' AND ')} ORDER BY ${T} DESC, id DESC LIMIT ?`)
    .bind(...w.binds, q.limit + 1)
    .all<{ id: number; ms: number; type: string; challenge_id: string | null; account_id: string | null; payload: string; push_status: string }>()
  return res.results.map((r) => {
    const payload = parseJson<Record<string, unknown>>(r.payload, {})
    // Pool account ids are acct-N only; anything else (a username, an email) never leaves the Worker.
    const account = r.account_id && ACCT_RE.test(r.account_id) ? r.account_id : null
    return {
      ts: Number(r.ms), kind: 'pool', status: r.type,
      problem: POOL_PROBLEM_TYPES.includes(r.type) || r.push_status === 'failed',
      title: POOL_TITLES[r.type] ?? r.type,
      detail: joinParts([
        account,
        r.challenge_id && `challenge ${r.challenge_id}`,
        poolReason(payload.reason),
        (r.push_status === 'failed' || r.push_status === 'not_configured') && `push ${r.push_status}`,
      ]),
      dj: null, setUrl: null, videoId: null,
      ref: { kind: 'pool', key: String(r.id) },
    }
  })
}

async function syncSource(env: Env, q: ActivityQuery): Promise<ActivityRow[]> {
  const T = 'last_run_at * 1000'
  const w = where(q, 'sync', T, 'slug', "last_error IS NOT NULL AND last_error != ''", 'slug')
  w.parts.push('last_run_at IS NOT NULL')
  const res = await dbOf(env)
    .prepare(`SELECT slug, ${T} AS ms, artist_name, last_error FROM sub_sync WHERE ${w.parts.join(' AND ')} ORDER BY ${T} DESC, slug DESC LIMIT ?`)
    .bind(...w.binds, q.limit + 1)
    .all<{ slug: string; ms: number; artist_name: string | null; last_error: string | null }>()
  return res.results.map((r) => {
    const failed = typeof r.last_error === 'string' && r.last_error !== ''
    return {
      ts: Number(r.ms), kind: 'sync', status: failed ? 'error' : 'ok',
      problem: failed,
      title: `Sync: ${r.artist_name || r.slug}`,
      detail: clip(r.last_error),
      dj: r.slug, setUrl: null, videoId: null,
      ref: { kind: 'sync', key: r.slug },
    }
  })
}

type BanEpisodeView = { endedAt?: string | null; blockedForMs?: number | null; simulated?: boolean; clearedBy?: string | null }

async function banSource(env: Env, q: ActivityQuery): Promise<ActivityRow[]> {
  if (q.dj) return []
  const page = await env.CACHE.list({ prefix: BAN_PREFIX, limit: BAN_SCAN })
  const c = q.cursor
  const banRank = rank('ban')
  const survivors: Array<{ key: string; ts: number }> = []
  for (const k of page.keys) {
    const inverted = Number(k.name.slice(BAN_PREFIX.length))
    if (!Number.isFinite(inverted)) continue
    const ts = INVERT_BASE - inverted
    if (q.since != null && ts < q.since) continue
    if (c) {
      const after = ts < c.ts || (ts === c.ts && (banRank > rank(c.src) || (c.src === 'ban' && k.name < c.key)))
      if (!after) continue
    }
    survivors.push({ key: k.name, ts })
  }
  survivors.sort((a, b) => b.ts - a.ts || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0))
  // Fetch bodies in parallel chunks, in key order, until limit + 1 rows qualify
  // (missing bodies and, under `problems`, simulated episodes do not count).
  const want = q.limit + 1
  const rows: ActivityRow[] = []
  for (let i = 0; i < survivors.length && rows.length < want; ) {
    const chunk = survivors.slice(i, i + (want - rows.length))
    i += chunk.length
    const eps = await Promise.all(chunk.map((s) => env.CACHE.get<BanEpisodeView>(s.key, 'json')))
    chunk.forEach((s, j) => {
      const ep = eps[j]
      if (!ep || rows.length >= want) return
      const row = banRow(s.key, s.ts, ep)
      if (!q.problems || row.problem) rows.push(row)
    })
  }
  return rows
}

function banRow(key: string, ts: number, ep: BanEpisodeView): ActivityRow {
  const simulated = ep.simulated === true
  const open = ep.endedAt == null
  return {
    ts, kind: 'ban', status: open ? 'open' : 'ended',
    problem: !simulated,
    title: simulated ? 'Simulated IP block' : 'IP block',
    detail: joinParts([
      typeof ep.blockedForMs === 'number' && ep.blockedForMs > 0 && `blocked ${duration(ep.blockedForMs)}`,
      str(ep.clearedBy) && `cleared by ${ep.clearedBy}`,
      open && 'ongoing',
    ]),
    dj: null, setUrl: null, videoId: null,
    ref: { kind: 'ban', key },
  }
}

const SOURCES: Array<{ src: ActivitySource; kind: ActivityKind; run: (env: Env, q: ActivityQuery) => Promise<ActivityRow[]> }> = [
  { src: 'audit', kind: 'request', run: auditSource },
  { src: 'addition', kind: 'playlist', run: additionSource },
  { src: 'removal', kind: 'hygiene', run: removalSource },
  { src: 'mkvid', kind: 'mkvid', run: mkvidSource },
  { src: 'claim', kind: 'mkvid', run: claimSource },
  { src: 'pool', kind: 'pool', run: poolSource },
  { src: 'sync', kind: 'sync', run: syncSource },
  { src: 'ban', kind: 'ban', run: banSource },
]

export async function listActivity(env: Env, q: ActivityQuery): Promise<{ rows: ActivityRow[]; cursor: string | null }> {
  const parts = await Promise.all(SOURCES.filter((s) => q.kinds.includes(s.kind)).map((s) => s.run(env, q)))
  const all = parts.flat().sort(compare)
  const rows = all.slice(0, q.limit)
  const last = rows[rows.length - 1]
  return { rows, cursor: all.length > q.limit && last ? encodeActivityCursor({ ts: last.ts, src: last.ref.kind, key: last.ref.key }) : null }
}
