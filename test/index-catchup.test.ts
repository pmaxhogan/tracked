import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeD1 } from './helpers/fake-d1'
import { fakeKV } from './helpers/fake-kv'
import type { Env } from '../src/types'
import { DEFAULT_POOL_SETTINGS, updatePoolSettings } from '../src/lib/pool-settings'
import { budgetHoldKey, ENSURE_STAMP_KEY, INFLIGHT_KEY, indexCatchUpAllowance, indexCatchUpCandidates, INDEX_CATCHUP_EMPTY_KEY, pickTickItems, runSchedulerTick, TICK_BACKOFF_KEY } from '../src/lib/fetch-scheduler'
import { PoolPausedError } from '../src/lib/pool'
import { INDEX_FORMAT_SINCE } from '../src/lib/search/index'
import { saveSubState, loadSubState } from '../src/lib/sync-store'
import { getVerification } from '../src/lib/verification'
import { _resetTallyForTests } from '../src/lib/ban-state'
import { UpstreamHttpError } from '../src/lib/upstream-errors'

// Network edges stubbed; the scheduler, syncOne, D1 and verification run for real.
vi.mock('../src/lib/dj-index', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/dj-index')>('../src/lib/dj-index')
  return { ...actual, fetch1001Html: vi.fn(), crawlDjIndex: vi.fn(), djScrollStep: vi.fn(), parseSetYouTubeId: vi.fn() }
})
vi.mock('../src/lib/youtube-playlists', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/youtube-playlists')>('../src/lib/youtube-playlists')
  return { ...actual, findPlaylistByTitle: vi.fn(), createPlaylist: vi.fn(), listPlaylistVideoIds: vi.fn(), addVideoToPlaylist: vi.fn(), removeVideoFromPlaylist: vi.fn() }
})
vi.mock('../src/lib/video-meta', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/video-meta')>('../src/lib/video-meta')
  return { ...actual, getVideoMeta: vi.fn(async () => new Map()) }
})
import { fetch1001Html, parseSetYouTubeId } from '../src/lib/dj-index'
import { findPlaylistByTitle, listPlaylistVideoIds } from '../src/lib/youtube-playlists'

const H = 3600
const D = 24 * H
const NOON = Math.floor(Date.now() / 1000 / D) * D + 12 * H
const BEFORE = INDEX_FORMAT_SINCE - 5 * D
const day = (daysAgo: number) => new Date((NOON - daysAgo * D) * 1000).toISOString().slice(0, 10)
const setUrl = (id: string, daysAgo: number) => `https://www.1001tracklists.com/tracklist/${id}/dj-set-${day(daysAgo)}.html`
const mocked = (f: unknown) => f as ReturnType<typeof vi.fn>
const always = (x: number) => () => x
const MATRODA = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tracklist-matroda.html'), 'utf8')
const S = DEFAULT_POOL_SETTINGS

function makeEnv(): Env {
  return { CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k', TLPOOL_URL: 'https://tlpool.example', TLPOOL_TOKEN: 'pt' } as Env
}

async function subscribe(env: Env, ...slugs: string[]) {
  let i = 0
  for (const slug of slugs) {
    await env.DB.prepare('INSERT INTO subscriptions (slug, source_url, added_at, position) VALUES (?, ?, ?, ?)').bind(slug, `https://www.1001tracklists.com/dj/${slug}/`, 0, i++).run()
    await env.DB.prepare('INSERT OR REPLACE INTO dj_schedule (slug, next_discovery_at, next_backfill_at, updated_at) VALUES (?, ?, ?, ?)').bind(slug, NOON + 300 * D, NOON + 300 * D, NOON).run()
  }
  await env.SUBS.put('subs:migrated', '{}')
  await env.SUBS.put('oauth:google', JSON.stringify({ accessToken: 'tok', refreshToken: 'r', expiresAt: NOON + 400 * D, scope: 's', channelId: null, channelTitle: null, connectedAt: 0 }))
  await env.CACHE.put(ENSURE_STAMP_KEY, String(NOON + 400 * D))
}

/** A processed set with a video, last fetched at `fetchedAt`, next due `dueAt` (default: in 100 days). */
async function syncedSet(env: Env, id: string, o: { daysAgo?: number; slug?: string; fetchedAt?: number | null; dueAt?: number | null } = {}): Promise<string> {
  const slug = o.slug ?? 'dj'
  const daysAgo = o.daysAgo ?? 200
  const u = setUrl(id, daysAgo)
  const st = (await loadSubState(env, slug)) ?? { discoveredTracklistUrls: [], processedTracklistUrls: [], tracklistVideos: {} }
  await saveSubState(env, slug, {
    ...st,
    playlistId: 'PL',
    artistName: 'A',
    discoveredTracklistUrls: [...(st.discoveredTracklistUrls ?? []), u],
    processedTracklistUrls: [...(st.processedTracklistUrls ?? []), u],
    tracklistVideos: { ...(st.tracklistVideos ?? {}), [u]: { videoId: 'vid' + id, checkedAt: BEFORE } },
  })
  await env.DB.prepare(
    'INSERT INTO set_schedule (url, set_date, next_due_at, last_fetched_at, has_id_rows, no_good_video, updated_at) VALUES (?, ?, ?, ?, 0, 0, ?)',
  )
    .bind(u, day(daysAgo), o.dueAt === undefined ? NOON + 100 * D : o.dueAt, o.fetchedAt === undefined ? BEFORE : o.fetchedAt, BEFORE)
    .run()
  return u
}

async function verified(env: Env, u: string) {
  await env.DB.prepare(
    `INSERT INTO set_verification (url, state, fingerprint, row_count, first_account, first_fetched_at, verify_due_at, verified_at, updated_at)
     VALUES (?, 'verified', 'f', 1, 'a', ?, ?, ?, ?)`,
  )
    .bind(u, NOON - D, NOON - D, NOON - D, NOON - D)
    .run()
}

const cands = async (env: Env, now = NOON) => (await indexCatchUpCandidates(env, S, now, 100)).map((c) => c.url)

beforeEach(() => {
  vi.resetAllMocks()
  _resetTallyForTests()
  mocked(fetch1001Html).mockResolvedValue({ html: MATRODA, via: 'pool', state: { cookie: '' }, accountId: 'acct-1', fetchedAt: new Date(NOON * 1000).toISOString() })
  mocked(listPlaylistVideoIds).mockImplementation(async () => new Set<string>())
  mocked(findPlaylistByTitle).mockResolvedValue({ id: 'PL', title: 'x' })
  mocked(parseSetYouTubeId).mockReturnValue(null)
})

describe('search index catch-up: which sets', () => {
  it('sets fetched before the index format date, or never verified, newest set first', async () => {
    const env = makeEnv()
    await subscribe(env, 'dj')
    const old = await syncedSet(env, 'old', { daysAgo: 300 })
    const young = await syncedSet(env, 'young', { daysAgo: 40 })
    // Fetched after the format date and verified: indexed then.
    const done = await syncedSet(env, 'done', { daysAgo: 20, fetchedAt: NOON - 5 * D })
    await verified(env, done)
    // Verified before the format date: never indexed, fetched again.
    const early = await syncedSet(env, 'early', { daysAgo: 100 })
    await verified(env, early)
    // Fetched after the format date with no verification (a decoy fetch): again once the cooldown passed.
    const decoy = await syncedSet(env, 'decoy', { daysAgo: 60, fetchedAt: NOON - 4 * D })
    const fresh = await syncedSet(env, 'fresh', { daysAgo: 70, fetchedAt: NOON - H })
    expect(await cands(env)).toEqual([young, decoy, early, old])
    expect(await cands(env, NOON + S.indexCatchUp.cooldownHours * H)).toEqual([young, decoy, fresh, early, old])
  })

  it('leaves out sets due as a recheck, marked for a resync, of unsubscribed DJs, and the render feeder cools down or gave up on', async () => {
    const env = makeEnv()
    await subscribe(env, 'dj')
    const keep = await syncedSet(env, 'keep')
    await syncedSet(env, 'due', { dueAt: NOON - 60 })
    const resync = await syncedSet(env, 'resync')
    await env.DB.prepare('UPDATE tracklists SET checked_at = 0 WHERE url = ?').bind(resync).run()
    await syncedSet(env, 'other', { slug: 'gone' })
    const cooling = await syncedSet(env, 'cooling')
    const gaveUp = await syncedSet(env, 'gaveup')
    await env.DB.prepare('INSERT INTO render_feed (url, attempts, failures, last_attempt_at, next_feed_at, gave_up, updated_at) VALUES (?, 1, 1, ?, ?, 0, ?)').bind(cooling, NOON, NOON + D, NOON).run()
    await env.DB.prepare('INSERT INTO render_feed (url, attempts, failures, last_attempt_at, next_feed_at, gave_up, updated_at) VALUES (?, 3, 3, ?, ?, 1, ?)').bind(gaveUp, NOON, NOON - D, NOON).run()
    expect(await cands(env)).toEqual([keep])
  })
})

describe('search index catch-up: in the tick', () => {
  it('rides on top of the drawn items, at most perTick, and not at all when off', async () => {
    const env = makeEnv()
    await subscribe(env, 'dj')
    const a = await syncedSet(env, 'a', { daysAgo: 30 })
    await syncedSet(env, 'b', { daysAgo: 300 })
    const due = await syncedSet(env, 'due', { dueAt: NOON - 60, fetchedAt: NOON - 10 * D })
    const items = await pickTickItems(env, S, 1, new Set(['dj']), NOON, 0)
    expect(items.map((i) => [i.kind, 'url' in i && i.url])).toEqual([
      ['recheck', due],
      ['index_catchup', a],
    ])
    expect(await pickTickItems(env, S, 1, new Set(['dj']), NOON, 0, undefined, 0)).toHaveLength(1)
    await updatePoolSettings(env, { indexCatchUp: { perDay: 0 } })
    const off = await (await import('../src/lib/pool-settings')).getPoolSettings(env)
    expect(await indexCatchUpAllowance(env, off, NOON)).toBe(0)
  })

  it('a catch-up fetch starts verification (so the set leaves the list) and counts toward the day; nothing left = not looked for for an hour', async () => {
    const env = makeEnv()
    await subscribe(env, 'dj')
    const u = await syncedSet(env, 'one')
    const r = await runSchedulerTick(env, { random: always(0.99), now: NOON })
    expect(r.items.map((i) => [i.item.kind, 'url' in i.item && i.item.url, i.outcome])).toEqual([['index_catchup', u, 'ok']])
    expect((await getVerification(env, u))?.state).toBe('pending')
    expect(await indexCatchUpAllowance(env, { ...S, indexCatchUp: { ...S.indexCatchUp, perDay: 1 } }, NOON)).toBe(0)
    expect(await cands(env, NOON + 10 * D)).toEqual([])
    const r2 = await runSchedulerTick(env, { random: always(0.99), now: NOON + 60 })
    expect(r2.items).toEqual([])
    expect(Number(await env.CACHE.get(INDEX_CATCHUP_EMPTY_KEY))).toBeGreaterThan(NOON + 60)
  })

  it('a set that fails to fetch (deleted) waits the whole cooldown, not the attempt backoff', async () => {
    const env = makeEnv()
    await subscribe(env, 'dj')
    const u = await syncedSet(env, 'dead')
    mocked(fetch1001Html).mockRejectedValue(new UpstreamHttpError(404, u))
    const r = await runSchedulerTick(env, { random: always(0.99), now: NOON })
    expect(r.items.map((i) => [i.item.kind, i.outcome])).toEqual([['index_catchup', 'failed']])
    expect(await cands(env, NOON + 6 * H)).toEqual([])
    expect(await cands(env, NOON + S.indexCatchUp.cooldownHours * H + 60)).toEqual([u])
  })
})

describe('a spent low-priority budget, and spreading a tick', () => {
  it('budget_exhausted on a catch-up holds backfill only: the tick carries on, the next one still runs its recheck and picks no catch-up', async () => {
    const env = makeEnv()
    await subscribe(env, 'dj')
    const due = await syncedSet(env, 'due', { dueAt: NOON - 60, fetchedAt: NOON - 10 * D })
    const old = await syncedSet(env, 'old')
    mocked(fetch1001Html).mockImplementation(async (url: string) => {
      if (url === old) throw new PoolPausedError('budget_exhausted', 1800)
      return { html: MATRODA, via: 'pool', state: { cookie: '' }, accountId: 'acct-1', fetchedAt: new Date(NOON * 1000).toISOString() }
    })
    const r = await runSchedulerTick(env, { random: always(0.99), now: NOON })
    expect(r.items.map((i) => [i.item.kind, i.outcome])).toEqual([['recheck', 'ok'], ['index_catchup', 'stopped']])
    expect(r.stoppedBy).toBeUndefined()
    expect(await env.CACHE.get(TICK_BACKOFF_KEY)).toBeNull()
    expect(Number(await env.CACHE.get(budgetHoldKey('backfill')))).toBe(NOON + 1800)
    const due2 = await syncedSet(env, 'due2', { dueAt: NOON, fetchedAt: NOON - 10 * D })
    const r2 = await runSchedulerTick(env, { random: always(0.99), now: NOON + 300 })
    expect(r2.skipped).toBeUndefined()
    expect(r2.items.map((i) => [i.item.kind, 'url' in i.item && i.item.url])).toEqual([['recheck', due2]])
    expect(due).not.toBe(due2)
    // Once the hold runs out, catch-up is back.
    expect((await pickTickItems(env, S, 3, new Set(['dj']), NOON + 1900, 0)).some((i) => i.kind === 'index_catchup')).toBe(true)
  })

  it("spreads a tick's items over tick.spreadSeconds when given a timer, and an overlapping tick leaves the URLs still to come", async () => {
    const env = makeEnv()
    await subscribe(env, 'dj')
    await syncedSet(env, 'due', { dueAt: NOON - 60, fetchedAt: NOON - 10 * D })
    const later = await syncedSet(env, 'later', { dueAt: NOON - 30, fetchedAt: NOON - 10 * D })
    const waits: number[] = []
    let seenDuringWait: string[] = []
    const sleep = async (ms: number) => {
      waits.push(ms)
      seenDuringWait = (await pickTickItems(env, S, 3, new Set(['dj']), NOON, 0, undefined, 0)).flatMap((i) => ('url' in i ? [i.url] : []))
    }
    const r = await runSchedulerTick(env, { random: always(0.5), now: NOON, sleep })
    expect(r.items).toHaveLength(2)
    expect(waits).toHaveLength(1)
    expect(waits[0]).toBeGreaterThan(70_000)
    expect(waits[0]).toBeLessThanOrEqual(75_000)
    expect(seenDuringWait).not.toContain(later)
    expect(await env.CACHE.get(INFLIGHT_KEY)).toBeNull()
  })
})
