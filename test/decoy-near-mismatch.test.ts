import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isNearMismatch, parseTracklist } from '../src/lib/tracklists1001'
import { passesDecoyCheck } from '../src/lib/verification'
import { mkvidTracksTrusted } from '../src/lib/mkvid'
import { classifyPage } from '../src/lib/page-store'

// 2026-09-30: the strict decoy check (0 rows whose microdata name differs from
// the visible text) rested four good pool accounts for 72 h. Each of their
// pages had exactly one row where the two names differ in a benign way, the
// visible text adding a parenthetical or repeating an artist. Those "near"
// mismatches are counted apart and never count as decoy evidence.

const fx = (n: string) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', n), 'utf8')
const URL = 'https://www.1001tracklists.com/tracklist/1abcdef/some-set-2026-09-30.html'

// The three live pairs (meta, shown), names only.
const LIVE: Array<[string, string]> = [
  ['Truth x Lies &amp; KLP - Smile', 'Truth x Lies &amp; KLP &amp; Lies - Smile'],
  ['The Prodigy - No Good (ALOK Remix)', 'The Prodigy - No Good (Start The Dance) (ALOK Remix)'],
  ['Adam Beyer &amp; Charles D - Rave Repeat', 'Adam Beyer &amp; Charles D (USA) - Rave Repeat'],
]

const row = (n: number, meta: string, shown = meta) =>
  `<div class="tlpTog bItm tlpItem trRow${n}" data-id="${n}"><div id="tlp${n}_content"><meta itemprop="name" content="${meta}"><span class="trackValue">${shown}</span></div></div>`
/** A synthetic page: `clean` rows whose names agree, then the given (meta, shown) rows. */
const page = (clean: number, extra: Array<[string, string]>) => {
  let html = ''
  let n = 0
  for (let i = 0; i < clean; i++) html += row(++n, `Artist ${n} - Track Number ${n}`)
  for (const [m, s] of extra) html += row(++n, m, s)
  return html
}
const decode = (s: string) => s.replace(/&amp;/g, '&')

describe('near mismatches (benign meta/visible name differences)', () => {
  it('classifies each live example as near', () => {
    for (const [m, s] of LIVE) expect(isNearMismatch(decode(m).toLowerCase(), decode(s).toLowerCase()), m).toBe(true)
  })

  it('a page with one near mismatch passes every check', async () => {
    for (const pair of LIVE) {
      const html = page(19, [pair])
      const p = parseTracklist(URL, html)
      expect(p.decoy).toEqual({ named: 20, mismatched: 0, nearMismatched: 1, suspected: false })
      expect(passesDecoyCheck(p)).toBe(true)
      expect(mkvidTracksTrusted(p.decoy, true)).toBe(true)
      expect((await classifyPage({ kind: 'set', status: 200, html, url: URL })).verdict).toBe('clean')
    }
  })

  it('all three live examples on one short page still pass', async () => {
    const html = page(13, LIVE)
    const p = parseTracklist(URL, html)
    expect(p.decoy).toEqual({ named: 16, mismatched: 0, nearMismatched: 3, suspected: false })
    expect(passesDecoyCheck(p)).toBe(true)
    expect(mkvidTracksTrusted(p.decoy, true)).toBe(true)
    expect((await classifyPage({ kind: 'set', status: 200, html, url: URL })).verdict).toBe('clean')
  })

  it('a single far mismatch still fails every check (0 far mismatches tolerated)', async () => {
    const html = page(45, [['Artist A - Some Title', 'Somebody Else - Other Words']])
    const p = parseTracklist(URL, html)
    expect(p.decoy).toEqual({ named: 46, mismatched: 1, nearMismatched: 0, suspected: false })
    expect(passesDecoyCheck(p)).toBe(false)
    expect(mkvidTracksTrusted(p.decoy, true)).toBe(false)
    expect((await classifyPage({ kind: 'set', status: 200, html, url: URL })).verdict).toBe('decoy')
  })

  it('is not fooled by decoy-style rows that swap one part of the name', () => {
    // Pairs taken from the decoy fixture: high token overlap (Jaccard up to
    // 0.71), but a part was replaced, not added.
    const far: Array<[string, string]> = [
      ['Don Diablo & RetroVision - Set Me Free (TAIGA Remix)', 'Don Diablo & RetroVision - Set Me Free (Figure & 2FAC3D Remix)'],
      ['Naughty Boy & RAY BLK & Wyclef Jean - All Or Nothing (Ten Ven Remix)', 'Naughty Boy & RAY BLK & Wyclef Jean - All Or Nothing (Luan Pugliesi Remix)'],
      ['4 Strings - 13 Ways To Save The World', 'CHASE WRIGHT - 13 Ways To Save The World'],
      ['Beroshima & Frank Muller - Electronic Discussion (The Hacker Remix)', 'Beroshima & Frank Muller - Electronic Discussion (Leftfield & Lydon Remix)'],
    ]
    for (const [m, s] of far) expect(isNearMismatch(m.toLowerCase(), s.toLowerCase()), m).toBe(false)
    // Visible text that drops a remix credit is not benign either.
    expect(isNearMismatch('a - t (x remix)', 'a - t')).toBe(false)
    // Nor is a one-word name contained in anything.
    expect(isNearMismatch('energy', 'monococ - energy')).toBe(false)
  })

  it('compares artist and title separately and only allows parenthetical or repeated additions', () => {
    const far: Array<[string, string]> = [
      // An added artist outside parentheses (the shape that would reach users via byArtist).
      ['modjo - lady', 'modjo & someone - lady'],
      ['inch - mindflow', 'patti day & inch - mindflow'],
      // A different track whose remix credit happens to hold the meta words.
      ['a - b', 'x - y (a b remix)'],
      // Artist and title swapped, or a word moved across the separator.
      ['daft punk - one more time', 'one more time - daft punk'],
      ['daft punk one - more time', 'daft punk - one more time'],
      // A title added around a meta "ID".
      ['artist - id', 'artist - real song (id remix)'],
      // One side has a separator and the other does not.
      ['artist - title', 'artist title'],
    ]
    for (const [m, s] of far) expect(isNearMismatch(m, s), `${m} / ${s}`).toBe(false)
    // A parenthetical added to the title is harmless (the shown title comes from the meta name): near.
    expect(isNearMismatch('monococ - energy', 'monococ - energy (extended mix)')).toBe(true)
    expect(isNearMismatch('monococ - energy', 'monococ - energy [extended mix]')).toBe(true)
  })

  it('a superset decoy (shown text adds an artist on most rows) fails every check', async () => {
    const rows: Array<[string, string]> = Array.from({ length: 20 }, (_, i) => [`Artist ${i} - Title ${i}`, `Artist ${i} &amp; Guest ${i + 50} - Title ${i}`])
    const html = page(0, rows)
    const p = parseTracklist(URL, html)
    expect(p.decoy).toMatchObject({ named: 20, mismatched: 20, nearMismatched: 0, suspected: true })
    expect(passesDecoyCheck(p)).toBe(false)
    expect(mkvidTracksTrusted(p.decoy, true)).toBe(false)
    expect((await classifyPage({ kind: 'set', status: 200, html, url: URL })).verdict).toBe('decoy')
  })

  it('reads feat/featuring as ft and ignores accents and punctuation', () => {
    expect(isNearMismatch('artist feat. singer - song', 'artist ft. singer (uk) - song')).toBe(true)
    expect(isNearMismatch('beyonce - halo', 'beyoncé - halo (live)')).toBe(true)
  })

  it('the decoy fixture: every mismatch is far, and it fails every check', async () => {
    const html = fx('tracklist-decoy-dcr839.html')
    const p = parseTracklist(URL, html)
    expect(p.decoy).toEqual({ named: 25, mismatched: 24, nearMismatched: 0, suspected: true })
    expect(passesDecoyCheck(p)).toBe(false)
    expect(mkvidTracksTrusted(p.decoy, true)).toBe(false)
    expect((await classifyPage({ kind: 'set', status: 200, html, url: URL })).verdict).toBe('decoy')
  })

  it('a decoy page built from synthetic rows fails every check', async () => {
    const rows: Array<[string, string]> = Array.from({ length: 20 }, (_, i) => [`Real Artist ${i} - Real Title ${i}`, `Fake Name ${i + 100} - Other Song ${i + 200}`])
    const html = page(0, rows)
    const p = parseTracklist(URL, html)
    expect(p.decoy).toMatchObject({ named: 20, mismatched: 20, nearMismatched: 0, suspected: true })
    expect(passesDecoyCheck(p)).toBe(false)
    expect(mkvidTracksTrusted(p.decoy, true)).toBe(false)
    expect((await classifyPage({ kind: 'set', status: 200, html, url: URL })).verdict).toBe('decoy')
  })

  it('the clean fixtures have no mismatches of either kind and pass', async () => {
    for (const name of ['tracklist-matroda.html', 'tracklist-habstrakt.html', 'tracklist-maxstyler.html']) {
      const html = fx(name)
      const p = parseTracklist(URL, html)
      expect(p.decoy.mismatched, name).toBe(0)
      expect(p.decoy.nearMismatched, name).toBe(0)
      expect(passesDecoyCheck(p), name).toBe(true)
      expect(mkvidTracksTrusted(p.decoy, true), name).toBe(true)
      expect((await classifyPage({ kind: 'set', status: 200, html, url: URL })).verdict, name).toBe('clean')
    }
  })
})
