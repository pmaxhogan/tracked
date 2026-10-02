/**
 * Search-result thumbnails. The index keeps each image's source URL (a track's
 * artwork, a set page's og:image) and a key: 32 hex of sha256(src), in
 * search_images. Results link /ui/img/<key>; the first request for a key copies
 * the image from its source CDN into R2 (binding IMAGES, `img/<key>`), every
 * later one is served from R2. Nothing is hotlinked from the page.
 *
 * Sources are what 1001tracklists set pages point at (Beatport, SoundCloud,
 * YouTube channel art, ...), never a 1001tracklists page: no pool page views.
 * A source, and every redirect it takes (at most 3), must be https on a named
 * host; it must answer image/* (not SVG) and be at most MAX_IMAGE_BYTES; anything else is a 404 and the page shows a placeholder.
 */
import { decodeEntities } from '../html-entities'
import type { Env } from '../../types'

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024
const FETCH_TIMEOUT_MS = 8000
const MAX_REDIRECTS = 3
const KEY_RE = /^[0-9a-f]{32}$/
/** Content-addressed by source URL: a key's image never changes. */
const CACHE_HIT = 'private, max-age=31536000, immutable'

export async function imageKey(src: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(src))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32)
}

export const imagePath = (key: string): string => `/ui/img/${key}`

/** https on a named host (no IP literal, no localhost), else null. */
export function usableImageUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null
  const h = u.hostname.toLowerCase()
  if (!h.includes('.') || h === 'localhost' || h.endsWith('.localhost') || /^[\d.]+$/.test(h) || h.startsWith('[')) return null
  return u.toString()
}

/** The set page's og:image, unless it is 1001tracklists' own logo or placeholder. */
export function extractPageImage(html: string): string | null {
  const m = html.match(/<meta\s+property="og:image"\s+content="([^"]{1,1000})"/i)
  if (!m) return null
  const src = usableImageUrl(decodeEntities(m[1]!))
  if (!src || /1001tracklists\.com\/images\/(static|artworks)\//i.test(src)) return null
  return src
}

/**
 * Fetch an image source, following at most MAX_REDIRECTS redirects by hand:
 * every hop's URL must pass `usableImageUrl` too, so a redirect cannot take
 * the Worker off https or onto a bare IP/localhost. null on any failure.
 */
async function fetchImage(src: string): Promise<Response | null> {
  let url = src
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res: Response
    try {
      res = await fetch(url, { signal, redirect: 'manual' })
    } catch {
      return null
    }
    if (res.status < 300 || res.status >= 400) return res
    const loc = res.headers.get('location')
    let next: string | null = null
    try {
      next = loc ? usableImageUrl(new URL(loc, url).toString()) : null
    } catch {
      next = null
    }
    if (!next) return null
    url = next
  }
  return null
}

/**
 * GET /ui/img/<key>: R2 first; on a miss, the source from search_images is
 * fetched, checked and stored. 404 for an unknown key or an unusable source.
 */
export async function serveImage(env: Env, key: string): Promise<Response> {
  const notFound = () => new Response('not found', { status: 404, headers: { 'cache-control': 'private, max-age=3600' } })
  if (!KEY_RE.test(key) || !env.IMAGES || !env.SEARCH_DB) return notFound()
  const objKey = `img/${key}`
  const hit = await env.IMAGES.get(objKey)
  if (hit) {
    return new Response(await hit.arrayBuffer(), { headers: { 'content-type': hit.httpMetadata?.contentType ?? 'image/jpeg', 'cache-control': CACHE_HIT, 'x-content-type-options': 'nosniff' } })
  }
  const row = await env.SEARCH_DB.prepare('SELECT src FROM search_images WHERE key = ?').bind(key).first<{ src: string }>()
  const src = usableImageUrl(row?.src)
  if (!src) return notFound()
  const res = await fetchImage(src)
  if (!res) return notFound()
  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  const declared = Number(res.headers.get('content-length') ?? '0')
  if (!res.ok || !type.startsWith('image/') || type.includes('svg') || declared > MAX_IMAGE_BYTES) return notFound()
  const body = await res.arrayBuffer()
  if (body.byteLength === 0 || body.byteLength > MAX_IMAGE_BYTES) return notFound()
  try {
    await env.IMAGES.put(objKey, body, { httpMetadata: { contentType: type } })
  } catch {
    /* served anyway; the next request tries to store it again */
  }
  return new Response(body, { headers: { 'content-type': type, 'cache-control': CACHE_HIT, 'x-content-type-options': 'nosniff' } })
}
