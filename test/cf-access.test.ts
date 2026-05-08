import { describe, it, expect, beforeAll, vi } from 'vitest'
import { verifyAccessJwt } from '../src/middleware/cf-access'
import type { Env } from '../src/types'

const TEAM = 'testteam.cloudflareaccess.com'
const ISS = `https://${TEAM}`
const AUD = 'test-aud-tag'

let signKey: CryptoKey
let publicJwk: JsonWebKey
let envWithJwks: Env
const KID = 'test-kid-1'

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

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (const c of b) s += String.fromCharCode(c)
  return btoa(s).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

async function signJwt(payload: Record<string, unknown>, kid = KID): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT', kid }
  const enc = (o: object) => b64url(new TextEncoder().encode(JSON.stringify(o)))
  const signingInput = `${enc(header)}.${enc(payload)}`
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    signKey,
    new TextEncoder().encode(signingInput),
  )
  return `${signingInput}.${b64url(sig)}`
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  signKey = pair.privateKey
  publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey
  const jwks = { keys: [{ ...publicJwk, kid: KID, alg: 'RS256', use: 'sig' }] }
  envWithJwks = {
    CACHE: fakeKV({ 'cfaccess:jwks': JSON.stringify({ iss: ISS, jwks }) }),
  } as unknown as Env
})

const validClaims = () => ({
  iss: ISS,
  aud: AUD,
  email: 'me@example.com',
  iat: Math.floor(Date.now() / 1000) - 10,
  exp: Math.floor(Date.now() / 1000) + 600,
})

describe('verifyAccessJwt', () => {
  it('accepts a well-formed signed token', async () => {
    const tok = await signJwt(validClaims())
    const claims = await verifyAccessJwt(tok, { teamDomain: TEAM, aud: AUD, env: envWithJwks })
    expect(claims.email).toBe('me@example.com')
  })

  it('rejects a token with the wrong aud', async () => {
    const tok = await signJwt({ ...validClaims(), aud: 'someone-else' })
    await expect(verifyAccessJwt(tok, { teamDomain: TEAM, aud: AUD, env: envWithJwks })).rejects.toThrow(/bad aud/)
  })

  it('rejects a token with the wrong issuer', async () => {
    const tok = await signJwt({ ...validClaims(), iss: 'https://other.cloudflareaccess.com' })
    await expect(verifyAccessJwt(tok, { teamDomain: TEAM, aud: AUD, env: envWithJwks })).rejects.toThrow(/bad iss/)
  })

  it('rejects an expired token', async () => {
    const tok = await signJwt({ ...validClaims(), exp: Math.floor(Date.now() / 1000) - 3600 })
    await expect(verifyAccessJwt(tok, { teamDomain: TEAM, aud: AUD, env: envWithJwks })).rejects.toThrow(/expired/)
  })

  it('rejects a tampered signature', async () => {
    const tok = await signJwt(validClaims())
    const parts = tok.split('.')
    const sigBytes = Uint8Array.from(atob(parts[2]!.replace(/-/g, '+').replace(/_/g, '/').padEnd(parts[2]!.length + ((4 - (parts[2]!.length % 4)) % 4), '=')), (c) => c.charCodeAt(0))
    sigBytes[0] = sigBytes[0]! ^ 0xff
    const tamperedSig = b64url(sigBytes)
    const tampered = `${parts[0]}.${parts[1]}.${tamperedSig}`
    await expect(verifyAccessJwt(tampered, { teamDomain: TEAM, aud: AUD, env: envWithJwks })).rejects.toThrow(/bad signature/)
  })

  it('rejects an unknown kid', async () => {
    const tok = await signJwt(validClaims(), 'nope-kid')
    // Cached JWKS has no matching kid; the verifier falls back to fetching
    // fresh keys. Stub fetch to deterministically return an empty key set
    // so the test doesn't hit the network.
    const env = { CACHE: fakeKV({ 'cfaccess:jwks': JSON.stringify({ iss: ISS, jwks: { keys: [] } }) }) } as unknown as Env
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ keys: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
    try {
      await expect(verifyAccessJwt(tok, { teamDomain: TEAM, aud: AUD, env })).rejects.toThrow(/unknown kid/)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('rejects a malformed token', async () => {
    await expect(verifyAccessJwt('not.a.jwt.at.all', { teamDomain: TEAM, aud: AUD, env: envWithJwks })).rejects.toThrow()
    await expect(verifyAccessJwt('only-one-segment', { teamDomain: TEAM, aud: AUD, env: envWithJwks })).rejects.toThrow(/malformed/)
  })

  it('rejects unsupported alg (alg=none)', async () => {
    const header = { alg: 'none', typ: 'JWT', kid: KID }
    const payload = validClaims()
    const enc = (o: object) => b64url(new TextEncoder().encode(JSON.stringify(o)))
    const tok = `${enc(header)}.${enc(payload)}.`
    await expect(verifyAccessJwt(tok, { teamDomain: TEAM, aud: AUD, env: envWithJwks })).rejects.toThrow(/unsupported alg/)
  })
})
