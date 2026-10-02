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
 *   - A fixed number of statements per set (12), whatever its length: every
 *     per-track and per-term write is one set-based statement over
 *     `json_each(?)` with one JSON array bind, so indexing never spends the
 *     invocation's D1 query budget per track. At most MAX_TRACKS_PER_SET (500)
 *     distinct tracks are indexed per set. D1's 100 KB limit applies to the
 *     SQL text, and bound values are counted separately; the 500-track cap
 *     keeps the largest JSON bind near 84 KB.
 *   - Thumbnails: a track's artwork URL and the set page's og:image are kept
 *     as source URLs (never overwritten with null) and registered in
 *     search_images under their key (src/lib/search/images.ts); the images
 *     are copied into R2 when first shown.
 *   - INDEX_FORMAT_SINCE: a set indexed before the index format last changed
 *     is re-indexed by its next verified fetch or Rebuild even when the skip
 *     rule would hold, so older rows pick up new columns.
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
import { extractPageImage, imageKey, usableImageUrl } from './images'
import { normalizedJoin, normalizeText, slugWords, trackKey } from './normalize'

export type IndexTrack = { trackId: string | null; trackUrl: string | null; artist: string; title: string; label: string | null; artworkUrl: string | null; cueSeconds: number | null; layered: boolean }

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
  /** The set page's image (og:image) source URL; null keeps the stored one. */
  imageUrl: string | null
  tracks: IndexTrack[]
}

type VerifiedFetch = { setUrl: string; html: string; parsed: ScrapedTracklist; videoId: string | null; nowSec?: number; log?: Logger }

const nowSeconds = () => Math.floor(Date.now() / 1000)

/** Vocabulary terms are normalized words of at least this many characters. */
const MIN_TERM = 3

/** Distinct tracks indexed per set; the rest of a longer list is dropped (see the header). */
export const MAX_TRACKS_PER_SET = 500

/**
 * Unix seconds of the last index format change (2026-10-02: thumbnails). A
 * set indexed before it is not skipped by the recheck/backfill skip rules.
 */
export const INDEX_FORMAT_SINCE = 1790954400

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
      artworkUrl: usableImageUrl(r.artworkUrl),
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
 * Write one set and its tracks: one SEARCH_DB batch (a transaction) of 12
 * statements, plus at most two reads before it. Throws on DB errors; callers
 * swallow them.
 */
export async function indexSet(env: Env, input: IndexSetInput, nowSec: number): Promise<{ tracks: number }> {
  const sdb = searchDbOf(env)
  const { setUrl } = input

  // New tracks, first occurrence of a key only, capped.
  const tracks: Array<IndexTrack & { key: string; pos: number }> = []
  const seen = new Set<string>()
  for (const t of input.tracks) {
    if (tracks.length >= MAX_TRACKS_PER_SET) break
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

  // Touched tracks (old ∪ new) with the normalized text of their FTS row.
  const touched = new Map<string, [string, string, string]>()
  for (const o of old) touched.set(o.track_key, [normalizedJoin(o.artist), normalizedJoin(o.title), normalizedJoin(o.label)])
  for (const t of tracks) touched.set(t.key, [normalizedJoin(t.artist), normalizedJoin(t.title), normalizedJoin(t.label ?? storedLabel.get(t.key))])

  // JSON array binds, rows as positional arrays to keep them small:
  //   trackRows  [key, track_url, artist, title, label, artwork_url]
  //   linkRows   [key, pos, cue_seconds, layered]
  //   ftsRows    [key, artist, title, label] (normalized), one per touched key
  //   terms      [term, ...]
  //   images     [key, src] for the set image and each track's artwork
  const trackRows = JSON.stringify(tracks.map((t) => [t.key, t.trackUrl, t.artist, t.title, t.label, t.artworkUrl]))
  const linkRows = JSON.stringify(tracks.map((t) => [t.key, t.pos, t.cueSeconds, t.layered ? 1 : 0]))
  const ftsRows = JSON.stringify([...touched].map(([k, v]) => [k, ...v]))
  const termSet = new Set<string>()
  addTerms(termSet, input.title, input.djName)
  for (const t of tracks) addTerms(termSet, t.artist, t.title, t.label)
  const terms = JSON.stringify([...termSet])
  const imageUrl = usableImageUrl(input.imageUrl)
  const srcs = [...new Set([imageUrl, ...tracks.map((t) => t.artworkUrl)].filter((u): u is string => !!u))]
  const images = JSON.stringify(await Promise.all(srcs.map(async (u) => [await imageKey(u), u])))

  await sdb.batch([
    // 1-3. Set row and its FTS row.
    sdb
      .prepare(
        `INSERT INTO search_sets (set_url, dj_slug, dj_name, title, set_date, video_id, video_source, track_count, ided_count, source, indexed_at, image_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(set_url) DO UPDATE SET
           dj_slug = excluded.dj_slug, dj_name = excluded.dj_name, title = excluded.title, set_date = excluded.set_date,
           video_id = excluded.video_id, video_source = excluded.video_source, track_count = excluded.track_count,
           ided_count = excluded.ided_count, source = excluded.source, indexed_at = excluded.indexed_at,
           image_url = COALESCE(excluded.image_url, image_url)`,
      )
      .bind(setUrl, input.djSlug, input.djName, input.title, input.setDate, input.videoId, input.videoSource, input.trackCount, input.idedCount, input.source, nowSec, imageUrl),
    sdb.prepare('DELETE FROM sets_fts WHERE rowid = (SELECT id FROM search_sets WHERE set_url = ?)').bind(setUrl),
    sdb
      .prepare('INSERT INTO sets_fts (rowid, title, dj, slug_words) SELECT id, ?, ?, ? FROM search_sets WHERE set_url = ?')
      .bind(normalizedJoin(input.title), `${normalizedJoin(input.djName)} ${normalizedJoin(input.djSlug.replace(/[._-]+/g, ' '))}`, slugWords(setUrl), setUrl),
    // 4. Old links out.
    sdb.prepare('DELETE FROM search_track_sets WHERE set_url = ?').bind(setUrl),
    // 5. New tracks in. track_id only for a 't:<id>' key; youtube_link is never
    //    written here. `WHERE true` keeps ON CONFLICT from parsing as a join constraint.
    sdb
      .prepare(
        `INSERT INTO search_tracks (track_key, track_id, track_url, artist, title, label, artwork_url, sets_count, updated_at)
         SELECT json_extract(j.value, '$[0]'),
                CASE WHEN json_extract(j.value, '$[0]') LIKE 't:%' THEN substr(json_extract(j.value, '$[0]'), 3) END,
                json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'), json_extract(j.value, '$[3]'), json_extract(j.value, '$[4]'),
                json_extract(j.value, '$[5]'), 0, ?1
           FROM json_each(?2) j WHERE true
         ON CONFLICT(track_key) DO UPDATE SET
           artist = excluded.artist, title = excluded.title,
           track_url = COALESCE(excluded.track_url, track_url), label = COALESCE(excluded.label, label),
           artwork_url = COALESCE(excluded.artwork_url, artwork_url), updated_at = excluded.updated_at`,
      )
      .bind(nowSec, trackRows),
    // 6. New links in.
    sdb
      .prepare(
        `INSERT INTO search_track_sets (track_key, set_url, pos, cue_seconds, layered)
         SELECT json_extract(j.value, '$[0]'), ?1, json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'), json_extract(j.value, '$[3]')
           FROM json_each(?2) j`,
      )
      .bind(setUrl, linkRows),
    // 7-9. Every touched track: its count, then its FTS row (none once it is in no set).
    sdb
      .prepare(
        `UPDATE search_tracks SET sets_count = (SELECT COUNT(*) FROM search_track_sets ts WHERE ts.track_key = search_tracks.track_key)
          WHERE track_key IN (SELECT json_extract(value, '$[0]') FROM json_each(?))`,
      )
      .bind(ftsRows),
    sdb
      .prepare('DELETE FROM tracks_fts WHERE rowid IN (SELECT id FROM search_tracks WHERE track_key IN (SELECT json_extract(value, \'$[0]\') FROM json_each(?)))')
      .bind(ftsRows),
    sdb
      .prepare(
        `INSERT INTO tracks_fts (rowid, artist, title, label, djs, set_titles)
         SELECT t.id, json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'), json_extract(j.value, '$[3]'),
                (SELECT group_concat(DISTINCT f.dj) FROM search_track_sets ts JOIN search_sets s ON s.set_url = ts.set_url JOIN sets_fts f ON f.rowid = s.id WHERE ts.track_key = t.track_key),
                (SELECT group_concat(f.title, ' ') FROM search_track_sets ts JOIN search_sets s ON s.set_url = ts.set_url JOIN sets_fts f ON f.rowid = s.id WHERE ts.track_key = t.track_key)
           FROM json_each(?) j JOIN search_tracks t ON t.track_key = json_extract(j.value, '$[0]')
          WHERE t.sets_count > 0`,
      )
      .bind(ftsRows),
    // 10-11. Vocabulary: the set title, the DJ name, each new track's artist,
    // title and label. `df` counts index writes that carried the term (a
    // re-index counts again), not documents: it is only a tie-break when
    // ranking correction candidates.
    sdb.prepare('INSERT INTO search_vocab (term, df) SELECT value, 1 FROM json_each(?) WHERE true ON CONFLICT(term) DO UPDATE SET df = df + 1').bind(terms),
    sdb
      .prepare(
        `INSERT INTO vocab_fts (rowid, term)
         SELECT v.id, v.term FROM search_vocab v
          WHERE v.term IN (SELECT value FROM json_each(?)) AND NOT EXISTS (SELECT 1 FROM vocab_fts f WHERE f.rowid = v.id)`,
      )
      .bind(terms),
    // 12. Thumbnail sources, by key (served from R2 by /ui/img/<key>).
    sdb
      .prepare(`INSERT OR IGNORE INTO search_images (key, src) SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)`)
      .bind(images),
  ])
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
  if (cur && cur.source === 'page' && set.verified_at != null && cur.indexed_at >= Math.max(set.verified_at, INDEX_FORMAT_SINCE) && (cur.video_id ?? null) === videoId) return 'skipped'

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
      imageUrl: extractPageImage(html),
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
