import type { Env } from '../types'
import { batchChunked, dbOf } from './db'

/**
 * Storage for the /subscriptions mini-app: the `subscriptions` table in D1
 * (one row per DJ slug, `position` preserving the order they were added in).
 *
 * Before D1 the list lived in the SUBS KV namespace as `subs:list` (ordered
 * slug array) + `subs:item:<slug>` (metadata). The first read against an
 * empty table imports that list once, then records the fact in KV
 * (`migrate:d1:subs`) so a table the user has since emptied on purpose is not
 * refilled from the stale KV copy. A failed import throws — the sync must
 * never run against a silently-empty list.
 */

const LEGACY_LIST_KEY = 'subs:list'
const LEGACY_ITEM_PREFIX = 'subs:item:'
const MIGRATED_FLAG = 'migrate:d1:subs'

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

type Row = { slug: string; source_url: string; added_at: number }

async function readAll(env: Env): Promise<Subscription[]> {
  const res = await dbOf(env).prepare('SELECT slug, source_url, added_at FROM subscriptions ORDER BY position, slug').all<Row>()
  return res.results.map((r) => ({ slug: r.slug, sourceUrl: r.source_url, addedAt: Number(r.added_at) }))
}

export async function listSubscriptions(env: Env): Promise<Subscription[]> {
  const rows = await readAll(env)
  if (rows.length > 0) return rows
  if (await importSubscriptionsFromKv(env)) return readAll(env)
  return []
}

/**
 * One-time import of the pre-D1 subscription list. Returns true when it
 * imported something. Idempotent: the KV flag is set once the import (or a
 * confirmed-empty KV) has been seen, and nothing is touched after that.
 */
export async function importSubscriptionsFromKv(env: Env): Promise<boolean> {
  if ((await env.SUBS.get(MIGRATED_FLAG)) !== null) return false
  const list = ((await env.SUBS.get(LEGACY_LIST_KEY, 'json')) as string[] | null) ?? []
  const db = dbOf(env)
  const statements: D1PreparedStatement[] = []
  let position = 0
  for (const slug of list) {
    if (!SLUG_RE.test(slug)) continue
    const meta = (await env.SUBS.get(`${LEGACY_ITEM_PREFIX}${slug}`, 'json')) as Omit<Subscription, 'slug'> | null
    statements.push(
      db
        .prepare('INSERT OR IGNORE INTO subscriptions (slug, source_url, added_at, position) VALUES (?, ?, ?, ?)')
        .bind(slug, meta?.sourceUrl ?? djUrlFor(slug), meta?.addedAt ?? 0, position++),
    )
  }
  await batchChunked(db, statements)
  await env.SUBS.put(MIGRATED_FLAG, JSON.stringify({ at: new Date().toISOString(), imported: statements.length }))
  return statements.length > 0
}

export async function addSubscription(env: Env, sourceUrl: string): Promise<{ added: boolean; subscription: Subscription }> {
  const slug = parseDjSlug(sourceUrl)
  if (!slug) throw new InvalidSubscriptionInput(`could not parse a 1001tracklists DJ slug from ${JSON.stringify(sourceUrl)}`)

  const db = dbOf(env)
  // Make sure a legacy list has been imported before deciding "new".
  await listSubscriptions(env)
  const existing = await db.prepare('SELECT slug, source_url, added_at FROM subscriptions WHERE slug = ?').bind(slug).first<Row>()
  if (existing) {
    return { added: false, subscription: { slug, sourceUrl: existing.source_url, addedAt: Number(existing.added_at) } }
  }
  const subscription: Subscription = { slug, sourceUrl, addedAt: Math.floor(Date.now() / 1000) }
  await db
    .prepare(
      `INSERT INTO subscriptions (slug, source_url, added_at, position)
       VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM subscriptions))`,
    )
    .bind(slug, sourceUrl, subscription.addedAt)
    .run()
  return { added: true, subscription }
}

export async function removeSubscription(env: Env, slug: string): Promise<boolean> {
  if (!SLUG_RE.test(slug)) throw new InvalidSubscriptionInput(`invalid slug ${JSON.stringify(slug)}`)
  const lower = slug.toLowerCase()
  await listSubscriptions(env)
  const r = await dbOf(env).prepare('DELETE FROM subscriptions WHERE slug = ?').bind(lower).run()
  return (r.meta.changes ?? 0) > 0
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
