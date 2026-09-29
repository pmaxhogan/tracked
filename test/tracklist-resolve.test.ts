import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'
import type { Env } from '../src/types'
import { makeLogger } from '../src/lib/log'
import { resolveTrackMediaLinks, resolveTracklistPage, TRACKLIST_CV } from '../src/lib/tracklist-resolve'
import { DecoyTracklistError } from '../src/lib/tracklists1001'

const here = dirname(fileURLToPath(import.meta.url))
const fx = (name: string) => readFileSync(resolve(here, 'fixtures', name), 'utf8')
const POOL = 'https://tlpool.example'
const TL = 'https://www.1001tracklists.com/tracklist/1pqq0hst/adam-beyer-drumcode-839.html'

function makeEnv(): Env {
  return { CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k', TLPOOL_URL: POOL, TLPOOL_TOKEN: 'tok' } as Env
}

/** tlpool answers every 1001tl fetch with `html` (or with `error` when given). */
function proxyServes(html: string, error?: string) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      calls.push(url)
      if (url === `${POOL}/fetch`) {
        const req = JSON.parse(String(init.body))
        const body = error ? { error, retryAfterSeconds: 60 } : { status: 200, finalUrl: req.url, html, accountId: 'acct-1', exitLabel: 'x', fetchedAt: new Date().toISOString(), bytes: html.length }
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`unexpected fetch ${url}`)
    }),
  )
  return calls
}

afterEach(() => vi.unstubAllGlobals())

describe('resolveTracklistPage', () => {
  it('caches a real page under the current cache version', async () => {
    const env = makeEnv()
    proxyServes(fx('tracklist-matroda.html'))
    const r = await resolveTracklistPage(env, TL, makeLogger({ task: 'test' }))
    expect(r.tracks.length).toBeGreaterThan(20)
    expect(await env.CACHE.get(`tl:v${TRACKLIST_CV.tracklist}:1pqq0hst`)).not.toBeNull()
  })

  it('caches every page row too (anonymous "ID - ID" rows included), for /now-playing; a cached entry from before rows existed still serves', async () => {
    const env = makeEnv()
    proxyServes(fx('tracklist-matroda.html'))
    const r = await resolveTracklistPage(env, TL, makeLogger({ task: 'test' }))
    expect(r.rows).toHaveLength(r.tracks.length) // no anonymous rows on this page
    expect(TRACKLIST_CV.tracklist).toBe(4)
    const cached = JSON.parse((await env.CACHE.get(`tl:v4:1pqq0hst`))!)
    expect(cached.rows).toHaveLength(r.tracks.length)
  })

  it('refuses a decoy page — throws DecoyTracklistError and caches nothing', async () => {
    const env = makeEnv()
    proxyServes(fx('tracklist-decoy-dcr839.html'))
    const err = await resolveTracklistPage(env, TL, makeLogger({ task: 'test' })).catch((e) => e)
    expect(err).toBeInstanceOf(DecoyTracklistError)
    expect((err as DecoyTracklistError).message).toMatch(/decoy/)
    expect((err as DecoyTracklistError).mismatched).toBe(24)
    expect((err as DecoyTracklistError).named).toBe(25)
    expect(await env.CACHE.list({ prefix: 'tl:' })).toMatchObject({ keys: [] })
  })
})

describe('resolveTrackMediaLinks', () => {
  it('caches links the pool served, but never a refusal', async () => {
    const env = makeEnv()
    proxyServes('', 'budget_exhausted')
    const refused = await resolveTrackMediaLinks(env, '909720', makeLogger({ task: 'test' }))
    expect(refused).toEqual({ appleLink: null, youtubeLink: null, soundcloudLink: null })
    expect(await env.CACHE.get(`ml:v${TRACKLIST_CV.medialink}:909720`)).toBeNull()
    vi.unstubAllGlobals()
    proxyServes(fx('medialink-909720.json'))
    const ok = await resolveTrackMediaLinks(env, '909720', makeLogger({ task: 'test' }))
    expect(ok.appleLink ?? ok.youtubeLink).toBeTruthy()
    expect(await env.CACHE.get(`ml:v${TRACKLIST_CV.medialink}:909720`)).not.toBeNull()
  })
})
