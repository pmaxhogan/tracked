#!/usr/bin/env node
/**
 * Tiny HTTP fetch-forwarder. Runs on a residential-IP host (e.g. a home NAS)
 * and is exposed to the public internet by cloudflared. The Cloudflare Worker
 * calls this with `?url=<encoded>` + a shared bearer; the forwarder makes the
 * request from the residential IP and streams the response back.
 *
 * 1001tracklists serves Cloudflare Worker egress IPs a captcha shell on
 * tracklist GETs. With the residential IP alone we still get an upstream
 * "Please wait, you will be forwarded" Turnstile gate on cold-cache URLs;
 * authenticating with a 1001tl account skips that gate. So when login creds
 * are configured the forwarder logs in once, persists the session cookies
 * (`uid`, `sid`, `guid`) to disk, and injects them on every 1001tl request.
 * If a gated response slips through (cookies expired) it re-logs-in and
 * retries once.
 *
 * Run:
 *   PROXY_TOKEN=<long-random> \
 *   UPSTREAM_1001TL_EMAIL=you@example.com \
 *   UPSTREAM_1001TL_PASSWORD=<password> \
 *   COOKIE_FILE=./1001tl-cookies.json \
 *   node scripts/nas-fetch-proxy.mjs
 *
 * Env:
 *   PROXY_TOKEN              required, shared with the Worker (HOME_PROXY_TOKEN)
 *   PORT                     default 8088
 *   BIND                     default 0.0.0.0 (container-friendly)
 *   ALLOWED_HOSTS            default "www.1001tracklists.com,1001tracklists.com"
 *   REQUEST_TIMEOUT_MS       default 20000
 *   UPSTREAM_1001TL_EMAIL    optional; enables logged-in mode for 1001tl
 *   UPSTREAM_1001TL_PASSWORD optional; enables logged-in mode for 1001tl
 *   COOKIE_FILE              default /data/1001tl-cookies.json
 */

import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const PORT = Number(process.env.PORT ?? 8088)
const BIND = process.env.BIND ?? '0.0.0.0'
const TOKEN = process.env.PROXY_TOKEN
const TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 20000)
const ALLOWED_HOSTS = new Set(
  (process.env.ALLOWED_HOSTS ?? 'www.1001tracklists.com,1001tracklists.com')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean),
)

if (!TOKEN) {
  console.error('PROXY_TOKEN env is required')
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
// CF-*, etc.) is dropped to avoid leaking proxy plumbing to 1001tl.
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

let session = { cookies: '', savedAt: 0 }
let loginPromise = null

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, t: new Date().toISOString(), ...fields }))
}

function isTracklistsHost(hostname) {
  return hostname === TL_HOST || hostname.endsWith(`.${TL_HOST}`)
}

// Heuristic for the "Please wait, you will be forwarded to the requested
// page" Turnstile gate that 1001tl serves to unauthenticated/cold sessions.
function looksGated(html) {
  return (
    html.includes('turnstile-container') &&
    html.includes('Please wait, you will be forwarded')
  )
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

async function doLogin() {
  if (!TL_EMAIL || !TL_PASSWORD) {
    throw new Error('UPSTREAM_1001TL_EMAIL/PASSWORD not configured')
  }
  // 1) seed guid by visiting homepage
  const homepageRes = await fetch('https://www.1001tracklists.com/', {
    headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
    redirect: 'manual',
  })
  await homepageRes.arrayBuffer()
  const homeRaw =
    typeof homepageRes.headers.getSetCookie === 'function'
      ? homepageRes.headers.getSetCookie()
      : []
  const homeJar = parseSetCookies(homeRaw)

  // 2) POST login form
  const body = new URLSearchParams({
    email: TL_EMAIL,
    password: TL_PASSWORD,
    referer: 'https://www.1001tracklists.com/',
  }).toString()
  const loginRes = await fetch(TL_LOGIN_URL, {
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
  })
  await loginRes.arrayBuffer()

  const loginRaw =
    typeof loginRes.headers.getSetCookie === 'function'
      ? loginRes.headers.getSetCookie()
      : []
  const loginJar = { ...homeJar, ...parseSetCookies(loginRaw) }

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

async function ensureSession({ forceRefresh = false } = {}) {
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

  loginPromise = doLogin().finally(() => {
    loginPromise = null
  })
  try {
    return await loginPromise
  } catch (e) {
    log('login.error', { error: String(e?.message ?? e) })
    throw e
  }
}

async function fetchUpstream(target, req, extraHeaders = {}) {
  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (REQUEST_PASSTHRU.has(k.toLowerCase()) && v !== undefined) {
      headers[k] = Array.isArray(v) ? v.join(', ') : v
    }
  }
  for (const [k, v] of Object.entries(extraHeaders)) {
    if (v) headers[k] = v
  }

  const ac = new AbortController()
  const timer = setTimeout(
    () => ac.abort(new Error(`upstream timed out after ${TIMEOUT_MS}ms`)),
    TIMEOUT_MS,
  )
  let upstream
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req,
      redirect: 'follow',
      signal: ac.signal,
      duplex: 'half',
    })
  } finally {
    clearTimeout(timer)
  }
  const buf = Buffer.from(await upstream.arrayBuffer())
  return { upstream, buf }
}

async function handleProxy(req, res, target, parsed) {
  const useSession = isTracklistsHost(parsed.hostname) && TL_EMAIL && TL_PASSWORD

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

  let cookieHeader = req.headers.cookie ?? ''
  if (useSession) {
    try {
      const s = await ensureSession()
      cookieHeader = cookieHeader ? `${cookieHeader}; ${s.cookies}` : s.cookies
    } catch (e) {
      res.statusCode = 502
      return res.end(`session unavailable: ${e?.message ?? e}`)
    }
  }

  let { upstream, buf } = await fetchUpstream(target, req, {
    ...tlDefaults,
    cookie: cookieHeader,
  })

  if (useSession && looksGated(buf.toString('utf8'))) {
    log('upstream.gate_detected', { url: target, status: upstream.status })
    try {
      const s = await ensureSession({ forceRefresh: true })
      cookieHeader = req.headers.cookie ? `${req.headers.cookie}; ${s.cookies}` : s.cookies
      const retry = await fetchUpstream(target, req, {
        ...tlDefaults,
        cookie: cookieHeader,
      })
      upstream = retry.upstream
      buf = retry.buf
      log('upstream.gate_retry', { url: target, status: upstream.status, bytes: buf.length })
    } catch (e) {
      log('upstream.gate_retry_failed', { error: String(e?.message ?? e) })
    }
  }

  res.statusCode = upstream.status
  upstream.headers.forEach((value, key) => {
    if (RESPONSE_DROP.has(key.toLowerCase())) return
    res.setHeader(key, value)
  })
  res.end(buf)
  return { upstream, buf }
}

const server = createServer(async (req, res) => {
  const reqStart = Date.now()
  try {
    const reqUrl = new URL(req.url ?? '/', 'http://x')

    if (reqUrl.pathname === '/health') {
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ ok: true, hasSession: Boolean(session.cookies) }))
    }

    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.statusCode = 401
      return res.end('unauthorized')
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

    const result = await handleProxy(req, res, target, parsed)
    log('ok', {
      method: req.method,
      target,
      status: result?.upstream.status,
      bytes: result?.buf.length,
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
    bind: BIND,
    port: PORT,
    allowedHosts: [...ALLOWED_HOSTS],
    hasCreds: Boolean(TL_EMAIL && TL_PASSWORD),
  })
})
