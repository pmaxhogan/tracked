/**
 * The Track uploads page's API (lib/track-uploads.ts). Mounted inside
 * subscriptionsApp, so behind its cfAccess gate and the /ui/api/* same-origin
 * guard. List endpoints speak the data-table contract (lib/table-query.ts).
 *
 *   GET  /api/track-uploads                  data table over track_uploads (default sort -createdAt)
 *                                            + counts { pending, claimed, done, failed, banned, superseded }
 *                                            + today { claims, cap }  (track claims this quota day vs trackUploads.dailyCap)
 *   GET  /api/track-uploads/bans             data table over track_upload_bans (default sort -bannedAt)
 *   POST /api/track-uploads/bans/unban       { url } → { unbanned }
 *   POST /api/track-uploads/ban-url          { url, reason? } → { banned, url, affected, requeued } (400 when the URL is not
 *                                            https on an allowlisted source host)
 *   GET  /api/track-uploads/playlist         → { playlistId, title, url }  (never creates; null id until the first upload)
 *   POST /api/track-uploads/:id/retry        → { ok, upload, playlistRetried? }
 *   POST /api/track-uploads/:id/ban-link     { reason? } → { banned, url, affected, requeued, upload, next }
 */

import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../types'
import { makeLogger } from '../lib/log'
import { tableResponse, type TableDef } from '../lib/table-query'
import { getAppSettings } from '../lib/app-settings'
import { getAccessToken } from '../lib/google-oauth'
import {
  banTrackSourceUrl,
  banTrackUploadLink,
  countTrackUploads,
  getStoredTrackPlaylist,
  retryTrackUpload,
  sourceOfUrl,
  TRACK_UPLOAD_COLUMNS,
  TRACK_UPLOAD_STATUSES,
  trackClaimsToday,
  trackUploadOut,
  unbanTrackSourceUrl,
  type TrackUploadOut,
  type TrackUploadRow,
} from '../lib/track-uploads'

export const trackUploadsUiApp = new Hono<{ Bindings: Env; Variables: { cfAccessEmail: string } }>()

const log = (c: { req: { raw: Request }; get(k: 'cfAccessEmail'): string }, route: string) =>
  makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route, by: c.get('cfAccessEmail') })

export const TRACK_UPLOADS_TABLE: TableDef<TrackUploadRow & { source_banned: number }, TrackUploadOut> = {
  from: 'track_uploads u',
  select: TRACK_UPLOAD_COLUMNS,
  primaryKey: 'id',
  defaultSort: '-createdAt',
  columns: {
    id: { sql: 'u.id', type: 'number' },
    artist: { sql: 'u.artist', type: 'text', searchable: true },
    title: { sql: 'u.title', type: 'text', searchable: true },
    sourceName: { sql: 'u.source_name', type: 'enum' },
    sourceUrl: { sql: 'u.source_url', type: 'text', searchable: true },
    status: { sql: 'u.status', type: 'enum', options: TRACK_UPLOAD_STATUSES },
    attempts: { sql: 'u.attempts', type: 'number' },
    createdAt: { sql: 'u.created_at', type: 'datetime', storage: 's' },
    claimedAt: { sql: 'u.claimed_at', type: 'datetime', storage: 's' },
    completedAt: { sql: 'u.completed_at', type: 'datetime', storage: 's' },
    videoId: { sql: 'u.video_id', type: 'text', searchable: true },
    error: { sql: 'u.error', type: 'text' },
    account: { sql: 'u.account', type: 'enum', options: ['primary', 'shared'] },
  },
  mapRow: (r) => trackUploadOut(r),
}

type BanRow = { url: string; source_name: string | null; reason: string | null; upload_id: number | null; presave_id: number | null; banned_at: number }
export type TrackUploadBanOut = { url: string; sourceName: string | null; reason: string | null; uploadId: number | null; presaveId: number | null; bannedAt: number }

export const TRACK_UPLOAD_BANS_TABLE: TableDef<BanRow, TrackUploadBanOut> = {
  from: 'track_upload_bans',
  primaryKey: 'url',
  defaultSort: '-bannedAt',
  columns: {
    url: { sql: 'url', type: 'text', searchable: true },
    sourceName: { sql: 'source_name', type: 'enum' },
    reason: { sql: 'reason', type: 'text', searchable: true },
    bannedAt: { sql: 'banned_at', type: 'datetime', storage: 's' },
  },
  mapRow: (r) => ({ url: r.url, sourceName: r.source_name, reason: r.reason, uploadId: r.upload_id, presaveId: r.presave_id, bannedAt: Number(r.banned_at) * 1000 }),
}

const ReasonBody = z.object({ reason: z.string().max(500).optional().nullable() })
const UrlBody = z.object({ url: z.string().min(1).max(2000), reason: z.string().max(500).optional().nullable() })

async function json<T>(c: { req: { json(): Promise<unknown> } }, schema: z.ZodType<T>): Promise<T | null> {
  const parsed = schema.safeParse((await c.req.json().catch(() => null)) ?? {})
  return parsed.success ? parsed.data : null
}

function idParam(raw: string): number | null {
  return /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : null
}

trackUploadsUiApp.get('/api/track-uploads', (c) =>
  tableResponse(c, TRACK_UPLOADS_TABLE, c.env.DB, {
    extra: async () => ({
      counts: await countTrackUploads(c.env),
      today: { claims: await trackClaimsToday(c.env), cap: (await getAppSettings(c.env)).trackUploads.dailyCap },
    }),
  }),
)

trackUploadsUiApp.get('/api/track-uploads/bans', (c) => tableResponse(c, TRACK_UPLOAD_BANS_TABLE, c.env.DB))

trackUploadsUiApp.post('/api/track-uploads/bans/unban', async (c) => {
  const b = await json(c, z.object({ url: z.string().min(1).max(2000) }))
  if (!b) return c.json({ error: 'invalid_request', message: 'url is required' }, 400)
  return c.json({ unbanned: await unbanTrackSourceUrl(c.env, b.url, log(c, 'track_uploads.unban')) })
})

trackUploadsUiApp.post('/api/track-uploads/ban-url', async (c) => {
  const b = await json(c, UrlBody)
  if (!b) return c.json({ error: 'invalid_request', message: 'url is required' }, 400)
  const src = sourceOfUrl(b.url)
  if (!src) return c.json({ error: 'invalid_request', message: 'not an https URL on an allowed source host (soundcloud, bandcamp, hearthis, mixcloud)' }, 400)
  return c.json(await banTrackSourceUrl(c.env, src.url, { reason: b.reason ?? null, sourceName: src.sourceName }, log(c, 'track_uploads.ban_url')))
})

trackUploadsUiApp.get('/api/track-uploads/playlist', async (c) => {
  const title = (await getAppSettings(c.env)).trackUploads.playlistTitle
  const stored = await getStoredTrackPlaylist(c.env)
  // A stored id for an older title is not this playlist any more: the next upload finds or creates the new one.
  const playlistId = stored && stored.title === title ? stored.playlistId : null
  return c.json({ playlistId, title, url: playlistId ? `https://www.youtube.com/playlist?list=${playlistId}` : null })
})

trackUploadsUiApp.post('/api/track-uploads/:id/retry', async (c) => {
  const id = idParam(c.req.param('id'))
  if (id === null) return c.json({ error: 'invalid_request', message: 'bad id' }, 400)
  const r = await retryTrackUpload(c.env, id, log(c, 'track_uploads.retry'), async () => (await getAccessToken(c.env).catch(() => null))?.accessToken ?? null)
  if (r.ok) return c.json(r)
  const status = r.error === 'not_found' ? 404 : r.error === 'youtube_not_connected' ? 503 : 409
  return c.json({ error: r.error, message: r.message }, status)
})

trackUploadsUiApp.post('/api/track-uploads/:id/ban-link', async (c) => {
  const id = idParam(c.req.param('id'))
  if (id === null) return c.json({ error: 'invalid_request', message: 'bad id' }, 400)
  const b = await json(c, ReasonBody)
  if (!b) return c.json({ error: 'invalid_request', message: 'reason must be a string' }, 400)
  const r = await banTrackUploadLink(c.env, id, b.reason ?? null, log(c, 'track_uploads.ban_link'))
  if (!r) return c.json({ error: 'not_found' }, 404)
  return c.json(r)
})
