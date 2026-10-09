// The Stats page: lib/stats.ts over the real schema, the hourly snapshot, the
// API route, and the page script drawing its panels in a stub DOM.
import { describe, it, expect } from 'vitest'
import vm from 'node:vm'
import { fakeD1 } from './helpers/fake-d1'
import { fakeKV } from './helpers/fake-kv'
import type { Env } from '../src/types'
import { computeStats, fillDays, maybeSnapshotStats, SNAPSHOT_STAMP_KEY, type StatsResponse } from '../src/lib/stats'
import { STATS_PAGE } from '../src/ui/pages/stats'
import { app } from '../src/index'

const NOW = Math.floor(Date.UTC(2026, 9, 9, 12, 30) / 1000)
const DAY = 86400
const env = (): Env => ({ CACHE: fakeKV(), SUBS: fakeKV(), DB: fakeD1(), SEARCH_DB: fakeD1({ migrations: 'search' }), API_TOKEN: 't', YOUTUBE_API_KEY: 'k', DEV_BYPASS_CF_ACCESS: '1' }) as unknown as Env

async function seed(e: Env) {
  const run = (sql: string, ...b: unknown[]) => e.DB.prepare(sql).bind(...b).run()
  await run("INSERT INTO subscriptions (slug, source_url, added_at, position) VALUES ('fisher', 'u', ?, 0), ('matroda', 'u', ?, 1)", NOW - 40 * DAY, NOW - 2 * DAY)
  await run("INSERT INTO sub_sync (slug, playlist_id, artist_name) VALUES ('fisher', 'PL1', 'FISHER')")
  const set = (slug: string, id: string, video: string | null, src: string | null, disc: number) =>
    run('INSERT INTO tracklists (slug, url, position, discovered_at, processed, video_known, video_id, video_source, checked_at) VALUES (?, ?, 0, ?, 1, 1, ?, ?, ?)', slug, `https://www.1001tracklists.com/tracklist/${id}/x-2024-05-01.html`, disc, video, src, disc)
  await set('fisher', 'a', 'v1', '1001tl', NOW - DAY)
  await set('fisher', 'b', 'v2', 'mkvid', NOW - DAY)
  await set('fisher', 'c', null, null, NOW - 3 * DAY)
  await set('matroda', 'd', null, null, NOW)
  await run("INSERT INTO set_verification (url, state, fingerprint, row_count, first_account, first_fetched_at, verify_due_at, verified_at, updated_at) VALUES ('https://www.1001tracklists.com/tracklist/a/x-2024-05-01.html', 'verified', 'f', 1, 'a', 1, 1, ?, 1)", NOW - DAY)
  await run("INSERT INTO mkvid_requests (id, slug, set_url, source, source_url, status, created_at, updated_at) VALUES ('r1', 'fisher', 'https://x/1', 'soundcloud', 's', 'done', ?, ?), ('r2', 'fisher', 'https://x/2', 'hearthis', 's', 'pending', ?, ?)", NOW - 5 * DAY, NOW - DAY, NOW, NOW)
  await run("INSERT INTO presave_candidates (key, track_id, artist, title, is_id, presave_count, set_url, first_seen_at, updated_at) VALUES ('track:1', '1', 'BLR', 'Lipstick', 0, 108, 's', ?, ?)", NOW * 1000, NOW * 1000)
  await run("INSERT INTO playlist_additions (t, ts, status, slug, set_url, video_id, summary, record) VALUES ('x', ?, 'added', 'fisher', 's', 'v1', '', '{}')", (NOW - DAY) * 1000)
  await run("INSERT INTO scheduler_ticks (at, ms, drawn, ran, items) VALUES (?, 1, 2, 2, ?)", NOW - 3600, JSON.stringify([{ kind: 'verify', outcome: 'ok' }, { kind: 'index_catchup', outcome: 'stopped' }]))
  await e.SEARCH_DB!.prepare("INSERT INTO search_sets (set_url, dj_slug, dj_name, title, source, indexed_at) VALUES ('https://www.1001tracklists.com/tracklist/a/x-2024-05-01.html', 'fisher', 'FISHER', 't', 'page', ?)").bind(NOW - DAY).run()
}

describe('computeStats', () => {
  it('counts, daily series, breakdowns and the scheduler hours from the real schema', async () => {
    const e = env()
    await seed(e)
    const s = await computeStats(e, NOW)
    expect(s.cards).toMatchObject({ djs: 2, sets: 4, setsWithVideo: 2, setsNoVideo: 2, setsMkvid: 1, sets1001tl: 1, setsVerified: 1, searchSets: 1, mkvidDone: 1, mkvidPending: 1, candidates: 1, candidateTop: 108, poolAccounts: null })
    expect(s.daily.discovered).toHaveLength(60)
    expect(s.daily.discovered!.at(-1)).toEqual(['2026-10-09', 1])
    expect(s.daily.discovered!.at(-2)).toEqual(['2026-10-08', 2])
    expect(s.daily.playlistAdds!.at(-2)).toEqual(['2026-10-08', 1])
    expect(s.djsOverTime.map((x) => x[1])).toEqual([1, 2])
    expect(s.breakdowns.setsPerDj[0]).toMatchObject({ slug: 'fisher', name: 'FISHER', sets: 3, withVideo: 2, searchable: 1 })
    expect(s.breakdowns.setYears).toEqual([])
    expect(s.hourly).toHaveLength(48)
    expect(s.hourly.find((h) => h.kinds.verify)).toMatchObject({ kinds: { verify: 1 }, stopped: 1 })
    expect(s.topCandidates[0]).toMatchObject({ artist: 'BLR', count: 108, presaveId: null })
    expect(s.pool).toEqual({ ok: false, error: 'not configured' })
  })

  it('fillDays zero-fills the window, oldest first', () => {
    expect(fillDays([{ d: '2026-10-08', n: 3 }], NOW, 3)).toEqual([['2026-10-07', 0], ['2026-10-08', 3], ['2026-10-09', 0]])
  })

  it('snapshots once an hour and the page shows them over time', async () => {
    const e = env()
    await seed(e)
    expect(await maybeSnapshotStats(e, undefined, NOW)).toBe(true)
    expect(await maybeSnapshotStats(e, undefined, NOW + 600)).toBe(false)
    expect(Number(await e.CACHE.get(SNAPSHOT_STAMP_KEY))).toBe(NOW - (NOW % 3600))
    expect(await maybeSnapshotStats(e, undefined, NOW + 3600)).toBe(true)
    const s = await computeStats(e, NOW + 3700)
    expect(s.snapshots.map((x) => x.data.sets)).toEqual([4, 4])
  })

  it('GET /ui/api/stats answers (and caches), behind Access like every /ui route', async () => {
    const e = env()
    await seed(e)
    const res = await app.request('https://tracked.example/ui/api/stats', {}, e)
    expect(res.status).toBe(200)
    expect(((await res.json()) as StatsResponse).cards.djs).toBe(2)
    expect(await e.CACHE.get('stats:v1')).not.toBeNull()
    const page = await app.request('https://tracked.example/ui/stats', {}, e)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('Stats')
  })
})

describe('the Stats page script', () => {
  it('draws a few dozen panels: tiles, bar and line charts with tooltips, and a data table each', async () => {
    const e = env()
    await seed(e)
    await maybeSnapshotStats(e, undefined, NOW - 7200)
    await maybeSnapshotStats(e, undefined, NOW)
    const stats = await computeStats(e, NOW)
    const els = new Map<string, any>()
    const el = (): any => ({ innerHTML: '', textContent: '', hidden: false, clientWidth: 400, style: {}, addEventListener() {}, setAttribute() {}, getAttribute: () => null, querySelector: () => null, classList: { add() {}, remove() {} } })
    const get = (id: string) => (els.has(id) ? els.get(id) : (els.set(id, el()), els.get(id)))
    const document = { getElementById: get, querySelector: () => null, addEventListener() {}, createElement: () => el(), hidden: false }
    const fetch = async (url: string) => (url.startsWith('/ui/api/stats') ? Response.json(stats) : Response.json({}))
    const ctx = vm.createContext({ document, fetch, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, console, Date, URLSearchParams, JSON, URL, AbortController, location: { search: '', pathname: '/ui/stats', hash: '' }, history: { replaceState() {} } })
    for (const m of STATS_PAGE.html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(m[1]!, ctx)
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
    const grid = get('st-grid').innerHTML as string
    const cards = grid.match(/class="st-card/g)?.length ?? 0
    expect(cards).toBeGreaterThanOrEqual(40)
    const charts = [...els.entries()].filter(([k]) => k.startsWith('st-c')).map(([, v]) => v.innerHTML as string)
    expect(charts.some((h) => h.includes('<rect') && h.includes('data-t="'))).toBe(true)
    expect(charts.some((h) => h.includes('<path') && h.includes('class="st-guide"'))).toBe(true)
    expect(charts.filter((h) => h.includes('Could not draw')).map((h, i) => [i, h])).toEqual([])
    expect(grid).toContain('<details class="st-data">')
    expect(grid).toContain('BLR')
    expect(get('st-when').textContent).toContain('As of')
  })
})
