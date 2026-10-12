// What a YouTube Data API error reply says, kept apart from the HTTP code that
// carried it. Dependency-free on purpose: the Worker (youtube-playlists.ts,
// sync, Activity) and anything that only holds the stored text of an old error
// all use the same checks.
//
// "Out of quota" is one decision, made here:
//   - `isQuotaReason(reason)` is true for quotaExceeded and dailyLimitExceeded
//     (the project's 10 000 units a day are used up; resets at midnight Pacific)
//     and for rateLimitExceeded / userRateLimitExceeded (a short per-minute
//     limit). All four get the same handling: nothing else will succeed right
//     now, so the run stops its YouTube writes, and the failure is never
//     charged to the item (it is not abandoned for it).
//   - `quotaKind(reason)` tells the two apart for display: 'quota' (daily,
//     "quota exceeded") and 'rate_limit' ("rate limited").
// For a caught error use `isQuotaError(e)` (youtube-playlists.ts); for a reason
// string or stored error text use the functions below.

/** The daily project quota is used up; it resets at midnight Pacific time. */
export const DAILY_QUOTA_REASONS: readonly string[] = ['quotaExceeded', 'dailyLimitExceeded']
/** A short-lived per-minute / per-user limit. */
export const RATE_LIMIT_REASONS: readonly string[] = ['rateLimitExceeded', 'userRateLimitExceeded']

/** Out of quota or rate limited: retrying anything else right now is pointless, and the item is not at fault. */
export function isQuotaReason(reason: string | null | undefined): boolean {
  return !!reason && (DAILY_QUOTA_REASONS.includes(reason) || RATE_LIMIT_REASONS.includes(reason))
}

/** 'quota' (daily), 'rate_limit' (per minute), or null for any other reason. */
export function quotaKind(reason: string | null | undefined): 'quota' | 'rate_limit' | null {
  if (!reason) return null
  if (DAILY_QUOTA_REASONS.includes(reason)) return 'quota'
  return RATE_LIMIT_REASONS.includes(reason) ? 'rate_limit' : null
}

/**
 * SQL LIKE patterns that find a stored error as a quota one, for the Activity
 * query: the reason in new rows (`youtube <op> 403 quotaExceeded: ...`) and the
 * start of Google's quota message in old ones, whose stored text was cut
 * before the reason (`... because you have exceeded your <a href=`).
 */
export const QUOTA_LIKE = ['% 403 quotaExceeded:%', '% 403 dailyLimitExceeded:%', '%youtube%403: %have exceeded your%']
export const RATE_LIMIT_LIKE = ['% 403 rateLimitExceeded:%', '% 403 userRateLimitExceeded:%']

/** Google's message with tags dropped, entities and a cut-off tag cleaned up, on one line. */
export function cleanErrorMessage(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/<[^>]*$/, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/** `error.errors[0].reason` and `error.message` of a JSON error body; nulls when the body is not that. */
export function parseErrorBody(body: string): { reason: string | null; message: string | null } {
  try {
    const p = JSON.parse(body) as { error?: { message?: unknown; errors?: Array<{ reason?: unknown }> } }
    const reason = p.error?.errors?.[0]?.reason
    const message = p.error?.message
    return {
      reason: typeof reason === 'string' && reason ? reason : null,
      message: typeof message === 'string' && message ? cleanErrorMessage(message) : null,
    }
  } catch {
    return { reason: null, message: null }
  }
}

export type ParsedYouTubeError = {
  op: string | null
  status: number
  reason: string | null
  /** Google's message, cleaned; null when the text carries none. */
  message: string | null
  /** The raw reply body, when the text carries it. */
  raw: string | null
}

const TEXT_RE = /^(?:recheck:\s*)?youtube (?:([A-Za-z]+(?:\.[A-Za-z]+)*) )?(\d{3})(?: ([A-Za-z]+))?:\s*([\s\S]*)$/

/**
 * The structure of a stored error text. New texts read
 * `youtube <op> <status> <reason>: <clean message>\n<raw body>` (YouTubeApiError);
 * old ones `youtube <op> <status>: <raw body>`, cut at 500 characters (and
 * further, to 160, in a row summary), so a cut body is read with patterns
 * instead of JSON and a quota reply with no reason left is recognised by
 * Google's own wording. Null when the text is not a YouTube API error.
 */
export function parseYouTubeErrorText(text: string | null | undefined): ParsedYouTubeError | null {
  const m = TEXT_RE.exec((text ?? '').trim())
  if (!m) return null
  const op = m[1] ?? null
  const status = Number(m[2])
  let reason = m[3] ?? null
  const rest = m[4] ?? ''
  let message: string | null = null
  let raw: string | null = null
  if (rest.startsWith('{')) {
    raw = rest
    const body = parseErrorBody(rest)
    reason = reason ?? body.reason
    message = body.message
    if (!message) {
      // A body cut short: take the message text up to where it stops.
      const mm = /"message"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(rest)
      if (mm) {
        try { message = cleanErrorMessage(JSON.parse(`"${mm[1]}"`) as string) } catch { message = cleanErrorMessage(mm[1]!.replace(/\\(.)/g, '$1')) }
      }
    }
    reason = reason ?? /"reason"\s*:\s*"(\w+)"/.exec(rest)?.[1] ?? null
    // The legacy text cut before the reason: Google's quota wording stands for it.
    if (!reason && status === 403 && /have exceeded your|youtube\.quota/.test(rest)) reason = 'quotaExceeded'
  } else {
    const nl = rest.indexOf('\n')
    message = (nl < 0 ? rest : rest.slice(0, nl)).trim() || null
    raw = nl < 0 ? null : rest.slice(nl + 1).trim() || null
  }
  return { op, status, reason, message, raw }
}

export type YouTubeErrorView = {
  /** 'quota' / 'rate_limit' are waits the system retries by itself; 'other' is any other YouTube reply. */
  kind: 'quota' | 'rate_limit' | 'other'
  /** Short status: "quota exceeded", "rate limited", or null for 'other'. */
  label: string | null
  /** One readable line: the explanation for a wait, else `op status reason: message`. */
  headline: string
  /** One plain sentence on what happens next; null for 'other'. */
  explanation: string | null
  /** The raw reply body for a collapsed details element; null when none was kept. */
  raw: string | null
  /** True for a quota / rate-limit reply on a row that is still tried again (status `failed`): a wait, shown amber. */
  wait: boolean
}

const QUOTA_EXPLANATION = "YouTube's daily quota is used up. It resets at midnight Pacific time, and tracked will try again."
const RATE_LIMIT_EXPLANATION = 'YouTube is limiting requests for the moment. tracked will try again.'

/** The row statuses a quota reply is still a wait for: the item is tried again (an `abandoned` one is not). */
const WAIT_ROW_STATUSES = ['failed', 'quota', 'rate_limited']

/**
 * How a stored error text is shown; null when it is not a YouTube API error.
 * `rowStatus` is the status of the row that holds the text: a quota reply is a
 * wait only on a row that is still tried again. On an `abandoned` row (given up
 * before quota replies stopped being charged) it says so instead. Only a 403
 * is a quota reply, as in `isQuotaError`: a 429 was charged as an ordinary failure.
 */
export function describeYouTubeError(text: string | null | undefined, rowStatus?: string | null): YouTubeErrorView | null {
  const p = parseYouTubeErrorText(text)
  if (!p) return null
  const kind = p.status === 403 ? quotaKind(p.reason) : null
  const wait = !rowStatus || WAIT_ROW_STATUSES.includes(rowStatus)
  if (kind && wait) {
    const e = kind === 'quota' ? QUOTA_EXPLANATION : RATE_LIMIT_EXPLANATION
    return { kind, label: kind === 'quota' ? 'quota exceeded' : 'rate limited', headline: e, explanation: e, raw: p.raw, wait: true }
  }
  if (kind) {
    const what = kind === 'quota' ? "YouTube's daily quota was used up" : 'YouTube was rate limiting requests'
    return { kind, label: null, headline: `Given up after repeated failures; ${what} (it was charged to the set). Invalidate & resync on the DJs page gives it another chance.`, explanation: null, raw: p.raw, wait: false }
  }
  const head = [p.op, String(p.status)].filter(Boolean).join(' ') + (p.reason ? ` ${p.reason}` : '')
  return { kind: 'other', label: null, headline: p.message ? `${head}: ${p.message}` : head, explanation: null, raw: p.raw, wait: false }
}

/** A stored error as one readable line: a YouTube API error by its headline, anything else as it is. */
export function errorOneLine(text: string | null | undefined, rowStatus?: string | null): string | null {
  if (!text) return null
  return describeYouTubeError(text, rowStatus)?.headline ?? text
}
