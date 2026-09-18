import { describe, it, expect, vi, beforeEach } from 'vitest'
import { app } from '../src/index'
import type { Env, ParsedTrack } from '../src/types'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'

// Every network-facing dependency is mocked so the test proves one thing: a
// set that mkvid uploaded (unlisted, so the YouTube Data API's search.list can
// never return it and 1001tracklists can never know its URL) resolves from
// tracked's own D1 without touching YouTube or 1001tracklists at all.
vi.mock('../src/lib/youtube', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/youtube')>('../src/lib/youtube')
  return { ...actual, resolveVideo: vi.fn(async () => null) }
})
vi.mock('../src/lib/tracklists1001', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/tracklists1001')>('../src/lib/tracklists1001')
  return {
    ...actual,
    searchByYouTubeUrl: vi.fn(async () => ({ result: { tracklistUrl: null }, state: null })),
    searchByTitle: vi.fn(async () => ({ result: { tracklistUrl: null }, state: null })),
  }
})
vi.mock('../src/lib/tracklist-resolve', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/tracklist-resolve')>('../src/lib/tracklist-resolve')
  return {
    ...actual,
    resolveTracklistPage: vi.fn(),
    resolveTrackMediaLinks: vi.fn(async () => ({ appleLink: null, youtubeLink: null })),
  }
})
vi.mock('../src/lib/itunes', () => ({ lookupAppleLink: vi.fn(async () => null) }))

import { resolveVideo } from '../src/lib/youtube'
import { searchByTitle, searchByYouTubeUrl } from '../src/lib/tracklists1001'
import { resolveTracklistPage } from '../src/lib/tracklist-resolve'

const SET_URL = 'https://www.1001tracklists.com/tracklist/2u10c9r9/mau-p-panorama-festival-italy-2026-08-16.html'
const SET_TITLE = 'Mau P @ Panorama Festival, Italy 2026-08-16'
const VIDEO_ID = '7-HvbsxBq-4'

const track = (startSeconds: number, artist: string, title: string): ParsedTrack => ({
  startTime: `${Math.floor(startSeconds / 60)}:${String(startSeconds % 60).padStart(2, '0')}`,
  startSeconds,
  artist,
  title,
  trackId: null,
  trackUrl: null,
  artworkUrl: null,
  isUnidentified: false,
  idStatus: null,
  isMashupLinked: false,
})

function makeEnv(): Env {
  return { CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV(), API_TOKEN: 'tasker', YOUTUBE_API_KEY: 'k', MKVID_TOKEN: 'mk' } as Env
}

const NOW = Math.floor(Date.now() / 1000)

/** A finished mkvid upload, exactly as /mkvid/complete leaves it. */
async function seedMkvidUpload(env: Env, over: Partial<{ status: string; setTitle: string; videoId: string | null }> = {}) {
  await env.DB.prepare(
    `INSERT INTO mkvid_requests (id, slug, set_url, artist_name, set_title, source, source_url, status, video_id, video_url, privacy, created_at, updated_at)
     VALUES (?, 'maup', ?, 'Mau P', ?, 'soundcloud', 'https://api.soundcloud.com/tracks/1', ?, ?, ?, 'unlisted', ?, ?)`,
  )
    .bind('req-1', SET_URL, over.setTitle ?? SET_TITLE, over.status ?? 'done', over.videoId === undefined ? VIDEO_ID : over.videoId, `https://youtu.be/${VIDEO_ID}`, NOW, NOW)
    .run()
}

/** The tracklists row the sync keeps once mkvid delivered the upload. */
async function seedTracklistVideo(env: Env) {
  await env.DB.prepare(
    `INSERT INTO tracklists (slug, url, position, discovered_at, processed, video_known, video_id, video_source, checked_at)
     VALUES ('maup', ?, 0, ?, 1, 1, ?, 'mkvid', ?)`,
  )
    .bind(SET_URL, NOW, VIDEO_ID, NOW)
    .run()
}

const post = (env: Env, body: unknown) =>
  app.request('http://x/now-playing', { method: 'POST', headers: { Authorization: 'Bearer tasker', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env)

beforeEach(() => {
  vi.clearAllMocks()
  ;(resolveTracklistPage as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
    tracks: [track(0, 'Mau P', 'Drugs From Amsterdam'), track(300, 'Chris Lake', 'Turn Off The Lights'), track(600, 'Odd Mob', 'Left To Right')],
    setAppleLink: null,
    setYoutubeLink: null,
    setSoundcloudLink: null,
  }))
})

describe('POST /now-playing — sets tracked itself uploaded through mkvid', () => {
  it('resolves an unlisted mkvid upload by title from D1, without YouTube or 1001tracklists searches', async () => {
    const env = makeEnv()
    await seedMkvidUpload(env)
    await seedTracklistVideo(env)

    const res = await post(env, { videoTitle: SET_TITLE, videoDurationSeconds: 6967, currentSeconds: 1816 })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.status).toBe('ok')
    expect(body.videoUrl).toBe(`https://www.youtube.com/watch?v=${VIDEO_ID}`)
    expect(body.tracklistUrl).toBe(SET_URL)
    expect(body.tracks.find((t: any) => t.isCurrent)?.title).toBe('Left To Right')

    expect(resolveVideo).not.toHaveBeenCalled()
    expect(searchByYouTubeUrl).not.toHaveBeenCalled()
    expect(searchByTitle).not.toHaveBeenCalled()
    expect(resolveTracklistPage).toHaveBeenCalledWith(expect.anything(), SET_URL, expect.anything())
  })

  it('matches the title YouTube actually shows: case-insensitive, and cut to the 100 chars mkvid uploads', async () => {
    const env = makeEnv()
    const long = 'Matroda @ OCHO by Gray Area (Knockdown Center New York, United States) 2026-08-14 — Extended Director Cut Edition'
    expect(long.length).toBeGreaterThan(100)
    await seedMkvidUpload(env, { setTitle: long })

    const res = await post(env, { videoTitle: long.slice(0, 100).toUpperCase(), currentSeconds: 10 })
    const body = (await res.json()) as any
    expect(body.status).toBe('ok')
    expect(body.videoUrl).toBe(`https://www.youtube.com/watch?v=${VIDEO_ID}`)
    expect(body.tracklistUrl).toBe(SET_URL)
    expect(resolveVideo).not.toHaveBeenCalled()
  })

  it('resolves the tracklist from D1 when the caller posts the unlisted video URL', async () => {
    const env = makeEnv()
    await seedTracklistVideo(env)

    const res = await post(env, { videoUrl: `https://youtu.be/${VIDEO_ID}`, currentSeconds: 350 })
    const body = (await res.json()) as any
    expect(body.status).toBe('ok')
    expect(body.tracklistUrl).toBe(SET_URL)
    expect(body.tracks.find((t: any) => t.isCurrent)?.title).toBe('Turn Off The Lights')
    expect(searchByYouTubeUrl).not.toHaveBeenCalled()
  })

  it('ignores requests that never produced a video and falls through to the normal lookups', async () => {
    const env = makeEnv()
    await seedMkvidUpload(env, { status: 'pending', videoId: null })

    const res = await post(env, { videoTitle: SET_TITLE, currentSeconds: 10 })
    const body = (await res.json()) as any
    expect(body.status).toBe('no_video')
    expect(resolveVideo).toHaveBeenCalledTimes(1)
    expect(searchByTitle).toHaveBeenCalledTimes(1)
  })
})
