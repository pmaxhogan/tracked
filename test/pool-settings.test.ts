import { describe, it, expect } from 'vitest'
import { fakeKV } from './helpers/fake-kv'
import type { Env } from '../src/types'
import {
  DEFAULT_POOL_SETTINGS,
  firstFetchClass,
  getPoolSettings,
  jitter,
  mergeSettings,
  POOL_SETTINGS_KEY,
  recheckIntervalSeconds,
  setAgeDays,
  setDateFromUrl,
  updatePoolSettings,
} from '../src/lib/pool-settings'

const H = 3600
const D = 24 * H
const env = () => ({ SUBS: fakeKV() }) as unknown as Env

describe('decision 13: recheck pace by set age', () => {
  const s = DEFAULT_POOL_SETTINGS
  it.each([
    [0, 12 * H],
    [1.99, 12 * H],
    [2, 1 * D],
    [6.9, 1 * D],
    [7, 5 * D],
    [29.9, 5 * D],
    [30, 30 * D],
    [179.9, 30 * D],
  ])('a %s-day-old set is rechecked every %s s', (age, want) => {
    expect(recheckIntervalSeconds(s, age)).toBe(want)
  })

  it('over 180 days: never, unless the set has no good video or has ID rows (then 90 days)', () => {
    expect(recheckIntervalSeconds(s, 181)).toBeNull()
    expect(recheckIntervalSeconds(s, 400, { noGoodVideo: true })).toBe(90 * D)
    expect(recheckIntervalSeconds(s, 400, { hasIdRows: true })).toBe(90 * D)
    // The exception only applies past the last band.
    expect(recheckIntervalSeconds(s, 10, { hasIdRows: true })).toBe(5 * D)
  })

  it('a set without a date in its URL falls back to 5 days', () => {
    expect(recheckIntervalSeconds(s, null)).toBe(5 * D)
  })

  it('reads the date off a 1001tracklists set URL', () => {
    expect(setDateFromUrl('https://www.1001tracklists.com/tracklist/2kl/armin-van-buuren-asot-1248-2025-10-23.html')).toBe('2025-10-23')
    expect(setDateFromUrl('https://www.1001tracklists.com/tracklist/2f4x9k7t/max-styler-edc.html')).toBeNull()
    expect(setDateFromUrl('https://x/tracklist/a')).toBeNull()
    const now = Date.parse('2026-09-29T12:00:00Z') / 1000
    expect(setAgeDays('2026-09-27', now)).toBeCloseTo(2.5, 5)
    expect(setAgeDays('2026-10-05', now)).toBe(0)
    expect(setAgeDays(null, now)).toBeNull()
  })

  it('jitter stays within ±jitterFraction', () => {
    expect(jitter(1000 * H, 0.15, () => 0)).toBe(850 * H)
    expect(jitter(1000 * H, 0.15, () => 0.999999)).toBeLessThanOrEqual(1150 * H)
    expect(jitter(1000 * H, 0, () => 0.3)).toBe(1000 * H)
  })

  it('a never-fetched set up to 14 days old (or undated) is `new`, older is `backfill`', () => {
    expect(firstFetchClass(s, 3)).toBe('new')
    expect(firstFetchClass(s, 14)).toBe('new')
    expect(firstFetchClass(s, 15)).toBe('backfill')
    expect(firstFetchClass(s, null)).toBe('new')
  })
})

describe('stored settings', () => {
  it('defaults when nothing is stored; decision 12 order', async () => {
    const e = env()
    const s = await getPoolSettings(e)
    expect(s).toEqual(DEFAULT_POOL_SETTINGS)
    expect(s.priorities.order).toEqual(['new', 'verify', 'recheck', 'backfill'])
    expect(s.tick).toEqual({ minItems: 0, maxItems: 3 })
  })

  it('a partial update deep-merges over the current settings and is stored', async () => {
    const e = env()
    const r = await updatePoolSettings(e, { tick: { maxItems: 5 }, recheck: { beyondIntervalHours: 365 * 24 } })
    expect(r.ok).toBe(true)
    const s = await getPoolSettings(e)
    expect(s.tick).toEqual({ minItems: 0, maxItems: 5 })
    expect(s.recheck.beyondIntervalHours).toBe(365 * 24)
    expect(s.recheck.bands).toEqual(DEFAULT_POOL_SETTINGS.recheck.bands)
    // Bands are replaced whole and kept sorted.
    await updatePoolSettings(e, { recheck: { bands: [{ maxAgeDays: 30, intervalHours: 48 }, { maxAgeDays: 3, intervalHours: 6 }] } })
    expect((await getPoolSettings(e)).recheck.bands).toEqual([
      { maxAgeDays: 3, intervalHours: 6 },
      { maxAgeDays: 30, intervalHours: 48 },
    ])
  })

  it('rejects invalid updates with readable issues and stores nothing', async () => {
    const e = env()
    const bad = await updatePoolSettings(e, { tick: { minItems: 4, maxItems: 2 } })
    expect(bad.ok).toBe(false)
    expect((bad as { issues: string[] }).issues.join(' ')).toMatch(/maxItems/)
    expect((await updatePoolSettings(e, { priorities: { order: ['new', 'new', 'recheck', 'backfill'] } })).ok).toBe(false)
    expect((await updatePoolSettings(e, { verify: { minGapHours: 1 } })).ok).toBe(false) // decision 2: at least 2 h
    expect((await updatePoolSettings(e, 'nope')).ok).toBe(false)
    expect(await e.SUBS.get(POOL_SETTINGS_KEY)).toBeNull()
  })

  it('a stored document that no longer validates is ignored', async () => {
    const e = env()
    await e.SUBS.put(POOL_SETTINGS_KEY, JSON.stringify({ tick: { minItems: -1 } }))
    expect(await getPoolSettings(e)).toEqual(DEFAULT_POOL_SETTINGS)
  })

  it('mergeSettings replaces arrays and scalars, merges objects', () => {
    expect(mergeSettings({ a: { b: 1, c: [1, 2] }, d: 1 }, { a: { c: [3] } })).toEqual({ a: { b: 1, c: [3] }, d: 1 })
  })
})
