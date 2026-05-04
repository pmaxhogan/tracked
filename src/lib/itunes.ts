import { fetchWithTimeout } from './fetch'
import type { Logger } from './log'

type ITunesResponse = {
  resultCount: number
  results: Array<{
    trackViewUrl?: string
    trackName?: string
    artistName?: string
  }>
}

/**
 * Look up an Apple Music URL by free-text search. Used as fallback when
 * 1001tracklists' medialink AJAX doesn't surface an Apple link for a track.
 * The endpoint is unauthenticated and returns standard Apple-Music-domain URLs.
 */
export async function lookupAppleLink(artist: string, title: string, log?: Logger): Promise<string | null> {
  const term = `${artist} ${title}`.trim()
  if (!term) {
    log?.warn('itunes.empty_term', { artist, title })
    return null
  }
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=5`
  log?.info('itunes.start', { artist, title, term })
  const start = Date.now()
  let res: Response
  try {
    res = await fetchWithTimeout(url, { timeoutMs: 5000 })
  } catch (e) {
    log?.error('itunes.transport_throw', { term, error: e instanceof Error ? e.message : String(e), ms: Date.now() - start })
    return null
  }
  if (!res.ok) {
    log?.error('itunes.transport_non_ok', { term, status: res.status, ms: Date.now() - start })
    return null
  }
  const json = (await res.json()) as ITunesResponse
  if (!json.results?.length) {
    log?.info('itunes.no_results', { term, ms: Date.now() - start })
    return null
  }

  const tn = norm(title)
  const an = norm(artist)
  let best: { url: string; score: number; trackName: string; artistName: string } | null = null
  for (const r of json.results) {
    if (!r.trackViewUrl) continue
    const t = norm(r.trackName ?? '')
    const a = norm(r.artistName ?? '')
    let score = 0
    if (t === tn) score += 4
    else if (t.includes(tn) || tn.includes(t)) score += 2
    if (a === an) score += 3
    else if (a.includes(an) || an.includes(a)) score += 1
    if (best === null || score > best.score) {
      best = { url: r.trackViewUrl, score, trackName: r.trackName ?? '', artistName: r.artistName ?? '' }
    }
  }
  if (!best || best.score < 2) {
    log?.info('itunes.no_confident_match', {
      term,
      bestScore: best?.score ?? 0,
      bestTrack: best?.trackName ?? null,
      bestArtist: best?.artistName ?? null,
      resultCount: json.results.length,
      ms: Date.now() - start,
    })
    return null
  }
  log?.info('itunes.matched', { term, score: best.score, trackName: best.trackName, artistName: best.artistName, url: best.url, ms: Date.now() - start })
  return best.url
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}
