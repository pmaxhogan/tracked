/**
 * Every link 1001tracklists has for one track, not just the three the
 * viewers show (lib/tracklists1001.ts `parseMediaLinks`): the pre-save
 * recheck (lib/presave.ts) needs to know whether a YouTube link turned up,
 * and which other sites carry the track (mkvid can rip some of them).
 *
 * `get_medialink.php?idObject=5&idItem=<id>` answers `{ success, data, more }`:
 *   - `data`: embedded players `{ source, playerId, player (iframe html), duration (s, string) }`
 *   - `more`: plain links `{ source, idLink }` (the YouTube video lives here)
 * Source codes: 1 beatport, 2 apple, 4 traxsource, 10 soundcloud, 13 youtube,
 * 36 spotify. An unknown code is kept as `src<code>`, unless its player's host
 * names the site (bandcamp, hearthis, mixcloud, deezer…), which is what
 * trackUploads.allowedSources matches on.
 *
 * Unlike `fetchMediaLinks`, `fetchAllMediaLinks` never turns a failure into
 * "no links": a pool refusal comes back as `{ ok: false, poolError }`, so the
 * caller can tell "the pool would not look" from "1001tracklists has nothing".
 * A good answer is written through to the viewers' `ml:v1:<id>` cache in the
 * classic shape, so the next viewer of that track costs nothing.
 *
 * The track page parser (`parseTrackPageMediaId`) is for a pre-save that only
 * knows a track URL: the id in `/track/<id>/<slug>/` is NOT the medialink id
 * (verified: `/track/1hf79cg5/tobehonest-where-ya-at/` is medialink 909720).
 */

import type { Env } from '../types'
import { TTL, putJson } from './cache'
import { IPBlockedError } from './fetch'
import type { Logger } from './log'
import type { PoolFaultCode, PoolPriority } from './pool'
import { poolCodeOf } from './pool'
import { buildAppleLink, parseMediaLinks, type MediaLinks, type MedialinkResponse } from './tracklists1001'
import { fetch1001, fetchOptsFromEnv, UpstreamPausedError, UpstreamUnavailableError } from './upstream1001'
import { decodeEntities } from './html-entities'

const ORIGIN = 'https://www.1001tracklists.com'

/** Cache-key version of the per-track links (`ml:v<N>:<id>`), shared with lib/tracklist-resolve.ts. */
export const MEDIALINK_CACHE_VERSION = 1

export function mediaLinksCacheKey(trackId: string): string {
  return `ml:v${MEDIALINK_CACHE_VERSION}:${trackId}`
}

/** 1001tracklists' medialink source codes → names. */
export const MEDIALINK_SOURCES: Readonly<Record<string, string>> = {
  '1': 'beatport',
  '2': 'apple',
  '4': 'traxsource',
  '10': 'soundcloud',
  '13': 'youtube',
  '36': 'spotify',
}

/** One link of a track. `url` is a canonical public URL where one can be built, else the player's iframe src. */
export type LinkEntry = {
  /** 1001tracklists' source code ("36"). */
  source: string
  /** spotify | apple | soundcloud | youtube | beatport | traxsource | <host name> | src<code> */
  name: string
  url: string | null
  playerId: string | null
  /** Seconds, from the player entry; null when 1001tracklists gave none. */
  duration: number | null
}

/** Player hosts that name a site whose source code we do not know. */
const HOST_NAMES: Array<[RegExp, string]> = [
  [/(^|\.)bandcamp\.com$/, 'bandcamp'],
  [/(^|\.)hearthis\.at$/, 'hearthis'],
  [/(^|\.)mixcloud\.com$/, 'mixcloud'],
  [/(^|\.)deezer\.com$/, 'deezer'],
  [/(^|\.)tidal\.com$/, 'tidal'],
  [/(^|\.)music\.amazon\.[a-z.]+$/, 'amazon'],
  [/(^|\.)audiomack\.com$/, 'audiomack'],
]

/** The iframe src of a player's html, entities decoded. */
function iframeSrc(player: string | undefined | null): string | null {
  const m = (player ?? '').match(/<iframe[^>]*\ssrc="([^"]+)"/i) ?? (player ?? '').match(/<iframe[^>]*\ssrc='([^']+)'/i)
  return m ? decodeEntities(m[1]!) : null
}

function nameFor(code: string, src: string | null): string {
  const known = MEDIALINK_SOURCES[code]
  if (known) return known
  if (src) {
    try {
      const host = new URL(src).hostname.toLowerCase()
      for (const [re, name] of HOST_NAMES) if (re.test(host)) return name
    } catch {
      // not a URL: keep the code
    }
  }
  return `src${code}`
}

function durationOf(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

const httpsOrNull = (u: string | null): string | null => {
  if (!u) return null
  try {
    return new URL(u).protocol === 'https:' ? u : null
  } catch {
    return null
  }
}

/**
 * The canonical URL for a source. A known source whose URL cannot be built
 * from its ids is null (track uploads only accept allowlisted hosts per
 * source, never an arbitrary iframe src); an unknown one keeps its player's
 * src for display, when that is an https URL.
 */
function canonicalUrl(name: string, playerId: string | null, src: string | null, player?: string): string | null {
  const id = playerId ?? ''
  switch (name) {
    case 'spotify': {
      if (/^[A-Za-z0-9]{10,40}$/.test(id)) return `https://open.spotify.com/track/${id}`
      const m = (src ?? '').match(/^https:\/\/open\.spotify\.com\/(?:embed\/)?track\/([A-Za-z0-9]+)/)
      return m ? `https://open.spotify.com/track/${m[1]}` : null
    }
    case 'apple':
      return playerId || player ? buildAppleLink({ playerId: id, player }) : null
    case 'soundcloud': {
      if (/^\d+$/.test(id)) return `https://api.soundcloud.com/tracks/${id}`
      const m = (src ?? '').match(/api\.soundcloud\.com\/tracks\/(\d+)/)
      return m ? `https://api.soundcloud.com/tracks/${m[1]}` : null
    }
    case 'youtube':
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : null
    case 'beatport': {
      if (/^\d+$/.test(id)) return `https://www.beatport.com/track/-/${id}`
      const m = (src ?? '').match(/^https:\/\/embed\.beatport\.com\/\?id=(\d+)/)
      return m ? `https://www.beatport.com/track/-/${m[1]}` : null
    }
    case 'traxsource':
      return /^\d+$/.test(id) ? `https://www.traxsource.com/track/${id}` : null
    default:
      return httpsOrNull(src)
  }
}

/**
 * Every entry of a medialink answer, `data` (players) first then `more`
 * (plain links), in 1001tracklists' order. A YouTube id that sits in both is
 * listed once. `success: false` gives no links.
 */
export function parseAllMediaLinks(json: MedialinkResponse | null | undefined): LinkEntry[] {
  if (!json || !json.success) return []
  const out: LinkEntry[] = []
  const seen = new Set<string>()
  const push = (e: LinkEntry) => {
    const k = `${e.name}|${e.url ?? e.playerId ?? ''}`
    if (seen.has(k)) return
    seen.add(k)
    out.push(e)
  }
  for (const d of (json.data ?? []) as Array<{ source?: unknown; playerId?: unknown; player?: unknown; duration?: unknown; isDeleted?: unknown }>) {
    if (!d || d.isDeleted === true) continue
    const source = String(d.source ?? '')
    if (!source) continue
    const player = typeof d.player === 'string' ? d.player : undefined
    const src = iframeSrc(player)
    const playerId = typeof d.playerId === 'string' && d.playerId ? d.playerId : typeof d.playerId === 'number' ? String(d.playerId) : null
    const name = nameFor(source, src)
    push({ source, name, url: canonicalUrl(name, playerId, src, player), playerId, duration: durationOf(d.duration) })
  }
  for (const m of (json.more ?? []) as Array<{ source?: unknown; idLink?: unknown }>) {
    if (!m) continue
    const source = String(m.source ?? '')
    if (!source) continue
    const idLink = typeof m.idLink === 'string' && m.idLink ? m.idLink : null
    const name = nameFor(source, null)
    const url = name === 'youtube' ? (idLink && /^[A-Za-z0-9_-]{11}$/.test(idLink) ? `https://www.youtube.com/watch?v=${idLink}` : null) : MEDIALINK_SOURCES[source] ? null : httpsOrNull(idLink)
    push({ source, name, url, playerId: idLink, duration: null })
  }
  return out
}

/** The YouTube video id among the links (the `more` entry, else a youtube player), or null. */
export function youtubeIdOf(links: readonly LinkEntry[]): string | null {
  for (const l of links) {
    if (l.name !== 'youtube') continue
    if (l.playerId && /^[A-Za-z0-9_-]{11}$/.test(l.playerId)) return l.playerId
    const m = (l.url ?? '').match(/[?&]v=([A-Za-z0-9_-]{11})/)
    if (m) return m[1]!
  }
  return null
}

/** Distinct link names in first-seen order. */
export function linkNames(links: readonly LinkEntry[]): string[] {
  return [...new Set(links.map((l) => l.name))]
}

/** The longest reported duration, or null. */
export function maxDuration(links: readonly LinkEntry[]): number | null {
  let best: number | null = null
  for (const l of links) if (l.duration !== null && (best === null || l.duration > best)) best = l.duration
  return best
}

export type FetchAllMediaLinksResult =
  | { ok: true; links: LinkEntry[]; classic: MediaLinks; success: boolean; accountId: string; ms: number }
  | {
      ok: false
      error: string
      /** Set when the pool (or the pause switch, or a block page) refused: nothing about the track was learnt. */
      poolError?: UpstreamPausedError | UpstreamUnavailableError | IPBlockedError
      poolCode?: PoolFaultCode | null
      retryAfterSeconds?: number | null
      ms: number
    }

/**
 * One uncached medialink lookup through the pool (kind `medialink`, one
 * budgeted view). The classic `ml:v1:<id>` cache entry is refreshed with the
 * answer, never consulted. Never throws.
 */
export async function fetchAllMediaLinks(
  env: Env,
  trackId: string,
  opts: { priority?: PoolPriority; log?: Logger; maxWaitSeconds?: number } = {},
): Promise<FetchAllMediaLinksResult> {
  const t0 = Date.now()
  const log = opts.log
  const url = `${ORIGIN}/ajax/get_medialink.php?idObject=5&idItem=${encodeURIComponent(trackId)}`
  let html: string
  let accountId = ''
  try {
    const r = await fetch1001(url, {
      ...fetchOptsFromEnv(env, log, { priority: opts.priority ?? 'phone', ...(opts.maxWaitSeconds ? { maxWaitSeconds: opts.maxWaitSeconds } : {}) }),
      kind: 'medialink',
      headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json,text/javascript,*/*;q=0.01', Referer: ORIGIN + '/' },
    })
    html = r.html
    accountId = r.accountId
  } catch (e) {
    const ms = Date.now() - t0
    const error = e instanceof Error ? e.message : String(e)
    if (e instanceof UpstreamPausedError || e instanceof UpstreamUnavailableError || e instanceof IPBlockedError) {
      const retry = (e as { retryAfterSeconds?: unknown }).retryAfterSeconds
      log?.warn('medialink_all.refused', { trackId, error, ms })
      return { ok: false, error, poolError: e, poolCode: poolCodeOf(e), retryAfterSeconds: typeof retry === 'number' && Number.isFinite(retry) ? retry : null, ms }
    }
    log?.error('medialink_all.failed', { trackId, error, ms })
    return { ok: false, error, ms }
  }
  let json: MedialinkResponse
  try {
    json = JSON.parse(html) as MedialinkResponse
  } catch {
    log?.warn('medialink_all.parse_failed', { trackId, body: html.slice(0, 300) })
    return { ok: false, error: 'medialink answer is not JSON', ms: Date.now() - t0 }
  }
  const links = parseAllMediaLinks(json)
  const classic = parseMediaLinks(json)
  try {
    await putJson(env.CACHE, mediaLinksCacheKey(trackId), classic, TTL.MEDIALINK)
  } catch (e) {
    log?.warn('medialink_all.cache_put_failed', { trackId, error: e instanceof Error ? e.message : String(e) })
  }
  const ms = Date.now() - t0
  log?.info('medialink_all.done', { trackId, success: !!json.success, names: linkNames(links), youtube: youtubeIdOf(links), accountId, ms })
  return { ok: true, links, classic, success: !!json.success, accountId, ms }
}

// ─── track page → medialink id ──────────────────────────────────────────────

/**
 * The medialink id a 1001tracklists track page embeds, defensively: there is
 * no fixture of a track page, so several patterns are tried in order of how
 * specific they are, and the caller logs which one matched.
 *   1. a `mediaRow` element's numeric `data-trackid` (what set pages carry)
 *   2. a medialink AJAX call or MediaSubmitter with `idObject: 5` (5 = track;
 *      8 is a tracklist position, never the track)
 *   3. any numeric `data-trackid`
 */
export function parseTrackPageMediaId(html: string): { id: string; via: string } | null {
  const tests: Array<[string, RegExp]> = [
    ['mediaRow', /<[a-z]+[^>]*\bclass="[^"]*\bmediaRow\b[^"]*"[^>]*\bdata-trackid="(\d+)"/i],
    ['mediaRow', /<[a-z]+[^>]*\bdata-trackid="(\d+)"[^>]*\bclass="[^"]*\bmediaRow\b/i],
    ['get_medialink', /get_medialink\.php\?idObject=5&(?:amp;)?idItem=(\d+)/],
    ['idObject5', /idObject['"]?\s*:\s*['"]?5['"]?\s*,\s*['"]?idItem['"]?\s*:\s*['"]?(\d+)/],
    ['idObject5', /idItem['"]?\s*:\s*['"]?(\d+)['"]?\s*,\s*['"]?idObject['"]?\s*:\s*['"]?5\b/],
    ['data-trackid', /\bdata-trackid="(\d+)"/],
  ]
  for (const [via, re] of tests) {
    const m = html.match(re)
    if (m) return { id: m[1]!, via }
  }
  return null
}

/** `Artist - Title` from a track page's microdata / og:title / <title>, when it has one. */
export function parseTrackPageName(html: string): { artist: string; title: string } | null {
  const pick = (re: RegExp) => {
    const m = html.match(re)
    return m ? decodeEntities(m[1]!).replace(/\s+/g, ' ').trim() : ''
  }
  const raw =
    pick(/<meta[^>]*\bproperty="og:title"[^>]*\bcontent="([^"]+)"/i) ||
    pick(/<meta[^>]*\bitemprop="name"[^>]*\bcontent="([^"]+)"/i) ||
    pick(/<title>([^<]+)<\/title>/i)
  if (!raw) return null
  const name = raw.replace(/\s*[|–-]\s*1001\s*tracklists.*$/i, '').trim()
  const dash = name.indexOf(' - ')
  if (dash <= 0) return null
  return { artist: name.slice(0, dash).trim(), title: name.slice(dash + 3).trim() }
}

/** `https://www.1001tracklists.com/track/<id>/<slug>/index.html` from any spelling, or null. */
export function normalizeTrackUrl(input: string | null | undefined): string | null {
  const s = (input ?? '').trim()
  if (!s) return null
  let u: URL
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, '')}`)
  } catch {
    try {
      u = new URL(s, ORIGIN)
    } catch {
      return null
    }
  }
  if (!/^(www\.)?1001tracklists\.com$/i.test(u.hostname)) {
    if (!s.startsWith('/track/')) return null
    u = new URL(s, ORIGIN)
  }
  const m = u.pathname.match(/^\/track\/([a-z0-9]+)(?:\/([^/?#]+))?/i)
  if (!m) return null
  return `${ORIGIN}/track/${m[1]}/${m[2] ?? 'x'}/index.html`
}

export type TrackPageLookup =
  | { ok: true; trackId: string | null; via: string | null; name: { artist: string; title: string } | null }
  | { ok: false; error: string; poolError?: UpstreamPausedError | UpstreamUnavailableError | IPBlockedError; poolCode?: PoolFaultCode | null; retryAfterSeconds?: number | null }

/** Fetch a track page (pool kind `set`, one page view) and read its medialink id. Never throws. */
export async function fetchTrackPageMediaId(env: Env, trackUrl: string, opts: { priority?: PoolPriority; log?: Logger } = {}): Promise<TrackPageLookup> {
  const log = opts.log
  try {
    const r = await fetch1001(trackUrl, { ...fetchOptsFromEnv(env, log, { priority: opts.priority ?? 'phone' }), kind: 'set' })
    const hit = parseTrackPageMediaId(r.html)
    const name = parseTrackPageName(r.html)
    log?.info('presave.track_page', { trackUrl, trackId: hit?.id ?? null, via: hit?.via ?? null, name, htmlBytes: r.html.length, accountId: r.accountId })
    return { ok: true, trackId: hit?.id ?? null, via: hit?.via ?? null, name }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    if (e instanceof UpstreamPausedError || e instanceof UpstreamUnavailableError || e instanceof IPBlockedError) {
      const retry = (e as { retryAfterSeconds?: unknown }).retryAfterSeconds
      log?.warn('presave.track_page_refused', { trackUrl, error })
      return { ok: false, error, poolError: e, poolCode: poolCodeOf(e), retryAfterSeconds: typeof retry === 'number' && Number.isFinite(retry) ? retry : null }
    }
    log?.warn('presave.track_page_failed', { trackUrl, error })
    return { ok: false, error }
  }
}
