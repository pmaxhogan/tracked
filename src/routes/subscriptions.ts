import { Hono } from 'hono'
import type { Env } from '../types'
import { cfAccess } from '../middleware/cf-access'
import { servePage } from '../ui/pages'
import { SET_PAGE } from '../ui/pages/set'
import { DJ_PAGE } from '../ui/pages/dj'
import { MKVID_PAGE_HTML } from '../ui/pages/mkvid'
import {
  addSubscription,
  djUrlFor,
  InvalidSubscriptionInput,
  listSubscriptions,
  parseDjSlug,
  removeSubscription,
} from '../lib/subscriptions'
import { getDjSets } from '../lib/dj-sets'
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
import { countOldStyleVideos, deleteOldVideo, listUndeletedOldVideos, recreateMkvidRequest, recreateOldStyleVideos, resetOldVideoDelete } from '../lib/mkvid-recreate'
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
import { ALERTS_ROW_HTML, BAN_BANNER_HTML, BAN_CSS, BAN_HISTORY_HTML, BAN_JS, SW_JS } from './ban-ui'
import { hygieneApp } from './playlist-hygiene'

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

subscriptionsApp.get('/', (c) => servePage(c, HOME_HTML))
// The old main page also answers at the pages it is being split into, so links
// work while the redesign lands; each route goes when its real page is built.
for (const p of ['/djs', '/playlists', '/settings', '/tools']) subscriptionsApp.get(p, (c) => servePage(c, PAGE_HTML))
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
 * Set list for one DJ (backs the profile page). Served from a 6 h KV cache of
 * the DJ-index crawl merged with the sync state's discovered URLs; pass
 * `?refresh=1` to force a fresh crawl (the page's Refresh button does).
 */
subscriptionsApp.get('/api/dj/:slug', async (c) => {
  const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'subs.dj_sets', by: c.get('cfAccessEmail') })
  const slug = parseDjSlug(c.req.param('slug'))
  if (!slug) return c.json({ error: 'invalid_slug' }, 400)
  const refresh = c.req.query('refresh') === '1'
  log.info('subs.dj_sets.start', { slug, refresh })
  try {
    const [sets, subs] = await Promise.all([getDjSets(c.env, slug, { refresh, log }), listSubscriptions(c.env)])
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
      return c.json({ links, error: 'upstream_error', message: `stopped after ${Object.keys(links).length} of ${ids.length}: ${(e as Error).message}` }, 502)
    }
  }
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

const PAGE_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>tracked — DJ subscriptions</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #0e1116;
    --fg: #e6edf3;
    --muted: #8b949e;
    --accent: #58a6ff;
    --danger: #f85149;
    --card: #161b22;
    --border: #30363d;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg: #ffffff; --fg: #1f2328; --muted: #59636e; --accent: #0969da; --danger: #cf222e; --card: #f6f8fa; --border: #d0d7de; }
  }
  * { box-sizing: border-box; }
  /* HTML hidden attribute uses display:none, but our explicit .yt
     display:flex rule overrides that. Force [hidden] back to none. */
  [hidden] { display: none !important; }
  body { margin: 0; padding: 2rem 1rem; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  main { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 0.25rem; }
  p.lead { color: var(--muted); margin: 0 0 1.5rem; }
  form { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; }
  input[type="url"] { flex: 1; padding: 0.6rem 0.75rem; font: inherit; background: var(--card); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; }
  input[type="url"]:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  button { padding: 0.6rem 1rem; font: inherit; background: var(--accent); color: #fff; border: 0; border-radius: 6px; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: progress; }
  button.danger { background: transparent; color: var(--danger); border: 1px solid var(--border); padding: 0.3rem 0.6rem; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { display: flex; align-items: center; gap: 0.75rem; padding: 0.6rem 0.75rem; border: 1px solid var(--border); border-radius: 6px; background: var(--card); margin-bottom: 0.5rem; }
  li .slug { font-weight: 600; }
  li a { color: var(--accent); text-decoration: none; font-size: 0.85rem; }
  li a.slug { color: var(--fg); font-size: 1rem; }
  li a.slug:hover { color: var(--accent); }
  li a:hover { text-decoration: underline; }
  li .meta { flex: 1; min-width: 0; }
  li .meta .added { color: var(--muted); font-size: 0.8rem; }
  #list-actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-bottom: 0.5rem; }
  #list-actions button { background: transparent; color: var(--accent); border: 1px solid var(--border); padding: 0.3rem 0.6rem; }
  li button.resync-btn { color: var(--muted); }
  .empty { color: var(--muted); padding: 2rem 0; text-align: center; }
  .error { color: var(--danger); margin: 0.5rem 0 1rem; min-height: 1.2em; }
  .error-detail { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.75rem; color: var(--muted); white-space: pre-wrap; word-break: break-word; max-height: 16em; overflow: auto; margin: 0.4rem 0 0; padding: 0.5rem 0.6rem; border: 1px solid var(--border); border-radius: 4px; background: var(--card); }
  footer { margin-top: 2rem; color: var(--muted); font-size: 0.8rem; }
  .yt { display: flex; align-items: center; gap: 0.75rem; padding: 0.6rem 0.75rem; border: 1px solid var(--border); border-radius: 6px; background: var(--card); margin-bottom: 1rem; }
  .yt .info { flex: 1; min-width: 0; font-size: 0.9rem; }
  .yt .info .title { font-weight: 600; }
  .yt .info .sub { color: var(--muted); font-size: 0.8rem; }
  .yt button.connect { background: #c4302b; }
  /* ── Combined playlist ── */
  section#combined { margin-top: 2.25rem; }
  p.mk-link { margin: 2.25rem 0 0; font-weight: 600; }
  #cmb-body { border: 1px solid var(--border); border-radius: 6px; background: var(--card); padding: 0.7rem 0.8rem; font-size: 0.88rem; line-height: 1.55; }
  #cmb-body .headline { font-weight: 600; }
  #cmb-body .counts { color: var(--muted); font-size: 0.82rem; }
  #cmb-body .counts .warn { color: var(--danger); }
  #cmb-body a { color: var(--accent); }
  /* ── YouTube video inspector ── */
  .arow-head a { color: var(--accent); font-size: 0.78rem; white-space: nowrap; }
  .badge.pending { background: rgba(88,166,255,0.18); color: var(--accent); }
  .badge.claimed { background: rgba(210,153,34,0.18); color: #d29922; }
  .badge.done { background: rgba(63,185,80,0.18); color: #3fb950; }
  .badge.superseded { background: color-mix(in srgb, var(--fg) 10%, transparent); color: var(--muted); }
  .badge.banned { background: rgba(248,81,73,0.12); color: var(--danger); }
  .arow .src { font-size: 0.72rem; color: var(--muted); white-space: nowrap; }
  .arow-detail .retry { margin-top: 0.4rem; }
  section#ytjson { margin-top: 2.25rem; }
  #ytjson-form { display: flex; gap: 0.5rem; margin: 0 0 0.5rem; }
  /* type="text", not "url", so a bare 11-char video id is accepted too — hence
     it doesn't pick up the input[type="url"] rule above. */
  #ytjson-url { flex: 1; min-width: 0; padding: 0.6rem 0.75rem; font: inherit; background: var(--card); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; }
  #ytjson-url:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  #ytjson-status { color: var(--muted); font-size: 0.82rem; min-height: 1.2em; margin-bottom: 0.4rem; }
  #ytjson-status .warn { color: var(--danger); }
  #ytjson-status .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  #ytjson-status a { color: var(--accent); }
  #ytjson-out { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.75rem; line-height: 1.45;
    white-space: pre; overflow: auto; max-height: 28em; margin: 0; padding: 0.6rem 0.7rem;
    border: 1px solid var(--border); border-radius: 6px; background: var(--card); }
  /* ── Recent requests (audit trail) ── */
  section#audit { margin-top: 2.25rem; }
  .audit-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.75rem; }
  .audit-head h2 { font-size: 1.05rem; margin: 0; }
  .audit-actions { display: flex; align-items: center; gap: 0.9rem; }
  .audit-actions .chk { color: var(--muted); font-size: 0.8rem; display: inline-flex; align-items: center; gap: 0.35rem; cursor: pointer; user-select: none; }
  button.ghost { background: transparent; color: var(--accent); border: 1px solid var(--border); padding: 0.35rem 0.7rem; font-size: 0.85rem; }
  #audit-more { width: 100%; margin-top: 0.25rem; }
  .arow { border: 1px solid var(--border); border-radius: 6px; background: var(--card); margin-bottom: 0.4rem; overflow: hidden; }
  .arow.err { border-color: color-mix(in srgb, var(--danger) 55%, var(--border)); }
  .arow-head { display: flex; align-items: center; gap: 0.55rem; padding: 0.5rem 0.7rem; cursor: pointer; }
  .arow-head:hover { background: color-mix(in srgb, var(--fg) 5%, transparent); }
  .badge { font-size: 0.66rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; padding: 0.14rem 0.42rem; border-radius: 999px; white-space: nowrap; }
  .badge.ok { background: rgba(63,185,80,0.18); color: #3fb950; }
  .badge.unidentified { background: rgba(210,153,34,0.18); color: #d29922; }
  .badge.no_video, .badge.no_tracklist, .badge.upstream_error { background: rgba(248,81,73,0.18); color: var(--danger); }
  /* ── Recent playlist additions (sync audit trail) ── */
  .badge.added { background: rgba(63,185,80,0.18); color: #3fb950; }
  .badge.duplicate { background: color-mix(in srgb, var(--fg) 10%, transparent); color: var(--muted); }
  .badge.replaced { background: rgba(88,166,255,0.18); color: var(--accent); }
  .badge.no_youtube { background: rgba(210,153,34,0.18); color: #d29922; }
  .badge.failed, .badge.abandoned { background: rgba(248,81,73,0.18); color: var(--danger); }
  section#pladds { margin-top: 2.25rem; }
  #pl-more { width: 100%; margin-top: 0.25rem; }
  .arow .vid { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.72rem; color: var(--muted); white-space: nowrap; }
  .arow .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.9rem; }
  .arow .when { color: var(--muted); font-size: 0.75rem; white-space: nowrap; }
  .arow .pos { font-variant-numeric: tabular-nums; font-size: 0.78rem; color: var(--muted); white-space: nowrap; }
  .arow .via { font-size: 0.7rem; color: var(--muted); white-space: nowrap; }
  .arow .flag { color: var(--danger); font-weight: 700; }
  .arow-detail { border-top: 1px solid var(--border); padding: 0.6rem 0.8rem; font-size: 0.82rem; line-height: 1.5; }
  .arow-detail dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.1rem 0.75rem; margin: 0 0 0.2rem; }
  .arow-detail dt { color: var(--muted); }
  .arow-detail dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .arow-detail .grp { font-weight: 700; margin: 0.55rem 0 0.2rem; font-size: 0.8rem; }
  .arow-detail .grp:first-child { margin-top: 0; }
  .arow-detail a { color: var(--accent); }
  .arow-detail .warn { color: var(--danger); }
  .arow-detail ol { margin: 0.15rem 0 0; padding-left: 1.1rem; }
  .arow-detail .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.78rem; }
${BAN_CSS}
</style>
</head>
<body data-ban-page="main">
<main>
${BAN_BANNER_HTML}
  <h1>DJ subscriptions</h1>
  <p class="lead">Paste a 1001tracklists DJ URL like <code>https://www.1001tracklists.com/dj/lillypalmer/index.html</code>. &nbsp;·&nbsp; <a href="/ui/set">Tracklist viewer →</a> &nbsp;·&nbsp; <a href="/ui/pool">Pool accounts →</a></p>
${ALERTS_ROW_HTML}
  <div id="yt" class="yt" hidden>
    <div class="info">
      <div class="title" id="yt-title">YouTube</div>
      <div class="sub" id="yt-sub"></div>
    </div>
    <button id="yt-action"></button>
  </div>
  <form id="add-form">
    <input id="url" type="url" placeholder="https://www.1001tracklists.com/dj/.../index.html" required autofocus />
    <button type="submit">Add</button>
  </form>
  <div id="error" class="error" role="alert"></div>
  <div id="list-actions" hidden>
    <button id="resync-all" title="Forget what the sync trusts about every DJ's sets and re-fetch them all: swapped recordings get replaced. Drains over a few cron ticks.">Invalidate video cache &amp; resync all</button>
    <button id="sync-all">Sync all</button>
    <button id="fix-titles" class="ghost" title="Rename DJ playlists still titled &quot;Tracklists By …&quot; to the artist name (shows the list first)">Fix playlist titles</button>
  </div>
  <div id="fix-titles-out" class="muted" hidden></div>
  <ul id="list"></ul>
  <div id="empty" class="empty" hidden>No subscriptions yet.</div>

  <section id="combined">
    <div class="audit-head">
      <h2>Combined playlist</h2>
      <div class="audit-actions">
        <button id="cmb-backfill" class="ghost">Backfill now</button>
        <button id="cmb-refresh" class="ghost">Refresh</button>
      </div>
    </div>
    <div id="cmb-body"><span class="counts">loading…</span></div>
  </section>

  <p class="mk-link"><a href="/ui/mkvid">mkvid →</a></p>

  <section id="ytjson">
    <div class="audit-head">
      <h2>YouTube video JSON</h2>
      <div class="audit-actions">
        <button id="ytjson-copy" class="ghost" hidden>Copy</button>
      </div>
    </div>
    <form id="ytjson-form">
      <input id="ytjson-url" type="text" placeholder="https://www.youtube.com/watch?v=… (or a bare video id)" />
      <button type="submit">Fetch</button>
    </form>
    <div id="ytjson-status"></div>
    <pre id="ytjson-out" hidden></pre>
  </section>

  <section id="audit">
    <div class="audit-head">
      <h2>Recent requests</h2>
      <div class="audit-actions">
        <label class="chk"><input type="checkbox" id="audit-errors-only" /> problems only</label>
        <button id="audit-refresh" class="ghost">Refresh</button>
      </div>
    </div>
    <div id="audit-list"></div>
    <div id="audit-empty" class="empty" hidden>No requests recorded yet.</div>
    <button id="audit-more" class="ghost" hidden>Load older</button>
  </section>

  <section id="pladds">
    <div class="audit-head">
      <h2>Recent playlist additions</h2>
      <div class="audit-actions">
        <label class="chk"><input type="checkbox" id="pl-errors-only" /> problems only</label>
        <button id="pl-refresh" class="ghost">Refresh</button>
      </div>
    </div>
    <div id="pl-list"></div>
    <div id="pl-empty" class="empty" hidden>No playlist additions recorded yet.</div>
    <button id="pl-more" class="ghost" hidden>Load older</button>
  </section>

${BAN_HISTORY_HTML}
  <footer>Signed in as <span id="who"></span></footer>
</main>
<script>
(() => {
  const $list = document.getElementById('list');
  const $empty = document.getElementById('empty');
  const $error = document.getElementById('error');
  const $form = document.getElementById('add-form');
  const $url = document.getElementById('url');
  const $btn = $form.querySelector('button');
  const $listActions = document.getElementById('list-actions');
  const $syncAll = document.getElementById('sync-all');
  const $resyncAll = document.getElementById('resync-all');

  function showError(msg, detail) {
    $error.textContent = msg ?? '';
    if (detail) {
      const pre = document.createElement('pre');
      pre.className = 'error-detail';
      pre.textContent = detail;
      $error.appendChild(pre);
    }
  }

  function showReauthError() {
    $error.textContent = 'YouTube token rejected by Google (refresh token expired or revoked). Reconnect to continue syncing.';
    const btn = document.createElement('button');
    btn.textContent = 'Reconnect YouTube';
    btn.className = 'connect';
    btn.style.marginLeft = '0.5rem';
    btn.addEventListener('click', () => { window.location.href = '/ui/oauth/start'; });
    $error.appendChild(btn);
  }

  function fmtDate(epoch) {
    if (!epoch) return '';
    try { return new Date(epoch * 1000).toLocaleDateString(); } catch { return ''; }
  }

  function render(subs) {
    $list.innerHTML = '';
    if (!subs.length) { $empty.hidden = false; $listActions.hidden = true; return; }
    $empty.hidden = true;
    $listActions.hidden = false;
    for (const s of subs) {
      const li = document.createElement('li');
      const meta = document.createElement('div');
      meta.className = 'meta';
      const slug = document.createElement('div');
      slug.innerHTML = '<a class="slug"></a> · <a target="_blank" rel="noreferrer noopener"></a>';
      // The DJ profile page: all of this DJ's tracklists as expandable cards.
      const prof = slug.querySelector('.slug');
      prof.textContent = s.slug;
      prof.href = '/ui/dj/' + encodeURIComponent(s.slug);
      const link = slug.querySelector('a:not(.slug)');
      link.href = s.sourceUrl;
      link.textContent = 'open';
      meta.appendChild(slug);
      const added = document.createElement('div');
      added.className = 'added';
      added.textContent = s.addedAt ? 'added ' + fmtDate(s.addedAt) : '';
      meta.appendChild(added);
      li.appendChild(meta);
      const sync = document.createElement('button');
      sync.className = 'danger sync-btn';
      sync.textContent = 'Sync';
      sync.dataset.slug = s.slug;
      sync.addEventListener('click', () => syncSlug(s.slug, sync));
      li.appendChild(sync);
      // Re-fetch every one of this DJ's sets now (not just new ones), so a
      // set whose recording was swapped on 1001tracklists gets the old
      // video pulled and the new one added. Bounded per run; the cron
      // continues it.
      const resync = document.createElement('button');
      resync.className = 'danger resync-btn';
      resync.textContent = 'Invalidate & resync';
      resync.title = 'Forget the cached video for every set and re-check them all';
      resync.dataset.slug = s.slug;
      resync.addEventListener('click', () => syncSlug(s.slug, resync, { resync: true }));
      li.appendChild(resync);
      const rm = document.createElement('button');
      rm.className = 'danger';
      rm.textContent = 'Remove';
      rm.addEventListener('click', () => remove(s.slug, rm));
      li.appendChild(rm);
      $list.appendChild(li);
    }
  }

  async function syncSlug(slug, btn, opts) {
    const resync = !!(opts && opts.resync);
    showError('');
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = resync ? 'Resyncing…' : 'Syncing…';
    try {
      const r = await fetch('/ui/api/' + (resync ? 'resync' : 'sync') + '/' + encodeURIComponent(slug), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const raw = await r.text();
      let data = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch { /* non-JSON body, fall through */ }
      if (!r.ok) {
        if (r.status === 412 && data.error === 'youtube_reauth_required') {
          showReauthError();
          // The server has cleared stored tokens; refresh the YouTube
          // panel so the "Sign in with YouTube" button reappears.
          loadYouTubeStatus();
          return;
        }
        const msg = data.errorMessage || data.message || data.error || ('sync failed (' + r.status + ')');
        const detail = data.errorStack
          || (data.errorName && data.errorName !== 'Error' ? data.errorName : null)
          || (raw && raw !== msg ? raw : null);
        showError('sync failed: ' + msg, detail);
        return;
      }
      const stats = data.stats || {};
      const pending = stats.tracklistsPending || 0;
      const rechecksPending = stats.rechecksPending || 0;
      const continuing = [];
      if (pending > 0) continuing.push(pending + ' new pending');
      if (rechecksPending > 0) continuing.push(rechecksPending + ' recheck' + (rechecksPending === 1 ? '' : 's') + ' pending');
      const more = continuing.length ? ' · ' + continuing.join(', ') + ' — auto-continuing every 5 min' : '';
      const combined = stats.combinedVideoIdsAdded ? ' · ' + stats.combinedVideoIdsAdded + ' into the combined playlist' : '';
      const rechecked = stats.tracklistsRechecked
        ? ' · rechecked ' + stats.tracklistsRechecked + ', replaced ' + (stats.videosReplaced || 0)
        : '';
      const inv = data.invalidated ? ' (invalidated ' + (data.invalidated.tracklistsMarked || 0) + ' cached videos)' : '';
      showError(
        (resync ? 'resynced ' : 'synced ') + slug + inv + ' — ' + (stats.videoIdsAdded || 0) + ' new of ' +
        (stats.tracklistsProcessed || 0) + ' set' + (stats.tracklistsProcessed === 1 ? '' : 's') +
        ' processed (' + (stats.tracklistsSeen || 0) + ' total on the DJ page)' + rechecked + combined + more
      );
      // The run may have created the combined playlist or mirrored into it.
      loadCombined();
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  async function load() {
    showError('');
    const r = await fetch('/ui/api/list', { credentials: 'same-origin' });
    if (!r.ok) { showError('failed to load (' + r.status + ')'); return; }
    const data = await r.json();
    render(data.subscriptions || []);
  }

  async function add(url) {
    showError('');
    $btn.disabled = true;
    try {
      const r = await fetch('/ui/api/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ url }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { showError(data.message || data.error || ('add failed (' + r.status + ')')); return; }
      $url.value = '';
      await load();
    } finally {
      $btn.disabled = false;
    }
  }

  async function remove(slug, btn) {
    showError('');
    btn.disabled = true;
    try {
      const r = await fetch('/ui/api/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ slug }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        showError(data.message || data.error || ('remove failed (' + r.status + ')'));
        return;
      }
      await load();
    } finally {
      btn.disabled = false;
    }
  }

  $syncAll.addEventListener('click', async () => {
    const btns = Array.from($list.querySelectorAll('button.sync-btn'));
    if (!btns.length) return;
    $syncAll.disabled = true;
    const original = $syncAll.textContent;
    $syncAll.textContent = 'Syncing all…';
    try {
      // Serial: mirrors clicking each row's Sync one after the other, and
      // keeps us under YouTube quota / 1001tracklists rate limits.
      for (const b of btns) await syncSlug(b.dataset.slug, b);
    } finally {
      $syncAll.disabled = false;
      $syncAll.textContent = original;
    }
  });

  // "Fix playlist titles": a dry run first, then the rename after a confirm.
  const $fixTitles = document.getElementById('fix-titles');
  const $fixOut = document.getElementById('fix-titles-out');
  async function fixTitles(dryRun) {
    const r = await fetch('/ui/api/playlists/fix-titles', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dryRun }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.message || d.error || ('failed (' + r.status + ')'));
    return d;
  }
  function showFixes(d) {
    $fixOut.hidden = false;
    $fixOut.textContent = '';
    if (!d.fixes.length) { $fixOut.textContent = 'All ' + d.checked + ' DJ playlist titles are fine.'; return; }
    const ul = document.createElement('ul');
    for (const f of d.fixes) {
      const li = document.createElement('li');
      li.textContent = f.oldTitle + ' → ' + f.newTitle + (f.status === 'failed' ? ' (failed: ' + (f.error || '') + ')' : f.status === 'renamed' ? ' (renamed)' : '');
      ul.appendChild(li);
    }
    $fixOut.appendChild(ul);
  }
  $fixTitles.addEventListener('click', async () => {
    $fixTitles.disabled = true;
    showError('');
    try {
      const preview = await fixTitles(true);
      showFixes(preview);
      if (!preview.fixes.length) return;
      if (!confirm('Rename ' + preview.fixes.length + ' playlist' + (preview.fixes.length === 1 ? '' : 's') + ' on YouTube (50 quota units each)?')) return;
      showFixes(await fixTitles(false));
    } catch (e) {
      showError('fix playlist titles: ' + (e && e.message ? e.message : e));
    } finally {
      $fixTitles.disabled = false;
    }
  });

  $resyncAll.addEventListener('click', async () => {
    const btns = Array.from($list.querySelectorAll('button.resync-btn'));
    if (!btns.length) return;
    if (!confirm('Re-fetch every set of every DJ? Swapped recordings get replaced in the playlists. This drains over the next few cron ticks.')) return;
    $resyncAll.disabled = true;
    btns.forEach((b) => { b.disabled = true; });
    const original = $resyncAll.textContent;
    $resyncAll.textContent = 'Resyncing all…';
    showError('');
    try {
      // One server-side pass on a single shared fetch budget — NOT one
      // request per row: that loop ran every DJ unpaced and got the
      // 1001tracklists accounts banned (twice).
      const r = await fetch('/ui/api/resync', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' });
      const raw = await r.text();
      let data = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch { /* non-JSON body, fall through */ }
      if (!r.ok) {
        if (r.status === 412 && data.error === 'youtube_reauth_required') { showReauthError(); loadYouTubeStatus(); return; }
        showError('resync all failed: ' + (data.errorMessage || data.message || data.error || ('resync failed (' + r.status + ')')), data.errorStack || null);
        return;
      }
      if (data.paused) { showError('resync all: 1001tracklists fetching is paused (see the banner); nothing was fetched.'); return; }
      const results = data.results || [];
      const invalidated = (data.invalidated || []).reduce((a, x) => a + (x.tracklistsMarked || 0), 0);
      const rechecked = results.reduce((a, x) => a + ((x.stats || {}).tracklistsRechecked || 0), 0);
      const replaced = results.reduce((a, x) => a + ((x.stats || {}).videosReplaced || 0), 0);
      const added = results.reduce((a, x) => a + ((x.stats || {}).videoIdsAdded || 0), 0);
      const pending = results.reduce((a, x) => a + ((x.stats || {}).rechecksPending || 0) + ((x.stats || {}).tracklistsPending || 0), 0);
      const failed = results.filter((x) => x.ok === false).map((x) => x.slug);
      showError(
        'resynced ' + results.length + ' of ' + btns.length + ' DJs this pass (invalidated ' + invalidated + ' cached videos) — rechecked ' + rechecked +
        ', replaced ' + replaced + ', ' + added + ' new' +
        (pending ? ' · ' + pending + ' still pending — auto-continuing every 5 min' : '') +
        (failed.length ? ' · failed: ' + failed.join(', ') : ''),
      );
      loadCombined();
    } catch (e) {
      showError('resync all failed: ' + (e && e.message || e));
    } finally {
      $resyncAll.disabled = false;
      btns.forEach((b) => { b.disabled = false; });
      $resyncAll.textContent = original;
    }
  });

  $form.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $url.value.trim();
    if (!url) return;
    add(url);
  });

  // ── YouTube connect/disconnect ──────────────────────────────────────────
  const $yt = document.getElementById('yt');
  const $ytTitle = document.getElementById('yt-title');
  const $ytSub = document.getElementById('yt-sub');
  const $ytAction = document.getElementById('yt-action');

  async function loadYouTubeStatus() {
    const r = await fetch('/ui/api/youtube/status', { credentials: 'same-origin' });
    if (!r.ok) { $yt.hidden = true; return; }
    const data = await r.json();
    $yt.hidden = false;
    if (data.connected) {
      $ytTitle.textContent = 'YouTube · ' + (data.channelTitle || 'connected');
      $ytSub.textContent = 'Granted: ' + (data.scope || '(unknown scope)');
      $ytAction.textContent = 'Disconnect';
      $ytAction.className = 'danger';
      $ytAction.onclick = disconnectYouTube;
    } else {
      $ytTitle.textContent = 'YouTube';
      $ytSub.textContent = 'Connect your account to let this app create and update playlists.';
      $ytAction.textContent = 'Sign in with YouTube';
      $ytAction.className = 'connect';
      $ytAction.onclick = () => { window.location.href = '/ui/oauth/start'; };
    }
  }

  async function disconnectYouTube() {
    if (!confirm('Disconnect this app from your YouTube account?')) return;
    $ytAction.disabled = true;
    try {
      const r = await fetch('/ui/oauth/disconnect', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (!r.ok) { showError('disconnect failed (' + r.status + ')'); return; }
      await loadYouTubeStatus();
    } finally {
      $ytAction.disabled = false;
    }
  }

  // Surface ?yt=connected / ?yt_error=... after the OAuth round-trip.
  const params = new URLSearchParams(location.search);
  if (params.get('yt_error')) showError('YouTube connect failed: ' + params.get('yt_error'));
  if (params.get('yt') || params.get('yt_error')) {
    history.replaceState({}, '', location.pathname);
  }

  // ── YouTube video JSON inspector ───────────────────────────────────────
  // Paste any watch/youtu.be/shorts URL (or a bare id) and dump the raw
  // videos.list payload. Read-only: it touches nothing else in the app.
  const $yjForm = document.getElementById('ytjson-form');
  const $yjUrl = document.getElementById('ytjson-url');
  const $yjBtn = $yjForm.querySelector('button');
  const $yjStatus = document.getElementById('ytjson-status');
  const $yjOut = document.getElementById('ytjson-out');
  const $yjCopy = document.getElementById('ytjson-copy');

  function yjStatus(html) { $yjStatus.innerHTML = html || ''; }

  async function fetchVideoJson(input) {
    yjStatus('fetching…');
    $yjBtn.disabled = true;
    try {
      const r = await fetch('/ui/api/youtube/video?url=' + encodeURIComponent(input), {
        credentials: 'same-origin',
      });
      const raw = await r.text();
      let data = null;
      try { data = raw ? JSON.parse(raw) : null; } catch { /* non-JSON body */ }
      if (!r.ok) {
        $yjOut.hidden = true;
        $yjCopy.hidden = true;
        const msg = (data && (data.message || data.error)) || raw || ('failed (' + r.status + ')');
        yjStatus('<span class="warn">' + esc(msg) + '</span>');
        return;
      }
      // Pretty-print the whole envelope (videoId + watchUrl + the API item).
      // textContent, never innerHTML — the payload is third-party text.
      $yjOut.textContent = JSON.stringify(data, null, 2);
      $yjOut.hidden = false;
      $yjCopy.hidden = false;
      const sn = (data && data.video && data.video.snippet) || {};
      yjStatus(
        '<span class="mono">' + esc(data.videoId) + '</span> · ' +
        link(data.watchUrl, 'open on YouTube') +
        (sn.title ? ' · ' + esc(sn.title) : '')
      );
    } catch (e) {
      $yjOut.hidden = true;
      $yjCopy.hidden = true;
      yjStatus('<span class="warn">' + esc(e && e.message ? e.message : String(e)) + '</span>');
    } finally {
      $yjBtn.disabled = false;
    }
  }

  $yjForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $yjUrl.value.trim();
    if (!v) return;
    fetchVideoJson(v);
  });

  $yjCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($yjOut.textContent);
      const original = $yjCopy.textContent;
      $yjCopy.textContent = 'Copied';
      setTimeout(() => { $yjCopy.textContent = original; }, 1200);
    } catch { yjStatus('<span class="warn">clipboard blocked — select the JSON and copy manually</span>'); }
  });

  // ── Recent requests (audit trail) ──────────────────────────────────────
  const $auditList = document.getElementById('audit-list');
  const $auditEmpty = document.getElementById('audit-empty');
  const $auditMore = document.getElementById('audit-more');
  const $auditRefresh = document.getElementById('audit-refresh');
  const $auditErrorsOnly = document.getElementById('audit-errors-only');
  let auditCursor = null;
  let auditRecords = [];
  const PROBLEM = new Set(['no_video', 'no_tracklist', 'upstream_error']);
  const BIG_SKEW = 600; // |pos − track start| over 10 min → flag as suspicious

  // Audit values include third-party 1001tracklists titles and the phoned-in
  // video title — untrusted. esc() is used in both text and attribute contexts,
  // so it must also escape quotes (textContent→innerHTML would not).
  function esc(s) {
    return (s == null ? '' : String(s))
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function clock(s) {
    if (s == null || isNaN(s)) return '—';
    s = Math.round(s);
    const neg = s < 0; s = Math.abs(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (neg ? '-' : '') + (h ? h + ':' : '') + mm + ':' + String(sec).padStart(2, '0');
  }
  function relTime(iso) {
    const t = Date.parse(iso); if (isNaN(t)) return '';
    const d = Math.round((Date.now() - t) / 1000);
    if (d < 60) return d + 's ago';
    if (d < 3600) return Math.floor(d / 60) + 'm ago';
    if (d < 86400) return Math.floor(d / 3600) + 'h ago';
    return Math.floor(d / 86400) + 'd ago';
  }
  function link(u, label) {
    // Only linkify http(s) — anything else (javascript:, data:, …) renders as
    // plain escaped text so a hostile URL can't become a clickable script URI.
    if (!u) return '—';
    var lo = String(u).toLowerCase();
    if (!(lo.startsWith('http://') || lo.startsWith('https://'))) return esc(u);
    return '<a href="' + esc(u) + '" target="_blank" rel="noreferrer noopener">' + esc(label || u) + '</a>';
  }

  function renderAudit() {
    const errOnly = $auditErrorsOnly.checked;
    const rows = auditRecords.filter((r) => !errOnly || PROBLEM.has(r.status) || r.impossible);
    $auditList.innerHTML = '';
    if (auditRecords.length === 0) { $auditEmpty.textContent = 'No requests recorded yet.'; $auditEmpty.hidden = false; }
    else if (rows.length === 0) { $auditEmpty.textContent = 'No problems in the loaded requests.'; $auditEmpty.hidden = false; }
    else { $auditEmpty.hidden = true; }
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'arow' + (PROBLEM.has(r.status) ? ' err' : '');
      const head = document.createElement('div');
      head.className = 'arow-head';
      const skewBad = r.skew != null && Math.abs(r.skew) > BIG_SKEW;
      head.innerHTML =
        '<span class="badge ' + esc(r.status || '') + '">' + esc(r.status || '?') + '</span>' +
        '<span class="title">' + esc(r.title || '(no title)') + '</span>' +
        (r.via ? '<span class="via">via ' + esc(r.via) + '</span>' : '') +
        '<span class="pos">' + clock(r.cs) + (r.dur ? ' / ' + clock(r.dur) : '') +
          (r.impossible ? ' <span class="flag" title="reported position is past the end of the video">!</span>' : '') +
          (skewBad ? ' <span class="flag" title="large gap between reported position and selected track start">Δ' + clock(r.skew) + '</span>' : '') +
        '</span>' +
        '<span class="when" title="' + esc(r.t) + '">' + esc(relTime(r.t)) + '</span>';
      row.appendChild(head);
      const detail = document.createElement('div');
      detail.className = 'arow-detail';
      detail.hidden = true;
      row.appendChild(detail);
      let loaded = false;
      head.addEventListener('click', async () => {
        detail.hidden = !detail.hidden;
        if (detail.hidden || loaded) return;
        loaded = true;
        detail.innerHTML = '<span class="when">loading…</span>';
        try {
          const resp = await fetch('/ui/api/audit-detail?key=' + encodeURIComponent(r.key), { credentials: 'same-origin' });
          const data = await resp.json();
          detail.innerHTML = data && data.record ? auditDetailHtml(data.record) : '<span class="warn">detail not found</span>';
        } catch { detail.innerHTML = '<span class="warn">failed to load detail</span>'; loaded = false; }
      });
      $auditList.appendChild(row);
    }
  }

  function dl(pairs) {
    return '<dl>' + pairs.filter(Boolean).map((p) => '<dt>' + esc(p[0]) + '</dt><dd>' + p[1] + '</dd>').join('') + '</dl>';
  }

  function auditDetailHtml(r) {
    // Legacy records (pre-metadata) stored fields flat; lift them into the
    // nested shape the renderer expects so old history still displays.
    if (!r.input) {
      r = {
        t: r.t, reqId: r.reqId, status: r.status, message: r.message,
        input: { videoTitle: r.videoTitle, videoUrl: r.videoUrl, currentSeconds: r.currentSeconds, videoDurationSeconds: r.videoDurationSeconds },
        impossibleTimestamp: r.impossibleTimestamp,
        youtube: r.youtube || { videoId: null, videoUrl: r.videoUrl, matchTitle: null, error: null },
        search: r.search || { attempts: [], via: r.tracklistVia || null, tracklistUrl: r.tracklistUrl || null },
        select: r.select || ((r.currentStartSeconds != null || r.currentTracks) ? {
          currentStartSeconds: r.currentStartSeconds != null ? r.currentStartSeconds : null,
          currentSkewSeconds: (r.currentStartSeconds != null && r.currentSeconds != null) ? r.currentSeconds - r.currentStartSeconds : null,
          trackCount: null, unidentifiedCount: null, currentTracks: r.currentTracks || [],
        } : null),
        meta: r.meta || {},
      };
    }
    const inp = r.input || {}, yt = r.youtube || {}, se = r.search || {}, sel = r.select, meta = r.meta || {};
    const out = [];

    out.push('<div class="grp">Input</div>');
    out.push(dl([
      ['title', esc(inp.videoTitle) || '—'],
      inp.videoUrl ? ['videoUrl', link(inp.videoUrl)] : null,
      ['position', clock(inp.currentSeconds) + (inp.videoDurationSeconds ? ' / ' + clock(inp.videoDurationSeconds) : '') +
        (r.impossibleTimestamp ? ' <span class="warn">— past end of video (client bug?)</span>' : '')],
    ]));

    out.push('<div class="grp">YouTube match</div>');
    out.push(dl([
      ['videoId', yt.videoId ? '<span class="mono">' + esc(yt.videoId) + '</span> ' + link('https://youtu.be/' + yt.videoId, 'open') : '<span class="warn">no match</span>'],
      yt.matchTitle ? ['matched title', esc(yt.matchTitle)] : null,
      yt.error ? ['error', '<span class="warn">' + esc(yt.error) + '</span>'] : null,
    ]));

    out.push('<div class="grp">Tracklist search</div>');
    const attempts = (se.attempts && se.attempts.length)
      ? '<ol>' + se.attempts.map((a) => '<li>' + esc(a.via) + ': <span class="mono">' + esc(a.query) + '</span>' + (a.via === se.via ? ' ✓' : '') + '</li>').join('') + '</ol>'
      : '—';
    out.push(dl([
      ['attempts', attempts],
      ['matched via', se.via ? esc(se.via) : '<span class="warn">no tracklist found</span>'],
      se.tracklistUrl ? ['tracklist', link(se.tracklistUrl, 'open')] : null,
    ]));

    if (sel) {
      out.push('<div class="grp">Selection</div>');
      const skewBad = sel.currentSkewSeconds != null && Math.abs(sel.currentSkewSeconds) > BIG_SKEW;
      const cur = (sel.currentTracks || []).map((t) => '<li>' + esc(t.startTime) + ' — ' + esc(t.artist) + ' – ' + esc(t.title) + '</li>').join('');
      out.push(dl([
        ['current track start', clock(sel.currentStartSeconds)],
        ['skew (pos − start)', '<span class="' + (skewBad ? 'warn' : '') + '">' + clock(sel.currentSkewSeconds) + '</span>'],
        ['tracks in set', (sel.trackCount != null ? sel.trackCount : '—') + (sel.unidentifiedCount ? ' (' + sel.unidentifiedCount + ' unidentified)' : '')],
        ['now playing', cur ? '<ol>' + cur + '</ol>' : '—'],
      ]));
    }

    out.push('<div class="grp">Meta</div>');
    out.push(dl([
      ['status', esc(r.status) + (r.message ? ' — ' + esc(r.message) : '')],
      ['when', esc(r.t)],
      ['edge', esc([meta.colo, meta.country].filter(Boolean).join(' · ')) || '—'],
      ['took', meta.totalMs != null ? meta.totalMs + ' ms' : '—'],
      ['reqId', '<span class="mono">' + esc(r.reqId) + '</span>'],
    ]));
    return out.join('');
  }

  async function loadAudit(reset) {
    if (reset) { auditCursor = null; auditRecords = []; }
    const params = new URLSearchParams({ limit: '50' });
    if (auditCursor) params.set('cursor', auditCursor);
    try {
      const r = await fetch('/ui/api/audit?' + params.toString(), { credentials: 'same-origin' });
      if (!r.ok) return;
      const data = await r.json();
      auditRecords = auditRecords.concat(data.records || []);
      auditCursor = data.cursor || null;
      $auditMore.hidden = !auditCursor;
      renderAudit();
    } catch { /* leave prior state */ }
  }

  $auditRefresh.addEventListener('click', () => loadAudit(true));
  $auditErrorsOnly.addEventListener('change', renderAudit);
  $auditMore.addEventListener('click', () => loadAudit(false));

  // ── Recent playlist additions (sync audit trail) ────────────────────────
  // Same shape as the requests view above (newest-first page + KV cursor,
  // expandable per-row detail, "problems only" filter) over the \`pladd:\`
  // trail the sync writes — one row per tracklist it decided an outcome for.
  const $plList = document.getElementById('pl-list');
  const $plEmpty = document.getElementById('pl-empty');
  const $plMore = document.getElementById('pl-more');
  const $plRefresh = document.getElementById('pl-refresh');
  const $plErrorsOnly = document.getElementById('pl-errors-only');
  let plCursor = null;
  let plRecords = [];
  // Statuses that mean the set didn't get resolved: 'no_youtube' is a normal
  // outcome (the set simply has no recording), so it is NOT a problem.
  const PL_PROBLEM = new Set(['failed', 'abandoned']);

  // ".../tracklist/2mx9k/lilly-palmer-tomorrowland-2024.html" →
  // "lilly palmer tomorrowland 2024". Untrusted input — only ever rendered
  // through esc().
  function setLabel(u) {
    if (!u) return '(unknown set)';
    try {
      const seg = new URL(u).pathname.split('/').filter(Boolean).pop() || '';
      const name = seg.replace(/\\.html?$/i, '').replace(/[-_]+/g, ' ').trim();
      return name || u;
    } catch { return u; }
  }

  function renderPlaylistAdds() {
    const errOnly = $plErrorsOnly.checked;
    const rows = plRecords.filter((r) => !errOnly || PL_PROBLEM.has(r.status));
    $plList.innerHTML = '';
    if (plRecords.length === 0) { $plEmpty.textContent = 'No playlist additions recorded yet.'; $plEmpty.hidden = false; }
    else if (rows.length === 0) { $plEmpty.textContent = 'No problems in the loaded additions.'; $plEmpty.hidden = false; }
    else { $plEmpty.hidden = true; }
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'arow' + (PL_PROBLEM.has(r.status) ? ' err' : '');
      const head = document.createElement('div');
      head.className = 'arow-head';
      head.innerHTML =
        '<span class="badge ' + esc(r.status || '') + '">' + esc(r.status || '?') + '</span>' +
        '<span class="title">' + esc(setLabel(r.set)) + '</span>' +
        (r.artist || r.slug ? '<span class="via">' + esc(r.artist || r.slug) + '</span>' : '') +
        (r.vid ? '<span class="vid">' + (r.prev ? esc(r.prev) + ' → ' : '') + esc(r.vid) + '</span>' : '') +
        '<span class="when" title="' + esc(r.t) + '">' + esc(relTime(r.t)) + '</span>';
      row.appendChild(head);
      const detail = document.createElement('div');
      detail.className = 'arow-detail';
      detail.hidden = true;
      row.appendChild(detail);
      let loaded = false;
      head.addEventListener('click', async () => {
        detail.hidden = !detail.hidden;
        if (detail.hidden || loaded) return;
        loaded = true;
        detail.innerHTML = '<span class="when">loading…</span>';
        try {
          const resp = await fetch('/ui/api/playlist-addition-detail?key=' + encodeURIComponent(r.key), { credentials: 'same-origin' });
          const data = await resp.json();
          detail.innerHTML = data && data.record ? plDetailHtml(data.record) : '<span class="warn">detail not found</span>';
        } catch { detail.innerHTML = '<span class="warn">failed to load detail</span>'; loaded = false; }
      });
      $plList.appendChild(row);
    }
  }

  function plDetailHtml(r) {
    const out = [];
    out.push('<div class="grp">Set</div>');
    out.push(dl([
      ['tracklist', link(r.setUrl, setLabel(r.setUrl))],
      ['DJ', esc(r.artistName || r.slug || '—') + (r.slug ? ' <span class="when">(' + esc(r.slug) + ')</span>' : '')],
      ['scraped via', r.via ? esc(r.via) : '—'],
    ]));

    out.push('<div class="grp">Playlist</div>');
    out.push(dl([
      ['video', r.videoId
        ? '<span class="mono">' + esc(r.videoId) + '</span> ' + link(r.videoUrl || ('https://youtu.be/' + r.videoId), 'open')
        : (r.status === 'failed' || r.status === 'abandoned')
          ? '<span class="warn">unknown — the set failed before a video was recorded</span>'
          : '<span class="warn">no YouTube recording on the set page</span>'],
      // A recheck found the set's recording swapped on 1001tracklists: this
      // is the one that came out of the playlists.
      r.previousVideoId
        ? ['replaced', '<span class="mono">' + esc(r.previousVideoId) + '</span> ' + link('https://youtu.be/' + r.previousVideoId, 'open')]
        : null,
      ['playlist', r.playlistId
        ? link('https://www.youtube.com/playlist?list=' + encodeURIComponent(r.playlistId), r.playlistTitle || r.playlistId)
        : '—'],
      // How the same video fared in the combined all-artists playlist. A miss
      // here isn't a set failure — the combined backfill re-derives it.
      ['combined', r.combinedStatus
        ? '<span class="' + (r.combinedStatus === 'failed' || r.combinedStatus === 'unavailable' ? 'warn' : '') + '">' + esc(r.combinedStatus) + '</span>'
        : '—'],
    ]));

    out.push('<div class="grp">Meta</div>');
    out.push(dl([
      ['status', esc(r.status) + (r.message ? ' — <span class="warn">' + esc(r.message) + '</span>' : '')],
      r.failureCount != null ? ['failures so far', esc(r.failureCount)] : null,
      ['trigger', r.trigger ? esc(r.trigger) : '—'],
      ['when', esc(r.t)],
      ['took', r.meta && r.meta.ms != null ? esc(r.meta.ms) + ' ms' : '—'],
    ]));
    return out.join('');
  }

  async function loadPlaylistAdds(reset) {
    if (reset) { plCursor = null; plRecords = []; }
    const params = new URLSearchParams({ limit: '50' });
    if (plCursor) params.set('cursor', plCursor);
    try {
      const r = await fetch('/ui/api/playlist-additions?' + params.toString(), { credentials: 'same-origin' });
      if (!r.ok) return;
      const data = await r.json();
      plRecords = plRecords.concat(data.records || []);
      plCursor = data.cursor || null;
      $plMore.hidden = !plCursor;
      renderPlaylistAdds();
    } catch { /* leave prior state */ }
  }

  $plRefresh.addEventListener('click', () => loadPlaylistAdds(true));
  $plErrorsOnly.addEventListener('change', renderPlaylistAdds);
  $plMore.addEventListener('click', () => loadPlaylistAdds(false));

  // ── Combined "all tracked artists" playlist ────────────────────────────
  // One playlist holding every video from every tracked DJ. The sync mirrors
  // new videos into it as it goes; anything older (sets processed before this
  // existed, or a new DJ's back catalogue) arrives via the backfill, which the
  // crons run automatically — the button here just skips the wait.
  const $cmbBody = document.getElementById('cmb-body');
  const $cmbRefresh = document.getElementById('cmb-refresh');
  const $cmbBackfill = document.getElementById('cmb-backfill');

  function renderCombined(d) {
    if (!d || d.connected === false) {
      $cmbBody.innerHTML = '<span class="counts">Connect a YouTube account to build the combined playlist.</span>';
      $cmbBackfill.disabled = true;
      return;
    }
    $cmbBackfill.disabled = false;
    const missing = d.missingTotal || 0;
    const sources = d.sources || [];
    const cap = d.dailyInsertCap || 0;
    const left = Math.max(0, cap - (d.dailyInsertsUsed || 0));
    const head = d.playlistId
      ? link(d.playlistUrl, d.title) + ' <span class="counts">· ' + (d.videoCount || 0) + ' videos</span>'
      : esc(d.title) + ' <span class="counts">· not created yet</span>';
    const bits = [
      missing > 0
        ? '<span class="warn">' + missing + ' still to add</span>'
        : 'up to date with every artist playlist',
      sources.length + ' artist playlist' + (sources.length === 1 ? '' : 's'),
      left + '/' + cap + ' inserts left today',
    ];
    // Deleted/private videos that can never be inserted — skipped, not retried.
    if (d.unavailableTotal) bits.push(d.unavailableTotal + ' unavailable skipped');
    if (d.lastBackfillAt) bits.push('last backfill ' + relTime(new Date(d.lastBackfillAt * 1000).toISOString()));
    let html = '<div class="headline">' + head + '</div><div class="counts">' + bits.join(' · ') + '</div>';
    if (missing > 0) {
      html += '<div class="counts">Backfilling automatically on every cron tick, up to ' + cap +
        ' videos/day (YouTube quota).</div>';
    }
    $cmbBody.innerHTML = html;
  }

  async function loadCombined() {
    try {
      const r = await fetch('/ui/api/combined', { credentials: 'same-origin' });
      if (!r.ok) { $cmbBody.innerHTML = '<span class="counts">status unavailable (' + r.status + ')</span>'; return; }
      renderCombined(await r.json());
    } catch { $cmbBody.innerHTML = '<span class="counts">status unavailable</span>'; }
  }

  $cmbRefresh.addEventListener('click', loadCombined);
  $cmbBackfill.addEventListener('click', async () => {
    showError('');
    $cmbBackfill.disabled = true;
    const original = $cmbBackfill.textContent;
    $cmbBackfill.textContent = 'Backfilling…';
    try {
      const r = await fetch('/ui/api/combined/backfill', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (r.status === 412 && data.error === 'youtube_reauth_required') { showReauthError(); loadYouTubeStatus(); return; }
        showError(data.errorMessage || data.message || data.error || ('backfill failed (' + r.status + ')'));
        return;
      }
      if (data.ok === false) {
        showError(data.reason === 'no_sources'
          ? 'nothing to backfill yet — sync a DJ first'
          : 'backfill skipped: ' + data.reason);
      } else {
        showError('combined playlist: added ' + (data.inserted || 0) + ' video' + (data.inserted === 1 ? '' : 's') +
          (data.pending ? ' · ' + data.pending + ' still pending (' + (data.cappedBy || 'capped') + ')' : ''));
      }
      await loadCombined();
    } finally {
      $cmbBackfill.disabled = false;
      $cmbBackfill.textContent = original;
    }
  });

  // Cf-Access-Authenticated-User-Email is forwarded by Access; surface it for confidence.
  document.getElementById('who').textContent = document.cookie.includes('CF_Authorization=') ? 'Cloudflare Access' : 'dev';

  load();
  loadYouTubeStatus();
  loadCombined();
  loadAudit(true);
  loadPlaylistAdds(true);
})();
</script>
<script>${BAN_JS}</script>
</body>
</html>`

/** The home page. Today the old main page; Task 12 swaps in the Home page. */
export const HOME_HTML = PAGE_HTML
