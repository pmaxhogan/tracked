/**
 * YouTube Data API v3 playlist client. Authenticated calls only — uses an
 * OAuth access token (from src/lib/google-oauth.ts) for everything; the
 * read-only YOUTUBE_API_KEY is reserved for unauthenticated `resolveVideo`.
 *
 * Quota notes (default project quota = 10,000 units/day):
 *   - playlists.list           1
 *   - playlists.insert        50
 *   - playlistItems.list       1
 *   - playlistItems.insert    50
 *
 * Errors include the full JSON response body in the message so failures are
 * readable in the worker log without sprinkling toString fallbacks at call
 * sites.
 */

const API = 'https://www.googleapis.com/youtube/v3'

export type Playlist = { id: string; title: string }

async function authedFetch(
  url: string,
  accessToken: string,
  init: RequestInit = {},
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const headers = new Headers(init.headers ?? {})
  headers.set('Authorization', `Bearer ${accessToken}`)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  return fetcher(url, { ...init, headers })
}

async function expectOk(res: Response, op: string): Promise<void> {
  if (res.ok) return
  const body = await res.text().catch(() => '')
  throw new Error(`youtube ${op} ${res.status}: ${body.slice(0, 500)}`)
}

/**
 * Walk the user's own playlists and return the first one whose snippet.title
 * matches `title` exactly (case-sensitive — YouTube allows duplicate titles
 * but we treat the first as the canonical one). Returns null if no match.
 */
export async function findPlaylistByTitle(
  title: string,
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<Playlist | null> {
  let pageToken: string | undefined
  for (;;) {
    const params = new URLSearchParams({ part: 'snippet', mine: 'true', maxResults: '50' })
    if (pageToken) params.set('pageToken', pageToken)
    const res = await authedFetch(`${API}/playlists?${params}`, accessToken, {}, fetcher)
    await expectOk(res, 'playlists.list')
    const data = (await res.json()) as {
      items?: Array<{ id: string; snippet?: { title?: string } }>
      nextPageToken?: string
    }
    const hit = data.items?.find((p) => p.snippet?.title === title)
    if (hit) return { id: hit.id, title: hit.snippet?.title ?? title }
    if (!data.nextPageToken) return null
    pageToken = data.nextPageToken
  }
}

export async function createPlaylist(
  opts: { title: string; description?: string; privacyStatus?: 'private' | 'unlisted' | 'public' },
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<Playlist> {
  const body = {
    snippet: { title: opts.title, description: opts.description ?? '' },
    status: { privacyStatus: opts.privacyStatus ?? 'private' },
  }
  const res = await authedFetch(
    `${API}/playlists?part=snippet,status`,
    accessToken,
    { method: 'POST', body: JSON.stringify(body) },
    fetcher,
  )
  await expectOk(res, 'playlists.insert')
  const data = (await res.json()) as { id: string; snippet?: { title?: string } }
  return { id: data.id, title: data.snippet?.title ?? opts.title }
}

/**
 * Page through every playlistItem on `playlistId` and return the set of
 * contained videoIds (incl. private/unlisted videos owned by the same
 * channel). Used so we never re-insert duplicates even when the per-sub KV
 * state has been wiped.
 */
export async function listPlaylistVideoIds(
  playlistId: string,
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<Set<string>> {
  const out = new Set<string>()
  let pageToken: string | undefined
  for (;;) {
    const params = new URLSearchParams({
      part: 'contentDetails',
      playlistId,
      maxResults: '50',
    })
    if (pageToken) params.set('pageToken', pageToken)
    const res = await authedFetch(`${API}/playlistItems?${params}`, accessToken, {}, fetcher)
    await expectOk(res, 'playlistItems.list')
    const data = (await res.json()) as {
      items?: Array<{ contentDetails?: { videoId?: string } }>
      nextPageToken?: string
    }
    for (const it of data.items ?? []) {
      const id = it.contentDetails?.videoId
      if (id) out.add(id)
    }
    if (!data.nextPageToken) return out
    pageToken = data.nextPageToken
  }
}

export async function addVideoToPlaylist(
  playlistId: string,
  videoId: string,
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const body = {
    snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } },
  }
  const res = await authedFetch(
    `${API}/playlistItems?part=snippet`,
    accessToken,
    { method: 'POST', body: JSON.stringify(body) },
    fetcher,
  )
  await expectOk(res, 'playlistItems.insert')
}
