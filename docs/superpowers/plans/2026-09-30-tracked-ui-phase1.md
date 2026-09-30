# tracked UI redesign, phase 1: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the admin UI from `/subscriptions/**` to `/ui/**` and rebuild every existing page on a shared app shell (sidebar on desktop, bottom tabs on a phone), on the existing APIs.

**Architecture:** Server-rendered HTML strings, no bundler. `src/ui/` holds the CSS tokens, component CSS, icons, the shell (`shell(opts)` returns a full document) and one shared inline client runtime (`TK`). Each page lives in `src/ui/pages/<name>.ts` and exports a `UiPage`. The routers (`subscriptions.ts`, `pool-ui.ts`, `playlist-hygiene.ts`) serve those pages; every API handler stays untouched apart from its mount prefix. A small legacy app answers the old prefix with 301s (pages) and 410s (API, OAuth, sw.js).

**Tech Stack:** Cloudflare Workers, Hono, TypeScript, vitest with `node:vm` stub DOMs, sql.js fake D1.

**Spec:** `docs/superpowers/specs/2026-09-30-tracked-ui-redesign-design.md` and its companion `docs/superpowers/specs/2026-09-30-tracked-ui-behaviour-contract.md`. Read both before any task. The old code at commit `02b883f` is the source of truth for behaviour not written down: `git show 02b883f:src/routes/subscriptions.ts`.

## Global Constraints

- API request and response shapes never change. Only the prefix moves: `/subscriptions/api/*` becomes `/ui/api/*`, `/subscriptions/oauth/*` becomes `/ui/oauth/*`.
- `cfAccess` runs on every `/ui/**` route. Bearer gates elsewhere. The wildcard bearer gate in `src/index.ts` exempts `/`, `/ui`, `/subscriptions`, `/mkvid`, `/pool`.
- Every non-GET fetch in page JS is one object literal with `method` first, then `headers: { 'content-type': 'application/json' }`, then `credentials: 'same-origin'`. `test/same-origin.test.ts` finds the `{` before `method:` and the second `}` after it, and requires the content-type inside. No `<form method=post>`.
- Script tags are bare `<script>` with no attributes. Every inline script must parse with `new vm.Script`.
- Shared scripts (theme boot, runtime, shell JS, `BAN_JS`) must run without throwing in the pool tests' stub DOM: no `window`, `navigator`, `localStorage`, `location`, `history`, `matchMedia`, `document.body`, `document.documentElement` or `document.querySelectorAll`, and stub elements have no `classList`. Guard every such access with `typeof x !== 'undefined'` or a null check.
- Shared scripts define exactly one global, `TK` (declared with `var`). The shell script and every page script are IIFEs. Pool pages keep their own top-level `COMMON_JS` names (`$`, `esc`, `api`, `jsonInit`, `poller`, `errText`), so nothing shared may declare those names at top level.
- Shared scripts add no timers of 20000 ms or more and no tlpool requests on the pool pages; `test/pool-ui.test.ts` counts both.
- Web Push: service worker at `/ui/sw.js`, scope `/ui/`. Push payload URLs: `/ui/captcha/<id>`, `/ui/pool`, `/ui/removed`, `/ui/`.
- `POOL_PAGES` (`{ POOL_PAGE_HTML, CAPTCHA_LIST_HTML, SETTINGS_PAGE_HTML, captchaPageHtml }`) and `createPoolUiApp` stay exported from `src/routes/pool-ui.ts` with the same shape. `BAN_JS` stays exported from `src/routes/ban-ui.ts`.
- Pool page `<h1>` prefixes: `Pool accounts`, `Pool settings`, `Captchas`, `Captcha`. Every page links to `/ui/pool/settings`.
- The pool settings schedule form keeps input `#feed` ("Render feeder: first fetches a day", 0 to 500, loaded from and saved as `renderFeedPerDay`).
- Dismiss never lifts `ban:pause`. Pool ids are `acct-N` only. No secrets, emails, usernames or local paths in code, fixtures, docs or commits (public repo).
- No CSP is added. Pages send `Cache-Control: no-store`; `sw.js` sends `no-cache`.
- `npx vitest run` and `npx tsc --noEmit` are clean at every commit.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (the owner's wording, kept verbatim) and `Claude-Session: https://claude.ai/code/session_017MqcMbWUuvz3X4Q8RGd5XY`. Use repeated `-m` flags.
- `test/pool-ui.test.ts` runs regexes over whole pages, shell included: the word "quiet" appears nowhere in shared CSS, JS, markup or comments, and no shell `<input>`/`<select>` carries an attribute containing `user`, `mail` or `passw`, and no `type=password`/`type=email`/`autocomplete=username`.
- Hono routing is strict: a mounted `get('/')` answers `/ui` but `/ui/` is a 404. `/ui/` is registered explicitly in `src/index.ts` (Task 1).
- Visual tokens, type scale, spacing and radii are spec section 7, copied exactly.

## Review Focus

1. **A phone that registered push under `/subscriptions/`** loads `/ui/` for the first time: it must end with exactly one subscription (the new one), with no permission prompt when permission was already granted. Owner: Task 1 (test on the unregister-and-resubscribe path with a fake `navigator.serviceWorker`).
2. **A bookmark or old push that opens `/subscriptions/tracklist?url=…` or `/subscriptions/captcha/ch-1`** must land on the working new page with the query intact. `/ui/tracklist` no longer exists, so the legacy map sends it to `/ui/set`. Owner: Task 1.
3. **Every page's shared scripts in the minimal pool stub** (no body, no window): one throw would kill the pool page on the owner's phone-critical path. Owner: Task 5 (`test/ui-pages.test.ts` runs every page in that stub).
4. **Theme storage blocked** (private window, blocked site data): the boot script and the toggle must not throw and must fall back to the system theme. Owner: Task 4 (runtime test with a throwing `localStorage`).
5. **A 360px-wide phone**: no horizontal page scroll, the bottom tab bar never covers a dialog's buttons or the captcha answer box, safe-area insets respected. Owner: Task 2 CSS, verified in Task 14 with screenshots at 360 and 1440 px.

---

## File map

| File | Status | Responsibility |
| --- | --- | --- |
| `src/routes/legacy.ts` | new | `legacyApp`: 301 page redirects and 410 API/OAuth/sw.js answers for `/subscriptions/**` |
| `src/index.ts` | modify | mounts at `/ui`, legacy mount, `GET /` 302, bearer gate exemptions |
| `src/middleware/same-origin.ts` | modify | `LIVE_VIEW_PATH` under `/ui` |
| `src/routes/subscriptions.ts` | modify | cookie path, OAuth redirects, page routes from `src/ui/pages`; old page constants deleted by the end |
| `src/routes/pool-ui.ts` | modify | page constants replaced by imports from `src/ui/pages` |
| `src/routes/ban-ui.ts` | modify | sw path and scope, old-registration cleanup, stub-tolerant guards, `home`/`settings` page kinds |
| `src/routes/playlist-hygiene.ts` | modify | `REMOVED_PAGE_HTML` replaced by an import |
| `src/lib/google-oauth.ts`, `pool-events.ts`, `playlist-hygiene.ts`, `web-push.ts` | modify | `/ui` URLs |
| `src/ui/tokens.ts` | new | `TOKENS_CSS` |
| `src/ui/base.ts` | new | `BASE_CSS`: reset, shell, components, banner restyle |
| `src/ui/icons.ts` | new | `icon(name, opts)`, `IconName` |
| `src/ui/runtime.ts` | new | `THEME_BOOT_JS`, `RUNTIME_JS` (defines `TK`) |
| `src/ui/shell.ts` | new | `NAV`, `shell(opts)`, `SHELL_JS` |
| `src/ui/pages/*.ts` | new | one page each: `home djs dj set playlists removed mkvid pool captcha-list captcha pool-settings settings tools` |
| `src/ui/pages/index.ts` | new | `UiPage` type and `servePage` |
| `test/legacy-redirects.test.ts` | new | Task 1 |
| `test/ui-runtime.test.ts` | new | Task 4 |
| `test/ui-pages.test.ts` | new | Task 5, extended by every page task |
| every test that requests `/subscriptions…` | modify | paths move to `/ui` (Task 1) |

Interfaces used across tasks:

```ts
// src/ui/shell.ts
export type NavKey = 'home' | 'djs' | 'search' | 'playlists' | 'removed' | 'mkvid' | 'activity'
  | 'pool' | 'captcha' | 'pool-settings' | 'settings' | 'tools'
export interface ShellOptions {
  nav: NavKey | null        // active nav item; DJ profile uses 'djs', Set uses null
  title: string             // plain text: <title>, top-bar title and <h1>
  h1Id?: string             // DJ profile needs <h1 id="dj-name">
  description?: string      // raw HTML, one line under the h1
  actions?: string          // raw HTML for the header actions slot
  body: string              // raw HTML page content
  css?: string              // page CSS
  js?: string               // page script, emitted as its own bare <script>, after the shared ones
  banPage?: 'home' | 'settings' | 'other'   // <body data-ban-page>, default 'other'
  width?: 'wide' | 'narrow' // narrow = 560px centered column (captcha page)
  ownNavCount?: boolean     // page reports the Challenges count itself via TK.navCount(n)
}
export function shell(o: ShellOptions): string

// src/ui/pages/index.ts
export interface UiPage { path: string; html: string }  // path relative to /ui, e.g. '/djs'
export function servePage(c: Context, html: string): Response  // Cache-Control: no-store + c.html
// captcha page: export function captchaPageHtml(id: string): string   (src/ui/pages/captcha.ts)
// dj page:      export const DJ_PAGE: UiPage = { path: '/dj/:slug', html }
```

Runtime (`TK`, one global, all members null-tolerant):

```
TK.$(id)                              document.getElementById
TK.esc(s)                             & < > " ' escaped, null -> ''
TK.safeHref(u)                        u when it starts with http:// or https://, else null
TK.api.get(path) / .post(path, body) / .put(path, body) / .del(path, body)
                                      -> Promise<{ ok, status, data, raw }>; network error -> { ok:false, status:0, data:{error:'network'}, raw:'' }
TK.errText(res, fallback)             data.message || KNOWN_CODES[data.error] || data.error || fallback
TK.toast(msg, kind = 'ok' | 'bad', detail?)
TK.ask(text, { yes = 'Yes', no = 'Cancel', danger = false }) -> Promise<boolean>   native <dialog id="tk-confirm">
TK.drawer.open(title, html) -> body element; TK.drawer.close()                   native <dialog id="tk-drawer">
TK.busy(btn, label, fn) -> Promise    disables btn, sets label, restores both after fn settles
TK.fmt.{ time, dur, ago, rel, clock, until, date, setLabel }                       verbatim from the old pages
TK.poll(fn, everyMs, { onAuth, onTimeout }) -> { stop, isStopped, now }           same semantics as the pool poller
TK.qs.get(name) / TK.qs.set(obj)      query string read and history.replaceState write
TK.navCount(n)                        sets the Challenges nav badge
TK.theme.get() / TK.theme.set('system' | 'dark' | 'light')
```

---

### Task 1: Prefix move with legacy redirects (old pages, new paths)

Moves every route from `/subscriptions` to `/ui` with the old page HTML unchanged apart from paths, so the redesign lands on a green base.

**Files:**
- Create: `src/routes/legacy.ts`, `test/legacy-redirects.test.ts`
- Modify: `src/index.ts`, `src/middleware/same-origin.ts`, `src/routes/subscriptions.ts`, `src/routes/pool-ui.ts`, `src/routes/ban-ui.ts`, `src/routes/playlist-hygiene.ts`, `src/lib/google-oauth.ts`, `src/lib/pool-events.ts`, `src/lib/playlist-hygiene.ts`, `src/lib/web-push.ts`, comments in `src/lib/*.ts` that name the old path, every test under `test/` that names `/subscriptions`

**Interfaces:**
- Produces: `legacyApp` (Hono) exported from `src/routes/legacy.ts`; `LEGACY_PAGE_MAP: Record<string, string>` (old sub-path to new sub-path, only `'/tracklist' -> '/set'` today).

- [ ] **Step 1: Write the failing legacy test** in `test/legacy-redirects.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { app } from '../src/index'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'
import type { Env } from '../src/types'

const locked = () => ({ CACHE: fakeKV(), SUBS: fakeKV(), DB: fakeD1(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k',
  CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CF_ACCESS_AUD: 'aud', CF_ACCESS_ALLOWED_EMAILS: 'owner@example.com' }) as unknown as Env
const get = (path: string, init: RequestInit = {}) => app.request(`https://tracked.example${path}`, init, locked())

describe('the old /subscriptions prefix', () => {
  it.each([
    ['/subscriptions', '/ui'],
    ['/subscriptions/', '/ui/'],
    ['/subscriptions/pool', '/ui/pool'],
    ['/subscriptions/captcha/ch-1', '/ui/captcha/ch-1'],
    ['/subscriptions/removed', '/ui/removed'],
    ['/subscriptions/dj/some-dj', '/ui/dj/some-dj'],
    ['/subscriptions/tracklist?url=https%3A%2F%2Fx.example%2Fa.html', '/ui/set?url=https%3A%2F%2Fx.example%2Fa.html'],
  ])('%s answers 301 to %s without Access and without content', async (from, to) => {
    const r = await get(from)
    expect(r.status).toBe(301)
    expect(r.headers.get('location')).toBe(to)
  })
  it.each(['/subscriptions/api/list', '/subscriptions/api/pool/status', '/subscriptions/oauth/callback?code=x', '/subscriptions/sw.js'])('%s answers 410 moved', async (path) => {
    const r = await get(path)
    expect(r.status).toBe(410)
    const body = await r.json() as { error: string; message: string }
    expect(body.error).toBe('moved')
    expect(body.message).toContain('/ui/')
  })
  it('a POST to the old API is refused with 410, not redirected', async () => {
    const r = await get('/subscriptions/api/add', { method: 'POST', headers: { 'content-type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, body: '{}' })
    expect(r.status).toBe(410)
  })
  it('GET / redirects to /ui/ without the bearer token', async () => {
    const r = await get('/')
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('/ui/')
  })
  it('/ui and /ui/ both need Access', async () => {
    expect((await get('/ui/')).status).toBe(401)
  })
  it('/ui/tracklist keeps working as a redirect to /ui/set', async () => {
    const r = await get('/ui/tracklist?url=x')
    expect([301, 401]).toContain(r.status) // behind Access: 401 here; with the bypass it is a 301
  })
  it('the new prefix is behind Access and the bearer routes are untouched', async () => {
    expect((await get('/ui')).status).toBe(401)
    expect((await get('/ui/api/list')).status).toBe(401)
    expect((await get('/now-playing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401)
  })
})
```

- [ ] **Step 2: Run it.** `npx vitest run test/legacy-redirects.test.ts`. Expected: FAIL (301s are 401s or 404s; `/` answers 200 text).

- [ ] **Step 3: Write `src/routes/legacy.ts`:**

```ts
/**
 * The admin UI lived under /subscriptions until the phase 1 redesign moved it to /ui.
 * Old bookmarks and pushes delivered before the deploy still point here: pages answer a
 * 301 to the same path under /ui (the retired viewer to /ui/set), and the API, OAuth and
 * the old service worker answer 410 (a redirect would drop a POST body, and a 410 on its
 * script makes the browser drop the old worker). No handler serves content, so none needs
 * Access. Keep until the owner retires the old prefix.
 */
import { Hono } from 'hono'

export const LEGACY_PAGE_MAP: Record<string, string> = { '/tracklist': '/set' }

export const legacyApp = new Hono()

legacyApp.all('*', (c) => {
  const url = new URL(c.req.url)
  const rest = url.pathname.replace(/^\/subscriptions/, '') // '' | '/' | '/pool' | '/api/…'
  if (rest === '/sw.js' || rest.startsWith('/api/') || rest === '/api' || rest.startsWith('/oauth/') || rest === '/oauth') {
    return c.json({ error: 'moved', message: `This API moved to /ui${rest}` }, 410)
  }
  const mapped = LEGACY_PAGE_MAP[rest] ?? rest
  return c.redirect(`/ui${mapped}${url.search}`, 301)
})
```

- [ ] **Step 4: Rewire `src/index.ts`.** Replace the `GET /` hint with `app.get('/', (c) => c.redirect('/ui/', 302))`. Replace the `/subscriptions` block with:

```ts
app.use('/ui/api/*', sameOriginJson)
app.use('/ui/oauth/disconnect', sameOriginJson)
app.use('/ui', noFraming)
app.use('/ui/*', noFraming)
app.route('/ui', poolUiApp) // ahead of subscriptionsApp so its '*' gate doesn't run twice
app.route('/ui', subscriptionsApp)
// Old prefix: 301 for pages, 410 for API / OAuth / sw.js (routes/legacy.ts). No content, no Access needed.
app.route('/subscriptions', legacyApp)
```

Register the trailing-slash home explicitly (strict routing makes `/ui/` a 404 otherwise), right after the mounts: `app.use('/ui/', cfAccess)` then `app.get('/ui/', (c) => servePage(c, HOME_HTML))`, where `HOME_HTML` is exported from `src/routes/subscriptions.ts` (the old `PAGE_HTML` until Task 12 swaps in the Home page) and `servePage` is a two-line helper in `src/routes/subscriptions.ts` for now (moved to `src/ui/pages/index.ts` in Task 5). Add a bypass-env test in the legacy test file that `/ui` and `/ui/` both answer 200 with `no-store`.

In the wildcard gate, exempt `path === '/'`, `/ui` + `/ui/…`, and keep `/subscriptions` + `/subscriptions/…` exempt. Update the comments.

- [ ] **Step 5: Move every server-side path.** Run `grep -rn "subscriptions" src` and change each hit:
  - `src/middleware/same-origin.ts`: `LIVE_VIEW_PATH = /^\/ui\/api\/pool\/challenges\/[A-Za-z0-9_-]{1,64}\/live(\/|$)/`; doc comments.
  - `src/routes/subscriptions.ts`: `STATE_COOKIE` path `/ui/oauth` (set and delete); OAuth callback redirects go to `/ui/playlists?yt=connected` and `/ui/playlists?yt_error=…` (the Playlists page owns the YouTube connection from Task 10; until then `/ui/playlists` is served by the old main page, see Step 6); every `/subscriptions/api/…` and `/subscriptions/…` literal inside `PAGE_HTML`, `TRACKLIST_PAGE_HTML`, `DJ_PAGE_HTML` becomes `/ui/…`; add `subscriptionsApp.get('/tracklist', (c) => c.redirect('/ui/set' + new URL(c.req.url).search, 301))` and serve `TRACKLIST_PAGE_HTML` at `/set`. In the same step move `test/lazy-links.test.ts` and the same-origin page list from `/ui/tracklist` to `/ui/set` (the 301 has no body, so the page-text test would fail).
  - `src/lib/google-oauth.ts` `redirectUriFor`: `${u.origin}/ui/oauth/callback` (`test/google-oauth.test.ts` lines 52 to 54 pin it; they become `/ui/oauth/...`). Check that test file and `test/subscriptions.test.ts` for any pinned `?yt=` redirect target and move it to `/ui/playlists?yt=…`.
  - `src/routes/pool-ui.ts`: `NAV_HTML` links, `COMMON_JS` base `'/ui/api/pool'`, `/accounts` redirect to `/ui/pool`, header comment.
  - `src/routes/ban-ui.ts`: `api` base `'/ui'`, `register('/ui/sw.js', { scope: '/ui/' })`, `SW_JS` default URLs `'/ui/'`.
  - `src/routes/playlist-hygiene.ts`: page links and fetch paths in `REMOVED_PAGE_HTML`.
  - `src/lib/pool-events.ts` (`/ui/captcha/<id>`, `/ui/pool`), `src/lib/playlist-hygiene.ts` (`/ui/removed`), `src/lib/web-push.ts` (`url: '/ui/'` twice), comments elsewhere.

- [ ] **Step 6: Serve the old main page at the pages it is about to be split into**, so links from Tasks 6 to 12 work in between: in `subscriptions.ts` register `PAGE_HTML` at `/` and also at `/djs`, `/playlists`, `/mkvid`, `/settings`, `/tools` (each route is removed by the task that builds the real page). `/ui` and `/ui/` both answer (Hono's mounted `/` matches both; add a test).

- [ ] **Step 7: Old service worker cleanup in `BAN_JS`.** Replace `getReg` with:

```js
  async function dropOldRegistrations() {
    // Before the /ui move the worker lived at /subscriptions/sw.js. Drop it and its push
    // subscription once, so a device does not end up subscribed twice.
    if (!navigator.serviceWorker.getRegistrations) return false;
    let dropped = false;
    for (const reg of await navigator.serviceWorker.getRegistrations()) {
      if (!/\/subscriptions\/$/.test(reg.scope || '')) continue;
      try {
        const old = reg.pushManager && (await reg.pushManager.getSubscription());
        if (old) {
          await api('/api/push/unsubscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ endpoint: old.endpoint }) });
          await old.unsubscribe().catch(() => {});
          dropped = true;
        }
      } catch {}
      await reg.unregister().catch(() => {});
    }
    return dropped;
  }
  async function getReg() { if (swReg) return swReg; swReg = await navigator.serviceWorker.register('/ui/sw.js', { scope: '/ui/' }); return swReg; }
```

In `syncPush`, before `pushState()`: `const hadOld = pushSupported ? await dropOldRegistrations() : false;` and after computing `st`: `if (hadOld && !st.sub && Notification.permission === 'granted') { await enablePush(); return; }` (granted permission means no prompt).

- [ ] **Step 8: Test the cleanup.** Add to `test/admin-hardening.test.ts` a BAN_JS run with `navigator.serviceWorker` faking one old registration (`scope: 'https://tracked.example/subscriptions/'`, a subscription with endpoint `https://push.example/old`) and a new one, `Notification.permission = 'granted'`, `window = { isSecureContext: true, PushManager: {}, Notification }`, and a `pushConfig` answer `{ configured: true, publicKey: 'AQAB' }`. Assert: one POST to `/ui/api/push/unsubscribe` with body `{"endpoint":"https://push.example/old"}`, `unregister` called once on the old registration, `register('/ui/sw.js', { scope: '/ui/' })`, one POST to `/ui/api/push/subscribe`, and no `Notification.requestPermission` call.

- [ ] **Step 9: Test the push URLs.** In `test/admin-hardening.test.ts` (service worker block) assert `poolEventPushPayload` for a `challenge.created` event with id `ch-1` has `url === '/ui/captcha/ch-1'`, a flagged account `'/ui/pool'`, and `playlistHoldPayload(...).url === '/ui/removed'` (requested by the pool session).

- [ ] **Step 10: Move every test path.** Rewrite only path literals, never module paths or the `subscriptions` D1 table: `grep -rl "/subscriptions" test | grep -v legacy-redirects | xargs sed -i -E "s#(['\"\`(]|example|//x)/subscriptions#\1/ui#g"`. Then `grep -rn "subscriptions" test` and check every remaining hit by hand: imports of `../src/lib/subscriptions` and `../src/routes/subscriptions`, SQL on the `subscriptions` table and test titles stay; any leftover path literal moves. Keep `test/pool-ui.test.ts` and `test/ban-state.test.ts` otherwise unchanged. The `test/admin-hardening.test.ts` accounts-redirect assertion becomes `/ui/pool`.

- [ ] **Step 11: Run everything.** `npx vitest run` and `npx tsc --noEmit`. Expected: all pass, including the new legacy test.

- [ ] **Step 12: Docs for the move.** README: replace every `/subscriptions` with `/ui` except in a new short paragraph under "Subscriptions mini-app" that says the old prefix answers 301/410 until retired; Deploy step 4 says the Access app covers `/ui/*`; OAuth setup says the redirect URI is `/ui/oauth/callback`. `.dev.vars.example` and `docs/tasker-setup.md` likewise.

- [ ] **Step 13: Commit.** `git add -A && git commit -m "Move the admin UI from /subscriptions to /ui, with 301/410 for the old prefix" -m "<body: what moved, legacy answers, push URL and service worker migration>" -m "Co-Authored-By: …" -m "Claude-Session: …"` (trailers as in Global Constraints).

---

### Task 2: Tokens and component CSS

**Files:**
- Create: `src/ui/tokens.ts`, `src/ui/base.ts`, `test/ui-css.test.ts`

**Interfaces:**
- Produces: `TOKENS_CSS: string`, `BASE_CSS: string`. Class names below are the contract for every page task.

- [ ] **Step 1: Failing test** `test/ui-css.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { TOKENS_CSS } from '../src/ui/tokens'
import { BASE_CSS } from '../src/ui/base'

describe('tokens', () => {
  it('is dark first with the spec values, and light twice (media query and manual)', () => {
    for (const v of ['#101219', '#171a23', '#1f2330', '#2a2f3d', '#3a4052', '#e8e9f0', '#a3a7b8', '#737889', '#a597ff', '#7b6cf6', '#3fb950', '#d29922', '#f85149', '#58a6ff']) expect(TOKENS_CSS).toContain(v)
    for (const v of ['#f6f6fa', '#5b4bd6', '#1a7f37', '#9a6700', '#cf222e', '#0969da']) expect(TOKENS_CSS.split(v).length).toBe(3)
    expect(TOKENS_CSS).toContain('color-scheme: dark')
    expect(TOKENS_CSS).toContain(':root:not([data-theme="dark"])')
    expect(TOKENS_CSS).toContain(':root[data-theme="light"]')
  })
})
describe('base', () => {
  it('defines every component class the pages use', () => {
    for (const c of ['.tk-shell', '.tk-side', '.tk-nav', '.tk-top', '.tk-tabs', '.tk-main', '.tk-head', '.tk-card', '.tk-grid', '.tk-tiles', '.tk-tile', '.tk-meter',
      '.btn', '.btn.primary', '.btn.danger', '.btn.ghost', '.btn.icon', '.badge', '.badge.ok', '.badge.warn', '.badge.bad', '.badge.info', '.badge.neutral',
      '.field', '.chips', '.chip', '.tk-table', '.tk-tabbar', '.tk-drawer', '.tk-dialog', '.tk-toasts', '.toast', '.empty', '.err-state', '.skel', '.mono',
      '.trk', '.set-card', '.ban-alert', '.ban-alert.paused', '.ban-alert.simulated', '.error']) expect(BASE_CSS).toContain(c)
  })
  it('has the three breakpoints and no gradient', () => {
    expect(BASE_CSS).toContain('max-width: 1099px')
    expect(BASE_CSS).toContain('max-width: 799px')
    expect(BASE_CSS).toContain('max-width: 699px')
    expect(BASE_CSS).not.toMatch(/gradient\(/)
  })
})
```

- [ ] **Step 2: Run it**, expect FAIL (modules missing).

- [ ] **Step 3: Write `src/ui/tokens.ts`.** Export `TOKENS_CSS` with the exact variable set of the approved design artifact (`--page --card --elev --line --line-strong --fg --muted --subtle --accent --accent-fill --on-accent --accent-soft --ok --ok-bg --warn --warn-bg --danger --danger-bg --info --info-bg --sans --mono`), values from spec section 7, plus `--r-ctl: 6px; --r-tile: 8px; --r-card: 10px; --sp-1..6: 4 8 12 16 24 32px; --fs-xs .75rem; --fs-sm .85rem; --fs-md .95rem; --fs-lg 1.05rem; --fs-xl 1.35rem; --fs-2xl 1.7rem; --shadow-float: 0 12px 32px rgba(0,0,0,.35)`. Shape: dark on `:root` with `color-scheme: dark`; light under `@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { … } }` and again under `:root[data-theme="light"]` (with `color-scheme: light`).

- [ ] **Step 4: Write `src/ui/base.ts`.** Export `BASE_CSS`. Port the component samples from the approved design artifact (`.btn`, `.badge` with the dot, `.tile`, `.meter`, `.field`, `.banner`, `.trk`) under the class names in the test, and add:
  - Reset: `*{box-sizing:border-box}`, `body{margin:0;background:var(--page);color:var(--fg);font:15px/1.5 var(--sans)}`, `[hidden]{display:none!important}`, `a{color:var(--accent)}`, `code,.mono{font-family:var(--mono)}`, `table{font-variant-numeric:tabular-nums}`, focus ring `:focus-visible{outline:2px solid var(--accent);outline-offset:2px}`.
  - Shell: `.tk-shell{display:grid;grid-template-columns:15rem minmax(0,1fr);min-height:100vh}`; `.tk-side` sticky full-height column (`--elev` background, grouped `.tk-nav` with `.grp` labels, `a.on` = accent-soft background and accent text, `.count` pill, footer `.tk-side-foot` with status pill, theme select, "Signed in via Access"); `.tk-main{max-width:1400px;padding:24px 32px 48px}`; `.tk-top` (phone top bar: title + menu button) hidden on desktop; `.tk-tabs` (phone bottom tab bar, 5 equal columns, `position:fixed;bottom:0`, `padding-bottom:env(safe-area-inset-bottom)`) hidden on desktop; `.tk-menu` (phone menu sheet, a `<dialog>`).
  - `@media (max-width: 1099px)`: `.tk-shell{grid-template-columns:4rem minmax(0,1fr)}`, nav labels and group titles hidden (`.tk-nav .lbl,.grp{display:none}`), icons centered, `title` attributes give tooltips.
  - `@media (max-width: 799px)`: `.tk-shell{display:block}`, `.tk-side{display:none}`, `.tk-top` and `.tk-tabs` shown, `.tk-main{padding:12px 16px calc(72px + env(safe-area-inset-bottom))}`, `.tk-head` actions wrap under the title, dialogs and drawers become bottom sheets (`margin:auto 0 0;width:100%;max-height:85vh;border-radius:10px 10px 0 0`).
  - `@media (max-width: 699px)`: `.tk-table` becomes cards (`thead{display:none}`, `tr{display:block;border:1px solid var(--line);border-radius:var(--r-card);margin-bottom:8px}`, `td{display:flex;justify-content:space-between;gap:8px}`, `td::before{content:attr(data-label);color:var(--subtle)}`).
  - `.tk-head` (h1 at `--fs-2xl`, description `--muted`, `.actions` flex wrap), `.tk-card` (the only bordered surface, radius 10px, padding 16px), `.tk-grid.two` / `.three` (auto-fit columns, one column under 800px), `.tk-tiles`, `.tk-tile .k .v .s`, `.tk-meter > i`.
  - `.chips/.chip/.chip.on`, `.tk-tabbar` (role=tablist, `[aria-selected=true]` underline), `.tk-drawer` (native `<dialog>` pinned right, 28rem, full height, `--shadow-float`; `::backdrop` rgba(0,0,0,.45)), `.tk-dialog`, `.tk-toasts` (fixed bottom-right, above the tab bar on a phone), `.toast.ok/.bad`, `.empty`, `.err-state` (+ Retry), `.skel` (pulsing block, disabled under `prefers-reduced-motion`).
  - Buttons: `.btn` (secondary), `.primary`, `.danger`, `.ghost`, `.icon` (square 32px), `.btn[aria-busy=true]` shows progress cursor and opacity .6, `.btn:disabled`.
  - Track row `.trk` (grid `52px 36px 1fr auto`: cue, artwork, text, link pills), set card `.set-card` (head row with title, badge, date; collapsible body).
  - Banner: `.ban-alert` restyled to spec colours (`--danger-bg` background, `--danger` border, `--fg` text), `.ban-alert.paused` stronger border, `.ban-alert.simulated` dashed, `.ban-btn`, `.ban-btn.primary` (accent fill), keep every class `BAN_JS` toggles. Also `.alerts-state.on/.off/.err`, `.ban-route .ok/.bad`, `.ban-eps` from the old `BAN_CSS`, on the new tokens.
  - `.error` (role=alert status text, `--danger`), `.ok-text`, `.muted`, `.subtle`.
  Keep it under about 500 lines. No gradients; shadows only on drawer, dialog, toast.

- [ ] **Step 5: Run the test**, expect PASS. `npx tsc --noEmit` clean.

- [ ] **Step 6: Commit** ("UI tokens and component CSS for the redesign").

### Task 3: Icons

**Files:**
- Create: `src/ui/icons.ts`, `test/ui-icons.test.ts`

**Interfaces:**
- Produces: `type IconName = 'home' | 'djs' | 'search' | 'playlist' | 'removed' | 'mkvid' | 'activity' | 'pool' | 'captcha' | 'settings' | 'tools' | 'sliders' | 'menu' | 'close' | 'sun' | 'moon' | 'monitor' | 'external' | 'refresh' | 'play' | 'bell' | 'shield' | 'up' | 'down' | 'top' | 'bottom' | 'ban' | 'check' | 'warn' | 'copy' | 'link'`; `icon(name: IconName, opts?: { size?: number; label?: string }): string`.

- [ ] **Step 1: Failing test:**

```ts
import { describe, it, expect } from 'vitest'
import { icon, ICON_NAMES } from '../src/ui/icons'
describe('icon()', () => {
  it('returns a 24px-viewBox stroke SVG in currentColor for every name', () => {
    for (const n of ICON_NAMES) {
      const s = icon(n)
      expect(s).toMatch(/^<svg [^>]*viewBox="0 0 24 24"/)
      expect(s).toContain('stroke="currentColor"')
      expect(s).toContain('aria-hidden="true"')
    }
  })
  it('labels an icon when asked, and sizes it', () => {
    expect(icon('menu', { label: 'Menu', size: 20 })).toContain('role="img" aria-label="Menu"')
    expect(icon('menu', { size: 20 })).toContain('width="20"')
  })
})
```

- [ ] **Step 2: Run**, FAIL.
- [ ] **Step 3: Implement.** `ICON_NAMES` is a readonly tuple of the names above. Each icon is a string of `<path>`/`<circle>`/`<rect>` children drawn on a 24 grid (stroke 1.75, round caps and joins, no fill), in the amber AppIcon style (Lucide-like shapes: house, users, magnifier, list-music, trash, film, activity pulse, server, shield-check, gear, wrench, sliders, three lines, x, sun, moon, monitor, arrow-up-right box, rotate-cw, play triangle, bell, shield, chevron up/down, arrow-up-to-line, arrow-down-to-line, circle-slash, check, triangle-alert, copy, link). `icon()` wraps it: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" ${label ? `role="img" aria-label="${escAttr(label)}"` : 'aria-hidden="true"'}>…</svg>`; default size 18.
- [ ] **Step 4: Run**, PASS. **Step 5: Commit** ("UI icon set").

### Task 4: Client runtime and theme boot

**Files:**
- Create: `src/ui/runtime.ts`, `test/ui-runtime.test.ts`

**Interfaces:**
- Produces: `THEME_BOOT_JS: string`, `RUNTIME_JS: string` (defines `var TK`, members as listed in the File map section).

- [ ] **Step 1: Failing tests** in `test/ui-runtime.test.ts`. A helper runs the scripts in a context built from parts:

```ts
import { describe, it, expect } from 'vitest'
import vm from 'node:vm'
import { RUNTIME_JS, THEME_BOOT_JS } from '../src/ui/runtime'

function ctx(extra: Record<string, unknown> = {}) {
  const els = new Map<string, any>()
  const el = () => ({ innerHTML: '', textContent: '', value: '', hidden: false, disabled: false, className: '', dataset: {}, style: {},
    addEventListener() {}, showModal() { this.open = true }, close() { this.open = false }, querySelector: () => null, querySelectorAll: () => [] })
  const document = { hidden: false, getElementById: (id: string) => (els.has(id) ? els.get(id) : (els.set(id, el()), els.get(id))), querySelector: () => null, addEventListener() {} }
  const c = vm.createContext({ document, console, setTimeout, clearTimeout, Date, JSON, ...extra })
  return { c, els, document }
}

describe('shared scripts in the minimal pool stub', () => {
  it('run without window, navigator, localStorage, location, history or body', () => {
    const { c } = ctx()
    expect(() => vm.runInContext(THEME_BOOT_JS, c)).not.toThrow()
    expect(() => vm.runInContext(RUNTIME_JS, c)).not.toThrow()
    expect(vm.runInContext('typeof TK.api.post', c)).toBe('function')
  })
  it('the theme survives a throwing localStorage', () => {
    const throwing = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }
    const root = { dataset: {} as Record<string, string> }
    const { c } = ctx({ localStorage: throwing })
    ;(c as any).document.documentElement = root
    expect(() => vm.runInContext(THEME_BOOT_JS + RUNTIME_JS + ';TK.theme.set("dark")', c)).not.toThrow()
    expect(root.dataset.theme).toBe('dark')
  })
  it('boot applies a stored manual theme and leaves "system" to the media query', () => {
    for (const [stored, want] of [['light', 'light'], ['dark', 'dark'], ['system', undefined], [null, undefined]] as const) {
      const root = { dataset: {} as Record<string, string> }
      const { c } = ctx({ localStorage: { getItem: () => stored, setItem() {} } })
      ;(c as any).document.documentElement = root
      vm.runInContext(THEME_BOOT_JS, c)
      expect(root.dataset.theme).toBe(want)
    }
  })
})

describe('TK.api', () => {
  it('sends same-origin JSON with the method and content type in one literal', async () => {
    const calls: Array<[string, RequestInit]> = []
    const { c } = ctx({ fetch: async (u: string, i: RequestInit) => (calls.push([u, i]), new Response('{"ok":true}', { status: 200 })) })
    vm.runInContext(RUNTIME_JS, c)
    const r = await vm.runInContext("TK.api.post('/ui/api/add', { url: 'x' })", c)
    expect(r).toMatchObject({ ok: true, status: 200, data: { ok: true } })
    expect(calls[0]![1]).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{"url":"x"}' })
    await vm.runInContext("TK.api.post('/ui/api/x')", c)
    expect(calls[1]![1].body).toBe('{}')
    expect(RUNTIME_JS).toMatch(/\{ method: 'POST', headers: \{ 'content-type': 'application\/json' \}/)
  })
  it('turns a network error into status 0 and a non-JSON body into raw', async () => {
    const { c } = ctx({ fetch: async () => { throw new TypeError('offline') } })
    vm.runInContext(RUNTIME_JS, c)
    expect(await vm.runInContext("TK.api.get('/ui/api/list')", c)).toMatchObject({ ok: false, status: 0, data: { error: 'network' } })
    const { c: c2 } = ctx({ fetch: async () => new Response('Internal Server Error', { status: 500 }) })
    vm.runInContext(RUNTIME_JS, c2)
    expect(await vm.runInContext("TK.api.get('/x')", c2)).toMatchObject({ ok: false, status: 500, data: null, raw: 'Internal Server Error' })
  })
  it('errText maps known codes to plain text', () => {
    const { c } = ctx()
    vm.runInContext(RUNTIME_JS, c)
    expect(vm.runInContext("TK.errText({ data: { error: 'youtube_not_connected' } }, 'x')", c)).toMatch(/YouTube/)
    expect(vm.runInContext("TK.errText({ data: { error: 'e', message: 'Plain words' } }, 'x')", c)).toBe('Plain words')
    expect(vm.runInContext("TK.errText({ status: 502, data: null }, 'failed (502)')", c)).toBe('failed (502)')
  })
})

describe('TK.poll', () => {
  it('backs off on 5xx, stops on 401 with onAuth, pauses while hidden', async () => {
    const timers: Array<{ fn: () => unknown; ms: number }> = []
    const { c, document } = ctx({ setTimeout: (fn: () => unknown, ms: number) => (timers.push({ fn, ms }), timers.length), clearTimeout() {} })
    vm.runInContext(RUNTIME_JS, c)
    let status = 503; let authed = 0
    ;(c as any).fn = async () => status
    ;(c as any).onAuth = () => { authed++ }
    vm.runInContext('TK.poll(fn, 20000, { onAuth })', c)
    expect(timers.at(-1)!.ms).toBe(20000)
    await timers.at(-1)!.fn(); expect(timers.at(-1)!.ms).toBe(40000)
    await timers.at(-1)!.fn(); expect(timers.at(-1)!.ms).toBe(60000)
    status = 401; const n = timers.length
    await timers.at(-1)!.fn(); expect(authed).toBe(1); expect(timers.length).toBe(n)
    document.hidden = true
  })
})

describe('TK.fmt', () => {
  it('keeps the old helpers', () => {
    const { c } = ctx()
    vm.runInContext(RUNTIME_JS, c)
    expect(vm.runInContext('TK.fmt.dur(90 * 60000)', c)).toBe('1 h 30 min')
    expect(vm.runInContext('TK.fmt.dur(5 * 60000)', c)).toBe('5 min')
    expect(vm.runInContext("TK.fmt.setLabel('https://www.1001tracklists.com/tracklist/abc/some_dj-set-name.html')", c)).toBe('some dj set name')
    expect(vm.runInContext("TK.fmt.setLabel('')", c)).toBe('(unknown set)')
    expect(vm.runInContext('TK.fmt.clock(3725)', c)).toBe('1:02:05')
  })
})
```

- [ ] **Step 2: Run**, FAIL.

- [ ] **Step 3: Implement `src/ui/runtime.ts`.**
  - `THEME_BOOT_JS`: `(function(){try{var t=localStorage.getItem('tk-theme');if(t==='dark'||t==='light')document.documentElement.dataset.theme=t}catch(e){}})();`
  - `RUNTIME_JS`: `var TK = (() => { … return { … } })();`. Port `esc`, `clock`, `relTime` (as `rel`), `setLabel` verbatim from `git show 02b883f:src/routes/subscriptions.ts` (main page script, `esc` at 1641, `clock` 1646, `relTime` 1654, `setLabel` 1824); `fmtTime`, `fmtDur`, `ago` verbatim from `BAN_JS`; `untilTime` from 2103 (as `until`); `fmtDate` from 1252 (as `date`). The four senders are written out literally, method first:

```js
  const JSON_HEADERS = 'application/json';
  async function send(path, init) {
    let r;
    try { r = await fetch(path, init); } catch (e) { return { ok: false, status: 0, data: { error: 'network' }, raw: '' }; }
    const raw = await r.text().catch(() => '');
    let data = null; try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
    return { ok: r.ok, status: r.status, data, raw };
  }
  const body = (b) => JSON.stringify(b === undefined ? {} : b);
  const api = {
    get: (path) => send(path, { credentials: 'same-origin' }),
    post: (path, b) => send(path, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: body(b) }),
    put: (path, b) => send(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: body(b) }),
    del: (path, b) => send(path, { method: 'DELETE', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: body(b) }),
  };
```

  (Drop the unused `JSON_HEADERS` line; it is shown only to stress that the header must stay a literal.) `KNOWN_CODES`: `youtube_not_connected` "YouTube is not connected. Connect it on the Playlists page.", `youtube_reauth_required` "YouTube token rejected by Google (refresh token expired or revoked). Reconnect to continue syncing.", `network` "Could not reach tracked. Check the connection and try again.", `unauthorized` "Your Cloudflare Access login has expired. Reload the page to sign in again.", `internal` "Something went wrong in the Worker.", `json_required` "The page sent a request the Worker refuses. Reload the page.", `cross_origin` "The Worker refused a request from another site."
  - `toast(msg, kind, detail)`: appends to `#tk-toasts` when `document.createElement` exists (a `div.toast.ok|bad` with text, optional `<pre>` detail via textContent, removed after 6 s for ok, kept with a close button for bad); otherwise sets `#tk-toasts` textContent.
  - `ask(text, opts)`: uses `#tk-confirm`, `#tk-confirm-text`, `#tk-confirm-yes`, `#tk-confirm-no`; sets texts, `className` of yes button `btn danger` or `btn primary`; `showModal()`; resolves true on yes, false on no or on the dialog's `close`/`cancel` event; guards against a missing `showModal` by resolving false.
  - `drawer.open(title, html)`: `#tk-drawer`, `#tk-drawer-title` (textContent), `#tk-drawer-body` (innerHTML), `showModal()`, returns the body element; `#tk-drawer-close` and Escape close it. `drawer.close()`.
  - `busy(btn, label, fn)`: remembers `textContent` and `disabled`, sets `disabled = true`, `textContent = label`, sets `btn.dataset.busy = '1'`, awaits `fn()`, restores in `finally`.
  - `poll(fn, everyMs, opts)`: port the pool page `poller` from `git show 02b883f:src/routes/pool-ui.ts` (inside `COMMON_JS`) verbatim, renamed.
  - `qs.get(name)`: `typeof location === 'undefined' ? null : new URLSearchParams(location.search).get(name)`. `qs.set(obj)`: builds the query from `obj` (skips empty values) and calls `history.replaceState(null, '', location.pathname + (q ? '?' + q : ''))`, guarded.
  - `navCount(n)`: `#nav-count-captcha` and `#tab-count-captcha`: textContent `n`, hidden when `!n`.
  - `theme.get()`: stored value or `'system'` (try/catch). `theme.set(v)`: store (try/catch), then `document.documentElement.dataset.theme = v` for dark/light or `delete …theme` for system (guard `document.documentElement`).
  - `safeHref(u)`: `/^https?:\/\//i.test(String(u || '')) ? String(u) : null`.

- [ ] **Step 4: Run**, PASS. `npx tsc --noEmit`.
- [ ] **Step 5: Commit** ("Shared client runtime and theme boot for the UI shell").

### Task 5: Shell, page registry and the page test

**Files:**
- Create: `src/ui/shell.ts`, `src/ui/pages/index.ts`, `test/ui-pages.test.ts`
- Modify: `src/routes/ban-ui.ts` (stub-tolerant guards, page kinds)

**Interfaces:**
- Consumes: `TOKENS_CSS`, `BASE_CSS`, `icon`, `THEME_BOOT_JS`, `RUNTIME_JS`, `BAN_BANNER_HTML`, `BAN_JS`.
- Produces: `NAV`, `shell(opts)`, `SHELL_JS`, `UiPage`, `servePage` (moved here from `subscriptions.ts`).

- [ ] **Step 1: Failing tests** `test/ui-pages.test.ts` (the file every page task extends):

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import vm from 'node:vm'
import { app } from '../src/index'
import { shell } from '../src/ui/shell'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'
import type { Env } from '../src/types'

const env = (extra: Record<string, unknown> = {}) => ({ CACHE: fakeKV(), SUBS: fakeKV(), DB: fakeD1(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k', DEV_BYPASS_CF_ACCESS: '1', ...extra }) as unknown as Env
const lockedEnv = () => env({ DEV_BYPASS_CF_ACCESS: undefined, CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CF_ACCESS_AUD: 'aud', CF_ACCESS_ALLOWED_EMAILS: 'owner@example.com', TLPOOL_URL: 'https://tlpool.example', TLPOOL_TOKEN: 'x' })
const scriptsOf = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
afterEach(() => vi.unstubAllGlobals())

/** Every shell page: path and the h1 text it must carry. Page tasks add rows. */
export const PAGES: Array<[string, string]> = [
]

/** The pool tests' stub: no body, window, navigator, storage, location or history. */
function minimalStub() {
  const el = (): any => ({ innerHTML: '', textContent: '', value: '', hidden: false, checked: false, disabled: false, className: '', src: '', dataset: {}, style: {}, options: [],
    addEventListener() {}, focus() {}, add() {}, remove() {}, showModal() {}, close() {}, querySelector: () => el(), querySelectorAll: () => [], closest: () => null })
  const els = new Map<string, any>()
  const document = { hidden: false, getElementById: (id: string) => (els.has(id) ? els.get(id) : (els.set(id, el()), els.get(id))), querySelector: () => null, addEventListener() {} }
  return vm.createContext({ document, fetch: async () => new Response('{}', { status: 404 }), setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, console, Date,
    Option: function (t: string, v: string) { return { text: t, value: v } } })
}

describe('shell()', () => {
  const html = shell({ nav: 'djs', title: 'DJs & more', description: 'One line', actions: '<button id="a">A</button>', body: '<p id="b">x</p>', js: 'window.__page = 1' })
  it('is one document with the tokens, the banner, the nav, the page and the scripts in order', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<h1>DJs &amp; more</h1>')
    expect(html).toContain('id="ban-banner"')
    expect(html).toContain('href="/ui/pool/settings"')
    expect(html).toContain('id="tk-toasts"')
    expect(html).toContain('id="tk-confirm"')
    expect(html).toContain('id="tk-drawer"')
    expect(html).toMatch(/<a [^>]*class="on"[^>]*href="\/ui\/djs"|<a [^>]*href="\/ui\/djs"[^>]*class="on"/)
    const scripts = scriptsOf(html)
    expect(scripts.length).toBe(5) // theme boot, runtime, shell, BAN_JS, page
    expect(scripts[4]).toBe('window.__page = 1')
    for (const s of scripts) expect(() => new vm.Script(s)).not.toThrow()
    expect(html).not.toMatch(/<script [^>]/)
  })
  it('its shared scripts run in the minimal pool stub', () => {
    const c = minimalStub()
    for (const s of scriptsOf(shell({ nav: 'pool', title: 'Pool accounts', body: '' })).slice(0, 4)) expect(() => vm.runInContext(s, c)).not.toThrow()
  })
  it('narrow pages get the 560px column and phone tabs list the five destinations', () => {
    const h = shell({ nav: 'captcha', title: 'Captcha', body: '', width: 'narrow' })
    expect(h).toContain('tk-main narrow')
    for (const p of ['/ui', '/ui/djs', '/ui/search', '/ui/mkvid', '/ui/pool']) expect(h).toContain(`href="${p}"`)
  })
})

describe.runIf(PAGES.length > 0)('every UI page', () => {
  it.each(PAGES)('%s: 200, no-store, shell nav, its h1, the pool settings link, the banner, scripts that parse and run', async (path, h1) => {
    const r = await app.request(`https://tracked.example${path}`, {}, env())
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('no-store')
    const text = await r.text()
    expect(text).toContain('class="tk-nav"')
    expect(text).toContain(`<h1>${h1}`)
    expect(text).toContain('/ui/pool/settings')
    expect(text).toContain('id="ban-banner"')
    const scripts = scriptsOf(text)
    for (const s of scripts) expect(() => new vm.Script(s)).not.toThrow()
    const c = minimalStub()
    for (const s of scripts.slice(0, 4)) expect(() => vm.runInContext(s, c)).not.toThrow()
  })
  it.each(PAGES)('%s answers 401 without Access and never reaches tlpool', async (path) => {
    const spy = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', spy)
    expect((await app.request(`https://tracked.example${path}`, {}, lockedEnv())).status).toBe(401)
    expect(spy).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run**, FAIL (no shell).

- [ ] **Step 3: Make `BAN_JS` stub-tolerant and page-aware** (`src/routes/ban-ui.ts`):
  - `const page = (document.body && document.body.dataset && document.body.dataset.banPage) || 'other';`
  - `const history = page === 'main' || page === 'settings';` (renders route, devices, episodes; uses `?live=1`), `const prompts = page === 'main' || page === 'home';` (auto-prompt once per session). Replace each `page === 'main'` with the matching flag. The 15-minute note goes to `alerts-msg` when `history`.
  - `const pushSupported = typeof navigator !== 'undefined' && typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;`
  - `$banner.classList.toggle(...)` becomes guarded: `if ($banner.classList) { … } else { $banner.className = 'ban-alert' + (pause ? ' paused' : '') + (simulated ? ' simulated' : '') }`.
  - Leave every string, id and timer as is; `test/admin-hardening.test.ts` must stay green unchanged.

- [ ] **Step 4: Write `src/ui/shell.ts`.**
  - `NAV`: `{ key, label, href, icon, group, tab }[]` in this order and grouping: Home (`/ui`, tab); Library: DJs (`/ui/djs`, tab), Search (`/ui/search`, tab, phase 3: until then it links to `/ui/djs?focus=filter`), Playlists (`/ui/playlists`), Removed videos (`/ui/removed`); Pipeline: mkvid (`/ui/mkvid`, tab), Activity (`/ui/activity`, phase 2: omitted from `NAV` until phase 2); Pool: Accounts (`/ui/pool`, tab, tab label "Pool"), Challenges (`/ui/captcha`, with `<span class="count" id="nav-count-captcha" hidden></span>`), Pool settings (`/ui/pool/settings`); Settings (`/ui/settings`); Tools (`/ui/tools`).
  - `shell(o)` returns:

```html
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark light"><title>{title} · tracked</title>
<style>{TOKENS_CSS}{BASE_CSS}{o.css}</style>
<script>{THEME_BOOT_JS}</script></head>
<body data-ban-page="{o.banPage||'other'}"{o.ownNavCount ? ' data-own-count="1"' : ''}>
<div class="tk-shell">
  <aside class="tk-side"> brand "tracked" · <nav class="tk-nav"> grouped links, each `<a href title="{label}" [class="on"]>{icon}<span class="lbl">{label}</span></a>` </nav>
    <div class="tk-side-foot"> <span id="tk-status" class="badge neutral">…</span> theme <select id="tk-theme"> System/Dark/Light · "Signed in via Access" </div></aside>
  <header class="tk-top"><button class="btn icon" id="tk-menu-btn" aria-label="Menu">{icon menu}</button><span class="tk-top-title">{title}</span></header>
  <main class="tk-main{narrow? ' narrow'}" id="main">
    {BAN_BANNER_HTML}
    <div class="tk-head"><div><h1{h1Id? ' id=…'}>{esc title}</h1>{description? <p class="desc">…</p>}</div><div class="actions">{actions}</div></div>
    {body}
  </main>
  <nav class="tk-tabs" aria-label="Main"> five tabs with icon + label, class="on" for the active one; Pool tab carries `<span id="tab-count-captcha" class="count" hidden>` </nav>
</div>
<dialog id="tk-menu" class="tk-dialog tk-menu"> the full NAV as a list + a close button </dialog>
<dialog id="tk-confirm" class="tk-dialog"><p id="tk-confirm-text"></p><div class="actions"><button id="tk-confirm-no" class="btn">Cancel</button><button id="tk-confirm-yes" class="btn primary">Yes</button></div></dialog>
<dialog id="tk-drawer" class="tk-drawer"><div class="tk-drawer-head"><h2 id="tk-drawer-title"></h2><button id="tk-drawer-close" class="btn icon" aria-label="Close">{icon close}</button></div><div id="tk-drawer-body"></div></dialog>
<div id="tk-toasts" class="tk-toasts" aria-live="polite"></div>
<script>{RUNTIME_JS}</script><script>{SHELL_JS}</script><script>{BAN_JS}</script>{o.js ? <script>{o.js}</script> : ''}
</body></html>
```

    Escape `title` in `<title>`, top bar and `<h1>`. Every page therefore contains the pool settings link (sidebar and menu).
  - `SHELL_JS` (IIFE, every lookup null-tolerant, no timers, no fetch on pool pages):
    - Menu button opens `#tk-menu` (`showModal`), its close button closes it.
    - Theme select: value from `TK.theme.get()`, change calls `TK.theme.set`.
    - `/` key (outside inputs) focuses `#tk-search` when present, else goes to `/ui/djs?focus=filter` (guard `location`).
    - Status pill `#tk-status`: filled from one `TK.api.get('/ui/api/ban/status')` at load: `Paused` (bad) when `pause`, `Pool offline` (warn) when `!poolConfigured`, else `Active` (ok). Skipped when `document.body` is missing.
    - Challenges count: when `document.body` exists and has no `data-own-count`, one `TK.api.get('/ui/api/pool/challenges')` at load, counting `pending && ready !== false`, then `TK.navCount(n)`. Silent on failure.
  - `src/ui/pages/index.ts`: `export interface UiPage { path: string; html: string }`, plus the helper used by the routers (moved from `subscriptions.ts`):

```ts
import type { Context } from 'hono'
export function servePage(c: Context, html: string) {
  c.header('Cache-Control', 'no-store')
  return c.html(html)
}
```

- [ ] **Step 5: Run** `npx vitest run test/ui-pages.test.ts test/admin-hardening.test.ts test/pool-ui.test.ts`, PASS (PAGES is empty so the `every UI page` block is skipped; the shell tests pass). Full `npx vitest run` and `npx tsc --noEmit`.
- [ ] **Step 6: Commit** ("App shell, page registry and the UI page test").

### Task 6: Pool pages on the shell (Pool accounts, Captchas, Captcha, Pool settings)

**Files:**
- Create: `src/ui/pages/pool.ts`, `src/ui/pages/captcha-list.ts`, `src/ui/pages/captcha.ts`, `src/ui/pages/pool-settings.ts`, `src/ui/pages/pool-common.ts` (the ported `COMMON_JS`, `CAPTCHA_JS` and page CSS)
- Modify: `src/routes/pool-ui.ts` (lines 185 to the end: constants replaced by imports; `POOL_PAGES` re-exported with the same shape), `test/ui-pages.test.ts`

**Interfaces:**
- Consumes: `shell`, `servePage`.
- Produces: `POOL_PAGE_HTML`, `CAPTCHA_LIST_HTML`, `SETTINGS_PAGE_HTML`, `captchaPageHtml(id)`, re-exported from `src/routes/pool-ui.ts` as `POOL_PAGES`.

- [ ] **Step 1: Failing test rows.** Add to `PAGES` in `test/ui-pages.test.ts`: `['/ui/pool', 'Pool accounts']`, `['/ui/pool/settings', 'Pool settings']`, `['/ui/captcha', 'Captchas']`, `['/ui/captcha/ch-1', 'Captcha']`. Also add:

```ts
it('pool pages report the Challenges count themselves and keep the phone-critical ids', async () => {
  const { POOL_PAGES } = await import('../src/routes/pool-ui')
  for (const h of [POOL_PAGES.POOL_PAGE_HTML, POOL_PAGES.CAPTCHA_LIST_HTML, POOL_PAGES.captchaPageHtml('ch-1')]) expect(h).toContain('data-own-count="1"')
  for (const id of ['add-btn', 'err', 'stats', 'prio', 'chals', 'accts', 'add-dlg', 'add-exit', 'add-passive', 'add-create', 'add-steps', 'add-captcha', 'add-msg', 'add-retry']) expect(POOL_PAGES.POOL_PAGE_HTML).toContain(`id="${id}"`)
  expect(POOL_PAGES.SETTINGS_PAGE_HTML).toContain('id="feed"')
  expect(POOL_PAGES.SETTINGS_PAGE_HTML).toContain('Render feeder: first fetches a day')
})
```

  Run, FAIL (no `tk-nav`, no `data-own-count`).

- [ ] **Step 2: Port.** Move `POOL_CSS`, `COMMON_JS`, `CAPTCHA_JS` from `src/routes/pool-ui.ts` into `src/ui/pages/pool-common.ts` unchanged except: drop colour values from `POOL_CSS` that the tokens now own (use `var(--…)`), drop the page-level layout rules the shell owns, and restyle the stat tiles, chips, challenge cards, accounts table (cards under 700px, exit kind and passive as badges) and `<dialog id="add-dlg">` on the new component classes. Every id, `data-r`/`data-act`/`data-id`/`data-yes`/`data-no`/`data-k`/`data-del`/`data-up`/`data-down` attribute, `ERRORS` string, label, hint, option and `<h1>` text stays byte-identical. `COMMON_JS` keeps its top-level names and the verbatim `headers: { 'content-type': 'application/json' }` in `jsonInit`. Each page file builds its HTML with `shell({ nav, title, body, css: POOL_CSS, js: COMMON_JS + page JS, ownNavCount: true })` for pool, captcha list and captcha; pool settings uses `ownNavCount: false`. Titles: `Pool accounts`, `Captchas`, `Captcha` (`width: 'narrow'`), `Pool settings`. `captchaPageHtml(id)` keeps `const ID = ${JSON.stringify(id)}`. The old `NAV_HTML` line is gone (the shell nav replaces it). The pool page's and the captcha list's render functions call `if (typeof TK !== 'undefined') TK.navCount(openCount)` after each successful load. The two pool settings forms sit side by side (`tk-grid two`), each a `tk-card`, saves also call `TK.toast('Saved.')` while keeping the inline `Saved.` text.
- [ ] **Step 3: Wire.** In `src/routes/pool-ui.ts` delete the page constants and import them; keep `export const POOL_PAGES = { POOL_PAGE_HTML, CAPTCHA_LIST_HTML, SETTINGS_PAGE_HTML, captchaPageHtml }`.
- [ ] **Step 4: Run** `npx vitest run test/pool-ui.test.ts test/ui-pages.test.ts test/admin-hardening.test.ts test/same-origin.test.ts`. Expected PASS with `test/pool-ui.test.ts` unchanged. If a pool test fails, fix the page, never the test. Then the full suite and tsc.
- [ ] **Step 5: Screenshot gate.** Before committing, the controller runs the local dev server (Task 14 Step 1) and screenshots `/ui/pool` and `/ui/captcha/ch-1` at 360x780 and 1440x900 with the gstack `/browse` skill. No horizontal scroll at 360; the tab bar does not cover the add-account dialog buttons or the captcha answer box. Shell CSS fixes go in this task.
- [ ] **Step 6: Commit** ("Pool pages on the new shell").

### Task 7: Set page and DJ profile

**Files:**
- Create: `src/ui/pages/set.ts`, `src/ui/pages/dj.ts`, `src/ui/pages/track-row.ts` (shared client JS for track rows and lazy links)
- Modify: `src/routes/subscriptions.ts` (`/set` and `/dj/:slug` routes serve the new pages; `TRACKLIST_PAGE_HTML` and `DJ_PAGE_HTML` deleted), `test/lazy-links.test.ts` (path `/ui/tracklist` becomes `/ui/set`), `test/same-origin.test.ts` (page list), `test/ui-pages.test.ts`

**Interfaces:**
- Produces: `TRACK_ROW_JS` (defines, inside each page IIFE, `trackRow(t)`, `fetchLinks(ids)`, `applyLinks`, `lazyLinkButton`, `loadAllLinks(root, status)`, `LINKABLE`), `SET_PAGE`, `DJ_PAGE`.

- [ ] **Step 1: Failing test rows:** `PAGES` gains `['/ui/set', 'Set']` and `['/ui/dj/some-dj', '']` (the DJ h1 has an id; the test checks `<h1` only when the expected text is empty: change the assertion to `expect(text).toContain(h1 ? `<h1>${h1}` : '<h1 id="dj-name"')`). In `test/lazy-links.test.ts` the loop runs over `['/ui/set', '/ui/dj/habstrakt']`. Run, FAIL.
- [ ] **Step 2: Port** `TRACKLIST_PAGE_HTML` (old lines 2394 to 2765) into `set.ts` and `DJ_PAGE_HTML` (2769 to 3180) into `dj.ts`, both from `git show 02b883f:src/routes/subscriptions.ts`. Move the duplicated helpers (`safeHref`, `pill`, `LINKABLE`, `fetchLinks`, `applyLinks`, `lazyLinkButton`, `loadAllLinks`, `trackRow`, `fillRowActions`) into `TRACK_ROW_JS` once; the TS source must still contain the literal `/^\\d+$/.test(t.trackId)` and `/ui/api/tracklist/links`. Keep `createElement` + `textContent` rendering and http(s)-only `href`s. Behaviour and copy per contract section 4. Changes from the old pages:
  - Set: `shell({ nav: null, title: 'Set', description: 'Paste a 1001tracklists tracklist URL, or arrive with ?url=' … })`; fix the rough edge (clear the `bad` status class after a later success); "Refresh track list" uses `TK.busy`.
  - DJ: `shell({ nav: 'djs', title: 'DJ', h1Id: 'dj-name' … })`; layout per spec section 6 (sticky summary column with subscribed badge, counts, Sync, Invalidate & resync via `POST /ui/api/sync/{slug}` and `/ui/api/resync/{slug}` with the same success text as the DJs page, "Refresh from 1001tracklists" = `?refresh=1`; set cards two across from 1300px); filter chips all / with video / no video / partial ID (client-side over loaded cards; "with video" means the card's set links include YouTube); "Open in viewer" becomes "Open set page" linking `/ui/set?url=`; `confirm()` becomes `TK.ask` with the same wording; "Remove & replace video" keeps its title and messages, errors through `TK.errText` (maps `youtube_not_connected`).
- [ ] **Step 3: Wire routes**: `subscriptionsApp.get('/set', (c) => servePage(c, SET_PAGE.html))`, `/dj/:slug` likewise; keep the `/tracklist` 301 to `/set`. Update the same-origin page list: `'/ui/set'`, `'/ui/dj/some-dj'` replace the tracklist entries.
- [ ] **Step 4: Run** the three tests, then the full suite and tsc. PASS.
- [ ] **Step 5: Commit** ("Set page and DJ profile on the new shell").

### Task 8: Removed videos

**Files:**
- Create: `src/ui/pages/removed.ts`
- Modify: `src/routes/playlist-hygiene.ts` (`REMOVED_PAGE_HTML` lines 94 to 243 deleted, route serves the import), `test/ui-pages.test.ts`

- [ ] **Step 1: Failing row** `['/ui/removed', 'Removed videos']`. Run, FAIL.
- [ ] **Step 2: Port** the old page per contract section 5 onto `shell({ nav: 'removed', title: 'Removed videos', … })`: header actions `Compare playlists now` and `Run sweep now`; the DRY RUN / LIVE bar as a badge row; holds first as cards with `They really are removed — apply once`; the table (`tk-table`, `data-label` per cell) with filter chips all / sweep / owner / replace (filter over `reason`/source client-side on loaded rows, mirrored with `TK.qs`) and a DJ filter select; `Keep it` / `Undo (re-add)`; `Older` paging by `before`. Add 401/403 handling (`TK.errText` gives the sign-in text) and map `youtube_not_connected`. All fetches through `TK.api`.
- [ ] **Step 3: Run** `test/playlist-hygiene.test.ts`, `test/ui-pages.test.ts`, `test/same-origin.test.ts`, full suite, tsc. **Step 4: Commit** ("Removed videos page on the new shell").

### Task 9: mkvid page

**Files:**
- Create: `src/ui/pages/mkvid.ts`
- Modify: `src/routes/subscriptions.ts` (`/mkvid` route serves the new page; mkvid markup and script sections are removed from `PAGE_HTML`), `test/mkvid-verified-recreate.test.ts` (page path `/ui/mkvid`), `test/same-origin.test.ts` (add `/ui/mkvid`), `test/ui-pages.test.ts`

- [ ] **Step 1: Failing changes:** `PAGES` gains `['/ui/mkvid', 'mkvid']`; in `test/mkvid-verified-recreate.test.ts` the page request becomes `app.request('http://x/ui/mkvid', …)`. Add a stub-DOM run in `test/ui-pages.test.ts` that feeds the page one `GET /ui/api/mkvid` answer (fixture with `enabled: true`, `dailyClaimCap: 30`, one pending row with `position: 7` and `readiness: { state: 'waiting_ids', until: <epoch>, idRows: 2 }`, `counts.pending: 1`, `accounts: [{ account: 'primary', label: 'primary', cap: 24, used: 3 }]`, `lastPoll: { at: now, outcome: 'ok', accounts: ['primary'] }`) through a fake `fetch`, then asserts the queue container's innerHTML contains `#7` and `waiting for IDs until` and the status element contains `Ready — mkvid takes the next set on its next poll`. Use the richer stub (the minimal stub plus `document.createElement` returning stub elements, `location: { search: '', pathname: '/ui/mkvid' }`, `history: { replaceState() {} }`). Run, FAIL.
- [ ] **Step 2: Build the page** from old markup lines 1142 to 1174 and script lines 2011 to 2381 (`git show 02b883f:src/routes/subscriptions.ts`), per contract section 3 and spec section 6 (mkvid):
  - Header actions: Refresh, `Recreate all old-style videos (N)` (hidden unless `oldStyleCount > 0`; `GET` count, `TK.ask` with the verbatim confirm text, `POST … {expect}`, 409 text).
  - Top: status line from `mkState(d)` (all nine cases, verbatim strings with U+2019), per-account caps as `tk-meter` tiles, the summary line (backlog estimate etc.).
  - Filter bar: search (250 ms debounce), status, source, account (`primary`/`shared`, sent as `account=`), DJ select rebuilt from `djs`, Clear; state mirrored with `TK.qs`; every change reloads section `all`.
  - Tabs (`role=tablist`, arrow keys): Queue (Rendering now group first, then `Up next · newest set first`, `#N` from the server's `position`, ⤒ ↑ ↓ ⤓ ✕ with their titles), Finished (settled rows), Old videos (`oldVideos` with `Retry now`). `Load {min(left,25)} more ({left} left)` per tab with the tab's cursor; the sequence counter so only the newest load renders.
  - Row click opens `TK.drawer.open(title, mkDetailHtml(r))` with every detail field and the buttons (`Release & retry`, `Unban`, `Retry`, `Render now`, `Delete and recreate` with its `TK.ask` text, `Open set page` to `/ui/set?url=`).
  - Every string pinned by `test/mkvid-verified-recreate.test.ts` present.
- [ ] **Step 3: Remove** the mkvid section and its script from `PAGE_HTML` (the old main page still serves `/`, `/djs`, `/playlists`, `/settings`, `/tools` until Tasks 10 to 12). The main page keeps a link "mkvid →" to `/ui/mkvid`.
- [ ] **Step 4: Run** full suite and tsc, PASS. **Step 5: Commit** ("mkvid page with tabs, filters and a detail drawer").

### Task 10: DJs and Playlists

**Files:**
- Create: `src/ui/pages/djs.ts`, `src/ui/pages/playlists.ts`, `src/ui/pages/dj-actions.ts` (client JS shared by DJs, Playlists and DJ profile: `syncSlug`, the sync message builder, `showReauthError`, `fixTitles` dialog)
- Modify: `src/routes/subscriptions.ts` (`/djs`, `/playlists` serve the new pages), `src/ui/pages/dj.ts` (use `dj-actions`), `test/same-origin.test.ts`, `test/ui-pages.test.ts`

- [ ] **Step 1: Failing rows** `['/ui/djs', 'DJs']`, `['/ui/playlists', 'Playlists']`; add both to the same-origin page list. Add a stub-DOM run of `/ui/djs` fed `GET /ui/api/list` with two subscriptions and `GET /ui/api/state/:slug` answers, asserting the table body contains `/ui/dj/` links, `Invalidate & resync` and that `id="fix-titles"` is in the page. Run, FAIL.
- [ ] **Step 2: DJs page** per contract section 2 (DJ list, add, remove, sync one, sync all serial, invalidate & resync all once, fix titles) and spec section 6 (DJs): table with columns DJ, Sets, Last sync, Playlist, Actions (cards under 700px), filled from `api/list` plus one `api/state/:slug` per row (loaded 4 at a time, the row shows a skeleton until its state arrives; read what `loadSubState` returns in `src/lib/sync-store.ts` for set counts, last run, last error and playlist id). Header: add form (URL field + `Add DJ` primary), `Sync all`, `Invalidate & resync all`, `Fix titles` (`id="fix-titles"`, dialog with the dry run first, `TK.ask` for the rename confirm with the verbatim text). Filter: text over names plus a "with errors" toggle, mirrored with `TK.qs`; `?focus=filter` focuses it. Remove gets an in-row confirm (`Remove {slug}?` / `Yes, remove` / `Cancel`). Status messages go to `TK.toast` with the old strings; the 412 `youtube_reauth_required` toast carries a `Reconnect YouTube` link to `/ui/oauth/start`.
- [ ] **Step 3: Playlists page**: connection card (YouTube status, `Sign in with YouTube` / Disconnect with `TK.ask('Disconnect this app from your YouTube account?')`, `POST /ui/oauth/disconnect {}`), handles `?yt=connected` (toast) and `?yt_error=` (`YouTube connect failed: …`) and strips both with `history.replaceState`; fix the rough edge (catch network errors in the status load). Combined playlist card per contract (headline, bits, inserts used of cap as a meter, `Backfill now` with its messages). Per-DJ playlists table from `api/list` + `api/state/:slug` (title, link, videos, last addition, mkvid videos when the state carries them). `Fix titles` button (same dialog). Hygiene strip from one `GET /ui/api/removals` (DRY RUN / LIVE, `deletes today n / cap`, held count, link to `/ui/removed`).
- [ ] **Step 4: Remove** the DJ list, add form, YouTube strip and Combined section and their script from `PAGE_HTML`; drop the `/djs` and `/playlists` aliases of the old page.
- [ ] **Step 5: Run** full suite and tsc. **Step 6: Commit** ("DJs and Playlists pages").

### Task 11: Settings and Tools

**Files:**
- Create: `src/ui/pages/settings.ts`, `src/ui/pages/tools.ts`
- Modify: `src/routes/subscriptions.ts` (`/settings`, `/tools`), `test/same-origin.test.ts`, `test/ui-pages.test.ts`

- [ ] **Step 1: Failing rows** `['/ui/settings', 'Settings']`, `['/ui/tools', 'Tools']`, both added to the same-origin list. Assert `/ui/settings` has `data-ban-page="settings"` and the ids `alerts-state alerts-enable alerts-test alerts-msg ban-refresh ban-route ban-devices ban-episodes`, and `/ui/tools` has `ban-simulate`. Run, FAIL.
- [ ] **Step 2: Settings** (`banPage: 'settings'`): YouTube account card (same status and actions as Playlists; reuse the client code by putting it in `src/ui/pages/youtube-card.ts`); Notifications card (`ALERTS_ROW_HTML` ids restyled: state, `Enable on this device`, `Send test notification`, message; the devices line `ban-devices`); Theme card (System / Dark / Light radio group bound to `TK.theme`); Integrations card (tlpool from `poolConfigured`, Web Push from `pushConfigured`, mkvid token from `GET /ui/api/mkvid` `enabled`); Ban episodes card (`ban-route`, `ban-episodes`, `ban-refresh`). `BAN_JS` fills these by id.
- [ ] **Step 3: Tools**: YouTube video JSON card (port lines 1562 to 1626: status, `<pre>` via textContent, Copy with `Copied` / `clipboard blocked — select the JSON and copy manually`); Purge a tracklist card (URL field, `POST /ui/api/tracklist/purge {url}`, the Set page's result texts); Simulate a ban card (`<a id="ban-simulate">`, handled by `BAN_JS`, the existing `alert` stays); Requeue ban victims card (days number default 14, dry-run checkbox default on, `POST /ui/api/ban/requeue-victims?days=N&dry=1`, prints the JSON answer); Migration status card (`GET /ui/api/migration`, printed).
- [ ] **Step 4: Remove** the YouTube JSON section, alerts row and ban history from `PAGE_HTML`; drop the `/settings` and `/tools` aliases.
- [ ] **Step 5: Run**, **Step 6: Commit** ("Settings and Tools pages").

### Task 12: Home, and the old main page removed

**Files:**
- Create: `src/ui/pages/home.ts`
- Modify: `src/routes/subscriptions.ts` (`/` serves Home; `PAGE_HTML`, its CSS and every import only it used are deleted, along with the old `BAN_CSS` usage), `src/routes/ban-ui.ts` (`BAN_CSS`, `ALERTS_ROW_HTML`, `BAN_HISTORY_HTML` removed if unused; `BAN_BANNER_HTML`, `BAN_JS`, `SW_JS`, `UNBLOCK_URL` stay), `test/pool-ui.test.ts` only where it asserts the main page links to the pool page (the link now comes from the shell nav; the assertion text stays `href="/ui/pool"`), `test/ui-pages.test.ts`

- [ ] **Step 1: Failing row** `['/ui', 'Home']` and `['/ui/', 'Home']`; assert `/ui` has `data-ban-page="home"` and that the same-origin scan of `/ui` sees more than two JSON fetches (the runtime's senders count). Add a stub-DOM run of Home fed with `api/pool/status` (budget 40, used 15), `api/pool/challenges` (one open), `api/combined`, `api/mkvid`, `api/list` + one `api/state/:slug` whose last run errored, `api/removals` with one hold, `api/audit`, `api/playlist-additions`, and assert the attention list contains a link to `/ui/captcha/`, one to `/ui/removed` and one to `/ui/dj/`. Run, FAIL.
- [ ] **Step 2: Build Home** per spec section 6 (Home): four status tiles (Fetching, YouTube, mkvid with `mkState` reused from the mkvid page by putting `mkState`, `mkEffective`, `mkWhy`, `untilTime` in `src/ui/pages/mkvid-state.ts`, Challenges); Needs attention list (open challenges, flagged or retired accounts, held playlists, failed mkvid requests, undeleted old videos, DJs whose last sync errored, an active pause or ban episode), each row a link to its fix, empty state "Nothing needs you right now."; Recent activity: last 6 requests and last 6 playlist additions side by side (port `renderAudit`/`auditDetailHtml` 1627 to 1805 and `renderPlaylistAdds`/`plDetailHtml` 1806 to 1932, rows open `TK.drawer` with the detail groups, badges and anomaly flags per contract); Quick actions: Sync all (serial over `api/list`, same text), Backfill combined, Run hygiene compare. `banPage: 'home'` (auto-prompt for notifications once per session). All loads in parallel, each tile with its own error state.
- [ ] **Step 3: Delete** `PAGE_HTML` and the page-only imports; `tsc` flags leftovers.
- [ ] **Step 4: Run** full suite and tsc. **Step 5: Commit** ("Home page; the old single admin page is gone").

### Task 13: Final sweep

**Files:**
- Modify: `README.md`, `test/same-origin.test.ts`, anything `grep` finds

- [ ] **Step 1:** `grep -rn "subscriptions" src test docs README.md .dev.vars.example` and check every hit: only the legacy app, its test, the README legacy paragraph, the D1 table `subscriptions`, `src/lib/subscriptions.ts` and the `subscriptionsApp` identifier may remain.
- [ ] **Step 2:** Same-origin page list is exactly: `/ui`, `/ui/djs`, `/ui/dj/some-dj`, `/ui/set`, `/ui/playlists`, `/ui/removed`, `/ui/mkvid`, `/ui/pool`, `/ui/pool/settings`, `/ui/captcha`, `/ui/captcha/ch-1`, `/ui/settings`, `/ui/tools`, with the `/ui` (more than two) and `/ui/pool` (verbatim header) checks.
- [ ] **Step 3:** README "Subscriptions mini-app" becomes "Admin UI (`/ui`)": the page list from spec section 4 (phase 1 pages), the shell, the theme, and where each old section went. "Files" section lists `src/ui/`.
- [ ] **Step 4:** Full suite, tsc, commit ("README and final path sweep for the /ui move").

### Task 14: Local visual check

- [ ] **Step 1:** Copy `../tracked/.dev.vars` into the worktree (gitignored), `npx wrangler d1 migrations apply tracked --local`, `npx wrangler dev --port 8787 --var DEV_BYPASS_CF_ACCESS:1`.
- [ ] **Step 2:** With the gstack `/browse` skill (never the Chrome MCP tools), screenshot every page at 1440x900 and 360x780, dark and light. Check: no horizontal scroll at 360, the tab bar leaves dialogs and the captcha answer box usable, sidebar collapses to icons at 1000, focus rings visible, empty and error states render.
- [ ] **Step 3:** Fix what the screenshots show, each fix its own commit with the suite green.

## Release (not a subagent task)

1. `git fetch origin main`, rebase, full suite and tsc.
2. `npx wrangler d1 migrations list tracked --remote` shows nothing pending (phase 1 has no migration).
3. Send the pool session the commit range for its review; get its all-clear.
4. Deploy gates (spec section 3a): the Access app covers `/ui/*` (done by the pool session on 2026-09-30, same AUD); the owner adds `https://tracked.pmaxhogan.workers.dev/ui/oauth/callback` to the Google OAuth client and keeps the old URI.
5. The owner's ok, then merge to main (Workers Builds deploys).
6. Live check at desktop and phone widths, one push notification tap (`Send test notification` and a pool challenge push if one occurs), and the OAuth round trip (Disconnect is not needed; `Sign in with YouTube` re-consents and returns to `/ui/playlists?yt=connected`).
