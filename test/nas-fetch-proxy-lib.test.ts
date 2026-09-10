import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  classifyUpstream,
  extractBlockedIp,
  parsePoolConfig,
  RoutePlanner,
  type Route,
} from '../scripts/nas-fetch-proxy-lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fx = (name: string) => readFileSync(resolve(here, 'fixtures', name), 'utf8')

describe('classifyUpstream', () => {
  it('treats HTTP 403 as an IP block regardless of body', () => {
    expect(classifyUpstream(403, '<html>whatever</html>')).toBe('ip_blocked')
    expect(classifyUpstream(403, '')).toBe('ip_blocked')
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
