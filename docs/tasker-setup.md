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

The task runs on demand (e.g. via a home-screen widget or a notification action).

The generated task (see the end of the Pre-save section) opens the scene **first**, before any of the steps below, so there is a window on screen within about a second. It shows a circular spinner and a status line that follows the work:

| When                              | Status line                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| The scene opens                   | `Finding the media notification…`                                                        |
| The notification was read         | `Found the notification (1:02:03 in). Asking the server which track this is…`, and the title becomes the video title |
| The Worker answered               | `Drawing 3 tracks…`                                                                      |
| The cards are in                  | the spinner goes; the line is hidden on `ok`, else it keeps the status message           |
| No media notification             | `No media notification found. Start the set in YouTube Music, then tap refresh.`         |
| No answer from the Worker         | `No answer from the server (network error or timeout).` or `The server answered HTTP 500.` |

The spinner is the scene's `BusyRow` (shown while `%WP_BUSY` is `1`), the title is `%WP_TITLE` and the line is `%STATUS_MSG`. All three are globals because a shown Scene v2 follows globals live, while a local such as `%antitle` is only read when the scene opens. So Show Scene v2 runs with "Continue Task Immediately" on, and the HTTP Request with "Continue Task After Error" on: the task has to reach the parse step to end the spinner. The ‹ › pager uses the same spinner and line (`Loading the whole set from the server…`) while it loads the full set.

Steps:

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
   - Continue Task After Error: **On** — the scene is already showing its spinner, so the parse step must run to report the failure in the window (step 7).

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
     - without one: **Pre-save** (a + icon, see below) and, when there is an `appleLink`, the Apple Music note. ID rows get the + too.
   - When `setAppleLink` is set, an "Open whole set on Apple Music" card sits on top. A ‹ › pager at the bottom (`Tracked.Page`) loads the whole set once via `POST /tracklist` (`%FULL_TRACKS`) and pages through it 5 at a time.

   **Links that are still loading.** The Worker answers within about 20 s of the request (`PHONE_ANSWER_BUDGET_MS`), well inside the HTTP step's 30 s timeout. A track whose Apple/YouTube links were not looked up by then comes back with `linksPending: true` and null links; its card shows a small spinner instead of buttons. The task then runs up to three fill rounds (Wait 5 s, the same `POST /now-playing` with a 15 s timeout, `whatsplaying-fill.js`), which merge the links into `%NP_TRACKS` by cue + artist + title and re-render, stopping as soon as nothing is pending. The lookups finish in the background on the Worker and are cached for 30 days, so a fill round is answered from cache. After each answer the Worker also looks up the links of the next 3 tracks in the background, so the next tap a few minutes later is all cache. And every set the sync reads has its tracks' links looked up ahead of time by the 5-minute cron (README, Per-track media links), so most taps are all cache from the first one.

   **A set page past its cache TTL** is answered from the kept copy at once (KV keeps it 7 days past the TTL) and fetched again behind the answer; only a set never fetched before waits for 1001tracklists.

   The response always carries up to three groups (previous, current, next) so the user can disambiguate transitions and peek ahead. `isCurrent` is `true` only on the current group's members. Edge cases the response handles automatically: at the start of the set there's no previous; at the end there's no next; before any cued track the response is just `[firstCuedGroup]` with all `isCurrent: false` ("next up").

7. **Network error**
   - No branch: the parse step sees that there is no HTTP response code (or one that is not 200), ends the spinner and puts the reason in the status line.

## Pre-save (task `Tracked.PreSave`)

A track 1001tracklists has identified but that has no YouTube video (only Spotify / Apple / other links, only a 1001tracklists track page, or just "ID") can be **pre-saved**: the Worker queues it, rechecks it twice a day, and pushes to all devices when a YouTube version appears (see the Pre-saves page in the web UI).

- The card's + button runs `Tracked.PreSave` with `%src` (`np` = the now-playing window, `full` = the paged whole set), `%idx` (index into `%NP_TRACKS` / `%FULL_TRACKS`) and `%pkey`.
- Step 1 (JavaScriptlet) looks the track up, sets `%PRESAVE_PENDING` to the track's key and re-renders, so the tapped + becomes a small spinner at once, and builds the body with `JSON.stringify` into `%presave_body` — `trackId`, `trackUrl`, `tracklistUrl` (from `%TRACKLIST_URL`), `rowIndex`, `cueSeconds` (= `startSeconds`), `artist`, `title`, `artworkUrl`, null fields left out. An ID row with no track id is pre-saved by `tracklistUrl` + `rowIndex` / `cueSeconds`; the Worker re-reads the set page until it is identified.
- Step 2: **HTTP Request** `POST %TRACKED_URL/presave`, same `Authorization: Bearer %TRACKED_TOKEN` header as the other tasks, body `%presave_body`, "Continue Task After Error" on so a 400 reaches the next step.
- Step 3 (JavaScriptlet) flashes the Worker's one-line `message` (`Pre-saved: Artist – Title (watching for a YouTube link)`, `Already pre-saved …`, `Already on YouTube: …`) or the error, records the track in `%PRESAVED`, clears `%PRESAVE_PENDING` and re-renders. A pre-saved track shows a tinted check in place of the +; after a failure the + comes back.
- `%PRESAVED` (JSON `{ key: stage }`, key = `id:<trackId>`, else `url:<trackUrl>`, else `row:`/`cue:` + set URL) only covers what was pre-saved from this phone; it is kept across sets and is not refreshed from the server. `%PRESAVE_BUSY` guards against double taps.

The tasks are generated: edit the `*.js` files in `tasker/build/` and run `node tasker/build/build.mjs`, which rewrites `tasker/Tracked.prj.xml` in place (import that project into Tasker). `tasker/Tracked.prj.xml` is the project as the phone exports it (project `MCP.Tracked`), and the build finds its tasks by name, so re-exporting from the phone and rebuilding changes nothing; a generated task keeps the id, creation date and priority it has in that file. The scene layout is `tasker/build/scene.json`. The build also owns the order of `Tracked.WhatsPlaying`'s actions; the plugin, HTTP, Flash, Write File and Show Scene actions themselves are reused as Tasker exported them.

## Tips

- **Trigger**: bind this task to a Tasker widget on your home screen, or to a Quick Settings tile, or to an AutoNotification persistent control button — whichever flow feels least intrusive while listening.
- **Polling vs. on-demand**: don't set this on a timer. The Worker caches the YouTube → tracklist mapping and the parsed tracks for 2 hours each (per-track Apple/YouTube links and the iTunes fallback have much longer TTLs since track ↔ deep-link mappings are essentially immutable). Even with caching, every fresh poll still risks tripping 1001tracklists' per-IP rate-limit upstream. Tap-to-resolve only when you actually care about a track.
- **Token rotation**: if you ever roll `API_TOKEN` (Worker secret), update `%TRACKED_TOKEN` once in Tasker — the rest works unchanged.
