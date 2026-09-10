/**
 * The one 1001tracklists fetch cascade every caller goes through.
 *
 *   1. Worker-side pause check — if every forwarder route was blocked within
 *      the last hour (`ban:pause`), the forwarder is not touched at all.
 *   2. Home forwarder (residential IP, then its tailnet pool; see
 *      scripts/nas-fetch-proxy.mjs). Its X-Proxy-* report is fed to
 *      lib/ban-state.ts, which owns the banner/push/pause state.
 *   3. BrightData Web Unlocker, within a daily budget (default 333 calls).
 *   4. Direct from the Worker's own egress — skipped while paused, because the
 *      pause means "stop hitting 1001tracklists".
 *
 * Before 2026-09-10 there were two copies of this cascade (`fetchTracklist`
 * and `fetch1001Html`) with different block handling, and search went
 * straight from the Worker. Now `fetchTracklist`, `fetch1001Html`,
 * `searchByYouTubeUrl` and `searchByTitle` are thin wrappers over `fetch1001`.
 *
 * Block signals never masquerade as generic failures here: a blocked route
 * either falls through to the next one or surfaces as a typed error
 * (`UpstreamPausedError` when we deliberately stopped, `IPBlockedError` when
 * the last route itself was blocked) so the sync loop can stop the run instead
 * of charging every set a failure and re-hitting the banned IP.
 */

import { fetchHtml, postForm, isIPBlocked, extractIPBlockedAddress, IPBlockedError, looksLikeCfShell, CloudflareChallengeError, type ChallengeState } from './fetch'
import { fetchViaHomeProxy, type HomeProxyResult } from './homeProxy'
import { fetchViaUnlocker } from './unlocker'
import { isPaused, noteProxyResult, tryConsumeBrightdata, type Pause } from './ban-state'
import type { Logger } from './log'
import type { Env } from '../types'

export type Via = 'home-proxy' | 'home-proxy-pool' | 'unlocker' | 'direct'

/**
 * Thrown when we stopped on purpose: every forwarder route is in block
 * cooldown and BrightData is unavailable/over budget. Callers should stop the
 * whole batch, not just this item — the next item would be paused too.
 */
export class UpstreamPausedError extends Error {
  readonly until: string | null
  readonly reason: string
  constructor(reason: string, until: string | null) {
    super(until ? `1001tracklists fetching paused (${reason}) until ${until}` : `1001tracklists fetching paused (${reason})`)
    this.name = 'UpstreamPausedError'
    this.until = until
    this.reason = reason
  }
}

export function isStopTheBatchError(e: unknown): boolean {
  return e instanceof UpstreamPausedError || e instanceof IPBlockedError
}

export type Fetch1001Opts = {
  brightdataApiKey?: string
  homeProxyUrl?: string
  homeProxyToken?: string
  /**
   * CACHE KV. Required for the ban state (pause, episodes, BrightData budget)
   * to work; without it the cascade still runs but never remembers a block.
   */
  cacheKv?: KVNamespace
  /** SUBS KV — only needed so a ban episode can push to the stored subscriptions. */
  subsKv?: KVNamespace
  brightdataDailyCap?: string
  vapid?: { publicKey?: string; privateKey?: string; subject?: string }
  state?: ChallengeState
  log?: Logger
  method?: 'GET' | 'POST'
  /** Form fields for POST (encoded as application/x-www-form-urlencoded). */
  form?: Record<string, string>
  /** Extra request headers forwarded to upstream (Referer, X-Requested-With…). */
  headers?: Record<string, string>
  /**
   * Usable-body predicate. A response that is not blocked/gated but fails this
   * (e.g. a tracklist page that parses to zero tracks) falls through to the
   * next route on the forwarder hop; BrightData/direct results are returned
   * regardless so the caller can log diagnostics.
   */
  accept?: (html: string) => boolean
  /** BrightData attempts when it returns a CF shell (its exit IP rotates). */
  unlockerAttempts?: number
  /** Forwarder route override for tests / the admin re-probe. */
  forceRoute?: 'direct' | 'pool'
  /** Set false to never fall back to the Worker's own egress (search must, tracklist pages may). */
  allowDirect?: boolean
}

/**
 * Everything the cascade needs from the environment: routes, the KV that
 * remembers blocks and the BrightData budget, and the push identity so a
 * fresh ban can alert the admin. Every caller builds its options from this.
 */
export function fetchOptsFromEnv(env: Env, log?: Logger): Fetch1001Opts {
  return {
    brightdataApiKey: env.BRIGHTDATA_API_KEY,
    homeProxyUrl: env.HOME_PROXY_URL,
    homeProxyToken: env.HOME_PROXY_TOKEN,
    cacheKv: env.CACHE,
    subsKv: env.SUBS,
    brightdataDailyCap: env.BRIGHTDATA_DAILY_CAP,
    vapid: { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT },
    log,
  }
}

export type Fetch1001Result = {
  html: string
  via: Via
  state: ChallengeState
  proxy: HomeProxyResult | null
  pause: Pause | null
}

function banEnv(opts: Fetch1001Opts) {
  if (!opts.cacheKv) return null
  return {
    CACHE: opts.cacheKv,
    SUBS: opts.subsKv ?? opts.cacheKv,
    BRIGHTDATA_DAILY_CAP: opts.brightdataDailyCap,
    VAPID_PUBLIC_KEY: opts.vapid?.publicKey,
    VAPID_PRIVATE_KEY: opts.vapid?.privateKey,
    VAPID_SUBJECT: opts.vapid?.subject,
  }
}

export async function fetch1001(url: string, opts: Fetch1001Opts = {}): Promise<Fetch1001Result> {
  const log = opts.log
  const method = opts.method ?? 'GET'
  const body = method === 'POST' ? new URLSearchParams(opts.form ?? {}).toString() : undefined
  const accept = opts.accept ?? (() => true)
  const haveHomeProxy = !!(opts.homeProxyUrl && opts.homeProxyToken)
  const env = banEnv(opts)
  const state = opts.state ?? { cookie: '' }

  const pause = env ? await isPaused(env) : null
  if (pause) log?.warn('fetch1001.paused', { url, until: pause.until, reason: pause.reason })
  log?.info('fetch1001.start', { url, method, viaHomeProxy: haveHomeProxy && !pause, viaUnlocker: !!opts.brightdataApiKey, forceRoute: opts.forceRoute ?? null })

  let proxy: HomeProxyResult | null = null
  let blockedIp: string | null = null

  // ── 1. Home forwarder ────────────────────────────────────────────────────
  if (haveHomeProxy && !pause) {
    proxy = await fetchViaHomeProxy(url, opts.homeProxyUrl!, opts.homeProxyToken!, log, {
      method,
      body,
      headers: opts.headers,
      forceRoute: opts.forceRoute,
    })
    if (env) await noteProxyResult(env, proxy, log)
    if (proxy.kind === 'ok') {
      if (isIPBlocked(proxy.html)) {
        // Belt and braces: the forwarder classifies blocks itself, so this only
        // fires if 1001tl ships a new block-page shape. Treat as blocked.
        blockedIp = extractIPBlockedAddress(proxy.html)
        log?.error('fetch1001.homeproxy_block_page_passed_through', { url, route: proxy.route, egress: proxy.egress, blockedIp })
      } else if (looksLikeCfShell(proxy.html)) {
        log?.warn('fetch1001.homeproxy_cf_shell_falling_back', { url, route: proxy.route, egress: proxy.egress, htmlBytes: proxy.html.length })
      } else if (!accept(proxy.html)) {
        log?.warn('fetch1001.homeproxy_unusable_body_falling_back', { url, route: proxy.route, egress: proxy.egress, htmlBytes: proxy.html.length })
      } else {
        return { html: proxy.html, via: proxy.route === 'pool' ? 'home-proxy-pool' : 'home-proxy', state, proxy, pause: null }
      }
    } else if (proxy.kind === 'all_blocked') {
      blockedIp = extractIPBlockedAddress(proxy.html) ?? proxy.directBlocked?.ip ?? null
      log?.error('fetch1001.homeproxy_all_routes_blocked', { url, attempts: proxy.attempts, blockedIp, fallback: opts.brightdataApiKey ? 'brightdata' : 'pause' })
    } else {
      log?.warn('fetch1001.homeproxy_unusable_falling_back', { url, kind: proxy.kind, status: proxy.status, errorMessage: proxy.errorMessage, fallback: opts.brightdataApiKey ? 'brightdata' : 'direct' })
    }
  }

  // Are we here because of a block (as opposed to a transport blip / parse miss)?
  const blockedPath = !!pause || proxy?.kind === 'all_blocked' || blockedIp !== null

  // ── 2. BrightData Web Unlocker, budgeted ────────────────────────────────
  if (opts.brightdataApiKey) {
    const budget = env ? await tryConsumeBrightdata(env, log) : { ok: true, usage: null }
    if (!budget.ok) {
      log?.warn('fetch1001.brightdata_over_budget', { url, usage: budget.usage })
      if (blockedPath) throw new UpstreamPausedError('every route blocked and BrightData budget spent', pause?.until ?? null)
    } else {
      const attempts = Math.max(1, opts.unlockerAttempts ?? 1)
      let lastShellBytes = 0
      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (attempt > 1 && env) {
          const more = await tryConsumeBrightdata(env, log)
          if (!more.ok) break
        }
        const r = await fetchViaUnlocker(url, opts.brightdataApiKey, log)
        if (!r.html) {
          const detail = r.errorCode ? `${r.errorCode}: ${r.errorMessage ?? ''}` : `status ${r.status}`
          log?.error('fetch1001.unlocker_failed', { url, status: r.status, errorCode: r.errorCode, errorMessage: r.errorMessage, attempt })
          throw new Error(`unlocker fetch failed for ${url} — ${detail}`)
        }
        if (isIPBlocked(r.html)) {
          const ip = extractIPBlockedAddress(r.html)
          log?.error('fetch1001.unlocker_ip_blocked', { url, clientIp: ip, htmlBytes: r.html.length, attempt })
          throw new IPBlockedError(ip)
        }
        if (looksLikeCfShell(r.html)) {
          lastShellBytes = r.html.length
          if (attempt < attempts) {
            log?.warn('fetch1001.unlocker_cf_shell_retry', { url, htmlBytes: r.html.length, attempt })
            continue
          }
          log?.error('fetch1001.unlocker_cf_shell', { url, htmlBytes: r.html.length, attempt, attempts })
          throw new CloudflareChallengeError(`unlocker fetched a CF shell page for ${url} after ${attempts} attempts (last ${lastShellBytes} bytes)`)
        }
        return { html: r.html, via: 'unlocker', state, proxy, pause }
      }
      throw new CloudflareChallengeError(`unlocker fetched a CF shell page for ${url} (last ${lastShellBytes} bytes)`)
    }
  }

  // ── 3. Direct from the Worker ───────────────────────────────────────────
  if (blockedPath) {
    // "Stop retrying": blocked everywhere and no paid fallback → stop the batch.
    throw new UpstreamPausedError(pause ? pause.reason : 'every forwarder route blocked', pause?.until ?? proxy?.directBlocked?.until ?? null)
  }
  if (opts.allowDirect === false) {
    throw new Error(`no usable route for ${url} (home proxy ${proxy?.kind ?? 'unconfigured'}, no BrightData)`)
  }
  if (method === 'POST') {
    const { html, state: s2 } = await postForm(url, opts.form ?? {}, state)
    return { html, via: 'direct', state: s2, proxy, pause }
  }
  const { html, state: s2 } = await fetchHtml(url, state)
  return { html, via: 'direct', state: s2, proxy, pause }
}
