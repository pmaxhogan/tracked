/**
 * The search indexer: writes track lists into SEARCH_DB (migrations-search/).
 *
 * Rules:
 *   - Verified lists only. A live set fetch is indexed when its verification
 *     outcome is 'verified' or 'unchanged' AND its rows' fingerprint is the
 *     set's verified fingerprint (`verifiedFingerprint`). The only other
 *     writer is the admin backfill from trusted mkvid lists (source 'mkvid').
 *   - Never from KV: not the `tl:` cache, not `cacheParsedTracklist`. The
 *     main DB is only read here; every write goes to SEARCH_DB.
 *   - Never pruned. A track a re-index drops from its last set stays in
 *     search_tracks with `sets_count = 0` and no tracks_fts row (never
 *     returned).
 *   - A re-index replaces the set's links: the set's old search_track_sets
 *     rows are deleted and the new ones inserted, and every track touched
 *     (old ∪ new) gets its count and FTS row recomputed, all in one batch.
 *   - The recheck skip rule: a fetch is skipped when the set is already
 *     indexed from a page (`source = 'page'`), at or after its verification
 *     (`indexed_at >= verified_at`), with the same video. A backfilled set
 *     ('mkvid') is always replaced by a live verified fetch.
 *   - Fire-and-forget from the sync path (`queueSearchIndex`), drained via
 *     ctx.waitUntil (`drainSearchIndex`). Errors never reach the caller: they
 *     are logged at warn as `search.index_failed`.
 *
 * `pos` in search_track_sets is the track's 0-based index in the indexed
 * track list (`IndexSetInput.tracks`, i.e. after anonymous, unidentified and
 * nameless rows are dropped), from its first occurrence in the set.
 */
import type { Env } from '../../types'
import { dbOf } from '../db'
import { errorFields, type Logger } from '../log'
import { extractSetDate, extractSetTitle } from '../mkvid'
import { prettifySlug } from '../prettify-slug'
import type { PageRow, ScrapedTracklist } from '../tracklists1001'
import { tracklistFingerprint, verifiedFingerprint, type VerificationOutcome } from '../verification'
import { searchDbOf } from './db'
import { normalizedJoin, normalizeText, slugWords, trackKey } from './normalize'

export type IndexTrack = { trackId: string | null; trackUrl: string | null; artist: string; title: string; label: string | null; cueSeconds: number | null; layered: boolean }

export type IndexSetInput = {
  setUrl: string
  djSlug: string
  djName: string
  title: string
  setDate: string | null
  videoId: string | null
  videoSource: string | null
  trackCount: number
  idedCount: number
  source: 'page' | 'mkvid'
  tracks: IndexTrack[]
}

type VerifiedFetch = { setUrl: string; html: string; parsed: ScrapedTracklist; videoId: string | null; nowSec?: number; log?: Logger }

const nowSeconds = () => Math.floor(Date.now() / 1000)

/** Vocabulary terms are normalized words of at least this many characters. */
const MIN_TERM = 3

/**
 * The indexable tracks of a page, in page order: anonymous and unidentified
 * rows and rows without an artist or title are dropped. A layered ("w/") row
 * carries its own cue. Repeats are kept here; `indexSet` keeps the first.
 */
export function tracksFromRows(rows: readonly PageRow[]): IndexTrack[] {
  const out: IndexTrack[] = []
  for (const r of rows) {
    if (r.anonymous || r.isUnidentified) continue
    const artist = r.artist.trim()
    const title = r.title.trim()
    if (!artist || !title) continue
    out.push({
      trackId: r.trackId,
      trackUrl: r.trackUrl,
      artist,
      title,
      label: r.label,
      cueSeconds: r.isMashupLinked ? r.ownStartSeconds : r.startSeconds,
      layered: r.isMashupLinked,
    })
  }
  return out
}

/** Distinct normalized terms of `texts` with at least MIN_TERM characters, added to `into`. */
function addTerms(into: Set<string>, ...texts: Array<string | null | undefined>): void {
  for (const t of texts) for (const w of normalizeText(t)) if ([...w].length >= MIN_TERM) into.add(w)
}

/**
 * Write one set and its tracks: one SEARCH_DB batch (a transaction) plus at
 * most two reads before it. Throws on DB errors; callers swallow them.
 */
export async function indexSet(env: Env, input: IndexSetInput, nowSec: number): Promise<{ tracks: number }> {
  const sdb = searchDbOf(env)
  const { setUrl } = input

  // New tracks, first occurrence of a key only.
  const tracks: Array<IndexTrack & { key: string; pos: number }> = []
  const seen = new Set<string>()
  for (const t of input.tracks) {
    const key = await trackKey(t)
    if (seen.has(key)) continue
    seen.add(key)
    tracks.push({ ...t, key, pos: tracks.length })
  }

  // Read 1: the tracks this set links now, so their counts and FTS rows get recomputed.
  const old = (
    await sdb
      .prepare('SELECT ts.track_key AS track_key, t.artist AS artist, t.title AS title, t.label AS label FROM search_track_sets ts JOIN search_tracks t USING (track_key) WHERE ts.set_url = ?')
      .bind(setUrl)
      .all<{ track_key: string; artist: string; title: string; label: string | null }>()
  ).results

  // Read 2 (only when needed): the stored label of a new track listed here
  // without one. The upsert keeps it (COALESCE), so its FTS row must carry it.
  const storedLabel = new Map<string, string>()
  for (const o of old) if (o.label) storedLabel.set(o.track_key, o.label)
  const needLabel = tracks.filter((t) => !t.label && !storedLabel.has(t.key)).map((t) => t.key)
  if (needLabel.length > 0) {
    const rows = (
      await sdb
        .prepare('SELECT track_key, label FROM search_tracks WHERE label IS NOT NULL AND track_key IN (SELECT value FROM json_each(?))')
        .bind(JSON.stringify(needLabel))
        .all<{ track_key: string; label: string }>()
    ).results
    for (const r of rows) storedLabel.set(r.track_key, r.label)
  }

  const stmts: D1PreparedStatement[] = []

  // Set row and its FTS row.
  stmts.push(
    sdb
      .prepare(
        `INSERT INTO search_sets (set_url, dj_slug, dj_name, title, set_date, video_id, video_source, track_count, ided_count, source, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(set_url) DO UPDATE SET
           dj_slug = excluded.dj_slug, dj_name = excluded.dj_name, title = excluded.title, set_date = excluded.set_date,
           video_id = excluded.video_id, video_source = excluded.video_source, track_count = excluded.track_count,
           ided_count = excluded.ided_count, source = excluded.source, indexed_at = excluded.indexed_at`,
      )
      .bind(setUrl, input.djSlug, input.djName, input.title, input.setDate, input.videoId, input.videoSource, input.trackCount, input.idedCount, input.source, nowSec),
    sdb.prepare('DELETE FROM sets_fts WHERE rowid = (SELECT id FROM search_sets WHERE set_url = ?)').bind(setUrl),
    sdb
      .prepare('INSERT INTO sets_fts (rowid, title, dj, slug_words) SELECT id, ?, ?, ? FROM search_sets WHERE set_url = ?')
      .bind(normalizedJoin(input.title), `${normalizedJoin(input.djName)} ${normalizedJoin(input.djSlug.replace(/[._-]+/g, ' '))}`, slugWords(setUrl), setUrl),
  )

  // Old links out, new tracks and links in.
  stmts.push(sdb.prepare('DELETE FROM search_track_sets WHERE set_url = ?').bind(setUrl))
  const upsertTrack = sdb.prepare(
    `INSERT INTO search_tracks (track_key, track_id, track_url, artist, title, label, sets_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(track_key) DO UPDATE SET
       artist = excluded.artist, title = excluded.title,
       track_url = COALESCE(excluded.track_url, track_url), label = COALESCE(excluded.label, label),
       updated_at = excluded.updated_at`,
  )
  const insertLink = sdb.prepare('INSERT INTO search_track_sets (track_key, set_url, pos, cue_seconds, layered) VALUES (?, ?, ?, ?, ?)')
  for (const t of tracks) {
    stmts.push(
      upsertTrack.bind(t.key, t.key.startsWith('t:') ? t.trackId : null, t.trackUrl, t.artist, t.title, t.label, nowSec),
      insertLink.bind(t.key, setUrl, t.pos, t.cueSeconds, t.layered ? 1 : 0),
    )
  }

  // Every touched track (old ∪ new): its count, then its FTS row (none once it is in no set).
  const fts = new Map<string, { artist: string; title: string; label: string | null }>()
  for (const o of old) fts.set(o.track_key, { artist: o.artist, title: o.title, label: o.label })
  for (const t of tracks) fts.set(t.key, { artist: t.artist, title: t.title, label: t.label ?? storedLabel.get(t.key) ?? null })
  const updateCount = sdb.prepare('UPDATE search_tracks SET sets_count = (SELECT COUNT(*) FROM search_track_sets WHERE track_key = ?) WHERE track_key = ?')
  const deleteFts = sdb.prepare('DELETE FROM tracks_fts WHERE rowid = (SELECT id FROM search_tracks WHERE track_key = ?)')
  const insertFts = sdb.prepare(
    `INSERT INTO tracks_fts (rowid, artist, title, label, djs, set_titles)
     SELECT t.id, ?, ?, ?,
            (SELECT group_concat(DISTINCT f.dj) FROM search_track_sets ts JOIN search_sets s ON s.set_url = ts.set_url JOIN sets_fts f ON f.rowid = s.id WHERE ts.track_key = t.track_key),
            (SELECT group_concat(f.title, ' ') FROM search_track_sets ts JOIN search_sets s ON s.set_url = ts.set_url JOIN sets_fts f ON f.rowid = s.id WHERE ts.track_key = t.track_key)
       FROM search_tracks t WHERE t.track_key = ? AND t.sets_count > 0`,
  )
  for (const [key, v] of fts) {
    stmts.push(
      updateCount.bind(key, key),
      deleteFts.bind(key),
      insertFts.bind(normalizedJoin(v.artist), normalizedJoin(v.title), normalizedJoin(v.label), key),
    )
  }

  // Vocabulary: the set title, the DJ name, each new track's artist, title and label.
  const terms = new Set<string>()
  addTerms(terms, input.title, input.djName)
  for (const t of tracks) addTerms(terms, t.artist, t.title, t.label)
  const upsertTerm = sdb.prepare('INSERT INTO search_vocab (term, df) VALUES (?, 1) ON CONFLICT(term) DO UPDATE SET df = df + 1')
  const insertTermFts = sdb.prepare('INSERT INTO vocab_fts (rowid, term) SELECT id, term FROM search_vocab WHERE term = ? AND id NOT IN (SELECT rowid FROM vocab_fts)')
  for (const term of terms) stmts.push(upsertTerm.bind(term), insertTermFts.bind(term))

  await sdb.batch(stmts)
  return { tracks: tracks.length }
}

/**
 * Index one live set fetch when its list is the set's verified list. Reads
 * the main DB (verification, the set's DJ) and SEARCH_DB (the recheck skip
 * rule), then calls `indexSet`. Throws on DB errors.
 */
export async function indexVerifiedFetch(env: Env, f: VerifiedFetch): Promise<'indexed' | 'skipped' | 'not_verified'> {
  const { setUrl, html, parsed } = f
  const videoId = f.videoId ?? null
  const nowSec = f.nowSec ?? nowSeconds()

  const fp = await verifiedFingerprint(env, setUrl)
  if (!fp || fp !== (await tracklistFingerprint(parsed))) return 'not_verified'

  // The set under its smallest subscribed slug (a b2b set is listed under each DJ).
  const set = await dbOf(env)
    .prepare(
      `SELECT t.slug AS slug, s.artist_name AS artist_name, t.video_source AS video_source, v.verified_at AS verified_at
         FROM tracklists t
         LEFT JOIN sub_sync s ON s.slug = t.slug
         LEFT JOIN set_verification v ON v.url = t.url
        WHERE t.url = ? AND t.slug IN (SELECT slug FROM subscriptions)
        ORDER BY t.slug LIMIT 1`,
    )
    .bind(setUrl)
    .first<{ slug: string; artist_name: string | null; video_source: string | null; verified_at: number | null }>()
  if (!set) return 'not_verified'

  const sdb = searchDbOf(env)
  const cur = await sdb
    .prepare('SELECT source, indexed_at, video_id FROM search_sets WHERE set_url = ?')
    .bind(setUrl)
    .first<{ source: string; indexed_at: number; video_id: string | null }>()
  if (cur && cur.source === 'page' && set.verified_at != null && cur.indexed_at >= set.verified_at && (cur.video_id ?? null) === videoId) return 'skipped'

  await indexSet(
    env,
    {
      setUrl,
      djSlug: set.slug,
      djName: set.artist_name ?? prettifySlug(set.slug),
      title: extractSetTitle(html) ?? slugWords(setUrl),
      setDate: extractSetDate(setUrl, html),
      videoId,
      videoSource: set.video_source,
      trackCount: parsed.rows.length,
      idedCount: parsed.rows.filter((r) => !r.anonymous && !r.isUnidentified).length,
      source: 'page',
      tracks: tracksFromRows(parsed.rows),
    },
    nowSec,
  )
  return 'indexed'
}

const pending = new Set<Promise<unknown>>()

/**
 * Fire and forget: index a verified fetch in the background. Does nothing
 * unless the fetch verified the set or agreed with its verified list, and
 * SEARCH_DB is bound. Never throws; `drainSearchIndex` hands the work to
 * ctx.waitUntil.
 */
export function queueSearchIndex(env: Env, f: VerifiedFetch, outcome: VerificationOutcome | undefined): void {
  if (outcome !== 'verified' && outcome !== 'unchanged') return
  if (!env.SEARCH_DB) return
  const p: Promise<unknown> = indexVerifiedFetch(env, f)
    .catch((e) => f.log?.warn('search.index_failed', { setUrl: f.setUrl, ...errorFields(e) }))
    .finally(() => pending.delete(p))
  pending.add(p)
}

/** Resolves when every index write started so far has finished (they swallow their own errors). */
export async function drainSearchIndex(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending])
}
