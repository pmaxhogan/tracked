import { noteTrackYoutubeLinks } from '../lib/search/backfill'
import { Hono } from 'hono'
import { unpublishResponse } from './mkvid-ops'
import type { Env } from '../types'
import { cfAccess } from '../middleware/cf-access'
import { servePage } from '../ui/pages'
import { SET_PAGE } from '../ui/pages/set'
import { DJ_PAGE } from '../ui/pages/dj'
import { MKVID_PAGE_HTML } from '../ui/pages/mkvid'
import { DJS_PAGE } from '../ui/pages/djs'
import { PLAYLISTS_PAGE } from '../ui/pages/playlists'
import { SETTINGS_PAGE } from '../ui/pages/settings'
import { TOOLS_PAGE } from '../ui/pages/tools'
import { HOME_PAGE } from '../ui/pages/home'
import {
  addSubscription,
  djUrlFor,
  InvalidSubscriptionInput,
  listSubscriptions,
  parseDjSlug,
  removeSubscription,
} from '../lib/subscriptions'
import { getDjSets } from '../lib/dj-sets'
import { fetchMkvidRenderProgress } from '../lib/mkvid-progress'
import { extractVideoId, fetchVideoDetails, YouTubeApiError } from '../lib/youtube'
import {
  buildAuthUrl,
  clearTokens,
  exchangeCode,
  fetchChannelInfo,
  getAccessToken,
  GoogleOAuthRefreshFailed,
  loadTokens,
  randomState,
  redirectUriFor,
  revokeToken,
  saveTokens,
  type StoredTokens,
} from '../lib/google-oauth'
import { makeLogger, errorFields } from '../lib/log'
import { setCookie, getCookie, deleteCookie } from 'hono/cookie'
import {
  syncAll,
  syncOne,
  loadSubState,
  backfillCombined,
  combinedPlaylistStatus,
  invalidateVideoCache,
  manualFetchBudget,
  resyncAll,
} from '../lib/sync'
import { normalizeTracklistUrl } from '../lib/tracklists1001'
import { resolveFullTracklist, resolveTrackMediaLinks } from '../lib/tracklist-resolve'
import { fixPlaylistTitles } from '../lib/playlist-rename'
import { purgeAndRefetch, resolvePurgeTarget } from '../lib/tracklist-purge'
import { IPBlockedError, CloudflareChallengeError } from '../lib/fetch'
import { getPlaylistAddition, listPlaylistAdditions } from '../lib/playlist-audit'
import { getNowPlayingAudit, listNowPlayingAudit } from '../lib/now-playing-audit'
import { migrationStatus } from '../lib/kv-import'
import { readinessFor, setSkipIdWait } from '../lib/mkvid-readiness'
import { countOldStyleVideos, deleteOldVideo, listUndeletedOldVideos, recreateMkvidRequest, recreateOldStyleVideos, resetOldVideoDelete, unpublishMkvidRequest } from '../lib/mkvid-recreate'
import { banMkvidRequest, countMkvidRequests, getMkvidLastPoll, listMkvidDjs, listMkvidQueuePage, listMkvidSettledPage, MKVID_ACCOUNTS, MKVID_MOVES, MKVID_SOURCES, MKVID_STATUSES, mkvidAccountUsage, moveMkvidRequest, quotaDayEnd, requestSummary, retryMkvidRequest, type MkvidAccount, type MkvidFilter, type MkvidMove, type MkvidSourceKind, type MkvidStatus } from '../lib/mkvid'
import { requeueBanVictims } from '../lib/sync'
import { getBanStatus, manualClear, simulateBan } from '../lib/ban-state'
import { poolSettingsApp } from './pool-api'
import {
  deletePushSubscription,
  isPushSubscription,
  listPushSubscriptions,
  pushConfigured,
  savePushSubscription,
  sendPushToAll,
  testPayload,
} from '../lib/web-push'
import { SW_JS } from './ban-ui'
import { hygieneApp } from './playlist-hygiene'
import { activityApp } from './activity'
import { searchApp } from './search'
import { schedulerUiApp } from './scheduler-ui'

const STATE_COOKIE = 'yt_oauth_state'

export const subscriptionsApp = new Hono<{
  Bindings: Env
  Variables: { cfAccessEmail: string }
}>()

subscriptionsApp.use('*', cfAccess)

// Backstop: any throw that escapes a route handler would otherwise become
// Hono's default plaintext "Internal Server Error" body, which the UI
// can't parse and degrades to a generic "sync failed (500)" toast. Return
// JSON with the full error context (already captured for logs) so the
// browser can render the message + stack.
subscriptionsApp.onError((e, c) => {
  const log = makeLogger({
    reqId: c.req.raw.headers.get('cf-ray') ?? 'local',
    route: 'subs.unhandled',
    path: new URL(c.req.url).pathname,
  })
  log.error('subs.unhandled_throw', errorFields(e))
  return c.json({ error: 'internal', ...errorFields(e) }, 500)
})

// /removed page, removal log + undo, remove-and-replace (routes/playlist-hygiene.ts). Behind cfAccess above.
subscriptionsApp.route('/', hygieneApp)

// Activity log + set diagnostics (routes/activity.ts). Behind cfAccess above.
subscriptionsApp.route('/', activityApp)

// Search over the SEARCH_DB index (routes/search.ts). Behind cfAccess above.
subscriptionsApp.route('/', searchApp)

// Scheduler tick history and DJ due times, read-only (routes/scheduler-ui.ts). Behind cfAccess above.
subscriptionsApp.route('/', schedulerUiApp)

// Home: status tiles, needs attention, recent activity (ui/pages/home.ts).
subscriptionsApp.get('/', (c) => servePage(c, HOME_PAGE.html))
subscriptionsApp.get('/djs', (c) => servePage(c, DJS_PAGE.html))
subscriptionsApp.get('/playlists', (c) => servePage(c, PLAYLISTS_PAGE.html))
subscriptionsApp.get('/settings', (c) => servePage(c, SETTINGS_PAGE.html))
subscriptionsApp.get('/tools', (c) => servePage(c, TOOLS_PAGE.html))
// The mkvid queue: status line, caps, filters, tabs and a detail drawer (ui/pages/mkvid.ts).
subscriptionsApp.get('/mkvid', (c) => servePage(c, MKVID_PAGE_HTML))

// Standalone "tracklist viewer" page: paste a 1001tracklists URL, get a clean
// per-song list with a YouTube icon-link and an Apple Music button when 1001tl
// has them. Data comes from the CF-Access-gated /api/tracklist below (NOT the
// bearer-gated /tracklist API route — the browser only holds the Access cookie).
subscriptionsApp.get('/set', (c) => servePage(c, SET_PAGE.html))
// The viewer's old address; keeps the ?url= deep link.
subscriptionsApp.get('/tracklist', (c) => c.redirect('/ui/set' + new URL(c.req.url).search, 301))

// DJ profile page: every tracklist we know about for one DJ, as expandable
// cards. Linked from each row of the subscriptions list. The HTML is static —
// the slug is parsed client-side from the path, so nothing user-controlled is
// ever templated into the markup.
subscriptionsApp.get('/dj/:slug', (c) => servePage(c, DJ_PAGE.html))

/**
 * Set list for one DJ (backs the profile page). Served from a KV cache of the
 * DJ-index crawl merged with the sync state's discovered URLs, fresh for 6 h
 * and served stale (or from the sync state) while a background crawl
 * refreshes it; pass `?refresh=1` to force a crawl now (the page's Refresh
 * button does).
 */
subscriptionsApp.get('/api/dj/:slug', async (c) => {
  const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'subs.dj_sets', by: c.get('cfAccessEmail') })
  const slug = parseDjSlug(c.req.param('slug'))
  if (!slug) return c.json({ error: 'invalid_slug' }, 400)
  const refresh = c.req.query('refresh') === '1'
  log.info('subs.dj_sets.start', { slug, refresh })
  try {
    // A stale or state-only list comes back at once; the crawl refreshes the cache in the background.
    const defer = (p: Promise<unknown>) => {
      try {
        c.executionCtx.waitUntil(p)
      } catch {
        /* no executionCtx (tests): the promise still runs */
      }
    }
    const [sets, subs] = await Promise.all([getDjSets(c.env, slug, { refresh, log, defer }), listSubscriptions(c.env)])
    if (sets.sets.length === 0) {
      // Nothing from the crawl OR the sync state — either a bad slug or an
      // upstream block. 502 (not 404) so the UI says "retry", since we can't
      // tell the two apart without a page fingerprint.
      log.warn('subs.dj_sets.empty', { slug, stopReason: sets.stopReason })
      return c.json({ error: 'upstream_error', message: `no sets found (crawl: ${sets.stopReason}) — unknown DJ, or 1001tracklists is blocking us; try again shortly` }, 502)
    }
    return c.json({ ...sets, subscribed: subs.some((s) => s.slug === slug), sourceUrl: djUrlFor(slug) })
  } catch (e) {
    if (e instanceof IPBlockedError) {
      log.error('subs.dj_sets.ip_blocked', { slug, clientIp: e.clientIp })
      return c.json({ error: 'upstream_error', message: `1001 crawl: ip_blocked (${e.clientIp ?? 'unknown'})` }, 502)
    }
    if (e instanceof CloudflareChallengeError) {
      log.error('subs.dj_sets.cf_challenge', { slug, errorMessage: e.message })
      return c.json({ error: 'upstream_error', message: `1001 crawl: cf_challenge — ${e.message}` }, 502)
    }
    log.error('subs.dj_sets.throw', { slug, ...errorFields(e) })
    return c.json({ error: 'upstream_error', message: `1001 crawl: ${(e as Error).message}` }, 502)
  }
})

subscriptionsApp.post('/api/tracklist', async (c) => {
  const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'subs.tracklist', by: c.get('cfAccessEmail') })
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  const rawUrl = typeof (body as { url?: unknown })?.url === 'string' ? (body as { url: string }).url : ''
  if (!rawUrl) return c.json({ error: 'missing_url' }, 400)
  const tracklistUrl = normalizeTracklistUrl(rawUrl)
  if (!tracklistUrl) {
    log.warn('subs.tracklist.bad_url', { url: rawUrl })
    return c.json({ error: 'invalid_url', message: 'not a 1001tracklists tracklist URL' }, 400)
  }
  // Per-track links are NOT resolved here: each one is a budgeted pool page
  // view. The viewer asks for them lazily (POST /api/tracklist/links) for the
  // rows the owner opens, or all at once behind a "Load links" button.
  log.info('subs.tracklist.start', { tracklistUrl })
  try {
    const full = await resolveFullTracklist(c.env, tracklistUrl, { resolveLinks: false }, log)
    if (full.tracks.length === 0) {
      log.warn('subs.tracklist.empty', { tracklistUrl })
      return c.json({ error: 'upstream_error', message: 'parsed 0 tracks (likely a transient captcha) — try again shortly' }, 502)
    }
    return c.json({
      tracklistUrl,
      slug: full.slug,
      setAppleLink: full.setAppleLink,
      setYoutubeLink: full.setYoutubeLink,
      setSoundcloudLink: full.setSoundcloudLink,
      trackCount: full.tracks.length,
      tracks: full.tracks,
      fetchedAt: full.fetchedAt,
      cacheAgeSeconds: full.cacheAgeSeconds,
    })
  } catch (e) {
    if (e instanceof IPBlockedError) {
      log.error('subs.tracklist.ip_blocked', { tracklistUrl, clientIp: e.clientIp })
      return c.json({ error: 'upstream_error', message: `1001 scrape: ip_blocked (${e.clientIp ?? 'unknown'})` }, 502)
    }
    if (e instanceof CloudflareChallengeError) {
      log.error('subs.tracklist.cf_challenge', { tracklistUrl, errorMessage: e.message })
      return c.json({ error: 'upstream_error', message: `1001 scrape: cf_challenge — ${e.message}` }, 502)
    }
    log.error('subs.tracklist.throw', { tracklistUrl, ...errorFields(e) })
    return c.json({ error: 'upstream_error', message: `1001 scrape: ${(e as Error).message}` }, 502)
  }
})

/** Most track ids one lazy-links request may ask for (the viewer batches "Load links" by this). */
export const LAZY_LINKS_MAX_IDS = 25

// Lazy per-track links for the viewers: `{ trackIds: ["909720", ...] }` →
// `{ links: { "909720": { appleLink, youtubeLink, soundcloudLink } } }`.
// Cached per track id for 30 days; a miss is one pool page view at priority
// `recheck` (never `phone`: this is the admin page, not someone on the road).
subscriptionsApp.post('/api/tracklist/links', async (c) => {
  const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'subs.tracklist_links', by: c.get('cfAccessEmail') })
  const body = (await c.req.json().catch(() => null)) as { trackIds?: unknown } | null
  const raw = Array.isArray(body?.trackIds) ? body!.trackIds : null
  if (!raw || raw.length === 0) return c.json({ error: 'missing_track_ids', message: 'trackIds: a non-empty array of numeric 1001tracklists track ids' }, 400)
  const ids = [...new Set(raw.filter((x): x is string => typeof x === 'string' && /^\d{1,12}$/.test(x)))]
  if (ids.length !== raw.length && ids.length === 0) return c.json({ error: 'invalid_track_ids', message: 'track ids are numeric strings' }, 400)
  if (ids.length > LAZY_LINKS_MAX_IDS) return c.json({ error: 'too_many', message: `at most ${LAZY_LINKS_MAX_IDS} track ids per request` }, 400)
  const links: Record<string, { appleLink: string | null; youtubeLink: string | null; soundcloudLink: string | null }> = {}
  // One at a time: the pool paces its accounts; a refusal stops the batch.
  for (const id of ids) {
    try {
      links[id] = await resolveTrackMediaLinks(c.env, id, log, 'recheck')
    } catch (e) {
      log.warn('subs.tracklist_links.stopped', { id, done: Object.keys(links).length, ...errorFields(e) })
      try { await noteTrackYoutubeLinks(c.env, links) } catch {}
      return c.json({ links, error: 'upstream_error', message: `stopped after ${Object.keys(links).length} of ${ids.length}: ${(e as Error).message}` }, 502)
    }
  }
  try { await noteTrackYoutubeLinks(c.env, links) } catch {}
  return c.json({ links })
})

// "Refresh track list" on the viewer: purge the cached list and refetch it now
// (lib/tracklist-purge.ts, same as the bearer POST /tracklist/purge).
subscriptionsApp.post('/api/tracklist/purge', async (c) => {
  const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'subs.tracklist_purge', by: c.get('cfAccessEmail') })
  const body = (await c.req.json().catch(() => null)) as { url?: unknown; slug?: unknown; videoId?: unknown } | null
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const target = await resolvePurgeTarget(c.env, { url: str(body?.url), slug: str(body?.slug), videoId: str(body?.videoId) })
  if (!target.ok) return c.json({ error: target.error, message: target.message }, target.status)
  const r = await purgeAndRefetch(c.env, target.tracklistUrl, log)
  return r.ok ? c.json(r.summary) : c.json({ error: r.error, message: r.message, stale: r.stale, fetchedAt: r.fetchedAt }, r.status)
})

/**
 * Video inspector: paste any YouTube URL (or bare id), get the raw
 * `videos.list` JSON back. Read-only and side-effect free — no tracklist
 * lookup, no playlist writes, nothing cached. Uses the read-only
 * YOUTUBE_API_KEY (1 quota unit per call), not the OAuth token.
 */
subscriptionsApp.get('/api/youtube/video', async (c) => {
  const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'subs.yt_video', by: c.get('cfAccessEmail') })
  const input = (c.req.query('url') || '').trim()
  if (!input) return c.json({ error: 'missing_url' }, 400)
  const videoId = extractVideoId(input)
  if (!videoId) {
    log.warn('subs.yt_video.bad_url', { input })
    return c.json({ error: 'invalid_url', message: 'not a YouTube video URL or 11-character video id' }, 400)
  }
  if (!c.env.YOUTUBE_API_KEY) {
    log.error('subs.yt_video.no_api_key')
    return c.json({ error: 'not_configured', message: 'YOUTUBE_API_KEY is not set' }, 500)
  }
  try {
    const video = await fetchVideoDetails(videoId, c.env.YOUTUBE_API_KEY, log)
    if (!video) {
      return c.json({ error: 'not_found', videoId, message: 'no video with that id (deleted, private, or never existed)' }, 404)
    }
    return c.json({ videoId, watchUrl: `https://www.youtube.com/watch?v=${videoId}`, video })
  } catch (e) {
    if (e instanceof YouTubeApiError) {
      log.error('subs.yt_video.api_error', { videoId, status: e.status, body: e.body.slice(0, 500) })
      // 502: the failure is upstream (bad key, quota exhausted, …), not in this request.
      return c.json({ error: 'upstream_error', videoId, status: e.status, message: e.body.slice(0, 2000) }, 502)
    }
    log.error('subs.yt_video.throw', { videoId, ...errorFields(e) })
    return c.json({ error: 'upstream_error', videoId, message: (e as Error).message }, 502)
  }
})

subscriptionsApp.get('/api/list', async (c) => {
  const subs = await listSubscriptions(c.env)
  return c.json({ subscriptions: subs })
})

subscriptionsApp.post('/api/add', async (c) => {
  const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'subs.add' })
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  const url = typeof (body as { url?: unknown })?.url === 'string' ? (body as { url: string }).url : ''
  if (!url) return c.json({ error: 'missing_url' }, 400)
  try {
    const result = await addSubscription(c.env, url)
    log.info('subs.add', { added: result.added, slug: result.subscription.slug, by: c.get('cfAccessEmail') })
    return c.json(result)
  } catch (e) {
    if (e instanceof InvalidSubscriptionInput) {
      return c.json({ error: 'invalid_url', message: e.message }, 400)
    }
    log.error('subs.add_throw', errorFields(e))
    return c.json({ error: 'internal' }, 500)
  }
})

subscriptionsApp.post('/api/remove', async (c) => {
  const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'subs.remove' })
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  const slug = typeof (body as { slug?: unknown })?.slug === 'string' ? (body as { slug: string }).slug : ''
  if (!slug) return c.json({ error: 'missing_slug' }, 400)
  try {
    const removed = await removeSubscription(c.env, slug)
    log.info('subs.remove', { slug, removed, by: c.get('cfAccessEmail') })
    return c.json({ removed })
  } catch (e) {
    if (e instanceof InvalidSubscriptionInput) {
      return c.json({ error: 'invalid_slug', message: e.message }, 400)
    }
    log.error('subs.remove_throw', errorFields(e))
    return c.json({ error: 'internal' }, 500)
  }
})

// ─── Sync (scrape + add to playlist) ────────────────────────────────────────

subscriptionsApp.post('/api/sync', async (c) => {
  const log = makeLogger({
    reqId: c.req.raw.headers.get('cf-ray') ?? 'local',
    route: 'subs.sync_all',
    by: c.get('cfAccessEmail'),
  })
  try {
    const result = await syncAll(c.env, { log, trigger: 'manual.all' })
    return c.json(result)
  } catch (e) {
    if (e instanceof GoogleOAuthRefreshFailed && e.invalidGrant) {
      log.warn('subs.sync_all_reauth', { status: e.status })
      return c.json({ error: 'youtube_reauth_required', message: 'YouTube refresh token rejected by Google; reconnect required.' }, 412)
    }
    log.error('subs.sync_all_throw', errorFields(e))
    return c.json({ error: 'sync_failed', ...errorFields(e) }, 500)
  }
})

subscriptionsApp.post('/api/sync/:slug', async (c) => {
  const log = makeLogger({
    reqId: c.req.raw.headers.get('cf-ray') ?? 'local',
    route: 'subs.sync_one',
    by: c.get('cfAccessEmail'),
  })
  const slug = c.req.param('slug')
  try {
    const subs = await listSubscriptions(c.env)
    const sub = subs.find((s) => s.slug === slug)
    if (!sub) return c.json({ error: 'not_subscribed', slug }, 404)
    // syncOne needs a fresh access token; the helper auto-refreshes near expiry.
    const tokenInfo = await getAccessToken(c.env)
    if (!tokenInfo) return c.json({ error: 'youtube_not_connected' }, 412)
    // Same per-account pacing as the cron: a button press is not exempt from
    // 1001tracklists' rate limit (an unpaced run got the accounts banned).
    const fetchBudget = await manualFetchBudget(c.env, log)
    const result = await syncOne(c.env, sub, tokenInfo.accessToken, { log, trigger: 'manual.one', fetchBudget })
    return c.json({ ...result, fetchesSpent: fetchBudget.spent, fetchBudget: fetchBudget.limit })
  } catch (e) {
    if (e instanceof GoogleOAuthRefreshFailed && e.invalidGrant) {
      log.warn('subs.sync_one_reauth', { slug, status: e.status })
      return c.json({ error: 'youtube_reauth_required', message: 'YouTube refresh token rejected by Google; reconnect required.' }, 412)
    }
    log.error('subs.sync_one_throw', { slug, ...errorFields(e) })
    return c.json({ error: 'sync_failed', ...errorFields(e) }, 500)
  }
})

/**
 * "Invalidate video cache & resync" for one DJ: mark every processed set due
 * for an immediate recheck (its recorded video is kept, so a swapped recording
 * is detected and the old one removed), drop the cached playlist membership so
 * it's re-read from YouTube, then run one sync. The run is bounded like any
 * other (new sets + a capped batch of rechecks); the 5-minute cron drains the
 * rest. The "all artists" button in the panel calls this once per row.
 */
subscriptionsApp.post('/api/resync/:slug', async (c) => {
  const log = makeLogger({
    reqId: c.req.raw.headers.get('cf-ray') ?? 'local',
    route: 'subs.resync_one',
    by: c.get('cfAccessEmail'),
  })
  const slug = c.req.param('slug')
  try {
    const subs = await listSubscriptions(c.env)
    const sub = subs.find((s) => s.slug === slug)
    if (!sub) return c.json({ error: 'not_subscribed', slug }, 404)
    const tokenInfo = await getAccessToken(c.env)
    if (!tokenInfo) return c.json({ error: 'youtube_not_connected' }, 412)
    const invalidated = await invalidateVideoCache(c.env, slug, log)
    const fetchBudget = await manualFetchBudget(c.env, log)
    const result = await syncOne(c.env, sub, tokenInfo.accessToken, { log, trigger: 'manual.resync', fetchBudget })
    return c.json({ ...result, invalidated, fetchesSpent: fetchBudget.spent, fetchBudget: fetchBudget.limit })
  } catch (e) {
    if (e instanceof GoogleOAuthRefreshFailed && e.invalidGrant) {
      log.warn('subs.resync_one_reauth', { slug, status: e.status })
      return c.json({ error: 'youtube_reauth_required', message: 'YouTube refresh token rejected by Google; reconnect required.' }, 412)
    }
    log.error('subs.resync_one_throw', { slug, ...errorFields(e) })
    return c.json({ error: 'resync_failed', ...errorFields(e) }, 500)
  }
})

/**
 * "Invalidate video cache & resync all": one server-side pass over every DJ
 * on a single shared fetch budget (lib/sync.ts resyncAll). The panel used to
 * call /api/resync/<slug> once per row instead — each call unpaced — which is
 * what tripped the 1001tracklists rate limit on 2026-09-10 and 2026-09-14.
 */
subscriptionsApp.post('/api/resync', async (c) => {
  const log = makeLogger({
    reqId: c.req.raw.headers.get('cf-ray') ?? 'local',
    route: 'subs.resync_all',
    by: c.get('cfAccessEmail'),
  })
  try {
    const result = await resyncAll(c.env, { log, trigger: 'manual.resync' })
    return c.json(result)
  } catch (e) {
    if (e instanceof GoogleOAuthRefreshFailed && e.invalidGrant) {
      log.warn('subs.resync_all_reauth', { status: e.status })
      return c.json({ error: 'youtube_reauth_required', message: 'YouTube refresh token rejected by Google; reconnect required.' }, 412)
    }
    log.error('subs.resync_all_throw', errorFields(e))
    return c.json({ error: 'resync_failed', ...errorFields(e) }, 500)
  }
})

/**
 * "Fix playlist titles": rename managed DJ playlists still titled
 * "Tracklists By X (1001tklists)" (the July 2026 redesign's H1 leaked into the
 * stored artist names) to "X (1001tklists)" (lib/playlist-rename.ts). Body
 * `{ dryRun?: boolean }`, default true: nothing is renamed unless dryRun is
 * false. Answers the old and new titles.
 */
subscriptionsApp.post('/api/playlists/fix-titles', async (c) => {
  const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'subs.fix_titles', by: c.get('cfAccessEmail') })
  const body = (await c.req.json().catch(() => ({}))) as { dryRun?: unknown }
  if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') return c.json({ error: 'invalid_request', message: 'dryRun must be true or false' }, 400)
  const dryRun = body.dryRun !== false
  let tokenInfo
  try {
    tokenInfo = await getAccessToken(c.env)
  } catch (e) {
    if (e instanceof GoogleOAuthRefreshFailed && e.invalidGrant) return c.json({ error: 'youtube_reauth_required', message: 'YouTube refresh token rejected by Google; reconnect required.' }, 412)
    throw e
  }
  if (!tokenInfo) return c.json({ error: 'youtube_not_connected', message: 'connect YouTube first' }, 503)
  try {
    const r = await fixPlaylistTitles(c.env, tokenInfo.accessToken, { dryRun, log })
    log.info('subs.fix_titles.done', { dryRun, checked: r.checked, fixes: r.fixes.length })
    return c.json(r)
  } catch (e) {
    log.error('subs.fix_titles.throw', errorFields(e))
    return c.json({ error: 'upstream_error', message: (e as Error).message }, 502)
  }
})

// ─── Combined "all tracked artists" playlist ────────────────────────────────

/**
 * Read-only summary of the combined playlist: what's in it, how much of the
 * artist playlists it's still missing, and how much of today's insert budget
 * is left. Never creates the playlist — that's the backfill's job.
 */
subscriptionsApp.get('/api/combined', async (c) => {
  const log = makeLogger({
    reqId: c.req.raw.headers.get('cf-ray') ?? 'local',
    route: 'subs.combined_status',
    by: c.get('cfAccessEmail'),
  })
  try {
    return c.json(await combinedPlaylistStatus(c.env, { log }))
  } catch (e) {
    if (e instanceof GoogleOAuthRefreshFailed && e.invalidGrant) {
      return c.json({ error: 'youtube_reauth_required', message: 'YouTube refresh token rejected by Google; reconnect required.' }, 412)
    }
    log.error('subs.combined_status_throw', errorFields(e))
    return c.json({ error: 'combined_status_failed', ...errorFields(e) }, 500)
  }
})

/**
 * Run one bounded reconciliation pass now. Same work the crons do — the button
 * exists so a fresh install (or a just-added DJ) doesn't have to wait for the
 * next tick. Bounded by the same per-run and per-day insert caps, so clicking
 * it repeatedly can't blow the YouTube quota.
 */
subscriptionsApp.post('/api/combined/backfill', async (c) => {
  const log = makeLogger({
    reqId: c.req.raw.headers.get('cf-ray') ?? 'local',
    route: 'subs.combined_backfill',
    by: c.get('cfAccessEmail'),
  })
  try {
    const result = await backfillCombined(c.env, { log, trigger: 'manual.combined' })
    if (!result.ok && result.reason === 'youtube_not_connected') {
      return c.json({ error: 'youtube_not_connected' }, 412)
    }
    return c.json(result)
  } catch (e) {
    if (e instanceof GoogleOAuthRefreshFailed && e.invalidGrant) {
      log.warn('subs.combined_backfill_reauth', { status: e.status })
      return c.json({ error: 'youtube_reauth_required', message: 'YouTube refresh token rejected by Google; reconnect required.' }, 412)
    }
    log.error('subs.combined_backfill_throw', errorFields(e))
    return c.json({ error: 'backfill_failed', ...errorFields(e) }, 500)
  }
})

subscriptionsApp.get('/api/state/:slug', async (c) => {
  const slug = c.req.param('slug')
  const state = await loadSubState(c.env, slug)
  return c.json({ slug, state })
})

// ─── tlpool scheduler settings (routes/pool-api.ts) ─────────────────────────

// GET/PUT /ui/api/pool/settings, behind the same CF Access gate.
subscriptionsApp.route('/api/pool', poolSettingsApp)

// ─── IP-ban state, Web Push, service worker ──────────────────────────────────

/**
 * Everything the banner + history section need in one call: KV pause/ban
 * state (lib/ban-state.ts), whether tlpool is configured, and — with
 * `?live=1` — the push subscriptions.
 */
subscriptionsApp.get('/api/ban/status', async (c) => {
  const live = c.req.query('live') === '1'
  const status = await getBanStatus(c.env)
  const poolConfigured = !!(c.env.TLPOOL_URL && c.env.TLPOOL_TOKEN)
  const pushSubscriptions = live
    ? (await listPushSubscriptions(c.env)).map((p) => ({ id: p.id, ua: p.ua, createdAt: p.createdAt, lastOkAt: p.lastOkAt, lastError: p.lastError }))
    : undefined
  return c.json({ ...status, poolConfigured, pushSubscriptions })
})

/** Manual dismiss: ends the open episode (real or simulated) and hides the banner. Never lifts `ban:pause` (operator only). */
subscriptionsApp.post('/api/ban/clear', async (c) => {
  const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'subs.ban_clear', by: c.get('cfAccessEmail') })
  const ep = await manualClear(c.env, log)
  return c.json({ cleared: !!ep, episode: ep })
})

/** Test hook: open a simulated episode so the banner + push path can be seen end to end. */
subscriptionsApp.post('/api/ban/simulate', async (c) => {
  const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'subs.ban_simulate', by: c.get('cfAccessEmail') })
  const home = await simulateBan(c.env, log)
  return c.json({ home })
})

/**
 * One-time repair after a ban: re-queue sets that were abandoned only because
 * every fetch route was blocked. `?days=N` (default 14), `?dry=1` to preview.
 */
subscriptionsApp.post('/api/ban/requeue-victims', async (c) => {
  const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'subs.requeue_victims', by: c.get('cfAccessEmail') })
  const days = Number(c.req.query('days') ?? 14)
  const dryRun = c.req.query('dry') === '1'
  const r = await requeueBanVictims(c.env, { days: Number.isFinite(days) && days > 0 ? days : 14, dryRun, log })
  return c.json(r)
})

subscriptionsApp.get('/api/push/config', async (c) => {
  return c.json({ configured: pushConfigured(c.env), publicKey: c.env.VAPID_PUBLIC_KEY ?? null })
})

subscriptionsApp.post('/api/push/subscribe', async (c) => {
  const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'subs.push_subscribe', by: c.get('cfAccessEmail') })
  const body = (await c.req.json().catch(() => null)) as { subscription?: unknown; ua?: unknown } | null
  if (!body || !isPushSubscription(body.subscription)) return c.json({ error: 'invalid_subscription' }, 400)
  const ua = typeof body.ua === 'string' ? body.ua.slice(0, 300) : (c.req.header('user-agent') ?? null)
  const saved = await savePushSubscription(c.env, body.subscription, ua)
  log.info('subs.push_subscribed', { id: saved.id, ua })
  return c.json({ id: saved.id, createdAt: saved.createdAt })
})

subscriptionsApp.post('/api/push/unsubscribe', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { endpoint?: unknown; id?: unknown } | null
  const key = typeof body?.endpoint === 'string' ? body.endpoint : typeof body?.id === 'string' ? body.id : null
  if (!key) return c.json({ error: 'missing_endpoint' }, 400)
  return c.json({ removed: await deletePushSubscription(c.env, key) })
})

/** Fire a test push to every subscribed device so delivery can be checked without a real ban. */
subscriptionsApp.post('/api/push/test', async (c) => {
  const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'subs.push_test', by: c.get('cfAccessEmail') })
  if (!pushConfigured(c.env)) return c.json({ error: 'push_not_configured' }, 412)
  const r = await sendPushToAll(c.env, testPayload(), log)
  return c.json(r)
})

/**
 * The service worker behind the Notifications API. Same-origin and inside the
 * /ui/ scope, so it rides on the CF Access cookie like the pages.
 */
subscriptionsApp.get('/sw.js', (c) => {
  c.header('Content-Type', 'application/javascript; charset=utf-8')
  c.header('Cache-Control', 'no-cache')
  return c.body(SW_JS)
})


// ─── Audit trail (Recent requests) ──────────────────────────────────────────

/**
 * Newest-first page of /now-playing audit summaries (the `now_playing_audit`
 * table, lib/now-playing-audit.ts). Each record carries `key` — the row id —
 * for the detail endpoint. Pass `cursor` (from a prior response) to page into
 * older records. Behind CF Access like everything here.
 */
subscriptionsApp.get('/api/audit', async (c) => {
  const n = parseInt(c.req.query('limit') || '50', 10)
  const limit = Number.isFinite(n) ? n : 50
  const page = await listNowPlayingAudit(c.env, { limit, cursor: c.req.query('cursor') || null })
  return c.json({ records: page.records, cursor: page.cursor, listComplete: page.cursor === null })
})

/** Full audit record for one request (`key` = the row id from /api/audit). */
subscriptionsApp.get('/api/audit-detail', async (c) => {
  const key = c.req.query('key') || ''
  if (!/^\d+$/.test(key)) return c.json({ error: 'bad_key' }, 400)
  const record = await getNowPlayingAudit(c.env, key)
  if (!record) return c.json({ error: 'not_found' }, 404)
  return c.json({ record })
})

// ─── Audit trail (Recent playlist additions) ────────────────────────────────

/**
 * Newest-first page of the sync's per-set audit rows (the `playlist_additions`
 * table, lib/playlist-audit.ts). Same contract as /api/audit above.
 */
subscriptionsApp.get('/api/playlist-additions', async (c) => {
  const n = parseInt(c.req.query('limit') || '50', 10)
  const limit = Number.isFinite(n) ? n : 50
  const page = await listPlaylistAdditions(c.env, { limit, cursor: c.req.query('cursor') || null })
  return c.json({ records: page.records, cursor: page.cursor, listComplete: page.cursor === null })
})

/** Full audit record for one processed set (`key` = the row id from /api/playlist-additions). */
subscriptionsApp.get('/api/playlist-addition-detail', async (c) => {
  const key = c.req.query('key') || ''
  if (!/^\d+$/.test(key)) return c.json({ error: 'bad_key' }, 400)
  const record = await getPlaylistAddition(c.env, key)
  if (!record) return c.json({ error: 'not_found' }, 404)
  return c.json({ record })
})

/** Progress of the one-time KV → D1 import the cron drives (lib/kv-import.ts). */
subscriptionsApp.get('/api/migration', async (c) => c.json(await migrationStatus(c.env)))

// ─── mkvid uploads ──────────────────────────────────────────────────────────

/** The two lists the panel pages independently; `all` is both (and the only one that carries the header). */
const MKVID_SECTIONS = ['all', 'queue', 'settled'] as const
type MkvidSection = (typeof MKVID_SECTIONS)[number]

/**
 * `?status=failed,banned&source=hearthis&account=shared&dj=<slug>&q=palmer` —
 * every part optional. An unknown value is a 400 rather than a silently empty
 * list: a typo in a filter should not read as "nothing queued".
 */
function mkvidQuery(url: URL): { filter: MkvidFilter; section: MkvidSection; limit: number; queueCursor: string | null; settledCursor: string | null } | { error: string } {
  const p = url.searchParams
  const statuses = (p.get('status') || '').split(',').map((x) => x.trim()).filter(Boolean)
  for (const s of statuses) if (!MKVID_STATUSES.includes(s as MkvidStatus)) return { error: `unknown status: ${s}` }
  const source = p.get('source') || null
  if (source && !MKVID_SOURCES.includes(source as MkvidSourceKind)) return { error: `unknown source: ${source}` }
  const account = p.get('account') || null
  if (account && !MKVID_ACCOUNTS.includes(account as MkvidAccount)) return { error: `unknown account: ${account}` }
  const section = (p.get('section') || 'all') as MkvidSection
  if (!MKVID_SECTIONS.includes(section)) return { error: `unknown section: ${section}` }
  const n = parseInt(p.get('limit') || '50', 10)
  return {
    filter: {
      statuses: statuses as MkvidStatus[],
      source: source as MkvidSourceKind | null,
      account: account as MkvidAccount | null,
      slug: p.get('dj') || null,
      // Long enough for a set title, short enough that the LIKE stays cheap.
      q: (p.get('q') || '').trim().slice(0, 120) || null,
    },
    section,
    limit: Number.isFinite(n) ? n : 50,
    queueCursor: p.get('queueCursor'),
    settledCursor: p.get('settledCursor'),
  }
}

const EMPTY_PAGE = { records: [], cursor: null, total: 0 }

/**
 * The mkvid queue (lib/mkvid.ts): what has been rendered (or is rendering, or
 * failed), the waiting line in the order it will be served, and the three
 * things that decide whether anything moves — the daily claim cap, how much of
 * it is used, and when mkvid last polled.
 *
 * Both lists are filterable (see `mkvidQuery`) and paged by keyset cursor:
 * each response hands back `queueCursor` / `settledCursor`, which come back as
 * query params for the next page. `section=queue|settled` asks for one list's
 * next page alone — the header and the other list are then left out.
 */
subscriptionsApp.get('/api/mkvid', async (c) => {
  const parsed = mkvidQuery(new URL(c.req.url))
  if ('error' in parsed) return c.json({ error: 'invalid_request', message: parsed.error }, 400)
  const { filter, section, limit } = parsed
  const [settled, queue, counts, accounts, lastPoll, djs, oldStyleCount, oldVideos] = await Promise.all([
    section === 'queue' ? EMPTY_PAGE : listMkvidSettledPage(c.env, { ...filter, limit, cursor: parsed.settledCursor }),
    section === 'settled' ? EMPTY_PAGE : listMkvidQueuePage(c.env, { ...filter, limit, cursor: parsed.queueCursor }),
    countMkvidRequests(c.env),
    mkvidAccountUsage(c.env),
    getMkvidLastPoll(c.env),
    listMkvidDjs(c.env),
    countOldStyleVideos(c.env),
    listUndeletedOldVideos(c.env),
  ])
  // Why each waiting set is (not) next: unverified, waiting for IDs until <t>, backoff, or ready (the panel adds "capped").
  const readiness = await readinessFor(c.env, [...queue.records, ...settled.records.filter((r) => r.status === 'claimed' || r.status === 'failed')])
  const withReadiness = (r: Parameters<typeof requestSummary>[0]) => ({ ...requestSummary(r), readiness: readiness.get(r.id) ?? null })
  return c.json({
    enabled: !!c.env.MKVID_TOKEN,
    counts,
    /** Done videos made with a style other than scene (unknown counts): what "Recreate all old-style videos" would queue. */
    oldStyleCount,
    /** Videos a recreation replaced that are not deleted from YouTube yet (pending retry, or refused by mkvid). */
    oldVideos,
    /** Per Google project (fill order): today's claims vs cap. The totals below are their sums. */
    accounts,
    dailyClaims: accounts.reduce((n, a) => n + a.used, 0),
    dailyClaimCap: accounts.reduce((n, a) => n + a.cap, 0),
    /** Unix seconds when the quota day rolls over (midnight Pacific). */
    quotaResetsAt: quotaDayEnd(),
    /** mkvid's last `/mkvid/claim` poll; `at` is refreshed at most every 10 min while the outcome is unchanged. */
    lastPoll,
    now: Math.floor(Date.now() / 1000),
    /** Echoed back so the panel can tell which filter a response belongs to. */
    filter: { status: filter.statuses, source: filter.source, account: filter.account, dj: filter.slug, q: filter.q },
    section,
    limit,
    /** Every DJ the queue has ever held, most requests first — the `dj=` filter's options. */
    djs,
    settled: settled.records.map(withReadiness),
    settledCursor: settled.cursor,
    /** Rows matching the filter in each list, not just the ones on this page. */
    settledTotal: settled.total,
    /** Pending requests in claim order (newest set first), each with its `position` in the whole queue. */
    queue: queue.records.map(withReadiness),
    queueCursor: queue.cursor,
    queueTotal: queue.total,
  })
})

/** Give a failed / superseded / stuck request a fresh start (mkvid picks it up on its next poll). */
subscriptionsApp.post('/api/mkvid/retry/:id', async (c) => {
  const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'subs.mkvid_retry', by: c.get('cfAccessEmail') })
  const id = c.req.param('id')
  const ok = await retryMkvidRequest(c.env, id)
  log.info('subs.mkvid_retry', { id, ok })
  return c.json({ ok, id }, ok ? 200 : 404)
})

/** Reorder the waiting line: { to: top | up | down | bottom }. 404 when the request is not pending. */
subscriptionsApp.post('/api/mkvid/move/:id', async (c) => {
  const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'subs.mkvid_move', by: c.get('cfAccessEmail') })
  const id = c.req.param('id')
  const body = (await c.req.json().catch(() => null)) as { to?: unknown } | null
  const to = body?.to
  if (typeof to !== 'string' || !(MKVID_MOVES as readonly string[]).includes(to)) return c.json({ error: 'invalid_request', message: 'to must be top, up, down or bottom' }, 400)
  const r = await moveMkvidRequest(c.env, id, to as MkvidMove)
  log.info('subs.mkvid_move', { id, to, ...(r ?? { ok: false }) })
  return r ? c.json({ ok: true, id, to, ...r }) : c.json({ error: 'not_pending', id }, 404)
})

/** Never upload this set via mkvid (pending / failed / superseded only; Retry lifts it). */
subscriptionsApp.post('/api/mkvid/ban/:id', async (c) => {
  const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'subs.mkvid_ban', by: c.get('cfAccessEmail') })
  const id = c.req.param('id')
  const ok = await banMkvidRequest(c.env, id)
  log.info('subs.mkvid_ban', { id, ok })
  return c.json({ ok, id }, ok ? 200 : 409)
})

/** "Render now": skip the 7-day wait for IDs on this request (a verified list is still required). */
subscriptionsApp.post('/api/mkvid/render-now/:id', async (c) => {
  const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'subs.mkvid_render_now', by: c.get('cfAccessEmail') })
  const id = c.req.param('id')
  const ok = await setSkipIdWait(c.env, id)
  log.info('subs.mkvid_render_now', { id, ok })
  return c.json({ ok, id }, ok ? 200 : 409)
})

/**
 * "Delete and recreate" (done requests only): queue the set again at the back
 * of the queue; once the new video is delivered and in the playlists, the old
 * one is taken out and deleted from YouTube (lib/mkvid-recreate.ts).
 */
subscriptionsApp.post('/api/mkvid/recreate/:id', async (c) => {
  const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'subs.mkvid_recreate', by: c.get('cfAccessEmail') })
  const id = c.req.param('id')
  const r = await recreateMkvidRequest(c.env, id, log)
  log.info('subs.mkvid_recreate', { id, ...r })
  if (r.ok) return c.json(r)
  return c.json({ ...r, id }, r.error === 'not_found' ? 404 : 409)
})

/**
 * "Delete video" (done requests only): out of the playlists and off YouTube
 * now, the request back to pending; it renders again once the claim's gates
 * pass (lib/mkvid-recreate.ts unpublishMkvidRequest).
 */
subscriptionsApp.post('/api/mkvid/unpublish/:id', async (c) => {
  const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'subs.mkvid_unpublish', by: c.get('cfAccessEmail') })
  return unpublishResponse(c, c.req.param('id'), log)
})

/** The render mkvid is working on now, as weighted stages (the page's progress bar); `running: null` when it is idle. */
subscriptionsApp.get('/api/mkvid/progress', async (c) => {
  const r = await fetchMkvidRenderProgress(c.env)
  if (!r.ok) return c.json({ error: 'mkvid_unavailable', message: r.error }, 503)
  return c.json({ running: r.running })
})

/** How many videos "Recreate all old-style videos" would queue — the confirm step. */
subscriptionsApp.get('/api/mkvid/recreate-old-style', async (c) => c.json({ count: await countOldStyleVideos(c.env) }))

/** Queue every old-style video for recreation. Body `{ expect: <count shown in the confirm> }`; 409 with the fresh count when it changed. */
subscriptionsApp.post('/api/mkvid/recreate-old-style', async (c) => {
  const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'subs.mkvid_recreate_old_style', by: c.get('cfAccessEmail') })
  const body = (await c.req.json().catch(() => null)) as { expect?: unknown } | null
  const expect = body?.expect
  if (typeof expect !== 'number' || !Number.isInteger(expect) || expect < 0) return c.json({ error: 'invalid_request', message: 'expect must be the confirmed count' }, 400)
  const r = await recreateOldStyleVideos(c.env, expect, log)
  log.info('subs.mkvid_recreate_old_style', { expect, ...r })
  return r.ok ? c.json(r) : c.json(r, 409)
})

/** Try deleting a replaced video again now (a pending or refused one). */
subscriptionsApp.post('/api/mkvid/old-videos/:videoId/retry', async (c) => {
  const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'subs.mkvid_old_video_retry', by: c.get('cfAccessEmail') })
  const videoId = c.req.param('videoId')
  if (!(await resetOldVideoDelete(c.env, videoId))) return c.json({ error: 'not_found', videoId }, 404)
  const r = await deleteOldVideo(c.env, videoId, log)
  return c.json({ ok: r?.state === 'deleted', oldVideo: r })
})

// ─── YouTube / Google OAuth ─────────────────────────────────────────────────

subscriptionsApp.get('/api/youtube/status', async (c) => {
  const t = await loadTokens(c.env)
  if (!t) return c.json({ connected: false })
  return c.json({
    connected: true,
    channelId: t.channelId,
    channelTitle: t.channelTitle,
    scope: t.scope,
    connectedAt: t.connectedAt,
    // expiresAt is the ACCESS token's expiry; the refresh token's lifetime is
    // governed by Google, surfaced only when revoked.
    accessTokenExpiresAt: t.expiresAt,
  })
})

subscriptionsApp.get('/oauth/start', async (c) => {
  const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'oauth.start' })
  if (!c.env.GOOGLE_OAUTH_CLIENT_ID || !c.env.GOOGLE_OAUTH_CLIENT_SECRET) {
    log.error('oauth.start.misconfigured')
    return c.text('GOOGLE_OAUTH_CLIENT_ID/SECRET not configured', 500)
  }
  const state = randomState()
  const redirectUri = redirectUriFor(c.req.url)
  setCookie(c, STATE_COOKIE, state, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/ui/oauth',
    maxAge: 60 * 5,
  })
  const url = buildAuthUrl({ clientId: c.env.GOOGLE_OAUTH_CLIENT_ID, redirectUri, state })
  log.info('oauth.start.redirect', { redirectUri, by: c.get('cfAccessEmail') })
  return c.redirect(url, 302)
})

subscriptionsApp.get('/oauth/callback', async (c) => {
  const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'oauth.callback' })
  const url = new URL(c.req.url)
  const code = url.searchParams.get('code')
  const stateParam = url.searchParams.get('state')
  const stateCookie = getCookie(c, STATE_COOKIE)
  const errParam = url.searchParams.get('error')

  // Single-use cookie: clear regardless of outcome.
  deleteCookie(c, STATE_COOKIE, { path: '/ui/oauth' })

  if (errParam) {
    log.warn('oauth.callback.provider_error', { error: errParam })
    return c.redirect(`/ui/playlists?yt_error=${encodeURIComponent(errParam)}`, 302)
  }
  if (!code || !stateParam || !stateCookie || stateParam !== stateCookie) {
    log.warn('oauth.callback.state_mismatch', { hasCode: !!code, hasState: !!stateParam, hasCookie: !!stateCookie })
    return c.redirect('/ui/playlists?yt_error=state_mismatch', 302)
  }
  if (!c.env.GOOGLE_OAUTH_CLIENT_ID || !c.env.GOOGLE_OAUTH_CLIENT_SECRET) {
    log.error('oauth.callback.misconfigured')
    return c.text('GOOGLE_OAUTH_CLIENT_ID/SECRET not configured', 500)
  }

  try {
    const redirectUri = redirectUriFor(c.req.url)
    const tok = await exchangeCode({
      clientId: c.env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: c.env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirectUri,
      code,
    })
    const channel = await fetchChannelInfo(tok.accessToken).catch(() => null)
    const now = Math.floor(Date.now() / 1000)
    const stored: StoredTokens = {
      accessToken: tok.accessToken,
      refreshToken: tok.refreshToken,
      expiresAt: now + tok.expiresIn,
      scope: tok.scope,
      channelId: channel?.id ?? null,
      channelTitle: channel?.title ?? null,
      connectedAt: now,
    }
    await saveTokens(c.env, stored)
    log.info('oauth.callback.connected', {
      channelId: stored.channelId,
      channelTitle: stored.channelTitle,
      scope: stored.scope,
      by: c.get('cfAccessEmail'),
    })
    return c.redirect('/ui/playlists?yt=connected', 302)
  } catch (e) {
    log.error('oauth.callback.exchange_failed', errorFields(e))
    return c.redirect('/ui/playlists?yt_error=exchange_failed', 302)
  }
})

subscriptionsApp.post('/oauth/disconnect', async (c) => {
  const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'oauth.disconnect' })
  const t = await loadTokens(c.env)
  if (t) {
    // Revoke the refresh token (which also invalidates derived access tokens).
    await revokeToken(t.refreshToken)
    await clearTokens(c.env)
    log.info('oauth.disconnect.revoked', { channelTitle: t.channelTitle, by: c.get('cfAccessEmail') })
  }
  return c.json({ disconnected: true })
})

/** The Home page (src/ui/pages/home.ts); index.ts also serves it at /ui/. */
export const HOME_HTML = HOME_PAGE.html
