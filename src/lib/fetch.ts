/**
 * fetch wrapper that aborts after `timeoutMs` so a stuck connection can't
 * stall the whole Worker invocation. The original use case was a 1001tl
 * AJAX endpoint that occasionally responds with CF-edge 522s after ~19s,
 * blocking the entire request — fail fast and let the caller fall back.
 */
export async function fetchWithTimeout(input: RequestInfo, init: RequestInit & { timeoutMs: number }): Promise<Response> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error(`fetch timed out after ${init.timeoutMs}ms`)), init.timeoutMs)
  try {
    return await fetch(input, { ...init, signal: ac.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** Legacy: the direct route kept a cookie jar here. Sessions live in tlpool's browsers now; always `{ cookie: '' }`. */
export type ChallengeState = { cookie: string }

/**
 * 1001tracklists rate-limits per IP. When tripped, expensive endpoints
 * (search/result.php, /tracklist/...) return a 200 page whose body is
 * actually a "Fill out the captcha to unblock your IP" form posting to
 * /info/unblock_ip.html. Without this detection the parser sees zero
 * tracklist rows and the route silently returns no_tracklist — a
 * misleading status. Detect and surface as a typed error so the route
 * can return a real upstream_error.
 */
export class IPBlockedError extends Error {
  readonly clientIp: string | null
  constructor(clientIp: string | null) {
    super(clientIp ? `1001tracklists rate-limited IP ${clientIp}` : '1001tracklists rate-limited IP')
    this.name = 'IPBlockedError'
    this.clientIp = clientIp
  }
}

const IP_BLOCK_FORM_RE = /action="\/info\/unblock_ip\.html"/
const IP_BLOCK_IP_RE = /Your IP is ((?:\d{1,3}\.){3}\d{1,3})/

export function isIPBlocked(html: string): boolean {
  return IP_BLOCK_FORM_RE.test(html)
}

export function extractIPBlockedAddress(html: string): string | null {
  const m = html.match(IP_BLOCK_IP_RE)
  return m ? m[1]! : null
}

/**
 * Third bot gate: 1001tracklists' Cloudflare Turnstile pre-render shell. The
 * response is a 200 carrying just the page chrome (header, search box, footer
 * scripts) with `tlpItem` rows deferred until JS clears Turnstile. We see this
 * when BrightData's exit IP doesn't have a fresh CF clearance cookie for the
 * tracklist path. Distinct from IP-block (which has an unblock_ip form) and
 * the JS interstitial (which has a chop() token + POST-back form). Detect on
 * the absence of any track structure together with CF/Turnstile markers in
 * the body — empty real tracklists are vanishingly rare and won't have those.
 */
export class CloudflareChallengeError extends Error {
  constructor(message?: string) {
    super(message ?? '1001tracklists served a Cloudflare challenge page (no tracklist body rendered)')
    this.name = 'CloudflareChallengeError'
  }
}

const TURNSTILE_RE = /turnstile-container|cf-turnstile|cf-mitigated|challenge-platform|sitekey/

export function looksLikeCfShell(html: string): boolean {
  // Strong signal: page mentions CF/Turnstile AND has zero track structure.
  // We don't gate on size — some shells are 5KB, others 60KB depending on
  // how much chrome 1001tl includes. The absence of tlpItem is what matters.
  if (!TURNSTILE_RE.test(html)) return false
  if (html.includes('class="tlpItem"') || html.includes(' tlpItem ')) return false
  if (/cueValuesEntry\.seconds\s*=/.test(html)) return false
  return true
}
