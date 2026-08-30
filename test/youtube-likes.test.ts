import { describe, it, expect, vi } from 'vitest'
import { getRatings, rateVideo } from '../src/lib/youtube-likes'
import { YouTubeApiError } from '../src/lib/youtube-playlists'

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' }, ...init })
}

type Call = [string, RequestInit]
const calls = (f: unknown) => (f as { mock: { calls: Call[] } }).mock.calls

describe('rateVideo', () => {
  it('POSTs videos.rate with id + rating and the bearer token', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 })) as unknown as typeof fetch
    await rateVideo('79n8BaQAL2Q', 'like', 'tok', fetcher)
    const [url, init] = calls(fetcher)[0]!
    const u = new URL(url)
    expect(u.pathname).toBe('/youtube/v3/videos/rate')
    expect(u.searchParams.get('id')).toBe('79n8BaQAL2Q')
    expect(u.searchParams.get('rating')).toBe('like')
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tok')
  })

  it('sends rating=none to remove a like', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 })) as unknown as typeof fetch
    await rateVideo('79n8BaQAL2Q', 'none', 'tok', fetcher)
    expect(new URL(calls(fetcher)[0]![0]).searchParams.get('rating')).toBe('none')
  })

  it('throws YouTubeApiError with the API reason on failure', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { errors: [{ reason: 'videoNotFound' }] } }, { status: 404 })) as unknown as typeof fetch
    await expect(rateVideo('deadbeef000', 'like', 'tok', fetcher)).rejects.toMatchObject({
      name: 'YouTubeApiError',
      status: 404,
      reason: 'videoNotFound',
    } satisfies Partial<YouTubeApiError>)
  })
})

describe('getRatings', () => {
  it('returns a map of videoId → rating, deduping ids', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        items: [
          { videoId: 'a', rating: 'like' },
          { videoId: 'b', rating: 'none' },
        ],
      }),
    ) as unknown as typeof fetch
    const r = await getRatings(['a', 'b', 'a'], 'tok', fetcher)
    expect(r.get('a')).toBe('like')
    expect(r.get('b')).toBe('none')
    expect(r.size).toBe(2)
    const u = new URL(calls(fetcher)[0]![0])
    expect(u.pathname).toBe('/youtube/v3/videos/getRating')
    expect(u.searchParams.get('id')).toBe('a,b')
    expect(calls(fetcher).length).toBe(1)
  })

  it('chunks requests at 50 ids', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `id${i}`)
    const fetcher = vi.fn().mockImplementation((url: string) => {
      const got = new URL(url).searchParams.get('id')!.split(',')
      return Promise.resolve(jsonResponse({ items: got.map((videoId) => ({ videoId, rating: 'none' })) }))
    }) as unknown as typeof fetch
    const r = await getRatings(ids, 'tok', fetcher)
    expect(r.size).toBe(120)
    const sizes = calls(fetcher).map(([url]) => new URL(url).searchParams.get('id')!.split(',').length)
    expect(sizes).toEqual([50, 50, 20])
  })

  it('makes no request for an empty id list', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch
    const r = await getRatings([], 'tok', fetcher)
    expect(r.size).toBe(0)
    expect(calls(fetcher).length).toBe(0)
  })

  it('propagates API errors', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { errors: [{ reason: 'quotaExceeded' }] } }, { status: 403 })) as unknown as typeof fetch
    await expect(getRatings(['a'], 'tok', fetcher)).rejects.toBeInstanceOf(YouTubeApiError)
  })
})
