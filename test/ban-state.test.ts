import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fakeD1 } from './helpers/fake-d1'
import { fakeKV } from './helpers/fake-kv'
import type { Env } from '../src/types'
import {
  _resetTallyForTests,
  clearPause,
  closeEpisode,
  getBanStatus,
  getHomeBan,
  getPause,
  isPaused,
  manualClear,
  openEpisode,
  setPause,
  simulateBan,
} from '../src/lib/ban-state'

function makeEnv(overrides: Partial<Env> = {}): Env {
  return { CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k', ...overrides } as Env
}

beforeEach(() => {
  _resetTallyForTests()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-10T15:10:00.000Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('ban:pause — the master switch', () => {
  it('setPause is idempotent inside the window and closeEpisode lifts it', async () => {
    const env = makeEnv()
    const p1 = await setPause(env, 'manual', null)
    vi.setSystemTime(new Date('2026-09-10T15:20:00.000Z'))
    const p2 = await setPause(env, 'manual', null)
    expect(p2.until).toBe(p1.until)
    await openEpisode(env, { ip: null, source: 'proxy', until: null, viaPool: false })
    await closeEpisode(env, 'auto')
    expect(await getPause(env)).toBeNull()
  })

  it('honours a pause the orchestrator wrote by hand, until its `until` passes', async () => {
    const env = makeEnv()
    await env.CACHE.put('ban:pause', JSON.stringify({ since: '2026-09-10T00:00:00.000Z', until: '2026-10-01T00:00:00.000Z', reason: 'pool launch pending', ip: null }))
    expect((await isPaused(env))?.reason).toBe('pool launch pending')
    _resetTallyForTests()
    vi.setSystemTime(new Date('2026-10-01T00:00:01.000Z'))
    expect(await isPaused(env)).toBeNull()
    expect(await env.CACHE.get('ban:pause')).toBeNull()
  })

  it('clearPause lifts it at once', async () => {
    const env = makeEnv()
    await setPause(env, 'manual', null)
    expect(await clearPause(env)).toBe(true)
    expect(await isPaused(env)).toBeNull()
  })
})

describe('banner episodes and the admin status', () => {
  it('status carries the pause and episodes, and no forwarder / Bright Data fields any more', async () => {
    const env = makeEnv()
    await setPause(env, 'manual', null)
    const s = await getBanStatus(env)
    expect(Object.keys(s).sort()).toEqual(['episodes', 'home', 'now', 'pause', 'pushConfigured'])
    expect(s.pause?.reason).toBe('manual')
  })

  it('simulateBan opens a simulated episode that only manualClear ends', async () => {
    const env = makeEnv()
    const home = await simulateBan(env)
    expect(home.simulated).toBe(true)
    expect((await getBanStatus(env)).episodes).toHaveLength(1)
    const ep = await manualClear(env)
    expect(ep?.clearedBy).toBe('manual')
    expect(await getHomeBan(env)).toBeNull()
  })
})
