import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../src/types'
import {
  loadSubState,
  prettifySlug,
  saveSubState,
  syncOne,
  type SubState,
} from '../src/lib/sync'

// Stub the network-touching primitives so syncOne becomes a deterministic
// orchestrator test. This is the most important behavior to lock down: state
// transitions, dedup, the state-vs-fresh-token-vs-create cascade for the
// playlist, and per-set error isolation.
vi.mock('../src/lib/dj-index', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/dj-index')>('../src/lib/dj-index')
  return {
    ...actual,
    fetch1001Html: vi.fn(),
    parseDjIndex: vi.fn(),
    parseSetYouTubeId: vi.fn(),
  }
})
vi.mock('../src/lib/youtube-playlists', () => ({
  findPlaylistByTitle: vi.fn(),
  createPlaylist: vi.fn(),
  listPlaylistVideoIds: vi.fn(),
  addVideoToPlaylist: vi.fn(),
}))

import { fetch1001Html, parseDjIndex, parseSetYouTubeId } from '../src/lib/dj-index'
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

beforeEach(() => {
  vi.clearAllMocks()
  ;(fetch1001Html as ReturnType<typeof vi.fn>).mockResolvedValue({ html: '<html></html>', via: 'direct', state: { cookie: '' } })
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

describe('syncOne', () => {
  it('creates a new playlist on first run, scrapes each set, adds non-duplicate videos, and writes state', async () => {
    const env = makeEnv()
    ;(parseDjIndex as ReturnType<typeof vi.fn>).mockReturnValue({
      artistName: 'Lilly Palmer',
      tracklistUrls: ['https://x/tracklist/a', 'https://x/tracklist/b', 'https://x/tracklist/c'],
    })
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
    })
    expect(addVideoToPlaylist).toHaveBeenCalledTimes(2)
    expect(r.stats).toEqual({
      tracklistsSeen: 3,
      tracklistsProcessed: 3,
      videoIdsFound: 2,
      videoIdsAdded: 2,
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

  it('reuses a same-titled playlist found by lookup instead of creating a new one', async () => {
    const env = makeEnv()
    ;(parseDjIndex as ReturnType<typeof vi.fn>).mockReturnValue({
      artistName: 'Lilly Palmer',
      tracklistUrls: ['https://x/tracklist/a'],
    })
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
    ;(parseDjIndex as ReturnType<typeof vi.fn>).mockReturnValue({
      artistName: 'Lilly Palmer',
      tracklistUrls: ['https://x/tracklist/old', 'https://x/tracklist/new'],
    })
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
    ;(parseDjIndex as ReturnType<typeof vi.fn>).mockReturnValue({
      artistName: 'X',
      tracklistUrls: ['https://x/tracklist/a'],
    })
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
    ;(parseDjIndex as ReturnType<typeof vi.fn>).mockReturnValue({ artistName: 'X', tracklistUrls: urls })
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
    ;(parseDjIndex as ReturnType<typeof vi.fn>).mockReturnValue({
      artistName: 'X',
      tracklistUrls: ['https://x/tracklist/a', 'https://x/tracklist/b'],
    })
    ;(findPlaylistByTitle as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'PL', title: 'X (1001tklists)' })
    // First call resolves the DJ page, then fails for /a, then succeeds for /b.
    ;(fetch1001Html as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ html: '<dj>', via: 'direct', state: { cookie: '' } })
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
    ;(parseDjIndex as ReturnType<typeof vi.fn>).mockReturnValue({ artistName: null, tracklistUrls: [] })

    const r = await syncOne(env, sub, 'tok')
    expect(r.artistName).toBe('Lilly Palmer')
  })

  it('falls back to a prettified slug when no name is available anywhere', async () => {
    const env = makeEnv()
    ;(parseDjIndex as ReturnType<typeof vi.fn>).mockReturnValue({ artistName: null, tracklistUrls: [] })
    ;(findPlaylistByTitle as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    ;(createPlaylist as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'PLx', title: 'Lillypalmer (1001tklists)' })

    const r = await syncOne(env, sub, 'tok')
    expect(r.artistName).toBe('Lillypalmer')
    expect((createPlaylist as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
      title: 'Lillypalmer (1001tklists)',
    })
  })
})
