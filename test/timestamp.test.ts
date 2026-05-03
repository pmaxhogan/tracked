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
    isUnidentified: opts.isUnidentified ?? false,
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

  it('returns the current track when comfortably in the middle', () => {
    const r = selectCurrent(tracks, 400, 15)
    expect(r.picked.map((t) => t.title)).toEqual(['C'])
    expect(r.picked[0]!.isCurrent).toBe(true)
  })

  it('includes the next track when within transition window', () => {
    const r = selectCurrent(tracks, 590, 15)
    expect(r.picked.map((t) => t.title)).toEqual(['C', 'D'])
    expect(r.picked.find((t) => t.title === 'C')!.isCurrent).toBe(true)
    expect(r.picked.find((t) => t.title === 'D')!.isCurrent).toBe(false)
  })

  it('includes the previous track when within transition window', () => {
    const r = selectCurrent(tracks, 310, 15)
    expect(r.picked.map((t) => t.title)).toEqual(['B', 'C'])
    expect(r.picked.find((t) => t.title === 'B')!.isCurrent).toBe(false)
    expect(r.picked.find((t) => t.title === 'C')!.isCurrent).toBe(true)
  })

  it('handles before-first edge: returns next within window', () => {
    const r = selectCurrent([track(60, { title: 'X' }), track(200, { title: 'Y' })], 50, 15)
    expect(r.picked.map((t) => t.title)).toEqual(['X'])
    expect(r.picked[0]!.isCurrent).toBe(false)
  })

  it('groups w/ mashup-linked siblings', () => {
    const ts: ParsedTrack[] = [
      track(0, { title: 'A' }),
      track(300, { title: 'B' }),
      track(300, { title: 'B-mashup', isMashupLinked: true }),
      track(600, { title: 'C' }),
    ]
    const r = selectCurrent(ts, 400, 15)
    expect(r.picked.map((t) => t.title)).toEqual(['B', 'B-mashup'])
    expect(r.picked.every((t) => t.isCurrent)).toBe(true)
  })

  it('flags unidentified current tracks', () => {
    const ts: ParsedTrack[] = [
      track(0, { title: 'A' }),
      track(300, { title: 'ID', isUnidentified: true }),
      track(600, { title: 'C' }),
    ]
    const r = selectCurrent(ts, 400, 15)
    expect(r.anyUnidentified).toBe(true)
  })

  it('skips tracks with null cue', () => {
    const ts: ParsedTrack[] = [
      track(null, { title: 'pre' }),
      track(300, { title: 'B' }),
      track(600, { title: 'C' }),
    ]
    const r = selectCurrent(ts, 400, 15)
    expect(r.picked.map((t) => t.title)).toEqual(['B'])
  })
})
