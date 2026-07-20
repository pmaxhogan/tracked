import { Hono } from 'hono'
import type { Env } from '../types'
import { cfAccess } from '../middleware/cf-access'
import {
  addSubscription,
  djUrlFor,
  InvalidSubscriptionInput,
  listSubscriptions,
  removeSubscription,
} from '../lib/subscriptions'
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
import { syncAll, syncOne, loadSubState } from '../lib/sync'
import { normalizeTracklistUrl } from '../lib/tracklists1001'
import { resolveFullTracklist } from '../lib/tracklist-resolve'
import { IPBlockedError, CloudflareChallengeError } from '../lib/fetch'

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

subscriptionsApp.get('/', (c) => {
  // The page bundles its own JS inline. no-store keeps browsers from
  // serving a stale page after a deploy, which would mean stale UI logic
  // (e.g. a banner that doesn't auto-refresh).
  c.header('Cache-Control', 'no-store')
  return c.html(PAGE_HTML)
})

// Standalone "tracklist viewer" page: paste a 1001tracklists URL, get a clean
// per-song list with a YouTube icon-link and an Apple Music button when 1001tl
// has them. Data comes from the CF-Access-gated /api/tracklist below (NOT the
// bearer-gated /tracklist API route — the browser only holds the Access cookie).
subscriptionsApp.get('/tracklist', (c) => {
  c.header('Cache-Control', 'no-store')
  return c.html(TRACKLIST_PAGE_HTML)
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
  log.info('subs.tracklist.start', { tracklistUrl })
  try {
    const full = await resolveFullTracklist(c.env, tracklistUrl, { resolveLinks: true }, log)
    if (full.tracks.length === 0) {
      log.warn('subs.tracklist.empty', { tracklistUrl })
      return c.json({ error: 'upstream_error', message: 'parsed 0 tracks (likely a transient captcha) — try again shortly' }, 502)
    }
    return c.json({ tracklistUrl, slug: full.slug, setAppleLink: full.setAppleLink, trackCount: full.tracks.length, tracks: full.tracks })
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
    const result = await syncAll(c.env, { log })
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
    const result = await syncOne(c.env, sub, tokenInfo.accessToken, { log })
    return c.json(result)
  } catch (e) {
    if (e instanceof GoogleOAuthRefreshFailed && e.invalidGrant) {
      log.warn('subs.sync_one_reauth', { slug, status: e.status })
      return c.json({ error: 'youtube_reauth_required', message: 'YouTube refresh token rejected by Google; reconnect required.' }, 412)
    }
    log.error('subs.sync_one_throw', { slug, ...errorFields(e) })
    return c.json({ error: 'sync_failed', ...errorFields(e) }, 500)
  }
})

subscriptionsApp.get('/api/state/:slug', async (c) => {
  const slug = c.req.param('slug')
  const state = await loadSubState(c.env, slug)
  return c.json({ slug, state })
})

/**
 * Returns whether the home proxy is currently in IP-block backoff and
 * until when. The UI surfaces this so the user knows to solve the
 * 1001tracklists captcha from their home network when the flag is set.
 */
subscriptionsApp.get('/api/home-proxy-status', async (c) => {
  const { isHomeProxyBlocked } = await import('../lib/dj-index')
  const blk = await isHomeProxyBlocked(c.env.CACHE)
  return c.json(blk)
})

/** Manual override: clears the home-proxy IP-block backoff. Use after
 *  solving the captcha at https://www.1001tracklists.com from the home
 *  network so the next sync tries the home proxy again immediately. */
subscriptionsApp.post('/api/home-proxy-status/clear', async (c) => {
  const { clearHomeProxyBlocked } = await import('../lib/dj-index')
  await clearHomeProxyBlocked(c.env.CACHE)
  return c.json({ cleared: true })
})

/**
 * Diagnostic: probe several pagination URL formats for the DJ page and
 * report which one returns content different from page 1. Also stashes the
 * page-1 HTML into SUBS KV at `debug:dj:<slug>:html` (10 min TTL) so we can
 * inspect it offline via wrangler kv to figure out what scroll-loader the
 * page actually uses. Behind CF Access like everything else here.
 */
subscriptionsApp.get('/api/debug/dj-pagination/:slug', async (c) => {
  const log = makeLogger({
    reqId: c.req.raw.headers.get('cf-ray') ?? 'local',
    route: 'subs.debug_pagination',
  })
  const slug = c.req.param('slug')
  const fetchOpts = {
    brightdataApiKey: c.env.BRIGHTDATA_API_KEY,
    homeProxyUrl: c.env.HOME_PROXY_URL,
    homeProxyToken: c.env.HOME_PROXY_TOKEN,
    log,
  }
  const { fetch1001Html, parseDjIndex } = await import('../lib/dj-index')

  const candidates = [
    `https://www.1001tracklists.com/dj/${slug}/index.html`,
    `https://www.1001tracklists.com/dj/${slug}/page2.html`,
    `https://www.1001tracklists.com/dj/${slug}/index.html?page=2`,
    `https://www.1001tracklists.com/dj/${slug}/?page=2`,
    `https://www.1001tracklists.com/dj/${slug}/?p=2`,
    `https://www.1001tracklists.com/dj/${slug}/2.html`,
  ]
  const results: Array<{
    url: string
    ok: boolean
    htmlBytes?: number
    trackCount?: number
    firstTrack?: string | null
    lastTrack?: string | null
    error?: string
  }> = []
  let page1Html: string | null = null
  for (const url of candidates) {
    try {
      const r = await fetch1001Html(url, fetchOpts)
      const parsed = parseDjIndex(r.html)
      if (url.endsWith('/index.html')) page1Html = r.html
      results.push({
        url,
        ok: true,
        htmlBytes: r.html.length,
        trackCount: parsed.tracklistUrls.length,
        firstTrack: parsed.tracklistUrls[0] ?? null,
        lastTrack: parsed.tracklistUrls[parsed.tracklistUrls.length - 1] ?? null,
      })
    } catch (e) {
      results.push({ url, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
  if (page1Html) {
    await c.env.SUBS.put(`debug:dj:${slug}:html`, page1Html, { expirationTtl: 600 })
  }
  // The DJ index loads /js/framework.js asynchronously, which defines the
  // infinite-scroll handler `loadInfiniteScrollData`. Fetch that and pull
  // out the AJAX URL it calls so we can paginate properly.
  let frameworkSnippets: string[] = []
  let frameworkBytes = 0
  try {
    const fw = await fetch1001Html('https://www.1001tracklists.com/js/framework.js', fetchOpts)
    frameworkBytes = fw.html.length
    await c.env.SUBS.put(`debug:dj:${slug}:framework_js`, fw.html, { expirationTtl: 600 })
    // Pull a window of source around the function definition.
    const idx = fw.html.indexOf('loadInfiniteScrollData')
    if (idx !== -1) {
      // capture 600 bytes around each occurrence (max 4 occurrences)
      let from = 0
      let count = 0
      while (count < 4) {
        const i = fw.html.indexOf('loadInfiniteScrollData', from)
        if (i === -1) break
        frameworkSnippets.push(fw.html.slice(Math.max(0, i - 100), i + 600))
        from = i + 1
        count++
      }
    }
  } catch (e) {
    frameworkSnippets.push(`framework.js fetch failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  // Surface inline-script fragments that look pagination-related — the
  // scroll loader's AJAX URL often lives in one of them.
  const scriptHints: string[] = []
  if (page1Html) {
    const reHints = [
      /['"]\/?ajax\/[^'"]+['"]/g,
      /['"]\/dj\/[^'"]*\/[^'"]*['"]/g,
      /(?:get_dj|loadMore|loadTracklists|infinite[Ss]croll|nextPage)[^\n]{0,120}/g,
      /XMLHttpRequest|fetch\(\s*['"][^'"]+['"]/g,
    ]
    for (const re of reHints) {
      let m: RegExpExecArray | null
      while ((m = re.exec(page1Html)) && scriptHints.length < 30) {
        scriptHints.push(m[0])
      }
    }
  }
  return c.json({ slug, results, scriptHints, frameworkBytes, frameworkSnippets })
})

// ─── Audit trail (Recent requests) ──────────────────────────────────────────

/**
 * Newest-first page of /now-playing audit summaries. now-playing.ts writes each
 * request as `np:<invertedTs>:<reqId>` with a compact summary in KV metadata, so
 * a single `list()` returns the most recent N rows (with their summary) in one
 * round-trip — no per-row get. Pass `cursor` (from a prior response) to page into
 * older records. Behind CF Access like everything here.
 */
subscriptionsApp.get('/api/audit', async (c) => {
  const n = parseInt(c.req.query('limit') || '50', 10)
  const limit = Math.min(Math.max(Number.isFinite(n) ? n : 50, 1), 200)
  const cursor = c.req.query('cursor') || undefined
  const res = await c.env.CACHE.list<Record<string, unknown>>({ prefix: 'np:', limit, cursor })
  const records = await Promise.all(
    res.keys.map(async (k) => {
      const base = { key: k.name, expiration: k.expiration ?? null }
      if (k.metadata) return { ...base, ...k.metadata }
      // Legacy record written before metadata summaries existed (flat shape).
      // Bounded work: only pre-upgrade keys lack metadata, and they age out.
      const v = await c.env.CACHE.get<Record<string, any>>(k.name, 'json')
      if (!v) return base
      return {
        ...base,
        t: v.t,
        status: v.status,
        title: v.videoTitle ?? v.input?.videoTitle ?? v.videoUrl ?? '',
        cs: v.currentSeconds ?? v.input?.currentSeconds ?? null,
        dur: v.videoDurationSeconds ?? v.input?.videoDurationSeconds ?? null,
        via: v.tracklistVia ?? v.search?.via ?? null,
        skew: v.select?.currentSkewSeconds ?? null,
        impossible: v.impossibleTimestamp ?? false,
        ms: v.meta?.totalMs ?? null,
      }
    }),
  )
  return c.json({ records, cursor: res.list_complete ? null : res.cursor, listComplete: res.list_complete })
})

/** Full audit record for one request (the value behind an `np:` key). */
subscriptionsApp.get('/api/audit-detail', async (c) => {
  const key = c.req.query('key') || ''
  if (!key.startsWith('np:')) return c.json({ error: 'bad_key' }, 400)
  const record = await c.env.CACHE.get(key, 'json')
  if (!record) return c.json({ error: 'not_found' }, 404)
  return c.json({ record })
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
    path: '/subscriptions/oauth',
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
  deleteCookie(c, STATE_COOKIE, { path: '/subscriptions/oauth' })

  if (errParam) {
    log.warn('oauth.callback.provider_error', { error: errParam })
    return c.redirect(`/subscriptions?yt_error=${encodeURIComponent(errParam)}`, 302)
  }
  if (!code || !stateParam || !stateCookie || stateParam !== stateCookie) {
    log.warn('oauth.callback.state_mismatch', { hasCode: !!code, hasState: !!stateParam, hasCookie: !!stateCookie })
    return c.redirect('/subscriptions?yt_error=state_mismatch', 302)
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
    return c.redirect('/subscriptions?yt=connected', 302)
  } catch (e) {
    log.error('oauth.callback.exchange_failed', errorFields(e))
    return c.redirect('/subscriptions?yt_error=exchange_failed', 302)
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
  /* HTML hidden attribute uses display:none, but our explicit .yt/.banner
     display:flex rules override that. Force [hidden] back to none. */
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
  li a:hover { text-decoration: underline; }
  li .meta { flex: 1; min-width: 0; }
  li .meta .added { color: var(--muted); font-size: 0.8rem; }
  #list-actions { display: flex; justify-content: flex-end; margin-bottom: 0.5rem; }
  #list-actions button { background: transparent; color: var(--accent); border: 1px solid var(--border); padding: 0.3rem 0.6rem; }
  .empty { color: var(--muted); padding: 2rem 0; text-align: center; }
  .error { color: var(--danger); margin: 0.5rem 0 1rem; min-height: 1.2em; }
  .error-detail { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.75rem; color: var(--muted); white-space: pre-wrap; word-break: break-word; max-height: 16em; overflow: auto; margin: 0.4rem 0 0; padding: 0.5rem 0.6rem; border: 1px solid var(--border); border-radius: 4px; background: var(--card); }
  footer { margin-top: 2rem; color: var(--muted); font-size: 0.8rem; }
  .yt { display: flex; align-items: center; gap: 0.75rem; padding: 0.6rem 0.75rem; border: 1px solid var(--border); border-radius: 6px; background: var(--card); margin-bottom: 1rem; }
  .yt .info { flex: 1; min-width: 0; font-size: 0.9rem; }
  .yt .info .title { font-weight: 600; }
  .yt .info .sub { color: var(--muted); font-size: 0.8rem; }
  .yt button.connect { background: #c4302b; }
  .banner { display: flex; align-items: center; gap: 0.75rem; padding: 0.6rem 0.75rem; border: 1px solid var(--danger); border-radius: 6px; background: var(--card); margin-bottom: 1rem; font-size: 0.9rem; }
  .banner .info { flex: 1; min-width: 0; }
  .banner .info .title { font-weight: 600; color: var(--danger); }
  .banner .info .sub { color: var(--muted); font-size: 0.8rem; }
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
</style>
</head>
<body>
<main>
  <h1>DJ subscriptions</h1>
  <p class="lead">Paste a 1001tracklists DJ URL like <code>https://www.1001tracklists.com/dj/lillypalmer/index.html</code>. &nbsp;·&nbsp; <a href="/subscriptions/tracklist">Tracklist viewer →</a></p>
  <div id="proxy-banner" class="banner" hidden>
    <div class="info">
      <div class="title">Home proxy IP-blocked at 1001tracklists</div>
      <div class="sub" id="proxy-banner-sub"></div>
    </div>
    <button id="proxy-clear">Clear backoff</button>
  </div>
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
  <div id="list-actions" hidden><button id="sync-all">Sync all</button></div>
  <ul id="list"></ul>
  <div id="empty" class="empty" hidden>No subscriptions yet.</div>

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
    btn.addEventListener('click', () => { window.location.href = '/subscriptions/oauth/start'; });
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
      slug.innerHTML = '<span class="slug"></span> · <a target="_blank" rel="noreferrer noopener"></a>';
      slug.querySelector('.slug').textContent = s.slug;
      const link = slug.querySelector('a');
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
      const rm = document.createElement('button');
      rm.className = 'danger';
      rm.textContent = 'Remove';
      rm.addEventListener('click', () => remove(s.slug, rm));
      li.appendChild(rm);
      $list.appendChild(li);
    }
  }

  async function syncSlug(slug, btn) {
    showError('');
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Syncing…';
    try {
      const r = await fetch('/subscriptions/api/sync/' + encodeURIComponent(slug), {
        method: 'POST',
        credentials: 'same-origin',
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
      const more = pending > 0 ? ' · ' + pending + ' more pending — auto-continuing every 5 min' : '';
      showError(
        'synced ' + slug + ' — ' + (stats.videoIdsAdded || 0) + ' new of ' +
        (stats.tracklistsProcessed || 0) + ' set' + (stats.tracklistsProcessed === 1 ? '' : 's') +
        ' processed (' + (stats.tracklistsSeen || 0) + ' total on the DJ page)' + more
      );
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  async function load() {
    showError('');
    const r = await fetch('/subscriptions/api/list', { credentials: 'same-origin' });
    if (!r.ok) { showError('failed to load (' + r.status + ')'); return; }
    const data = await r.json();
    render(data.subscriptions || []);
  }

  async function add(url) {
    showError('');
    $btn.disabled = true;
    try {
      const r = await fetch('/subscriptions/api/add', {
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
      const r = await fetch('/subscriptions/api/remove', {
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
    const r = await fetch('/subscriptions/api/youtube/status', { credentials: 'same-origin' });
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
      $ytAction.onclick = () => { window.location.href = '/subscriptions/oauth/start'; };
    }
  }

  async function disconnectYouTube() {
    if (!confirm('Disconnect this app from your YouTube account?')) return;
    $ytAction.disabled = true;
    try {
      const r = await fetch('/subscriptions/oauth/disconnect', { method: 'POST', credentials: 'same-origin' });
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

  // ── Home-proxy IP-block backoff banner ─────────────────────────────────
  const $proxyBanner = document.getElementById('proxy-banner');
  const $proxyBannerSub = document.getElementById('proxy-banner-sub');
  const $proxyClear = document.getElementById('proxy-clear');

  async function loadProxyStatus() {
    try {
      const r = await fetch('/subscriptions/api/home-proxy-status', { credentials: 'same-origin' });
      if (!r.ok) { $proxyBanner.hidden = true; return; }
      const data = await r.json();
      if (data.blocked && data.until) {
        const untilDate = new Date(data.until * 1000);
        $proxyBannerSub.textContent =
          'Skipping home proxy until ' + untilDate.toLocaleTimeString() +
          '. Solve the captcha at 1001tracklists.com from your home network, then click Clear.';
        $proxyBanner.hidden = false;
      } else {
        $proxyBanner.hidden = true;
      }
    } catch { $proxyBanner.hidden = true; }
  }

  $proxyClear.addEventListener('click', async () => {
    $proxyClear.disabled = true;
    const original = $proxyClear.textContent;
    $proxyClear.textContent = 'Clearing…';
    try {
      const r = await fetch('/subscriptions/api/home-proxy-status/clear', {
        method: 'POST', credentials: 'same-origin',
      });
      if (!r.ok) { showError('clear failed (' + r.status + ')'); return; }
      await loadProxyStatus();
    } finally {
      $proxyClear.disabled = false;
      $proxyClear.textContent = original;
    }
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
          const resp = await fetch('/subscriptions/api/audit-detail?key=' + encodeURIComponent(r.key), { credentials: 'same-origin' });
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
      const r = await fetch('/subscriptions/api/audit?' + params.toString(), { credentials: 'same-origin' });
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

  // Cf-Access-Authenticated-User-Email is forwarded by Access; surface it for confidence.
  document.getElementById('who').textContent = document.cookie.includes('CF_Authorization=') ? 'Cloudflare Access' : 'dev';

  load();
  loadYouTubeStatus();
  loadProxyStatus();
  loadAudit(true);
  // Re-poll the home-proxy status so the banner reflects KV changes
  // initiated outside this tab (e.g. clearing via curl, or a sync run
  // tripping a fresh backoff in the background).
  setInterval(loadProxyStatus, 15_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadProxyStatus();
  });
})();
</script>
</body>
</html>`

const TRACKLIST_PAGE_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>tracked — tracklist viewer</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #0e1116; --fg: #e6edf3; --muted: #8b949e; --accent: #58a6ff;
    --danger: #f85149; --card: #161b22; --border: #30363d;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg: #ffffff; --fg: #1f2328; --muted: #59636e; --accent: #0969da; --danger: #cf222e; --card: #f6f8fa; --border: #d0d7de; }
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body { margin: 0; padding: 2rem 1rem; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  main { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 0.25rem; }
  p.lead { color: var(--muted); margin: 0 0 1.25rem; }
  p.lead a { color: var(--accent); text-decoration: none; }
  p.lead a:hover { text-decoration: underline; }
  form { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
  input[type="url"] { flex: 1; padding: 0.6rem 0.75rem; font: inherit; background: var(--card); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; }
  input[type="url"]:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  button.load { padding: 0.6rem 1rem; font: inherit; background: var(--accent); color: #fff; border: 0; border-radius: 6px; cursor: pointer; }
  button.load:disabled { opacity: 0.5; cursor: progress; }
  .error { color: var(--danger); margin: 0.25rem 0 1rem; min-height: 1.2em; white-space: pre-wrap; }
  .setmeta { color: var(--muted); font-size: 0.85rem; margin: 0 0 1rem; display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; }
  .setmeta a { color: var(--accent); text-decoration: none; }
  .setmeta a:hover { text-decoration: underline; }
  ul { list-style: none; padding: 0; margin: 0; }
  li.track { display: flex; align-items: center; gap: 0.75rem; padding: 0.55rem 0.7rem; border: 1px solid var(--border); border-radius: 8px; background: var(--card); margin-bottom: 0.45rem; }
  li.track .num { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 0.8rem; width: 1.8rem; text-align: right; flex: none; }
  li.track img.art { width: 40px; height: 40px; border-radius: 4px; object-fit: cover; flex: none; background: var(--border); }
  li.track .art.ph { width: 40px; height: 40px; border-radius: 4px; flex: none; background: var(--border); }
  li.track .meta { flex: 1; min-width: 0; }
  li.track .title { font-weight: 600; font-size: 0.92rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  li.track .title a { color: inherit; text-decoration: none; }
  li.track .title a:hover { text-decoration: underline; }
  li.track .sub { color: var(--muted); font-size: 0.78rem; display: flex; align-items: center; gap: 0.5rem; margin-top: 0.1rem; }
  li.track .cue { font-variant-numeric: tabular-nums; }
  li.track .tag { font-size: 0.66rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; padding: 0.1rem 0.4rem; border-radius: 999px; background: rgba(210,153,34,0.18); color: #d29922; }
  li.track .actions { display: flex; align-items: center; gap: 0.5rem; flex: none; }
  a.yt { display: inline-flex; align-items: center; line-height: 0; border-radius: 4px; }
  a.yt:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  a.pill { display: inline-flex; align-items: center; gap: 0.3rem; padding: 0.35rem 0.6rem; font-size: 0.78rem; font-weight: 600; text-decoration: none; color: var(--fg); background: transparent; border: 1px solid var(--border); border-radius: 999px; white-space: nowrap; }
  a.pill:hover { border-color: var(--accent); color: var(--accent); }
  a.pill.sc:hover { border-color: #ff5500; color: #ff5500; }
  .empty { color: var(--muted); padding: 2rem 0; text-align: center; }
  footer { margin-top: 2rem; color: var(--muted); font-size: 0.8rem; }
</style>
</head>
<body>
<main>
  <h1>Tracklist viewer</h1>
  <p class="lead">Paste a 1001tracklists tracklist URL to see a clean per-song list with direct YouTube, SoundCloud, and Apple Music links. &nbsp;·&nbsp; <a href="/subscriptions">← Subscriptions</a></p>
  <form id="load-form">
    <input id="url" type="url" placeholder="https://www.1001tracklists.com/tracklist/.../....html" required autofocus />
    <button type="submit" class="load">Load</button>
  </form>
  <div id="error" class="error" role="alert"></div>
  <div id="setmeta" class="setmeta" hidden></div>
  <ul id="tracks"></ul>
  <div id="empty" class="empty" hidden></div>
  <footer>Signed in as <span id="who"></span></footer>
</main>
<script>
(() => {
  const $form = document.getElementById('load-form');
  const $url = document.getElementById('url');
  const $btn = $form.querySelector('button');
  const $error = document.getElementById('error');
  const $setmeta = document.getElementById('setmeta');
  const $tracks = document.getElementById('tracks');
  const $empty = document.getElementById('empty');

  // Static, data-free SVG for the YouTube glyph — safe to inject as innerHTML.
  const YT_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="#FF0000" d="M23 7.5a3 3 0 0 0-2.1-2.1C19 5 12 5 12 5s-7 0-8.9.4A3 3 0 0 0 1 7.5 31 31 0 0 0 .6 12 31 31 0 0 0 1 16.5a3 3 0 0 0 2.1 2.1C5 19 12 19 12 19s7 0 8.9-.4a3 3 0 0 0 2.1-2.1A31 31 0 0 0 23.4 12 31 31 0 0 0 23 7.5Z"/><path fill="#fff" d="M9.8 15.5v-7l6 3.5-6 3.5Z"/></svg>';
  const APPLE_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="currentColor"><path d="M16.4 12.8c0-2.2 1.8-3.3 1.9-3.3-1-1.5-2.6-1.7-3.2-1.7-1.4-.1-2.6.8-3.3.8-.7 0-1.7-.8-2.8-.8-1.4 0-2.8.8-3.5 2.1-1.5 2.6-.4 6.5 1.1 8.6.7 1 1.5 2.2 2.6 2.2 1 0 1.4-.7 2.7-.7 1.2 0 1.6.7 2.7.6 1.1 0 1.8-1 2.5-2 .8-1.2 1.1-2.3 1.1-2.3s-2.1-.8-2.1-3.2ZM14.3 5.9c.6-.7 1-1.7.9-2.7-.9 0-1.9.6-2.5 1.3-.5.6-1 1.6-.9 2.6 1 .1 2-.5 2.5-1.2Z"/></svg>';
  // SoundCloud — a simple cloud + waveform bars, brand orange.
  const SC_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="#ff5500"><path d="M1.5 13.2c-.1 0-.2.1-.2.2l-.2 1.7.2 1.6c0 .1.1.2.2.2s.2-.1.2-.2l.2-1.6-.2-1.7c0-.1-.1-.2-.2-.2Zm1.6-1c-.1 0-.2.1-.2.2l-.3 2.7.3 2.6c0 .1.1.2.2.2s.2-.1.2-.2l.3-2.6-.3-2.7c0-.1-.1-.2-.2-.2Zm1.7-.4c-.1 0-.3.1-.3.3l-.2 3.1.2 3c0 .2.1.3.3.3.1 0 .3-.1.3-.3l.3-3-.3-3.1c0-.2-.2-.3-.3-.3Zm1.8-.3c-.2 0-.3.1-.3.3l-.2 3.4.2 3.2c0 .2.1.3.3.3s.3-.1.3-.3l.2-3.2-.2-3.4c0-.2-.1-.3-.3-.3ZM22 12.6a2.9 2.9 0 0 0-1.1.2c-.2-2.5-2.3-4.5-4.9-4.5-.6 0-1.2.1-1.8.4-.2.1-.3.2-.3.4v8.1c0 .2.2.4.4.4H22a2.5 2.5 0 0 0 0-5Zm-13.9-1c-.2 0-.3.2-.3.4l-.2 3.1.2 3c0 .2.2.3.3.3.2 0 .3-.1.3-.3l.2-3-.2-3.1c0-.2-.1-.4-.3-.4Zm1.9-.7c-.2 0-.4.2-.4.4l-.1 3.8.1 3c0 .2.2.4.4.4.2 0 .4-.2.4-.4l.2-3-.2-3.8c0-.2-.2-.4-.4-.4Z"/></svg>';

  // Untrusted third-party text (artist/title from 1001tracklists) — build every
  // node with textContent, and only ever set href to an http(s) URL, so a
  // hostile value can never become markup or a javascript: link.
  function safeHref(a, u) {
    if (!u) return false;
    const lo = String(u).toLowerCase();
    if (!(lo.startsWith('http://') || lo.startsWith('https://'))) return false;
    a.href = u; a.target = '_blank'; a.rel = 'noreferrer noopener';
    return true;
  }

  function render(data) {
    $tracks.innerHTML = '';
    $setmeta.innerHTML = '';

    const parts = [];
    const count = document.createElement('span');
    count.textContent = (data.trackCount || 0) + ' track' + (data.trackCount === 1 ? '' : 's');
    parts.push(count);
    const src = document.createElement('a');
    if (safeHref(src, data.tracklistUrl)) { src.textContent = '1001tracklists page ↗'; parts.push(src); }
    if (data.setAppleLink) {
      const al = document.createElement('a');
      if (safeHref(al, data.setAppleLink)) { al.textContent = 'Apple Music (full set) ↗'; parts.push(al); }
    }
    parts.forEach((p) => $setmeta.appendChild(p));
    $setmeta.hidden = false;

    for (const t of (data.tracks || [])) {
      const li = document.createElement('li');
      li.className = 'track';

      const num = document.createElement('div');
      num.className = 'num';
      num.textContent = String((t.index ?? 0) + 1);
      li.appendChild(num);

      if (t.artworkUrl) {
        const img = document.createElement('img');
        img.className = 'art';
        img.loading = 'lazy';
        img.alt = '';
        img.src = t.artworkUrl;
        // Fall back to a neutral placeholder if the CDN 404s / hotlink-blocks.
        img.addEventListener('error', () => { const ph = document.createElement('div'); ph.className = 'art ph'; img.replaceWith(ph); });
        li.appendChild(img);
      } else {
        const ph = document.createElement('div');
        ph.className = 'art ph';
        li.appendChild(ph);
      }

      const meta = document.createElement('div');
      meta.className = 'meta';
      const title = document.createElement('div');
      title.className = 'title';
      const label = (t.artist ? t.artist + ' – ' : '') + (t.title || 'ID');
      if (t.trackUrl) {
        const a = document.createElement('a');
        a.textContent = label;
        if (!safeHref(a, t.trackUrl)) { title.textContent = label; } else { title.appendChild(a); }
      } else {
        title.textContent = label;
      }
      meta.appendChild(title);

      const sub = document.createElement('div');
      sub.className = 'sub';
      if (t.startTime) { const cue = document.createElement('span'); cue.className = 'cue'; cue.textContent = t.startTime; sub.appendChild(cue); }
      if (t.idStatus) { const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = t.idStatus; sub.appendChild(tag); }
      else if (t.isUnidentified) { const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = 'ID'; sub.appendChild(tag); }
      if (t.isMashupLinked) { const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = 'w/'; sub.appendChild(tag); }
      meta.appendChild(sub);
      li.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'actions';
      if (t.youtubeLink) {
        const a = document.createElement('a');
        a.className = 'yt';
        a.title = 'Play on YouTube';
        a.setAttribute('aria-label', 'Play on YouTube');
        if (safeHref(a, t.youtubeLink)) { a.innerHTML = YT_SVG; actions.appendChild(a); }
      }
      if (t.soundcloudLink) {
        const a = document.createElement('a');
        a.className = 'pill sc';
        a.title = 'Play on SoundCloud (free, ad-supported)';
        const glyph = document.createElement('span'); glyph.style.display = 'inline-flex'; glyph.innerHTML = SC_SVG;
        const txt = document.createElement('span'); txt.textContent = 'SoundCloud';
        if (safeHref(a, t.soundcloudLink)) { a.appendChild(glyph); a.appendChild(txt); actions.appendChild(a); }
      }
      if (t.appleLink) {
        const a = document.createElement('a');
        a.className = 'pill apple';
        a.title = 'Open in Apple Music';
        const glyph = document.createElement('span'); glyph.style.display = 'inline-flex'; glyph.innerHTML = APPLE_SVG;
        const txt = document.createElement('span'); txt.textContent = 'Apple Music';
        if (safeHref(a, t.appleLink)) { a.appendChild(glyph); a.appendChild(txt); actions.appendChild(a); }
      }
      li.appendChild(actions);

      $tracks.appendChild(li);
    }
    $empty.hidden = true;
  }

  async function load(url) {
    $error.textContent = '';
    $empty.hidden = true;
    $btn.disabled = true;
    const original = $btn.textContent;
    $btn.textContent = 'Loading…';
    try {
      const r = await fetch('/subscriptions/api/tracklist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ url }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        $tracks.innerHTML = '';
        $setmeta.hidden = true;
        $error.textContent = (data.message || data.error || ('failed (' + r.status + ')'));
        return;
      }
      if (!data.tracks || data.tracks.length === 0) {
        $tracks.innerHTML = '';
        $setmeta.hidden = true;
        $empty.textContent = 'No tracks found.';
        $empty.hidden = false;
        return;
      }
      render(data);
    } catch (e) {
      $error.textContent = 'request failed: ' + (e && e.message ? e.message : e);
    } finally {
      $btn.disabled = false;
      $btn.textContent = original;
    }
  }

  $form.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $url.value.trim();
    if (!url) return;
    // Reflect the loaded set in the address bar so it can be shared/bookmarked.
    try { history.replaceState({}, '', location.pathname + '?url=' + encodeURIComponent(url)); } catch {}
    load(url);
  });

  document.getElementById('who').textContent = document.cookie.includes('CF_Authorization=') ? 'Cloudflare Access' : 'dev';

  // Deep-link support: /subscriptions/tracklist?url=... prefills and auto-loads.
  const pre = new URLSearchParams(location.search).get('url');
  if (pre) { $url.value = pre; load(pre); }
})();
</script>
</body>
</html>`
