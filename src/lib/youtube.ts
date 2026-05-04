const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/

/**
 * Extract a YouTube video id from any of the common URL shapes the user might
 * paste: full `youtube.com/watch?v=`, mobile `m.youtube.com`, music subdomain,
 * shortener `youtu.be/<id>`, embed paths, or a bare 11-char id. Returns null
 * if nothing parses cleanly.
 */
export function extractVideoId(input: string): string | null {
  const s = input.trim()
  if (VIDEO_ID_RE.test(s)) return s
  let url: URL
  try {
    url = new URL(s)
  } catch {
    return null
  }
  const host = url.hostname.replace(/^www\./, '')
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0] ?? ''
    return VIDEO_ID_RE.test(id) ? id : null
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    const v = url.searchParams.get('v')
    if (v && VIDEO_ID_RE.test(v)) return v
    const m = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/)
    if (m) return m[1]!
  }
  return null
}

import { fetchWithTimeout } from './fetch'
import type { Logger } from './log'

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
  log?: Logger,
): Promise<{ videoId: string; matchTitle: string } | null> {
  log?.info('yt.search.start', { title, targetDurationSeconds })
  const search = await fetchJson<SearchResponse>(
    `${API}/search?part=snippet&type=video&maxResults=5&q=${encodeURIComponent(title)}&key=${apiKey}`,
  )
  const candidates = (search.items ?? [])
    .map((it) => ({ id: it.id?.videoId, title: it.snippet?.title ?? '' }))
    .filter((x): x is { id: string; title: string } => !!x.id)
  log?.info('yt.search.result', {
    title,
    candidateCount: candidates.length,
    candidates: candidates.map((c) => ({ id: c.id, title: c.title })),
  })
  if (candidates.length === 0) return null

  if (targetDurationSeconds === undefined) {
    log?.info('yt.resolve.no_duration_picked_first', { videoId: candidates[0]!.id, title: candidates[0]!.title })
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
  log?.info('yt.resolve.duration_match', {
    targetDurationSeconds,
    durations: Array.from(durations.entries()).map(([id, d]) => ({ id, d })),
    best: best ? { id: best.c.id, title: best.c.title, delta: best.delta } : null,
  })
  if (!best || best.delta > 90) {
    log?.warn('yt.resolve.no_match_within_tolerance', { targetDurationSeconds, bestDelta: best?.delta ?? null })
    return null
  }
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
  const res = await fetchWithTimeout(url, { timeoutMs: 8000 })
  if (!res.ok) throw new Error(`youtube ${res.status}: ${await res.text()}`)
  return (await res.json()) as T
}
