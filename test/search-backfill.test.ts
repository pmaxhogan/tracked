/**
 * The search backfill from trusted mkvid lists, the index status, the Tools
 * routes and the lazy-links write-back (src/lib/search/backfill.ts).
 */
import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/types'
import { fakeD1 } from './helpers/fake-d1'
import { fakeKV } from './helpers/fake-kv'

vi.mock('../src/lib/tracklist-resolve', async (orig) => ({
  ...(await orig<typeof import('../src/lib/tracklist-resolve')>()),
  resolveTrackMediaLinks: vi.fn(async (_env: unknown, id: string) => ({ appleLink: null, youtubeLink: id === '909720' ? 'https://www.youtube.com/watch?v=abc' : null, soundcloudLink: null })),
}))

import { app } from '../src/index'
import { BACKFILL_QUERY_BUDGET, backfillSearch, searchIndexStatus } from '../src/lib/search/backfill'
import { indexSet } from '../src/lib/search/index'

const NOW = Math.floor(Date.now() / 1000)
const VERIFIED_AT = NOW - 3600
const U = (n: string) => `https://www.1001tracklists.com/tracklist/${n}/dj-${n}-festival-2026-05-16.html`
const FAR = Date.now() + 60_000

function makeEnv(over: Partial<Env> = {}): Env {
  return { CACHE: fakeKV(), SUBS: fakeKV(), DB: fakeD1(), SEARCH_DB: fakeD1({ migrations: 'search' }), API_TOKEN: 't', YOUTUBE_API_KEY: 'k', DEV_BYPASS_CF_ACCESS: '1', ...over } as Env
}

const LIST = JSON.stringify([
  { cueSeconds: 0, artist: 'Mau P', title: 'Neck', artworkUrl: null, isId: false, layered: false },
  { cueSeconds: 120, artist: null, title: null, artworkUrl: null, isId: true, layered: false },
  { cueSeconds: 240, artist: 'Eli Brown', title: 'Be The One', artworkUrl: null, isId: false, layered: true },
])

async function seedMkvid(env: Env, n: string, o: { trusted?: number; state?: 'verified' | 'pending'; videoId?: string | null; list?: string } = {}) {
  const url = U(n)
  await env.DB.prepare("INSERT INTO mkvid_requests (id, slug, set_url, artist_name, set_title, set_date, source, source_url, status, video_id, created_at, updated_at) VALUES (?, 'dj-one', ?, 'DJ One', ?, '2026-05-16', 'soundcloud', 'https://soundcloud.com/x/y', 'done', ?, 1, 1)")
    .bind(`req-${n}`, url, `DJ One @ ${n}`, o.videoId === undefined ? 'vid1' : o.videoId)
    .run()
  await env.DB.prepare('INSERT INTO mkvid_request_tracks (request_id, tracks, track_count, trusted, scraped_at) VALUES (?, ?, 3, ?, 1)').bind(`req-${n}`, o.list ?? LIST, o.trusted ?? 1).run()
  const state = o.state ?? 'verified'
  await env.DB.prepare("INSERT INTO set_verification (url, state, fingerprint, row_count, first_account, first_fetched_at, verified_at, updated_at) VALUES (?, ?, 'fp', 3, 'a', 1, ?, 1)").bind(url, state, state === 'verified' ? VERIFIED_AT : null).run()
  return url
}

const all = async <T = Record<string, unknown>>(env: Env, sql: string, ...b: unknown[]) => (await env.SEARCH_DB!.prepare(sql).bind(...b).all<T>()).results
const run = (env: Env, over: Partial<Parameters<typeof backfillSearch>[1]> = {}) => backfillSearch(env, { cursor: null, limit: 500, deadlineMs: FAR, nowSec: NOW, ...over })

const post = (env: Env, path: string, body: unknown, headers: Record<string, string> = { 'Content-Type': 'application/json' }) =>
  app.request(`http://x${path}`, { method: 'POST', headers: { Origin: 'http://x', ...headers }, body: JSON.stringify(body) }, env)

describe('search backfill', () => {
  it('backfills trusted lists of verified sets only', async () => {
    const env = makeEnv()
    const a = await seedMkvid(env, 'a1')
    await seedMkvid(env, 'b2', { state: 'pending' })
    await seedMkvid(env, 'c3', { trusted: 0 })
    const r = await run(env)
    expect(r).toEqual({ indexed: 1, skipped: 0, cursor: a, done: true })
    const sets = await all(env, 'SELECT * FROM search_sets')
    expect(sets).toHaveLength(1)
    expect(sets[0]).toMatchObject({ set_url: a, source: 'mkvid', dj_slug: 'dj-one', dj_name: 'DJ One', title: 'DJ One @ a1', set_date: '2026-05-16', video_id: 'vid1', video_source: 'mkvid', track_count: 3, ided_count: 2, indexed_at: NOW })
    const keys = (await all<{ track_key: string }>(env, 'SELECT track_key FROM search_tracks ORDER BY track_key')).map((t) => t.track_key)
    expect(keys).toHaveLength(2)
    expect(keys.every((k) => k.startsWith('h:'))).toBe(true)
  })

  it('skips sets already indexed from a page, with no writes', async () => {
    const env = makeEnv()
    const a = await seedMkvid(env, 'a1')
    await indexSet(env, { setUrl: a, djSlug: 'dj-one', djName: 'DJ One', title: 't', setDate: null, videoId: null, videoSource: null, trackCount: 1, idedCount: 1, source: 'page', tracks: [{ trackId: '1', trackUrl: null, artist: 'X', title: 'Y', label: null, cueSeconds: 0, layered: false }] }, NOW - 100)
    const before = await all(env, 'SELECT * FROM search_sets')
    expect(await run(env)).toMatchObject({ indexed: 0, skipped: 1, done: true })
    expect(await all(env, 'SELECT * FROM search_sets')).toEqual(before)
    // a second press over an mkvid-indexed set skips it too
    const env2 = makeEnv()
    await seedMkvid(env2, 'a1')
    await run(env2)
    expect(await run(env2, { nowSec: NOW + 5 })).toMatchObject({ indexed: 0, skipped: 1 })
    expect((await all<{ indexed_at: number }>(env2, 'SELECT indexed_at FROM search_sets'))[0]!.indexed_at).toBe(NOW)
  })

  it('pages with a keyset cursor', async () => {
    const env = makeEnv()
    const a = await seedMkvid(env, 'a1')
    const b = await seedMkvid(env, 'b2')
    const r1 = await run(env, { limit: 1 })
    expect(r1).toEqual({ indexed: 1, skipped: 0, cursor: a, done: false })
    const r2 = await run(env, { limit: 1, cursor: r1.cursor })
    expect(r2).toEqual({ indexed: 1, skipped: 0, cursor: b, done: false })
    expect(await run(env, { limit: 1, cursor: r2.cursor })).toMatchObject({ indexed: 0, done: true })
  })

  it('stops at the deadline with a cursor', async () => {
    const env = makeEnv()
    await seedMkvid(env, 'a1')
    expect(await run(env, { deadlineMs: Date.now() - 1, cursor: null })).toEqual({ indexed: 0, skipped: 0, cursor: null, done: false })
    expect(await run(env, { deadlineMs: Date.now() - 1, cursor: 'a' })).toEqual({ indexed: 0, skipped: 0, cursor: 'a', done: false })
    expect(await all(env, 'SELECT * FROM search_sets')).toHaveLength(0)
  })

  it('stops on the D1 query budget with a cursor and the next call continues', async () => {
    expect(BACKFILL_QUERY_BUDGET).toBe(800)
    const env = makeEnv()
    const a = await seedMkvid(env, 'a1')
    const b = await seedMkvid(env, 'b2')
    // page read + skip read = 2, one set = 13 more: 15 fits one set, not two.
    const r1 = await run(env, { queryBudget: 20 })
    expect(r1).toEqual({ indexed: 1, skipped: 0, cursor: a, done: false })
    const r2 = await run(env, { queryBudget: 20, cursor: r1.cursor })
    expect(r2).toEqual({ indexed: 1, skipped: 0, cursor: b, done: true })
  })

  it('rejects a bad limit and cursor', async () => {
    const env = makeEnv()
    for (const limit of [0, 501, 'x']) expect((await post(env, '/ui/api/search/backfill', { limit })).status).toBe(400)
    expect((await post(env, '/ui/api/search/backfill', { cursor: 5 })).status).toBe(400)
    const ok = await post(env, '/ui/api/search/backfill', {})
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ indexed: 0, skipped: 0, cursor: null, done: true })
  })

  it('requires same-origin JSON and the index binding', async () => {
    const env = makeEnv()
    expect((await post(env, '/ui/api/search/backfill', {}, { 'Content-Type': 'text/plain' })).status).toBe(415)
    const unbound = makeEnv({ SEARCH_DB: undefined })
    const r = await post(unbound, '/ui/api/search/backfill', {})
    expect(r.status).toBe(503)
    expect(((await r.json()) as { error: string }).error).toBe('search_unavailable')
    expect((await app.request('http://x/ui/api/search/status', {}, unbound)).status).toBe(503)
  })

  it('status counts sets and tracks', async () => {
    const env = makeEnv()
    expect(await searchIndexStatus(env)).toEqual({ sets: 0, tracks: 0, vocab: 0, lastIndexedAt: null })
    await seedMkvid(env, 'a1')
    await run(env)
    const s = await searchIndexStatus(env)
    expect(s).toMatchObject({ sets: 1, tracks: 2, lastIndexedAt: NOW })
    expect(s.vocab).toBeGreaterThan(0)
    const res = await app.request('http://x/ui/api/search/status', {}, env)
    expect(await res.json()).toEqual(s)
  })

  it('lazy links write found YouTube links back to the index', async () => {
    const env = makeEnv()
    await indexSet(env, { setUrl: U('a1'), djSlug: 'dj-one', djName: 'DJ One', title: 't', setDate: null, videoId: null, videoSource: null, trackCount: 1, idedCount: 1, source: 'page', tracks: [{ trackId: '909720', trackUrl: null, artist: 'Mau P', title: 'Neck', label: null, cueSeconds: 0, layered: false }] }, NOW)
    const res = await post(env, '/ui/api/tracklist/links', { trackIds: ['909720', '123456'] })
    expect(res.status).toBe(200)
    expect((await all<{ youtube_link: string | null }>(env, "SELECT youtube_link FROM search_tracks WHERE track_key = 't:909720'"))[0]!.youtube_link).toBe('https://www.youtube.com/watch?v=abc')
    const noIndex = makeEnv({ SEARCH_DB: undefined })
    expect((await post(noIndex, '/ui/api/tracklist/links', { trackIds: ['909720'] })).status).toBe(200)
  })
})
