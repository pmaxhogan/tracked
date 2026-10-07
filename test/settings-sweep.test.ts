// Settings sweep (2026-10-07): constants and env vars that became settings.
// Every default equals the old value; a saved value takes effect where used.
import { describe, it, expect } from 'vitest'
import { fakeD1 } from './helpers/fake-d1'
import { fakeKV } from './helpers/fake-kv'
import type { Env } from '../src/types'
import { APP_SETTINGS_KEY, DEFAULT_APP_SETTINGS, getAppSettings, updateAppSettings, type AppSettings } from '../src/lib/app-settings'
import { DEFAULT_POOL_SETTINGS, mergeSettings, updatePoolSettings, type PoolSettings } from '../src/lib/pool-settings'
import {
  attemptBackoffSeconds,
  claimRenderFeed,
  claimSetAttempt,
  ITEM_SCOPED_BACKOFF_SECONDS,
  MAX_SET_ATTEMPTS_PER_DAY,
  pickTickItems,
  RENDER_FEED_MAX_COOLDOWN_SECONDS,
  RENDER_FEED_MAX_FAILURES,
  RENDER_FEED_MAX_PER_TICK,
  RENDER_FEED_REFETCH_COOLDOWN_SECONDS,
} from '../src/lib/fetch-scheduler'
import { claimTtl, dailyClaimCap, DEFAULT_CLAIM_TTL_SECONDS, MKVID_MAX_ATTEMPTS } from '../src/lib/mkvid'
import { isMassRemoval, judgeVideo, rejectVerticalEnabled, sweepSettings } from '../src/lib/playlist-hygiene'
import { AUDIO_LONGER_TOLERANCE_SECONDS, decideFullRecording, SHORTER_THAN_CUE_TOLERANCE_SECONDS } from '../src/lib/full-recording'
import { normalizeSettings, PoolAdminError, validateSettingsPatch } from '../src/lib/pool-admin-client'
import { TLPOOL_FIELD_GROUPS, TLPOOL_NUMERIC_KEYS } from '../src/lib/tlpool-settings-fields'
import { effectiveAppSettings } from '../src/routes/app-settings'
import { saveSubState } from '../src/lib/sync-store'
import { SETTINGS_PAGE_HTML } from '../src/ui/pages/pool-settings'
import { SETTINGS_PAGE } from '../src/ui/pages/settings'
import { Hono } from 'hono'
import { app as mainApp } from '../src/index'
import { createPoolUiApp } from '../src/routes/pool-ui'

const H = 3600
const kvEnv = () => ({ SUBS: fakeKV() }) as unknown as Env
const app = (patch: unknown): AppSettings => mergeSettings(DEFAULT_APP_SETTINGS, patch)
const pool = (patch: unknown): PoolSettings => mergeSettings(DEFAULT_POOL_SETTINGS, patch)

describe('pool settings: scheduler constants', () => {
  it('defaults equal the old constants', () => {
    expect(MAX_SET_ATTEMPTS_PER_DAY).toBe(3)
    expect(ITEM_SCOPED_BACKOFF_SECONDS).toBe(10 * 60)
    expect(RENDER_FEED_MAX_PER_TICK).toBe(1)
    expect(RENDER_FEED_REFETCH_COOLDOWN_SECONDS).toBe(48 * H)
    expect(RENDER_FEED_MAX_COOLDOWN_SECONDS).toBe(14 * 24 * H)
    expect(RENDER_FEED_MAX_FAILURES).toBe(3)
    expect(DEFAULT_POOL_SETTINGS.retry).toEqual({
      maxSetAttemptsPerDay: 3, attemptBackoffBaseMinutes: 15, attemptBackoffMaxHours: 6, claimRecheckHours: 6,
      claimVerifyHours: 2, djRetryMinutes: 60, poolBackoffMaxHours: 6, itemScopedBackoffMinutes: 10,
    })
    expect(DEFAULT_POOL_SETTINGS.recheck.mkvidWaitingSpreadHours).toBe(48)
    expect([1, 2, 3, 10].map((n) => attemptBackoffSeconds(n))).toEqual([15 * 60, 30 * 60, 60 * 60, 6 * H])
  })

  it('attempt backoff follows retry settings', () => {
    const retry = { ...DEFAULT_POOL_SETTINGS.retry, attemptBackoffBaseMinutes: 5, attemptBackoffMaxHours: 1 }
    expect([1, 2, 3, 4, 9].map((n) => attemptBackoffSeconds(n, retry))).toEqual([300, 600, 1200, 2400, 3600])
  })

  it('a stored document missing the new groups still loads (defaults fill in) and bad values are refused', async () => {
    const env = kvEnv()
    await env.SUBS.put('pool:settings', JSON.stringify({ manualMaxFetches: 7 }))
    const ok = await updatePoolSettings(env, { retry: { djRetryMinutes: 30 } })
    expect(ok.ok && ok.settings.retry.djRetryMinutes).toBe(30)
    expect(ok.ok && ok.settings.manualMaxFetches).toBe(7)
    for (const bad of [{ retry: { maxSetAttemptsPerDay: 0 } }, { retry: { maxSetAttemptsPerDay: 2.5 } }, { renderFeed: { maxPerTick: 11 } }, { recheck: { mkvidWaitingSpreadHours: 0 } }]) {
      const r = await updatePoolSettings(env, bad)
      expect(r.ok).toBe(false)
    }
  })

  it('claimSetAttempt and the attempts-per-day cap read the settings passed in', async () => {
    const env = { CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV() } as unknown as Env
    const day0 = Math.floor(Date.now() / 1000 / 86400) * 86400 + 60
    const u = 'https://www.1001tracklists.com/tracklist/abc/a-set-2020-01-01.html'
    await env.DB.prepare('INSERT INTO subscriptions (slug, source_url, added_at, position) VALUES (?, ?, ?, ?)').bind('a', 'https://www.1001tracklists.com/dj/a/', 0, 0).run()
    await env.SUBS.put('subs:migrated', '{}')
    await saveSubState(env, 'a', { playlistId: 'PL', artistName: 'A', discoveredTracklistUrls: [u], processedTracklistUrls: [], tracklistVideos: {} })
    const custom = pool({ retry: { maxSetAttemptsPerDay: 1, attemptBackoffBaseMinutes: 1 } })
    expect(await claimSetAttempt(env, u, day0, custom)).toBe(1)
    const retryAt = (await env.DB.prepare('SELECT retry_at FROM set_schedule WHERE url = ?').bind(u).first<{ retry_at: number }>())!.retry_at
    expect(retryAt).toBe(day0 + 60)
    const urls = async (s: PoolSettings) => (await pickTickItems(env, s, 5, new Set(['a']), day0 + 30 * 60, 0)).map((i) => ('url' in i ? i.url : i.slug))
    expect(await urls(DEFAULT_POOL_SETTINGS)).toContain(u) // 1 of 3 attempts used
    expect(await urls(custom)).not.toContain(u) // 1 of 1
  })

  it('a render-feed claim cools the set down for renderFeed.cooldownHours', async () => {
    const env = { CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV() } as unknown as Env
    const now = Math.floor(Date.now() / 1000 / 86400) * 86400 + 12 * H
    const u = 'https://www.1001tracklists.com/tracklist/x/b-2020-01-01.html'
    expect(await claimRenderFeed(env, pool({ renderFeed: { cooldownHours: 5 } }), u, now)).toBeNull()
    const row = await env.DB.prepare('SELECT next_feed_at FROM render_feed WHERE url = ?').bind(u).first<{ next_feed_at: number }>()
    expect(row!.next_feed_at).toBe(now + 5 * H)
  })
})

describe('app settings', () => {
  it('defaults equal the old constants; env-backed fields default to null', () => {
    expect(MKVID_MAX_ATTEMPTS).toBe(3)
    expect(DEFAULT_APP_SETTINGS.mkvid).toEqual({ dailyClaimCap: null, sharedDailyClaimCap: null, claimTtlMinutes: null, maxAttempts: 3, retryBackoffHours: 6, unverifiedRetryMinutes: 60 })
    expect(DEFAULT_APP_SETTINGS.playlists.shortToleranceMinutes * 60).toBe(SHORTER_THAN_CUE_TOLERANCE_SECONDS)
    expect(DEFAULT_APP_SETTINGS.playlists.audioToleranceMinutes * 60).toBe(AUDIO_LONGER_TOLERANCE_SECONDS)
    expect(DEFAULT_APP_SETTINGS.playlists).toMatchObject({ massRemovalMax: 5, massRemovalRatio: 0.3, runRemovalMax: 15, combinedDailyInsertCap: 80, combinedMaxInsertsPerRun: 20 })
    expect(DEFAULT_APP_SETTINGS.retention).toEqual({ auditDays: 90, tickHistoryDays: 14 })
  })

  it('stores a partial update, validates it, and a null resets an env-backed field', async () => {
    const env = kvEnv()
    expect(await getAppSettings(env)).toEqual(DEFAULT_APP_SETTINGS)
    const r = await updateAppSettings(env, { mkvid: { dailyClaimCap: 0, retryBackoffHours: 2 } })
    expect(r.ok && r.settings.mkvid).toMatchObject({ dailyClaimCap: 0, retryBackoffHours: 2, maxAttempts: 3 })
    expect((await getAppSettings(env)).mkvid.dailyClaimCap).toBe(0) // memo refreshed by the update
    expect(JSON.parse((await env.SUBS.get(APP_SETTINGS_KEY))!).mkvid.dailyClaimCap).toBe(0)
    const back = await updateAppSettings(env, { mkvid: { dailyClaimCap: null } })
    expect(back.ok && back.settings.mkvid.dailyClaimCap).toBeNull()
    for (const bad of [{ mkvid: { maxAttempts: 0 } }, { mkvid: { dailyClaimCap: -1 } }, { playlists: { massRemovalRatio: 2 } }, { retention: { auditDays: 0 } }, { playlists: { sweepDryRun: 'yes' } }, [], null]) {
      expect((await updateAppSettings(env, bad)).ok).toBe(false)
    }
  })

  it('a stored document that no longer validates is ignored', async () => {
    const env = kvEnv()
    await env.SUBS.put(APP_SETTINGS_KEY, JSON.stringify({ mkvid: { maxAttempts: 'many' } }))
    expect(await getAppSettings(env)).toEqual(DEFAULT_APP_SETTINGS)
  })

  it('precedence: saved value > env var > code default (0 is a real value)', () => {
    const env = { MKVID_DAILY_CLAIM_CAP: '6', MKVID_SHARED_DAILY_CLAIM_CAP: '3', MKVID_CLAIM_TTL_SECONDS: '600' } as unknown as Env
    expect(dailyClaimCap(env, 'primary', DEFAULT_APP_SETTINGS)).toBe(6)
    expect(dailyClaimCap(env, 'shared', DEFAULT_APP_SETTINGS)).toBe(3)
    expect(dailyClaimCap({} as Env, 'primary', DEFAULT_APP_SETTINGS)).toBe(24)
    expect(dailyClaimCap(env, 'primary', app({ mkvid: { dailyClaimCap: 0 } }))).toBe(0)
    expect(dailyClaimCap(env, 'shared', app({ mkvid: { sharedDailyClaimCap: 9 } }))).toBe(9)
    expect(claimTtl(env, DEFAULT_APP_SETTINGS)).toBe(600)
    expect(claimTtl({} as Env, DEFAULT_APP_SETTINGS)).toBe(DEFAULT_CLAIM_TTL_SECONDS)
    expect(claimTtl(env, app({ mkvid: { claimTtlMinutes: 30 } }))).toBe(1800)
    expect(sweepSettings({}, DEFAULT_APP_SETTINGS)).toEqual({ dryRun: true, dailyRemovals: 40 })
    expect(sweepSettings({ PLAYLIST_SWEEP_DRY_RUN: 'false' }, app({ playlists: { sweepDailyRemovals: 7 } }))).toEqual({ dryRun: false, dailyRemovals: 7 })
    expect(sweepSettings({ PLAYLIST_SWEEP_DRY_RUN: 'false' }, app({ playlists: { sweepDryRun: true } })).dryRun).toBe(true)
    expect(rejectVerticalEnabled({ REJECT_VERTICAL: '1' }, DEFAULT_APP_SETTINGS)).toBe(true)
    expect(rejectVerticalEnabled({ REJECT_VERTICAL: '1' }, app({ playlists: { rejectVertical: false } }))).toBe(false)
    const eff = effectiveAppSettings(env, DEFAULT_APP_SETTINGS)
    expect(eff.mkvid).toEqual({ dailyClaimCap: 6, sharedDailyClaimCap: 3, claimTtlMinutes: 10 })
    expect(eff.playlists).toEqual({ sweepDryRun: true, sweepDailyRemovals: 40, rejectVertical: false })
  })

  it('full-recording tolerances and the mass-removal guard take the settings', () => {
    const base = { notice: false, lastCueSeconds: 3600, videoSeconds: 3600 - 6 * 60, audioMaxSeconds: null, embedWidth: null, embedHeight: null }
    expect(decideFullRecording(base).ok).toBe(false) // 6 min short > 5
    expect(decideFullRecording({ ...base, shortToleranceSeconds: 7 * 60 }).ok).toBe(true)
    const facts = { noFullNotice: false, lastCueSeconds: 3600, audioMaxSeconds: 3600 + 11 * 60 } as never
    const meta = { alive: true, durationSeconds: 3600, embedWidth: null, embedHeight: null } as never
    expect(judgeVideo(facts, meta).ok).toBe(false) // audio 11 min longer > 10
    expect(judgeVideo(facts, meta, { audioToleranceSeconds: 12 * 60 }).ok).toBe(true)
    expect(isMassRemoval(4, 100)).toBe(false)
    expect(isMassRemoval(4, 100, { max: 3, ratio: 0.3 })).toBe(true)
    expect(isMassRemoval(2, 4, { max: 5, ratio: 0.6 })).toBe(false)
  })
})

describe('tlpool numeric settings through tracked', () => {
  it('the field table matches its keys and every default sits inside its range', () => {
    expect(new Set(TLPOOL_NUMERIC_KEYS).size).toBe(TLPOOL_NUMERIC_KEYS.length)
    for (const g of TLPOOL_FIELD_GROUPS) for (const f of g.fields) expect(f.def >= f.min && f.def <= f.max).toBe(true)
  })

  it('GET picks the listed numbers into `tuning`; PUT passes listed numbers and refuses non-numbers', () => {
    const s = normalizeSettings({ budgetPerDay: 30, navTimeoutSeconds: 45, idleCloseSeconds: 0, retestUrl: 'x', unknownKnob: 4 })
    expect(s.tuning).toEqual({ navTimeoutSeconds: 45, idleCloseSeconds: 0 })
    expect(normalizeSettings({ budgetPerDay: 30 }).tuning).toBeUndefined()
    expect(validateSettingsPatch({ navTimeoutSeconds: 60, maxWallsPerFetch: 4 })).toEqual({ navTimeoutSeconds: 60, maxWallsPerFetch: 4 })
    expect(() => validateSettingsPatch({ navTimeoutSeconds: '60' })).toThrow(PoolAdminError)
    expect(() => validateSettingsPatch({ someOtherKey: 3 })).toThrow(PoolAdminError) // nothing_to_change: unlisted keys never reach tlpool
  })
})

describe('settings pages', () => {
  it.each([['/ui/pool/settings', SETTINGS_PAGE_HTML, 'retry.maxSetAttemptsPerDay', 'navTimeoutSeconds'], ['/ui/settings', SETTINGS_PAGE.html, 'mkvid.dailyClaimCap', 'retention.auditDays']])(
    '%s: the inline scripts parse and carry the new fields',
    (_, html, a, b) => {
      const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
      expect(scripts.length).toBeGreaterThan(0)
      for (const s of scripts) expect(() => new Function(s ?? "")).not.toThrow()
      expect(html).toContain(a)
      expect(html).toContain(b)
    },
  )
})

describe('routes', () => {
  const routeEnv = (extra: Record<string, unknown> = {}) =>
    ({ CACHE: fakeKV(), SUBS: fakeKV(), DB: fakeD1(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k', DEV_BYPASS_CF_ACCESS: '1', TLPOOL_URL: 'https://pool.example', TLPOOL_TOKEN: 'tok', ...extra }) as unknown as Env
  const call = (env: Env, method: string, path: string, body?: unknown, appl: { request: typeof mainApp.request } = mainApp) =>
    appl.request(`http://x${path}`, { method, headers: { Origin: 'http://x', 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, env)

  it('GET/PUT /ui/api/settings through the real app (CF Access gate, same-origin guard)', async () => {
    const env = routeEnv({ MKVID_DAILY_CLAIM_CAP: '6' })
    const got = (await (await call(env, 'GET', '/ui/api/settings')).json()) as { settings: AppSettings; defaults: AppSettings; effective: { mkvid: { dailyClaimCap: number } } }
    expect(got.settings).toEqual(DEFAULT_APP_SETTINGS)
    expect(got.defaults).toEqual(DEFAULT_APP_SETTINGS)
    expect(got.effective.mkvid.dailyClaimCap).toBe(6)
    const put = await call(env, 'PUT', '/ui/api/settings', { mkvid: { dailyClaimCap: 0 } })
    expect(put.status).toBe(200)
    expect(((await put.json()) as { effective: { mkvid: { dailyClaimCap: number } } }).effective.mkvid.dailyClaimCap).toBe(0)
    const bad = await call(env, 'PUT', '/ui/api/settings', { mkvid: { maxAttempts: 0 } })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { issues: string[] }).issues[0]).toMatch(/^mkvid\.maxAttempts:/)
    const gated = await call(routeEnv({ DEV_BYPASS_CF_ACCESS: undefined, CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CF_ACCESS_AUD: 'aud', CF_ACCESS_ALLOWED_EMAILS: 'a@example.com' }), 'GET', '/ui/api/settings')
    expect([401, 403]).toContain(gated.status)
  })

  it('PUT /ui/api/pool/limits passes a tlpool numeric knob through, and tlpool range errors come back with its message', async () => {
    const puts: unknown[] = []
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      if (init?.method === 'PUT') {
        puts.push(body)
        if (body.navTimeoutSeconds > 85) return new Response(JSON.stringify({ error: 'bad_request', message: 'navTimeoutSeconds must be between 10 and 85' }), { status: 400, headers: { 'content-type': 'application/json' } })
        return new Response(JSON.stringify({ budgetPerDay: 30, ...body }), { headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ budgetPerDay: 30, navTimeoutSeconds: 45 }), { headers: { 'content-type': 'application/json' } })
    }
    const root = new Hono<{ Bindings: Env }>()
    root.route('/ui', createPoolUiApp({ fetcher: fetcher as never }))
    const env = routeEnv()
    const ok = await call(env, 'PUT', '/ui/api/pool/limits', { navTimeoutSeconds: 60 }, root)
    expect(ok.status).toBe(200)
    expect(puts[0]).toEqual({ navTimeoutSeconds: 60 })
    expect(((await ok.json()) as { settings: { tuning: Record<string, number> } }).settings.tuning).toEqual({ navTimeoutSeconds: 60 })
    const bad = await call(env, 'PUT', '/ui/api/pool/limits', { navTimeoutSeconds: 120 }, root)
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ error: 'invalid', message: 'navTimeoutSeconds must be between 10 and 85' })
  })
})
