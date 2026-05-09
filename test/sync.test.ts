import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../src/types'
import {
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
  const store = new Map<string, string>()
  return {
    async get(key: string, type?: 'json' | 'text') {
      const v = store.get(key)
      if (v === undefined) return null
      return type === 'json' ? JSON.parse(v) : v
    },
    async put(key: string, value: string) {
      store.set(key, value)
    },
    async delete(key: string) {
      store.delete(key)
    },
  } as unknown as KVNamespace
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
  vi.clearAllMocks()
  ;(fetch1001Html as ReturnType<typeof vi.fn>).mockResolvedValue({
    html: '<set/>',
    via: 'direct',
    state: { cookie: '' },
  })
  ;(listPlaylistVideoIds as ReturnType<typeof vi.fn>).mockResolvedValue(new Set<string>())
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
    expect(createPlaylist).toHaveBeenCalledOnce()
    expect((createPlaylist as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
      title: 'Lilly Palmer (1001tklists)',
      privacyStatus: 'private',
      description: 'Every set Lilly Palmer has a YouTube recording for on 1001tracklists.',
    })
    expect(addVideoToPlaylist).toHaveBeenCalledTimes(2)
    expect(r.stats).toEqual({
      tracklistsSeen: 3,
      tracklistsProcessed: 3,
      videoIdsFound: 2,
      videoIdsAdded: 2,
      tracklistsPending: 0,
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
    ;(parseSetYouTubeId as ReturnType<typeof vi.fn>).mockReturnValue('vidNew11234')

    await syncOne(env, sub, 'tok')

    expect(findPlaylistByTitle).not.toHaveBeenCalled()
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
