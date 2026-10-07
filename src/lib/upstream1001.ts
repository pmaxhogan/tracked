/**
 * The one 1001tracklists fetch path every caller goes through.
 *
 *   1. The master switch: while `ban:pause` (CACHE KV) is set, nothing is
 *      fetched at all — `UpstreamPausedError` before any network call.
 *   2. tlpool (lib/pool.ts), the NAS browser pool: a real browser, logged in
 *      as one of the pool's accounts behind that account's own exit. The pool
 *      owns budget, pacing and captchas; the caller only says what kind of
 *      page this is and how urgent (quest decisions 9, 11, 12).
 *
 * There is no other route. The home forwarder, the Bright Data unlocker and
 * the direct fetch from Cloudflare's egress were removed on 2026-09-29: every
 * one of them either got an account flagged or is refused by the site.
 *
 * Block signals never masquerade as generic failures: the pool's refusals and
 * a block page that slips through surface as `UpstreamPausedError` /
 * `UpstreamUnavailableError` / `IPBlockedError` so a batch stops instead of
 * charging every set a failure.
 */

import { extractIPBlockedAddress, IPBlockedError, isIPBlocked, looksLikeCfShell, type ChallengeState } from './fetch'
import { isPaused } from './ban-state'
import { poolCodeOf, poolConfigFromEnv, poolFetch, type PoolConfig, type PoolFetchOk, type PoolFetchRequest, type PoolKind, type PoolPriority } from './pool'
import { UpstreamHttpError, UpstreamPausedError, UpstreamTransportError, UpstreamUnavailableError } from './upstream-errors'
import { capturePage, type PageStoreOpts, type PageVerdict } from './page-store'
import type { Logger } from './log'
import type { Env } from '../types'

export { isStopTheBatchError, UpstreamHttpError, UpstreamPausedError, UpstreamTransportError, UpstreamUnavailableError } from './upstream-errors'

/**
 * Which route served a page. `pool` is the only live value; the others stay in
 * the union because stored run stats and audit rows written before 2026-09-29
 * carry them.
 */
export type Via = 'pool' | 'home-proxy' | 'home-proxy-pool' | 'unlocker' | 'direct'

export type Fetch1001Opts = {
  /** tlpool endpoint + bearer (`poolConfigFromEnv`). null/absent = not configured: every fetch fails with PoolUnavailableError. */
  pool?: PoolConfig | null
  /** CACHE KV, for the `ban:pause` master switch. Without it the switch is not consulted. */
  cacheKv?: KVNamespace
  log?: Logger
  /** What the page is, for tlpool's accounting. Default `set`. */
  kind?: PoolKind
  /** How urgent (decision 12). Default `phone`: everything but the scheduler is someone waiting on a response. */
  priority?: PoolPriority
  /** Accounts that must not serve this fetch (verification second fetches). */
  excludeAccounts?: string[]
  maxWaitSeconds?: number
  method?: 'GET' | 'POST'
  /** Form fields for POST (tlpool sends them application/x-www-form-urlencoded). */
  form?: Record<string, string>
  /** Extra request headers (Referer, X-Requested-With…). */
  headers?: Record<string, string>
  /** Where to keep every page returned (R2 + its daily counter). Absent = not kept. */
  pages?: Pick<PageStoreOpts, 'bucket' | 'counter'>
  /** Legacy, ignored: sessions live in tlpool's browser profiles now. */
  state?: ChallengeState
}

/**
 * Options for a caller outside the scheduler. `priority` defaults to `phone`
 * (see Fetch1001Opts); pass another where nobody is waiting.
 */
export function fetchOptsFromEnv(env: Env, log?: Logger, overrides: Partial<Fetch1001Opts> = {}): Fetch1001Opts {
  return {
    pool: poolConfigFromEnv(env),
    cacheKv: env.CACHE,
    ...(env.PAGES ? { pages: { bucket: env.PAGES, counter: env.CACHE } } : {}),
    log,
    ...overrides,
  }
}

export type Fetch1001Result = {
  html: string
  via: Via
  /** Always empty; kept so existing destructuring callers compile. */
  state: ChallengeState
  /** Opaque tlpool account id (acct-N) that served the page. */
  accountId: string
  exitLabel: string
  fetchedAt: string
}

/** Definitive upstream answers that no retry would change. */
const FINAL_UPSTREAM_STATUSES = new Set([404, 410])

export async function fetch1001(url: string, opts: Fetch1001Opts = {}): Promise<Fetch1001Result> {
  const log = opts.log
  if (opts.cacheKv) {
    const pause = await isPaused({ CACHE: opts.cacheKv })
    if (pause) {
      log?.warn('fetch1001.paused', { url, until: pause.until, reason: pause.reason })
      throw new UpstreamPausedError(pause.reason, pause.until)
    }
  }
  const kind = opts.kind ?? 'set'
  const priority = opts.priority ?? 'phone'
  const req: PoolFetchRequest = {
    url,
    kind,
    priority,
    ...(opts.excludeAccounts?.length ? { excludeAccounts: opts.excludeAccounts } : {}),
    ...(opts.maxWaitSeconds !== undefined ? { maxWaitSeconds: opts.maxWaitSeconds } : {}),
    ...(opts.method ? { method: opts.method } : {}),
    ...(opts.form ? { form: opts.form } : {}),
    ...(opts.headers ? { headers: opts.headers } : {}),
  }
  let r: PoolFetchOk
  try {
    r = await poolFetch(opts.pool ?? null, req, log)
  } catch (e) {
    // A pool timeout is usually one account's browser hanging on its page
    // load (2026-10-07: acct-34 stalled and a whole DJ sync stopped). Ask
    // once more: tlpool never hands a request to an account still busy with
    // the stalled one, so the retry lands on another account. Not for phone,
    // whose caller is waiting under the 25 s contract.
    if (poolCodeOf(e) !== 'timeout' || priority === 'phone') throw e
    log?.warn('fetch1001.pool_timeout_retry', { url, kind, priority })
    r = await poolFetch(opts.pool ?? null, req, log)
  }
  if (opts.pages) {
    // Background, never awaited: index.ts drains it into ctx.waitUntil.
    const blocked = isIPBlocked(r.html) || looksLikeCfShell(r.html)
    const verdict: { verdict: PageVerdict; detail: string } | undefined = blocked ? { verdict: 'challenge', detail: 'block page or challenge shell' } : undefined
    capturePage(
      { ...opts.pages, log },
      { url, kind, priority, status: r.status, html: r.html, accountId: r.accountId, exitLabel: r.exitLabel, fetchedAt: r.fetchedAt, verdict, variant: opts.form ? JSON.stringify(opts.form) : undefined },
    )
  }
  if (FINAL_UPSTREAM_STATUSES.has(r.status)) {
    log?.warn('fetch1001.upstream_final_status', { url, status: r.status, accountId: r.accountId })
    throw new UpstreamHttpError(r.status, url)
  }
  // A block page or a Cloudflare shell that got through the browser is the
  // route's problem (the pool should have classified it), never the URL's.
  if (isIPBlocked(r.html)) {
    const ip = extractIPBlockedAddress(r.html)
    log?.error('fetch1001.block_page_through_pool', { url, accountId: r.accountId, exitLabel: r.exitLabel })
    throw new IPBlockedError(ip)
  }
  if (looksLikeCfShell(r.html)) {
    log?.error('fetch1001.cf_shell_through_pool', { url, accountId: r.accountId, exitLabel: r.exitLabel, htmlBytes: r.html.length })
    throw new UpstreamUnavailableError(`pool served a Cloudflare challenge shell (${r.accountId})`)
  }
  if (r.status === 401 || r.status === 403 || r.status === 429) {
    // Captcha wall / refusal / rate limit: about the account, not the URL.
    log?.error('fetch1001.refused_through_pool', { url, status: r.status, accountId: r.accountId, exitLabel: r.exitLabel })
    throw new UpstreamUnavailableError(`1001tracklists answered ${r.status} to ${r.accountId}`)
  }
  if (r.status >= 400) {
    log?.warn('fetch1001.upstream_error_status', { url, status: r.status, accountId: r.accountId })
    throw new UpstreamTransportError(url, `HTTP ${r.status}`)
  }
  return { html: r.html, via: 'pool', state: { cookie: '' }, accountId: r.accountId, exitLabel: r.exitLabel, fetchedAt: r.fetchedAt }
}
