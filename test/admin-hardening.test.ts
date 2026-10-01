/**
 * W8 review minors: sticky pushes in the service worker, anti-framing
 * headers, the live-view allowlist, raster-only captcha images, the
 * /ui/accounts link, and the ban banner's poll limits.
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
  root.route('/ui', createPoolUiApp({ fetcher }))
  return root
}
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)) }
type El = { textContent: string; innerHTML: string; hidden: boolean; addEventListener: () => void; classList: { toggle: () => void } }
const el = (): El => ({ textContent: '', innerHTML: '', hidden: false, addEventListener() {}, classList: { toggle() {} } })

afterEach(() => vi.unstubAllGlobals())

describe('service worker', () => {
  it('keeps captcha, flagged-account, held-playlist and ban pushes on screen until tapped (real payloads)', async () => {
    const text = await (await mainApp.request('https://tracked.example/ui/sw.js', {}, makeEnv())).text()
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
    push({ kind: 'test', title: 'Test', body: 'x', url: '/ui', tag: 't', ts: new Date().toISOString() })
    expect(shown).toEqual([true, true, true, false])
  })
})

describe('push payload URLs point under /ui', () => {
  it('captcha, flagged account and held playlist pushes open the new pages', async () => {
    const { poolEventPushPayload, sanitizePoolEvent } = await import('../src/lib/pool-events')
    const ch = sanitizePoolEvent({ type: 'challenge.created', challengeId: 'ch-1', accountId: 'acct-1', challengeType: 'image' })
    if (!ch.ok) throw new Error(ch.error)
    expect(poolEventPushPayload(ch.event)!.url).toBe('/ui/captcha/ch-1')
    const flagged = sanitizePoolEvent({ type: 'account.flagged', accountId: 'acct-2', reason: 'decoys' })
    if (!flagged.ok) throw new Error(flagged.error)
    expect(poolEventPushPayload(flagged.event)!.url).toBe('/ui/pool')
    const { playlistHoldPayload } = await import('../src/lib/playlist-hygiene')
    expect(playlistHoldPayload('Playlist check held', 'x').url).toBe('/ui/removed')
  })
})

describe('old service worker cleanup', () => {
  /**
   * A browser in which /ui/sw.js is not registered yet: register() resolves with
   * an installing worker that activates a macrotask later, and subscribe()
   * rejects until then (Chromium: "no active Service Worker").
   */
  async function runMigration(opts: { old: boolean; install?: 'activated' | 'redundant' | 'stuck'; subscribeStatus?: number; existingSub?: boolean; storage?: Map<string, string> }) {
    const { BAN_JS } = await import('../src/routes/ban-ui')
    const posts: Array<{ url: string; body: string }> = []
    const registered: Array<[string, unknown]> = []
    const log: string[] = []
    let oldUnregistered = 0
    let newUnregistered = 0
    let oldUnsubscribed = 0
    let requestPermission = 0
    let subscribeRejected = 0
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
    const oldReg = {
      scope: 'https://tracked.example/subscriptions/',
      pushManager: { getSubscription: async () => ({ endpoint: 'https://push.example/old', unsubscribe: async () => { oldUnsubscribed++; log.push('old.unsubscribe'); return true } }) },
      unregister: async () => { oldUnregistered++; log.push('old.unregister'); return true },
    }
    const listeners: Array<() => void> = []
    let worker = { state: 'installing', addEventListener: (type: string, fn: () => void) => { if (type === 'statechange') listeners.push(fn) } }
    let newSub: { endpoint: string; toJSON: () => object } | null = opts.existingSub ? { endpoint: 'https://push.example/new', toJSON: () => ({ endpoint: 'https://push.example/new', keys: { p256dh: 'p', auth: 'a' } }) } : null
    const newReg: Record<string, unknown> = {
      scope: 'https://tracked.example/ui/',
      active: null, installing: null, waiting: null,
      pushManager: {
        getSubscription: async () => newSub,
        subscribe: async () => {
          if (!newReg.active) { subscribeRejected++; throw new Error('AbortError: Subscription failed - no active Service Worker') }
          log.push('subscribe')
          return (newSub = { endpoint: 'https://push.example/new', toJSON: () => ({ endpoint: 'https://push.example/new', keys: { p256dh: 'p', auth: 'a' } }) })
        },
      },
      unregister: async () => { newUnregistered++; return true },
    }
    const activate = () => {
      if (opts.install === 'redundant') { worker.state = 'redundant'; newReg.installing = null } // the install failed
      else { worker.state = 'activated'; newReg.active = worker; newReg.installing = null }
      for (const f of listeners.splice(0)) f()
    }
    const navigator = {
      userAgent: 'test',
      serviceWorker: {
        getRegistrations: async () => (opts.old ? [oldReg] : []),
        register: async (url: string, o: unknown) => {
          registered.push([url, o])
          if (!newReg.active) { worker = { ...worker, state: 'installing' }; newReg.installing = worker; if (opts.install !== 'stuck') setTimeout(activate, 0) } // Node's timer, not the page's
          return newReg
        },
      },
    }
    const Notification = { permission: 'granted', requestPermission: async () => { requestPermission++; return 'granted' } }
    const window = { isSecureContext: true, PushManager: {}, Notification }
    const els: Record<string, El> = {}
    const enableClicks: Array<() => unknown> = []
    els['alerts-enable'] = { ...el(), addEventListener: ((type: string, fn: () => unknown) => { if (type === 'click') enableClicks.push(fn) }) as El['addEventListener'] }
    const document = { hidden: false, body: { dataset: { banPage: 'other' } }, getElementById: (id: string) => (els[id] ??= el()), addEventListener() {} }
    const ctx = vm.createContext({
      document, navigator, window, Notification, atob, Uint8Array, console, Date,
      sessionStorage: opts.storage ? { getItem: (k: string) => opts.storage!.get(k) ?? null, setItem: (k: string, v: string) => { opts.storage!.set(k, v) } } : { getItem: () => '1', setItem() {} },
      fetch: async (u: string, init?: { method?: string; body?: string }) => {
        if (init && init.method === 'POST') { posts.push({ url: u, body: String(init.body) }); log.push('POST ' + u) }
        if (u === '/ui/api/push/subscribe' && opts.subscribeStatus) return new Response('{}', { status: opts.subscribeStatus })
        if (u === '/ui/api/push/config') return Response.json({ configured: true, publicKey: 'AQAB' })
        return Response.json({})
      },
      setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms, cleared: false }); return timers.length },
      clearTimeout: (id: number) => { if (timers[id - 1]) timers[id - 1]!.cleared = true },
      setInterval: () => 0, alert() {},
    })
    vm.runInContext(BAN_JS, ctx)
    await settle()
    const fireActivationTimeout = async () => { for (const t of timers) if (t.ms === 10000 && !t.cleared) { t.cleared = true; t.fn() } await settle() }
    const clickEnable = async () => { for (const f of enableClicks) await f(); await settle() }
    return { posts, registered, log, els, clickEnable, fireActivationTimeout, timers, oldUnregistered: () => oldUnregistered, newUnregistered: () => newUnregistered, oldUnsubscribed: () => oldUnsubscribed, requestPermission: () => requestPermission, subscribeRejected: () => subscribeRejected }
  }

  it('subscribes under /ui/ once the new worker is active, then drops the /subscriptions/ registration and its push subscription, without a prompt', async () => {
    const m = await runMigration({ old: true })
    expect(m.registered).toEqual([['/ui/sw.js', { scope: '/ui/' }]])
    expect(m.subscribeRejected()).toBe(0)
    expect(m.posts.filter((p) => p.url === '/ui/api/push/subscribe')).toHaveLength(1)
    expect(m.posts.filter((p) => p.url === '/ui/api/push/unsubscribe')).toEqual([{ url: '/ui/api/push/unsubscribe', body: '{"endpoint":"https://push.example/old"}' }])
    expect(m.oldUnsubscribed()).toBe(1)
    expect(m.oldUnregistered()).toBe(1)
    expect(m.newUnregistered()).toBe(0)
    expect(m.posts.every((p) => p.url.startsWith('/ui/'))).toBe(true)
    expect(m.requestPermission()).toBe(0)
    // The old subscription goes only after the new one is on the server.
    expect(m.log).toEqual(['subscribe', 'POST /ui/api/push/subscribe', 'POST /ui/api/push/unsubscribe', 'old.unsubscribe', 'old.unregister'])
  })

  it('re-subscribes a device whose permission is granted but has no subscription, with no old registration', async () => {
    const m = await runMigration({ old: false })
    expect(m.registered).toEqual([['/ui/sw.js', { scope: '/ui/' }]])
    expect(m.posts.filter((p) => p.url === '/ui/api/push/subscribe')).toHaveLength(1)
    expect(m.posts.filter((p) => p.url === '/ui/api/push/unsubscribe')).toHaveLength(0)
    expect(m.requestPermission()).toBe(0)
    expect(m.els['alerts-state']!.textContent).toBe('on (this device)')
  })

  it('a worker that fails to install (redundant): no subscribe, the old registration stays, the error shows, and Enable retries the install', async () => {
    const m = await runMigration({ old: true, install: 'redundant' })
    expect(m.registered).toEqual([['/ui/sw.js', { scope: '/ui/' }]])
    expect(m.subscribeRejected()).toBe(0)
    expect(m.log).toEqual([]) // no subscribe, no POST subscribe, nothing dropped
    expect(m.posts.filter((p) => /push\/(un)?subscribe/.test(p.url))).toEqual([])
    expect(m.oldUnsubscribed()).toBe(0)
    expect(m.oldUnregistered()).toBe(0)
    expect(m.els['alerts-state']!.textContent).toBe('error')
    expect(m.els['alerts-msg']!.textContent).toContain('failed to install')
    // The rejected registration is not cached: pressing Enable registers again.
    await m.clickEnable()
    expect(m.registered).toHaveLength(2)
    expect(m.els['alerts-state']!.textContent).toBe('error')
  })

  it('a worker stuck in installing times out after 10 s: no subscribe, the old registration stays, the error shows, and Enable registers again', async () => {
    const m = await runMigration({ old: true, install: 'stuck' })
    expect(m.registered).toHaveLength(1)
    expect(m.timers.some((t) => t.ms === 10000 && !t.cleared)).toBe(true)
    expect(m.els['alerts-state']!.textContent).not.toBe('error') // still waiting
    await m.fireActivationTimeout()
    expect(m.subscribeRejected()).toBe(0)
    expect(m.log).toEqual([])
    expect(m.oldUnsubscribed()).toBe(0)
    expect(m.oldUnregistered()).toBe(0)
    expect(m.els['alerts-state']!.textContent).toBe('error')
    expect(m.els['alerts-msg']!.textContent).toContain('did not activate')
    await m.clickEnable()
    expect(m.registered).toHaveLength(2)
  })

  it('an existing subscription is re-sent once per browser session, not on every page view', async () => {
    const storage = new Map<string, string>()
    const first = await runMigration({ old: false, existingSub: true, storage })
    expect(first.posts.filter((p) => p.url === '/ui/api/push/subscribe')).toHaveLength(1)
    expect(storage.get('ban-push-synced')).toBe('1')
    const second = await runMigration({ old: false, existingSub: true, storage })
    expect(second.posts.filter((p) => p.url === '/ui/api/push/subscribe')).toHaveLength(0)
    expect(second.els['alerts-state']!.textContent).toBe('on (this device)')
    // A new session (empty storage) sends it again.
    const third = await runMigration({ old: false, existingSub: true, storage: new Map() })
    expect(third.posts.filter((p) => p.url === '/ui/api/push/subscribe')).toHaveLength(1)
  })

  it('when the subscribe POST fails (500), the old registration and its subscription are kept', async () => {
    const m = await runMigration({ old: true, subscribeStatus: 500 })
    expect(m.posts.filter((p) => p.url === '/ui/api/push/subscribe').length).toBeGreaterThan(0)
    expect(m.posts.filter((p) => p.url === '/ui/api/push/unsubscribe')).toEqual([])
    expect(m.oldUnsubscribed()).toBe(0)
    expect(m.oldUnregistered()).toBe(0)
    expect(m.log).not.toContain('old.unsubscribe')
    expect(m.log).not.toContain('old.unregister')
  })
})

describe('framing and content types', () => {
  it('admin pages and API answers refuse framing; the live view may be framed by this origin only', async () => {
    const env = makeEnv()
    for (const path of ['/ui', '/ui/pool', '/ui/captcha/ch-1', '/ui/pool/settings', '/ui/removed', '/ui/api/pool/settings']) {
      const r = await mainApp.request(`https://tracked.example${path}`, {}, env)
      expect([path, r.headers.get('x-frame-options'), r.headers.get('content-security-policy')]).toEqual([path, 'DENY', "frame-ancestors 'none'"])
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>live</html>', { headers: { 'content-type': 'text/html' } })))
    const live = await mainApp.request('https://tracked.example/ui/api/pool/challenges/ch-1/live/?path=x', {}, env)
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
      const r = await mount(fetcher).request(`https://tracked.example/ui/api/pool/challenges/ch-1/live/${sub}`, {}, makeEnv())
      expect([sub, r.status]).toEqual([sub, 404])
    }
    expect(calls).toHaveLength(0)
    expect((await mount(fetcher).request('https://tracked.example/ui/api/pool/challenges/ch-1/live/core/rfb.js', {}, makeEnv())).status).toBe(200)
    // A module path that answers HTML is refused, not served on this origin.
    expect((await mount(fetcher).request('https://tracked.example/ui/api/pool/challenges/ch-1/live/vendor/pako/lib/zlib/inflate.js', {}, makeEnv())).status).toBe(503)
  })

  it('the captcha image route passes PNG/JPEG/WebP only, with nosniff', async () => {
    const svg = fakePool({ '/challenges/ch-1/image': () => new Response('<svg onload="x()"/>', { headers: { 'content-type': 'image/svg+xml' } }) })
    expect((await mount(svg.fetcher).request('https://tracked.example/ui/api/pool/challenges/ch-1/image', {}, makeEnv())).status).toBe(503)
    const png = fakePool({ '/challenges/ch-1/image': () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } }) })
    const r = await mount(png.fetcher).request('https://tracked.example/ui/api/pool/challenges/ch-1/image', {}, makeEnv())
    expect(r.status).toBe(200)
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('/ui/accounts (where flagged-account pushes point) goes to the pool page', async () => {
    const r = await mainApp.request('https://tracked.example/ui/accounts', {}, makeEnv())
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('/ui/pool')
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
