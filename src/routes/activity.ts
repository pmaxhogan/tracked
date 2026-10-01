// Read-only Activity and Set diagnostics endpoints (spec "Activity (phase 2)",
// "Set"). Mounted inside subscriptionsApp, so behind its cfAccess gate and the
// /ui/api/* same-origin guard.
import { Hono } from 'hono'
import type { Env } from '../types'
import { listActivity, parseActivityQuery } from '../lib/activity'
import { normalizeTracklistUrl } from '../lib/tracklists1001'
import { setDiagnostics } from '../lib/set-diagnostics'

export const activityApp = new Hono<{ Bindings: Env; Variables: { cfAccessEmail: string } }>()

activityApp.get('/api/activity', async (c) => {
  const q = parseActivityQuery(new URL(c.req.url).searchParams)
  if ('error' in q) return c.json({ error: 'invalid_request', message: q.error }, 400)
  return c.json(await listActivity(c.env, q))
})

activityApp.get('/api/set', async (c) => {
  const url = normalizeTracklistUrl(c.req.query('url') || '')
  if (!url) return c.json({ error: 'invalid_request', message: 'not a 1001tracklists tracklist URL' }, 400)
  return c.json(await setDiagnostics(c.env, url))
})
