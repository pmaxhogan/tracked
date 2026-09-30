import { describe, it, expect, beforeEach } from 'vitest'
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
import { PHONE_MAX_WAIT_SECONDS, PoolPausedError, PoolUnavailableError, poolConfigFromEnv, poolFetch, poolRetestAccount } from '../src/lib/pool'
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
