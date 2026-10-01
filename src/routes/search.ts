// Search (spec §9): GET /ui/api/search over the SEARCH_DB index
// (src/lib/search/query.ts). Mounted inside subscriptionsApp, so behind its
// cfAccess gate and the /ui/api/* same-origin guard. Read-only.
import { Hono } from 'hono'
import type { Env } from '../types'
import { parseSearchQuery, search } from '../lib/search/query'

export const searchApp = new Hono<{ Bindings: Env; Variables: { cfAccessEmail: string } }>()

searchApp.get('/api/search', async (c) => {
  const q = parseSearchQuery(new URL(c.req.url).searchParams)
  if ('error' in q) return c.json({ error: 'invalid_request', message: q.error }, 400)
  if (!c.env.SEARCH_DB) return c.json({ error: 'search_unavailable', message: 'The search index is not bound to this Worker.' }, 503)
  return c.json(await search(c.env, q))
})
