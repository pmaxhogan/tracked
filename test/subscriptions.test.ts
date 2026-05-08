import { describe, it, expect } from 'vitest'
import { parseDjSlug } from '../src/lib/subscriptions'

describe('parseDjSlug', () => {
  it.each([
    ['https://www.1001tracklists.com/dj/lillypalmer/index.html', 'lillypalmer'],
    ['https://www.1001tracklists.com/dj/lillypalmer/', 'lillypalmer'],
    ['https://www.1001tracklists.com/dj/lillypalmer', 'lillypalmer'],
    ['http://1001tracklists.com/dj/lillypalmer/index.html', 'lillypalmer'],
    ['www.1001tracklists.com/dj/lillypalmer/index.html', 'lillypalmer'],
    ['https://www.1001tracklists.com/dj/Lilly_Palmer/page2.html', 'lilly_palmer'],
    ['https://www.1001tracklists.com/dj/lillypalmer/index.html?q=1#x', 'lillypalmer'],
    ['  https://www.1001tracklists.com/dj/lillypalmer/index.html  ', 'lillypalmer'],
    ['lillypalmer', 'lillypalmer'],
    ['LillyPalmer', 'lillypalmer'],
  ])('parses %s', (input, expected) => {
    expect(parseDjSlug(input)).toBe(expected)
  })

  it.each([
    '',
    '   ',
    'https://example.com/dj/lillypalmer/index.html',
    'https://www.1001tracklists.com/tracklist/abc/foo.html',
    'https://www.1001tracklists.com/source/lillypalmer/',
    'https://www.1001tracklists.com/dj/',
    'https://www.1001tracklists.com/dj//index.html',
    'https://www.1001tracklists.com/dj/has spaces/',
    'has spaces',
    'with/slash',
    '!badchars',
  ])('rejects %s', (input) => {
    expect(parseDjSlug(input)).toBeNull()
  })
})
