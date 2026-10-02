import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeD1 } from './helpers/fake-d1'
import { fakeKV } from './helpers/fake-kv'
import type { Env } from '../src/types'
import { DEFAULT_POOL_SETTINGS, type PoolSettings } from '../src/lib/pool-settings'
import { attemptBackoffSeconds, claimSetAttempt, ENSURE_STAMP_KEY, ensureSetSchedules, markSetDue, MAX_SET_ATTEMPTS_PER_DAY, pickTickItems, runSchedulerTick, scheduleAfterFetch, TICK_BACKOFF_KEY } from '../src/lib/fetch-scheduler'
import { loadDjBackfill, loadSubState, saveDjBackfill, saveSubState } from '../src/lib/sync-store'
import { noteSetFetch } from '../src/lib/verification'
import { setPause, _resetTallyForTests } from '../src/lib/ban-state'
import { PoolPausedError } from '../src/lib/pool'

// Network edges stubbed; the scheduler, syncOne, D1 and the verification
// logic run for real.
vi.mock('../src/lib/dj-index', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/dj-index')>('../src/lib/dj-index')
  return { ...actual, fetch1001Html: vi.fn(), crawlDjIndex: vi.fn(), djScrollStep: vi.fn(), parseSetYouTubeId: vi.fn() }
})
vi.mock('../src/lib/youtube-playlists', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/youtube-playlists')>('../src/lib/youtube-playlists')
  return { ...actual, findPlaylistByTitle: vi.fn(), createPlaylist: vi.fn(), listPlaylistVideoIds: vi.fn(), addVideoToPlaylist: vi.fn(), removeVideoFromPlaylist: vi.fn() }
})
// The full-recording gate (W6) looks page videos up with videos.list: no network.
vi.mock('../src/lib/video-meta', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/video-meta')>('../src/lib/video-meta')
  return { ...actual, getVideoMeta: vi.fn(async () => new Map()) }
})
import { crawlDjIndex, djScrollStep, fetch1001Html, parseSetYouTubeId } from '../src/lib/dj-index'
import { findPlaylistByTitle, listPlaylistVideoIds } from '../src/lib/youtube-playlists'

const H = 3600
const D = 24 * H
const NOW = Math.floor(Date.now() / 1000)
const day = (daysAgo: number) => new Date((NOW - daysAgo * D) * 1000).toISOString().slice(0, 10)
const setUrl = (id: string, daysAgo: number) => `https://www.1001tracklists.com/tracklist/${id}/dj-set-${day(daysAgo)}.html`
const mocked = (f: unknown) => f as ReturnType<typeof vi.fn>

function makeEnv(extra: Partial<Env> = {}): Env {
  return { CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k', TLPOOL_URL: 'https://tlpool.example', TLPOOL_TOKEN: 'pt', ...extra } as Env
}

async function subscribe(env: Env, ...slugs: string[]) {
  let i = 0
  for (const slug of slugs) {
    await env.DB.prepare('INSERT INTO subscriptions (slug, source_url, added_at, position) VALUES (?, ?, ?, ?)').bind(slug, `https://www.1001tracklists.com/dj/${slug}/`, 0, i++).run()
  }
  await env.SUBS.put('subs:migrated', '{}')
  await env.SUBS.put('oauth:google', JSON.stringify({ accessToken: 'tok', refreshToken: 'r', expiresAt: NOW + 3600, scope: 's', channelId: null, channelTitle: null, connectedAt: 0 }))
}

/** Put every DJ's discovery / backfill far in the future so a test controls exactly what is due. */
async function quietDjs(env: Env, ...slugs: string[]) {
  for (const s of slugs) await env.DB.prepare('INSERT OR REPLACE INTO dj_schedule (slug, next_discovery_at, next_backfill_at, updated_at) VALUES (?, ?, ?, ?)').bind(s, NOW + 30 * D, NOW + 30 * D, NOW).run()
}

beforeEach(() => {
  vi.resetAllMocks()
  _resetTallyForTests()
  mocked(fetch1001Html).mockResolvedValue({ html: '<set/>', via: 'pool', state: { cookie: '' }, accountId: 'acct-9', fetchedAt: new Date().toISOString() })
  mocked(listPlaylistVideoIds).mockImplementation(async () => new Set<string>())
  mocked(findPlaylistByTitle).mockResolvedValue({ id: 'PL', title: 'x' })
  mocked(parseSetYouTubeId).mockReturnValue(null)
})

describe('spreading the backlog (the ~2,100 known sets must not all come due together)', () => {
  it('overdue sets get a random due time inside one interval, created in batches', async () => {
    const env = makeEnv()
    await subscribe(env, 'dj')
    const urls = Array.from({ length: 2100 }, (_, i) => setUrl(`s${i}`, 3 + (i % 400)))
    await saveSubState(env, 'dj', {
      discoveredTracklistUrls: urls,
      processedTracklistUrls: urls,
      tracklistVideos: Object.fromEntries(urls.map((u) => [u, { videoId: 'vid00000001', checkedAt: NOW - 60 * D }])),
    })
    let created = 0
    for (let pass = 0; pass < 10; pass++) {
      const n = await ensureSetSchedules(env, DEFAULT_POOL_SETTINGS, NOW)
      if (n === 0) break
      expect(n).toBeLessThanOrEqual(500)
      created += n
    }
    expect(created).toBe(2100)
    const rows = (await env.DB.prepare('SELECT url, next_due_at FROM set_schedule').all<{ url: string; next_due_at: number | null }>()).results
    // Old sets of unknown ID status get the 90-day exception at first; none is "never" before its first fetch.
    expect(rows.every((r) => r.next_due_at !== null && r.next_due_at >= NOW && r.next_due_at <= NOW + 90 * D)).toBe(true)
    const dueInFirstHour = rows.filter((r) => r.next_due_at! <= NOW + H).length
    expect(dueInFirstHour).toBeLessThan(2100 * 0.05)
    // A 3-day-old set (1-day band) is due within a day; nothing piles onto one tick.
    const young = rows.find((r) => r.url === urls[0])!
    expect(young.next_due_at! - NOW).toBeLessThanOrEqual(D)
    const perFiveMinutes = new Map<number, number>()
    for (const r of rows) perFiveMinutes.set(Math.floor((r.next_due_at! - NOW) / 300), (perFiveMinutes.get(Math.floor((r.next_due_at! - NOW) / 300)) ?? 0) + 1)
    expect(Math.max(...perFiveMinutes.values())).toBeLessThan(40)
  })

  it('a set not yet overdue keeps its natural (jittered) due time', async () => {
    const env = makeEnv()
    await subscribe(env, 'dj')
    const u = setUrl('a', 20) // 7-30 d band: 5 days
    await saveSubState(env, 'dj', { discoveredTracklistUrls: [u], processedTracklistUrls: [u], tracklistVideos: { [u]: { videoId: 'v', checkedAt: NOW - D } } })
    await ensureSetSchedules(env, DEFAULT_POOL_SETTINGS, NOW, () => 0.5)
    const row = await env.DB.prepare('SELECT next_due_at FROM set_schedule WHERE url = ?').bind(u).first<{ next_due_at: number }>()
    expect(row!.next_due_at).toBe(NOW - D + 5 * D)
  })
})

describe('scheduleAfterFetch / markSetDue', () => {
  it('pace by age after a fetch: young sets soon, old good sets never, old sets with ID rows or no video at 90 d', async () => {
    const env = makeEnv()
    const next = (url: string, videoId: string | null, hasIdRows: boolean) => scheduleAfterFetch(env, DEFAULT_POOL_SETTINGS, { url, videoId, hasIdRows, nowSec: NOW, random: () => 0.5 })
    expect(await next(setUrl('y', 1), 'v', false)).toBe(NOW + 12 * H)
    expect(await next(setUrl('m', 60), 'v', false)).toBe(NOW + 30 * D)
    expect(await next(setUrl('o', 400), 'v', false)).toBeNull()
    expect(await next(setUrl('i', 400), 'v', true)).toBe(NOW + 90 * D)
    expect(await next(setUrl('n', 400), null, false)).toBe(NOW + 90 * D)
    await markSetDue(env, setUrl('o', 400), NOW)
    expect((await env.DB.prepare('SELECT next_due_at FROM set_schedule WHERE url = ?').bind(setUrl('o', 400)).first<{ next_due_at: number }>())!.next_due_at).toBe(NOW)
  })
})

describe('pickTickItems (decision 12 priorities)', () => {
  async function everythingDue(env: Env) {
    await subscribe(env, 'a')
    const young = setUrl('young', 1)
    const old = setUrl('old', 300)
    const verifyMe = setUrl('verify', 5)
    const recheckMe = setUrl('recheck', 5)
    await saveSubState(env, 'a', {
      discoveredTracklistUrls: [young, old, verifyMe, recheckMe],
      processedTracklistUrls: [verifyMe, recheckMe],
      tracklistVideos: { [verifyMe]: { videoId: null, checkedAt: NOW }, [recheckMe]: { videoId: 'v', checkedAt: NOW - 3 * D } },
    })
    await env.DB.prepare('INSERT INTO dj_schedule (slug, next_discovery_at, next_backfill_at, updated_at) VALUES (?, ?, ?, ?)').bind('a', NOW - 1, NOW - 1, NOW).run()
    await env.DB.prepare(
      `INSERT INTO set_verification (url, state, fingerprint, row_count, first_account, first_fetched_at, verify_due_at, exclude_accounts, updated_at)
       VALUES (?, 'pending', 'f', 1, 'acct-1', ?, ?, '["acct-1"]', ?)`,
    ).bind(verifyMe, NOW - 3 * H, NOW - 60, NOW).run()
    await markSetDue(env, recheckMe, NOW - 10)
    return { young, old, verifyMe, recheckMe }
  }

  it('fills a tick new → verify → recheck → backfill', async () => {
    const env = makeEnv()
    const u = await everythingDue(env)
    const items = await pickTickItems(env, DEFAULT_POOL_SETTINGS, 10, new Set(['a']), NOW)
    expect(items.map((i) => [i.kind, i.cls, 'url' in i ? i.url : i.slug])).toEqual([
      ['discovery', 'new', 'a'],
      ['set', 'new', u.young],
      ['verify', 'verify', u.verifyMe],
      ['recheck', 'recheck', u.recheckMe],
      ['set', 'backfill', u.old],
      ['dj_backfill', 'backfill', 'a'],
    ])
    expect(items[2]).toMatchObject({ excludeAccounts: ['acct-1'] })
    expect((await pickTickItems(env, DEFAULT_POOL_SETTINGS, 2, new Set(['a']), NOW)).map((i) => i.kind)).toEqual(['discovery', 'set'])
    // Tick history: what was due per class, before the draw of 2 cut it.
    const due = { new: 0, verify: 0, recheck: 0, backfill: 0 }
    await pickTickItems(env, DEFAULT_POOL_SETTINGS, 2, new Set(['a']), NOW, undefined, due)
    expect(due).toMatchObject({ new: 2, recheck: 1, backfill: 2 })
    expect(due.verify).toBeGreaterThanOrEqual(1)
  })

  it('a DJ step overdue past overdueSlotHours takes the first slot (one per tick); a fresher one waits its turn; 0 turns it off', async () => {
    const env = makeEnv()
    const u = await everythingDue(env)
    // Due 1 s ago: not overdue enough, backfill stays last.
    expect((await pickTickItems(env, DEFAULT_POOL_SETTINGS, 2, new Set(['a']), NOW)).map((i) => i.kind)).toEqual(['discovery', 'set'])
    // 13 h overdue: first slot, even in a tick of one.
    await env.DB.prepare('UPDATE dj_schedule SET next_backfill_at = ? WHERE slug = ?').bind(NOW - 13 * H, 'a').run()
    expect((await pickTickItems(env, DEFAULT_POOL_SETTINGS, 1, new Set(['a']), NOW)).map((i) => i.kind)).toEqual(['dj_backfill'])
    const items = await pickTickItems(env, DEFAULT_POOL_SETTINGS, 10, new Set(['a']), NOW)
    expect(items.map((i) => i.kind)).toEqual(['dj_backfill', 'discovery', 'set', 'verify', 'recheck', 'set'])
    expect(items.filter((i) => i.kind === 'dj_backfill')).toHaveLength(1)
    expect(items[5]).toMatchObject({ cls: 'backfill', url: u.old })
    // Two overdue DJs: only the most overdue one jumps the queue.
    await subscribe(env, 'b')
    await env.DB.prepare('INSERT OR REPLACE INTO dj_schedule (slug, next_discovery_at, next_backfill_at, updated_at) VALUES (?, ?, ?, ?)').bind('b', NOW + D, NOW - 40 * H, NOW).run()
    const two = await pickTickItems(env, DEFAULT_POOL_SETTINGS, 10, new Set(['a', 'b']), NOW)
    expect(two[0]).toMatchObject({ kind: 'dj_backfill', slug: 'b' })
    expect(two[two.length - 1]).toMatchObject({ kind: 'dj_backfill', slug: 'a' })
    const off: PoolSettings = { ...DEFAULT_POOL_SETTINGS, backfill: { ...DEFAULT_POOL_SETTINGS.backfill, overdueSlotHours: 0 } }
    expect((await pickTickItems(env, off, 1, new Set(['a', 'b']), NOW)).map((i) => i.kind)).toEqual(['discovery'])
  })

  it('follows a custom order from the settings, and ignores unsubscribed DJs', async () => {
    const env = makeEnv()
    const u = await everythingDue(env)
    const s: PoolSettings = { ...DEFAULT_POOL_SETTINGS, priorities: { ...DEFAULT_POOL_SETTINGS.priorities, order: ['recheck', 'verify', 'new', 'backfill'] } }
    const items = await pickTickItems(env, s, 1, new Set(['a']), NOW)
    expect(items).toEqual([{ cls: 'recheck', kind: 'recheck', slug: 'a', url: u.recheckMe }])
    expect(await pickTickItems(env, s, 5, new Set(['someone-else']), NOW)).toEqual([])
  })
})

describe('runSchedulerTick', () => {
  const always = (x: number) => () => x

  it('does nothing while ban:pause is set, or without TLPOOL_*', async () => {
    const env = makeEnv()
    await subscribe(env, 'a')
    await setPause(env, 'manual', null)
    expect(await runSchedulerTick(env, { random: always(0.99) })).toMatchObject({ skipped: 'paused' })
    _resetTallyForTests()
    expect(await runSchedulerTick(makeEnv({ TLPOOL_URL: undefined }), { random: always(0.99) })).toMatchObject({ skipped: 'pool_not_configured' })
    expect(fetch1001Html).not.toHaveBeenCalled()
  })

  it('submits a random number of items in [minItems, maxItems] (0 = a quiet tick)', async () => {
    const env = makeEnv()
    await subscribe(env, 'a')
    await quietDjs(env, 'a')
    const urls = [1, 2, 3, 4, 5].map((i) => setUrl(`p${i}`, 1))
    await saveSubState(env, 'a', { playlistId: 'PL', artistName: 'A', discoveredTracklistUrls: urls, processedTracklistUrls: [] })
    expect(await runSchedulerTick(env, { random: always(0) })).toMatchObject({ skipped: 'zero_draw' })
    const r = await runSchedulerTick(env, { random: always(0.99) }) // 0..3 → 3
    expect(r.drawn).toBe(3)
    expect(r.items.map((i) => i.outcome)).toEqual(['ok', 'ok', 'ok'])
    expect(fetch1001Html).toHaveBeenCalledTimes(3)
    expect(mocked(fetch1001Html).mock.calls.every((c) => c[1].priority === 'new' && c[1].kind === 'set')).toBe(true)
    expect((await loadSubState(env, 'a'))!.processedTracklistUrls).toHaveLength(3)
  })

  it('budget_exhausted ends the tick at once, charges nothing, and backs off for retryAfterSeconds', async () => {
    const env = makeEnv()
    await subscribe(env, 'a')
    await quietDjs(env, 'a')
    const urls = [1, 2, 3].map((i) => setUrl(`b${i}`, 1))
    await saveSubState(env, 'a', { playlistId: 'PL', artistName: 'A', discoveredTracklistUrls: urls, processedTracklistUrls: [] })
    mocked(fetch1001Html).mockRejectedValue(new PoolPausedError('budget_exhausted', 900))
    const r = await runSchedulerTick(env, { random: always(0.99), now: NOW })
    expect(fetch1001Html).toHaveBeenCalledTimes(1)
    expect(r.items).toHaveLength(1)
    expect(r.stoppedBy).toMatch(/budget_exhausted/)
    expect(Number(await env.CACHE.get(TICK_BACKOFF_KEY))).toBe(NOW + 900)
    const state = (await loadSubState(env, 'a'))!
    expect(state.failureCounts).toEqual({})
    expect(state.abandonedTracklistUrls).toEqual([])
    expect(await runSchedulerTick(env, { random: always(0.99), now: NOW + 60 })).toMatchObject({ skipped: 'backoff' })
    expect(fetch1001Html).toHaveBeenCalledTimes(1)
  })

  it('a verification second fetch runs at priority verify, avoiding the first account, and verifies on agreement', async () => {
    const env = makeEnv()
    await subscribe(env, 'a')
    await quietDjs(env, 'a')
    const { readFileSync } = await import('node:fs')
    const { resolve, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const html = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tracklist-matroda.html'), 'utf8')
    const u = setUrl('v', 200) // old: no recheck due by age, only the verification
    await saveSubState(env, 'a', { playlistId: 'PL', artistName: 'A', discoveredTracklistUrls: [u], processedTracklistUrls: [u], tracklistVideos: { [u]: { videoId: 'vid00000001', checkedAt: NOW - 3 * H } } })
    await env.DB.prepare('INSERT INTO set_schedule (url, set_date, next_due_at, last_fetched_at, has_id_rows, no_good_video, updated_at) VALUES (?, NULL, NULL, ?, 0, 0, ?)').bind(u, NOW - 3 * H, NOW).run()
    const { parseTracklist } = await import('../src/lib/tracklists1001')
    await noteSetFetch(env, { setUrl: u, parsed: parseTracklist(u, html), accountId: 'acct-1', fetchedAt: NOW - 3 * H, settings: DEFAULT_POOL_SETTINGS, pool: null, random: () => 0 })
    mocked(parseSetYouTubeId).mockReturnValue('vid00000001')
    mocked(fetch1001Html).mockResolvedValue({ html, via: 'pool', state: { cookie: '' }, accountId: 'acct-2', fetchedAt: new Date(NOW * 1000).toISOString() })
    const r = await runSchedulerTick(env, { random: always(0.4), now: NOW })
    expect(r.items.map((i) => [i.item.kind, i.outcome])).toEqual([['verify', 'ok']])
    expect(mocked(fetch1001Html).mock.calls[0]![1]).toMatchObject({ priority: 'verify', excludeAccounts: ['acct-1'], kind: 'set' })
    const { isVerified } = await import('../src/lib/verification')
    expect(await isVerified(env, u)).toBe(true)
  })

  it('discovery reads the DJ page at priority new and pushes the next discovery out by about a day', async () => {
    const env = makeEnv()
    await subscribe(env, 'a')
    await saveSubState(env, 'a', { playlistId: 'PL', artistName: 'A', discoveredTracklistUrls: [], processedTracklistUrls: [] })
    await env.DB.prepare('INSERT INTO dj_schedule (slug, next_discovery_at, next_backfill_at, updated_at) VALUES (?, ?, ?, ?)').bind('a', NOW - 1, NOW + 30 * D, NOW).run()
    mocked(crawlDjIndex).mockResolvedValue({ artistName: 'A', tracklistUrls: [setUrl('new1', 0)], pagesWalked: 1, stopReason: 'known', tail: { pos: 15, id: 'x' }, keys: { type: 'artist', idScrollObject: 'q', subtype: 'tracklists' } })
    const r = await runSchedulerTick(env, { random: always(0.26), now: NOW }) // draw 1
    expect(r.items.map((i) => i.item.kind)).toEqual(['discovery'])
    expect(mocked(crawlDjIndex).mock.calls[0]![1]).toMatchObject({ priority: 'new' })
    expect(fetch1001Html).not.toHaveBeenCalled() // discovery only; the new set is the next tick's
    const next = (await env.DB.prepare('SELECT next_discovery_at FROM dj_schedule WHERE slug = ?').bind('a').first<{ next_discovery_at: number }>())!.next_discovery_at
    expect(next - NOW).toBeGreaterThanOrEqual(20 * H)
    expect(next - NOW).toBeLessThanOrEqual(28 * H)
    expect((await loadSubState(env, 'a'))!.discoveredTracklistUrls).toContain(setUrl('new1', 0))
    expect(await loadDjBackfill(env, 'a')).toMatchObject({ cursor: { pos: 15, id: 'x' }, done: false })
  })

  it('a DJ backfill step is one older-sets request at priority backfill; its sets join the DJ', async () => {
    const env = makeEnv()
    await subscribe(env, 'a')
    await saveSubState(env, 'a', { playlistId: 'PL', artistName: 'A', discoveredTracklistUrls: [setUrl('k', 1)], processedTracklistUrls: [setUrl('k', 1)], tracklistVideos: { [setUrl('k', 1)]: { videoId: 'v', checkedAt: NOW } } })
    await env.DB.prepare('INSERT INTO set_schedule (url, set_date, next_due_at, last_fetched_at, has_id_rows, no_good_video, updated_at) VALUES (?, NULL, ?, ?, 0, 0, ?)').bind(setUrl('k', 1), NOW + D, NOW, NOW).run()
    await env.DB.prepare('INSERT INTO dj_schedule (slug, next_discovery_at, next_backfill_at, updated_at) VALUES (?, ?, ?, ?)').bind('a', NOW + 30 * D, NOW - 1, NOW).run()
    const keys = { type: 'artist', idScrollObject: 'q', subtype: 'tracklists' }
    await saveDjBackfill(env, 'a', { cursor: { pos: 15, id: 'x' }, done: false, at: 0, keys })
    mocked(djScrollStep).mockResolvedValue({ urls: [setUrl('old1', 500), setUrl('old2', 510)], end: false, next: { pos: 25, id: 'y' } })
    const r = await runSchedulerTick(env, { random: always(0.26), now: NOW })
    expect(r.items.map((i) => [i.item.kind, i.outcome])).toEqual([['dj_backfill', 'stepped']])
    expect(mocked(djScrollStep).mock.calls[0]!.slice(0, 3)).toEqual(['a', keys, { pos: 15, id: 'x' }])
    expect(mocked(djScrollStep).mock.calls[0]![3]).toMatchObject({ priority: 'backfill' })
    expect((await loadSubState(env, 'a'))!.discoveredTracklistUrls).toEqual([setUrl('k', 1), setUrl('old1', 500), setUrl('old2', 510)])
    expect(await loadDjBackfill(env, 'a')).toMatchObject({ cursor: { pos: 25, id: 'y' }, done: false, keys })
    // The sets it found are backfill-priority first fetches on later ticks.
    const items = await pickTickItems(env, DEFAULT_POOL_SETTINGS, 5, new Set(['a']), NOW)
    expect(items.filter((i) => i.kind === 'set').map((i) => i.cls)).toEqual(['backfill', 'backfill'])
  })

  it('new subscriptions get discovery times spread across the day, not all at once', async () => {
    const env = makeEnv()
    const slugs = Array.from({ length: 20 }, (_, i) => `dj${i}`)
    await subscribe(env, ...slugs)
    await runSchedulerTick(env, { now: NOW, random: (() => { let x = 0; return () => ((x = (x * 9301 + 49297) % 233280) / 233280) })() })
    const rows = (await env.DB.prepare('SELECT next_discovery_at FROM dj_schedule').all<{ next_discovery_at: number }>()).results
    expect(rows).toHaveLength(20)
    expect(rows.filter((r) => r.next_discovery_at <= NOW + 300).length).toBeLessThanOrEqual(2)
    expect(rows.every((r) => r.next_discovery_at <= NOW + 24 * H)).toBe(true)
  })
})

describe('hand-made rechecks and failure handling', () => {
  const always = (x: number) => () => x

  it('a set marked due by checked_at = 0 (Invalidate & resync, playlist hygiene) is a recheck even without a schedule row, and goes first', async () => {
    const env = makeEnv()
    await subscribe(env, 'a')
    await quietDjs(env, 'a')
    const byHand = setUrl('hand', 400)
    const bySchedule = setUrl('sched', 20)
    await saveSubState(env, 'a', {
      playlistId: 'PL',
      artistName: 'A',
      discoveredTracklistUrls: [bySchedule, byHand],
      processedTracklistUrls: [bySchedule, byHand],
      tracklistVideos: { [bySchedule]: { videoId: 'v1', checkedAt: NOW - 9 * D }, [byHand]: { videoId: null, checkedAt: 0 } },
    })
    await markSetDue(env, bySchedule, NOW - 60)
    const items = await pickTickItems(env, DEFAULT_POOL_SETTINGS, 5, new Set(['a']), NOW)
    expect(items.map((i) => (i.kind === 'recheck' ? i.url : i.kind))).toEqual([byHand, bySchedule])
  })

  it('a discovery whose page fetch failed ends the tick and is retried in about an hour, not a day', async () => {
    const env = makeEnv()
    await subscribe(env, 'a')
    await saveSubState(env, 'a', { playlistId: 'PL', artistName: 'A', discoveredTracklistUrls: [setUrl('x', 1)], processedTracklistUrls: [] })
    await env.DB.prepare('INSERT INTO dj_schedule (slug, next_discovery_at, next_backfill_at, updated_at) VALUES (?, ?, ?, ?)').bind('a', NOW - 1, NOW + 30 * D, NOW).run()
    mocked(crawlDjIndex).mockResolvedValue({ artistName: null, tracklistUrls: [], pagesWalked: 0, stopReason: 'fetch_failed', tail: null })
    const r = await runSchedulerTick(env, { random: always(0.99), now: NOW }) // draws 3: discovery, then the pending set
    expect(r.items.map((i) => [i.item.kind, i.outcome])).toEqual([['discovery', 'stopped']])
    expect(fetch1001Html).not.toHaveBeenCalled()
    const next = (await env.DB.prepare('SELECT next_discovery_at FROM dj_schedule WHERE slug = ?').bind('a').first<{ next_discovery_at: number }>())!.next_discovery_at
    expect(next).toBe(NOW + H)
  })

  it('a backfill step the pool refused keeps its cursor and is retried in about an hour', async () => {
    const env = makeEnv()
    await subscribe(env, 'a')
    await saveSubState(env, 'a', { playlistId: 'PL', artistName: 'A', discoveredTracklistUrls: [], processedTracklistUrls: [] })
    await env.DB.prepare('INSERT INTO dj_schedule (slug, next_discovery_at, next_backfill_at, updated_at) VALUES (?, ?, ?, ?)').bind('a', NOW + 30 * D, NOW - 1, NOW).run()
    const keys = { type: 'artist', idScrollObject: 'q', subtype: 'tracklists' }
    await saveDjBackfill(env, 'a', { cursor: { pos: 15, id: 'x' }, done: false, at: 0, keys })
    mocked(djScrollStep).mockRejectedValue(new PoolPausedError('challenge_pending', 300))
    const r = await runSchedulerTick(env, { random: always(0.26), now: NOW })
    expect(r.items.map((i) => [i.item.kind, i.outcome])).toEqual([['dj_backfill', 'stopped']])
    expect(Number(await env.CACHE.get(TICK_BACKOFF_KEY))).toBe(NOW + 300)
    expect(await loadDjBackfill(env, 'a')).toMatchObject({ cursor: { pos: 15, id: 'x' } })
    const next = (await env.DB.prepare('SELECT next_backfill_at FROM dj_schedule WHERE slug = ?').bind('a').first<{ next_backfill_at: number }>())!.next_backfill_at
    expect(next).toBe(NOW + H)
  })

  it('an overdue set mkvid is waiting on is spread over two days, not its whole interval (its render needs a verified list)', async () => {
    const env = makeEnv()
    await subscribe(env, 'dj')
    const old = setUrl('mk', 300)
    await saveSubState(env, 'dj', { discoveredTracklistUrls: [old], processedTracklistUrls: [old], tracklistVideos: { [old]: { videoId: null, checkedAt: NOW - 200 * D } } })
    const { enqueueMkvidRequest } = await import('../src/lib/mkvid')
    await enqueueMkvidRequest(env, { slug: 'dj', setUrl: old, artistName: 'X', setTitle: null, setDate: null, source: { kind: 'soundcloud', url: 'https://api.soundcloud.com/tracks/1' }, lastCueSeconds: null, trackCount: 1, idedCount: 1 })
    await ensureSetSchedules(env, DEFAULT_POOL_SETTINGS, NOW, always(0.999))
    const row = await env.DB.prepare('SELECT next_due_at FROM set_schedule WHERE url = ?').bind(old).first<{ next_due_at: number }>()
    expect(row!.next_due_at - NOW).toBeLessThanOrEqual(2 * D)
    expect(row!.next_due_at - NOW).toBeGreaterThan(D)
  })
})

describe('review W4 fixes (scheduler)', () => {
  const always = (x: number) => () => x
  const insTl = (env: Env, slug: string, url: string, checkedAt: number, processed = 1) =>
    env.DB.prepare('INSERT INTO tracklists (slug, url, processed, abandoned, checked_at, position, discovered_at) VALUES (?, ?, ?, 0, ?, 0, 0)').bind(slug, url, processed, checkedAt).run()
  const insSched = (env: Env, url: string, due: number) =>
    env.DB.prepare('INSERT INTO set_schedule (url, set_date, next_due_at, last_fetched_at, has_id_rows, no_good_video, updated_at) VALUES (?, NULL, ?, NULL, 0, 0, 0)').bind(url, due).run()

  it('#2 overdue sets of an unsubscribed DJ cannot starve a subscribed one (the SQL filters before its LIMIT)', async () => {
    const env = makeEnv()
    await subscribe(env, 'live')
    for (let i = 0; i < 25; i++) {
      const u = setUrl(`o${i}`, 400)
      await insTl(env, 'gone', u, 100)
      await insSched(env, u, NOW - 100000 - i)
      await insTl(env, 'gone', setUrl(`p${i}`, 1), 0, 0) // never-fetched sets of the gone DJ
    }
    const good = setUrl('g', 400)
    await insTl(env, 'live', good, 100)
    await insSched(env, good, NOW - 10)
    const items = await pickTickItems(env, DEFAULT_POOL_SETTINGS, 3, new Set(['live', 'gone']), NOW)
    expect(items).toEqual([{ cls: 'recheck', kind: 'recheck', slug: 'live', url: good }])
  })

  it('#2 a b2b set listed under an unsubscribed DJ too runs under the subscribed one', async () => {
    const env = makeEnv()
    await subscribe(env, 'zzz')
    const u = setUrl('b2b', 400)
    await insTl(env, 'aaa', u, 100)
    await insTl(env, 'zzz', u, 100)
    await insSched(env, u, NOW - 10)
    const items = await pickTickItems(env, DEFAULT_POOL_SETTINGS, 3, new Set(['zzz']), NOW)
    expect(items).toEqual([{ cls: 'recheck', kind: 'recheck', slug: 'zzz', url: u }])
  })

  it('#2 schedules are not created for an unsubscribed DJ', async () => {
    const env = makeEnv()
    await subscribe(env, 'live')
    await insTl(env, 'gone', setUrl('x', 400), 100)
    await insTl(env, 'live', setUrl('y', 400), 100)
    expect(await ensureSetSchedules(env, DEFAULT_POOL_SETTINGS, NOW)).toBe(1)
  })

  it('#3 a hand-marked recheck whose run fails is not picked again until its backoff ends, and at most 3 times a day', async () => {
    const env = makeEnv()
    await subscribe(env, 'a')
    await quietDjs(env, 'a')
    const u = setUrl('hand', 400)
    await saveSubState(env, 'a', { playlistId: 'PL', artistName: 'A', discoveredTracklistUrls: [u], processedTracklistUrls: [u], tracklistVideos: { [u]: { videoId: null, checkedAt: 0 } } })
    mocked(fetch1001Html).mockRejectedValue(new Error('transient'))
    // ENSURE_STAMP_KEY: skip schedule creation, so only the hand mark makes it due.
    await env.CACHE.put(ENSURE_STAMP_KEY, String(NOW + 10 * D))
    const day0 = Math.floor(NOW / 86400) * 86400 + 60 // 00:01 UTC: all attempts land on one UTC day
    let t = day0
    const runs: string[] = []
    for (let i = 0; i < 6; i++) {
      const r = await runSchedulerTick(env, { random: always(0.99), now: t })
      runs.push(r.skipped ?? r.items.map((x) => `${x.item.kind}`).join(','))
      t += 5 * 60 // the next tick, 5 minutes later
    }
    // Picked once; the following ticks inside the 15-minute backoff leave it alone.
    expect(runs.filter((x) => x === 'recheck')).toHaveLength(2) // t0 and t0+15 min
    expect(fetch1001Html).toHaveBeenCalledTimes(2)
    // Third attempt after 30 more minutes, then the daily cap holds for the rest of the day.
    await runSchedulerTick(env, { random: always(0.99), now: day0 + 15 * 60 + attemptBackoffSeconds(2) })
    expect(fetch1001Html).toHaveBeenCalledTimes(MAX_SET_ATTEMPTS_PER_DAY)
    await runSchedulerTick(env, { random: always(0.99), now: day0 + 20 * 3600 })
    expect(fetch1001Html).toHaveBeenCalledTimes(MAX_SET_ATTEMPTS_PER_DAY)
  })

  it('#3 a completed fetch clears the pending attempt; backoff doubles and is capped at 6 h', async () => {
    const env = makeEnv()
    const u = setUrl('ok', 1)
    expect(await claimSetAttempt(env, u, NOW)).toBe(1)
    expect(await claimSetAttempt(env, u, NOW + 1)).toBe(2)
    expect((await env.DB.prepare('SELECT retry_at FROM set_schedule WHERE url = ?').bind(u).first<{ retry_at: number }>())!.retry_at).toBe(NOW + 1 + 30 * 60)
    await scheduleAfterFetch(env, DEFAULT_POOL_SETTINGS, { url: u, videoId: 'v', hasIdRows: false, nowSec: NOW + 2 })
    expect((await env.DB.prepare('SELECT retry_at FROM set_schedule WHERE url = ?').bind(u).first<{ retry_at: number | null }>())!.retry_at).toBeNull()
    expect(attemptBackoffSeconds(10)).toBe(6 * H)
  })

  it('#7 schedule creation runs at most hourly, not on every tick', async () => {
    const env = makeEnv()
    await subscribe(env, 'a')
    await quietDjs(env, 'a')
    const u = setUrl('s', 400)
    await saveSubState(env, 'a', { playlistId: 'PL', artistName: 'A', discoveredTracklistUrls: [u], processedTracklistUrls: [u], tracklistVideos: { [u]: { videoId: 'v', checkedAt: NOW - 400 * D } } })
    await runSchedulerTick(env, { random: always(0), now: NOW }) // zero draw, but schedules are ensured
    expect(Number(await env.CACHE.get(ENSURE_STAMP_KEY))).toBe(NOW)
    await env.DB.prepare('DELETE FROM set_schedule').run()
    await runSchedulerTick(env, { random: always(0), now: NOW + 30 * 60 })
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM set_schedule').first<{ n: number }>())!.n).toBe(0)
    await runSchedulerTick(env, { random: always(0), now: NOW + H })
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM set_schedule').first<{ n: number }>())!.n).toBe(1)
  })

  it('#7 the tick queries use the new tracklists index', async () => {
    const env = makeEnv()
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN SELECT t.slug, t.url FROM tracklists t WHERE t.processed = 0 AND t.abandoned = 0 ORDER BY t.discovered_at DESC`).all<{ detail: string }>()
    expect(plan.results.map((r) => r.detail).join(' ')).toContain('tracklists_queue')
  })
})
