/**
 * Fetch + parse DJ index pages on 1001tracklists, plus extract the embedded
 * YouTube video id from individual set pages.
 *
 * **Why URL-pattern extraction instead of CSS selectors:** the DJ page lists
 * dozens of sets in a structure 1001tl is free to restyle, but every set is
 * always a `<a href="/tracklist/<id>/<slug>.html">` link with a YouTube
 * indicator only revealed by visiting the set itself. Selectors break on
 * minor template changes; pattern extraction is selector-free and survives
 * layout churn. Same for the set page: the embedded player is always a
 * `youtube.com/embed/<11-char id>` URL — finding it doesn't require knowing
 * the exact iframe structure.
 *
 * The two fetch helpers `fetch1001Html` + this module's parsers are kept
 * deliberately small so they can be unit-tested with synthetic fixtures and
 * exercised live against unstable selectors.
 */

import { parse } from 'node-html-parser'
import {
  fetchHtml,
  fetchWithTimeout,
  isIPBlocked,
  extractIPBlockedAddress,
  IPBlockedError,
  looksLikeCfShell,
  CloudflareChallengeError,
  type ChallengeState,
} from './fetch'
import { fetchViaUnlocker } from './unlocker'
import { fetchViaHomeProxy } from './homeProxy'
import type { Logger } from './log'

const ORIGIN = 'https://www.1001tracklists.com'
const TRACKLIST_HREF_RE = /href="(\/tracklist\/[^"#?]+\.html)"/g
const VIDEO_ID_RE = /[A-Za-z0-9_-]{11}/
// Match the player iframe URL (the canonical "this set has a YouTube
// recording" signal). Both youtube.com/embed and the privacy-enhanced
// youtube-nocookie.com/embed are valid; 1001tl has used both over time.
const EMBED_RE = /(?:youtube(?:-nocookie)?\.com)\/embed\/([A-Za-z0-9_-]{11})/g
// og:video / og:video:url tags occasionally surface the watch URL too.
const WATCH_RE = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/v\/)([A-Za-z0-9_-]{11})/g
// Common JS-variable / data-attribute carriers for the set's video id when
// the player iframe is rendered lazily.
const DATA_ATTR_RE = /data-(?:yt|youtube)(?:-?id)?="([A-Za-z0-9_-]{11})"/g
const JS_VAR_RE = /(?:videoId|ytId|youtubeId)\s*[:=]\s*["']([A-Za-z0-9_-]{11})["']/g

export type ParsedDjIndex = {
  /** Best guess at the DJ's display name. Falls back to slug-prettified when missing. */
  artistName: string | null
  /**
   * Absolute tracklist URLs in the order they appear on the page. De-duped.
   * Newest sets typically appear first on 1001tl DJ pages.
   */
  tracklistUrls: string[]
}

/**
 * Pull the DJ display name + tracklist URLs out of a DJ index page. Pure;
 * does not fetch.
 *
 * The H1 selector (`h1.titleNameH1`) is the only CSS-selector dependency in
 * here, and we degrade to null on miss — caller falls back to slug.
 */
export function parseDjIndex(html: string): ParsedDjIndex {
  const root = parse(html)
  // The actual H1 class on 1001tl as of 2026 is `titleNameH1`, but be
  // tolerant: any H1 will do as a fallback. 1001tl's DJ-page H1 includes a
  // " Tracklists Overview" suffix on the listing template — strip it so the
  // playlist name is just the artist.
  let artistName: string | null = null
  const h1 = root.querySelector('h1.titleNameH1') ?? root.querySelector('h1')
  if (h1) {
    const raw = decodeEntities(h1.text).trim().replace(/\s+/g, ' ')
    const trimmed = raw.replace(/\s+Tracklists Overview\s*$/i, '').trim()
    artistName = trimmed || null
  }

  const seen = new Set<string>()
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = TRACKLIST_HREF_RE.exec(html))) {
    const path = m[1]!
    const abs = ORIGIN + path
    if (!seen.has(abs)) {
      seen.add(abs)
      out.push(abs)
    }
  }

  return { artistName, tracklistUrls: out }
}

/**
 * Find the YouTube video id embedded as the set's main media. Returns the
 * first match, since 1001tl set pages put the primary embed near the top of
 * the document. Returns null when the set has no YouTube video.
 *
 * We accept either the `/embed/<id>` form (player iframe) or the watch URL
 * form (og:video). VIDEO_ID_RE filters out 11-char-lookalike substrings that
 * happen to live inside other attributes.
 */
export function parseSetYouTubeId(html: string): string | null {
  const candidates: string[] = []
  for (const re of [EMBED_RE, WATCH_RE, DATA_ATTR_RE, JS_VAR_RE]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(html))) candidates.push(m[1]!)
  }
  for (const c of candidates) {
    if (VIDEO_ID_RE.test(c) && !isYouTubeChannelLike(c)) return c
  }
  return null
}

/**
 * Rough fingerprint of how YouTube-y a set page is, used in the
 * `sync.no_youtube_on_set` diagnostic to tell at a glance whether the parser
 * is missing real embeds vs. the page truly has none. No hot-path use.
 */
export function youtubeFingerprint(html: string): {
  htmlBytes: number
  embedCount: number
  watchCount: number
  shortLinkCount: number
  channelCount: number
  iframeCount: number
} {
  return {
    htmlBytes: html.length,
    embedCount: (html.match(/youtube(?:-nocookie)?\.com\/embed\//g) ?? []).length,
    watchCount: (html.match(/youtube\.com\/watch\?v=/g) ?? []).length,
    shortLinkCount: (html.match(/youtu\.be\//g) ?? []).length,
    channelCount: (html.match(/youtube\.com\/(?:channel|user|@)/g) ?? []).length,
    iframeCount: (html.match(/<iframe[^>]*youtube/gi) ?? []).length,
  }
}

// Channel ids start with "UC" + 22 chars and aren't 11 chars long, so the
// 11-char regex above already excludes them. This guard is paranoia for
// future regex tweaks.
function isYouTubeChannelLike(id: string): boolean {
  return /^UC/.test(id) && id.length !== 11
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

// 1001tl's DJ-index page is JS infinite-scroll: the initial HTML only
// renders ~15 newest sets, and `loadInfiniteScrollData()` (defined in
// /js/framework.js) POSTs to `/ajax/get_data.php` to fetch more. The
// payload is form-encoded:
//
//   type=overview        constant for DJ-index pagination
//   dj=<DJ_ID>           internal short id (e.g. '80q82k2'), embedded in
//                        the page as `iScrollParams.dj = '...'`
//   width=<innerWidth>   used server-side to estimate row height; 1920 works
//   pos=<count>          number of items currently shown
//   id=<lastDataId>      data-id attribute of the last visible .oItm row
//   count=<requested>    how many more items to return; ~15 fits page-1 sizing
//
// Response shape: { success: bool, data: '<html chunk of more .oItm rows>',
// end?: bool, captcha?: bool, captchaHTML?: '...' }. We only need success+data
// (or end). Captcha is rare and surfaces as a CloudflareChallengeError-style
// no-progress signal.
const DJ_ID_RE = /iScrollParams\s*\.\s*dj\s*=\s*['"]([^'"]+)['"]/
const O_ITM_DATA_ID_RE = /<div[^>]*\boItm\b[^>]*\bdata-id="([^"]+)"/g
const AJAX_URL = `${ORIGIN}/ajax/get_data.php`

/**
 * Walk the DJ's index by fetching page 1 statically and then driving the
 * same `/ajax/get_data.php` infinite-scroll endpoint that the browser uses.
 * Returns the union of all tracklist URLs, artist name (from page 1 H1),
 * pages walked (1 = initial only, N = initial + N-1 AJAX calls), and a
 * stop reason for the log.
 *
 * Stop conditions:
 *   - `end: true` in the AJAX response (1001tl explicitly says no more)
 *   - new-URL count zero on an AJAX response (defensive — past end)
 *   - `maxPages` reached
 *   - `deadlineMs` reached (wall clock — guards Workers' 30 s budget)
 *   - AJAX call threw / parsing failed — we keep what we've collected
 *
 * If we can't extract a DJ id or last-data-id from page 1's HTML, the
 * function degrades gracefully to "page 1 only" with stopReason='no_pagination'.
 */
export async function crawlDjIndex(
  slug: string,
  opts: Fetch1001Opts & { maxPages?: number; deadlineMs?: number } = {},
): Promise<{
  artistName: string | null
  tracklistUrls: string[]
  pagesWalked: number
  stopReason: 'end' | 'no_new' | 'max_pages' | 'deadline' | 'fetch_failed' | 'no_pagination'
}> {
  const maxPages = opts.maxPages ?? 20
  const log = opts.log

  // Page 1 is the static fetch — we need its HTML for both the URLs and
  // the pagination keys (DJ id + last-data-id).
  let page1Html: string
  try {
    const r = await fetch1001Html(`${ORIGIN}/dj/${slug}/index.html`, opts)
    page1Html = r.html
  } catch (e) {
    log?.warn('crawlDjIndex.page1_failed', { slug, error: e instanceof Error ? e.message : String(e) })
    return { artistName: null, tracklistUrls: [], pagesWalked: 0, stopReason: 'fetch_failed' }
  }
  const parsed1 = parseDjIndex(page1Html)
  const seenSet = new Set<string>(parsed1.tracklistUrls)
  const all: string[] = [...parsed1.tracklistUrls]
  let pagesWalked = 1
  log?.info('crawlDjIndex.page_done', {
    slug,
    page: 1,
    via: 'static',
    urlsOnPage: parsed1.tracklistUrls.length,
    addedNew: parsed1.tracklistUrls.length,
  })

  const djId = page1Html.match(DJ_ID_RE)?.[1] ?? null
  const lastDataId = lastOItmDataId(page1Html)
  if (!djId || !lastDataId || parsed1.tracklistUrls.length === 0) {
    log?.warn('crawlDjIndex.no_pagination_keys', {
      slug,
      hasDjId: !!djId,
      hasLastDataId: !!lastDataId,
      urlsOnPage1: parsed1.tracklistUrls.length,
    })
    return { artistName: parsed1.artistName, tracklistUrls: all, pagesWalked, stopReason: 'no_pagination' }
  }

  let cursorDataId = lastDataId
  let cursorPos = parsed1.tracklistUrls.length
  let stopReason: 'end' | 'no_new' | 'max_pages' | 'deadline' | 'fetch_failed' | 'no_pagination' = 'max_pages'

  for (let page = 2; page <= maxPages; page++) {
    if (opts.deadlineMs && Date.now() >= opts.deadlineMs) {
      log?.warn('crawlDjIndex.deadline', { slug, pagesWalked })
      stopReason = 'deadline'
      break
    }
    let chunk: { ok: boolean; end: boolean; dataHtml: string }
    try {
      chunk = await fetchInfiniteScrollChunk(
        { djId, pos: cursorPos, dataId: cursorDataId, count: 15, refererSlug: slug },
        opts,
      )
    } catch (e) {
      log?.warn('crawlDjIndex.ajax_failed', {
        slug,
        page,
        error: e instanceof Error ? e.message : String(e),
      })
      stopReason = 'fetch_failed'
      break
    }
    if (!chunk.ok) {
      log?.warn('crawlDjIndex.ajax_not_ok', { slug, page })
      stopReason = 'fetch_failed'
      break
    }
    pagesWalked++

    const newUrls = extractTracklistUrls(chunk.dataHtml)
    let added = 0
    for (const u of newUrls) {
      if (!seenSet.has(u)) {
        seenSet.add(u)
        all.push(u)
        added++
      }
    }
    log?.info('crawlDjIndex.page_done', { slug, page, via: 'ajax', urlsOnPage: newUrls.length, addedNew: added, end: chunk.end })

    if (chunk.end) {
      stopReason = 'end'
      break
    }
    if (added === 0) {
      stopReason = 'no_new'
      break
    }

    const nextDataId = lastOItmDataId(chunk.dataHtml)
    if (!nextDataId) {
      // No further data-ids returned — we've drained the list.
      stopReason = 'end'
      break
    }
    cursorDataId = nextDataId
    cursorPos += newUrls.length
  }

  return { artistName: parsed1.artistName, tracklistUrls: all, pagesWalked, stopReason }
}

function lastOItmDataId(html: string): string | null {
  let last: string | null = null
  let m: RegExpExecArray | null
  O_ITM_DATA_ID_RE.lastIndex = 0
  while ((m = O_ITM_DATA_ID_RE.exec(html))) last = m[1]!
  return last
}

function extractTracklistUrls(html: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  TRACKLIST_HREF_RE.lastIndex = 0
  while ((m = TRACKLIST_HREF_RE.exec(html))) {
    const abs = ORIGIN + m[1]!
    if (!seen.has(abs)) {
      seen.add(abs)
      out.push(abs)
    }
  }
  return out
}

/**
 * POST /ajax/get_data.php with the form-encoded scroll cursor. Direct
 * fetch only — the AJAX endpoint historically isn't behind 1001tl's CF
 * challenge gate the way the page HTML is, mirroring how the medialink
 * AJAX works direct from Workers in tracklists1001.ts. If a deployment
 * starts seeing 522s or CF shells here, BrightData fallback can be
 * grafted in following the medialink-direct-then-unlocker pattern.
 */
async function fetchInfiniteScrollChunk(
  cursor: { djId: string; pos: number; dataId: string; count: number; refererSlug: string },
  opts: Fetch1001Opts,
): Promise<{ ok: boolean; end: boolean; dataHtml: string }> {
  const body = new URLSearchParams({
    type: 'overview',
    dj: cursor.djId,
    width: '1920',
    pos: String(cursor.pos),
    id: cursor.dataId,
    count: String(cursor.count),
  })
  const referer = `${ORIGIN}/dj/${cursor.refererSlug}/index.html`
  const start = Date.now()
  const res = await fetchWithTimeout(AJAX_URL, {
    method: 'POST',
    timeoutMs: 8000,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json,text/javascript,*/*;q=0.01',
      Referer: referer,
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    body,
  })
  const text = await res.text()
  if (!res.ok) {
    opts.log?.warn('crawlDjIndex.ajax_http_status', { status: res.status, ms: Date.now() - start, body: text.slice(0, 300) })
    return { ok: false, end: false, dataHtml: '' }
  }
  let json: { success?: boolean; end?: boolean; data?: string; captcha?: boolean }
  try {
    json = JSON.parse(text)
  } catch {
    opts.log?.warn('crawlDjIndex.ajax_parse_failed', { ms: Date.now() - start, body: text.slice(0, 300) })
    return { ok: false, end: false, dataHtml: '' }
  }
  if (json.captcha) {
    opts.log?.warn('crawlDjIndex.ajax_captcha', { ms: Date.now() - start })
    return { ok: false, end: false, dataHtml: '' }
  }
  if (!json.success && !json.end) {
    return { ok: false, end: false, dataHtml: '' }
  }
  return { ok: true, end: !!json.end, dataHtml: json.data ?? '' }
}

export type Fetch1001Opts = {
  brightdataApiKey?: string
  homeProxyUrl?: string
  homeProxyToken?: string
  state?: ChallengeState
  log?: Logger
}

/**
 * Fetch a 1001tracklists page using the same residential-IP-forwarder →
 * BrightData Web Unlocker → direct cascade as `fetchTracklist`, but returning
 * the raw HTML so the caller can apply whatever parser fits.
 *
 * Any of the failure modes that already cause us to fall through (CF shell,
 * IP block, transport error) are mirrored here. We do NOT retry the
 * BrightData attempt — DJ index pages are less captcha-prone than tracklist
 * pages, and a retry loop here would compound BrightData spend across many
 * pages per cron run.
 */
export async function fetch1001Html(
  url: string,
  opts: Fetch1001Opts = {},
): Promise<{ html: string; via: 'home-proxy' | 'unlocker' | 'direct'; state: ChallengeState }> {
  const log = opts.log
  const haveHomeProxy = !!(opts.homeProxyUrl && opts.homeProxyToken)
  log?.info('fetch1001.start', { url, viaHomeProxy: haveHomeProxy, viaUnlocker: !!opts.brightdataApiKey })

  if (haveHomeProxy) {
    const r = await fetchViaHomeProxy(url, opts.homeProxyUrl!, opts.homeProxyToken!, log)
    if (r.html && !isIPBlocked(r.html) && !looksLikeCfShell(r.html)) {
      return { html: r.html, via: 'home-proxy', state: opts.state ?? { cookie: '' } }
    }
    log?.warn('fetch1001.homeproxy_unusable', {
      url,
      status: r.status,
      htmlBytes: r.html?.length ?? 0,
      reason: !r.html ? 'no_body' : isIPBlocked(r.html) ? 'ip_blocked' : 'cf_shell',
    })
  }

  if (opts.brightdataApiKey) {
    const r = await fetchViaUnlocker(url, opts.brightdataApiKey, log)
    if (!r.html) {
      const detail = r.errorCode ? `${r.errorCode}: ${r.errorMessage ?? ''}` : `status ${r.status}`
      throw new Error(`unlocker fetch failed for ${url} — ${detail}`)
    }
    if (isIPBlocked(r.html)) {
      throw new IPBlockedError(extractIPBlockedAddress(r.html))
    }
    if (looksLikeCfShell(r.html)) {
      throw new CloudflareChallengeError(`unlocker fetched a CF shell for ${url} (${r.html.length} bytes)`)
    }
    return { html: r.html, via: 'unlocker', state: opts.state ?? { cookie: '' } }
  }

  const { html, state } = await fetchHtml(url, opts.state)
  return { html, via: 'direct', state }
}
