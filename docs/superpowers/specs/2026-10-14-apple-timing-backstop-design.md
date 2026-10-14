# Apple Music timing backstop for held mkvid sets - design

Date: 2026-10-14. Status: decisions locked by the owner (Max) in the interview;
the brainstorming questions below were answered from those decisions by the
implementing agent (Max was not available). Path: architectural (new module,
new columns, gate integration, admin route). The orchestrator stands in for the
spec approval; no separate writing-plans document (the quest asks for TDD
implementation straight after this spec).

## Intent

mkvid only renders a set whose verified 1001tl list has cue times on at least
90 % of its base rows (lib/mkvid-readiness.ts). A few hundred sets are held for
that, many for years. Many of those sets have an Apple Music "DJ mix" album
whose track durations give start offsets. Use them, carefully, to supply the
missing cues, so held sets render, while 1001tl cues stay the truth and the 90 %
rule stays exactly as it is.

Success: tonight's one-off moves every held set with a usable Apple album to
timed-enough without a 1001tl fetch, and pulls the rest of the held sets'
rechecks into the next few hours within the pool budget.

## Decisions (locked) and the answers drawn from them

1. Source: the public album page `music.apple.com/<cc>/album/<slug>/<id>`
   (browser UA), JSON-LD block `<script id=schema:music-album
   type="application/ld+json">` only (the id attribute is unquoted on the live
   page; other albums' durations appear elsewhere on the page). Fallback when
   the block is missing or unparseable: amp-api
   `amp-api.music.apple.com/v1/catalog/<cc>/albums/<id>` with the web player's
   developer token, scraped from the music.apple.com JS bundle and cached in KV
   until its `exp`; any failure gives up quietly with a log. Parsed albums are
   cached in KV per id (`apple:album:v1:<id>`, 90 days; a miss for 1 day).
2. Matching: order-aware fuzzy matching of 1001tl base rows (not layered "w/"
   rows) to Apple tracks. Normalise: NFKD + strip accents, lowercase, `&` ->
   and, drop feat./ft./featuring clauses, drop bracketed mix words ((Mixed),
   (Original Mix), (Extended Mix), (Edit)), keep remixer words, drop
   punctuation. Apple mashups ("A / B (Mixed)") match on either half. ID rows
   and rows with no title never match. Token Dice similarity >= 0.6 (or an
   equal title core) is a candidate; a monotone alignment (LCS-style DP that
   maximises total similarity) respects order, so reordered or missing rows
   just stay unmatched.
3. Threshold: the album is used only if matched base rows / base rows >= 70 %
   (ID rows count in the denominator, so an ID-heavy set fails; that is the
   locked rule). Setting `appleCues.minMatchShare` (0..1, default 0.7).
4. Length check (added by Max mid-quest): the album's total duration (sum of
   its tracks) must agree with the source audio length within
   max(3 % of the source, 2 min) - settings `appleCues.lengthTolerancePct`
   (default 3) and `appleCues.lengthToleranceMinutes` (default 2). Source length,
   best available first: the YouTube duration (video_meta) of the mkvid video
   this request replaces (a recreate: rendered from the same source), else
   `set_media_facts.audio_max_seconds` (the longest SoundCloud / Mixcloud player
   on the set page, written on every page fetch). mkvid reports no probed length
   to the Worker, so nothing else is known.
   Unknown source length: the album is used only when the 1001tl cues themselves
   vouch for it - at least one real cue past row 0 on a matched row, the album is
   not shorter than the last real cue, and every anchor-to-anchor gap's scale
   (real cue span / Apple offset span) is within the same tolerance. Otherwise
   skipped as "source length unknown". A skip records the reason, e.g.
   `length mismatch: album 58:10 vs source 1:02:45`.
5. Fill (anchored): Apple cumulative offsets o_k. Anchors = base rows with a
   real 1001tl cue that matched an Apple track, plus row 0 at cue 0 / offset of
   its match (or offset 0 when row 0 is unmatched). For an uncued matched row
   between anchors A and B: cue = a + (o_k - oA) * (b - a) / (oB - oA);
   after the last anchor: cue = a + (o_k - oA). Rounded to seconds. A filled cue
   must lie strictly between the nearest real cues before and after it,
   otherwise that row stays untimed. Only rows without a cue are filled;
   unmatched rows stay untimed (no interpolation).
6. Where: the Apple pass runs on the stored list (`mkvid_request_tracks`) every
   time it is saved for mkvid (saveMkvidTracks, both saved and kept), on the
   "Queue for re-check now" button, and in the one-off. It runs only for a
   trusted list (names are nulled on untrusted ones) that is not timed-enough
   from its 1001tl cues alone. Filled rows carry `cueFrom: "apple"` in the
   stored JSON; a re-run resets them first, and getMkvidTracks strips the
   marker so the claim wire format is unchanged. The video and description use
   the filled cues like any cue. `last_cue_seconds` is not touched.
7. Recorded per request (migration 0022, on mkvid_request_tracks):
   `apple_album_url` (from the parsed page's setAppleLink; for older rows the KV
   tracklist cache, stale allowed, is read instead), `apple_cues` (cues filled),
   `apple_note` (why the album was or was not used).
8. UI (hint only): readiness rows carry `apple: { cues, note }`. The mkvid page
   (queue Status cell, drawer) and the set page diagnostics show "N cues from
   Apple Music" with a data-tip; a held set's skip reason is in the tip and the
   diagnostics facts. Nothing red (nothing for the owner to act on).
9. Button "Queue for re-check now" on held-untimed sets (mkvid drawer, set page
   diagnostics): `POST /ui/api/mkvid/recheck-now/:id` runs the Apple pass from
   the stored list, marks the set due now for a pool refetch (markSetDue - the
   scheduler fetches it within the pool budget), and answers the new readiness.
10. One-off: `POST /ops/mkvid/apple-backstop` (bearer API_TOKEN, idempotent).
    Cursor (request rowid) over held sets (pending, stored list not
    timed-enough), `limit` per call (default 20, max 50). Per set: (a) the Apple
    pass from the stored list (no 1001tl fetch); (b) a still-held set's
    `set_schedule.next_due_at` is pulled in (never pushed out) to
    `now + 10 min + position * spacing`, spacing 60 s, so a few hundred sets
    land over ~5 h and the scheduler's own budget gates decide the actual
    pace. Answers counts for the batch plus running totals kept in KV, and
    `nextCursor` (null when done). Re-running from cursor 0 is harmless: the
    pass is idempotent and (b) only pulls in.

## Units

- `src/lib/apple-album.ts`: album id from URL, JSON-LD parser, amp-api parser,
  token scrape, fetch + KV cache. Network injected for tests.
- `src/lib/apple-cues.ts`: pure - normalise, match, length check, anchored
  fill, `planAppleCues` (decides and returns new tracks + count + note).
- `src/lib/apple-backstop.ts`: D1/KV glue - `applyAppleCuesToRequest`,
  `appleBackstopBatch`.
- Hooks: lib/mkvid.ts (saveMkvidTracks, getMkvidTracks), lib/mkvid-readiness.ts
  (readinessFor), lib/app-settings.ts + ui settings page (new `appleCues`
  group), routes/subscriptions.ts (button), routes/mkvid-ops.ts (one-off),
  ui/pages/mkvid-state.ts, mkvid.ts, set-diag.ts.

## Errors

Every Apple step is best effort: a fetch, parse or D1 failure logs a warn and
leaves the list as the 1001tl cues made it; a save never fails because of it.

## Tests

JSON-LD parser (small synthetic fixture shaped like the live page, unquoted
id, a decoy duration outside the block), amp-api parser, matcher (accents,
feat., remix parentheses, (Mixed), mashup halves, ID rows, reordered and
missing rows), anchored fill, 70 % threshold and the setting, length check
(match, mismatch, unknown with and without cue evidence), route/button, the
one-off batching and pull-in.
