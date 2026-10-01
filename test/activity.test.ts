import { describe, it, expect } from 'vitest'
import { app } from '../src/index'
import type { Env } from '../src/types'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'
import { ACTIVITY_KINDS, parseActivityQuery, encodeActivityCursor, decodeActivityCursor, labelFromSetUrl } from '../src/lib/activity'

function makeEnv(): Env {
  return { CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k', DEV_BYPASS_CF_ACCESS: '1' } as Env
}
const get = (env: Env, path: string) => app.request(`http://x${path}`, { method: 'GET' }, env)
type Page = { rows: Array<{ ts: number; kind: string; status: string; problem: boolean; title: string; detail: string | null; dj: string | null; setUrl: string | null; ref: { kind: string; key: string } }>; cursor: string | null }
const SET = 'https://www.1001tracklists.com/tracklist/abc123/dj-one-live-at-somewhere-2026-09-01.html'

async function audit(env: Env, id: number, tsMs: number, status = 'ok', extra: Record<string, unknown> = {}) {
  const summary = { t: new Date(tsMs).toISOString(), status, title: `req ${id}`, cs: 61, dur: 3600, via: 'search', skew: null, impossible: false, ms: 1, ...extra }
  await env.DB.prepare('INSERT INTO now_playing_audit (id, t, ts, req_id, status, summary, record) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, summary.t, tsMs, `r${id}`, status, JSON.stringify(summary), JSON.stringify({ t: summary.t, status })).run()
}
async function addition(env: Env, id: number, tsMs: number, status = 'added', slug = 'dj-one') {
  const summary = { t: new Date(tsMs).toISOString(), status, slug, artist: 'DJ One', set: SET, vid: 'vid00000001', via: 'pool', trg: 'test', msg: null, ms: 1, cmb: 'added' }
  await env.DB.prepare('INSERT INTO playlist_additions (id, t, ts, status, slug, set_url, video_id, summary, record) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, summary.t, tsMs, status, slug, SET, 'vid00000001', JSON.stringify(summary), '{}').run()
}
async function removal(env: Env, id: number, atSec: number, status = 'removed') {
  await env.DB.prepare("INSERT INTO playlist_removals (id, at, source, status, slug, set_url, video_id, playlist_id, playlist_kind, reason, detail) VALUES (?, ?, 'sweep', ?, 'dj-one', ?, ?, 'PL1', 'artist', 'short', 'video 10:00 < last cue 60:00 - 5:00')")
    .bind(id, atSec, status, SET, `vid${id}`).run()
}
async function poolEvent(env: Env, id: number, atSec: number, type: string, accountId: string | null, payload: Record<string, unknown> = {}, push = 'none') {
  await env.DB.prepare('INSERT INTO pool_events (id, type, challenge_id, account_id, payload, received_at, push_status) VALUES (?, ?, NULL, ?, ?, ?, ?)')
    .bind(id, type, accountId, JSON.stringify(payload), atSec, push).run()
}
async function banEpisode(env: Env, tsMs: number, simulated = false) {
  const key = 'ban:ep:' + String(10_000_000_000_000 - tsMs).padStart(14, '0')
  await env.CACHE.put(key, JSON.stringify({
    key, startedAt: new Date(tsMs).toISOString(), endedAt: null, blockedForMs: null, ip: null, source: 'home', simulated,
    poolRequests: 0, brightdataRequests: 0, allBlockedHits: 0, clearedBy: null, pushStart: null, pushClear: null,
  }))
  return key
}
async function page(env: Env, qs: string): Promise<Page> {
  const r = await get(env, `/ui/api/activity${qs}`)
  expect(r.status).toBe(200)
  return (await r.json()) as Page
}
const refs = (p: Page) => p.rows.map((r) => `${r.ref.kind}:${r.ref.key}`)

describe('activity feed', () => {
  it('parses and rejects query parameters', async () => {
    expect(parseActivityQuery(new URLSearchParams(''))).toEqual({ kinds: [...ACTIVITY_KINDS], problems: false, dj: null, since: null, cursor: null, limit: 50 })
    const q = parseActivityQuery(new URLSearchParams('kind=request,ban&problems=1&limit=500'))
    expect(q).toMatchObject({ kinds: ['request', 'ban'], problems: true, limit: 100 })
    for (const bad of ['kind=nope', 'limit=abc', 'since=-5', 'since=1e9', 'cursor=garbage', 'dj=Bad Slug!']) {
      expect(parseActivityQuery(new URLSearchParams(bad)), bad).toHaveProperty('error')
    }
    const env = makeEnv()
    const r = await get(env, '/ui/api/activity?kind=nope')
    expect(r.status).toBe(400)
    expect(((await r.json()) as { error: string }).error).toBe('invalid_request')
  })

  it('round-trips the cursor', () => {
    expect(decodeActivityCursor(encodeActivityCursor({ ts: 5, src: 'sync', key: 'dj-one' }))).toEqual({ ts: 5, src: 'sync', key: 'dj-one' })
    expect(decodeActivityCursor('5|audit|x')).toBeNull()
    expect(decodeActivityCursor('5|nope|1')).toBeNull()
  })

  it('labels a set URL like the client does', () => {
    expect(labelFromSetUrl(SET)).toBe('dj one live at somewhere 2026 09 01')
    expect(labelFromSetUrl(null)).toBe('(unknown set)')
    expect(labelFromSetUrl('not a url')).toBe('not a url')
  })

  it('orders seconds and milliseconds sources on one clock', async () => {
    const env = makeEnv()
    await audit(env, 1, 999_999)
    await removal(env, 1, 1000)
    const p = await page(env, '')
    expect(p.rows.map((r) => r.ref.kind)).toEqual(['removal', 'audit'])
    expect(p.rows.map((r) => r.ts)).toEqual([1_000_000, 999_999])
  })

  it('pages a mixed feed with ts ties exactly once', async () => {
    const env = makeEnv()
    await audit(env, 1, 2_000_000)
    await audit(env, 2, 2_000_000)
    await addition(env, 1, 2_000_000)
    await addition(env, 2, 2_000_000)
    await removal(env, 1, 2000)
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const p: Page = await page(env, `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      seen.push(...refs(p))
      cursor = p.cursor
      pages++
    } while (cursor && pages < 10)
    expect(seen).toEqual(['audit:2', 'audit:1', 'addition:2', 'addition:1', 'removal:1'])
    expect(pages).toBe(3)
  })

  it('marks problems and filters to them', async () => {
    const env = makeEnv()
    await audit(env, 1, 5_000, 'ok')
    await audit(env, 2, 4_000, 'no_video')
    await audit(env, 3, 6_000, 'ok', { impossible: true })
    await addition(env, 1, 3_000, 'failed')
    await addition(env, 2, 7_000, 'added')
    const all = await page(env, '')
    expect(all.rows.find((r) => r.ref.kind === 'audit' && r.ref.key === '1')!.problem).toBe(false)
    const p = await page(env, '?problems=1')
    expect(refs(p)).toEqual(['audit:3', 'audit:2', 'addition:1'])
    expect(p.rows.every((r) => r.problem)).toBe(true)
    expect(p.rows[0]!.detail).toContain('position past end of video')
  })

  it('dj filter drops the DJ-less sources', async () => {
    const env = makeEnv()
    await audit(env, 1, 1_000)
    await addition(env, 1, 2_000, 'added', 'dj-one')
    await addition(env, 2, 3_000, 'added', 'dj-two')
    await poolEvent(env, 1, 4, 'account.flagged', 'acct-1')
    await banEpisode(env, 5_000)
    expect(refs(await page(env, '?dj=dj-one'))).toEqual(['addition:1'])
    expect(refs(await page(env, '?dj=dj-one&problems=1'))).toEqual([])
  })

  it('reads every source', async () => {
    const env = makeEnv()
    await audit(env, 1, 1_000_000)
    await addition(env, 1, 2_000_000)
    await removal(env, 1, 3_000)
    await env.DB.prepare("INSERT INTO mkvid_requests (id, slug, set_url, set_title, source, source_url, status, video_id, created_at, updated_at) VALUES ('req-uuid-1', 'dj-one', ?, 'DJ One @ Somewhere', 'soundcloud', 'https://soundcloud.com/x/y', 'done', 'vidmkvid001', 1, 4000)")
      .bind(SET).run()
    await env.DB.prepare("INSERT INTO mkvid_claims (id, request_id, account, claimed_at, recreate, refunded_at) VALUES (1, 'req-uuid-1', 'shared', 5000, 0, 5100)").run()
    await poolEvent(env, 1, 6000, 'account.flagged', 'acct-3', { reason: 'captcha loop' })
    await poolEvent(env, 2, 6500, 'account.created', 'someone@example.com')
    await env.DB.prepare("INSERT INTO sub_sync (slug, artist_name, last_run_at, last_error) VALUES ('dj-one', 'DJ One', 7000, 'boom')").run()
    const banTs = 8_000_123
    const banKey = await banEpisode(env, banTs)

    const p = await page(env, '')
    const by = (kind: string, key?: string) => p.rows.find((r) => r.ref.kind === kind && (key == null || r.ref.key === key))!
    expect(p.rows).toHaveLength(9)
    const kinds = Object.fromEntries(p.rows.map((r) => [r.ref.kind, r.kind]))
    expect(kinds).toEqual({ audit: 'request', addition: 'playlist', removal: 'hygiene', mkvid: 'mkvid', claim: 'mkvid', pool: 'pool', sync: 'sync', ban: 'ban' })

    expect(by('addition').setUrl).toBe(SET)
    expect(by('addition').dj).toBe('dj-one')
    expect(by('removal').title).toBe('Sweep: video is more than 5 min shorter than the last cue')
    expect(by('removal').ts).toBe(3_000_000)
    expect(by('mkvid').detail).toBe('uploaded vidmkvid001')
    expect(by('mkvid').title).toBe('DJ One @ Somewhere')

    const claim = by('claim')
    expect(claim.status).toBe('refunded')
    expect(claim.detail).toContain('shared account')
    expect(claim.title).toBe('Claimed for render: DJ One @ Somewhere')
    expect(claim.dj).toBe('dj-one')

    const flagged = by('pool', '1')
    expect(flagged.problem).toBe(true)
    expect(flagged.title).toBe('Account flagged')
    expect(flagged.detail).toContain('acct-3')
    expect(flagged.detail).toContain('captcha loop')
    expect(by('pool', '2').detail ?? '').not.toContain('@')

    const sync = by('sync')
    expect(sync.status).toBe('error')
    expect(sync.problem).toBe(true)
    expect(sync.detail).toBe('boom')
    expect(sync.title).toBe('Sync: DJ One')

    const ban = by('ban')
    expect(ban.ref.key).toBe(banKey)
    expect(ban.status).toBe('open')
    expect(ban.problem).toBe(true)
    expect(ban.ts).toBe(banTs)
    expect(ban.detail).toBe('ongoing')
  })

  it('pages across ban episodes with the in-Worker keyset', async () => {
    const env = makeEnv()
    await banEpisode(env, 3_000)
    await banEpisode(env, 2_000, true)
    await audit(env, 1, 2_000)
    const p1 = await page(env, '?limit=2')
    expect(refs(p1).map((r) => r.split(':')[0])).toEqual(['ban', 'audit'])
    const p2 = await page(env, `?limit=2&cursor=${encodeURIComponent(p1.cursor!)}`)
    expect(p2.rows.map((r) => [r.ref.kind, r.ts, r.problem, r.title])).toEqual([['ban', 2_000, false, 'Simulated IP block']])
    expect(p2.cursor).toBeNull()
  })

  it('filters ban problems before the limit + 1 cut', async () => {
    const env = makeEnv()
    await banEpisode(env, 1_000) // the only real block, oldest
    await banEpisode(env, 2_000, true)
    await banEpisode(env, 3_000, true)
    await banEpisode(env, 4_000, true)
    const p = await page(env, '?kind=ban&problems=1&limit=2')
    expect(p.rows.map((r) => [r.ts, r.title])).toEqual([[1_000, 'IP block']])
    expect(p.cursor).toBeNull()
    // A key whose body is gone does not take a slot either.
    await banEpisode(env, 500)
    await banEpisode(env, 400)
    await env.CACHE.delete('ban:ep:' + String(10_000_000_000_000 - 4_000).padStart(14, '0'))
    const q = await page(env, '?kind=ban&limit=2')
    expect(q.rows.map((r) => r.ts)).toEqual([3_000, 2_000])
    expect(q.cursor).not.toBeNull()
  })

  it('treats an empty sync error as ok', async () => {
    const env = makeEnv()
    await env.DB.prepare("INSERT INTO sub_sync (slug, artist_name, last_run_at, last_error) VALUES ('dj-one', 'DJ One', 7000, '')").run()
    const p = await page(env, '?kind=sync')
    expect(p.rows.map((r) => [r.status, r.problem])).toEqual([['ok', false]])
    expect((await page(env, '?kind=sync&problems=1')).rows).toEqual([])
  })

  it('drops pool reasons that could carry an address or are long', async () => {
    const env = makeEnv()
    await poolEvent(env, 1, 10, 'account.flagged', 'acct-1', { reason: 'mail bounced for someone@example.com' })
    await poolEvent(env, 2, 20, 'account.flagged', 'acct-2', { reason: 'x'.repeat(121) })
    await poolEvent(env, 3, 30, 'account.flagged', 'acct-3', { reason: 'y'.repeat(120) })
    const p = await page(env, '?kind=pool')
    const detail = (key: string) => p.rows.find((r) => r.ref.key === key)!.detail
    expect(detail('1')).toBe('acct-1')
    expect(detail('2')).toBe('acct-2')
    expect(detail('3')).toBe(`acct-3 · ${'y'.repeat(120)}`)
  })

  it('since cuts every source', async () => {
    const env = makeEnv()
    await audit(env, 1, 1_000)
    await audit(env, 2, 5_000_000)
    await removal(env, 1, 1)
    await removal(env, 2, 5_000)
    // Same ms (5_000 s = 5_000_000 ms): ties break by source rank, audit before removal.
    expect(refs(await page(env, '?since=2000000'))).toEqual(['audit:2', 'removal:2'])
  })

  it('never writes', async () => {
    const env = makeEnv()
    await audit(env, 1, 1_000)
    await addition(env, 1, 2_000)
    await banEpisode(env, 3_000)
    const sql: string[] = []
    const db = env.DB
    const prepare = db.prepare.bind(db)
    db.prepare = ((q: string) => { sql.push(q); return prepare(q) }) as typeof db.prepare
    env.CACHE.put = (async () => { throw new Error('CACHE.put during activity read') }) as typeof env.CACHE.put
    env.CACHE.delete = (async () => { throw new Error('CACHE.delete during activity read') }) as typeof env.CACHE.delete
    const p = await page(env, '')
    expect(p.rows.length).toBe(3)
    expect(sql.length).toBeGreaterThan(0)
    expect(sql.filter((s) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(s))).toEqual([])
  })
})
