/**
 * The full-recording rule (spec decision 21): a YouTube video linked from a
 * 1001tracklists set page is NOT a full recording of the set, and is never
 * added to a playlist, when any of these holds:
 *
 *   (a) `notice`        the page shows 1001tracklists' "Currently no (full)
 *                       recording available" notice
 *   (b) `short`         the video is more than 5 minutes shorter than the last
 *                       cue on the tracklist
 *   (c) `audio_longer`  an audio player on the page (SoundCloud, Mixcloud) is
 *                       more than 10 minutes longer than the video
 *   (d) `vertical`      the video is taller than it is wide (a phone clip / Short)
 *
 * The decision is pure. Every input may be unknown (null): an unknown input
 * never rejects, it only means that rule could not be applied. The sync reads
 * (a)-(c) from the page it just fetched; the sweep reads them from
 * `set_media_facts`, which the sync writes on every page fetch.
 */

export type RejectReason = 'notice' | 'short' | 'audio_longer' | 'vertical'

export const REJECT_REASON_LABELS: Record<RejectReason, string> = {
  notice: '1001tracklists says no full recording is available',
  short: 'video is more than 5 min shorter than the last cue',
  audio_longer: 'an audio recording on the page is over 10 min longer',
  vertical: 'vertical video',
}

/** (b): a video this much shorter than the last cue cannot hold the whole set. */
export const SHORTER_THAN_CUE_TOLERANCE_SECONDS = 5 * 60
/** (c): an audio recording this much longer than the video means the video is a cut. */
export const AUDIO_LONGER_TOLERANCE_SECONDS = 10 * 60

export type FullRecordingInput = {
  /** Page shows the no-full-recording notice. null = page not seen. */
  notice: boolean | null
  /** Largest cue on the tracklist, seconds. */
  lastCueSeconds: number | null
  /** Video duration from the YouTube Data API. */
  videoSeconds: number | null
  /** Longest audio player (SoundCloud / Mixcloud) duration on the page. */
  audioMaxSeconds: number | null
  /** videos.list player.embedWidth / embedHeight (requested with maxWidth). */
  embedWidth: number | null
  embedHeight: number | null
  /** Apply rule (d). Off unless `REJECT_VERTICAL` is set (lib/playlist-hygiene.ts rejectVerticalEnabled). */
  rejectVertical?: boolean
}

export type FullRecordingDecision = { ok: true } | { ok: false; reason: RejectReason; detail: string }

const known = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n)

/**
 * Orientation from the embed size YouTube scales to the video's aspect ratio.
 * TODO(live check): the embed dimensions for a Short have not been observed
 * from this codebase yet (no network while it was written). If a known Short
 * comes back with embedHeight <= embedWidth, switch this to oEmbed
 * (youtube.com/oembed width/height) — the rule stays in this one function.
 */
export function isVertical(embedWidth: number | null, embedHeight: number | null): boolean | null {
  if (!known(embedWidth) || !known(embedHeight) || embedWidth <= 0 || embedHeight <= 0) return null
  return embedHeight > embedWidth
}

/** Pure: is this video a full recording of the set? First failing rule wins, in (a)-(d) order. */
export function decideFullRecording(i: FullRecordingInput): FullRecordingDecision {
  if (i.notice === true) return { ok: false, reason: 'notice', detail: 'page: "Currently no (full) recording available"' }
  if (known(i.videoSeconds) && i.videoSeconds > 0) {
    if (known(i.lastCueSeconds) && i.videoSeconds < i.lastCueSeconds - SHORTER_THAN_CUE_TOLERANCE_SECONDS) {
      return { ok: false, reason: 'short', detail: `video ${fmt(i.videoSeconds)} < last cue ${fmt(i.lastCueSeconds)} - 5:00` }
    }
    if (known(i.audioMaxSeconds) && i.audioMaxSeconds > i.videoSeconds + AUDIO_LONGER_TOLERANCE_SECONDS) {
      return { ok: false, reason: 'audio_longer', detail: `audio ${fmt(i.audioMaxSeconds)} > video ${fmt(i.videoSeconds)} + 10:00` }
    }
  }
  if (i.rejectVertical === true && isVertical(i.embedWidth, i.embedHeight) === true) {
    return { ok: false, reason: 'vertical', detail: `embed ${i.embedWidth}x${i.embedHeight}` }
  }
  return { ok: true }
}

// ─── page extractors ────────────────────────────────────────────────────────

/**
 * Rule (a). Markup seen on saved pages (test/fixtures/tracklist-matroda.html,
 * and every research copy of that set, 2026-09):
 *
 *   <div class="bItmH"> <i class="fa fa-24 fa-info-circle mA spR"></i><span>Currently no
 *   (full) recording available, tracklist incomplete and track order might not be correct.</span> </div>
 *
 * That page links a YouTube video anyway, which is exactly the case the rule
 * exists for. Matched on the text, not the classes, and tolerant of the
 * parentheses and spacing being dropped.
 */
const NO_FULL_NOTICE_RE = /currently\s+no\s+\(?\s*full\s*\)?\s+recording\s+available/i

export function hasNoFullRecordingNotice(html: string): boolean {
  return NO_FULL_NOTICE_RE.test(html)
}

/**
 * Audio players 1001tracklists builds on a set page, with their duration in
 * seconds, as the page scripts construct them:
 *
 *   new AudioPlayerSC("scWidget_…", { idPlayer: "…", type: "soundcloud", source: "…", duration: "4569" })
 *   new AudioPlayerMC("mcWidget_…", { idPlayer: "…", source: "…", duration: "7200" })
 *
 * Read straight from the HTML the sync already has — no extra request.
 */
const AUDIO_PLAYER_RE = /new\s+AudioPlayer([A-Z]{2,})\(\s*"[^"]*"\s*,\s*\{([^}]{0,400})\}/g

export function extractAudioDurations(html: string): Array<{ kind: string; seconds: number }> {
  const out: Array<{ kind: string; seconds: number }> = []
  AUDIO_PLAYER_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = AUDIO_PLAYER_RE.exec(html))) {
    const d = m[2]!.match(/duration\s*:\s*"?(\d+)"?/)
    if (!d) continue
    const seconds = Number(d[1])
    if (!Number.isFinite(seconds) || seconds <= 0) continue
    const code = m[1]!
    out.push({ kind: code === 'SC' ? 'soundcloud' : code === 'MC' ? 'mixcloud' : code.toLowerCase(), seconds })
  }
  return out
}

export function maxAudioSeconds(html: string): number | null {
  let max: number | null = null
  for (const a of extractAudioDurations(html)) if (max === null || a.seconds > max) max = a.seconds
  return max
}

function fmt(s: number): string {
  const t = Math.round(s)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const sec = t % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}
