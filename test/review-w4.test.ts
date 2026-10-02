/**
 * Review W4 findings (fetch layer, verification, pool events) that are not
 * scheduler-tick tests (those are in fetch-scheduler.test.ts), plus the tlpool
 * contract as built (tlpool/api.py, tlpool/webhook.py).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1, type FakeD1 } from './helpers/fake-d1'
import { pushSubscription, vapid } from './helpers/web-push'
import type { Env } from '../src/types'
import { makeLogger } from '../src/lib/log'
import { DEFAULT_POOL_SETTINGS } from '../src/lib/pool-settings'
import { parseTracklist } from '../src/lib/tracklists1001'
import { isVerified, noteSetFetch } from '../src/lib/verification'
import { claimMkvidRequest, enqueueMkvidRequest, getMkvidTracks } from '../src/lib/mkvid'
import { dueRecheckUrls } from '../src/lib/sync'
import { savePushSubscription } from '../src/lib/web-push'
import { listPoolEvents, MAX_PUSH_ATTEMPTS, poolEventPushPayload, prunePoolEvents, receivePoolEvent, retryFailedPoolPushes, sanitizePoolEvent, type PoolEvent } from '../src/lib/pool-events'
import { PoolPausedError, PoolUnavailableError, poolFetch } from '../src/lib/pool'
import { app } from '../src/index'

const here = dirname(fileURLToPath(import.meta.url))
const fx = (name: string) => readFileSync(resolve(here, 'fixtures', name), 'utf8')
const log = makeLogger({ task: 'test' })
const NOW = Math.floor(Date.now() / 1000)
const H = 3600
const D = 86400

function makeEnv(extra: Partial<Env> = {}): Env {
  return { CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k', MKVID_TOKEN: 'mk', ...extra } as Env
}
const ev = (body: Record<string, unknown>): PoolEvent => {
  const r = sanitizePoolEvent(body)
  if (!r.ok) throw new Error(r.error)
  return r.event
}

afterEach(() => vi.unstubAllGlobals())

describe('#1 blocker: a stored trusted flag alone never makes a list claimable', () => {
  const SET = 'https://www.1001tracklists.com/tracklist/abc/x-2026-01-01.html'
  const input = { slug: 'dj', setUrl: SET, artistName: 'DJ', setTitle: 'X', setDate: '2026-01-01', source: { kind: 'soundcloud' as const, url: 'https://api.soundcloud.com/tracks/1' }, lastCueSeconds: 100, trackCount: 3, idedCount: 3 }

  it('a pre-existing trusted = 1 row for an unverified set: not claimable, and its list is not handed out as trusted', async () => {
    const env = makeEnv()
    await enqueueMkvidRequest(env, input)
    const id = (await env.DB.prepare('SELECT id FROM mkvid_requests WHERE set_url = ?').bind(SET).first<{ id: string }>())!.id
    const tracks = JSON.stringify([0, 1, 2].map((i) => ({ cueSeconds: i * 60, artist: `A${i}`, title: `T${i}`, artworkUrl: null, isId: false, layered: false })))
    await env.DB.prepare(`INSERT INTO mkvid_request_tracks (request_id, tracks, track_count, trusted, named, mismatched, scraped_at, id_rows) VALUES (?, ?, 3, 1, 3, 0, 1, 0)`).bind(id, tracks).run()
    expect(await isVerified(env, SET)).toBe(false)
    expect((await getMkvidTracks(env, id)).tracksTrusted).toBe(false)
    expect(await claimMkvidRequest(env, log)).toBeNull()
    expect((await env.DB.prepare('SELECT status, attempts FROM mkvid_requests WHERE id = ?').bind(id).first())).toMatchObject({ status: 'pending', attempts: 0 })
  })
})

describe('#6 minor: a verification write only lands on the pending row it was compared with', () => {
  it('a concurrent restart between the read and the write is not overwritten with verified', async () => {
    const env = makeEnv()
    const URL1 = 'https://www.1001tracklists.com/tracklist/1pqq0hst/matroda-2025-06-01.html'
    const real = parseTracklist(URL1, fx('tracklist-matroda.html'))
    const T0 = NOW - 10 * H
    await noteSetFetch(env, { setUrl: URL1, parsed: real, accountId: 'acct-1', fetchedAt: T0, settings: DEFAULT_POOL_SETTINGS, pool: null })
    // Interleave: right before acct-2's "verified" UPDATE runs, another fetch (acct-3, edited rows) restarts verification.
    const db = env.DB as FakeD1
    const prepare = db.prepare.bind(db)
    let raced = false
    db.prepare = ((sql: string) => {
      if (!raced && /SET state = 'verified'/.test(sql)) {
        raced = true
        db._db.exec(`UPDATE set_verification SET fingerprint = 'restarted', first_account = 'acct-3', first_fetched_at = ${T0 + 5 * H} WHERE url = '${URL1}'`)
      }
      return prepare(sql)
    }) as typeof db.prepare
    const r = await noteSetFetch(env, { setUrl: URL1, parsed: real, accountId: 'acct-2', fetchedAt: T0 + 3 * H, settings: DEFAULT_POOL_SETTINGS, pool: null })
    expect(raced).toBe(true)
    expect(r.outcome).toBe('still_pending')
    expect(await isVerified(env, URL1)).toBe(false)
  })
})

describe('#8 minor: manual runs keep the 90-day exception for old sets with ID rows', () => {
  it('an old set with a good video is due after 90 days only when its last fetch had ID rows', () => {
    const u = 'https://www.1001tracklists.com/tracklist/old/x-2024-01-01.html'
    const videos = { [u]: { videoId: 'v', checkedAt: NOW - 100 * D } }
    expect(dueRecheckUrls([u], new Set(), videos, NOW, DEFAULT_POOL_SETTINGS)).toEqual([])
    expect(dueRecheckUrls([u], new Set(), videos, NOW, DEFAULT_POOL_SETTINGS, new Set([u]))).toEqual([u])
  })
})

describe('#9 minor: failed pushes are retried while fresh; events are pruned after 90 days', () => {
  async function pushEnv() {
    const env = makeEnv({ ...(await vapid()), TLPOOL_TOKEN: 'pool-secret' })
    await savePushSubscription(env, await pushSubscription('https://push.example/device-1'), 'phone')
    return env
  }
  it('a push-service 5xx is retried by the cron (5 deliveries at most); a challenge solved meanwhile is not', async () => {
    const env = await pushEnv()
    const now = new Date(NOW * 1000)
    const failing = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch
    const ok = (async () => new Response(null, { status: 201 })) as unknown as typeof fetch
    expect((await receivePoolEvent(env, ev({ type: 'challenge.created', challengeId: 'c1' }), { now, fetchImpl: failing })).push).toBe('failed')
    expect((await receivePoolEvent(env, ev({ type: 'challenge.created', challengeId: 'c2' }), { now, fetchImpl: failing })).push).toBe('failed')
    await receivePoolEvent(env, ev({ type: 'challenge.solved', challengeId: 'c2' }), { now })
    for (let i = 1; i < MAX_PUSH_ATTEMPTS; i++) await retryFailedPoolPushes(env, { now, fetchImpl: failing })
    expect(await retryFailedPoolPushes(env, { now, fetchImpl: ok })).toEqual({ retried: 0, sent: 0 }) // c1 used its 5 tries; c2 closed
    const env2 = await pushEnv()
    await receivePoolEvent(env2, ev({ type: 'account.flagged', accountId: 'acct-4' }), { now, fetchImpl: failing })
    expect(await retryFailedPoolPushes(env2, { now, fetchImpl: ok })).toEqual({ retried: 1, sent: 1 })
    expect((await listPoolEvents(env2))[0]!.pushStatus).toBe('sent')
    // Older than 2 hours: no more retries.
    await receivePoolEvent(env2, ev({ type: 'account.flagged', accountId: 'acct-5' }), { now: new Date((NOW - 3 * H) * 1000), fetchImpl: failing })
    expect(await retryFailedPoolPushes(env2, { now, fetchImpl: ok })).toEqual({ retried: 0, sent: 0 })
  })
  it('the daily prune drops events older than 90 days', async () => {
    const env = await pushEnv()
    await receivePoolEvent(env, ev({ type: 'account.created', accountId: 'acct-1' }), { now: new Date((NOW - 91 * D) * 1000) })
    await receivePoolEvent(env, ev({ type: 'account.created', accountId: 'acct-2' }), { now: new Date(NOW * 1000) })
    expect(await prunePoolEvents(env, NOW)).toBe(1)
    expect((await listPoolEvents(env)).map((e) => e.accountId)).toEqual(['acct-2'])
  })
})

describe('tlpool contract as built', () => {
  it('accepts every event tlpool emits, and pushes only challenge.created, account.flagged and account.retired', async () => {
    const env = makeEnv({ TLPOOL_TOKEN: 'pool-secret' })
    const types = ['challenge.created', 'challenge.solved', 'challenge.expired', 'account.flagged', 'account.created', 'account.retired', 'account.rested']
    for (const [i, type] of types.entries()) {
      const res = await app.request('http://x/pool/events', { method: 'POST', headers: { Authorization: 'Bearer pool-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ id: `ev_${i}`, type, at: new Date().toISOString(), challengeId: 'ch-1', accountId: 'acct-2', reason: 'x', restUntil: new Date().toISOString(), exitLabel: 'exit-a' }) }, env)
      expect(res.status, type).toBe(200)
    }
    expect(await listPoolEvents(env)).toHaveLength(types.length)
    const pushed = types.filter((type) => poolEventPushPayload(ev({ type, challengeId: 'ch-1', accountId: 'acct-2' })) !== null)
    expect(pushed).toEqual(['challenge.created', 'account.flagged', 'account.retired'])
    expect(poolEventPushPayload(ev({ type: 'account.retired', accountId: 'acct-2' }))).toMatchObject({ kind: 'pool_account', url: '/ui/pool' })
  })

  it('the retired push says whether the exit is quarantined (tlpool omits the date when the form was never submitted)', () => {
    const free = poolEventPushPayload(ev({ type: 'account.retired', accountId: 'acct-32', reason: 'signup_failed: could not set the country on the registration form' }))!
    expect(free.body).toBe('acct-32 was retired (signup_failed: could not set the country on the registration form). It never submitted the register form, so its exit is free for a new account.')
    const held = poolEventPushPayload(ev({ type: 'account.retired', accountId: 'acct-7', reason: 'decoy', exitQuarantinedUntil: '2026-11-01T17:00:00Z' }))!
    expect(held.body).toBe('acct-7 was retired (decoy). Its exit is not reused until Nov 1.')
    expect(ev({ type: 'account.retired', exitQuarantinedUntil: 'soon' }).exitQuarantinedUntil).toBeNull()
  })

  it('reads contract errors from the body of an HTTP 200 answer (tlpool never answers 502/504)', async () => {
    const answer = (body: unknown, status = 200) => ({ url: 'https://tlpool.example', token: 't', fetchImpl: (async () => Response.json(body, { status })) as unknown as typeof fetch })
    const req = { url: 'https://www.1001tracklists.com/tracklist/x/y.html', kind: 'set' as const, priority: 'new' as const }
    await expect(poolFetch(answer({ error: 'budget_exhausted', retryAfterSeconds: 900 }), req)).rejects.toBeInstanceOf(PoolPausedError)
    await expect(poolFetch(answer({ error: 'challenge_pending', retryAfterSeconds: 120, challengeId: 'c', accountId: 'acct-1' }), req)).rejects.toMatchObject({ code: 'challenge_pending' })
    await expect(poolFetch(answer({ error: 'blocked', reason: 'decoy', retryAfterSeconds: 600 }), req)).rejects.toBeInstanceOf(PoolUnavailableError)
    await expect(poolFetch(answer({ error: 'bad_request', message: 'url' }, 400), req)).rejects.toMatchObject({ code: 'bad_response' })
  })
})

describe('#4 major: /tracklist resolves links one at a time, 25 at most per call', () => {
  it('a 31-track set with links on makes at most 25 media link fetches, never two at once', async () => {
    const env = makeEnv({ TLPOOL_URL: 'https://tlpool.example', TLPOOL_TOKEN: 'pt' })
    let inFlight = 0
    let maxInFlight = 0
    let medialinks = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.startsWith('https://itunes.apple.com/')) return Response.json({ resultCount: 0, results: [] })
        const body = JSON.parse(String(init!.body)) as { kind: string; url: string }
        if (body.kind === 'medialink') {
          medialinks++
          inFlight++
          maxInFlight = Math.max(maxInFlight, inFlight)
          await new Promise((r) => setTimeout(r, 1))
          inFlight--
        }
        const html = body.kind === 'medialink' ? fx('medialink-909720.json') : fx('tracklist-habstrakt.html')
        return Response.json({ status: 200, finalUrl: body.url, html, accountId: 'acct-1', exitLabel: 'e', fetchedAt: new Date().toISOString(), bytes: html.length })
      }),
    )
    const res = await app.request('http://x/tracklist', { method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://www.1001tracklists.com/tracklist/18kll1h1/habstrakt-jstjr-1001tracklists-x-dj-lovers-club-pres.-waterways-amsterdam-dance-event-netherlands-2024-11-11.html' }) }, env)
    expect(res.status).toBe(200)
    expect(medialinks).toBeLessThanOrEqual(25)
    expect(medialinks).toBeGreaterThan(0)
    expect(maxInFlight).toBe(1)
  })
})
