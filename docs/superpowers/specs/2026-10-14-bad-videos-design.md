# Bad videos: uploader channels, ban questions, strikes, portrait rule

Date: 2026-10-14. Status: decisions locked by the owner (Max) in the quest
interview; this spec settles the remaining design. Path: architectural (new
tables, a new tab, a change to how the sync picks a set's video).

## Problem

Fan phone recordings of sets (blown-out mic, clipped bass, crowd noise) still
reach the managed playlists, and Max removes them by hand. The good videos are
official recordings by the DJ, label, venue or event. Views, subscriber counts
and channel names are not usable signals. Allowed: prior removals from the
same channel, duration rules, orientation.

## What the owner decided (locked)

1. Store the uploader channel (id + title) of videos and of removals. Backfill
   from the 6-hourly playlist listings and the video lookups already made.
2. A channel ban is asked per removal, never automatic. An owner removal
   (found by the comparison) or the Remove & replace button creates a pending
   "ban this channel?" question listing that channel's other videos in the
   managed playlists. Shown three ways: Web Push, a Home card, a new Bans tab
   (pending questions, banned channels with Lift ban).
   - Ban: never pick the channel's videos again anywhere; its videos in every
     managed playlist (artist and combined) are swapped for the next-best
     passing video, or removed if none, through the existing sweep (daily
     budget, dry-run setting), undoable from /ui/removed.
   - Not banned: recorded; not asked again for that channel unless a further
     removal happens, then asked again showing the strike count.
3. Strikes: a channel Max removed a video from before (banned or not) is
   skipped when another candidate passes the rules; if it is the only passing
   candidate it may still be used.
4. Portrait: verify the orientation signal live, switch signals if wrong, turn
   the vertical rule on by default, dry-run the sweep and report; the live run
   is left to the orchestrator.
5. Existing rules stay (last cue, audio player longer, notice). No view,
   subscriber or channel-name filters.

## Findings that shape the design

- **Orientation signal is right.** videos.list `player.embedWidth/Height` with
  `maxWidth=1280` follows the aspect ratio: five known Shorts (YouTube and
  MrBeast channels) return 1280x2276; three 16:9 videos return 1280x720.
  oEmbed returns 200x113 for every video, Shorts included: useless. 17 rows of
  prod `video_meta` are portrait long-form phone videos (1280x2276, 18 to 114
  minutes), 13 of them already removed by the live sweep. `isVertical` stays;
  the TODO goes.
- **Prod already has `playlists.rejectVertical: true`** and a live sweep
  (13 vertical, 217 notice, 25 short, 6 audio_longer removals). "On by
  default" therefore changes the code default only.
- **Set pages can carry more than one recording.** Of 214 stored set pages
  (2026-10-12/13), 110 had no YouTube player, 95 one, 9 two
  (`<div id="ytWidget_<id>">`). The pairs are exactly the case this quest is
  about: e.g. Adam Beyer at Time Warp as `drumcodeofficial` vs `Time Warp`,
  EPTIC B2B Space Laces as two fan uploads. Today only the first is ever
  considered. So "candidates" are the page's players, in page order.

## Design

### Data (migration 0022_channel_bans.sql)

- `video_meta` + `channel_id`, `channel_title` (videos.list adds `snippet`; the
  call stays 1 unit per 50 ids).
- `removed_videos` + `channel_id`, `channel_title`, `ban_noted INTEGER NOT NULL
DEFAULT 0` (0 = an owner/button removal the ban queue has not looked at).
- `channel_bans (channel_id PK, channel_title, state, strikes, last_video_id,
last_playlist_id, last_slug, last_set_url, last_removal_at, asked_at,
decided_at, notified)`; `state` is `pending | banned | declined | lifted`.
  The "other videos" list is computed when read, never stored.

Strikes of a channel = `COUNT(DISTINCT video_id)` of `removed_videos` rows with
reason `owner` or `button` and that channel (one video taken from the artist
and the combined playlist is one strike). `dead` never counts, nor does the
sweep (it never writes `removed_videos`).

### Channels (lib/video-meta.ts, lib/channel-bans.ts)

- `fetchVideoMeta` asks for `snippet` and fills `channelId`/`channelTitle`.
  `saveVideoMeta` keeps a known channel when a later answer has none
  (`COALESCE`).
- `saveVideoChannels(env, [{videoId, channelId, channelTitle}])` writes only the
  channel columns; a video with no row gets one with `fetched_at = 0`, so it is
  stale for every reader that cares about duration and never mistaken for a
  fresh lookup.
- `comparePlaylists` hands every complete listing's
  `snippet.videoOwnerChannelId/Title` to `saveVideoChannels` (no extra call).
- `getVideoMeta` treats a cached alive row without a channel as stale, so the
  next lookup that would have used it fills the channel. The comparison runs
  before the sweep in the same tick and fills channels of everything in a
  playlist from its listings first, so in practice this re-reads only videos
  that are in no playlist.
- Past removals: the ban queue looks up (videos.list, at most 50 ids, 1 unit)
  removed videos whose channel is unknown and that were not looked up in the
  last 7 days. Dead ones come back without a channel and are left alone.

### The ban queue (lib/channel-bans.ts)

`processBanQueue(env, {log, accessToken?, notify?})`, run after every
comparison and after Remove & replace:

1. Copy channels from `video_meta` onto `removed_videos` rows that lack one;
   look up the rest (above) when a token is at hand.
2. For each channel with `ban_noted = 0` owner/button rows: no `channel_bans`
   row, or `declined`/`lifted` -> `pending` with the strike count, the newest
   removal, `asked_at = now`, `notified = 0`. Already `pending` -> strike count
   and newest removal updated (not pushed again). `banned` -> nothing. Then
   the rows are marked `ban_noted = 1`.
3. Pending questions with `notified = 0` are pushed in one Web Push (kind
   `channel_ban`, url `/ui/bans`, the newest removed video's thumbnail);
   `notified = 1` only when a device took it, else the next run tries again.

Past removals (before this ships) go through the same queue once their channel
is known: 11 owner removals in prod, so at most a handful of questions.

Decisions (`banChannel`, `declineChannel`, `liftBan`): set the state and
`decided_at`. A ban also clears the sweep's last-run time
(`hygiene:last_sweep`) so the next 5-minute cron tick runs the sweep instead of
waiting up to 6 hours. Banning works from `pending`, `declined` or `lifted`; a
lift works from `banned` and leaves the channel `lifted` (asked again on the
next removal, like `declined`).

### Enforcement (lib/playlist-hygiene.ts)

- `judgeVideo` rejects a video whose channel is banned (reason
  `banned_channel`, before the full-recording rules; after `dead`).
  `JudgeOptions.bannedChannels` is loaded by `judgeOptions(env)`, so the sync
  (`pickSetVideo`), the sweep and `hasGoodVideo` all apply it. The sweep merges
  channels from `video_meta` into the meta it judges.
- The sweep then does the rest with its existing rails: removal from the
  artist and combined playlists (B1 keep-if-shared is unaffected: one video,
  one channel), daily budget, dry run, `playlist_removals` rows undoable from
  /ui/removed (undo = `video_overrides`, which exempts that one video from the
  ban as from every rule). The sweep clears the set's video and makes it due:
  its recheck picks the next-best passing candidate from the page, or none,
  which queues the set for mkvid. That is the "swap".
- `pickSetVideo` judges every candidate (`parseSetYouTubeIds`: the primary id
  `parseSetYouTubeId` finds, then the other `ytWidget_` players in page order)
  with one videos.list call. Order of choice:
  1. passing candidates whose channel has no strikes, in page order;
  2. else passing candidates with strikes, fewest strikes first, then page
     order (tie-break: the channel Max has objected to least).
     A rejected primary with a passing second player now yields the second one
     instead of no video. When the page is not at hand (an insert that waited for
     quota), only the stored id is judged, as today.
- The recheck's existing swap branch ("swapped recording: out with the old, in
  with the new") already replaces a set's video when the pick changes, so a
  struck primary with a clean second player is swapped at the set's next
  recheck with no new code path. The sweep itself never swaps on strikes (it
  cannot read the page); only bans reach it.

### Portrait default

`playlists.rejectVertical` defaults to `true` (schema stays nullable: null =
`REJECT_VERTICAL`, which is now ON unless set to 0/false/no/off). Prod's stored
`true` is unchanged.

### UI

- Sidebar: `Bans` (icon `ban`) in Library after Removed videos, `/ui/bans`.
- Bans page: pending questions as cards (channel link, strikes, the removed
  video and its set, the channel's other videos in managed playlists, Ban /
  Not banned buttons); then a table of decided channels (banned, not banned,
  lifted) with Lift ban or Ban. Pending is `warn` (a decision to make, nothing
  broken); banned is neutral. No `title=` attributes (data-tip), ASCII only.
- Home: a card above Needs attention, shown only when questions are pending,
  linking each to /ui/bans.
- API (Access-gated, in routes/playlist-hygiene.ts): `GET /ui/api/bans`,
  `POST /ui/api/bans/:channelId/ban | decline | lift`.

### Errors and guards

- Every ban-queue step is best effort inside the comparison: a failure is
  logged and never fails the comparison or the button.
- A missing `channel_bans` table (migration not applied yet) reads as "no
  bans" in `judgeOptions`.
- No channel id = no strike, no ban, no question (unknown never rejects).

## Testing

vitest, fake D1 with real migrations: `fetchVideoMeta` snippet parsing and the
channel-keeping upsert; `saveVideoChannels`; stale-without-channel;
`parseSetYouTubeIds`; `judgeVideo` banned reason; `pickSetVideo` candidate
order (strikes, fewest strikes, second player); `processBanQueue` (new,
pending update, declined then a new removal asks again with strikes, banned
ignored, push once, retry when not delivered); compare -> question end to end;
sweep removing a banned channel's videos; routes; Bans page and Home card in
test/ui-pages.test.ts; migration on prod-shaped data.

## Combined-playlist orphans (added after the dry run)

The read-only dry run (2026-10-14) found no sweep candidate left to reject:
the live sweep had already taken the portrait videos out of the artist
playlists. Two portrait fan recordings were still in the combined playlist,
where nothing looks at them again, because no `tracklists` row points at them:

- `lLiclA_GCEQ` (Knock2, Ultra Taiwan, 1280x2276): the sweep removed it from
  the artist playlist, then its combined delete failed (the 2026-10-08 OAuth
  401 incident), and clearing the set made it invisible to every later sweep.
- `gX0uFq9hv_E` (Mau P, 1280x2276): the owner removed it from the artist
  playlist by hand; removals are per playlist, so it stayed in the combined one.

So the sweep also judges the combined playlist's orphans (in its last complete
listing, referenced by no set, not mkvid's, not kept, not already taken out by
tracked) by the rules that need no set page: vertical and banned channel. Same
dry run, budget and log rows (`playlist_kind = combined`, no set), undoable.

## Out of scope

- The sweep does not swap on strikes alone (only on a ban).
- Videos the owner added by hand to an artist playlist (in no `tracklists`
  row) are not swept; the sync never picks a banned channel's video anyway.
