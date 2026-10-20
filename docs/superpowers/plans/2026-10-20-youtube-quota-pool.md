# YouTube Quota Pool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every OAuth YouTube call tracked makes draws from the general quota of all
connected Google projects on the owner's channel. Each kind of work spends in the
owner's order. The owner manages it from one page. A new "Pre-saves" playlist
holds every pre-save that has a video.

**Architecture:** mkvid pushes short-lived access tokens for its projects to
tracked every poll.

tracked's `youtube-pool.ts`:

- keeps those tokens, a per-project ledger (D1) and per-project out flags (KV);
- picks the project with the most left.

Two existing choke points carry the pool to all 26 call sites without touching them:

- `getAccessToken` hands out the picked project's token.
- `authedFetch` records spend, marks a project out on a quota reply, and resends
  that one request on the next project.

Ranking (`quota-priority.ts`) gates each consumer before it spends. The page
`/ui/quota` edits the ranking.

**Tech Stack:** Cloudflare Worker (Hono, D1, KV), vitest with the D1/KV fakes;
mkvid (Node, better-sqlite3, vitest).

**Spec:** `docs/superpowers/specs/2026-10-20-youtube-quota-pool-design.md`

## Global Constraints

- ASCII only in code, docs, commits and logs (`node scripts/check-ascii.mjs`).
- Prettier and ESLint clean. Conventional commits. Direct push to main.
- A D1 migration is applied with `npm run d1:migrate` (retry on 7403) before
  pushing code that needs it.
- Tokens are never logged.
- Refresh tokens and client secrets never leave mkvid.
- The quota day is Pacific (`quotaDayStart` / `quotaDayEnd` in src/lib/mkvid.ts).
- Unit costs:
  - list/read: 1
  - insert/update/delete/rate: 50
  - playlists.insert: 50
  - search: 100
  - a removal is counted as 51 (list + delete)
- Margin default: 300. Project budget default: 10,000.
- Owner order: likes 1; pre-save playlists 2; DJ playlists 3; hygiene 4; mkvid
  set uploads 5 (no pool spend); mkvid gone/recreate 6; combined 7; renames 8;
  ordering 9; owner actions above all.
- Statuses never red except "not connected" for the token source, which is a
  warning (feedback: red means action).
- mkvid's `quota_out:<key>` is an upload-bucket flag. It never removes a
  project from the push.

## Review Focus

- **An expired or revoked pushed token:** the 401 retry must drop it and use
  another project, never loop on it or clear tracked's own tokens (Task 2).
- **A quota reply on a POST playlistItems insert:** the retry on the next
  project must first check whether the video is already in the playlist, so no
  set lands twice (Task 2).
- **The legacy `yt:quota:out` flag present at deploy:** it must stop blocking
  callers when other projects have room (Task 1).
- **mkvid stops polling:** pushed tokens expire, and the pool silently becomes
  tracked-youtube only (Task 1).
- **A pushed token for a different channel:** it is rejected and never used
  (Task 3).

---

## Phase 1 - the pool (ship first)

### Task 1: Pool store, ledger, out flags, picking

**Files:**

- Create: `migrations/0031_youtube_quota_ledger.sql`
- Create: `src/lib/youtube-pool.ts`
- Modify: `src/lib/youtube-quota.ts`. `getQuotaOut` means "the whole pool is
  out"; `noteQuotaOut` sets the global flag only when `poolOut`.
- Test: `test/youtube-pool.test.ts`

**Migration:** `youtube_quota_ledger(day INTEGER NOT NULL, project TEXT NOT NULL,
consumer TEXT NOT NULL, units INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL
DEFAULT 0, PRIMARY KEY (day, project, consumer))`. `day` = `quotaDayStart` in
unix seconds.

**Interfaces (produces):**

- `export const OWN_PROJECT = "shared"`. This is mkvid's key for tracked-youtube.
  - Labels: `{ shared: "tracked-youtube", primary: "mkvid-uploads" }`.
  - Any other key uses the label mkvid sent.
- `export type PushedToken = { account: string; label: string; channelId: string; accessToken: string; expiresAt: number /* unix s */; unitsToday: number | null }`
- `export async function storePushedTokens(env: Env, list: PushedToken[], ownChannelId: string | null, nowSec?: number): Promise<{ accepted: string[]; rejected: Array<{ account: string; reason: "channel" | "expired" | "own" | "invalid" }> }>`
  - KV `yt:pool:token:<account>`, TTL = expiresAt - now - 300.
  - Also `yt:pool:seen` = the last push's time.
- `export type PoolProject = { key: string; label: string; budget: number; spent: number; mkvidUnits: number; remaining: number; out: { since: number; until: number } | null; hasToken: boolean }`
- `export async function poolProjects(env: Env, nowMs?: number): Promise<PoolProject[]>`
  - Covers the own project plus every key with a live pushed token.
  - `spent` comes from the ledger.
  - `remaining = budget - spent - mkvidUnits`.
- `export async function pickProject(env: Env, opts?: { exclude?: string[]; nowMs?: number }): Promise<{ key: string; accessToken: string | null } | null>`
  - Excludes projects that are out or have no token.
  - Picks the most remaining; the own project wins ties.
  - `accessToken: null` for the own project, meaning "use tracked's stored token".
- `export async function markProjectOut(env: Env, key: string, nowMs?: number): Promise<void>`
  - KV `yt:quota:out:<key>` = `{since, until: quotaDayEnd}`.
- `export async function dropPushedToken(env: Env, key: string): Promise<void>`
- `export async function recordUnits(env: Env, key: string, consumer: string, units: number, nowMs?: number): Promise<void>`: a D1 upsert.
- `export function unitCost(method: string, url: string): number`
- `export async function poolOut(env: Env, nowMs?: number): Promise<boolean>`
  - True when every project is out, or has under `margin` remaining.
  - The margin is a constant 300 until Task 9 makes it a setting.
- Legacy flag: when `yt:quota:out` is set and `poolOut` is false, convert it
  into `yt:quota:out:shared` and delete the global flag. Do this lazily inside
  `poolProjects`.

**Steps:**

- [ ] **Step 1: Write failing tests**
  - `test/youtube-pool.test.ts`:
    - `unitCost("POST", ".../playlistItems?part=snippet")` = 50
    - `unitCost("GET", ".../playlistItems?...")` = 1
    - `unitCost("GET", ".../search?...")` = 100
    - `unitCost("POST", ".../videos/rate?...")` = 50
    - `unitCost("DELETE", ".../playlistItems?id=x")` = 50
  - `storePushedTokens`:
    - accepts the matching channel;
    - rejects another channel ("channel"), `account: "shared"` ("own"), and
      `expiresAt` already past ("expired").
  - `pickProject`:
    - with own spent 9,000 and `upload2` spent 0, it returns `upload2` and its token;
    - with `upload2` marked out, it returns own (`accessToken: null`);
    - with everything out, it returns null.
  - `recordUnits` twice sums (50 + 50 = 100) in `poolProjects().spent`.
  - Legacy flag:
    - with `yt:quota:out` set and a live `upload2` token, `getQuotaOut(env)`
      returns null, and `yt:quota:out:shared` is set;
    - with no pushed token, `getQuotaOut` still returns the flag.
- [ ] **Step 2: Run** `npx vitest run test/youtube-pool.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement the migration and `youtube-pool.ts`, and adapt
      `youtube-quota.ts`.** `getQuotaOut` calls `poolProjects` (which converts the
      legacy flag) and returns the global flag only while `poolOut`.
- [ ] **Step 4: Run** the new test and `test/youtube-quota*.test.ts test/activity-quota.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(youtube-pool): per-project tokens, ledger and out flags`

### Task 2: getAccessToken and authedFetch draw from the pool

**Files:**

- Modify: `src/lib/google-oauth.ts` (`getAccessToken`, `youtubeTokenRefresher`)
- Modify: `src/lib/youtube-playlists.ts` (`authedFetch`, add `setYoutubePool`)
- Modify: `src/index.ts` (`ensureTokenRefresher` installs the pool hooks too)
- Test: `test/youtube-pool-fetch.test.ts`

**Interfaces:**

- Consumes: Task 1.
- Produces:
  - `export type YoutubePoolHooks = { projectOf(token: string): string | null; spent(key: string, units: number): void; quotaOut(key: string): Promise<string | null> /* next token, or null */; rejected(key: string): Promise<void> }`
  - `export function setYoutubePool(h: YoutubePoolHooks | null): void`
  - `export function setQuotaConsumer(key: string | null): void`: the ledger's
    consumer for calls from now on. Module-level; `"unknown"` when unset.
    Task 9 uses it.
- `getAccessToken(env, fetcher, opts)` keeps its return shape
  `{ accessToken, tokens }`. `tokens` is always tracked's own stored set.
  `accessToken` is the token of `pickProject(env)`: the own one when it picks
  `shared`, otherwise the pushed one, remembered in the `projectOf` map.
  - When `opts.rejected` is a pushed token: `dropPushedToken` for it, then pick again.
  - When the pool is out: return the own token (callers keep today's quota handling).

**Behaviour of `authedFetch` after the response:**

- 2xx: `spent(project, unitCost(method, url))`.
- 403 with reason `quotaExceeded` or `dailyLimitExceeded` (read from a clone of
  the body):
  1. `next = await quotaOut(project)`;
  2. if `next`:
     - when the request is POST `/playlistItems`, first GET
       `playlistItems?part=id&playlistId=<body.snippet.playlistId>&videoId=<body.snippet.resourceId.videoId>`
       with `next` (1 unit). If it has items, return a synthetic 200 whose body
       is the first item, without inserting;
     - otherwise resend the same request once with `next`, and set
       `replaced[accessToken] = next`.
- A 401 on a pushed token: the refresher (`youtubeTokenRefresher` -> `getAccessToken({rejected})`) already drops it and picks another.

**Steps:**

- [ ] **Step 1: Write failing tests** (stub `fetch`):
  - A 200 insert with the own token records 50 units on `shared`.
  - A 403 `quotaExceeded` on the own token:
    - `shared` is marked out;
    - the same insert is resent with the `upload2` token, preceded by the
      videoId check GET;
    - 50 units are recorded on `upload2`;
    - the caller gets the 200.
  - When the check GET finds the video: no second insert; the caller gets 200.
  - A 403 `forbidden` (not quota) is returned as-is, without a retry.
  - A 401 on the `upload2` token: the token is dropped, and the next call uses own.
  - `getAccessToken` with own spent 9,900 and `upload2` live returns the
    `upload2` token, and `tokens.channelId` is still own.
- [ ] **Step 2: Run** `npx vitest run test/youtube-pool-fetch.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Install the hooks in `ensureTokenRefresher` (index.ts:71) beside the refresher.
- [ ] **Step 4: Run** the full suite, `npx vitest run`. Expected: PASS. The
      existing auth-401 tests still pass.
- [ ] **Step 5: Commit** `feat(youtube-pool): every OAuth call spills to the project with the most quota left`

### Task 3: tracked accepts mkvid's token push

**Files:**

- Modify: `src/routes/mkvid.ts`:
  - `POST /mkvid/youtube-tokens`, bearer `MKVID_TOKEN`;
  - the health check gains `youtubeTokens: true`.
- Test: `test/mkvid-routes.test.ts` (extend)

**Interfaces:**

- Consumes: `storePushedTokens`.
- Request: `{ tokens: PushedToken[] }`. Response: `{ accepted, rejected }`.
- `ownChannelId` comes from `loadTokens(env)?.channelId`.

**Steps:**

- [ ] **Step 1: Failing tests:**
  - 401 without the bearer;
  - 200 accepts a matching channel;
  - 400 on a body that is not `{tokens: [...]}`;
  - health includes `youtubeTokens: true`;
  - the response body never echoes `accessToken`.
- [ ] **Step 2: Run, FAIL. Step 3: Implement. Step 4: Run, PASS.**
- [ ] **Step 5: Commit** `feat(mkvid): accept pushed YouTube tokens for the quota pool`

### Task 4: Phase-1 guard: ordering and the combined backfill yield to waiting sets

**Files:**

- Create: `src/lib/quota-waiting.ts`
- Modify: `src/index.ts`. Before the combined backfill (:327) and the reorder
  pass (:350), skip when `djInsertsWaiting > 0` (log
  `cron.yielded_to_sync`).
- Test: `test/quota-waiting.test.ts`

**Interfaces:**

- Produces: `export async function djInsertsWaiting(env: Env): Promise<number>`.
  It counts:
  - `tracklists` rows with `processed = 0 AND abandoned = 0 AND video_id IS NOT NULL`
    whose slug is in `subscriptions`;
  - plus `mkvid_requests` rows with `playlist_status = 'pending'`.
- Task 9 extends this file with the other consumers' waiting counts.

**Steps:**

- [ ] **Step 1:** A failing test: the count includes those rows, and leaves out
      an abandoned row and an unsubscribed DJ's row.
- [ ] **Steps 2-4:** run, implement, run.
- [ ] **Step 5: Commit** `feat(quota): ordering and the combined backfill wait while sets wait to be added`

### Task 5: mkvid pushes its tokens every poll

**Repo:** `C:\Users\pmaxh\Documents\node-projects\mkvid`

**Files:**

- Modify: `src/lib/tracked.ts`:
  - `TrackedHealth.youtubeTokens?: boolean`;
  - client `pushYoutubeTokens(tokens)` -> `POST /mkvid/youtube-tokens`;
  - in `pollTracked`, after the claim, push when health says `youtubeTokens`
    (cached like `uploadProjects`).
- Create: `src/lib/youtube-units.ts`: per-project general-pool unit counter,
  sqlite table `youtube_units(day INTEGER, account TEXT, units INTEGER, PRIMARY KEY(day, account))`,
  Pacific day.
- Modify: mkvid's YouTube calls that are not uploads, to add their units:
  - the playlist insert, pipeline.ts:598;
  - `videos.delete`, youtube.ts:313;
  - the description backfill's `videos.update`.
- Test: `test/tracked-token-push.test.ts`

**Interfaces:**

- Push body:
  `{ tokens: [{ account, label, channelId, accessToken, expiresAt /* unix s */, unitsToday }] }`.
  - One entry per connected account except `shared`, whether or not it has an
    upload `quota_out`.
  - Each token is made valid for at least 15 minutes with
    `getValidAccessToken(store, cfg, { minValidMs: 15 * 60_000 })`.

**Steps:**

- [ ] **Step 1: Failing tests:**
  - the push lists `primary` and `upload2`, not `shared`;
  - an account with `quota_out:upload2` set is still pushed;
  - with no `youtubeTokens` in health, nothing is pushed;
  - `unitsToday` sums the counter for today;
  - the push never throws into the poll loop.
- [ ] **Steps 2-4:** run (`npx vitest run test/tracked-token-push.test.ts`), implement, run the full suite.
- [ ] **Step 5: Commit** `feat(tracked): push short-lived YouTube tokens for the quota pool every poll`

### Task 6: Ship phase 1 and clear the backlog

- [ ] Apply migration 0031 (`npm run d1:migrate`), then push tracked. Wait for
      the green check plus the Workers Build.
- [ ] Push mkvid. Watchtower redeploys in about 2 minutes. Check
      `docker logs mkvid` for the push succeeding.
- [ ] **Verify in prod:**
  - KV has `yt:pool:token:primary` and `yt:pool:token:upload2`;
  - `getQuotaOut` is null;
  - the next ticks insert the deferred sets (no D1 rows left with
    `processed = 0 AND video_id IS NOT NULL` for subscribed DJs) and create the
    new playlist;
  - the ledger shows units on `primary` or `upload2`;
  - no duplicate video in the affected DJ playlists.

## Phase 1b - the Pre-saves playlist

### Task 7: Pre-saves playlist, insert on resolve, backfill

**Files:**

- Create: `migrations/0032_presave_playlist.sql`:
  - `presaves` gains `presave_playlist_status TEXT` (null | `pending` | `added` | `failed`),
    `presave_playlist_item_id TEXT`, `presave_playlist_next_at INTEGER`
    and `presave_playlist_error TEXT`;
  - backfill: `UPDATE presaves SET presave_playlist_status = 'pending', presave_playlist_next_at = 0 WHERE youtube_video_id IS NOT NULL`.
- Create: `src/lib/presave-playlist.ts`
- Modify: `src/lib/presave-like.ts` `onPresaveResolved` also marks the pre-save
  `pending`, with `next_at` = now.
- Modify: `src/lib/app-settings.ts` `presave.playlistTitle` (default
  "Pre-saves"), `presave.playlistPrivacy` (default "unlisted"); and
  `src/ui/pages/settings.ts` fields for both.
- Modify: `src/index.ts`: cron step `retryDuePresavePlaylist(env, log)` right
  after the pre-save likes (:339).
- Test: `test/presave-playlist.test.ts`

**Interfaces:**

- `export async function retryDuePresavePlaylist(env: Env, log: Logger, opts?: { limit?: number /* default 10 */; nowMs?: number }): Promise<{ added: number; skipped: number; failed: number }>`
  - Due rows oldest first (`created_at`).
  - Resolves the playlist by title, creating it when missing via
    `findOrCreatePlaylist`, with the playlist id cached in KV
    `presave:playlist_id`.
  - Lists the playlist once per run (cached) and skips videos already in it,
    marking them `added`.
  - Inserts at the end.
  - On a quota error: `next_at = quotaDayEnd`.
  - On another error: backoff 1 h x attempts; `failed` after 5.
- `onPresaveResolved` only queues; the insert happens in the cron (one place, ranked).

**Steps:**

- [ ] **Step 1: Failing tests:**
  - the migration marks existing pre-saves with a video `pending`;
  - a run creates the "Pre-saves" playlist once and adds two due videos oldest first;
  - a video already in the playlist is marked `added` without an insert;
  - a quota error pushes `next_at` to `quotaDayEnd`;
  - `limit` is respected;
  - a newly resolved pre-save is queued.
- [ ] **Steps 2-4:** run, implement, run the full suite.
- [ ] **Step 5:** Apply 0032 with `npm run d1:migrate`, then commit and push:
      `feat(presave): every pre-save with a video goes into a Pre-saves playlist, existing ones backfilled`.
- [ ] **Step 6: Verify in prod:** the playlist exists, and the backfill count
      drops each tick.

## Phase 2 - ranking

### Task 8: Quota settings and consumers

**Files:**

- Modify: `src/lib/app-settings.ts`: new group `quota`:
  - `order: string[]` (consumer keys), default
    `["likes","presave_playlists","dj_playlists","hygiene","mkvid_uploads","mkvid_recreate","combined","renames","ordering"]`;
  - `margin: number` (default 300, 0-5000);
  - `projectBudget: number` (default 10000);
  - `consumers: Record<string, { min: number | null; max: number | null; enabled: boolean }>`.
  - Migration of old caps on first read:
    - `consumers.ordering.max` = live `playlists.orderDailyUnits` (0 -> `enabled: false`);
    - `consumers.combined.max` = `combinedDailyInsertCap x 50`;
    - `consumers.hygiene.max` = resolved `sweepDailyRemovals` (setting, else env
      `PLAYLIST_SWEEP_DAILY_REMOVALS`, else 40) x 51;
    - `consumers.likes.max` = `presave.likeDailyUnitCap`.
- Create: `src/lib/quota-consumers.ts`:
  `export const QUOTA_CONSUMERS: ReadonlyArray<{ key: string; label: string; description: string; perAction: string; waitingCost: number | null }>`,
  with the copy from the spec's table.
- Test: `test/quota-settings.test.ts`, covering defaults and each migration rule
  (ordering 8000 -> max 8000; 0 -> off; combined 80 -> 4000; sweep null + env
  25 -> 1275).

**Steps:**

- [ ] **Steps 1-4:** write the failing test, run it (FAIL), implement, run it (PASS).
- [ ] **Step 5: Commit** `feat(quota): one settings group for the quota order, limits and margin`

### Task 9: The rule, wired into every consumer

**Files:**

- Modify: `src/lib/quota-waiting.ts`:
  `export async function waitingDemand(env: Env): Promise<Record<string, number /* units */>>`.
  - Per consumer:
    - likes: due likes x 51;
    - presave_playlists: due Pre-saves rows x 50, plus due track-upload inserts x 50;
    - dj_playlists: the Task 4 count x 50 (the DJ insert only; the combined
      insert is consumer `combined`);
    - every other consumer: 0.
  - Cached in CACHE for 240 s.
- Create: `src/lib/quota-priority.ts`:
  - `export async function quotaGate(env: Env, consumer: string, units: number, nowMs?: number): Promise<{ ok: true } | { ok: false; reason: "held" | "max" | "off" | "pool_out" }>`
    - Applies the spec's rule.
    - `consumer === "owner"` is always ok (unless `pool_out`).
    - On ok it calls `setQuotaConsumer(consumer)`.
  - `export async function consumerStatus(env: Env): Promise<Array<{ key: string; status: "running" | "held" | "max" | "pool_out" | "off"; spentToday: number; waiting: number }>>`
    for the page.
- Modify each consumer's entry so it calls `quotaGate` before spending, and
  stops when refused (leaving its work queued):
  - sync insert and create, sync.ts:1287 and :862: consumer `dj_playlists`, 50 per insert;
  - mkvid set playlist insert, mkvid-playlist.ts:294: `dj_playlists`;
  - track-upload playlist insert, track-uploads.ts:1080 / :1006: `presave_playlists`;
  - Pre-saves playlist: `presave_playlists`;
  - likes, presave-like.ts:307: `likes`, 51;
  - hygiene compare and sweep, playlist-hygiene.ts:2155 and :832: `hygiene`;
  - gone check, mkvid-recreate.ts:866: `mkvid_recreate`;
  - combined backfill and mirror: `combined`;
  - rename: `renames`;
  - reorder: `ordering`;
  - UI-initiated routes (likes button, undo, replace, manual sync, rename):
    `owner`.
  - The old cap checks are replaced by the consumer's `max`.
  - Remove the Task 4 guard; the rule subsumes it.
- Test: `test/quota-priority.test.ts`:
  - ordering is refused while `dj_playlists` waits more than remaining - margin,
    and allowed once it fits;
  - `min` counts as waiting until spent;
  - `max` refuses;
  - `owner` is always ok;
  - `off` refuses;
  - a refused sync insert stays deferred (row unchanged);
  - the example from the spec: 12 sets waiting = 600 units held for `dj_playlists`.
- [ ] **Steps 1-4:** test, fail, implement, full suite.
- [ ] **Step 5: Commit** `feat(quota): every consumer spends in the owner's order`

## Phase 3 - the page

### Task 10: `/ui/quota`

**Files:**

- Create: `src/ui/pages/quota.ts` (shell page with the nav key `quota`, under
  the group "Pool" or Settings: a link from Settings, the Scheduler and the
  Playlists set-date card)
- Create: `src/routes/quota-ui.ts`, mounted in subscriptions.ts:
  - `GET /ui/quota`
  - `GET /ui/api/quota` -> `{ pool: PoolProject[], resetsAt, margin, consumers: (QUOTA_CONSUMERS + settings + consumerStatus)[], outside: { uploads: per-project used/100 + claim caps, apiKeyReads: "unknown project" }, tokenSource: { lastPushAt } }`
  - `PUT /ui/api/quota` saves `{ order, margin, projectBudget, consumers }`
    through `updateAppSettings`
  - `POST /ui/api/quota/projects/:key/clear`
- Modify:
  - `src/ui/pages/settings.ts`: remove `orderDailyUnits`,
    `combinedDailyInsertCap`, `sweepDailyRemovals` and `likeDailyUnitCap`; add
    a link "YouTube quota" to each group;
  - `src/ui/pages/scheduler.ts`: the quota notice links to `/ui/quota`;
  - `src/ui/pages/playlists.ts`: the set-date card links to `/ui/quota`.
- Test: `test/quota-page.test.ts`:
  - rows render in order;
  - up/down posts the new order;
  - statuses use classes `info`/`warn`, never `bad`, except a token source
    silent for more than 10 min shows `warn`;
  - the PUT round-trips.
- Copy, from the spec:
  - the header sentence: "Each item spends only what is left after the waiting
    work of everything above it."
  - the statuses: "running", "held for higher priority", "at its daily limit",
    "waiting for the quota reset", "off".
- [ ] **Steps 1-4:** test, fail, implement, full suite.
- [ ] **Step 5:** Commit and push. Verify the page in prod via the Access-gated
      UI (the owner's browser).
