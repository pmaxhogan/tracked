import { describe, it, expect } from 'vitest'
import { app } from '../src/index'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'
import { djSetFacts } from '../src/lib/dj-table'
import type { Env } from '../src/types'

const T = 1_790_000_000 // unix s

async function seeded() {
  const DB = fakeD1()
  const env = { CACHE: fakeKV(), SUBS: fakeKV(), DB, API_TOKEN: 't', YOUTUBE_API_KEY: 'k', DEV_BYPASS_CF_ACCESS: '1' } as unknown as Env
  const run = (sql: string, ...b: unknown[]) => DB.prepare(sql).bind(...(b as never[])).run()
  // Three DJs: alpha (synced, 2 of 3 processed, 1 mkvid video), bravo (sync error), charlie (never synced, no tracklists).
  await run('INSERT INTO subscriptions (slug, source_url, added_at, position) VALUES (?, ?, ?, ?)', 'alpha', 'https://www.1001tracklists.com/dj/alpha/index.html', T - 300, 0)
  await run('INSERT INTO subscriptions (slug, source_url, added_at, position) VALUES (?, ?, ?, ?)', 'bravo', 'https://www.1001tracklists.com/dj/bravo/index.html', T - 200, 1)
  await run('INSERT INTO subscriptions (slug, source_url, added_at, position) VALUES (?, ?, ?, ?)', 'charlie', 'https://www.1001tracklists.com/dj/charlie/index.html', T - 100, 2)
  await run('INSERT INTO sub_sync (slug, playlist_id, artist_name, last_run_at, last_error, last_run_stats) VALUES (?, ?, ?, ?, ?, ?)', 'alpha', 'PLa', 'Alpha One', T, null, JSON.stringify({ videoIdsAdded: 2 }))
  await run('INSERT INTO sub_sync (slug, playlist_id, artist_name, last_run_at, last_error, last_run_stats) VALUES (?, ?, ?, ?, ?, ?)', 'bravo', null, 'Bravo', T - 50, 'boom: upstream', null)
  const tl = (slug: string, url: string, pos: number, processed: number, videoId: string | null, source: string | null, known = 1) =>
    run('INSERT INTO tracklists (slug, url, position, discovered_at, processed, abandoned, failure_count, video_known, video_id, video_source, checked_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)', slug, url, pos, T - 1000 + pos, processed, known, videoId, source, processed ? T : null)
  await tl('alpha', 'https://www.1001tracklists.com/tracklist/a1/alpha-one-2026-01-01.html', 0, 1, 'vid00000001', '1001tl')
  await tl('alpha', 'https://www.1001tracklists.com/tracklist/a2/alpha-two-2026-02-01.html', 1, 1, 'vid00000002', 'mkvid')
  await tl('alpha', 'https://www.1001tracklists.com/tracklist/a3/alpha-three-2026-03-01.html', 2, 0, null, null, 0)
  await tl('bravo', 'https://www.1001tracklists.com/tracklist/b1/bravo-one-2026-01-05.html', 0, 1, null, null)
  await run('INSERT INTO set_media_facts (set_url, slug, video_id, track_count, ided_count, fetched_at) VALUES (?, ?, ?, ?, ?, ?)', 'https://www.1001tracklists.com/tracklist/a1/alpha-one-2026-01-01.html', 'alpha', 'vid00000001', 20, 18, T)
  await run('INSERT INTO set_media_facts (set_url, slug, video_id, track_count, ided_count, fetched_at) VALUES (?, ?, ?, ?, ?, ?)', 'https://www.1001tracklists.com/tracklist/a9/alpha-crawl-only-2026-04-01.html', 'alpha', null, 10, 10, T)
  return env
}

const get = async (env: Env, qs: string) => {
  const r = await app.request(`https://tracked.example/ui/api/djs${qs}`, {}, env)
  return { status: r.status, body: (await r.json()) as any }
}

describe('GET /ui/api/djs', () => {
  it('answers one row per subscription with the sync summary, sorted by name, plus counts', async () => {
    const env = await seeded()
    const { status, body } = await get(env, '')
    expect(status).toBe(200)
    expect(body.total).toBe(3)
    expect(body.rows.map((r: any) => r.slug)).toEqual(['alpha', 'bravo', 'charlie'])
    const a = body.rows[0]
    expect(a).toMatchObject({ name: 'Alpha One', sets: 3, processed: 2, pending: 1, videos: 2, mkvid: 1, playlistId: 'PLa', playlistUrl: 'https://www.youtube.com/playlist?list=PLa', lastRunAt: T * 1000, hasError: false, lastAdded: 2, addedAt: (T - 300) * 1000 })
    expect(body.rows[1]).toMatchObject({ slug: 'bravo', hasError: true, lastError: 'boom: upstream', sets: 1, pending: 0, playlistUrl: null })
    expect(body.rows[2]).toMatchObject({ slug: 'charlie', name: 'charlie', sets: 0, lastRunAt: null, hasError: false })
    expect(body.counts).toEqual({ total: 3, errors: 1, pending: 1, neverSynced: 1, noPlaylist: 2, mkvid: 1 })
  })
  it('filters, searches and sorts on the server', async () => {
    const env = await seeded()
    expect((await get(env, '?f.hasError=eq:1')).body.rows.map((r: any) => r.slug)).toEqual(['bravo'])
    expect((await get(env, '?f.pending=gt:0')).body.rows.map((r: any) => r.slug)).toEqual(['alpha'])
    expect((await get(env, '?f.lastRunAt=empty')).body.rows.map((r: any) => r.slug)).toEqual(['charlie'])
    expect((await get(env, '?f.hasPlaylist=eq:0')).body.rows.map((r: any) => r.slug)).toEqual(['bravo', 'charlie'])
    expect((await get(env, '?q=upstream')).body.rows.map((r: any) => r.slug)).toEqual(['bravo'])
    expect((await get(env, '?q=one')).body.rows.map((r: any) => r.slug)).toEqual(['alpha'])
    expect((await get(env, '?sort=-sets')).body.rows.map((r: any) => r.slug)).toEqual(['alpha', 'bravo', 'charlie'])
    // NULLs last in both directions.
    expect((await get(env, '?sort=-lastRunAt')).body.rows.map((r: any) => r.slug)).toEqual(['alpha', 'bravo', 'charlie'])
    expect((await get(env, '?sort=lastRunAt')).body.rows.map((r: any) => r.slug)).toEqual(['bravo', 'alpha', 'charlie'])
    const paged = (await get(env, '?size=10&page=1')).body
    expect([paged.size, paged.pageCount]).toEqual([10, 1])
  })
  it('answers 400 bad_table_query on an unknown column or op', async () => {
    const env = await seeded()
    expect(await get(env, '?sort=nope')).toMatchObject({ status: 400, body: { error: 'bad_table_query' } })
    expect(await get(env, '?f.sets=has:1')).toMatchObject({ status: 400, body: { error: 'bad_table_query' } })
  })
})

describe('djSetFacts and GET /ui/api/dj/:slug', () => {
  it('knows each set: video from the sync or the page facts, track and ID counts', async () => {
    const env = await seeded()
    const f = await djSetFacts(env, 'alpha')
    expect(f.get('https://www.1001tracklists.com/tracklist/a1/alpha-one-2026-01-01.html')).toMatchObject({ tracked: true, processed: true, video: 'page', videoId: 'vid00000001', trackCount: 20, idedCount: 18, factsAt: T * 1000 })
    expect(f.get('https://www.1001tracklists.com/tracklist/a2/alpha-two-2026-02-01.html')).toMatchObject({ video: 'mkvid', trackCount: null })
    expect(f.get('https://www.1001tracklists.com/tracklist/a3/alpha-three-2026-03-01.html')).toMatchObject({ tracked: true, processed: false, video: null })
    expect(f.get('https://www.1001tracklists.com/tracklist/a9/alpha-crawl-only-2026-04-01.html')).toMatchObject({ tracked: false, video: 'none', trackCount: 10, idedCount: 10 })
    expect((await djSetFacts(env, 'bravo')).get('https://www.1001tracklists.com/tracklist/b1/bravo-one-2026-01-05.html')).toMatchObject({ video: 'none' })
  })
  it('merges the facts into the profile list (served from the set-list cache)', async () => {
    const env = await seeded()
    const urls = ['https://www.1001tracklists.com/tracklist/a1/alpha-one-2026-01-01.html', 'https://www.1001tracklists.com/tracklist/zz/unknown-set-2026-05-01.html']
    await env.CACHE.put('djsets:v2:alpha', JSON.stringify({
      slug: 'alpha', artistName: 'Alpha One', source: 'crawl', crawledAt: Math.floor(Date.now() / 1000), pagesWalked: 1, stopReason: 'done', listingComplete: true,
      sets: urls.map((url) => ({ url, tlSlug: null, title: url, date: null })),
    }))
    const r = await app.request('https://tracked.example/ui/api/dj/alpha', {}, env)
    expect(r.status).toBe(200)
    const body = (await r.json()) as any
    expect(body.subscribed).toBe(true)
    expect(body.sets[0].facts).toMatchObject({ video: 'page', trackCount: 20, idedCount: 18 })
    expect(body.sets[1].facts).toBeNull()
  })
})
