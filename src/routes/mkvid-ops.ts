/**
 * Operator routes for mkvid requests, bearer API_TOKEN (the panel's own
 * buttons go through /ui/api/*, behind Access, and share the handlers):
 *   POST /ops/mkvid/unpublish/<request id>   take a delivered video down and requeue the set
 */

import { Hono, type Context } from 'hono'
import type { Env } from '../types'
import { bearerAuthFor } from '../middleware/auth'
import { getAccessToken } from '../lib/google-oauth'
import { makeLogger, type Logger } from '../lib/log'
import { deleteOldVideo, unpublishMkvidRequest } from '../lib/mkvid-recreate'

export const mkvidOpsApp = new Hono<{ Bindings: Env }>()
mkvidOpsApp.use('*', bearerAuthFor('API_TOKEN'))

/** Unpublish one request, then ask mkvid to delete the video now (the cron retries a failure). */
export async function unpublishResponse(c: Context<any>, id: string, log: Logger): Promise<Response> {
  const env = c.env as Env
  const token = await getAccessToken(env).catch(() => null)
  const r = await unpublishMkvidRequest(env, id, log, token?.accessToken ?? null)
  if (!r.ok) return c.json({ ...r, id }, r.error === 'not_found' ? 404 : r.error === 'not_connected' ? 503 : 409)
  const deleted = await deleteOldVideo(env, r.videoId, log).catch(() => null)
  return c.json({ ...r, deleteState: deleted?.state ?? null })
}

mkvidOpsApp.post('/mkvid/unpublish/:id', async (c) => {
  const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'ops.mkvid_unpublish' })
  return unpublishResponse(c, c.req.param('id'), log)
})
