import { describe, it, expect, vi, afterEach } from 'vitest'
import { app } from '../src/index'
import type { Env } from '../src/types'
import type { StoredTokens } from '../src/lib/google-oauth'
import { parseIsoDuration } from '../src/lib/youtube-playlists'

function fakeKV(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map<string, string>(Object.entries(initial))
  return {
    async get(key: string, type?: 'text' | 'json') {
      const v = store.get(key)
      if (v === undefined) return null
      if (type === 'json') return JSON.parse(v)
      return v
    },
    async put(key: string, value: string) {
      store.set(key, value)
    },
    async delete(key: string) {
      store.delete(key)
    },
  } as unknown as KVNamespace
}

const validTokens: StoredTokens = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  scope: 'https://www.googleapis.com/auth/youtube',
  channelId: 'c',
  channelTitle: 'C',
  connectedAt: 0,
}
const connected = { 'oauth:google': JSON.stringify(validTokens) }

function env(subs: Record<string, string> = {}, extra: Partial<Env> = {}): Env {
  return { CACHE: fakeKV(), SUBS: fakeKV(subs), API_TOKEN: 'tasker', YOUTUBE_API_KEY: 'k', LIKED_SONGS_TOKEN: 'agent', ...extra }
}

function get(query = '', token: string | null = 'agent'): Request {
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  return new Request(`http://localhost/liked-songs${query}`, { headers })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function playlistItem(videoId: string, title = `Song ${videoId}`) {
  return {
    kind: 'youtube#playlistItem',
    id: `pli-${videoId}`,
    snippet: { title, resourceId: { kind: 'youtube#video', videoId }, publishedAt: '2026-01-01T00:00:00Z', position: 0 },
    contentDetails: { videoId },
    status: { privacyStatus: 'public' },
  }
}

type Call = [string, RequestInit]
const urls = (f: ReturnType<typeof vi.fn>) => (f.mock.calls as Call[]).map(([u]) => new URL(u))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseIsoDuration', () => {
  it('parses the shapes YouTube emits', () => {
    expect(parseIsoDuration('PT25M')).toBe(1500)
    expect(parseIsoDuration('PT1H2M3S')).toBe(3723)
    expect(parseIsoDuration('PT0S')).toBe(0)
    expect(parseIsoDuration('P1DT2H')).toBe(93600)
    expect(parseIsoDuration('PT4M30S')).toBe(270)
  })
  it('returns null for garbage', () => {
    expect(parseIsoDuration('')).toBeNull()
    expect(parseIsoDuration(undefined)).toBeNull()
    expect(parseIsoDuration('P')).toBeNull()
    expect(parseIsoDuration('4:30')).toBeNull()
  })
})

describe('GET /liked-songs auth', () => {
  it('401s with no token', async () => {
    const res = await app.request(get('', null), undefined, env(connected))
    expect(res.status).toBe(401)
  })

  it('401s with the Tasker API_TOKEN — the tokens are not interchangeable', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const res = await app.request(get('', 'tasker'), undefined, env(connected))
    expect(res.status).toBe(401)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('the liked-songs token does not open POST /likes', async () => {
    const res = await app.request(
      new Request('http://localhost/likes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer agent' },
        body: JSON.stringify({ videoUrl: '79n8BaQAL2Q', liked: true }),
      }),
      undefined,
      env(connected),
    )
    expect(res.status).toBe(401)
  })

  it('500s when LIKED_SONGS_TOKEN is not configured', async () => {
    const res = await app.request(get(), undefined, env(connected, { LIKED_SONGS_TOKEN: undefined }))
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ error: 'LIKED_SONGS_TOKEN not configured' })
  })
})

describe('GET /liked-songs', () => {
  it('503s youtube_not_connected when no OAuth tokens are stored', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const res = await app.request(get(), undefined, env())
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'youtube_not_connected' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('500s misconfigured when the token is expired and the OAuth client secrets are missing', async () => {
    const expired: StoredTokens = { ...validTokens, expiresAt: Math.floor(Date.now() / 1000) - 10 }
    const res = await app.request(get(), undefined, env({ 'oauth:google': JSON.stringify(expired) }))
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ error: 'misconfigured' })
  })

  it('walks every page of LL with all parts, then enriches durations in 50-id chunks', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => playlistItem(`vid${String(i).padStart(7, '0')}`))
    const page2 = [playlistItem('vidlast001'), playlistItem('vidgone002', 'Deleted video')]
    const allIds = [...page1, ...page2].map((p) => p.contentDetails.videoId)
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ items: page1, nextPageToken: 'p2' }))
      .mockResolvedValueOnce(json({ items: page2 }))
      // videos.list chunk 1 (50 ids) — every one 4m30s
      .mockResolvedValueOnce(json({ items: page1.map((p) => ({ id: p.contentDetails.videoId, contentDetails: { duration: 'PT4M30S' } })) }))
      // videos.list chunk 2 (2 ids) — the deleted one is not echoed back
      .mockResolvedValueOnce(json({ items: [{ id: 'vidlast001', contentDetails: { duration: 'PT1H2M3S' } }] }))
    vi.stubGlobal('fetch', fetcher)

    const res = await app.request(get(), undefined, env(connected))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      playlistId: string
      count: number
      nextPageToken: string | null
      quotaUnits: number
      items: Array<{ videoId: string; duration: string | null; durationSeconds: number | null; unavailable: boolean; item: Record<string, unknown> }>
    }
    expect(body.playlistId).toBe('LL')
    expect(body.count).toBe(52)
    expect(body.nextPageToken).toBeNull()
    expect(body.quotaUnits).toBe(4)
    expect(body.items.map((i) => i.videoId)).toEqual(allIds)
    expect(body.items[0]).toMatchObject({ duration: 'PT4M30S', durationSeconds: 270, unavailable: false })
    expect(body.items[0]!.item).toEqual(page1[0])
    expect(body.items[50]).toMatchObject({ videoId: 'vidlast001', durationSeconds: 3723, unavailable: false })
    expect(body.items[51]).toMatchObject({ videoId: 'vidgone002', duration: null, durationSeconds: null, unavailable: true })

    const u = urls(fetcher)
    expect(u).toHaveLength(4)
    expect(u[0]!.pathname).toBe('/youtube/v3/playlistItems')
    expect(u[0]!.searchParams.get('playlistId')).toBe('LL')
    expect(u[0]!.searchParams.get('part')!.split(',').sort()).toEqual(['contentDetails', 'id', 'snippet', 'status'])
    expect(u[0]!.searchParams.get('maxResults')).toBe('50')
    expect(u[0]!.searchParams.get('pageToken')).toBeNull()
    expect(u[1]!.searchParams.get('pageToken')).toBe('p2')
    expect(u[2]!.pathname).toBe('/youtube/v3/videos')
    expect(u[2]!.searchParams.get('part')).toBe('contentDetails')
    expect(u[2]!.searchParams.get('id')!.split(',')).toHaveLength(50)
    expect(u[3]!.searchParams.get('id')).toBe('vidlast001,vidgone002')
    for (const [, init] of fetcher.mock.calls as Call[]) {
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer at')
    }
  })

  it('durations=0 skips videos.list and leaves duration null without flagging unavailable', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ items: [playlistItem('vidonly0001')] }))
    vi.stubGlobal('fetch', fetcher)
    const res = await app.request(get('?durations=0'), undefined, env(connected))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { quotaUnits: number; items: Array<Record<string, unknown>> }
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(body.quotaUnits).toBe(1)
    expect(body.items[0]).toMatchObject({ videoId: 'vidonly0001', duration: null, durationSeconds: null, unavailable: false })
  })

  it('maxPages stops early and returns nextPageToken; pageToken resumes from there', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ items: [playlistItem('vidpage0001')], nextPageToken: 'p2' }))
      .mockResolvedValueOnce(json({ items: [{ id: 'vidpage0001', contentDetails: { duration: 'PT3M' } }] }))
      .mockResolvedValueOnce(json({ items: [playlistItem('vidpage0002')] }))
      .mockResolvedValueOnce(json({ items: [{ id: 'vidpage0002', contentDetails: { duration: 'PT3M' } }] }))
    vi.stubGlobal('fetch', fetcher)

    const first = (await (await app.request(get('?maxPages=1'), undefined, env(connected))).json()) as { count: number; nextPageToken: string | null }
    expect(first).toMatchObject({ count: 1, nextPageToken: 'p2' })

    const second = (await (await app.request(get('?maxPages=1&pageToken=p2'), undefined, env(connected))).json()) as {
      count: number
      nextPageToken: string | null
      items: Array<{ videoId: string }>
    }
    expect(second).toMatchObject({ count: 1, nextPageToken: null })
    expect(second.items[0]!.videoId).toBe('vidpage0002')
    expect(urls(fetcher)[2]!.searchParams.get('pageToken')).toBe('p2')
  })

  it('400s on a bad maxPages in the documented { error, message } shape', async () => {
    const res = await app.request(get('?maxPages=0'), undefined, env(connected))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_request' })
  })

  it('502s with the YouTube reason when playlistItems.list is rejected', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, 403))
    vi.stubGlobal('fetch', fetcher)
    const res = await app.request(get(), undefined, env(connected))
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('upstream_error')
    expect(body.message).toContain('quotaExceeded')
  })
})
