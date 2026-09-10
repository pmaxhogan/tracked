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

/** Human label for why a batch stopped early (surfaces as the sub's lastError). */
function stopReasonFor(e: unknown): string {
  if (e instanceof UpstreamPausedError) return `paused: ${e.message}`
  if (e instanceof UpstreamUnavailableError) return `unavailable: ${e.message}`
  return `ip_blocked: ${e instanceof Error ? e.message : String(e)}`
}
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
import {
  flushPlaylistAdditions,
  PLAYLIST_AUDIT_PREFIX,
  type PlaylistAdditionRecord,
  type PlaylistAdditionStatus,
  type PlaylistAdditionSummary,
} from './playlist-audit'

const STATE_PREFIX = 'subs:state:'
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
// Upper bound on `pladd:` list pages read when seeding a sub's baseline from
// the audit trail (1 000 keys per page; 90 days of rows is a few pages).
const AUDIT_SEED_MAX_PAGES = 20

export type SubState = {
  playlistId?: string
  artistName?: string
  /**
   * Union over time of every tracklist URL we've ever seen on this DJ's
   * paginated index. The DJ index uses JS infinite-scroll, so a single
   * fetch only sees ~15 newest sets; we walk pageN.html on first sync to
   * build this and merge in newly-appearing URLs on every subsequent run.
   */
  discoveredTracklistUrls?: string[]
  processedTracklistUrls: string[]
  /**
   * Per-URL failure counter. When a set scrape errors (CF shell, IP block,
   * transport), we bump the count here. Once it crosses
   * `ABANDON_AFTER_FAILURES`, we move it to processedTracklistUrls so the
   * cron stops retrying — otherwise every cron tick re-attempts the same
   * failing URLs forever, which is what kept re-triggering the home-proxy
   * IP block. Cleared on success.
   */
  failureCounts?: Record<string, number>
  /** URLs we've given up retrying (after ABANDON_AFTER_FAILURES failures). */
  abandonedTracklistUrls?: string[]
  /**
   * What each processed tracklist resolved to, and when we last looked. This
   * is what a recheck compares against (see the module doc). Absent on state
   * written before rechecks existed; `syncOne` seeds it from the audit trail
   * on the first run after that, and any URL still without an entry is
   * rechecked as "baseline unknown".
   */
  tracklistVideos?: Record<string, TracklistVideo>
  lastRunAt?: number
  lastError?: string
  lastRunStats?: {
    tracklistsSeen: number
    tracklistsProcessed: number
    videoIdsFound: number
    videoIdsAdded: number
    tracklistsRechecked?: number
    videosReplaced?: number
    via: 'home-proxy' | 'home-proxy-pool' | 'unlocker' | 'direct' | 'mixed'
  }
}

export type TracklistVideo = {
  /**
   * The YouTube video the set page carried at `checkedAt`; null when it had
   * none. *Absent* means the baseline is unknown — the set was processed
   * before rechecks existed and no audit row survived — so the next recheck
   * records rather than compares.
   */
  videoId?: string | null
  /** Unix seconds of the last fetch of the set page. 0 = due now (invalidated). */
  checkedAt: number
}

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

export async function loadSubState(env: Env, slug: string): Promise<SubState | null> {
  return ((await env.SUBS.get(`${STATE_PREFIX}${slug}`, 'json')) as SubState | null) ?? null
}

export async function saveSubState(env: Env, slug: string, state: SubState): Promise<void> {
  await env.SUBS.put(`${STATE_PREFIX}${slug}`, JSON.stringify(state))
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
  const subs = await listSubscriptions(env)
  log.info('sync.start', { subCount: subs.length })
  const results: SyncOneResult[] = []
  if (await pausedForRun(env, log, 'sync')) return { results, paused: true }
  for (const sub of subs) {
    try {
      const r = await syncOne(env, sub, tokenInfo.accessToken, opts)
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
  })
  await flushBanTally(env, true)
  return { results }
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
  const candidates: Subscription[] = []
  for (const sub of subs) {
    const state = await loadSubState(env, sub.slug)
    if (!state || !state.discoveredTracklistUrls) continue
    if (pendingTracklistUrls(state).length > 0 || dueRechecks(state).length > 0) candidates.push(sub)
  }
  if (candidates.length === 0) {
    log.info('sync.pending.nothing_to_do', { totalSubs: subs.length })
    return { results: [] }
  }
  log.info('sync.pending.start', { totalSubs: subs.length, candidatesWithPending: candidates.length })
  const tokenInfo = await getAccessToken(env)
  if (!tokenInfo) {
    log.error('sync.pending.no_oauth_tokens')
    throw new Error('YouTube account not connected')
  }
  const results: SyncOneResult[] = []
  for (const sub of candidates) {
    try {
      const r = await syncOne(env, sub, tokenInfo.accessToken, { ...opts, skipDjCrawl: true })
      results.push(r)
    } catch (e) {
      log.error('sync.pending.sub_threw', { slug: sub.slug, ...errorFields(e) })
    }
  }
  log.info('sync.pending.done', {
    candidatesProcessed: results.length,
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
  const sources: PlaylistSource[] = []
  for (const sub of subs) {
    const state = await loadSubState(env, sub.slug)
    if (!state?.playlistId) continue
    sources.push({ slug: sub.slug, artistName: state.artistName ?? null, playlistId: state.playlistId })
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
  const state: SubState = (await loadSubState(env, sub.slug)) ?? { processedTracklistUrls: [] }
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
    const tSet = Date.now()
    try {
      const setFetched = await fetch1001Html(setUrl, fetchOpts)
      viaSeen.add(setFetched.via)
      const videoId = parseSetYouTubeId(setFetched.html)
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
        auditSet('no_youtube', setUrl, { via: setFetched.via, meta: { ms: Date.now() - tSet } })
      }
      processed.add(setUrl)
      tracklistVideos[setUrl] = { videoId, checkedAt: nowSeconds() }
      delete failureCounts[setUrl]
      setsProcessed += 1
    } catch (e) {
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
        // The set lost its recording. Keep what we have — never remove on absence.
        tracklistVideos[setUrl] = { videoId: prev.videoId, checkedAt }
        log.info('sync.recheck_no_youtube', { slug: sub.slug, setUrl, keptVideoId: prev.videoId })
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
  await saveSubState(env, sub.slug, next)
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
  const subs = await listSubscriptions(env)
  for (const s of subs) {
    if (s.slug === exceptSlug) continue
    const st = await loadSubState(env, s.slug)
    if (st?.tracklistVideos && referencedByOtherSet(st.tracklistVideos, videoId, '')) return true
  }
  return false
}

/**
 * Recover a sub's per-tracklist video baseline from the playlist-addition
 * audit trail (`pladd:` rows carry set URL + video id in their metadata, 90
 * days deep). Runs once, on the first sync after `tracklistVideos` was
 * introduced, so sets processed before then can still have a swapped
 * recording detected — otherwise the first recheck could only record. Rows
 * are newest-first, so the first row seen per URL is its latest outcome.
 * Sets with no surviving row get no entry (baseline unknown).
 */
export async function seedTracklistVideosFromAudit(
  env: Env,
  slug: string,
  processedUrls: ReadonlySet<string>,
  log: Logger,
): Promise<Record<string, TracklistVideo>> {
  const out: Record<string, TracklistVideo> = {}
  let cursor: string | undefined
  let pages = 0
  try {
    do {
      const page = await env.CACHE.list<PlaylistAdditionSummary>({ prefix: PLAYLIST_AUDIT_PREFIX, cursor, limit: 1000 })
      pages += 1
      for (const k of page.keys) {
        const m = k.metadata
        if (!m || m.slug !== slug || !m.set || out[m.set] || !processedUrls.has(m.set)) continue
        if (m.status === 'added' || m.status === 'duplicate' || m.status === 'replaced') {
          if (!m.vid) continue
          out[m.set] = { videoId: m.vid, checkedAt: auditSeconds(m.t) }
        } else if (m.status === 'no_youtube') {
          out[m.set] = { videoId: null, checkedAt: auditSeconds(m.t) }
        }
      }
      cursor = page.list_complete ? undefined : page.cursor
    } while (cursor && pages < AUDIT_SEED_MAX_PAGES)
  } catch (e) {
    // Best-effort: an unreadable audit trail just means more sets start with
    // an unknown baseline. Never fail the sync over it.
    log.warn('sync.seed_from_audit_failed', { slug, seeded: Object.keys(out).length, ...errorFields(e) })
  }
  log.info('sync.seed_from_audit', { slug, processed: processedUrls.size, seeded: Object.keys(out).length, pages })
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
  let cursor: string | undefined
  let pages = 0
  outer: do {
    const page = await env.CACHE.list({ prefix: PLAYLIST_AUDIT_PREFIX, cursor, limit: 1000 })
    pages++
    for (const k of page.keys) {
      const m = k.metadata as PlaylistAdditionSummary | undefined
      if (!m) continue
      scanned++
      if (Date.parse(m.t) < cutoff) break outer
      if ((m.status === 'abandoned' || m.status === 'failed') && m.msg && BLOCK_SHAPED_FAILURE.test(m.msg)) {
        if (!candidates.has(m.slug)) candidates.set(m.slug, new Set())
        candidates.get(m.slug)!.add(m.set)
      }
    }
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor && pages < AUDIT_SEED_MAX_PAGES)

  const requeued: Record<string, string[]> = {}
  for (const [slug, urls] of candidates) {
    const state = await loadSubState(env, slug)
    if (!state) continue
    const abandoned = new Set(state.abandonedTracklistUrls ?? [])
    const failureCounts = { ...(state.failureCounts ?? {}) }
    const hit: string[] = []
    for (const u of urls) {
      let touched = false
      if (abandoned.delete(u)) touched = true
      if (u in failureCounts) {
        delete failureCounts[u]
        touched = true
      }
      if (touched) hit.push(u)
    }
    if (hit.length === 0) continue
    requeued[slug] = hit.sort()
    if (!dryRun) {
      await saveSubState(env, slug, { ...state, abandonedTracklistUrls: [...abandoned], failureCounts })
    }
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
  const tracklistVideos =
    state.tracklistVideos ?? (processed.size > 0 ? await seedTracklistVideosFromAudit(env, slug, processed, log) : {})
  for (const u of processed) {
    tracklistVideos[u] = { ...(tracklistVideos[u] ?? {}), checkedAt: 0 }
  }
  const abandonedCleared = state.abandonedTracklistUrls?.length ?? 0
  await saveSubState(env, slug, {
    ...state,
    tracklistVideos,
    abandonedTracklistUrls: [],
    failureCounts: {},
  })
  if (state.playlistId) await invalidatePlaylistVideoIds(env, state.playlistId)
  const combined = await loadCombinedState(env)
  if (combined.playlistId) await invalidatePlaylistVideoIds(env, combined.playlistId)
  log.info('sync.invalidate', {
    slug,
    tracklistsMarked: processed.size,
    abandonedCleared,
    playlistId: state.playlistId ?? null,
    combinedPlaylistId: combined.playlistId ?? null,
  })
  return { slug, tracklistsMarked: processed.size, abandonedCleared }
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
