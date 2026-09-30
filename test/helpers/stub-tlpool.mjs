#!/usr/bin/env node
/**
 * In-memory stand-in for tlpool (quest spec "tlpool HTTP contract v1", shapes
 * as built in the tlpool repo's api.py), for clicking through the Worker under
 * `wrangler dev` without touching 1001tracklists. It serves the saved pages in
 * test/fixtures and never makes an outbound request.
 *
 *   node test/helpers/stub-tlpool.mjs            # listens on 127.0.0.1:8799
 *   PORT=8800 TLPOOL_TOKEN=x node test/helpers/stub-tlpool.mjs
 *
 * Then in .dev.vars: TLPOOL_URL=http://127.0.0.1:8799 and the same
 * TLPOOL_TOKEN (default `dev-pool-token`).
 *
 * What it does:
 *   - POST /fetch: set pages by tracklist slug from the fixtures (unknown
 *     slugs get the habstrakt page), DJ pages, search, media links; answers
 *     alternate between acct-1 and acct-2 (honouring excludeAccounts), so a
 *     verification second fetch can agree. `STUB_FETCH_ERROR=budget_exhausted`
 *     makes every fetch answer that contract error (HTTP 200, like tlpool).
 *   - accounts, status, settings (tlpool's defaults), rest/retire/retest
 *   - two open challenges: `ch-img-1` (image; answer "right" solves it,
 *     anything else is wrong) and `ch-box-1` (checkbox, with a live view page);
 *     GET /challenges/:id/image is a real PNG
 *   - POST /accounts starts a signup whose `step` advances every 2 s through
 *     tlpool's SIGNUP_STEPS, skipping awaiting_captcha as the real form does
 */
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const PORT = Number(process.env.PORT ?? 8799)
const TOKEN = process.env.TLPOOL_TOKEN ?? 'dev-pool-token'
const FORCED_ERROR = process.env.STUB_FETCH_ERROR ?? ''
const FIX = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')
const fx = (name) => readFileSync(resolve(FIX, name), 'utf8')

const SET_PAGES = {
  '18kll1h1': 'tracklist-habstrakt.html',
  '1pmwyfn1': 'tracklist-maxstyler.html',
  '1pqq0hst': 'tracklist-matroda.html',
}
const now = () => new Date().toISOString()
const iso = (ms) => new Date(ms).toISOString()

// ── state ────────────────────────────────────────────────────────────────
const settings = {
  budgetPerDay: 30, xhrBudgetPerDay: 60, xhrMinGapSeconds: 3, xhrGapMedianExtraSeconds: 6, ramp: [10, 20],
  reservedPhoneShare: 0.2, priorityCeilings: { new: 1.0, verify: 1.0, recheck: 0.9, backfill: 0.75 }, imagePolicy: 'allow',
  challengeTtlSeconds: 7200, flagRestSeconds: 259200,
}
const accounts = new Map()
function addAccount(n, over = {}) {
  const a = {
    id: `acct-${n}`, state: 'active', passive: false, exitLabel: `exit-${String.fromCharCode(96 + n)}`, exitKnown: true,
    usedToday: 0, budget: 30, usedXhrToday: 0, xhrBudget: 60, lastOk: null, lastChallenge: null, pendingChallenge: null,
    restUntil: null, restReason: null, flagged: false, retestPending: false, createdAt: iso(Date.now() - 5 * 86400e3),
    activatedAt: iso(Date.now() - 5 * 86400e3), retiredAt: null, lastError: null, busy: null, ...over,
  }
  accounts.set(a.id, a)
  return a
}
addAccount(1)
addAccount(2)
addAccount(3, { passive: true, budget: 0, xhrBudget: 0 })

const challenges = new Map()
function addChallenge(c) {
  challenges.set(c.id, { accountId: null, purpose: 'fetch', status: 'pending', step: null, error: null, ready: true, createdAt: now(), expiresAt: iso(Date.now() + 2 * 3600e3), ...c })
}
addChallenge({ id: 'ch-img-1', type: 'image', accountId: 'acct-1' })
addChallenge({ id: 'ch-box-1', type: 'checkbox', accountId: 'acct-2' })
accounts.get('acct-1').pendingChallenge = 'ch-img-1'

const SIGNUP_STEPS = ['exit_assigned', 'form_opened', 'submitted', 'awaiting_email', 'confirmed', 'logged_in', 'done']
let nextAccount = 4
let lastServed = 'acct-2'
const totals = { fetches: 0, errors: 0 }

function challengeView(c, base) {
  return {
    id: c.id, type: c.type, account: c.accountId, accountId: c.accountId, purpose: c.purpose, createdAt: c.createdAt, expiresAt: c.expiresAt,
    status: c.status, step: c.step, error: c.error, ready: c.ready,
    imageUrl: c.type === 'image' ? `${base}/challenges/${c.id}/image` : null,
    liveUrl: c.type === 'checkbox' && ['pending', 'wrong'].includes(c.status) ? `${base}/challenges/${c.id}/live/?t=stub` : null,
  }
}

// A real 120x40 PNG with a few dark bars, so an <img> renders something.
function png() {
  const w = 120, h = 40
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const dark = (x % 20 < 8 && y > 8 && y < 32)
      const o = y * (w * 3 + 1) + 1 + x * 3
      raw[o] = raw[o + 1] = raw[o + 2] = dark ? 40 : 235
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

function pageFor(url, kind) {
  if (kind === 'medialink') return fx('medialink-909720.json')
  if (kind === 'search') return fx('search-result.html')
  if (kind === 'dj') return /ajax/.test(url) ? fx('dj-adam-beyer-ajax-pos15.json') : fx('dj-adam-beyer-page1.html')
  const slug = url.match(/\/tracklist\/([^/]+)\//)?.[1]
  return fx(SET_PAGES[slug] ?? 'tracklist-habstrakt.html')
}

// ── server ───────────────────────────────────────────────────────────────
const send = (res, status, body, headers = {}) => {
  const isBuf = Buffer.isBuffer(body)
  res.writeHead(status, { 'Content-Type': isBuf ? 'image/png' : typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store', ...headers })
  res.end(isBuf || typeof body === 'string' ? body : JSON.stringify(body))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const base = `http://${req.headers.host}`
  let raw = ''
  for await (const c of req) raw += c
  const body = raw ? (() => { try { return JSON.parse(raw) } catch { return null } })() : {}
  const p = url.pathname
  console.log(`[stub-tlpool] ${req.method} ${p}${body && body.url ? ` ${body.kind}/${body.priority} ${body.url.replace(/^https?:\/\/[^/]+/, '')}` : ''}`)
  const live = /^\/challenges\/[^/]+\/live/.test(p)
  if (p === '/healthz') return send(res, 200, { ok: true })
  if (!live && req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'unauthorized' })

  if (req.method === 'POST' && p === '/fetch') {
    if (!body || typeof body.url !== 'string') return send(res, 400, { error: 'bad_request', message: 'url' })
    totals.fetches++
    if (FORCED_ERROR) { totals.errors++; return send(res, 200, { error: FORCED_ERROR, retryAfterSeconds: 900 }) }
    const exclude = new Set(body.excludeAccounts ?? [])
    const pick = ['acct-1', 'acct-2'].filter((a) => !exclude.has(a))
    const accountId = pick.find((a) => a !== lastServed) ?? pick[0]
    if (!accountId) return send(res, 200, { error: 'no_healthy_account', retryAfterSeconds: 3600 })
    lastServed = accountId
    const a = accounts.get(accountId)
    a.usedToday++; a.lastOk = now()
    const html = pageFor(body.url, body.kind)
    return send(res, 200, { status: 200, finalUrl: body.url, html, accountId, exitLabel: a.exitLabel, fetchedAt: now(), bytes: html.length })
  }
  if (req.method === 'GET' && p === '/status') {
    const list = [...accounts.values()]
    const byState = {}
    for (const a of list) byState[a.state] = (byState[a.state] ?? 0) + 1
    return send(res, 200, { accounts: list, queueDepth: 0, queueByPriority: {}, browsers: [], pendingChallenges: [...challenges.values()].filter((c) => ['pending', 'wrong'].includes(c.status)).length, totals: { ...totals, accountsByState: byState, usedToday: list.reduce((s, a) => s + a.usedToday, 0), budgetToday: list.reduce((s, a) => s + a.budget, 0) }, exits: [], settings })
  }
  if (req.method === 'GET' && p === '/accounts') return send(res, 200, { accounts: [...accounts.values()] })
  if (req.method === 'POST' && p === '/accounts') {
    const n = nextAccount++
    const a = addAccount(n, { state: 'signup', passive: body?.passive === true, busy: 'signup', activatedAt: null, createdAt: now() })
    const id = `ch-signup-${n}`
    addChallenge({ id, type: 'image', accountId: a.id, purpose: 'signup', step: SIGNUP_STEPS[0], ready: false })
    let i = 0
    const timer = setInterval(() => {
      const c = challenges.get(id)
      i++
      if (i >= SIGNUP_STEPS.length) { clearInterval(timer); return }
      c.step = SIGNUP_STEPS[i]
      if (c.step === 'done') { c.status = 'solved'; a.state = 'warming'; a.busy = null; a.activatedAt = now() }
    }, 2000)
    return send(res, 200, { challengeId: id, accountId: a.id })
  }
  let m
  if ((m = p.match(/^\/accounts\/([^/]+)\/(rest|retire|retest)$/)) && req.method === 'POST') {
    const a = accounts.get(m[1])
    if (!a) return send(res, 404, { error: 'not_found' })
    if (m[2] === 'rest') { a.state = 'resting'; a.restUntil = iso(Date.now() + (body?.seconds ?? 21600) * 1000); a.restReason = body?.reason ?? 'manual' }
    if (m[2] === 'retire') { a.state = 'retired'; a.retiredAt = now() }
    if (m[2] === 'retest') a.retestPending = true
    return send(res, 200, a)
  }
  if (p === '/settings' && req.method === 'GET') return send(res, 200, settings)
  if (p === '/settings' && req.method === 'PUT') {
    for (const [k, v] of Object.entries(body ?? {})) {
      if (!(k in settings)) return send(res, 400, { error: 'bad_request', message: `unknown setting ${k}` })
      settings[k] = v
    }
    return send(res, 200, settings)
  }
  if (p === '/challenges' && req.method === 'GET') return send(res, 200, { challenges: [...challenges.values()].filter((c) => ['pending', 'wrong'].includes(c.status)).map((c) => challengeView(c, base)) })
  if ((m = p.match(/^\/challenges\/([^/]+)$/)) && req.method === 'GET') {
    const c = challenges.get(m[1])
    return c ? send(res, 200, challengeView(c, base)) : send(res, 404, { error: 'not_found' })
  }
  if ((m = p.match(/^\/challenges\/([^/]+)\/image$/))) return challenges.get(m[1])?.type === 'image' ? send(res, 200, png()) : send(res, 404, { error: 'not_found' })
  if ((m = p.match(/^\/challenges\/([^/]+)\/answer$/)) && req.method === 'POST') {
    const c = challenges.get(m[1])
    if (!c) return send(res, 404, { error: 'not_found' })
    if (!['pending', 'wrong'].includes(c.status)) return send(res, 409, { error: 'challenge_closed' })
    if (c.type === 'checkbox') {
      c.status = 'solved'
      return send(res, 200, { status: 'solved' })
    }
    if (body?.text === 'right') { c.status = 'solved'; return send(res, 200, { status: 'solved' }) }
    c.status = 'wrong'
    return send(res, 422, { status: 'wrong', error: 'the site rejected that answer; a fresh image is up' })
  }
  if ((m = p.match(/^\/challenges\/([^/]+)\/live\/?$/))) return send(res, 200, `<!doctype html><title>live view (stub)</title><p>Live view of ${m[1]} (stub: no browser here).</p>`)
  return send(res, 404, { error: 'not_found' })
})

server.listen(PORT, '127.0.0.1', () => console.log(`[stub-tlpool] listening on http://127.0.0.1:${PORT} (token ${TOKEN === 'dev-pool-token' ? 'dev-pool-token' : 'from TLPOOL_TOKEN'})`))
