import { parse, type HTMLElement } from 'node-html-parser'
import type { ParsedTrack } from '../types'
import { fetchHtml, postForm, type ChallengeState } from './fetch'

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
): Promise<{ result: SearchResult; state: ChallengeState }> {
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
  return { result: parseSearchResult(html), state: s2 }
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
  tracks: ParsedTrack[]
}

export async function fetchTracklist(
  tracklistUrl: string,
  state?: ChallengeState,
): Promise<{ result: ScrapedTracklist; state: ChallengeState }> {
  const { html, state: s2 } = await fetchHtml(tracklistUrl, state)
  return { result: parseTracklist(tracklistUrl, html), state: s2 }
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
  return { slug, tracks }
}

function parseRow(row: HTMLElement): ParsedTrack | null {
  const dataId = row.getAttribute('data-id') ?? null
  const isided = row.getAttribute('data-isided') === 'true'
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

  if (!fullName && !isided) return null

  let title = ''
  let artist = artistRaw
  if (fullName) {
    const dash = fullName.indexOf(' - ')
    if (dash >= 0) {
      const left = fullName.slice(0, dash).trim()
      title = fullName.slice(dash + 3).trim()
      if (!artist) artist = left
    } else {
      title = fullName
    }
  }

  const isUnidentified = !isided || title === 'ID' || /\bID\b/.test(title)

  const mediaRow = row.querySelector('div.mediaRow')
  const mediaTrackId = mediaRow?.getAttribute('data-trackid') ?? null

  return {
    startTime: startTime || (Number.isFinite(startSeconds!) ? formatCue(startSeconds!) : ''),
    startSeconds: Number.isFinite(startSeconds!) ? (startSeconds as number) : null,
    artist: artist || (isUnidentified ? '' : ''),
    title: title || (isUnidentified ? 'ID' : ''),
    trackId: mediaTrackId ?? dataId,
    isUnidentified,
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

export async function fetchMediaLinks(mediaItemId: string, state?: ChallengeState): Promise<{ result: MediaLinks; state: ChallengeState }> {
  const url = `${ORIGIN}/ajax/get_medialink.php?idObject=5&idItem=${encodeURIComponent(mediaItemId)}`
  const cookieHeader: Record<string, string> = state?.cookie ? { Cookie: state.cookie } : {}
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'application/json,text/javascript,*/*;q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: ORIGIN + '/',
      ...cookieHeader,
    },
  })
  const text = await res.text()
  let json: MedialinkResponse
  try {
    json = JSON.parse(text)
  } catch {
    return { result: { appleLink: null, youtubeLink: null }, state: state ?? { cookie: '' } }
  }
  return { result: parseMediaLinks(json), state: state ?? { cookie: '' } }
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
