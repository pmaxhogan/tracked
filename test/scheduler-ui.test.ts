import { describe, it, expect, vi, afterEach } from 'vitest'
import vm from 'node:vm'
import { app } from '../src/index'
import { shell } from '../src/ui/shell'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'
import type { Env } from '../src/types'
import { recordSchedulerTick } from '../src/lib/tick-history'
import { djStarvation, redactText, schedulerSummary } from '../src/lib/scheduler-report'
import type { TickResult } from '../src/lib/fetch-scheduler'

const env = (extra: Record<string, unknown> = {}) => ({ CACHE: fakeKV(), SUBS: fakeKV(), DB: fakeD1(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k', DEV_BYPASS_CF_ACCESS: '1', ...extra }) as unknown as Env
const lockedEnv = () => env({ DEV_BYPASS_CF_ACCESS: undefined, CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CF_ACCESS_AUD: 'aud', CF_ACCESS_ALLOWED_EMAILS: 'owner@example.com', TLPOOL_URL: 'https://tlpool.example', TLPOOL_TOKEN: 'x' })
const scriptsOf = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
const ORIGIN = 'https://tracked.example'
afterEach(() => vi.unstubAllGlobals())

const SET = (s: string) => `https://www.1001tracklists.com/tracklist/x${s}/${s}.html`

async function seed(e: Env, now: number) {
  const db = e.DB as unknown as D1Database
  await db.prepare('INSERT INTO subscriptions (slug, source_url, added_at, position) VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)')
    .bind('dj-late', 'https://www.1001tracklists.com/dj/dj-late/index.html', now, 1, 'dj-fine', 'https://www.1001tracklists.com/dj/dj-fine/index.html', now, 2, 'dj-new', 'https://www.1001tracklists.com/dj/dj-new/index.html', now, 3).run()
  await db.prepare('INSERT INTO dj_schedule (slug, next_discovery_at, next_backfill_at, updated_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)')
    .bind('dj-late', now - 7200, now - 2 * 86400, now, 'dj-fine', now + 3600, now + 600, now).run()
  await db.prepare('INSERT INTO sub_sync (slug, artist_name) VALUES (?, ?)').bind('dj-late', 'DJ <b>Late</b>').run()
  // Older than the 24 h window: counts for "last ran", not the summary.
  await recordSchedulerTick(e, now - 3 * 86400, 900, { drawn: 1, items: [{ item: { cls: 'backfill', kind: 'dj_backfill', slug: 'dj-late' }, outcome: 'stepped' }], due: { new: 0, verify: 0, recheck: 0, backfill: 1 } } as TickResult)
  await recordSchedulerTick(e, now - 3600, 10, { skipped: 'nothing_due', drawn: 2, items: [], due: { new: 0, verify: 0, recheck: 0, backfill: 0 } })
  await recordSchedulerTick(e, now - 1800, 5, { skipped: 'paused', drawn: 0, items: [] })
  await recordSchedulerTick(e, now - 600, 2400, {
    drawn: 3,
    due: { new: 2, verify: 1, recheck: 7, backfill: 4 },
    items: [
      { item: { cls: 'new', kind: 'discovery', slug: 'dj-fine' }, outcome: 'ok' },
      { item: { cls: 'recheck', kind: 'recheck', slug: 'dj-fine', url: SET('a-live-set') }, outcome: 'failed' },
      { item: { cls: 'verify', kind: 'render_feed', slug: 'dj-late', url: SET('b') }, outcome: 'stopped', stopReason: 'budget_exhausted' },
    ],
    stoppedBy: 'budget_exhausted',
  } as TickResult)
  await recordSchedulerTick(e, now - 60, 30, null, 'TypeError: fetch https://tlpool.example/fetch?token=abc123 failed, Bearer sekrit')
}

describe('scheduler report (lib)', () => {
  it('redacts every URL but 1001tracklists, bearer values and token pairs', () => {
    expect(redactText('GET https://tlpool.internal:8443/fetch?x=1 failed')).toBe('GET [url] failed')
    expect(redactText(`at ${SET('a')}?utm=1`)).toBe(`at ${SET('a')}`)
    expect(redactText('Authorization: Bearer abc.def')).not.toContain('abc.def')
    expect(redactText('token=xyz&k=1')).toBe('token=[redacted]&k=1')
    expect(redactText(null)).toBeNull()
    expect(redactText('x'.repeat(400))!.length).toBe(301)
  })

  it('summarises the last 24 h, last runs over the whole history, the newest due counts', async () => {
    const e = env()
    const now = Math.floor(Date.now() / 1000)
    await seed(e, now)
    const s = await schedulerSummary(e, now)
    expect(s).toMatchObject({
      ticks: 4, ranTicks: 1, skippedTicks: 2, skipped: { nothing_due: 1, paused: 1 }, errored: 1, drawn: 5, items: 3,
      byClass: { new: 1, verify: 1, recheck: 1, backfill: 0 },
      byKind: { discovery: 1, set: 0, verify: 0, render_feed: 1, recheck: 1, dj_backfill: 0 },
      outcomes: { ok: 1, failed: 1, stopped: 1 },
      outcomesByKind: { recheck: { failed: 1 }, render_feed: { stopped: 1 } },
      stopReasons: { budget_exhausted: 1 },
      latestDue: { at: now - 600, due: { new: 2, verify: 1, recheck: 7, backfill: 4 } },
      oldestTickAt: now - 3 * 86400,
    })
    expect(s.lastRun.byClass.backfill).toEqual({ picked: now - 3 * 86400, ok: now - 3 * 86400 })
    expect(s.lastRun.byKind.recheck).toEqual({ picked: now - 600, ok: null })
    expect(s.lastRun.byKind.discovery).toEqual({ picked: now - 600, ok: now - 600 })
    expect(s.lastRun.byKind.set).toEqual({ picked: null, ok: null })
  })

  it('lists every subscribed DJ, most overdue first, with the time it is overdue', async () => {
    const e = env()
    const now = Math.floor(Date.now() / 1000)
    await seed(e, now)
    const djs = await djStarvation(e, now)
    expect(djs.map((d) => d.slug)).toEqual(['dj-late', 'dj-fine', 'dj-new'])
    expect(djs[0]).toEqual({ slug: 'dj-late', name: 'DJ <b>Late</b>', nextDiscoveryAt: now - 7200, nextBackfillAt: now - 2 * 86400, discoveryOverdue: 7200, backfillOverdue: 2 * 86400 })
    expect(djs[1]).toMatchObject({ discoveryOverdue: -3600, backfillOverdue: -600 })
    expect(djs[2]).toMatchObject({ nextDiscoveryAt: null, discoveryOverdue: null, backfillOverdue: null })
  })

  it('the tick table: newest first by default, set labels, redacted errors, sort, filters, search and pages', async () => {
    const e = env()
    const now = Math.floor(Date.now() / 1000)
    await seed(e, now)
    const get = async (qs: string) => {
      const r = await app.request(`${ORIGIN}/ui/api/scheduler/ticks${qs}`, {}, e)
      expect(r.status, qs).toBe(200)
      return (await r.json()) as { rows: Array<any>; total: number; page: number; pageCount: number; sort: unknown }
    }
    const p1 = await get('?size=10')
    expect(p1.total).toBe(5)
    expect(p1.sort).toEqual([{ col: 'at', dir: 'desc' }])
    expect(p1.rows.map((t) => t.at)).toEqual([now - 60, now - 600, now - 1800, now - 3600, now - 3 * 86400])
    expect(p1.rows[0].error).toBe('TypeError: fetch [url] failed, Bearer [redacted]')
    expect(p1.rows[1].items[1]).toEqual({ kind: 'recheck', cls: 'recheck', slug: 'dj-fine', url: SET('a-live-set'), label: 'a live set', outcome: 'failed', stopReason: null })
    expect(p1.rows[1].items[0]).toMatchObject({ kind: 'discovery', url: null, label: null })
    expect(p1.rows[1].due).toEqual({ new: 2, verify: 1, recheck: 7, backfill: 4 })
    // Paging (size is clamped to 10..200, so page with 10 rows over 12 ticks).
    for (let i = 0; i < 7; i++) await recordSchedulerTick(e, now - 7200 - i, 1, { skipped: 'nothing_due', drawn: 0, items: [] })
    const pg2 = await get('?size=10&page=2')
    expect([pg2.total, pg2.page, pg2.pageCount, pg2.rows.length]).toEqual([12, 2, 2, 2])
    // The due count of one class sorts; filters reach SQL.
    expect((await get('?sort=-dueRecheck&size=10')).rows[0].at).toBe(now - 600)
    expect((await get('?f.error=nempty')).rows.map((t) => t.at)).toEqual([now - 60])
    expect((await get('?f.stoppedBy=nempty')).rows.map((t) => t.at)).toEqual([now - 600])
    expect((await get('?f.skipped=in:paused')).rows.map((t) => t.at)).toEqual([now - 1800])
    expect((await get('?f.failedItems=eq:1')).rows.map((t) => t.at)).toEqual([now - 600])
    expect((await get('?f.ran=gt:0&sort=at')).rows.map((t) => t.at)).toEqual([now - 3 * 86400, now - 600])
    expect((await get(`?f.at=gte:${(now - 1800) * 1000}`)).rows.map((t) => t.at)).toEqual([now - 60, now - 600, now - 1800])
    // q searches the picked items (a DJ slug, a set URL), not the error text.
    expect((await get('?q=a-live-set')).rows.map((t) => t.at)).toEqual([now - 600])
    expect((await get('?q=dj-late')).rows.map((t) => t.at)).toEqual([now - 600, now - 3 * 86400])
    expect((await get('?q=sekrit')).total).toBe(0)
    expect((await app.request(`${ORIGIN}/ui/api/scheduler/ticks?sort=nope`, {}, e)).status).toBe(400)
    expect((await app.request(`${ORIGIN}/ui/api/scheduler/ticks?f.error=gt:1`, {}, e)).status).toBe(400)
  })
})

describe('/ui/scheduler and /ui/api/scheduler*', () => {
  it('serve the page and the JSON behind Access; nothing secret in the JSON', async () => {
    const e = env()
    await seed(e, Math.floor(Date.now() / 1000))
    const page = await app.request(`${ORIGIN}/ui/scheduler`, {}, e)
    expect(page.status).toBe(200)
    expect(page.headers.get('cache-control')).toBe('no-store')
    const html = await page.text()
    expect(html).toContain('<h1>Scheduler')
    for (const s of scriptsOf(html)) expect(() => new vm.Script(s)).not.toThrow()

    const r = await app.request(`${ORIGIN}/ui/api/scheduler`, {}, e)
    expect(r.status).toBe(200)
    const d = (await r.json()) as { summary: { ticks: number }; djs: unknown[] }
    expect(d.summary.ticks).toBe(4)
    expect(d.djs).toHaveLength(3)

    const t = await app.request(`${ORIGIN}/ui/api/scheduler/ticks`, {}, e)
    expect(t.status).toBe(200)
    const raw = await t.text()
    expect(raw).not.toContain('tlpool.example')
    expect(raw).not.toContain('abc123')
    expect(raw).not.toContain('sekrit')
    expect((JSON.parse(raw) as { rows: unknown[] }).rows).toHaveLength(5)
    expect((await app.request(`${ORIGIN}/ui/api/scheduler/ticks?page=abc`, {}, e)).status).toBe(400)
  })

  it.each(['/ui/scheduler', '/ui/api/scheduler', '/ui/api/scheduler/ticks'])('%s answers 401 without Access and never fetches', async (path) => {
    const spy = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', spy)
    expect((await app.request(`${ORIGIN}${path}`, {}, lockedEnv())).status).toBe(401)
    expect(spy).not.toHaveBeenCalled()
  })

  it('the Scheduler nav item sits last in the Pool group, lights up, and the Pool tab stands for it', () => {
    const h = shell({ nav: 'scheduler', title: 'Scheduler', body: '' })
    expect(h).toMatch(/<a [^>]*href="\/ui\/scheduler"[^>]*class="on"/)
    expect(h).toMatch(/href="\/ui\/pool\/settings"[^>]*>(?:(?!<\/a>)[\s\S])*<\/a><a href="\/ui\/scheduler"/)
    const tabBar = /<nav class="tk-tabs"[^>]*>([\s\S]*?)<\/nav>/.exec(h)![1]!
    expect(tabBar.match(/href="/g)!.length).toBe(5)
    expect(tabBar).toMatch(/<a href="\/ui\/pool" class="on"/)
  })
})

/** The page tests' richStub: elements by id that record listeners; createElement, location and history for TKTable. */
function stub(fetchImpl: (u: string) => Promise<Response>, withBody = true) {
  const el = (): any => {
    const ls: Record<string, Array<(ev: unknown) => unknown>> = {}
    return { innerHTML: '', textContent: '', value: '', hidden: false, checked: false, disabled: false, className: '', dataset: {}, style: {}, options: [], ls,
      addEventListener(t: string, f: (ev: unknown) => unknown) { (ls[t] ??= []).push(f) }, focus() {}, showModal() {}, close() {},
      setAttribute() {}, removeAttribute() {}, getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [], closest: () => null }
  }
  const els = new Map<string, any>()
  const drawers: Array<[string, string]> = []
  const document = { hidden: false, ...(withBody ? { body: { dataset: { ownCount: '1' } } } : {}), getElementById: (id: string) => (els.has(id) ? els.get(id) : (els.set(id, el()), els.get(id))), querySelector: () => null, addEventListener() {}, removeEventListener() {}, createElement: () => el() }
  const ctx = vm.createContext({ document, fetch: fetchImpl, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, console, Date, URLSearchParams,
    location: { search: '', pathname: '/ui/scheduler', hash: '' }, history: { state: null, replaceState() {} },
    Option: function (t: string, v: string) { return { text: t, value: v } } })
  return { ctx, els, drawers }
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)) }
/** A click on a table row: the target answers closest('tr[data-tkt-row]') with the row. */
const rowClick = (i: number) => {
  const tr = { getAttribute: (k: string) => (k === 'data-tkt-row' ? String(i) : null), closest: () => null }
  return { target: { getAttribute: () => null, closest: (sel: string) => (sel === 'tr[data-tkt-row]' ? tr : null) } }
}
/** A click on a [data-tkt] control (a chip, a sort header). */
const ctlClick = (attrs: Record<string, string>) => {
  const t: any = { getAttribute: (k: string) => (k in attrs ? attrs[k] : null), disabled: false }
  t.closest = (sel: string) => (sel === '[data-tkt]' && 'data-tkt' in attrs ? t : null)
  return { target: t }
}

describe('Scheduler page script', () => {
  const now = Math.floor(Date.now() / 1000)
  const XSS = '<img src=x onerror=alert(1)>'
  const summary = {
    now, windowSeconds: 86400, ticks: 3, ranTicks: 1, skippedTicks: 2, skipped: { nothing_due: 1, [XSS]: 1 }, errored: 1, drawn: 4, items: 2,
    byClass: { new: 1, verify: 0, recheck: 1, backfill: 0 }, byKind: { discovery: 1, set: 0, verify: 0, render_feed: 0, recheck: 1, dj_backfill: 0, presave: 2 },
    outcomes: { ok: 1, failed: 1 }, outcomesByKind: { discovery: { ok: 1 }, recheck: { failed: 1 } }, stopReasons: { [XSS]: 1 },
    lastRun: { byClass: { new: { picked: now - 60, ok: now - 60 }, verify: { picked: null, ok: null }, recheck: { picked: now - 60, ok: null }, backfill: { picked: null, ok: null } }, byKind: {} },
    latestDue: { at: now - 60, due: { new: 1, verify: 0, recheck: 3, backfill: 9 } }, oldestTickAt: now - 86400 * 5,
  }
  const djs = [
    { slug: 'ok-dj', name: null, nextDiscoveryAt: null, nextBackfillAt: null, discoveryOverdue: null, backfillOverdue: null },
    { slug: 'late"dj', name: XSS, nextDiscoveryAt: now - 3 * 86400, nextBackfillAt: now + 100, discoveryOverdue: 3 * 86400, backfillOverdue: -100 },
  ]
  const tick = (id: number, extra: Record<string, unknown> = {}) => ({ id, at: now - id * 300, ms: 1500, skipped: null, drawn: 2, ran: 1, due: { new: 1, verify: 0, recheck: 3, backfill: 9 }, stoppedBy: null, error: null, items: [], ...extra })
  const rows = [
    tick(10, { items: [{ kind: 'recheck', cls: 'recheck', slug: 'dj<x>', url: SET('a') + '?q="><script>', label: `set ${XSS}`, outcome: 'failed', stopReason: XSS }, { kind: 'presave', cls: 'recheck', slug: '', url: null, label: null, outcome: 'ok', stopReason: null }], stoppedBy: XSS, error: XSS }),
    tick(9, { items: [{ kind: 'discovery', cls: 'new', slug: 'ok-dj', url: null, label: null, outcome: 'ok', stopReason: null }] }),
    tick(8, { skipped: 'nothing_due', ran: 0, due: null }),
  ]
  const page = { rows, total: 120, page: 1, size: 50, pageCount: 3, sort: [{ col: 'at', dir: 'desc' }], filters: [], q: '' }

  it('renders the summary, the DJ due times and the tick table, escaped; chips and row clicks work', async () => {
    const fetches: string[] = []
    const { ctx, els } = stub(async (u: string) => {
      fetches.push(u)
      if (u === '/ui/api/scheduler') return Response.json({ summary, djs })
      if (u.startsWith('/ui/api/scheduler/ticks?')) return Response.json(page)
      return new Response('{}', { status: 404 })
    })
    const html = await (await app.request(`${ORIGIN}/ui/scheduler`, {}, env())).text()
    for (const s of scriptsOf(html)) vm.runInContext(s, ctx)
    vm.runInContext('TK.drawer.open = (t, b) => { (globalThis.__drawers ||= []).push([t, b]); return null }', ctx)
    await settle()

    const all = () => ['sc-tiles', 'sc-classes', 'sc-kinds', 'sc-reasons', 'djs-body', 'ticks-body'].map((id) => els.get(id).innerHTML).join('\n')
    expect(all()).not.toContain('<img')
    expect(all()).not.toContain('<script>')
    expect(all()).not.toContain('late"dj')

    expect(els.get('sc-tiles').innerHTML).toContain('1 ran, 2 skipped')
    expect(els.get('sc-classes').innerHTML).toMatch(/<tr class="starve"><td data-label="Class">backfill/)
    expect(els.get('sc-classes').innerHTML).toContain('>9<')
    expect(els.get('sc-kinds').innerHTML).toContain('failed 1')
    expect(els.get('sc-kinds').innerHTML).toContain('Pre-save recheck')
    expect(els.get('sc-reasons').innerHTML).toContain('Nothing due')
    expect(els.get('sc-reasons').innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;')

    // DJ due times: a local table, most overdue first.
    const djHtml = els.get('djs-body').innerHTML as string
    expect(djHtml.indexOf('late%22dj')).toBeLessThan(djHtml.indexOf('ok-dj'))
    expect(djHtml).toContain('class="late"')
    expect(djHtml).toContain('href="/ui/dj/late%22dj"')
    expect(djHtml).toContain('3d overdue')
    expect(djHtml).toContain('not scheduled')
    expect(els.get('sc-djs-count').textContent).toBe('1 of 2 overdue')

    // Ticks: one server request in the table contract, newest first.
    const tickFetches = () => fetches.filter((u) => u.startsWith('/ui/api/scheduler/ticks?')).map(decodeURIComponent)
    expect(tickFetches()).toEqual(['/ui/api/scheduler/ticks?page=1&size=50&sort=-at'])
    const tk = els.get('ticks-body').innerHTML as string
    expect(tk).toContain('class="late"')
    expect(tk).toContain('set &lt;img')
    expect(tk).toContain('failed 1')
    expect(tk).toContain('+1')
    expect(tk).toContain('1.5 s')
    expect(tk).toContain('Nothing due')
    expect(els.get('ticks-pager').innerHTML).toContain('1–50 of 120')

    // The "Errors" chip filters on the server.
    els.get('sc-ticks').ls.click[0](ctlClick({ 'data-tkt': 'chip', 'data-chip': 'errors' }))
    await settle()
    expect(tickFetches().at(-1)).toBe('/ui/api/scheduler/ticks?page=1&size=50&sort=-at&f.error=nempty')
    els.get('sc-ticks').ls.click[0](ctlClick({ 'data-tkt': 'chip', 'data-chip': 'stopped' }))
    await settle()
    expect(tickFetches().at(-1)).toBe('/ui/api/scheduler/ticks?page=1&size=50&sort=-at&f.stoppedBy=nempty')
    // Sorting by a due column.
    els.get('sc-ticks').ls.click[0](ctlClick({ 'data-tkt': 'sort', 'data-col': 'dueRecheck' }))
    await settle()
    expect(tickFetches().at(-1)).toContain('sort=dueRecheck')

    // A row click opens the drawer with every picked item, escaped and linked.
    els.get('sc-ticks').ls.click[0](rowClick(0))
    const drawers = vm.runInContext('globalThis.__drawers', ctx) as Array<[string, string]>
    expect(drawers).toHaveLength(1)
    const body = drawers[0]![1]
    expect(body).toContain('href="/ui/set?url=' + encodeURIComponent(SET('a') + '?q="><script>') + '"')
    expect(body).toContain('href="/ui/dj/dj%3Cx%3E"')
    expect(body).toContain('Pre-save recheck')
    expect(body).toContain('1/0/3/9')
    expect(body).not.toContain('<img')
  })

  it('shows the errors when the API fails, and runs in the minimal stub without a body', async () => {
    const { ctx, els } = stub(async () => Response.json({ error: 'internal' }, { status: 500 }))
    const html = await (await app.request(`${ORIGIN}/ui/scheduler`, {}, env())).text()
    for (const s of scriptsOf(html)) vm.runInContext(s, ctx)
    await settle()
    expect(els.get('sc-err').textContent).toBe('Something went wrong in the Worker.')
    expect(els.get('ticks-err').innerHTML).toContain('Something went wrong in the Worker.')

    const bare = stub(async () => new Response('{}', { status: 404 }), false)
    for (const s of scriptsOf(html)) expect(() => vm.runInContext(s, bare.ctx)).not.toThrow()
    await settle()
  })
})
