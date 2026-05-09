import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { vi } from 'vitest'
import { crawlDjIndex, parseDjIndex, parseSetYouTubeId } from '../src/lib/dj-index'

// crawlDjIndex internally calls fetch1001Html, which goes through the home
// proxy / unlocker / direct cascade. For unit tests we stub it module-level.
vi.mock('../src/lib/fetch', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/fetch')>('../src/lib/fetch')
  return { ...actual, fetchHtml: vi.fn() }
})
vi.mock('../src/lib/unlocker', () => ({ fetchViaUnlocker: vi.fn() }))
vi.mock('../src/lib/homeProxy', () => ({ fetchViaHomeProxy: vi.fn() }))

import { fetchHtml } from '../src/lib/fetch'

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
  function htmlWith(urls: string[], h1 = 'Test DJ'): string {
    return `<h1>${h1}</h1>` + urls.map((u) => `<a href="${u.replace(/^https:\/\/www\.1001tracklists\.com/, '')}">x</a>`).join('')
  }

  it('walks pages until an empty page, accumulates URLs, captures artistName from page 1', async () => {
    const fh = fetchHtml as unknown as ReturnType<typeof vi.fn>
    fh.mockReset()
    fh.mockResolvedValueOnce({ html: htmlWith(['/tracklist/a/x.html', '/tracklist/b/y.html'], 'Lilly Palmer'), state: { cookie: '' } })
      .mockResolvedValueOnce({ html: htmlWith(['/tracklist/c/z.html'], 'Lilly Palmer'), state: { cookie: '' } })
      .mockResolvedValueOnce({ html: '<html><body>nothing</body></html>', state: { cookie: '' } })

    const r = await crawlDjIndex('lillypalmer')
    expect(r.artistName).toBe('Lilly Palmer')
    expect(r.tracklistUrls).toEqual([
      'https://www.1001tracklists.com/tracklist/a/x.html',
      'https://www.1001tracklists.com/tracklist/b/y.html',
      'https://www.1001tracklists.com/tracklist/c/z.html',
    ])
    expect(r.pagesWalked).toBe(3)
    expect(r.stopReason).toBe('empty')
    // Verify the URL pattern: page 1 → /index.html, page 2+ → /pageN.html.
    const urls = fh.mock.calls.map((c) => c[0])
    expect(urls).toEqual([
      'https://www.1001tracklists.com/dj/lillypalmer/index.html',
      'https://www.1001tracklists.com/dj/lillypalmer/page2.html',
      'https://www.1001tracklists.com/dj/lillypalmer/page3.html',
    ])
  })

  it('stops with no_new when an out-of-range page repeats already-seen URLs', async () => {
    const fh = fetchHtml as unknown as ReturnType<typeof vi.fn>
    fh.mockReset()
    fh.mockResolvedValueOnce({ html: htmlWith(['/tracklist/a/x.html']), state: { cookie: '' } })
      .mockResolvedValueOnce({ html: htmlWith(['/tracklist/a/x.html']), state: { cookie: '' } })

    const r = await crawlDjIndex('x')
    expect(r.tracklistUrls).toEqual(['https://www.1001tracklists.com/tracklist/a/x.html'])
    expect(r.stopReason).toBe('no_new')
  })

  it('respects maxPages and reports max_pages stopReason', async () => {
    const fh = fetchHtml as unknown as ReturnType<typeof vi.fn>
    fh.mockReset()
    // Each page contributes new URLs so neither empty nor no_new fires.
    fh.mockImplementation(async (url: string) => {
      const page = url.match(/page(\d+)\.html/)?.[1] ?? '1'
      return { html: htmlWith([`/tracklist/${page}/x.html`]), state: { cookie: '' } }
    })

    const r = await crawlDjIndex('x', { maxPages: 2 })
    expect(r.pagesWalked).toBe(2)
    expect(r.stopReason).toBe('max_pages')
  })

  it('respects deadlineMs and reports deadline stopReason', async () => {
    const fh = fetchHtml as unknown as ReturnType<typeof vi.fn>
    fh.mockReset()
    fh.mockResolvedValueOnce({ html: htmlWith(['/tracklist/a/x.html']), state: { cookie: '' } })
    // deadlineMs already in the past → loop never enters page 2.
    const r = await crawlDjIndex('x', { deadlineMs: Date.now() - 1, maxPages: 5 })
    expect(r.pagesWalked).toBe(0)
    expect(r.stopReason).toBe('deadline')
  })

  it('treats a per-page fetch failure as fetch_failed and keeps prior pages', async () => {
    const fh = fetchHtml as unknown as ReturnType<typeof vi.fn>
    fh.mockReset()
    fh.mockResolvedValueOnce({ html: htmlWith(['/tracklist/a/x.html']), state: { cookie: '' } }).mockRejectedValueOnce(
      new Error('CF shell on page 2'),
    )
    const r = await crawlDjIndex('x')
    expect(r.tracklistUrls).toEqual(['https://www.1001tracklists.com/tracklist/a/x.html'])
    expect(r.stopReason).toBe('fetch_failed')
  })
})
