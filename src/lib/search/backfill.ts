/**
 * Admin backfill of the search index from trusted mkvid track lists
 * (POST /ui/api/search/backfill, the Tools "Search index" card).
 *
 * Rules:
 *   - Source: mkvid_request_tracks rows with `trusted = 1`, joined to their
 *     request and to a `set_verification` row in state 'verified', keyset
 *     paged by `set_url` (the cursor is the last set_url handled; '' starts
 *     from the beginning). `trusted = 1` means the list passed the decoy
 *     check with evidence, and `verified` means two accounts agreed on the
 *     set's page; together they stand in for the fingerprint match a live
 *     fetch is indexed under (the mkvid list is not the page itself, so its
 *     fingerprint cannot be recomputed here).
 *   - Never reads KV and never runs from the cron: it is an admin press only.
 *     The main DB is only read; every write goes to SEARCH_DB (via indexSet).
 *   - Skip (counted as `skipped`, no writes): a search_sets row exists with
 *     source 'page', or with source 'mkvid' and indexed_at at or after both
 *     verified_at and INDEX_FORMAT_SINCE.
 *     Existing rows for the page are read in chunks of 50 binds.
 *   - Tracks: the list's JSON is parsed defensively; rows that are `isId` or
 *     lack an artist or title are dropped. No track ids or urls (the mkvid
 *     list has none), so a track is keyed by the hash of its artist + title.
 *   - One indexSet per set, sequentially. Before each set the backfill stops,
 *     returning done: false and the cursor of the last finished set, when the
 *     deadline has passed or the D1 query budget (BACKFILL_QUERY_BUDGET, below
 *     the 1000 queries a Worker invocation may issue; batched statements may
 *     each count) could not cover the set's 13 statements.
 *   - An indexSet error on one set is logged (search.backfill_set_failed),
 *     counted as skipped, and the backfill moves on.
 *   - done: true when the page returned fewer than `limit` rows and the loop
 *     finished.
 */
import type { Env } from '../../types'
import { dbOf, parseJson } from '../db'
import { errorFields, makeLogger } from '../log'
import { prettifySlug } from '../prettify-slug'
import { searchDbOf } from './db'
import { INDEX_FORMAT_SINCE, indexSet, type IndexTrack } from './index'
import { usableImageUrl } from './images'
import { slugWords } from './normalize'

/** D1 queries one invocation may spend on the backfill (the platform allows 1000). */
export const BACKFILL_QUERY_BUDGET = 800
/** Statements indexSet issues per set: 2 reads plus one batch of 12. */
const QUERIES_PER_SET = 14
const IN_CHUNK = 50

type SourceRow = {
  set_url: string
  slug: string
  artist_name: string | null
  set_title: string | null
  set_date: string | null
  video_id: string | null
  tracks: string
  track_count: number
  verified_at: number | null
}

type MkvidListTrack = { cueSeconds?: unknown; artist?: unknown; title?: unknown; artworkUrl?: unknown; isId?: unknown; layered?: unknown }

const str = (x: unknown) => (typeof x === 'string' ? x.trim() : '')

export async function backfillSearch(
  env: Env,
  opts: { cursor: string | null; limit: number; deadlineMs: number; nowSec?: number; queryBudget?: number },
): Promise<{ indexed: number; skipped: number; cursor: string | null; done: boolean }> {
  const sdb = searchDbOf(env)
  const log = makeLogger({ route: 'search.backfill' })
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000)
  const budget = opts.queryBudget ?? BACKFILL_QUERY_BUDGET
  const start = opts.cursor ?? ''
  let cursor = start
  const result = (indexed: number, skipped: number, done: boolean) => ({ indexed, skipped, cursor: cursor === '' ? null : cursor, done })

  const page = (
    await dbOf(env)
      .prepare(
        `SELECT r.set_url, r.slug, r.artist_name, r.set_title, r.set_date, r.video_id, k.tracks, k.track_count, v.verified_at
           FROM mkvid_request_tracks k
           JOIN mkvid_requests r ON r.id = k.request_id
           JOIN set_verification v ON v.url = r.set_url AND v.state = 'verified'
          WHERE k.trusted = 1 AND r.set_url > ?
          ORDER BY r.set_url LIMIT ?`,
      )
      .bind(start, opts.limit)
      .all<SourceRow>()
  ).results
  let used = 1

  const existing = new Map<string, { source: string; indexed_at: number }>()
  for (let i = 0; i < page.length; i += IN_CHUNK) {
    const urls = page.slice(i, i + IN_CHUNK).map((r) => r.set_url)
    const rows = (
      await sdb
        .prepare(`SELECT set_url, source, indexed_at FROM search_sets WHERE set_url IN (${urls.map(() => '?').join(',')})`)
        .bind(...urls)
        .all<{ set_url: string; source: string; indexed_at: number }>()
    ).results
    used++
    for (const r of rows) existing.set(r.set_url, r)
  }

  let indexed = 0
  let skipped = 0
  for (const r of page) {
    const have = existing.get(r.set_url)
    if (have && (have.source === 'page' || (have.source === 'mkvid' && have.indexed_at >= Math.max(r.verified_at ?? 0, INDEX_FORMAT_SINCE)))) {
      skipped++
      cursor = r.set_url
      continue
    }
    if (Date.now() >= opts.deadlineMs || used + QUERIES_PER_SET > budget) return result(indexed, skipped, false)

    const list = parseJson<unknown>(r.tracks, null)
    const rows = Array.isArray(list) ? (list as MkvidListTrack[]) : []
    const tracks: IndexTrack[] = []
    let idedCount = 0
    for (const t of rows) {
      if (!t || typeof t !== 'object' || t.isId) continue
      idedCount++
      const artist = str(t.artist)
      const title = str(t.title)
      if (!artist || !title) continue
      tracks.push({ trackId: null, trackUrl: null, artist, title, label: null, artworkUrl: usableImageUrl(typeof t.artworkUrl === 'string' ? t.artworkUrl : null), cueSeconds: typeof t.cueSeconds === 'number' ? t.cueSeconds : null, layered: t.layered === true })
    }
    used += QUERIES_PER_SET
    try {
      await indexSet(
        env,
        {
          setUrl: r.set_url,
          djSlug: r.slug,
          djName: r.artist_name ?? prettifySlug(r.slug),
          title: r.set_title ?? slugWords(r.set_url),
          setDate: r.set_date,
          videoId: r.video_id,
          videoSource: r.video_id ? 'mkvid' : null,
          trackCount: r.track_count,
          idedCount,
          source: 'mkvid',
          imageUrl: null,
          tracks,
        },
        nowSec,
      )
      indexed++
    } catch (e) {
      log.warn('search.backfill_set_failed', { setUrl: r.set_url, ...errorFields(e) })
      skipped++
    }
    cursor = r.set_url
  }
  return result(indexed, skipped, page.length < opts.limit)
}

export async function searchIndexStatus(env: Env): Promise<{ sets: number; tracks: number; vocab: number; lastIndexedAt: number | null }> {
  const db = searchDbOf(env)
  const n = async (sql: string) => (await db.prepare(sql).first<{ n: number | null }>())?.n ?? null
  const [sets, tracks, vocab, last] = await Promise.all([
    n('SELECT COUNT(*) AS n FROM search_sets'),
    n('SELECT COUNT(*) AS n FROM search_tracks'),
    n('SELECT COUNT(*) AS n FROM search_vocab'),
    n('SELECT MAX(indexed_at) AS n FROM search_sets'),
  ])
  return { sets: sets ?? 0, tracks: tracks ?? 0, vocab: vocab ?? 0, lastIndexedAt: last }
}

/** Lazy-links write-back: a found YouTube link lands on the indexed track. Errors are swallowed; a no-op without SEARCH_DB. */
export async function noteTrackYoutubeLinks(env: Env, links: Record<string, { youtubeLink: string | null }>): Promise<void> {
  if (!env.SEARCH_DB) return
  try {
    const stmts = Object.entries(links)
      .filter(([, l]) => typeof l?.youtubeLink === 'string' && l.youtubeLink)
      .map(([id, l]) =>
        env.SEARCH_DB!.prepare('UPDATE search_tracks SET youtube_link = ? WHERE track_id = ? AND (youtube_link IS NULL OR youtube_link <> ?)').bind(l.youtubeLink, id, l.youtubeLink),
      )
    if (stmts.length) await env.SEARCH_DB.batch(stmts)
  } catch {
    // best effort
  }
}
