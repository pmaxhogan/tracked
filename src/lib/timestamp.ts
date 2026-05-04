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
 * Pick currently-playing track(s) plus any inside the transition window,
 * grouping w/ siblings. `tracks` must be in document order.
 *
 * `currentSeconds` is the playback offset in the original DJ set.
 *
 * Rules:
 *  - "Current group": tracks whose startSeconds <= currentSeconds < nextStartSeconds,
 *    plus any subsequent rows marked isMashupLinked (w/) that share the same group.
 *  - "Transition window":
 *      • include the previous group if its members started within `windowSeconds` before now
 *      • include the next group if its first member starts within `windowSeconds` after now
 *  - Tracks with null startSeconds (no cue) are skipped for time-based selection but kept
 *    if they are mashup-linked siblings of a selected track.
 */
export function selectCurrent(
  tracks: ParsedTrack[],
  currentSeconds: number,
  windowSeconds: number,
): SelectionResult {
  const groups = groupByMashup(tracks)

  let currentIdx = -1
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!
    const groupStart = groupStartSeconds(g)
    if (groupStart === null) continue
    const next = groups[i + 1]
    const nextStart = next ? groupStartSeconds(next) : null
    if (groupStart <= currentSeconds && (nextStart === null || currentSeconds < nextStart)) {
      currentIdx = i
      break
    }
  }

  const picked: ParsedTrack[] = []
  const currentMembers = new Set<ParsedTrack>()

  if (currentIdx >= 0) {
    const g = groups[currentIdx]!
    const currentStart = groupStartSeconds(g)
    for (const t of g) {
      picked.push(t)
      currentMembers.add(t)
    }
    const prev = groups[currentIdx - 1]
    if (prev && currentStart !== null && currentSeconds - currentStart <= windowSeconds) {
      picked.unshift(...prev)
    }
    const next = groups[currentIdx + 1]
    if (next) {
      const nextStart = groupStartSeconds(next)
      if (nextStart !== null && nextStart - currentSeconds <= windowSeconds) {
        picked.push(...next)
      }
    }
  } else {
    const next = groups.find((g) => {
      const s = groupStartSeconds(g)
      return s !== null && s > currentSeconds && s - currentSeconds <= windowSeconds
    })
    if (next) {
      picked.push(...next)
    }
  }

  const response: ResponseTrack[] = picked.map((t) => ({
    title: t.title,
    artist: t.artist,
    startTime: t.startTime,
    startSeconds: t.startSeconds,
    isCurrent: currentMembers.has(t),
    isUnidentified: t.isUnidentified,
    appleLink: null,
    youtubeLink: null,
    trackUrl: t.trackUrl,
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
