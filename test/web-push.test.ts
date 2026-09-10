import { describe, it, expect, vi } from 'vitest'
import { fakeKV } from './helpers/fake-kv'
import type { Env } from '../src/types'
import {
  banClearPayload,
  banStartPayload,
  deletePushSubscription,
  formatDuration,
  isPushSubscription,
  listPushSubscriptions,
  pushConfigured,
  savePushSubscription,
  sendPushToAll,
  testPayload,
} from '../src/lib/web-push'

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

/** VAPID keys in the same shape `scripts/gen-vapid-keys.mjs` prints. */
async function genVapid() {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const pub = (await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer
  const jwk = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as JsonWebKey
  return { publicKey: b64url(pub), privateKey: jwk.d!, subject: 'mailto:test@example.com' }
}

/** What a browser hands back from pushManager.subscribe(). */
async function genSubscription(endpoint: string) {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
  const pub = (await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer
  return { endpoint, expirationTime: null, keys: { p256dh: b64url(pub), auth: b64url(crypto.getRandomValues(new Uint8Array(16))) } }
}

async function makeEnv(): Promise<Env> {
  const v = await genVapid()
  return { CACHE: fakeKV(), SUBS: fakeKV(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k', VAPID_PUBLIC_KEY: v.publicKey, VAPID_PRIVATE_KEY: v.privateKey, VAPID_SUBJECT: v.subject } as Env
}

describe('subscription storage', () => {
  it('validates, stores (idempotently by endpoint) and deletes subscriptions', async () => {
    const env = await makeEnv()
    const sub = await genSubscription('https://fcm.googleapis.com/fcm/send/abc')
    expect(isPushSubscription(sub)).toBe(true)
    expect(isPushSubscription({ endpoint: 'http://insecure', keys: sub.keys })).toBe(false)
    expect(isPushSubscription({ endpoint: sub.endpoint })).toBe(false)
    const a = await savePushSubscription(env, sub, 'Chrome on Android')
    const b = await savePushSubscription(env, sub, null)
    expect(b.id).toBe(a.id)
    expect(b.ua).toBe('Chrome on Android')
    expect(b.createdAt).toBe(a.createdAt)
    expect(await listPushSubscriptions(env)).toHaveLength(1)
    expect(await deletePushSubscription(env, sub.endpoint)).toBe(true)
    expect(await deletePushSubscription(env, sub.endpoint)).toBe(false)
    expect(await listPushSubscriptions(env)).toEqual([])
  })
})

describe('sendPushToAll', () => {
  it('is a no-op (not an error) when VAPID is not configured', async () => {
    const env = { ...(await makeEnv()), VAPID_PRIVATE_KEY: undefined } as Env
    expect(pushConfigured(env)).toBe(false)
    const r = await sendPushToAll(env, testPayload())
    expect(r).toMatchObject({ configured: false, total: 0, sent: 0 })
  })

  it('sends an aes128gcm-encrypted, VAPID-signed POST per subscription and prunes dead endpoints', async () => {
    const env = await makeEnv()
    const alive = await genSubscription('https://fcm.googleapis.com/fcm/send/alive')
    const dead = await genSubscription('https://updates.push.services.mozilla.com/wpush/v2/dead')
    const flaky = await genSubscription('https://web.push.apple.com/flaky')
    await savePushSubscription(env, alive, 'Chrome on Android')
    await savePushSubscription(env, dead, 'Firefox on Windows')
    await savePushSubscription(env, flaky, 'Safari on iOS')

    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init: init ?? {} })
      if (url.endsWith('/dead')) return new Response('gone', { status: 410 })
      if (url.endsWith('/flaky')) return new Response('too many', { status: 429 })
      return new Response('', { status: 201 })
    }) as unknown as typeof fetch

    const payload = banStartPayload('68.1.2.3', true)
    const r = await sendPushToAll(env, payload, undefined, fetchImpl)
    expect(r).toMatchObject({ configured: true, total: 3, sent: 1, failed: 1, removed: 1 })

    const aliveCall = calls.find((c) => c.url.endsWith('/alive'))!
    const h = aliveCall.init.headers as Record<string, string>
    expect(String(aliveCall.init.method).toUpperCase()).toBe('POST')
    expect(h.authorization).toMatch(/^vapid t=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+, k=/)
    expect(String(h.authorization).endsWith(`k=${env.VAPID_PUBLIC_KEY}`)).toBe(true)
    expect(h['content-encoding']).toBe('aes128gcm')
    expect(h.urgency).toBe('high')
    expect(h.topic).toBe('tracked-ip-ban')
    expect(Number(h.ttl)).toBeGreaterThan(0)
    const body = aliveCall.init.body as Uint8Array
    expect(body).toBeInstanceOf(Uint8Array)
    // The library pads every message to a constant 4096 octets so length leaks nothing.
    expect(body.byteLength).toBe(4096)
    // The plaintext never appears in the ciphertext.
    expect(Buffer.from(body).toString('latin1')).not.toContain('68.1.2.3')

    const left = await listPushSubscriptions(env)
    expect(left.map((s) => s.ua).sort()).toEqual(['Chrome on Android', 'Safari on iOS'])
    expect(left.find((s) => s.ua === 'Chrome on Android')).toMatchObject({ failCount: 0, lastError: null })
    expect(left.find((s) => s.ua === 'Safari on iOS')).toMatchObject({ failCount: 1 })
    expect(left.find((s) => s.ua === 'Safari on iOS')!.lastError).toMatch(/429/)
    expect(left.find((s) => s.ua === 'Safari on iOS')!.lastOkAt).toBeNull()
  })
})

describe('payload copy', () => {
  it('describes the ban, the fallback and where to tap', () => {
    const p = banStartPayload('68.1.2.3', true)
    expect(p.title).toBe('1001tracklists blocked your home IP')
    expect(p.body).toContain('68.1.2.3')
    expect(p.body).toContain('fallback pool')
    expect(p.url).toBe('https://www.1001tracklists.com/info/unblock_ip.html')
    expect(p.tag).toBe('tracked-ip-ban')
    expect(banStartPayload(null, false).body).toContain('sync is paused')
    const c = banClearPayload('68.1.2.3', 95 * 60 * 1000)
    expect(c.body).toContain('after 1 h 35 min')
    expect(c.tag).toBe(p.tag)
  })

  it('formats durations', () => {
    expect(formatDuration(5 * 60_000)).toBe('5 min')
    expect(formatDuration(60 * 60_000)).toBe('1 h')
    expect(formatDuration(150 * 60_000)).toBe('2 h 30 min')
  })
})
