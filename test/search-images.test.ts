/**
 * Search follow-ups: one result per track (merged on the 1001tracklists link,
 * a linkless backfilled row joining its linked twin), relevance scores, and
 * result thumbnails (src/lib/search/images.ts: index → search_images → R2).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/types'
import { app } from '../src/index'
import { indexSet, type IndexSetInput, type IndexTrack } from '../src/lib/search/index'
import { extractPageImage, imageKey, imagePath, MAX_IMAGE_BYTES, serveImage, usableImageUrl } from '../src/lib/search/images'
import { search } from '../src/lib/search/query'
import { fakeD1 } from './helpers/fake-d1'
import { fakeKV } from './helpers/fake-kv'
import { fakeR2 } from './helpers/fake-r2'

const NOW = Math.floor(Date.now() / 1000)
const TL = 'https://www.1001tracklists.com/tracklist'
const PDS_URL = 'https://www.1001tracklists.com/track/91qu62qx/lilly-palmer-party-dont-stop/index.html'
const ART = 'https://geo-media.beatport.com/image_size/300x300/aaaa-bbbb.jpg'
const DJ_IMG = 'https://i1.sndcdn.com/avatars-lillypalmer-t500x500.jpg'

function makeEnv(over: Partial<Env> = {}): Env {
  return { CACHE: fakeKV(), SUBS: fakeKV(), DB: fakeD1(), SEARCH_DB: fakeD1({ migrations: 'search' }), IMAGES: fakeR2(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k', DEV_BYPASS_CF_ACCESS: '1', ...over } as Env
}

const trk = (o: Partial<IndexTrack> & Pick<IndexTrack, 'artist' | 'title'>): IndexTrack => ({ trackId: null, trackUrl: null, label: null, artworkUrl: null, cueSeconds: 60, layered: false, ...o })
const setIn = (o: Partial<IndexSetInput> & Pick<IndexSetInput, 'setUrl' | 'tracks'>): IndexSetInput => ({
  djSlug: 'lillypalmer', djName: 'Lilly Palmer', title: 'Lilly Palmer @ Somewhere', setDate: '2026-05-16', videoId: null, videoSource: null,
  trackCount: o.tracks.length, idedCount: o.tracks.length, source: 'page', imageUrl: null, ...o,
})

async function subscribe(env: Env, slug: string, name: string) {
  await env.DB.prepare('INSERT INTO subscriptions (slug, source_url, added_at, position) VALUES (?, ?, 0, 0)').bind(slug, `https://www.1001tracklists.com/dj/${slug}/`).run()
  await env.DB.prepare('INSERT INTO sub_sync (slug, artist_name) VALUES (?, ?)').bind(slug, name).run()
}

const q = (text: string, kind: 'all' | 'tracks' | 'sets' | 'djs' = 'all') => ({ q: text, kind, limit: 20, exact: false })

afterEach(() => vi.unstubAllGlobals())

describe('one result per track', () => {
  it('a backfilled linkless row joins the linked row with the same artist + title: one result, every set, the label kept', async () => {
    const env = makeEnv()
    await subscribe(env, 'lillypalmer', 'Lilly Palmer')
    // A verified page: the 1001tl id, link and label.
    await indexSet(env, setIn({ setUrl: `${TL}/a1/lilly-palmer-ultra-japan-2026-09-20.html`, setDate: '2026-09-20', tracks: [trk({ trackId: '1077047', trackUrl: PDS_URL, artist: 'Lilly Palmer', title: "Party Don't Stop", label: 'ARMADA / KONTOR / SPANNUNG' })] }), NOW)
    // Two backfilled mkvid lists: no id, no link, no label (hash key by name).
    await indexSet(env, setIn({ setUrl: `${TL}/b1/lilly-palmer-saga-2026-08-22.html`, setDate: '2026-08-22', source: 'mkvid', tracks: [trk({ artist: 'Lilly Palmer', title: "Party Don't Stop", artworkUrl: ART })] }), NOW)
    await indexSet(env, setIn({ setUrl: `${TL}/b2/lilly-palmer-awakenings-2025-06-28.html`, setDate: '2025-06-28', source: 'mkvid', tracks: [trk({ artist: 'Lilly Palmer', title: "Party Don't Stop" })] }), NOW)
    expect((await env.SEARCH_DB!.prepare('SELECT COUNT(*) AS n FROM search_tracks').first('n'))).toBe(2)

    const r = await search(env, q('dont stop', 'tracks'))
    expect(r.tracks).toHaveLength(1)
    const t = r.tracks[0]!
    expect(t).toMatchObject({ trackKey: 't:1077047', trackId: '1077047', trackUrl: PDS_URL, label: 'ARMADA / KONTOR / SPANNUNG', image: imagePath(await imageKey(ART)) })
    expect(t.sets.map((s) => s.date)).toEqual(['2026-09-20', '2026-08-22', '2025-06-28'])
  })

  it('rows with the same link merge; two different links stay two results', async () => {
    const env = makeEnv()
    await subscribe(env, 'lillypalmer', 'Lilly Palmer')
    await indexSet(env, setIn({ setUrl: `${TL}/a1/x-2026-09-20.html`, tracks: [trk({ trackId: '11', trackUrl: PDS_URL, artist: 'Lilly Palmer', title: "Party Don't Stop" })] }), NOW)
    await indexSet(env, setIn({ setUrl: `${TL}/a2/y-2026-09-21.html`, tracks: [trk({ trackId: '12', trackUrl: PDS_URL, artist: 'Lilly Palmer', title: "Party Don't Stop (Extended)" })] }), NOW)
    await indexSet(env, setIn({ setUrl: `${TL}/a3/z-2026-09-22.html`, tracks: [trk({ trackId: '13', trackUrl: 'https://www.1001tracklists.com/track/zzz/other/index.html', artist: 'Lilly Palmer', title: "Party Don't Stop" })] }), NOW)
    const r = await search(env, q('party dont stop', 'tracks'))
    expect(r.tracks).toHaveLength(2)
    expect(r.tracks.find((t) => t.trackUrl === PDS_URL)!.sets).toHaveLength(2)
  })
})

describe('relevance scores', () => {
  it('every item carries a score: ~1 for an exact match in a top field, lower for a partial one', async () => {
    const env = makeEnv()
    await subscribe(env, 'oddmob', 'Odd Mob')
    await indexSet(env, setIn({ setUrl: `${TL}/o1/odd-mob-edc-2025-05-18.html`, djSlug: 'oddmob', djName: 'Odd Mob', title: 'Odd Mob @ stereoBLOOM, EDC Las Vegas 2025-05-18', tracks: [trk({ trackId: '21', trackUrl: 'https://www.1001tracklists.com/track/a/x/index.html', artist: 'Odd Mob', title: 'Get Busy' }), trk({ trackId: '22', trackUrl: 'https://www.1001tracklists.com/track/b/y/index.html', artist: 'Someone', title: 'Odd Song' })] }), NOW)
    const r = await search(env, q('odd mob'))
    expect(r.djs[0]!.score).toBeGreaterThanOrEqual(0.99)
    const byTitle = Object.fromEntries(r.tracks.map((t) => [t.title, t.score]))
    expect(byTitle['Get Busy']).toBeGreaterThanOrEqual(1)
    expect(byTitle['Get Busy']).toBeLessThan(1.3)
    expect(r.sets[0]!.score).toBeGreaterThanOrEqual(1)
  })
})

describe('thumbnails', () => {
  it('index registers the set image and track artwork; results link /ui/img/<key>; a DJ and an imageless set use the newest set image of that DJ', async () => {
    const env = makeEnv()
    await subscribe(env, 'lillypalmer', 'Lilly Palmer')
    await indexSet(env, setIn({ setUrl: `${TL}/a1/lilly-palmer-ultra-2026-09-20.html`, title: 'Lilly Palmer @ Ultra', setDate: '2026-09-20', imageUrl: DJ_IMG, tracks: [trk({ trackId: '31', trackUrl: 'https://www.1001tracklists.com/track/c/z/index.html', artist: 'Lilly Palmer', title: 'Before I Go', artworkUrl: ART })] }), NOW)
    await indexSet(env, setIn({ setUrl: `${TL}/a2/lilly-palmer-saga-2025-08-22.html`, title: 'Lilly Palmer @ SAGA', setDate: '2025-08-22', source: 'mkvid', tracks: [trk({ artist: 'Amelie Lens', title: 'Feel It' })] }), NOW)
    const keys = await env.SEARCH_DB!.prepare('SELECT key, src FROM search_images ORDER BY src').all<{ key: string; src: string }>()
    expect(keys.results).toEqual([{ key: await imageKey(ART), src: ART }, { key: await imageKey(DJ_IMG), src: DJ_IMG }].sort((a, b) => (a.src < b.src ? -1 : 1)))

    const r = await search(env, q('lilly palmer'))
    const djImg = imagePath(await imageKey(DJ_IMG))
    expect(r.djs[0]).toMatchObject({ slug: 'lillypalmer', image: djImg })
    expect(r.sets.find((s) => s.title === 'Lilly Palmer @ Ultra')!.image).toBe(djImg)
    expect(r.sets.find((s) => s.title === 'Lilly Palmer @ SAGA')!.image).toBe(djImg)
    expect(r.tracks.find((t) => t.title === 'Before I Go')!.image).toBe(imagePath(await imageKey(ART)))
    expect(r.tracks.find((t) => t.title === 'Feel It')?.image ?? null).toBeNull()
  })

  it('a re-index without an image keeps the stored one', async () => {
    const env = makeEnv()
    const url = `${TL}/a1/x-2026-09-20.html`
    const t = trk({ trackId: '41', trackUrl: 'https://www.1001tracklists.com/track/d/w/index.html', artist: 'A', title: 'B' })
    await indexSet(env, setIn({ setUrl: url, imageUrl: DJ_IMG, tracks: [{ ...t, artworkUrl: ART }] }), NOW)
    await indexSet(env, setIn({ setUrl: url, imageUrl: null, tracks: [t] }), NOW + 1)
    expect(await env.SEARCH_DB!.prepare('SELECT image_url FROM search_sets').first('image_url')).toBe(DJ_IMG)
    expect(await env.SEARCH_DB!.prepare('SELECT artwork_url FROM search_tracks').first('artwork_url')).toBe(ART)
  })

  it('extractPageImage takes og:image, never the 1001tracklists logo; usableImageUrl wants https on a named host', () => {
    expect(extractPageImage(`<meta property="og:image" content="${DJ_IMG}">`)).toBe(DJ_IMG)
    expect(extractPageImage('<meta property="og:image" content="https://cdn.1001tracklists.com/images/static/logo_blue_white_320x250.png">')).toBeNull()
    expect(extractPageImage('<title>x</title>')).toBeNull()
    expect(usableImageUrl('http://i1.sndcdn.com/a.jpg')).toBeNull()
    expect(usableImageUrl('https://127.0.0.1/a.jpg')).toBeNull()
    expect(usableImageUrl('https://localhost/a.jpg')).toBeNull()
    expect(usableImageUrl('https://i1.sndcdn.com:8443/a.jpg')).toBeNull()
    expect(usableImageUrl('not a url')).toBeNull()
    expect(usableImageUrl(ART)).toBe(ART)
  })
})

describe('GET /ui/img/<key>', () => {
  async function seeded(src: string) {
    const env = makeEnv()
    const key = await imageKey(src)
    await env.SEARCH_DB!.prepare('INSERT INTO search_images (key, src) VALUES (?, ?)').bind(key, src).run()
    return { env, key }
  }
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])

  it('copies the source into R2 on the first request, then serves R2 without fetching', async () => {
    const { env, key } = await seeded(ART)
    const fetchSpy = vi.fn(async () => new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } }))
    vi.stubGlobal('fetch', fetchSpy)
    const first = await app.request(`https://tracked.example/ui/img/${key}`, {}, env)
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toBe('image/jpeg')
    expect(first.headers.get('cache-control')).toContain('immutable')
    expect(first.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(jpeg)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect((fetchSpy.mock.calls[0] as unknown[])[0]).toBe(ART)
    const second = await app.request(`https://tracked.example/ui/img/${key}`, {}, env)
    expect(second.status).toBe(200)
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(jpeg)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('404s a malformed or unknown key, a non-image, an SVG, an oversized image, an upstream error, and no IMAGES binding', async () => {
    const { env, key } = await seeded(ART)
    const answer = (r: Response) => vi.stubGlobal('fetch', vi.fn(async () => r))
    expect((await serveImage(env, 'nothex')).status).toBe(404)
    expect((await serveImage(env, 'b'.repeat(32))).status).toBe(404)
    answer(new Response('<html>', { headers: { 'content-type': 'text/html' } }))
    expect((await serveImage(env, key)).status).toBe(404)
    answer(new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }))
    expect((await serveImage(env, key)).status).toBe(404)
    answer(new Response(new Uint8Array(MAX_IMAGE_BYTES + 1), { headers: { 'content-type': 'image/jpeg' } }))
    expect((await serveImage(env, key)).status).toBe(404)
    answer(new Response('nope', { status: 500, headers: { 'content-type': 'image/jpeg' } }))
    expect((await serveImage(env, key)).status).toBe(404)
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('timeout'))))
    expect((await serveImage(env, key)).status).toBe(404)
    expect((await serveImage({ ...env, IMAGES: undefined }, key)).status).toBe(404)
    expect(((env.IMAGES as unknown as { _store: Map<string, unknown> })._store).size).toBe(0)
  })

  it('follows a redirect only to a usable URL, at most 3 hops; a redirect to http or a bare IP stores nothing', async () => {
    const jpg = () => new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } })
    const to = (loc: string) => new Response(null, { status: 302, headers: { location: loc } })
    const store = (env: Env) => (env.IMAGES as unknown as { _store: Map<string, unknown> })._store

    for (const bad of ['http://evil.example/x.jpg', 'https://10.0.0.1/x.jpg', 'https://localhost/x.jpg', '']) {
      const { env, key } = await seeded(ART)
      const spy = vi.fn(async (u: string) => (u === ART ? to(bad) : jpg()))
      vi.stubGlobal('fetch', spy)
      expect((await serveImage(env, key)).status).toBe(404)
      expect(spy).toHaveBeenCalledTimes(1)
      expect((spy.mock.calls[0] as unknown[])[1]).toMatchObject({ redirect: 'manual' })
      expect(store(env).size).toBe(0)
    }

    // A relative redirect on a usable host is followed and stored.
    const ok = await seeded(ART)
    const spy = vi.fn(async (u: string) => (u === ART ? to('/image_size/300x300/moved.jpg') : jpg()))
    vi.stubGlobal('fetch', spy)
    expect((await serveImage(ok.env, ok.key)).status).toBe(200)
    expect((spy.mock.calls[1] as unknown[])[0]).toBe('https://geo-media.beatport.com/image_size/300x300/moved.jpg')
    expect(store(ok.env).size).toBe(1)

    // More than 3 redirects: given up, nothing stored.
    const loop = await seeded(ART)
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async () => to(`https://geo-media.beatport.com/hop${++n}.jpg`)))
    expect((await serveImage(loop.env, loop.key)).status).toBe(404)
    expect(n).toBe(4)
    expect(store(loop.env).size).toBe(0)
  })

  it('a stored source that is not usable (http) is never fetched', async () => {
    const { env, key } = await seeded('http://i1.sndcdn.com/a.jpg')
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    expect((await serveImage(env, key)).status).toBe(404)
    expect(spy).not.toHaveBeenCalled()
  })
})
