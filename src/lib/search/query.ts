/**
 * GET /ui/api/search's pipeline (spec §9); reads SEARCH_DB and the main DB only.
 * 1. Normalize q (≤ 8 words). 2. Expand: exact, prefix, and for words not in
 * the vocabulary up to 5 corrections (the distance-1 edit neighbourhood, plus
 * trigram recall for distance 2). 3. FTS5 bm25 recall, AND then OR under 10
 * rows. 4. Re-rank with `rankScore`; recency/subscribed (≤ MAX_LATE_BOOST) need
 * a track's sets, so sets are read only for candidates that can still make the
 * cut. 5. Every set of each returned track; DJs from the subscription list.
 * Rows of one track are merged (same 1001tracklists link, or a linkless row with
 * a linked row's artist + title). Every item carries `score` (relevance over
 * the best possible, ~0-1, comparable across kinds) and `image` (/ui/img/<key>).
 */
import type { Env } from '../../types'
import { dbOf } from '../db'
import { prettifySlug } from '../prettify-slug'
import { searchDbOf } from './db'
import { imageKey, imagePath } from './images'
import { normalizeText } from './normalize'
import { damerauLevenshtein, MAX_LATE_BOOST, rankScore, tokenFieldScore, type QueryToken } from './score'

export type SearchKind = 'all' | 'sets' | 'tracks' | 'djs'
export type SearchQuery = { q: string; kind: SearchKind; limit: number; exact: boolean }

export type SearchTrackSet = { url: string; title: string; djSlug: string; djName: string; date: string | null; cueSeconds: number | null }
export type SearchTrack = {
  trackKey: string
  trackId: string | null
  artist: string
  title: string
  label: string | null
  youtubeLink: string | null
  trackUrl: string | null
  sets: SearchTrackSet[]
  image: string | null
  score: number
}
export type SearchSet = { url: string; title: string; djSlug: string; djName: string; date: string | null; videoId: string | null; trackCount: number; idedCount: number; image: string | null; score: number }
export type SearchDj = { slug: string; name: string; subscribed: boolean; sets: number; image: string | null; score: number }
export type SearchResponse = { q: string; corrected: Array<{ from: string; to: string }>; tracks: SearchTrack[]; sets: SearchSet[]; djs: SearchDj[] }

const KINDS: readonly SearchKind[] = ['all', 'sets', 'tracks', 'djs']
const MAX_Q = 200
const MAX_TOKENS = 8
/** Default results per kind (the "All" list). */
const DEFAULT_LIMIT = 20
/**
 * Most results per kind. The Search page's Tracks / Sets / DJs tabs ask for
 * this many and sort, filter and page them in the browser (TKTable local
 * mode): relevance ranking needs the whole candidate set, and recall is
 * capped at RECALL_LIMIT rows per kind anyway.
 */
const MAX_LIMIT = 200
/** Fewer AND-recall rows than this and the words are ORed too. */
const MIN_AND_ROWS = 10
const RECALL_LIMIT = 200
/** Correction candidates read from vocab_fts per word, and kept after the distance check. */
const VOCAB_CANDIDATES = 50
const MAX_CORRECTIONS = 5
/** Longest word whose distance-1 edit neighbourhood is looked up (one JSON bind of ~73 terms per character). */
const MAX_NEIGHBOURHOOD_LEN = 24
/** Sets listed per track (the newest). */
const MAX_SETS_PER_TRACK = 50
const DAY_MS = 86_400_000
/** Upper bound of a prefix range on the term index: sorts after every BMP character. */
const PREFIX_END = String.fromCharCode(0xffff)

export function parseSearchQuery(p: URLSearchParams): SearchQuery | { error: string } {
  const q = Array.from((p.get('q') ?? '').trim()).slice(0, MAX_Q).join('')
  const kindRaw = p.get('kind')
  if (kindRaw !== null && !KINDS.includes(kindRaw as SearchKind)) return { error: `kind must be one of ${KINDS.join(', ')}` }
  const kind = (kindRaw ?? 'all') as SearchKind
  const limitRaw = p.get('limit')
  let limit = DEFAULT_LIMIT
  if (limitRaw !== null) {
    if (!/^\d{1,3}$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > MAX_LIMIT) return { error: `limit must be an integer from 1 to ${MAX_LIMIT}` }
    limit = Number(limitRaw)
  }
  const exactRaw = p.get('exact')
  if (exactRaw !== null && exactRaw !== '1') return { error: 'exact must be 1 or absent' }
  return { q, kind, limit, exact: exactRaw === '1' }
}

const len = (s: string) => [...s].length
/** An FTS5 string: double-quoted, inner quotes doubled. */
const quote = (s: string) => `"${s.replace(/"/g, '""')}"`
/** Field tokens of an FTS column: normalized words, comma-joined lists (djs) included. */
const fieldWords = (s: string | null | undefined) => (s ? s.split(/[\s,]+/).filter(Boolean) : [])

function trigrams(s: string): string[] {
  const c = [...s]
  const out = new Set<string>()
  for (let i = 0; i + 3 <= c.length; i++) out.add(c.slice(i, i + 3).join(''))
  return [...out]
}

const EDIT_ALPHABET = [...'abcdefghijklmnopqrstuvwxyz0123456789']

/**
 * Every string one edit from `w` (deletion, adjacent transposition, and
 * substitution or insertion of [a-z0-9]), by code point. Normalized words are
 * lowercase and diacritic-free; other letters just get no new characters.
 */
export function editNeighbourhood(w: string): string[] {
  const c = [...w]
  const out = new Set<string>()
  for (let i = 0; i < c.length; i++) out.add([...c.slice(0, i), ...c.slice(i + 1)].join(''))
  for (let i = 0; i + 1 < c.length; i++) out.add([...c.slice(0, i), c[i + 1], c[i], ...c.slice(i + 2)].join(''))
  for (let i = 0; i <= c.length; i++) {
    for (const a of EDIT_ALPHABET) {
      if (i < c.length && a !== c[i]) out.add([...c.slice(0, i), a, ...c.slice(i + 1)].join(''))
      out.add([...c.slice(0, i), a, ...c.slice(i)].join(''))
    }
  }
  out.delete(w)
  return [...out]
}

/** Step 2: each word's variants, and the best correction per corrected word. */
async function expand(sdb: D1Database, words: string[], exact: boolean): Promise<{ tokens: QueryToken[]; corrected: Array<{ from: string; to: string }> }> {
  const tokens: QueryToken[] = words.map((w) => ({
    text: w,
    variants: [{ term: w, kind: 'exact' as const, distance: 0 }, ...(len(w) >= 3 ? [{ term: w, kind: 'prefix' as const, distance: 0 }] : [])],
  }))
  const corrected: Array<{ from: string; to: string }> = []
  if (exact) return { tokens, corrected }
  const correctable = words.filter((w) => len(w) >= 3)
  if (correctable.length === 0) return { tokens, corrected }

  const known = new Set(
    (await sdb.prepare('SELECT term FROM search_vocab WHERE term IN (SELECT value FROM json_each(?))').bind(JSON.stringify(correctable)).all<{ term: string }>()).results.map((r) => r.term),
  )
  const unknown = correctable.filter((w) => !known.has(w))
  if (unknown.length === 0) return { tokens, corrected }

  // One batch, three statements per unknown word:
  //   - the vocabulary terms in its distance-1 edit neighbourhood, an equality
  //     lookup, so no distance-1 term is ever missed (skipped above
  //     MAX_NEIGHBOURHOOD_LEN, which keeps the JSON bind well under 100 KB);
  //   - trigram recall for distance 2, best bm25 rank first. The length band
  //     is result-preserving (a term whose length differs by more than `max`
  //     is farther than `max`) and keeps the LIMIT for plausible terms;
  //   - a prefix probe on the UNIQUE term index: a word that begins a
  //     vocabulary term is most likely still being typed ("dol" of "dolla"),
  //     so its corrections still widen recall but are not reported.
  const maxOf = (w: string) => (len(w) >= 7 ? 2 : 1)
  const rows = await sdb.batch<{ term: string; df: number }>(
    unknown.flatMap((w) => [
      sdb
        .prepare('SELECT term, df FROM search_vocab WHERE term IN (SELECT value FROM json_each(?))')
        .bind(JSON.stringify(len(w) <= MAX_NEIGHBOURHOOD_LEN ? editNeighbourhood(w) : [])),
      sdb
        .prepare(
          `SELECT v.term AS term, v.df AS df FROM vocab_fts f JOIN search_vocab v ON v.id = f.rowid
            WHERE vocab_fts MATCH ? AND length(v.term) BETWEEN ? AND ? ORDER BY f.rank LIMIT ${VOCAB_CANDIDATES}`,
        )
        .bind(trigrams(w).map(quote).join(' OR '), len(w) - maxOf(w), len(w) + maxOf(w)),
      sdb.prepare('SELECT term, 0 AS df FROM search_vocab WHERE term > ?1 AND term < ?2 LIMIT 1').bind(w, w + PREFIX_END),
    ]),
  )
  unknown.forEach((w, i) => {
    const max = maxOf(w)
    const candidates = new Map<string, { term: string; df: number; distance: number }>()
    for (const r of [...(rows[3 * i]?.results ?? []), ...(rows[3 * i + 1]?.results ?? [])]) {
      if (r.term === w || candidates.has(r.term)) continue
      const distance = damerauLevenshtein(w, r.term, max)
      if (distance <= max) candidates.set(r.term, { term: r.term, df: r.df, distance })
    }
    const kept = [...candidates.values()]
      .sort((a, b) => a.distance - b.distance || b.df - a.df || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0))
      .slice(0, MAX_CORRECTIONS)
    if (kept.length === 0) return
    const tok = tokens.find((t) => t.text === w)!
    for (const c of kept) tok.variants.push({ term: c.term, kind: 'corrected', distance: c.distance })
    const typingPrefix = (rows[3 * i + 2]?.results.length ?? 0) > 0
    if (!typingPrefix) corrected.push({ from: w, to: kept[0]!.term })
  })
  return { tokens, corrected }
}

/** Step 3: one FTS group per word, `("w" OR "w"* OR "c1" ...)`. */
function matchGroups(tokens: QueryToken[]): string[] {
  return tokens.map((t) => {
    const parts = new Set<string>()
    for (const v of t.variants) parts.add(v.kind === 'prefix' ? `${quote(v.term)}*` : quote(v.term))
    return `(${[...parts].join(' OR ')})`
  })
}

type TrackRow = {
  id: number
  track_key: string
  track_id: string | null
  track_url: string | null
  artist: string
  title: string
  label: string | null
  youtube_link: string | null
  artwork_url: string | null
  n_artist: string | null
  n_title: string | null
  n_label: string | null
  n_djs: string | null
  n_set_titles: string | null
  bm: number
}
type SetRow = {
  id: number
  set_url: string
  dj_slug: string
  dj_name: string
  title: string
  set_date: string | null
  video_id: string | null
  track_count: number
  ided_count: number
  image_url: string | null
  n_title: string | null
  n_dj: string | null
  n_slug_words: string | null
  bm: number
}
type TrackSetRow = { track_key: string; set_url: string; title: string; dj_slug: string; dj_name: string; set_date: string | null; cue_seconds: number | null }

const TRACKS_SQL = `SELECT t.*, f.artist AS n_artist, f.title AS n_title, f.label AS n_label, f.djs AS n_djs, f.set_titles AS n_set_titles,
       bm25(tracks_fts, 3.0, 3.0, 1.0, 2.0, 1.0) AS bm
  FROM tracks_fts f JOIN search_tracks t ON t.id = f.rowid
 WHERE tracks_fts MATCH ? AND t.sets_count > 0
 ORDER BY bm LIMIT ${RECALL_LIMIT}`
const SETS_SQL = `SELECT s.*, f.title AS n_title, f.dj AS n_dj, f.slug_words AS n_slug_words,
       bm25(sets_fts, 3.0, 2.0, 1.0) AS bm
  FROM sets_fts f JOIN search_sets s ON s.id = f.rowid
 WHERE sets_fts MATCH ?
 ORDER BY bm LIMIT ${RECALL_LIMIT}`

/** Step 3: AND recall for each wanted kind, then OR recall for any that found too few; merged by rowid. */
async function recall(sdb: D1Database, tokens: QueryToken[], wantTracks: boolean, wantSets: boolean): Promise<{ tracks: TrackRow[]; sets: SetRow[] }> {
  const groups = matchGroups(tokens)
  const and = groups.join(' AND ')
  const or = groups.join(' OR ')
  const kinds = [...(wantTracks ? (['tracks'] as const) : []), ...(wantSets ? (['sets'] as const) : [])]
  const stmt = (k: 'tracks' | 'sets', m: string) => sdb.prepare(k === 'tracks' ? TRACKS_SQL : SETS_SQL).bind(m)
  const out = { tracks: [] as TrackRow[], sets: [] as SetRow[] }
  if (kinds.length === 0) return out
  const first = await sdb.batch<TrackRow | SetRow>(kinds.map((k) => stmt(k, and)))
  kinds.forEach((k, i) => ((out[k] as Array<TrackRow | SetRow>) = first[i]?.results ?? []))
  const again = tokens.length > 1 ? kinds.filter((k) => out[k].length < MIN_AND_ROWS) : []
  if (again.length > 0) {
    const second = await sdb.batch<TrackRow | SetRow>(again.map((k) => stmt(k, or)))
    again.forEach((k, i) => {
      const rows = out[k] as Array<TrackRow | SetRow>
      const seen = new Set(rows.map((r) => r.id))
      for (const r of second[i]?.results ?? []) if (!seen.has(r.id)) (seen.add(r.id), rows.push(r))
    })
  }
  return out
}

function recencyDays(date: string | null, nowMs: number): number | null {
  if (!date) return null
  const t = Date.parse(`${date.slice(0, 10)}T00:00:00Z`)
  return Number.isFinite(t) ? (nowMs - t) / DAY_MS : null
}

/** Score desc, then bm25 asc (better first), then id. */
const byRank = <T extends { score: number; bm: number; id: number }>(a: T, b: T) => b.score - a.score || a.bm - b.bm || a.id - b.id

type Field = { tokens: string[]; weight: number }
type TrackCand = { r: TrackRow; fields: Field[]; partial: number; score: number; bm: number; id: number; keys: string[] }

/**
 * One candidate per track. Rows with the same 1001tracklists link merge, and
 * a row without a link (a backfilled mkvid list keys its tracks by name) joins
 * the best linked row with the same normalized artist + title. The lead row is
 * the linked one; its gaps (label, YouTube link, artwork) are filled from the
 * others, field words are pooled, and the best partial score is kept.
 */
function mergeTracks(cands: TrackCand[]): TrackCand[] {
  const sorted = [...cands].sort((a, b) => Number(!!b.r.track_url) - Number(!!a.r.track_url) || b.partial - a.partial || a.id - b.id)
  const byUrl = new Map<string, TrackCand>()
  const byName = new Map<string, TrackCand>()
  const out: TrackCand[] = []
  for (const c of sorted) {
    const name = `${c.r.n_artist ?? ''}\u0000${c.r.n_title ?? ''}`
    const g = c.r.track_url ? byUrl.get(c.r.track_url) : byName.get(name)
    if (!g) {
      const lead = { ...c, r: { ...c.r }, fields: c.fields.map((f) => ({ ...f, tokens: [...f.tokens] })), keys: [c.r.track_key] }
      out.push(lead)
      if (c.r.track_url) byUrl.set(c.r.track_url, lead)
      if (!byName.has(name)) byName.set(name, lead)
      continue
    }
    g.keys.push(c.r.track_key)
    g.partial = Math.max(g.partial, c.partial)
    g.bm = Math.min(g.bm, c.bm)
    g.r.label ??= c.r.label
    g.r.youtube_link ??= c.r.youtube_link
    g.r.artwork_url ??= c.r.artwork_url
    c.fields.forEach((f, i) => {
      const into = g.fields[i]!
      for (const w of f.tokens) if (!into.tokens.includes(w)) into.tokens.push(w)
    })
  }
  return out
}

/** /ui/img/<key> for a source URL (null stays null). */
async function imageOf(src: string | null | undefined): Promise<string | null> {
  return src ? imagePath(await imageKey(src)) : null
}

type Subs = { slug: string; artist_name: string | null }

const emptyResponse = (q: string, corrected: SearchResponse['corrected'] = []): SearchResponse => ({ q, corrected, tracks: [], sets: [], djs: [] })

export async function search(env: Env, q: SearchQuery, nowMs: number = Date.now()): Promise<SearchResponse> {
  const words = [...new Set(normalizeText(q.q).slice(0, MAX_TOKENS))]
  if (words.length === 0) return emptyResponse(q.q)
  const sdb = searchDbOf(env)
  const wantTracks = q.kind === 'all' || q.kind === 'tracks'
  const wantSets = q.kind === 'all' || q.kind === 'sets'
  const wantDjs = q.kind === 'all' || q.kind === 'djs'

  // Main DB, in parallel with the search pipeline: the subscription list
  // (subscribed boost, DJ matching) and, for DJs, processed set counts.
  const db = dbOf(env)
  const mainP = db.batch([
    db.prepare('SELECT s.slug AS slug, ss.artist_name AS artist_name FROM subscriptions s LEFT JOIN sub_sync ss ON ss.slug = s.slug'),
    ...(wantDjs ? [db.prepare('SELECT slug, COUNT(*) AS n FROM tracklists WHERE processed = 1 GROUP BY slug')] : []),
  ])
  mainP.catch(() => {}) // awaited below; keeps an early search throw from leaving it unhandled

  const { tokens, corrected } = await expand(sdb, words, q.exact)
  const recalled = await recall(sdb, tokens, wantTracks, wantSets)
  const main = await mainP
  const subs = (main[0]?.results ?? []) as Subs[]
  const subscribed = new Set(subs.map((s) => s.slug))
  const res = emptyResponse(q.q, corrected)
  /** Relevance over the best possible (every word an exact match in a weight-3 field): ~0-1, comparable across kinds. */
  const norm = (score: number) => Math.round((score / (3 * tokens.length)) * 1000) / 1000

  if (wantTracks && recalled.tracks.length > 0) {
    const scored: TrackCand[] = recalled.tracks.map((r) => {
      const fields = [
        { tokens: fieldWords(r.n_artist), weight: 3 },
        { tokens: fieldWords(r.n_title), weight: 3 },
        { tokens: fieldWords(r.n_label), weight: 1 },
        { tokens: fieldWords(r.n_djs), weight: 2 },
        { tokens: fieldWords(r.n_set_titles), weight: 1 },
      ]
      return { r, fields, partial: rankScore(tokens, fields, { youtube: r.youtube_link != null }), score: 0, bm: r.bm, id: r.id, keys: [r.track_key] }
    })
    const merged = mergeTracks(scored)
    const ordered = [...merged].sort((a, b) => b.partial - a.partial || a.bm - b.bm || a.id - b.id)
    const floor = ordered.length >= q.limit ? ordered[q.limit - 1]!.partial : 0
    const shortlist = merged.filter((c) => c.partial > 0 && c.partial * MAX_LATE_BOOST >= floor * (1 - 1e-9))
    const setsByKey = new Map<string, TrackSetRow[]>()
    if (shortlist.length > 0) {
      const rows = (
        await sdb
          .prepare(
            `SELECT track_key, set_url, title, dj_slug, dj_name, set_date, cue_seconds FROM (
               SELECT ts.track_key AS track_key, s.set_url AS set_url, s.title AS title, s.dj_slug AS dj_slug, s.dj_name AS dj_name,
                      s.set_date AS set_date, ts.cue_seconds AS cue_seconds,
                      ROW_NUMBER() OVER (PARTITION BY ts.track_key ORDER BY s.set_date DESC, s.set_url) AS rn
                 FROM search_track_sets ts JOIN search_sets s ON s.set_url = ts.set_url
                WHERE ts.track_key IN (SELECT value FROM json_each(?))
             ) WHERE rn <= ${MAX_SETS_PER_TRACK}
             ORDER BY set_date DESC, set_url`,
          )
          .bind(JSON.stringify(shortlist.flatMap((c) => c.keys)))
          .all<TrackSetRow>()
      ).results
      for (const row of rows) {
        const list = setsByKey.get(row.track_key) ?? []
        list.push(row)
        setsByKey.set(row.track_key, list)
      }
    }
    /** A merged track's sets: each set once (a cue wins over none), newest first, capped. */
    const setsOf = (c: TrackCand): TrackSetRow[] => {
      const byUrl = new Map<string, TrackSetRow>()
      for (const k of c.keys) for (const row of setsByKey.get(k) ?? []) {
        const had = byUrl.get(row.set_url)
        if (!had || (had.cue_seconds == null && row.cue_seconds != null)) byUrl.set(row.set_url, row)
      }
      return [...byUrl.values()]
        .sort((a, b) => (b.set_date ?? '').localeCompare(a.set_date ?? '') || (a.set_url < b.set_url ? -1 : a.set_url > b.set_url ? 1 : 0))
        .slice(0, MAX_SETS_PER_TRACK)
    }
    const withSets = shortlist.map((c) => ({ c, sets: setsOf(c) }))
    for (const { c, sets } of withSets) {
      const newest = sets.find((s) => s.set_date)?.set_date ?? null
      c.score = rankScore(tokens, c.fields, { youtube: c.r.youtube_link != null, recencyDays: recencyDays(newest, nowMs), subscribed: sets.some((s) => subscribed.has(s.dj_slug)) })
    }
    res.tracks = await Promise.all(
      withSets
        .filter(({ c }) => c.score > 0)
        .sort((a, b) => byRank(a.c, b.c))
        .slice(0, q.limit)
        .map(async ({ c, sets }) => ({
          trackKey: c.r.track_key,
          trackId: c.r.track_id,
          artist: c.r.artist,
          title: c.r.title,
          label: c.r.label,
          youtubeLink: c.r.youtube_link,
          trackUrl: c.r.track_url,
          sets: sets.map((s) => ({ url: s.set_url, title: s.title, djSlug: s.dj_slug, djName: s.dj_name, date: s.set_date, cueSeconds: s.cue_seconds })),
          image: await imageOf(c.r.artwork_url),
          score: norm(c.score),
        })),
    )
  }

  const setPicks = wantSets
    ? recalled.sets
        .map((r) => {
          const fields = [
            { tokens: fieldWords(r.n_title), weight: 3 },
            { tokens: fieldWords(r.n_dj), weight: 2 },
            { tokens: fieldWords(r.n_slug_words), weight: 1 },
          ]
          const score = rankScore(tokens, fields, { youtube: r.video_id != null, recencyDays: recencyDays(r.set_date, nowMs), subscribed: subscribed.has(r.dj_slug) })
          return { r, score, bm: r.bm, id: r.id }
        })
        .filter((c) => c.score > 0)
        .sort(byRank)
        .slice(0, q.limit)
    : []

  const djPicks = wantDjs
    ? subs
        .map((s) => {
          const name = s.artist_name ?? prettifySlug(s.slug)
          const fields = [
            { tokens: normalizeText(name), weight: 3 },
            { tokens: normalizeText(s.slug.replace(/[._-]+/g, ' ')), weight: 1 },
          ]
          const matched = tokens.filter((t) => fields.some((f) => tokenFieldScore(t, f.tokens) > 0)).length
          return { s, name, score: rankScore(tokens, fields, {}), matched }
        })
        .filter((c) => c.score > 0 && c.matched / tokens.length >= 0.5)
        .sort((a, b) => b.score - a.score || (a.s.slug < b.s.slug ? -1 : 1))
        .slice(0, q.limit)
    : []

  // A DJ's picture, and a set's when its page gave none: the newest indexed set of that DJ with an image.
  const needDjImage = [...new Set([...djPicks.map((c) => c.s.slug), ...setPicks.filter((c) => !c.r.image_url).map((c) => c.r.dj_slug)])]
  const djImage = new Map<string, string>()
  if (needDjImage.length > 0) {
    const rows = (
      await sdb
        .prepare(
          `SELECT dj_slug, image_url FROM search_sets
            WHERE image_url IS NOT NULL AND dj_slug IN (SELECT value FROM json_each(?))
            ORDER BY set_date DESC, set_url`,
        )
        .bind(JSON.stringify(needDjImage))
        .all<{ dj_slug: string; image_url: string }>()
    ).results
    for (const r of rows) if (!djImage.has(r.dj_slug)) djImage.set(r.dj_slug, r.image_url)
  }

  res.sets = await Promise.all(
    setPicks.map(async ({ r, score }) => ({
      url: r.set_url,
      title: r.title,
      djSlug: r.dj_slug,
      djName: r.dj_name,
      date: r.set_date,
      videoId: r.video_id,
      trackCount: r.track_count,
      idedCount: r.ided_count,
      image: await imageOf(r.image_url ?? djImage.get(r.dj_slug)),
      score: norm(score),
    })),
  )

  if (wantDjs) {
    const counts = new Map(((main[1]?.results ?? []) as Array<{ slug: string; n: number }>).map((r) => [r.slug, r.n]))
    res.djs = await Promise.all(
      djPicks.map(async (c) => ({ slug: c.s.slug, name: c.name, subscribed: true, sets: counts.get(c.s.slug) ?? 0, image: await imageOf(djImage.get(c.s.slug)), score: norm(c.score) })),
    )
  }
  return res
}
