import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/lib/fetch', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/fetch')>('../src/lib/fetch')
  return { ...actual, fetchWithTimeout: vi.fn() }
})

import { fetchWithTimeout } from '../src/lib/fetch'
import {
  extractVideoId,
  fetchVideoDetails,
  parseIso8601Duration,
  VIDEO_DETAIL_PARTS,
  YouTubeApiError,
} from '../src/lib/youtube'

const mockFetch = vi.mocked(fetchWithTimeout)

describe('extractVideoId', () => {
  const ID = '79n8BaQAL2Q'

  it.each([
    ['https://www.youtube.com/watch?v=79n8BaQAL2Q', ID],
    ['https://youtube.com/watch?v=79n8BaQAL2Q', ID],
    ['https://m.youtube.com/watch?v=79n8BaQAL2Q', ID],
    ['https://music.youtube.com/watch?v=79n8BaQAL2Q', ID],
    ['https://www.youtube.com/watch?v=79n8BaQAL2Q&t=4500s', ID],
    ['https://www.youtube.com/watch?list=PLfoo&v=79n8BaQAL2Q', ID],
    ['https://youtu.be/79n8BaQAL2Q', ID],
    ['https://youtu.be/79n8BaQAL2Q?t=42', ID],
    ['https://www.youtube.com/embed/79n8BaQAL2Q', ID],
    ['https://www.youtube.com/shorts/79n8BaQAL2Q', ID],
    ['https://www.youtube.com/live/79n8BaQAL2Q', ID],
    ['https://www.youtube.com/v/79n8BaQAL2Q', ID],
    ['79n8BaQAL2Q', ID], // bare id
    ['  79n8BaQAL2Q  ', ID], // padded
  ])('extracts from %s', (input, expected) => {
    expect(extractVideoId(input)).toBe(expected)
  })

  it.each([
    '',
    'not a url',
    'https://www.youtube.com/',
    'https://www.youtube.com/watch',
    'https://www.youtube.com/watch?v=tooshort',
    'https://example.com/watch?v=79n8BaQAL2Q', // wrong host
    'https://vimeo.com/12345',
    '79n8BaQAL2', // 10 chars, not 11
    '79n8BaQAL2QX', // 12 chars
    '79n8BaQAL2!', // invalid char
  ])('rejects %s', (input) => {
    expect(extractVideoId(input)).toBeNull()
  })
})

describe('parseIso8601Duration', () => {
  it.each([
    ['PT1H28M6S', 5286],
    ['PT3M30S', 210],
    ['PT45S', 45],
    ['PT2H', 7200],
    ['PT1H2M', 3720],
  ])('parses %s', (input, seconds) => {
    expect(parseIso8601Duration(input)).toBe(seconds)
  })

  it.each(['', 'P1H', '1H30M', 'garbage'])('rejects %s', (input) => {
    expect(parseIso8601Duration(input)).toBeNull()
  })
})

describe('fetchVideoDetails', () => {
  beforeEach(() => mockFetch.mockReset())

  const ok = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response

  it('requests every read-only part for the id and returns the raw item', async () => {
    const item = { id: '79n8BaQAL2Q', snippet: { title: 'a set' }, contentDetails: { duration: 'PT1H' } }
    mockFetch.mockResolvedValue(ok({ items: [item] }))

    const got = await fetchVideoDetails('79n8BaQAL2Q', 'key123')

    expect(got).toEqual(item)
    const url = String(mockFetch.mock.calls[0]![0])
    expect(url).toContain('/videos?part=' + VIDEO_DETAIL_PARTS.join(','))
    expect(url).toContain('id=79n8BaQAL2Q')
    expect(url).toContain('key=key123')
  })

  it('returns null when the id resolves to no item', async () => {
    mockFetch.mockResolvedValue(ok({ items: [] }))
    expect(await fetchVideoDetails('79n8BaQAL2Q', 'key123')).toBeNull()
  })

  it('throws YouTubeApiError carrying the upstream status and body', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => '{"error":"quotaExceeded"}',
    } as unknown as Response)

    await expect(fetchVideoDetails('79n8BaQAL2Q', 'key123')).rejects.toMatchObject({
      name: 'YouTubeApiError',
      status: 403,
      body: '{"error":"quotaExceeded"}',
    })
    await expect(fetchVideoDetails('79n8BaQAL2Q', 'key123')).rejects.toBeInstanceOf(YouTubeApiError)
  })
})
