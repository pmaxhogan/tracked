/**
 * "Never re-add" state for the managed playlists (migrations/0008):
 *
 *   - `removed_videos`   a video the owner removed from a playlist by hand,
 *                        one that died, or one taken out with "remove and
 *                        replace". Per playlist.
 *   - `playlist_members` the last complete listing of the combined playlist.
 *                        An id that was there and is gone now was removed by
 *                        someone; the combined backfill must not put it back
 *                        before the 6-hourly comparison records it.
 *   - `video_overrides`  the owner's undo: the full-recording rule is not
 *                        applied to that video again.
 *
 * Only depends on the D1 helpers, so combined-playlist.ts and sync.ts can both
 * import it without a cycle through lib/playlist-hygiene.ts.
 */

import type { Env } from '../types'
import { batchChunked, dbOf } from './db'

export type RemovedReason = 'owner' | 'dead' | 'button'

const nowSeconds = () => Math.floor(Date.now() / 1000)

/** Video ids that must never be (re-)added to `playlistId`. */
export async function blockedIds(env: Env, playlistId: string): Promise<Set<string>> {
  const res = await dbOf(env).prepare('SELECT video_id FROM removed_videos WHERE playlist_id = ?').bind(playlistId).all<{ video_id: string }>()
  return new Set(res.results.map((r) => r.video_id))
}

export async function isBlocked(env: Env, playlistId: string, videoId: string): Promise<boolean> {
  const row = await dbOf(env)
    .prepare('SELECT 1 AS x FROM removed_videos WHERE playlist_id = ? AND video_id = ?')
    .bind(playlistId, videoId)
    .first<{ x: number }>()
  return !!row
}

export async function recordRemoved(
  env: Env,
  r: { playlistId: string; videoId: string; slug: string | null; setUrl: string | null; reason: RemovedReason; at?: number },
): Promise<void> {
  await dbOf(env)
    .prepare(
      `INSERT INTO removed_videos (playlist_id, video_id, slug, set_url, reason, at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(playlist_id, video_id) DO NOTHING`,
    )
    .bind(r.playlistId, r.videoId, r.slug, r.setUrl, r.reason, r.at ?? nowSeconds())
    .run()
}

export async function unblock(env: Env, playlistId: string, videoId: string): Promise<void> {
  await dbOf(env).prepare('DELETE FROM removed_videos WHERE playlist_id = ? AND video_id = ?').bind(playlistId, videoId).run()
}

/** Last complete listing of `playlistId`, as recorded by the comparison. */
export async function playlistMembers(env: Env, playlistId: string): Promise<Set<string>> {
  const res = await dbOf(env).prepare('SELECT video_id FROM playlist_members WHERE playlist_id = ?').bind(playlistId).all<{ video_id: string }>()
  return new Set(res.results.map((r) => r.video_id))
}

/** Replace the recorded listing of `playlistId` with `present` (diff-only writes). */
export async function savePlaylistMembers(env: Env, playlistId: string, present: ReadonlySet<string>, at = nowSeconds()): Promise<void> {
  const db = dbOf(env)
  const before = await playlistMembers(env, playlistId)
  const stmts: D1PreparedStatement[] = []
  for (const id of before) if (!present.has(id)) stmts.push(db.prepare('DELETE FROM playlist_members WHERE playlist_id = ? AND video_id = ?').bind(playlistId, id))
  for (const id of present) if (!before.has(id)) stmts.push(db.prepare('INSERT OR IGNORE INTO playlist_members (playlist_id, video_id, seen_at) VALUES (?, ?, ?)').bind(playlistId, id, at))
  await batchChunked(db, stmts)
}

/**
 * Ids the combined playlist must not receive: blocked for it, or seen in it
 * at the last complete listing and absent from `current` now (removed since;
 * the comparison decides whether by the owner or because it died).
 */
export async function combinedSkipIds(env: Env, combinedPlaylistId: string, current: ReadonlySet<string>): Promise<Set<string>> {
  const skip = await blockedIds(env, combinedPlaylistId)
  for (const id of await playlistMembers(env, combinedPlaylistId)) if (!current.has(id)) skip.add(id)
  return skip
}

/** Single-id form of `combinedSkipIds`, for the sync's live mirror. */
export async function combinedRefuses(env: Env, combinedPlaylistId: string, videoId: string, current: ReadonlySet<string>): Promise<boolean> {
  if (current.has(videoId)) return false
  if (await isBlocked(env, combinedPlaylistId, videoId)) return true
  const row = await dbOf(env)
    .prepare('SELECT 1 AS x FROM playlist_members WHERE playlist_id = ? AND video_id = ?')
    .bind(combinedPlaylistId, videoId)
    .first<{ x: number }>()
  return !!row
}

export async function overriddenIds(env: Env): Promise<Set<string>> {
  const res = await dbOf(env).prepare('SELECT video_id FROM video_overrides WHERE allow = 1').all<{ video_id: string }>()
  return new Set(res.results.map((r) => r.video_id))
}

export async function isOverridden(env: Env, videoId: string): Promise<boolean> {
  const row = await dbOf(env).prepare('SELECT 1 AS x FROM video_overrides WHERE video_id = ? AND allow = 1').bind(videoId).first<{ x: number }>()
  return !!row
}

export async function setOverride(env: Env, videoId: string, at = nowSeconds()): Promise<void> {
  await dbOf(env)
    .prepare('INSERT INTO video_overrides (video_id, allow, at) VALUES (?, 1, ?) ON CONFLICT(video_id) DO UPDATE SET allow = 1, at = excluded.at')
    .bind(videoId, at)
    .run()
}
