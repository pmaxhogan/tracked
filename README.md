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

`videoTitle` and `videoUrl` are mutually optional but at least one is required (zod-validated). When both are sent, `videoUrl` wins. `videoDurationSeconds` is ignored on the `videoUrl` path (no tie-breaker needed).

Sending `videoTitle` is the robust choice: even if the YouTube Data API can't confidently match the title to a video, the worker still searches 1001tracklists directly by that title, so the tracklist is found as long as 1001tracklists has it. `no_video` / `no_tracklist` responses carry a `message` field describing what happened (whether a video was matched, which searches ran).

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
      "artworkUrl": "https://geo-media.beatport.com/image_size/300x300/abc-def.jpg"
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

`idStatus` (per-track) is `null` for fully-identified tracks. When 1001tracklists marks a row as a partial-ID variant of a known base track ("ID Remix", "ID Edit", "ID Bootleg", "ID Rework", etc.), `idStatus` carries that label, `isUnidentified` stays `false`, and `appleLink` / `youtubeLink` / `trackUrl` describe the **base track** — the actual playing variant may sound different. `isUnidentified: true` is reserved for fully-anonymous tracks (e.g. `"Cave Studio - ID"`); those skip link resolution entirely.

`artworkUrl` is the album art URL, normalized server-side to a square **300×300** for both supported CDNs (Beatport's `image_size/300x300/…` and SoundCloud's `t300x300`). `null` when only 1001tracklists' placeholder was embedded — clients should render their own no-art indicator. Unknown CDNs are passed through unchanged so something is always surfaced when the page has a non-placeholder image.

`durationSeconds` / `durationTime` is the **length the track occupies in this set** (not the studio length): `nextGroupStart − thisGroupStart` for non-last groups, or `videoDurationSeconds − thisGroupStart` for the last group when the caller sent `videoDurationSeconds`. Mashup-linked siblings share the group's window. `null` (and `""` for `durationTime`) when neither input is known or the cue is missing.

When the upstream rate-limits us (1001tracklists per-IP captcha gate), the response is `status: "upstream_error"` with `message: "1001 search: ip_blocked (<ip>)"` (or `1001 scrape: …`) — both the home-IP direct-fetch path and the BrightData unlocker path detect the unblock-form page and surface it cleanly rather than silently degrading to `no_tracklist`.

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
      "isMashupLinked": false
    }
  ]
}
```

Per-track field semantics (`startSeconds`, `trackUrl`, `artworkUrl`, `idStatus`, `isUnidentified`, `isMashupLinked`) are identical to `/now-playing` — see the notes above. Unlike `/now-playing`, this endpoint uses **HTTP status codes** rather than a `status` field: `400` for a bad URL, `401` for a missing/invalid bearer token, and `502 upstream_error` when 1001tracklists rate-limits us (per-IP captcha gate) or the page parses to zero tracks (the fingerprint of a transient captcha that slipped past the block detectors — retry shortly).

OpenAPI spec: `GET /openapi.json` (bearer-gated).

## Subscriptions mini-app

`GET /subscriptions/` is a tiny single-user web UI for managing the list of DJs to track. Paste a 1001tracklists DJ URL like `https://www.1001tracklists.com/dj/lillypalmer/index.html` and only the slug (`lillypalmer`) is stored. Subscriptions live in a separate KV namespace (`SUBS`, no TTL) so they're durable independent of the cache.

The UI is gated by **Cloudflare Access**, not the bearer token used for `/now-playing`. The worker doesn't trust the `Cf-Access-Authenticated-User-Email` header on its own — every `/subscriptions/*` request goes through `cfAccess` middleware that:

1. Reads the `Cf-Access-Jwt-Assertion` header (or `CF_Authorization` cookie).
2. Verifies the RS256 signature against the team's JWKS at `https://<CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` (cached in KV for 1h, refreshed on `kid` mismatch).
3. Validates `iss` matches the team URL, `aud` matches `CF_ACCESS_AUD`, and `exp`/`nbf`/`iat` are in range (60s skew).
4. Checks the `email` claim is in `CF_ACCESS_ALLOWED_EMAILS` (comma-separated).

If any of `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` / `CF_ACCESS_ALLOWED_EMAILS` is unset the middleware **fails closed** (every request 500s) — there's no implicit "open" mode in production. For `wrangler dev` set `DEV_BYPASS_CF_ACCESS=1` in `.dev.vars` to skip verification.

JSON API (also Access-gated):

```
GET  /subscriptions/api/list                      → { subscriptions: [{ slug, sourceUrl, addedAt }] }
POST /subscriptions/api/add    { url: "..." }     → { added: bool, subscription: {...} }
POST /subscriptions/api/remove { slug: "..." }    → { removed: bool }
```

### Tracklist viewer

`GET /subscriptions/tracklist` is a standalone page (linked from the top of the subscriptions page) where you paste a 1001tracklists **tracklist** URL and get a clean per-song list: each row shows the artist – title, cue time, a **YouTube** icon that links straight to the track's video, and an **Apple Music** button, whenever 1001tracklists has those links. It's the browser-facing companion to the bearer-gated `POST /tracklist` API; because the browser only carries the Cloudflare Access cookie (not the bearer token), the page calls its own Access-gated endpoint:

```
GET  /subscriptions/tracklist                     → the viewer page (HTML)
POST /subscriptions/api/tracklist { url: "..." }  → { tracklistUrl, slug, setAppleLink, trackCount, tracks: [...] }
```

Both `POST /tracklist` and `POST /subscriptions/api/tracklist` resolve through the same shared scrape + cache (`lib/tracklist-resolve.ts`), so a set opened in the viewer is warm for the API and vice-versa. The page accepts `?url=` to deep-link a specific tracklist (it prefills and auto-loads).

### DJ profile pages

Every DJ in the subscriptions list links to `GET /subscriptions/dj/<slug>` — a profile page showing **all of that DJ's tracklists as expandable cards**, newest first. Collapsed cards show the set title and date (derived from the tracklist URL slug — free); expanding a card fetches the full tracklist through the same Access-gated `/api/tracklist` endpoint and shows:

- a **completeness badge** — `full tracklist` when every row resolves to a known track, `partial` otherwise (rows with an `idStatus` like "ID Remix" still count as known; only fully-anonymous `ID` rows count against completeness), plus `IDed / cued / partial-ID` counts,
- **set-level links**: the 1001tracklists page, the set's primary **YouTube** recording, its **SoundCloud** player, and the **Apple Music** album, whenever 1001tracklists embeds them,
- the **per-track list** with artwork, cue times, and per-track YouTube / SoundCloud / Apple Music links (same rendering as the tracklist viewer), and an "Open in viewer" deep link.

Once loaded, the badge stays on the card head, so collapsed cards keep showing which sets are fully IDed. Per-set detail is fetched only on expand — never in bulk — so viewing a profile costs at most one index crawl, and re-expanding a set another page already resolved is a warm cache hit.

The set list comes from `GET /subscriptions/api/dj/<slug>` (`?refresh=1` to force), which walks the DJ's 1001tracklists index with the same infinite-scroll crawl the sync uses (`lib/dj-sets.ts` → `crawlDjIndex`), merges in any URLs the sync state discovered that the index no longer surfaces, and caches the result in KV for 6 h (`djsets:v1:<slug>`). If the crawl is blocked upstream, the page degrades to the sync state's URL list rather than erroring; an empty result is never cached, so the next view retries.

### YouTube account connection

The same page has a "Sign in with YouTube" button that runs an OAuth 2.0 authorization-code flow against Google so the worker can create and modify playlists on the connected channel. The flow is implemented in `src/lib/google-oauth.ts` and wired up in `src/routes/subscriptions.ts`:

```
GET  /subscriptions/oauth/start                   → 302 to Google consent (state cookie set)
GET  /subscriptions/oauth/callback?code&state     → exchanges code, stores tokens, 302 back
POST /subscriptions/oauth/disconnect              → revokes refresh token + clears KV
GET  /subscriptions/api/youtube/status            → { connected, channelId, channelTitle, scope, ... }
```

Scope: `https://www.googleapis.com/auth/youtube` (read+write on the user's playlists/uploads). `access_type=offline` + `prompt=consent` ensures Google always issues a refresh token. The refresh token, current access token, expiry, and channel info are stored at `oauth:google` in the `SUBS` KV namespace; access tokens are auto-refreshed via `getAccessToken(env)` when they're within 60s of expiry. Disconnect calls Google's revoke endpoint and clears the KV entry.

CSRF protection: the `/oauth/start` handler sets a single-use `yt_oauth_state` cookie (HttpOnly, Secure, SameSite=Lax, scoped to `/subscriptions/oauth`, 5-minute lifetime); the callback rejects mismatched/missing state.

**One-time setup** (Google Cloud Console):

1. Create or pick a project, enable the **YouTube Data API v3**.
2. *APIs & Services → OAuth consent screen* — set up an "External" app, add yourself as a test user.
3. *Credentials → Create Credentials → OAuth client ID* — type **Web application**. Authorized redirect URI:
   ```
   https://<your-worker-host>/subscriptions/oauth/callback
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
- **Backfill.** The combined playlist is defined as *the union of every artist playlist*, so each cron tick diffs it against those playlists and inserts whatever is missing. This is the only path that can cover sets the sync processed **before this feature existed** (it never revisits a tracklist it has already handled) and the deep back catalogue a **newly added artist** accumulates over many ticks. It also self-heals anything the live mirror dropped — which is why a failed mirror is recorded on the audit row but never fails a sync.

Both playlists are created on demand (looked up by exact title first, so an existing playlist is adopted rather than duplicated) and their ids are cached in KV — `subs:state:<slug>` for artists, `subs:combined` for the combined one. Deleting a playlist on YouTube is recovered from automatically: the next run re-resolves by title and re-creates if needed. Removing a subscription leaves both playlists in place — nothing is ever deleted from a playlist, only added.

**Pacing.** `playlistItems.insert` costs 50 units against a 10 000/day project quota — 200 inserts/day for the whole worker. The combined **backfill** therefore takes a bounded slice: ≤ 20 inserts per run, a 10 s wall-clock ceiling, and it stops once the day's combined-playlist inserts hit `COMBINED_DAILY_INSERT_CAP` (80, counted at `yt:combined:inserts:<date>` in `CACHE`). The **live mirror** isn't capped — new sets are few and getting them in immediately is the point — but its inserts count against the same daily total, so the backfill yields to them rather than competing. A first backfill of several hundred videos spreads over a few days of cron ticks instead of burning a day's quota in one sweep and starving the per-artist sync. Reads are the cheap half and are cached (`yt:plvids:<playlistId>`, 6 h, rewritten after every insert), so a no-op tick costs ~nothing.

**Failure accounting.** YouTube charges the full 50 units for a *failed* `playlistItems.insert` too, so the caps count **attempts**, not successes — a run of failures consumes budget exactly like a run of inserts (this once mattered: two uninsertable videos retried by the 5-minute cron burned the entire 10 000/day quota, every day). Three rules keep failures bounded:

- A **permanent** insert error (404 `videoNotFound`, 400, non-quota 403 — typically a video deleted or privated *after* the sync added it to an artist playlist, which `playlistItems.list` still returns) marks the video **unavailable** in the combined state (`subs:combined` → `unavailableVideoIds`). It's excluded from "missing" from then on — never retried, by the backfill or the live mirror. The panel shows the skip count; deleting the stale entry from the artist playlist on YouTube is the manual cleanup if you want the count back to zero.
- A **quota** error (`quotaExceeded` etc.) stops the run immediately (`cappedBy: "quota"`) — nothing else will succeed today, and each further attempt would be noise.
- A **transient** error (5xx, network) stays pending and is retried next tick, but the attempt still counted against the daily budget, so even an unclassified repeat-failure can't loop unmetered.

The admin panel's **Combined playlist** section shows the link, video count, how many are still to add, today's remaining insert budget, how many unavailable videos are being skipped, and a **Backfill now** button that runs one bounded pass immediately (same caps — clicking it repeatedly can't blow the quota). Per-set rows in **Recent playlist additions** carry a `combined` field: `added` / `duplicate` / `failed` / `unavailable`.

```
GET  /subscriptions/api/combined            → { connected, title, playlistId, playlistUrl, videoCount,
                                                missingTotal, unavailableTotal, dailyInsertsUsed,
                                                dailyInsertCap, lastBackfillAt, lastBackfillStats,
                                                sources: [...] }
POST /subscriptions/api/combined/backfill   → { ok: true, inserted, pending, cappedBy, ... }
                                              | { ok: false, reason: "no_sources" }
```

Both crons (`0 6 * * *` and `*/5 * * * *`) end with a backfill pass, in their own try/catch so a per-artist sync failure can't stop the combined playlist from catching up on everything that did land.

## Logs

Worker observability is on (`observability.enabled: true` in `wrangler.jsonc`). Every request emits a stream of structured JSON log lines correlated by `reqId` (the Cloudflare `cf-ray` header). Each phase logs full input/output bodies and timing; every error path logs full error context (name, message, stack, upstream status/error code).

`req.start` includes the Cloudflare `colo` and `country` from the request properties for regional triage. `req.end` includes a `counters` object summarising the request's footprint:

```jsonc
"counters": {
  "cacheHits": 5,
  "cacheMisses": 0,
  "youtubeApiCalls": 0,    // 100 quota units each (search.list + videos.list)
  "brightdataCalls": 0,    // ~$3/1000, used for tracklist scrape and medialink fallback
  "homeProxyCalls": 0,     // free, residential-IP forwarder; preferred over brightdata when configured
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

# 2. Set secrets
echo $API_TOKEN                 | npx wrangler secret put API_TOKEN
echo $YOUTUBE_API_KEY           | npx wrangler secret put YOUTUBE_API_KEY
echo $BRIGHTDATA_API_KEY        | npx wrangler secret put BRIGHTDATA_API_KEY
echo $GOOGLE_OAUTH_CLIENT_ID    | npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID
echo $GOOGLE_OAUTH_CLIENT_SECRET| npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET

# Optional: residential-IP forwarder (see "Home proxy" below)
echo $HOME_PROXY_URL     | npx wrangler secret put HOME_PROXY_URL
echo $HOME_PROXY_TOKEN   | npx wrangler secret put HOME_PROXY_TOKEN

# 3. Set CF Access vars in wrangler.jsonc (`vars` block):
#    CF_ACCESS_TEAM_DOMAIN     yourteam.cloudflareaccess.com
#    CF_ACCESS_AUD             <app AUD tag from the Access dashboard>
#    CF_ACCESS_ALLOWED_EMAILS  you@example.com[,other@example.com]

# 4. Set up a Cloudflare Access "self-hosted" application covering the
#    /subscriptions/* path of this worker's hostname, with a policy that
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

## Network strategy

1001tracklists treats Cloudflare Workers' egress IPs as bots and serves a captcha interstitial on tracklist *page* GETs (the search endpoint, oddly, comes through fine). The tracklist GET has up to three escape hatches in priority order:

1. **Home proxy** (free) — a residential-IP HTTP forwarder we run ourselves on a NAS, exposed via cloudflared. Tried first when `HOME_PROXY_URL` + `HOME_PROXY_TOKEN` are set.
2. **Bright Data Web Unlocker** (~$3/1k) — tried when the home proxy isn't configured or returns a CF shell / IP-block / unparseable body. Requires `BRIGHTDATA_API_KEY`.
3. **Direct `fetch()`** — only useful in local dev from a residential IP; runs the JS-challenge solver in `src/lib/fetch.ts`. Always fails on Workers.

| upstream                              | how we fetch it                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| YouTube Data API                       | direct `fetch()`                                                                |
| iTunes Search API                      | direct `fetch()`                                                                |
| 1001tracklists `/search/result.php`    | direct `fetch()` (works from Worker IPs)                                        |
| 1001tracklists tracklist page          | home proxy → Bright Data Unlocker → direct (whichever is configured, in order)  |
| 1001tracklists `get_medialink.php` AJAX| direct `fetch()`, with Bright Data raced as a fallback on timeout                |

**Cost**: at ~$3/1,000 successful requests with Web Unlocker and KV caching the search mapping + parsed tracklist for 2 hours each (short on purpose — new tracklists and newly-IDed tracks should show up quickly), ~20–40 lookups/month works out to under $0.50/month. With the home proxy configured the BrightData spend drops to whatever the residential link can't cover (per-IP rate limits, NAS downtime). Medialink (per-track Apple/YT) and Apple-Music fallback lookups have separate, much longer TTLs since track ↔ deep-link mapping is essentially immutable.

### Home proxy

Why: BrightData occasionally serves a Cloudflare shell on tracklist pages (residential-IP rotation lands on an exit IP without warm CF clearance) and Worker IPs always do. A residential IP we control sidesteps both.

What: a tiny Node service (`scripts/nas-fetch-proxy.mjs`) that accepts `GET /?url=<encoded>` with a shared bearer, fetches the target, and streams the response back. Exposed publicly via your existing cloudflared tunnel. Target hostnames are allowlisted (defaults to `www.1001tracklists.com`) so a leaked bearer can't open-proxy the world. When `UPSTREAM_1001TL_EMAIL`/`UPSTREAM_1001TL_PASSWORD` are configured, the forwarder logs in once, persists the session cookies (`uid`, `sid`, `guid`) to disk, and injects them on every 1001tl request — that's what lets us bypass the upstream Turnstile captcha gate that even residential IPs hit on cold-cache URLs.

Setup (assumes you already have cloudflared running on the NAS):

1. Run the forwarder on the NAS. PM2/systemd/docker — whatever you already use to keep things up:
   ```bash
   PROXY_TOKEN=<long-random> \
   UPSTREAM_1001TL_EMAIL=you@example.com \
   UPSTREAM_1001TL_PASSWORD=<password> \
   COOKIE_FILE=/data/1001tl-cookies.json \
   node scripts/nas-fetch-proxy.mjs
   ```
   Env knobs: `PORT` (default 8088), `BIND` (default 0.0.0.0 — container-friendly; set 127.0.0.1 if running on the host directly), `ALLOWED_HOSTS` (default `www.1001tracklists.com,1001tracklists.com`), `REQUEST_TIMEOUT_MS` (default 20000), `UPSTREAM_1001TL_EMAIL`/`UPSTREAM_1001TL_PASSWORD` (optional; enables logged-in mode), `COOKIE_FILE` (default `/data/1001tl-cookies.json` — persist on a volume so restarts don't re-login).
2. Add a public hostname to your cloudflared tunnel pointing at the forwarder. Either via the Zero Trust dashboard (Tunnels → your tunnel → Public Hostnames → Add) or in `config.yml`:
   ```yaml
   ingress:
     - hostname: tracked-proxy.<yourdomain>
       service: http://localhost:8088
     - service: http_status:404   # keep the catch-all last
   ```
   `cloudflared tunnel route dns <tunnel> tracked-proxy.<yourdomain>` if the DNS record isn't already there, then restart cloudflared.
3. Smoke test from anywhere — should return your residential IP, not a Cloudflare PoP:
   ```bash
   curl -H "Authorization: Bearer $PROXY_TOKEN" \
     "https://tracked-proxy.<yourdomain>/?url=https://api.ipify.org"
   ```
4. Set the secrets on the Worker:
   ```bash
   echo "https://tracked-proxy.<yourdomain>" | npx wrangler secret put HOME_PROXY_URL
   echo $PROXY_TOKEN                          | npx wrangler secret put HOME_PROXY_TOKEN
   ```

Failure handling: any of {transport throw, non-2xx, CF shell, IP-block page, parsed-zero-tracks} on the home-proxy attempt logs a `1001scrape.homeproxy_*_falling_back` warning and proceeds to the next configured path. The Worker can't speak WireGuard so it can't be on your tailnet directly — this forwarder is the bridge.

## How it works

1. **YouTube resolve (best-effort)** — `search.list` (100 quota units) for the title; `videos.list` (1 unit) for durations; pick the result with the smallest abs delta from the provided duration (max 90s tolerance). Cached 30 days. **A miss here is not fatal** — the tracklist lookup falls through to a title search (step 2), so a YouTube-side hiccup (the exact upload missing from the top 5, a duration outside tolerance, a quota/5xx blip) no longer blocks a set 1001tracklists actually has.
2. **1001tracklists search** — tried in order until one hits, then cached 2 hours each: (b) POST `/search/result.php` with the resolved **YouTube URL** + a media-source filter pinned to YouTube (exact); (c) a `search_selection=9` **text search for the resolved video's title**; (d) a text search for the **original POSTed notification title**. Ranking the text-search rows is subtle: same-venue sets share an *identical* visible title (seven "Gorgon City @ Club Space Miami, United States" differing only by a date that lives in the URL, not the title), so a text score can't pick the right date — but 1001tl's own result order already does (it sees the date in the query). So we walk 1001tl's order and take the **first row that clears the bar**, where the bar is an **IDF-weighted token match**: each title token is weighted by how rare it is across the result set, so shared venue/geography boilerplate ("club space miami united states") counts for little and the distinctive artist/event tokens dominate — and a match must include a distinctive shared token, so a query that only shares the venue with an unrelated set is rejected. Steps (c)/(d) are what recover a YouTube miss. If everything misses, the response carries a `message` explaining whether a video was found and which searches were run.
3. **Anti-bot challenges** — two independent gates from 1001tracklists. (a) The original JS interstitial: a `var <token>='<value>';` plus a form that POSTs back with `bChk = Java String.hashCode(<value>)`. The Worker re-implements `chop()` (Java's hash) and POSTs through the challenge. (b) The per-IP rate-limit page (`/info/unblock_ip.html` form, served as a 200 from `search/result.php` and tracklist GETs once an IP trips its quota). The Worker detects this on both direct-fetch and BrightData-unlocker paths and throws a typed `IPBlockedError`, surfaced as `upstream_error: "1001 search/scrape: ip_blocked (<ip>)"`. From Cloudflare egress IPs (production) the JS interstitial upgrades to a graphical captcha the solver can't clear, so the tracklist GET routes through Bright Data Web Unlocker — which in turn occasionally lands on a residential IP that's *also* rate-limited, and we surface that the same way.
4. **Tracklist scrape** — `node-html-parser` over the (un-gated) tracklist HTML. Each `div.tlpItem` contributes one row. Cue seconds come from the JS-emitted `cueValueData` map (keyed by each row's inner `tlp{N}_content` id) — using the hidden form input directly is wrong because it defaults to `"0"` for uncued rows (mashup-linked siblings, trailing untimed extras), which would pollute every selection at probe=0. Title/artist from `meta[itemprop="name|byArtist"]`; mashup-linked status from the `con` class on the row. Cached 2 hours (skipped when the parse returns 0 tracks — that's almost always a transient captcha we want to retry, not a real zero-track tracklist).
5. **Current-track selection** — group `w/` siblings, find the group whose `[startSeconds, nextGroupStart)` window contains `currentSeconds`, then always include the previous group (if any) and the next group (if any) so the caller has one-tap context. When `currentSeconds` is before any cued track, return only the first cued group with `isCurrent: false`.
6. **Per-track Apple/YouTube links** — first try 1001tracklists' first-party AJAX `get_medialink.php?idObject=5&idItem=<n>` and parse the Apple Music embed iframe URL out of the response; fall back to the iTunes Search API for an Apple link if 1001tl has none. No per-track YouTube search (YouTube Data API quota is precious).

### Cache versioning & audit trail

Every cache key embeds the version of the logic that produced its value (`family:v<N>:…`, e.g. `s1001t:v2:<hash>`). When that logic changes, bump the number in `CV` (top of `routes/now-playing.ts`) and stale entries from the old code are simply not read — they age out via TTL instead of being served. This exists because a real fix once looked broken in production: the search change was correct, but a `null` tracklist cached under the un-versioned key by the *old* over-strict ranking kept coming back for two hours.

Each `/now-playing` call also writes a durable audit record to KV under `np:<invertedTs>:<reqId>` (90-day TTL). The key uses an **inverted** timestamp (`10^13 − epochMs`, zero-padded) so a plain `list()` returns newest-first in one page — KV only lists ascending, so forward-epoch keys could only page from the oldest. Each record captures the full request story: inputs (`currentSeconds`, `videoDurationSeconds`, title/url), the YouTube resolution (matched id/title or the error), the tracklist-search plan and which signal hit, and the selection it produced (`currentStartSeconds`, `currentSkewSeconds`, chosen tracks) — plus an `impossibleTimestamp` flag when `currentSeconds > videoDurationSeconds` (the fingerprint of a client-side position bug). A compact summary is duplicated into KV **metadata** so the admin panel lists recent requests without a per-row `get`. Workers Logs only retains ~3 days, but timestamp/selection bugs are often noticed much later (a wrong "now playing" spotted in an old screenshot).

Browse this history in the **admin panel** at `/subscriptions` → **Recent requests** (newest-first, expandable per-request detail, a "problems only" filter, and anomaly highlighting for error statuses / impossible timestamps / large skews). Behind Cloudflare Access. Endpoints: `GET /subscriptions/api/audit?limit&cursor` (summaries) and `GET /subscriptions/api/audit-detail?key=` (full record). For raw CLI access: `wrangler kv key list --namespace-id <CACHE id> --prefix np: --remote` then `wrangler kv key get … --remote` (the `--remote` flag is required — `kv` commands default to the local simulation store).

### Playlist-addition audit trail

The sync writes the same kind of trail for its own work (`lib/playlist-audit.ts`): one record per tracklist it decided an outcome for, under `pladd:<invertedTs>:<slug>:<invertedIndex>` (90-day TTL, compact summary in KV metadata — same newest-first key trick, with the batch index inverted too so sets resolved inside one millisecond still list newest-first). Statuses are `added` (video inserted), `duplicate` (already in the playlist), `no_youtube` (the set page has no recording to add), `failed` (errored this run, will be retried) and `abandoned` (errored `ABANDON_AFTER_FAILURES` times; the cron gives up). Each record carries the set URL, DJ, video id/url, playlist id/title, the combined-playlist outcome for the same video (`combinedStatus`: `added` / `duplicate` / `failed` / `unavailable`), which scrape path served the page, what triggered the run (`cron.daily`, `cron.pending`, `manual.all`, `manual.one`, `manual.combined`), the error message, and how long the set took. This answers "why isn't that set in my playlist?" — previously only answerable from Workers Logs, which age out in ~3 days.

Rows are buffered during a run and flushed in one parallel batch at the end: awaiting up to 30 sequential KV puts inside the set loop would eat a large slice of the 25 s sync deadline. A run killed mid-loop therefore loses its rows — deliberate, since this is diagnostics only; idempotency and progress live in the per-sub state. A KV failure here is logged and swallowed, never surfaced as a sync failure.

Browse it in the **admin panel** at `/subscriptions` → **Recent playlist additions**, which mirrors the requests view (newest-first, expandable per-row detail, a "problems only" filter — `failed` / `abandoned`, since `no_youtube` is a normal outcome). Endpoints: `GET /subscriptions/api/playlist-additions?limit&cursor` (summaries) and `GET /subscriptions/api/playlist-addition-detail?key=` (full record). Raw CLI access is the same as above with `--prefix pladd:`.

## Files

```
src/
  index.ts                  OpenAPIHono app + /openapi.json
  routes/now-playing.ts     pipeline orchestrator (track playing at an offset)
  routes/tracklist.ts       whole-tracklist → JSON dump
  routes/subscriptions.ts   DJ subscriptions mini-app (HTML + JSON API)
  middleware/auth.ts        bearer token (timing-safe)
  middleware/cf-access.ts   Cloudflare Access JWT verification (RS256 + JWKS)
  schemas.ts                zod request/response (also drives OpenAPI)
  types.ts
  lib/
    timestamp.ts            cue parsing + current-track selection
    tracklists1001.ts       search, scrape, medialink, URL parsing (homeProxy → unlocker → direct)
    tracklist-resolve.ts    cached tracklist-page + per-track-link resolvers (shared by both API routes)
    subscriptions.ts        DJ slug parser + KV CRUD for the mini-app
    sync.ts                 auto-playlist orchestrator (crawl → scrape → insert), per-sub KV state
    dj-index.ts             DJ index crawl (infinite-scroll AJAX) + set-page video id extraction
    dj-sets.ts              cached per-DJ set list behind the /subscriptions/dj/<slug> profile page
    combined-playlist.ts    the "All tracked artists" playlist: live mirror + bounded backfill
    playlist-cache.ts       KV-cached playlist video-id sets + find-or-create (shared by both)
    youtube-playlists.ts    YouTube Data API v3 playlist client (OAuth)
    playlist-audit.ts       per-set audit rows behind "Recent playlist additions"
    google-oauth.ts         Google OAuth 2.0 flow + token refresh + revoke
    log.ts                  structured JSON logger + per-request counters
    fetch.ts                challenge solver + cookie jar
    homeProxy.ts            residential-IP forwarder client (pairs with scripts/nas-fetch-proxy.mjs)
    unlocker.ts             Bright Data Web Unlocker client
    youtube.ts              YouTube Data API v3 client
    itunes.ts               Apple Music fallback search
    cache.ts                KV helpers + sha1 + TTLs
scripts/
  nas-fetch-proxy.mjs       Node http server that runs on the NAS and forwards to 1001tl
test/
  fixtures/                 saved 1001tracklists HTML and JSON
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
docs/tasker-setup.md
```
