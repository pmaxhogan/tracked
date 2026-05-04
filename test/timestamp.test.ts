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
})
