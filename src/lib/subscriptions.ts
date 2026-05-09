import type { Env } from '../types'

/**
 * Storage layout for the /subscriptions mini-app.
 *
 * One KV key (`subs:list`) holds the full ordered list of slugs as a JSON
 * array. The list is small (a personal DJ subscription list — dozens at most)
 * and KV's eventual consistency is fine for this single-user app.
 *
 * Per-subscription metadata lives alongside in `subs:item:<slug>` so we can
 * later add scrape state (last-checked timestamp, last-known tracklist ids,
 * etc.) without rewriting the whole list on every update.
 */

const LIST_KEY = 'subs:list'
const ITEM_PREFIX = 'subs:item:'

export type Subscription = {
  slug: string
  /** Original URL the user pasted, kept for round-tripping/displaying. */
  sourceUrl: string
  /** Unix seconds. */
  addedAt: number
}

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i

/**
 * Pull the DJ slug out of a 1001tracklists DJ URL. Accepts:
 *   https://www.1001tracklists.com/dj/lillypalmer/index.html
 *   https://www.1001tracklists.com/dj/lillypalmer/
 *   https://www.1001tracklists.com/dj/lillypalmer
 *   www.1001tracklists.com/dj/lillypalmer
 *   1001tracklists.com/dj/lilly_palmer/page2.html
 *   lillypalmer  (bare slug)
 *
 * Rejects everything else (tracklist URLs, label URLs, other hosts).
 */
export function parseDjSlug(input: string): string | null {
  const s = input.trim()
  if (!s) return null

  // Try as URL first (with or without scheme).
  let urlStr = s
  if (!/^https?:\/\//i.test(urlStr) && /\//.test(urlStr)) urlStr = `https://${urlStr}`
  let u: URL | null = null
  try {
    u = new URL(urlStr)
  } catch {
    u = null
  }

  if (u) {
    if (!/^(www\.)?1001tracklists\.com$/i.test(u.hostname)) return null
    const m = u.pathname.match(/^\/dj\/([^/]+)(?:\/|$)/i)
    if (!m) return null
    const raw = decodeURIComponent(m[1]!).toLowerCase()
    return SLUG_RE.test(raw) ? raw : null
  }

  // Bare slug fallback.
  const lower = s.toLowerCase()
  return SLUG_RE.test(lower) ? lower : null
}

export async function listSubscriptions(env: Env): Promise<Subscription[]> {
  const list = (await env.SUBS.get(LIST_KEY, 'json')) as string[] | null
  if (!list || list.length === 0) return []
  const items = await Promise.all(
    list.map(async (slug) => {
      const meta = (await env.SUBS.get(`${ITEM_PREFIX}${slug}`, 'json')) as Omit<Subscription, 'slug'> | null
      if (meta) return { slug, ...meta } satisfies Subscription
      // Defensive fallback for a list entry without metadata (shouldn't happen
      // but we'd rather show the slug than crash).
      return { slug, sourceUrl: djUrlFor(slug), addedAt: 0 } satisfies Subscription
    }),
  )
  return items
}

export async function addSubscription(env: Env, sourceUrl: string): Promise<{ added: boolean; subscription: Subscription }> {
  const slug = parseDjSlug(sourceUrl)
  if (!slug) throw new InvalidSubscriptionInput(`could not parse a 1001tracklists DJ slug from ${JSON.stringify(sourceUrl)}`)

  const list = ((await env.SUBS.get(LIST_KEY, 'json')) as string[] | null) ?? []
  const existing = (await env.SUBS.get(`${ITEM_PREFIX}${slug}`, 'json')) as Omit<Subscription, 'slug'> | null
  if (list.includes(slug) && existing) {
    return { added: false, subscription: { slug, ...existing } }
  }
  const subscription: Subscription = { slug, sourceUrl, addedAt: Math.floor(Date.now() / 1000) }
  await env.SUBS.put(`${ITEM_PREFIX}${slug}`, JSON.stringify({ sourceUrl, addedAt: subscription.addedAt }))
  if (!list.includes(slug)) {
    list.push(slug)
    await env.SUBS.put(LIST_KEY, JSON.stringify(list))
  }
  return { added: true, subscription }
}

export async function removeSubscription(env: Env, slug: string): Promise<boolean> {
  if (!SLUG_RE.test(slug)) throw new InvalidSubscriptionInput(`invalid slug ${JSON.stringify(slug)}`)
  const lower = slug.toLowerCase()
  const list = ((await env.SUBS.get(LIST_KEY, 'json')) as string[] | null) ?? []
  const idx = list.indexOf(lower)
  if (idx === -1) return false
  list.splice(idx, 1)
  await env.SUBS.put(LIST_KEY, JSON.stringify(list))
  await env.SUBS.delete(`${ITEM_PREFIX}${lower}`)
  return true
}

export function djUrlFor(slug: string): string {
  return `https://www.1001tracklists.com/dj/${slug}/index.html`
}

export class InvalidSubscriptionInput extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidSubscriptionInput'
  }
}
