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
  ['/ui/activity', 'Activity'],
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
  it('has a GET search form for the DJs filter (desktop only) and no POST form', () => {
    const h = shell({ nav: 'home', title: 'Home', body: '' })
    expect(h).toContain('<form class="tk-search" action="/ui/djs" method="get" role="search">')
    expect(h).toContain('<input id="tk-search" name="q" type="search" placeholder="Filter DJs" aria-label="Filter DJs">')
    expect(h).not.toMatch(/<form[^>]*method="?post/i)
    expect(h).toContain('href="/ui/" title="tracked"')
  })
  it('its shared scripts run in the minimal pool stub', () => {
    const c = minimalStub()
    for (const s of scriptsOf(shell({ nav: 'pool', title: 'Pool accounts', body: '' })).slice(0, 4)) expect(() => vm.runInContext(s, c)).not.toThrow()
  })
  it('narrow pages get the 560px column and phone tabs list the five destinations', () => {
    const h = shell({ nav: 'captcha', title: 'Captcha', body: '', width: 'narrow' })
    expect(h).toContain('tk-main narrow')
    // Search is its own page from phase 3; until then it opens the DJs filter.
    for (const p of ['/ui/', '/ui/djs', '/ui/djs?focus=filter', '/ui/mkvid', '/ui/pool']) expect(h).toContain(`href="${p}"`)
    // Activity is in the sidebar and the menu, never a phone tab.
    const tabBar = /<nav class="tk-tabs"[^>]*>([\s\S]*?)<\/nav>/.exec(h)![1]!
    expect(tabBar.match(/href="/g)!.length).toBe(5)
    expect(tabBar).not.toContain('/ui/activity')
  })
  it('the Activity nav item sits in the Pipeline group and lights up on its page', () => {
    const h = shell({ nav: 'activity', title: 'Activity', body: '' })
    expect(h).toMatch(/<a [^>]*href="\/ui\/activity"[^>]*class="on"/)
    expect(h).toMatch(/href="\/ui\/mkvid"[^>]*>(?:(?!<\/a>)[\s\S])*<\/a><a href="\/ui\/activity"/)
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
    expect(html).toContain('href="/ui/activity"')
    expect(html).toContain('href="/ui/activity?problems=1"')
    for (const id of ['h-sync-all', 'h-backfill', 'h-compare', 'attn', 'act-list', 'act-empty']) expect(html).toContain(`id="${id}"`)
  })
  it('loads every source in parallel and lists what needs attention, each row linking to its fix', async () => {
    const now = Math.floor(Date.now() / 1000)
    const fetches: string[] = []
    const { ctx, els } = richStub(async (u: string) => {
      fetches.push(u)
      if (u === '/ui/api/pool/status') return Response.json({ status: { accounts: [{ id: 'acct-1', state: 'active', budget: 40, usedToday: 15 }, { id: 'acct-2', state: 'active', flagged: true, flagReason: 'too_many' }, { id: 'acct-3', state: 'retired' }, { id: 'acct-4', state: 'retired', flagged: true }] }, challenges: [], challengesError: null })
      if (u === '/ui/api/pool/challenges') return Response.json({ challenges: [{ id: 'ch-1', state: 'pending', ready: true, type: 'image', expiresAt: new Date(Date.now() + 20 * 60000).toISOString(), createdAt: new Date().toISOString() }, { id: 'ch-2', state: 'solved' }] })
      if (u === '/ui/api/combined') return Response.json({ connected: true, title: 'All DJs', playlistId: 'PLc', videoCount: 12, missingTotal: 0, sources: [], dailyInsertCap: 100, dailyInsertsUsed: 25 })
      if (u.startsWith('/ui/api/mkvid')) return Response.json({ enabled: true, dailyClaimCap: 30, dailyClaims: 3, now, quotaResetsAt: now + 3600, counts: { pending: 0, claimed: 0, done: 4, failed: 2 }, accounts: [{ account: 'primary', label: 'primary', cap: 24, used: 3 }, { account: 'shared', label: 'shared', cap: 6, used: 0 }], lastPoll: { at: now, outcome: 'ok', accounts: ['primary', 'shared'] }, oldVideos: [{ videoId: 'v1' }], queue: [], settled: [] })
      if (u === '/ui/api/list') return Response.json({ subscriptions: [{ slug: 'dj-1', sourceUrl: 'https://x', addedAt: 1 }, { slug: 'dj-2', sourceUrl: 'https://y', addedAt: 2 }] })
      if (u === '/ui/api/state/dj-1') return Response.json({ state: { lastRunAt: now - 60, lastError: 'boom <b>' } })
      if (u === '/ui/api/state/dj-2') return Response.json({ state: { lastRunAt: now - 60 } })
      if (u.startsWith('/ui/api/removals')) return Response.json({ holds: [{ kind: 'artist', slug: 'dj-1', playlistId: 'PL1', missing: 5, expected: 40, at: now - 3600 }] })
      if (u.startsWith('/ui/api/activity?')) return Response.json({ rows: [
        { ts: Date.now() - 1000, kind: 'request', status: 'no_video', problem: true, title: 'A <set>', detail: 'no match', dj: null, setUrl: null, videoId: null, ref: { kind: 'audit', key: '1' } },
        { ts: Date.now() - 2000, kind: 'playlist', status: 'added', problem: false, title: 'some set', detail: 'added to PL1', dj: 'dj-1', setUrl: null, videoId: 'abcdefghijk', ref: { kind: 'addition', key: '2' } },
        { ts: Date.now() - 3000, kind: 'pool', status: 'account.flagged', problem: true, title: 'acct-2 flagged <b>', detail: '', dj: null, setUrl: null, videoId: null, ref: { kind: 'pool', key: '7' } },
      ], cursor: 'c' })
      if (u === '/ui/api/audit-detail?key=1') return Response.json({ record: { t: 'now', reqId: 'r1', status: 'ok', input: { videoTitle: 'A <set>' }, youtube: { videoId: 'abcdefghijk' }, search: { attempts: [] }, meta: {} } })
      if (u.startsWith('/ui/api/playlist-addition-detail')) return Response.json({ error: 'not_found' }, { status: 404 })
      return new Response('{}', { status: 404 })
    }, '/ui')
    ;(ctx as any).URL = URL // TK.fmt.setLabel parses the set URL
    const clicks: Record<string, (ev: unknown) => void> = {}
    for (const id of ['act-list']) (ctx as any).document.getElementById(id).addEventListener = (_t: string, fn: (ev: unknown) => void) => { clicks[id] = fn }
    const html = await (await app.request('https://tracked.example/ui', {}, env())).text()
    for (const s of scriptsOf(html)) vm.runInContext(s, ctx)
    for (let i = 0; i < 20; i++) await new Promise((res) => setTimeout(res, 0))
    for (const u of ['/ui/api/ban/status', '/ui/api/pool/status', '/ui/api/pool/challenges', '/ui/api/youtube/status', '/ui/api/combined', '/ui/api/list', '/ui/api/state/dj-1']) expect(fetches).toContain(u)
    expect(fetches).toContain('/ui/api/mkvid?limit=1')
    expect(fetches).toContain('/ui/api/activity?limit=12')
    expect(fetches.some((u) => u.startsWith('/ui/api/audit?') || u.startsWith('/ui/api/playlist-additions?'))).toBe(false)
    const attn = els.get('attn').innerHTML as string
    expect(attn).toContain('href="/ui/captcha/ch-1"')
    expect(attn).toContain('href="/ui/removed"')
    expect(attn).toContain('href="/ui/dj/dj-1"')
    expect(attn).not.toContain('href="/ui/dj/dj-2"')
    expect(attn).toContain('href="/ui/pool"')
    expect(attn).toContain('acct-2 is flagged')
    expect(attn).not.toContain('acct-3')
    expect(attn).not.toContain('acct-4')
    expect(attn).toContain('/ui/mkvid?status=failed')
    expect(attn).toContain('/ui/mkvid?tab=old')
    expect(attn).toContain('boom &lt;b&gt;')
    expect(attn).not.toContain('<b>')
    expect(els.get('t-fetch').innerHTML).toContain('15 / 40')
    expect(els.get('t-chal').innerHTML).toContain('1')
    expect(els.get('t-yt').innerHTML).toContain('25 / 100')
    expect(els.get('t-mk').innerHTML).toContain('primary 3 / 24')
    const act = els.get('act-list').innerHTML as string
    expect(act).toContain('A &lt;set&gt;')
    expect(act).not.toContain('<set>')
    expect(act).toMatch(/class="a-row err" data-i="0"/)
    expect(act).not.toMatch(/class="a-row err" data-i="1"/)
    expect(act).toContain('acct-2 flagged &lt;b&gt;')
    const clickRow = async (i: string) => {
      clicks['act-list']!({ target: { closest: () => ({ dataset: { i } }) } })
      for (let n = 0; n < 10; n++) await new Promise((res) => setTimeout(res, 0))
    }
    await clickRow('0')
    expect(els.get('tk-drawer-body').innerHTML).toContain('YouTube match')
    expect(els.get('tk-drawer-body').innerHTML).toContain('A &lt;set&gt;')
    await clickRow('1')
    expect(els.get('tk-drawer-body').innerHTML).toContain('detail not found')
    await clickRow('2')
    expect(fetches.filter((u) => u.includes('-detail')).length).toBe(2)
  })
})

describe('Activity page', () => {
  const rows = [
    { ts: Date.now() - 60_000, kind: 'request', status: 'no_video', problem: true, title: 'Bad <img src=x onerror=1>', detail: 'no match', dj: null, setUrl: null, videoId: null, ref: { kind: 'audit', key: '11' } },
    { ts: Date.now() - 120_000, kind: 'playlist', status: 'added', problem: false, title: 'Some set', detail: 'added to PL1', dj: 'dj-one', setUrl: 'https://www.1001tracklists.com/tracklist/x/some-set.html', videoId: 'abcdefghijk', ref: { kind: 'addition', key: '12' } },
  ]
  const poolRow = { ts: Date.now() - 30_000, kind: 'pool', status: 'account.flagged', problem: true, title: 'acct-3 flagged <b>', detail: 'too many', dj: null, setUrl: null, videoId: null, ref: { kind: 'pool', key: '7' } }
  type Answer = (u: string) => Promise<Response> | Response
  async function run(search: string, activity: Answer = () => Response.json({ rows, cursor: 'x' })) {
    const fetches: string[] = []
    const { ctx, els } = richStub(async (u: string) => {
      fetches.push(u)
      if (u.startsWith('/ui/api/activity?')) return activity(u)
      if (u === '/ui/api/list') return Response.json({ subscriptions: [{ slug: 'dj-one', sourceUrl: 'https://x', addedAt: 1 }] })
      if (u === '/ui/api/audit-detail?key=11') return Response.json({ record: { t: 'now', reqId: 'r1', status: 'no_video', input: { videoTitle: 'Bad <img src=x onerror=1>' }, youtube: {}, search: { attempts: [] }, meta: {} } })
      if (u === '/ui/api/playlist-addition-detail?key=12') return Response.json({ record: { t: 'now', status: 'added', setUrl: 'https://www.1001tracklists.com/tracklist/x/some-set.html', slug: 'dj-one', videoId: 'abcdefghijk', playlistId: 'PL1', playlistTitle: 'PL <one>', combinedStatus: 'added', meta: { ms: 5 } } })
      return new Response('{}', { status: 404 })
    }, '/ui/activity')
    ;(ctx as any).URL = URL
    ;(ctx as any).location.search = search
    const clicks: Record<string, (ev: unknown) => void> = {}
    for (const [id, name] of [['a-list', 'list'], ['a-filters', 'filters'], ['a-more', 'more']] as const) (ctx as any).document.getElementById(id).addEventListener = (_t: string, fn: (ev: unknown) => void) => { clicks[name] = fn }
    const html = await (await app.request('https://tracked.example/ui/activity', {}, env())).text()
    for (const s of scriptsOf(html)) vm.runInContext(s, ctx)
    for (let i = 0; i < 15; i++) await new Promise((res) => setTimeout(res, 0))
    return { fetches, els, clicks, html }
  }
  const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((res) => setTimeout(res, 0)) }
  it('renders the rows from one GET /ui/api/activity, escaped, with DJ and set links and Load older', async () => {
    const { fetches, els, clicks, html } = await run('')
    expect(html).toContain('id="a-filters"')
    expect(html).toContain('data-kind="request"')
    // The page's own first fetch (BAN_JS reads the ban status on every page).
    const first = fetches.find((u) => !u.startsWith('/ui/api/ban/')) ?? ''
    expect(first.startsWith('/ui/api/activity?')).toBe(true)
    expect(first).toContain('&since=')
    expect(first).toContain('limit=50')
    expect(first).not.toContain('kind=')
    expect(fetches).toContain('/ui/api/list')
    const list = els.get('a-list').innerHTML as string
    expect(list.split('class="a-row err"').length - 1).toBe(1)
    expect(list).toContain('/ui/dj/dj-one')
    expect(list).toContain('/ui/set?url=')
    expect(list).toContain('&lt;img')
    expect(list).not.toContain('<img')
    expect(els.get('a-more').hidden).toBe(false)
    expect(els.get('a-dj').innerHTML).toContain('value="dj-one"')
    clicks.list!({ target: { closest: () => ({ dataset: { i: '0' } }) } })
    for (let i = 0; i < 10; i++) await new Promise((res) => setTimeout(res, 0))
    expect(fetches).toContain('/ui/api/audit-detail?key=11')
    expect(els.get('tk-drawer-body').innerHTML).toContain('YouTube match')
    clicks.list!({ target: { closest: () => ({ dataset: { i: '1' } }) } })
    for (let i = 0; i < 10; i++) await new Promise((res) => setTimeout(res, 0))
    expect(fetches).toContain('/ui/api/playlist-addition-detail?key=12')
    const pl = els.get('tk-drawer-body').innerHTML as string
    expect(pl).toContain('Playlist') // plDetailHtml's group heading
    expect(pl).toContain('PL &lt;one&gt;')
    expect(pl).toContain('https://www.youtube.com/playlist?list=PL1')
  })
  it('a row with no detail endpoint opens its own fields without a fetch', async () => {
    const { fetches, els, clicks } = await run('', () => Response.json({ rows: [poolRow], cursor: null }))
    const before = fetches.length
    clicks.list!({ target: { closest: () => ({ dataset: { i: '0' } }) } })
    await tick()
    expect(fetches.length).toBe(before)
    expect(els.get('tk-drawer-title').textContent).toBe('acct-3 flagged <b>')
    const body = els.get('tk-drawer-body').innerHTML as string
    expect(body).toContain('acct-3 flagged &lt;b&gt;')
    expect(body).toContain('account.flagged')
    expect(els.get('a-more').hidden).toBe(true)
  })
  it('Load older during a filter change does nothing: the list ends with only the new filter rows', async () => {
    let release: (() => void) | null = null
    const { fetches, els, clicks } = await run('', (u) => {
      if (!u.includes('kind=')) return Response.json({ rows, cursor: 'x' })
      return new Promise<Response>((res) => { release = () => res(Response.json({ rows: [poolRow], cursor: null })) })
    })
    expect(els.get('a-more').hidden).toBe(false)
    clicks.filters!({ target: { closest: () => ({ dataset: { kind: 'pool' }, id: '' }) } })
    await tick(3)
    expect(els.get('a-more').hidden).toBe(true)
    expect(els.get('a-list').className).toContain('busy')
    clicks.more!({})
    await tick(3)
    expect(fetches.some((u) => u.includes('cursor='))).toBe(false)
    release!()
    await tick()
    const list = els.get('a-list').innerHTML as string
    expect(list).toContain('acct-3 flagged')
    expect(list).not.toContain('Some set')
    expect(list.split('class="a-item"').length - 1).toBe(1)
    expect(els.get('a-list').className).not.toContain('busy')
  })
  it('reads kind, problems, DJ and range from the query string', async () => {
    const { fetches, els } = await run('?kind=pool,ban,bogus&problems=1&range=24h&dj=dj-one')
    const u = fetches.find((x) => x.startsWith('/ui/api/activity?')) ?? ''
    expect(u).toMatch(/kind=pool(%2C|,)ban(&|$)/)
    expect(u).toContain('problems=1')
    expect(u).toContain('dj=dj-one')
    const since = Number(/since=(\d+)/.exec(u)![1])
    expect(Math.abs(since - (Date.now() - 86_400_000))).toBeLessThan(1000)
    expect(els.get('a-kinds').innerHTML).toMatch(/class="chip on" data-kind="pool" aria-pressed="true"/)
    expect(els.get('a-ranges').innerHTML).toMatch(/class="chip on" data-range="24h" aria-pressed="true"/)
  })
  it('its page script runs in the minimal stub too', async () => {
    const html = await (await app.request('https://tracked.example/ui/activity', {}, env())).text()
    const c = minimalStub()
    for (const s of scriptsOf(html)) expect(() => vm.runInContext(s, c)).not.toThrow()
    for (let i = 0; i < 10; i++) await new Promise((res) => setTimeout(res, 0))
  })
  it('Home uses the shared detail renderers instead of its own copy', async () => {
    const { readFileSync } = await import('node:fs')
    expect(readFileSync('src/ui/pages/home.ts', 'utf8')).not.toContain('function auditDetailHtml')
    const { ACTIVITY_DETAIL_JS } = await import('../src/ui/pages/activity-detail')
    const { HOME_PAGE } = await import('../src/ui/pages/home')
    expect(HOME_PAGE.html).toContain(ACTIVITY_DETAIL_JS)
  })
  // The phone block of a CSS string: everything inside `@media (max-width: 799px) { … }`.
  const phoneBlock = (css: string) => /@media \(max-width: 799px\) \{([\s\S]*?)\n  \}/.exec(css)![1]!
  const ruleOf = (css: string, sel: string) => {
    const m = new RegExp('(?:^|\\n)\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{([^}]*)\\}').exec(css)
    return m ? m[1]! : ''
  }
  it('under 800px a row stacks: icon, badge and time, then title, detail and links, without breaking words', async () => {
    const { ACTIVITY_ROW_CSS } = await import('../src/ui/pages/activity')
    const phone = phoneBlock(ACTIVITY_ROW_CSS)
    // The title/detail column takes a full line of its own under the icon/badge/time line.
    expect(ruleOf(phone, '.a-main')).toContain('order: 1')
    expect(ruleOf(phone, '.a-main')).toContain('flex-basis: 100%')
    expect(ruleOf(phone, '.a-main')).toContain('flex-direction: column')
    expect(ruleOf(phone, '.a-when')).toContain('margin-left: auto')
    expect(ruleOf(phone, '.a-when')).not.toContain('flex-basis: 100%')
    expect(ruleOf(phone, '.a-links')).toContain('flex-basis: 100%')
    // Normal words never break mid-word; only a word too long for the line (an id, a URL) does.
    expect(ruleOf(phone, '.a-title, .a-detail')).toContain('overflow-wrap: break-word')
    expect(phone).not.toContain('overflow-wrap: anywhere')
    expect(phone).not.toMatch(/word-break: break-all/)
  })
  it('under 800px the chip rows wrap instead of scrolling sideways', async () => {
    const { ACTIVITY_PAGE_CSS } = await import('../src/ui/pages/activity')
    const phone = phoneBlock(ACTIVITY_PAGE_CSS)
    expect(ruleOf(phone, '.tk-filters .a-chips')).toContain('flex-wrap: wrap')
    expect(phone).not.toContain('overflow-x')
    expect(ACTIVITY_PAGE_CSS).not.toMatch(/\.a-chips[^}]*nowrap/)
  })
})

describe('Set diagnostics', () => {
  const XSS = '<img src=x onerror=1>'
  const empty = () => ({ url: 'https://www.1001tracklists.com/tracklist/x/some-set.html', now: 1_790_000_000, discovered: [] as any[], schedule: null as any, verification: null as any, media: null as any, video: null as any,
    playlist: { additions: [] as any[], confirmed: [] as any[] }, hygiene: { removed: [] as any[], removals: [] as any[] }, mkvid: null as any })
  async function diagCtx() {
    const { RUNTIME_JS } = await import('../src/ui/runtime')
    const { SET_DIAG_JS } = await import('../src/ui/pages/set-diag')
    const ctx = vm.createContext({ document: { getElementById: () => null }, console, Date })
    vm.runInContext(RUNTIME_JS, ctx)
    vm.runInContext("TK.fmt.rel = () => 'REL'; TK.fmt.until = () => 'UNTIL';", ctx)
    vm.runInContext(SET_DIAG_JS, ctx)
    return ctx as any
  }
  const verdict = { ok: false, reason: 'short', label: 'Shorter than the set', detail: 'video 10:00 < last cue 60:00 - 5:00' }
  const video = (extra: object = {}) => ({ id: 'abcdefghijk', from: 'tracklists', meta: null, verdict, override: false, ...extra })
  const pendingMkvid = (extra: object = {}) => ({ id: 'r1', status: 'pending', position: 3, readiness: { state: 'waiting_ids', until: 1_800_000_000, idRows: 2 }, attempts: 0, notBefore: null, error: null, videoId: null, style: null, account: 'primary', skipIdWait: false, list: null, ...extra })

  it('setDiagRows: an empty response gives the seven rows in order with their tones', async () => {
    const ctx = await diagCtx()
    const rows = ctx.setDiagRows(empty())
    expect(rows.map((r: any) => r.key)).toEqual(['discovered', 'recording', 'verification', 'rule', 'playlist', 'hygiene', 'mkvid'])
    expect(rows.map((r: any) => r.tone)).toEqual(['warn', 'info', 'info', 'neutral', 'info', 'ok', 'neutral'])
    for (const r of rows) { expect(typeof r.label).toBe('string'); expect(typeof r.finding).toBe('string'); expect(Array.isArray(r.facts)).toBe(true) }
  })
  it('setDiagRows: mkvid waiting for IDs, the rule verdict, the override and an owner removal', async () => {
    const ctx = await diagCtx()
    const byKey = (d: object) => Object.fromEntries(ctx.setDiagRows(d).map((r: any) => [r.key, r]))
    const m = byKey({ ...empty(), mkvid: pendingMkvid() }).mkvid
    expect(m.finding.startsWith('#3;')).toBe(true)
    expect(m.finding).toContain('2 ID rows')
    expect(m.finding).toContain('UNTIL')
    const rule = byKey({ ...empty(), video: video() }).rule
    expect(rule.tone).toBe('bad')
    expect(rule.finding).toContain('Shorter than the set')
    expect(rule.finding).toContain('video 10:00 < last cue 60:00 - 5:00')
    expect(byKey({ ...empty(), video: video({ override: true }) }).rule.tone).toBe('ok')
    const h = byKey({ ...empty(), video: video(), hygiene: { removed: [{ playlistId: 'PL1', reason: 'owner', at: 1_790_000_000, slug: 'dj-one' }], removals: [] } }).hygiene
    expect(h.tone).toBe('bad')
    expect(h.finding).toContain('removed by you')
  })
  it('setDiagRows: an mkvid render is exempt from the rule, a turned-down page video is a warning', async () => {
    const ctx = await diagCtx()
    const byKey = (d: object) => Object.fromEntries(ctx.setDiagRows(d).map((r: any) => [r.key, r]))
    const mk = byKey({ ...empty(), video: video({ source: 'mkvid', current: true, exempt: 'mkvid', verdict: null }) })
    expect([mk.recording.tone, mk.recording.finding]).toEqual(['ok', 'YouTube abcdefghijk, rendered by mkvid.'])
    expect([mk.rule.tone, mk.rule.finding]).toEqual(['ok', 'mkvid renders are not judged by the rule (the sweep never removes them).'])
    const cur = byKey({ ...empty(), video: video({ source: '1001tl', current: true, exempt: null }) })
    expect([cur.recording.tone, cur.recording.finding]).toEqual(['ok', 'YouTube abcdefghijk from the set page.'])
    const down = byKey({ ...empty(), video: video({ from: 'media', source: '1001tl', current: false, exempt: null }) })
    expect([down.recording.tone, down.recording.finding]).toEqual(['warn', 'The set page links YouTube abcdefghijk, but it was turned down (see Full-recording rule).'])
    expect(down.rule.tone).toBe('bad')
  })
  it('setDiagRows: discovery, verification, playlist and mkvid tones', async () => {
    const ctx = await diagCtx()
    const byKey = (d: object) => Object.fromEntries(ctx.setDiagRows(d).map((r: any) => [r.key, r]))
    const dj = (extra: object) => ({ slug: 'dj', artistName: null, discoveredAt: 1, processed: false, abandoned: false, failureCount: 0, videoKnown: false, videoId: null, videoSource: null, checkedAt: null, ...extra })
    const disc = byKey({ ...empty(), discovered: [dj({ slug: 'a', failureCount: 9 }), dj({ slug: 'b', abandoned: true, failureCount: 4 })] }).discovered
    expect([disc.tone, disc.finding]).toEqual(['bad', 'Given up after 4 failed fetches.'])
    const ver = (extra: object) => ({ state: 'pending', rowCount: 30, firstAccount: 'acct-1', firstFetchedAt: 1, verifyDueAt: 1_800_000_000, secondAccount: null, secondFetchedAt: null, verifiedAt: null, mismatches: 0, ...extra })
    const pending = byKey({ ...empty(), verification: ver({}) }).verification
    expect([pending.tone, pending.finding]).toEqual(['warn', 'First fetch by acct-1, second fetch due UNTIL.'])
    // A due time already past reads as "… ago", never "in 1m".
    expect(byKey({ ...empty(), verification: ver({ verifyDueAt: 1_000_000 }) }).verification.finding).toBe('First fetch by acct-1, second fetch due REL.')
    const verified = byKey({ ...empty(), verification: ver({ state: 'verified', verifiedAt: 1, secondAccount: 'acct-2', secondFetchedAt: 1, mismatches: 2 }) }).verification
    expect([verified.tone, verified.finding]).toEqual(['ok', 'Verified REL (30 rows). 2 earlier pair(s) disagreed.'])
    const add = (status: string, message: string | null = null) => ({ ...empty(), playlist: { additions: [{ key: '1', ts: 1_790_000_000_000, status, slug: 'dj', videoId: null, message }], confirmed: [] } })
    expect([byKey(add('failed', 'quota')).playlist.tone, byKey(add('failed', 'quota')).playlist.finding]).toEqual(['bad', 'failed: quota.'])
    expect(byKey(add('no_youtube')).playlist.tone).toBe('warn')
    expect(byKey(add('added')).playlist.tone).toBe('ok')
    const backoff = byKey({ ...empty(), mkvid: pendingMkvid({ readiness: { state: 'backoff', until: 1_800_000_000 } }) }).mkvid
    expect([backoff.tone, backoff.finding]).toEqual(['warn', '#3; retry backoff until UNTIL.'])
    const done = byKey({ ...empty(), mkvid: pendingMkvid({ status: 'done', position: null, readiness: null, videoId: 'abcdefghijk' }) }).mkvid
    expect([done.tone, done.finding]).toEqual(['ok', 'Uploaded abcdefghijk.'])
    const sup = byKey({ ...empty(), mkvid: pendingMkvid({ status: 'superseded', position: null, readiness: null }) }).mkvid
    expect([sup.tone, sup.finding]).toEqual(['neutral', 'Superseded by an official recording.'])
  })
  it('the sticky column scrolls on its own from 1100px', async () => {
    const { SET_DIAG_CSS } = await import('../src/ui/pages/set-diag')
    const wide = /@media \(min-width: 1100px\) \{([\s\S]*?)\n  \}/.exec(SET_DIAG_CSS)![1]!
    const rule = /\.set-diag \{([^}]*)\}/.exec(wide)![1]!
    expect(rule).toContain('position: sticky')
    expect(rule).toContain('max-height: calc(100vh - 2 * var(--sp-4))')
    expect(rule).toContain('overflow-y: auto')
  })
  it('renderDiag escapes upstream text and links DJs, removed videos and mkvid', async () => {
    const ctx = await diagCtx()
    const d = { ...empty(),
      discovered: [{ slug: 'dj-one', artistName: XSS, discoveredAt: 1_790_000_000, processed: true, abandoned: false, failureCount: 0, videoKnown: true, videoId: 'abcdefghijk', videoSource: 'youtube', checkedAt: 1_790_000_000 }],
      media: { videoId: 'abcdefghijk', noFullNotice: false, lastCueSeconds: 3600, audioMaxSeconds: null, audioKind: null, setTitle: XSS, setDate: null, trackCount: 10, idedCount: 9, fetchedAt: 1_790_000_000 },
      video: video(),
      playlist: { additions: [{ key: '1', ts: 1_790_000_000_000, status: 'failed', slug: 'dj-one', videoId: 'abcdefghijk', message: XSS }], confirmed: [] },
      hygiene: { removed: [], removals: [{ id: 1, at: 1_790_000_000, source: 'sweep', status: 'failed', playlistKind: 'dj', reason: 'dead', detail: XSS }] },
      mkvid: pendingMkvid({ status: 'failed', position: null, readiness: null, error: XSS }),
    }
    const html = ctx.renderDiag(d) as string
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=1&gt;')
    expect(html).toContain('href="/ui/dj/dj-one"')
    expect(html).toContain('href="/ui/removed"')
    expect(html).toContain('href="/ui/mkvid"')
    expect(html.split('class="diag-row"').length - 1).toBe(7)
  })

  async function runSet(answers: { tracklist: () => Response; set: () => Response }) {
    const url = 'https://www.1001tracklists.com/tracklist/x/some-set.html'
    const fetches: string[] = []
    const { ctx, els } = richStub(async (u: string) => {
      fetches.push(u)
      if (u === '/ui/api/tracklist') return answers.tracklist()
      if (u.startsWith('/ui/api/set?url=')) return answers.set()
      return new Response('{}', { status: 404 })
    }, '/ui/set')
    ;(ctx as any).location.search = '?url=' + encodeURIComponent(url)
    const html = await (await app.request('https://tracked.example/ui/set', {}, env())).text()
    for (const s of scriptsOf(html)) vm.runInContext(s, ctx)
    for (let i = 0; i < 15; i++) await new Promise((res) => setTimeout(res, 0))
    return { fetches, els, html, url }
  }
  it('the page keeps its ids and carries the diagnostics column', async () => {
    const html = await (await app.request('https://tracked.example/ui/set', {}, env())).text()
    for (const id of ['load-form', 'url', 'load-btn', 'error', 'setmeta', 'cachebar', 'refresh', 'load-links', 'tracks', 'empty']) expect(html).toContain(`id="${id}"`)
    expect(html).toContain('<aside id="diag" class="tk-card set-diag" aria-label="Diagnostics" hidden>')
    expect(html).toContain('class="set-layout"')
    expect(html).toContain('why it is or is not in your playlists')
  })
  it('diagnostics render when the track list fails', async () => {
    const { fetches, els, url } = await runSet({
      tracklist: () => Response.json({ error: 'upstream', message: 'Upstream failed' }, { status: 502 }),
      set: () => Response.json(empty()),
    })
    expect(fetches).toContain('/ui/api/set?url=' + encodeURIComponent(url))
    expect(fetches).toContain('/ui/api/tracklist')
    expect(els.get('diag').hidden).toBe(false)
    expect(els.get('diag').innerHTML).toContain('Discovered')
    expect(els.get('error').textContent).toBe('Upstream failed')
  })
  it('a 400 hides the column', async () => {
    const { els } = await runSet({
      tracklist: () => Response.json({ error: 'invalid_request', message: 'not a tracklist' }, { status: 400 }),
      set: () => Response.json({ error: 'invalid_request', message: 'not a tracklist' }, { status: 400 }),
    })
    expect(els.get('diag').hidden).toBe(true)
  })
  it('a newer load drops the older diagnostics response', async () => {
    const url2 = 'https://www.1001tracklists.com/tracklist/y/other-set.html'
    let releaseOld!: () => void
    const oldGate = new Promise<void>((r) => { releaseOld = r })
    let submit: ((ev: unknown) => void) | undefined
    const { ctx, els } = richStub(async (u: string) => {
      if (u === '/ui/api/tracklist') return Response.json({ tracks: [], trackCount: 0 })
      if (u === '/ui/api/set?url=' + encodeURIComponent(url2)) return Response.json({ ...empty(), url: url2, media: { setTitle: 'NEW SET' } })
      if (u.startsWith('/ui/api/set?url=')) { await oldGate; return Response.json({ ...empty(), media: { setTitle: 'OLD SET' } }) }
      return new Response('{}', { status: 404 })
    }, '/ui/set')
    ;(ctx as any).location.search = '?url=' + encodeURIComponent('https://www.1001tracklists.com/tracklist/x/some-set.html')
    ;(ctx as any).document.getElementById('load-form').addEventListener = (t: string, fn: (ev: unknown) => void) => { if (t === 'submit') submit = fn }
    const html = await (await app.request('https://tracked.example/ui/set', {}, env())).text()
    for (const s of scriptsOf(html)) vm.runInContext(s, ctx)
    const tick = async () => { for (let i = 0; i < 15; i++) await new Promise((res) => setTimeout(res, 0)) }
    await tick()
    els.get('url').value = url2
    submit!({ preventDefault() {} })
    await tick()
    expect(els.get('diag').innerHTML).toContain('NEW SET')
    releaseOld()
    await tick()
    expect(els.get('diag').innerHTML).toContain('NEW SET')
    expect(els.get('diag').innerHTML).not.toContain('OLD SET')
  })
  it('any other failure says so in the column; the track list still renders', async () => {
    const { els } = await runSet({
      tracklist: () => Response.json({ tracks: [], trackCount: 0 }),
      set: () => Response.json({ error: 'internal' }, { status: 500 }),
    })
    expect(els.get('diag').hidden).toBe(false)
    expect(els.get('diag').innerHTML).toContain('Diagnostics unavailable: Something went wrong in the Worker.')
    expect(els.get('empty').textContent).toBe('No tracks found.')
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
