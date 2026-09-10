import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  classifyUpstream,
  extractBlockedIp,
  parsePoolConfig,
  RoutePlanner,
  AccountPool,
  parseAccountsFromEnv,
  accountFileKey,
  type Route,
} from '../scripts/nas-fetch-proxy-lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fx = (name: string) => readFileSync(resolve(here, 'fixtures', name), 'utf8')

describe('classifyUpstream', () => {
  it('treats HTTP 403 and 429 as a block regardless of body', () => {
    expect(classifyUpstream(403, '<html>whatever</html>')).toBe('ip_blocked')
    expect(classifyUpstream(403, '')).toBe('ip_blocked')
    // 2026-09-10: the block page came back as 429 Too Many Requests.
    expect(classifyUpstream(429, '')).toBe('ip_blocked')
  })

  it('detects the unblock_ip form on a 200', () => {
    expect(classifyUpstream(200, fx('ip-block-tracklist.html'))).toBe('ip_blocked')
    expect(classifyUpstream(200, fx('ip-block-search.html'))).toBe('ip_blocked')
  })

  it('detects the Turnstile "please wait" gate', () => {
    const gate = '<div id="turnstile-container"></div><p>Please wait, you will be forwarded to the requested page</p>'
    expect(classifyUpstream(200, gate)).toBe('gated')
  })

  it('passes real pages, 404s and 5xx through as ok', () => {
    expect(classifyUpstream(200, fx('tracklist-matroda.html'))).toBe('ok')
    expect(classifyUpstream(404, '<html>not found</html>')).toBe('ok')
    expect(classifyUpstream(502, '')).toBe('ok')
  })

  it('extracts the blocked IP from the block page', () => {
    expect(extractBlockedIp(fx('ip-block-tracklist.html'))).toMatch(/^(?:\d{1,3}\.){3}\d{1,3}$/)
    expect(extractBlockedIp('nope')).toBeNull()
  })
})

describe('parsePoolConfig', () => {
  it('accepts comma / whitespace / newline separated URLs with optional labels', () => {
    const pool = parsePoolConfig(`
      bgp1:18180=http://100.82.201.37:18180, http://100.82.201.37:18181
      http://100.123.204.114:18180
    `)
    expect(pool).toEqual([
      { url: 'http://100.82.201.37:18180/', label: 'bgp1:18180' },
      { url: 'http://100.82.201.37:18181/', label: '100.82.201.37:18181' },
      { url: 'http://100.123.204.114:18180/', label: '100.123.204.114:18180' },
    ])
  })

  it('drops duplicates and rejects garbage', () => {
    expect(parsePoolConfig('http://a:1,http://a:1')).toHaveLength(1)
    expect(parsePoolConfig('')).toEqual([])
    expect(() => parsePoolConfig('not a url')).toThrow(/invalid proxy URL/)
    expect(() => parsePoolConfig('socks5://a:1')).toThrow(/unsupported scheme/)
  })
})

function planner(opts: { pool?: number; cooldownMs?: number; maxPoolAttempts?: number } = {}) {
  let t = 1_000_000
  const now = () => t
  const advance = (ms: number) => {
    t += ms
  }
  // Deterministic "random": always pick the first healthy member.
  const random = () => 0
  const pool = Array.from({ length: opts.pool ?? 3 }, (_, i) => ({ url: `http://p${i}:1/`, label: `p${i}` }))
  const p = new RoutePlanner({ pool, cooldownMs: opts.cooldownMs ?? 3600_000, maxPoolAttempts: opts.maxPoolAttempts ?? 2, now, random })
  return { p, advance, now }
}

const kinds = (routes: Route[]) => routes.map((r) => (r.kind === 'direct' ? 'direct' : `pool:${r.member.label}`))

describe('RoutePlanner', () => {
  it('tries direct first, then pool members, while healthy', () => {
    const { p } = planner()
    expect(kinds(p.plan())).toEqual(['direct', 'pool:p0', 'pool:p1'])
  })

  it('puts direct into cooldown on a block and routes to the pool', () => {
    const { p, advance } = planner()
    const events = p.report({ kind: 'direct' }, 'ip_blocked', { ip: '1.2.3.4' })
    expect(events).toEqual([{ event: 'direct.blocked', ip: '1.2.3.4', blockedUntil: 1_000_000 + 3600_000 }])
    expect(p.isDirectBlocked()).toBe(true)
    expect(kinds(p.plan())).toEqual(['pool:p0', 'pool:p1'])
    advance(30 * 60_000)
    expect(kinds(p.plan())).toEqual(['pool:p0', 'pool:p1'])
  })

  it('probes direct exactly once per cooldown window', () => {
    const { p, advance } = planner()
    p.report({ kind: 'direct' }, 'ip_blocked', { ip: '1.2.3.4' })
    advance(3600_000)
    // Cooldown expired → next plan leads with direct (the probe).
    expect(kinds(p.plan())[0]).toBe('direct')
    // Still blocked → cooldown renews from now, status says still_blocked.
    const ev = p.report({ kind: 'direct' }, 'ip_blocked', { ip: '1.2.3.4' })
    expect(ev[0]!.event).toBe('direct.still_blocked')
    expect(kinds(p.plan())[0]).toBe('pool:p0')
    advance(3599_000)
    expect(kinds(p.plan())[0]).toBe('pool:p0')
    advance(1_000)
    expect(kinds(p.plan())[0]).toBe('direct')
  })

  it('reports recovery when direct works again after a block', () => {
    const { p, advance } = planner()
    p.report({ kind: 'direct' }, 'ip_blocked', { ip: '1.2.3.4' })
    advance(3600_000)
    const ev = p.report({ kind: 'direct' }, 'ok')
    expect(ev).toEqual([{ event: 'direct.recovered', blockedFor: 3600_000, ip: '1.2.3.4' }])
    expect(p.isDirectBlocked()).toBe(false)
    expect(p.status().direct).toMatchObject({ blocked: false, blockedIp: null, blockedSince: null })
    expect(kinds(p.plan())[0]).toBe('direct')
  })

  it('takes blocked pool members out of rotation for their own cooldown', () => {
    const { p, advance } = planner({ pool: 2 })
    p.report({ kind: 'direct' }, 'ip_blocked')
    const [first] = p.plan()
    expect(first!.kind).toBe('pool')
    p.report(first!, 'ip_blocked')
    expect(kinds(p.plan())).toEqual(['pool:p1'])
    p.report(p.plan()[0]!, 'ip_blocked')
    // Everything blocked → nothing to try.
    expect(p.plan()).toEqual([])
    advance(3600_000)
    // All cooldowns expire together → direct probe first, pool after.
    expect(kinds(p.plan())).toEqual(['direct', 'pool:p0', 'pool:p1'])
  })

  it('benches a pool member for the error cooldown after a transport error, without calling it blocked', () => {
    const { p, advance } = planner({ pool: 2 })
    const route = p.plan()[1]!
    const ev = p.report(route, 'error')
    expect(ev[0]!.event).toBe('member.unhealthy')
    expect(kinds(p.plan())).toEqual(['direct', 'pool:p1'])
    expect(p.status().pool[0]).toMatchObject({ errorCount: 1, blocked: false, unhealthy: true, blockedCount: 0 })
    advance(10 * 60_000)
    expect(kinds(p.plan())).toEqual(['direct', 'pool:p0', 'pool:p1'])
    p.report(p.plan()[1]!, 'ok')
    expect(p.status().pool[0]).toMatchObject({ unhealthy: false, okCount: 1 })
  })

  it('honours the force-route header', () => {
    const { p } = planner()
    p.report({ kind: 'direct' }, 'ip_blocked')
    expect(kinds(p.plan('direct'))).toEqual(['direct'])
    p.report({ kind: 'direct' }, 'ok')
    expect(kinds(p.plan('pool'))).toEqual(['pool:p0', 'pool:p1'])
  })

  it('samples pool members without replacement using the injected random', () => {
    const seq = [0.99, 0.0]
    const p = new RoutePlanner({
      pool: [
        { url: 'http://a/', label: 'a' },
        { url: 'http://b/', label: 'b' },
        { url: 'http://c/', label: 'c' },
      ],
      maxPoolAttempts: 2,
      random: () => seq.shift() ?? 0,
    })
    expect(p.pickPool().map((m) => m.label)).toEqual(['c', 'a'])
  })

  it('exposes a status snapshot with ISO timestamps and counters', () => {
    const { p } = planner({ pool: 1 })
    p.report({ kind: 'direct' }, 'ok')
    p.report({ kind: 'direct' }, 'ip_blocked', { ip: '9.9.9.9' })
    const s = p.status()
    expect(s.direct.blocked).toBe(true)
    expect(s.direct.blockedIp).toBe('9.9.9.9')
    expect(s.direct.blockedUntil).toBe(new Date(1_000_000 + 3600_000).toISOString())
    expect(s.counters).toEqual({ directOk: 1, directBlocked: 1, poolOk: 0, poolBlocked: 0, poolError: 0, allBlocked: 0 })
    expect(s.poolHealthy).toBe(1)
    expect(s.poolTotal).toBe(1)
  })
})

describe('parseAccountsFromEnv', () => {
  it('discovers numbered pairs in any order, ignores other vars, sorts by index', () => {
    const accts = parseAccountsFromEnv({
      UPSTREAM_1001TL_EMAIL_3: 'c@x.com',
      UPSTREAM_1001TL_PASSWORD_3: 'p3',
      UPSTREAM_1001TL_EMAIL_1: ' a@x.com ',
      UPSTREAM_1001TL_PASSWORD_1: 'p1',
      UPSTREAM_1001TL_EMAIL_12: 'l@x.com',
      UPSTREAM_1001TL_PASSWORD_12: 'p12',
      PROXY_TOKEN: 'zzz',
    })
    expect(accts.map((a) => `${a.index}:${a.email}`)).toEqual(['1:a@x.com', '3:c@x.com', '12:l@x.com'])
    expect(accts[0]!.password).toBe('p1')
  })

  it('rejects a half pair or a duplicate email, returns [] when none are configured', () => {
    expect(() => parseAccountsFromEnv({ UPSTREAM_1001TL_EMAIL_2: 'b@x.com' })).toThrow(/PASSWORD_2/)
    expect(() => parseAccountsFromEnv({ UPSTREAM_1001TL_EMAIL_1: 'a@x.com', UPSTREAM_1001TL_PASSWORD_1: 'p', UPSTREAM_1001TL_EMAIL_2: 'A@x.com', UPSTREAM_1001TL_PASSWORD_2: 'q' })).toThrow(/twice/)
    expect(parseAccountsFromEnv({ PROXY_TOKEN: 'x' })).toEqual([])
  })

  it('still reads the legacy unsuffixed pair as account 0 when no numbered pair exists', () => {
    expect(parseAccountsFromEnv({ UPSTREAM_1001TL_EMAIL: 'old@x.com', UPSTREAM_1001TL_PASSWORD: 'p' })).toEqual([{ index: 0, email: 'old@x.com', password: 'p', legacy: true }])
    // …but numbered pairs win outright.
    expect(parseAccountsFromEnv({ UPSTREAM_1001TL_EMAIL: 'old@x.com', UPSTREAM_1001TL_PASSWORD: 'p', UPSTREAM_1001TL_EMAIL_1: 'a@x.com', UPSTREAM_1001TL_PASSWORD_1: 'p1' }).map((a) => a.email)).toEqual(['a@x.com'])
  })

  it('derives a stable filesystem-safe cookie file key from the email', () => {
    expect(accountFileKey('Gaxopa6482@gcervera.com')).toBe('gaxopa6482_at_gcervera.com')
    expect(accountFileKey('we ird/name@x.com')).toBe('we_ird_name_at_x.com')
  })
})

describe('AccountPool', () => {
  function pool(n: number) {
    let t = 1_000_000
    const now = () => t
    const advance = (ms: number) => {
      t += ms
    }
    const accounts = Array.from({ length: n }, (_, i) => ({ index: i + 1, email: `a${i + 1}@x.com`, password: 'p' }))
    const p = new AccountPool({ accounts, blockCooldownMs: 3600_000, errorCooldownMs: 600_000, reloginCooldownMs: 600_000, now })
    return { p, advance }
  }
  const labels = (ms: Array<{ label: string }>) => ms.map((m) => m.label)

  it('round-robins least-recently-used first, so every account carries ~1/N of the load', () => {
    const { p, advance } = pool(3)
    const picks: string[] = []
    for (let i = 0; i < 7; i++) {
      advance(1000)
      picks.push(p.pick()!.label)
    }
    expect(picks).toEqual(['acct1', 'acct2', 'acct3', 'acct1', 'acct2', 'acct3', 'acct1'])
  })

  it('parks a blocked account for the block cooldown and keeps serving from the rest', () => {
    const { p, advance } = pool(3)
    const a1 = p.pick()!
    const ev = p.report(a1, 'ip_blocked', { ip: '1.2.3.4' })
    expect(ev[0]).toMatchObject({ event: 'account.blocked', label: 'acct1', ip: '1.2.3.4' })
    expect(labels(p.healthyMembers())).toEqual(['acct2', 'acct3'])
    const seq = [1, 2, 3, 4].map(() => {
      advance(1000)
      return p.pick()!.label
    })
    expect(seq).toEqual(['acct2', 'acct3', 'acct2', 'acct3'])
    advance(3600_000)
    expect(labels(p.healthyMembers())).toEqual(['acct1', 'acct2', 'acct3'])
    expect(p.report(a1, 'ok')).toEqual([])
    expect(p.status().accountsHealthy).toBe(3)
  })

  it('excludes accounts already tried for this request and reports none left', () => {
    const { p } = pool(2)
    const tried = new Set<import('../scripts/nas-fetch-proxy-lib.mjs').AccountMember>()
    const first = p.pick(tried)!
    tried.add(first)
    const second = p.pick(tried)!
    expect(second.label).not.toBe(first.label)
    tried.add(second)
    expect(p.pick(tried)).toBeNull()
  })

  it('benches a login failure for the error cooldown and recovers on the next ok', () => {
    const { p, advance } = pool(2)
    const a = p.pick()!
    expect(p.report(a, 'login_failed', { error: 'bad password' })[0]!.event).toBe('account.login_failed')
    expect(p.status().accounts[0]).toMatchObject({ healthy: false, unhealthy: true, loginFailures: 1 })
    advance(600_000)
    expect(p.isHealthy(a)).toBe(true)
    expect(p.report(a, 'ok')).toEqual([])
  })

  it('rate-limits re-logins per account and pickAny still returns a parked account for probes', () => {
    const { p, advance } = pool(1)
    const a = p.pick()!
    expect(p.canRelogin(a)).toBe(true)
    p.noteReloginAttempt(a)
    expect(p.canRelogin(a)).toBe(false)
    advance(600_000)
    expect(p.canRelogin(a)).toBe(true)
    p.report(a, 'ip_blocked')
    expect(p.pick()).toBeNull()
    expect(p.pickAny()!.label).toBe('acct1')
    const st = p.status()
    expect(st.accountsHealthy).toBe(0)
    expect(st.accounts[0]!.relogin.attempts).toBe(1)
  })
})
