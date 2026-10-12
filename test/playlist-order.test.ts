import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  applyMoves,
  compareOrder,
  estimateDays,
  insertPosition,
  orderKeyOfSet,
  orderKeysByVideo,
  orderNeed,
  planMoves,
  setHappenedOn,
  UNDATED,
  type OrderKey,
} from '../src/lib/playlist-order'
import { fakeD1 } from './helpers/fake-d1'
import { fakeKV } from './helpers/fake-kv'
import type { Env } from '../src/types'
import { makeLogger } from '../src/lib/log'

vi.mock('../src/lib/youtube-playlists', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/youtube-playlists')>('../src/lib/youtube-playlists')
  return { ...actual, addVideoToPlaylist: vi.fn() }
})
import { addVideoToPlaylist, YouTubeApiError } from '../src/lib/youtube-playlists'
import { insertInOrder, isNotManual, loadOrderKeys, orderKeyFor, type OrderKeyCache } from '../src/lib/playlist-order-store'
import { saveCombinedState } from '../src/lib/combined-playlist'

const T = 'https://www.1001tracklists.com/tracklist'
const set = (id: string, slug: string) => `${T}/${id}/${slug}.html`

describe('setHappenedOn', () => {
  it('reads the date a set URL ends in', () => {
    expect(setHappenedOn(set('1a', 'gorgon-city-perry-s-stage-lollapalooza-brazil-2023-03-24'))).toBe('2023-03-24')
    expect(setHappenedOn(`${set('1a', 'fisher-club-space-miami-2024-01-02')}?utm=1#top`)).toBe('2024-01-02')
  })

  it('takes the earlier of two dates: the set happened on the first, the radio show aired on the second', () => {
    expect(setHappenedOn(set('2b', 'adam-beyer-drumcode-radio-720-resistance-stage-ultra-music-festival-chile-2024-04-20-2024-05-22'))).toBe('2024-04-20')
    // Whichever way round they are written.
    expect(setHappenedOn(set('2c', 'some-show-2024-05-22-2024-04-20'))).toBe('2024-04-20')
    expect(setHappenedOn(set('2d', 'fisher-bbc-radio-1-in-ibiza-528-ibiza-spain-2023-07-28-2023-07-28'))).toBe('2023-07-28')
  })

  it('only reads the dates the slug ends in, and only real ones', () => {
    expect(setHappenedOn(set('3c', 'nye-2019-12-31-countdown-club-x-2020-01-05'))).toBe('2020-01-05')
    expect(setHappenedOn(set('3d', 'maddix-radio-762'))).toBeNull()
    expect(setHappenedOn(set('3e', 'broken-2024-13-45'))).toBeNull()
    expect(setHappenedOn(set('3f', 'half-broken-2024-02-30-2024-03-09'))).toBe('2024-03-09')
    expect(setHappenedOn('not a url')).toBeNull()
  })

  it('does not take a number that only looks like a date for one: nothing before 1990', () => {
    // A catalogue number in front of the real date must not sort the set first.
    expect(setHappenedOn(set('4a', 'label-night-1000-01-21-2024-03-09'))).toBe('2024-03-09')
    expect(setHappenedOn(set('4b', 'some-show-0000-01-01'))).toBeNull()
    expect(setHappenedOn(set('4c', 'old-tape-1989-12-31'))).toBeNull()
    expect(setHappenedOn(set('4d', 'old-tape-1990-01-01'))).toBe('1990-01-01')
  })
})

const k = (date: string | null, name = 'a', url = name): OrderKey => ({ date, name, url })

describe('compareOrder', () => {
  it('orders by date, earliest first', () => {
    expect(compareOrder(k('2023-01-01'), k('2024-01-01'))).toBeLessThan(0)
    expect(compareOrder(k('2024-01-01'), k('2023-12-31'))).toBeGreaterThan(0)
  })

  it('puts undated entries after every dated one and leaves them as they are among themselves', () => {
    expect(compareOrder(UNDATED, k('2099-01-01'))).toBeGreaterThan(0)
    expect(compareOrder(k('1999-01-01'), UNDATED)).toBeLessThan(0)
    expect(compareOrder(UNDATED, UNDATED)).toBe(0)
  })

  it('settles a shared date by the set slug, then the URL, the same way every time', () => {
    const a = orderKeyOfSet(set('zz9', 'adam-beyer-awakenings-2024-06-29'))
    const b = orderKeyOfSet(set('aa1', 'charlotte-de-witte-awakenings-2024-06-29'))
    expect(compareOrder(a, b)).toBeLessThan(0)
    expect(compareOrder(b, a)).toBeGreaterThan(0)
    // The same slug under two ids: the URL decides.
    const c = orderKeyOfSet(set('aa1', 'adam-beyer-awakenings-2024-06-29'))
    expect(compareOrder(c, a)).toBeLessThan(0)
    expect(compareOrder(a, a)).toBe(0)
  })
})

describe('orderKeysByVideo', () => {
  it('gives a video several sets resolve to the key that goes first, and skips rows without a video', () => {
    const keys = orderKeysByVideo([
      { url: set('1', 'b-side-2024-05-02'), videoId: 'v1' },
      { url: set('2', 'a-side-2024-05-01'), videoId: 'v1' },
      { url: set('3', 'no-video-2024-05-01'), videoId: null },
    ])
    expect(keys.get('v1')?.date).toBe('2024-05-01')
    expect(keys.size).toBe(1)
  })
})

describe('insertPosition', () => {
  const sorted = [k('2022-01-01'), k('2023-01-01'), k('2024-01-01'), UNDATED]

  it('is the place the entry has once the playlist is sorted', () => {
    expect(insertPosition(sorted, k('2021-06-01'))).toBe(0)
    expect(insertPosition(sorted, k('2023-06-01'))).toBe(2)
    // After the last dated set, before the undated ones.
    expect(insertPosition(sorted, k('2025-01-01'))).toBe(3)
  })

  it('goes after an entry it ties with', () => {
    expect(insertPosition(sorted, k('2023-01-01'))).toBe(2)
  })

  it('appends (no position) an undated entry, and one that belongs last', () => {
    expect(insertPosition(sorted, UNDATED)).toBeNull()
    expect(insertPosition(sorted.slice(0, 3), k('2025-01-01'))).toBeNull()
    expect(insertPosition([], k('2025-01-01'))).toBeNull()
  })

  it('counts membership, not the current order, so an unsorted playlist gets the same answer', () => {
    expect(insertPosition([...sorted].reverse(), k('2023-06-01'))).toBe(2)
  })
})

const item = (id: string, date: string | null, name = id) => ({ id, key: k(date, name) })
const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id)

/** Deterministic pseudo-random numbers, so a failing case can be reproduced. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** Length of the longest already-ordered subsequence, the slow obvious way. */
function longestOrdered(items: Array<{ key: OrderKey }>): number {
  const best = items.map(() => 1)
  for (let i = 0; i < items.length; i++) for (let j = 0; j < i; j++) if (compareOrder(items[j]!.key, items[i]!.key) <= 0) best[i] = Math.max(best[i]!, best[j]! + 1)
  return Math.max(0, ...best)
}

describe('planMoves', () => {
  it('needs nothing for a playlist already in order', () => {
    const items = [item('a', '2022-01-01'), item('b', '2023-01-01'), item('c', null), item('d', null)]
    expect(planMoves(items).moves).toEqual([])
    expect(planMoves([]).moves).toEqual([])
  })

  it('moves only the entry that is out of place', () => {
    // c (the newest) sits first; one move to the end fixes it, not two moves of a and b.
    const items = [item('c', '2024-01-01'), item('a', '2022-01-01'), item('b', '2023-01-01')]
    const plan = planMoves(items)
    expect(plan.moves).toEqual([{ id: 'c', position: 2 }])
    expect(applyMoves(ids(items), plan.moves)).toEqual(['a', 'b', 'c'])
  })

  it('gives each move the index the entry has after the moves before it', () => {
    const items = [item('d', '2024-01-01'), item('c', '2023-01-01'), item('b', '2022-01-01'), item('a', '2021-01-01')]
    const plan = planMoves(items)
    // Newest first is the worst case: every entry but one moves.
    expect(plan.moves).toHaveLength(3)
    expect(applyMoves(ids(items), plan.moves)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('never moves a fixed entry: the others are sorted around it with the fewest moves, and a cut-short plan still only needs the rest', () => {
    const fixed = (id: string, date: string | null) => ({ ...item(id, date), fixed: true })
    // Out of place by its own date, and alone in the way of nothing: no moves.
    expect(planMoves([item('a', '2022-01-01'), fixed('x', '2020-01-01'), item('b', '2023-01-01'), fixed('y', null), item('c', '2024-01-01')]).moves).toEqual([])
    const items = [item('c', '2024-01-01'), fixed('x', '2020-01-01'), item('b', '2023-01-01'), fixed('y', null), item('a', '2022-01-01')]
    const plan = planMoves(items)
    expect(plan.moves).toHaveLength(2)
    expect(plan.moves.map((m) => m.id)).not.toContain('x')
    expect(plan.moves.map((m) => m.id)).not.toContain('y')
    expect(ids(plan.sorted)).toEqual(['a', 'b', 'c'])
    const after = applyMoves(ids(items), plan.moves)
    expect(after.filter((id) => id !== 'x' && id !== 'y')).toEqual(['a', 'b', 'c'])
    expect(after).toHaveLength(5)
    // One move made, then planned again from what is there: exactly one more.
    const partly = applyMoves(ids(items), plan.moves.slice(0, 1))
    const byId = new Map(items.map((it) => [it.id, it]))
    const rest = planMoves(partly.map((id) => byId.get(id)!))
    expect(rest.moves).toHaveLength(1)
    expect(applyMoves(partly, rest.moves).filter((id) => id !== 'x' && id !== 'y')).toEqual(['a', 'b', 'c'])
  })

  it('keeps tied and undated entries in the order they have', () => {
    const items = [item('u1', null), item('x', '2024-01-01', 'same'), item('u2', null), item('y', '2024-01-01', 'same'), item('old', '2020-01-01')]
    const plan = planMoves(items)
    expect(ids(plan.sorted)).toEqual(['old', 'x', 'y', 'u1', 'u2'])
    expect(applyMoves(ids(items), plan.moves)).toEqual(['old', 'x', 'y', 'u1', 'u2'])
  })

  it('applied in sequence yields the sorted order with the fewest moves, for any playlist', () => {
    const rand = rng(20261011)
    for (let round = 0; round < 300; round++) {
      const n = Math.floor(rand() * 40)
      const items = Array.from({ length: n }, (_, i) => {
        const r = rand()
        // A few undated entries and plenty of shared dates.
        const date = r < 0.1 ? null : `2024-01-${String(1 + Math.floor(rand() * 12)).padStart(2, '0')}`
        return item(`i${i}`, date, rand() < 0.5 ? 'same' : `n${Math.floor(rand() * 4)}`)
      })
      const plan = planMoves(items)
      const after = applyMoves(ids(items), plan.moves)
      expect(after).toEqual(ids(plan.sorted))
      // In order, and nothing lost.
      const byId = new Map(items.map((x) => [x.id, x]))
      for (let i = 1; i < after.length; i++) expect(compareOrder(byId.get(after[i - 1]!)!.key, byId.get(after[i]!)!.key)).toBeLessThanOrEqual(0)
      expect([...after].sort()).toEqual(ids(items).sort())
      expect(plan.moves).toHaveLength(n - longestOrdered(items))
    }
  })

  it('is resumable: after any prefix of the plan, planning again needs exactly the rest', () => {
    const rand = rng(7)
    for (let round = 0; round < 60; round++) {
      const items = Array.from({ length: 25 }, (_, i) => item(`i${i}`, `2024-02-${String(1 + Math.floor(rand() * 28)).padStart(2, '0')}`, `n${i}`))
      const plan = planMoves(items)
      const done = Math.floor(rand() * (plan.moves.length + 1))
      const byId = new Map(items.map((x) => [x.id, x]))
      const partly = applyMoves(ids(items), plan.moves.slice(0, done)).map((id) => byId.get(id)!)
      const rest = planMoves(partly)
      expect(rest.moves).toHaveLength(plan.moves.length - done)
      expect(applyMoves(ids(partly), rest.moves)).toEqual(ids(plan.sorted))
    }
  })
})

describe('orderNeed / estimateDays', () => {
  it('counts entries, undated ones, moves and their units', () => {
    expect(orderNeed([item('c', '2024-01-01'), item('a', '2022-01-01'), item('u', null), item('b', '2023-01-01')])).toEqual({ items: 4, undated: 1, moves: 2, units: 100 })
  })

  it('adds one listing per run of moves and divides by the daily budget', () => {
    // 25 moves, 10 a run = 3 runs, each a listing of a 120-entry playlist (3 pages) and a 2-unit read-back, on top of 25 x 50.
    expect(estimateDays([{ items: 120, undated: 0, moves: 25, units: 1250 }], 500, 10)).toEqual({ units: 1265, days: 3 })
    expect(estimateDays([{ items: 120, undated: 0, moves: 0, units: 0 }], 500, 10)).toEqual({ units: 0, days: 0 })
    expect(estimateDays([{ items: 5, undated: 0, moves: 1, units: 50 }], 0, 10).days).toBe(Infinity)
  })
})

// ─── the insert every playlist addition goes through ────────────────────────

const log = makeLogger({ task: 'test' })
const add = addVideoToPlaylist as ReturnType<typeof vi.fn>

async function envWithSets(rows: Array<[slug: string, url: string, videoId: string | null]>): Promise<Env> {
  const env = { CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k' } as unknown as Env
  let position = 0
  for (const [slug, url, videoId] of rows) {
    await env.DB.prepare('INSERT INTO tracklists (slug, url, position, discovered_at, processed, video_known, video_id) VALUES (?, ?, ?, 0, 1, 1, ?)').bind(slug, url, position++, videoId).run()
  }
  return env
}

describe('insertInOrder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    add.mockResolvedValue(undefined)
  })

  const rows: Array<[string, string, string | null]> = [
    ['dj', set('1', 'dj-club-2022-01-01'), 'v2022'],
    ['dj', set('2', 'dj-club-2023-01-01'), 'v2023'],
    ['dj', set('3', 'dj-club-2024-01-01'), 'v2024'],
  ]

  it('inserts at the position the set date gives the video, from the set URL alone', async () => {
    const env = await envWithSets(rows)
    // The new set's tracklists row does not carry the video yet (the sync writes it after the insert).
    const r = await insertInOrder(env, { playlistId: 'PL', videoId: 'vNew', existing: ['v2024', 'v2022', 'v2023'], accessToken: 'tok', log, setUrl: set('9', 'dj-radio-800-2022-06-01-2023-06-01') })
    expect(r).toEqual({ position: 1, attempts: 1 })
    expect(add).toHaveBeenCalledWith('PL', 'vNew', 'tok', undefined, { position: 1 })
  })

  it('appends, with the call it always made, a video that belongs last or has no date', async () => {
    const env = await envWithSets(rows)
    await insertInOrder(env, { playlistId: 'PL', videoId: 'vNew', existing: ['v2022', 'v2023', 'v2024'], accessToken: 'tok', log, setUrl: set('9', 'dj-club-2025-01-01') })
    await insertInOrder(env, { playlistId: 'PL', videoId: 'vHand', existing: ['v2022', 'v2023', 'v2024'], accessToken: 'tok', log })
    expect(add.mock.calls).toEqual([
      ['PL', 'vNew', 'tok'],
      ['PL', 'vHand', 'tok'],
    ])
  })

  it('finds the date of a video in D1 when the caller names no set, and reads D1 once per run', async () => {
    const env = await envWithSets([...rows, ['dj', set('4', 'dj-club-2022-06-01'), 'vBackfilled']])
    const cache = {}
    const r = await insertInOrder(env, { playlistId: 'PL', videoId: 'vBackfilled', existing: new Set(['v2022', 'v2023', 'v2024', 'vUnknown']), accessToken: 'tok', log, cache })
    expect(r.position).toBe(1)
    const spy = vi.spyOn(env.DB, 'prepare')
    await insertInOrder(env, { playlistId: 'PL', videoId: 'v2023', existing: ['v2022', 'v2024'], accessToken: 'tok', log, cache })
    expect(spy).not.toHaveBeenCalled()
    expect(add).toHaveBeenLastCalledWith('PL', 'v2023', 'tok', undefined, { position: 1 })
  })

  it('tries once more without a position when YouTube refuses the position', async () => {
    const env = await envWithSets(rows)
    add.mockRejectedValueOnce(new YouTubeApiError('playlistItems.insert', 400, 'invalidPlaylistItemPosition', '{}'))
    const r = await insertInOrder(env, { playlistId: 'PL', videoId: 'vNew', existing: ['v2022', 'v2023', 'v2024'], accessToken: 'tok', log, setUrl: set('9', 'dj-club-2021-01-01') })
    expect(r).toEqual({ position: null, attempts: 2 })
    expect(add.mock.calls).toEqual([
      ['PL', 'vNew', 'tok', undefined, { position: 0 }],
      ['PL', 'vNew', 'tok'],
    ])
  })

  it('remembers a playlist that is not on manual order: the next inserts are appended for 50 units, not 100', async () => {
    const env = await envWithSets(rows)
    const older = (n: number) => ({ playlistId: 'PL', videoId: `vNew${n}`, existing: ['v2022', 'v2023', 'v2024'], accessToken: 'tok', log, setUrl: set(`9${n}`, 'dj-club-2021-01-01') })
    add.mockRejectedValueOnce(new YouTubeApiError('playlistItems.insert', 400, 'manualSortRequired', '{}'))
    expect(await insertInOrder(env, older(1))).toEqual({ position: null, attempts: 2 })
    expect(await isNotManual(env, 'PL')).toBe(true)
    add.mockClear()
    expect(await insertInOrder(env, older(2))).toEqual({ position: null, attempts: 1 })
    expect(add.mock.calls).toEqual([['PL', 'vNew2', 'tok']])
    // Another playlist is not affected, and a position past the end is not remembered at all.
    add.mockClear()
    add.mockRejectedValueOnce(new YouTubeApiError('playlistItems.insert', 400, 'invalidPlaylistItemPosition', '{}'))
    await insertInOrder(env, { ...older(3), playlistId: 'PLother' })
    expect(await isNotManual(env, 'PLother')).toBe(false)
    expect(add.mock.calls[0]).toEqual(['PLother', 'vNew3', 'tok', undefined, { position: 0 }])
    // The memory lapses (a day's TTL in KV): the insert after that tries a position again.
    await env.CACHE.delete('yt:order:notmanual:PL')
    add.mockClear()
    expect((await insertInOrder(env, older(4))).position).toBe(0)
  })

  it('a run with several inserts asks KV once: the combined id and the not-manual memory are kept in the run cache', async () => {
    const env = await envWithSets(rows)
    await saveCombinedState(env, { playlistId: 'PLcombined' })
    const subsGet = vi.spyOn(env.SUBS, 'get')
    const cacheGet = vi.spyOn(env.CACHE, 'get')
    const cache: OrderKeyCache = {}
    const older = (n: number, playlistId = 'PL') => ({ playlistId, videoId: `vNew${n}`, existing: ['v2022', 'v2023', 'v2024'], accessToken: 'tok', log, setUrl: set(`9${n}`, 'dj-club-2021-01-01'), cache })
    for (let n = 1; n <= 4; n++) expect((await insertInOrder(env, older(n))).position).toBe(0)
    expect(subsGet).toHaveBeenCalledTimes(1)
    expect(cacheGet.mock.calls.filter((c) => String(c[0]).startsWith('yt:order:notmanual:'))).toHaveLength(1)
    // Another playlist is its own question; the combined one needs none.
    await insertInOrder(env, older(5, 'PLother'))
    expect((await insertInOrder(env, older(6, 'PLcombined'))).position).toBeNull()
    expect(subsGet).toHaveBeenCalledTimes(1)
    expect(cacheGet.mock.calls.filter((c) => String(c[0]).startsWith('yt:order:notmanual:'))).toHaveLength(2)
    // A refusal learnt in this run is remembered in it: the next insert is appended without asking KV again.
    add.mockClear()
    add.mockRejectedValueOnce(new YouTubeApiError('playlistItems.insert', 400, 'manualSortRequired', '{}'))
    expect(await insertInOrder(env, older(7))).toEqual({ position: null, attempts: 2 })
    add.mockClear()
    expect(await insertInOrder(env, older(8))).toEqual({ position: null, attempts: 1 })
    expect(add.mock.calls).toEqual([['PL', 'vNew8', 'tok']])
    expect(cacheGet.mock.calls.filter((c) => String(c[0]).startsWith('yt:order:notmanual:'))).toHaveLength(2)
  })

  it('never sends a position for the combined playlist, whoever calls', async () => {
    const env = await envWithSets(rows)
    await saveCombinedState(env, { playlistId: 'PLcombined' })
    const r = await insertInOrder(env, { playlistId: 'PLcombined', videoId: 'vNew', existing: ['v2022', 'v2023', 'v2024'], accessToken: 'tok', log, setUrl: set('9', 'dj-club-2021-01-01') })
    expect(r).toEqual({ position: null, attempts: 1 })
    expect(add.mock.calls).toEqual([['PLcombined', 'vNew', 'tok']])
  })

  it('does not retry any other failure', async () => {
    const env = await envWithSets(rows)
    add.mockRejectedValueOnce(new YouTubeApiError('playlistItems.insert', 403, 'quotaExceeded', '{}'))
    await expect(insertInOrder(env, { playlistId: 'PL', videoId: 'vNew', existing: ['v2022'], accessToken: 'tok', log, setUrl: set('9', 'dj-club-2021-01-01') })).rejects.toBeInstanceOf(YouTubeApiError)
    expect(add).toHaveBeenCalledTimes(1)
  })

  it('appends when the keys cannot be read', async () => {
    const env = await envWithSets(rows)
    vi.spyOn(env.DB, 'prepare').mockImplementation(() => {
      throw new Error('D1 down')
    })
    const r = await insertInOrder(env, { playlistId: 'PL', videoId: 'vNew', existing: ['v2022'], accessToken: 'tok', log, setUrl: set('9', 'dj-club-2021-01-01') })
    expect(r.position).toBeNull()
    expect(add).toHaveBeenCalledWith('PL', 'vNew', 'tok')
  })
})

describe('orderKeyFor / loadOrderKeys', () => {
  it('prefers whichever of the named set and the known sets goes first', async () => {
    const env = await envWithSets([['dj', set('1', 'dj-club-2022-01-01'), 'v']])
    const keys = await loadOrderKeys(env)
    expect(orderKeyFor(keys, 'v', set('2', 'dj-radio-2023-01-01')).date).toBe('2022-01-01')
    expect(orderKeyFor(keys, 'v', set('2', 'dj-radio-2021-01-01')).date).toBe('2021-01-01')
    expect(orderKeyFor(keys, 'other', null)).toEqual(UNDATED)
  })
})
