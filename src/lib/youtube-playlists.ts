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

export async function authedFetch(
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

/**
 * Thrown by any read/write op when YouTube reports the playlist (or playlist
 * item) we referenced no longer exists. Common cause: the user deleted the
 * playlist in the YouTube UI after we'd cached its id in KV state. The sync
 * orchestrator catches this and re-resolves by title (or creates fresh).
 */
export class PlaylistNotFoundError extends Error {
  constructor(public readonly op: string, public readonly playlistId?: string) {
    super(`youtube ${op}: playlist not found${playlistId ? ` (${playlistId})` : ''}`)
    this.name = 'PlaylistNotFoundError'
  }
}

/**
 * Any non-OK YouTube Data API response that isn't the special-cased
 * PlaylistNotFoundError. Carries the HTTP status and the API's error `reason`
 * (e.g. "quotaExceeded", "videoNotFound") so callers can tell a transient
 * failure from a permanent one instead of string-matching the message.
 */
export class YouTubeApiError extends Error {
  constructor(
    public readonly op: string,
    public readonly status: number,
    public readonly reason: string | null,
    body: string,
  ) {
    super(`youtube ${op} ${status}: ${body.slice(0, 500)}`)
    this.name = 'YouTubeApiError'
  }
}

/** Out of quota (or per-minute rate limit) — retrying anything else this run is pointless. */
export function isQuotaError(e: unknown): boolean {
  return (
    e instanceof YouTubeApiError &&
    e.status === 403 &&
    /^(quotaExceeded|dailyLimitExceeded|rateLimitExceeded|userRateLimitExceeded)$/.test(e.reason ?? '')
  )
}

/**
 * A playlistItems.insert failure that will never succeed on retry for this
 * video: the video is deleted/private/otherwise uninsertable (404
 * videoNotFound, 400 invalid resource) or forbidden for a non-quota reason.
 * 5xx and network errors are NOT permanent — those retry.
 */
export function isPermanentInsertError(e: unknown): boolean {
  if (!(e instanceof YouTubeApiError)) return false
  if (isQuotaError(e)) return false
  return e.status === 400 || e.status === 404 || e.status === 403
}

export async function expectOk(res: Response, op: string, playlistIdHint?: string): Promise<void> {
  if (res.ok) return
  const body = await res.text().catch(() => '')
  if (res.status === 404 && /playlistNotFound/.test(body)) {
    throw new PlaylistNotFoundError(op, playlistIdHint)
  }
  let reason: string | null = null
  try {
    const parsed = JSON.parse(body) as { error?: { errors?: Array<{ reason?: string }> } }
    reason = parsed.error?.errors?.[0]?.reason ?? null
  } catch {
    // Non-JSON body (proxy error page etc.) — status alone still classifies.
  }
  throw new YouTubeApiError(op, res.status, reason, body)
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
    status: { privacyStatus: opts.privacyStatus ?? 'public' },
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
    await expectOk(res, 'playlistItems.list', playlistId)
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
  await expectOk(res, 'playlistItems.insert', playlistId)
}

/** YouTube's alias for the authenticated user's "Liked videos" playlist — what YouTube Music shows as "Liked songs". */
export const LIKED_VIDEOS_PLAYLIST_ID = 'LL'

/** A raw `youtube#playlistItem` resource, passed through untouched. */
export type RawPlaylistItem = Record<string, unknown> & {
  id?: string
  snippet?: { resourceId?: { videoId?: string } }
  contentDetails?: { videoId?: string }
}

/**
 * Page through `playlistId` and return every playlistItem verbatim, asking for
 * every part (`id,snippet,contentDetails,status`) — cost is 1 unit per page of
 * 50 regardless of parts, so there is no reason to skimp. Newest-added first
 * (YouTube's order). `maxPages` bounds subrequests; when the cap is hit the
 * returned `nextPageToken` lets the caller resume. `pageToken` starts mid-walk.
 */
export async function listPlaylistItems(
  playlistId: string,
  accessToken: string,
  opts: { pageToken?: string; maxPages?: number } = {},
  fetcher: typeof fetch = fetch,
): Promise<{ items: RawPlaylistItem[]; nextPageToken: string | null; pages: number }> {
  const items: RawPlaylistItem[] = []
  let pageToken = opts.pageToken
  let pages = 0
  for (;;) {
    const params = new URLSearchParams({
      part: 'id,snippet,contentDetails,status',
      playlistId,
      maxResults: '50',
    })
    if (pageToken) params.set('pageToken', pageToken)
    const res = await authedFetch(`${API}/playlistItems?${params}`, accessToken, {}, fetcher)
    await expectOk(res, 'playlistItems.list', playlistId)
    const data = (await res.json()) as { items?: RawPlaylistItem[]; nextPageToken?: string }
    items.push(...(data.items ?? []))
    pages++
    pageToken = data.nextPageToken
    if (!pageToken) return { items, nextPageToken: null, pages }
    if (opts.maxPages && pages >= opts.maxPages) return { items, nextPageToken: pageToken, pages }
  }
}

/**
 * Parse an ISO 8601 duration as YouTube emits it (`PT1H2M3S`, `PT25M`, `PT0S`,
 * `P1DT2H`). Returns null for anything unparseable.
 */
export function parseIsoDuration(iso: string | undefined | null): number | null {
  if (!iso) return null
  const m = iso.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/)
  if (!m) return null
  const [, d, h, mi, s] = m
  if (d === undefined && h === undefined && mi === undefined && s === undefined) return null
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(mi ?? 0) * 60 + Number(s ?? 0)
}

/**
 * videos.list?part=contentDetails for a batch of ids (1 unit per chunk of 50).
 * playlistItems never carry duration, so this is the only way to get it. Ids
 * the API doesn't echo back (deleted/private/region-blocked) are absent from
 * the map.
 */
export async function getVideoDurations(
  videoIds: string[],
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<Map<string, { duration: string; durationSeconds: number | null }>> {
  const out = new Map<string, { duration: string; durationSeconds: number | null }>()
  const ids = [...new Set(videoIds)]
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50)
    const params = new URLSearchParams({ part: 'contentDetails', id: chunk.join(','), maxResults: '50' })
    const res = await authedFetch(`${API}/videos?${params}`, accessToken, {}, fetcher)
    await expectOk(res, 'videos.list')
    const data = (await res.json()) as { items?: Array<{ id?: string; contentDetails?: { duration?: string } }> }
    for (const it of data.items ?? []) {
      const duration = it.contentDetails?.duration
      if (it.id && duration) out.set(it.id, { duration, durationSeconds: parseIsoDuration(duration) })
    }
  }
  return out
}
