#!/usr/bin/env node
/**
 * Tiny HTTP fetch-forwarder. Runs on a residential-IP host (e.g. a home NAS)
 * and is exposed to the public internet by cloudflared. The Cloudflare Worker
 * calls this with `?url=<encoded>` + a shared bearer; the forwarder makes the
 * request and returns the response.
 *
 * Routing (see nas-fetch-proxy-lib.mjs for the state machine):
 *   1. Direct from the residential IP while it is healthy.
 *   2. When 1001tracklists blocks the residential IP (HTTP 403 / unblock_ip
 *      captcha form), direct goes into a cooldown (BLOCK_COOLDOWN_MS, 1 h) and
 *      the same request is retried through a random member of FALLBACK_PROXIES
 *      — HTTP proxies (tinyproxy buckets on the tailnet) each with their own
 *      egress IP. The first request after the cooldown probes direct again.
 *   3. If every route is blocked the forwarder answers 503 with the block
 *      page body and `X-Proxy-All-Blocked: 1`; the Worker pauses.
 *
 * Every response carries X-Proxy-* headers describing which route served it
 * and whether direct is currently blocked, so the Worker can raise the
 * "solve the captcha" alert even while requests are succeeding via the pool.
 *
 * 1001tracklists serves Cloudflare Worker egress IPs a captcha shell on
 * tracklist GETs. With a residential IP alone we still get an upstream
 * "Please wait, you will be forwarded" Turnstile gate on cold-cache URLs;
 * authenticating with a 1001tl account skips that gate. So when login creds
 * are configured the forwarder logs in once, persists the session cookies
 * (`uid`, `sid`, `guid`) to disk, and injects them on every 1001tl request.
 * If a gated response slips through (cookies expired) it re-logs-in and
 * retries once on the same route.
 *
 * Endpoints (all but /health require `Authorization: Bearer $PROXY_TOKEN`):
 *   GET|POST /?url=<encoded>    forward the request (method, body and the
 *                               passthrough headers below are preserved)
 *   GET  /health                liveness, unauthenticated
 *   GET  /status                route state: direct cooldown, pool health,
 *                               counters
 *   POST /probe[?url=]          force one direct fetch of PROBE_URL (or ?url);
 *                               responds { probe: ok|ip_blocked|gated|error, … }
 *                               plus the same snapshot as /status
 * Request header `X-Proxy-Force-Route: direct|pool` (bearer-gated like the
 * rest) overrides the planner for that one request — used by the Worker's
 * tests and the admin page's "re-probe" button.
 *
 * Env:
 *   PROXY_TOKEN              required, shared with the Worker (HOME_PROXY_TOKEN)
 *   PORT                     default 8088
 *   BIND                     default 0.0.0.0 (container-friendly)
 *   ALLOWED_HOSTS            default "www.1001tracklists.com,1001tracklists.com"
 *   REQUEST_TIMEOUT_MS       per-attempt upstream timeout, default 15000
 *   FALLBACK_PROXIES         comma/newline-separated HTTP proxy URLs, each
 *                            optionally `label=url`; empty = no fallback
 *   BLOCK_COOLDOWN_MS        default 3600000 (1 h)
 *   ERROR_COOLDOWN_MS        bench time for a pool member after a transport
 *                            error / tinyproxy error page, default 600000 (10 min)
 *   POOL_CONNECT_TIMEOUT_MS  TCP connect timeout to a pool member, default 5000
 *   MAX_POOL_ATTEMPTS        pool members tried per request, default 2
 *   PROBE_URL                tracklist URL fetched by POST /probe; default a
 *                            known set page (the homepage is NOT gated when
 *                            blocked, so it is useless as a probe)
 *   UPSTREAM_1001TL_EMAIL    optional; enables logged-in mode for 1001tl
 *   UPSTREAM_1001TL_PASSWORD optional; enables logged-in mode for 1001tl
 *   COOKIE_FILE              default /data/1001tl-cookies.json
 */

import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fetch as undiciFetch, ProxyAgent } from 'undici'
import {
  classifyUpstream,
  extractBlockedIp,
  parsePoolConfig,
  RoutePlanner,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_ERROR_COOLDOWN_MS,
  DEFAULT_MAX_POOL_ATTEMPTS,
} from './nas-fetch-proxy-lib.mjs'

const VERSION = '0.3.1'
const PORT = Number(process.env.PORT ?? 8088)
const BIND = process.env.BIND ?? '0.0.0.0'
const TOKEN = process.env.PROXY_TOKEN
const TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 15000)
const ALLOWED_HOSTS = new Set(
  (process.env.ALLOWED_HOSTS ?? 'www.1001tracklists.com,1001tracklists.com')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean),
)
const COOLDOWN_MS = Number(process.env.BLOCK_COOLDOWN_MS ?? DEFAULT_COOLDOWN_MS)
const ERROR_COOLDOWN_MS = Number(process.env.ERROR_COOLDOWN_MS ?? DEFAULT_ERROR_COOLDOWN_MS)
// A dead bucket must not hold a request for the full upstream timeout.
const POOL_CONNECT_TIMEOUT_MS = Number(process.env.POOL_CONNECT_TIMEOUT_MS ?? 5000)
const MAX_POOL_ATTEMPTS = Number(process.env.MAX_POOL_ATTEMPTS ?? DEFAULT_MAX_POOL_ATTEMPTS)
const PROBE_URL =
  process.env.PROBE_URL ??
  'https://www.1001tracklists.com/tracklist/2klx8j7t/armin-van-buuren-ruben-de-ronde-ferry-corsten-a-state-of-trance-1248-ade-special-amsterdam-dance-event-netherlands-2025-10-23.html'

if (!TOKEN) {
  console.error('PROXY_TOKEN env is required')
  process.exit(1)
}

let POOL
try {
  POOL = parsePoolConfig(process.env.FALLBACK_PROXIES)
} catch (e) {
  console.error(String(e?.message ?? e))
  process.exit(1)
}

const TL_HOST = '1001tracklists.com'
const TL_LOGIN_URL = 'https://www.1001tracklists.com/action/login.html'
const TL_EMAIL = process.env.UPSTREAM_1001TL_EMAIL ?? ''
const TL_PASSWORD = process.env.UPSTREAM_1001TL_PASSWORD ?? ''
const COOKIE_FILE = process.env.COOKIE_FILE ?? '/data/1001tl-cookies.json'

// Browser UA used both for the in-process login and the override below.
// 1001tl rejects curl/<Y> shaped agents on tracklist pages even with valid
// session cookies.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'

// Headers we forward from caller → upstream. Anything else (Host, X-Forwarded-*,
// CF-*, X-Proxy-*, Authorization, etc.) is dropped to avoid leaking proxy
// plumbing to 1001tl.
const REQUEST_PASSTHRU = new Set([
  'user-agent',
  'accept',
  'accept-language',
  'accept-encoding',
  'referer',
  'content-type',
  'x-requested-with',
])

// Headers we drop on the response side. Hop-by-hop + encoding/length get
// recomputed by the Node response writer once we re-buffer the body. Set-Cookie
// from the upstream is intentionally suppressed so the forwarder's auth
// cookies stay server-side and never leak back to the Worker.
const RESPONSE_DROP = new Set([
  'content-encoding',
  'transfer-encoding',
  'content-length',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
  'set-cookie',
])

const planner = new RoutePlanner({ pool: POOL, cooldownMs: COOLDOWN_MS, errorCooldownMs: ERROR_COOLDOWN_MS, maxPoolAttempts: MAX_POOL_ATTEMPTS })
// One dispatcher per pool member; undici's ProxyAgent does CONNECT tunnelling
// for https targets, which is exactly what tinyproxy expects.
const dispatchers = new Map(
  POOL.map((m) => [m.url, new ProxyAgent({ uri: m.url, connect: { timeout: POOL_CONNECT_TIMEOUT_MS } })]),
)

let session = { cookies: '', savedAt: 0 }
let loginPromise = null

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, t: new Date().toISOString(), ...fields }))
}

function isTracklistsHost(hostname) {
  return hostname === TL_HOST || hostname.endsWith(`.${TL_HOST}`)
}

function routeLabel(route) {
  return route.kind === 'direct' ? 'direct' : route.member.label
}

function parseSetCookies(setCookieHeaders) {
  const out = {}
  for (const line of setCookieHeaders) {
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const name = line.slice(0, eq).trim()
    const semi = line.indexOf(';', eq)
    const value = (semi < 0 ? line.slice(eq + 1) : line.slice(eq + 1, semi)).trim()
    if (name) out[name] = value
  }
  return out
}

function cookieJarToHeader(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
}

async function loadCookiesFromDisk() {
  try {
    const txt = await readFile(COOKIE_FILE, 'utf8')
    const obj = JSON.parse(txt)
    if (obj && typeof obj.cookies === 'string' && obj.cookies.length) {
      return { cookies: obj.cookies, savedAt: obj.savedAt ?? 0 }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') log('cookies.load_error', { error: String(e?.message ?? e) })
  }
  return null
}

async function saveCookiesToDisk(state) {
  try {
    await mkdir(dirname(COOKIE_FILE), { recursive: true })
    await writeFile(COOKIE_FILE, JSON.stringify(state, null, 2))
  } catch (e) {
    log('cookies.save_error', { error: String(e?.message ?? e) })
  }
}

/**
 * Log in to 1001tl. Uses the same route the triggering request is on, so a
 * login forced by a gate on a pool member happens from that member's IP.
 */
async function doLogin(dispatcher) {
  if (!TL_EMAIL || !TL_PASSWORD) {
    throw new Error('UPSTREAM_1001TL_EMAIL/PASSWORD not configured')
  }
  const init = (extra) => ({ ...extra, ...(dispatcher ? { dispatcher } : {}) })
  // 1) seed guid by visiting homepage
  const homepageRes = await undiciFetch(
    'https://www.1001tracklists.com/',
    init({ headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }, redirect: 'manual' }),
  )
  await homepageRes.arrayBuffer()
  const homeJar = parseSetCookies(homepageRes.headers.getSetCookie?.() ?? [])

  // 2) POST login form
  const body = new URLSearchParams({
    email: TL_EMAIL,
    password: TL_PASSWORD,
    referer: 'https://www.1001tracklists.com/',
  }).toString()
  const loginRes = await undiciFetch(
    TL_LOGIN_URL,
    init({
      method: 'POST',
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: TL_LOGIN_URL,
        Cookie: cookieJarToHeader(homeJar),
      },
      body,
      redirect: 'manual',
    }),
  )
  await loginRes.arrayBuffer()
  const loginJar = { ...homeJar, ...parseSetCookies(loginRes.headers.getSetCookie?.() ?? []) }

  if (!loginJar.uid || !loginJar.sid) {
    throw new Error(
      `login did not set uid/sid (status=${loginRes.status}, jar=${Object.keys(loginJar).join(',')})`,
    )
  }

  const cookies = cookieJarToHeader(loginJar)
  const state = { cookies, savedAt: Date.now() }
  session = state
  await saveCookiesToDisk(state)
  log('login.ok', { status: loginRes.status, cookieNames: Object.keys(loginJar).join(',') })
  return state
}

async function ensureSession({ forceRefresh = false, dispatcher = null } = {}) {
  if (forceRefresh) {
    session = { cookies: '', savedAt: 0 }
  }
  if (session.cookies) return session
  if (loginPromise) return loginPromise

  if (!forceRefresh) {
    const fromDisk = await loadCookiesFromDisk()
    if (fromDisk) {
      session = fromDisk
      log('cookies.loaded', { savedAt: fromDisk.savedAt })
      return session
    }
  }

  loginPromise = doLogin(dispatcher).finally(() => {
    loginPromise = null
  })
  try {
    return await loginPromise
  } catch (e) {
    log('login.error', { error: String(e?.message ?? e) })
    throw e
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * One upstream attempt on one route. Returns `{ upstream, buf, text }`.
 * Throws on transport failure / timeout.
 */
async function fetchVia(route, target, method, reqHeaders, body, extraHeaders) {
  const headers = {}
  for (const [k, v] of Object.entries(reqHeaders)) {
    if (REQUEST_PASSTHRU.has(k.toLowerCase()) && v !== undefined) {
      headers[k] = Array.isArray(v) ? v.join(', ') : v
    }
  }
  for (const [k, v] of Object.entries(extraHeaders)) {
    if (v) headers[k] = v
  }
  const init = {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }
  if (route.kind === 'pool') init.dispatcher = dispatchers.get(route.member.url)
  const upstream = await undiciFetch(target, init)
  const buf = Buffer.from(await upstream.arrayBuffer())
  return { upstream, buf, text: buf.toString('utf8') }
}

/**
 * tinyproxy answers its own failures (cannot connect, bad gateway) with a
 * 5xx whose Server header names it; 1001tracklists' real responses come from
 * Apache. Only checked on pool routes.
 */
function isProxyErrorPage(upstream) {
  if (upstream.status < 500) return false
  const server = upstream.headers.get('server') ?? ''
  const via = upstream.headers.get('via') ?? ''
  return /tinyproxy/i.test(server) || /tinyproxy/i.test(via)
}

function directHeaders(res) {
  const s = planner.status()
  if (s.direct.blocked) {
    res.setHeader('x-proxy-direct-blocked-until', s.direct.blockedUntil)
    if (s.direct.blockedSince) res.setHeader('x-proxy-direct-blocked-since', s.direct.blockedSince)
    if (s.direct.blockedIp) res.setHeader('x-proxy-direct-blocked-ip', s.direct.blockedIp)
  }
  res.setHeader('x-proxy-pool-healthy', String(s.poolHealthy))
  res.setHeader('x-proxy-pool-total', String(s.poolTotal))
}

function sendJson(res, status, obj) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(obj))
}

/**
 * Forward one request across the planned routes. Returns a summary for the
 * access log.
 */
async function handleProxy(req, res, target, parsed, force) {
  const useSession = isTracklistsHost(parsed.hostname) && TL_EMAIL && TL_PASSWORD
  const method = req.method ?? 'GET'
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req)

  // 1001tl rejects non-browser User-Agents (curl/etc) and same-host requests
  // missing a Referer even with valid auth cookies. Force-set sane defaults
  // for 1001tl-bound requests so the Worker can stay header-light.
  const tlDefaults = isTracklistsHost(parsed.hostname)
    ? {
        'user-agent': UA,
        accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        referer: 'https://www.1001tracklists.com/',
      }
    : {}

  const callerCookie = req.headers.cookie ?? ''
  const withSession = (s) => (callerCookie ? `${callerCookie}; ${s.cookies}` : s.cookies)

  const routes = planner.plan(force)
  const attempts = []
  let lastBlocked = null
  let directRecovered = false

  if (routes.length === 0) {
    planner.noteAllBlocked()
    directHeaders(res)
    res.setHeader('x-proxy-route', 'none')
    res.setHeader('x-proxy-all-blocked', '1')
    res.setHeader('x-proxy-attempts', 'none:all_in_cooldown')
    sendJson(res, 503, { error: 'all_routes_blocked', ...planner.status() })
    return { route: 'none', kind: 'all_blocked', status: 503, bytes: 0, attempts: ['none:all_in_cooldown'] }
  }

  for (const route of routes) {
    const dispatcher = route.kind === 'pool' ? dispatchers.get(route.member.url) : null
    let cookieHeader = callerCookie
    if (useSession) {
      try {
        cookieHeader = withSession(await ensureSession({ dispatcher }))
      } catch (e) {
        res.statusCode = 502
        res.end(`session unavailable: ${e?.message ?? e}`)
        return { route: routeLabel(route), kind: 'session_error', status: 502, bytes: 0, attempts, error: String(e?.message ?? e) }
      }
    }

    let r
    try {
      r = await fetchVia(route, target, method, req.headers, body, { ...tlDefaults, cookie: cookieHeader })
    } catch (e) {
      const msg = String(e?.message ?? e)
      attempts.push(`${routeLabel(route)}:error`)
      if (route.kind === 'direct') {
        // A transport failure on the residential link is not a ban. Return
        // it as-is rather than doubling traffic through the pool during a
        // 1001tl outage.
        res.statusCode = 502
        directHeaders(res)
        res.setHeader('x-proxy-route', 'direct')
        res.setHeader('x-proxy-attempts', attempts.join(','))
        res.end(`upstream error: ${msg}`)
        return { route: 'direct', kind: 'transport_error', status: 502, bytes: 0, attempts, error: msg }
      }
      for (const ev of planner.report(route, 'error')) log(`route.${ev.event}`, ev)
      log('route.member_error', { label: route.member.label, error: msg })
      continue
    }

    if (route.kind === 'pool' && isProxyErrorPage(r.upstream)) {
      // tinyproxy could not reach 1001tl ("500 Unable to connect", a dead
      // secondary IP, upstream DNS failure): that is the bucket's problem,
      // not the page's. Bench it and move on like a transport error.
      attempts.push(`${routeLabel(route)}:error`)
      for (const ev of planner.report(route, 'error')) log(`route.${ev.event}`, ev)
      log('route.member_error', { label: route.member.label, error: `proxy error page ${r.upstream.status}`, body: r.text.slice(0, 120) })
      continue
    }

    let kind = classifyUpstream(r.upstream.status, r.text)
    if (kind === 'gated' && useSession) {
      log('upstream.gate_detected', { url: target, route: routeLabel(route), status: r.upstream.status })
      try {
        const s = await ensureSession({ forceRefresh: true, dispatcher })
        r = await fetchVia(route, target, method, req.headers, body, { ...tlDefaults, cookie: withSession(s) })
        kind = classifyUpstream(r.upstream.status, r.text)
        log('upstream.gate_retry', { url: target, route: routeLabel(route), status: r.upstream.status, kind, bytes: r.buf.length })
      } catch (e) {
        log('upstream.gate_retry_failed', { route: routeLabel(route), error: String(e?.message ?? e) })
      }
    }

    if (kind === 'ip_blocked') {
      const ip = extractBlockedIp(r.text)
      attempts.push(`${routeLabel(route)}:ip_blocked`)
      lastBlocked = { route, r, ip }
      for (const ev of planner.report(route, 'ip_blocked', { ip })) log(`route.${ev.event}`, { ...ev, url: target })
      continue
    }

    for (const ev of planner.report(route, kind)) {
      log(`route.${ev.event}`, ev)
      if (ev.event === 'direct.recovered') directRecovered = true
    }
    attempts.push(`${routeLabel(route)}:${kind}`)

    res.statusCode = r.upstream.status
    r.upstream.headers.forEach((value, key) => {
      if (RESPONSE_DROP.has(key.toLowerCase())) return
      res.setHeader(key, value)
    })
    directHeaders(res)
    res.setHeader('x-proxy-route', route.kind)
    res.setHeader('x-proxy-egress', routeLabel(route))
    res.setHeader('x-proxy-upstream-status', String(r.upstream.status))
    res.setHeader('x-proxy-attempts', attempts.join(','))
    if (directRecovered) res.setHeader('x-proxy-direct-recovered', '1')
    res.end(r.buf)
    return { route: routeLabel(route), kind, status: r.upstream.status, bytes: r.buf.length, attempts }
  }

  // Every route we tried came back blocked (or errored, for pool members).
  planner.noteAllBlocked()
  directHeaders(res)
  res.setHeader('x-proxy-route', 'none')
  res.setHeader('x-proxy-all-blocked', '1')
  res.setHeader('x-proxy-attempts', attempts.join(','))
  if (lastBlocked) {
    // Hand the block page back (as a 503, never the upstream 403) so the
    // Worker can run its own detector and read the blocked IP.
    res.statusCode = 503
    res.setHeader('content-type', lastBlocked.r.upstream.headers.get('content-type') ?? 'text/html; charset=utf-8')
    if (lastBlocked.ip) res.setHeader('x-proxy-blocked-ip', lastBlocked.ip)
    res.end(lastBlocked.r.buf)
    return { route: 'none', kind: 'all_blocked', status: 503, bytes: lastBlocked.r.buf.length, attempts, blockedIp: lastBlocked.ip }
  }
  sendJson(res, 503, { error: 'all_routes_failed', attempts, ...planner.status() })
  return { route: 'none', kind: 'all_failed', status: 503, bytes: 0, attempts }
}

/** POST /probe: one forced direct fetch to learn whether the ban has lifted. */
async function handleProbe(req, res, url) {
  const parsed = new URL(url)
  if (!ALLOWED_HOSTS.has(parsed.hostname)) return sendJson(res, 400, { error: 'probe url host not allowed' })
  const wasBlocked = planner.isDirectBlocked()
  const tlDefaults = {
    'user-agent': UA,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    referer: 'https://www.1001tracklists.com/',
  }
  const useSession = isTracklistsHost(parsed.hostname) && TL_EMAIL && TL_PASSWORD
  let cookie = ''
  if (useSession) {
    try {
      cookie = (await ensureSession()).cookies
    } catch (e) {
      return sendJson(res, 502, { error: `session unavailable: ${e?.message ?? e}` })
    }
  }
  const start = Date.now()
  try {
    const r = await fetchVia({ kind: 'direct' }, url, 'GET', {}, undefined, { ...tlDefaults, cookie })
    const kind = classifyUpstream(r.upstream.status, r.text)
    const ip = kind === 'ip_blocked' ? extractBlockedIp(r.text) : null
    const events = planner.report({ kind: 'direct' }, kind, { ip })
    for (const ev of events) log(`route.${ev.event}`, { ...ev, url, via: 'probe' })
    const out = { probe: kind, status: r.upstream.status, bytes: r.buf.length, ms: Date.now() - start, wasBlocked, blockedIp: ip, ...planner.status() }
    log('probe', { url, kind, status: r.upstream.status, wasBlocked, nowBlocked: planner.isDirectBlocked(), ms: out.ms })
    return sendJson(res, 200, out)
  } catch (e) {
    const msg = String(e?.message ?? e)
    log('probe.error', { url, error: msg, ms: Date.now() - start })
    return sendJson(res, 200, { probe: 'error', error: msg, wasBlocked, ...planner.status() })
  }
}

const server = createServer(async (req, res) => {
  const reqStart = Date.now()
  try {
    const reqUrl = new URL(req.url ?? '/', 'http://x')

    if (reqUrl.pathname === '/health') {
      return sendJson(res, 200, {
        ok: true,
        version: VERSION,
        hasSession: Boolean(session.cookies),
        directBlocked: planner.isDirectBlocked(),
        poolHealthy: planner.healthyMembers().length,
        poolTotal: POOL.length,
      })
    }

    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.statusCode = 401
      return res.end('unauthorized')
    }

    if (reqUrl.pathname === '/status') {
      return sendJson(res, 200, { version: VERSION, probeUrl: PROBE_URL, hasSession: Boolean(session.cookies), ...planner.status() })
    }

    if (reqUrl.pathname === '/probe') {
      if (req.method !== 'POST') {
        res.statusCode = 405
        return res.end('POST required')
      }
      const url = reqUrl.searchParams.get('url') || PROBE_URL
      try {
        new URL(url)
      } catch {
        return sendJson(res, 400, { error: 'invalid probe url' })
      }
      return handleProbe(req, res, url)
    }

    const target = reqUrl.searchParams.get('url')
    if (!target) {
      res.statusCode = 400
      return res.end('missing url query param')
    }
    let parsed
    try {
      parsed = new URL(target)
    } catch {
      res.statusCode = 400
      return res.end('invalid url')
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      res.statusCode = 400
      return res.end('only http(s) supported')
    }
    if (!ALLOWED_HOSTS.has(parsed.hostname)) {
      res.statusCode = 403
      return res.end(`host not allowed: ${parsed.hostname}`)
    }
    const forceRaw = req.headers['x-proxy-force-route']
    const force = forceRaw === 'direct' || forceRaw === 'pool' ? forceRaw : null

    const result = await handleProxy(req, res, target, parsed, force)
    // `blocked`/`all_blocked` are their own events so a Loki query on
    // event="fetch" only sees traffic that actually reached a page.
    const event = result.kind === 'ok' || result.kind === 'gated' ? 'fetch' : result.kind === 'all_blocked' ? 'all_blocked' : 'fetch_failed'
    log(event, {
      method: req.method,
      target,
      force,
      ...result,
      ms: Date.now() - reqStart,
    })
  } catch (e) {
    if (!res.headersSent) {
      res.statusCode = 502
      res.end(`upstream error: ${e?.message ?? String(e)}`)
    } else {
      res.end()
    }
    log('err', { url: req.url, error: e?.message ?? String(e), ms: Date.now() - reqStart })
  }
})

server.listen(PORT, BIND, () => {
  log('listen', {
    version: VERSION,
    bind: BIND,
    port: PORT,
    allowedHosts: [...ALLOWED_HOSTS],
    hasCreds: Boolean(TL_EMAIL && TL_PASSWORD),
    pool: POOL.map((m) => m.label),
    cooldownMs: COOLDOWN_MS,
    errorCooldownMs: ERROR_COOLDOWN_MS,
    poolConnectTimeoutMs: POOL_CONNECT_TIMEOUT_MS,
    maxPoolAttempts: MAX_POOL_ATTEMPTS,
    probeUrl: PROBE_URL,
  })
})
