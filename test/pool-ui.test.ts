import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import { poolSettingsApp } from '../src/routes/pool-api'
import type { PoolSettings } from '../src/lib/pool-settings'
import vm from 'node:vm'
import { app as mainApp } from '../src/index'
import { createPoolUiApp, POOL_PAGES } from '../src/routes/pool-ui'
import { normalizeAccount, normalizeChallenge, type Fetcher } from '../src/lib/pool-admin-client'
import type { Env } from '../src/types'
import { receivePoolEvent, sanitizePoolEvent } from '../src/lib/pool-events'
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
  root.route('/ui', createPoolUiApp({ fetcher }))
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
  id, state: 'active', passive: false, exit_label: 'own-2', exit_kind: 'own', used_today: 12, budget: 30, ramp_day: 3,
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
    ['GET', '/ui/pool'],
    ['GET', '/ui/pool/settings'],
    ['GET', '/ui/captcha'],
    ['GET', '/ui/captcha/ch-1'],
    ['GET', '/ui/api/pool/status'],
    ['GET', '/ui/api/pool/accounts'],
    ['POST', '/ui/api/pool/accounts'],
    ['POST', '/ui/api/pool/accounts/acct-1/retire'],
    ['GET', '/ui/api/pool/accounts/acct-1/events'],
    ['GET', '/ui/api/pool/challenges'],
    ['GET', '/ui/api/pool/challenges/ch-1'],
    ['GET', '/ui/api/pool/challenges/ch-1/image'],
    ['POST', '/ui/api/pool/challenges/ch-1/answer'],
    ['GET', '/ui/api/pool/challenges/ch-1/live/'],
    ['GET', '/ui/api/pool/challenges/ch-1/live/core/rfb.js'],
    ['GET', '/ui/api/pool/challenges/ch-1/live/websockify'],
    ['GET', '/ui/api/pool/limits'],
    ['PUT', '/ui/api/pool/limits'],
  ]
  it.each(paths)('%s %s answers 401 without an Access token, through the real app, and never calls tlpool', async (method, path) => {
    const fetchSpy = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchSpy)
    const env = makeEnv({ DEV_BYPASS_CF_ACCESS: undefined, CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CF_ACCESS_AUD: 'aud', CF_ACCESS_ALLOWED_EMAILS: 'owner@example.com' })
    // A same-origin JSON request (the CSRF guard lets it through), so the Access gate is what answers.
    const init: RequestInit = method === 'GET'
      ? { method, ...(path.endsWith('/websockify') ? { headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' } } : {}) }
      : { method, headers: { 'Sec-Fetch-Site': 'same-origin', 'content-type': 'application/json' }, body: '{}' }
    const { r, text } = await req(mainApp, path, init, env)
    expect(r.status).toBe(401)
    expect(fetchSpy).not.toHaveBeenCalled()
    expectNoLeak(r, text)
  })

  it('is mounted in the real app (bypass on) and the main page links to it', async () => {
    const { r, text } = await req(mainApp, '/ui/pool')
    expect(r.status).toBe(200)
    expect(text).toContain('Pool accounts')
    expect(text).toMatch(/s === 'resting' \|\| s === 'new' \|\| s === 'creating' \? 'warn'/)
    expect(text).toMatch(/s === 'warming' \|\| s === 'ramping' \? 'info'/)
    const main = await req(mainApp, '/ui')
    expect(main.text).toContain('href="/ui/pool"')
  })
})

describe('pool UI: error mapping', () => {
  it('503 pool_not_configured when TLPOOL_URL/TOKEN are unset, without calling out', async () => {
    const { fetcher, calls } = fakePool({})
    const { r, data } = await req(mount(fetcher), '/ui/api/pool/status', {}, makeEnv({ TLPOOL_URL: undefined }))
    expect(r.status).toBe(503)
    expect(data).toEqual({ error: 'pool_not_configured' })
    expect(calls).toHaveLength(0)
  })

  it('503 pool_unreachable when the fetch throws, and the thrown message (which names the URL) is not echoed', async () => {
    const fetcher: Fetcher = async (u) => { throw new Error(`connect ECONNREFUSED ${String(u)} Bearer ${TOKEN}`) }
    const { r, text, data } = await req(mount(fetcher), '/ui/api/pool/accounts')
    expect(r.status).toBe(503)
    expect(data).toEqual({ error: 'pool_unreachable' })
    expectNoLeak(r, text)
  })

  it('upstream 401/403 become 503 pool_auth_failed (a 401 would look like an Access failure)', async () => {
    for (const status of [401, 403]) {
      const { fetcher } = fakePool({ 'GET /status': () => json({ error: 'bad_token' }, status) })
      const { r, data } = await req(mount(fetcher), '/ui/api/pool/status')
      expect(r.status).toBe(503)
      expect(data.error).toBe('pool_auth_failed')
    }
  })

  it('upstream 5xx becomes 503 pool_error; an upstream body echoing secrets is not passed through', async () => {
    const { fetcher } = fakePool({ 'GET /accounts': () => json({ error: 'db_locked', message: `token ${TOKEN} at ${POOL}`, username: SECRET_USER }, 500, { 'set-cookie': 'x=1' }) })
    const { r, text, data } = await req(mount(fetcher), '/ui/api/pool/accounts')
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
      const { r, data } = await req(mount(fetcher), '/ui/api/pool/challenges/ch-9')
      expect(r.status).toBe(status)
      expect(data).toEqual({ error: code })
    }
  })

  it('a non-JSON 200 is bad_response, not a crash', async () => {
    const { fetcher } = fakePool({ 'GET /status': () => new Response('<html>tunnel error</html>', { status: 200 }) })
    const { r, data } = await req(mount(fetcher), '/ui/api/pool/status')
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
    const { r, text, data } = await req(mount(fetcher), '/ui/api/pool/status', { headers: browserHeaders })
    expect(r.status).toBe(200)
    expect(calls.map((c) => c.url).sort()).toEqual([`${POOL}/challenges`, `${POOL}/status`])
    calls.forEach(expectAuthed)
    expect(data.status.accounts[0]).toEqual({
      id: 'acct-1', state: 'active', passive: false, exitLabel: 'own-2', exitKind: 'own', usedToday: 12, budget: 30, rampDay: 3,
      lastOkAt: '2026-09-29T10:00:00.000Z', lastChallengeAt: null, flagged: false, flagReason: null, restUntil: null, xhrUsedToday: null, xhrBudget: null, signupChallengeId: null,
      stateChangedAt: null, restReason: null, retestPending: false, createdAt: null, activatedAt: null, retiredAt: null, submittedAt: null,
      lastError: null, exitProblem: null, pendingChallengeId: null, canRetrySignup: false, busy: null, queued: false, scheduledAt: null, attempts: null,
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
    const { r, data } = await req(mount(fetcher), '/ui/api/pool/status')
    expect(r.status).toBe(200)
    expect(data.challenges).toEqual([])
    expect(data.challengesError).toBe('pool_error')
  })

  it('GET /api/pool/accounts lists without credentials', async () => {
    const { fetcher, calls } = fakePool({ 'GET /accounts': () => json({ accounts: [upstreamAccount('acct-7')] }) })
    const { r, text, data } = await req(mount(fetcher), '/ui/api/pool/accounts')
    expect(r.status).toBe(200)
    expect(data.accounts.map((a: { id: string }) => a.id)).toEqual(['acct-7'])
    expectAuthed(calls[0])
    expectNoCredentials(text)
  })

  it('POST /api/pool/accounts starts a signup with only {passive}', async () => {
    const { fetcher, calls } = fakePool({ 'POST /accounts': () => json({ challengeId: 'ch-new', accountId: 'acct-9', username: SECRET_USER }) })
    const { r, text, data } = await req(mount(fetcher), '/ui/api/pool/accounts', {
      method: 'POST', headers: { 'content-type': 'application/json', ...browserHeaders }, body: JSON.stringify({ passive: true, username: 'injected' }),
    })
    expect(r.status).toBe(200)
    expect(data).toEqual({ challengeId: 'ch-new', accountId: 'acct-9' })
    expect(calls[0]!.body).toEqual({ passive: true })
    expectAuthed(calls[0])
    expectNoCredentials(text)
  })

  it('POST /api/pool/accounts forwards a valid exitKind, omits auto, and rejects anything else', async () => {
    const { fetcher, calls } = fakePool({ 'POST /accounts': () => json({ challengeId: 'ch-x' }) })
    const appl = mount(fetcher)
    const post = (body: unknown) => req(appl, '/ui/api/pool/accounts', { method: 'POST', headers: { 'content-type': 'application/json', ...browserHeaders }, body: JSON.stringify(body) })
    for (const k of ['own', 'mullvad', 'airvpn']) {
      expect((await post({ exitKind: k })).r.status).toBe(200)
      expect(calls[calls.length - 1]!.body).toEqual({ passive: false, exitKind: k })
    }
    expect((await post({ passive: true, exitKind: 'auto' })).r.status).toBe(200)
    expect(calls[calls.length - 1]!.body).toEqual({ passive: true })
    const n = calls.length
    for (const bad of ['wireguard', '', 5, null, {}]) {
      const { r, data } = await post({ exitKind: bad })
      expect(r.status).toBe(400)
      expect(data).toMatchObject({ error: 'invalid', detail: 'bad_exit_kind' })
    }
    expect(calls.length).toBe(n)
  })

  it('POST /api/pool/accounts treats anything but passive:true as false', async () => {
    const { fetcher, calls } = fakePool({ 'POST /accounts': () => json({ challenge_id: 'ch-2' }) })
    const { data } = await req(mount(fetcher), '/ui/api/pool/accounts', { method: 'POST', body: JSON.stringify({ passive: 'yes' }), headers: { 'content-type': 'application/json' } })
    expect(calls[0]!.body).toEqual({ passive: false })
    expect(data).toEqual({ challengeId: 'ch-2', accountId: null })
  })

  it.each(['rest', 'retire', 'retest'])('POST /api/pool/accounts/:id/%s maps to the lifecycle route', async (action) => {
    const { fetcher, calls } = fakePool({ [`POST /accounts/acct-4/${action}`]: () => json({ account: upstreamAccount('acct-4', { state: 'resting' }) }) })
    const { r, text, data } = await req(mount(fetcher), `/ui/api/pool/accounts/acct-4/${action}`, { method: 'POST' })
    expect(r.status).toBe(200)
    expect(data.ok).toBe(true)
    expect(data.account.state).toBe('resting')
    expect(calls[0]!.url).toBe(`${POOL}/accounts/acct-4/${action}`)
    expectAuthed(calls[0])
    expectNoCredentials(text)
  })

  it('an action with an empty 204 body still succeeds', async () => {
    const { fetcher } = fakePool({ 'POST /accounts/acct-4/rest': () => new Response(null, { status: 204 }) })
    const { r, data } = await req(mount(fetcher), '/ui/api/pool/accounts/acct-4/rest', { method: 'POST' })
    expect(r.status).toBe(200)
    expect(data).toEqual({ ok: true, account: null })
  })

  it('unknown actions and malformed ids never reach tlpool', async () => {
    const { fetcher, calls } = fakePool({})
    expect((await req(mount(fetcher), '/ui/api/pool/accounts/acct-4/delete', { method: 'POST' })).r.status).toBe(404)
    expect((await req(mount(fetcher), '/ui/api/pool/accounts/acct%2F..%2Fsettings/rest', { method: 'POST' })).r.status).toBe(400)
    expect(calls).toHaveLength(0)
  })
})

describe('pool UI: challenges', () => {
  it('GET /api/pool/challenges and /:id normalise and fill a 2 h expiry when missing', async () => {
    const { fetcher, calls } = fakePool({
      'GET /challenges': () => json({ challenges: [upstreamChallenge('ch-1'), upstreamChallenge('ch-2', { type: 'checkbox' })] }),
      'GET /challenges/ch-3': () => json({ id: 'ch-3', type: 'image', account: 'acct-1', created_at: '2026-09-29T11:00:00Z', step: 'awaiting_captcha', reason: 'signup' }),
    })
    const list = await req(mount(fetcher), '/ui/api/pool/challenges')
    expect(list.data.challenges.map((c: { type: string }) => c.type)).toEqual(['image', 'checkbox'])
    expectNoCredentials(list.text)
    const one = await req(mount(fetcher), '/ui/api/pool/challenges/ch-3')
    expect(one.data.challenge).toMatchObject({ id: 'ch-3', step: 'awaiting_captcha', reason: 'signup', expiresAt: '2026-09-29T13:00:00.000Z', state: 'pending' })
    calls.forEach(expectAuthed)
  })

  it('GET image proxies the PNG with no-store, and refresh=1 asks for a new screenshot', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const { fetcher, calls } = fakePool({ 'GET /challenges/ch-1/image': () => new Response(png, { headers: { 'content-type': 'image/png', 'set-cookie': 'tl=1', server: 'uvicorn' } }) })
    const r = await mount(fetcher).request('https://tracked.example/ui/api/pool/challenges/ch-1/image?refresh=1&t=1', { headers: browserHeaders }, makeEnv())
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
    const { r, data } = await req(mount(fetcher), '/ui/api/pool/challenges/ch-1/image')
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
      const { r, data } = await req(mount(fetcher), '/ui/api/pool/challenges/ch-1/answer', {
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
    const { r } = await req(mount(fetcher), '/ui/api/pool/challenges/ch-1/answer', { method: 'POST', body: JSON.stringify({ text: '  ' }), headers: { 'content-type': 'application/json' } })
    expect(r.status).toBe(400)
    expect(calls).toHaveLength(0)
  })
})

describe('pool UI: live view proxy', () => {
  it('/live redirects to /live/ so relative noVNC assets resolve', async () => {
    const { fetcher, calls } = fakePool({})
    const r = await mount(fetcher).request('https://tracked.example/ui/api/pool/challenges/ch-1/live?autoconnect=1', {}, makeEnv())
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('/ui/api/pool/challenges/ch-1/live/?autoconnect=1')
    expect(calls).toHaveLength(0)
  })

  it('proxies page and assets with whitelisted headers both ways', async () => {
    const { fetcher, calls } = fakePool({
      'GET /challenges/ch-1/live/': () => new Response('<html>novnc</html>', { headers: { 'content-type': 'text/html', 'set-cookie': 'a=b', 'x-internal': POOL } }),
      'GET /challenges/ch-1/live/core/rfb.js': () => new Response('js', { headers: { 'content-type': 'application/javascript' } }),
    })
    const page = await mount(fetcher).request('https://tracked.example/ui/api/pool/challenges/ch-1/live/?autoconnect=1', { headers: browserHeaders }, makeEnv())
    expect(page.status).toBe(200)
    expect(await page.text()).toBe('<html>novnc</html>')
    expect(page.headers.get('set-cookie')).toBeNull()
    expect(page.headers.get('x-internal')).toBeNull()
    expect(page.headers.get('cache-control')).toBe('no-store')
    expect(calls[0]!.url).toBe(`${POOL}/challenges/ch-1/live/?autoconnect=1`)
    expectAuthed(calls[0])
    const asset = await mount(fetcher).request('https://tracked.example/ui/api/pool/challenges/ch-1/live/core/rfb.js', {}, makeEnv())
    expect(asset.status).toBe(200)
    expect(calls[1]!.url).toBe(`${POOL}/challenges/ch-1/live/core/rfb.js`)
  })

  it('passes a websocket upgrade through with auth and no timeout (101 itself cannot be built outside workerd)', async () => {
    const upstream = new Response(null, { status: 200 })
    const { fetcher, calls } = fakePool({ 'GET /challenges/ch-1/live/websockify': () => upstream })
    await mount(fetcher).request('https://tracked.example/ui/api/pool/challenges/ch-1/live/websockify', {
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
    expect((await mount(fetcher).request('https://tracked.example/ui/api/pool/challenges/ch-1/live/a%2F..%2Fb', {}, makeEnv())).status).toBe(400)
    expect(calls).toHaveLength(0)
    const gone = await req(mount(fetcher), '/ui/api/pool/challenges/ch-1/live/vnc.html')
    expect(gone.r.status).toBe(404)
    expectNoLeak(gone.r, gone.text)
  })
})

describe('pool UI: tlpool settings (/api/pool/limits)', () => {
  it('GET normalises (percent share becomes a fraction)', async () => {
    const { fetcher, calls } = fakePool({ 'GET /settings': () => json({ budget_per_day: 30, ramp: [10, 20], reserved_phone_share: 15, image_policy: 'block', admin_password: SECRET_PASS }) })
    const { data, text } = await req(mount(fetcher), '/ui/api/pool/limits')
    expect(data.settings).toEqual({ budgetPerDay: 30, ramp: [10, 20], reservedPhoneShare: 0.15, imagePolicy: 'block', xhrBudgetPerDay: null, priorityCeilings: null })
    expectAuthed(calls[0])
    expectNoCredentials(text)
  })

  it('PUT validates and forwards only the four known fields', async () => {
    const { fetcher, calls } = fakePool({ 'PUT /settings': (c) => json(c.body) })
    const { r, data } = await req(mount(fetcher), '/ui/api/pool/limits', {
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
    for (const body of [{ budgetPerDay: -1 }, { budgetPerDay: 2.5 }, { ramp: 'x' }, { reservedPhoneShare: 1.5 }, { budgetPerDay: 0 }, { budgetPerDay: 501 }, { imagePolicy: 'Block<>' }, { imagePolicy: 'sometimes' }, { xhrBudgetPerDay: -1 }, { priorityCeilings: { phone: 0.5 } }, { priorityCeilings: { backfill: 2 } }, {}, null]) {
      const { r, data } = await req(mount(fetcher), '/ui/api/pool/limits', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      expect(r.status).toBe(400)
      expect(data.error).toBe('invalid')
    }
    expect(calls).toHaveLength(0)
  })
})

describe('normalisers', () => {
  it('drop every field outside the whitelist', () => {
    const a = normalizeAccount(upstreamAccount('acct-1', { exit: { label: 'x', wgPrivateKey: 'k' } }))!
    expect(Object.keys(a).sort()).toEqual([
      'activatedAt', 'attempts', 'budget', 'busy', 'canRetrySignup', 'createdAt', 'exitKind', 'exitLabel', 'exitProblem', 'flagReason', 'flagged', 'id', 'lastChallengeAt', 'lastError', 'lastOkAt',
      'passive', 'pendingChallengeId', 'queued', 'rampDay', 'restReason', 'restUntil', 'retestPending', 'retiredAt', 'scheduledAt', 'signupChallengeId', 'state', 'stateChangedAt', 'submittedAt', 'usedToday', 'xhrBudget', 'xhrUsedToday',
    ])
    expect(JSON.stringify(a)).not.toContain('wgPrivateKey')
    const c = normalizeChallenge(upstreamChallenge('ch-1'))!
    expect(Object.keys(c).sort()).toEqual(['accountId', 'createdAt', 'error', 'expiresAt', 'id', 'ready', 'reason', 'state', 'step', 'type'])
  })
  it('reads passive from state when tlpool sends no passive field', () => {
    expect(normalizeAccount({ id: 'acct-1', state: 'passive' })!.passive).toBe(true)
    expect(normalizeAccount({ id: 'acct-2', state: 'active' })!.passive).toBe(false)
    expect(normalizeAccount({ id: 'acct-3', state: 'active', passive: true })!.passive).toBe(true)
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
    ['/ui/pool', 'Pool accounts'],
    ['/ui/pool/settings', 'Pool settings'],
    ['/ui/captcha', 'Captchas'],
    ['/ui/captcha/ch-1', 'Captcha'],
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
    expect(text).toContain('/ui/pool/settings') // nav
  })

  it('the captcha page embeds only a validated id', async () => {
    const { fetcher } = fakePool({})
    expect((await req(mount(fetcher), '/ui/captcha/%3Cscript%3E')).r.status).toBe(404)
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
    expect(accts).toContain('own-2')
    expect(accts).toContain('passive')
    expect(accts).toContain('flagged')
    expect(accts).toContain('data-act="retire"')
    expect(els.get('chals')!.innerHTML).toContain('/ui/captcha/ch-7')
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
    // tlpool's real refusal: 409 {error: no_exit_available, message}.
    const { fetcher } = fakePool({ 'GET /status': () => json({ accounts: [] }), 'GET /challenges': () => json([]), 'POST /accounts': () => json({ error: 'no_exit_available', message: 'no free exit in the registry' }, 409) })
    const els = await runPage(POOL_PAGES.POOL_PAGE_HTML, mount(fetcher), makeEnv())
    await (els.get('add-create')!.handlers as Record<string, () => Promise<void>>).click!()
    await settle()
    expect(els.get('add-msg')!.innerHTML).toContain('There is no free exit IP to pin a new account to. no free exit in the registry')
    expect(els.get('add-retry')!.hidden).toBe(false)
  })

  it('the Add account dialog has an Exit type select and sends the chosen kind', async () => {
    const html = POOL_PAGES.POOL_PAGE_HTML
    expect(html).toContain('<select id="add-exit">')
    for (const t of ['Auto (default)', 'Own IP', 'Mullvad', 'AirVPN']) expect(html).toContain(t)
    const { fetcher, calls } = fakePool({
      'GET /status': () => json({ accounts: [] }), 'GET /challenges': () => json([]),
      'POST /accounts': () => json({ challengeId: 'ch-e1' }),
      'GET /challenges/ch-e1': () => json({ id: 'ch-e1', type: 'image', state: 'pending', step: 'exit_assigned', reason: 'signup' }),
    })
    const els = await runPage(POOL_PAGES.POOL_PAGE_HTML, mount(fetcher), makeEnv())
    const sel = stubEl(); sel.value = 'mullvad'; els.set('add-exit', sel)
    await (els.get('add-create')!.handlers as Record<string, () => Promise<void>>).click!()
    await settle()
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ passive: false, exitKind: 'mullvad' })
  })

  it('the Add account dialog names a 409 no_free_exit plainly', async () => {
    const { fetcher } = fakePool({ 'GET /status': () => json({ accounts: [] }), 'GET /challenges': () => json([]), 'POST /accounts': () => json({ error: 'no_free_exit', message: 'no free mullvad exit' }, 409) })
    const els = await runPage(POOL_PAGES.POOL_PAGE_HTML, mount(fetcher), makeEnv())
    await (els.get('add-create')!.handlers as Record<string, () => Promise<void>>).click!()
    await settle()
    expect(els.get('add-msg')!.innerHTML).toContain('There is no free exit of that type')
    expect(els.get('add-msg')!.innerHTML).toContain('no free mullvad exit')
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
    expect(list.get('list')!.innerHTML).toContain('/ui/captcha/ch-7')
    expect(list.get('list')!.innerHTML).toContain('acct-3')
    expect(list.get('list')!.innerHTML).toMatch(/min left/)
    const one = await runPage(POOL_PAGES.captchaPageHtml('ch-7'), appl, makeEnv())
    expect(one.get('head')!.innerHTML).toContain('acct-3')
    expect(one.get('head')!.innerHTML).toContain('While fetching a page')
    expect(one.get('widget')!.innerHTML).toContain('cap-img')
    expect(one.get('widget')!.innerHTML).toContain('Submit answer')
    expectNoCredentials([...list.values(), ...one.values()].map((e) => e.innerHTML).join())
  })

  it('a checkbox challenge shows the live view and a "Done, I clicked it" button, and polls every 3 s until tlpool reports it solved', async () => {
    let status = 'pending'
    const { fetcher } = fakePool({ 'GET /challenges/ch-8': () => json(upstreamChallenge('ch-8', { type: 'checkbox', state: undefined, status })) })
    const pg = await runPageTimed(POOL_PAGES.captchaPageHtml('ch-8'), mount(fetcher), makeEnv())
    const w = pg.els.get('widget')!.innerHTML
    expect(w).toContain('Tap the checkbox')
    expect(w).toContain('/ui/api/pool/challenges/ch-8/live/?path=')
    expect(w).toContain('Done, I clicked it')
    expect(w).not.toContain('Submit answer')
    expect(pg.pending().map((t) => t.ms)).toContain(3000)
    status = 'solved' // the owner clicked the box; tlpool noticed the wall clear by itself
    await pg.fire(3000)
    expect(pg.els.get('state')!.innerHTML).toContain('Solved')
  })

  it('"Done, I clicked it" posts {done: true} and says so when the wall is still up', async () => {
    const answers: unknown[] = []
    let verdict: Response = json({ status: 'pending', error: 'the checkbox wall is still up' }, 422)
    const { fetcher } = fakePool({
      'GET /challenges/ch-8': () => json(upstreamChallenge('ch-8', { type: 'checkbox' })),
      'POST /challenges/ch-8/answer': (c) => (answers.push(c.body), verdict),
    })
    const root = stubEl()
    const pg = await runPageTimed(POOL_PAGES.captchaPageHtml('ch-8'), mount(fetcher), makeEnv(), { query: { '[data-r=done]': root } })
    await (root.handlers as Record<string, () => Promise<void>>).click!()
    await settle()
    expect(answers).toEqual([{ done: true }])
    const msgEl = pg.q['[data-r=msg]']!
    expect(msgEl.textContent).toContain('Not through yet')
    verdict = json({ status: 'solved' })
    await (root.handlers as Record<string, () => Promise<void>>).click!()
    await settle()
    expect(msgEl.textContent).toContain('Through')
  })

  it('the answer route takes {done: true} for a checkbox and at most 64 characters of text', async () => {
    const { fetcher, calls } = fakePool({ 'POST /challenges/ch-1/answer': () => json({ status: 'solved' }) })
    const post = (body: unknown) => req(mount(fetcher), '/ui/api/pool/challenges/ch-1/answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect((await post({ done: true })).data).toEqual({ outcome: 'solved' })
    expect(calls[0]!.body).toEqual({ done: true })
    expect((await post({ text: 'x'.repeat(65) })).r.status).toBe(400)
    expect(calls).toHaveLength(1)
  })

  /** The UI next to W4's real settings routes, as index.ts mounts them. */
  function withSettingsApi(fetcher: Fetcher) {
    const appl = mount(fetcher)
    appl.route('/ui/api/pool', poolSettingsApp)
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
    const stored = (await (await appl.request('https://tracked.example/ui/api/pool/settings', {}, env)).json()) as { settings: PoolSettings }
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
    const { text } = await req(mainApp, '/ui/sw.js')
    expect(text).toContain("addEventListener('notificationclick'")
    expect(text).toContain('data: { url: data.url')
    expect(text).toContain('self.clients.openWindow(target)')
    expect(text).toMatch(/requireInteraction:.*challenge/)
  })
})

// ─── a runPage whose timers, clock and visibility the test drives ───────────
type Timer = { fn: () => unknown; ms: number; id: number; cleared: boolean }
async function runPageTimed(html: string, appl: Appl, env: Env, opts: { query?: Record<string, StubEl>; now?: () => number } = {}) {
  const els = new Map<string, StubEl>()
  const timers: Timer[] = []
  const q: Record<string, StubEl> = { ...(opts.query ?? {}) }
  const visHandlers: Array<() => void> = []
  let nextId = 1
  const document = {
    hidden: false,
    getElementById: (id: string) => {
      if (!els.has(id)) {
        const el = stubEl()
        // mountCaptcha looks its parts up with querySelector on its root.
        el.querySelector = ((sel: string) => (q[sel] ??= stubEl())) as never
        els.set(id, el)
      }
      return els.get(id)
    },
    querySelector: () => null,
    addEventListener: (type: string, fn: () => void) => { if (type === 'visibilitychange') visHandlers.push(fn) },
  }
  const fetchFromPage = async (path: string, init?: RequestInit) => appl.request(`https://tracked.example${path}`, init, env)
  const RealDate = Date
  const FakeDate = opts.now ? class extends RealDate { static now() { return opts.now!() } } : RealDate
  const ctx = vm.createContext({
    document, fetch: fetchFromPage, console, Date: FakeDate,
    setInterval: () => 0, clearInterval() {},
    setTimeout: (fn: () => unknown, ms: number) => { const t = { fn, ms, id: nextId++, cleared: false }; timers.push(t); return t.id },
    clearTimeout: (id: number) => { const t = timers.find((x) => x.id === id); if (t) t.cleared = true },
    Option: function (t: string, v: string) { return { text: t, value: v } },
  })
  for (const sc of scriptsOf(html)) vm.runInContext(sc, ctx)
  await settle()
  const pending = () => timers.filter((t) => !t.cleared)
  /** Run (and consume) every pending timer set for `ms`. */
  async function fire(ms: number) {
    const due = pending().filter((t) => t.ms === ms)
    for (const t of due) { t.cleared = true; await t.fn() }
    await settle()
    return due.length
  }
  async function setHidden(h: boolean) {
    document.hidden = h
    for (const f of visHandlers) f()
    await settle()
  }
  return { els, q, timers, pending, fire, setHidden, document }
}

describe('polling on the pool pages', () => {
  const statusOnce = () => json({ accounts: [upstreamAccount('acct-1')], queueDepth: 0 })

  it('pauses while the tab is hidden and runs once when it comes back', async () => {
    const { fetcher, calls } = fakePool({ 'GET /status': statusOnce, 'GET /challenges': () => json({ challenges: [] }) })
    const pg = await runPageTimed(POOL_PAGES.POOL_PAGE_HTML, mount(fetcher), makeEnv())
    const before = calls.length
    pg.document.hidden = true
    expect(await pg.fire(20000)).toBe(1)
    expect(calls.length).toBe(before) // hidden: nothing fetched, nothing rescheduled
    expect(pg.pending().filter((t) => t.ms === 20000)).toHaveLength(0)
    await pg.setHidden(false)
    expect(calls.length).toBeGreaterThan(before)
    expect(pg.pending().some((t) => t.ms === 20000)).toBe(true)
  })

  it('backs off on errors and stops with "sign in again" on 401/403', async () => {
    let status = 503
    const { fetcher } = fakePool({ 'GET /status': () => json({ error: 'busy' }, status), 'GET /challenges': () => json({ challenges: [] }) })
    const pg = await runPageTimed(POOL_PAGES.POOL_PAGE_HTML, mount(fetcher), makeEnv())
    await pg.fire(20000)
    expect(pg.pending().some((t) => t.ms === 40000)).toBe(true) // doubled after one failure
    await pg.fire(40000)
    expect(pg.pending().some((t) => t.ms === 60000)).toBe(true) // capped at a minute
    // The Worker's own Access gate answering 401 (the browser's session expired).
    const appl = new Hono<{ Bindings: Env }>()
    appl.get('/ui/api/pool/status', (c) => c.json({ error: 'unauthorized' }, 401))
    appl.route('/ui', createPoolUiApp({ fetcher }))
    const pg2 = await runPageTimed(POOL_PAGES.POOL_PAGE_HTML, appl, makeEnv())
    await pg2.fire(20000)
    expect(pg2.pending().filter((t) => t.ms >= 20000)).toHaveLength(0)
    expect(pg2.els.get('err')!.textContent).toContain('sign in again')
    status = 200
  })

  it('stops for good after 15 minutes', async () => {
    let clock = Date.now()
    const { fetcher, calls } = fakePool({ 'GET /status': statusOnce, 'GET /challenges': () => json({ challenges: [] }) })
    const pg = await runPageTimed(POOL_PAGES.POOL_PAGE_HTML, mount(fetcher), makeEnv(), { now: () => clock })
    clock += 15 * 60000 + 1
    const before = calls.length
    await pg.fire(20000)
    expect(calls.length).toBe(before)
    expect(pg.pending().filter((t) => t.ms >= 20000)).toHaveLength(0)
    expect(pg.els.get('err')!.textContent).toContain('15 minutes')
  })

  it('the add-account poll keeps its stall guard on errors and stops when the dialog closes', async () => {
    let clock = Date.now()
    const { fetcher, calls } = fakePool({
      'GET /status': statusOnce, 'GET /challenges': () => json({ challenges: [] }),
      'POST /accounts': () => json({ challengeId: 'ch_s1', accountId: 'acct-7' }),
      'GET /challenges/ch_s1': () => json({ error: 'busy' }, 503),
    })
    const pg = await runPageTimed(POOL_PAGES.POOL_PAGE_HTML, mount(fetcher), makeEnv(), { now: () => clock })
    await (pg.els.get('add-create')!.handlers as Record<string, () => Promise<void>>).click!()
    await settle()
    clock += 11 * 60000
    await pg.fire(2500)
    expect(pg.els.get('add-msg')!.innerHTML).toContain('No progress for 10 minutes')
    // A fresh flow, then the dialog closes: nothing is polled any more.
    const pg2 = await runPageTimed(POOL_PAGES.POOL_PAGE_HTML, mount(fetcher), makeEnv())
    await (pg2.els.get('add-create')!.handlers as Record<string, () => Promise<void>>).click!()
    await settle()
    await (pg2.els.get('add-dlg')!.handlers as Record<string, () => void>).close!()
    await settle()
    const n = calls.length
    await pg2.fire(2500)
    expect(calls.filter((c, i) => i >= n && c.url.includes('/challenges/ch_s1'))).toHaveLength(0)
  })
})

describe('tlpool as shipped', () => {
  it('a signup whose form has no captcha never waits at the captcha step; it shows as skipped', async () => {
    let row: Record<string, unknown> = { id: 'ch_s2', type: 'image', account: 'acct-8', purpose: 'signup', status: 'pending', step: 'form_opened', ready: false, error: null }
    const { fetcher } = fakePool({
      'GET /status': () => json({ accounts: [] }), 'GET /challenges': () => json({ challenges: [] }),
      'POST /accounts': () => json({ challengeId: 'ch_s2', accountId: 'acct-8' }),
      'GET /challenges/ch_s2': () => json(row),
    })
    const pg = await runPageTimed(POOL_PAGES.POOL_PAGE_HTML, mount(fetcher), makeEnv())
    await (pg.els.get('add-create')!.handlers as Record<string, () => Promise<void>>).click!()
    await settle()
    expect(pg.els.get('add-captcha')?.innerHTML ?? '').toBe('') // pending but not ready: nothing to answer
    row = { ...row, status: 'solved', step: 'awaiting_email', ready: false }
    await pg.fire(2500)
    const steps = pg.els.get('add-steps')!.innerHTML
    expect(steps).toContain('No captcha needed')
    expect(steps).not.toContain('Waiting for your captcha')
    row = { ...row, step: 'done' }
    await pg.fire(2500)
    expect(pg.els.get('add-msg')!.innerHTML).toContain('acct-8 is ready')
  })

  it('a signup captcha shows once tlpool marks the challenge ready', async () => {
    const row = { id: 'ch_s3', type: 'image', account: 'acct-9', purpose: 'signup', status: 'pending', step: 'awaiting_captcha', ready: true }
    const { fetcher } = fakePool({
      'GET /status': () => json({ accounts: [] }), 'GET /challenges': () => json({ challenges: [] }),
      'POST /accounts': () => json({ challengeId: 'ch_s3', accountId: 'acct-9' }),
      'GET /challenges/ch_s3': () => json(row),
    })
    const pg = await runPageTimed(POOL_PAGES.POOL_PAGE_HTML, mount(fetcher), makeEnv())
    await (pg.els.get('add-create')!.handlers as Record<string, () => Promise<void>>).click!()
    await settle()
    expect(pg.els.get('add-captcha')!.innerHTML).toContain('cap-img')
  })

  it('reads the real /status shape: warming accounts fetch, queueByPriority, totals.usedToday', async () => {
    const { fetcher } = fakePool({
      'GET /status': () => json({
        accounts: [
          { id: 'acct-1', state: 'warming', passive: false, exitLabel: 'e1', usedToday: 4, budget: 10, usedXhrToday: 2, xhrBudget: 20 },
          { id: 'acct-2', state: 'active', passive: false, exitLabel: 'e2', usedToday: 11, budget: 30 },
        ],
        queueDepth: 3, queueByPriority: { new: 2, recheck: 1 },
        totals: { fetchOk: 9, fetchError: 1, pageViews: 99, usedToday: 15, budgetToday: 40, accountsByState: { warming: 1, active: 1 } },
      }),
      'GET /challenges': () => json({ challenges: [] }),
    })
    const { data } = await req(mount(fetcher), '/ui/api/pool/status')
    expect(data.status).toMatchObject({ queueDepth: 3, queueByPriority: { new: 2, recheck: 1 }, requestsToday: 15, budgetToday: 40 })
    expect(data.status.accounts[0]).toMatchObject({ state: 'warming', xhrUsedToday: 2, xhrBudget: 20 })
    const pg = await runPageTimed(POOL_PAGES.POOL_PAGE_HTML, mount(fetcher), makeEnv())
    const stats = pg.els.get('stats')!.innerHTML
    expect(stats).toContain('15 / 40') // used / budget counts the warming account
    expect(stats).toContain('2 / 2') // fetching / live
    expect(pg.els.get('prio')!.innerHTML).toContain('recheck')
  })

  it('a failed signup shows tlpool\'s plain-words reason', async () => {
    const { fetcher } = fakePool({
      'GET /status': () => json({ accounts: [] }), 'GET /challenges': () => json({ challenges: [] }),
      'POST /accounts': () => json({ challengeId: 'ch_s4', accountId: 'acct-4' }),
      'GET /challenges/ch_s4': () => json({ id: 'ch_s4', status: 'failed', step: 'submitted', error: 'the site rejected the registration form', ready: false }),
    })
    const pg = await runPageTimed(POOL_PAGES.POOL_PAGE_HTML, mount(fetcher), makeEnv())
    await (pg.els.get('add-create')!.handlers as Record<string, () => Promise<void>>).click!()
    await settle()
    expect(pg.els.get('add-msg')!.innerHTML).toContain('the site rejected the registration form')
  })

  it('an error tlpool answers with HTTP 200 is still an error (read from the body, not the status)', async () => {
    const { fetcher } = fakePool({ 'POST /accounts': () => json({ error: 'no_exit_available', message: 'no free exit in the registry' }, 200) })
    const { r, data } = await req(mount(fetcher), '/ui/api/pool/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(r.status).toBe(409)
    expect(data).toEqual({ error: 'conflict', detail: 'no_exit_available', message: 'no free exit in the registry' })
  })

  it('an upstream message that could carry an address or secret is dropped', async () => {
    const { fetcher } = fakePool({ 'GET /accounts': () => json({ error: 'db_locked', message: 'see https://x.example/y' }, 500) })
    const { data } = await req(mount(fetcher), '/ui/api/pool/accounts')
    expect(data).toEqual({ error: 'pool_error', detail: 'db_locked' })
  })

  it('settings: xhrBudgetPerDay and priorityCeilings are read, shown and saved', async () => {
    const puts: unknown[] = []
    const settings = { budgetPerDay: 30, ramp: [10, 20], reservedPhoneShare: 0.2, imagePolicy: 'allow', xhrBudgetPerDay: 60, priorityCeilings: { new: 1, verify: 1, recheck: 0.9, backfill: 0.75 }, minGapSeconds: 35 }
    const { fetcher } = fakePool({ 'GET /settings': () => json(settings), 'PUT /settings': (c) => (puts.push(c.body), json({ ...settings, ...(c.body as object) })) })
    const { data } = await req(mount(fetcher), '/ui/api/pool/limits')
    expect(data.settings).toEqual({ budgetPerDay: 30, ramp: [10, 20], reservedPhoneShare: 0.2, imagePolicy: 'allow', xhrBudgetPerDay: 60, priorityCeilings: { new: 1, verify: 1, recheck: 0.9, backfill: 0.75 } })
    const pg = await runPageTimed(POOL_PAGES.SETTINGS_PAGE_HTML, mount(fetcher), makeEnv())
    expect(pg.els.get('xhr')!.value).toBe(60)
    expect(pg.els.get('ceil-backfill')!.value).toBe(75)
    pg.els.get('xhr')!.value = '80' as never
    pg.els.get('ceil-backfill')!.value = '50' as never
    await (pg.els.get('lim')!.handlers as Record<string, (e: unknown) => Promise<void>>).submit!({ preventDefault() {} })
    await settle()
    expect(puts[0]).toMatchObject({ xhrBudgetPerDay: 80, priorityCeilings: { new: 1, verify: 1, recheck: 0.9, backfill: 0.5 } })
  })
})

describe('pool page: reopening the signup progress of an account still being created', () => {
  const statusWith = (accounts: unknown[]) => () => json({ accounts, queueDepth: 0 })
  const badgeButtons = (html: string) => [...html.matchAll(/<button [^>]*data-signup="([^"]*)"[^>]*data-acct="([^"]*)"[^>]*>([^<]*)<\/button>/g)].map((m) => ({ cid: m[1], acct: m[2], text: m[3] }))
  /** A click on the #accts table that lands on a button carrying these data attributes. */
  const clickOn = (dataset: Record<string, string>) => ({ target: { closest: (sel: string) => (sel === 'button' ? { dataset, closest: () => null } : null) } })

  it('the normaliser keeps tlpool\'s signupChallengeId (opaque ids only)', () => {
    expect(normalizeAccount({ id: 'acct-5', state: 'new', signupChallengeId: 'ch_s5' })!.signupChallengeId).toBe('ch_s5')
    expect(normalizeAccount({ id: 'acct-5', state: 'new', signup_challenge_id: 'ch_s5' })!.signupChallengeId).toBe('ch_s5')
    expect(normalizeAccount({ id: 'acct-5', state: 'active' })!.signupChallengeId).toBeNull()
    expect(normalizeAccount({ id: 'acct-5', state: 'new', signupChallengeId: '<img src=x>' })!.signupChallengeId).toBeNull()
  })

  it('the state badge is a button only for an account still being created that names its signup challenge', async () => {
    const { fetcher } = fakePool({
      'GET /status': statusWith([
        upstreamAccount('acct-1', { state: 'new', signupChallengeId: 'ch_n1' }),
        upstreamAccount('acct-2', { state: 'active', signupChallengeId: 'ch_old' }),
        upstreamAccount('acct-3', { state: 'new' }),
        upstreamAccount('acct-4', { state: 'warming', signupChallengeId: 'ch_w4' }),
      ]),
      'GET /challenges': () => json({ challenges: [] }),
    })
    const els = await runPage(POOL_PAGES.POOL_PAGE_HTML, mount(fetcher), makeEnv())
    const accts = els.get('accts')!.innerHTML
    expect(badgeButtons(accts)).toEqual([{ cid: 'ch_n1', acct: 'acct-1', text: 'new' }])
    expect(accts).toMatch(/<button type="button" class="badge badge-btn warn" data-signup="ch_n1"[^>]*aria-label="acct-1 is new: show its signup progress"/)
    // Every other badge opens the state details instead (never the signup dialog).
    expect(accts).toMatch(/<button type="button" class="badge badge-btn ok" data-state-acct="acct-2"[^>]*>active<\/button>/)
    expect(accts).toMatch(/<button type="button" class="badge badge-btn warn" data-state-acct="acct-3"[^>]*>new<\/button>/) // acct-3: no challenge to follow
    expect(accts).toMatch(/<button type="button" class="badge badge-btn info" data-state-acct="acct-4"[^>]*>warming<\/button>/)
    expectNoCredentials([...els.values()].map((e) => e.innerHTML + e.textContent).join('\n'))
  })

  it('clicking the badge opens the progress dialog on that account\'s signup challenge', async () => {
    const { fetcher, calls } = fakePool({
      'GET /status': statusWith([
        upstreamAccount('acct-1', { state: 'new', signupChallengeId: 'ch_n1' }),
        upstreamAccount('acct-2', { state: 'new', signupChallengeId: 'ch_n2' }),
      ]),
      'GET /challenges': () => json({ challenges: [] }),
      'GET /challenges/ch_n1': () => json({ id: 'ch_n1', type: 'image', account: 'acct-1', purpose: 'signup', status: 'pending', step: 'form_opened', ready: false }),
      'GET /challenges/ch_n2': () => json({ id: 'ch_n2', type: 'image', account: 'acct-2', purpose: 'signup', status: 'solved', step: 'awaiting_email', ready: false }),
    })
    const pg = await runPageTimed(POOL_PAGES.POOL_PAGE_HTML, mount(fetcher), makeEnv())
    const dlg = pg.els.get('add-dlg')!
    const showModal = vi.fn(); dlg.showModal = showModal
    const n = calls.length
    await (pg.els.get('accts')!.handlers as Record<string, (ev: unknown) => Promise<void>>).click!(clickOn({ signup: 'ch_n2', acct: 'acct-2' }))
    await settle()
    const fetched = calls.slice(n).map((c) => c.url.slice(POOL.length))
    expect(fetched).toContain('/challenges/ch_n2')
    expect(fetched).not.toContain('/challenges/ch_n1')
    expect(showModal).toHaveBeenCalledTimes(1)
    expect(pg.els.get('add-form')!.hidden).toBe(true)
    expect(pg.els.get('add-progress')!.hidden).toBe(false)
    const steps = pg.els.get('add-steps')!.innerHTML
    expect(steps).toMatch(/<li class="cur">.*Waiting for the confirmation email/)
    expect(steps).toMatch(/<li class="done">.*Exit assigned/)
    // It keeps watching that same challenge.
    await pg.fire(2500)
    expect(calls.slice(n).filter((c) => c.url.endsWith('/challenges/ch_n2')).length).toBeGreaterThan(1)
    // "+ Add account" afterwards offers a new account, not the reopened signup, which is listed under the form.
    ;(pg.els.get('add-btn')!.handlers as Record<string, () => void>).click!()
    expect(pg.els.get('add-form')!.hidden).toBe(false)
    expect(pg.els.get('add-progress')!.hidden).toBe(true)
    expect(pg.els.get('add-active')!.innerHTML).toContain('data-flow=')
    expect(pg.els.get('add-active')!.innerHTML).toContain('acct-2')
    // Closing the dialog stops watching it.
    await (dlg.handlers as Record<string, () => void>).close!()
    const m = calls.length
    await pg.fire(2500)
    expect(calls.slice(m).filter((c) => c.url.includes('/challenges/ch_n2'))).toHaveLength(0)
  })

  it('a reopened signup whose challenge is gone says so at once (no "Starting…" grace)', async () => {
    const { fetcher } = fakePool({
      'GET /status': statusWith([upstreamAccount('acct-1', { state: 'new', signupChallengeId: 'ch_gone' })]),
      'GET /challenges': () => json({ challenges: [] }),
    })
    const pg = await runPageTimed(POOL_PAGES.POOL_PAGE_HTML, mount(fetcher), makeEnv())
    await (pg.els.get('accts')!.handlers as Record<string, (ev: unknown) => Promise<void>>).click!(clickOn({ signup: 'ch_gone', acct: 'acct-1' }))
    await settle()
    expect(pg.els.get('add-msg')!.innerHTML).toContain('lost track of this signup')
  })
})

describe('pool page: state details for every other account state', () => {
  const H = 3600_000
  const D = 24 * H
  const isoIn = (ms: number) => new Date(Date.now() + ms).toISOString()
  const statusWith = (accounts: unknown[]) => () => json({ accounts, queueDepth: 0 })
  /** A click on the #accts table that lands on a button carrying these data attributes. */
  const clickOn = (dataset: Record<string, string>) => ({ target: { closest: (sel: string) => (sel === 'button' ? { dataset, closest: () => null } : null) } })
  const stateButtons = (html: string) => [...html.matchAll(/<button type="button" class="badge badge-btn ([a-z]*)" data-state-acct="([^"]*)" aria-haspopup="dialog" aria-label="([^"]*)"[^>]*>([^<]*)<\/button>/g)]
    .map((m) => ({ cls: m[1], acct: m[2], label: m[3], text: m[4] }))
  async function seed(env: Env, body: Record<string, unknown>) {
    const s = sanitizePoolEvent(body)
    if (!s.ok) throw new Error(s.error)
    await receivePoolEvent(env, s.event)
  }
  async function openOn(pg: { els: Map<string, StubEl> }, acct: string) {
    await (pg.els.get('accts')!.handlers as Record<string, (ev: unknown) => Promise<void>>).click!(clickOn({ stateAcct: acct }))
    await settle()
    return { title: pg.els.get('tk-drawer-title')!.textContent, body: pg.els.get('tk-drawer-body')!.innerHTML }
  }

  const ALL = [
    upstreamAccount('acct-1', { state: 'new', created_at: isoIn(-1 * H) }),
    upstreamAccount('acct-2', { state: 'warming', activated_at: isoIn(-1.5 * D), used_today: 4, budget: 20 }),
    upstreamAccount('acct-3', { state: 'active', activated_at: isoIn(-9 * D), used_today: 30, budget: 30 }),
    upstreamAccount('acct-4', { state: 'passive', passive: true, activated_at: isoIn(-4 * D) }),
    upstreamAccount('acct-5', { state: 'resting', restUntil: isoIn(5 * H), restReason: 'retest:requested', retestPending: true, flagged: true }),
    upstreamAccount('acct-6', { state: 'retired', retiredAt: isoIn(-2 * D), submittedAt: isoIn(-20 * D) }),
    upstreamAccount('acct-7', { state: 'signup_failed', submittedAt: isoIn(-3 * D), canRetrySignup: true, lastError: 'signup not confirmed: the email never came' }),
    upstreamAccount('acct-8', { state: 'flagged', flag_reason: 'decoy_names' }),
    upstreamAccount('acct-9', { state: 'quarantined_v2' }),
    upstreamAccount('acct-10', { state: 'new', signupChallengeId: 'ch_n10' }),
  ]

  it('the normaliser keeps tlpool\'s lifecycle fields and drops free text holding an address or a URL', () => {
    const a = normalizeAccount({
      id: 'acct-1', state: 'resting', restReason: 'retest_inconclusive:rate_block', retestPending: true, createdAt: '2026-09-01T00:00:00Z',
      activatedAt: '2026-09-02T00:00:00Z', retiredAt: null, submittedAt: '2026-09-01T01:00:00Z', lastError: 'retest postponed: NoBrowserSlot',
      exitProblem: 'its exit is not in the registry', pendingChallenge: 'ch_p1', canRetrySignup: false, busy: 'fetch:phone', state_changed_at: 1790000000,
    })!
    expect(a).toMatchObject({
      restReason: 'retest_inconclusive:rate_block', retestPending: true, createdAt: '2026-09-01T00:00:00.000Z', activatedAt: '2026-09-02T00:00:00.000Z',
      submittedAt: '2026-09-01T01:00:00.000Z', lastError: 'retest postponed: NoBrowserSlot', exitProblem: 'its exit is not in the registry',
      pendingChallengeId: 'ch_p1', busy: 'fetch:phone', stateChangedAt: new Date(1790000000 * 1000).toISOString(),
    })
    const b = normalizeAccount({
      id: 'acct-2', state: 'resting', restReason: `login failed for ${SECRET_EMAIL}`, lastError: 'see https://x.example/y',
      exitProblem: 'C:\\exits\\x.json', busy: 'fetch:<b>', pendingChallenge: '<img>',
    })!
    expect(b).toMatchObject({ restReason: null, lastError: null, exitProblem: null, busy: null, pendingChallengeId: null })
  })

  it('every state badge is a real button: "new" with a signup challenge keeps the signup dialog, every other one opens the details', async () => {
    const { fetcher } = fakePool({ 'GET /status': statusWith(ALL), 'GET /challenges': () => json({ challenges: [] }) })
    const els = await runPage(POOL_PAGES.POOL_PAGE_HTML, mount(fetcher), makeEnv())
    const accts = els.get('accts')!.innerHTML
    const btns = stateButtons(accts)
    expect(btns.map((b) => [b.acct, b.text])).toEqual([
      ['acct-1', 'new'], ['acct-2', 'warming'], ['acct-3', 'active'], ['acct-4', 'passive'], ['acct-5', 'resting'],
      ['acct-6', 'retired'], ['acct-7', 'signup_failed'], ['acct-8', 'flagged'], ['acct-9', 'quarantined_v2'],
    ])
    for (const b of btns) expect(b.label).toBe(`${b.acct} is ${b.text}: show what that means and what happens next`)
    expect(btns.find((b) => b.acct === 'acct-8')!.cls).toBe('bad')
    expect(btns.find((b) => b.acct === 'acct-6')!.cls).toBe('')
    // The signup badge is untouched.
    expect(accts).toContain('data-signup="ch_n10" data-acct="acct-10" aria-haspopup="dialog" aria-label="acct-10 is new: show its signup progress"')
    expect(accts).not.toContain('data-state-acct="acct-10"')
    // Real buttons get the shared focus-visible ring.
    expect(POOL_PAGES.POOL_PAGE_HTML).toContain('button.badge-btn:focus-visible')
  })

  it('the details say what each state means, how it got there and what happens next', async () => {
    const env = makeEnv()
    const { fetcher } = fakePool({
      'GET /status': statusWith(ALL), 'GET /challenges': () => json({ challenges: [] }),
      'GET /settings': () => json({ budgetPerDay: 30, ramp: [10, 20, 25] }),
    })
    await seed(env, { type: 'account.retired', accountId: 'acct-6', reason: 'retest_failed:decoy', createdAt: isoIn(-2 * D), exitQuarantinedUntil: isoIn(28 * D) })
    const pg = await runPageTimed(POOL_PAGES.POOL_PAGE_HTML, mount(fetcher), env)
    const showModal = vi.fn(); pg.els.get('tk-drawer')!.showModal = showModal

    const n = await openOn(pg, 'acct-1')
    expect(showModal).toHaveBeenCalled()
    expect(n.title).toBe('acct-1 · new')
    expect(n.body).toContain('Being created')
    expect(n.body).toContain('Created <b>')
    expect(n.body).toContain('the pool gives up')

    const w = await openOn(pg, 'acct-2')
    expect(w.body).toContain('on the ramp')
    expect(w.body).toContain('Ramp day <b>2 of 3</b>')
    expect(w.body).toContain('4 / 20')
    expect(w.body).toContain('Becomes active with the full budget around')

    const a = await openOn(pg, 'acct-3')
    expect(a.body).toContain('full daily page budget')
    expect(a.body).toContain('budget is spent')
    expect(a.body).toContain('does not report the exact next time')

    expect((await openOn(pg, 'acct-4')).body).toContain('never fetches')

    const r = await openOn(pg, 'acct-5')
    expect(r.body).toContain('Out of rotation')
    expect(r.body).toContain('Why: a retest was asked for (by hand).')
    expect(r.body).toContain('Rests until <b>')
    expect(r.body).toContain('Then one retest with a known set')

    const t = await openOn(pg, 'acct-6')
    expect(t.body).toContain('Out for good')
    expect(t.body).toContain('Retired <b>')
    expect(t.body).toContain('The pool said: it failed its retest (the site served it decoy track names).')
    expect(t.body).toContain('Its exit is kept from new accounts until <b>')

    const f = await openOn(pg, 'acct-7')
    expect(f.body).toContain('never confirmed')
    expect(f.body).toContain('Last error: signup not confirmed: the email never came')
    expect(f.body).toContain('Retired on its own <b>')
    expect(f.body).toContain('accepts a signup retry')

    const g = await openOn(pg, 'acct-8')
    expect(g.body).toContain('flagged it')
    expect(g.body).toContain('the site served it decoy track names')

    expect((await openOn(pg, 'acct-9')).body).toContain('A state this page does not know yet')
    expectNoCredentials([...pg.els.values()].map((e) => e.innerHTML + e.textContent).join('\n'))
  })

  it('a retired account without a stored event falls back to retiredAt + 30 days for the exit', async () => {
    const { fetcher } = fakePool({ 'GET /status': statusWith([ALL[5]]), 'GET /challenges': () => json({ challenges: [] }) })
    const pg = await runPageTimed(POOL_PAGES.POOL_PAGE_HTML, mount(fetcher), makeEnv())
    const t = await openOn(pg, 'acct-6')
    expect(t.body).toContain('Its exit is kept from new accounts until <b>')
    expect(t.body).toContain('No pool events stored for acct-6')
  })

  it('the events route lists only that account\'s events, newest first, acct-N ids only', async () => {
    const env = makeEnv()
    await seed(env, { id: 'e1', type: 'account.created', accountId: 'acct-1', createdAt: '2026-09-20T10:00:00Z' })
    await seed(env, { id: 'e2', type: 'challenge.created', challengeId: 'ch-9', accountId: 'acct-2', challengeType: 'image', createdAt: '2026-09-21T10:00:00Z' })
    await seed(env, { id: 'e3', type: 'account.flagged', accountId: 'acct-1', reason: 'decoy', createdAt: '2026-09-22T10:00:00Z' })
    await seed(env, { id: 'e4', type: 'account.rested', accountId: 'acct-12', createdAt: '2026-09-23T10:00:00Z' })
    const { fetcher, calls } = fakePool({})
    const { r, data } = await req(mount(fetcher), '/ui/api/pool/accounts/acct-1/events', {}, env)
    expect(r.status).toBe(200)
    expect(data.events.map((e: { type: string }) => e.type)).toEqual(['account.flagged', 'account.created'])
    expect(data.events[0]).toEqual({ type: 'account.flagged', at: '2026-09-22T10:00:00.000Z', reason: 'decoy', challengeId: null, challengeType: null, phoneInitiated: false, exitQuarantinedUntil: null })
    expect(calls).toHaveLength(0) // D1 only, never tlpool
    expect((await req(mount(fetcher), '/ui/api/pool/accounts/dj_fan_marta88/events', {}, env)).r.status).toBe(400)
    // The POST action route still knows only rest, retire and retest.
    const post = await req(mount(fetcher), '/ui/api/pool/accounts/acct-1/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, env)
    expect(post.r.status).toBe(404)
    expect(post.data).toEqual({ error: 'not_found', detail: 'unknown_action' })

    // The drawer shows them.
    const page = fakePool({ 'GET /status': statusWith([upstreamAccount('acct-1', { state: 'active' })]), 'GET /challenges': () => json({ challenges: [] }) })
    const pg = await runPageTimed(POOL_PAGES.POOL_PAGE_HTML, mount(page.fetcher), env)
    const d = await openOn(pg, 'acct-1')
    expect(d.body).toContain('<b>Flagged</b>')
    expect(d.body).toContain('<b>Account created</b>')
    expect(d.body).not.toContain('Captcha raised')
    expect(d.body).not.toContain('Rested')
  })

  it('a reason that held an address never reaches the route or the drawer', async () => {
    const env = makeEnv()
    await seed(env, { id: 'e5', type: 'account.retired', accountId: 'acct-3', reason: `login failed for ${SECRET_EMAIL}`, createdAt: '2026-09-22T10:00:00Z' })
    const { fetcher } = fakePool({
      'GET /status': statusWith([upstreamAccount('acct-3', { state: 'resting', restReason: `rest for ${SECRET_EMAIL}`, lastError: `mail to ${SECRET_EMAIL} bounced` })]),
      'GET /challenges': () => json({ challenges: [] }),
    })
    const { data, text } = await req(mount(fetcher), '/ui/api/pool/accounts/acct-3/events', {}, env)
    expect(data.events[0].reason).toBeNull()
    expect(text).not.toContain('owner-domain')
    expect(text).not.toContain('[redacted]')
    const pg = await runPageTimed(POOL_PAGES.POOL_PAGE_HTML, mount(fetcher), env)
    const d = await openOn(pg, 'acct-3')
    expect(d.body).toContain('<b>Retired</b>')
    expect(d.body).not.toContain('@')
    expect(d.body).not.toContain('redacted')
    expect(d.body).not.toContain('Last error')
    expectNoCredentials([...pg.els.values()].map((e) => e.innerHTML + e.textContent).join('\n'))
  })

  it('escapes what it shows', async () => {
    const { fetcher } = fakePool({
      'GET /status': statusWith([upstreamAccount('acct-1', { state: 'resting', restReason: 'x"><img src=y onerror=z>' , lastError: 'a & b' })]),
      'GET /challenges': () => json({ challenges: [] }),
    })
    const pg = await runPageTimed(POOL_PAGES.POOL_PAGE_HTML, mount(fetcher), makeEnv())
    const d = await openOn(pg, 'acct-1')
    expect(d.body).not.toContain('<img')
    expect(d.body).toContain('Last error: a &amp; b')
    // A stored event reason keeps < and > (pool-events sanitising): the drawer escapes it.
    const appl = new Hono<{ Bindings: Env }>()
    appl.get('/ui/api/pool/accounts/:id/events', (c) => c.json({ events: [{ type: 'account.flagged', at: '2026-09-22T10:00:00Z', reason: '<img src=x onerror=y>' }] }))
    appl.route('/ui', createPoolUiApp({ fetcher }))
    const pg2 = await runPageTimed(POOL_PAGES.POOL_PAGE_HTML, appl, makeEnv())
    const d2 = await openOn(pg2, 'acct-1')
    expect(d2.body).not.toContain('<img')
    expect(d2.body).toContain('&lt;img')
  })

  it('drops an events reply that lands after the drawer moved to another account or closed', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const { fetcher } = fakePool({
      'GET /status': statusWith([upstreamAccount('acct-1', { state: 'active' }), upstreamAccount('acct-2', { state: 'passive', passive: true })]),
      'GET /challenges': () => json({ challenges: [] }),
    })
    const appl = new Hono<{ Bindings: Env }>()
    appl.get('/ui/api/pool/accounts/:id/events', async (c) => {
      if (c.req.param('id') === 'acct-1') { await gate; return c.json({ events: [{ type: 'account.flagged', at: '2026-09-22T10:00:00Z', reason: 'stale_reply_marker' }] }) }
      return c.json({ events: [] })
    })
    appl.route('/ui', createPoolUiApp({ fetcher }))
    const pg = await runPageTimed(POOL_PAGES.POOL_PAGE_HTML, appl, makeEnv())
    const click = (pg.els.get('accts')!.handlers as Record<string, (ev: unknown) => Promise<void>>).click!
    const first = click(clickOn({ stateAcct: 'acct-1' }))
    await settle()
    expect(pg.els.get('tk-drawer-body')!.innerHTML).toContain('data-sd-acct="acct-1"')
    await openOn(pg, 'acct-2')
    expect(pg.els.get('tk-drawer-body')!.innerHTML).toContain('data-sd-acct="acct-2"')
    release()
    await first
    await settle()
    const body = pg.els.get('tk-drawer-body')!.innerHTML
    expect(body).toContain('data-sd-acct="acct-2"')
    expect(body).not.toContain('stale reply marker')
    expect(pg.els.get('tk-drawer-title')!.textContent).toBe('acct-2 · passive')

    // Closed while the reply is on its way: the closed drawer is left alone.
    let release2!: () => void
    const gate2 = new Promise<void>((r) => { release2 = r })
    const appl2 = new Hono<{ Bindings: Env }>()
    appl2.get('/ui/api/pool/accounts/:id/events', async (c) => { await gate2; return c.json({ events: [{ type: 'account.flagged', at: '2026-09-22T10:00:00Z', reason: 'stale_reply_marker' }] }) })
    appl2.route('/ui', createPoolUiApp({ fetcher }))
    const pg2 = await runPageTimed(POOL_PAGES.POOL_PAGE_HTML, appl2, makeEnv())
    const p2 = (pg2.els.get('accts')!.handlers as Record<string, (ev: unknown) => Promise<void>>).click!(clickOn({ stateAcct: 'acct-1' }))
    await settle()
    ;(pg2.els.get('tk-drawer')!.handlers as Record<string, () => void>).close!()
    release2()
    await p2
    await settle()
    expect(pg2.els.get('tk-drawer-body')!.innerHTML).not.toContain('stale reply marker')
    expect(pg2.els.get('tk-drawer-body')!.innerHTML).toContain('Loading…')
  })
})


// ─────────────────────────────────────────────────────────────────────────────
// Scheduled creation, queued rows, several creations at once
// ─────────────────────────────────────────────────────────────────────────────

const queuedEntry = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `queued-${n}`, state: 'queued', queued: true, scheduledAt: '2099-01-02T15:30:00Z', passive: false, exitKind: 'mullvad', attempts: 0, lastError: null, createdAt: '2026-10-07T12:00:00Z', ...extra,
})
const postJson = (appl: Appl, path: string, body: unknown) => req(appl, path, { method: 'POST', headers: { 'content-type': 'application/json', ...browserHeaders }, body: JSON.stringify(body) })
const inDays = (d: number) => new Date(Date.now() + d * 86400_000).toISOString()

describe('pool UI: scheduled account creation', () => {
  it('passes a valid scheduledAt to tlpool as a normalised UTC string and returns the queued reply', async () => {
    const { fetcher, calls } = fakePool({ 'POST /accounts': () => json({ queued: true, accountId: 'queued-3', scheduledAt: '2099-01-01T00:00:00Z', username: SECRET_USER }) })
    const when = new Date(Date.now() + 2 * 86400_000)
    const withOffset = when.toISOString().replace('Z', '+00:00')
    const { r, data, text } = await postJson(mount(fetcher), '/ui/api/pool/accounts', { passive: true, exitKind: 'airvpn', scheduledAt: withOffset })
    expect(r.status).toBe(200)
    expect(calls[0]!.body).toEqual({ passive: true, exitKind: 'airvpn', scheduledAt: when.toISOString() })
    expect(data).toEqual({ queued: true, challengeId: null, accountId: 'queued-3', scheduledAt: '2099-01-01T00:00:00.000Z' })
    expectNoCredentials(text)
  })

  it('an empty or null scheduledAt means "now": it is not sent', async () => {
    const { fetcher, calls } = fakePool({ 'POST /accounts': () => json({ challengeId: 'ch-n', accountId: 'acct-1' }) })
    for (const v of ['', null]) {
      const { r, data } = await postJson(mount(fetcher), '/ui/api/pool/accounts', { scheduledAt: v })
      expect(r.status).toBe(200)
      expect(data).toEqual({ challengeId: 'ch-n', accountId: 'acct-1' })
    }
    expect(calls.map((c) => c.body)).toEqual([{ passive: false }, { passive: false }])
  })

  it('refuses an unparseable, offset-less, past or too-far scheduledAt without calling tlpool', async () => {
    const { fetcher, calls } = fakePool({ 'POST /accounts': () => json({ queued: true, accountId: 'queued-1' }) })
    const appl = mount(fetcher)
    const cases: Array<[unknown, string]> = [
      ['tomorrow', 'bad_scheduled_at'],
      [5, 'bad_scheduled_at'],
      [{}, 'bad_scheduled_at'],
      ['2099-13-45T99:00:00Z', 'bad_scheduled_at'],
      [inDays(2).replace('Z', ''), 'bad_scheduled_at'], // no offset: the Worker would have to guess the zone
      [new Date(Date.now() - 3600_000).toISOString(), 'scheduled_at_past'],
      [inDays(91), 'scheduled_at_too_far'],
    ]
    for (const [v, detail] of cases) {
      const { r, data } = await postJson(appl, '/ui/api/pool/accounts', { scheduledAt: v })
      expect(r.status, JSON.stringify(v)).toBe(400)
      expect(data).toMatchObject({ error: 'invalid', detail })
    }
    expect(calls).toHaveLength(0)
    // The edges that are fine: a minute ago (skew / "now" in the picker) and 89 days ahead.
    for (const v of [new Date(Date.now() - 60_000).toISOString(), inDays(89)]) {
      expect((await postJson(appl, '/ui/api/pool/accounts', { scheduledAt: v })).r.status).toBe(200)
    }
    expect(calls).toHaveLength(2)
  })

  it('a queued reply with a non-queued id is a bad_response, not a signup to follow', async () => {
    const { fetcher } = fakePool({ 'POST /accounts': () => json({ queued: true, accountId: 'acct-9' }) })
    const { r, data } = await postJson(mount(fetcher), '/ui/api/pool/accounts', { scheduledAt: inDays(1) })
    expect(r.status).toBe(503)
    expect(data.error).toBe('bad_response')
  })

  it('tlpool\'s own refusal of a scheduledAt reaches the page as an error', async () => {
    const { fetcher } = fakePool({ 'POST /accounts': () => json({ error: 'bad_request', message: 'scheduledAt too far' }, 400) })
    const { r, data } = await postJson(mount(fetcher), '/ui/api/pool/accounts', { scheduledAt: inDays(1) })
    expect(r.status).toBe(400)
    expect(data.error).toBe('invalid')
  })
})

describe('pool UI: cancelling a queued account', () => {
  it('POST /accounts/queued-N/cancel reaches tlpool; an empty 204 answer is a success', async () => {
    const { fetcher, calls } = fakePool({ 'POST /accounts/queued-3/cancel': () => new Response(null, { status: 204 }) })
    const { r, data } = await req(mount(fetcher), '/ui/api/pool/accounts/queued-3/cancel', { method: 'POST', headers: browserHeaders })
    expect(r.status).toBe(200)
    expect(data).toEqual({ ok: true })
    expect(calls[0]!.url).toBe(`${POOL}/accounts/queued-3/cancel`)
    expectAuthed(calls[0])
  })

  it('an unknown queue entry is a 404 from tlpool', async () => {
    const { fetcher } = fakePool({}) // the fake pool answers 404 not_found
    const { r, data } = await req(mount(fetcher), '/ui/api/pool/accounts/queued-99/cancel', { method: 'POST' })
    expect(r.status).toBe(404)
    expect(data.error).toBe('not_found')
  })

  it('only queued-<n> ids can be cancelled, and queued ids take no other action', async () => {
    const { fetcher, calls } = fakePool({})
    const appl = mount(fetcher)
    for (const id of ['acct-4', 'queued-', 'queued-x', 'queued-1x', 'queued--1', 'Queued-1', 'x']) {
      const { r } = await req(appl, `/ui/api/pool/accounts/${id}/cancel`, { method: 'POST' })
      expect(r.status, id).toBe(400)
    }
    for (const action of ['rest', 'retire', 'retest']) {
      const { r, data } = await req(appl, `/ui/api/pool/accounts/queued-3/${action}`, { method: 'POST' })
      expect(r.status).toBe(400)
      expect(data.detail).toBe('bad_id')
    }
    // The existing validation is unchanged: an unknown action 404s.
    expect((await req(appl, '/ui/api/pool/accounts/acct-4/delete', { method: 'POST' })).r.status).toBe(404)
    expect(calls).toHaveLength(0)
  })
})

describe('queued entries in the status', () => {
  it('normalizeAccount keeps a queue entry\'s fields and marks it queued', () => {
    const q = normalizeAccount(queuedEntry(4, { attempts: 2, lastError: 'no free exit' }))!
    expect(q).toMatchObject({ id: 'queued-4', state: 'queued', queued: true, scheduledAt: '2099-01-02T15:30:00.000Z', passive: false, exitKind: 'mullvad', attempts: 2, lastError: 'no free exit' })
    expect(normalizeAccount(upstreamAccount('acct-1'))).toMatchObject({ queued: false, scheduledAt: null, attempts: null })
  })

  it('GET /status and GET /accounts list queue entries next to the accounts', async () => {
    const { fetcher } = fakePool({
      'GET /status': () => json({ accounts: [upstreamAccount('acct-1'), queuedEntry(1)], queueDepth: 0 }),
      'GET /accounts': () => json({ accounts: [upstreamAccount('acct-1'), queuedEntry(1)] }),
      'GET /challenges': () => json([]),
    })
    const appl = mount(fetcher)
    expect((await req(appl, '/ui/api/pool/status')).data.status.accounts.map((a: { id: string }) => a.id)).toEqual(['acct-1', 'queued-1'])
    expect((await req(appl, '/ui/api/pool/accounts')).data.accounts[1]).toMatchObject({ id: 'queued-1', queued: true })
  })
})

describe('pool page: queued rows and several creations at once', () => {
  const clickOn = (dataset: Record<string, string>) => ({ target: { closest: (sel: string) => (sel === 'button' ? { dataset, closest: () => null } : null) } })
  const handler = (pg: { els: Map<string, StubEl> }, id: string, type = 'click') => (pg.els.get(id)!.handlers as Record<string, unknown>)[type] as (ev?: unknown) => Promise<void>
  const statusOf = (accounts: unknown[]) => () => json({ accounts, queueDepth: 0, totals: { requests_today: 5 } })

  it('lists a queued entry as its own row: queued chip, local time, cancel; not counted as an account', async () => {
    const { fetcher } = fakePool({
      'GET /status': statusOf([
        upstreamAccount('acct-1'), upstreamAccount('acct-2', { state: 'retired' }),
        queuedEntry(2, { scheduledAt: '2099-03-01T00:00:00Z', attempts: 2, lastError: 'no free exit', passive: true }),
        queuedEntry(1),
      ]),
      'GET /challenges': () => json([]),
    })
    const pg = await runPageTimed(POOL_PAGES.POOL_PAGE_HTML, mount(fetcher), makeEnv())
    const accts = pg.els.get('accts')!.innerHTML
    // Real accounts first, then queued by time (queued-1 is due before queued-2).
    expect(accts.indexOf('acct-1')).toBeLessThan(accts.indexOf('queued-1'))
    expect(accts.indexOf('queued-1')).toBeLessThan(accts.indexOf('queued-2'))
    expect(accts).toContain('<span class="badge queued"')
    expect(accts).toContain('>queued</span>')
    expect(accts).toContain('creates ')
    expect(accts).toContain('Tried 2 times, failed: no free exit')
    expect(accts).toContain('data-act="cancel" data-id="queued-1"')
    // A queued row has no state-details button and no rest/retest/retire.
    expect(accts).not.toContain('data-state-acct="queued-')
    expect(accts).not.toMatch(/data-act="(rest|retest|retire)" data-id="queued-/)
    // Totals: 1 live (acct-1); the retired one and the queued ones do not count; queued has its own tile.
    const stats = pg.els.get('stats')!.innerHTML
    expect(stats).toMatch(/<div class="v">1 \/ 1<\/div>/)
    expect(stats).toMatch(/<div class="k">queued accounts \(scheduled\)<\/div>/)
    expect(stats).toMatch(/<div class="k">queued accounts \(scheduled\)<\/div><div class="v">2<\/div>/)
  })

  it('shows no queued tile without queued entries, and a table with only queued entries still renders', async () => {
    const a = fakePool({ 'GET /status': statusOf([upstreamAccount('acct-1')]), 'GET /challenges': () => json([]) })
    const pa = await runPageTimed(POOL_PAGES.POOL_PAGE_HTML, mount(a.fetcher), makeEnv())
    expect(pa.els.get('stats')!.innerHTML).not.toContain('queued accounts')
    const b = fakePool({ 'GET /status': statusOf([queuedEntry(1)]), 'GET /challenges': () => json([]) })
    const pb = await runPageTimed(POOL_PAGES.POOL_PAGE_HTML, mount(b.fetcher), makeEnv())
    expect(pb.els.get('accts')!.innerHTML).toContain('queued-1')
    expect(pb.els.get('stats')!.innerHTML).toMatch(/<div class="v">0 \/ 0<\/div>/)
  })

  it('Cancel asks first, then calls the cancel route', async () => {
    const { fetcher, calls } = fakePool({
      'GET /status': statusOf([queuedEntry(1)]), 'GET /challenges': () => json([]),
      'POST /accounts/queued-1/cancel': () => json({ ok: true }),
    })
    const pg = await runPageTimed(POOL_PAGES.POOL_PAGE_HTML, mount(fetcher), makeEnv())
    const box = stubEl(); box.dataset = { acts: 'queued-1' }
    const click = (dataset: Record<string, string>) => ({ target: { closest: (sel: string) => (sel === 'button' ? { dataset, closest: () => box, disabled: false } : null) } })
    await handler(pg, 'accts')(click({ act: 'cancel', id: 'queued-1' }))
    expect(box.innerHTML).toContain('Cancel this scheduled account?')
    expect(box.innerHTML).toContain('data-yes="cancel"')
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
    await handler(pg, 'accts')(click({ yes: 'cancel' }))
    await settle()
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual([`${POOL}/accounts/queued-1/cancel`])
  })

  it('a scheduled Create sends scheduledAt (UTC ISO), closes the dialog and starts no flow', async () => {
    const { fetcher, calls } = fakePool({
      'GET /status': statusOf([]), 'GET /challenges': () => json([]),
      'POST /accounts': () => json({ queued: true, accountId: 'queued-5', scheduledAt: '2099-01-02T15:30:00Z' }),
    })
    const pg = await runPageTimed(POOL_PAGES.POOL_PAGE_HTML, mount(fetcher), makeEnv())
    const pad = (n: number) => String(n).padStart(2, '0')
    const d = new Date(Date.now() + 3 * 86400_000)
    const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
    const when = stubEl(); when.value = local
    pg.els.set('add-when', when)
    const close = vi.fn(); pg.els.get('add-dlg')!.close = close
    await handler(pg, 'add-create')()
    await settle()
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.body).toEqual({ passive: false, scheduledAt: new Date(local).toISOString() })
    expect(close).toHaveBeenCalledTimes(1)
    expect(when.value).toBe('')
    // No challenge to follow for a queued account.
    await pg.fire(2500)
    expect(calls.filter((c) => c.url.includes('/challenges/'))).toHaveLength(0)
  })

  it('a scheduled Create refuses a past or too-far time in the page, before any request', async () => {
    const { fetcher, calls } = fakePool({ 'GET /status': statusOf([]), 'GET /challenges': () => json([]) })
    const pg = await runPageTimed(POOL_PAGES.POOL_PAGE_HTML, mount(fetcher), makeEnv())
    const when = stubEl(); pg.els.set('add-when', when)
    const msg = stubEl(); pg.els.set('add-form-msg', msg)
    for (const v of ['2001-01-01T00:00', '2999-01-01T00:00']) {
      when.value = v
      msg.innerHTML = ''
      await handler(pg, 'add-create')()
      await settle()
      expect(msg.innerHTML).toContain('banner bad')
    }
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
    expect(pg.els.get('add-create')!.disabled).toBe(false)
  })

  it('the dialog has a datetime-local box, empty by default', () => {
    expect(POOL_PAGES.POOL_PAGE_HTML).toContain('<input id="add-when" type="datetime-local" />')
  })

  it('"+ Add account" opens a fresh dialog while creations run, and each creation keeps its own progress', async () => {
    let n = 0
    const { fetcher, calls } = fakePool({
      'GET /status': statusOf([]), 'GET /challenges': () => json([]),
      'POST /accounts': () => { n++; return json(n === 1 ? { challengeId: 'ch_a', accountId: 'acct-21' } : { challengeId: 'ch_b', accountId: 'acct-22' }) },
      'GET /challenges/ch_a': () => json({ id: 'ch_a', type: 'image', state: 'pending', step: 'form_opened', ready: false, account: 'acct-21' }),
      'GET /challenges/ch_b': () => json({ id: 'ch_b', type: 'image', state: 'pending', step: 'awaiting_email', ready: false, account: 'acct-22' }),
    })
    const pg = await runPageTimed(POOL_PAGES.POOL_PAGE_HTML, mount(fetcher), makeEnv())
    // First creation, then a fresh form, then a second one.
    await handler(pg, 'add-btn')(); await handler(pg, 'add-create')(); await settle()
    expect(pg.els.get('add-steps')!.innerHTML).toMatch(/<li class="cur">.*Signup form opened/)
    await handler(pg, 'add-btn')()
    expect(pg.els.get('add-form')!.hidden).toBe(false) // the bug: this used to show creation 1's progress instead
    expect(pg.els.get('add-progress')!.hidden).toBe(true)
    expect(pg.els.get('add-create')!.disabled).toBe(false)
    expect(pg.els.get('add-active')!.innerHTML).toContain('acct-21')
    await handler(pg, 'add-create')(); await settle()
    expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/accounts'))).toHaveLength(2)
    expect(pg.els.get('add-steps')!.innerHTML).toMatch(/<li class="cur">.*Waiting for the confirmation email/)
    // Both are polled, and a third click lists both with their own step.
    const m = calls.length
    await pg.fire(2500)
    const polled = calls.slice(m).map((c) => c.url.slice(POOL.length))
    expect(polled).toContain('/challenges/ch_a'); expect(polled).toContain('/challenges/ch_b')
    await handler(pg, 'add-btn')()
    const list = pg.els.get('add-active')!.innerHTML
    expect(list).toContain('acct-21'); expect(list).toContain('acct-22')
    expect(list).toContain('Signup form opened'); expect(list).toContain('Waiting for the confirmation email')
    // Reopen the first one from the list: its own steps are drawn, not the second one's.
    const key = /data-flow="([^"]+)"/.exec(list)![1]!
    await handler(pg, 'add-active')(clickOn({ flow: key }))
    expect(pg.els.get('add-progress')!.hidden).toBe(false)
    expect(pg.els.get('add-steps')!.innerHTML).toMatch(/<li class="cur">.*Signup form opened/)
    await handler(pg, 'add-back')()
    expect(pg.els.get('add-form')!.hidden).toBe(false)
  })

  it('a creation that finishes in the background does not repaint the dialog the owner is on', async () => {
    const { fetcher } = fakePool({
      'GET /status': statusOf([]), 'GET /challenges': () => json([]),
      'POST /accounts': () => json({ challengeId: 'ch_a', accountId: 'acct-21' }),
      'GET /challenges/ch_a': () => json({ id: 'ch_a', type: 'image', state: 'solved', step: 'done', ready: false, account: 'acct-21' }),
    })
    const pg = await runPageTimed(POOL_PAGES.POOL_PAGE_HTML, mount(fetcher), makeEnv())
    await handler(pg, 'add-btn')(); await handler(pg, 'add-create')(); await settle()
    expect(pg.els.get('add-msg')!.innerHTML).toContain('acct-21 is ready')
    await handler(pg, 'add-btn')() // fresh form
    pg.els.get('add-msg')!.innerHTML = 'untouched'
    await pg.fire(2500)
    expect(pg.els.get('add-msg')!.innerHTML).toBe('untouched')
    expect(pg.els.get('add-form')!.hidden).toBe(false)
  })

  it('a failed create stays on screen with Try again; Try again returns to the form', async () => {
    const { fetcher } = fakePool({ 'GET /status': statusOf([]), 'GET /challenges': () => json([]), 'POST /accounts': () => json({ error: 'no_free_exit' }, 409) })
    const pg = await runPageTimed(POOL_PAGES.POOL_PAGE_HTML, mount(fetcher), makeEnv())
    await handler(pg, 'add-btn')(); await handler(pg, 'add-create')(); await settle()
    expect(pg.els.get('add-retry')!.hidden).toBe(false)
    await handler(pg, 'add-retry')()
    expect(pg.els.get('add-form')!.hidden).toBe(false)
    expect(pg.els.get('add-active')!.hidden).toBe(true)
  })
})
