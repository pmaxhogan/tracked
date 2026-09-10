/**
 * Type declarations for nas-fetch-proxy-lib.mjs so the Worker repo's tests
 * (TypeScript, strict) can import it. Keep in sync with the .mjs.
 */

export const DEFAULT_COOLDOWN_MS: number
export const DEFAULT_MAX_POOL_ATTEMPTS: number
export const DEFAULT_ERROR_COOLDOWN_MS: number

export type UpstreamKind = 'ip_blocked' | 'gated' | 'ok'
export function classifyUpstream(status: number, bodyText: string | null | undefined): UpstreamKind
export function extractBlockedIp(bodyText: string | null | undefined): string | null

export type PoolConfigEntry = { url: string; label: string }
export function parsePoolConfig(raw: string | null | undefined): PoolConfigEntry[]

export type PoolMember = {
  url: string
  label: string
  blockedUntil: number
  blockedSince: number
  unhealthyUntil: number
  lastBlockAt: number
  lastOkAt: number
  lastErrorAt: number
  okCount: number
  blockedCount: number
  errorCount: number
}

export type Route = { kind: 'direct' } | { kind: 'pool'; member: PoolMember }
export type Outcome = 'ok' | 'ip_blocked' | 'gated' | 'error'
export type PlannerEvent = { event: string; [k: string]: unknown }

export type PlannerStatus = {
  now: string
  cooldownMs: number
  errorCooldownMs: number
  direct: {
    blocked: boolean
    blockedSince: string | null
    blockedUntil: string | null
    blockedIp: string | null
    lastBlockAt: string | null
    lastOkAt: string | null
  }
  pool: Array<{
    label: string
    blocked: boolean
    blockedUntil: string | null
    unhealthy: boolean
    unhealthyUntil: string | null
    okCount: number
    blockedCount: number
    errorCount: number
    lastOkAt: string | null
    lastErrorAt: string | null
  }>
  poolHealthy: number
  poolTotal: number
  counters: {
    directOk: number
    directBlocked: number
    poolOk: number
    poolBlocked: number
    poolError: number
    allBlocked: number
  }
}

export class RoutePlanner {
  constructor(opts?: {
    pool?: PoolConfigEntry[]
    cooldownMs?: number
    errorCooldownMs?: number
    maxPoolAttempts?: number
    now?: () => number
    random?: () => number
  })
  cooldownMs: number
  errorCooldownMs: number
  maxPoolAttempts: number
  direct: { blockedUntil: number; blockedSince: number; blockedIp: string | null; lastBlockAt: number; lastOkAt: number }
  members: PoolMember[]
  counters: PlannerStatus['counters']
  isDirectBlocked(now?: number): boolean
  healthyMembers(now?: number): PoolMember[]
  pickPool(count?: number, now?: number): PoolMember[]
  plan(force?: 'direct' | 'pool' | null): Route[]
  report(route: Route, outcome: Outcome, extra?: { ip?: string | null }): PlannerEvent[]
  noteAllBlocked(): void
  status(): PlannerStatus
}
