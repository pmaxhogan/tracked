/**
 * The work queue mkvid (the NAS render/upload service) polls. Gated by its
 * own bearer token (`MKVID_TOKEN`) — never the Tasker token — and mounted in
 * src/index.ts *above* the API_TOKEN wildcard gate, which also skips this path.
 *
 *   POST /mkvid/claim     { accounts?: ['primary'|'shared'…] } → { request } (null when nothing is queued / claimable)
 *                         `accounts` = the Google projects mkvid can upload through right now (default ['primary']);
 *                         the request carries the `account` it was handed out for
 *   POST /mkvid/job       { id, jobId }                       attach mkvid's job id (informational)
 *   POST /mkvid/complete  { id, videoId, videoUrl?, privacy?, jobId? }
 *   POST /mkvid/fail      { id, error, permanent?, jobId? }
 *   GET  /mkvid/health    → { ok, counts }                    lets mkvid verify its token/config
 *
 * See lib/mkvid.ts for the lifecycle these drive.
 */

import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../types'
import { mkvidAuth } from '../middleware/auth'
import { getAccessToken, GoogleOAuthRefreshFailed } from '../lib/google-oauth'
import { makeLogger, errorFields } from '../lib/log'
import { attachMkvidJob, claimMkvidRequest, completeMkvidRequest, countMkvidRequests, failMkvidRequest, mkvidAccountUsage, recordMkvidPoll } from '../lib/mkvid'

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

const ClaimBody = z.object({ accounts: z.array(z.enum(['primary', 'shared'])).max(2).optional() })
const JobBody = z.object({ id: z.string().uuid(), jobId: z.string().min(1).max(100) })
const CompleteBody = z.object({
  id: z.string().uuid(),
  videoId: z.string().regex(VIDEO_ID),
  videoUrl: z.string().url().max(300).optional().nullable(),
  privacy: z.enum(['private', 'unlisted', 'public']).optional().nullable(),
  jobId: z.string().min(1).max(100).optional().nullable(),
})
const FailBody = z.object({
  id: z.string().uuid(),
  error: z.string().min(1).max(2000),
  permanent: z.boolean().optional(),
  jobId: z.string().min(1).max(100).optional().nullable(),
})

export const mkvidApp = new Hono<{ Bindings: Env }>()
mkvidApp.use('*', mkvidAuth)

function logger(c: { req: { raw: Request } }, route: string) {
  return makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route })
}

async function body<T>(c: { req: { json(): Promise<unknown> } }, schema: z.ZodType<T>): Promise<T | null> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null))
  return parsed.success ? parsed.data : null
}

mkvidApp.get('/health', async (c) => {
  const accounts = await mkvidAccountUsage(c.env)
  return c.json({
    ok: true,
    counts: await countMkvidRequests(c.env),
    accounts,
    dailyClaims: accounts.reduce((n, a) => n + a.used, 0),
    dailyClaimCap: accounts.reduce((n, a) => n + a.cap, 0),
  })
})

mkvidApp.post('/claim', async (c) => {
  const log = logger(c, 'mkvid.claim')
  // An empty/absent body is the pre-accounts mkvid: it has one client, the primary.
  const parsed = ClaimBody.safeParse((await c.req.json().catch(() => null)) ?? {})
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
  const accounts = parsed.data.accounts ?? ['primary']
  try {
    return c.json({ request: await claimMkvidRequest(c.env, log, accounts) })
  } catch (e) {
    log.error('mkvid.claim_threw', errorFields(e))
    await recordMkvidPoll(c.env, 'error')
    return c.json({ error: 'claim_failed', ...errorFields(e) }, 500)
  }
})

mkvidApp.post('/job', async (c) => {
  const b = await body(c, JobBody)
  if (!b) return c.json({ error: 'invalid_request' }, 400)
  await attachMkvidJob(c.env, b.id, b.jobId)
  return c.json({ ok: true })
})

mkvidApp.post('/complete', async (c) => {
  const log = logger(c, 'mkvid.complete')
  const b = await body(c, CompleteBody)
  if (!b) return c.json({ error: 'invalid_request' }, 400)
  let accessToken: string
  try {
    const tok = await getAccessToken(c.env)
    if (!tok) return c.json({ error: 'youtube_not_connected', message: 'connect a YouTube account at /subscriptions first' }, 503)
    accessToken = tok.accessToken
  } catch (e) {
    if (e instanceof GoogleOAuthRefreshFailed) return c.json({ error: 'youtube_not_connected', message: e.message }, 503)
    throw e
  }
  try {
    const r = await completeMkvidRequest(c.env, b, accessToken, log)
    if (r.status === 'not_found') return c.json({ error: 'not_found' }, 404)
    if (r.status === 'invalid_state') return c.json({ error: 'invalid_state', current: r.current }, 409)
    return c.json(r)
  } catch (e) {
    log.error('mkvid.complete_threw', { id: b.id, videoId: b.videoId, ...errorFields(e) })
    return c.json({ error: 'complete_failed', ...errorFields(e) }, 502)
  }
})

mkvidApp.post('/fail', async (c) => {
  const log = logger(c, 'mkvid.fail')
  const b = await body(c, FailBody)
  if (!b) return c.json({ error: 'invalid_request' }, 400)
  const r = await failMkvidRequest(c.env, b, log)
  if (!r) return c.json({ error: 'not_found' }, 404)
  return c.json(r)
})
