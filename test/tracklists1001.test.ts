import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { parseSearchResult, parseTracklist, parseMediaLinks } from '../src/lib/tracklists1001'
import { chop, extractChallenge } from '../src/lib/fetch'

const here = dirname(fileURLToPath(import.meta.url))
const fx = (name: string) => readFileSync(resolve(here, 'fixtures', name), 'utf8')

describe('challenge', () => {
  it('chop matches Java String.hashCode for the captured token', () => {
    expect(chop('d4ff8ib4')).toBe(109070355)
  })

  it('extracts challenge fields from the interstitial page', () => {
    const c = extractChallenge(fx('tracklist-neptune.html'))
    expect(c).not.toBeNull()
    expect(c!.bChk).toBe(chop('d4ff8ib4'))
    expect(c!.ts).toBe('1777696559')
    expect(c!.action).toMatch(/^\/tracklist\/1sy5yvb9\//)
  })

  it('returns null when the page is not the challenge', () => {
    expect(extractChallenge(fx('tracklist-matroda.html'))).toBeNull()
  })
})

describe('parseSearchResult', () => {
  it('finds the matching tracklist URL', () => {
    const r = parseSearchResult(fx('search-result.html'))
    expect(r.tracklistUrl).toBe(
      'https://www.1001tracklists.com/tracklist/l3uw499/matroda-club-space-miami-united-states-2023-08-05.html',
    )
  })

  it('returns null when there are no matches', () => {
    const r = parseSearchResult(fx('search-no-result.html'))
    expect(r.tracklistUrl).toBeNull()
  })
})

describe('parseTracklist (Matroda Space Miami)', () => {
  const url =
    'https://www.1001tracklists.com/tracklist/l3uw499/matroda-club-space-miami-united-states-2023-08-05.html'
  const parsed = parseTracklist(url, fx('tracklist-matroda.html'))

  it('extracts the slug from the URL', () => {
    expect(parsed.slug).toBe('l3uw499')
  })

  it('extracts all 28 rows', () => {
    expect(parsed.tracks).toHaveLength(28)
  })

  it('parses cue seconds from the hidden input', () => {
    const t = parsed.tracks[1]!
    expect(t.startSeconds).toBe(150)
    expect(t.startTime).toBe('02:30')
    expect(t.artist).toBe('TOBEHONEST')
    expect(t.title).toBe('Where Ya At')
    expect(t.isUnidentified).toBe(false)
  })

  it('detects mashup-linked (w/) rows via the "con" class', () => {
    const mashup = parsed.tracks.find((t) => t.isMashupLinked)
    expect(mashup).toBeDefined()
    expect(mashup!.title).toBe('Calypso')
    expect(mashup!.artist).toBe('Round Table Knights & Bauchamp')
  })

  it('flags unidentified rows', () => {
    const ids = parsed.tracks.filter((t) => t.isUnidentified)
    expect(ids.length).toBeGreaterThanOrEqual(1)
    expect(ids[0]!.title).toBe('ID')
  })

  it('captures the medialink track id (iRow.mediaRow data-trackid)', () => {
    const t = parsed.tracks[1]!
    expect(t.trackId).toBe('909720')
  })

  it('captures trackUrl from meta[itemprop="url"]', () => {
    const t = parsed.tracks[1]!
    expect(t.trackUrl).toBe(
      'https://www.1001tracklists.com/track/1hf79cg5/tobehonest-where-ya-at/index.html',
    )
  })

  it('returns null trackUrl for unidentified rows', () => {
    const id = parsed.tracks.find((t) => t.isUnidentified)!
    expect(id.trackUrl).toBeNull()
  })

  it('keeps tracks ordered by ascending start time', () => {
    const cues = parsed.tracks.map((t) => t.startSeconds).filter((x): x is number => x !== null)
    for (let i = 1; i < cues.length; i++) {
      expect(cues[i]!).toBeGreaterThanOrEqual(cues[i - 1]!)
    }
  })
})

describe('parseMediaLinks', () => {
  const json = JSON.parse(fx('medialink-909720.json'))
  it('finds the apple music link by parsing the embed iframe URL', () => {
    const r = parseMediaLinks(json)
    expect(r.appleLink).toBe(
      'https://music.apple.com/us/album/where-ya-at/1696220774?i=1696221102',
    )
  })

  it('finds the youtube link from the more[] array', () => {
    const r = parseMediaLinks(json)
    expect(r.youtubeLink).toBe('https://www.youtube.com/watch?v=h8CtvP1rEy8')
  })
})
