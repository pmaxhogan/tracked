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

// ─── accounts ────────────────────────────────────────────────────────────────
export type AccountConfig = { index: number; email: string; password: string; legacy?: boolean }
export function parseAccountsFromEnv(env: Record<string, string | undefined>): AccountConfig[]
export function accountFileKey(email: string): string

export type AccountMember = {
  index: number
  email: string
  password: string
  label: string
  legacy: boolean
  blockedUntil: number
  unhealthyUntil: number
  lastUsedAt: number
  lastOkAt: number
  lastBlockAt: number
  lastErrorAt: number
  okCount: number
  blockedCount: number
  errorCount: number
  loginFailures: number
  reloginLastAt: number
  reloginAttempts: number
  reloginRecovered: number
  reloginStillBlocked: number
  reloginFailed: number
  order: number
}
export type AccountOutcome = 'ok' | 'ip_blocked' | 'login_failed' | 'error'
export type AccountStatus = {
  accounts: Array<{
    label: string
    email: string
    legacy: boolean
    healthy: boolean
    blocked: boolean
    blockedUntil: string | null
    unhealthy: boolean
    unhealthyUntil: string | null
    lastUsedAt: string | null
    lastOkAt: string | null
    lastBlockAt: string | null
    okCount: number
    blockedCount: number
    errorCount: number
    loginFailures: number
    relogin: { lastAt: string | null; attempts: number; recovered: number; stillBlocked: number; failed: number; available: boolean }
  }>
  accountsHealthy: number
  accountsTotal: number
  reloginCooldownMs: number
}
export class AccountPool {
  constructor(opts?: { accounts?: AccountConfig[]; blockCooldownMs?: number; errorCooldownMs?: number; reloginCooldownMs?: number; now?: () => number })
  members: AccountMember[]
  readonly size: number
  isHealthy(m: AccountMember, now?: number): boolean
  healthyMembers(now?: number): AccountMember[]
  pick(exclude?: Set<AccountMember>, now?: number): AccountMember | null
  pickAny(now?: number): AccountMember | null
  canRelogin(m: AccountMember, now?: number): boolean
  noteReloginAttempt(m: AccountMember, now?: number): void
  report(m: AccountMember, outcome: AccountOutcome, extra?: Record<string, unknown>): PlannerEvent[]
  status(): AccountStatus
}
