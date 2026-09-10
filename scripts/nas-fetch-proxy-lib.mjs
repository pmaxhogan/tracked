/**
 * Pure logic for the NAS fetch forwarder (`nas-fetch-proxy.mjs`): how an
 * upstream response is classified, and how requests are routed between the
 * residential ("direct") egress and the fallback pool of tinyproxy buckets.
 *
 * Kept free of I/O so it can be unit-tested from the Worker repo's vitest
 * suite (test/nas-fetch-proxy-lib.test.ts). The server file imports this and
 * stays a thin HTTP wrapper.
 *
 * Routing contract (decided 2026-09-10):
 *   - Every request tries the direct route first while it is healthy.
 *   - A block signal on direct (HTTP 403, or 1001tracklists' unblock_ip form
 *     in the body) puts direct into a cooldown (default 1 h). While in
 *     cooldown, requests go to a random healthy pool member instead.
 *   - The first request after the cooldown expires tries direct again — that
 *     is the "one probe per hour" limit. Blocked again → another cooldown.
 *   - Pool members that return a block signal get the same cooldown
 *     individually. A request may try up to `maxPoolAttempts` members.
 *   - Transport errors are NOT block signals: on direct they are returned to
 *     the caller as-is (a 1001tl outage must not double the traffic); on a
 *     pool member they just move on to the next member.
 */

export const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000
export const DEFAULT_MAX_POOL_ATTEMPTS = 2

const IP_BLOCK_FORM_RE = /action="\/info\/unblock_ip\.html"/
const IP_BLOCK_IP_RE = /Your IP is ((?:\d{1,3}\.){3}\d{1,3})/

/**
 * What an upstream response means for routing.
 *   - `ip_blocked`: 1001tracklists has rate-limited the egress IP. Either the
 *     status is 403 (how the block page is served since at least 2026-09) or
 *     the body carries the unblock_ip captcha form (older 200-with-form shape).
 *   - `gated`: the Turnstile "Please wait, you will be forwarded" shell served
 *     to cold/unauthenticated sessions. Not a ban — a re-login usually clears it.
 *   - `ok`: anything else, including 404s and 5xx, which are passed through.
 */
export function classifyUpstream(status, bodyText) {
  const body = typeof bodyText === 'string' ? bodyText : ''
  if (status === 403 || IP_BLOCK_FORM_RE.test(body)) return 'ip_blocked'
  if (body.includes('turnstile-container') && body.includes('Please wait, you will be forwarded')) return 'gated'
  return 'ok'
}

export function extractBlockedIp(bodyText) {
  const m = typeof bodyText === 'string' ? bodyText.match(IP_BLOCK_IP_RE) : null
  return m ? m[1] : null
}

/**
 * Parse the FALLBACK_PROXIES env value: proxy URLs separated by commas,
 * whitespace or newlines, each optionally prefixed with `label=`. Without a
 * label the `host:port` of the URL is used. Duplicates (by URL) are dropped.
 */
export function parsePoolConfig(raw) {
  const out = []
  const seen = new Set()
  for (const tok of String(raw ?? '').split(/[\s,]+/)) {
    if (!tok) continue
    let label = null
    let url = tok
    const eq = tok.indexOf('=')
    if (eq > 0 && !tok.slice(0, eq).includes('://')) {
      label = tok.slice(0, eq)
      url = tok.slice(eq + 1)
    }
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      throw new Error(`FALLBACK_PROXIES: invalid proxy URL "${url}"`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`FALLBACK_PROXIES: unsupported scheme in "${url}"`)
    }
    const key = parsed.toString()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ url: key, label: label ?? parsed.host })
  }
  return out
}

/**
 * Route state machine. `now` and `random` are injectable for tests.
 */
export class RoutePlanner {
  constructor({
    pool = [],
    cooldownMs = DEFAULT_COOLDOWN_MS,
    maxPoolAttempts = DEFAULT_MAX_POOL_ATTEMPTS,
    now = () => Date.now(),
    random = () => Math.random(),
  } = {}) {
    this.cooldownMs = cooldownMs
    this.maxPoolAttempts = maxPoolAttempts
    this.now = now
    this.random = random
    this.direct = { blockedUntil: 0, blockedSince: 0, blockedIp: null, lastBlockAt: 0, lastOkAt: 0 }
    this.members = pool.map((m) => ({
      url: m.url,
      label: m.label,
      blockedUntil: 0,
      blockedSince: 0,
      lastBlockAt: 0,
      lastOkAt: 0,
      okCount: 0,
      blockedCount: 0,
      errorCount: 0,
    }))
    this.counters = { directOk: 0, directBlocked: 0, poolOk: 0, poolBlocked: 0, poolError: 0, allBlocked: 0 }
  }

  isDirectBlocked(now = this.now()) {
    return this.direct.blockedUntil > now
  }

  healthyMembers(now = this.now()) {
    return this.members.filter((m) => m.blockedUntil <= now)
  }

  /** Random sample (without replacement) of healthy pool members. */
  pickPool(count = this.maxPoolAttempts, now = this.now()) {
    const pool = this.healthyMembers(now).slice()
    const picks = []
    while (pool.length && picks.length < count) {
      const i = Math.min(pool.length - 1, Math.floor(this.random() * pool.length))
      picks.push(pool.splice(i, 1)[0])
    }
    return picks
  }

  /**
   * Ordered list of routes to try for one request. `force` is the value of the
   * bearer-gated X-Proxy-Force-Route header: 'direct' or 'pool'.
   * Each route is `{ kind: 'direct' }` or `{ kind: 'pool', member }`.
   * An empty array means every route is in cooldown → the caller answers 503.
   */
  plan(force = null) {
    const now = this.now()
    if (force === 'direct') return [{ kind: 'direct' }]
    const poolRoutes = this.pickPool(this.maxPoolAttempts, now).map((member) => ({ kind: 'pool', member }))
    if (force === 'pool') return poolRoutes
    if (this.isDirectBlocked(now)) return poolRoutes
    return [{ kind: 'direct' }, ...poolRoutes]
  }

  /**
   * Record the outcome of one attempt. Returns a list of state-change events
   * (`direct.blocked`, `direct.recovered`, `member.blocked`, `member.recovered`)
   * so the server can log them.
   */
  report(route, outcome, { ip = null } = {}) {
    const now = this.now()
    const events = []
    if (route.kind === 'direct') {
      if (outcome === 'ip_blocked') {
        const wasBlocked = this.direct.blockedSince > 0
        this.direct.blockedUntil = now + this.cooldownMs
        if (!wasBlocked) this.direct.blockedSince = now
        this.direct.blockedIp = ip ?? this.direct.blockedIp
        this.direct.lastBlockAt = now
        this.counters.directBlocked++
        events.push({
          event: wasBlocked ? 'direct.still_blocked' : 'direct.blocked',
          ip: this.direct.blockedIp,
          blockedUntil: this.direct.blockedUntil,
        })
      } else if (outcome === 'ok' || outcome === 'gated') {
        const wasBlocked = this.direct.blockedSince > 0
        this.direct.blockedUntil = 0
        this.direct.lastOkAt = now
        if (outcome === 'ok') this.counters.directOk++
        if (wasBlocked) {
          events.push({ event: 'direct.recovered', blockedFor: now - this.direct.blockedSince, ip: this.direct.blockedIp })
          this.direct.blockedSince = 0
          this.direct.blockedIp = null
        }
      }
      return events
    }
    const m = route.member
    if (outcome === 'ip_blocked') {
      const wasBlocked = m.blockedSince > 0
      m.blockedUntil = now + this.cooldownMs
      if (!wasBlocked) m.blockedSince = now
      m.lastBlockAt = now
      m.blockedCount++
      this.counters.poolBlocked++
      events.push({ event: 'member.blocked', label: m.label, blockedUntil: m.blockedUntil })
    } else if (outcome === 'error') {
      m.errorCount++
      this.counters.poolError++
    } else {
      const wasBlocked = m.blockedSince > 0
      m.blockedUntil = 0
      m.lastOkAt = now
      if (outcome === 'ok') {
        m.okCount++
        this.counters.poolOk++
      }
      if (wasBlocked) {
        m.blockedSince = 0
        events.push({ event: 'member.recovered', label: m.label })
      }
    }
    return events
  }

  noteAllBlocked() {
    this.counters.allBlocked++
  }

  /** Snapshot for GET /status and for the X-Proxy-* response headers. */
  status() {
    const now = this.now()
    const iso = (ms) => (ms > 0 ? new Date(ms).toISOString() : null)
    return {
      now: new Date(now).toISOString(),
      cooldownMs: this.cooldownMs,
      direct: {
        blocked: this.isDirectBlocked(now),
        blockedSince: iso(this.direct.blockedSince),
        blockedUntil: iso(this.direct.blockedUntil),
        blockedIp: this.direct.blockedIp,
        lastBlockAt: iso(this.direct.lastBlockAt),
        lastOkAt: iso(this.direct.lastOkAt),
      },
      pool: this.members.map((m) => ({
        label: m.label,
        blocked: m.blockedUntil > now,
        blockedUntil: iso(m.blockedUntil),
        okCount: m.okCount,
        blockedCount: m.blockedCount,
        errorCount: m.errorCount,
        lastOkAt: iso(m.lastOkAt),
      })),
      poolHealthy: this.healthyMembers(now).length,
      poolTotal: this.members.length,
      counters: { ...this.counters },
    }
  }
}
