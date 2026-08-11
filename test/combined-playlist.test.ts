import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../src/types'
import {
  COMBINED_DAILY_INSERT_CAP,
  COMBINED_PLAYLIST_TITLE,
  dailyInsertsUsed,
  loadCombinedState,
  mergeIntoCombinedPlaylist,
  openCombinedPlaylist,
  readCombinedStatus,
  saveCombinedState,
  type PlaylistSource,
} from '../src/lib/combined-playlist'
import { makeLogger } from '../src/lib/log'

// Same stubbing strategy as sync.test.ts: the YouTube client is mocked so the
// merge logic (union → diff → bounded insert) is a deterministic unit test.
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

import {
  addVideoToPlaylist,
  createPlaylist,
  findPlaylistByTitle,
  listPlaylistVideoIds,
  PlaylistNotFoundError,
  YouTubeApiError,
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
  return { CACHE: fakeKV(), SUBS: fakeKV(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k' } as Env
}

const log = makeLogger({ task: 'test' })

const source = (slug: string, playlistId: string): PlaylistSource => ({
  slug,
  artistName: slug,
  playlistId,
})

/** Per-playlist contents for the mocked `listPlaylistVideoIds`. */
function seedPlaylists(contents: Record<string, string[]>) {
  ;(listPlaylistVideoIds as ReturnType<typeof vi.fn>).mockImplementation(async (playlistId: string) =>
    new Set(contents[playlistId] ?? []),
  )
}

const addedVideos = () =>
  (addVideoToPlaylist as ReturnType<typeof vi.fn>).mock.calls.map((c) => [c[0], c[1]])

beforeEach(() => {
  vi.clearAllMocks()
  ;(findPlaylistByTitle as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'PLcombined', title: COMBINED_PLAYLIST_TITLE })
  ;(listPlaylistVideoIds as ReturnType<typeof vi.fn>).mockResolvedValue(new Set<string>())
  ;(addVideoToPlaylist as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
})

describe('openCombinedPlaylist', () => {
  it('creates the playlist on first use and caches its id in state', async () => {
    const env = makeEnv()
    ;(findPlaylistByTitle as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    ;(createPlaylist as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'PLfresh', title: COMBINED_PLAYLIST_TITLE })

    const handle = await openCombinedPlaylist(env, 'tok', log)

    expect(handle?.playlistId).toBe('PLfresh')
    expect(handle?.videoIds.size).toBe(0)
    // Freshly created → known empty, so we skip the read that would 404 on
    // YouTube's not-yet-consistent playlist.
    expect(listPlaylistVideoIds).not.toHaveBeenCalled()
    expect((await loadCombinedState(env)).playlistId).toBe('PLfresh')
  })

  it('reuses the id from state without a lookup on later runs', async () => {
    const env = makeEnv()
    await saveCombinedState(env, { playlistId: 'PLknown' })
    seedPlaylists({ PLknown: ['vidOne12345'] })

    const handle = await openCombinedPlaylist(env, 'tok', log)

    expect(handle?.playlistId).toBe('PLknown')
    expect([...handle!.videoIds]).toEqual(['vidOne12345'])
    expect(findPlaylistByTitle).not.toHaveBeenCalled()
  })

  it('re-resolves when the cached id points at a deleted playlist', async () => {
    const env = makeEnv()
    await saveCombinedState(env, { playlistId: 'PLdeleted' })
    ;(listPlaylistVideoIds as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new PlaylistNotFoundError('playlistItems.list', 'PLdeleted'))
      .mockResolvedValueOnce(new Set(['vidKept1234']))
    ;(findPlaylistByTitle as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'PLrecovered', title: COMBINED_PLAYLIST_TITLE })

    const handle = await openCombinedPlaylist(env, 'tok', log)

    expect(handle?.playlistId).toBe('PLrecovered')
    expect((await loadCombinedState(env)).playlistId).toBe('PLrecovered')
  })

  it('returns null instead of creating when asked to look up only', async () => {
    const env = makeEnv()
    ;(findPlaylistByTitle as ReturnType<typeof vi.fn>).mockResolvedValue(null)

    expect(await openCombinedPlaylist(env, 'tok', log, { create: false })).toBeNull()
    expect(createPlaylist).not.toHaveBeenCalled()
  })
})

describe('mergeIntoCombinedPlaylist', () => {
  it('inserts every video the artist playlists have and the combined one lacks', async () => {
    const env = makeEnv()
    await saveCombinedState(env, { playlistId: 'PLcombined' })
    seedPlaylists({
      PLcombined: ['alreadyIn12'],
      PLa: ['alreadyIn12', 'aOnly123456'],
      PLb: ['bOnly123456'],
    })

    const r = await mergeIntoCombinedPlaylist(env, 'tok', [source('a', 'PLa'), source('b', 'PLb')], { log })

    expect(addedVideos()).toEqual([
      ['PLcombined', 'aOnly123456'],
      ['PLcombined', 'bOnly123456'],
    ])
    expect(r).toMatchObject({
      playlistId: 'PLcombined',
      sourcesRead: 2,
      sourcesFailed: 0,
      missingTotal: 2,
      inserted: 2,
      failed: 0,
      pending: 0,
      cappedBy: null,
      videoCount: 3,
    })
    // Post-insert set is written back so the next tick doesn't re-list it.
    expect(await env.CACHE.get('yt:plvids:PLcombined', 'json')).toEqual({
      videoIds: ['alreadyIn12', 'aOnly123456', 'bOnly123456'],
    })
  })

  it('inserts a video shared by two artists exactly once', async () => {
    const env = makeEnv()
    await saveCombinedState(env, { playlistId: 'PLcombined' })
    seedPlaylists({ PLcombined: [], PLa: ['b2bSet12345'], PLb: ['b2bSet12345'] })

    const r = await mergeIntoCombinedPlaylist(env, 'tok', [source('a', 'PLa'), source('b', 'PLb')], { log })

    expect(addedVideos()).toEqual([['PLcombined', 'b2bSet12345']])
    expect(r.missingTotal).toBe(1)
  })

  it('stops at maxInsertsPerRun and reports the rest as pending', async () => {
    const env = makeEnv()
    await saveCombinedState(env, { playlistId: 'PLcombined' })
    const backlog = Array.from({ length: 10 }, (_, i) => `vid${String(i).padStart(8, '0')}`)
    seedPlaylists({ PLcombined: [], PLa: backlog })

    const r = await mergeIntoCombinedPlaylist(env, 'tok', [source('a', 'PLa')], { log, maxInsertsPerRun: 3 })

    expect(addedVideos().map((c) => c[1])).toEqual(backlog.slice(0, 3))
    expect(r).toMatchObject({ inserted: 3, pending: 7, cappedBy: 'run' })
    // Progress is deterministic: the next run resumes from the same order.
    const state = await loadCombinedState(env)
    expect(state.lastBackfillStats).toMatchObject({ inserted: 3, pending: 7, cappedBy: 'run' })
    expect(state.lastBackfillAt).toBeGreaterThan(0)
  })

  it('honours the daily insert cap across runs', async () => {
    const env = makeEnv()
    await saveCombinedState(env, { playlistId: 'PLcombined' })
    const backlog = Array.from({ length: 5 }, (_, i) => `day${String(i).padStart(8, '0')}`)
    seedPlaylists({ PLcombined: [], PLa: backlog })
    // Pretend today already spent all but two of the day's budget.
    const today = new Date().toISOString().slice(0, 10)
    await env.CACHE.put(`yt:combined:inserts:${today}`, String(COMBINED_DAILY_INSERT_CAP - 2))

    const r = await mergeIntoCombinedPlaylist(env, 'tok', [source('a', 'PLa')], { log })

    expect(r).toMatchObject({ inserted: 2, pending: 3, cappedBy: 'daily' })
    expect(await dailyInsertsUsed(env)).toBe(COMBINED_DAILY_INSERT_CAP)

    // A second run the same day inserts nothing at all.
    ;(addVideoToPlaylist as ReturnType<typeof vi.fn>).mockClear()
    const again = await mergeIntoCombinedPlaylist(env, 'tok', [source('a', 'PLa')], { log })
    expect(addVideoToPlaylist).not.toHaveBeenCalled()
    expect(again).toMatchObject({ inserted: 0, cappedBy: 'daily' })
  })

  it('skips a source it cannot read and still merges the others', async () => {
    const env = makeEnv()
    await saveCombinedState(env, { playlistId: 'PLcombined' })
    ;(listPlaylistVideoIds as ReturnType<typeof vi.fn>).mockImplementation(async (playlistId: string) => {
      if (playlistId === 'PLgone') throw new PlaylistNotFoundError('playlistItems.list', 'PLgone')
      return new Set(playlistId === 'PLb' ? ['bOnly123456'] : [])
    })

    const r = await mergeIntoCombinedPlaylist(env, 'tok', [source('a', 'PLgone'), source('b', 'PLb')], { log })

    expect(r).toMatchObject({ sourcesRead: 1, sourcesFailed: 1, inserted: 1 })
    expect(addedVideos()).toEqual([['PLcombined', 'bOnly123456']])
  })

  it('counts a failed insert without aborting the run', async () => {
    const env = makeEnv()
    await saveCombinedState(env, { playlistId: 'PLcombined' })
    seedPlaylists({ PLcombined: [], PLa: ['boom1234567', 'fine1234567'] })
    ;(addVideoToPlaylist as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('youtube playlistItems.insert 503'))
      .mockResolvedValue(undefined)

    const r = await mergeIntoCombinedPlaylist(env, 'tok', [source('a', 'PLa')], { log })

    expect(r).toMatchObject({ inserted: 1, failed: 1 })
    // The failed one stays missing, so the next run retries it.
    expect(r.pending).toBe(1)
    // A transient failure is NOT marked unavailable.
    expect((await loadCombinedState(env)).unavailableVideoIds ?? []).toEqual([])
  })

  it('marks a permanently-uninsertable video unavailable and never retries it', async () => {
    const env = makeEnv()
    await saveCombinedState(env, { playlistId: 'PLcombined' })
    seedPlaylists({ PLcombined: [], PLa: ['deadVideo12', 'fine1234567'] })
    ;(addVideoToPlaylist as ReturnType<typeof vi.fn>).mockImplementation(async (_pl: string, videoId: string) => {
      if (videoId === 'deadVideo12') throw new YouTubeApiError('playlistItems.insert', 404, 'videoNotFound', '{}')
    })

    const r = await mergeIntoCombinedPlaylist(env, 'tok', [source('a', 'PLa')], { log })

    expect(r).toMatchObject({ inserted: 1, failed: 1, unavailableTotal: 1 })
    // Not pending — no future tick should pick it up.
    expect(r.pending).toBe(0)
    expect((await loadCombinedState(env)).unavailableVideoIds).toEqual(['deadVideo12'])

    // The next run doesn't even attempt it: only the dead video is excluded.
    ;(addVideoToPlaylist as ReturnType<typeof vi.fn>).mockClear()
    const again = await mergeIntoCombinedPlaylist(env, 'tok', [source('a', 'PLa')], { log })
    expect(addVideoToPlaylist).not.toHaveBeenCalled()
    expect(again).toMatchObject({ missingTotal: 0, unavailableTotal: 1 })
  })

  it('stops the run on quotaExceeded without marking the video unavailable', async () => {
    const env = makeEnv()
    await saveCombinedState(env, { playlistId: 'PLcombined' })
    seedPlaylists({ PLcombined: [], PLa: ['first1234567'.slice(0, 11), 'second123456'.slice(0, 11), 'third1234567'.slice(0, 11)] })
    ;(addVideoToPlaylist as ReturnType<typeof vi.fn>).mockRejectedValue(
      new YouTubeApiError('playlistItems.insert', 403, 'quotaExceeded', '{}'),
    )

    const r = await mergeIntoCombinedPlaylist(env, 'tok', [source('a', 'PLa')], { log })

    // One attempt, then stop — retrying the rest today is pointless.
    expect(addVideoToPlaylist).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ inserted: 0, failed: 1, cappedBy: 'quota', pending: 3 })
    // Quota exhaustion says nothing about the video itself.
    expect((await loadCombinedState(env)).unavailableVideoIds ?? []).toEqual([])
  })

  it('charges failed attempts against the daily budget so failures cannot loop unmetered', async () => {
    const env = makeEnv()
    await saveCombinedState(env, { playlistId: 'PLcombined' })
    seedPlaylists({ PLcombined: [], PLa: ['boom1234567'] })
    // Transient failure (not permanent, not quota) → stays pending…
    ;(addVideoToPlaylist as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('socket hang up'))

    const r = await mergeIntoCombinedPlaylist(env, 'tok', [source('a', 'PLa')], { log })

    expect(r).toMatchObject({ inserted: 0, failed: 1, pending: 1 })
    // …but the attempt still consumed a unit of the daily insert budget.
    expect(await dailyInsertsUsed(env)).toBe(1)
    expect(r.dailyInsertsUsed).toBe(1)
  })

  it('never treats the combined playlist as one of its own sources', async () => {
    const env = makeEnv()
    await saveCombinedState(env, { playlistId: 'PLcombined' })
    seedPlaylists({ PLcombined: ['already12345'] })

    const r = await mergeIntoCombinedPlaylist(env, 'tok', [source('self', 'PLcombined')], { log })

    expect(r).toMatchObject({ sourcesRead: 0, missingTotal: 0, inserted: 0 })
    expect(addVideoToPlaylist).not.toHaveBeenCalled()
  })
})

describe('readCombinedStatus', () => {
  it('reports what is missing without creating or inserting anything', async () => {
    const env = makeEnv()
    ;(findPlaylistByTitle as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    seedPlaylists({ PLa: ['one12345678', 'two12345678'] })

    const status = await readCombinedStatus(env, 'tok', [source('a', 'PLa')], log)

    expect(status).toMatchObject({
      title: COMBINED_PLAYLIST_TITLE,
      playlistId: null,
      playlistUrl: null,
      videoCount: 0,
      missingTotal: 2,
      dailyInsertCap: COMBINED_DAILY_INSERT_CAP,
    })
    expect(status.sources).toEqual([{ slug: 'a', artistName: 'a', playlistId: 'PLa', videoCount: 2 }])
    expect(createPlaylist).not.toHaveBeenCalled()
    expect(addVideoToPlaylist).not.toHaveBeenCalled()
  })

  it('counts only what the combined playlist still lacks once it exists', async () => {
    const env = makeEnv()
    await saveCombinedState(env, { playlistId: 'PLcombined' })
    seedPlaylists({ PLcombined: ['one12345678'], PLa: ['one12345678', 'two12345678'] })

    const status = await readCombinedStatus(env, 'tok', [source('a', 'PLa')], log)

    expect(status).toMatchObject({
      playlistId: 'PLcombined',
      playlistUrl: 'https://www.youtube.com/playlist?list=PLcombined',
      videoCount: 1,
      missingTotal: 1,
    })
  })
})
