import { describe, it, expect, vi } from 'vitest'
import type { Env } from '../src/types'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'
import {
  invalidateSubTracklists,
  loadSubState,
  requeueTracklists,
  rowsToState,
  saveSubState,
  setTracklistVideo,
  slugsReferencingVideo,
  findTracklistUrlByVideoId,
  stateToFields,
  subWorkCounts,
  type SubState,
} from '../src/lib/sync-store'
import { makeLogger } from '../src/lib/log'

function makeEnv(): Env {
  return { CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k' } as Env
}

const NOW = Math.floor(Date.now() / 1000)
const log = makeLogger({ task: 'test' })

const full: SubState = {
  playlistId: 'PL1',
  artistName: 'Lilly Palmer',
  discoveredTracklistUrls: ['https://x/tracklist/a', 'https://x/tracklist/b', 'https://x/tracklist/c', 'https://x/tracklist/d'],
  processedTracklistUrls: ['https://x/tracklist/a', 'https://x/tracklist/b', 'https://x/tracklist/c'],
  abandonedTracklistUrls: ['https://x/tracklist/c'],
  failureCounts: { 'https://x/tracklist/d': 2 },
  tracklistVideos: {
    'https://x/tracklist/a': { videoId: 'vidA1234567', checkedAt: NOW - 10 },
    'https://x/tracklist/b': { videoId: null, checkedAt: NOW - 20 },
    // Deferred after repeated recheck failures: checked, baseline unknown.
    'https://x/tracklist/c': { checkedAt: NOW - 30 },
  },
  lastRunAt: NOW,
  lastError: 'paused: x',
  lastRunStats: { tracklistsSeen: 4, tracklistsProcessed: 1, videoIdsFound: 1, videoIdsAdded: 1, via: 'home-proxy' },
}

async function rows(env: Env, slug: string) {
  return (await env.DB.prepare('SELECT * FROM tracklists WHERE slug = ? ORDER BY position').bind(slug).all()).results
}

describe('sync-store: load / save', () => {
  it('returns null for a DJ nothing has been recorded for (and no KV blob)', async () => {
    expect(await loadSubState(makeEnv(), 'nobody')).toBeNull()
  })

  it('round-trips a full state through D1 rows', async () => {
    const env = makeEnv()
    await saveSubState(env, 's', full)
    const back = await loadSubState(env, 's')
    expect(back).toEqual({
      ...full,
      // Row order follows discovery order, so these come back exactly as saved.
    })
    expect((await rows(env, 's')).map((r) => r.position)).toEqual([0, 1, 2, 3])
  })

  it('keeps the legacy "no baselines yet" signal: no records + processed sets → tracklistVideos absent', async () => {
    const env = makeEnv()
    await saveSubState(env, 's', {
      discoveredTracklistUrls: ['https://x/tracklist/a'],
      processedTracklistUrls: ['https://x/tracklist/a'],
    })
    const back = (await loadSubState(env, 's'))!
    expect(back.tracklistVideos).toBeUndefined()
    // …but an unprocessed-only DJ gets an empty map (nothing to seed).
    await saveSubState(env, 't', { discoveredTracklistUrls: ['https://x/tracklist/z'], processedTracklistUrls: [] })
    expect((await loadSubState(env, 't'))!.tracklistVideos).toEqual({})
  })

  it('diff-based save writes only the rows that changed', async () => {
    const env = makeEnv()
    await saveSubState(env, 's', full)
    const since = structuredClone(full)
    const next: SubState = structuredClone(full)
    next.tracklistVideos!['https://x/tracklist/a'] = { videoId: 'newVid12345', checkedAt: NOW }
    next.discoveredTracklistUrls!.push('https://x/tracklist/e')

    const upserts: string[] = []
    const realPrepare = env.DB.prepare.bind(env.DB)
    vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => {
      const stmt = realPrepare(sql)
      if (sql.includes('INSERT INTO tracklists')) {
        const realBind = stmt.bind.bind(stmt)
        stmt.bind = (...values: unknown[]) => {
          upserts.push(String(values[1]))
          return realBind(...values)
        }
      }
      return stmt
    })
    await saveSubState(env, 's', next, { since })

    expect(upserts.sort()).toEqual(['https://x/tracklist/a', 'https://x/tracklist/e'])
    const back = (await loadSubState(env, 's'))!
    expect(back.tracklistVideos!['https://x/tracklist/a']).toEqual({ videoId: 'newVid12345', checkedAt: NOW })
    expect(back.discoveredTracklistUrls).toEqual([...full.discoveredTracklistUrls!, 'https://x/tracklist/e'])
    // The new URL got the next position, existing ones kept theirs.
    expect((await rows(env, 's')).map((r) => r.position)).toEqual([0, 1, 2, 3, 4])
  })

  it('an mkvid upload is marked as such and survives a round trip; a page video stays implicit', async () => {
    const env = makeEnv()
    await saveSubState(env, 's', {
      processedTracklistUrls: ['https://x/tracklist/a', 'https://x/tracklist/b'],
      tracklistVideos: {
        'https://x/tracklist/a': { videoId: 'mkvidVid123', checkedAt: NOW, source: 'mkvid' },
        'https://x/tracklist/b': { videoId: 'pageVid1234', checkedAt: NOW },
      },
    })
    const back = (await loadSubState(env, 's'))!
    expect(back.tracklistVideos).toEqual({
      'https://x/tracklist/a': { videoId: 'mkvidVid123', checkedAt: NOW, source: 'mkvid' },
      'https://x/tracklist/b': { videoId: 'pageVid1234', checkedAt: NOW },
    })
    const stored = await rows(env, 's')
    expect(stored.map((r) => r.video_source)).toEqual(['mkvid', '1001tl'])
  })

  it('stateToFields treats a null videoId as a known baseline and a missing one as unknown', () => {
    const f = stateToFields(full)
    expect(f.get('https://x/tracklist/a')).toMatchObject({ video_known: 1, video_id: 'vidA1234567', video_source: '1001tl' })
    expect(f.get('https://x/tracklist/b')).toMatchObject({ video_known: 1, video_id: null, video_source: null })
    expect(f.get('https://x/tracklist/c')).toMatchObject({ video_known: 0, video_id: null, checked_at: NOW - 30, abandoned: 1 })
    expect(f.get('https://x/tracklist/d')).toMatchObject({ processed: 0, failure_count: 2, checked_at: null })
  })

  it('rowsToState orders by position regardless of row order', () => {
    const s = rowsToState(null, [
      { slug: 's', url: 'u2', position: 1, discovered_at: 0, processed: 1, abandoned: 0, failure_count: 0, video_known: 1, video_id: 'v', video_source: '1001tl', checked_at: 5 },
      { slug: 's', url: 'u1', position: 0, discovered_at: 0, processed: 0, abandoned: 0, failure_count: 0, video_known: 0, video_id: null, video_source: null, checked_at: null },
    ])
    expect(s.discoveredTracklistUrls).toEqual(['u1', 'u2'])
    expect(s.processedTracklistUrls).toEqual(['u2'])
    expect(s.tracklistVideos).toEqual({ u2: { videoId: 'v', checkedAt: 5 } })
  })
})

describe('sync-store: legacy KV import', () => {
  it('imports the subs:state blob on first load and reads D1 from then on', async () => {
    const env = makeEnv()
    await env.SUBS.put('subs:state:s', JSON.stringify(full))
    const back = await loadSubState(env, 's', log)
    expect(back).toEqual(full)
    expect((await rows(env, 's')).length).toBe(4)
    // Later KV changes are ignored: D1 is the truth now.
    await env.SUBS.put('subs:state:s', JSON.stringify({ processedTracklistUrls: [] }))
    expect(await loadSubState(env, 's')).toEqual(full)
  })

  it('throws instead of returning an empty state when the import fails (never re-fetch a whole back catalogue)', async () => {
    const env = makeEnv()
    await env.SUBS.put('subs:state:s', JSON.stringify(full))
    vi.spyOn(env.DB, 'batch').mockRejectedValue(new Error('D1 unavailable'))
    await expect(loadSubState(env, 's', log)).rejects.toThrow('D1 unavailable')
    // A garbage blob is refused too.
    const env2 = makeEnv()
    await env2.SUBS.put('subs:state:s', JSON.stringify({ hello: 'world' }))
    await expect(loadSubState(env2, 's', log)).rejects.toThrow(/refusing to import/)
  })

  it('throws when KV itself is unreadable during the import', async () => {
    const env = makeEnv()
    vi.spyOn(env.SUBS, 'get').mockRejectedValue(new Error('KV down'))
    await expect(loadSubState(env, 's', log)).rejects.toThrow('KV down')
  })
})

describe('sync-store: queries', () => {
  it('subWorkCounts counts pending and due-for-recheck sets per DJ', async () => {
    const env = makeEnv()
    const interval = 5 * 86400
    await saveSubState(env, 'a', {
      discoveredTracklistUrls: ['p1', 'p2', 'done-fresh', 'done-stale', 'done-never', 'gone'],
      processedTracklistUrls: ['done-fresh', 'done-stale', 'done-never', 'gone'],
      abandonedTracklistUrls: ['gone'],
      tracklistVideos: {
        'done-fresh': { videoId: 'v', checkedAt: NOW },
        'done-stale': { videoId: 'v', checkedAt: NOW - interval - 1 },
      },
    })
    await saveSubState(env, 'b', { discoveredTracklistUrls: ['x'], processedTracklistUrls: ['x'], tracklistVideos: { x: { videoId: null, checkedAt: NOW } } })
    const counts = await subWorkCounts(env, interval, NOW)
    expect(counts).toEqual([
      { slug: 'a', pending: 2, due: 2 },
      { slug: 'b', pending: 0, due: 0 },
    ])
  })

  it('invalidateSubTracklists marks processed sets due (keeping the video), un-abandons and resets failures', async () => {
    const env = makeEnv()
    await saveSubState(env, 's', full)
    const r = await invalidateSubTracklists(env, 's')
    expect(r).toEqual({ tracklistsMarked: 3, abandonedCleared: 1 })
    const back = (await loadSubState(env, 's'))!
    expect(back.abandonedTracklistUrls).toEqual([])
    expect(back.failureCounts).toEqual({})
    expect(back.tracklistVideos).toEqual({
      'https://x/tracklist/a': { videoId: 'vidA1234567', checkedAt: 0 },
      'https://x/tracklist/b': { videoId: null, checkedAt: 0 },
      'https://x/tracklist/c': { checkedAt: 0 },
    })
  })

  it('slugsReferencingVideo finds other DJs whose sets resolve to the video', async () => {
    const env = makeEnv()
    await saveSubState(env, 'a', { processedTracklistUrls: ['u'], tracklistVideos: { u: { videoId: 'shared12345', checkedAt: NOW } } })
    await saveSubState(env, 'b', { processedTracklistUrls: ['w'], tracklistVideos: { w: { videoId: 'shared12345', checkedAt: NOW } } })
    await saveSubState(env, 'c', { processedTracklistUrls: ['z'], tracklistVideos: { z: { videoId: 'other123456', checkedAt: NOW } } })
    expect(await slugsReferencingVideo(env, 'shared12345', 'a')).toEqual(['b'])
    expect(await slugsReferencingVideo(env, 'shared12345', 'b')).toEqual(['a'])
    expect(await slugsReferencingVideo(env, 'other123456', 'c')).toEqual([])
  })

  it('requeueTracklists only touches sets that were abandoned or had failures', async () => {
    const env = makeEnv()
    await saveSubState(env, 's', full)
    const hit = await requeueTracklists(env, 's', ['https://x/tracklist/a', 'https://x/tracklist/c', 'https://x/tracklist/d', 'https://x/tracklist/nope'])
    expect(hit).toEqual(['https://x/tracklist/c', 'https://x/tracklist/d'])
    const back = (await loadSubState(env, 's'))!
    expect(back.abandonedTracklistUrls).toEqual([])
    expect(back.failureCounts).toEqual({})
  })

  it('setTracklistVideo records an mkvid upload on the row', async () => {
    const env = makeEnv()
    await saveSubState(env, 's', { processedTracklistUrls: ['u'], tracklistVideos: { u: { videoId: null, checkedAt: NOW - 100 } } })
    await setTracklistVideo(env, 's', 'u', { videoId: 'upload12345', source: 'mkvid', checkedAt: NOW })
    expect((await loadSubState(env, 's'))!.tracklistVideos).toEqual({ u: { videoId: 'upload12345', checkedAt: NOW, source: 'mkvid' } })
  })
})

describe('findTracklistUrlByVideoId — /now-playing answering from sets the sync already resolved', () => {
  it('returns the set URL for a known video (mkvid upload or 1001tl-embedded) and null otherwise', async () => {
    const env = makeEnv()
    await saveSubState(env, 'maup', {
      ...full,
      discoveredTracklistUrls: ['https://x/tracklist/panorama', 'https://x/tracklist/none'],
      processedTracklistUrls: ['https://x/tracklist/panorama', 'https://x/tracklist/none'],
      abandonedTracklistUrls: [],
      failureCounts: {},
      tracklistVideos: {
        'https://x/tracklist/panorama': { videoId: '7-HvbsxBq-4', checkedAt: NOW, source: 'mkvid' },
        'https://x/tracklist/none': { videoId: null, checkedAt: NOW },
      },
    })
    expect(await findTracklistUrlByVideoId(env, '7-HvbsxBq-4')).toBe('https://x/tracklist/panorama')
    expect(await findTracklistUrlByVideoId(env, 'vidA1234567')).toBeNull()
  })

  it('a b2b set referenced by two DJs resolves to the same page either way', async () => {
    const env = makeEnv()
    const state = (url: string): SubState => ({
      ...full,
      discoveredTracklistUrls: [url],
      processedTracklistUrls: [url],
      abandonedTracklistUrls: [],
      failureCounts: {},
      tracklistVideos: { [url]: { videoId: 'wKOj6yQ6TAQ', checkedAt: NOW } },
    })
    await saveSubState(env, 'john-summit', state('https://x/tracklist/b2b'))
    await saveSubState(env, 'moguai', state('https://x/tracklist/b2b'))
    expect(await findTracklistUrlByVideoId(env, 'wKOj6yQ6TAQ')).toBe('https://x/tracklist/b2b')
  })
})
