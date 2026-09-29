import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
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
import { DecoyTracklistError, parseTracklist } from '../src/lib/tracklists1001'

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
  ownStartSeconds: startSeconds,
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

describe('POST /now-playing — the D1 lookups are best-effort', () => {
  it('still answers 200 with a status when D1 throws, falling through to the upstream path', async () => {
    const env = makeEnv()
    const broken = { prepare: () => { throw new Error('D1_ERROR: Network connection lost') } }
    ;(env as any).DB = broken

    const res = await post(env, { videoTitle: SET_TITLE, currentSeconds: 10 })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).status).toBe('no_video')
    expect(resolveVideo).toHaveBeenCalledTimes(1)
    expect(searchByTitle).toHaveBeenCalledTimes(1)

    const byUrl = await post(env, { videoUrl: `https://youtu.be/${VIDEO_ID}`, currentSeconds: 10 })
    expect(byUrl.status).toBe(200)
    expect(((await byUrl.json()) as any).status).toBe('no_tracklist')
    expect(searchByYouTubeUrl).toHaveBeenCalledTimes(1)
  })
})

describe('POST /now-playing — 1001tracklists serving decoy track data', () => {
  it('answers upstream_error naming the decoy instead of showing randomized names', async () => {
    const env = makeEnv()
    ;(resolveVideo as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ videoId: VIDEO_ID, videoUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}`, matchTitle: SET_TITLE, error: null })
    ;(searchByYouTubeUrl as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ result: { tracklistUrl: SET_URL }, state: null })
    ;(resolveTracklistPage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new DecoyTracklistError(SET_URL, { named: 25, mismatched: 24 }))
    const res = await post(env, { videoTitle: SET_TITLE, currentSeconds: 400, videoDurationSeconds: 3600 })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; message?: string; tracks: unknown[]; tracklistUrl: string | null }
    expect(body.status).toBe('upstream_error')
    expect(body.tracks).toEqual([])
    expect(body.tracklistUrl).toBe(SET_URL)
    expect(body.message).toMatch(/decoy/)
    expect(body.message).toMatch(/24 of 25/)
  })
})

// Anonymous "ID - ID" rows carry no microdata, so they are not in `tracks`.
// Without them the named track before one kept its slot until the next named
// cue, and /now-playing answered with it while the unidentified track played.
// The real fixtures have none, so these tests insert one into a real page.
describe('POST /now-playing — an anonymous "ID - ID" row is playing', () => {
  const page = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tracklist-maxstyler.html'), 'utf8')
  const plain = parseTracklist(SET_URL, page)
  // Rows 4 and 5 of the page (trRow4, trRow5), both named and cued.
  const before = plain.tracks[3]!
  const after = plain.tracks[4]!
  const CUE = Math.round((before.startSeconds! + after.startSeconds!) / 2)
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

  /** The page with an anonymous row (and optionally a named "w/" row on it) inserted before trRow5. */
  function edited(opts: { cued: boolean; layeredNamed?: boolean }): string {
    const anon =
      `<div id="tlp_999" class="tlpTog bItm tlpItem trRow99" data-id="999"><div id="tlp999_content" class="fontL"><span class="trackValue notranslate redTxt">ID - ID</span></div>` +
      (opts.cued ? `<div id="cue_999" class="cue noWrap action mt5">${mmss(CUE)}</div>` : '') +
      `</div>`
    const partner = opts.layeredNamed
      ? `<div id="tlp_998" class="tlpTog bItm tlpItem trRow99 con" data-id="998"><span class="fontXL" title="played together with previous track"> w/ </span><div id="tlp998_content" class="fontL"><meta itemprop="name" content="Partner - Acapella"><meta itemprop="byArtist" content="Partner"><span class="trackValue">Partner - Acapella</span></div></div>`
      : ''
    const at = page.search(/<div[^>]*class="tlpTog bItm tlpItem trRow5"/)
    expect(at).toBeGreaterThan(0)
    const cue = opts.cued
      ? `<script>cueValuesEntry = {}; cueValuesEntry.seconds = ${CUE}; cueValuesEntry.ids = []; cueValuesEntry.ids[0] = 'tlp999_content';${opts.layeredNamed ? " cueValuesEntry.ids[1] = 'tlp998_content';" : ''}</script>`
      : ''
    return page.slice(0, at) + anon + partner + page.slice(at) + cue
  }

  function serve(html: string) {
    const p = parseTracklist(SET_URL, html)
    ;(resolveTracklistPage as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      tracks: p.tracks,
      rows: p.rows,
      setAppleLink: null,
      setYoutubeLink: null,
      setSoundcloudLink: null,
    }))
    return p
  }

  async function ask(currentSeconds: number) {
    const env = makeEnv()
    await seedTracklistVideo(env)
    const body = (await (await post(env, { videoUrl: `https://youtu.be/${VIDEO_ID}`, currentSeconds, videoDurationSeconds: 4500 })).json()) as any
    await new Promise((r) => setTimeout(r, 0)) // the audit row is written after the response
    const row = await env.DB.prepare('SELECT record FROM now_playing_audit ORDER BY id DESC').first<{ record: string }>()
    return { body, audit: JSON.parse(row!.record) }
  }

  it('answers unidentified with the anonymous row as the current track, and ends the previous slot at its cue', async () => {
    const p = serve(edited({ cued: true }))
    expect(p.tracks).toEqual(plain.tracks) // tracks / counts unchanged
    const { body, audit } = await ask(CUE + 10)
    expect(body.status).toBe('unidentified')
    const current = body.tracks.filter((t: any) => t.isCurrent)
    expect(current).toEqual([
      expect.objectContaining({ artist: 'ID', title: 'ID', isUnidentified: true, startSeconds: CUE, trackUrl: null, artworkUrl: null, appleLink: null, youtubeLink: null }),
    ])
    const prev = body.tracks.find((t: any) => t.title === before.title)
    expect(prev).toMatchObject({ isCurrent: false, durationSeconds: CUE - before.startSeconds! })
    expect(body.tracks.find((t: any) => t.title === after.title)).toMatchObject({ isCurrent: false })
    expect(audit.status).toBe('unidentified')
    expect(audit.select).toMatchObject({ currentFromAnonymousRow: true, anonymousRowCount: 1, trackCount: plain.tracks.length })
  })

  it('before the anonymous cue, the previous track is current and named as before', async () => {
    serve(edited({ cued: true }))
    const { body, audit } = await ask(CUE - 10)
    expect(body.status).toBe('ok')
    expect(body.tracks.filter((t: any) => t.isCurrent).map((t: any) => t.title)).toEqual([before.title])
    expect(audit.select.currentFromAnonymousRow).toBe(false)
  })

  it('a named "w/" row on the anonymous row is reported as the current track', async () => {
    serve(edited({ cued: true, layeredNamed: true }))
    const { body, audit } = await ask(CUE + 10)
    expect(body.status).toBe('ok')
    expect(body.tracks.filter((t: any) => t.isCurrent)).toEqual([expect.objectContaining({ artist: 'Partner', title: 'Acapella', startSeconds: CUE, isUnidentified: false })])
    expect(body.tracks.some((t: any) => t.title === 'ID' && t.artist === 'ID')).toBe(false)
    expect(audit.select).toMatchObject({ currentFromAnonymousRow: true })
  })

  it('an anonymous row without a cue of its own changes nothing', async () => {
    serve(page)
    const base = await ask(CUE + 10)
    serve(edited({ cued: false }))
    const withAnon = await ask(CUE + 10)
    expect(withAnon.body).toEqual(base.body)
    expect(withAnon.body.tracks.filter((t: any) => t.isCurrent).map((t: any) => t.title)).toEqual([before.title])
    expect(withAnon.audit.select.currentFromAnonymousRow).toBe(false)
  })
})
