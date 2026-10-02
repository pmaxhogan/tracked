import { describe, it, expect, vi, afterEach } from 'vitest'
import vm from 'node:vm'
import { app } from '../src/index'
import { shell } from '../src/ui/shell'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'
import type { Env } from '../src/types'
import { recordSchedulerTick } from '../src/lib/tick-history'
import { djStarvation, redactText, schedulerSummary, schedulerTicksPage } from '../src/lib/scheduler-report'
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

  it('pages ticks newest first with set labels and redacted errors', async () => {
    const e = env()
    const now = Math.floor(Date.now() / 1000)
    await seed(e, now)
    const p1 = await schedulerTicksPage(e, { limit: 2 })
    expect(p1.ticks.map((t) => t.at)).toEqual([now - 60, now - 600])
    expect(p1.ticks[0]!.error).toBe('TypeError: fetch [url] failed, Bearer [redacted]')
    expect(p1.ticks[1]!.items[1]).toEqual({ kind: 'recheck', cls: 'recheck', slug: 'dj-fine', url: SET('a-live-set'), label: 'a live set', outcome: 'failed', stopReason: null })
    expect(p1.ticks[1]!.items[0]).toMatchObject({ kind: 'discovery', url: null, label: null })
    const p2 = await schedulerTicksPage(e, { limit: 2, before: p1.nextBefore })
    expect(p2.ticks.map((t) => t.at)).toEqual([now - 1800, now - 3600])
    const p3 = await schedulerTicksPage(e, { limit: 2, before: p2.nextBefore })
    expect(p3.ticks.map((t) => t.at)).toEqual([now - 3 * 86400])
    expect(p3.nextBefore).toBeNull()
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

    const t = await app.request(`${ORIGIN}/ui/api/scheduler/ticks?limit=2`, {}, e)
    expect(t.status).toBe(200)
    const raw = await t.text()
    expect(raw).not.toContain('tlpool.example')
    expect(raw).not.toContain('abc123')
    expect(raw).not.toContain('sekrit')
    const td = JSON.parse(raw) as { ticks: Array<{ id: number }>; nextBefore: number }
    expect(td.ticks).toHaveLength(2)
    const older = await (await app.request(`${ORIGIN}/ui/api/scheduler/ticks?limit=2&before=${td.nextBefore}`, {}, e)).json() as { ticks: Array<{ id: number }> }
    expect(older.ticks.every((x) => x.id < td.nextBefore)).toBe(true)
    expect((await app.request(`${ORIGIN}/ui/api/scheduler/ticks?before=abc`, {}, e)).status).toBe(400)
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

/** A stub DOM that records listeners, so a test can click; no setAttribute/appendChild, like the other page tests. */
function stub(fetchImpl: (u: string) => Promise<Response>, withBody = true) {
  const el = (): any => {
    const ls: Record<string, Array<(ev: unknown) => unknown>> = {}
    return { innerHTML: '', textContent: '', value: '', hidden: false, checked: false, disabled: false, className: '', dataset: {}, style: {}, options: [], ls,
      addEventListener(t: string, f: (ev: unknown) => unknown) { (ls[t] ??= []).push(f) }, focus() {}, showModal() {}, close() {},
      querySelector: () => el(), querySelectorAll: () => [], closest: () => null }
  }
  const els = new Map<string, any>()
  const document = { hidden: false, ...(withBody ? { body: { dataset: { ownCount: '1' } } } : {}), getElementById: (id: string) => (els.has(id) ? els.get(id) : (els.set(id, el()), els.get(id))), querySelector: () => null, addEventListener() {} }
  const ctx = vm.createContext({ document, fetch: fetchImpl, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, console, Date, URLSearchParams,
    Option: function (t: string, v: string) { return { text: t, value: v } } })
  return { ctx, els }
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)) }

describe('Scheduler page script', () => {
  const now = Math.floor(Date.now() / 1000)
  const XSS = '<img src=x onerror=alert(1)>'
  const summary = {
    now, windowSeconds: 86400, ticks: 3, ranTicks: 1, skippedTicks: 2, skipped: { nothing_due: 1, [XSS]: 1 }, errored: 1, drawn: 4, items: 2,
    byClass: { new: 1, verify: 0, recheck: 1, backfill: 0 }, byKind: { discovery: 1, set: 0, verify: 0, render_feed: 0, recheck: 1, dj_backfill: 0 },
    outcomes: { ok: 1, failed: 1 }, outcomesByKind: { discovery: { ok: 1 }, recheck: { failed: 1 } }, stopReasons: { [XSS]: 1 },
    lastRun: { byClass: { new: { picked: now - 60, ok: now - 60 }, verify: { picked: null, ok: null }, recheck: { picked: now - 60, ok: null }, backfill: { picked: null, ok: null } }, byKind: {} },
    latestDue: { at: now - 60, due: { new: 1, verify: 0, recheck: 3, backfill: 9 } }, oldestTickAt: now - 86400 * 5,
  }
  const djs = [
    { slug: 'late"dj', name: XSS, nextDiscoveryAt: now - 3 * 86400, nextBackfillAt: now + 100, discoveryOverdue: 3 * 86400, backfillOverdue: -100 },
    { slug: 'ok-dj', name: null, nextDiscoveryAt: null, nextBackfillAt: null, discoveryOverdue: null, backfillOverdue: null },
  ]
  const tick = (id: number, extra: Record<string, unknown> = {}) => ({ id, at: now - id * 300, ms: 1500, skipped: null, drawn: 2, ran: 1, due: { new: 1, verify: 0, recheck: 3, backfill: 9 }, stoppedBy: null, error: null, items: [], ...extra })
  const page1 = {
    ticks: [
      tick(10, { items: [{ kind: 'recheck', cls: 'recheck', slug: 'dj<x>', url: SET('a') + '?q="><script>', label: `set ${XSS}`, outcome: 'failed', stopReason: XSS }], stoppedBy: XSS, error: XSS }),
      tick(9, { items: [{ kind: 'discovery', cls: 'new', slug: 'ok-dj', url: null, label: null, outcome: 'ok', stopReason: null }] }),
    ],
    nextBefore: 9,
  }
  const page2 = { ticks: [tick(8, { skipped: 'nothing_due', ran: 0, due: null })], nextBefore: null }

  it('renders the summary, the DJ due times and the ticks, escaped, and pages with Load older', async () => {
    const fetches: string[] = []
    const { ctx, els } = stub(async (u: string) => {
      fetches.push(u)
      if (u === '/ui/api/scheduler') return Response.json({ summary, djs })
      if (u === '/ui/api/scheduler/ticks?limit=50') return Response.json(page1)
      if (u === '/ui/api/scheduler/ticks?limit=50&before=9') return Response.json(page2)
      return new Response('{}', { status: 404 })
    })
    const html = await (await app.request(`${ORIGIN}/ui/scheduler`, {}, env())).text()
    for (const s of scriptsOf(html)) vm.runInContext(s, ctx)
    await settle()

    const all = () => ['sc-tiles', 'sc-classes', 'sc-kinds', 'sc-reasons', 'sc-djs', 'sc-ticks'].map((id) => els.get(id).innerHTML).join('\n')
    expect(all()).not.toContain('<img')
    expect(all()).not.toContain('<script>')
    expect(all()).not.toContain('late"dj')

    expect(els.get('sc-tiles').innerHTML).toContain('1 ran, 2 skipped')
    expect(els.get('sc-classes').innerHTML).toMatch(/<tr class="starve"><td data-label="Class">backfill/)
    expect(els.get('sc-classes').innerHTML).toContain('>9<')
    expect(els.get('sc-kinds').innerHTML).toContain('failed 1')
    expect(els.get('sc-reasons').innerHTML).toContain('Nothing due')
    expect(els.get('sc-reasons').innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;')

    const djHtml = els.get('sc-djs').innerHTML
    expect(djHtml).toMatch(/<tr class="late">/)
    expect(djHtml).toContain('href="/ui/dj/late%22dj"')
    expect(djHtml).toContain('3d overdue')
    expect(djHtml).toContain('not scheduled')
    expect(els.get('sc-djs-count').textContent).toBe('1 of 2 overdue')

    const tk = els.get('sc-ticks').innerHTML
    expect(tk).toContain('href="/ui/set?url=' + encodeURIComponent(SET('a') + '?q="><script>') + '"')
    expect(tk).toContain('set &lt;img')
    expect(tk).toContain('href="/ui/dj/dj%3Cx%3E"')
    expect(tk).toContain('1/0/3/9')
    expect(tk).toContain('1.5 s')
    expect(els.get('sc-more').hidden).toBe(false)

    // Load older appends the next page and hides the button at the end.
    await els.get('sc-more').ls.click[0]({})
    await settle()
    expect(fetches).toContain('/ui/api/scheduler/ticks?limit=50&before=9')
    expect((els.get('sc-ticks').innerHTML.match(/<tr/g) || []).length).toBe(3)
    expect(els.get('sc-ticks').innerHTML).toContain('Nothing due')
    expect(els.get('sc-more').hidden).toBe(true)
  })

  it('shows the errors when the API fails, and runs in the minimal stub without a body', async () => {
    const { ctx, els } = stub(async () => Response.json({ error: 'internal' }, { status: 500 }))
    const html = await (await app.request(`${ORIGIN}/ui/scheduler`, {}, env())).text()
    for (const s of scriptsOf(html)) vm.runInContext(s, ctx)
    await settle()
    expect(els.get('sc-err').textContent).toBe('Something went wrong in the Worker.')
    expect(els.get('sc-ticks-err').textContent).toBe('Something went wrong in the Worker.')

    const bare = stub(async () => new Response('{}', { status: 404 }), false)
    for (const s of scriptsOf(html)) expect(() => vm.runInContext(s, bare.ctx)).not.toThrow()
    await settle()
  })
})
