import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fakeD1 } from './helpers/fake-d1'
import { fakeKV } from './helpers/fake-kv'
import type { Env } from '../src/types'
import { makeLogger } from '../src/lib/log'
import { saveCombinedState } from '../src/lib/combined-playlist'
import { DEFAULT_APP_SETTINGS, updateAppSettings } from '../src/lib/app-settings'
import { loadOrderState, managedPlaylists, orderQueue, orderReport, orderUnitsUsedToday, quotaStop, runOrderPass } from '../src/lib/playlist-reorder'
import { YouTubeApiError } from '../src/lib/youtube-playlists'

const log = makeLogger({ task: 'test' })
const setUrl = (n: number, date: string) => `https://www.1001tracklists.com/tracklist/${n}/dj-set-${n}-${date}.html`

/**
 * A YouTube that keeps playlists as ordered lists: playlistItems.list pages by
 * 50 and reports `snippet.position`; playlistItems.update moves an item (out,
 * then back in at the position) and replies with where it is. Every call is
 * counted in quota units. Knobs:
 *   - `refuseAfterUnits` / `refuseWith`  answer 403 with that reason from then on
 *   - `semantics`  'documented' as above; 'before' puts the item in front of
 *     whatever was at that index BEFORE it was taken out (one short when
 *     moving down the list); 'ignored' accepts the move and does nothing
 *   - `reply`  'position' (the true index), 'echo' (what was asked), 'none'
 */
function fakeYouTube(playlists: Record<string, string[]>) {
  const yt = {
    playlists: Object.fromEntries(Object.entries(playlists).map(([id, vids]) => [id, [...vids]])),
    units: 0,
    calls: [] as string[],
    moves: [] as Array<{ playlistId: string; videoId: string; position: number }>,
    refuseAfterUnits: Infinity,
    refuseWith: 'quotaExceeded',
    manualSortRequired: new Set<string>(),
    semantics: 'documented' as 'documented' | 'before' | 'ignored',
    reply: 'position' as 'position' | 'echo' | 'none',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      const refuse = (status: number, reason: string) => json(status, { error: { code: status, errors: [{ reason }] } })
      const method = init?.method ?? 'GET'
      yt.calls.push(`${method} ${url.searchParams.get('playlistId') ?? ''}`)
      if (yt.units >= yt.refuseAfterUnits) return refuse(403, yt.refuseWith)
      if (method === 'GET') {
        yt.units += 1
        const list = yt.playlists[url.searchParams.get('playlistId')!]
        if (!list) return refuse(404, 'playlistNotFound')
        const only = url.searchParams.get('videoId')
        const start = Number(url.searchParams.get('pageToken') ?? 0)
        const all = list.map((v, i) => ({ id: `item-${v}`, snippet: { position: i, resourceId: { videoId: v } }, contentDetails: { videoId: v } }))
        if (only) return json(200, { items: all.filter((it) => it.contentDetails.videoId === only) })
        return json(200, {
          // Deliberately not in playlist order: the reader has to go by snippet.position.
          items: all.slice(start, start + 50).reverse(),
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
      if (yt.semantics !== 'ignored') {
        list.splice(from, 1)
        list.splice(yt.semantics === 'before' && from < body.snippet.position ? body.snippet.position - 1 : body.snippet.position, 0, videoId)
      }
      yt.moves.push({ playlistId: body.snippet.playlistId, videoId, position: body.snippet.position })
      const at = yt.reply === 'echo' ? body.snippet.position : list.indexOf(videoId)
      return json(200, { id: body.id, snippet: yt.reply === 'none' ? {} : { position: at } })
    }) as typeof fetch,
  }
  return yt
}

/** Two DJs: `dj` with six sets, v1 (oldest) to v6 (newest), and `dj2` with w1 to w3. And a combined playlist, which is never ordered. */
async function makeEnv(opts: { budget?: number } = {}): Promise<Env> {
  const env = { CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k' } as unknown as Env
  await env.DB.prepare('INSERT INTO sub_sync (slug, playlist_id, artist_name) VALUES (?, ?, ?)').bind('dj', 'PLdj', 'DJ').run()
  await env.DB.prepare('INSERT INTO sub_sync (slug, playlist_id, artist_name) VALUES (?, ?, ?)').bind('dj2', 'PLdj2', 'DJ 2').run()
  const add = (slug: string, n: number, videoId: string) =>
    env.DB.prepare('INSERT INTO tracklists (slug, url, position, discovered_at, processed, video_known, video_id) VALUES (?, ?, ?, 0, 1, 1, ?)').bind(slug, setUrl(n, `2024-0${(n % 9) + 1}-01`), n, videoId).run()
  for (let n = 1; n <= 6; n++) await add('dj', n - 1, `v${n}`)
  for (let n = 1; n <= 3; n++) await add('dj2', n + 9, `w${n}`)
  await saveCombinedState(env, { playlistId: 'PLall' })
  // The pass ships paused; these tests give it a budget unless they are about the pause.
  if (opts.budget !== 0) await updateAppSettings(env, { playlists: { orderDailyUnits: opts.budget ?? 2000 } })
  return env
}

const run = (env: Env, yt: ReturnType<typeof fakeYouTube>) => runOrderPass(env, { log, fetcher: yt.fetch, accessToken: 'tok', trigger: 'test' })
const NEWEST_FIRST = ['v6', 'v5', 'v4', 'v3', 'v2', 'v1']
const SORTED = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6']
const W_SORTED = ['w1', 'w2', 'w3']
const UNSORTED_COMBINED = ['w3', 'v6', 'v1', 'w1']

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-12T18:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('paused by default', () => {
  it('ships with a budget of 0', () => {
    expect(DEFAULT_APP_SETTINGS.playlists.orderDailyUnits).toBe(0)
  })

  it('makes no YouTube call of any kind while paused: no move, no listing, no daily look', async () => {
    const env = await makeEnv({ budget: 0 })
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED, PLall: UNSORTED_COMBINED })
    const token = vi.fn()
    for (const day of ['2026-10-12', '2026-10-13', '2026-10-20']) {
      vi.setSystemTime(new Date(`${day}T18:00:00Z`))
      // No access token is handed in either: a paused pass must not even ask for one.
      expect(await runOrderPass(env, { log, fetcher: (async (...a: Parameters<typeof fetch>) => (token(), yt.fetch(...a))) as typeof fetch, trigger: 'test' })).toMatchObject({ read: 0, moved: 0, units: 0, stoppedBy: 'paused' })
    }
    expect(yt.calls).toEqual([])
    expect(token).not.toHaveBeenCalled()
    expect(yt.playlists.PLdj).toEqual(NEWEST_FIRST)
    expect(await orderUnitsUsedToday(env)).toBe(0)
  })

  it('still answers the dry run, and says what a budget would mean', async () => {
    const env = await makeEnv({ budget: 0 })
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED, PLall: UNSORTED_COMBINED })
    const r = await orderReport(env, { log, fresh: true, fetcher: yt.fetch, accessToken: 'tok' })
    expect(r).toMatchObject({ fresh: true, dailyUnits: 0, estimate: { moves: 5, units: 251, days: null } })
    expect(r.daysAt).toEqual([
      { dailyUnits: 1000, days: 1 },
      { dailyUnits: 2000, days: 1 },
      { dailyUnits: 4000, days: 1 },
    ])
    expect(yt.moves).toEqual([])
  })
})

describe('the combined playlist is not ordered', () => {
  it('is never read, planned or moved, by the pass or by the dry run', async () => {
    const env = await makeEnv()
    expect((await managedPlaylists(env)).map((p) => p.playlistId)).toEqual(['PLdj', 'PLdj2'])
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: ['w3', 'w1', 'w2'], PLall: UNSORTED_COMBINED })
    await run(env, yt)
    const r = await orderReport(env, { log, fresh: true, fetcher: yt.fetch, accessToken: 'tok' })
    expect(yt.calls.filter((c) => c.endsWith('PLall'))).toEqual([])
    expect(yt.playlists.PLall).toEqual(UNSORTED_COMBINED)
    expect(r.playlists.map((p) => p.playlistId)).toEqual(['PLdj', 'PLdj2'])
    expect(r.totals.playlists).toBe(2)
    expect((await loadOrderState(env)).playlists.PLall).toBeUndefined()
  })
})

describe('runOrderPass', () => {
  it('sorts a newest-first playlist by set date with the fewest moves and leaves a sorted one alone', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED })
    const r = await run(env, yt)
    expect(yt.playlists.PLdj).toEqual(SORTED)
    expect(yt.playlists.PLdj2).toEqual(W_SORTED)
    // Five moves (one entry stays), two listings.
    expect(yt.moves).toHaveLength(5)
    expect(r).toMatchObject({ read: 2, moved: 5, units: 252, stoppedBy: null })
    expect(yt.units).toBe(252)
    expect(await orderUnitsUsedToday(env)).toBe(252)
    expect((await loadOrderState(env)).playlists.PLdj).toMatchObject({ items: 6, undated: 0, moves: 0, moved: 5, problem: null })

    // Idempotent: nothing is due, so the next tick makes no YouTube call at all.
    expect(await run(env, yt)).toMatchObject({ read: 0, moved: 0, units: 0 })
    expect(yt.units).toBe(252)
  })

  it('puts videos with no known set after the dated ones, in the order they had', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: ['hand2', 'v3', 'hand1', 'v1'], PLdj2: W_SORTED })
    await run(env, yt)
    expect(yt.playlists.PLdj).toEqual(['v1', 'v3', 'hand2', 'hand1'])
    expect((await loadOrderState(env)).playlists.PLdj).toMatchObject({ items: 4, undated: 2 })
  })

  it('stops at the moves-per-run limit and resumes from the actual order next run', async () => {
    const env = await makeEnv()
    await updateAppSettings(env, { playlists: { orderMovesPerRun: 2 } })
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED })
    expect(await run(env, yt)).toMatchObject({ moved: 2, stoppedBy: 'run' })
    expect((await loadOrderState(env)).playlists.PLdj).toMatchObject({ moves: 3, moved: 2 })
    // The owner drags videos about in between: the next run plans from what is there now.
    yt.playlists.PLdj = ['v2', 'v1', 'v6', 'v3', 'v5', 'v4']
    for (let i = 0; i < 4 && JSON.stringify(yt.playlists.PLdj) !== JSON.stringify(SORTED); i++) await run(env, yt)
    expect(yt.playlists.PLdj).toEqual(SORTED)
  })

  it('never spends more than the daily unit budget, listings included, and picks up the next quota day', async () => {
    const env = await makeEnv({ budget: 120 })
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED })
    // One listing + 2 moves = 101; a third move would pass 120, and so would reading the next playlist and moving in it.
    expect(await run(env, yt)).toMatchObject({ moved: 2, units: 101, stoppedBy: 'budget' })
    expect(await run(env, yt)).toMatchObject({ read: 0, moved: 0, units: 0, stoppedBy: 'budget' })
    expect(yt.units).toBe(101)

    vi.setSystemTime(new Date('2026-10-13T18:00:00Z'))
    expect(await run(env, yt)).toMatchObject({ moved: 2, stoppedBy: 'budget' })
    expect(yt.units).toBeLessThanOrEqual(2 * 120)
  })

  it('stops on a daily-quota reply and does not call YouTube again until the quota day rolls over', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED })
    yt.refuseAfterUnits = 101
    expect(await run(env, yt)).toMatchObject({ moved: 2, stoppedBy: 'quota' })
    // Two moves landed; the playlist is a valid, partly sorted playlist.
    expect([...yt.playlists.PLdj!].sort()).toEqual(SORTED)
    const callsAfter = yt.calls.length
    expect(await run(env, yt)).toMatchObject({ read: 0, moved: 0, stoppedBy: 'quota' })
    expect(yt.calls).toHaveLength(callsAfter)
    expect((await orderReport(env, { log, accessToken: 'tok' })).quotaStoppedUntil).not.toBeNull()

    // Midnight Pacific has passed and the quota is back.
    vi.setSystemTime(new Date('2026-10-13T08:00:00Z'))
    yt.refuseAfterUnits = Infinity
    await run(env, yt)
    expect(yt.playlists.PLdj).toEqual(SORTED)
  })

  it('ends only this run on a per-minute rate limit: the next tick tries again', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED })
    yt.refuseAfterUnits = 101
    yt.refuseWith = 'rateLimitExceeded'
    expect(await run(env, yt)).toMatchObject({ moved: 2, stoppedBy: 'rate_limit' })
    expect((await loadOrderState(env)).quotaStoppedAt ?? null).toBeNull()
    expect((await orderReport(env, { log, accessToken: 'tok' })).quotaStoppedUntil).toBeNull()
    // Five minutes later, the same quota day.
    yt.refuseAfterUnits = Infinity
    vi.setSystemTime(new Date('2026-10-12T18:05:00Z'))
    await run(env, yt)
    expect(yt.playlists.PLdj).toEqual(SORTED)
  })

  it('records a playlist YouTube will not reorder and one it cannot read, and carries on with the rest', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST })
    yt.manualSortRequired.add('PLdj')
    expect((await run(env, yt)).moved).toBe(0)
    const state = await loadOrderState(env)
    expect(state.playlists.PLdj).toMatchObject({ problem: 'manual_sort', moves: 5 })
    expect(state.playlists.PLdj2).toMatchObject({ problem: 'unreadable' })
    // Neither is tried again on the next tick: a refused move costs 50 units.
    const before = yt.units
    await run(env, yt)
    expect(yt.units).toBe(before)
  })

  it('reads a playlist longer than one page in its real order', async () => {
    const env = await makeEnv()
    const many = Array.from({ length: 120 }, (_, i) => `x${i}`)
    const yt = fakeYouTube({ PLdj: [...many, 'v2', 'v1'], PLdj2: W_SORTED })
    await run(env, yt)
    // The two dated sets go in front, in order; the 120 undated ones are untouched.
    expect(yt.playlists.PLdj!.slice(0, 2)).toEqual(['v1', 'v2'])
    expect(yt.playlists.PLdj!.slice(2)).toEqual(many)
    expect(yt.moves).toHaveLength(2)
  })
})

describe('the pass checks that a move did what the plan expects', () => {
  it('stops a playlist after ONE move when YouTube puts the video somewhere else', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED })
    yt.semantics = 'before'
    const r = await run(env, yt)
    expect(r.moved).toBe(1)
    expect(yt.moves).toHaveLength(1)
    const s = (await loadOrderState(env)).playlists.PLdj!
    expect(s.problem).toBe('unexpected_position')
    expect(s.detail).toMatch(/moved to index \d+ is at index \d+/)
    // Not tried again on the next ticks; a day later it is looked at once more.
    await run(env, yt)
    expect(yt.moves).toHaveLength(1)
    vi.setSystemTime(new Date('2026-10-13T19:00:00Z'))
    await run(env, yt)
    expect(yt.moves).toHaveLength(2)
  })

  it('looks the item up (1 unit) when the update reply carries no position', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED })
    yt.reply = 'none'
    // Documented behaviour: the lookup agrees and the run goes on. 2 listings + 5 moves + 1 lookup.
    expect(await run(env, yt)).toMatchObject({ moved: 5, units: 253 })
    expect(yt.playlists.PLdj).toEqual(SORTED)

    const env2 = await makeEnv()
    const yt2 = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED })
    yt2.reply = 'none'
    yt2.semantics = 'before'
    expect((await run(env2, yt2)).moved).toBe(1)
    expect((await loadOrderState(env2)).playlists.PLdj!.problem).toBe('unexpected_position')
  })

  it('stops a playlist whose moves change nothing, even when every reply says they worked', async () => {
    const env = await makeEnv()
    await updateAppSettings(env, { playlists: { orderMovesPerRun: 3 } })
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED })
    yt.semantics = 'ignored'
    yt.reply = 'echo'
    expect(await run(env, yt)).toMatchObject({ moved: 3 })
    // The next reading finds the playlist needing as many moves as before those three.
    expect(await run(env, yt)).toMatchObject({ moved: 0 })
    expect(yt.moves).toHaveLength(3)
    expect((await loadOrderState(env)).playlists.PLdj).toMatchObject({ problem: 'no_progress', moves: 5 })
    await run(env, yt)
    expect(yt.moves).toHaveLength(3)
  })
})

describe('orderQueue', () => {
  it('reads unread playlists first, then finishes the smallest, then gives sorted ones their daily look', () => {
    const p = (playlistId: string) => ({ playlistId, slug: playlistId, title: playlistId })
    const s = (moves: number, checkedAt = 1000) => ({ ...p('x'), items: 10, undated: 0, moves, units: moves * 50, checkedAt, moved: 0 })
    const state = { playlists: { big: s(40), small: s(3), done: s(0), old: s(0, 0) } }
    const all = [p('big'), p('new'), p('small'), p('done'), p('old')]
    expect(orderQueue(all, state, 1000 + 3600).map((q) => q.playlistId)).toEqual(['new', 'small', 'big'])
    expect(orderQueue(all, state, 1000 + 86400).map((q) => q.playlistId)).toEqual(['new', 'small', 'big', 'old', 'done'])
  })
})

describe('orderReport (the dry run)', () => {
  it('reports entries, undated, moves and units per playlist, totals and days, and moves nothing', async () => {
    const env = await makeEnv({ budget: 100 })
    const yt = fakeYouTube({ PLdj: [...NEWEST_FIRST, 'hand'], PLdj2: ['w2', 'w1', 'w3'] })
    const before = JSON.stringify(yt.playlists)
    const r = await orderReport(env, { log, fresh: true, fetcher: yt.fetch, accessToken: 'tok' })
    expect(JSON.stringify(yt.playlists)).toBe(before)
    expect(yt.moves).toEqual([])
    expect(r).toMatchObject({ connected: true, fresh: true, unitsSpent: 2, dailyUnits: 100 })
    expect(r.playlists.map((p) => [p.playlistId, 'items' in p && p.items, 'undated' in p && p.undated, 'moves' in p && p.moves, 'units' in p && p.units])).toEqual([
      ['PLdj', 7, 1, 5, 250],
      ['PLdj2', 3, 0, 1, 50],
    ])
    expect(r.totals).toEqual({ playlists: 2, unread: 0, items: 10, undated: 1, moves: 6, units: 300 })
    // 300 for the moves and one listing of each playlist: 302 units, 4 days at 100 a day.
    expect(r.estimate).toEqual({ moves: 6, units: 302, days: 4 })

    // Without `fresh` the same numbers come from what was stored: no YouTube call.
    const stored = await orderReport(env, { log, fetcher: yt.fetch, accessToken: 'tok' })
    expect(yt.units).toBe(2)
    expect(stored.fresh).toBe(false)
    expect(stored.totals).toEqual(r.totals)
  })

  it('leaves a playlist the pass cannot order out of the days, not out of the table', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: ['w2', 'w1', 'w3'] })
    yt.manualSortRequired.add('PLdj')
    await run(env, yt)
    const r = await orderReport(env, { log, fresh: true, fetcher: yt.fetch, accessToken: 'tok' })
    expect(r.playlists[0]).toMatchObject({ playlistId: 'PLdj', moves: 5, problem: 'manual_sort' })
    expect(r.totals.moves).toBe(5)
    expect(r.estimate).toEqual({ moves: 0, units: 0, days: 0 })
  })

  it('says a playlist was never read rather than calling it sorted', async () => {
    const env = await makeEnv()
    const r = await orderReport(env, { log, accessToken: 'tok' })
    expect(r.totals).toMatchObject({ playlists: 2, unread: 2, moves: 0 })
    expect(r.playlists[0]).toMatchObject({ playlistId: 'PLdj', checkedAt: null })
  })
})

describe('quotaStop', () => {
  const err = (reason: string) => new YouTubeApiError('playlistItems.update', 403, reason, '{}')
  it('tells the spent day from a per-minute limit, and both from anything else', () => {
    expect(quotaStop(err('quotaExceeded'))).toBe('daily')
    expect(quotaStop(err('dailyLimitExceeded'))).toBe('daily')
    expect(quotaStop(err('rateLimitExceeded'))).toBe('rate')
    expect(quotaStop(err('userRateLimitExceeded'))).toBe('rate')
    expect(quotaStop(err('forbidden'))).toBeNull()
    expect(quotaStop(new Error('quotaExceeded'))).toBeNull()
  })
})
