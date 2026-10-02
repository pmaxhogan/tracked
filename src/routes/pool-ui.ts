/**
 * Admin pages for the tlpool browser pool, and the `/ui/api/pool/*`
 * routes they call. Mounted at `/ui` (in `index.ts`, ahead of the
 * main admin app), gated by Cloudflare Access like every other admin
 * page, and never by the bearer token.
 *
 *   GET  /pool                          accounts + pool status (+ Add account dialog)
 *   GET  /pool/settings                 budget, ramp, phone share, images; recheck schedule
 *   GET  /captcha                       every pending challenge
 *   GET  /captcha/:id                   one challenge: image + answer box, or the live view
 *
 *   GET  /api/pool/status               tlpool GET /status (+ GET /challenges)
 *   GET  /api/pool/accounts             tlpool GET /accounts
 *   POST /api/pool/accounts             tlpool POST /accounts {passive, exitKind?}
 *   POST /api/pool/accounts/:id/:action tlpool POST /accounts/:id/{rest,retire,retest}
 *   GET  /api/pool/accounts/:id/events  that account's newest pool events (D1 pool_events, lib/pool-events.ts)
 *   GET  /api/pool/challenges           tlpool GET /challenges
 *   GET  /api/pool/challenges/:id       tlpool GET /challenges/:id
 *   GET  /api/pool/challenges/:id/image tlpool GET /challenges/:id/image (PNG)
 *   POST /api/pool/challenges/:id/answer tlpool POST /challenges/:id/answer {text}
 *   GET  /api/pool/challenges/:id/live/* tlpool GET /challenges/:id/live/* (noVNC + websocket)
 *   GET|PUT /api/pool/limits            tlpool GET|PUT /settings
 *
 * `/api/pool/settings` (the recheck schedule and priority order;
 * shape: lib/pool-settings.ts PoolSettings) belongs to `routes/pool-api.ts`;
 * the settings page only calls it.
 *
 * The Worker is the only thing holding TLPOOL_TOKEN; the browser only ever
 * talks to these routes. `lib/pool-admin-client.ts` rebuilds every upstream
 * object from a whitelist, so no username, email or password reaches a page.
 */
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import type { Env } from '../types'
import { cfAccess } from '../middleware/cf-access'
import { makeLogger, errorFields } from '../lib/log'
import {
  ACCOUNT_ACTIONS,
  EXIT_KINDS,
  createPoolAdminClient,
  ID_RE,
  PoolAdminError,
  validateSettingsPatch,
  type AccountAction,
  type Fetcher,
  type PoolEnv,
} from '../lib/pool-admin-client'
import { isPoolAccountId, listPoolEventsForAccount } from '../lib/pool-events'
import { servePage } from '../ui/pages'
import { POOL_PAGE_HTML } from '../ui/pages/pool'
import { CAPTCHA_LIST_HTML } from '../ui/pages/captcha-list'
import { SETTINGS_PAGE_HTML } from '../ui/pages/pool-settings'
import { captchaPageHtml } from '../ui/pages/captcha'

type AppEnv = { Bindings: Env; Variables: { cfAccessEmail: string } }

/** The one optional field the Add account dialog may add: which kind of exit to pin to. */
const CreateAccountExit = z.enum(EXIT_KINDS).optional()

export function createPoolUiApp(opts: { fetcher?: Fetcher } = {}) {
  const app = new Hono<AppEnv>()
  const client = (env: Env) => createPoolAdminClient(env as PoolEnv, opts.fetcher)

  // Scoped to this app's own paths: a `use('*')` here would also run on every
  // other /ui/* request, since both apps share the mount point.
  for (const p of [
    '/pool', '/pool/*', '/captcha', '/captcha/*', '/accounts',
    '/api/pool/status', '/api/pool/accounts', '/api/pool/accounts/*',
    '/api/pool/challenges', '/api/pool/challenges/*', '/api/pool/limits',
  ]) app.use(p, cfAccess)

  app.onError((e, c) => {
    if (e instanceof PoolAdminError) {
      return c.json({ error: e.code, ...(e.detail ? { detail: e.detail } : {}), ...(e.plainMessage ? { message: e.plainMessage } : {}) }, e.status)
    }
    const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'pool_ui.unhandled', path: new URL(c.req.url).pathname })
    log.error('pool_ui.unhandled_throw', errorFields(e))
    // No message: an unexpected throw could carry the upstream URL.
    return c.json({ error: 'internal' }, 500)
  })

  const page = (c: Context<AppEnv>, html: string) => servePage(c, html)

  // ── pages ────────────────────────────────────────────────────────────────
  app.get('/pool', (c) => page(c, POOL_PAGE_HTML))
  app.get('/pool/settings', (c) => page(c, SETTINGS_PAGE_HTML))
  app.get('/captcha', (c) => page(c, CAPTCHA_LIST_HTML))
  // Older pushes (flagged account) link here; the accounts live on the pool page.
  app.get('/accounts', (c) => c.redirect('/ui/pool', 302))
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
    const body = (await c.req.json().catch(() => null)) as { passive?: unknown; exitKind?: unknown } | null
    if (body !== null && typeof body !== 'object') return c.json({ error: 'invalid', detail: 'body_not_object' }, 400)
    const passive = body?.passive === true
    const kind = CreateAccountExit.safeParse(body?.exitKind)
    if (!kind.success) return c.json({ error: 'invalid', detail: 'bad_exit_kind' }, 400)
    const exitKind = kind.data ?? 'auto'
    const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'pool_ui.create_account', by: c.get('cfAccessEmail') })
    const r = await client(c.env).createAccount(passive, exitKind)
    log.info('pool_ui.account_create_started', { passive, exitKind, challengeId: r.challengeId, accountId: r.accountId })
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

  // The state details drawer: what the pool told the Worker about one account
  // (stored events, never tlpool itself). acct-N ids only.
  app.get('/api/pool/accounts/:id/events', async (c) => {
    const id = c.req.param('id')
    if (!isPoolAccountId(id)) return c.json({ error: 'invalid', detail: 'bad_id' }, 400)
    return c.json({ events: await listPoolEventsForAccount(c.env, id, 20) })
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
    return new Response(img.body, { headers: { 'Content-Type': img.contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
  })

  app.post('/api/pool/challenges/:id/answer', async (c) => {
    const id = c.req.param('id')
    if (!ID_RE.test(id)) return c.json({ error: 'invalid', detail: 'bad_id' }, 400)
    const body = (await c.req.json().catch(() => null)) as { text?: unknown; done?: unknown } | null
    // A checkbox wall: {done: true} ("I clicked it, check now"). An image captcha: its text, as tlpool takes it (max 64).
    const done = body?.done === true
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (!done && (!text || text.length > 64)) return c.json({ error: 'invalid', detail: text ? 'answer_too_long' : 'empty_answer' }, 400)
    const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'pool_ui.answer', by: c.get('cfAccessEmail') })
    const outcome = await client(c.env).answer(id, done ? { done: true } : text)
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

/** Exported for the HTML smoke tests. The pages themselves live in src/ui/pages/. */
export const POOL_PAGES = { POOL_PAGE_HTML, CAPTCHA_LIST_HTML, SETTINGS_PAGE_HTML, captchaPageHtml }
