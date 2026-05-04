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
