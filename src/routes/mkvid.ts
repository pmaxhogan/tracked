/**
 * The work queue mkvid (the NAS render/upload service) polls. Gated by its
 * own bearer token (`MKVID_TOKEN`) — never the Tasker token — and mounted in
 * src/index.ts *above* the API_TOKEN wildcard gate, which also skips this path.
 *
 *   POST /mkvid/claim     { accounts?: ['primary'|'shared'…], style? } → { request } (null when nothing is queued / claimable)
 *                         `style` = what mkvid renders tracked jobs with; a recreation is only handed out when it is `scene`
 *                         `accounts` = the Google projects mkvid can upload through right now (default ['primary']);
 *                         the request carries the `account` it was handed out for, and the set's
 *                         `tracks` [{ cueSeconds, artist, title, artworkUrl, isId, layered }] + `tracksTrusted`
 *                         (names only from a page that passed the decoy check; [] + false when none is stored)
 *   POST /mkvid/job       { id, jobId }                       attach mkvid's job id; sent again every poll while the job is
 *                         queued or running there, renewing the claim (claimed_at) so a set waiting for mkvid's
 *                         render slot is not handed out again after the claim TTL
 *                         Only requests whose list is verified (and whose 7-day ID wait is over or skipped)
 *                         are handed out, so `tracksTrusted` is true and `tracks` non-empty on every claim.
 *   POST /mkvid/complete  { id, videoId, videoUrl?, privacy?, jobId?, style? }
 *                         `style` = the visual style the video was made with (static | waves | scene);
 *                         absent = unknown = old style. A recreation's answer names `replacedVideoId`,
 *                         which the Worker then asks mkvid to delete (lib/mkvid-recreate.ts).
 *   POST /mkvid/fail      { id, error, permanent?, jobId? }
 *                         error starting `unverified_tracklist` = mkvid refused the list: back to pending,
 *                         no attempt used.
 *   GET  /mkvid/health    → { ok, verifiedLists, recreateStyle, counts, accounts, dailyClaims, dailyClaimCap }
 *                         `verifiedLists: true` = only verified lists are handed out and `unverified_tracklist`
 *                         is retryable; a scene-style mkvid claims nothing until it sees it
 *
 * See lib/mkvid.ts for the lifecycle these drive.
 */

import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../types'
import { mkvidAuth } from '../middleware/auth'
import { MkvidClaimBody } from '../schemas'
import { getAccessToken, GoogleOAuthRefreshFailed } from '../lib/google-oauth'
import { makeLogger, errorFields } from '../lib/log'
import { deleteOldVideo, RECREATE_STYLE } from '../lib/mkvid-recreate'
import { attachMkvidJob, claimMkvidRequest, completeMkvidRequest, countMkvidRequests, failMkvidRequest, mkvidAccountUsage, recordMkvidPoll } from '../lib/mkvid'

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

// The shape is published in the OpenAPI spec (src/index.ts), response included.
const ClaimBody = MkvidClaimBody
const JobBody = z.object({ id: z.string().uuid(), jobId: z.string().min(1).max(100) })
const CompleteBody = z.object({
  id: z.string().uuid(),
  videoId: z.string().regex(VIDEO_ID),
  videoUrl: z.string().url().max(300).optional().nullable(),
  privacy: z.enum(['private', 'unlisted', 'public']).optional().nullable(),
  jobId: z.string().min(1).max(100).optional().nullable(),
  style: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional().nullable(),
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
    // This Worker hands out verified lists only and treats `unverified_tracklist` as retryable (mkvid's scene style waits for this).
    verifiedLists: true,
    // Recreations go only to an mkvid whose claim says this style.
    recreateStyle: RECREATE_STYLE,
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
    return c.json({ request: await claimMkvidRequest(c.env, log, accounts, parsed.data.style ?? null) })
  } catch (e) {
    log.error('mkvid.claim_threw', errorFields(e))
    await recordMkvidPoll(c.env, 'error', accounts)
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
    if (!tok) return c.json({ error: 'youtube_not_connected', message: 'connect a YouTube account at /ui first' }, 503)
    accessToken = tok.accessToken
  } catch (e) {
    if (e instanceof GoogleOAuthRefreshFailed) return c.json({ error: 'youtube_not_connected', message: e.message }, 503)
    throw e
  }
  try {
    const r = await completeMkvidRequest(c.env, b, accessToken, log)
    if (r.status === 'not_found') return c.json({ error: 'not_found' }, 404)
    if (r.status === 'invalid_state') return c.json({ error: 'invalid_state', current: r.current }, 409)
    // A recreation: ask mkvid to delete the old video once this answer is out
    // (the cron retries it if this attempt fails).
    const doomed = r.status === 'done' ? r.replacedVideoId : r.status === 'banned' ? r.videoId : undefined
    if (doomed) {
      const job = deleteOldVideo(c.env, doomed, log, fetch, { dueOnly: true }).catch((e) => log.warn('mkvid.old_video_delete_threw', errorFields(e)))
      try {
        c.executionCtx.waitUntil(job)
      } catch {
        await job // no execution context (tests)
      }
    }
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
