import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { fakeKV } from './helpers/fake-kv'
import type { Env } from '../src/types'
import { fetch1001, fetchOptsFromEnv, UpstreamPausedError } from '../src/lib/upstream1001'
import { fetchTracklist, searchByYouTubeUrl } from '../src/lib/tracklists1001'
import { fetch1001Html } from '../src/lib/dj-index'
import { _resetTallyForTests, getBanStatus, getHomeBan, getPause, setPause } from '../src/lib/ban-state'
import { IPBlockedError, CloudflareChallengeError } from '../src/lib/fetch'

const here = dirname(fileURLToPath(import.meta.url))
const fx = (name: string) => readFileSync(resolve(here, 'fixtures', name), 'utf8')
const TRACKLIST_HTML = fx('tracklist-matroda.html')
const BLOCK_HTML = fx('ip-block-tracklist.html')
const SEARCH_HTML = fx('search-result.html')

const PROXY = 'https://proxy.example'
const TL = 'https://www.1001tracklists.com/tracklist/abc/def.html'

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    CACHE: fakeKV(),
    SUBS: fakeKV(),
    API_TOKEN: 't',
    YOUTUBE_API_KEY: 'k',
    HOME_PROXY_URL: PROXY,
    HOME_PROXY_TOKEN: 'tok',
    ...overrides,
  } as Env
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>
type Calls = Array<{ url: string; init: RequestInit }>
function routeFetch(handlers: { proxy?: Handler; brightdata?: Handler; direct?: Handler }): Calls {
  const calls: Calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.startsWith(PROXY)) return handlers.proxy ? handlers.proxy(url, init) : new Response('no proxy handler', { status: 599 })
      if (url.startsWith('https://api.brightdata.com/')) return handlers.brightdata ? handlers.brightdata(url, init) : new Response('no bd handler', { status: 599 })
      return handlers.direct ? handlers.direct(url, init) : new Response('no direct handler', { status: 599 })
    }),
  )
  return calls
}

const proxyOk = (html: string, headers: Record<string, string> = {}) =>
  new Response(html, { status: 200, headers: { 'x-proxy-route': 'direct', 'x-proxy-egress': 'direct', 'x-proxy-upstream-status': '200', 'x-proxy-attempts': 'direct:ok', 'x-proxy-pool-healthy': '19', 'x-proxy-pool-total': '19', ...headers } })
const POOL_HEADERS = {
  'x-proxy-route': 'pool',
  'x-proxy-egress': 'bgp1:18183',
  'x-proxy-attempts': 'direct:ip_blocked,bgp1:18183:ok',
  'x-proxy-direct-blocked-until': '2026-09-10T16:00:00.000Z',
  'x-proxy-direct-blocked-since': '2026-09-10T15:00:00.000Z',
  'x-proxy-direct-blocked-ip': '68.1.2.3',
  'x-proxy-pool-healthy': '18',
}
const proxyAllBlocked = () =>
  new Response(BLOCK_HTML, {
    status: 503,
    headers: { 'x-proxy-route': 'none', 'x-proxy-all-blocked': '1', 'x-proxy-attempts': 'direct:ip_blocked,bgp1:18180:ip_blocked', 'x-proxy-direct-blocked-until': '2026-09-10T16:00:00.000Z', 'x-proxy-direct-blocked-ip': '68.1.2.3', 'x-proxy-pool-healthy': '0', 'x-proxy-pool-total': '19' },
  })
const bdOk = (body: string) => new Response(JSON.stringify({ status_code: 200, headers: {}, body }), { status: 200 })

beforeEach(() => {
  _resetTallyForTests()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-10T15:10:00.000Z'))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('fetch1001 cascade', () => {
  it('serves from the forwarder (direct) and touches nothing else', async () => {
    const env = makeEnv({ BRIGHTDATA_API_KEY: 'bd' })
    const calls = routeFetch({ proxy: () => proxyOk(TRACKLIST_HTML) })
    const r = await fetch1001(TL, fetchOptsFromEnv(env))
    expect(r.via).toBe('home-proxy')
    expect(r.html).toBe(TRACKLIST_HTML)
    expect(calls.map((c) => c.url)).toEqual([`${PROXY}/?url=${encodeURIComponent(TL)}`])
    expect(await getHomeBan(env)).toBeNull()
  })

  it('reports via=home-proxy-pool and opens a ban episode when the forwarder rerouted around a blocked home IP', async () => {
    const env = makeEnv()
    routeFetch({ proxy: () => proxyOk(TRACKLIST_HTML, POOL_HEADERS) })
    const r = await fetch1001(TL, fetchOptsFromEnv(env))
    expect(r.via).toBe('home-proxy-pool')
    expect(r.proxy?.egress).toBe('bgp1:18183')
    const home = await getHomeBan(env)
    expect(home).toMatchObject({ ip: '68.1.2.3', until: '2026-09-10T16:00:00.000Z', poolHealthy: 18 })
    expect(await getPause(env)).toBeNull()
  })

  it('falls through to BrightData (budgeted) when every forwarder route is blocked, and sets the pause', async () => {
    const env = makeEnv({ BRIGHTDATA_API_KEY: 'bd', BRIGHTDATA_DAILY_CAP: '5' })
    const calls = routeFetch({ proxy: () => proxyAllBlocked(), brightdata: () => bdOk(TRACKLIST_HTML) })
    const r = await fetch1001(TL, fetchOptsFromEnv(env))
    expect(r.via).toBe('unlocker')
    expect(calls.map((c) => new URL(c.url).host)).toEqual(['proxy.example', 'api.brightdata.com'])
    expect(await getPause(env)).toMatchObject({ reason: 'all_routes_blocked', ip: '68.1.2.3' })
    const st = await getBanStatus(env)
    expect(st.brightdata.used).toBe(1)
    expect(st.home?.ip).toBe('68.1.2.3')
  })

  it('throws UpstreamPausedError instead of touching anything once paused and BrightData budget is spent', async () => {
    const env = makeEnv({ BRIGHTDATA_API_KEY: 'bd', BRIGHTDATA_DAILY_CAP: '0' })
    await setPause(env, 'all_routes_blocked', '68.1.2.3')
    const calls = routeFetch({})
    await expect(fetch1001(TL, fetchOptsFromEnv(env))).rejects.toBeInstanceOf(UpstreamPausedError)
    expect(calls).toEqual([])
  })

  it('while paused with no BrightData, throws UpstreamPausedError without hitting 1001tl directly', async () => {
    const env = makeEnv()
    await setPause(env, 'all_routes_blocked', null)
    const calls = routeFetch({})
    const err = await fetch1001(TL, fetchOptsFromEnv(env)).catch((e) => e)
    expect(err).toBeInstanceOf(UpstreamPausedError)
    expect(err.until).toBe('2026-09-10T16:10:00.000Z')
    expect(calls).toEqual([])
  })

  it('all routes blocked and no BrightData → UpstreamPausedError (the batch stops)', async () => {
    const env = makeEnv()
    const calls = routeFetch({ proxy: () => proxyAllBlocked() })
    await expect(fetch1001(TL, fetchOptsFromEnv(env))).rejects.toBeInstanceOf(UpstreamPausedError)
    expect(calls).toHaveLength(1)
    expect(await getPause(env)).not.toBeNull()
  })

  it('a forwarder transport failure still falls through to BrightData, then direct, without any ban state', async () => {
    const env = makeEnv({ BRIGHTDATA_API_KEY: 'bd' })
    routeFetch({
      proxy: () => {
        throw new TypeError('fetch failed')
      },
      brightdata: () => bdOk(TRACKLIST_HTML),
    })
    const r = await fetch1001(TL, fetchOptsFromEnv(env))
    expect(r.via).toBe('unlocker')
    expect(await getHomeBan(env)).toBeNull()
    expect(await getPause(env)).toBeNull()
  })

  it('falls through when the forwarder body fails the accept predicate', async () => {
    const env = makeEnv({ BRIGHTDATA_API_KEY: 'bd' })
    routeFetch({ proxy: () => proxyOk('<html>no tracks here</html>'), brightdata: () => bdOk(TRACKLIST_HTML) })
    const r = await fetch1001(TL, { ...fetchOptsFromEnv(env), accept: (html) => html.includes('tlpItem') })
    expect(r.via).toBe('unlocker')
  })

  it('BrightData returning the block page surfaces IPBlockedError; a CF shell retries up to unlockerAttempts', async () => {
    const env = makeEnv({ BRIGHTDATA_API_KEY: 'bd' })
    routeFetch({ proxy: () => proxyAllBlocked(), brightdata: () => bdOk(BLOCK_HTML) })
    await expect(fetch1001(TL, fetchOptsFromEnv(env))).rejects.toBeInstanceOf(IPBlockedError)
    vi.unstubAllGlobals()
    const shell = '<html><div id="turnstile-container"></div><script src="challenge-platform"></script></html>'
    const calls = routeFetch({ proxy: () => proxyAllBlocked(), brightdata: () => bdOk(shell) })
    await expect(fetch1001(TL, { ...fetchOptsFromEnv(env), unlockerAttempts: 2 })).rejects.toBeInstanceOf(CloudflareChallengeError)
    expect(calls.filter((c) => c.url.includes('brightdata')).length).toBe(2)
    // Both attempts were charged to today's budget (1 from the first test run above + 2 here).
    expect((await getBanStatus(env)).brightdata.used).toBe(3)
  })

  it('POSTs form fields through the forwarder', async () => {
    const env = makeEnv()
    const calls = routeFetch({ proxy: () => proxyOk(SEARCH_HTML) })
    const r = await fetch1001('https://www.1001tracklists.com/search/result.php', { ...fetchOptsFromEnv(env), method: 'POST', form: { main_search: 'x', search_selection: '9' } })
    expect(r.via).toBe('home-proxy')
    const init = calls[0]!.init
    expect(init.method).toBe('POST')
    expect(init.body).toBe('main_search=x&search_selection=9')
  })

  it('falls back to the Worker egress with no forwarder configured (legacy behaviour)', async () => {
    const env = makeEnv({ HOME_PROXY_URL: undefined, HOME_PROXY_TOKEN: undefined })
    const calls = routeFetch({ direct: () => new Response(TRACKLIST_HTML, { status: 200 }) })
    const r = await fetch1001(TL, fetchOptsFromEnv(env))
    expect(r.via).toBe('direct')
    expect(calls[0]!.url).toBe(TL)
  })
})

describe('wrappers', () => {
  it('fetchTracklist parses the forwarder result and reports via/egress', async () => {
    const env = makeEnv()
    routeFetch({ proxy: () => proxyOk(TRACKLIST_HTML, POOL_HEADERS) })
    const r = await fetchTracklist(TL, fetchOptsFromEnv(env))
    expect(r.result.tracks.length).toBeGreaterThan(0)
    expect(r.via).toBe('home-proxy-pool')
  })

  it('fetchTracklist falls through to BrightData when the forwarder page parses to zero tracks', async () => {
    const env = makeEnv({ BRIGHTDATA_API_KEY: 'bd' })
    const calls = routeFetch({ proxy: () => proxyOk('<html><body>nothing</body></html>'), brightdata: () => bdOk(TRACKLIST_HTML) })
    const r = await fetchTracklist(TL, fetchOptsFromEnv(env))
    expect(r.via).toBe('unlocker')
    expect(r.result.tracks.length).toBeGreaterThan(0)
    expect(calls).toHaveLength(2)
  })

  it('fetch1001Html uses a single BrightData attempt', async () => {
    const env = makeEnv({ BRIGHTDATA_API_KEY: 'bd' })
    const shell = '<html><div id="turnstile-container"></div><script src="challenge-platform"></script></html>'
    const calls = routeFetch({ proxy: () => proxyAllBlocked(), brightdata: () => bdOk(shell) })
    await expect(fetch1001Html(TL, fetchOptsFromEnv(env))).rejects.toBeInstanceOf(CloudflareChallengeError)
    expect(calls.filter((c) => c.url.includes('brightdata')).length).toBe(1)
  })

  it('searchByYouTubeUrl goes through the forwarder as a POST and still parses results', async () => {
    const env = makeEnv()
    const calls = routeFetch({ proxy: () => proxyOk(SEARCH_HTML) })
    const { result } = await searchByYouTubeUrl('https://www.youtube.com/watch?v=abcdefghijk', fetchOptsFromEnv(env))
    expect(calls[0]!.url).toBe(`${PROXY}/?url=${encodeURIComponent('https://www.1001tracklists.com/search/result.php')}`)
    expect(calls[0]!.init.method).toBe('POST')
    expect(String(calls[0]!.init.body)).toContain('main_search=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dabcdefghijk')
    expect('tracklistUrl' in result).toBe(true)
  })

  it('searchByYouTubeUrl keeps the legacy (state, log) signature for direct calls', async () => {
    routeFetch({ direct: () => new Response(SEARCH_HTML, { status: 200 }) })
    const { result } = await searchByYouTubeUrl('https://www.youtube.com/watch?v=abcdefghijk', { cookie: '' })
    expect('tracklistUrl' in result).toBe(true)
  })
})
