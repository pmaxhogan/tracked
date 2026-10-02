// The Scheduler page and its read-only endpoints. Mounted inside
// subscriptionsApp, so behind its cfAccess gate and the /ui/api/* same-origin
// guard (never the bearer token: GET /ops/scheduler/ticks is the bearer twin).
//
//   GET /scheduler                      the page (ui/pages/scheduler.ts)
//   GET /api/scheduler                  { summary, djs }: the last 24 h of ticks and the DJ due times
//   GET /api/scheduler/ticks?before=&limit=   { ticks, nextBefore }: the tick list, newest first
import { Hono } from 'hono'
import type { Env } from '../types'
import { djStarvation, schedulerSummary, schedulerTicksPage } from '../lib/scheduler-report'
import { servePage } from '../ui/pages'
import { SCHEDULER_PAGE } from '../ui/pages/scheduler'

export const schedulerUiApp = new Hono<{ Bindings: Env; Variables: { cfAccessEmail: string } }>()

schedulerUiApp.get(SCHEDULER_PAGE.path, (c) => servePage(c, SCHEDULER_PAGE.html))

schedulerUiApp.get('/api/scheduler', async (c) => {
  const now = Math.floor(Date.now() / 1000)
  const [summary, djs] = await Promise.all([schedulerSummary(c.env, now), djStarvation(c.env, now)])
  return c.json({ summary, djs })
})

schedulerUiApp.get('/api/scheduler/ticks', async (c) => {
  const num = (k: string) => {
    const v = c.req.query(k)
    if (v === undefined || v === '') return undefined
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : NaN
  }
  const limit = num('limit')
  const before = num('before')
  if (Number.isNaN(limit) || Number.isNaN(before)) return c.json({ error: 'invalid_request', message: 'limit and before are positive integers' }, 400)
  return c.json(await schedulerTicksPage(c.env, { limit, before: before ?? null }))
})
