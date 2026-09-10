import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fakeKV } from './helpers/fake-kv'
import type { Env } from '../src/types'
import type { HomeProxyResult } from '../src/lib/homeProxy'
import {
  _resetTallyForTests,
  brightdataUsage,
  closeEpisode,
  flushBanTally,
  getBanStatus,
  getHomeBan,
  getPause,
  isPaused,
  maintainBanState,
  manualClear,
  noteProxyResult,
  openEpisode,
  recordProbe,
  setPause,
  simulateBan,
  tryConsumeBrightdata,
} from '../src/lib/ban-state'

function makeEnv(overrides: Partial<Env> = {}): Env {
  return { CACHE: fakeKV(), SUBS: fakeKV(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k', ...overrides } as Env
}

const okDirect: HomeProxyResult = {
  status: 200,
  html: '<html/>',
  errorMessage: null,
  kind: 'ok',
  route: 'direct',
  egress: 'direct',
  upstreamStatus: 200,
  attempts: 'direct:ok',
  directBlocked: null,
  directRecovered: false,
  upstreamTransport: false,
  account: null,
  accountsHealthy: null,
  accountsTotal: null,
  sessionReissued: false,
  blockScope: null,
  poolHealthy: 19,
  poolTotal: 19,
}
const okViaPool: HomeProxyResult = {
  ...okDirect,
  route: 'pool',
  egress: 'bgp1:18183',
  attempts: 'direct:ip_blocked,bgp1:18183:ok',
  directBlocked: { until: '2026-09-10T16:00:00.000Z', since: '2026-09-10T15:00:00.000Z', ip: '68.1.2.3' },
  poolHealthy: 18,
}
const allBlocked: HomeProxyResult = {
  ...okViaPool,
  status: 503,
  kind: 'all_blocked',
  route: 'none',
  egress: null,
  attempts: 'direct:ip_blocked,bgp1:18180:ip_blocked,vm1:18180:ip_blocked',
  poolHealthy: 0,
  errorMessage: 'home proxy: every route blocked',
}

beforeEach(() => {
  _resetTallyForTests()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-10T15:10:00.000Z'))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('noteProxyResult', () => {
  it('does nothing on a plain direct success', async () => {
    const env = makeEnv()
    await noteProxyResult(env, okDirect)
    expect(await getHomeBan(env)).toBeNull()
    expect((await getBanStatus(env)).episodes).toEqual([])
  })

  it('opens an episode when the forwarder reports the residential IP in cooldown', async () => {
    const env = makeEnv()
    await noteProxyResult(env, okViaPool)
    const home = await getHomeBan(env)
    expect(home).toMatchObject({ ip: '68.1.2.3', until: '2026-09-10T16:00:00.000Z', source: 'proxy', poolHealthy: 18, poolTotal: 19, simulated: false })
    const st = await getBanStatus(env)
    expect(st.episodes).toHaveLength(1)
    expect(st.episodes[0]).toMatchObject({ ip: '68.1.2.3', endedAt: null, source: 'proxy' })
    // Push not configured in this env → recorded as 0/0, never throws.
    expect(st.episodes[0]!.pushStart).toEqual({ sent: 0, total: 0 })
    expect(st.pause).toBeNull()
  })

  it('refreshes the cooldown end and counts pool requests while blocked', async () => {
    const env = makeEnv()
    await noteProxyResult(env, okViaPool)
    await noteProxyResult(env, okViaPool)
    await noteProxyResult(env, { ...okViaPool, directBlocked: { ...okViaPool.directBlocked!, until: '2026-09-10T17:00:00.000Z' } })
    expect((await getHomeBan(env))!.until).toBe('2026-09-10T17:00:00.000Z')
    await flushBanTally(env, true)
    const [ep] = (await getBanStatus(env)).episodes
    expect(ep!.poolRequests).toBe(3)
    expect((await getBanStatus(env)).episodes).toHaveLength(1)
  })

  it('closes the episode when direct works again, stamping duration and clearedBy=auto', async () => {
    const env = makeEnv()
    await noteProxyResult(env, okViaPool)
    vi.setSystemTime(new Date('2026-09-10T16:40:00.000Z'))
    await noteProxyResult(env, { ...okDirect, directRecovered: true })
    expect(await getHomeBan(env)).toBeNull()
    const [ep] = (await getBanStatus(env)).episodes
    expect(ep).toMatchObject({ clearedBy: 'auto', endedAt: '2026-09-10T16:40:00.000Z', blockedForMs: 90 * 60 * 1000, pushClear: { sent: 0, total: 0 } })
  })

  it('sets the one-hour pause when every route is blocked, and clears it with the episode', async () => {
    const env = makeEnv()
    await noteProxyResult(env, allBlocked)
    const pause = await getPause(env)
    expect(pause).toMatchObject({ reason: 'all_routes_blocked', ip: '68.1.2.3', since: '2026-09-10T15:10:00.000Z', until: '2026-09-10T16:10:00.000Z' })
    expect(await isPaused(env)).not.toBeNull()
    // Second all-blocked report within the window does not extend the pause.
    vi.setSystemTime(new Date('2026-09-10T15:30:00.000Z'))
    await noteProxyResult(env, allBlocked)
    expect((await getPause(env))!.until).toBe('2026-09-10T16:10:00.000Z')
    await flushBanTally(env, true)
    expect((await getBanStatus(env)).episodes[0]!.allBlockedHits).toBe(2)
    // Pause expires on its own.
    vi.setSystemTime(new Date('2026-09-10T16:10:01.000Z'))
    expect(await getPause(env)).toBeNull()
  })

  it('never auto-closes a simulated episode on a direct success', async () => {
    const env = makeEnv()
    await simulateBan(env)
    await noteProxyResult(env, okDirect)
    expect((await getHomeBan(env))?.simulated).toBe(true)
    await manualClear(env)
    expect(await getHomeBan(env)).toBeNull()
    expect((await getBanStatus(env)).episodes[0]).toMatchObject({ simulated: true, clearedBy: 'manual' })
  })
})

describe('recordProbe', () => {
  it('closes an open episode on probe=ok (clearedBy manual/probe) and clears any pause', async () => {
    const env = makeEnv()
    await noteProxyResult(env, allBlocked)
    const r = await recordProbe(env, { probe: 'ok', status: 200, poolHealthy: 19, poolTotal: 19 }, 'manual')
    expect(r.cleared).toBe(true)
    expect(await getHomeBan(env)).toBeNull()
    expect(await getPause(env)).toBeNull()
    expect((await getBanStatus(env)).episodes[0]!.clearedBy).toBe('manual')
  })

  it('opens an episode on probe=ip_blocked when none is open, refreshes it otherwise', async () => {
    const env = makeEnv()
    const r1 = await recordProbe(env, { probe: 'ip_blocked', blockedIp: '68.1.2.3', direct: { blocked: true, blockedUntil: '2026-09-10T16:10:00.000Z', blockedSince: null, blockedIp: '68.1.2.3', lastBlockAt: null, lastOkAt: null }, poolHealthy: 19, poolTotal: 19 }, 'probe')
    expect(r1.cleared).toBe(false)
    expect(r1.home).toMatchObject({ ip: '68.1.2.3', source: 'probe', until: '2026-09-10T16:10:00.000Z' })
    const r2 = await recordProbe(env, { probe: 'ip_blocked', direct: { blocked: true, blockedUntil: '2026-09-10T17:10:00.000Z', blockedSince: null, blockedIp: null, lastBlockAt: null, lastOkAt: null } }, 'probe')
    expect(r2.home!.until).toBe('2026-09-10T17:10:00.000Z')
    expect((await getBanStatus(env)).episodes).toHaveLength(1)
  })
})

describe('maintainBanState (cron)', () => {
  it('probes the forwarder once the cooldown lapsed with no traffic, and clears on ok', async () => {
    const env = makeEnv({ HOME_PROXY_URL: 'https://proxy.example', HOME_PROXY_TOKEN: 't' })
    await noteProxyResult(env, okViaPool) // until 16:00
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ probe: 'ok', status: 200 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await maintainBanState(env)
    expect(fetchMock).not.toHaveBeenCalled() // still inside the cooldown
    vi.setSystemTime(new Date('2026-09-10T16:05:00.000Z'))
    await maintainBanState(env)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String((fetchMock.mock.calls as unknown as unknown[][])[0]![0])).toBe('https://proxy.example/probe')
    expect(await getHomeBan(env)).toBeNull()
  })

  it('probes at most once per cooldown when still blocked', async () => {
    const env = makeEnv({ HOME_PROXY_URL: 'https://proxy.example', HOME_PROXY_TOKEN: 't' })
    await openEpisode(env, { ip: null, source: 'proxy', until: null, viaPool: true })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ probe: 'ip_blocked', direct: { blocked: true, blockedUntil: null } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await maintainBanState(env)
    await maintainBanState(env)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.setSystemTime(new Date('2026-09-10T16:15:00.000Z'))
    await maintainBanState(env)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('BrightData budget', () => {
  it('counts per UTC day against the cap and refuses past it', async () => {
    const env = makeEnv({ BRIGHTDATA_DAILY_CAP: '2' })
    expect(await brightdataUsage(env)).toEqual({ date: '2026-09-10', used: 0, cap: 2, remaining: 2 })
    expect((await tryConsumeBrightdata(env)).ok).toBe(true)
    expect((await tryConsumeBrightdata(env)).ok).toBe(true)
    const third = await tryConsumeBrightdata(env)
    expect(third.ok).toBe(false)
    expect(third.usage).toEqual({ date: '2026-09-10', used: 2, cap: 2, remaining: 0 })
    vi.setSystemTime(new Date('2026-09-11T00:00:01.000Z'))
    expect((await tryConsumeBrightdata(env)).ok).toBe(true)
  })

  it('defaults to 333 and tolerates garbage in the env var', async () => {
    expect((await brightdataUsage(makeEnv())).cap).toBe(333)
    expect((await brightdataUsage(makeEnv({ BRIGHTDATA_DAILY_CAP: 'lots' }))).cap).toBe(333)
  })

  it('charges BrightData calls to the open episode', async () => {
    const env = makeEnv()
    await noteProxyResult(env, allBlocked)
    await tryConsumeBrightdata(env)
    await tryConsumeBrightdata(env)
    await flushBanTally(env, true)
    expect((await getBanStatus(env)).episodes[0]!.brightdataRequests).toBe(2)
  })
})

describe('pause helpers', () => {
  it('setPause is idempotent inside the window and closeEpisode lifts it', async () => {
    const env = makeEnv()
    const p1 = await setPause(env, 'all_routes_blocked', null)
    vi.setSystemTime(new Date('2026-09-10T15:20:00.000Z'))
    const p2 = await setPause(env, 'all_routes_blocked', null)
    expect(p2.until).toBe(p1.until)
    await openEpisode(env, { ip: null, source: 'proxy', until: null, viaPool: false })
    await closeEpisode(env, 'auto')
    expect(await getPause(env)).toBeNull()
  })
})
