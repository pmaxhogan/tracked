import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fakeD1 } from './helpers/fake-d1'
import { fakeKV } from './helpers/fake-kv'
import type { Env } from '../src/types'
import { makeLogger } from '../src/lib/log'
import { saveCombinedState } from '../src/lib/combined-playlist'
import { AppSettingsSchema, DEFAULT_APP_SETTINGS, updateAppSettings } from '../src/lib/app-settings'
import { loadOrderState, managedPlaylists, orderQueue, orderReport, orderUnitsUsedToday, quotaStop, retryOrderPlaylist, runOrderPass } from '../src/lib/playlist-reorder'
import { isNotManual, noteNotManual } from '../src/lib/playlist-order-store'
import { YouTubeApiError } from '../src/lib/youtube-playlists'
import { getQuotaOut } from '../src/lib/youtube-quota'

const log = makeLogger({ task: 'test' })
const setUrl = (n: number, date: string) => `https://www.1001tracklists.com/tracklist/${n}/dj-set-${n}-${date}.html`

/**
 * A YouTube that keeps playlists as ordered lists: playlistItems.list pages by
 * 50 and reports `snippet.position`; the same call with `videoId` is the
 * lookup of one item; playlistItems.update moves an item. Every call is
 * counted in quota units. Knobs:
 *   - `refuseAfterUnits` / `refuseWith`  answer 403 with that reason from then on
 *   - `semantics`  how a move shifts the list:
 *       'documented'  out, then back in at the position
 *       'before'      in front of whatever was at that index BEFORE it was
 *                     taken out (one short when moving down the list)
 *       'swap'        changes places with whatever is at that index
 *       'ignored'     accepted, nothing happens
 *   - `reply`  what the update answers: 'echo' (the position asked for,
 *     whatever happened) or 'none'. Never the truth: the pass must not need it.
 *   - `staleLookups`  this many lookups after a move still see the list as it
 *     was before it (read-after-write lag)
 *   - `lookupsLie`  lookups answer as if every move had done the documented thing
 *   - `brokenPositions`  playlists whose listing repeats a position
 *   - `dead`  videos that are gone from YouTube: the listing shows them as a
 *     foreign private video, and both the `videoId` lookup and a move of
 *     them answer 404 videoNotFound
 *   - `hiddenGone`  the same refusals for videos the listing shows as there
 */
function fakeYouTube(playlists: Record<string, string[]>) {
  const copy = (o: Record<string, string[]>) => Object.fromEntries(Object.entries(o).map(([id, vids]) => [id, [...vids]]))
  const yt = {
    playlists: copy(playlists),
    /** What the lists would be had every move done the documented thing. */
    believed: copy(playlists),
    /** The lists as they were before the last move. */
    previous: copy(playlists),
    units: 0,
    calls: [] as string[],
    lookups: 0,
    moves: [] as Array<{ playlistId: string; videoId: string; position: number }>,
    refuseAfterUnits: Infinity,
    refuseWith: 'quotaExceeded',
    manualSortRequired: new Set<string>(),
    brokenPositions: new Set<string>(),
    semantics: 'documented' as 'documented' | 'before' | 'swap' | 'ignored',
    reply: 'echo' as 'echo' | 'none',
    staleLookups: 0,
    lookupsLie: false,
    dead: new Set<string>(),
    hiddenGone: new Set<string>(),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      const refuse = (status: number, reason: string) => json(status, { error: { code: status, errors: [{ reason }] } })
      const method = init?.method ?? 'GET'
      yt.calls.push(`${method} ${url.searchParams.get('playlistId') ?? ''}`)
      if (yt.units >= yt.refuseAfterUnits) return refuse(403, yt.refuseWith)
      const gone = (v: string | null) => !!v && (yt.dead.has(v) || yt.hiddenGone.has(v))
      const items = (list: string[]) =>
        list.map((v, i) =>
          yt.dead.has(v)
            ? { id: `item-${v}`, snippet: { position: i, title: 'Private video', resourceId: { videoId: v } }, contentDetails: { videoId: v }, status: { privacyStatus: 'private' } }
            : { id: `item-${v}`, snippet: { position: i, title: `Set ${v}`, videoOwnerChannelId: 'UCsomeone', resourceId: { videoId: v } }, contentDetails: { videoId: v, videoPublishedAt: '2024-01-01T00:00:00Z' }, status: { privacyStatus: 'public' } },
        )
      if (method === 'GET') {
        yt.units += 1
        const id = url.searchParams.get('playlistId')!
        if (!yt.playlists[id]) return refuse(404, 'playlistNotFound')
        const only = url.searchParams.get('videoId')
        if (only) {
          yt.lookups += 1
          if (gone(only)) return refuse(404, 'videoNotFound')
          const from = yt.staleLookups > 0 ? (yt.staleLookups--, yt.previous) : yt.lookupsLie ? yt.believed : yt.playlists
          return json(200, { items: items(from[id]!).filter((it) => it.contentDetails.videoId === only) })
        }
        const start = Number(url.searchParams.get('pageToken') ?? 0)
        const all = items(yt.playlists[id]!)
        if (yt.brokenPositions.has(id) && all.length > 1) all[1]!.snippet.position = 0
        return json(200, {
          // Deliberately not in playlist order: the reader has to go by snippet.position.
          items: all.slice(start, start + 50).reverse(),
          ...(start + 50 < all.length ? { nextPageToken: String(start + 50) } : {}),
        })
      }
      yt.units += 50
      const body = JSON.parse(String(init!.body)) as { id: string; snippet: { playlistId: string; position: number; resourceId: { videoId: string } } }
      const pl = body.snippet.playlistId
      if (yt.manualSortRequired.has(pl)) return refuse(400, 'manualSortRequired')
      if (gone(body.snippet.resourceId.videoId)) return refuse(404, 'videoNotFound')
      const list = yt.playlists[pl]!
      const videoId = body.id.replace(/^item-/, '')
      const from = list.indexOf(videoId)
      const to = body.snippet.position
      if (from < 0 || videoId !== body.snippet.resourceId.videoId) return refuse(404, 'playlistItemNotFound')
      yt.previous[pl] = [...list]
      if (yt.semantics === 'swap') {
        list[from] = list[to]!
        list[to] = videoId
      } else if (yt.semantics !== 'ignored') {
        list.splice(from, 1)
        list.splice(yt.semantics === 'before' && from < to ? to - 1 : to, 0, videoId)
      }
      const b = yt.believed[pl]!
      b.splice(b.indexOf(videoId), 1)
      b.splice(to, 0, videoId)
      yt.moves.push({ playlistId: pl, videoId, position: to })
      return json(200, { id: body.id, snippet: yt.reply === 'none' ? {} : { position: to } })
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

const slept: number[] = []
const run = (env: Env, yt: ReturnType<typeof fakeYouTube>) =>
  runOrderPass(env, { log, fetcher: yt.fetch, accessToken: 'tok', trigger: 'test', sleep: async (ms) => void slept.push(ms) })
const NEWEST_FIRST = ['v6', 'v5', 'v4', 'v3', 'v2', 'v1']
const SORTED = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6']
const W_SORTED = ['w1', 'w2', 'w3']
const UNSORTED_COMBINED = ['w3', 'v6', 'v1', 'w1']
const T0 = Date.parse('2026-10-12T18:00:00Z')
const at = (ms: number) => vi.setSystemTime(new Date(ms))
const HOUR = 3600_000

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  at(T0)
  slept.length = 0
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
    for (const day of [0, 1, 8]) {
      at(T0 + day * 24 * HOUR)
      // No access token is handed in either: a paused pass must not even ask for one.
      expect(await runOrderPass(env, { log, fetcher: yt.fetch, trigger: 'test' })).toMatchObject({ read: 0, moved: 0, units: 0, stoppedBy: 'paused' })
    }
    expect(yt.calls).toEqual([])
    expect(yt.playlists.PLdj).toEqual(NEWEST_FIRST)
    expect(await orderUnitsUsedToday(env)).toBe(0)
  })

  it('still answers the dry run, and says what a budget would mean', async () => {
    const env = await makeEnv({ budget: 0 })
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED, PLall: UNSORTED_COMBINED })
    const r = await orderReport(env, { log, fresh: true, fetcher: yt.fetch, accessToken: 'tok' })
    // 5 moves, one run of them: a listing and the read-back of its first move on top.
    expect(r).toMatchObject({ fresh: true, dailyUnits: 0, estimate: { moves: 5, units: 253, days: null } })
    expect(r.daysAt).toEqual([
      { dailyUnits: 1000, days: 1 },
      { dailyUnits: 2000, days: 1 },
      { dailyUnits: 4000, days: 1 },
    ])
    expect(yt.moves).toEqual([])
  })

  it('refuses a budget too small to ever move anything, rather than behaving as paused without saying so', async () => {
    const env = await makeEnv({ budget: 0 })
    const r = await updateAppSettings(env, { playlists: { orderDailyUnits: 50 } })
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.issues.join(' ')).toMatch(/orderDailyUnits.*0 \(paused\) or at least 110/)
    expect((await updateAppSettings(env, { playlists: { orderDailyUnits: 110 } })).ok).toBe(true)
    expect(AppSettingsSchema.safeParse(DEFAULT_APP_SETTINGS).success).toBe(true)
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

  it('is left out by its id even if it turns up as a DJ playlist', async () => {
    const env = await makeEnv()
    await env.DB.prepare('INSERT INTO sub_sync (slug, playlist_id, artist_name) VALUES (?, ?, ?)').bind('odd', 'PLall', 'Odd').run()
    expect((await managedPlaylists(env)).map((p) => p.playlistId)).toEqual(['PLdj', 'PLdj2'])
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED, PLall: UNSORTED_COMBINED })
    await run(env, yt)
    expect(yt.calls.filter((c) => c.endsWith('PLall'))).toEqual([])
    expect(yt.playlists.PLall).toEqual(UNSORTED_COMBINED)
  })
})

describe('runOrderPass', () => {
  it('sorts a newest-first playlist by set date with the fewest moves and leaves a sorted one alone', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED })
    const r = await run(env, yt)
    expect(yt.playlists.PLdj).toEqual(SORTED)
    expect(yt.playlists.PLdj2).toEqual(W_SORTED)
    // Five moves (one entry stays), two listings, and the two lookups that read the first move back.
    expect(yt.moves).toHaveLength(5)
    expect(r).toMatchObject({ read: 2, moved: 5, units: 254, stoppedBy: null })
    expect(yt.units).toBe(254)
    expect(await orderUnitsUsedToday(env)).toBe(254)
    expect((await loadOrderState(env)).playlists.PLdj).toMatchObject({ items: 6, undated: 0, moves: 0, moved: 5, problem: null })

    // Idempotent: nothing is due, so the next tick makes no YouTube call at all.
    expect(await run(env, yt)).toMatchObject({ read: 0, moved: 0, units: 0 })
    expect(yt.units).toBe(254)
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

  it('never spends more than the daily unit budget, listings and lookups included, and picks up the next quota day', async () => {
    const env = await makeEnv({ budget: 120 })
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED })
    // One listing + 2 moves + 2 lookups = 103; a third move would pass 120.
    expect(await run(env, yt)).toMatchObject({ moved: 2, units: 103, stoppedBy: 'budget' })
    expect(await run(env, yt)).toMatchObject({ read: 0, moved: 0, units: 0, stoppedBy: 'budget' })
    expect(yt.units).toBe(103)

    at(T0 + 24 * HOUR)
    expect(await run(env, yt)).toMatchObject({ moved: 2, stoppedBy: 'budget' })
    expect(yt.units).toBeLessThanOrEqual(2 * 120)
  })

  it('stops on a daily-quota reply and does not call YouTube again until the quota day rolls over', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED })
    yt.refuseAfterUnits = 103
    expect(await run(env, yt)).toMatchObject({ moved: 2, stoppedBy: 'quota' })
    // Two moves landed; the playlist is a valid, partly sorted playlist.
    expect([...yt.playlists.PLdj!].sort()).toEqual(SORTED)
    const callsAfter = yt.calls.length
    expect(await run(env, yt)).toMatchObject({ read: 0, moved: 0, stoppedBy: 'quota' })
    expect(yt.calls).toHaveLength(callsAfter)
    expect((await orderReport(env, { log, accessToken: 'tok' })).quotaStoppedUntil).not.toBeNull()
    // The flag every YouTube writer shares is what holds it (lib/youtube-quota.ts).
    expect(await getQuotaOut(env)).not.toBeNull()

    // Midnight Pacific has passed and the quota is back.
    at(Date.parse('2026-10-13T08:00:00Z'))
    yt.refuseAfterUnits = Infinity
    await run(env, yt)
    expect(yt.playlists.PLdj).toEqual(SORTED)
  })

  it('ends only this run on a per-minute rate limit: the next tick tries again', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED })
    yt.refuseAfterUnits = 103
    yt.refuseWith = 'rateLimitExceeded'
    expect(await run(env, yt)).toMatchObject({ moved: 2, stoppedBy: 'rate_limit' })
    expect(await getQuotaOut(env)).toBeNull()
    expect((await orderReport(env, { log, accessToken: 'tok' })).quotaStoppedUntil).toBeNull()
    // Five minutes later, the same quota day.
    yt.refuseAfterUnits = Infinity
    at(T0 + 5 * 60_000)
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
    // Inserts into it stop trying a position as well.
    expect(await isNotManual(env, 'PLdj')).toBe(true)
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

  it('moves nothing in a playlist whose listing does not number its videos 0..n-1', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: ['w3', 'w1', 'w2'] })
    yt.brokenPositions.add('PLdj')
    const r = await run(env, yt)
    expect(yt.playlists.PLdj).toEqual(NEWEST_FIRST)
    expect(yt.moves.every((m) => m.playlistId === 'PLdj2')).toBe(true)
    expect(r.moved).toBe(1)
    const s = (await loadOrderState(env)).playlists.PLdj!
    expect(s.problem).toBe('unreadable')
    expect(s.detail).toMatch(/positions are not 0\.\.n-1/)
    // The dry run says the same and counts no moves for it.
    yt.brokenPositions.add('PLdj2')
    const rep = await orderReport(env, { log, fresh: true, fetcher: yt.fetch, accessToken: 'tok' })
    expect(rep.playlists.map((p) => 'problem' in p && p.problem)).toEqual(['unreadable', 'unreadable'])
  })

  it('reports set dates it cannot read as that, spends nothing and blames no playlist', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED })
    const prepare = env.DB.prepare.bind(env.DB)
    const spy = vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => {
      if (/FROM tracklists/.test(sql)) throw new Error('D1 down')
      return prepare(sql)
    })
    expect(await run(env, yt)).toMatchObject({ read: 0, moved: 0, units: 0, stoppedBy: 'no_keys' })
    expect(yt.calls).toEqual([])
    expect(await orderUnitsUsedToday(env)).toBe(0)
    expect((await loadOrderState(env)).playlists).toEqual({})
    spy.mockRestore()
    await run(env, yt)
    expect(yt.playlists.PLdj).toEqual(SORTED)
  })
})

describe('the pass reads its first move back', () => {
  it('stops a playlist after ONE move when the video is not where it was sent, whatever the update replied', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED })
    yt.semantics = 'before'
    // The reply repeats the request: only an independent read can tell.
    yt.reply = 'echo'
    const r = await run(env, yt)
    expect(r.moved).toBe(1)
    expect(yt.moves).toHaveLength(1)
    const s = (await loadOrderState(env)).playlists.PLdj!
    expect(s.problem).toBe('unexpected_position')
    expect(s.detail).toMatch(/the moved video should be at index 5 after a move to index 5 and is at index 4/)
    // It looked twice, a moment apart, before saying so.
    expect(slept).toEqual([1500])
    // Not tried again on the next ticks; a day later it is, by itself.
    at(T0 + 5 * 60_000)
    await run(env, yt)
    expect(yt.moves).toHaveLength(1)
    at(T0 + 25 * HOUR)
    await run(env, yt)
    expect(yt.moves).toHaveLength(2)
  })

  it('checks a neighbour too: a move that lands on the right index but shifts the others differently is caught', async () => {
    const env = await makeEnv()
    // v3 goes from the front to the end; a swap puts it at the right index and leaves v1 and v2 the wrong way round.
    const yt = fakeYouTube({ PLdj: ['v3', 'v1', 'v2'], PLdj2: W_SORTED })
    yt.semantics = 'swap'
    await run(env, yt)
    expect(yt.moves).toEqual([{ playlistId: 'PLdj', videoId: 'v3', position: 2 }])
    expect(yt.playlists.PLdj).toEqual(['v2', 'v1', 'v3'])
    const s = (await loadOrderState(env)).playlists.PLdj!
    expect(s.problem).toBe('unexpected_position')
    expect(s.detail).toMatch(/the video before it should be at index 1 .* and is at index 0/)
  })

  it('allows for a read that lags the write: one more look, then on with the run', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED })
    yt.staleLookups = 1
    // 2 listings + 5 moves + the stale lookup + the 2 that agree.
    expect(await run(env, yt)).toMatchObject({ moved: 5, units: 255 })
    expect(slept).toEqual([1500])
    expect(yt.playlists.PLdj).toEqual(SORTED)
    expect((await loadOrderState(env)).playlists.PLdj!.problem).toBeNull()
  })

  it('does not rely on the update reply at all', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED })
    yt.reply = 'none'
    expect(await run(env, yt)).toMatchObject({ moved: 5, units: 254 })
    expect(yt.lookups).toBe(2)
    expect(yt.playlists.PLdj).toEqual(SORTED)
  })

  it('stops a playlist whose moves change nothing even when every read-back agrees (no_progress)', async () => {
    const env = await makeEnv()
    await updateAppSettings(env, { playlists: { orderMovesPerRun: 3 } })
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED })
    yt.semantics = 'ignored'
    yt.lookupsLie = true
    expect(await run(env, yt)).toMatchObject({ moved: 3 })
    // The next reading finds the playlist needing as many moves as before those three.
    expect(await run(env, yt)).toMatchObject({ moved: 0 })
    expect(yt.moves).toHaveLength(3)
    expect((await loadOrderState(env)).playlists.PLdj).toMatchObject({ problem: 'no_progress', moves: 5 })
    await run(env, yt)
    expect(yt.moves).toHaveLength(3)
  })

  it('Retry now clears a stop so the next run tries again', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED })
    yt.semantics = 'before'
    await run(env, yt)
    expect((await loadOrderState(env)).playlists.PLdj!.problem).toBe('unexpected_position')
    yt.semantics = 'documented'
    at(T0 + 5 * 60_000)
    expect(await retryOrderPlaylist(env, 'PLdj')).toEqual({ ok: true })
    expect((await loadOrderState(env)).playlists.PLdj).toMatchObject({ problem: null, moves: 4 })
    await run(env, yt)
    expect(yt.playlists.PLdj).toEqual(SORTED)
    expect(await retryOrderPlaylist(env, 'PLnope')).toEqual({ ok: false, reason: 'not_found' })
  })

  it('Retry now on a playlist switched back to Manual also lets inserts use positions again', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED })
    yt.manualSortRequired.add('PLdj')
    await run(env, yt)
    expect(await isNotManual(env, 'PLdj')).toBe(true)
    yt.manualSortRequired.clear()
    await retryOrderPlaylist(env, 'PLdj')
    expect(await isNotManual(env, 'PLdj')).toBe(false)
    at(T0 + 5 * 60_000)
    await run(env, yt)
    expect(yt.playlists.PLdj).toEqual(SORTED)
  })

  it('Check now does not put off the daily retry of a stopped playlist', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED })
    yt.semantics = 'before'
    await run(env, yt)
    yt.semantics = 'documented'
    // 23 hours on, the owner looks.
    at(T0 + 23 * HOUR)
    const rep = await orderReport(env, { log, fresh: true, fetcher: yt.fetch, accessToken: 'tok' })
    expect(rep.playlists[0]).toMatchObject({ playlistId: 'PLdj', problem: 'unexpected_position' })
    await run(env, yt)
    expect(yt.moves).toHaveLength(1)
    // An hour and a bit later the day is up, counted from the stop and not from the look.
    at(T0 + 24 * HOUR + 5 * 60_000)
    await run(env, yt)
    expect(yt.playlists.PLdj).toEqual(SORTED)
  })
})

describe('a video that is gone from YouTube (deleted, or made private by its uploader)', () => {
  it('is never moved: the others are sorted around it, and nothing asks YouTube about it by its id', async () => {
    const env = await makeEnv()
    // `gone` is in no set of tracked's (the owner added it); v1..v3 are out of order around it.
    const yt = fakeYouTube({ PLdj: ['v3', 'gone', 'v2', 'v1'], PLdj2: W_SORTED })
    yt.dead.add('gone')
    const r = await run(env, yt)
    expect(yt.moves.map((m) => m.videoId)).not.toContain('gone')
    expect(yt.playlists.PLdj!.filter((v) => v !== 'gone')).toEqual(['v1', 'v2', 'v3'])
    expect(yt.playlists.PLdj).toContain('gone')
    expect(r).toMatchObject({ moved: 2, stoppedBy: null })
    expect((await loadOrderState(env)).playlists.PLdj).toMatchObject({ items: 4, moves: 0, problem: null })
    // Every unit is accounted for, and the next tick has nothing to do.
    expect(r.units).toBe(yt.units)
    expect(await run(env, yt)).toMatchObject({ read: 0, moved: 0, units: 0 })
  })

  it('a playlist whose only disorder is a dead video needs no moves, wherever the video is', async () => {
    const env = await makeEnv()
    // v9 is a set of the DJ (dated first of all) whose video died, sitting last.
    await env.DB.prepare('INSERT INTO tracklists (slug, url, position, discovered_at, processed, video_known, video_id) VALUES (?, ?, 9, 0, 1, 1, ?)').bind('dj', setUrl(99, '2020-01-01'), 'v9').run()
    const yt = fakeYouTube({ PLdj: ['v1', 'v2', 'v3', 'v9'], PLdj2: W_SORTED })
    yt.dead.add('v9')
    expect(await run(env, yt)).toMatchObject({ read: 2, moved: 0, units: 2 })
    expect((await loadOrderState(env)).playlists.PLdj).toMatchObject({ moves: 0, problem: null })
    expect((await orderReport(env, { log, fresh: true, fetcher: yt.fetch, accessToken: 'tok' })).totals).toMatchObject({ moves: 0 })
  })

  it('reads a move back from a listing when the neighbour it checks is the dead video', async () => {
    const env = await makeEnv()
    // v3 goes to the end of the dated ones, right in front of the dead video: the neighbour of the read-back.
    const yt = fakeYouTube({ PLdj: ['v3', 'v1', 'v2', 'gone'], PLdj2: W_SORTED })
    yt.dead.add('gone')
    const r = await run(env, yt)
    expect(yt.moves).toEqual([{ playlistId: 'PLdj', videoId: 'v3', position: 2 }])
    expect(yt.playlists.PLdj).toEqual(['v1', 'v2', 'v3', 'gone'])
    // No lookup by video id at all: listing + move + one listing as the read-back, and the other playlist's listing.
    expect(yt.lookups).toBe(0)
    expect(r).toMatchObject({ moved: 1, units: 53, stoppedBy: null })
    expect(r.units).toBe(yt.units)
    expect((await loadOrderState(env)).playlists.PLdj).toMatchObject({ moves: 0, problem: null })
  })

  it('the read-back by listing still catches a move that did something else', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: ['v3', 'v1', 'v2', 'gone'], PLdj2: W_SORTED })
    yt.dead.add('gone')
    yt.semantics = 'ignored'
    await run(env, yt)
    expect(yt.moves).toHaveLength(1)
    expect(slept).toEqual([1500])
    const s = (await loadOrderState(env)).playlists.PLdj!
    expect(s.problem).toBe('unexpected_position')
    expect(s.detail).toMatch(/the moved video should be at index 2 .* and is at index 0/)
  })

  it('a lookup that answers videoNotFound for a video the listing showed as there falls back to the listing: no move_failed', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: ['v3', 'v1', 'v2', 'hand'], PLdj2: W_SORTED })
    // `hand` (no set, so it stays last) lists like any video but is refused by id.
    yt.hiddenGone.add('hand')
    const r = await run(env, yt)
    expect(yt.playlists.PLdj).toEqual(['v1', 'v2', 'v3', 'hand'])
    // Listing + move + lookup of v3 + refused lookup of `hand` + the listing instead, and the other playlist.
    expect(r).toMatchObject({ moved: 1, units: 55, stoppedBy: null })
    expect(r.units).toBe(yt.units)
    expect((await loadOrderState(env)).playlists.PLdj).toMatchObject({ moves: 0, problem: null })
  })

  it('a move refused with videoNotFound is not a stop and is not paid for again: the item is planned around until Retry now', async () => {
    const env = await makeEnv()
    // v3 has to move and YouTube no longer finds it, though the listing shows it.
    const yt = fakeYouTube({ PLdj: ['v3', 'v1', 'v2'], PLdj2: W_SORTED })
    yt.hiddenGone.add('v3')
    const r = await run(env, yt)
    expect(r).toMatchObject({ moved: 0, units: 52, stoppedBy: null })
    expect(yt.moves).toEqual([])
    expect((await loadOrderState(env)).playlists.PLdj).toMatchObject({ moves: 0, problem: null, unmovable: [{ id: 'item-v3', at: Math.floor(T0 / 1000) }] })
    // Hours and days later it is read (1 unit a day) and never tried again.
    at(T0 + 2 * HOUR)
    expect(await run(env, yt)).toMatchObject({ read: 0, units: 0 })
    at(T0 + 25 * HOUR)
    expect(await run(env, yt)).toMatchObject({ read: 2, moved: 0, units: 2 })
    expect((await loadOrderState(env)).playlists.PLdj).toMatchObject({ moves: 0, problem: null, unmovable: [{ id: 'item-v3', at: Math.floor(T0 / 1000) }] })
    // The video is back; the owner asks for another try.
    yt.hiddenGone.clear()
    expect(await retryOrderPlaylist(env, 'PLdj')).toEqual({ ok: true })
    expect(await run(env, yt)).toMatchObject({ moved: 1 })
    expect(yt.playlists.PLdj).toEqual(['v1', 'v2', 'v3'])
    expect((await loadOrderState(env)).playlists.PLdj!.unmovable).toBeUndefined()
  })

  it('the report counts the videos that could not be moved, and one is forgotten after a week so its move is tried once more', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: ['v3', 'v1', 'v2'], PLdj2: W_SORTED })
    yt.hiddenGone.add('v3')
    await run(env, yt)
    const report = await orderReport(env, { log })
    expect(report.totals).toMatchObject({ unmovable: 1, moves: 0 })
    expect(report.playlists.find((p) => p.playlistId === 'PLdj')).toMatchObject({ unmovable: [{ id: 'item-v3' }] })
    // Six days of daily readings: left alone, 1 unit each for this playlist, no move paid for.
    for (let d = 1; d <= 6; d++) {
      at(T0 + d * 24 * HOUR + d * 60_000)
      expect(await run(env, yt)).toMatchObject({ moved: 0 })
    }
    expect(yt.units).toBe(52 + 6 * 2)
    expect((await orderReport(env, { log })).totals.unmovable).toBe(1)
    // A week on it is no longer counted, and the next reading tries the move again: still refused, remembered anew.
    at(T0 + 7 * 24 * HOUR + 10 * 60_000)
    expect((await orderReport(env, { log })).totals.unmovable).toBe(0)
    const before = yt.units
    expect(await run(env, yt)).toMatchObject({ moved: 0 })
    expect(yt.units - before).toBe(52)
    expect((await loadOrderState(env)).playlists.PLdj).toMatchObject({ moves: 0, problem: null, unmovable: [{ id: 'item-v3', at: Math.floor((T0 + 7 * 24 * HOUR + 10 * 60_000) / 1000) }] })
    // Or the video is back by then: the move is made and nothing is remembered.
    yt.hiddenGone.clear()
    at(T0 + 15 * 24 * HOUR)
    expect(await run(env, yt)).toMatchObject({ moved: 1 })
    expect(yt.playlists.PLdj).toEqual(['v1', 'v2', 'v3'])
    expect((await orderReport(env, { log })).totals.unmovable).toBe(0)
  })

  it('the state production has for FISHER (move_failed after a read-back that got videoNotFound, no moves left) clears on the next reading, with no move', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: ['v1', 'v2', 'v3', 'gone'], PLdj2: W_SORTED })
    yt.dead.add('gone')
    const now = Math.floor(T0 / 1000)
    await env.SUBS.put(
      'subs:playlist-order',
      JSON.stringify({
        playlists: {
          PLdj: { playlistId: 'PLdj', slug: 'dj', title: 'DJ (1001tklists)', items: 4, undated: 1, moves: 0, units: 0, checkedAt: now, moved: 1, problem: 'move_failed', detail: 'a move could not be read back: youtube playlistItems.list 404 videoNotFound: Video not found.', problemAt: now, lastRun: { needed: 1, applied: 1 } },
          PLdj2: { playlistId: 'PLdj2', slug: 'dj2', title: 'DJ 2 (1001tklists)', items: 3, undated: 0, moves: 0, units: 0, checkedAt: now, moved: 0 },
        },
      }),
    )
    // Inside the hour it is left alone.
    at(T0 + HOUR / 2)
    expect(await run(env, yt)).toMatchObject({ read: 0, units: 0 })
    at(T0 + HOUR + 1000)
    expect(await run(env, yt)).toMatchObject({ read: 1, moved: 0, units: 1, stoppedBy: null })
    expect(yt.moves).toEqual([])
    expect((await loadOrderState(env)).playlists.PLdj).toMatchObject({ moves: 0, problem: null, detail: null, lastRun: null })
  })
})

describe('one run at a time', () => {
  it('skips, with nothing read or moved, while another run holds the lock', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED })
    await env.CACHE.put('yt:order:lock', '1')
    expect(await run(env, yt)).toMatchObject({ read: 0, moved: 0, units: 0, stoppedBy: 'busy' })
    const rep = await orderReport(env, { log, fresh: true, fetcher: yt.fetch, accessToken: 'tok' })
    expect(rep).toMatchObject({ fresh: false, busy: true, unitsSpent: 0 })
    expect(yt.calls).toEqual([])
  })

  /** Every write and delete a KV sees, in order. */
  const watch = (kv: KVNamespace) => {
    const ops: string[] = []
    const put = kv.put.bind(kv)
    const del = kv.delete.bind(kv)
    kv.put = (async (k: string, ...rest: unknown[]) => (ops.push(`put ${k}`), (put as (...a: unknown[]) => Promise<void>)(k, ...rest))) as typeof kv.put
    kv.delete = (async (k: string) => (ops.push(`delete ${k}`), del(k))) as typeof kv.delete
    return ops
  }

  it('an enabled pass with nothing due takes no lock and writes nothing', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: SORTED, PLdj2: W_SORTED })
    expect(await run(env, yt)).toMatchObject({ read: 2, moved: 0 })
    const cache = watch(env.CACHE)
    const subs = watch(env.SUBS)
    yt.calls.length = 0
    // Every tick of the next hours: both playlists are sorted and were read today.
    for (const min of [5, 10, 300]) {
      at(T0 + min * 60_000)
      expect(await run(env, yt)).toMatchObject({ read: 0, moved: 0, units: 0, stoppedBy: null })
    }
    expect(cache).toEqual([])
    expect(subs).toEqual([])
    expect(yt.calls).toEqual([])
    // The daily look still happens, under the lock, and gives it back.
    at(T0 + 25 * HOUR)
    expect(await run(env, yt)).toMatchObject({ read: 2 })
    expect(cache.filter((o) => o.endsWith('yt:order:lock'))).toEqual(['put yt:order:lock', 'delete yt:order:lock'])
  })

  it('a paused pass writes nothing to KV either', async () => {
    const env = await makeEnv({ budget: 0 })
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED })
    const cache = watch(env.CACHE)
    const subs = watch(env.SUBS)
    await runOrderPass(env, { log, fetcher: yt.fetch, trigger: 'test' })
    expect(cache).toEqual([])
    expect(subs).toEqual([])
  })

  it('Retry now takes no lock, so a Move now right after it is not shut out, and it works while a run holds the lock', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED })
    yt.semantics = 'before'
    await run(env, yt)
    yt.semantics = 'documented'
    const cache = watch(env.CACHE)
    expect(await retryOrderPlaylist(env, 'PLdj')).toEqual({ ok: true })
    expect(cache.filter((o) => o.endsWith('yt:order:lock'))).toEqual([])
    expect(await run(env, yt)).toMatchObject({ stoppedBy: null })
    expect(yt.playlists.PLdj).toEqual(SORTED)
    // Another run's lock does not turn a retry away.
    await env.CACHE.put('yt:order:lock', JSON.stringify({ token: 'someone', at: Date.now() }))
    expect(await retryOrderPlaylist(env, 'PLdj')).toEqual({ ok: true })
  })

  it('a run that saves after a Retry now keeps what the retry cleared on a playlist it did not read', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: ['w3', 'w2', 'w1'] })
    yt.semantics = 'before'
    await run(env, yt)
    expect((await loadOrderState(env)).playlists.PLdj!.problem).toBe('unexpected_position')
    expect((await loadOrderState(env)).playlists.PLdj2!.problem).toBe('unexpected_position')
    yt.semantics = 'documented'
    await retryOrderPlaylist(env, 'PLdj2')
    // The pass works on PLdj2 (PLdj is still stopped); the owner retries PLdj while its moves are being made.
    let retried: Promise<unknown> | null = null
    const fetcher = (async (...a: Parameters<typeof fetch>) => {
      if ((a[1]?.method ?? 'GET') !== 'GET') retried ??= retryOrderPlaylist(env, 'PLdj')
      return yt.fetch(...a)
    }) as typeof fetch
    await runOrderPass(env, { log, fetcher, accessToken: 'tok', trigger: 'test', sleep: async () => {} })
    expect(await retried).toEqual({ ok: true })
    const st = await loadOrderState(env)
    expect(st.playlists.PLdj2).toMatchObject({ problem: null, moves: 0 })
    expect(st.playlists.PLdj!.problem).toBeNull()
  })

  it('Check now keeps a stop that Retry now cleared while it was reading cleared', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED })
    yt.semantics = 'before'
    await run(env, yt)
    let retried: Promise<unknown> | null = null
    const fetcher = (async (...a: Parameters<typeof fetch>) => {
      retried ??= retryOrderPlaylist(env, 'PLdj')
      return yt.fetch(...a)
    }) as typeof fetch
    await orderReport(env, { log, fresh: true, fetcher, accessToken: 'tok' })
    expect(await retried).toEqual({ ok: true })
    expect((await loadOrderState(env)).playlists.PLdj!.problem).toBeNull()
  })

  it('a KV that keeps answering "not set" for the lock does not make a run think it lost it: the stop is saved and the move is not paid for again', async () => {
    const env = await makeEnv()
    await updateAppSettings(env, { playlists: { orderMovesPerRun: 1 } })
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED })
    yt.semantics = 'before'
    // The key was read as absent just before it was written; KV goes on saying so.
    const get = env.CACHE.get.bind(env.CACHE)
    env.CACHE.get = (async (key: string, ...rest: unknown[]) => (key === 'yt:order:lock' ? null : (get as (...a: unknown[]) => Promise<unknown>)(key, ...rest))) as typeof env.CACHE.get
    const warn = vi.spyOn(log, 'warn')
    expect(await run(env, yt)).toMatchObject({ moved: 1 })
    expect(warn.mock.calls.map((c) => c[0])).not.toContain('playlist_order.lock_lost')
    expect((await loadOrderState(env)).playlists.PLdj).toMatchObject({ problem: 'unexpected_position' })
    // Tick after tick: the stopped playlist is left alone, so one move was paid for, not one a tick.
    for (const min of [5, 10, 15, 20]) {
      at(T0 + min * 60_000)
      await run(env, yt)
    }
    expect(yt.moves).toHaveLength(1)
    // And the lock is released (the raw store, since reads of it are blind here).
    expect((env.CACHE as ReturnType<typeof fakeKV>)._store.has('yt:order:lock')).toBe(false)
    warn.mockRestore()
  })

  it('release deletes only its own lock, and a lapsed lock is taken over and said so', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED })
    // The lock changes hands in the middle of the run (it lapsed and another run took it).
    const other = JSON.stringify({ token: 'other-run', at: T0 })
    const fetcher = (async (...a: Parameters<typeof fetch>) => {
      if ((a[1]?.method ?? 'GET') !== 'GET') await env.CACHE.put('yt:order:lock', other)
      return yt.fetch(...a)
    }) as typeof fetch
    const warn = vi.spyOn(log, 'warn')
    await runOrderPass(env, { log, fetcher, accessToken: 'tok', trigger: 'test', sleep: async () => {} })
    // Not deleted by the run that lost it, and that run's reading is not written over the newer one.
    expect(await env.CACHE.get('yt:order:lock')).toBe(other)
    expect(warn.mock.calls.map((c) => c[0])).toContain('playlist_order.lock_lost')
    expect((await loadOrderState(env)).playlists.PLdj).toBeUndefined()
    // Still inside its minute it holds; a minute and more after it was taken it has lapsed.
    at(T0 + 30_000)
    expect(await run(env, yt)).toMatchObject({ stoppedBy: 'busy' })
    at(T0 + 61_000)
    warn.mockClear()
    expect(await run(env, yt)).toMatchObject({ read: 2 })
    expect(warn.mock.calls.map((c) => c[0])).toContain('playlist_order.lock_lapsed')
    expect(await env.CACHE.get('yt:order:lock')).toBeNull()
    warn.mockRestore()
  })
})

describe('Retry now only takes a playlist that is ordered', () => {
  it('refuses an id that is no playlist id, an inherited key, and a playlist that is not managed', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED })
    await run(env, yt)
    const before = JSON.stringify(await loadOrderState(env))
    for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'PLall', 'PLnope', '', 'PL dj', 'a'.repeat(65), '../x']) {
      expect(await retryOrderPlaylist(env, id)).toEqual({ ok: false, reason: 'not_found' })
    }
    expect(JSON.stringify(await loadOrderState(env))).toBe(before)
    // A playlist of a DJ that is gone from sub_sync is no longer managed, even with an entry left in the state.
    await env.DB.prepare('DELETE FROM sub_sync WHERE slug = ?').bind('dj2').run()
    expect(await retryOrderPlaylist(env, 'PLdj2')).toEqual({ ok: false, reason: 'not_found' })
  })
})

describe('the dry run ends inside the lock', () => {
  it('stops at its deadline, keeps what it read, and says the reading is partial', async () => {
    const env = await makeEnv({ budget: 0 })
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: ['w3', 'w1', 'w2'] })
    // Each listing takes 30 s: the second playlist is not reached within 40.
    const slow = (async (...a: Parameters<typeof fetch>) => {
      at(Date.now() + 30_000)
      return yt.fetch(...a)
    }) as typeof fetch
    const r = await orderReport(env, { log, fresh: true, fetcher: slow, accessToken: 'tok', deadlineMs: 20_000 })
    expect(r).toMatchObject({ fresh: false, partial: true, busy: false, unitsSpent: 1 })
    expect(r.playlists[0]).toMatchObject({ playlistId: 'PLdj', moves: 5 })
    expect(r.playlists[1]).toMatchObject({ playlistId: 'PLdj2', checkedAt: null })
    expect(r.totals).toMatchObject({ playlists: 2, unread: 1 })
    expect(await env.CACHE.get('yt:order:lock')).toBeNull()
    // With time enough it is a whole reading.
    const full = await orderReport(env, { log, fresh: true, fetcher: yt.fetch, accessToken: 'tok' })
    expect(full).toMatchObject({ fresh: true, partial: false })
  })
})

describe('what a failed read-back is charged', () => {
  it('charges every lookup made before the one that threw, not a flat 1', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED })
    // The first look disagrees at its first lookup (lag), and the second look's second lookup fails: 1 listing + 50 + 3 lookups.
    yt.staleLookups = 1
    let lookups = 0
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).searchParams.get('videoId') && ++lookups === 3) {
        yt.units += 1
        return new Response(JSON.stringify({ error: { code: 400, errors: [{ reason: 'badRequest' }] } }), { status: 400, headers: { 'content-type': 'application/json' } })
      }
      return yt.fetch(input, init)
    }) as typeof fetch
    const r = await runOrderPass(env, { log, fetcher, accessToken: 'tok', trigger: 'test', sleep: async () => {} })
    expect(r).toMatchObject({ moved: 1 })
    expect(r.units).toBe(yt.units)
    // ...and the other playlist's listing: 1 + 50 + 3 + 1 (the flat charge made it 53).
    expect(r.units).toBe(55)
    expect((await loadOrderState(env)).playlists.PLdj).toMatchObject({ problem: 'move_failed' })
    expect(await orderUnitsUsedToday(env)).toBe(yt.units)
  })

  it('a second caller arriving in the middle of a run plans nothing from the stale listing', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED })
    let second: Promise<unknown> | null = null
    const inner = yt.fetch
    // "Move now" pressed while the cron pass is between its listing and its moves.
    const fetcher = (async (...a: Parameters<typeof fetch>) => {
      second ??= runOrderPass(env, { log, fetcher: inner, accessToken: 'tok', trigger: 'manual.order', sleep: async () => {} })
      return inner(...a)
    }) as typeof fetch
    const first = await runOrderPass(env, { log, fetcher, accessToken: 'tok', trigger: 'cron.tick', sleep: async () => {} })
    expect(await second).toMatchObject({ read: 0, moved: 0, stoppedBy: 'busy' })
    expect(first).toMatchObject({ moved: 5 })
    expect(yt.moves).toHaveLength(5)
    expect(yt.playlists.PLdj).toEqual(SORTED)
    // The lock is given back: the next run is not shut out.
    expect(await env.CACHE.get('yt:order:lock')).toBeNull()
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
    const env = await makeEnv({ budget: 150 })
    const yt = fakeYouTube({ PLdj: [...NEWEST_FIRST, 'hand'], PLdj2: ['w2', 'w1', 'w3'] })
    const before = JSON.stringify(yt.playlists)
    const r = await orderReport(env, { log, fresh: true, fetcher: yt.fetch, accessToken: 'tok' })
    expect(JSON.stringify(yt.playlists)).toBe(before)
    expect(yt.moves).toEqual([])
    expect(r).toMatchObject({ connected: true, fresh: true, busy: false, unitsSpent: 2, dailyUnits: 150 })
    expect(r.playlists.map((p) => [p.playlistId, 'items' in p && p.items, 'undated' in p && p.undated, 'moves' in p && p.moves, 'units' in p && p.units])).toEqual([
      ['PLdj', 7, 1, 5, 250],
      ['PLdj2', 3, 0, 1, 50],
    ])
    expect(r.totals).toEqual({ playlists: 2, unread: 0, items: 10, undated: 1, moves: 6, units: 300, unmovable: 0 })
    // 300 for the moves, and for each playlist one listing and one read-back: 306 units, 3 days at 150 a day.
    expect(r.estimate).toEqual({ moves: 6, units: 306, days: 3 })

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

  it('forgets that a playlist refused positions, so the next insert finds out again', async () => {
    const env = await makeEnv()
    const yt = fakeYouTube({ PLdj: NEWEST_FIRST, PLdj2: W_SORTED })
    await noteNotManual(env, 'PLdj')
    await orderReport(env, { log, fetcher: yt.fetch, accessToken: 'tok' })
    expect(await isNotManual(env, 'PLdj')).toBe(true)
    await orderReport(env, { log, fresh: true, fetcher: yt.fetch, accessToken: 'tok' })
    expect(await isNotManual(env, 'PLdj')).toBe(false)
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
