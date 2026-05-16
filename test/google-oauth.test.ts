import { describe, it, expect, vi } from 'vitest'
import {
  buildAuthUrl,
  redirectUriFor,
  randomState,
  getAccessToken,
  GoogleOAuthRefreshFailed,
  YOUTUBE_SCOPES,
  type StoredTokens,
} from '../src/lib/google-oauth'
import type { Env } from '../src/types'

function fakeKV(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map<string, string>(Object.entries(initial))
  return {
    async get(key: string, type?: 'text' | 'json' | 'arrayBuffer' | 'stream') {
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
    async list() {
      return { keys: [...store.keys()].map((name) => ({ name })), list_complete: true, cursor: '' }
    },
    async getWithMetadata() {
      return { value: null, metadata: null, cacheStatus: null }
    },
  } as unknown as KVNamespace
}

describe('buildAuthUrl', () => {
  it('builds a Google authorize URL with the required params', () => {
    const url = new URL(buildAuthUrl({ clientId: 'cid', redirectUri: 'https://x.example/cb', state: 'st' }))
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('redirect_uri')).toBe('https://x.example/cb')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toBe(YOUTUBE_SCOPES.join(' '))
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('state')).toBe('st')
  })
})

describe('redirectUriFor', () => {
  it('extracts origin + appends /subscriptions/oauth/callback', () => {
    expect(redirectUriFor('https://w.example/subscriptions/oauth/start')).toBe('https://w.example/subscriptions/oauth/callback')
    expect(redirectUriFor('http://localhost:8787/subscriptions/oauth/start?x=1')).toBe('http://localhost:8787/subscriptions/oauth/callback')
  })
})

describe('randomState', () => {
  it('returns a 64-char lowercase hex string', () => {
    const s = randomState()
    expect(s).toMatch(/^[0-9a-f]{64}$/)
  })
  it('returns different values across calls', () => {
    expect(randomState()).not.toBe(randomState())
  })
})

describe('getAccessToken', () => {
  const baseTokens: StoredTokens = {
    accessToken: 'old-access',
    refreshToken: 'rt-stored',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    scope: YOUTUBE_SCOPES.join(' '),
    channelId: 'UC123',
    channelTitle: 'Me',
    connectedAt: Math.floor(Date.now() / 1000) - 100,
  }

  it('returns null when no tokens stored', async () => {
    const env = { SUBS: fakeKV() } as unknown as Env
    expect(await getAccessToken(env)).toBeNull()
  })

  it('returns the cached token when not near expiry', async () => {
    const env = {
      SUBS: fakeKV({ 'oauth:google': JSON.stringify(baseTokens) }),
      GOOGLE_OAUTH_CLIENT_ID: 'cid',
      GOOGLE_OAUTH_CLIENT_SECRET: 'csec',
    } as unknown as Env
    const fetchSpy = vi.fn() as unknown as typeof fetch
    const result = await getAccessToken(env, fetchSpy)
    expect(result?.accessToken).toBe('old-access')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refreshes when access token is within 60s of expiry, persists new value', async () => {
    const expiring: StoredTokens = { ...baseTokens, expiresAt: Math.floor(Date.now() / 1000) + 30 }
    const kv = fakeKV({ 'oauth:google': JSON.stringify(expiring) })
    const env = {
      SUBS: kv,
      GOOGLE_OAUTH_CLIENT_ID: 'cid',
      GOOGLE_OAUTH_CLIENT_SECRET: 'csec',
    } as unknown as Env
    const fakeFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: 'new-access', expires_in: 3600, scope: YOUTUBE_SCOPES.join(' ') }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ) as unknown as typeof fetch
    const result = await getAccessToken(env, fakeFetch)
    expect(result?.accessToken).toBe('new-access')
    const stored = JSON.parse((await kv.get('oauth:google', 'text')) as unknown as string) as StoredTokens
    expect(stored.accessToken).toBe('new-access')
    // refreshToken must be preserved across refresh
    expect(stored.refreshToken).toBe('rt-stored')
  })

  it('throws when refresh is needed but client config missing', async () => {
    const expiring: StoredTokens = { ...baseTokens, expiresAt: Math.floor(Date.now() / 1000) - 10 }
    const env = { SUBS: fakeKV({ 'oauth:google': JSON.stringify(expiring) }) } as unknown as Env
    await expect(getAccessToken(env)).rejects.toThrow(/CLIENT_ID/)
  })

  it('clears stored tokens and throws an invalid_grant marker when Google rejects the refresh token', async () => {
    const expiring: StoredTokens = { ...baseTokens, expiresAt: Math.floor(Date.now() / 1000) - 10 }
    const kv = fakeKV({ 'oauth:google': JSON.stringify(expiring) })
    const env = {
      SUBS: kv,
      GOOGLE_OAUTH_CLIENT_ID: 'cid',
      GOOGLE_OAUTH_CLIENT_SECRET: 'csec',
    } as unknown as Env
    const fakeFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    ) as unknown as typeof fetch
    let caught: unknown
    try { await getAccessToken(env, fakeFetch) } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(GoogleOAuthRefreshFailed)
    expect((caught as GoogleOAuthRefreshFailed).invalidGrant).toBe(true)
    expect((caught as GoogleOAuthRefreshFailed).status).toBe(400)
    // Stored tokens are wiped so the UI's status endpoint reflects disconnect.
    expect(await kv.get('oauth:google')).toBeNull()
  })

  it('keeps tokens intact when refresh fails with a transient (non-invalid_grant) error', async () => {
    const expiring: StoredTokens = { ...baseTokens, expiresAt: Math.floor(Date.now() / 1000) - 10 }
    const kv = fakeKV({ 'oauth:google': JSON.stringify(expiring) })
    const env = {
      SUBS: kv,
      GOOGLE_OAUTH_CLIENT_ID: 'cid',
      GOOGLE_OAUTH_CLIENT_SECRET: 'csec',
    } as unknown as Env
    const fakeFetch = vi.fn(async () =>
      new Response('upstream blip', { status: 503 }),
    ) as unknown as typeof fetch
    let caught: unknown
    try { await getAccessToken(env, fakeFetch) } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(GoogleOAuthRefreshFailed)
    expect((caught as GoogleOAuthRefreshFailed).invalidGrant).toBe(false)
    // Tokens preserved for the next retry.
    expect(await kv.get('oauth:google')).not.toBeNull()
  })
})
