/**
 * W8 review minors: sticky pushes in the service worker, anti-framing
 * headers, the live-view allowlist, raster-only captcha images, the
 * /subscriptions/accounts link, and the ban banner's poll limits.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import vm from 'node:vm'
import { Hono } from 'hono'
import { app as mainApp } from '../src/index'
import { createPoolUiApp } from '../src/routes/pool-ui'
import type { Fetcher } from '../src/lib/pool-admin-client'
import type { Env } from '../src/types'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'

const POOL = 'https://tlpool.example'
function makeEnv(): Env {
  return { CACHE: fakeKV(), SUBS: fakeKV(), DB: fakeD1(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k', DEV_BYPASS_CF_ACCESS: '1', TLPOOL_URL: POOL, TLPOOL_TOKEN: 'tok' } as unknown as Env
}
function fakePool(routes: Record<string, () => Response>) {
  const calls: string[] = []
  const fetcher: Fetcher = async (input) => {
    const url = typeof input === 'string' ? input : input.url
    calls.push(url)
    const h = routes[url.slice(POOL.length).split('?')[0]!]
    return h ? h() : Response.json({ error: 'not_found' }, { status: 404 })
  }
  return { fetcher, calls }
}
function mount(fetcher: Fetcher) {
  const root = new Hono<{ Bindings: Env }>()
  root.route('/subscriptions', createPoolUiApp({ fetcher }))
  return root
}
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)) }
type El = { textContent: string; innerHTML: string; hidden: boolean; addEventListener: () => void; classList: { toggle: () => void } }
const el = (): El => ({ textContent: '', innerHTML: '', hidden: false, addEventListener() {}, classList: { toggle() {} } })

afterEach(() => vi.unstubAllGlobals())

describe('service worker', () => {
  it('keeps captcha, flagged-account, held-playlist and ban pushes on screen until tapped (real payloads)', async () => {
    const text = await (await mainApp.request('https://tracked.example/subscriptions/sw.js', {}, makeEnv())).text()
    const handlers: Record<string, (ev: unknown) => void> = {}
    const shown: boolean[] = []
    const self = {
      addEventListener: (t: string, f: (ev: unknown) => void) => { handlers[t] = f },
      registration: { showNotification: (_t: string, o: { requireInteraction: boolean }) => (shown.push(o.requireInteraction), Promise.resolve()) },
      skipWaiting() {}, clients: { claim() {} }, location: { origin: 'https://tracked.example' },
    }
    vm.runInContext(text, vm.createContext({ self, URL }))
    const push = (payload: object) => handlers.push!({ data: { json: () => payload }, waitUntil: (p: Promise<unknown>) => p })
    const { poolEventPushPayload, sanitizePoolEvent } = await import('../src/lib/pool-events')
    const ev = sanitizePoolEvent({ type: 'challenge.created', challengeId: 'ch-1', accountId: 'acct-1', challengeType: 'image' })
    if (!ev.ok) throw new Error(ev.error)
    push(poolEventPushPayload(ev.event)!) // kind pool_challenge, as W4 sends it
    const flagged = sanitizePoolEvent({ type: 'account.flagged', accountId: 'acct-2', reason: 'decoys' })
    if (!flagged.ok) throw new Error(flagged.error)
    push(poolEventPushPayload(flagged.event)!)
    const { playlistHoldPayload } = await import('../src/lib/playlist-hygiene')
    push(playlistHoldPayload('Playlist check held', 'x'))
    push({ kind: 'test', title: 'Test', body: 'x', url: '/subscriptions', tag: 't', ts: new Date().toISOString() })
    expect(shown).toEqual([true, true, true, false])
  })
})

describe('framing and content types', () => {
  it('admin pages and API answers refuse framing; the live view may be framed by this origin only', async () => {
    const env = makeEnv()
    for (const path of ['/subscriptions', '/subscriptions/pool', '/subscriptions/captcha/ch-1', '/subscriptions/pool/settings', '/subscriptions/removed', '/subscriptions/api/pool/settings']) {
      const r = await mainApp.request(`https://tracked.example${path}`, {}, env)
      expect([path, r.headers.get('x-frame-options'), r.headers.get('content-security-policy')]).toEqual([path, 'DENY', "frame-ancestors 'none'"])
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>live</html>', { headers: { 'content-type': 'text/html' } })))
    const live = await mainApp.request('https://tracked.example/subscriptions/api/pool/challenges/ch-1/live/?path=x', {}, env)
    expect(live.status).toBe(200)
    expect(live.headers.get('x-frame-options')).toBe('SAMEORIGIN')
    expect(live.headers.get('content-security-policy')).toBe("frame-ancestors 'self'")
    expect(live.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('the live view proxies only the page, its websocket and noVNC core/vendor modules', async () => {
    const { fetcher, calls } = fakePool({
      '/challenges/ch-1/live/core/rfb.js': () => new Response('js', { headers: { 'content-type': 'text/javascript' } }),
      '/challenges/ch-1/live/vendor/pako/lib/zlib/inflate.js': () => new Response('<html>not js</html>', { headers: { 'content-type': 'text/html' } }),
    })
    for (const sub of ['vnc.html', 'vnc_lite.html', 'app/ui.js', 'core/', 'defaults.json', 'core/x.svg']) {
      const r = await mount(fetcher).request(`https://tracked.example/subscriptions/api/pool/challenges/ch-1/live/${sub}`, {}, makeEnv())
      expect([sub, r.status]).toEqual([sub, 404])
    }
    expect(calls).toHaveLength(0)
    expect((await mount(fetcher).request('https://tracked.example/subscriptions/api/pool/challenges/ch-1/live/core/rfb.js', {}, makeEnv())).status).toBe(200)
    // A module path that answers HTML is refused, not served on this origin.
    expect((await mount(fetcher).request('https://tracked.example/subscriptions/api/pool/challenges/ch-1/live/vendor/pako/lib/zlib/inflate.js', {}, makeEnv())).status).toBe(503)
  })

  it('the captcha image route passes PNG/JPEG/WebP only, with nosniff', async () => {
    const svg = fakePool({ '/challenges/ch-1/image': () => new Response('<svg onload="x()"/>', { headers: { 'content-type': 'image/svg+xml' } }) })
    expect((await mount(svg.fetcher).request('https://tracked.example/subscriptions/api/pool/challenges/ch-1/image', {}, makeEnv())).status).toBe(503)
    const png = fakePool({ '/challenges/ch-1/image': () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } }) })
    const r = await mount(png.fetcher).request('https://tracked.example/subscriptions/api/pool/challenges/ch-1/image', {}, makeEnv())
    expect(r.status).toBe(200)
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('/subscriptions/accounts (where flagged-account pushes point) goes to the pool page', async () => {
    const r = await mainApp.request('https://tracked.example/subscriptions/accounts', {}, makeEnv())
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('/subscriptions/pool')
  })
})

describe('the ban banner poll', () => {
  async function run(status: number, now: () => number) {
    const { BAN_JS } = await import('../src/routes/ban-ui')
    const timers: Array<{ fn: () => unknown; ms: number; done: boolean }> = []
    const els: Record<string, El> = {}
    const calls: string[] = []
    const document = { hidden: false, body: { dataset: { banPage: 'main' } }, getElementById: (id: string) => (els[id] ??= el()), addEventListener() {} }
    const FakeDate = class extends Date { static now() { return now() } }
    const ctx = vm.createContext({
      document, Date: FakeDate, console, navigator: {}, window: { isSecureContext: false }, sessionStorage: { getItem: () => '1', setItem() {} },
      fetch: async (u: string) => (calls.push(u), new Response(JSON.stringify({ error: 'x' }), { status })),
      setTimeout: (fn: () => unknown, ms: number) => (timers.push({ fn, ms, done: false }), timers.length), clearTimeout() {},
      setInterval: () => 0, alert() {},
    })
    vm.runInContext(BAN_JS, ctx)
    await settle()
    const pollTimers = () => timers.filter((x) => !x.done && x.ms >= 15000)
    const fire = async () => { for (const x of pollTimers()) { x.done = true; await x.fn() } await settle() }
    return { els, calls, document, fire, pollTimers }
  }

  it('stops with a sign-in note on 401', async () => {
    const a = await run(401, () => Date.now())
    await a.fire()
    expect(a.els['alerts-msg']!.textContent).toContain('sign in again')
    expect(a.pollTimers()).toHaveLength(0)
  })

  it('does not fetch while hidden, backs off on errors, and stops after 15 minutes', async () => {
    let clock = Date.now()
    const b = await run(503, () => clock)
    b.document.hidden = true
    const n = b.calls.length
    await b.fire()
    expect(b.calls.length).toBe(n)
    expect(b.pollTimers()).toHaveLength(0) // resumes on visibilitychange, not on a timer
    const c = await run(503, () => clock)
    await c.fire()
    expect(c.pollTimers().map((t) => t.ms)).toEqual([30000])
    clock += 15 * 60000 + 1
    const before = c.calls.length
    await c.fire()
    expect(c.calls.length).toBe(before)
    expect(c.pollTimers()).toHaveLength(0)
  })
})
