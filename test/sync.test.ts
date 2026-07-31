import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../src/types'
import {
  backfillCombined,
  collectCombinedSources,
  loadSubState,
  prettifySlug,
  saveSubState,
  syncOne,
  syncPendingOnly,
  type SubState,
} from '../src/lib/sync'
import { PlaylistNotFoundError } from '../src/lib/youtube-playlists'

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
  }
})

import { crawlDjIndex, fetch1001Html, parseSetYouTubeId } from '../src/lib/dj-index'
import {
  addVideoToPlaylist,
  createPlaylist,
  findPlaylistByTitle,
  listPlaylistVideoIds,
} from '../src/lib/youtube-playlists'

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
    async list({ prefix = '' }: { prefix?: string } = {}) {
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
      }),
    )

    const r = await syncPendingOnly(env)
    expect(r.results).toEqual([])
    // syncPendingOnly fast-skips before calling crawl/findPlaylist/etc.
    expect(crawlDjIndex).not.toHaveBeenCalled()
    expect(findPlaylistByTitle).not.toHaveBeenCalled()
    expect(addVideoToPlaylist).not.toHaveBeenCalled()
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
})
