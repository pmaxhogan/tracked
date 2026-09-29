/**
 * The Worker's side of the tlpool integration (quest 2026-09-29, W4):
 *
 *   - `poolEventsApp`, mounted at `/pool` in index.ts:
 *       POST /pool/events      webhook tlpool calls (bearer TLPOOL_TOKEN):
 *                              challenge created/solved/expired, account
 *                              flagged/created. Stored in D1; the two that
 *                              need the owner become a Web Push
 *                              (lib/pool-events.ts). Answers 200
 *                              `{ ok, duplicate, push }`, 400 on a bad body.
 *   - `poolSettingsApp`, mounted at `/api/pool` inside the CF Access-gated
 *     subscriptions app:
 *       GET  /subscriptions/api/pool/settings   `{ settings, defaults }`
 *       PUT  /subscriptions/api/pool/settings   partial or full settings,
 *                              deep-merged over the current ones, validated
 *                              (lib/pool-settings.ts); 200 `{ settings }` or
 *                              400 `{ error: 'invalid_settings', issues }`.
 *     The admin page that edits them is W8's.
 */

import { Hono } from 'hono'
import type { Env } from '../types'
import { bearerAuthFor } from '../middleware/auth'
import { errorFields, makeLogger } from '../lib/log'
import { receivePoolEvent, sanitizePoolEvent } from '../lib/pool-events'
import { DEFAULT_POOL_SETTINGS, getPoolSettings, updatePoolSettings } from '../lib/pool-settings'

export const poolEventsApp = new Hono<{ Bindings: Env }>()

poolEventsApp.use('*', bearerAuthFor('TLPOOL_TOKEN'))

poolEventsApp.post('/events', async (c) => {
  const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'pool.events' })
  const body = await c.req.json().catch(() => null)
  const parsed = sanitizePoolEvent(body)
  if (!parsed.ok) {
    log.warn('pool.event_rejected', { error: parsed.error })
    return c.json({ error: 'invalid_event', message: parsed.error }, 400)
  }
  try {
    const r = await receivePoolEvent(c.env, parsed.event, { log })
    return c.json({ ok: true, duplicate: r.duplicate, push: r.push })
  } catch (e) {
    log.error('pool.event_failed', { type: parsed.event.type, ...errorFields(e) })
    return c.json({ error: 'internal', message: 'could not store the event' }, 500)
  }
})

export const poolSettingsApp = new Hono<{ Bindings: Env; Variables: { cfAccessEmail: string } }>()

poolSettingsApp.get('/settings', async (c) => {
  return c.json({ settings: await getPoolSettings(c.env), defaults: DEFAULT_POOL_SETTINGS })
})

poolSettingsApp.put('/settings', async (c) => {
  const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'subs.pool_settings', by: c.get('cfAccessEmail') })
  const body = await c.req.json().catch(() => undefined)
  const r = await updatePoolSettings(c.env, body)
  if (!r.ok) {
    log.warn('pool.settings_rejected', { issues: r.issues })
    return c.json({ error: 'invalid_settings', issues: r.issues }, 400)
  }
  log.info('pool.settings_updated', { settings: r.settings })
  return c.json({ settings: r.settings })
})
