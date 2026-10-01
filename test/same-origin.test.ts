/**
 * CSRF guard on the Access-gated admin API (middleware/same-origin.ts), through
 * the real app, and the pages' own fetches passing it.
 */
import { describe, it, expect } from 'vitest'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'
import type { Env } from '../src/types'
import { sameOriginCheck } from '../src/middleware/same-origin'
import { app } from '../src/index'

const ORIGIN = 'https://tracked.example'
function makeEnv(): Env {
  return { CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV(), API_TOKEN: 'tasker', YOUTUBE_API_KEY: 'k', DEV_BYPASS_CF_ACCESS: '1' } as Env
}
const call = (path: string, init: RequestInit, env = makeEnv()) => app.request(`${ORIGIN}${path}`, init, env)
// A state-changing admin route with no upstream: 400 on a bad body proves the request got past the guard.
const ROUTE = '/ui/api/tracklist/links'

describe('sameOriginCheck', () => {
  const req = (method: string, headers: Record<string, string>) => new Request(`${ORIGIN}/ui/api/x`, { method, headers })
  it('lets safe methods through untouched', () => {
    expect(sameOriginCheck(req('GET', {}))).toEqual({ ok: true })
  })
  it('requires this origin: Sec-Fetch-Site same-origin, else a matching Origin', () => {
    expect(sameOriginCheck(req('POST', { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }))).toEqual({ ok: true })
    expect(sameOriginCheck(req('POST', { origin: ORIGIN, 'content-type': 'application/json' }))).toEqual({ ok: true })
    expect(sameOriginCheck(req('POST', { origin: 'https://evil.example', 'content-type': 'application/json' }))).toMatchObject({ ok: false, status: 403 })
    expect(sameOriginCheck(req('POST', { 'sec-fetch-site': 'same-site', origin: ORIGIN, 'content-type': 'application/json' }))).toMatchObject({ ok: false, status: 403 })
    expect(sameOriginCheck(req('POST', { 'content-type': 'application/json' }))).toMatchObject({ ok: false, status: 403 })
  })
  it('requires a JSON body type (a form cannot send one)', () => {
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '']) {
      expect(sameOriginCheck(req('PUT', { origin: ORIGIN, ...(ct ? { 'content-type': ct } : {}) }))).toMatchObject({ ok: false, status: 415 })
    }
    expect(sameOriginCheck(req('DELETE', { origin: ORIGIN, 'content-type': 'application/json; charset=utf-8' }))).toEqual({ ok: true })
  })
})

describe('the guard on /ui/api/* (real app)', () => {
  it('refuses a cross-site form post before any handler runs', async () => {
    const r = await call(ROUTE, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'trackIds=1' })
    expect(r.status).toBe(403)
    expect(await r.json()).toMatchObject({ error: 'cross_origin' })
  })
  it('refuses a same-origin text/plain post (what a no-preflight fetch would send)', async () => {
    const r = await call(ROUTE, { method: 'POST', headers: { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'text/plain' }, body: '{"trackIds":[]}' })
    expect(r.status).toBe(415)
  })
  it('lets a same-origin JSON request reach the route', async () => {
    const r = await call(ROUTE, { method: 'POST', headers: { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' }, body: '{}' })
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ error: 'missing_track_ids' })
  })
  it('covers every branch\'s admin routes (pool, mkvid, playlist hygiene, pool settings, ban)', async () => {
    for (const [method, path] of <Array<[string, string]>>[
      ['POST', '/ui/api/pool/accounts/acct-1/retire'],
      ['POST', '/ui/api/mkvid/recreate/abc'],
      ['POST', '/ui/api/set/remove-replace'],
      ['PUT', '/ui/api/pool/settings'],
      ['POST', '/ui/api/ban/clear'],
      ['POST', '/ui/api/tracklist/purge'],
    ]) {
      const r = await call(path, { method, headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' })
      expect([path, r.status]).toEqual([path, 403])
    }
  })
  it('leaves GETs and the bearer routes alone', async () => {
    expect((await call('/ui/api/pool/settings', { method: 'GET' })).status).toBe(200)
    // Tasker's bearer route: no Origin, no Sec-Fetch-Site; the bearer gate answers, not the CSRF guard.
    const r = await call('/tracklist/purge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(r.status).toBe(401)
  })
})

describe('the admin pages send what the guard wants', () => {
  const pages = ['/ui', '/ui/djs', '/ui/playlists', '/ui/set', '/ui/dj/some-dj', '/ui/removed', '/ui/mkvid', '/ui/pool', '/ui/pool/settings', '/ui/captcha', '/ui/captcha/ch-1', '/ui/settings', '/ui/tools']
  it.each(pages)('%s: every POST/PUT/DELETE fetch carries a JSON content type', async (path) => {
    const html = await (await call(path, {})).text()
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!).join('\n')
    const bad: string[] = []
    let seen = 0
    for (const m of scripts.matchAll(/method:\s*'(POST|PUT|DELETE|PATCH)'/g)) {
      // The init object literal around the method.
      const start = scripts.lastIndexOf('{', m.index!)
      const end = scripts.indexOf('}', scripts.indexOf('}', m.index!) + 1)
      const init = scripts.slice(start, end + 1)
      seen++
      if (!/content-type':\s*'application\/json'/i.test(init)) bad.push(init.slice(0, 160))
    }
    expect(bad).toEqual([])
    // The scan really sees the fetches (the pool pages build theirs with jsonInit, which sets the type).
    if (path === '/ui') expect(seen).toBeGreaterThan(2)
    if (path === '/ui/pool') expect(scripts).toContain("headers: { 'content-type': 'application/json' }")
  })
})

describe('the guard also covers POST /ui/oauth/disconnect', () => {
  it('refuses a cross-site disconnect before it reaches the route', async () => {
    const r = await call('/ui/oauth/disconnect', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' })
    expect(r.status).toBe(403)
  })
})
