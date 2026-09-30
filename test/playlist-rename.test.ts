import { describe, it, expect, vi, afterEach } from 'vitest'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'
import type { Env } from '../src/types'
import { artistPlaylistTitle, fixPlaylistTitles, stripTracklistsBy } from '../src/lib/playlist-rename'
import { app } from '../src/index'

type Pl = { id: string; snippet: { title: string; description: string; defaultLanguage?: string }; status: { privacyStatus: string } }

/** YouTube playlists.list / playlists.update stand-in over an in-memory set of playlists. Records the update bodies. */
function mockYouTube(playlists: Pl[], opts: { failUpdate?: string } = {}) {
  const updates: Array<{ url: string; body: Record<string, any> }> = []
  const byId = new Map(playlists.map((p) => [p.id, p]))
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/playlists') && (!init?.method || init.method === 'GET')) {
      const ids = (url.searchParams.get('id') ?? '').split(',')
      return Response.json({ items: ids.map((id) => byId.get(id)).filter(Boolean) })
    }
    if (url.pathname.endsWith('/playlists') && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body))
      updates.push({ url: String(input), body })
      if (body.id === opts.failUpdate) return Response.json({ error: { code: 403, message: 'forbidden' } }, { status: 403 })
      const p = byId.get(body.id)!
      p.snippet = { ...p.snippet, ...body.snippet }
      return Response.json(p)
    }
    throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`)
  }) as unknown as typeof fetch
  return { fetcher, updates, byId }
}

async function seed(env: Env) {
  const ins = env.DB.prepare('INSERT INTO sub_sync (slug, playlist_id, artist_name) VALUES (?, ?, ?)')
  await ins.bind('habstrakt', 'PL1', 'Tracklists By Habstrakt').run() // stored name still has the prefix
  await ins.bind('matroda', 'PL2', 'Matroda').run() // name already corrected by a DJ page fetch, title not
  await ins.bind('lilly', 'PL3', 'Lilly Palmer').run() // title fine
}
const playlists = (): Pl[] => [
  { id: 'PL1', snippet: { title: 'Tracklists By Habstrakt (1001tklists)', description: 'Every set Habstrakt…', defaultLanguage: 'en' }, status: { privacyStatus: 'public' } },
  { id: 'PL2', snippet: { title: 'Tracklists By Matroda (1001tklists)', description: 'Matroda sets' }, status: { privacyStatus: 'unlisted' } },
  { id: 'PL3', snippet: { title: 'Lilly Palmer (1001tklists)', description: '' }, status: { privacyStatus: 'public' } },
]
const makeEnv = (): Env => ({ CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k', DEV_BYPASS_CF_ACCESS: '1' }) as Env

afterEach(() => vi.unstubAllGlobals())

describe('playlist title fix (seam 8)', () => {
  it('the title helper matches what a fresh creation uses, and strips the prefix', () => {
    expect(artistPlaylistTitle('Habstrakt')).toBe('Habstrakt (1001tklists)')
    expect(stripTracklistsBy('Tracklists By  Habstrakt ')).toBe('Habstrakt')
  })

  it('a dry run (the default) lists old and new titles and changes nothing', async () => {
    const env = makeEnv()
    await seed(env)
    const yt = mockYouTube(playlists())
    const r = await fixPlaylistTitles(env, 'tok', { fetcher: yt.fetcher })
    expect(r).toMatchObject({ dryRun: true, checked: 3 })
    expect(r.fixes).toEqual([
      { slug: 'habstrakt', playlistId: 'PL1', oldTitle: 'Tracklists By Habstrakt (1001tklists)', newTitle: 'Habstrakt (1001tklists)', status: 'would_rename' },
      { slug: 'matroda', playlistId: 'PL2', oldTitle: 'Tracklists By Matroda (1001tklists)', newTitle: 'Matroda (1001tklists)', status: 'would_rename' },
    ])
    expect(yt.updates).toEqual([])
    expect((await env.DB.prepare("SELECT artist_name FROM sub_sync WHERE slug = 'habstrakt'").first<{ artist_name: string }>())!.artist_name).toBe('Tracklists By Habstrakt')
  })

  it('dryRun false renames with playlists.update, keeping description, privacy and language; fixes the stored name', async () => {
    const env = makeEnv()
    await seed(env)
    const yt = mockYouTube(playlists())
    const r = await fixPlaylistTitles(env, 'tok', { dryRun: false, fetcher: yt.fetcher })
    expect(r.fixes.map((f) => f.status)).toEqual(['renamed', 'renamed'])
    expect(yt.updates.map((u) => u.body)).toEqual([
      { id: 'PL1', snippet: { title: 'Habstrakt (1001tklists)', description: 'Every set Habstrakt…', defaultLanguage: 'en' }, status: { privacyStatus: 'public' } },
      { id: 'PL2', snippet: { title: 'Matroda (1001tklists)', description: 'Matroda sets' }, status: { privacyStatus: 'unlisted' } },
    ])
    expect(yt.updates[0]!.url).toContain('part=snippet,status')
    expect((await env.DB.prepare("SELECT artist_name FROM sub_sync WHERE slug = 'habstrakt'").first<{ artist_name: string }>())!.artist_name).toBe('Habstrakt')
    // Idempotent: nothing left to do.
    expect((await fixPlaylistTitles(env, 'tok', { dryRun: false, fetcher: yt.fetcher })).fixes).toEqual([])
  })

  it('a rename YouTube refuses is reported as failed and the others still go through', async () => {
    const env = makeEnv()
    await seed(env)
    const yt = mockYouTube(playlists(), { failUpdate: 'PL1' })
    const r = await fixPlaylistTitles(env, 'tok', { dryRun: false, fetcher: yt.fetcher })
    expect(r.fixes.map((f) => [f.slug, f.status])).toEqual([['habstrakt', 'failed'], ['matroda', 'renamed']])
    expect((await env.DB.prepare("SELECT artist_name FROM sub_sync WHERE slug = 'habstrakt'").first<{ artist_name: string }>())!.artist_name).toBe('Tracklists By Habstrakt')
  })

  it('POST /subscriptions/api/playlists/fix-titles: Access-gated, dry run by default, answers old and new titles', async () => {
    const env = makeEnv()
    await seed(env)
    await env.SUBS.put('oauth:google', JSON.stringify({ accessToken: 'tok', refreshToken: 'r', expiresAt: Math.floor(Date.now() / 1000) + 3600, scope: 's', channelId: null, channelTitle: null, connectedAt: 0 }))
    const yt = mockYouTube(playlists())
    vi.stubGlobal('fetch', yt.fetcher)
    const post = (e: Env, body: unknown) => app.request('http://x/subscriptions/api/playlists/fix-titles', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, body: JSON.stringify(body) }, e)
    const dry = await post(env, {})
    expect(dry.status).toBe(200)
    expect(((await dry.json()) as any).fixes).toHaveLength(2)
    expect(yt.updates).toHaveLength(0)
    expect((await post(env, { dryRun: 'no' })).status).toBe(400)
    const real = (await (await post(env, { dryRun: false })).json()) as any
    expect(real.fixes.map((f: any) => f.newTitle)).toEqual(['Habstrakt (1001tklists)', 'Matroda (1001tklists)'])
    expect(yt.updates).toHaveLength(2)
    // Without Access (no dev bypass, no JWT) it is refused.
    const locked = { ...env, DEV_BYPASS_CF_ACCESS: undefined, CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CF_ACCESS_AUD: 'aud', CF_ACCESS_ALLOWED_EMAILS: 'a@example.com' } as Env
    expect([401, 403]).toContain((await post(locked, {})).status)
    // The main page has the button.
    const page = await (await app.request('http://x/subscriptions', {}, env)).text()
    expect(page).toContain('id="fix-titles"')
    expect(page).toContain('/subscriptions/api/playlists/fix-titles')
  })
})
