import { describe, it, expect, vi, beforeEach } from 'vitest'
import { app } from '../src/index'
import type { Env } from '../src/types'
import type { StoredTokens } from '../src/lib/google-oauth'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'
import { updateAppSettings } from '../src/lib/app-settings'
import { mkvidAccountUsage } from '../src/lib/mkvid'
import { makeLogger } from '../src/lib/log'
import {
  attachTrackJob,
  claimTrackUpload,
  maybeQueueTrackUpload,
  safeSourceUrl,
  supersedeTrackUploadsForPresave,
  trackClaimsToday,
  TRACK_PLAYLIST_KEY,
} from '../src/lib/track-uploads'

vi.mock('../src/lib/youtube-playlists', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/youtube-playlists')>('../src/lib/youtube-playlists')
  return { ...actual, findPlaylistByTitle: vi.fn(), createPlaylist: vi.fn(), listPlaylistVideoIds: vi.fn(), addVideoToPlaylist: vi.fn() }
})
vi.mock('../src/lib/web-push', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/web-push')>('../src/lib/web-push')
  return { ...actual, sendPushToAll: vi.fn() }
})
import { addVideoToPlaylist, createPlaylist, findPlaylistByTitle, listPlaylistVideoIds, PlaylistNotFoundError, YouTubeApiError } from '../src/lib/youtube-playlists'
import { sendPushToAll } from '../src/lib/web-push'

const fn = (f: unknown) => f as ReturnType<typeof vi.fn>
const log = makeLogger({ test: 'track-uploads' })
const DAY = 86_400_000

const tokens: StoredTokens = { accessToken: 'ya29', refreshToken: 'r', expiresAt: Math.floor(Date.now() / 1000) + 3600, scope: 'https://www.googleapis.com/auth/youtube', channelId: null, channelTitle: null, connectedAt: 0 }

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

const SC = 'https://api.soundcloud.com/tracks/111'
const BC = 'https://artist.bandcamp.com/track/tune'
const LINKS = [
  { source: '36', name: 'spotify', url: 'https://open.spotify.com/track/abc', playerId: null, duration: 200 },
  { source: '10', name: 'soundcloud', url: SC, playerId: '111', duration: 201 },
  { source: 'src77', name: 'bandcamp', url: BC, playerId: null, duration: null },
]

async function seedPresave(env: Env, o: { stage?: string; ageDays?: number; links?: unknown[]; trackId?: string } = {}): Promise<number> {
  const now = Date.now()
  const created = now - (o.ageDays ?? 6) * DAY
  const links = o.links ?? LINKS
  const r = await env.DB.prepare(
    `INSERT INTO presaves (track_id, track_url, artist, title, artwork_url, stage, links, link_sources, link_count, duration_seconds, source, created_at, updated_at)
     VALUES (?, ?, 'Matroda', 'Tune', 'https://img/a.jpg', ?, ?, ?, ?, 200, 'ui', ?, ?)`,
  )
    .bind(o.trackId ?? String(Math.floor(Math.random() * 1e9)), 'https://www.1001tracklists.com/track/1hf79cg5/x/index.html', o.stage ?? 'links', JSON.stringify(links), ',' + (links as { name: string }[]).map((l) => l.name).join(',') + ',', links.length, created, created)
    .run()
  return Number(r.meta.last_row_id)
}

const mk = (env: Env, path: string, body: unknown, token = 'mk-secret') =>
  app.request(`http://x${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env)
const ui = (env: Env, path: string, body?: unknown) =>
  app.request(
    `https://tracked.example${path}`,
    body === undefined ? {} : { method: 'POST', headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify(body) },
    env,
  )
const row = (env: Env, id: number) => env.DB.prepare('SELECT * FROM track_uploads WHERE id = ?').bind(id).first<Record<string, unknown>>()

beforeEach(() => {
  vi.resetAllMocks()
  fn(listPlaylistVideoIds).mockImplementation(async () => new Set<string>())
  fn(findPlaylistByTitle).mockImplementation(async () => null)
  fn(createPlaylist).mockImplementation(async (o: { title: string }) => ({ id: 'PLtrack', title: o.title }))
  fn(sendPushToAll).mockImplementation(async () => ({ configured: true, total: 1, sent: 1, failed: 0, removed: 0, results: [] }))
})

describe('source URL allowlist', () => {
  it('accepts https on the source host only, normalised', () => {
    expect(safeSourceUrl('soundcloud', SC)).toBe(SC)
    expect(safeSourceUrl('SoundCloud', 'https://SoundCloud.com/a/b')).toBe('https://soundcloud.com/a/b')
    expect(safeSourceUrl('bandcamp', BC)).toBe(BC)
    expect(safeSourceUrl('soundcloud', 'http://api.soundcloud.com/tracks/1')).toBeNull()
    expect(safeSourceUrl('soundcloud', 'javascript:alert(1)')).toBeNull()
    expect(safeSourceUrl('soundcloud', 'https://evilsoundcloud.com/x')).toBeNull()
    expect(safeSourceUrl('soundcloud', 'https://soundcloud.com.evil.io/x')).toBeNull()
    expect(safeSourceUrl('soundcloud', 'https://bandcamp.com/x')).toBeNull()
    expect(safeSourceUrl('beatport', 'https://www.beatport.com/track/-/1')).toBeNull() // unknown source name
    expect(safeSourceUrl('soundcloud', 'https://u:p@soundcloud.com/x')).toBeNull()
  })

  it('queue skips non-allowlisted, http: and javascript: URLs', async () => {
    const env = makeEnv()
    const id = await seedPresave(env, {
      links: [
        { name: 'soundcloud', url: 'http://api.soundcloud.com/tracks/1' },
        { name: 'soundcloud', url: 'javascript:alert(1)' },
        { name: 'bandcamp', url: 'https://bandcamp.evil.com/t' },
        { name: 'hearthis', url: 'https://hearthis.at/dj/tune/' },
      ],
    })
    const q = await maybeQueueTrackUpload(env, id)
    expect(q).toMatchObject({ queued: true, sourceName: 'hearthis', sourceUrl: 'https://hearthis.at/dj/tune/' })
    const only = await seedPresave(env, { links: [{ name: 'soundcloud', url: 'https://evil.example/x' }] })
    expect(await maybeQueueTrackUpload(env, only)).toEqual({ queued: false, reason: 'no_source' })
  })

  it('a stored row whose URL is not allowed is failed at claim, never handed out', async () => {
    const env = makeEnv()
    const id = await seedPresave(env)
    const q = await maybeQueueTrackUpload(env, id)
    await env.DB.prepare('UPDATE track_uploads SET source_url = ? WHERE id = ?').bind('https://evil.example/x', q.uploadId!).run()
    expect((await claimTrackUpload(env, log)).request).toBeNull()
    expect((await row(env, q.uploadId!))!.status).toBe('failed')
  })

  it('ban-url refuses a URL that is not https on an allowed host', async () => {
    const env = makeEnv()
    expect((await ui(env, '/ui/api/track-uploads/ban-url', { url: 'javascript:alert(1)' })).status).toBe(400)
    expect((await ui(env, '/ui/api/track-uploads/ban-url', { url: 'http://soundcloud.com/x' })).status).toBe(400)
    const ok = await ui(env, '/ui/api/track-uploads/ban-url', { url: 'https://SOUNDCLOUD.com/x', reason: 'preview' })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ banned: true, url: 'https://soundcloud.com/x' })
  })
})

describe('maybeQueueTrackUpload', () => {
  it('eligibility matrix', async () => {
    const env = makeEnv()
    expect(await maybeQueueTrackUpload(env, 999)).toEqual({ queued: false, reason: 'not_found' })
    expect((await maybeQueueTrackUpload(env, await seedPresave(env, { stage: 'found' }))).reason).toBe('stage')
    expect((await maybeQueueTrackUpload(env, await seedPresave(env, { stage: 'identify' }))).reason).toBe('stage')
    expect((await maybeQueueTrackUpload(env, await seedPresave(env, { ageDays: 4 }))).reason).toBe('too_new')
    expect((await maybeQueueTrackUpload(env, await seedPresave(env, { links: [...LINKS, { name: 'youtube', url: 'https://www.youtube.com/watch?v=abcdefghijk' }] }))).reason).toBe('has_youtube')
    expect((await maybeQueueTrackUpload(env, await seedPresave(env, { links: [LINKS[0]] }))).reason).toBe('no_source')

    const id = await seedPresave(env)
    const q = await maybeQueueTrackUpload(env, { id })
    expect(q).toMatchObject({ queued: true, reason: 'queued', sourceName: 'soundcloud', sourceUrl: SC })
    expect(await row(env, q.uploadId!)).toMatchObject({ status: 'pending', presave_id: id, expected_duration_seconds: 201, artist: 'Matroda', title: 'Tune' })
    // One live request per presave.
    expect((await maybeQueueTrackUpload(env, id)).reason).toBe('already_live')

    // A banned source is passed over for the next allowed one (allowedSources order).
    const id2 = await seedPresave(env)
    await env.DB.prepare('INSERT INTO track_upload_bans (url, banned_at) VALUES (?, 1)').bind(SC).run()
    expect(await maybeQueueTrackUpload(env, id2)).toMatchObject({ queued: true, sourceName: 'bandcamp', sourceUrl: BC })

    await updateAppSettings(env, { trackUploads: { enabled: false } })
    expect((await maybeQueueTrackUpload(env, await seedPresave(env))).reason).toBe('disabled')
    await updateAppSettings(env, { trackUploads: { enabled: true, minWatchDays: 0 } })
    expect((await maybeQueueTrackUpload(env, await seedPresave(env, { ageDays: 0 }))).queued).toBe(true)
  })

  it('never throws (no DB)', async () => {
    expect(await maybeQueueTrackUpload({ SUBS: fakeKV() } as unknown as Env, 1)).toEqual({ queued: false, reason: 'error' })
  })

  it('supersedeTrackUploadsForPresave moves live requests only', async () => {
    const env = makeEnv()
    const id = await seedPresave(env)
    const q = await maybeQueueTrackUpload(env, id)
    expect(await supersedeTrackUploadsForPresave(env, id, '1001tracklists has abcdefghijk')).toBe(1)
    expect(await row(env, q.uploadId!)).toMatchObject({ status: 'superseded', error: '1001tracklists has abcdefghijk' })
    expect(await supersedeTrackUploadsForPresave(env, id, 'again')).toBe(0)
  })
})

describe('/mkvid/track routes', () => {
  it('is gated by MKVID_TOKEN', async () => {
    const env = makeEnv()
    expect((await mk(env, '/mkvid/track/claim', {}, 'tasker')).status).toBe(401)
    expect((await mk(env, '/mkvid/track/claim', {})).status).toBe(200)
    expect((await mk(makeEnv({ MKVID_TOKEN: undefined }), '/mkvid/track/claim', {})).status).toBe(500)
  })

  it('health says trackUploads: true', async () => {
    const r = await app.request('http://x/mkvid/health', { headers: { Authorization: 'Bearer mk-secret' } }, makeEnv())
    expect(await r.json()).toMatchObject({ trackUploads: true })
  })

  it('claim hands out the TrackRequest and logs a track: claim shared with the per-project count', async () => {
    const env = makeEnv()
    const id = await seedPresave(env)
    const q = await maybeQueueTrackUpload(env, id)
    const res = await mk(env, '/mkvid/track/claim', { accounts: ['primary', 'shared'] })
    const { request } = (await res.json()) as { request: Record<string, unknown> }
    expect(request).toEqual({
      id: q.uploadId,
      presaveId: id,
      artist: 'Matroda',
      title: 'Tune',
      artworkUrl: 'https://img/a.jpg',
      trackUrl: 'https://www.1001tracklists.com/track/1hf79cg5/x/index.html',
      sourceName: 'soundcloud',
      sourceUrl: SC,
      expectedDurationSeconds: 201,
      minDurationRatio: 0.85,
      privacy: 'unlisted',
      account: 'primary',
      attempts: 1,
    })
    expect(await env.DB.prepare('SELECT request_id, account FROM mkvid_claims').all()).toMatchObject({ results: [{ request_id: `track:${q.uploadId}`, account: 'primary' }] })
    expect((await mkvidAccountUsage(env)).find((u) => u.account === 'primary')!.used).toBe(1)
    expect(await trackClaimsToday(env)).toBe(1)
    // Nothing else claimable.
    expect(await (await mk(env, '/mkvid/track/claim', {})).json()).toEqual({ request: null })
  })

  it('respects trackUploads.dailyCap and the per-project caps (set claims count too); a fail refunds', async () => {
    const env = makeEnv()
    await updateAppSettings(env, { trackUploads: { dailyCap: 1 }, mkvid: { dailyClaimCap: 2, sharedDailyClaimCap: 0 } })
    const a = await maybeQueueTrackUpload(env, await seedPresave(env))
    const b = await maybeQueueTrackUpload(env, await seedPresave(env))
    const c1 = await claimTrackUpload(env, log, ['primary'])
    expect(c1.request?.id).toBe(a.uploadId)
    expect(await claimTrackUpload(env, log, ['primary'])).toEqual({ request: null, outcome: 'capped' })
    // The fail refunds the claim: the track cap has room again.
    const f = await mk(env, '/mkvid/track/fail', { id: a.uploadId, error: 'yt-dlp: HTTP Error 500' })
    expect(await f.json()).toMatchObject({ status: 'pending', attempts: 1 })
    expect(await trackClaimsToday(env)).toBe(0)
    expect((await env.DB.prepare('SELECT refunded_at FROM mkvid_claims').first<{ refunded_at: number | null }>())!.refunded_at).not.toBeNull()
    // Per-project cap: two set claims fill the primary (cap 2), the shared one has cap 0.
    const now = Math.floor(Date.now() / 1000)
    await env.DB.prepare("INSERT INTO mkvid_claims (request_id, account, claimed_at) VALUES ('set-1', 'primary', ?), ('set-2', 'primary', ?)").bind(now, now).run()
    expect(await claimTrackUpload(env, log, ['primary', 'shared'])).toEqual({ request: null, outcome: 'capped' })
    await updateAppSettings(env, { mkvid: { sharedDailyClaimCap: 1 } })
    const c2 = await claimTrackUpload(env, log, ['primary', 'shared'])
    expect(c2.request).toMatchObject({ id: b.uploadId, account: 'shared' })
    await updateAppSettings(env, { trackUploads: { dailyCap: 0 } })
    expect((await claimTrackUpload(env, log)).outcome).toBe('paused')
  })

  it('"Rip and upload now" queues a pre-save inside its watch period; refuses one with nothing to rip, and an unknown one', async () => {
    const env = makeEnv()
    const id = await seedPresave(env, { ageDays: 0 })
    expect((await maybeQueueTrackUpload(env, id)).reason).toBe('too_new')
    const r = await ui(env, '/ui/api/track-uploads/rip-now', { presaveId: id })
    expect(r.status).toBe(200)
    const d = (await r.json()) as { ok: boolean; queued: boolean; uploadId: number; sourceName: string }
    expect(d).toMatchObject({ ok: true, queued: true, sourceName: 'soundcloud' })
    expect((await row(env, d.uploadId))!.status).toBe('pending')
    // Pressed again: already queued, still ok.
    expect(await (await ui(env, '/ui/api/track-uploads/rip-now', { presaveId: id })).json()).toMatchObject({ ok: true, queued: false, reason: 'already_live' })
    const none = await seedPresave(env, { ageDays: 0, links: [{ source: '36', name: 'spotify', url: 'https://open.spotify.com/track/x', playerId: 'x', duration: 200 }] })
    const n = await ui(env, '/ui/api/track-uploads/rip-now', { presaveId: none })
    expect(n.status).toBe(409)
    expect(await n.json()).toMatchObject({ error: 'no_source' })
    expect((await ui(env, '/ui/api/track-uploads/rip-now', { presaveId: 99999 })).status).toBe(404)
    expect((await ui(env, '/ui/api/track-uploads/rip-now', {})).status).toBe(400)
  })

  it('a claim past the TTL is handed out again; /job renews it', async () => {
    const env = makeEnv()
    const q = await maybeQueueTrackUpload(env, await seedPresave(env))
    expect((await claimTrackUpload(env, log)).request?.attempts).toBe(1)
    expect((await claimTrackUpload(env, log)).request).toBeNull()
    const old = Math.floor(Date.now() / 1000) - 4 * 3600
    await env.DB.prepare('UPDATE track_uploads SET claimed_at = ? WHERE id = ?').bind(old, q.uploadId!).run()
    // /job renews the claim, so it is not handed out.
    expect((await mk(env, '/mkvid/track/job', { id: q.uploadId, jobId: 'j1' })).status).toBe(200)
    expect((await claimTrackUpload(env, log)).request).toBeNull()
    expect(await attachTrackJob(env, q.uploadId!, 'other-job')).toBe(false)
    await env.DB.prepare('UPDATE track_uploads SET claimed_at = ? WHERE id = ?').bind(old, q.uploadId!).run()
    const again = await claimTrackUpload(env, log)
    expect(again.request).toMatchObject({ id: q.uploadId, attempts: 2 })
  })

  it('a claim of a presave that got a YouTube link meanwhile supersedes it', async () => {
    const env = makeEnv()
    const id = await seedPresave(env)
    const q = await maybeQueueTrackUpload(env, id)
    await env.DB.prepare("UPDATE presaves SET stage = 'found' WHERE id = ?").bind(id).run()
    expect((await claimTrackUpload(env, log)).request).toBeNull()
    expect((await row(env, q.uploadId!))!.status).toBe('superseded')
  })

  it('complete → playlist created by title, request done, presave uploaded with a check row, push', async () => {
    const env = makeEnv()
    const id = await seedPresave(env)
    const q = await maybeQueueTrackUpload(env, id)
    await claimTrackUpload(env, log)
    const res = await mk(env, '/mkvid/track/complete', { id: q.uploadId, videoId: 'vid12345678', privacy: 'unlisted', jobId: 'j1' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'done', videoId: 'vid12345678', presaveId: id, playlistId: 'PLtrack', playlistStatus: 'added', notified: true })
    expect(findPlaylistByTitle).toHaveBeenCalledWith('Track uploads', 'ya29')
    expect(fn(createPlaylist).mock.calls[0]![0]).toMatchObject({ title: 'Track uploads', privacyStatus: 'public' })
    expect(addVideoToPlaylist).toHaveBeenCalledWith('PLtrack', 'vid12345678', 'ya29')
    expect(JSON.parse((await env.SUBS.get(TRACK_PLAYLIST_KEY))!)).toEqual({ playlistId: 'PLtrack', title: 'Track uploads' })
    expect(await row(env, q.uploadId!)).toMatchObject({ status: 'done', video_id: 'vid12345678', playlist_status: 'added', job_id: 'j1' })
    expect((await row(env, q.uploadId!))!.notified_at).not.toBeNull()
    expect(await env.DB.prepare('SELECT stage, youtube_video_id, next_check_at FROM presaves WHERE id = ?').bind(id).first()).toEqual({ stage: 'uploaded', youtube_video_id: 'vid12345678', next_check_at: null })
    expect(await env.DB.prepare('SELECT trigger, result, stage_after, youtube_video_id FROM presave_checks WHERE presave_id = ?').bind(id).first()).toEqual({ trigger: 'upload', result: 'uploaded', stage_after: 'uploaded', youtube_video_id: 'vid12345678' })
    const payload = fn(sendPushToAll).mock.calls[0]![1]
    expect(payload).toMatchObject({ kind: 'track_uploaded', title: 'Track ripped and uploaded', body: 'Matroda – Tune (from soundcloud) is now in "Track uploads"', url: 'https://music.youtube.com/watch?v=vid12345678' })
    // Again: 409.
    const again = await mk(env, '/mkvid/track/complete', { id: q.uploadId, videoId: 'vid12345678' })
    expect(again.status).toBe(409)
    expect((await mk(env, '/mkvid/track/complete', { id: 9999, videoId: 'vid12345678' })).status).toBe(404)
    expect((await mk(env, '/mkvid/track/complete', { id: 'not-a-number', videoId: 'vid12345678' })).status).toBe(400)
  })

  it("complete fills a nameless pre-save (saved by id alone) with mkvid's names and artwork, never overwrites, and refuses nothing", async () => {
    const env = makeEnv()
    const id = await seedPresave(env)
    await env.DB.prepare('UPDATE presaves SET artist = NULL, title = NULL, artwork_url = NULL WHERE id = ?').bind(id).run()
    const q = await maybeQueueTrackUpload(env, id)
    await env.DB.prepare('UPDATE track_uploads SET artist = NULL, title = NULL, artwork_url = NULL WHERE id = ?').bind(q.uploadId!).run()
    await claimTrackUpload(env, log)
    const res = await mk(env, '/mkvid/track/complete', { id: q.uploadId, videoId: 'vid12345678', artist: ' Beltran ', title: "Smack Yo' (Danny Avila Remix)", artworkUrl: 'https://i1.sndcdn.com/a-original.png' })
    expect(res.status).toBe(200)
    expect(await env.DB.prepare('SELECT artist, title, artwork_url FROM presaves WHERE id = ?').bind(id).first()).toEqual({ artist: 'Beltran', title: "Smack Yo' (Danny Avila Remix)", artwork_url: 'https://i1.sndcdn.com/a-original.png' })
    expect(await row(env, q.uploadId!)).toMatchObject({ artist: 'Beltran', title: "Smack Yo' (Danny Avila Remix)", artwork_url: 'https://i1.sndcdn.com/a-original.png' })
    expect(fn(sendPushToAll).mock.calls[0]![1]).toMatchObject({ body: expect.stringContaining("Beltran – Smack Yo' (Danny Avila Remix)") })

    // A named pre-save keeps its names; a bad artwork URL is dropped, not a 400.
    const id2 = await seedPresave(env)
    const q2 = await maybeQueueTrackUpload(env, id2)
    await claimTrackUpload(env, log)
    const r2 = await mk(env, '/mkvid/track/complete', { id: q2.uploadId, videoId: 'vid22345678', artist: 'Other', title: 'Name', artworkUrl: 'javascript:alert(1)' })
    expect(r2.status).toBe(200)
    expect(await env.DB.prepare('SELECT artist, title, artwork_url FROM presaves WHERE id = ?').bind(id2).first()).toEqual({ artist: 'Matroda', title: 'Tune', artwork_url: 'https://img/a.jpg' })
  })

  it('complete recreates a playlist deleted on YouTube, and no push when notifyUploaded is off', async () => {
    const env = makeEnv()
    await updateAppSettings(env, { trackUploads: { notifyUploaded: false } })
    await env.SUBS.put(TRACK_PLAYLIST_KEY, JSON.stringify({ playlistId: 'PLgone', title: 'Track uploads' }))
    fn(listPlaylistVideoIds).mockImplementation(async (pl: string) => {
      if (pl === 'PLgone') throw new PlaylistNotFoundError('playlistItems.list', pl)
      return new Set<string>()
    })
    const q = await maybeQueueTrackUpload(env, await seedPresave(env))
    await claimTrackUpload(env, log)
    const r = await (await mk(env, '/mkvid/track/complete', { id: q.uploadId, videoId: 'vid12345678' })).json()
    expect(r).toMatchObject({ status: 'done', playlistId: 'PLtrack', playlistStatus: 'added', notified: false })
    expect(sendPushToAll).not.toHaveBeenCalled()
    expect(JSON.parse((await env.SUBS.get(TRACK_PLAYLIST_KEY))!).playlistId).toBe('PLtrack')
  })

  it('a quota error leaves the request done with playlist failed; Retry re-runs only the insert', async () => {
    const env = makeEnv()
    const q = await maybeQueueTrackUpload(env, await seedPresave(env))
    await claimTrackUpload(env, log)
    fn(addVideoToPlaylist).mockImplementationOnce(async () => {
      throw new YouTubeApiError('playlistItems.insert', 403, 'quotaExceeded', '{}')
    })
    const r = await (await mk(env, '/mkvid/track/complete', { id: q.uploadId, videoId: 'vid12345678' })).json()
    expect(r).toMatchObject({ status: 'done', playlistStatus: 'failed' })
    expect(String((await row(env, q.uploadId!))!.error)).toMatch(/quota/)
    const retry = await ui(env, `/ui/api/track-uploads/${q.uploadId}/retry`, {})
    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({ ok: true, playlistRetried: true, upload: { status: 'done', playlistStatus: 'added', error: null } })
  })

  it('complete after 1001tl found a YouTube link records the video as superseded, no insert, no push', async () => {
    const env = makeEnv()
    const id = await seedPresave(env)
    const q = await maybeQueueTrackUpload(env, id)
    await claimTrackUpload(env, log)
    await env.DB.prepare("UPDATE presaves SET stage = 'found' WHERE id = ?").bind(id).run()
    const r = await (await mk(env, '/mkvid/track/complete', { id: q.uploadId, videoId: 'vid12345678' })).json()
    expect(r).toMatchObject({ status: 'superseded', videoId: 'vid12345678' })
    expect(addVideoToPlaylist).not.toHaveBeenCalled()
    expect(sendPushToAll).not.toHaveBeenCalled()
    expect(await row(env, q.uploadId!)).toMatchObject({ status: 'superseded', video_id: 'vid12345678' })
    expect((await env.DB.prepare('SELECT stage FROM presaves WHERE id = ?').bind(id).first())!.stage).toBe('found')
  })

  it('fail: backoff × attempts, failed after maxAttempts, permanent fails at once and queues the next source', async () => {
    const env = makeEnv()
    const id = await seedPresave(env)
    const q = await maybeQueueTrackUpload(env, id)
    await claimTrackUpload(env, log)
    const t0 = Math.floor(Date.now() / 1000)
    const f1 = (await (await mk(env, '/mkvid/track/fail', { id: q.uploadId, error: 'network' })).json()) as { status: string; notBefore: number }
    expect(f1.status).toBe('pending')
    expect(f1.notBefore / 1000).toBeGreaterThanOrEqual(t0 + 6 * 3600)
    // Not claimable until the backoff is over.
    expect((await claimTrackUpload(env, log)).request).toBeNull()
    await env.DB.prepare('UPDATE track_uploads SET not_before = 1 WHERE id = ?').bind(q.uploadId!).run()
    await claimTrackUpload(env, log)
    const f2 = (await (await mk(env, '/mkvid/track/fail', { id: q.uploadId, error: 'network' })).json()) as { status: string; notBefore: number }
    expect(f2.status).toBe('pending')
    expect(f2.notBefore / 1000).toBeGreaterThanOrEqual(t0 + 12 * 3600)
    await env.DB.prepare('UPDATE track_uploads SET not_before = 1 WHERE id = ?').bind(q.uploadId!).run()
    await claimTrackUpload(env, log)
    const f3 = await (await mk(env, '/mkvid/track/fail', { id: q.uploadId, error: 'network' })).json()
    expect(f3).toMatchObject({ status: 'failed', attempts: 3 })
    // The failed source is not retried: the next allowed source (bandcamp) was queued.
    const next = await env.DB.prepare("SELECT source_name, status FROM track_uploads WHERE presave_id = ? AND status = 'pending'").bind(id).first()
    expect(next).toEqual({ source_name: 'bandcamp', status: 'pending' })

    // Permanent: straight to failed.
    const id2 = await seedPresave(env, { links: [LINKS[1]] })
    const q2 = await maybeQueueTrackUpload(env, id2)
    await env.DB.prepare('UPDATE track_uploads SET created_at = 0 WHERE id = ?').bind(q2.uploadId!).run()
    expect((await claimTrackUpload(env, log)).request?.id).toBe(q2.uploadId)
    expect(await (await mk(env, '/mkvid/track/fail', { id: q2.uploadId, error: 'preview_clip: 30 s of 201 s', permanent: true })).json()).toMatchObject({ status: 'failed', attempts: 1 })
    expect((await mk(env, '/mkvid/track/fail', { id: 4242, error: 'x' })).status).toBe(404)
  })
})

describe('/ui/api/track-uploads', () => {
  it('lists as a data table with counts and today', async () => {
    const env = makeEnv()
    const a = await maybeQueueTrackUpload(env, await seedPresave(env))
    await maybeQueueTrackUpload(env, await seedPresave(env, { links: [LINKS[2]] }))
    await env.DB.prepare('UPDATE track_uploads SET created_at = created_at - 10 WHERE id = ?').bind(a.uploadId!).run()
    await claimTrackUpload(env, log)
    const r = await ui(env, '/ui/api/track-uploads?size=10')
    expect(r.status).toBe(200)
    const j = (await r.json()) as { rows: { id: number; status: string; createdAt: number; sourceBanned: boolean }[]; total: number; counts: Record<string, number>; today: { claims: number; cap: number } }
    expect(j.total).toBe(2)
    expect(j.counts).toMatchObject({ pending: 1, claimed: 1, done: 0 })
    expect(j.today).toEqual({ claims: 1, cap: 4 })
    expect(j.rows[0]!.createdAt).toBeGreaterThan(j.rows[1]!.createdAt) // -createdAt, ms
    expect(j.rows[1]!.createdAt % 1000).toBe(0)
    const f = (await (await ui(env, '/ui/api/track-uploads?f.status=in:claimed&f.sourceName=in:soundcloud')).json()) as { rows: { id: number }[] }
    expect(f.rows.map((x) => x.id)).toEqual([a.uploadId])
    expect((await ui(env, '/ui/api/track-uploads?f.status=in:bogus')).status).toBe(400)
  })

  it('ban-link bans the URL, marks it banned, queues the next source; bans list / unban', async () => {
    const env = makeEnv()
    const id = await seedPresave(env)
    const q = await maybeQueueTrackUpload(env, id)
    await claimTrackUpload(env, log)
    const r = await ui(env, `/ui/api/track-uploads/${q.uploadId}/ban-link`, { reason: 'a 30 s preview' })
    expect(r.status).toBe(200)
    const j = (await r.json()) as { upload: { status: string; sourceBanned: boolean }; next: { queued: boolean; sourceName: string }; affected: number[] }
    expect(j.upload).toMatchObject({ status: 'banned', sourceBanned: true })
    expect(j.next).toMatchObject({ queued: true, sourceName: 'bandcamp' })
    expect(j.affected).toEqual([q.uploadId])
    // The claim was given back.
    expect(await trackClaimsToday(env)).toBe(0)
    // mkvid finishing the banned job: recorded, kept out of the playlist.
    expect(await (await mk(env, '/mkvid/track/complete', { id: q.uploadId, videoId: 'vid12345678' })).json()).toEqual({ status: 'banned', videoId: 'vid12345678' })
    expect(addVideoToPlaylist).not.toHaveBeenCalled()

    const bans = (await (await ui(env, '/ui/api/track-uploads/bans')).json()) as { rows: { url: string; sourceName: string; reason: string; bannedAt: number }[]; total: number }
    expect(bans.total).toBe(1)
    expect(bans.rows[0]).toMatchObject({ url: SC, sourceName: 'soundcloud', reason: 'a 30 s preview' })
    expect((await ui(env, `/ui/api/track-uploads/${q.uploadId}/retry`, {})).status).toBe(409) // banned source
    expect(await (await ui(env, '/ui/api/track-uploads/bans/unban', { url: SC })).json()).toEqual({ unbanned: true })
    expect((await (await ui(env, '/ui/api/track-uploads/bans')).json() as { total: number }).total).toBe(0)
    expect((await ui(env, '/ui/api/track-uploads/999/ban-link', {})).status).toBe(404)
  })

  it('retry: a failed request goes back to pending unless another is live', async () => {
    const env = makeEnv()
    const id = await seedPresave(env, { links: [LINKS[1]] })
    const q = await maybeQueueTrackUpload(env, id)
    await env.DB.prepare("UPDATE track_uploads SET status = 'failed', attempts = 3 WHERE id = ?").bind(q.uploadId!).run()
    const r = await ui(env, `/ui/api/track-uploads/${q.uploadId}/retry`, {})
    expect(await r.json()).toMatchObject({ ok: true, upload: { status: 'pending', attempts: 0 } })
    expect((await ui(env, `/ui/api/track-uploads/${q.uploadId}/retry`, {})).status).toBe(409)
  })

  it('playlist info never creates', async () => {
    const env = makeEnv()
    expect(await (await ui(env, '/ui/api/track-uploads/playlist')).json()).toEqual({ playlistId: null, title: 'Track uploads', url: null })
    await env.SUBS.put(TRACK_PLAYLIST_KEY, JSON.stringify({ playlistId: 'PLx', title: 'Track uploads' }))
    expect(await (await ui(env, '/ui/api/track-uploads/playlist')).json()).toEqual({ playlistId: 'PLx', title: 'Track uploads', url: 'https://www.youtube.com/playlist?list=PLx' })
    expect(findPlaylistByTitle).not.toHaveBeenCalled()
  })

  it('is behind Access', async () => {
    const env = makeEnv({ DEV_BYPASS_CF_ACCESS: undefined, CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CF_ACCESS_AUD: 'aud', CF_ACCESS_ALLOWED_EMAILS: 'o@example.com' } as Partial<Env>)
    expect((await ui(env, '/ui/api/track-uploads')).status).toBe(401)
    expect((await ui(env, '/ui/api/track-uploads/1/retry', {})).status).toBe(401)
  })
})

describe('review fixes', () => {
  it('never queues a presave that already has a done upload (even when its stage says links)', async () => {
    const env = makeEnv()
    const id = await seedPresave(env)
    const q = await maybeQueueTrackUpload(env, id)
    await claimTrackUpload(env, log)
    expect((await mk(env, '/mkvid/track/complete', { id: q.uploadId, videoId: 'vid12345678' })).status).toBe(200)
    // A slow links check used to write the stage back to links: the done upload still blocks a second one.
    await env.DB.prepare("UPDATE presaves SET stage = 'links' WHERE id = ?").bind(id).run()
    expect(await maybeQueueTrackUpload(env, id)).toEqual({ queued: false, reason: 'already_uploaded', uploadId: q.uploadId })
  })

  it('/fail cuts an error over 2000 characters instead of answering 400 (mkvid would resend it forever)', async () => {
    const env = makeEnv()
    const q = await maybeQueueTrackUpload(env, await seedPresave(env))
    await claimTrackUpload(env, log)
    const res = await mk(env, '/mkvid/track/fail', { id: q.uploadId, error: `ffmpeg exit 1: ${'x'.repeat(2500)}` })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'pending' })
    expect(String((await row(env, q.uploadId!))!.error).length).toBeLessThanOrEqual(500)
  })

  it('the set queue /mkvid/fail cuts a long error too', async () => {
    const env = makeEnv()
    const res = await mk(env, '/mkvid/fail', { id: '00000000-0000-4000-8000-000000000000', error: 'e'.repeat(2500) })
    expect(res.status).not.toBe(400)
  })

  it('complete / fail from a job other than the one holding the claim: 409 invalid_state, nothing changes', async () => {
    const env = makeEnv()
    const id = await seedPresave(env)
    const q = await maybeQueueTrackUpload(env, id)
    await claimTrackUpload(env, log)
    expect((await mk(env, '/mkvid/track/job', { id: q.uploadId, jobId: 'new-job' })).status).toBe(200)
    const c = await mk(env, '/mkvid/track/complete', { id: q.uploadId, videoId: 'vid12345678', jobId: 'old-job' })
    expect(c.status).toBe(409)
    expect(await c.json()).toEqual({ error: 'invalid_state', current: 'claimed' })
    const f = await mk(env, '/mkvid/track/fail', { id: q.uploadId, error: 'boom', jobId: 'old-job' })
    expect(f.status).toBe(409)
    expect(await row(env, q.uploadId!)).toMatchObject({ status: 'claimed', job_id: 'new-job', video_id: null })
    expect((await env.DB.prepare('SELECT stage FROM presaves WHERE id = ?').bind(id).first())!.stage).toBe('links')
    // The right job still completes.
    expect((await mk(env, '/mkvid/track/complete', { id: q.uploadId, videoId: 'vid12345678', jobId: 'new-job' })).status).toBe(200)
  })

  it('/job answers 409 when nothing was renewed, 404 for an unknown id', async () => {
    const env = makeEnv()
    const q = await maybeQueueTrackUpload(env, await seedPresave(env))
    expect((await mk(env, '/mkvid/track/job', { id: q.uploadId, jobId: 'j1' })).status).toBe(409) // still pending
    await claimTrackUpload(env, log)
    expect((await mk(env, '/mkvid/track/job', { id: q.uploadId, jobId: 'j1' })).status).toBe(200)
    const other = await mk(env, '/mkvid/track/job', { id: q.uploadId, jobId: 'j2' })
    expect(other.status).toBe(409)
    expect(await other.json()).toEqual({ error: 'invalid_state', current: 'claimed' })
    expect((await mk(env, '/mkvid/track/job', { id: 4242, jobId: 'j1' })).status).toBe(404)
  })

  it('a stale claim handed out again refunds the earlier claim, so it counts once against the caps', async () => {
    const env = makeEnv()
    const q = await maybeQueueTrackUpload(env, await seedPresave(env))
    await claimTrackUpload(env, log)
    expect(await trackClaimsToday(env)).toBe(1)
    await env.DB.prepare('UPDATE track_uploads SET claimed_at = ? WHERE id = ?').bind(Math.floor(Date.now() / 1000) - 4 * 3600, q.uploadId!).run()
    expect((await claimTrackUpload(env, log)).request).toMatchObject({ id: q.uploadId, attempts: 2 })
    expect(await trackClaimsToday(env)).toBe(1)
    expect((await mkvidAccountUsage(env)).find((u) => u.account === 'primary')!.used).toBe(1)
    const claims = (await env.DB.prepare('SELECT refunded_at FROM mkvid_claims ORDER BY id').all<{ refunded_at: number | null }>()).results
    expect(claims.map((r) => r.refunded_at !== null)).toEqual([true, false])
  })
})
