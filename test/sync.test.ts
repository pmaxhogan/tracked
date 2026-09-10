import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../src/types'
import {
  backfillCombined,
  collectCombinedSources,
  dueRechecks,
  invalidateVideoCache,
  loadSubState,
  prettifySlug,
  RECHECK_INTERVAL_SECONDS,
  saveSubState,
  requeueBanVictims,
  seedTracklistVideosFromAudit,
  newFetchBudget,
  syncOne,
  syncPendingOnly,
  type SubState,
} from '../src/lib/sync'
import { PlaylistNotFoundError, YouTubeApiError } from '../src/lib/youtube-playlists'
import { makeLogger } from '../src/lib/log'
import { UpstreamPausedError, UpstreamUnavailableError } from '../src/lib/upstream1001'
import { IPBlockedError, CloudflareChallengeError } from '../src/lib/fetch'
import { _resetTallyForTests, setPause } from '../src/lib/ban-state'

// Stub the network-touching primitives so syncOne becomes a deterministic
// orchestrator test. This is the most important behavior to lock down: state
// transitions, dedup, the state-vs-fresh-token-vs-create cascade for the
// playlist, and per-set error isolation.
vi.mock('../src/lib/dj-index', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/dj-index')>('../src/lib/dj-index')
  return {
    ...actual,
    fetch1001Html: vi.fn(),
    crawlDjIndex: vi.fn(),
    parseSetYouTubeId: vi.fn(),
  }
})
vi.mock('../src/lib/youtube-playlists', async () => {
  const actual =
    await vi.importActual<typeof import('../src/lib/youtube-playlists')>('../src/lib/youtube-playlists')
  return {
    ...actual,
    findPlaylistByTitle: vi.fn(),
    createPlaylist: vi.fn(),
    listPlaylistVideoIds: vi.fn(),
    addVideoToPlaylist: vi.fn(),
    removeVideoFromPlaylist: vi.fn(),
  }
})

import { crawlDjIndex, fetch1001Html, parseSetYouTubeId } from '../src/lib/dj-index'
import {
  addVideoToPlaylist,
  createPlaylist,
  findPlaylistByTitle,
  listPlaylistVideoIds,
  removeVideoFromPlaylist,
} from '../src/lib/youtube-playlists'

const NOW = Math.floor(Date.now() / 1000)
/** A tracklistVideos entry checked just now — not due for another 5 days. */
const fresh = (videoId: string | null) => ({ videoId, checkedAt: NOW })
/** A tracklistVideos entry older than the recheck interval — due now. */
const stale = (videoId: string | null) => ({ videoId, checkedAt: NOW - RECHECK_INTERVAL_SECONDS - 60 })

function fakeKV(): KVNamespace {
  const store = new Map<string, { value: string; metadata?: unknown }>()
  return {
    async get(key: string, type?: 'json' | 'text') {
      const v = store.get(key)
      if (v === undefined) return null
      return type === 'json' ? JSON.parse(v.value) : v.value
    },
    async put(key: string, value: string, opts?: { metadata?: unknown }) {
      store.set(key, { value, metadata: opts?.metadata })
    },
    async delete(key: string) {
      store.delete(key)
    },
    // Ascending key order, like the real thing — the audit trails rely on it.
    async list({ prefix = '' }: { prefix?: string; cursor?: string; limit?: number } = {}) {
      const keys = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, v]) => ({ name, metadata: v.metadata }))
      return { keys, list_complete: true, cacheStatus: null }
    },
  } as unknown as KVNamespace
}

/** The `pladd:` audit rows a run wrote, newest-first (KV list order). */
async function playlistAdditions(env: Env) {
  const listed = await env.CACHE.list<Record<string, unknown>>({ prefix: 'pladd:' })
  return Promise.all(
    listed.keys.map(async (k) => ({
      key: k.name,
      metadata: k.metadata,
      record: (await env.CACHE.get(k.name, 'json')) as Record<string, unknown>,
    })),
  )
}

function makeEnv(): Env {
  return {
    CACHE: fakeKV(),
    SUBS: fakeKV(),
    API_TOKEN: 't',
    YOUTUBE_API_KEY: 'k',
  } as Env
}

const sub = { slug: 'lillypalmer', sourceUrl: 'https://www.1001tracklists.com/dj/lillypalmer/', addedAt: 0 }

function mockCrawl(tracklistUrls: string[], artistName: string | null = 'X') {
  ;(crawlDjIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
    artistName,
    tracklistUrls,
    pagesWalked: 1,
    stopReason: 'empty',
  })
}

beforeEach(() => {
  // resetAllMocks, not clearAllMocks: `mockClear` leaves implementations (and
  // queued `…Once` values) in place, so a mock configured by one test would
  // otherwise answer calls in the next one.
  vi.resetAllMocks()
  ;(fetch1001Html as ReturnType<typeof vi.fn>).mockResolvedValue({
    html: '<set/>',
    via: 'direct',
    state: { cookie: '' },
  })
  // A fresh Set per call: the sync mutates the returned set in place, and one
  // run now reads two playlists (the artist's and the combined one), so a
  // single shared instance would leak inserts from one into the other.
  ;(listPlaylistVideoIds as ReturnType<typeof vi.fn>).mockImplementation(async () => new Set<string>())
  ;(removeVideoFromPlaylist as ReturnType<typeof vi.fn>).mockResolvedValue(1)
})

describe('prettifySlug', () => {
  it('replaces separators and word-caps', () => {
    expect(prettifySlug('lilly_palmer')).toBe('Lilly Palmer')
    expect(prettifySlug('charlotte-de-witte')).toBe('Charlotte De Witte')
    expect(prettifySlug('boys.noize')).toBe('Boys Noize')
  })

  it('leaves run-on slugs alone (no way to split letter runs)', () => {
    expect(prettifySlug('lillypalmer')).toBe('Lillypalmer')
  })
})

describe('syncPendingOnly', () => {
  it('returns empty without calling YouTube when no sub has pending tracklists', async () => {
    const env = makeEnv()
    // Seed a subscription with state where discovered == processed (nothing pending).
    await env.SUBS.put('subs:list', JSON.stringify(['lillypalmer']))
    await env.SUBS.put(
      'subs:item:lillypalmer',
      JSON.stringify({ sourceUrl: 'https://www.1001tracklists.com/dj/lillypalmer/', addedAt: 0 }),
    )
    await env.SUBS.put(
      'subs:state:lillypalmer',
      JSON.stringify({
        playlistId: 'PL',
        artistName: 'Lilly Palmer',
        discoveredTracklistUrls: ['https://x/tracklist/a'],
        processedTracklistUrls: ['https://x/tracklist/a'],
        tracklistVideos: { 'https://x/tracklist/a': fresh('vidA1234567') },
      }),
    )

    const r = await syncPendingOnly(env)
    expect(r.results).toEqual([])
    // syncPendingOnly fast-skips before calling crawl/findPlaylist/etc.
    expect(crawlDjIndex).not.toHaveBeenCalled()
    expect(findPlaylistByTitle).not.toHaveBeenCalled()
    expect(addVideoToPlaylist).not.toHaveBeenCalled()
  })

  it('treats a sub with nothing pending but a stale recheck as work to do', async () => {
    const env = makeEnv()
    await env.SUBS.put('subs:list', JSON.stringify(['lillypalmer']))
    await env.SUBS.put(
      'subs:item:lillypalmer',
      JSON.stringify({ sourceUrl: 'https://www.1001tracklists.com/dj/lillypalmer/', addedAt: 0 }),
    )
    await saveSubState(env, 'lillypalmer', {
      playlistId: 'PL',
      artistName: 'Lilly Palmer',
      discoveredTracklistUrls: ['https://x/tracklist/a'],
      processedTracklistUrls: ['https://x/tracklist/a'],
      tracklistVideos: { 'https://x/tracklist/a': stale('vidA1234567') },
    })
    // No YouTube connection: the only way past the candidate scan is to throw here.
    await expect(syncPendingOnly(env)).rejects.toThrow(/not connected/)
  })

  it('returns empty for subs that have never been synced (no state row)', async () => {
    const env = makeEnv()
    await env.SUBS.put('subs:list', JSON.stringify(['fresh']))
    await env.SUBS.put(
      'subs:item:fresh',
      JSON.stringify({ sourceUrl: 'https://www.1001tracklists.com/dj/fresh/', addedAt: 0 }),
    )

    const r = await syncPendingOnly(env)
    expect(r.results).toEqual([])
  })
})

describe('combined playlist orchestration', () => {
  /** Subscribe `slug` and give it a synced state row (or none). */
  async function subscribe(env: Env, slug: string, state?: Partial<SubState>) {
    const list = ((await env.SUBS.get('subs:list', 'json')) as string[] | null) ?? []
    await env.SUBS.put('subs:list', JSON.stringify([...list, slug]))
    await env.SUBS.put(
      `subs:item:${slug}`,
      JSON.stringify({ sourceUrl: `https://www.1001tracklists.com/dj/${slug}/`, addedAt: 0 }),
    )
    if (state) await saveSubState(env, slug, { processedTracklistUrls: [], ...state })
  }

  /** A stored OAuth token that `getAccessToken` accepts without refreshing. */
  async function connectYouTube(env: Env) {
    await env.SUBS.put(
      'oauth:google',
      JSON.stringify({
        accessToken: 'tok',
        refreshToken: 'refresh',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        scope: 'https://www.googleapis.com/auth/youtube',
        channelId: null,
        channelTitle: null,
        connectedAt: 0,
      }),
    )
  }

  it('collects one source per subscription that has been synced', async () => {
    const env = makeEnv()
    await subscribe(env, 'synced', { playlistId: 'PLa', artistName: 'Synced' })
    await subscribe(env, 'never-synced')

    expect(await collectCombinedSources(env)).toEqual([
      { slug: 'synced', artistName: 'Synced', playlistId: 'PLa' },
    ])
  })

  it('skips the backfill when YouTube is not connected', async () => {
    const env = makeEnv()
    await subscribe(env, 'a', { playlistId: 'PLa' })

    expect(await backfillCombined(env)).toEqual({ ok: false, reason: 'youtube_not_connected' })
    expect(findPlaylistByTitle).not.toHaveBeenCalled()
  })

  it('skips the backfill (and creates no playlist) before anything has been synced', async () => {
    const env = makeEnv()
    await connectYouTube(env)
    await subscribe(env, 'fresh')

    expect(await backfillCombined(env)).toEqual({ ok: false, reason: 'no_sources' })
    expect(createPlaylist).not.toHaveBeenCalled()
  })

  it('backfills the union of every artist playlist into the combined one', async () => {
    const env = makeEnv()
    await connectYouTube(env)
    await subscribe(env, 'a', { playlistId: 'PLa', artistName: 'A' })
    await subscribe(env, 'b', { playlistId: 'PLb', artistName: 'B' })
    ;(findPlaylistByTitle as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    ;(createPlaylist as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'PLcombined',
      title: 'All tracked artists (1001tklists)',
    })
    ;(listPlaylistVideoIds as ReturnType<typeof vi.fn>).mockImplementation(async (playlistId: string) =>
      new Set(playlistId === 'PLa' ? ['aVid1234567'] : ['bVid1234567']),
    )

    const r = await backfillCombined(env, { trigger: 'manual.combined' })

    expect(r).toMatchObject({ ok: true, playlistId: 'PLcombined', inserted: 2, pending: 0 })
    expect((addVideoToPlaylist as ReturnType<typeof vi.fn>).mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['PLcombined', 'aVid1234567'],
      ['PLcombined', 'bVid1234567'],
    ])
  })
})

describe('syncOne', () => {
  it('creates a new playlist on first run, scrapes each set, adds non-duplicate videos, and writes state', async () => {
    const env = makeEnv()
    mockCrawl(['https://x/tracklist/a', 'https://x/tracklist/b', 'https://x/tracklist/c'], 'Lilly Palmer')
    ;(findPlaylistByTitle as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    ;(createPlaylist as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'PLnew', title: 'Lilly Palmer (1001tklists)' })
    ;(parseSetYouTubeId as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce('vidA1234567') // a → has video
      .mockReturnValueOnce(null) // b → no video
      .mockReturnValueOnce('vidC1234567') // c → has video

    const r = await syncOne(env, sub, 'tok')

    expect(r.ok).toBe(true)
    expect(r.playlistId).toBe('PLnew')
    // Two playlists get created on a virgin account: this artist's, and the
    // combined all-artists one every video is mirrored into.
    expect((createPlaylist as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].title)).toEqual([
      'Lilly Palmer (1001tklists)',
      'All tracked artists (1001tklists)',
    ])
    expect((createPlaylist as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
      title: 'Lilly Palmer (1001tklists)',
      privacyStatus: 'public',
      description: 'Every set Lilly Palmer has a YouTube recording for on 1001tracklists.',
    })
    expect(addVideoToPlaylist).toHaveBeenCalledTimes(4) // 2 videos × (artist + combined)
    expect(r.stats).toEqual({
      tracklistsSeen: 3,
      tracklistsProcessed: 3,
      videoIdsFound: 2,
      videoIdsAdded: 2,
      tracklistsPending: 0,
      combinedVideoIdsAdded: 2,
      tracklistsRechecked: 0,
      videosReplaced: 0,
      rechecksPending: 0,
    })

    // State persisted with all three URLs marked processed and the playlistId cached.
    const state = await loadSubState(env, sub.slug)
    expect(state?.playlistId).toBe('PLnew')
    expect(state?.artistName).toBe('Lilly Palmer')
    expect(state?.processedTracklistUrls).toEqual([
      'https://x/tracklist/a',
      'https://x/tracklist/b',
      'https://x/tracklist/c',
    ])
    // …and what each set resolved to, stamped now, so the recheck loop knows
    // both what to compare against and when to look again.
    expect(state?.tracklistVideos).toEqual({
      'https://x/tracklist/a': { videoId: 'vidA1234567', checkedAt: expect.any(Number) },
      'https://x/tracklist/b': { videoId: null, checkedAt: expect.any(Number) },
      'https://x/tracklist/c': { videoId: 'vidC1234567', checkedAt: expect.any(Number) },
    })
    expect(dueRechecks(state!)).toEqual([])
  })

  it('skips listPlaylistVideoIds after creating a fresh playlist (eventual-consistency 404 avoidance)', async () => {
    // YouTube\'s read API takes a few seconds to see a freshly-created
    // playlist; listing it immediately after create 404s with
    // playlistNotFound. A new playlist is empty by definition, so just skip.
    const env = makeEnv()
    mockCrawl(['https://x/tracklist/a'], 'Lilly Palmer')
    ;(findPlaylistByTitle as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    ;(createPlaylist as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'PLnew', title: 'Lilly Palmer (1001tklists)' })
    ;(parseSetYouTubeId as ReturnType<typeof vi.fn>).mockReturnValue('vidA1234567')

    const r = await syncOne(env, sub, 'tok')

    expect(r.ok).toBe(true)
    expect(listPlaylistVideoIds).not.toHaveBeenCalled()
    expect(addVideoToPlaylist).toHaveBeenCalledWith('PLnew', 'vidA1234567', 'tok')
  })

  it('reuses a same-titled playlist found by lookup instead of creating a new one', async () => {
    const env = makeEnv()
    mockCrawl(['https://x/tracklist/a'], 'Lilly Palmer')
    ;(findPlaylistByTitle as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'PLold', title: 'Lilly Palmer (1001tklists)' })
    ;(parseSetYouTubeId as ReturnType<typeof vi.fn>).mockReturnValue('vidA1234567')

    const r = await syncOne(env, sub, 'tok')

    expect(r.playlistId).toBe('PLold')
    expect(createPlaylist).not.toHaveBeenCalled()
    expect(addVideoToPlaylist).toHaveBeenCalledWith('PLold', 'vidA1234567', 'tok')
  })

  it('uses cached playlistId from state without calling list/create on subsequent runs', async () => {
    const env = makeEnv()
    await saveSubState(env, sub.slug, {
      playlistId: 'PLcached',
      artistName: 'Lilly Palmer',
      processedTracklistUrls: ['https://x/tracklist/old'],
      tracklistVideos: { 'https://x/tracklist/old': fresh('vidOld12345') },
    })
    mockCrawl(['https://x/tracklist/old', 'https://x/tracklist/new'], 'Lilly Palmer')
    ;(findPlaylistByTitle as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'PLcombined',
      title: 'All tracked artists (1001tklists)',
    })
    ;(parseSetYouTubeId as ReturnType<typeof vi.fn>).mockReturnValue('vidNew11234')

    await syncOne(env, sub, 'tok')

    // The artist playlist comes straight from state — the only title looked up
    // is the combined playlist's, which has no cached id in this state row.
    expect((findPlaylistByTitle as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([
      'All tracked artists (1001tklists)',
    ])
    expect(createPlaylist).not.toHaveBeenCalled()
    // Only the *new* tracklist URL is fetched / processed.
    expect(parseSetYouTubeId).toHaveBeenCalledTimes(1)
    expect(addVideoToPlaylist).toHaveBeenCalledWith('PLcached', 'vidNew11234', 'tok')
  })

  it('skips videos already in the playlist (defense against wiped state)', async () => {
    const env = makeEnv()
    mockCrawl(['https://x/tracklist/a'], 'X')
    ;(findPlaylistByTitle as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'PL', title: 'X (1001tklists)' })
    ;(listPlaylistVideoIds as ReturnType<typeof vi.fn>).mockResolvedValue(new Set(['alreadyIn12']))
    ;(parseSetYouTubeId as ReturnType<typeof vi.fn>).mockReturnValue('alreadyIn12')

    const r = await syncOne(env, sub, 'tok')

    expect(addVideoToPlaylist).not.toHaveBeenCalled()
    expect(r.stats.videoIdsFound).toBe(1)
    expect(r.stats.videoIdsAdded).toBe(0)
  })

  it('caps to maxSetsPerRun and leaves remaining URLs unprocessed for next run', async () => {
    const env = makeEnv()
    const urls = Array.from({ length: 50 }, (_, i) => `https://x/tracklist/${i}`)
    mockCrawl(urls, 'X')
    ;(findPlaylistByTitle as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'PL', title: 'X (1001tklists)' })
    ;(parseSetYouTubeId as ReturnType<typeof vi.fn>).mockReturnValue(null)

    await syncOne(env, sub, 'tok', { maxSetsPerRun: 5 })

    expect(parseSetYouTubeId).toHaveBeenCalledTimes(5)
    const state = (await loadSubState(env, sub.slug))!
    expect(state.processedTracklistUrls.length).toBe(5)
    expect(state.processedTracklistUrls).toEqual(urls.slice(0, 5))
  })

  it('continues past a per-set fetch failure without marking that URL processed', async () => {
    const env = makeEnv()
    mockCrawl(['https://x/tracklist/a', 'https://x/tracklist/b'], 'X')
    ;(findPlaylistByTitle as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'PL', title: 'X (1001tklists)' })
    // The DJ-index walk is mocked above; here we mock per-set fetches:
    // /a fails, /b succeeds.
    ;(fetch1001Html as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ html: '<set>', via: 'direct', state: { cookie: '' } })
    ;(parseSetYouTubeId as ReturnType<typeof vi.fn>).mockReturnValue('goodVid1234')

    const r = await syncOne(env, sub, 'tok')

    expect(r.stats.tracklistsProcessed).toBe(1)
    expect(r.stats.videoIdsAdded).toBe(1)
    const state = (await loadSubState(env, sub.slug))!
    expect(state.processedTracklistUrls).toEqual(['https://x/tracklist/b'])
  })

  it('falls back to the cached artistName when the DJ page parse misses the H1', async () => {
    const env = makeEnv()
    await saveSubState(env, sub.slug, {
      playlistId: 'PL',
      artistName: 'Lilly Palmer',
      processedTracklistUrls: [],
    } satisfies SubState)
    mockCrawl([], null)

    const r = await syncOne(env, sub, 'tok')
    expect(r.artistName).toBe('Lilly Palmer')
  })

  it('recovers when the cached playlistId 404s on listPlaylistVideoIds (stale state)', async () => {
    const env = makeEnv()
    await saveSubState(env, sub.slug, {
      playlistId: 'PLdeleted',
      artistName: 'X',
      processedTracklistUrls: [],
    })
    mockCrawl(['https://x/tracklist/a'], 'X')
    // First list call → 404, recovery flow re-resolves and returns empty.
    ;(listPlaylistVideoIds as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new PlaylistNotFoundError('playlistItems.list', 'PLdeleted'))
      .mockResolvedValueOnce(new Set())
    ;(findPlaylistByTitle as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'PLrecovered', title: 'X (1001tklists)' })
    ;(parseSetYouTubeId as ReturnType<typeof vi.fn>).mockReturnValue('newVid12345')

    const r = await syncOne(env, sub, 'tok')

    expect(r.ok).toBe(true)
    expect(r.playlistId).toBe('PLrecovered')
    expect(addVideoToPlaylist).toHaveBeenCalledWith('PLrecovered', 'newVid12345', 'tok')
    const state = (await loadSubState(env, sub.slug))!
    expect(state.playlistId).toBe('PLrecovered')
  })

  it('recovers when the playlist disappears mid-run on the first add', async () => {
    const env = makeEnv()
    mockCrawl(['https://x/tracklist/a', 'https://x/tracklist/b'], 'X')
    ;(findPlaylistByTitle as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ id: 'PL1', title: 'X (1001tklists)' })
      .mockResolvedValueOnce({ id: 'PL2', title: 'X (1001tklists)' })
    ;(parseSetYouTubeId as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce('vidFirst123')
      .mockReturnValueOnce('vidSecond12')
    ;(addVideoToPlaylist as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new PlaylistNotFoundError('playlistItems.insert', 'PL1'))
      .mockResolvedValue(undefined)

    const r = await syncOne(env, sub, 'tok')

    // Both videos end up in the recovered playlist.
    expect(r.playlistId).toBe('PL2')
    expect(addVideoToPlaylist).toHaveBeenCalledTimes(3) // failed insert on PL1 + retry on PL2 + second set on PL2
    const calls = (addVideoToPlaylist as ReturnType<typeof vi.fn>).mock.calls.map((c) => [c[0], c[1]])
    expect(calls).toEqual([
      ['PL1', 'vidFirst123'],
      ['PL2', 'vidFirst123'],
      ['PL2', 'vidSecond12'],
    ])
    expect(r.stats.videoIdsAdded).toBe(2)
  })

  it('skips the DJ crawl when skipDjCrawl=true and uses state.discoveredTracklistUrls instead', async () => {
    const env = makeEnv()
    await saveSubState(env, sub.slug, {
      playlistId: 'PLcached',
      artistName: 'Lilly Palmer',
      discoveredTracklistUrls: ['https://x/tracklist/a', 'https://x/tracklist/b'],
      processedTracklistUrls: ['https://x/tracklist/a'],
    })
    ;(parseSetYouTubeId as ReturnType<typeof vi.fn>).mockReturnValue('vidB12345678')

    const r = await syncOne(env, sub, 'tok', { skipDjCrawl: true })

    expect(crawlDjIndex).not.toHaveBeenCalled()
    expect(r.artistName).toBe('Lilly Palmer')
    expect(r.stats.tracklistsSeen).toBe(2)
    expect(r.stats.tracklistsProcessed).toBe(1) // only /b was pending
    expect(addVideoToPlaylist).toHaveBeenCalledWith('PLcached', 'vidB12345678', 'tok')
  })

  it('records one playlist-addition audit row per set, with the outcome of each', async () => {
    const env = makeEnv()
    mockCrawl(['https://x/tracklist/a', 'https://x/tracklist/b', 'https://x/tracklist/c'], 'Lilly Palmer')
    ;(findPlaylistByTitle as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'PL', title: 'Lilly Palmer (1001tklists)' })
    ;(listPlaylistVideoIds as ReturnType<typeof vi.fn>).mockResolvedValue(new Set(['dupeVid1234']))
    ;(parseSetYouTubeId as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce('newVid12345') // a → added
      .mockReturnValueOnce('dupeVid1234') // b → already in the playlist
      .mockReturnValueOnce(null) // c → set page has no YouTube recording

    await syncOne(env, sub, 'tok', { trigger: 'manual.one' })

    const rows = await playlistAdditions(env)
    expect(rows.map((r) => [r.record.setUrl, r.record.status])).toEqual([
      ['https://x/tracklist/c', 'no_youtube'],
      ['https://x/tracklist/b', 'duplicate'],
      ['https://x/tracklist/a', 'added'],
    ])
    expect(rows[2]!.record).toMatchObject({
      slug: 'lillypalmer',
      artistName: 'Lilly Palmer',
      status: 'added',
      videoId: 'newVid12345',
      videoUrl: 'https://www.youtube.com/watch?v=newVid12345',
      playlistId: 'PL',
      playlistTitle: 'Lilly Palmer (1001tklists)',
      via: 'direct',
      trigger: 'manual.one',
    })
    // Summary duplicated into KV metadata so the panel lists rows without a get.
    expect(rows[2]!.metadata).toMatchObject({
      status: 'added',
      slug: 'lillypalmer',
      artist: 'Lilly Palmer',
      set: 'https://x/tracklist/a',
      vid: 'newVid12345',
      trg: 'manual.one',
    })
    // Inverted timestamp + inverted batch index, so ascending KV order is
    // newest-first even for sets that resolve inside the same millisecond.
    expect(rows.every((r) => /^pladd:\d{14}:lillypalmer:\d{4}$/.test(r.key))).toBe(true)
  })

  it('records a failed row per set error, and an abandoned row once it gives up', async () => {
    const env = makeEnv()
    await saveSubState(env, sub.slug, {
      playlistId: 'PL',
      artistName: 'X',
      discoveredTracklistUrls: ['https://x/tracklist/bad'],
      processedTracklistUrls: [],
      // Two prior failures — this run's failure is the third and abandons it.
      failureCounts: { 'https://x/tracklist/bad': 2 },
    })
    ;(fetch1001Html as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ip_blocked (1.2.3.4)'))

    await syncOne(env, sub, 'tok', { skipDjCrawl: true, trigger: 'cron.pending' })

    const rows = await playlistAdditions(env)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.record).toMatchObject({
      status: 'abandoned',
      setUrl: 'https://x/tracklist/bad',
      message: 'ip_blocked (1.2.3.4)',
      failureCount: 3,
      videoId: null,
      trigger: 'cron.pending',
    })
  })

  it('writes no audit rows when a run processes nothing', async () => {
    const env = makeEnv()
    mockCrawl([], 'X')
    ;(findPlaylistByTitle as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'PL', title: 'X (1001tklists)' })

    await syncOne(env, sub, 'tok')

    expect(await playlistAdditions(env)).toEqual([])
  })

  it('keeps syncing when the audit write fails (diagnostics never break a run)', async () => {
    const env = makeEnv()
    mockCrawl(['https://x/tracklist/a'], 'X')
    ;(findPlaylistByTitle as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'PL', title: 'X (1001tklists)' })
    ;(parseSetYouTubeId as ReturnType<typeof vi.fn>).mockReturnValue('vidA1234567')
    const realPut = env.CACHE.put.bind(env.CACHE)
    vi.spyOn(env.CACHE, 'put').mockImplementation(async (key: string, ...rest: unknown[]) => {
      if (key.startsWith('pladd:')) throw new Error('KV write limit')
      return (realPut as (...a: unknown[]) => Promise<void>)(key, ...rest)
    })

    const r = await syncOne(env, sub, 'tok')

    expect(r.ok).toBe(true)
    expect(r.stats.videoIdsAdded).toBe(1)
  })

  // ── Combined "all tracked artists" playlist mirror ────────────────────────

  it('mirrors every new video into the combined playlist and records the outcome', async () => {
    const env = makeEnv()
    await saveSubState(env, sub.slug, {
      playlistId: 'PLartist',
      artistName: 'X',
      discoveredTracklistUrls: ['https://x/tracklist/a'],
      processedTracklistUrls: [],
    })
    ;(findPlaylistByTitle as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'PLcombined',
      title: 'All tracked artists (1001tklists)',
    })
    ;(parseSetYouTubeId as ReturnType<typeof vi.fn>).mockReturnValue('vidA1234567')

    const r = await syncOne(env, sub, 'tok', { skipDjCrawl: true })

    expect((addVideoToPlaylist as ReturnType<typeof vi.fn>).mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['PLartist', 'vidA1234567'],
      ['PLcombined', 'vidA1234567'],
    ])
    expect(r.combinedPlaylistId).toBe('PLcombined')
    expect(r.stats.combinedVideoIdsAdded).toBe(1)
    const rows = await playlistAdditions(env)
    expect(rows[0]!.record).toMatchObject({ status: 'added', combinedStatus: 'added' })
    expect(rows[0]!.metadata).toMatchObject({ cmb: 'added' })
  })

  it('mirrors a set already in the artist playlist but missing from the combined one', async () => {
    // This is the shape of the backfill at the per-set level: the artist
    // playlist has had this video since before the combined playlist existed.
    const env = makeEnv()
    await saveSubState(env, sub.slug, {
      playlistId: 'PLartist',
      artistName: 'X',
      discoveredTracklistUrls: ['https://x/tracklist/a'],
      processedTracklistUrls: [],
    })
    ;(findPlaylistByTitle as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'PLcombined',
      title: 'All tracked artists (1001tklists)',
    })
    ;(listPlaylistVideoIds as ReturnType<typeof vi.fn>).mockImplementation(async (playlistId: string) =>
      new Set(playlistId === 'PLartist' ? ['oldVid12345'] : []),
    )
    ;(parseSetYouTubeId as ReturnType<typeof vi.fn>).mockReturnValue('oldVid12345')

    const r = await syncOne(env, sub, 'tok', { skipDjCrawl: true })

    expect((addVideoToPlaylist as ReturnType<typeof vi.fn>).mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['PLcombined', 'oldVid12345'],
    ])
    expect(r.stats.videoIdsAdded).toBe(0)
    expect(r.stats.combinedVideoIdsAdded).toBe(1)
    const rows = await playlistAdditions(env)
    expect(rows[0]!.record).toMatchObject({ status: 'duplicate', combinedStatus: 'added' })
  })

  it('keeps syncing when the combined playlist cannot be opened', async () => {
    const env = makeEnv()
    await saveSubState(env, sub.slug, {
      playlistId: 'PLartist',
      artistName: 'X',
      discoveredTracklistUrls: ['https://x/tracklist/a', 'https://x/tracklist/b'],
      processedTracklistUrls: [],
    })
    // Only the combined playlist needs a title lookup here (the artist one is
    // cached in state), so this fails exactly that resolution.
    ;(findPlaylistByTitle as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('youtube playlists.list 403: quotaExceeded'),
    )
    ;(parseSetYouTubeId as ReturnType<typeof vi.fn>).mockReturnValue('vidA1234567')

    const r = await syncOne(env, sub, 'tok', { skipDjCrawl: true })

    expect(r.ok).toBe(true)
    expect(r.stats.tracklistsProcessed).toBe(2)
    expect(r.stats.combinedVideoIdsAdded).toBe(0)
    // Resolution is attempted once, not once per set.
    expect(findPlaylistByTitle).toHaveBeenCalledTimes(1)
    const rows = await playlistAdditions(env)
    expect(rows.map((x) => x.record.combinedStatus)).toEqual(['unavailable', 'unavailable'])
  })

  it('falls back to a prettified slug when no name is available anywhere', async () => {
    const env = makeEnv()
    mockCrawl([], null)
    ;(findPlaylistByTitle as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    ;(createPlaylist as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'PLx', title: 'Lillypalmer (1001tklists)' })

    const r = await syncOne(env, sub, 'tok')
    expect(r.artistName).toBe('Lillypalmer')
    expect((createPlaylist as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
      title: 'Lillypalmer (1001tklists)',
    })
  })
  // ── Rechecks: re-fetch processed sets to catch a swapped recording ────────

  /** A synced sub with one processed set, ready for the recheck loop. */
  async function seedProcessed(env: Env, tracklistVideos: SubState['tracklistVideos'], extra: Partial<SubState> = {}) {
    const urls = Object.keys(tracklistVideos ?? {})
    await saveSubState(env, sub.slug, {
      playlistId: 'PLartist',
      artistName: 'X',
      discoveredTracklistUrls: urls,
      processedTracklistUrls: urls,
      tracklistVideos,
      ...extra,
    })
  }

  function combinedExists(videoIds: string[] = []) {
    ;(findPlaylistByTitle as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'PLcombined',
      title: 'All tracked artists (1001tklists)',
    })
    ;(listPlaylistVideoIds as ReturnType<typeof vi.fn>).mockImplementation(async () => new Set(videoIds))
  }

  it('leaves a set alone until its record is older than the recheck interval', async () => {
    const env = makeEnv()
    await seedProcessed(env, { 'https://x/tracklist/a': fresh('vidA1234567') })

    const r = await syncOne(env, sub, 'tok', { skipDjCrawl: true })

    expect(fetch1001Html).not.toHaveBeenCalled()
    expect(r.stats.tracklistsRechecked).toBe(0)
    expect(r.stats.rechecksPending).toBe(0)
  })

  it('rechecks a stale set and, when nothing changed, touches neither YouTube nor the audit trail', async () => {
    const env = makeEnv()
    await seedProcessed(env, { 'https://x/tracklist/a': stale('vidA1234567') })
    combinedExists(['vidA1234567'])
    ;(parseSetYouTubeId as ReturnType<typeof vi.fn>).mockReturnValue('vidA1234567')

    const r = await syncOne(env, sub, 'tok', { skipDjCrawl: true })

    expect(fetch1001Html).toHaveBeenCalledWith('https://x/tracklist/a', expect.anything())
    expect(addVideoToPlaylist).not.toHaveBeenCalled()
    expect(removeVideoFromPlaylist).not.toHaveBeenCalled()
    expect(r.stats).toMatchObject({ tracklistsRechecked: 1, videosReplaced: 0, rechecksPending: 0 })
    expect(await playlistAdditions(env)).toEqual([])
    const state = (await loadSubState(env, sub.slug))!
    expect(state.tracklistVideos!['https://x/tracklist/a']!.videoId).toBe('vidA1234567')
    expect(state.tracklistVideos!['https://x/tracklist/a']!.checkedAt).toBeGreaterThanOrEqual(NOW)
  })

  it('replaces a swapped recording: old out of both playlists, new into both', async () => {
    const env = makeEnv()
    await seedProcessed(env, { 'https://x/tracklist/a': stale('phoneVid123') })
    combinedExists(['phoneVid123'])
    ;(parseSetYouTubeId as ReturnType<typeof vi.fn>).mockReturnValue('officialV12')

    const r = await syncOne(env, sub, 'tok', { skipDjCrawl: true, trigger: 'cron.pending' })

    expect((removeVideoFromPlaylist as ReturnType<typeof vi.fn>).mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['PLartist', 'phoneVid123'],
      ['PLcombined', 'phoneVid123'],
    ])
    expect((addVideoToPlaylist as ReturnType<typeof vi.fn>).mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['PLartist', 'officialV12'],
      ['PLcombined', 'officialV12'],
    ])
    expect(r.stats).toMatchObject({ videoIdsAdded: 1, tracklistsRechecked: 1, videosReplaced: 1, combinedVideoIdsAdded: 1 })
    const state = (await loadSubState(env, sub.slug))!
    expect(state.tracklistVideos!['https://x/tracklist/a']!.videoId).toBe('officialV12')
    // Both membership caches reflect the swap, so the next tick doesn't re-list.
    expect(await env.CACHE.get('yt:plvids:PLartist', 'json')).toEqual({ videoIds: ['officialV12'] })
    expect(await env.CACHE.get('yt:plvids:PLcombined', 'json')).toEqual({ videoIds: ['officialV12'] })
    const rows = await playlistAdditions(env)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.record).toMatchObject({
      status: 'replaced',
      videoId: 'officialV12',
      previousVideoId: 'phoneVid123',
      combinedStatus: 'added',
      trigger: 'cron.pending',
    })
    expect(rows[0]!.metadata).toMatchObject({ status: 'replaced', vid: 'officialV12', prev: 'phoneVid123' })
  })

  it('still swaps when the old video was already removed by hand', async () => {
    const env = makeEnv()
    await seedProcessed(env, { 'https://x/tracklist/a': stale('phoneVid123') })
    combinedExists([]) // neither playlist has the phone recording any more
    ;(parseSetYouTubeId as ReturnType<typeof vi.fn>).mockReturnValue('officialV12')

    const r = await syncOne(env, sub, 'tok', { skipDjCrawl: true })

    expect(removeVideoFromPlaylist).not.toHaveBeenCalled()
    expect((addVideoToPlaylist as ReturnType<typeof vi.fn>).mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['PLartist', 'officialV12'],
      ['PLcombined', 'officialV12'],
    ])
    expect(r.stats.videosReplaced).toBe(1)
  })

  it('never re-adds an unchanged video the user removed from the playlist', async () => {
    const env = makeEnv()
    await seedProcessed(env, { 'https://x/tracklist/a': stale('phoneVid123') })
    combinedExists([]) // user pruned it from both playlists
    ;(parseSetYouTubeId as ReturnType<typeof vi.fn>).mockReturnValue('phoneVid123')

    await syncOne(env, sub, 'tok', { skipDjCrawl: true })

    expect(addVideoToPlaylist).not.toHaveBeenCalled()
  })

  it('keeps the existing video when the set page no longer has one', async () => {
    const env = makeEnv()
    await seedProcessed(env, { 'https://x/tracklist/a': stale('vidA1234567') })
    combinedExists(['vidA1234567'])
    ;(parseSetYouTubeId as ReturnType<typeof vi.fn>).mockReturnValue(null)

    const r = await syncOne(env, sub, 'tok', { skipDjCrawl: true })

    expect(removeVideoFromPlaylist).not.toHaveBeenCalled()
    expect(r.stats.videosReplaced).toBe(0)
    const state = (await loadSubState(env, sub.slug))!
    expect(state.tracklistVideos!['https://x/tracklist/a']).toEqual({ videoId: 'vidA1234567', checkedAt: expect.any(Number) })
    expect(dueRechecks(state)).toEqual([])
  })

  it('adds the video when a set that had none gains one', async () => {
    const env = makeEnv()
    await seedProcessed(env, { 'https://x/tracklist/a': stale(null) })
    combinedExists([])
    ;(parseSetYouTubeId as ReturnType<typeof vi.fn>).mockReturnValue('newVid12345')

    const r = await syncOne(env, sub, 'tok', { skipDjCrawl: true })

    expect(removeVideoFromPlaylist).not.toHaveBeenCalled()
    expect((addVideoToPlaylist as ReturnType<typeof vi.fn>).mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['PLartist', 'newVid12345'],
      ['PLcombined', 'newVid12345'],
    ])
    expect(r.stats).toMatchObject({ videoIdsAdded: 1, videosReplaced: 0, tracklistsRechecked: 1 })
    const rows = await playlistAdditions(env)
    expect(rows[0]!.record).toMatchObject({ status: 'added', videoId: 'newVid12345', combinedStatus: 'added' })
  })

  it('only records a baseline for a set processed before rechecks existed (no audit row to seed from)', async () => {
    const env = makeEnv()
    // Legacy state: processed, but no tracklistVideos at all.
    await saveSubState(env, sub.slug, {
      playlistId: 'PLartist',
      artistName: 'X',
      discoveredTracklistUrls: ['https://x/tracklist/a'],
      processedTracklistUrls: ['https://x/tracklist/a'],
    })
    combinedExists([]) // whatever it once had is gone — we can't tell "never added" from "removed by hand"
    ;(parseSetYouTubeId as ReturnType<typeof vi.fn>).mockReturnValue('someVid1234')

    const r = await syncOne(env, sub, 'tok', { skipDjCrawl: true })

    expect(fetch1001Html).toHaveBeenCalledTimes(1)
    expect(addVideoToPlaylist).not.toHaveBeenCalled()
    expect(removeVideoFromPlaylist).not.toHaveBeenCalled()
    expect(r.stats).toMatchObject({ tracklistsRechecked: 1, videosReplaced: 0, videoIdsAdded: 0 })
    const state = (await loadSubState(env, sub.slug))!
    expect(state.tracklistVideos).toEqual({ 'https://x/tracklist/a': { videoId: 'someVid1234', checkedAt: expect.any(Number) } })
    // Next time it's a real comparison.
    ;(parseSetYouTubeId as ReturnType<typeof vi.fn>).mockReturnValue('betterVid12')
    await invalidateVideoCache(env, sub.slug, makeLogger({ task: 'test' }))
    const r2 = await syncOne(env, sub, 'tok', { skipDjCrawl: true })
    expect(r2.stats.videosReplaced).toBe(1)
    expect(addVideoToPlaylist).toHaveBeenCalledWith('PLartist', 'betterVid12', 'tok')
  })

  it('seeds the baseline from the audit trail on the first run after upgrade, so an old swap is caught', async () => {
    const env = makeEnv()
    await saveSubState(env, sub.slug, {
      playlistId: 'PLartist',
      artistName: 'X',
      discoveredTracklistUrls: ['https://x/tracklist/a', 'https://x/tracklist/b', 'https://x/tracklist/c'],
      processedTracklistUrls: ['https://x/tracklist/a', 'https://x/tracklist/b', 'https://x/tracklist/c'],
    })
    // Audit rows from an earlier run: /a was added with the phone recording,
    // /b had no video, /c has no surviving row.
    const t = new Date(Date.now() - 6 * 86400 * 1000).toISOString()
    await env.CACHE.put('pladd:00000000000001:lillypalmer:9999', '{}', {
      metadata: { t, status: 'added', slug: 'lillypalmer', set: 'https://x/tracklist/a', vid: 'phoneVid123' },
    })
    await env.CACHE.put('pladd:00000000000001:lillypalmer:9998', '{}', {
      metadata: { t, status: 'no_youtube', slug: 'lillypalmer', set: 'https://x/tracklist/b', vid: null },
    })
    // A row for another DJ's set with the same URL shape must not bleed in.
    await env.CACHE.put('pladd:00000000000002:other:9999', '{}', {
      metadata: { t, status: 'added', slug: 'other', set: 'https://x/tracklist/c', vid: 'otherVid123' },
    })
    combinedExists(['phoneVid123'])
    ;(parseSetYouTubeId as ReturnType<typeof vi.fn>).mockImplementation(() => 'officialV12')

    const r = await syncOne(env, sub, 'tok', { skipDjCrawl: true })

    // All three are stale (6 days / never), so all three get rechecked; only
    // /a has a baseline that differs, /b gains a video, /c just records.
    expect(r.stats).toMatchObject({ tracklistsRechecked: 3, videosReplaced: 1 })
    expect((removeVideoFromPlaylist as ReturnType<typeof vi.fn>).mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['PLartist', 'phoneVid123'],
      ['PLcombined', 'phoneVid123'],
    ])
    // Skip the planted seed rows (their bodies are empty) — only this run's rows matter.
    // /b's row is `duplicate`: every page here resolves to the same video, and
    // /a's swap had already inserted it by the time /b was rechecked.
    const rows = (await playlistAdditions(env)).filter((x) => x.record.status)
    expect(rows.map((x) => [x.record.setUrl, x.record.status])).toEqual([
      ['https://x/tracklist/b', 'duplicate'],
      ['https://x/tracklist/a', 'replaced'],
    ])
  })

  it('keeps the old video when another set of the same DJ still resolves to it', async () => {
    const env = makeEnv()
    await seedProcessed(env, {
      'https://x/tracklist/a': stale('sharedVid12'),
      'https://x/tracklist/b': fresh('sharedVid12'),
    })
    combinedExists(['sharedVid12'])
    ;(parseSetYouTubeId as ReturnType<typeof vi.fn>).mockReturnValue('officialV12')

    const r = await syncOne(env, sub, 'tok', { skipDjCrawl: true })

    expect(removeVideoFromPlaylist).not.toHaveBeenCalled()
    expect(addVideoToPlaylist).toHaveBeenCalledWith('PLartist', 'officialV12', 'tok')
    expect(r.stats.videosReplaced).toBe(1)
  })

  it("keeps the old video in the combined playlist when another DJ's set still resolves to it", async () => {
    const env = makeEnv()
    await env.SUBS.put('subs:list', JSON.stringify(['lillypalmer', 'b2bpartner']))
    await env.SUBS.put('subs:item:lillypalmer', JSON.stringify({ sourceUrl: 'x', addedAt: 0 }))
    await env.SUBS.put('subs:item:b2bpartner', JSON.stringify({ sourceUrl: 'x', addedAt: 0 }))
    await seedProcessed(env, { 'https://x/tracklist/a': stale('b2bVid12345') })
    await saveSubState(env, 'b2bpartner', {
      playlistId: 'PLpartner',
      processedTracklistUrls: ['https://x/tracklist/same-set'],
      tracklistVideos: { 'https://x/tracklist/same-set': fresh('b2bVid12345') },
    })
    combinedExists(['b2bVid12345'])
    ;(parseSetYouTubeId as ReturnType<typeof vi.fn>).mockReturnValue('officialV12')

    await syncOne(env, sub, 'tok', { skipDjCrawl: true })

    // Removed from this DJ's playlist only — the combined one still needs it.
    expect((removeVideoFromPlaylist as ReturnType<typeof vi.fn>).mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['PLartist', 'b2bVid12345'],
    ])
  })

  it('caps rechecks per run and reports the rest as pending', async () => {
    const env = makeEnv()
    const map: NonNullable<SubState['tracklistVideos']> = {}
    for (let i = 0; i < 7; i++) map[`https://x/tracklist/${i}`] = stale(`vid${i}12345678`.slice(0, 11))
    await seedProcessed(env, map)
    combinedExists([])
    ;(parseSetYouTubeId as ReturnType<typeof vi.fn>).mockImplementation(() => null)

    const r = await syncOne(env, sub, 'tok', { skipDjCrawl: true, maxRechecksPerRun: 3 })

    expect(fetch1001Html).toHaveBeenCalledTimes(3)
    expect(r.stats).toMatchObject({ tracklistsRechecked: 3, rechecksPending: 4 })
  })

  it('processes new sets before rechecks, so a backfill is never starved', async () => {
    const env = makeEnv()
    await saveSubState(env, sub.slug, {
      playlistId: 'PLartist',
      artistName: 'X',
      discoveredTracklistUrls: ['https://x/tracklist/old', 'https://x/tracklist/new'],
      processedTracklistUrls: ['https://x/tracklist/old'],
      tracklistVideos: { 'https://x/tracklist/old': stale('oldVid12345') },
    })
    combinedExists(['oldVid12345'])
    ;(parseSetYouTubeId as ReturnType<typeof vi.fn>).mockReturnValueOnce('newVid12345').mockReturnValueOnce('oldVid12345')

    const r = await syncOne(env, sub, 'tok', { skipDjCrawl: true })

    expect((fetch1001Html as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([
      'https://x/tracklist/new',
      'https://x/tracklist/old',
    ])
    expect(r.stats).toMatchObject({ tracklistsProcessed: 1, videoIdsAdded: 1, tracklistsRechecked: 1, videosReplaced: 0 })
  })

  it('defers a set whose recheck keeps failing instead of abandoning it', async () => {
    const env = makeEnv()
    await seedProcessed(env, { 'https://x/tracklist/a': stale('vidA1234567') }, {
      failureCounts: { 'https://x/tracklist/a': 2 },
    })
    ;(fetch1001Html as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('cf shell'))

    const r = await syncOne(env, sub, 'tok', { skipDjCrawl: true })

    expect(r.stats.tracklistsRechecked).toBe(0)
    const state = (await loadSubState(env, sub.slug))!
    expect(state.abandonedTracklistUrls).toEqual([])
    expect(state.failureCounts).toEqual({})
    // Video kept, timestamp bumped: due again next interval, not next tick.
    expect(state.tracklistVideos!['https://x/tracklist/a']!.videoId).toBe('vidA1234567')
    expect(dueRechecks(state)).toEqual([])
    const rows = await playlistAdditions(env)
    expect(rows[0]!.record).toMatchObject({ status: 'failed', videoId: 'vidA1234567', failureCount: 3 })
  })

  it('stops rechecking on a quota error and leaves the swap due, uncharged', async () => {
    const env = makeEnv()
    await seedProcessed(env, {
      'https://x/tracklist/a': stale('phoneVid123'),
      'https://x/tracklist/b': stale('vidB1234567'),
    })
    combinedExists(['phoneVid123', 'vidB1234567'])
    ;(parseSetYouTubeId as ReturnType<typeof vi.fn>).mockReturnValue('officialV12')
    ;(addVideoToPlaylist as ReturnType<typeof vi.fn>).mockRejectedValue(
      new YouTubeApiError('playlistItems.insert', 403, 'quotaExceeded', '{}'),
    )

    const r = await syncOne(env, sub, 'tok', { skipDjCrawl: true })

    // /a's swap got as far as the removals, then the insert hit quota; /b was never fetched.
    expect(fetch1001Html).toHaveBeenCalledTimes(1)
    expect(r.stats).toMatchObject({ tracklistsRechecked: 0, videosReplaced: 0, rechecksPending: 2 })
    const state = (await loadSubState(env, sub.slug))!
    expect(state.failureCounts).toEqual({})
    expect(state.tracklistVideos!['https://x/tracklist/a']!.videoId).toBe('phoneVid123')
    expect(await playlistAdditions(env)).toEqual([])
  })

  it('leaves a transiently failing recheck due for the next tick', async () => {
    const env = makeEnv()
    await seedProcessed(env, { 'https://x/tracklist/a': stale('vidA1234567') })
    ;(fetch1001Html as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('transient'))

    const r = await syncOne(env, sub, 'tok', { skipDjCrawl: true })

    expect(r.stats.rechecksPending).toBe(1)
    const state = (await loadSubState(env, sub.slug))!
    expect(state.failureCounts).toEqual({ 'https://x/tracklist/a': 1 })
    expect(dueRechecks(state)).toEqual(['https://x/tracklist/a'])
  })
})

describe('seedTracklistVideosFromAudit', () => {
  it('takes the newest row per set, only for this slug and only for processed URLs', async () => {
    const env = makeEnv()
    const put = (key: string, m: Record<string, unknown>) => env.CACHE.put(key, '{}', { metadata: m })
    // Keys ascend = newest first, like the real inverted-timestamp layout.
    await put('pladd:1:s:9999', { t: '2026-09-01T00:00:00Z', status: 'replaced', slug: 's', set: 'u1', vid: 'newVid12345' })
    await put('pladd:2:s:9999', { t: '2026-08-01T00:00:00Z', status: 'added', slug: 's', set: 'u1', vid: 'oldVid12345' })
    await put('pladd:3:s:9999', { t: '2026-08-01T00:00:00Z', status: 'no_youtube', slug: 's', set: 'u2', vid: null })
    await put('pladd:4:s:9999', { t: '2026-08-01T00:00:00Z', status: 'failed', slug: 's', set: 'u3', vid: null })
    await put('pladd:5:s:9999', { t: '2026-08-01T00:00:00Z', status: 'added', slug: 's', set: 'unprocessed', vid: 'x1234567890' })
    await put('pladd:6:t:9999', { t: '2026-08-01T00:00:00Z', status: 'added', slug: 't', set: 'u3', vid: 'otherVid123' })

    const seeded = await seedTracklistVideosFromAudit(env, 's', new Set(['u1', 'u2', 'u3']), makeLogger({ task: 'test' }))

    expect(seeded).toEqual({
      u1: { videoId: 'newVid12345', checkedAt: Math.floor(Date.parse('2026-09-01T00:00:00Z') / 1000) },
      u2: { videoId: null, checkedAt: Math.floor(Date.parse('2026-08-01T00:00:00Z') / 1000) },
    })
  })

  it('returns what it has when the list call throws', async () => {
    const env = makeEnv()
    vi.spyOn(env.CACHE, 'list').mockRejectedValue(new Error('kv down'))
    expect(await seedTracklistVideosFromAudit(env, 's', new Set(['u1']), makeLogger({ task: 'test' }))).toEqual({})
  })
})

describe('invalidateVideoCache', () => {
  it('marks every processed set due, keeps its recorded video, clears abandons, and drops both membership caches', async () => {
    const env = makeEnv()
    await saveSubState(env, sub.slug, {
      playlistId: 'PLartist',
      artistName: 'X',
      discoveredTracklistUrls: ['https://x/tracklist/a', 'https://x/tracklist/dead'],
      processedTracklistUrls: ['https://x/tracklist/a'],
      abandonedTracklistUrls: ['https://x/tracklist/dead'],
      failureCounts: { 'https://x/tracklist/dead': 3 },
      tracklistVideos: { 'https://x/tracklist/a': fresh('vidA1234567') },
    })
    await env.SUBS.put('subs:combined', JSON.stringify({ playlistId: 'PLcombined' }))
    await env.CACHE.put('yt:plvids:PLartist', JSON.stringify({ videoIds: ['vidA1234567'] }))
    await env.CACHE.put('yt:plvids:PLcombined', JSON.stringify({ videoIds: ['vidA1234567'] }))

    const r = await invalidateVideoCache(env, sub.slug, makeLogger({ task: 'test' }))

    expect(r).toEqual({ slug: sub.slug, tracklistsMarked: 1, abandonedCleared: 1 })
    const state = (await loadSubState(env, sub.slug))!
    expect(state.tracklistVideos).toEqual({ 'https://x/tracklist/a': { videoId: 'vidA1234567', checkedAt: 0 } })
    expect(state.abandonedTracklistUrls).toEqual([])
    expect(state.failureCounts).toEqual({})
    expect(dueRechecks(state)).toEqual(['https://x/tracklist/a'])
    expect(await env.CACHE.get('yt:plvids:PLartist')).toBeNull()
    expect(await env.CACHE.get('yt:plvids:PLcombined')).toBeNull()
    // The formerly-abandoned set is pending again.
    expect(state.discoveredTracklistUrls!.filter((u) => !state.processedTracklistUrls.includes(u))).toEqual([
      'https://x/tracklist/dead',
    ])
  })

  it('is a no-op for a sub that was never synced', async () => {
    const env = makeEnv()
    expect(await invalidateVideoCache(env, 'nobody', makeLogger({ task: 'test' }))).toEqual({
      slug: 'nobody',
      tracklistsMarked: 0,
      abandonedCleared: 0,
    })
  })
})



describe('block handling (2026-09 IP-ban resilience)', () => {
  beforeEach(() => _resetTallyForTests())

  it('stops the set loop on UpstreamPausedError without charging any set a failure', async () => {
    const env = makeEnv()
    await saveSubState(env, sub.slug, {
      playlistId: 'PL',
      artistName: 'X',
      discoveredTracklistUrls: ['https://x/tracklist/a', 'https://x/tracklist/b', 'https://x/tracklist/c'],
      processedTracklistUrls: [],
      failureCounts: { 'https://x/tracklist/a': 2 },
    })
    ;(fetch1001Html as ReturnType<typeof vi.fn>).mockRejectedValue(new UpstreamPausedError('every forwarder route blocked', '2026-09-10T16:00:00.000Z'))

    const r = await syncOne(env, sub, 'tok', { skipDjCrawl: true, trigger: 'cron.pending' })

    expect(fetch1001Html).toHaveBeenCalledTimes(1)
    expect(r.stats.tracklistsProcessed).toBe(0)
    expect(r.stats.tracklistsPending).toBe(3)
    const state = (await loadSubState(env, sub.slug))!
    // No failure charged, nothing abandoned, the run's stop reason is recorded.
    expect(state.failureCounts).toEqual({ 'https://x/tracklist/a': 2 })
    expect(state.abandonedTracklistUrls).toEqual([])
    expect(state.lastError).toMatch(/^paused: /)
    expect(await playlistAdditions(env)).toEqual([])
  })

  it('stops on IPBlockedError too, and skips the recheck window for that run', async () => {
    const env = makeEnv()
    await saveSubState(env, sub.slug, {
      playlistId: 'PL',
      artistName: 'X',
      discoveredTracklistUrls: ['https://x/tracklist/new', 'https://x/tracklist/old'],
      processedTracklistUrls: ['https://x/tracklist/old'],
      tracklistVideos: { 'https://x/tracklist/old': stale('vidOLD00000') },
    })
    ;(fetch1001Html as ReturnType<typeof vi.fn>).mockRejectedValue(new IPBlockedError('1.2.3.4'))

    const r = await syncOne(env, sub, 'tok', { skipDjCrawl: true })

    expect(fetch1001Html).toHaveBeenCalledTimes(1)
    expect(r.stats.tracklistsRechecked).toBe(0)
    expect(r.stats.rechecksPending).toBe(1)
    const state = (await loadSubState(env, sub.slug))!
    expect(state.failureCounts).toEqual({})
    expect(state.lastError).toMatch(/^ip_blocked: /)
  })

  it('a block during the recheck window stops it without deferring the set', async () => {
    const env = makeEnv()
    await saveSubState(env, sub.slug, {
      playlistId: 'PL',
      artistName: 'X',
      discoveredTracklistUrls: ['https://x/tracklist/old1', 'https://x/tracklist/old2'],
      processedTracklistUrls: ['https://x/tracklist/old1', 'https://x/tracklist/old2'],
      tracklistVideos: { 'https://x/tracklist/old1': stale('vidOLD00001'), 'https://x/tracklist/old2': stale('vidOLD00002') },
    })
    ;(fetch1001Html as ReturnType<typeof vi.fn>).mockRejectedValue(new UpstreamPausedError('paused', null))

    await syncOne(env, sub, 'tok', { skipDjCrawl: true })

    expect(fetch1001Html).toHaveBeenCalledTimes(1)
    const state = (await loadSubState(env, sub.slug))!
    // checkedAt untouched → both still due next tick.
    expect(dueRechecks(state)).toEqual(['https://x/tracklist/old1', 'https://x/tracklist/old2'])
    expect(state.failureCounts).toEqual({})
  })

  it('syncPendingOnly stands down entirely while the pause is active', async () => {
    const env = makeEnv()
    await saveSubState(env, sub.slug, {
      playlistId: 'PL',
      artistName: 'X',
      discoveredTracklistUrls: ['https://x/tracklist/a'],
      processedTracklistUrls: [],
    })
    await env.SUBS.put('subs:list', JSON.stringify([sub]))
    await setPause(env, 'all_routes_blocked', '1.2.3.4')

    const pending = await syncPendingOnly(env)
    expect(pending).toEqual({ results: [], paused: true })
    expect(fetch1001Html).not.toHaveBeenCalled()
    expect(crawlDjIndex).not.toHaveBeenCalled()
  })
})

describe('requeueBanVictims', () => {
  const log = makeLogger({ task: 'test' })

  async function seedAudit(env: Env, rows: Array<{ t: string; status: string; slug: string; set: string; msg: string | null }>) {
    for (const [i, r] of rows.entries()) {
      const inv = String(10_000_000_000_000 - Date.parse(r.t)).padStart(14, '0')
      await env.CACHE.put(`pladd:${inv}:${r.slug}:${String(9999 - i).padStart(4, '0')}`, JSON.stringify(r), {
        metadata: { t: r.t, status: r.status, slug: r.slug, artist: null, set: r.set, vid: null, via: null, trg: 'cron.pending', msg: r.msg, ms: null, cmb: null },
      })
    }
  }

  it('re-queues sets abandoned with block-shaped errors inside the window, leaves everything else alone', async () => {
    const env = makeEnv()
    const now = Date.now()
    const iso = (agoDays: number) => new Date(now - agoDays * 86_400_000).toISOString()
    await saveSubState(env, 'lillypalmer', {
      playlistId: 'PL',
      artistName: 'X',
      discoveredTracklistUrls: ['https://x/tracklist/ban1', 'https://x/tracklist/ban2', 'https://x/tracklist/broken', 'https://x/tracklist/ancient', 'https://x/tracklist/counting'],
      processedTracklistUrls: [],
      abandonedTracklistUrls: ['https://x/tracklist/ban1', 'https://x/tracklist/ban2', 'https://x/tracklist/broken', 'https://x/tracklist/ancient'],
      failureCounts: { 'https://x/tracklist/counting': 2 },
    })
    await seedAudit(env, [
      { t: iso(1), status: 'abandoned', slug: 'lillypalmer', set: 'https://x/tracklist/ban1', msg: 'unlocker fetched a CF shell for https://x/tracklist/ban1 (59211 bytes)' },
      { t: iso(2), status: 'abandoned', slug: 'lillypalmer', set: 'https://x/tracklist/ban2', msg: '1001tracklists rate-limited IP 68.1.2.3' },
      { t: iso(2), status: 'abandoned', slug: 'lillypalmer', set: 'https://x/tracklist/broken', msg: 'youtube videos.list 404: not found' },
      { t: iso(40), status: 'abandoned', slug: 'lillypalmer', set: 'https://x/tracklist/ancient', msg: 'home proxy 403: blocked' },
      { t: iso(1), status: 'failed', slug: 'lillypalmer', set: 'https://x/tracklist/counting', msg: 'unlocker fetch failed for https://x/tracklist/counting — reject_block: ' },
      { t: iso(1), status: 'abandoned', slug: 'nobody', set: 'https://x/tracklist/orphan', msg: 'ip_blocked' },
    ])

    const dry = await requeueBanVictims(env, { days: 14, dryRun: true, log })
    expect(dry.requeuedCount).toBe(3)
    expect((await loadSubState(env, 'lillypalmer'))!.abandonedTracklistUrls).toHaveLength(4)

    const r = await requeueBanVictims(env, { days: 14, log })
    expect(r.requeued).toEqual({ lillypalmer: ['https://x/tracklist/ban1', 'https://x/tracklist/ban2', 'https://x/tracklist/counting'] })
    const state = (await loadSubState(env, 'lillypalmer'))!
    expect(state.abandonedTracklistUrls).toEqual(['https://x/tracklist/broken', 'https://x/tracklist/ancient'])
    expect(state.failureCounts).toEqual({})
    expect(r.candidates.nobody).toEqual(['https://x/tracklist/orphan'])
  })
})

describe('route faults are not the set\'s fault', () => {
  it('forwarder down + paid fallback serving Cloudflare shells stops the batch without charging any set', async () => {
    const env = makeEnv()
    await saveSubState(env, sub.slug, {
      playlistId: 'PL',
      artistName: 'X',
      discoveredTracklistUrls: ['https://x/tracklist/a', 'https://x/tracklist/b'],
      processedTracklistUrls: [],
      failureCounts: { 'https://x/tracklist/a': 2 },
    })
    ;(fetch1001Html as ReturnType<typeof vi.fn>).mockRejectedValue(
      new UpstreamUnavailableError('forwarder transport: fetch failed; BrightData returned Cloudflare challenge pages (2 attempts)'),
    )

    const r = await syncOne(env, sub, 'tok', { skipDjCrawl: true })

    // Stopped after the first set: the second one is never attempted.
    expect(fetch1001Html).toHaveBeenCalledTimes(1)
    expect(r.stats.tracklistsPending).toBe(2)
    const state = (await loadSubState(env, sub.slug))!
    expect(state.lastError).toMatch(/^unavailable: 1001tracklists unreachable/)
    expect(state.failureCounts).toEqual({ 'https://x/tracklist/a': 2 })
    expect(state.abandonedTracklistUrls).toEqual([])
    expect(await playlistAdditions(env)).toEqual([])
  })

  it('a Cloudflare shell behind a healthy forwarder IS charged like any other fetch failure', async () => {
    const env = makeEnv()
    await saveSubState(env, sub.slug, {
      playlistId: 'PL',
      artistName: 'X',
      discoveredTracklistUrls: ['https://x/tracklist/a'],
      processedTracklistUrls: [],
      failureCounts: { 'https://x/tracklist/a': 2 },
    })
    ;(fetch1001Html as ReturnType<typeof vi.fn>).mockRejectedValue(new CloudflareChallengeError('unlocker fetched a CF shell page'))

    await syncOne(env, sub, 'tok', { skipDjCrawl: true })

    const state = (await loadSubState(env, sub.slug))!
    expect(state.abandonedTracklistUrls).toEqual(['https://x/tracklist/a'])
    const rows = await playlistAdditions(env)
    expect(rows.map((x) => x.record.status)).toEqual(['abandoned'])
  })
})

describe('per-tick 1001tl fetch budget (account rate-limit pacing)', () => {
  beforeEach(() => _resetTallyForTests())
  /** Two subscribed DJs, each with N unprocessed sets, YouTube connected. */
  async function twoSubs(env: Env, perSub: number, lastRunAt: [number, number]) {
    await env.SUBS.put('subs:list', JSON.stringify(['alpha', 'beta']))
    for (const [i, slug] of (['alpha', 'beta'] as const).entries()) {
      await env.SUBS.put('subs:item:' + slug, JSON.stringify({ sourceUrl: 'https://www.1001tracklists.com/dj/' + slug + '/', addedAt: 0 }))
      await saveSubState(env, slug, {
        playlistId: 'PL' + slug,
        artistName: slug,
        discoveredTracklistUrls: Array.from({ length: perSub }, (_, k) => 'https://x/tracklist/' + slug + k),
        processedTracklistUrls: [],
        tracklistVideos: {},
        lastRunAt: lastRunAt[i],
      })
    }
    await env.SUBS.put(
      'oauth:google',
      JSON.stringify({ accessToken: 'tok', refreshToken: 'refresh', expiresAt: Math.floor(Date.now() / 1000) + 3600, scope: 's', channelId: null, channelTitle: null, connectedAt: 0 }),
    )
  }

  it('stops fetching 1001tl pages once TL_FETCHES_PER_TICK is spent, and picks the least-recently-run sub first', async () => {
    const env = { ...makeEnv(), TL_FETCHES_PER_TICK: '3' } as Env
    // beta ran longer ago than alpha → beta goes first.
    await twoSubs(env, 5, [200, 100])
    const r = await syncPendingOnly(env)
    // 3 fetches total: all spent on beta (the older one); alpha never starts.
    expect(fetch1001Html).toHaveBeenCalledTimes(3)
    expect(r.results.map((x) => x.slug)).toEqual(['beta'])
    const beta = (await loadSubState(env, 'beta'))!
    const alpha = (await loadSubState(env, 'alpha'))!
    expect(beta.processedTracklistUrls).toHaveLength(3)
    expect(alpha.processedTracklistUrls).toHaveLength(0)
    // Nothing was charged as a failure: the budget is pacing, not an error.
    expect(beta.failureCounts ?? {}).toEqual({})
    expect(beta.lastError).toBeUndefined()
  })

  it('carries leftover budget into the next sub and defaults to 25 when the var is unset', async () => {
    const env = makeEnv()
    await twoSubs(env, 2, [100, 200])
    const r = await syncPendingOnly(env)
    expect(r.results.map((x) => x.slug)).toEqual(['alpha', 'beta'])
    expect(fetch1001Html).toHaveBeenCalledTimes(4)
    expect(newFetchBudget(env)).toEqual({ remaining: 25, limit: 25, spent: 0 })
    expect(newFetchBudget({ ...env, TL_FETCHES_PER_TICK: 'nope' } as Env).limit).toBe(25)
    expect(newFetchBudget({ ...env, TL_FETCHES_PER_TICK: '7' } as Env).limit).toBe(7)
  })

  it('also caps rechecks', async () => {
    const env = { ...makeEnv(), TL_FETCHES_PER_TICK: '2' } as Env
    await env.SUBS.put('subs:list', JSON.stringify(['alpha']))
    await env.SUBS.put('subs:item:alpha', JSON.stringify({ sourceUrl: 'https://www.1001tracklists.com/dj/alpha/', addedAt: 0 }))
    const urls = ['https://x/tracklist/r1', 'https://x/tracklist/r2', 'https://x/tracklist/r3', 'https://x/tracklist/r4']
    await saveSubState(env, 'alpha', {
      playlistId: 'PLalpha',
      artistName: 'alpha',
      discoveredTracklistUrls: urls,
      processedTracklistUrls: urls,
      tracklistVideos: Object.fromEntries(urls.map((u) => [u, stale('vidA1234567')])),
    })
    await env.SUBS.put(
      'oauth:google',
      JSON.stringify({ accessToken: 'tok', refreshToken: 'refresh', expiresAt: Math.floor(Date.now() / 1000) + 3600, scope: 's', channelId: null, channelTitle: null, connectedAt: 0 }),
    )
    const r = await syncPendingOnly(env)
    expect(fetch1001Html).toHaveBeenCalledTimes(2)
    expect(r.results[0]!.stats.tracklistsRechecked).toBe(2)
    expect(r.results[0]!.stats.rechecksPending).toBe(2)
  })
})
