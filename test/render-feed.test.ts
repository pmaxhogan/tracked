import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeD1 } from './helpers/fake-d1'
import { fakeKV } from './helpers/fake-kv'
import type { Env } from '../src/types'
import { DEFAULT_POOL_SETTINGS, getPoolSettings, POOL_SETTINGS_KEY, updatePoolSettings, type PoolSettings } from '../src/lib/pool-settings'
import {
  ENSURE_STAMP_KEY,
  markSetDue,
  pickTickItems,
  renderFeedAllowance,
  renderFeedCandidates,
  renderFeedUsed,
  claimRenderFeed,
  RENDER_FEED_MAX_FAILURES,
  RENDER_FEED_REFETCH_COOLDOWN_SECONDS,
  runSchedulerTick,
  TICK_BACKOFF_KEY,
} from '../src/lib/fetch-scheduler'
import { saveSubState } from '../src/lib/sync-store'
import { getVerification } from '../src/lib/verification'
import { enqueueMkvidRequest } from '../src/lib/mkvid'
import { setPause, _resetTallyForTests } from '../src/lib/ban-state'
import { PoolPausedError } from '../src/lib/pool'
import { UpstreamHttpError, UpstreamTransportError } from '../src/lib/upstream-errors'
import { POOL_PAGES } from '../src/routes/pool-ui'

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
/** Noon UTC today: the pacing allowance is about half the day's cap. */
const NOON = Math.floor(Date.now() / 1000 / D) * D + 12 * H
const day = (daysAgo: number) => new Date((NOON - daysAgo * D) * 1000).toISOString().slice(0, 10)
const setUrl = (id: string, daysAgo: number) => `https://www.1001tracklists.com/tracklist/${id}/dj-set-${day(daysAgo)}.html`
const mocked = (f: unknown) => f as ReturnType<typeof vi.fn>
const always = (x: number) => () => x
const MATRODA = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tracklist-matroda.html'), 'utf8')

function makeEnv(extra: Partial<Env> = {}): Env {
  return { CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k', TLPOOL_URL: 'https://tlpool.example', TLPOOL_TOKEN: 'pt', ...extra } as Env
}

async function subscribe(env: Env, ...slugs: string[]) {
  let i = 0
  for (const slug of slugs) {
    await env.DB.prepare('INSERT INTO subscriptions (slug, source_url, added_at, position) VALUES (?, ?, ?, ?)').bind(slug, `https://www.1001tracklists.com/dj/${slug}/`, 0, i++).run()
    await env.DB.prepare('INSERT OR REPLACE INTO dj_schedule (slug, next_discovery_at, next_backfill_at, updated_at) VALUES (?, ?, ?, ?)').bind(slug, NOON + 300 * D, NOON + 300 * D, NOON).run()
  }
  await env.SUBS.put('subs:migrated', '{}')
  await env.SUBS.put('oauth:google', JSON.stringify({ accessToken: 'tok', refreshToken: 'r', expiresAt: NOON + 400 * D, scope: 's', channelId: null, channelTitle: null, connectedAt: 0 }))
  // Keep schedule creation out of the way: a test decides which set_schedule rows exist.
  await env.CACHE.put(ENSURE_STAMP_KEY, String(NOON + 400 * D))
}

type SetOpts = { daysAgo?: number; createdAt?: number; trackCount?: number; idedCount?: number; slug?: string }

/** A processed set with no YouTube video and a pending mkvid request for it (the 472 in production). */
async function waitingSet(env: Env, id: string, o: SetOpts = {}): Promise<string> {
  const slug = o.slug ?? 'dj'
  const u = setUrl(id, o.daysAgo ?? 200)
  const { loadSubState } = await import('../src/lib/sync-store')
  const st = (await loadSubState(env, slug)) ?? { discoveredTracklistUrls: [], processedTracklistUrls: [], tracklistVideos: {} }
  await saveSubState(env, slug, {
    ...st,
    playlistId: 'PL',
    artistName: 'A',
    discoveredTracklistUrls: [...(st.discoveredTracklistUrls ?? []), u],
    processedTracklistUrls: [...(st.processedTracklistUrls ?? []), u],
    tracklistVideos: { ...(st.tracklistVideos ?? {}), [u]: { videoId: null, checkedAt: NOON - 20 * D } },
  })
  await enqueueMkvidRequest(env, {
    slug,
    setUrl: u,
    artistName: 'A',
    setTitle: null,
    setDate: day(o.daysAgo ?? 200),
    source: { kind: 'soundcloud', url: `https://api.soundcloud.com/tracks/${id}` },
    lastCueSeconds: 3000,
    trackCount: o.trackCount ?? 10,
    idedCount: o.idedCount ?? 10,
  })
  if (o.createdAt !== undefined) await env.DB.prepare('UPDATE mkvid_requests SET created_at = ? WHERE set_url = ?').bind(o.createdAt, u).run()
  return u
}

const candidates = async (env: Env, now = NOON) => (await renderFeedCandidates(env, now, 100)).map((c) => c.url)

beforeEach(() => {
  vi.resetAllMocks()
  _resetTallyForTests()
  mocked(fetch1001Html).mockResolvedValue({ html: '<set/>', via: 'pool', state: { cookie: '' }, accountId: 'acct-9', fetchedAt: new Date(NOON * 1000).toISOString() })
  mocked(listPlaylistVideoIds).mockImplementation(async () => new Set<string>())
  mocked(findPlaylistByTitle).mockResolvedValue({ id: 'PL', title: 'x' })
  mocked(parseSetYouTubeId).mockReturnValue(null)
})

describe('render feeder: what it feeds, in which order', () => {
  it('oldest mkvid request first', async () => {
    const env = makeEnv()
    await subscribe(env, 'dj')
    const b = await waitingSet(env, 'b', { createdAt: NOON - 5 * D })
    const a = await waitingSet(env, 'a', { createdAt: NOON - 9 * D })
    const c = await waitingSet(env, 'c', { createdAt: NOON - 1 * D })
    expect(await candidates(env)).toEqual([a, b, c])
  })

  it('leaves out every request that could not be claimed, and sets whose verification already started', async () => {
    const env = makeEnv()
    await subscribe(env, 'dj')
    const ok = await waitingSet(env, 'ok', { createdAt: NOON - 30 * D })
    const set = async (id: string, sql: string, ...binds: (string | number)[]) => {
      const u = await waitingSet(env, id)
      await env.DB.prepare(sql).bind(...binds, u).run()
      return u
    }
    for (const status of ['banned', 'superseded', 'failed', 'done', 'claimed']) await set(`st-${status}`, 'UPDATE mkvid_requests SET status = ? WHERE set_url = ?', status)
    await set('attempts', 'UPDATE mkvid_requests SET attempts = 3 WHERE set_url = ?')
    await set('has-video', "UPDATE tracklists SET video_id = 'ytvideo0001', video_source = '1001tl' WHERE url = ?")
    await set('abandoned', 'UPDATE tracklists SET abandoned = 1 WHERE url = ?')
    // Verification already under way, or done: the normal verify flow owns it.
    const pending = await waitingSet(env, 'pending')
    const verified = await waitingSet(env, 'verified')
    for (const [u, state] of [[pending, 'pending'], [verified, 'verified']] as const) {
      await env.DB.prepare(
        `INSERT INTO set_verification (url, state, fingerprint, row_count, first_account, first_fetched_at, verify_due_at, exclude_accounts, updated_at)
         VALUES (?, ?, 'f', 1, 'acct-1', ?, NULL, '[]', ?)`,
      ).bind(u, state, NOON - D, NOON).run()
    }
    // The full-recording rule: the page's longest audio stops before the last cue.
    const short = await waitingSet(env, 'short')
    await env.DB.prepare('INSERT INTO set_media_facts (set_url, slug, audio_max_seconds, fetched_at) VALUES (?, ?, ?, ?)').bind(short, 'dj', 1200, NOON).run()
    // Waiting out a failed attempt, or fetched too recently.
    const retry = await waitingSet(env, 'retry')
    await env.DB.prepare('INSERT INTO set_schedule (url, next_due_at, has_id_rows, no_good_video, updated_at, retry_at) VALUES (?, NULL, 0, 0, ?, ?)').bind(retry, NOON, NOON + H).run()
    const recent = await waitingSet(env, 'recent')
    await env.DB.prepare('INSERT INTO set_schedule (url, next_due_at, last_fetched_at, has_id_rows, no_good_video, updated_at) VALUES (?, NULL, ?, 0, 0, ?)').bind(recent, NOON - H, NOON).run()
    // An unsubscribed DJ's request.
    await waitingSet(env, 'gone', { slug: 'gone' })
    expect(await candidates(env)).toEqual([ok])
  })

  it('a set fetched before the cooldown (e.g. before the pause) is fed', async () => {
    const env = makeEnv()
    await subscribe(env, 'dj')
    const u = await waitingSet(env, 'old-fetch')
    await env.DB.prepare('INSERT INTO set_schedule (url, next_due_at, last_fetched_at, has_id_rows, no_good_video, updated_at) VALUES (?, ?, ?, 0, 0, ?)').bind(u, NOON + 60 * D, NOON - 9 * D, NOON).run()
    expect(await candidates(env)).toEqual([u])
    await env.DB.prepare('UPDATE set_schedule SET last_fetched_at = ? WHERE url = ?').bind(NOON - RENDER_FEED_REFETCH_COOLDOWN_SECONDS + 60, u).run()
    expect(await candidates(env)).toEqual([])
  })

  it('a recreation (set still resolves to the mkvid video it replaces) is fed', async () => {
    const env = makeEnv()
    await subscribe(env, 'dj')
    const u = await waitingSet(env, 'recreate')
    await env.DB.prepare("UPDATE tracklists SET video_id = 'mkvidvideo1', video_source = 'mkvid' WHERE url = ?").bind(u).run()
    await env.DB.prepare("UPDATE mkvid_requests SET replaces_video_id = 'mkvidvideo1' WHERE set_url = ?").bind(u).run()
    expect(await candidates(env)).toEqual([u])
  })

  it('respects the 7-day ID wait: a young set with ID rows waits, unless it has none or Render now skipped the wait', async () => {
    const env = makeEnv()
    await subscribe(env, 'dj')
    const young = await waitingSet(env, 'young-ids', { daysAgo: 3, trackCount: 10, idedCount: 8 })
    const clean = await waitingSet(env, 'young-clean', { daysAgo: 3, trackCount: 10, idedCount: 10 })
    const skipped = await waitingSet(env, 'young-skip', { daysAgo: 3, trackCount: 10, idedCount: 8 })
    await env.DB.prepare('UPDATE mkvid_requests SET skip_id_wait = 1 WHERE set_url = ?').bind(skipped).run()
    const old = await waitingSet(env, 'old-ids', { daysAgo: 8, trackCount: 10, idedCount: 8 })
    const got = await candidates(env)
    expect(got).not.toContain(young)
    expect(got).toEqual(expect.arrayContaining([clean, skipped, old]))
    // The stored list's own count wins over the request's: ID rows filled in since.
    const req = await env.DB.prepare('SELECT id FROM mkvid_requests WHERE set_url = ?').bind(young).first<{ id: string }>()
    await env.DB.prepare("INSERT INTO mkvid_request_tracks (request_id, tracks, track_count, trusted, id_rows, scraped_at) VALUES (?, '[]', 10, 0, 0, ?)").bind(req!.id, NOON).run()
    expect(await candidates(env)).toContain(young)
  })

  it('sits in the verify class: after new sets and due second fetches, before rechecks and backfill', async () => {
    const env = makeEnv()
    await subscribe(env, 'dj')
    const feedMe = await waitingSet(env, 'feed', { createdAt: NOON - 5 * D })
    const verifyMe = await waitingSet(env, 'verify')
    await env.DB.prepare(
      `INSERT INTO set_verification (url, state, fingerprint, row_count, first_account, first_fetched_at, verify_due_at, exclude_accounts, updated_at)
       VALUES (?, 'pending', 'f', 1, 'acct-1', ?, ?, '["acct-1"]', ?)`,
    ).bind(verifyMe, NOON - 3 * H, NOON - 60, NOON).run()
    const recheckMe = setUrl('recheck', 5)
    const young = setUrl('young', 1)
    const { loadSubState } = await import('../src/lib/sync-store')
    const st = (await loadSubState(env, 'dj'))!
    await saveSubState(env, 'dj', {
      ...st,
      discoveredTracklistUrls: [...st.discoveredTracklistUrls!, recheckMe, young],
      processedTracklistUrls: [...st.processedTracklistUrls!, recheckMe],
      tracklistVideos: { ...st.tracklistVideos, [recheckMe]: { videoId: 'v', checkedAt: NOON - 3 * D } },
    })
    await markSetDue(env, recheckMe, NOON - 10)
    const items = await pickTickItems(env, DEFAULT_POOL_SETTINGS, 10, new Set(['dj']), NOON)
    expect(items.map((i) => [i.kind, i.cls, 'url' in i ? i.url : i.slug])).toEqual([
      ['set', 'new', young],
      ['verify', 'verify', verifyMe],
      ['render_feed', 'verify', feedMe],
      ['recheck', 'recheck', recheckMe],
    ])
    // Moving verify in the order moves the feeder with it.
    const s: PoolSettings = { ...DEFAULT_POOL_SETTINGS, priorities: { ...DEFAULT_POOL_SETTINGS.priorities, order: ['recheck', 'new', 'verify', 'backfill'] } }
    expect((await pickTickItems(env, s, 10, new Set(['dj']), NOON)).map((i) => i.kind)).toEqual(['recheck', 'set', 'verify', 'render_feed'])
  })
})

describe('render feeder: daily cap and pacing', () => {
  /** `n` feed fetches recorded at `at` (render_feed rows, the day's count). */
  const fedAt = async (env: Env, n: number, at: number, tag = 'x') => {
    for (let i = 0; i < n; i++) {
      await env.DB.prepare('INSERT INTO render_feed (url, attempts, failures, last_attempt_at, next_feed_at, gave_up, updated_at) VALUES (?, 1, 0, ?, ?, 0, ?)')
        .bind(`https://www.1001tracklists.com/tracklist/${tag}${at}-${i}/x-2026-01-01.html`, at, at + 2 * D, at)
        .run()
    }
  }

  it('spreads renderFeedPerDay over the UTC day, one per tick at most, and stops at the cap', async () => {
    const env = makeEnv()
    const midnight = NOON - 12 * H
    const s = DEFAULT_POOL_SETTINGS // 40 a day
    expect(await renderFeedAllowance(env, s, midnight + 30)).toBe(1)
    await fedAt(env, 1, midnight + 30)
    expect(await renderFeedAllowance(env, s, midnight + 10 * 60)).toBe(0) // the next share is ~36 min in
    expect(await renderFeedAllowance(env, s, midnight + 37 * 60)).toBe(1)
    await fedAt(env, 4, midnight + 2 * H)
    expect(await renderFeedAllowance(env, s, NOON)).toBe(1) // 21 allowed by noon: behind, but still one per tick
    await fedAt(env, 35, midnight + 20 * H)
    expect(await renderFeedAllowance(env, s, midnight + D - 60)).toBe(0) // 40 today: the cap
    expect(await renderFeedAllowance(env, s, midnight + D + 60)).toBe(1) // a new UTC day
    expect(await renderFeedAllowance(env, { ...s, renderFeedPerDay: 0 }, NOON)).toBe(0)
  })

  it('catches up gently after a pause: at most the even rate + 1 an hour (3/h at 40 a day), never one per tick', async () => {
    const env = makeEnv()
    await subscribe(env, 'dj')
    for (let i = 0; i < 30; i++) await waitingSet(env, `c${String(i).padStart(2, '0')}`, { createdAt: NOON - 100 * D + i })
    // Nothing fed all morning (paused): by noon the day's share is 21.
    let fed = 0
    for (let t = NOON; t < NOON + 2 * H; t += 5 * 60) {
      const r = await runSchedulerTick(env, { random: always(0.99), now: t })
      fed += r.items.filter((x) => x.item.kind === 'render_feed' && x.outcome === 'ok').length
    }
    expect(fed).toBe(6) // 2 hours × 3
  })

  it('a tick that lost the race for the last slot (an overlapping tick) does not fetch', async () => {
    const env = makeEnv()
    await subscribe(env, 'dj')
    await waitingSet(env, 'race')
    const midnight = NOON - 12 * H
    // Picked while the slot was free; another tick took it before this one ran.
    const items = await pickTickItems(env, DEFAULT_POOL_SETTINGS, 3, new Set(['dj']), midnight + 60)
    expect(items.map((i) => i.kind)).toEqual(['render_feed'])
    await fedAt(env, 1, midnight + 60, 'other')
    const r = await runSchedulerTick(env, { random: always(0.99), now: midnight + 120 })
    expect(r.skipped).toBe('nothing_due') // the allowance is spent: not even picked
    // Two ticks that both picked before either ran: the D1 claim is atomic,
    // so only one gets the set, and only one gets the day's last slot.
    const env2 = makeEnv()
    const a = setUrl('a', 200)
    const b = setUrl('b', 200)
    expect(await claimRenderFeed(env2, DEFAULT_POOL_SETTINGS, a, midnight + 60)).toBeNull() // granted (no row before)
    expect(await claimRenderFeed(env2, DEFAULT_POOL_SETTINGS, a, midnight + 61)).toBe(false) // same set: cooling down
    expect(await claimRenderFeed(env2, DEFAULT_POOL_SETTINGS, b, midnight + 62)).toBe(false) // share so far (1) taken
    expect(await renderFeedUsed(env2, midnight + 62)).toBe(1)
  })

  it('does not rescan the requests every tick when there is nothing to feed', async () => {
    const env = makeEnv()
    await subscribe(env, 'dj')
    expect(await pickTickItems(env, DEFAULT_POOL_SETTINGS, 3, new Set(['dj']), NOON)).toEqual([])
    const u = await waitingSet(env, 'late')
    expect(await pickTickItems(env, DEFAULT_POOL_SETTINGS, 3, new Set(['dj']), NOON + 10 * 60)).toEqual([])
    expect((await pickTickItems(env, DEFAULT_POOL_SETTINGS, 3, new Set(['dj']), NOON + 31 * 60)).map((i) => 'url' in i && i.url)).toEqual([u])
  })

  it('a whole day of 5-minute ticks feeds exactly the cap, never two in one tick, never ahead of the pace', async () => {
    const env = makeEnv()
    await subscribe(env, 'dj')
    await updatePoolSettings(env, { renderFeedPerDay: 12 })
    for (let i = 0; i < 20; i++) await waitingSet(env, `s${String(i).padStart(2, '0')}`, { createdAt: NOON - 100 * D + i })
    const midnight = NOON - 12 * H
    let fed = 0
    for (let t = midnight + 60; t < midnight + D; t += 5 * 60) {
      const r = await runSchedulerTick(env, { random: always(0.99), now: t })
      const n = r.items.filter((x) => x.item.kind === 'render_feed').length
      expect(n).toBeLessThanOrEqual(1)
      fed += n
      expect(fed).toBeLessThanOrEqual(Math.floor((12 * (t - midnight)) / D) + 1)
    }
    expect(fed).toBe(12)
    expect(await renderFeedUsed(env, midnight + 60)).toBe(12)
    expect(mocked(fetch1001Html).mock.calls.every((c) => c[1].priority === 'verify' && c[1].kind === 'set' && !c[1].excludeAccounts?.length)).toBe(true)
    // Oldest requests went first.
    const fetched = mocked(fetch1001Html).mock.calls.map((c) => c[0] as string)
    expect(fetched[0]).toContain('/s00/')
    expect(fetched[11]).toContain('/s11/')
  })

  it('renderFeedPerDay is a pool setting: default 40, editable, validated', async () => {
    const env = makeEnv()
    expect((await getPoolSettings(env)).renderFeedPerDay).toBe(40)
    // A settings document saved before the setting existed keeps its values and gets the default.
    await env.SUBS.put(POOL_SETTINGS_KEY, JSON.stringify({ manualMaxFetches: 7 }))
    expect(await getPoolSettings(env)).toMatchObject({ manualMaxFetches: 7, renderFeedPerDay: 40 })
    expect(await updatePoolSettings(env, { renderFeedPerDay: 10 })).toMatchObject({ ok: true, settings: { renderFeedPerDay: 10 } })
    expect(await updatePoolSettings(env, { renderFeedPerDay: -1 })).toMatchObject({ ok: false })
    expect(await updatePoolSettings(env, { renderFeedPerDay: 1.5 })).toMatchObject({ ok: false })
    expect(POOL_PAGES.SETTINGS_PAGE_HTML).toContain('id="feed"')
    expect(POOL_PAGES.SETTINGS_PAGE_HTML).toContain('body.renderFeedPerDay')
  })
})

describe('render feeder: pause, pool refusals, and the verification that follows', () => {
  it('feeds nothing while ban:pause is set', async () => {
    const env = makeEnv()
    await subscribe(env, 'dj')
    await waitingSet(env, 'p')
    await setPause(env, 'manual', null)
    expect(await runSchedulerTick(env, { random: always(0.99), now: NOON })).toMatchObject({ skipped: 'paused' })
    expect(fetch1001Html).not.toHaveBeenCalled()
    expect(await renderFeedUsed(env, NOON)).toBe(0)
  })

  it('a budget refusal ends the tick, uses none of the day allowance, backs off, and the set stays a candidate', async () => {
    const env = makeEnv()
    await subscribe(env, 'dj')
    const u = await waitingSet(env, 'b')
    mocked(fetch1001Html).mockRejectedValue(new PoolPausedError('budget_exhausted', 900))
    const r = await runSchedulerTick(env, { random: always(0.99), now: NOON })
    expect(r.items.map((i) => [i.item.kind, i.outcome])).toEqual([['render_feed', 'stopped']])
    expect(r.stoppedBy).toMatch(/budget_exhausted/)
    expect(await renderFeedUsed(env, NOON)).toBe(0)
    expect(Number(await env.CACHE.get(TICK_BACKOFF_KEY))).toBe(NOON + 900)
    expect(await runSchedulerTick(env, { random: always(0.99), now: NOON + 60 })).toMatchObject({ skipped: 'backoff' })
    expect(fetch1001Html).toHaveBeenCalledTimes(1)
    // After its attempt backoff (15 min) it is picked again.
    expect(await candidates(env, NOON + 16 * 60)).toEqual([u])
  })

  it('the first fetch starts verification; the second fetch comes >= 2 h later from another account, and the set is not fed again', async () => {
    const env = makeEnv()
    await subscribe(env, 'dj')
    const u = await waitingSet(env, 'e2e')
    mocked(fetch1001Html).mockResolvedValue({ html: MATRODA, via: 'pool', state: { cookie: '' }, accountId: 'acct-1', fetchedAt: new Date(NOON * 1000).toISOString() })
    const r1 = await runSchedulerTick(env, { random: always(0.99), now: NOON })
    expect(r1.items.map((i) => [i.item.kind, i.outcome])).toEqual([['render_feed', 'ok']])
    expect(mocked(fetch1001Html).mock.calls[0]![1]).toMatchObject({ priority: 'verify', kind: 'set' })
    const v = (await getVerification(env, u))!
    expect(v).toMatchObject({ state: 'pending', first_account: 'acct-1' })
    expect(v.verify_due_at! - v.first_fetched_at).toBeGreaterThanOrEqual(2 * H)
    expect(await candidates(env, NOON + 10 * 60)).toEqual([])
    // The regular verify class takes it from here.
    mocked(fetch1001Html).mockResolvedValue({ html: MATRODA, via: 'pool', state: { cookie: '' }, accountId: 'acct-2', fetchedAt: new Date((v.verify_due_at! + 60) * 1000).toISOString() })
    const r2 = await runSchedulerTick(env, { random: always(0.99), now: v.verify_due_at! + 60 })
    expect(r2.items.map((i) => [i.item.kind, i.outcome])).toEqual([['verify', 'ok']])
    expect(mocked(fetch1001Html).mock.calls[1]![1]).toMatchObject({ priority: 'verify', excludeAccounts: ['acct-1'] })
    expect((await getVerification(env, u))!.state).toBe('verified')
  })

  it('a decoy first fetch starts nothing; the cooldown keeps the set from being fed again at once', async () => {
    const env = makeEnv()
    await subscribe(env, 'dj')
    const u = await waitingSet(env, 'decoy')
    // Stand-in for a decoy: a page the verification refuses (no rows) leaves no row.
    const r = await runSchedulerTick(env, { random: always(0.99), now: NOON })
    expect(r.items.map((i) => i.item.kind)).toEqual(['render_feed'])
    expect(await getVerification(env, u)).toBeNull()
    expect(await candidates(env, NOON + H)).toEqual([])
    // (last_fetched_at is stamped with the real clock, up to a day off NOON.)
    expect(await candidates(env, NOON + RENDER_FEED_REFETCH_COOLDOWN_SECONDS + D + 60)).toEqual([u])
  })
})

describe('render feeder: sets whose feed fetch fails (review MAJOR 1)', () => {
  const failing = [
    ['a 404 (set deleted on 1001tracklists)', () => new UpstreamHttpError(404, 'https://www.1001tracklists.com/tracklist/dead/x.html')],
    ['a 5xx', () => new UpstreamHttpError(503, 'https://www.1001tracklists.com/tracklist/dead/x.html')],
    ['a transport failure', () => new UpstreamTransportError('https://www.1001tracklists.com/tracklist/dead/x.html', 'socket hang up')],
  ] as const

  for (const [what, err] of failing) {
    it(`${what}: cooled down 2 d, 4 d, then given up after ${RENDER_FEED_MAX_FAILURES} failures; other sets keep being fed`, async () => {
      const env = makeEnv()
      await subscribe(env, 'dj')
      const dead = await waitingSet(env, 'dead', { createdAt: NOON - 50 * D }) // oldest: head of the queue
      const alive = await waitingSet(env, 'alive', { createdAt: NOON - 10 * D })
      mocked(fetch1001Html).mockImplementation(async (url: string) => {
        if (url === dead) throw err()
        return { html: '<set/>', via: 'pool', state: { cookie: '' }, accountId: 'acct-9', fetchedAt: new Date(NOON * 1000).toISOString() }
      })
      const tick = (t: number) => runSchedulerTick(env, { random: always(0.99), now: t })
      const r1 = await tick(NOON)
      expect(r1.items.map((i) => [i.item.kind, 'url' in i.item && i.item.url, i.outcome])).toEqual([['render_feed', dead, 'failed']])
      const row = () => env.DB.prepare('SELECT failures, gave_up, next_feed_at FROM render_feed WHERE url = ?').bind(dead).first<{ failures: number; gave_up: number; next_feed_at: number }>()
      expect(await row()).toEqual({ failures: 1, gave_up: 0, next_feed_at: NOON + 2 * D })
      // The failure counted towards the day's allowance.
      expect(await renderFeedUsed(env, NOON)).toBe(1)
      // Later the same day, well past the 15-minute attempt backoff: the dead set
      // is not fed again; the next one in line is.
      const r2 = await tick(NOON + H)
      expect(r2.items.map((i) => 'url' in i.item && i.item.url)).toEqual([alive])
      expect(await candidates(env, NOON + 2 * H)).toEqual([])
      // Second failure: 4 days. Third: given up for good.
      expect(await candidates(env, NOON + 2 * D + 60)).toContain(dead)
      await tick(NOON + 2 * D + 60)
      expect(await row()).toEqual({ failures: 2, gave_up: 0, next_feed_at: NOON + 2 * D + 60 + 4 * D })
      expect(await candidates(env, NOON + 5 * D)).not.toContain(dead)
      await tick(NOON + 6 * D + 120)
      expect(await row()).toMatchObject({ failures: 3, gave_up: 1 })
      expect(await candidates(env, NOON + 100 * D)).not.toContain(dead)
      expect(mocked(fetch1001Html).mock.calls.filter((c) => c[0] === dead)).toHaveLength(3)
    })
  }

  it('a success after a failure resets the failure count', async () => {
    const env = makeEnv()
    await subscribe(env, 'dj')
    const u = await waitingSet(env, 'flaky')
    mocked(fetch1001Html).mockRejectedValueOnce(new UpstreamHttpError(503, u))
    await runSchedulerTick(env, { random: always(0.99), now: NOON })
    await runSchedulerTick(env, { random: always(0.99), now: NOON + 2 * D + 60 })
    expect(await env.DB.prepare('SELECT failures, gave_up, attempts FROM render_feed WHERE url = ?').bind(u).first()).toEqual({ failures: 0, gave_up: 0, attempts: 2 })
  })
})
