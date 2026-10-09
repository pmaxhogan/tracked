// The Pre-saves, Pre-saved track and Track uploads pages: served like every
// shell page, and their scripts in a stub DOM: the table fetch URLs and the
// actions' requests.
import { describe, it, expect } from 'vitest'
import vm from 'node:vm'
import { app } from '../src/index'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'
import type { Env } from '../src/types'
import { PRESAVES_PAGE } from '../src/ui/pages/presaves'
import { PRESAVE_PAGE } from '../src/ui/pages/presave'
import { TRACK_UPLOADS_PAGE } from '../src/ui/pages/track-uploads'

const env = () => ({ CACHE: fakeKV(), SUBS: fakeKV(), DB: fakeD1(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k', DEV_BYPASS_CF_ACCESS: '1' }) as unknown as Env
const scriptsOf = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }

type Call = { url: string; method: string; body?: unknown }

/** A stub DOM whose elements keep their listeners, running every script of the page. */
function page(html: string, search: string, answer: (url: string, method: string) => unknown) {
  const el = (): any => {
    const n: any = { open: false, innerHTML: '', textContent: '', value: '', hidden: false, checked: false, disabled: false, className: '', src: '', dataset: {}, style: {}, options: [],
      on: {} as Record<string, (e: any) => unknown>,
      addEventListener(type: string, fn: (e: any) => unknown) { n.on[type] = fn }, focus() {}, add() {}, remove() {},
      showModal() { n.open = true }, close() { n.open = false; if (n.onclose) n.onclose() },
      setAttribute() {}, removeAttribute() {}, getAttribute: () => null, appendChild() {},
      querySelector: () => null, querySelectorAll: () => [], closest: () => null }
    return n
  }
  const els = new Map<string, any>()
  const get = (id: string) => (els.has(id) ? els.get(id) : (els.set(id, el()), els.get(id)))
  const document = { hidden: false, getElementById: get, querySelector: () => null, addEventListener() {}, createElement: () => el() }
  const calls: Call[] = []
  const location = { search, pathname: '/ui/x', hash: '', href: '' }
  const fetch = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined })
    const a = answer(url, method)
    return a instanceof Response ? a : Response.json(a ?? {})
  }
  const ctx = vm.createContext({ document, fetch, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, console, Date, URLSearchParams, JSON, URL, AbortController,
    location, history: { state: null, replaceState(_s: unknown, _t: string, u: string) { const i = u.indexOf('?'); location.search = i < 0 ? '' : u.slice(i) } } })
  for (const s of scriptsOf(html)) vm.runInContext(s, ctx)
  return { get, calls, location }
}

/** A click target answering closest() for the selectors the table and the pages ask for. */
function target(attrs: Record<string, string>, extra: { tr?: any } = {}): any {
  const t: any = {
    textContent: 'x', disabled: false, dataset: {}, setAttribute() {}, removeAttribute() {},
    getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
    closest(sel: string) {
      if (sel === '[data-act]') return 'data-act' in attrs ? t : null
      if (sel === 'button[data-do]') return 'data-do' in attrs ? t : null
      if (sel === '[data-tab]') return 'data-tab' in attrs ? t : null
      if (sel === 'tr[data-tkt-row]') return extra.tr ?? null
      return null
    },
  }
  return t
}
const ev = (t: unknown) => ({ target: t, preventDefault() {} })
const actOn = (act: string, row = 0) => ev(target({ 'data-act': act }, { tr: target({ 'data-tkt-row': String(row) }) }))
const posts = (calls: Call[]) => calls.filter((c) => c.method !== 'GET')
const gets = (calls: Call[]) => calls.filter((c) => c.method === 'GET').map((c) => decodeURIComponent(c.url))

const NOW = Date.now()
function presave(over: Record<string, unknown> = {}) {
  return {
    id: 7, trackId: '909720', trackUrl: 'https://www.1001tracklists.com/track/1hf79cg5/tobehonest-where-ya-at/index.html', setUrl: 'https://www.1001tracklists.com/tracklist/2mx9k/some-set.html',
    rowIndex: 4, cueSeconds: 3750, artist: 'TOBEHONEST', title: 'Where Ya At', artworkUrl: 'https://cdn.example/a.jpg', label: null, djSlug: 'some-dj', stage: 'links',
    links: [{ source: '36', name: 'spotify', url: 'https://open.spotify.com/track/abc', playerId: 'abc', duration: 201 }, { source: '10', name: 'soundcloud', url: 'https://api.soundcloud.com/tracks/42', playerId: '42', duration: 200 }],
    linkSources: ['spotify', 'soundcloud'], linkCount: 2, durationSeconds: 201, youtubeVideoId: null, youtubeUrl: null, youtubeMusicUrl: null, source: 'ui',
    createdAt: NOW - 86400000, updatedAt: NOW, lastCheckedAt: NOW - 3600000, nextCheckAt: NOW + 3600000, checkCount: 3, failCount: 0, lastResult: 'no_youtube', lastError: null,
    identifiedAt: null, foundAt: null, notifiedAt: null, dismissedAt: null, uploadEligibleAt: NOW + 4 * 86400000, ...over,
  }
}
const table = (rows: unknown[], extra: Record<string, unknown> = {}) => ({ rows, total: rows.length, page: 1, size: 50, pageCount: 1, sort: [], filters: [], q: '', ...extra })
const upload = (over: Record<string, unknown> = {}) => ({
  id: 3, presaveId: 7, trackId: '909720', artist: 'TOBEHONEST', title: 'Where Ya At', artworkUrl: null, trackUrl: null, sourceName: 'soundcloud', sourceUrl: 'https://api.soundcloud.com/tracks/42',
  sourceBanned: false, expectedDurationSeconds: 201, status: 'failed', attempts: 3, notBefore: null, claimedAt: NOW - 7200000, account: 'primary', jobId: 'j1', videoId: null,
  youtubeUrl: null, youtubeMusicUrl: null, privacy: null, playlistStatus: null, error: 'yt-dlp: 404', createdAt: NOW - 86400000, updatedAt: NOW, completedAt: null, notifiedAt: null, ...over,
})

describe('the pages are served', () => {
  it.each([['/ui/presaves', 'Pre-saves', 'presaves'], ['/ui/presave?id=7', 'Pre-saved track', 'presaves'], ['/ui/track-uploads', 'Track uploads', 'track-uploads']])('%s: 200, no-store, its h1, its nav item lit', async (path, h1, nav) => {
    const r = await app.request(`https://tracked.example${path}`, {}, env())
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('no-store')
    const text = await r.text()
    expect(text).toContain(`<h1>${h1}</h1>`)
    expect(text).toMatch(new RegExp(`<a [^>]*href="/ui/${nav}"[^>]*class="on"`))
    for (const s of scriptsOf(text)) expect(() => new vm.Script(s)).not.toThrow()
  })
  it('link to their settings groups', () => {
    expect(PRESAVES_PAGE.html).toContain('href="/ui/settings#sf-presave"')
    expect(PRESAVE_PAGE.html).toContain('href="/ui/settings#sf-presave"')
    expect(TRACK_UPLOADS_PAGE.html).toContain('href="/ui/settings#sf-track-uploads"')
  })
})

describe('Pre-saves page', () => {
  const answer = (url: string, method: string) => {
    if (method === 'GET' && url.startsWith('/ui/api/presaves?')) return table([presave(), presave({ id: 8, stage: 'found', youtubeVideoId: 'h8CtvP1rEy8', youtubeMusicUrl: 'https://music.youtube.com/watch?v=h8CtvP1rEy8', artist: 'ID', title: 'ID' })], { counts: { identify: 1, links: 1, found: 1, uploaded: 0, dismissed: 2 } })
    if (url.endsWith('/recheck')) return { presave: presave({ lastResult: 'no_youtube' }), check: { result: 'no_youtube', linkCount: 2, linkSources: ['spotify', 'soundcloud'] } }
    if (url === '/ui/api/presaves' && method === 'POST') return { ok: true, created: true, presave: presave({ id: 9 }), message: 'Pre-saved: A – B (watching for a YouTube link)' }
    return { presave: presave() }
  }

  it('loads the Watching chip by default, renders the row, the stage, the link chips and the counts', async () => {
    const { get, calls } = page(PRESAVES_PAGE.html, '', answer)
    await settle()
    const list = gets(calls).filter((u) => u.startsWith('/ui/api/presaves'))
    expect(list).toEqual(['/ui/api/presaves?page=1&size=50&sort=-createdAt&f.stage=in:identify|links'])
    const body = get('ps-body').innerHTML
    expect(body).toContain('TOBEHONEST – Where Ya At')
    expect(body).toContain('href="/ui/presave?id=7"')
    expect(body).toContain('Watching')
    expect(body).toContain('href="https://open.spotify.com/track/abc"')
    expect(body).toContain('>SoundCloud<')
    expect(body).toContain('href="https://music.youtube.com/watch?v=h8CtvP1rEy8"')
    expect(body).toContain('data-act="recheck"')
    expect(get('ps-chips').innerHTML).toMatch(/Watching[\s\S]*>2</)
    expect(body).not.toMatch(/\stitle="/)
  })

  it('Recheck now posts the recheck and reloads; Dismiss posts dismiss', async () => {
    const { get, calls } = page(PRESAVES_PAGE.html, '', answer)
    await settle()
    const host = get('ps-table')
    const before = gets(calls).length
    await host.on.click(actOn('recheck'))
    await settle()
    expect(posts(calls)).toMatchObject([{ url: '/ui/api/presaves/7/recheck', method: 'POST' }])
    expect(gets(calls).length).toBeGreaterThan(before)
    await host.on.click(actOn('dismiss'))
    await settle()
    expect(posts(calls).map((c) => c.url)).toEqual(['/ui/api/presaves/7/recheck', '/ui/api/presaves/7/dismiss'])
  })

  it('a row click opens the track page', async () => {
    const { get, location } = page(PRESAVES_PAGE.html, '', answer)
    await settle()
    get('ps-table').on.click(ev(target({}, { tr: target({ 'data-tkt-row': '1' }) })))
    expect(location.href).toBe('/ui/presave?id=8')
  })

  it('the add form posts a track URL, refuses a set URL without a cue, and posts a set URL with its cue', async () => {
    const { get, calls } = page(PRESAVES_PAGE.html, '', answer)
    await settle()
    const submit = get('ps-add').on.submit
    get('ps-add-url').value = 'https://www.1001tracklists.com/track/1hf79cg5/tobehonest-where-ya-at/index.html'
    await submit({ preventDefault() {} })
    await settle()
    expect(posts(calls)).toMatchObject([{ url: '/ui/api/presaves', body: { trackUrl: 'https://www.1001tracklists.com/track/1hf79cg5/tobehonest-where-ya-at/index.html' } }])
    expect(get('ps-add-msg').innerHTML).toContain('href="/ui/presave?id=9"')

    get('ps-add-url').value = 'https://www.1001tracklists.com/tracklist/2mx9k/some-set.html'
    await submit({ preventDefault() {} })
    expect(posts(calls).length).toBe(1)
    expect(get('ps-add-msg').className).toContain('bad')

    get('ps-add-url').value = 'https://www.1001tracklists.com/tracklist/2mx9k/some-set.html'
    get('ps-add-cue').value = '1:02:30'
    await submit({ preventDefault() {} })
    await settle()
    expect(posts(calls)[1]).toMatchObject({ url: '/ui/api/presaves', body: { tracklistUrl: 'https://www.1001tracklists.com/tracklist/2mx9k/some-set.html', cueSeconds: 3750 } })

    get('ps-add-url').value = 'https://example.com/track/x'
    await submit({ preventDefault() {} })
    expect(posts(calls).length).toBe(2)
  })
})

describe('Pre-saved track page', () => {
  it('without an id shows an empty state and fetches no pre-save', async () => {
    const { get, calls } = page(PRESAVE_PAGE.html, '', () => ({}))
    await settle()
    expect(get('pv-root').innerHTML).toContain('No pre-saved track picked')
    expect(gets(calls).filter((u) => u.startsWith('/ui/api/presaves'))).toEqual([])
  })

  it('a found track gets the one-click YouTube Music button, the links, and the check history table', async () => {
    const found = presave({ stage: 'found', youtubeVideoId: 'h8CtvP1rEy8', youtubeUrl: 'https://www.youtube.com/watch?v=h8CtvP1rEy8', youtubeMusicUrl: 'https://music.youtube.com/watch?v=h8CtvP1rEy8', foundAt: NOW, nextCheckAt: null })
    const { get, calls } = page(PRESAVE_PAGE.html, '?id=7', (url) => (url.includes('/checks') ? table([{ id: 1, presaveId: 7, at: NOW, trigger: 'scheduled', result: 'found', stageBefore: 'links', stageAfter: 'found', linkCount: 3, linkSources: ['spotify', 'youtube'], youtubeVideoId: 'h8CtvP1rEy8', error: null, ms: 812 }]) : { presave: found, upload: null }))
    await settle()
    expect(gets(calls)).toEqual(expect.arrayContaining(['/ui/api/presaves/7', '/ui/api/presaves/7/checks?page=1&size=25&sort=-at']))
    const root = get('pv-root').innerHTML
    expect(root).toContain('href="https://music.youtube.com/watch?v=h8CtvP1rEy8"')
    expect(root).toContain('Open in YouTube Music')
    expect(root).toContain('href="https://www.1001tracklists.com/track/1hf79cg5/tobehonest-where-ya-at/index.html"')
    expect(root).toContain('href="/ui/set?url=' + encodeURIComponent('https://www.1001tracklists.com/tracklist/2mx9k/some-set.html') + '"')
    expect(root).toContain('href="https://open.spotify.com/track/abc"')
    expect(get('pc-body').innerHTML).toContain('YouTube link found')
    expect(get('pv-checks-card').hidden).toBe(false)
  })

  it('recheck, delete (after a confirm) and ban the upload source post to their endpoints', async () => {
    const { get, calls, location } = page(PRESAVE_PAGE.html, '?id=7', (url, method) => {
      if (url.includes('/checks')) return table([])
      if (url.endsWith('/recheck')) return { presave: presave(), check: { result: 'no_youtube', linkCount: 2, linkSources: [] } }
      if (method === 'DELETE') return { deleted: true }
      if (url.endsWith('/ban-link')) return { banned: true, url: 'https://api.soundcloud.com/tracks/42', affected: [3], requeued: [], next: { queued: false, reason: 'no_source' } }
      return { presave: presave(), upload: upload() }
    })
    await settle()
    const root = get('pv-root')
    expect(root.innerHTML).toContain('Ban this source URL')
    await root.on.click(ev(target({ 'data-do': 'recheck' })))
    await settle()
    expect(posts(calls)).toMatchObject([{ url: '/ui/api/presaves/7/recheck', method: 'POST' }])

    // Delete: cancel sends nothing, yes sends DELETE and goes back to the list.
    let p = root.on.click(ev(target({ 'data-do': 'delete' })))
    await settle()
    expect(get('tk-confirm').open).toBe(true)
    get('tk-confirm-no').onclick()
    await p
    expect(posts(calls).length).toBe(1)
    p = root.on.click(ev(target({ 'data-do': 'delete' })))
    await settle()
    get('tk-confirm-yes').onclick()
    await p
    await settle()
    expect(posts(calls)[1]).toMatchObject({ url: '/ui/api/presaves/7', method: 'DELETE' })
    expect(location.href).toBe('/ui/presaves')

    p = root.on.click(ev(target({ 'data-do': 'banlink' })))
    await settle()
    get('tk-confirm-yes').onclick()
    await p
    await settle()
    expect(posts(calls)[2]).toMatchObject({ url: '/ui/api/track-uploads/3/ban-link', method: 'POST' })
  })
})

describe('Track uploads page', () => {
  const answer = (url: string, method: string) => {
    if (url === '/ui/api/track-uploads/playlist') return { playlistId: 'PL1', title: 'Track uploads', url: 'https://www.youtube.com/playlist?list=PL1' }
    if (url.startsWith('/ui/api/track-uploads/bans?')) return table([{ url: 'https://soundcloud.com/a/b', sourceName: 'soundcloud', reason: 'preview', uploadId: 2, presaveId: 7, bannedAt: NOW }])
    if (url.startsWith('/ui/api/track-uploads?')) return table([upload()], { counts: { pending: 0, claimed: 0, done: 4, failed: 1, banned: 0, superseded: 0 }, today: { claims: 2, cap: 4 } })
    if (url.endsWith('/ban-link')) return { banned: true, url: 'https://api.soundcloud.com/tracks/42', affected: [3], requeued: [], next: { queued: true, reason: 'queued', sourceName: 'bandcamp', sourceUrl: 'https://x.bandcamp.com/track/y' } }
    if (method === 'POST') return { ok: true, unbanned: true, banned: true, url: 'https://soundcloud.com/c/d', affected: [], requeued: [] }
    return {}
  }

  it('loads the uploads table, the playlist and today\'s claims', async () => {
    const { get, calls } = page(TRACK_UPLOADS_PAGE.html, '', answer)
    await settle()
    expect(gets(calls)).toEqual(expect.arrayContaining(['/ui/api/track-uploads/playlist', '/ui/api/track-uploads?page=1&size=50&sort=-createdAt']))
    expect(gets(calls).some((u) => u.includes('/bans'))).toBe(false)
    const head = get('tu-sum').innerHTML
    expect(head).toContain('2 / 4')
    expect(head).toContain('href="https://www.youtube.com/playlist?list=PL1"')
    expect(head).toContain('href="/ui/settings#sf-track-uploads"')
    const body = get('tu-body').innerHTML
    expect(body).toContain('href="/ui/presave?id=7"')
    expect(body).toContain('Failed')
    expect(body).toContain('data-act="retry"')
    expect(body).toContain('data-act="ban"')
    expect(get('tu-chips').innerHTML).toMatch(/Uploaded[\s\S]*>4</)
  })

  it('Retry posts retry; Ban link asks, then posts ban-link', async () => {
    const { get, calls } = page(TRACK_UPLOADS_PAGE.html, '', answer)
    await settle()
    const host = get('tu-table')
    await host.on.click(actOn('retry'))
    await settle()
    expect(posts(calls)).toMatchObject([{ url: '/ui/api/track-uploads/3/retry', method: 'POST' }])
    const p = host.on.click(actOn('ban'))
    await settle()
    expect(get('tk-confirm').open).toBe(true)
    get('tk-confirm-yes').onclick()
    await p
    await settle()
    expect(posts(calls)[1]).toMatchObject({ url: '/ui/api/track-uploads/3/ban-link', body: {} })
  })

  it('the Banned links tab loads its table, unbans, and the form bans a URL', async () => {
    const { get, calls } = page(TRACK_UPLOADS_PAGE.html, '', answer)
    await settle()
    get('tu-tabs').on.click(ev(target({ 'data-tab': 'bans' })))
    await settle()
    expect(gets(calls)).toContain('/ui/api/track-uploads/bans?page=1&size=50&sort=-bannedAt')
    expect(get('tu-p-bans').hidden).toBe(false)
    expect(get('tu-p-up').hidden).toBe(true)
    expect(get('tb-body').innerHTML).toContain('href="https://soundcloud.com/a/b"')
    await get('tb-table').on.click(actOn('unban'))
    await settle()
    expect(posts(calls)).toMatchObject([{ url: '/ui/api/track-uploads/bans/unban', body: { url: 'https://soundcloud.com/a/b' } }])
    get('tu-ban-url').value = 'https://soundcloud.com/c/d'
    get('tu-ban-why').value = 'wrong track'
    await get('tu-ban').on.submit({ preventDefault() {} })
    await settle()
    expect(posts(calls)[1]).toMatchObject({ url: '/ui/api/track-uploads/ban-url', body: { url: 'https://soundcloud.com/c/d', reason: 'wrong track' } })
  })
})
