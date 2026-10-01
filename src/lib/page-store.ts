/**
 * Keep every page tlpool hands back, in R2 (binding PAGES, bucket
 * tracked-pages), so a decoy / captcha / parser question can be answered from
 * the page itself instead of from a log line. Flagged or clean, set page or
 * DJ page or search: the owner wants them all (HTML is cheap).
 *
 * Key:   <flagged|clean|other>/<YYYY-MM-DD>/<kind>/<slug>/<unix>-<accountId>.html
 *          flagged = verdict decoy; clean = verdict clean; other = challenge | error.
 *          Day and unix are the fetch time (UTC). Lifecycle rules are set on the
 *          bucket by prefix: flagged/ 180 days, clean/ 30, other/ 30.
 * Body:  gzip (httpMetadata.contentEncoding = gzip). The operator route
 *        (routes/pool-pages.ts) inflates it on the way out.
 * Meta:  customMetadata { url, kind, priority, accountId, exitLabel, fetchedAt,
 *        status, verdict, detail } (R2 allows 2 KB in all: fields are clipped).
 *
 * Runs in the background only (`capturePage` is fire-and-forget; index.ts
 * hands `drainPageCaptures()` to ctx.waitUntil), never awaited by a request,
 * and swallows every error. At most PAGE_DAILY_CAP stores a UTC day (a KV
 * counter in CACHE, approximate by design); hitting it logs once.
 *
 * The page is 1001tracklists' public HTML as served to a pool account, with
 * one edit: the logged-in header names the account ("user dashboard for
 * <username> (n)"); the Worker never knows that name, so the element is
 * found by its shape and the name replaced with the accountId.
 */

import type { Logger } from './log'
import type { PoolKind, PoolPriority } from './pool'

export const PAGE_DAILY_CAP = 5000

export type PageVerdict = 'clean' | 'decoy' | 'challenge' | 'error'

export type PageCapture = {
  url: string
  kind: PoolKind
  priority: PoolPriority
  status: number
  html: string
  accountId: string
  exitLabel: string
  /** ISO time of the fetch (tlpool's). */
  fetchedAt: string
  /** Set by the caller when it already knows (block page, refusal); otherwise classified from status and page. */
  verdict?: { verdict: PageVerdict; detail: string }
  /** Extra text that tells two fetches of one URL apart (a POST's form), hashed into the slug. */
  variant?: string
}

export type PageStoreOpts = { bucket: R2Bucket; counter: KVNamespace; log?: Logger; now?: () => number }

export const SCRUB_NOTE = '<!-- page withheld: a logged-in header could not be scrubbed -->'

/**
 * Replace the logged-in account's username with the account id. Fails closed:
 *   1. every "user dashboard for NAME (n)" (any case, attribute or text, any
 *      attribute order) becomes "... for <accountId> (n)";
 *   2. any title attribute that still mentions "dashboard" (an unknown shape)
 *      is cut down to "dashboard";
 *   3. if a "dashboard for" phrase other than the account id still remains
 *      (entities, odd markup), the body is replaced by SCRUB_NOTE.
 * An unmatched logged-in header is never returned.
 */
export function scrubPage(html: string, accountId: string): { html: string; mode: 'exact' | 'fallback' | 'note' } {
  const safe = accountId.replace(/[^A-Za-z0-9_-]/g, '_')
  let mode: 'exact' | 'fallback' | 'note' = 'exact'
  let out = html.replace(
    /(user\s+dashboard\s+for\s+)([^"'<(]*?)(\s*\(\d[^)"'<]*\))?(?=["'<])/gi,
    (_m, a: string, _name: string, n: string | undefined) => `${a}${safe}${n ?? ''}`,
  )
  const okTitle = new RegExp(`^user\\s+dashboard\\s+for\\s+${safe}(\\s*\\(\\d[^)]*\\))?$`, 'i')
  out = out.replace(/(\btitle\s*=\s*)(["'])([^"']*dashboard[^"']*)\2/gi, (m, a: string, q: string, v: string) => {
    if (okTitle.test(v.trim())) return m
    mode = 'fallback'
    return `${a}${q}dashboard${q}`
  })
  const leftover = out.replace(new RegExp(`user\\s+dashboard\\s+for\\s+${safe}`, 'gi'), '')
  if (/dashboard(?:\s|&nbsp;|&#160;|&#xa0;)*for\b/i.test(leftover)) return { html: SCRUB_NOTE, mode: 'note' }
  return { html: out, mode }
}

/** The page with the logged-in username replaced (see scrubPage). */
export function scrubUsername(html: string, accountId: string): string {
  return scrubPage(html, accountId).html
}

const clean = (s: string, max: number) => s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, max)

async function shortHash(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
  return [...d.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** `<id>` for a tracklist URL, else the path (plus a short hash of the query/form when there is one). */
export async function pageSlug(url: string, variant?: string): Promise<string> {
  let u: URL | null = null
  try {
    u = new URL(url)
  } catch {
    /* not a URL: slug it whole */
  }
  const id = u?.pathname.match(/^\/tracklist\/([^/]+)\//)?.[1]
  const path = id ?? (clean((u?.pathname ?? url).replace(/^\/+/, '').replace(/\.(html|php)$/i, '').replace(/\//g, '_'), 80) || 'root')
  const extra = `${u?.search ?? ''}${variant ?? ''}`
  return extra ? `${clean(path, 70)}-${await shortHash(extra)}` : clean(path, 80)
}

export function pageKey(p: { verdict: PageVerdict; kind: string; slug: string; accountId: string; fetchedAt: string }, nowMs: number): string {
  const t = Date.parse(p.fetchedAt)
  const ms = Number.isFinite(t) ? t : nowMs
  const prefix = p.verdict === 'decoy' ? 'flagged' : p.verdict === 'clean' ? 'clean' : 'other'
  const day = new Date(ms).toISOString().slice(0, 10)
  return `${prefix}/${day}/${clean(p.kind, 16)}/${p.slug}/${Math.floor(ms / 1000)}-${clean(p.accountId, 64)}.html`
}

/** What the page is, from the status and the page itself. Set pages run the decoy detector. */
export async function classifyPage(c: Pick<PageCapture, 'kind' | 'status' | 'html' | 'url'>): Promise<{ verdict: PageVerdict; detail: string }> {
  if (c.status >= 400) return { verdict: c.status === 401 || c.status === 403 || c.status === 429 ? 'challenge' : 'error', detail: `http ${c.status}` }
  if (c.kind !== 'set') return { verdict: 'clean', detail: '' }
  // Dynamic import: tracklists1001 imports upstream1001, which starts captures.
  const { parseTracklist } = await import('./tracklists1001')
  const parsed = parseTracklist(c.url, c.html)
  const d = parsed.decoy
  if (d.suspected || d.mismatched > 0) return { verdict: 'decoy', detail: `named=${d.named} mismatched=${d.mismatched} near=${d.nearMismatched} rows=${parsed.rows.length}` }
  if (parsed.rows.length === 0) return { verdict: 'error', detail: 'no track rows' }
  return { verdict: 'clean', detail: d.nearMismatched > 0 ? `rows=${parsed.rows.length} near=${d.nearMismatched}` : `rows=${parsed.rows.length}` }
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export async function gunzipToText(body: ArrayBuffer): Promise<string> {
  const stream = new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).text()
}

/** Count one store against today's cap. false = over the cap (logs once, on the first refusal). */
async function underCap(kv: KVNamespace, nowMs: number, log?: Logger): Promise<boolean> {
  const key = `pages:count:${new Date(nowMs).toISOString().slice(0, 10)}`
  const n = Number((await kv.get(key)) ?? '0') || 0
  if (n >= PAGE_DAILY_CAP) {
    if (n === PAGE_DAILY_CAP) {
      await kv.put(key, String(n + 1), { expirationTtl: 172800 })
      log?.warn('pages.daily_cap_hit', { cap: PAGE_DAILY_CAP })
    }
    return false
  }
  await kv.put(key, String(n + 1), { expirationTtl: 172800 })
  return true
}

/** Store one page. Never throws. Returns the key, or null when skipped / failed. */
export async function storePage(opts: PageStoreOpts, c: PageCapture): Promise<string | null> {
  const { log } = opts
  try {
    const nowMs = (opts.now ?? Date.now)()
    if (!(await underCap(opts.counter, nowMs, log))) return null
    // Scrub first: nothing below can reach the bucket with an unscrubbed page.
    const scrubbed = scrubPage(c.html, c.accountId)
    let v: { verdict: PageVerdict; detail: string }
    try {
      v = c.verdict ?? (await classifyPage(c))
    } catch {
      v = { verdict: 'error', detail: 'classify_failed' }
    }
    if (scrubbed.mode !== 'exact') {
      log?.warn('pages.scrub_fallback', { mode: scrubbed.mode, accountId: c.accountId })
      v = { ...v, detail: `${v.detail} scrub:${scrubbed.mode}`.trim() }
    }
    const slug = await pageSlug(c.url, c.variant)
    const key = pageKey({ verdict: v.verdict, kind: c.kind, slug, accountId: c.accountId, fetchedAt: c.fetchedAt }, nowMs)
    const body = await gzip(scrubbed.html)
    await opts.bucket.put(key, body, {
      httpMetadata: { contentType: 'text/html; charset=utf-8', contentEncoding: 'gzip' },
      customMetadata: {
        url: c.url.slice(0, 400),
        kind: c.kind,
        priority: c.priority,
        accountId: c.accountId.slice(0, 64),
        exitLabel: c.exitLabel.slice(0, 80),
        fetchedAt: c.fetchedAt.slice(0, 40),
        status: String(c.status),
        verdict: v.verdict,
        detail: v.detail.slice(0, 200),
      },
    })
    if (v.verdict === 'decoy') log?.warn('pages.stored_flagged', { key, accountId: c.accountId })
    return key
  } catch (e) {
    log?.warn('pages.store_failed', { url: c.url, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) })
    return null
  }
}

const pending = new Set<Promise<unknown>>()

/** Fire and forget: start storing, remember the promise so `drainPageCaptures` can hand it to ctx.waitUntil. */
export function capturePage(opts: PageStoreOpts, c: PageCapture): void {
  const p: Promise<unknown> = storePage(opts, c).finally(() => pending.delete(p))
  pending.add(p)
}

/** Resolves when every capture started so far has finished (they swallow their own errors). */
export async function drainPageCaptures(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending])
}
