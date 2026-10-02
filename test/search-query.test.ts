/**
 * GET /ui/api/search (src/routes/search.ts over src/lib/search/query.ts): the
 * fixture is indexed through `indexSet` into the real search migrations on
 * sqlite-wasm (FTS5 + trigram); the DJs come from the main DB.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../src/index'
import type { Env } from '../src/types'
import { fakeD1 } from './helpers/fake-d1'
import { fakeKV } from './helpers/fake-kv'
import { indexSet, type IndexTrack } from '../src/lib/search/index'
import { search as runSearch, type SearchResponse } from '../src/lib/search/query'

const TL = 'https://www.1001tracklists.com/tracklist'
const URLS = {
  lpEdc: `${TL}/1a1a1a/lilly-palmer-circuitgrounds-edc-las-vegas-united-states-2026-05-16.html`,
  lpAwk: `${TL}/2b2b2b/lilly-palmer-awakenings-festival-netherlands-2025-06-28.html`,
  ebUltra26: `${TL}/3c3c3c/eli-brown-mainstage-ultra-music-festival-miami-united-states-2026-03-28.html`,
  ebUltra25: `${TL}/4d4d4d/eli-brown-mainstage-ultra-music-festival-miami-united-states-2025-03-29.html`,
  ebIbiza: `${TL}/5e5e5e/eli-brown-hi-ibiza-spain-2026-07-04.html`,
  jsUltra: `${TL}/6f6f6f/john-summit-ultra-music-festival-miami-united-states-2026-03-29.html`,
}

const t = (trackId: string, artist: string, title: string, label: string, cueSeconds: number): IndexTrack => ({
  trackId,
  trackUrl: `https://www.1001tracklists.com/track/${trackId}/index.html`,
  artist,
  title,
  label,
  artworkUrl: null,
  cueSeconds,
  layered: false,
})
const RIAN = t('1001', 'Rian Wood & Version 34', "Don't Stop", 'RAVE WORLD', 0)
const NECK = (cue: number) => t('2002', 'Mau P', 'Neck', 'BLACK BOOK', cue)
const BEFORE = (cue: number) => t('1003', 'Lilly Palmer', 'Before I Go', 'Spannung', cue)
const FEEL = t('1004', 'Amelie Lens', 'Feel It', 'LENSKE', 300)
const MEU = t('1005', 'Eli Brown', 'Me & U', 'Repopulate Mars', 240)
const DIAMONDS = t('1006', 'Eli Brown', 'Diamonds', 'Repopulate Mars', 0)
const DOM = t('1007', 'Dom Dolla', "Don't Stop", 'Sweat It Out', 0)
const DECEMBER = t('1008', 'Neck Deep', 'December', 'Hopeless', 180)

// In the brief's table order, so ids follow it.
const SETS: Array<{ url: string; djSlug: string; djName: string; title: string; date: string; tracks: IndexTrack[] }> = [
  { url: URLS.lpEdc, djSlug: 'lillypalmer', djName: 'Lilly Palmer', title: 'Lilly Palmer @ circuitGROUNDS, EDC Las Vegas, United States 2026-05-16', date: '2026-05-16', tracks: [RIAN, NECK(200), BEFORE(400)] },
  { url: URLS.lpAwk, djSlug: 'lillypalmer', djName: 'Lilly Palmer', title: 'Lilly Palmer @ Awakenings Festival, Netherlands 2025-06-28', date: '2025-06-28', tracks: [BEFORE(0), FEEL] },
  { url: URLS.ebUltra26, djSlug: 'elibrown', djName: 'Eli Brown', title: 'Eli Brown @ Mainstage, Ultra Music Festival Miami, United States 2026-03-28', date: '2026-03-28', tracks: [NECK(60), MEU] },
  { url: URLS.ebUltra25, djSlug: 'elibrown', djName: 'Eli Brown', title: 'Eli Brown @ Mainstage, Ultra Music Festival Miami, United States 2025-03-29', date: '2025-03-29', tracks: [DIAMONDS] },
  { url: URLS.ebIbiza, djSlug: 'elibrown', djName: 'Eli Brown', title: 'Eli Brown @ Hï Ibiza, Spain 2026-07-04', date: '2026-07-04', tracks: [NECK(120)] },
  { url: URLS.jsUltra, djSlug: 'johnsummit', djName: 'John Summit', title: 'John Summit @ Ultra Music Festival Miami, United States 2026-03-29', date: '2026-03-29', tracks: [DOM, DECEMBER] },
]

const NOW_SEC = Math.floor(Date.now() / 1000)

function makeEnv(over: Partial<Env> = {}): Env {
  return { CACHE: fakeKV(), SUBS: fakeKV(), DB: fakeD1(), SEARCH_DB: fakeD1({ migrations: 'search' }), API_TOKEN: 't', YOUTUBE_API_KEY: 'k', DEV_BYPASS_CF_ACCESS: '1', ...over } as Env
}

async function seed(env: Env): Promise<void> {
  const djs = [['lillypalmer', 'Lilly Palmer'], ['elibrown', 'Eli Brown'], ['johnsummit', 'John Summit']] as const
  for (const [i, [slug, name]] of djs.entries()) {
    await env.DB.prepare('INSERT INTO subscriptions (slug, source_url, added_at, position) VALUES (?, ?, 0, ?)').bind(slug, `https://www.1001tracklists.com/dj/${slug}/`, i).run()
    await env.DB.prepare('INSERT INTO sub_sync (slug, artist_name) VALUES (?, ?)').bind(slug, name).run()
  }
  for (const [i, s] of SETS.entries()) {
    await env.DB.prepare('INSERT INTO tracklists (slug, url, position, discovered_at, processed) VALUES (?, ?, ?, 0, 1)').bind(s.djSlug, s.url, i).run()
    await indexSet(
      env,
      { setUrl: s.url, djSlug: s.djSlug, djName: s.djName, title: s.title, setDate: s.date, videoId: null, videoSource: null, trackCount: s.tracks.length, idedCount: s.tracks.length, source: 'page', imageUrl: null, tracks: s.tracks },
      NOW_SEC,
    )
  }
  // An unprocessed set does not count towards a DJ's sets.
  await env.DB.prepare('INSERT INTO tracklists (slug, url, position, discovered_at, processed) VALUES (?, ?, 99, 0, 0)').bind('elibrown', `${TL}/7a7a7a/eli-brown-pending-2026-09-30.html`).run()
}

/** 300 six-letter terms "amer" + two characters, none within one edit of plamer. */
function crowdTerms(): string[] {
  const a = [...'bcdfghjkqvwxz0123456789']
  const out: string[] = []
  for (const x of a) for (const y of a) if (out.length < 300) out.push(`amer${x}${y}`)
  return out
}

const get = (env: Env, qs: string) => app.request(`http://x/ui/api/search?${qs}`, { method: 'GET' }, env)
async function search(env: Env, qs: string): Promise<SearchResponse> {
  const r = await get(env, qs)
  expect(r.status, qs).toBe(200)
  return (await r.json()) as SearchResponse
}

describe('GET /ui/api/search', () => {
  let env: Env
  beforeEach(async () => {
    env = makeEnv()
    await seed(env)
  })

  it("lily plamer dont ranks Rian Wood & Version 34 - Don't Stop in the top 3 tracks, above Dom Dolla's Don't Stop", async () => {
    const r = await search(env, 'q=' + encodeURIComponent('lily plamer dont'))
    const keys = r.tracks.map((x) => x.trackKey)
    expect(keys.slice(0, 3)).toContain('t:1001')
    const rian = keys.indexOf('t:1001')
    const dom = keys.indexOf('t:1007')
    expect(dom === -1 || dom > rian).toBe(true)
    expect(r.corrected).toContainEqual({ from: 'lily', to: 'lilly' })
    expect(r.corrected).toContainEqual({ from: 'plamer', to: 'palmer' })
    expect(r.q).toBe('lily plamer dont')
  })

  it('Eli Brown Ultra ranks the Ultra Miami 2026 set first at a fixed clock, and still past 2028', async () => {
    const q = { q: 'Eli Brown Ultra', kind: 'sets' as const, limit: 20, exact: false }
    // At 2026-10-01 recency separates the two Ultra sets (×1.074 vs ×1.025).
    // From 2028-03-28 both are over 730 days old, so neither gets a recency
    // boost: they tie on score and the brief's tie-break (bm25, then id) keeps
    // the 2026 set first because it was indexed first.
    for (const now of ['2026-10-01', '2029-06-01']) {
      const urls = (await runSearch(env, q, Date.parse(`${now}T12:00:00Z`))).sets.map((s) => s.url)
      expect(urls, now).toEqual([URLS.ebUltra26, URLS.ebUltra25, URLS.ebIbiza, URLS.jsUltra])
    }
  })

  it('Eli Brown Ultra ranks the Ultra Miami 2026 set first (route)', async () => {
    const r = await search(env, 'q=' + encodeURIComponent('Eli Brown Ultra'))
    const urls = r.sets.map((s) => s.url)
    expect(urls[0]).toBe(URLS.ebUltra26)
    const at = (u: string) => (urls.includes(u) ? urls.indexOf(u) : Infinity)
    expect(at(URLS.ebUltra25)).toBeLessThan(at(URLS.ebIbiza))
    expect(at(URLS.ebUltra25)).toBeLessThan(at(URLS.jsUltra))
    expect(r.sets[0]).toEqual({ url: URLS.ebUltra26, title: SETS[2]!.title, djSlug: 'elibrown', djName: 'Eli Brown', date: '2026-03-28', videoId: null, trackCount: 2, idedCount: 2, image: null, score: expect.any(Number) })
  })

  it('mau p neck returns Mau P - Neck with every set it appears on', async () => {
    const r = await search(env, 'q=' + encodeURIComponent('mau p neck'))
    const top = r.tracks[0]!
    expect(top.trackKey).toBe('t:2002')
    expect(top).toMatchObject({ trackId: '2002', artist: 'Mau P', title: 'Neck', label: 'BLACK BOOK', youtubeLink: null, trackUrl: 'https://www.1001tracklists.com/track/2002/index.html' })
    expect(top.sets.map((s) => s.url)).toEqual([URLS.ebIbiza, URLS.lpEdc, URLS.ebUltra26])
    expect(top.sets[0]).toEqual({ url: URLS.ebIbiza, title: SETS[4]!.title, djSlug: 'elibrown', djName: 'Eli Brown', date: '2026-07-04', cueSeconds: 120 })
    expect(top.sets.map((s) => s.cueSeconds)).toEqual([120, 200, 60])
    expect(r.tracks.findIndex((x) => x.trackKey === 't:1008')).not.toBe(0)
  })

  it('djs match subscription names with corrections: eli brwn corrects to brown', async () => {
    const r = await search(env, 'q=' + encodeURIComponent('eli brwn'))
    expect(r.corrected).toEqual([{ from: 'brwn', to: 'brown' }])
    expect(r.djs[0]).toEqual({ slug: 'elibrown', name: 'Eli Brown', subscribed: true, sets: 3, image: null, score: expect.any(Number) })
    expect(r.djs.map((d) => d.slug)).not.toContain('johnsummit')
    // A corrected token matches a DJ name: "summt" -> "summit" (in the vocabulary from the set title).
    const s = await search(env, 'q=' + encodeURIComponent('john summt') + '&kind=djs')
    expect(s.corrected).toContainEqual({ from: 'summt', to: 'summit' })
    expect(s.djs[0]).toMatchObject({ slug: 'johnsummit', sets: 1 })
  })

  it('a crowded vocabulary still corrects plamer to palmer (distance-1 neighbourhood)', async () => {
    // 300 terms sharing two of plamer's trigrams (ame, mer), all with rowids
    // before palmer's, so trigram recall alone ranks them above palmer and
    // fills its LIMIT 50.
    const crowd = crowdTerms()
    const crowded = makeEnv()
    await crowded.SEARCH_DB!.prepare('INSERT INTO search_vocab (term, df) SELECT value, 1 FROM json_each(?)').bind(JSON.stringify(crowd)).run()
    await crowded.SEARCH_DB!.prepare('INSERT INTO vocab_fts (rowid, term) SELECT id, term FROM search_vocab').run()
    await seed(crowded)
    const trigramOnly = (
      await crowded.SEARCH_DB!.prepare(
        `SELECT v.term AS term FROM vocab_fts f JOIN search_vocab v ON v.id = f.rowid
          WHERE vocab_fts MATCH '"pla" OR "lam" OR "ame" OR "mer"' AND length(v.term) BETWEEN 5 AND 7 ORDER BY f.rank LIMIT 50`,
      ).all<{ term: string }>()
    ).results.map((x) => x.term)
    expect(trigramOnly).toHaveLength(50)
    expect(trigramOnly).not.toContain('palmer')

    const r = await search(crowded, 'q=' + encodeURIComponent('lily plamer dont'))
    expect(r.corrected).toContainEqual({ from: 'plamer', to: 'palmer' })
    expect(r.corrected).toContainEqual({ from: 'lily', to: 'lilly' })
    const keys = r.tracks.map((x) => x.trackKey)
    expect(keys[0]).toBe('t:1001')
    expect(keys.indexOf('t:1007')).toBeGreaterThan(0)
  })

  it('exact=1 skips correction', async () => {
    const r = await search(env, 'q=plamer&exact=1')
    expect(r.corrected).toEqual([])
    expect(r.tracks[0]?.artist).not.toBe('Lilly Palmer')
    expect(r.tracks).toEqual([])
    expect(r.sets).toEqual([])
    expect(r.djs).toEqual([])
    const c = await search(env, 'q=plamer')
    expect(c.corrected).toEqual([{ from: 'plamer', to: 'palmer' }])
    expect(c.tracks[0]?.artist).toBe('Lilly Palmer')
  })

  it('a partial word that begins a vocabulary term is not reported as corrected', async () => {
    // "dol" is not a term but begins "dolla": the user is still typing.
    const r = await search(env, 'q=' + encodeURIComponent('dom dol'))
    expect(r.corrected).toEqual([])
    expect(r.tracks[0]?.trackKey).toBe('t:1007')
    // Misspellings that begin no term are still reported.
    const c = await search(env, 'q=' + encodeURIComponent('lily plamer dont'))
    expect(c.corrected).toContainEqual({ from: 'lily', to: 'lilly' })
    expect(c.corrected).toContainEqual({ from: 'plamer', to: 'palmer' })
  })

  it('kind=sets returns only sets', async () => {
    const r = await search(env, 'q=neck&kind=sets')
    expect(r.tracks).toEqual([])
    expect(r.djs).toEqual([])
    const all = await search(env, 'q=ultra&kind=sets')
    expect(all.sets.length).toBeGreaterThan(0)
    const tr = await search(env, 'q=eli&kind=tracks')
    expect(tr.sets).toEqual([])
    expect(tr.djs).toEqual([])
    expect(tr.tracks.length).toBeGreaterThan(0)
  })

  it('honours limit per kind', async () => {
    const r = await search(env, 'q=ultra&limit=1')
    expect(r.sets).toHaveLength(1)
  })

  it('orphan tracks are not returned', async () => {
    expect((await search(env, 'q=december')).tracks.map((x) => x.trackKey)).toContain('t:1008')
    await env.SEARCH_DB!.prepare("UPDATE search_tracks SET sets_count = 0 WHERE track_key = 't:1008'").run()
    await env.SEARCH_DB!.prepare("DELETE FROM search_track_sets WHERE track_key = 't:1008'").run()
    const r = await search(env, 'q=december')
    expect(r.tracks.map((x) => x.trackKey)).not.toContain('t:1008')
  })

  it('FTS syntax in the query is inert', async () => {
    for (const q of ['"', 'neck*', '(mau', 'mau -neck', 'title:neck', 'NEAR(mau neck)', 'AND', 'mau AND OR neck']) {
      const r = await get(env, 'q=' + encodeURIComponent(q))
      expect(r.status, q).toBe(200)
    }
  })

  it('an empty q is 200 with empty groups; bad kind is 400; no SEARCH_DB is 503', async () => {
    expect(await search(env, 'q=')).toEqual({ q: '', corrected: [], tracks: [], sets: [], djs: [] })
    expect(await search(env, 'q=' + encodeURIComponent('  "  '))).toEqual({ q: '"', corrected: [], tracks: [], sets: [], djs: [] })
    const bad = await get(env, 'q=neck&kind=bogus')
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: string }).error).toBe('invalid_request')
    // A query with no words needs no index.
    for (const q of ['', encodeURIComponent('"')]) {
      const empty = await get(makeEnv({ SEARCH_DB: undefined }), `q=${q}`)
      expect(empty.status).toBe(200)
      expect(((await empty.json()) as SearchResponse).tracks).toEqual([])
    }
    const none = await get(makeEnv({ SEARCH_DB: undefined }), 'q=neck')
    expect(none.status).toBe(503)
    expect(await none.json()).toEqual({ error: 'search_unavailable', message: 'The search index is not bound to this Worker.' })
  })
})
