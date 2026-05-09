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
const EMBED_RE = /youtube\.com\/embed\/([A-Za-z0-9_-]{11})/g
// og:video / og:video:url tags occasionally surface the watch URL too.
const WATCH_RE = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/g

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
  let m: RegExpExecArray | null
  EMBED_RE.lastIndex = 0
  while ((m = EMBED_RE.exec(html))) candidates.push(m[1]!)
  WATCH_RE.lastIndex = 0
  while ((m = WATCH_RE.exec(html))) candidates.push(m[1]!)
  for (const c of candidates) {
    if (VIDEO_ID_RE.test(c) && !isYouTubeChannelLike(c)) return c
  }
  return null
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
