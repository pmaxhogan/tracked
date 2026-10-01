import { describe, it, expect, afterEach, vi } from 'vitest'
import { app } from '../src/index'
import type { Env } from '../src/types'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'
import { REASON_LABELS } from '../src/lib/playlist-hygiene'
import { mkvidQueuePosition } from '../src/lib/mkvid'
import { storeVerifiedList } from './helpers/mkvid-lists'
import type { SetDiagnostics } from '../src/lib/set-diagnostics'

function makeEnv(): Env {
  return { CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k', DEV_BYPASS_CF_ACCESS: '1' } as Env
}
const get = (env: Env, path: string) => app.request(`http://x${path}`, { method: 'GET' }, env)
const SET = 'https://www.1001tracklists.com/tracklist/abc123/dj-one-live-at-somewhere-2026-09-01.html'
const VID = 'vid00000001'
const diag = async (env: Env, url = SET): Promise<SetDiagnostics> => {
  const r = await get(env, `/ui/api/set?url=${encodeURIComponent(url)}`)
  expect(r.status).toBe(200)
  return (await r.json()) as SetDiagnostics
}

async function discover(env: Env, slug: string, videoId: string | null = null, url = SET) {
  await env.DB.prepare(
    `INSERT INTO tracklists (slug, url, position, discovered_at, processed, abandoned, failure_count, video_known, video_id, video_source, checked_at)
     VALUES (?, ?, 0, 1000, 1, 0, 0, 1, ?, ?, 2000)`,
  ).bind(slug, url, videoId, videoId ? '1001tl' : null).run()
}
async function facts(env: Env, lastCue: number, videoId: string | null = VID) {
  await env.DB.prepare(
    `INSERT INTO set_media_facts (set_url, slug, video_id, no_full_notice, last_cue_seconds, last_cue_known, fetched_at) VALUES (?, 'dj-one', ?, 0, ?, 1, 3000)`,
  ).bind(SET, videoId, lastCue).run()
}
async function meta(env: Env, seconds: number) {
  await env.DB.prepare('INSERT INTO video_meta (video_id, duration_seconds, embed_width, embed_height, privacy, upload_status, alive, fetched_at) VALUES (?, ?, 480, 270, ?, ?, 1, 4000)')
    .bind(VID, seconds, 'public', 'processed').run()
}
async function mkvidRow(env: Env, id: string, url: string, status: string, sortKey: number, createdAt = 1) {
  await env.DB.prepare(
    `INSERT INTO mkvid_requests (id, slug, set_url, source, source_url, status, sort_key, attempts, created_at, updated_at)
     VALUES (?, 'dj-one', ?, 'soundcloud', 'https://soundcloud.com/x', ?, ?, 0, ?, ?)`,
  ).bind(id, url, status, sortKey, createdAt, createdAt).run()
}

afterEach(() => vi.unstubAllGlobals())

describe('GET /ui/api/set', () => {
  it('rejects a non-tracklist URL', async () => {
    const env = makeEnv()
    for (const q of ['?url=https://example.com/x', '', '?url=']) {
      const r = await get(env, `/ui/api/set${q}`)
      expect(r.status, q).toBe(400)
      expect(await r.json()).toEqual({ error: 'invalid_request', message: 'not a 1001tracklists tracklist URL' })
    }
  })

  it('normalizes the URL', async () => {
    const env = makeEnv()
    await discover(env, 'dj-one')
    const d = await diag(env, '1001tracklists.com/tracklist/abc123/dj-one-live-at-somewhere-2026-09-01.html?ref=1')
    expect(d.url).toBe(SET)
    expect(d.discovered).toHaveLength(1)
  })

  it('an unknown set is all empty, not an error', async () => {
    const d = await diag(makeEnv())
    expect(d).toMatchObject({ url: SET, discovered: [], schedule: null, verification: null, media: null, video: null, mkvid: null })
    expect(d.playlist).toEqual({ additions: [], confirmed: [] })
    expect(d.hygiene).toEqual({ removed: [], removals: [] })
  })

  it('lists every DJ that discovered the set', async () => {
    const env = makeEnv()
    await discover(env, 'dj-one')
    await discover(env, 'dj-two')
    await env.DB.prepare("INSERT INTO sub_sync (slug, artist_name) VALUES ('dj-one', 'DJ One')").run()
    const d = await diag(env)
    expect(d.discovered.map((x) => [x.slug, x.artistName])).toEqual([['dj-one', 'DJ One'], ['dj-two', null]])
    expect(d.discovered[0]).toMatchObject({ discoveredAt: 1000, processed: true, abandoned: false, videoKnown: true, checkedAt: 2000 })
  })

  it('judges the video from cached facts only', async () => {
    const env = makeEnv()
    await discover(env, 'dj-one', VID)
    await facts(env, 3600)
    await meta(env, 600)
    const fetchSpy = vi.fn(() => { throw new Error('network during diagnostics') })
    vi.stubGlobal('fetch', fetchSpy)
    const d = await diag(env)
    expect(d.video).toMatchObject({ id: VID, from: 'tracklists', override: false })
    expect(d.video?.meta).toMatchObject({ durationSeconds: 600, alive: true })
    expect(d.video?.verdict).toMatchObject({ ok: false, reason: 'short', label: REASON_LABELS.short })
    expect(d.media).toMatchObject({ lastCueSeconds: 3600, videoId: VID })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('takes the video from media facts, then from mkvid, when tracklists has none', async () => {
    const env = makeEnv()
    await discover(env, 'dj-one')
    await facts(env, 3600)
    expect((await diag(env)).video).toMatchObject({ id: VID, from: 'media', meta: null })
    const env2 = makeEnv()
    await discover(env2, 'dj-one')
    await mkvidRow(env2, 'r1', SET, 'done', 1)
    await env2.DB.prepare("UPDATE mkvid_requests SET video_id = 'mkvidvideo01' WHERE id = 'r1'").run()
    const d = await diag(env2)
    expect(d.video).toMatchObject({ id: 'mkvidvideo01', from: 'mkvid', verdict: null })
  })

  it('an override wins', async () => {
    const env = makeEnv()
    await discover(env, 'dj-one', VID)
    await facts(env, 3600)
    await meta(env, 600)
    await env.DB.prepare('INSERT INTO video_overrides (video_id, allow, at) VALUES (?, 1, 5000)').bind(VID).run()
    expect((await diag(env)).video?.override).toBe(true)
  })

  it('position is null unless pending', async () => {
    const env = makeEnv()
    const A = 'https://www.1001tracklists.com/tracklist/aaa111/a.html'
    const B = 'https://www.1001tracklists.com/tracklist/bbb222/b.html'
    const C = 'https://www.1001tracklists.com/tracklist/ccc333/c.html'
    await mkvidRow(env, 'ra', A, 'pending', 10)
    await mkvidRow(env, 'rb', B, 'pending', 5)
    await mkvidRow(env, 'rc', C, 'done', 20)
    expect((await diag(env, A)).mkvid?.position).toBe(1)
    expect((await diag(env, B)).mkvid?.position).toBe(2)
    expect((await diag(env, C)).mkvid?.position).toBeNull()
    expect(await mkvidQueuePosition(env, 'rc')).toBeNull()
    expect(await mkvidQueuePosition(env, 'nope')).toBeNull()
  })

  it('reports readiness and the stored list', async () => {
    const env = makeEnv()
    await mkvidRow(env, 'r1', SET, 'pending', 1)
    await storeVerifiedList(env, SET, { rows: 4, idRows: 1, trusted: false })
    const d = await diag(env)
    expect(d.mkvid?.readiness).toEqual({ state: 'unverified' })
    expect(d.mkvid?.list).toMatchObject({ trackCount: 4, idRows: 1, trusted: false })
    expect(d.mkvid).toMatchObject({ id: 'r1', status: 'pending', account: 'primary', skipIdWait: false, attempts: 0 })
  })

  it('hides non-acct account ids', async () => {
    const env = makeEnv()
    await env.DB.prepare(
      `INSERT INTO set_verification (url, state, fingerprint, row_count, first_account, first_fetched_at, verify_due_at, second_account, second_fetched_at, verified_at, exclude_accounts, mismatches, updated_at)
       VALUES (?, 'pending', 'fp', 5, 'acct-2', 100, 200, 'someone@example.com', 150, NULL, '[]', 0, 100)`,
    ).bind(SET).run()
    const r = await get(env, `/ui/api/set?url=${encodeURIComponent(SET)}`)
    const text = await r.text()
    const d = JSON.parse(text) as SetDiagnostics
    expect(d.verification).toMatchObject({ state: 'pending', rowCount: 5, firstAccount: 'acct-2', secondAccount: null, verifyDueAt: 200 })
    expect(text).not.toContain('@')
  })

  it('collects schedule, playlist and hygiene evidence', async () => {
    const env = makeEnv()
    await discover(env, 'dj-one', VID)
    await env.DB.prepare(
      `INSERT INTO set_schedule (url, set_date, next_due_at, last_fetched_at, has_id_rows, no_good_video, updated_at, retry_at, attempt_day, attempts_today)
       VALUES (?, '2026-09-01', 9000, 8000, 1, 0, 1, 8500, '2026-10-01', 2)`,
    ).bind(SET).run()
    await env.DB.prepare('INSERT INTO playlist_additions (id, t, ts, status, slug, set_url, video_id, summary, record) VALUES (1, ?, 5000, ?, ?, ?, ?, ?, ?)')
      .bind('t', 'failed', 'dj-one', SET, VID, JSON.stringify({ msg: 'quota' }), '{}').run()
    await env.DB.prepare("INSERT INTO playlist_confirmed (playlist_id, video_id, state, source, at) VALUES ('PL1', ?, 'in', 'sync', 6000)").bind(VID).run()
    await env.DB.prepare("INSERT INTO removed_videos (playlist_id, video_id, slug, set_url, reason, at) VALUES ('PL1', ?, 'dj-one', ?, 'owner', 7000)").bind(VID, SET).run()
    await env.DB.prepare("INSERT INTO playlist_removals (at, source, status, slug, set_url, video_id, playlist_id, playlist_kind, reason, detail) VALUES (7100, 'sweep', 'removed', 'dj-one', ?, ?, 'PL1', 'artist', 'short', 'x')")
      .bind(SET, VID).run()
    const d = await diag(env)
    expect(d.schedule).toEqual({ setDate: '2026-09-01', nextDueAt: 9000, lastFetchedAt: 8000, hasIdRows: true, noGoodVideo: false, retryAt: 8500, attemptDay: '2026-10-01', attemptsToday: 2 })
    expect(d.playlist.additions).toEqual([{ key: '1', ts: 5000, status: 'failed', slug: 'dj-one', videoId: VID, message: 'quota' }])
    expect(d.playlist.confirmed).toEqual([{ playlistId: 'PL1', state: 'in', source: 'sync', at: 6000 }])
    expect(d.hygiene.removed).toEqual([{ playlistId: 'PL1', reason: 'owner', at: 7000, slug: 'dj-one' }])
    expect(d.hygiene.removals).toMatchObject([{ at: 7100, source: 'sweep', status: 'removed', playlistKind: 'artist', reason: 'short', detail: 'x' }])
  })

  it('never writes', async () => {
    const env = makeEnv()
    await discover(env, 'dj-one', VID)
    await facts(env, 3600)
    await meta(env, 600)
    await mkvidRow(env, 'r1', SET, 'pending', 1)
    await storeVerifiedList(env, SET)
    const sql: string[] = []
    const db = env.DB
    const prepare = db.prepare.bind(db)
    db.prepare = ((q: string) => { sql.push(q); return prepare(q) }) as typeof db.prepare
    env.CACHE.put = (async () => { throw new Error('CACHE.put during diagnostics') }) as typeof env.CACHE.put
    env.CACHE.delete = (async () => { throw new Error('CACHE.delete during diagnostics') }) as typeof env.CACHE.delete
    const d = await diag(env)
    expect(d.mkvid?.readiness).toBeTruthy()
    expect(sql.length).toBeGreaterThan(0)
    expect(sql.filter((s) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(s))).toEqual([])
  })
})
