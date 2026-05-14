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
 *  - trailing uncued tracks (those after the last cued group, common when
 *    1001tl only ID'd the opener and a few mid-set drops) get evenly-spaced
 *    interpolated starts in [lastCuedStart, setEndSeconds] when
 *    setEndSeconds is provided, so playback past the last cue still resolves
 *    to a plausible track instead of pinning forever on the last cued one.
 */
export function selectCurrent(
  tracks: ParsedTrack[],
  currentSeconds: number,
  setEndSeconds: number | null = null,
): SelectionResult {
  const groups = groupByMashup(tracks)
  if (groups.length === 0) return { picked: [], anyUnidentified: false }

  // Effective starts: real cue when present, evenly-spaced interpolated cue
  // for trailing uncued groups when setEndSeconds is known. Used by both
  // current-group selection and per-track duration computation so they stay
  // consistent.
  const effectiveStarts = computeEffectiveStarts(groups, setEndSeconds)
  const durations = computeDurations(groups, effectiveStarts, setEndSeconds)

  // Find the group whose [start, nextStart) range contains currentSeconds.
  // Returns -1 if currentSeconds is before any cued group (which means the
  // listener is in an intro / pre-roll / silent section).
  let currentIdx = -1
  for (let i = 0; i < groups.length; i++) {
    const start = effectiveStarts[i]
    if (start == null) continue
    const nextStart = nextEffectiveStart(effectiveStarts, i)
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

  const response: ResponseTrack[] = picked.map((t) => {
    const dur = durations.get(t) ?? null
    return {
      title: t.title,
      artist: t.artist,
      startTime: t.startTime,
      startSeconds: t.startSeconds,
      durationSeconds: dur,
      durationTime: dur !== null ? formatTime(dur) : '',
      isCurrent: currentMembers.has(t),
      isUnidentified: t.isUnidentified,
      idStatus: t.idStatus,
      appleLink: null,
      youtubeLink: null,
      trackUrl: t.trackUrl,
      artworkUrl: t.artworkUrl,
    }
  })

  return {
    picked: response,
    anyUnidentified: picked.some((t) => currentMembers.has(t) && t.isUnidentified),
  }
}

/**
 * Map each group to a usable start-time for range matching. Real cues pass
 * through. Trailing uncued groups (everything after the last cued group) get
 * interpolated starts when setEndSeconds is provided so trailing-track
 * positions are a best-guess instead of `null`.
 *
 * The interpolation slot is `min(medianCuedDuration, evenSlot)` where
 * `evenSlot = (setEndSeconds − lastCuedStart) / (trailingCount + 1)`. Capping
 * by the median of observed cued-track gaps keeps the last cued group from
 * being inflated to an unrealistic length when the trailing list is short:
 * a 1:20 opener shouldn't be projected to play for 6+ minutes just because
 * 1001tl didn't ID the rest of the set. Capping by `evenSlot` keeps the
 * projected trailing tracks from extending past the end of the video when
 * cued tracks are unusually long.
 *
 * Leading and internal uncued groups (rare) keep `null` — interpolating those
 * would risk pulling a hidden intro into the current selection in cases
 * (live mixes with an untimed opening) where the existing "before-first-cue"
 * fallback already does the right thing.
 */
function computeEffectiveStarts(
  groups: ParsedTrack[][],
  setEndSeconds: number | null,
): (number | null)[] {
  const out = groups.map(groupStartSeconds)
  if (setEndSeconds === null) return out

  let lastCuedIdx = -1
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] !== null) { lastCuedIdx = i; break }
  }
  if (lastCuedIdx < 0 || lastCuedIdx === out.length - 1) return out

  const lastCuedStart = out[lastCuedIdx]!
  if (setEndSeconds <= lastCuedStart) return out

  const trailing = out.length - lastCuedIdx - 1
  const evenSlot = (setEndSeconds - lastCuedStart) / (trailing + 1)

  // Median of cued-group gaps (each gap is a track's actual playing window).
  const gaps: number[] = []
  for (let i = 1; i <= lastCuedIdx; i++) {
    const a = out[i - 1]
    const b = out[i]
    if (a != null && b != null && b > a) gaps.push(b - a)
  }
  let slot = evenSlot
  if (gaps.length > 0) {
    gaps.sort((a, b) => a - b)
    const median = gaps[Math.floor(gaps.length / 2)]!
    slot = Math.min(median, evenSlot)
  }

  for (let i = lastCuedIdx + 1; i < out.length; i++) {
    out[i] = lastCuedStart + slot * (i - lastCuedIdx)
  }
  return out
}

function nextEffectiveStart(starts: (number | null)[], i: number): number | null {
  for (let j = i + 1; j < starts.length; j++) {
    const s = starts[j]
    if (s != null) return s
  }
  return null
}

function computeDurations(
  groups: ParsedTrack[][],
  effectiveStarts: (number | null)[],
  setEndSeconds: number | null,
): Map<ParsedTrack, number | null> {
  const out = new Map<ParsedTrack, number | null>()
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!
    const start = effectiveStarts[i]
    let dur: number | null = null
    if (start != null) {
      const next = nextEffectiveStart(effectiveStarts, i)
      const end = next ?? setEndSeconds
      if (end !== null && end > start) dur = end - start
    }
    for (const t of group) out.set(t, dur)
  }
  return out
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
