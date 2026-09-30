import { describe, it, expect, vi, afterEach } from 'vitest'
import vm from 'node:vm'
import { app } from '../src/index'
import { shell } from '../src/ui/shell'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'
import type { Env } from '../src/types'

const env = (extra: Record<string, unknown> = {}) => ({ CACHE: fakeKV(), SUBS: fakeKV(), DB: fakeD1(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k', DEV_BYPASS_CF_ACCESS: '1', ...extra }) as unknown as Env
const lockedEnv = () => env({ DEV_BYPASS_CF_ACCESS: undefined, CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CF_ACCESS_AUD: 'aud', CF_ACCESS_ALLOWED_EMAILS: 'owner@example.com', TLPOOL_URL: 'https://tlpool.example', TLPOOL_TOKEN: 'x' })
const scriptsOf = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
afterEach(() => vi.unstubAllGlobals())

/** Every shell page: path and the h1 text it must carry. Page tasks add rows. */
export const PAGES: Array<[string, string]> = [
  ['/ui/pool', 'Pool accounts'],
  ['/ui/pool/settings', 'Pool settings'],
  ['/ui/captcha', 'Captchas'],
  ['/ui/captcha/ch-1', 'Captcha'],
  ['/ui/set', 'Set'],
  ['/ui/dj/some-dj', ''],
]

/** The pool tests' stub: no body, window, navigator, storage, location or history. */
function minimalStub() {
  const el = (): any => ({ innerHTML: '', textContent: '', value: '', hidden: false, checked: false, disabled: false, className: '', src: '', dataset: {}, style: {}, options: [],
    addEventListener() {}, focus() {}, add() {}, remove() {}, showModal() {}, close() {}, querySelector: () => el(), querySelectorAll: () => [], closest: () => null })
  const els = new Map<string, any>()
  const document = { hidden: false, getElementById: (id: string) => (els.has(id) ? els.get(id) : (els.set(id, el()), els.get(id))), querySelector: () => null, addEventListener() {} }
  return vm.createContext({ document, fetch: async () => new Response('{}', { status: 404 }), setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, console, Date,
    Option: function (t: string, v: string) { return { text: t, value: v } } })
}

describe('shell()', () => {
  const html = shell({ nav: 'djs', title: 'DJs & more', description: 'One line', actions: '<button id="a">A</button>', body: '<p id="b">x</p>', js: 'window.__page = 1' })
  it('is one document with the tokens, the banner, the nav, the page and the scripts in order', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<h1>DJs &amp; more</h1>')
    expect(html).toContain('id="ban-banner"')
    expect(html).toContain('href="/ui/pool/settings"')
    expect(html).toContain('id="tk-toasts"')
    expect(html).toContain('id="tk-confirm"')
    expect(html).toContain('id="tk-drawer"')
    expect(html).toMatch(/<a [^>]*class="on"[^>]*href="\/ui\/djs"|<a [^>]*href="\/ui\/djs"[^>]*class="on"/)
    const scripts = scriptsOf(html)
    expect(scripts.length).toBe(5) // theme boot, runtime, shell, BAN_JS, page
    expect(scripts[4]).toBe('window.__page = 1')
    for (const s of scripts) expect(() => new vm.Script(s)).not.toThrow()
    expect(html).not.toMatch(/<script [^>]/)
  })
  it('its shared scripts run in the minimal pool stub', () => {
    const c = minimalStub()
    for (const s of scriptsOf(shell({ nav: 'pool', title: 'Pool accounts', body: '' })).slice(0, 4)) expect(() => vm.runInContext(s, c)).not.toThrow()
  })
  it('narrow pages get the 560px column and phone tabs list the five destinations', () => {
    const h = shell({ nav: 'captcha', title: 'Captcha', body: '', width: 'narrow' })
    expect(h).toContain('tk-main narrow')
    // Search is its own page from phase 3; until then it opens the DJs filter.
    for (const p of ['/ui', '/ui/djs', '/ui/djs?focus=filter', '/ui/mkvid', '/ui/pool']) expect(h).toContain(`href="${p}"`)
  })
})

describe('SHELL_JS', () => {
  /** Runs RUNTIME_JS + SHELL_JS with a body (or none), recording fetches and timers. */
  async function runShell(body: object | undefined, answers: Record<string, unknown> = {}) {
    const { RUNTIME_JS } = await import('../src/ui/runtime')
    const { SHELL_JS } = await import('../src/ui/shell')
    const els = new Map<string, any>()
    const el = () => ({ textContent: '', className: '', title: '', hidden: true, value: '', addEventListener() {} })
    const document = { hidden: false, body, getElementById: (id: string) => (els.has(id) ? els.get(id) : (els.set(id, el()), els.get(id))), addEventListener() {} }
    const fetches: string[] = []
    const timers: number[] = []
    const ctx = vm.createContext({ document, console, Date,
      fetch: async (u: string) => (fetches.push(u), u in answers ? Response.json(answers[u]) : new Response('{}', { status: 404 })),
      setTimeout: (_f: unknown, ms: number) => (timers.push(ms), 0), setInterval: (_f: unknown, ms: number) => (timers.push(ms), 0), clearTimeout() {}, clearInterval() {} })
    vm.runInContext(RUNTIME_JS, ctx)
    vm.runInContext(SHELL_JS, ctx)
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
    return { els, fetches, timers }
  }
  it('fetches nothing and sets no timer without a body', async () => {
    const r = await runShell(undefined)
    expect(r.fetches).toEqual([])
    expect(r.timers).toEqual([])
  })
  it('on a page that owns its count, fetches only the status (no tlpool request), and a failed status leaves a neutral pill', async () => {
    const r = await runShell({ dataset: { ownCount: '1' } })
    expect(r.fetches).toEqual(['/ui/api/ban/status'])
    expect(r.timers).toEqual([])
    expect([r.els.get('tk-status').textContent, r.els.get('tk-status').className]).toEqual(['Unknown', 'badge neutral'])
  })
  it('fills the status pill and the Challenges count once at load', async () => {
    const r = await runShell({ dataset: {} }, {
      '/ui/api/ban/status': { pause: { until: 'x', reason: 'y' }, poolConfigured: true },
      '/ui/api/pool/challenges': { challenges: [{ state: 'pending' }, { state: 'pending', ready: false }, { state: 'solved' }, { state: 'pending', ready: true }] },
    })
    expect(r.fetches.sort()).toEqual(['/ui/api/ban/status', '/ui/api/pool/challenges'])
    expect(r.timers).toEqual([])
    expect(r.els.get('tk-status').textContent).toBe('Paused')
    expect(r.els.get('tk-status').className).toBe('badge bad')
    expect(r.els.get('nav-count-captcha').textContent).toBe('2')
    expect(r.els.get('tab-count-captcha').hidden).toBe(false)
    const off = await runShell({ dataset: {} }, { '/ui/api/ban/status': { poolConfigured: false } })
    expect([off.els.get('tk-status').textContent, off.els.get('tk-status').className]).toEqual(['Pool offline', 'badge warn'])
    const ok = await runShell({ dataset: {} }, { '/ui/api/ban/status': { poolConfigured: true } })
    expect([ok.els.get('tk-status').textContent, ok.els.get('tk-status').className]).toEqual(['Active', 'badge ok'])
  })
  it('the shell carries no credential-looking inputs and never says quiet', () => {
    const h = shell({ nav: 'home', title: 'Home', body: '', banPage: 'home' })
    expect(h).not.toMatch(/quiet/i)
    expect(h).not.toMatch(/<(input|select)[^>]*(user|e-?mail|passw)/i)
    expect(h).toContain('data-ban-page="home"')
    expect(h).toContain('id="tk-theme"')
  })
})

describe.runIf(PAGES.length > 0)('every UI page', () => {
  it.each(PAGES)('%s: 200, no-store, shell nav, its h1, the pool settings link, the banner, scripts that parse and run', async (path, h1) => {
    const r = await app.request(`https://tracked.example${path}`, {}, env())
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('no-store')
    const text = await r.text()
    expect(text).toContain('class="tk-nav"')
    expect(text).toContain(h1 ? `<h1>${h1}` : '<h1 id="dj-name"')
    expect(text).toContain('/ui/pool/settings')
    expect(text).toContain('id="ban-banner"')
    const scripts = scriptsOf(text)
    for (const s of scripts) expect(() => new vm.Script(s)).not.toThrow()
    const c = minimalStub()
    for (const s of scripts.slice(0, 4)) expect(() => vm.runInContext(s, c)).not.toThrow()
  })
  it.each(PAGES)('%s answers 401 without Access and never reaches tlpool', async (path) => {
    const spy = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', spy)
    expect((await app.request(`https://tracked.example${path}`, {}, lockedEnv())).status).toBe(401)
    expect(spy).not.toHaveBeenCalled()
  })
})

it('pool pages report the Challenges count themselves and keep the phone-critical ids', async () => {
  const { POOL_PAGES } = await import('../src/routes/pool-ui')
  for (const h of [POOL_PAGES.POOL_PAGE_HTML, POOL_PAGES.CAPTCHA_LIST_HTML, POOL_PAGES.captchaPageHtml('ch-1')]) expect(h).toContain('data-own-count="1"')
  for (const id of ['add-btn', 'err', 'stats', 'prio', 'chals', 'accts', 'add-dlg', 'add-exit', 'add-passive', 'add-create', 'add-steps', 'add-captcha', 'add-msg', 'add-retry']) expect(POOL_PAGES.POOL_PAGE_HTML).toContain(`id="${id}"`)
  expect(POOL_PAGES.SETTINGS_PAGE_HTML).toContain('id="feed"')
  expect(POOL_PAGES.SETTINGS_PAGE_HTML).toContain('Render feeder: first fetches a day')
})

/** Every GET route the app registers under /ui, with sample values for its parameters. */
function uiGetPaths(): string[] {
  const sample: Record<string, string> = { slug: 'some-dj', id: 'ch-1', videoId: 'abcdefghijk', playlistId: 'PL1', action: 'x' }
  const paths = new Set<string>()
  for (const r of app.routes) {
    if (r.method !== 'GET' || !(r.path === '/ui' || r.path.startsWith('/ui/'))) continue
    paths.add(r.path.replace(/:(\w+)(\{[^}]*\})?/g, (_m, name: string) => sample[name] ?? 'x').replace(/\*/g, 'x'))
  }
  return [...paths].sort()
}

describe('Access gate on every /ui route', () => {
  const paths = uiGetPaths()
  it('finds the /ui routes', () => {
    expect(paths).toContain('/ui')
    expect(paths).toContain('/ui/')
    expect(paths.length).toBeGreaterThan(20)
  })
  it.each(paths)('GET %s answers 401 without Access and never fetches', async (path) => {
    const spy = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', spy)
    expect((await app.request(`https://tracked.example${path}`, {}, lockedEnv())).status).toBe(401)
    expect(spy).not.toHaveBeenCalled()
  })
})
