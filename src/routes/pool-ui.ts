/**
 * Admin pages for the tlpool browser pool, and the `/subscriptions/api/pool/*`
 * routes they call. Mounted at `/subscriptions` (in `index.ts`, ahead of the
 * main subscriptions app), gated by Cloudflare Access like every other admin
 * page, and never by the bearer token.
 *
 *   GET  /pool                          accounts + pool status (+ Add account dialog)
 *   GET  /pool/settings                 budget, ramp, phone share, images; recheck schedule
 *   GET  /captcha                       every pending challenge
 *   GET  /captcha/:id                   one challenge: image + answer box, or the live view
 *
 *   GET  /api/pool/status               tlpool GET /status (+ GET /challenges)
 *   GET  /api/pool/accounts             tlpool GET /accounts
 *   POST /api/pool/accounts             tlpool POST /accounts {passive}
 *   POST /api/pool/accounts/:id/:action tlpool POST /accounts/:id/{rest,retire,retest}
 *   GET  /api/pool/challenges           tlpool GET /challenges
 *   GET  /api/pool/challenges/:id       tlpool GET /challenges/:id
 *   GET  /api/pool/challenges/:id/image tlpool GET /challenges/:id/image (PNG)
 *   POST /api/pool/challenges/:id/answer tlpool POST /challenges/:id/answer {text}
 *   GET  /api/pool/challenges/:id/live/* tlpool GET /challenges/:id/live/* (noVNC + websocket)
 *   GET|PUT /api/pool/limits            tlpool GET|PUT /settings
 *
 * `/api/pool/settings` (the recheck schedule and priority order) belongs to
 * `routes/pool-api.ts`; the settings page only calls it.
 *
 * The Worker is the only thing holding TLPOOL_TOKEN; the browser only ever
 * talks to these routes. `lib/pool-admin-client.ts` rebuilds every upstream
 * object from a whitelist, so no username, email or password reaches a page.
 */
import { Hono, type Context } from 'hono'
import type { Env } from '../types'
import { cfAccess } from '../middleware/cf-access'
import { makeLogger, errorFields } from '../lib/log'
import {
  ACCOUNT_ACTIONS,
  createPoolAdminClient,
  ID_RE,
  PoolAdminError,
  validateSettingsPatch,
  type AccountAction,
  type Fetcher,
  type PoolEnv,
} from '../lib/pool-admin-client'

type AppEnv = { Bindings: Env; Variables: { cfAccessEmail: string } }

export function createPoolUiApp(opts: { fetcher?: Fetcher } = {}) {
  const app = new Hono<AppEnv>()
  const client = (env: Env) => createPoolAdminClient(env as PoolEnv, opts.fetcher)

  // Scoped to this app's own paths: a `use('*')` here would also run on every
  // other /subscriptions/* request, since both apps share the mount point.
  for (const p of [
    '/pool', '/pool/*', '/captcha', '/captcha/*',
    '/api/pool/status', '/api/pool/accounts', '/api/pool/accounts/*',
    '/api/pool/challenges', '/api/pool/challenges/*', '/api/pool/limits',
  ]) app.use(p, cfAccess)

  app.onError((e, c) => {
    if (e instanceof PoolAdminError) {
      return c.json({ error: e.code, ...(e.detail ? { detail: e.detail } : {}) }, e.status)
    }
    const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'pool_ui.unhandled', path: new URL(c.req.url).pathname })
    log.error('pool_ui.unhandled_throw', errorFields(e))
    // No message: an unexpected throw could carry the upstream URL.
    return c.json({ error: 'internal' }, 500)
  })

  const page = (c: Context<AppEnv>, html: string) => {
    c.header('Cache-Control', 'no-store')
    return c.html(html)
  }

  // ── pages ────────────────────────────────────────────────────────────────
  app.get('/pool', (c) => page(c, POOL_PAGE_HTML))
  app.get('/pool/settings', (c) => page(c, SETTINGS_PAGE_HTML))
  app.get('/captcha', (c) => page(c, CAPTCHA_LIST_HTML))
  app.get('/captcha/:id', (c) => {
    const id = c.req.param('id')
    if (!ID_RE.test(id)) return c.text('Not a challenge id', 404)
    return page(c, captchaPageHtml(id))
  })

  // ── API ──────────────────────────────────────────────────────────────────
  app.get('/api/pool/status', async (c) => {
    const pool = client(c.env)
    const [status, challenges] = await Promise.all([
      pool.status(),
      pool.listChallenges().catch((e) => (e instanceof PoolAdminError ? { error: e.code } : { error: 'internal' })),
    ])
    return c.json({ status, challenges: Array.isArray(challenges) ? challenges : [], challengesError: Array.isArray(challenges) ? null : challenges.error })
  })

  app.get('/api/pool/accounts', async (c) => c.json({ accounts: await client(c.env).listAccounts() }))

  app.post('/api/pool/accounts', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { passive?: unknown } | null
    if (body !== null && typeof body !== 'object') return c.json({ error: 'invalid', detail: 'body_not_object' }, 400)
    const passive = body?.passive === true
    const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'pool_ui.create_account', by: c.get('cfAccessEmail') })
    const r = await client(c.env).createAccount(passive)
    log.info('pool_ui.account_create_started', { passive, challengeId: r.challengeId, accountId: r.accountId })
    return c.json(r)
  })

  app.post('/api/pool/accounts/:id/:action', async (c) => {
    const { id, action } = c.req.param()
    if (!ID_RE.test(id)) return c.json({ error: 'invalid', detail: 'bad_id' }, 400)
    if (!(ACCOUNT_ACTIONS as readonly string[]).includes(action)) return c.json({ error: 'not_found', detail: 'unknown_action' }, 404)
    const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'pool_ui.account_action', by: c.get('cfAccessEmail') })
    const account = await client(c.env).accountAction(id, action as AccountAction)
    log.info('pool_ui.account_action', { accountId: id, action })
    return c.json({ ok: true, account })
  })

  app.get('/api/pool/challenges', async (c) => c.json({ challenges: await client(c.env).listChallenges() }))

  app.get('/api/pool/challenges/:id', async (c) => {
    const id = c.req.param('id')
    if (!ID_RE.test(id)) return c.json({ error: 'invalid', detail: 'bad_id' }, 400)
    return c.json({ challenge: await client(c.env).getChallenge(id) })
  })

  app.get('/api/pool/challenges/:id/image', async (c) => {
    const id = c.req.param('id')
    if (!ID_RE.test(id)) return c.json({ error: 'invalid', detail: 'bad_id' }, 400)
    const img = await client(c.env).challengeImage(id, c.req.query('refresh') === '1')
    return new Response(img.body, { headers: { 'Content-Type': img.contentType, 'Cache-Control': 'no-store' } })
  })

  app.post('/api/pool/challenges/:id/answer', async (c) => {
    const id = c.req.param('id')
    if (!ID_RE.test(id)) return c.json({ error: 'invalid', detail: 'bad_id' }, 400)
    const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (!text || text.length > 200) return c.json({ error: 'invalid', detail: 'empty_answer' }, 400)
    const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'pool_ui.answer', by: c.get('cfAccessEmail') })
    const outcome = await client(c.env).answer(id, text)
    log.info('pool_ui.answer', { challengeId: id, outcome })
    return c.json({ outcome })
  })

  // The live view: noVNC page, its assets and its websocket, all under
  // `/live/`. The iframe points at `/live/` (trailing slash) so relative
  // asset URLs resolve under it.
  const live = async (c: Context<AppEnv>) => {
    const id = c.req.param('id') ?? ''
    if (!ID_RE.test(id)) return c.json({ error: 'invalid', detail: 'bad_id' }, 400)
    const url = new URL(c.req.url)
    const marker = `/challenges/${id}/live`
    const idx = url.pathname.indexOf(marker)
    const sub = idx >= 0 ? url.pathname.slice(idx + marker.length).replace(/^\/+/, '') : ''
    return client(c.env).live(id, sub, url.search, c.req.raw)
  }
  app.get('/api/pool/challenges/:id/live', (c) => c.redirect(new URL(c.req.url).pathname + '/' + new URL(c.req.url).search, 302))
  app.get('/api/pool/challenges/:id/live/*', live)

  app.get('/api/pool/limits', async (c) => c.json({ settings: await client(c.env).getSettings() }))
  app.put('/api/pool/limits', async (c) => {
    const patch = validateSettingsPatch(await c.req.json().catch(() => null))
    const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'pool_ui.put_limits', by: c.get('cfAccessEmail') })
    const settings = await client(c.env).putSettings(patch)
    log.info('pool_ui.limits_saved', { patch })
    return c.json({ settings })
  })

  return app
}

export const poolUiApp = createPoolUiApp()

// ─────────────────────────────────────────────────────────────────────────────
// Pages. Inline, no bundler, same palette as the other admin pages.
// ─────────────────────────────────────────────────────────────────────────────

const POOL_CSS = /* css */ `
  :root { color-scheme: light dark; --bg: #0e1116; --fg: #e6edf3; --muted: #8b949e; --accent: #58a6ff; --danger: #f85149; --ok: #3fb950; --warn: #d29922; --card: #161b22; --border: #30363d; }
  @media (prefers-color-scheme: light) { :root { --bg: #ffffff; --fg: #1f2328; --muted: #59636e; --accent: #0969da; --danger: #cf222e; --ok: #1a7f37; --warn: #9a6700; --card: #f6f8fa; --border: #d0d7de; } }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body { margin: 0; padding: 1.25rem 1rem 3rem; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  main { max-width: 820px; margin: 0 auto; }
  main.narrow { max-width: 560px; }
  h1 { font-size: 1.4rem; margin: 0 0 0.25rem; }
  h2 { font-size: 1.05rem; margin: 1.75rem 0 0.6rem; }
  p.lead { color: var(--muted); margin: 0 0 1.25rem; font-size: 0.9rem; }
  a { color: var(--accent); }
  button { padding: 0.6rem 1rem; font: inherit; background: var(--accent); color: #fff; border: 0; border-radius: 6px; cursor: pointer; min-height: 2.5rem; }
  button:disabled { opacity: 0.5; cursor: progress; }
  button.ghost { background: transparent; color: var(--accent); border: 1px solid var(--border); }
  button.danger { background: var(--danger); }
  button.small { padding: 0.3rem 0.65rem; font-size: 0.85rem; min-height: 2.1rem; }
  input, select { font: inherit; padding: 0.5rem 0.6rem; background: var(--card); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; }
  input:focus, select:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  .muted { color: var(--muted); }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .error { color: var(--danger); }
  .card { border: 1px solid var(--border); border-radius: 8px; background: var(--card); padding: 0.8rem 0.9rem; margin-bottom: 0.75rem; }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
  .spacer { flex: 1; }
  .badge { display: inline-block; font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; padding: 0.14rem 0.45rem; border-radius: 999px; white-space: nowrap; background: color-mix(in srgb, var(--fg) 10%, transparent); color: var(--muted); }
  .badge.ok { background: rgba(63,185,80,0.18); color: var(--ok); }
  .badge.warn { background: rgba(210,153,34,0.18); color: var(--warn); }
  .badge.bad { background: rgba(248,81,73,0.16); color: var(--danger); }
  .badge.info { background: rgba(88,166,255,0.18); color: var(--accent); }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: 0.6rem; margin-bottom: 0.75rem; }
  .stat { border: 1px solid var(--border); border-radius: 8px; background: var(--card); padding: 0.6rem 0.75rem; }
  .stat .v { font-size: 1.35rem; font-weight: 700; font-variant-numeric: tabular-nums; }
  .stat .k { color: var(--muted); font-size: 0.78rem; }
  .chips { display: flex; flex-wrap: wrap; gap: 0.35rem; font-size: 0.8rem; }
  .chip { border: 1px solid var(--border); border-radius: 999px; padding: 0.1rem 0.55rem; }
  table.accts { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  table.accts th, table.accts td { text-align: left; padding: 0.45rem 0.5rem; border-bottom: 1px solid var(--border); vertical-align: top; }
  table.accts th { color: var(--muted); font-weight: 600; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.03em; }
  table.accts td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .acts { display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem; font-size: 0.82rem; }
  /* Phone first: each account is a card, each cell a labelled line. */
  @media (max-width: 700px) {
    table.accts thead { display: none; }
    table.accts, table.accts tbody, table.accts tr, table.accts td { display: block; width: 100%; }
    table.accts tr { border: 1px solid var(--border); border-radius: 8px; background: var(--card); margin-bottom: 0.6rem; padding: 0.35rem 0.2rem; }
    table.accts td { border: 0; padding: 0.2rem 0.6rem; display: flex; gap: 0.6rem; }
    table.accts td::before { content: attr(data-l); color: var(--muted); min-width: 6.5rem; font-size: 0.78rem; }
    table.accts td.acts-cell::before { content: none; }
  }
  ul.plain { list-style: none; margin: 0; padding: 0; }
  ul.plain li { border: 1px solid var(--border); border-radius: 8px; background: var(--card); padding: 0.7rem 0.8rem; margin-bottom: 0.5rem; }
  .empty { color: var(--muted); padding: 1rem 0; }
  dialog { width: min(34rem, calc(100vw - 1.5rem)); max-height: calc(100dvh - 2rem); border: 1px solid var(--border); border-radius: 10px; background: var(--bg); color: var(--fg); padding: 1rem; }
  dialog::backdrop { background: rgba(0,0,0,0.55); }
  .switch { display: flex; align-items: flex-start; gap: 0.75rem; padding: 0.75rem; border: 1px solid var(--border); border-radius: 8px; cursor: pointer; }
  .switch input { width: 1.5rem; height: 1.5rem; margin: 0.1rem 0 0; flex-shrink: 0; }
  ol.steps { list-style: none; margin: 0.75rem 0; padding: 0; }
  ol.steps li { display: flex; gap: 0.6rem; align-items: center; padding: 0.3rem 0; color: var(--muted); }
  ol.steps li .dot { width: 1.3rem; text-align: center; }
  ol.steps li.done { color: var(--fg); }
  ol.steps li.done .dot { color: var(--ok); }
  ol.steps li.cur { color: var(--fg); font-weight: 600; }
  ol.steps li.fail { color: var(--danger); font-weight: 600; }
  /* Captcha widget: big touch targets, a phone is the main client. */
  .cap-img { display: block; width: 100%; max-width: 100%; min-height: 4rem; border: 1px solid var(--border); border-radius: 8px; background: #fff; image-rendering: auto; }
  .cap-form { display: flex; flex-direction: column; gap: 0.6rem; margin-top: 0.75rem; }
  .cap-form input { font-size: 1.6rem; padding: 0.7rem 0.8rem; min-height: 3.4rem; letter-spacing: 0.08em; text-align: center; }
  .cap-form button { font-size: 1.15rem; min-height: 3.2rem; font-weight: 600; }
  .cap-tools { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
  .cap-tools button { flex: 1; }
  .cap-msg { min-height: 1.4em; margin-top: 0.6rem; font-weight: 600; }
  .cap-msg.ok { color: var(--ok); }
  .cap-msg.bad { color: var(--danger); }
  .cap-live { width: 100%; height: 70vh; min-height: 22rem; border: 1px solid var(--border); border-radius: 8px; background: #000; }
  .left { font-variant-numeric: tabular-nums; }
  .left.soon { color: var(--danger); font-weight: 700; }
  .banner { border-radius: 8px; padding: 0.9rem 1rem; margin: 0.75rem 0; font-weight: 600; }
  .banner.ok { background: rgba(63,185,80,0.16); color: var(--ok); border: 1px solid var(--ok); }
  .banner.bad { background: rgba(248,81,73,0.12); color: var(--danger); border: 1px solid var(--danger); }
  .banner.info { background: rgba(88,166,255,0.12); color: var(--accent); border: 1px solid var(--accent); }
  .field { display: grid; gap: 0.25rem; margin-bottom: 0.8rem; }
  .field label { font-weight: 600; font-size: 0.9rem; }
  .field .hint { color: var(--muted); font-size: 0.8rem; }
  .field input[type=number] { width: 7rem; }
  table.sched { border-collapse: collapse; font-size: 0.88rem; width: 100%; }
  table.sched td, table.sched th { padding: 0.3rem 0.4rem; border-bottom: 1px solid var(--border); text-align: left; }
  table.sched input { width: 5.5rem; }
  .prio { display: flex; align-items: center; gap: 0.4rem; padding: 0.35rem 0; border-bottom: 1px solid var(--border); }
  .prio .n { width: 1.5rem; color: var(--muted); }
  .prio .name { flex: 1; }
`

const NAV_HTML = /* html */ `<a href="/subscriptions">Subscriptions</a> &nbsp;·&nbsp; <a href="/subscriptions/pool">Pool</a> &nbsp;·&nbsp; <a href="/subscriptions/captcha">Captchas</a> &nbsp;·&nbsp; <a href="/subscriptions/pool/settings">Pool settings</a>`

/** Shared helpers for every pool page. */
const COMMON_JS = /* js */ `
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  async function api(path, init) {
    let r;
    try { r = await fetch('/subscriptions/api/pool' + path, { credentials: 'same-origin', ...(init || {}) }); }
    catch (e) { return { ok: false, status: 0, data: { error: 'network' } }; }
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  }
  const jsonInit = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const ERRORS = {
    network: 'Your phone could not reach the tracked site. Check the connection and try again.',
    unauthorized: 'Your Cloudflare Access login has expired. Reload the page to sign in again.',
    forbidden: 'This Cloudflare Access login is not allowed here.',
    pool_not_configured: 'The pool service is not set up on the Worker yet (TLPOOL_URL and TLPOOL_TOKEN are missing).',
    pool_unreachable: 'The pool service on the NAS did not answer. Is tlpool running and the tunnel up?',
    pool_auth_failed: 'The pool service refused the Worker\\'s token. The two tokens do not match.',
    pool_error: 'The pool service hit an error on its side.',
    bad_response: 'The pool service answered something this page does not understand.',
    not_found: 'Not found. It may have been closed or finished already.',
    conflict: 'The pool is already busy doing that.',
    expired: 'This has expired.',
    invalid: 'That was not accepted.',
    too_many: 'Too many at once. Wait a moment and try again.',
    internal: 'Something went wrong in the Worker.',
    no_free_exit: 'There is no free exit IP to pin a new account to.',
    email_timeout: 'The confirmation email never arrived.',
    signup_rejected: '1001tracklists refused the signup form.',
    login_failed: 'The new account could not log in.',
    captcha_expired: 'Nobody answered the captcha in time.',
    username_taken: 'The generated username was taken.',
  };
  function errText(d, status) {
    const code = d && d.error;
    const base = ERRORS[code] || (code ? 'Error: ' + String(code).replace(/_/g, ' ') + '.' : 'Unexpected answer (HTTP ' + status + ').');
    const det = d && d.detail ? ' (' + String(d.detail).replace(/_/g, ' ') + ')' : '';
    return base + det;
  }
  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function fmtDur(ms) {
    const m = Math.max(0, Math.round(ms / 60000));
    if (m < 60) return m + ' min';
    const h = Math.floor(m / 60);
    if (h < 48) return h + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
    return Math.round(h / 24) + ' d';
  }
  const ago = (iso) => iso ? fmtDur(Date.now() - Date.parse(iso)) + ' ago' : '—';
  function leftText(expiresAt) {
    if (!expiresAt) return { text: 'no expiry known', soon: false };
    const ms = Date.parse(expiresAt) - Date.now();
    if (ms <= 0) return { text: 'expired', soon: true };
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return { text: (h ? h + ' h ' : '') + (h || m ? m + ' min' : sec + ' s') + ' left', soon: ms < 10 * 60000 };
  }
  const REASONS = {
    signup: 'Creating a new account', login: 'Logging in', fetch: 'While fetching a page', retest: 'Retesting a flagged account', verify: 'While fetching a page',
  };
  const reasonText = (r) => r ? (REASONS[r] || String(r).replace(/_/g, ' ')) : 'The site asked for a human check';
  const typeText = (t) => t === 'checkbox' ? 'checkbox (live view)' : 'image captcha';
`

/**
 * The captcha widget, used by the captcha page and by the Add-account dialog.
 * mountCaptcha(root, challenge, { onOutcome }) renders either the image +
 * answer box, or the live view for the checkbox wall.
 */
const CAPTCHA_JS = /* js */ `
  function mountCaptcha(root, ch, hooks) {
    hooks = hooks || {};
    const base = '/subscriptions/api/pool/challenges/' + encodeURIComponent(ch.id);
    if (ch.type === 'checkbox') {
      const livePath = base.slice(1) + '/live/websockify';
      const src = base + '/live/?autoconnect=1&resize=scale&reconnect=1&path=' + encodeURIComponent(livePath);
      root.innerHTML =
        '<p><b>Tap the checkbox</b> in the view below. It is the real browser on the NAS; once the check passes, this page notices on its own.</p>' +
        '<iframe class="cap-live" title="Live view of the pool browser" src="' + esc(src) + '" allow="clipboard-read; clipboard-write"></iframe>' +
        '<div class="cap-tools"><a class="ghost" href="' + esc(src) + '" target="_blank" rel="noopener">Open the live view full screen ↗</a></div>' +
        '<div class="cap-msg" data-r="msg"></div>';
      return { setMsg: (t, cls) => { const m = root.querySelector('[data-r=msg]'); m.textContent = t; m.className = 'cap-msg ' + (cls || ''); }, disable: () => {} };
    }
    root.innerHTML =
      '<img class="cap-img" data-r="img" alt="Captcha image from the pool browser" />' +
      '<div class="cap-tools"><button type="button" class="ghost" data-r="refresh">↻ New screenshot</button></div>' +
      '<form class="cap-form" data-r="form" autocomplete="off">' +
      '<input data-r="text" type="text" inputmode="text" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" enterkeyhint="send" aria-label="Captcha answer" placeholder="Type what you see" required maxlength="200" />' +
      '<button type="submit" data-r="submit">Submit answer</button>' +
      '</form>' +
      '<div class="cap-msg" data-r="msg"></div>';
    const img = root.querySelector('[data-r=img]'), form = root.querySelector('[data-r=form]'), input = root.querySelector('[data-r=text]');
    const submit = root.querySelector('[data-r=submit]'), refresh = root.querySelector('[data-r=refresh]'), msg = root.querySelector('[data-r=msg]');
    const setMsg = (t, cls) => { msg.textContent = t; msg.className = 'cap-msg ' + (cls || ''); };
    const load = (fresh) => { img.src = base + '/image?t=' + Date.now() + (fresh ? '&refresh=1' : ''); };
    img.addEventListener('error', () => setMsg('The captcha image could not be loaded. Try a new screenshot.', 'bad'));
    load(false);
    input.focus();
    refresh.addEventListener('click', () => { setMsg(''); load(true); input.focus(); });
    let done = false;
    const disable = () => { done = true; input.disabled = true; submit.disabled = true; refresh.disabled = true; };
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (done) return;
      const text = input.value.trim();
      if (!text) { input.focus(); return; }
      submit.disabled = true; submit.textContent = 'Sending…'; setMsg('');
      const r = await api('/challenges/' + encodeURIComponent(ch.id) + '/answer', jsonInit('POST', { text }));
      submit.disabled = false; submit.textContent = 'Submit answer';
      if (!r.ok) { setMsg(errText(r.data, r.status), 'bad'); return; }
      const o = r.data.outcome;
      if (o === 'solved') { disable(); setMsg('✓ Solved. The pool browser carries on.', 'ok'); }
      else if (o === 'wrong') { setMsg('✗ Wrong, try again with the new image.', 'bad'); input.value = ''; load(true); input.focus(); }
      else if (o === 'expired') { disable(); setMsg('This challenge has expired.', 'bad'); }
      else { setMsg('Sent. Checking whether it passed…', ''); }
      if (hooks.onOutcome) hooks.onOutcome(o);
    });
    return { setMsg, disable };
  }
`

const POOL_PAGE_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>tracked — pool accounts</title>
<style>${POOL_CSS}</style>
</head>
<body>
<main>
  <div class="row"><h1>Pool accounts</h1><span class="spacer"></span><button id="add-btn" type="button">+ Add account</button></div>
  <p class="lead">${NAV_HTML}</p>
  <div id="err" class="banner bad" hidden></div>
  <div id="stats" class="stats"></div>
  <div id="prio" class="card" hidden></div>
  <h2>Pending challenges</h2>
  <div id="chals"><div class="empty">loading…</div></div>
  <h2>Accounts</h2>
  <div id="accts"><div class="empty">loading…</div></div>
  <p class="muted" style="font-size:0.8rem">Accounts are shown by their opaque id only. Usernames, emails and passwords stay on the NAS.</p>
</main>

<dialog id="add-dlg" aria-labelledby="add-title">
  <div class="row"><h2 id="add-title" style="margin:0">Add account</h2><span class="spacer"></span><button id="add-close" type="button" class="ghost small">Close</button></div>
  <div id="add-form">
    <p class="muted" style="font-size:0.88rem">The pool picks a free exit IP, generates the username and password, fills the signup form and confirms the email on its own. You only solve the captcha.</p>
    <label class="switch"><input id="add-passive" type="checkbox" /><span><b>Passive</b> (control group, never used for fetching)<br><span class="muted" style="font-size:0.82rem">Pinned to its own exit and logged in, but never fetches. It shows whether flags come from use or from simply existing.</span></span></label>
    <div class="row" style="margin-top:0.9rem"><span class="spacer"></span><button id="add-create" type="button">Create</button></div>
  </div>
  <div id="add-progress" hidden>
    <ol id="add-steps" class="steps"></ol>
    <div id="add-captcha" class="card" hidden></div>
    <div id="add-msg"></div>
    <div class="row" style="margin-top:0.6rem"><span class="spacer"></span><button id="add-retry" type="button" hidden>Try again</button></div>
  </div>
</dialog>

<script>
(() => {
${COMMON_JS}
${CAPTCHA_JS}
  // ── overview ───────────────────────────────────────────────────────────
  const stateBadge = (a) => {
    const s = String(a.state || 'unknown');
    const cls = a.flagged || s === 'flagged' ? 'bad' : s === 'retired' ? '' : s === 'resting' || s === 'ramping' || s === 'creating' ? 'warn' : s === 'active' || s === 'ok' || s === 'healthy' ? 'ok' : 'info';
    return '<span class="badge ' + cls + '">' + esc(s) + '</span>';
  };
  const confirmWords = { rest: 'Rest it for 72 hours?', retest: 'Retest it with one known set?', retire: 'Retire it for good? Its exit stays unused for 30 days.' };
  let lastStatus = null;

  function renderStats(st, chals) {
    const accts = st.accounts || [];
    const live = accts.filter((a) => a.state !== 'retired');
    const fetching = live.filter((a) => !a.passive && !a.flagged && (a.state === 'active' || a.state === 'ok' || a.state === 'healthy' || a.state === 'ramping'));
    const budget = fetching.reduce((s, a) => s + (a.budget || 0), 0);
    const used = fetching.reduce((s, a) => s + (a.usedToday || 0), 0);
    const tile = (v, k) => '<div class="stat"><div class="v">' + esc(v) + '</div><div class="k">' + esc(k) + '</div></div>';
    $('stats').innerHTML =
      tile(st.requestsToday ?? '—', 'requests today') +
      tile(used + ' / ' + budget, 'used / budget (fetching accounts)') +
      tile(st.queueDepth ?? '—', 'queued fetches') +
      tile(fetching.length + ' / ' + live.length, 'fetching / live accounts') +
      tile(chals.length, 'pending challenges');
    const chips = (m) => Object.keys(m).map((k) => '<span class="chip">' + esc(k) + ' <b>' + esc(m[k]) + '</b></span>').join('');
    const bp = st.requestsByPriority || {}, qp = st.queueByPriority || {};
    const parts = [];
    if (Object.keys(bp).length) parts.push('<div class="muted" style="font-size:0.8rem;margin-bottom:0.3rem">Requests today by priority</div><div class="chips">' + chips(bp) + '</div>');
    if (Object.keys(qp).length) parts.push('<div class="muted" style="font-size:0.8rem;margin:0.5rem 0 0.3rem">Queue by priority</div><div class="chips">' + chips(qp) + '</div>');
    $('prio').hidden = !parts.length;
    $('prio').innerHTML = parts.join('');
  }

  function renderChallenges(chals, errCode) {
    if (errCode) { $('chals').innerHTML = '<div class="empty error">' + esc(errText({ error: errCode })) + '</div>'; return; }
    const open = chals.filter((c) => c.state === 'pending');
    if (!open.length) { $('chals').innerHTML = '<div class="empty">None. Nothing is waiting for you.</div>'; return; }
    $('chals').innerHTML = '<ul class="plain">' + open.map((c) => {
      const l = leftText(c.expiresAt);
      return '<li><div class="row"><a href="/subscriptions/captcha/' + encodeURIComponent(c.id) + '"><b>Solve ' + esc(typeText(c.type)) + '</b></a><span class="spacer"></span><span class="left' + (l.soon ? ' soon' : '') + '">' + esc(l.text) + '</span></div>' +
        '<div class="muted" style="font-size:0.82rem">' + esc(c.accountId || 'no account yet') + ' · ' + esc(reasonText(c.reason)) + ' · since ' + esc(fmtTime(c.createdAt)) + '</div></li>';
    }).join('') + '</ul>';
  }

  function renderAccounts(accts) {
    if (!accts.length) { $('accts').innerHTML = '<div class="empty">No accounts yet. Press + Add account.</div>'; return; }
    const rows = accts.map((a) => {
      const flag = a.flagged ? '<span class="badge bad">flagged</span>' + (a.flagReason ? ' <span class="muted">' + esc(a.flagReason.replace(/_/g, ' ')) + '</span>' : '') : '<span class="muted">no</span>';
      const acts = a.state === 'retired' ? '<span class="muted">retired</span>' :
        ['rest', 'retest', 'retire'].map((act) => '<button type="button" class="ghost small" data-act="' + act + '" data-id="' + esc(a.id) + '">' + act[0].toUpperCase() + act.slice(1) + '</button>').join('');
      return '<tr>' +
        '<td data-l="Account"><b class="mono">' + esc(a.id) + '</b> ' + (a.passive ? '<span class="badge info">passive</span>' : '') + '</td>' +
        '<td data-l="State">' + stateBadge(a) + (a.restUntil ? ' <span class="muted">until ' + esc(fmtTime(a.restUntil)) + '</span>' : '') + '</td>' +
        '<td data-l="Exit"><span class="mono">' + esc(a.exitLabel || '—') + '</span>' + (a.exitKind ? ' <span class="muted">' + esc(a.exitKind) + '</span>' : '') + '</td>' +
        '<td data-l="Today" class="num">' + esc(a.usedToday ?? '—') + ' / ' + esc(a.budget ?? '—') + '</td>' +
        '<td data-l="Ramp day" class="num">' + esc(a.rampDay ?? '—') + '</td>' +
        '<td data-l="Last success">' + esc(ago(a.lastOkAt)) + '</td>' +
        '<td data-l="Last challenge">' + esc(ago(a.lastChallengeAt)) + '</td>' +
        '<td data-l="Flagged">' + flag + '</td>' +
        '<td class="acts-cell"><div class="acts" data-acts="' + esc(a.id) + '">' + acts + '</div></td>' +
        '</tr>';
    }).join('');
    $('accts').innerHTML = '<table class="accts"><thead><tr><th>Account</th><th>State</th><th>Exit</th><th>Today</th><th>Ramp</th><th>Last ok</th><th>Last challenge</th><th>Flagged</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  // In-page confirmation (no confirm()): the buttons of that row turn into a question.
  $('accts').addEventListener('click', async (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    const box = b.closest('[data-acts]');
    const id = box && box.dataset.acts;
    if (b.dataset.act) {
      const act = b.dataset.act;
      box.innerHTML = '<div class="confirm"><span>' + esc(id) + ': ' + esc(confirmWords[act]) + '</span>' +
        '<button type="button" class="small ' + (act === 'retire' ? 'danger' : '') + '" data-yes="' + act + '">Yes, ' + act + '</button>' +
        '<button type="button" class="ghost small" data-no="1">Cancel</button></div>';
      return;
    }
    if (b.dataset.no) { load(); return; }
    if (b.dataset.yes) {
      const act = b.dataset.yes;
      b.disabled = true; b.textContent = 'Working…';
      const r = await api('/accounts/' + encodeURIComponent(id) + '/' + act, { method: 'POST' });
      if (!r.ok) { box.innerHTML = '<span class="error">' + esc(errText(r.data, r.status)) + '</span> <button type="button" class="ghost small" data-no="1">OK</button>'; return; }
      load();
    }
  });

  async function load() {
    const r = await api('/status');
    if (!r.ok) {
      $('err').hidden = false; $('err').textContent = errText(r.data, r.status);
      if (!lastStatus) { $('accts').innerHTML = ''; $('chals').innerHTML = ''; }
      return;
    }
    $('err').hidden = true;
    lastStatus = r.data.status;
    renderStats(r.data.status, r.data.challenges || []);
    renderChallenges(r.data.challenges || [], r.data.challengesError);
    // Don't clobber a row that is mid-confirmation.
    if (!document.querySelector('#accts .confirm')) renderAccounts(r.data.status.accounts || []);
  }
  load();
  setInterval(() => { if (!document.hidden) load(); }, 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

  // ── Add account ────────────────────────────────────────────────────────
  const STEPS = [
    ['exit_assigned', 'Exit assigned'],
    ['form_opened', 'Signup form opened'],
    ['awaiting_captcha', 'Waiting for your captcha'],
    ['submitted', 'Submitted'],
    ['awaiting_email', 'Waiting for the confirmation email'],
    ['confirmed', 'Email confirmed'],
    ['logged_in', 'Logged in'],
    ['done', 'Done'],
  ];
  const STEP_ALIASES = { exit: 'exit_assigned', form: 'form_opened', captcha: 'awaiting_captcha', waiting_captcha: 'awaiting_captcha', captcha_pending: 'awaiting_captcha', waiting_email: 'awaiting_email', email: 'awaiting_email', email_confirmed: 'confirmed', login: 'logged_in', created: 'done', complete: 'done', completed: 'done' };
  const NO_PROGRESS_MS = 15 * 60000;
  const dlg = $('add-dlg');
  let flow = null; // { challengeId, accountId, stepIdx, lastChange, timer, captchaShown, widget }

  function stepIndex(step) { const s = STEP_ALIASES[step] || step; return STEPS.findIndex((x) => x[0] === s); }
  function renderSteps(idx, failed) {
    $('add-steps').innerHTML = STEPS.map((s, i) => {
      const cls = failed && i === idx ? 'fail' : i < idx || (i === idx && s[0] === 'done') ? 'done' : i === idx ? 'cur' : '';
      const dot = cls === 'done' ? '✓' : cls === 'cur' ? '●' : cls === 'fail' ? '✗' : '○';
      return '<li class="' + cls + '"><span class="dot">' + dot + '</span>' + esc(s[1]) + '</li>';
    }).join('');
  }
  function stopFlow() { if (flow) { if (flow.timer) clearInterval(flow.timer); flow.active = false; } }
  function failFlow(text) {
    stopFlow();
    renderSteps(flow ? Math.max(flow.stepIdx, 0) : 0, true);
    $('add-captcha').hidden = true;
    $('add-msg').innerHTML = '<div class="banner bad">' + esc(text) + '</div>';
    $('add-retry').hidden = false;
  }
  function resetDialog() {
    stopFlow(); flow = null;
    $('add-form').hidden = false; $('add-progress').hidden = true; $('add-retry').hidden = true;
    $('add-captcha').hidden = true; $('add-captcha').innerHTML = ''; $('add-msg').innerHTML = '';
    $('add-create').disabled = false;
  }

  async function poll() {
    if (!flow) return;
    const r = await api('/challenges/' + encodeURIComponent(flow.challengeId));
    let ch = r.ok ? r.data.challenge : null;
    if (!r.ok && r.status === 404 && flow.stepIdx >= stepIndex('submitted') && flow.accountId) {
      // The solved challenge may be gone already; follow the account instead.
      const a = await api('/accounts');
      const acct = a.ok ? (a.data.accounts || []).find((x) => x.id === flow.accountId) : null;
      if (acct && !/^(creating|signup|pending|new)$/.test(acct.state)) { ch = { state: 'solved', step: 'done' }; }
      else return;
    } else if (!r.ok) {
      if (r.status === 404) { failFlow('The pool lost track of this signup. Check the accounts table, then try again.'); return; }
      $('add-msg').innerHTML = '<div class="muted">' + esc(errText(r.data, r.status)) + ' Still trying…</div>';
      return;
    }
    let idx = ch.step ? stepIndex(ch.step) : -1;
    if (idx < 0) idx = ch.state === 'pending' ? stepIndex('awaiting_captcha') : flow.stepIdx;
    if (idx !== flow.stepIdx) { flow.stepIdx = idx; flow.lastChange = Date.now(); }
    if (ch.error || ch.state === 'failed') { failFlow('The signup failed: ' + errText({ error: ch.error || 'pool_error' })); return; }
    if (ch.state === 'expired') { failFlow(errText({ error: 'captcha_expired' })); return; }
    renderSteps(idx, false);
    const needCaptcha = ch.state === 'pending' && idx === stepIndex('awaiting_captcha');
    if (needCaptcha && !flow.captchaShown && ch.type) {
      flow.captchaShown = true;
      $('add-captcha').hidden = false;
      flow.widget = mountCaptcha($('add-captcha'), ch, {});
    }
    if (!needCaptcha && flow.captchaShown) { $('add-captcha').hidden = true; }
    if (STEPS[idx] && STEPS[idx][0] === 'done') {
      stopFlow();
      $('add-msg').innerHTML = '<div class="banner ok">Account ' + esc(flow.accountId || '') + ' is ready.</div>';
      load();
      return;
    }
    $('add-msg').innerHTML = '';
    if (Date.now() - flow.lastChange > NO_PROGRESS_MS) failFlow('No progress for 15 minutes. The flow may be stuck on the NAS.');
  }

  async function create() {
    $('add-create').disabled = true;
    $('add-form').hidden = true; $('add-progress').hidden = false; $('add-retry').hidden = true;
    $('add-msg').innerHTML = '<div class="muted">Starting…</div>';
    renderSteps(-1, false);
    const r = await api('/accounts', jsonInit('POST', { passive: $('add-passive').checked }));
    if (!r.ok) { flow = { stepIdx: 0 }; failFlow(errText(r.data, r.status)); return; }
    flow = { challengeId: r.data.challengeId, accountId: r.data.accountId, stepIdx: -1, lastChange: Date.now(), timer: null, captchaShown: false, active: true };
    poll();
    flow.timer = setInterval(poll, 2500);
  }

  // Closing the dialog mid-signup keeps it running; reopening shows it again.
  $('add-btn').addEventListener('click', () => { if (!flow || !flow.active) resetDialog(); dlg.showModal(); });
  $('add-close').addEventListener('click', () => dlg.close());
  $('add-create').addEventListener('click', create);
  $('add-retry').addEventListener('click', () => { resetDialog(); });
  dlg.addEventListener('close', () => load());
})();
</script>
</body>
</html>`

const CAPTCHA_LIST_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>tracked — captchas</title>
<style>${POOL_CSS}</style>
</head>
<body>
<main class="narrow">
  <h1>Captchas</h1>
  <p class="lead">${NAV_HTML}</p>
  <div id="list"><div class="empty">loading…</div></div>
</main>
<script>
(() => {
${COMMON_JS}
  async function load() {
    const r = await api('/challenges');
    if (!r.ok) { $('list').innerHTML = '<div class="banner bad">' + esc(errText(r.data, r.status)) + '</div>'; return; }
    const open = (r.data.challenges || []).filter((c) => c.state === 'pending');
    if (!open.length) { $('list').innerHTML = '<div class="empty">No pending challenges. Nothing is waiting for you.</div>'; return; }
    $('list').innerHTML = '<ul class="plain">' + open.map((c) => {
      const l = leftText(c.expiresAt);
      return '<li><a href="/subscriptions/captcha/' + encodeURIComponent(c.id) + '" style="display:block;text-decoration:none;color:inherit">' +
        '<div class="row"><b>' + esc(reasonText(c.reason)) + '</b><span class="spacer"></span><span class="left' + (l.soon ? ' soon' : '') + '">' + esc(l.text) + '</span></div>' +
        '<div class="muted" style="font-size:0.85rem">' + esc(c.accountId || 'no account yet') + ' · ' + esc(typeText(c.type)) + ' · since ' + esc(fmtTime(c.createdAt)) + '</div>' +
        '<div style="margin-top:0.4rem;color:var(--accent);font-weight:600">Solve →</div></a></li>';
    }).join('') + '</ul>';
  }
  load();
  setInterval(() => { if (!document.hidden) load(); }, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
})();
</script>
</body>
</html>`

/** The page a push notification opens. `id` is validated against ID_RE before it gets here. */
function captchaPageHtml(id: string): string {
  return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>tracked — captcha</title>
<style>${POOL_CSS}</style>
</head>
<body>
<main class="narrow">
  <h1>Captcha</h1>
  <p class="lead">${NAV_HTML}</p>
  <div id="head" class="card"><span class="muted">loading…</span></div>
  <div id="state"></div>
  <div id="widget"></div>
</main>
<script>
(() => {
${COMMON_JS}
${CAPTCHA_JS}
  const ID = ${JSON.stringify(id)};
  let ch = null, widget = null, finished = false, timer = null;

  function renderHead() {
    const l = leftText(ch.expiresAt);
    $('head').innerHTML =
      '<div class="row"><b class="mono">' + esc(ch.accountId || 'new account') + '</b><span class="badge info">' + esc(typeText(ch.type)) + '</span><span class="spacer"></span><span id="left" class="left' + (l.soon ? ' soon' : '') + '">' + esc(l.text) + '</span></div>' +
      '<div class="muted" style="font-size:0.88rem;margin-top:0.25rem">' + esc(reasonText(ch.reason)) + ' · since ' + esc(fmtTime(ch.createdAt)) + '</div>';
  }
  function tick() {
    const el = $('left');
    if (!el || !ch) return;
    const l = leftText(ch.expiresAt);
    el.textContent = l.text; el.className = 'left' + (l.soon ? ' soon' : '');
  }
  function finish(kind, text) {
    finished = true;
    if (timer) clearInterval(timer);
    if (widget) widget.disable();
    if (kind !== 'ok') $('widget').innerHTML = '';
    $('state').innerHTML = '<div class="banner ' + kind + '">' + esc(text) + '</div><p><a href="/subscriptions/captcha">Other pending captchas</a> · <a href="/subscriptions/pool">Pool</a></p>';
  }
  function applyState() {
    if (ch.state === 'solved') finish('ok', '✓ Solved. The pool browser carries on.');
    else if (ch.state === 'expired') finish('bad', 'This challenge expired. The account rests for 6 hours; a new challenge will come if it is needed.');
    else if (ch.state === 'failed') finish('bad', 'This challenge was closed by the pool' + (ch.error ? ' (' + ch.error.replace(/_/g, ' ') + ')' : '') + '.');
  }
  async function refresh(first) {
    if (finished) return;
    const r = await api('/challenges/' + encodeURIComponent(ID));
    if (!r.ok) {
      if (r.status === 404) { if (first) $('head').innerHTML = ''; finish('bad', 'This challenge is gone: it was solved, or closed after 2 hours.'); }
      else if (first) { $('head').innerHTML = '<span class="error">' + esc(errText(r.data, r.status)) + '</span> <button type="button" class="ghost small" id="again">Try again</button>'; $('again').onclick = () => refresh(true); }
      return;
    }
    ch = r.data.challenge;
    renderHead();
    if (ch.state !== 'pending') { applyState(); return; }
    if (!widget) widget = mountCaptcha($('widget'), ch, { onOutcome: (o) => { if (o === 'solved') { ch.state = 'solved'; applyState(); } else if (o === 'expired') { ch.state = 'expired'; applyState(); } else if (o === 'accepted') setTimeout(() => refresh(false), 1500); } });
  }
  refresh(true);
  setInterval(tick, 1000);
  timer = setInterval(() => { if (!document.hidden) refresh(false); }, 4000);
})();
</script>
</body>
</html>`
}

const SETTINGS_PAGE_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>tracked — pool settings</title>
<style>${POOL_CSS}</style>
</head>
<body>
<main class="narrow">
  <h1>Pool settings</h1>
  <p class="lead">${NAV_HTML}</p>

  <h2>Budget and browser</h2>
  <form id="lim" class="card" autocomplete="off">
    <div id="lim-err" class="error"></div>
    <div class="field"><label for="budget">Pages per account per day</label><input id="budget" type="number" min="0" max="1000" step="1" /><span class="hint">Default 30. Spread around the clock with random gaps.</span></div>
    <div class="field"><label>Ramp for new accounts</label><div class="row"><span>Day 1</span><input id="ramp1" type="number" min="0" max="1000" step="1" /><span>Day 2</span><input id="ramp2" type="number" min="0" max="1000" step="1" /><span class="muted">then the full budget</span></div><span class="hint">Default 10, then 20.</span></div>
    <div class="field"><label for="share">Reserved for the phone button</label><div class="row"><input id="share" type="number" min="0" max="90" step="1" /><span>% of each day's budget</span></div></div>
    <div class="field"><label for="images">First-party images</label><select id="images"><option value="block">Block</option><option value="allow">Allow</option></select><span class="hint">Video, ads and ad scripts are always blocked.</span></div>
    <div class="field"><label>Quiet hours</label><span>No pushes 23:00 to 08:00, America/Chicago.</span><span class="hint">Fixed for now; not stored in either settings store.</span></div>
    <div class="row"><span id="lim-msg" class="muted"></span><span class="spacer"></span><button id="lim-save" type="submit">Save</button></div>
  </form>

  <h2>Recheck schedule</h2>
  <form id="sch" class="card" autocomplete="off">
    <div id="sch-err" class="error"></div>
    <p class="muted" style="font-size:0.85rem;margin-top:0">How often a set is fetched again, by its age. Leave "every" empty for never.</p>
    <table class="sched"><thead><tr><th>Sets up to (days old)</th><th>Every (hours)</th><th></th></tr></thead><tbody id="sch-rows"></tbody></table>
    <div class="row" style="margin:0.5rem 0 0.9rem"><button id="sch-add" type="button" class="ghost small">+ Add row</button></div>
    <div class="field"><label for="over180">Older sets without a good video or with ID rows: every (hours)</label><input id="over180" type="number" min="1" step="1" /><span class="hint">Default 2160 (90 days).</span></div>
    <h2 style="margin-top:0.5rem">Priority order</h2>
    <p class="muted" style="font-size:0.85rem;margin-top:0">When the budget runs short, earlier ones go first.</p>
    <div id="prios"></div>
    <div class="row" style="margin-top:0.9rem"><span id="sch-msg" class="muted"></span><span class="spacer"></span><button id="sch-save" type="submit">Save</button></div>
  </form>
</main>
<script>
(() => {
${COMMON_JS}
  // ── tlpool's own settings, via /api/pool/limits ───────────────────────
  let lim = null;
  async function loadLimits() {
    const r = await api('/limits');
    if (!r.ok) { $('lim-err').textContent = errText(r.data, r.status); $('lim-save').disabled = true; return; }
    lim = r.data.settings;
    $('budget').value = lim.budgetPerDay ?? '';
    $('ramp1').value = lim.ramp && lim.ramp[0] != null ? lim.ramp[0] : '';
    $('ramp2').value = lim.ramp && lim.ramp[1] != null ? lim.ramp[1] : '';
    $('share').value = lim.reservedPhoneShare != null ? Math.round(lim.reservedPhoneShare * 100) : '';
    if (lim.imagePolicy) {
      if (![...$('images').options].some((o) => o.value === lim.imagePolicy)) $('images').add(new Option(lim.imagePolicy, lim.imagePolicy));
      $('images').value = lim.imagePolicy;
    }
    $('lim-save').disabled = false; $('lim-err').textContent = '';
  }
  $('lim').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const n = (id) => $(id).value === '' ? null : Number($(id).value);
    const body = {};
    if (n('budget') != null) body.budgetPerDay = n('budget');
    if (n('ramp1') != null && n('ramp2') != null) body.ramp = [n('ramp1'), n('ramp2')];
    if (n('share') != null) body.reservedPhoneShare = n('share') / 100;
    if ($('images').value) body.imagePolicy = $('images').value;
    $('lim-save').disabled = true; $('lim-msg').textContent = 'saving…';
    const r = await api('/limits', jsonInit('PUT', body));
    $('lim-save').disabled = false;
    if (!r.ok) { $('lim-msg').textContent = ''; $('lim-err').textContent = errText(r.data, r.status); return; }
    $('lim-err').textContent = ''; $('lim-msg').textContent = 'Saved.';
    loadLimits();
  });

  // ── recheck schedule + priorities, via /api/pool/settings (scheduler) ──
  const PRIO_WORDS = { phone: 'Phone button', new: 'New sets', verify: 'Verification second fetches', recheck: 'Routine rechecks', backfill: 'DJ backfill' };
  let sched = null;
  function rowHtml(r) {
    return '<tr><td><input type="number" min="1" step="1" data-k="maxAgeDays" value="' + esc(r.maxAgeDays ?? '') + '" /></td>' +
      '<td><input type="number" min="1" step="1" data-k="everyHours" placeholder="never" value="' + esc(r.everyHours ?? '') + '" /></td>' +
      '<td><button type="button" class="ghost small" data-del="1" aria-label="Remove row">✕</button></td></tr>';
  }
  function renderSched() {
    $('sch-rows').innerHTML = (sched.recheck || []).map(rowHtml).join('');
    $('over180').value = sched.over180Exception && sched.over180Exception.everyHours != null ? sched.over180Exception.everyHours : '';
    renderPrios();
  }
  function renderPrios() {
    const p = sched.priorities || [];
    $('prios').innerHTML = p.map((name, i) => '<div class="prio"><span class="n">' + (i + 1) + '.</span><span class="name">' + esc(PRIO_WORDS[name] || name) + '</span>' +
      '<button type="button" class="ghost small" data-up="' + i + '" ' + (i === 0 ? 'disabled' : '') + ' aria-label="Move up">↑</button>' +
      '<button type="button" class="ghost small" data-down="' + i + '" ' + (i === p.length - 1 ? 'disabled' : '') + ' aria-label="Move down">↓</button></div>').join('');
  }
  function readRows() {
    return [...$('sch-rows').querySelectorAll('tr')].map((tr) => {
      const v = (k) => tr.querySelector('[data-k=' + k + ']').value;
      return { maxAgeDays: v('maxAgeDays') === '' ? null : Number(v('maxAgeDays')), everyHours: v('everyHours') === '' ? null : Number(v('everyHours')) };
    });
  }
  async function loadSched() {
    const r = await fetch('/subscriptions/api/pool/settings', { credentials: 'same-origin' }).catch(() => null);
    if (!r) { $('sch-err').textContent = errText({ error: 'network' }); $('sch-save').disabled = true; return; }
    if (r.status === 404) { $('sch-err').textContent = 'Not available yet: the scheduler update that stores these settings has not shipped.'; $('sch-save').disabled = true; $('sch-add').disabled = true; return; }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { $('sch-err').textContent = errText(d, r.status); $('sch-save').disabled = true; return; }
    sched = d.settings && typeof d.settings === 'object' && d.settings.recheck ? d.settings : d;
    if (!Array.isArray(sched.recheck)) sched.recheck = [];
    if (!Array.isArray(sched.priorities)) sched.priorities = [];
    $('sch-err').textContent = ''; $('sch-save').disabled = false;
    renderSched();
  }
  $('sch-add').addEventListener('click', () => { if (!sched) return; sched.recheck = readRows(); sched.recheck.push({ maxAgeDays: null, everyHours: null }); renderSched(); });
  $('sch').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b || !sched) return;
    if (b.dataset.del) { b.closest('tr').remove(); return; }
    const p = sched.priorities;
    if (b.dataset.up) { const i = Number(b.dataset.up); [p[i - 1], p[i]] = [p[i], p[i - 1]]; renderPrios(); }
    if (b.dataset.down) { const i = Number(b.dataset.down); [p[i + 1], p[i]] = [p[i], p[i + 1]]; renderPrios(); }
  });
  $('sch').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!sched) return;
    const rows = readRows();
    if (rows.some((r) => !(r.maxAgeDays > 0))) { $('sch-err').textContent = 'Every row needs an age in days.'; return; }
    rows.sort((a, b) => a.maxAgeDays - b.maxAgeDays);
    // Send the whole object back, unknown fields included.
    const body = { ...sched, recheck: rows, over180Exception: { ...(sched.over180Exception || {}), everyHours: $('over180').value === '' ? null : Number($('over180').value) }, priorities: sched.priorities };
    $('sch-save').disabled = true; $('sch-msg').textContent = 'saving…';
    const r = await fetch('/subscriptions/api/pool/settings', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
    $('sch-save').disabled = false;
    const d = r ? await r.json().catch(() => ({})) : { error: 'network' };
    if (!r || !r.ok) { $('sch-msg').textContent = ''; $('sch-err').textContent = errText(d, r ? r.status : 0); return; }
    $('sch-err').textContent = ''; $('sch-msg').textContent = 'Saved.';
    loadSched();
  });

  loadLimits();
  loadSched();
})();
</script>
</body>
</html>`

/** Exported for the HTML smoke tests. */
export const POOL_PAGES = { POOL_PAGE_HTML, CAPTCHA_LIST_HTML, SETTINGS_PAGE_HTML, captchaPageHtml }
