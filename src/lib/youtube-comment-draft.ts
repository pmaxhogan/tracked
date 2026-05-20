/**
 * Render a YouTube comment body that lists a 1001tracklists tracklist as
 * timestamped lines plus a short-link credit. Pure transform — no network,
 * no posting. The caller (mini-app UI / future auto-poster) does that part.
 *
 * Format:
 *
 *   0:00 Artist - Title
 *   1:16:30 Artist - Title w/ Other Artist - Other Title
 *   ...
 *
 *   Tracklist: 1001.tl/<id>
 *
 * Timestamps are at the start of each line so YouTube auto-linkifies them
 * into seek points. The credit link uses 1001tracklists' first-party
 * `1001.tl/<id>` shortener and is rendered WITHOUT an `https://` prefix —
 * bare-host text seems to land softer against YouTube's link-heavy-comment
 * spam filter than a full URL would.
 */

import type { ParsedTrack } from '../types'
import { formatTime, groupByMashup } from './timestamp'

/** Matches the canonical 1001tracklists URL: /tracklist/<id>/<slug>. The id
 *  is what 1001.tl uses too — no separate lookup needed. */
const TRACKLIST_URL_ID_RE = /^https?:\/\/(?:www\.)?1001tracklists\.com\/tracklist\/([a-z0-9]+)(?:\/|$)/i

const SHORT_LINK_HOST = '1001.tl'

/** YouTube's hard cap on a comment is 10,000 characters. Aim under it with
 *  margin so a sloppy upstream (long artist/title strings, surprise tracks
 *  appended late) doesn't push us over. */
const DEFAULT_MAX_CHARS = 9500

export class InvalidTracklistUrl extends Error {
  constructor(public readonly tracklistUrl: string) {
    super(`tracklistUrl does not match the expected /tracklist/<id>/ shape: ${tracklistUrl}`)
    this.name = 'InvalidTracklistUrl'
  }
}

/** Pull the short-link id from a canonical 1001tracklists tracklist URL.
 *  Returns null when the URL doesn't match. */
export function extractTracklistShortId(tracklistUrl: string): string | null {
  const m = tracklistUrl.match(TRACKLIST_URL_ID_RE)
  return m ? m[1]! : null
}

/** `1001.tl/<id>` — no `https://`. */
export function buildShortLink(id: string): string {
  return `${SHORT_LINK_HOST}/${id}`
}

export type CommentDraftOpts = {
  /** Override the trailing credit line. Receives the bare short link. */
  creditTemplate?: (shortLink: string) => string
  /** Soft cap on the total body length. Default 9500 (under YT's 10k limit). */
  maxChars?: number
}

export type CommentDraft = {
  /** Ready-to-paste comment body. */
  body: string
  /** `1001.tl/<id>` — bare host, no scheme. */
  shortLink: string
  /** Track groups (mashup-linked siblings count once) rendered as lines. */
  includedGroups: number
  /** Track groups skipped because no member had a cue — a line without a
   *  timestamp can't be auto-linkified by YouTube and just looks like noise. */
  droppedUncued: number
  /** Track groups skipped because adding them would have pushed the body
   *  over `maxChars`. Trimmed from the tail. */
  droppedForLength: number
  truncated: boolean
}

const defaultCredit = (sl: string) => `Tracklist: ${sl}`

export function buildCommentDraft(
  tracklistUrl: string,
  tracklist: { tracks: ParsedTrack[] },
  opts: CommentDraftOpts = {},
): CommentDraft {
  const id = extractTracklistShortId(tracklistUrl)
  if (!id) throw new InvalidTracklistUrl(tracklistUrl)
  const shortLink = buildShortLink(id)
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS
  const credit = (opts.creditTemplate ?? defaultCredit)(shortLink)

  // Group mashup-linked siblings so a single cue renders as a single line
  // (otherwise YT would create two seek links to the same second).
  const groups = groupByMashup(tracklist.tracks)
  const cuedLines: string[] = []
  let droppedUncued = 0
  for (const group of groups) {
    const cue = groupCueSeconds(group)
    if (cue === null) {
      droppedUncued++
      continue
    }
    cuedLines.push(formatGroupLine(group, cue))
  }

  // Reserve room for the credit by trimming trailing track lines until the
  // composed body fits. Drop from the tail (not head): the credit is more
  // important than the last track. The first/cued tracks are the most useful
  // seek points and stay.
  let lines = cuedLines.slice()
  let droppedForLength = 0
  while (lines.length > 0 && composeBody(lines, credit).length > maxChars) {
    lines.pop()
    droppedForLength++
  }

  return {
    body: composeBody(lines, credit),
    shortLink,
    includedGroups: lines.length,
    droppedUncued,
    droppedForLength,
    truncated: droppedForLength > 0,
  }
}

function composeBody(lines: string[], credit: string): string {
  if (lines.length === 0) return credit
  return `${lines.join('\n')}\n\n${credit}`
}

function groupCueSeconds(group: ParsedTrack[]): number | null {
  for (const t of group) {
    if (t.startSeconds !== null) return t.startSeconds
  }
  return null
}

function formatGroupLine(group: ParsedTrack[], cue: number): string {
  const ts = formatTime(cue)
  const members = group.map(formatTrackText).filter((s) => s.length > 0)
  return members.length > 0 ? `${ts} ${members.join(' w/ ')}` : ts
}

function formatTrackText(t: ParsedTrack): string {
  const artist = t.artist.trim()
  const title = t.title.trim()
  if (artist && title) return `${artist} - ${title}`
  if (artist) return artist
  if (title) return title
  return 'ID'
}
