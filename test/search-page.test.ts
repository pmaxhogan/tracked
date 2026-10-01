import { describe, it, expect } from 'vitest'
import vm from 'node:vm'
import { app } from '../src/index'
import { shell, SEARCH_HREF } from '../src/ui/shell'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'
import type { Env } from '../src/types'

const env = () => ({ CACHE: fakeKV(), SUBS: fakeKV(), DB: fakeD1(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k', DEV_BYPASS_CF_ACCESS: '1' }) as unknown as Env
const scriptsOf = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
const tick = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)) }

const SET_URL = 'https://www.1001tracklists.com/tracklist/abc/mau-p-live-2026-09-01.html'
const track = (over: Record<string, unknown> = {}) => ({
  trackKey: 'k1', trackId: '123', artist: 'Mau P', title: 'Drugs from Amsterdam', label: 'Repopulate Mars', youtubeLink: null,
  trackUrl: 'https://www.1001tracklists.com/track/x/mau-p-drugs/index.html',
  sets: [{ url: SET_URL, title: 'Mau P live', djSlug: 'maup', djName: 'Mau P', date: '2026-09-01', cueSeconds: 125 }], ...over,
})
const response = (over: Record<string, unknown> = {}) => ({
  q: 'mau p', corrected: [],
  tracks: [track()],
  sets: [{ url: SET_URL, title: 'Mau P <b>x</b> live', djSlug: 'maup', djName: 'Mau P', date: '2026-09-01', videoId: 'abcdefghijk', trackCount: 20, idedCount: 18 }],
  djs: [{ slug: 'maup', name: 'Mau P', subscribed: true, sets: 4 }], ...over,
})

type Fn = (ev?: any) => void
/** A stub DOM with recorded listeners and timers, running the shell scripts and the page's. */
async function open(search: string, answer: (u: string) => Promise<Response> | Response) {
  const els = new Map<string, any>()
  const listeners = new Map<string, Fn>()
  const el = (id: string): any => ({ innerHTML: '', textContent: '', value: '', hidden: false, checked: false, disabled: false, className: '', src: '', dataset: {}, style: {}, options: [],
    setAttribute(k: string, v: string) { (this as any)['@' + k] = v }, removeAttribute() {}, scrollIntoView() {},
    addEventListener(t: string, fn: Fn) { listeners.set(id + ':' + t, fn) }, focus() {}, add() {}, remove() {}, showModal() {}, close() {}, querySelector: () => el('q'), querySelectorAll: () => [], closest: () => null })
  const document = { hidden: false, getElementById: (id: string) => (els.has(id) ? els.get(id) : (els.set(id, el(id)), els.get(id))), querySelector: () => null, addEventListener() {}, createElement: () => el('new') }
  const fetches: string[] = []
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let tid = 0
  const history = { urls: [] as string[], replaceState(_a: unknown, _b: string, u: string) { this.urls.push(u) } }
  const location: { search: string; pathname: string; href?: string } = { search, pathname: '/ui/search' }
  const ctx = vm.createContext({ document, console, Date, URLSearchParams, URL, AbortController, location, history,
    fetch: async (u: string) => { fetches.push(u); return answer(u) },
    setTimeout: (fn: () => void, ms: number) => { timers.set(++tid, { fn, ms }); return tid }, clearTimeout: (n: number) => { timers.delete(n) }, setInterval: () => 0, clearInterval() {},
    Option: function (t: string, v: string) { return { text: t, value: v } } })
  const html = await (await app.request('https://tracked.example/ui/search', {}, env())).text()
  for (const s of scriptsOf(html)) vm.runInContext(s, ctx)
  await tick()
  const searchFetches = () => fetches.filter((u) => u.startsWith('/ui/api/search'))
  const fire = (id: string, type: string, ev: any = {}) => listeners.get(id + ':' + type)?.({ preventDefault() {}, target: els.get(id), ...ev })
  const debounced = () => [...timers.entries()].filter(([, t]) => t.ms === 150)
  const runDebounced = async () => { for (const [k, t] of debounced()) { timers.delete(k); t.fn() } await tick() }
  return { els, html, fetches, searchFetches, fire, timers, debounced, runDebounced, history, location }
}

describe('Search page script', () => {
  it('renders the three groups from a response, escaped and highlighted', async () => {
    const p = await open('?q=mau%20p', () => Response.json(response()))
    expect(p.searchFetches()).toHaveLength(1)
    expect(p.searchFetches()[0]).toContain('q=mau%20p')
    const out = p.els.get('sq-results').innerHTML as string
    expect(out).toContain('<mark>Mau</mark>')
    expect(out).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(out).not.toContain('<b>x')
    for (const h of ['Tracks', 'Sets', 'DJs']) expect(out).toContain(h)
    expect(out).toContain('/ui/set?url=' + encodeURIComponent(SET_URL))
    expect(out).toContain('/ui/dj/maup')
    expect(out).toContain('18/20 IDs')
    expect(out).toContain('subscribed')
    expect(p.els.get('sq').value).toBe('mau p')
  })

  it('highlights across diacritics and never injects markup from the data', async () => {
    const r = response({ tracks: [track({ artist: 'Mau P', title: 'Café <img src=x onerror=1> del Mar' })], sets: [], djs: [] })
    const p = await open('?q=cafe', () => Response.json(r))
    const out = p.els.get('sq-results').innerHTML as string
    expect(out).toContain('<mark>Café</mark>')
    expect(out).toContain('&lt;img src=x onerror=1&gt;')
    expect(out).not.toContain('<img')
    const apos = await open('?q=dont%20stop', () => Response.json(response({ tracks: [track({ title: "Don't Stop" })], sets: [], djs: [] })))
    expect(apos.els.get('sq-results').innerHTML).toContain('<mark>Don&#39;t</mark> <mark>Stop</mark>')
  })

  it('shows the corrected notice with a search-exactly button that requests exact=1', async () => {
    const answer = (u: string) => Response.json(u.includes('exact=1') ? response({ q: 'lily plamer dont', tracks: [], sets: [], djs: [] }) : response({ q: 'lily plamer dont', corrected: [{ from: 'plamer', to: 'palmer' }, { from: 'lily', to: 'lilly' }] }))
    const p = await open('?q=lily%20plamer%20dont', answer)
    const note = p.els.get('sq-corrected')
    expect(note.hidden).toBe(false)
    expect(note.innerHTML).toContain('Showing results for <strong>lilly palmer dont</strong>.</span>')
    expect(note.innerHTML).toContain('Search exactly for lily plamer dont')
    expect(p.searchFetches()[0]).not.toContain('exact=1')
    p.fire('sq-corrected', 'click', { target: { closest: () => ({ id: 'sq-exact' }) } })
    await tick()
    expect(p.searchFetches()).toHaveLength(2)
    expect(p.searchFetches()[1]).toContain('exact=1')
    expect(p.els.get('sq-corrected').hidden).toBe(true)
  })

  it('debounces typing and drops a stale reply', async () => {
    const pending: Array<(r: Response) => void> = []
    const p = await open('', (u) => (u.startsWith('/ui/api/search') ? new Promise<Response>((res) => pending.push(res)) : new Response('{}', { status: 404 })))
    expect(p.searchFetches()).toHaveLength(0)
    p.els.get('sq').value = 'ma'; p.fire('sq', 'input')
    p.els.get('sq').value = 'mau'; p.fire('sq', 'input')
    expect(p.debounced()).toHaveLength(1)
    await p.runDebounced()
    expect(p.searchFetches()).toHaveLength(1)
    expect(p.searchFetches()[0]).toContain('q=mau')
    p.els.get('sq').value = 'mau p'; p.fire('sq', 'input')
    await p.runDebounced()
    expect(p.searchFetches()).toHaveLength(2)
    pending[1]!(Response.json(response({ q: 'mau p', sets: [], djs: [], tracks: [track({ title: 'Second reply' })] })))
    await tick()
    pending[0]!(Response.json(response({ q: 'mau', sets: [], djs: [], tracks: [track({ title: 'First reply' })] })))
    await tick()
    const out = p.els.get('sq-results').innerHTML as string
    expect(out).toContain('Second reply')
    expect(out).not.toContain('First reply')
    expect(p.history.urls.at(-1)).toBe('/ui/search?q=mau+p')
  })

  it('a track with no YouTube link and a numeric id gets a links button; one with a link gets a YouTube pill', async () => {
    const r = response({ sets: [], djs: [], tracks: [track({ trackKey: 'a', trackId: '55', title: 'Needs Links' }), track({ trackKey: 'b', trackId: '56', title: 'Has Link', youtubeLink: 'https://youtu.be/abc' }), track({ trackKey: 'c', trackId: null, title: 'No Id' })] })
    const p = await open('?q=mau', () => Response.json(r))
    const out = p.els.get('sq-results').innerHTML as string
    expect((out.match(/data-links="/g) ?? []).length).toBe(1)
    expect(out).toContain('data-links="a"')
    expect(out).toContain('href="https://youtu.be/abc"')
    expect(out).toContain('>YouTube<')
  })

  it('the links button looks the track up and shows the YouTube pill', async () => {
    const r = response({ sets: [], djs: [], tracks: [track({ trackKey: 'a', trackId: '55', title: 'Needs Links' })] })
    const answer = (u: string) => u.startsWith('/ui/api/search') ? Response.json(r) : u === '/ui/api/tracklist/links' ? Response.json({ links: { '55': { youtubeLink: 'https://youtu.be/zzz' } } }) : new Response('{}', { status: 404 })
    const p = await open('?q=mau', answer)
    p.fire('sq-results', 'click', { target: { closest: (s: string) => (s === '[data-links]' ? { dataset: { links: 'a' } } : null) } })
    await tick()
    expect(p.fetches).toContain('/ui/api/tracklist/links')
    const out = p.els.get('sq-results').innerHTML as string
    expect(out).toContain('href="https://youtu.be/zzz"')
    expect(out).not.toContain('data-links="a"')
  })

  it('tabs request kind= and All shows Show all links', async () => {
    const many = response({ sets: Array.from({ length: 7 }, (_, i) => ({ url: SET_URL + i, title: 'Set ' + i, djSlug: 'maup', djName: 'Mau P', date: null, videoId: null, trackCount: 0, idedCount: 0 })) })
    const p = await open('?q=mau', () => Response.json(many))
    expect(p.searchFetches()[0]).toContain('kind=all')
    const out = p.els.get('sq-results').innerHTML as string
    expect(out).toContain('Show all 7')
    expect(out).toContain('data-kind="sets"')
    expect((out.match(/data-set-row/g) ?? []).length).toBe(5)
    expect(p.els.get('sq-tabs').innerHTML).toContain('aria-pressed="true"')
    p.fire('sq-results', 'click', { target: { closest: (s: string) => (s === '[data-kind]' ? { dataset: { kind: 'sets' } } : null) } })
    await tick()
    expect(p.searchFetches()[1]).toContain('kind=sets')
    expect(p.history.urls.at(-1)).toContain('kind=sets')
    expect((p.els.get('sq-results').innerHTML as string).match(/data-set-row/g)!.length).toBe(7)
  })

  it('keyboard: arrows move the active result, Enter opens it, Escape clears', async () => {
    const p = await open('?q=mau', () => Response.json(response()))
    const input = p.els.get('sq')
    expect(p.els.get('sq-results').innerHTML).toContain('role="option"')
    p.fire('sq', 'keydown', { key: 'ArrowDown' })
    expect(input['@aria-activedescendant']).toBe('sq-r0')
    p.fire('sq', 'keydown', { key: 'ArrowDown' })
    expect(input['@aria-activedescendant']).toBe('sq-r1')
    p.fire('sq', 'keydown', { key: 'ArrowUp' })
    expect(input['@aria-activedescendant']).toBe('sq-r0')
    p.fire('sq', 'keydown', { key: 'Enter' })
    expect(p.location.href).toBe('/ui/set?url=' + encodeURIComponent(SET_URL))
    p.fire('sq', 'keydown', { key: 'Escape' })
    expect(input.value).toBe('')
    expect(p.els.get('sq-results').innerHTML).toBe('')
  })

  it('empty states: no query, nothing found, index not set up, other errors', async () => {
    const none = await open('', () => new Response('{}', { status: 404 }))
    expect(none.els.get('sq-empty').textContent).toBe('Search every verified track list: tracks, sets and DJs.')
    const nf = await open('?q=zzz', () => Response.json(response({ q: 'zzz', tracks: [], sets: [], djs: [] })))
    expect(nf.els.get('sq-empty').textContent).toBe('Nothing found for “zzz”.')
    const un = await open('?q=zzz', () => Response.json({ error: 'search_unavailable', message: 'The search index is not bound to this Worker.' }, { status: 503 }))
    expect(un.els.get('sq-empty').textContent).toBe('The search index is not set up on this Worker.')
    const bad = await open('?q=zzz', () => Response.json({ error: 'invalid_request', message: 'nope' }, { status: 400 }))
    expect(bad.els.get('sq-empty').textContent).toBe('nope')
  })
})

describe('TK.api.get abort support', () => {
  it('passes the signal to fetch; an aborted request resolves to aborted:true without throwing', async () => {
    const { RUNTIME_JS } = await import('../src/ui/runtime')
    const seen: unknown[] = []
    const ctx = vm.createContext({ document: { getElementById: () => null, querySelector: () => null, addEventListener() {} }, console, Date, AbortController,
      fetch: (_u: string, init: { signal?: AbortSignal }) => { seen.push(init.signal); return new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' })))) } })
    vm.runInContext(RUNTIME_JS, ctx)
    const ac = new AbortController()
    const p = vm.runInContext('(s) => TK.api.get("/x", { signal: s })', ctx)(ac.signal) as Promise<unknown>
    ac.abort()
    expect(await p).toMatchObject({ ok: false, status: 0, aborted: true })
    expect(seen[0]).toBe(ac.signal)
  })
})

describe('shell search box', () => {
  it('the top form searches /ui/search and the Search tab links there', () => {
    expect(SEARCH_HREF).toBe('/ui/search')
    const h = shell({ nav: 'home', title: 'Home', body: '' })
    expect(h).toContain('<form class="tk-search" action="/ui/search" method="get" role="search">')
    expect(h).toContain('<input id="tk-search" name="q" type="search" placeholder="Search tracks, sets, DJs" aria-label="Search tracks, sets, DJs">')
    const tabs = /<nav class="tk-tabs"[^>]*>([\s\S]*?)<\/nav>/.exec(h)![1]!
    expect(tabs).toContain('href="/ui/search"')
    for (const l of ['Home', 'DJs', 'Search', 'mkvid', 'Pool']) expect(tabs).toContain(l)
  })
})
