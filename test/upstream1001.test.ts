import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { fakeD1 } from './helpers/fake-d1'
import { fakeKV } from './helpers/fake-kv'
import type { Env } from '../src/types'
import {
  fetch1001,
  fetchOptsFromEnv,
  isStopTheBatchError,
  UpstreamHttpError,
  UpstreamPausedError,
  UpstreamTransportError,
  UpstreamUnavailableError,
} from '../src/lib/upstream1001'
import { PHONE_MAX_WAIT_SECONDS, PoolPausedError, PoolUnavailableError, poolConfigFromEnv, poolFetch, poolRestingShare, poolRetestAccount } from '../src/lib/pool'
import { fetchMediaLinks, fetchTracklist, searchByTitle, searchByYouTubeUrl } from '../src/lib/tracklists1001'
import { fetch1001Html } from '../src/lib/dj-index'
import { _resetTallyForTests, setPause } from '../src/lib/ban-state'
import { IPBlockedError } from '../src/lib/fetch'
import { makeLogger } from '../src/lib/log'

const here = dirname(fileURLToPath(import.meta.url))
const fx = (name: string) => readFileSync(resolve(here, 'fixtures', name), 'utf8')
const TRACKLIST_HTML = fx('tracklist-matroda.html')
const BLOCK_HTML = fx('ip-block-tracklist.html')
const SEARCH_HTML = fx('search-result.html')

const POOL = 'https://tlpool.example'
const TL = 'https://www.1001tracklists.com/tracklist/abc/def.html'

type Call = { url: string; init: RequestInit; body: Record<string, any> | null }

/** A fake tlpool: `answer` decides each /fetch reply; every request is recorded. */
function fakePool(answer: (body: Record<string, any>, url: string) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    const body = init.body ? JSON.parse(String(init.body)) : null
    calls.push({ url, init, body })
    return answer(body ?? {}, url)
  }) as unknown as typeof fetch
  return { calls, pool: { url: POOL, token: 'pool-token', fetchImpl } }
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
const page = (html: string, extra: Record<string, unknown> = {}) =>
  json({ status: 200, finalUrl: TL, html, accountId: 'acct-2', exitLabel: 'own-3', fetchedAt: '2026-09-29T10:00:00.000Z', bytes: html.length, ...extra })

function makeEnv(overrides: Partial<Env> = {}): Env {
  return { CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k', TLPOOL_URL: POOL, TLPOOL_TOKEN: 'pool-token', ...overrides } as Env
}

beforeEach(() => _resetTallyForTests())

describe('poolFetch — the tlpool /fetch contract', () => {
  it('POSTs {url, kind, priority, maxWaitSeconds} with the bearer and returns the page and its opaque account', async () => {
    const { calls, pool } = fakePool(() => page('<html>ok</html>'))
    const r = await poolFetch(pool, { url: TL, kind: 'set', priority: 'recheck' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${POOL}/fetch`)
    expect(calls[0]!.init.method).toBe('POST')
    expect(new Headers(calls[0]!.init.headers).get('Authorization')).toBe('Bearer pool-token')
    expect(calls[0]!.body).toEqual({ url: TL, kind: 'set', priority: 'recheck', maxWaitSeconds: 20 })
    expect(r).toMatchObject({ status: 200, html: '<html>ok</html>', accountId: 'acct-2', exitLabel: 'own-3' })
  })

  it('caps a phone fetch at 25 s and passes excludeAccounts / method / form / headers only when set', async () => {
    const { calls, pool } = fakePool(() => page('x'))
    await poolFetch(pool, { url: TL, kind: 'search', priority: 'phone', maxWaitSeconds: 90, excludeAccounts: ['acct-1'], method: 'POST', form: { a: '1' }, headers: { Referer: 'r' } })
    expect(calls[0]!.body).toEqual({ url: TL, kind: 'search', priority: 'phone', maxWaitSeconds: PHONE_MAX_WAIT_SECONDS, excludeAccounts: ['acct-1'], method: 'POST', form: { a: '1' }, headers: { Referer: 'r' } })
  })

  it('maps budget_exhausted / challenge_pending to a pause (stop the batch) carrying retryAfterSeconds', async () => {
    for (const error of ['budget_exhausted', 'challenge_pending']) {
      const { pool } = fakePool(() => json({ error, retryAfterSeconds: 900 }))
      const e = await poolFetch(pool, { url: TL, kind: 'set', priority: 'new' }).catch((x) => x)
      expect(e).toBeInstanceOf(PoolPausedError)
      expect(e).toBeInstanceOf(UpstreamPausedError)
      expect(e).toMatchObject({ code: error, retryAfterSeconds: 900 })
      expect(isStopTheBatchError(e)).toBe(true)
    }
  })

  it('maps no_healthy_account / blocked / timeout to unavailable (stop the batch, charge nothing)', async () => {
    for (const error of ['no_healthy_account', 'blocked', 'timeout']) {
      const { pool } = fakePool(() => json({ error, retryAfterSeconds: 60 }))
      const e = await poolFetch(pool, { url: TL, kind: 'set', priority: 'new' }).catch((x) => x)
      expect(e).toBeInstanceOf(PoolUnavailableError)
      expect(e).toBeInstanceOf(UpstreamUnavailableError)
      expect(e.code).toBe(error)
      expect(isStopTheBatchError(e)).toBe(true)
    }
  })

  it('pool unreachable, 401 from the pool, garbage, or no config are all unavailable', async () => {
    const down = { url: POOL, token: 't', fetchImpl: (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch }
    await expect(poolFetch(down, { url: TL, kind: 'set', priority: 'new' })).rejects.toMatchObject({ name: 'PoolUnavailableError', code: 'unreachable' })
    await expect(poolFetch(fakePool(() => json({ error: 'unauthorized' }, 401)).pool, { url: TL, kind: 'set', priority: 'new' })).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(poolFetch(fakePool(() => new Response('<html>502</html>', { status: 502 })).pool, { url: TL, kind: 'set', priority: 'new' })).rejects.toMatchObject({ code: 'bad_response' })
    await expect(poolFetch(fakePool(() => json({ error: 'something_new' })).pool, { url: TL, kind: 'set', priority: 'new' })).rejects.toMatchObject({ code: 'bad_response' })
    await expect(poolFetch(null, { url: TL, kind: 'set', priority: 'new' })).rejects.toMatchObject({ code: 'not_configured' })
  })

  it('counts every call on the request log', async () => {
    const log = makeLogger({ test: true })
    await poolFetch(fakePool(() => page('x')).pool, { url: TL, kind: 'set', priority: 'new' }, log)
    await poolFetch(fakePool(() => json({ error: 'timeout' })).pool, { url: TL, kind: 'set', priority: 'new' }, log).catch(() => {})
    expect(log.counters.poolCalls).toBe(2)
  })

  it('poolRetestAccount posts to /accounts/:id/retest and refuses anything that is not an opaque id', async () => {
    const { calls, pool } = fakePool(() => json({ ok: true }))
    expect(await poolRetestAccount(pool, 'acct-7', 'verification mismatch')).toBe(true)
    expect(calls[0]!.url).toBe(`${POOL}/accounts/acct-7/retest`)
    expect(calls[0]!.body).toEqual({ reason: 'verification mismatch' })
    expect(await poolRetestAccount(pool, 'some user@example.com', 'x')).toBe(false)
    expect(calls).toHaveLength(1)
    expect(await poolRetestAccount(null, 'acct-7', 'x')).toBe(false)
  })

  it('poolConfigFromEnv needs both TLPOOL_URL and TLPOOL_TOKEN', () => {
    expect(poolConfigFromEnv({ TLPOOL_URL: `${POOL}/`, TLPOOL_TOKEN: 'k' })).toEqual({ url: POOL, token: 'k' })
    expect(poolConfigFromEnv({ TLPOOL_URL: POOL })).toBeNull()
    expect(poolConfigFromEnv({})).toBeNull()
  })
})

describe('poolFetch — queueSeconds (long queueing across re-POSTs)', () => {
  const T0 = Date.parse('2026-10-07T18:00:00Z')
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => vi.useRealTimers())
  /** tlpool holding each POST for its full maxWaitSeconds before answering. */
  const holds = (answer: (body: Record<string, any>, n: number) => Response) => {
    let n = 0
    return fakePool((body) => {
      vi.setSystemTime(Date.now() + body.maxWaitSeconds * 1000)
      return answer(body, ++n)
    })
  }

  it('re-POSTs the identical request (each wait <= 90 s) while tlpool says queued, then returns the page', async () => {
    const { calls, pool } = holds((_b, n) => (n <= 3 ? json({ error: 'timeout', reason: 'queued', retryAfterSeconds: 0, queuedSeconds: n * 90 }) : page('<html>ok</html>')))
    const r = await poolFetch(pool, { url: TL, kind: 'set', priority: 'new', queueSeconds: 600, excludeAccounts: ['acct-1'] })
    expect(r.html).toBe('<html>ok</html>')
    expect(calls).toHaveLength(4)
    for (const c of calls) {
      expect(c.body!.maxWaitSeconds).toBeLessThanOrEqual(90)
      const { maxWaitSeconds: _w, ...rest } = c.body!
      expect(rest).toEqual({ url: TL, kind: 'set', priority: 'new', excludeAccounts: ['acct-1'], queueSeconds: 600 })
    }
  })

  it('stops at the queue budget and says how long it waited and why', async () => {
    const log = makeLogger({ test: true })
    const { calls, pool } = holds(() => json({ error: 'timeout', reason: 'queued', retryAfterSeconds: 0 }))
    const e = await poolFetch(pool, { url: TL, kind: 'set', priority: 'new', queueSeconds: 600 }, log).catch((x) => x)
    expect(calls.map((c) => c.body!.maxWaitSeconds)).toEqual([90, 90, 90, 90, 90, 90, 60])
    expect(e).toBeInstanceOf(PoolUnavailableError)
    expect(e).toMatchObject({ code: 'timeout', poolReason: 'queued', waitedSeconds: 600 })
    expect(e.message).toBe('pool busy: waited 600 s for a free browser (other fetches were running)')
    expect(isStopTheBatchError(e)).toBe(true)
    expect(log.counters.poolCalls).toBe(7)

    const running = holds(() => json({ error: 'timeout', reason: 'running', accountId: 'acct-34', retryAfterSeconds: 0 }))
    const e2 = await poolFetch(running.pool, { url: TL, kind: 'set', priority: 'new', queueSeconds: 120 }).catch((x) => x)
    expect(running.calls.map((c) => c.body!.maxWaitSeconds)).toEqual([90, 30])
    expect(e2.message).toBe("pool slow: acct-34's page load had not finished after 120 s")
  })

  it('any other answer ends the loop at once: a stalled page load, an old tlpool without a reason, a pause', async () => {
    for (const reply of [
      { error: 'timeout', reason: 'browser', accountId: 'acct-34', retryAfterSeconds: 0 },
      { error: 'timeout', retryAfterSeconds: 30 },
      { error: 'budget_exhausted', retryAfterSeconds: 900 },
    ]) {
      const { calls, pool } = holds(() => json(reply))
      await poolFetch(pool, { url: TL, kind: 'set', priority: 'new', queueSeconds: 600 }).catch(() => {})
      expect(calls, JSON.stringify(reply)).toHaveLength(1)
    }
  })

  it('a tlpool answering "queued" instantly cannot make it spin', async () => {
    const { calls, pool } = fakePool(() => json({ error: 'timeout', reason: 'queued', retryAfterSeconds: 0 }))
    await poolFetch(pool, { url: TL, kind: 'set', priority: 'new', queueSeconds: 600 }).catch(() => {})
    expect(calls).toHaveLength(22)
  })

  it('phone never queues; without queueSeconds one POST waits the default 20 s, capped at 90', async () => {
    const phone = holds(() => json({ error: 'timeout', reason: 'queued', retryAfterSeconds: 0 }))
    const e = await poolFetch(phone.pool, { url: TL, kind: 'set', priority: 'phone', queueSeconds: 600 }).catch((x) => x)
    expect(phone.calls).toHaveLength(1)
    expect(phone.calls[0]!.body).toMatchObject({ maxWaitSeconds: PHONE_MAX_WAIT_SECONDS })
    expect(phone.calls[0]!.body).not.toHaveProperty('queueSeconds')
    expect(e.message).toBe('pool busy: waited 25 s for a free browser (other fetches were running)')

    const plain = holds(() => json({ error: 'timeout', retryAfterSeconds: 30 }))
    const e2 = await poolFetch(plain.pool, { url: TL, kind: 'set', priority: 'new' }).catch((x) => x)
    expect(plain.calls[0]!.body).toMatchObject({ maxWaitSeconds: 20 })
    expect(e2.message).toBe('pool timeout: no page within 20 s (pool busy or a page load stalled)')
    const long = fakePool(() => page('x'))
    await poolFetch(long.pool, { url: TL, kind: 'set', priority: 'new', maxWaitSeconds: 120 })
    expect(long.calls[0]!.body).toMatchObject({ maxWaitSeconds: 90 })
  })

  it('fetch1001 passes queueSeconds through, and a stalled load inside the queue still gets its one retry elsewhere', async () => {
    const { calls, pool } = holds((_b, n) =>
      n === 1 ? json({ error: 'timeout', reason: 'queued', retryAfterSeconds: 0 }) : n === 2 ? json({ error: 'timeout', reason: 'browser', accountId: 'acct-34', retryAfterSeconds: 0 }) : page(TRACKLIST_HTML, { accountId: 'acct-8' }),
    )
    const r = await fetch1001(TL, { pool, priority: 'new', queueSeconds: 600 })
    expect(r.accountId).toBe('acct-8')
    expect(calls.map((c) => [c.body!.queueSeconds, c.body!.excludeAccounts ?? []])).toEqual([[600, []], [600, []], [600, ['acct-34']]])
  })
})

describe('pool fault messages', () => {
  it('say what happened, never "1001tracklists unreachable" for a pool fault', async () => {
    const down = { url: POOL, token: 't', fetchImpl: (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch }
    const e = await poolFetch(down, { url: TL, kind: 'set', priority: 'new' }).catch((x) => x)
    expect(e.message).toBe('pool unreachable: tlpool or its tunnel did not answer (fetch failed)')
    expect(new PoolUnavailableError('no_healthy_account').message).toBe('pool: no healthy account free for this fetch')
    expect(new PoolUnavailableError('timeout', undefined, null, { reason: 'net_error', accountId: 'acct-2' }).message).toBe('page load failed on acct-2 (network error in the pool browser)')
  })

  it('poolRestingShare ignores scheduled creations (state "queued") and passive accounts', async () => {
    const accounts = [
      { id: 'acct-1', state: 'active' },
      { id: 'acct-2', state: 'resting' },
      { id: 'acct-3', state: 'warming' },
      { id: 'acct-4', state: 'resting', passive: true },
      { id: 'queued-1', state: 'queued', queued: true, scheduledAt: '2026-10-08T00:00:00Z', passive: false },
      { id: 'acct-5', state: 'retired' },
    ]
    const { pool } = fakePool(() => json({ accounts }))
    expect(await poolRestingShare(pool)).toEqual({ resting: 1, total: 3 })
  })
})

describe('fetch1001 — the only 1001tracklists route', () => {
  it('ban:pause is the master switch: nothing is sent to the pool', async () => {
    const env = makeEnv()
    await setPause(env, 'manual', null)
    const { calls, pool } = fakePool(() => page(TRACKLIST_HTML))
    const e = await fetch1001(TL, { pool, cacheKv: env.CACHE }).catch((x) => x)
    expect(e).toBeInstanceOf(UpstreamPausedError)
    expect(isStopTheBatchError(e)).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('serves the page via the pool, defaulting to kind set and priority phone', async () => {
    const env = makeEnv()
    const { calls, pool } = fakePool(() => page(TRACKLIST_HTML))
    const r = await fetch1001(TL, { pool, cacheKv: env.CACHE })
    expect(r).toMatchObject({ via: 'pool', accountId: 'acct-2', exitLabel: 'own-3', fetchedAt: '2026-09-29T10:00:00.000Z' })
    expect(r.html).toBe(TRACKLIST_HTML)
    expect(calls[0]!.body).toMatchObject({ kind: 'set', priority: 'phone', maxWaitSeconds: 25 })
  })

  it('a pool timeout is asked once more (another account serves it); a second timeout stops the batch', async () => {
    let n = 0
    const { calls, pool } = fakePool(() => (++n === 1 ? json({ error: 'timeout', retryAfterSeconds: 30 }) : page(TRACKLIST_HTML, { accountId: 'acct-17' })))
    const r = await fetch1001(TL, { pool, priority: 'new', excludeAccounts: ['acct-9'] })
    expect(r.accountId).toBe('acct-17')
    expect(calls).toHaveLength(2)
    expect(calls[1]!.body).toEqual(calls[0]!.body)
    expect(calls[1]!.body).toMatchObject({ excludeAccounts: ['acct-9'] })

    const always = fakePool(() => json({ error: 'timeout', retryAfterSeconds: 30 }))
    const e = await fetch1001(TL, { pool: always.pool, priority: 'recheck' }).catch((x) => x)
    expect(e).toBeInstanceOf(PoolUnavailableError)
    expect(e).toMatchObject({ code: 'timeout' })
    expect(isStopTheBatchError(e)).toBe(true)
    expect(always.calls).toHaveLength(2)
  })

  it('reason "browser" (a stalled page load) retries once with that account excluded; the error tells both halves', async () => {
    let n = 0
    const { calls, pool } = fakePool(() => (++n === 1 ? json({ error: 'timeout', reason: 'browser', accountId: 'acct-34', retryAfterSeconds: 0 }) : page(TRACKLIST_HTML, { accountId: 'acct-17' })))
    const r = await fetch1001(TL, { pool, priority: 'new', excludeAccounts: ['acct-9'] })
    expect(r.accountId).toBe('acct-17')
    expect(calls.map((c) => c.body!.excludeAccounts)).toEqual([['acct-9'], ['acct-9', 'acct-34']])

    let m = 0
    const twice = fakePool(() => json({ error: 'timeout', reason: 'browser', accountId: ++m === 1 ? 'acct-34' : 'acct-5', retryAfterSeconds: 0 }))
    const e = await fetch1001(TL, { pool: twice.pool, priority: 'recheck' }).catch((x) => x)
    expect(e).toBeInstanceOf(PoolUnavailableError)
    expect(e).toMatchObject({ code: 'timeout', poolReason: 'browser', accountId: 'acct-5' })
    expect(e.message).toBe('page load stalled on acct-34 (tlpool stopped it); retried on another account: page load stalled on acct-5 (tlpool stopped it)')
    expect(isStopTheBatchError(e)).toBe(true)
    expect(twice.calls).toHaveLength(2)
  })

  it('no fetch1001 retry for queued / running / net_error / internal timeouts', async () => {
    for (const reason of ['queued', 'running', 'net_error', 'internal']) {
      const { calls, pool } = fakePool(() => json({ error: 'timeout', reason, accountId: 'acct-3', retryAfterSeconds: 0 }))
      const e = await fetch1001(TL, { pool, priority: 'new' }).catch((x) => x)
      expect(e, reason).toMatchObject({ code: 'timeout', poolReason: reason })
      expect(calls, reason).toHaveLength(1)
    }
  })

  it('no retry for a phone fetch or for any other pool refusal', async () => {
    const phone = fakePool(() => json({ error: 'timeout', retryAfterSeconds: 30 }))
    await fetch1001(TL, { pool: phone.pool }).catch((x) => x)
    expect(phone.calls).toHaveLength(1)
    for (const error of ['no_healthy_account', 'blocked', 'budget_exhausted']) {
      const other = fakePool(() => json({ error, retryAfterSeconds: 30 }))
      await fetch1001(TL, { pool: other.pool, priority: 'new' }).catch((x) => x)
      expect(other.calls, error).toHaveLength(1)
    }
  })

  it('a 404/410 from the site is final for the URL; a 5xx is a blip; 401/403/429 is the account, not the URL', async () => {
    for (const [status, cls] of [
      [404, UpstreamHttpError],
      [410, UpstreamHttpError],
      [503, UpstreamTransportError],
      [401, UpstreamUnavailableError],
      [429, UpstreamUnavailableError],
    ] as const) {
      const { pool } = fakePool(() => page('<html>err</html>', { status }))
      const e = await fetch1001(TL, { pool }).catch((x) => x)
      expect(e, String(status)).toBeInstanceOf(cls)
    }
  })

  it('a block page or a Cloudflare shell that gets through the browser stops the batch instead of charging the URL', async () => {
    const blocked = await fetch1001(TL, { pool: fakePool(() => page(BLOCK_HTML)).pool }).catch((x) => x)
    expect(blocked).toBeInstanceOf(IPBlockedError)
    expect(isStopTheBatchError(blocked)).toBe(true)
    const shell = '<html><div class="cf-turnstile" data-sitekey="x"></div></html>'
    const cf = await fetch1001(TL, { pool: fakePool(() => page(shell)).pool }).catch((x) => x)
    expect(cf).toBeInstanceOf(UpstreamUnavailableError)
  })

  it('fetchOptsFromEnv wires the pool from TLPOOL_* and the pause from CACHE; overrides win', () => {
    const env = makeEnv()
    const o = fetchOptsFromEnv(env, undefined, { priority: 'new' })
    expect(o.pool).toEqual({ url: POOL, token: 'pool-token' })
    expect(o.cacheKv).toBe(env.CACHE)
    expect(o.priority).toBe('new')
    expect(fetchOptsFromEnv(makeEnv({ TLPOOL_URL: undefined })).pool).toBeNull()
  })

  it('fetch1001Html passes the account through for verification', async () => {
    const r = await fetch1001Html(TL, { pool: fakePool(() => page('<html>x</html>')).pool, priority: 'verify', excludeAccounts: ['acct-1'] })
    expect(r).toMatchObject({ via: 'pool', accountId: 'acct-2', fetchedAt: '2026-09-29T10:00:00.000Z' })
  })
})

describe('each request kind', () => {
  it('fetchTracklist: kind set, parsed, account logged', async () => {
    const { calls, pool } = fakePool(() => page(TRACKLIST_HTML))
    const r = await fetchTracklist(TL, { pool, priority: 'phone' })
    expect(calls[0]!.body).toMatchObject({ url: TL, kind: 'set', priority: 'phone' })
    expect(r.via).toBe('pool')
    expect(r.accountId).toBe('acct-2')
    expect(r.result.tracks.length).toBeGreaterThan(0)
  })

  it('search: kind search, a POST with the search form and a Referer', async () => {
    const { calls, pool } = fakePool(() => page(SEARCH_HTML))
    await searchByYouTubeUrl('https://www.youtube.com/watch?v=abcdefghijk', { pool })
    expect(calls[0]!.body).toMatchObject({
      url: 'https://www.1001tracklists.com/search/result.php',
      kind: 'search',
      priority: 'phone',
      method: 'POST',
      form: { main_search: 'https://www.youtube.com/watch?v=abcdefghijk', search_selection: '9' },
      headers: { Referer: 'https://www.1001tracklists.com/search/result.php' },
    })
    await searchByTitle('Some Set Title', { pool })
    expect(calls[1]!.body).toMatchObject({ kind: 'search', method: 'POST' })
  })

  it('medialink: kind medialink, JSON parsed; a refusal comes back as failed (not cached by the caller)', async () => {
    const ml = fx('medialink-909720.json')
    const { calls, pool } = fakePool(() => page(ml))
    const ok = await fetchMediaLinks('909720', { pool })
    expect(calls[0]!.body).toMatchObject({ url: 'https://www.1001tracklists.com/ajax/get_medialink.php?idObject=5&idItem=909720', kind: 'medialink' })
    expect(ok.failed).toBeUndefined()
    expect(ok.result.appleLink ?? ok.result.youtubeLink).toBeTruthy()
    const refused = await fetchMediaLinks('909720', { pool: fakePool(() => json({ error: 'budget_exhausted' })).pool })
    expect(refused).toMatchObject({ failed: true, result: { appleLink: null, youtubeLink: null, soundcloudLink: null } })
  })
})
