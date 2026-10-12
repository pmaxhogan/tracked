import { describe, it, expect } from 'vitest'
import { describeYouTubeError, isQuotaReason, parseErrorBody, parseYouTubeErrorText, quotaKind } from '../src/lib/youtube-error'
import { isQuotaError, YouTubeApiError } from '../src/lib/youtube-playlists'

/** The reply the owner saw as a wall of JSON (2026-10-11, playlistItems.insert). */
export const QUOTA_BODY = JSON.stringify({
  error: {
    code: 403,
    message: 'The request cannot be completed because you have exceeded your <a href="/youtube/v3/getting-started#quota">quota</a>.',
    errors: [{ message: 'The request cannot be completed because you have exceeded your <a href="/youtube/v3/getting-started#quota">quota</a>.', domain: 'youtube.quota', reason: 'quotaExceeded' }],
  },
})
/** What the stored row said before the error was structured: `youtube <op> <status>: <body>`, clipped. */
export const LEGACY_FULL = `youtube playlistItems.insert 403: ${QUOTA_BODY}`
export const LEGACY_CLIPPED = LEGACY_FULL.slice(0, 160)

describe('youtube error reasons', () => {
  it('knows which reasons are quota and which kind', () => {
    for (const r of ['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded', 'userRateLimitExceeded']) expect(isQuotaReason(r), r).toBe(true)
    for (const r of ['videoNotFound', 'forbidden', '', null, undefined]) expect(isQuotaReason(r), String(r)).toBe(false)
    expect(quotaKind('quotaExceeded')).toBe('quota')
    expect(quotaKind('dailyLimitExceeded')).toBe('quota')
    expect(quotaKind('userRateLimitExceeded')).toBe('rate_limit')
    expect(quotaKind('videoNotFound')).toBeNull()
  })

  it('parses reason and a clean message out of the exact body', () => {
    expect(parseErrorBody(QUOTA_BODY)).toEqual({ reason: 'quotaExceeded', message: 'The request cannot be completed because you have exceeded your quota.' })
    expect(parseErrorBody('<html>bad gateway</html>')).toEqual({ reason: null, message: null })
  })

  it('YouTubeApiError carries a readable first line, the reason and the raw body', () => {
    const e = new YouTubeApiError('playlistItems.insert', 403, 'quotaExceeded', QUOTA_BODY)
    expect(e.message.split('\n')[0]).toBe('youtube playlistItems.insert 403 quotaExceeded: The request cannot be completed because you have exceeded your quota.')
    expect(e.message).toContain(QUOTA_BODY)
    expect(isQuotaError(e)).toBe(true)
    expect(isQuotaError(new YouTubeApiError('playlistItems.insert', 404, 'videoNotFound', '{}'))).toBe(false)
    expect(isQuotaError(new YouTubeApiError('playlistItems.insert', 500, 'quotaExceeded', '{}'))).toBe(false)
  })

  it('reads a new text, a full legacy text and a clipped legacy text the same', () => {
    const fresh = new YouTubeApiError('playlistItems.insert', 403, 'quotaExceeded', QUOTA_BODY).message
    for (const t of [fresh, LEGACY_FULL, LEGACY_CLIPPED, 'recheck: ' + LEGACY_CLIPPED]) {
      const p = parseYouTubeErrorText(t)!
      expect(p, t).toMatchObject({ op: 'playlistItems.insert', status: 403, reason: 'quotaExceeded' })
      expect(describeYouTubeError(t), t).toMatchObject({ kind: 'quota', label: 'quota exceeded' })
    }
    expect(parseYouTubeErrorText(LEGACY_CLIPPED)!.message).toBe('The request cannot be completed because you have exceeded your')
  })

  it('shows quota as a wait with one plain sentence, anything else as one readable line', () => {
    const q = describeYouTubeError(LEGACY_FULL)!
    expect(q.explanation).toBe("YouTube's daily quota is used up. It resets at midnight Pacific time, and tracked will try again.")
    expect(q.headline).toBe(q.explanation)
    expect(q.raw).toBe(QUOTA_BODY)
    const rl = describeYouTubeError('youtube playlistItems.insert 403 userRateLimitExceeded: Too fast.\n{}')!
    expect(rl).toMatchObject({ kind: 'rate_limit', label: 'rate limited' })
    const nf = describeYouTubeError(new YouTubeApiError('playlistItems.insert', 404, 'videoNotFound', JSON.stringify({ error: { message: 'Video not found.', errors: [{ reason: 'videoNotFound' }] } })).message)!
    expect(nf).toMatchObject({ kind: 'other', label: null, headline: 'playlistItems.insert 404 videoNotFound: Video not found.' })
    expect(nf.raw).toContain('"videoNotFound"')
    expect(describeYouTubeError('connection reset')).toBeNull()
    expect(describeYouTubeError('youtube playlistItems.insert: playlist not found (PL1)')).toBeNull()
  })

  it('only a 403 is a quota reply; a 429 (charged as an ordinary failure) and an abandoned row are not a wait', () => {
    const t = new YouTubeApiError('playlistItems.insert', 429, 'rateLimitExceeded', '{}').message
    expect(describeYouTubeError(t)).toMatchObject({ kind: 'other', wait: false })
    const q = new YouTubeApiError('playlistItems.insert', 403, 'quotaExceeded', QUOTA_BODY).message
    expect(describeYouTubeError(q, 'failed')).toMatchObject({ kind: 'quota', wait: true, label: 'quota exceeded' })
    const given = describeYouTubeError(q, 'abandoned')!
    expect(given).toMatchObject({ kind: 'quota', wait: false, label: null, explanation: null })
    expect(given.headline).toMatch(/^Given up after repeated failures; YouTube's daily quota was used up/)
    expect(given.headline).not.toMatch(/will try again/)
  })

  it('the "have exceeded your" wording stands for the reason only in the legacy clipped body, not in any text', () => {
    expect(parseYouTubeErrorText('youtube playlistItems.insert 403: you have exceeded your patience')!.reason).toBeNull()
    expect(parseYouTubeErrorText('youtube playlistItems.insert 404: { "error": { "message": "you have exceeded your <a')!.reason).toBeNull()
    expect(parseYouTubeErrorText(LEGACY_CLIPPED)!.reason).toBe('quotaExceeded')
  })

  it('a 403 that is not quota stays "other", also when the body is cut', () => {
    const t = 'youtube playlistItems.insert 403: { "error": { "code": 403, "message": "The caller does not have permission", "errors": [ { "reason": "forbidden"'
    expect(describeYouTubeError(t)).toMatchObject({ kind: 'other', headline: 'playlistItems.insert 403 forbidden: The caller does not have permission' })
  })
})
