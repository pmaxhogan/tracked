/**
 * The I/O half of playlist ordering (the rules are in lib/playlist-order.ts):
 * where the order keys come from, and the one insert every playlist addition
 * goes through.
 *
 * Nothing new is stored. A video's key is derived from the URL of the set
 * that resolves to it (`tracklists.url` + `video_id`), and the position of an
 * insert is counted from the playlist's membership, which every call site
 * already holds (the `yt:plvids:` snapshot). `playlist_confirmed`,
 * `playlist_members` and that snapshot record WHICH videos are in a playlist,
 * never where, so a positioned insert or a move leaves all three correct.
 */

import type { Env } from '../types'
import { dbOf } from './db'
import { errorFields, type Logger } from './log'
import { compareOrder, insertPosition, orderKeyOfSet, orderKeysByVideo, UNDATED, type OrderKey } from './playlist-order'
import { addVideoToPlaylist, YouTubeApiError } from './youtube-playlists'

export type OrderKeys = Map<string, OrderKey>

/** Holds the keys for the length of one run, so a run with several inserts reads D1 once. */
export type OrderKeyCache = { keys?: OrderKeys }

/** Order key of every video a tracked set resolves to (one D1 read, about 1 300 rows in October 2026). */
export async function loadOrderKeys(env: Env): Promise<OrderKeys> {
  const res = await dbOf(env).prepare('SELECT url, video_id FROM tracklists WHERE video_id IS NOT NULL').all<{ url: string; video_id: string }>()
  return orderKeysByVideo(res.results.map((r) => ({ url: r.url, videoId: r.video_id })))
}

/** The key of `videoId`: the set it is being added for (its `tracklists` row may not carry the video yet), else what D1 knows. */
export function orderKeyFor(keys: OrderKeys, videoId: string, setUrl?: string | null): OrderKey {
  const known = keys.get(videoId) ?? UNDATED
  const given = setUrl ? orderKeyOfSet(setUrl) : UNDATED
  if (given.date === null) return known
  return known.date !== null && compareOrder(known, given) < 0 ? known : given
}

/**
 * `playlistItems.insert` at the place the video's set date gives it among
 * `existing` (the video ids in the playlist now). The same 50 units as an
 * insert at the end.
 *
 *   - An undated video, or one that belongs last, is appended: the call is
 *     then exactly the one made before ordering existed.
 *   - YouTube answers 400 for a position past the end (the snapshot counted a
 *     video the owner has since removed) and for a playlist that is not on
 *     manual order. A positioned insert that gets a 400 is therefore tried
 *     once more without a position, so ordering can never keep a video out;
 *     the reorder pass (lib/playlist-reorder.ts) puts it right later. A 400
 *     that was about the video fails the second time too and is thrown as before.
 *   - Keys that cannot be read (a D1 error) mean an append, never a failure.
 *
 * `attempts` = insert calls made, for callers that budget them.
 */
export async function insertInOrder(
  env: Env,
  a: {
    playlistId: string
    videoId: string
    existing: Iterable<string>
    accessToken: string
    log: Logger
    /** The set this video is added for. */
    setUrl?: string | null
    cache?: OrderKeyCache
    fetcher?: typeof fetch
  },
): Promise<{ position: number | null; attempts: number }> {
  let position: number | null = null
  try {
    const keys = a.cache?.keys ?? (await loadOrderKeys(env))
    if (a.cache) a.cache.keys = keys
    const entry = orderKeyFor(keys, a.videoId, a.setUrl)
    const others: OrderKey[] = []
    for (const id of a.existing) if (id !== a.videoId) others.push(keys.get(id) ?? UNDATED)
    position = insertPosition(others, entry)
  } catch (e) {
    a.log.warn('playlist_order.keys_unreadable', { playlistId: a.playlistId, videoId: a.videoId, ...errorFields(e) })
  }
  // An append is the call exactly as it was before ordering existed.
  const append = () => (a.fetcher ? addVideoToPlaylist(a.playlistId, a.videoId, a.accessToken, a.fetcher) : addVideoToPlaylist(a.playlistId, a.videoId, a.accessToken))
  if (position === null) {
    await append()
    return { position: null, attempts: 1 }
  }
  try {
    await addVideoToPlaylist(a.playlistId, a.videoId, a.accessToken, a.fetcher, { position })
    return { position, attempts: 1 }
  } catch (e) {
    if (!(e instanceof YouTubeApiError) || e.status !== 400) throw e
    a.log.warn('playlist_order.position_refused', { playlistId: a.playlistId, videoId: a.videoId, position, reason: e.reason })
    await append()
    return { position: null, attempts: 2 }
  }
}
