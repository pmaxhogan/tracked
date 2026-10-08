/**
 * Renamed tracklists. 1001tracklists renames a set's URL now and then (a venue
 * added to the slug: `…/1y2us4k1/odd-mob-gallagher-square-united-states-…` became
 * `…/1y2us4k1/odd-mob-gallagher-square-san-diego-united-states-…`) and redirects
 * the old URL to the new one. Discovery saw the new URL on the DJ page as a set
 * it had never seen, so the set was tracked twice: two rows everywhere, two
 * search hits, every recheck fetched twice.
 *
 * The id segment is the set's identity. When a DJ's URLs hold one id more than
 * once, the URL discovered last wins (it is the one the DJ page lists now; the
 * older one only redirects to it), and the others are folded into it: their
 * state merges into the winner's and their rows move to it (or are dropped
 * when the winner already has one).
 */
import type { Env } from '../types'
import { dbOf } from './db'
import type { Logger } from './log'
import { tracklistIdOf } from './mkvid'
import { searchDbOf } from './search/db'
import type { SubState, TracklistVideo } from './sync-store'

export type TracklistRename = { from: string; to: string }

/** For each tracklist id listed more than once, every earlier URL → the last one. */
export function findRenamedTracklists(urls: readonly string[]): TracklistRename[] {
  const last = new Map<string, string>()
  for (const u of urls) {
    const id = tracklistIdOf(u)
    if (id) last.set(id, u)
  }
  const out: TracklistRename[] = []
  const seen = new Set<string>()
  for (const u of urls) {
    const id = tracklistIdOf(u)
    const to = id ? last.get(id) : undefined
    if (to && to !== u && !seen.has(u)) {
      seen.add(u)
      out.push({ from: u, to })
    }
  }
  return out
}

/**
 * Fold each renamed URL into its winner in memory: the winner counts as
 * processed if either was, and keeps its own video record unless the loser's
 * has a video the winner lacks. Mutates `state`, `tracklistVideos` and `discovered`.
 */
export function mergeRenamedState(
  state: SubState,
  tracklistVideos: Record<string, TracklistVideo>,
  discovered: Set<string>,
  renames: readonly TracklistRename[],
): void {
  if (renames.length === 0) return
  const processed = new Set(state.processedTracklistUrls)
  const abandoned = new Set(state.abandonedTracklistUrls ?? [])
  const failureCounts = state.failureCounts ?? {}
  for (const { from, to } of renames) {
    if (processed.has(from)) processed.add(to)
    const rec = tracklistVideos[from]
    const own = tracklistVideos[to]
    // The winner's own record stands unless the loser knows more (a video where the winner has none).
    if (rec && (!own || (!own.videoId && rec.videoId) || (own.videoId === undefined && rec.videoId !== undefined))) tracklistVideos[to] = rec
    // A processed winner is never abandoned; otherwise the loser's give-up stands for the set.
    if (abandoned.has(from) && !processed.has(to)) abandoned.add(to)
    processed.delete(from)
    abandoned.delete(from)
    delete failureCounts[from]
    delete tracklistVideos[from]
    discovered.delete(from)
  }
  for (const u of processed) if (abandoned.has(u)) abandoned.delete(u)
  state.processedTracklistUrls = [...processed]
  state.abandonedTracklistUrls = [...abandoned]
  state.failureCounts = failureCounts
  state.discoveredTracklistUrls = (state.discoveredTracklistUrls ?? []).filter((u) => discovered.has(u))
}

/** Rows keyed by a set's URL: the loser's row moves to the winner unless the winner has one, then it goes. */
const PER_SET_TABLES: ReadonlyArray<[table: string, column: string]> = [
  ['set_schedule', 'url'],
  ['set_verification', 'url'],
  ['render_feed', 'url'],
  ['set_media_facts', 'set_url'],
]
/** History naming the set: repointed so the set's diagnostics stay whole. */
const HISTORY_TABLES: ReadonlyArray<[table: string, column: string]> = [
  ['playlist_additions', 'set_url'],
  ['playlist_removals', 'set_url'],
  ['removed_videos', 'set_url'],
  ['mkvid_old_videos', 'set_url'],
]

/**
 * Retire each loser URL in D1: its tracklists row goes, its per-set rows move
 * to the winner (or go when the winner has its own), history is repointed, and
 * its mkvid request moves unless the winner has one (one request per URL; the
 * twin guard keyed by tracklist id already kept the pair from both rendering).
 * The search index drops the loser's set, or renames it when only the loser
 * was indexed. The winner's own tracklists row is written by saveSubState.
 */
export async function retireRenamedTracklists(env: Env, slug: string, renames: readonly TracklistRename[], log: Logger): Promise<void> {
  if (renames.length === 0) return
  const db = dbOf(env)
  const statements: D1PreparedStatement[] = []
  for (const { from, to } of renames) {
    statements.push(db.prepare('DELETE FROM tracklists WHERE slug = ? AND url = ?').bind(slug, from))
    for (const [table, col] of PER_SET_TABLES) {
      statements.push(db.prepare(`UPDATE OR IGNORE ${table} SET ${col} = ? WHERE ${col} = ?`).bind(to, from))
      statements.push(db.prepare(`DELETE FROM ${table} WHERE ${col} = ?`).bind(from))
    }
    for (const [table, col] of HISTORY_TABLES) statements.push(db.prepare(`UPDATE OR IGNORE ${table} SET ${col} = ? WHERE ${col} = ?`).bind(to, from))
    statements.push(db.prepare('UPDATE OR IGNORE mkvid_requests SET set_url = ? WHERE set_url = ?').bind(to, from))
  }
  await db.batch(statements)
  if (env.SEARCH_DB) {
    for (const r of renames) await retireFromSearch(env, r)
  }
  log.info('sync.tracklist_renamed', { slug, renames })
}

async function retireFromSearch(env: Env, { from, to }: TracklistRename): Promise<void> {
  const sdb = searchDbOf(env)
  const winnerIndexed = await sdb.prepare('SELECT 1 AS x FROM search_sets WHERE set_url = ?').bind(to).first()
  if (!winnerIndexed) {
    await sdb.batch([
      sdb.prepare('UPDATE OR IGNORE search_sets SET set_url = ? WHERE set_url = ?').bind(to, from),
      sdb.prepare('UPDATE OR IGNORE search_track_sets SET set_url = ? WHERE set_url = ?').bind(to, from),
    ])
    return
  }
  const keys = JSON.stringify(
    (await sdb.prepare('SELECT track_key FROM search_track_sets WHERE set_url = ?').bind(from).all<{ track_key: string }>()).results.map((r) => r.track_key),
  )
  await sdb.batch([
    sdb.prepare('DELETE FROM sets_fts WHERE rowid = (SELECT id FROM search_sets WHERE set_url = ?)').bind(from),
    sdb.prepare('DELETE FROM search_sets WHERE set_url = ?').bind(from),
    sdb.prepare('DELETE FROM search_track_sets WHERE set_url = ?').bind(from),
    sdb
      .prepare('UPDATE search_tracks SET sets_count = (SELECT COUNT(*) FROM search_track_sets ts WHERE ts.track_key = search_tracks.track_key) WHERE track_key IN (SELECT value FROM json_each(?))')
      .bind(keys),
    sdb
      .prepare('DELETE FROM tracks_fts WHERE rowid IN (SELECT id FROM search_tracks WHERE sets_count = 0 AND track_key IN (SELECT value FROM json_each(?)))')
      .bind(keys),
  ])
}
