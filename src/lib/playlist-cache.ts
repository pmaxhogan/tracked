/**
 * Shared YouTube-playlist plumbing for the sync: a KV-cached snapshot of a
 * playlist's videoId set, plus the find-or-create resolver.
 *
 * Both the per-artist sync (lib/sync.ts) and the combined "all tracked
 * artists" playlist (lib/combined-playlist.ts) need identical behaviour here,
 * and the combined backfill reads *every* artist playlist on every run — so
 * the cache is what keeps that read cheap.
 */

import type { Env } from '../types'
import { getJson, putJson, TTL } from './cache'
import { createPlaylist, findPlaylistByTitle, listPlaylistVideoIds } from './youtube-playlists'
import type { Logger } from './log'

const PLAYLIST_VIDEO_IDS_PREFIX = 'yt:plvids:'

/**
 * Cached wrapper around `listPlaylistVideoIds`. The 5-min drain-pending cron
 * calls this for every sub with pending work (and, since the combined playlist
 * landed, for every artist playlist on every tick); without a cache it costs 1
 * YT quota unit per playlist page per tick (~3 000 units/day for a few subs
 * with mid-sized playlists, all of it wasted because nothing changed since the
 * previous tick). The cache is invalidated by writing back the updated set
 * after every insert (see `cachePlaylistVideoIds`), so it only goes stale if
 * the user edits the playlist directly on YouTube — in which case the 6h TTL
 * reconciles eventually.
 */
export async function getCachedPlaylistVideoIds(
  env: Env,
  playlistId: string,
  accessToken: string,
  log: Logger,
): Promise<Set<string>> {
  const key = `${PLAYLIST_VIDEO_IDS_PREFIX}${playlistId}`
  const cached = await getJson<{ videoIds: string[] }>(env.CACHE, key)
  if (cached) {
    log.info('sync.playlist_video_ids.cache_hit', { playlistId, count: cached.videoIds.length })
    return new Set(cached.videoIds)
  }
  log.info('sync.playlist_video_ids.cache_miss', { playlistId })
  const ids = await listPlaylistVideoIds(playlistId, accessToken)
  await cachePlaylistVideoIds(env, playlistId, ids)
  return ids
}

export async function cachePlaylistVideoIds(env: Env, playlistId: string, ids: Set<string>): Promise<void> {
  const key = `${PLAYLIST_VIDEO_IDS_PREFIX}${playlistId}`
  await putJson(env.CACHE, key, { videoIds: [...ids] }, TTL.PLAYLIST_VIDEO_IDS)
}

/**
 * Resolve a playlist by title — find an existing one with that exact title on
 * the user's channel, or create a fresh public playlist. Used on first sync
 * and as the recovery path when cached state references a deleted playlist.
 *
 * `justCreated` matters to callers: YouTube's read API takes a few seconds to
 * see a freshly-created playlist, so listing it right away 404s with
 * playlistNotFound even though the id is valid. A new playlist is empty by
 * definition, so known-empty is the right baseline and the list call is skipped.
 *
 * With `create: false` the function never writes — it returns null when no
 * playlist with that title exists. Read-only status endpoints use that so
 * merely opening the admin panel can't conjure a playlist.
 */
export async function findOrCreatePlaylist(
  opts: {
    title: string
    description: string
    create?: boolean
    /** Extra fields for the two log lines (e.g. `{ slug }`). */
    logCtx?: Record<string, unknown>
  },
  accessToken: string,
  log: Logger,
): Promise<{ id: string; justCreated: boolean } | null> {
  const ctx = opts.logCtx ?? {}
  const existing = await findPlaylistByTitle(opts.title, accessToken)
  if (existing) {
    log.info('sync.playlist_found', { ...ctx, playlistId: existing.id, title: opts.title })
    return { id: existing.id, justCreated: false }
  }
  if (opts.create === false) return null
  const created = await createPlaylist(
    { title: opts.title, description: opts.description, privacyStatus: 'public' },
    accessToken,
  )
  log.info('sync.playlist_created', { ...ctx, playlistId: created.id, title: opts.title })
  return { id: created.id, justCreated: true }
}
