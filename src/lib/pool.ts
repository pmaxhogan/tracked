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
 * Refusal: `{ error, retryAfterSeconds }`, mapped here to the typed errors in
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
  constructor(code: PoolFaultCode, detail?: string, retryAfterSeconds: number | null = null) {
    super(`pool: ${code}${detail ? ` (${detail})` : ''}`)
    this.name = 'PoolUnavailableError'
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export function poolErrorFor(code: string, retryAfterSeconds: number | null): PoolPausedError | PoolUnavailableError {
  const known = ['budget_exhausted', 'challenge_pending', 'no_healthy_account', 'blocked', 'timeout'].includes(code)
  const c = (known ? code : 'bad_response') as PoolFaultCode
  return PAUSE_CODES.has(c) ? new PoolPausedError(c, retryAfterSeconds) : new PoolUnavailableError(c, known ? undefined : `unknown error ${code.slice(0, 40)}`, retryAfterSeconds)
}

function clampWait(priority: PoolPriority, maxWaitSeconds: number | undefined): number {
  const cap = priority === 'phone' ? PHONE_MAX_WAIT_SECONDS : 120
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
 */
export async function poolFetch(cfg: PoolConfig | null, req: PoolFetchRequest, log?: Logger): Promise<PoolFetchOk> {
  if (!cfg) throw new PoolUnavailableError('not_configured', 'TLPOOL_URL / TLPOOL_TOKEN unset')
  const maxWaitSeconds = clampWait(req.priority, req.maxWaitSeconds)
  const body: Record<string, unknown> = { url: req.url, kind: req.kind, priority: req.priority, maxWaitSeconds }
  if (req.excludeAccounts?.length) body.excludeAccounts = req.excludeAccounts
  if (req.method && req.method !== 'GET') body.method = req.method
  if (req.form) body.form = req.form
  if (req.headers && Object.keys(req.headers).length) body.headers = req.headers
  if (log) log.counters.poolCalls++
  const start = Date.now()
  log?.info('pool.fetch.start', { url: req.url, kind: req.kind, priority: req.priority, maxWaitSeconds, excludeAccounts: req.excludeAccounts ?? [] })
  let res: Response
  try {
    res = await poolCall(cfg, '/fetch', { method: 'POST', body, timeoutMs: maxWaitSeconds * 1000 + CLIENT_SLACK_MS })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log?.warn('pool.fetch.unreachable', { url: req.url, kind: req.kind, priority: req.priority, ms: Date.now() - start, error: msg.slice(0, 200) })
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
  if (json && typeof json.error === 'string') {
    const retry = typeof json.retryAfterSeconds === 'number' && Number.isFinite(json.retryAfterSeconds) ? json.retryAfterSeconds : null
    const err = poolErrorFor(json.error, retry)
    log?.warn('pool.fetch.refused', { url: req.url, kind: req.kind, priority: req.priority, error: err.code, retryAfterSeconds: retry, ms: Date.now() - start })
    throw err
  }
  if (!res.ok || !json || typeof json.html !== 'string' || typeof json.status !== 'number') {
    log?.error('pool.fetch.bad_response', { url: req.url, httpStatus: res.status, body: text.slice(0, 200), ms: Date.now() - start })
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
  log?.info('pool.fetch.ok', { url: req.url, kind: req.kind, priority: req.priority, status: out.status, accountId: out.accountId, exitLabel: out.exitLabel, bytes: out.bytes, ms: Date.now() - start })
  return out
}

/**
 * Report an account as possibly flagged (a decoy page, or a verification pair
 * that disagreed): tlpool rests it and retests it with a known set (decision
 * 14). Best-effort — never throws.
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
