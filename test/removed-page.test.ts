import { describe, it, expect } from 'vitest'
import vm from 'node:vm'
import { app } from '../src/index'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'
import type { Env } from '../src/types'

const env = () => ({ CACHE: fakeKV(), SUBS: fakeKV(), DB: fakeD1(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k', DEV_BYPASS_CF_ACCESS: '1' }) as unknown as Env
const scriptsOf = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)) }

/** richStub with listeners recorded and a location whose query string history.replaceState updates. */
function stub(fetchImpl: (u: string, init?: { method?: string; body?: string }) => Promise<Response>, search = '') {
  const el = (): any => {
    const ls: Record<string, Array<(ev: unknown) => unknown>> = {}
    return { innerHTML: '', textContent: '', value: '', hidden: false, disabled: false, className: '', dataset: {}, style: {}, ls,
      addEventListener(t: string, f: (ev: unknown) => unknown) { (ls[t] ??= []).push(f) }, focus() {},
      setAttribute() {}, removeAttribute() {}, getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [], closest: () => null }
  }
  const els = new Map<string, any>()
  const location = { search, pathname: '/ui/removed', hash: '' }
  const document = { hidden: false, getElementById: (id: string) => (els.has(id) ? els.get(id) : (els.set(id, el()), els.get(id))), querySelector: () => null, addEventListener() {}, removeEventListener() {}, createElement: () => el() }
  const ctx = vm.createContext({ document, fetch: fetchImpl, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, console, Date, URLSearchParams, location,
    history: { state: null, replaceState(_s: unknown, _t: string, u: string) { const i = u.indexOf('?'); location.search = i < 0 ? '' : u.slice(i) } } })
  return { ctx, els, location }
}
const ctl = (attrs: Record<string, string>) => {
  const t: any = { getAttribute: (k: string) => (k in attrs ? attrs[k] : null), disabled: false }
  t.closest = (sel: string) => (sel === '[data-tkt]' && 'data-tkt' in attrs ? t : null)
  return { target: t }
}
const act = (row: number, name: string) => {
  const tr = { getAttribute: (k: string) => (k === 'data-tkt-row' ? String(row) : null) }
  const btn: any = { getAttribute: (k: string) => (k === 'data-act' ? name : null), disabled: false, textContent: '' }
  return { target: { getAttribute: () => null, closest: (sel: string) => (sel === '[data-act]' ? btn : sel === 'tr[data-tkt-row]' ? tr : null) } }
}

describe('Removed videos page script', () => {
  const XSS = '<img src=x onerror=alert(1)>'
  const rows = [
    { id: 3, at: 1_790_000_300, source: 'sweep', status: 'would_remove', slug: 'dj-a', set_url: 'https://www.1001tracklists.com/tracklist/1/a-set.html', video_id: 'vid00000003', playlist_id: 'PL1', playlist_kind: 'artist', reason: 'short', detail: XSS },
    { id: 2, at: 1_790_000_200, source: 'owner', status: 'recorded', slug: 'dj-b', set_url: null, video_id: 'vid00000002', playlist_id: 'PL2', playlist_kind: 'combined', reason: 'owner', detail: null },
    { id: 1, at: 1_790_000_100, source: 'dead', status: 'recorded', slug: null, set_url: null, video_id: 'vid00000001', playlist_id: 'PL2', playlist_kind: 'combined', reason: 'dead', detail: null },
  ]
  const answer = { rows, total: 230, page: 1, size: 50, pageCount: 5, sort: [{ col: 'at', dir: 'desc' }], filters: [], q: '',
    counts: { would_remove: 1, recorded: 2 }, settings: { dryRun: true, dailyRemovals: 40 }, deletesUsedToday: 3, djs: ['dj-a', 'dj-b'],
    holds: [{ kind: 'artist', slug: 'dj-a', playlistId: 'PL1', missing: 5, expected: 40, at: 1_790_000_000 }], reasonLabels: {} }

  async function boot(search = '') {
    const gets: string[] = [], posts: string[] = []
    const s = stub(async (u, init) => {
      if (init?.method === 'POST') { posts.push(u); return Response.json({ ok: true }) }
      gets.push(decodeURIComponent(u))
      if (u.startsWith('/ui/api/removals?')) return Response.json(answer)
      return new Response('{}', { status: 404 })
    }, search)
    const html = await (await app.request('https://tracked.example/ui/removed', {}, env())).text()
    for (const sc of scriptsOf(html)) vm.runInContext(sc, s.ctx)
    await settle()
    return { ...s, gets, posts, removals: () => gets.filter((u) => u.startsWith('/ui/api/removals?')) }
  }

  it('renders rows, the bar, holds and the DJ list from one table request, escaped', async () => {
    const t = await boot()
    expect(t.removals()).toEqual(['/ui/api/removals?page=1&size=50&sort=-at'])
    const body = t.els.get('rm-body').innerHTML as string
    expect(body).not.toContain('<img')
    expect(body).toContain('&lt;img src=x')
    expect(body).toContain('video is more than 5 min shorter than the last cue') // the label, from the page's own map
    expect(body).toContain('href="/ui/dj/dj-a"')
    expect(body).toContain('data-act="undo"')
    expect(body).toContain('Keep it')
    expect(body).toContain('Undo (re-add)')
    expect(body.match(/data-act="undo"/g)).toHaveLength(2) // the dead video has no action
    expect(t.els.get('rm-pager').innerHTML).toContain('1–50 of 230')
    expect(t.els.get('bar').innerHTML).toContain('DRY RUN')
    expect(t.els.get('bar').innerHTML).toContain('deletes today 3 / 40')
    expect(t.els.get('holds').innerHTML).toContain('5 of 40 missing')
    expect(t.els.get('dj').innerHTML).toContain('<option value="dj-b">dj-b</option>')
  })

  it('source chips and the DJ select are server-side filters; Undo posts and reloads', async () => {
    const t = await boot()
    t.els.get('rm-table').ls.click[0](ctl({ 'data-tkt': 'chip', 'data-chip': 'owner' }))
    await settle()
    expect(t.removals().at(-1)).toBe('/ui/api/removals?page=1&size=50&sort=-at&f.source=in:owner')
    expect(t.location.search).toContain('rm.chip=owner')
    t.els.get('dj').value = 'dj-b'
    t.els.get('dj').ls.change[0]({})
    await settle()
    expect(t.removals().at(-1)).toBe('/ui/api/removals?page=1&size=50&sort=-at&f.source=in:owner&f.slug=eq:dj-b')
    const before = t.removals().length
    t.els.get('rm-table').ls.click[0](act(0, 'undo'))
    await settle()
    expect(t.posts).toEqual(['/ui/api/removals/3/undo'])
    expect(t.removals().length).toBe(before + 1)
  })

  it('old ?source= and ?dj= links become the table chip and filter', async () => {
    const t = await boot('?source=replace&dj=dj-a')
    expect(t.removals()[0]).toBe('/ui/api/removals?page=1&size=50&sort=-at&f.source=in:button&f.slug=eq:dj-a')
    expect(t.location.search).not.toMatch(/[?&](source|dj)=/)
  })
})
