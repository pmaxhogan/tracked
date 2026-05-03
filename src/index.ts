import { OpenAPIHono } from '@hono/zod-openapi'
import { nowPlayingRoute, nowPlayingHandler } from './routes/now-playing'
import { bearerAuth } from './middleware/auth'
import type { Env } from './types'

const app = new OpenAPIHono<{ Bindings: Env }>()

app.openapi(nowPlayingRoute, nowPlayingHandler)

// Public root: just a hint. Anything past `/` requires the bearer token.
app.get('/', (c) => c.text('tracked — POST /now-playing (Bearer auth). See /openapi.json'))

// Bearer-gate everything else, including /openapi.json and /doc.
app.use('*', bearerAuth)

app.doc('/openapi.json', {
  openapi: '3.0.0',
  info: {
    title: 'tracked',
    version: '0.0.1',
    description: 'Resolve currently-playing track in a YouTube DJ set via 1001tracklists.',
  },
})

export default app
