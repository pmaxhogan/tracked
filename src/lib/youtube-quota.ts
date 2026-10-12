// "YouTube quota is out until midnight Pacific": one KV flag, set when any
// YouTube write gets a daily-quota reply and read by the scheduler, so a day
// without quota does not keep spending 1001tracklists pool fetches on sets whose
// only next step is an insert that fails again.
//
//   - Set by `noteQuotaOut(env, e)` from every place that already tests
//     `isQuotaError` (sync inserts and rechecks, combined playlist, hygiene sweep,
//     mkvid recreate / gone check, track uploads).
//   - It expires by itself at the next midnight America/Los_Angeles (the KV
//     expiry, DST handled by the zone), and the owner can clear it early
//     (Scheduler page: they may have raised the quota).
//   - Only the daily reasons (quotaExceeded / dailyLimitExceeded) set it. A
//     per-minute rate limit (rateLimitExceeded / userRateLimitExceeded) sets
//     nothing: the run that got it stops its writes, and the next tick in a few
//     minutes simply tries again.
import type { Env } from '../types'
import { errorFields, type Logger } from './log'
import { quotaKind } from './youtube-error'
import { YouTubeApiError } from './youtube-playlists'
// The quota day's end is mkvid.ts's (not reimplemented here), so the hold expires exactly when the daily claims reset.
import { quotaDayEnd } from './mkvid'

export const QUOTA_OUT_KEY = 'yt:quota:out'

export type QuotaOut = { since: number; until: number }

/** The flag while it holds, else null. */
export async function getQuotaOut(env: Env, nowMs = Date.now()): Promise<QuotaOut | null> {
  try {
    const v = await env.CACHE.get<QuotaOut>(QUOTA_OUT_KEY, 'json')
    return v && typeof v.until === 'number' && v.until * 1000 > nowMs ? v : null
  } catch {
    return null
  }
}

/** Marks quota as used up until the next midnight Pacific when `e` is a daily-quota reply; any other error is ignored. Never throws. */
export async function noteQuotaOut(env: Env, e: unknown, log?: Logger, nowMs = Date.now()): Promise<void> {
  try {
    if (!(e instanceof YouTubeApiError) || e.status !== 403 || quotaKind(e.reason) !== 'quota') return
    if (await getQuotaOut(env, nowMs)) return
    const until = quotaDayEnd(nowMs)
    const since = Math.floor(nowMs / 1000)
    await env.CACHE.put(QUOTA_OUT_KEY, JSON.stringify({ since, until } satisfies QuotaOut), { expirationTtl: Math.max(60, until - since) })
    log?.warn('youtube.quota_out', { until: new Date(until * 1000).toISOString() })
  } catch (err) {
    log?.warn('youtube.quota_out_note_failed', errorFields(err))
  }
}

/** The owner's early clear (they may have raised the quota). */
export async function clearQuotaOut(env: Env): Promise<void> {
  await env.CACHE.delete(QUOTA_OUT_KEY)
}
