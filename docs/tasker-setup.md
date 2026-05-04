# Tasker setup

End-to-end flow on the phone: a Tasker task reads the YouTube media notification, asks the Worker what's currently playing, and pops a small list with one tap to open the track on Apple Music or YouTube.

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
   | `no_video`       | `Flash` toast: "Couldn't match this video on YouTube".                                               |
   | `no_tracklist`   | `Flash` toast: "No tracklist on 1001tracklists for this set".                                        |
   | `upstream_error` | `Flash` toast with `%http_data.message`. The message is structured: `1001 search: ip_blocked (<ip>)` or `1001 scrape: ip_blocked (<ip>)` means the upstream rate-limited us — usually transient, retry in a few minutes. Other messages indicate a real failure. |

6. **Scene: tracklist popup**
   - Header (when present): if `%http_data.setAppleLink` is non-null, show a small "▶ Open whole set in Apple Music" pinned row at the top.
   - Use a `ListView` element bound to `%http_data.tracks(:)`.
   - Per-row layout (custom item layout):
     - **Artwork** (left thumbnail): `%http_data.tracks(:).artworkUrl` — server already normalises to 300×300. If null, render your own no-art placeholder.
     - **Title**: `%http_data.tracks(:).title`. If `idStatus` is non-null, append a subtle " · ID Remix" / " · ID Edit" / etc. badge.
     - **Subtitle**: `%http_data.tracks(:).artist`.
     - **Time line**: `%http_data.tracks(:).startTime` + " · " + `%http_data.tracks(:).durationTime` (skip the second part when empty). Mashup-linked siblings share the same `durationTime`.
     - **Right-side icon**: 🍎 (Apple) if `appleLink` is set, else ▶ (YouTube) if `youtubeLink` is set, else 🔗 (1001tracklists) if `trackUrl` is set, else nothing.
     - **Visual state**: rows with `isCurrent: true` highlight (background tint or bold). Rows with `isUnidentified: true` greyed out and not tappable.
   - **Item tap precedence**: `Browse URL` to the first non-null of `appleLink`, then `youtubeLink`, then `trackUrl`. Skip if all three are null.

   The response always carries up to three groups (previous, current, next) so the user can disambiguate transitions and peek ahead. `isCurrent` is `true` only on the current group's members. Edge cases the response handles automatically: at the start of the set there's no previous; at the end there's no next; before any cued track the response is just `[firstCuedGroup]` with all `isCurrent: false` ("next up").

7. **Network error** (the Off-error branch from step 4)
   - `Flash`: "Network error".

## Tips

- **Trigger**: bind this task to a Tasker widget on your home screen, or to a Quick Settings tile, or to an AutoNotification persistent control button — whichever flow feels least intrusive while listening.
- **Polling vs. on-demand**: don't set this on a timer. The Worker caches the YouTube → tracklist mapping and the parsed tracks for 2 hours each (per-track Apple/YouTube links and the iTunes fallback have much longer TTLs since track ↔ deep-link mappings are essentially immutable). Even with caching, every fresh poll still risks tripping 1001tracklists' per-IP rate-limit upstream. Tap-to-resolve only when you actually care about a track.
- **Token rotation**: if you ever roll `API_TOKEN` (Worker secret), update `%TRACKED_TOKEN` once in Tasker — the rest works unchanged.
