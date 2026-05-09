#!/usr/bin/env node
/**
 * Tiny HTTP fetch-forwarder. Runs on a residential-IP host (e.g. a home NAS)
 * and is exposed to the public internet by cloudflared. The Cloudflare Worker
 * calls this with `?url=<encoded>` + a shared bearer; the forwarder makes the
 * request from the residential IP and streams the response back.
 *
 * The point: 1001tracklists serves Cloudflare Worker egress IPs a captcha
 * shell on tracklist GETs, but residential IPs come straight through. This
 * lets us avoid the BrightData unlocker (~$3/1k) on the happy path.
 *
 * Security: bind to 127.0.0.1 (the only path in is via cloudflared on the
 * same host); require a shared bearer (PROXY_TOKEN env) on every call;
 * restrict target hosts to an allowlist (ALLOWED_HOSTS env, comma-separated)
 * so a leaked bearer can't turn this into an open proxy.
 *
 * Run:
 *   PROXY_TOKEN=<long-random> node scripts/nas-fetch-proxy.mjs
 *
 * Env:
 *   PROXY_TOKEN     required, shared with the Worker (HOME_PROXY_TOKEN)
 *   PORT            default 8088
 *   BIND            default 127.0.0.1
 *   ALLOWED_HOSTS   default "www.1001tracklists.com,1001tracklists.com"
 *   REQUEST_TIMEOUT_MS  default 20000
 */

import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 8088)
const BIND = process.env.BIND ?? '127.0.0.1'
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

// Headers we forward from caller → upstream. Anything else (Host, X-Forwarded-*,
// CF-* etc.) is dropped to avoid leaking proxy plumbing to 1001tl.
const REQUEST_PASSTHRU = new Set([
  'user-agent',
  'accept',
  'accept-language',
  'accept-encoding',
  'cookie',
  'referer',
  'content-type',
  'x-requested-with',
])

// Headers we drop on the response side. Hop-by-hop + encoding/length get
// recomputed by the Node response writer once we re-buffer the body.
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
])

const server = createServer(async (req, res) => {
  const reqStart = Date.now()
  try {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.statusCode = 401
      return res.end('unauthorized')
    }
    const reqUrl = new URL(req.url ?? '/', 'http://x')
    if (reqUrl.pathname === '/health') {
      res.statusCode = 200
      return res.end('ok')
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

    const headers = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (REQUEST_PASSTHRU.has(k.toLowerCase()) && v !== undefined) {
        headers[k] = Array.isArray(v) ? v.join(', ') : v
      }
    }

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error(`upstream timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)
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

    res.statusCode = upstream.status
    upstream.headers.forEach((value, key) => {
      if (RESPONSE_DROP.has(key.toLowerCase())) return
      // node http supports duplicate Set-Cookie via array; the Headers iterator
      // collapses them into a single comma-joined string, which is incorrect
      // for cookies. Split safely on the date-comma boundary.
      if (key.toLowerCase() === 'set-cookie') {
        res.setHeader('set-cookie', splitSetCookie(value))
        return
      }
      res.setHeader(key, value)
    })
    const buf = Buffer.from(await upstream.arrayBuffer())
    res.end(buf)
    log('ok', { method: req.method, target, status: upstream.status, bytes: buf.length, ms: Date.now() - reqStart })
  } catch (e) {
    res.statusCode = 502
    res.end(`upstream error: ${e?.message ?? String(e)}`)
    log('err', { url: req.url, error: e?.message ?? String(e), ms: Date.now() - reqStart })
  }
})

server.listen(PORT, BIND, () => {
  console.log(JSON.stringify({ event: 'listen', bind: BIND, port: PORT, allowedHosts: [...ALLOWED_HOSTS] }))
})

function log(event, fields) {
  console.log(JSON.stringify({ event, t: new Date().toISOString(), ...fields }))
}

// fetch's Headers collapses multiple Set-Cookie into one comma-joined string,
// but commas inside Expires=... dates are valid. Split on comma only when the
// next token doesn't look like " <DayName>,".
function splitSetCookie(joined) {
  const out = []
  let buf = ''
  for (let i = 0; i < joined.length; i++) {
    const c = joined[i]
    if (c === ',' && !/^,\s\w{3},/.test(joined.slice(i, i + 6))) {
      out.push(buf.trim())
      buf = ''
    } else {
      buf += c
    }
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}
