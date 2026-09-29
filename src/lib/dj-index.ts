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
import { fetchWithTimeout, type ChallengeState } from './fetch'
import { fetch1001, type Fetch1001Opts as CascadeOpts, type Via } from './upstream1001'
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
  // The H1 was `h1.titleNameH1` "<Artist> Tracklists Overview" until mid
  // 2026; since the July 2026 redesign it is `h1#pageTitle` "Tracklists By
  // <Artist>". Accept either and strip the template words so the playlist
  // name is just the artist.
  let artistName: string | null = null
  const h1 = root.querySelector('h1#pageTitle') ?? root.querySelector('h1.titleNameH1') ?? root.querySelector('h1')
  if (h1) {
    const raw = decodeEntities(h1.text).trim().replace(/\s+/g, ' ')
    const trimmed = raw
      .replace(/\s+Tracklists Overview\s*$/i, '')
      .replace(/^Tracklists By\s+/i, '')
      .trim()
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

// 1001tl's DJ-index page is JS infinite-scroll: the initial HTML renders the
// 15 newest sets, and framework.js's `InfiniteScrollEvent` POSTs to
// `/ajax/get_data.php` for more as the visitor scrolls. Since the site's July
// 2026 redesign (between 07-08 and 07-28; the old `iScrollParams.dj` /
// `type=overview` protocol is gone) the scroll list is
//
//   <div class="sDiv " id="sDivTracklists" data-type="artist" data-id="q43lgd">
//     <div class="bItm action oItm" data-id="<tracklist short id>">…</div> ×15
//
// and the form-encoded request is (framework.js?ver=2026-08-29):
//
//   width=<innerWidth>       1920 works
//   type=<data-type>         'artist' on a DJ page
//   idScrollObject=<data-id> the DJ's short id
//   subtype=<data-subtype, else the div id minus 'sDiv', lowercased> 'tracklists'
//   count=10                 the browser's height maths throws and leaves 10
//   pos=<rows shown>         number of .oItm rows currently in the list
//   id=<last row data-id>    data-id of the last .oItm row
//
// Response: { success: true, data: '<10 more .oItm rows>', subType } while
// there is more; `end`, `message` or `success:false` mean stop; `captcha`
// asks for a human check (we stop, never solve it). Measured 2026-09-28: the
// endpoint answers the same rows to an anonymous request as to a logged-in
// one, so it is called direct (no forwarder account spent on it).
const O_ITM_DATA_ID_RE = /<div[^>]*\boItm\b[^>]*\bdata-id="([^"]+)"/g
const SDIV_TAG_RE = /<div\b[^>]*\bclass="[^"]*\bsDiv\b[^"]*"[^>]*>/g
const AJAX_URL = `${ORIGIN}/ajax/get_data.php`
/** Rows per scroll step, as the browser asks for. */
const SCROLL_COUNT = 10

/** Where the next scroll step starts: rows already shown + the last row's data-id. */
export type ScrollCursor = { pos: number; id: string }

type ScrollKeys = { type: string; idScrollObject: string; subtype: string }

export type DjCrawlStopReason = 'end' | 'known' | 'no_new' | 'max_pages' | 'deadline' | 'fetch_failed' | 'no_pagination'

export type DjCrawlResult = {
  artistName: string | null
  /** Head walk + backfill URLs, head first (newest first), de-duplicated. */
  tracklistUrls: string[]
  /** Pages fetched by the head walk (1 = page 1 only). */
  pagesWalked: number
  /** Why the head walk stopped. */
  stopReason: DjCrawlStopReason
  /** Where the head walk left the list (null: end of list reached, or no scroll keys). */
  tail: ScrollCursor | null
  /** Present when a backfill was asked for. */
  backfill?: {
    /** Scroll steps spent on the backfill this call. */
    steps: number
    /** Sets the backfill saw that the head walk had not. */
    added: number
    /** Resume point for the next backfill; null once `done`. */
    cursor: ScrollCursor | null
    /** The end of the DJ's list was reached: the listing is complete. */
    done: boolean
  }
}

function attr(tag: string, name: string): string | null {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? null
}

/**
 * The scroll request keys from a DJ page: the tracklist list's `div.sDiv`
 * (by id `sDivTracklists`, else the first visible sDiv with a data-id), with
 * the page-global `window.scrollObject` / `window.idScrollObject` as fallback —
 * the same precedence framework.js applies.
 */
export function parseScrollKeys(html: string): ScrollKeys | null {
  const tags = [...html.matchAll(SDIV_TAG_RE)].map((m) => m[0])
  const div =
    tags.find((t) => attr(t, 'id') === 'sDivTracklists') ??
    tags.find((t) => !/\bclass="[^"]*\bhidden\b/.test(t) && attr(t, 'data-id'))
  const type = (div && attr(div, 'data-type')) || html.match(/window\.scrollObject\s*=\s*["']([^"']+)["']/)?.[1] || null
  const idScrollObject = (div && attr(div, 'data-id')) || html.match(/window\.idScrollObject\s*=\s*["']([^"']+)["']/)?.[1] || null
  const divId = div ? attr(div, 'id') : null
  const subtype = (div && attr(div, 'data-subtype')) || (divId && divId.length > 4 ? divId.slice(4).toLowerCase() : 'tracklists')
  if (!type || !idScrollObject) return null
  return { type, idScrollObject, subtype }
}

function oItmIds(html: string): string[] {
  O_ITM_DATA_ID_RE.lastIndex = 0
  return [...html.matchAll(O_ITM_DATA_ID_RE)].map((m) => m[1]!)
}

/**
 * Walk a DJ's index: page 1 through the fetch cascade, then the site's own
 * infinite-scroll endpoint, 10 sets per step.
 *
 * **Request budget.** Every step is a request to a site that rate-blocks and
 * flags this project, so the walk is incremental rather than exhaustive:
 *
 * - The *head walk* goes from the top and stops at the first page that shows
 *   a set in `knownUrls` (`known`): everything newer than a known set has now
 *   been seen. For a DJ already in the database that is page 1 itself, so the
 *   steady state is zero scroll requests. `maxPages` caps it (page 1 counts).
 * - The *backfill* reaches older history a few steps per call: it resumes
 *   from `backfill.from` (a cursor a previous call returned; null = start
 *   where the head walk stopped) and takes at most `backfill.maxSteps`
 *   steps. The caller stores the returned cursor and decides how often to
 *   spend more; `done` means the list's end was reached.
 *
 * Other stops: `end` (the site says there is no more), `no_new` (a head step
 * added nothing), `deadline` (wall clock), `fetch_failed` (a step threw or
 * was refused — what was collected is kept), `no_pagination` (page 1 has no
 * scroll keys: the markup changed again; see the log `no_pagination_keys`).
 */
export async function crawlDjIndex(
  slug: string,
  opts: Fetch1001Opts & {
    maxPages?: number
    deadlineMs?: number
    knownUrls?: ReadonlySet<string>
    backfill?: { from: ScrollCursor | null; maxSteps: number }
  } = {},
): Promise<DjCrawlResult> {
  const maxPages = opts.maxPages ?? 4
  const log = opts.log
  const known = opts.knownUrls ?? new Set<string>()

  let page1Html: string
  try {
    const r = await fetch1001Html(`${ORIGIN}/dj/${slug}/index.html`, opts)
    page1Html = r.html
  } catch (e) {
    log?.warn('crawlDjIndex.page1_failed', { slug, error: e instanceof Error ? e.message : String(e) })
    return { artistName: null, tracklistUrls: [], pagesWalked: 0, stopReason: 'fetch_failed', tail: null }
  }
  const parsed1 = parseDjIndex(page1Html)
  const seenSet = new Set<string>(parsed1.tracklistUrls)
  const all: string[] = [...parsed1.tracklistUrls]
  let pagesWalked = 1
  const reachedKnown1 = parsed1.tracklistUrls.some((u) => known.has(u))
  log?.info('crawlDjIndex.page_done', {
    slug,
    page: 1,
    via: 'static',
    urlsOnPage: parsed1.tracklistUrls.length,
    addedNew: parsed1.tracklistUrls.length,
    reachedKnown: reachedKnown1,
  })

  const keys = parseScrollKeys(page1Html)
  const rows1 = oItmIds(page1Html)
  if (!keys || rows1.length === 0 || parsed1.tracklistUrls.length === 0) {
    log?.warn('crawlDjIndex.no_pagination_keys', {
      slug,
      hasScrollKeys: !!keys,
      rowsOnPage1: rows1.length,
      urlsOnPage1: parsed1.tracklistUrls.length,
    })
    return { artistName: parsed1.artistName, tracklistUrls: all, pagesWalked, stopReason: 'no_pagination', tail: null }
  }

  const step = async (cursor: ScrollCursor, phase: string, n: number) => {
    const chunk = await fetchInfiniteScrollChunk({ ...keys, pos: cursor.pos, dataId: cursor.id, refererSlug: slug }, opts)
    if (!chunk.ok) {
      log?.warn('crawlDjIndex.ajax_not_ok', { slug, phase, step: n })
      return null
    }
    const rows = oItmIds(chunk.dataHtml)
    const urls = extractTracklistUrls(chunk.dataHtml)
    let added = 0
    for (const u of urls) {
      if (!seenSet.has(u)) {
        seenSet.add(u)
        all.push(u)
        added++
      }
    }
    const end = chunk.end || rows.length === 0
    const next: ScrollCursor | null = end ? null : { pos: cursor.pos + rows.length, id: rows[rows.length - 1]! }
    const reachedKnown = urls.some((u) => known.has(u))
    log?.info('crawlDjIndex.page_done', { slug, phase, step: n, via: 'ajax', urlsOnPage: urls.length, addedNew: added, end, reachedKnown })
    return { added, end, next, reachedKnown }
  }

  // ── Head walk: from the top down to the first known set. ────────────────
  let tail: ScrollCursor | null = { pos: rows1.length, id: rows1[rows1.length - 1]! }
  let stopReason: DjCrawlStopReason = reachedKnown1 ? 'known' : 'max_pages'
  if (!reachedKnown1) {
    for (let page = 2; page <= maxPages; page++) {
      if (opts.deadlineMs && Date.now() >= opts.deadlineMs) {
        log?.warn('crawlDjIndex.deadline', { slug, pagesWalked })
        stopReason = 'deadline'
        break
      }
      let s: Awaited<ReturnType<typeof step>>
      try {
        s = await step(tail!, 'head', page)
      } catch (e) {
        log?.warn('crawlDjIndex.ajax_failed', { slug, page, error: e instanceof Error ? e.message : String(e) })
        s = null
      }
      if (!s) {
        stopReason = 'fetch_failed'
        break
      }
      pagesWalked++
      tail = s.next
      if (s.end) {
        stopReason = 'end'
        break
      }
      if (s.reachedKnown) {
        stopReason = 'known'
        break
      }
      if (s.added === 0) {
        stopReason = 'no_new'
        break
      }
    }
  }
  const result: DjCrawlResult = { artistName: parsed1.artistName, tracklistUrls: all, pagesWalked, stopReason, tail }

  // ── Backfill: a few steps further into the DJ's history. ────────────────
  if (opts.backfill) {
    const bf = { steps: 0, added: 0, cursor: opts.backfill.from ?? tail, done: false }
    if (stopReason === 'end') {
      bf.cursor = null
      bf.done = true
    } else if (bf.cursor && stopReason !== 'fetch_failed' && stopReason !== 'deadline') {
      while (bf.steps < opts.backfill.maxSteps) {
        if (opts.deadlineMs && Date.now() >= opts.deadlineMs) break
        let s: Awaited<ReturnType<typeof step>>
        try {
          s = await step(bf.cursor!, 'backfill', bf.steps + 1)
        } catch (e) {
          log?.warn('crawlDjIndex.ajax_failed', { slug, phase: 'backfill', error: e instanceof Error ? e.message : String(e) })
          s = null
        }
        if (!s) break // keep the cursor: the next call retries the same step
        bf.steps++
        bf.added += s.added
        bf.cursor = s.next
        if (s.end) {
          bf.done = true
          break
        }
      }
    }
    result.backfill = bf
    log?.info('crawlDjIndex.backfill', { slug, ...bf })
  }
  return result
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
 * POST /ajax/get_data.php with the form-encoded scroll cursor, direct from
 * the Worker. Anonymous requests get the same rows as logged-in ones
 * (2026-09-28), so no forwarder account is spent here; if this starts
 * answering non-JSON / captcha from Cloudflare's egress, the walk stops at
 * what it has (`crawlDjIndex.ajax_*` warnings) rather than retrying.
 */
async function fetchInfiniteScrollChunk(
  cursor: ScrollKeys & { pos: number; dataId: string; refererSlug: string },
  opts: Fetch1001Opts,
): Promise<{ ok: boolean; end: boolean; dataHtml: string }> {
  const body = new URLSearchParams({
    width: '1920',
    type: cursor.type,
    idScrollObject: cursor.idScrollObject,
    subtype: cursor.subtype,
    count: String(SCROLL_COUNT),
    pos: String(cursor.pos),
    id: cursor.dataId,
  })
  const referer = `${ORIGIN}/dj/${cursor.refererSlug}/index.html`
  const start = Date.now()
  const res = await fetchWithTimeout(AJAX_URL, {
    method: 'POST',
    timeoutMs: 8000,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
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
  let json: { success?: boolean; end?: unknown; data?: string; captcha?: boolean; message?: string }
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
  // framework.js ends the list on `message` or on any defined `end`.
  const end = json.end !== undefined || json.message !== undefined
  if (!json.success && !end) {
    opts.log?.warn('crawlDjIndex.ajax_unsuccessful', { ms: Date.now() - start, body: text.slice(0, 300) })
    return { ok: false, end: false, dataHtml: '' }
  }
  return { ok: true, end, dataHtml: json.success ? (json.data ?? '') : '' }
}

/** Options for the shared 1001tracklists fetch cascade — see lib/upstream1001.ts. */
export type Fetch1001Opts = Omit<CascadeOpts, 'method' | 'form' | 'accept' | 'unlockerAttempts'>

/**
 * Fetch a 1001tracklists page through the shared cascade (home forwarder →
 * BrightData within budget → direct) and return the raw HTML so the caller
 * can apply whatever parser fits. One BrightData attempt only — DJ index
 * pages are less captcha-prone than tracklist pages, and a retry loop here
 * would compound BrightData spend across many pages per cron run.
 *
 * Throws `UpstreamPausedError` when fetching is deliberately paused (every
 * route blocked) and `IPBlockedError` when the last route was itself blocked;
 * see lib/upstream1001.ts. Callers running a batch should stop on either.
 */
export async function fetch1001Html(
  url: string,
  opts: Fetch1001Opts = {},
): Promise<{ html: string; via: Via; state: ChallengeState }> {
  const r = await fetch1001(url, { ...opts, unlockerAttempts: 1 })
  return { html: r.html, via: r.via, state: r.state }
}
