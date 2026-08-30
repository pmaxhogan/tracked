import type { Env } from '../types'
import { extractVideoId } from './youtube'
import { getAccessToken } from './google-oauth'
import { getRatings } from './youtube-likes'
import { errorFields, type Logger } from './log'

/**
 * Annotate each track with `youtubeLiked` — whether the connected YouTube
 * account has liked the track's `youtubeLink` video. Best-effort by design:
 *
 *   - no OAuth connection / no youtubeLink / lookup failure → `null`
 *   - rating === 'like'                                     → `true`
 *   - any other rating the API reports                     → `false`
 *
 * Never throws and never blocks the response on a YouTube outage; the client
 * renders `null` as the outlined (unknown) thumbs-up. Costs one
 * videos.getRating call (1 quota unit per 50 ids) when connected.
 */
export async function attachYoutubeLiked<T extends { youtubeLink: string | null }>(
  env: Env,
  tracks: T[],
  log: Logger,
  fetcher: typeof fetch = fetch,
): Promise<Array<T & { youtubeLiked: boolean | null }>> {
  const withNull = () => tracks.map((t) => ({ ...t, youtubeLiked: null }))

  const idOf = (t: T) => (t.youtubeLink ? extractVideoId(t.youtubeLink) : null)
  const ids = tracks.map(idOf).filter((id): id is string => id !== null)
  if (ids.length === 0) return withNull()

  let accessToken: string
  try {
    const tok = await getAccessToken(env, fetcher)
    if (!tok) {
      log.info('liked.skip_not_connected', { ids: ids.length })
      return withNull()
    }
    accessToken = tok.accessToken
  } catch (e) {
    log.warn('liked.token_failed', errorFields(e))
    return withNull()
  }

  try {
    const ratings = await getRatings(ids, accessToken, fetcher)
    log.info('liked.resolved', { requested: ids.length, returned: ratings.size })
    return tracks.map((t) => {
      const id = idOf(t)
      const r = id ? ratings.get(id) : undefined
      return { ...t, youtubeLiked: r === undefined ? null : r === 'like' }
    })
  } catch (e) {
    log.warn('liked.lookup_failed', errorFields(e))
    return withNull()
  }
}
