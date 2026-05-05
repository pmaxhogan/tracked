/**
 * BrightData Web Unlocker client.
 *
 * Mirrors the Python `brightdata_fetch` we use elsewhere: POST to
 * /request with {zone, url, format:"json"}, get back {status_code, headers, body}.
 * One auto-retry on the documented retryable error codes; 407 (account
 * suspended) and 429 (rate limit) bubble up so the caller can flag them.
 */

import type { Logger } from './log'

const API_URL = 'https://api.brightdata.com/request'

const DEFAULT_ZONE = 'prism'

const RETRYABLE_ERROR_CODES = new Set([
  'domcontentloaded_event_timeout',
  'navigation_timeout',
  'resolve_failed_akamai_interstitial',
  'reject_block',
  'expect_element',
  'timeout',
  'net_err_closed',
  'net_err_cert_authority_invalid',
  'no_free_workers',
])

const MAX_RETRIES = 1

type UnlockerResponse = {
  status_code: number
  headers?: Record<string, string>
  body?: string
}

export type UnlockerResult = {
  status: number
  html: string
  redirectedUrl: string
  errorCode: string | null
  errorMessage: string | null
}

export type FetchViaUnlockerOpts = {
  zone?: string
  retriesLeft?: number
  /**
   * BrightData "manual expect" — pass a CSS selector and the Unlocker will
   * keep rendering JS until the selector is in the DOM (or its internal
   * timeout fires) before returning. Maps to the `x-unblock-expect` header
   * documented under Web Unlocker > Manual 'expect' elements. Use this for
   * pages whose content lands after a CF Turnstile clearance pass — without
   * it the Unlocker can return an unrendered shell when our exit IP didn't
   * have warm clearance for that URL. `expect_element` is in the retryable
   * error set, so a miss naturally rotates IP and tries again.
   */
  expectElement?: string
}

export async function fetchViaUnlocker(
  url: string,
  apiKey: string,
  log?: Logger,
  opts: FetchViaUnlockerOpts = {},
): Promise<UnlockerResult> {
  const zone = opts.zone ?? DEFAULT_ZONE
  const retriesLeft = opts.retriesLeft ?? MAX_RETRIES
  const expectElement = opts.expectElement

  const start = Date.now()
  if (log) log.counters.brightdataCalls++
  log?.info('unlocker.start', { url, zone, retriesLeft, expectElement: expectElement ?? null })

  let res: Response
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }
    if (expectElement) {
      headers['x-unblock-expect'] = JSON.stringify({ element: expectElement })
    }
    res = await fetch(API_URL, {
      method: 'POST',
      headers,
      // country=us pins to the residential IP pool where 1001tracklists has
      // the warmest Cloudflare clearance cache — BrightData's docs say
      // Unlocker handles CF Turnstile automatically, but per-URL clearance
      // varies by exit IP and we kept landing on cold ones for newer
      // tracklists. Geo-pinning makes the rotation pull from the country
      // most users hit 1001tl from, so the cookies are likeliest to exist.
      body: JSON.stringify({ zone, url, format: 'json', country: 'us' }),
    })
  } catch (e) {
    log?.error('unlocker.transport_throw', { url, ms: Date.now() - start, error: e instanceof Error ? e.message : String(e) })
    throw e
  }

  if (!res.ok) {
    const text = await res.text()
    log?.error('unlocker.transport_non_ok', { url, transportStatus: res.status, body: text.slice(0, 1000), ms: Date.now() - start })
    throw new Error(`unlocker transport ${res.status}: ${text}`)
  }
  const json = (await res.json()) as UnlockerResponse
  const status = json.status_code ?? 0
  const headers = json.headers ?? {}
  const errorCode = headers['x-brd-error-code'] ?? null
  const errorMessage = headers['x-brd-error'] ?? null
  const htmlBytes = (json.body ?? '').length
  const ms = Date.now() - start

  if (status === 407) {
    log?.error('unlocker.account_suspended', { url, status, errorCode, errorMessage, ms })
    throw new Error('unlocker account suspended (407) — top up Bright Data balance')
  }

  // 2xx ↔ success (1001tl's tracklist page often comes back as 206 due to
  // chunked HTTP/1.1). 404 = legitimate "not found" → caller decides.
  // Anything else is an upstream/proxy issue.
  const ok = (status >= 200 && status < 300) || status === 404
  if (!ok) {
    if (errorCode && RETRYABLE_ERROR_CODES.has(errorCode) && retriesLeft > 0) {
      log?.warn('unlocker.retrying', { url, status, errorCode, errorMessage, retriesLeft, ms })
      return fetchViaUnlocker(url, apiKey, log, { zone, retriesLeft: retriesLeft - 1, expectElement })
    }
    log?.error('unlocker.failed', { url, status, errorCode, errorMessage, htmlBytes, ms })
    return { status, html: '', redirectedUrl: '', errorCode, errorMessage }
  }

  log?.info('unlocker.ok', { url, status, htmlBytes, redirectedUrl: headers['x-unblocker-redirected-to'] ?? '', ms })
  return {
    status,
    html: json.body ?? '',
    redirectedUrl: headers['x-unblocker-redirected-to'] ?? '',
    errorCode: null,
    errorMessage: null,
  }
}
