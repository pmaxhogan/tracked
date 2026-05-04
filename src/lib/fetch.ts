const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

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

const COMMON_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'identity',
}

export type ChallengeState = { cookie: string }

/**
 * Java String.hashCode (cf. `String.prototype.chop` shipped by 1001tracklists).
 * 32-bit signed, returns the sum of `((h << 5) - h) + charCode` over each char.
 */
export function chop(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0
  }
  return h
}

const TOKEN_RE = /var ([a-zA-Z]+)='([a-z0-9]+)';\s*<\/script>/
const TS_RE = /i\.value=(\d{8,12});/
const FORM_ACTION_RE = /<form action="([^"]+)" method="POST"/

export type ChallengeFields = {
  bChk: number
  ts: string
  action: string
}

export function extractChallenge(html: string): ChallengeFields | null {
  const tokenMatch = html.match(TOKEN_RE)
  const tsMatch = html.match(TS_RE)
  const actionMatch = html.match(FORM_ACTION_RE)
  if (!tokenMatch || !tsMatch || !actionMatch) return null
  return {
    bChk: chop(tokenMatch[2]!),
    ts: tsMatch[1]!,
    action: actionMatch[1]!,
  }
}

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

/**
 * 1001tracklists serves a JS interstitial on first contact: a "please wait"
 * page with a token var the browser is meant to hash and POST back. We do
 * the same thing here. After solving, the response sets a session cookie
 * which subsequent calls reuse.
 */
export async function fetchHtml(url: string, state?: ChallengeState): Promise<{ html: string; state: ChallengeState }> {
  const cookieHeader: Record<string, string> = state?.cookie ? { Cookie: state.cookie } : {}
  const res = await fetch(url, { headers: { ...COMMON_HEADERS, ...cookieHeader } })
  const setCookie = res.headers.get('set-cookie') ?? ''
  let cookie = mergeCookies(state?.cookie, setCookie)
  const html = await res.text()

  if (isIPBlocked(html)) throw new IPBlockedError(extractIPBlockedAddress(html))

  const challenge = extractChallenge(html)
  if (!challenge) return { html, state: { cookie } }

  const challengeUrl = new URL(challenge.action, url).toString()
  const body = new URLSearchParams({
    captcha: '1',
    ts: challenge.ts,
    bChk: String(challenge.bChk),
  })
  const res2 = await fetch(challengeUrl, {
    method: 'POST',
    headers: {
      ...COMMON_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: url,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body,
  })
  cookie = mergeCookies(cookie, res2.headers.get('set-cookie') ?? '')
  const html2 = await res2.text()
  return { html: html2, state: { cookie } }
}

export async function postForm(
  url: string,
  body: Record<string, string>,
  state?: ChallengeState,
): Promise<{ html: string; state: ChallengeState }> {
  const cookieHeader: Record<string, string> = state?.cookie ? { Cookie: state.cookie } : {}
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...COMMON_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...cookieHeader,
    },
    body: new URLSearchParams(body),
  })
  const cookie = mergeCookies(state?.cookie, res.headers.get('set-cookie') ?? '')
  const html = await res.text()

  if (isIPBlocked(html)) throw new IPBlockedError(extractIPBlockedAddress(html))

  const challenge = extractChallenge(html)
  if (!challenge) return { html, state: { cookie } }

  const challengeUrl = new URL(challenge.action, url).toString()
  const challengeBody = new URLSearchParams({
    ...body,
    captcha: '1',
    ts: challenge.ts,
    bChk: String(challenge.bChk),
  })
  const res2 = await fetch(challengeUrl, {
    method: 'POST',
    headers: {
      ...COMMON_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: url,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: challengeBody,
  })
  const cookie2 = mergeCookies(cookie, res2.headers.get('set-cookie') ?? '')
  const html2 = await res2.text()
  return { html: html2, state: { cookie: cookie2 } }
}

function mergeCookies(existing: string | undefined, setCookie: string): string {
  const jar = new Map<string, string>()
  if (existing) {
    for (const pair of existing.split('; ')) {
      const [k, v] = splitOnce(pair, '=')
      if (k) jar.set(k, v ?? '')
    }
  }
  if (setCookie) {
    for (const c of splitSetCookie(setCookie)) {
      const first = c.split(';')[0]?.trim() ?? ''
      const [k, v] = splitOnce(first, '=')
      if (k) jar.set(k, v ?? '')
    }
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

function splitOnce(s: string, sep: string): [string, string | undefined] {
  const idx = s.indexOf(sep)
  if (idx < 0) return [s, undefined]
  return [s.slice(0, idx), s.slice(idx + sep.length)]
}

function splitSetCookie(header: string): string[] {
  const out: string[] = []
  let depth = 0
  let buf = ''
  for (let i = 0; i < header.length; i++) {
    const c = header[i]!
    if (c === ',' && depth === 0 && !looksLikeDateComma(header, i)) {
      out.push(buf.trim())
      buf = ''
    } else {
      buf += c
    }
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

function looksLikeDateComma(s: string, i: number): boolean {
  return /^,\s\w{3},/.test(s.slice(i, i + 6))
}
