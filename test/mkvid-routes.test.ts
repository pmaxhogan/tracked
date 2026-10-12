import { describe, it, expect, vi, beforeEach } from 'vitest'
import { app } from '../src/index'
import type { Env } from '../src/types'
import type { StoredTokens } from '../src/lib/google-oauth'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'
import { banMkvidRequest, enqueueMkvidRequest as enqueueRaw, getMkvidRequest, getMkvidRequestForSet, retryMkvidRequest, saveMkvidTracks } from '../src/lib/mkvid'
import { MkvidClaimResponse } from '../src/schemas'
import { parseTracklist } from '../src/lib/tracklists1001'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { saveSubState } from '../src/lib/sync-store'
import { noteSetFetch } from '../src/lib/verification'
import { DEFAULT_POOL_SETTINGS } from '../src/lib/pool-settings'
import { updateAppSettings } from '../src/lib/app-settings'
import { storeVerifiedList } from './helpers/mkvid-lists'

/** Queue a set with a verified list (no ID rows), so the claim gate lets it through. */
async function enqueueMkvidRequest(env: Env, i: Parameters<typeof enqueueRaw>[1]) {
  const r = await enqueueRaw(env, i)
  if (r === 'queued') await storeVerifiedList(env, i.setUrl)
  return r
}

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
import { addVideoToPlaylist, findPlaylistByTitle, listPlaylistVideoIds } from '../src/lib/youtube-playlists'

const tokens: StoredTokens = {
  accessToken: 'ya29',
  refreshToken: 'r',
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  scope: 'https://www.googleapis.com/auth/youtube',
  channelId: null,
  channelTitle: null,
  connectedAt: 0,
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    CACHE: fakeKV(),
    DB: fakeD1(),
    SUBS: fakeKV({ 'oauth:google': JSON.stringify(tokens) }),
    API_TOKEN: 'tasker',
    YOUTUBE_API_KEY: 'k',
    MKVID_TOKEN: 'mk-secret',
    ...overrides,
  } as Env
}

const post = (env: Env, path: string, body: unknown, token = 'mk-secret') =>
  app.request(`http://x${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env)

const input = {
  slug: 'lillypalmer',
  setUrl: 'https://www.1001tracklists.com/tracklist/abc/x.html',
  artistName: 'Lilly Palmer',
  setTitle: 'Lilly Palmer @ X',
  setDate: '2026-09-01',
  source: { kind: 'soundcloud' as const, url: 'https://api.soundcloud.com/tracks/1' },
  lastCueSeconds: 100,
  trackCount: 3,
  idedCount: 3,
}

beforeEach(() => {
  vi.resetAllMocks()
  ;(listPlaylistVideoIds as ReturnType<typeof vi.fn>).mockImplementation(async () => new Set<string>())
  ;(findPlaylistByTitle as ReturnType<typeof vi.fn>).mockImplementation(async (title: string) => ({ id: title.startsWith('All') ? 'PLc' : 'PLa', title }))
})

describe('/mkvid routes', () => {
  it('is gated by MKVID_TOKEN, not the Tasker token', async () => {
    const env = makeEnv()
    expect((await post(env, '/mkvid/claim', {}, 'tasker')).status).toBe(401)
    expect((await app.request('http://x/mkvid/health', {}, env)).status).toBe(401)
    expect((await post(env, '/mkvid/claim', {}, 'mk-secret')).status).toBe(200)
    // …and the Tasker routes do not accept the mkvid token.
    const r = await app.request('http://x/openapi.json', { headers: { Authorization: 'Bearer mk-secret' } }, env)
    expect(r.status).toBe(401)
    // Unconfigured token = 500 (never open).
    expect((await post(makeEnv({ MKVID_TOKEN: undefined }), '/mkvid/claim', {}, 'mk-secret')).status).toBe(500)
  })

  it('complete for a request banned mid-render answers banned and asks mkvid to delete the upload', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(String(url)); return new Response(JSON.stringify({ ok: true, outcome: 'deleted' }), { headers: { 'content-type': 'application/json' } }) }))
    try {
      const env = makeEnv({ MKVID_URL: 'https://mkvid.example' })
      await enqueueMkvidRequest(env, input)
      const { request } = (await (await post(env, '/mkvid/claim', {})).json()) as { request: { id: string } }
      expect(await retryMkvidRequest(env, request.id)).toBe(true)
      expect(await banMkvidRequest(env, request.id)).toBe(true)
      const res = await post(env, '/mkvid/complete', { id: request.id, videoId: 'banned12345', videoUrl: 'https://youtu.be/banned12345', privacy: 'unlisted' })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ status: 'banned', videoId: 'banned12345' })
      expect(addVideoToPlaylist).not.toHaveBeenCalled()
      expect(calls.some((u) => u === 'https://mkvid.example/api/videos/banned12345/delete')).toBe(true)
      expect(await env.DB.prepare('SELECT state FROM mkvid_old_videos WHERE video_id = ?').bind('banned12345').first()).toEqual({ state: 'deleted' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('claim → complete adds the video and answers with the playlist outcome', async () => {
    const env = makeEnv()
    await saveSubState(env, 'lillypalmer', { playlistId: 'PLa', artistName: 'Lilly Palmer', processedTracklistUrls: [input.setUrl], tracklistVideos: { [input.setUrl]: { videoId: null, checkedAt: 1 } } })
    await enqueueMkvidRequest(env, input)

    const claim = await post(env, '/mkvid/claim', {})
    const { request } = (await claim.json()) as { request: { id: string; setUrl: string; sourceUrl: string; lastCueSeconds: number } }
    expect(request).toMatchObject({ setUrl: input.setUrl, sourceUrl: 'https://api.soundcloud.com/tracks/1', lastCueSeconds: 100 })

    expect((await post(env, '/mkvid/job', { id: request.id, jobId: 'job-1' })).status).toBe(200)
    expect((await getMkvidRequest(env, request.id))!.jobId).toBe('job-1')

    const done = await post(env, '/mkvid/complete', { id: request.id, videoId: 'upload12345', videoUrl: 'https://youtu.be/upload12345', privacy: 'unlisted' })
    expect(done.status).toBe(200)
    expect(await done.json()).toEqual({ status: 'done', videoId: 'upload12345', playlistId: 'PLa', playlistStatus: 'added', combinedStatus: 'added' })
    expect(addVideoToPlaylist).toHaveBeenCalledTimes(2)

    expect((await post(env, '/mkvid/claim', {})).status).toBe(200)
    expect(((await (await post(env, '/mkvid/claim', {})).json()) as { request: unknown }).request).toBeNull()
    const health = await app.request('http://x/mkvid/health', { headers: { Authorization: 'Bearer mk-secret' } }, env)
    expect(await health.json()).toEqual({
      ok: true,
      verifiedLists: true,
      trackUploads: true,
      recreateStyle: 'scene',
      counts: { pending: 0, claimed: 0, done: 1, failed: 0, superseded: 0, banned: 0 },
      accounts: [{ account: 'primary', label: 'mkvid-uploads', used: 1, cap: 24 }, { account: 'shared', label: 'tracked-youtube', used: 0, cap: 6 }],
      dailyClaims: 1,
      dailyClaimCap: 30,
    })
  })

  it('/mkvid/job renews the claim of a request still claimed for that job, without moving it in the lists', async () => {
    const env = makeEnv()
    await enqueueMkvidRequest(env, input)
    const { request } = (await (await post(env, '/mkvid/claim', {})).json()) as { request: { id: string } }
    expect((await post(env, '/mkvid/job', { id: request.id, jobId: 'job-1' })).status).toBe(200)
    // Two hours later, still waiting for mkvid's render slot.
    await env.DB.prepare('UPDATE mkvid_requests SET claimed_at = claimed_at - 7200, updated_at = updated_at - 7200 WHERE id = ?').bind(request.id).run()
    const aged = (await getMkvidRequest(env, request.id))!
    expect((await post(env, '/mkvid/job', { id: request.id, jobId: 'job-1' })).status).toBe(200)
    const renewed = (await getMkvidRequest(env, request.id))!
    expect(renewed.claimedAt).toBeGreaterThanOrEqual(aged.claimedAt! + 7200)
    expect(renewed.updatedAt).toBe(aged.updatedAt)
    expect(renewed.jobId).toBe('job-1')
    // Another job's renewal, or one after the request left `claimed`, changes nothing.
    await post(env, '/mkvid/job', { id: request.id, jobId: 'job-2' })
    expect((await getMkvidRequest(env, request.id))!.jobId).toBe('job-1')
    expect(await retryMkvidRequest(env, request.id)).toBe(true)
    await post(env, '/mkvid/job', { id: request.id, jobId: 'job-1' })
    expect((await getMkvidRequest(env, request.id))!).toMatchObject({ status: 'pending', claimedAt: null })
  })

  it('the claim carries the track list and whether its names can be trusted', async () => {
    const env = makeEnv()
    const html = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tracklist-matroda.html'), 'utf8')
    await enqueueMkvidRequest(env, input)
    // Names are only trusted from a VERIFIED list (quest decision 2): two accounts, >= 2 h apart, same rows.
    const parsedPage = parseTracklist(input.setUrl, html)
    const now = Math.floor(Date.now() / 1000)
    await noteSetFetch(env, { setUrl: input.setUrl, parsed: parsedPage, accountId: 'acct-1', fetchedAt: now - 3 * 3600, settings: DEFAULT_POOL_SETTINGS, pool: null })
    await noteSetFetch(env, { setUrl: input.setUrl, parsed: parsedPage, accountId: 'acct-2', fetchedAt: now, settings: DEFAULT_POOL_SETTINGS, pool: null })
    await saveMkvidTracks(env, input.setUrl, parsedPage)
    const body = await (await post(env, '/mkvid/claim', {})).json()
    const parsed = MkvidClaimResponse.parse(body)
    expect(parsed.request!.tracksTrusted).toBe(true)
    expect(parsed.request!.tracks.length).toBeGreaterThan(5)
    expect(parsed.request!.tracks[0]).toMatchObject({ cueSeconds: 0, artist: expect.any(String), title: expect.any(String), isId: false, layered: false })
    // Matroda's 'w/' row (Calypso over Odd Mob) comes through layered with its own printed cue.
    expect(parsed.request!.tracks.filter((t) => t.layered)).toEqual([expect.objectContaining({ title: 'Calypso', cueSeconds: 4650 })])
    expect(parsed.request!.tracks.some((t) => t.artworkUrl)).toBe(true)
    // Documented in the OpenAPI spec (which itself sits behind the Tasker token).
    const spec = (await (await app.request('http://x/openapi.json', { headers: { Authorization: 'Bearer tasker' } }, env)).json()) as { paths: Record<string, unknown>; components: { schemas: Record<string, unknown> } }
    expect(spec.paths['/mkvid/claim']).toBeDefined()
    expect(spec.components.schemas).toHaveProperty('MkvidTrack')
    expect(spec.components.schemas).toHaveProperty('MkvidClaimResponse')
  })

  it('validates bodies and reports unknown / finished requests', async () => {
    const env = makeEnv()
    expect((await post(env, '/mkvid/complete', { id: 'not-a-uuid', videoId: 'upload12345' })).status).toBe(400)
    expect((await post(env, '/mkvid/complete', { id: crypto.randomUUID(), videoId: 'bad id' })).status).toBe(400)
    expect((await post(env, '/mkvid/complete', { id: crypto.randomUUID(), videoId: 'upload12345' })).status).toBe(404)
    expect((await post(env, '/mkvid/fail', { id: crypto.randomUUID(), error: 'x' })).status).toBe(404)
    expect((await post(env, '/mkvid/fail', { id: crypto.randomUUID() })).status).toBe(400)
  })

  it('the panel API explains the queue: cap, usage, reset time, last poll; the waiting line is its own table', async () => {
    const env = makeEnv({ DEV_BYPASS_CF_ACCESS: '1', MKVID_DAILY_CLAIM_CAP: '0', MKVID_SHARED_DAILY_CLAIM_CAP: '0' })
    await enqueueMkvidRequest(env, input)
    expect(((await (await post(env, '/mkvid/claim', {})).json()) as { request: unknown }).request).toBeNull()
    // Home and Settings still send ?limit=1: ignored.
    const r = await app.request('http://x/ui/api/mkvid?limit=1', {}, env)
    expect(r.status).toBe(200)
    const d = (await r.json()) as { dailyClaimCap: number; dailyClaims: number; quotaResetsAt: number; now: number; lastPoll: { outcome: string } | null; rendering: unknown[] }
    expect(d).toMatchObject({ enabled: true, dailyClaimCap: 0, dailyClaims: 0, lastPoll: { outcome: 'capped', accounts: ['primary'] }, rendering: [], oldVideos: [], counts: { pending: 1 }, accounts: [{ account: 'primary', cap: 0 }, { account: 'shared', cap: 0 }] })
    expect(d).not.toHaveProperty('queue')
    expect(d.quotaResetsAt).toBeGreaterThan(d.now)
    expect(d.quotaResetsAt - d.now).toBeLessThanOrEqual(25 * 3600)
    const q = (await (await app.request('http://x/ui/api/mkvid/queue', {}, env)).json()) as { rows: Array<{ setUrl: string; position: number; readiness: unknown }>; total: number }
    expect(q.rows.map((x) => [x.setUrl, x.position])).toEqual([[input.setUrl, 1]])
    expect(q.rows[0]!.readiness).toMatchObject({ state: expect.any(String) })
  })

  it('the queue and finished tables sort, filter, search and page on the server; positions are whole-queue', async () => {
    const env = makeEnv({ DEV_BYPASS_CF_ACCESS: '1', MKVID_DAILY_CLAIM_CAP: '10' })
    const sets = [
      ['a', '2026-09-05', 'lillypalmer', 'Lilly Palmer', 'soundcloud'],
      ['b', '2026-09-04', 'lillypalmer', 'Lilly Palmer', 'hearthis'],
      ['c', '2026-09-03', 'johnsummit', 'John Summit', 'soundcloud'],
    ] as const
    for (const [n, setDate, slug, artistName, kind] of sets) {
      await enqueueMkvidRequest(env, { ...input, setUrl: `https://x/tracklist/${n}`, setDate, slug, artistName, setTitle: `${artistName} @ set ${n}`, source: { kind, url: `https://audio/${n}` } })
    }
    type Table = { rows: Array<{ setUrl: string; position?: number; status: string; outcome: string | null; artistLabel: string }>; total: number; page: number; pageCount: number; counts: Record<string, number> }
    const table = async (which: string, qs = '') => {
      const r = await app.request(`http://x/ui/api/mkvid/${which}${qs}`, {}, env)
      expect(r.status, qs).toBe(200)
      return (await r.json()) as Table
    }
    const names = (t: Table) => t.rows.map((r) => r.setUrl.split('/').pop())

    const q1 = await table('queue')
    expect(names(q1)).toEqual(['a', 'b', 'c'])
    expect(q1.rows.map((q) => q.position)).toEqual([1, 2, 3])
    expect(q1.rows[0]!.artistLabel).toBe('Lilly Palmer')
    const header = (await (await app.request('http://x/ui/api/mkvid', {}, env)).json()) as { djs: unknown }
    expect(header.djs).toEqual([
      { slug: 'lillypalmer', label: 'Lilly Palmer', count: 2 },
      { slug: 'johnsummit', label: 'John Summit', count: 1 },
    ])

    // Other sorts; the position stays the place in the whole queue.
    const bySet = await table('queue', '?sort=setDate')
    expect(names(bySet)).toEqual(['c', 'b', 'a'])
    expect(bySet.rows.map((q) => q.position)).toEqual([3, 2, 1])
    expect(names(await table('queue', '?sort=-dj,setDate'))).toEqual(['b', 'a', 'c'])
    // Filters: DJ, source and free text keep whole-queue positions.
    const jo = await table('queue', '?f.dj=eq:johnsummit')
    expect([names(jo), jo.rows[0]!.position]).toEqual([['c'], 3])
    expect(names(await table('queue', '?f.source=in:hearthis'))).toEqual(['b'])
    expect(names(await table('queue', '?q=set%20a'))).toEqual(['a'])
    expect(names(await table('queue', '?q=summit'))).toEqual(['c'])
    expect(names(await table('queue', '?f.setDate=after:2026-09-03'))).toEqual(['a', 'b'])
    expect((await table('finished')).total).toBe(0)

    // A finished list: 'a' fails, 'b' is banned, 'c' is rendering (not finished: it is in the header).
    const first = (await (await post(env, '/mkvid/claim', {})).json()) as { request: { id: string } }
    await post(env, '/mkvid/fail', { id: first.request.id, error: 'incomplete_recording', permanent: true })
    const ids = Object.fromEntries(await Promise.all(['a', 'b'].map(async (n) => [n, (await getMkvidRequestForSet(env, `https://x/tracklist/${n}`))!.id])))
    expect((await app.request(`http://x/ui/api/mkvid/ban/${ids.b}`, { method: 'POST', headers: { Origin: 'http://x', 'Content-Type': 'application/json' }, body: '{}' }, env)).status).toBe(200)
    await post(env, '/mkvid/claim', {})

    const fin = await table('finished', '?size=10')
    // The stored status is unchanged; the Status column is the outcome, and 'a' has no usable recording: not a failure.
    expect(fin.rows.map((r) => [r.setUrl.split('/').pop(), r.status, r.outcome]).sort()).toEqual([['a', 'failed', 'recording_short'], ['b', 'banned', 'banned']])
    expect(names(await table('finished', '?f.status=in:failed'))).toEqual([])
    expect(names(await table('finished', '?f.status=in:recording_short'))).toEqual(['a'])
    expect(names(await table('finished', '?f.status=in:failed|banned'))).toEqual(['b'])
    expect(fin.counts).toEqual({ done: 0, failed: 0, removed_unconfirmed: 0, recording_removed: 0, recording_short: 1, has_recording: 0, duplicate: 0, superseded: 0, banned: 1 })
    expect(names(await table('finished', '?f.error=has:incomplete'))).toEqual(['a'])
    expect(names(await table('finished', '?sort=dj,-setDate'))).toEqual(['a', 'b'])
    expect((await table('queue')).total).toBe(0)
    const h = (await (await app.request('http://x/ui/api/mkvid', {}, env)).json()) as { rendering: Array<{ setUrl: string; status: string }>; counts: Record<string, number>; outcomes: Record<string, number> }
    expect(h.rendering.map((r) => [r.setUrl.split('/').pop(), r.status])).toEqual([['c', 'claimed']])
    expect(h.counts).toMatchObject({ pending: 0, claimed: 1, failed: 1, banned: 1 })
    expect(h.outcomes).toMatchObject({ failed: 0, recording_short: 1, banned: 1 })
    // Paging: page size is clamped to 10..200.
    for (let i = 0; i < 12; i++) await enqueueMkvidRequest(env, { ...input, setUrl: `https://x/tracklist/p${i}`, setDate: `2026-08-${String(10 + i).padStart(2, '0')}` })
    const pg = await table('queue', '?size=10&page=2')
    expect([pg.total, pg.page, pg.pageCount, pg.rows.map((r) => r.position)]).toEqual([12, 2, 2, [11, 12]])
  })

  it('the finished Status column is the outcome: it filters, sorts and counts across every page', async () => {
    const env = makeEnv({ DEV_BYPASS_CF_ACCESS: '1' })
    // Three removals seconds apart would be a burst (test/mkvid-removed-burst.test.ts); this is about the plain outcomes.
    expect((await updateAppSettings(env, { mkvid: { removedBurstCount: 0 } })).ok).toBe(true)
    const GONE = 'probe: yt-dlp exit 1: ERROR: [soundcloud] 77: Unable to download JSON metadata: HTTP Error 404: Not Found'
    const SHORT = "incomplete_recording: source is 1824s but the tracklist's last cue is at 7009s"
    // 12 uploads, newest; then the rest, older, so the default first page of 10 holds none of them.
    const rows: Array<[string, string, string | null]> = Array.from({ length: 12 }, (_, i): [string, string, string | null] => [`d${i}`, 'done', null])
    rows.push(['g1', 'failed', GONE], ['g2', 'failed', GONE], ['g3', 'failed', GONE], ['s1', 'failed', SHORT], ['s2', 'failed', SHORT],
      ['f1', 'failed', 'too many attempts'], ['x1', 'superseded', '1001tracklists now has abcdefghijk'], ['x2', 'superseded', 'duplicate of the same 1001tracklists id under another URL'], ['b1', 'banned', 'banned from the panel'],
      ['p1', 'pending', GONE])
    let t = 5000
    for (const [id, status, error] of rows) {
      await env.DB.prepare("INSERT INTO mkvid_requests (id, slug, set_url, set_title, source, source_url, status, error, created_at, updated_at) VALUES (?, 'dj', ?, ?, 'soundcloud', 'https://api.soundcloud.com/tracks/77', ?, ?, 1, ?)")
        .bind(id, `https://x/tracklist/${id}`, `Set ${id}`, status, error, t--).run()
    }
    type Row = { id: string; status: string; outcome: string | null; outcomeLine: string | null; outcomeDetail: string | null }
    type Table = { rows: Row[]; total: number; pageCount: number; counts: Record<string, number> }
    const fin = async (qs: string) => {
      const r = await app.request(`http://x/ui/api/mkvid/finished${qs}`, {}, env)
      expect(r.status, qs).toBe(200)
      return (await r.json()) as Table
    }
    const ids = (x: Table) => x.rows.map((r) => r.id).sort()

    const first = await fin('?size=10')
    expect([first.total, first.pageCount, first.rows.every((r) => r.outcome === 'done')]).toEqual([21, 3, true])
    const counts = { done: 12, failed: 1, removed_unconfirmed: 0, recording_removed: 3, recording_short: 2, has_recording: 1, duplicate: 1, superseded: 0, banned: 1 }
    expect(first.counts).toEqual(counts)

    const gone = await fin('?size=10&f.status=in:recording_removed')
    expect([gone.total, ids(gone)]).toEqual([3, ['g1', 'g2', 'g3']])
    expect(gone.rows[0]).toMatchObject({ status: 'failed', outcome: 'recording_removed', outcomeLine: 'The recording is gone from SoundCloud (the link answers "not found").' })
    expect(gone.rows[0]!.outcomeDetail).toContain('Nothing to do')
    // The counts are the whole list, whatever is filtered.
    expect(gone.counts).toEqual(counts)
    expect(ids(await fin('?size=10&f.status=in:recording_short'))).toEqual(['s1', 's2'])
    expect(ids(await fin('?size=10&f.status=in:recording_removed|recording_short'))).toEqual(['g1', 'g2', 'g3', 's1', 's2'])
    const failed = await fin('?size=10&f.status=in:failed')
    expect([failed.total, ids(failed), failed.rows[0]!.outcomeDetail]).toEqual([1, ['f1'], null])
    expect(ids(await fin('?f.status=in:has_recording'))).toEqual(['x1'])
    expect(ids(await fin('?f.status=in:duplicate'))).toEqual(['x2'])
    expect((await fin('?f.status=in:superseded')).total).toBe(0)
    expect(ids(await fin('?f.status=nin:done'))).toEqual(['b1', 'f1', 'g1', 'g2', 'g3', 's1', 's2', 'x1', 'x2'])
    // Sorted by it, the outcomes group together.
    expect((await fin('?size=200&sort=status')).rows.map((r) => r.outcome).filter((o, i, a) => o !== a[i - 1])).toEqual(['banned', 'done', 'duplicate', 'failed', 'has_recording', 'recording_removed', 'recording_short'])
    // A value that is not an outcome is refused; a waiting request has none.
    expect((await app.request('http://x/ui/api/mkvid/finished?f.status=in:pending', {}, env)).status).toBe(400)

    const h = (await (await app.request('http://x/ui/api/mkvid', {}, env)).json()) as { counts: Record<string, number>; outcomes: Record<string, number> }
    expect(h.counts).toMatchObject({ failed: 6, done: 12, superseded: 2 })
    expect(h.outcomes).toEqual(counts)
  })

  it('the queue Status column is the readiness state: it filters and counts on the server, and agrees with each row', async () => {
    const env = makeEnv({ DEV_BYPASS_CF_ACCESS: '1' })
    const now = Math.floor(Date.now() / 1000)
    const day = (ago: number) => new Date((now - ago * 86400) * 1000).toISOString().slice(0, 10)
    const q = async (n: string, setDate: string | null) => {
      await enqueueRaw(env, { ...input, setUrl: `https://x/tracklist/${n}`, setDate, source: { kind: 'soundcloud', url: `https://audio/${n}` } })
      return (await getMkvidRequestForSet(env, `https://x/tracklist/${n}`))!.id
    }
    await q('ready', day(30))
    await storeVerifiedList(env, 'https://x/tracklist/ready')
    await q('nolist', day(30))
    await q('untrusted', day(30))
    await storeVerifiedList(env, 'https://x/tracklist/untrusted', { trusted: false })
    await q('untimed', day(30))
    await storeVerifiedList(env, 'https://x/tracklist/untimed', { rows: 10, untimedRows: 5 })
    await q('ids-new', day(1))
    await storeVerifiedList(env, 'https://x/tracklist/ids-new', { rows: 4, idRows: 2 })
    await q('ids-old', day(30))
    await storeVerifiedList(env, 'https://x/tracklist/ids-old', { rows: 4, idRows: 2 })
    const skip = await q('ids-skip', day(1))
    await storeVerifiedList(env, 'https://x/tracklist/ids-skip', { rows: 4, idRows: 2 })
    await env.DB.prepare('UPDATE mkvid_requests SET skip_id_wait = 1 WHERE id = ?').bind(skip).run()
    // No set date: the wait counts from when the set was queued.
    await q('ids-undated', null)
    await storeVerifiedList(env, 'https://x/tracklist/ids-undated', { rows: 4, idRows: 2 })
    const back = await q('backoff', day(30))
    await storeVerifiedList(env, 'https://x/tracklist/backoff')
    await env.DB.prepare("UPDATE mkvid_requests SET not_before = ?, error = 'yt-dlp exit 1' WHERE id = ?").bind(now + 3600, back).run()
    const past = await q('backoff-over', day(30))
    await storeVerifiedList(env, 'https://x/tracklist/backoff-over')
    await env.DB.prepare("UPDATE mkvid_requests SET not_before = ?, error = 'yt-dlp exit 1' WHERE id = ?").bind(now - 3600, past).run()

    type Table = { rows: Array<{ setUrl: string; status: string; readiness: { state: string } }>; total: number; counts: Record<string, number> }
    const queue = async (qs: string) => {
      const r = await app.request(`http://x/ui/api/mkvid/queue${qs}`, {}, env)
      expect(r.status, qs).toBe(200)
      return (await r.json()) as Table
    }
    const names = (x: Table) => x.rows.map((r) => r.setUrl.split('/').pop()).sort()
    const all = await queue('')
    expect(all.total).toBe(10)
    expect(all.counts).toEqual({ unverified: 2, untimed: 1, waiting_ids: 2, backoff: 1, ready: 4 })
    expect(names(await queue('?f.status=in:ready'))).toEqual(['backoff-over', 'ids-old', 'ids-skip', 'ready'])
    expect(names(await queue('?f.status=in:unverified'))).toEqual(['nolist', 'untrusted'])
    expect(names(await queue('?f.status=in:untimed'))).toEqual(['untimed'])
    expect(names(await queue('?f.status=in:waiting_ids'))).toEqual(['ids-new', 'ids-undated'])
    expect(names(await queue('?f.status=in:backoff'))).toEqual(['backoff'])
    // The filter (SQL) and the row's own readiness (computed in the Worker) are the same answer; every row stays `pending`.
    for (const state of Object.keys(all.counts)) {
      const t = await queue(`?size=10&f.status=in:${state}`)
      expect([state, t.total, t.rows.map((r) => r.readiness.state), t.rows.map((r) => r.status)]).toEqual([state, all.counts[state], t.rows.map(() => state), t.rows.map(() => 'pending')])
      expect(t.counts).toEqual(all.counts)
    }
    expect(names(await queue('?f.status=in:ready&sort=status'))).toHaveLength(4)
    expect((await app.request('http://x/ui/api/mkvid/queue?f.status=in:failed', {}, env)).status).toBe(400)
  })

  it('a filter the table API does not know is a 400, not an empty list', async () => {
    const env = makeEnv({ DEV_BYPASS_CF_ACCESS: '1' })
    for (const qs of ['queue?f.status=in:nope', 'queue?f.source=in:bandcamp', 'finished?f.account=in:other', 'finished?sort=nope', 'queue?f.position=has:1']) {
      const r = await app.request(`http://x/ui/api/mkvid/${qs}`, {}, env)
      expect([qs, r.status]).toEqual([qs, 400])
      expect(await r.json()).toMatchObject({ error: 'bad_table_query' })
    }
  })

  it('the claim body names the accounts mkvid can upload with; the request names the one it got', async () => {
    const env = makeEnv({ MKVID_DAILY_CLAIM_CAP: '0', MKVID_SHARED_DAILY_CLAIM_CAP: '1' })
    await enqueueMkvidRequest(env, input)
    // Pre-accounts mkvid (no body / no field) only ever has the primary client.
    expect(((await (await post(env, '/mkvid/claim', {})).json()) as { request: unknown }).request).toBeNull()
    expect((await post(env, '/mkvid/claim', { accounts: ['bogus'] })).status).toBe(400)
    const { request } = (await (await post(env, '/mkvid/claim', { accounts: ['primary', 'shared'] })).json()) as { request: { account: string; setUrl: string } }
    expect(request).toMatchObject({ setUrl: input.setUrl, account: 'shared' })
    expect(((await (await post(env, '/mkvid/claim', { accounts: [] })).json()) as { request: unknown }).request).toBeNull()
  })

  it('the claim body may name a preferAccount, honoured while that account has claims left', async () => {
    const env = makeEnv({ MKVID_DAILY_CLAIM_CAP: '5', MKVID_SHARED_DAILY_CLAIM_CAP: '5' })
    for (const n of ['a', 'b']) await enqueueMkvidRequest(env, { ...input, setUrl: `https://x/tracklist/${n}` })
    expect((await post(env, '/mkvid/claim', { accounts: ['primary', 'shared'], preferAccount: 'bogus' })).status).toBe(400)
    const claim = async (b: object) => ((await (await post(env, '/mkvid/claim', b)).json()) as { request: { account: string } }).request
    expect(await claim({ accounts: ['primary', 'shared'], preferAccount: 'shared' })).toMatchObject({ account: 'shared' })
    expect(await claim({ accounts: ['primary', 'shared'] })).toMatchObject({ account: 'primary' })
  })

  it('the panel can reorder and ban queued sets', async () => {
    const env = makeEnv({ DEV_BYPASS_CF_ACCESS: '1' })
    for (const [n, d] of [['a', '2026-09-13'], ['b', '2026-09-11'], ['c', '2026-09-05']] as Array<[string, string]>) await enqueueMkvidRequest(env, { ...input, setUrl: `https://x/tracklist/${n}`, setDate: d })
    const ids = Object.fromEntries(await Promise.all(['a', 'b', 'c'].map(async (n) => [n, (await getMkvidRequestForSet(env, `https://x/tracklist/${n}`))!.id])))
    const panel = async () => {
      const get = async (w: string) => ((await (await app.request(`http://x/ui/api/mkvid/${w}`, {}, env)).json()) as { rows: Array<{ setUrl: string; status: string }> }).rows
      return { queue: await get('queue'), settled: await get('finished') }
    }
    const act = (path: string, body?: unknown) => app.request(`http://x/ui/api/mkvid/${path}`, { method: 'POST', headers: { Origin: 'http://x', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, env)

    expect((await act(`move/${ids.c}`, { to: 'sideways' })).status).toBe(400)
    const moved = await act(`move/${ids.c}`, { to: 'top' })
    expect(moved.status).toBe(200)
    expect(await moved.json()).toMatchObject({ ok: true, to: 'top', position: 1 })
    expect((await panel()).queue.map((q) => q.setUrl.split('/').pop())).toEqual(['c', 'a', 'b'])
    expect((await act(`move/${crypto.randomUUID()}`, { to: 'up' })).status).toBe(404)

    expect((await act(`ban/${ids.a}`)).status).toBe(200)
    expect((await act(`ban/${ids.a}`)).status).toBe(409)
    const p = await panel()
    expect(p.queue.map((q) => q.setUrl.split('/').pop())).toEqual(['c', 'b'])
    expect(p.settled.map((s) => s.status)).toEqual(['banned'])
    expect((await act(`retry/${ids.a}`)).status).toBe(200)
    expect((await panel()).queue.map((q) => q.setUrl.split('/').pop())).toEqual(['c', 'a', 'b'])
  })

  it('fail parks or requeues, and complete 503s without a YouTube connection', async () => {
    const env = makeEnv()
    await enqueueMkvidRequest(env, input)
    const { request } = (await (await post(env, '/mkvid/claim', {})).json()) as { request: { id: string } }
    const failed = await post(env, '/mkvid/fail', { id: request.id, error: 'incomplete_recording', permanent: true, jobId: 'job-2' })
    expect(await failed.json()).toEqual({ status: 'failed', attempts: 1 })

    const noYt = makeEnv({ SUBS: fakeKV() })
    await enqueueMkvidRequest(noYt, input)
    const { request: r2 } = (await (await post(noYt, '/mkvid/claim', {})).json()) as { request: { id: string } }
    expect((await post(noYt, '/mkvid/complete', { id: r2.id, videoId: 'upload12345' })).status).toBe(503)
  })
})
