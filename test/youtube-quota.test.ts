import { describe, it, expect } from 'vitest'
import { app } from '../src/index'
import type { Env } from '../src/types'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'
import { clearQuotaOut, getQuotaOut, noteQuotaOut, QUOTA_OUT_KEY } from '../src/lib/youtube-quota'
import { quotaDayEnd } from '../src/lib/mkvid'
import { YouTubeApiError } from '../src/lib/youtube-playlists'

function makeEnv(): Env {
  return { CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k', DEV_BYPASS_CF_ACCESS: '1' } as Env
}
const at = (iso: string) => Date.parse(iso)

describe('the quota day', () => {
  it('ends at the next midnight Pacific, also across the DST changes', () => {
    // Summer time (UTC-7), then the day clocks go forward (23 h long), then back (25 h long).
    expect(quotaDayEnd(at('2026-07-01T12:00:00Z'))).toBe(at('2026-07-02T07:00:00Z') / 1000)
    expect(quotaDayEnd(at('2026-03-08T12:00:00Z'))).toBe(at('2026-03-09T07:00:00Z') / 1000)
    expect(quotaDayEnd(at('2026-11-01T12:00:00Z'))).toBe(at('2026-11-02T08:00:00Z') / 1000)
    expect(quotaDayEnd(at('2026-01-15T07:59:59Z'))).toBe(at('2026-01-15T08:00:00Z') / 1000)
  })
})

describe('the "YouTube quota is out" flag', () => {
  const body = '{}'
  it('is set by a daily-quota reply until the next midnight Pacific, and ignored once that has passed', async () => {
    const env = makeEnv()
    const now = at('2026-10-11T23:55:00Z')
    await noteQuotaOut(env, new YouTubeApiError('playlistItems.insert', 403, 'quotaExceeded', body), undefined, now)
    expect(await getQuotaOut(env, now)).toEqual({ since: now / 1000, until: at('2026-10-12T07:00:00Z') / 1000 })
    expect(await getQuotaOut(env, at('2026-10-12T07:00:01Z'))).toBeNull()
    await clearQuotaOut(env)
    expect(await env.CACHE.get(QUOTA_OUT_KEY)).toBeNull()
  })

  it('is not set by a per-minute rate limit, a 429, another 403 or a plain error', async () => {
    const env = makeEnv()
    for (const e of [
      new YouTubeApiError('playlistItems.insert', 403, 'userRateLimitExceeded', body),
      new YouTubeApiError('playlistItems.insert', 403, 'rateLimitExceeded', body),
      new YouTubeApiError('playlistItems.insert', 429, 'quotaExceeded', body),
      new YouTubeApiError('playlistItems.insert', 403, 'forbidden', body),
      new Error('boom'),
    ]) await noteQuotaOut(env, e)
    expect(await getQuotaOut(env)).toBeNull()
  })

  it('shows on the scheduler endpoint and the owner clears it early', async () => {
    const env = makeEnv()
    await noteQuotaOut(env, new YouTubeApiError('playlistItems.insert', 403, 'dailyLimitExceeded', body))
    const r = await app.request('http://x/ui/api/scheduler', {}, env)
    expect(((await r.json()) as { quotaOut: { until: number } | null }).quotaOut!.until).toBeGreaterThan(Date.now() / 1000)
    const c = await app.request('http://x/ui/api/scheduler/quota-clear', { method: 'POST', headers: { origin: 'http://x', 'content-type': 'application/json' }, body: '{}' }, env)
    expect(c.status).toBe(200)
    expect(await getQuotaOut(env)).toBeNull()
    expect(((await (await app.request('http://x/ui/api/scheduler', {}, env)).json()) as { quotaOut: unknown }).quotaOut).toBeNull()
  })
})
