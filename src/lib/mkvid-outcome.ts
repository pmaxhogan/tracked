/**
 * Why an mkvid request ended, derived from its stored `status` and `error`.
 *
 * The stored status says only `failed` for three different things, and only
 * one of them is a failure someone can act on:
 *
 *   - `recording_removed`  mkvid could not open the recording at its source:
 *                          it was deleted, made private or blocked there.
 *   - `recording_short`    the recording ends before the tracklist does
 *                          (`incomplete_recording`): a part of the set.
 *   - `failed`             anything else, an unrecognised text included.
 *
 * The first two are not problems: there is no usable recording of the set,
 * Retry fails the same way, and nobody can change that from here. They are
 * shown neutral and never counted as failures. `superseded` is split the same
 * way, by the text stored when it happened (`has_recording`, `duplicate`).
 *
 * Nothing is stored: the same rules exist as a function (mkvidOutcome) and as
 * SQL (mkvidOutcomeSql), built from the lists below, so a list endpoint can
 * filter, sort and count by outcome across all its pages. The stored `status`
 * values, which mkvid's API uses, are untouched.
 */

export type MkvidNoRecording = 'recording_removed' | 'recording_short'
/** `failed`, split. */
export type MkvidFailureKind = MkvidNoRecording | 'failed'
/** Where a request that left the queue ended. */
export type MkvidOutcome = 'done' | MkvidFailureKind | 'has_recording' | 'duplicate' | 'superseded' | 'banned'
export const MKVID_OUTCOMES: readonly MkvidOutcome[] = ['done', 'failed', 'recording_removed', 'recording_short', 'has_recording', 'duplicate', 'superseded', 'banned']
export const MKVID_NO_RECORDING: readonly MkvidNoRecording[] = ['recording_removed', 'recording_short']

export const MKVID_OUTCOME_LABELS: Record<MkvidOutcome, string> = {
  done: 'uploaded',
  failed: 'failed',
  recording_removed: 'recording removed',
  recording_short: 'recording too short',
  has_recording: 'has a recording',
  duplicate: 'duplicate',
  superseded: 'superseded',
  banned: 'banned',
}

// Every text below is lower case ASCII without quotes, `%` or `\`: it is
// compared against the folded error, and written into SQL as it is.

/** mkvid's refusal when the source is shorter than the tracklist's last cue. */
const SHORT_PREFIX = 'incomplete_recording'
/**
 * mkvid's two checks before it downloads anything (resolving the source URL,
 * probing it with yt-dlp). Only a refusal from one of them is about the
 * recording itself: the same words in a later error (a render, an upload)
 * are about something else.
 */
const SOURCE_STAGES = ['probe:', 'source:']
/**
 * What a source that is gone answers there: the source-gone part of
 * KNOWN_PERMANENT_RE (lib/mkvid.ts). `404` is spelled as yt-dlp and mkvid's
 * hearthis lookup print it, because a bare 404 also occurs inside track ids.
 * `unsupported url` and `no video formats` are left out: they can be a fault
 * on our side, so they stay failures.
 */
const GONE_MARKS = ['http error 404', ': http 404', 'not available', 'is private', 'private track', 'private video', 'removed', 'does not exist', 'geo restricted', 'geo-restricted', 'georestricted']
/** yt-dlp's "Requested format is not available" is about formats, not about the recording. */
const NOT_GONE_MARKS = ['requested format']

/** Stored when the claim or the sync superseded a request (lib/mkvid.ts). */
const DUPLICATE_PREFIXES = ['same tracklist as ', 'duplicate of the same 1001tracklists id under another url']
const HAS_RECORDING_PREFIX = '1001tracklists now has '
const RESOLVES_PREFIX = 'set already resolves to '
const RESOLVES_1001TL = '(1001tl)'

/** ASCII-only lower case: what SQLite's lower() does. */
const fold = (s: string) => s.replace(/[A-Z]/g, (ch) => ch.toLowerCase())

/** Why a `failed` request failed. Conservative: a text it does not recognise is a failure. */
export function mkvidFailureKind(error: string | null | undefined): MkvidFailureKind {
  const e = fold(error ?? '')
  if (e.startsWith(SHORT_PREFIX)) return 'recording_short'
  if (SOURCE_STAGES.some((p) => e.startsWith(p)) && GONE_MARKS.some((m) => e.includes(m)) && !NOT_GONE_MARKS.some((m) => e.includes(m))) return 'recording_removed'
  return 'failed'
}

/** The outcome of a request; a request still in the queue (`pending`, `claimed`) has none. */
export function mkvidOutcome(r: { status: string; error?: string | null }): MkvidOutcome | null {
  switch (r.status) {
    case 'done': return 'done'
    case 'banned': return 'banned'
    case 'failed': return mkvidFailureKind(r.error)
    case 'superseded': {
      const e = fold(r.error ?? '')
      if (DUPLICATE_PREFIXES.some((p) => e.startsWith(p))) return 'duplicate'
      if (e.startsWith(HAS_RECORDING_PREFIX) || (e.startsWith(RESOLVES_PREFIX) && e.includes(RESOLVES_1001TL))) return 'has_recording'
      return 'superseded'
    }
    default: return null
  }
}

export function isNoRecording(outcome: string | null | undefined): outcome is MkvidNoRecording {
  return outcome === 'recording_removed' || outcome === 'recording_short'
}

// ── the same rules in SQL ──

const folded = (error: string) => `lower(COALESCE(${error}, ''))`
const starts = (e: string, p: string) => `instr(${e}, '${p}') = 1`
const has = (e: string, m: string) => `instr(${e}, '${m}') > 0`
const any = (parts: string[]) => `(${parts.join(' OR ')})`

/** SQL condition: mkvidFailureKind(error) is 'recording_short'. */
const shortSql = (error: string) => starts(folded(error), SHORT_PREFIX)
/** SQL condition: mkvidFailureKind(error) is 'recording_removed'. */
function removedSql(error: string): string {
  const e = folded(error)
  return `(NOT ${starts(e, SHORT_PREFIX)} AND ${any(SOURCE_STAGES.map((p) => starts(e, p)))} AND ${any(GONE_MARKS.map((m) => has(e, m)))} AND NOT ${any(NOT_GONE_MARKS.map((m) => has(e, m)))})`
}

/** SQL condition over an error column: the failure is one of the two no-recording kinds. */
export function mkvidNoRecordingSql(error: string): string {
  return `(${shortSql(error)} OR ${removedSql(error)})`
}

/** SQL expression: `failed` split into its kinds, any other status as it is stored (mkvidFailureKind). */
export function mkvidFailureKindSql(status: string, error: string): string {
  return `(CASE WHEN ${status} != 'failed' THEN ${status} WHEN ${shortSql(error)} THEN 'recording_short' WHEN ${removedSql(error)} THEN 'recording_removed' ELSE 'failed' END)`
}

/** SQL expression: mkvidOutcome, NULL for a request still in the queue. */
export function mkvidOutcomeSql(status: string, error: string): string {
  const e = folded(error)
  return `(CASE ${status}
    WHEN 'done' THEN 'done'
    WHEN 'banned' THEN 'banned'
    WHEN 'failed' THEN (CASE WHEN ${shortSql(error)} THEN 'recording_short' WHEN ${removedSql(error)} THEN 'recording_removed' ELSE 'failed' END)
    WHEN 'superseded' THEN (CASE WHEN ${any(DUPLICATE_PREFIXES.map((p) => starts(e, p)))} THEN 'duplicate'
      WHEN ${starts(e, HAS_RECORDING_PREFIX)} OR (${starts(e, RESOLVES_PREFIX)} AND ${has(e, RESOLVES_1001TL)}) THEN 'has_recording'
      ELSE 'superseded' END)
    END)`
}

// ── plain words ──

const SOURCE_NAMES: Record<string, string> = { soundcloud: 'SoundCloud', hearthis: 'hearthis.at' }

/** 1824 -> "30:24", 7009 -> "1:56:49". */
function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  const two = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`
}

/** What a gone source answered, in a few words; null when the text names none of these. */
function goneWhy(error: string): string | null {
  const e = fold(error)
  if (e.includes('http error 404') || e.includes(': http 404')) return 'the link answers "not found"'
  if (e.includes('private')) return 'it is private now'
  if (e.includes('geo')) return 'it is blocked in this region'
  if (e.includes('removed') || e.includes('does not exist')) return 'it was taken down'
  if (e.includes('not available')) return 'it is not available'
  return null
}

/**
 * One short plain line for a no-recording outcome, with the specifics the
 * stored error carries (the two durations; what the source answered). Null for
 * every other outcome.
 */
export function mkvidOutcomeLine(r: { status: string; error?: string | null; source?: string | null }): string | null {
  const outcome = mkvidOutcome(r)
  const error = r.error ?? ''
  if (outcome === 'recording_short') {
    const m = /source is (\d+(?:\.\d+)?)s\b.*?last cue is at (\d+(?:\.\d+)?)s\b/.exec(error)
    return m ? `The recording is ${clock(Number(m[1]))} long, but the last track starts at ${clock(Number(m[2]))}.` : 'The recording ends before the tracklist does.'
  }
  if (outcome === 'recording_removed') {
    const where = SOURCE_NAMES[r.source ?? ''] ?? 'its source'
    const why = goneWhy(error)
    return `The recording is gone from ${where}${why ? ` (${why})` : ''}.`
  }
  return null
}

/** mkvidOutcomeLine plus what it means for the owner: the tooltip and the details text. */
export function mkvidOutcomeDetail(r: { status: string; error?: string | null; source?: string | null }): string | null {
  const line = mkvidOutcomeLine(r)
  if (!line) return null
  const outcome = mkvidOutcome(r)
  return outcome === 'recording_short'
    ? `${line} It is a part of the set, not the whole set, so no video is made. Nothing to do: Retry fails the same way. If the tracklist page later links a different recording, the set is queued again by itself.`
    : `${line} No video can be made without it. Nothing to do: Retry only helps if the recording comes back. If the tracklist page later links a different recording, the set is queued again by itself.`
}
