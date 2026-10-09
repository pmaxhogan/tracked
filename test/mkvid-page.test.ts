// The /ui/mkvid page script in a stub DOM: the header, the three tables
// (Queue and Finished are server-side TKTables, Old videos local), the
// reorder/ban buttons, the drawer's actions, the Delete-and-recreate confirm
// and the inline error line.
import { describe, it, expect } from 'vitest'
import vm from 'node:vm'
import { MKVID_PAGE_HTML } from '../src/ui/pages/mkvid'

const RECREATE_ASK = 'Delete and recreate this video? The set is rendered again at the back of the queue; the current video stays up until the new one is in the playlists, then it is deleted from YouTube.'

const scripts = [...MKVID_PAGE_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)) }

const NOW = Math.floor(Date.now() / 1000)
const DONE = { id: 'r2', slug: 'some-dj', setUrl: 'https://www.1001tracklists.com/tracklist/x/some-set.html', setTitle: 'Some Set', setDate: '2026-09-01',
  source: 'soundcloud', sourceLabel: 'SoundCloud', sourceUrl: 'https://soundcloud.com/x/y', status: 'done', account: 'primary', attempts: 1,
  notBefore: null, createdAt: NOW, updatedAt: NOW, skipIdWait: false, style: 'scene', replacesVideoId: null, videoId: 'abcdefghijk', readiness: null }
const WAITING = (id: string, position: number, extra: Record<string, unknown> = {}) => ({ ...DONE, id, status: 'pending', videoId: null, style: null, position,
  setTitle: 'Waiting <b>' + id + '</b>', readiness: { state: 'waiting_ids', until: NOW + 86400 * 3, idRows: 2 }, ...extra })

function header(extra: Record<string, unknown> = {}) {
  return {
    enabled: true, dailyClaimCap: 30, dailyClaims: 3, now: NOW, quotaResetsAt: NOW + 3600,
    counts: { pending: 2, claimed: 1, done: 1, failed: 0, superseded: 0, banned: 0 },
    accounts: [{ account: 'primary', label: 'primary', cap: 24, used: 3 }],
    lastPoll: { at: NOW, outcome: 'ok', accounts: ['primary'] },
    oldStyleCount: 0, oldVideos: [{ videoId: 'oldvid00001', setUrl: DONE.setUrl, replacedBy: 'abcdefghijk', state: 'pending', attempts: 1, nextTryAt: NOW + 600, lastError: 'quota', createdAt: NOW }],
    djs: [{ slug: 'some-dj', label: 'Some DJ', count: 3 }],
    rendering: [{ ...DONE, id: 'r9', status: 'claimed', setTitle: 'Rendering Set', videoId: null }],
    ...extra,
  }
}
const tableOf = (rows: unknown[]) => ({ rows, total: rows.length, page: 1, size: 25, pageCount: 1, sort: [], filters: [], q: '' })
/** The page's GETs: the header, the two tables, the progress (unavailable). */
function answers(url: string): Response {
  if (url.startsWith('/ui/api/mkvid/finished?')) return Response.json(tableOf([DONE]))
  if (url.startsWith('/ui/api/mkvid/queue?')) return Response.json(tableOf([WAITING('r3', 7), WAITING('r4', 8)]))
  if (url === '/ui/api/mkvid') return Response.json(header())
  return Response.json({ error: 'mkvid_unavailable' }, { status: 503 })
}

/** A stub DOM that keeps each element's listeners, so clicks can be driven. */
function page(answer: (url: string, init?: RequestInit) => Response, search = '') {
  const location = { search, pathname: '/ui/mkvid', hash: '' }
  const el = (): any => {
    const n: any = { open: false, innerHTML: '', textContent: '', value: '', hidden: false, checked: false, disabled: false, className: '', src: '', dataset: {}, style: {}, options: [],
      on: {} as Record<string, (e: any) => unknown>,
      addEventListener(type: string, fn: (e: any) => unknown) { n.on[type] = fn }, focus() {}, add() {}, remove() {},
      showModal() { n.open = true }, close() { n.open = false; if (n.onclose) n.onclose() },
      setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
      querySelector: (sel: string) => (sel === '[data-derr]' ? n.derr ?? (n.derr = el()) : null), querySelectorAll: () => [], closest: () => null }
    return n
  }
  const els = new Map<string, any>()
  const get = (id: string) => (els.has(id) ? els.get(id) : (els.set(id, el()), els.get(id)))
  const document = { hidden: false, getElementById: get, querySelector: () => null, addEventListener() {}, removeEventListener() {}, createElement: () => el() }
  const calls: Array<{ url: string; method: string; body?: string }> = []
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined })
    return answer(url, init)
  }
  const ctx = vm.createContext({ document, fetch, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, console, Date, URLSearchParams, JSON, URL,
    location, history: { state: null, replaceState(_s: unknown, _t: string, u: string) { const i = u.indexOf('?'); location.search = i < 0 ? '' : u.slice(i) } },
    Option: function (t: string, v: string) { return { text: t, value: v } } })
  for (const s of scripts) vm.runInContext(s, ctx)
  return { get, calls, location }
}

/** A click on table row i (TKTable delegates through closest('tr[data-tkt-row]')). */
const rowClick = (i: number) => {
  const tr = { getAttribute: (k: string) => (k === 'data-tkt-row' ? String(i) : null) }
  return { target: { getAttribute: () => null, closest: (sel: string) => (sel === 'tr[data-tkt-row]' ? tr : null) } }
}
/** A click on a data-act button in table row i. */
const actClick = (i: number, act: string) => {
  const tr = { getAttribute: (k: string) => (k === 'data-tkt-row' ? String(i) : null), querySelectorAll: () => [] }
  const btn: any = { getAttribute: (k: string) => (k === 'data-act' ? act : null), disabled: false, textContent: '', closest: (sel: string) => (sel === 'tr' ? tr : null) }
  return { target: { getAttribute: () => null, closest: (sel: string) => (sel === '[data-act]' ? btn : sel === 'tr[data-tkt-row]' ? tr : null) } }
}
const ctlClick = (attrs: Record<string, string>) => {
  const t: any = { getAttribute: (k: string) => (k in attrs ? attrs[k] : null), disabled: false }
  t.closest = (sel: string) => (sel === '[data-tkt]' && 'data-tkt' in attrs ? t : null)
  return { target: t }
}
const gets = (calls: Array<{ method: string; url: string }>) => calls.filter((c) => c.method === 'GET').map((c) => decodeURIComponent(c.url))
const doClick = (what: string) => {
  const btn = { dataset: { do: what }, textContent: 'x', disabled: false }
  return { target: { closest: (sel: string) => (sel === 'button[data-do]' ? btn : null) } }
}
const posts = (calls: Array<{ method: string; url: string }>) => calls.filter((c) => c.method === 'POST')

describe('mkvid page drawer', () => {
  it('Delete and recreate asks first: yes sends POST /ui/api/mkvid/recreate/{id}, no sends nothing', async () => {
    const { get, calls } = page((url, init) => (init?.method === 'POST' ? Response.json({ ok: true }) : answers(url)))
    await settle()
    get('mk-settled').on.click(rowClick(0))
    const body = get('tk-drawer-body')
    expect(get('tk-drawer').open).toBe(true)
    expect(body.innerHTML).toContain('Delete and recreate')

    // Cancel: no request.
    let p = body.onclick(doClick('recreate'))
    await settle()
    expect(get('tk-confirm-text').textContent).toBe(RECREATE_ASK)
    expect(get('tk-confirm').open).toBe(true)
    get('tk-confirm-no').onclick()
    await p
    expect(posts(calls)).toEqual([])
    expect(get('tk-drawer').open).toBe(true)

    // Confirm: one POST, then the drawer closes and the header and both tables reload.
    const before = calls.length
    p = body.onclick(doClick('recreate'))
    await settle()
    get('tk-confirm-yes').onclick()
    await p
    await settle()
    expect(posts(calls)).toMatchObject([{ url: '/ui/api/mkvid/recreate/r2', body: '{}' }])
    expect(get('tk-drawer').open).toBe(false)
    expect(gets(calls.slice(before)).filter((u) => u === '/ui/api/mkvid' || u.startsWith('/ui/api/mkvid/queue?') || u.startsWith('/ui/api/mkvid/finished?'))).toHaveLength(3)
  })

  it('a failed action keeps the drawer open with the reason inline and reloads', async () => {
    const { get, calls } = page((url, init) => (init?.method === 'POST'
      ? Response.json({ error: 'not_found', message: 'no such request' }, { status: 404 })
      : answers(url)))
    await settle()
    get('mk-settled').on.click(rowClick(0))
    const body = get('tk-drawer-body')
    const before = calls.length
    await body.onclick(doClick('retry'))
    await settle()
    expect(posts(calls)).toMatchObject([{ url: '/ui/api/mkvid/retry/r2' }])
    expect(get('tk-drawer').open).toBe(true)
    const line = body.querySelector('[data-derr]')
    expect(line.hidden).toBe(false)
    expect(line.textContent).toBe('retry failed (404): no such request')
    expect(gets(calls.slice(before))).toContain('/ui/api/mkvid')
  })
})

describe('mkvid page tables', () => {
  it('paints the header, rendering now, the queue in claim order with positions and moves, and the finished table', async () => {
    const { get, calls } = page((url) => answers(url))
    await settle()
    expect(gets(calls).filter((u) => u.startsWith('/ui/api/mkvid') && !u.includes('/progress')).sort()).toEqual([
      '/ui/api/mkvid',
      '/ui/api/mkvid/finished?page=1&size=25&sort=-updatedAt',
      '/ui/api/mkvid/queue?page=1&size=25&sort=position',
    ])
    expect(get('mk-state').innerHTML).toContain('Rendering 1 set now')
    expect(get('mk-rendering').innerHTML).toContain('Rendering Set')
    const q = get('q-body').innerHTML as string
    expect(q).toContain('#7')
    expect(q).toContain('waiting for IDs until')
    expect(q).toContain('Waiting &lt;b&gt;r3')
    expect(q).not.toContain('<b>r3')
    for (const a of ['top', 'up', 'down', 'bottom', 'ban']) expect(q).toContain(`data-act="${a}"`)
    expect(get('fin-body').innerHTML).toContain('href="https://youtu.be/abcdefghijk"')
    expect(get('old-body').innerHTML).toContain('oldvid00001')
    expect(get('mk-n-queue').textContent).toBe('3')
    expect(get('mk-dj').innerHTML).toContain('<option value="some-dj">Some DJ (3)</option>')
  })

  it('moves post the whole-queue move and reload; sorted by another column only ban is offered', async () => {
    const { get, calls } = page((url, init) => (init?.method === 'POST' ? Response.json({ ok: true }) : answers(url)))
    await settle()
    get('mk-queue').on.click(actClick(1, 'up'))
    await settle()
    expect(calls.filter((c) => c.method === 'POST')).toMatchObject([{ url: '/ui/api/mkvid/move/r4', body: '{"to":"up"}' }])
    get('mk-queue').on.click(ctlClick({ 'data-tkt': 'sort', 'data-col': 'setDate' }))
    await settle()
    expect(gets(calls).at(-1)).toBe('/ui/api/mkvid/queue?page=1&size=25&sort=setDate')
    const q = get('q-body').innerHTML as string
    expect(q).not.toContain('data-act="up"')
    expect(q).toContain('data-act="ban"')
    get('mk-queue').on.click(actClick(0, 'ban'))
    await settle()
    expect(calls.filter((c) => c.method === 'POST').at(-1)).toMatchObject({ url: '/ui/api/mkvid/ban/r3' })
  })

  it('the DJ select and chips filter on the server; old ?status=&tab= links become table filters', async () => {
    const { get, calls } = page((url) => answers(url))
    await settle()
    get('mk-dj').value = 'some-dj'
    get('mk-dj').on.change({})
    await settle()
    expect(gets(calls)).toContain('/ui/api/mkvid/queue?page=1&size=25&sort=position&f.dj=eq:some-dj')
    expect(gets(calls)).toContain('/ui/api/mkvid/finished?page=1&size=25&sort=-updatedAt&f.dj=eq:some-dj')
    get('mk-settled').on.click(ctlClick({ 'data-tkt': 'chip', 'data-chip': 'problems' }))
    await settle()
    expect(gets(calls).at(-1)).toBe('/ui/api/mkvid/finished?page=1&size=25&sort=-updatedAt&f.status=in:failed|banned&f.dj=eq:some-dj')

    const old = page((url) => answers(url), '?status=failed,banned&tab=settled&source=hearthis&q=palmer')
    await settle()
    expect(gets(old.calls)).toContain('/ui/api/mkvid/finished?page=1&size=25&sort=-updatedAt&q=palmer&f.source=in:hearthis&f.status=in:failed|banned')
    expect(gets(old.calls)).toContain('/ui/api/mkvid/queue?page=1&size=25&sort=position&q=palmer&f.source=in:hearthis')
    expect(old.location.search).not.toMatch(/[?&](status|source|q)=/)
    expect(old.get('mk-p-settled').hidden).toBe(false)
    expect(old.get('mk-p-queue').hidden).toBe(true)
  })
})
