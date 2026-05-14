import { describe, it, expect } from 'vitest'
import { parseTime, formatTime, selectCurrent } from '../src/lib/timestamp'
import type { ParsedTrack } from '../src/types'

describe('parseTime', () => {
  it('parses M:SS', () => {
    expect(parseTime('2:30')).toBe(150)
    expect(parseTime('0:00')).toBe(0)
    expect(parseTime('59:59')).toBe(3599)
  })
  it('parses H:MM:SS', () => {
    expect(parseTime('1:16:30')).toBe(4590)
    expect(parseTime('2:00:00')).toBe(7200)
  })
  it('rejects malformed input', () => {
    expect(parseTime('')).toBeNull()
    expect(parseTime('abc')).toBeNull()
    expect(parseTime('1:60:00')).toBeNull()
    expect(parseTime('1:00:60')).toBeNull()
    expect(parseTime('1')).toBeNull()
  })
})

describe('formatTime', () => {
  it('formats sub-hour as M:SS', () => {
    expect(formatTime(150)).toBe('2:30')
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(59)).toBe('0:59')
  })
  it('formats hours as H:MM:SS', () => {
    expect(formatTime(4590)).toBe('1:16:30')
    expect(formatTime(7200)).toBe('2:00:00')
  })
  it('roundtrips', () => {
    for (const t of ['0:00', '0:30', '5:42', '59:59', '1:00:00', '1:16:30', '12:34:56']) {
      expect(formatTime(parseTime(t)!)).toBe(t)
    }
  })
})

function track(startSeconds: number | null, opts: Partial<ParsedTrack> = {}): ParsedTrack {
  return {
    startTime: startSeconds !== null ? formatTime(startSeconds) : '',
    startSeconds,
    artist: opts.artist ?? 'Artist',
    title: opts.title ?? 'Title',
    trackId: opts.trackId ?? 'abc123',
    trackUrl: opts.trackUrl ?? null,
    artworkUrl: opts.artworkUrl ?? null,
    isUnidentified: opts.isUnidentified ?? false,
    idStatus: opts.idStatus ?? null,
    isMashupLinked: opts.isMashupLinked ?? false,
  }
}

describe('selectCurrent', () => {
  const tracks: ParsedTrack[] = [
    track(0, { title: 'A' }),
    track(150, { title: 'B' }),
    track(300, { title: 'C' }),
    track(600, { title: 'D' }),
    track(900, { title: 'E' }),
  ]

  it('returns prev + current + next, with isCurrent only on the current group', () => {
    const r = selectCurrent(tracks, 400)
    expect(r.picked.map((t) => t.title)).toEqual(['B', 'C', 'D'])
    expect(r.picked.find((t) => t.title === 'B')!.isCurrent).toBe(false)
    expect(r.picked.find((t) => t.title === 'C')!.isCurrent).toBe(true)
    expect(r.picked.find((t) => t.title === 'D')!.isCurrent).toBe(false)
  })

  it('boundary timestamps still produce prev + current + next (no transition window flag)', () => {
    const r1 = selectCurrent(tracks, 300) // exactly at C's start
    expect(r1.picked.map((t) => t.title)).toEqual(['B', 'C', 'D'])
    const r2 = selectCurrent(tracks, 599) // 1s before D
    expect(r2.picked.map((t) => t.title)).toEqual(['B', 'C', 'D'])
  })

  it('first track of tracklist: no prev, returns [current, next]', () => {
    const r = selectCurrent(tracks, 50) // current is A (starts at 0)
    expect(r.picked.map((t) => t.title)).toEqual(['A', 'B'])
    expect(r.picked.find((t) => t.title === 'A')!.isCurrent).toBe(true)
    expect(r.picked.find((t) => t.title === 'B')!.isCurrent).toBe(false)
  })

  it('last track of tracklist: no next, returns [prev, current]', () => {
    const r = selectCurrent(tracks, 1000) // past start of E
    expect(r.picked.map((t) => t.title)).toEqual(['D', 'E'])
    expect(r.picked.find((t) => t.title === 'D')!.isCurrent).toBe(false)
    expect(r.picked.find((t) => t.title === 'E')!.isCurrent).toBe(true)
  })

  it('single-track tracklist returns just the current', () => {
    const r = selectCurrent([track(50, { title: 'only' })], 100)
    expect(r.picked.map((t) => t.title)).toEqual(['only'])
    expect(r.picked[0]!.isCurrent).toBe(true)
  })

  it('before the first cued group: returns first as next-up, no isCurrent', () => {
    const r = selectCurrent([track(60, { title: 'X' }), track(200, { title: 'Y' })], 10)
    expect(r.picked.map((t) => t.title)).toEqual(['X'])
    expect(r.picked[0]!.isCurrent).toBe(false)
  })

  it('empty tracklist returns empty pick', () => {
    const r = selectCurrent([], 100)
    expect(r.picked).toEqual([])
    expect(r.anyUnidentified).toBe(false)
  })

  it('groups w/ mashup-linked siblings within prev/current/next', () => {
    const ts: ParsedTrack[] = [
      track(0, { title: 'A' }),
      track(300, { title: 'B' }),
      track(300, { title: 'B-mashup', isMashupLinked: true }),
      track(600, { title: 'C' }),
    ]
    const r = selectCurrent(ts, 400) // current = B+B-mashup
    expect(r.picked.map((t) => t.title)).toEqual(['A', 'B', 'B-mashup', 'C'])
    expect(r.picked.find((t) => t.title === 'A')!.isCurrent).toBe(false)
    expect(r.picked.find((t) => t.title === 'B')!.isCurrent).toBe(true)
    expect(r.picked.find((t) => t.title === 'B-mashup')!.isCurrent).toBe(true)
    expect(r.picked.find((t) => t.title === 'C')!.isCurrent).toBe(false)
  })

  it('flags unidentified current tracks', () => {
    const ts: ParsedTrack[] = [
      track(0, { title: 'A' }),
      track(300, { title: 'ID', isUnidentified: true }),
      track(600, { title: 'C' }),
    ]
    const r = selectCurrent(ts, 400)
    expect(r.anyUnidentified).toBe(true)
  })

  it('does not flag unidentified when the unidentified track is just neighboring context', () => {
    const ts: ParsedTrack[] = [
      track(0, { title: 'A' }),
      track(300, { title: 'B' }),
      track(600, { title: 'ID', isUnidentified: true }),
    ]
    const r = selectCurrent(ts, 400) // current is B, unidentified is next
    expect(r.anyUnidentified).toBe(false)
  })

  it('computes durationSeconds as nextGroupStart - thisStart for non-last groups', () => {
    const r = selectCurrent(tracks, 400) // current = C; tracks A=0, B=150, C=300, D=600, E=900
    const c = r.picked.find((t) => t.title === 'C')!
    expect(c.durationSeconds).toBe(300) // 600 - 300
    expect(c.durationTime).toBe('5:00')
    const b = r.picked.find((t) => t.title === 'B')!
    expect(b.durationSeconds).toBe(150) // 300 - 150
    expect(b.durationTime).toBe('2:30')
  })

  it('last group duration is null when setEndSeconds not provided', () => {
    const r = selectCurrent(tracks, 950) // current = E (last)
    const e = r.picked.find((t) => t.title === 'E')!
    expect(e.durationSeconds).toBeNull()
    expect(e.durationTime).toBe('')
  })

  it('last group duration uses setEndSeconds when provided', () => {
    const r = selectCurrent(tracks, 950, 1100) // E starts at 900, set ends at 1100
    const e = r.picked.find((t) => t.title === 'E')!
    expect(e.durationSeconds).toBe(200)
    expect(e.durationTime).toBe('3:20')
  })

  it('mashup-linked siblings share their group duration', () => {
    const ts: ParsedTrack[] = [
      track(0, { title: 'A' }),
      track(300, { title: 'B' }),
      track(300, { title: 'B-mashup', isMashupLinked: true }),
      track(600, { title: 'C' }),
    ]
    const r = selectCurrent(ts, 400)
    const b = r.picked.find((t) => t.title === 'B')!
    const bm = r.picked.find((t) => t.title === 'B-mashup')!
    expect(b.durationSeconds).toBe(300) // 600 - 300
    expect(bm.durationSeconds).toBe(300) // shares group window
    expect(b.durationSeconds).toBe(bm.durationSeconds)
  })

  it('clamps to null when setEndSeconds is before the last group start (bad input)', () => {
    const r = selectCurrent(tracks, 950, 800) // bogus: set ends before E starts
    const e = r.picked.find((t) => t.title === 'E')!
    expect(e.durationSeconds).toBeNull()
  })

  it('clamps to null when setEndSeconds equals the last group start (zero-length last track)', () => {
    const r = selectCurrent(tracks, 950, 900) // E starts at 900, set ends at 900 → no length
    const e = r.picked.find((t) => t.title === 'E')!
    expect(e.durationSeconds).toBeNull()
  })

  it('null-cue tracks have null duration', () => {
    const ts: ParsedTrack[] = [
      track(null, { title: 'pre' }),
      track(300, { title: 'B' }),
      track(600, { title: 'C' }),
    ]
    const r = selectCurrent(ts, 400)
    const pre = r.picked.find((t) => t.title === 'pre')!
    expect(pre.durationSeconds).toBeNull()
    expect(pre.durationTime).toBe('')
  })

  it('skips null-cue tracks for current selection', () => {
    const ts: ParsedTrack[] = [
      track(null, { title: 'pre' }),
      track(300, { title: 'B' }),
      track(600, { title: 'C' }),
    ]
    const r = selectCurrent(ts, 400) // current = B; prev = pre group, next = C
    // The null-cue 'pre' is its own group with no cue; selectCurrent's range
    // matcher skips it, so current is B. Previous group is the pre row.
    expect(r.picked.map((t) => t.title)).toEqual(['pre', 'B', 'C'])
    expect(r.picked.find((t) => t.title === 'B')!.isCurrent).toBe(true)
  })

  describe('trailing uncued tracks (interpolated by setEndSeconds)', () => {
    // Habstrakt b2b JSTJR-style sparse tracklist: a couple of cued opener
    // tracks and a long tail of untimed extras. Without interpolation the last
    // cued track would pin as "current" forever past its cue.
    //
    // Cued gap is 80s (670 → 750), so the median-bounded slot for trailing
    // tracks is 80s. evenSlot = (2759 - 750) / 21 = 95.7s; we cap at 80s.
    // Trailing effective starts: 830, 910, 990, 1070, 1150, 1230, 1310, 1390,
    // 1470, 1550, 1630, 1710, 1790, 1870, 1950, 2030, 2110, 2190, 2270, 2350.
    const trailingTitles = Array.from({ length: 20 }, (_, i) => `T${i + 1}`)
    const sparse: ParsedTrack[] = [
      track(670, { title: 'Lemme Get Down' }), // 11:10
      track(750, { title: 'Guest List' }), // 12:30 — last cue
      ...trailingTitles.map((title) => track(null, { title })),
    ]
    const setEnd = 2759 // 45:59

    it('does NOT pin the last cued group as current well past its cue', () => {
      const r = selectCurrent(sparse, 1668, setEnd) // 27:48
      const current = r.picked.find((t) => t.isCurrent)
      expect(current).toBeDefined()
      expect(current!.title).not.toBe('Guest List')
      expect(current!.title).not.toBe('Lemme Get Down')
    })

    it('picks a trailing uncued group whose slot contains currentSeconds (mid-set)', () => {
      // 1668 lands in T11's slot [1630, 1710).
      const r = selectCurrent(sparse, 1668, setEnd)
      const current = r.picked.find((t) => t.isCurrent)!
      expect(current.title).toBe('T11')
      expect(r.picked.map((t) => t.title)).toEqual(['T10', 'T11', 'T12'])
    })

    it('picks an early trailing group when currentSeconds is just past the last cue', () => {
      // 1112 lands in T4's slot [1070, 1150).
      const r = selectCurrent(sparse, 1112, setEnd) // 18:32
      const current = r.picked.find((t) => t.isCurrent)!
      expect(current.title).toBe('T4')
      expect(r.picked.map((t) => t.title)).toEqual(['T3', 'T4', 'T5'])
    })

    it('falls back to the last interpolated group near setEndSeconds', () => {
      const r = selectCurrent(sparse, 2700, setEnd) // ≈ end of set
      const current = r.picked.find((t) => t.isCurrent)!
      expect(current.title).toBe('T20')
      // T20 is the last group → no next.
      expect(r.picked.map((t) => t.title)).toEqual(['T19', 'T20'])
    })

    it('gives every interpolated trailing group a finite durationSeconds', () => {
      const r = selectCurrent(sparse, 1668, setEnd)
      for (const t of r.picked) {
        expect(t.durationSeconds).not.toBeNull()
        expect(t.durationSeconds!).toBeGreaterThan(0)
      }
    })

    it('falls back to the old (pin-last-cued) behavior when setEndSeconds is omitted', () => {
      // No setEndSeconds → no interpolation; Guest List is the last cued group
      // and stays "current" for any currentSeconds past its cue.
      const r = selectCurrent(sparse, 1668)
      const current = r.picked.find((t) => t.isCurrent)!
      expect(current.title).toBe('Guest List')
    })

    it('does not interpolate when setEndSeconds is not strictly after the last cue', () => {
      // Bogus input (setEnd ≤ lastCuedStart): treat as if setEnd weren't given.
      const r = selectCurrent(sparse, 1668, 700)
      const current = r.picked.find((t) => t.isCurrent)!
      expect(current.title).toBe('Guest List')
    })

    it('caps the slot by evenSlot so trailing tracks never extend past setEndSeconds', () => {
      // Only one cued track (no gap to seed the median), so slot = evenSlot.
      // evenSlot = (200 - 100) / (4 + 1) = 20.
      const tl: ParsedTrack[] = [
        track(100, { title: 'A' }),
        track(null, { title: 'T1' }),
        track(null, { title: 'T2' }),
        track(null, { title: 'T3' }),
        track(null, { title: 'T4' }),
      ]
      const r = selectCurrent(tl, 175, 200)
      // T4 starts at 100 + 20*4 = 180; T3 at 160. 175 falls in T3's slot.
      const current = r.picked.find((t) => t.isCurrent)!
      expect(current.title).toBe('T3')
    })

    it('caps the slot by median to avoid inflating the last cued group', () => {
      // 3 cued gaps each 60s → median = 60. evenSlot = (1000 - 200) / 3 ≈ 267.
      // Slot = min(60, 267) = 60. Without median capping D would extend to 467
      // and "swallow" any currentSeconds up to 467 — keeping the listener
      // pinned on a short opener that ended long ago.
      const tl: ParsedTrack[] = [
        track(20, { title: 'A' }),
        track(80, { title: 'B' }),
        track(140, { title: 'C' }),
        track(200, { title: 'D' }), // last cue
        track(null, { title: 'T1' }),
        track(null, { title: 'T2' }),
      ]
      // 300 is past D's median-bounded window [200,260) and into T1 [260,320).
      const r = selectCurrent(tl, 300, 1000)
      const current = r.picked.find((t) => t.isCurrent)!
      expect(current.title).toBe('T1')
    })

    it('leaves a tracklist with no cues at all unmatched (returns nothing current)', () => {
      const allUncued: ParsedTrack[] = [
        track(null, { title: 'X' }),
        track(null, { title: 'Y' }),
      ]
      const r = selectCurrent(allUncued, 100, 500)
      // No cue to anchor the interpolation; "before first cued group" branch
      // also no-ops because there are no cued groups.
      expect(r.picked).toEqual([])
    })
  })
})
