/**
 * BrightData Web Unlocker client.
 *
 * Mirrors the Python `brightdata_fetch` we use elsewhere: POST to
 * /request with {zone, url, format:"json"}, get back {status_code, headers, body}.
 * One auto-retry on the documented retryable error codes; 407 (account
 * suspended) and 429 (rate limit) bubble up so the caller can flag them.
 */

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

export async function fetchViaUnlocker(
  url: string,
  apiKey: string,
  zone = DEFAULT_ZONE,
  retriesLeft = MAX_RETRIES,
): Promise<UnlockerResult> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ zone, url, format: 'json' }),
  })
  if (!res.ok) {
    throw new Error(`unlocker transport ${res.status}: ${await res.text()}`)
  }
  const json = (await res.json()) as UnlockerResponse
  const status = json.status_code ?? 0
  const headers = json.headers ?? {}
  const errorCode = headers['x-brd-error-code'] ?? null
  const errorMessage = headers['x-brd-error'] ?? null

  if (status === 407) {
    throw new Error('unlocker account suspended (407) — top up Bright Data balance')
  }

  if (status !== 200 && status !== 404) {
    if (errorCode && RETRYABLE_ERROR_CODES.has(errorCode) && retriesLeft > 0) {
      return fetchViaUnlocker(url, apiKey, zone, retriesLeft - 1)
    }
    return {
      status,
      html: '',
      redirectedUrl: '',
      errorCode,
      errorMessage,
    }
  }

  return {
    status,
    html: json.body ?? '',
    redirectedUrl: headers['x-unblocker-redirected-to'] ?? '',
    errorCode: null,
    errorMessage: null,
  }
}
