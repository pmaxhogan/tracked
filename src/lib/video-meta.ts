/**
 * Per-video facts from the YouTube Data API, cached in D1 (`video_meta`):
 * duration (contentDetails), orientation (player embed size, requested with
 * `maxWidth` so YouTube scales it to the video's aspect ratio) and liveness
 * (status, or the id missing from the answer). One `videos.list` call per 50
 * ids, 1 quota unit each, whatever the parts.
 *
 * Called with the owner's OAuth token, so the owner's own private uploads
 * (mkvid renders YouTube forced private) come back as alive; somebody else's
 * private or deleted video is simply absent, which is what "dead" means here.
 */

import type { Env } from '../types'
import { batchChunked, dbOf } from './db'
import { authedFetch, expectOk, parseIsoDuration } from './youtube-playlists'

const API = 'https://www.googleapis.com/youtube/v3'
/** Width asked for; only the ratio of the answer matters. */
const EMBED_MAX_WIDTH = 1280
/** Duration and orientation never change; re-read once a month anyway. */
export const VIDEO_META_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

export type VideoMeta = {
  videoId: string
  durationSeconds: number | null
  embedWidth: number | null
  embedHeight: number | null
  privacy: string | null
  uploadStatus: string | null
  alive: boolean
  fetchedAt: number
}

type ApiItem = {
  id?: string
  contentDetails?: { duration?: string }
  player?: { embedWidth?: string | number; embedHeight?: string | number }
  status?: { privacyStatus?: string; uploadStatus?: string }
}

const num = (x: unknown): number | null => {
  const n = typeof x === 'string' ? Number(x) : typeof x === 'number' ? x : NaN
  return Number.isFinite(n) ? n : null
}

/** Upload states that mean the video will never play. */
const DEAD_UPLOAD = /^(deleted|failed|rejected)$/

/** One or more videos.list calls. Ids the API does not echo back come out as `alive: false`. */
export async function fetchVideoMeta(
  videoIds: string[],
  accessToken: string,
  fetcher: typeof fetch = fetch,
  now = Math.floor(Date.now() / 1000),
): Promise<Map<string, VideoMeta>> {
  const out = new Map<string, VideoMeta>()
  const ids = [...new Set(videoIds)]
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50)
    const params = new URLSearchParams({
      part: 'contentDetails,player,status',
      id: chunk.join(','),
      maxResults: '50',
      maxWidth: String(EMBED_MAX_WIDTH),
    })
    const res = await authedFetch(`${API}/videos?${params}`, accessToken, {}, fetcher)
    await expectOk(res, 'videos.list')
    const data = (await res.json()) as { items?: ApiItem[] }
    for (const it of data.items ?? []) {
      if (!it.id) continue
      const uploadStatus = it.status?.uploadStatus ?? null
      out.set(it.id, {
        videoId: it.id,
        durationSeconds: parseIsoDuration(it.contentDetails?.duration),
        embedWidth: num(it.player?.embedWidth),
        embedHeight: num(it.player?.embedHeight),
        privacy: it.status?.privacyStatus ?? null,
        uploadStatus,
        alive: !(uploadStatus && DEAD_UPLOAD.test(uploadStatus)),
        fetchedAt: now,
      })
    }
    for (const id of chunk) {
      if (!out.has(id)) {
        out.set(id, { videoId: id, durationSeconds: null, embedWidth: null, embedHeight: null, privacy: null, uploadStatus: null, alive: false, fetchedAt: now })
      }
    }
  }
  return out
}

type Row = {
  video_id: string
  duration_seconds: number | null
  embed_width: number | null
  embed_height: number | null
  privacy: string | null
  upload_status: string | null
  alive: number
  fetched_at: number
}

const fromRow = (r: Row): VideoMeta => ({
  videoId: r.video_id,
  durationSeconds: r.duration_seconds === null ? null : Number(r.duration_seconds),
  embedWidth: r.embed_width === null ? null : Number(r.embed_width),
  embedHeight: r.embed_height === null ? null : Number(r.embed_height),
  privacy: r.privacy,
  uploadStatus: r.upload_status,
  alive: Number(r.alive) === 1,
  fetchedAt: Number(r.fetched_at),
})

/** Cached rows for `videoIds` (any age). */
export async function readCachedVideoMeta(env: Env, videoIds: string[]): Promise<Map<string, VideoMeta>> {
  const out = new Map<string, VideoMeta>()
  const ids = [...new Set(videoIds)]
  const db = dbOf(env)
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90)
    const res = await db
      .prepare(`SELECT * FROM video_meta WHERE video_id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk)
      .all<Row>()
    for (const r of res.results) out.set(r.video_id, fromRow(r))
  }
  return out
}

export async function saveVideoMeta(env: Env, metas: Iterable<VideoMeta>): Promise<void> {
  const db = dbOf(env)
  const stmts = [...metas].map((m) =>
    db
      .prepare(
        `INSERT INTO video_meta (video_id, duration_seconds, embed_width, embed_height, privacy, upload_status, alive, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(video_id) DO UPDATE SET duration_seconds = excluded.duration_seconds, embed_width = excluded.embed_width,
           embed_height = excluded.embed_height, privacy = excluded.privacy, upload_status = excluded.upload_status,
           alive = excluded.alive, fetched_at = excluded.fetched_at`,
      )
      .bind(m.videoId, m.durationSeconds, m.embedWidth, m.embedHeight, m.privacy, m.uploadStatus, m.alive ? 1 : 0, m.fetchedAt),
  )
  await batchChunked(db, stmts)
}

/**
 * Meta for every id: from the cache when younger than `maxAgeSeconds`,
 * otherwise from the API (and written back). `maxAgeSeconds: 0` forces a
 * fresh read — the liveness check wants that. Dead entries are re-read after
 * a day even under the default age, so a video that was only briefly
 * unavailable is not written off for a month.
 */
export async function getVideoMeta(
  env: Env,
  videoIds: string[],
  accessToken: string,
  opts: { maxAgeSeconds?: number; fetcher?: typeof fetch; now?: number } = {},
): Promise<Map<string, VideoMeta>> {
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const maxAge = opts.maxAgeSeconds ?? VIDEO_META_MAX_AGE_SECONDS
  const ids = [...new Set(videoIds.filter(Boolean))]
  const cached = maxAge > 0 ? await readCachedVideoMeta(env, ids) : new Map<string, VideoMeta>()
  const out = new Map<string, VideoMeta>()
  const stale: string[] = []
  for (const id of ids) {
    const c = cached.get(id)
    const age = c ? now - c.fetchedAt : Infinity
    if (c && age < maxAge && (c.alive || age < 24 * 60 * 60)) out.set(id, c)
    else stale.push(id)
  }
  if (stale.length > 0) {
    const fetched = await fetchVideoMeta(stale, accessToken, opts.fetcher, now)
    await saveVideoMeta(env, fetched.values())
    for (const [id, m] of fetched) out.set(id, m)
  }
  return out
}
