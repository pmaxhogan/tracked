/**
 * mkvid's second queue: pre-saved tracks to rip, render (the `track` style)
 * and upload (lib/track-uploads.ts). Gated by MKVID_TOKEN like /mkvid, mounted
 * at /mkvid/track in src/index.ts ahead of /mkvid, so the API_TOKEN wildcard
 * gate skips it too. Request ids are INTEGERS (track_uploads.id), not UUIDs.
 *
 *   POST /mkvid/track/claim    { accounts?: ['primary'|'shared'…] } → { request: TrackRequest | null }
 *                              Oldest claimable first; needs room under trackUploads.dailyCap AND the
 *                              account's per-project mkvid cap (shared with set uploads).
 *   POST /mkvid/track/job      { id, jobId } → { ok }   renews the claim while the job is queued / running;
 *                              404 unknown id, 409 { error: 'invalid_state', current } when nothing was renewed
 *                              (no longer claimed, or claimed by another job)
 *   POST /mkvid/track/complete { id, videoId, videoUrl?, privacy?, jobId? }
 *                              → { status: 'done', videoId, presaveId, playlistId, playlistStatus, notified }
 *                              | { status: 'superseded', videoId, reason } | { status: 'banned', videoId }
 *                              404 unknown id, 409 { error: 'invalid_state', current } when already done / superseded
 *                              or claimed by another job than `jobId`,
 *                              503 youtube_not_connected
 *   POST /mkvid/track/fail     { id, error, permanent?, jobId? } → { status, attempts, notBefore } (404 unknown id,
 *                              409 invalid_state when claimed by another job). An error over 2000 characters is cut, never refused:
 *                              a 400 there would have mkvid retry the same report forever.
 */

import { Hono } from 'hono'
import { z } from '@hono/zod-openapi'
import type { Env } from '../types'
import { mkvidAuth } from '../middleware/auth'
import { getAccessToken, GoogleOAuthRefreshFailed } from '../lib/google-oauth'
import { makeLogger, errorFields } from '../lib/log'
import { attachTrackJob, claimTrackUpload, completeTrackUpload, failTrackUpload, getTrackUploadRow } from '../lib/track-uploads'

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
const Id = z.number().int().positive()

export const MkvidTrackClaimBody = z
  .object({
    accounts: z.array(z.enum(['primary', 'shared'])).max(2).optional().openapi({
      description: 'Accounts mkvid can upload through right now; default ["primary"]. The primary fills first, then the shared one. A track claim counts against the same per-project caps as a set claim.',
    }),
  })
  .openapi('MkvidTrackClaimBody')

export const MkvidTrackRequest = z
  .object({
    id: z.number().int().openapi({ example: 12, description: 'track_uploads.id (an integer). Echo it to /job, /complete and /fail.' }),
    presaveId: z.number().int(),
    artist: z.string().nullable().openapi({ example: 'Matroda' }),
    title: z.string().nullable().openapi({ example: 'Tobehonest (Where Ya At)' }),
    artworkUrl: z.string().nullable(),
    trackUrl: z.string().nullable().openapi({ description: 'The 1001tracklists track page, for the description.' }),
    sourceName: z.string().openapi({ example: 'soundcloud' }),
    sourceUrl: z.string().openapi({ example: 'https://api.soundcloud.com/tracks/123', description: 'Handed to yt-dlp as-is.' }),
    expectedDurationSeconds: z.number().int().nullable().openapi({ description: 'From the medialink entries; null when unknown.' }),
    minDurationRatio: z.number().openapi({ example: 0.85, description: 'Refuse (permanent, preview_clip) a rip shorter than expectedDurationSeconds × this.' }),
    privacy: z.enum(['public', 'unlisted', 'private']),
    account: z.enum(['primary', 'shared']),
    attempts: z.number().int().openapi({ description: 'Including this claim.' }),
  })
  .openapi('MkvidTrackRequest')

export const MkvidTrackClaimResponse = z
  .object({ request: MkvidTrackRequest.nullable().openapi({ description: 'null when nothing is claimable (queue empty, track cap or project caps reached, paused, no account offered).' }) })
  .openapi('MkvidTrackClaimResponse')

const JobBody = z.object({ id: Id, jobId: z.string().min(1).max(100) })
const CompleteBody = z.object({
  id: Id,
  videoId: z.string().regex(VIDEO_ID),
  videoUrl: z.string().url().max(300).optional().nullable(),
  privacy: z.enum(['private', 'unlisted', 'public']).optional().nullable(),
  jobId: z.string().min(1).max(100).optional().nullable(),
})
const FailBody = z.object({
  id: Id,
  // Cut, not refused (a 400 leaves mkvid re-sending the report forever).
  error: z.string().min(1).transform((s) => s.slice(0, 2000)),
  permanent: z.boolean().optional(),
  jobId: z.string().min(1).max(100).optional().nullable(),
})

export const mkvidTrackApp = new Hono<{ Bindings: Env }>()
mkvidTrackApp.use('*', mkvidAuth)

function logger(c: { req: { raw: Request } }, route: string) {
  return makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route })
}

async function body<T>(c: { req: { json(): Promise<unknown> } }, schema: z.ZodType<T>): Promise<T | null> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null))
  return parsed.success ? parsed.data : null
}

mkvidTrackApp.post('/claim', async (c) => {
  const log = logger(c, 'mkvid.track.claim')
  const parsed = MkvidTrackClaimBody.safeParse((await c.req.json().catch(() => null)) ?? {})
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
  try {
    const { request } = await claimTrackUpload(c.env, log, parsed.data.accounts ?? ['primary'])
    return c.json({ request })
  } catch (e) {
    log.error('track_upload.claim_threw', errorFields(e))
    return c.json({ error: 'claim_failed', ...errorFields(e) }, 500)
  }
})

mkvidTrackApp.post('/job', async (c) => {
  const b = await body(c, JobBody)
  if (!b) return c.json({ error: 'invalid_request' }, 400)
  if (await attachTrackJob(c.env, b.id, b.jobId)) return c.json({ ok: true })
  const row = await getTrackUploadRow(c.env, b.id)
  if (!row) return c.json({ error: 'not_found' }, 404)
  return c.json({ error: 'invalid_state', current: row.status }, 409)
})

mkvidTrackApp.post('/complete', async (c) => {
  const log = logger(c, 'mkvid.track.complete')
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
    const r = await completeTrackUpload(c.env, b, accessToken, log)
    if (r.status === 'not_found') return c.json({ error: 'not_found' }, 404)
    if (r.status === 'invalid_state') return c.json({ error: 'invalid_state', current: r.current }, 409)
    return c.json(r)
  } catch (e) {
    log.error('track_upload.complete_threw', { id: b.id, videoId: b.videoId, ...errorFields(e) })
    return c.json({ error: 'complete_failed', ...errorFields(e) }, 502)
  }
})

mkvidTrackApp.post('/fail', async (c) => {
  const log = logger(c, 'mkvid.track.fail')
  const b = await body(c, FailBody)
  if (!b) return c.json({ error: 'invalid_request' }, 400)
  const r = await failTrackUpload(c.env, b, log)
  if (!r) return c.json({ error: 'not_found' }, 404)
  if (r.status === 'invalid_state') return c.json({ error: 'invalid_state', current: (r as { current: string }).current }, 409)
  return c.json(r)
})
