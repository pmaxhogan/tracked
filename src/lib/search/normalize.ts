/**
 * One normalization for both sides of search (spec §9): the text written to
 * the FTS columns and the vocabulary, and the query. Lowercase, diacritics
 * stripped, apostrophes dropped (don't → dont), & → and, "w/" → with, split on
 * anything not a letter or digit, then the synonym map.
 */
const SYNONYMS: Record<string, string> = { ft: 'feat', featuring: 'feat', rmx: 'remix', versus: 'vs', pt: 'part' }

export function normalizeText(s: string | null | undefined): string[] {
  if (!s) return []
  const t = s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/['’‘`´]/g, '')
    .replace(/&/g, ' and ')
    .replace(/(^|[^\p{L}\p{N}])w\//gu, '$1with ')
  return t
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => SYNONYMS[w] ?? w)
}

export const normalizedJoin = (s: string | null | undefined): string => normalizeText(s).join(' ')

/** Words of a 1001tracklists set URL's slug, date and extension dropped. */
export function slugWords(url: string): string {
  const last = url.split(/[?#]/)[0]!.split('/').filter(Boolean).pop() ?? ''
  return normalizedJoin(last.replace(/\.html$/i, '').replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-/g, ' '))
}

async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The index key of a track: its 1001tracklists id, else a hash of normalized artist + title. */
export async function trackKey(t: { trackId: string | null; artist: string; title: string }): Promise<string> {
  if (t.trackId && /^\d{1,12}$/.test(t.trackId)) return `t:${t.trackId}`
  return `h:${(await sha256hex(`${normalizedJoin(t.artist)}\u0000${normalizedJoin(t.title)}`)).slice(0, 32)}`
}
