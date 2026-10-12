/**
 * The I/O half of playlist ordering (the rules are in lib/playlist-order.ts):
 * where the order keys come from, and the one insert every addition to an
 * artist playlist goes through. The combined playlist is not ordered (it is
 * the one for shuffling): its inserts are plain appends in
 * lib/combined-playlist.ts, untouched by any of this.
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
import { loadCombinedState } from './combined-playlist'

/**
 * "YouTube refuses positions for this playlist" (`manualSortRequired`: it is
 * set to sort by date or popularity), in CACHE. While it holds, inserts into
 * that playlist skip positioning instead of paying for a refused insert and
 * then an append, 100 units, every time. It lapses after a day, so one insert
 * a day finds out whether the owner has switched the playlist back to Manual;
 * Check now and Retry now on the Playlists card clear it at once.
 */
const NOT_MANUAL_PREFIX = 'yt:order:notmanual:'
const NOT_MANUAL_TTL = 24 * 60 * 60

export async function isNotManual(env: Env, playlistId: string): Promise<boolean> {
  return (await env.CACHE.get(`${NOT_MANUAL_PREFIX}${playlistId}`)) !== null
}

export async function noteNotManual(env: Env, playlistId: string): Promise<void> {
  await env.CACHE.put(`${NOT_MANUAL_PREFIX}${playlistId}`, '1', { expirationTtl: NOT_MANUAL_TTL })
}

export async function clearNotManual(env: Env, playlistId: string): Promise<void> {
  await env.CACHE.delete(`${NOT_MANUAL_PREFIX}${playlistId}`)
}

export type OrderKeys = Map<string, OrderKey>

/**
 * Holds what an insert has to look up for the length of one run, so a run with
 * several inserts reads each once: the keys (D1), the combined playlist's id
 * (SUBS) and, per playlist, whether YouTube refuses positions for it (CACHE).
 */
export type OrderKeyCache = { keys?: OrderKeys; combinedId?: string | null; notManual?: Map<string, boolean> }

/**
 * Positions are never sent for the combined playlist (it is not ordered), nor
 * for one YouTube refuses them for. Unreadable = position as usual (and not
 * remembered in `cache`, so the next insert asks again).
 */
async function positioningOff(env: Env, playlistId: string, cache?: OrderKeyCache): Promise<'combined' | 'not_manual' | null> {
  try {
    let combinedId = cache?.combinedId
    if (combinedId === undefined) {
      combinedId = (await loadCombinedState(env)).playlistId ?? null
      if (cache) cache.combinedId = combinedId
    }
    if (combinedId === playlistId) return 'combined'
    let notManual = cache?.notManual?.get(playlistId)
    if (notManual === undefined) {
      notManual = await isNotManual(env, playlistId)
      if (cache) (cache.notManual ??= new Map()).set(playlistId, notManual)
    }
    return notManual ? 'not_manual' : null
  } catch {
    return null
  }
}

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
 *   - `manualSortRequired` is remembered for a day (`noteNotManual`): until
 *     then inserts into that playlist are appended without trying a position.
 *   - The combined playlist never gets a position, whoever calls.
 *   - Keys that cannot be read (a D1 error) mean an append, never a failure.
 *
 * `attempts` = insert calls made.
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
  if (position !== null && (await positioningOff(env, a.playlistId, a.cache))) position = null
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
    if (e.reason === 'manualSortRequired') {
      await noteNotManual(env, a.playlistId).catch(() => {})
      // The run's own memory too: its next insert into this playlist is appended without asking.
      if (a.cache) (a.cache.notManual ??= new Map()).set(a.playlistId, true)
    }
    await append()
    return { position: null, attempts: 2 }
  }
}
