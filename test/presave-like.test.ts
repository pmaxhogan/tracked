/**
 * Likes for pre-saved tracks (lib/presave-like.ts): the hook on each of the
 * three ways a pre-save gets its video, that a like is made once, what a
 * failed like leaves behind and when it is retried, and the backfill's
 * selection, dry run and live page. tlpool and YouTube are a stubbed global
 * fetch; D1 and KV are the in-memory fakes with the real migrations.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'
import type { Env } from '../src/types'
import { addPresave, dismissPresave, getPresaveRow, markPresaveUploaded, presaveOut, recheckPresave, runScheduledPresave } from '../src/lib/presave'
import { backfillPresaveLikes, likeFailKind, likePresaveVideo, likeRetryAt, retryDuePresaveLikes } from '../src/lib/presave-like'
import { YouTubeApiError } from '../src/lib/youtube-playlists'
import { quotaDayEnd } from '../src/lib/mkvid'
import { DEFAULT_APP_SETTINGS, updateAppSettings } from '../src/lib/app-settings'
import { makeLogger } from '../src/lib/log'
import { app } from '../src/index'

const here = dirname(fileURLToPath(import.meta.url))
const POOL = 'https://tlpool.example'
const ML_FOUND = readFileSync(resolve(here, 'fixtures', 'medialink-909720.json'), 'utf8')
const ML_NO_YT = JSON.stringify({ ...JSON.parse(ML_FOUND), more: [] })
const VIDEO = 'h8CtvP1rEy8'
const NOW = Date.UTC(2026, 9, 11, 18, 0, 0)
const log = makeLogger({ test: 'presave-like' })

async function makeEnv(opts: { connected?: boolean } = {}): Promise<Env> {
  const env = { CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k', TLPOOL_URL: POOL, TLPOOL_TOKEN: 'pt', DEV_BYPASS_CF_ACCESS: '1' } as unknown as Env
  if (opts.connected !== false) {
    await env.SUBS.put('oauth:google', JSON.stringify({ accessToken: 'tok', refreshToken: 'r', expiresAt: Math.floor(Date.now() / 1000) + 3600, scope: 'https://www.googleapis.com/auth/youtube', channelId: null, channelTitle: null, connectedAt: 0 }))
  }
  return env
}

const ytError = (status: number, reason: string) => new Response(JSON.stringify({ error: { code: status, errors: [{ reason }] } }), { status, headers: { 'Content-Type': 'application/json' } })

type Yt = { rate: string[]; getRating: string[][] }
/**
 * tlpool answers every lookup with `medialink()`; YouTube's videos.rate with
 * `rate(videoId)` (default 204) and videos.getRating with `ratings`.
 */
function stub(o: { medialink?: () => string; rate?: (id: string) => Response; ratings?: Record<string, string> | (() => Response) } = {}): Yt {
  const yt: Yt = { rate: [], getRating: [] }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `${POOL}/fetch`) {
        const body = JSON.parse(String(init!.body)) as { url: string }
        const html = (o.medialink ?? (() => ML_FOUND))()
        return Response.json({ status: 200, finalUrl: body.url, html, accountId: 'acct-1', exitLabel: 'exit-a', fetchedAt: new Date().toISOString(), bytes: html.length })
      }
      const u = new URL(url)
      if (u.pathname === '/youtube/v3/videos/rate') {
        expect(init?.method).toBe('POST')
        expect(u.searchParams.get('rating')).toBe('like')
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer tok')
        const id = u.searchParams.get('id')!
        yt.rate.push(id)
        return o.rate ? o.rate(id) : new Response(null, { status: 204 })
      }
      if (u.pathname === '/youtube/v3/videos/getRating') {
        const ids = u.searchParams.get('id')!.split(',')
        yt.getRating.push(ids)
        if (typeof o.ratings === 'function') return o.ratings()
        const r = o.ratings ?? {}
        return Response.json({ items: ids.filter((id) => r[id]).map((id) => ({ videoId: id, rating: r[id] })) })
      }
      throw new Error(`unexpected fetch ${url}`)
    }),
  )
  return yt
}

/** A pre-save that already has its video, as one resolved before the likes existed. */
async function seedResolved(env: Env, trackId: string, videoId: string, stage: 'found' | 'uploaded' | 'dismissed' = 'found'): Promise<number> {
  const r = await env.DB.prepare("INSERT INTO presaves (track_id, artist, title, stage, youtube_video_id, created_at, updated_at) VALUES (?, 'A', ?, ?, ?, 1, 1)").bind(trackId, `T${trackId}`, stage, videoId).run()
  return Number(r.meta.last_row_id)
}
const likeCols = async (env: Env, id: number) => (await env.DB.prepare('SELECT liked_at, like_attempts, like_error, like_next_at FROM presaves WHERE id = ?').bind(id).first<Record<string, unknown>>())!

afterEach(() => vi.unstubAllGlobals())

describe('the hook: a pre-save that gets its video is liked', () => {
  it('found at once, by the check that runs on save', async () => {
    const env = await makeEnv()
    const yt = stub()
    const r = await addPresave(env, { trackId: '909720' }, 'tasker', { now: NOW })
    expect(r.presave).toMatchObject({ stage: 'found', youtube_video_id: VIDEO, liked_at: NOW, like_attempts: 1, like_error: null, like_next_at: null })
    expect(yt.rate).toEqual([VIDEO])
    expect(yt.getRating).toEqual([])
    expect(presaveOut(r.presave, DEFAULT_APP_SETTINGS)).toMatchObject({ likedAt: NOW, likeError: null, likeNextAt: null })
  })

  it('found later, by a scheduled check', async () => {
    const env = await makeEnv()
    let found = false
    const yt = stub({ medialink: () => (found ? ML_FOUND : ML_NO_YT) })
    const added = await addPresave(env, { trackId: '909720' }, 'ui', { now: NOW })
    expect(added.presave).toMatchObject({ stage: 'links', liked_at: null, like_attempts: 0 })
    expect(yt.rate).toEqual([])
    found = true
    const later = added.presave.next_check_at! + 1
    expect(await runScheduledPresave(env, added.presave.id, log, later)).toEqual({ outcome: 'ok' })
    expect(await getPresaveRow(env, added.presave.id)).toMatchObject({ stage: 'found', youtube_video_id: VIDEO, liked_at: later })
    expect(yt.rate).toEqual([VIDEO])
  })

  it('uploaded by mkvid: the upload is the video that is liked', async () => {
    const env = await makeEnv()
    const yt = stub({ medialink: () => ML_NO_YT })
    const added = await addPresave(env, { trackId: '909720' }, 'ui', { now: NOW })
    const p = await markPresaveUploaded(env, added.presave.id, 'UPLOADED001', { uploadId: 1 }, NOW + 5)
    expect(p).toMatchObject({ stage: 'uploaded', youtube_video_id: 'UPLOADED001', liked_at: NOW + 5 })
    expect(yt.rate).toEqual(['UPLOADED001'])
  })

  it('an upload that lands on a pre-save 1001tracklists already found likes nothing more', async () => {
    const env = await makeEnv()
    const yt = stub()
    const added = await addPresave(env, { trackId: '909720' }, 'ui', { now: NOW })
    const p = await markPresaveUploaded(env, added.presave.id, 'UPLOADED001', undefined, NOW + 5)
    expect(p).toMatchObject({ stage: 'found', youtube_video_id: VIDEO, liked_at: NOW })
    expect(yt.rate).toEqual([VIDEO])
  })

  it('likes once: a second call, and a recheck of a found pre-save, rate nothing', async () => {
    const env = await makeEnv()
    const yt = stub()
    const { presave } = await addPresave(env, { trackId: '909720' }, 'ui', { now: NOW })
    expect(await likePresaveVideo(env, presave.id, { now: NOW + 1 })).toEqual({ outcome: 'skipped', videoId: VIDEO })
    await recheckPresave(env, presave.id, 'manual', { now: NOW + 2 })
    await addPresave(env, { trackId: '909720' }, 'tasker', { now: NOW + 3 })
    expect(yt.rate).toEqual([VIDEO])
    expect(await likeCols(env, presave.id)).toMatchObject({ liked_at: NOW, like_attempts: 1 })
  })

  it('a try another run holds is not made twice', async () => {
    const env = await makeEnv()
    const id = await seedResolved(env, '1', 'VIDEOAAAAA1')
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const yt = stub()
    const real = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (i: RequestInfo | URL, init?: RequestInit) => { await gate; return real(i, init) }))
    const a = likePresaveVideo(env, id, { now: NOW })
    await new Promise((r) => setTimeout(r, 0))
    expect(await likePresaveVideo(env, id, { now: NOW + 1 })).toMatchObject({ outcome: 'skipped' })
    release()
    expect(await a).toMatchObject({ outcome: 'liked' })
    expect(yt.rate).toEqual(['VIDEOAAAAA1'])
  })

  it('presave.likeOnYouTube off: found, not liked, nothing tried', async () => {
    const env = await makeEnv()
    await updateAppSettings(env, { presave: { likeOnYouTube: false } })
    const yt = stub()
    const r = await addPresave(env, { trackId: '909720' }, 'ui', { now: NOW })
    expect(r.presave).toMatchObject({ stage: 'found', liked_at: null, like_attempts: 0, like_next_at: null })
    expect(yt.rate).toEqual([])
  })
})

describe('a like that fails does not touch the pre-save', () => {
  it('out of quota: still found, tried again when the quota day rolls over, and every other waiting like moves there', async () => {
    const env = await makeEnv()
    const other = await seedResolved(env, '2', 'VIDEOBBBBB2')
    await env.DB.prepare("UPDATE presaves SET like_attempts = 1, like_error = 'transient: x', like_next_at = ? WHERE id = ?").bind(NOW + 60_000, other).run()
    const yt = stub({ rate: () => ytError(403, 'quotaExceeded') })
    const r = await addPresave(env, { trackId: '909720' }, 'tasker', { now: NOW })
    const dayEnd = quotaDayEnd(NOW) * 1000
    expect(r.presave).toMatchObject({ stage: 'found', youtube_video_id: VIDEO, next_check_at: null, last_result: 'found', last_error: null, liked_at: null, like_attempts: 1, like_next_at: dayEnd })
    expect(r.presave.like_error).toMatch(/^quota: /)
    expect(r.message).toMatch(/^Already on YouTube/)
    expect(await likeCols(env, other)).toMatchObject({ like_next_at: dayEnd })
    expect(yt.rate).toEqual([VIDEO])

    // Not due before the roll-over; due after it, and liked then.
    yt.rate.length = 0
    expect(await retryDuePresaveLikes(env, log, { now: dayEnd - 1 })).toEqual({ tried: 0, liked: 0, stoppedBy: null })
    expect(yt.rate).toEqual([])
    stub()
    expect(await retryDuePresaveLikes(env, log, { now: dayEnd + 1 })).toEqual({ tried: 2, liked: 2, stoppedBy: null })
    expect(await likeCols(env, r.presave.id)).toEqual({ liked_at: dayEnd + 1, like_attempts: 2, like_error: null, like_next_at: null })
  })

  it('a retry that is out of quota stops the sweep after one call', async () => {
    const env = await makeEnv()
    for (const [t, v] of [['1', 'VIDEOAAAAA1'], ['2', 'VIDEOBBBBB2']] as const) {
      const id = await seedResolved(env, t, v)
      await env.DB.prepare("UPDATE presaves SET like_attempts = 1, like_error = 'transient: x', like_next_at = ? WHERE id = ?").bind(NOW - 1, id).run()
    }
    const yt = stub({ rate: () => ytError(403, 'quotaExceeded') })
    expect(await retryDuePresaveLikes(env, log, { now: NOW })).toEqual({ tried: 1, liked: 0, stoppedBy: 'quota' })
    expect(yt.rate).toHaveLength(1)
    expect((await env.DB.prepare('SELECT like_next_at FROM presaves').all<{ like_next_at: number }>()).results.map((r) => r.like_next_at)).toEqual([quotaDayEnd(NOW) * 1000, quotaDayEnd(NOW) * 1000])
  })

  it('a 5xx backs off (15 min, doubling, a day at most) and is retried by the cron', async () => {
    const env = await makeEnv()
    const yt = stub({ rate: () => new Response('boom', { status: 503 }) })
    const r = await addPresave(env, { trackId: '909720' }, 'ui', { now: NOW })
    expect(r.presave).toMatchObject({ stage: 'found', liked_at: null, like_attempts: 1, like_next_at: NOW + 15 * 60_000 })
    expect(r.presave.like_error).toMatch(/^transient: /)
    expect(await retryDuePresaveLikes(env, log, { now: NOW + 15 * 60_000 })).toEqual({ tried: 1, liked: 0, stoppedBy: null })
    expect(await likeCols(env, r.presave.id)).toMatchObject({ like_attempts: 2, like_next_at: NOW + 15 * 60_000 + 30 * 60_000 })
    expect(yt.rate).toEqual([VIDEO, VIDEO])
    expect(likeRetryAt('transient', 30, 0)).toBe(24 * 3600_000)
  })

  it('a video that is gone, or a refusal that is not about quota, is not tried again', async () => {
    const env = await makeEnv()
    stub({ rate: () => ytError(404, 'videoNotFound') })
    const r = await addPresave(env, { trackId: '909720' }, 'ui', { now: NOW })
    expect(r.presave).toMatchObject({ stage: 'found', liked_at: null, like_attempts: 1, like_next_at: null })
    expect(r.presave.like_error).toMatch(/^gone: /)
    expect(await retryDuePresaveLikes(env, log, { now: NOW + 365 * 86400_000 })).toMatchObject({ tried: 0 })
    expect(likeFailKind(new YouTubeApiError('videos.rate', 403, 'forbidden', ''))).toBe('forbidden')
    expect(likeFailKind(new YouTubeApiError('videos.rate', 403, 'rateLimitExceeded', ''))).toBe('quota')
    expect(likeFailKind(new YouTubeApiError('videos.rate', 401, 'authError', ''))).toBe('transient')
    expect(likeFailKind(new Error('fetch timed out'))).toBe('transient')
    expect(likeRetryAt('forbidden', 1, NOW)).toBeNull()
  })

  it('no YouTube account connected: the pre-save is found all the same, the like waits', async () => {
    const env = await makeEnv({ connected: false })
    const yt = stub()
    const r = await addPresave(env, { trackId: '909720' }, 'ui', { now: NOW })
    expect(r.presave).toMatchObject({ stage: 'found', liked_at: null, like_error: 'not_connected: no YouTube account is connected', like_next_at: NOW + 15 * 60_000 })
    expect(yt.rate).toEqual([])
  })

  it('a database without migration 0020 still finds the pre-save', async () => {
    const env = await makeEnv()
    for (const c of ['liked_at', 'like_attempts', 'like_error']) await env.DB.prepare(`ALTER TABLE presaves DROP COLUMN ${c}`).run()
    await env.DB.prepare('DROP INDEX presaves_like_due').run()
    await env.DB.prepare('ALTER TABLE presaves DROP COLUMN like_next_at').run()
    const yt = stub()
    const r = await addPresave(env, { trackId: '909720' }, 'ui', { now: NOW })
    expect(r.presave).toMatchObject({ stage: 'found', youtube_video_id: VIDEO })
    expect(yt.rate).toEqual([])
    expect(await retryDuePresaveLikes(env, log, { now: NOW })).toEqual({ tried: 0, liked: 0, stoppedBy: null })
  })
})

describe('the cron retries only likes that were tried', () => {
  it('a pre-save resolved before the likes existed is left to the backfill', async () => {
    const env = await makeEnv()
    await seedResolved(env, '1', 'VIDEOAAAAA1')
    const yt = stub()
    expect(await retryDuePresaveLikes(env, log, { now: NOW })).toEqual({ tried: 0, liked: 0, stoppedBy: null })
    expect(yt.rate).toEqual([])
  })
})

describe('the backfill', () => {
  async function seedMany(env: Env) {
    const ids = {
      found: await seedResolved(env, '1', 'VIDEOAAAAA1'),
      uploaded: await seedResolved(env, '2', 'VIDEOBBBBB2', 'uploaded'),
      alreadyOnYt: await seedResolved(env, '3', 'VIDEOCCCCC3'),
      disliked: await seedResolved(env, '4', 'VIDEODDDDD4'),
      dismissed: await seedResolved(env, '5', 'VIDEOEEEEE5', 'dismissed'),
      liked: await seedResolved(env, '6', 'VIDEOFFFFF6'),
      gone: await seedResolved(env, '7', 'VIDEOGGGGG7'),
    }
    await env.DB.prepare('UPDATE presaves SET liked_at = 5 WHERE id = ?').bind(ids.liked).run()
    await env.DB.prepare("UPDATE presaves SET like_attempts = 1, like_error = 'gone: x' WHERE id = ?").bind(ids.gone).run()
    await env.DB.prepare("INSERT INTO presaves (track_id, stage, created_at, updated_at) VALUES ('8', 'links', 1, 1)").run()
    return ids
  }
  const RATINGS = { VIDEOAAAAA1: 'none', VIDEOBBBBB2: 'none', VIDEOCCCCC3: 'like', VIDEODDDDD4: 'dislike' }

  it('dry run (the default): lists what it would like and the cost, writes and likes nothing', async () => {
    const env = await makeEnv()
    const ids = await seedMany(env)
    const yt = stub({ ratings: RATINGS })
    const r = await backfillPresaveLikes(env, {}, { now: NOW })
    expect(r).toMatchObject({ dryRun: true, total: 4, wouldLike: 2, alreadyLiked: 1, liked: 0, failed: 0, units: { getRating: 1, rate: 100 }, stoppedBy: null, nextAfterId: null })
    expect(r.items.map((i) => [i.id, i.action, i.rating])).toEqual([
      [ids.found, 'would_like', 'none'],
      [ids.uploaded, 'would_like', 'none'],
      [ids.alreadyOnYt, 'already_liked', 'like'],
      [ids.disliked, 'left_disliked', 'dislike'],
    ])
    expect(yt.getRating).toEqual([['VIDEOAAAAA1', 'VIDEOBBBBB2', 'VIDEOCCCCC3', 'VIDEODDDDD4']])
    expect(yt.rate).toEqual([])
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM presaves WHERE liked_at IS NOT NULL OR like_next_at IS NOT NULL').first<{ n: number }>())!.n).toBe(1)
    // includeStopped also names the one given up on.
    expect((await backfillPresaveLikes(env, { includeStopped: true }, { now: NOW })).items.map((i) => i.id)).toContain(ids.gone)
  })

  it('live: likes the unliked, marks the already liked without rating it, leaves a disliked one, and is rerunnable', async () => {
    const env = await makeEnv()
    const ids = await seedMany(env)
    const yt = stub({ ratings: RATINGS })
    const r = await backfillPresaveLikes(env, { dryRun: false }, { now: NOW })
    expect(r).toMatchObject({ dryRun: false, total: 4, liked: 2, alreadyLiked: 1, failed: 0, units: { getRating: 1, rate: 100 }, stoppedBy: null, nextAfterId: null })
    expect(yt.rate).toEqual(['VIDEOAAAAA1', 'VIDEOBBBBB2'])
    for (const id of [ids.found, ids.uploaded, ids.alreadyOnYt]) expect(await likeCols(env, id)).toMatchObject({ liked_at: NOW, like_error: null, like_next_at: null })
    expect(await likeCols(env, ids.disliked)).toMatchObject({ liked_at: null, like_error: 'disliked: disliked on YouTube; left alone', like_next_at: null })
    expect(await likeCols(env, ids.dismissed)).toMatchObject({ liked_at: null, like_attempts: 0 })
    // Again: nothing left, no YouTube call at all.
    const again = await backfillPresaveLikes(env, { dryRun: false }, { now: NOW + 1 })
    expect(again).toMatchObject({ total: 0, items: [], units: { getRating: 0, rate: 0 } })
    expect(yt.rate).toHaveLength(2)
    expect(yt.getRating).toHaveLength(1)
  })

  it('live: `limit` bounds the likes of one request and nextAfterId carries on', async () => {
    const env = await makeEnv()
    const a = await seedResolved(env, '1', 'VIDEOAAAAA1')
    const b = await seedResolved(env, '2', 'VIDEOBBBBB2')
    const yt = stub()
    const first = await backfillPresaveLikes(env, { dryRun: false, limit: 1 }, { now: NOW })
    expect(first).toMatchObject({ liked: 1, nextAfterId: a, units: { getRating: 1, rate: 50 } })
    const second = await backfillPresaveLikes(env, { dryRun: false, limit: 1, afterId: a }, { now: NOW })
    expect(second).toMatchObject({ liked: 1, nextAfterId: null })
    expect(second.items.map((i) => i.id)).toEqual([b])
    expect(yt.rate).toEqual(['VIDEOAAAAA1', 'VIDEOBBBBB2'])
  })

  it('live: out of quota stops the page; what was liked stays liked and the rest is picked up by a rerun', async () => {
    const env = await makeEnv()
    const a = await seedResolved(env, '1', 'VIDEOAAAAA1')
    const b = await seedResolved(env, '2', 'VIDEOBBBBB2')
    const c = await seedResolved(env, '3', 'VIDEOCCCCC3')
    const yt = stub({ rate: (id) => (id === 'VIDEOAAAAA1' ? new Response(null, { status: 204 }) : ytError(403, 'quotaExceeded')) })
    const r = await backfillPresaveLikes(env, { dryRun: false }, { now: NOW })
    expect(r).toMatchObject({ liked: 1, failed: 1, stoppedBy: 'quota', nextAfterId: null, units: { getRating: 1, rate: 50 } })
    expect(yt.rate).toEqual(['VIDEOAAAAA1', 'VIDEOBBBBB2'])
    expect(await likeCols(env, a)).toMatchObject({ liked_at: NOW })
    expect(await likeCols(env, b)).toMatchObject({ liked_at: null, like_next_at: quotaDayEnd(NOW) * 1000 })
    expect(await likeCols(env, c)).toMatchObject({ liked_at: null, like_attempts: 0 })
    stub()
    expect(await backfillPresaveLikes(env, { dryRun: false }, { now: NOW + 1 })).toMatchObject({ total: 2, liked: 2, stoppedBy: null })
  })

  it('out of quota already at videos.getRating: a live run likes nothing, a dry run lists everything as not liked yet', async () => {
    const env = await makeEnv()
    await seedResolved(env, '1', 'VIDEOAAAAA1')
    const yt = stub({ ratings: () => ytError(403, 'quotaExceeded') })
    expect(await backfillPresaveLikes(env, { dryRun: false }, { now: NOW })).toMatchObject({ liked: 0, stoppedBy: 'quota', units: { getRating: 0, rate: 0 }, items: [{ action: 'not_tried', rating: 'unknown' }] })
    expect(await backfillPresaveLikes(env, {}, { now: NOW })).toMatchObject({ wouldLike: 1, stoppedBy: 'quota', units: { getRating: 0, rate: 50 }, items: [{ action: 'would_like', rating: 'unknown' }] })
    expect(yt.rate).toEqual([])
  })

  it('a video getRating does not name (deleted, private) is tried, and a 404 parks it', async () => {
    const env = await makeEnv()
    const a = await seedResolved(env, '1', 'VIDEOAAAAA1')
    stub({ ratings: {}, rate: () => ytError(404, 'videoNotFound') })
    const r = await backfillPresaveLikes(env, { dryRun: false }, { now: NOW })
    expect(r).toMatchObject({ liked: 0, failed: 1, stoppedBy: null, items: [{ id: a, rating: 'unknown', action: 'failed' }] })
    expect(await backfillPresaveLikes(env, { dryRun: false }, { now: NOW })).toMatchObject({ total: 0 })
  })

  it('a dismissed pre-save is never liked', async () => {
    const env = await makeEnv()
    const yt = stub()
    const { presave } = await addPresave(env, { trackId: '909720' }, 'ui', { now: NOW, check: false })
    await env.DB.prepare("UPDATE presaves SET youtube_video_id = 'VIDEOAAAAA1', stage = 'found' WHERE id = ?").bind(presave.id).run()
    await dismissPresave(env, presave.id, NOW)
    expect(await likePresaveVideo(env, presave.id, { now: NOW })).toMatchObject({ outcome: 'skipped' })
    expect(await backfillPresaveLikes(env, { dryRun: false }, { now: NOW })).toMatchObject({ total: 0 })
    expect(yt.rate).toEqual([])
  })

  it('POST /presave/like-backfill: the Tasker bearer, dry run unless told otherwise', async () => {
    const env = await makeEnv()
    const id = await seedResolved(env, '1', 'VIDEOAAAAA1')
    const yt = stub({ ratings: { VIDEOAAAAA1: 'none' } })
    const post = (body: unknown, token = 't') => app.request('/presave/like-backfill', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env)
    expect((await post({}, 'wrong')).status).toBe(401)
    expect((await post({ limit: 500 })).status).toBe(400)
    const dry = await post({})
    expect(dry.status).toBe(200)
    expect(await dry.json()).toMatchObject({ dryRun: true, total: 1, wouldLike: 1, units: { getRating: 1, rate: 50 }, items: [{ id, videoId: 'VIDEOAAAAA1', action: 'would_like' }] })
    expect(yt.rate).toEqual([])
    expect(await (await post({ dryRun: false })).json()).toMatchObject({ dryRun: false, liked: 1, items: [{ id, action: 'liked' }] })
    expect(yt.rate).toEqual(['VIDEOAAAAA1'])
    expect(await likeCols(env, id)).toMatchObject({ like_attempts: 1 })
  })
})
