# Graph tab - design

Date: 2026-10-14. Status: decisions locked by the owner (interview done); this
spec records how they are implemented. Brainstorming questions were answered
from the locked decisions; open points picked here are listed under
"Judgment calls".

## Intent

A "Graph" page in the tracked UI that draws the library as an interactive
directed graph, so the owner can see how DJs, sets, sources, tracks, remixes
and artists connect, and jump from any node to the page tracked (or
1001tracklists) already has for it. Success: from a chosen DJ, artist, source
or search hit the neighbourhood draws in well under a second from cached data
only, nodes expand on click, the layout is readable, every node is labelled,
categories can be hidden, and it works (as a bottom sheet) on a phone.

Constraints: cached data only at view time (no 1001tracklists fetch while
browsing); never build the graph from KV (`tl:v4:*` is not enumerable); decoy
pages must never write graph data (verified lists only, the search index's
rule); pool fetches only at the lowest priority, inside the pool budget.

## Graph model

Node categories (node id prefix):

| category | id                                             | from                                        |
| -------- | ---------------------------------------------- | ------------------------------------------- |
| dj       | `a:<artist key>`                               | an artist whose key maps to a subscribed DJ |
| artist   | `a:<artist key>`                               | track credits and set headings              |
| set      | `s:<set url>`                                  | `search_sets`                               |
| source   | `src:<1001tl source id>`                       | set heading (`#pageTitle`) links            |
| track    | `t:<1001tl page id>` or `k:<search track_key>` | `search_tracks`, credits                    |
| remix    | same as track                                  | a track that has a base track               |

Edges (directed, `kind`):

- `plays`: artist/dj -> set (set heading artists; `search_sets.dj_slug` as a fallback)
- `source`: source -> set
- `has`: set -> track (`search_track_sets`)
- `by`: artist -> track (main credit), `feat`: featured artist -> track,
  `remixer`: remixer -> remix
- `remix` / `rework`: base track -> its remix / rework

Artist key: a slug made from the display name (`nameSlug`), for linked and
unlinked credits alike. The 1001tl artist link is kept as an attribute, not
used as the key: the captured pages link credits to combined pages now and
then ("Lydon" to `/artist/mgnky4/leftfield-&-lydon/`, "Bauchamp" to
`round-table-knights-bauchamp`), while the name is what the row shows. Both
link forms (`/artist/<slug>/tracks.html`, `/artist/<id>/<slug>/index.html`)
are read. "ID" artists are no credit. A DJ is matched to an
artist key through the heading: a `/dj/<djslug>/` link stores `dj_slug` on the
artist row of its name; a subscribed DJ with no row yet maps to the slug of
its name.

Track identity: the 1001tl track page id (`/track/<id>/...`), which is not the
medialink id `search_tracks.track_id` holds. `search_tracks` gains `page_id`
(filled from `track_url`, and by the migration for existing rows). A played
track without a page link stays `k:<track_key>`.

## Parsing (src/lib/tracklist-credits.ts)

`parseSetGraph(html)` returns:

- `sources`: `#pageTitle a[href*="/source/"]` (covers the `<div id=pageTitle><h1>`
  and the `<h1 id=pageTitle>` layouts; the page's Hot Shows / Hot Events
  modals carry many other source links that are ignored): `{ id, slug, name }`.
- `artists`: the heading's `/dj/<slug>/` and `/artist/.../tracklists.html` links.
- `rows`: per named row with a track page id: artist/title (microdata),
  page id, label + label id (publisher microdata), genre, duration
  (`PT7M51S`), the version word (`span.remixValue`, e.g. "Remix"), credits
  from `span.trackValue`: main artists (spans before the " - " separator, each
  `span.notranslate` with its own artist link, split by `span.spLR`),
  featured (plain " ft. A & B" text, no link), remixers (the spans inside the
  "(...)" group before `span.remixValue`). Base track: the `/track/` link in
  the title span when it differs from the row's own id (`kind: remix`), and
  the `fa-recycle` "rework of track A - B" link after the track value
  (`kind: rework`, base named from the title attribute).

No title heuristics: credits and remixes come only from links and spans.

## Storage (migrations-search/0003_graph.sql, SEARCH_DB)

- `search_tracks.page_id` + index (backfilled in SQL from `track_url`).
- `search_artists(key PK, name, tl_path, dj_slug, updated_at)`
- `search_graph_tracks(page_id PK, artist, title, tl_path, label, label_path, genre, duration_s, version, updated_at)`:
  every track seen in credits, bases included (a base that was never played
  is only here).
- `search_track_artists(page_id, artist_key, role, pos)` PK (page_id, artist_key, role)
- `search_track_bases(page_id, base_id, kind)` PK (page_id, base_id)
- `search_sources(id PK, slug, name, updated_at)`, `search_set_sources(set_url, source_id, pos)`
- `search_set_artists(set_url, artist_key, pos)`
- `search_graph_sets(set_url PK, format, parsed_at, origin)`: which sets were
  graph-parsed (`origin` fetch | pages).

Written by `writeSetGraph` (src/lib/graph/store.ts): one SEARCH_DB batch per
set, a fixed number of statements over `json_each` binds (the indexer's
style). A set's sources and heading artists are replaced; a track's credits
are replaced by the latest page that lists it; bases are upserted.

Writers:

1. `indexVerifiedFetch` (verified/unchanged fetches only): after indexing, or
   when the index skip rule holds but the set has no current graph row.
2. Page-store backfill (stored R2 HTML, `clean/<day>/set/...`): only when the
   stored page's fingerprint equals the set's verified fingerprint.
3. Pool backfill: the existing search index catch-up (fetch-scheduler) with
   its format date moved to `GRAPH_FORMAT_SINCE` while `graph.backfill` is on,
   so older sets are refetched once at pool priority backfill, on top of the
   draw, `indexCatchUp.perTick` (1) / `perDay` (200), skipped whenever a
   budget hold is in force. Candidates already graph-parsed (for example by
   the page-store pass) and fetched after the old format date are dropped.

## Settings (app settings, `graph` group)

- `nodeCap` (default 5,000, 100..1,000,000): most nodes one response or the
  whole-library view returns.
- `confirmOver` (default 300): an expansion adding more neighbours asks first.
- `backfill` (default on): the pool catch-up for sources and credits.
- `pagesPerTick` (default 10, 0..100): stored pages the cron reads a tick.

## API (routes/graph.ts, under /ui behind CF Access)

- `GET /ui/api/graph/find?q=` focus candidates: DJs, artists, sources, sets,
  tracks (prefix/substring match, a few each).
- `GET /ui/api/graph/expand?id=&depth=1|2` neighbours of a node (depth 2 =
  their neighbours too), nearest first, capped at `nodeCap`, with `truncated`
  and the `limits`. The page counts the nodes it does not have yet and asks
  before adding more than `confirmOver` (exact "new neighbours", and the
  data is cached, so fetching first is cheap); it never holds more than
  `nodeCap` in all.
- `GET /ui/api/graph/library` the whole library up to `nodeCap` (DJs, sources,
  sets first, then tracks by sets played, then artists), with `truncated`;
  the page asks first.
- `GET /ui/api/graph/status` counts (sets parsed so far) and the limits.
- `GET /ui/api/graph/info?id=` the info panel for one node.
- `POST /ui/api/graph/backfill/pages` one manual page-store step.

Compact JSON: `nodes: [[id, cat, label, size, sub?]]`, `edges: [[from, to, kind]]`.
Tracks and remixes carry the title as `label` and the artist as `sub`.
503 when SEARCH_DB is unbound.

## Page (src/ui/pages/graph.ts, /ui/graph)

Sidebar item "Graph" in Library after "Removed videos" (not a phone tab).
Sigma.js 3.0.3 + graphology 0.26.0 + graphology-library 0.8.0 (ForceAtlas2 in
a web worker via `FA2Layout`, `inferSettings`) from jsdelivr with exact
versions and SRI hashes, loaded on this page only (first external JS in
tracked; README notes it). Toolbar: find box with results, depth, Whole
library, Fit, Layout run/stop, labels toggle. Legend chips double as category
toggles. Click a node: info panel (desktop right column, phone bottom sheet)
plus expansion; double click focuses. Edge click shows the edge's kind.
Colors: validated categorical palette; the DJ category also has a ring (node
border program); sigma has no other shapes.

### Labels, pins, Display and Forces (second pass, 2026-10-14)

- Labels are drawn inside the nodes (custom `defaultDrawNodeLabel` /
  `defaultDrawNodeHover` on sigma's canvas layer): centred, shrunk a little
  then cut with an ellipsis, and not drawn at all when the node is under
  10 px on screen. Tracks and remixes are two lines, title then artist in
  smaller text; a set "DJ @ Event 2026-03-28" is the event then the date
  (the event then the DJ when there is no date). Hover shows the full name in
  a box. Node sizes are in graph units (`itemSizesReference: "positions"`),
  so text appears as you zoom in.
- Labels never overprint (third pass, after real data: 1,872 nodes for one
  DJ at depth 2). Sigma draws labels on a canvas above every node, so in a
  packed core the names of overlapping nodes piled up. `drawLabel` now only
  queues the node; after the frame (`afterRender`) the labels are placed
  greedily: the selected node, then undimmed before dimmed, then DJs,
  sources, sets, artists, tracks and remixes, then by links. A label is drawn
  only when its box touches no other node's disc and no label already placed
  (`placeLabels`, a grid on screen).
- Drag works while the layout runs: the FA2 supervisor gets an
  `outputReducer`, which makes it copy the graph's positions back into its
  matrices every tick; the reducer holds dragged and pinned nodes in place.
  A dragged node stays pinned (dashed ring) until Unpin in the info panel or
  Release pins. Links to a pinned node weigh `1 + pinPull * (degree - 1)` of
  the other end (`getEdgeWeight`), so neighbours gather around it even when
  they are hubs.
- Root cause of "dragged nodes did not pull their neighbours" (measured on a
  seeded 986-node graph), three separate findings: (a) pause, drag, resume
  reached an equilibrium, not a slow crawl: with every link weighing 1, each
  of a DJ's sets is held by 15 to 30 track links plus mass-weighted gravity
  against one link to the DJ, so the sets moved ~15% of the way and no
  further (the same at 6 s and 20 s; slowDown 1 or 4 made no difference;
  outboundAttractionDistribution made it worse, it divides the pull by the
  pinned node's mass). The fix is the pin weight above. (b) While the layout
  ran, the worker overwrote a drag every tick: the supervisor re-reads graph
  positions only when it has an outputReducer, and reads `fixed` only at
  start. (c) `fixed` was set on drag and never cleared, with no way to
  release it.
- The layout stops by itself when at most 5% of nodes still move more than
  0.2% of the graph's extent per tick (a ceiling of 20 s to 2 min). The stop
  is never done inside the supervisor's message handler (the settle test runs
  there, through `eachNodeAttributesUpdated`): `kill()` nulls its matrices
  and the handler then threw "Cannot set properties of null (setting
  'nodes')". It is deferred to the next turn, and `add()` kills the worker
  before adding nodes (adding makes a running supervisor respawn on a timer).
- "No overlap" is a finishing pass, not FA2's `adjustSizes`: on a 1,700-node
  seeded graph FA2's anti-collision left 1,400 of 1,700 nodes overlapping
  after its phase, and noverlap alone cannot open up a packed core (it only
  nudges neighbours apart; 300 iterations changed nothing). So the pass first
  shrinks every node until three quarters clear their nearest neighbour
  (`spacing`, `fitShrink`, never under 0.3x, reset by Clear), then runs
  graphology's noverlap in rounds of 10 iterations until a round moves
  nothing (at most 80). Result on that graph: 1 overlapping pair. The spread
  (scalingRatio) grows with the node count past 300 (`spreadScale`, x5.8 at
  1,700, at most x8).
- New nodes start next to a neighbour already placed (nodes arrive nearest
  first), on a sunflower spiral around it (`childOffset`), so 400 sets around
  one DJ start as a disc, not a clump.
- Display drawer, per category: show, label, size (0.25x to 4x on a log
  slider) and color; `tk-graph:display` in localStorage. Forces drawer: the
  ForceAtlas2 knobs plus Pin pull, applied live (the supervisor sends its
  settings object every tick; pin pull restarts the worker), Re-run layout
  and Reset to defaults; `tk-graph:layout`. Defaults: gravity 0.05, strong
  gravity on (plain gravity lets small components drift far off), spread
  (scalingRatio) 10, slow down 2, LinLog off, spread hubs
  (outboundAttractionDistribution) off, no overlap on, Barnes-Hut auto (on
  from 500 nodes), theta 0.6, edge weight 1, pin pull 1.

## Error handling

CDN blocked: the page says the graph library did not load. API failures use
`TK.errText`. Parser: any row it cannot read is skipped; graph writes never
throw into the sync (logged `graph.write_failed`).

## Testing

vitest: parser on the captured fixtures (habstrakt, matroda, maxstyler for
credits and sources; decoy fixture for the `h1#pageTitle` layout and artist
link forms only, its names are randomized) plus a synthetic row fixture
(ft., `&` artists, `/artist/<slug>/tracks.html`, genre, duration); store +
query (focus, depth, caps, confirm threshold, DJ matching, library cap);
page-store backfill (fingerprint gate); catch-up candidate rule; settings
defaults; the page in ui-pages tests.

## Judgment calls

- Parser lives in a new module (`tracklist-credits.ts`) called by the
  indexer, not in `ScrapedTracklist`: that object is cached in KV and shared
  with other in-flight work; the graph needs it only at index time.
- Artists are keyed by a slug of their name, so a featured (unlinked) artist
  merges with the linked artist of the same name, and two different artists
  with one name merge too (accepted).
- The stored-pages pass runs whenever `graph.pagesPerTick` > 0 (it costs no
  pool budget); `graph.backfill` gates only the pool refetch.
- The pool backfill reuses the index catch-up instead of a second scheduler
  kind; its caps are the pool settings' `indexCatchUp` ones.
- Depth is capped at 2 server-side.
