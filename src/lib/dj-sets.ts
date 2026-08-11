import type { Env } from '../types'
import { crawlDjIndex } from './dj-index'
import { loadSubState } from './sync'
import { TTL, getJson, putJson } from './cache'
import type { Logger } from './log'

/**
 * The set list behind the DJ profile page (`/subscriptions/dj/<slug>`): every
 * tracklist we know about for one DJ, with the display metadata that can be
 * derived without opening each set page (title + date live in the URL slug).
 *
 * Per-set detail (tracks, Apple/YouTube/SoundCloud links, ID'd fraction) is
 * deliberately NOT resolved here — that would mean scraping every set page on
 * a profile view, which is exactly the high-volume pattern the README warns
 * against. The page fetches one set on card-expand via /api/tracklist instead,
 * sharing the 2 h tracklist cache with every other consumer.
 */

/** Cache-key version — bump when DjSets' shape or derivation changes. */
const CV = 1
const cacheKey = (slug: string) => `djsets:v${CV}:${slug}`

export type DjSetSummary = {
  /** Absolute 1001tracklists tracklist URL. */
  url: string
  /** 1001tracklists' short id for the tracklist (`/tracklist/<id>/…`). */
  tlSlug: string | null
  /** Prettified from the URL slug: "lilly-palmer-tomorrowland-2024-07-21" → "Lilly Palmer Tomorrowland". */
  title: string
  /** ISO date (YYYY-MM-DD) when the URL slug carries one, else null. */
  date: string | null
}

export type DjSets = {
  slug: string
  artistName: string | null
  sets: DjSetSummary[]
  /** Where the list came from: a fresh crawl, or sync state after a failed crawl. */
  source: 'crawl' | 'state'
  crawledAt: number
  pagesWalked: number
  stopReason: string
}

/**
 * Derive display metadata from a tracklist URL. 1001tl slugs are
 * `<artist-and-event-words>-<YYYY-MM-DD>.html` (date optional — festival sets
 * occasionally omit it). Pure; exported for tests.
 */
export function setMetaFromUrl(url: string): DjSetSummary {
  const m = url.match(/\/tracklist\/([^/]+)\/([^/]+?)\.html?$/i)
  const tlSlug = m?.[1] ?? null
  let words = (m?.[2] ?? '').replace(/[-_]+/g, ' ').trim()
  let date: string | null = null
  const dm = words.match(/^(.*?)[\s]*(\d{4}) (\d{2}) (\d{2})$/)
  if (dm) {
    const [, rest, y, mo, d] = dm
    // Sanity-bound the month/day so "essential mix 2001 40 12" doesn't parse.
    if (Number(mo) >= 1 && Number(mo) <= 12 && Number(d) >= 1 && Number(d) <= 31) {
      date = `${y}-${mo}-${d}`
      words = (rest ?? '').trim()
    }
  }
  const title = words
    .split(' ')
    .filter(Boolean)
    .map((w) => (w.length > 2 ? w[0]!.toUpperCase() + w.slice(1) : w.toUpperCase()))
    .join(' ')
  return { url, tlSlug, title: title || url, date }
}

/**
 * Full set list for one DJ, served from KV when fresh. On miss (or
 * `refresh: true`) we walk the DJ's 1001tracklists index — same crawl the
 * sync uses — and merge in `state.discoveredTracklistUrls` from the sync
 * state, which can hold sets the index no longer surfaces (or that a deeper
 * past crawl found). If the crawl comes back empty (IP block, CF shell),
 * the sync state alone still renders a useful page.
 *
 * Crawl order is newest-first (that's how 1001tl lists them); state-only
 * URLs are appended after, so recency ordering is preserved for everything
 * the crawl saw.
 */
export async function getDjSets(
  env: Env,
  slug: string,
  opts: { refresh?: boolean; log: Logger },
): Promise<DjSets> {
  const { log } = opts
  const key = cacheKey(slug)
  if (!opts.refresh) {
    const cached = await getJson<DjSets>(env.CACHE, key)
    if (cached) {
      log.counters.cacheHits++
      log.info('cache.hit', { key, setCount: cached.sets.length })
      return cached
    }
    log.counters.cacheMisses++
    log.info('cache.miss', { key })
  }

  const crawl = await crawlDjIndex(slug, {
    brightdataApiKey: env.BRIGHTDATA_API_KEY,
    homeProxyUrl: env.HOME_PROXY_URL,
    homeProxyToken: env.HOME_PROXY_TOKEN,
    cacheKv: env.CACHE,
    log,
    // The profile page is interactive — stay well inside the fetch budget.
    deadlineMs: Date.now() + 20_000,
    maxPages: 100,
  })

  const state = await loadSubState(env, slug)
  const seen = new Set(crawl.tracklistUrls)
  const urls = [...crawl.tracklistUrls]
  for (const u of state?.discoveredTracklistUrls ?? []) {
    if (!seen.has(u)) {
      seen.add(u)
      urls.push(u)
    }
  }

  const result: DjSets = {
    slug,
    artistName: crawl.artistName ?? state?.artistName ?? null,
    sets: urls.map(setMetaFromUrl),
    source: crawl.tracklistUrls.length > 0 ? 'crawl' : 'state',
    crawledAt: Math.floor(Date.now() / 1000),
    pagesWalked: crawl.pagesWalked,
    stopReason: crawl.stopReason,
  }

  // Don't cache a failed crawl that the sync state couldn't cover either —
  // the next view should retry instead of pinning an empty page for the TTL.
  if (result.sets.length > 0) {
    await putJson(env.CACHE, key, result, TTL.DJ_SETS)
    log.info('cache.put', { key, setCount: result.sets.length, ttlSeconds: TTL.DJ_SETS })
  } else {
    log.warn('djsets.empty_not_cached', { slug, stopReason: crawl.stopReason })
  }
  return result
}
