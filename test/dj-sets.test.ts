import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../src/types'
import { getDjSets, setMetaFromUrl } from '../src/lib/dj-sets'
import { makeLogger } from '../src/lib/log'

vi.mock('../src/lib/dj-index', () => ({ crawlDjIndex: vi.fn() }))
import { crawlDjIndex } from '../src/lib/dj-index'

const ORIGIN = 'https://www.1001tracklists.com'

function fakeKV(): KVNamespace {
  const store = new Map<string, string>()
  return {
    async get(key: string, type?: 'json' | 'text') {
      const v = store.get(key)
      if (v === undefined) return null
      return type === 'json' ? JSON.parse(v) : v
    },
    async put(key: string, value: string) {
      store.set(key, value)
    },
    async delete(key: string) {
      store.delete(key)
    },
  } as unknown as KVNamespace
}

function makeEnv(): Env {
  return { CACHE: fakeKV(), SUBS: fakeKV(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k' } as Env
}

const log = makeLogger({ reqId: 'test', route: 'test' })

function mockCrawl(tracklistUrls: string[], artistName: string | null = 'Lilly Palmer') {
  ;(crawlDjIndex as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    artistName,
    tracklistUrls,
    pagesWalked: 1,
    stopReason: 'end',
  })
}

beforeEach(() => {
  ;(crawlDjIndex as unknown as ReturnType<typeof vi.fn>).mockReset()
})

describe('setMetaFromUrl', () => {
  it('extracts the tracklist slug, prettified title, and trailing date', () => {
    const m = setMetaFromUrl(`${ORIGIN}/tracklist/2mx9k7t1/lilly-palmer-tomorrowland-weekend-1-2024-07-21.html`)
    expect(m.tlSlug).toBe('2mx9k7t1')
    expect(m.title).toBe('Lilly Palmer Tomorrowland Weekend 1')
    expect(m.date).toBe('2024-07-21')
  })

  it('returns a null date when the slug has none, keeping the full title', () => {
    const m = setMetaFromUrl(`${ORIGIN}/tracklist/abc123/carl-cox-space-closing-fiesta.html`)
    expect(m.date).toBeNull()
    expect(m.title).toBe('Carl Cox Space Closing Fiesta')
  })

  it('rejects impossible month/day values instead of parsing them as a date', () => {
    const m = setMetaFromUrl(`${ORIGIN}/tracklist/x1/dj-essential-mix-2001-40-12.html`)
    expect(m.date).toBeNull()
    expect(m.title).toBe('DJ Essential Mix 2001 40 12')
  })

  it('uppercases short (≤2-char) words and capitalizes the rest', () => {
    const m = setMetaFromUrl(`${ORIGIN}/tracklist/x2/mc-goat-b2b-yolo-2025-01-01.html`)
    expect(m.title).toBe('MC Goat B2b Yolo')
  })

  it('degrades gracefully on a URL that is not a tracklist path', () => {
    const m = setMetaFromUrl('https://example.com/nope')
    expect(m.tlSlug).toBeNull()
    expect(m.title).toBe('https://example.com/nope')
    expect(m.date).toBeNull()
  })
})

describe('getDjSets', () => {
  const u1 = `${ORIGIN}/tracklist/a1/lilly-palmer-set-one-2025-01-01.html`
  const u2 = `${ORIGIN}/tracklist/b2/lilly-palmer-set-two-2024-12-25.html`
  const u3 = `${ORIGIN}/tracklist/c3/lilly-palmer-older-set-2023-06-06.html`

  it('crawls on a cold cache and returns crawl-ordered sets with metadata', async () => {
    const env = makeEnv()
    mockCrawl([u1, u2])
    const r = await getDjSets(env, 'lillypalmer', { log })
    expect(r.artistName).toBe('Lilly Palmer')
    expect(r.source).toBe('crawl')
    expect(r.sets.map((s) => s.url)).toEqual([u1, u2])
    expect(r.sets[0]).toMatchObject({ tlSlug: 'a1', date: '2025-01-01' })
  })

  it('serves the cached list on a second call without re-crawling', async () => {
    const env = makeEnv()
    mockCrawl([u1])
    await getDjSets(env, 'lillypalmer', { log })
    ;(crawlDjIndex as unknown as ReturnType<typeof vi.fn>).mockClear()
    const r = await getDjSets(env, 'lillypalmer', { log })
    expect(crawlDjIndex).not.toHaveBeenCalled()
    expect(r.sets.map((s) => s.url)).toEqual([u1])
  })

  it('refresh: true bypasses the cache and re-crawls', async () => {
    const env = makeEnv()
    mockCrawl([u1])
    await getDjSets(env, 'lillypalmer', { log })
    mockCrawl([u2, u1])
    const r = await getDjSets(env, 'lillypalmer', { refresh: true, log })
    expect(r.sets.map((s) => s.url)).toEqual([u2, u1])
  })

  it('merges sync-state URLs the crawl no longer surfaces, after crawl order', async () => {
    const env = makeEnv()
    await env.SUBS.put(
      'subs:state:lillypalmer',
      JSON.stringify({ processedTracklistUrls: [], discoveredTracklistUrls: [u2, u3] }),
    )
    mockCrawl([u1, u2])
    const r = await getDjSets(env, 'lillypalmer', { log })
    expect(r.sets.map((s) => s.url)).toEqual([u1, u2, u3])
    expect(r.source).toBe('crawl')
  })

  it('falls back to sync state when the crawl comes back empty', async () => {
    const env = makeEnv()
    await env.SUBS.put(
      'subs:state:lillypalmer',
      JSON.stringify({ processedTracklistUrls: [], discoveredTracklistUrls: [u1], artistName: 'Lilly Palmer' }),
    )
    ;(crawlDjIndex as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      artistName: null,
      tracklistUrls: [],
      pagesWalked: 0,
      stopReason: 'fetch_failed',
    })
    const r = await getDjSets(env, 'lillypalmer', { log })
    expect(r.source).toBe('state')
    expect(r.artistName).toBe('Lilly Palmer')
    expect(r.sets.map((s) => s.url)).toEqual([u1])
  })

  it('does not cache an empty result, so the next call retries the crawl', async () => {
    const env = makeEnv()
    ;(crawlDjIndex as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      artistName: null,
      tracklistUrls: [],
      pagesWalked: 0,
      stopReason: 'fetch_failed',
    })
    const r1 = await getDjSets(env, 'unknown', { log })
    expect(r1.sets).toEqual([])
    mockCrawl([u1], 'X')
    const r2 = await getDjSets(env, 'unknown', { log })
    expect(r2.sets.map((s) => s.url)).toEqual([u1])
  })
})
