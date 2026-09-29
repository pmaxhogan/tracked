import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { vi, beforeEach } from 'vitest'
import { crawlDjIndex, djScrollStep, parseDjIndex, parseSetYouTubeId } from '../src/lib/dj-index'

// crawlDjIndex fetches page 1 and every /ajax/get_data.php scroll step
// through the pool (lib/upstream1001.ts -> lib/pool.ts). A fake pool
// (injected fetcher) dispatches page reads to `fh` and the XHR POSTs to `fwt`,
// so each test scripts the site's answers.
const fh = vi.fn()
const fwt = vi.fn()
const poolRequests: Array<Record<string, any>> = []
const poolJson = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
const poolFetcher = (async (_u: string, init: RequestInit) => {
  const req = JSON.parse(String(init.body))
  poolRequests.push(req)
  const meta = { finalUrl: req.url, accountId: 'acct-1', exitLabel: 'exit-a', fetchedAt: new Date().toISOString(), bytes: 1 }
  if (req.method === 'POST') {
    let res: Response
    try {
      res = await fwt(req.url, { method: 'POST', body: new URLSearchParams(req.form) })
    } catch {
      return poolJson({ error: 'timeout', retryAfterSeconds: null })
    }
    return poolJson({ status: res.status, html: await res.text(), ...meta })
  }
  const r = await fh(req.url)
  return poolJson({ status: 200, html: r.html, ...meta })
}) as unknown as typeof fetch
const pool = { url: 'https://pool.test', token: 't', fetchImpl: poolFetcher }

const ORIGIN = 'https://www.1001tracklists.com'

describe('parseDjIndex', () => {
  it('extracts artistName from the H1 and tracklist URLs from anchor hrefs', () => {
    const html = `<!doctype html><html><body>
      <h1 class="titleNameH1">Lilly Palmer</h1>
      <a href="/dj/lillypalmer/index.html">profile</a>
      <a href="/tracklist/abc123/lilly-palmer-set-one-2025-01-01.html">set 1</a>
      <a href="/tracklist/def456/lilly-palmer-set-two-2024-12-25.html">set 2</a>
      <a href="/tracklist/abc123/lilly-palmer-set-one-2025-01-01.html">duplicate</a>
      <a href="/genre/techno">unrelated</a>
    </body></html>`
    const r = parseDjIndex(html)
    expect(r.artistName).toBe('Lilly Palmer')
    expect(r.tracklistUrls).toEqual([
      `${ORIGIN}/tracklist/abc123/lilly-palmer-set-one-2025-01-01.html`,
      `${ORIGIN}/tracklist/def456/lilly-palmer-set-two-2024-12-25.html`,
    ])
  })

  it('falls back to any <h1> when titleNameH1 is missing', () => {
    const html = `<h1>Charlotte de Witte</h1><a href="/tracklist/x/y.html">a</a>`
    expect(parseDjIndex(html).artistName).toBe('Charlotte de Witte')
  })

  it('returns null artistName when no H1 is present', () => {
    expect(parseDjIndex('<html><body><p>x</p></body></html>').artistName).toBeNull()
  })

  it('decodes HTML entities in the artist name', () => {
    expect(parseDjIndex('<h1>Boys Noize &amp; Friends</h1>').artistName).toBe('Boys Noize & Friends')
  })

  it('strips the " Tracklists Overview" suffix that 1001tl appends on DJ listing pages', () => {
    expect(parseDjIndex('<h1 class="titleNameH1">Lilly Palmer Tracklists Overview</h1>').artistName).toBe('Lilly Palmer')
    // Mixed case + extra whitespace.
    expect(parseDjIndex('<h1>Charlotte de Witte  tracklists overview </h1>').artistName).toBe('Charlotte de Witte')
    // No suffix → name passes through unchanged.
    expect(parseDjIndex('<h1>Charlotte de Witte</h1>').artistName).toBe('Charlotte de Witte')
  })

  it('preserves first-occurrence order across duplicate hrefs', () => {
    const html = [
      '<a href="/tracklist/aaa/one.html">',
      '<a href="/tracklist/bbb/two.html">',
      '<a href="/tracklist/aaa/one.html">',
      '<a href="/tracklist/ccc/three.html">',
    ].join('')
    expect(parseDjIndex(html).tracklistUrls).toEqual([
      `${ORIGIN}/tracklist/aaa/one.html`,
      `${ORIGIN}/tracklist/bbb/two.html`,
      `${ORIGIN}/tracklist/ccc/three.html`,
    ])
  })

  it('ignores tracklist URLs that contain a query/fragment marker before .html', () => {
    // The regex requires .html immediately before the closing quote — drops
    // anything with ?foo= or #x in between (typically pagination/UI links).
    const html = `<a href="/tracklist/abc/one.html?from=dj">x</a><a href="/tracklist/def/two.html">y</a>`
    expect(parseDjIndex(html).tracklistUrls).toEqual([`${ORIGIN}/tracklist/def/two.html`])
  })

  it('returns an empty list on a page with no tracklist links', () => {
    expect(parseDjIndex('<html><body><h1>Empty DJ</h1></body></html>').tracklistUrls).toEqual([])
  })
})

describe('parseSetYouTubeId', () => {
  it('extracts the video id from a youtube.com/embed iframe URL', () => {
    const html = `<iframe src="https://www.youtube.com/embed/79n8BaQAL2Q?autoplay=0">`
    expect(parseSetYouTubeId(html)).toBe('79n8BaQAL2Q')
  })

  it('falls back to a watch URL when no embed is present', () => {
    const html = `<meta property="og:video:url" content="https://www.youtube.com/watch?v=dQw4w9WgXcQ">`
    expect(parseSetYouTubeId(html)).toBe('dQw4w9WgXcQ')
  })

  it('falls back to a youtu.be short link', () => {
    const html = `<a href="https://youtu.be/aBcDeFgHiJk">share</a>`
    expect(parseSetYouTubeId(html)).toBe('aBcDeFgHiJk')
  })

  it('returns null when no YouTube reference appears', () => {
    expect(parseSetYouTubeId('<p>tracklist with no embed</p>')).toBeNull()
  })

  it('does not match YouTube channel URLs (different shape)', () => {
    expect(parseSetYouTubeId('<a href="https://youtube.com/channel/UCBIfsPaQviN1LpnkWQvAGMQ">x</a>')).toBeNull()
  })

  it('returns the *first* embed when several exist (primary set video lives near the top)', () => {
    const html = `<iframe src="https://youtube.com/embed/firstSetVid"></iframe>
      <iframe src="https://youtube.com/embed/secondClip0"></iframe>`
    // Both ids are 11 chars so both pass the regex; the first one wins.
    expect(parseSetYouTubeId(html)).toBe('firstSetVid')
  })

  it('successfully extracts from a real 1001tracklists tracklist fixture', () => {
    const html = readFileSync(resolve(__dirname, 'fixtures/tracklist-matroda.html'), 'utf-8')
    // tracklist-matroda was archived with `youtube.com/embed/79n8BaQAL2Q` as
    // the player iframe — that's the set's main video id.
    expect(parseSetYouTubeId(html)).toBe('79n8BaQAL2Q')
  })

  it('matches the youtube-nocookie embed form', () => {
    expect(parseSetYouTubeId('<iframe src="https://www.youtube-nocookie.com/embed/abcDEFghi12">')).toBe('abcDEFghi12')
  })

  it('matches a data-yt-id attribute when the iframe is lazy-loaded', () => {
    expect(parseSetYouTubeId('<div class="player" data-yt-id="dQw4w9WgXcQ"></div>')).toBe('dQw4w9WgXcQ')
  })

  it('matches a videoId JS-variable initializer', () => {
    expect(parseSetYouTubeId('<script>var videoId = "tf42CVmF6V0"; setupPlayer();</script>')).toBe('tf42CVmF6V0')
  })
})

describe('crawlDjIndex against real 1001tracklists captures (2026-09-28)', () => {
  // Page 1 of /dj/adam-beyer/ and the first infinite-scroll answer for it, as
  // served on 2026-09-28 (the logged-in username in the page header is
  // scrubbed to acct2-user). Sometime between 2026-07-08 and 2026-07-28 the
  // site dropped `iScrollParams.dj` from the page; the scroll list is now a
  // `div.sDiv#sDivTracklists[data-type][data-id]` and framework.js posts
  // type/idScrollObject/subtype/count/pos/id. Against the old parser every
  // DJ stopped at the 15 sets page 1 renders (stopReason `no_pagination`).
  const page1 = readFileSync(resolve(__dirname, 'fixtures/dj-adam-beyer-page1.html'), 'utf-8')
  const ajax1 = readFileSync(resolve(__dirname, 'fixtures/dj-adam-beyer-ajax-pos15.json'), 'utf-8')

  it('follows the infinite scroll past the 15 sets on page 1', async () => {
    fh.mockReset()
    fwt.mockReset()
    fh.mockResolvedValueOnce({ html: page1, state: { cookie: '' } })
    fwt.mockResolvedValueOnce(new Response(ajax1, { status: 200, headers: { 'Content-Type': 'application/json' } }))
    fwt.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, end: true, data: '' }), { status: 200 }))

    const r = await crawlDjIndex('adam-beyer', { pool, maxPages: 5 })

    expect(r.artistName).toBe('Adam Beyer')
    expect(r.tracklistUrls).toHaveLength(25)
    expect(r.tracklistUrls[0]).toBe(
      `${ORIGIN}/tracklist/28bww6l1/adam-beyer-drumcode-radio-843-resistance-amnesia-ibiza-spain-2026-09-16-2026-09-25.html`,
    )
    expect(r.tracklistUrls[15]).toContain('/tracklist/2kmzbyst/')
    expect(r.tracklistUrls[24]).toContain('/tracklist/wjqu951/')
    expect(r.stopReason).toBe('end')
    // The request framework.js builds for the first scroll step.
    const body1 = new URLSearchParams((fwt.mock.calls[0]![1]!.body as URLSearchParams).toString())
    expect(Object.fromEntries(body1)).toEqual({
      width: '1920',
      type: 'artist',
      idScrollObject: 'q43lgd',
      subtype: 'tracklists',
      count: '10',
      pos: '15',
      id: 'hj0myf1',
    })
    // Second step continues from the last row of the first answer.
    const body2 = new URLSearchParams((fwt.mock.calls[1]![1]!.body as URLSearchParams).toString())
    expect(body2.get('pos')).toBe('25')
    expect(body2.get('id')).toBe('wjqu951')
  })

  it('spends no scroll request when page 1 already shows a known set (the daily steady state)', async () => {
    fh.mockReset()
    fwt.mockReset()
    fh.mockResolvedValueOnce({ html: page1, state: { cookie: '' } })
    const known = new Set([`${ORIGIN}/tracklist/18pcnb11/adam-beyer-drumcode-radio-837-2026-08-14.html`])

    const r = await crawlDjIndex('adam-beyer', { pool, maxPages: 5, knownUrls: known })

    expect(fwt).not.toHaveBeenCalled()
    expect(r.stopReason).toBe('known')
    expect(r.tracklistUrls).toHaveLength(15)
    expect(r.tail).toEqual({ pos: 15, id: 'hj0myf1' })
  })

  it('stops the head walk at the first scroll step that reaches a known set', async () => {
    fh.mockReset()
    fwt.mockReset()
    fh.mockResolvedValueOnce({ html: page1, state: { cookie: '' } })
    fwt.mockResolvedValueOnce(new Response(ajax1, { status: 200 }))
    const known = new Set([
      `${ORIGIN}/tracklist/wjqu951/adam-beyer-drumcode-radio-807-2026-01-16.html`,
    ])

    const r = await crawlDjIndex('adam-beyer', { pool, maxPages: 5, knownUrls: known })

    expect(fwt).toHaveBeenCalledTimes(1)
    expect(r.stopReason).toBe('known')
    expect(r.tracklistUrls).toHaveLength(25)
    expect(r.tail).toEqual({ pos: 25, id: 'wjqu951' })
  })

  it('backfills a bounded number of steps from a stored cursor and reports where to resume', async () => {
    fh.mockReset()
    fwt.mockReset()
    fh.mockResolvedValueOnce({ html: page1, state: { cookie: '' } })
    // Head walk: page 1 is all known → no head step. Backfill: 1 step allowed.
    fwt.mockResolvedValueOnce(new Response(ajax1, { status: 200 }))
    const known = new Set(parseDjIndex(page1).tracklistUrls)

    const r = await crawlDjIndex('adam-beyer', {
      pool,
      knownUrls: known,
      backfill: { from: { pos: 15, id: 'hj0myf1' }, maxSteps: 1 },
    })

    expect(fwt).toHaveBeenCalledTimes(1)
    const body = new URLSearchParams((fwt.mock.calls[0]![1]!.body as URLSearchParams).toString())
    expect(body.get('pos')).toBe('15')
    expect(body.get('id')).toBe('hj0myf1')
    expect(r.backfill).toEqual({ steps: 1, added: 10, cursor: { pos: 25, id: 'wjqu951' }, done: false })
    expect(r.tracklistUrls).toHaveLength(25)
  })

  it('marks the backfill done at the end of the list, and keeps the cursor when a step fails', async () => {
    const known = new Set(parseDjIndex(page1).tracklistUrls)

    fh.mockReset()
    fwt.mockReset()
    fh.mockResolvedValueOnce({ html: page1, state: { cookie: '' } })
    fwt.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, end: true, data: '' }), { status: 200 }))
    const done = await crawlDjIndex('adam-beyer', { pool, knownUrls: known, backfill: { from: { pos: 905, id: 'zzz' }, maxSteps: 3 } })
    expect(done.backfill).toEqual({ steps: 1, added: 0, cursor: null, done: true })

    fh.mockReset()
    fwt.mockReset()
    fh.mockResolvedValueOnce({ html: page1, state: { cookie: '' } })
    fwt.mockResolvedValueOnce(new Response('<html>captcha</html>', { status: 401 }))
    const failed = await crawlDjIndex('adam-beyer', { pool, knownUrls: known, backfill: { from: { pos: 45, id: 'abc' }, maxSteps: 3 } })
    expect(failed.backfill).toEqual({ steps: 0, added: 0, cursor: { pos: 45, id: 'abc' }, done: false })
  })
})

describe('crawlDjIndex', () => {
  /**
   * Build a page-1 HTML in the post-July-2026 markup: an H1, and the
   * `div.sDiv#sDivTracklists[data-type][data-id]` scroll list holding .oItm
   * rows (each with a data-id and an inner anchor to a tracklist URL).
   * Without the scroll div and rows, crawlDjIndex degrades to no_pagination.
   */
  function page1Html(opts: {
    artist?: string
    djId?: string
    items: Array<{ dataId: string; href: string }>
  }): string {
    const items = opts.items
      .map(
        (it) =>
          `<div class="bItm action oItm" data-id="${it.dataId}"><a href="${it.href}">x</a></div>`,
      )
      .join('')
    return `<h1 id="pageTitle">Tracklists By ${opts.artist ?? 'Test'}</h1><div class="sDiv " id="sDivTracklists" data-type="artist" data-title="Tracklists By" data-id="${opts.djId ?? 'abc123'}">${items}</div>`
  }

  function ajaxResponse(body: object): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  it('fetches page 1 and drives /ajax/get_data.php for subsequent pages until end:true', async () => {
    fh.mockReset()
    fwt.mockReset()
    fh.mockResolvedValueOnce({
      html: page1Html({
        artist: 'Lilly Palmer',
        djId: '80q82k2',
        items: [
          { dataId: 'd1', href: '/tracklist/a/one.html' },
          { dataId: 'd2', href: '/tracklist/b/two.html' },
        ],
      }),
      state: { cookie: '' },
    })
    // First AJAX page: 2 new
    fwt.mockResolvedValueOnce(
      ajaxResponse({
        success: true,
        data: '<div class="oItm" data-id="d3"><a href="/tracklist/c/three.html">x</a></div><div class="oItm" data-id="d4"><a href="/tracklist/d/four.html">x</a></div>',
      }),
    )
    // Second AJAX page: 1 new + end
    fwt.mockResolvedValueOnce(
      ajaxResponse({
        success: true,
        end: true,
        data: '<div class="oItm" data-id="d5"><a href="/tracklist/e/five.html">x</a></div>',
      }),
    )

    const r = await crawlDjIndex('lillypalmer', { pool })
    expect(r.artistName).toBe('Lilly Palmer')
    expect(r.tracklistUrls).toEqual([
      'https://www.1001tracklists.com/tracklist/a/one.html',
      'https://www.1001tracklists.com/tracklist/b/two.html',
      'https://www.1001tracklists.com/tracklist/c/three.html',
      'https://www.1001tracklists.com/tracklist/d/four.html',
      'https://www.1001tracklists.com/tracklist/e/five.html',
    ])
    expect(r.pagesWalked).toBe(3)
    expect(r.stopReason).toBe('end')
    // Verify the AJAX call shape: form-encoded POST with the correct cursor params.
    const ajaxCalls = fwt.mock.calls
    expect(ajaxCalls[0]![0]).toBe('https://www.1001tracklists.com/ajax/get_data.php')
    const init1 = ajaxCalls[0]![1]!
    expect(init1.method).toBe('POST')
    const body1 = (init1.body as URLSearchParams).toString()
    expect(body1).toContain('type=artist')
    expect(body1).toContain('idScrollObject=80q82k2')
    expect(body1).toContain('subtype=tracklists')
    expect(body1).toContain('pos=2') // 2 items shown after page 1
    expect(body1).toContain('id=d2') // last data-id from page 1
    // Second AJAX call's cursor advances using the previous chunk's data.
    const body2 = (ajaxCalls[1]![1]!.body as URLSearchParams).toString()
    expect(body2).toContain('pos=4') // 2 + 2 items shown
    expect(body2).toContain('id=d4') // last data-id from chunk 1
  })

  it('degrades to no_pagination when page 1 lacks pagination keys', async () => {
    fh.mockReset()
    // No scroll div and no .oItm data-ids → can't paginate.
    fh.mockResolvedValueOnce({
      html: '<h1>Test</h1><a href="/tracklist/x/y.html">x</a>',
      state: { cookie: '' },
    })

    const r = await crawlDjIndex('x', { pool })
    expect(r.tracklistUrls).toEqual(['https://www.1001tracklists.com/tracklist/x/y.html'])
    expect(r.pagesWalked).toBe(1)
    expect(r.stopReason).toBe('no_pagination')
  })

  it('stops with no_new when an AJAX chunk introduces only already-seen URLs', async () => {
    fh.mockReset()
    fwt.mockReset()
    fh.mockResolvedValueOnce({
      html: page1Html({ djId: 'd', items: [{ dataId: 'd1', href: '/tracklist/a/one.html' }] }),
      state: { cookie: '' },
    })
    fwt.mockResolvedValueOnce(
      ajaxResponse({
        success: true,
        // Same URL we already saw on page 1 → added=0 → no_new.
        data: '<div class="oItm" data-id="d1"><a href="/tracklist/a/one.html">x</a></div>',
      }),
    )

    const r = await crawlDjIndex('x', { pool })
    expect(r.tracklistUrls).toEqual(['https://www.1001tracklists.com/tracklist/a/one.html'])
    expect(r.stopReason).toBe('no_new')
  })

  it('respects maxPages and reports max_pages stopReason', async () => {
    fh.mockReset()
    fwt.mockReset()
    fh.mockResolvedValueOnce({
      html: page1Html({ djId: 'd', items: [{ dataId: 'd1', href: '/tracklist/1/x.html' }] }),
      state: { cookie: '' },
    })
    // Each AJAX call introduces a new URL so neither end nor no_new fires.
    let n = 1
    fwt.mockImplementation(async () =>
      ajaxResponse({
        success: true,
        data: `<div class="oItm" data-id="d${++n}"><a href="/tracklist/${n}/x.html">x</a></div>`,
      }),
    )

    const r = await crawlDjIndex('x', { pool, maxPages: 3 })
    expect(r.pagesWalked).toBe(3)
    expect(r.stopReason).toBe('max_pages')
  })

  it('honors deadlineMs and reports deadline stopReason', async () => {
    fh.mockReset()
    fwt.mockReset()
    fh.mockResolvedValueOnce({
      html: page1Html({ djId: 'd', items: [{ dataId: 'd1', href: '/tracklist/a/x.html' }] }),
      state: { cookie: '' },
    })
    // Deadline already in the past → loop never enters the AJAX phase.
    const r = await crawlDjIndex('x', { pool, deadlineMs: Date.now() - 1, maxPages: 5 })
    expect(r.pagesWalked).toBe(1) // page 1 still happened
    expect(r.stopReason).toBe('deadline')
    expect(fwt).not.toHaveBeenCalled()
  })

  it('treats an AJAX failure as fetch_failed and keeps prior pages', async () => {
    fh.mockReset()
    fwt.mockReset()
    fh.mockResolvedValueOnce({
      html: page1Html({ djId: 'd', items: [{ dataId: 'd1', href: '/tracklist/a/x.html' }] }),
      state: { cookie: '' },
    })
    fwt.mockRejectedValueOnce(new Error('AJAX upstream timeout'))
    const r = await crawlDjIndex('x', { pool })
    expect(r.tracklistUrls).toEqual(['https://www.1001tracklists.com/tracklist/a/x.html'])
    expect(r.stopReason).toBe('fetch_failed')
  })
})

describe('DJ listing requests go through the pool', () => {
  const page1 = readFileSync(resolve(__dirname, 'fixtures/dj-adam-beyer-page1.html'), 'utf-8')
  const ajax1 = readFileSync(resolve(__dirname, 'fixtures/dj-adam-beyer-ajax-pos15.json'), 'utf-8')
  beforeEach(() => {
    fh.mockReset()
    fwt.mockReset()
    poolRequests.length = 0
  })

  it('page 1 and the head walk are kind dj at the caller priority; the older-sets POST carries its form and XHR headers', async () => {
    fh.mockResolvedValueOnce({ html: page1 })
    fwt.mockResolvedValueOnce(new Response(ajax1, { status: 200 }))
    fwt.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, end: true, data: '' }), { status: 200 }))
    await crawlDjIndex('adam-beyer', { pool, priority: 'new', maxPages: 5 })
    expect(poolRequests.map((r) => [r.kind, r.priority, r.method ?? 'GET'])).toEqual([
      ['dj', 'new', 'GET'],
      ['dj', 'new', 'POST'],
      ['dj', 'new', 'POST'],
    ])
    expect(poolRequests[1]!.url).toBe('https://www.1001tracklists.com/ajax/get_data.php')
    expect(poolRequests[1]!.form).toMatchObject({ type: 'artist', idScrollObject: 'q43lgd', pos: '15', id: 'hj0myf1' })
    expect(poolRequests[1]!.headers).toMatchObject({ 'X-Requested-With': 'XMLHttpRequest', Referer: 'https://www.1001tracklists.com/dj/adam-beyer/index.html' })
  })

  it('backfill steps inside a crawl are priority backfill', async () => {
    fh.mockResolvedValueOnce({ html: page1 })
    fwt.mockResolvedValueOnce(new Response(ajax1, { status: 200 }))
    const known = new Set(parseDjIndex(page1).tracklistUrls)
    const r = await crawlDjIndex('adam-beyer', { pool, priority: 'new', knownUrls: known, backfill: { from: { pos: 15, id: 'hj0myf1' }, maxSteps: 1 } })
    expect(poolRequests.map((x) => x.priority)).toEqual(['new', 'backfill'])
    expect(r.keys).toEqual({ type: 'artist', idScrollObject: 'q43lgd', subtype: 'tracklists' })
  })

  it('djScrollStep: one step from stored keys, no page-1 fetch', async () => {
    fwt.mockResolvedValueOnce(new Response(ajax1, { status: 200 }))
    const s = await djScrollStep('adam-beyer', { type: 'artist', idScrollObject: 'q43lgd', subtype: 'tracklists' }, { pos: 15, id: 'hj0myf1' }, { pool, priority: 'backfill' })
    expect(fh).not.toHaveBeenCalled()
    expect(poolRequests).toHaveLength(1)
    expect(poolRequests[0]!.priority).toBe('backfill')
    expect(s!.urls).toHaveLength(10)
    expect(s!.next).toEqual({ pos: 25, id: 'wjqu951' })
    expect(s!.end).toBe(false)
  })

  it('djScrollStep: a captcha-flagged answer is a soft failure (null); a pool refusal throws', async () => {
    fwt.mockResolvedValueOnce(new Response(JSON.stringify({ captcha: true }), { status: 200 }))
    expect(await djScrollStep('x', { type: 'artist', idScrollObject: 'q', subtype: 'tracklists' }, { pos: 15, id: 'a' }, { pool })).toBeNull()
    const refusing = { ...pool, fetchImpl: (async () => poolJson({ error: 'budget_exhausted', retryAfterSeconds: 600 })) as unknown as typeof fetch }
    await expect(djScrollStep('x', { type: 'artist', idScrollObject: 'q', subtype: 'tracklists' }, { pos: 15, id: 'a' }, { pool: refusing })).rejects.toMatchObject({ name: 'PoolPausedError', code: 'budget_exhausted', retryAfterSeconds: 600 })
  })
})
