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
export async function lookupAppleLink(artist: string, title: string): Promise<string | null> {
  const term = `${artist} ${title}`.trim()
  if (!term) return null
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=5`
  const res = await fetch(url)
  if (!res.ok) return null
  const json = (await res.json()) as ITunesResponse
  if (!json.results?.length) return null

  const tn = norm(title)
  const an = norm(artist)
  let best: { url: string; score: number } | null = null
  for (const r of json.results) {
    if (!r.trackViewUrl) continue
    const t = norm(r.trackName ?? '')
    const a = norm(r.artistName ?? '')
    let score = 0
    if (t === tn) score += 4
    else if (t.includes(tn) || tn.includes(t)) score += 2
    if (a === an) score += 3
    else if (a.includes(an) || an.includes(a)) score += 1
    if (best === null || score > best.score) best = { url: r.trackViewUrl, score }
  }
  if (!best || best.score < 2) return null
  return best.url
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}
