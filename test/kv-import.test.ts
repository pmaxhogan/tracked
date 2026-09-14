import { describe, it, expect, vi } from 'vitest'
import type { Env } from '../src/types'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'
import { importAllSubStates, importAuditPage, migrationStatus, runKvMigrationTick } from '../src/lib/kv-import'
import { loadSubState } from '../src/lib/sync-store'
import { listNowPlayingAudit } from '../src/lib/now-playing-audit'
import { listPlaylistAdditions } from '../src/lib/playlist-audit'
import { makeLogger } from '../src/lib/log'
import { invertedTs } from '../src/lib/cache'

function makeEnv(): Env {
  return { CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k' } as Env
}
const log = makeLogger({ task: 'test' })

async function seedLegacyAudit(env: Env, np: number, pladd: number) {
  const base = Date.parse('2026-08-01T00:00:00Z')
  for (let i = 0; i < np; i++) {
    const t = new Date(base + i * 60_000).toISOString()
    const record = { t, reqId: `r${i}`, status: i % 2 ? 'ok' : 'no_tracklist', input: { currentSeconds: i } }
    const summary = { t, status: record.status, title: `np ${i}`, cs: i, dur: null, via: null, skew: null, impossible: false, ms: 1 }
    await env.CACHE.put(`np:${invertedTs(base + i * 60_000)}:r${i}`, JSON.stringify(record), { metadata: summary })
  }
  for (let i = 0; i < pladd; i++) {
    const t = new Date(base + i * 60_000).toISOString()
    const record = {
      t, status: 'added', slug: 'dj', artistName: 'DJ', setUrl: `https://x/tracklist/${i}`, videoId: `v${i}`, videoUrl: null,
      playlistId: 'PL', playlistTitle: 'DJ', combinedStatus: null, via: 'direct', trigger: 'cron.daily', message: null, failureCount: null, meta: { ms: 1 },
    }
    const summary = { t, status: 'added', slug: 'dj', artist: 'DJ', set: record.setUrl, vid: `v${i}`, via: 'direct', trg: 'cron.daily', msg: null, ms: 1, cmb: null }
    await env.CACHE.put(`pladd:${invertedTs(base + i * 60_000)}:dj:9999`, JSON.stringify(record), { metadata: summary })
  }
}

describe('kv-import: audit trails', () => {
  it('imports both trails in bounded pages across ticks, then reports done', async () => {
    const env = makeEnv()
    await seedLegacyAudit(env, 5, 3)

    const t1 = await importAuditPage(env, log, 2)
    expect(t1).toEqual({ np: 2, pladd: 2, done: false })
    const t2 = await importAuditPage(env, log, 2)
    expect(t2).toEqual({ np: 2, pladd: 1, done: false })
    const t3 = await importAuditPage(env, log, 2)
    expect(t3.np).toBe(1)
    const t4 = await importAuditPage(env, log, 2)
    expect(t4).toEqual({ np: 0, pladd: 0, done: true })

    const np = await listNowPlayingAudit(env, { limit: 50 })
    expect(np.records.map((r) => r.title)).toEqual(['np 4', 'np 3', 'np 2', 'np 1', 'np 0'])
    const pl = await listPlaylistAdditions(env, { limit: 50 })
    expect(pl.records.map((r) => r.set)).toEqual(['https://x/tracklist/2', 'https://x/tracklist/1', 'https://x/tracklist/0'])
    const status = await migrationStatus(env)
    expect(status.audit).toMatchObject({ np: 'done', pladd: 'done', imported: { np: 5, pladd: 3 } })
  })

  it('is idempotent: re-importing a page never duplicates rows', async () => {
    const env = makeEnv()
    await seedLegacyAudit(env, 3, 0)
    await importAuditPage(env, log, 10)
    // Rewind the cursor as if the progress write had been lost.
    await env.SUBS.put('migrate:d1:audit', JSON.stringify({ np: null, pladd: 'done', imported: { np: 0, pladd: 0 } }))
    await importAuditPage(env, log, 10)
    expect((await listNowPlayingAudit(env, { limit: 50 })).records).toHaveLength(3)
  })

  it('synthesises a summary for pre-metadata np: records', async () => {
    const env = makeEnv()
    const record = { t: '2026-08-01T00:00:00Z', reqId: 'r', status: 'ok', videoTitle: 'Old flat title', currentSeconds: 12, tracklistVia: 'direct', meta: { totalMs: 9 } }
    await env.CACHE.put(`np:${invertedTs(Date.parse(record.t))}:r`, JSON.stringify(record))
    await importAuditPage(env, log, 10)
    const np = await listNowPlayingAudit(env, { limit: 10 })
    expect(np.records[0]).toMatchObject({ title: 'Old flat title', cs: 12, via: 'direct', ms: 9, status: 'ok' })
  })
})

describe('kv-import: sub states', () => {
  it('imports every subscribed DJ blob D1 lacks, once', async () => {
    const env = makeEnv()
    await env.SUBS.put('subs:list', JSON.stringify(['a', 'b', 'c']))
    await env.SUBS.put('subs:state:a', JSON.stringify({ processedTracklistUrls: ['u1'], discoveredTracklistUrls: ['u1', 'u2'] }))
    await env.SUBS.put('subs:state:b', JSON.stringify({ processedTracklistUrls: [] , artistName: 'B' }))
    // c has no blob (never synced)
    expect(await importAllSubStates(env, log)).toEqual({ imported: 2, skipped: 1 })
    expect((await loadSubState(env, 'a'))!.discoveredTracklistUrls).toEqual(['u1', 'u2'])
    expect((await loadSubState(env, 'b'))!.artistName).toBe('B')
    expect(await loadSubState(env, 'c')).toBeNull()
    expect(await importAllSubStates(env, log)).toBe('done')
  })

  it('a failed state import is not recorded as done, so the next tick retries', async () => {
    const env = makeEnv()
    await env.SUBS.put('subs:list', JSON.stringify(['a']))
    await env.SUBS.put('subs:state:a', JSON.stringify({ processedTracklistUrls: ['u1'] }))
    const spy = vi.spyOn(env.DB, 'batch').mockRejectedValueOnce(new Error('D1 blip'))
    await expect(importAllSubStates(env, log)).rejects.toThrow('D1 blip')
    expect(await env.SUBS.get('migrate:d1:states')).toBeNull()
    spy.mockRestore()
    expect(await importAllSubStates(env, log)).toEqual({ imported: 1, skipped: 0 })
  })

  it('runKvMigrationTick is a cheap no-op once everything is done', async () => {
    const env = makeEnv()
    const first = await runKvMigrationTick(env, log)
    expect(first).toEqual({ states: { imported: 0, skipped: 0 }, audit: { np: 0, pladd: 0, done: true } })
    const second = await runKvMigrationTick(env, log)
    expect(second).toEqual({ states: 'done', audit: { np: 0, pladd: 0, done: true } })
  })
})
