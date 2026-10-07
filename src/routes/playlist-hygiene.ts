/**
 * Playlist hygiene routes (lib/playlist-hygiene.ts), mounted inside the
 * /ui sub-app, so Cloudflare Access gates every one of them:
 *
 *   GET  /ui/removed                     what was (or in a dry run would be) removed, and why
 *   GET  /ui/api/removals                the rows behind it, settings, holds
 *   POST /ui/api/removals/:id/undo       re-add (or, for a dry-run row, keep) one video
 *   POST /ui/api/removals/holds/:playlistId/approve   apply a held comparison once
 *   POST /ui/api/hygiene/run?what=compare|sweep       run one step now
 *   POST /ui/api/set/remove-replace      the set card's "remove and replace" button
 */

import { getAppSettings } from '../lib/app-settings'
import { Hono } from 'hono'
import type { Env } from '../types'
import { getAccessToken } from '../lib/google-oauth'
import { makeLogger } from '../lib/log'
import {
  approveHold,
  listHolds,
  listRemovals,
  removalCounts,
  REASON_LABELS,
  removeAndReplace,
  runPlaylistHygiene,
  sweepDeletesUsed,
  sweepSettings,
  undoRemoval,
} from '../lib/playlist-hygiene'
import { parseDjSlug } from '../lib/subscriptions'
import { normalizeTracklistUrl } from '../lib/tracklists1001'
import { servePage } from '../ui/pages'
import { REMOVED_PAGE_HTML } from '../ui/pages/removed'

export const hygieneApp = new Hono<{ Bindings: Env; Variables: { cfAccessEmail: string } }>()

const reqLog = (c: { req: { raw: Request }; get: (k: 'cfAccessEmail') => string }, route: string) =>
  makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route, by: c.get('cfAccessEmail') })

hygieneApp.get('/removed', (c) => servePage(c, REMOVED_PAGE_HTML))

hygieneApp.get('/api/removals', async (c) => {
  const before = Number(c.req.query('before'))
  const page = await listRemovals(c.env, { limit: Number(c.req.query('limit')) || 200, before: Number.isFinite(before) && before > 0 ? before : null })
  return c.json({
    ...page,
    counts: await removalCounts(c.env),
    settings: sweepSettings(c.env, await getAppSettings(c.env)),
    deletesUsedToday: await sweepDeletesUsed(c.env),
    holds: await listHolds(c.env),
    reasonLabels: REASON_LABELS,
  })
})

hygieneApp.post('/api/removals/:id/undo', async (c) => {
  const log = reqLog(c, 'subs.hygiene.undo')
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid_id' }, 400)
  const token = await getAccessToken(c.env)
  if (!token) return c.json({ error: 'youtube_not_connected' }, 409)
  const r = await undoRemoval(c.env, token.accessToken, id, log)
  if (!r.ok) return c.json({ error: r.error }, r.error === 'not_found' ? 404 : 409)
  return c.json(r)
})

hygieneApp.post('/api/removals/holds/:playlistId/approve', async (c) => {
  const ok = await approveHold(c.env, c.req.param('playlistId'))
  return ok ? c.json({ ok: true }) : c.json({ error: 'not_held' }, 404)
})

hygieneApp.post('/api/hygiene/run', async (c) => {
  const what = c.req.query('what')
  if (what !== 'compare' && what !== 'sweep') return c.json({ error: 'invalid_request', message: 'what=compare|sweep' }, 400)
  const log = reqLog(c, `subs.hygiene.run.${what}`)
  return c.json(await runPlaylistHygiene(c.env, log, { force: what }))
})

hygieneApp.post('/api/set/remove-replace', async (c) => {
  const log = reqLog(c, 'subs.hygiene.remove_replace')
  const body = (await c.req.json().catch(() => null)) as { slug?: unknown; url?: unknown } | null
  const slug = typeof body?.slug === 'string' ? parseDjSlug(body.slug) : null
  const url = typeof body?.url === 'string' ? normalizeTracklistUrl(body.url) : null
  if (!slug || !url) return c.json({ error: 'invalid_request', message: 'slug and a 1001tracklists set url are required' }, 400)
  const token = await getAccessToken(c.env)
  if (!token) return c.json({ error: 'youtube_not_connected' }, 409)
  const r = await removeAndReplace(c.env, token.accessToken, { slug, setUrl: url, log })
  if (!r.ok) {
    const message = r.error === 'no_video' ? 'this set has no video in the playlists' : r.error === 'mkvid_video' ? 'the video is an mkvid render; use Delete and recreate instead' : 'set not known to the sync'
    return c.json({ error: r.error, message }, r.error === 'not_found' ? 404 : 409)
  }
  return c.json(r)
})
