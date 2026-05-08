import type { Context, MiddlewareHandler } from 'hono'
import type { Env } from '../types'
import { makeLogger, errorFields } from '../lib/log'

/**
 * Cloudflare Access JWT verification middleware.
 *
 * Cloudflare Access sits in front of the worker and, for any request that
 * passes its policy, forwards a signed JWT in the `Cf-Access-Jwt-Assertion`
 * header (also a `CF_Authorization` cookie). The header alone isn't proof of
 * anything — anyone hitting the worker URL directly (e.g. via the *.workers.dev
 * subdomain, or another zone, or a misconfigured route) could forge it. So
 * we verify the JWT signature against the team's JWKS and check the standard
 * claims (iss/aud/exp/nbf) plus an explicit email allowlist.
 *
 * Failing closed: if any of CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD /
 * CF_ACCESS_ALLOWED_EMAILS is unset, every request is rejected — unless
 * DEV_BYPASS_CF_ACCESS is "1"/"true" (intended for local `wrangler dev`).
 */

type Claims = {
  iss?: string
  aud?: string | string[]
  exp?: number
  iat?: number
  nbf?: number
  email?: string
  sub?: string
  identity_nonce?: string
}

type Jwk = {
  kid: string
  kty: string
  alg?: string
  use?: string
  n: string
  e: string
}

type Jwks = { keys: Jwk[] }

const JWKS_KV_KEY = 'cfaccess:jwks'
const JWKS_TTL_SECONDS = 60 * 60 // 1h; CF rotates keys every ~6 weeks

export const cfAccess: MiddlewareHandler<{ Bindings: Env; Variables: { cfAccessEmail: string } }> = async (c, next) => {
  const reqId = c.req.raw.headers.get('cf-ray') ?? `local-${Math.random().toString(36).slice(2, 10)}`
  const log = makeLogger({ reqId, mw: 'cfAccess' })

  if (isTruthy(c.env.DEV_BYPASS_CF_ACCESS)) {
    log.warn('cfaccess.dev_bypass', { note: 'verification skipped — dev only' })
    c.set('cfAccessEmail', 'dev@local')
    await next()
    return
  }

  const teamDomain = (c.env.CF_ACCESS_TEAM_DOMAIN ?? '').trim()
  const aud = (c.env.CF_ACCESS_AUD ?? '').trim()
  const allowed = parseAllowedEmails(c.env.CF_ACCESS_ALLOWED_EMAILS)
  if (!teamDomain || !aud || allowed.length === 0) {
    log.error('cfaccess.misconfigured', {
      hasTeamDomain: Boolean(teamDomain),
      hasAud: Boolean(aud),
      allowedCount: allowed.length,
    })
    return c.json({ error: 'cf_access_misconfigured' }, 500)
  }

  const token = readToken(c)
  if (!token) {
    log.warn('cfaccess.no_token')
    return c.json({ error: 'unauthorized' }, 401)
  }

  let claims: Claims
  try {
    claims = await verifyAccessJwt(token, { teamDomain, aud, env: c.env })
  } catch (e) {
    log.warn('cfaccess.verify_failed', errorFields(e))
    return c.json({ error: 'unauthorized' }, 401)
  }

  const email = (claims.email ?? '').toLowerCase()
  if (!email || !allowed.includes(email)) {
    log.warn('cfaccess.email_not_allowed', { email })
    return c.json({ error: 'forbidden' }, 403)
  }

  log.info('cfaccess.ok', { email })
  c.set('cfAccessEmail', email)
  await next()
  return
}

function readToken(c: Context): string | null {
  const header = c.req.header('Cf-Access-Jwt-Assertion')
  if (header && header.length > 0) return header
  const cookie = c.req.header('Cookie') ?? ''
  const m = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/)
  return m ? decodeURIComponent(m[1]!) : null
}

function parseAllowedEmails(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

function isTruthy(v: string | undefined): boolean {
  if (!v) return false
  const s = v.trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes'
}

export async function verifyAccessJwt(
  token: string,
  opts: { teamDomain: string; aud: string; env: Env; now?: number },
): Promise<Claims> {
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('jwt: malformed')
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string]

  const header = JSON.parse(b64urlToText(headerB64)) as { alg?: string; kid?: string; typ?: string }
  if (header.alg !== 'RS256') throw new Error(`jwt: unsupported alg ${header.alg}`)
  if (!header.kid) throw new Error('jwt: missing kid')

  const expectedIss = `https://${opts.teamDomain.replace(/^https?:\/\//, '').replace(/\/$/, '')}`
  const jwks = await getJwks(expectedIss, opts.env)
  let jwk = jwks.keys.find((k) => k.kid === header.kid)
  if (!jwk) {
    // Maybe the key rotated — refresh once.
    const fresh = await fetchJwks(expectedIss)
    await opts.env.CACHE.put(JWKS_KV_KEY, JSON.stringify({ iss: expectedIss, jwks: fresh }), {
      expirationTtl: JWKS_TTL_SECONDS,
    })
    jwk = fresh.keys.find((k) => k.kid === header.kid)
    if (!jwk) throw new Error(`jwt: unknown kid ${header.kid}`)
  }

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  const signed = new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  const sig = b64urlToBytes(sigB64)
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, signed)
  if (!ok) throw new Error('jwt: bad signature')

  const claims = JSON.parse(b64urlToText(payloadB64)) as Claims

  if (claims.iss !== expectedIss) throw new Error(`jwt: bad iss ${claims.iss}`)
  const audMatches = Array.isArray(claims.aud) ? claims.aud.includes(opts.aud) : claims.aud === opts.aud
  if (!audMatches) throw new Error(`jwt: bad aud ${JSON.stringify(claims.aud)}`)

  // 60s skew tolerance.
  const SKEW = 60
  if (typeof claims.exp !== 'number' || claims.exp + SKEW < now) throw new Error('jwt: expired')
  if (typeof claims.nbf === 'number' && claims.nbf - SKEW > now) throw new Error('jwt: not yet valid')
  if (typeof claims.iat === 'number' && claims.iat - SKEW > now) throw new Error('jwt: iat in future')

  return claims
}

async function getJwks(expectedIss: string, env: Env): Promise<Jwks> {
  const cached = await env.CACHE.get(JWKS_KV_KEY, 'json')
  if (cached && typeof cached === 'object' && (cached as { iss?: string }).iss === expectedIss) {
    return (cached as { iss: string; jwks: Jwks }).jwks
  }
  const fresh = await fetchJwks(expectedIss)
  await env.CACHE.put(JWKS_KV_KEY, JSON.stringify({ iss: expectedIss, jwks: fresh }), {
    expirationTtl: JWKS_TTL_SECONDS,
  })
  return fresh
}

async function fetchJwks(expectedIss: string): Promise<Jwks> {
  const url = `${expectedIss}/cdn-cgi/access/certs`
  const r = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!r.ok) throw new Error(`jwks: ${r.status} ${r.statusText}`)
  const body = (await r.json()) as Jwks
  if (!body.keys || !Array.isArray(body.keys)) throw new Error('jwks: malformed')
  return body
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = '='.repeat((4 - (s.length % 4)) % 4)
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function b64urlToText(s: string): string {
  return new TextDecoder().decode(b64urlToBytes(s))
}
