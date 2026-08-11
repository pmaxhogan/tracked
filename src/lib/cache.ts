export const TTL = {
  YT_VIDEO: 60 * 60 * 24 * 30,
  /** 1001tl pages turn over fast on new listings — keep both the search
   *  mapping and the parsed tracklist short so newly-added tracklists and
   *  newly-IDed tracks show up without a long stale window. */
  TRACKLIST_SEARCH: 60 * 60 * 2,
  TRACKLIST_PAGE: 60 * 60 * 2,
  MEDIALINK: 60 * 60 * 24 * 30,
  APPLE: 60 * 60 * 24 * 90,
  /** Durable audit record of each /now-playing call, keyed `np:<epochMs>:<reqId>`.
   *  Workers Logs only retains ~3 days, but bugs here are often noticed weeks
   *  later (e.g. a wrong timestamp spotted in an old screenshot). 90 days keeps
   *  the input (currentSeconds, videoDuration) and the selection durably
   *  inspectable via `wrangler kv key list --prefix np:`. */
  AUDIT: 60 * 60 * 24 * 90,
  /** Durable audit record of one tracklist the sync processed, keyed
   *  `pladd:<invertedTs>:<slug>:<i>`. Same 90-day horizon as AUDIT and for the
   *  same reason: "why isn't this set in my playlist?" is usually asked long
   *  after the run that decided it. Backs the panel's "Recent playlist
   *  additions" view (see lib/playlist-audit.ts). */
  PLAYLIST_AUDIT: 60 * 60 * 24 * 90,
  /** Snapshot of a YouTube playlist's videoId set, keyed by playlistId. The
   *  5-min sync cron would otherwise re-fetch this every tick per sub. We
   *  update the cache after every insert in-run, so the only reason it can
   *  drift is the user manually editing the playlist outside the worker —
   *  6h reconciliation catches that without hammering the quota. */
  PLAYLIST_VIDEO_IDS: 60 * 60 * 6,
  /** A DJ's crawled set index behind the /subscriptions/dj/<slug> profile
   *  page. The crawl is a real upstream cost (home-proxy/BrightData page GET
   *  + AJAX pagination hops), and new sets appear at most a few times a week
   *  per DJ — 6 h keeps profile views ~free while staying reasonably fresh.
   *  The page has an explicit Refresh button that bypasses this. */
  DJ_SETS: 60 * 60 * 6,
} as const

export async function getJson<T>(kv: KVNamespace, key: string): Promise<T | undefined> {
  const v = await kv.get(key, 'json')
  return (v ?? undefined) as T | undefined
}

export async function putJson<T>(kv: KVNamespace, key: string, value: T, ttl: number): Promise<void> {
  await kv.put(key, JSON.stringify(value), { expirationTtl: ttl })
}

/**
 * Zero-padded `10^13 − epochMs`, the key component that makes an audit prefix
 * list newest-first: KV `list()` only returns keys in ascending order, so a
 * forward-epoch key could only be paged from the oldest record. Used by both
 * audit trails (`np:` in routes/now-playing.ts, `pladd:` in lib/playlist-audit.ts).
 */
export function invertedTs(epochMs: number): string {
  return String(10_000_000_000_000 - epochMs).padStart(14, '0')
}

/** sha1 of a string, hex-encoded. Used for cache keys derived from free text. */
export async function sha1Hex(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s)
  const digest = await crypto.subtle.digest('SHA-1', buf)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
