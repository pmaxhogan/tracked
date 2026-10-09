/**
 * POST /now-playing's per-track `trackId` (what Tasker sends to POST /presave):
 * only a row's medialink id. A list cached before rows carried `mediaId` has
 * `trackId` = media id OR data-id (a page position), indistinguishable, so it
 * answers null there and the phone saves the row by `rowIndex` instead.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { app } from '../src/index'
import type { Env } from '../src/types'
import type { PageRow } from '../src/lib/tracklists1001'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'

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
  return { ...actual, resolveTracklistPage: vi.fn(), resolveTrackMediaLinks: vi.fn(async () => ({ appleLink: null, youtubeLink: null })) }
})
vi.mock('../src/lib/itunes', () => ({ lookupAppleLink: vi.fn(async () => null) }))

import { resolveTracklistPage } from '../src/lib/tracklist-resolve'

const SET_URL = 'https://www.1001tracklists.com/tracklist/2u10c9r9/mau-p-panorama-festival-italy-2026-08-16.html'
const SET_TITLE = 'Mau P @ Panorama Festival, Italy 2026-08-16'
const NOW = Math.floor(Date.now() / 1000)

const pageRow = (startSeconds: number, artist: string, title: string, trackId: string, mediaId: string | null | undefined): PageRow => {
  const r: PageRow = {
    startTime: `${Math.floor(startSeconds / 60)}:${String(startSeconds % 60).padStart(2, '0')}`,
    startSeconds,
    artist,
    title,
    trackId,
    trackUrl: null,
    artworkUrl: null,
    isUnidentified: false,
    idStatus: null,
    isMashupLinked: false,
    ownStartSeconds: startSeconds,
    anonymous: false,
    label: null,
    mediaId,
  }
  if (mediaId === undefined) delete r.mediaId
  return r
}

async function seed(env: Env) {
  await env.DB.prepare(
    `INSERT INTO mkvid_requests (id, slug, set_url, artist_name, set_title, source, source_url, status, video_id, video_url, privacy, created_at, updated_at)
     VALUES ('req-1', 'maup', ?, 'Mau P', ?, 'soundcloud', 'https://api.soundcloud.com/tracks/1', 'done', '7-HvbsxBq-4', 'https://youtu.be/7-HvbsxBq-4', 'unlisted', ?, ?)`,
  )
    .bind(SET_URL, SET_TITLE, NOW, NOW)
    .run()
  await env.DB.prepare(
    `INSERT INTO tracklists (slug, url, position, discovered_at, processed, video_known, video_id, video_source, checked_at)
     VALUES ('maup', ?, 0, ?, 1, 1, '7-HvbsxBq-4', 'mkvid', ?)`,
  )
    .bind(SET_URL, NOW, NOW)
    .run()
}

function listOf(rows: PageRow[]) {
  const tracks = rows.map(({ anonymous: _a, label: _l, mediaId: _m, ...t }) => t)
  return { tracks, rows, setAppleLink: null, setYoutubeLink: null, setSoundcloudLink: null }
}

async function nowPlaying(rows: PageRow[]) {
  const env = { CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV(), API_TOKEN: 'tasker', YOUTUBE_API_KEY: 'k', MKVID_TOKEN: 'mk' } as Env
  await seed(env)
  ;(resolveTracklistPage as ReturnType<typeof vi.fn>).mockImplementation(async () => listOf(rows))
  const res = await app.request(
    'http://x/now-playing',
    { method: 'POST', headers: { Authorization: 'Bearer tasker', 'Content-Type': 'application/json' }, body: JSON.stringify({ videoTitle: SET_TITLE, videoDurationSeconds: 6967, currentSeconds: 400 }) },
    env,
  )
  expect(res.status).toBe(200)
  return ((await res.json()) as { tracks: Array<{ title: string; trackId: string | null; rowIndex: number | null }> }).tracks
}

beforeEach(() => vi.clearAllMocks())

describe('POST /now-playing trackId', () => {
  it('is the medialink id; null for a row with no media id', async () => {
    const tracks = await nowPlaying([pageRow(0, 'Mau P', 'Drugs From Amsterdam', '111', '111'), pageRow(300, 'Chris Lake', 'Turn Off The Lights', '9381908', null)])
    expect(tracks.map((t) => [t.title, t.trackId, t.rowIndex])).toEqual([
      ['Drugs From Amsterdam', '111', 0],
      ['Turn Off The Lights', null, 1],
    ])
  })

  it('is null on a list cached before mediaId existed (its trackId may be a page position)', async () => {
    const tracks = await nowPlaying([pageRow(0, 'Mau P', 'Drugs From Amsterdam', '111', undefined), pageRow(300, 'Chris Lake', 'Turn Off The Lights', '9381908', undefined)])
    expect(tracks.map((t) => [t.trackId, t.rowIndex])).toEqual([
      [null, 0],
      [null, 1],
    ])
  })
})
