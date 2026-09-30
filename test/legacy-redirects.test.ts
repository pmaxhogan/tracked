import { describe, it, expect } from 'vitest'
import { app } from '../src/index'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'
import type { Env } from '../src/types'

const locked = () => ({ CACHE: fakeKV(), SUBS: fakeKV(), DB: fakeD1(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k',
  CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CF_ACCESS_AUD: 'aud', CF_ACCESS_ALLOWED_EMAILS: 'owner@example.com' }) as unknown as Env
const bypass = () => ({ ...locked(), DEV_BYPASS_CF_ACCESS: '1' }) as unknown as Env
const get = (path: string, init: RequestInit = {}) => app.request(`https://tracked.example${path}`, init, locked())

describe('the old /subscriptions prefix', () => {
  it.each([
    ['/subscriptions', '/ui'],
    ['/subscriptions/', '/ui/'],
    ['/subscriptions/pool', '/ui/pool'],
    ['/subscriptions/captcha/ch-1', '/ui/captcha/ch-1'],
    ['/subscriptions/removed', '/ui/removed'],
    ['/subscriptions/dj/some-dj', '/ui/dj/some-dj'],
    ['/subscriptions/tracklist?url=https%3A%2F%2Fx.example%2Fa.html', '/ui/set?url=https%3A%2F%2Fx.example%2Fa.html'],
  ])('%s answers 301 to %s without Access and without content', async (from, to) => {
    const r = await get(from)
    expect(r.status).toBe(301)
    expect(r.headers.get('location')).toBe(to)
  })
  it.each(['/subscriptions/api/list', '/subscriptions/api/pool/status', '/subscriptions/oauth/callback?code=x', '/subscriptions/sw.js'])('%s answers 410 moved', async (path) => {
    const r = await get(path)
    expect(r.status).toBe(410)
    const body = await r.json() as { error: string; message: string }
    expect(body.error).toBe('moved')
    expect(body.message).toContain('/ui/')
  })
  it('a POST to the old API is refused with 410, not redirected', async () => {
    const r = await get('/subscriptions/api/add', { method: 'POST', headers: { 'content-type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, body: '{}' })
    expect(r.status).toBe(410)
  })
  it('GET / redirects to /ui/ without the bearer token', async () => {
    const r = await get('/')
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('/ui/')
  })
  it('/ui and /ui/ both need Access', async () => {
    expect((await get('/ui/')).status).toBe(401)
  })
  it('/ui/tracklist keeps working as a redirect to /ui/set', async () => {
    const r = await get('/ui/tracklist?url=x')
    expect([301, 401]).toContain(r.status) // behind Access: 401 here; with the bypass it is a 301
  })
  it('the new prefix is behind Access and the bearer routes are untouched', async () => {
    expect((await get('/ui')).status).toBe(401)
    expect((await get('/ui/api/list')).status).toBe(401)
    expect((await get('/now-playing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401)
  })
})

describe('the new prefix with the Access bypass', () => {
  it.each(['/ui', '/ui/'])('%s answers 200 with no-store', async (path) => {
    const r = await app.request(`https://tracked.example${path}`, {}, bypass())
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(r.headers.get('x-frame-options')).toBeTruthy()
    expect(await r.text()).toContain('<!doctype html>')
  })
  it.each(['/ui/djs', '/ui/playlists', '/ui/mkvid', '/ui/settings', '/ui/tools', '/ui/set'])('%s serves a page for now', async (path) => {
    const r = await app.request(`https://tracked.example${path}`, {}, bypass())
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('no-store')
  })
  it('/ui/tracklist is a 301 to /ui/set keeping the query', async () => {
    const r = await app.request('https://tracked.example/ui/tracklist?url=x', {}, bypass())
    expect(r.status).toBe(301)
    expect(r.headers.get('location')).toBe('/ui/set?url=x')
  })
})
