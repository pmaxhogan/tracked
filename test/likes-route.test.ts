import { describe, it, expect, vi, afterEach } from 'vitest'
import { app } from '../src/index'
import type { Env } from '../src/types'
import type { StoredTokens } from '../src/lib/google-oauth'

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

function env(subs: Record<string, string> = {}): Env {
  return { CACHE: fakeKV(), SUBS: fakeKV(subs), API_TOKEN: 'secret', YOUTUBE_API_KEY: 'k' }
}

function post(body: unknown, token = 'secret'): Request {
  return new Request('http://localhost/likes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('POST /likes', () => {
  it('401s without the bearer token', async () => {
    const res = await app.request(post({ videoUrl: 'https://youtu.be/79n8BaQAL2Q', liked: true }, 'wrong'), undefined, env())
    expect(res.status).toBe(401)
  })

  it('400s on a body that fails validation', async () => {
    const res = await app.request(post({ videoUrl: 'https://youtu.be/79n8BaQAL2Q' }), undefined, env())
    expect(res.status).toBe(400)
  })

  it('400s on an unparseable YouTube URL', async () => {
    const res = await app.request(post({ videoUrl: 'https://example.com/nope', liked: true }), undefined, env())
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_url' })
  })

  it('503s youtube_not_connected when no OAuth tokens are stored', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const res = await app.request(post({ videoUrl: 'https://youtu.be/79n8BaQAL2Q', liked: true }), undefined, env())
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'youtube_not_connected' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('likes: calls videos.rate with rating=like and echoes {videoId, liked}', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetcher)
    const res = await app.request(
      post({ videoUrl: 'https://music.youtube.com/watch?v=79n8BaQAL2Q&list=x', liked: true }),
      undefined,
      env({ 'oauth:google': JSON.stringify(validTokens) }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ videoId: '79n8BaQAL2Q', liked: true })
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    const u = new URL(url)
    expect(u.pathname).toBe('/youtube/v3/videos/rate')
    expect(u.searchParams.get('id')).toBe('79n8BaQAL2Q')
    expect(u.searchParams.get('rating')).toBe('like')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer at')
  })

  it('unlikes: liked:false sends rating=none', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetcher)
    const res = await app.request(post({ videoUrl: '79n8BaQAL2Q', liked: false }), undefined, env({ 'oauth:google': JSON.stringify(validTokens) }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ videoId: '79n8BaQAL2Q', liked: false })
    expect(new URL(fetcher.mock.calls[0]![0] as string).searchParams.get('rating')).toBe('none')
  })

  it('502s with the YouTube reason when videos.rate is rejected', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { errors: [{ reason: 'videoNotFound' }] } }), { status: 404 }),
    )
    vi.stubGlobal('fetch', fetcher)
    const res = await app.request(post({ videoUrl: '79n8BaQAL2Q', liked: true }), undefined, env({ 'oauth:google': JSON.stringify(validTokens) }))
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('upstream_error')
    expect(body.message).toContain('videoNotFound')
  })

  it('503s youtube_not_connected when the refresh token has been revoked (invalid_grant)', async () => {
    const expired: StoredTokens = { ...validTokens, expiresAt: Math.floor(Date.now() / 1000) - 10 }
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }))
    vi.stubGlobal('fetch', fetcher)
    const e = { ...env({ 'oauth:google': JSON.stringify(expired) }), GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 'sec' }
    const res = await app.request(post({ videoUrl: '79n8BaQAL2Q', liked: true }), undefined, e)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'youtube_not_connected' })
  })
})
