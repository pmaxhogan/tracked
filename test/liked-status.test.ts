import { describe, it, expect, vi } from 'vitest'
import { attachYoutubeLiked } from '../src/lib/liked-status'
import { makeLogger } from '../src/lib/log'
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
  return { CACHE: fakeKV(), SUBS: fakeKV(subs), API_TOKEN: 't', YOUTUBE_API_KEY: 'k' }
}

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' }, ...init })
}

const log = () => makeLogger({ test: true })

const tracks = [
  { title: 'A', youtubeLink: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' },
  { title: 'B', youtubeLink: 'https://www.youtube.com/watch?v=bbbbbbbbbbb' },
  { title: 'C', youtubeLink: null },
]

describe('attachYoutubeLiked', () => {
  it('returns null everywhere when no YouTube account is connected (no fetch)', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch
    const r = await attachYoutubeLiked(env(), tracks, log(), fetcher)
    expect(r.map((t) => t.youtubeLiked)).toEqual([null, null, null])
    expect((fetcher as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0)
  })

  it('maps like → true, other ratings → false, unknown id → null, no link → null', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(
      jsonResponse({ items: [{ videoId: 'aaaaaaaaaaa', rating: 'like' }, { videoId: 'bbbbbbbbbbb', rating: 'none' }, { videoId: 'eeeeeeeeeee', rating: 'unspecified' }] }),
    ) as unknown as typeof fetch
    const r = await attachYoutubeLiked(
      env({ 'oauth:google': JSON.stringify(validTokens) }),
      [...tracks, { title: 'D', youtubeLink: 'https://youtu.be/ddddddddddd' }, { title: 'E', youtubeLink: 'https://youtu.be/eeeeeeeeeee' }],
      log(),
      fetcher,
    )
    // unspecified (YouTube can't tell) is "unknown", same as an id the API didn't echo.
    expect(r.map((t) => t.youtubeLiked)).toEqual([true, false, null, null, null])
    // Original fields are preserved.
    expect(r[0]!.title).toBe('A')
    const url = new URL((fetcher as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0]!)
    expect(url.searchParams.get('id')).toBe('aaaaaaaaaaa,bbbbbbbbbbb,ddddddddddd,eeeeeeeeeee')
  })

  it('degrades to null (never throws) when the rating lookup fails', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse({ error: {} }, { status: 500 })) as unknown as typeof fetch
    const r = await attachYoutubeLiked(env({ 'oauth:google': JSON.stringify(validTokens) }), tracks, log(), fetcher)
    expect(r.map((t) => t.youtubeLiked)).toEqual([null, null, null])
  })

  it('skips the lookup entirely when no track has a youtubeLink', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch
    const r = await attachYoutubeLiked(env({ 'oauth:google': JSON.stringify(validTokens) }), [{ youtubeLink: null }], log(), fetcher)
    expect(r).toEqual([{ youtubeLink: null, youtubeLiked: null }])
    expect((fetcher as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0)
  })
})
