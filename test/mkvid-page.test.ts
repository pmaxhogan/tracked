// The /ui/mkvid page script in a stub DOM: the drawer's actions, the
// Delete-and-recreate confirm and the inline error line.
import { describe, it, expect } from 'vitest'
import vm from 'node:vm'
import { MKVID_PAGE_HTML } from '../src/ui/pages/mkvid'

const RECREATE_ASK = 'Delete and recreate this video? The set is rendered again at the back of the queue; the current video stays up until the new one is in the playlists, then it is deleted from YouTube.'

const scripts = [...MKVID_PAGE_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)) }

function fixture() {
  const now = Math.floor(Date.now() / 1000)
  return {
    enabled: true, dailyClaimCap: 30, dailyClaims: 3, now, quotaResetsAt: now + 3600,
    counts: { pending: 0, claimed: 0, done: 1, failed: 0, superseded: 0, banned: 0 },
    accounts: [{ account: 'primary', label: 'primary', cap: 24, used: 3 }],
    lastPoll: { at: now, outcome: 'ok', accounts: ['primary'] },
    oldStyleCount: 0, oldVideos: [], djs: [],
    queue: [], queueCursor: null, queueTotal: 0,
    settled: [{ id: 'r2', slug: 'some-dj', setUrl: 'https://www.1001tracklists.com/tracklist/x/some-set.html', setTitle: 'Some Set', setDate: '2026-09-01',
      source: 'soundcloud', sourceLabel: 'SoundCloud', sourceUrl: 'https://soundcloud.com/x/y', status: 'done', account: 'primary', attempts: 1,
      notBefore: null, createdAt: now, updatedAt: now, skipIdWait: false, style: 'scene', replacesVideoId: null, videoId: 'abcdefghijk', readiness: null }],
    settledCursor: null, settledTotal: 1,
  }
}

/** A stub DOM that keeps each element's listeners, so clicks can be driven. */
function page(answer: (url: string, init?: RequestInit) => Response) {
  const el = (): any => {
    const n: any = { open: false, innerHTML: '', textContent: '', value: '', hidden: false, checked: false, disabled: false, className: '', src: '', dataset: {}, style: {}, options: [],
      on: {} as Record<string, (e: any) => unknown>,
      addEventListener(type: string, fn: (e: any) => unknown) { n.on[type] = fn }, focus() {}, add() {}, remove() {},
      showModal() { n.open = true }, close() { n.open = false; if (n.onclose) n.onclose() },
      querySelector: (sel: string) => (sel === '[data-derr]' ? n.derr ?? (n.derr = el()) : null), querySelectorAll: () => [], closest: () => null }
    return n
  }
  const els = new Map<string, any>()
  const get = (id: string) => (els.has(id) ? els.get(id) : (els.set(id, el()), els.get(id)))
  const document = { hidden: false, getElementById: get, querySelector: () => null, addEventListener() {}, createElement: () => el() }
  const calls: Array<{ url: string; method: string; body?: string }> = []
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined })
    return answer(url, init)
  }
  const ctx = vm.createContext({ document, fetch, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, console, Date, URLSearchParams, JSON, URL,
    location: { search: '', pathname: '/ui/mkvid' }, history: { replaceState() {} },
    Option: function (t: string, v: string) { return { text: t, value: v } } })
  for (const s of scripts) vm.runInContext(s, ctx)
  return { get, calls }
}

const rowClick = (id: string) => ({ target: { closest: (sel: string) => (sel === '.mk-row[data-id]' ? { dataset: { id } } : null) } })
const doClick = (what: string) => {
  const btn = { dataset: { do: what }, textContent: 'x', disabled: false }
  return { target: { closest: (sel: string) => (sel === 'button[data-do]' ? btn : null) } }
}
const posts = (calls: Array<{ method: string; url: string }>) => calls.filter((c) => c.method === 'POST')

describe('mkvid page drawer', () => {
  it('Delete and recreate asks first: yes sends POST /ui/api/mkvid/recreate/{id}, no sends nothing', async () => {
    const { get, calls } = page((url, init) => (init?.method === 'POST' ? Response.json({ ok: true }) : Response.json(fixture())))
    await settle()
    get('mk-settled').on.click(rowClick('r2'))
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

    // Confirm: one POST, then the drawer closes and the page reloads section all.
    const gets = calls.length
    p = body.onclick(doClick('recreate'))
    await settle()
    get('tk-confirm-yes').onclick()
    await p
    await settle()
    expect(posts(calls)).toMatchObject([{ url: '/ui/api/mkvid/recreate/r2', body: '{}' }])
    expect(get('tk-drawer').open).toBe(false)
    expect(calls.slice(gets).some((c) => c.method === 'GET' && c.url.includes('section=all'))).toBe(true)
  })

  it('a failed action keeps the drawer open with the reason inline and reloads section all', async () => {
    const { get, calls } = page((url, init) => (init?.method === 'POST'
      ? Response.json({ error: 'not_found', message: 'no such request' }, { status: 404 })
      : Response.json(fixture())))
    await settle()
    get('mk-settled').on.click(rowClick('r2'))
    const body = get('tk-drawer-body')
    const before = calls.length
    await body.onclick(doClick('retry'))
    await settle()
    expect(posts(calls)).toMatchObject([{ url: '/ui/api/mkvid/retry/r2' }])
    expect(get('tk-drawer').open).toBe(true)
    const line = body.querySelector('[data-derr]')
    expect(line.hidden).toBe(false)
    expect(line.textContent).toBe('retry failed (404): no such request')
    expect(calls.slice(before).some((c) => c.method === 'GET' && c.url.includes('section=all'))).toBe(true)
  })
})
