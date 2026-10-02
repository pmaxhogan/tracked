// Search (spec §9): GET /ui/api/search over the SEARCH_DB index
// (src/lib/search/query.ts). Mounted inside subscriptionsApp, so behind its
// cfAccess gate and the /ui/api/* same-origin guard. Read-only.
import { Hono } from 'hono'
import type { Env } from '../types'
import { parseSearchQuery, search } from '../lib/search/query'
import { normalizeText } from '../lib/search/normalize'
import { backfillSearch, searchIndexStatus } from '../lib/search/backfill'
import { serveImage } from '../lib/search/images'
import { servePage } from '../ui/pages'
import { SEARCH_PAGE } from '../ui/pages/search'

export const searchApp = new Hono<{ Bindings: Env; Variables: { cfAccessEmail: string } }>()

searchApp.get(SEARCH_PAGE.path, (c) => servePage(c, SEARCH_PAGE.html))

// Result thumbnails: R2 copies of the indexed images (src/lib/search/images.ts).
searchApp.get('/img/:key', (c) => serveImage(c.env, c.req.param('key')))

searchApp.get('/api/search', async (c) => {
  const q = parseSearchQuery(new URL(c.req.url).searchParams)
  if ('error' in q) return c.json({ error: 'invalid_request', message: q.error }, 400)
  // A query with no words is answered (empty) without the index.
  if (!c.env.SEARCH_DB && normalizeText(q.q).length > 0) return c.json({ error: 'search_unavailable', message: 'The search index is not bound to this Worker.' }, 503)
  return c.json(await search(c.env, q))
})

const UNBOUND = { error: 'search_unavailable', message: 'The search index is not bound to this Worker.' } as const

// Index counts for the Tools card.
searchApp.get('/api/search/status', async (c) => {
  if (!c.env.SEARCH_DB) return c.json(UNBOUND, 503)
  return c.json(await searchIndexStatus(c.env))
})

// One press of "Rebuild": up to `limit` trusted mkvid lists, resumable by cursor.
searchApp.post('/api/search/backfill', async (c) => {
  if (!c.env.SEARCH_DB) return c.json(UNBOUND, 503)
  const body = (await c.req.json().catch(() => null)) as { cursor?: unknown; limit?: unknown } | null
  const limit = body?.limit ?? 500
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 500) return c.json({ error: 'invalid_request', message: 'limit: an integer from 1 to 500' }, 400)
  const cursor = body?.cursor ?? null
  if (cursor !== null && typeof cursor !== 'string') return c.json({ error: 'invalid_request', message: 'cursor: a string or null' }, 400)
  return c.json(await backfillSearch(c.env, { cursor, limit, deadlineMs: Date.now() + 20_000 }))
})
