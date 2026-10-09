import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeD1 } from './helpers/fake-d1'
import { fakeKV } from './helpers/fake-kv'
import type { Env } from '../src/types'
import { parseTracklist } from '../src/lib/tracklists1001'
import { tracklistFingerprint } from '../src/lib/verification'
import { updatePresaveCandidates } from '../src/lib/presave-candidates'
import { app } from '../src/index'

const SET = 'https://www.1001tracklists.com/tracklist/2w8m7q5k/matroda-test.html'
const MATRODA = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tracklist-matroda.html'), 'utf8')

function makeEnv(): Env {
  return { CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k', DEV_BYPASS_CF_ACCESS: '1' } as Env
}

async function verify(env: Env, parsed: ReturnType<typeof parseTracklist>) {
  await env.DB.prepare(
    `INSERT INTO set_verification (url, state, fingerprint, row_count, first_account, first_fetched_at, verify_due_at, verified_at, updated_at)
     VALUES (?, 'verified', ?, ?, 'a', 1, 1, 1, 1)`,
  )
    .bind(SET, await tracklistFingerprint(parsed), parsed.rows.length)
    .run()
}

const rows = (env: Env) => env.DB.prepare('SELECT key, artist, title, presave_count, is_id, row_index FROM presave_candidates ORDER BY presave_count DESC').all().then((r) => r.results)

describe('set page: Spotify pre-save counts and links per row', () => {
  it('reads the Pre-Save badge and which players are lit', () => {
    const p = parseTracklist(SET, MATRODA)
    const byId = new Map(p.rows.map((r) => [r.mediaId, r]))
    expect(byId.get('877907')).toMatchObject({ presaveCount: 108, hasYoutube: false, hasSpotify: false })
    expect(byId.get('843714')).toMatchObject({ presaveCount: 144, hasYoutube: true, hasSpotify: false })
    expect(byId.get('909720')).toMatchObject({ hasYoutube: true, hasSpotify: true })
    // The named track list keeps its old shape.
    expect(p.tracks[0]).not.toHaveProperty('presaveCount')
  })
})

describe('updatePresaveCandidates', () => {
  it('only from a verified list; keeps rows with pre-saves and no YouTube or Spotify link', async () => {
    const env = makeEnv()
    const p = parseTracklist(SET, MATRODA)
    expect((await updatePresaveCandidates(env, SET, p)).status).toBe('not_verified')
    await verify(env, p)
    const r = await updatePresaveCandidates(env, SET, p, { warn: (e: string, f: unknown) => console.log('WARN', e, JSON.stringify(f)), info() {}, error() {} } as any, 1000)
    expect(r.status).toBe('updated')
    const got = await rows(env)
    expect(got.map((x: any) => [x.key, x.presave_count])).toEqual([
      ['track:877907', 108],
      ['track:877909', 80],
      ['track:918457', 62],
    ])
    expect(got[0]).toMatchObject({ artist: 'BLR', title: 'Lipstick (Matroda Remix)', is_id: 0 })
  })

  it('a later fetch updates the count, and drops a row that got a YouTube link', async () => {
    const env = makeEnv()
    const p = parseTracklist(SET, MATRODA)
    await verify(env, p)
    await updatePresaveCandidates(env, SET, p, undefined, 1000)
    const next = parseTracklist(SET, MATRODA)
    for (const r of next.rows) {
      if (r.mediaId === '877907') r.presaveCount = 120
      if (r.mediaId === '918457') r.hasYoutube = true
    }
    await updatePresaveCandidates(env, SET, next, undefined, 2000)
    const got = await rows(env)
    expect(got.map((x: any) => [x.key, x.presave_count])).toEqual([
      ['track:877907', 120],
      ['track:877909', 80],
    ])
    const first = await env.DB.prepare("SELECT first_seen_at, updated_at FROM presave_candidates WHERE key = 'track:877907'").first()
    expect(first).toEqual({ first_seen_at: 1000, updated_at: 2000 })
  })

  it('GET /ui/api/presaves/candidates: most pre-saves first; a pre-saved one carries its presave', async () => {
    const env = makeEnv()
    const p = parseTracklist(SET, MATRODA)
    await verify(env, p)
    await updatePresaveCandidates(env, SET, p, undefined, 1000)
    await env.DB.prepare("INSERT INTO presaves (track_id, artist, title, stage, source, created_at, updated_at) VALUES ('877909', 'Martha Wash', 'Catch The Light', 'links', 'ui', 1, 1)").run()
    const res = await app.request('https://tracked.example/ui/api/presaves/candidates', {}, env)
    expect(res.status).toBe(200)
    const d = (await res.json()) as { rows: Array<{ trackId: string; presaveCount: number; presaveId: number | null; presaveStage: string | null }> }
    expect(d.rows.map((r) => [r.trackId, r.presaveCount, r.presaveStage])).toEqual([
      ['877907', 108, null],
      ['877909', 80, 'links'],
      ['918457', 62, null],
    ])
    const onlyNew = (await (await app.request('https://tracked.example/ui/api/presaves/candidates?f.presaved=eq:0', {}, env)).json()) as { rows: unknown[] }
    expect(onlyNew.rows).toHaveLength(2)
  })
})
