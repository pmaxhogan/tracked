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
 * **Quota contract.** Caps `maxSetsPerRun` (default 30) per subscription per
 * run to keep Bright Data spend and YouTube quota bounded. New subscriptions
 * with deep histories backfill across multiple cron ticks; users who want
 * "now" can hit the manual sync endpoint repeatedly.
 */

import type { Env } from '../types'
import { listSubscriptions, djUrlFor, type Subscription } from './subscriptions'
import { crawlDjIndex, fetch1001Html, parseSetYouTubeId, youtubeFingerprint } from './dj-index'
import { getAccessToken } from './google-oauth'
import { addVideoToPlaylist, isPermanentInsertError, PlaylistNotFoundError } from './youtube-playlists'
import { cachePlaylistVideoIds, findOrCreatePlaylist, getCachedPlaylistVideoIds } from './playlist-cache'
import {
  addToCombined,
  flushCombined,
  markVideosUnavailable,
  mergeIntoCombinedPlaylist,
  openCombinedPlaylist,
  readCombinedStatus,
  type CombinedAdditionStatus,
  type CombinedHandle,
  type CombinedMergeResult,
  type CombinedStatus,
  type PlaylistSource,
} from './combined-playlist'
import { makeLogger, errorFields, type Logger } from './log'
import {
  flushPlaylistAdditions,
  type PlaylistAdditionRecord,
  type PlaylistAdditionStatus,
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
  lastRunAt?: number
  lastError?: string
  lastRunStats?: {
    tracklistsSeen: number
    tracklistsProcessed: number
    videoIdsFound: number
    videoIdsAdded: number
    via: 'home-proxy' | 'unlocker' | 'direct' | 'mixed'
  }
}

const ABANDON_AFTER_FAILURES = 3

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
  /**
   * What kicked off this run (`cron.daily`, `cron.pending`, `manual.all`,
   * `manual.one`). Recorded on every playlist-addition audit row so the panel
   * can tell a cron sweep's work apart from a button press.
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
  }
}

const EMPTY_STATS: SyncOneResult['stats'] = {
  tracklistsSeen: 0,
  tracklistsProcessed: 0,
  videoIdsFound: 0,
  videoIdsAdded: 0,
  tracklistsPending: 0,
  combinedVideoIdsAdded: 0,
}

/**
 * Sync every subscription. Errors per sub are isolated (logged + surfaced in
 * the result, but don't kill the rest of the sweep). A missing OAuth
 * connection or missing CACHE/SUBS bindings is a global failure.
 */
export async function syncAll(env: Env, opts: SyncOpts = {}): Promise<{ results: SyncOneResult[] }> {
  const log = opts.log ?? makeLogger({ task: 'sync.all' })
  const tokenInfo = await getAccessToken(env)
  if (!tokenInfo) {
    log.error('sync.no_oauth_tokens')
    throw new Error('YouTube account not connected — visit /subscriptions/oauth/start first')
  }
  const subs = await listSubscriptions(env)
  log.info('sync.start', { subCount: subs.length })
  const results: SyncOneResult[] = []
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
  return { results }
}

/**
 * Drain pending tracklists across every subscription without re-discovering
 * new sets. Used by the frequent (every-N-min) cron to chip away at large
 * backfills — manual sync handles only one batch, this handler keeps going
 * automatically until pending hits zero.
 *
 * Subs with no pending or no prior discovery state are skipped; the daily
 * 06:00 UTC sync handles initial discovery for them.
 */
export async function syncPendingOnly(env: Env, opts: SyncOpts = {}): Promise<{ results: SyncOneResult[] }> {
  const log = opts.log ?? makeLogger({ task: 'sync.pending' })
  const subs = await listSubscriptions(env)
  const candidates: Subscription[] = []
  for (const sub of subs) {
    const state = await loadSubState(env, sub.slug)
    if (!state || !state.discoveredTracklistUrls) continue
    const abandoned = state.abandonedTracklistUrls?.length ?? 0
    const pending =
      state.discoveredTracklistUrls.length - state.processedTracklistUrls.length - abandoned
    if (pending > 0) candidates.push(sub)
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
  })
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
  const deadline = Date.now() + SYNC_DEADLINE_MS
  const state: SubState = (await loadSubState(env, sub.slug)) ?? { processedTracklistUrls: [] }
  const fetchOpts = {
    brightdataApiKey: env.BRIGHTDATA_API_KEY,
    homeProxyUrl: env.HOME_PROXY_URL,
    homeProxyToken: env.HOME_PROXY_TOKEN,
    cacheKv: env.CACHE,
    log,
  }

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
  let playlistId = state.playlistId
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
      // Non-null by this point (step 2 resolved or created it), but the
      // closure sees the declared `string | undefined`.
      playlistId: playlistId ?? null,
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
          try {
            await addVideoToPlaylist(playlistId, videoId, accessToken)
          } catch (e) {
            if (e instanceof PlaylistNotFoundError) {
              // Playlist disappeared mid-run. Re-resolve once and retry the
              // insert; subsequent iterations of the loop pick up the new id.
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
            } else {
              throw e
            }
          }
          existingVideoIds.add(videoId)
          videoIdsAdded += 1
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
      delete failureCounts[setUrl]
      setsProcessed += 1
    } catch (e) {
      // Bump per-URL failure count. After ABANDON_AFTER_FAILURES, give up
      // and mark the URL processed so the cron stops re-attempting it
      // every tick (which is what kept re-triggering the home-proxy IP
      // block). The user can manually clear state if they want a retry.
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

  const next: SubState = {
    playlistId,
    artistName,
    discoveredTracklistUrls: [...discovered],
    processedTracklistUrls: [...processed],
    abandonedTracklistUrls: [...abandoned],
    failureCounts,
    lastRunAt: Math.floor(Date.now() / 1000),
    lastRunStats: {
      tracklistsSeen: discovered.size,
      tracklistsProcessed: setsProcessed,
      videoIdsFound,
      videoIdsAdded,
      via:
        viaSeen.size === 0
          ? 'direct'
          : viaSeen.size === 1
            ? ([...viaSeen][0] as 'home-proxy' | 'unlocker' | 'direct')
            : 'mixed',
    },
  }
  await saveSubState(env, sub.slug, next)
  // Write the post-insert video set back so the next cron tick reads it from
  // KV instead of paying YT quota to re-fetch. Only on actual change — a
  // no-op run shouldn't re-extend the TTL on a cache the API already populated.
  if (videoIdsAdded > 0) {
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
      tracklistsPending: Math.max(0, discovered.size - processed.size - abandoned.size),
      combinedVideoIdsAdded: combined.handle?.inserted ?? 0,
    },
  }
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
