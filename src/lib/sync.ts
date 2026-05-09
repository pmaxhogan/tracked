/**
 * Sync orchestrator: for each subscribed DJ, scrape their 1001tracklists DJ
 * page, discover sets that have a YouTube video, and add those videos to a
 * playlist named "<artist> (1001tklists)" on the connected YouTube account.
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
import {
  addVideoToPlaylist,
  createPlaylist,
  findPlaylistByTitle,
  listPlaylistVideoIds,
  PlaylistNotFoundError,
} from './youtube-playlists'
import { makeLogger, errorFields, type Logger } from './log'

const STATE_PREFIX = 'subs:state:'
const PLAYLIST_TITLE_SUFFIX = ' (1001tklists)'
const playlistDescription = (artistName: string) =>
  `Every set ${artistName} has a YouTube recording for on 1001tracklists.`
// Per-set scrape via home proxy is ~250 ms; via BrightData ~3–4 s. 30 sets
// fits in ~8 s home-proxy / 25 s BrightData (deadline-bound either way).
// Big enough that a 145-set first-time backfill is ~5 cron ticks instead
// of 15, but small enough to keep YouTube quota usage bounded — at 50
// quota per insert, 30 inserts × 4 subs = 6 000 of the daily 10 000.
const DEFAULT_MAX_SETS_PER_RUN = 30
// DJ-page pagination is also BrightData-paid; cap so a deep history doesn't
// blow the wall-clock budget. Most DJs fit in <10 pages.
const DEFAULT_MAX_DJ_PAGES = 20
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
}

export type SyncOneResult = {
  slug: string
  ok: boolean
  error?: string
  artistName: string
  playlistId?: string
  stats: {
    tracklistsSeen: number
    tracklistsProcessed: number
    videoIdsFound: number
    videoIdsAdded: number
    /** Tracklists discovered on the DJ page but not yet processed (cap or
     *  per-set failure). Run sync again to chip away at them. */
    tracklistsPending: number
  }
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
        stats: { tracklistsSeen: 0, tracklistsProcessed: 0, videoIdsFound: 0, videoIdsAdded: 0, tracklistsPending: 0 },
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
    const pending = state.discoveredTracklistUrls.length - state.processedTracklistUrls.length
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
    const r = await findOrCreatePlaylist(playlistTitle, artistName, accessToken, log, sub.slug)
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
  } else {
    try {
      existingVideoIds = await listPlaylistVideoIds(playlistId, accessToken)
    } catch (e) {
      if (e instanceof PlaylistNotFoundError) {
        log.warn('sync.playlist_stale', { slug: sub.slug, stalePlaylistId: playlistId })
        const r = await findOrCreatePlaylist(playlistTitle, artistName, accessToken, log, sub.slug)
        playlistId = r.id
        existingVideoIds = r.justCreated ? new Set() : await listPlaylistVideoIds(playlistId, accessToken)
      } else {
        throw e
      }
    }
  }

  // 4. Walk tracklist URLs we haven't already processed. todo is drawn from
  // the cumulative discovery set (state ∪ this-run), in the order we first
  // saw them — newest at the front since 1001tl lists newest first.
  const processed = new Set(state.processedTracklistUrls)
  const allUrls = [...discovered]
  const todo = allUrls.filter((u) => !processed.has(u)).slice(0, maxSets)
  log.info('sync.todo_window', {
    slug: sub.slug,
    totalUrls: allUrls.length,
    alreadyProcessed: processed.size,
    todoThisRun: todo.length,
    capped: allUrls.length - processed.size > maxSets,
  })

  let videoIdsFound = 0
  let videoIdsAdded = 0
  let setsProcessed = 0
  const viaSeen = new Set<string>()

  for (const setUrl of todo) {
    if (Date.now() >= deadline) {
      log.warn('sync.deadline_hit_during_set_loop', {
        slug: sub.slug,
        setsProcessed,
        setsRemainingInWindow: todo.length - setsProcessed,
      })
      break
    }
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
              const r = await findOrCreatePlaylist(playlistTitle, artistName, accessToken, log, sub.slug)
              playlistId = r.id
              // Found existing same-titled → list to avoid dupes; freshly created → empty.
              existingVideoIds = r.justCreated ? new Set() : await listPlaylistVideoIds(playlistId, accessToken)
              await addVideoToPlaylist(playlistId, videoId, accessToken)
            } else {
              throw e
            }
          }
          existingVideoIds.add(videoId)
          videoIdsAdded += 1
          log.info('sync.added', { slug: sub.slug, setUrl, videoId, playlistId })
        } else {
          log.info('sync.already_in_playlist', { slug: sub.slug, setUrl, videoId })
        }
      } else {
        // Diagnostic fingerprint so we can tell at a glance whether the page
        // truly has no YT or whether the parser missed an embed shape.
        log.info('sync.no_youtube_on_set', {
          slug: sub.slug,
          setUrl,
          fingerprint: youtubeFingerprint(setFetched.html),
        })
      }
      processed.add(setUrl)
      setsProcessed += 1
    } catch (e) {
      // Per-set errors don't block the rest of the run, and we deliberately
      // do NOT mark this URL as processed — we'll retry next run.
      log.warn('sync.set_failed', { slug: sub.slug, setUrl, ...errorFields(e) })
    }
  }

  const next: SubState = {
    playlistId,
    artistName,
    discoveredTracklistUrls: [...discovered],
    processedTracklistUrls: [...processed],
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

  return {
    slug: sub.slug,
    ok: true,
    artistName,
    playlistId,
    stats: {
      tracklistsSeen: discovered.size,
      tracklistsProcessed: setsProcessed,
      videoIdsFound,
      videoIdsAdded,
      tracklistsPending: Math.max(0, discovered.size - processed.size),
    },
  }
}

/**
 * Resolve a playlist by title — find an existing one with that exact title
 * on the user's channel, or create a fresh private playlist. Used both on
 * first sync and as the recovery path when cached state references a
 * deleted playlist.
 */
async function findOrCreatePlaylist(
  title: string,
  artistName: string,
  accessToken: string,
  log: Logger,
  slug: string,
): Promise<{ id: string; justCreated: boolean }> {
  const existing = await findPlaylistByTitle(title, accessToken)
  if (existing) {
    log.info('sync.playlist_found', { slug, playlistId: existing.id, title })
    return { id: existing.id, justCreated: false }
  }
  const created = await createPlaylist(
    { title, description: playlistDescription(artistName), privacyStatus: 'private' },
    accessToken,
  )
  log.info('sync.playlist_created', { slug, playlistId: created.id, title })
  return { id: created.id, justCreated: true }
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
