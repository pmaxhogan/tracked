import type { Env } from '../types'

/**
 * Google OAuth 2.0 (authorization code, offline) for YouTube playlist access.
 *
 * Single-user app: there's exactly one set of tokens stored at `oauth:google`
 * in the SUBS KV namespace. The CF Access gate already restricts access to
 * the owner; this OAuth flow lets the worker act on the owner's YouTube
 * account on their behalf for playlist create/modify operations.
 *
 * We never log tokens. The KV namespace is encrypted at rest by Cloudflare.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true'

/**
 * `youtube` is read+write for playlists/uploads/etc. — narrower than
 * `youtube.force-ssl` and sufficient for create/insert/update/delete on
 * playlists and playlistItems on the authenticated user's channel.
 */
export const YOUTUBE_SCOPES = ['https://www.googleapis.com/auth/youtube']

const KV_KEY = 'oauth:google'

export type StoredTokens = {
  accessToken: string
  refreshToken: string
  /** Unix seconds. */
  expiresAt: number
  scope: string
  channelId: string | null
  channelTitle: string | null
  /** Unix seconds; first connection. */
  connectedAt: number
}

export function buildAuthUrl(opts: { clientId: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: YOUTUBE_SCOPES.join(' '),
    access_type: 'offline',
    include_granted_scopes: 'true',
    // prompt=consent forces Google to (re-)issue a refresh_token even when
    // the user has previously authorized this client. Without it, only the
    // *first* consent yields a refresh_token, which makes recovery from a
    // lost-token state impossible without manually revoking via the user's
    // Google account.
    prompt: 'consent',
    state: opts.state,
  })
  return `${AUTH_URL}?${params.toString()}`
}

type TokenResponse = {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope?: string
  token_type?: string
}

export async function exchangeCode(opts: {
  clientId: string
  clientSecret: string
  redirectUri: string
  code: string
  fetcher?: typeof fetch
}): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; scope: string }> {
  const f = opts.fetcher ?? fetch
  const r = await f(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri,
      grant_type: 'authorization_code',
      code: opts.code,
    }),
  })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`oauth code exchange: ${r.status} ${body}`)
  }
  const data = (await r.json()) as TokenResponse
  if (!data.refresh_token) {
    throw new Error('oauth: missing refresh_token (Google withholds it on re-consent unless prompt=consent + access_type=offline)')
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    scope: data.scope ?? '',
  }
}

export async function refreshAccessToken(opts: {
  clientId: string
  clientSecret: string
  refreshToken: string
  fetcher?: typeof fetch
}): Promise<{ accessToken: string; expiresIn: number; scope: string }> {
  const f = opts.fetcher ?? fetch
  const r = await f(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: opts.refreshToken,
    }),
  })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`oauth refresh: ${r.status} ${body}`)
  }
  const data = (await r.json()) as TokenResponse
  return { accessToken: data.access_token, expiresIn: data.expires_in, scope: data.scope ?? '' }
}

export async function revokeToken(token: string, fetcher: typeof fetch = fetch): Promise<void> {
  await fetcher(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => {})
}

export async function fetchChannelInfo(accessToken: string, fetcher: typeof fetch = fetch): Promise<{ id: string; title: string } | null> {
  const r = await fetcher(CHANNELS_URL, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!r.ok) return null
  const data = (await r.json()) as { items?: Array<{ id: string; snippet?: { title?: string } }> }
  const item = data.items?.[0]
  if (!item) return null
  return { id: item.id, title: item.snippet?.title ?? '' }
}

export async function loadTokens(env: Env): Promise<StoredTokens | null> {
  return ((await env.SUBS.get(KV_KEY, 'json')) as StoredTokens | null) ?? null
}

export async function saveTokens(env: Env, t: StoredTokens): Promise<void> {
  await env.SUBS.put(KV_KEY, JSON.stringify(t))
}

export async function clearTokens(env: Env): Promise<void> {
  await env.SUBS.delete(KV_KEY)
}

/**
 * Returns a usable access token (refreshing if it's within 60s of expiring),
 * or null when no tokens are stored.
 */
export async function getAccessToken(env: Env, fetcher: typeof fetch = fetch): Promise<{ accessToken: string; tokens: StoredTokens } | null> {
  const t = await loadTokens(env)
  if (!t) return null
  const now = Math.floor(Date.now() / 1000)
  if (t.expiresAt - 60 > now) return { accessToken: t.accessToken, tokens: t }
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET not configured')
  }
  const refreshed = await refreshAccessToken({
    clientId: env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    refreshToken: t.refreshToken,
    fetcher,
  })
  const next: StoredTokens = {
    ...t,
    accessToken: refreshed.accessToken,
    expiresAt: now + refreshed.expiresIn,
    scope: refreshed.scope || t.scope,
  }
  await saveTokens(env, next)
  return { accessToken: refreshed.accessToken, tokens: next }
}

export function randomState(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function redirectUriFor(reqUrl: string): string {
  const u = new URL(reqUrl)
  return `${u.origin}/subscriptions/oauth/callback`
}
