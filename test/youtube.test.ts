import { describe, it, expect } from 'vitest'
import { extractVideoId, parseIso8601Duration } from '../src/lib/youtube'

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
