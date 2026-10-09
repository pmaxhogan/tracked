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
  ['/ui/scheduler', 'Scheduler'],
  ['/ui/captcha', 'Captchas'],
  ['/ui/captcha/ch-1', 'Captcha'],
  ['/ui/set', 'Set'],
  ['/ui/dj/some-dj', ''],
  ['/ui/removed', 'Removed videos'],
  ['/ui/mkvid', 'mkvid'],
  ['/ui/activity', 'Activity'],
  ['/ui/search', 'Search'],
  ['/ui/settings', 'Settings'],
  ['/ui/tools', 'Tools'],
  ['/ui/presaves', 'Pre-saves'],
  ['/ui/presave?id=1', 'Pre-saved track'],
  ['/ui/track-uploads', 'Track uploads'],
]

/** The pool tests' stub: no body, window, navigator, storage, location or history. */
function minimalStub() {
  const el = (): any => ({ innerHTML: '', textContent: '', value: '', hidden: false, checked: false, disabled: false, className: '', src: '', dataset: {}, style: {}, options: [],
    addEventListener() {}, focus() {}, add() {}, remove() {}, showModal() {}, close() {}, setAttribute() {}, removeAttribute() {}, getAttribute: () => null, querySelector: () => el(), querySelectorAll: () => [], closest: () => null })
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
  it('has a GET search form for the Search page (desktop only) and no POST form', () => {
    const h = shell({ nav: 'home', title: 'Home', body: '' })
    expect(h).toContain('<form class="tk-search" action="/ui/search" method="get" role="search">')
    expect(h).toContain('<input id="tk-search" name="q" type="search" placeholder="Search tracks, sets, DJs" aria-label="Search tracks, sets, DJs">')
    expect(h).not.toMatch(/<form[^>]*method="?post/i)
    expect(h).toContain('href="/ui/" data-tip="tracked: back to Home" data-tip-rail')
    expect(h).not.toMatch(/ title="/)
  })
  it('its shared scripts run in the minimal pool stub', () => {
    const c = minimalStub()
    for (const s of scriptsOf(shell({ nav: 'pool', title: 'Pool accounts', body: '' })).slice(0, 4)) expect(() => vm.runInContext(s, c)).not.toThrow()
  })
  it('narrow pages get the 560px column and phone tabs list the five destinations', () => {
    const h = shell({ nav: 'captcha', title: 'Captcha', body: '', width: 'narrow' })
    expect(h).toContain('tk-main narrow')
    for (const p of ['/ui/', '/ui/djs', '/ui/search', '/ui/mkvid', '/ui/pool']) expect(h).toContain(`href="${p}"`)
    // Activity is in the sidebar and the menu, never a phone tab.
    const tabBar = /<nav class="tk-tabs"[^>]*>([\s\S]*?)<\/nav>/.exec(h)![1]!
    expect(tabBar.match(/href="/g)!.length).toBe(5)
    expect(tabBar).not.toContain('/ui/activity')
  })
  it('the Activity nav item sits in the Pipeline group and lights up on its page', () => {
    const h = shell({ nav: 'activity', title: 'Activity', body: '' })
    expect(h).toMatch(/<a [^>]*href="\/ui\/activity"[^>]*class="on"/)
    // mkvid, then Track uploads, then Activity.
    expect(h).toMatch(/href="\/ui\/mkvid"[^>]*>(?:(?!<\/a>)[\s\S])*<\/a><a href="\/ui\/track-uploads"[^>]*>(?:(?!<\/a>)[\s\S])*<\/a><a href="\/ui\/activity"/)
  })
  it('Pre-saves sits in the Library group after Search, and neither new page is a phone tab', () => {
    const h = shell({ nav: 'presaves', title: 'Pre-saves', body: '' })
    expect(h).toMatch(/<a [^>]*href="\/ui\/presaves"[^>]*class="on"/)
    expect(h).toMatch(/href="\/ui\/search"[^>]*>(?:(?!<\/a>)[\s\S])*<\/a><a href="\/ui\/presaves"/)
    const tabBar = /<nav class="tk-tabs"[^>]*>([\s\S]*?)<\/nav>/.exec(h)![1]!
    expect(tabBar).not.toContain('/ui/presaves')
    expect(tabBar).not.toContain('/ui/track-uploads')
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
    // Hover hints are data-tip tooltips (src/ui/tip.ts), never the browser's title="" (an iframe's title is its accessible name, not a hint).
    expect(text).not.toMatch(/<(?!iframe\b)[a-z][^>]*\stitle="/i)
    expect(text).not.toMatch(/\b(?!document\b)\w+\.title = /)
    // Every tooltip says something, and the copy has no em dash.
    for (const m of text.matchAll(/ data-tip="([^"]*)"/g)) { expect(m[1]!.trim()).not.toBe(''); expect(m[1]).not.toContain('\u2014') }
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
    addEventListener() {}, focus() {}, add() {}, remove() {}, showModal() {}, close() {}, setAttribute() {}, removeAttribute() {}, getAttribute: () => null, querySelector: () => el(), querySelectorAll: () => [], closest: () => null })
  const els = new Map<string, any>()
  const document = { hidden: false, getElementById: (id: string) => (els.has(id) ? els.get(id) : (els.set(id, el()), els.get(id))), querySelector: () => null, addEventListener() {}, createElement: () => el() }
  const ctx = vm.createContext({ document, fetch: fetchImpl, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, console, Date, URLSearchParams,
    location: { search: '', pathname }, history: { replaceState() {} },
    Option: function (t: string, v: string) { return { text: t, value: v } } })
  return { ctx, els }
}

describe('mkvid page script', () => {
  it('renders the status line from GET /ui/api/mkvid and the queue table from /ui/api/mkvid/queue, with the server position', async () => {
    const now = Math.floor(Date.now() / 1000)
    const header = {
      enabled: true, dailyClaimCap: 30, dailyClaims: 3, now, quotaResetsAt: now + 3600,
      counts: { pending: 1, claimed: 0, done: 0, failed: 0, superseded: 0, banned: 0 },
      accounts: [{ account: 'primary', label: 'primary', cap: 24, used: 3 }],
      lastPoll: { at: now, outcome: 'ok', accounts: ['primary'] },
      oldStyleCount: 0, oldVideos: [], djs: [{ slug: 'some-dj', label: 'Some DJ', count: 1 }], rendering: [],
    }
    const queue = { total: 1, page: 1, size: 25, pageCount: 1, rows: [{ id: 'r1', slug: 'some-dj', setUrl: 'https://www.1001tracklists.com/tracklist/x/some-set.html', setTitle: 'Some Set', setDate: '2026-09-01', source: 'soundcloud', sourceLabel: 'SoundCloud',
      sourceUrl: 'https://soundcloud.com/x/y', status: 'pending', account: 'primary', attempts: 0, notBefore: null, createdAt: now, updatedAt: now, skipIdWait: false, style: null, replacesVideoId: null,
      position: 7, readiness: { state: 'waiting_ids', until: now + 86400 * 3, idRows: 2 } }] }
    const fetches: string[] = []
    const { ctx, els } = richStub(async (u: string) => (fetches.push(u), u === '/ui/api/mkvid' ? Response.json(header) : u.startsWith('/ui/api/mkvid/queue?') ? Response.json(queue)
      : u.startsWith('/ui/api/mkvid/finished?') ? Response.json({ rows: [], total: 0, page: 1, size: 25, pageCount: 1 }) : new Response('{}', { status: 404 })), '/ui/mkvid')
    const r = await app.request('https://tracked.example/ui/mkvid', {}, env())
    for (const s of scriptsOf(await r.text())) vm.runInContext(s, ctx)
    for (let i = 0; i < 10; i++) await new Promise((res) => setTimeout(res, 0))
    expect(fetches).toContain('/ui/api/mkvid')
    expect(fetches.some((u) => u.startsWith('/ui/api/mkvid/queue?'))).toBe(true)
    const queueHtml = els.get('q-body').innerHTML as string
    expect(queueHtml).toContain('#7')
    expect(queueHtml).toContain('waiting for IDs until')
    expect(els.get('mk-state').innerHTML).toContain('Ready — mkvid takes the next set on its next poll')
  })
})

/** One /ui/api/djs answer (lib/dj-table.ts DjTableRow shape). */
const djRow = (n: number, extra: Record<string, unknown> = {}) => ({
  slug: `dj-${n}`, name: `DJ ${n}`, artistName: `DJ ${n}`, sourceUrl: `https://www.1001tracklists.com/dj/dj-${n}/index.html`, addedAt: 1000,
  sets: 2, processed: 1, pending: 1, abandoned: 0, videos: 1, mkvid: 0, playlistId: `PL${n}`, playlistUrl: `https://www.youtube.com/playlist?list=PL${n}`,
  lastRunAt: Date.now() - 120_000, lastError: null, hasError: false, lastAdded: null, lastDiscoveredAt: null, ...extra,
})
const djsAnswer = (rows: unknown[]) => ({ rows, total: rows.length, page: 1, size: 50, pageCount: 1, sort: [{ col: 'name', dir: 'asc' }], filters: [], q: '', counts: { total: rows.length, errors: 1, pending: rows.length, neverSynced: 0, noPlaylist: 0, mkvid: 0 } })

describe('DJs page script', () => {
  it('renders the table from one GET /ui/api/djs (no per-DJ state calls), with profile links, counts and the row actions', async () => {
    const fetches: string[] = []
    const { ctx, els } = richStub(async (u: string) => {
      fetches.push(u)
      if (u.startsWith('/ui/api/djs?')) return Response.json(djsAnswer([djRow(1), djRow(2, { hasError: true, lastError: 'boom' })]))
      return new Response('{}', { status: 404 })
    }, '/ui/djs')
    const r = await app.request('https://tracked.example/ui/djs', {}, env())
    const html = await r.text()
    expect(html).toContain('id="fix-titles"')
    expect(html).toContain('<div id="djs"></div>')
    for (const s of scriptsOf(html)) vm.runInContext(s, ctx)
    for (let i = 0; i < 15; i++) await new Promise((res) => setTimeout(res, 0))
    expect(fetches.filter((u) => u.startsWith('/ui/api/djs?'))).toEqual(['/ui/api/djs?page=1&size=50&sort=name'])
    expect(fetches.some((u) => u.startsWith('/ui/api/state/') || u === '/ui/api/list')).toBe(false)
    const body = els.get('djs-body').innerHTML as string
    expect(body).toContain('/ui/dj/dj-1')
    expect(body).toContain('/ui/dj/dj-2')
    expect(body).toContain('aria-label="Invalidate and resync dj-1"')
    expect(body).toContain('data-act="resync"')
    expect(body).toContain('data-act="sync"')
    expect(body).toContain('data-act="remove"')
    expect(body).toContain('1 of 2')
    expect(body).toContain('1 pending')
    expect(body).toContain('https://www.youtube.com/playlist?list=PL1')
    expect(body).toContain('badge bad')
    expect(els.get('djs-chips').innerHTML).toContain('Errors')
    expect(els.get('sync-all').hidden).toBe(false)
  })
})

describe('DJs page ?focus=filter and bulk actions', () => {
  it('focuses the search once there are DJs, and locks row buttons while Sync all runs over every slug', async () => {
    const fetches: string[] = []
    const { ctx, els } = richStub(async (u: string) => {
      fetches.push(u)
      if (u.startsWith('/ui/api/djs?')) return Response.json(djsAnswer([djRow(1)]))
      if (u === '/ui/api/list') return Response.json({ subscriptions: [{ slug: 'dj-1', sourceUrl: 'https://x', addedAt: 1 }, { slug: 'dj-2', sourceUrl: 'https://x', addedAt: 2 }] })
      if (u.startsWith('/ui/api/sync/')) { await new Promise((res) => setTimeout(res, 20)); return Response.json({ stats: {} }) }
      return new Response('{}', { status: 404 })
    }, '/ui/djs')
    ;(ctx as any).location.search = '?focus=filter'
    const doc = (ctx as any).document
    const mk = (): any => ({ innerHTML: '', textContent: '', className: '', children: [] as any[], appendChild(c: any) { this.children.push(c) }, setAttribute() {} })
    doc.createElement = mk
    doc.getElementById('tk-toasts').appendChild = () => {}
    let focusedQ = 0
    doc.getElementById('djs-q').focus = () => { focusedQ++ }
    const handlers: Record<string, () => void> = {}
    doc.getElementById('sync-all').addEventListener = (_t: string, fn: () => void) => { handlers.syncAll = fn }
    const html = await (await app.request('https://tracked.example/ui/djs', {}, env())).text()
    for (const s of scriptsOf(html)) vm.runInContext(s, ctx)
    for (let i = 0; i < 15; i++) await new Promise((res) => setTimeout(res, 0))
    expect(focusedQ).toBe(1)
    handlers.syncAll!()
    await new Promise((res) => setTimeout(res, 5))
    expect(els.get('resync-all').disabled).toBe(true)
    expect(els.get('djs-body').innerHTML).toContain('disabled')
    await new Promise((res) => setTimeout(res, 120))
    expect(fetches).toContain('/ui/api/list')
    expect(fetches.filter((u) => u.startsWith('/ui/api/sync/'))).toEqual(['/ui/api/sync/dj-1', '/ui/api/sync/dj-2'])
    expect(els.get('resync-all').disabled).toBe(false)
    expect(els.get('djs-body').innerHTML).not.toContain('disabled')
  })
})

describe('Playlists page script', () => {
  it('fills the connection card, the combined card with its meter, the DJ playlist table and the hygiene strip', async () => {
    const fetches: string[] = []
    const { ctx, els } = richStub(async (u: string) => {
      fetches.push(u)
      if (u === '/ui/api/youtube/status') return Response.json({ connected: true, channelTitle: 'My channel', scope: 'youtube' })
      if (u === '/ui/api/combined') return Response.json({ connected: true, title: 'All DJs', playlistId: 'PLc', playlistUrl: 'https://www.youtube.com/playlist?list=PLc', videoCount: 12, missingTotal: 3, sources: [{}], dailyInsertCap: 100, dailyInsertsUsed: 25 })
      if (u === '/ui/api/removals?limit=1') return Response.json({ settings: { dryRun: true, dailyRemovals: 20 }, deletesUsedToday: 2, holds: [{}] })
      if (u.startsWith('/ui/api/djs?')) return Response.json(djsAnswer([djRow(1, { mkvid: 1, lastAdded: 3 }), djRow(2, { playlistId: null, playlistUrl: null })]))
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
    expect(fetches.some((u) => u.startsWith('/ui/api/state/'))).toBe(false)
    const rows = els.get('pl-body').innerHTML as string
    expect(rows).toContain('https://www.youtube.com/playlist?list=PL1')
    expect(rows).toContain('DJ 1 (1001tklists)')
    expect(rows).toContain('DJ 2 · not created yet')
    expect(rows).toContain('+3')
    expect(els.get('hygiene').innerHTML).toContain('DRY RUN')
    expect(els.get('hygiene').innerHTML).toContain('1 held')
  })
})

/** Gives the stub's elements appendChild (the Set and DJ pages build their link bars with DOM calls). */
function withAppend(ctx: any) {
  const doc = ctx.document
  const add = (e: any) => { if (e && !e.appendChild) { e.children = []; e.appendChild = function (c: any) { this.children.push(c); return c } } return e }
  const get = doc.getElementById
  doc.getElementById = (id: string) => add(get(id))
  const mk = doc.createElement
  doc.createElement = () => add(mk())
}
/** A click on a button with data-act inside table row i (what TKTable's delegated handler reads). */
const actClick = (act: string, i: number) => {
  const tr = { getAttribute: (k: string) => (k === 'data-tkt-row' ? String(i) : null), closest: () => null }
  const btn: any = { getAttribute: (k: string) => (k === 'data-act' ? act : null), closest: (sel: string) => (sel === '[data-act]' ? btn : sel === 'tr[data-tkt-row]' ? tr : null) }
  return { target: btn }
}
const rowClick = (i: number) => {
  const tr = { getAttribute: (k: string) => (k === 'data-tkt-row' ? String(i) : null) }
  return { target: { getAttribute: () => null, closest: (sel: string) => (sel === 'tr[data-tkt-row]' ? tr : null) } }
}
const SET_URL = 'https://www.1001tracklists.com/tracklist/x/some-set.html'
/** A /ui/api/tracklist answer: a named row, a "w/" row on it, an anonymous ID row and a partial ID. */
const tracklistAnswer = () => ({
  tracklistUrl: SET_URL, trackCount: 3, cacheAgeSeconds: 60,
  tracks: [
    { index: 0, rowIndex: 0, artist: 'Alpha', title: 'First', startTime: '00:00', startSeconds: 0, trackId: '111', trackUrl: 'https://www.1001tracklists.com/track/a/first/index.html', artworkUrl: 'https://img.example/a.jpg', appleLink: null, youtubeLink: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', soundcloudLink: null, isUnidentified: false, idStatus: null, isMashupLinked: false },
    { index: 1, rowIndex: 1, artist: 'Bravo', title: 'Second', startTime: '00:00', startSeconds: 0, trackId: '222', trackUrl: 'https://www.1001tracklists.com/track/b/second/index.html', artworkUrl: null, appleLink: null, youtubeLink: null, soundcloudLink: null, isUnidentified: false, idStatus: null, isMashupLinked: true },
    { index: 2, rowIndex: 3, artist: 'Delta', title: 'Fourth (ID Remix)', startTime: '06:00', startSeconds: 360, trackId: '444', trackUrl: null, artworkUrl: null, appleLink: null, youtubeLink: null, soundcloudLink: null, isUnidentified: false, idStatus: 'ID Remix', isMashupLinked: false },
  ],
  rows: [
    { rowIndex: 0, cueSeconds: 0, startTime: '00:00', artist: 'Alpha', title: 'First', trackId: '111', trackUrl: 'https://www.1001tracklists.com/track/a/first/index.html', artworkUrl: 'https://img.example/a.jpg', isUnidentified: false, idStatus: null, isMashupLinked: false, anonymous: false },
    { rowIndex: 1, cueSeconds: 0, startTime: '00:00', artist: 'Bravo', title: 'Second', trackId: '222', trackUrl: 'https://www.1001tracklists.com/track/b/second/index.html', artworkUrl: null, isUnidentified: false, idStatus: null, isMashupLinked: true, anonymous: false },
    { rowIndex: 2, cueSeconds: 180, startTime: '03:00', artist: 'ID', title: 'ID', trackId: null, trackUrl: null, artworkUrl: null, isUnidentified: true, idStatus: null, isMashupLinked: false, anonymous: true },
    { rowIndex: 3, cueSeconds: 360, startTime: '06:00', artist: 'Delta', title: 'Fourth (ID Remix)', trackId: '444', trackUrl: null, artworkUrl: null, isUnidentified: false, idStatus: 'ID Remix', isMashupLinked: false, anonymous: false },
  ],
})

describe('Set page track table', () => {
  async function runTable() {
    const calls: Array<{ u: string; body: any }> = []
    const { ctx, els } = richStub(async (u: string, init?: RequestInit) => {
      calls.push({ u, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (u === '/ui/api/tracklist') return Response.json(tracklistAnswer())
      if (u === '/ui/api/presaves/lookup') return Response.json({ byTrackId: { 444: { id: 9, stage: 'links' } }, byRow: {} })
      if (u === '/ui/api/presaves') return Response.json({ ok: true, created: true, presave: { id: 12, stage: 'identify' }, message: 'Pre-saved: ID row (watching)' })
      if (u.startsWith('/ui/api/set?url=')) return Response.json({ error: 'x' }, { status: 400 })
      return new Response('{}', { status: 404 })
    }, '/ui/set')
    withAppend(ctx)
    ;(ctx as any).location.search = '?url=' + encodeURIComponent(SET_URL)
    const doc = (ctx as any).document
    doc.getElementById('tk-toasts').appendChild = () => {}
    const handlers: Record<string, (e: unknown) => void> = {}
    doc.getElementById('tracks').addEventListener = (t: string, fn: (e: unknown) => void) => { handlers[t] = fn }
    const html = await (await app.request('https://tracked.example/ui/set', {}, env())).text()
    for (const s of scriptsOf(html)) vm.runInContext(s, ctx)
    const tick = async () => { for (let i = 0; i < 20; i++) await new Promise((res) => setTimeout(res, 0)) }
    await tick()
    return { calls, els, handlers, tick }
  }
  it('lists every page row (anonymous ID rows too) with cue, status, links and Pre-save, and marks saved rows', async () => {
    const { calls, els } = await runTable()
    const body = els.get('trk-body').innerHTML as string
    expect(body.split('<tr ').length - 1).toBe(4)
    expect(body).toContain('class="tkt-child"') // the w/ row hangs under its base
    expect(body).toContain('>w/<')
    expect(body).toContain('ID Remix')
    expect(body).toContain('>ID<')
    expect(body).toContain('03:00')
    expect(body).toContain('https://www.youtube.com/watch?v=aaaaaaaaaaa')
    expect(body).toContain('href="https://www.1001tracklists.com/track/b/second/index.html"')
    expect(body).toContain('data-act="links"')
    // Rows without a YouTube link get Pre-save; the row already saved (track 444) links to its pre-save.
    expect(body.split('data-act="presave"').length - 1).toBe(2)
    expect(body).toContain('href="/ui/presave?id=9"')
    expect(body).toContain('Pre-saved ✓')
    const lookup = calls.find((c) => c.u === '/ui/api/presaves/lookup')!
    expect(lookup.body).toEqual({ trackIds: ['111', '222', '444'], setUrl: SET_URL })
    expect(els.get('trk-chips').innerHTML).toContain('No YouTube')
  })
  it('Pre-save on an anonymous row posts the set and row, omits the ID placeholders, and turns into a link', async () => {
    const { calls, els, handlers, tick } = await runTable()
    handlers.click!(actClick('presave', 2))
    await tick()
    const post = calls.find((c) => c.u === '/ui/api/presaves')!
    expect(post.body).toEqual({ tracklistUrl: SET_URL, rowIndex: 2, cueSeconds: 180 })
    const body = els.get('trk-body').innerHTML as string
    expect(body).toContain('href="/ui/presave?id=12"')
    expect(body.split('data-act="presave"').length - 1).toBe(1)
  })
  it('a named row posts its track id, URL and names', async () => {
    const { calls, handlers, tick } = await runTable()
    handlers.click!(actClick('presave', 1))
    await tick()
    expect(calls.find((c) => c.u === '/ui/api/presaves')!.body).toEqual({ tracklistUrl: SET_URL, rowIndex: 1, trackId: '222', trackUrl: 'https://www.1001tracklists.com/track/b/second/index.html', cueSeconds: 0, artist: 'Bravo', title: 'Second' })
  })
})

describe('DJ profile set table', () => {
  it('lists the sets with what D1 knows, chips with counts, and expands a row into its track table', async () => {
    const calls: Array<{ u: string; body: any }> = []
    const sets = [
      { url: 'https://www.1001tracklists.com/tracklist/a1/one-2026-01-01.html', tlSlug: 'a1', title: 'One', date: '2026-01-01', facts: { tracked: true, processed: true, abandoned: false, video: 'page', videoId: 'v1', trackCount: 20, idedCount: 18, factsAt: 1 } },
      { url: 'https://www.1001tracklists.com/tracklist/a2/two-2026-02-01.html', tlSlug: 'a2', title: 'Two', date: '2026-02-01', facts: { tracked: true, processed: true, abandoned: false, video: 'none', videoId: null, trackCount: 10, idedCount: 10, factsAt: 1 } },
      { url: SET_URL, tlSlug: 'x', title: 'Three', date: '2026-03-01', facts: null },
    ]
    const { ctx, els } = richStub(async (u: string, init?: RequestInit) => {
      calls.push({ u, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (u === '/ui/api/dj/dj-1') return Response.json({ slug: 'dj-1', artistName: 'DJ One', sets, source: 'crawl', crawledAt: 1, subscribed: true, listingComplete: true })
      if (u === '/ui/api/state/dj-1') return Response.json({ state: null })
      if (u === '/ui/api/tracklist') return Response.json(tracklistAnswer())
      if (u === '/ui/api/presaves/lookup') return Response.json({ byTrackId: {}, byRow: {} })
      return new Response('{}', { status: 404 })
    }, '/ui/dj/dj-1')
    withAppend(ctx)
    const doc = (ctx as any).document
    const handlers: Record<string, (e: unknown) => void> = {}
    doc.getElementById('sets').addEventListener = (t: string, fn: (e: unknown) => void) => { handlers[t] = fn }
    const html = await (await app.request('https://tracked.example/ui/dj/dj-1', {}, env())).text()
    for (const s of scriptsOf(html)) vm.runInContext(s, ctx)
    const tick = async () => { for (let i = 0; i < 20; i++) await new Promise((res) => setTimeout(res, 0)) }
    await tick()
    const body = els.get('st-body').innerHTML as string
    // Newest first; facts drive the video and ID columns.
    expect(body.indexOf('Three')).toBeLessThan(body.indexOf('Two'))
    expect(body).toContain('18/20')
    expect(body).toContain('>partial<')
    expect(body).toContain('>no video<')
    expect(body).toContain('data-act="toggle"')
    const chips = els.get('st-chips').innerHTML as string
    expect(chips).toMatch(/With video<span class="tkt-count">1</)
    expect(chips).toMatch(/Not read yet<span class="tkt-count">1</)
    handlers.click!(rowClick(0))
    await tick()
    expect(calls.find((c) => c.u === '/ui/api/tracklist')!.body).toEqual({ url: SET_URL })
    // The opened set now knows its list: 3 of 4 rows identified, partial.
    expect(els.get('st-body').innerHTML).toContain('3/4')
    expect(els.get('st-body').innerHTML).toContain('Hide')
    expect(els.get('dt1-body').innerHTML).toContain('data-act="presave"')
    expect(calls.some((c) => c.u === '/ui/api/presaves/lookup')).toBe(true)
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
    for (const id of ['h-sync-all', 'h-backfill', 'h-compare', 'attn', 'act-table']) expect(html).toContain(`id="${id}"`)
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
      if (u.startsWith('/ui/api/activity?')) return Response.json({ total: 3, page: 1, size: 12, pageCount: 1, rows: [
        { id: 'audit:1', ts: Date.now() - 1000, kind: 'request', status: 'no_video', problem: true, title: 'A <set>', detail: 'no match', dj: null, setUrl: null, videoId: null, ref: { kind: 'audit', key: '1' } },
        { id: 'addition:2', ts: Date.now() - 2000, kind: 'playlist', status: 'added', problem: false, title: 'some set', detail: 'added to PL1', dj: 'dj-1', setUrl: null, videoId: 'abcdefghijk', ref: { kind: 'addition', key: '2' } },
        { id: 'pool:7', ts: Date.now() - 3000, kind: 'pool', status: 'account.flagged', problem: true, title: 'acct-2 flagged <b>', detail: '', dj: null, setUrl: null, videoId: null, ref: { kind: 'pool', key: '7' } },
      ] })
      if (u === '/ui/api/audit-detail?key=1') return Response.json({ record: { t: 'now', reqId: 'r1', status: 'ok', input: { videoTitle: 'A <set>' }, youtube: { videoId: 'abcdefghijk' }, search: { attempts: [] }, meta: {} } })
      if (u.startsWith('/ui/api/playlist-addition-detail')) return Response.json({ error: 'not_found' }, { status: 404 })
      return new Response('{}', { status: 404 })
    }, '/ui')
    ;(ctx as any).URL = URL // TK.fmt.setLabel parses the set URL
    const clicks: Record<string, (ev: unknown) => void> = {}
    for (const id of ['act-table']) (ctx as any).document.getElementById(id).addEventListener = (t: string, fn: (ev: unknown) => void) => { if (t === 'click') clicks[id] = fn }
    const html = await (await app.request('https://tracked.example/ui', {}, env())).text()
    for (const s of scriptsOf(html)) vm.runInContext(s, ctx)
    for (let i = 0; i < 20; i++) await new Promise((res) => setTimeout(res, 0))
    for (const u of ['/ui/api/ban/status', '/ui/api/pool/status', '/ui/api/pool/challenges', '/ui/api/youtube/status', '/ui/api/combined', '/ui/api/list', '/ui/api/state/dj-1']) expect(fetches).toContain(u)
    expect(fetches).toContain('/ui/api/mkvid?limit=1')
    // The compact activity table: the newest twelve rows of the last 7 days, one request.
    const act0 = fetches.filter((u) => u.startsWith('/ui/api/activity?')).map(decodeURIComponent)
    expect(act0).toHaveLength(1)
    expect(act0[0]).toContain('page=1&size=12&sort=-ts&f.ts=gte:')
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
    const act = els.get('act-body').innerHTML as string
    expect(act).toContain('A &lt;set&gt;')
    expect(act).not.toContain('<set>')
    expect(act).toMatch(/<tr data-tkt-row="0"[^>]*data-problem="1"/)
    expect(act).not.toMatch(/<tr data-tkt-row="1"[^>]*data-problem="1"/)
    expect(act).toContain('acct-2 flagged &lt;b&gt;')
    expect(els.get('act-pager')).toBeUndefined() // compact: no pager
    const clickRow = async (i: string) => {
      clicks['act-table']!(tableClick({ row: Number(i) }))
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

/** A click target inside a TKTable: closest() answers the selectors the table asks for (data-table.ts onClick). */
function tableClick(opts: { row?: number; tkt?: Record<string, string> }): any {
  const attrs = opts.tkt ?? {}
  const t: any = {
    getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
    closest(sel: string) {
      if (sel === '[data-tkt]') return opts.tkt ? t : null
      if (sel === 'tr[data-tkt-row]') return opts.row == null ? null : { getAttribute: () => String(opts.row) }
      return null
    },
  }
  return { target: t }
}

describe('Activity page', () => {
  const rows = [
    { id: 'audit:000000000011', ts: Date.now() - 60_000, kind: 'request', status: 'no_video', problem: true, title: 'Bad <img src=x onerror=1>', detail: 'no match', dj: null, setUrl: null, videoId: null, ref: { kind: 'audit', key: '11' } },
    { id: 'addition:000000000012', ts: Date.now() - 120_000, kind: 'playlist', status: 'added', problem: false, title: 'Some set', detail: 'added to PL1', dj: 'dj-one', setUrl: 'https://www.1001tracklists.com/tracklist/x/some-set.html', videoId: 'abcdefghijk', ref: { kind: 'addition', key: '12' } },
  ]
  const poolRow = { id: 'pool:000000000007', ts: Date.now() - 30_000, kind: 'pool', status: 'account.flagged', problem: true, title: 'acct-3 flagged <b>', detail: 'too many', dj: null, setUrl: null, videoId: null, ref: { kind: 'pool', key: '7' } }
  const answer = (list: unknown[]) => Response.json({ rows: list, total: list.length, page: 1, size: 50, pageCount: 1, sort: [{ col: 'ts', dir: 'desc' }], filters: [], q: '' })
  type Answer = (u: string) => Promise<Response> | Response
  async function run(search: string, activity: Answer = () => answer(rows)) {
    const fetches: string[] = []
    const { ctx, els } = richStub(async (u: string) => {
      fetches.push(u)
      if (u.startsWith('/ui/api/activity?')) return activity(u)
      if (u === '/ui/api/list') return Response.json({ subscriptions: [{ slug: 'dj-one', sourceUrl: 'https://x', addedAt: 1 }] })
      if (u === '/ui/api/audit-detail?key=11') return Response.json({ record: { t: 'now', reqId: 'r1', status: 'no_video', input: { videoTitle: 'Bad <img src=x onerror=1>' }, youtube: {}, search: { attempts: [] }, meta: {} } })
      if (u === '/ui/api/playlist-addition-detail?key=12') return Response.json({ record: { t: 'now', status: 'added', setUrl: 'https://www.1001tracklists.com/tracklist/x/some-set.html', slug: 'dj-one', videoId: 'abcdefghijk', playlistId: 'PL1', playlistTitle: 'PL <one>', combinedStatus: 'added', meta: { ms: 5 } } })
      return new Response('{}', { status: 404 })
    }, '/ui/activity')
    const c = ctx as any
    c.URL = URL
    c.location.search = search
    // The table keeps its state in the query string: replaceState really changes it here.
    c.history = { state: null, replaceState(_s: unknown, _t: string, u: string) { const i = u.indexOf('?'); c.location.search = i < 0 ? '' : u.slice(i) } }
    const handlers: Record<string, (ev: unknown) => void> = {}
    for (const [id, type] of [['a-table', 'click'], ['a-dj', 'change']] as const) c.document.getElementById(id).addEventListener = (t: string, fn: (ev: unknown) => void) => { if (t === type) handlers[id] = fn }
    const html = await (await app.request('https://tracked.example/ui/activity', {}, env())).text()
    for (const s of scriptsOf(html)) vm.runInContext(s, ctx)
    for (let i = 0; i < 15; i++) await new Promise((res) => setTimeout(res, 0))
    const tableFetches = () => fetches.filter((u) => u.startsWith('/ui/api/activity?')).map(decodeURIComponent)
    return { fetches, tableFetches, els, handlers, html, ctx: c }
  }
  const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((res) => setTimeout(res, 0)) }
  it('renders one page from the table endpoint, escaped, with DJ and set links, a pager, and row drawers', async () => {
    const { fetches, tableFetches, els, handlers, html } = await run('')
    expect(html).toContain('id="a-table"')
    expect(html).toContain('id="a-dj"')
    // The page's own first fetch (BAN_JS reads the ban status on every page).
    const first = fetches.find((u) => !u.startsWith('/ui/api/ban/')) ?? ''
    expect(first.startsWith('/ui/api/activity?')).toBe(true)
    const u = tableFetches()[0]!
    expect(u).toContain('page=1&size=50&sort=-ts')
    // The 7d range chip is on by default; no kind filter.
    const since = Number(/f\.ts=gte:(\d+)/.exec(u)![1])
    expect(Math.abs(since - (Date.now() - 7 * 86_400_000))).toBeLessThan(600_000 + 1000)
    expect(u).not.toContain('f.kind')
    expect(fetches).toContain('/ui/api/list')
    const body = els.get('a-body').innerHTML as string
    expect(body.split('data-problem="1"').length - 1).toBe(1)
    expect(body).toContain('/ui/dj/dj-one')
    expect(body).toContain('/ui/set?url=')
    expect(body).toContain('&lt;img')
    expect(body).not.toContain('<img')
    expect(body).toContain('>Requests<')
    expect(els.get('a-pager').innerHTML).toContain('1–2 of 2')
    expect(els.get('a-chips').innerHTML).toContain('data-chip="problems"')
    expect(els.get('a-chips').innerHTML).toMatch(/class="chip on" data-tkt="chip" data-chip="7d"/)
    expect(els.get('a-dj').innerHTML).toContain('value="dj-one"')
    handlers['a-table']!(tableClick({ row: 0 }))
    await tick()
    expect(fetches).toContain('/ui/api/audit-detail?key=11')
    expect(els.get('tk-drawer-body').innerHTML).toContain('YouTube match')
    handlers['a-table']!(tableClick({ row: 1 }))
    await tick()
    expect(fetches).toContain('/ui/api/playlist-addition-detail?key=12')
    const pl = els.get('tk-drawer-body').innerHTML as string
    expect(pl).toContain('Playlist') // plDetailHtml's group heading
    expect(pl).toContain('PL &lt;one&gt;')
    expect(pl).toContain('https://www.youtube.com/playlist?list=PL1')
  })
  it('a row with no detail endpoint opens its own fields without a fetch', async () => {
    const { fetches, els, handlers } = await run('', () => answer([poolRow]))
    const before = fetches.length
    handlers['a-table']!(tableClick({ row: 0 }))
    await tick()
    expect(fetches.length).toBe(before)
    expect(els.get('tk-drawer-title').textContent).toBe('acct-3 flagged <b>')
    const body = els.get('tk-drawer-body').innerHTML as string
    expect(body).toContain('acct-3 flagged &lt;b&gt;')
    expect(body).toContain('account.flagged')
  })
  it('the kind, problems and range chips and the DJ select become table filters', async () => {
    const { tableFetches, handlers, els, ctx } = await run('')
    handlers['a-table']!(tableClick({ tkt: { 'data-tkt': 'chip', 'data-chip': 'k-pool' } }))
    await tick()
    expect(tableFetches().at(-1)).toContain('f.kind=in:pool')
    handlers['a-table']!(tableClick({ tkt: { 'data-tkt': 'chip', 'data-chip': 'problems' } }))
    await tick()
    expect(tableFetches().at(-1)).toContain('f.kind=in:pool')
    expect(tableFetches().at(-1)).toContain('f.problem=eq:1')
    handlers['a-table']!(tableClick({ tkt: { 'data-tkt': 'chip', 'data-chip': '24h' } }))
    await tick()
    const since = Number(/f\.ts=gte:(\d+)/.exec(tableFetches().at(-1)!)![1])
    expect(Math.abs(since - (Date.now() - 86_400_000))).toBeLessThan(600_000 + 1000)
    expect(tableFetches().at(-1)!.match(/f\.ts=/g)).toHaveLength(1)
    els.get('a-dj').value = 'dj-one'
    handlers['a-dj']!({})
    await tick()
    expect(tableFetches().at(-1)).toContain('f.dj=eq:dj-one')
    expect(decodeURIComponent(ctx.location.search)).toContain('a.f.dj=eq:dj-one')
    expect(decodeURIComponent(ctx.location.search)).toContain('a.chip=')
  })
  it('turns the old ?kind=, ?problems=1, ?range= and ?dj= links into table state', async () => {
    const { tableFetches, els, ctx } = await run('?kind=pool,ban,bogus&problems=1&range=24h&dj=dj-one')
    const u = tableFetches()[0]!
    expect(u).toContain('f.kind=in:pool|ban')
    expect(u).toContain('f.problem=eq:1')
    expect(u).toContain('f.dj=eq:dj-one')
    const since = Number(/f\.ts=gte:(\d+)/.exec(u)![1])
    expect(Math.abs(since - (Date.now() - 86_400_000))).toBeLessThan(600_000 + 1000)
    expect(ctx.location.search).not.toMatch(/(^|[?&])(kind|problems|range|dj)=/)
    expect(els.get('a-dj').value).toBe('dj-one')
    expect(els.get('a-chips').innerHTML).toMatch(/class="chip on" data-tkt="chip" data-chip="24h"/)
    const one = await run('?kind=sync')
    expect(one.tableFetches()[0]).toContain('f.kind=in:sync')
    expect(one.els.get('a-chips').innerHTML).toMatch(/class="chip on" data-tkt="chip" data-chip="k-sync"/)
  })
  it('a failed load shows the error with a retry', async () => {
    const { els } = await run('', () => Response.json({ error: 'bad_table_query', message: 'unknown column: x' }, { status: 400 }))
    expect(els.get('a-err').hidden).toBe(false)
    expect(els.get('a-err').innerHTML).toContain('unknown column: x')
    expect(els.get('a-err').innerHTML).toContain('data-tkt="retry"')
  })
  it('its page script runs in the minimal stub too', async () => {
    const html = await (await app.request('https://tracked.example/ui/activity', {}, env())).text()
    const c = minimalStub()
    for (const s of scriptsOf(html)) expect(() => vm.runInContext(s, c)).not.toThrow()
    for (let i = 0; i < 10; i++) await new Promise((res) => setTimeout(res, 0))
  })
  it('Home uses the shared detail renderers and activity columns instead of its own copy', async () => {
    const { readFileSync } = await import('node:fs')
    expect(readFileSync('src/ui/pages/home.ts', 'utf8')).not.toContain('function auditDetailHtml')
    const { ACTIVITY_DETAIL_JS } = await import('../src/ui/pages/activity-detail')
    const { ACTIVITY_ROW_JS } = await import('../src/ui/pages/activity')
    const { HOME_PAGE } = await import('../src/ui/pages/home')
    expect(HOME_PAGE.html).toContain(ACTIVITY_DETAIL_JS)
    expect(HOME_PAGE.html).toContain(ACTIVITY_ROW_JS)
  })
  it('on a phone a row is a card whose event takes the full width, without breaking words', async () => {
    const { ACTIVITY_ROW_CSS } = await import('../src/ui/pages/activity')
    const phone = /@media \(max-width: 699px\) \{([\s\S]*?)\n  \}/.exec(ACTIVITY_ROW_CSS)![1]!
    expect(phone).toMatch(/td\[data-label="Event"\] \{[^}]*flex-direction: column[^}]*text-align: left/)
    expect(phone).toMatch(/td\[data-label="Event"\]::before \{ content: none; \}/)
    expect(ACTIVITY_ROW_CSS).toContain('overflow-wrap: break-word')
    expect(ACTIVITY_ROW_CSS).not.toContain('overflow-wrap: anywhere')
    expect(ACTIVITY_ROW_CSS).not.toMatch(/word-break: break-all/)
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
    expect([sup.tone, sup.finding]).toEqual(['neutral', 'Superseded.'])
    const supOfficial = byKey({ ...empty(), mkvid: pendingMkvid({ status: 'superseded', position: null, readiness: null, supersededReason: 'superseded by an official recording (vidoffic001)' }) }).mkvid
    expect(supOfficial.finding).toBe('Superseded by an official recording (vidoffic001).')
    const supTwin = byKey({ ...empty(), mkvid: pendingMkvid({ status: 'superseded', position: null, readiness: null, supersededReason: 'duplicate URL: kept under another URL' }) }).mkvid
    expect(supTwin.finding).toBe('Duplicate URL: kept under another URL.')
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
  it('Settings lists the push devices and the ban episodes as tables (newest first, Open/Real/Simulated chips)', async () => {
    const now = Date.now()
    const ep = (i: number, extra: Record<string, unknown> = {}) => ({ key: 'ban:ep:' + i, startedAt: new Date(now - i * 3600_000).toISOString(), endedAt: new Date(now - i * 3600_000 + 600_000).toISOString(), blockedForMs: 600_000, ip: '10.0.0.' + i, source: 'home', simulated: false, poolRequests: i, brightdataRequests: 0, allBlockedHits: 0, clearedBy: 'captcha', pushStart: { sent: 1, total: 2 }, pushClear: null, ...extra })
    const { ctx, els } = richStub(async (u: string) => {
      if (u.startsWith('/ui/api/ban/status')) return Response.json({ poolConfigured: true, pushConfigured: true,
        pushSubscriptions: [{ ua: 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0', lastOkAt: new Date(now).toISOString(), lastError: null, createdAt: '2026-01-01T00:00:00Z' }, { ua: 'Mozilla/5.0 (Windows NT 10.0) Firefox/131.0', lastOkAt: null, lastError: '410 <gone>', createdAt: '2026-02-01T00:00:00Z' }],
        episodes: [ep(3), ep(1, { endedAt: null, blockedForMs: null }), ep(2, { simulated: true, ip: '<b>x</b>' })] })
      return new Response('{}', { status: 404 })
    }, '/ui/settings')
    ;(ctx as any).document.body = { dataset: { banPage: 'settings' } }
    const clicks: Record<string, (ev: unknown) => void> = {}
    ;(ctx as any).document.getElementById('ban-episodes').addEventListener = (t: string, fn: (ev: unknown) => void) => { if (t === 'click') clicks.eps = fn }
    const html = await (await app.request('https://tracked.example/ui/settings', {}, env())).text()
    for (const s of scriptsOf(html)) vm.runInContext(s, ctx)
    for (let i = 0; i < 15; i++) await new Promise((res) => setTimeout(res, 0))
    expect(els.get('ban-devices').innerHTML).toContain('Push devices (<span id="ban-dev-n">2</span>)')
    const dev = els.get('bdev-body').innerHTML as string
    expect(dev).toContain('Chrome on Android')
    expect(dev).toContain('Firefox on Windows')
    expect(dev).toContain('Last delivery failed: 410 &lt;gone&gt;')
    const eps = els.get('beps-body').innerHTML as string
    expect(eps.indexOf('10.0.0.1')).toBeLessThan(eps.indexOf('&lt;b&gt;x&lt;/b&gt;'))
    expect(eps.indexOf('&lt;b&gt;x&lt;/b&gt;')).toBeLessThan(eps.indexOf('10.0.0.3'))
    expect(eps).toContain('<b>(open)</b>')
    expect(eps).not.toContain('<b>x</b>')
    clicks.eps!(tableClick({ tkt: { 'data-tkt': 'chip', 'data-chip': 'sim' } }))
    const sim = els.get('beps-body').innerHTML as string
    expect(sim).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(sim).not.toContain('10.0.0.1')
  })
  it('Tools carries the Search index card and its script runs in the minimal stub', async () => {
    const html = await (await app.request('https://tracked.example/ui/tools', {}, env())).text()
    for (const id of ['search-card', 'si-sets', 'si-tracks', 'si-last', 'si-rebuild', 'si-status']) expect(html).toContain(`id="${id}"`)
    const c = minimalStub()
    for (const s of scriptsOf(html)) expect(() => vm.runInContext(s, c)).not.toThrow()
  })
  /** Runs the Tools script with backfill replies from `reply` (by request number); returns a press() and what was seen. */
  async function toolsBackfill(reply: (n: number) => Response) {
    const posts: Array<{ cursor: string | null; limit: number }> = []
    const { ctx, els } = richStub((async (u: string, init?: { body?: string }) => {
      if (u === '/ui/api/search/backfill') { posts.push(JSON.parse(init?.body ?? '{}')); return reply(posts.length) }
      if (u === '/ui/api/search/status') return Response.json({ sets: 1, tracks: 2, vocab: 3, lastIndexedAt: null })
      return new Response('{}', { status: 404 })
    }) as (u: string) => Promise<Response>, '/ui/tools')
    let click: (() => void) | null = null
    ctx.document.getElementById('si-rebuild').addEventListener = (t: string, fn: () => void) => { if (t === 'click') click = fn }
    const statuses: string[] = []
    const st = ctx.document.getElementById('si-status')
    Object.defineProperty(st, 'textContent', { get() { return statuses.at(-1) ?? '' }, set(v: string) { statuses.push(v) } })
    const html = await (await app.request('https://tracked.example/ui/tools', {}, env())).text()
    for (const s of scriptsOf(html)) vm.runInContext(s, ctx)
    const settle = async () => { for (let i = 0; i < 60; i++) await new Promise((res) => setTimeout(res, 0)) }
    await settle()
    return { posts, statuses, els, press: async () => { click!(); await settle() } }
  }
  it('Tools Rebuild loops requests until done, showing running totals, and resets the cursor when done', async () => {
    const replies = [
      { indexed: 50, skipped: 10, cursor: 'c1', done: false },
      { indexed: 55, skipped: 5, cursor: 'c2', done: false },
      { indexed: 3, skipped: 0, cursor: 'c3', done: true },
    ]
    const t = await toolsBackfill((n) => Response.json(replies[(n - 1) % 3]))
    await t.press()
    expect(t.posts).toEqual([{ cursor: null, limit: 500 }, { cursor: 'c1', limit: 440 }, { cursor: 'c2', limit: 380 }])
    expect(t.statuses).toContain('Indexed 50, skipped 10…')
    expect(t.statuses).toContain('Indexed 105, skipped 15…')
    expect(t.statuses.at(-1)).toBe('Indexed 108, skipped 15. Done: every trusted list is indexed.')
    // done reset the cursor: the next press starts over.
    await t.press()
    expect(t.posts[3]).toEqual({ cursor: null, limit: 500 })
  })
  it('Tools Rebuild stops at 500 sets per press and on an error, keeping the cursor', async () => {
    const t = await toolsBackfill((n) => Response.json({ indexed: 60, skipped: 40, cursor: 'c' + n, done: false }))
    await t.press()
    expect(t.posts.map((p) => p.limit)).toEqual([500, 400, 300, 200, 100])
    expect(t.statuses.at(-1)).toBe('Indexed 300, skipped 200. Press again for more.')
    const e = await toolsBackfill((n) => (n === 1 ? Response.json({ indexed: 60, skipped: 0, cursor: 'c1', done: false }) : Response.json({ error: 'boom', message: 'D1 down' }, { status: 500 })))
    await e.press()
    expect(e.posts).toHaveLength(2)
    expect(e.statuses.at(-1)).toBe('Indexed 60, skipped 0, then D1 down')
    expect(e.els.get('si-status').className).toContain('bad')
    await e.press()
    expect(e.posts[2]).toEqual({ cursor: 'c1', limit: 500 })
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
    expect(paths).toContain('/ui/api/mkvid/progress') // the render progress proxy (calls mkvid) sits behind Access too
    expect(paths).toContain('/ui/api/search') // the search API (routes/search.ts) is mounted inside subscriptionsApp
    expect(paths).toContain('/ui/img/x') // search thumbnails (R2 copies) sit behind Access too
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
