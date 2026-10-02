/**
 * The search indexer (src/lib/search/index.ts): verified set fetches are
 * written to SEARCH_DB, one batch per set, in the background. Both databases
 * are the real migrations on sqlite-wasm (FTS5 + trigram).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/types'
import type { Logger } from '../src/lib/log'
import type { PageRow, ScrapedTracklist } from '../src/lib/tracklists1001'
import { fakeD1 } from './helpers/fake-d1'
import { fakeKV } from './helpers/fake-kv'
import { tracklistFingerprint } from '../src/lib/verification'
import { DEFAULT_POOL_SETTINGS } from '../src/lib/pool-settings'
import { recordSetFetch } from '../src/lib/fetch-scheduler'
import { drainSearchIndex, INDEX_FORMAT_SINCE, indexSet, indexVerifiedFetch, MAX_TRACKS_PER_SET, queueSearchIndex, tracksFromRows, type IndexSetInput, type IndexTrack } from '../src/lib/search/index'

const NOW = Math.floor(Date.now() / 1000)
const VERIFIED_AT = NOW - 3600

const SET_LP = 'https://www.1001tracklists.com/tracklist/2lp7k1/lilly-palmer-circuitgrounds-edc-las-vegas-united-states-2026-05-16.html'
const HTML_LP = '<title>Lilly Palmer @ circuitGROUNDS, EDC Las Vegas, United States 2026-05-16</title>'
const SET_EB = 'https://www.1001tracklists.com/tracklist/3eb9q2/eli-brown-ultra-music-festival-miami-united-states-2026-03-28.html'
const HTML_EB = '<title>Eli Brown @ Ultra Music Festival Miami, United States 2026-03-28</title>'

function row(over: Partial<PageRow>): PageRow {
  return {
    startTime: '',
    startSeconds: null,
    artist: 'Artist',
    title: 'Title',
    trackId: null,
    trackUrl: null,
    artworkUrl: null,
    isUnidentified: false,
    idStatus: null,
    isMashupLinked: false,
    ownStartSeconds: null,
    anonymous: false,
    label: null,
    ...over,
  }
}

function tracklist(rows: PageRow[]): ScrapedTracklist {
  return {
    slug: 'x',
    setAppleLink: null,
    setYoutubeLink: null,
    setSoundcloudLink: null,
    tracks: rows.filter((r) => !r.anonymous),
    rows,
    decoy: { named: rows.length, mismatched: 0, nearMismatched: 0, suspected: false },
  }
}

const LP_ROWS: PageRow[] = [
  row({ artist: 'Mau P', title: 'Neck', trackId: '909720', trackUrl: 'https://www.1001tracklists.com/track/mau-p-neck/index.html', label: 'BLACK BOOK', startSeconds: 0, ownStartSeconds: 0 }),
  row({ artist: 'Rian Wood & Version 34', title: "Don't Stop", trackId: '1234567', label: 'RAVE WORLD', startSeconds: 240, ownStartSeconds: 240 }),
  row({ artist: 'Lilly Palmer', title: 'Venus', trackId: '555001', startSeconds: 240, ownStartSeconds: 270, isMashupLinked: true }),
]
const EB_ROWS: PageRow[] = [
  row({ artist: 'Eli Brown', title: 'Be The One', trackId: '777001', label: 'Repopulate Mars', startSeconds: 0, ownStartSeconds: 0 }),
  row({ artist: 'Mau P', title: 'Neck', trackId: '909720', label: 'BLACK BOOK', startSeconds: 180, ownStartSeconds: 180 }),
]

function makeEnv(over: Partial<Env> = {}): Env {
  return { CACHE: fakeKV(), SUBS: fakeKV(), DB: fakeD1(), SEARCH_DB: fakeD1({ migrations: 'search' }), API_TOKEN: 't', YOUTUBE_API_KEY: 'k', ...over } as Env
}

function makeLog(): Logger & { warn: ReturnType<typeof vi.fn> } {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), time: vi.fn(), child: vi.fn(), counters: {} }
  log.child.mockReturnValue(log)
  return log as unknown as Logger & { warn: ReturnType<typeof vi.fn> }
}

async function seedDj(env: Env, slug: string, artistName: string | null, position = 0) {
  await env.DB.prepare('INSERT OR IGNORE INTO subscriptions (slug, source_url, added_at, position) VALUES (?, ?, 0, ?)').bind(slug, `https://www.1001tracklists.com/dj/${slug}/`, position).run()
  await env.DB.prepare('INSERT OR IGNORE INTO sub_sync (slug, artist_name) VALUES (?, ?)').bind(slug, artistName).run()
}

async function seedSet(env: Env, o: { url: string; slugs: string[]; parsed: ScrapedTracklist; state?: 'verified' | 'pending'; videoSource?: string | null }) {
  let i = 0
  for (const slug of o.slugs) {
    await env.DB.prepare('INSERT INTO tracklists (slug, url, position, discovered_at, processed, video_source) VALUES (?, ?, ?, 0, 1, ?)').bind(slug, o.url, i++, o.videoSource ?? null).run()
  }
  const state = o.state ?? 'verified'
  await env.DB.prepare(
    `INSERT INTO set_verification (url, state, fingerprint, row_count, first_account, first_fetched_at, verify_due_at, second_account, second_fetched_at, verified_at, updated_at)
     VALUES (?, ?, ?, ?, 'acct-1', ?, NULL, ?, ?, ?, ?)`,
  )
    .bind(o.url, state, await tracklistFingerprint(o.parsed), o.parsed.rows.length, VERIFIED_AT - 86400, state === 'verified' ? 'acct-2' : null, state === 'verified' ? VERIFIED_AT : null, state === 'verified' ? VERIFIED_AT : null, VERIFIED_AT)
    .run()
}

const all = async <T = Record<string, unknown>>(env: Env, sql: string, ...binds: unknown[]) => (await env.SEARCH_DB!.prepare(sql).bind(...binds).all<T>()).results
const one = async <T = Record<string, unknown>>(env: Env, sql: string, ...binds: unknown[]) => (await all<T>(env, sql, ...binds))[0] ?? null

/** Track keys whose tracks_fts row matches `q`. */
const ftsKeys = async (env: Env, q: string) =>
  (await all<{ track_key: string }>(env, 'SELECT t.track_key FROM tracks_fts f JOIN search_tracks t ON t.id = f.rowid WHERE tracks_fts MATCH ? ORDER BY t.track_key', q)).map((r) => r.track_key)

async function lpEnv() {
  const env = makeEnv()
  const parsed = tracklist(LP_ROWS)
  await seedDj(env, 'lillypalmer', 'Lilly Palmer')
  await seedSet(env, { url: SET_LP, slugs: ['lillypalmer'], parsed, videoSource: '1001tl' })
  return { env, parsed }
}

/** The same database with a batch() that rejects (fakeD1's methods close over the db, so a spread copy works). */
const failingBatch = (db: D1Database) => ({ ...(db as object), batch: async () => Promise.reject(new Error('D1_ERROR: boom')) }) as unknown as D1Database

afterEach(async () => {
  await drainSearchIndex()
})

describe('search indexer', () => {
  it('indexes a verified fetch: set row, tracks, links, FTS rows, vocabulary', async () => {
    const { env, parsed } = await lpEnv()
    expect(await indexVerifiedFetch(env, { setUrl: SET_LP, html: HTML_LP, parsed, videoId: 'vid1', nowSec: NOW })).toBe('indexed')

    const set = await one(env, 'SELECT * FROM search_sets WHERE set_url = ?', SET_LP)
    expect(set).toMatchObject({
      title: 'Lilly Palmer @ circuitGROUNDS, EDC Las Vegas, United States 2026-05-16',
      dj_slug: 'lillypalmer',
      dj_name: 'Lilly Palmer',
      set_date: '2026-05-16',
      video_id: 'vid1',
      video_source: '1001tl',
      track_count: 3,
      ided_count: 3,
      source: 'page',
      indexed_at: NOW,
    })

    const track = await one(env, 'SELECT * FROM search_tracks WHERE track_key = ?', 't:909720')
    expect(track).toMatchObject({ track_id: '909720', artist: 'Mau P', title: 'Neck', label: 'BLACK BOOK', sets_count: 1, track_url: 'https://www.1001tracklists.com/track/mau-p-neck/index.html' })

    const links = await all(env, 'SELECT track_key, pos, cue_seconds, layered FROM search_track_sets WHERE set_url = ? ORDER BY pos', SET_LP)
    expect(links).toEqual([
      { track_key: 't:909720', pos: 0, cue_seconds: 0, layered: 0 },
      { track_key: 't:1234567', pos: 1, cue_seconds: 240, layered: 0 },
      { track_key: 't:555001', pos: 2, cue_seconds: 270, layered: 1 },
    ])

    expect(await ftsKeys(env, 'djs:"lilly"')).toEqual(['t:1234567', 't:555001', 't:909720'])
    expect(await ftsKeys(env, 'title:"dont" AND label:"rave"')).toEqual(['t:1234567'])
    expect(await ftsKeys(env, 'set_titles:"circuitgrounds"')).toHaveLength(3)
    const sets = await all(env, `SELECT s.set_url FROM sets_fts f JOIN search_sets s ON s.id = f.rowid WHERE sets_fts MATCH 'dj:"lillypalmer" AND title:"edc"'`)
    expect(sets).toEqual([{ set_url: SET_LP }])

    const vocab = await all<{ term: string }>(env, `SELECT term FROM vocab_fts WHERE vocab_fts MATCH '"alm"'`)
    expect(vocab.map((v) => v.term)).toContain('palmer')
    expect(await one(env, 'SELECT df FROM search_vocab WHERE term = ?', 'palmer')).toEqual({ df: 1 })
    // Terms shorter than 3 are not vocabulary.
    expect(await one(env, 'SELECT term FROM search_vocab WHERE term = ?', 'p')).toBeNull()
  })

  it('skips a set already indexed since it verified', async () => {
    const { env, parsed } = await lpEnv()
    const f = { setUrl: SET_LP, html: HTML_LP, parsed, videoId: 'vid1' }
    expect(await indexVerifiedFetch(env, { ...f, nowSec: NOW })).toBe('indexed')
    expect(await indexVerifiedFetch(env, { ...f, nowSec: NOW + 500 })).toBe('skipped')
    expect(await one(env, 'SELECT indexed_at FROM search_sets WHERE set_url = ?', SET_LP)).toEqual({ indexed_at: NOW })
    expect(await indexVerifiedFetch(env, { ...f, videoId: 'vid2', nowSec: NOW + 600 })).toBe('indexed')
    expect(await one(env, 'SELECT indexed_at, video_id FROM search_sets WHERE set_url = ?', SET_LP)).toEqual({ indexed_at: NOW + 600, video_id: 'vid2' })
  })

  it('re-indexes a set indexed before INDEX_FORMAT_SINCE once (new columns), then skips it again; the page image is kept', async () => {
    const { env, parsed } = await lpEnv()
    await env.DB.prepare('UPDATE set_verification SET verified_at = ? WHERE url = ?').bind(INDEX_FORMAT_SINCE - 100, SET_LP).run()
    const html = HTML_LP + '<meta property="og:image" content="https://i1.sndcdn.com/avatars-lp-t500x500.jpg">'
    const f = { setUrl: SET_LP, html, parsed, videoId: 'vid1' }
    expect(await indexVerifiedFetch(env, { ...f, nowSec: INDEX_FORMAT_SINCE - 50 })).toBe('indexed')
    expect(await indexVerifiedFetch(env, { ...f, nowSec: INDEX_FORMAT_SINCE + 10 })).toBe('indexed')
    expect(await indexVerifiedFetch(env, { ...f, nowSec: INDEX_FORMAT_SINCE + 20 })).toBe('skipped')
    expect(await one(env, 'SELECT image_url FROM search_sets WHERE set_url = ?', SET_LP)).toEqual({ image_url: 'https://i1.sndcdn.com/avatars-lp-t500x500.jpg' })
  })

  it('does not index a list whose fingerprint is not the verified one', async () => {
    const { env } = await lpEnv()
    const changed = tracklist([...LP_ROWS.slice(0, 2), row({ ...LP_ROWS[2]!, title: 'Venus (Edit)' })])
    expect(await indexVerifiedFetch(env, { setUrl: SET_LP, html: HTML_LP, parsed: changed, videoId: null, nowSec: NOW })).toBe('not_verified')
    expect(await all(env, 'SELECT * FROM search_sets')).toEqual([])
  })

  it('does not index pending sets', async () => {
    const env = makeEnv()
    const parsed = tracklist(LP_ROWS)
    await seedDj(env, 'lillypalmer', 'Lilly Palmer')
    await seedSet(env, { url: SET_LP, slugs: ['lillypalmer'], parsed, state: 'pending' })
    expect(await indexVerifiedFetch(env, { setUrl: SET_LP, html: HTML_LP, parsed, videoId: null, nowSec: NOW })).toBe('not_verified')
    expect(await all(env, 'SELECT * FROM search_sets')).toEqual([])
  })

  it('does not index a set no subscribed DJ lists', async () => {
    const env = makeEnv()
    const parsed = tracklist(LP_ROWS)
    await seedSet(env, { url: SET_LP, slugs: ['lillypalmer'], parsed })
    expect(await indexVerifiedFetch(env, { setUrl: SET_LP, html: HTML_LP, parsed, videoId: null, nowSec: NOW })).toBe('not_verified')
    expect(await all(env, 'SELECT * FROM search_sets')).toEqual([])
  })

  it("a live index replaces a backfilled set's tracks", async () => {
    const { env, parsed } = await lpEnv()
    // Backfill (trusted mkvid list): no track ids, so hash keys; indexed after verification.
    await indexSet(
      env,
      {
        setUrl: SET_LP,
        djSlug: 'lillypalmer',
        djName: 'Lilly Palmer',
        title: 'Lilly Palmer @ circuitGROUNDS, EDC Las Vegas, United States 2026-05-16',
        setDate: '2026-05-16',
        videoId: 'vid1',
        videoSource: 'mkvid',
        trackCount: 3,
        idedCount: 3,
        source: 'mkvid',
        imageUrl: null,
        tracks: tracksFromRows(LP_ROWS.map((r) => ({ ...r, trackId: null, label: null }))),
      },
      NOW,
    )
    const before = await all<{ track_key: string }>(env, 'SELECT track_key FROM search_track_sets WHERE set_url = ?', SET_LP)
    expect(before).toHaveLength(3)
    expect(before.every((r) => r.track_key.startsWith('h:'))).toBe(true)
    expect(await ftsKeys(env, 'title:"neck"')).toHaveLength(1)

    // indexed_at (NOW) >= verified_at and the same video, but the stored set is a backfill: not skipped.
    expect(await indexVerifiedFetch(env, { setUrl: SET_LP, html: HTML_LP, parsed, videoId: 'vid1', nowSec: NOW + 10 })).toBe('indexed')
    const after = await all<{ track_key: string }>(env, 'SELECT track_key FROM search_track_sets WHERE set_url = ? ORDER BY track_key', SET_LP)
    expect(after.map((r) => r.track_key)).toEqual(['t:1234567', 't:555001', 't:909720'])
    const orphans = await all<{ sets_count: number }>(env, `SELECT sets_count FROM search_tracks WHERE track_key LIKE 'h:%'`)
    expect(orphans).toHaveLength(3)
    expect(orphans.every((o) => o.sets_count === 0)).toBe(true)
    expect(await one(env, `SELECT COUNT(*) AS n FROM tracks_fts WHERE rowid IN (SELECT id FROM search_tracks WHERE track_key LIKE 'h:%')`)).toEqual({ n: 0 })
    expect(await ftsKeys(env, 'title:"neck"')).toEqual(['t:909720'])
    expect(await one(env, 'SELECT source FROM search_sets WHERE set_url = ?', SET_LP)).toEqual({ source: 'page' })
  })

  it('a track in two sets aggregates both DJs and set titles', async () => {
    const { env, parsed } = await lpEnv()
    const eb = tracklist(EB_ROWS)
    await seedDj(env, 'elibrown', 'Eli Brown', 1)
    await seedSet(env, { url: SET_EB, slugs: ['elibrown'], parsed: eb })
    expect(await indexVerifiedFetch(env, { setUrl: SET_LP, html: HTML_LP, parsed, videoId: null, nowSec: NOW })).toBe('indexed')
    expect(await indexVerifiedFetch(env, { setUrl: SET_EB, html: HTML_EB, parsed: eb, videoId: null, nowSec: NOW })).toBe('indexed')

    expect(await one(env, 'SELECT sets_count FROM search_tracks WHERE track_key = ?', 't:909720')).toEqual({ sets_count: 2 })
    expect(await ftsKeys(env, 'djs:"brown"')).toContain('t:909720')
    expect(await ftsKeys(env, 'djs:"palmer"')).toContain('t:909720')
    expect(await ftsKeys(env, 'set_titles:"ultra" AND set_titles:"circuitgrounds"')).toEqual(['t:909720'])
    // A track only in the first set is untouched by the second.
    expect(await ftsKeys(env, 'djs:"brown"')).not.toContain('t:1234567')
  })

  it("a track's stored label survives a set that lists it without one", async () => {
    const { env, parsed } = await lpEnv()
    const eb = tracklist(EB_ROWS.map((r) => ({ ...r, label: null })))
    await seedDj(env, 'elibrown', 'Eli Brown', 1)
    await seedSet(env, { url: SET_EB, slugs: ['elibrown'], parsed: eb })
    await indexVerifiedFetch(env, { setUrl: SET_LP, html: HTML_LP, parsed, videoId: null, nowSec: NOW })
    await indexVerifiedFetch(env, { setUrl: SET_EB, html: HTML_EB, parsed: eb, videoId: null, nowSec: NOW })
    expect(await one(env, 'SELECT label FROM search_tracks WHERE track_key = ?', 't:909720')).toEqual({ label: 'BLACK BOOK' })
    expect(await ftsKeys(env, 'label:"black"')).toEqual(['t:909720'])
  })

  it('a b2b set is indexed under the smallest slug', async () => {
    const env = makeEnv()
    const parsed = tracklist(LP_ROWS)
    await seedDj(env, 'zeta', 'Zeta Sound', 0)
    await seedDj(env, 'alpha', 'Alpha Beat', 1)
    await seedSet(env, { url: SET_LP, slugs: ['zeta', 'alpha'], parsed })
    expect(await indexVerifiedFetch(env, { setUrl: SET_LP, html: HTML_LP, parsed, videoId: null, nowSec: NOW })).toBe('indexed')
    expect(await one(env, 'SELECT dj_slug, dj_name FROM search_sets WHERE set_url = ?', SET_LP)).toEqual({ dj_slug: 'alpha', dj_name: 'Alpha Beat' })
  })

  it('falls back to the prettified slug and the URL words without a DJ name or a title', async () => {
    const env = makeEnv()
    const parsed = tracklist(LP_ROWS)
    await seedDj(env, 'lilly_palmer', null)
    await seedSet(env, { url: SET_LP, slugs: ['lilly_palmer'], parsed })
    expect(await indexVerifiedFetch(env, { setUrl: SET_LP, html: '<html></html>', parsed, videoId: null, nowSec: NOW })).toBe('indexed')
    expect(await one(env, 'SELECT dj_name, title, set_date FROM search_sets WHERE set_url = ?', SET_LP)).toEqual({
      dj_name: 'Lilly Palmer',
      title: 'lilly palmer circuitgrounds edc las vegas united states',
      set_date: '2026-05-16',
    })
  })

  it('anonymous, unidentified and duplicate rows are not indexed', async () => {
    const env = makeEnv()
    const rows = [
      row({ artist: 'Eli Brown', title: 'Be The One', trackId: '222', startSeconds: 0, ownStartSeconds: 0 }),
      row({ artist: 'ID', title: 'ID', anonymous: true, startSeconds: 30, ownStartSeconds: 30 }),
      row({ artist: 'Cave Studio', title: 'ID', isUnidentified: true, startSeconds: 45, ownStartSeconds: 45 }),
      row({ artist: 'Mau P', title: 'Neck', trackId: '111', startSeconds: 60, ownStartSeconds: 60 }),
      row({ artist: '', title: 'No Artist', trackId: '333' }),
      row({ artist: 'Mau P', title: 'Neck', trackId: '111', startSeconds: 500, ownStartSeconds: 500 }),
    ]
    expect(tracksFromRows(rows).map((t) => t.trackId)).toEqual(['222', '111', '111'])
    const parsed = tracklist(rows)
    await seedDj(env, 'elibrown', 'Eli Brown')
    await seedSet(env, { url: SET_EB, slugs: ['elibrown'], parsed })
    expect(await indexVerifiedFetch(env, { setUrl: SET_EB, html: HTML_EB, parsed, videoId: null, nowSec: NOW })).toBe('indexed')
    expect(await all(env, 'SELECT track_key FROM search_tracks ORDER BY track_key')).toEqual([{ track_key: 't:111' }, { track_key: 't:222' }])
    expect(await all(env, 'SELECT track_key, pos, cue_seconds FROM search_track_sets ORDER BY pos')).toEqual([
      { track_key: 't:222', pos: 0, cue_seconds: 0 },
      { track_key: 't:111', pos: 1, cue_seconds: 60 },
    ])
    expect(await one(env, 'SELECT track_count, ided_count FROM search_sets')).toEqual({ track_count: 6, ided_count: 4 })
    expect(await one(env, 'SELECT term FROM search_vocab WHERE term = ?', 'cave')).toBeNull()
  })

  it('queueSearchIndex ignores outcomes other than verified/unchanged and a missing SEARCH_DB', async () => {
    const { env, parsed } = await lpEnv()
    const f = { setUrl: SET_LP, html: HTML_LP, parsed, videoId: null, nowSec: NOW }
    for (const outcome of ['first', 'mismatch', 'changed', 'still_pending', 'decoy', 'no_account'] as const) queueSearchIndex(env, f, outcome)
    queueSearchIndex(env, f, undefined)
    await drainSearchIndex()
    expect(await all(env, 'SELECT * FROM search_sets')).toEqual([])

    const noSearch = { ...env, SEARCH_DB: undefined } as Env
    expect(() => queueSearchIndex(noSearch, f, 'verified')).not.toThrow()
    await drainSearchIndex()
    expect(await all(env, 'SELECT * FROM search_sets')).toEqual([])

    queueSearchIndex(env, f, 'unchanged')
    await drainSearchIndex()
    expect(await all(env, 'SELECT set_url FROM search_sets')).toEqual([{ set_url: SET_LP }])
  })

  it('a failing index write is swallowed', async () => {
    const { env, parsed } = await lpEnv()
    const failing = { ...env, SEARCH_DB: failingBatch(env.SEARCH_DB!) } as Env
    const log = makeLog()
    queueSearchIndex(failing, { setUrl: SET_LP, html: HTML_LP, parsed, videoId: null, nowSec: NOW, log }, 'verified')
    await expect(drainSearchIndex()).resolves.toBeUndefined()
    expect(log.warn).toHaveBeenCalledWith('search.index_failed', expect.objectContaining({ setUrl: SET_LP, errorMessage: 'D1_ERROR: boom' }))

    // Through the sync path: a pending verification from another account, confirmed by this fetch.
    const env2 = makeEnv()
    await seedDj(env2, 'elibrown', 'Eli Brown')
    const eb = tracklist(EB_ROWS)
    await env2.DB.prepare('INSERT INTO tracklists (slug, url, position, discovered_at, processed) VALUES (?, ?, 0, 0, 1)').bind('elibrown', SET_EB).run()
    await env2.DB.prepare(
      `INSERT INTO set_verification (url, state, fingerprint, row_count, first_account, first_fetched_at, verify_due_at, updated_at)
       VALUES (?, 'pending', ?, ?, 'acct-1', ?, ?, ?)`,
    )
      .bind(SET_EB, await tracklistFingerprint(eb), eb.rows.length, NOW - 10 * 86400, NOW - 9 * 86400, NOW - 10 * 86400)
      .run()
    const failing2 = { ...env2, SEARCH_DB: failingBatch(env2.SEARCH_DB!) } as Env
    const log2 = makeLog()
    const out = await recordSetFetch(failing2, {
      setUrl: SET_EB,
      html: HTML_EB,
      parsed: eb,
      videoId: null,
      accountId: 'acct-2',
      fetchedAt: new Date(NOW * 1000).toISOString(),
      settings: DEFAULT_POOL_SETTINGS,
      pool: null,
      log: log2,
    })
    expect(out.verification?.outcome).toBe('verified')
    await drainSearchIndex()
    expect(log2.warn).toHaveBeenCalledWith('search.index_failed', expect.objectContaining({ setUrl: SET_EB }))
    expect(log2.warn).not.toHaveBeenCalledWith('scheduler.record_fetch_failed', expect.anything())
    expect(await all(env2, 'SELECT * FROM search_sets')).toEqual([])
  })

  it('a verified fetch through recordSetFetch is indexed once drained', async () => {
    const env = makeEnv()
    await seedDj(env, 'elibrown', 'Eli Brown')
    const eb = tracklist(EB_ROWS)
    await env.DB.prepare('INSERT INTO tracklists (slug, url, position, discovered_at, processed) VALUES (?, ?, 0, 0, 1)').bind('elibrown', SET_EB).run()
    await env.DB.prepare(
      `INSERT INTO set_verification (url, state, fingerprint, row_count, first_account, first_fetched_at, verify_due_at, updated_at)
       VALUES (?, 'pending', ?, ?, 'acct-1', ?, ?, ?)`,
    )
      .bind(SET_EB, await tracklistFingerprint(eb), eb.rows.length, NOW - 10 * 86400, NOW - 9 * 86400, NOW - 10 * 86400)
      .run()
    const out = await recordSetFetch(env, { setUrl: SET_EB, html: HTML_EB, parsed: eb, videoId: 'yt1', accountId: 'acct-2', fetchedAt: new Date(NOW * 1000).toISOString(), settings: DEFAULT_POOL_SETTINGS, pool: null })
    expect(out.verification?.outcome).toBe('verified')
    await drainSearchIndex()
    expect(await one(env, 'SELECT dj_name, video_id, source FROM search_sets WHERE set_url = ?', SET_EB)).toEqual({ dj_name: 'Eli Brown', video_id: 'yt1', source: 'page' })
  })

  describe('fixed statement count', () => {
    /** n distinct synthetic tracks, every other one labeled, with a realistic track URL. */
    const synth = (n: number): IndexTrack[] =>
      Array.from({ length: n }, (_, i) => ({
        trackId: String(100000 + i),
        trackUrl: `https://www.1001tracklists.com/track/${(100000 + i).toString(36)}/artist-${i}-track-number-${i}/index.html`,
        artist: `Artist ${i} & Friend ${i}`,
        title: `Track Number ${i} (Extended Mix)`,
        label: i % 2 ? `Label ${i} Records` : null,
        artworkUrl: null,
        cueSeconds: i * 60,
        layered: false,
      }))
    const input = (setUrl: string, tracks: IndexTrack[]): IndexSetInput => ({
      setUrl, djSlug: 'somedj', djName: 'Some DJ', title: 'Some DJ @ Big Festival 2026-05-16', setDate: '2026-05-16',
      videoId: null, videoSource: null, trackCount: tracks.length, idedCount: tracks.length, source: 'page', imageUrl: null, tracks,
    })
    async function batchSizes(env: Env, ...inputs: IndexSetInput[]): Promise<number[]> {
      const sizes: number[] = []
      const sdb = env.SEARCH_DB!
      const orig = sdb.batch.bind(sdb)
      const spy = vi.spyOn(sdb, 'batch').mockImplementation(async (s) => {
        sizes.push(s.length)
        return orig(s)
      })
      for (const i of inputs) await indexSet(env, i, NOW)
      spy.mockRestore()
      return sizes
    }

    it('the batch for a 30-track set and for a 200-track set have the same statement count', async () => {
      const env = makeEnv()
      const sizes = await batchSizes(env, input(SET_LP, synth(30)), input(SET_EB, synth(200)), input(SET_LP, synth(200).slice(100)))
      expect(sizes).toEqual([12, 12, 12])
      // The re-index of SET_LP dropped tracks 0-29 (orphaned) and links 100-199.
      expect(await one(env, 'SELECT COUNT(*) AS n FROM search_track_sets WHERE set_url = ?', SET_LP)).toEqual({ n: 100 })
      expect(await one(env, `SELECT sets_count FROM search_tracks WHERE track_key = 't:100000'`)).toEqual({ sets_count: 1 })
      expect(await one(env, `SELECT sets_count FROM search_tracks WHERE track_key = 't:100150'`)).toEqual({ sets_count: 2 })
      expect(await one(env, 'SELECT COUNT(*) AS n FROM tracks_fts')).toEqual({ n: 200 })
    })

    it(`indexes at most ${MAX_TRACKS_PER_SET} tracks of a set`, async () => {
      const env = makeEnv()
      const r = await indexSet(env, input(SET_LP, synth(MAX_TRACKS_PER_SET + 100)), NOW)
      expect(r.tracks).toBe(MAX_TRACKS_PER_SET)
      expect(await one(env, 'SELECT COUNT(*) AS n, MAX(pos) AS maxPos FROM search_track_sets')).toEqual({ n: MAX_TRACKS_PER_SET, maxPos: MAX_TRACKS_PER_SET - 1 })
      expect(await one(env, 'SELECT COUNT(*) AS n FROM tracks_fts')).toEqual({ n: MAX_TRACKS_PER_SET })
    })
  })
})
