type SearchResponse = {
  items?: Array<{ id?: { videoId?: string }; snippet?: { title?: string } }>
}
type VideosResponse = {
  items?: Array<{ id: string; contentDetails?: { duration?: string } }>
}

const API = 'https://www.googleapis.com/youtube/v3'

/**
 * Find the YouTube video that best matches `title`. If `targetDurationSeconds`
 * is provided we pull contentDetails for the top results and pick the one with
 * the smallest duration delta (within ±90s tolerance). Otherwise we take the
 * top result as-is.
 *
 * Cost: 100 (search) + 1 (videos) when duration is provided; 100 otherwise.
 */
export async function resolveVideo(
  title: string,
  targetDurationSeconds: number | undefined,
  apiKey: string,
): Promise<{ videoId: string; matchTitle: string } | null> {
  const search = await fetchJson<SearchResponse>(
    `${API}/search?part=snippet&type=video&maxResults=5&q=${encodeURIComponent(title)}&key=${apiKey}`,
  )
  const candidates = (search.items ?? [])
    .map((it) => ({ id: it.id?.videoId, title: it.snippet?.title ?? '' }))
    .filter((x): x is { id: string; title: string } => !!x.id)
  if (candidates.length === 0) return null

  if (targetDurationSeconds === undefined) {
    return { videoId: candidates[0]!.id, matchTitle: candidates[0]!.title }
  }

  const ids = candidates.map((c) => c.id).join(',')
  const videos = await fetchJson<VideosResponse>(
    `${API}/videos?part=contentDetails&id=${ids}&key=${apiKey}`,
  )
  const durations = new Map<string, number>()
  for (const v of videos.items ?? []) {
    const d = parseIso8601Duration(v.contentDetails?.duration ?? '')
    if (d !== null) durations.set(v.id, d)
  }
  let best: { c: { id: string; title: string }; delta: number } | null = null
  for (const c of candidates) {
    const d = durations.get(c.id)
    if (d === undefined) continue
    const delta = Math.abs(d - targetDurationSeconds)
    if (best === null || delta < best.delta) best = { c, delta }
  }
  if (!best || best.delta > 90) return null
  return { videoId: best.c.id, matchTitle: best.c.title }
}

const ISO_RE = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/

export function parseIso8601Duration(s: string): number | null {
  const m = s.match(ISO_RE)
  if (!m) return null
  const h = m[1] ? Number(m[1]) : 0
  const min = m[2] ? Number(m[2]) : 0
  const sec = m[3] ? Number(m[3]) : 0
  return h * 3600 + min * 60 + sec
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`youtube ${res.status}: ${await res.text()}`)
  return (await res.json()) as T
}
