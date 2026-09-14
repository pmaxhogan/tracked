/**
 * Sync orchestrator: for each subscribed DJ, scrape their 1001tracklists DJ
 * page, discover sets that have a YouTube video, and add those videos to a
 * playlist named "<artist> (1001tklists)" on the connected YouTube account.
 * Every video also gets mirrored into a single combined playlist holding all
 * tracked artists (see lib/combined-playlist.ts).
 *
 * Runs from two triggers (both gated by Cloudflare Access at the route level):
 *   - Cron (`scheduled` worker handler) — daily sweep of every subscription.
 *   - Manual POST `/subscriptions/api/sync[/<slug>]` — opportunistic single
 *     run, used for the initial backfill when a subscription is added.
 *
 * **Idempotency contract.** A run may be killed mid-way (CPU limit, transient
 * error, redeploy) and re-running must never duplicate videos in the
 * playlist. Two layers protect against this:
 *
 *   1. Per-sub KV state remembers every tracklist URL we've fully *resolved*
 *      (i.e. attempted to extract a video id from), so the next run skips it.
 *   2. We list the playlist's current video ids on every run and dedupe
 *      against that, so even with a wiped state we don't re-insert.
 *
 * **Recheck contract.** A set's YouTube recording on 1001tracklists is not
 * final: the first video attached is often a phone recording, replaced by an
 * official upload days later. So "resolved" is not "done" — every processed
 * tracklist is re-fetched once its record in `state.tracklistVideos` is older
 * than `RECHECK_INTERVAL_SECONDS`. A recheck compares the video the page has
 * now against the one recorded then:
 *   - same video, or the page lost its video → nothing changes (a set that
 *     drops its recording keeps the one already in the playlist)
 *   - the set had none and now has one → added, as on first processing
 *   - a different video → the old one is removed from the artist playlist and
 *     the combined playlist (unless another set still resolves to it) and the
 *     new one inserted. New is always taken to be strictly better.
 *   - no recorded baseline (processed before rechecks existed, no audit row
 *     survived to seed one) → the recheck only records what the page has now.
 *     It never re-adds, because we can't tell "never added" from "the user
 *     removed it by hand", and the second must stick.
 * Rechecks that change nothing write no audit row — see lib/playlist-audit.ts.
 *
 * **Quota contract.** Caps `maxSetsPerRun` (default 30) per subscription per
 * run to keep Bright Data spend and YouTube quota bounded. New subscriptions
 * with deep histories backfill across multiple cron ticks; users who want
 * "now" can hit the manual sync endpoint repeatedly.
 */

import type { Env } from '../types'
import { listSubscriptions, djUrlFor, type Subscription } from './subscriptions'
import { crawlDjIndex, fetch1001Html, parseSetYouTubeId, youtubeFingerprint } from './dj-index'
import { fetchOptsFromEnv, isStopTheBatchError, UpstreamPausedError, UpstreamUnavailableError } from './upstream1001'
import { flushBanTally, isPaused } from './ban-state'
import { fetchHomeProxyStatus } from './homeProxy'

import { getAccessToken } from './google-oauth'
import {
  addVideoToPlaylist,
  isPermanentInsertError,
  isQuotaError,
  PlaylistNotFoundError,
  removeVideoFromPlaylist,
} from './youtube-playlists'
import {
  cachePlaylistVideoIds,
  findOrCreatePlaylist,
  getCachedPlaylistVideoIds,
  invalidatePlaylistVideoIds,
} from './playlist-cache'
import {
  addToCombined,
  flushCombined,
  loadCombinedState,
  markVideosUnavailable,
  mergeIntoCombinedPlaylist,
  openCombinedPlaylist,
  readCombinedStatus,
  removeFromCombined,
  type CombinedAdditionStatus,
  type CombinedHandle,
  type CombinedMergeResult,
  type CombinedStatus,
  type PlaylistSource,
} from './combined-playlist'
import { makeLogger, errorFields, type Logger } from './log'
import { parseTracklist } from './tracklists1001'
import { enqueueMkvidRequest, extractSetAudioSource, extractSetDate, extractSetTitle, lastCueSeconds, supersedeMkvidRequestForSet } from './mkvid'
import {
  failureRowsSince,
  flushPlaylistAdditions,
  latestAdditionPerSet,
  type PlaylistAdditionRecord,
  type PlaylistAdditionStatus,
} from './playlist-audit'
import {
  invalidateSubTracklists,
  listSubSync,
  loadSubState,
  requeueTracklists,
  saveSubState,
  slugsReferencingVideo,
  subWorkCounts,
  type SubState,
  type TracklistVideo,
} from './sync-store'

// The state shape and its D1 persistence live in lib/sync-store.ts; re-exported
// so callers (routes, tests) keep importing them from here.
export { loadSubState, saveSubState, type SubState, type TracklistVideo }

/** Human label for why a batch stopped early (surfaces as the sub's lastError). */
function stopReasonFor(e: unknown): string {
  if (e instanceof UpstreamPausedError) return `paused: ${e.message}`
  if (e instanceof UpstreamUnavailableError) return `unavailable: ${e.message}`
  return `ip_blocked: ${e instanceof Error ? e.message : String(e)}`
}

const PLAYLIST_TITLE_SUFFIX = ' (1001tklists)'
const watchUrl = (videoId: string) => `https://www.youtube.com/watch?v=${videoId}`
const playlistDescription = (artistName: string) =>
  `Every set ${artistName} has a YouTube recording for on 1001tracklists.`
// Per-set scrape via home proxy is ~250 ms; via BrightData ~3–4 s. 30 sets
// fits in ~8 s home-proxy / 25 s BrightData (deadline-bound either way).
// Big enough that a 145-set first-time backfill is ~5 cron ticks instead
// of 15, but small enough to keep YouTube quota usage bounded — at 50
// quota per insert, 30 inserts × 4 subs = 6 000 of the daily 10 000.
const DEFAULT_MAX_SETS_PER_RUN = 30
// AJAX pagination hops are ~30 ms each (the endpoint is JSON, not a CF-gated
// page), so 100 pages costs ~3 s of the 25 s sync deadline. End-of-list is
// signaled explicitly by `end:true` from 1001tl and almost always fires
// first; this cap is just a safety net for a DJ with a wildly deep history.
const DEFAULT_MAX_DJ_PAGES = 100
// Hard wall-clock deadline so we save state and return cleanly before
// Cloudflare kills the worker. Workers' fetch event budget is ~30 s; we
// leave headroom for network I/O on the response itself.
const SYNC_DEADLINE_MS = 25_000
/**
 * How long a processed tracklist's resolved video is trusted before the set
 * page is fetched again to see whether 1001tracklists swapped the recording.
 * Five days: official uploads typically land within a week of the phone
 * recording, and at ~150 sets per DJ this is ~30 re-fetches per DJ per day,
 * trickled through the 5-minute cron.
 */
export const RECHECK_INTERVAL_SECONDS = 5 * 24 * 60 * 60
// Rechecks are cheaper than first-time processing (a changed video is rare,
// so almost none of them touch the YouTube API), but each is still a page
// fetch through the home proxy / BrightData. Bounded per run so a mass
// invalidation drains over a few ticks instead of hammering 1001tracklists.
const DEFAULT_MAX_RECHECKS_PER_RUN = 20
const nowSeconds = () => Math.floor(Date.now() / 1000)

/** Tracklists discovered but never processed (and not given up on). */
export function pendingTracklistUrls(state: SubState): string[] {
  const processed = new Set(state.processedTracklistUrls)
  const abandoned = new Set(state.abandonedTracklistUrls ?? [])
  return (state.discoveredTracklistUrls ?? []).filter((u) => !processed.has(u) && !abandoned.has(u))
}

/**
 * Processed tracklists whose recorded video is older than the recheck
 * interval (or that have no record at all). Order follows
 * `processedTracklistUrls`, which is discovery order — newest sets first —
 * so the sets most likely to have had their recording swapped are rechecked
 * first when the per-run cap binds.
 */
export function dueRecheckUrls(
  processed: Iterable<string>,
  abandoned: ReadonlySet<string>,
  tracklistVideos: Record<string, TracklistVideo>,
  now = nowSeconds(),
): string[] {
  const out: string[] = []
  for (const u of processed) {
    if (abandoned.has(u)) continue
    const entry = tracklistVideos[u]
    if (!entry || now - entry.checkedAt >= RECHECK_INTERVAL_SECONDS) out.push(u)
  }
  return out
}

export function dueRechecks(state: SubState, now = nowSeconds()): string[] {
  return dueRecheckUrls(
    state.processedTracklistUrls,
    new Set(state.abandonedTracklistUrls ?? []),
    state.tracklistVideos ?? {},
    now,
  )
}

const ABANDON_AFTER_FAILURES = 3

/**
 * Whether the whole run should stand down before touching 1001tracklists:
 * every route was blocked within the last hour. Logged once per run; the
 * per-set loop never even starts, so nothing gets charged a failure.
 */
async function pausedForRun(env: Env, log: Logger, task: string): Promise<boolean> {
  const pause = await isPaused(env)
  if (!pause) return false
  log.warn(`${task}.paused`, { until: pause.until, reason: pause.reason, since: pause.since })
  return true
}

export type SyncOpts = {
  log?: Logger
  /** Cap how many *new* tracklist pages we fetch+process for this sub. */
  maxSetsPerRun?: number
  /**
   * Skip the DJ-page crawl entirely and process pending tracklists from
   * `state.discoveredTracklistUrls`. Used by the frequent "drain pending"
   * cron — we don't need to re-discover new sets on every 5-minute tick
   * (the daily 06:00 UTC cron does that), and skipping the crawl saves
   * the BrightData/home-proxy round-trip + ~14 AJAX hops per sub.
   */
  skipDjCrawl?: boolean
  /** Cap how many already-processed tracklists we re-fetch to look for a swapped video. */
  maxRechecksPerRun?: number
  /**
   * What kicked off this run (`cron.daily`, `cron.pending`, `manual.all`,
   * `manual.one`, `manual.resync`). Recorded on every playlist-addition audit
   * row so the panel can tell a cron sweep's work apart from a button press.
   */
  trigger?: string
  /**
   * Shared, mutable budget of 1001tracklists page fetches for this whole run
   * (all subs). Each set fetch / recheck decrements it; when it hits zero the
   * loops stop and the remaining work waits for the next tick. This is the
   * pacing that keeps the account under 1001tl's rate limit — the 2026-09-10
   * resync drove ~360 fetches in 11 minutes and got the account banned.
   * `syncAll`/`syncPendingOnly` create one from `TL_FETCHES_PER_TICK`.
   */
  fetchBudget?: FetchBudget
}

export type FetchBudget = { remaining: number; limit: number; spent: number; perAccount: number; accounts: number }

export const DEFAULT_TL_FETCHES_PER_TICK = 20

/**
 * One tick's worth of 1001tl page fetches: `TL_FETCHES_PER_TICK` (default 20)
 * *per healthy account* on the forwarder. Three healthy accounts → 60 a tick;
 * one parked → 40, automatically. 1001tl's limit is per account, so this keeps
 * each account at the same rate no matter how many there are.
 */
export function newFetchBudget(env: Env, healthyAccounts = 1): FetchBudget {
  const raw = Number(env.TL_FETCHES_PER_TICK)
  const perAccount = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_TL_FETCHES_PER_TICK
  const accounts = Math.max(1, Math.floor(healthyAccounts) || 1)
  const limit = perAccount * accounts
  return { remaining: limit, limit, spent: 0, perAccount, accounts }
}

/**
 * How many 1001tl accounts the forwarder can serve from right now, read from
 * its /status once per tick. Anything short of a clear answer — no forwarder
 * configured, unreachable, old forwarder without accounts — is treated as 1
 * (the pre-multi-account throughput), never more.
 */
export async function healthyAccountCount(env: Env, log: Logger): Promise<number> {
  if (!env.HOME_PROXY_URL || !env.HOME_PROXY_TOKEN) return 1
  try {
    const st = await fetchHomeProxyStatus(env.HOME_PROXY_URL, env.HOME_PROXY_TOKEN)
    const n = typeof st.accountsHealthy === 'number' ? st.accountsHealthy : 1
    log.info('sync.forwarder_accounts', { accountsHealthy: st.accountsHealthy ?? null, accountsTotal: st.accountsTotal ?? null, poolHealthy: st.poolHealthy ?? null })
    return Math.max(1, n)
  } catch (e) {
    log.warn('sync.forwarder_status_unavailable', { ...errorFields(e) })
    return 1
  }
}

/** Take one fetch from the budget; false when it is spent. */
function takeFetch(budget: FetchBudget | undefined): boolean {
  if (!budget) return true
  if (budget.remaining <= 0) return false
  budget.remaining -= 1
  budget.spent += 1
  return true
}

/** Oldest-synced first, so a budget that runs out mid-tick starves nobody. */
export function orderByLastRun<T extends { slug: string }>(subs: T[], lastRunAt: Map<string, number | null | undefined>): T[] {
  return [...subs].sort((a, b) => (lastRunAt.get(a.slug) ?? 0) - (lastRunAt.get(b.slug) ?? 0))
}

/** `slug → lastRunAt` for every sub with a sync row, from one D1 query. */
async function lastRunMap(env: Env): Promise<Map<string, number | null | undefined>> {
  return new Map((await listSubSync(env)).map((s) => [s.slug, s.lastRunAt] as const))
}

export type SyncOneResult = {
  slug: string
  ok: boolean
  error?: string
  artistName: string
  playlistId?: string
  /** The combined all-artists playlist, when this run touched it. */
  combinedPlaylistId?: string
  stats: {
    tracklistsSeen: number
    tracklistsProcessed: number
    videoIdsFound: number
    videoIdsAdded: number
    /** Tracklists discovered on the DJ page but not yet processed (cap or
     *  per-set failure). Run sync again to chip away at them. */
    tracklistsPending: number
    /** Videos this run mirrored into the combined all-artists playlist. */
    combinedVideoIdsAdded: number
    /** Already-processed tracklists re-fetched this run to look for a swapped video. */
    tracklistsRechecked: number
    /** Rechecks that found a different video: old removed, new inserted. */
    videosReplaced: number
    /** Processed tracklists still due for a recheck after this run. */
    rechecksPending: number
  }
}

const EMPTY_STATS: SyncOneResult['stats'] = {
  tracklistsSeen: 0,
  tracklistsProcessed: 0,
  videoIdsFound: 0,
  videoIdsAdded: 0,
  tracklistsPending: 0,
  combinedVideoIdsAdded: 0,
  tracklistsRechecked: 0,
  videosReplaced: 0,
  rechecksPending: 0,
}

/**
 * Sync every subscription. Errors per sub are isolated (logged + surfaced in
 * the result, but don't kill the rest of the sweep). A missing OAuth
 * connection or missing CACHE/SUBS bindings is a global failure.
 */
export async function syncAll(env: Env, opts: SyncOpts = {}): Promise<{ results: SyncOneResult[]; paused?: boolean }> {
  const log = opts.log ?? makeLogger({ task: 'sync.all' })
  const tokenInfo = await getAccessToken(env)
  if (!tokenInfo) {
    log.error('sync.no_oauth_tokens')
    throw new Error('YouTube account not connected — visit /subscriptions/oauth/start first')
  }
  const allSubs = await listSubscriptions(env)
  const subs = orderByLastRun(allSubs, await lastRunMap(env))
  const fetchBudget = opts.fetchBudget ?? newFetchBudget(env, await healthyAccountCount(env, log))
  log.info('sync.start', { subCount: subs.length, fetchBudget: fetchBudget.limit, perAccount: fetchBudget.perAccount, accounts: fetchBudget.accounts })
  const results: SyncOneResult[] = []
  if (await pausedForRun(env, log, 'sync')) return { results, paused: true }
  for (const sub of subs) {
    if (fetchBudget.remaining <= 0) {
      log.info('sync.fetch_budget_exhausted', { slug: sub.slug, spent: fetchBudget.spent, limit: fetchBudget.limit, subsLeft: subs.length - results.length })
      break
    }
    try {
      const r = await syncOne(env, sub, tokenInfo.accessToken, { ...opts, fetchBudget })
      results.push(r)
    } catch (e) {
      log.error('sync.sub_threw', { slug: sub.slug, ...errorFields(e) })
      results.push({
        slug: sub.slug,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        artistName: sub.slug,
        stats: { ...EMPTY_STATS },
      })
    }
  }
  log.info('sync.done', {
    subCount: subs.length,
    okCount: results.filter((r) => r.ok).length,
    totalNewVideos: results.reduce((a, r) => a + r.stats.videoIdsAdded, 0),
    fetchesSpent: fetchBudget.spent,
    fetchBudget: fetchBudget.limit,
  })
  await flushBanTally(env, true)
  return { results }
}

/**
 * The fetch budget a manual run (panel button) gets: sized exactly like the
 * cron's, `TL_FETCHES_PER_TICK` per account the forwarder reports healthy.
 * Every entry point that calls syncOne outside the cron must pass one —
 * without a budget takeFetch() always says yes.
 */
export async function manualFetchBudget(env: Env, log: Logger): Promise<FetchBudget> {
  return newFetchBudget(env, await healthyAccountCount(env, log))
}

/**
 * "Invalidate video cache & resync all": every DJ's processed sets are marked
 * due now (see invalidateVideoCache), then ONE sync pass runs over all of them
 * with a single shared fetch budget. Until 2026-09-14 the panel did this by
 * calling the per-DJ resync once per row from the browser, and each of those
 * calls ran unpaced — ~360 fetches in 11 minutes on 2026-09-10, ~40 in 16 s
 * on 2026-09-14, a 429 on every account both times. The pass stops when the
 * budget is spent; the 5-minute cron drains the remaining rechecks.
 */
export async function resyncAll(
  env: Env,
  opts: SyncOpts = {},
): Promise<{ results: SyncOneResult[]; paused?: boolean; invalidated: InvalidateResult[] }> {
  const log = opts.log ?? makeLogger({ task: 'sync.resync_all' })
  const subs = await listSubscriptions(env)
  const invalidated: InvalidateResult[] = []
  for (const sub of subs) invalidated.push(await invalidateVideoCache(env, sub.slug, log))
  log.info('sync.resync_all.invalidated', { subCount: subs.length, tracklistsMarked: invalidated.reduce((a, r) => a + r.tracklistsMarked, 0) })
  const fetchBudget = opts.fetchBudget ?? (await manualFetchBudget(env, log))
  const r = await syncAll(env, { ...opts, log, trigger: opts.trigger ?? 'manual.resync', fetchBudget })
  return { ...r, invalidated }
}

/**
 * Drain pending tracklists across every subscription without re-discovering
 * new sets. Used by the frequent (every-N-min) cron to chip away at large
 * backfills — manual sync handles only one batch, this handler keeps going
 * automatically until pending hits zero. The same tick also drains due
 * rechecks (processed sets whose video record is older than
 * `RECHECK_INTERVAL_SECONDS`), which is how the 5-day re-fetch cadence is
 * actually met: the daily sync alone would fall behind on a deep catalogue.
 *
 * Subs with nothing pending, nothing due, or no prior discovery state are
 * skipped; the daily 06:00 UTC sync handles initial discovery for them.
 */
export async function syncPendingOnly(env: Env, opts: SyncOpts = {}): Promise<{ results: SyncOneResult[]; paused?: boolean }> {
  const log = opts.log ?? makeLogger({ task: 'sync.pending' })
  if (await pausedForRun(env, log, 'sync.pending')) return { results: [], paused: true }
  const subs = await listSubscriptions(env)
  // One aggregate query instead of hydrating every DJ's state: a sub is a
  // candidate when it has unprocessed sets or processed sets whose record is
  // older than the recheck interval (or has none).
  const counts = new Map((await subWorkCounts(env, RECHECK_INTERVAL_SECONDS)).map((c) => [c.slug, c] as const))
  const unordered: Subscription[] = subs.filter((sub) => {
    const c = counts.get(sub.slug)
    return !!c && (c.pending > 0 || c.due > 0)
  })
  const candidates = orderByLastRun(unordered, await lastRunMap(env))
  if (candidates.length === 0) {
    log.info('sync.pending.nothing_to_do', { totalSubs: subs.length })
    return { results: [] }
  }
  const fetchBudget = opts.fetchBudget ?? newFetchBudget(env, await healthyAccountCount(env, log))
  log.info('sync.pending.start', { totalSubs: subs.length, candidatesWithPending: candidates.length, fetchBudget: fetchBudget.limit, perAccount: fetchBudget.perAccount, accounts: fetchBudget.accounts })
  const tokenInfo = await getAccessToken(env)
  if (!tokenInfo) {
    log.error('sync.pending.no_oauth_tokens')
    throw new Error('YouTube account not connected')
  }
  const results: SyncOneResult[] = []
  for (const sub of candidates) {
    if (fetchBudget.remaining <= 0) {
      log.info('sync.fetch_budget_exhausted', { slug: sub.slug, spent: fetchBudget.spent, limit: fetchBudget.limit, candidatesLeft: candidates.length - results.length })
      break
    }
    try {
      const r = await syncOne(env, sub, tokenInfo.accessToken, { ...opts, skipDjCrawl: true, fetchBudget })
      results.push(r)
    } catch (e) {
      log.error('sync.pending.sub_threw', { slug: sub.slug, ...errorFields(e) })
    }
  }
  log.info('sync.pending.done', {
    candidatesProcessed: results.length,
    candidatesWithPending: candidates.length,
    fetchesSpent: fetchBudget.spent,
    fetchBudget: fetchBudget.limit,
    totalAdded: results.reduce((a, r) => a + r.stats.videoIdsAdded, 0),
    totalStillPending: results.reduce((a, r) => a + r.stats.tracklistsPending, 0),
    totalRechecked: results.reduce((a, r) => a + r.stats.tracklistsRechecked, 0),
    totalReplaced: results.reduce((a, r) => a + r.stats.videosReplaced, 0),
    totalRechecksPending: results.reduce((a, r) => a + r.stats.rechecksPending, 0),
  })
  await flushBanTally(env, true)
  return { results }
}

// ─── Combined "all tracked artists" playlist ────────────────────────────────

/**
 * The artist playlists that feed the combined one: every subscription that has
 * been synced at least once (an unsynced sub has no playlist yet, and nothing
 * to contribute). Order follows the subscription list so a capped backfill
 * makes deterministic progress.
 */
export async function collectCombinedSources(env: Env): Promise<PlaylistSource[]> {
  const subs = await listSubscriptions(env)
  const syncRows = new Map((await listSubSync(env)).map((s) => [s.slug, s] as const))
  const sources: PlaylistSource[] = []
  for (const sub of subs) {
    const s = syncRows.get(sub.slug)
    if (!s?.playlistId) continue
    sources.push({ slug: sub.slug, artistName: s.artistName ?? null, playlistId: s.playlistId })
  }
  return sources
}

export type CombinedBackfillResult =
  | ({ ok: true } & CombinedMergeResult)
  | { ok: false; reason: 'youtube_not_connected' | 'no_sources' }

/**
 * Reconcile the combined playlist against every artist playlist, inserting
 * whatever it's missing (bounded — see lib/combined-playlist.ts). This is the
 * path that backfills sets which predate the combined playlist and sets a
 * newly added artist accumulates in their own playlist over several ticks.
 *
 * Skips rather than throws when there's nothing to work with, so the
 * every-5-min cron can call it unconditionally.
 */
export async function backfillCombined(
  env: Env,
  opts: { log?: Logger; maxInsertsPerRun?: number; deadlineMs?: number; trigger?: string } = {},
): Promise<CombinedBackfillResult> {
  const log = opts.log ?? makeLogger({ task: 'sync.combined_backfill' })
  const tokenInfo = await getAccessToken(env)
  if (!tokenInfo) {
    log.info('combined.skip_no_oauth')
    return { ok: false, reason: 'youtube_not_connected' }
  }
  const sources = await collectCombinedSources(env)
  if (sources.length === 0) {
    // Nothing has been synced yet — don't create an empty playlist for it.
    log.info('combined.skip_no_sources')
    return { ok: false, reason: 'no_sources' }
  }
  const merged = await mergeIntoCombinedPlaylist(env, tokenInfo.accessToken, sources, {
    log,
    maxInsertsPerRun: opts.maxInsertsPerRun,
    deadlineMs: opts.deadlineMs,
    trigger: opts.trigger,
  })
  return { ok: true, ...merged }
}

/** Read-only combined-playlist summary for the admin panel. */
export async function combinedPlaylistStatus(
  env: Env,
  opts: { log?: Logger } = {},
): Promise<{ connected: false } | ({ connected: true } & CombinedStatus)> {
  const log = opts.log ?? makeLogger({ task: 'sync.combined_status' })
  const tokenInfo = await getAccessToken(env)
  if (!tokenInfo) return { connected: false }
  const sources = await collectCombinedSources(env)
  const status = await readCombinedStatus(env, tokenInfo.accessToken, sources, log)
  return { connected: true, ...status }
}

/**
 * Sync a single subscription. Public for the manual `/api/sync/<slug>`
 * endpoint; `syncAll` calls this for each sub.
 */
export async function syncOne(
  env: Env,
  sub: Subscription,
  accessToken: string,
  opts: SyncOpts = {},
): Promise<SyncOneResult> {
  const log = opts.log ?? makeLogger({ task: 'sync.one', slug: sub.slug })
  const maxSets = opts.maxSetsPerRun ?? DEFAULT_MAX_SETS_PER_RUN
  const maxRechecks = opts.maxRechecksPerRun ?? DEFAULT_MAX_RECHECKS_PER_RUN
  const deadline = Date.now() + SYNC_DEADLINE_MS
  const loaded = await loadSubState(env, sub.slug, log)
  // A snapshot of what was loaded: the final save diffs against it so only
  // rows this run changed are written. Cloned because the run mutates the
  // loaded maps in place (tracklistVideos in particular).
  const since = loaded ? structuredClone(loaded) : null
  const state: SubState = loaded ?? { processedTracklistUrls: [] }
  // First run on state written before rechecks existed: recover each
  // processed set's video from the audit trail so the first recheck has a
  // baseline to compare against instead of just recording.
  const tracklistVideos: Record<string, TracklistVideo> =
    state.tracklistVideos ??
    (state.processedTracklistUrls.length > 0
      ? await seedTracklistVideosFromAudit(env, sub.slug, new Set(state.processedTracklistUrls), log)
      : {})
  const fetchOpts = fetchOptsFromEnv(env, log)

  // 1. Discover tracklists. Either crawl the DJ index (the fresh-discovery
  // path, used by the daily cron + initial manual syncs) OR skip the crawl
  // entirely and rely on `state.discoveredTracklistUrls` (used by the
  // frequent drain-pending cron — discovery doesn't need to repeat every
  // few minutes, and skipping saves ~14 AJAX hops per sub).
  const discovered = new Set<string>(state.discoveredTracklistUrls ?? [])
  let artistName: string
  if (opts.skipDjCrawl) {
    artistName = state.artistName ?? prettifySlug(sub.slug)
    log.info('sync.skip_crawl', {
      slug: sub.slug,
      artistName,
      tracklistsKnownTotal: discovered.size,
    })
  } else {
    const crawl = await crawlDjIndex(sub.slug, {
      ...fetchOpts,
      maxPages: DEFAULT_MAX_DJ_PAGES,
      deadlineMs: deadline,
    })
    artistName = crawl.artistName ?? state.artistName ?? prettifySlug(sub.slug)
    // Union with previously-discovered URLs — earlier pages may have failed
    // to fetch this run but we don't want to lose them from the todo set.
    for (const u of crawl.tracklistUrls) discovered.add(u)
    log.info('sync.dj_parsed', {
      slug: sub.slug,
      artistName,
      pagesWalked: crawl.pagesWalked,
      stopReason: crawl.stopReason,
      tracklistsSeenThisRun: crawl.tracklistUrls.length,
      tracklistsKnownTotal: discovered.size,
    })
  }

  // 2. Resolve / create the playlist. State first, then YT lookup, then create.
  const playlistTitle = `${artistName}${PLAYLIST_TITLE_SUFFIX}`
  // Empty until step 2 resolves it. Typed as a definite string so the insert
  // and removal closures below don't have to re-narrow it on every call.
  let playlistId: string = state.playlistId ?? ''
  // Track whether the resolution path went through `playlists.insert` so we
  // can skip the immediately-following `playlistItems.list`. YouTube's read
  // API takes a few seconds to see a freshly-created playlist; listing it
  // right away 404s with playlistNotFound even though the id is valid. A
  // newly-created playlist is by definition empty, so the list call is also
  // unnecessary — known-empty is the right baseline.
  let justCreated = false
  if (!playlistId) {
    const r = await resolveArtistPlaylist(playlistTitle, artistName, accessToken, log, sub.slug)
    playlistId = r.id
    justCreated = r.justCreated
  }

  // 3. Existing video ids in the playlist (defense in depth — wiped state mustn't dupe).
  // If the cached playlistId references a playlist the user has since deleted
  // (or that was never visible to this account), the list call 404s with
  // playlistNotFound. Treat that as a state-staleness signal: drop the id,
  // re-resolve by title (or create fresh), and retry — skipping the list
  // again if recovery created a fresh playlist.
  let existingVideoIds: Set<string>
  if (justCreated) {
    existingVideoIds = new Set()
    await cachePlaylistVideoIds(env, playlistId, existingVideoIds)
  } else {
    try {
      existingVideoIds = await getCachedPlaylistVideoIds(env, playlistId, accessToken, log)
    } catch (e) {
      if (e instanceof PlaylistNotFoundError) {
        log.warn('sync.playlist_stale', { slug: sub.slug, stalePlaylistId: playlistId })
        const r = await resolveArtistPlaylist(playlistTitle, artistName, accessToken, log, sub.slug)
        playlistId = r.id
        if (r.justCreated) {
          existingVideoIds = new Set()
          await cachePlaylistVideoIds(env, playlistId, existingVideoIds)
        } else {
          existingVideoIds = await getCachedPlaylistVideoIds(env, playlistId, accessToken, log)
        }
      } else {
        throw e
      }
    }
  }

  // 4. Walk tracklist URLs we haven't already processed. todo is drawn from
  // the cumulative discovery set (state ∪ this-run), excluding both
  // already-processed and previously-abandoned URLs.
  const processed = new Set(state.processedTracklistUrls)
  const abandoned = new Set(state.abandonedTracklistUrls ?? [])
  const failureCounts: Record<string, number> = { ...(state.failureCounts ?? {}) }
  const allUrls = [...discovered]
  const todo = allUrls
    .filter((u) => !processed.has(u) && !abandoned.has(u))
    .slice(0, maxSets)
  log.info('sync.todo_window', {
    slug: sub.slug,
    totalUrls: allUrls.length,
    alreadyProcessed: processed.size,
    abandoned: abandoned.size,
    todoThisRun: todo.length,
    capped: allUrls.length - processed.size - abandoned.size > maxSets,
  })

  let videoIdsFound = 0
  let videoIdsAdded = 0
  let setsProcessed = 0
  let setsAbandonedThisRun = 0
  /** Set when a block/pause stopped the run early; recorded as lastError and skips the recheck window. */
  let stopReason: string | null = null
  let setsRechecked = 0
  let videosReplaced = 0
  // Artist-playlist membership changed (insert or removal) → write the
  // cached id set back at the end.
  let playlistChanged = false
  const viaSeen = new Set<string>()

  // 4b. Live mirror into the combined "all tracked artists" playlist. Opened
  // lazily on the first video we resolve, so a run that finds nothing new
  // costs nothing here. Every failure degrades to a status on the audit row
  // rather than failing the set: the set is already handled for the artist
  // playlist, and the combined backfill re-derives whatever was dropped.
  const combined: { handle: CombinedHandle | null; openFailed: boolean } = { handle: null, openFailed: false }
  const openCombinedOnce = async (): Promise<CombinedHandle | null> => {
    if (combined.handle || combined.openFailed) return combined.handle
    try {
      combined.handle = await openCombinedPlaylist(env, accessToken, log)
    } catch (e) {
      combined.openFailed = true
      log.warn('sync.combined_open_failed', { slug: sub.slug, ...errorFields(e) })
    }
    return combined.handle
  }
  const mirrorToCombined = async (videoId: string): Promise<CombinedAdditionStatus> => {
    const handle = await openCombinedOnce()
    if (!handle) return 'unavailable'
    try {
      const status = await addToCombined(env, handle, videoId, accessToken, log)
      if (status === 'added') {
        log.info('sync.combined_added', { slug: sub.slug, videoId, playlistId: handle.playlistId })
      }
      return status
    } catch (e) {
      log.warn('sync.combined_add_failed', { slug: sub.slug, videoId, ...errorFields(e) })
      // A permanently-uninsertable video (deleted/private) must be recorded,
      // or the combined backfill will retry it every cron tick — 50 quota
      // units per failed attempt, forever.
      if (isPermanentInsertError(e)) {
        await markVideosUnavailable(env, [videoId], log).catch(() => {})
        return 'unavailable'
      }
      return 'failed'
    }
  }

  // One audit row per set we decide an outcome for, surfaced by the admin
  // panel's "Recent playlist additions" view. Buffered here and flushed in a
  // single batch after the loop — see lib/playlist-audit.ts for why.
  const additions: PlaylistAdditionRecord[] = []
  const auditSet = (
    status: PlaylistAdditionStatus,
    setUrl: string,
    fields: Partial<PlaylistAdditionRecord> = {},
  ) => {
    additions.push({
      t: new Date().toISOString(),
      status,
      slug: sub.slug,
      artistName,
      setUrl,
      videoId: null,
      videoUrl: null,
      // Resolved by step 2 — never actually empty here.
      playlistId: playlistId || null,
      playlistTitle,
      combinedStatus: null,
      via: null,
      trigger: opts.trigger ?? null,
      message: null,
      failureCount: null,
      meta: { ms: null },
      ...fields,
    })
  }

  // mkvid bridge (lib/mkvid.ts): a set with no YouTube recording but a
  // SoundCloud / hearthis.at one is queued for mkvid to render + upload. Only
  // while MKVID_TOKEN is configured — the queue is pointless with nobody
  // polling it. Never fails the set: any error here is a warn log and the set
  // is still recorded as `no_youtube` (the next recheck queues it again).
  const mkvidEnabled = !!env.MKVID_TOKEN
  const mkvidRequireFull = /^(1|true|yes)$/i.test(env.MKVID_REQUIRE_FULL_TRACKLIST ?? '')
  const maybeQueueForMkvid = async (setUrl: string, html: string): Promise<string | null> => {
    if (!mkvidEnabled) return null
    try {
      const source = extractSetAudioSource(html)
      if (!source) return null
      const tracks = parseTracklist(setUrl, html).tracks
      // Zero rows is the fingerprint of a captcha shell, not a set — never queue from it.
      if (tracks.length === 0) return null
      const idedCount = tracks.filter((t) => !t.isUnidentified).length
      if (mkvidRequireFull && idedCount < tracks.length) {
        log.info('sync.mkvid_skip_partial', { slug: sub.slug, setUrl, source: source.kind, idedCount, trackCount: tracks.length })
        return `mkvid: not queued, tracklist partial (${idedCount}/${tracks.length} IDed)`
      }
      const r = await enqueueMkvidRequest(env, {
        slug: sub.slug,
        setUrl,
        artistName,
        setTitle: extractSetTitle(html),
        setDate: extractSetDate(setUrl, html),
        source,
        lastCueSeconds: lastCueSeconds(tracks),
        trackCount: tracks.length,
        idedCount,
      })
      log.info('sync.mkvid_queue', { slug: sub.slug, setUrl, source: source.kind, result: r, trackCount: tracks.length, idedCount })
      return r === 'queued' ? `queued for mkvid (${source.kind})` : `mkvid request already exists (${source.kind})`
    } catch (e) {
      log.warn('sync.mkvid_queue_failed', { slug: sub.slug, setUrl, ...errorFields(e) })
      return null
    }
  }
  /** The set gained a real recording: a pending mkvid request has nothing left to do. */
  const supersedeMkvid = async (setUrl: string, videoId: string): Promise<void> => {
    if (!mkvidEnabled) return
    try {
      if (await supersedeMkvidRequestForSet(env, setUrl, videoId)) log.info('sync.mkvid_superseded', { slug: sub.slug, setUrl, videoId })
    } catch (e) {
      log.warn('sync.mkvid_supersede_failed', { slug: sub.slug, setUrl, ...errorFields(e) })
    }
  }

  /**
   * Insert into the artist playlist, recovering once from a playlist deleted
   * mid-run (re-resolve by title, then retry; later iterations pick up the
   * new id). Updates the in-memory membership set and the added counter.
   */
  const addToArtistPlaylist = async (videoId: string): Promise<void> => {
    try {
      await addVideoToPlaylist(playlistId, videoId, accessToken)
    } catch (e) {
      if (!(e instanceof PlaylistNotFoundError)) throw e
      log.warn('sync.playlist_stale_midrun', { slug: sub.slug, stalePlaylistId: playlistId })
      const r = await resolveArtistPlaylist(playlistTitle, artistName, accessToken, log, sub.slug)
      playlistId = r.id
      // Found existing same-titled → list to avoid dupes; freshly created → empty.
      if (r.justCreated) {
        existingVideoIds = new Set()
        await cachePlaylistVideoIds(env, playlistId, existingVideoIds)
      } else {
        existingVideoIds = await getCachedPlaylistVideoIds(env, playlistId, accessToken, log)
      }
      await addVideoToPlaylist(playlistId, videoId, accessToken)
    }
    existingVideoIds.add(videoId)
    videoIdsAdded += 1
    playlistChanged = true
  }

  /** Remove from the artist playlist if it's there. Returns items deleted. */
  const removeFromArtistPlaylist = async (videoId: string): Promise<number> => {
    if (!existingVideoIds.has(videoId)) return 0
    const n = await removeVideoFromPlaylist(playlistId, videoId, accessToken)
    existingVideoIds.delete(videoId)
    playlistChanged = true
    return n
  }

  for (const setUrl of todo) {
    if (Date.now() >= deadline) {
      log.warn('sync.deadline_hit_during_set_loop', {
        slug: sub.slug,
        setsProcessed,
        setsRemainingInWindow: todo.length - setsProcessed,
      })
      break
    }
    if (!takeFetch(opts.fetchBudget)) {
      log.info('sync.set_budget_exhausted', { slug: sub.slug, setsProcessed, setsRemainingInWindow: todo.length - setsProcessed })
      break
    }
    const tSet = Date.now()
    // Remembered outside the try so a failure *after* the page was parsed
    // (typically YouTube rejecting the insert) can still name the video.
    let foundVideoId: string | null = null
    let foundVia: string | null = null
    try {
      const setFetched = await fetch1001Html(setUrl, fetchOpts)
      viaSeen.add(setFetched.via)
      foundVia = setFetched.via
      const videoId = parseSetYouTubeId(setFetched.html)
      foundVideoId = videoId
      if (videoId) {
        videoIdsFound += 1
        if (!existingVideoIds.has(videoId)) {
          await addToArtistPlaylist(videoId)
          log.info('sync.added', { slug: sub.slug, setUrl, videoId, playlistId })
          auditSet('added', setUrl, {
            videoId,
            videoUrl: watchUrl(videoId),
            via: setFetched.via,
            meta: { ms: Date.now() - tSet },
            combinedStatus: await mirrorToCombined(videoId),
          })
        } else {
          log.info('sync.already_in_playlist', { slug: sub.slug, setUrl, videoId })
          // Already in the artist playlist, but possibly not in the combined
          // one (it predates this feature, or a previous mirror failed) — so
          // mirror duplicates too rather than leaning on the backfill.
          auditSet('duplicate', setUrl, {
            videoId,
            videoUrl: watchUrl(videoId),
            via: setFetched.via,
            meta: { ms: Date.now() - tSet },
            combinedStatus: await mirrorToCombined(videoId),
          })
        }
      } else {
        // Diagnostic fingerprint so we can tell at a glance whether the page
        // truly has no YT or whether the parser missed an embed shape.
        log.info('sync.no_youtube_on_set', {
          slug: sub.slug,
          setUrl,
          fingerprint: youtubeFingerprint(setFetched.html),
        })
        const note = await maybeQueueForMkvid(setUrl, setFetched.html)
        auditSet('no_youtube', setUrl, { via: setFetched.via, meta: { ms: Date.now() - tSet }, ...(note ? { message: note } : {}) })
      }
      processed.add(setUrl)
      tracklistVideos[setUrl] = { videoId, checkedAt: nowSeconds() }
      delete failureCounts[setUrl]
      setsProcessed += 1
    } catch (e) {
      if (foundVideoId && isPermanentInsertError(e)) {
        // YouTube itself says this recording cannot be added (deleted, private,
        // region-blocked: 400/403/404 that is not a quota error). No number of
        // retries changes that, so the set is settled now — like a set whose
        // page has no usable recording — instead of costing three ticks. Its
        // dead video id is remembered so the 5-day recheck still notices if
        // 1001tracklists attaches a replacement recording later.
        log.warn('sync.set_video_unavailable', { slug: sub.slug, setUrl, videoId: foundVideoId, ...errorFields(e) })
        auditSet('no_youtube', setUrl, {
          videoId: foundVideoId,
          videoUrl: watchUrl(foundVideoId),
          message: `YouTube rejected ${foundVideoId} as unavailable: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`,
          ...(foundVia ? { via: foundVia } : {}),
          meta: { ms: Date.now() - tSet },
        })
        await markVideosUnavailable(env, [foundVideoId], log).catch(() => {})
        processed.add(setUrl)
        tracklistVideos[setUrl] = { videoId: foundVideoId, checkedAt: nowSeconds() }
        delete failureCounts[setUrl]
        setsProcessed += 1
        continue
      }
      if (isStopTheBatchError(e)) {
        // A block (or a broken route: forwarder down and the paid fallback
        // serving Cloudflare shells) is not the set's fault: every remaining
        // set would fail the same way, and each attempt from a banned IP keeps
        // the ban fresh. Stop the run here, charge nothing, and let the next
        // tick (after the cooldown) pick up exactly where we left off.
        stopReason = stopReasonFor(e)
        log.error('sync.batch_stopped_blocked', { slug: sub.slug, setUrl, setsProcessed, setsRemainingInWindow: todo.length - setsProcessed, ...errorFields(e) })
        break
      }
      // Bump per-URL failure count. After ABANDON_AFTER_FAILURES, give up
      // and mark the URL processed so the cron stops re-attempting it
      // every tick. Blocks and route faults never reach this branch (see
      // above), so a URL is only abandoned for failures that are actually
      // about that URL — a real 404, a page that parses to zero tracks, a
      // Cloudflare shell served while the forwarder itself was healthy.
      const fc = (failureCounts[setUrl] = (failureCounts[setUrl] ?? 0) + 1)
      const abandon = fc >= ABANDON_AFTER_FAILURES
      log.warn('sync.set_failed', { slug: sub.slug, setUrl, failureCount: fc, abandoning: abandon, ...errorFields(e) })
      auditSet(abandon ? 'abandoned' : 'failed', setUrl, {
        message: e instanceof Error ? e.message : String(e),
        failureCount: fc,
        ...(foundVideoId ? { videoId: foundVideoId, videoUrl: watchUrl(foundVideoId) } : {}),
        ...(foundVia ? { via: foundVia } : {}),
        meta: { ms: Date.now() - tSet },
      })
      if (abandon) {
        abandoned.add(setUrl)
        delete failureCounts[setUrl]
        setsAbandonedThisRun += 1
      }
    }
  }

  // 5. Recheck processed tracklists whose recorded video is stale (see the
  // module doc for the contract). Runs after the new-set window so a backfill
  // is never starved by rechecks; the deadline guards both.
  const rechecksDue = dueRecheckUrls(processed, abandoned, tracklistVideos)
  const rechecks = stopReason ? [] : rechecksDue.slice(0, maxRechecks)
  if (rechecksDue.length > 0) {
    log.info('sync.recheck_window', {
      slug: sub.slug,
      due: rechecksDue.length,
      thisRun: rechecks.length,
    })
  }
  for (const setUrl of rechecks) {
    if (Date.now() >= deadline) {
      log.warn('sync.deadline_hit_during_recheck_loop', {
        slug: sub.slug,
        setsRechecked,
        setsRemainingInWindow: rechecks.length - setsRechecked,
      })
      break
    }
    if (!takeFetch(opts.fetchBudget)) {
      log.info('sync.recheck_budget_exhausted', { slug: sub.slug, setsRechecked, setsRemainingInWindow: rechecks.length - setsRechecked })
      break
    }
    const tSet = Date.now()
    const prev = tracklistVideos[setUrl]
    try {
      const setFetched = await fetch1001Html(setUrl, fetchOpts)
      viaSeen.add(setFetched.via)
      const videoId = parseSetYouTubeId(setFetched.html)
      const checkedAt = nowSeconds()
      if (!prev || prev.videoId === undefined) {
        // Unknown baseline: record what the page has now, change nothing.
        tracklistVideos[setUrl] = { videoId, checkedAt }
        log.info('sync.recheck_baseline', { slug: sub.slug, setUrl, videoId })
      } else if (videoId === null) {
        // The set lost its recording (or, for an mkvid upload, never had one on
        // the page). Keep what we have — never remove on absence.
        tracklistVideos[setUrl] = { ...prev, videoId: prev.videoId, checkedAt }
        log.info('sync.recheck_no_youtube', { slug: sub.slug, setUrl, keptVideoId: prev.videoId })
        // Still nothing on YouTube: a SoundCloud/hearthis recording that has
        // appeared since (or a request that was never queued) goes to mkvid.
        // Idempotent — a set with a request already gets 'exists'.
        if (prev.videoId === null) await maybeQueueForMkvid(setUrl, setFetched.html)
      } else if (videoId === prev.videoId) {
        tracklistVideos[setUrl] = { videoId, checkedAt }
        log.info('sync.recheck_unchanged', { slug: sub.slug, setUrl, videoId })
      } else if (prev.videoId === null) {
        // The set gained a recording since we last looked: same as a first-time add.
        videoIdsFound += 1
        const wasPresent = existingVideoIds.has(videoId)
        if (!wasPresent) {
          await addToArtistPlaylist(videoId)
          log.info('sync.recheck_added', { slug: sub.slug, setUrl, videoId, playlistId })
        }
        tracklistVideos[setUrl] = { videoId, checkedAt }
        await supersedeMkvid(setUrl, videoId)
        auditSet(wasPresent ? 'duplicate' : 'added', setUrl, {
          videoId,
          videoUrl: watchUrl(videoId),
          via: setFetched.via,
          meta: { ms: Date.now() - tSet },
          combinedStatus: await mirrorToCombined(videoId),
        })
      } else {
        // Swapped recording. New is strictly better: out with the old (from
        // both playlists, unless another set still resolves to it), in with
        // the new. Removals happen before the insert so a failure part-way
        // leaves the next recheck with a clean retry: `prev` is unchanged
        // until the end, so it re-runs this branch and every step is a no-op
        // once done.
        const oldVideoId = prev.videoId
        videoIdsFound += 1
        const oldStillUsedHere = referencedByOtherSet(tracklistVideos, oldVideoId, setUrl)
        let removedFromArtist = 0
        if (oldStillUsedHere) {
          log.info('sync.recheck_keep_old_shared', { slug: sub.slug, setUrl, oldVideoId })
        } else {
          removedFromArtist = await removeFromArtistPlaylist(oldVideoId)
        }
        let removedFromCombined = 0
        if (!oldStillUsedHere && !(await videoReferencedByAnySub(env, oldVideoId, sub.slug))) {
          const handle = await openCombinedOnce()
          if (handle) {
            try {
              removedFromCombined = await removeFromCombined(handle, oldVideoId, accessToken, log)
            } catch (e) {
              // The combined backfill only ever adds, so a failed removal here
              // is not self-healing — but it is also not worth failing the
              // swap over. Logged for the panel.
              log.warn('sync.recheck_combined_remove_failed', { slug: sub.slug, oldVideoId, ...errorFields(e) })
            }
          }
        }
        if (!existingVideoIds.has(videoId)) await addToArtistPlaylist(videoId)
        const combinedStatus = await mirrorToCombined(videoId)
        tracklistVideos[setUrl] = { videoId, checkedAt }
        videosReplaced += 1
        log.info('sync.recheck_replaced', {
          slug: sub.slug,
          setUrl,
          oldVideoId,
          videoId,
          removedFromArtist,
          removedFromCombined,
          playlistId,
        })
        auditSet('replaced', setUrl, {
          videoId,
          videoUrl: watchUrl(videoId),
          previousVideoId: oldVideoId,
          via: setFetched.via,
          meta: { ms: Date.now() - tSet },
          combinedStatus,
          message: `replaced ${oldVideoId} (removed ${removedFromArtist} from artist, ${removedFromCombined} from combined)`,
        })
      }
      delete failureCounts[setUrl]
      setsRechecked += 1
    } catch (e) {
      if (isStopTheBatchError(e)) {
        stopReason = stopReasonFor(e)
        log.error('sync.recheck_batch_stopped_blocked', { slug: sub.slug, setUrl, setsRechecked, ...errorFields(e) })
        break
      }
      if (isQuotaError(e)) {
        // Out of YouTube quota mid-swap. Nothing else will succeed today and
        // the set is still due, so stop here without charging it a failure —
        // a later tick redoes the swap from the top (every completed step is
        // a no-op on retry).
        log.warn('sync.recheck_quota_exhausted', { slug: sub.slug, setUrl, ...errorFields(e) })
        break
      }
      // Same counter as first-time processing, but a set that already has a
      // video in the playlist is never abandoned for failing a *recheck* —
      // after ABANDON_AFTER_FAILURES it is simply deferred to the next
      // interval instead of being retried every tick.
      const fc = (failureCounts[setUrl] = (failureCounts[setUrl] ?? 0) + 1)
      const defer = fc >= ABANDON_AFTER_FAILURES
      log.warn('sync.recheck_failed', { slug: sub.slug, setUrl, failureCount: fc, deferring: defer, ...errorFields(e) })
      auditSet('failed', setUrl, {
        videoId: prev?.videoId ?? null,
        videoUrl: prev?.videoId ? watchUrl(prev.videoId) : null,
        message: `recheck: ${e instanceof Error ? e.message : String(e)}`,
        failureCount: fc,
        meta: { ms: Date.now() - tSet },
      })
      if (defer) {
        tracklistVideos[setUrl] = { ...(prev ?? {}), checkedAt: nowSeconds() }
        delete failureCounts[setUrl]
      }
    }
  }

  const next: SubState = {
    playlistId,
    artistName,
    discoveredTracklistUrls: [...discovered],
    processedTracklistUrls: [...processed],
    abandonedTracklistUrls: [...abandoned],
    failureCounts,
    tracklistVideos,
    lastRunAt: Math.floor(Date.now() / 1000),
    ...(stopReason ? { lastError: stopReason } : {}),
    lastRunStats: {
      tracklistsSeen: discovered.size,
      tracklistsProcessed: setsProcessed,
      videoIdsFound,
      videoIdsAdded,
      tracklistsRechecked: setsRechecked,
      videosReplaced,
      via:
        viaSeen.size === 0
          ? 'direct'
          : viaSeen.size === 1
            ? ([...viaSeen][0] as 'home-proxy' | 'home-proxy-pool' | 'unlocker' | 'direct')
            : 'mixed',
    },
  }
  await saveSubState(env, sub.slug, next, { since })
  // Write the post-insert/removal video set back so the next cron tick reads
  // it from KV instead of paying YT quota to re-fetch. Only on actual change —
  // a no-op run shouldn't re-extend the TTL on a cache the API already populated.
  if (playlistChanged) {
    await cachePlaylistVideoIds(env, playlistId, existingVideoIds)
  }
  if (combined.handle) await flushCombined(env, combined.handle, log)
  await flushPlaylistAdditions(env, additions, log)

  return {
    slug: sub.slug,
    ok: true,
    artistName,
    playlistId,
    combinedPlaylistId: combined.handle?.playlistId,
    stats: {
      tracklistsSeen: discovered.size,
      tracklistsProcessed: setsProcessed,
      videoIdsFound,
      videoIdsAdded,
      // Pending = discovered minus already-processed minus permanently-abandoned.
      tracklistsPending: [...discovered].filter((u) => !processed.has(u) && !abandoned.has(u)).length,
      combinedVideoIdsAdded: combined.handle?.inserted ?? 0,
      tracklistsRechecked: setsRechecked,
      videosReplaced,
      rechecksPending: dueRecheckUrls(processed, abandoned, tracklistVideos).length,
    },
  }
}

/** Does any *other* tracklist in `map` currently resolve to `videoId`? */
function referencedByOtherSet(map: Record<string, TracklistVideo>, videoId: string, exceptUrl: string): boolean {
  for (const [u, e] of Object.entries(map)) {
    if (u !== exceptUrl && e.videoId === videoId) return true
  }
  return false
}

/**
 * Does a tracklist of any *other* subscription resolve to `videoId`? Guards
 * the combined-playlist removal: a b2b set listed under both DJs shares one
 * recording, and swapping it on one DJ's page must not pull it from the
 * combined playlist while the other DJ's set still points at it. Only
 * consulted on a swap, so the extra KV reads are rare.
 */
async function videoReferencedByAnySub(env: Env, videoId: string, exceptSlug: string): Promise<boolean> {
  return (await slugsReferencingVideo(env, videoId, exceptSlug)).length > 0
}

/**
 * Recover a sub's per-tracklist video baseline from the playlist-addition
 * audit trail (rows carry set URL + video id, 90 days deep). Runs once, on
 * the first sync after `tracklistVideos` was introduced, so sets processed
 * before then can still have a swapped recording detected — otherwise the
 * first recheck could only record. The newest row per set is its latest
 * outcome. Sets with no surviving row get no entry (baseline unknown).
 */
export async function seedTracklistVideosFromAudit(
  env: Env,
  slug: string,
  processedUrls: ReadonlySet<string>,
  log: Logger,
): Promise<Record<string, TracklistVideo>> {
  const out: Record<string, TracklistVideo> = {}
  try {
    for (const [setUrl, m] of await latestAdditionPerSet(env, slug)) {
      if (!processedUrls.has(setUrl)) continue
      if (m.status === 'added' || m.status === 'duplicate' || m.status === 'replaced') {
        if (!m.vid) continue
        out[setUrl] = { videoId: m.vid, checkedAt: auditSeconds(m.t) }
      } else if (m.status === 'no_youtube') {
        out[setUrl] = { videoId: null, checkedAt: auditSeconds(m.t) }
      }
    }
  } catch (e) {
    // Best-effort: an unreadable audit trail just means more sets start with
    // an unknown baseline. Never fail the sync over it.
    log.warn('sync.seed_from_audit_failed', { slug, seeded: Object.keys(out).length, ...errorFields(e) })
  }
  log.info('sync.seed_from_audit', { slug, processed: processedUrls.size, seeded: Object.keys(out).length })
  return out
}

function auditSeconds(iso: string): number {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0
}

export type InvalidateResult = {
  slug: string
  /** Processed tracklists now due for an immediate recheck. */
  tracklistsMarked: number
  /** Previously given-up tracklists that will be retried. */
  abandonedCleared: number
}

/**
 * "Invalidate video cache": forget everything the sync *trusts* about this
 * DJ without forgetting what it *knows*. Every processed tracklist becomes
 * due for a recheck now (its recorded video is kept, so a swap is still
 * detected and the old one removed), abandoned sets get another chance, and
 * the cached membership of the artist playlist and the combined playlist is
 * dropped so the next run re-reads both from YouTube. Follow with `syncOne`;
 * the 5-minute cron drains whatever one run doesn't reach.
 */
/**
 * Failure messages that mean "the fetch route was blocked", not "this set is
 * broken": the block page itself, the forwarder being unusable, BrightData
 * answering with a Cloudflare shell (what every set got during the 2026-09
 * ban once the home proxy was blocked), or a deliberate pause.
 */
export const BLOCK_SHAPED_FAILURE = /ip.?block|rate-limited|blocked|home proxy|unlocker|cf shell|cloudflare|challenge|paused|403|no_body|unusable/i

export type RequeueResult = {
  days: number
  dryRun: boolean
  auditRowsScanned: number
  /** Sets whose failure/abandon rows in the window all look block-shaped, per slug. */
  candidates: Record<string, string[]>
  /** Sets actually removed from a sub's abandoned list (or whose failure count was reset). */
  requeued: Record<string, string[]>
  requeuedCount: number
}

/**
 * One-time repair after a ban episode: sets that were abandoned (3 failures)
 * because every fetch route was blocked are valid URLs that deserve another
 * go. Scans the playlist-addition audit for `failed`/`abandoned` rows in the
 * last `days` with a block-shaped message, and for each such set drops it from
 * the sub's abandoned list and resets its failure count so the next cron tick
 * processes it again. Blocks no longer count as failures going forward (see
 * the set loop), so this should not be needed twice.
 */
export async function requeueBanVictims(env: Env, opts: { days?: number; dryRun?: boolean; log: Logger }): Promise<RequeueResult> {
  const days = opts.days ?? 14
  const dryRun = opts.dryRun ?? false
  const log = opts.log
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const candidates = new Map<string, Set<string>>()
  let scanned = 0
  for (const m of await failureRowsSince(env, cutoff)) {
    scanned++
    if (m.msg && BLOCK_SHAPED_FAILURE.test(m.msg)) {
      if (!candidates.has(m.slug)) candidates.set(m.slug, new Set())
      candidates.get(m.slug)!.add(m.set)
    }
  }

  const requeued: Record<string, string[]> = {}
  for (const [slug, urls] of candidates) {
    const state = await loadSubState(env, slug)
    if (!state) continue
    const abandoned = new Set(state.abandonedTracklistUrls ?? [])
    const failureCounts = state.failureCounts ?? {}
    const hit = [...urls].filter((u) => abandoned.has(u) || u in failureCounts)
    if (hit.length === 0) continue
    requeued[slug] = hit.sort()
    if (!dryRun) await requeueTracklists(env, slug, hit)
  }
  const requeuedCount = Object.values(requeued).reduce((a, x) => a + x.length, 0)
  log.info('sync.requeue_ban_victims', { days, dryRun, auditRowsScanned: scanned, requeuedCount, perSlug: Object.fromEntries(Object.entries(requeued).map(([k, v]) => [k, v.length])) })
  return {
    days,
    dryRun,
    auditRowsScanned: scanned,
    candidates: Object.fromEntries([...candidates].map(([k, v]) => [k, [...v].sort()])),
    requeued,
    requeuedCount,
  }
}

export async function invalidateVideoCache(env: Env, slug: string, log: Logger): Promise<InvalidateResult> {
  const state = await loadSubState(env, slug)
  if (!state) {
    log.info('sync.invalidate.no_state', { slug })
    return { slug, tracklistsMarked: 0, abandonedCleared: 0 }
  }
  const processed = new Set(state.processedTracklistUrls)
  // State that predates rechecks has no baselines: seed them from the audit
  // trail first, so the rechecks this triggers can compare (and swap) rather
  // than merely record.
  if (!state.tracklistVideos && processed.size > 0) {
    const tracklistVideos = await seedTracklistVideosFromAudit(env, slug, processed, log)
    await saveSubState(env, slug, { ...state, tracklistVideos }, { since: state })
  }
  const { tracklistsMarked, abandonedCleared } = await invalidateSubTracklists(env, slug)
  if (state.playlistId) await invalidatePlaylistVideoIds(env, state.playlistId)
  const combined = await loadCombinedState(env)
  if (combined.playlistId) await invalidatePlaylistVideoIds(env, combined.playlistId)
  log.info('sync.invalidate', {
    slug,
    tracklistsMarked,
    abandonedCleared,
    playlistId: state.playlistId ?? null,
    combinedPlaylistId: combined.playlistId ?? null,
  })
  return { slug, tracklistsMarked, abandonedCleared }
}

/**
 * Resolve this artist's playlist by title — find an existing one with that
 * exact title on the user's channel, or create a fresh public one. Used both
 * on first sync and as the recovery path when cached state references a
 * deleted playlist. Never returns null (the shared helper only does so in
 * lookup-only mode, which the sync never uses).
 */
async function resolveArtistPlaylist(
  title: string,
  artistName: string,
  accessToken: string,
  log: Logger,
  slug: string,
): Promise<{ id: string; justCreated: boolean }> {
  const r = await findOrCreatePlaylist(
    { title, description: playlistDescription(artistName), logCtx: { slug } },
    accessToken,
    log,
  )
  if (!r) throw new Error(`playlist ${JSON.stringify(title)} could not be resolved`)
  return r
}

/**
 * Best-effort prettification when the DJ page didn't yield a name. Underscore
 * / hyphen → space, then word-cap. "lillypalmer" stays "Lillypalmer" (we have
 * no way to split runs of letters), but "lilly_palmer" becomes "Lilly Palmer".
 * Always loses to the scraped H1 when one is present.
 */
export function prettifySlug(slug: string): string {
  return slug
    .replace(/[._-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}
