import { describe, it, expect } from 'vitest'
import type { Env } from '../src/types'
import { fakeD1 } from './helpers/fake-d1'
import { fakeKV } from './helpers/fake-kv'
import { makeLogger } from '../src/lib/log'
import { findRenamedTracklists, mergeRenamedState, retireRenamedTracklists } from '../src/lib/tracklist-renames'
import { loadSubState, saveSubState, type SubState, type TracklistVideo } from '../src/lib/sync-store'
import { indexSet, type IndexTrack } from '../src/lib/search/index'

const OLD = 'https://www.1001tracklists.com/tracklist/1y2us4k1/odd-mob-gallagher-square-united-states-2026-05-29.html'
const NEW = 'https://www.1001tracklists.com/tracklist/1y2us4k1/odd-mob-gallagher-square-san-diego-united-states-2026-05-29.html'
const OTHER = 'https://www.1001tracklists.com/tracklist/2abc/odd-mob-elsewhere-2026-06-01.html'
const log = makeLogger({ task: 'test' })

describe('findRenamedTracklists', () => {
  it('maps every earlier URL of an id to the last one, and leaves single URLs alone', () => {
    expect(findRenamedTracklists([OLD, OTHER, NEW])).toEqual([{ from: OLD, to: NEW }])
    expect(findRenamedTracklists([NEW, OLD])).toEqual([{ from: NEW, to: OLD }])
    expect(findRenamedTracklists([OLD, OTHER])).toEqual([])
    const third = OLD.replace('united-states', 'usa')
    expect(findRenamedTracklists([OLD, NEW, third])).toEqual([{ from: OLD, to: third }, { from: NEW, to: third }])
  })
})

describe('mergeRenamedState', () => {
  it('carries processed and the video record to the winner and drops the loser everywhere', () => {
    const state: SubState = {
      discoveredTracklistUrls: [OLD, OTHER, NEW],
      processedTracklistUrls: [OLD, OTHER],
      abandonedTracklistUrls: [],
      failureCounts: { [OLD]: 1 },
    }
    const videos: Record<string, TracklistVideo> = { [OLD]: { videoId: 'vid', checkedAt: 5 } }
    const discovered = new Set(state.discoveredTracklistUrls)
    mergeRenamedState(state, videos, discovered, [{ from: OLD, to: NEW }])
    expect(state.discoveredTracklistUrls).toEqual([OTHER, NEW])
    expect(new Set(state.processedTracklistUrls)).toEqual(new Set([OTHER, NEW]))
    expect(state.failureCounts).toEqual({})
    expect(videos).toEqual({ [NEW]: { videoId: 'vid', checkedAt: 5 } })
    expect([...discovered]).toEqual([OTHER, NEW])
  })

  it('keeps the winner’s own video record', () => {
    const state: SubState = { discoveredTracklistUrls: [OLD, NEW], processedTracklistUrls: [OLD, NEW] }
    const videos: Record<string, TracklistVideo> = { [OLD]: { videoId: 'a', checkedAt: 1 }, [NEW]: { videoId: 'b', checkedAt: 2 } }
    mergeRenamedState(state, videos, new Set(state.discoveredTracklistUrls), [{ from: OLD, to: NEW }])
    expect(videos).toEqual({ [NEW]: { videoId: 'b', checkedAt: 2 } })
  })
})

describe('retireRenamedTracklists', () => {
  function makeEnv(): Env {
    return { CACHE: fakeKV(), SUBS: fakeKV(), DB: fakeD1(), SEARCH_DB: fakeD1({ migrations: 'search' }) } as unknown as Env
  }
  const track = (title: string): IndexTrack => ({ trackId: null, trackUrl: null, artist: 'A', title, label: null, artworkUrl: null, cueSeconds: null, layered: false })
  const indexed = (setUrl: string, tracks: IndexTrack[]) => ({
    setUrl, djSlug: 'oddmob', djName: 'Odd Mob', title: 'Odd Mob @ Gallagher Square', setDate: '2026-05-29', videoId: 'vid', videoSource: '1001tl',
    trackCount: tracks.length, idedCount: tracks.length, source: 'page' as const, imageUrl: null, tracks,
  })

  it('moves or drops the loser’s rows, repoints history, and drops its search entry when the winner is indexed', async () => {
    const env = makeEnv()
    const db = env.DB!
    const state: SubState = { discoveredTracklistUrls: [OLD, NEW], processedTracklistUrls: [OLD, NEW], tracklistVideos: { [OLD]: { videoId: 'vid', checkedAt: 1 }, [NEW]: { videoId: 'vid', checkedAt: 2 } } }
    await saveSubState(env, 'oddmob', state)
    for (const u of [OLD, NEW]) await db.prepare('INSERT INTO set_schedule (url, next_due_at, updated_at) VALUES (?, ?, 1)').bind(u, u === OLD ? 1 : 2).run()
    await db
      .prepare("INSERT INTO set_verification (url, state, fingerprint, row_count, first_account, first_fetched_at, updated_at) VALUES (?, 'verified', 'f', 3, 'a1', 1, 1)")
      .bind(OLD)
      .run()
    await db.prepare("INSERT INTO playlist_additions (t, ts, status, slug, set_url, summary, record) VALUES ('x', 1, 'added', 'oddmob', ?, 's', '{}')").bind(OLD).run()
    await indexSet(env, indexed(OLD, [track('Only Old'), track('Shared')]), 100)
    await indexSet(env, indexed(NEW, [track('Shared')]), 100)

    await retireRenamedTracklists(env, 'oddmob', [{ from: OLD, to: NEW }], log)

    expect((await loadSubState(env, 'oddmob'))!.discoveredTracklistUrls).toEqual([NEW])
    expect((await db.prepare('SELECT url, next_due_at FROM set_schedule').all()).results).toEqual([{ url: NEW, next_due_at: 2 }])
    expect((await db.prepare('SELECT url FROM set_verification').all()).results).toEqual([{ url: NEW }])
    expect((await db.prepare('SELECT set_url FROM playlist_additions').all()).results).toEqual([{ set_url: NEW }])
    const sdb = env.SEARCH_DB!
    expect((await sdb.prepare('SELECT set_url FROM search_sets').all()).results).toEqual([{ set_url: NEW }])
    expect((await sdb.prepare('SELECT COUNT(*) AS n FROM sets_fts').first<{ n: number }>())!.n).toBe(1)
    expect((await sdb.prepare('SELECT title, sets_count FROM search_tracks ORDER BY title').all()).results).toEqual([
      { title: 'Only Old', sets_count: 0 },
      { title: 'Shared', sets_count: 1 },
    ])
  })

  it('renames the loser’s search entry when only the loser was indexed', async () => {
    const env = makeEnv()
    await indexSet(env, indexed(OLD, [track('T')]), 100)
    await retireRenamedTracklists(env, 'oddmob', [{ from: OLD, to: NEW }], log)
    const sdb = env.SEARCH_DB!
    expect((await sdb.prepare('SELECT set_url FROM search_sets').all()).results).toEqual([{ set_url: NEW }])
    expect((await sdb.prepare('SELECT set_url FROM search_track_sets').all()).results).toEqual([{ set_url: NEW }])
  })
})
