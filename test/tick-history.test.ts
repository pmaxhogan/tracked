import { describe, it, expect } from 'vitest'
import { app } from '../src/index'
import type { Env } from '../src/types'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'
import { listSchedulerTicks, pruneSchedulerTicks, recordSchedulerTick, TICK_HISTORY_DAYS } from '../src/lib/tick-history'

function makeEnv(): Env {
  return { CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k' } as Env
}
const NOW = 1_790_000_000

describe('scheduler tick history', () => {
  it('records a tick with its due counts, items and stop reason; lists newest first and pages back', async () => {
    const env = makeEnv()
    await recordSchedulerTick(env, NOW - 120, 10, { skipped: 'nothing_due', drawn: 3, items: [], due: { new: 0, verify: 0, recheck: 0, backfill: 0 } })
    await recordSchedulerTick(env, NOW - 60, 1234.4, {
      drawn: 2,
      due: { new: 1, verify: 0, recheck: 5, backfill: 23 },
      items: [
        { item: { cls: 'recheck', kind: 'recheck', slug: 'a', url: 'https://www.1001tracklists.com/tracklist/x1/a.html' }, outcome: 'ok' },
        { item: { cls: 'backfill', kind: 'dj_backfill', slug: 'a' }, outcome: 'stopped', stopReason: 'pool budget' },
      ],
      stoppedBy: 'pool budget',
    })
    await recordSchedulerTick(env, NOW, 5, null, 'Error: boom')
    const ticks = await listSchedulerTicks(env)
    expect(ticks.map((t) => t.at)).toEqual([NOW, NOW - 60, NOW - 120])
    expect(ticks[0]).toMatchObject({ error: 'Error: boom', drawn: 0, ran: 0, items: [], due: null })
    expect(ticks[1]).toMatchObject({
      ms: 1234, drawn: 2, ran: 2, stoppedBy: 'pool budget', skipped: null,
      due: { new: 1, verify: 0, recheck: 5, backfill: 23 },
      items: [
        { kind: 'recheck', cls: 'recheck', slug: 'a', url: 'https://www.1001tracklists.com/tracklist/x1/a.html', outcome: 'ok' },
        { kind: 'dj_backfill', cls: 'backfill', slug: 'a', outcome: 'stopped', stopReason: 'pool budget' },
      ],
    })
    expect(ticks[1]!.items[1]).not.toHaveProperty('url')
    expect(ticks[2]).toMatchObject({ skipped: 'nothing_due', drawn: 3 })
    expect((await listSchedulerTicks(env, { limit: 1, before: ticks[0]!.id })).map((t) => t.at)).toEqual([NOW - 60])
  })

  it('never throws (no table yet) and prunes rows older than the horizon', async () => {
    const env = makeEnv()
    await env.DB.prepare('DROP TABLE scheduler_ticks').run()
    await expect(recordSchedulerTick(env, NOW, 1, null, 'x')).resolves.toBeUndefined()
    const env2 = makeEnv()
    await recordSchedulerTick(env2, NOW - TICK_HISTORY_DAYS * 86400 - 1, 1, null)
    await recordSchedulerTick(env2, NOW - 10, 1, null)
    expect(await pruneSchedulerTicks(env2, NOW)).toBe(1)
    expect((await listSchedulerTicks(env2)).map((t) => t.at)).toEqual([NOW - 10])
  })

  it('GET /ops/scheduler/ticks is bearer-gated', async () => {
    const env = makeEnv()
    await recordSchedulerTick(env, NOW, 1, { drawn: 1, items: [], skipped: 'nothing_due' })
    expect((await app.request('http://x/ops/scheduler/ticks', {}, env)).status).toBe(401)
    const r = await app.request('http://x/ops/scheduler/ticks?limit=5', { headers: { Authorization: 'Bearer t' } }, env)
    expect(r.status).toBe(200)
    expect(((await r.json()) as { ticks: unknown[] }).ticks).toHaveLength(1)
  })
})
