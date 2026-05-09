import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { vi } from 'vitest'
import { crawlDjIndex, parseDjIndex, parseSetYouTubeId } from '../src/lib/dj-index'

// crawlDjIndex internally fetches page 1 via fetch1001Html (home-proxy /
// unlocker / direct cascade) and then drives /ajax/get_data.php via direct
// POST. We stub both for unit tests.
vi.mock('../src/lib/fetch', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/fetch')>('../src/lib/fetch')
  return { ...actual, fetchHtml: vi.fn(), fetchWithTimeout: vi.fn() }
})
vi.mock('../src/lib/unlocker', () => ({ fetchViaUnlocker: vi.fn() }))
vi.mock('../src/lib/homeProxy', () => ({ fetchViaHomeProxy: vi.fn() }))

import { fetchHtml, fetchWithTimeout } from '../src/lib/fetch'

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

describe('crawlDjIndex', () => {
  /**
   * Build a page-1 HTML containing the necessary pagination keys: an H1, a
   * set of .oItm rows (each with a data-id and an inner anchor to a tracklist
   * URL), and the inline `iScrollParams.dj = '...'` script. Without all
   * three, crawlDjIndex degrades to no_pagination.
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
    return `<h1 class="titleNameH1">${opts.artist ?? 'Test'}</h1>${items}<script>iScrollParams.dj = '${opts.djId ?? 'abc123'}';</script>`
  }

  function ajaxResponse(body: object): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  it('fetches page 1 and drives /ajax/get_data.php for subsequent pages until end:true', async () => {
    const fh = fetchHtml as unknown as ReturnType<typeof vi.fn>
    const fwt = fetchWithTimeout as unknown as ReturnType<typeof vi.fn>
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

    const r = await crawlDjIndex('lillypalmer')
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
    expect(body1).toContain('type=overview')
    expect(body1).toContain('dj=80q82k2')
    expect(body1).toContain('pos=2') // 2 items shown after page 1
    expect(body1).toContain('id=d2') // last data-id from page 1
    // Second AJAX call's cursor advances using the previous chunk's data.
    const body2 = (ajaxCalls[1]![1]!.body as URLSearchParams).toString()
    expect(body2).toContain('pos=4') // 2 + 2 items shown
    expect(body2).toContain('id=d4') // last data-id from chunk 1
  })

  it('degrades to no_pagination when page 1 lacks pagination keys', async () => {
    const fh = fetchHtml as unknown as ReturnType<typeof vi.fn>
    fh.mockReset()
    // No iScrollParams script and no .oItm data-ids → can't paginate.
    fh.mockResolvedValueOnce({
      html: '<h1>Test</h1><a href="/tracklist/x/y.html">x</a>',
      state: { cookie: '' },
    })

    const r = await crawlDjIndex('x')
    expect(r.tracklistUrls).toEqual(['https://www.1001tracklists.com/tracklist/x/y.html'])
    expect(r.pagesWalked).toBe(1)
    expect(r.stopReason).toBe('no_pagination')
  })

  it('stops with no_new when an AJAX chunk introduces only already-seen URLs', async () => {
    const fh = fetchHtml as unknown as ReturnType<typeof vi.fn>
    const fwt = fetchWithTimeout as unknown as ReturnType<typeof vi.fn>
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

    const r = await crawlDjIndex('x')
    expect(r.tracklistUrls).toEqual(['https://www.1001tracklists.com/tracklist/a/one.html'])
    expect(r.stopReason).toBe('no_new')
  })

  it('respects maxPages and reports max_pages stopReason', async () => {
    const fh = fetchHtml as unknown as ReturnType<typeof vi.fn>
    const fwt = fetchWithTimeout as unknown as ReturnType<typeof vi.fn>
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

    const r = await crawlDjIndex('x', { maxPages: 3 })
    expect(r.pagesWalked).toBe(3)
    expect(r.stopReason).toBe('max_pages')
  })

  it('honors deadlineMs and reports deadline stopReason', async () => {
    const fh = fetchHtml as unknown as ReturnType<typeof vi.fn>
    const fwt = fetchWithTimeout as unknown as ReturnType<typeof vi.fn>
    fh.mockReset()
    fwt.mockReset()
    fh.mockResolvedValueOnce({
      html: page1Html({ djId: 'd', items: [{ dataId: 'd1', href: '/tracklist/a/x.html' }] }),
      state: { cookie: '' },
    })
    // Deadline already in the past → loop never enters the AJAX phase.
    const r = await crawlDjIndex('x', { deadlineMs: Date.now() - 1, maxPages: 5 })
    expect(r.pagesWalked).toBe(1) // page 1 still happened
    expect(r.stopReason).toBe('deadline')
    expect(fwt).not.toHaveBeenCalled()
  })

  it('treats an AJAX failure as fetch_failed and keeps prior pages', async () => {
    const fh = fetchHtml as unknown as ReturnType<typeof vi.fn>
    const fwt = fetchWithTimeout as unknown as ReturnType<typeof vi.fn>
    fh.mockReset()
    fwt.mockReset()
    fh.mockResolvedValueOnce({
      html: page1Html({ djId: 'd', items: [{ dataId: 'd1', href: '/tracklist/a/x.html' }] }),
      state: { cookie: '' },
    })
    fwt.mockRejectedValueOnce(new Error('AJAX upstream timeout'))
    const r = await crawlDjIndex('x')
    expect(r.tracklistUrls).toEqual(['https://www.1001tracklists.com/tracklist/a/x.html'])
    expect(r.stopReason).toBe('fetch_failed')
  })
})
