import { describe, it, expect, vi, beforeEach } from 'vitest'
import { app } from '../src/index'
import type { Env } from '../src/types'
import type { StoredTokens } from '../src/lib/google-oauth'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'
import { enqueueMkvidRequest, getMkvidRequest, getMkvidRequestForSet } from '../src/lib/mkvid'
import { saveSubState } from '../src/lib/sync-store'

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
      counts: { pending: 0, claimed: 0, done: 1, failed: 0, superseded: 0, banned: 0 },
      accounts: [{ account: 'primary', label: 'mkvid-uploads', used: 1, cap: 6 }, { account: 'shared', label: 'tracked-youtube', used: 0, cap: 0 }],
      dailyClaims: 1,
      dailyClaimCap: 6,
    })
  })

  it('validates bodies and reports unknown / finished requests', async () => {
    const env = makeEnv()
    expect((await post(env, '/mkvid/complete', { id: 'not-a-uuid', videoId: 'upload12345' })).status).toBe(400)
    expect((await post(env, '/mkvid/complete', { id: crypto.randomUUID(), videoId: 'bad id' })).status).toBe(400)
    expect((await post(env, '/mkvid/complete', { id: crypto.randomUUID(), videoId: 'upload12345' })).status).toBe(404)
    expect((await post(env, '/mkvid/fail', { id: crypto.randomUUID(), error: 'x' })).status).toBe(404)
    expect((await post(env, '/mkvid/fail', { id: crypto.randomUUID() })).status).toBe(400)
  })

  it('the panel API explains the queue: cap, usage, reset time, last poll, waiting line', async () => {
    const env = makeEnv({ DEV_BYPASS_CF_ACCESS: '1', MKVID_DAILY_CLAIM_CAP: '0' })
    await enqueueMkvidRequest(env, input)
    expect(((await (await post(env, '/mkvid/claim', {})).json()) as { request: unknown }).request).toBeNull()
    const r = await app.request('http://x/subscriptions/api/mkvid', {}, env)
    expect(r.status).toBe(200)
    const d = (await r.json()) as { dailyClaimCap: number; dailyClaims: number; quotaResetsAt: number; now: number; lastPoll: { outcome: string } | null; queue: Array<{ setUrl: string }>; settled: unknown[] }
    expect(d).toMatchObject({ enabled: true, dailyClaimCap: 0, dailyClaims: 0, lastPoll: { outcome: 'capped', accounts: ['primary'] }, settled: [], accounts: [{ account: 'primary', cap: 0 }, { account: 'shared', cap: 0 }] })
    expect(d.queue.map((q) => q.setUrl)).toEqual([input.setUrl])
    expect(d.quotaResetsAt).toBeGreaterThan(d.now)
    expect(d.quotaResetsAt - d.now).toBeLessThanOrEqual(25 * 3600)
  })

  it('the panel API pages and filters both lists', async () => {
    const env = makeEnv({ DEV_BYPASS_CF_ACCESS: '1', MKVID_DAILY_CLAIM_CAP: '10' })
    const sets = [
      ['a', '2026-09-05', 'lillypalmer', 'Lilly Palmer', 'soundcloud'],
      ['b', '2026-09-04', 'lillypalmer', 'Lilly Palmer', 'hearthis'],
      ['c', '2026-09-03', 'johnsummit', 'John Summit', 'soundcloud'],
    ] as const
    for (const [n, setDate, slug, artistName, kind] of sets) {
      await enqueueMkvidRequest(env, { ...input, setUrl: `https://x/tracklist/${n}`, setDate, slug, artistName, setTitle: `${artistName} @ set ${n}`, source: { kind, url: `https://audio/${n}` } })
    }
    type Panel = {
      queue: Array<{ setUrl: string; position: number }>
      settled: Array<{ setUrl: string; status: string }>
      queueCursor: string | null
      queueTotal: number
      settledCursor: string | null
      settledTotal: number
      djs: Array<{ slug: string; label: string; count: number }>
      counts: Record<string, number>
      section: string
    }
    const panel = async (qs: string) => (await (await app.request(`http://x/subscriptions/api/mkvid${qs}`, {}, env)).json()) as Panel
    const names = (rows: ReadonlyArray<{ setUrl: string }>) => rows.map((r) => r.setUrl.split('/').pop())

    const p1 = await panel('?limit=2')
    expect(names(p1.queue)).toEqual(['a', 'b'])
    expect(p1.queue.map((q) => q.position)).toEqual([1, 2])
    expect(p1.queueTotal).toBe(3)
    expect(p1.djs).toEqual([
      { slug: 'lillypalmer', label: 'Lilly Palmer', count: 2 },
      { slug: 'johnsummit', label: 'John Summit', count: 1 },
    ])

    // The next page of one list alone: the other is left out, the header still comes along.
    const p2 = await panel(`?limit=2&section=queue&queueCursor=${encodeURIComponent(p1.queueCursor!)}`)
    expect(names(p2.queue)).toEqual(['c'])
    expect(p2.queue[0]!.position).toBe(3)
    expect(p2.queueCursor).toBeNull()
    expect(p2.settled).toEqual([])
    expect(p2.section).toBe('queue')

    // Filters: DJ, source and free text, over both lists.
    expect(names((await panel('?dj=johnsummit')).queue)).toEqual(['c'])
    expect(names((await panel('?source=hearthis')).queue)).toEqual(['b'])
    expect(names((await panel('?q=set%20a')).queue)).toEqual(['a'])
    const waiting = await panel('?status=pending')
    expect(names(waiting.queue)).toEqual(['a', 'b', 'c'])
    expect(waiting.settled).toEqual([])

    // A settled list to page and filter: 'a' fails, 'b' is banned, 'c' is rendering.
    const first = (await (await post(env, '/mkvid/claim', {})).json()) as { request: { id: string } }
    await post(env, '/mkvid/fail', { id: first.request.id, error: 'incomplete_recording', permanent: true })
    const ids = Object.fromEntries(await Promise.all(['a', 'b'].map(async (n) => [n, (await getMkvidRequestForSet(env, `https://x/tracklist/${n}`))!.id])))
    expect((await app.request(`http://x/subscriptions/api/mkvid/ban/${ids.b}`, { method: 'POST' }, env)).status).toBe(200)
    await post(env, '/mkvid/claim', {})

    const s1 = await panel('?limit=2')
    expect(s1.settled.map((r) => [r.setUrl.split('/').pop(), r.status])).toEqual([['c', 'claimed'], ['a', 'failed']])
    expect(s1.settledTotal).toBe(3)
    const s2 = await panel(`?limit=2&section=settled&settledCursor=${encodeURIComponent(s1.settledCursor!)}`)
    expect(names(s2.settled)).toEqual(['b'])
    expect(s2.queue).toEqual([])
    const problems = await panel('?status=failed,banned')
    expect(names(problems.settled)).toEqual(['a', 'b'])
    expect(problems.queue).toEqual([])
    // The global counts stay global — the header is about the queue, not the filter.
    expect(problems.counts).toMatchObject({ pending: 0, claimed: 1, failed: 1, banned: 1 })
  })

  it('a filter the panel API does not know is a 400, not an empty list', async () => {
    const env = makeEnv({ DEV_BYPASS_CF_ACCESS: '1' })
    for (const qs of ['?status=nope', '?status=pending,nope', '?source=bandcamp', '?account=other', '?section=middle']) {
      const r = await app.request(`http://x/subscriptions/api/mkvid${qs}`, {}, env)
      expect([qs, r.status]).toEqual([qs, 400])
      expect(await r.json()).toMatchObject({ error: 'invalid_request' })
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

  it('the panel can reorder and ban queued sets', async () => {
    const env = makeEnv({ DEV_BYPASS_CF_ACCESS: '1' })
    for (const [n, d] of [['a', '2026-09-13'], ['b', '2026-09-11'], ['c', '2026-09-05']] as Array<[string, string]>) await enqueueMkvidRequest(env, { ...input, setUrl: `https://x/tracklist/${n}`, setDate: d })
    const ids = Object.fromEntries(await Promise.all(['a', 'b', 'c'].map(async (n) => [n, (await getMkvidRequestForSet(env, `https://x/tracklist/${n}`))!.id])))
    const panel = async () => ((await (await app.request('http://x/subscriptions/api/mkvid', {}, env)).json()) as { queue: Array<{ setUrl: string }>; settled: Array<{ status: string }> })
    const act = (path: string, body?: unknown) => app.request(`http://x/subscriptions/api/mkvid/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, env)

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
