/**
 * The Stats page (/ui/stats, GET /ui/api/stats): every count the app keeps,
 * in one answer, for a grid of cards and charts.
 *
 * Rules:
 *   - Read-only: one batch on the main DB, one on SEARCH_DB, and tlpool's
 *     /status (best effort, 4 s; absent when tlpool is not configured or slow).
 *   - Cached in CACHE KV for STATS_CACHE_SECONDS; `fresh` recomputes.
 *   - Daily series cover the last DAYS UTC days, zero-filled, oldest first,
 *     from the timestamps the tables already keep (each table's own unit).
 *   - Numbers with no history of their own (sets with a video, searchable
 *     sets, ...) come over time from `stats_snapshots`: the 5-minute cron
 *     writes one an hour (maybeSnapshotStats), kept SNAPSHOT_KEEP_DAYS.
 */
import type { Env } from '../types'
import { dbOf } from './db'
import { errorFields, type Logger } from './log'
import { createPoolAdminClient } from './pool-admin-client'
import { CANDIDATE_PRESAVE_SQL } from './presave-candidates'

export const DAYS = 60
export const STATS_CACHE_KEY = 'stats:v1'
export const STATS_CACHE_SECONDS = 300
export const SNAPSHOT_STAMP_KEY = 'stats:snapshot_at'
const SNAPSHOT_KEEP_DAYS = 400
const SNAPSHOT_SHOW_DAYS = 90
const HOUR = 3600
const DAY = 86400

/** [UTC day 'YYYY-MM-DD', count], oldest first. */
export type DaySeries = Array<[string, number]>
export type Labeled = Array<{ label: string; value: number }>

/** The headline numbers a snapshot keeps (a subset of `cards`). */
export const SNAPSHOT_KEYS = [
  'djs', 'sets', 'setsWithVideo', 'setsMkvid', 'setsVerified', 'searchSets', 'searchTracks', 'searchLinks',
  'playlistVideos', 'mkvidDone', 'mkvidPending', 'presavesWatching', 'presavesFound', 'candidates', 'candidatePresaves',
  'poolAccounts', 'poolRequestsToday',
] as const

export type StatsResponse = {
  generatedAt: number
  days: number
  cards: Record<string, number | null>
  daily: Record<string, DaySeries>
  /** Cumulative DJs followed, by the day each was added (all time). */
  djsOverTime: DaySeries
  /** The scheduler's last 48 h, per hour: items run by kind, and refused (stopped) ones. */
  hourly: Array<{ hour: string; kinds: Record<string, number>; stopped: number }>
  snapshots: Array<{ at: number; data: Record<string, number> }>
  breakdowns: {
    setsPerDj: Array<{ slug: string; name: string; sets: number; withVideo: number; searchable: number }>
    setYears: Labeled
    videoSources: Labeled
    verification: Labeled
    mkvidStatus: Labeled
    mkvidSource: Labeled
    mkvidAccount: Labeled
    presaveStages: Labeled
    presaveLinkSources: Labeled
    trackUploads: Labeled
    removedReasons: Labeled
    playlistAdds: Labeled
    nowPlaying: Labeled
    searchSources: Labeled
    poolStates: Labeled
    poolByPriority: Labeled
  }
  topCandidates: Array<{ key: string; artist: string | null; title: string | null; count: number; isId: boolean; trackUrl: string | null; setUrl: string; presaveId: number | null }>
  pool: { ok: boolean; error?: string }
}

const utcDay = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10)

/** The last `days` UTC days, oldest first, each with the count `rows` gave it (0 when none). */
export function fillDays(rows: Array<{ d: string; n: number }>, nowSec: number, days = DAYS): DaySeries {
  const by = new Map(rows.map((r) => [r.d, Number(r.n) || 0]))
  const out: DaySeries = []
  for (let i = days - 1; i >= 0; i--) {
    const d = utcDay(nowSec - i * DAY)
    out.push([d, by.get(d) ?? 0])
  }
  return out
}

const labeled = (rows: Array<{ k: string | null; n: number }>, fallback = 'none'): Labeled =>
  rows.map((r) => ({ label: r.k ?? fallback, value: Number(r.n) || 0 })).sort((a, b) => b.value - a.value)

const num = (x: unknown): number => Number(x) || 0
const sumOf = (l: Labeled, ...labels: string[]) => l.filter((x) => labels.includes(x.label)).reduce((n, x) => n + x.value, 0)

type R = Record<string, unknown>

export async function computeStats(env: Env, nowSec = Math.floor(Date.now() / 1000), log?: Logger): Promise<StatsResponse> {
  const db = dbOf(env)
  const since = nowSec - DAYS * DAY
  const day = (expr: string) => `date(${expr}, 'unixepoch')`
  const Q: Array<[string, D1PreparedStatement]> = [
    ['djs', db.prepare('SELECT COUNT(*) AS n FROM subscriptions')],
    ['djsAdded', db.prepare(`SELECT ${day('added_at')} AS d, COUNT(*) AS n FROM subscriptions GROUP BY d ORDER BY d`)],
    ['sets', db.prepare(
      `SELECT COUNT(DISTINCT url) AS total, COUNT(DISTINCT CASE WHEN processed = 1 THEN url END) AS processed,
              COUNT(DISTINCT CASE WHEN video_id IS NOT NULL THEN url END) AS with_video,
              COUNT(DISTINCT CASE WHEN video_source = 'mkvid' THEN url END) AS mkvid,
              COUNT(DISTINCT CASE WHEN video_source = '1001tl' THEN url END) AS tl,
              COUNT(DISTINCT CASE WHEN abandoned = 1 THEN url END) AS abandoned
         FROM tracklists`)],
    ['perDj', db.prepare(
      `SELECT t.slug AS slug, MAX(s.artist_name) AS name, COUNT(DISTINCT t.url) AS sets, COUNT(DISTINCT CASE WHEN t.video_id IS NOT NULL THEN t.url END) AS wv
         FROM tracklists t LEFT JOIN sub_sync s ON s.slug = t.slug GROUP BY t.slug`)],
    ['setYears', db.prepare("SELECT substr(set_date, 1, 4) AS k, COUNT(*) AS n FROM set_schedule WHERE set_date IS NOT NULL GROUP BY k")],
    ['discovered', db.prepare(`SELECT ${day('discovered_at')} AS d, COUNT(DISTINCT url) AS n FROM tracklists WHERE discovered_at >= ? GROUP BY d`).bind(since)],
    ['verif', db.prepare('SELECT state AS k, COUNT(*) AS n FROM set_verification GROUP BY state')],
    ['verified', db.prepare(`SELECT ${day('verified_at')} AS d, COUNT(*) AS n FROM set_verification WHERE verified_at >= ? GROUP BY d`).bind(since)],
    ['playlists', db.prepare('SELECT COUNT(*) AS n FROM sub_sync WHERE playlist_id IS NOT NULL')],
    ['members', db.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT playlist_id) AS p FROM playlist_members')],
    ['adds', db.prepare(`SELECT ${day('ts / 1000')} AS d, COUNT(*) AS n FROM playlist_additions WHERE ts >= ? AND status = 'added' GROUP BY d`).bind(since * 1000)],
    ['addStatus', db.prepare('SELECT status AS k, COUNT(*) AS n FROM playlist_additions WHERE ts >= ? GROUP BY status').bind(since * 1000)],
    ['removals', db.prepare(`SELECT ${day('at')} AS d, COUNT(*) AS n FROM playlist_removals WHERE at >= ? AND status = 'removed' GROUP BY d`).bind(since)],
    ['removedReasons', db.prepare('SELECT reason AS k, COUNT(*) AS n FROM removed_videos GROUP BY reason')],
    ['mkvidStatus', db.prepare('SELECT status AS k, COUNT(*) AS n FROM mkvid_requests GROUP BY status')],
    ['mkvidSource', db.prepare("SELECT source AS k, COUNT(*) AS n FROM mkvid_requests WHERE status = 'done' GROUP BY source")],
    ['mkvidAccount', db.prepare("SELECT account AS k, COUNT(*) AS n FROM mkvid_requests WHERE status = 'done' GROUP BY account")],
    ['mkvidDone', db.prepare(`SELECT ${day('updated_at')} AS d, COUNT(*) AS n FROM mkvid_requests WHERE updated_at >= ? AND status = 'done' GROUP BY d`).bind(since)],
    ['mkvidFailed', db.prepare(`SELECT ${day('updated_at')} AS d, COUNT(*) AS n FROM mkvid_requests WHERE updated_at >= ? AND status = 'failed' GROUP BY d`).bind(since)],
    ['mkvidQueued', db.prepare(`SELECT ${day('created_at')} AS d, COUNT(*) AS n FROM mkvid_requests WHERE created_at >= ? GROUP BY d`).bind(since)],
    ['presaveStages', db.prepare('SELECT stage AS k, COUNT(*) AS n FROM presaves GROUP BY stage')],
    ['presaveLinks', db.prepare("SELECT link_sources AS s FROM presaves WHERE stage IN ('identify', 'links')")],
    ['presavesAdded', db.prepare(`SELECT ${day('created_at / 1000')} AS d, COUNT(*) AS n FROM presaves WHERE created_at >= ? GROUP BY d`).bind(since * 1000)],
    ['presavesFound', db.prepare(`SELECT ${day('found_at / 1000')} AS d, COUNT(*) AS n FROM presaves WHERE found_at >= ? GROUP BY d`).bind(since * 1000)],
    ['cand', db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(presave_count), 0) AS total, COALESCE(MAX(presave_count), 0) AS mx, COALESCE(SUM(is_id), 0) AS ids FROM presave_candidates')],
    ['candTop', db.prepare(
      `SELECT c.key AS key, c.artist AS artist, c.title AS title, c.presave_count AS n, c.is_id AS is_id, c.track_url AS track_url, c.set_url AS set_url, ${CANDIDATE_PRESAVE_SQL} AS presave_id
         FROM presave_candidates c ORDER BY c.presave_count DESC, c.key LIMIT 12`)],
    ['candSeen', db.prepare(`SELECT ${day('first_seen_at / 1000')} AS d, COUNT(*) AS n FROM presave_candidates WHERE first_seen_at >= ? GROUP BY d`).bind(since * 1000)],
    ['trackUploads', db.prepare('SELECT status AS k, COUNT(*) AS n FROM track_uploads GROUP BY status')],
    ['nowPlaying', db.prepare(`SELECT ${day('ts / 1000')} AS d, COUNT(*) AS n FROM now_playing_audit WHERE ts >= ? GROUP BY d`).bind(since * 1000)],
    ['nowPlayingStatus', db.prepare('SELECT status AS k, COUNT(*) AS n FROM now_playing_audit WHERE ts >= ? GROUP BY status').bind(since * 1000)],
    ['poolEvents', db.prepare(`SELECT ${day('received_at')} AS d, COUNT(*) AS n FROM pool_events WHERE received_at >= ? GROUP BY d`).bind(since)],
    ['ticks', db.prepare('SELECT at, items, stopped_by FROM scheduler_ticks WHERE at >= ? ORDER BY at').bind(nowSec - 48 * HOUR)],
    ['snapshots', db.prepare('SELECT at, data FROM stats_snapshots WHERE at >= ? ORDER BY at').bind(nowSec - SNAPSHOT_SHOW_DAYS * DAY)],
  ]
  const sdb = env.SEARCH_DB ?? null
  const S: Array<[string, D1PreparedStatement]> = sdb
    ? [
        ['sets', sdb.prepare('SELECT COUNT(*) AS n FROM search_sets')],
        ['sources', sdb.prepare('SELECT source AS k, COUNT(*) AS n FROM search_sets GROUP BY source')],
        ['tracks', sdb.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(sets_count > 0), 0) AS live, COALESCE(SUM(youtube_link IS NOT NULL AND sets_count > 0), 0) AS yt FROM search_tracks')],
        ['links', sdb.prepare('SELECT COUNT(*) AS n FROM search_track_sets')],
        ['vocab', sdb.prepare('SELECT COUNT(*) AS n FROM search_vocab')],
        ['images', sdb.prepare('SELECT COUNT(*) AS n FROM search_images')],
        ['perDj', sdb.prepare('SELECT dj_slug AS slug, COUNT(*) AS n FROM search_sets GROUP BY dj_slug')],
        ['indexed', sdb.prepare(`SELECT ${day('indexed_at')} AS d, COUNT(*) AS n FROM search_sets WHERE indexed_at >= ? GROUP BY d`).bind(since)],
      ]
    : []

  const poolP = (async () => {
    if (!env.TLPOOL_URL || !env.TLPOOL_TOKEN) return { ok: false as const, error: 'not configured' }
    try {
      const status = await Promise.race([
        createPoolAdminClient(env).status(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('tlpool did not answer in 4 s')), 4000)),
      ])
      return { ok: true as const, status }
    } catch (e) {
      log?.warn('stats.pool_status_failed', errorFields(e))
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })()

  const [mainRes, searchRes, pool] = await Promise.all([
    db.batch(Q.map((q) => q[1])),
    S.length ? sdb!.batch(S.map((q) => q[1])) : Promise.resolve([]),
    poolP,
  ])
  const m = Object.fromEntries(Q.map((q, i) => [q[0], (mainRes[i]?.results ?? []) as R[]]))
  const s = Object.fromEntries(S.map((q, i) => [q[0], (searchRes[i]?.results ?? []) as R[]]))
  const one = (rows: R[] | undefined) => (rows?.[0] ?? {}) as R
  const dayRows = (rows: R[] | undefined) => (rows ?? []).map((r) => ({ d: String(r.d), n: num(r.n) }))
  const kRows = (rows: R[] | undefined) => (rows ?? []).map((r) => ({ k: r.k == null ? null : String(r.k), n: num(r.n) }))

  const sets = one(m.sets)
  const verification = labeled(kRows(m.verif))
  const mkvidStatus = labeled(kRows(m.mkvidStatus))
  const presaveStages = labeled(kRows(m.presaveStages))
  const trackUploads = labeled(kRows(m.trackUploads))
  const cand = one(m.cand)
  const searchSources = labeled(kRows(s.sources))
  const stracks = one(s.tracks)

  const searchablePerDj = new Map((s.perDj ?? []).map((r) => [String(r.slug), num(r.n)]))
  const setsPerDj = (m.perDj ?? [])
    .map((r) => ({ slug: String(r.slug), name: r.name ? String(r.name) : String(r.slug), sets: num(r.sets), withVideo: num(r.wv), searchable: searchablePerDj.get(String(r.slug)) ?? 0 }))
    .sort((a, b) => b.sets - a.sets)

  const linkCounts = new Map<string, number>()
  for (const r of m.presaveLinks ?? []) {
    const list = String(r.s ?? '').split(',').filter(Boolean)
    for (const name of list.length ? list : ['none']) linkCounts.set(name, (linkCounts.get(name) ?? 0) + 1)
  }

  // The scheduler's last 48 h, per hour.
  const hours = new Map<string, { kinds: Record<string, number>; stopped: number }>()
  for (let i = 47; i >= 0; i--) hours.set(new Date((nowSec - i * HOUR) * 1000).toISOString().slice(0, 13), { kinds: {}, stopped: 0 })
  for (const r of m.ticks ?? []) {
    const h = hours.get(new Date(num(r.at) * 1000).toISOString().slice(0, 13))
    if (!h) continue
    let items: Array<{ kind?: string; outcome?: string }> = []
    try {
      items = JSON.parse(String(r.items ?? '[]'))
    } catch {
      /* a bad row: no items */
    }
    for (const it of Array.isArray(items) ? items : []) {
      if (it.outcome === 'stopped') h.stopped++
      else if (it.kind) h.kinds[it.kind] = (h.kinds[it.kind] ?? 0) + 1
    }
  }

  const poolStates: Labeled = pool.ok ? labeled([...countBy(pool.status.accounts.map((a) => a.state))].map(([k, n]) => ({ k, n }))) : []
  const poolByPriority: Labeled = pool.ok ? labeled(Object.entries(pool.status.requestsByPriority).map(([k, n]) => ({ k, n: num(n) }))) : []

  let djsCum = 0
  const djsOverTime: DaySeries = dayRows(m.djsAdded).map((r) => [r.d, (djsCum += r.n)])

  const cards: Record<string, number | null> = {
    djs: num(one(m.djs).n),
    sets: num(sets.total),
    setsProcessed: num(sets.processed),
    setsWithVideo: num(sets.with_video),
    setsNoVideo: num(sets.total) - num(sets.with_video),
    setsMkvid: num(sets.mkvid),
    sets1001tl: num(sets.tl),
    setsAbandoned: num(sets.abandoned),
    setsVerified: sumOf(verification, 'verified'),
    setsPending: sumOf(verification, 'pending'),
    searchSets: S.length ? num(one(s.sets).n) : null,
    searchTracks: S.length ? num(stracks.live) : null,
    searchTracksYoutube: S.length ? num(stracks.yt) : null,
    searchLinks: S.length ? num(one(s.links).n) : null,
    searchVocab: S.length ? num(one(s.vocab).n) : null,
    searchImages: S.length ? num(one(s.images).n) : null,
    playlists: num(one(m.playlists).n),
    playlistVideos: num(one(m.members).n),
    mkvidDone: sumOf(mkvidStatus, 'done'),
    mkvidPending: sumOf(mkvidStatus, 'pending', 'claimed'),
    mkvidFailed: sumOf(mkvidStatus, 'failed'),
    mkvidBanned: sumOf(mkvidStatus, 'banned'),
    presavesWatching: sumOf(presaveStages, 'identify', 'links'),
    presavesFound: sumOf(presaveStages, 'found'),
    presavesUploaded: sumOf(presaveStages, 'uploaded'),
    candidates: num(cand.n),
    candidatePresaves: num(cand.total),
    candidateTop: num(cand.mx),
    candidateIds: num(cand.ids),
    trackUploadsDone: sumOf(trackUploads, 'done'),
    trackUploadsPending: sumOf(trackUploads, 'pending', 'claimed'),
    removedVideos: labeled(kRows(m.removedReasons)).reduce((n, x) => n + x.value, 0),
    poolAccounts: pool.ok ? pool.status.accounts.filter((a) => a.state === 'active' || a.state === 'warming').length : null,
    poolRequestsToday: pool.ok ? pool.status.requestsToday : null,
    poolBudgetToday: pool.ok ? pool.status.budgetToday : null,
  }

  return {
    generatedAt: nowSec * 1000,
    days: DAYS,
    cards,
    daily: {
      discovered: fillDays(dayRows(m.discovered), nowSec),
      verified: fillDays(dayRows(m.verified), nowSec),
      indexed: fillDays(dayRows(s.indexed), nowSec),
      playlistAdds: fillDays(dayRows(m.adds), nowSec),
      playlistRemovals: fillDays(dayRows(m.removals), nowSec),
      mkvidDone: fillDays(dayRows(m.mkvidDone), nowSec),
      mkvidFailed: fillDays(dayRows(m.mkvidFailed), nowSec),
      mkvidQueued: fillDays(dayRows(m.mkvidQueued), nowSec),
      presavesAdded: fillDays(dayRows(m.presavesAdded), nowSec),
      presavesFound: fillDays(dayRows(m.presavesFound), nowSec),
      candidatesSeen: fillDays(dayRows(m.candSeen), nowSec),
      nowPlaying: fillDays(dayRows(m.nowPlaying), nowSec),
      poolEvents: fillDays(dayRows(m.poolEvents), nowSec),
    },
    djsOverTime,
    hourly: [...hours].map(([hour, h]) => ({ hour, ...h })),
    snapshots: (m.snapshots ?? []).flatMap((r) => {
      try {
        return [{ at: num(r.at), data: JSON.parse(String(r.data)) as Record<string, number> }]
      } catch {
        return []
      }
    }),
    breakdowns: {
      setsPerDj,
      setYears: kRows(m.setYears).map((r) => ({ label: r.k ?? '?', value: r.n })).sort((a, b) => a.label.localeCompare(b.label)),
      videoSources: [
        { label: '1001tracklists', value: num(sets.tl) },
        { label: 'mkvid', value: num(sets.mkvid) },
        { label: 'other', value: Math.max(0, num(sets.with_video) - num(sets.tl) - num(sets.mkvid)) },
        { label: 'no video', value: num(sets.total) - num(sets.with_video) },
      ],
      verification,
      mkvidStatus,
      mkvidSource: labeled(kRows(m.mkvidSource)),
      mkvidAccount: labeled(kRows(m.mkvidAccount)),
      presaveStages,
      presaveLinkSources: labeled([...linkCounts].map(([k, n]) => ({ k, n }))),
      trackUploads,
      removedReasons: labeled(kRows(m.removedReasons)),
      playlistAdds: labeled(kRows(m.addStatus)),
      nowPlaying: labeled(kRows(m.nowPlayingStatus)),
      searchSources,
      poolStates,
      poolByPriority,
    },
    topCandidates: (m.candTop ?? []).map((r) => ({
      key: String(r.key),
      artist: r.artist == null ? null : String(r.artist),
      title: r.title == null ? null : String(r.title),
      count: num(r.n),
      isId: num(r.is_id) === 1,
      trackUrl: r.track_url == null ? null : String(r.track_url),
      setUrl: String(r.set_url),
      presaveId: r.presave_id == null ? null : num(r.presave_id),
    })),
    pool: pool.ok ? { ok: true } : { ok: false, error: pool.error },
  }
}

function countBy(xs: string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1)
  return m
}

/** The page's answer: the cached copy unless `fresh` or stale. */
export async function getStats(env: Env, opts: { fresh?: boolean; log?: Logger } = {}): Promise<StatsResponse> {
  if (!opts.fresh) {
    try {
      const hit = await env.CACHE.get(STATS_CACHE_KEY)
      if (hit) return JSON.parse(hit) as StatsResponse
    } catch {
      /* recompute */
    }
  }
  const out = await computeStats(env, undefined, opts.log)
  try {
    await env.CACHE.put(STATS_CACHE_KEY, JSON.stringify(out), { expirationTtl: STATS_CACHE_SECONDS })
  } catch {
    /* not cached */
  }
  return out
}

/**
 * The hourly snapshot (from the 5-minute cron): when the last one is from an
 * earlier hour, compute the stats, keep SNAPSHOT_KEYS, prune past
 * SNAPSHOT_KEEP_DAYS. Never throws.
 */
export async function maybeSnapshotStats(env: Env, log?: Logger, nowSec = Math.floor(Date.now() / 1000)): Promise<boolean> {
  try {
    const hour = nowSec - (nowSec % HOUR)
    if ((Number(await env.CACHE.get(SNAPSHOT_STAMP_KEY)) || 0) >= hour) return false
    const stats = await computeStats(env, nowSec, log)
    const data: Record<string, number> = {}
    for (const k of SNAPSHOT_KEYS) if (stats.cards[k] != null) data[k] = stats.cards[k] as number
    const db = dbOf(env)
    await db.batch([
      db.prepare('INSERT OR REPLACE INTO stats_snapshots (at, data) VALUES (?, ?)').bind(hour, JSON.stringify(data)),
      db.prepare('DELETE FROM stats_snapshots WHERE at < ?').bind(nowSec - SNAPSHOT_KEEP_DAYS * DAY),
    ])
    await env.CACHE.put(SNAPSHOT_STAMP_KEY, String(hour), { expirationTtl: 2 * HOUR })
    await env.CACHE.put(STATS_CACHE_KEY, JSON.stringify(stats), { expirationTtl: STATS_CACHE_SECONDS })
    return true
  } catch (e) {
    log?.warn('stats.snapshot_failed', errorFields(e))
    return false
  }
}
