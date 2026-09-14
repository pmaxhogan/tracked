import { describe, it, expect } from 'vitest'
import { app } from '../src/index'
import type { Env } from '../src/types'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'
import { writeNowPlayingAudit } from '../src/lib/now-playing-audit'
import { flushPlaylistAdditions, type PlaylistAdditionRecord } from '../src/lib/playlist-audit'
import { makeLogger } from '../src/lib/log'

function makeEnv(): Env {
  return {
    CACHE: fakeKV(),
    DB: fakeD1(),
    SUBS: fakeKV(),
    API_TOKEN: 't',
    YOUTUBE_API_KEY: 'k',
    DEV_BYPASS_CF_ACCESS: '1',
  } as Env
}

const get = (env: Env, path: string) => app.request(`http://x${path}`, { method: 'GET' }, env)

describe('admin audit routes (D1)', () => {
  it('/api/audit pages newest-first and /api/audit-detail resolves a key', async () => {
    const env = makeEnv()
    for (let i = 0; i < 3; i++) {
      const t = new Date(Date.parse('2026-09-01T00:00:00Z') + i * 1000).toISOString()
      await writeNowPlayingAudit(env, {
        reqId: `r${i}`,
        record: { t, reqId: `r${i}`, status: 'ok', input: { currentSeconds: i } },
        summary: { t, status: 'ok', title: `set ${i}`, cs: i, dur: null, via: null, skew: null, impossible: false, ms: 1 },
      })
    }
    const r1 = await get(env, '/subscriptions/api/audit?limit=2')
    expect(r1.status).toBe(200)
    const p1 = (await r1.json()) as { records: Array<{ key: string; title: string }>; cursor: string | null; listComplete: boolean }
    expect(p1.records.map((r) => r.title)).toEqual(['set 2', 'set 1'])
    expect(p1.listComplete).toBe(false)
    const r2 = await get(env, `/subscriptions/api/audit?limit=2&cursor=${encodeURIComponent(p1.cursor!)}`)
    const p2 = (await r2.json()) as typeof p1
    expect(p2.records.map((r) => r.title)).toEqual(['set 0'])
    expect(p2.cursor).toBeNull()
    expect(p2.listComplete).toBe(true)

    const d = await get(env, `/subscriptions/api/audit-detail?key=${p1.records[0]!.key}`)
    expect(d.status).toBe(200)
    expect(((await d.json()) as { record: { reqId: string } }).record.reqId).toBe('r2')
    expect((await get(env, '/subscriptions/api/audit-detail?key=np:old')).status).toBe(400)
    expect((await get(env, '/subscriptions/api/audit-detail?key=999')).status).toBe(404)
  })

  it('/api/playlist-additions + detail serve the sync trail', async () => {
    const env = makeEnv()
    const rec: PlaylistAdditionRecord = {
      t: '2026-09-01T00:00:00Z', status: 'added', slug: 'dj', artistName: 'DJ', setUrl: 'https://x/tracklist/1',
      videoId: 'vid00000001', videoUrl: null, playlistId: 'PL', playlistTitle: 'DJ (1001tklists)', combinedStatus: 'added',
      via: 'direct', trigger: 'test', message: null, failureCount: null, meta: { ms: 1 },
    }
    await flushPlaylistAdditions(env, [rec], makeLogger({ task: 'test' }))
    const r = await get(env, '/subscriptions/api/playlist-additions')
    const p = (await r.json()) as { records: Array<{ key: string; set: string; vid: string; cmb: string }>; cursor: null }
    expect(p.records).toHaveLength(1)
    expect(p.records[0]).toMatchObject({ set: 'https://x/tracklist/1', vid: 'vid00000001', cmb: 'added' })
    const d = await get(env, `/subscriptions/api/playlist-addition-detail?key=${p.records[0]!.key}`)
    expect(((await d.json()) as { record: PlaylistAdditionRecord }).record).toEqual(rec)
    expect((await get(env, '/subscriptions/api/playlist-addition-detail?key=pladd:x')).status).toBe(400)
  })

  it('/api/migration reports import progress', async () => {
    const env = makeEnv()
    const r = await get(env, '/subscriptions/api/migration')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ subs: null, states: null, audit: { np: null, pladd: null, imported: { np: 0, pladd: 0 } } })
  })
})
