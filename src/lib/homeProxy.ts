/**
 * Residential-IP fetch forwarder client.
 *
 * The Worker can't speak WireGuard, so it can't be on the user's tailnet
 * directly. Instead a tiny HTTP forwarder runs on a tailnet-connected NAS
 * (see `scripts/nas-fetch-proxy.mjs`) and is exposed publicly via cloudflared.
 * The Worker calls `${HOME_PROXY_URL}/?url=<encoded>` with a bearer; the
 * forwarder makes the actual request — from the residential IP while that is
 * healthy, otherwise through a random member of its tailnet proxy pool — and
 * returns status + body plus `X-Proxy-*` headers describing the route.
 *
 * This client keeps the body on EVERY status (the 2026-09-10 incident was a
 * 403 block page whose body was thrown away, which made the block invisible)
 * and decodes the route headers so `lib/ban-state.ts` can raise the
 * "solve the captcha" alert even while requests are succeeding via the pool.
 */

import type { Logger } from './log'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/**
 * What happened on the Worker → forwarder → upstream hop.
 *   - `ok`             upstream answered 2xx via the reported route
 *   - `upstream_error` forwarder reached upstream, which answered non-2xx (404, 5xx…)
 *   - `all_blocked`    every route the forwarder has is in block cooldown; body is the block page (503)
 *   - `proxy_error`    the forwarder itself refused/failed (401 bad token, 400, 403 host, 502 transport, 503 session)
 *   - `transport`      we never got a response from the forwarder (timeout, DNS, tunnel down)
 */
export type HomeProxyKind = 'ok' | 'upstream_error' | 'all_blocked' | 'proxy_error' | 'transport'

export type HomeProxyDirectBlocked = {
  /** ISO time the residential IP's cooldown ends (the forwarder probes direct again then). */
  until: string
  /** ISO time the block was first observed by the forwarder. */
  since: string | null
  /** Blocked IP as printed on 1001tracklists' block page, when known. */
  ip: string | null
}

export type HomeProxyResult = {
  /** HTTP status the forwarder returned (upstream status when served; 503 when all blocked; 0 on transport failure). */
  status: number
  /** Response body — kept for every status so block pages can be classified. */
  html: string
  errorMessage: string | null
  kind: HomeProxyKind
  /** Which egress served the request: `direct` (residential IP), `pool` (tailnet bucket) or `none`. */
  route: 'direct' | 'pool' | 'none' | null
  /** Forwarder's label for the egress (e.g. `direct`, `bgp1:18183`). */
  egress: string | null
  upstreamStatus: number | null
  /** Forwarder's per-route attempt trail, e.g. `direct:ip_blocked,bgp1:18183:ok`. */
  attempts: string | null
  /** Present while the forwarder has the residential IP in block cooldown. */
  directBlocked: HomeProxyDirectBlocked | null
  /** True when this very request found the residential IP working again after a block. */
  directRecovered: boolean
  /**
   * The forwarder could not reach 1001tracklists at all on the direct route
   * (its 502 with attempts `direct:error`): a network blip on the home link,
   * not an answer from 1001tl. The cascade treats it as a plain retryable
   * failure rather than paying for a BrightData fallback.
   */
  upstreamTransport: boolean
  /** The forwarder found its 1001tl session blocked, re-logged in through a pool egress and retried (x-proxy-session-reissued). */
  sessionReissued: boolean
  /** Forwarder's reading of what was blocked: 'session' (healed by re-login), 'routes', or 'account' (a fresh session was blocked too). */
  blockScope: 'session' | 'routes' | 'account' | null
  poolHealthy: number | null
  poolTotal: number | null
}

export type FetchViaHomeProxyOpts = {
  /**
   * Forwarder timeout. The forwarder may make up to 1 + MAX_POOL_ATTEMPTS
   * upstream attempts (block responses are ~200 ms each, a pool hop ~500 ms),
   * so this is looser than a single upstream call.
   */
  timeoutMs?: number
  method?: 'GET' | 'POST'
  /** Request body for POST (already encoded). */
  body?: string
  contentType?: string
  /** Extra headers to forward (the forwarder passes through Referer, Accept*, X-Requested-With, Content-Type). */
  headers?: Record<string, string>
  /** Bearer-gated override of the forwarder's route planner — tests and the admin re-probe use it. */
  forceRoute?: 'direct' | 'pool'
}

function proxyBase(proxyUrl: string): string {
  return proxyUrl.replace(/\/$/, '')
}

function authHeaders(proxyToken: string): Record<string, string> {
  return { Authorization: `Bearer ${proxyToken}` }
}

export async function fetchViaHomeProxy(
  url: string,
  proxyUrl: string,
  proxyToken: string,
  log?: Logger,
  opts: FetchViaHomeProxyOpts = {},
): Promise<HomeProxyResult> {
  const start = Date.now()
  const timeoutMs = opts.timeoutMs ?? 20000
  const method = opts.method ?? 'GET'
  if (log) log.counters.homeProxyCalls++
  log?.info('homeproxy.start', { url, method, forceRoute: opts.forceRoute ?? null })

  const fwd = `${proxyBase(proxyUrl)}/?url=${encodeURIComponent(url)}`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error(`home proxy timed out after ${timeoutMs}ms`)), timeoutMs)
  const headers: Record<string, string> = {
    ...authHeaders(proxyToken),
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'identity',
    ...(opts.headers ?? {}),
  }
  if (opts.forceRoute) headers['X-Proxy-Force-Route'] = opts.forceRoute
  if (method === 'POST') headers['Content-Type'] = opts.contentType ?? 'application/x-www-form-urlencoded'

  let res: Response
  try {
    res = await fetch(fwd, { method, headers, body: method === 'POST' ? opts.body ?? '' : undefined, signal: ac.signal })
  } catch (e) {
    clearTimeout(timer)
    const message = e instanceof Error ? e.message : String(e)
    log?.warn('homeproxy.transport_throw', { url, ms: Date.now() - start, error: message })
    return {
      status: 0,
      html: '',
      errorMessage: message,
      kind: 'transport',
      route: null,
      egress: null,
      upstreamStatus: null,
      attempts: null,
      directBlocked: null,
      directRecovered: false,
      upstreamTransport: false,
      sessionReissued: false,
      blockScope: null,
      poolHealthy: null,
      poolTotal: null,
    }
  }
  clearTimeout(timer)

  const html = await res.text()
  const ms = Date.now() - start
  const h = res.headers
  const routeRaw = h.get('x-proxy-route')
  const route: HomeProxyResult['route'] = routeRaw === 'direct' || routeRaw === 'pool' || routeRaw === 'none' ? routeRaw : null
  const blockedUntil = h.get('x-proxy-direct-blocked-until')
  const directBlocked: HomeProxyDirectBlocked | null = blockedUntil
    ? { until: blockedUntil, since: h.get('x-proxy-direct-blocked-since'), ip: h.get('x-proxy-direct-blocked-ip') }
    : null
  const num = (v: string | null) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null)
  const meta = {
    route,
    egress: h.get('x-proxy-egress'),
    upstreamStatus: num(h.get('x-proxy-upstream-status')),
    attempts: h.get('x-proxy-attempts'),
    directBlocked,
    directRecovered: h.get('x-proxy-direct-recovered') === '1',
    upstreamTransport: res.status === 502 && route === 'direct' && /(^|,)direct:error$/.test(h.get('x-proxy-attempts') ?? ''),
    sessionReissued: h.get('x-proxy-session-reissued') === '1',
    blockScope: (['session', 'routes', 'account'].includes(h.get('x-proxy-block-scope') ?? '') ? h.get('x-proxy-block-scope') : null) as HomeProxyResult['blockScope'],
    poolHealthy: num(h.get('x-proxy-pool-healthy')),
    poolTotal: num(h.get('x-proxy-pool-total')),
  }

  let kind: HomeProxyKind
  if (h.get('x-proxy-all-blocked') === '1') kind = 'all_blocked'
  else if (res.status >= 200 && res.status < 300) kind = 'ok'
  else if (route === 'direct' || route === 'pool') kind = 'upstream_error'
  else kind = 'proxy_error'

  const base = { status: res.status, html, ...meta }
  if (kind === 'ok') {
    if (meta.sessionReissued) log?.warn('homeproxy.session_reissued', { url, route, egress: meta.egress, attempts: meta.attempts })
    log?.info('homeproxy.ok', { url, status: res.status, htmlBytes: html.length, ms, route, egress: meta.egress, attempts: meta.attempts, directBlocked: directBlocked?.until ?? null, sessionReissued: meta.sessionReissued })
    return { ...base, errorMessage: null, kind }
  }
  const errorMessage =
    kind === 'all_blocked'
      ? `home proxy: every route blocked (${meta.attempts ?? 'no attempts'})`
      : `home proxy ${res.status}: ${html.slice(0, 200)}`
  log?.warn(`homeproxy.${kind}`, {
    url,
    status: res.status,
    htmlBytes: html.length,
    body: kind === 'proxy_error' ? html.slice(0, 300) : undefined,
    ms,
    route,
    egress: meta.egress,
    attempts: meta.attempts,
    directBlocked: directBlocked?.until ?? null,
    blockedIp: h.get('x-proxy-blocked-ip') ?? directBlocked?.ip ?? null,
  })
  return { ...base, errorMessage, kind }
}

export type HomeProxyStatus = {
  version?: string
  probeUrl?: string
  hasSession?: boolean
  now?: string
  cooldownMs?: number
  direct?: { blocked: boolean; blockedSince: string | null; blockedUntil: string | null; blockedIp: string | null; lastBlockAt: string | null; lastOkAt: string | null }
  pool?: Array<{ label: string; blocked: boolean; blockedUntil: string | null; okCount: number; blockedCount: number; errorCount: number; lastOkAt: string | null }>
  poolHealthy?: number
  poolTotal?: number
  counters?: Record<string, number>
}

/** GET /status on the forwarder. Throws on transport/auth failure. */
export async function fetchHomeProxyStatus(proxyUrl: string, proxyToken: string, timeoutMs = 8000): Promise<HomeProxyStatus> {
  const res = await fetch(`${proxyBase(proxyUrl)}/status`, { headers: authHeaders(proxyToken), signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`home proxy /status ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return (await res.json()) as HomeProxyStatus
}

export type HomeProxyProbe = HomeProxyStatus & {
  probe: 'ok' | 'ip_blocked' | 'gated' | 'error'
  status?: number
  error?: string
  wasBlocked?: boolean
  blockedIp?: string | null
  ms?: number
}

/**
 * POST /probe on the forwarder: one forced direct fetch so we learn right now
 * whether the residential IP is still blocked (instead of waiting for the
 * hourly in-band probe). Throws on transport/auth failure.
 */
export async function probeHomeProxy(proxyUrl: string, proxyToken: string, opts: { url?: string; timeoutMs?: number } = {}): Promise<HomeProxyProbe> {
  const q = opts.url ? `?url=${encodeURIComponent(opts.url)}` : ''
  const res = await fetch(`${proxyBase(proxyUrl)}/probe${q}`, {
    method: 'POST',
    headers: authHeaders(proxyToken),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 25000),
  })
  if (!res.ok) throw new Error(`home proxy /probe ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return (await res.json()) as HomeProxyProbe
}
