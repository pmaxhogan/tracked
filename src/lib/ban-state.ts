/**
 * IP-ban state for the 1001tracklists fetch path.
 *
 * 1001tracklists rate-limits per IP: after a burst it serves a captcha page
 * (HTTP 403 with an `/info/unblock_ip.html` form) until a human solves it from
 * the blocked IP. The NAS forwarder (`scripts/nas-fetch-proxy.mjs`) detects
 * that on the residential IP and reroutes through its tailnet pool, reporting
 * what it did in `X-Proxy-*` headers. This module turns those reports into
 * durable state in the CACHE KV so that:
 *
 *   - the admin page can show a big red "solve the captcha" banner (`ban:home`)
 *   - a Web Push fires once when a ban starts and once when it clears
 *   - the Worker stops hitting the forwarder for a cooldown once EVERY route
 *     is blocked (`ban:pause`, 1 h — the "1/hr" retry limit), falling back to
 *     BrightData within a daily budget (`ban:bd:<day>`) and otherwise pausing
 *   - each episode is recorded for the admin page's history (`ban:ep:<invTs>`)
 *
 * All writes are best-effort: a KV hiccup here must never fail a fetch.
 */

import type { Env } from '../types'
import { invertedTs } from './cache'
import { probeHomeProxy, type HomeProxyProbe, type HomeProxyResult } from './homeProxy'
import type { Logger } from './log'
import { banClearPayload, banStartPayload, pushConfigured, sendPushToAll } from './web-push'

/** Worker-side pause after every route is blocked. Mirrors the forwarder's BLOCK_COOLDOWN_MS. */
export const BAN_COOLDOWN_SECONDS = 60 * 60
export const DEFAULT_BRIGHTDATA_DAILY_CAP = 333

const HOME_KEY = 'ban:home'
const PAUSE_KEY = 'ban:pause'
const EPISODE_PREFIX = 'ban:ep:'
const BRIGHTDATA_PREFIX = 'ban:bd:'
const EPISODE_TTL_SECONDS = 180 * 24 * 60 * 60
const BRIGHTDATA_TTL_SECONDS = 3 * 24 * 60 * 60

export type BanSource = 'proxy' | 'probe' | 'simulated'

export type HomeBan = {
  /** ISO time the block was first observed. */
  since: string
  /** ISO time the forwarder will next probe the residential IP (its cooldown end). */
  until: string | null
  ip: string | null
  episodeKey: string
  source: BanSource
  lastSeenAt: string
  poolHealthy: number | null
  poolTotal: number | null
  simulated: boolean
  /** Last time the cron probed the forwarder because the cooldown had lapsed with no traffic. */
  lastCronProbeAt?: string | null
}

export type Pause = {
  since: string
  until: string
  reason: 'all_routes_blocked' | 'simulated'
  ip: string | null
}

export type BanEpisode = {
  key: string
  startedAt: string
  endedAt: string | null
  blockedForMs: number | null
  ip: string | null
  source: BanSource
  simulated: boolean
  /** Requests the forwarder served through the pool while this episode was open. */
  poolRequests: number
  /** BrightData calls made while this episode was open. */
  brightdataRequests: number
  /** Times the forwarder reported every route blocked. */
  allBlockedHits: number
  clearedBy: 'auto' | 'probe' | 'manual' | null
  pushStart: { sent: number; total: number } | null
  pushClear: { sent: number; total: number } | null
}

export type BrightdataUsage = { date: string; used: number; cap: number; remaining: number }

export type BanStatus = {
  now: string
  home: HomeBan | null
  pause: Pause | null
  brightdata: BrightdataUsage
  episodes: BanEpisode[]
  pushConfigured: boolean
}

type Kv = Pick<KVNamespace, 'get' | 'put' | 'delete' | 'list'>
type BanEnv = Pick<Env, 'CACHE' | 'SUBS' | 'BRIGHTDATA_DAILY_CAP' | 'VAPID_PUBLIC_KEY' | 'VAPID_PRIVATE_KEY' | 'VAPID_SUBJECT'>

const nowIso = () => new Date().toISOString()

// ─── In-isolate tally, flushed into the open episode at most every few seconds
// (KV allows one write per second per key; a sync run does ~50 fetches in 25 s).
const tally = { pool: 0, brightdata: 0, allBlocked: 0, lastFlushAt: 0 }
const FLUSH_INTERVAL_MS = 5000

async function getJson<T>(kv: Kv, key: string): Promise<T | null> {
  try {
    return ((await kv.get(key, 'json')) as T | null) ?? null
  } catch {
    return null
  }
}

async function putJson(kv: Kv, key: string, value: unknown, ttlSeconds?: number): Promise<void> {
  await kv.put(key, JSON.stringify(value), ttlSeconds ? { expirationTtl: ttlSeconds } : undefined)
}

export async function getHomeBan(env: BanEnv): Promise<HomeBan | null> {
  return getJson<HomeBan>(env.CACHE, HOME_KEY)
}

export async function getPause(env: BanEnv): Promise<Pause | null> {
  const p = await getJson<Pause>(env.CACHE, PAUSE_KEY)
  if (!p) return null
  if (Date.parse(p.until) <= Date.now()) {
    await env.CACHE.delete(PAUSE_KEY).catch(() => {})
    return null
  }
  return p
}

let pauseMemo: { at: number; value: Pause | null } | null = null
/** `getPause` memoised for a few seconds so a 50-set sync loop is one KV read, not fifty. */
export async function isPaused(env: BanEnv): Promise<Pause | null> {
  if (pauseMemo && Date.now() - pauseMemo.at < 5000) return pauseMemo.value
  const value = await getPause(env)
  pauseMemo = { at: Date.now(), value }
  return value
}

export async function setPause(env: BanEnv, reason: Pause['reason'], ip: string | null, log?: Logger): Promise<Pause> {
  const existing = await getPause(env)
  if (existing) return existing
  const since = nowIso()
  const pause: Pause = { since, until: new Date(Date.now() + BAN_COOLDOWN_SECONDS * 1000).toISOString(), reason, ip }
  await putJson(env.CACHE, PAUSE_KEY, pause, BAN_COOLDOWN_SECONDS + 60)
  pauseMemo = { at: Date.now(), value: pause }
  log?.warn('ban.pause_set', { ...pause })
  return pause
}

export async function clearPause(env: BanEnv, log?: Logger): Promise<boolean> {
  const existing = await getJson<Pause>(env.CACHE, PAUSE_KEY)
  await env.CACHE.delete(PAUSE_KEY).catch(() => {})
  pauseMemo = { at: Date.now(), value: null }
  if (existing) log?.info('ban.pause_cleared', { ...existing })
  return !!existing
}

export async function getEpisode(env: BanEnv, key: string): Promise<BanEpisode | null> {
  return getJson<BanEpisode>(env.CACHE, key)
}

export async function listEpisodes(env: BanEnv, limit = 10): Promise<BanEpisode[]> {
  const page = await env.CACHE.list({ prefix: EPISODE_PREFIX, limit })
  const out: BanEpisode[] = []
  for (const k of page.keys) {
    const ep = await getJson<BanEpisode>(env.CACHE, k.name)
    if (ep) out.push(ep)
  }
  return out
}

async function putEpisode(env: BanEnv, ep: BanEpisode): Promise<void> {
  await putJson(env.CACHE, ep.key, ep, EPISODE_TTL_SECONDS)
}

/**
 * Start a ban episode: write `ban:home`, create the episode record and fire
 * the "blocked" push (once). No-op if an episode is already open.
 */
export async function openEpisode(
  env: BanEnv,
  info: { ip: string | null; source: BanSource; until: string | null; viaPool: boolean; poolHealthy?: number | null; poolTotal?: number | null; simulated?: boolean },
  log?: Logger,
): Promise<HomeBan> {
  const existing = await getHomeBan(env)
  if (existing) return existing
  const since = nowIso()
  const key = `${EPISODE_PREFIX}${invertedTs(Date.now())}`
  const home: HomeBan = {
    since,
    until: info.until,
    ip: info.ip,
    episodeKey: key,
    source: info.source,
    lastSeenAt: since,
    poolHealthy: info.poolHealthy ?? null,
    poolTotal: info.poolTotal ?? null,
    simulated: !!info.simulated,
  }
  const episode: BanEpisode = {
    key,
    startedAt: since,
    endedAt: null,
    blockedForMs: null,
    ip: info.ip,
    source: info.source,
    simulated: !!info.simulated,
    poolRequests: 0,
    brightdataRequests: 0,
    allBlockedHits: 0,
    clearedBy: null,
    pushStart: null,
    pushClear: null,
  }
  await putJson(env.CACHE, HOME_KEY, home)
  await putEpisode(env, episode)
  log?.error('ban.episode_opened', { key, ip: info.ip, source: info.source, viaPool: info.viaPool, simulated: !!info.simulated })
  try {
    const push = await sendPushToAll(env as Env, banStartPayload(info.ip, info.viaPool), log)
    episode.pushStart = { sent: push.sent, total: push.total }
    await putEpisode(env, episode)
  } catch (e) {
    log?.warn('ban.push_start_failed', { error: e instanceof Error ? e.message : String(e) })
  }
  return home
}

async function updateHomeBan(env: BanEnv, home: HomeBan, patch: Partial<HomeBan>): Promise<HomeBan> {
  const next = { ...home, ...patch, lastSeenAt: nowIso() }
  await putJson(env.CACHE, HOME_KEY, next)
  return next
}

/**
 * End the open episode: stamp it, drop `ban:home` and any pause, fire the
 * "cleared" push. Returns the closed episode, or null if none was open.
 */
export async function closeEpisode(env: BanEnv, clearedBy: NonNullable<BanEpisode['clearedBy']>, log?: Logger): Promise<BanEpisode | null> {
  const home = await getHomeBan(env)
  if (!home) return null
  await flushBanTally(env, true)
  const ep = (await getEpisode(env, home.episodeKey)) ?? {
    key: home.episodeKey,
    startedAt: home.since,
    endedAt: null,
    blockedForMs: null,
    ip: home.ip,
    source: home.source,
    simulated: home.simulated,
    poolRequests: 0,
    brightdataRequests: 0,
    allBlockedHits: 0,
    clearedBy: null,
    pushStart: null,
    pushClear: null,
  }
  const endedAt = nowIso()
  ep.endedAt = endedAt
  ep.blockedForMs = Math.max(0, Date.parse(endedAt) - Date.parse(ep.startedAt))
  ep.clearedBy = clearedBy
  await env.CACHE.delete(HOME_KEY).catch(() => {})
  await clearPause(env, log)
  await putEpisode(env, ep)
  log?.warn('ban.episode_closed', { key: ep.key, ip: ep.ip, clearedBy, blockedForMs: ep.blockedForMs, poolRequests: ep.poolRequests, brightdataRequests: ep.brightdataRequests })
  try {
    const push = await sendPushToAll(env as Env, banClearPayload(ep.ip, ep.blockedForMs), log)
    ep.pushClear = { sent: push.sent, total: push.total }
    await putEpisode(env, ep)
  } catch (e) {
    log?.warn('ban.push_clear_failed', { error: e instanceof Error ? e.message : String(e) })
  }
  return ep
}

/**
 * The single hook the fetch cascade calls after every forwarder round-trip.
 * Reads the X-Proxy-* facts off the result and reconciles KV: opens/refreshes
 * the episode when direct is in cooldown, closes it when direct works again,
 * and sets the Worker-side pause when every route is blocked.
 */
export async function noteProxyResult(env: BanEnv, r: HomeProxyResult, log?: Logger): Promise<void> {
  try {
    if (r.route === 'pool') tally.pool++
    if (r.kind === 'all_blocked') tally.allBlocked++
    const home = await getHomeBan(env)
    if (r.directBlocked) {
      const viaPool = r.route === 'pool' || (r.poolHealthy ?? 0) > 0
      if (!home) {
        await openEpisode(env, { ip: r.directBlocked.ip, source: 'proxy', until: r.directBlocked.until, viaPool, poolHealthy: r.poolHealthy, poolTotal: r.poolTotal }, log)
      } else if (home.until !== r.directBlocked.until || (!home.ip && r.directBlocked.ip) || home.poolHealthy !== r.poolHealthy) {
        await updateHomeBan(env, home, { until: r.directBlocked.until, ip: home.ip ?? r.directBlocked.ip, poolHealthy: r.poolHealthy, poolTotal: r.poolTotal })
      }
    }
    if (r.kind === 'all_blocked') {
      await setPause(env, 'all_routes_blocked', r.directBlocked?.ip ?? null, log)
    } else if (home && !home.simulated && (r.directRecovered || (r.route === 'direct' && (r.kind === 'ok' || r.kind === 'upstream_error')))) {
      await closeEpisode(env, 'auto', log)
    }
    await flushBanTally(env)
  } catch (e) {
    log?.warn('ban.note_failed', { error: e instanceof Error ? e.message : String(e) })
  }
}

/** Reconcile after an explicit forwarder probe (admin button or the cron's hourly check). */
export async function recordProbe(env: BanEnv, probe: HomeProxyProbe, by: 'probe' | 'manual', log?: Logger): Promise<{ home: HomeBan | null; cleared: boolean }> {
  const home = await getHomeBan(env)
  if (probe.probe === 'ok') {
    if (home && !home.simulated) {
      await closeEpisode(env, by === 'manual' ? 'manual' : 'probe', log)
      return { home: null, cleared: true }
    }
    if (!home) await clearPause(env, log)
    return { home, cleared: false }
  }
  if (probe.probe === 'ip_blocked') {
    const until = probe.direct?.blockedUntil ?? null
    const ip = probe.blockedIp ?? probe.direct?.blockedIp ?? null
    if (!home) {
      const opened = await openEpisode(env, { ip, source: 'probe', until, viaPool: (probe.poolHealthy ?? 0) > 0, poolHealthy: probe.poolHealthy ?? null, poolTotal: probe.poolTotal ?? null }, log)
      return { home: opened, cleared: false }
    }
    const updated = await updateHomeBan(env, home, { until, ip: home.ip ?? ip, poolHealthy: probe.poolHealthy ?? home.poolHealthy, poolTotal: probe.poolTotal ?? home.poolTotal })
    return { home: updated, cleared: false }
  }
  return { home, cleared: false }
}

/** Fold the in-isolate counters into the open episode (rate-limited unless `force`). */
export async function flushBanTally(env: BanEnv, force = false): Promise<void> {
  if (tally.pool === 0 && tally.brightdata === 0 && tally.allBlocked === 0) return
  if (!force && Date.now() - tally.lastFlushAt < FLUSH_INTERVAL_MS) return
  const home = await getHomeBan(env)
  const pool = tally.pool
  const bd = tally.brightdata
  const ab = tally.allBlocked
  tally.pool = 0
  tally.brightdata = 0
  tally.allBlocked = 0
  tally.lastFlushAt = Date.now()
  if (!home) return
  const ep = await getEpisode(env, home.episodeKey)
  if (!ep) return
  ep.poolRequests += pool
  ep.brightdataRequests += bd
  ep.allBlockedHits += ab
  await putEpisode(env, ep).catch(() => {})
}

/**
 * Cron hook: when an episode is open but nothing has fetched since the
 * forwarder's cooldown lapsed (quiet backlog, night time), nobody would notice
 * the ban lifting. Probe the forwarder ourselves — at most once per cooldown —
 * so the banner and the all-clear push don't wait for the next real fetch.
 */
export async function maintainBanState(env: BanEnv & Pick<Env, 'HOME_PROXY_URL' | 'HOME_PROXY_TOKEN'>, log?: Logger): Promise<void> {
  try {
    await flushBanTally(env, true)
    const home = await getHomeBan(env)
    if (!home || home.simulated) return
    if (!env.HOME_PROXY_URL || !env.HOME_PROXY_TOKEN) return
    const now = Date.now()
    if (home.until && Date.parse(home.until) > now) return
    if (home.lastCronProbeAt && now - Date.parse(home.lastCronProbeAt) < BAN_COOLDOWN_SECONDS * 1000) return
    await updateHomeBan(env, home, { lastCronProbeAt: new Date(now).toISOString() })
    const probe = await probeHomeProxy(env.HOME_PROXY_URL, env.HOME_PROXY_TOKEN)
    const r = await recordProbe(env, probe, 'probe', log)
    log?.info('ban.cron_probe', { probe: probe.probe, status: probe.status ?? null, cleared: r.cleared, blockedIp: probe.blockedIp ?? null })
  } catch (e) {
    log?.warn('ban.cron_probe_failed', { error: e instanceof Error ? e.message : String(e) })
  }
}

// ─── BrightData daily budget ─────────────────────────────────────────────────

export function brightdataCap(env: Pick<Env, 'BRIGHTDATA_DAILY_CAP'>): number {
  const n = Number(env.BRIGHTDATA_DAILY_CAP)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_BRIGHTDATA_DAILY_CAP
}

const utcDay = (d = new Date()) => d.toISOString().slice(0, 10)

export async function brightdataUsage(env: BanEnv): Promise<BrightdataUsage> {
  const date = utcDay()
  const used = Number((await env.CACHE.get(`${BRIGHTDATA_PREFIX}${date}`)) ?? 0) || 0
  const cap = brightdataCap(env)
  return { date, used, cap, remaining: Math.max(0, cap - used) }
}

/**
 * Reserve one BrightData request against today's cap. Returns false (and
 * makes no call) when the cap is spent. The counter is a plain KV integer:
 * a concurrent double-count under-charges by one at worst.
 */
export async function tryConsumeBrightdata(env: BanEnv, log?: Logger): Promise<{ ok: boolean; usage: BrightdataUsage }> {
  const usage = await brightdataUsage(env)
  if (usage.used >= usage.cap) {
    log?.warn('brightdata.budget_exhausted', { ...usage })
    return { ok: false, usage }
  }
  try {
    await env.CACHE.put(`${BRIGHTDATA_PREFIX}${usage.date}`, String(usage.used + 1), { expirationTtl: BRIGHTDATA_TTL_SECONDS })
  } catch (e) {
    log?.warn('brightdata.budget_write_failed', { error: e instanceof Error ? e.message : String(e) })
  }
  tally.brightdata++
  return { ok: true, usage: { ...usage, used: usage.used + 1, remaining: Math.max(0, usage.cap - usage.used - 1) } }
}

// ─── Admin surface ───────────────────────────────────────────────────────────

export async function getBanStatus(env: BanEnv, episodeLimit = 10): Promise<BanStatus> {
  const [home, pause, brightdata, episodes] = await Promise.all([getHomeBan(env), getPause(env), brightdataUsage(env), listEpisodes(env, episodeLimit)])
  return { now: nowIso(), home, pause, brightdata, episodes, pushConfigured: pushConfigured(env as Env) }
}

/** Admin test hook: open a fake episode (banner + push) that only a manual clear ends. */
export async function simulateBan(env: BanEnv, log?: Logger): Promise<HomeBan> {
  return openEpisode(env, { ip: null, source: 'simulated', until: new Date(Date.now() + BAN_COOLDOWN_SECONDS * 1000).toISOString(), viaPool: true, simulated: true }, log)
}

/** Admin: end the open episode by hand (also used to dismiss a simulated one). */
export async function manualClear(env: BanEnv, log?: Logger): Promise<BanEpisode | null> {
  const ep = await closeEpisode(env, 'manual', log)
  await clearPause(env, log)
  return ep
}

/** Test helper: reset the in-isolate tally between vitest cases. */
export function _resetTallyForTests(): void {
  tally.pool = 0
  tally.brightdata = 0
  tally.allBlocked = 0
  tally.lastFlushAt = 0
  pauseMemo = null
}
