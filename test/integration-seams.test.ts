/**
 * Seams between the pool fetch layer (W4), the tracklist cache (W5), playlist
 * hygiene (W6) and verified-only renders (W7), exercised through the real
 * sync, the real verification state and the real routes. Network edges (the
 * pool fetch, YouTube) are stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Env } from '../src/types'
import type { StoredTokens } from '../src/lib/google-oauth'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'

vi.mock('../src/lib/dj-index', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/dj-index')>('../src/lib/dj-index')
  return { ...actual, fetch1001Html: vi.fn(), crawlDjIndex: vi.fn(), parseSetYouTubeId: vi.fn() }
})
vi.mock('../src/lib/youtube-playlists', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/youtube-playlists')>('../src/lib/youtube-playlists')
  return { ...actual, findPlaylistByTitle: vi.fn(), createPlaylist: vi.fn(), listPlaylistVideoIds: vi.fn(), addVideoToPlaylist: vi.fn(), removeVideoFromPlaylist: vi.fn() }
})
vi.mock('../src/lib/video-meta', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/video-meta')>('../src/lib/video-meta')
  return { ...actual, getVideoMeta: vi.fn(async () => new Map()) }
})
// Real parser, counted: every set page must be parsed once per fetch.
vi.mock('../src/lib/tracklists1001', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/tracklists1001')>('../src/lib/tracklists1001')
  return { ...actual, parseTracklist: vi.fn(actual.parseTracklist) }
})

import { crawlDjIndex, fetch1001Html, parseSetYouTubeId } from '../src/lib/dj-index'
import { findPlaylistByTitle, listPlaylistVideoIds } from '../src/lib/youtube-playlists'
import { parseTracklist } from '../src/lib/tracklists1001'
import { syncOne } from '../src/lib/sync'
import { isVerified, tracklistFingerprint } from '../src/lib/verification'
import { getMkvidRequestForSet, saveMkvidTracks } from '../src/lib/mkvid'
import { MkvidClaimResponse } from '../src/schemas'
import { app } from '../src/index'

const here = dirname(fileURLToPath(import.meta.url))
const fx = (name: string) => readFileSync(resolve(here, 'fixtures', name), 'utf8')
const mocked = (f: unknown) => f as ReturnType<typeof vi.fn>

// habstrakt: 31 rows, every one identified, a SoundCloud player, set date 2024-11-11 (no ID wait).
const SET = 'https://www.1001tracklists.com/tracklist/18kll1h1/habstrakt-jstjr-1001tracklists-x-dj-lovers-club-pres.-waterways-amsterdam-dance-event-netherlands-2024-11-11.html'
const HTML = fx('tracklist-habstrakt.html')
const sub = { slug: 'habstrakt', sourceUrl: 'https://www.1001tracklists.com/dj/habstrakt/', addedAt: 0 }
const tokens: StoredTokens = { accessToken: 'at', refreshToken: 'rt', expiresAt: Math.floor(Date.now() / 1000) + 3600, scope: 'https://www.googleapis.com/auth/youtube', channelId: null, channelTitle: null, connectedAt: 0 }

function makeEnv(over: Partial<Env> = {}): Env {
  return {
    CACHE: fakeKV(),
    DB: fakeD1(),
    SUBS: fakeKV({ 'oauth:google': JSON.stringify(tokens) }),
    API_TOKEN: 'tasker',
    YOUTUBE_API_KEY: 'k',
    MKVID_TOKEN: 'mk-secret',
    ...over,
  } as Env
}

const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3600_000).toISOString()
const served = (accountId: string, hoursAgo: number) =>
  mocked(fetch1001Html).mockResolvedValue({ html: HTML, via: 'pool', state: { cookie: '' }, accountId, exitLabel: 'exit-x', fetchedAt: at(hoursAgo) })
const verifyRun = (env: Env, exclude: string[]) =>
  syncOne(env, sub, 'tok', { skipDjCrawl: true, priority: 'verify', excludeAccounts: exclude, selection: { newUrls: [], recheckUrls: [SET] } })
const claim = async (env: Env) =>
  MkvidClaimResponse.parse(
    await (await app.request('http://x/mkvid/claim', { method: 'POST', headers: { Authorization: 'Bearer mk-secret', 'Content-Type': 'application/json' }, body: '{}' }, env)).json(),
  )
const trusted = async (env: Env) =>
  (await env.DB.prepare('SELECT t.trusted AS trusted FROM mkvid_request_tracks t JOIN mkvid_requests r ON r.id = t.request_id WHERE r.set_url = ?').bind(SET).first<{ trusted: number }>())?.trusted

const realParse = (await vi.importActual<typeof import('../src/lib/tracklists1001')>('../src/lib/tracklists1001')).parseTracklist

beforeEach(() => {
  vi.resetAllMocks()
  mocked(parseTracklist).mockImplementation(realParse)
  mocked(crawlDjIndex).mockResolvedValue({ artistName: 'Habstrakt', tracklistUrls: [SET], pagesWalked: 1, stopReason: 'empty' })
  mocked(findPlaylistByTitle).mockImplementation(async (title: string) => ({ id: title.startsWith('All') ? 'PLc' : 'PLa', title }))
  mocked(listPlaylistVideoIds).mockImplementation(async () => new Set<string>())
  mocked(parseSetYouTubeId).mockReturnValue(null) // "no YouTube recording": the SoundCloud one goes to mkvid
})
afterEach(() => vi.unstubAllGlobals())

describe('seam 1: only a verified list is claimable (W4 isVerified behind W7 readiness)', () => {
  it('a decoy-clean but unverified list is not claimable; a matching second fetch by another account makes it so', async () => {
    const env = makeEnv()
    served('acct-1', 3)
    await syncOne(env, sub, 'tok')
    expect(await getMkvidRequestForSet(env, SET)).toMatchObject({ status: 'pending' })
    expect(await isVerified(env, SET)).toBe(false)
    expect(await trusted(env)).toBe(0)
    expect((await claim(env)).request).toBeNull()

    served('acct-2', 0)
    await verifyRun(env, ['acct-1'])
    expect(await isVerified(env, SET)).toBe(true)
    expect(await trusted(env)).toBe(1)
    const c = await claim(env)
    expect(c.request).toMatchObject({ setUrl: SET, tracksTrusted: true })
    expect(c.request!.tracks.length).toBeGreaterThan(10)
    expect(c.request!.tracks[0]!.artist).toBeTruthy()
  })

  it('a second fetch by the SAME account does not verify, and the list stays unclaimable', async () => {
    const env = makeEnv()
    served('acct-1', 3)
    await syncOne(env, sub, 'tok')
    served('acct-1', 0)
    await verifyRun(env, [])
    expect(await isVerified(env, SET)).toBe(false)
    expect(await trusted(env)).toBe(0)
    expect((await claim(env)).request).toBeNull()
  })
})

describe('review N2: a stored mkvid list is trusted only when it IS the verified list', () => {
  // List G: the habstrakt page with one title renamed everywhere it appears, so
  // the page still passes the decoy check but fingerprints differently.
  const F = realParse(SET, HTML)
  const oldTitle = F.rows.find((r) => r.title && r.title.length > 6 && HTML.split(r.title).length > 1)!.title!
  const NEW_TITLE = 'Totally Different Tune'
  const HTML_G = HTML.split(oldTitle).join(NEW_TITLE)
  const servedG = (accountId: string | undefined, hoursAgo: number) =>
    mocked(fetch1001Html).mockResolvedValue({ html: HTML_G, via: 'pool', state: { cookie: '' }, accountId, exitLabel: 'exit-x', fetchedAt: at(hoursAgo) })
  const storedTracks = async (env: Env) =>
    (await env.DB.prepare('SELECT t.tracks AS tracks FROM mkvid_request_tracks t JOIN mkvid_requests r ON r.id = t.request_id WHERE r.set_url = ?').bind(SET).first<{ tracks: string }>())?.tracks ?? ''
  /** env.DB, except statements whose SQL matches `re` fail like a D1 error. */
  const failingDb = (db: D1Database, re: RegExp): D1Database => {
    const fail = async () => {
      throw new Error('D1_ERROR: simulated')
    }
    const broken = { bind: () => broken, first: fail, all: fail, run: fail, raw: fail }
    return new Proxy(db, {
      get(target, prop) {
        if (prop === 'prepare') return (sql: string) => (re.test(sql) ? broken : target.prepare(sql))
        const v = Reflect.get(target, prop)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
  }
  const verifyF = async (env: Env) => {
    served('acct-1', 5)
    await syncOne(env, sub, 'tok')
    served('acct-2', 2)
    await verifyRun(env, ['acct-1'])
    expect(await isVerified(env, SET)).toBe(true)
    expect(await trusted(env)).toBe(1)
  }

  it('precondition: list G passes the decoy check and differs from F', async () => {
    const G = realParse(SET, HTML_G)
    expect(G.decoy.suspected).toBe(false)
    expect(G.decoy.mismatched).toBe(0)
    expect(G.rows.some((r) => r.title === NEW_TITLE)).toBe(true)
    expect(await tracklistFingerprint(G)).not.toBe(await tracklistFingerprint(F))
  })

  it('a D1 error inside the verification update (swallowed by recordSetFetch) cannot make list G trusted', async () => {
    const env = makeEnv()
    await verifyF(env)
    // startOver's first write fails: the set stays verified as F.
    servedG('acct-3', 0)
    await verifyRun({ ...env, DB: failingDb(env.DB, /INSERT INTO set_verification/) }, [])
    expect(await isVerified(env, SET)).toBe(true)
    // The trusted F copy is kept; G never replaces it.
    expect(await trusted(env)).toBe(1)
    expect(await storedTracks(env)).not.toContain(NEW_TITLE)
    const c = await claim(env)
    expect(c.request?.tracksTrusted).toBe(true)
    expect(c.request!.tracks.some((t) => t.title === NEW_TITLE)).toBe(false)
  })

  it('same D1 error with no stored list: G is stored untrusted and is not claimable', async () => {
    const env = makeEnv()
    await verifyF(env)
    await env.DB.prepare('DELETE FROM mkvid_request_tracks').run()
    servedG('acct-3', 0)
    await verifyRun({ ...env, DB: failingDb(env.DB, /INSERT INTO set_verification/) }, [])
    expect(await isVerified(env, SET)).toBe(true)
    expect(await storedTracks(env)).not.toContain(NEW_TITLE) // names dropped: untrusted rows carry none
    expect(await trusted(env)).toBe(0)
    expect((await claim(env)).request).toBeNull()
  })

  it('a D1 error on the verification READ (getVerification) cannot make list G trusted either', async () => {
    const env = makeEnv()
    await verifyF(env)
    await env.DB.prepare('DELETE FROM mkvid_request_tracks').run()
    servedG('acct-3', 0)
    await verifyRun({ ...env, DB: failingDb(env.DB, /SELECT \* FROM set_verification/) }, [])
    expect(await trusted(env)).toBe(0)
  })

  it('a fetch without an account id (path a) cannot make list G trusted', async () => {
    const env = makeEnv()
    await verifyF(env)
    servedG('unknown', 0)
    await verifyRun(env, [])
    expect(await isVerified(env, SET)).toBe(true)
    expect(await trusted(env)).toBe(1)
    expect(await storedTracks(env)).not.toContain(NEW_TITLE)
    await env.DB.prepare('DELETE FROM mkvid_request_tracks').run()
    servedG(undefined, 0)
    await verifyRun(env, [])
    expect(await trusted(env)).toBe(0)
  })

  it('fails closed when the verified fingerprint cannot be read, or is empty', async () => {
    const env = makeEnv()
    served('acct-1', 5)
    await syncOne(env, sub, 'tok')
    // The confirming fetch verifies the set, but the fingerprint read fails: stored untrusted.
    served('acct-2', 2)
    await verifyRun({ ...env, DB: failingDb(env.DB, /SELECT fingerprint FROM set_verification/) }, ['acct-1'])
    expect(await isVerified(env, SET)).toBe(true)
    expect(await trusted(env)).toBe(0)
    // Direct: verified row with an empty fingerprint.
    await env.DB.prepare(`UPDATE set_verification SET fingerprint = '' WHERE url = ?`).bind(SET).run()
    expect(await saveMkvidTracks(env, SET, F)).toBe('saved')
    expect(await trusted(env)).toBe(0)
    // And with the real fingerprint restored, the same list is upgraded.
    await env.DB.prepare(`UPDATE set_verification SET fingerprint = ? WHERE url = ?`).bind(await tracklistFingerprint(F), SET).run()
    expect(await saveMkvidTracks(env, SET, F)).toBe('saved')
    expect(await trusted(env)).toBe(1)
  })
})

describe('seam 5: one parse per set page fetch; the verification fetch fills the cache', () => {
  it('new-set fetch and verification fetch each parse the page exactly once', async () => {
    const env = makeEnv()
    served('acct-1', 3)
    mocked(parseTracklist).mockClear()
    await syncOne(env, sub, 'tok')
    expect(mocked(parseTracklist)).toHaveBeenCalledTimes(1)

    await env.CACHE.delete('tl:v4:18kll1h1')
    served('acct-2', 0)
    mocked(parseTracklist).mockClear()
    await verifyRun(env, ['acct-1'])
    expect(mocked(parseTracklist)).toHaveBeenCalledTimes(1)
    // The verification second fetch wrote through to the parsed-list cache.
    const cached = JSON.parse((await env.CACHE.get('tl:v4:18kll1h1'))!)
    expect(cached.tracks).toHaveLength(31)
    expect(cached.tracklistUrl).toBe(SET)
  })
})

describe('seam 6: page facts are stored on every set page fetch', () => {
  const facts = (env: Env) => env.DB.prepare('SELECT * FROM set_media_facts WHERE set_url = ?').bind(SET).first<Record<string, unknown>>()

  it('sync fetches (new and verification) store them', async () => {
    const env = makeEnv()
    served('acct-1', 3)
    await syncOne(env, sub, 'tok')
    const first = await facts(env)
    expect(first).toMatchObject({ slug: 'habstrakt', audio_kind: 'soundcloud', set_date: '2024-11-11' })
    await env.DB.prepare('DELETE FROM set_media_facts').run()
    served('acct-2', 0)
    await verifyRun(env, ['acct-1'])
    expect(await facts(env)).toMatchObject({ slug: 'habstrakt', audio_kind: 'soundcloud' })
  })

  it('a purge refetch (and so any phone/viewer fetch through resolveTracklistPage) stores them, with the synced slug', async () => {
    const env = makeEnv({ TLPOOL_URL: 'https://tlpool.example', TLPOOL_TOKEN: 'pt' })
    served('acct-1', 3)
    await syncOne(env, sub, 'tok')
    await env.DB.prepare('DELETE FROM set_media_facts').run()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.startsWith('https://tlpool.example/fetch')) return Response.json({ status: 200, finalUrl: SET, html: HTML, accountId: 'acct-3', exitLabel: 'exit-y', fetchedAt: new Date().toISOString(), bytes: HTML.length })
        throw new Error(`unexpected fetch ${url}`)
      }),
    )
    mocked(parseSetYouTubeId).mockReturnValue('vidPurge001')
    const res = await app.request('http://x/tracklist/purge', { method: 'POST', headers: { Authorization: 'Bearer tasker', 'Content-Type': 'application/json' }, body: JSON.stringify({ url: SET }) }, env)
    expect(res.status).toBe(200)
    const f = await facts(env)
    expect(f).toMatchObject({ slug: 'habstrakt', video_id: 'vidPurge001', audio_kind: 'soundcloud', set_date: '2024-11-11' })
    expect(Number(f!.track_count)).toBeGreaterThan(25) // W6's light row counter, not parseTracklist (see report: 30 vs 31)
  })
})

describe('review W4 #10: the mkvid queue log says whether the stored list is verified', () => {
  it('logs verified: false after the first fetch and true after the confirming one', async () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((x: unknown) => void lines.push(String(x)))
    try {
      const env = makeEnv()
      served('acct-1', 3)
      await syncOne(env, sub, 'tok')
      served('acct-2', 0)
      await verifyRun(env, ['acct-1'])
    } finally {
      spy.mockRestore()
    }
    const queue = lines.filter((l) => l.includes('"sync.mkvid_queue"')).map((l) => JSON.parse(l) as { verified?: boolean })
    expect(queue.map((q) => q.verified)).toEqual([false, true])
  })
})
