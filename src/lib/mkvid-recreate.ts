/**
 * "Delete and recreate" (spec decision 25): render a set mkvid already
 * uploaded again — in practice, to replace an old-style (static waveform)
 * video with the scene visualizer — and retire the old video.
 *
 *   done ──recreate──▶ pending (back of the queue, `replaces_video_id` = old video)
 *        ──claim/complete as usual──▶ done with the new video, then:
 *          1. the new video is added to the artist + combined playlists
 *             (completeMkvidRequest, as for any upload);
 *          2. the old one is removed from both playlists (retireReplacedVideo);
 *          3. a `mkvid_old_videos` row asks mkvid to delete it from YouTube
 *             (POST <MKVID_URL>/api/videos/<id>/delete) — right after the
 *             completion, and again from the cron with a backoff until it
 *             works; the panel lists the ones still waiting.
 *
 * The old video stays on YouTube and in the playlists until the new one is
 * delivered. A recreation is an ordinary request: it needs a verified list,
 * waits for IDs like any other, and its claim counts against the daily cap.
 *
 * mkvid_requests keeps one row per set (set_url is UNIQUE), so a recreation
 * resets the row in place rather than adding one. The old video id is also
 * written to `mkvid_old_videos` (state `awaiting_replacement`) the moment
 * Recreate is pressed, so no later path can lose it: it becomes `pending`
 * (delete it) when the new video is in, or when the set is superseded by an
 * official recording, and leaves the table's to-do list only on a confirmed
 * delete. Only an mkvid that renders `scene` is handed a recreation.
 */

import { markOutOfPlaylist } from './playlist-blocklist'
import type { Env } from '../types'
import { dbOf } from './db'
import { errorFields, type Logger } from './log'
import { openCombinedPlaylist, removeFromCombined, type CombinedHandle } from './combined-playlist'
import { cachePlaylistVideoIds } from './playlist-cache'
import { listPlaylistVideoIds, removeVideoFromPlaylist } from './youtube-playlists'

const nowSeconds = () => Math.floor(Date.now() / 1000)

/** The style every video should have; anything else (or unknown) is "old style". */
export const CURRENT_STYLE = 'scene'
/** A recreation is only claimed by an mkvid that says (claim body `style`) it renders this. */
export const RECREATE_STYLE = CURRENT_STYLE
export const isOldStyle = (style: string | null | undefined): boolean => style !== CURRENT_STYLE

/** Sort key just behind the last pending request (or behind today, when the queue is empty). */
async function backOfQueueKey(env: Env): Promise<number> {
  const r = await dbOf(env).prepare("SELECT MIN(sort_key) AS k FROM mkvid_requests WHERE status = 'pending'").first<{ k: number | null }>()
  const julianNow = Date.now() / 86_400_000 + 2_440_587.5
  return (r?.k ?? julianNow) - 1
}

export type RecreateResult = { ok: true; id: string; replacesVideoId: string } | { ok: false; error: 'not_found' | 'not_done' | 'no_video' | 'already_recreating' }

/**
 * Queue one done request again, behind everything pending. The old video id
 * is remembered in `replaces_video_id`; `video_id` keeps pointing at it until
 * the new upload arrives (so /now-playing still finds it meanwhile).
 */
export async function recreateMkvidRequest(env: Env, id: string, log: Logger): Promise<RecreateResult> {
  const db = dbOf(env)
  const row = await db
    .prepare('SELECT status, video_id, replaces_video_id FROM mkvid_requests WHERE id = ?')
    .bind(id)
    .first<{ status: string; video_id: string | null; replaces_video_id: string | null }>()
  if (!row) return { ok: false, error: 'not_found' }
  if (row.status !== 'done') return { ok: false, error: 'not_done' }
  if (!row.video_id) return { ok: false, error: 'no_video' }
  if (row.replaces_video_id) return { ok: false, error: 'already_recreating' }
  const r = await db
    .prepare(
      `UPDATE mkvid_requests SET status = 'pending', replaces_video_id = video_id, sort_key = ?, attempts = 0, not_before = NULL,
         claimed_at = NULL, job_id = NULL, error = NULL, updated_at = ?
       WHERE id = ? AND status = 'done' AND video_id IS NOT NULL AND replaces_video_id IS NULL`,
    )
    .bind(await backOfQueueKey(env), nowSeconds(), id)
    .run()
  if ((r.meta.changes ?? 0) === 0) return { ok: false, error: 'not_done' }
  await recordAwaitingOldVideos(env, [id])
  log.info('mkvid.recreate_queued', { id, replacesVideoId: row.video_id })
  return { ok: true, id, replacesVideoId: row.video_id }
}

/** Done requests whose video is not the current style (unknown counts as old), not already being recreated. */
const OLD_STYLE_WHERE = `status = 'done' AND video_id IS NOT NULL AND replaces_video_id IS NULL AND (style IS NULL OR style <> '${CURRENT_STYLE}')`

export async function countOldStyleVideos(env: Env): Promise<number> {
  const r = await dbOf(env).prepare(`SELECT COUNT(*) AS n FROM mkvid_requests WHERE ${OLD_STYLE_WHERE}`).first<{ n: number }>()
  return Number(r?.n ?? 0)
}

/**
 * Bulk "Recreate all old-style videos": every matching done request goes to
 * the back of the queue, keeping their relative order (newest set first).
 * `expect` is the count the owner confirmed; when it no longer matches, nothing
 * is queued and the fresh count is returned so the confirm step can be shown
 * again.
 */
export async function recreateOldStyleVideos(
  env: Env,
  expect: number,
  log: Logger,
): Promise<{ ok: true; queued: number } | { ok: false; error: 'count_changed'; count: number }> {
  const db = dbOf(env)
  const rows = await db
    .prepare(`SELECT id FROM mkvid_requests WHERE ${OLD_STYLE_WHERE} ORDER BY sort_key DESC, created_at DESC, rowid ASC`)
    .all<{ id: string }>()
  if (rows.results.length !== expect) return { ok: false, error: 'count_changed', count: rows.results.length }
  const base = await backOfQueueKey(env)
  const now = nowSeconds()
  const stmts = rows.results.map((r, i) =>
    db
      .prepare(
        `UPDATE mkvid_requests SET status = 'pending', replaces_video_id = video_id, sort_key = ?, attempts = 0, not_before = NULL,
           claimed_at = NULL, job_id = NULL, error = NULL, updated_at = ?
         WHERE id = ? AND ${OLD_STYLE_WHERE}`,
      )
      .bind(base - i * 1e-3, now, r.id),
  )
  // D1 batches are one transaction; chunked so a big backlog stays under the statement limit.
  let queued = 0
  for (let i = 0; i < stmts.length; i += 50) {
    const res = await db.batch(stmts.slice(i, i + 50))
    for (const x of res) queued += x.meta.changes ?? 0
  }
  await recordAwaitingOldVideos(env, rows.results.map((r) => r.id))
  log.info('mkvid.recreate_old_style_queued', { queued })
  return { ok: true, queued }
}

/** Put the old video of each recreation on record (awaiting its replacement); a row already there is kept. */
async function recordAwaitingOldVideos(env: Env, requestIds: string[]): Promise<void> {
  const db = dbOf(env)
  const now = nowSeconds()
  const stmt = `INSERT INTO mkvid_old_videos (video_id, request_id, slug, set_url, style, replaced_by, state, attempts, next_try_at, created_at, updated_at)
                SELECT replaces_video_id, id, slug, set_url, style, '', 'awaiting_replacement', 0, 0, ?, ?
                  FROM mkvid_requests WHERE id = ? AND replaces_video_id IS NOT NULL
                ON CONFLICT(video_id) DO NOTHING`
  for (let i = 0; i < requestIds.length; i += 50) await db.batch(requestIds.slice(i, i + 50).map((id) => db.prepare(stmt).bind(now, now, id)))
}

/** Mark a recorded old video for deletion (from awaiting_replacement, or insert it). `delaySeconds` holds the delete back. */
async function markOldVideoForDelete(
  env: Env,
  a: { requestId: string; slug: string; setUrl: string; oldVideoId: string; oldStyle: string | null; replacedBy: string; delaySeconds?: number },
): Promise<void> {
  const now = nowSeconds()
  const at = now + (a.delaySeconds ?? 0)
  await dbOf(env)
    .prepare(
      `INSERT INTO mkvid_old_videos (video_id, request_id, slug, set_url, style, replaced_by, state, attempts, next_try_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
       ON CONFLICT(video_id) DO UPDATE SET state = 'pending', replaced_by = excluded.replaced_by, next_try_at = excluded.next_try_at, updated_at = excluded.updated_at
         WHERE mkvid_old_videos.state = 'awaiting_replacement'`,
    )
    .bind(a.oldVideoId, a.requestId, a.slug, a.setUrl, a.oldStyle, a.replacedBy, at, now, now)
    .run()
}

/**
 * The set was superseded while a recreation was under way (an official
 * recording, or the old video already gone from the set): the old mkvid video
 * still comes out of both playlists (the sync's swap usually did that
 * already; every step here is a no-op then) and is queued for deletion.
 * Best-effort on the playlists; the delete record is always written.
 */
export async function retireSupersededOldVideo(
  env: Env,
  a: { requestId: string; slug: string; setUrl: string; oldVideoId: string; replacedBy: string; accessToken: string | null; log: Logger; combined?: CombinedHandle | null },
): Promise<void> {
  const db = dbOf(env)
  if (a.accessToken) {
    try {
      const pl = await db.prepare('SELECT playlist_id FROM sub_sync WHERE slug = ?').bind(a.slug).first<{ playlist_id: string | null }>()
      if (pl?.playlist_id) {
        const ids = await listPlaylistVideoIds(pl.playlist_id, a.accessToken)
        if (ids.has(a.oldVideoId)) {
          await removeVideoFromPlaylist(pl.playlist_id, a.oldVideoId, a.accessToken)
          ids.delete(a.oldVideoId)
        }
        await cachePlaylistVideoIds(env, pl.playlist_id, ids)
      }
      const combined = a.combined ?? (await openCombinedPlaylist(env, a.accessToken, a.log))
      if (combined) await removeFromCombined(combined, a.oldVideoId, a.accessToken, a.log)
    } catch (e) {
      a.log.warn('mkvid.recreate_superseded_remove_failed', { id: a.requestId, oldVideoId: a.oldVideoId, ...errorFields(e) })
    }
  }
  const style = (await db.prepare('SELECT style FROM mkvid_old_videos WHERE video_id = ?').bind(a.oldVideoId).first<{ style: string | null }>())?.style ?? null
  await markOldVideoForDelete(env, { requestId: a.requestId, slug: a.slug, setUrl: a.setUrl, oldVideoId: a.oldVideoId, oldStyle: style, replacedBy: a.replacedBy })
  a.log.info('mkvid.recreate_superseded_old_retired', { id: a.requestId, oldVideoId: a.oldVideoId, replacedBy: a.replacedBy })
}

/**
 * An upload finished for a request that was banned while it rendered: the
 * video never enters a playlist and is queued for deletion from YouTube.
 */
export async function queueBannedUploadForDelete(
  env: Env,
  a: { requestId: string; slug: string; setUrl: string; videoId: string; style: string | null },
): Promise<void> {
  await markOldVideoForDelete(env, { requestId: a.requestId, slug: a.slug, setUrl: a.setUrl, oldVideoId: a.videoId, oldStyle: a.style, replacedBy: 'banned' })
}

/**
 * Supersede without a YouTube token (the sync noticing an official recording,
 * the claim finding one): the sync's recheck swap has already taken the old
 * mkvid video out of the playlists; queue its deletion.
 */
export async function queueSupersededOldVideo(env: Env, requestId: string, replacedBy: string): Promise<void> {
  const r = await dbOf(env)
    .prepare('SELECT slug, set_url, replaces_video_id FROM mkvid_requests WHERE id = ?')
    .bind(requestId)
    .first<{ slug: string; set_url: string; replaces_video_id: string | null }>()
  if (!r?.replaces_video_id) return
  await markOldVideoForDelete(env, { requestId, slug: r.slug, setUrl: r.set_url, oldVideoId: r.replaces_video_id, oldStyle: null, replacedBy })
}

// ─── retiring the replaced video ────────────────────────────────────────────

/**
 * The new video is in the playlists: take the old one out of the artist and
 * combined playlists and record it for deletion from YouTube. An artist
 * playlist removal that fails throws, which fails the completion (mkvid
 * redelivers it and every step runs again, the done ones as no-ops); the
 * combined removal is best-effort like the sync's.
 */
export async function retireReplacedVideo(
  env: Env,
  a: {
    requestId: string
    slug: string
    setUrl: string
    oldVideoId: string
    oldStyle: string | null
    newVideoId: string
    playlistId: string
    playlistVideoIds: Set<string>
    combined: CombinedHandle | null
    /** false = the new video did not make it into the combined playlist: hold the delete back 6 h (the backfill adds it meanwhile). */
    combinedOk?: boolean
    accessToken: string
    log: Logger
  },
): Promise<{ removedFromArtist: number; removedFromCombined: number }> {
  let removedFromArtist = 0
  // The cached listing can be stale: look again before concluding the old video is not there.
  if (!a.playlistVideoIds.has(a.oldVideoId)) {
    try {
      const fresh = await listPlaylistVideoIds(a.playlistId, a.accessToken)
      for (const id of fresh) a.playlistVideoIds.add(id)
    } catch (e) {
      a.log.warn('mkvid.recreate_relist_failed', { id: a.requestId, playlistId: a.playlistId, ...errorFields(e) })
    }
  }
  if (a.playlistVideoIds.has(a.oldVideoId)) {
    removedFromArtist = await removeVideoFromPlaylist(a.playlistId, a.oldVideoId, a.accessToken)
    await markOutOfPlaylist(env, a.playlistId, a.oldVideoId, 'recreate')
    a.playlistVideoIds.delete(a.oldVideoId)
    await cachePlaylistVideoIds(env, a.playlistId, a.playlistVideoIds)
  }
  let removedFromCombined = 0
  if (a.combined) {
    try {
      removedFromCombined = await removeFromCombined(a.combined, a.oldVideoId, a.accessToken, a.log)
    } catch (e) {
      a.log.warn('mkvid.recreate_combined_remove_failed', { id: a.requestId, oldVideoId: a.oldVideoId, ...errorFields(e) })
    }
  }
  await markOldVideoForDelete(env, {
    requestId: a.requestId,
    slug: a.slug,
    setUrl: a.setUrl,
    oldVideoId: a.oldVideoId,
    oldStyle: a.oldStyle,
    replacedBy: a.newVideoId,
    delaySeconds: a.combinedOk === false ? 6 * 3600 : 0,
  })
  a.log.info('mkvid.recreate_retired', { id: a.requestId, oldVideoId: a.oldVideoId, newVideoId: a.newVideoId, removedFromArtist, removedFromCombined })
  return { removedFromArtist, removedFromCombined }
}

// ─── asking mkvid to delete ─────────────────────────────────────────────────

export type OldVideoState = 'awaiting_replacement' | 'pending' | 'deleted' | 'refused'
export type OldVideo = {
  videoId: string
  requestId: string
  slug: string
  setUrl: string
  style: string | null
  replacedBy: string
  state: OldVideoState
  attempts: number
  nextTryAt: number
  lastError: string | null
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

type OldRow = {
  video_id: string
  request_id: string
  slug: string
  set_url: string
  style: string | null
  replaced_by: string
  state: string
  attempts: number
  next_try_at: number
  last_error: string | null
  created_at: number
  updated_at: number
  deleted_at: number | null
}

const toOld = (r: OldRow): OldVideo => ({
  videoId: r.video_id,
  requestId: r.request_id,
  slug: r.slug,
  setUrl: r.set_url,
  style: r.style,
  replacedBy: r.replaced_by,
  state: r.state as OldVideoState,
  attempts: Number(r.attempts),
  nextTryAt: Number(r.next_try_at),
  lastError: r.last_error,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
  deletedAt: r.deleted_at,
})

/** Backoff after `attempts` failed deletes: 10 min doubling, at most 6 h. Never gives up. */
export function deleteBackoffSeconds(attempts: number): number {
  return Math.min(6 * 3600, 600 * 2 ** Math.max(0, attempts - 1))
}

/** mkvid's answers that mean "this video is not mine to delete" — retrying cannot change them. */
const REFUSALS = new Set(['unknown_video', 'not_tracked', 'request_mismatch'])

export type DeleteCallOutcome = { kind: 'deleted' } | { kind: 'already_gone' } | { kind: 'refused'; error: string } | { kind: 'retry'; error: string }

/**
 * One call to mkvid's delete route. mkvid sits behind Cloudflare Access: when
 * MKVID_ACCESS_CLIENT_ID / _SECRET (an Access service token) are set they are
 * sent too, otherwise the tunnel's Access app needs a bypass for
 * /api/videos/*. The bearer is MKVID_TOKEN (mkvid's TRACKED_TOKEN).
 */
export async function callMkvidDelete(env: Env, videoId: string, requestId: string, fetcher: typeof fetch = fetch): Promise<DeleteCallOutcome> {
  const base = (env.MKVID_URL ?? '').trim().replace(/\/$/, '')
  if (!base || !env.MKVID_TOKEN) return { kind: 'retry', error: 'MKVID_URL / MKVID_TOKEN not set' }
  const headers: Record<string, string> = { authorization: `Bearer ${env.MKVID_TOKEN}`, 'content-type': 'application/json' }
  if (env.MKVID_ACCESS_CLIENT_ID && env.MKVID_ACCESS_CLIENT_SECRET) {
    headers['cf-access-client-id'] = env.MKVID_ACCESS_CLIENT_ID
    headers['cf-access-client-secret'] = env.MKVID_ACCESS_CLIENT_SECRET
  }
  let res: Response
  try {
    res = await fetcher(`${base}/api/videos/${encodeURIComponent(videoId)}/delete`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ requestId }),
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    })
  } catch (e) {
    return { kind: 'retry', error: `mkvid unreachable: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) }
  }
  const text = await res.text().catch(() => '')
  let body: { ok?: boolean; outcome?: string; error?: string; message?: string } = {}
  try {
    body = JSON.parse(text)
  } catch {
    // An Access login page or a tunnel error: not mkvid talking.
  }
  if (res.ok && body.ok && body.outcome === 'deleted') return { kind: 'deleted' }
  if (res.ok && body.ok && body.outcome === 'already_gone') return { kind: 'already_gone' }
  if (body.error && REFUSALS.has(body.error)) return { kind: 'refused', error: `${body.error}${body.message ? `: ${body.message}` : ''}`.slice(0, 300) }
  return { kind: 'retry', error: `HTTP ${res.status}${body.error ? ` ${body.error}` : ''}${body.message ? `: ${body.message}` : text && !body.error ? `: ${text.slice(0, 120)}` : ''}`.slice(0, 300) }
}

/** One delete attempt for a recorded old video; updates its row. */
export async function deleteOldVideo(env: Env, videoId: string, log: Logger, fetcher: typeof fetch = fetch, opts: { dueOnly?: boolean } = {}): Promise<OldVideo | null> {
  const db = dbOf(env)
  const row = await db.prepare('SELECT * FROM mkvid_old_videos WHERE video_id = ?').bind(videoId).first<OldRow>()
  if (!row) return null
  if (row.state !== 'pending') return toOld(row)
  // Held back on purpose (the new video missed the combined playlist): the cron takes it when due.
  if (opts.dueOnly && Number(row.next_try_at) > nowSeconds()) return toOld(row)
  const r = await callMkvidDelete(env, videoId, row.request_id, fetcher)
  const now = nowSeconds()
  const attempts = Number(row.attempts) + 1
  if (r.kind === 'deleted' || r.kind === 'already_gone') {
    await db
      .prepare("UPDATE mkvid_old_videos SET state = 'deleted', attempts = ?, last_error = ?, deleted_at = ?, updated_at = ? WHERE video_id = ?")
      .bind(attempts, r.kind === 'already_gone' ? 'already gone from YouTube' : null, now, now, videoId)
      .run()
    log.info('mkvid.old_video_deleted', { videoId, requestId: row.request_id, outcome: r.kind, attempts })
  } else if (r.kind === 'refused') {
    await db
      .prepare("UPDATE mkvid_old_videos SET state = 'refused', attempts = ?, last_error = ?, updated_at = ? WHERE video_id = ?")
      .bind(attempts, r.error, now, videoId)
      .run()
    log.warn('mkvid.old_video_refused', { videoId, requestId: row.request_id, error: r.error })
  } else {
    await db
      .prepare('UPDATE mkvid_old_videos SET attempts = ?, last_error = ?, next_try_at = ?, updated_at = ? WHERE video_id = ?')
      .bind(attempts, r.error, now + deleteBackoffSeconds(attempts), now, videoId)
      .run()
    log.warn('mkvid.old_video_delete_failed', { videoId, requestId: row.request_id, attempts, error: r.error })
  }
  return toOld((await db.prepare('SELECT * FROM mkvid_old_videos WHERE video_id = ?').bind(videoId).first<OldRow>())!)
}

/** Cron: retry the deletes that are due (a few per tick). Never throws. */
export async function retryDueOldVideoDeletions(env: Env, log: Logger, limit = 5, fetcher: typeof fetch = fetch): Promise<{ tried: number; deleted: number }> {
  let tried = 0
  let deleted = 0
  try {
    const due = await dbOf(env)
      .prepare("SELECT video_id FROM mkvid_old_videos WHERE state = 'pending' AND next_try_at <= ? ORDER BY next_try_at LIMIT ?")
      .bind(nowSeconds(), limit)
      .all<{ video_id: string }>()
    for (const d of due.results) {
      tried += 1
      const r = await deleteOldVideo(env, d.video_id, log, fetcher)
      if (r?.state === 'deleted') deleted += 1
    }
  } catch (e) {
    log.warn('mkvid.old_video_retry_threw', errorFields(e))
  }
  return { tried, deleted }
}

/** Old videos not yet deleted (pending, refused), newest first — the panel's "to delete" list. */
export async function listUndeletedOldVideos(env: Env, limit = 50): Promise<OldVideo[]> {
  const res = await dbOf(env)
    .prepare("SELECT * FROM mkvid_old_videos WHERE state IN ('pending', 'refused') ORDER BY created_at DESC LIMIT ?")
    .bind(limit)
    .all<OldRow>()
  return res.results.map(toOld)
}

/** Panel: try a pending (or refused) delete again on the next cron tick, or right now via deleteOldVideo. */
export async function resetOldVideoDelete(env: Env, videoId: string): Promise<boolean> {
  const r = await dbOf(env)
    .prepare("UPDATE mkvid_old_videos SET state = 'pending', next_try_at = 0, updated_at = ? WHERE video_id = ? AND state IN ('pending', 'refused')")
    .bind(nowSeconds(), videoId)
    .run()
  return (r.meta.changes ?? 0) > 0
}

/** The replaced video id of a request mid-recreation (or null). */
export async function replacedVideoOf(env: Env, requestId: string): Promise<string | null> {
  const r = await dbOf(env).prepare('SELECT replaces_video_id FROM mkvid_requests WHERE id = ?').bind(requestId).first<{ replaces_video_id: string | null }>()
  return r?.replaces_video_id ?? null
}
