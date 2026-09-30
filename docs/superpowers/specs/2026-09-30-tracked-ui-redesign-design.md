# tracked web UI redesign: design spec

Status: approved by the owner on 2026-09-30 (design artifact "tracked New UI", every proposed default accepted).
Branch: `new-ui` in worktree `tracked-ui`, off `origin/main` at `d5ab9c4`.
Companion: `2026-09-30-tracked-ui-behaviour-contract.md` (the client-side behaviour every rebuilt page must keep).

## 1. Goal

Replace the tracked admin's single 640px column and its detached pool pages with a multi-page information architecture and an app shell that uses desktop width (a wide monitor, often beside other windows) and works on a phone (captchas are answered from the phone). Add three new capabilities on top: a per-set diagnostics page, a unified activity log, and fuzzy search over every verified tracklist.

The individual components (track rows, set cards, the captcha widget, the add-account flow, the mkvid queue controls) are fine and are restyled, not redesigned.

## 2. Decisions

| Topic | Decision |
| --- | --- |
| Prefix | Everything that lives under `/subscriptions/**` today (pages, `/api/*`, `/oauth/*`, `sw.js`) moves to `/ui/**`, with the same shapes. `GET /` becomes a 302 to `/ui/`. The Cloudflare Access application path and the Google OAuth redirect URI move with it (section 3a). |
| Identity | amber's token shape, shell classes, small components and icon dictionary, ported by hand into server-rendered CSS. tracked gets its own palette (section 7). amber's built CSS cannot be served: it is a Vue 3 + PrimeVue SPA whose look lives in a runtime preset. |
| URLs | HTML page paths may change; no redirects required. JSON/API paths never change. |
| Shell | Sidebar app shell (option A). Collapses to icons at 1100px; under 800px a top bar plus a bottom tab bar. |
| Phone tabs | Home, DJs, Search, mkvid, Pool. Everything else behind the top-bar menu. |
| Tracklist viewer | Becomes the Set page at `/ui/set?url=`, and grows a diagnostics column in phase 2. `/subscriptions/tracklist` is retired. |
| Search index | Verified track lists only, fed from `noteSetFetch` in `src/lib/verification.ts` (owner's decoy rule, relayed by the pool session). Per-track YouTube links found by the lazy links lookup are written back into the index. |
| Accent | Violet on slate neutrals. Dark first, designed light mode, manual toggle (system / dark / light). |
| Removed videos | Same path, `/ui/removed` (push payloads open it), filed under Playlists in the nav. |
| Phasing | Phase 1 ships to main first (after the owner's ok and the pool session's all-clear), then phase 2, then phase 3. |
| Top jobs (order the Home page and phone tabs by) | answer captchas / live view; diagnose "why isn't set X in my playlist"; tend the mkvid queue; manage DJs and resync. |

## 3. Non-negotiables

Taken from the code and tests at `d5ab9c4`. They are spec, not folklore.

1. Every JSON/API route keeps its request and response shape. `/now-playing`, `/tracklist`, `/tracklist/purge`, `/pool/events`, `/mkvid/*`, `/likes`, `/liked-songs` and `/openapi.json` keep their paths too. Every `/subscriptions/api/*` route, the tlpool proxies under `/subscriptions/api/pool/*` and the OAuth routes move to the same path under `/ui/` (section 3a); nothing else about them changes.
2. Cloudflare Access on every `/ui/*` request; bearer gates elsewhere; the mount order in `src/index.ts` (`sameOriginJson` on `/ui/api/*` and `/ui/oauth/disconnect`, `noFraming` on `/ui` and `/ui/*`, `poolUiApp` mounted before `subscriptionsApp`, both at `/ui`; the wildcard bearer gate exempts `/ui`, `/mkvid`, `/pool` and `/`).
3. Same-origin JSON on state changes: every non-GET fetch carries `'content-type': 'application/json'` and `credentials: 'same-origin'`. No `<form method=post>`. `test/same-origin.test.ts` scans each page's inline scripts with `method:\s*'(POST|PUT|DELETE|PATCH)'` and requires the content-type literal inside the same object literal; the shared fetch wrapper must keep `method` and the header in one object, the `/ui` page must contain more than two such fetches, and the pool page must contain the verbatim `headers: { 'content-type': 'application/json' }`. Add every new page path to that test's list.
4. Web Push: the service worker moves to `/ui/sw.js` (scope `/ui/`); every server-generated push payload URL moves with it: `/ui/captcha/<id>`, `/ui/pool`, `/ui/removed`, `/ui/`, and the legacy `/ui/accounts` 302 (grep `src/lib/pool-events.ts`, `src/lib/playlist-hygiene.ts`, `src/lib/web-push.ts`, `src/lib/ban-state.ts`). On first load under the new prefix the client unregisters the old `/subscriptions/` registration, subscribes with the new one, and posts `push/unsubscribe` for the old endpoint, so a device does not end up with two subscriptions.
5. Tests extract page scripts with `/<script>([\s\S]*?)<\/script>/g` and run them in `node:vm` against a stub DOM: script tags stay bare and inline. The pool pages keep their element ids, literal strings and `<h1>` prefixes (companion doc, section 11). Every page keeps a link to `/ui/pool/settings`.
6. `test/pool-ui.test.ts` imports `createPoolUiApp` and `POOL_PAGES` (`{ POOL_PAGE_HTML, CAPTCHA_LIST_HTML, SETTINGS_PAGE_HTML, captchaPageHtml }`) from `src/routes/pool-ui`; `test/admin-hardening.test.ts` dynamically imports `BAN_JS` from `src/routes/ban-ui`. Keep those exports.
7. The banner's Dismiss hides the banner for this pause and never lifts `ban:pause`. The 409 `no_free_exit` message on Add account stays.
8. Pool data only through `src/lib/pool-admin-client.ts`, `pool-events.ts`, `verification.ts`; accounts are `acct-N`, never a username, email or exit credential. Never call tlpool or 1001tracklists directly from UI code. Public repo: nothing sensitive in code, fixtures, docs or commits.
9. No new writes on the hot paths (`*/5` tick, `/mkvid/claim`, `/now-playing`) except the search-index upsert inside `ctx.waitUntil` with errors swallowed. Migrations number from `0012`; send DDL to the pool session before writing it; apply to production (with a D1 export first) before the push that deploys it.
10. No script/style CSP exists; inline CSS and JS stay inline. Do not add a CSP.

## 3a. Prefix move: `/subscriptions/**` to `/ui/**`

Owner decision (2026-09-30). Everything the Worker serves under `/subscriptions` moves to `/ui` with identical shapes; `/subscriptions/**` is not served any more. `GET /` (today: hint text behind the bearer gate) becomes a 302 to `/ui/`, exempt from the bearer gate. Both `/ui` and `/ui/` serve Home.

Code touch points (grep for `subscriptions` and check each hit; the list is what the survey found at `d5ab9c4`):
- `src/index.ts`: the two `sameOriginJson` mounts, the two `noFraming` mounts, both `app.route('/subscriptions', ...)` mounts, the wildcard bearer gate's prefix exemptions, the `GET /` handler and its comment.
- `src/middleware/same-origin.ts`: `LIVE_VIEW_PATH` (the live-view iframe path that gets `SAMEORIGIN` / `frame-ancestors 'self'`).
- `src/routes/subscriptions.ts`: `STATE_COOKIE` path (`/subscriptions/oauth` to `/ui/oauth`), the OAuth redirect URI the callback expects, the `?yt=` redirect targets, every `/subscriptions/api/...` literal in page JS (moves into `src/ui/` anyway).
- `src/routes/pool-ui.ts`: `NAV_HTML`, `COMMON_JS` base path (`/subscriptions/api/pool`), the `/accounts` redirect target, the live-view iframe URL, `cfAccess` path list.
- `src/routes/ban-ui.ts`: service worker registration path and scope, `SW_JS` default `url`.
- `src/lib/pool-events.ts`, `src/lib/playlist-hygiene.ts` (`playlistHoldPayload`), `src/lib/web-push.ts`, `src/lib/ban-state.ts`: push payload URLs.
- `README.md`, `.dev.vars.example`, `docs/tasker-setup.md`: every mention.
- Tests: `test/pool-ui.test.ts` (17 gated paths, redirect, nav link), `test/same-origin.test.ts` (page list, guard paths), `test/admin-hardening.test.ts` (sw.js, redirect, framing), `test/playlist-hygiene.test.ts` (hold payload url), `test/mkvid-verified-recreate.test.ts`, `test/playlist-rename.test.ts`, `test/tracklist-cache.test.ts`, `test/lazy-links.test.ts`, `test/audit-routes.test.ts`, `test/pool-api.test.ts` and any other `app.request('/subscriptions...')`.

Optional, recommended: one `app.all('/subscriptions/*')` handler that 301s to the same path under `/ui/` (no auth needed, nothing served), because push notifications delivered before the deploy carry the old URL and phone bookmarks exist. The owner said redirects are not required; drop it if unwanted.

Owner steps outside the repo, before the phase 1 deploy:
- Cloudflare Access: change the self-hosted application's path from `/subscriptions` to `/ui` on the same application (editing keeps the AUD; creating a new application changes `CF_ACCESS_AUD` in `wrangler.jsonc`). The cookie the Worker verifies is `CF_Authorization`, unchanged.
- Google Cloud Console: change the authorized redirect URI to `https://<worker-host>/ui/oauth/callback`.
- Nothing changes for Tasker (`/now-playing`), mkvid (`/mkvid/*`, `TRACKED_URL`) or tlpool (`/pool/events`).

## 4. Sitemap

All under `/ui` (the Access application, service worker scope, same-origin guard and anti-framing are bound to that one prefix; see section 3a for the move). "Same path" below means the path is unchanged apart from the prefix.

| Path | Page | Phase | Notes |
| --- | --- | --- | --- |
| `/ui` | Home | 1 | status tiles, needs-attention list, recent activity, quick actions |
| `/ui/djs` | DJs | 1 | table on desktop, cards on phone; add form in the header |
| `/ui/dj/:slug` | DJ profile | 1 | same path; sticky summary column + set cards |
| `/ui/set?url=` | Set | 1 (viewer), 2 (diagnostics) | replaces `/ui/tracklist`; `?url=` deep link kept |
| `/ui/search?q=` | Search | 3 | sets, tracks, DJs |
| `/ui/playlists` | Playlists | 1 | YouTube connection, combined playlist, per-DJ playlist table, fix titles, hygiene strip |
| `/ui/removed` | Removed videos | 1 | same path (push target) |
| `/ui/mkvid` | mkvid | 1 | status line, caps, Queue / Finished / Old videos tabs, detail drawer |
| `/ui/activity` | Activity | 2 | unified log, filters in the URL, detail drawer |
| `/ui/pool` | Pool accounts | 1 | same path; stats, challenges, accounts table, add-account dialog |
| `/ui/captcha` | Challenges | 1 | same path |
| `/ui/captcha/:id` | Challenge | 1 | same path (push target); phone-first, 560px centered on desktop |
| `/ui/pool/settings` | Pool settings | 1 | same path (tests link to it) |
| `/ui/settings` | Settings | 1 | YouTube account, notifications and devices, theme, integrations status, ban episodes |
| `/ui/tools` | Tools | 1 | video JSON, purge a tracklist, simulate ban, requeue victims, migration status, (3) rebuild search index |

Same path under the new prefix: `/ui/sw.js`, `/ui/oauth/*`, `/ui/accounts` (302), every `/ui/api/*`. Nothing is served under `/subscriptions` any more (section 3a).

What moved from the current single page: YouTube strip to Playlists and Settings; add form and DJ list to DJs; Combined playlist to Playlists; mkvid uploads to mkvid; YouTube video JSON to Tools; Recent requests and Recent playlist additions to Activity (phase 2; in phase 1 Home shows the last 6 of each side by side); IP-ban history and push devices to Settings; simulate-ban and requeue-victims to Tools.

## 5. App shell

- Desktop (>= 1100px): 15rem sidebar with grouped navigation and a footer (status pill: Paused / Active / Pool offline; theme toggle; "Signed in via Access"); main area up to 1400px; a search box in the top of main (`/` focuses it; phase 1 links it to the DJs filter, phase 3 wires it to search).
- Sidebar groups: Home; Library (DJs, Search, Playlists, Removed videos); Pipeline (mkvid, Activity); Pool (Accounts, Challenges with a live count, Pool settings); Settings; Tools.
- 800px to 1100px: sidebar collapses to icons with tooltips.
- Under 800px: top bar (page title, menu) and a bottom tab bar: Home, DJs, Search, mkvid, Pool.
- The shell owns the ban/pause banner slot on every page (the README promises it on every admin page; today only three pages carry it), with `BAN_JS`'s polling and Dismiss behaviour unchanged.
- Page header on every page: title, one-line description, actions (wrap under the title on a phone).
- Every page is one server-rendered HTML document: shell CSS + page CSS + shared runtime JS + page JS, all inline (about 30 KB). The theme boot script runs before first paint.

## 6. Pages

Behaviour details (polling, paging, copy, confirmations) are in the companion contract and are not repeated here.

### Home
Status tiles: Fetching (active / paused until; pool pages used of budget from `api/pool/status`), YouTube (channel; combined inserts used of cap from `api/combined`), mkvid (the existing status line and both caps from `api/mkvid`), Challenges (count, oldest time left). Needs attention: open challenges, flagged or retired accounts, held playlists, failed mkvid requests, undeleted old videos, DJs whose last sync errored (`api/state/:slug`), an active ban episode; each row links to its fix. Recent activity: phase 2 `api/activity?limit=12`; phase 1 the last 6 requests and last 6 playlist additions side by side. Quick actions: Sync all, Backfill combined, Run hygiene compare.

### DJs
`api/list` plus `api/state/:slug` per row. Columns: DJ (profile link, 1001tracklists link), Sets (processed of known, pending), Last sync (time, error badge), Playlist (link, count), Actions (Sync, Invalidate & resync, Remove with in-row confirm). Header: Add DJ (URL field), Sync all, Invalidate & resync all, Fix titles (dialog: dry run first, then confirm). Filter: text over names, "with errors" toggle. Cards under 800px.

### DJ profile
Sticky summary column (subscribed badge, counts, playlist link, last sync, Sync, Invalidate & resync, Refresh from 1001tracklists) plus set cards in the remaining width (two across at 1300px). Cards keep the lazy per-set load, completeness badge, set links, "Open set page", "Remove and replace". Filter chips: all / with video / no video / partial ID.

### Set
Phase 1: the viewer as is (URL field, `?url=` prefill and auto-load, track rows, Load links, Refresh track list) at the new path. Phase 2: a diagnostics column from `GET /ui/api/set?url=` (new, read-only): Discovered (`tracklists` row), Recording (video id, source, checked at, next due from `set_schedule`), Verification (`set_verification`), Full-recording rule (`set_media_facts`, `video_overrides`), Playlist (`playlist_additions` rows for the URL), Hygiene (`removed_videos`, `playlist_removals` for the video), mkvid (`mkvid_requests` status, position, waits-because, trusted list). Actions are the existing ones only.

### Search (phase 3)
One input, results as you type (150 ms debounce, previous request cancelled), grouped All / Tracks / Sets / DJs, keyboard navigation, highlighted tokens, corrected-query notice with "search exactly". Track result: artist and title, label, the sets it appears on (DJ, date, cue, Set page and 1001tracklists links), 1001tracklists track link, YouTube link when known, else the lazy "links" button. Set result: title, DJ, date, completeness, video badge, Set page and 1001tl links. DJ result: name, subscribed badge, set count, profile link.

### Playlists
Connection card (channel, scope, Sign in / Disconnect, reconnect prompt after a token rejection). Combined playlist card (link, count, missing, unavailable, inserts used of cap as a meter, last backfill, Backfill now). Per-DJ playlists table from `api/list` + `api/state/:slug` (title, link, videos, last addition, mkvid videos). Fix titles dialog. Hygiene strip (DRY RUN / LIVE, deletes today, held count, link to Removed videos).

### Removed videos
Holds first (cards with "They really are removed, apply once"), then the removals table with filter chips (all / sweep / owner / replace) and a DJ filter; the same actions (Undo, Keep it, Compare now, Run sweep); "Older" paging.

### mkvid
Status line and both caps (meter) at the top, backlog estimate. Filter bar (text, status, source, account, DJ, Clear; summary says how many match). Tabs: Queue (claim order, position badge, move and ban controls), Finished (Retry / Unban), Old videos (Retry now). Row opens a detail drawer (side panel on desktop, bottom sheet on phone) with the existing detail fields and buttons (Render now, Delete and recreate, Retry, Unban, Open set page). Header: Refresh, Recreate all old-style (expect-count confirm). Keyset paging per tab, 25 rows.

### Activity (phase 2)
Filter chips: kind (request, playlist, hygiene, mkvid, pool, sync, ban), problems only, DJ, range (24h, 7d, 30d, 90d), mirrored in the query string. Row: time, kind icon, status badge, summary, DJ / set link; anomaly highlighting kept. Drawer: full record via the existing detail routes for requests and playlist additions, inline fields for the rest.

`GET /ui/api/activity?kind=a,b&problems=1&dj=&since=&cursor=&limit=50` returns `{ rows: [{ ts, kind, status, problem, title, detail, dj, setUrl, videoId, ref: { kind, key } }], cursor }`. Sources: `now_playing_audit` (request), `playlist_additions` (playlist), `playlist_removals` (hygiene), `mkvid_requests` transitions and `mkvid_claims` (mkvid), `pool_events` (pool), `sub_sync` last run and error (sync), KV `ban:ep:*` (ban). One SELECT per source with the same output columns, ordered and limited per source, merged in the Worker; keyset on `(ts, kind, key)`. No writes.

### Pool accounts, Challenges, Challenge, Pool settings
Same content and behaviour, laid out for width: stat tiles and priority chips across the top, challenges as cards, the accounts table full width (cards under 700px, exit kind and passive as badges), the add-account `<dialog>` unchanged in ids and strings. Challenge page stays narrow and phone-first. Pool settings: the two forms side by side as cards, saved toasts.

### Settings
YouTube account card; Notifications (VAPID configured, Enable on this device, Send test, device list); Theme (system / dark / light); Integrations status (tlpool, mkvid token, Web Push); Ban episodes table.

### Tools
Cards: YouTube video JSON (copy), Purge a tracklist, Simulate a ban, Requeue ban victims (days, dry run), Migration status, (phase 3) Search index (indexed count, Rebuild 500 more).

## 7. Visual tokens

Dark (default): page `#101219`, card `#171a23`, elevated `#1f2330`, border `#2a2f3d`, strong border `#3a4052`, text `#e8e9f0`, muted `#a3a7b8`, subtle `#737889`, accent text `#a597ff`, accent fill `#7b6cf6` (white on it), accent soft `rgba(123,108,246,.16)`, ok `#3fb950` / `#12261a`, warn `#d29922` / `#2a2110`, danger `#f85149` / `#2d1516`, info `#58a6ff` / `#13202e`.

Light: page `#f6f6fa`, card `#ffffff`, elevated `#eeeef5`, border `#e2e3ec`, strong border `#c9cbd9`, text `#171a23`, muted `#4a4e5e`, subtle `#6b6f80`, accent `#5b4bd6` (white on it), accent soft `rgba(91,75,214,.12)`, ok `#1a7f37` / `#e6f4ea`, warn `#9a6700` / `#fbf1d6`, danger `#cf222e` / `#fbe9e9`, info `#0969da` / `#e5f0fb`.

CSS shape: dark values on `:root` with `color-scheme: dark`; light values under `@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) }` and again under `:root[data-theme="light"]`; the toggle sets `data-theme` and stores it in localStorage; a boot script applies it before first paint.

Type: `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`; mono `ui-monospace, "Cascadia Mono", "SFMono-Regular", Menlo, monospace` for ids, cues and URLs; tabular numerals in every column. Scale 0.75 / 0.85 / 0.95 / 1.05 / 1.35 / 1.7rem. Spacing 4 / 8 / 12 / 16 / 24 / 32px. Radii 6px controls, 8px tiles and drawers, 10px cards, 999px pills. Focus ring 2px accent, offset 2px. Depth by lightness steps; shadow only on floating surfaces (drawer, dialog, toast). No gradients.

## 8. Component inventory

| Component | Source | Notes |
| --- | --- | --- |
| App shell (sidebar, top bar, bottom tabs, collapse) | amber shell/nav + new | `shell(page)` wraps every page; owns banner slot and nav active state |
| Page header | amber | title, description, actions |
| Ban/pause banner | existing, restyled | `BAN_JS` unchanged |
| Stat tile with meter | new | label, value, sub, optional meter |
| Card | amber | the only bordered surface |
| Table that turns into cards | new (pool page has a first version) | `data-label` per cell |
| Badge / status pill | amber OutcomeBadge, StatusPill | ok / warn / bad / info / neutral |
| Buttons: primary, secondary, danger, ghost, icon | new | busy state; in-row confirm pattern kept |
| Field, input, select, toggle, number | amber `.amber-field` + new | label above, hint below, error text |
| Filter bar and chips | new | state mirrored into the query string |
| Tabs | new | `role=tablist`, arrow keys |
| Drawer (side panel / bottom sheet) | new | native `<dialog>`, Escape closes |
| Dialog | existing add-account, restyled | native `<dialog>`, never `confirm()` on the pool pages |
| Toast | new | success / error, `aria-live` |
| Empty state, Error state (Retry), Skeleton | amber | |
| Track row | existing, restyled | cue, artwork, artist, title, link pills, lazy links button |
| Set card | existing, restyled | completeness badge, set links |
| Activity row | new | time, kind icon, badge, summary, link |
| Diagnostic row | new | label, badge, finding, expandable facts |
| Search box and result groups | new | debounced, keyboard nav, highlights, corrected-query notice |
| Copy field | amber | |
| Captcha widget (image / live view) | existing, restyled | ids, `data-r` attributes and strings pinned by tests |
| Icons | amber AppIcon paths + about 10 new | `icon(name)` returns an inline SVG string |
| Theme toggle | amber behaviour | system / dark / light |

## 9. Search (phase 3)

Acceptance queries (from the owner): "lily plamer dont" must rank "Rian Wood & Version 34 - Don't Stop [RAVE WORLD]" from Lilly Palmer @ circuitGROUNDS, EDC Las Vegas 2026-05-16 near the top; "Eli Brown Ultra" must rank the Ultra Miami 2026 set first; "mau p neck" must return the track "Mau P - Neck [BLACK BOOK]" with every set it appears on.

Indexing: hook `noteSetFetch(env, input)` in `src/lib/verification.ts`; upsert only when the result says the list just became verified or is verified with an unchanged fingerprint (confirm with `verifiedFingerprint(env, setUrl)`); inside `ctx.waitUntil`, errors swallowed; never from `cacheParsedTracklist` or the `tl:` KV cache. Backfill: an admin button on Tools, 500 sets per press with a keyset cursor, from `mkvid_request_tracks` rows with `trusted=1` and sets whose `set_verification` row is verified with a matching fingerprint; never from KV; never on the cron. The index is not pruned; a set that verifies again is re-indexed.

Tables (migration `0012`, DDL to the pool session before writing; must not collide with `0007_pool_scheduler`):

```
search_sets       (set_url PK, dj_slug, dj_name, title, set_date, video_id, video_source, track_count, ided_count, indexed_at)
search_tracks     (track_key PK, track_id NULL, artist, title, label, youtube_link NULL, sets_count, updated_at)
search_track_sets (track_key, set_url, pos, cue_seconds, layered, PK(track_key, set_url))
search_vocab      (term PK, df)
sets_fts   FTS5(title, dj, slug_words, tokenize='unicode61 remove_diacritics 2')
tracks_fts FTS5(artist, title, label, djs, set_titles, tokenize='unicode61 remove_diacritics 2')   -- djs, set_titles aggregated per track
vocab_fts  FTS5(term, tokenize='trigram')
```

`track_key` is the 1001tracklists track id when present, else a hash of normalized artist + title. Local D1 (workerd SQLite) accepted FTS5 with the trigram tokenizer on 2026-09-30; production D1 documents FTS5.

Query pipeline, one request in the Worker: normalize (lowercase, strip diacritics, drop apostrophes, `&` to `and`, split on non-alphanumerics, synonym map: feat/ft/featuring, rmx/remix, vs/versus, w//with, pt/part); expand each token (exact; `term*` for 3+ chars; when absent from `search_vocab`, up to 5 vocabulary terms within Damerau-Levenshtein 1, or 2 for 7+ letters, found by querying `vocab_fts` with the token's trigrams and ranking by edit distance); recall from FTS5 with groups ANDed, then ORed if fewer than 10 rows, `bm25()` weights title 3, artist 3, label 1, djs 2, set_titles 1, LIMIT 200; re-rank in the Worker (per token best field match: exact 1.0, prefix 0.9, corrected 0.7 minus edit distance; sum with field weights; multiply by matched-token fraction squared; small boosts for a known YouTube link, recency, subscribed DJ); top 20 per kind. DJs are matched in the Worker against the subscription list.

API: `GET /ui/api/search?q=&kind=all|sets|tracks|djs&limit=20` returns `{ q, corrected: [{from,to}], tracks: [{ trackKey, trackId, artist, title, label, youtubeLink, trackUrl, sets: [{ url, title, djSlug, djName, date, cueSeconds }] }], sets: [{ url, title, djSlug, djName, date, videoId, trackCount, idedCount }], djs: [{ slug, name, subscribed, sets }] }`. The existing lazy links route writes a found YouTube link back to `search_tracks.youtube_link`.

Tests: `test/helpers/fake-d1.ts` runs the real migrations through `sql.js`, whose build has no FTS5 (verified 2026-09-30). Swap it for `sql.js-fts5` (drop-in API) in phase 3. Unit tests for normalize and the scorer; route tests that index a fixture and assert the three acceptance queries.

## 10. Code architecture

```
src/ui/
  tokens.ts     CSS string: section 7 tokens, dark first
  base.ts       CSS string: reset, shell, every component in section 8
  icons.ts      icon(name) -> inline SVG string
  shell.ts      shell({ title, nav, headerActions, body, css, js }) -> full HTML document; owns banner + BAN_JS,
                top bar, sidebar, bottom tabs, theme boot, runtime
  runtime.ts    shared inline client JS: esc, api (the one fetch wrapper, method + content-type in one object),
                toast, drawer, dialog helpers, the visibility-aware poller, fmt (times, durations), filters <-> query string
  pages/        one file per page exporting { path, html }: home, djs, dj, set, search, playlists, removed, mkvid,
                activity, pool, captcha-list, captcha, pool-settings, settings, tools
src/routes/subscriptions.ts   lines 949-3182 (PAGE_HTML, TRACKLIST_PAGE_HTML, DJ_PAGE_HTML) removed; the handlers at
                              93, 105, 114 import from src/ui/pages; every API route untouched; SW_JS route stays
src/routes/pool-ui.ts         proxies untouched; page constants (189-1030) replaced by imports; POOL_PAGES and
                              createPoolUiApp exports kept with the same shape
src/routes/ban-ui.ts          keeps BAN_JS, SW_JS, banner markup and UNBLOCK_URL (consumed by shell.ts)
src/routes/playlist-hygiene.ts  REMOVED_PAGE_HTML (94-243) replaced by an import; API routes untouched
src/routes/activity.ts        phase 2: GET api/activity, GET api/set
src/lib/search/               phase 3: normalize.ts, score.ts, index.ts (upsert + backfill), query.ts
migrations/0012_search.sql    phase 3
```

No page constant in the current code uses any API-side helper; the only dynamic interpolation is `${JSON.stringify(id)}` in `captchaPageHtml(id)`, which stays a function. No UI handler reads `c.env`.

## 11. Testing

- Existing tests stay green throughout; pinned ids and strings are kept, not renamed.
- New `test/ui-pages.test.ts`: every HTML route answers 200 with `Cache-Control: no-store`, contains the shell nav, its `<h1>`, a link to `/ui/pool/settings`, the banner markup, and scripts that parse with `new vm.Script`; every new path returns 401 without Access.
- `test/same-origin.test.ts`: page list extended with every new path. Every existing test path moves from `/subscriptions` to `/ui` (section 3a).
- Phase 2: route tests for `api/activity` and `api/set` against fake-d1 fixtures.
- Phase 3: as in section 9.
- `npx vitest run` and `npx tsc --noEmit` clean before every merge.

## 12. Process

- Work on `new-ui` in worktree `tracked-ui`; never edit the main checkout.
- Another session ("tracked-mkvid-continue") ships pool changes to this repo and may touch `src/routes/pool-ui.ts`, `src/routes/ban-ui.ts` and the mkvid panel; it announces edits first. Before any backend code: send it the route list and DDL. Before merging: rebase on `origin/main`, run `npx wrangler d1 migrations list tracked --remote`, and get both the owner's ok and that session's all-clear. A push to main deploys to production.
- Commit trailers per the owner's rules. No secrets, emails or usernames in code, fixtures, docs or commits.
- Phase 1 first. Before its deploy the owner changes the Access application path and the Google OAuth redirect URI (section 3a). Live check of the deployed pages at desktop and phone widths after each merge, including a push notification tap and the OAuth round trip.
