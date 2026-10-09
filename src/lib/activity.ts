// Unified activity log (spec "Activity (phase 2)"), served as a data table
// (src/lib/table-query.ts): GET /ui/api/activity speaks the table contract
// (page, size, sort, q, f.<col>) with a real total.
//
// Every source is one arm of a single UNION ALL subquery that projects the
// same columns (`id`, `ts` in unix ms, `src`, `key`, `kind`, `status`,
// `problem` 0/1, `dj`, `set_url`, `video_id`, `search`, `j`), so SQLite does
// the merge: one COUNT(*) and one sorted, paged SELECT over all sources, with
// every filter pushed into each arm. `j` carries the raw fields a row's title
// and detail are built from (in `mapRow`, in the Worker). The D1 sources are
// now_playing_audit, playlist_additions, playlist_removals, mkvid_requests
// (settled ones), mkvid_claims (with its request or track upload),
// pool_events and sub_sync. IP-block episodes live in KV (`ban:ep:*`): the
// newest BAN_SCAN keys are listed, their bodies read in parallel (at most
// BAN_SCAN KV reads per request, skipped when the filters rule ban rows out
// or the time filter ends before a key), and they join the union as one
// JSON bind read through json_each.
//
// Limits: sortable columns are the stored ones (time, kind, source, status,
// problem, DJ); the title is built in the Worker, so it is neither sortable
// nor filterable. `q` matches the raw stored text a row's title and detail
// come from (the request summary JSON, set URL, slug, set title, error,
// removal reason code, pool event type, sync error), not the rendered label.
// The primary key `<src>:<zero-padded key>` breaks ties.
// Read-only: nothing here writes D1 or KV.
import type { Env } from '../types'
import { dbOf, parseJson } from './db'
import { REASON_LABELS } from './playlist-hygiene'
import { buildTableSql, parseTableQuery, type TableDef, type TableQuery, type TableResult, type TableParams } from './table-query'

export const ACTIVITY_KINDS = ['request', 'playlist', 'hygiene', 'mkvid', 'pool', 'sync', 'ban'] as const
export type ActivityKind = (typeof ACTIVITY_KINDS)[number]
export const ACTIVITY_SOURCES = ['audit', 'addition', 'removal', 'mkvid', 'claim', 'pool', 'sync', 'ban'] as const
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number]
export type ActivityRow = { id: string; ts: number; kind: ActivityKind; status: string; problem: boolean; title: string; detail: string | null; dj: string | null; setUrl: string | null; videoId: string | null; ref: { kind: ActivitySource; key: string } }

const ACCT_RE = /^acct-\d+$/
const DETAIL_MAX = 200
/** Ban episode keys are `ban:ep:<invertedTs(ms)>` (lib/cache.ts invertedTs). */
const BAN_PREFIX = 'ban:ep:'
const BAN_SCAN = 100
const INVERT_BASE = 10_000_000_000_000

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

// ── the union ──

/** Zero-padded integer key, so the text primary key orders like the number. */
const pk = (src: string, idSql: string) => `'${src}:' || printf('%012d', ${idSql})`
/** Concatenated search text, NULLs as ''. */
const cat = (...parts: string[]) => parts.map((p) => `COALESCE(${p}, '')`).join(` || ' ' || `)

const ARMS: string[] = [
  `SELECT ${pk('audit', 'id')} AS id, ts AS ts, 'audit' AS src, CAST(id AS TEXT) AS key, 'request' AS kind, status AS status,
     (CASE WHEN status IN ('no_video','no_tracklist','upstream_error') OR json_extract(summary, '$.impossible') = 1 THEN 1 ELSE 0 END) AS problem,
     NULL AS dj, NULL AS set_url, NULL AS video_id, summary AS search, summary AS j
   FROM now_playing_audit`,
  `SELECT ${pk('addition', 'id')}, ts, 'addition', CAST(id AS TEXT), 'playlist', status,
     (CASE WHEN status IN ('failed','abandoned') THEN 1 ELSE 0 END),
     slug, set_url, video_id, ${cat('slug', 'set_url', 'summary')}, summary
   FROM playlist_additions`,
  `SELECT ${pk('removal', 'id')}, at * 1000, 'removal', CAST(id AS TEXT), 'hygiene', status,
     (CASE WHEN status = 'failed' THEN 1 ELSE 0 END),
     slug, set_url, video_id, ${cat('source', 'reason', 'detail', 'playlist_kind', 'slug', 'set_url')},
     json_object('source', source, 'reason', reason, 'detail', detail, 'playlist_kind', playlist_kind)
   FROM playlist_removals`,
  `SELECT 'mkvid:' || id, updated_at * 1000, 'mkvid', id, 'mkvid', status,
     (CASE WHEN status IN ('failed','banned') THEN 1 ELSE 0 END),
     slug, set_url, video_id, ${cat('set_title', 'slug', 'set_url', 'error')},
     json_object('set_title', set_title, 'error', error)
   FROM mkvid_requests WHERE status IN ('done','failed','banned','superseded')`,
  // A track upload's claim (request_id 'track:<id>', lib/track-uploads.ts) has no mkvid_requests row: name the track instead.
  `SELECT ${pk('claim', 'c.id')}, c.claimed_at * 1000, 'claim', CAST(c.id AS TEXT), 'mkvid',
     (CASE WHEN c.refunded_at IS NOT NULL THEN 'refunded' ELSE 'claimed' END), 0,
     r.slug, r.set_url, COALESCE(r.video_id, tu.video_id), ${cat('r.set_title', 'r.slug', 'r.set_url', 'c.account', 'tu.artist', 'tu.title')},
     json_object('account', c.account, 'recreate', c.recreate, 'refunded', c.refunded_at IS NOT NULL, 'set_title', r.set_title, 'tu_id', tu.id, 'tu_artist', tu.artist, 'tu_title', tu.title)
   FROM mkvid_claims c LEFT JOIN mkvid_requests r ON r.id = c.request_id
   LEFT JOIN track_uploads tu ON c.request_id LIKE 'track:%' AND tu.id = CAST(SUBSTR(c.request_id, 7) AS INTEGER)`,
  // Pool account ids are acct-N only; anything else (a username, an email) is neither searched nor shown.
  `SELECT ${pk('pool', 'id')}, received_at * 1000, 'pool', CAST(id AS TEXT), 'pool', type,
     (CASE WHEN type IN ('account.flagged','account.retired','challenge.expired') OR push_status = 'failed' THEN 1 ELSE 0 END),
     NULL, NULL, NULL, ${cat('type', "CASE WHEN account_id GLOB 'acct-[0-9]*' THEN account_id END", 'challenge_id')},
     json_object('type', type, 'challenge_id', challenge_id, 'account_id', account_id, 'payload', payload, 'push_status', push_status)
   FROM pool_events`,
  `SELECT 'sync:' || slug, last_run_at * 1000, 'sync', slug, 'sync',
     (CASE WHEN last_error IS NOT NULL AND last_error != '' THEN 'error' ELSE 'ok' END),
     (CASE WHEN last_error IS NOT NULL AND last_error != '' THEN 1 ELSE 0 END),
     slug, NULL, NULL, ${cat('artist_name', 'slug', 'last_error')},
     json_object('artist_name', artist_name, 'last_error', last_error)
   FROM sub_sync WHERE last_run_at IS NOT NULL`,
  // IP-block episodes from KV, prepared in the Worker (banRows) and bound as one JSON array.
  `SELECT 'ban:' || json_extract(value, '$.key'), json_extract(value, '$.ts'), 'ban', json_extract(value, '$.key'), 'ban',
     json_extract(value, '$.status'), json_extract(value, '$.problem'),
     NULL, NULL, NULL, json_extract(value, '$.search'), value
   FROM json_each(?)`,
]
/**
 * D1 refuses a compound SELECT with more than a handful of terms ("too many
 * terms in compound SELECT"; plain SQLite allows 500), so the arms are nested:
 * groups of COMPOUND_MAX arms, each its own subquery, joined by one more
 * UNION ALL. Filters still push down into every arm.
 */
export const COMPOUND_MAX = 4
const groups: string[][] = []
for (let i = 0; i < ARMS.length; i += COMPOUND_MAX) groups.push(ARMS.slice(i, i + COMPOUND_MAX))
export const UNION_FROM = `(${groups.map((g) => `SELECT * FROM (${g.join('\nUNION ALL\n')})`).join('\nUNION ALL\n')}) AS a`

type RawRow = { id: string; ts: number; src: ActivitySource; key: string; kind: ActivityKind; status: string; problem: number; dj: string | null; set_url: string | null; video_id: string | null; j: string | null }

export const ACTIVITY_TABLE: TableDef<RawRow, ActivityRow> = {
  from: UNION_FROM,
  select: 'id, ts, src, key, kind, status, problem, dj, set_url, video_id, j',
  primaryKey: 'id',
  defaultSort: '-ts',
  defaultSize: 50,
  columns: {
    id: { type: 'text', filterable: false },
    ts: { type: 'datetime', storage: 'ms' },
    kind: { type: 'enum', options: ACTIVITY_KINDS },
    src: { type: 'enum', options: ACTIVITY_SOURCES },
    status: { type: 'enum' },
    problem: { type: 'bool' },
    dj: { type: 'text' },
    setUrl: { sql: 'set_url', type: 'text', sortable: false },
    videoId: { sql: 'video_id', type: 'text', sortable: false },
    search: { type: 'text', searchable: true, sortable: false, filterable: false },
  },
  mapRow: toActivityRow,
}

/** Parses the table query (throws TableQueryError on a bad one). */
export function parseActivityQuery(params: TableParams): TableQuery {
  return parseTableQuery(params, ACTIVITY_TABLE)
}

// ── rows ──

function auditDetail(s: Record<string, unknown>): string | null {
  const skew = typeof s.skew === 'number' ? s.skew : null
  return joinParts([
    clock(s.cs) + (s.dur ? ` / ${clock(s.dur)}` : ''),
    str(s.via) && `via ${s.via}`,
    s.impossible === true && 'position past end of video',
    skew != null && Math.abs(skew) > 600 && `Δ${clock(skew)} from track start`,
  ])
}

const REMOVAL_SOURCE_LABEL: Record<string, string> = { sweep: 'Sweep', owner: 'Removed by owner', dead: 'Video died', button: 'Remove and replace' }

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

/** The title and detail of one union row, from its stored fields (`j`). */
function describe(r: RawRow): { title: string; detail: string | null } {
  const j = parseJson<Record<string, unknown>>(r.j ?? '', {})
  switch (r.src) {
    case 'audit':
      return { title: str(j.title) ?? '(no title)', detail: auditDetail(j) }
    case 'addition': {
      const cmb = j.cmb === 'failed' || j.cmb === 'unavailable' ? `combined ${j.cmb}` : null
      return { title: labelFromSetUrl(r.set_url), detail: joinParts([str(j.msg) ?? (r.video_id ? `video ${r.video_id}` : null), cmb]) }
    }
    case 'removal': {
      const source = String(j.source ?? ''), reason = String(j.reason ?? '')
      return { title: `${REMOVAL_SOURCE_LABEL[source] ?? source}: ${REASON_LABELS[reason] ?? reason}`, detail: joinParts([clip(str(j.detail)), `${String(j.playlist_kind ?? '')} playlist`]) }
    }
    case 'mkvid':
      return { title: str(j.set_title) || labelFromSetUrl(r.set_url), detail: mkvidDetail({ status: r.status, video_id: r.video_id, error: str(j.error) }) }
    case 'claim': {
      const tuId = j.tu_id == null ? null : Number(j.tu_id)
      const track = tuId != null ? [str(j.tu_artist), str(j.tu_title)].filter(Boolean).join(' – ') || `track upload ${tuId}` : null
      const refunded = j.refunded === 1 || j.refunded === true
      return {
        title: track ? `Track upload claimed: ${track}` : (Number(j.recreate) ? 'Recreate claimed: ' : 'Claimed for render: ') + (str(j.set_title) || labelFromSetUrl(r.set_url)),
        detail: `${String(j.account ?? '?')} account` + (refunded ? ' · given back (failed before upload)' : ''),
      }
    }
    case 'pool': {
      const type = String(j.type ?? r.status)
      const payload = parseJson<Record<string, unknown>>(typeof j.payload === 'string' ? j.payload : '', {})
      const account = typeof j.account_id === 'string' && ACCT_RE.test(j.account_id) ? j.account_id : null
      const push = str(j.push_status)
      return {
        title: POOL_TITLES[type] ?? type,
        detail: joinParts([account, str(j.challenge_id) && `challenge ${j.challenge_id}`, poolReason(payload.reason), (push === 'failed' || push === 'not_configured') && `push ${push}`]),
      }
    }
    case 'sync':
      return { title: `Sync: ${str(j.artist_name) || r.key}`, detail: clip(str(j.last_error)) }
    case 'ban':
      return { title: str(j.title) ?? 'IP block', detail: str(j.detail) }
  }
  return { title: r.status, detail: null }
}

function toActivityRow(r: RawRow): ActivityRow {
  const { title, detail } = describe(r)
  return {
    id: r.id, ts: Number(r.ts), kind: r.kind, status: r.status, problem: Number(r.problem) === 1, title, detail,
    dj: r.dj ?? null, setUrl: r.set_url ?? null, videoId: r.video_id ?? null,
    ref: { kind: r.src, key: r.key },
  }
}

// ── ban episodes (KV) ──

type BanEpisodeView = { endedAt?: string | null; blockedForMs?: number | null; simulated?: boolean; clearedBy?: string | null }
type BanJson = { key: string; ts: number; status: string; problem: 0 | 1; title: string; detail: string | null; search: string }

function banJson(key: string, ts: number, ep: BanEpisodeView): BanJson {
  const simulated = ep.simulated === true
  const open = ep.endedAt == null
  const title = simulated ? 'Simulated IP block' : 'IP block'
  const detail = joinParts([
    typeof ep.blockedForMs === 'number' && ep.blockedForMs > 0 && `blocked ${duration(ep.blockedForMs)}`,
    str(ep.clearedBy) && `cleared by ${ep.clearedBy}`,
    open && 'ongoing',
  ])
  return { key, ts, status: open ? 'open' : 'ended', problem: simulated ? 0 : 1, title, detail, search: `${title} ${detail ?? ''}` }
}

/** Whether a filter set can still let ban rows through (they have kind/src `ban` and no DJ). */
function banPossible(q: TableQuery): boolean {
  for (const f of q.filters) {
    const list = f.value.split('|').map((s) => s.trim())
    if ((f.col === 'kind' || f.col === 'src') && ((f.op === 'in' && !list.includes('ban')) || (f.op === 'nin' && list.includes('ban')) || f.op === 'empty')) return false
    if ((f.col === 'dj' || f.col === 'setUrl' || f.col === 'videoId') && ['eq', 'has', 'sw', 'ew', 'nempty'].includes(f.op)) return false
  }
  return true
}

/** The earliest ts the filters allow (a cheap bound used to skip KV reads), or null. */
function tsLowerBound(q: TableQuery): number | null {
  let lo: number | null = null
  for (const f of q.filters) {
    if (f.col !== 'ts') continue
    let v: number | null = null
    if (f.op === 'gt' || f.op === 'gte' || f.op === 'eq') v = Number(f.value)
    else if (f.op === 'between') { const a = f.value.split('..')[0]?.trim(); v = a ? Number(a) : null }
    if (v != null && Number.isFinite(v)) lo = lo == null ? v : Math.max(lo, v)
  }
  return lo
}

async function banRows(env: Env, q: TableQuery): Promise<BanJson[]> {
  if (!banPossible(q)) return []
  const page = await env.CACHE.list({ prefix: BAN_PREFIX, limit: BAN_SCAN })
  const lo = tsLowerBound(q)
  const keys: Array<{ key: string; ts: number }> = []
  for (const k of page.keys) {
    const inverted = Number(k.name.slice(BAN_PREFIX.length))
    if (!Number.isFinite(inverted)) continue
    const ts = INVERT_BASE - inverted
    if (lo != null && ts < lo) continue
    keys.push({ key: k.name, ts })
  }
  const eps = await Promise.all(keys.map((k) => env.CACHE.get<BanEpisodeView>(k.key, 'json')))
  const out: BanJson[] = []
  keys.forEach((k, i) => { const ep = eps[i]; if (ep) out.push(banJson(k.key, k.ts, ep)) })
  return out
}

// ── the query ──

/** One page of the merged log: a COUNT over the union and one sorted, paged SELECT. */
export async function listActivity(env: Env, q: TableQuery): Promise<TableResult<ActivityRow>> {
  const bans = JSON.stringify(await banRows(env, q))
  const b = buildTableSql(ACTIVITY_TABLE, q)
  const db = dbOf(env)
  const count = await db.prepare(b.countSql).bind(bans, ...b.binds).first<{ n: number }>()
  const total = Number(count?.n ?? 0)
  const pageCount = Math.max(1, Math.ceil(total / q.size))
  const page = Math.min(q.page, pageCount)
  let rows: RawRow[] = []
  if (total > 0) {
    const p = b.pageSql(q.size, (page - 1) * q.size)
    rows = (await db.prepare(p.sql).bind(bans, ...p.binds).all<RawRow>()).results ?? []
  }
  return { rows: rows.map(toActivityRow), total, page, size: q.size, pageCount, sort: b.sort, filters: q.filters, q: q.q }
}
