# tracked

[![CI](https://github.com/pmaxhogan/tracked/actions/workflows/ci.yml/badge.svg)](https://github.com/pmaxhogan/tracked/actions/workflows/ci.yml)

Resolve the song that's currently playing in a YouTube DJ set.

> **Personal-use only.** This calls 1001tracklists.com on your behalf. Please respect [their ToS](https://www.1001tracklists.com/info/policies/terms.html) — don't run this at high volume, don't redistribute scraped data, and don't use it as a stand-in for a 1001tracklists subscription. KV caching keeps a personal Tasker setup well under any reasonable rate limit.

A Cloudflare Worker that takes a YouTube video title + playback offset, finds the matching video via the YouTube Data API, finds the matching tracklist on 1001tracklists, scrapes the per-track cue times, and returns the song(s) playing at that moment with deep links to Apple Music (and YouTube as a fallback). The companion is a [Tasker setup](docs/tasker-setup.md) that calls this endpoint from your phone while you're listening.

## API

```
POST /now-playing
Authorization: Bearer <token>
Content-Type: application/json

{
  "videoTitle": "Matroda @ Club Space Miami, United States 2023-08-05",
  "videoDurationSeconds": 5286,
  "currentSeconds": 4595
}
```

`videoDurationSeconds` is optional but recommended — it disambiguates between multiple uploads of the same DJ set.

If the caller already knows the YouTube URL, send it directly to skip the YouTube Data API roundtrip (saves 100 quota units per call):

```jsonc
{
  "videoUrl": "https://www.youtube.com/watch?v=79n8BaQAL2Q",  // or youtu.be/, m.youtube.com, /shorts/, /embed/, or a bare 11-char id
  "currentSeconds": 4595
}
```

**Cache age and forced refresh.** Once a tracklist is resolved, the answer carries `cache: { fetchedAt, ageSeconds, ttlSeconds, refreshed }` — when the parsed list it came from was fetched from 1001tracklists, and how long that entry is kept (see [Tracklist cache](#tracklist-cache-and-purge)). Add `"refresh": true` to the request to fetch that set's list again before the current track is picked (one upstream fetch at priority `phone`; `refreshed: true` in the answer); the fresh list replaces the cached one. If the refetch fails (paused, blocked, challenge, decoy, empty parse, timeout) the cached list is kept and the track is picked from it as usual, with `cache: { stale: true, refreshError, fetchedAt, ageSeconds, … }` describing the kept list; only when nothing was cached is the answer `status: "upstream_error"` (`cache.fetchedAt: null`). Forced refetches are limited (pool settings `forcedRefetch`): a repeat for the same set within 120 s, or beyond 40 a day (UTC) across all sets, is answered from the cache with `refreshed: false` and `cooldownSeconds` or `dailyCapReached`. Meant for a Tasker "force refresh" task when the list looks stale or wrong:

```bash
curl -sS -X POST https://<worker>/now-playing -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json'   -d '{"videoUrl":"79n8BaQAL2Q","currentSeconds":4595,"refresh":true}'
```

`videoTitle` and `videoUrl` are mutually optional but at least one is required (zod-validated). When both are sent, `videoUrl` wins. `videoDurationSeconds` is ignored on the `videoUrl` path (no tie-breaker needed).

Sending `videoTitle` is the robust choice: even if the YouTube Data API can't confidently match the title to a video, the worker still searches 1001tracklists directly by that title, so the tracklist is found as long as 1001tracklists has it.

Sets tracked already knows are answered from its own D1 before either upstream is asked. A title that names a set [mkvid](#sets-without-a-youtube-recording-mkvid) uploaded resolves straight to that upload and its tracklist (those videos are unlisted, so the YouTube Data API's search never returns them and 1001tracklists never has their URL), and a `videoUrl` the sync has already resolved a set to skips the 1001tracklists search. Such requests show `via: "tracked_db"` in the audit trail. `no_video` / `no_tracklist` responses carry a `message` field describing what happened (whether a video was matched, which searches ran).

The response always returns `200` (errors live in `status` so the Tasker side can branch on a single field):

```jsonc
{
  "status": "ok",                    // ok | unidentified | no_video | no_tracklist | upstream_error
  "videoUrl":      "https://www.youtube.com/watch?v=79n8BaQAL2Q",
  "tracklistUrl":  "https://www.1001tracklists.com/tracklist/l3uw499/...",
  "setAppleLink":  null,              // Apple Music album for the WHOLE set, when 1001tl has one
  "tracks": [
    {
      "title": "LEFT TO RIGHT (Aidan Rudd Remix)",
      "artist": "Odd Mob",
      "startTime": "1:16:30",
      "startSeconds": 4590,
      "durationSeconds": 270,         // length the track occupies in the set (next-group start − this-group start; setEnd for the last group when videoDurationSeconds is sent)
      "durationTime": "4:30",         // same, formatted "M:SS" / "H:MM:SS". Empty string when null.
      "isCurrent": true,
      "isUnidentified": false,
      "idStatus": null,               // "ID Remix" / "ID Edit" etc. when the base track is known but the playing variant isn't
      "appleLink": "https://music.apple.com/...",
      "youtubeLink": null,
      "trackUrl": "https://www.1001tracklists.com/track/1x9zgrpp/odd-mob-left-to-right-aidan-rudd-remix/index.html",
      "artworkUrl": "https://geo-media.beatport.com/image_size/300x300/abc-def.jpg",
      "youtubeLiked": null            // true/false = liked on the connected YouTube account; null = not connected / no youtubeLink (as here) / lookup failed
    }
  ]
}
```

The response always carries a small adjacent-context window so the caller doesn't have to scrub the source video to grab a previous song or peek at what's coming up:

- the **previous** group (immediately before current),
- the **current** group (one or more tracks if it's a mashup),
- the **next** group (immediately after current).

`isCurrent: true` only on the current group's members. Edge cases:
- **First track of the tracklist** → no previous; response is `[current, next]`.
- **Last track of the tracklist** → no next; response is `[previous, current]`.
- **Single-track tracklist** → just `[current]`.
- **Playback is before the first cued track** → no current; response is `[firstCuedGroup]` with all `isCurrent: false`, so the client can show "next up at 0:30".

Mashup-linked siblings (1001tracklists `w/`) count as a single group, so a current pair returns both members with `isCurrent: true`, and prev/next can themselves be pairs. Mashup pairs are detected two ways: the parent's row class carries `con` (the "official" 1001tl marker), **or** the next row shares the parent's cue (1001tl encodes that as multiple `cueValuesEntry.ids[N]` on a single entry — common on the newer `trRow` layout where the class marker is absent).

**Trailing uncued tracks** (the long tail of untimed rows that 1001tracklists sometimes leaves at the bottom of sparsely-identified sets) get interpolated start times when `videoDurationSeconds` is sent. The slot used for each trailing group is `min(medianCuedDuration, evenSlot)`, where `evenSlot` evenly splits the remaining video time across `(lastCuedGroup + trailingGroups)`. Capping by the median of observed cued-track gaps keeps a short opener from being projected to play through the rest of the set; capping by `evenSlot` keeps trailing tracks from extending past `videoDurationSeconds`. Interpolation only runs on **trailing** uncued groups — leading/internal uncued rows keep `startSeconds: null` and the existing "before-first-cue" fallback handles intros. Per-track `startSeconds` is still the raw cue (`null` for trailing rows); only the internal range-matching uses the interpolated value.

`trackUrl` is the canonical 1001tracklists track page (good for opening track details / submitting a fix); `null` when there's no meta url on the row.

`setAppleLink` (top-level) is the Apple Music album/playlist URL for the entire DJ set when 1001tracklists has one — parallel to `videoUrl` for the YouTube source. `null` for sets with no Apple Music release.

**Anonymous "ID - ID" rows** (no name at all on 1001tracklists, so not in `/tracklist` or the counts) still bound the track before them when they have a cue of their own: that track's slot ends at the anonymous row's cue, and while it plays the answer is `status: "unidentified"` with a current track `{ artist: "ID", title: "ID", isUnidentified: true }` (no links, `trackUrl`/`artworkUrl` null) — the same shape as any unidentified track. A named "w/" row on top of one is the only thing known to be playing, so it alone is the current track (`status: "ok"`). An anonymous row without a cue changes nothing. The audit record's `select` carries `anonymousRowCount` and `currentFromAnonymousRow`, so these answers read apart from a named "ID" row. (Cache family `tl:v4`, whose entries carry the rows.)

`idStatus` (per-track) is `null` for fully-identified tracks. When 1001tracklists marks a row as a partial-ID variant of a known base track ("ID Remix", "ID Edit", "ID Bootleg", "ID Rework", etc.), `idStatus` carries that label, `isUnidentified` stays `false`, and `appleLink` / `youtubeLink` / `trackUrl` describe the **base track** — the actual playing variant may sound different. `isUnidentified: true` is reserved for fully-anonymous tracks (e.g. `"Cave Studio - ID"`); those skip link resolution entirely.

`artworkUrl` is the album art URL, normalized server-side to a square **300×300** for both supported CDNs (Beatport's `image_size/300x300/…` and SoundCloud's `t300x300`). `null` when only 1001tracklists' placeholder was embedded — clients should render their own no-art indicator. Unknown CDNs are passed through unchanged so something is always surfaced when the page has a non-placeholder image.

`durationSeconds` / `durationTime` is the **length the track occupies in this set** (not the studio length): `nextGroupStart − thisGroupStart` for non-last groups, or `videoDurationSeconds − thisGroupStart` for the last group when the caller sent `videoDurationSeconds`. Mashup-linked siblings share the group's window. `null` (and `""` for `durationTime`) when neither input is known or the cue is missing.

`youtubeLiked` (per-track) is whether the YouTube account connected via `/ui` has liked the `youtubeLink` video — i.e. whether it is in YouTube Music's "Liked songs". Resolved with one `videos.getRating` call per request (1 quota unit per 50 ids; `/tracklist` on a 100-track set makes two), capped at 3 s. `null` when no account is connected, the track has no `youtubeLink`, or the lookup failed (a YouTube outage never fails `/now-playing`). Toggle it with `POST /likes` (below).

When the upstream rate-limits us (1001tracklists per-IP captcha gate), the response is `status: "upstream_error"` with `message: "1001 search: ip_blocked (<ip>)"` (or `1001 scrape: …`) — a block page that slips through the pool is detected and surfaced cleanly rather than silently degrading to `no_tracklist`.

### Dump a whole tracklist

`POST /tracklist` takes a 1001tracklists tracklist URL and returns every track as JSON — the "give me the whole set" counterpart to `/now-playing` (which returns only the track playing at a given offset). Same bearer auth, and it shares the same scrape + cache as `/now-playing`, so a set fetched by one endpoint is warm for the other.

```
POST /tracklist
Authorization: Bearer <token>
Content-Type: application/json

{
  "url": "https://www.1001tracklists.com/tracklist/l3uw499/matroda-club-space-miami-united-states-2023-08-05.html",
  "resolveLinks": true
}
```

The scheme and leading `www.` are optional and any query string / fragment is ignored; the URL must point at `/tracklist/<id>/…` (DJ pages and other hosts are rejected with `400 invalid_url`). `resolveLinks` defaults to `true` — each identified track is enriched with its Apple Music and YouTube deep links (one cached upstream call per track); set it to `false` to skip that and return faster (you still get `trackUrl` and `artworkUrl` straight from the page).

```jsonc
{
  "tracklistUrl": "https://www.1001tracklists.com/tracklist/l3uw499/...html",
  "slug": "l3uw499",
  "setAppleLink": null,          // Apple Music album for the WHOLE set, when 1001tl has one
  "setYoutubeLink": "https://www.youtube.com/watch?v=79n8BaQAL2Q",  // the set's primary recording, when embedded
  "setSoundcloudLink": null,     // SoundCloud widget-player URL for the whole set, when embedded
  "linksResolved": true,         // echoes the request's resolveLinks
  "trackCount": 32,
  "tracks": [
    {
      "index": 0,
      "artist": "Matroda",
      "title": "LEFT TO RIGHT (Aidan Rudd Remix)",
      "startTime": "0:00",
      "startSeconds": 0,
      "trackId": "909720",
      "trackUrl": "https://www.1001tracklists.com/track/.../index.html",
      "artworkUrl": "https://geo-media.beatport.com/image_size/300x300/....jpg",
      "appleLink": "https://music.apple.com/us/album/...?i=...",
      "youtubeLink": "https://www.youtube.com/watch?v=...",
      "isUnidentified": false,
      "idStatus": null,
      "isMashupLinked": false,
      "youtubeLiked": null           // same semantics as /now-playing
    }
  ]
}
```

Per-track field semantics (`startSeconds`, `trackUrl`, `artworkUrl`, `idStatus`, `isUnidentified`, `isMashupLinked`) are identical to `/now-playing` — see the notes above. Unlike `/now-playing`, this endpoint uses **HTTP status codes** rather than a `status` field: `400` for a bad URL, `401` for a missing/invalid bearer token, and `502 upstream_error` when 1001tracklists rate-limits us (per-IP captcha gate) or the page parses to zero tracks (the fingerprint of a transient captcha that slipped past the block detectors — retry shortly).

### Tracklist cache and purge

Every parsed tracklist is cached in KV under `tl:v4:<slug>`, whichever path fetched it: `/now-playing`, `/tracklist`, the viewer, and the sync's new-set and recheck fetches all write the same entry (`lib/tracklist-cache.ts`), so a phone press after a sync fetch costs no request. How long an entry lives:

| List | Kept |
|---|---|
| every row identified, set 2 days old or more | 3 days |
| any "ID" row (anonymous "ID - ID" rows included), or set under 2 days old | 6 hours |

The set's date comes from its URL (or, for sync fetches, the page's date meta / title); a set with no readable date counts as not new. A decoy page or a zero-track parse is never cached. Each entry records `fetchedAt`, `ttlSeconds` and its `tracklistUrl`.

`POST /tracklist/purge` (same bearer as `/now-playing`) fetches one set's list again right away at priority `phone`, bypassing the cache read, and replaces the cached entry with the fresh list. Name the set with exactly one of:

- `url` — a 1001tracklists tracklist URL;
- `slug` — the short id in `/tracklist/<slug>/…`, for a set tracked already knows (cached, synced, or queued for mkvid);
- `videoId` — a YouTube id or URL that maps to a set (synced or mkvid-uploaded, or matched by an earlier `/now-playing`, whether by URL or by title search; that mapping is kept 30 days).

```bash
curl -sS -X POST https://<worker>/tracklist/purge -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json'   -d '{"slug":"l3uw499"}'
# → { "tracklistUrl": "...", "slug": "l3uw499", "rowCount": 31, "trackCount": 31, "identifiedCount": 29,
#     "fetchedAt": "2026-09-29T14:03:11.000Z", "ttlSeconds": 21600 }
```

`rowCount` counts every page row (anonymous "ID - ID" rows included), `trackCount` the named rows `/tracklist` returns, `identifiedCount` the named rows that are not "ID". Errors: `400` for no/more than one/an invalid identifier, `401` bad bearer, `404 unknown_slug` / `unknown_video` when tracked cannot map the identifier to a set (nothing is fetched then), `404 not_found` when 1001tracklists answers 404/410, `502` for a failed fetch (`error: "decoy"` for a decoy page), `503 paused` while fetching is paused. A failed refetch never costs the set its list: the old entry is **kept** (and still served), and the error body says so — `{ error, message, stale: true, fetchedAt: "<kept entry's fetchedAt>" }` (`stale: false, fetchedAt: null` when nothing was cached). A decoy or empty parse never replaces a good entry.

The tracklist viewer has the same thing as a **Refresh track list** button (`POST /ui/api/tracklist/purge`, behind Cloudflare Access), next to the list's cache age.

### Like / unlike a track

`POST /likes` rates a YouTube video `like` or `none` on the account connected via `/ui` — which is exactly what adds a song to / removes it from YouTube Music's "Liked songs". This backs the thumbs-up button in the Tasker scene: tap once to like the track that's playing, tap again to unlike.

```
POST /likes
Authorization: Bearer <token>
Content-Type: application/json

{ "videoUrl": "https://www.youtube.com/watch?v=79n8BaQAL2Q", "liked": true }
```

`videoUrl` accepts every shape `/now-playing` does (watch URL, `youtu.be`, `music.youtube.com`, or a bare 11-character id). `liked: true` → `videos.rate` with `rating=like`; `liked: false` → `rating=none`. Idempotent — re-liking a liked video is a no-op `200`.

```jsonc
{ "videoId": "79n8BaQAL2Q", "liked": true }
```

Errors use HTTP status codes: `400 invalid_url` when no video id parses, `401` for a bad bearer token, `503 youtube_not_connected` when no YouTube account is connected (or Google revoked the refresh token — reconnect from `/ui`), and `502 upstream_error` when YouTube rejects the call (the message carries Google's `reason`, e.g. `videoNotFound`, `quotaExceeded`). `videos.rate` costs 50 quota units per call.

### List every liked song

`GET /liked-songs` dumps the connected account's "Liked videos" playlist (YouTube's `LL`, which is exactly YouTube Music's "Liked songs") as JSON, newest-liked first. It is meant for agents/scripts, so it has its **own bearer token** — `LIKED_SONGS_TOKEN`, a separate secret from the Tasker `API_TOKEN`. Neither token opens the other's routes. Read-only.

```
GET /liked-songs?durations=1&maxPages=20&pageToken=...
Authorization: Bearer <LIKED_SONGS_TOKEN>
```

```jsonc
{
  "playlistId": "LL",
  "count": 1234,
  "nextPageToken": null,          // non-null only when maxPages stopped the walk early — pass back as ?pageToken=
  "quotaUnits": 50,               // YouTube Data API quota this call spent
  "items": [
    {
      "videoId": "79n8BaQAL2Q",
      "duration": "PT4M30S",      // ISO 8601, from videos.list; null with durations=0 or when unavailable
      "durationSeconds": 270,
      "unavailable": false,       // true = deleted/private (videos.list didn't return it, or the title is "Deleted video"/"Private video")
      "item": { /* raw youtube#playlistItem: id, snippet, contentDetails, status — verbatim */ }
    }
  ]
}
```

Quota: `playlistItems.list` costs 1 unit per page of 50 **regardless of which parts you ask for**, so every part is requested. But playlistItems never carries duration — that lives only in `videos.list` — so by default the collected ids are also batched through `videos.list?part=contentDetails` (another 1 unit per 50) and `durationSeconds` is attached to each item. That is what lets a client filter by length (e.g. "under 25 minutes") without any further calls. Pass `durations=0` to skip that second pass. Net: ~2 units per 50 liked songs, so a 2,500-song library is ~100 units of the 10,000/day quota.

`maxPages` (1–200) caps how many playlist pages one call walks; the response's `nextPageToken` resumes from where it stopped. Omit it to get everything in one response. The reason to cap: a full walk with durations on makes `2 × ceil(N/50)` YouTube subrequests (plus a KV read and possibly a token refresh), and Workers allow 50 subrequests per invocation on the free plan (so a library over ~1,200 songs 502s without `maxPages`) or 1,000 on paid (~24,000 songs).

Errors mirror `/likes`: `401` bad/missing `LIKED_SONGS_TOKEN`, `500` when that secret (or the OAuth client) is not configured, `503 youtube_not_connected`, `502 upstream_error` with Google's `reason`.

OpenAPI spec: `GET /openapi.json` (bearer-gated).

## Admin UI (`/ui`)

`GET /ui` is a single-user admin web UI: the list of DJs to track, the pool, playlists, mkvid and the tools around them. Paste a 1001tracklists DJ URL like `https://www.1001tracklists.com/dj/lillypalmer/index.html` on the DJs page and only the slug (`lillypalmer`) is stored. Subscriptions live in the D1 `subscriptions` table (see **Storage**) so they're durable independent of the cache. `GET /` redirects to `/ui/`.

### Pages

| Path | Page |
| --- | --- |
| `/ui` | Home: status tiles, needs-attention list, the last 12 events from the Activity log (links to the full log and to problems only), quick actions |
| `/ui/djs` | DJs: the list (table on desktop, cards on a phone) with the add form in the header |
| `/ui/dj/<slug>` | DJ profile: summary column and expandable set cards |
| `/ui/activity` | Activity: one newest-first log of requests, playlist additions, hygiene, mkvid, pool, sync and IP blocks. Filters (kind, Problems only, DJ, range 24h/7d/30d/90d) live in the URL; Load older pages back through the log; a row opens a drawer (the full detail for requests and additions, the row's own fields for the rest) |
| `/ui/search` | Search: tracks, sets and DJs as you type (150 ms debounce), with All / Tracks / Sets / DJs tabs, typo correction with a "Search exactly" escape, highlighted matches and Up/Down/Enter/Escape keyboard navigation. `q` and `kind` live in the URL |
| `/ui/set?url=` | Set: the tracklist viewer (`?url=` deep link kept) and a diagnostics column (discovery, recording, verification, full-recording rule, playlist, hygiene, mkvid). The diagnostics read only stored data: nothing is fetched from YouTube, tlpool or 1001tracklists |
| `/ui/playlists` | Playlists: YouTube connection, combined playlist, per-DJ playlists, fix titles, hygiene strip |
| `/ui/removed` | Removed videos (the push target for removals) |
| `/ui/mkvid` | mkvid: status line, caps, Queue / Finished / Old videos tabs, detail drawer |
| `/ui/pool` | Pool accounts: stats, challenges, accounts table, add-account dialog |
| `/ui/pool/settings` | Pool settings |
| `/ui/captcha` | Challenges |
| `/ui/captcha/<id>` | One challenge (the push target; phone-first) |
| `/ui/settings` | Settings: YouTube account, notifications and devices, theme, integration status, IP-ban episodes |
| `/ui/tools` | Tools: YouTube video JSON, purge a tracklist, simulate a ban, requeue victims, migration status |

Search lives at `/ui/search` (see [Search](#search)); the search box at the top of the page, the Search tab and the `/` key all open it.

### Search

`/ui/search` searches every verified track list: tracks (artist, title, label, with the sets they were played in), sets and DJs. It reads `GET /ui/api/search?q=&kind=all|sets|tracks|djs&limit=1..20&exact=1`, which normalizes the query (case, diacritics, apostrophes, `ft`/`feat`), corrects likely typos against the index's own vocabulary (the page says "Showing results for ..." and offers "Search exactly for ..." with `exact=1`) and re-ranks in the Worker.

**Results.** "All" is one list: matching DJs first, then tracks and sets interleaved by relevance (each result carries a `score`, its match quality relative to an exact match on every word, so tracks and sets compare). The Tracks, Sets and DJs tabs show one kind. A track appears once: rows with the same 1001tracklists track link are merged, and a row without a link (a backfilled mkvid list carries no track ids) joins the linked row with the same artist and title, pooling their sets.

**Thumbnails.** Every result has a square picture: a track's artwork, a set's page image (`og:image`), a DJ's newest set image (also used for a set whose page had none), else a lettered placeholder. The index keeps the source URL; `GET /ui/img/<key>` (behind Access) serves a copy from R2 (`IMAGES`, bucket `tracked-images`), fetching it from its source CDN (https only, `image/*` but not SVG, at most 2 MB) the first time it is asked for. Nothing is hotlinked from the page, and no image fetch is a 1001tracklists page view. Sets indexed before thumbnails existed pick them up the next time they are indexed (`INDEX_FORMAT_SINCE`; Rebuild redoes the mkvid lists).

**What is indexed, and when.** Only trusted lists: a set is indexed after a fetch that verified against its recording, in the background (`waitUntil`, one batch per set, skipped when it was already indexed since that verification), and lists that mkvid uploaded from a trusted track list are added by the rebuild below. Sets with more than 500 tracks keep their first 500. In results, each track lists its 50 newest sets. Unverified lists are never indexed, so a wrong guess cannot surface in search.

**Rebuild.** The Tools page has a Search index card with the counts (sets, tracks, last indexed) and a "Rebuild 500 more" button: each press works through up to 500 trusted mkvid lists (indexed or skipped as already current), in requests of about 60 sets each (one Worker invocation's D1 query budget), showing the running totals, and remembers where it stopped, so press it until it says done. It is safe to repeat.

**A separate database.** The index lives in its own D1 database, `tracked-search` (binding `SEARCH_DB`, `migrations-search/`), not in the main one: D1 cannot export a database that holds FTS5 virtual tables, and `wrangler d1 export` is how the main database is backed up. Everything in the index can be rebuilt from verified lists, so it is never exported. Without the binding `/ui/api/search` answers 503 `search_unavailable` and the page says the index is not set up. To create the tables on a deploy:

```
npx wrangler d1 migrations apply tracked-search --remote
```

The thumbnails bucket is created once with `npx wrangler r2 bucket create tracked-images`.

Locally, `npx wrangler d1 migrations apply tracked-search --local` does the same for `wrangler dev`.

### The shell

Every page is one server-rendered HTML document with the shell, page CSS and JS inline; the theme script runs before first paint.

- 1100px and wider: a sidebar with grouped navigation (Home; Library: DJs, Search, Playlists, Removed videos; Pipeline: mkvid; Pool: Accounts, Challenges with a live count, Pool settings; Settings; Tools) and a footer with the status pill, the theme toggle and "Signed in via Access". `/` focuses the search box.
- 800px to 1100px: the sidebar collapses to an icon rail with tooltips.
- Under 800px: a top bar (page title, menu) and a bottom tab bar (Home, DJs, Search, mkvid, Pool).
- The shell owns the ban/pause banner on every page.
- The theme control (sidebar footer, and the Settings page on any width) picks System, Light or Dark, and the choice is remembered in the browser.
- Pages paint from memory, then correct themselves (stale-while-revalidate, `TK.api.swr`): Home's tiles, attention items and recent activity, the DJs, Playlists and Removed videos lists, the first Activity page and the DJ profile's set list show the response this browser stored at its last view (at most a day old, kept in `localStorage`) at once, then replace it with the live one. Pool, challenge and ban data is always live. Loading lists show skeleton placeholders until the first answer.

### Where the old sections went

The old single page had these sections: the YouTube strip is on Playlists and Settings; the add form and DJ list are on DJs; Combined playlist is on Playlists; mkvid uploads are on mkvid; YouTube video JSON, simulate ban and requeue victims are on Tools; IP-ban history and push devices are on Settings; Recent requests and Recent playlist additions are on Activity (Home shows the latest 12). The tracklist viewer is `/ui/set`, the pool pages keep their paths under `/ui`.

The admin UI lived under `/subscriptions` until it moved to `/ui`. Until the owner retires the old prefix, `/subscriptions/...` pages answer a `301` to the same path under `/ui` (the old tracklist viewer to `/ui/set`), and the old API, OAuth and service worker paths answer `410 { error: "moved" }` (`src/routes/legacy.ts`). None of those answers carries content, so they need no Access.

The UI is gated by **Cloudflare Access**, not the bearer token used for `/now-playing`. The worker doesn't trust the `Cf-Access-Authenticated-User-Email` header on its own — every `/ui/*` request goes through `cfAccess` middleware that:

1. Reads the `Cf-Access-Jwt-Assertion` header (or `CF_Authorization` cookie).
2. Verifies the RS256 signature against the team's JWKS at `https://<CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` (cached in KV for 1h, refreshed on `kid` mismatch).
3. Validates `iss` matches the team URL, `aud` matches `CF_ACCESS_AUD`, and `exp`/`nbf`/`iat` are in range (60s skew).
4. Checks the `email` claim is in `CF_ACCESS_ALLOWED_EMAILS` (comma-separated).

If any of `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` / `CF_ACCESS_ALLOWED_EMAILS` is unset the middleware **fails closed** (every request 500s) — there's no implicit "open" mode in production. For `wrangler dev` set `DEV_BYPASS_CF_ACCESS=1` in `.dev.vars` to skip verification.

JSON API (also Access-gated):

```
GET  /ui/api/list                      → { subscriptions: [{ slug, sourceUrl, addedAt }] }
POST /ui/api/add    { url: "..." }     → { added: bool, subscription: {...} }
POST /ui/api/remove { slug: "..." }    → { removed: bool }
POST /ui/api/tracklist { url }         → the parsed list, no per-track links (see below)
POST /ui/api/tracklist/links { trackIds: ["909720", …] }   (≤ 25)
                                                  → { links: { "<id>": { appleLink, youtubeLink, soundcloudLink } } }
POST /ui/api/tracklist/purge { url | slug | videoId }      → same as POST /tracklist/purge
POST /ui/api/playlists/fix-titles { dryRun?: true }        → { dryRun, checked, fixes: [{ slug, playlistId, oldTitle, newTitle, status }] }
```

**Fix playlist titles** (button on the Playlists page; `lib/playlist-rename.ts`): since 1001tracklists' July 2026 redesign the DJ page H1 reads "Tracklists By X", and playlists created meanwhile are titled "Tracklists By X (1001tklists)". The DJ page parser strips the prefix now and the next DJ page fetch corrects the stored name, but YouTube titles are set only at creation. The route finds every managed DJ playlist whose title starts with "Tracklists By ", computes the title a fresh creation would get ("X (1001tklists)"), and, only with `dryRun: false`, renames it with `playlists.update`, keeping its description, privacy and language (50 quota units each); the stored artist name is corrected too. The button shows the list first and asks before renaming.

**Per-track links in the viewers are lazy**: loading a set costs one set page; each identified row has a **links** button, and **Load links** fetches them for the whole list (25 per request). Every lookup is a budgeted pool view at priority `recheck`, cached per track id for 30 days.

### Tracklist viewer

`GET /ui/set` is a standalone page (open it from the DJs page or paste a `?url=` link) where you paste a 1001tracklists **tracklist** URL and get a clean per-song list: each row shows the artist – title, cue time, a **YouTube** icon that links straight to the track's video, and an **Apple Music** button, whenever 1001tracklists has those links. It's the browser-facing companion to the bearer-gated `POST /tracklist` API; because the browser only carries the Cloudflare Access cookie (not the bearer token), the page calls its own Access-gated endpoint:

```
GET  /ui/set                     → the viewer page (HTML)
GET  /ui/tracklist               → 301 to /ui/set (keeps ?url=)
POST /ui/api/tracklist { url: "..." }  → { tracklistUrl, slug, setAppleLink, trackCount, tracks: [...], fetchedAt, cacheAgeSeconds }
POST /ui/api/tracklist/purge { url }   → purge + refetch, same answer as POST /tracklist/purge
```

Both `POST /tracklist` and `POST /ui/api/tracklist` resolve through the same shared scrape + cache (`lib/tracklist-resolve.ts`), so a set opened in the viewer is warm for the API and vice-versa. The page accepts `?url=` to deep-link a specific tracklist (it prefills and auto-loads).

### DJ profile pages

Every DJ in the subscriptions list links to `GET /ui/dj/<slug>` — a profile page showing **all of that DJ's tracklists as expandable cards**, newest first. Collapsed cards show the set title and date (derived from the tracklist URL slug — free); expanding a card fetches the full tracklist through the same Access-gated `/api/tracklist` endpoint and shows:

- a **completeness badge** — `full tracklist` when every row resolves to a known track, `partial` otherwise (rows with an `idStatus` like "ID Remix" still count as known; only fully-anonymous `ID` rows count against completeness), plus `IDed / cued / partial-ID` counts,
- **set-level links**: the 1001tracklists page, the set's primary **YouTube** recording, its **SoundCloud** player, and the **Apple Music** album, whenever 1001tracklists embeds them,
- the **per-track list** with artwork, cue times, and per-track YouTube / SoundCloud / Apple Music links (same rendering as the tracklist viewer), and an "Open in viewer" deep link.

Once loaded, the badge stays on the card head, so collapsed cards keep showing which sets are fully IDed. Per-set detail is fetched only on expand — never in bulk — so viewing a profile costs at most one index crawl, and re-expanding a set another page already resolved is a warm cache hit.

The set list comes from `GET /ui/api/dj/<slug>` (`?refresh=1` to force), which walks the DJ's 1001tracklists index with the same infinite-scroll crawl the sync uses (`lib/dj-sets.ts` → `crawlDjIndex`), merges in any URLs the sync state discovered that the index no longer surfaces, and caches the result in KV (`djsets:v2:<slug>`): fresh for 6 h, then served stale for up to 30 days while a background crawl (`waitUntil`, one per DJ a minute) replaces it. A DJ with no cached list but a sync state gets that state's URL list at once ("from sync state · refreshing from 1001tracklists") and the crawl runs in the background; only a DJ with neither waits for the crawl. If the crawl is blocked upstream, the page degrades to the sync state's URL list rather than erroring; an empty result is never cached, so the next view retries.

### YouTube video JSON

`/ui/tools` has a **YouTube video JSON** section: paste any video URL (`watch?v=`, `youtu.be/`, `/shorts/`, `/embed/`, `/live/`, a bare 11-character id — anything `extractVideoId` accepts) and it pretty-prints the raw YouTube Data API payload for that video. Purely a lookup — it doesn't scrape a tracklist, touch a playlist, or write anything.

```
GET /ui/api/youtube/video?url=...   → { videoId, watchUrl, video: { ...videos.list item } }
```

The `video` field is Google's `videos.list` item verbatim, asking for every part a read-only key can fetch (`snippet`, `contentDetails`, `statistics`, `status`, `liveStreamingDetails`, `localizations`, `player`, `recordingDetails`, `topicDetails`). Uses `YOUTUBE_API_KEY` (1 quota unit per call), not the OAuth token, and isn't cached. `404` means the id resolved to no item (deleted, private, or never existed); `502` passes through an upstream failure (invalid key, quota exhausted) with Google's own error body so it's visible in the panel.

### YouTube account connection

The Settings page (YouTube account) and the Playlists page have a "Sign in with YouTube" button that runs an OAuth 2.0 authorization-code flow against Google so the worker can create and modify playlists on the connected channel. The flow is implemented in `src/lib/google-oauth.ts` and wired up in `src/routes/subscriptions.ts`:

```
GET  /ui/oauth/start                   → 302 to Google consent (state cookie set)
GET  /ui/oauth/callback?code&state     → exchanges code, stores tokens, 302 back
POST /ui/oauth/disconnect              → revokes refresh token + clears KV
GET  /ui/api/youtube/status            → { connected, channelId, channelTitle, scope, ... }
```

Scope: `https://www.googleapis.com/auth/youtube` (read+write on the user's playlists/uploads). `access_type=offline` + `prompt=consent` ensures Google always issues a refresh token. The refresh token, current access token, expiry, and channel info are stored at `oauth:google` in the `SUBS` KV namespace; access tokens are auto-refreshed via `getAccessToken(env)` when they're within 60s of expiry. Disconnect calls Google's revoke endpoint and clears the KV entry.

CSRF protection: the `/oauth/start` handler sets a single-use `yt_oauth_state` cookie (HttpOnly, Secure, SameSite=Lax, scoped to `/ui/oauth`, 5-minute lifetime); the callback rejects mismatched/missing state.

**One-time setup** (Google Cloud Console):

1. Create or pick a project, enable the **YouTube Data API v3**.
2. *APIs & Services → OAuth consent screen* — set up an "External" app, add yourself as a test user.
3. *Credentials → Create Credentials → OAuth client ID* — type **Web application**. Authorized redirect URI:
   ```
   https://<your-worker-host>/ui/oauth/callback
   ```
4. Copy the client id and client secret into worker secrets:
   ```bash
   echo $GOOGLE_OAUTH_CLIENT_ID     | npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID
   echo $GOOGLE_OAUTH_CLIENT_SECRET | npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
   ```

### Auto-playlists

With a YouTube account connected, the sync (`lib/sync.ts`) keeps playlists on that channel filled automatically. For each subscribed DJ it crawls their 1001tracklists index (JS infinite-scroll, driven through the same `/ajax/get_data.php` endpoint the browser uses), opens each set page, extracts the embedded YouTube video id, and inserts it into a public playlist named **`<artist> (1001tklists)`**.

On top of those, one **combined playlist** — **`All tracked artists (1001tklists)`** — holds every video from every tracked artist, so there's a single thing to hit shuffle on. Two paths fill it (`lib/combined-playlist.ts`):

- **Live mirror.** Whenever the sync resolves a set to a video, it inserts that video into the combined playlist in the same pass. This also runs for sets that are already in the artist playlist but not yet in the combined one, so an in-flight backlog closes from both ends.
- **Backfill.** The combined playlist is defined as *the union of every artist playlist*, so each cron tick diffs it against those playlists and inserts whatever is missing. This is the only path that can cover sets the sync processed **before this feature existed** and the deep back catalogue a **newly added artist** accumulates over many ticks. It also self-heals anything the live mirror dropped — which is why a failed mirror is recorded on the audit row but never fails a sync. The backfill only ever *adds*; removals come from the recheck below.

Both playlists are created on demand (looked up by exact title first, so an existing playlist is adopted rather than duplicated) and their ids are kept in D1 (`sub_sync.playlist_id`) for artists and in KV (`subs:combined`) for the combined one. Deleting a playlist on YouTube is recovered from automatically: the next run re-resolves by title and re-creates if needed. Removing a subscription leaves both playlists in place. The sync never removes a video except to replace it (next paragraph), so anything you prune from a playlist by hand stays pruned.

**Rechecks (swapped recordings).** The first video attached to a set on 1001tracklists is often a phone recording, replaced by an official upload days later — so a set is not "done" once processed. Every processed tracklist records what it resolved to (its `tracklists` row: `video_id` + `checked_at`, surfaced to the sync as `tracklistVideos[url] = { videoId, checkedAt }`), and once the set is due — **by its age** (12 h for a set under 2 days old up to 30 days for one under 180, older ones only while they lack a good video or have ID rows; see **The scheduler** under [How 1001tracklists is fetched](#how-1001tracklists-is-fetched)) — the set page is fetched again and compared:

- **same video**, or the page **lost** its video → nothing changes (a set that drops its recording keeps the one already in the playlist), and no audit row is written — at thousands of rechecks those would drown the rows that matter.
- the set **had none and now has one** → added, exactly like a first-time set.
- a **different video** → new is taken to be strictly better: the old one is removed from the artist playlist *and* the combined playlist (unless another tracked set — say the other half of a b2b — still resolves to it) and the new one inserted into both. Recorded as a `replaced` audit row carrying `previousVideoId`. Removals happen before the insert, and the record is only rewritten at the end, so a run that dies half-way simply redoes the swap next time with every step a no-op once done.
- **no recorded baseline** → the recheck only records what the page has now and adds nothing. This is the state of sets processed before rechecks existed: on the first run after that upgrade, the sync seeds baselines from the 90-day playlist-addition audit trail (`pladd:` rows carry set URL + video id), so a swap on any set processed in the last three months is still caught; older sets get their baseline on the first recheck and are compared from then on. Nothing is ever re-added from an unknown baseline, because "never added" and "removed by hand" are indistinguishable and the second must stick.

The scheduler hands rechecks to the sync one set at a time, after new sets and verification fetches (decision 12); a manual run still does its new-set window first, then at most 20 due rechecks per DJ. A recheck that keeps failing (3×) is deferred to the next interval rather than abandoned — the video it already has stays put. `playlistItems.delete` costs the same 50 units as an insert; a swap is rare enough that this isn't budgeted, but every removal shows up in the audit row's message.

**Invalidate video cache & resync.** Each DJ row on the DJs page has an **Invalidate & resync** button, and the list header has one for every DJ. It marks every processed set due *now* (keeping its recorded video, so swaps are detected and old videos removed), gives abandoned sets another chance, drops the cached membership of both the artist playlist and the combined playlist (`yt:plvids:<id>`) so they're re-read from YouTube, and runs one sync. One run rechecks at most 20 sets and stops when the manual fetch budget (`manualMaxFetches`, default 10) is spent; the scheduler works through the rest by age and priority — the panel message says how many are still pending. The list-header button is `POST /ui/api/resync` — one server-side pass over every DJ on a single shared budget. Until 2026-09-14 it looped the per-DJ endpoint from the browser, and neither the loop nor the per-DJ endpoints carried a budget, so a "resync all" fetched every set of every DJ flat out; that is what tripped the 1001tracklists rate limit on both ban days.

```
POST /ui/api/resync/<slug>   → same body as /api/sync/<slug>, plus
                                          invalidated: { tracklistsMarked, abandonedCleared }
                                          stats gains tracklistsRechecked, videosReplaced, rechecksPending
```

**Pacing.** `playlistItems.insert` costs 50 units against a 10 000/day project quota — 200 inserts/day for the whole worker. The combined **backfill** therefore takes a bounded slice: ≤ 20 inserts per run, a 10 s wall-clock ceiling, and it stops once the day's combined-playlist inserts hit `COMBINED_DAILY_INSERT_CAP` (80, counted at `yt:combined:inserts:<date>` in `CACHE`). The **live mirror** isn't capped — new sets are few and getting them in immediately is the point — but its inserts count against the same daily total, so the backfill yields to them rather than competing. A first backfill of several hundred videos spreads over a few days of cron ticks instead of burning a day's quota in one sweep and starving the per-artist sync. Reads are the cheap half and are cached (`yt:plvids:<playlistId>`, 6 h, rewritten after every insert), so a no-op tick costs ~nothing.

**Failure accounting.** YouTube charges the full 50 units for a *failed* `playlistItems.insert` too, so the caps count **attempts**, not successes — a run of failures consumes budget exactly like a run of inserts (this once mattered: two uninsertable videos retried by the 5-minute cron burned the entire 10 000/day quota, every day). Three rules keep failures bounded:

- A **permanent** insert error (404 `videoNotFound`, 400, non-quota 403 — typically a video deleted or privated *after* the sync added it to an artist playlist, which `playlistItems.list` still returns) marks the video **unavailable** in the combined state (`subs:combined` → `unavailableVideoIds`). It's excluded from "missing" from then on — never retried, by the backfill or the live mirror. The panel shows the skip count; deleting the stale entry from the artist playlist on YouTube is the manual cleanup if you want the count back to zero.
- A **quota** error (`quotaExceeded` etc.) stops the run immediately (`cappedBy: "quota"`) — nothing else will succeed today, and each further attempt would be noise.
- A **transient** error (5xx, network) stays pending and is retried next tick, but the attempt still counted against the daily budget, so even an unclassified repeat-failure can't loop unmetered.

The **Combined playlist** card on the Playlists page shows the link, video count, how many are still to add, today's remaining insert budget, how many unavailable videos are being skipped, and a **Backfill now** button that runs one bounded pass immediately (same caps — clicking it repeatedly can't blow the quota). Per-set rows in **Recent playlist additions** carry a `combined` field: `added` / `duplicate` / `failed` / `unavailable`.

```
GET  /ui/api/combined            → { connected, title, playlistId, playlistUrl, videoCount,
                                                missingTotal, unavailableTotal, dailyInsertsUsed,
                                                dailyInsertCap, lastBackfillAt, lastBackfillStats,
                                                sources: [...] }
POST /ui/api/combined/backfill   → { ok: true, inserted, pending, cappedBy, ... }
                                              | { ok: false, reason: "no_sources" }
```

Both crons (`0 6 * * *` and `*/5 * * * *`) end with a backfill pass, in their own try/catch so a per-artist sync failure can't stop the combined playlist from catching up on everything that did land.

### Playlist hygiene (`src/lib/playlist-hygiene.ts`)

**Full-recording rule.** A page's YouTube video is not added when the page shows 1001tracklists' "no (full) recording" notice, the video is over 5 min shorter than the last cue, or an audio player on the page declares a duration over 10 min longer than the video (this is the player's declared duration, which on every saved page equals the set's own `itemprop="duration"`; it is not measured from the audio file). A fourth rule, vertical video, reads `videos.list` embed sizes and is **off** unless `REJECT_VERTICAL=1` (not yet verified live).

**Sweep** (every 6 h; `PLAYLIST_SWEEP_DRY_RUN` defaults to report-only, `PLAYLIST_SWEEP_DAILY_REMOVALS` caps deletes per UTC day, counted as each delete happens). A rejected video leaves a DJ's playlist only when every set of that DJ that links it is rejected; if any accepted set of the DJ still uses it, it stays (and the rejected set alone loses it). It leaves the combined playlist only when no accepted set anywhere uses it. The sweep never blocklists a video.

**Owner-removal comparison** (every 6 h). A video counts as expected in an artist playlist only with evidence tracked put it there: a confirmed insert or a sighting in an earlier complete listing (`playlist_confirmed`, migration `0011`), or, for removals made before this existed, an `added`/`replaced` audit row that tracked never took back out (sync swaps, sweeps, remove-and-replace and recreations are recorded as `out`). A video the sync never managed to insert is never read as removed. A listing that is paginated past the cap, fails, or has an item without a video id is ignored. A playlist is **held** (nothing recorded, the owner is pushed) when more than 30% or more than 5 of its expected videos look gone; more than 15 across the whole run holds every affected playlist with one push. **Approve** on `/ui/removed` applies exactly the ids that hold showed, within 24 h. **Undo** re-adds first and only then lifts the block, restores every set of the DJ that lost the video, and supersedes an mkvid request queued since; a double click re-adds once. **Remove and replace** is refused for an mkvid render (use Delete and recreate).

### Sets without a YouTube recording: mkvid

Plenty of sets on 1001tracklists have no YouTube recording but do have the full set on **SoundCloud** or **hearthis.at**. Those go to [mkvid](https://github.com/pmaxhogan/mkvid) — the render/upload service on the NAS — which downloads the audio with yt-dlp, renders the static-waveform video and uploads it **unlisted** to the same channel; the Worker then adds that video to the artist playlist and the combined playlist exactly as if 1001tracklists had embedded it.

The Worker can't reach the NAS (mkvid sits behind Cloudflare Access on a cloudflared tunnel), so the integration is **pull**: the sync queues work in D1 and mkvid polls for it.

1. **Queue.** When the sync resolves a set page and finds no YouTube id — first-time processing or a 5-day recheck of a set that still has none — it looks for the set's own audio player: the SoundCloud widget (`api.soundcloud.com/tracks/<id>`, handed to yt-dlp as-is) or a hearthis.at player/link (the embed URL; mkvid resolves it to the track page yt-dlp accepts). If there is one, a row goes into `mkvid_requests` (one per set, ever) carrying the page title (the video title), the source, and the tracklist's **last cue** — the `no_youtube` audit row says `queued for mkvid (soundcloud)`. Only while `MKVID_TOKEN` is set; a page that parses to zero tracks (a captcha shell) is never queued. A set with ID rows is queued like any other; the claim decides when it may render (below). `track_count` counts every page row, anonymous "ID - ID" rows included, and `ided_count` the identified ones (before migration `0009` the anonymous rows were in neither count; the migration backfills both from the stored list).
   **Verified lists only; IDs wait 7 days** (`lib/mkvid-readiness.ts`). A request is claimable only when its stored track list is **verified** — two fetches by different pool accounts agreed on every row (the fetch layer's `isVerified(setUrl)`, which also makes the stored `trusted` flag mean exactly that). An unverified set stays `pending`, keeps its place, and the claim passes over it without using an attempt; nothing is ever rendered from an unverified list, with or without names. A verified list that still has ID rows (`mkvid_request_tracks.id_rows`) is held until the set is **7 days old** — by its set date, else the day the sync discovered it — and then renders with "ID" shown. **Render now** in the request's details (`POST /ui/api/mkvid/render-now/<id>`) sets `skip_id_wait` and skips that wait (never the verification). Each waiting row on the panel says why it waits: *not verified*, *waiting for IDs until <date>*, *capped* (today's uploads are used) or *ready*. This replaces the old `MKVID_REQUIRE_FULL_TRACKLIST` setting, which is gone.
2. **Claim.** mkvid polls `POST /mkvid/claim` (bearer `MKVID_TOKEN`) whenever its render slot is free and gets the next claimable request, or `null`. **Newest set first**: the queue is ordered by the set's date (`set_date`, from the `-YYYY-MM-DD.html` URL slug, else the page's `datePublished` / title), undated sets last, ties by most recently queued — so a DJ's latest show is uploaded before their 2014 back catalogue. The panel's mkvid section lists the waiting line in this order, and each row has **⤒ ↑ ↓ ⤓** to reorder it (`POST /ui/api/mkvid/move/<id>` `{ "to": "top" | "up" | "down" | "bottom" }` — the order is a `sort_key` that defaults to the set date as a Julian day, so a moved row keeps its place while newly queued sets still slot in by date; `top` also outranks anything dated up to today) and **✕** to ban the set (`POST /ui/api/mkvid/ban/<id>`: status `banned`, the row stays so the sync cannot queue it again; **Unban** in its details puts it back). A request whose set has meanwhile gained a real recording is marked `superseded` and skipped. A claim nobody reports on within `MKVID_CLAIM_TTL_SECONDS` (default 3 h — mkvid died mid-job) is handed out again; three claims and it is `failed`. **Two Google Cloud projects, two daily caps.** Since September 2026 YouTube meters uploads apart from everything else: each project gets **100 `videos.insert` calls a day** in their own bucket (reset at midnight Pacific), and an upload no longer spends any of the 10 000-unit general pool. mkvid has two OAuth clients for the same channel — `primary` in its own project **mkvid-uploads**, where nothing else spends, and `shared` in the sync's project **tracked-youtube**. What an mkvid video still costs is the two playlist inserts `/mkvid/complete` makes (artist + combined, 50 units each), and those always land on tracked-youtube's general pool, because the Worker makes them with its own token whichever account uploaded. The claim body says which accounts mkvid can currently upload with (`{ "accounts": ["primary", "shared"] }`; a body-less claim means primary only), the Worker fills the primary account first (`MKVID_DAILY_CLAIM_CAP`, default **24**) and then spills to the shared one (`MKVID_SHARED_DAILY_CLAIM_CAP`, default **6**) — **30 a day in total**, and the queue keeps moving on 6 a day if the primary client is disconnected. Budget on tracked-youtube: 30 × ~100 = ~3 000 units, on top of the sync's own ~150–650 (8 days measured before the raise: 1 053–1 559 units/day including ~900 for the 9 videos then allowed), so ~3 200–3 700 of 10 000; even the combined backfill's own ceiling (80 inserts = 4 000) on top stays under 8 000. The request handed back names its `account`. Counts come from an append-only claims log (`mkvid_claims`, migration `0010`): every claim adds a row for its account, a recreation's claim included, and nothing that resets a request (Delete and recreate, Retry) takes one away, so a deploy cannot reset them and a recreation can never give a slot back; a claim mkvid hands back through `/mkvid/fail` (nothing was uploaded) stops counting. The claim body also names the style mkvid renders with (`{ "accounts": [...], "style": "scene" }`): a **recreation is only handed to an mkvid that says `scene`**; otherwise it waits, pending, without using an attempt or a slot. `GET /mkvid/health` answers `verifiedLists: true` (only verified lists are handed out, `unverified_tracklist` is retryable) and `recreateStyle`; mkvid's scene style claims nothing until it sees `verifiedLists`. **Both caps are Worker secrets in production** (`wrangler secret list`), and a set secret overrides the code default — change them (or delete them to fall back to the defaults) when the defaults change. A cap of `0` **pauses** that account (every claim is refused) — it has to be a literal `0`; a blank value means the default. The panel shows both accounts' usage and says so in red when everything is paused.
   **Track list.** The claimed request also carries the set's track list for mkvid to draw per-track titles and artwork: `tracks: [{ cueSeconds, artist, title, artworkUrl, isId, layered }]` (page order, at most 300 rows, ~20 KB for a 150-track set) and `tracksTrusted`. **`layered: true`** marks a 1001tracklists "w/" row — a track played *on top of* the row before it (mashup, acapella over an instrumental, two tracks together) rather than replacing it; on the page it has the row class `con`, repeats its base's number and shows "w/" instead. Its base is the nearest earlier row with `layered: false`. A layered row's `cueSeconds` is only a cue printed on that row itself — usually there is none and it is `null` (mkvid starts it with its base); 1001tl files the base's cue for it, which is not sent. The first row is never layered. **Anonymous "ID - ID" rows are in the list too**, in page order (`isId: true`, `artist`/`title`/`artworkUrl` null, their own cue), so the video shows "ID" while one plays instead of holding the previous track; a "w/" row on one is layered on it. They carry no microdata, so the parser returns them only in `ScrapedTracklist.rows` (flagged `anonymous`); `tracks` — which the decoy counts, the playlist sync and `/tracklist` use — still leaves them out, as before (`trackCount` / `idedCount` count them since `0009`) (`/now-playing` adds the cued ones only to end the previous track's slot; see its notes). Layered rows count in `trackCount` / `idedCount` like any other row. Since only verified lists are claimed, a claim always carries `tracksTrusted: true` and a non-empty list; mkvid refuses anything else for the scene style (`POST /mkvid/fail { error: "unverified_tracklist: …" }`), which puts the request back to `pending` for an hour without using an attempt. **On an untrusted list `isId` cannot be believed**: a decoy page shows a random 15–35% of identified rows as "ID - ID", so `isId: true` there may be a known track; `cueSeconds`, `artworkUrl` and `layered` are still real. The sync stores it in D1 (`mkvid_request_tracks`, migration `0006`, one row per request, kept out of `mkvid_requests` so the panel's listings stay lean) when it queues a set, and again on every 5-day recheck of a set that still has no recording — which is also how requests queued before this existed get a list. **`tracksTrusted` is true only when the page passed the decoy check with evidence**: at least 3 rows had both a microdata name and visible text, and not one of them disagreed (`mkvidTracksTrusted` — stricter than `looksLikeDecoy`, which needs a majority to refuse a page). An untrusted list is stored and sent with `artist`/`title` **null on every row** — cues, artwork and `isId` are kept, because a decoy page randomizes names only. A trusted list is never replaced by an untrusted one; an untrusted one is upgraded as soon as a clean page turns up. No stored list → `tracks: []`, `tracksTrusted: false`. Nothing older is trusted by date: before this, the Worker kept no per-track data for the queue at all (only `track_count` / `ided_count` / `last_cue_seconds`), and the only other copy — the `tl:v4:` KV cache (3 days / 6 hours) — is not consulted. Blind spots: a decoy that keeps each row's microdata and visible text consistent would pass the check; a page with fewer than 3 comparable rows is never trusted; `isId` on an untrusted list comes from randomized names. Schema: `MkvidClaimResponse` in `/openapi.json`.
3. **"Complete recording".** Before rendering, mkvid probes the source's duration and refuses one shorter than the tracklist's last cue (`incomplete_recording`, permanent) — a SoundCloud upload that ends before the last track started is a clip, not the set.
4. **Deliver.** `POST /mkvid/complete { id, videoId, privacy, style }` (`style` = the visual style mkvid rendered with: `static` / `waves` / `scene`; stored in `mkvid_requests.style`, absent = unknown = old style) inserts the video into the artist playlist (created if the DJ was never synced) and the combined playlist, records it on the set's `tracklists` row with `video_source = 'mkvid'`, writes an `added` audit row (`via: mkvid`) and marks the request `done`. If the set gained a real recording while mkvid was rendering, nothing is inserted and the request is `superseded` (the upload stays on the channel; the panel shows it). `POST /mkvid/fail { id, error, permanent? }` parks a permanent failure or requeues with a 6 h × attempts backoff. A failure that would park the request for a reason this Worker does not recognise as final (anything but an incomplete recording or a source-gone answer, e.g. a reason a newer mkvid added) goes back to pending with a backoff and no attempt used, the first 3 times (`mkvid_requests.unknown_failures`).
5. **Rechecks keep working.** An mkvid video is kept while the page still has no recording (never removed on absence) and is swapped out — removed from both playlists, replaced — the day 1001tracklists attaches a real YouTube video, like any phone recording replaced by an official upload. The recheck also refreshes the stored track list of a set whose video is an mkvid upload, so a recreation renders from the newest list.
6. **Delete and recreate** (`lib/mkvid-recreate.ts`). **Delete and recreate** in a done request's details (`POST /ui/api/mkvid/recreate/<id>`) puts the set back in the queue **behind everything waiting**, remembering the video it replaces (`replaces_video_id`); it is an ordinary request from there — it needs a verified list, waits for IDs, and its claim counts against the daily cap. The old video stays on YouTube and in both playlists until the new one is delivered; then `/mkvid/complete` adds the new video to both playlists first, removes the old one from both, writes a `replaced` audit row (`trigger: mkvid.recreate`, `previousVideoId`), and asks mkvid to delete the old video from YouTube (`POST <MKVID_URL>/api/videos/<id>/delete { requestId }`, bearer `MKVID_TOKEN`; mkvid only deletes a video its own database recorded as uploaded for that request, through the account that uploaded it). The old video id is written to `mkvid_old_videos` the moment Recreate is pressed (state `awaiting_replacement`, not on the panel's to-delete list), so no path can lose it: it becomes due for deletion when the new video is delivered, or when the set is superseded by an official recording meanwhile (at the claim, at completion, or by the sync), in which case it is also taken out of both playlists; the new upload of a superseded recreation stays on record in `video_id`. When the new video did not make it into the combined playlist, the delete waits 6 h (the combined backfill adds it first), and an old video missing from the cached artist listing is looked for in a fresh listing before it is recorded. A delete that fails is kept in `mkvid_old_videos`, retried by the cron (10 min doubling to 6 h, never given up) and listed on the panel with its error and a **Retry now**; mkvid refusing one (not its upload) is final and shown. **Recreate all old-style videos** in the panel header queues every done request whose video was not made with `scene` (unknown counts as old), after a confirm that shows the count (`GET`/`POST /ui/api/mkvid/recreate-old-style { expect: <count> }`; a count that changed meanwhile is refused with the fresh one). `MKVID_URL` is mkvid's base URL; mkvid sits behind Cloudflare Access, so either set `MKVID_ACCESS_CLIENT_ID` / `MKVID_ACCESS_CLIENT_SECRET` (an Access service token the Worker sends) or give `/api/videos/*` a bypass policy — the route checks the bearer itself.

The mkvid page opens with one status line that answers "why is nothing uploading?" — paused (cap 0), mkvid not polling (the Worker records each `/mkvid/claim` poll's outcome in KV, rewritten at most every 10 min), today's cap used (with the time until the midnight-Pacific reset), rendering, or ready — then the backlog estimate, what is rendering, the waiting line in claim order, and what finished. It lists every request (status, source, video, attempts, error, the privacy YouTube actually applied — an unverified OAuth app forces `private` even when `unlisted` was requested) with a **Retry** for failed ones.

Both lists are **filterable and paged**. The filter bar narrows them by free text (a substring of the set title, the DJ or the set URL), status, source and DJ; the summary line then says how many requests match, and **Clear** drops the filter. Each list loads 25 rows at a time with a **Load more** under it, and a waiting-line row keeps the number of its place in the *whole* queue — neither a filter nor a page boundary renumbers it, so ⤒ ↑ ↓ ⤓ still move it where the badge says. Paging is by keyset cursor rather than an offset, so a claim, a retry or a reorder between two pages can never make a row skip a page or turn up on both.

Endpoints (CF Access): `GET /ui/api/mkvid`, `POST /ui/api/mkvid/retry/<id>`. The list endpoint takes `?limit=` (default 50, max 200), `status=` (comma-separated: `pending,claimed,done,failed,superseded,banned`), `source=soundcloud|hearthis`, `account=primary|shared`, `dj=<slug>`, `q=<substring>` — an unknown value is a `400`, not an empty list — and pages with the `queueCursor` / `settledCursor` each response hands back. `section=queue|settled` asks for one list's next page alone; the response carries `queueTotal` / `settledTotal` (rows matching the filter, not just the page) and `djs` (every DJ the queue has held, for the filter's options), while `counts` stays the queue's global tally. mkvid-side: `GET /mkvid/health` (counts, verifies the token), `POST /mkvid/job` (attach its job id).

Setup: `openssl rand -hex 24 | npx wrangler secret put MKVID_TOKEN`, and give mkvid the same value as `TRACKED_TOKEN` with `TRACKED_URL=https://tracked.pmaxhogan.workers.dev` (see mkvid's README).

## Logs

Worker observability is on (`observability.enabled: true` in `wrangler.jsonc`). Every request emits a stream of structured JSON log lines correlated by `reqId` (the Cloudflare `cf-ray` header). Each phase logs full input/output bodies and timing; every error path logs full error context (name, message, stack, upstream status/error code).

`req.start` includes the Cloudflare `colo` and `country` from the request properties for regional triage. `req.end` includes a `counters` object summarising the request's footprint:

```jsonc
"counters": {
  "cacheHits": 5,
  "cacheMisses": 0,
  "youtubeApiCalls": 0,    // 100 quota units each (search.list + videos.list)
  "poolCalls": 0,          // requests sent to tlpool (every 1001tracklists page, search and medialink); each is a budgeted account page view
  "itunesCalls": 0         // free
}
```

A fully-cached request typically lands at ~20ms with all-zero upstream counters; a cold request is ~600ms and shows exactly which upstreams it had to call.

```bash
# live, all events
npx wrangler tail tracked --format json

# live, errors only
npx wrangler tail tracked --format json --status error

# stream to a file for later analysis
npx wrangler tail tracked --format json > logs/all.jsonl
```

For historical (past few days), use the Cloudflare dashboard → Workers & Pages → `tracked` → Observability tab → Query Builder.

## Local dev

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill in API_TOKEN and YOUTUBE_API_KEY
npm run dev                       # wrangler dev on :8787
```

Smoke test:

```bash
curl -X POST http://localhost:8787/now-playing \
  -H 'Authorization: Bearer dev-token-change-me' \
  -H 'Content-Type: application/json' \
  -d '{"videoTitle":"Matroda @ Club Space Miami, United States 2023-08-05","videoDurationSeconds":5286,"currentSeconds":4590}'
```

Tests:

```bash
npm test           # vitest, ~100 assertions across timestamp + scraper + IP-block detection
npm run typecheck
```

To exercise the full flow from the phone, expose dev over a tunnel:

```bash
npm run tunnel     # cloudflared tunnel --url http://localhost:8787
```

Point Tasker at the resulting `https://*.trycloudflare.com` URL.

## Deploy

```bash
# 1. Create the KV namespaces and paste all four ids into wrangler.jsonc
npx wrangler kv namespace create CACHE
npx wrangler kv namespace create CACHE --preview
npx wrangler kv namespace create SUBS
npx wrangler kv namespace create SUBS --preview

# 1b. Create the D1 database, paste its id into wrangler.jsonc, apply the schema
npx wrangler d1 create tracked
npm run d1:migrate            # wrangler d1 migrations apply tracked --remote

# 2. Set secrets
echo $API_TOKEN                 | npx wrangler secret put API_TOKEN
echo $LIKED_SONGS_TOKEN         | npx wrangler secret put LIKED_SONGS_TOKEN   # separate token for GET /liked-songs
echo $MKVID_TOKEN               | npx wrangler secret put MKVID_TOKEN         # shared with mkvid (TRACKED_TOKEN there); enables the mkvid queue
echo $YOUTUBE_API_KEY           | npx wrangler secret put YOUTUBE_API_KEY
echo $GOOGLE_OAUTH_CLIENT_ID    | npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID
echo $GOOGLE_OAUTH_CLIENT_SECRET| npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET

# tlpool, the NAS browser pool every 1001tracklists request goes through (see "How 1001tracklists is fetched")
echo $TLPOOL_URL         | npx wrangler secret put TLPOOL_URL     # its URL through the cloudflared tunnel
echo $TLPOOL_TOKEN       | npx wrangler secret put TLPOOL_TOKEN   # bearer, both directions (Worker → /fetch, tlpool → /pool/events)

# mkvid's base URL, for deleting the old video after "Delete and recreate"; optional Access service token
echo $MKVID_URL                  | npx wrangler secret put MKVID_URL
echo $MKVID_ACCESS_CLIENT_ID     | npx wrangler secret put MKVID_ACCESS_CLIENT_ID      # optional
echo $MKVID_ACCESS_CLIENT_SECRET | npx wrangler secret put MKVID_ACCESS_CLIENT_SECRET  # optional

# Web Push (captcha, flagged-account and held-playlist pushes): node scripts/gen-vapid-keys.mjs mailto:you@example.com
echo $VAPID_PUBLIC_KEY  | npx wrangler secret put VAPID_PUBLIC_KEY
echo $VAPID_PRIVATE_KEY | npx wrangler secret put VAPID_PRIVATE_KEY
echo $VAPID_SUBJECT     | npx wrangler secret put VAPID_SUBJECT

# Optional switches (secrets or vars): PLAYLIST_SWEEP_DRY_RUN (default report-only),
# PLAYLIST_SWEEP_DAILY_REMOVALS (default 40), REJECT_VERTICAL (default off),
# MKVID_DAILY_CLAIM_CAP (24), MKVID_SHARED_DAILY_CLAIM_CAP (6), MKVID_CLAIM_TTL_SECONDS (3 h).
#
# Gone since 2026-09-29; delete them from an older deployment:
#   npx wrangler secret delete BRIGHTDATA_API_KEY
#   npx wrangler secret delete HOME_PROXY_URL
#   npx wrangler secret delete HOME_PROXY_TOKEN
#   npx wrangler secret delete MKVID_REQUIRE_FULL_TRACKLIST   # if it was set
# (the BRIGHTDATA_DAILY_CAP and TL_FETCHES_PER_TICK vars left wrangler.jsonc)

# 3. Set CF Access vars in wrangler.jsonc (`vars` block):
#    CF_ACCESS_TEAM_DOMAIN     yourteam.cloudflareaccess.com
#    CF_ACCESS_AUD             <app AUD tag from the Access dashboard>
#    CF_ACCESS_ALLOWED_EMAILS  you@example.com[,other@example.com]

# 4. Set up a Cloudflare Access "self-hosted" application covering the
#    /ui/* path of this worker's hostname, with a policy that
#    allows only your email.

# 5. Deploy
npx wrangler deploy
```

### Continuous deployment (Workers Builds)

Pushes to `main` auto-deploy via Cloudflare's native Git integration ([Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)) — no GitHub Actions deploy step, no `CLOUDFLARE_API_TOKEN` secret in the repo. The connection is a one-time OAuth step in the dashboard:

1. **Workers & Pages → `tracked` → Settings → Builds → Connect**, authorize the Cloudflare GitHub app on `pmaxhogan/tracked`, and pick `main` as the production branch. (The dashboard Worker name **must** match `name` in `wrangler.jsonc` — both are `tracked` — or the build fails.)
2. Build settings:
   - **Build command:** `npm run typecheck && npm test` — a red build aborts before deploy, so broken code never ships.
   - **Deploy command:** `npx wrangler deploy` (the default).
   - Deps install automatically from `package-lock.json`; no `npm ci` needed in the build command.
3. Push to `main` → Cloudflare runs typecheck + tests, then `wrangler deploy`. Non-`main` branches get a preview version (`npx wrangler versions upload`) instead of a production deploy, with the preview URL posted back as a PR comment.

Connecting an **existing** Worker leaves its secrets, KV bindings, crons, and `vars` in place — Workers Builds only adds the build/deploy-on-push pipeline. Secrets are never read from the repo (they're not in it); set/rotate them with `wrangler secret put` as before. The `.github/workflows/ci.yml` job still runs typecheck + tests on pull requests for pre-merge feedback.

**D1 migrations are a manual pre-push step.** Workers Builds runs `wrangler deploy` and nothing else, so a new file in `migrations/` must be applied with `npm run d1:migrate` *before* the code that needs it is pushed — otherwise the deployed Worker queries a table that isn't there yet. Migrations are plain SQL and additive, so applying one ahead of the deploy is always safe.

## Storage

Two kinds of state, two stores:

**D1** (`DB` binding, database `tracked`, schema in `migrations/`) holds everything that is queried, joined or kept as history:

| table | what |
| --- | --- |
| `subscriptions` | the DJ list, in the order it was added |
| `sub_sync` | per-DJ sync summary: playlist id, artist name, last run / error / stats |
| `tracklists` | one row per set URL ever discovered for a DJ: processed / abandoned / failure count, the recorded video (`video_id`, `video_known`, `video_source` = `1001tl` or `mkvid`), and `checked_at` for the recheck cadence |
| `now_playing_audit` | one row per `/now-playing` call (summary + full record), 90 days |
| `playlist_additions` | one row per set the sync decided an outcome for, 90 days |
| `mkvid_requests` | sets handed to mkvid to render + upload (see **Sets without a YouTube recording**) |
| `set_schedule` | when each set page is next due for a recheck (pace by set age), one row per set URL |
| `set_verification` | the two-fetch verification of each set's track list (fingerprint, accounts, times, `pending` / `verified`) |
| `dj_schedule` | when each DJ's listing page is next read (discovery) and its next "older sets" backfill step |
| `render_feed` | the render feeder's first fetches for sets mkvid waits on: the day's count, and each set's cooldown / failures / given-up flag (migration `0012`) |
| `pool_events` | events tlpool posted (challenges, flagged accounts) and whether each was pushed |
| `set_media_facts` | per set page: no-full-recording notice, last cue, audio player durations, the linked video (the full-recording rule's input) |
| `removed_videos` | never re-add: videos the owner removed, dead videos, remove-and-replace, per playlist |
| `playlist_removals` | every removal the playlist hygiene made or would make, with the reason (the `/ui/removed` page) |
| `video_overrides` | videos the owner allowed despite the full-recording rule |
| `playlist_members` | the last complete listing of each managed playlist |
| `playlist_confirmed` | videos tracked confirmed in a playlist (insert answered, or seen in a complete listing): what the owner-removal comparison expects |
| `mkvid_old_videos` | old mkvid videos a recreation replaces, until mkvid confirms their deletion |
| `mkvid_claims` | append-only log of mkvid claims per Pacific day and account (the daily caps count this) |

The sync still reasons about one `SubState` object per DJ (`lib/sync-store.ts` hydrates it from `sub_sync` + `tracklists` and writes it back as row upserts, diffing against what it loaded so a tick that touched 20 sets writes 20 rows). The 5-minute scheduler tick picks its few items from `set_schedule` / `set_verification` / `dj_schedule` / pending `tracklists` rows instead of loading every DJ; "Invalidate & resync", ban-victim requeues and mkvid's deliveries are direct row updates. D1 has no TTLs, so the daily cron prunes both audit tables and `pool_events` at the 90-day horizon.

**KV** keeps what is genuinely a cache or a tiny blob: every `CACHE` entry that has a TTL (YouTube resolves, 1001tl searches and parsed pages, medialinks, Apple links, playlist membership, DJ set lists, the Access JWKS), the `ban:pause` master switch and the admin banner's episodes, the scheduler settings (`pool:settings` in SUBS) and its backoff, the DJ backfill cursors, the daily combined-insert counter, `subs:combined`, the Google OAuth tokens and the Web Push subscriptions.

**Migration from the KV-only layout** is automatic and one-way. Before D1, the subscription list (`subs:list` / `subs:item:*`), each DJ's state (`subs:state:<slug>`, one JSON blob) and both audit trails (`np:` / `pladd:` keys with metadata summaries) lived in KV. After the deploy that introduced D1 (`lib/kv-import.ts`):

- the subscription list and every DJ's state are imported on first touch (and by the first cron tick, so the drain cron sees every backlog immediately). An import that *fails* throws rather than returning an empty state — an empty state would make the sync treat every set as new and re-fetch the DJ's whole back catalogue, which is exactly what gets the 1001tracklists account banned;
- the audit trails are imported in bounded pages (40 keys per trail per cron tick — each full record is a separate KV `get`) with progress at `migrate:d1:audit` in `SUBS`; `INSERT OR IGNORE` on the old key makes a re-run harmless. `GET /ui/api/migration` shows where it is;
- nothing is deleted from KV. The old audit rows age out through their TTLs; the state blobs stay as a backup and are never read again once their D1 rows exist (`migrate:d1:*` flags).

Tests run against the real schema: `test/helpers/fake-d1.ts` is an in-memory sql.js (SQLite-as-WebAssembly, no native build, any Node version) database with `migrations/*.sql` applied, strict like D1 about `undefined`/boolean bind values.

## How 1001tracklists is fetched

**Only through tlpool.** Since 2026-09-29 every 1001tracklists request (set pages, DJ listing pages, search, media link lookups) goes through tlpool, a browser pool on the NAS (its own repo), reached through the cloudflared tunnel at `TLPOOL_URL` with bearer `TLPOOL_TOKEN`. Each pool account is a real headed Chrome profile pinned to one exit IP for life. tlpool owns the accounts, their daily page budget and pacing, and relays captchas to the owner; the Worker decides only *what* to fetch and *how urgent* it is. The Worker never sees a credential: an answer names the serving account only by an opaque id (`acct-N`). The home forwarder, Bright Data and direct fetches from Cloudflare's egress are gone from every 1001tracklists path.

**One code path.** `fetch1001()` in `src/lib/upstream1001.ts` is the only route, with `src/lib/pool.ts` as the client:

0. **Master switch.** While `ban:pause` (CACHE KV) is set nothing is fetched and the scheduler does nothing. Only the operator sets and lifts it (wrangler, at pool launch). The admin banner's *Dismiss* (`POST /ui/api/ban/clear`) hides the banner and never touches the switch.
1. **`POST {TLPOOL_URL}/fetch`** `{ url, kind, priority, excludeAccounts?, maxWaitSeconds, queueSeconds? }` (plus `method` / `form` / `headers` for the two POST endpoints: search and the DJ "older sets" XHR). A phone fetch waits at most 25 s, anything else 20 s by default and never more than 90 s per POST (the cloudflared tunnel cuts a request at 100 s). tlpool answers every contract result **with HTTP 200**, a page or `{ error, retryAfterSeconds, reason?, accountId?, queuedSeconds? }`, so the client reads the body, never the status. A `timeout` carries a `reason`: `queued` (no browser free yet: all busy, or paced), `running` (an account has it, its page load has not finished), `browser` (that page load stalled and tlpool killed it), `net_error`, `internal`; an older tlpool sends none.
   **Long queueing** (`queueSeconds`, 0–900): the client re-POSTs the identical request (`maxWaitSeconds` = min(90, time left)) while the answer is `timeout` with reason `queued` / `running`, until `queueSeconds` after the first POST; tlpool keeps the job's place in its queue and attaches each repeat to that job. Only manual button syncs use it (pool setting `manualQueueSeconds`, default 600: a Sync / Resync press may wait up to 10 min per page for a free browser, the request held open meanwhile; Workers have no wall-clock limit on an HTTP request while the client stays connected). The scheduler and phone keep their single short wait.

| request | kind | priority |
| --- | --- | --- |
| `/now-playing` (search, set page, per-track links), `/tracklist`, purge / refresh | `search` / `set` / `medialink` | `phone` |
| the tracklist viewer's set page | `set` | `phone` |
| the viewers' per-track links (lazy: a row's **links** button or **Load links**) | `medialink` | `recheck` |
| DJ profile page in the admin UI; scheduler DJ discovery | `dj` | `new` |
| scheduler: never-fetched set ≤ 14 days old (or undated) | `set` | `new` |
| scheduler: verification second fetch | `set` | `verify` (with `excludeAccounts`) |
| scheduler: recheck by age | `set` | `recheck` |
| scheduler: older never-fetched set, DJ "older sets" step | `set` / `dj` | `backfill` |

**Failures.** Pool refusals map onto the typed errors every batch handles: `budget_exhausted` / `challenge_pending` → `PoolPausedError`, `no_healthy_account` / `blocked` (tlpool's own decoy and rate-block detection included) / `timeout` / pool unreachable → `PoolUnavailableError`. Both stop the batch and charge the set nothing. A non-phone timeout with reason `browser` (or no reason, from an older tlpool) is asked once more with the stalled account in `excludeAccounts`, so another account serves it; `queued` / `running` (the queue budget is spent, or the caller chose a short wait), `net_error` and `internal` are not retried. The error text says what happened and is what a DJ's last sync error, the sync toast and the scheduler page show: `pool busy: waited 600 s for a free browser (other fetches were running)`, `pool slow: acct-34's page load had not finished after 600 s`, `page load stalled on acct-34 (tlpool stopped it); retried on another account: …`, `pool timeout: no page within 20 s (pool busy or a page load stalled)` (older tlpool), `pool unreachable: tlpool or its tunnel did not answer (…)`. A pool refusal on a sync's DJ listing page stops that run and is recorded the same way. From the site itself: 404/410 → `UpstreamHttpError` (charged, final); 5xx → one ordinary failure; 401/403/429, a block page or a Cloudflare shell that gets through the browser → stop the batch. Three charged failures abandon a set. **Decoy pages** (flagged accounts get the real page with randomized names; `parseTracklist` counts rows whose microdata name, visible text and link slug disagree) are never cached or shown (`DecoyTracklistError`); the account is reported to tlpool (`POST /accounts/:id/retest`, which rests it 72 h). Only a page where most rows disagree accuses its account; a page with a few far mismatches is not trusted and counts nothing towards verification, but reports nobody: real pages carry the odd credit difference (2026-10-07: one row, "Coolio" in the microdata vs "Coolio ft. L.V." on the page, sat on 19 sets and had rested 19 accounts). A featured-artist credit on either side and a country tag such as "(BR)" only in the microdata are benign (`isNearMismatch`). Every report, decoy or verification mismatch, is limited by pool settings `reports`: at most 6 per UTC day, and none while more than half of the non-passive pool already rests. A dead YouTube video settles on the first strike.

**Every page is used fully, once.** A set page fetched by the sync (new set, recheck or verification) is parsed once, and that one parse feeds the parsed-list cache, the verification record, the next due time and the mkvid track list. Every set page fetch, the phone's and the viewer's included, also stores the page's media facts (`set_media_facts`: no-full-recording notice, last cue, audio player durations) for the playlist full-recording rule.

**Parsed-list cache** (decision 19; details under [Tracklist cache and purge](#tracklist-cache-and-purge)): `tl:v4:<slug>` for 3 days when every row is identified, 6 hours with ID rows or a set under 2 days old (date from the URL, else the page). Decoy and empty parses are never cached. **Forced refetches** (purge routes, the viewer's Refresh, `/now-playing` `refresh: true`) are limited by pool settings `forcedRefetch`: 120 s per set, 40 per UTC day overall; a skipped one answers the cached list with `refreshed: false`.

**Per-track media links** are budgeted views too (decision 11). `/now-playing` looks up only the tracks it returns; `/tracklist` at most 25, one at a time; the viewers only on request. Each result is cached per track id for 30 days (`ml:v1:<id>`); a failed lookup is not cached.

### The scheduler (`src/lib/fetch-scheduler.ts`)

The `*/5` cron is only a heartbeat. Each tick draws a random number of items in `[tick.minItems, tick.maxItems]` (default 0–3), takes them from what is due in `priorities.order` (default new → verify → recheck → backfill), runs them one at a time and stops at the first refusal; with `retryAfterSeconds` it also stands down until then (`pool:tick_backoff_until` in CACHE). Only subscribed DJs' sets are considered (filtered in SQL, so an unsubscribed DJ's backlog cannot crowd them out). There is no burst anywhere: the daily 06:00 cron only prunes audit tables, and each DJ's discovery is spread around the clock (every ~24 h ± 4 h per DJ).

**Recheck pace by set age** (decision 13; the date comes from the URL): 0–2 d every 12 h, 2–7 d daily, 7–30 d every 5 d, 30–180 d every 30 d, older never, unless the set has no good video or has ID rows, then every 90 d. Undated sets every 5 d. Every interval is jittered ±15 %. Schedule rows are created lazily (500 at a time, at most hourly): a set already overdue gets a random due time inside one interval, so the ~2,100 sets known when the pool starts come due gradually. `markSetDue(env, url)` makes a set due now (hand marks: Invalidate & resync, playlist hygiene).

**Attempts.** Every set page the tick fetches first claims an attempt (`set_schedule.retry_at`): a set whose fetch does not complete waits 15 min, then 30, then 60 before it is tried again, and gets at most 3 attempts per UTC day, so no page is fetched every tick.

**Verification** (`src/lib/verification.ts`, decision 2): a track list is `verified` only when a second fetch at least 2 h after the first, served by a *different* account, passes the decoy detector and matches the first on every row (row count, artist, title, cues, layering). A pair that disagrees reports the first account and starts over; a verified list that changes later (IDs identified) just starts over. Nothing is rendered by mkvid from an unverified list (`isVerified` gates the claim; `mkvid_request_tracks.trusted` is 1 only for a list saved while its set was verified, and migration 0007 reset every older row).

**DJ backfill**: discovery walks the head of a DJ's list and stores page 1's scroll keys with the backfill cursor (`djbackfill:<slug>` in SUBS); the paced backfill then takes one "older sets" step (10 sets) per DJ about once a day at priority `backfill`.

**Settings** live in SUBS KV (`pool:settings`, merged over the defaults in `src/lib/pool-settings.ts`: recheck bands, priority order, tick size, verification gap, discovery and backfill pace, `manualMaxFetches`, `manualQueueSeconds`, `forcedRefetch`, `renderFeedPerDay`, `reports`) and are edited on `/ui/pool/settings` through `GET/PUT /ui/api/pool/settings` (CF Access). tlpool's own settings (page budget per account, XHR budget, ramp, phone share, priority ceilings, image policy) are on the same page, proxied to tlpool. Manual buttons (`Sync`, `Invalidate & resync`, the `…all` variants) are bounded by `manualMaxFetches` (default 10) per press, and each of their fetches may queue for a free pool browser for `manualQueueSeconds` (default 600, 0–900; 0 = one 20 s ask like the scheduler).

**Add account** (`/ui/pool`, `+ Add account`): the dialog's optional "Create at" box (`<input type="datetime-local">`, your local time, at most 90 days ahead) schedules the creation instead of starting it now; the browser converts it to UTC and sends `scheduledAt` through `POST /ui/api/pool/accounts` (the Worker checks it: ISO with `Z`/offset, not more than 5 minutes past, at most 90 days ahead) to tlpool `POST /accounts`. tlpool queues it (`queued-<n>`, kept in its sqlite, retried every 30 min after a failure) and the accounts table lists it with state `queued`, its local due time and a Cancel button (`POST /ui/api/pool/accounts/queued-<n>/cancel`); queued rows are not counted as accounts. Passive and the exit type apply to the queued account. Several creations can run at once: `+ Add account` always opens a fresh form, and the ones in progress are listed under it (each with its own progress view).

| upstream | how we fetch it |
| --- | --- |
| YouTube Data API | direct `fetch()` |
| iTunes Search API | direct `fetch()` |
| 1001tracklists (every request) | tlpool `POST /fetch`, nothing else |

### Pool events and pushes

tlpool posts `challenge.created` / `.solved` / `.expired` and `account.flagged` / `.created` / `.retired` / `.rested` to **`POST /pool/events`** (bearer `TLPOOL_TOKEN`; exempt from the Tasker token gate). Events are stored in `pool_events` with only whitelisted ids (`acct-N`, challenge ids, times); a new challenge, a flagged account and a retired account become a Web Push (`src/lib/pool-events.ts`) that opens `/ui/captcha/<id>` (or the accounts page `/ui/pool`); a failed delivery is retried by the cron while the event is under 2 hours old (5 tries at most), and events older than 90 days are pruned daily. Every push goes out immediately, at any hour: there are no quiet hours (owner decision, 2026-09-29). tlpool holds a challenge for 2 hours; unanswered, it closes it and rests the account 6 hours.

### Admin banner and pause

`src/lib/ban-state.ts` keeps `ban:pause` (the master switch) and the banner's episodes (`ban:home`, `ban:ep:*`) in KV. Every admin page shows the banner while paused, until *Dismiss* hides it for that pause (`ban:pause:dismissed`; the pause itself stays); the Settings page's ban history lists past episodes and whether tlpool is configured. Web Push needs `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` (`node scripts/gen-vapid-keys.mjs mailto:you@example.com`); **Enable notifications** once per device, **Send test notification** proves delivery.

Admin endpoints (CF Access): `GET /ui/api/ban/status[?live=1]`, `POST /ui/api/ban/clear`, `POST /ui/api/ban/simulate`, `POST /ui/api/ban/requeue-victims[?days=14&dry=1]`, `GET/PUT /ui/api/pool/settings`, `GET /ui/api/push/config`, `POST /ui/api/push/{subscribe,unsubscribe,test}`, `GET /ui/sw.js`. Pool pages and their proxies to tlpool (accounts, add account, captchas, live view, tlpool settings) are listed in `src/routes/pool-ui.ts`.

## How it works

1. **YouTube resolve (best-effort)** — `search.list` (100 quota units) for the title; `videos.list` (1 unit) for durations; pick the result with the smallest abs delta from the provided duration (max 90s tolerance). Cached 30 days. **A miss here is not fatal** — the tracklist lookup falls through to a title search (step 2), so a YouTube-side hiccup (the exact upload missing from the top 5, a duration outside tolerance, a quota/5xx blip) no longer blocks a set 1001tracklists actually has.
2. **1001tracklists search** — tried in order until one hits, then cached 2 hours each: (b) POST `/search/result.php` with the resolved **YouTube URL** + a media-source filter pinned to YouTube (exact); (c) a `search_selection=9` **text search for the resolved video's title**; (d) a text search for the **original POSTed notification title**. Ranking the text-search rows is subtle: same-venue sets share an *identical* visible title (seven "Gorgon City @ Club Space Miami, United States" differing only by a date that lives in the URL, not the title), so a text score can't pick the right date — but 1001tl's own result order already does (it sees the date in the query). So we walk 1001tl's order and take the **first row that clears the bar**, where the bar is an **IDF-weighted token match**: each title token is weighted by how rare it is across the result set, so shared venue/geography boilerplate ("club space miami united states") counts for little and the distinctive artist/event tokens dominate — and a match must include a distinctive shared token, so a query that only shares the venue with an unrelated set is rejected. Steps (c)/(d) are what recover a YouTube miss. If everything misses, the response carries a `message` explaining whether a video was found and which searches were run.
3. **Anti-bot challenges** — handled by tlpool's real browsers (captchas are relayed to the owner, never solved by code). If a block page (`/info/unblock_ip.html` form) or a Cloudflare shell still reaches the Worker, it throws a typed `IPBlockedError` / `UpstreamUnavailableError`, surfaced as `upstream_error`, and a batch stops.
4. **Tracklist scrape** — `node-html-parser` over the (un-gated) tracklist HTML. Each `div.tlpItem` contributes one row. Cue seconds come from the JS-emitted `cueValueData` map (keyed by each row's inner `tlp{N}_content` id) — using the hidden form input directly is wrong because it defaults to `"0"` for uncued rows (mashup-linked siblings, trailing untimed extras), which would pollute every selection at probe=0. Title/artist from `meta[itemprop="name|byArtist"]`; mashup-linked status from the `con` class on the row. Cached 3 days when fully identified, 6 hours with ID rows or a set under 2 days old (skipped when the parse returns 0 tracks — that's almost always a transient captcha we want to retry, not a real zero-track tracklist — and for decoy pages). See [Tracklist cache and purge](#tracklist-cache-and-purge).
5. **Current-track selection** — group `w/` siblings, find the group whose `[startSeconds, nextGroupStart)` window contains `currentSeconds`, then always include the previous group (if any) and the next group (if any) so the caller has one-tap context. When `currentSeconds` is before any cued track, return only the first cued group with `isCurrent: false`.
6. **Per-track Apple/YouTube links** — first try 1001tracklists' first-party AJAX `get_medialink.php?idObject=5&idItem=<n>` and parse the Apple Music embed iframe URL out of the response; fall back to the iTunes Search API for an Apple link if 1001tl has none. No per-track YouTube search (YouTube Data API quota is precious).

### Cache versioning & audit trail

Every cache key embeds the version of the logic that produced its value (`family:v<N>:…`, e.g. `s1001t:v2:<hash>`). When that logic changes, bump the number in `CV` (top of `routes/now-playing.ts`) and stale entries from the old code are simply not read — they age out via TTL instead of being served. This exists because a real fix once looked broken in production: the search change was correct, but a `null` tracklist cached under the un-versioned key by the *old* over-strict ranking kept coming back for two hours.

Each `/now-playing` call also writes a durable audit row to D1 (`now_playing_audit`, `lib/now-playing-audit.ts`; 90-day retention, pruned by the daily cron). The write runs after the response inside `waitUntil` and swallows its own errors, so a D1 hiccup never fails a Tasker call. Each record captures the full request story: inputs (`currentSeconds`, `videoDurationSeconds`, title/url), the YouTube resolution (matched id/title or the error), the tracklist-search plan and which signal hit, and the selection it produced (`currentStartSeconds`, `currentSkewSeconds`, chosen tracks) — plus an `impossibleTimestamp` flag when `currentSeconds > videoDurationSeconds` (the fingerprint of a client-side position bug). A compact summary sits in its own column so the admin panel lists recent requests without parsing records. Workers Logs only retains ~3 days, but timestamp/selection bugs are often noticed much later (a wrong "now playing" spotted in an old screenshot).

Browse this history on the **Home** page (`/ui`) under **Recent requests** (the last 6, newest first; the full Activity log with filters is phase 2). Each row opens its full record, and rows with an error status or an impossible timestamp are highlighted, with a flag on large position skews. Behind Cloudflare Access. Endpoints: `GET /ui/api/audit?limit&cursor` (summaries, keyset-paged newest-first; each record's `key` is its row id) and `GET /ui/api/audit-detail?key=` (full record). For raw CLI access: `npx wrangler d1 execute tracked --remote --command "SELECT t, status, summary FROM now_playing_audit ORDER BY ts DESC LIMIT 20"`.

### Playlist-addition audit trail

The sync writes the same kind of trail for its own work (`lib/playlist-audit.ts`): one D1 row (`playlist_additions`, 90-day retention) per tracklist it decided an outcome for. Statuses are `added` (video inserted), `duplicate` (already in the playlist), `replaced` (a recheck found the recording swapped: old removed, new inserted — `previousVideoId` names the old one), `no_youtube` (the set page has no recording to add), `failed` (errored this run, will be retried) and `abandoned` (errored `ABANDON_AFTER_FAILURES` times; the cron gives up). Rechecks that change nothing write no row. Each record carries the set URL, DJ, video id/url, playlist id/title, the combined-playlist outcome for the same video (`combinedStatus`: `added` / `duplicate` / `failed` / `unavailable`), which scrape path served the page, what triggered the run (`cron.daily`, `cron.pending`, `manual.all`, `manual.one`, `manual.resync`, `manual.combined`), the error message, and how long the set took. The trail doubles as the seed for recheck baselines after the upgrade that introduced them (see **Rechecks** above). This answers "why isn't that set in my playlist?" — previously only answerable from Workers Logs, which age out in ~3 days.

Rows are buffered during a run and flushed in one batch at the end: awaiting up to 30 sequential writes inside the set loop would eat a large slice of the 25 s sync deadline. A run killed mid-loop therefore loses its rows — deliberate, since this is diagnostics only; idempotency and progress live in the per-sub state. A D1 failure here is logged and swallowed, never surfaced as a sync failure.

Browse it on the **Home** page (`/ui`) under **Recent playlist additions**, which mirrors the requests view (the last 6, newest first; each row opens its full record, and `failed` / `abandoned` rows are highlighted since `no_youtube` is a normal outcome). Endpoints: `GET /ui/api/playlist-additions?limit&cursor` (summaries) and `GET /ui/api/playlist-addition-detail?key=` (full record). Raw CLI access is the same as above against the `playlist_additions` table.

## Files

```
src/
  index.ts                  OpenAPIHono app + /openapi.json
  routes/now-playing.ts     pipeline orchestrator (track playing at an offset)
  routes/tracklist.ts       whole-tracklist → JSON dump
  routes/subscriptions.ts   admin JSON API (DJs, playlists, tracklists, YouTube) mounted under /ui
  routes/legacy.ts          the old /subscriptions prefix: 301 for pages, 410 for API / OAuth / sw.js
  ui/tokens.ts              design tokens (colors, type scale, spacing, radii), light and dark
  ui/base.ts                shared CSS (buttons, tables, dialogs, chips, toasts)
  ui/icons.ts               the inline SVG icon set
  ui/runtime.ts             shared page runtime (the one global, TK: api helpers, formatting, toasts)
  ui/shell.ts               sidebar, rail, top bar, bottom tabs, banner slot, theme control
  ui/pages/                 one module per page (home, djs, dj, set, playlists, removed, mkvid, pool, captcha, settings, tools)
  routes/mkvid.ts           the work queue mkvid polls (bearer MKVID_TOKEN)
  routes/pool-api.ts        POST /pool/events (tlpool webhook) + GET/PUT /ui/api/pool/settings
  middleware/auth.ts        bearer token (timing-safe)
  middleware/cf-access.ts   Cloudflare Access JWT verification (RS256 + JWKS)
  schemas.ts                zod request/response (also drives OpenAPI)
  types.ts
  lib/
    timestamp.ts            cue parsing + current-track selection
    tracklists1001.ts       search, scrape, medialink, URL parsing (all through the pool)
    tracklist-resolve.ts    cached tracklist-page + per-track-link resolvers (shared by both API routes)
    db.ts                   D1 helpers (bind-value coercion, chunked batches)
    subscriptions.ts        DJ slug parser + the `subscriptions` table (with the one-time KV import)
    sync.ts                 auto-playlist orchestrator (crawl → scrape → insert)
    sync-store.ts           per-sub sync state ⇄ `sub_sync` + `tracklists` rows (diff-based saves, KV blob import)
    kv-import.ts            one-time KV → D1 import of states + audit trails, driven from the cron
    now-playing-audit.ts    the `now_playing_audit` table behind "Recent requests"
    mkvid.ts                the mkvid queue: set-page audio-source extraction + request lifecycle (claim/complete/fail)
    audit-cursor.ts         keyset pagination shared by both audit trails
    dj-index.ts             DJ index crawl (infinite-scroll AJAX) + set-page video id extraction
    dj-sets.ts              cached per-DJ set list behind the /ui/dj/<slug> profile page
    combined-playlist.ts    the "All tracked artists" playlist: live mirror + bounded backfill
    playlist-cache.ts       KV-cached playlist video-id sets + find-or-create (shared by both)
    youtube-playlists.ts    YouTube Data API v3 playlist client (OAuth)
    playlist-audit.ts       the `playlist_additions` table behind "Recent playlist additions"
    google-oauth.ts         Google OAuth 2.0 flow + token refresh + revoke
    log.ts                  structured JSON logger + per-request counters
    fetch.ts                fetchWithTimeout + block-page / Cloudflare-shell detectors
    upstream1001.ts         the one 1001tracklists route: ban:pause check → tlpool
    upstream-errors.ts      the typed fetch failures (pause / unavailable / HTTP / transport)
    pool.ts                 tlpool client (POST /fetch, account retest) and its error mapping
    pool-settings.ts        scheduler settings (recheck pace by age, priorities, tick size) in SUBS KV
    fetch-scheduler.ts      the 5-minute tick: what is due, in priority order, a few items at a time
    verification.ts         two-account verification of track lists (isVerified)
    pool-events.ts          tlpool webhook events: storage, Web Push
    ban-state.ts            the ban:pause master switch + admin banner episodes (KV)
    web-push.ts             Web Push (VAPID / RFC 8291) delivery + subscription storage
    youtube.ts              YouTube Data API v3 client
    itunes.ts               Apple Music fallback search
    cache.ts                KV helpers + sha1 + TTLs
  routes/ban-ui.ts          shared admin-page banner / alerts row / ban history / service worker
scripts/
  gen-vapid-keys.mjs        prints a VAPID key pair for the Web Push alerts
migrations/                 D1 schema, one SQL file per change (apply with npm run d1:migrate)
test/
  fixtures/                 saved 1001tracklists HTML and JSON
  helpers/fake-kv.ts        in-memory KVNamespace
  helpers/fake-d1.ts        sql.js-backed D1 with the real migrations applied
  sync-store.test.ts
  subscriptions-store.test.ts
  kv-import.test.ts
  audit-store.test.ts
  audit-routes.test.ts
  timestamp.test.ts
  tracklists1001.test.ts
  subscriptions.test.ts
  sync.test.ts
  combined-playlist.test.ts
  dj-index.test.ts
  youtube-playlists.test.ts
  youtube.test.ts
  cf-access.test.ts
  google-oauth.test.ts
  upstream1001.test.ts
  ban-state.test.ts
  web-push.test.ts
  pool-settings.test.ts
  verification.test.ts
  fetch-scheduler.test.ts
  pool-api.test.ts
docs/tasker-setup.md
```
