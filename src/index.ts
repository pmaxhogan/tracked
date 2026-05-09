import { OpenAPIHono } from '@hono/zod-openapi'
import { nowPlayingRoute, nowPlayingHandler } from './routes/now-playing'
import { subscriptionsApp } from './routes/subscriptions'
import { bearerAuth } from './middleware/auth'
import type { Env } from './types'

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

export default app
