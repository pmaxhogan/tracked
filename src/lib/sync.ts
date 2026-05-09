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
import { fetch1001Html, parseDjIndex, parseSetYouTubeId } from './dj-index'
import { getAccessToken } from './google-oauth'
import {
  addVideoToPlaylist,
  createPlaylist,
  findPlaylistByTitle,
  listPlaylistVideoIds,
} from './youtube-playlists'
import { makeLogger, errorFields, type Logger } from './log'

const STATE_PREFIX = 'subs:state:'
const PLAYLIST_TITLE_SUFFIX = ' (1001tklists)'
const PLAYLIST_DESCRIPTION = 'Auto-curated by tracked: every set this DJ has a YouTube recording for, scraped from 1001tracklists.'
// Each set scrape is a 2–4 s BrightData hit; 10 sets keeps a single request
// inside Workers' wall-time budget. New subs with deeper history backfill
// over multiple cron ticks (or repeated manual syncs).
const DEFAULT_MAX_SETS_PER_RUN = 10

export type SubState = {
  playlistId?: string
  artistName?: string
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
        stats: { tracklistsSeen: 0, tracklistsProcessed: 0, videoIdsFound: 0, videoIdsAdded: 0 },
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
  const state: SubState = (await loadSubState(env, sub.slug)) ?? { processedTracklistUrls: [] }
  const fetchOpts = {
    brightdataApiKey: env.BRIGHTDATA_API_KEY,
    homeProxyUrl: env.HOME_PROXY_URL,
    homeProxyToken: env.HOME_PROXY_TOKEN,
    log,
  }

  // 1. DJ index page
  const djUrl = djUrlFor(sub.slug)
  const djFetched = await fetch1001Html(djUrl, fetchOpts)
  const parsed = parseDjIndex(djFetched.html)
  const artistName = parsed.artistName ?? state.artistName ?? prettifySlug(sub.slug)
  log.info('sync.dj_parsed', {
    slug: sub.slug,
    via: djFetched.via,
    artistName,
    tracklistsSeen: parsed.tracklistUrls.length,
  })

  // 2. Resolve / create the playlist. State first, then YT lookup, then create.
  const playlistTitle = `${artistName}${PLAYLIST_TITLE_SUFFIX}`
  let playlistId = state.playlistId
  if (!playlistId) {
    const existing = await findPlaylistByTitle(playlistTitle, accessToken)
    if (existing) {
      playlistId = existing.id
      log.info('sync.playlist_found', { slug: sub.slug, playlistId, title: playlistTitle })
    } else {
      const created = await createPlaylist(
        { title: playlistTitle, description: PLAYLIST_DESCRIPTION, privacyStatus: 'private' },
        accessToken,
      )
      playlistId = created.id
      log.info('sync.playlist_created', { slug: sub.slug, playlistId, title: playlistTitle })
    }
  }

  // 3. Existing video ids in the playlist (defense in depth — wiped state mustn't dupe)
  const existingVideoIds = await listPlaylistVideoIds(playlistId, accessToken)

  // 4. Walk tracklist URLs we haven't already processed.
  const processed = new Set(state.processedTracklistUrls)
  const todo = parsed.tracklistUrls.filter((u) => !processed.has(u)).slice(0, maxSets)
  log.info('sync.todo_window', {
    slug: sub.slug,
    totalUrls: parsed.tracklistUrls.length,
    alreadyProcessed: processed.size,
    todoThisRun: todo.length,
    capped: parsed.tracklistUrls.length - processed.size > maxSets,
  })

  let videoIdsFound = 0
  let videoIdsAdded = 0
  let setsProcessed = 0
  const viaSeen = new Set<string>([djFetched.via])

  for (const setUrl of todo) {
    try {
      const setFetched = await fetch1001Html(setUrl, fetchOpts)
      viaSeen.add(setFetched.via)
      const videoId = parseSetYouTubeId(setFetched.html)
      if (videoId) {
        videoIdsFound += 1
        if (!existingVideoIds.has(videoId)) {
          await addVideoToPlaylist(playlistId, videoId, accessToken)
          existingVideoIds.add(videoId)
          videoIdsAdded += 1
          log.info('sync.added', { slug: sub.slug, setUrl, videoId, playlistId })
        } else {
          log.info('sync.already_in_playlist', { slug: sub.slug, setUrl, videoId })
        }
      } else {
        log.info('sync.no_youtube_on_set', { slug: sub.slug, setUrl })
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
    processedTracklistUrls: [...processed],
    lastRunAt: Math.floor(Date.now() / 1000),
    lastRunStats: {
      tracklistsSeen: parsed.tracklistUrls.length,
      tracklistsProcessed: setsProcessed,
      videoIdsFound,
      videoIdsAdded,
      via: viaSeen.size === 1 ? ([...viaSeen][0] as 'home-proxy' | 'unlocker' | 'direct') : 'mixed',
    },
  }
  await saveSubState(env, sub.slug, next)

  return {
    slug: sub.slug,
    ok: true,
    artistName,
    playlistId,
    stats: {
      tracklistsSeen: parsed.tracklistUrls.length,
      tracklistsProcessed: setsProcessed,
      videoIdsFound,
      videoIdsAdded,
    },
  }
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
