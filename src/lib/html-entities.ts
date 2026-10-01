/**
 * Decode every HTML entity: named (`&auml;`, `&Oslash;`, `&iuml;`, ...),
 * decimal and hex. 1001tracklists writes accented names as named entities
 * in `<title>`, `<h1>` and `meta content`; the old hand-rolled decoders knew
 * eight of them, so "Chris Gek&auml;" reached titles and YouTube (2026-10-01).
 * Single pass: `&amp;auml;` becomes the text `&auml;`, never `ä`.
 */
import he from 'he'

export function decodeEntities(s: string): string {
  return he.decode(s).replace(/ /g, ' ') // &nbsp; stays a plain space, as before
}
