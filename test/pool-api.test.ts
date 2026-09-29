import { describe, it, expect } from 'vitest'
import { app } from '../src/index'
import { fakeD1 } from './helpers/fake-d1'
import { fakeKV } from './helpers/fake-kv'
import type { Env } from '../src/types'
import { flushDeferredPoolPushes, inQuietHours, listPoolEvents, poolEventPushPayload, receivePoolEvent, sanitizePoolEvent, type PoolEvent } from '../src/lib/pool-events'
import { savePushSubscription } from '../src/lib/web-push'

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

async function vapid() {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const pub = (await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer
  const jwk = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as JsonWebKey
  return { VAPID_PUBLIC_KEY: b64url(pub), VAPID_PRIVATE_KEY: jwk.d!, VAPID_SUBJECT: 'mailto:test@example.com' }
}

async function subscription(endpoint: string) {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
  const pub = (await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer
  return { endpoint, expirationTime: null, keys: { p256dh: b64url(pub), auth: b64url(crypto.getRandomValues(new Uint8Array(16))) } }
}

async function makeEnv(extra: Partial<Env> = {}): Promise<Env> {
  const env = { CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV(), API_TOKEN: 'tasker', YOUTUBE_API_KEY: 'k', TLPOOL_TOKEN: 'pool-secret', ...(await vapid()), ...extra } as Env
  await savePushSubscription(env, await subscription('https://push.example/device-1'), 'phone')
  return env
}

/** Push service stub: every delivery succeeds and is recorded. */
function pushService() {
  const sent: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    sent.push(String(input))
    return new Response(null, { status: 201 })
  }) as unknown as typeof fetch
  return { sent, fetchImpl }
}

// 2026-09-29 is CDT (UTC-5): 15:00Z = 10:00 in Chicago, 06:00Z = 01:00.
const DAYTIME = new Date('2026-09-29T15:00:00Z')
const NIGHT = new Date('2026-09-29T06:00:00Z')

const ev = (body: Record<string, unknown>): PoolEvent => {
  const r = sanitizePoolEvent(body)
  if (!r.ok) throw new Error(r.error)
  return r.event
}

describe('pool events: sanitising', () => {
  it('keeps ids and times, drops anything that could be a username', () => {
    const e = ev({ id: 'e1', type: 'challenge.created', challenge: { id: 'ch-9', type: 'image', account: 'acct-3', createdAt: '2026-09-29T15:00:00Z', expiresAt: '2026-09-29T17:00:00Z' }, reason: 'login as someone@example.com failed', username: 'secret-user', password: 'x' })
    expect(e).toEqual({
      eventId: 'e1',
      type: 'challenge.created',
      challengeId: 'ch-9',
      accountId: 'acct-3',
      challengeType: 'image',
      createdAt: '2026-09-29T15:00:00.000Z',
      expiresAt: '2026-09-29T17:00:00.000Z',
      phoneInitiated: false,
      reason: 'login as [redacted] failed',
    })
    expect(JSON.stringify(e)).not.toMatch(/secret-user|someone@/)
    expect(ev({ type: 'account.flagged', accountId: 'real.person.name' }).accountId).toBeNull()
    expect(ev({ type: 'challenge.created', challengeId: 'c1', priority: 'phone' }).phoneInitiated).toBe(true)
  })

  it('rejects unknown types and challenge events without a challenge id', () => {
    expect(sanitizePoolEvent({ type: 'nope' }).ok).toBe(false)
    expect(sanitizePoolEvent({ type: 'challenge.created' }).ok).toBe(false)
    expect(sanitizePoolEvent([]).ok).toBe(false)
  })
})

describe('quiet hours: 23:00-08:00 America/Chicago', () => {
  it('follows Chicago time, DST included', () => {
    expect(inQuietHours(new Date('2026-09-29T03:59:00Z'))).toBe(false) // 22:59 CDT
    expect(inQuietHours(new Date('2026-09-29T04:00:00Z'))).toBe(true) // 23:00 CDT
    expect(inQuietHours(new Date('2026-09-29T12:59:00Z'))).toBe(true) // 07:59 CDT
    expect(inQuietHours(new Date('2026-09-29T13:00:00Z'))).toBe(false) // 08:00 CDT
    expect(inQuietHours(new Date('2026-12-15T04:30:00Z'))).toBe(false) // 22:30 CST
    expect(inQuietHours(new Date('2026-12-15T05:00:00Z'))).toBe(true) // 23:00 CST
  })
})

describe('receivePoolEvent', () => {
  it('a daytime challenge is stored and pushed with a link to the captcha page', async () => {
    const env = await makeEnv()
    const push = pushService()
    const r = await receivePoolEvent(env, ev({ id: 'e1', type: 'challenge.created', challengeId: 'ch 1'.replace(' ', '-'), accountId: 'acct-2', challengeType: 'checkbox' }), { now: DAYTIME, fetchImpl: push.fetchImpl })
    expect(r).toMatchObject({ duplicate: false, push: 'sent' })
    expect(push.sent).toEqual(['https://push.example/device-1'])
    expect(poolEventPushPayload(ev({ type: 'challenge.created', challengeId: 'ch-1' }))!.url).toBe('/subscriptions/captcha/ch-1')
    const [stored] = await listPoolEvents(env)
    expect(stored).toMatchObject({ type: 'challenge.created', challengeId: 'ch-1', accountId: 'acct-2', pushStatus: 'sent' })
    // Retries of the same event id are stored and pushed once.
    const again = await receivePoolEvent(env, ev({ id: 'e1', type: 'challenge.created', challengeId: 'ch-1' }), { now: DAYTIME, fetchImpl: push.fetchImpl })
    expect(again).toMatchObject({ duplicate: true, push: 'sent' })
    expect(push.sent).toHaveLength(1)
    expect(await listPoolEvents(env)).toHaveLength(1)
  })

  it('at night: a phone-initiated challenge still pushes; a background one waits for 08:00 and is dropped if it expired', async () => {
    const env = await makeEnv()
    const push = pushService()
    expect((await receivePoolEvent(env, ev({ type: 'challenge.created', challengeId: 'phone-1', phoneInitiated: true }), { now: NIGHT, fetchImpl: push.fetchImpl })).push).toBe('sent')
    expect((await receivePoolEvent(env, ev({ type: 'challenge.created', challengeId: 'bg-1', expiresAt: '2026-09-29T08:00:00Z' }), { now: NIGHT, fetchImpl: push.fetchImpl })).push).toBe('quiet_deferred')
    expect((await receivePoolEvent(env, ev({ type: 'challenge.created', challengeId: 'bg-2', expiresAt: '2026-09-29T20:00:00Z' }), { now: NIGHT, fetchImpl: push.fetchImpl })).push).toBe('quiet_deferred')
    expect((await receivePoolEvent(env, ev({ type: 'account.flagged', accountId: 'acct-5', reason: 'decoys' }), { now: NIGHT, fetchImpl: push.fetchImpl })).push).toBe('quiet_deferred')
    expect(push.sent).toHaveLength(1)
    // Still night: nothing goes out.
    expect(await flushDeferredPoolPushes(env, { now: new Date('2026-09-29T07:00:00Z'), fetchImpl: push.fetchImpl })).toEqual({ sent: 0, expired: 0 })
    // 08:30 Chicago: bg-1 expired at 03:00 → dropped; bg-2 still open → pushed; the flagged account → pushed.
    const r = await flushDeferredPoolPushes(env, { now: new Date('2026-09-29T13:30:00Z'), fetchImpl: push.fetchImpl })
    expect(r).toEqual({ sent: 2, expired: 1 })
    expect(push.sent).toHaveLength(3)
    const byId = Object.fromEntries((await listPoolEvents(env)).map((e) => [e.challengeId ?? e.accountId, e.pushStatus]))
    expect(byId).toEqual({ 'phone-1': 'sent', 'bg-1': 'expired', 'bg-2': 'sent', 'acct-5': 'sent' })
  })

  it('a deferred challenge solved in the meantime is not pushed', async () => {
    const env = await makeEnv()
    const push = pushService()
    await receivePoolEvent(env, ev({ type: 'challenge.created', challengeId: 'c7' }), { now: NIGHT, fetchImpl: push.fetchImpl })
    expect((await receivePoolEvent(env, ev({ type: 'challenge.solved', challengeId: 'c7' }), { now: NIGHT, fetchImpl: push.fetchImpl })).push).toBe('none')
    expect(await flushDeferredPoolPushes(env, { now: DAYTIME, fetchImpl: push.fetchImpl })).toEqual({ sent: 0, expired: 1 })
    expect(push.sent).toEqual([])
  })

  it('account.flagged links to the accounts page (or the captcha when it names one)', () => {
    expect(poolEventPushPayload(ev({ type: 'account.flagged', accountId: 'acct-1' }))).toMatchObject({ kind: 'pool_account', url: '/subscriptions/accounts' })
    expect(poolEventPushPayload(ev({ type: 'account.flagged', accountId: 'acct-1', challengeId: 'c2' }))!.url).toBe('/subscriptions/captcha/c2')
    expect(poolEventPushPayload(ev({ type: 'account.created', accountId: 'acct-1' }))).toBeNull()
  })
})

describe('POST /pool/events (bearer TLPOOL_TOKEN)', () => {
  const post = (env: Env, body: unknown, token?: string) =>
    app.request('http://x/pool/events', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }, env)

  it('refuses a missing or wrong token (the Tasker token included)', async () => {
    const env = await makeEnv()
    expect((await post(env, { type: 'account.created' })).status).toBe(401)
    expect((await post(env, { type: 'account.created' }, 'tasker')).status).toBe(401)
    expect((await post(env, { type: 'account.created' }, 'wrong')).status).toBe(401)
  })

  it('stores a valid event and answers 400 on a bad one', async () => {
    const env = await makeEnv({ VAPID_PUBLIC_KEY: undefined })
    const ok = await post(env, { id: 'x1', type: 'account.created', accountId: 'acct-4' }, 'pool-secret')
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, duplicate: false, push: 'none' })
    const flagged = await post(env, { type: 'account.flagged', accountId: 'acct-4' }, 'pool-secret')
    expect(await flagged.json()).toMatchObject({ push: 'not_configured' })
    expect((await post(env, { type: 'bogus' }, 'pool-secret')).status).toBe(400)
    expect(await listPoolEvents(env)).toHaveLength(2)
  })
})

describe('GET/PUT /subscriptions/api/pool/settings (behind Cloudflare Access)', () => {
  const call = (env: Env, method: string, body?: unknown) =>
    app.request('http://x/subscriptions/api/pool/settings', { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, env)

  it('is gated by Cloudflare Access', async () => {
    const env = await makeEnv({ CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CF_ACCESS_AUD: 'aud', CF_ACCESS_ALLOWED_EMAILS: 'a@example.com' })
    const r = await call(env, 'GET')
    expect([401, 403]).toContain(r.status)
  })

  it('reads defaults, applies a partial update, and rejects an invalid one', async () => {
    const env = await makeEnv({ DEV_BYPASS_CF_ACCESS: '1' })
    const got = (await (await call(env, 'GET')).json()) as { settings: { tick: unknown }; defaults: unknown }
    expect(got.settings.tick).toEqual({ minItems: 0, maxItems: 3 })
    expect(got.defaults).toEqual(got.settings)
    const put = await call(env, 'PUT', { tick: { maxItems: 6 }, recheck: { beyondIntervalHours: 8760 } })
    expect(put.status).toBe(200)
    expect(((await put.json()) as { settings: { tick: unknown } }).settings.tick).toEqual({ minItems: 0, maxItems: 6 })
    const bad = await call(env, 'PUT', { tick: { maxItems: 99 } })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ error: 'invalid_settings' })
    expect(((await (await call(env, 'GET')).json()) as { settings: { tick: unknown } }).settings.tick).toEqual({ minItems: 0, maxItems: 6 })
  })
})
