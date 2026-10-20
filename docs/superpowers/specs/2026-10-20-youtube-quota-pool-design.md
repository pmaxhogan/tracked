# YouTube quota pool and priorities

Status: draft for the owner's approval (2026-10-20). Nothing here is built yet.

## Why

On 2026-10-20 tracked's Google project (tracked-youtube) ran out of its 10,000
daily YouTube units at 09:37 Pacific. 12 new sets could not be added to their
DJ playlists and a new DJ playlist could not be created until midnight Pacific.
Meanwhile mkvid's two other projects, mkvid-uploads and upload2, had spent almost
none of their own 10,000 units each.

Since September 2026 YouTube meters uploads (`videos.insert`) in a bucket of
their own: 100 a day per project, outside the 10,000-unit general pool
(src/lib/mkvid.ts:89-114). So every one of mkvid's projects has a general pool
that is almost idle. All of them hold a token with the `youtube` scope for the
same channel as tracked: Belsi, `UC7Z5L6e0k6bzMG2nMejpZqQ`, checked
2026-10-20.

The owner wants two things:

- the important work (pre-saves, new DJ playlists, adding videos to them)
  always goes first;
- the quota that exists is actually used, not walled off "just in case" and
  then wasted at midnight.

## Goals

1. **One pool.** Every YouTube call tracked makes with OAuth draws from the
   general pools of all connected projects on the owner's channel:
   tracked-youtube plus mkvid's connected projects (today `primary` =
   mkvid-uploads and `upload2`). That is about 30,000 units a day.
2. **Ranked consumers.** A consumer spends only what is left after every
   higher-ranked consumer's work that is waiting right now, plus a small
   margin. There is no fixed reserve unless the owner sets one.
3. **One page** shows the pool and every consumer: rank, today's spend, what
   it is waiting on, and its status. The owner can reorder them and give any
   one an optional minimum ("keep at least") and maximum ("at most a day").
4. **Set-date ordering waits for the sync** (and for everything above it).
   This follows from goal 2 because ordering is ranked last.
5. **Today's backlog** (the deferred inserts and the new playlist) clears as
   soon as phase 1 ships.

## Non-goals

- Raising Google's quota, or adding new Google projects. The pool takes any
  project mkvid connects later automatically.
- Changing how uploads are metered or claimed. Upload counts (mkvid claim
  caps, `trackUploads.dailyCap`) stay as they are; the page shows them.
- Pooling the API-key reads (`YOUTUBE_API_KEY`: now-playing search at 100 each,
  videos.list for set details and pre-save matches). Which project that key
  belongs to is unknown. The page lists these as "outside the pool".

## Anti-goals (a failure even if it works)

- Quota that sits reserved and unused at midnight while lower work waited.
- Long-lived credentials (refresh tokens, client secrets) leaving mkvid.
- A set inserted twice because a retry on another project repeated a write
  that had in fact gone through.
- A page where the owner must tune numbers before the basics work. The
  defaults must be right with every minimum and maximum left blank, except
  ordering's existing cap.
- Red error states for what is only waiting its turn ("held for higher
  priority" and "waiting for the quota reset" are information, not problems;
  see the project's red-means-action rule).

## The pool

### Where the tokens come from

- **tracked-youtube:** tracked's own OAuth token (`getAccessToken`,
  src/lib/google-oauth.ts:196). Unchanged.
- **mkvid's other projects:** mkvid pushes short-lived access tokens to tracked.
  - On every poll (`claimOffer`, mkvid src/lib/tracked.ts:580; every 60 s), mkvid
    sends `POST /mkvid/youtube-tokens` (bearer `MKVID_TOKEN`) with, for each
    connected project, `{ account, project label, channelId, accessToken,
expiresAt, unitsToday }`.
  - mkvid refreshes a token first when it has less than 15 minutes left
    (`getValidAccessToken`, mkvid src/lib/google-oauth.ts:76).
  - It leaves out `shared`, which is tracked-youtube itself.
    - It does **not** leave out a project it has marked `quota_out:<key>`. That flag
      is set by an upload failure (pipeline.ts:582): the 100-a-day upload bucket
      ran out, not the general pool. A project out of uploads still lends its
      general pool. tracked keeps its own general-pool out flags (below).
  - `unitsToday` is mkvid's own general-pool spend on that project today.
    mkvid counts every non-upload call it makes, per Pacific quota day:
    - its playlist insert into `YOUTUBE_PLAYLIST_ID` (pipeline.ts:598);
    - `videos.delete` (youtube.ts:313);
    - the description backfill's `videos.update` (lib/description-backfill.ts;
      up to 7,600 units a day per project when it runs).
      The backfill keeps its own budget. It only reports its spend, so the pool
      sees it.
- **On receipt, tracked:**
  - accepts a token only when its `channelId` equals the channel of tracked's
    own connection;
  - keeps it in CACHE KV until 5 minutes before it expires. tracked's own token
    stays where it is (SUBS `oauth:google`);
  - never logs it.
- **When a pushed token is rejected** (401), tracked drops it and moves to
  another project; it cannot refresh it, and the next push replaces it. About 19
  call sites retry a 401 with `getAccessToken(..., { rejected })`. For a pushed
  token that retry means "drop it and pick again".
- **When mkvid stops polling,** the pushed tokens simply expire, and the pool
  falls back to tracked-youtube alone. The page shows "mkvid's projects:
  not connected (last seen <time>)" as a warning, not as red.

### The ledger

- tracked counts the units it spends, per project per Pacific quota day, from
  a cost table: list/read 1, insert/update/delete/rate 50, playlists.insert 50,
  search 100.
- The counting happens in one place: the YouTube call wrapper the pool hands
  out (youtube-playlists.ts and youtube-likes.ts already funnel through a few
  helpers). It is kept in D1 (`youtube_quota_ledger(day, project, consumer,
units)`) so the page can show spend by consumer.
- A project's remaining today = its budget (10,000 by default, editable per
  project on the page) - tracked's units on it - mkvid's `unitsToday` on it.
- **Out flags are per project:** `yt:quota:out:<project>` until midnight Pacific.
  The KV flag `yt:quota:out` keeps its meaning of "the whole pool is out", so
  existing checks of `getQuotaOut` keep working. It is set only when every
  project is out.
- The ledger is an estimate. A real quota reply from Google always wins:
  that project is marked out, whatever the ledger says.

### Picking a project

- A consumer asks the pool for `units` on its own behalf. The pool:
  1. applies the priority rule (below);
  2. then picks the project with the most remaining (tracked-youtube on a tie);
  3. hands back `{ token, project }`.
- On a daily-quota reply, the project is marked out, and the one refused HTTP
  request (never a whole multi-step operation such as a recheck swap's
  delete + insert) is sent once more on the next project. The steps that
  already succeeded are not repeated.
  - Assumed, not verified against Google documentation: a call refused for
    quota did nothing.
  - The builder adds a duplicate guard to the insert retry: before the retry,
    list the target playlist and skip the insert if the video is already in it
    (1 unit).
  - Any other error is not retried on another project.
- Rate-limit replies (per minute) behave as today: that run stops its writes.

## Consumers and their ranks

The order below is the owner's. "Waiting" is the work queued right now, which
is what higher-ranked work holds back for.

| Rank | Consumer                                   | What it spends                                                 | Waiting now (from)                                                                                                                                                                                                  |
| ---- | ------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Pre-save likes                             | videos.getRating 1 + videos.rate 50                            | `presaves` with a video and a like due (`like_next_at`)                                                                                                                                                             |
| 2    | Ripped pre-saves into "Track uploads"      | playlistItems.insert 50; the playlist's creation 50            | `track_uploads` with `playlist_status` pending or failed and due                                                                                                                                                    |
| 3    | DJ playlists: add videos, create playlists | insert 50; playlists.insert 50 + list 1/page; recheck swaps 51 | `tracklists` with `processed = 0 AND abandoned = 0 AND video_id IS NOT NULL`, for subscribed DJs only (as fetch-scheduler.ts:1231 picks them); `mkvid_requests.playlist_status = 'pending'`; DJs without a playlist |
| 4    | Playlist hygiene                           | comparison reads 1/page; dead-video and sweep removals 51      | planned removals (bounded by `sweepDailyRemovals`)                                                                                                                                                                  |
| 5    | mkvid set uploads                          | upload bucket only (not this pool); shown for reference        | -                                                                                                                                                                                                                   |
| 6    | mkvid gone check and recreate              | videos.list 1; removals 51                                     | due checks                                                                                                                                                                                                          |
| 7    | Combined "all artists" playlist            | insert 50                                                      | videos missing from the combined playlist                                                                                                                                                                           |
| 8    | Playlist renames                           | playlists.list 1, update 50                                    | titles to fix                                                                                                                                                                                                       |
| 9    | Set-date ordering                          | update 50 per move; list 1/page                                | planned moves                                                                                                                                                                                                       |

- **Owner actions** (the like button, undo, remove-and-replace, a manual sync or
  rename from the UI) are ranked above everything. Someone is waiting on them.
  They still count in the ledger.
- **Uploads:** an mkvid set upload or track upload costs nothing from this pool.
  The owner placed set uploads at rank 5; that placement has nothing to gate
  inside the general pool. The video's playlist inserts afterwards are rank 3
  (sets) or rank 2 (pre-saves). The page still shows each project's uploads
  used against its 100 and against the claim caps.
- **Reads inside a consumer** (a list before an insert) count under that consumer.

## The priority rule

A consumer at rank r may spend u units when both hold:

    pool remaining - u >= sum over ranks above r of max(waiting_k, min_k - spent_k) + margin
    spent_r + u <= max_r   (when the owner set a maximum)

- **waiting_k:** the consumer's waiting count x its cost per item.
  - Recomputed at most once per cron tick with cheap COUNT queries, and cached.
  - A consumer whose waiting work is not countable up front (hygiene,
    ordering) counts 0 waiting. Nothing ranks below them except each other.
- **min_k / max_r:** the owner's optional "keep at least" / "at most a day".
  - Blank means none.
  - Ordering's max starts at its current `orderDailyUnits` (8,000).
- **margin:** 300 units by default, editable on the page.
- **Refusals:**
  - A consumer refused by the rule leaves its work queued with the reason
    "held for higher priority".
  - One refused by its own max shows "at its daily limit".
  - When the whole pool is out, it shows "waiting for the quota reset (midnight
    Pacific)". The pool is "out" when every project is flagged out, or when the
    ledger estimates under `margin` left on every project.

**Example** (2026-10-20 had it been in place):

- The pool held about 30,000 units.
- 12 deferred inserts (rank 3) wait at about 1,200 units with the combined mirror.
- Ordering (rank 9) may spend while remaining stays above 1,200 + 300, so it is
  never the reason a set waits.

## The page

**Settings → YouTube quota** (`/ui/quota`), linked from Settings, the
Playlists page's set-date card and the Scheduler page's quota notice.

### Pool header

- **Today's pool:** a bar of spent / remaining across all projects, and "resets
  at midnight Pacific (in 4 h 12 m)".
- **One chip per project:**
  - "tracked-youtube 9,960 of 10,000 - out until 00:00 PT"
  - "mkvid-uploads 140 of 10,000"
  - "upload2 0 of 10,000"
  - a project mkvid stopped pushing: "not connected since 14:02"
  - Each chip has a "Clear" action, which replaces the Scheduler page's single
    "Clear now".
- The margin, editable inline.

### Ranked list

One row per consumer, in rank order. Each row has:

- **Moving it:** up/down buttons; drag on desktop.
- The plain name, and a one-line description of what it does.
- The cost per action ("50 units per video").
- Today's spend in units.
- Waiting now: "12 sets, about 1,200 units", or "-".
- **Status chip:**
  - "running"
  - "held for higher priority"
  - "at its daily limit"
  - "waiting for the quota reset"
  - "off"
- **Expanding the row shows:**
  - "Keep at least ___ units a day"
  - "At most ___ units a day"
  - an On/Off switch
  - for consumers with older settings, the setting it replaced (e.g. "was
    Combined playlist inserts a day: 80").
- Saving reorders and recomputes at once. The page explains the rule in one
  sentence above the list: "Each item spends only what is left after the
  waiting work of everything above it."

### Outside the pool (footer)

- Uploads per project: used / 100 today, plus the claim caps, linking to the
  mkvid settings.
- API-key reads, with today's count when tracked can count them, and a note
  that their project is unknown.

### Settings that move here

- **These become row maxima, migrated with their live values** (read from the
  stored settings, not the code defaults):
  - `playlists.orderDailyUnits` becomes ordering's max: 8,000 live today; the
    code default 0 means "off", not "max 0".
  - `playlists.combinedDailyInsertCap` (80 inserts) becomes the combined max,
    4,000 units.
  - `playlists.sweepDailyRemovals` becomes hygiene's max, at 51 units per
    removal. Its null default resolves the `PLAYLIST_SWEEP_DAILY_REMOVALS` env
    var, else 40.
  - `presave.likeDailyUnitCap` (1,000) becomes the likes max.
- The old fields leave their Settings groups, and each group links here.
- `combinedMaxInsertsPerRun` and `orderMovesPerRun` stay where they are: they
  pace a run, they are not quota.
- The four counters these settings used (some per UTC day, some per Pacific
  day) are replaced by the ledger, which is all Pacific.

## Phasing

1. **Pool (ships first; clears today's backlog).**
   - mkvid pushes its tokens (one mkvid change, deployed by Watchtower in ~2 min),
     with a health flag (`youtubeTokens: true`) as the other claim features
     have, so the two deploys can land in any order.
   - tracked stores them, keeps the ledger and per-project out flags, and picks
     a project per call.
   - **Smallest change that covers every consumer:** `getAccessToken` becomes
     pool-aware and returns the token of the project with the most left. That
     covers the 26 call sites in 18 files at once. The ledger is kept in the
     shared YouTube request helpers. The raw googleapis calls that use the API
     key stay outside the pool.
   - At deploy, a `yt:quota:out` flag set before the deploy is read as
     tracked-youtube's own flag, not "the whole pool". Otherwise every caller
     that checks it (e.g. mkvid-playlist.ts:294) would stay blocked.
   - Existing caps stay as they are; there is no ranking yet. One simple guard
     keeps the backlog first until phase 2: ordering and the combined backfill
     skip a tick while any rank-3 work is waiting.
   - The deferred inserts and the new playlist go in on the next tick after
     tracked-youtube's flag is no longer "whole pool out".
   - Verify in prod: the 12 sets inserted, the new playlist exists, the ledger
     shows the spend on upload2 or mkvid-uploads, and no duplicates.
2. **Ranking.** The waiting counts, the rule, owner actions on top, and the
   statuses.
3. **The page,** and moving the old settings onto it.

## Testing

- **Pool:**
  - token push accepted only for the matching channel;
  - expiry;
  - picking the most-remaining project;
  - a quota reply marks one project and retries once on the next;
  - every project out sets `yt:quota:out`;
  - a non-quota error is never retried on another project.
- **Rule:**
  - a lower consumer refused while higher waiting work would not fit, and
    allowed once it fits;
  - min and max;
  - margin;
  - owner actions always allowed.
- **Migration:** the old settings' values land as maxima.
- **Page:** a vm-run test like the other pages: rows render in rank order,
  reorder posts the new order, statuses read as info (never red) except a
  disconnected token source.

## Calls made by the designer (check these)

- Owner actions skip the ranking rule but never a real out-of-quota reply.
- The API-key reads stay outside the pool for good unless the owner asks.
- mkvid's description backfill reports its spend but keeps its own budget.
- A project out of uploads still lends its general pool.
- Hygiene and ordering count 0 waiting. They hold nothing back for anything
  below them; only ordering is below hygiene's neighbours, and the combined
  playlist and renames are cheap.
- The per-call duplicate guard on an insert retried on another project.
- Push auth reuses `MKVID_TOKEN`.
- Per-project budgets and the margin are app settings shown on the page.

## Left to the builder

- Exact table and KV key names.
- How the waiting COUNTs are cached.
- Drag library or none.
- The wrapper's shape, as long as every OAuth call goes through it.

## Open questions for the owner

1. **There is no "pre-saved playlist" today.** A pre-save that turns up on
   YouTube is only liked (that is what puts it in YouTube Music). Ripped ones
   go into the "Track uploads" playlist. Should every resolved pre-save also
   be added to a "Pre-saves" playlist, at rank 2? This design assumes not:
   rank 2 is the "Track uploads" insert.
