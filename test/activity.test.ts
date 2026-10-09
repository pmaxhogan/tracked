import { describe, it, expect } from 'vitest'
import { app } from '../src/index'
import type { Env } from '../src/types'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'
import { parseActivityQuery, labelFromSetUrl, supersededReason, UNION_FROM, COMPOUND_MAX } from '../src/lib/activity'

function makeEnv(): Env {
  return { CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k', DEV_BYPASS_CF_ACCESS: '1' } as Env
}
const get = (env: Env, path: string) => app.request(`http://x${path}`, { method: 'GET' }, env)
type Page = { total: number; page: number; size: number; pageCount: number; sort: unknown; filters: unknown; q: string; rows: Array<{ id: string; ts: number; kind: string; status: string; problem: boolean; title: string; detail: string | null; dj: string | null; setUrl: string | null; videoId?: string | null; ref: { kind: string; key: string } }> }
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
const enc = encodeURIComponent

describe('activity feed (data-table contract)', () => {
  it('rejects a bad table query with 400 bad_table_query', async () => {
    const env = makeEnv()
    for (const bad of ['f.kind=in:nope', 'f.nope=eq:1', 'sort=title', 'f.ts=gt:abc', 'page=-1', 'f.search=has:x']) {
      const r = await get(env, `/ui/api/activity?${bad}`)
      expect(r.status, bad).toBe(400)
      expect(((await r.json()) as { error: string }).error).toBe('bad_table_query')
    }
    expect(() => parseActivityQuery(new URLSearchParams('f.problem=eq:2'))).toThrow()
    expect(parseActivityQuery(new URLSearchParams('f.kind=in:pool|ban&size=12')).filters).toEqual([{ col: 'kind', op: 'in', value: 'pool|ban' }])
  })

  it('keeps every compound SELECT within the D1 term limit (plain SQLite allows 500)', () => {
    // The UNION ALL count of each parenthesised level of the union.
    const counts: number[] = []
    const stack: number[] = [0]
    for (const tok of UNION_FROM.match(/\(|\)|UNION ALL/g) ?? []) {
      if (tok === '(') stack.push(0)
      else if (tok === ')') counts.push(stack.pop()!)
      else stack[stack.length - 1]!++
    }
    counts.push(stack.pop()!)
    expect(Math.max(...counts) + 1).toBeLessThanOrEqual(COMPOUND_MAX)
    expect(counts.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(7) // eight sources, still all there
  })

  it('labels a set URL like the client does', () => {
    expect(labelFromSetUrl(SET)).toBe('dj one live at somewhere 2026 09 01')
    expect(labelFromSetUrl(null)).toBe('(unknown set)')
    expect(labelFromSetUrl('not a url')).toBe('not a url')
  })

  it('orders seconds and milliseconds sources on one clock, newest first, and answers the table shape', async () => {
    const env = makeEnv()
    await audit(env, 1, 999_999)
    await removal(env, 1, 1000)
    const p = await page(env, '')
    expect(p.rows.map((r) => r.ref.kind)).toEqual(['removal', 'audit'])
    expect(p.rows.map((r) => r.ts)).toEqual([1_000_000, 999_999])
    expect(p).toMatchObject({ total: 2, page: 1, size: 50, pageCount: 1, sort: [{ col: 'ts', dir: 'desc' }], filters: [], q: '' })
    const asc = await page(env, '?sort=ts')
    expect(asc.rows.map((r) => r.ref.kind)).toEqual(['audit', 'removal'])
  })

  it('pages a mixed feed exactly once with a real total, ties included', async () => {
    const env = makeEnv()
    for (let i = 1; i <= 8; i++) await audit(env, i, 2_000_000 + (i % 3) * 1000)
    for (let i = 1; i <= 8; i++) await addition(env, i, 2_000_000 + (i % 2) * 1000)
    for (let i = 1; i <= 6; i++) await removal(env, i, 2000 + (i % 2))
    await banEpisode(env, 2_000_000)
    const seen: string[] = []
    const first = await page(env, '?size=10')
    expect(first.total).toBe(23)
    expect(first.pageCount).toBe(3)
    for (let pg = 1; pg <= 3; pg++) {
      const p = await page(env, `?size=10&page=${pg}`)
      expect(p.page).toBe(pg)
      seen.push(...refs(p))
      for (let i = 1; i < p.rows.length; i++) expect(p.rows[i - 1]!.ts).toBeGreaterThanOrEqual(p.rows[i]!.ts)
    }
    expect(seen).toHaveLength(23)
    expect(new Set(seen).size).toBe(23)
    // A page past the end is clamped to the last one.
    const past = await page(env, '?size=10&page=9')
    expect(past.page).toBe(3)
    expect(past.rows).toHaveLength(3)
  })

  it('marks problems and filters to them, with the total of the filtered rows', async () => {
    const env = makeEnv()
    await audit(env, 1, 5_000, 'ok')
    await audit(env, 2, 4_000, 'no_video')
    await audit(env, 3, 6_000, 'ok', { impossible: true })
    await addition(env, 1, 3_000, 'failed')
    await addition(env, 2, 7_000, 'added')
    const all = await page(env, '')
    expect(all.rows.find((r) => r.ref.kind === 'audit' && r.ref.key === '1')!.problem).toBe(false)
    const p = await page(env, '?f.problem=eq:1')
    expect(refs(p)).toEqual(['audit:3', 'audit:2', 'addition:1'])
    expect(p.total).toBe(3)
    expect(p.rows.every((r) => r.problem)).toBe(true)
    expect(p.rows[0]!.detail).toContain('position past end of video')
    expect(refs(await page(env, '?f.problem=eq:0'))).toEqual(['addition:2', 'audit:1'])
  })

  it('filters by kind (one or several), status and source, and sorts by them', async () => {
    const env = makeEnv()
    await audit(env, 1, 1_000)
    await addition(env, 1, 2_000)
    await poolEvent(env, 1, 3, 'account.flagged', 'acct-1')
    await banEpisode(env, 4_000)
    expect(refs(await page(env, '?f.kind=in:pool'))).toEqual(['pool:1'])
    expect(refs(await page(env, `?f.kind=${enc('in:pool|ban')}`))).toEqual([expect.stringMatching(/^ban:/), 'pool:1'])
    expect(refs(await page(env, `?f.kind=${enc('nin:pool|ban')}`))).toEqual(['addition:1', 'audit:1'])
    expect(refs(await page(env, '?f.status=in:added'))).toEqual(['addition:1'])
    expect(refs(await page(env, '?f.src=in:audit'))).toEqual(['audit:1'])
    const byKind = await page(env, '?sort=kind')
    expect(byKind.rows.map((r) => r.kind)).toEqual(['ban', 'playlist', 'pool', 'request'])
  })

  it('a DJ filter drops the DJ-less sources (and never reads the ban episodes)', async () => {
    const env = makeEnv()
    await audit(env, 1, 1_000)
    await addition(env, 1, 2_000, 'added', 'dj-one')
    await addition(env, 2, 3_000, 'added', 'dj-two')
    await poolEvent(env, 1, 4, 'account.flagged', 'acct-1')
    await banEpisode(env, 5_000)
    const list = env.CACHE.list.bind(env.CACHE)
    let listed = 0
    env.CACHE.list = ((o: unknown) => { listed++; return list(o as never) }) as typeof env.CACHE.list
    expect(refs(await page(env, '?f.dj=eq:dj-one'))).toEqual(['addition:1'])
    expect(refs(await page(env, '?f.dj=eq:dj-one&f.problem=eq:1'))).toEqual([])
    expect(listed).toBe(0)
    expect(refs(await page(env, '?f.dj=empty:'))).toEqual([expect.stringMatching(/^ban:/), 'pool:1', 'audit:1'])
  })

  it('a time range cuts every source, ban episodes included', async () => {
    const env = makeEnv()
    await audit(env, 1, 1_000)
    await audit(env, 2, 5_000_000)
    await removal(env, 1, 1)
    await removal(env, 2, 5_000)
    await banEpisode(env, 500)
    await banEpisode(env, 6_000_000)
    const p = await page(env, '?f.ts=gte:2000000')
    expect(refs(p)).toEqual([expect.stringMatching(/^ban:/), 'removal:2', 'audit:2'])
    expect(p.total).toBe(3)
    const early = await page(env, `?f.ts=${enc('between:..1000')}`)
    expect(early.rows.map((r) => r.ts).sort((a, b) => a - b)).toEqual([500, 1_000, 1_000])
  })

  it('q searches the stored text of every source', async () => {
    const env = makeEnv()
    await audit(env, 1, 1_000, 'ok', { title: 'Anyma live at Sphere' })
    await addition(env, 1, 2_000, 'added', 'dj-one')
    await env.DB.prepare("INSERT INTO sub_sync (slug, artist_name, last_run_at, last_error) VALUES ('dj-two', 'Anyma Fans', 7000, 'boom 100%')").run()
    expect(refs(await page(env, '?q=anyma'))).toEqual(['sync:dj-two', 'audit:1'])
    expect(refs(await page(env, '?q=somewhere'))).toEqual(['addition:1'])
    expect(refs(await page(env, `?q=${enc('100%')}`))).toEqual(['sync:dj-two'])
    expect((await page(env, '?q=zzz')).total).toBe(0)
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
    expect(p.total).toBe(9)
    const kinds = Object.fromEntries(p.rows.map((r) => [r.ref.kind, r.kind]))
    expect(kinds).toEqual({ audit: 'request', addition: 'playlist', removal: 'hygiene', mkvid: 'mkvid', claim: 'mkvid', pool: 'pool', sync: 'sync', ban: 'ban' })
    expect(new Set(p.rows.map((r) => r.id)).size).toBe(9)

    expect(by('audit').title).toBe('req 1')
    expect(by('audit').detail).toBe('1:01 / 1:00:00 · via search')
    expect(by('addition').setUrl).toBe(SET)
    expect(by('addition').dj).toBe('dj-one')
    expect(by('addition').title).toBe('dj one live at somewhere 2026 09 01')
    expect(by('removal').title).toBe('Sweep: video is more than 5 min shorter than the last cue')
    expect(by('removal').ts).toBe(3_000_000)
    expect(by('mkvid').detail).toBe('uploaded vidmkvid001')
    expect(by('mkvid').title).toBe('DJ One @ Somewhere')

    const claim = by('claim')
    expect(claim.status).toBe('refunded')
    expect(claim.detail).toContain('shared account')
    expect(claim.detail).toContain('given back')
    expect(claim.title).toBe('Claimed for render: DJ One @ Somewhere')
    expect(claim.dj).toBe('dj-one')

    const flagged = by('pool', '1')
    expect(flagged.problem).toBe(true)
    expect(flagged.title).toBe('Account flagged')
    expect(flagged.detail).toContain('acct-3')
    expect(flagged.detail).toContain('captcha loop')
    expect(by('pool', '2').detail ?? '').not.toContain('@')
    expect((await page(env, '?q=someone')).total).toBe(0)

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

  it('names a track upload claim by its track', async () => {
    const env = makeEnv()
    await env.DB.prepare("INSERT INTO track_uploads (id, presave_id, artist, title, source_name, source_url, status, video_id, created_at, updated_at) VALUES (4, 1, 'Mau P', 'Metro', 'soundcloud', 'https://soundcloud.com/a/b', 'done', 'vidtrack001', 1, 1)").run()
    await env.DB.prepare("INSERT INTO mkvid_claims (id, request_id, account, claimed_at, recreate, refunded_at) VALUES (2, 'track:4', 'primary', 5000, 0, NULL)").run()
    const p = await page(env, '?f.src=in:claim')
    expect(p.rows.map((r) => [r.title, r.status, r.videoId])).toEqual([['Track upload claimed: Mau P – Metro', 'claimed', 'vidtrack001']])
  })

  it('ban episodes: problems skip simulated ones, a key whose body is gone is skipped', async () => {
    const env = makeEnv()
    await banEpisode(env, 1_000) // the only real block, oldest
    await banEpisode(env, 2_000, true)
    await banEpisode(env, 3_000, true)
    await audit(env, 1, 2_500)
    const p = await page(env, '?f.kind=in:ban&f.problem=eq:1')
    expect(p.rows.map((r) => [r.ts, r.title])).toEqual([[1_000, 'IP block']])
    expect(p.total).toBe(1)
    const mixed = await page(env, '')
    expect(mixed.rows.map((r) => [r.ref.kind, r.ts])).toEqual([['ban', 3_000], ['audit', 2_500], ['ban', 2_000], ['ban', 1_000]])
    expect(mixed.rows[0]!.title).toBe('Simulated IP block')
    await env.CACHE.delete('ban:ep:' + String(10_000_000_000_000 - 3_000).padStart(14, '0'))
    expect((await page(env, '?f.kind=in:ban')).rows.map((r) => r.ts)).toEqual([2_000, 1_000])
  })

  it('names each superseded cause from the stored error', () => {
    const twinUrl = 'https://www.1001tracklists.com/tracklist/abc123/other-url.html'
    expect(supersededReason('duplicate of the same 1001tracklists id under another URL (removed 2026-10-02)')).toBe('duplicate URL: kept under another URL')
    expect(supersededReason(`same tracklist as ${twinUrl}, already rendered as vidtwin0001`)).toBe(`duplicate URL: kept under ${twinUrl} (vidtwin0001)`)
    expect(supersededReason('set already resolves to vidoffic001 (1001tl)')).toBe('superseded by an official recording (vidoffic001)')
    expect(supersededReason('set already resolves to vidmkvid002 (mkvid)')).toBe('set already has mkvid video vidmkvid002')
    expect(supersededReason('1001tracklists now has vidoffic003')).toBe('superseded by an official recording (vidoffic003)')
    expect(supersededReason('set gained vidx before the upload finished')).toBe('set gained vidx before the upload finished')
    expect(supersededReason(null)).toBe('superseded')
    expect(supersededReason('  ')).toBe('superseded')
  })

  it('shows the stored superseded cause on mkvid rows', async () => {
    const env = makeEnv()
    const errors = [
      'duplicate of the same 1001tracklists id under another URL (removed 2026-10-02)',
      'same tracklist as https://www.1001tracklists.com/tracklist/abc123/other-url.html, already rendered as vidtwin0001',
      'set already resolves to vidoffic001 (1001tl)',
      'set already resolves to vidmkvid002 (mkvid)',
      '1001tracklists now has vidoffic003',
      null,
    ]
    for (const [i, error] of errors.entries()) {
      await env.DB.prepare("INSERT INTO mkvid_requests (id, slug, set_url, set_title, source, source_url, status, error, created_at, updated_at) VALUES (?, 'dj-one', ?, 'DJ One @ Somewhere', 'soundcloud', 'https://soundcloud.com/x/y', 'superseded', ?, 1, ?)")
        .bind(`sup-${i}`, `${SET}?n=${i}`, error, 1000 + i).run()
    }
    const p = await page(env, '?f.kind=in:mkvid')
    const detail = Object.fromEntries(p.rows.filter((r) => r.ref.kind === 'mkvid').map((r) => [r.ref.key, r.detail]))
    expect(detail).toEqual({
      'sup-0': 'duplicate URL: kept under another URL',
      'sup-1': 'duplicate URL: kept under https://www.1001tracklists.com/tracklist/abc123/other-url.html (vidtwin0001)',
      'sup-2': 'superseded by an official recording (vidoffic001)',
      'sup-3': 'set already has mkvid video vidmkvid002',
      'sup-4': 'superseded by an official recording (vidoffic003)',
      'sup-5': 'superseded',
    })
  })

  it('treats an empty sync error as ok', async () => {
    const env = makeEnv()
    await env.DB.prepare("INSERT INTO sub_sync (slug, artist_name, last_run_at, last_error) VALUES ('dj-one', 'DJ One', 7000, '')").run()
    const p = await page(env, '?f.kind=in:sync')
    expect(p.rows.map((r) => [r.status, r.problem])).toEqual([['ok', false]])
    expect((await page(env, '?f.kind=in:sync&f.problem=eq:1')).rows).toEqual([])
  })

  it('drops pool reasons that could carry an address or are long', async () => {
    const env = makeEnv()
    await poolEvent(env, 1, 10, 'account.flagged', 'acct-1', { reason: 'mail bounced for someone@example.com' })
    await poolEvent(env, 2, 20, 'account.flagged', 'acct-2', { reason: 'x'.repeat(121) })
    await poolEvent(env, 3, 30, 'account.flagged', 'acct-3', { reason: 'y'.repeat(120) })
    const p = await page(env, '?f.kind=in:pool')
    const detail = (key: string) => p.rows.find((r) => r.ref.key === key)!.detail
    expect(detail('1')).toBe('acct-1')
    expect(detail('2')).toBe('acct-2')
    expect(detail('3')).toBe(`acct-3 · ${'y'.repeat(120)}`)
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
