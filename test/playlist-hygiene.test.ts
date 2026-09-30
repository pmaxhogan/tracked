import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeD1 } from './helpers/fake-d1'
import { fakeKV } from './helpers/fake-kv'
import type { Env } from '../src/types'
import { makeLogger } from '../src/lib/log'
import type { VideoMeta } from '../src/lib/video-meta'

vi.mock('../src/lib/youtube-playlists', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/youtube-playlists')>('../src/lib/youtube-playlists')
  return { ...actual, listPlaylistItems: vi.fn(), removeVideoFromPlaylist: vi.fn(), addVideoToPlaylist: vi.fn() }
})
vi.mock('../src/lib/video-meta', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/video-meta')>('../src/lib/video-meta')
  return { ...actual, getVideoMeta: vi.fn() }
})
vi.mock('../src/lib/google-oauth', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/google-oauth')>('../src/lib/google-oauth')
  return { ...actual, getAccessToken: vi.fn(async () => ({ accessToken: 'tok', tokens: {} })) }
})

import { addVideoToPlaylist, listPlaylistItems, removeVideoFromPlaylist, YouTubeApiError } from '../src/lib/youtube-playlists'
import { getVideoMeta } from '../src/lib/video-meta'
import { getAccessToken } from '../src/lib/google-oauth'
import {
  comparePlaylists,
  extractSetFacts,
  hasGoodVideo,
  isMassRemoval,
  listHolds,
  playlistHoldNotifier,
  playlistHoldPayload,
  mkvidReplacedIds,
  approveHold,
  pickSetVideo,
  removeAndReplace,
  runPlaylistHygiene,
  runRemovalSweep,
  saveSetFacts,
  sweepDeletesUsed,
  sweepSettings,
  undoRemoval,
  type SetFacts,
} from '../src/lib/playlist-hygiene'
import { savePushSubscription } from '../src/lib/web-push'
import { pushSubscription, vapid } from './helpers/web-push'
import { blockedIds, combinedRefuses, combinedSkipIds, confirmedMembership, isBlocked, markInPlaylist, markOutOfPlaylist, recordRemoved, savePlaylistMembers, setOverride } from '../src/lib/playlist-blocklist'
import { getMkvidRequestForSet } from '../src/lib/mkvid'

const log = makeLogger({ task: 'test' })
const fixture = (name: string) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8')

function makeEnv(extra: Partial<Env> = {}): Env {
  return { CACHE: fakeKV(), SUBS: fakeKV(), DB: fakeD1(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k', DEV_BYPASS_CF_ACCESS: '1', ...extra } as Env
}

const SLUG = 'dj'
const PL = 'PLartist'
const PLC = 'PLcombined'
const setUrl = (n: number | string) => `https://www.1001tracklists.com/tracklist/${n}/dj-set-2026-09-0${Number(n) % 9 || 1}.html`

async function seedSub(env: Env, slug = SLUG, playlistId = PL) {
  await env.DB.prepare('INSERT INTO sub_sync (slug, playlist_id, artist_name) VALUES (?, ?, ?)').bind(slug, playlistId, 'DJ').run()
}
/**
 * A processed set. Its video counts as confirmed in the DJ's playlist (the
 * sync's insert succeeded) unless `confirmed: false`.
 */
async function seedSet(env: Env, url: string, videoId: string | null, opts: { slug?: string; source?: string; pos?: number; confirmed?: boolean; playlistId?: string } = {}) {
  await env.DB.prepare(
    'INSERT INTO tracklists (slug, url, position, discovered_at, processed, video_known, video_id, video_source, checked_at) VALUES (?, ?, ?, 0, 1, 1, ?, ?, ?)',
  )
    .bind(opts.slug ?? SLUG, url, opts.pos ?? 0, videoId, videoId ? (opts.source ?? '1001tl') : null, 1_900_000_000)
    .run()
  if (videoId && opts.confirmed !== false) await markInPlaylist(env, opts.playlistId ?? PL, videoId, 'sync', 1)
}
async function seedCombined(env: Env, extra: Record<string, unknown> = {}) {
  await env.SUBS.put('subs:combined', JSON.stringify({ playlistId: PLC, ...extra }))
}
async function row(env: Env, url: string) {
  return env.DB.prepare('SELECT * FROM tracklists WHERE url = ?').bind(url).first<{ video_id: string | null; video_known: number; checked_at: number; video_source: string | null }>()
}
async function removals(env: Env) {
  return (await env.DB.prepare('SELECT * FROM playlist_removals ORDER BY id').all<Record<string, any>>()).results
}

function meta(id: string, m: Partial<VideoMeta> = {}): VideoMeta {
  return { videoId: id, durationSeconds: 3600, embedWidth: 1280, embedHeight: 720, privacy: 'public', uploadStatus: 'processed', alive: true, fetchedAt: 0, ...m }
}
function metaAnswer(metas: Record<string, Partial<VideoMeta>>) {
  ;(getVideoMeta as ReturnType<typeof vi.fn>).mockImplementation(async (_env: Env, ids: string[]) => new Map(ids.map((id) => [id, meta(id, metas[id] ?? {})])))
}
function facts(url: string, f: Partial<SetFacts> = {}): SetFacts {
  return { setUrl: url, slug: SLUG, videoId: null, noFullNotice: false, lastCueSeconds: null, audioMaxSeconds: null, audioKind: null, audioUrl: null, setTitle: null, setDate: null, trackCount: 10, idedCount: 10, fetchedAt: 1, ...f }
}
/** listPlaylistItems answers from a playlistId → video ids map. */
function listing(map: Record<string, string[]>, opts: { incomplete?: string[]; throws?: string[]; deadTitles?: string[] } = {}) {
  ;(listPlaylistItems as ReturnType<typeof vi.fn>).mockImplementation(async (playlistId: string) => {
    if ((opts.throws ?? []).includes(playlistId)) throw new Error('youtube playlistItems.list 500')
    const items = (map[playlistId] ?? []).map((id) => ({
      id: `item-${id}`,
      snippet: { title: (opts.deadTitles ?? []).includes(id) ? 'Deleted video' : `Set ${id}`, resourceId: { videoId: id } },
      contentDetails: { videoId: id },
    }))
    return { items, nextPageToken: (opts.incomplete ?? []).includes(playlistId) ? 'NEXT' : null, pages: 1 }
  })
}

beforeEach(() => {
  vi.mocked(listPlaylistItems).mockReset()
  vi.mocked(removeVideoFromPlaylist).mockReset().mockResolvedValue(1)
  vi.mocked(addVideoToPlaylist).mockReset().mockResolvedValue(undefined)
  vi.mocked(getVideoMeta).mockReset().mockImplementation(async (_env: Env, ids: string[]) => new Map(ids.map((id) => [id, meta(id)])))
  vi.mocked(getAccessToken).mockClear()
})

describe('sweepSettings', () => {
  it('is a dry run unless PLAYLIST_SWEEP_DRY_RUN says otherwise', () => {
    expect(sweepSettings({}).dryRun).toBe(true)
    expect(sweepSettings({ PLAYLIST_SWEEP_DRY_RUN: '' }).dryRun).toBe(true)
    expect(sweepSettings({ PLAYLIST_SWEEP_DRY_RUN: 'true' }).dryRun).toBe(true)
    expect(sweepSettings({ PLAYLIST_SWEEP_DRY_RUN: 'yes please' }).dryRun).toBe(true)
    for (const off of ['false', '0', 'no', 'OFF']) expect(sweepSettings({ PLAYLIST_SWEEP_DRY_RUN: off }).dryRun).toBe(false)
  })

  it('allows 40 removals a day unless configured', () => {
    expect(sweepSettings({}).dailyRemovals).toBe(40)
    expect(sweepSettings({ PLAYLIST_SWEEP_DAILY_REMOVALS: '5' }).dailyRemovals).toBe(5)
    expect(sweepSettings({ PLAYLIST_SWEEP_DAILY_REMOVALS: '0' }).dailyRemovals).toBe(0)
    expect(sweepSettings({ PLAYLIST_SWEEP_DAILY_REMOVALS: 'lots' }).dailyRemovals).toBe(40)
  })
})

describe('extractSetFacts', () => {
  it('reads the notice, cues, rows and audio source from a saved page', () => {
    const f = extractSetFacts(SLUG, 'https://www.1001tracklists.com/tracklist/l3uw499/matroda.html', fixture('tracklist-matroda.html'), '79n8BaQAL2Q')
    expect(f.noFullNotice).toBe(true)
    expect(f.videoId).toBe('79n8BaQAL2Q')
    expect(f.lastCueSeconds).toBeGreaterThan(0)
    expect(f.trackCount).toBeGreaterThan(0)
    const m = extractSetFacts(SLUG, 'https://www.1001tracklists.com/tracklist/1pmwyfn1/max-styler.html', fixture('tracklist-maxstyler.html'), 'N40pkDgwNfg')
    expect(m.noFullNotice).toBe(false)
    expect(m.audioMaxSeconds).toBe(4569)
    expect(m.audioKind).toBe('soundcloud')
    expect(m.trackCount).toBeGreaterThanOrEqual(28)
  })
})

describe('pickSetVideo (the sync gate)', () => {
  const html = '<html>plain page</html>'

  it('passes a full recording and stores the page facts', async () => {
    const env = makeEnv()
    const r = await pickSetVideo(env, { slug: SLUG, setUrl: setUrl(1), html, rawVideoId: 'good0000001', playlistId: PL, accessToken: 'tok', log })
    expect(r).toEqual({ videoId: 'good0000001', rejected: null })
    const stored = await env.DB.prepare('SELECT video_id FROM set_media_facts WHERE set_url = ?').bind(setUrl(1)).first<{ video_id: string }>()
    expect(stored!.video_id).toBe('good0000001')
  })

  it('turns down a video on a page with the no-full-recording notice', async () => {
    const env = makeEnv()
    const r = await pickSetVideo(env, { slug: SLUG, setUrl: setUrl(1), html: fixture('tracklist-matroda.html'), rawVideoId: '79n8BaQAL2Q', playlistId: PL, accessToken: 'tok', log })
    expect(r.videoId).toBeNull()
    expect(r.rejected).toMatchObject({ videoId: '79n8BaQAL2Q', reason: 'notice' })
  })

  it('leaves a vertical-looking video alone while REJECT_VERTICAL is off (the default)', async () => {
    const env = makeEnv()
    metaAnswer({ vert0000001: { embedWidth: 720, embedHeight: 1280 } })
    expect((await pickSetVideo(env, { slug: SLUG, setUrl: setUrl(1), html, rawVideoId: 'vert0000001', playlistId: PL, accessToken: 'tok', log })).rejected).toBeNull()
  })

  it('turns down a vertical video (REJECT_VERTICAL=1) and one much shorter than the audio', async () => {
    const env = makeEnv({ REJECT_VERTICAL: '1' })
    metaAnswer({ vert0000001: { embedWidth: 720, embedHeight: 1280 }, clip0000001: { durationSeconds: 600 } })
    expect((await pickSetVideo(env, { slug: SLUG, setUrl: setUrl(1), html, rawVideoId: 'vert0000001', playlistId: PL, accessToken: 'tok', log })).rejected).toMatchObject({ reason: 'vertical' })
    const withAudio = 'new AudioPlayerSC("scWidget_1", { idPlayer: "1", type: "soundcloud", source: "x", duration: "3600" })'
    expect((await pickSetVideo(env, { slug: SLUG, setUrl: setUrl(2), html: withAudio, rawVideoId: 'clip0000001', playlistId: PL, accessToken: 'tok', log })).rejected).toMatchObject({ reason: 'audio_longer' })
  })

  it('turns down a video removed from the artist playlist before, and a dead one', async () => {
    const env = makeEnv()
    await recordRemoved(env, { playlistId: PL, videoId: 'gone0000001', slug: SLUG, setUrl: setUrl(1), reason: 'owner' })
    const r = await pickSetVideo(env, { slug: SLUG, setUrl: setUrl(1), html, rawVideoId: 'gone0000001', playlistId: PL, accessToken: 'tok', log })
    expect(r).toMatchObject({ videoId: null, rejected: { reason: 'blocked' } })
    metaAnswer({ dead0000001: { alive: false } })
    expect((await pickSetVideo(env, { slug: SLUG, setUrl: setUrl(2), html, rawVideoId: 'dead0000001', playlistId: PL, accessToken: 'tok', log })).rejected).toMatchObject({ reason: 'dead' })
  })

  it('lets an owner-overridden video through, and fails open when the lookup fails', async () => {
    const env = makeEnv()
    await setOverride(env, '79n8BaQAL2Q')
    expect((await pickSetVideo(env, { slug: SLUG, setUrl: setUrl(1), html: fixture('tracklist-matroda.html'), rawVideoId: '79n8BaQAL2Q', playlistId: PL, accessToken: 'tok', log })).videoId).toBe('79n8BaQAL2Q')
    vi.mocked(getVideoMeta).mockRejectedValue(new Error('videos.list 500'))
    expect((await pickSetVideo(env, { slug: SLUG, setUrl: setUrl(2), html, rawVideoId: 'unkn0000001', playlistId: PL, accessToken: 'tok', log })).videoId).toBe('unkn0000001')
  })

  it('no page video: nothing to vet', async () => {
    const env = makeEnv()
    expect(await pickSetVideo(env, { slug: SLUG, setUrl: setUrl(1), html, rawVideoId: null, playlistId: PL, accessToken: 'tok', log })).toEqual({ videoId: null, rejected: null })
    expect(getVideoMeta).not.toHaveBeenCalled()
  })
})

describe('hasGoodVideo (for the mkvid eligibility check)', () => {
  it('false without a video, when blocked, or when cached facts reject it; true otherwise', async () => {
    const env = makeEnv()
    await seedSub(env)
    expect(await hasGoodVideo(env, { slug: SLUG, setUrl: setUrl(1), videoId: null })).toBe(false)
    expect(await hasGoodVideo(env, { slug: SLUG, setUrl: setUrl(1), videoId: 'good0000001' })).toBe(true)
    await saveSetFacts(env, facts(setUrl(2), { noFullNotice: true }))
    expect(await hasGoodVideo(env, { slug: SLUG, setUrl: setUrl(2), videoId: 'bad00000001' })).toBe(false)
    await recordRemoved(env, { playlistId: PL, videoId: 'own00000001', slug: SLUG, setUrl: setUrl(3), reason: 'owner' })
    expect(await hasGoodVideo(env, { slug: SLUG, setUrl: setUrl(3), videoId: 'own00000001' })).toBe(false)
    await setOverride(env, 'bad00000001')
    expect(await hasGoodVideo(env, { slug: SLUG, setUrl: setUrl(2), videoId: 'bad00000001' })).toBe(true)
  })
})

describe('runRemovalSweep', () => {
  async function seedMix(env: Env) {
    await seedSub(env)
    await seedCombined(env)
    await seedSet(env, setUrl(1), 'good0000001', { pos: 0 })
    await seedSet(env, setUrl(2), 'notc0000001', { pos: 1 })
    await seedSet(env, setUrl(3), 'vert0000001', { pos: 2 })
    await seedSet(env, setUrl(4), 'mkvd0000001', { pos: 3, source: 'mkvid' })
    await saveSetFacts(env, facts(setUrl(2), { noFullNotice: true }))
    await saveSetFacts(env, facts(setUrl(4), { noFullNotice: true }))
    metaAnswer({ vert0000001: { embedWidth: 720, embedHeight: 1280 } })
  }

  it('dry run (the default) only reports, from facts and video meta, and never deletes', async () => {
    const env = makeEnv({ REJECT_VERTICAL: '1' })
    await seedMix(env)
    const r = await runRemovalSweep(env, 'tok', { log })
    expect(r).toMatchObject({ dryRun: true, candidates: 3, rejected: 2, reported: 2, deletes: 0 })
    expect(removeVideoFromPlaylist).not.toHaveBeenCalled()
    const rows = await removals(env)
    expect(rows.map((x) => [x.video_id, x.playlist_kind, x.status, x.reason])).toEqual([
      ['notc0000001', 'artist', 'would_remove', 'notice'],
      ['notc0000001', 'combined', 'would_remove', 'notice'],
      ['vert0000001', 'artist', 'would_remove', 'vertical'],
      ['vert0000001', 'combined', 'would_remove', 'vertical'],
    ])
    expect((await row(env, setUrl(2)))!.video_id).toBe('notc0000001')
    // A second dry run does not duplicate the report.
    await runRemovalSweep(env, 'tok', { log })
    expect(await removals(env)).toHaveLength(4)
  })

  it('live: removes from both playlists, logs, clears the set so the recheck queues mkvid', async () => {
    const env = makeEnv({ REJECT_VERTICAL: '1' })
    await seedMix(env)
    const r = await runRemovalSweep(env, 'tok', { log, settings: { dryRun: false, dailyRemovals: 40 } })
    expect(r).toMatchObject({ dryRun: false, rejected: 2, removedVideos: 2, deletes: 4 })
    expect(vi.mocked(removeVideoFromPlaylist).mock.calls.map((c) => [c[0], c[1]])).toEqual([
      [PL, 'notc0000001'],
      [PLC, 'notc0000001'],
      [PL, 'vert0000001'],
      [PLC, 'vert0000001'],
    ])
    expect(await row(env, setUrl(2))).toMatchObject({ video_id: null, video_known: 1, checked_at: 0 })
    expect((await row(env, setUrl(1)))!.video_id).toBe('good0000001')
    expect((await row(env, setUrl(4)))!.video_id).toBe('mkvd0000001')
    expect((await removals(env)).every((x) => x.status === 'removed')).toBe(true)
    expect(await sweepDeletesUsed(env)).toBe(4)
  })

  it('stops at the daily delete budget and carries on the next day', async () => {
    const env = makeEnv({ REJECT_VERTICAL: '1' })
    await seedMix(env)
    const day1 = Date.parse('2026-10-01T12:00:00Z')
    const r1 = await runRemovalSweep(env, 'tok', { log, settings: { dryRun: false, dailyRemovals: 3 }, nowMs: day1 })
    expect(r1).toMatchObject({ removedVideos: 1, deletes: 2, stoppedBy: 'budget' })
    const r2 = await runRemovalSweep(env, 'tok', { log, settings: { dryRun: false, dailyRemovals: 3 }, nowMs: day1 + 3600_000 })
    expect(r2).toMatchObject({ removedVideos: 0, stoppedBy: 'budget', budgetLeft: 1 })
    const r3 = await runRemovalSweep(env, 'tok', { log, settings: { dryRun: false, dailyRemovals: 3 }, nowMs: day1 + 86400_000 })
    expect(r3).toMatchObject({ removedVideos: 1, deletes: 2, stoppedBy: null })
  })

  it('stops on a quota error without clearing the set', async () => {
    const env = makeEnv({ REJECT_VERTICAL: '1' })
    await seedMix(env)
    vi.mocked(removeVideoFromPlaylist).mockRejectedValue(new YouTubeApiError('playlistItems.delete', 403, 'quotaExceeded', '{}'))
    const r = await runRemovalSweep(env, 'tok', { log, settings: { dryRun: false, dailyRemovals: 40 } })
    expect(r).toMatchObject({ stoppedBy: 'quota', removedVideos: 0, failed: 1 })
    expect((await row(env, setUrl(2)))!.video_id).toBe('notc0000001')
    expect((await removals(env))[0]).toMatchObject({ status: 'failed' })
  })

  it('skips overridden videos and leaves a shared video in the combined playlist', async () => {
    const env = makeEnv({ REJECT_VERTICAL: '1' })
    await seedMix(env)
    await setOverride(env, 'vert0000001')
    // Another DJ's set (fine, no facts) resolves to the rejected video too.
    await seedSub(env, 'other', 'PLother')
    await seedSet(env, 'https://www.1001tracklists.com/tracklist/9/other.html', 'notc0000001', { slug: 'other' })
    const r = await runRemovalSweep(env, 'tok', { log, settings: { dryRun: false, dailyRemovals: 40 } })
    expect(r.rejected).toBe(1)
    expect(vi.mocked(removeVideoFromPlaylist).mock.calls.map((c) => c[0])).toEqual([PL])
  })

  it('does not delete dead videos (the comparison records those)', async () => {
    const env = makeEnv({ REJECT_VERTICAL: '1' })
    await seedSub(env)
    await seedSet(env, setUrl(1), 'dead0000001')
    metaAnswer({ dead0000001: { alive: false } })
    const r = await runRemovalSweep(env, 'tok', { log, settings: { dryRun: false, dailyRemovals: 40 } })
    expect(r.rejected).toBe(0)
    expect(removeVideoFromPlaylist).not.toHaveBeenCalled()
  })
})

async function seedFive(env: Env) {
  await seedSub(env)
  for (let i = 1; i <= 10; i++) await seedSet(env, setUrl(i), `vid${String(i).padStart(8, '0')}`, { pos: i })
}
const ids = (n: number[]) => n.map((i) => `vid${String(i).padStart(8, '0')}`)

describe('comparePlaylists', () => {
  it('records a video missing from the artist playlist as owner-removed, clears its set and never re-adds it', async () => {
    const env = makeEnv()
    await seedFive(env)
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6, 7, 8, 9]) })
    const [r] = await comparePlaylists(env, 'tok', { log })
    expect(r).toMatchObject({ kind: 'artist', status: 'ok', expected: 10, missing: 1, owner: 1, dead: 0 })
    expect(await isBlocked(env, PL, 'vid00000010')).toBe(true)
    expect(await row(env, setUrl(10))).toMatchObject({ video_id: null, video_known: 1, checked_at: 0 })
    expect((await removals(env))[0]).toMatchObject({ source: 'owner', status: 'recorded', video_id: 'vid00000010' })
    // Next run: nothing new.
    const [again] = await comparePlaylists(env, 'tok', { log })
    expect(again).toMatchObject({ missing: 0, owner: 0 })
  })

  it('labels a missing video that is gone from YouTube as dead, and a present "Deleted video" item too', async () => {
    const env = makeEnv()
    await seedFive(env)
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6, 7, 8, 9]) }, { deadTitles: ['vid00000001'] })
    metaAnswer({ vid00000010: { alive: false } })
    const [r] = await comparePlaylists(env, 'tok', { log })
    expect(r).toMatchObject({ missing: 1, owner: 0, dead: 2 })
    expect(vi.mocked(getVideoMeta).mock.calls[0]![3]).toMatchObject({ maxAgeSeconds: 0 })
    expect((await blockedIds(env, PL)).size).toBe(2)
  })

  it('treats removals made before it existed the same way on its first run', async () => {
    const env = makeEnv()
    await seedFive(env)
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6, 7, 8]) })
    const [r] = await comparePlaylists(env, 'tok', { log })
    expect(r).toMatchObject({ status: 'ok', owner: 2 })
  })

  it('never reads an incomplete or failed listing as removals', async () => {
    const env = makeEnv()
    await seedFive(env)
    listing({ [PL]: [] }, { incomplete: [PL] })
    expect((await comparePlaylists(env, 'tok', { log }))[0]).toMatchObject({ status: 'incomplete' })
    listing({}, { throws: [PL] })
    expect((await comparePlaylists(env, 'tok', { log }))[0]).toMatchObject({ status: 'incomplete' })
    expect(await removals(env)).toHaveLength(0)
    expect((await row(env, setUrl(1)))!.video_id).toBe('vid00000001')
  })

  it('holds a playlist that seems to have lost more than 30%, pushes once, and applies after approval', async () => {
    const env = makeEnv()
    await seedFive(env)
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6]) })
    const notify = vi.fn(async () => {})
    expect((await comparePlaylists(env, 'tok', { log, notify }))[0]).toMatchObject({ status: 'held', missing: 4 })
    expect((await comparePlaylists(env, 'tok', { log, notify }))[0]).toMatchObject({ status: 'held' })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(await removals(env)).toHaveLength(0)
    expect(await listHolds(env)).toMatchObject([{ playlistId: PL, missing: 4, expected: 10, notified: true }])
    expect(await approveHold(env, PL)).toBe(true)
    expect((await comparePlaylists(env, 'tok', { log, notify }))[0]).toMatchObject({ status: 'ok', owner: 4 })
    expect(await listHolds(env)).toEqual([])
    expect(await approveHold(env, PL)).toBe(false)
  })

  it('holds above 30% or above 5 missing, whatever the playlist size (M3)', async () => {
    expect(isMassRemoval(0, 10)).toBe(false)
    expect(isMassRemoval(3, 10)).toBe(false)
    expect(isMassRemoval(4, 10)).toBe(true)
    expect(isMassRemoval(1, 10)).toBe(false)
    expect(isMassRemoval(2, 2)).toBe(true) // small playlists no longer slip under a minimum
    expect(isMassRemoval(1, 1)).toBe(true)
    expect(isMassRemoval(5, 100)).toBe(false)
    expect(isMassRemoval(6, 100)).toBe(true)
  })

  it('combined: first run only snapshots; later a missing member is recorded for the combined playlist only', async () => {
    const env = makeEnv()
    await seedFive(env)
    await seedCombined(env)
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), [PLC]: ids([1, 2, 3, 4, 5]) })
    const first = await comparePlaylists(env, 'tok', { log })
    expect(first[1]).toMatchObject({ kind: 'combined', status: 'first_snapshot' })
    // The backfill lag (6-10 absent) is not a removal. The owner then removes 5.
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), [PLC]: ids([1, 2, 3, 4, 6]) })
    const second = await comparePlaylists(env, 'tok', { log })
    expect(second[1]).toMatchObject({ kind: 'combined', status: 'ok', missing: 1, owner: 1 })
    expect(await isBlocked(env, PLC, 'vid00000005')).toBe(true)
    expect(await isBlocked(env, PL, 'vid00000005')).toBe(false)
    // Combined-only removal leaves the set's video alone.
    expect((await row(env, setUrl(5)))!.video_id).toBe('vid00000005')
  })
})

describe('combined playlist never gets back what was taken out', () => {
  it('skips blocked ids and ids that left since the last complete listing', async () => {
    const env = makeEnv()
    await savePlaylistMembers(env, PLC, new Set(['a0000000001', 'b0000000001']))
    await recordRemoved(env, { playlistId: PLC, videoId: 'c0000000001', slug: null, setUrl: null, reason: 'owner' })
    const current = new Set(['a0000000001'])
    expect([...(await combinedSkipIds(env, PLC, current))].sort()).toEqual(['b0000000001', 'c0000000001'])
    expect(await combinedRefuses(env, PLC, 'b0000000001', current)).toBe(true)
    expect(await combinedRefuses(env, PLC, 'c0000000001', current)).toBe(true)
    expect(await combinedRefuses(env, PLC, 'new00000001', current)).toBe(false)
    expect(await combinedRefuses(env, PLC, 'a0000000001', current)).toBe(false)
  })
})

describe('removeAndReplace', () => {
  it('removes from both playlists, blocks the video, clears the set and queues mkvid from stored facts', async () => {
    const env = makeEnv({ MKVID_TOKEN: 'm' })
    await seedSub(env)
    await seedCombined(env)
    await seedSet(env, setUrl(1), 'bad00000001')
    await saveSetFacts(env, facts(setUrl(1), { audioKind: 'soundcloud', audioUrl: 'https://api.soundcloud.com/tracks/1', lastCueSeconds: 3000, setTitle: 'DJ @ Club' }))
    const r = await removeAndReplace(env, 'tok', { slug: SLUG, setUrl: setUrl(1), log })
    expect(r).toMatchObject({ ok: true, videoId: 'bad00000001', mkvid: 'queued for mkvid (soundcloud)' })
    expect(vi.mocked(removeVideoFromPlaylist).mock.calls.map((c) => c[0])).toEqual([PL, PLC])
    expect(await isBlocked(env, PL, 'bad00000001')).toBe(true)
    expect(await isBlocked(env, PLC, 'bad00000001')).toBe(true)
    expect(await row(env, setUrl(1))).toMatchObject({ video_id: null, checked_at: 0 })
    expect(await getMkvidRequestForSet(env, setUrl(1))).toMatchObject({ status: 'pending', source: 'soundcloud' })
  })

  it('answers no_video / not_found without touching YouTube', async () => {
    const env = makeEnv()
    await seedSet(env, setUrl(1), null)
    expect(await removeAndReplace(env, 'tok', { slug: SLUG, setUrl: setUrl(1), log })).toEqual({ ok: false, error: 'no_video' })
    expect(await removeAndReplace(env, 'tok', { slug: SLUG, setUrl: setUrl(2), log })).toEqual({ ok: false, error: 'not_found' })
    expect(removeVideoFromPlaylist).not.toHaveBeenCalled()
  })
})

describe('undoRemoval', () => {
  it('re-adds a removed video, unblocks it, restores the set and exempts it from the rule', async () => {
    const env = makeEnv()
    await seedFive(env)
    listing({ [PL]: ids([2, 3, 4, 5, 6, 7, 8, 9, 10]) })
    await comparePlaylists(env, 'tok', { log })
    const [rec] = await removals(env)
    const r = await undoRemoval(env, 'tok', rec!.id, log)
    expect(r).toEqual({ ok: true, readded: true })
    expect(addVideoToPlaylist).toHaveBeenCalledWith(PL, 'vid00000001', 'tok', undefined)
    expect(await isBlocked(env, PL, 'vid00000001')).toBe(false)
    expect((await row(env, setUrl(1)))!.video_id).toBe('vid00000001')
    expect((await removals(env))[0]!.status).toBe('undone')
    expect(await undoRemoval(env, 'tok', rec!.id, log)).toEqual({ ok: false, error: 'not_undoable' })
  })

  it('a dry-run row is kept by override alone; dead rows cannot be undone', async () => {
    const env = makeEnv()
    await seedSub(env)
    await seedSet(env, setUrl(1), 'notc0000001')
    await saveSetFacts(env, facts(setUrl(1), { noFullNotice: true }))
    await runRemovalSweep(env, 'tok', { log })
    const [rec] = await removals(env)
    expect(await undoRemoval(env, 'tok', rec!.id, log)).toEqual({ ok: true, readded: false })
    expect(addVideoToPlaylist).not.toHaveBeenCalled()
    expect((await runRemovalSweep(env, 'tok', { log })).candidates).toBe(0)

    await seedSet(env, setUrl(2), 'dead0000001', { pos: 1 })
    listing({ [PL]: ['notc0000001'] })
    metaAnswer({ dead0000001: { alive: false } })
    // 1 of 2 missing is held (>30%); the owner approves exactly that id.
    expect((await comparePlaylists(env, 'tok', { log }))[0]).toMatchObject({ status: 'held' })
    expect(await approveHold(env, PL)).toBe(true)
    await comparePlaylists(env, 'tok', { log })
    const dead = (await removals(env)).find((x) => x.source === 'dead')!
    expect(await undoRemoval(env, 'tok', dead.id, log)).toEqual({ ok: false, error: 'not_undoable' })
    expect(await undoRemoval(env, 'tok', 9999, log)).toEqual({ ok: false, error: 'not_found' })
  })
})

describe('runPlaylistHygiene (cron entry)', () => {
  it('compares and sweeps when due, then waits 6 hours', async () => {
    const env = makeEnv()
    await seedSub(env)
    listing({ [PL]: [] })
    const t0 = Date.parse('2026-10-01T00:00:00Z')
    const r1 = await runPlaylistHygiene(env, log, { nowMs: t0 })
    expect(r1.compare).toHaveLength(1)
    expect(r1.sweep).toMatchObject({ dryRun: true })
    expect(await runPlaylistHygiene(env, log, { nowMs: t0 + 5 * 60_000 })).toEqual({ skipped: 'not_due' })
    const r3 = await runPlaylistHygiene(env, log, { nowMs: t0 + 6 * 3600_000 })
    expect(r3.compare).toBeDefined()
  })

  it('skips without a YouTube connection and never throws', async () => {
    const env = makeEnv()
    vi.mocked(getAccessToken).mockResolvedValueOnce(null)
    expect(await runPlaylistHygiene(env, log)).toEqual({ skipped: 'youtube_not_connected' })
    const broken = makeEnv({ DB: undefined as unknown as D1Database })
    expect(await runPlaylistHygiene(broken, log, { accessToken: 'tok' })).toEqual({ skipped: 'error' })
  })
})

describe('routes', () => {
  it('serve the removed page and API behind Cloudflare Access', async () => {
    const { app } = await import('../src/index')
    const locked = makeEnv({ DEV_BYPASS_CF_ACCESS: undefined, CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CF_ACCESS_AUD: 'aud', CF_ACCESS_ALLOWED_EMAILS: 'owner@example.com' })
    for (const [method, path] of [['GET', '/ui/removed'], ['GET', '/ui/api/removals'], ['POST', '/ui/api/set/remove-replace'], ['POST', '/ui/api/removals/1/undo'], ['POST', '/ui/api/hygiene/run?what=sweep']] as const) {
      const r = await app.request(`http://x${path}`, { method }, locked)
      expect([401, 403], path).toContain(r.status)
    }
    expect(removeVideoFromPlaylist).not.toHaveBeenCalled()
    const env = makeEnv()
    const page = await app.request('http://x/ui/removed', {}, env)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('Removed videos')
    const api = await app.request('http://x/ui/api/removals', {}, env)
    expect(await api.json()).toMatchObject({ rows: [], settings: { dryRun: true, dailyRemovals: 40 }, holds: [] })
  })

  it('remove-replace validates input and reports a set without a video', async () => {
    const { app } = await import('../src/index')
    const env = makeEnv()
    const post = (body: unknown) => app.request('http://x/ui/api/set/remove-replace', { method: 'POST', headers: { Origin: 'http://x', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env)
    expect((await post({ slug: 'dj' })).status).toBe(400)
    await seedSet(env, setUrl(1), null)
    expect((await post({ slug: SLUG, url: setUrl(1) })).status).toBe(409)
    expect((await post({ slug: SLUG, url: setUrl(2) })).status).toBe(404)
  })
})

describe('a cleared set loads as "no video", due now (the seam to the recheck and mkvid)', () => {
  it('after the live sweep and after the comparison', async () => {
    const { loadSubState, dueRechecks } = await import('../src/lib/sync')
    const env = makeEnv()
    await seedSub(env)
    await seedSet(env, setUrl(1), 'notc0000001', { pos: 0 })
    await seedSet(env, setUrl(2), 'ownr0000001', { pos: 1 })
    await seedSet(env, setUrl(3), 'keep0000001', { pos: 2 })
    await saveSetFacts(env, facts(setUrl(1), { noFullNotice: true }))
    await runRemovalSweep(env, 'tok', { log, settings: { dryRun: false, dailyRemovals: 40 } })
    listing({ [PL]: ['keep0000001'] })
    expect((await comparePlaylists(env, 'tok', { log }))[0]).toMatchObject({ status: 'held' }) // 1 of 2 missing
    await approveHold(env, PL)
    await comparePlaylists(env, 'tok', { log })

    const state = (await loadSubState(env, SLUG))!
    expect(state.tracklistVideos![setUrl(1)]!.videoId).toBeNull()
    expect(state.tracklistVideos![setUrl(2)]!.videoId).toBeNull()
    expect(state.tracklistVideos![setUrl(3)]!.videoId).toBe('keep0000001')
    expect(dueRechecks(state).sort()).toEqual([setUrl(1), setUrl(2)].sort())
  })
})

describe("mkvid's own videos (W7 interface)", () => {
  it('the sweep never judges a video mkvid uploaded, whatever the row says', async () => {
    const env = makeEnv()
    await seedSub(env)
    await seedSet(env, setUrl(1), 'mkUp0000001')
    await saveSetFacts(env, facts(setUrl(1), { noFullNotice: true }))
    await env.DB.prepare(
      "INSERT INTO mkvid_requests (id, slug, set_url, source, source_url, status, video_id, created_at, updated_at) VALUES ('r1', ?, ?, 'soundcloud', 'u', 'done', 'mkUp0000001', 0, 0)",
    ).bind(SLUG, setUrl(1)).run()
    const r = await runRemovalSweep(env, 'tok', { log, settings: { dryRun: false, dailyRemovals: 40 } })
    expect(r.candidates).toBe(0)
    expect(removeVideoFromPlaylist).not.toHaveBeenCalled()
  })

  it('the comparison does not count a video replaced by delete-and-recreate as an owner removal (and copes without the table)', async () => {
    const env = makeEnv()
    await seedSub(env)
    await seedSet(env, setUrl(1), 'oldR0000001')
    listing({ [PL]: [] })
    // The row W7's retireReplacedVideo writes (migration 0009 schema; the column is video_id on both sides).
    await env.DB.prepare(
      `INSERT INTO mkvid_old_videos (video_id, request_id, slug, set_url, style, replaced_by, state, attempts, next_try_at, created_at, updated_at)
       VALUES (?, 'req-1', 'dj', ?, NULL, 'newR0000001', 'pending', 0, 0, 1, 1)`,
    )
      .bind('oldR0000001', setUrl(1))
      .run()
    expect(await mkvidReplacedIds(env, log)).toEqual(new Set(['oldR0000001']))
    const [r] = await comparePlaylists(env, 'tok', { log })
    expect(r).toMatchObject({ status: 'ok', expected: 0, missing: 0 })
    expect(await removals(env)).toHaveLength(0)
    expect((await row(env, setUrl(1)))!.video_id).toBe('oldR0000001')
    // A database without migration 0009 yet: no table, no throw, nothing skipped.
    await env.DB.exec('DROP TABLE mkvid_old_videos')
    expect(await mkvidReplacedIds(env, log)).toEqual(new Set())
  })
})

describe('held comparison push (cron wiring)', () => {
  // 2026-09-29 is CDT: 15:00Z = 10:00 Chicago, 06:00Z = 01:00.
  const DAY = new Date('2026-09-29T15:00:00Z')
  const NIGHT = new Date('2026-09-29T06:00:00Z')
  async function pushEnv() {
    const env = makeEnv(await vapid())
    await savePushSubscription(env, await pushSubscription('https://push.example/device-1'), 'phone')
    return env
  }
  afterEach(() => vi.useRealTimers())

  it('the payload is a playlist_hold push that opens /ui/removed', () => {
    expect(playlistHoldPayload('Playlist check held', 'x', DAY)).toEqual({ kind: 'playlist_hold', title: 'Playlist check held', body: 'x', url: '/ui/removed', tag: 'playlist-hold', ts: DAY.toISOString() })
  })

  it('pushes a held playlist once, at any hour (no quiet hours)', async () => {
    const sent: string[] = []
    const pushFetch = (async (input: RequestInfo | URL) => (sent.push(String(input)), new Response(null, { status: 201 }))) as unknown as typeof fetch
    const env = await pushEnv()
    await seedFive(env)
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6]) })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NIGHT)
    const notify = playlistHoldNotifier(env, log, pushFetch)
    expect((await comparePlaylists(env, 'tok', { log, notify }))[0]).toMatchObject({ status: 'held' })
    expect(sent).toEqual(['https://push.example/device-1'])
    expect(await listHolds(env)).toMatchObject([{ notified: true }])
    vi.setSystemTime(DAY)
    await comparePlaylists(env, 'tok', { log, notify })
    expect(sent).toHaveLength(1)
  })

  it('without push configured nothing is sent and the hold is not marked notified', async () => {
    const env = makeEnv()
    await seedFive(env)
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6]) })
    await comparePlaylists(env, 'tok', { log, notify: playlistHoldNotifier(env, log) })
    expect(await listHolds(env)).toMatchObject([{ notified: false }])
  })
})

// ─── W6 review fixes ────────────────────────────────────────────────────────

describe('review B1: the sweep never takes out a video another set of the DJ still uses', () => {
  it('two sets of one DJ share a video; one is rejected: nothing is deleted, only that set is cleared, and no ban follows', async () => {
    const env = makeEnv()
    await seedSub(env)
    await seedCombined(env)
    await seedSet(env, setUrl(1), 'shrd0000001', { pos: 0 })
    await seedSet(env, setUrl(2), 'shrd0000001', { pos: 1 })
    await saveSetFacts(env, facts(setUrl(1), { noFullNotice: true }))
    const r = await runRemovalSweep(env, 'tok', { log, settings: { dryRun: false, dailyRemovals: 40 } })
    expect(r).toMatchObject({ rejected: 1, keptShared: 1, deletes: 0 })
    expect(removeVideoFromPlaylist).not.toHaveBeenCalled()
    expect((await row(env, setUrl(1)))!.video_id).toBeNull()
    expect((await row(env, setUrl(2)))!.video_id).toBe('shrd0000001')
    expect((await blockedIds(env, PL)).size).toBe(0)
    // The comparison afterwards sees it present: nothing recorded.
    listing({ [PL]: ['shrd0000001'], [PLC]: ['shrd0000001'] })
    expect((await comparePlaylists(env, 'tok', { log }))[0]).toMatchObject({ status: 'ok', missing: 0, owner: 0 })
    expect(await removals(env)).toHaveLength(0)
  })

  it('a dry run does not report a shared video either', async () => {
    const env = makeEnv()
    await seedSub(env)
    await seedSet(env, setUrl(1), 'shrd0000001', { pos: 0 })
    await seedSet(env, setUrl(2), 'shrd0000001', { pos: 1 })
    await saveSetFacts(env, facts(setUrl(1), { noFullNotice: true }))
    expect(await runRemovalSweep(env, 'tok', { log })).toMatchObject({ dryRun: true, reported: 0, keptShared: 1 })
    expect(await removals(env)).toHaveLength(0)
  })

  it('when every set of the DJ that uses it is rejected, it is removed once and both sets are cleared; never blocklisted', async () => {
    const env = makeEnv()
    await seedSub(env)
    await seedSet(env, setUrl(1), 'shrd0000001', { pos: 0 })
    await seedSet(env, setUrl(2), 'shrd0000001', { pos: 1 })
    await saveSetFacts(env, facts(setUrl(1), { noFullNotice: true }))
    await saveSetFacts(env, facts(setUrl(2), { noFullNotice: true }))
    await runRemovalSweep(env, 'tok', { log, settings: { dryRun: false, dailyRemovals: 40 } })
    expect(vi.mocked(removeVideoFromPlaylist).mock.calls.map((c) => [c[0], c[1]])).toEqual([[PL, 'shrd0000001']])
    expect((await row(env, setUrl(1)))!.video_id).toBeNull()
    expect((await row(env, setUrl(2)))!.video_id).toBeNull()
    expect((await blockedIds(env, PL)).size).toBe(0)
    expect((await confirmedMembership(env, PL)).get('shrd0000001')).toBe('out')
  })
})

describe('review M1: only videos tracked confirmed inserting are expected', () => {
  async function seedNine(env: Env) {
    await seedSub(env)
    for (let i = 1; i <= 9; i++) await seedSet(env, setUrl(i), `vid${String(i).padStart(8, '0')}`, { pos: i })
  }
  async function audit(env: Env, videoId: string, status = 'added') {
    await env.DB.prepare("INSERT INTO playlist_additions (t, ts, status, slug, set_url, video_id, summary, record) VALUES ('2026-01-01T00:00:00Z', 1, ?, ?, ?, ?, '{}', '{}')")
      .bind(status, SLUG, setUrl(10), videoId)
      .run()
  }

  it('a row whose insert never succeeded (no confirmation, no audit) is ignored when it is missing', async () => {
    const env = makeEnv()
    await seedNine(env)
    await seedSet(env, setUrl(10), 'never000001', { pos: 10, confirmed: false })
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6, 7, 8, 9]) })
    expect((await comparePlaylists(env, 'tok', { log }))[0]).toMatchObject({ status: 'ok', expected: 9, missing: 0 })
    expect(await removals(env)).toHaveLength(0)
    expect((await row(env, setUrl(10)))!.video_id).toBe('never000001')
  })

  it('past removals: an audited successful insert that is gone is owner-removed on the first run; "duplicate" and "failed" rows are not evidence', async () => {
    const env = makeEnv()
    await seedNine(env)
    await seedSet(env, setUrl(10), 'past0000001', { pos: 10, confirmed: false })
    await audit(env, 'past0000001', 'added')
    await seedSet(env, setUrl(11), 'dupl0000001', { pos: 11, confirmed: false })
    await audit(env, 'dupl0000001', 'duplicate')
    await seedSet(env, setUrl(12), 'fail0000001', { pos: 12, confirmed: false })
    await audit(env, 'fail0000001', 'failed')
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6, 7, 8, 9]) })
    expect((await comparePlaylists(env, 'tok', { log }))[0]).toMatchObject({ status: 'ok', expected: 10, missing: 1, owner: 1 })
    expect(await isBlocked(env, PL, 'past0000001')).toBe(true)
    expect(await isBlocked(env, PL, 'dupl0000001')).toBe(false)
    expect(await isBlocked(env, PL, 'fail0000001')).toBe(false)
  })

  it('an audited insert that tracked later took out itself (swap, sweep) is not the owner', async () => {
    const env = makeEnv()
    await seedNine(env)
    await seedSet(env, setUrl(10), 'swap0000001', { pos: 10, confirmed: false })
    await audit(env, 'swap0000001', 'added')
    await markOutOfPlaylist(env, PL, 'swap0000001', 'swap')
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6, 7, 8, 9]) })
    expect((await comparePlaylists(env, 'tok', { log }))[0]).toMatchObject({ status: 'ok', missing: 0 })
    expect(await removals(env)).toHaveLength(0)
  })

  it('snapshot: an unconfirmed video seen in a complete listing becomes expected, and its later removal is found from the second run on', async () => {
    const env = makeEnv()
    await seedNine(env)
    await seedSet(env, setUrl(10), 'snap0000001', { pos: 10, confirmed: false })
    listing({ [PL]: [...ids([1, 2, 3, 4, 5, 6, 7, 8, 9]), 'snap0000001'] })
    expect((await comparePlaylists(env, 'tok', { log }))[0]).toMatchObject({ expected: 9, missing: 0 })
    expect((await confirmedMembership(env, PL)).get('snap0000001')).toBe('in')
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6, 7, 8, 9]) })
    expect((await comparePlaylists(env, 'tok', { log }))[0]).toMatchObject({ status: 'ok', expected: 10, missing: 1, owner: 1 })
  })
})

describe('review M2: an approval covers one hold, its exact ids, for 24 hours', () => {
  it('a hold cleared in between takes its approval with it', async () => {
    const env = makeEnv()
    await seedFive(env)
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6]) })
    await comparePlaylists(env, 'tok', { log })
    await approveHold(env, PL)
    // The anomaly clears: nothing missing, hold and approval both gone.
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) })
    await comparePlaylists(env, 'tok', { log })
    expect(await env.SUBS.get(`hygiene:approve:${PL}`)).toBeNull()
    // Later, the same four go missing again: held, not auto-approved.
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6]) })
    expect((await comparePlaylists(env, 'tok', { log }))[0]).toMatchObject({ status: 'held' })
    expect(await removals(env)).toHaveLength(0)
  })

  it('an approval does not cover a different set of missing ids', async () => {
    const env = makeEnv()
    await seedFive(env)
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6]) })
    await comparePlaylists(env, 'tok', { log })
    await approveHold(env, PL)
    listing({ [PL]: ids([1, 2, 3, 4, 5]) }) // now five missing
    expect((await comparePlaylists(env, 'tok', { log }))[0]).toMatchObject({ status: 'held', missing: 5 })
    expect(await removals(env)).toHaveLength(0)
  })

  it('an approval older than 24 hours no longer applies', async () => {
    const env = makeEnv()
    await seedFive(env)
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6]) })
    const t0 = 1_900_000_000
    await comparePlaylists(env, 'tok', { log, now: t0 })
    await approveHold(env, PL, t0)
    expect((await comparePlaylists(env, 'tok', { log, now: t0 + 25 * 3600 }))[0]).toMatchObject({ status: 'held' })
    expect((await comparePlaylists(env, 'tok', { log, now: t0 + 3600 }))[0]).toMatchObject({ status: 'ok', owner: 4 })
  })
})

describe('review M3: guards', () => {
  it('more than 15 missing across the run holds every playlist with a missing video and pushes once', async () => {
    const env = makeEnv()
    const listed: Record<string, string[]> = {}
    for (const dj of ['a', 'b', 'c', 'd']) {
      await seedSub(env, dj, `PL${dj}`)
      const vids = Array.from({ length: 20 }, (_, i) => `${dj}vid${String(i).padStart(7, '0')}`)
      for (const [i, v] of vids.entries()) await seedSet(env, `https://www.1001tracklists.com/tracklist/${dj}${i}/x.html`, v, { slug: dj, pos: i, playlistId: `PL${dj}` })
      listed[`PL${dj}`] = vids.slice(4) // 4 of 20 missing: 20%, not a mass removal on its own
    }
    listing(listed)
    const notify = vi.fn(async () => true)
    const res = await comparePlaylists(env, 'tok', { log, notify })
    expect(res.map((r) => r.status)).toEqual(['held', 'held', 'held', 'held'])
    expect(notify).toHaveBeenCalledTimes(1)
    expect(await removals(env)).toHaveLength(0)
    expect((await listHolds(env)).every((h) => h.runWide && h.notified)).toBe(true)
  })

  it('a listing item without a video id makes the listing incomplete: nothing inferred', async () => {
    const env = makeEnv()
    await seedFive(env)
    vi.mocked(listPlaylistItems).mockResolvedValue({ items: [{ id: 'item-x', snippet: { title: 'Set' } }], nextPageToken: null, pages: 1 } as never)
    expect((await comparePlaylists(env, 'tok', { log }))[0]).toMatchObject({ status: 'incomplete' })
    expect(await removals(env)).toHaveLength(0)
  })

  it('m5: already-blocked videos do not dilute the 30% guard', async () => {
    const env = makeEnv()
    await seedFive(env)
    for (const id of ids([6, 7, 8, 9, 10])) await recordRemoved(env, { playlistId: PL, videoId: id, slug: SLUG, setUrl: null, reason: 'owner' })
    listing({ [PL]: ids([1, 2, 3]) }) // 4, 5 missing of the 5 still expected: 40%
    expect((await comparePlaylists(env, 'tok', { log }))[0]).toMatchObject({ status: 'held', expected: 5, missing: 2 })
  })
})

describe('review minors', () => {
  it('m3: each delete is counted as it happens', async () => {
    const env = makeEnv()
    await seedSub(env)
    await seedCombined(env)
    await seedSet(env, setUrl(1), 'notc0000001')
    await saveSetFacts(env, facts(setUrl(1), { noFullNotice: true }))
    const seen: number[] = []
    vi.mocked(removeVideoFromPlaylist).mockImplementation(async () => {
      seen.push(await sweepDeletesUsed(env))
      return 1
    })
    await runRemovalSweep(env, 'tok', { log, settings: { dryRun: false, dailyRemovals: 40 } })
    expect(seen).toEqual([0, 1]) // the artist delete was on the books before the combined one started
  })

  it('m4: a quota stop on the combined step after the artist delete still clears the set and marks it out, so no owner record follows', async () => {
    const env = makeEnv()
    await seedSub(env)
    await seedCombined(env)
    for (let i = 2; i <= 10; i++) await seedSet(env, setUrl(i), `vid${String(i).padStart(8, '0')}`, { pos: i })
    await seedSet(env, setUrl(1), 'notc0000001')
    await saveSetFacts(env, facts(setUrl(1), { noFullNotice: true }))
    vi.mocked(removeVideoFromPlaylist)
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new YouTubeApiError('playlistItems.delete', 403, 'quotaExceeded', '{}'))
    const r = await runRemovalSweep(env, 'tok', { log, settings: { dryRun: false, dailyRemovals: 40 } })
    expect(r).toMatchObject({ stoppedBy: 'quota' })
    expect((await row(env, setUrl(1)))!.video_id).toBeNull()
    listing({ [PL]: ids([2, 3, 4, 5, 6, 7, 8, 9, 10]), [PLC]: [] })
    expect((await comparePlaylists(env, 'tok', { log }))[0]).toMatchObject({ status: 'ok', missing: 0, owner: 0 })
    expect(await isBlocked(env, PL, 'notc0000001')).toBe(false)
  })

  it('m2: undo is claimed once (double click), re-adds before unblocking, and a failed re-add keeps the block', async () => {
    const env = makeEnv()
    await seedFive(env)
    listing({ [PL]: ids([2, 3, 4, 5, 6, 7, 8, 9, 10]) })
    await comparePlaylists(env, 'tok', { log })
    const [rec] = await removals(env)
    vi.mocked(addVideoToPlaylist).mockRejectedValueOnce(new Error('youtube 500'))
    await expect(undoRemoval(env, 'tok', rec!.id, log)).rejects.toThrow('youtube 500')
    expect(await isBlocked(env, PL, 'vid00000001')).toBe(true)
    expect((await removals(env))[0]!.status).toBe('recorded')
    const both = await Promise.all([undoRemoval(env, 'tok', rec!.id, log), undoRemoval(env, 'tok', rec!.id, log)])
    expect(both.filter((x) => x.ok)).toHaveLength(1)
    expect(vi.mocked(addVideoToPlaylist)).toHaveBeenCalledTimes(2) // the failed try + one real re-add
    expect((await confirmedMembership(env, PL)).get('vid00000001')).toBe('in')
  })

  it('m2: undo restores every set of the DJ that lost the video and supersedes an mkvid request queued since', async () => {
    const env = makeEnv({ MKVID_TOKEN: 'mk' })
    await seedFive(env)
    await seedSet(env, setUrl(11), 'vid00000001', { pos: 11 })
    await saveSetFacts(env, facts(setUrl(11), { videoId: 'vid00000001' }))
    listing({ [PL]: ids([2, 3, 4, 5, 6, 7, 8, 9, 10]) })
    await comparePlaylists(env, 'tok', { log })
    expect((await row(env, setUrl(11)))!.video_id).toBeNull()
    const { enqueueMkvidRequest } = await import('../src/lib/mkvid')
    await enqueueMkvidRequest(env, { slug: SLUG, setUrl: setUrl(11), artistName: 'DJ', setTitle: 'x', setDate: null, source: { kind: 'soundcloud', url: 'https://api.soundcloud.com/tracks/1' }, lastCueSeconds: 1, trackCount: 1, idedCount: 1 })
    const [rec] = await removals(env)
    expect(await undoRemoval(env, 'tok', rec!.id, log)).toEqual({ ok: true, readded: true })
    expect((await row(env, setUrl(1)))!.video_id).toBe('vid00000001')
    expect((await row(env, setUrl(11)))!.video_id).toBe('vid00000001')
    expect((await getMkvidRequestForSet(env, setUrl(11)))!.status).toBe('superseded')
  })

  it('m6: when the video lookup fails, a video the sweep removed before is not taken again', async () => {
    const env = makeEnv()
    await env.DB.prepare("INSERT INTO playlist_removals (at, source, status, slug, set_url, video_id, playlist_id, playlist_kind, reason, detail) VALUES (1, 'sweep', 'removed', ?, ?, 'swpt0000001', ?, 'artist', 'short', NULL)")
      .bind(SLUG, setUrl(1), PL)
      .run()
    vi.mocked(getVideoMeta).mockRejectedValue(new Error('videos.list 500'))
    const r = await pickSetVideo(env, { slug: SLUG, setUrl: setUrl(1), html: '<html></html>', rawVideoId: 'swpt0000001', playlistId: PL, accessToken: 'tok', log })
    expect(r.videoId).toBeNull()
    const other = await pickSetVideo(env, { slug: SLUG, setUrl: setUrl(2), html: '<html></html>', rawVideoId: 'othr0000001', playlistId: PL, accessToken: 'tok', log })
    expect(other.videoId).toBe('othr0000001')
  })

  it('m10: remove-and-replace refuses an mkvid render', async () => {
    const env = makeEnv()
    await seedSub(env)
    await seedSet(env, setUrl(1), 'mkUp0000001', { source: 'mkvid' })
    expect(await removeAndReplace(env, 'tok', { slug: SLUG, setUrl: setUrl(1), log })).toEqual({ ok: false, error: 'mkvid_video' })
    expect(removeVideoFromPlaylist).not.toHaveBeenCalled()
    expect((await row(env, setUrl(1)))!.video_id).toBe('mkUp0000001')
  })
})
