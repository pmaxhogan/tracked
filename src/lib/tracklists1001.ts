import { parse, type HTMLElement } from 'node-html-parser'
import type { ParsedTrack } from '../types'
import { fetchHtml, fetchWithTimeout, postForm, isIPBlocked, extractIPBlockedAddress, IPBlockedError, type ChallengeState } from './fetch'
import { fetchViaUnlocker } from './unlocker'
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
  const result = parseSearchResult(html)
  log?.info('1001search.done', { videoUrl, htmlBytes: html.length, tracklistUrl: result.tracklistUrl, ms: Date.now() - start })
  return { result, state: s2 }
}

export function parseSearchResult(html: string): SearchResult {
  const root = parse(html)
  const rows = root.querySelectorAll('div.bItm.action.oItm')
  for (const r of rows) {
    const onclick = r.getAttribute('onclick') ?? ''
    const m = onclick.match(/window\.open\('(\/tracklist\/[^']+)'/)
    if (m) return { tracklistUrl: ORIGIN + m[1] }
  }
  return { tracklistUrl: null }
}

export type ScrapedTracklist = {
  slug: string
  /** Apple Music album/playlist link for the whole set, when 1001tl embeds one. null otherwise. */
  setAppleLink: string | null
  tracks: ParsedTrack[]
}

export type FetchTracklistOpts = {
  /** When set, route through Bright Data Web Unlocker (handles the captcha gate
   *  1001tracklists serves to Cloudflare Worker IPs). When absent, fetch directly
   *  — fine from a residential IP, fails on Workers. */
  brightdataApiKey?: string
  state?: ChallengeState
  log?: Logger
}

export async function fetchTracklist(
  tracklistUrl: string,
  opts: FetchTracklistOpts = {},
): Promise<{ result: ScrapedTracklist; state: ChallengeState }> {
  const log = opts.log
  log?.info('1001scrape.start', { tracklistUrl, viaUnlocker: !!opts.brightdataApiKey })
  const start = Date.now()
  if (opts.brightdataApiKey) {
    const r = await fetchViaUnlocker(tracklistUrl, opts.brightdataApiKey, log)
    // unlocker already accepts 2xx; this is just defensive in case the body is empty.
    if (!r.html) {
      const detail = r.errorCode ? `${r.errorCode}: ${r.errorMessage ?? ''}` : `status ${r.status}`
      log?.error('1001scrape.unlocker_failed', { tracklistUrl, status: r.status, errorCode: r.errorCode, errorMessage: r.errorMessage })
      throw new Error(`unlocker tracklist fetch failed — ${detail}`)
    }
    if (isIPBlocked(r.html)) {
      const clientIp = extractIPBlockedAddress(r.html)
      log?.error('1001scrape.unlocker_ip_blocked', { tracklistUrl, clientIp, htmlBytes: r.html.length })
      throw new IPBlockedError(clientIp)
    }
    const result = parseTracklist(tracklistUrl, r.html)
    log?.info('1001scrape.parsed', {
      tracklistUrl,
      htmlBytes: r.html.length,
      trackCount: result.tracks.length,
      unidentifiedCount: result.tracks.filter((t) => t.isUnidentified).length,
      mashupLinkedCount: result.tracks.filter((t) => t.isMashupLinked).length,
      ms: Date.now() - start,
    })
    return { result, state: opts.state ?? { cookie: '' } }
  }
  const { html, state: s2 } = await fetchHtml(tracklistUrl, opts.state)
  const result = parseTracklist(tracklistUrl, html)
  log?.info('1001scrape.parsed_direct', {
    tracklistUrl,
    htmlBytes: html.length,
    trackCount: result.tracks.length,
    ms: Date.now() - start,
  })
  return { result, state: s2 }
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

  return { slug, setAppleLink: extractSetAppleLink(html), tracks }
}

/**
 * 1001tracklists emits a JS block (`cueValueData`) that maps each cued track's
 * inner content id (`tlp{N}_content`) to its cue in seconds. The hidden form
 * input `_cue_seconds` defaults to "0" for uncued rows (mashup-linked siblings,
 * trailing untimed extras), so reading the input alone makes those rows look
 * like they start at 0:00. The JS map only contains real cues, so use it as
 * the source of truth and fall back to null for anything not listed.
 */
export function parseCueValueData(html: string): Map<string, number> {
  const out = new Map<string, number>()
  const re = /cueValuesEntry\.seconds = (\d+);[\s\S]*?cueValuesEntry\.ids\[0\] = '([^']+)';/g
  let m
  while ((m = re.exec(html))) {
    out.set(m[2]!, Number(m[1]!))
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
}

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
    return { result: { appleLink: null, youtubeLink: null }, state: opts.state ?? { cookie: '' } }
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
    ms: Date.now() - start,
  })
  return result
}

export function parseMediaLinks(json: MedialinkResponse): MediaLinks {
  if (!json.success) return { appleLink: null, youtubeLink: null }
  const apple = json.data?.find((d) => d.source === SOURCE.APPLE)
  const youtube = json.more?.find((m) => m.source === SOURCE.YOUTUBE)
  return {
    appleLink: apple ? buildAppleLink(apple) : null,
    youtubeLink: youtube?.idLink ? `https://www.youtube.com/watch?v=${youtube.idLink}` : null,
  }
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
