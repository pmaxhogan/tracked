import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fakeD1 } from './helpers/fake-d1'
import { fakeKV } from './helpers/fake-kv'
import type { Env } from '../src/types'
import { makeLogger } from '../src/lib/log'
import { saveCombinedState } from '../src/lib/combined-playlist'
import { updateAppSettings } from '../src/lib/app-settings'
import { loadOrderState, managedPlaylists, orderQueue, orderReport, orderUnitsUsedToday, runOrderPass, stoppedByQuota } from '../src/lib/playlist-reorder'
import { YouTubeApiError } from '../src/lib/youtube-playlists'

const log = makeLogger({ task: 'test' })
const setUrl = (n: number, date: string) => `https://www.1001tracklists.com/tracklist/${n}/dj-set-${n}-${date}.html`

/**
 * A YouTube that keeps playlists as ordered lists: playlistItems.list pages by
 * 50 and reports `snippet.position`; playlistItems.update moves an item the way
 * the real one does (out, then back in at the position). Every call is counted
 * in quota units, and `failAfterUnits` makes it answer quotaExceeded from then on.
 */
function fakeYouTube(playlists: Record<string, string[]>) {
  const yt = {
    playlists: Object.fromEntries(Object.entries(playlists).map(([id, vids]) => [id, [...vids]])),
    units: 0,
    moves: [] as Array<{ playlistId: string; videoId: string; position: number }>,
    failAfterUnits: Infinity,
    manualSortRequired: new Set<string>(),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      const refuse = (status: number, reason: string) => json(status, { error: { code: status, errors: [{ reason }] } })
      if (yt.units >= yt.failAfterUnits) return refuse(403, 'quotaExceeded')
      if ((init?.method ?? 'GET') === 'GET') {
        yt.units += 1
        const list = yt.playlists[url.searchParams.get('playlistId')!]
        if (!list) return refuse(404, 'playlistNotFound')
        const start = Number(url.searchParams.get('pageToken') ?? 0)
        const page = list.slice(start, start + 50)
        return json(200, {
          // Deliberately not in playlist order: the reader has to go by snippet.position.
          items: page.map((v, i) => ({ id: `item-${v}`, snippet: { position: start + i, resourceId: { videoId: v } }, contentDetails: { videoId: v } })).reverse(),
          ...(start + 50 < list.length ? { nextPageToken: String(start + 50) } : {}),
        })
      }
      yt.units += 50
      const body = JSON.parse(String(init!.body)) as { id: string; snippet: { playlistId: string; position: number; resourceId: { videoId: string } } }
      if (yt.manualSortRequired.has(body.snippet.playlistId)) return refuse(400, 'manualSortRequired')
      const list = yt.playlists[body.snippet.playlistId]!
      const videoId = body.id.replace(/^item-/, '')
      const from = list.indexOf(videoId)
      if (from < 0 || videoId !== body.snippet.resourceId.videoId) return refuse(404, 'playlistItemNotFound')
      list.splice(from, 1)
      list.splice(body.snippet.position, 0, videoId)
      yt.moves.push({ playlistId: body.snippet.playlistId, videoId, position: body.snippet.position })
      return json(200, {})
    }) as typeof fetch,
  }
  return yt
}

/** One DJ with six sets, v1 (oldest) to v6 (newest), plus a combined playlist. */
async function makeEnv(): Promise<Env> {
  const env = { CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k' } as unknown as Env
  await env.DB.prepare('INSERT INTO sub_sync (slug, playlist_id, artist_name) VALUES (?, ?, ?)').bind('dj', 'PLdj', 'DJ').run()
  for (let n = 1; n <= 6; n++) {
    await env.DB.prepare('INSERT INTO tracklists (slug, url, position, discovered_at, processed, video_known, video_id) VALUES (?, ?, ?, 0, 1, 1, ?)').bind('dj', setUrl(n, `2024-0${n}-01`), n, `v${n}`).run()
  }
  await saveCombinedState(env, { playlistId: 'PLall' })
  return env
}

const run = (env: Env, yt: ReturnType<typeof fakeYouTube>) => runOrderPass(env, { log, fetcher: yt.fetch, accessToken: 'tok', trigger: 'test' })
const NEWEST_FIRST = ['v6', 'v5', 'v4', 'v3', 'v2', 'v1']
const SORTED = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6']

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-12T18:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('managedPlaylists', () => {
  it('is every artist playlist and the combined one', async () => {
    const env = await makeEnv()
    expect((await managedPlaylists(env)).map((p) => [p.kind, p.playlistId])).toEqual([
      ['artist', 'PLdj'],
      ['combined', 'PLall'],
    ])
  })
})

describe('runOrderPass', () => {
  it('sorts a newest-first playlist by set date with the fewest moves and leaves a sorted one alone', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLall: SORTED })
    const r = await run(env, yt)
    expect(yt.playlists.PLdj).toEqual(SORTED)
    expect(yt.playlists.PLall).toEqual(SORTED)
    // Five moves (one entry stays), two listings.
    expect(yt.moves).toHaveLength(5)
    expect(r).toMatchObject({ read: 2, moved: 5, units: 252, stoppedBy: null })
    expect(yt.units).toBe(252)
    expect(await orderUnitsUsedToday(env)).toBe(252)
    const state = await loadOrderState(env)
    expect(state.playlists.PLdj).toMatchObject({ items: 6, undated: 0, moves: 0, moved: 5, problem: null })

    // Idempotent: nothing is due, so the next tick makes no YouTube call at all.
    const again = await run(env, yt)
    expect(again).toMatchObject({ read: 0, moved: 0, units: 0 })
    expect(yt.units).toBe(252)
  })

  it('puts videos with no known set after the dated ones, in the order they had', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: ['hand2', 'v3', 'hand1', 'v1'], PLall: [] })
    await run(env, yt)
    expect(yt.playlists.PLdj).toEqual(['v1', 'v3', 'hand2', 'hand1'])
    expect((await loadOrderState(env)).playlists.PLdj).toMatchObject({ items: 4, undated: 2 })
  })

  it('stops at the moves-per-run limit and resumes from the actual order next run', async () => {
    const env = await makeEnv()
    await updateAppSettings(env, { playlists: { orderMovesPerRun: 2 } })
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLall: SORTED })
    expect(await run(env, yt)).toMatchObject({ moved: 2, stoppedBy: 'run' })
    expect((await loadOrderState(env)).playlists.PLdj).toMatchObject({ moves: 3, moved: 2 })
    // The owner drags a video in between: the next run plans from what is there now.
    yt.playlists.PLdj!.reverse()
    for (let i = 0; i < 4 && JSON.stringify(yt.playlists.PLdj) !== JSON.stringify(SORTED); i++) await run(env, yt)
    expect(yt.playlists.PLdj).toEqual(SORTED)
  })

  it('never spends more than the daily unit budget, listings included, and picks up the next quota day', async () => {
    const env = await makeEnv()
    await updateAppSettings(env, { playlists: { orderDailyUnits: 120 } })
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLall: SORTED })
    const first = await run(env, yt)
    // Both playlists read (2) + 2 moves = 102; a third move would pass 120.
    expect(first).toMatchObject({ moved: 2, units: 102, stoppedBy: 'budget' })
    expect(await run(env, yt)).toMatchObject({ read: 0, moved: 0, units: 0, stoppedBy: 'budget' })
    expect(yt.units).toBe(102)

    vi.setSystemTime(new Date('2026-10-13T18:00:00Z'))
    expect(await run(env, yt)).toMatchObject({ moved: 2, stoppedBy: 'budget' })
    expect(yt.units).toBeLessThanOrEqual(2 * 120)
  })

  it('stops cleanly on a quota reply and does not call YouTube again until the quota day rolls over', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLall: SORTED })
    yt.failAfterUnits = 101
    const r = await run(env, yt)
    expect(r).toMatchObject({ moved: 2, stoppedBy: 'quota' })
    // Two moves landed; the playlist is a valid, partly sorted playlist.
    expect([...yt.playlists.PLdj!].sort()).toEqual(SORTED)
    const unitsAfter = yt.units
    expect(await run(env, yt)).toMatchObject({ read: 0, moved: 0, stoppedBy: 'quota' })
    expect(yt.units).toBe(unitsAfter)

    // Midnight Pacific has passed and the quota is back.
    vi.setSystemTime(new Date('2026-10-13T08:00:00Z'))
    yt.failAfterUnits = Infinity
    await run(env, yt)
    expect(yt.playlists.PLdj).toEqual(SORTED)
  })

  it('does nothing while paused (budget 0)', async () => {
    const env = await makeEnv()
    await updateAppSettings(env, { playlists: { orderDailyUnits: 0 } })
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLall: SORTED })
    expect(await run(env, yt)).toMatchObject({ read: 0, moved: 0, stoppedBy: 'paused' })
    expect(yt.units).toBe(0)
  })

  it('records a playlist YouTube will not reorder and one it cannot read, and carries on with the rest', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST })
    yt.manualSortRequired.add('PLdj')
    const r = await run(env, yt)
    expect(r.moved).toBe(0)
    const state = await loadOrderState(env)
    expect(state.playlists.PLdj).toMatchObject({ problem: 'manual_sort', moves: 5 })
    expect(state.playlists.PLall).toMatchObject({ problem: 'unreadable' })
    // Neither is tried again on the next tick: a refused move costs 50 units.
    const before = yt.units
    await run(env, yt)
    expect(yt.units).toBe(before)
  })

  it('reads a playlist longer than one page in its real order', async () => {
    const env = await makeEnv()
    const many = Array.from({ length: 120 }, (_, i) => `x${i}`)
    const yt = fakeYouTube({ PLdj: [...many, 'v2', 'v1'], PLall: [] })
    await run(env, yt)
    // The two dated sets go in front, in order; the 120 undated ones are untouched.
    expect(yt.playlists.PLdj!.slice(0, 2)).toEqual(['v1', 'v2'])
    expect(yt.playlists.PLdj!.slice(2)).toEqual(many)
    expect(yt.moves).toHaveLength(2)
  })
})

describe('orderQueue', () => {
  it('reads unread playlists first, then finishes the smallest artist playlist, and leaves the combined one for last', () => {
    const p = (playlistId: string, kind: 'artist' | 'combined') => ({ playlistId, kind, slug: null, title: playlistId })
    const s = (moves: number, checkedAt = 1000) => ({ ...p('x', 'artist'), items: 10, undated: 0, moves, units: moves * 50, checkedAt, moved: 0 })
    const state = { playlists: { big: s(40), small: s(3), all: s(500), done: s(0), old: s(0, 0) } }
    const queue = orderQueue([p('all', 'combined'), p('big', 'artist'), p('new', 'artist'), p('small', 'artist'), p('done', 'artist'), p('old', 'artist')], state, 1000 + 3600)
    expect(queue.map((q) => q.playlistId)).toEqual(['new', 'small', 'big', 'all'])
    // A day later the sorted ones are due another look, still before the combined playlist.
    expect(orderQueue([p('all', 'combined'), p('done', 'artist')], state, 1000 + 86400).map((q) => q.playlistId)).toEqual(['done', 'all'])
  })
})

describe('orderReport (the dry run)', () => {
  it('reports entries, undated, moves and units per playlist, totals and days, and moves nothing', async () => {
    const env = await makeEnv()
    await updateAppSettings(env, { playlists: { orderDailyUnits: 100, orderMovesPerRun: 10 } })
    const yt = fakeYouTube({ PLdj: [...NEWEST_FIRST, 'hand'], PLall: ['v2', 'v1', 'v3'] })
    const before = JSON.stringify(yt.playlists)
    const r = await orderReport(env, { log, fresh: true, fetcher: yt.fetch, accessToken: 'tok' })
    expect(JSON.stringify(yt.playlists)).toBe(before)
    expect(yt.moves).toEqual([])
    expect(r).toMatchObject({ connected: true, fresh: true, unitsSpent: 2, dailyUnits: 100 })
    expect(r.playlists.map((p) => [p.playlistId, 'items' in p && p.items, 'undated' in p && p.undated, 'moves' in p && p.moves, 'units' in p && p.units])).toEqual([
      ['PLdj', 7, 1, 5, 250],
      ['PLall', 3, 0, 1, 50],
    ])
    expect(r.totals).toEqual({ playlists: 2, unread: 0, items: 10, undated: 1, moves: 6, units: 300 })
    // 300 for the moves and one listing of each playlist: 302 units, 4 days at 100 a day.
    expect(r.estimate).toEqual({ units: 302, days: 4 })

    // Without `fresh` the same numbers come from what was stored: no YouTube call.
    const stored = await orderReport(env, { log, fetcher: yt.fetch, accessToken: 'tok' })
    expect(yt.units).toBe(2)
    expect(stored.fresh).toBe(false)
    expect(stored.totals).toEqual(r.totals)
  })

  it('says a playlist was never read rather than calling it sorted', async () => {
    const env = await makeEnv()
    const r = await orderReport(env, { log, accessToken: 'tok' })
    expect(r.totals).toMatchObject({ playlists: 2, unread: 2, moves: 0 })
    expect(r.playlists[0]).toMatchObject({ playlistId: 'PLdj', checkedAt: null })
  })
})

describe('stoppedByQuota', () => {
  it('is true for a quota reply and nothing else', () => {
    expect(stoppedByQuota(new YouTubeApiError('playlistItems.update', 403, 'quotaExceeded', '{}'))).toBe(true)
    expect(stoppedByQuota(new YouTubeApiError('playlistItems.update', 403, 'forbidden', '{}'))).toBe(false)
    expect(stoppedByQuota(new Error('quotaExceeded'))).toBe(false)
  })
})
