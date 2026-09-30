import { OpenAPIHono } from '@hono/zod-openapi'
import { nowPlayingRoute, nowPlayingHandler } from './routes/now-playing'
import { tracklistRoute, tracklistHandler } from './routes/tracklist'
import { tracklistPurgeRoute, tracklistPurgeHandler } from './routes/tracklist-purge'
import { likesRoute, likesHandler } from './routes/likes'
import { likedSongsRoute, likedSongsHandler } from './routes/liked-songs'
import { HOME_HTML, servePage, subscriptionsApp } from './routes/subscriptions'
import { legacyApp } from './routes/legacy'
import { cfAccess } from './middleware/cf-access'
import { noFraming, sameOriginJson } from './middleware/same-origin'
import { mkvidApp } from './routes/mkvid'
import { poolUiApp } from './routes/pool-ui'
import { MkvidClaimBody, MkvidClaimResponse } from './schemas'
import { bearerAuth } from './middleware/auth'
import type { Env } from './types'
import { backfillCombined } from './lib/sync'
import { runSchedulerTick } from './lib/fetch-scheduler'
import { poolEventsApp } from './routes/pool-api'
import { runKvMigrationTickSafely } from './lib/kv-import'
import { pruneNowPlayingAudit } from './lib/now-playing-audit'
import { prunePlaylistAdditions } from './lib/playlist-audit'
import { makeLogger, errorFields } from './lib/log'
import { drainPageCaptures } from './lib/page-store'
import { poolPagesApp } from './routes/pool-pages'
import { prunePoolEvents, retryFailedPoolPushes } from './lib/pool-events'
import { playlistHoldNotifier, runPlaylistHygiene } from './lib/playlist-hygiene'
import { retryDueOldVideoDeletions } from './lib/mkvid-recreate'

// Validation failures (zod) default to `{ success:false, error:<ZodError> }`,
// which is not the `{ error, message }` shape every route documents. Normalise
// so clients (the Tasker toasts in particular) can always read `.message`.
const app = new OpenAPIHono<{ Bindings: Env }>({
  defaultHook: (result, c) => {
    if (result.success) return
    const issues = result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
    return c.json({ error: 'invalid_request', message: issues.join('; ') }, 400)
  },
})

// Stored pages (lib/page-store.ts) are written in the background; hand them to waitUntil once the response is built.
app.use('*', async (c, next) => {
  await next()
  try {
    c.executionCtx.waitUntil(drainPageCaptures())
  } catch {
    /* no executionCtx (tests): captures still run */
  }
})

app.openapi(nowPlayingRoute, nowPlayingHandler)
app.openapi(tracklistRoute, tracklistHandler)
app.openapi(tracklistPurgeRoute, tracklistPurgeHandler)
app.openapi(likesRoute, likesHandler)
// Gated by its own LIKED_SONGS_TOKEN. Must stay above the API_TOKEN wildcard
// gate below — a route registered first, with route-level middleware, answers
// before that gate ever runs.
app.openapi(likedSongsRoute, likedSongsHandler)

// Public root: send a browser to the admin UI (Access-gated there). Anything
// else outside the Access and own-token surfaces requires the bearer token.
app.get('/', (c) => c.redirect('/ui/', 302))

// Browsers auto-request /favicon.ico for every page; serve a tiny 204 so it
// doesn't fall through to the bearer-token gate and show up as 401 noise in
// logs.
app.get('/favicon.ico', (c) => c.body(null, 204))

// Admin UI (DJ subscriptions, pool, playlists, mkvid). Gated by Cloudflare Access
// (verified inside the sub-apps' middleware), NOT by the Tasker bearer token.
// CSRF guard for every state-changing admin API call (middleware/same-origin.ts).
// Registered before the sub-apps so it runs ahead of their handlers.
app.use('/ui/api/*', sameOriginJson)
app.use('/ui/oauth/disconnect', sameOriginJson)
// Admin pages may not be framed by another site (the captcha page frames its own live view).
app.use('/ui', noFraming)
app.use('/ui/*', noFraming)
app.route('/ui', poolUiApp) // ahead of subscriptionsApp so its '*' gate doesn't run twice
app.route('/ui', subscriptionsApp)
// Routing is strict: the sub-apps' get('/') answers /ui but not /ui/, so the
// trailing-slash home is registered here, behind the same Access gate.
app.use('/ui/', cfAccess)
app.get('/ui/', (c) => servePage(c, HOME_HTML))
// Old prefix: 301 for pages, 410 for API / OAuth / sw.js (routes/legacy.ts). No content, no Access needed.
app.route('/subscriptions', legacyApp)

// Work queue for mkvid (the NAS render/upload service). Gated by its own
// MKVID_TOKEN inside the sub-app, so like /ui it must be skipped by
// the API_TOKEN wildcard gate below.
app.route('/mkvid', mkvidApp)

// tlpool's webhook (POST /pool/events), gated by TLPOOL_TOKEN inside the
// sub-app — skipped by the API_TOKEN wildcard gate below, like /mkvid.
app.route('/pool', poolPagesApp) // GET /pool/pages*, bearer API_TOKEN, gated per path; before poolEventsApp's '*' gate
app.route('/pool', poolEventsApp)
// Documented here only (the sub-app is plain Hono), so mkvid's side has a
// published contract for the claim, track list included.
app.openAPIRegistry.registerPath({
  method: 'post',
  path: '/mkvid/claim',
  summary: 'Claim the next set for mkvid to render and upload (bearer MKVID_TOKEN)',
  request: {
    body: {
      required: false,
      content: { 'application/json': { schema: MkvidClaimBody } },
    },
  },
  responses: {
    200: { description: 'The claimed request with its track list, or null.', content: { 'application/json': { schema: MkvidClaimResponse } } },
  },
})

// Bearer-gate everything else, including /openapi.json and /doc. Skip
// / (a redirect), /ui/* (Access), /subscriptions/* (legacy answers, no
// content), /mkvid/* and /pool/* — a naive wildcard would double-gate those
// surfaces, since Hono runs parent middleware after a mounted sub-app's
// handlers; their own gate would pass but then bearerAuth would 401 the
// token it doesn't recognise.
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname
  if (path === '/') return next()
  if (path === '/ui' || path.startsWith('/ui/')) return next()
  if (path === '/subscriptions' || path.startsWith('/subscriptions/')) return next()
  if (path === '/mkvid' || path.startsWith('/mkvid/')) return next()
  if (path === '/pool' || path.startsWith('/pool/')) return next()
  return bearerAuth(c, next)
})

app.doc('/openapi.json', {
  openapi: '3.0.0',
  info: {
    title: 'tracked',
    version: '0.0.1',
    description: 'Resolve currently-playing track in a YouTube DJ set via 1001tracklists.',
  },
})

/**
 * Cron trigger handler. Configured in wrangler.jsonc → `triggers.crons`:
 *   - `*\/5 * * * *`  heartbeat — one scheduler tick (lib/fetch-scheduler.ts):
 *                     a small random number of due 1001tracklists fetches
 *                     (DJ discovery, new sets, verification second fetches,
 *                     rechecks by set age, DJ backfill), highest priority
 *                     first, stopping at the pool's first refusal. tlpool owns
 *                     budget and pacing; nothing here bursts.
 *   - `0 6 * * *`     daily housekeeping only (audit pruning). It no longer
 *                     crawls every DJ at once: discovery is spread around the
 *                     clock by the scheduler.
 *
 * Both finish by reconciling the combined "all tracked artists" playlist
 * (YouTube only, no 1001tracklists traffic).
 *
 * `ctx.waitUntil` keeps the worker alive past `scheduled` returning.
 */
async function scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
  const isDaily = event.cron === '0 6 * * *'
  const log = makeLogger({ task: isDaily ? 'cron.daily' : 'cron.tick', cron: event.cron, ts: event.scheduledTime })
  log.info('cron.start')
  ctx.waitUntil(
    (async () => {
      try {
      const trigger = isDaily ? 'cron.daily' : 'cron.tick'
      // One-time KV → D1 import, a bounded slice per tick until it reports
      // done (then a cheap flag check).
      await runKvMigrationTickSafely(env, log)
      // Old mkvid videos a recreation replaced: retry the YouTube deletes that are due (never throws).
      if (env.MKVID_TOKEN) {
        const d = await retryDueOldVideoDeletions(env, log)
        if (d.tried) log.info('cron.mkvid_old_video_deletes', d)
      }
      if (isDaily) {
        // D1 has no TTLs: keep both audit trails at the 90-day horizon.
        try {
          log.info('cron.audit_pruned', { nowPlaying: await pruneNowPlayingAudit(env), playlistAdditions: await prunePlaylistAdditions(env), poolEvents: await prunePoolEvents(env) })
        } catch (e) {
          log.warn('cron.audit_prune_threw', errorFields(e))
        }
      } else {
        try {
          const r = await runSchedulerTick(env, { log })
          log.info('cron.done', { skipped: r.skipped ?? null, drawn: r.drawn, ran: r.items.length, stoppedBy: r.stoppedBy ?? null })
        } catch (e) {
          log.error('cron.threw', errorFields(e))
        }
      }
      try {
        await retryFailedPoolPushes(env, { log })
      } catch (e) {
        log.warn('cron.push_retries_threw', errorFields(e))
      }
      // Separate try/catch: a failed tick shouldn't stop the combined
      // playlist from catching up on everything that *did* land.
      try {
        log.info('cron.combined_backfill', await backfillCombined(env, { log, trigger }))
      } catch (e) {
        log.error('cron.combined_backfill_threw', errorFields(e))
      }
      // 6-hourly playlist comparison + full-recording sweep; self-paced, never throws.
      await runPlaylistHygiene(env, log, { notify: playlistHoldNotifier(env, log) })
      } finally {
        // Stored pages finish even when the tick threw.
        await drainPageCaptures()
      }
    })(),
  )
}

/** Exported for route-level tests (app.request). */
export { app }

export default {
  fetch: app.fetch.bind(app),
  scheduled,
}
