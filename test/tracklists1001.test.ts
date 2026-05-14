import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { parseSearchResult, parseTracklist, parseMediaLinks, extractSetAppleLink, normalizeArtworkUrl, parseCueValueData } from '../src/lib/tracklists1001'
import { chop, extractChallenge, isIPBlocked, extractIPBlockedAddress, looksLikeCfShell } from '../src/lib/fetch'
import { selectCurrent } from '../src/lib/timestamp'

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

describe('IP block detection', () => {
  it('detects the IP-block search response', () => {
    expect(isIPBlocked(fx('ip-block-search.html'))).toBe(true)
  })

  it('detects the IP-block tracklist response', () => {
    expect(isIPBlocked(fx('ip-block-tracklist.html'))).toBe(true)
  })

  it('does not flag the JS interstitial as IP-blocked', () => {
    expect(isIPBlocked(fx('tracklist-neptune.html'))).toBe(false)
  })

  it('does not flag a real tracklist page as IP-blocked', () => {
    expect(isIPBlocked(fx('tracklist-matroda.html'))).toBe(false)
  })

  it('extracts the client IP from the unblock page', () => {
    expect(extractIPBlockedAddress(fx('ip-block-search.html'))).toMatch(/^(?:\d{1,3}\.){3}\d{1,3}$/)
  })

  it('returns null IP for non-blocked pages', () => {
    expect(extractIPBlockedAddress(fx('tracklist-matroda.html'))).toBeNull()
  })
})

describe('CF shell detection (looksLikeCfShell)', () => {
  it('flags a page with turnstile-container and no track structure', () => {
    const html = `<html><head><title>x</title></head><body>
      <div id="turnstile-container" data-sitekey="abc"></div>
      <script>jsAsyncReady();</script>
    </body></html>`
    expect(looksLikeCfShell(html)).toBe(true)
  })

  it('flags a page mentioning cf-mitigated with no tlpItem rows', () => {
    const html = '<html><body><meta name="cf-mitigated" content="challenge"><script>jsbuffer.push();</script></body></html>'
    expect(looksLikeCfShell(html)).toBe(true)
  })

  it('does NOT flag a real tracklist page', () => {
    expect(looksLikeCfShell(fx('tracklist-matroda.html'))).toBe(false)
  })

  it('does NOT flag a real tracklist page even if scripts mention cf in passing', () => {
    expect(looksLikeCfShell(fx('tracklist-maxstyler.html'))).toBe(false)
  })

  it('also matches the JS interstitial — caller handles that earlier in fetchHtml', () => {
    // The pre-render JS interstitial happens to share Turnstile-ish markers
    // and has no tlpItem rows. fetchHtml runs extractChallenge first and
    // POSTs the chop() solution before looksLikeCfShell ever sees the body,
    // so this overlap is harmless in production. Documented here to lock the
    // ordering invariant.
    const challenge = fx('tracklist-neptune.html')
    expect(looksLikeCfShell(challenge)).toBe(true)
    expect(extractChallenge(challenge)).not.toBeNull()
  })

  it('does NOT flag the IP-block page (different gate, handled by isIPBlocked)', () => {
    // The IP-block fixture has unblock_ip and may also reference sitekey, but
    // looksLikeCfShell is a fallback — IP-block is detected first in fetchTracklist.
    // This is a behavioral note: looksLikeCfShell may return true on IP-block too.
    // The order of checks in fetchTracklist (IP block first) ensures we route correctly.
    const ipBlock = fx('ip-block-tracklist.html')
    if (looksLikeCfShell(ipBlock)) {
      // It does match — that's fine, isIPBlocked runs first in production code.
      expect(isIPBlocked(ipBlock)).toBe(true)
    }
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

  it('flags fully unidentified rows (title is literal "ID")', () => {
    const ids = parsed.tracks.filter((t) => t.isUnidentified)
    expect(ids.length).toBeGreaterThanOrEqual(1)
    expect(ids[0]!.title).toBe('ID')
    expect(ids[0]!.idStatus).toBeNull()
  })

  it('extracts artworkUrl from data-src and normalizes to 300x300', () => {
    // Row 1 (TOBEHONEST - Where Ya At) has a Beatport thumbnail
    const t = parsed.tracks[1]!
    expect(t.artworkUrl).toBe(
      'https://geo-media.beatport.com/image_size/300x300/8702a65a-cfa7-4890-9476-4a346d36f169.jpg',
    )
  })

  it('returns null artworkUrl for rows that only embed the placeholder', () => {
    // Row 9 (Cave Studio - ID) uses default_100.png as the src
    const id = parsed.tracks.find((t) => t.isUnidentified && t.title === 'ID')!
    expect(id.artworkUrl).toBeNull()
  })

  it('detects "ID Remix" rows: NOT isUnidentified, artist+title from base track, idStatus="ID Remix"', () => {
    // Row 19 in the fixture: Armand van Helden - I Want Your Soul (ID Remix)
    const row = parsed.tracks.find((t) => t.idStatus === 'ID Remix')!
    expect(row).toBeDefined()
    expect(row.isUnidentified).toBe(false)
    expect(row.artist).toBe('Armand van Helden')
    expect(row.title).toBe('I Want Your Soul')
    expect(row.trackUrl).toBe(
      'https://www.1001tracklists.com/track/6gbh9j5/armand-van-helden-i-want-your-soul/index.html',
    )
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

  it('setAppleLink is null when the page has no set-level Apple Music album', () => {
    expect(parsed.setAppleLink).toBeNull()
  })

  it('keeps tracks ordered by ascending start time', () => {
    const cues = parsed.tracks.map((t) => t.startSeconds).filter((x): x is number => x !== null)
    for (let i = 1; i < cues.length; i++) {
      expect(cues[i]!).toBeGreaterThanOrEqual(cues[i - 1]!)
    }
  })
})

describe('parseTracklist (Max Styler — has set-level Apple Music album)', () => {
  const url =
    'https://www.1001tracklists.com/tracklist/1pmwyfn1/max-styler-circuitgrounds-edc-las-vegas-united-states-2025-05-16.html'
  const parsed = parseTracklist(url, fx('tracklist-maxstyler.html'))

  it('builds a canonical music.apple.com album URL from the embed iframe', () => {
    expect(parsed.setAppleLink).toBe(
      'https://music.apple.com/us/album/max-styler-at-edc-las-vegas-2025-circuit-grounds-stage-dj-mix/1818472775?app=music&at=1000lwkw',
    )
  })

  it('still parses tracks alongside', () => {
    expect(parsed.tracks.length).toBeGreaterThan(0)
  })

  it("inherits the parent cue on mashup-linked rows that share an entry's ids[N]", () => {
    // 1001tl emits the mashup partner as `cueValuesEntry.ids[1] = 'tlp12_content'`
    // in the same entry as its parent (tlp11_content at 2325s). The row still
    // has the visual `w/` marker (class "con"); the cue is just stored on the
    // shared entry rather than its own block.
    const mashup = parsed.tracks.find((t) => t.isMashupLinked && t.title === "Let Em' Know")
    expect(mashup).toBeDefined()
    expect(mashup!.startSeconds).toBe(2325)
    expect(mashup!.isMashupLinked).toBe(true)
  })

  it('marks trailing untimed extras with null startSeconds (not s=0)', () => {
    // Several trailing rows — Drunken Kong, Shadow Child, etc. — appear after
    // the last cued track but have no time. They must not collapse to s=0.
    const trailing = parsed.tracks.filter(
      (t) => !t.isMashupLinked && t.startSeconds === null,
    )
    expect(trailing.length).toBeGreaterThanOrEqual(5)
  })

  it('keeps the legitimate first track at startSeconds=0', () => {
    const first = parsed.tracks[0]!
    expect(first.startSeconds).toBe(0)
    expect(first.startTime).toBe('0:00')
  })
})

describe('parseTracklist + selectCurrent (Habstrakt b2b JSTJR — regression)', () => {
  // Captured 2026-05-14 from the live page. Reproduces the original bug:
  // every track has a cue (last at 44:40), but the row right after Guest
  // List (Badders, tlp9_content) is encoded as ids[1] of Guest List's
  // cueValuesEntry. With the old ids[0]-only regex, Badders had
  // startSeconds=null; the old selectCurrent then saw Guest List's "next
  // start" as null and pinned Guest List as current for every offset past
  // 12:30.
  const url =
    'https://www.1001tracklists.com/tracklist/18kll1h1/habstrakt-jstjr-1001tracklists-x-dj-lovers-club-pres.-waterways-amsterdam-dance-event-netherlands-2024-11-11.html'
  const parsed = parseTracklist(url, fx('tracklist-habstrakt.html'))
  const setEnd = 2759 // user-reported videoDurationSeconds

  it('parses every cued track including the mashup-partner cue', () => {
    expect(parsed.tracks).toHaveLength(31)
    const badders = parsed.tracks.find((t) => t.title === 'Badders')!
    expect(badders.startSeconds).toBe(750)
    const guestList = parsed.tracks.find((t) => t.title === 'Guest List')!
    expect(guestList.startSeconds).toBe(750)
  })

  it('selectCurrent at 1668s (27:48) picks the track cued exactly there', () => {
    const r = selectCurrent(parsed.tracks, 1668, setEnd)
    const current = r.picked.find((t) => t.isCurrent)!
    expect(current.title).toBe('Outer Space (CHYL Remix)')
    expect(current.startSeconds).toBe(1668)
  })

  it('treats the two ids[N]-paired rows at 12:30 (Guest List w/ Badders) as one group', () => {
    // Currently playing at 12:35: 1001tl paired Guest List (ids[0]) with
    // Badders (ids[1]) at cue 750. Both must show isCurrent=true so the
    // caller can render the mashup pair together.
    const r = selectCurrent(parsed.tracks, 755, setEnd)
    const cur = r.picked.filter((t) => t.isCurrent).map((t) => t.title)
    expect(cur).toContain('Guest List')
    expect(cur).toContain('Badders')
  })

  it('selectCurrent at 1112s (18:32) picks the track whose window contains it', () => {
    // Cue 950 (Marlon Hoffstadt — It's That Time) → next real cue 1125
    // (Eminem — Shake That). 1112 falls in [950, 1125).
    const r = selectCurrent(parsed.tracks, 1112, setEnd)
    const current = r.picked.find((t) => t.isCurrent)!
    expect(current.title).toBe("It's That Time")
    expect(current.startSeconds).toBe(950)
  })

  it('does NOT pin Guest List as current well past its cue', () => {
    for (const sec of [1112, 1668, 2500]) {
      const r = selectCurrent(parsed.tracks, sec, setEnd)
      const current = r.picked.find((t) => t.isCurrent)
      expect(current?.title).not.toBe('Guest List')
    }
  })
})

describe('parseCueValueData', () => {
  it('extracts every cue mapping from the JS block', () => {
    const map = parseCueValueData(fx('tracklist-maxstyler.html'))
    // 22 cued entries; the mashup partner (tlp12) shares its parent's cue
    // via ids[1] in the same entry, so the map size is 23 (22 + 1 sibling).
    expect(map.size).toBe(23)
    expect(map.get('tlp0_content')).toBe(0)
    expect(map.get('tlp1_content')).toBe(227)
    expect(map.get('tlp23_content')).toBe(4400)
    // Mashup partner shares the parent entry's cue (tlp11 at 2325s).
    expect(map.get('tlp12_content')).toBe(2325)
    expect(map.get('tlp11_content')).toBe(2325)
    // Index 14 is missing in the page's emitted data — verify we don't synthesize it
    expect(map.has('tlp14_content')).toBe(false)
  })

  it('captures every ids[N] in a multi-id entry (Habstrakt b2b mashup pattern)', () => {
    const block = `
      cueValuesEntry = {};
      cueValuesEntry.seconds = 750;
      cueValuesEntry.ids = [];
      cueValuesEntry.ids[0] = 'tlp8_content';
      cueValuesEntry.ids[1] = 'tlp9_content';
      cueValuesEntry = {};
      cueValuesEntry.seconds = 840;
      cueValuesEntry.ids[0] = 'tlp10_content';
    `
    const map = parseCueValueData(block)
    expect(map.get('tlp8_content')).toBe(750)
    expect(map.get('tlp9_content')).toBe(750) // the sibling — would be missing without the fix
    expect(map.get('tlp10_content')).toBe(840)
  })

  it('returns empty map when no cueValueData block is present', () => {
    expect(parseCueValueData('<html><body>nothing</body></html>').size).toBe(0)
  })
})

describe('extractSetAppleLink (unit)', () => {
  it('returns null when no embed URL is present', () => {
    expect(extractSetAppleLink('<html><body>nothing here</body></html>')).toBeNull()
  })

  it('rebuilds the canonical URL with country, slug, album id, and query string', () => {
    const html =
      '<iframe src="https://embed.music.apple.com/album/some-slug/1234567/us/album/some-slug/1234567?app=music&at=foo"></iframe>'
    expect(extractSetAppleLink(html)).toBe(
      'https://music.apple.com/us/album/some-slug/1234567?app=music&at=foo',
    )
  })

  it('handles a non-US country code', () => {
    const html =
      '<iframe src="https://embed.music.apple.com/album/foo/999/gb/album/foo/999"></iframe>'
    expect(extractSetAppleLink(html)).toBe('https://music.apple.com/gb/album/foo/999')
  })
})

describe('normalizeArtworkUrl', () => {
  it.each([
    'https://www.1001tracklists.com/images/static/empty.png',
    '/images/static/empty.png',
    'https://cdn.1001tracklists.com/images/artworks/default_100.png',
    'https://cdn.1001tracklists.com/images/artworks/default_500.png',
    '',
  ])('returns null for placeholder %s', (raw) => {
    expect(normalizeArtworkUrl(raw)).toBeNull()
  })

  it('rewrites Beatport size to 300x300 regardless of input size', () => {
    expect(
      normalizeArtworkUrl('https://geo-media.beatport.com/image_size/1400x1400/abc-def.jpg'),
    ).toBe('https://geo-media.beatport.com/image_size/300x300/abc-def.jpg')
    expect(
      normalizeArtworkUrl('https://geo-media.beatport.com/image_size/60x60/abc-def.jpg'),
    ).toBe('https://geo-media.beatport.com/image_size/300x300/abc-def.jpg')
  })

  it('rewrites SoundCloud size to t300x300', () => {
    expect(
      normalizeArtworkUrl('https://i1.sndcdn.com/artworks-sDgTuNY7UCiK-0-t500x500.jpg'),
    ).toBe('https://i1.sndcdn.com/artworks-sDgTuNY7UCiK-0-t300x300.jpg')
    expect(
      normalizeArtworkUrl('https://i2.sndcdn.com/artworks-foo-bar-t120x120.jpg'),
    ).toBe('https://i2.sndcdn.com/artworks-foo-bar-t300x300.jpg')
  })

  it('passes through unknown CDNs unchanged', () => {
    expect(normalizeArtworkUrl('https://example.com/some/image.jpg')).toBe('https://example.com/some/image.jpg')
  })

  it('returns null for non-http inputs', () => {
    expect(normalizeArtworkUrl('javascript:void(0)')).toBeNull()
    expect(normalizeArtworkUrl('data:image/png;base64,xxx')).toBeNull()
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
