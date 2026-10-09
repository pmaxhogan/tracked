/**
 * Media link budget (seam 9): the admin viewers never look up per-track links
 * on load. Links come from POST /ui/api/tracklist/links, one row or
 * one "Load links" batch at a time, at pool priority `recheck`, cached per
 * track id for 30 days.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'
import type { Env } from '../src/types'
import { TTL } from '../src/lib/cache'
import { app } from '../src/index'

const here = dirname(fileURLToPath(import.meta.url))
const fx = (name: string) => readFileSync(resolve(here, 'fixtures', name), 'utf8')
const POOL = 'https://tlpool.example'
const SET = 'https://www.1001tracklists.com/tracklist/18kll1h1/habstrakt-jstjr-1001tracklists-x-dj-lovers-club-pres.-waterways-amsterdam-dance-event-netherlands-2024-11-11.html'

function makeEnv(): Env {
  return { CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k', TLPOOL_URL: POOL, TLPOOL_TOKEN: 'pt', DEV_BYPASS_CF_ACCESS: '1' } as Env
}

/** tlpool stub: set pages get the habstrakt fixture, medialink lookups the 909720 answer. Records every /fetch body. */
function poolStub() {
  const calls: Array<{ url: string; kind: string; priority: string }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `${POOL}/fetch`) {
        const body = JSON.parse(String(init!.body)) as { url: string; kind: string; priority: string }
        calls.push({ url: body.url, kind: body.kind, priority: body.priority })
        const html = body.kind === 'medialink' ? fx('medialink-909720.json') : fx('tracklist-habstrakt.html')
        return Response.json({ status: 200, finalUrl: body.url, html, accountId: 'acct-1', exitLabel: 'exit-a', fetchedAt: new Date().toISOString(), bytes: html.length })
      }
      if (url.startsWith('https://itunes.apple.com/')) return Response.json({ resultCount: 0, results: [] })
      throw new Error(`unexpected fetch ${url}`)
    }),
  )
  return calls
}

const post = (env: Env, path: string, body: unknown) =>
  app.request(`http://x${path}`, { method: 'POST', headers: { Origin: 'http://x', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env)

afterEach(() => vi.unstubAllGlobals())

describe('lazy per-track links', () => {
  it('loading a set in the viewer costs one set page and no media link lookup', async () => {
    const env = makeEnv()
    const calls = poolStub()
    const res = await post(env, '/ui/api/tracklist', { url: SET })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tracks: Array<{ trackId: string | null; appleLink: string | null }> }
    expect(body.tracks.length).toBe(31)
    expect(body.tracks.every((t) => t.appleLink === null)).toBe(true)
    expect(calls.map((c) => c.kind)).toEqual(['set'])
  })

  it('the links endpoint looks each id up once at priority recheck, then serves it from a 30-day cache', async () => {
    const env = makeEnv()
    const calls = poolStub()
    const ttls: Record<string, number | undefined> = {}
    const put = env.CACHE.put.bind(env.CACHE)
    env.CACHE.put = (async (k: string, v: string, o?: KVNamespacePutOptions) => ((ttls[k] = o?.expirationTtl), put(k, v, o))) as KVNamespace['put']

    const r1 = await post(env, '/ui/api/tracklist/links', { trackIds: ['909720', '123456'] })
    expect(r1.status).toBe(200)
    const d1 = (await r1.json()) as { links: Record<string, { appleLink: string | null; youtubeLink: string | null }> }
    expect(Object.keys(d1.links).sort()).toEqual(['123456', '909720'])
    expect(d1.links['909720']!.appleLink ?? d1.links['909720']!.youtubeLink).toBeTruthy()
    expect(calls).toHaveLength(2)
    expect(calls.every((c) => c.kind === 'medialink' && c.priority === 'recheck')).toBe(true)
    expect(ttls['ml:v1:909720']).toBe(30 * 86400)
    expect(TTL.MEDIALINK).toBe(30 * 86400)

    const r2 = await post(env, '/ui/api/tracklist/links', { trackIds: ['909720', '123456'] })
    expect(r2.status).toBe(200)
    expect(calls).toHaveLength(2) // both served from cache
  })

  it('refuses empty, non-numeric and oversized requests without touching the pool', async () => {
    const env = makeEnv()
    const calls = poolStub()
    expect((await post(env, '/ui/api/tracklist/links', {})).status).toBe(400)
    expect((await post(env, '/ui/api/tracklist/links', { trackIds: ['../x'] })).status).toBe(400)
    expect((await post(env, '/ui/api/tracklist/links', { trackIds: Array.from({ length: 26 }, (_, i) => String(1000 + i)) })).status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('both viewers ship the lazy links UI, with the digit regex intact and scripts that parse', async () => {
    const env = makeEnv()
    for (const path of ['/ui/set', '/ui/dj/habstrakt']) {
      const page = await (await app.request(`http://x${path}`, {}, env)).text()
      expect(page).toContain('/ui/api/tracklist/links')
      expect(page).toContain('/^\\d+$/.test(String(r.trackId))') // a template-literal escape slip would leave /^d+$/
      expect(page).toContain('Load links')
      const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
      for (const js of scripts) expect(() => new Function(js)).not.toThrow()
    }
  })
})
