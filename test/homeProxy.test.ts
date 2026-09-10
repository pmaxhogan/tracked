import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchViaHomeProxy, probeHomeProxy, fetchHomeProxyStatus } from '../src/lib/homeProxy'

const PROXY = 'https://proxy.example/'
const TOKEN = 'tok'

type Call = { url: string; init: RequestInit }
function mockFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} }
    calls.push(call)
    return handler(call)
  })
  vi.stubGlobal('fetch', fn)
  return { calls, fn }
}

afterEach(() => vi.unstubAllGlobals())

describe('fetchViaHomeProxy', () => {
  it('sends the bearer, encodes the target and reads the route headers on a direct hit', async () => {
    const { calls } = mockFetch(() =>
      new Response('<html>page</html>', {
        status: 200,
        headers: { 'x-proxy-route': 'direct', 'x-proxy-egress': 'direct', 'x-proxy-upstream-status': '200', 'x-proxy-attempts': 'direct:ok', 'x-proxy-pool-healthy': '19', 'x-proxy-pool-total': '19' },
      }),
    )
    const r = await fetchViaHomeProxy('https://www.1001tracklists.com/tracklist/x/y.html', PROXY, TOKEN)
    expect(calls[0]!.url).toBe('https://proxy.example/?url=https%3A%2F%2Fwww.1001tracklists.com%2Ftracklist%2Fx%2Fy.html')
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    expect(r).toMatchObject({ kind: 'ok', status: 200, html: '<html>page</html>', route: 'direct', egress: 'direct', upstreamStatus: 200, attempts: 'direct:ok', directBlocked: null, directRecovered: false, poolHealthy: 19, poolTotal: 19 })
  })

  it('reports a pool-served success with the residential IP in cooldown', async () => {
    mockFetch(() =>
      new Response('<html>page</html>', {
        status: 200,
        headers: {
          'x-proxy-route': 'pool',
          'x-proxy-egress': 'bgp1:18183',
          'x-proxy-upstream-status': '200',
          'x-proxy-attempts': 'direct:ip_blocked,bgp1:18183:ok',
          'x-proxy-direct-blocked-until': '2026-09-10T16:00:00.000Z',
          'x-proxy-direct-blocked-since': '2026-09-10T15:00:00.000Z',
          'x-proxy-direct-blocked-ip': '68.1.2.3',
          'x-proxy-pool-healthy': '18',
          'x-proxy-pool-total': '19',
        },
      }),
    )
    const r = await fetchViaHomeProxy('https://www.1001tracklists.com/tracklist/x/y.html', PROXY, TOKEN)
    expect(r.kind).toBe('ok')
    expect(r.route).toBe('pool')
    expect(r.egress).toBe('bgp1:18183')
    expect(r.directBlocked).toEqual({ until: '2026-09-10T16:00:00.000Z', since: '2026-09-10T15:00:00.000Z', ip: '68.1.2.3' })
  })

  it('keeps the block page body when every route is blocked (503 + X-Proxy-All-Blocked)', async () => {
    mockFetch(() =>
      new Response('<form action="/info/unblock_ip.html">Your IP is 68.1.2.3</form>', {
        status: 503,
        headers: { 'x-proxy-route': 'none', 'x-proxy-all-blocked': '1', 'x-proxy-attempts': 'direct:ip_blocked,bgp1:18180:ip_blocked', 'x-proxy-direct-blocked-until': '2026-09-10T16:00:00.000Z', 'x-proxy-blocked-ip': '68.1.2.3' },
      }),
    )
    const r = await fetchViaHomeProxy('https://www.1001tracklists.com/tracklist/x/y.html', PROXY, TOKEN)
    expect(r.kind).toBe('all_blocked')
    expect(r.status).toBe(503)
    expect(r.html).toContain('unblock_ip')
    expect(r.errorMessage).toMatch(/every route blocked/)
    expect(r.directBlocked?.until).toBe('2026-09-10T16:00:00.000Z')
  })

  it('distinguishes an upstream 404 (served) from a forwarder error (unserved)', async () => {
    mockFetch(() => new Response('nope', { status: 404, headers: { 'x-proxy-route': 'direct', 'x-proxy-upstream-status': '404' } }))
    const served = await fetchViaHomeProxy('https://www.1001tracklists.com/x', PROXY, TOKEN)
    expect(served.kind).toBe('upstream_error')
    expect(served.html).toBe('nope')
    vi.unstubAllGlobals()
    mockFetch(() => new Response('unauthorized', { status: 401 }))
    const refused = await fetchViaHomeProxy('https://www.1001tracklists.com/x', PROXY, TOKEN)
    expect(refused.kind).toBe('proxy_error')
    expect(refused.errorMessage).toMatch(/home proxy 401/)
  })

  it('returns kind=transport when the forwarder is unreachable', async () => {
    mockFetch(() => {
      throw new TypeError('fetch failed')
    })
    const r = await fetchViaHomeProxy('https://www.1001tracklists.com/x', PROXY, TOKEN)
    expect(r).toMatchObject({ kind: 'transport', status: 0, html: '', errorMessage: 'fetch failed' })
  })

  it('forwards POST bodies, extra headers and the force-route override', async () => {
    const { calls } = mockFetch(() => new Response('ok', { status: 200, headers: { 'x-proxy-route': 'pool', 'x-proxy-egress': 'vm1:18180' } }))
    await fetchViaHomeProxy('https://www.1001tracklists.com/search/result.php', PROXY, TOKEN, undefined, {
      method: 'POST',
      body: 'main_search=x&search_selection=9',
      headers: { Referer: 'https://www.1001tracklists.com/search/result.php' },
      forceRoute: 'pool',
    })
    const init = calls[0]!.init
    const h = init.headers as Record<string, string>
    expect(init.method).toBe('POST')
    expect(init.body).toBe('main_search=x&search_selection=9')
    expect(h['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(h['X-Proxy-Force-Route']).toBe('pool')
    expect(h.Referer).toBe('https://www.1001tracklists.com/search/result.php')
  })
})

describe('probeHomeProxy / fetchHomeProxyStatus', () => {
  it('POSTs /probe with the bearer and returns the JSON', async () => {
    const { calls } = mockFetch(() => new Response(JSON.stringify({ probe: 'ok', status: 200, wasBlocked: true, poolHealthy: 19, poolTotal: 19 }), { status: 200 }))
    const r = await probeHomeProxy(PROXY, TOKEN)
    expect(calls[0]!.url).toBe('https://proxy.example/probe')
    expect(calls[0]!.init.method).toBe('POST')
    expect(r.probe).toBe('ok')
    expect(r.wasBlocked).toBe(true)
  })

  it('GETs /status and throws on a non-2xx', async () => {
    mockFetch(() => new Response(JSON.stringify({ version: '0.3.0', poolHealthy: 3, poolTotal: 3 }), { status: 200 }))
    expect((await fetchHomeProxyStatus(PROXY, TOKEN)).version).toBe('0.3.0')
    vi.unstubAllGlobals()
    mockFetch(() => new Response('unauthorized', { status: 401 }))
    await expect(fetchHomeProxyStatus(PROXY, TOKEN)).rejects.toThrow(/401/)
  })
})
