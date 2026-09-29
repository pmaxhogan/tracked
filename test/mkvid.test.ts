import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Env } from '../src/types'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'
import {
  dailyClaimCap,
  getMkvidLastPoll,
  listPendingMkvidRequests,
  listSettledMkvidRequests,
  quotaDayEnd,
  requestSummary,
  dailyClaimsUsed,
  extractSetDate,
  nextMkvidRequests,
  quotaDayStart,
  claimMkvidRequest,
  completeMkvidRequest,
  countMkvidRequests,
  enqueueMkvidRequest,
  extractSetAudioSource,
  extractSetTitle,
  failMkvidRequest,
  getMkvidRequest,
  getMkvidRequestForSet,
  lastCueSeconds,
  listMkvidRequests,
  listMkvidQueuePage,
  listMkvidSettledPage,
  listMkvidDjs,
  banMkvidRequest,
  moveMkvidRequest,
  mkvidAccountUsage,
  MKVID_MAX_ATTEMPTS,
  retryMkvidRequest,
  supersedeMkvidRequestForSet,
  findMkvidUploadByTitle,
  getMkvidTracks,
  mkvidTracksTrusted,
  saveMkvidTracks,
  toMkvidTracks,
  MKVID_MAX_TRACKS,
} from '../src/lib/mkvid'
import { parseTracklist } from '../src/lib/tracklists1001'
import { noteSetFetch } from '../src/lib/verification'
import { DEFAULT_POOL_SETTINGS } from '../src/lib/pool-settings'
import { MkvidClaimResponse } from '../src/schemas'
import { loadSubState, saveSubState } from '../src/lib/sync-store'
import { makeLogger } from '../src/lib/log'

vi.mock('../src/lib/youtube-playlists', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/youtube-playlists')>('../src/lib/youtube-playlists')
  return {
    ...actual,
    findPlaylistByTitle: vi.fn(),
    createPlaylist: vi.fn(),
    listPlaylistVideoIds: vi.fn(),
    addVideoToPlaylist: vi.fn(),
    removeVideoFromPlaylist: vi.fn(),
  }
})
import { addVideoToPlaylist, createPlaylist, findPlaylistByTitle, listPlaylistVideoIds } from '../src/lib/youtube-playlists'

function makeEnv(overrides: Partial<Env> = {}): Env {
  return { CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k', MKVID_TOKEN: 'mk', ...overrides } as Env
}
const log = makeLogger({ task: 'test' })
const NOW = Math.floor(Date.now() / 1000)
const fixture = (name: string) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8')

const input = {
  slug: 'lillypalmer',
  setUrl: 'https://www.1001tracklists.com/tracklist/abc/lilly-palmer-x.html',
  artistName: 'Lilly Palmer',
  setTitle: 'Lilly Palmer @ X 2026-09-01',
  setDate: '2026-09-01',
  source: { kind: 'soundcloud' as const, url: 'https://api.soundcloud.com/tracks/123' },
  lastCueSeconds: 3600,
  trackCount: 20,
  idedCount: 18,
}

beforeEach(() => {
  vi.resetAllMocks()
  ;(listPlaylistVideoIds as ReturnType<typeof vi.fn>).mockImplementation(async () => new Set<string>())
})

describe('extractSetAudioSource', () => {
  it('finds the SoundCloud recording on real set pages and nothing on a YouTube-only page', () => {
    expect(extractSetAudioSource(fixture('tracklist-maxstyler.html'))).toEqual({ kind: 'soundcloud', url: 'https://api.soundcloud.com/tracks/2099378310' })
    expect(extractSetAudioSource(fixture('tracklist-habstrakt.html'))).toEqual({ kind: 'soundcloud', url: 'https://api.soundcloud.com/tracks/1955469523' })
    expect(extractSetAudioSource(fixture('tracklist-matroda.html'))).toBeNull()
  })

  it('prefers SoundCloud over hearthis when a page has both', () => {
    const html = '<iframe src="https://app.hearthis.at/embed/123/transparent_black/"></iframe><iframe src="https://w.soundcloud.com/player/?url=https://api.soundcloud.com/tracks/9&amp;x=1"></iframe>'
    expect(extractSetAudioSource(html)).toEqual({ kind: 'soundcloud', url: 'https://api.soundcloud.com/tracks/9' })
  })

  it.each([
    ['app embed', '<iframe src="https://app.hearthis.at/embed/14673927/transparent_black/?hcolor=&color=&style=2"></iframe>', 'https://hearthis.at/embed/14673927/'],
    ['bare embed', "<iframe src='https://hearthis.at/embed/555/'></iframe>", 'https://hearthis.at/embed/555/'],
    ['track page link', '<a href="https://hearthis.at/paul-newman-ml/paul-newmans-smooth-sunday-13th-september-2026/">listen</a>', 'https://hearthis.at/paul-newman-ml/paul-newmans-smooth-sunday-13th-september-2026/'],
    ['www track page, no trailing slash', 'see https://www.hearthis.at/dj_x/my.set-2026 now', 'https://hearthis.at/dj_x/my.set-2026/'],
  ])('accepts hearthis %s', (_label, html, url) => {
    expect(extractSetAudioSource(html)).toEqual({ kind: 'hearthis', url })
  })

  it('ignores hearthis links that are not a track page', () => {
    expect(extractSetAudioSource('<a href="https://hearthis.at/user/someone/">profile</a> <a href="https://hearthis.at/search/x/">s</a>')).toBeNull()
    expect(extractSetAudioSource('<a href="https://hearthis.at/">home</a>')).toBeNull()
  })
})

describe('extractSetTitle / lastCueSeconds', () => {
  it('reads and decodes the page title, rejecting the site-wide one', () => {
    expect(extractSetTitle(fixture('tracklist-habstrakt.html'))).toBe(
      'Habstrakt & JSTJR @ 1001Tracklists x DJ Lovers Club pres. WaterWays, Amsterdam Dance Event, Netherlands 2024-11-11',
    )
    expect(extractSetTitle(fixture('tracklist-matroda.html'))).toBe('Matroda @ Club Space Miami, United States 2023-08-05')
    expect(extractSetTitle(fixture('tracklist-neptune.html'))).toBeNull()
    expect(extractSetTitle('<title>Some Set | 1001Tracklists</title>')).toBe('Some Set')
    expect(extractSetTitle('<html></html>')).toBeNull()
  })

  it('lastCueSeconds is the largest cue, null when nothing is cued', () => {
    expect(lastCueSeconds([{ startSeconds: 10 }, { startSeconds: null }, { startSeconds: 4500 }, { startSeconds: 300 }])).toBe(4500)
    expect(lastCueSeconds([{ startSeconds: null }])).toBeNull()
    expect(lastCueSeconds([])).toBeNull()
  })
})

describe('queue lifecycle', () => {
  it('enqueues once per set and lists/counts it', async () => {
    const env = makeEnv()
    expect(await enqueueMkvidRequest(env, input)).toBe('queued')
    expect(await enqueueMkvidRequest(env, { ...input, setTitle: 'other' })).toBe('exists')
    const list = await listMkvidRequests(env)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ slug: 'lillypalmer', setUrl: input.setUrl, status: 'pending', attempts: 0, source: 'soundcloud', lastCueSeconds: 3600, idedCount: 18 })
    expect(await countMkvidRequests(env)).toEqual({ pending: 1, claimed: 0, done: 0, failed: 0, superseded: 0, banned: 0 })
    expect((await getMkvidRequestForSet(env, input.setUrl))!.id).toBe(list[0]!.id)
  })

  it('claim hands out the oldest pending request and marks it claimed', async () => {
    const env = makeEnv()
    await enqueueMkvidRequest(env, { ...input, setUrl: 'https://x/tracklist/first' })
    await new Promise((r) => setTimeout(r, 5))
    // Same created_at second is possible; created_at ASC then falls back to insertion order.
    await enqueueMkvidRequest(env, { ...input, setUrl: 'https://x/tracklist/second' })
    const a = await claimMkvidRequest(env, log)
    expect(a).toMatchObject({ setUrl: 'https://x/tracklist/first', status: 'claimed', attempts: 1 })
    expect(a!.claimedAt).toBeGreaterThanOrEqual(NOW)
    const b = await claimMkvidRequest(env, log)
    expect(b).toMatchObject({ setUrl: 'https://x/tracklist/second', status: 'claimed', attempts: 1 })
    expect(await claimMkvidRequest(env, log)).toBeNull()
  })

  it('claim skips (and supersedes) a request whose set already has a video', async () => {
    const env = makeEnv()
    await saveSubState(env, 'lillypalmer', {
      processedTracklistUrls: [input.setUrl],
      tracklistVideos: { [input.setUrl]: { videoId: 'realVid1234', checkedAt: NOW } },
    })
    await enqueueMkvidRequest(env, input)
    expect(await claimMkvidRequest(env, log)).toBeNull()
    expect((await getMkvidRequestForSet(env, input.setUrl))!).toMatchObject({ status: 'superseded', error: 'set already resolves to realVid1234 (1001tl)' })
  })

  it('a claim older than the claim TTL is handed out again; attempts are capped', async () => {
    const env = makeEnv({ MKVID_CLAIM_TTL_SECONDS: '60', MKVID_DAILY_CLAIM_CAP: '10' })
    await enqueueMkvidRequest(env, input)
    const first = (await claimMkvidRequest(env, log))!
    expect(await claimMkvidRequest(env, log)).toBeNull()
    // Age the claim past the TTL.
    await env.DB.prepare('UPDATE mkvid_requests SET claimed_at = ? WHERE id = ?').bind(NOW - 120, first.id).run()
    const again = (await claimMkvidRequest(env, log))!
    expect(again).toMatchObject({ id: first.id, status: 'claimed', attempts: 2 })
    await env.DB.prepare('UPDATE mkvid_requests SET claimed_at = ?, attempts = ? WHERE id = ?').bind(NOW - 120, MKVID_MAX_ATTEMPTS, first.id).run()
    expect(await claimMkvidRequest(env, log)).toBeNull()
    expect((await getMkvidRequest(env, first.id))!).toMatchObject({ status: 'failed', error: 'too many attempts' })
  })

  it('fail: retryable goes back to pending with a backoff, permanent parks it, exhausted parks it', async () => {
    const env = makeEnv()
    await enqueueMkvidRequest(env, input)
    const req = (await claimMkvidRequest(env, log))!
    expect(await failMkvidRequest(env, { id: req.id, error: 'yt-dlp exit 1', jobId: 'job1' }, log)).toEqual({ status: 'pending', attempts: 1 })
    const r1 = (await getMkvidRequest(env, req.id))!
    expect(r1.notBefore).toBeGreaterThan(NOW + 5 * 3600)
    expect(r1.jobId).toBe('job1')
    expect(r1.error).toBe('yt-dlp exit 1')
    // Not claimable until the backoff lapses.
    expect(await claimMkvidRequest(env, log)).toBeNull()
    await env.DB.prepare('UPDATE mkvid_requests SET not_before = 0 WHERE id = ?').bind(req.id).run()
    expect((await claimMkvidRequest(env, log))!.attempts).toBe(2)
    expect(await failMkvidRequest(env, { id: req.id, error: 'incomplete_recording: 1800s < last cue 3600s', permanent: true }, log)).toEqual({ status: 'failed', attempts: 2 })
    expect(await claimMkvidRequest(env, log)).toBeNull()
    // Retry from the panel resets it.
    expect(await retryMkvidRequest(env, req.id)).toBe(true)
    expect((await getMkvidRequest(env, req.id))!).toMatchObject({ status: 'pending', attempts: 0, notBefore: null, error: null })
    expect(await failMkvidRequest(env, { id: 'nope', error: 'x' }, log)).toBeNull()
  })

  it('extractSetDate: URL slug first, then date-only datePublished meta, then the title', () => {
    const html = fixture('tracklist-maxstyler.html')
    expect(extractSetDate('https://www.1001tracklists.com/tracklist/1pmwyfn1/max-styler-circuitgrounds-edc-las-vegas-united-states-2025-05-16.html', html)).toBe('2025-05-16')
    // No date in the URL → the page's date-only meta wins over the timestamped page-publication one.
    expect(extractSetDate('https://www.1001tracklists.com/tracklist/1pmwyfn1/max-styler.html', html)).toBe('2025-05-16')
    expect(extractSetDate('https://x/tracklist/y.html', '<title>Some DJ @ Somewhere 2024-11-11 | 1001Tracklists</title>')).toBe('2024-11-11')
    expect(extractSetDate('https://x/tracklist/y-2024-13-45.html', '<title>Some DJ @ Somewhere</title>')).toBeNull()
    expect(extractSetDate('https://x/tracklist/y.html', fixture('tracklist-neptune.html'))).toBeNull()
  })

  it('serves the newest set first, undated sets last, ties by most recently queued', async () => {
    const env = makeEnv({ MKVID_DAILY_CLAIM_CAP: '10' })
    const q = async (n: string, setDate: string | null) => {
      await enqueueMkvidRequest(env, { ...input, setUrl: `https://x/tracklist/${n}`, setDate })
      // sql.js has second resolution on created_at; force distinct queue times.
      await env.DB.prepare('UPDATE mkvid_requests SET created_at = created_at + ? WHERE set_url = ?').bind(['old', 'mid', 'new', 'undated-old', 'undated-new'].indexOf(n), `https://x/tracklist/${n}`).run()
    }
    await q('old', '2014-03-06')
    await q('undated-old', null)
    await q('new', '2026-09-11')
    await q('undated-new', null)
    await q('mid', '2023-08-05')
    expect((await nextMkvidRequests(env, 10)).map((r) => r.setUrl.split('/').pop())).toEqual(['new', 'mid', 'old', 'undated-new', 'undated-old'])
    expect((await claimMkvidRequest(env, log))!.setDate).toBe('2026-09-11')
    expect((await claimMkvidRequest(env, log))!.setDate).toBe('2023-08-05')
    expect((await claimMkvidRequest(env, log))!.setDate).toBe('2014-03-06')
    expect((await claimMkvidRequest(env, log))!.setUrl).toBe('https://x/tracklist/undated-new')
    expect((await claimMkvidRequest(env, log))!.setUrl).toBe('https://x/tracklist/undated-old')
    expect(await nextMkvidRequests(env)).toEqual([])
  })

  it('quotaDayStart is the most recent midnight Pacific', () => {
    // 2026-09-14T18:30:00Z is 11:30 PDT → day began 07:00Z.
    expect(quotaDayStart(Date.UTC(2026, 8, 14, 18, 30, 0))).toBe(Date.UTC(2026, 8, 14, 7, 0, 0) / 1000)
    // 2026-09-15T02:00:00Z is still 19:00 PDT on the 14th → same day start, not 00:00Z.
    expect(quotaDayStart(Date.UTC(2026, 8, 15, 2, 0, 0))).toBe(Date.UTC(2026, 8, 14, 7, 0, 0) / 1000)
    // In winter (PST) the day begins at 08:00Z.
    expect(quotaDayStart(Date.UTC(2026, 0, 10, 12, 0, 0))).toBe(Date.UTC(2026, 0, 10, 8, 0, 0) / 1000)
  })

  it('a claim refused before rendering or requeued does not use a daily slot', async () => {
    const env = makeEnv()
    for (const n of [1, 2, 3]) await enqueueMkvidRequest(env, { ...input, setUrl: `https://x/tracklist/${n}` })
    const a = (await claimMkvidRequest(env, log))!
    await failMkvidRequest(env, { id: a.id, error: 'incomplete_recording', permanent: true, jobId: null }, log)
    const b = (await claimMkvidRequest(env, log))!
    await failMkvidRequest(env, { id: b.id, error: 'yt-dlp exit 1', jobId: null }, log)
    expect(await dailyClaimsUsed(env)).toBe(0)
    expect(await claimMkvidRequest(env, log)).not.toBeNull()
    expect(await dailyClaimsUsed(env)).toBe(1)
  })

  it('hands out at most MKVID_DAILY_CLAIM_CAP requests per quota day on the primary account (default 24)', async () => {
    const env = makeEnv()
    const n = 25
    for (let i = 1; i <= n; i++) await enqueueMkvidRequest(env, { ...input, setUrl: `https://x/tracklist/${i}`, setDate: null })
    for (let i = 1; i <= 24; i++) expect(await claimMkvidRequest(env, log)).not.toBeNull()
    expect(await claimMkvidRequest(env, log)).toBeNull()
    expect(await countMkvidRequests(env)).toMatchObject({ pending: 1, claimed: 24 })
    expect(await dailyClaimsUsed(env)).toBe(24)
    expect(await dailyClaimsUsed(env, 'shared')).toBe(0)
    // With the shared account offered too, the defaults add up to 30 a day.
    expect((await claimMkvidRequest(env, log, ['primary', 'shared']))!).toMatchObject({ account: 'shared' })
    expect((await mkvidAccountUsage(env)).reduce((t, u) => t + u.cap, 0)).toBe(30)

    const lowered = makeEnv({ MKVID_DAILY_CLAIM_CAP: '2' })
    for (const n of [1, 2, 3]) await enqueueMkvidRequest(lowered, { ...input, setUrl: `https://x/tracklist/${n}` })
    for (let i = 0; i < 2; i++) expect(await claimMkvidRequest(lowered, log)).not.toBeNull()
    expect(await claimMkvidRequest(lowered, log)).toBeNull()
    const off = makeEnv({ MKVID_DAILY_CLAIM_CAP: '0' })
    await enqueueMkvidRequest(off, input)
    expect(await claimMkvidRequest(off, log)).toBeNull()
  })

  it('fills the primary account first, spills to the shared one, and only among the accounts mkvid offers', async () => {
    const env = makeEnv({ MKVID_DAILY_CLAIM_CAP: '1', MKVID_SHARED_DAILY_CLAIM_CAP: '2' })
    for (const n of [1, 2, 3, 4]) await enqueueMkvidRequest(env, { ...input, setUrl: `https://x/tracklist/${n}`, setDate: `2026-09-0${5 - n}` })
    const both = ['primary', 'shared'] as const
    expect((await claimMkvidRequest(env, log, both))!).toMatchObject({ setUrl: 'https://x/tracklist/1', account: 'primary' })
    expect((await claimMkvidRequest(env, log, both))!).toMatchObject({ setUrl: 'https://x/tracklist/2', account: 'shared' })
    // Only the primary is connected: its cap is used, so nothing — the shared slot is not offered.
    expect(await claimMkvidRequest(env, log, ['primary'])).toBeNull()
    expect(await getMkvidLastPoll(env)).toMatchObject({ outcome: 'capped', accounts: ['primary'] })
    expect((await claimMkvidRequest(env, log, both))!).toMatchObject({ setUrl: 'https://x/tracklist/3', account: 'shared' })
    expect(await claimMkvidRequest(env, log, both)).toBeNull()
    expect(await mkvidAccountUsage(env)).toEqual([
      { account: 'primary', label: 'mkvid-uploads', used: 1, cap: 1 },
      { account: 'shared', label: 'tracked-youtube', used: 2, cap: 2 },
    ])
    // The row remembers which project it went out for; the panel shows the project name.
    const rows = await listSettledMkvidRequests(env)
    expect(rows.map((r) => [r.setUrl.split('/').pop(), r.account])).toEqual([['1', 'primary'], ['2', 'shared'], ['3', 'shared']])
    expect(requestSummary(rows[1]!)).toMatchObject({ account: 'shared', accountLabel: 'tracked-youtube' })

    // mkvid with no YouTube account connected at all: nothing is handed out, and the panel can say why.
    expect(await claimMkvidRequest(env, log, [])).toBeNull()
    expect(await getMkvidLastPoll(env)).toMatchObject({ outcome: 'not_connected', accounts: [] })

    // A failed request retried later is reassigned to whichever account has room then.
    await failMkvidRequest(env, { id: rows[0]!.id, error: 'boom', permanent: true }, log)
    expect(await retryMkvidRequest(env, rows[0]!.id)).toBe(true)
    const fresh = makeEnv({ MKVID_DAILY_CLAIM_CAP: '0', MKVID_SHARED_DAILY_CLAIM_CAP: '5', DB: env.DB })
    expect((await claimMkvidRequest(fresh, log, both))!).toMatchObject({ setUrl: 'https://x/tracklist/1', account: 'shared' })
  })

  it('a blank cap is the default, not a pause — only a literal 0 pauses', () => {
    expect(dailyClaimCap(makeEnv())).toBe(24)
    for (const blank of ['', ' ', '\r\n']) expect(dailyClaimCap(makeEnv({ MKVID_DAILY_CLAIM_CAP: blank }))).toBe(24)
    expect(dailyClaimCap(makeEnv({ MKVID_DAILY_CLAIM_CAP: 'two' }))).toBe(24)
    expect(dailyClaimCap(makeEnv({ MKVID_DAILY_CLAIM_CAP: '-1' }))).toBe(24)
    expect(dailyClaimCap(makeEnv({ MKVID_DAILY_CLAIM_CAP: '0' }))).toBe(0)
    expect(dailyClaimCap(makeEnv({ MKVID_DAILY_CLAIM_CAP: ' 5\n' }))).toBe(5)
    // The shared (sync's) project takes the spill-over: 6 by default, 30 a day in total.
    expect(dailyClaimCap(makeEnv(), 'shared')).toBe(6)
    expect(dailyClaimCap(makeEnv({ MKVID_SHARED_DAILY_CLAIM_CAP: '' }), 'shared')).toBe(6)
    expect(dailyClaimCap(makeEnv({ MKVID_SHARED_DAILY_CLAIM_CAP: '0' }), 'shared')).toBe(0)
    expect(dailyClaimCap(makeEnv({ MKVID_SHARED_DAILY_CLAIM_CAP: '3' }), 'shared')).toBe(3)
    expect(dailyClaimCap(makeEnv({ MKVID_SHARED_DAILY_CLAIM_CAP: '3' }))).toBe(24)
  })

  it('quotaDayEnd is the next Pacific midnight, across a DST change too', () => {
    expect(quotaDayEnd(Date.parse('2026-09-17T23:30:00Z'))).toBe(Date.parse('2026-09-18T07:00:00Z') / 1000)
    // 2026-11-01 is a 25-hour day in Los Angeles.
    expect(quotaDayEnd(Date.parse('2026-11-01T12:00:00Z'))).toBe(Date.parse('2026-11-02T08:00:00Z') / 1000)
    // 2026-03-08 is a 23-hour one.
    expect(quotaDayEnd(Date.parse('2026-03-08T12:00:00Z'))).toBe(Date.parse('2026-03-09T07:00:00Z') / 1000)
  })

  it('remembers what the last poll got, so the panel can tell a capped queue from a silent mkvid', async () => {
    const env = makeEnv({ MKVID_DAILY_CLAIM_CAP: '1', MKVID_SHARED_DAILY_CLAIM_CAP: '0' })
    expect(await getMkvidLastPoll(env)).toBeNull()
    await claimMkvidRequest(env, log)
    expect(await getMkvidLastPoll(env)).toMatchObject({ outcome: 'empty' })
    for (const n of [1, 2]) await enqueueMkvidRequest(env, { ...input, setUrl: `https://x/tracklist/${n}` })
    await claimMkvidRequest(env, log)
    expect(await getMkvidLastPoll(env)).toMatchObject({ outcome: 'claimed' })
    await claimMkvidRequest(env, log)
    const capped = await getMkvidLastPoll(env)
    expect(capped).toMatchObject({ outcome: 'capped' })
    expect(capped!.at).toBeGreaterThanOrEqual(NOW)

    // An unchanged outcome is not rewritten every minute (KV write budget)…
    const put = vi.spyOn(env.CACHE, 'put')
    await claimMkvidRequest(env, log)
    expect(put).not.toHaveBeenCalled()
    // …but a change in what mkvid offers is.
    await claimMkvidRequest(env, log, ['primary', 'shared'])
    expect(put).toHaveBeenCalledTimes(1)
    expect(await getMkvidLastPoll(env)).toMatchObject({ outcome: 'capped', accounts: ['primary', 'shared'] })
  })

  it('lists the waiting line in claim order, apart from what has left it', async () => {
    const env = makeEnv({ MKVID_DAILY_CLAIM_CAP: '10' })
    await enqueueMkvidRequest(env, { ...input, setUrl: 'https://x/tracklist/old', setDate: '2021-01-01' })
    await enqueueMkvidRequest(env, { ...input, setUrl: 'https://x/tracklist/new', setDate: '2026-01-01' })
    await enqueueMkvidRequest(env, { ...input, setUrl: 'https://x/tracklist/mid', setDate: '2024-01-01' })
    const first = await claimMkvidRequest(env, log)
    await failMkvidRequest(env, { id: first!.id, error: 'incomplete_recording', permanent: true }, log)
    await claimMkvidRequest(env, log)
    expect((await listPendingMkvidRequests(env)).map((r) => r.setUrl.split('/').pop())).toEqual(['old'])
    expect((await listSettledMkvidRequests(env)).map((r) => [r.setUrl.split('/').pop(), r.status])).toEqual([['mid', 'claimed'], ['new', 'failed']])
  })

  it('shows the artist without the "Tracklists By" prefix the stored name carries', async () => {
    const env = makeEnv()
    await enqueueMkvidRequest(env, { ...input, artistName: 'Tracklists By John Summit' })
    const [r] = await listPendingMkvidRequests(env)
    expect(requestSummary(r!)).toMatchObject({ artistName: 'Tracklists By John Summit', artistLabel: 'John Summit', sourceLabel: 'SoundCloud' })
  })

  it('top / up / down / bottom move a pending row exactly as far as asked, ties included, and new sets still slot in by date', async () => {
    const env = makeEnv({ MKVID_DAILY_CLAIM_CAP: '10' })
    const ids: Record<string, string> = {}
    let t = 0
    const q = async (n: string, setDate: string | null) => {
      await enqueueMkvidRequest(env, { ...input, setUrl: `https://x/tracklist/${n}`, setDate })
      await env.DB.prepare('UPDATE mkvid_requests SET created_at = created_at + ? WHERE set_url = ?').bind(t++, `https://x/tracklist/${n}`).run()
      ids[n] = (await getMkvidRequestForSet(env, `https://x/tracklist/${n}`))!.id
    }
    const order = async () => (await listPendingMkvidRequests(env)).map((r) => r.setUrl.split('/').pop())
    await q('A', '2026-09-13'); await q('B', '2026-09-11'); await q('C', '2026-09-05'); await q('D', '2026-09-05'); await q('E', null)
    expect(await order()).toEqual(['A', 'B', 'D', 'C', 'E'])   // C and D tie on date; D was queued later

    expect(await moveMkvidRequest(env, ids.E!, 'top')).toEqual({ position: 1, rekeyed: 1 })
    expect(await order()).toEqual(['E', 'A', 'B', 'D', 'C'])
    expect(await moveMkvidRequest(env, ids.E!, 'top')).toEqual({ position: 1, rekeyed: 0 })
    expect(await moveMkvidRequest(env, ids.E!, 'bottom')).toEqual({ position: 5, rekeyed: 1 })
    expect(await order()).toEqual(['A', 'B', 'D', 'C', 'E'])
    // Up across a tie: exactly one step, the tie block is re-spaced, nothing else moves.
    expect(await moveMkvidRequest(env, ids.C!, 'up')).toMatchObject({ position: 3 })
    expect(await order()).toEqual(['A', 'B', 'C', 'D', 'E'])
    expect(await moveMkvidRequest(env, ids.C!, 'up')).toMatchObject({ position: 2 })
    expect(await order()).toEqual(['A', 'C', 'B', 'D', 'E'])
    expect(await moveMkvidRequest(env, ids.A!, 'down')).toMatchObject({ position: 2 })
    expect(await order()).toEqual(['C', 'A', 'B', 'D', 'E'])
    expect(await moveMkvidRequest(env, ids.E!, 'down')).toEqual({ position: 5, rekeyed: 0 })
    // A set the sync queues later still lands by date among the hand-sorted rows.
    await q('F', '2026-09-10')
    expect(await order()).toEqual(['C', 'A', 'B', 'F', 'D', 'E'])
    // …but never ahead of a row put at the top, even when it is newer than everything queued.
    expect(await moveMkvidRequest(env, ids.D!, 'top')).toMatchObject({ position: 1 })
    await q('G', new Date().toISOString().slice(0, 10))
    expect(await order()).toEqual(['D', 'G', 'C', 'A', 'B', 'F', 'E'])
    // The claim follows the same order.
    expect((await claimMkvidRequest(env, log))!.setUrl).toBe('https://x/tracklist/D')
    expect(await moveMkvidRequest(env, ids.D!, 'up')).toBeNull()   // not pending any more
    expect(await moveMkvidRequest(env, crypto.randomUUID(), 'up')).toBeNull()

    // A queue that is one big tie (all undated) still moves one step at a time.
    const tie = makeEnv({ MKVID_DAILY_CLAIM_CAP: '10' })
    for (const n of ['u1', 'u2', 'u3']) {
      await enqueueMkvidRequest(tie, { ...input, setUrl: `https://x/tracklist/${n}`, setDate: null })
      await tie.DB.prepare('UPDATE mkvid_requests SET created_at = created_at + ? WHERE set_url = ?').bind(Number(n[1]), `https://x/tracklist/${n}`).run()
    }
    const tieOrder = async () => (await listPendingMkvidRequests(tie)).map((r) => r.setUrl.split('/').pop())
    expect(await tieOrder()).toEqual(['u3', 'u2', 'u1'])
    const u1 = (await getMkvidRequestForSet(tie, 'https://x/tracklist/u1'))!.id
    await moveMkvidRequest(tie, u1, 'up')
    expect(await tieOrder()).toEqual(['u3', 'u1', 'u2'])
    await moveMkvidRequest(tie, u1, 'up')
    expect(await tieOrder()).toEqual(['u1', 'u3', 'u2'])
  })

  it('ban parks a set for good — never claimed, never re-queued by the sync — until the panel lifts it', async () => {
    const env = makeEnv()
    await enqueueMkvidRequest(env, input)
    const id = (await getMkvidRequestForSet(env, input.setUrl))!.id
    expect(await banMkvidRequest(env, id)).toBe(true)
    expect((await getMkvidRequest(env, id))!).toMatchObject({ status: 'banned', error: 'banned from the panel' })
    expect(await claimMkvidRequest(env, log)).toBeNull()
    expect(await enqueueMkvidRequest(env, input)).toBe('exists')
    expect(await countMkvidRequests(env)).toMatchObject({ pending: 0, banned: 1 })
    expect((await listSettledMkvidRequests(env)).map((r) => r.status)).toEqual(['banned'])
    expect((await listPendingMkvidRequests(env))).toEqual([])
    expect(await banMkvidRequest(env, id)).toBe(false)   // already banned
    // Unban = the ordinary retry: back to pending, same place in the queue.
    expect(await retryMkvidRequest(env, id)).toBe(true)
    expect((await getMkvidRequest(env, id))!).toMatchObject({ status: 'pending', error: null })
    expect((await claimMkvidRequest(env, log))!.id).toBe(id)
    // A set mkvid is rendering cannot be banned out from under it.
    expect(await banMkvidRequest(env, id)).toBe(false)
  })

  it('supersede only touches live requests', async () => {
    const env = makeEnv()
    await enqueueMkvidRequest(env, input)
    expect(await supersedeMkvidRequestForSet(env, input.setUrl, 'realVid1234')).toBe(true)
    expect((await getMkvidRequestForSet(env, input.setUrl))!.status).toBe('superseded')
    expect(await supersedeMkvidRequestForSet(env, input.setUrl, 'realVid1234')).toBe(false)
    expect(await supersedeMkvidRequestForSet(env, 'https://x/unknown', 'realVid1234')).toBe(false)
  })
})

describe('completeMkvidRequest', () => {
  function playlistsExist(artist = 'PLartist', combined = 'PLcombined') {
    ;(findPlaylistByTitle as ReturnType<typeof vi.fn>).mockImplementation(async (title: string) =>
      title.startsWith('All tracked artists') ? { id: combined, title } : { id: artist, title },
    )
  }

  it('adds the upload to the artist + combined playlists, records it on the tracklist row and audits it', async () => {
    const env = makeEnv()
    await saveSubState(env, 'lillypalmer', {
      playlistId: 'PLartist',
      artistName: 'Lilly Palmer',
      processedTracklistUrls: [input.setUrl],
      tracklistVideos: { [input.setUrl]: { videoId: null, checkedAt: NOW - 100 } },
    })
    playlistsExist()
    await enqueueMkvidRequest(env, input)
    const req = (await claimMkvidRequest(env, log))!

    const r = await completeMkvidRequest(env, { id: req.id, videoId: 'upload12345', videoUrl: 'https://youtu.be/upload12345', privacy: 'unlisted', jobId: 'job9' }, 'tok', log)

    expect(r).toEqual({ status: 'done', videoId: 'upload12345', playlistId: 'PLartist', playlistStatus: 'added', combinedStatus: 'added' })
    expect((addVideoToPlaylist as ReturnType<typeof vi.fn>).mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['PLartist', 'upload12345'],
      ['PLcombined', 'upload12345'],
    ])
    const state = (await loadSubState(env, 'lillypalmer'))!
    expect(state.tracklistVideos![input.setUrl]).toEqual({ videoId: 'upload12345', checkedAt: expect.any(Number), source: 'mkvid' })
    expect((await getMkvidRequest(env, req.id))!).toMatchObject({ status: 'done', videoId: 'upload12345', privacy: 'unlisted', jobId: 'job9', error: null })
    const audit = await env.DB.prepare('SELECT record FROM playlist_additions').all<{ record: string }>()
    expect(audit.results).toHaveLength(1)
    expect(JSON.parse(audit.results[0]!.record)).toMatchObject({ status: 'added', via: 'mkvid', trigger: 'mkvid', videoId: 'upload12345', slug: 'lillypalmer', combinedStatus: 'added' })
    // Membership caches were updated so the next sync tick doesn't re-list.
    expect(await env.CACHE.get('yt:plvids:PLartist', 'json')).toEqual({ videoIds: ['upload12345'] })
  })

  it('creates the artist playlist when the DJ was never synced', async () => {
    const env = makeEnv()
    ;(findPlaylistByTitle as ReturnType<typeof vi.fn>).mockImplementation(async (title: string) =>
      title.startsWith('All tracked artists') ? { id: 'PLcombined', title } : null,
    )
    ;(createPlaylist as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'PLnew', title: 'Lilly Palmer (1001tklists)' })
    await enqueueMkvidRequest(env, input)
    const req = (await claimMkvidRequest(env, log))!
    const r = await completeMkvidRequest(env, { id: req.id, videoId: 'upload12345' }, 'tok', log)
    expect(r).toMatchObject({ status: 'done', playlistId: 'PLnew', playlistStatus: 'added' })
    expect(createPlaylist).toHaveBeenCalledTimes(1)
    expect((await loadSubState(env, 'lillypalmer'))!.playlistId).toBe('PLnew')
  })

  it('supersedes instead of inserting when the set gained a real recording mid-render', async () => {
    const env = makeEnv()
    await saveSubState(env, 'lillypalmer', {
      playlistId: 'PLartist',
      processedTracklistUrls: [input.setUrl],
      tracklistVideos: { [input.setUrl]: { videoId: null, checkedAt: NOW - 100 } },
    })
    playlistsExist()
    await enqueueMkvidRequest(env, input)
    const req = (await claimMkvidRequest(env, log))!
    // A recheck found a YouTube recording while mkvid was busy.
    await saveSubState(env, 'lillypalmer', {
      playlistId: 'PLartist',
      processedTracklistUrls: [input.setUrl],
      tracklistVideos: { [input.setUrl]: { videoId: 'realVid1234', checkedAt: NOW } },
    })
    const r = await completeMkvidRequest(env, { id: req.id, videoId: 'upload12345', privacy: 'unlisted' }, 'tok', log)
    expect(r).toEqual({ status: 'superseded', videoId: 'upload12345', existingVideoId: 'realVid1234' })
    expect(addVideoToPlaylist).not.toHaveBeenCalled()
    expect((await getMkvidRequest(env, req.id))!).toMatchObject({ status: 'superseded', videoId: 'upload12345' })
    expect((await loadSubState(env, 'lillypalmer'))!.tracklistVideos![input.setUrl]!.videoId).toBe('realVid1234')
  })

  it('rejects unknown ids and already-finished requests', async () => {
    const env = makeEnv()
    playlistsExist()
    expect(await completeMkvidRequest(env, { id: 'nope', videoId: 'upload12345' }, 'tok', log)).toEqual({ status: 'not_found' })
    await enqueueMkvidRequest(env, input)
    const req = (await claimMkvidRequest(env, log))!
    await completeMkvidRequest(env, { id: req.id, videoId: 'upload12345' }, 'tok', log)
    expect(await completeMkvidRequest(env, { id: req.id, videoId: 'upload12345' }, 'tok', log)).toEqual({ status: 'invalid_state', current: 'done' })
  })
})

describe('findMkvidUploadByTitle — /now-playing resolving a set we uploaded ourselves', () => {
  const done = async (env: Env, id: string, setTitle: string, videoId: string | null, status = 'done', updatedAt = NOW) =>
    env.DB.prepare(
      `INSERT INTO mkvid_requests (id, slug, set_url, set_title, source, source_url, status, video_id, created_at, updated_at)
       VALUES (?, 'maup', ?, ?, 'soundcloud', 'https://api.soundcloud.com/tracks/1', ?, ?, ?, ?)`,
    )
      .bind(id, `https://www.1001tracklists.com/tracklist/${id}/x.html`, setTitle, status, videoId, NOW, updatedAt)
      .run()

  it('finds a finished upload by its exact title, case-insensitively and trimmed', async () => {
    const env = makeEnv()
    await done(env, 'r1', 'Mau P @ Panorama Festival, Italy 2026-08-16', '7-HvbsxBq-4')
    const hit = await findMkvidUploadByTitle(env, '  mau p @ panorama festival, italy 2026-08-16 ')
    expect(hit).toEqual({ videoId: '7-HvbsxBq-4', setUrl: 'https://www.1001tracklists.com/tracklist/r1/x.html', setTitle: 'Mau P @ Panorama Festival, Italy 2026-08-16', slug: 'maup' })
    expect(await findMkvidUploadByTitle(env, 'Mau P @ Panorama Festival, Italy 2026-08-17')).toBeNull()
    expect(await findMkvidUploadByTitle(env, '   ')).toBeNull()
  })

  it('matches the 100-character title YouTube actually shows for a long set title', async () => {
    const env = makeEnv()
    const long = 'Odd Mob @ High Tide, Day Trip Festival, Queen Mary Waterfront, Long Beach, California, United States 2026-06-27'
    expect(long.length).toBeGreaterThan(100)
    await done(env, 'r1', long, '_ZS9h7ePQ_0')
    expect((await findMkvidUploadByTitle(env, long.slice(0, 100)))?.videoId).toBe('_ZS9h7ePQ_0')
    expect(await findMkvidUploadByTitle(env, long)).toBeNull()
  })

  it('ignores rows without a video (pending / failed / superseded at claim) but keeps a superseded finished upload', async () => {
    const env = makeEnv()
    await done(env, 'p', 'Pending set', null, 'pending')
    await done(env, 'f', 'Failed set', null, 'failed')
    await done(env, 'sc', 'Superseded at claim', null, 'superseded')
    await done(env, 'sd', 'Superseded after upload', 'wKOj6yQ6TAQ', 'superseded')
    expect(await findMkvidUploadByTitle(env, 'Pending set')).toBeNull()
    expect(await findMkvidUploadByTitle(env, 'Failed set')).toBeNull()
    expect(await findMkvidUploadByTitle(env, 'Superseded at claim')).toBeNull()
    expect((await findMkvidUploadByTitle(env, 'Superseded after upload'))?.videoId).toBe('wKOj6yQ6TAQ')
  })

  it('prefers the most recent upload when two sets share a title', async () => {
    const env = makeEnv()
    await done(env, 'old', 'Same title', 'oldVid00001', 'done', NOW - 100)
    await done(env, 'new', 'Same title', 'newVid00001', 'done', NOW)
    expect((await findMkvidUploadByTitle(env, 'Same title'))?.videoId).toBe('newVid00001')
  })
})

describe('panel list: filters and paging', () => {
  /** Five sets, newest first: two DJs with one SoundCloud and one hearthis set each, plus one more. */
  const SETS = [
    ['a', '2026-09-05', 'lillypalmer', 'Lilly Palmer', 'Lilly Palmer @ Awakenings', 'soundcloud'],
    ['b', '2026-09-04', 'lillypalmer', 'Lilly Palmer', 'Lilly Palmer @ Tomorrowland', 'hearthis'],
    ['c', '2026-09-03', 'johnsummit', 'Tracklists By John Summit', 'John Summit @ 100% pure', 'soundcloud'],
    ['d', '2026-09-02', 'johnsummit', 'Tracklists By John Summit', 'John Summit @ Ushuaia', 'hearthis'],
    ['e', '2026-09-01', 'kx5', 'kx5', 'kx5 @ The Gorge', 'soundcloud'],
  ] as const

  async function seed(env: Env) {
    for (const [n, setDate, slug, artistName, setTitle, kind] of SETS) {
      await enqueueMkvidRequest(env, { ...input, setUrl: `https://x/tracklist/${n}`, setDate, slug, artistName, setTitle, source: { kind, url: `https://audio/${n}` } })
    }
  }
  const names = (rows: ReadonlyArray<{ setUrl: string }>) => rows.map((r) => r.setUrl.split('/').pop())

  it('pages the waiting line in claim order, each row knowing its place in the whole queue', async () => {
    const env = makeEnv()
    await seed(env)
    const p1 = await listMkvidQueuePage(env, { limit: 2 })
    expect(names(p1.records)).toEqual(['a', 'b'])
    expect(p1.records.map((r) => r.position)).toEqual([1, 2])
    expect(p1.total).toBe(5)
    const p2 = await listMkvidQueuePage(env, { limit: 2, cursor: p1.cursor })
    expect(names(p2.records)).toEqual(['c', 'd'])
    expect(p2.records.map((r) => r.position)).toEqual([3, 4])
    const p3 = await listMkvidQueuePage(env, { limit: 2, cursor: p2.cursor })
    expect(names(p3.records)).toEqual(['e'])
    expect(p3.cursor).toBeNull()
    // A cursor that is not one of ours is the first page, never an error.
    expect(names((await listMkvidQueuePage(env, { limit: 2, cursor: 'nonsense' })).records)).toEqual(['a', 'b'])
  })

  it('keyset, not offset: a claim between two pages cannot make the next row skip one', async () => {
    const env = makeEnv()
    await seed(env)
    const p1 = await listMkvidQueuePage(env, { limit: 2 })
    expect(names(p1.records)).toEqual(['a', 'b'])
    await claimMkvidRequest(env, log)   // 'a' leaves the waiting line…
    const p2 = await listMkvidQueuePage(env, { limit: 2, cursor: p1.cursor })
    expect(names(p2.records)).toEqual(['c', 'd'])   // …and 'c' is still next, not skipped
    expect((await listMkvidQueuePage(env, { limit: 2 })).total).toBe(4)
  })

  it('filters by status, source, DJ and a substring of the title, DJ or URL', async () => {
    const env = makeEnv()
    await seed(env)
    expect(names((await listMkvidQueuePage(env, { source: 'hearthis' })).records)).toEqual(['b', 'd'])
    expect(names((await listMkvidQueuePage(env, { slug: 'johnsummit' })).records)).toEqual(['c', 'd'])
    expect(names((await listMkvidQueuePage(env, { q: 'summit' })).records)).toEqual(['c', 'd'])        // the stored DJ name
    expect(names((await listMkvidQueuePage(env, { q: 'TOMORROWLAND' })).records)).toEqual(['b'])       // the title, case-insensitively
    expect(names((await listMkvidQueuePage(env, { q: 'tracklist/e' })).records)).toEqual(['e'])        // the set URL
    // A LIKE wildcard typed into the search box is a literal: '100%' is one set, not all five.
    expect(names((await listMkvidQueuePage(env, { q: '100%' })).records)).toEqual(['c'])
    expect(names((await listMkvidQueuePage(env, { q: '_' })).records)).toEqual([])
    // Filters narrow the total too, and the cursor carries them.
    const page = await listMkvidQueuePage(env, { limit: 1, source: 'soundcloud' })
    expect(page.total).toBe(3)
    expect(names((await listMkvidQueuePage(env, { limit: 1, source: 'soundcloud', cursor: page.cursor })).records)).toEqual(['c'])
    // Statuses that belong to the other list are simply not in this one.
    expect(await listMkvidQueuePage(env, { statuses: ['failed'] })).toEqual({ records: [], cursor: null, total: 0 })
  })

  it('pages what has left the waiting line, rendering first, newest activity next', async () => {
    const env = makeEnv({ MKVID_DAILY_CLAIM_CAP: '10' })
    await seed(env)
    expect(await banMkvidRequest(env, (await getMkvidRequestForSet(env, 'https://x/tracklist/b'))!.id)).toBe(true)
    const failed = (await claimMkvidRequest(env, log))!            // 'a'
    await failMkvidRequest(env, { id: failed.id, error: 'incomplete_recording', permanent: true }, log)
    await claimMkvidRequest(env, log)                              // 'c' is rendering now

    const p1 = await listMkvidSettledPage(env, { limit: 2 })
    expect(p1.records.map((r) => [r.setUrl.split('/').pop(), r.status])).toEqual([['c', 'claimed'], ['a', 'failed']])
    expect(p1.total).toBe(3)
    const p2 = await listMkvidSettledPage(env, { limit: 2, cursor: p1.cursor })
    expect(names(p2.records)).toEqual(['b'])
    expect(p2.cursor).toBeNull()
    const banned = await listMkvidSettledPage(env, { statuses: ['banned'] })
    expect(names(banned.records)).toEqual(['b'])
    expect(banned.total).toBe(1)
    expect(names((await listMkvidSettledPage(env, { slug: 'johnsummit' })).records)).toEqual(['c'])
    // The waiting line is the other list's business.
    expect(await listMkvidSettledPage(env, { statuses: ['pending'] })).toEqual({ records: [], cursor: null, total: 0 })
  })

  it('lists the DJs the queue has held, most requests first, without the stored "Tracklists By" prefix', async () => {
    const env = makeEnv()
    await seed(env)
    expect(await listMkvidDjs(env)).toEqual([
      { slug: 'johnsummit', label: 'John Summit', count: 2 },
      { slug: 'lillypalmer', label: 'Lilly Palmer', count: 2 },
      { slug: 'kx5', label: 'kx5', count: 1 },
    ])
  })
})

// The claim hands mkvid the track list so it can draw per-track titles and
// artwork. 1001tracklists serves decoy pages (real cues and art, randomized
// names) to our accounts since ~2026-09-22, so names are only passed on from a
// page the detector had enough evidence to clear.
describe('track list for mkvid', () => {
  const tl = (name: string) => parseTracklist(`https://www.1001tracklists.com/tracklist/x/${name}`, fixture(name))

  it('trusts a page only when the list is verified, enough rows were checked and none contradicts itself', () => {
    expect(mkvidTracksTrusted({ named: 25, mismatched: 0, suspected: false }, true)).toBe(true)
    expect(mkvidTracksTrusted({ named: 3, mismatched: 0, suspected: false }, true)).toBe(true)
    // Too few rows to judge, or any contradiction at all, or a suspected decoy: not trusted.
    expect(mkvidTracksTrusted({ named: 2, mismatched: 0, suspected: false }, true)).toBe(false)
    expect(mkvidTracksTrusted({ named: 0, mismatched: 0, suspected: false }, true)).toBe(false)
    expect(mkvidTracksTrusted({ named: 25, mismatched: 1, suspected: false }, true)).toBe(false)
    expect(mkvidTracksTrusted({ named: 25, mismatched: 24, suspected: true }, true)).toBe(false)
    expect(mkvidTracksTrusted(tl('tracklist-matroda.html').decoy, true)).toBe(true)
    expect(mkvidTracksTrusted(tl('tracklist-decoy-dcr839.html').decoy, true)).toBe(false)
    // Unverified (decision 2): never trusted, however clean the page looks.
    expect(mkvidTracksTrusted({ named: 25, mismatched: 0, suspected: false }, false)).toBe(false)
    expect(mkvidTracksTrusted(tl('tracklist-matroda.html').decoy, false)).toBe(false)
  })

  it('a trusted page keeps names, cues, artwork and the ID flag', () => {
    const parsed = tl('tracklist-matroda.html')
    const out = toMkvidTracks(parsed.tracks, true)
    expect(out).toHaveLength(parsed.tracks.length)
    expect(Object.keys(out[0]!).sort()).toEqual(['artist', 'artworkUrl', 'cueSeconds', 'isId', 'layered', 'title'])
    const named = out.filter((t) => !t.isId)
    expect(named.length).toBeGreaterThan(0)
    for (const t of named) expect(t.title).toBeTruthy()
    expect(out.some((t) => t.cueSeconds !== null)).toBe(true)
    expect(out.some((t) => t.artworkUrl?.startsWith('https://'))).toBe(true)
    expect(out.map((t) => t.cueSeconds)).toEqual(parsed.tracks.map((t) => (t.isMashupLinked ? t.ownStartSeconds : t.startSeconds)))
  })

  it('an anonymous "ID" row has no title, and an untrusted page has no names at all', () => {
    expect(toMkvidTracks([{ startTime: '', startSeconds: 60, artist: 'ID', title: 'ID', trackId: null, trackUrl: null, artworkUrl: null, isUnidentified: true, idStatus: null, isMashupLinked: false, ownStartSeconds: 60 }], true))
      .toEqual([{ cueSeconds: 60, artist: null, title: null, artworkUrl: null, isId: true, layered: false }])
    expect(toMkvidTracks([{ startTime: '', startSeconds: null, artist: 'Cave Studio', title: 'ID', trackId: null, trackUrl: null, artworkUrl: null, isUnidentified: true, idStatus: null, isMashupLinked: false, ownStartSeconds: null }], true))
      .toEqual([{ cueSeconds: null, artist: 'Cave Studio', title: null, artworkUrl: null, isId: true, layered: false }])
    const decoy = tl('tracklist-decoy-dcr839.html')
    const out = toMkvidTracks(decoy.tracks, false)
    expect(out).toHaveLength(decoy.tracks.length)
    for (const t of out) expect([t.artist, t.title]).toEqual([null, null])
    // Cues and artwork stay: those are real on a decoy page.
    expect(out.map((t) => t.cueSeconds)).toEqual(decoy.tracks.map((t) => (t.isMashupLinked ? t.ownStartSeconds : t.startSeconds)))
    expect(out.map((t) => t.layered)).toEqual(decoy.tracks.map((t) => t.isMashupLinked))
    expect(out.map((t) => t.artworkUrl)).toEqual(decoy.tracks.map((t) => t.artworkUrl))
  })

  it("marks 'w/' rows layered, in page order, with only their own cue", () => {
    const max = tl('tracklist-maxstyler.html')
    const out = toMkvidTracks(max.tracks, true)
    const i = out.findIndex((t) => t.title === "Let Em' Know")
    // On top of Mokba, which carries the cue; no time of its own on the page.
    expect(out[i - 1]).toMatchObject({ title: 'Mokba', cueSeconds: 2325, layered: false })
    expect(out[i]).toMatchObject({ artist: 'Max Styler', cueSeconds: null, layered: true })
    expect(out.filter((t) => t.layered)).toHaveLength(1)
    expect(out.map((t) => t.title)).toEqual(max.tracks.map((t) => (t.title === 'ID' ? null : t.title)))
    // Matroda's w/ row prints its own time (1:17:30), a minute after its base (1:16:30).
    const mat = toMkvidTracks(tl('tracklist-matroda.html').tracks, true)
    const j = mat.findIndex((t) => t.title === 'Calypso')
    expect(mat[j - 1]).toMatchObject({ cueSeconds: 4590, layered: false })
    expect(mat[j]).toMatchObject({ cueSeconds: 4650, layered: true })
    // A page without w/ rows has none.
    expect(toMkvidTracks(tl('tracklist-habstrakt.html').tracks, true).some((t) => t.layered)).toBe(false)
  })

  it('never sends the first row layered', () => {
    const row = { startTime: '', startSeconds: 5, artist: 'A', title: 'B', trackId: null, trackUrl: null, artworkUrl: null, isUnidentified: false, idStatus: null, isMashupLinked: true, ownStartSeconds: null }
    expect(toMkvidTracks([row, row], true).map((t) => [t.layered, t.cueSeconds])).toEqual([[false, 5], [true, null]])
  })

  it('an untrusted list keeps the layering (it comes from row classes, not names)', () => {
    const decoy = tl('tracklist-decoy-dcr839.html')
    expect(toMkvidTracks(decoy.tracks, false).filter((t) => t.layered)).toHaveLength(3)
  })

  it("sends anonymous 'ID - ID' rows in page order, and layers a w/ row on its true base", () => {
    const d = tl('tracklist-decoy-dcr839.html')
    const out = toMkvidTracks(d.rows, false)
    expect(out).toHaveLength(41)
    expect(out[4]).toEqual({ cueSeconds: 866, artist: null, title: null, artworkUrl: null, isId: true, layered: false })
    expect(out[14]).toEqual({ cueSeconds: null, artist: null, title: null, artworkUrl: null, isId: true, layered: true })
    const orphan = d.rows.findIndex((r) => r.trackId === '32060')
    expect(out[orphan - 1]).toMatchObject({ cueSeconds: 5883, isId: true, layered: false })
    expect(out[orphan]).toMatchObject({ cueSeconds: null, isId: false, layered: true })
    expect(out.filter((t) => t.layered)).toHaveLength(6)
    // Cues and artwork of the other rows survive the untrusted list.
    expect(out.filter((t) => t.cueSeconds !== null).length).toBeGreaterThan(30)
    expect(out.some((t) => t.artworkUrl?.startsWith('https://'))).toBe(true)
    // Even on a trusted list an anonymous row has no name and no art.
    const anon = { ...d.rows[4]!, artist: 'X', artworkUrl: 'https://a/b.jpg' }
    expect(toMkvidTracks([anon], true)).toEqual([{ cueSeconds: 866, artist: null, title: null, artworkUrl: null, isId: true, layered: false }])
  })

  it('caps a huge list', () => {
    const row = { startTime: '', startSeconds: 1, artist: 'A', title: 'B', trackId: null, trackUrl: null, artworkUrl: null, isUnidentified: false, idStatus: null, isMashupLinked: false, ownStartSeconds: 1 }
    expect(toMkvidTracks(Array.from({ length: MKVID_MAX_TRACKS + 50 }, () => row), true)).toHaveLength(MKVID_MAX_TRACKS)
  })

  it('stores the list per request, never lets an untrusted list replace a trusted one, and the claim carries it', async () => {
    const env = makeEnv({ MKVID_DAILY_CLAIM_CAP: '10' })
    const real = tl('tracklist-matroda.html')
    const decoy = tl('tracklist-decoy-dcr839.html')
    expect(await saveMkvidTracks(env, input.setUrl, real)).toBe('no_request')
    await enqueueMkvidRequest(env, input)
    const id = (await getMkvidRequestForSet(env, input.setUrl))!.id
    expect(await getMkvidTracks(env, id)).toEqual({ tracks: [], tracksTrusted: false })

    // Untrusted first (a decoy page), then a real page upgrades it...
    expect(await saveMkvidTracks(env, input.setUrl, decoy)).toBe('saved')
    expect(await getMkvidTracks(env, id)).toEqual({ tracks: toMkvidTracks(decoy.rows, false), tracksTrusted: false })
    expect((await getMkvidTracks(env, id)).tracks).toHaveLength(41) // anonymous rows included
    // A clean page of a list that is not VERIFIED yet stays untrusted (quest decision 2)...
    expect(await saveMkvidTracks(env, input.setUrl, real)).toBe('saved')
    expect((await getMkvidTracks(env, id)).tracksTrusted).toBe(false)
    // ...until a second account confirms the same rows at least 2 h later.
    await noteSetFetch(env, { setUrl: input.setUrl, parsed: real, accountId: 'acct-1', fetchedAt: NOW - 3 * 3600, settings: DEFAULT_POOL_SETTINGS, pool: null })
    expect((await noteSetFetch(env, { setUrl: input.setUrl, parsed: real, accountId: 'acct-2', fetchedAt: NOW, settings: DEFAULT_POOL_SETTINGS, pool: null })).outcome).toBe('verified')
    expect(await saveMkvidTracks(env, input.setUrl, real)).toBe('saved')
    const stored = await getMkvidTracks(env, id)
    expect(stored).toEqual({ tracks: toMkvidTracks(real.rows, true), tracksTrusted: true })
    // ...and a later decoy fetch does not downgrade it.
    expect(await saveMkvidTracks(env, input.setUrl, decoy)).toBe('kept')
    expect(await getMkvidTracks(env, id)).toEqual(stored)
    // A zero-row parse (captcha shell) stores nothing.
    expect(await saveMkvidTracks(env, input.setUrl, { rows: [], decoy: { named: 0, mismatched: 0, suspected: false } })).toBe('empty')

    const claimed = (await claimMkvidRequest(env, log))!
    expect(claimed).toMatchObject({ id, tracksTrusted: true })
    expect(claimed.tracks).toEqual(stored.tracks)
    expect(MkvidClaimResponse.safeParse({ request: claimed }).success).toBe(true)
    // The panel's rows stay lean: no track list in them.
    expect((await listSettledMkvidRequests(env))[0]).not.toHaveProperty('tracks')
  })

  it('a request with no stored list is claimed with an empty, untrusted one', async () => {
    const env = makeEnv()
    await enqueueMkvidRequest(env, input)
    const claimed = (await claimMkvidRequest(env, log))!
    expect(claimed).toMatchObject({ tracks: [], tracksTrusted: false })
    expect(MkvidClaimResponse.safeParse({ request: claimed }).success).toBe(true)
    expect(MkvidClaimResponse.safeParse({ request: null }).success).toBe(true)
  })
})
