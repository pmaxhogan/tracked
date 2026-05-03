export const TTL = {
  YT_VIDEO: 60 * 60 * 24 * 30,
  /** 1001tl pages turn over fast on new listings — keep both the search
   *  mapping and the parsed tracklist short so newly-added tracklists and
   *  newly-IDed tracks show up without a long stale window. */
  TRACKLIST_SEARCH: 60 * 60 * 2,
  TRACKLIST_PAGE: 60 * 60 * 2,
  MEDIALINK: 60 * 60 * 24 * 30,
  APPLE: 60 * 60 * 24 * 90,
} as const

export async function getJson<T>(kv: KVNamespace, key: string): Promise<T | undefined> {
  const v = await kv.get(key, 'json')
  return (v ?? undefined) as T | undefined
}

export async function putJson<T>(kv: KVNamespace, key: string, value: T, ttl: number): Promise<void> {
  await kv.put(key, JSON.stringify(value), { expirationTtl: ttl })
}

/** sha1 of a string, hex-encoded. Used for cache keys derived from free text. */
export async function sha1Hex(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s)
  const digest = await crypto.subtle.digest('SHA-1', buf)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
