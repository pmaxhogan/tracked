/**
 * Pre-saves (lib/presave.ts, lib/medialinks-all.ts, routes/presave.ts): every
 * save case, every check result, the push, the scheduler item, the set-fetch
 * hook and the routes. tlpool is a stubbed global fetch; D1 and KV are the
 * in-memory fakes with the real migrations.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'
import type { Env } from '../src/types'

vi.mock('../src/lib/track-uploads', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/track-uploads')>('../src/lib/track-uploads')
  return {
    ...actual,
    maybeQueueTrackUpload: vi.fn(async () => ({ queued: false, reason: 'too_young' })),
    supersedeTrackUploadsForPresave: vi.fn(async () => 0),
  }
})
import {
  addPresave,
  failRetryAt,
  rowIdentified,
  deletePresave,
  dismissPresave,
  duePresaves,
  findPresaveRow,
  getPresaveRow,
  listPresaveChecks,
  lookupPresaves,
  markPresaveUploaded,
  presaveOnSetParsed,
  presaveOut,
  PresaveInputError,
  recheckPresave,
  restorePresave,
  type PresaveRow,
} from '../src/lib/presave'
// After lib/presave: track-uploads imports presave, so presave must bind the mock first.
import { maybeQueueTrackUpload, supersedeTrackUploadsForPresave } from '../src/lib/track-uploads'
import { fetchAllMediaLinks, linkNames, normalizeTrackUrl, parseAllMediaLinks, parseTrackPageMediaId, youtubeIdOf } from '../src/lib/medialinks-all'
import { parseTracklist, type PageRow } from '../src/lib/tracklists1001'
import { presaveFoundPayload } from '../src/lib/web-push'
import { rowsOut } from '../src/lib/tracklist-resolve'
import { DEFAULT_APP_SETTINGS, updateAppSettings } from '../src/lib/app-settings'
import { recordSetFetch, runSchedulerTick, TICK_BACKOFF_KEY } from '../src/lib/fetch-scheduler'
import { recordSchedulerTick, listSchedulerTicks } from '../src/lib/tick-history'
import { makeLogger } from '../src/lib/log'
import { app } from '../src/index'

const here = dirname(fileURLToPath(import.meta.url))
const fx = (name: string) => readFileSync(resolve(here, 'fixtures', name), 'utf8')
const POOL = 'https://tlpool.example'
const SET = 'https://www.1001tracklists.com/tracklist/abc123/some-dj-at-somewhere-2026-10-01.html'
const MATRODA = 'https://www.1001tracklists.com/tracklist/l3uw499/matroda-club-space-miami-united-states-2023-08-05.html'
const TRACK_URL = 'https://www.1001tracklists.com/track/1hf79cg5/tobehonest-where-ya-at/index.html'
const log = makeLogger({ test: 'presave' })
const mocked = (f: unknown) => f as ReturnType<typeof vi.fn>

function makeEnv(extra: Partial<Env> = {}): Env {
  return { CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k', TLPOOL_URL: POOL, TLPOOL_TOKEN: 'pt', DEV_BYPASS_CF_ACCESS: '1', ...extra } as Env
}

const ML_FOUND = fx('medialink-909720.json')
/** The same answer without its YouTube link: spotify, apple, beatport, two soundclouds. */
const ML_NO_YT = JSON.stringify({ ...JSON.parse(ML_FOUND), more: [] })

type Call = { url: string; kind: string; priority: string }
/** tlpool stub. `answer(call)` returns html, or `{ refuse: code }`. Records every /fetch body. */
function poolStub(answer: (c: Call) => string | { refuse: string; retryAfterSeconds?: number } | Promise<string | { refuse: string; retryAfterSeconds?: number }>) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `${POOL}/fetch`) {
        const body = JSON.parse(String(init!.body)) as Call
        calls.push({ url: body.url, kind: body.kind, priority: body.priority })
        const a = await answer(body)
        if (typeof a !== 'string') return Response.json({ error: a.refuse, retryAfterSeconds: a.retryAfterSeconds ?? 3600 })
        return Response.json({ status: 200, finalUrl: body.url, html: a, accountId: 'acct-1', exitLabel: 'exit-a', fetchedAt: new Date().toISOString(), bytes: a.length })
      }
      throw new Error(`unexpected fetch ${url}`)
    }),
  )
  return calls
}

function row(p: Partial<PageRow> & { cue?: number | null } = {}): PageRow {
  const cue = p.cue === undefined ? null : p.cue
  return {
    startTime: '',
    startSeconds: cue,
    ownStartSeconds: cue,
    artist: 'ID',
    title: 'ID',
    trackId: null,
    trackUrl: null,
    artworkUrl: null,
    isUnidentified: true,
    idStatus: null,
    isMashupLinked: false,
    anonymous: true,
    label: null,
    mediaId: null,
    ...p,
  } as PageRow
}
const named = (artist: string, title: string, trackId: string, cue: number | null) =>
  row({ artist, title, trackId, mediaId: trackId, cue, anonymous: false, isUnidentified: false, trackUrl: `https://www.1001tracklists.com/track/x${trackId}/${artist.toLowerCase()}/index.html` })

async function cacheSet(env: Env, url: string, rows: PageRow[], fetchedAt = new Date(Date.now() + 1000).toISOString()) {
  const slug = url.match(/\/tracklist\/([^/]+)\//)![1]
  await env.CACHE.put(
    `tl:v4:${slug}`,
    JSON.stringify({ tracks: rows.filter((r) => !r.anonymous), rows, setAppleLink: null, setYoutubeLink: null, setSoundcloudLink: null, fetchedAt, ttlSeconds: 21600, tracklistUrl: url }),
  )
}

/** A set: A (101) at 0, anonymous ID at 120, "Cave - ID" at 240, B (202) at 360. */
const SET_ROWS = () => [named('A', 'One', '101', 0), row({ cue: 120 }), row({ artist: 'Cave', title: 'ID', anonymous: false, isUnidentified: true, trackId: '9999999', mediaId: null, cue: 240 }), named('B', 'Two', '202', 360)]

beforeEach(() => {
  mocked(maybeQueueTrackUpload).mockClear()
  mocked(supersedeTrackUploadsForPresave).mockClear()
})
afterEach(() => vi.unstubAllGlobals())

// ─── medialinks-all ─────────────────────────────────────────────────────────

describe('parseAllMediaLinks (fixture medialink-909720)', () => {
  const links = parseAllMediaLinks(JSON.parse(ML_FOUND))
  it('keeps every entry with canonical URLs and durations', () => {
    expect(linkNames(links)).toEqual(['beatport', 'apple', 'spotify', 'soundcloud', 'youtube'])
    expect(links).toHaveLength(6)
    expect(links.find((l) => l.name === 'spotify')).toEqual({ source: '36', name: 'spotify', url: 'https://open.spotify.com/track/5ly24DpozyrKv1FFDivUHx', playerId: '5ly24DpozyrKv1FFDivUHx', duration: 228 })
    expect(links.find((l) => l.name === 'beatport')!.url).toBe('https://www.beatport.com/track/-/17883763')
    expect(links.find((l) => l.name === 'apple')!.url).toBe('https://music.apple.com/us/album/where-ya-at/1696220774?i=1696221102')
    expect(links.filter((l) => l.name === 'soundcloud').map((l) => l.url)).toEqual(['https://api.soundcloud.com/tracks/2131221114', 'https://api.soundcloud.com/tracks/1570698946'])
    expect(links.find((l) => l.name === 'youtube')).toMatchObject({ source: '13', url: 'https://www.youtube.com/watch?v=h8CtvP1rEy8', duration: null })
    expect(youtubeIdOf(links)).toBe('h8CtvP1rEy8')
  })
  it('unknown codes are kept (named by their player host when known), known codes without a buildable URL are null', () => {
    const out = parseAllMediaLinks({
      success: true,
      data: [
        { source: '77', playerId: 'x', player: '<iframe src="https://bandcamp.com/EmbeddedPlayer/track=1/">' } as never,
        { source: '78', playerId: 'y', player: '<iframe src="http://evil.example/x">' } as never,
        { source: '36', playerId: 'not an id!', player: '<iframe src="https://evil.example/spotify">' } as never,
      ],
      more: [{ source: '13', idLink: 'bad' } as never],
    })
    expect(out.map((l) => [l.name, l.url])).toEqual([
      ['bandcamp', 'https://bandcamp.com/EmbeddedPlayer/track=1/'],
      ['src78', null],
      ['spotify', null],
      ['youtube', null],
    ])
    expect(youtubeIdOf(out)).toBeNull()
    expect(parseAllMediaLinks({ success: false })).toEqual([])
  })
})

describe('track page medialink id', () => {
  it('prefers a mediaRow data-trackid, never an idObject 8 (tracklist position)', () => {
    const html = `<i onclick="new MediaSubmitter(this, 'add_media', null, { idObject: 8, idItem: 9381908 } );"></i><div class="iRow grow mediaRow" data-trackid="909720"></div>`
    expect(parseTrackPageMediaId(html)).toEqual({ id: '909720', via: 'mediaRow' })
    expect(parseTrackPageMediaId(`<x onclick="f({ idObject: 5, idItem: 123 })">`)).toEqual({ id: '123', via: 'idObject5' })
    expect(parseTrackPageMediaId(`$.get('/ajax/get_medialink.php?idObject=5&amp;idItem=456')`)).toEqual({ id: '456', via: 'get_medialink' })
    expect(parseTrackPageMediaId(`{ idObject: 8, idItem: 9381908 }`)).toBeNull()
  })
  it('normalizes track URLs', () => {
    expect(normalizeTrackUrl('www.1001tracklists.com/track/1hf79cg5/tobehonest-where-ya-at/index.html?x=1')).toBe(TRACK_URL)
    expect(normalizeTrackUrl('/track/1hf79cg5/tobehonest-where-ya-at/')).toBe(TRACK_URL)
    expect(normalizeTrackUrl('https://example.com/track/1')).toBeNull()
  })
})

describe('fetchAllMediaLinks', () => {
  it('is uncached, writes the classic links through to ml:v1, and tells a refusal apart from no links', async () => {
    const env = makeEnv()
    await env.CACHE.put('ml:v1:909720', JSON.stringify({ appleLink: null, youtubeLink: null, soundcloudLink: null }))
    const calls = poolStub(() => ML_FOUND)
    const r = await fetchAllMediaLinks(env, '909720', { priority: 'recheck', log })
    expect(r.ok).toBe(true)
    expect(calls).toEqual([{ url: 'https://www.1001tracklists.com/ajax/get_medialink.php?idObject=5&idItem=909720', kind: 'medialink', priority: 'recheck' }])
    expect(await env.CACHE.get('ml:v1:909720', 'json')).toMatchObject({ youtubeLink: 'https://www.youtube.com/watch?v=h8CtvP1rEy8' })
    poolStub(() => ({ refuse: 'budget_exhausted' }))
    const refused = await fetchAllMediaLinks(env, '909720', { log })
    expect(refused).toMatchObject({ ok: false, poolCode: 'budget_exhausted', retryAfterSeconds: 3600 })
    expect(refused.ok === false && refused.poolError).toBeTruthy()
  })
})

// ─── saving ─────────────────────────────────────────────────────────────────

describe('addPresave', () => {
  it('a numeric track id: links stage, checked at once; with a YouTube link it is found, uploads superseded', async () => {
    const env = makeEnv()
    const calls = poolStub(() => ML_FOUND)
    const r = await addPresave(env, { trackId: '909720', artist: 'TOBEHONEST', title: 'Where Ya At' }, 'tasker', { log })
    expect(r.created).toBe(true)
    expect(r.presave).toMatchObject({ stage: 'found', track_id: '909720', youtube_video_id: 'h8CtvP1rEy8', next_check_at: null, check_count: 1, link_count: 6, duration_seconds: 339 })
    expect(r.presave.link_sources).toBe(',beatport,apple,spotify,soundcloud,youtube,')
    expect(r.message).toBe('Already on YouTube: TOBEHONEST – Where Ya At')
    expect(calls.map((c) => c.priority)).toEqual(['phone'])
    expect(supersedeTrackUploadsForPresave).toHaveBeenCalledWith(env, r.presave.id, expect.any(String))
    // No VAPID keys: no push, so notified_at stays null.
    expect(r.presave.notified_at).toBeNull()
    const checks = await listPresaveChecks(env, r.presave.id)
    expect(checks.map((c) => [c.trigger, c.result])).toEqual([['add', 'found'], ['add', 'added']])
    const out = presaveOut(r.presave, DEFAULT_APP_SETTINGS)
    expect(out).toMatchObject({ youtubeMusicUrl: 'https://music.youtube.com/watch?v=h8CtvP1rEy8', linkSources: ['beatport', 'apple', 'spotify', 'soundcloud', 'youtube'], uploadEligibleAt: r.presave.created_at + 5 * 86400_000 })
  })

  it('no YouTube link: no_youtube, links stored, next check about 12 h out, handed to track uploads', async () => {
    const env = makeEnv()
    poolStub(() => ML_NO_YT)
    const now = Date.now()
    const r = await addPresave(env, { trackId: 909720 }, 'ui', { log, now, random: () => 0.5 })
    expect(r.presave).toMatchObject({ stage: 'links', last_result: 'no_youtube', link_count: 5, youtube_video_id: null, next_check_at: now + 12 * 3600_000 })
    expect(r.message).toMatch(/^Pre-saved: .*\(watching for a YouTube link\)$/)
    expect(maybeQueueTrackUpload).toHaveBeenCalledTimes(1)
    expect(mocked(maybeQueueTrackUpload).mock.calls[0]![1]).toMatchObject({ id: r.presave.id, stage: 'links' })
  })

  it('a track URL only: the medialink id comes from the track page (one phone fetch)', async () => {
    const env = makeEnv()
    const calls = poolStub((c) => (c.kind === 'medialink' ? ML_NO_YT : `<title>TOBEHONEST - Where Ya At | 1001Tracklists</title><div class="iRow grow mediaRow" data-trackid="909720"></div>`))
    const r = await addPresave(env, { trackUrl: TRACK_URL }, 'tasker', { log })
    expect(r.presave).toMatchObject({ track_id: '909720', track_url: TRACK_URL, stage: 'links', artist: 'TOBEHONEST', title: 'Where Ya At' })
    expect(calls.map((c) => `${c.kind}:${c.priority}`)).toEqual(['set:phone', 'medialink:phone'])
  })

  it('a track URL whose page names no id: identify stage keyed by the URL, rechecked from the track page', async () => {
    const env = makeEnv()
    let page = '<html>nothing</html>'
    poolStub((c) => (c.kind === 'medialink' ? ML_FOUND : page))
    const r = await addPresave(env, { trackUrl: TRACK_URL }, 'tasker', { log })
    expect(r.presave).toMatchObject({ stage: 'identify', track_id: null, track_url: TRACK_URL, last_result: 'still_id' })
    page = '<div class="mediaRow" data-trackid="909720"></div>'
    const again = await recheckPresave(env, r.presave.id, 'manual', { log })
    expect(again!.presave).toMatchObject({ stage: 'found', track_id: '909720' })
    expect((await listPresaveChecks(env, r.presave.id)).map((c) => c.result).slice(0, 2)).toEqual(['found', 'identified'])
  })

  it('an anonymous "ID - ID" row from a set (cached list warm): identify stage with cue and anchors, no fetch at all', async () => {
    const env = makeEnv()
    await cacheSet(env, SET, SET_ROWS())
    const calls = poolStub(() => '')
    // The anonymous row's data-id is a page position: sent as trackId, it is ignored.
    const r = await addPresave(env, { setUrl: SET, rowIndex: 1, trackId: null, artist: 'ID', title: 'ID' }, 'tasker', { log })
    expect(r.presave).toMatchObject({ stage: 'identify', track_id: null, row_index: 1, cue_seconds: 120, prev_track_id: '101', next_track_id: '202', artist: null, title: null, last_result: 'still_id' })
    expect(r.message).toBe('Pre-saved the unidentified track at 2:00 in some dj at somewhere 2026 10 01 (watching for it to be identified)')
    expect(calls).toEqual([])
  })

  it('an "Artist - ID" row by cue only (Tasker sends no rowIndex): matched by cue', async () => {
    const env = makeEnv()
    await cacheSet(env, SET, SET_ROWS())
    poolStub(() => '')
    const r = await addPresave(env, { setUrl: SET, cueSeconds: 241, artist: 'Cave', title: 'ID' }, 'tasker', { log })
    expect(r.presave).toMatchObject({ stage: 'identify', row_index: 2, cue_seconds: 241, artist: 'Cave', title: null })
    expect(r.message).toMatch(/^Pre-saved: Cave – ID/)
  })

  it('an identified row of a set: saved by its track id', async () => {
    const env = makeEnv()
    await cacheSet(env, SET, SET_ROWS())
    poolStub(() => ML_NO_YT)
    const r = await addPresave(env, { setUrl: SET, rowIndex: 3 }, 'ui', { log })
    expect(r.presave).toMatchObject({ stage: 'links', track_id: '202', artist: 'B', title: 'Two', row_index: 3, cue_seconds: 360 })
  })

  it('saving again returns the same one (created false); a dismissed one is restored', async () => {
    const env = makeEnv()
    poolStub(() => ML_NO_YT)
    const a = await addPresave(env, { trackId: '909720' }, 'ui', { log })
    const b = await addPresave(env, { trackId: '909720' }, 'tasker', { log, check: false })
    expect(b.created).toBe(false)
    expect(b.presave.id).toBe(a.presave.id)
    expect(b.message).toMatch(/^Already pre-saved: /)
    await dismissPresave(env, a.presave.id)
    const c = await addPresave(env, { trackId: '909720' }, 'tasker', { log, check: false })
    expect(c).toMatchObject({ created: false, restored: true })
    expect(c.presave).toMatchObject({ stage: 'links', dismissed_at: null })
    expect(c.presave.next_check_at).not.toBeNull()
  })

  it('bad input throws PresaveInputError', async () => {
    const env = makeEnv()
    await expect(addPresave(env, {}, 'api')).rejects.toBeInstanceOf(PresaveInputError)
    await expect(addPresave(env, { trackId: 'abc' }, 'api')).rejects.toBeInstanceOf(PresaveInputError)
    await expect(addPresave(env, { setUrl: 'https://example.com/x', rowIndex: 1 }, 'api')).rejects.toBeInstanceOf(PresaveInputError)
  })

  it('a pool refusal on the immediate check never fails the save', async () => {
    const env = makeEnv()
    poolStub(() => ({ refuse: 'budget_exhausted' }))
    const r = await addPresave(env, { trackId: '909720' }, 'tasker', { log })
    expect(r.created).toBe(true)
    expect(r.refused).toMatchObject({ poolCode: 'budget_exhausted' })
    expect(r.presave).toMatchObject({ stage: 'links', last_result: 'pool_refused', fail_count: 1 })
    expect(r.presave.next_check_at! - Date.now()).toBeGreaterThan(55 * 60_000)
  })
})

// ─── checking ───────────────────────────────────────────────────────────────

describe('recheckPresave, identify stage', () => {
  async function savedAnon(env: Env) {
    await cacheSet(env, SET, SET_ROWS(), new Date(Date.now() - 60_000).toISOString())
    poolStub(() => '')
    return (await addPresave(env, { setUrl: SET, rowIndex: 1 }, 'ui', { log })).presave
  }

  it('identified on a newer cached list: takes the row and checks its links in the same call', async () => {
    const env = makeEnv()
    const p = await savedAnon(env)
    const rows = SET_ROWS()
    rows[1] = named('C', 'Three', '303', 120)
    await cacheSet(env, SET, rows)
    poolStub(() => ML_FOUND)
    const r = await recheckPresave(env, p.id, 'manual', { log })
    expect(r!.presave).toMatchObject({ stage: 'found', track_id: '303', artist: 'C', title: 'Three' })
    expect(r!.presave.identified_at).not.toBeNull()
    expect((await listPresaveChecks(env, p.id)).map((c) => `${c.trigger}:${c.result}`).slice(0, 2)).toEqual(['manual:found', 'manual:identified'])
  })

  it('rows shifted: the cue finds it; no cue match: the anchors', () => {
    const p = { track_url: null, cue_seconds: 120, prev_track_id: '101', next_track_id: '202', row_index: 1 }
    const shifted = [row({ cue: 0 }), ...SET_ROWS()]
    expect(findPresaveRow(shifted, p)).toEqual({ index: 2, how: 'cue' })
    const recued = SET_ROWS()
    recued[1] = row({ cue: 130 })
    expect(findPresaveRow([row(), ...recued], p)).toEqual({ index: 2, how: 'prev_anchor' })
    expect(findPresaveRow([], p)).toBeNull()
  })

  it('still ID on a fresh fetch (cache older than the last check): still_id; the page is fetched and cached', async () => {
    const env = makeEnv()
    const p = await savedAnon(env)
    const calls = poolStub(() => fx('tracklist-matroda.html'))
    // The cached list is older than the save's check, so the set page is fetched (the matroda page stands in).
    await env.DB.prepare('UPDATE presaves SET set_url = ? WHERE id = ?').bind(MATRODA, p.id).run()
    const scraped = parseTracklist(MATRODA, fx('tracklist-matroda.html'))
    const anonIdx = scraped.rows.findIndex((r) => r.anonymous || r.isUnidentified)
    const target = anonIdx >= 0 ? anonIdx : 0
    await env.DB.prepare('UPDATE presaves SET cue_seconds = ?, row_index = ?, prev_track_id = NULL, next_track_id = NULL WHERE id = ?')
      .bind(scraped.rows[target]!.ownStartSeconds ?? scraped.rows[target]!.startSeconds, target, p.id)
      .run()
    const r = await recheckPresave(env, p.id, 'scheduled', { log })
    expect(calls[0]).toMatchObject({ kind: 'set', priority: 'recheck', url: MATRODA })
    if (anonIdx >= 0) expect(r!.presave.last_result).toBe('still_id')
    else expect(['found', 'no_youtube']).toContain(r!.presave.last_result)
    expect(await env.CACHE.get('tl:v4:l3uw499')).not.toBeNull()
  })

  it('row missing: row_missing', async () => {
    const env = makeEnv()
    const p = await savedAnon(env)
    await cacheSet(env, SET, [named('Z', 'Zed', '909', 9999)])
    const r = await recheckPresave(env, p.id, 'manual', { log })
    expect(r!.presave.last_result).toBe('row_missing')
  })

  it('a pool refusal is recorded and returned as a refusal', async () => {
    const env = makeEnv()
    const p = await savedAnon(env)
    await env.CACHE.delete('tl:v4:abc123')
    poolStub(() => ({ refuse: 'challenge_pending', retryAfterSeconds: 600 }))
    const r = await recheckPresave(env, p.id, 'scheduled', { log })
    expect(r!.refused).toMatchObject({ poolCode: 'challenge_pending', retryAfterSeconds: 600 })
    expect(r!.presave).toMatchObject({ last_result: 'pool_refused', fail_count: 1, stage: 'identify' })
  })

  it('identified as a track already pre-saved: this one is dismissed and points at it', async () => {
    const env = makeEnv()
    poolStub(() => ML_NO_YT)
    const first = await addPresave(env, { trackId: '303' }, 'ui', { log })
    const p = await savedAnon(env)
    const rows = SET_ROWS()
    rows[1] = named('C', 'Three', '303', 120)
    await cacheSet(env, SET, rows)
    const r = await recheckPresave(env, p.id, 'manual', { log })
    expect(r!.presave.stage).toBe('dismissed')
    expect(JSON.parse(r!.check!.detail!)).toMatchObject({ duplicateOf: first.presave.id })
  })

  it('giveUpDays dismisses a long-watched track (gave_up)', async () => {
    const env = makeEnv()
    await env.SUBS.put('app:settings', JSON.stringify({ presave: { giveUpDays: 1 } }))
    poolStub(() => ML_NO_YT)
    const r = await addPresave(env, { trackId: '1' }, 'ui', { log, check: false })
    await env.DB.prepare('UPDATE presaves SET created_at = ? WHERE id = ?').bind(Date.now() - 2 * 86400_000, r.presave.id).run()
    const c = await recheckPresave(env, r.presave.id, 'scheduled', { log })
    expect(c!.presave).toMatchObject({ stage: 'dismissed', last_result: 'gave_up', next_check_at: null })
  })
})

describe('push payload', () => {
  it('presave_found opens the YouTube Music version, one tag per presave', () => {
    const p = presaveFoundPayload({ id: 7, artist: 'TOBEHONEST', title: 'Where Ya At', videoId: 'h8CtvP1rEy8' })
    expect(p).toMatchObject({ kind: 'presave_found', title: 'Pre-saved track is on YouTube', body: 'TOBEHONEST – Where Ya At', url: 'https://music.youtube.com/watch?v=h8CtvP1rEy8', tag: 'tracked-presave-7' })
    expect(presaveFoundPayload({ id: 1, artist: 'ID', title: 'ID', videoId: 'x' }).body).toBe('A pre-saved track')
  })
})

describe('owner actions and lookup', () => {
  it('dismiss, restore, delete; lookup by track id and by set row; markPresaveUploaded', async () => {
    const env = makeEnv()
    await cacheSet(env, SET, SET_ROWS())
    poolStub(() => ML_NO_YT)
    const a = (await addPresave(env, { trackId: '909720' }, 'ui', { log })).presave
    const b = (await addPresave(env, { setUrl: SET, rowIndex: 1 }, 'ui', { log })).presave
    expect(await lookupPresaves(env, { trackIds: ['909720', '5'], setUrl: SET })).toEqual({ byTrackId: { '909720': { id: a.id, stage: 'links' } }, byRow: { '1': { id: b.id, stage: 'identify' } } })
    expect((await dismissPresave(env, a.id))!).toMatchObject({ stage: 'dismissed', next_check_at: null })
    expect(supersedeTrackUploadsForPresave).toHaveBeenCalledWith(env, a.id, 'dismissed')
    expect((await restorePresave(env, a.id))!.stage).toBe('links')
    const up = await markPresaveUploaded(env, a.id, 'vidvidvid01', { uploadId: 3 })
    expect(up).toMatchObject({ stage: 'uploaded', youtube_video_id: 'vidvidvid01', next_check_at: null })
    expect((await listPresaveChecks(env, a.id))[0]).toMatchObject({ trigger: 'upload', result: 'uploaded', youtube_video_id: 'vidvidvid01' })
    expect(await deletePresave(env, b.id)).toBe(true)
    expect(await getPresaveRow(env, b.id)).toBeNull()
    expect(await listPresaveChecks(env, b.id)).toEqual([])
  })
})

// ─── the set-fetch hook ─────────────────────────────────────────────────────

describe('set-fetch hook', () => {
  it('a parsed set page identifies the pre-saved rows of that set (due for links now), skips decoys, never throws', async () => {
    const env = makeEnv()
    await cacheSet(env, SET, SET_ROWS())
    const calls = poolStub(() => '')
    const p = (await addPresave(env, { setUrl: SET, rowIndex: 1 }, 'ui', { log })).presave
    const rows = SET_ROWS()
    rows[1] = named('C', 'Three', '303', 120)
    expect(await presaveOnSetParsed(env, SET, { rows, decoy: { suspected: true } }, log)).toBe(0)
    const before = Date.now()
    await recordSetFetch(env, { setUrl: SET, html: '', parsed: { slug: 'abc123', setAppleLink: null, setYoutubeLink: null, setSoundcloudLink: null, tracks: rows.filter((r) => !r.anonymous), rows, decoy: { named: 0, mismatched: 0, nearMismatched: 0, suspected: false } }, videoId: null, log })
    const after = (await getPresaveRow(env, p.id))!
    expect(after).toMatchObject({ stage: 'links', track_id: '303', last_result: 'identified' })
    expect(after.next_check_at!).toBeGreaterThanOrEqual(before - 1000)
    expect(after.next_check_at!).toBeLessThanOrEqual(Date.now())
    expect((await listPresaveChecks(env, p.id))[0]!.trigger).toBe('set_fetch')
    expect(calls).toEqual([]) // nothing fetched by the hook
    // No identify rows for a set: one query, nothing else; a broken env never throws.
    expect(await presaveOnSetParsed(env, 'https://www.1001tracklists.com/tracklist/zzz/x.html', { rows }, log)).toBe(0)
    expect(await presaveOnSetParsed({ ...env, DB: { prepare: () => { throw new Error('boom') } } } as unknown as Env, SET, { rows }, log)).toBe(0)
  })

  it('useSetFetches off: the hook does nothing', async () => {
    const env = makeEnv()
    await env.SUBS.put('app:settings', JSON.stringify({ presave: { useSetFetches: false } }))
    await cacheSet(env, SET, SET_ROWS())
    poolStub(() => '')
    const p = (await addPresave(env, { setUrl: SET, rowIndex: 1 }, 'ui', { log })).presave
    const rows = SET_ROWS()
    rows[1] = named('C', 'Three', '303', 120)
    await presaveOnSetParsed(env, SET, { rows }, log)
    expect((await getPresaveRow(env, p.id))!.stage).toBe('identify')
  })
})

// ─── the scheduler ──────────────────────────────────────────────────────────

describe('scheduler item', () => {
  async function due(env: Env) {
    poolStub(() => ML_NO_YT)
    const p = (await addPresave(env, { trackId: '909720' }, 'ui', { log, check: false })).presave
    await env.SUBS.put('subs:migrated', '{}')
    return p
  }

  it('a due presave runs on a zero-draw tick, at the settings priority, and lands in the tick history', async () => {
    const env = makeEnv()
    const p = await due(env)
    expect((await duePresaves(env, Date.now(), 5)).map((x) => x.id)).toEqual([p.id])
    const calls = poolStub(() => ML_FOUND)
    const r = await runSchedulerTick(env, { log, random: () => 0 })
    expect(r).toMatchObject({ skipped: 'zero_draw', drawn: 0 })
    expect(r.items).toEqual([{ item: { cls: 'recheck', kind: 'presave', slug: '', url: '', presaveId: p.id }, outcome: 'ok' }])
    expect(calls).toEqual([expect.objectContaining({ kind: 'medialink', priority: 'recheck' })])
    expect((await getPresaveRow(env, p.id))!.stage).toBe('found')
    await recordSchedulerTick(env, Math.floor(Date.now() / 1000), 5, r)
    expect((await listSchedulerTicks(env))[0]!.items).toEqual([{ kind: 'presave', cls: 'recheck', slug: '', outcome: 'ok' }])
  })

  it('a pool refusal stops the tick (backoff) and is recorded on the presave', async () => {
    const env = makeEnv()
    const p = await due(env)
    poolStub(() => ({ refuse: 'budget_exhausted', retryAfterSeconds: 1800 }))
    const r = await runSchedulerTick(env, { log, random: () => 0 })
    expect(r.items[0]).toMatchObject({ outcome: 'stopped' })
    expect(r.stoppedBy).toBeTruthy()
    expect(Number(await env.CACHE.get(TICK_BACKOFF_KEY))).toBeGreaterThan(Math.floor(Date.now() / 1000))
    expect((await getPresaveRow(env, p.id))!).toMatchObject({ last_result: 'pool_refused', fail_count: 1 })
  })

  it('presave.enabled off or maxPerTick 0: nothing is picked', async () => {
    const env = makeEnv()
    await due(env)
    await env.SUBS.put('app:settings', JSON.stringify({ presave: { enabled: false } }))
    expect(await duePresaves(env, Date.now(), 5)).toEqual([])
    const env2 = makeEnv()
    await due(env2)
    await env2.SUBS.put('app:settings', JSON.stringify({ presave: { maxPerTick: 0 } }))
    expect(await duePresaves(env2, Date.now(), 5)).toEqual([])
  })

  it('a paused tick does not touch presaves', async () => {
    const env = makeEnv()
    const p = await due(env)
    await env.CACHE.put(TICK_BACKOFF_KEY, String(Math.floor(Date.now() / 1000) + 600))
    const calls = poolStub(() => ML_FOUND)
    const r = await runSchedulerTick(env, { log, random: () => 0 })
    expect(r.skipped).toBe('backoff')
    expect(calls).toEqual([])
    expect((await getPresaveRow(env, p.id))!.stage).toBe('links')
  })
})

// ─── routes ─────────────────────────────────────────────────────────────────

describe('routes', () => {
  const bearer = (env: Env, method: string, path: string, body?: unknown, token = 't') =>
    app.request(`http://x${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, env)
  const ui = (env: Env, method: string, path: string, body?: unknown) =>
    app.request(`http://x${path}`, { method, headers: { Origin: 'http://x', 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, env)

  it('POST /presave (Tasker bearer): 401 without the token, 200 with ok/created/presave/message, 400 on bad input', async () => {
    const env = makeEnv()
    poolStub(() => ML_NO_YT)
    expect((await bearer(env, 'POST', '/presave', { trackId: '909720' }, 'wrong')).status).toBe(401)
    const res = await bearer(env, 'POST', '/presave', { trackId: '909720', artist: 'TOBEHONEST', title: 'Where Ya At' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; created: boolean; presave: { stage: string; trackId: string; links: unknown[]; source: string }; message: string }
    expect(body).toMatchObject({ ok: true, created: true, message: 'Pre-saved: TOBEHONEST – Where Ya At (watching for a YouTube link)' })
    expect(body.presave).toMatchObject({ stage: 'links', trackId: '909720', source: 'tasker' })
    expect(body.presave.links).toHaveLength(5)
    const bad = await bearer(env, 'POST', '/presave', { artist: 'x' })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ error: 'invalid_request', message: expect.any(String) })
    const badUrl = await bearer(env, 'POST', '/presave', { tracklistUrl: 'https://example.com/x', rowIndex: 2 })
    expect(badUrl.status).toBe(400)
    const status = await bearer(env, 'GET', '/presave/status?trackId=909720')
    expect(((await status.json()) as { presave: { trackId: string } }).presave.trackId).toBe('909720')
    expect(await (await bearer(env, 'GET', '/presave/status?trackId=1')).json()).toEqual({ presave: null })
    expect((await bearer(env, 'GET', '/presave/status?trackId=1', undefined, 'nope')).status).toBe(401)
  })

  it('POST /presave accepts tracklistUrl + cueSeconds only', async () => {
    const env = makeEnv()
    await cacheSet(env, SET, SET_ROWS())
    poolStub(() => '')
    const res = await bearer(env, 'POST', '/presave', { tracklistUrl: SET, cueSeconds: 120, artist: 'ID', title: 'ID' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, presave: { stage: 'identify', rowIndex: 1 }, message: expect.stringMatching(/^Pre-saved the unidentified track at 2:00/) })
  })

  it('the UI API: table list with counts, detail, checks table, lookup, recheck (503 on a refusal), dismiss, restore, delete', async () => {
    const env = makeEnv()
    poolStub(() => ML_NO_YT)
    const add = await ui(env, 'POST', '/ui/api/presaves', { trackId: '909720', artist: 'TOBEHONEST', title: 'Where Ya At' })
    expect(add.status).toBe(200)
    const id = ((await add.json()) as { presave: { id: number; source: string } }).presave.id
    await ui(env, 'POST', '/ui/api/presaves', { trackId: '42', artist: 'Other', title: 'Song', check: false })

    const list = (await (await ui(env, 'GET', '/ui/api/presaves?q=tobe')).json()) as { rows: Array<{ id: number }>; total: number; counts: Record<string, number>; sort: unknown }
    expect(list.total).toBe(1)
    expect(list.rows[0]!.id).toBe(id)
    expect(list.counts).toEqual({ identify: 0, links: 2, found: 0, uploaded: 0, dismissed: 0 })
    expect(list.sort).toEqual([{ col: 'createdAt', dir: 'desc' }])
    const bySource = (await (await ui(env, 'GET', '/ui/api/presaves?f.linkSources=in:spotify')).json()) as { total: number }
    expect(bySource.total).toBe(1)
    const none = (await (await ui(env, 'GET', '/ui/api/presaves?f.linkSources=in:none')).json()) as { total: number }
    expect(none.total).toBe(1)
    expect((await ui(env, 'GET', '/ui/api/presaves?sort=nope')).status).toBe(400)

    const detail = (await (await ui(env, 'GET', `/ui/api/presaves/${id}`)).json()) as { presave: { id: number }; upload: unknown }
    expect(detail).toMatchObject({ presave: { id }, upload: null })
    expect((await ui(env, 'GET', '/ui/api/presaves/999')).status).toBe(404)
    const checks = (await (await ui(env, 'GET', `/ui/api/presaves/${id}/checks`)).json()) as { rows: Array<{ result: string; trigger: string }>; total: number }
    expect(checks.rows.map((c) => c.result)).toEqual(['no_youtube', 'added'])
    expect(((await (await ui(env, 'GET', `/ui/api/presaves/${id}/checks?f.result=in:added`)).json()) as { total: number }).total).toBe(1)

    const lookup = await (await ui(env, 'POST', '/ui/api/presaves/lookup', { trackIds: ['909720', '42', '1'] })).json()
    expect(lookup).toEqual({ byTrackId: { '909720': { id, stage: 'links' }, '42': { id: expect.any(Number), stage: 'links' } }, byRow: {} })

    poolStub(() => ML_FOUND)
    const re = await ui(env, 'POST', `/ui/api/presaves/${id}/recheck`)
    expect(re.status).toBe(200)
    expect(await re.json()).toMatchObject({ presave: { stage: 'found', youtubeMusicUrl: 'https://music.youtube.com/watch?v=h8CtvP1rEy8' }, check: { trigger: 'manual', result: 'found' } })

    const other = ((await (await ui(env, 'GET', '/ui/api/presaves?q=other')).json()) as { rows: Array<{ id: number }> }).rows[0]!.id
    const calls = poolStub(() => ({ refuse: 'budget_exhausted' }))
    const busy = await ui(env, 'POST', `/ui/api/presaves/${other}/recheck`)
    expect(busy.status).toBe(503)
    expect(await busy.json()).toMatchObject({ error: 'pool_busy', message: expect.any(String), check: { result: 'pool_refused' } })
    expect(calls[0]!.priority).toBe('phone')

    expect(await (await ui(env, 'POST', `/ui/api/presaves/${other}/dismiss`)).json()).toMatchObject({ presave: { stage: 'dismissed' } })
    expect(await (await ui(env, 'POST', `/ui/api/presaves/${other}/restore`)).json()).toMatchObject({ presave: { stage: 'links' } })
    expect(await (await ui(env, 'DELETE', `/ui/api/presaves/${other}`)).json()).toEqual({ deleted: true })
    expect((await ui(env, 'DELETE', `/ui/api/presaves/${other}`)).status).toBe(404)
  })

  it('the UI API is behind Cloudflare Access', async () => {
    const env = makeEnv({ DEV_BYPASS_CF_ACCESS: undefined, CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CF_ACCESS_AUD: 'aud', CF_ACCESS_ALLOWED_EMAILS: 'a@example.com' } as Partial<Env>)
    for (const [m, p] of [['GET', '/ui/api/presaves'], ['POST', '/ui/api/presaves'], ['POST', '/ui/api/presaves/lookup'], ['POST', '/ui/api/presaves/1/recheck'], ['DELETE', '/ui/api/presaves/1']] as const) {
      expect([401, 403]).toContain((await ui(env, m, p, m === 'GET' ? undefined : {})).status)
    }
  })
})

// ─── rows reach the UI ──────────────────────────────────────────────────────

describe('/ui/api/tracklist rows', () => {
  it('every page row with its index; each track points at its row', async () => {
    const env = makeEnv()
    poolStub(() => fx('tracklist-matroda.html'))
    const res = await app.request('http://x/ui/api/tracklist', { method: 'POST', headers: { Origin: 'http://x', 'Content-Type': 'application/json' }, body: JSON.stringify({ url: MATRODA }) }, env)
    const body = (await res.json()) as { tracks: Array<{ title: string; rowIndex: number | null; trackId: string | null }>; rows: Array<{ rowIndex: number; title: string; anonymous: boolean; trackId: string | null; cueSeconds: number | null }> }
    expect(body.rows.length).toBeGreaterThanOrEqual(body.tracks.length)
    expect(body.rows.map((r) => r.rowIndex)).toEqual(body.rows.map((_, i) => i))
    for (const t of body.tracks) expect(body.rows[t.rowIndex!]!.title).toBe(t.title)
    expect(body.rows.filter((r) => r.anonymous).every((r) => r.trackId === null)).toBe(true)
    expect(body.rows[1]).toMatchObject({ trackId: '909720', cueSeconds: 150 })
    // Row 0 has no media links: its data-id is a page position and never reaches the UI as a track id.
    expect(body.rows[0]).toMatchObject({ title: 'Nobody (Matroda Edit)', trackId: null, anonymous: false })
  })

  it('pre-saving a named row with no media id: identify stage, no medialink lookup of the position id', async () => {
    const env = makeEnv()
    const scraped = parseTracklist(MATRODA, fx('tracklist-matroda.html'))
    expect(scraped.rows[0]).toMatchObject({ trackId: '9381908', mediaId: null })
    await cacheSet(env, MATRODA, scraped.rows)
    const calls = poolStub(() => '')
    const r = await addPresave(env, { setUrl: MATRODA, rowIndex: 0, trackId: '9381908' }, 'ui', { log })
    expect(r.presave).toMatchObject({ stage: 'identify', track_id: null, row_index: 0, artist: 'Igor Zanga', title: 'Nobody (Matroda Edit)' })
    expect(r.presave.cue_seconds).toBe(0)
    expect(calls.filter((c) => c.kind === 'medialink')).toEqual([])
    // The row gains a media id: identified (matched by its cue) on the next set fetch.
    const rows = scraped.rows.map((x, i) => (i === 0 ? { ...x, trackId: '777', mediaId: '777' } : x))
    await presaveOnSetParsed(env, MATRODA, { rows }, log)
    expect((await getPresaveRow(env, r.presave.id))!).toMatchObject({ stage: 'links', track_id: '777' })
  })
})

// ─── review fixes ───────────────────────────────────────────────────────────

describe('review fixes', () => {
  /** A named row as a list cached before `mediaId` existed stores it: no mediaId key at all. */
  const oldRow = (r: PageRow): PageRow => {
    const { mediaId: _m, ...rest } = r
    return rest as PageRow
  }
  /** A "w/" row with no printed time: it shares its base row's cue (startSeconds) and has none of its own. */
  const wRow = (base: number, p: Partial<PageRow> = {}) => row({ startSeconds: base, ownStartSeconds: null, isMashupLinked: true, ...p })

  it('a "w/" ID row with no cue of its own is never mistaken for its base row (cue tie)', async () => {
    // A (101) at 0, base B (202) at 240, "w/" ID row sharing 240, C (303) at 480.
    const rows = [named('A', 'One', '101', 0), named('B', 'Two', '202', 240), wRow(240), named('C', 'Three', '303', 480)]
    // Saved with B as its previous anchor: B can never be the saved row, whatever its cue.
    expect(findPresaveRow(rows, { track_url: null, cue_seconds: 240, prev_track_id: '202', next_track_id: '303', row_index: 2 })).toEqual({ index: 2, how: 'cue' })
    // Rows shifted by one: still the w/ row, not B (which is nearer the old index now).
    const shifted = [row({ cue: 1 }), ...rows]
    expect(findPresaveRow(shifted, { track_url: null, cue_seconds: 240, prev_track_id: '202', next_track_id: '303', row_index: 2 })).toEqual({ index: 3, how: 'cue' })
    // The w/ row got identified (D, 404): B is still excluded as the anchor, so D is the saved row.
    const ided = [named('A', 'One', '101', 0), named('B', 'Two', '202', 240), { ...named('D', 'Four', '404', null), startSeconds: 240, ownStartSeconds: null, isMashupLinked: true }, named('C', 'Three', '303', 480)]
    expect(findPresaveRow(ided, { track_url: null, cue_seconds: 240, prev_track_id: '202', next_track_id: '303', row_index: 1 })).toEqual({ index: 2, how: 'cue' })
    // No anchors, no index (a save by cue alone): the unidentified candidate wins.
    expect(findPresaveRow(rows, { track_url: null, cue_seconds: 240, prev_track_id: null, next_track_id: null, row_index: null })).toEqual({ index: 2, how: 'cue' })

    // At save time (Tasker sends tracklistUrl + cueSeconds = the shared startSeconds): the ID row, not track 202.
    const env = makeEnv()
    await cacheSet(env, SET, rows)
    const calls = poolStub(() => ML_NO_YT)
    const r = await addPresave(env, { setUrl: SET, cueSeconds: 240, artist: 'ID', title: 'ID' }, 'tasker', { log })
    expect(r.presave).toMatchObject({ stage: 'identify', track_id: null, row_index: 2, prev_track_id: '202', next_track_id: '303' })
    expect(calls.filter((c) => c.kind === 'medialink')).toEqual([])
  })

  it('a slow links check never overwrites an upload that completed meanwhile, and queues nothing', async () => {
    const env = makeEnv()
    poolStub(() => ML_NO_YT)
    const p = (await addPresave(env, { trackId: '909720' }, 'ui', { log, check: false })).presave
    mocked(maybeQueueTrackUpload).mockClear()
    poolStub(async () => {
      // mkvid's /mkvid/track/complete lands while the medialink lookup is in flight.
      await markPresaveUploaded(env, p.id, 'vidvidvid01', { uploadId: 1 })
      return ML_NO_YT
    })
    const r = await recheckPresave(env, p.id, 'scheduled', { log })
    expect(r!.presave).toMatchObject({ stage: 'uploaded', youtube_video_id: 'vidvidvid01', next_check_at: null })
    expect(maybeQueueTrackUpload).not.toHaveBeenCalled()
    // The scheduled check is stamped with its start, so the upload's row may be newer.
    const sched = (await listPresaveChecks(env, p.id)).find((c) => c.trigger === 'scheduled')
    expect(sched).toMatchObject({ trigger: 'scheduled', result: 'no_youtube', stage_before: 'links', stage_after: 'uploaded' })
    expect(JSON.parse(sched!.detail!).concurrentChange).toMatch(/uploaded/)
  })

  it('a check that finds YouTube after an owner dismissed it meanwhile: stays dismissed, nothing superseded or pushed', async () => {
    const env = makeEnv()
    poolStub(() => ML_NO_YT)
    const p = (await addPresave(env, { trackId: '909720' }, 'ui', { log, check: false })).presave
    poolStub(async () => {
      await env.DB.prepare("UPDATE presaves SET stage = 'dismissed', dismissed_at = 1 WHERE id = ?").bind(p.id).run()
      return ML_FOUND
    })
    mocked(supersedeTrackUploadsForPresave).mockClear()
    const r = await recheckPresave(env, p.id, 'manual', { log })
    expect(r!.presave).toMatchObject({ stage: 'dismissed', youtube_video_id: null })
    expect(supersedeTrackUploadsForPresave).not.toHaveBeenCalled()
  })

  it('two checks finding the same link at once: one moves it to found, only that one supersedes and pushes', async () => {
    const env = makeEnv()
    poolStub(() => ML_NO_YT)
    const p = (await addPresave(env, { trackId: '909720' }, 'ui', { log, check: false })).presave
    poolStub(async () => {
      await new Promise((r) => setTimeout(r, 5))
      return ML_FOUND
    })
    mocked(supersedeTrackUploadsForPresave).mockClear()
    const [a, b] = await Promise.all([recheckPresave(env, p.id, 'manual', { log }), recheckPresave(env, p.id, 'scheduled', { log })])
    expect(a!.presave.stage).toBe('found')
    expect(b!.presave.stage).toBe('found')
    expect(supersedeTrackUploadsForPresave).toHaveBeenCalledTimes(1)
    const found = (await listPresaveChecks(env, p.id)).filter((c) => c.result === 'found')
    expect(found).toHaveLength(2)
    expect(found.filter((c) => c.detail && JSON.parse(c.detail).concurrentChange)).toHaveLength(1)
  })

  it('a track URL whose page names no id is fetched once: that answer is the add check', async () => {
    const env = makeEnv()
    const calls = poolStub(() => '<html>nothing</html>')
    const r = await addPresave(env, { trackUrl: TRACK_URL }, 'tasker', { log })
    expect(r.presave).toMatchObject({ stage: 'identify', last_result: 'still_id', check_count: 1 })
    expect(calls).toHaveLength(1)
    expect((await listPresaveChecks(env, r.presave.id)).map((c) => `${c.trigger}:${c.result}`)).toEqual(['add:still_id', 'add:added'])
  })

  it('failures back off exponentially up to the recheck interval; a refusal or decoy waits retryMinutes, never more', () => {
    const s = DEFAULT_APP_SETTINGS // retryMinutes 60, recheckIntervalHours 12
    const at = (n: number, kind: 'error' | 'refused' | 'decoy') => failRetryAt(s, n, kind, 0) / 60_000
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => at(n, 'error'))).toEqual([60, 120, 240, 480, 720, 720, 720])
    expect(at(9, 'refused')).toBe(60)
    expect(at(9, 'decoy')).toBe(60)
    expect(at(1000, 'error')).toBe(720)
  })

  it('repeated errors on a check move the next check out each time, and giveUpDays applies to them', async () => {
    const env = makeEnv()
    await cacheSet(env, SET, SET_ROWS(), new Date(Date.now() - 60_000).toISOString())
    poolStub(() => '')
    const p = (await addPresave(env, { setUrl: SET, rowIndex: 1 }, 'ui', { log })).presave
    await env.CACHE.delete('tl:v4:abc123')
    poolStub(() => '<html><body>not a tracklist</body></html>')
    const now = Date.now()
    const waits: number[] = []
    for (let k = 0; k < 3; k++) {
      const r = await recheckPresave(env, p.id, 'scheduled', { log, now })
      expect(r!.presave.last_result).toBe('error')
      expect(r!.refused).toBeUndefined()
      waits.push((r!.presave.next_check_at! - now) / 60_000)
    }
    expect(waits).toEqual([60, 120, 240])
    await env.DB.prepare('UPDATE presaves SET created_at = ? WHERE id = ?').bind(now - 3 * 86400_000, p.id).run()
    await updateAppSettings(env, { presave: { giveUpDays: 2 } })
    const g = await recheckPresave(env, p.id, 'scheduled', { log, now })
    expect(g!.presave).toMatchObject({ stage: 'dismissed', last_result: 'gave_up', next_check_at: null })
  })

  it('a decoy set page is retried after retryMinutes however often it repeats, and never gives up the watch', async () => {
    const env = makeEnv()
    await cacheSet(env, SET, SET_ROWS(), new Date(Date.now() - 60_000).toISOString())
    poolStub(() => '')
    const p = (await addPresave(env, { setUrl: SET, rowIndex: 1 }, 'ui', { log })).presave
    await env.CACHE.delete('tl:v4:abc123')
    await env.DB.prepare('UPDATE presaves SET created_at = ? WHERE id = ?').bind(Date.now() - 30 * 86400_000, p.id).run()
    await updateAppSettings(env, { presave: { giveUpDays: 2 } })
    poolStub(() => fx('tracklist-decoy-dcr839.html'))
    const now = Date.now()
    for (let k = 1; k <= 3; k++) {
      const r = await recheckPresave(env, p.id, 'scheduled', { log, now })
      expect(r!.presave).toMatchObject({ stage: 'identify', last_result: 'error', fail_count: k })
      expect(r!.presave.last_error).toMatch(/decoy/)
      expect(r!.refused).toBeUndefined()
      expect(r!.presave.next_check_at! - now).toBe(60 * 60_000)
    }
  })

  it('a list cached before mediaId existed names no track: not identified, not used to identify, no trackId to the UI', async () => {
    const r0 = named('A', 'One', '101', 0)
    expect(rowIdentified(r0)).toBe(true)
    expect(rowIdentified(oldRow(r0))).toBe(false)
    expect(rowsOut([oldRow(r0), r0]).map((r) => r.trackId)).toEqual([null, '101'])

    // Saving that row by index from the old list: by row (identify), never as track 202 (it may be a page position).
    const env = makeEnv()
    await cacheSet(env, SET, SET_ROWS().map(oldRow), new Date(Date.now() + 60_000).toISOString())
    const calls = poolStub((c) => (c.kind === 'set' ? fx('tracklist-matroda.html') : ML_NO_YT))
    const r = await addPresave(env, { setUrl: SET, rowIndex: 3, trackId: '202' }, 'ui', { log, check: false })
    expect(r.presave).toMatchObject({ stage: 'identify', track_id: null, row_index: 3, prev_track_id: null, next_track_id: null })
    // Its check does not trust the old list even though it is newer than the last check: the page is fetched.
    await recheckPresave(env, r.presave.id, 'manual', { log })
    expect(calls.filter((c) => c.kind === 'set')).toHaveLength(1)
  })

  it('two saves of the same new track at once: the loser returns the winner (created false), no 500', async () => {
    const env = makeEnv()
    poolStub(() => ML_NO_YT)
    const first = await addPresave(env, { trackId: '555' }, 'ui', { log, check: false })
    // Make the second save miss the existing row on its lookup, as a concurrent save would.
    const db = env.DB
    let hidden = false
    env.DB = new Proxy(db, {
      get(t, k) {
        if (k !== 'prepare') return Reflect.get(t, k)
        return (sql: string) => {
          if (!hidden && sql === 'SELECT * FROM presaves WHERE track_id = ?') {
            hidden = true
            return { bind: () => ({ first: async () => null }) }
          }
          return t.prepare(sql)
        }
      },
    }) as D1Database
    const second = await addPresave(env, { trackId: '555' }, 'tasker', { log, check: false })
    expect(hidden).toBe(true)
    expect(second).toMatchObject({ created: false, presave: { id: first.presave.id, track_id: '555' } })
  })
})

// keep the type import used
export type _P = PresaveRow
