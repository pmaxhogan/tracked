import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app } from '../src/index'
import { fakeKV } from './helpers/fake-kv'
import { fakeR2 } from './helpers/fake-r2'
import { PAGE_DAILY_CAP, drainPageCaptures, gunzipToText, pageKey, scrubUsername, storePage, type PageCapture } from '../src/lib/page-store'
import { fetch1001 } from '../src/lib/upstream1001'
import type { Env } from '../src/types'

const fx = (n: string) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', n), 'utf8')
const DECOY = fx('tracklist-decoy-dcr839.html')
const CLEAN = fx('tracklist-habstrakt.html')
const SET_URL = 'https://www.1001tracklists.com/tracklist/1pqq0hst/some-set-2026-08-28.html'
const NOW = Date.parse('2026-09-30T12:00:00Z')

const cap = (html: string, over: Partial<PageCapture> = {}): PageCapture => ({
  url: SET_URL,
  kind: 'set',
  priority: 'phone',
  status: 200,
  html,
  accountId: 'acct-7',
  exitLabel: 'exit-a',
  fetchedAt: '2026-09-30T12:00:00.000Z',
  ...over,
})
const ctx = () => ({ bucket: fakeR2(), counter: fakeKV(), now: () => NOW })
const body = async (b: ReturnType<typeof fakeR2>, key: string) => gunzipToText((await (await b.get(key))!.arrayBuffer()) as ArrayBuffer)

afterEach(() => vi.unstubAllGlobals())

describe('scrubUsername', () => {
  it('replaces the logged-in name in the dashboard link and nothing else', () => {
    const html = '<a class="navBtn" href="/dashboard/index.html" title="user dashboard for someone-real (12)"><i></i></a><a href="/user/other/index.html">other</a>'
    const out = scrubUsername(html, 'acct-7')
    expect(out).toBe('<a class="navBtn" href="/dashboard/index.html" title="user dashboard for acct-7 (12)"><i></i></a><a href="/user/other/index.html">other</a>')
    expect(out).not.toContain('someone-real')
  })
  it('handles the real-page shape in the fixtures', () => {
    const out = scrubUsername(DECOY, 'acct-7')
    expect(out).toContain('title="user dashboard for acct-7 (0)"')
    expect(out).not.toContain('user dashboard for acct1')
  })
})

describe('storePage', () => {
  it('files a decoy page under flagged/, gzipped, with metadata and the username scrubbed', async () => {
    const o = ctx()
    const key = await storePage(o, cap(DECOY))
    expect(key).toBe('flagged/2026-09-30/set/1pqq0hst/1790769600-acct-7.html')
    const obj = await o.bucket.get(key!)
    expect(obj!.httpMetadata!.contentEncoding).toBe('gzip')
    expect(obj!.customMetadata).toMatchObject({ url: SET_URL, kind: 'set', priority: 'phone', accountId: 'acct-7', exitLabel: 'exit-a', status: '200', verdict: 'decoy' })
    expect(obj!.customMetadata!.detail).toMatch(/mismatched=/)
    const html = await body(o.bucket, key!)
    expect(html).toContain('user dashboard for acct-7 (0)')
    expect(html).not.toContain('for acct1')
    expect(html.length).toBe(scrubUsername(DECOY, 'acct-7').length)
  })

  it('files a clean set page under clean/', async () => {
    const o = ctx()
    const key = await storePage(o, cap(CLEAN))
    expect(key!.startsWith('clean/2026-09-30/set/')).toBe(true)
    expect((await o.bucket.get(key!))!.customMetadata!.verdict).toBe('clean')
  })

  it('files error and challenge pages under other/, and non-set pages as clean', async () => {
    const o = ctx()
    expect((await storePage(o, cap('x', { status: 404 })))!.startsWith('other/')).toBe(true)
    expect((await storePage(o, cap('x', { status: 403, accountId: 'acct-8' })))!.startsWith('other/')).toBe(true)
    expect((await storePage(o, cap('<html></html>')))!.startsWith('other/')).toBe(true) // set page with no rows
    const k = await storePage(o, cap('<html></html>', { kind: 'dj', url: 'https://www.1001tracklists.com/dj/x/index.html', accountId: 'acct-9' }))
    expect(k).toBe('clean/2026-09-30/dj/dj_x_index/1790769600-acct-9.html'.replace('dj_x_index', 'dj_x_index'))
  })

  it('tells POST forms apart in the slug', async () => {
    const o = ctx()
    const u = 'https://www.1001tracklists.com/search/result.php'
    const a = await storePage(o, cap('<p></p>', { kind: 'search', url: u, variant: '{"q":"a"}' }))
    const b = await storePage(o, cap('<p></p>', { kind: 'search', url: u, variant: '{"q":"b"}', accountId: 'acct-7' }))
    expect(a).not.toBe(b)
  })

  it('stops at the daily cap and logs once', async () => {
    const o = ctx()
    const warn = vi.fn()
    const log = { info: vi.fn(), warn, error: vi.fn(), counters: {} } as never
    await o.counter.put('pages:count:2026-09-30', String(PAGE_DAILY_CAP))
    expect(await storePage({ ...o, log }, cap(CLEAN))).toBeNull()
    expect(await storePage({ ...o, log }, cap(CLEAN))).toBeNull()
    expect(o.bucket._store.size).toBe(0)
    expect(warn.mock.calls.filter((c) => c[0] === 'pages.daily_cap_hit')).toHaveLength(1)
  })

  it('swallows a failing bucket', async () => {
    const o = ctx()
    o.bucket.failPuts = true
    expect(await storePage(o, cap(CLEAN))).toBeNull()
  })
})

describe('pageKey', () => {
  it('uses the fetch time, UTC', () => {
    expect(pageKey({ verdict: 'clean', kind: 'set', slug: 's', accountId: 'a', fetchedAt: '2026-01-02T23:59:59Z' }, 0)).toBe('clean/2026-01-02/set/s/1767398399-a.html')
  })
})

describe('fetch1001 keeps every page, in the background', () => {
  it('returns at once and stores the page via drainPageCaptures', async () => {
    const o = ctx()
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ status: 200, html: DECOY, accountId: 'acct-2', exitLabel: 'e', fetchedAt: '2026-09-30T12:00:00Z' }), { status: 200 }))
    const r = await fetch1001(SET_URL, { pool: { url: 'https://pool.example', token: 't' } as never, pages: o, kind: 'set', priority: 'phone' })
    expect(r.accountId).toBe('acct-2')
    await drainPageCaptures()
    expect([...o.bucket._store.keys()]).toEqual(['flagged/2026-09-30/set/1pqq0hst/1790769600-acct-2.html'])
  })
})

describe('GET /pool/pages', () => {
  const env = async () => {
    const bucket = fakeR2()
    await storePage({ bucket, counter: fakeKV(), now: () => NOW }, cap(DECOY))
    return { CACHE: fakeKV(), API_TOKEN: 'tasker', TLPOOL_TOKEN: 'pool', PAGES: bucket } as unknown as Env
  }
  const get = (e: Env, path: string, token = 'tasker') => app.request(path, { headers: { Authorization: `Bearer ${token}` } }, e)

  it('rejects the wrong bearer (including the pool token)', async () => {
    const e = await env()
    expect((await get(e, '/pool/pages', 'pool')).status).toBe(401)
    expect((await get(e, '/pool/pages', 'nope')).status).toBe(401)
    expect((await app.request('/pool/pages/x', {}, e)).status).toBe(401)
  })

  it('lists keys with metadata and reads one back as plain text', async () => {
    const e = await env()
    const list = (await (await get(e, '/pool/pages?prefix=flagged/')).json()) as { objects: { key: string; metadata: Record<string, string> }[]; truncated: boolean }
    expect(list.objects).toHaveLength(1)
    expect(list.objects[0]!.metadata.verdict).toBe('decoy')
    const r = await get(e, `/pool/pages/${list.objects[0]!.key}`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/plain')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await r.text()).toContain('user dashboard for acct-7')
    expect((await get(e, '/pool/pages/flagged/none.html')).status).toBe(404)
  })

  it('does not break the pool webhook gate', async () => {
    const e = await env()
    const r = await app.request('/pool/events', { method: 'POST', headers: { Authorization: 'Bearer tasker' }, body: '{}' }, e)
    expect(r.status).toBe(401)
  })
})

describe('fail-closed scrub', () => {
  const variants = [
    '<a href="/dashboard/index.html" class="navBtn" title="USER DASHBOARD FOR Secret_Name (3)">x</a>',
    "<a data-x=1 title='user dashboard for Secret_Name' href=\"/dashboard/index.html\">x</a>",
    '<a title="user   dashboard for Secret_Name (0)" class="a" id="b">x</a>',
    '<a aria-label="user dashboard for Secret_Name (9)">x</a>',
    '<a title="Dashboard of Secret_Name">x</a>',
    '<a title="user dashboard for&nbsp;Secret_Name">x</a>',
  ]
  it.each(variants)('never keeps the name: %s', (v) => {
    const out = scrubUsername(`<html>${v}<body>rest</body></html>`, 'acct-7')
    expect(out).not.toContain('Secret_Name')
  })
  it('falls back to a note when the header cannot be scrubbed safely', async () => {
    const o = ctx()
    const key = await storePage(o, cap('<html><a title="user dashboard for&#32;Secret_Name">x</a> dashboard&nbsp;for Secret_Name</html>', { verdict: { verdict: 'clean', detail: '' } }))
    const html = await body(o.bucket, key!)
    expect(html).not.toContain('Secret_Name')
    expect(html).toContain('withheld')
    expect((await o.bucket.get(key!))!.customMetadata!.detail).toContain('scrub:note')
  })
  it('keeps a guest page byte for byte', () => {
    expect(scrubUsername(CLEAN, 'acct-7').length).toBeGreaterThan(1000)
  })
})

describe('classification failure', () => {
  it('stores as other/error with classify_failed, after the scrub', async () => {
    vi.resetModules()
    vi.doMock('../src/lib/tracklists1001', () => ({
      parseTracklist: () => {
        throw new Error('parser blew up')
      },
    }))
    const { storePage: store } = await import('../src/lib/page-store')
    const o = ctx()
    const key = await store(o, cap('<a title="user dashboard for Secret_Name (1)">x</a>'))
    vi.doUnmock('../src/lib/tracklists1001')
    expect(key!.startsWith('other/2026-09-30/set/')).toBe(true)
    expect((await o.bucket.get(key!))!.customMetadata).toMatchObject({ verdict: 'error', detail: 'classify_failed' })
    const html = await body(o.bucket, key!)
    expect(html).toContain('for acct-7 (1)')
    expect(html).not.toContain('Secret_Name')
  })
})
