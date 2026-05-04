import { parse, type HTMLElement } from 'node-html-parser'
import type { ParsedTrack } from '../types'
import { fetchHtml, postForm, type ChallengeState } from './fetch'
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
    if (r.status !== 200 || !r.html) {
      const detail = r.errorCode ? `${r.errorCode}: ${r.errorMessage ?? ''}` : `status ${r.status}`
      log?.error('1001scrape.unlocker_failed', { tracklistUrl, status: r.status, errorCode: r.errorCode, errorMessage: r.errorMessage })
      throw new Error(`unlocker tracklist fetch failed — ${detail}`)
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

  const rows = root.querySelectorAll('div.tlpItem')
  const tracks: ParsedTrack[] = []
  for (const row of rows) {
    const t = parseRow(row)
    if (t) tracks.push(t)
  }

  return { slug, setAppleLink: extractSetAppleLink(html), tracks }
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

function parseRow(row: HTMLElement): ParsedTrack | null {
  const dataId = row.getAttribute('data-id') ?? null
  const cls = row.getAttribute('class') ?? ''
  const isMashupLinked = / con(\s|$)/.test(cls)

  const cueInput = row.querySelector(`input[id$="_cue_seconds"]`)
  const cueSecondsRaw = cueInput?.getAttribute('value') ?? ''
  const startSeconds = cueSecondsRaw === '' ? null : Number(cueSecondsRaw)
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

  return {
    startTime: startTime || (Number.isFinite(startSeconds!) ? formatCue(startSeconds!) : ''),
    startSeconds: Number.isFinite(startSeconds!) ? (startSeconds as number) : null,
    artist,
    title: title || 'ID',
    trackId: mediaTrackId ?? dataId,
    trackUrl,
    isUnidentified,
    idStatus,
    isMashupLinked,
  }
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

export async function fetchMediaLinks(mediaItemId: string, state?: ChallengeState, log?: Logger): Promise<{ result: MediaLinks; state: ChallengeState }> {
  const url = `${ORIGIN}/ajax/get_medialink.php?idObject=5&idItem=${encodeURIComponent(mediaItemId)}`
  const cookieHeader: Record<string, string> = state?.cookie ? { Cookie: state.cookie } : {}
  log?.info('medialink.start', { mediaItemId })
  const start = Date.now()
  let res: Response
  try {
    res = await fetch(url, {
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
    log?.error('medialink.transport_throw', { mediaItemId, error: e instanceof Error ? e.message : String(e), ms: Date.now() - start })
    return { result: { appleLink: null, youtubeLink: null }, state: state ?? { cookie: '' } }
  }
  const text = await res.text()
  let json: MedialinkResponse
  try {
    json = JSON.parse(text)
  } catch {
    log?.warn('medialink.parse_failed', { mediaItemId, status: res.status, body: text.slice(0, 500), ms: Date.now() - start })
    return { result: { appleLink: null, youtubeLink: null }, state: state ?? { cookie: '' } }
  }
  const result = parseMediaLinks(json)
  log?.info('medialink.done', {
    mediaItemId,
    status: res.status,
    success: json.success,
    sourcesData: (json.data ?? []).map((d) => d.source),
    sourcesMore: (json.more ?? []).map((m) => m.source),
    appleLink: result.appleLink,
    youtubeLink: result.youtubeLink,
    ms: Date.now() - start,
  })
  return { result, state: state ?? { cookie: '' } }
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
