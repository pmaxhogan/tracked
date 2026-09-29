import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decideFullRecording,
  extractAudioDurations,
  hasNoFullRecordingNotice,
  isVertical,
  maxAudioSeconds,
  type FullRecordingInput,
} from '../src/lib/full-recording'

const fixture = (name: string) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8')

const base: FullRecordingInput = { notice: false, lastCueSeconds: 3600, videoSeconds: 3700, audioMaxSeconds: 3700, embedWidth: 1280, embedHeight: 720 }

describe('decideFullRecording', () => {
  it('accepts a horizontal video that covers the cues and matches the audio', () => {
    expect(decideFullRecording(base)).toEqual({ ok: true })
  })

  it('(a) rejects when the page shows the no-full-recording notice', () => {
    const d = decideFullRecording({ ...base, notice: true })
    expect(d).toMatchObject({ ok: false, reason: 'notice' })
  })

  it('(b) rejects a video more than 5 min shorter than the last cue, and only then', () => {
    expect(decideFullRecording({ ...base, lastCueSeconds: 4000, videoSeconds: 4000 - 301, audioMaxSeconds: null })).toMatchObject({ ok: false, reason: 'short' })
    expect(decideFullRecording({ ...base, lastCueSeconds: 4000, videoSeconds: 4000 - 300, audioMaxSeconds: null })).toEqual({ ok: true })
    // A video longer than the last cue is the normal case (the last track plays on).
    expect(decideFullRecording({ ...base, lastCueSeconds: 4000, videoSeconds: 4300, audioMaxSeconds: null })).toEqual({ ok: true })
  })

  it('(c) rejects when an audio recording is over 10 min longer than the video, and only then', () => {
    expect(decideFullRecording({ ...base, lastCueSeconds: null, videoSeconds: 1800, audioMaxSeconds: 1800 + 601 })).toMatchObject({ ok: false, reason: 'audio_longer' })
    expect(decideFullRecording({ ...base, lastCueSeconds: null, videoSeconds: 1800, audioMaxSeconds: 1800 + 600 })).toEqual({ ok: true })
    // Audio shorter than the video never matters.
    expect(decideFullRecording({ ...base, lastCueSeconds: null, videoSeconds: 7200, audioMaxSeconds: 60 })).toEqual({ ok: true })
  })

  it('(d) rejects a vertical video', () => {
    expect(decideFullRecording({ ...base, embedWidth: 1280, embedHeight: 2276 })).toMatchObject({ ok: false, reason: 'vertical' })
    expect(decideFullRecording({ ...base, embedWidth: 1280, embedHeight: 1280 })).toEqual({ ok: true })
  })

  it('never rejects on unknown inputs', () => {
    expect(
      decideFullRecording({ notice: null, lastCueSeconds: null, videoSeconds: null, audioMaxSeconds: null, embedWidth: null, embedHeight: null }),
    ).toEqual({ ok: true })
    // Duration unknown: neither the cue rule nor the audio rule can fire.
    expect(decideFullRecording({ ...base, videoSeconds: null, lastCueSeconds: 99999, audioMaxSeconds: 99999 })).toEqual({ ok: true })
    // Orientation unknown.
    expect(decideFullRecording({ ...base, embedWidth: null })).toEqual({ ok: true })
  })

  it('reports the first failing rule, in (a)-(d) order', () => {
    const all = { notice: true, lastCueSeconds: 5000, videoSeconds: 60, audioMaxSeconds: 5000, embedWidth: 100, embedHeight: 200 }
    expect(decideFullRecording(all)).toMatchObject({ reason: 'notice' })
    expect(decideFullRecording({ ...all, notice: false })).toMatchObject({ reason: 'short' })
    expect(decideFullRecording({ ...all, notice: false, lastCueSeconds: null })).toMatchObject({ reason: 'audio_longer' })
    expect(decideFullRecording({ ...all, notice: false, lastCueSeconds: null, audioMaxSeconds: null })).toMatchObject({ reason: 'vertical' })
  })
})

describe('isVertical', () => {
  it('is taller-than-wide, null when unknown or nonsense', () => {
    expect(isVertical(720, 1280)).toBe(true)
    expect(isVertical(1280, 720)).toBe(false)
    expect(isVertical(null, 720)).toBeNull()
    expect(isVertical(0, 720)).toBeNull()
  })
})

describe('page extractors (saved pages)', () => {
  it('finds the no-full-recording notice on the matroda page, which also links a YouTube video', () => {
    const html = fixture('tracklist-matroda.html')
    expect(hasNoFullRecordingNotice(html)).toBe(true)
    expect(html).toContain('ytWidget_79n8BaQAL2Q')
  })

  it('does not find it on pages without the notice', () => {
    for (const f of ['tracklist-maxstyler.html', 'tracklist-habstrakt.html', 'tracklist-neptune.html', 'tracklist-decoy-dcr839.html']) {
      expect(hasNoFullRecordingNotice(fixture(f)), f).toBe(false)
    }
  })

  it('tolerates the notice without parentheses and with other whitespace', () => {
    expect(hasNoFullRecordingNotice('<span>Currently no full\n recording available</span>')).toBe(true)
    expect(hasNoFullRecordingNotice('<span>A full recording available</span>')).toBe(false)
  })

  it('reads SoundCloud and Mixcloud player durations from the page scripts', () => {
    expect(extractAudioDurations(fixture('tracklist-maxstyler.html'))).toEqual([{ kind: 'soundcloud', seconds: 4569 }])
    const html = `new AudioPlayerSC("scWidget_1", { idPlayer: "1", type: "soundcloud", source: "x", duration: "2758" });
      new AudioPlayerMC("mcWidget_2", { idPlayer: "2", source: "y", duration: "7200" });`
    expect(extractAudioDurations(html)).toEqual([
      { kind: 'soundcloud', seconds: 2758 },
      { kind: 'mixcloud', seconds: 7200 },
    ])
    expect(maxAudioSeconds(html)).toBe(7200)
    expect(maxAudioSeconds('<html></html>')).toBeNull()
  })
})
