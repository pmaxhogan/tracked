/**
 * Pause / ban state for the 1001tracklists fetch path, in the CACHE KV.
 *
 *   - `ban:pause` is the MASTER SWITCH: while it is set (and its `until` is in
 *     the future) lib/upstream1001.ts fetches nothing and the scheduler tick
 *     does nothing. The orchestrator sets and lifts it; the admin page's
 *     "clear" button lifts it too.
 *   - `ban:home` + `ban:ep:<invTs>` are the admin banner and its history
 *     (an episode opened by hand or by the "simulate" test hook), with a Web
 *     Push when one starts and ends.
 *
 * Until 2026-09-29 this module also turned the home forwarder's X-Proxy-*
 * reports into episodes and kept Bright Data's daily budget. Both routes are
 * gone: tlpool (lib/pool.ts) owns blocks, budgets and captchas now.
 *
 * All writes are best-effort: a KV hiccup here must never fail a fetch.
 */

import type { Env } from '../types'
import { invertedTs } from './cache'
import type { Logger } from './log'
import { banClearPayload, banStartPayload, pushConfigured, sendPushToAll } from './web-push'

/** Default length of a pause set through `setPause` (and of a simulated episode). */
export const BAN_COOLDOWN_SECONDS = 60 * 60

const HOME_KEY = 'ban:home'
const PAUSE_KEY = 'ban:pause'
const EPISODE_PREFIX = 'ban:ep:'
const EPISODE_TTL_SECONDS = 180 * 24 * 60 * 60

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
  /** Free text: 'manual', 'simulated', or whatever the orchestrator wrote. */
  reason: string
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
  /** Legacy counters from the forwarder era; always 0 on new episodes. */
  poolRequests: number
  brightdataRequests: number
  allBlockedHits: number
  clearedBy: 'auto' | 'probe' | 'manual' | null
  pushStart: { sent: number; total: number } | null
  pushClear: { sent: number; total: number } | null
}

export type BanStatus = {
  now: string
  home: HomeBan | null
  pause: Pause | null
  episodes: BanEpisode[]
  pushConfigured: boolean
}

type Kv = Pick<KVNamespace, 'get' | 'put' | 'delete' | 'list'>
type BanEnv = Pick<Env, 'CACHE' | 'SUBS' | 'VAPID_PUBLIC_KEY' | 'VAPID_PRIVATE_KEY' | 'VAPID_SUBJECT'>

const nowIso = () => new Date().toISOString()

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

export async function getPause(env: Pick<Env, 'CACHE'>): Promise<Pause | null> {
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
export async function isPaused(env: Pick<Env, 'CACHE'>): Promise<Pause | null> {
  if (pauseMemo && Date.now() - pauseMemo.at < 5000) return pauseMemo.value
  const value = await getPause(env)
  pauseMemo = { at: Date.now(), value }
  return value
}

export async function setPause(env: Pick<Env, 'CACHE'>, reason: Pause['reason'], ip: string | null, log?: Logger): Promise<Pause> {
  const existing = await getPause(env)
  if (existing) return existing
  const since = nowIso()
  const pause: Pause = { since, until: new Date(Date.now() + BAN_COOLDOWN_SECONDS * 1000).toISOString(), reason, ip }
  await putJson(env.CACHE, PAUSE_KEY, pause, BAN_COOLDOWN_SECONDS + 60)
  pauseMemo = { at: Date.now(), value: pause }
  log?.warn('ban.pause_set', { ...pause })
  return pause
}

export async function clearPause(env: Pick<Env, 'CACHE'>, log?: Logger): Promise<boolean> {
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
    const push = await sendPushToAll(env as unknown as Env, banStartPayload(info.ip, info.viaPool), log)
    episode.pushStart = { sent: push.sent, total: push.total }
    await putEpisode(env, episode)
  } catch (e) {
    log?.warn('ban.push_start_failed', { error: e instanceof Error ? e.message : String(e) })
  }
  return home
}

/**
 * End the open episode: stamp it, drop `ban:home` and any pause, fire the
 * "cleared" push. Returns the closed episode, or null if none was open.
 */
export async function closeEpisode(env: BanEnv, clearedBy: NonNullable<BanEpisode['clearedBy']>, log?: Logger): Promise<BanEpisode | null> {
  const home = await getHomeBan(env)
  if (!home) return null
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
    const push = await sendPushToAll(env as unknown as Env, banClearPayload(ep.ip, ep.blockedForMs), log)
    ep.pushClear = { sent: push.sent, total: push.total }
    await putEpisode(env, ep)
  } catch (e) {
    log?.warn('ban.push_clear_failed', { error: e instanceof Error ? e.message : String(e) })
  }
  return ep
}

// ─── Admin surface ───────────────────────────────────────────────────────────

export async function getBanStatus(env: BanEnv, episodeLimit = 10): Promise<BanStatus> {
  const [home, pause, episodes] = await Promise.all([getHomeBan(env), getPause(env), listEpisodes(env, episodeLimit)])
  return { now: nowIso(), home, pause, episodes, pushConfigured: pushConfigured(env as unknown as Env) }
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

/** Test helper: forget the memoised pause between vitest cases. */
export function _resetTallyForTests(): void {
  pauseMemo = null
}
