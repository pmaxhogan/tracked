/**
 * YouTube Data API v3 like/unlike + rating lookup. Liking a video on YouTube
 * is what puts it in YouTube Music's "Liked songs", so this is the backing
 * store for the Tasker thumbs-up button (POST /likes).
 *
 * Quota notes (default project quota = 10,000 units/day):
 *   - videos.rate          50
 *   - videos.getRating      1  (up to 50 ids per call)
 *
 * Scope: `https://www.googleapis.com/auth/youtube` (already granted by the
 * /subscriptions OAuth flow) is one of the three scopes videos.rate accepts —
 * no re-consent needed.
 */
import { authedFetch, expectOk } from './youtube-playlists'

const API = 'https://www.googleapis.com/youtube/v3'

export type Rating = 'like' | 'dislike' | 'none' | 'unspecified'

/** videos.rate. `rating: 'none'` removes an existing like/dislike. Returns nothing (204). */
export async function rateVideo(
  videoId: string,
  rating: 'like' | 'none',
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const params = new URLSearchParams({ id: videoId, rating })
  const res = await authedFetch(`${API}/videos/rate?${params}`, accessToken, { method: 'POST' }, fetcher)
  await expectOk(res, 'videos.rate')
}

/**
 * videos.getRating for a batch of ids. Dedupes and chunks at YouTube's 50-id
 * cap. Ids the API doesn't echo back (deleted/private) are simply absent from
 * the returned map — callers should treat absence as "unknown", not "none".
 */
export async function getRatings(
  videoIds: string[],
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<Map<string, Rating>> {
  const out = new Map<string, Rating>()
  const ids = [...new Set(videoIds)]
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50)
    const params = new URLSearchParams({ id: chunk.join(',') })
    const res = await authedFetch(`${API}/videos/getRating?${params}`, accessToken, {}, fetcher)
    await expectOk(res, 'videos.getRating')
    const data = (await res.json()) as { items?: Array<{ videoId?: string; rating?: string }> }
    for (const it of data.items ?? []) {
      if (it.videoId && it.rating) out.set(it.videoId, it.rating as Rating)
    }
  }
  return out
}
