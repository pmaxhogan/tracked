import { describe, it, expect } from 'vitest'
import { normalizeText, slugWords, trackKey } from '../src/lib/search/normalize'

describe('normalizeText', () => {
  it('lowercases, strips diacritics, drops apostrophes, & to and', () => {
    expect(normalizeText("Don't Stop")).toEqual(['dont', 'stop'])
    expect(normalizeText('Tiësto & Sevenn')).toEqual(['tiesto', 'and', 'sevenn'])
    expect(normalizeText('Rian Wood & Version 34')).toEqual(['rian', 'wood', 'and', 'version', '34'])
    expect(normalizeText('l’amour')).toEqual(['lamour'])
  })
  it('maps synonyms: feat/ft/featuring, rmx/remix, vs/versus, w/ to with, pt/part', () => {
    expect(normalizeText('A ft. B featuring C feat D')).toEqual(['a', 'feat', 'b', 'feat', 'c', 'feat', 'd'])
    expect(normalizeText('X (Y Rmx)')).toEqual(['x', 'y', 'remix'])
    expect(normalizeText('A vs. B versus C')).toEqual(['a', 'vs', 'b', 'vs', 'c'])
    expect(normalizeText('A w/ B')).toEqual(['a', 'with', 'b'])
    expect(normalizeText('Pt. 2 part 3')).toEqual(['part', '2', 'part', '3'])
  })
  it('splits on non-alphanumerics and drops empties; null and blank give []', () => {
    expect(normalizeText('Mau P - Neck [BLACK BOOK]')).toEqual(['mau', 'p', 'neck', 'black', 'book'])
    expect(normalizeText('  ')).toEqual([])
    expect(normalizeText(null)).toEqual([])
  })
})

describe('slugWords', () => {
  it('reads the set slug without the date and extension', () => {
    expect(slugWords('https://www.1001tracklists.com/tracklist/2abc/eli-brown-mainstage-ultra-music-festival-miami-united-states-2026-03-28.html'))
      .toBe('eli brown mainstage ultra music festival miami united states')
  })
})

describe('trackKey', () => {
  it('uses the 1001tl id when there is one, else a stable hash of normalized artist + title', async () => {
    expect(await trackKey({ trackId: '909720', artist: 'Mau P', title: 'Neck' })).toBe('t:909720')
    const a = await trackKey({ trackId: null, artist: 'Mau P', title: 'Neck' })
    expect(a).toMatch(/^h:[0-9a-f]{32}$/)
    expect(await trackKey({ trackId: null, artist: 'MAU  P', title: 'neck' })).toBe(a)
    expect(await trackKey({ trackId: 'abc', artist: 'Mau P', title: 'Neck' })).toBe(a)
  })
})
