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
 *     pool member they move on to the next member and bench that member for
 *     a short error cooldown so a dead bucket is not re-tried every request.
 */

export const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000
export const DEFAULT_MAX_POOL_ATTEMPTS = 2
/** How long a pool member sits out after a transport error (proxy down, CONNECT refused). */
export const DEFAULT_ERROR_COOLDOWN_MS = 10 * 60 * 1000

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
  // 403 was the 2026-09-09 shape; the 2026-09-10 block arrived as a 429 with
  // the same unblock_ip form. Either status, or the form itself, is a block.
  if (status === 403 || status === 429 || IP_BLOCK_FORM_RE.test(body)) return 'ip_blocked'
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
    errorCooldownMs = DEFAULT_ERROR_COOLDOWN_MS,
    maxPoolAttempts = DEFAULT_MAX_POOL_ATTEMPTS,
    now = () => Date.now(),
    random = () => Math.random(),
  } = {}) {
    this.cooldownMs = cooldownMs
    this.errorCooldownMs = errorCooldownMs
    this.maxPoolAttempts = maxPoolAttempts
    this.now = now
    this.random = random
    this.direct = { blockedUntil: 0, blockedSince: 0, blockedIp: null, lastBlockAt: 0, lastOkAt: 0 }
    this.members = pool.map((m) => ({
      url: m.url,
      label: m.label,
      blockedUntil: 0,
      blockedSince: 0,
      unhealthyUntil: 0,
      lastBlockAt: 0,
      lastOkAt: 0,
      lastErrorAt: 0,
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
    return this.members.filter((m) => m.blockedUntil <= now && m.unhealthyUntil <= now)
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
      m.lastErrorAt = now
      m.unhealthyUntil = now + this.errorCooldownMs
      this.counters.poolError++
      events.push({ event: 'member.unhealthy', label: m.label, unhealthyUntil: m.unhealthyUntil })
    } else {
      const wasBlocked = m.blockedSince > 0
      m.blockedUntil = 0
      m.unhealthyUntil = 0
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
      errorCooldownMs: this.errorCooldownMs,
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
        unhealthy: m.unhealthyUntil > now,
        unhealthyUntil: iso(m.unhealthyUntil),
        okCount: m.okCount,
        blockedCount: m.blockedCount,
        errorCount: m.errorCount,
        lastOkAt: iso(m.lastOkAt),
        lastErrorAt: iso(m.lastErrorAt),
      })),
      poolHealthy: this.healthyMembers(now).length,
      poolTotal: this.members.length,
      counters: { ...this.counters },
    }
  }
}

// ─── 1001tracklists accounts ─────────────────────────────────────────────────
//
// 1001tl's block follows the *login session*, not the IP (verified 2026-09-10),
// and what trips it is per-account request rate. So the forwarder keeps N
// accounts, each with its own session, and spreads requests across them:
// N accounts ≈ N× the safe throughput, and a blocked account is simply skipped
// while the others keep serving (reliability). Accounts come from the env as
// numbered pairs — UPSTREAM_1001TL_EMAIL_1 / UPSTREAM_1001TL_PASSWORD_1,
// UPSTREAM_1001TL_EMAIL_2 / … — with no upper bound; the set is discovered by
// listing the env.

const ACCOUNT_ENV_RE = /^UPSTREAM_1001TL_(EMAIL|PASSWORD)_(\d+)$/

/**
 * Discover the configured accounts. Returns `[{ index, email, password }]`
 * sorted by index. Throws when a pair is missing its other half. The old
 * unsuffixed pair (UPSTREAM_1001TL_EMAIL / _PASSWORD) is still accepted, as
 * index 0 with `legacy: true`, so a half-migrated deploy degrades to one
 * account instead of to anonymous mode.
 */
export function parseAccountsFromEnv(env) {
  const byIndex = new Map()
  for (const [key, value] of Object.entries(env)) {
    const m = ACCOUNT_ENV_RE.exec(key)
    if (!m) continue
    const index = Number(m[2])
    const entry = byIndex.get(index) ?? { index, email: '', password: '' }
    if (m[1] === 'EMAIL') entry.email = String(value ?? '').trim()
    else entry.password = String(value ?? '')
    byIndex.set(index, entry)
  }
  const accounts = [...byIndex.values()].sort((a, b) => a.index - b.index)
  for (const a of accounts) {
    if (!a.email || !a.password) {
      throw new Error(`account ${a.index}: UPSTREAM_1001TL_EMAIL_${a.index} and UPSTREAM_1001TL_PASSWORD_${a.index} must both be set`)
    }
  }
  const seen = new Set()
  for (const a of accounts) {
    const k = a.email.toLowerCase()
    if (seen.has(k)) throw new Error(`account ${a.index}: ${a.email} is configured twice`)
    seen.add(k)
  }
  if (accounts.length === 0 && env.UPSTREAM_1001TL_EMAIL && env.UPSTREAM_1001TL_PASSWORD) {
    return [{ index: 0, email: String(env.UPSTREAM_1001TL_EMAIL).trim(), password: String(env.UPSTREAM_1001TL_PASSWORD), legacy: true }]
  }
  return accounts
}

/** Stable, filesystem-safe name for an account's cookie file. */
export function accountFileKey(email) {
  return email.toLowerCase().replace(/@/g, '_at_').replace(/[^a-z0-9._+-]/g, '_')
}

/**
 * Which account serves the next request, and how each one is doing.
 *
 * Selection is least-recently-used among healthy accounts (ties → lowest
 * index), i.e. round-robin that self-corrects when an account drops out: load
 * stays even, so every account sees ~1/N of the traffic. An account that was
 * blocked sits out `blockCooldownMs` (its fresh session is what the forwarder
 * tries first — see the proxy's re-login — and only a *still*-blocked fresh
 * session parks it); one whose login failed or errored sits out
 * `errorCooldownMs`. Re-logins are rate-limited per account.
 */
export class AccountPool {
  constructor({ accounts = [], blockCooldownMs = DEFAULT_COOLDOWN_MS, errorCooldownMs = DEFAULT_ERROR_COOLDOWN_MS, reloginCooldownMs = 10 * 60 * 1000, now = () => Date.now() } = {}) {
    this.blockCooldownMs = blockCooldownMs
    this.errorCooldownMs = errorCooldownMs
    this.reloginCooldownMs = reloginCooldownMs
    this.now = now
    this.members = accounts.map((a, i) => ({
      index: a.index,
      email: a.email,
      password: a.password,
      label: `acct${a.index}`,
      legacy: !!a.legacy,
      blockedUntil: 0,
      unhealthyUntil: 0,
      lastUsedAt: 0,
      lastOkAt: 0,
      lastBlockAt: 0,
      lastErrorAt: 0,
      okCount: 0,
      blockedCount: 0,
      errorCount: 0,
      loginFailures: 0,
      reloginLastAt: 0,
      reloginAttempts: 0,
      reloginRecovered: 0,
      reloginStillBlocked: 0,
      reloginFailed: 0,
      // Stable tiebreak so the very first requests go 1, 2, 3, … not all to 1.
      order: i,
    }))
  }

  get size() {
    return this.members.length
  }

  isHealthy(m, now = this.now()) {
    return m.blockedUntil <= now && m.unhealthyUntil <= now
  }

  healthyMembers(now = this.now()) {
    return this.members.filter((m) => this.isHealthy(m, now))
  }

  /**
   * Least-recently-used healthy account not in `exclude` (accounts already
   * tried for this request). Marks it used. Null when none is available.
   */
  pick(exclude = new Set(), now = this.now()) {
    const candidates = this.healthyMembers(now).filter((m) => !exclude.has(m))
    if (candidates.length === 0) return null
    candidates.sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.order - b.order)
    const m = candidates[0]
    m.lastUsedAt = now
    return m
  }

  /** Any account at all (for a probe when everything is parked): healthy first, then least recently used. */
  pickAny(now = this.now()) {
    if (this.members.length === 0) return null
    const sorted = [...this.members].sort(
      (a, b) => (this.isHealthy(b, now) ? 1 : 0) - (this.isHealthy(a, now) ? 1 : 0) || a.lastUsedAt - b.lastUsedAt || a.order - b.order,
    )
    const m = sorted[0]
    m.lastUsedAt = now
    return m
  }

  canRelogin(m, now = this.now()) {
    return now - m.reloginLastAt >= this.reloginCooldownMs
  }

  noteReloginAttempt(m, now = this.now()) {
    m.reloginLastAt = now
    m.reloginAttempts += 1
  }

  /**
   * Record an outcome for `m`. Returns the events to log.
   *   ok            — clears any block/unhealthy state
   *   ip_blocked    — parks the account for blockCooldownMs (the proxy calls
   *                   this after a fresh session was blocked too, or when no
   *                   re-login was possible)
   *   login_failed  — wrong password / login page unreachable: errorCooldownMs
   *   error         — transport trouble attributable to this account's session
   */
  report(m, outcome, extra = {}) {
    const now = this.now()
    const events = []
    if (outcome === 'ok') {
      m.okCount += 1
      m.lastOkAt = now
      if (m.blockedUntil > now || m.unhealthyUntil > now) {
        events.push({ event: 'account.recovered', label: m.label, email: m.email })
      }
      m.blockedUntil = 0
      m.unhealthyUntil = 0
      return events
    }
    if (outcome === 'ip_blocked') {
      m.blockedCount += 1
      m.lastBlockAt = now
      m.blockedUntil = now + this.blockCooldownMs
      events.push({ event: 'account.blocked', label: m.label, email: m.email, blockedUntil: m.blockedUntil, ...extra })
      return events
    }
    if (outcome === 'login_failed') {
      m.loginFailures += 1
      m.errorCount += 1
      m.lastErrorAt = now
      m.unhealthyUntil = now + this.errorCooldownMs
      events.push({ event: 'account.login_failed', label: m.label, email: m.email, unhealthyUntil: m.unhealthyUntil, ...extra })
      return events
    }
    m.errorCount += 1
    m.lastErrorAt = now
    m.unhealthyUntil = now + this.errorCooldownMs
    events.push({ event: 'account.unhealthy', label: m.label, email: m.email, unhealthyUntil: m.unhealthyUntil, ...extra })
    return events
  }

  status() {
    const now = this.now()
    const iso = (ms) => (ms ? new Date(ms).toISOString() : null)
    return {
      accounts: this.members.map((m) => ({
        label: m.label,
        email: m.email,
        legacy: m.legacy,
        healthy: this.isHealthy(m, now),
        blocked: m.blockedUntil > now,
        blockedUntil: iso(m.blockedUntil),
        unhealthy: m.unhealthyUntil > now,
        unhealthyUntil: iso(m.unhealthyUntil),
        lastUsedAt: iso(m.lastUsedAt),
        lastOkAt: iso(m.lastOkAt),
        lastBlockAt: iso(m.lastBlockAt),
        okCount: m.okCount,
        blockedCount: m.blockedCount,
        errorCount: m.errorCount,
        loginFailures: m.loginFailures,
        relogin: {
          lastAt: iso(m.reloginLastAt),
          attempts: m.reloginAttempts,
          recovered: m.reloginRecovered,
          stillBlocked: m.reloginStillBlocked,
          failed: m.reloginFailed,
          available: this.canRelogin(m, now),
        },
      })),
      accountsHealthy: this.healthyMembers(now).length,
      accountsTotal: this.members.length,
      reloginCooldownMs: this.reloginCooldownMs,
    }
  }
}
