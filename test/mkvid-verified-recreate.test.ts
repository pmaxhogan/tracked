import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { app } from '../src/index'
import type { Env } from '../src/types'
import type { StoredTokens } from '../src/lib/google-oauth'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'
import { storeVerifiedList } from './helpers/mkvid-lists'
import {
  claimMkvidRequest,
  enqueueMkvidRequest,
  failMkvidRequest,
  findMkvidUploadByTitle,
  getMkvidRequest,
  getMkvidRequestForSet,
  listPendingMkvidRequests,
  mkvidRowCounts,
  MKVID_MAX_ATTEMPTS,
  nextMkvidRequests,
  saveMkvidTracks,
  supersedeMkvidRequestForSet,
} from '../src/lib/mkvid'
import { ID_WAIT_SECONDS, isVerified, mkvidReadiness, readinessFor, pullInHeldRecheck, setAgeReference, timedRowCounts } from '../src/lib/mkvid-readiness'
import {
  callMkvidDelete,
  countOldStyleVideos,
  deleteBackoffSeconds,
  deleteOldVideo,
  isOldStyle,
  listUndeletedOldVideos,
  recreateMkvidRequest,
  resetOldVideoDelete,
  retryDueOldVideoDeletions,
} from '../src/lib/mkvid-recreate'
import { cachePlaylistVideoIds } from '../src/lib/playlist-cache'
import { parseTracklist } from '../src/lib/tracklists1001'
import { saveSubState, setTracklistVideo } from '../src/lib/sync-store'
import { makeLogger } from '../src/lib/log'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
import { addVideoToPlaylist, findPlaylistByTitle, listPlaylistVideoIds, removeVideoFromPlaylist } from '../src/lib/youtube-playlists'

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
    DEV_BYPASS_CF_ACCESS: '1',
    ...overrides,
  } as Env
}
const log = makeLogger({ task: 'test' })
const NOW = Math.floor(Date.now() / 1000)
const DAY = 86400
const isoDay = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10)
const fixture = (name: string) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8')

const input = (name: string, setDate: string | null = '2026-01-01') => ({
  slug: 'lillypalmer',
  setUrl: `https://www.1001tracklists.com/tracklist/abc/${name}.html`,
  artistName: 'Lilly Palmer',
  setTitle: `Lilly Palmer @ ${name}`,
  setDate,
  source: { kind: 'soundcloud' as const, url: 'https://api.soundcloud.com/tracks/1' },
  lastCueSeconds: 100,
  trackCount: 3,
  idedCount: 3,
})

async function queue(env: Env, name: string, opts: { setDate?: string | null; verified?: boolean; idRows?: number; rows?: number; untimedRows?: number } = {}) {
  const i = input(name, opts.setDate === undefined ? '2026-01-01' : opts.setDate)
  await enqueueMkvidRequest(env, i)
  if (opts.verified !== false) await storeVerifiedList(env, i.setUrl, { idRows: opts.idRows ?? 0, rows: opts.rows, untimedRows: opts.untimedRows })
  return (await getMkvidRequestForSet(env, i.setUrl))!
}

const post = (env: Env, path: string, body?: unknown, token = 'mk-secret') =>
  app.request(`http://x${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, env)
const panel = async (env: Env) => (await (await app.request('http://x/ui/api/mkvid', {}, env)).json()) as Record<string, any>

beforeEach(() => {
  vi.resetAllMocks()
  ;(listPlaylistVideoIds as ReturnType<typeof vi.fn>).mockImplementation(async () => new Set<string>())
  ;(findPlaylistByTitle as ReturnType<typeof vi.fn>).mockImplementation(async (title: string) => ({ id: title.startsWith('All') ? 'PLc' : 'PLa', title }))
  ;(removeVideoFromPlaylist as ReturnType<typeof vi.fn>).mockResolvedValue(1)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

// ─── readiness rules ────────────────────────────────────────────────────────

describe('mkvidReadiness', () => {
  const base = { status: 'pending', notBefore: null, setDate: null, discoveredAt: NOW - 30 * DAY, skipIdWait: false, verified: true, listRows: 10, idRows: 0, baseRows: 10, timedRows: 10 }

  it('a verified list under 90 % timed is held, whatever Render now says', () => {
    expect(mkvidReadiness({ ...base, timedRows: 9 })).toEqual({ state: 'ready' })
    expect(mkvidReadiness({ ...base, timedRows: 8 })).toEqual({ state: 'untimed', timedRows: 8, baseRows: 10 })
    expect(mkvidReadiness({ ...base, timedRows: 2, baseRows: 33, skipIdWait: true })).toEqual({ state: 'untimed', timedRows: 2, baseRows: 33 })
    // A list stored before migration 0013 has no counts: held until it is saved again.
    expect(mkvidReadiness({ ...base, timedRows: 0, baseRows: 0 }).state).toBe('untimed')
  })

  it('an unverified or empty list is never ready', () => {
    expect(mkvidReadiness({ ...base, verified: false })).toEqual({ state: 'unverified' })
    expect(mkvidReadiness({ ...base, listRows: 0 })).toEqual({ state: 'unverified' })
    // Render now does not skip verification.
    expect(mkvidReadiness({ ...base, verified: false, skipIdWait: true })).toEqual({ state: 'unverified' })
  })

  it('a verified list with ID rows waits until the set is 7 days old by its date, else its discovery', () => {
    const recent = isoDay(NOW - 2 * DAY)
    const r = mkvidReadiness({ ...base, idRows: 2, setDate: recent }, NOW)
    expect(r).toEqual({ state: 'waiting_ids', until: setAgeReference(recent, 0) + ID_WAIT_SECONDS, idRows: 2 })
    expect(mkvidReadiness({ ...base, idRows: 2, setDate: isoDay(NOW - 8 * DAY) }, NOW)).toEqual({ state: 'ready' })
    // No set date: the discovery time counts.
    expect(mkvidReadiness({ ...base, idRows: 1, discoveredAt: NOW - DAY }, NOW)).toEqual({ state: 'waiting_ids', until: NOW - DAY + ID_WAIT_SECONDS, idRows: 1 })
    expect(mkvidReadiness({ ...base, idRows: 1, discoveredAt: NOW - 7 * DAY }, NOW)).toEqual({ state: 'ready' })
    // Render now skips the wait; no IDs means no wait.
    expect(mkvidReadiness({ ...base, idRows: 2, setDate: recent, skipIdWait: true }, NOW)).toEqual({ state: 'ready' })
    expect(mkvidReadiness({ ...base, idRows: 0, setDate: recent }, NOW)).toEqual({ state: 'ready' })
  })

  it('a retry backoff is reported after the list checks', () => {
    expect(mkvidReadiness({ ...base, notBefore: NOW + 60 }, NOW)).toEqual({ state: 'backoff', until: NOW + 60 })
  })

  it('setAgeReference reads an ISO date as UTC midnight, ignores junk', () => {
    expect(setAgeReference('2026-09-01', 5)).toBe(Date.UTC(2026, 8, 1) / 1000)
    expect(setAgeReference('someday', 5)).toBe(5)
    expect(setAgeReference(null, 5)).toBe(5)
  })
})

describe('timed rows are counted', () => {
  it('counts base rows only ("w/" rows are not), row 0 always timed', () => {
    const t = (cueSeconds: number | null, layered = false) => ({ cueSeconds, layered })
    expect(timedRowCounts([t(null), t(null), t(120), t(null, true), t(300)])).toEqual({ baseRows: 4, timedRows: 3 })
    expect(timedRowCounts([])).toEqual({ baseRows: 0, timedRows: 0 })
  })
})

describe('ID rows are counted', () => {
  it('track_count counts every page row, ided_count only identified ones (anonymous "ID - ID" rows were in neither)', async () => {
    const url = 'https://www.1001tracklists.com/tracklist/dcr839/decoy.html'
    const parsed = parseTracklist(url, fixture('tracklist-decoy-dcr839.html'))
    const anon = parsed.rows.filter((r) => r.anonymous).length
    expect(anon).toBeGreaterThan(0)
    const c = mkvidRowCounts(parsed.rows)
    expect(c.trackCount).toBe(parsed.rows.length)
    expect(c.trackCount).toBe(parsed.tracks.length + anon)
    expect(c.idedCount).toBe(parsed.rows.filter((r) => !r.anonymous && !r.isUnidentified).length)

    const env = makeEnv()
    await enqueueMkvidRequest(env, { ...input('ms'), setUrl: url })
    expect(await saveMkvidTracks(env, url, parsed)).toBe('saved')
    const req = (await getMkvidRequestForSet(env, url))!
    const idRows = parsed.rows.length - c.idedCount
    expect(req).toMatchObject({ trackCount: c.trackCount, idedCount: c.idedCount })
    expect(await env.DB.prepare('SELECT id_rows FROM mkvid_request_tracks WHERE request_id = ?').bind(req.id).first()).toEqual({ id_rows: idRows })
  })
})

// ─── the claim gate ─────────────────────────────────────────────────────────

describe('claim: verified lists only, IDs wait 7 days', () => {
  it('passes over an unverified set without touching it, and serves the verified one behind it', async () => {
    const env = makeEnv()
    const a = await queue(env, 'a', { setDate: '2026-02-01', verified: false })
    const b = await queue(env, 'b', { setDate: '2026-01-01' })
    const claimed = (await claimMkvidRequest(env, log, ['primary'], 'scene'))!
    expect(claimed.id).toBe(b.id)
    expect(claimed.tracksTrusted).toBe(true)
    expect(claimed.tracks.length).toBeGreaterThan(0)
    expect(await getMkvidRequest(env, a.id)).toMatchObject({ status: 'pending', attempts: 0, notBefore: null, error: null })
    expect(await claimMkvidRequest(env, log, ['primary'], 'scene')).toBeNull()
    expect(await isVerified(env, a.setUrl)).toBe(false)
    expect(await isVerified(env, b.setUrl)).toBe(true)
  })

  it('passes over a verified list under 90 % timed (Render now included), and serves one at 90 %', async () => {
    const env = makeEnv()
    const a = await queue(env, 'a', { setDate: '2026-03-01', rows: 33, untimedRows: 31 })
    await env.DB.prepare('UPDATE mkvid_requests SET skip_id_wait = 1 WHERE id = ?').bind(a.id).run()
    const b = await queue(env, 'b', { setDate: '2026-02-01', rows: 10, untimedRows: 1 })
    expect((await claimMkvidRequest(env, log, ['primary'], 'scene'))!.id).toBe(b.id)
    expect(await getMkvidRequest(env, a.id)).toMatchObject({ status: 'pending', attempts: 0, notBefore: null })
    expect(await claimMkvidRequest(env, log, ['primary'], 'scene')).toBeNull()
    expect((await readinessFor(env, [a])).get(a.id)).toEqual({ state: 'untimed', timedRows: 2, baseRows: 33 })
  })

  it('an untrusted stored list is not claimable either (the stub reads trusted)', async () => {
    const env = makeEnv()
    const a = await queue(env, 'a', { verified: false })
    await storeVerifiedList(env, a.setUrl, { trusted: false })
    expect(await claimMkvidRequest(env, log, ['primary'], 'scene')).toBeNull()
    expect(await nextMkvidRequests(env)).toEqual([])
  })

  it('holds a verified list with IDs until the set is 7 days old; Render now skips the wait', async () => {
    const env = makeEnv()
    const recent = await queue(env, 'recent', { setDate: isoDay(NOW - 2 * DAY), idRows: 2 })
    expect(await claimMkvidRequest(env, log, ['primary'], 'scene')).toBeNull()
    expect(await getMkvidRequest(env, recent.id)).toMatchObject({ status: 'pending', attempts: 0 })
    const rd = (await readinessFor(env, [recent])).get(recent.id)!
    expect(rd).toMatchObject({ state: 'waiting_ids', idRows: 2 })

    // An old set with IDs goes, ID rows and all.
    const old = await queue(env, 'old', { setDate: isoDay(NOW - 10 * DAY), idRows: 5 })
    expect((await claimMkvidRequest(env, log, ['primary'], 'scene'))!.id).toBe(old.id)

    // Render now on the recent one.
    const r = await app.request(`http://x/ui/api/mkvid/render-now/${recent.id}`, { method: 'POST', headers: { Origin: 'http://x', 'Content-Type': 'application/json' }, body: '{}' }, env)
    expect(r.status).toBe(200)
    expect((await getMkvidRequest(env, recent.id))!.skipIdWait).toBe(true)
    const c = (await claimMkvidRequest(env, log, ['primary'], 'scene'))!
    expect(c.id).toBe(recent.id)
    expect(c.tracks.filter((t) => t.isId)).toHaveLength(2)
    // A done request cannot take it.
    await env.DB.prepare("UPDATE mkvid_requests SET status = 'done' WHERE id = ?").bind(old.id).run()
    expect((await app.request(`http://x/ui/api/mkvid/render-now/${old.id}`, { method: 'POST', headers: { Origin: 'http://x', 'Content-Type': 'application/json' }, body: '{}' }, env)).status).toBe(409)
  })

  it('an undated set waits by its discovery date', async () => {
    const env = makeEnv()
    const a = await queue(env, 'undated', { setDate: null, idRows: 1 })
    await env.DB.prepare('INSERT INTO tracklists (slug, url, position, discovered_at) VALUES (?, ?, 0, ?)').bind('lillypalmer', a.setUrl, NOW - 3 * DAY).run()
    expect(await claimMkvidRequest(env, log, ['primary'], 'scene')).toBeNull()
    expect((await readinessFor(env, [a])).get(a.id)).toEqual({ state: 'waiting_ids', until: NOW - 3 * DAY + ID_WAIT_SECONDS, idRows: 1 })
    await env.DB.prepare('UPDATE tracklists SET discovered_at = ?').bind(NOW - 8 * DAY).run()
    expect((await claimMkvidRequest(env, log, ['primary'], 'scene'))!.id).toBe(a.id)
  })

  it('mkvid refusing an unverified list puts it back without using an attempt, however often it happens', async () => {
    const env = makeEnv()
    const a = await queue(env, 'a')
    for (let i = 0; i < MKVID_MAX_ATTEMPTS + 2; i++) {
      const c = (await claimMkvidRequest(env, log, ['primary'], 'scene'))!
      expect(c.id).toBe(a.id)
      const r = await failMkvidRequest(env, { id: a.id, error: 'unverified_tracklist: tracksTrusted is false' }, log)
      expect(r).toEqual({ status: 'pending', attempts: 0 })
      const row = (await getMkvidRequest(env, a.id))!
      expect(row).toMatchObject({ status: 'pending', attempts: 0, claimedAt: null })
      expect(row.notBefore).toBeGreaterThan(NOW)
      await env.DB.prepare('UPDATE mkvid_requests SET not_before = NULL').run()
    }
    // Not counted against the daily cap either.
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM mkvid_requests WHERE status IN ('claimed','done')").first()).toEqual({ n: 0 })
  })

  it('the panel says why each waiting set waits', async () => {
    const env = makeEnv()
    await queue(env, 'unverified', { setDate: '2026-03-01', verified: false })
    await queue(env, 'ids', { setDate: isoDay(NOW - DAY), idRows: 3 })
    await queue(env, 'ready', { setDate: '2026-01-01' })
    const p = await panel(env)
    expect(p).not.toHaveProperty('requireFullTracklist')
    const why = Object.fromEntries(p.queue.map((q: any) => [q.setUrl.split('/').pop().replace('.html', ''), q.readiness.state]))
    expect(why).toEqual({ unverified: 'unverified', ids: 'waiting_ids', ready: 'ready' })
    const ids = p.queue.find((q: any) => q.setUrl.endsWith('ids.html'))
    expect(ids.readiness.until).toBe(setAgeReference(isoDay(NOW - DAY), 0) + ID_WAIT_SECONDS)
    // The page carries the "Render now" / "Delete and recreate" / bulk controls.
    const html = await (await app.request('http://x/ui/mkvid', {}, env)).text()
    for (const s of ['Render now', 'Delete and recreate', 'Recreate all old-style videos', 'waiting for IDs until', 'not verified', 'capped']) expect(html).toContain(s)
  })
})

// ─── delete and recreate ────────────────────────────────────────────────────

const OLD = 'oldVid00001'
const NEW = 'newVid00002'

/** A done request whose video is an old-style mkvid upload in both playlists. */
async function doneRequest(env: Env, name = 'set', style: string | null = null) {
  const a = await queue(env, name)
  await saveSubState(env, 'lillypalmer', {
    playlistId: 'PLa',
    artistName: 'Lilly Palmer',
    processedTracklistUrls: [a.setUrl],
    tracklistVideos: { [a.setUrl]: { videoId: OLD, checkedAt: 1 } },
  })
  await setTracklistVideo(env, 'lillypalmer', a.setUrl, { videoId: OLD, source: 'mkvid' })
  await env.DB.prepare("UPDATE mkvid_requests SET status = 'done', video_id = ?, video_url = ?, style = ?, attempts = 1 WHERE id = ?")
    .bind(OLD, `https://youtu.be/${OLD}`, style, a.id)
    .run()
  return a
}

function stubMkvid(answer: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return answer(url, init)
  }))
  return calls
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('delete video (unpublish)', () => {
  const postUi = (env: Env, path: string) => app.request(`http://x${path}`, { method: 'POST', headers: { Origin: 'http://x', 'Content-Type': 'application/json' }, body: '{}' }, env)
  const due = async (env: Env, url: string) => (await env.DB.prepare('SELECT next_due_at FROM set_schedule WHERE url = ?').bind(url).first<{ next_due_at: number | null }>())?.next_due_at ?? null

  it('takes the video out of both playlists, deletes it via mkvid, and puts the request back to pending with no video', async () => {
    const env = makeEnv({ MKVID_URL: 'https://mkvid.example/' })
    const a = await doneRequest(env, 'set', 'scene')
    ;(listPlaylistVideoIds as ReturnType<typeof vi.fn>).mockImplementation(async () => new Set([OLD]))
    const calls = stubMkvid(() => json({ ok: true, outcome: 'deleted' }))
    const r = await postUi(env, `/ui/api/mkvid/unpublish/${a.id}`)
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ ok: true, videoId: OLD, removedFromArtist: true, deleteState: 'deleted' })
    expect(removeVideoFromPlaylist).toHaveBeenCalledWith('PLa', OLD, 'ya29')
    expect(removeVideoFromPlaylist).toHaveBeenCalledWith('PLc', OLD, 'ya29')
    expect(calls.map((c) => c.url)).toEqual([`https://mkvid.example/api/videos/${OLD}/delete`])
    expect(await getMkvidRequest(env, a.id)).toMatchObject({ status: 'pending', videoId: null, videoUrl: null, replacesVideoId: null, attempts: 0 })
    expect(await env.DB.prepare('SELECT video_id, video_source FROM tracklists WHERE url = ?').bind(a.setUrl).first()).toEqual({ video_id: null, video_source: null })
    expect(await env.DB.prepare('SELECT state, replaced_by FROM mkvid_old_videos WHERE video_id = ?').bind(OLD).first()).toEqual({ state: 'deleted', replaced_by: 'unpublished' })
    // Its (timed) list makes it claimable again; twice is refused.
    expect((await claimMkvidRequest(env, log, ['primary'], 'scene'))!.id).toBe(a.id)
    expect((await postUi(env, `/ui/api/mkvid/unpublish/${a.id}`)).status).toBe(409)
    expect((await postUi(env, '/ui/api/mkvid/unpublish/nope')).status).toBe(404)
  })

  it('an untimed list stays held after unpublishing, its set due within a week; the operator route needs the API token', async () => {
    const env = makeEnv({ MKVID_URL: 'https://mkvid.example/' })
    const a = await doneRequest(env, 'set', 'scene')
    await storeVerifiedList(env, a.setUrl, { rows: 33, untimedRows: 31 })
    await env.DB.prepare('INSERT INTO set_schedule (url, set_date, next_due_at, last_fetched_at, has_id_rows, no_good_video, updated_at) VALUES (?, NULL, NULL, 1, 0, 0, 1)').bind(a.setUrl).run()
    stubMkvid(() => json({ ok: true, outcome: 'deleted' }))
    expect((await app.request(`http://x/ops/mkvid/unpublish/${a.id}`, { method: 'POST' }, env)).status).toBe(401)
    const before = Math.floor(Date.now() / 1000)
    const r = await app.request(`http://x/ops/mkvid/unpublish/${a.id}`, { method: 'POST', headers: { Authorization: 'Bearer tasker' } }, env)
    expect(r.status).toBe(200)
    expect(await claimMkvidRequest(env, log, ['primary'], 'scene')).toBeNull()
    const at = (await due(env, a.setUrl))!
    expect(at).toBeGreaterThanOrEqual(before + 7 * DAY)
    expect(at).toBeLessThanOrEqual(before + 7 * DAY + 5)
  })

  it('without a YouTube connection nothing changes', async () => {
    const env = makeEnv({ SUBS: fakeKV() })
    const a = await doneRequest(env, 'set', 'scene')
    expect((await postUi(env, `/ui/api/mkvid/unpublish/${a.id}`)).status).toBe(503)
    expect(await getMkvidRequest(env, a.id)).toMatchObject({ status: 'done', videoId: OLD })
  })
})

describe('a held (untimed) set is kept due within a week', () => {
  const due = async (env: Env, url: string) => (await env.DB.prepare('SELECT next_due_at FROM set_schedule WHERE url = ?').bind(url).first<{ next_due_at: number | null }>())?.next_due_at ?? null

  it('on Delete and recreate, and never pushed later or applied to a timed list', async () => {
    const env = makeEnv()
    const a = await doneRequest(env, 'held', 'scene')
    const b = await doneRequest(env, 'timed', 'scene')
    await env.DB.prepare("UPDATE mkvid_requests SET video_id = 'otherVid0001' WHERE id = ?").bind(b.id).run()
    await storeVerifiedList(env, a.setUrl, { rows: 33, untimedRows: 31 })
    const soon = NOW + 3600
    await env.DB.prepare('INSERT INTO set_schedule (url, set_date, next_due_at, last_fetched_at, has_id_rows, no_good_video, updated_at) VALUES (?, NULL, NULL, 1, 0, 0, 1), (?, NULL, NULL, 1, 0, 0, 1)').bind(a.setUrl, b.setUrl).run()
    expect((await recreateMkvidRequest(env, a.id, log)).ok).toBe(true)
    expect((await recreateMkvidRequest(env, b.id, log)).ok).toBe(true)
    expect(await due(env, a.setUrl)).toBeGreaterThanOrEqual(NOW + 7 * DAY)
    expect(await due(env, b.setUrl)).toBeNull()
    await env.DB.prepare('UPDATE set_schedule SET next_due_at = ? WHERE url = ?').bind(soon, a.setUrl).run()
    expect(await pullInHeldRecheck(env, a.setUrl)).toBe(true)
    expect(await due(env, a.setUrl)).toBe(soon)
    expect(await pullInHeldRecheck(env, b.setUrl)).toBe(false)
  })

  it('on every save of the list (the sync saves after its own scheduling)', async () => {
    const env = makeEnv()
    const a = await queue(env, 'x')
    await env.DB.prepare('INSERT INTO set_schedule (url, set_date, next_due_at, last_fetched_at, has_id_rows, no_good_video, updated_at) VALUES (?, NULL, ?, 1, 0, 0, 1)').bind(a.setUrl, NOW + 90 * DAY).run()
    const rows = Array.from({ length: 10 }, (_, i) => ({ artist: `A${i}`, title: `T${i}`, startSeconds: i === 0 ? 0 : i === 9 ? 900 : null, ownStartSeconds: null, isMashupLinked: false, isUnidentified: false, anonymous: false, artworkUrl: null }))
    expect(await saveMkvidTracks(env, a.setUrl, { rows: rows as any, decoy: { named: 10, mismatched: 0, suspected: false } })).toBe('kept')
    expect(await due(env, a.setUrl)).toBe(NOW + 90 * DAY) // the stored (trusted, timed) list was kept: not held
    await env.DB.prepare('UPDATE mkvid_request_tracks SET trusted = 0').run()
    expect(await saveMkvidTracks(env, a.setUrl, { rows: rows as any, decoy: { named: 10, mismatched: 0, suspected: false } })).toBe('saved')
    expect(await env.DB.prepare('SELECT base_rows, timed_rows FROM mkvid_request_tracks').first()).toEqual({ base_rows: 10, timed_rows: 2 })
    expect(await due(env, a.setUrl)).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 7 * DAY + 5)
  })
})

describe('delete and recreate', () => {
  it('end to end: queued at the back, the old video stays until the new one is in, then it leaves the playlists and is deleted', async () => {
    const env = makeEnv({ MKVID_URL: 'https://mkvid.example/' })
    const a = await doneRequest(env)
    const other = await queue(env, 'other', { setDate: '2025-01-01' }) // pending, oldest date = last in line
    ;(listPlaylistVideoIds as ReturnType<typeof vi.fn>).mockImplementation(async () => new Set([OLD]))

    const r = await app.request(`http://x/ui/api/mkvid/recreate/${a.id}`, { method: 'POST', headers: { Origin: 'http://x', 'Content-Type': 'application/json' }, body: '{}' }, env)
    expect(await r.json()).toEqual({ ok: true, id: a.id, replacesVideoId: OLD })
    const queued = (await getMkvidRequest(env, a.id))!
    expect(queued).toMatchObject({ status: 'pending', replacesVideoId: OLD, videoId: OLD, attempts: 0 })
    // Behind everything that was waiting.
    expect((await listPendingMkvidRequests(env)).map((x) => x.id)).toEqual([other.id, a.id])
    // Twice is refused; so is a request that is not done.
    expect((await app.request(`http://x/ui/api/mkvid/recreate/${a.id}`, { method: 'POST', headers: { Origin: 'http://x', 'Content-Type': 'application/json' }, body: '{}' }, env)).status).toBe(409)
    expect((await app.request('http://x/ui/api/mkvid/recreate/nope', { method: 'POST', headers: { Origin: 'http://x', 'Content-Type': 'application/json' }, body: '{}' }, env)).status).toBe(404)
    // /now-playing still finds the (old) upload meanwhile.
    expect(await findMkvidUploadByTitle(env, 'Lilly Palmer @ set')).toMatchObject({ videoId: OLD })

    // The claim does not take the set's own old mkvid video for a real recording.
    await env.DB.prepare("UPDATE mkvid_requests SET status = 'banned' WHERE id = ?").bind(other.id).run()
    // The old video is on record from the moment Recreate was pressed.
    expect(await env.DB.prepare('SELECT state, replaced_by FROM mkvid_old_videos WHERE video_id = ?').bind(OLD).first()).toEqual({ state: 'awaiting_replacement', replaced_by: '' })
    // An mkvid that does not render scene is not handed the recreation; it stays pending, no attempt, no slot.
    expect(((await (await post(env, '/mkvid/claim', { style: 'static' })).json()) as { request: unknown }).request).toBeNull()
    expect(((await (await post(env, '/mkvid/claim', {})).json()) as { request: unknown }).request).toBeNull()
    expect(await getMkvidRequest(env, a.id)).toMatchObject({ status: 'pending', attempts: 0 })
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM mkvid_claims').first<{ n: number }>())!.n).toBe(0)
    const claim = (await (await post(env, '/mkvid/claim', { accounts: ['primary'], style: 'scene' })).json()) as { request: { id: string } }
    expect(claim.request.id).toBe(a.id)
    expect((await getMkvidRequest(env, a.id))!.status).toBe('claimed')

    const calls = stubMkvid(() => json({ ok: true, outcome: 'deleted' }))
    const done = await post(env, '/mkvid/complete', { id: a.id, videoId: NEW, videoUrl: `https://youtu.be/${NEW}`, privacy: 'unlisted', style: 'scene' })
    expect(done.status).toBe(200)
    expect(await done.json()).toMatchObject({ status: 'done', videoId: NEW, playlistStatus: 'added', replacedVideoId: OLD })
    // New in first (artist + combined), then old out of both.
    expect(addVideoToPlaylist).toHaveBeenCalledWith('PLa', NEW, 'ya29')
    expect(addVideoToPlaylist).toHaveBeenCalledWith('PLc', NEW, 'ya29')
    expect(removeVideoFromPlaylist).toHaveBeenCalledWith('PLa', OLD, 'ya29')
    expect(removeVideoFromPlaylist).toHaveBeenCalledWith('PLc', OLD, 'ya29')
    const addOrder = (addVideoToPlaylist as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
    const removeOrder = (removeVideoFromPlaylist as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
    expect(addOrder).toBeLessThan(removeOrder)

    expect(await getMkvidRequest(env, a.id)).toMatchObject({ status: 'done', videoId: NEW, style: 'scene', replacesVideoId: null })
    const tl = await env.DB.prepare('SELECT video_id, video_source FROM tracklists WHERE url = ?').bind(a.setUrl).first()
    expect(tl).toEqual({ video_id: NEW, video_source: 'mkvid' })
    // mkvid was asked to delete the old one, with its bearer and the request id.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`https://mkvid.example/api/videos/${OLD}/delete`)
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer mk-secret')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ requestId: a.id })
    const old = await env.DB.prepare('SELECT state, replaced_by, style FROM mkvid_old_videos WHERE video_id = ?').bind(OLD).first()
    expect(old).toEqual({ state: 'deleted', replaced_by: NEW, style: null })
    // Audited as a swap.
    const audit = await env.DB.prepare('SELECT record FROM playlist_additions ORDER BY id DESC LIMIT 1').first<{ record: string }>()
    expect(JSON.parse(audit!.record)).toMatchObject({ status: 'replaced', videoId: NEW, previousVideoId: OLD, via: 'mkvid', trigger: 'mkvid.recreate' })
  })

  it('a failed delete is kept, shown, and retried by the cron with a backoff; a refusal is final', async () => {
    const env = makeEnv({ MKVID_URL: 'https://mkvid.example', MKVID_ACCESS_CLIENT_ID: 'cid', MKVID_ACCESS_CLIENT_SECRET: 'csec' })
    const a = await doneRequest(env)
    await recreateMkvidRequest(env, a.id, log)
    await claimMkvidRequest(env, log)
    const calls = stubMkvid(() => json({ error: 'youtube_failed', message: 'quota' }, 502))
    const done = await post(env, '/mkvid/complete', { id: a.id, videoId: NEW, style: 'scene' })
    expect(done.status).toBe(200)
    expect((calls[0]!.init.headers as Record<string, string>)['cf-access-client-id']).toBe('cid')
    let rows = await listUndeletedOldVideos(env)
    expect(rows).toEqual([expect.objectContaining({ videoId: OLD, state: 'pending', attempts: 1, lastError: 'HTTP 502 youtube_failed: quota' })])
    expect(rows[0]!.nextTryAt).toBeGreaterThan(NOW)
    // Shown on the panel.
    expect((await panel(env)).oldVideos).toEqual([expect.objectContaining({ videoId: OLD, state: 'pending' })])
    // Not due yet: the cron leaves it.
    expect(await retryDueOldVideoDeletions(env, log)).toEqual({ tried: 0, deleted: 0 })
    await env.DB.prepare('UPDATE mkvid_old_videos SET next_try_at = 0').run()
    stubMkvid(() => json({ ok: true, outcome: 'already_gone' }))
    expect(await retryDueOldVideoDeletions(env, log)).toEqual({ tried: 1, deleted: 1 })
    expect(await listUndeletedOldVideos(env)).toEqual([])

    // A refusal (not mkvid's upload) is not retried; the panel's Retry now can reset it.
    await env.DB.prepare("UPDATE mkvid_old_videos SET state = 'pending', next_try_at = 0").run()
    stubMkvid(() => json({ error: 'unknown_video', message: 'no job uploaded this video' }, 404))
    await retryDueOldVideoDeletions(env, log)
    rows = await listUndeletedOldVideos(env)
    expect(rows[0]).toMatchObject({ state: 'refused', lastError: 'unknown_video: no job uploaded this video' })
    expect(await retryDueOldVideoDeletions(env, log)).toEqual({ tried: 0, deleted: 0 })
    stubMkvid(() => json({ ok: true, outcome: 'deleted' }))
    const retry = await app.request(`http://x/ui/api/mkvid/old-videos/${OLD}/retry`, { method: 'POST', headers: { Origin: 'http://x', 'Content-Type': 'application/json' }, body: '{}' }, env)
    expect(await retry.json()).toMatchObject({ ok: true, oldVideo: { state: 'deleted' } })
  })

  it('callMkvidDelete: unset URL, Access login pages and network errors are retryable', async () => {
    const env = makeEnv()
    expect(await callMkvidDelete(env, OLD, 'r')).toEqual({ kind: 'retry', error: 'MKVID_URL / MKVID_TOKEN not set' })
    const env2 = makeEnv({ MKVID_URL: 'https://mkvid.example' })
    const html = async () => new Response('<html>Sign in</html>', { status: 200 })
    expect((await callMkvidDelete(env2, OLD, 'r', html as unknown as typeof fetch)).kind).toBe('retry')
    const boom = async () => { throw new Error('ECONNRESET') }
    expect(await callMkvidDelete(env2, OLD, 'r', boom as unknown as typeof fetch)).toEqual({ kind: 'retry', error: 'mkvid unreachable: ECONNRESET' })
    const refused = async () => json({ error: 'request_mismatch' }, 409)
    expect((await callMkvidDelete(env2, OLD, 'r', refused as unknown as typeof fetch)).kind).toBe('refused')
    expect(deleteBackoffSeconds(1)).toBe(600)
    expect(deleteBackoffSeconds(3)).toBe(2400)
    expect(deleteBackoffSeconds(20)).toBe(6 * 3600)
    expect(await deleteOldVideo(env2, 'missing0000', log)).toBeNull()
  })

  it('a recreation whose set meanwhile got a real recording is superseded, not swapped', async () => {
    const env = makeEnv()
    const a = await doneRequest(env)
    await recreateMkvidRequest(env, a.id, log)
    await setTracklistVideo(env, 'lillypalmer', a.setUrl, { videoId: 'realVid0003', source: '1001tl' })
    expect(await claimMkvidRequest(env, log, ['primary'], 'scene')).toBeNull()
    expect(await getMkvidRequest(env, a.id)).toMatchObject({ status: 'superseded' })
  })

  it('/mkvid/complete stores the style, rejects a malformed one, and an absent one is unknown = old style', async () => {
    const env = makeEnv()
    const a = await queue(env, 'a')
    await claimMkvidRequest(env, log)
    expect((await post(env, '/mkvid/complete', { id: a.id, videoId: NEW, style: 'Not A Style!' })).status).toBe(400)
    expect((await post(env, '/mkvid/complete', { id: a.id, videoId: NEW })).status).toBe(200)
    expect((await getMkvidRequest(env, a.id))!.style).toBeNull()
    expect(isOldStyle(null)).toBe(true)
    expect(isOldStyle('static')).toBe(true)
    expect(isOldStyle('scene')).toBe(false)
  })

  it('bulk: counts every done non-scene video, confirms the count, queues them all at the back', async () => {
    const env = makeEnv()
    const x = await doneRequest(env, 'x', null)
    const y = await queue(env, 'y')
    await env.DB.prepare("UPDATE mkvid_requests SET status = 'done', video_id = 'yVid0000001', style = 'static' WHERE id = ?").bind(y.id).run()
    const z = await queue(env, 'z')
    await env.DB.prepare("UPDATE mkvid_requests SET status = 'done', video_id = 'zVid0000001', style = 'scene' WHERE id = ?").bind(z.id).run()
    const w = await queue(env, 'w', { setDate: '2020-01-01' }) // pending
    expect(await countOldStyleVideos(env)).toBe(2)
    expect((await panel(env)).oldStyleCount).toBe(2)
    expect(await (await app.request('http://x/ui/api/mkvid/recreate-old-style', {}, env)).json()).toEqual({ count: 2 })

    const act = (body: unknown) => app.request('http://x/ui/api/mkvid/recreate-old-style', { method: 'POST', headers: { Origin: 'http://x', 'content-type': 'application/json' }, body: JSON.stringify(body) }, env)
    expect((await act({})).status).toBe(400)
    const stale = await act({ expect: 1 })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ ok: false, error: 'count_changed', count: 2 })
    expect(await (await act({ expect: 2 })).json()).toEqual({ ok: true, queued: 2 })

    expect((await listPendingMkvidRequests(env)).map((r) => r.id)).toEqual([w.id, x.id, y.id])
    expect(await getMkvidRequest(env, y.id)).toMatchObject({ status: 'pending', replacesVideoId: 'yVid0000001' })
    expect(await getMkvidRequest(env, z.id)).toMatchObject({ status: 'done', replacesVideoId: null })
    expect(await countOldStyleVideos(env)).toBe(0)
  })
})

// ─── W7 review fixes ────────────────────────────────────────────────────────

describe('W7 review: daily cap from the append-only claims log (blocker 1)', () => {
  const health = async (env: Env) =>
    (await (await app.request('http://x/mkvid/health', { headers: { Authorization: 'Bearer mk-secret' } }, env)).json()) as { dailyClaims: number; verifiedLists: boolean; recreateStyle: string }

  it("recreating today's uploads gives no slot back: the claim stays capped", async () => {
    const env = makeEnv({ MKVID_DAILY_CLAIM_CAP: '2', MKVID_SHARED_DAILY_CLAIM_CAP: '0' })
    const a = await queue(env, 'a')
    await queue(env, 'b')
    for (const vid of ['vidDone0001', 'vidDone0002']) {
      const c = (await claimMkvidRequest(env, log, ['primary'], 'scene'))!
      await env.DB.prepare("UPDATE mkvid_requests SET status = 'done', video_id = ?, style = 'static' WHERE id = ?").bind(vid, c.id).run()
    }
    expect((await health(env)).dailyClaims).toBe(2)
    const bulk = await app.request('http://x/ui/api/mkvid/recreate-old-style', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, body: JSON.stringify({ expect: 2 }) }, env)
    expect(bulk.status).toBe(200)
    // Both rows are pending again, but today's two uploads still count.
    expect((await health(env)).dailyClaims).toBe(2)
    expect(await claimMkvidRequest(env, log, ['primary'], 'scene')).toBeNull()
    expect((await getMkvidRequest(env, a.id))!.status).toBe('pending')
  })

  it("a recreation's claim counts as one use; a claim given back through /mkvid/fail stops counting", async () => {
    const env = makeEnv({ MKVID_DAILY_CLAIM_CAP: '5' })
    const a = await doneRequest(env)
    await recreateMkvidRequest(env, a.id, log)
    expect((await claimMkvidRequest(env, log, ['primary'], 'scene'))!.id).toBe(a.id)
    expect((await health(env)).dailyClaims).toBe(1)
    expect(await env.DB.prepare('SELECT recreate FROM mkvid_claims WHERE request_id = ?').bind(a.id).first()).toEqual({ recreate: 1 })
    await failMkvidRequest(env, { id: a.id, error: 'unverified_tracklist: race' }, log)
    expect((await health(env)).dailyClaims).toBe(0)
  })

  it("health advertises verified lists and the recreate style (what mkvid's scene style waits for)", async () => {
    const h = await health(makeEnv())
    expect(h.verifiedLists).toBe(true)
    expect(h.recreateStyle).toBe('scene')
  })
})

describe('W7 review: the old video survives every supersede path (major 4)', () => {
  it('superseded at completion: the old mkvid video leaves the playlists and is queued for deletion; the orphan upload stays on record', async () => {
    const env = makeEnv()
    const a = await doneRequest(env)
    await recreateMkvidRequest(env, a.id, log)
    expect((await claimMkvidRequest(env, log, ['primary'], 'scene'))!.id).toBe(a.id)
    // An official recording turns up while mkvid renders; the sync has not swapped yet.
    await setTracklistVideo(env, 'lillypalmer', a.setUrl, { videoId: 'realVid0003', source: '1001tl' })
    ;(listPlaylistVideoIds as ReturnType<typeof vi.fn>).mockImplementation(async () => new Set([OLD, 'realVid0003']))
    const r = await post(env, '/mkvid/complete', { id: a.id, videoId: NEW, style: 'scene' })
    expect(await r.json()).toMatchObject({ status: 'superseded', videoId: NEW, existingVideoId: 'realVid0003' })
    expect(removeVideoFromPlaylist).toHaveBeenCalledWith('PLa', OLD, 'ya29')
    expect(await env.DB.prepare('SELECT state, replaced_by FROM mkvid_old_videos WHERE video_id = ?').bind(OLD).first()).toEqual({ state: 'pending', replaced_by: 'realVid0003' })
    expect(await getMkvidRequest(env, a.id)).toMatchObject({ status: 'superseded', videoId: NEW, replacesVideoId: null })
    expect((await listUndeletedOldVideos(env)).map((o) => o.videoId)).toEqual([OLD])
  })

  it('superseded by the sync or at claim time: the old video is queued for deletion too', async () => {
    const env = makeEnv()
    const a = await doneRequest(env)
    await recreateMkvidRequest(env, a.id, log)
    // Waiting for its replacement: not on the panel's to-delete list, and Retry cannot delete it early.
    expect(await listUndeletedOldVideos(env)).toEqual([])
    expect(await resetOldVideoDelete(env, OLD)).toBe(false)
    expect(await supersedeMkvidRequestForSet(env, a.setUrl, 'realVid0004')).toBe(true)
    expect(await env.DB.prepare('SELECT state, replaced_by FROM mkvid_old_videos WHERE video_id = ?').bind(OLD).first()).toEqual({ state: 'pending', replaced_by: 'realVid0004' })

    const env2 = makeEnv()
    const b = await doneRequest(env2)
    await recreateMkvidRequest(env2, b.id, log)
    await setTracklistVideo(env2, 'lillypalmer', b.setUrl, { videoId: 'realVid0005', source: '1001tl' })
    expect(await claimMkvidRequest(env2, log, ['primary'], 'scene')).toBeNull()
    expect(await env2.DB.prepare('SELECT state, replaced_by FROM mkvid_old_videos WHERE video_id = ?').bind(OLD).first()).toEqual({ state: 'pending', replaced_by: 'realVid0005' })
  })
})

describe('W7 review: tolerant of failure reasons tracked does not know (major 3)', () => {
  it('an unknown permanent reason goes back to pending with a backoff, no attempt used, 3 times; the 4th parks it', async () => {
    const env = makeEnv()
    const a = await queue(env, 'a')
    for (let i = 1; i <= 3; i++) {
      await env.DB.prepare("UPDATE mkvid_requests SET status = 'pending', not_before = NULL WHERE id = ?").bind(a.id).run()
      await claimMkvidRequest(env, log, ['primary'])
      const r = await failMkvidRequest(env, { id: a.id, error: 'brand_new_reason: something mkvid learned', permanent: true }, log)
      expect(r).toMatchObject({ status: 'pending' })
      const row = (await getMkvidRequest(env, a.id))!
      expect(row.attempts).toBe(0)
      expect(row.notBefore).toBeGreaterThan(NOW)
    }
    await env.DB.prepare("UPDATE mkvid_requests SET status = 'pending', not_before = NULL WHERE id = ?").bind(a.id).run()
    await claimMkvidRequest(env, log, ['primary'])
    expect(await failMkvidRequest(env, { id: a.id, error: 'brand_new_reason: again', permanent: true }, log)).toMatchObject({ status: 'failed' })
  })

  it('a reason tracked knows to be final parks the request at once', async () => {
    const env = makeEnv()
    const a = await queue(env, 'a')
    await claimMkvidRequest(env, log, ['primary'])
    expect(await failMkvidRequest(env, { id: a.id, error: 'incomplete_recording: source is 600s', permanent: true }, log)).toMatchObject({ status: 'failed' })
  })
})

describe('W7 review minors', () => {
  it('(5) more than 25 rows the fetch layer does not call verified cannot hide a verified one behind them', async () => {
    const env = makeEnv()
    for (let i = 0; i < 30; i++) {
      const r = await queue(env, `u${i}`, { setDate: '2026-06-01' })
      // The stored flag says trusted, the fetch layer says not verified.
      await env.DB.prepare('DELETE FROM set_verification WHERE url = ?').bind(r.setUrl).run()
    }
    const v = await queue(env, 'verified', { setDate: '2020-01-01' }) // last in line
    expect((await claimMkvidRequest(env, log, ['primary']))!.id).toBe(v.id)
  })

  it("(6) when the new video missed the combined playlist, the old one's delete waits 6 h", async () => {
    const env = makeEnv({ MKVID_URL: 'https://mkvid.example/' })
    const a = await doneRequest(env)
    await recreateMkvidRequest(env, a.id, log)
    await claimMkvidRequest(env, log, ['primary'], 'scene')
    ;(listPlaylistVideoIds as ReturnType<typeof vi.fn>).mockImplementation(async () => new Set([OLD]))
    ;(addVideoToPlaylist as ReturnType<typeof vi.fn>).mockImplementation(async (pl: string) => {
      if (pl === 'PLc') throw new Error('youtube playlistItems.insert 503')
    })
    const calls = stubMkvid(() => json({ ok: true, outcome: 'deleted' }))
    expect(await (await post(env, '/mkvid/complete', { id: a.id, videoId: NEW, style: 'scene' })).json()).toMatchObject({ status: 'done', replacedVideoId: OLD })
    const row = (await env.DB.prepare('SELECT state, next_try_at FROM mkvid_old_videos WHERE video_id = ?').bind(OLD).first<{ state: string; next_try_at: number }>())!
    expect(row.state).toBe('pending')
    expect(row.next_try_at).toBeGreaterThanOrEqual(NOW + 6 * 3600 - 5)
    expect(calls).toHaveLength(0) // not due: the immediate attempt after the completion is skipped too
  })

  it('(7) an old video missing from the cached listing is looked for in a fresh one before the delete is recorded', async () => {
    const env = makeEnv()
    const a = await doneRequest(env)
    await recreateMkvidRequest(env, a.id, log)
    await claimMkvidRequest(env, log, ['primary'], 'scene')
    await cachePlaylistVideoIds(env, 'PLa', new Set<string>()) // stale cache: the old video is not in it
    ;(listPlaylistVideoIds as ReturnType<typeof vi.fn>).mockImplementation(async () => new Set([OLD]))
    await post(env, '/mkvid/complete', { id: a.id, videoId: NEW, style: 'scene' })
    expect(removeVideoFromPlaylist).toHaveBeenCalledWith('PLa', OLD, 'ya29')
  })
})
