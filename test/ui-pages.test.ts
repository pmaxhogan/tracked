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
  ['/ui', 'Home'],
  ['/ui/', 'Home'],
  ['/ui/pool', 'Pool accounts'],
  ['/ui/pool/settings', 'Pool settings'],
  ['/ui/captcha', 'Captchas'],
  ['/ui/captcha/ch-1', 'Captcha'],
  ['/ui/set', 'Set'],
  ['/ui/dj/some-dj', ''],
  ['/ui/removed', 'Removed videos'],
  ['/ui/mkvid', 'mkvid'],
  ['/ui/settings', 'Settings'],
  ['/ui/tools', 'Tools'],
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

/** The minimal stub plus createElement, location, history and URLSearchParams: enough for a page script to run. */
function richStub(fetchImpl: (u: string) => Promise<Response>, pathname: string) {
  const el = (): any => ({ innerHTML: '', textContent: '', value: '', hidden: false, checked: false, disabled: false, className: '', src: '', dataset: {}, style: {}, options: [],
    addEventListener() {}, focus() {}, add() {}, remove() {}, showModal() {}, close() {}, querySelector: () => el(), querySelectorAll: () => [], closest: () => null })
  const els = new Map<string, any>()
  const document = { hidden: false, getElementById: (id: string) => (els.has(id) ? els.get(id) : (els.set(id, el()), els.get(id))), querySelector: () => null, addEventListener() {}, createElement: () => el() }
  const ctx = vm.createContext({ document, fetch: fetchImpl, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, console, Date, URLSearchParams,
    location: { search: '', pathname }, history: { replaceState() {} },
    Option: function (t: string, v: string) { return { text: t, value: v } } })
  return { ctx, els }
}

describe('mkvid page script', () => {
  it('renders the status line and the queue from one GET /ui/api/mkvid, with the server position', async () => {
    const now = Math.floor(Date.now() / 1000)
    const fixture = {
      enabled: true, dailyClaimCap: 30, dailyClaims: 3, now, quotaResetsAt: now + 3600,
      counts: { pending: 1, claimed: 0, done: 0, failed: 0, superseded: 0, banned: 0 },
      accounts: [{ account: 'primary', label: 'primary', cap: 24, used: 3 }],
      lastPoll: { at: now, outcome: 'ok', accounts: ['primary'] },
      oldStyleCount: 0, oldVideos: [], djs: [{ slug: 'some-dj', label: 'Some DJ', count: 1 }],
      queue: [{ id: 'r1', slug: 'some-dj', setUrl: 'https://www.1001tracklists.com/tracklist/x/some-set.html', setTitle: 'Some Set', setDate: '2026-09-01', source: 'soundcloud', sourceLabel: 'SoundCloud',
        sourceUrl: 'https://soundcloud.com/x/y', status: 'pending', account: 'primary', attempts: 0, notBefore: null, createdAt: now, updatedAt: now, skipIdWait: false, style: null, replacesVideoId: null,
        position: 7, readiness: { state: 'waiting_ids', until: now + 86400 * 3, idRows: 2 } }],
      queueCursor: null, queueTotal: 1, settled: [], settledCursor: null, settledTotal: 0,
    }
    const fetches: string[] = []
    const { ctx, els } = richStub(async (u: string) => (fetches.push(u), u.startsWith('/ui/api/mkvid') ? Response.json(fixture) : new Response('{}', { status: 404 })), '/ui/mkvid')
    const r = await app.request('https://tracked.example/ui/mkvid', {}, env())
    for (const s of scriptsOf(await r.text())) vm.runInContext(s, ctx)
    for (let i = 0; i < 10; i++) await new Promise((res) => setTimeout(res, 0))
    expect(fetches.some((u) => u.startsWith('/ui/api/mkvid?'))).toBe(true)
    expect(fetches.filter((u) => u.startsWith('/ui/api/mkvid')).every((u) => !/account=(?!primary|shared)/.test(u))).toBe(true)
    const queue = els.get('mk-queue').innerHTML as string
    expect(queue).toContain('#7')
    expect(queue).toContain('waiting for IDs until')
    expect(els.get('mk-state').innerHTML).toContain('Ready — mkvid takes the next set on its next poll')
  })
})

describe('DJs page script', () => {
  it('renders one row per subscription from api/list and api/state, with profile links and the resync action', async () => {
    const fetches: string[] = []
    const state = (n: number) => ({ slug: `dj-${n}`, state: { playlistId: `PL${n}`, artistName: `DJ ${n}`, processedTracklistUrls: ['https://x/a'], discoveredTracklistUrls: ['https://x/a', 'https://x/b'], tracklistVideos: { 'https://x/a': { videoId: 'abcdefghijk', checkedAt: 1 } }, lastRunAt: Math.floor(Date.now() / 1000) - 120, lastError: n === 2 ? 'boom' : undefined } })
    const { ctx, els } = richStub(async (u: string) => {
      fetches.push(u)
      if (u === '/ui/api/list') return Response.json({ subscriptions: [{ slug: 'dj-1', sourceUrl: 'https://www.1001tracklists.com/dj/dj-1/index.html', addedAt: 1 }, { slug: 'dj-2', sourceUrl: 'https://www.1001tracklists.com/dj/dj-2/index.html', addedAt: 2 }] })
      const m = /^\/ui\/api\/state\/dj-(\d)$/.exec(u)
      return m ? Response.json(state(Number(m[1]))) : new Response('{}', { status: 404 })
    }, '/ui/djs')
    const r = await app.request('https://tracked.example/ui/djs', {}, env())
    const html = await r.text()
    expect(html).toContain('id="fix-titles"')
    for (const s of scriptsOf(html)) vm.runInContext(s, ctx)
    for (let i = 0; i < 15; i++) await new Promise((res) => setTimeout(res, 0))
    expect(fetches).toContain('/ui/api/list')
    expect(fetches).toContain('/ui/api/state/dj-1')
    expect(fetches).toContain('/ui/api/state/dj-2')
    const body = els.get('rows').innerHTML as string
    expect(body).toContain('/ui/dj/dj-1')
    expect(body).toContain('/ui/dj/dj-2')
    expect(body).toMatch(/Invalidate (&|&amp;) resync/)
    expect(body).toContain('1 of 2')
    expect(body).toContain('1 pending')
    expect(body).toContain('https://www.youtube.com/playlist?list=PL1')
    expect(body).toContain('badge bad')
    expect(els.get('empty').hidden).toBe(true)
  })
})

describe('DJs page ?focus=filter and bulk actions', () => {
  it('focuses the filter only after it is shown, and locks row buttons while Sync all runs', async () => {
    const { ctx, els } = richStub(async (u: string) => {
      if (u === '/ui/api/list') return Response.json({ subscriptions: [{ slug: 'dj-1', sourceUrl: 'https://x', addedAt: 1 }] })
      if (u.startsWith('/ui/api/state/')) return Response.json({ state: null })
      if (u.startsWith('/ui/api/sync/')) { await new Promise((res) => setTimeout(res, 20)); return Response.json({ stats: {} }) }
      return new Response('{}', { status: 404 })
    }, '/ui/djs')
    ;(ctx as any).location.search = '?focus=filter'
    const doc = (ctx as any).document
    const mk = (): any => ({ innerHTML: '', textContent: '', className: '', children: [] as any[], appendChild(c: any) { this.children.push(c) }, setAttribute() {} })
    doc.createElement = mk
    doc.getElementById('tk-toasts').appendChild = () => {}
    const seen: boolean[] = []
    doc.getElementById('f-text').focus = () => seen.push(doc.getElementById('filters').hidden)
    const handlers: Record<string, () => void> = {}
    doc.getElementById('sync-all').addEventListener = (_t: string, fn: () => void) => { handlers.syncAll = fn }
    const html = await (await app.request('https://tracked.example/ui/djs', {}, env())).text()
    for (const s of scriptsOf(html)) vm.runInContext(s, ctx)
    for (let i = 0; i < 15; i++) await new Promise((res) => setTimeout(res, 0))
    expect(seen).toEqual([false])
    handlers.syncAll!()
    await new Promise((res) => setTimeout(res, 5))
    expect(els.get('resync-all').disabled).toBe(true)
    expect(els.get('rows').innerHTML).toContain('disabled')
    await new Promise((res) => setTimeout(res, 60))
    expect(els.get('resync-all').disabled).toBe(false)
    expect(els.get('rows').innerHTML).not.toContain('disabled')
  })
})

describe('Playlists page script', () => {
  it('fills the connection card, the combined card with its meter, the DJ playlists and the hygiene strip', async () => {
    const { ctx, els } = richStub(async (u: string) => {
      if (u === '/ui/api/youtube/status') return Response.json({ connected: true, channelTitle: 'My channel', scope: 'youtube' })
      if (u === '/ui/api/combined') return Response.json({ connected: true, title: 'All DJs', playlistId: 'PLc', playlistUrl: 'https://www.youtube.com/playlist?list=PLc', videoCount: 12, missingTotal: 3, sources: [{}], dailyInsertCap: 100, dailyInsertsUsed: 25 })
      if (u === '/ui/api/removals?limit=1') return Response.json({ settings: { dryRun: true, dailyRemovals: 20 }, deletesUsedToday: 2, holds: [{}] })
      if (u === '/ui/api/list') return Response.json({ subscriptions: [{ slug: 'dj-1', sourceUrl: 'https://x', addedAt: 1 }] })
      if (u === '/ui/api/state/dj-1') return Response.json({ state: { playlistId: 'PL1', artistName: 'DJ 1', processedTracklistUrls: [], tracklistVideos: { a: { videoId: 'v', checkedAt: 1, source: 'mkvid' } } } })
      return new Response('{}', { status: 404 })
    }, '/ui/playlists')
    const html = await (await app.request('https://tracked.example/ui/playlists', {}, env())).text()
    expect(html).toContain('id="fix-titles"')
    expect(html).toContain('Sign in with YouTube')
    for (const s of scriptsOf(html)) vm.runInContext(s, ctx)
    for (let i = 0; i < 15; i++) await new Promise((res) => setTimeout(res, 0))
    expect(els.get('yt-title').textContent).toBe('YouTube · My channel')
    expect(els.get('cmb-body').innerHTML).toContain('3 still to add')
    expect(els.get('cmb-body').innerHTML).toContain('75/100 inserts left today')
    expect(els.get('cmb-fill').style.width).toBe('25%')
    expect(els.get('rows').innerHTML).toContain('https://www.youtube.com/playlist?list=PL1')
    expect(els.get('rows').innerHTML).toContain('DJ 1 (1001tklists)')
    expect(els.get('hygiene').innerHTML).toContain('DRY RUN')
    expect(els.get('hygiene').innerHTML).toContain('1 held')
  })
})

describe('Home page', () => {
  it('/ui is the Home page and auto-prompts for notifications (ban page "home")', async () => {
    const html = await (await app.request('https://tracked.example/ui', {}, env())).text()
    expect(html).toContain('data-ban-page="home"')
    expect(html).toContain('<h1>Home</h1>')
    expect(html).not.toMatch(/quiet/i)
    for (const id of ['h-sync-all', 'h-backfill', 'h-compare', 'attn', 'req-list', 'pl-list']) expect(html).toContain(`id="${id}"`)
  })
  it('loads every source in parallel and lists what needs attention, each row linking to its fix', async () => {
    const now = Math.floor(Date.now() / 1000)
    const fetches: string[] = []
    const { ctx, els } = richStub(async (u: string) => {
      fetches.push(u)
      if (u === '/ui/api/pool/status') return Response.json({ status: { accounts: [{ id: 'acct-1', state: 'active', budget: 40, usedToday: 15 }, { id: 'acct-2', state: 'active', flagged: true, flagReason: 'too_many' }] }, challenges: [], challengesError: null })
      if (u === '/ui/api/pool/challenges') return Response.json({ challenges: [{ id: 'ch-1', state: 'pending', ready: true, type: 'image', expiresAt: new Date(Date.now() + 20 * 60000).toISOString(), createdAt: new Date().toISOString() }, { id: 'ch-2', state: 'solved' }] })
      if (u === '/ui/api/combined') return Response.json({ connected: true, title: 'All DJs', playlistId: 'PLc', videoCount: 12, missingTotal: 0, sources: [], dailyInsertCap: 100, dailyInsertsUsed: 25 })
      if (u.startsWith('/ui/api/mkvid')) return Response.json({ enabled: true, dailyClaimCap: 30, dailyClaims: 3, now, quotaResetsAt: now + 3600, counts: { pending: 0, claimed: 0, done: 4, failed: 2 }, accounts: [{ account: 'primary', label: 'primary', cap: 24, used: 3 }, { account: 'shared', label: 'shared', cap: 6, used: 0 }], lastPoll: { at: now, outcome: 'ok', accounts: ['primary', 'shared'] }, oldVideos: [{ videoId: 'v1' }], queue: [], settled: [] })
      if (u === '/ui/api/list') return Response.json({ subscriptions: [{ slug: 'dj-1', sourceUrl: 'https://x', addedAt: 1 }, { slug: 'dj-2', sourceUrl: 'https://y', addedAt: 2 }] })
      if (u === '/ui/api/state/dj-1') return Response.json({ state: { lastRunAt: now - 60, lastError: 'boom <b>' } })
      if (u === '/ui/api/state/dj-2') return Response.json({ state: { lastRunAt: now - 60 } })
      if (u.startsWith('/ui/api/removals')) return Response.json({ holds: [{ kind: 'artist', slug: 'dj-1', playlistId: 'PL1', missing: 5, expected: 40, at: new Date().toISOString() }] })
      if (u.startsWith('/ui/api/audit?')) return Response.json({ records: [{ key: '1', status: 'ok', title: 'A <set>', via: 'yt', cs: 4000, dur: 3600, impossible: true, skew: 900, t: new Date().toISOString() }], cursor: null })
      if (u === '/ui/api/audit-detail?key=1') return Response.json({ record: { t: 'now', reqId: 'r1', status: 'ok', input: { videoTitle: 'A <set>' }, youtube: { videoId: 'abcdefghijk' }, search: { attempts: [] }, meta: {} } })
      if (u.startsWith('/ui/api/playlist-addition-detail')) return Response.json({ error: 'not_found' }, { status: 404 })
      if (u.startsWith('/ui/api/playlist-additions?')) return Response.json({ records: [{ key: '2', status: 'failed', set: 'https://www.1001tracklists.com/tracklist/x/some-set.html', slug: 'dj-1', vid: 'abcdefghijk', t: new Date().toISOString() }], cursor: null })
      return new Response('{}', { status: 404 })
    }, '/ui')
    ;(ctx as any).URL = URL // TK.fmt.setLabel parses the set URL
    const clicks: Record<string, (ev: unknown) => void> = {}
    for (const id of ['req-list', 'pl-list']) (ctx as any).document.getElementById(id).addEventListener = (_t: string, fn: (ev: unknown) => void) => { clicks[id] = fn }
    const html = await (await app.request('https://tracked.example/ui', {}, env())).text()
    for (const s of scriptsOf(html)) vm.runInContext(s, ctx)
    for (let i = 0; i < 20; i++) await new Promise((res) => setTimeout(res, 0))
    for (const u of ['/ui/api/ban/status', '/ui/api/pool/status', '/ui/api/pool/challenges', '/ui/api/youtube/status', '/ui/api/combined', '/ui/api/list', '/ui/api/state/dj-1']) expect(fetches).toContain(u)
    expect(fetches).toContain('/ui/api/mkvid?limit=1')
    expect(fetches).toContain('/ui/api/audit?limit=6')
    expect(fetches).toContain('/ui/api/playlist-additions?limit=6')
    const attn = els.get('attn').innerHTML as string
    expect(attn).toContain('href="/ui/captcha/ch-1"')
    expect(attn).toContain('href="/ui/removed"')
    expect(attn).toContain('href="/ui/dj/dj-1"')
    expect(attn).not.toContain('href="/ui/dj/dj-2"')
    expect(attn).toContain('href="/ui/pool"')
    expect(attn).toContain('/ui/mkvid?status=failed')
    expect(attn).toContain('/ui/mkvid?tab=old')
    expect(attn).toContain('boom &lt;b&gt;')
    expect(attn).not.toContain('<b>')
    expect(els.get('t-fetch').innerHTML).toContain('15 / 40')
    expect(els.get('t-chal').innerHTML).toContain('1')
    expect(els.get('t-yt').innerHTML).toContain('25 / 100')
    expect(els.get('t-mk').innerHTML).toContain('primary 3 / 24')
    const req = els.get('req-list').innerHTML as string
    expect(req).toContain('A &lt;set&gt;')
    expect(req).toContain('title="reported position is past the end of the video"')
    expect(req).toContain('Δ15:00')
    expect(els.get('pl-list').innerHTML).toContain('some set')
    const row = { target: { closest: () => ({ dataset: { i: '0' } }) } }
    clicks['req-list']!(row)
    for (let i = 0; i < 10; i++) await new Promise((res) => setTimeout(res, 0))
    expect(els.get('tk-drawer-body').innerHTML).toContain('YouTube match')
    expect(els.get('tk-drawer-body').innerHTML).toContain('A &lt;set&gt;')
    clicks['pl-list']!(row)
    for (let i = 0; i < 10; i++) await new Promise((res) => setTimeout(res, 0))
    expect(els.get('tk-drawer-body').innerHTML).toContain('detail not found')
  })
})

describe('Settings and Tools pages', () => {
  it('Settings carries the ban-script ids and the cards; Tools carries the simulate link', async () => {
    const s = await (await app.request('https://tracked.example/ui/settings', {}, env())).text()
    expect(s).toContain('data-ban-page="settings"')
    for (const id of ['alerts-state', 'alerts-enable', 'alerts-test', 'alerts-msg', 'ban-refresh', 'ban-route', 'ban-devices', 'ban-episodes', 'yt-card', 'int-pool', 'int-push', 'int-mkvid']) expect(s).toContain(`id="${id}"`)
    const t = await (await app.request('https://tracked.example/ui/tools', {}, env())).text()
    expect(t).toContain('id="ban-simulate"')
    expect(t).not.toMatch(/quiet/i)
    expect(s).not.toMatch(/quiet/i)
  })
  it('Settings script fills the integrations and the theme radios', async () => {
    const { ctx, els } = richStub(async (u: string) => {
      if (u === '/ui/api/youtube/status') return Response.json({ connected: false })
      if (u === '/ui/api/ban/status') return Response.json({ poolConfigured: true, pushConfigured: false })
      if (u.startsWith('/ui/api/mkvid')) return Response.json({ enabled: true })
      return new Response('{}', { status: 404 })
    }, '/ui/settings')
    const html = await (await app.request('https://tracked.example/ui/settings', {}, env())).text()
    for (const s of scriptsOf(html)) vm.runInContext(s, ctx)
    for (let i = 0; i < 15; i++) await new Promise((res) => setTimeout(res, 0))
    expect(els.get('int-pool').textContent).toBe('configured')
    expect(els.get('int-push').textContent).toBe('not configured')
    expect(els.get('int-mkvid').textContent).toBe('configured')
  })
  it('Tools script prints the migration status and requeues with dry=1 only when checked', async () => {
    const seen: string[] = []
    const { ctx, els } = richStub(async (u: string) => {
      seen.push(u)
      if (u === '/ui/api/migration') return Response.json({ done: false })
      if (u.startsWith('/ui/api/ban/requeue-victims')) return Response.json({ requeued: 0 })
      return new Response('{}', { status: 404 })
    }, '/ui/tools')
    const listeners: Record<string, () => void> = {}
    const form = () => (ctx.document.getElementById('rq-form'))
    form().addEventListener = (t: string, fn: any) => { if (t === 'submit') listeners.rq = () => fn({ preventDefault() {} }) }
    const html = await (await app.request('https://tracked.example/ui/tools', {}, env())).text()
    ctx.document.getElementById('rq-days').value = '7'
    ctx.document.getElementById('rq-dry').checked = true
    for (const s of scriptsOf(html)) vm.runInContext(s, ctx)
    for (let i = 0; i < 10; i++) await new Promise((res) => setTimeout(res, 0))
    expect(els.get('mig-out').textContent).toContain('"done": false')
    listeners.rq!()
    for (let i = 0; i < 10; i++) await new Promise((res) => setTimeout(res, 0))
    expect(seen).toContain('/ui/api/ban/requeue-victims?days=7&dry=1')
    expect(els.get('rq-out').textContent).toContain('"requeued": 0')
  })
})

/** Every route with one of these methods under /ui, with sample values for its parameters. */
function uiPaths(methods: string[]): string[] {
  const sample: Record<string, string> = { slug: 'some-dj', id: 'ch-1', videoId: 'abcdefghijk', playlistId: 'PL1', action: 'x' }
  const paths = new Set<string>()
  for (const r of app.routes) {
    if (!methods.includes(r.method) || !(r.path === '/ui' || r.path.startsWith('/ui/'))) continue
    paths.add(r.path.replace(/:(\w+)(\{[^}]*\})?/g, (_m, name: string) => sample[name] ?? 'x').replace(/\*/g, 'x'))
  }
  return [...paths].sort()
}

describe('Access gate on every /ui route', () => {
  const paths = uiPaths(['GET'])
  const writes = uiPaths(['POST', 'PUT', 'DELETE']).flatMap((p) => ['POST', 'PUT', 'DELETE'].filter((m) => app.routes.some((r) => r.method === m && uiPaths([m]).includes(p))).map((m) => [m, p] as const))
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
  it('finds the /ui write routes', () => expect(writes.length).toBeGreaterThan(5))
  it.each(writes)('%s %s answers 401 without Access and never fetches', async (method, path) => {
    const spy = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', spy)
    const r = await app.request(`https://tracked.example${path}`, { method, headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: '{}' }, lockedEnv())
    expect(r.status).toBe(401)
    expect(spy).not.toHaveBeenCalled()
  })
})
