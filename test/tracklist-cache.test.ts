import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'
import type { Env, ParsedTrack } from '../src/types'
import { makeLogger } from '../src/lib/log'
import { setPause, _resetTallyForTests } from '../src/lib/ban-state'
import {
  NEW_SET_AGE_SECONDS,
  TRACKLIST_TTL,
  cacheAgeSeconds,
  cacheParsedTracklist,
  tracklistCacheKey,
  tracklistCacheTtl,
} from '../src/lib/tracklist-cache'
import { parseTracklist } from '../src/lib/tracklists1001'
import { SEARCH_URL_CV, searchByUrlCacheKey, videoTracklistKey } from '../src/lib/tracklist-purge'
import { DEFAULT_POOL_SETTINGS, updatePoolSettings } from '../src/lib/pool-settings'

// Per-track link enrichment (medialink + iTunes) is not what these tests are
// about, and would be a network call: stub it, keep the real page resolver.
vi.mock('../src/lib/tracklist-resolve', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/tracklist-resolve')>('../src/lib/tracklist-resolve')
  return { ...actual, resolveTrackMediaLinks: vi.fn(async () => ({ appleLink: null, youtubeLink: null, soundcloudLink: null })) }
})
vi.mock('../src/lib/itunes', () => ({ lookupAppleLink: vi.fn(async () => null) }))

import { resolveTracklistPage } from '../src/lib/tracklist-resolve'
import { app } from '../src/index'

const here = dirname(fileURLToPath(import.meta.url))
const fx = (name: string) => readFileSync(resolve(here, 'fixtures', name), 'utf8')
const POOL = 'https://tlpool.example'
// habstrakt: 31 rows, every one identified, set date 2024-11-11.
const FULL_URL = 'https://www.1001tracklists.com/tracklist/18kll1h1/habstrakt-jstjr-1001tracklists-x-dj-lovers-club-pres.-waterways-amsterdam-dance-event-netherlands-2024-11-11.html'
const FULL_SLUG = '18kll1h1'
// maxstyler: 30 rows, 2 of them "ID".
const PARTIAL_URL = 'https://www.1001tracklists.com/tracklist/1pmwyfn1/max-styler-circuitgrounds-edc-las-vegas-united-states-2025-05-16.html'
const VIDEO_ID = '79n8BaQAL2Q'

function makeEnv(over: Partial<Env> = {}): Env {
  return { CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV(), API_TOKEN: 'tasker', YOUTUBE_API_KEY: 'k', TLPOOL_URL: POOL, TLPOOL_TOKEN: 'tok', ...over } as Env
}

/** tlpool answers every 1001tl fetch with `html`; returns the list of pool calls. */
function poolServes(html: string) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith(POOL)) {
        calls.push(url)
        return Response.json({ status: 200, finalUrl: url, html, accountId: 'acct-1', exitLabel: 'exit-a', fetchedAt: new Date().toISOString(), bytes: html.length })
      }
      throw new Error(`unexpected fetch ${url}`)
    }),
  )
  return calls
}

/** Spy on CACHE.put and collect the TTL each `tl:` key was written with. */
function ttlSpy(env: Env) {
  const ttls: Record<string, number | undefined> = {}
  const orig = env.CACHE.put.bind(env.CACHE)
  env.CACHE.put = (async (key: string, value: string, opts?: KVNamespacePutOptions) => {
    if (key.startsWith('tl:')) ttls[key] = opts?.expirationTtl
    return orig(key, value, opts)
  }) as KVNamespace['put']
  return ttls
}

const track = (over: Partial<ParsedTrack> = {}): ParsedTrack => ({
  startTime: '0:00',
  startSeconds: 0,
  artist: 'A',
  title: 'T',
  trackId: null,
  trackUrl: null,
  artworkUrl: null,
  isUnidentified: false,
  idStatus: null,
  isMashupLinked: false,
  ownStartSeconds: 0,
  ...over,
})

const log = makeLogger({ task: 'test' })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  _resetTallyForTests() // the pause test leaves an in-isolate pause memo
})

describe('tracklistCacheTtl (decision 19)', () => {
  const NOW = Date.UTC(2026, 8, 29, 12)
  it('3 days when every row is identified and the set is at least 2 days old', () => {
    expect(tracklistCacheTtl({ tracks: [track(), track()] }, '2026-09-20', NOW)).toBe(TRACKLIST_TTL.FULL)
    expect(TRACKLIST_TTL.FULL).toBe(3 * 86400)
  })
  it('6 hours when any row is unidentified', () => {
    expect(tracklistCacheTtl({ tracks: [track(), track({ isUnidentified: true })] }, '2026-01-01', NOW)).toBe(TRACKLIST_TTL.SHORT)
    expect(TRACKLIST_TTL.SHORT).toBe(6 * 3600)
  })
  it('6 hours when the page has an anonymous "ID - ID" row, even though every named track is identified', () => {
    const rows = [{ ...track(), anonymous: false, label: null }, { ...track({ artist: 'ID', title: 'ID', isUnidentified: true }), anonymous: true, label: null }]
    expect(tracklistCacheTtl({ tracks: [track()], rows }, '2026-01-01', NOW)).toBe(TRACKLIST_TTL.SHORT)
  })
  it('6 hours when the set is under 2 days old, 3 days from the 2-day mark', () => {
    expect(tracklistCacheTtl({ tracks: [track()] }, '2026-09-28', NOW)).toBe(TRACKLIST_TTL.SHORT)
    const twoDaysAgo = new Date(NOW - NEW_SET_AGE_SECONDS * 1000).toISOString().slice(0, 10)
    expect(tracklistCacheTtl({ tracks: [track()] }, twoDaysAgo, Date.parse(`${twoDaysAgo}T00:00:00Z`) + NEW_SET_AGE_SECONDS * 1000)).toBe(TRACKLIST_TTL.FULL)
  })
  it('an unknown set date counts as not new', () => {
    expect(tracklistCacheTtl({ tracks: [track()] }, null, NOW)).toBe(TRACKLIST_TTL.FULL)
  })
})

describe('cacheParsedTracklist', () => {
  it('refuses decoy and empty parses, and stamps fetchedAt / ttlSeconds / tracklistUrl on the rest', async () => {
    const env = makeEnv()
    const decoy = parseTracklist(FULL_URL, fx('tracklist-decoy-dcr839.html'))
    expect(await cacheParsedTracklist(env, FULL_URL, decoy, log)).toMatchObject({ cached: false, reason: 'decoy' })
    const empty = parseTracklist(FULL_URL, fx('tracklist-neptune.html'))
    expect(await cacheParsedTracklist(env, FULL_URL, empty, log)).toMatchObject({ cached: false, reason: 'empty' })
    expect(await env.CACHE.get(tracklistCacheKey(FULL_SLUG))).toBeNull()

    const html = fx('tracklist-habstrakt.html')
    const nowMs = Date.UTC(2026, 8, 29)
    const r = await cacheParsedTracklist(env, FULL_URL, parseTracklist(FULL_URL, html), log, { html, nowMs })
    expect(r).toMatchObject({ cached: true, ttlSeconds: TRACKLIST_TTL.FULL })
    const v = JSON.parse((await env.CACHE.get(tracklistCacheKey(FULL_SLUG)))!)
    expect(v).toMatchObject({ fetchedAt: new Date(nowMs).toISOString(), ttlSeconds: TRACKLIST_TTL.FULL, tracklistUrl: FULL_URL, setDate: '2024-11-11' })
    expect(cacheAgeSeconds(v, nowMs + 90_000)).toBe(90)
    expect(cacheAgeSeconds({})).toBeNull()
  })
})

describe('resolveTracklistPage TTL selection', () => {
  it('writes a fully identified old set for 3 days', async () => {
    const env = makeEnv()
    const ttls = ttlSpy(env)
    poolServes(fx('tracklist-habstrakt.html'))
    const r = await resolveTracklistPage(env, FULL_URL, log)
    expect(r.tracks).toHaveLength(31)
    expect(ttls[tracklistCacheKey(FULL_SLUG)]).toBe(TRACKLIST_TTL.FULL)
    expect(r.fetchedAt).toEqual(expect.any(String))
  })

  it('writes a list with ID rows for 6 hours', async () => {
    const env = makeEnv()
    const ttls = ttlSpy(env)
    poolServes(fx('tracklist-maxstyler.html'))
    await resolveTracklistPage(env, PARTIAL_URL, log)
    expect(ttls[tracklistCacheKey('1pmwyfn1')]).toBe(TRACKLIST_TTL.SHORT)
  })

  it('writes a fully identified set under 2 days old for 6 hours', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2024-11-12T10:00:00Z'))
    const env = makeEnv()
    const ttls = ttlSpy(env)
    poolServes(fx('tracklist-habstrakt.html'))
    await resolveTracklistPage(env, FULL_URL, log)
    expect(ttls[tracklistCacheKey(FULL_SLUG)]).toBe(TRACKLIST_TTL.SHORT)
  })

  it('serves the second call from cache; force refetches', async () => {
    const env = makeEnv()
    const calls = poolServes(fx('tracklist-habstrakt.html'))
    await resolveTracklistPage(env, FULL_URL, log)
    await resolveTracklistPage(env, FULL_URL, log)
    expect(calls).toHaveLength(1)
    await resolveTracklistPage(env, FULL_URL, log, { force: true })
    expect(calls).toHaveLength(2)
  })
})

const bearer = (env: Env, path: string, body: unknown, token: string | null = 'tasker') =>
  app.request(
    `http://x${path}`,
    { method: 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    env,
  )

async function seedTracklistRow(env: Env, url: string, videoId: string | null) {
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO tracklists (slug, url, position, discovered_at, processed, video_known, video_id, video_source, checked_at)
     VALUES ('habstrakt', ?, 0, ?, 1, 1, ?, 'sync', ?)`,
  )
    .bind(url, now, videoId, now)
    .run()
}

/** A stale entry as an earlier fetch left it: one wrong row, fetched 5 hours ago. */
async function seedStaleEntry(env: Env) {
  const fetchedAt = new Date(Date.now() - 5 * 3600 * 1000).toISOString()
  await env.CACHE.put(
    tracklistCacheKey(FULL_SLUG),
    JSON.stringify({ tracks: [track({ artist: 'Old', title: 'Stale' })], setAppleLink: null, setYoutubeLink: null, setSoundcloudLink: null, fetchedAt, ttlSeconds: TRACKLIST_TTL.SHORT, tracklistUrl: FULL_URL }),
  )
}

describe('POST /tracklist/purge (bearer)', () => {
  let calls: string[]
  beforeEach(() => {
    calls = poolServes(fx('tracklist-habstrakt.html'))
  })

  it('is behind the API_TOKEN bearer', async () => {
    const env = makeEnv()
    expect((await bearer(env, '/tracklist/purge', { url: FULL_URL }, null)).status).toBe(401)
    expect((await bearer(env, '/tracklist/purge', { url: FULL_URL }, 'wrong')).status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('by URL: deletes the stale entry, refetches, answers the fresh summary', async () => {
    const env = makeEnv()
    await seedStaleEntry(env)
    const res = await bearer(env, '/tracklist/purge', { url: FULL_URL })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body).toMatchObject({ tracklistUrl: FULL_URL, slug: FULL_SLUG, rowCount: 31, trackCount: 31, identifiedCount: 31, ttlSeconds: TRACKLIST_TTL.FULL })
    expect(Date.now() - Date.parse(body.fetchedAt)).toBeLessThan(60_000)
    expect(calls).toHaveLength(1)
    const v = JSON.parse((await env.CACHE.get(tracklistCacheKey(FULL_SLUG)))!)
    expect(v.tracks).toHaveLength(31)
  })

  it('by slug: known from the cached entry or from D1; unknown is a 404 with no fetch', async () => {
    const env = makeEnv()
    await seedStaleEntry(env)
    expect((await bearer(env, '/tracklist/purge', { slug: FULL_SLUG })).status).toBe(200)

    const env2 = makeEnv()
    await seedTracklistRow(env2, FULL_URL, null)
    const r2 = await bearer(env2, '/tracklist/purge', { slug: FULL_SLUG })
    expect(r2.status).toBe(200)
    expect((await r2.json() as any).tracklistUrl).toBe(FULL_URL)

    const before = calls.length
    const r3 = await bearer(makeEnv(), '/tracklist/purge', { slug: 'zzzz9999' })
    expect(r3.status).toBe(404)
    expect((await r3.json() as any).error).toBe('unknown_slug')
    expect(calls).toHaveLength(before)
  })

  it('by YouTube video id: through the synced set in D1, or the phone search cache; unknown is a 404', async () => {
    const env = makeEnv()
    await seedTracklistRow(env, FULL_URL, VIDEO_ID)
    const r = await bearer(env, '/tracklist/purge', { videoId: `https://youtu.be/${VIDEO_ID}` })
    expect(r.status).toBe(200)
    expect((await r.json() as any).slug).toBe(FULL_SLUG)

    const env2 = makeEnv()
    expect(SEARCH_URL_CV).toBe(2)
    await env2.CACHE.put(searchByUrlCacheKey(VIDEO_ID), JSON.stringify({ tracklistUrl: FULL_URL }))
    expect((await bearer(env2, '/tracklist/purge', { videoId: VIDEO_ID })).status).toBe(200)

    const r3 = await bearer(makeEnv(), '/tracklist/purge', { videoId: 'aaaaaaaaaaa' })
    expect(r3.status).toBe(404)
    expect((await r3.json() as any).error).toBe('unknown_video')
  })

  it('wants exactly one identifier', async () => {
    const env = makeEnv()
    expect((await bearer(env, '/tracklist/purge', {})).status).toBe(400)
    expect((await bearer(env, '/tracklist/purge', { url: FULL_URL, slug: FULL_SLUG })).status).toBe(400)
    expect((await bearer(env, '/tracklist/purge', { url: 'https://example.com/x' })).status).toBe(400)
  })

  it('a failed refetch (decoy) keeps the old entry and answers the error with stale: true and its fetchedAt', async () => {
    const env = makeEnv()
    await seedStaleEntry(env)
    const before = await env.CACHE.get(tracklistCacheKey(FULL_SLUG))
    const oldFetchedAt = JSON.parse(before!).fetchedAt
    poolServes(fx('tracklist-decoy-dcr839.html'))
    const res = await bearer(env, '/tracklist/purge', { url: FULL_URL })
    expect(res.status).toBe(502)
    expect(await res.json() as any).toMatchObject({ error: 'decoy', stale: true, fetchedAt: oldFetchedAt })
    expect(await env.CACHE.get(tracklistCacheKey(FULL_SLUG))).toBe(before)
  })

  it('an empty parse never replaces a good entry', async () => {
    const env = makeEnv()
    await seedStaleEntry(env)
    const before = await env.CACHE.get(tracklistCacheKey(FULL_SLUG))
    poolServes(fx('tracklist-neptune.html'))
    const res = await bearer(env, '/tracklist/purge', { url: FULL_URL })
    expect(res.status).toBe(502)
    expect(await res.json() as any).toMatchObject({ error: 'upstream_error', stale: true })
    expect(await env.CACHE.get(tracklistCacheKey(FULL_SLUG))).toBe(before)
  })

  it('while fetching is paused: 503, old entry kept, no upstream call', async () => {
    const env = makeEnv()
    await seedStaleEntry(env)
    const before = await env.CACHE.get(tracklistCacheKey(FULL_SLUG))
    await setPause(env, 'all_routes_blocked', null)
    const res = await bearer(env, '/tracklist/purge', { url: FULL_URL })
    expect(res.status).toBe(503)
    expect(await res.json() as any).toMatchObject({ error: 'paused', stale: true, fetchedAt: JSON.parse(before!).fetchedAt })
    expect(await env.CACHE.get(tracklistCacheKey(FULL_SLUG))).toBe(before)
    expect(calls).toHaveLength(0)
  })

  it('a failure with nothing cached answers stale: false', async () => {
    const env = makeEnv()
    poolServes(fx('tracklist-decoy-dcr839.html'))
    const res = await bearer(env, '/tracklist/purge', { url: FULL_URL })
    expect(await res.json() as any).toMatchObject({ error: 'decoy', stale: false, fetchedAt: null })
    expect(await env.CACHE.get(tracklistCacheKey(FULL_SLUG))).toBeNull()
  })
})

describe('POST /ui/api/tracklist/purge (Cloudflare Access)', () => {
  const ACCESS = { CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CF_ACCESS_AUD: 'aud', CF_ACCESS_ALLOWED_EMAILS: 'owner@example.com' }
  const post = (env: Env, body: unknown, headers: Record<string, string> = {}) =>
    app.request('http://x/ui/api/tracklist/purge', { method: 'POST', headers: { Origin: 'http://x', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }, env)

  it('rejects a request without an Access token, and does not take the API bearer instead', async () => {
    const calls = poolServes(fx('tracklist-habstrakt.html'))
    const env = makeEnv(ACCESS as Partial<Env>)
    expect((await post(env, { url: FULL_URL })).status).toBe(401)
    expect((await post(env, { url: FULL_URL }, { Authorization: 'Bearer tasker' })).status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('purges and refetches for an Access-authenticated caller', async () => {
    const calls = poolServes(fx('tracklist-habstrakt.html'))
    const env = makeEnv({ DEV_BYPASS_CF_ACCESS: '1' } as Partial<Env>)
    await seedStaleEntry(env)
    const res = await post(env, { url: FULL_URL })
    expect(res.status).toBe(200)
    expect(await res.json() as any).toMatchObject({ rowCount: 31, identifiedCount: 31 })
    expect(calls).toHaveLength(1)
  })

  it('the viewer API reports the cache age the Refresh button shows', async () => {
    poolServes(fx('tracklist-habstrakt.html'))
    const env = makeEnv({ DEV_BYPASS_CF_ACCESS: '1' } as Partial<Env>)
    await seedStaleEntry(env)
    const res = await app.request('http://x/ui/api/tracklist', { method: 'POST', headers: { Origin: 'http://x', 'Content-Type': 'application/json' }, body: JSON.stringify({ url: FULL_URL }) }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.cacheAgeSeconds).toBeGreaterThanOrEqual(5 * 3600 - 5)
    expect(body.fetchedAt).toEqual(expect.any(String))
    const page = await (await app.request('http://x/ui/set', {}, env)).text()
    expect(page).toContain('Refresh track list')
    expect(page).toContain('/ui/api/tracklist/purge')
    // The viewer's inline scripts must at least parse.
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
    expect(scripts.length).toBeGreaterThan(0)
    for (const js of scripts) expect(() => new Function(js)).not.toThrow()
  })
})

describe('/now-playing cache age and refresh flag', () => {
  const np = (env: Env, extra: Record<string, unknown> = {}) => bearer(env, '/now-playing', { videoUrl: VIDEO_ID, currentSeconds: 60, ...extra })

  it('reports the age of the cached list without fetching', async () => {
    const calls = poolServes(fx('tracklist-habstrakt.html'))
    const env = makeEnv()
    await seedTracklistRow(env, FULL_URL, VIDEO_ID)
    await seedStaleEntry(env)
    const body = await (await np(env)).json() as any
    expect(body.tracks[0]).toMatchObject({ artist: 'Old', title: 'Stale' })
    expect(body.cache).toMatchObject({ refreshed: false, ttlSeconds: TRACKLIST_TTL.SHORT })
    expect(body.cache.ageSeconds).toBeGreaterThanOrEqual(5 * 3600 - 5)
    expect(calls).toHaveLength(0)
  })

  it('refresh: true purges and refetches before picking the track', async () => {
    const calls = poolServes(fx('tracklist-habstrakt.html'))
    const env = makeEnv()
    await seedTracklistRow(env, FULL_URL, VIDEO_ID)
    await seedStaleEntry(env)
    const body = await (await np(env, { refresh: true })).json() as any
    expect(calls).toHaveLength(1)
    expect(body.status).toBe('ok')
    expect(body.tracks[0].artist).not.toBe('Old')
    expect(body.cache).toMatchObject({ refreshed: true, ttlSeconds: TRACKLIST_TTL.FULL })
    expect(body.cache.ageSeconds).toBeLessThan(60)
    expect(JSON.parse((await env.CACHE.get(tracklistCacheKey(FULL_SLUG)))!).tracks).toHaveLength(31)
  })

  it('refresh: true whose refetch fails answers the track from the kept list, with cache.stale and the refresh error (review W5 #3)', async () => {
    poolServes(fx('tracklist-decoy-dcr839.html'))
    const env = makeEnv()
    await seedTracklistRow(env, FULL_URL, VIDEO_ID)
    await seedStaleEntry(env)
    const before = await env.CACHE.get(tracklistCacheKey(FULL_SLUG))
    const body = await (await np(env, { refresh: true })).json() as any
    expect(body.status).not.toBe('upstream_error')
    expect(body.tracks[0]).toMatchObject({ artist: 'Old', title: 'Stale' })
    expect(body.cache).toMatchObject({ refreshed: false, stale: true, fetchedAt: JSON.parse(before!).fetchedAt })
    expect(body.cache.refreshError).toMatch(/decoy/)
    expect(body.cache.ageSeconds).toBeGreaterThanOrEqual(5 * 3600 - 5)
    expect(await env.CACHE.get(tracklistCacheKey(FULL_SLUG))).toBe(before)
  })

  it('refresh: true whose refetch fails with nothing cached is still upstream_error', async () => {
    poolServes(fx('tracklist-decoy-dcr839.html'))
    const env = makeEnv()
    await seedTracklistRow(env, FULL_URL, VIDEO_ID)
    const body = await (await np(env, { refresh: true })).json() as any
    expect(body.status).toBe('upstream_error')
    expect(body.message).toMatch(/decoy/)
    expect(body.cache).toMatchObject({ refreshed: false, stale: true, fetchedAt: null })
  })

  it('refresh must be a boolean', async () => {
    const env = makeEnv()
    expect((await np(env, { refresh: 'yes' })).status).toBe(400)
  })
})

describe('review W5 fixes', () => {
  it('#1 a second forced refetch of the same set within 120 s answers the cached list without a fetch', async () => {
    const calls = poolServes(fx('tracklist-habstrakt.html'))
    const env = makeEnv()
    const a = await (await bearer(env, '/tracklist/purge', { url: FULL_URL })).json() as any
    expect(a).toMatchObject({ refreshed: true })
    const b = await (await bearer(env, '/tracklist/purge', { url: FULL_URL })).json() as any
    expect(b).toMatchObject({ refreshed: false, trackCount: 31 })
    expect(b.cooldownSeconds).toBeGreaterThan(0)
    expect(b.cooldownSeconds).toBeLessThanOrEqual(120)
    expect(calls).toHaveLength(1)
    // /now-playing refresh: true is limited the same way.
    await seedTracklistRow(env, FULL_URL, VIDEO_ID)
    const n = await (await bearer(env, '/now-playing', { videoUrl: VIDEO_ID, currentSeconds: 60, refresh: true })).json() as any
    expect(n.cache).toMatchObject({ refreshed: false })
    expect(n.cache.cooldownSeconds).toBeGreaterThan(0)
    expect(calls).toHaveLength(1)
  })

  it('#1 forced refetches stop at the daily cap (a pool setting); the cached list answers', async () => {
    const calls = poolServes(fx('tracklist-habstrakt.html'))
    const env = makeEnv()
    await updatePoolSettings(env, { forcedRefetch: { cooldownSeconds: 0, dailyCap: 2 } })
    expect(((await (await bearer(env, '/tracklist/purge', { url: FULL_URL })).json()) as any).refreshed).toBe(true)
    expect(((await (await bearer(env, '/tracklist/purge', { url: FULL_URL })).json()) as any).refreshed).toBe(true)
    const third = await (await bearer(env, '/tracklist/purge', { url: FULL_URL })).json() as any
    expect(third).toMatchObject({ refreshed: false, dailyCapReached: true, trackCount: 31 })
    expect(calls).toHaveLength(2)
    expect(DEFAULT_POOL_SETTINGS.forcedRefetch).toEqual({ cooldownSeconds: 120, dailyCap: 40 })
  })

  it('#2 the phone/viewer/purge path reads the set date from the page, like the sync: an undated URL aired yesterday gets 6 h', async () => {
    poolServes(fx('tracklist-habstrakt.html')) // fully identified, datePublished 2024-11-11
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2024-11-12T12:00:00Z'))
    const env = makeEnv()
    const undated = 'https://www.1001tracklists.com/tracklist/18kll1h1/habstrakt-jstjr-waterways.html'
    const r = await resolveTracklistPage(env, undated, log)
    expect(r).toMatchObject({ setDate: '2024-11-11', ttlSeconds: TRACKLIST_TTL.SHORT })
  })

  it('#4 a purge by video id finds the set /now-playing matched, whichever search step found it', async () => {
    const calls = poolServes(fx('tracklist-habstrakt.html'))
    const env = makeEnv()
    await seedTracklistRow(env, FULL_URL, VIDEO_ID)
    await (await bearer(env, '/now-playing', { videoUrl: VIDEO_ID, currentSeconds: 60 })).json()
    expect(JSON.parse((await env.CACHE.get(videoTracklistKey(VIDEO_ID)))!)).toEqual({ tracklistUrl: FULL_URL })
    // Not a synced set any more, and no URL-search entry: only the phone's mapping knows it.
    await env.DB.prepare('DELETE FROM tracklists').run()
    const before = calls.length
    const res = await bearer(env, '/tracklist/purge', { videoId: VIDEO_ID })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).tracklistUrl).toBe(FULL_URL)
    expect(calls.length).toBe(before + 1)
  })

  it('#5 deleteCachedTracklist is gone (a purge never deletes before the refetch succeeds)', async () => {
    const mod = await import('../src/lib/tracklist-cache')
    expect('deleteCachedTracklist' in mod).toBe(false)
  })
})
