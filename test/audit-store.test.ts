import { describe, it, expect } from 'vitest'
import type { Env } from '../src/types'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'
import {
  getNowPlayingAudit,
  listNowPlayingAudit,
  NOW_PLAYING_AUDIT_RETENTION_MS,
  pruneNowPlayingAudit,
  writeNowPlayingAudit,
} from '../src/lib/now-playing-audit'
import {
  flushPlaylistAdditions,
  getPlaylistAddition,
  listPlaylistAdditions,
  prunePlaylistAdditions,
  type PlaylistAdditionRecord,
} from '../src/lib/playlist-audit'
import { makeLogger } from '../src/lib/log'

function makeEnv(): Env {
  return { CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k' } as Env
}

function npRecord(i: number, t: string) {
  return {
    reqId: `req${i}`,
    record: { t, reqId: `req${i}`, status: 'ok', input: { currentSeconds: i }, meta: { totalMs: 5 } },
    summary: { t, status: 'ok', title: `set ${i}`, cs: i, dur: null, via: null, skew: null, impossible: false, ms: 5 },
  }
}

function plRecord(i: number, t: string, status: PlaylistAdditionRecord['status'] = 'added'): PlaylistAdditionRecord {
  return {
    t,
    status,
    slug: 'dj',
    artistName: 'DJ',
    setUrl: `https://x/tracklist/${i}`,
    videoId: status === 'added' ? `vid${String(i).padStart(8, '0')}` : null,
    videoUrl: null,
    playlistId: 'PL',
    playlistTitle: 'DJ (1001tklists)',
    combinedStatus: null,
    via: 'direct',
    trigger: 'test',
    message: null,
    failureCount: null,
    meta: { ms: 1 },
  }
}

describe('now-playing audit (D1)', () => {
  it('writes rows and lists them newest-first with keyset paging', async () => {
    const env = makeEnv()
    const base = Date.parse('2026-09-01T00:00:00Z')
    for (let i = 0; i < 5; i++) await writeNowPlayingAudit(env, npRecord(i, new Date(base + i * 1000).toISOString()))

    const p1 = await listNowPlayingAudit(env, { limit: 2 })
    expect(p1.records.map((r) => r.title)).toEqual(['set 4', 'set 3'])
    expect(p1.cursor).not.toBeNull()
    const p2 = await listNowPlayingAudit(env, { limit: 2, cursor: p1.cursor })
    expect(p2.records.map((r) => r.title)).toEqual(['set 2', 'set 1'])
    const p3 = await listNowPlayingAudit(env, { limit: 2, cursor: p2.cursor })
    expect(p3.records.map((r) => r.title)).toEqual(['set 0'])
    expect(p3.cursor).toBeNull()

    const detail = await getNowPlayingAudit(env, p1.records[0]!.key)
    expect(detail).toMatchObject({ reqId: 'req4', input: { currentSeconds: 4 } })
    expect(await getNowPlayingAudit(env, 'np:legacy')).toBeNull()
    expect(await getNowPlayingAudit(env, '999')).toBeNull()
  })

  it('orders by timestamp, not insertion order (imported history carries old timestamps)', async () => {
    const env = makeEnv()
    await writeNowPlayingAudit(env, npRecord(1, '2026-09-10T00:00:00Z'))
    await writeNowPlayingAudit(env, npRecord(2, '2026-08-10T00:00:00Z'))
    const p = await listNowPlayingAudit(env, { limit: 10 })
    expect(p.records.map((r) => r.title)).toEqual(['set 1', 'set 2'])
  })

  it('prunes rows past the retention horizon', async () => {
    const env = makeEnv()
    const now = Date.now()
    await writeNowPlayingAudit(env, npRecord(1, new Date(now - NOW_PLAYING_AUDIT_RETENTION_MS - 1000).toISOString()))
    await writeNowPlayingAudit(env, npRecord(2, new Date(now).toISOString()))
    expect(await pruneNowPlayingAudit(env, now)).toBe(1)
    expect((await listNowPlayingAudit(env, { limit: 10 })).records.map((r) => r.title)).toEqual(['set 2'])
  })
})

describe('playlist-addition audit (D1)', () => {
  it('flushes a batch, lists newest-first with summaries, and serves the detail', async () => {
    const env = makeEnv()
    const log = makeLogger({ task: 'test' })
    const t = '2026-09-01T00:00:00Z'
    await flushPlaylistAdditions(env, [plRecord(1, t), plRecord(2, t, 'no_youtube'), plRecord(3, t, 'failed')], log)

    const page = await listPlaylistAdditions(env, { limit: 10 })
    // Same timestamp: later-inserted first (matches the old inverted batch index).
    expect(page.records.map((r) => [r.set, r.status])).toEqual([
      ['https://x/tracklist/3', 'failed'],
      ['https://x/tracklist/2', 'no_youtube'],
      ['https://x/tracklist/1', 'added'],
    ])
    expect(page.records[2]).toMatchObject({ vid: 'vid00000001', artist: 'DJ', trg: 'test', via: 'direct' })
    const detail = await getPlaylistAddition(env, page.records[2]!.key)
    expect(detail).toEqual(plRecord(1, t))
    expect(await getPlaylistAddition(env, 'pladd:x')).toBeNull()
  })

  it('flush is best-effort: a D1 failure is swallowed', async () => {
    const env = makeEnv()
    const log = makeLogger({ task: 'test' })
    ;(env as unknown as { DB: undefined }).DB = undefined
    await expect(flushPlaylistAdditions(env, [plRecord(1, '2026-09-01T00:00:00Z')], log)).resolves.toBeUndefined()
  })

  it('prunes rows past the retention horizon', async () => {
    const env = makeEnv()
    const log = makeLogger({ task: 'test' })
    const now = Date.now()
    await flushPlaylistAdditions(env, [plRecord(1, new Date(now - 91 * 86400 * 1000).toISOString()), plRecord(2, new Date(now).toISOString())], log)
    expect(await prunePlaylistAdditions(env, now)).toBe(1)
    expect((await listPlaylistAdditions(env, { limit: 10 })).records.map((r) => r.set)).toEqual(['https://x/tracklist/2'])
  })
})
