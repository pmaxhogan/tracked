import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import { poolSettingsApp } from '../src/routes/pool-api'
import type { PoolSettings } from '../src/lib/pool-settings'
import vm from 'node:vm'
import { app as mainApp } from '../src/index'
import { createPoolUiApp, POOL_PAGES } from '../src/routes/pool-ui'
import { normalizeAccount, normalizeChallenge, type Fetcher } from '../src/lib/pool-admin-client'
import type { Env } from '../src/types'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'

const TOKEN = 'tlpool-secret-token-5c1e'
const POOL = 'https://tlpool.nas.example.internal'

function makeEnv(extra: Record<string, unknown> = {}): Env {
  return {
    CACHE: fakeKV(),
    SUBS: fakeKV(),
    DB: fakeD1(),
    API_TOKEN: 't',
    YOUTUBE_API_KEY: 'k',
    DEV_BYPASS_CF_ACCESS: '1',
    TLPOOL_URL: POOL,
    TLPOOL_TOKEN: TOKEN,
    ...extra,
  } as unknown as Env
}

type Call = { url: string; method: string; headers: Headers; body: unknown; signal: AbortSignal | null | undefined }

/** A fake tlpool: `routes` maps "METHOD /path" (query stripped) to a responder. */
function fakePool(routes: Record<string, (call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = []
  const fetcher: Fetcher = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    const call = { url, method, headers, body, signal: init?.signal }
    calls.push(call)
    const path = url.slice(POOL.length).split('?')[0]
    const h = routes[`${method} ${path}`]
    if (!h) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } })
    return h(call)
  }
  return { fetcher, calls }
}

const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } })

type Appl = { request: (input: string, init?: RequestInit, env?: Env) => Response | Promise<Response> }

function mount(fetcher: Fetcher) {
  const root = new Hono<{ Bindings: Env }>()
  root.route('/subscriptions', createPoolUiApp({ fetcher }))
  return root
}

async function req(appl: Appl, path: string, init: RequestInit = {}, env = makeEnv()) {
  const r = await appl.request(`https://tracked.example${path}`, init, env)
  const text = await r.text()
  return { r, text, data: (() => { try { return JSON.parse(text) } catch { return null } })() }
}

/** Neither the token nor the pool's address may reach the browser: body or any header. */
function expectNoLeak(r: Response, text: string) {
  expect(text).not.toContain(TOKEN)
  expect(text).not.toContain('tlpool.nas.example')
  r.headers.forEach((v) => {
    expect(v).not.toContain(TOKEN)
    expect(v).not.toContain('tlpool.nas.example')
  })
}

// Upstream fixtures deliberately carry credential fields: the Worker must drop them.
const SECRET_USER = 'dj_fan_marta88'
const SECRET_EMAIL = 'marta@owner-domain.example'
const SECRET_PASS = 'hunter2-p4ss'
const upstreamAccount = (id: string, extra: Record<string, unknown> = {}) => ({
  id, state: 'active', passive: false, exit_label: 'ifog-2', exit_kind: 'own', used_today: 12, budget: 30, ramp_day: 3,
  last_ok_at: '2026-09-29T10:00:00Z', last_challenge_at: null, flagged: false,
  username: SECRET_USER, email: SECRET_EMAIL, password: SECRET_PASS, cookies: 'session=abc',
  ...extra,
})
const upstreamChallenge = (id: string, extra: Record<string, unknown> = {}) => ({
  id, type: 'image', account: 'acct-3', reason: 'fetch', state: 'pending',
  createdAt: '2026-09-29T11:00:00Z', expiresAt: '2026-09-29T13:00:00Z', username: SECRET_USER, ...extra,
})

function expectNoCredentials(text: string) {
  expect(text).not.toContain(SECRET_USER)
  expect(text).not.toContain(SECRET_EMAIL)
  expect(text).not.toContain(SECRET_PASS)
  expect(text).not.toContain('session=abc')
}

function expectAuthed(call: Call | undefined) {
  expect(call).toBeDefined()
  expect(call!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
  // The browser's Access credentials never travel on to the NAS.
  expect(call!.headers.get('cookie')).toBeNull()
  expect(call!.headers.get('cf-access-jwt-assertion')).toBeNull()
}

const browserHeaders = { Cookie: 'CF_Authorization=browser-jwt', 'Cf-Access-Jwt-Assertion': 'browser-jwt' }

afterEach(() => vi.unstubAllGlobals())

describe('pool UI: Cloudflare Access gate', () => {
  const paths: Array<[string, string]> = [
    ['GET', '/subscriptions/pool'],
    ['GET', '/subscriptions/pool/settings'],
    ['GET', '/subscriptions/captcha'],
    ['GET', '/subscriptions/captcha/ch-1'],
    ['GET', '/subscriptions/api/pool/status'],
    ['GET', '/subscriptions/api/pool/accounts'],
    ['POST', '/subscriptions/api/pool/accounts'],
    ['POST', '/subscriptions/api/pool/accounts/acct-1/retire'],
    ['GET', '/subscriptions/api/pool/challenges'],
    ['GET', '/subscriptions/api/pool/challenges/ch-1'],
    ['GET', '/subscriptions/api/pool/challenges/ch-1/image'],
    ['POST', '/subscriptions/api/pool/challenges/ch-1/answer'],
    ['GET', '/subscriptions/api/pool/challenges/ch-1/live/'],
    ['GET', '/subscriptions/api/pool/limits'],
    ['PUT', '/subscriptions/api/pool/limits'],
  ]
  it.each(paths)('%s %s answers 401 without an Access token, through the real app, and never calls tlpool', async (method, path) => {
    const fetchSpy = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchSpy)
    const env = makeEnv({ DEV_BYPASS_CF_ACCESS: undefined, CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CF_ACCESS_AUD: 'aud', CF_ACCESS_ALLOWED_EMAILS: 'owner@example.com' })
    // A same-origin JSON request (the CSRF guard lets it through), so the Access gate is what answers.
    const init = method === 'GET' ? { method } : { method, headers: { 'Sec-Fetch-Site': 'same-origin', 'content-type': 'application/json' }, body: '{}' }
    const { r, text } = await req(mainApp, path, init, env)
    expect(r.status).toBe(401)
    expect(fetchSpy).not.toHaveBeenCalled()
    expectNoLeak(r, text)
  })

  it('is mounted in the real app (bypass on) and the main page links to it', async () => {
    const { r, text } = await req(mainApp, '/subscriptions/pool')
    expect(r.status).toBe(200)
    expect(text).toContain('Pool accounts')
    const main = await req(mainApp, '/subscriptions')
    expect(main.text).toContain('href="/subscriptions/pool"')
  })
})

describe('pool UI: error mapping', () => {
  it('503 pool_not_configured when TLPOOL_URL/TOKEN are unset, without calling out', async () => {
    const { fetcher, calls } = fakePool({})
    const { r, data } = await req(mount(fetcher), '/subscriptions/api/pool/status', {}, makeEnv({ TLPOOL_URL: undefined }))
    expect(r.status).toBe(503)
    expect(data).toEqual({ error: 'pool_not_configured' })
    expect(calls).toHaveLength(0)
  })

  it('503 pool_unreachable when the fetch throws, and the thrown message (which names the URL) is not echoed', async () => {
    const fetcher: Fetcher = async (u) => { throw new Error(`connect ECONNREFUSED ${String(u)} Bearer ${TOKEN}`) }
    const { r, text, data } = await req(mount(fetcher), '/subscriptions/api/pool/accounts')
    expect(r.status).toBe(503)
    expect(data).toEqual({ error: 'pool_unreachable' })
    expectNoLeak(r, text)
  })

  it('upstream 401/403 become 503 pool_auth_failed (a 401 would look like an Access failure)', async () => {
    for (const status of [401, 403]) {
      const { fetcher } = fakePool({ 'GET /status': () => json({ error: 'bad_token' }, status) })
      const { r, data } = await req(mount(fetcher), '/subscriptions/api/pool/status')
      expect(r.status).toBe(503)
      expect(data.error).toBe('pool_auth_failed')
    }
  })

  it('upstream 5xx becomes 503 pool_error; an upstream body echoing secrets is not passed through', async () => {
    const { fetcher } = fakePool({ 'GET /accounts': () => json({ error: 'db_locked', message: `token ${TOKEN} at ${POOL}`, username: SECRET_USER }, 500, { 'set-cookie': 'x=1' }) })
    const { r, text, data } = await req(mount(fetcher), '/subscriptions/api/pool/accounts')
    expect(r.status).toBe(503)
    expect(data).toEqual({ error: 'pool_error', detail: 'db_locked' })
    expect(r.headers.get('set-cookie')).toBeNull()
    expectNoLeak(r, text)
    expectNoCredentials(text)
  })

  it('upstream 404/409/410 keep their status with our own code; non-snake detail is dropped', async () => {
    const cases: Array<[number, string]> = [[404, 'not_found'], [409, 'conflict'], [410, 'expired']]
    for (const [status, code] of cases) {
      const { fetcher } = fakePool({ 'GET /challenges/ch-9': () => json({ error: 'Some <b>HTML</b> text' }, status) })
      const { r, data } = await req(mount(fetcher), '/subscriptions/api/pool/challenges/ch-9')
      expect(r.status).toBe(status)
      expect(data).toEqual({ error: code })
    }
  })

  it('a non-JSON 200 is bad_response, not a crash', async () => {
    const { fetcher } = fakePool({ 'GET /status': () => new Response('<html>tunnel error</html>', { status: 200 }) })
    const { r, data } = await req(mount(fetcher), '/subscriptions/api/pool/status')
    expect(r.status).toBe(503)
    expect(data.error).toBe('bad_response')
  })
})

describe('pool UI: accounts and status', () => {
  it('GET /api/pool/status returns whitelisted accounts, totals and pending challenges', async () => {
    const { fetcher, calls } = fakePool({
      'GET /status': () => json({
        accounts: [upstreamAccount('acct-1'), upstreamAccount('acct-2', { state: 'flagged', passive: true, flag_reason: 'decoy_names' })],
        queue_depth: { phone: 1, new: 4, backfill: 7 },
        totals: { requests_today: 88, by_priority: { phone: 3, new: 40, verify: 20, recheck: 20, backfill: 5 } },
      }),
      'GET /challenges': () => json([upstreamChallenge('ch-1')]),
    })
    const { r, text, data } = await req(mount(fetcher), '/subscriptions/api/pool/status', { headers: browserHeaders })
    expect(r.status).toBe(200)
    expect(calls.map((c) => c.url).sort()).toEqual([`${POOL}/challenges`, `${POOL}/status`])
    calls.forEach(expectAuthed)
    expect(data.status.accounts[0]).toEqual({
      id: 'acct-1', state: 'active', passive: false, exitLabel: 'ifog-2', exitKind: 'own', usedToday: 12, budget: 30, rampDay: 3,
      lastOkAt: '2026-09-29T10:00:00.000Z', lastChallengeAt: null, flagged: false, flagReason: null, restUntil: null,
    })
    expect(data.status.accounts[1]).toMatchObject({ id: 'acct-2', flagged: true, passive: true, flagReason: 'decoy_names' })
    expect(data.status.queueDepth).toBe(12)
    expect(data.status.requestsToday).toBe(88)
    expect(data.status.requestsByPriority.new).toBe(40)
    expect(data.challenges[0]).toMatchObject({ id: 'ch-1', type: 'image', accountId: 'acct-3', reason: 'fetch', state: 'pending' })
    expectNoCredentials(text)
    expectNoLeak(r, text)
  })

  it('status still answers when only the challenge list fails', async () => {
    const { fetcher } = fakePool({ 'GET /status': () => json({ accounts: [] }), 'GET /challenges': () => json({}, 500) })
    const { r, data } = await req(mount(fetcher), '/subscriptions/api/pool/status')
    expect(r.status).toBe(200)
    expect(data.challenges).toEqual([])
    expect(data.challengesError).toBe('pool_error')
  })

  it('GET /api/pool/accounts lists without credentials', async () => {
    const { fetcher, calls } = fakePool({ 'GET /accounts': () => json({ accounts: [upstreamAccount('acct-7')] }) })
    const { r, text, data } = await req(mount(fetcher), '/subscriptions/api/pool/accounts')
    expect(r.status).toBe(200)
    expect(data.accounts.map((a: { id: string }) => a.id)).toEqual(['acct-7'])
    expectAuthed(calls[0])
    expectNoCredentials(text)
  })

  it('POST /api/pool/accounts starts a signup with only {passive}', async () => {
    const { fetcher, calls } = fakePool({ 'POST /accounts': () => json({ challengeId: 'ch-new', accountId: 'acct-9', username: SECRET_USER }) })
    const { r, text, data } = await req(mount(fetcher), '/subscriptions/api/pool/accounts', {
      method: 'POST', headers: { 'content-type': 'application/json', ...browserHeaders }, body: JSON.stringify({ passive: true, username: 'injected' }),
    })
    expect(r.status).toBe(200)
    expect(data).toEqual({ challengeId: 'ch-new', accountId: 'acct-9' })
    expect(calls[0]!.body).toEqual({ passive: true })
    expectAuthed(calls[0])
    expectNoCredentials(text)
  })

  it('POST /api/pool/accounts treats anything but passive:true as false', async () => {
    const { fetcher, calls } = fakePool({ 'POST /accounts': () => json({ challenge_id: 'ch-2' }) })
    const { data } = await req(mount(fetcher), '/subscriptions/api/pool/accounts', { method: 'POST', body: JSON.stringify({ passive: 'yes' }), headers: { 'content-type': 'application/json' } })
    expect(calls[0]!.body).toEqual({ passive: false })
    expect(data).toEqual({ challengeId: 'ch-2', accountId: null })
  })

  it.each(['rest', 'retire', 'retest'])('POST /api/pool/accounts/:id/%s maps to the lifecycle route', async (action) => {
    const { fetcher, calls } = fakePool({ [`POST /accounts/acct-4/${action}`]: () => json({ account: upstreamAccount('acct-4', { state: 'resting' }) }) })
    const { r, text, data } = await req(mount(fetcher), `/subscriptions/api/pool/accounts/acct-4/${action}`, { method: 'POST' })
    expect(r.status).toBe(200)
    expect(data.ok).toBe(true)
    expect(data.account.state).toBe('resting')
    expect(calls[0]!.url).toBe(`${POOL}/accounts/acct-4/${action}`)
    expectAuthed(calls[0])
    expectNoCredentials(text)
  })

  it('an action with an empty 204 body still succeeds', async () => {
    const { fetcher } = fakePool({ 'POST /accounts/acct-4/rest': () => new Response(null, { status: 204 }) })
    const { r, data } = await req(mount(fetcher), '/subscriptions/api/pool/accounts/acct-4/rest', { method: 'POST' })
    expect(r.status).toBe(200)
    expect(data).toEqual({ ok: true, account: null })
  })

  it('unknown actions and malformed ids never reach tlpool', async () => {
    const { fetcher, calls } = fakePool({})
    expect((await req(mount(fetcher), '/subscriptions/api/pool/accounts/acct-4/delete', { method: 'POST' })).r.status).toBe(404)
    expect((await req(mount(fetcher), '/subscriptions/api/pool/accounts/acct%2F..%2Fsettings/rest', { method: 'POST' })).r.status).toBe(400)
    expect(calls).toHaveLength(0)
  })
})

describe('pool UI: challenges', () => {
  it('GET /api/pool/challenges and /:id normalise and fill a 2 h expiry when missing', async () => {
    const { fetcher, calls } = fakePool({
      'GET /challenges': () => json({ challenges: [upstreamChallenge('ch-1'), upstreamChallenge('ch-2', { type: 'checkbox' })] }),
      'GET /challenges/ch-3': () => json({ id: 'ch-3', type: 'image', account: 'acct-1', created_at: '2026-09-29T11:00:00Z', step: 'awaiting_captcha', reason: 'signup' }),
    })
    const list = await req(mount(fetcher), '/subscriptions/api/pool/challenges')
    expect(list.data.challenges.map((c: { type: string }) => c.type)).toEqual(['image', 'checkbox'])
    expectNoCredentials(list.text)
    const one = await req(mount(fetcher), '/subscriptions/api/pool/challenges/ch-3')
    expect(one.data.challenge).toMatchObject({ id: 'ch-3', step: 'awaiting_captcha', reason: 'signup', expiresAt: '2026-09-29T13:00:00.000Z', state: 'pending' })
    calls.forEach(expectAuthed)
  })

  it('GET image proxies the PNG with no-store, and refresh=1 asks for a new screenshot', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const { fetcher, calls } = fakePool({ 'GET /challenges/ch-1/image': () => new Response(png, { headers: { 'content-type': 'image/png', 'set-cookie': 'tl=1', server: 'uvicorn' } }) })
    const r = await mount(fetcher).request('https://tracked.example/subscriptions/api/pool/challenges/ch-1/image?refresh=1&t=1', { headers: browserHeaders }, makeEnv())
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/png')
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(r.headers.get('set-cookie')).toBeNull()
    expect(r.headers.get('server')).toBeNull()
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(png)
    expect(calls[0]!.url).toBe(`${POOL}/challenges/ch-1/image?refresh=1`)
    expectAuthed(calls[0])
    r.headers.forEach((v) => expect(v).not.toContain(TOKEN))
  })

  it('an image route that answers something other than an image is bad_response', async () => {
    const { fetcher } = fakePool({ 'GET /challenges/ch-1/image': () => new Response('<html>', { headers: { 'content-type': 'text/html' } }) })
    const { r, data } = await req(mount(fetcher), '/subscriptions/api/pool/challenges/ch-1/image')
    expect(r.status).toBe(503)
    expect(data.error).toBe('bad_response')
  })

  it('POST answer forwards {text} and normalises the outcome', async () => {
    const cases: Array<[() => Response, string]> = [
      [() => json({ status: 'solved' }), 'solved'],
      [() => json({ correct: false }), 'wrong'],
      [() => json({ error: 'wrong_answer' }, 422), 'wrong'],
      [() => json({ error: 'expired' }, 410), 'expired'],
      [() => json({ error: 'not_found' }, 404), 'expired'],
      [() => json({ status: 'checking' }), 'accepted'],
    ]
    for (const [resp, outcome] of cases) {
      const { fetcher, calls } = fakePool({ 'POST /challenges/ch-1/answer': resp })
      const { r, data } = await req(mount(fetcher), '/subscriptions/api/pool/challenges/ch-1/answer', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '  xK4p9 ' }),
      })
      expect(r.status).toBe(200)
      expect(data).toEqual({ outcome })
      expect(calls[0]!.body).toEqual({ text: 'xK4p9' })
      expectAuthed(calls[0])
    }
  })

  it('an empty answer is rejected before tlpool', async () => {
    const { fetcher, calls } = fakePool({})
    const { r } = await req(mount(fetcher), '/subscriptions/api/pool/challenges/ch-1/answer', { method: 'POST', body: JSON.stringify({ text: '  ' }), headers: { 'content-type': 'application/json' } })
    expect(r.status).toBe(400)
    expect(calls).toHaveLength(0)
  })
})

describe('pool UI: live view proxy', () => {
  it('/live redirects to /live/ so relative noVNC assets resolve', async () => {
    const { fetcher, calls } = fakePool({})
    const r = await mount(fetcher).request('https://tracked.example/subscriptions/api/pool/challenges/ch-1/live?autoconnect=1', {}, makeEnv())
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('/subscriptions/api/pool/challenges/ch-1/live/?autoconnect=1')
    expect(calls).toHaveLength(0)
  })

  it('proxies page and assets with whitelisted headers both ways', async () => {
    const { fetcher, calls } = fakePool({
      'GET /challenges/ch-1/live/': () => new Response('<html>novnc</html>', { headers: { 'content-type': 'text/html', 'set-cookie': 'a=b', 'x-internal': POOL } }),
      'GET /challenges/ch-1/live/core/rfb.js': () => new Response('js', { headers: { 'content-type': 'application/javascript' } }),
    })
    const page = await mount(fetcher).request('https://tracked.example/subscriptions/api/pool/challenges/ch-1/live/?autoconnect=1', { headers: browserHeaders }, makeEnv())
    expect(page.status).toBe(200)
    expect(await page.text()).toBe('<html>novnc</html>')
    expect(page.headers.get('set-cookie')).toBeNull()
    expect(page.headers.get('x-internal')).toBeNull()
    expect(page.headers.get('cache-control')).toBe('no-store')
    expect(calls[0]!.url).toBe(`${POOL}/challenges/ch-1/live/?autoconnect=1`)
    expectAuthed(calls[0])
    const asset = await mount(fetcher).request('https://tracked.example/subscriptions/api/pool/challenges/ch-1/live/core/rfb.js', {}, makeEnv())
    expect(asset.status).toBe(200)
    expect(calls[1]!.url).toBe(`${POOL}/challenges/ch-1/live/core/rfb.js`)
  })

  it('passes a websocket upgrade through with auth and no timeout (101 itself cannot be built outside workerd)', async () => {
    const upstream = new Response(null, { status: 200 })
    const { fetcher, calls } = fakePool({ 'GET /challenges/ch-1/live/websockify': () => upstream })
    await mount(fetcher).request('https://tracked.example/subscriptions/api/pool/challenges/ch-1/live/websockify', {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Protocol': 'binary', ...browserHeaders },
    }, makeEnv())
    const c = calls[0]!
    expect(c.url).toBe(`${POOL}/challenges/ch-1/live/websockify`)
    expect(c.headers.get('upgrade')).toBe('websocket')
    expect(c.headers.get('sec-websocket-key')).toBe('dGhlIHNhbXBsZSBub25jZQ==')
    expect(c.headers.get('sec-websocket-protocol')).toBe('binary')
    expect(c.signal).toBeUndefined()
    expectAuthed(c)
  })

  it('rejects odd sub-paths and maps upstream 404', async () => {
    const { fetcher, calls } = fakePool({})
    expect((await mount(fetcher).request('https://tracked.example/subscriptions/api/pool/challenges/ch-1/live/a%2F..%2Fb', {}, makeEnv())).status).toBe(400)
    expect(calls).toHaveLength(0)
    const gone = await req(mount(fetcher), '/subscriptions/api/pool/challenges/ch-1/live/vnc.html')
    expect(gone.r.status).toBe(404)
    expectNoLeak(gone.r, gone.text)
  })
})

describe('pool UI: tlpool settings (/api/pool/limits)', () => {
  it('GET normalises (percent share becomes a fraction)', async () => {
    const { fetcher, calls } = fakePool({ 'GET /settings': () => json({ budget_per_day: 30, ramp: [10, 20], reserved_phone_share: 15, image_policy: 'block', admin_password: SECRET_PASS }) })
    const { data, text } = await req(mount(fetcher), '/subscriptions/api/pool/limits')
    expect(data.settings).toEqual({ budgetPerDay: 30, ramp: [10, 20], reservedPhoneShare: 0.15, imagePolicy: 'block' })
    expectAuthed(calls[0])
    expectNoCredentials(text)
  })

  it('PUT validates and forwards only the four known fields', async () => {
    const { fetcher, calls } = fakePool({ 'PUT /settings': (c) => json(c.body) })
    const { r, data } = await req(mount(fetcher), '/subscriptions/api/pool/limits', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ budgetPerDay: 25, ramp: [8, 16], reservedPhoneShare: 0.2, imagePolicy: 'allow', token: 'x', exits: ['a'] }),
    })
    expect(r.status).toBe(200)
    expect(calls[0]!.method).toBe('PUT')
    expect(calls[0]!.body).toEqual({ budgetPerDay: 25, ramp: [8, 16], reservedPhoneShare: 0.2, imagePolicy: 'allow' })
    expect(data.settings.budgetPerDay).toBe(25)
    expectAuthed(calls[0])
  })

  it('PUT rejects bad values before tlpool', async () => {
    const { fetcher, calls } = fakePool({})
    for (const body of [{ budgetPerDay: -1 }, { budgetPerDay: 2.5 }, { ramp: 'x' }, { reservedPhoneShare: 0.95 }, { imagePolicy: 'Block<>' }, {}, null]) {
      const { r, data } = await req(mount(fetcher), '/subscriptions/api/pool/limits', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      expect(r.status).toBe(400)
      expect(data.error).toBe('invalid')
    }
    expect(calls).toHaveLength(0)
  })
})

describe('normalisers', () => {
  it('drop every field outside the whitelist', () => {
    const a = normalizeAccount(upstreamAccount('acct-1', { exit: { label: 'x', wgPrivateKey: 'k' } }))!
    expect(Object.keys(a).sort()).toEqual(['budget', 'exitKind', 'exitLabel', 'flagReason', 'flagged', 'id', 'lastChallengeAt', 'lastOkAt', 'passive', 'rampDay', 'restUntil', 'state', 'usedToday'])
    expect(JSON.stringify(a)).not.toContain('wgPrivateKey')
    const c = normalizeChallenge(upstreamChallenge('ch-1'))!
    expect(Object.keys(c).sort()).toEqual(['accountId', 'createdAt', 'error', 'expiresAt', 'id', 'reason', 'state', 'step', 'type'])
  })
  it('refuse ids that are not opaque tokens', () => {
    expect(normalizeAccount({ id: '../x' })).toBeNull()
    expect(normalizeChallenge({ id: 'ch-1', account: 'someone@example.com' })!.accountId).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HTML smoke tests: pages render, contain no credential fields, their inline
// scripts parse, and (run against a stub DOM wired to the real routes and a
// fake tlpool) they render sample data without any credential.
// ─────────────────────────────────────────────────────────────────────────────

const scriptsOf = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)

type StubEl = Record<string, unknown> & { innerHTML: string; textContent: string; value: string }
function stubEl(): StubEl {
  return {
    innerHTML: '', textContent: '', value: '', hidden: false, checked: false, disabled: false, className: '', src: '',
    dataset: {}, style: {}, options: [],
    handlers: {} as Record<string, (ev: unknown) => unknown>,
    addEventListener(this: { handlers: Record<string, unknown> }, type: string, fn: unknown) { this.handlers[type] = fn },
    focus() {}, add() {}, remove() {}, showModal() {}, close() {},
    querySelector: () => stubEl(), querySelectorAll: () => [], closest: () => null,
  }
}
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)) }

async function runPage(html: string, appl: Appl, env: Env) {
  const els = new Map<string, StubEl>()
  const document = {
    hidden: false,
    getElementById: (id: string) => { if (!els.has(id)) els.set(id, stubEl()); return els.get(id) },
    querySelector: () => null,
    addEventListener() {},
  }
  const fetchFromPage = async (path: string, init?: RequestInit) => appl.request(`https://tracked.example${path}`, init, env)
  const ctx = vm.createContext({
    document, fetch: fetchFromPage, setInterval: () => 0, clearInterval() {}, setTimeout: () => 0,
    Option: function (t: string, v: string) { return { text: t, value: v } }, console,
  })
  for (const s of scriptsOf(html)) vm.runInContext(s, ctx)
  await settle()
  return els
}

describe('pool pages: HTML smoke', () => {
  const pages: Array<[string, string]> = [
    ['/subscriptions/pool', 'Pool accounts'],
    ['/subscriptions/pool/settings', 'Pool settings'],
    ['/subscriptions/captcha', 'Captchas'],
    ['/subscriptions/captcha/ch-1', 'Captcha'],
  ]
  it.each(pages)('%s renders, is no-store, has no credential inputs, and its scripts parse', async (path, heading) => {
    const { fetcher } = fakePool({})
    const { r, text } = await req(mount(fetcher), path)
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(text).toContain(`<h1>${heading}`)
    expect(text).not.toMatch(/type=["']?password/i)
    expect(text).not.toMatch(/type=["']?email/i)
    expect(text).not.toMatch(/<input[^>]*(user|e-?mail|passw)/i)
    expect(text).not.toMatch(/autocomplete=["']?(username|email|current-password|new-password)/i)
    expect(text).not.toContain(TOKEN)
    for (const s of scriptsOf(text)) expect(() => new vm.Script(s)).not.toThrow()
    expect(text).toContain('/subscriptions/pool/settings') // nav
  })

  it('the captcha page embeds only a validated id', async () => {
    const { fetcher } = fakePool({})
    expect((await req(mount(fetcher), '/subscriptions/captcha/%3Cscript%3E')).r.status).toBe(404)
    expect(POOL_PAGES.captchaPageHtml('ch-1')).toContain('const ID = "ch-1"')
  })

  it('the pool page renders sample status, with no credential reaching the DOM', async () => {
    const { fetcher } = fakePool({
      'GET /status': () => json({
        accounts: [upstreamAccount('acct-1'), upstreamAccount('acct-2', { passive: true, state: 'flagged', flag_reason: 'decoy_names', rest_until: '2026-10-01T00:00:00Z' })],
        queue_depth: 3, totals: { requests_today: 41, by_priority: { new: 30, recheck: 11 } },
      }),
      'GET /challenges': () => json([upstreamChallenge('ch-7')]),
    })
    const appl = mount(fetcher)
    const els = await runPage(POOL_PAGES.POOL_PAGE_HTML, appl, makeEnv())
    const accts = els.get('accts')!.innerHTML
    expect(accts).toContain('acct-1')
    expect(accts).toContain('ifog-2')
    expect(accts).toContain('passive')
    expect(accts).toContain('flagged')
    expect(accts).toContain('data-act="retire"')
    expect(els.get('chals')!.innerHTML).toContain('/subscriptions/captcha/ch-7')
    expect(els.get('stats')!.innerHTML).toContain('41')
    const all = [...els.values()].map((e) => e.innerHTML + e.textContent).join('\n')
    expectNoCredentials(all)
    expect(all).not.toContain(TOKEN)
  })

  it('the Add account dialog starts a signup and embeds the captcha at the captcha step', async () => {
    const { fetcher, calls } = fakePool({
      'GET /status': () => json({ accounts: [] }),
      'GET /challenges': () => json([]),
      'POST /accounts': () => json({ challengeId: 'ch-s1', accountId: 'acct-12' }),
      'GET /challenges/ch-s1': () => json({ id: 'ch-s1', type: 'image', state: 'pending', step: 'awaiting_captcha', reason: 'signup', account: 'acct-12' }),
    })
    const els = await runPage(POOL_PAGES.POOL_PAGE_HTML, mount(fetcher), makeEnv())
    const passive = stubEl(); passive.checked = true; els.set('add-passive', passive)
    await (els.get('add-create')!.handlers as Record<string, () => Promise<void>>).click!()
    await settle()
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ passive: true })
    const steps = els.get('add-steps')!.innerHTML
    expect(steps).toMatch(/<li class="done">.*Exit assigned/)
    expect(steps).toMatch(/<li class="cur">.*Waiting for your captcha/)
    expect(els.get('add-captcha')!.hidden).toBe(false)
    expect(els.get('add-captcha')!.innerHTML).toContain('cap-img')
    expect(els.get('add-captcha')!.innerHTML).toContain('autofocus')
  })

  it('the Add account dialog shows a plain-words error with a retry', async () => {
    const { fetcher } = fakePool({ 'GET /status': () => json({ accounts: [] }), 'GET /challenges': () => json([]), 'POST /accounts': () => json({ error: 'no_free_exit' }, 409) })
    const els = await runPage(POOL_PAGES.POOL_PAGE_HTML, mount(fetcher), makeEnv())
    await (els.get('add-create')!.handlers as Record<string, () => Promise<void>>).click!()
    await settle()
    expect(els.get('add-msg')!.innerHTML).toContain('The pool is already busy doing that. (no free exit)')
    expect(els.get('add-retry')!.hidden).toBe(false)
  })

  it('the pool page shows a plain-words error when tlpool is down', async () => {
    const fetcher: Fetcher = async () => { throw new Error('down') }
    const els = await runPage(POOL_PAGES.POOL_PAGE_HTML, mount(fetcher), makeEnv())
    expect(els.get('err')!.textContent).toContain('did not answer')
  })

  it('the captcha list and captcha page render a sample challenge', async () => {
    const { fetcher } = fakePool({
      'GET /challenges': () => json([upstreamChallenge('ch-7', { expiresAt: new Date(Date.now() + 3600_000).toISOString() })]),
      'GET /challenges/ch-7': () => json(upstreamChallenge('ch-7', { expiresAt: new Date(Date.now() + 3600_000).toISOString() })),
    })
    const appl = mount(fetcher)
    const list = await runPage(POOL_PAGES.CAPTCHA_LIST_HTML, appl, makeEnv())
    expect(list.get('list')!.innerHTML).toContain('/subscriptions/captcha/ch-7')
    expect(list.get('list')!.innerHTML).toContain('acct-3')
    expect(list.get('list')!.innerHTML).toMatch(/min left/)
    const one = await runPage(POOL_PAGES.captchaPageHtml('ch-7'), appl, makeEnv())
    expect(one.get('head')!.innerHTML).toContain('acct-3')
    expect(one.get('head')!.innerHTML).toContain('While fetching a page')
    expect(one.get('widget')!.innerHTML).toContain('cap-img')
    expect(one.get('widget')!.innerHTML).toContain('Submit answer')
    expectNoCredentials([...list.values(), ...one.values()].map((e) => e.innerHTML).join())
  })

  it('a checkbox challenge shows the live view instead of an answer box', async () => {
    const { fetcher } = fakePool({ 'GET /challenges/ch-8': () => json(upstreamChallenge('ch-8', { type: 'checkbox' })) })
    const one = await runPage(POOL_PAGES.captchaPageHtml('ch-8'), mount(fetcher), makeEnv())
    const w = one.get('widget')!.innerHTML
    expect(w).toContain('Tap the checkbox')
    expect(w).toContain('/subscriptions/api/pool/challenges/ch-8/live/?')
    expect(w).not.toContain('Submit answer')
  })

  /** The UI next to W4's real settings routes, as index.ts mounts them. */
  function withSettingsApi(fetcher: Fetcher) {
    const appl = mount(fetcher)
    appl.route('/subscriptions/api/pool', poolSettingsApp)
    return appl
  }

  it('the settings page fills tlpool limits and the scheduler settings from the real /api/pool/settings shape', async () => {
    const { fetcher } = fakePool({ 'GET /settings': () => json({ budgetPerDay: 30, ramp: [10, 20], reservedPhoneShare: 0.1, imagePolicy: 'block' }) })
    const els = await runPage(POOL_PAGES.SETTINGS_PAGE_HTML, withSettingsApi(fetcher), makeEnv())
    expect(els.get('budget')!.value).toBe(30)
    expect(els.get('ramp2')!.value).toBe(20)
    expect(els.get('share')!.value).toBe(10)
    expect(els.get('sch-err')!.textContent).toBe('')
    expect(els.get('sch-save')!.disabled).toBe(false)
    const rows = els.get('sch-rows')!.innerHTML
    expect(rows).toContain('data-k="intervalHours" value="12"') // 0-2 d: 12 h
    expect(rows).toContain('data-k="maxAgeDays" value="180"')
    expect(els.get('beyond')!.value).toBe('') // never
    expect(els.get('over180')!.value).toBe(2160)
    expect(els.get('prios')!.innerHTML).toContain('Verification second fetches')
  })

  it('saving the settings page stores the schedule in the shape W4 validates, and a reload shows it', async () => {
    const { fetcher } = fakePool({ 'GET /settings': () => json({ budgetPerDay: 30 }) })
    const env = makeEnv()
    const appl = withSettingsApi(fetcher)
    const els = await runPage(POOL_PAGES.SETTINGS_PAGE_HTML, appl, env)
    els.get('beyond')!.value = '4320' as unknown as string
    await (els.get('sch')!.handlers as Record<string, (ev: unknown) => Promise<void>>).submit!({ preventDefault() {} })
    await settle()
    expect(els.get('sch-err')!.textContent).toBe('')
    expect(els.get('sch-msg')!.textContent).toBe('Saved.')
    const stored = (await (await appl.request('https://tracked.example/subscriptions/api/pool/settings', {}, env)).json()) as { settings: PoolSettings }
    expect(stored.settings.recheck.beyondIntervalHours).toBe(4320)
    expect(stored.settings.recheck.bands).toHaveLength(4) // untouched: the stub DOM has no table rows to send
    const again = await runPage(POOL_PAGES.SETTINGS_PAGE_HTML, appl, env)
    expect(again.get('beyond')!.value).toBe(4320)
  })

  it('an invalid value is refused with the validator\'s message', async () => {
    const { fetcher } = fakePool({ 'GET /settings': () => json({ budgetPerDay: 30 }) })
    const els = await runPage(POOL_PAGES.SETTINGS_PAGE_HTML, withSettingsApi(fetcher), makeEnv())
    els.get('over180')!.value = '-5' as unknown as string
    await (els.get('sch')!.handlers as Record<string, (ev: unknown) => Promise<void>>).submit!({ preventDefault() {} })
    await settle()
    expect(els.get('sch-err')!.textContent).toContain('recheck.beyondExceptionIntervalHours')
  })

  it('the settings page has no quiet hours any more', () => {
    expect(POOL_PAGES.SETTINGS_PAGE_HTML).not.toMatch(/quiet/i)
  })
})

describe('service worker', () => {
  it('opens the URL carried in the push payload on tap and keeps challenge pushes on screen', async () => {
    const { text } = await req(mainApp, '/subscriptions/sw.js')
    expect(text).toContain("addEventListener('notificationclick'")
    expect(text).toContain('data: { url: data.url')
    expect(text).toContain('self.clients.openWindow(target)')
    expect(text).toMatch(/requireInteraction:.*challenge/)
  })
})
