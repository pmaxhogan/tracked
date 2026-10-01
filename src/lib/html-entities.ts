/**
 * Decode every HTML entity: named (`&auml;`, `&Oslash;`, `&iuml;`, ...),
 * decimal and hex. 1001tracklists writes accented names as named entities
 * in `<title>`, `<h1>` and `meta content`; the old hand-rolled decoders knew
 * eight of them, so "Chris Gek&auml;" reached titles and YouTube (2026-10-01).
 * Single pass: `&amp;auml;` becomes the text `&auml;`, never `ä`.
 */
import he from 'he'

// Only complete, `;`-terminated entities: several call sites get text that
// node-html-parser already decoded, and a second pass must not turn a literal
// "Rock&reggae" into "Rock®gae" (he's legacy semicolon-less rule).
const ENTITY_RE = /&(?:#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/gi

export function decodeEntities(s: string): string {
  return s.replace(ENTITY_RE, (m) => he.decode(m)).replace(/ /g, ' ') // &nbsp; stays a plain space, as before
}
