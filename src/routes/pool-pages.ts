/**
 * Operator read routes for the stored pages (lib/page-store.ts), bearer API_TOKEN:
 *   GET /pool/pages?prefix=&cursor=&limit=   keys + metadata
 *   GET /pool/pages/<key>                    the decompressed HTML, as text/plain
 * Mounted at /pool BEFORE poolEventsApp (whose '*' gate is TLPOOL_TOKEN), and
 * gated per path here so it never touches POST /pool/events.
 */

import { Hono } from 'hono'
import type { Env } from '../types'
import { bearerAuthFor } from '../middleware/auth'
import { gunzipToText } from '../lib/page-store'

export const poolPagesApp = new Hono<{ Bindings: Env }>()

const auth = bearerAuthFor('API_TOKEN')
poolPagesApp.use('/pages', auth)
poolPagesApp.use('/pages/*', auth)

poolPagesApp.get('/pages', async (c) => {
  if (!c.env.PAGES) return c.json({ error: 'pages_not_configured' }, 503)
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 100, 1), 1000)
  const r = await c.env.PAGES.list({ prefix: c.req.query('prefix') || undefined, cursor: c.req.query('cursor') || undefined, limit, include: ['customMetadata'] } as R2ListOptions)
  return c.json({
    objects: r.objects.map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded.toISOString?.() ?? String(o.uploaded), metadata: o.customMetadata ?? {} })),
    truncated: r.truncated,
    cursor: r.truncated ? r.cursor : null,
  })
})

poolPagesApp.get('/pages/*', async (c) => {
  if (!c.env.PAGES) return c.json({ error: 'pages_not_configured' }, 503)
  const prefix = '/pool/pages/'
  const path = new URL(c.req.url).pathname
  let key: string
  try {
    key = decodeURIComponent(path.slice(prefix.length))
  } catch {
    return c.json({ error: 'bad_key' }, 400)
  }
  const obj = key ? await c.env.PAGES.get(key) : null
  if (!obj) return c.json({ error: 'not_found' }, 404)
  const raw = await obj.arrayBuffer()
  const text = obj.httpMetadata?.contentEncoding === 'gzip' ? await gunzipToText(raw) : new TextDecoder().decode(raw)
  return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } })
})
