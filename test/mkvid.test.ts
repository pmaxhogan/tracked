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
  banMkvidRequest,
  moveMkvidRequest,
  mkvidAccountUsage,
  MKVID_MAX_ATTEMPTS,
  retryMkvidRequest,
  supersedeMkvidRequestForSet,
  findMkvidUploadByTitle,
} from '../src/lib/mkvid'
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

  it('hands out at most MKVID_DAILY_CLAIM_CAP requests per quota day on the primary account (default 6)', async () => {
    const env = makeEnv()
    for (const n of [1, 2, 3, 4, 5, 6, 7]) await enqueueMkvidRequest(env, { ...input, setUrl: `https://x/tracklist/${n}` })
    for (let i = 1; i <= 6; i++) expect((await claimMkvidRequest(env, log))!.setUrl).toBe(`https://x/tracklist/${i}`)
    expect(await claimMkvidRequest(env, log)).toBeNull()
    expect(await countMkvidRequests(env)).toMatchObject({ pending: 1, claimed: 6 })
    expect(await dailyClaimsUsed(env)).toBe(6)
    expect(await dailyClaimsUsed(env, 'shared')).toBe(0)

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
    expect(dailyClaimCap(makeEnv())).toBe(6)
    for (const blank of ['', ' ', '\r\n']) expect(dailyClaimCap(makeEnv({ MKVID_DAILY_CLAIM_CAP: blank }))).toBe(6)
    expect(dailyClaimCap(makeEnv({ MKVID_DAILY_CLAIM_CAP: 'two' }))).toBe(6)
    expect(dailyClaimCap(makeEnv({ MKVID_DAILY_CLAIM_CAP: '-1' }))).toBe(6)
    expect(dailyClaimCap(makeEnv({ MKVID_DAILY_CLAIM_CAP: '0' }))).toBe(0)
    expect(dailyClaimCap(makeEnv({ MKVID_DAILY_CLAIM_CAP: ' 5\n' }))).toBe(5)
    // The shared (sync's) project is opt-in.
    expect(dailyClaimCap(makeEnv(), 'shared')).toBe(0)
    expect(dailyClaimCap(makeEnv({ MKVID_SHARED_DAILY_CLAIM_CAP: '3' }), 'shared')).toBe(3)
    expect(dailyClaimCap(makeEnv({ MKVID_SHARED_DAILY_CLAIM_CAP: '3' }))).toBe(6)
  })

  it('quotaDayEnd is the next Pacific midnight, across a DST change too', () => {
    expect(quotaDayEnd(Date.parse('2026-09-17T23:30:00Z'))).toBe(Date.parse('2026-09-18T07:00:00Z') / 1000)
    // 2026-11-01 is a 25-hour day in Los Angeles.
    expect(quotaDayEnd(Date.parse('2026-11-01T12:00:00Z'))).toBe(Date.parse('2026-11-02T08:00:00Z') / 1000)
    // 2026-03-08 is a 23-hour one.
    expect(quotaDayEnd(Date.parse('2026-03-08T12:00:00Z'))).toBe(Date.parse('2026-03-09T07:00:00Z') / 1000)
  })

  it('remembers what the last poll got, so the panel can tell a capped queue from a silent mkvid', async () => {
    const env = makeEnv({ MKVID_DAILY_CLAIM_CAP: '1' })
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
