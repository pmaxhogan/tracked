/**
 * Residential-IP fetch forwarder client.
 *
 * The Worker can't speak WireGuard, so it can't be on the user's tailnet
 * directly. Instead a tiny HTTP forwarder runs on a tailnet-connected NAS
 * (see `scripts/nas-fetch-proxy.mjs`) and is exposed publicly via cloudflared.
 * The Worker calls `${HOME_PROXY_URL}/?url=<encoded>` with a bearer; the
 * forwarder makes the actual request from the residential IP and returns
 * status + body.
 *
 * The call signature mirrors the BrightData unlocker so `fetchTracklist`
 * can swap them with the same control flow (CF-shell / IP-block / parse-zero
 * fall-through to the next attempt).
 */

import type { Logger } from './log'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export type HomeProxyResult = {
  status: number
  html: string
  errorMessage: string | null
}

export type FetchViaHomeProxyOpts = {
  /** Forwarder timeout. Slightly tighter than the BrightData budget — this
   *  is the cheap path; if the residential link is degraded, fall through
   *  to BrightData rather than holding the request. */
  timeoutMs?: number
}

export async function fetchViaHomeProxy(
  url: string,
  proxyUrl: string,
  proxyToken: string,
  log?: Logger,
  opts: FetchViaHomeProxyOpts = {},
): Promise<HomeProxyResult> {
  const start = Date.now()
  const timeoutMs = opts.timeoutMs ?? 12000
  if (log) log.counters.homeProxyCalls++
  log?.info('homeproxy.start', { url })

  const fwd = `${proxyUrl.replace(/\/$/, '')}/?url=${encodeURIComponent(url)}`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error(`home proxy timed out after ${timeoutMs}ms`)), timeoutMs)
  let res: Response
  try {
    res = await fetch(fwd, {
      headers: {
        Authorization: `Bearer ${proxyToken}`,
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
      },
      signal: ac.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    const message = e instanceof Error ? e.message : String(e)
    log?.warn('homeproxy.transport_throw', { url, ms: Date.now() - start, error: message })
    return { status: 0, html: '', errorMessage: message }
  }
  clearTimeout(timer)

  const html = await res.text()
  const ms = Date.now() - start
  if (res.status < 200 || res.status >= 300) {
    log?.warn('homeproxy.non_ok', { url, status: res.status, htmlBytes: html.length, body: html.slice(0, 300), ms })
    return { status: res.status, html: '', errorMessage: `home proxy ${res.status}: ${html.slice(0, 200)}` }
  }
  log?.info('homeproxy.ok', { url, status: res.status, htmlBytes: html.length, ms })
  return { status: res.status, html, errorMessage: null }
}
