import { OpenAPIHono } from '@hono/zod-openapi'
import { nowPlayingRoute, nowPlayingHandler } from './routes/now-playing'
import { subscriptionsApp } from './routes/subscriptions'
import { bearerAuth } from './middleware/auth'
import type { Env } from './types'
import { syncAll, syncPendingOnly } from './lib/sync'
import { makeLogger, errorFields } from './lib/log'

const app = new OpenAPIHono<{ Bindings: Env }>()

app.openapi(nowPlayingRoute, nowPlayingHandler)

// Public root: just a hint. Anything past `/` requires the bearer token.
app.get('/', (c) => c.text('tracked — POST /now-playing (Bearer auth). See /openapi.json'))

// Browsers auto-request /favicon.ico for every page; serve a tiny 204 so it
// doesn't fall through to the bearer-token gate and show up as 401 noise in
// logs.
app.get('/favicon.ico', (c) => c.body(null, 204))

// Mini-app for managing DJ subscriptions. Gated by Cloudflare Access (verified
// inside the sub-app's middleware), NOT by the Tasker bearer token.
app.route('/subscriptions', subscriptionsApp)

// Bearer-gate everything else, including /openapi.json and /doc. Skip
// /subscriptions/* — a naive wildcard would double-gate that surface, since
// Hono runs parent middleware after a mounted sub-app's handlers; cfAccess
// would pass but then bearerAuth would 401 the missing Authorization header.
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname
  if (path === '/subscriptions' || path.startsWith('/subscriptions/')) return next()
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
 * Cron trigger handler. Configured in wrangler.jsonc → `triggers.crons` with
 * two expressions:
 *   - `0 6 * * *`     daily — full discovery + processing (`syncAll`)
 *   - `*\/5 * * * *`  every 5 min — drain pending only (`syncPendingOnly`),
 *                     fast-skips when nothing to do
 *
 * The frequent drain cron is what continues a backfill after the user
 * triggers a manual sync; they no longer have to keep clicking the button.
 *
 * `ctx.waitUntil` keeps the worker alive past `scheduled` returning so the
 * sweep can finish even if it crosses CPU-time boundaries on individual subs.
 */
async function scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
  const isDaily = event.cron === '0 6 * * *'
  const log = makeLogger({ task: isDaily ? 'cron.sync_all' : 'cron.sync_pending', cron: event.cron, ts: event.scheduledTime })
  log.info('cron.start')
  ctx.waitUntil(
    (async () => {
      try {
        const r = isDaily ? await syncAll(env, { log }) : await syncPendingOnly(env, { log })
        log.info('cron.done', {
          subs: r.results.length,
          totalAdded: r.results.reduce((a, x) => a + x.stats.videoIdsAdded, 0),
          totalStillPending: r.results.reduce((a, x) => a + x.stats.tracklistsPending, 0),
        })
      } catch (e) {
        log.error('cron.threw', errorFields(e))
      }
    })(),
  )
}

export default {
  fetch: app.fetch.bind(app),
  scheduled,
}
