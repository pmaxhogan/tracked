# Tasker setup

End-to-end flow on the phone: a Tasker task reads the YouTube media notification, asks the Worker what's currently playing, and shows a card list of the previous / current / next tracks with one tap to open, like or pre-save each one.

## Prerequisites

- Tasker (Play Store).
- AutoNotification (Tasker plugin).
- Notification listener permission granted to AutoNotification (Settings → Notifications → Notification access).
- The Worker deployed (or a tunnel exposing local dev — see the project README).
- Your bearer token + Worker URL handy.

## Variables

In Tasker, declare two **Variables** (or paste them inline — your call):

- `%TRACKED_URL` = your Worker URL, e.g. `https://tracked.example.workers.dev`
- `%TRACKED_TOKEN` = the value of `API_TOKEN` (the Worker secret).

## Task: "What's playing"

The task runs on demand (e.g. via a home-screen widget or a notification action). Steps:

1. **AutoNotification Query**
   - Action: Plugin → AutoNotification → Query.
   - App filter: `com.google.android.youtube` (and `com.google.android.apps.youtube.music` if you also use YT Music).
   - Persistent: `True` (background-play notification stays put).
   - Output variables: at minimum `%antitle` (notification title) and any media-position fields the action exposes. The "duration" field on the notification is typically the song length, not the playback offset.

2. **MediaUtilities ▸ Get Active Media Info** *(plugin alternative)*
   - Returns the active MediaSession for the device, including:
     - title (use this if AutoNotification's `%antitle` is unreliable),
     - duration in ms,
     - position in ms (the playback offset — what we want).
   - If you'd rather not install MediaUtilities, the built-in **Media → Media Control: Get Info** action (Tasker 6+) exposes the same fields under `%mc_*`.

3. **Variable Set**
   - `%dur` = duration_ms / 1000 (use a `Variable Math` or just ` / 1000 ` in a Variable Set with "Do Maths" on).
   - `%pos` = position_ms / 1000.

4. **HTTP Request**
   - Method: `POST`.
   - URL: `%TRACKED_URL/now-playing`.
   - Headers:
     ```
     Authorization: Bearer %TRACKED_TOKEN
     Content-Type: application/json
     ```
   - Body:
     ```json
     {
       "videoTitle": "%antitle",
       "videoDurationSeconds": %dur,
       "currentSeconds": %pos
     }
     ```
   - Output structure: `JSON`.
   - Continue Task After Error: **Off** — so a network blip falls into your error branch.

5. **Branch on `%http_data.status`**

   | Status           | UX                                                                                                   |
   | ---------------- | ---------------------------------------------------------------------------------------------------- |
   | `ok`             | Build a Scene with `%http_data.tracks` (see step 6).                                                 |
   | `unidentified`   | Same Scene. Rows with `isUnidentified: true` carry no deep links — render greyed-out and untappable. Rows with a non-null `idStatus` ("ID Remix" / "ID Edit" / etc.) DO have links but the playing variant may differ from the linked base track — surface the `idStatus` label. |
   | `no_video`       | `Flash` toast: "Couldn't match this video on YouTube". Now also means "…and a direct 1001tracklists title search found nothing either." `%http_data.message` explains specifically (e.g. `no confident YouTube match for "<title>"; 1001tracklists title search found nothing`) — worth flashing the message instead of the fixed string. |
   | `no_tracklist`   | `Flash` toast: "No tracklist on 1001tracklists for this set". `%http_data.message` says whether a YouTube video was matched and which searches ran. |
   | `upstream_error` | `Flash` toast with `%http_data.message`. The message is structured: `1001 search: ip_blocked (<ip>)` or `1001 scrape: ip_blocked (<ip>)` means the upstream rate-limited us — usually transient, retry in a few minutes. Other messages indicate a real failure. |

6. **Scene: tracklist cards** (Scene V2, task `Tracked.RenderCards`)
   - The parse step stores the response in globals (`%NP_TRACKS`, `%TRACKLIST_URL`, `%SET_APPLE_URL`, `%LIKED`, …) and runs `Tracked.RenderCards`, which builds the whole card list as Scene V2 JSON in `%CARDS_JSON`. The scene's Variable element is live-bound to `%CARDS_JSON`, so every re-render (like, pre-save, paging) swaps in without reopening the scene.
   - One **Card** per track: artwork (or a ♫ placeholder), title with an `idStatus` badge, artist, and `startTime · durationTime`. `isCurrent` cards are tinted `primaryContainer` and labelled NOW PLAYING (JUST PLAYED / UP NEXT around it). Tapping a card opens its `trackUrl` (task `Open Track URL`).
   - **Buttons** on the right, at most two:
     - with a `youtubeLink`: 👍 like toggle (`Tracked.ToggleLike` → `POST /likes`) and ▶ YouTube;
     - without one: **Pre-save** (bookmark-plus icon, see below) and, when there is an `appleLink`, the Apple Music note. ID rows get the Pre-save button too.
   - When `setAppleLink` is set, an "Open whole set on Apple Music" card sits on top. A ‹ › pager at the bottom (`Tracked.Page`) loads the whole set once via `POST /tracklist` (`%FULL_TRACKS`) and pages through it 5 at a time.

   The response always carries up to three groups (previous, current, next) so the user can disambiguate transitions and peek ahead. `isCurrent` is `true` only on the current group's members. Edge cases the response handles automatically: at the start of the set there's no previous; at the end there's no next; before any cued track the response is just `[firstCuedGroup]` with all `isCurrent: false` ("next up").

7. **Network error** (the Off-error branch from step 4)
   - `Flash`: "Network error".

## Pre-save (task `Tracked.PreSave`)

A track 1001tracklists has identified but that has no YouTube video (only Spotify / Apple / other links, only a 1001tracklists track page, or just "ID") can be **pre-saved**: the Worker queues it, rechecks it twice a day, and pushes to all devices when a YouTube version appears (see the Pre-saves page in the web UI).

- The card's bookmark button runs `Tracked.PreSave` with `%src` (`np` = the now-playing window, `full` = the paged whole set), `%idx` (index into `%NP_TRACKS` / `%FULL_TRACKS`) and `%pkey`.
- Step 1 (JavaScriptlet) looks the track up and builds the body with `JSON.stringify` into `%presave_body` — `trackId`, `trackUrl`, `tracklistUrl` (from `%TRACKLIST_URL`), `rowIndex`, `cueSeconds` (= `startSeconds`), `artist`, `title`, `artworkUrl`, null fields left out. An ID row with no track id is pre-saved by `tracklistUrl` + `rowIndex` / `cueSeconds`; the Worker re-reads the set page until it is identified.
- Step 2: **HTTP Request** `POST %TRACKED_URL/presave`, same `Authorization: Bearer %TRACKED_TOKEN` header as the other tasks, body `%presave_body`, "Continue Task After Error" on so a 400 reaches the next step.
- Step 3 (JavaScriptlet) flashes the Worker's one-line `message` (`Pre-saved: Artist – Title (watching for a YouTube link)`, `Already pre-saved …`, `Already on YouTube: …`) or the error, records the track in `%PRESAVED` and re-renders. A pre-saved track shows a filled, tinted bookmark-check icon.
- `%PRESAVED` (JSON `{ key: stage }`, key = `id:<trackId>`, else `url:<trackUrl>`, else `row:`/`cue:` + set URL) only covers what was pre-saved from this phone; it is kept across sets and is not refreshed from the server. `%PRESAVE_BUSY` guards against double taps.

The tasks are generated: edit the `*.js` files in `tasker/build/` and run `node tasker/build/build.mjs`, which rewrites `tasker/Tracked.prj.xml` in place (import that project into Tasker).

## Tips

- **Trigger**: bind this task to a Tasker widget on your home screen, or to a Quick Settings tile, or to an AutoNotification persistent control button — whichever flow feels least intrusive while listening.
- **Polling vs. on-demand**: don't set this on a timer. The Worker caches the YouTube → tracklist mapping and the parsed tracks for 2 hours each (per-track Apple/YouTube links and the iTunes fallback have much longer TTLs since track ↔ deep-link mappings are essentially immutable). Even with caching, every fresh poll still risks tripping 1001tracklists' per-IP rate-limit upstream. Tap-to-resolve only when you actually care about a track.
- **Token rotation**: if you ever roll `API_TOKEN` (Worker secret), update `%TRACKED_TOKEN` once in Tasker — the rest works unchanged.
