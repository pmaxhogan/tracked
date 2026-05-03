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

   | Status         | UX                                                                                                   |
   | -------------- | ---------------------------------------------------------------------------------------------------- |
   | `ok`           | Build a Scene with `%http_data.tracks` (see step 6).                                                 |
   | `unidentified` | Same Scene, but the row labeled `ID` shouldn't be tappable.                                          |
   | `no_video`     | `Flash` toast: "Couldn't match this video on YouTube".                                               |
   | `no_tracklist` | `Flash` toast: "No tracklist on 1001tracklists for this set".                                        |
   | `upstream_error` | `Flash` toast with `%http_data.message`. Optionally offer a retry via a second tap.               |

6. **Scene: tracklist popup**
   - Use a `ListView` element bound to `%http_data.tracks(:)`.
   - Per-row layout (you can build this with a custom item layout):
     - Title: `%http_data.tracks(:).title`
     - Subtitle: `%http_data.tracks(:).artist` + `  ·  ` + `%http_data.tracks(:).startTime`
     - Right-side icon: ` (Apple) if `%http_data.tracks(:).appleLink` is set, else `▶ ` (YouTube) if `youtubeLink` is set, else nothing.
   - Item tap: `Browse URL` to `%http_data.tracks(arr1).appleLink` (preferred) or `%http_data.tracks(arr1).youtubeLink` (fallback). Skip if both are null.

7. **Network error** (the Off-error branch from step 4)
   - `Flash`: "Network error".

## Tips

- **Trigger**: bind this task to a Tasker widget on your home screen, or to a Quick Settings tile, or to an AutoNotification persistent control button — whichever flow feels least intrusive while listening.
- **Polling vs. on-demand**: don't set this on a timer. The Worker caches results, but each call still hits at least 1001tracklists once per minute or so before the cache warms; tap-to-resolve when you actually care about a track.
- **Token rotation**: if you ever roll `API_TOKEN` (Worker secret), update `%TRACKED_TOKEN` once in Tasker — the rest works unchanged.
