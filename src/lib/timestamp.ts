import type { ParsedTrack, ResponseTrack } from '../types'

const TIME_PATTERN = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/

export function parseTime(s: string): number | null {
  const m = s.trim().match(TIME_PATTERN)
  if (!m) return null
  const h = m[1] ? Number(m[1]) : 0
  const min = Number(m[2])
  const sec = Number(m[3])
  if (Number.isNaN(h) || Number.isNaN(min) || Number.isNaN(sec)) return null
  if (min >= 60 || sec >= 60) return null
  return h * 3600 + min * 60 + sec
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

export type SelectionResult = {
  /** All tracks to include in response (current + transition-window). */
  picked: ResponseTrack[]
  /** True if any picked track is unidentified (caller may set status). */
  anyUnidentified: boolean
}

/**
 * Return the currently-playing group plus the immediately-previous and
 * immediately-next groups, so the caller has one-tap context without
 * rewinding/fast-forwarding the source video. Mashup-linked siblings ("w/")
 * count as one group, so a current pair returns both members and the prev/next
 * "group" might itself be a pair.
 *
 * `tracks` must be in document order (= chronological by cue time).
 *
 * Edge cases:
 *  - currentSeconds is before any cued track → no current; we return the
 *    first cued group as a "next-up" hint (all isCurrent=false).
 *  - first track in the tracklist → no previous, just [current, next].
 *  - last track in the tracklist → no next, just [previous, current].
 *  - single-track tracklist → just [current].
 *  - empty tracklist → [].
 *  - tracks without a cue (startSeconds === null) are skipped for current
 *    selection but stay attached to their parent group via isMashupLinked.
 */
export function selectCurrent(tracks: ParsedTrack[], currentSeconds: number): SelectionResult {
  const groups = groupByMashup(tracks)
  if (groups.length === 0) return { picked: [], anyUnidentified: false }

  // Find the group whose [start, nextStart) range contains currentSeconds.
  // Returns -1 if currentSeconds is before any cued group (which means the
  // listener is in an intro / pre-roll / silent section).
  let currentIdx = -1
  for (let i = 0; i < groups.length; i++) {
    const start = groupStartSeconds(groups[i]!)
    if (start === null) continue
    const next = groups[i + 1]
    const nextStart = next ? groupStartSeconds(next) : null
    if (start <= currentSeconds && (nextStart === null || currentSeconds < nextStart)) {
      currentIdx = i
      break
    }
  }

  const picked: ParsedTrack[] = []
  const currentMembers = new Set<ParsedTrack>()

  if (currentIdx === -1) {
    // Before the first cued group: offer up the first cued group as next-up.
    const firstCued = groups.find((g) => groupStartSeconds(g) !== null)
    if (firstCued) picked.push(...firstCued)
  } else {
    const prev = groups[currentIdx - 1]
    if (prev) picked.push(...prev)

    const cur = groups[currentIdx]!
    for (const t of cur) {
      picked.push(t)
      currentMembers.add(t)
    }

    const next = groups[currentIdx + 1]
    if (next) picked.push(...next)
  }

  const response: ResponseTrack[] = picked.map((t) => ({
    title: t.title,
    artist: t.artist,
    startTime: t.startTime,
    startSeconds: t.startSeconds,
    isCurrent: currentMembers.has(t),
    isUnidentified: t.isUnidentified,
    idStatus: t.idStatus,
    appleLink: null,
    youtubeLink: null,
    trackUrl: t.trackUrl,
    artworkUrl: t.artworkUrl,
  }))

  return {
    picked: response,
    anyUnidentified: picked.some((t) => currentMembers.has(t) && t.isUnidentified),
  }
}

function groupByMashup(tracks: ParsedTrack[]): ParsedTrack[][] {
  const groups: ParsedTrack[][] = []
  for (const t of tracks) {
    if (t.isMashupLinked && groups.length > 0) {
      groups[groups.length - 1]!.push(t)
    } else {
      groups.push([t])
    }
  }
  return groups
}

function groupStartSeconds(group: ParsedTrack[]): number | null {
  for (const t of group) {
    if (t.startSeconds !== null) return t.startSeconds
  }
  return null
}
