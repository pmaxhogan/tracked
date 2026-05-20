import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildCommentDraft,
  buildShortLink,
  extractTracklistShortId,
  InvalidTracklistUrl,
} from '../src/lib/youtube-comment-draft'
import { formatTime } from '../src/lib/timestamp'
import { parseTracklist } from '../src/lib/tracklists1001'
import type { ParsedTrack } from '../src/types'

const fx = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')

function track(startSeconds: number | null, opts: Partial<ParsedTrack> = {}): ParsedTrack {
  return {
    startTime: startSeconds !== null ? formatTime(startSeconds) : '',
    startSeconds,
    artist: opts.artist ?? 'Artist',
    title: opts.title ?? 'Title',
    trackId: opts.trackId ?? null,
    trackUrl: opts.trackUrl ?? null,
    artworkUrl: opts.artworkUrl ?? null,
    isUnidentified: opts.isUnidentified ?? false,
    idStatus: opts.idStatus ?? null,
    isMashupLinked: opts.isMashupLinked ?? false,
  }
}

describe('extractTracklistShortId', () => {
  it('extracts the id from a canonical /tracklist/<id>/<slug>.html URL', () => {
    expect(
      extractTracklistShortId(
        'https://www.1001tracklists.com/tracklist/l3uw499/matroda-club-space-miami-united-states-2023-08-05.html',
      ),
    ).toBe('l3uw499')
  })

  it('handles bare-host (no www)', () => {
    expect(extractTracklistShortId('https://1001tracklists.com/tracklist/abc123/foo.html')).toBe('abc123')
  })

  it('handles http (older share links)', () => {
    expect(extractTracklistShortId('http://www.1001tracklists.com/tracklist/4muqu3/foo.html')).toBe('4muqu3')
  })

  it('returns null for non-tracklist 1001tl URLs', () => {
    expect(extractTracklistShortId('https://www.1001tracklists.com/dj/lillypalmer/index.html')).toBeNull()
    expect(extractTracklistShortId('https://www.1001tracklists.com/')).toBeNull()
  })

  it('returns null for unrelated URLs', () => {
    expect(extractTracklistShortId('https://www.youtube.com/watch?v=abc')).toBeNull()
    expect(extractTracklistShortId('not a url')).toBeNull()
    expect(extractTracklistShortId('')).toBeNull()
  })
})

describe('buildShortLink', () => {
  it('returns the bare host, no scheme', () => {
    expect(buildShortLink('l3uw499')).toBe('1001.tl/l3uw499')
  })

  it('does not include "https://"', () => {
    expect(buildShortLink('abc')).not.toMatch(/^https?:\/\//)
  })
})

describe('buildCommentDraft', () => {
  const url = 'https://www.1001tracklists.com/tracklist/l3uw499/matroda.html'

  it('throws InvalidTracklistUrl for an unrecognized URL', () => {
    expect(() => buildCommentDraft('not-a-tracklist', { tracks: [] })).toThrow(InvalidTracklistUrl)
  })

  it('emits one line per cued track with leading timestamp + " - " separator', () => {
    const tracks = [
      track(0, { artist: 'A', title: 'X' }),
      track(150, { artist: 'B', title: 'Y' }),
      track(4590, { artist: 'C', title: 'Z' }),
    ]
    const draft = buildCommentDraft(url, { tracks })
    expect(draft.body).toContain('0:00 A - X')
    expect(draft.body).toContain('2:30 B - Y')
    expect(draft.body).toContain('1:16:30 C - Z')
    expect(draft.includedGroups).toBe(3)
  })

  it('puts the credit footer at the bottom with the bare short link', () => {
    const draft = buildCommentDraft(url, {
      tracks: [track(0, { artist: 'A', title: 'X' })],
    })
    expect(draft.body.endsWith('\n\nTracklist: 1001.tl/l3uw499')).toBe(true)
    expect(draft.shortLink).toBe('1001.tl/l3uw499')
    // No `https://` anywhere — bare-host link is intentional.
    expect(draft.body).not.toMatch(/https?:\/\//)
  })

  it('renders credit-only when there are zero tracks', () => {
    const draft = buildCommentDraft(url, { tracks: [] })
    expect(draft.body).toBe('Tracklist: 1001.tl/l3uw499')
    expect(draft.includedGroups).toBe(0)
    expect(draft.droppedUncued).toBe(0)
  })

  it('drops uncued tracks and reports the count', () => {
    const tracks = [
      track(0, { artist: 'A', title: 'X' }),
      track(null, { artist: 'B', title: 'Y' }),
      track(300, { artist: 'C', title: 'Z' }),
      track(null, { artist: 'D', title: 'W' }),
    ]
    const draft = buildCommentDraft(url, { tracks })
    expect(draft.includedGroups).toBe(2)
    expect(draft.droppedUncued).toBe(2)
    expect(draft.body).not.toContain(' B - Y')
    expect(draft.body).not.toContain(' D - W')
  })

  it('combines mashup-linked siblings (isMashupLinked) onto a single line with " w/ "', () => {
    const tracks = [
      track(60, { artist: 'A', title: 'X' }),
      track(60, { artist: 'B', title: 'Y', isMashupLinked: true }),
    ]
    const draft = buildCommentDraft(url, { tracks })
    expect(draft.body).toContain('1:00 A - X w/ B - Y')
    expect(draft.includedGroups).toBe(1)
  })

  it('combines siblings detected via shared cue (Habstrakt-style trRow with no "con" class)', () => {
    const tracks = [
      track(60, { artist: 'A', title: 'X' }),
      // Same cue but isMashupLinked=false — groupByMashup still merges these.
      track(60, { artist: 'B', title: 'Y', isMashupLinked: false }),
    ]
    const draft = buildCommentDraft(url, { tracks })
    expect(draft.body).toContain('1:00 A - X w/ B - Y')
    expect(draft.includedGroups).toBe(1)
  })

  it('keeps unidentified rows in the comment when they have a cue (titled "ID")', () => {
    const tracks = [
      track(0, { artist: 'A', title: 'X' }),
      track(120, { artist: 'ID', title: 'ID', isUnidentified: true }),
    ]
    const draft = buildCommentDraft(url, { tracks })
    expect(draft.body).toContain('2:00 ID - ID')
    expect(draft.includedGroups).toBe(2)
  })

  it('falls back to artist-only / title-only when one side is empty', () => {
    const tracks = [
      track(0, { artist: 'Solo', title: '' }),
      track(60, { artist: '', title: 'OnlyTitle' }),
    ]
    const draft = buildCommentDraft(url, { tracks })
    expect(draft.body).toContain('0:00 Solo')
    expect(draft.body).toContain('1:00 OnlyTitle')
    expect(draft.body).not.toContain('Solo -')
    expect(draft.body).not.toContain('- OnlyTitle')
  })

  it('drops trailing tracks when the body would exceed maxChars and reports truncation', () => {
    const tracks = Array.from({ length: 50 }, (_, i) =>
      track(i * 60, { artist: `Artist ${i}`, title: `Title ${i}` }),
    )
    // Each line is roughly "M:SS Artist N - Title N" (~25 chars). Cap at
    // ~250 chars so ~10 of the 50 fit. The credit footer is always kept.
    const draft = buildCommentDraft(url, { tracks }, { maxChars: 250 })
    expect(draft.truncated).toBe(true)
    expect(draft.droppedForLength).toBeGreaterThan(0)
    expect(draft.includedGroups + draft.droppedForLength).toBe(50)
    expect(draft.body.length).toBeLessThanOrEqual(250)
    // Credit stays at the bottom no matter what.
    expect(draft.body.endsWith('Tracklist: 1001.tl/l3uw499')).toBe(true)
    // First track is always kept (most useful seek point).
    expect(draft.body).toContain('0:00 Artist 0 - Title 0')
  })

  it('does not exceed the default maxChars (9500) for a realistic 50-track set', () => {
    const tracks = Array.from({ length: 50 }, (_, i) =>
      track(i * 60, { artist: `Artist ${i}`, title: `Title ${i}` }),
    )
    const draft = buildCommentDraft(url, { tracks })
    expect(draft.body.length).toBeLessThanOrEqual(9500)
    expect(draft.truncated).toBe(false)
    expect(draft.includedGroups).toBe(50)
  })

  it('allows a custom credit template', () => {
    const draft = buildCommentDraft(
      url,
      { tracks: [track(0, { artist: 'A', title: 'X' })] },
      { creditTemplate: (sl) => `Full tracklist: ${sl} (1001tracklists)` },
    )
    expect(draft.body.endsWith('Full tracklist: 1001.tl/l3uw499 (1001tracklists)')).toBe(true)
  })
})

describe('buildCommentDraft against the Matroda fixture (end-to-end shape)', () => {
  const url =
    'https://www.1001tracklists.com/tracklist/l3uw499/matroda-club-space-miami-united-states-2023-08-05.html'
  const parsed = parseTracklist(url, fx('tracklist-matroda.html'))
  const draft = buildCommentDraft(url, { tracks: parsed.tracks })

  it('parses without error and produces a non-empty body', () => {
    expect(parsed.tracks).toHaveLength(28)
    expect(draft.body.length).toBeGreaterThan(100)
  })

  it('renders the first track at 0:00 (or first cued track) at the top of the body', () => {
    // First line must start with a digit (a timestamp) — proves YT will
    // auto-linkify it as a seek point.
    const firstLine = draft.body.split('\n')[0]!
    expect(firstLine).toMatch(/^\d/)
  })

  it('combines the mashup-linked Round Table Knights w/ row onto one line', () => {
    // From the fixture: Calypso is the mashup-linked sibling.
    const lines = draft.body.split('\n')
    const calypsoLine = lines.find((l) => l.includes('Calypso'))
    expect(calypsoLine).toBeDefined()
    expect(calypsoLine).toMatch(/ w\/ /)
  })

  it('ends with the bare-host credit footer (no scheme)', () => {
    expect(draft.body.endsWith('Tracklist: 1001.tl/l3uw499')).toBe(true)
    expect(draft.body).not.toMatch(/https?:\/\//)
  })

  it('stays under YouTube\'s 10k comment cap by a comfortable margin', () => {
    expect(draft.body.length).toBeLessThan(10_000)
    expect(draft.truncated).toBe(false)
  })
})
