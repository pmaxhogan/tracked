/**
 * Client for tlpool, the NAS browser pool that is the only thing allowed to
 * touch 1001tracklists (quest spec 2026-09-29, "tlpool HTTP contract v1").
 * The Worker decides WHAT to fetch and how urgent it is; tlpool decides which
 * account and exit, enforces the per-account budget and pacing, and relays
 * captchas to the owner. The Worker never sees credentials: `accountId` is an
 * opaque `acct-N` and `exitLabel` an opaque label, both safe to log.
 *
 * Env: `TLPOOL_URL` (base URL through the cloudflared tunnel) and
 * `TLPOOL_TOKEN` (bearer, also what tlpool presents on POST /pool/events).
 *
 * ## POST /fetch
 *
 * Request body (v1): `{ url, kind, priority, excludeAccounts?, maxWaitSeconds }`
 * plus three OPTIONAL fields this client adds for the two POST endpoints the
 * site has (contract extension, tlpool must honour them):
 *   - `method`: "GET" (default) | "POST"
 *   - `form`: form fields, sent `application/x-www-form-urlencoded` (search
 *     `/search/result.php`, DJ "older sets" `/ajax/get_data.php`)
 *   - `headers`: extra request headers (Referer, X-Requested-With)
 * For an XHR endpoint (`/ajax/*`) `html` carries the raw response body (JSON
 * text); the caller parses it.
 *
 * Success: `{ status, finalUrl, html, accountId, exitLabel, fetchedAt, bytes }`
 * where `status` is 1001tracklists' HTTP status as the browser saw it.
 * Long queueing (contract 2026-10-07): with `queueSeconds` > 0 the client
 * re-POSTs the identical request (each POST waiting at most 90 s: the
 * cloudflared tunnel cuts at 100 s) while tlpool answers `timeout` with
 * `reason` "queued" (no browser free yet; tlpool keeps the job's place) or
 * "running" (an account is on it), until queueSeconds after the first POST.
 * tlpool attaches a repeat POST to the job it already has.
 *
 * Refusal: `{ error, retryAfterSeconds, reason?, accountId?, queuedSeconds? }`, mapped here to the typed errors in
 * lib/upstream-errors.ts so every batch loop keeps its "stop, charge nothing"
 * behaviour:
 *   - budget_exhausted, challenge_pending        → PoolPausedError (deliberate stop)
 *   - no_healthy_account, blocked, timeout,
 *     unreachable / 401 / garbage from the pool  → PoolUnavailableError
 */

import { UpstreamPausedError, UpstreamUnavailableError } from './upstream-errors'
import type { Logger } from './log'
import type { Env } from '../types'

export const POOL_KINDS = ['set', 'dj', 'search', 'medialink'] as const
export type PoolKind = (typeof POOL_KINDS)[number]

/** Highest first (quest decision 12). `phone` has a reserved share inside tlpool. */
export const POOL_PRIORITIES = ['phone', 'new', 'verify', 'recheck', 'backfill'] as const
export type PoolPriority = (typeof POOL_PRIORITIES)[number]

/** tlpool answers a phone-priority fetch within 25 s or not at all (contract). */
export const PHONE_MAX_WAIT_SECONDS = 25
export const DEFAULT_MAX_WAIT_SECONDS = 20
/** One POST's longest wait: the cloudflared tunnel cuts a request at 100 s. */
export const POOL_MAX_WAIT_SECONDS = 90
/** Longest queueSeconds tlpool accepts (contract). */
export const POOL_MAX_QUEUE_SECONDS = 900
/** Extra client-side time on top of maxWaitSeconds for the tunnel round trip. */
const CLIENT_SLACK_MS = 8000

export type PoolConfig = {
  url: string
  token: string
  /** Injectable for tests (the youtube-playlists pattern). */
  fetchImpl?: typeof fetch
}

export function poolConfigFromEnv(env: Pick<Env, 'TLPOOL_URL' | 'TLPOOL_TOKEN'>, fetchImpl?: typeof fetch): PoolConfig | null {
  if (!env.TLPOOL_URL || !env.TLPOOL_TOKEN) return null
  return { url: env.TLPOOL_URL.replace(/\/+$/, ''), token: env.TLPOOL_TOKEN, ...(fetchImpl ? { fetchImpl } : {}) }
}

export type PoolFetchRequest = {
  url: string
  kind: PoolKind
  priority: PoolPriority
  excludeAccounts?: string[]
  maxWaitSeconds?: number
  method?: 'GET' | 'POST'
  form?: Record<string, string>
  headers?: Record<string, string>
  /**
   * Keep re-POSTing for up to this many seconds while tlpool says the job is
   * queued or running (manual syncs: `manualQueueSeconds`). 0/absent = one
   * POST. Ignored for phone, whose caller waits under the 25 s contract.
   */
  queueSeconds?: number
}

export type PoolFetchOk = {
  status: number
  finalUrl: string
  html: string
  accountId: string
  exitLabel: string
  fetchedAt: string
  bytes: number
}

export type PoolErrorCode = 'budget_exhausted' | 'challenge_pending' | 'no_healthy_account' | 'blocked' | 'timeout'
export type PoolFaultCode = PoolErrorCode | 'not_configured' | 'unreachable' | 'unauthorized' | 'bad_response'

/**
 * What tlpool says about a timeout (contract 2026-10-07): `reason` "queued" =
 * no browser free yet (every one busy, or paced), "running" = an account has
 * it and its page load has not finished, "browser" = that page load stalled
 * and tlpool killed it, "net_error" / "internal". Old tlpool sends none.
 */
export type PoolFaultInfo = {
  reason?: string | null
  accountId?: string | null
  /** Seconds since the first POST of this request. */
  waitedSeconds?: number | null
}

const PAUSE_CODES = new Set<PoolFaultCode>(['budget_exhausted', 'challenge_pending'])

/** tlpool refused on purpose (budget spent, captcha waiting for the owner). Stop the batch; retry after `retryAfterSeconds`. */
export class PoolPausedError extends UpstreamPausedError {
  readonly code: PoolFaultCode
  readonly retryAfterSeconds: number | null
  constructor(code: PoolFaultCode, retryAfterSeconds: number | null) {
    super(`pool: ${code}`, retryAfterSeconds !== null ? new Date(Date.now() + retryAfterSeconds * 1000).toISOString() : null)
    this.name = 'PoolPausedError'
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/** tlpool cannot serve right now (or is not reachable). Stop the batch, charge nothing. */
export class PoolUnavailableError extends UpstreamUnavailableError {
  readonly code: PoolFaultCode
  readonly retryAfterSeconds: number | null
  /** tlpool's `reason` (PoolFaultInfo), null when it sent none. */
  readonly poolReason: string | null
  /** The account the reason is about (running, browser), when tlpool named one. */
  readonly accountId: string | null
  readonly waitedSeconds: number | null
  constructor(code: PoolFaultCode, detail?: string, retryAfterSeconds: number | null = null, info: PoolFaultInfo = {}) {
    super(`pool: ${code}${detail ? ` (${detail})` : ''}`)
    this.name = 'PoolUnavailableError'
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
    this.poolReason = info.reason ?? null
    this.accountId = info.accountId ?? null
    this.waitedSeconds = info.waitedSeconds ?? null
    // The base text ("1001tracklists unreachable (pool: timeout)") read like a
    // site outage when the pool was only busy (2026-10-07): say what happened.
    this.message = describePoolFault(code, detail, info)
  }
}

/** One short line for a pool fault: the run's lastError, the toast, the logs. */
export function describePoolFault(code: PoolFaultCode, detail?: string, info: PoolFaultInfo = {}): string {
  const acct = info.accountId ?? 'an account'
  const w = info.waitedSeconds
  const after = w != null ? ` after ${w} s` : ''
  const d = detail ? ` (${detail})` : ''
  switch (code) {
    case 'timeout':
      switch (info.reason) {
        case 'queued':
          return w != null ? `pool busy: waited ${w} s for a free browser (other fetches were running)` : 'pool busy: no free browser (other fetches were running)'
        case 'running':
          return `pool slow: ${acct}'s page load had not finished${after}`
        case 'browser':
          return `page load stalled on ${acct} (tlpool stopped it)`
        case 'net_error':
          return `page load failed on ${acct} (network error in the pool browser)`
        case 'internal':
          return 'pool timeout: tlpool internal error'
        default:
          return w != null ? `pool timeout: no page within ${w} s (pool busy or a page load stalled)` : 'pool timeout: no page in time (pool busy or a page load stalled)'
      }
    case 'unreachable':
      return `pool unreachable: tlpool or its tunnel did not answer${d}`
    case 'not_configured':
      return `pool not configured${d}`
    case 'unauthorized':
      return `pool refused our token${d}`
    case 'bad_response':
      return `pool gave an unreadable answer${d}`
    case 'no_healthy_account':
      return 'pool: no healthy account free for this fetch'
    case 'blocked':
      return 'pool: account blocked by 1001tracklists'
    default:
      return `pool: ${code}${d}`
  }
}

export function poolErrorFor(code: string, retryAfterSeconds: number | null, info: PoolFaultInfo = {}): PoolPausedError | PoolUnavailableError {
  const known = ['budget_exhausted', 'challenge_pending', 'no_healthy_account', 'blocked', 'timeout'].includes(code)
  const c = (known ? code : 'bad_response') as PoolFaultCode
  return PAUSE_CODES.has(c) ? new PoolPausedError(c, retryAfterSeconds) : new PoolUnavailableError(c, known ? undefined : `unknown error ${code.slice(0, 40)}`, retryAfterSeconds, info)
}

/** The tlpool code behind an error, or null when it did not come from the pool. */
export function poolCodeOf(e: unknown): PoolFaultCode | null {
  return e instanceof PoolPausedError || e instanceof PoolUnavailableError ? e.code : null
}

/**
 * Refusals about the one account tlpool picked, or about this one request
 * (every account excluded, all busy), not about the whole pool: another item
 * may well be served right away.
 */
export const ITEM_SCOPED_POOL_CODES: ReadonlySet<PoolFaultCode> = new Set(['no_healthy_account', 'timeout'])

function clampWait(priority: PoolPriority, maxWaitSeconds: number | undefined): number {
  const cap = priority === 'phone' ? PHONE_MAX_WAIT_SECONDS : POOL_MAX_WAIT_SECONDS
  const want = maxWaitSeconds ?? (priority === 'phone' ? PHONE_MAX_WAIT_SECONDS : DEFAULT_MAX_WAIT_SECONDS)
  return Math.max(1, Math.min(cap, Math.floor(want)))
}

async function poolCall(cfg: PoolConfig, path: string, init: { method: string; body?: unknown; timeoutMs: number }): Promise<Response> {
  const f = cfg.fetchImpl ?? fetch
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error(`pool ${path} timed out after ${init.timeoutMs}ms`)), init.timeoutMs)
  try {
    return await f(`${cfg.url}${path}`, {
      method: init.method,
      headers: { Authorization: `Bearer ${cfg.token}`, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), Accept: 'application/json' },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: ac.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One page through the pool. Resolves with the page (whatever HTTP status the
 * site answered — the caller judges 404s and error pages); throws
 * PoolPausedError / PoolUnavailableError when the pool will not or cannot.
 * With `queueSeconds` it keeps asking while tlpool says queued / running (see
 * the module doc); the final error says how long it waited and why.
 */
export async function poolFetch(cfg: PoolConfig | null, req: PoolFetchRequest, log?: Logger): Promise<PoolFetchOk> {
  if (!cfg) throw new PoolUnavailableError('not_configured', 'TLPOOL_URL / TLPOOL_TOKEN unset')
  const queueSeconds = req.priority === 'phone' ? 0 : Math.max(0, Math.min(POOL_MAX_QUEUE_SECONDS, Math.floor(req.queueSeconds ?? 0)))
  // Identical on every re-POST but maxWaitSeconds: that is what lets tlpool attach it to its job.
  const body: Record<string, unknown> = { url: req.url, kind: req.kind, priority: req.priority }
  if (req.excludeAccounts?.length) body.excludeAccounts = req.excludeAccounts
  if (req.method && req.method !== 'GET') body.method = req.method
  if (req.form) body.form = req.form
  if (req.headers && Object.keys(req.headers).length) body.headers = req.headers
  if (queueSeconds > 0) body.queueSeconds = queueSeconds
  const start = Date.now()
  if (queueSeconds <= 0) return poolPost(cfg, req, body, clampWait(req.priority, req.maxWaitSeconds), start, log)
  const until = start + queueSeconds * 1000
  // Tripwire: each POST normally holds up to 90 s; a tlpool answering
  // "queued" at once must not spin through the subrequest limit.
  const maxPosts = Math.ceil(queueSeconds / 30) + 2
  for (let post = 1; ; post++) {
    const remaining = Math.floor((until - Date.now()) / 1000)
    try {
      return await poolPost(cfg, req, body, Math.max(1, Math.min(POOL_MAX_WAIT_SECONDS, remaining)), start, log)
    } catch (e) {
      const waiting = e instanceof PoolUnavailableError && e.code === 'timeout' && (e.poolReason === 'queued' || e.poolReason === 'running')
      if (!waiting || until - Date.now() < 1000 || post >= maxPosts) throw e
      log?.info('pool.fetch.still_waiting', { url: req.url, kind: req.kind, priority: req.priority, reason: e.poolReason, accountId: e.accountId, waitedSeconds: e.waitedSeconds, queueSeconds, post })
    }
  }
}

/** One POST /fetch. A refusal carries tlpool's reason and the seconds since `start` (the request's first POST). */
async function poolPost(cfg: PoolConfig, req: PoolFetchRequest, base: Record<string, unknown>, maxWaitSeconds: number, start: number, log?: Logger): Promise<PoolFetchOk> {
  const body = { ...base, maxWaitSeconds }
  if (log) log.counters.poolCalls++
  const t0 = Date.now()
  log?.info('pool.fetch.start', { url: req.url, kind: req.kind, priority: req.priority, maxWaitSeconds, queueSeconds: base.queueSeconds ?? 0, excludeAccounts: req.excludeAccounts ?? [] })
  let res: Response
  try {
    res = await poolCall(cfg, '/fetch', { method: 'POST', body, timeoutMs: maxWaitSeconds * 1000 + CLIENT_SLACK_MS })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log?.warn('pool.fetch.unreachable', { url: req.url, kind: req.kind, priority: req.priority, ms: Date.now() - t0, error: msg.slice(0, 200) })
    throw new PoolUnavailableError('unreachable', msg.slice(0, 160))
  }
  const text = await res.text()
  let json: Record<string, unknown> | null = null
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    json = null
  }
  if (res.status === 401 || res.status === 403) {
    log?.error('pool.fetch.unauthorized', { url: req.url, status: res.status })
    throw new PoolUnavailableError('unauthorized', `pool answered ${res.status}`)
  }
  // tlpool answers every contract error as HTTP 200 with an `error` field
  // (never 502/504, which Cloudflare would rewrite): the body decides, not the status.
  if (json && typeof json.error === 'string') {
    const retry = typeof json.retryAfterSeconds === 'number' && Number.isFinite(json.retryAfterSeconds) ? json.retryAfterSeconds : null
    const reason = typeof json.reason === 'string' ? json.reason.slice(0, 40) : null
    const accountId = typeof json.accountId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(json.accountId) ? json.accountId : null
    const queued = typeof json.queuedSeconds === 'number' && Number.isFinite(json.queuedSeconds) ? json.queuedSeconds : 0
    const waitedSeconds = Math.max(Math.round((Date.now() - start) / 1000), Math.round(queued))
    const err = poolErrorFor(json.error, retry, { reason, accountId, waitedSeconds })
    log?.warn('pool.fetch.refused', { url: req.url, kind: req.kind, priority: req.priority, error: err.code, reason, accountId, waitedSeconds, httpStatus: res.status, retryAfterSeconds: retry, ms: Date.now() - t0, message: err.message })
    throw err
  }
  if (!res.ok || !json || typeof json.html !== 'string' || typeof json.status !== 'number') {
    log?.error('pool.fetch.bad_response', { url: req.url, httpStatus: res.status, body: text.slice(0, 200), ms: Date.now() - t0 })
    throw new PoolUnavailableError('bad_response', `pool answered ${res.status}`)
  }
  const out: PoolFetchOk = {
    status: json.status,
    finalUrl: typeof json.finalUrl === 'string' ? json.finalUrl : req.url,
    html: json.html,
    accountId: typeof json.accountId === 'string' ? json.accountId : 'unknown',
    exitLabel: typeof json.exitLabel === 'string' ? json.exitLabel : 'unknown',
    fetchedAt: typeof json.fetchedAt === 'string' ? json.fetchedAt : new Date().toISOString(),
    bytes: typeof json.bytes === 'number' ? json.bytes : json.html.length,
  }
  log?.info('pool.fetch.ok', { url: req.url, kind: req.kind, priority: req.priority, status: out.status, accountId: out.accountId, exitLabel: out.exitLabel, bytes: out.bytes, ms: Date.now() - t0, waitedSeconds: Math.round((Date.now() - start) / 1000) })
  return out
}

/**
 * How much of the non-passive pool rests right now, from tlpool's /status:
 * `resting` of `total` accounts that are warming, active or resting (new,
 * failed and retired ones do not count, nor scheduled creations, which
 * /status lists with state `queued`). null when tlpool cannot say.
 * Never throws.
 */
export async function poolRestingShare(cfg: PoolConfig | null, log?: Logger): Promise<{ resting: number; total: number } | null> {
  if (!cfg) return null
  try {
    const res = await poolCall(cfg, '/status', { method: 'GET', timeoutMs: 10_000 })
    const body = (await res.json().catch(() => null)) as { accounts?: unknown } | null
    if (!res.ok || !body || !Array.isArray(body.accounts)) return null
    let resting = 0
    let total = 0
    for (const a of body.accounts as Array<{ state?: unknown; passive?: unknown }>) {
      if (a?.passive === true || (a?.state !== 'warming' && a?.state !== 'active' && a?.state !== 'resting')) continue
      total++
      if (a.state === 'resting') resting++
    }
    return { resting, total }
  } catch (e) {
    log?.warn('pool.status_failed', { error: e instanceof Error ? e.message : String(e) })
    return null
  }
}

/**
 * Report an account as possibly flagged (a decoy page, or a verification pair
 * that disagreed): tlpool rests it and retests it with a known set (decision
 * 14). Best-effort — never throws. Callers go through verification.ts's
 * reportAccount, which applies the pool settings' `reports` limits first.
 */
export async function poolRetestAccount(cfg: PoolConfig | null, accountId: string, reason: string, log?: Logger): Promise<boolean> {
  if (!cfg || !/^[A-Za-z0-9_-]{1,64}$/.test(accountId)) return false
  try {
    const res = await poolCall(cfg, `/accounts/${encodeURIComponent(accountId)}/retest`, { method: 'POST', body: { reason: reason.slice(0, 200) }, timeoutMs: 10_000 })
    log?.warn('pool.retest_requested', { accountId, reason, status: res.status })
    return res.ok
  } catch (e) {
    log?.warn('pool.retest_failed', { accountId, reason, error: e instanceof Error ? e.message : String(e) })
    return false
  }
}
