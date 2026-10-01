import { describe, it, expect, vi } from 'vitest'
import vm from 'node:vm'
import { normalizeRenderProgress, fetchMkvidRenderProgress } from '../src/lib/mkvid-progress'
import { MKVID_PAGE_HTML } from '../src/ui/pages/mkvid'
import type { Env } from '../src/types'

const REQ = '7b62fa35-d9af-4130-8524-35a9c59c5a28'
const running = (over: Record<string, unknown> = {}) => ({
  jobId: 'j1', requestId: REQ, title: 'Odd Mob @ X', style: 'scene', status: 'transcoding', startedAt: 1_790_880_283_236,
  stage: 'render', fraction: 0.3, renderMinutesLeft: 19, segments: { done: 68, total: 120 },
  stages: [
    { key: 'download', label: 'Download', weight: 2, state: 'done', progress: 1 },
    { key: 'analyse', label: 'Analyse', weight: 2, state: 'done', progress: 1 },
    { key: 'render', label: 'Render', weight: 64, state: 'active', progress: 0.566 },
    { key: 'assemble', label: 'Assemble', weight: 3, state: 'pending', progress: 0 },
    { key: 'upload', label: 'Upload', weight: 29, state: 'pending', progress: 0 },
  ],
  ...over,
})

describe('normalizeRenderProgress', () => {
  it('keeps the whitelisted fields, ms → s, clamps', () => {
    const p = normalizeRenderProgress(running({ fraction: 1.7 }))!
    expect(p).toMatchObject({ requestId: REQ, stage: 'render', fraction: 1, renderMinutesLeft: 19, segments: { done: 68, total: 120 }, startedAt: 1_790_880_283 })
    expect(p.stages).toHaveLength(5)
    expect(p).not.toHaveProperty('jobId')
  })
  it('refuses a malformed answer', () => {
    expect(normalizeRenderProgress(null)).toBeNull()
    expect(normalizeRenderProgress(running({ stages: [] }))).toBeNull()
    expect(normalizeRenderProgress(running({ stage: 'nope' }))).toBeNull()
    expect(normalizeRenderProgress(running({ stages: [{ key: '<x>', label: 'x', weight: 1, state: 'done', progress: 1 }], stage: 'x' }))).toBeNull()
    expect(normalizeRenderProgress(running({ requestId: 'not-a-uuid' }))!.requestId).toBeNull()
  })
})

describe('fetchMkvidRenderProgress', () => {
  const env = (over: Partial<Env> = {}) => ({ MKVID_URL: 'https://mkvid.example/', MKVID_TOKEN: 'mk', MKVID_ACCESS_CLIENT_ID: 'id', MKVID_ACCESS_CLIENT_SECRET: 'sec', DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) }, ...over }) as unknown as Env
  it('calls mkvid with the bearer and Access headers; null when idle', async () => {
    const f = vi.fn(async () => Response.json({ running: null }))
    expect(await fetchMkvidRenderProgress(env(), f as unknown as typeof fetch)).toEqual({ ok: true, running: null })
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://mkvid.example/api/videos/render-progress')
    expect(init.headers).toMatchObject({ authorization: 'Bearer mk', 'cf-access-client-id': 'id', 'cf-access-client-secret': 'sec' })
  })
  it('reports mkvid errors and missing config', async () => {
    expect(await fetchMkvidRenderProgress(env({ MKVID_URL: undefined } as Partial<Env>), vi.fn() as unknown as typeof fetch)).toMatchObject({ ok: false })
    expect(await fetchMkvidRenderProgress(env(), (async () => new Response('', { status: 302 })) as unknown as typeof fetch)).toEqual({ ok: false, error: 'mkvid answered 302' })
    expect(await fetchMkvidRenderProgress(env(), (async () => Response.json({ running: { stage: 'x' } })) as unknown as typeof fetch)).toMatchObject({ ok: false })
  })
})

describe('mkvid page: the running render', () => {
  const scripts = [...MKVID_PAGE_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)) }
  function page(progress: unknown) {
    const el = (): any => {
      const n: any = { innerHTML: '', textContent: '', value: '', hidden: false, className: '', dataset: {}, style: {}, options: [], on: {},
        addEventListener(t: string, fn: unknown) { n.on[t] = fn }, focus() {}, add() {}, remove() {}, showModal() {}, close() {},
        querySelector: () => null, querySelectorAll: () => [], closest: () => null }
      return n
    }
    const els = new Map<string, any>()
    const get = (id: string) => (els.has(id) ? els.get(id) : (els.set(id, el()), els.get(id)))
    const document = { hidden: false, getElementById: get, querySelector: () => null, addEventListener() {}, createElement: () => el() }
    const fetch = async (url: string) => (String(url).includes('/ui/api/mkvid/progress') ? Response.json(progress) : Response.json({ enabled: true, counts: {}, accounts: [], queue: [], settled: [], oldVideos: [], djs: [] }))
    const ctx = vm.createContext({ document, fetch, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, console, Date, URLSearchParams, JSON, URL,
      location: { search: '', pathname: '/ui/mkvid' }, history: { replaceState() {} }, Option: function () { return {} } })
    for (const s of scripts) vm.runInContext(s, ctx)
    return get
  }

  it('draws one section per stage, sized by weight (narrow ones widened), with a tie at every boundary', async () => {
    const get = page({ running: { ...normalizeRenderProgress(running())!, setUrl: 'https://www.1001tracklists.com/tracklist/x/odd-mob.html', slug: 'oddmob' } })
    await settle()
    const run = get('mk-run')
    expect(run.hidden).toBe(false)
    const html: string = run.innerHTML
    expect(html).toContain('Rendering now')
    expect(html).toContain('30%')
    expect(html).toContain('segment 68 of 120')
    expect(html).toContain('~19 min left in the render')
    expect(html).toContain('href="/ui/set?url=https%3A%2F%2Fwww.1001tracklists.com%2Ftracklist%2Fx%2Fodd-mob.html"')
    const widths = [...html.matchAll(/class="sec [^"]*" style="flex: 0 0 ([\d.]+)%/g)].map((m) => Number(m[1]))
    expect(widths).toHaveLength(5)
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 1)
    expect(widths[2]).toBeGreaterThan(50) // render dominates
    expect(widths[0]).toBeCloseTo(widths[1]!, 3) // both minimum-width
    expect([...html.matchAll(/class="tie/g)]).toHaveLength(6)
    expect([...html.matchAll(/class="tie past"/g)]).toHaveLength(3)
    expect(html).toContain('style="width: 56.6%"')
    expect(html).toContain('aria-valuenow="30"')
  })

  it('stays hidden when mkvid is idle or unreachable', async () => {
    const idle = page({ running: null })
    await settle()
    expect(idle('mk-run').hidden).toBe(true)
    const get = page({ error: 'mkvid_unavailable' })
    await settle()
    expect(get('mk-run').hidden).toBe(true)
  })
})
