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

const STATE_COOKIE = 'yt_oauth_state'

export const subscriptionsApp = new Hono<{
  Bindings: Env
  Variables: { cfAccessEmail: string }
}>()

subscriptionsApp.use('*', cfAccess)

subscriptionsApp.get('/', (c) => {
  // The page bundles its own JS inline. no-store keeps browsers from
  // serving a stale page after a deploy, which would mean stale UI logic
  // (e.g. a banner that doesn't auto-refresh).
  c.header('Cache-Control', 'no-store')
  return c.html(PAGE_HTML)
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
    log.error('subs.sync_all_throw', errorFields(e))
    return c.json({ error: 'sync_failed', message: e instanceof Error ? e.message : String(e) }, 500)
  }
})

subscriptionsApp.post('/api/sync/:slug', async (c) => {
  const log = makeLogger({
    reqId: c.req.raw.headers.get('cf-ray') ?? 'local',
    route: 'subs.sync_one',
    by: c.get('cfAccessEmail'),
  })
  const slug = c.req.param('slug')
  const subs = await listSubscriptions(c.env)
  const sub = subs.find((s) => s.slug === slug)
  if (!sub) return c.json({ error: 'not_subscribed', slug }, 404)
  // syncOne needs a fresh access token; the helper auto-refreshes near expiry.
  const tokenInfo = await getAccessToken(c.env)
  if (!tokenInfo) return c.json({ error: 'youtube_not_connected' }, 412)
  try {
    const result = await syncOne(c.env, sub, tokenInfo.accessToken, { log })
    return c.json(result)
  } catch (e) {
    log.error('subs.sync_one_throw', { slug, ...errorFields(e) })
    return c.json({ error: 'sync_failed', message: e instanceof Error ? e.message : String(e) }, 500)
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
  .empty { color: var(--muted); padding: 2rem 0; text-align: center; }
  .error { color: var(--danger); margin: 0.5rem 0 1rem; min-height: 1.2em; }
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
</style>
</head>
<body>
<main>
  <h1>DJ subscriptions</h1>
  <p class="lead">Paste a 1001tracklists DJ URL like <code>https://www.1001tracklists.com/dj/lillypalmer/index.html</code>.</p>
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
  <ul id="list"></ul>
  <div id="empty" class="empty" hidden>No subscriptions yet.</div>
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

  function showError(msg) { $error.textContent = msg ?? ''; }

  function fmtDate(epoch) {
    if (!epoch) return '';
    try { return new Date(epoch * 1000).toLocaleDateString(); } catch { return ''; }
  }

  function render(subs) {
    $list.innerHTML = '';
    if (!subs.length) { $empty.hidden = false; return; }
    $empty.hidden = true;
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
      sync.className = 'danger';
      sync.textContent = 'Sync';
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
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        showError(data.message || data.error || ('sync failed (' + r.status + ')'));
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

  // Cf-Access-Authenticated-User-Email is forwarded by Access; surface it for confidence.
  document.getElementById('who').textContent = document.cookie.includes('CF_Authorization=') ? 'Cloudflare Access' : 'dev';

  load();
  loadYouTubeStatus();
  loadProxyStatus();
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
