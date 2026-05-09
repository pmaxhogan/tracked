import { describe, it, expect, vi } from 'vitest'
import {
  addVideoToPlaylist,
  createPlaylist,
  findPlaylistByTitle,
  listPlaylistVideoIds,
} from '../src/lib/youtube-playlists'

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' }, ...init })
}

describe('findPlaylistByTitle', () => {
  it('returns the matching playlist on the first page', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        items: [
          { id: 'p1', snippet: { title: 'Other' } },
          { id: 'p2', snippet: { title: 'Lilly Palmer (1001tklists)' } },
        ],
      }),
    ) as unknown as typeof fetch
    const r = await findPlaylistByTitle('Lilly Palmer (1001tklists)', 'tok', fetcher)
    expect(r).toEqual({ id: 'p2', title: 'Lilly Palmer (1001tklists)' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('paginates with nextPageToken and returns null when nothing matches', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'a', snippet: { title: 'A' } }], nextPageToken: 't2' }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'b', snippet: { title: 'B' } }] })) as unknown as typeof fetch
    const r = await findPlaylistByTitle('Nonexistent', 'tok', fetcher)
    expect(r).toBeNull()
    expect((fetcher as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(2)
    const url2 = (fetcher as unknown as { mock: { calls: string[][] } }).mock.calls[1]![0]!
    expect(url2).toContain('pageToken=t2')
  })

  it('throws with status + body on non-2xx', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('quotaExceeded', { status: 403 })) as unknown as typeof fetch
    await expect(findPlaylistByTitle('x', 'tok', fetcher)).rejects.toThrow(/playlists\.list 403/)
  })

  it('always sends mine=true and an Authorization bearer header', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse({ items: [] })) as unknown as typeof fetch
    await findPlaylistByTitle('x', 'tok-abc', fetcher)
    const [url, init] = (fetcher as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!
    expect(url).toContain('mine=true')
    expect(new Headers(init!.headers).get('Authorization')).toBe('Bearer tok-abc')
  })
})

describe('createPlaylist', () => {
  it('POSTs the title + private status by default', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(
      jsonResponse({ id: 'newPL', snippet: { title: 'A (1001tklists)' } }),
    ) as unknown as typeof fetch
    const r = await createPlaylist({ title: 'A (1001tklists)' }, 'tok', fetcher)
    expect(r).toEqual({ id: 'newPL', title: 'A (1001tklists)' })
    const init = (fetcher as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1]!
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string)
    expect(body.snippet.title).toBe('A (1001tklists)')
    expect(body.status.privacyStatus).toBe('private')
  })

  it('respects an explicit privacyStatus override', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse({ id: 'p', snippet: { title: 't' } })) as unknown as typeof fetch
    await createPlaylist({ title: 't', privacyStatus: 'unlisted' }, 'tok', fetcher)
    const body = JSON.parse(
      (fetcher as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1]!.body as string,
    )
    expect(body.status.privacyStatus).toBe('unlisted')
  })
})

describe('listPlaylistVideoIds', () => {
  it('paginates and returns the union of all videoIds as a Set', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          items: [{ contentDetails: { videoId: 'a1' } }, { contentDetails: { videoId: 'b2' } }],
          nextPageToken: 't',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ items: [{ contentDetails: { videoId: 'c3' } }, { contentDetails: { videoId: 'a1' } }] }),
      ) as unknown as typeof fetch
    const r = await listPlaylistVideoIds('PLx', 'tok', fetcher)
    expect([...r].sort()).toEqual(['a1', 'b2', 'c3'])
  })

  it('returns an empty set when the playlist has no items', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse({ items: [] })) as unknown as typeof fetch
    expect((await listPlaylistVideoIds('PLx', 'tok', fetcher)).size).toBe(0)
  })
})

describe('addVideoToPlaylist', () => {
  it('POSTs a snippet with the playlistId + videoId', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse({ id: 'item' })) as unknown as typeof fetch
    await addVideoToPlaylist('PLx', 'vidVidVidVi', 'tok', fetcher)
    const [, init] = (fetcher as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!
    const body = JSON.parse(init!.body as string)
    expect(body).toEqual({
      snippet: { playlistId: 'PLx', resourceId: { kind: 'youtube#video', videoId: 'vidVidVidVi' } },
    })
  })

  it('throws with response body when YouTube rejects the insert', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response('videoNotFound', { status: 404 }),
    ) as unknown as typeof fetch
    await expect(addVideoToPlaylist('PLx', 'missingVid0', 'tok', fetcher)).rejects.toThrow(/playlistItems\.insert 404/)
  })
})
