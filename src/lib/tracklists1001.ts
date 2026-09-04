import { parse, type HTMLElement } from 'node-html-parser'
import type { ParsedTrack } from '../types'
import { fetchHtml, fetchWithTimeout, postForm, isIPBlocked, extractIPBlockedAddress, IPBlockedError, looksLikeCfShell, CloudflareChallengeError, type ChallengeState } from './fetch'
import { fetchViaUnlocker } from './unlocker'
import { fetchViaHomeProxy } from './homeProxy'
import { parseSetYouTubeId } from './dj-index'
import type { Logger } from './log'

const ORIGIN = 'https://www.1001tracklists.com'

/** Source codes used by 1001tracklists' medialink AJAX. */
const SOURCE = {
  BEATPORT: '1',
  APPLE: '2',
  TRAXSOURCE: '4',
  SOUNDCLOUD: '10',
  YOUTUBE: '13',
  SPOTIFY: '36',
} as const

export type SearchResult = { tracklistUrl: string } | { tracklistUrl: null }

export async function searchByYouTubeUrl(
  videoUrl: string,
  state?: ChallengeState,
  log?: Logger,
): Promise<{ result: SearchResult; state: ChallengeState }> {
  log?.info('1001search.start', { videoUrl })
  const start = Date.now()
  const { html, state: s2 } = await postForm(
    `${ORIGIN}/search/result.php`,
    {
      main_search: videoUrl,
      search_selection: '9',
      orderby: 'added',
      'MediaSource[13]': '13',
    },
    state,
  )
  const { result, echo, textFallback } = parseUrlSearchResult(html, videoUrl)
  if (textFallback) {
    log?.warn('1001search.text_fallback', { videoUrl, echo, htmlBytes: html.length, ms: Date.now() - start })
  }
  log?.info('1001search.done', { videoUrl, htmlBytes: html.length, tracklistUrl: result.tracklistUrl, textFallback, ms: Date.now() - start })
  return { result, state: s2 }
}

/**
 * The query 1001tl actually ran, as echoed in the page `<title>`
 * (`Tracklists search result for "…"`). Present on every results page, empty
 * result sets included; null only if the page is not a search results page.
 */
export function parseSearchQueryEcho(html: string): string | null {
  const m = html.match(/<title>\s*Tracklists search result for &quot;(.*?)&quot;\s*<\/title>/s)
  return m ? decodeEntities(m[1]!) : null
}

/** Video id from a youtube.com/watch?v= or youtu.be/ URL; null if neither. */
function youTubeIdFromUrl(url: string): string | null {
  return url.match(/[?&]v=([A-Za-z0-9_-]{11})(?:[&#]|$)/)?.[1] ?? url.match(/youtu\.be\/([A-Za-z0-9_-]{11})(?:[?&#]|$)/)?.[1] ?? null
}

/**
 * Parse a YouTube-URL search page, guarding against 1001tl's silent text
 * fallback. A genuine media-link search returns only tracklists carrying that
 * link and echoes the URL verbatim. But 1001tl sanitizes the query before
 * matching it as a URL, replacing the hyphens of a video id that contains two
 * or more of them with spaces (`watch?v=-R-Lmvn7sVg` → `watch?v= R Lmvn7sVg`).
 * The mangled string no longer parses as a media link, so the site runs a
 * plain word search on the URL's tokens ("youtube", "watch", …) ordered
 * newest-first and returns a full page of unrelated tracklists. Detect that
 * by checking the echoed query still contains the video id we sent; when it
 * does not, report no match so the caller falls through to a title search.
 */
export function parseUrlSearchResult(
  html: string,
  videoUrl: string,
): { result: SearchResult; echo: string | null; textFallback: boolean } {
  const echo = parseSearchQueryEcho(html)
  const videoId = youTubeIdFromUrl(videoUrl)
  const textFallback = echo !== null && (videoId ? !echo.includes(videoId) : echo !== videoUrl)
  if (textFallback) return { result: { tracklistUrl: null }, echo, textFallback }
  return { result: parseSearchResult(html), echo, textFallback }
}

/** A single tracklist row on a `/search/result.php` results page. */
export type TracklistCandidate = { tracklistUrl: string; title: string }

/**
 * Parse every tracklist result row (`div.bItm.action.oItm`) into a
 * {url, visible title} pair. The URL comes from the row's `window.open(...)`
 * onclick; the title from the `.bTitle a` anchor. Order is preserved (the page
 * orders by whatever `orderby` was posted — default `added`, newest first).
 */
export function parseSearchResults(html: string): TracklistCandidate[] {
  const root = parse(html)
  const rows = root.querySelectorAll('div.bItm.action.oItm')
  const out: TracklistCandidate[] = []
  for (const r of rows) {
    const onclick = r.getAttribute('onclick') ?? ''
    const m = onclick.match(/window\.open\('(\/tracklist\/[^']+)'/)
    if (!m) continue
    const anchor = r.querySelector('div.bTitle a') ?? r.querySelector('.bTitle')
    const title = decodeEntities((anchor?.text ?? '').trim())
    out.push({ tracklistUrl: ORIGIN + m[1], title })
  }
  return out
}

export function parseSearchResult(html: string): SearchResult {
  const first = parseSearchResults(html)[0]
  return { tracklistUrl: first ? first.tracklistUrl : null }
}

/**
 * Tracklist text-search (search_selection=9, no media-source filter) — used as
 * a fallback when we don't have (or couldn't confirm) a YouTube URL to pin the
 * match. 1001tl returns any tracklist whose name matches the query text, so we
 * rank the rows against `title` and only accept a confident match (or a lone
 * result). Returns the same {tracklistUrl|null} shape as searchByYouTubeUrl.
 */
export async function searchByTitle(
  title: string,
  state?: ChallengeState,
  log?: Logger,
): Promise<{ result: SearchResult; state: ChallengeState }> {
  log?.info('1001titlesearch.start', { title })
  const start = Date.now()
  const { html, state: s2 } = await postForm(
    `${ORIGIN}/search/result.php`,
    { main_search: title, search_selection: '9', orderby: 'added' },
    state,
  )
  const candidates = parseSearchResults(html)
  const best = pickBestTracklist(title, candidates)
  log?.info('1001titlesearch.done', {
    title,
    htmlBytes: html.length,
    candidateCount: candidates.length,
    candidates: candidates.slice(0, 8).map((c) => ({ title: c.title, url: c.tracklistUrl })),
    chosen: best ? { title: best.title, url: best.tracklistUrl, score: Number(best.score.toFixed(3)) } : null,
    ms: Date.now() - start,
  })
  return { result: { tracklistUrl: best ? best.tracklistUrl : null }, state: s2 }
}

/** Lowercase, drop punctuation to spaces, collapse whitespace. */
function normText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/**
 * Boilerplate tokens that carry no matching signal in a DJ-set title: articles
 * and the YouTube-title cruft that never appears in 1001tl's canonical title
 * ("4hr set", "official video", "full set", …). Stripped before scoring so they
 * don't dilute the token overlap. NOT a venue/geography list — those are
 * downweighted dynamically via IDF (see pickBestTracklist), because "which words
 * are boilerplate" depends on the result set (a search full of Club Space Miami
 * sets makes "space/miami" uninformative; a different search wouldn't).
 */
const NOISE_TOKENS = new Set([
  'the', 'a', 'an', 'set', 'live', 'liveset', 'dj', 'mix', 'full', 'fullset',
  'official', 'video', 'audio', 'hd', 'hq', '4k', '1080p', '720p',
])
const DURATION_TOKEN = /^\d+(h|hr|hrs|hour|hours|min|mins|m)$/

/** Significant (non-noise) tokens of a title, as a set. */
function sigTokens(s: string): Set<string> {
  const out = new Set<string>()
  for (const t of normText(s).split(' ')) {
    if (!t || NOISE_TOKENS.has(t) || DURATION_TOKEN.test(t)) continue
    out.add(t)
  }
  return out
}

/**
 * Pairwise title similarity in [0,1] with no result-set context: exact = 1,
 * containment = 0.9, else token overlap coefficient (|shared| / |smaller set|).
 * Overlap coefficient (not Jaccard) so a noisy query — the YouTube title with
 * an extra date / "4hr set" — isn't penalized for its surplus tokens. Used as
 * the fallback when there's only one candidate (no IDF signal to weight with).
 */
export function scoreTitleMatch(query: string, candidate: string): number {
  const nq = normText(query)
  const nc = normText(candidate)
  if (!nq || !nc) return 0
  if (nq === nc) return 1
  if (nq.includes(nc) || nc.includes(nq)) return 0.9
  const tq = sigTokens(query)
  const tc = sigTokens(candidate)
  if (tq.size === 0 || tc.size === 0) return 0
  let inter = 0
  for (const t of tc) if (tq.has(t)) inter++
  return inter / Math.min(tq.size, tc.size)
}

/**
 * Pick the tracklist that best matches `query` from 1001tl's search rows.
 *
 * Two hard facts about this data shaped the algorithm:
 *  1. Same-venue sets share an IDENTICAL visible title ("Gorgon City @ Club
 *     Space Miami, United States" appears 7× for different dates — the date is
 *     only in the URL). So a text score literally cannot pick the right date;
 *     only 1001tl's own ranking (which sees the date) can. We therefore walk
 *     candidates in 1001tl's order and take the FIRST that clears the bar,
 *     rather than re-sorting by score.
 *  2. Venue/geography words ("club space miami united states") are shared
 *     boilerplate across most results, so overlap on them is meaningless. We
 *     weight each token by IDF over the candidate set — tokens common across
 *     results (venue) count little; rare tokens (the artist/event) count a lot —
 *     and require the match to include a distinctive shared token, so a query
 *     that only shares the venue with an unrelated set is rejected.
 *
 * Score = IDF-weighted coverage of a candidate's tokens by the query, i.e. "how
 * much of this tracklist's distinctive identity does the query account for."
 * Returns null when nothing clears the bar — better "not found" than a
 * confidently-wrong tracklist.
 */
export function pickBestTracklist(
  query: string,
  candidates: TracklistCandidate[],
): (TracklistCandidate & { score: number }) | null {
  if (candidates.length === 0) return null
  if (candidates.length === 1) {
    const score = scoreTitleMatch(query, candidates[0]!.title)
    // A lone hit for a specific set query is almost always right; require only
    // that it shares some real token, to reject a totally unrelated single row.
    return score > 0 ? { ...candidates[0]!, score } : null
  }

  const N = candidates.length
  const qt = sigTokens(query)
  const cts = candidates.map((c) => sigTokens(c.title))
  const df = new Map<string, number>()
  for (const ct of cts) for (const t of ct) df.set(t, (df.get(t) ?? 0) + 1)
  const idf = (t: string) => Math.log((N + 1) / ((df.get(t) ?? 0) + 1)) + 1
  // A token is "boilerplate" only when it recurs across most of the result set.
  const isCommon = (t: string) => (df.get(t) ?? 0) > N / 2

  const ACCEPT = 0.5
  let best: (TracklistCandidate & { score: number }) | null = null
  for (let i = 0; i < N; i++) {
    const c = candidates[i]!
    const nq = normText(query)
    const nc = normText(c.title)
    let score: number
    if (nq === nc || (nc && (nq.includes(nc) || nc.includes(nq)))) {
      score = 0.95
    } else {
      const ct = cts[i]!
      const shared = [...ct].filter((t) => qt.has(t))
      const distinctive = shared.some((t) => !isCommon(t))
      if (shared.length < 2 || !distinctive) {
        score = 0
      } else {
        let num = 0
        for (const t of shared) num += idf(t)
        let den = 0
        for (const t of ct) den += idf(t)
        score = den > 0 ? num / den : 0
      }
    }
    if (!best || score > best.score) best = { ...c, score }
    if (score >= ACCEPT) return { ...c, score } // first over the bar, in 1001tl relevance order
  }
  return null
}

/**
 * Normalize a user-supplied 1001tracklists tracklist URL to its canonical
 * `https://www.1001tracklists.com/tracklist/<id>/<name>.html` form. Accepts:
 *   https://www.1001tracklists.com/tracklist/l3uw499/matroda-....html
 *   www.1001tracklists.com/tracklist/l3uw499/matroda-....html   (no scheme)
 *   1001tracklists.com/tracklist/l3uw499                        (id only)
 *   https://.../tracklist/l3uw499/...html?foo=bar#frag          (query/frag dropped)
 *
 * Rejects anything that isn't a 1001tracklists tracklist URL (DJ pages, other
 * hosts, bare slugs). Returns null on reject.
 */
export function normalizeTracklistUrl(input: string): string | null {
  const s = input.trim()
  if (!s) return null
  const urlStr = /^https?:\/\//i.test(s) ? s : `https://${s}`
  let u: URL
  try {
    u = new URL(urlStr)
  } catch {
    return null
  }
  if (!/^(www\.)?1001tracklists\.com$/i.test(u.hostname)) return null
  // Path must be /tracklist/<id>[/<name>...]. The id is 1001tl's short
  // alphanumeric slug (e.g. "l3uw499").
  const m = u.pathname.match(/^\/tracklist\/[a-z0-9]+(?:\/[^?#]*)?$/i)
  if (!m) return null
  // Drop query/fragment; force the canonical www host.
  return `${ORIGIN}${u.pathname}`
}

export type ScrapedTracklist = {
  slug: string
  /** Apple Music album/playlist link for the whole set, when 1001tl embeds one. null otherwise. */
  setAppleLink: string | null
  /** YouTube watch URL for the set's primary recording, when 1001tl embeds one. null otherwise. */
  setYoutubeLink: string | null
  /** SoundCloud widget-player URL for the whole set's recording, when 1001tl embeds one. null otherwise. */
  setSoundcloudLink: string | null
  tracks: ParsedTrack[]
}

export type FetchTracklistOpts = {
  /** When set, route through Bright Data Web Unlocker (handles the captcha gate
   *  1001tracklists serves to Cloudflare Worker IPs). When absent, fetch directly
   *  — fine from a residential IP, fails on Workers. */
  brightdataApiKey?: string
  /** When both are set, try the residential-IP forwarder FIRST. On any failure
   *  (transport error, CF shell, IP block, zero-track parse) we fall through
   *  to BrightData if its key is set, else direct. Free + same residential-IP
   *  characteristics that already work in dev. */
  homeProxyUrl?: string
  homeProxyToken?: string
  state?: ChallengeState
  log?: Logger
}

export async function fetchTracklist(
  tracklistUrl: string,
  opts: FetchTracklistOpts = {},
): Promise<{ result: ScrapedTracklist; state: ChallengeState }> {
  const log = opts.log
  const haveHomeProxy = !!(opts.homeProxyUrl && opts.homeProxyToken)
  log?.info('1001scrape.start', {
    tracklistUrl,
    viaHomeProxy: haveHomeProxy,
    viaUnlocker: !!opts.brightdataApiKey,
  })
  const start = Date.now()

  // Attempt 0: residential-IP forwarder. Cheap (free) and uses the same kind
  // of IP that already works in dev. On any failure mode that the BrightData
  // path also handles (CF shell, IP block, transport, zero-track parse) we
  // fall through to BrightData rather than surfacing the error — the home
  // proxy is the preferred path, not the only path.
  if (haveHomeProxy) {
    const r = await fetchViaHomeProxy(tracklistUrl, opts.homeProxyUrl!, opts.homeProxyToken!, log)
    if (r.html) {
      if (isIPBlocked(r.html)) {
        const clientIp = extractIPBlockedAddress(r.html)
        log?.warn('1001scrape.homeproxy_ip_blocked_falling_back', { tracklistUrl, clientIp, htmlBytes: r.html.length, fallback: opts.brightdataApiKey ? 'brightdata' : 'direct' })
      } else if (looksLikeCfShell(r.html)) {
        log?.warn('1001scrape.homeproxy_cf_shell_falling_back', { tracklistUrl, htmlBytes: r.html.length, fallback: opts.brightdataApiKey ? 'brightdata' : 'direct' })
      } else {
        const result = parseTracklist(tracklistUrl, r.html)
        if (result.tracks.length > 0) {
          log?.info('1001scrape.parsed_homeproxy', {
            tracklistUrl,
            htmlBytes: r.html.length,
            trackCount: result.tracks.length,
            unidentifiedCount: result.tracks.filter((t) => t.isUnidentified).length,
            mashupLinkedCount: result.tracks.filter((t) => t.isMashupLinked).length,
            ms: Date.now() - start,
          })
          return { result, state: opts.state ?? { cookie: '' } }
        }
        log?.warn('1001scrape.homeproxy_zero_tracks_falling_back', { tracklistUrl, htmlBytes: r.html.length, fallback: opts.brightdataApiKey ? 'brightdata' : 'direct' })
        logEmptyParseDiagnostics(r.html, tracklistUrl, log)
      }
    } else {
      log?.warn('1001scrape.homeproxy_unusable_falling_back', { tracklistUrl, status: r.status, errorMessage: r.errorMessage, fallback: opts.brightdataApiKey ? 'brightdata' : 'direct' })
    }
  }

  if (opts.brightdataApiKey) {
    // Up to 2 attempts: BrightData rotates exit IP between calls, so a CF
    // shell on attempt 1 (residential IP without fresh CF clearance) often
    // clears on attempt 2.
    const MAX_ATTEMPTS = 2
    let lastShellBytes = 0
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // NOTE: tried passing `expectElement: 'div.tlpItem'` (BrightData's
      // x-unblock-expect header) here. Documented as the right primitive
      // for "wait for the tracklist to actually render before returning,"
      // but on the /request REST endpoint it made things strictly worse —
      // every probe came back as a CF shell where without the header the
      // same URL succeeded. Best guess: when Unlocker's expect-loop times
      // out it returns a best-effort shell instead of erroring, masking the
      // success path that previously fired immediately. Keeping the
      // expectElement plumbing in unlocker.ts so we can opt back in if
      // BrightData fixes / clarifies the REST behavior, but not using it
      // by default. Country=us pin alone is what's actually working.
      const r = await fetchViaUnlocker(tracklistUrl, opts.brightdataApiKey, log)
      if (!r.html) {
        const detail = r.errorCode ? `${r.errorCode}: ${r.errorMessage ?? ''}` : `status ${r.status}`
        log?.error('1001scrape.unlocker_failed', { tracklistUrl, status: r.status, errorCode: r.errorCode, errorMessage: r.errorMessage, attempt })
        throw new Error(`unlocker tracklist fetch failed — ${detail}`)
      }
      if (isIPBlocked(r.html)) {
        const clientIp = extractIPBlockedAddress(r.html)
        log?.error('1001scrape.unlocker_ip_blocked', { tracklistUrl, clientIp, htmlBytes: r.html.length, attempt })
        throw new IPBlockedError(clientIp)
      }
      if (looksLikeCfShell(r.html)) {
        lastShellBytes = r.html.length
        if (attempt < MAX_ATTEMPTS) {
          log?.warn('1001scrape.unlocker_cf_shell_retry', { tracklistUrl, htmlBytes: r.html.length, attempt })
          continue
        }
        log?.error('1001scrape.unlocker_cf_shell', { tracklistUrl, htmlBytes: r.html.length, attempt, attempts: MAX_ATTEMPTS })
        throw new CloudflareChallengeError(`unlocker fetched a CF shell page for ${tracklistUrl} after ${MAX_ATTEMPTS} attempts (last ${lastShellBytes} bytes)`)
      }
      const result = parseTracklist(tracklistUrl, r.html)
      log?.info('1001scrape.parsed', {
        tracklistUrl,
        htmlBytes: r.html.length,
        trackCount: result.tracks.length,
        unidentifiedCount: result.tracks.filter((t) => t.isUnidentified).length,
        mashupLinkedCount: result.tracks.filter((t) => t.isMashupLinked).length,
        ms: Date.now() - start,
        attempt,
      })
      if (result.tracks.length === 0) logEmptyParseDiagnostics(r.html, tracklistUrl, log)
      return { result, state: opts.state ?? { cookie: '' } }
    }
    // Unreachable — loop either returns or throws.
    throw new Error('unlocker retry loop exited unexpectedly')
  }
  const { html, state: s2 } = await fetchHtml(tracklistUrl, opts.state)
  const result = parseTracklist(tracklistUrl, html)
  log?.info('1001scrape.parsed_direct', {
    tracklistUrl,
    htmlBytes: html.length,
    trackCount: result.tracks.length,
    ms: Date.now() - start,
  })
  if (result.tracks.length === 0) logEmptyParseDiagnostics(html, tracklistUrl, log)
  return { result, state: s2 }
}

/**
 * When a scrape parses 0 tracks, log a fingerprint of the response so we can
 * tell at a glance whether 1001tl renamed selectors / changed layout (bug),
 * served a captcha (transient), or returned a real empty page. No raw HTML.
 */
function logEmptyParseDiagnostics(html: string, tracklistUrl: string, log?: Logger): void {
  if (!log) return
  const sample = (re: RegExp, n = 1) => {
    const m = html.match(re)
    return m ? m.slice(0, n) : null
  }
  log.warn('1001scrape.empty_diagnostics', {
    tracklistUrl,
    htmlBytes: html.length,
    hasTurnstile: /turnstile|cf-mitigated|sitekey/.test(html),
    hasUnblockIp: /unblock_ip\.html/.test(html),
    tlpItemCount: (html.match(/tlpItem/g) ?? []).length,
    cueValueEntries: (html.match(/cueValuesEntry\.seconds/g) ?? []).length,
    metaNameCount: (html.match(/itemprop="name"/g) ?? []).length,
    contentDivCount: (html.match(/id="tlp\d+_content"/g) ?? []).length,
    hasJsBuffer: /jsbuffer|jsAsyncReady/.test(html),
    titleHint: sample(/<title>([^<]{1,140})/)?.[0]?.slice(0, 200) ?? null,
    classListSample: [...new Set((html.match(/class="[a-zA-Z][^"]{0,40}"/g) ?? []).slice(0, 30))].slice(0, 15),
    bodyTail: html.slice(-400),
  })
}

export function parseTracklist(tracklistUrl: string, html: string): ScrapedTracklist {
  const root = parse(html)
  const slug = tracklistUrl.match(/\/tracklist\/([^/]+)\//)?.[1] ?? tracklistUrl

  const cueMap = parseCueValueData(html)
  const rows = root.querySelectorAll('div.tlpItem')
  const tracks: ParsedTrack[] = []
  for (const row of rows) {
    const t = parseRow(row, cueMap)
    if (t) tracks.push(t)
  }

  return {
    slug,
    setAppleLink: extractSetAppleLink(html),
    setYoutubeLink: extractSetYouTubeLink(html),
    setSoundcloudLink: extractSetSoundcloudLink(html),
    tracks,
  }
}

/**
 * YouTube watch URL for the set's primary recording. Delegates to
 * parseSetYouTubeId (dj-index.ts), which already knows every way 1001tl has
 * embedded the player over time (embed iframe, og:video, data attributes,
 * JS variables) and returns the first hit — the main media lives near the
 * top of the page, above any incidental per-track references.
 */
export function extractSetYouTubeLink(html: string): string | null {
  const id = parseSetYouTubeId(html)
  return id ? `https://www.youtube.com/watch?v=${id}` : null
}

/**
 * SoundCloud recording of the whole set. 1001tl embeds it in the media-tabs
 * section as a widget iframe wrapping `api.soundcloud.com/tracks/<id>`.
 * Per-track SoundCloud links never appear in the page HTML (they come from
 * the medialink AJAX), so the first tracks/<id> reference is the set's own.
 * Returned in the same widget-player form as MediaLinks.soundcloudLink.
 */
export function extractSetSoundcloudLink(html: string): string | null {
  const m = html.match(/api\.soundcloud\.com\/tracks\/(\d+)/)
  if (!m) return null
  return `https://w.soundcloud.com/player/?url=${encodeURIComponent(`https://api.soundcloud.com/tracks/${m[1]}`)}`
}

/**
 * 1001tracklists emits a JS block (`cueValueData`) that maps each cued track's
 * inner content id (`tlp{N}_content`) to its cue in seconds. The hidden form
 * input `_cue_seconds` defaults to "0" for uncued rows (mashup-linked siblings,
 * trailing untimed extras), so reading the input alone makes those rows look
 * like they start at 0:00. The JS map only contains real cues, so use it as
 * the source of truth and fall back to null for anything not listed.
 *
 * A single `cueValuesEntry` may hold multiple `ids[N]` entries — 1001tl uses
 * `ids[1+]` for additional rows that share the parent cue (e.g. a track and
 * its mashup partner both cued at 12:30). Capture every `ids[N]` so those
 * sibling rows aren't left looking uncued, which would otherwise leave a
 * null gap in the timeline and confuse `selectCurrent`'s range matcher.
 */
export function parseCueValueData(html: string): Map<string, number> {
  const out = new Map<string, number>()
  // Walk each entry block (delimited by `cueValuesEntry = {}`) and pair its
  // .seconds with every .ids[N] in the same block.
  const blocks = html.split(/cueValuesEntry\s*=\s*\{\}/)
  for (const block of blocks) {
    const sm = block.match(/cueValuesEntry\.seconds\s*=\s*(\d+)/)
    if (!sm) continue
    const seconds = Number(sm[1])
    const idRe = /cueValuesEntry\.ids\[\d+\]\s*=\s*'([^']+)'/g
    let im
    while ((im = idRe.exec(block))) {
      out.set(im[1]!, seconds)
    }
  }
  return out
}

/**
 * Some 1001tracklists pages have an Apple Music album for the whole DJ set
 * embedded near the top of the page (in the media-tabs section, parallel to
 * the YouTube video). When present, the iframe src is of the form:
 *   embed.music.apple.com/album/<slug>/<id>/<country>/album/<slug>/<id>?app=music&at=...
 * — the country code lives in the middle of the path after the first
 * /album/<slug>/<id> repeats. We rebuild the canonical user-facing URL.
 */
export function extractSetAppleLink(html: string): string | null {
  const m = html.match(
    /embed\.music\.apple\.com\/album\/[^/"]+\/\d+\/(\w{2})\/album\/([^/"]+)\/(\d+)([^"\s]*)/,
  )
  if (!m) return null
  const [, country, slug, albumId, query] = m
  return `https://music.apple.com/${country}/album/${slug}/${albumId}${query ?? ''}`
}

function parseRow(row: HTMLElement, cueMap: Map<string, number>): ParsedTrack | null {
  const dataId = row.getAttribute('data-id') ?? null
  const cls = row.getAttribute('class') ?? ''
  const isMashupLinked = / con(\s|$)/.test(cls)

  // Source of truth for the cue is the JS-emitted cueValueData map keyed by
  // tlp{N}_content. Rows that aren't in the map (mashup-linked, trailing
  // untimed extras) get null even when their hidden form input reads "0".
  const contentDiv = row.querySelector('[id^="tlp"][id$="_content"]')
  const contentId = contentDiv?.getAttribute('id') ?? ''
  const cueFromMap = cueMap.get(contentId)
  const startSeconds = cueFromMap === undefined ? null : cueFromMap
  const cueDiv = row.querySelector('div.cue')
  const startTime = (cueDiv?.text ?? '').trim()

  const nameMeta = row.querySelector('meta[itemprop="name"]')
  const artistMeta = row.querySelector('meta[itemprop="byArtist"]')
  const fullName = decodeEntities(nameMeta?.getAttribute('content') ?? '')
  const artistRaw = decodeEntities(artistMeta?.getAttribute('content') ?? '')

  if (!fullName) return null

  let title = ''
  let artist = artistRaw
  const dash = fullName.indexOf(' - ')
  if (dash >= 0) {
    const left = fullName.slice(0, dash).trim()
    title = fullName.slice(dash + 3).trim()
    if (!artist) artist = left
  } else {
    title = fullName
  }

  // 1001tl marks partial-ID variants ("ID Remix", "ID Edit", etc.) with a
  // <span class="trackStatus"> next to the title. The base track is known;
  // only the variant is uncertain. We propagate that signal as idStatus.
  const trackStatus = row.querySelector('span.trackStatus')
  const trackStatusText = (trackStatus?.text ?? '').trim()
  const idStatus = trackStatusText && /\bID\b/.test(trackStatusText)
    ? trackStatusText.replace(/^\(|\)$/g, '').trim()
    : null

  // Fully unidentified = the playing track itself has no name (e.g.
  // "Cave Studio - ID"). Partial variants (idStatus set) are NOT unidentified
  // — the artist + title describe the base track and are useful.
  const isUnidentified = idStatus === null && (title === 'ID' || /^ID\b/.test(title) || !artist || artist === 'ID')

  const mediaRow = row.querySelector('div.mediaRow')
  const mediaTrackId = mediaRow?.getAttribute('data-trackid') ?? null

  const urlMeta = row.querySelector('meta[itemprop="url"]')
  const urlPath = urlMeta?.getAttribute('content') ?? ''
  const trackUrl = urlPath ? new URL(urlPath, ORIGIN).toString() : null

  // Album art lives on the row's `img.artM`. Two layouts:
  //   - real art: <img data-src="<CDN URL>" src="/images/static/empty.png" class="artwork artM" …>
  //   - no art: <img src="…/default_100.png" class="artM" …>  (no `artwork` class, no data-src)
  // Prefer data-src; fall back to src. The normalizer maps both placeholders to null.
  const artImg = row.querySelector('img.artM')
  const artRaw = artImg?.getAttribute('data-src') ?? artImg?.getAttribute('src') ?? ''
  const artworkUrl = normalizeArtworkUrl(artRaw)

  return {
    startTime: startTime || (Number.isFinite(startSeconds!) ? formatCue(startSeconds!) : ''),
    startSeconds: Number.isFinite(startSeconds!) ? (startSeconds as number) : null,
    artist,
    title: title || 'ID',
    trackId: mediaTrackId ?? dataId,
    trackUrl,
    artworkUrl,
    isUnidentified,
    idStatus,
    isMashupLinked,
  }
}

/**
 * Normalize a 1001tl-embedded album-art URL to a 300×300 square. Returns null
 * for any of the known placeholders (1001tl's default_100.png + the lazy-load
 * empty.png). Unknown CDNs are passed through unchanged so we still surface
 * something — the contract is "300×300 if we can, raw URL otherwise."
 *
 * Beatport (geo-media.beatport.com) supports any size via dynamic resizer.
 * SoundCloud (i1.sndcdn.com / iN.sndcdn.com) only honors a fixed list of
 * sizes; 300 is in that list so we use it.
 */
export function normalizeArtworkUrl(raw: string): string | null {
  if (!raw) return null
  // 1001tl placeholders — both relative and absolute forms.
  if (
    /\/images\/static\/empty\.png$/.test(raw) ||
    /\/images\/artworks\/default_\d+\.png$/.test(raw)
  ) {
    return null
  }
  // Beatport: image_size/<W>x<H>/<uuid>.<ext>
  const beatport = raw.match(/^(https:\/\/[^/]*beatport\.com\/image_size\/)\d+x\d+(\/[^/?#]+)/)
  if (beatport) return `${beatport[1]}300x300${beatport[2]}`
  // SoundCloud: artworks-<id>-t<W>x<H>.<ext>  (or the named alias forms)
  const sndcdn = raw.match(/^(https:\/\/i\d*\.sndcdn\.com\/artworks-[^.-]+-(?:[^./-]+-)?)t?\d+x\d+(\.[a-z]+)/)
  if (sndcdn) return `${sndcdn[1]}t300x300${sndcdn[2]}`
  // Unknown CDN — pass through unmodified.
  return /^https?:\/\//.test(raw) ? raw : null
}

function formatCue(seconds: number): string {
  const s = Math.floor(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
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
    .replace(/&sdot;/g, '·')
}

export type MediaLinks = {
  appleLink: string | null
  youtubeLink: string | null
  /** SoundCloud widget-player URL (plays free w/ ads in a browser tab, and
   *  yt-dlp can download it without cookies). null when 1001tl has no
   *  SoundCloud source for the track. */
  soundcloudLink: string | null
}

const NO_LINKS: MediaLinks = { appleLink: null, youtubeLink: null, soundcloudLink: null }

type MedialinkResponse = {
  success: boolean
  data?: Array<{ source: string; playerId: string; player?: string }>
  more?: Array<{ source: string; idLink: string; type?: string }>
}

export type FetchMediaLinksOpts = {
  state?: ChallengeState
  log?: Logger
  /** When set, the fallback path is enabled: if a direct CF→1001tl fetch
   *  fails or times out, race a longer direct retry against a BrightData
   *  call (different IP, no captcha needed for the JSON endpoint — it just
   *  works from non-CF IPs). */
  brightdataApiKey?: string
}

/**
 * Resolve per-track Apple Music + YouTube links from 1001tl's medialink
 * AJAX. Strategy:
 *
 *   1. **Direct fetch with a 2s timeout.** Most calls succeed in ~150ms.
 *   2. On timeout/transport failure, race a longer direct retry against a
 *      BrightData fetch via Promise.any. Whichever returns first wins.
 *
 * Background: medialink calls from Cloudflare Worker IPs occasionally hit
 * CF-edge 522s after ~19s — a single stuck call was blocking the whole
 * Worker invocation for 20s. Failing fast at 2s + a second-IP retry both
 * fixes the slow-tail and increases reliability.
 */
export async function fetchMediaLinks(mediaItemId: string, state?: ChallengeState, log?: Logger): Promise<{ result: MediaLinks; state: ChallengeState }>
export async function fetchMediaLinks(mediaItemId: string, opts: FetchMediaLinksOpts): Promise<{ result: MediaLinks; state: ChallengeState }>
export async function fetchMediaLinks(
  mediaItemId: string,
  stateOrOpts?: ChallengeState | FetchMediaLinksOpts,
  maybeLog?: Logger,
): Promise<{ result: MediaLinks; state: ChallengeState }> {
  const opts: FetchMediaLinksOpts = stateOrOpts && 'cookie' in stateOrOpts
    ? { state: stateOrOpts, log: maybeLog }
    : (stateOrOpts ?? {})
  const log = opts.log
  const url = `${ORIGIN}/ajax/get_medialink.php?idObject=5&idItem=${encodeURIComponent(mediaItemId)}`
  log?.info('medialink.start', { mediaItemId })

  // Attempt 1: direct, 2s deadline.
  try {
    const result = await fetchMediaLinksDirect(mediaItemId, url, opts.state, 2000, log, 'direct.first')
    return { result, state: opts.state ?? { cookie: '' } }
  } catch (e) {
    log?.warn('medialink.direct_first_failed', {
      mediaItemId,
      error: e instanceof Error ? e.message : String(e),
      willRace: !!opts.brightdataApiKey,
    })
  }

  // Attempt 2: race a longer direct retry against BrightData.
  const racers: Promise<MediaLinks>[] = [
    fetchMediaLinksDirect(mediaItemId, url, opts.state, 8000, log, 'direct.retry'),
  ]
  if (opts.brightdataApiKey) {
    racers.push(fetchMediaLinksViaUnlocker(mediaItemId, url, opts.brightdataApiKey, log))
  }
  try {
    const result = await Promise.any(racers)
    return { result, state: opts.state ?? { cookie: '' } }
  } catch (e) {
    // Promise.any throws AggregateError when all racers reject.
    log?.error('medialink.all_failed', {
      mediaItemId,
      racerCount: racers.length,
      errors: e instanceof AggregateError ? e.errors.map((er) => (er instanceof Error ? er.message : String(er))) : [String(e)],
    })
    return { result: { ...NO_LINKS }, state: opts.state ?? { cookie: '' } }
  }
}

async function fetchMediaLinksDirect(
  mediaItemId: string,
  url: string,
  state: ChallengeState | undefined,
  timeoutMs: number,
  log: Logger | undefined,
  phase: string,
): Promise<MediaLinks> {
  const cookieHeader: Record<string, string> = state?.cookie ? { Cookie: state.cookie } : {}
  const start = Date.now()
  let res: Response
  try {
    res = await fetchWithTimeout(url, {
      timeoutMs,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json,text/javascript,*/*;q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: ORIGIN + '/',
        ...cookieHeader,
      },
    })
  } catch (e) {
    log?.warn('medialink.transport_throw', { mediaItemId, phase, error: e instanceof Error ? e.message : String(e), ms: Date.now() - start })
    throw e
  }
  return parseAndLog(mediaItemId, res, await res.text(), log, phase, start)
}

async function fetchMediaLinksViaUnlocker(
  mediaItemId: string,
  url: string,
  apiKey: string,
  log: Logger | undefined,
): Promise<MediaLinks> {
  const start = Date.now()
  const r = await fetchViaUnlocker(url, apiKey, log)
  if (r.status !== 200 || !r.html) {
    log?.warn('medialink.unlocker_non_ok', { mediaItemId, status: r.status, errorCode: r.errorCode, ms: Date.now() - start })
    throw new Error(`unlocker medialink ${r.status}: ${r.errorCode ?? r.errorMessage ?? ''}`)
  }
  let json: MedialinkResponse
  try {
    json = JSON.parse(r.html)
  } catch {
    log?.warn('medialink.unlocker_parse_failed', { mediaItemId, body: r.html.slice(0, 500), ms: Date.now() - start })
    throw new Error('unlocker medialink JSON parse failed')
  }
  const result = parseMediaLinks(json)
  log?.info('medialink.unlocker_done', {
    mediaItemId,
    appleLink: result.appleLink,
    youtubeLink: result.youtubeLink,
    soundcloudLink: result.soundcloudLink,
    ms: Date.now() - start,
  })
  return result
}

function parseAndLog(
  mediaItemId: string,
  res: Response,
  text: string,
  log: Logger | undefined,
  phase: string,
  start: number,
): MediaLinks {
  let json: MedialinkResponse
  try {
    json = JSON.parse(text)
  } catch {
    log?.warn('medialink.parse_failed', { mediaItemId, phase, status: res.status, body: text.slice(0, 500), ms: Date.now() - start })
    throw new Error(`medialink parse_failed (${phase}) status=${res.status}`)
  }
  const result = parseMediaLinks(json)
  log?.info('medialink.done', {
    mediaItemId,
    phase,
    status: res.status,
    success: json.success,
    sourcesData: (json.data ?? []).map((d) => d.source),
    sourcesMore: (json.more ?? []).map((m) => m.source),
    appleLink: result.appleLink,
    youtubeLink: result.youtubeLink,
    soundcloudLink: result.soundcloudLink,
    ms: Date.now() - start,
  })
  return result
}

export function parseMediaLinks(json: MedialinkResponse): MediaLinks {
  if (!json.success) return { ...NO_LINKS }
  const apple = json.data?.find((d) => d.source === SOURCE.APPLE)
  const youtube = json.more?.find((m) => m.source === SOURCE.YOUTUBE)
  const soundcloud = json.data?.find((d) => d.source === SOURCE.SOUNDCLOUD)
  return {
    appleLink: apple ? buildAppleLink(apple) : null,
    youtubeLink: youtube?.idLink ? `https://www.youtube.com/watch?v=${youtube.idLink}` : null,
    soundcloudLink: soundcloud ? buildSoundcloudLink(soundcloud) : null,
  }
}

/**
 * Build a SoundCloud link from a source-10 medialink entry. 1001tl embeds the
 * SoundCloud widget, whose `playerId` is the numeric track id (and whose iframe
 * src wraps `https://api.soundcloud.com/tracks/<id>`). We return the widget
 * player URL: it plays free (with ads) as a standalone browser page, and
 * yt-dlp's SoundcloudEmbedIE downloads it without cookies. Falls back to
 * parsing the api URL out of the iframe when `playerId` isn't the bare id.
 */
function buildSoundcloudLink(entry: { playerId?: string; player?: string }): string | null {
  let apiUrl: string | null = null
  if (entry.playerId && /^\d+$/.test(entry.playerId)) {
    apiUrl = `https://api.soundcloud.com/tracks/${entry.playerId}`
  } else {
    // The iframe src is `...player/?url=https://api.soundcloud.com/tracks/<id>&amp;...`
    const m = (entry.player ?? '').match(/[?&]url=(https?:\/\/api\.soundcloud\.com\/tracks\/\d+)/)
    if (m) apiUrl = m[1]!
  }
  if (!apiUrl) return null
  return `https://w.soundcloud.com/player/?url=${encodeURIComponent(apiUrl)}`
}

function buildAppleLink(entry: { playerId: string; player?: string }): string | null {
  const player = entry.player ?? ''
  // Player iframe src example:
  //   https://embed.music.apple.com/us/album/where-ya-at/1696220774?i=1696221102app=music&at=...
  const m = player.match(/embed\.music\.apple\.com\/(\w+)\/album\/([^/]+)\/(\d+)\?i=(\d+)/)
  if (m) {
    const [, country, slug, albumId, songId] = m
    return `https://music.apple.com/${country}/album/${slug}/${albumId}?i=${songId}`
  }
  // Fallback: song-id direct link (Apple redirects this).
  if (entry.playerId) return `https://music.apple.com/us/song/${entry.playerId}`
  return null
}
