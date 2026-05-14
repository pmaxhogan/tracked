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

Mashup-linked siblings (1001tracklists `w/`) count as a single group, so a current pair returns both members with `isCurrent: true`, and prev/next can themselves be pairs.

**Trailing uncued tracks** (the long tail of untimed rows that 1001tracklists often leaves at the bottom of sparsely-identified sets) get interpolated start times when `videoDurationSeconds` is sent — without that, playback past the last cue would pin the last cued track as "current" forever even when it clearly ended minutes ago. The slot used for each trailing group is `min(medianCuedDuration, evenSlot)`, where `evenSlot` evenly splits the remaining video time across `(lastCuedGroup + trailingGroups)`. Capping by the median of observed cued-track gaps keeps a short opener from being projected to play through the rest of the set; capping by `evenSlot` keeps trailing tracks from extending past `videoDurationSeconds`. Interpolation only runs on **trailing** uncued groups — leading/internal uncued rows keep `startSeconds: null` and the existing "before-first-cue" fallback handles intros. Per-track `startSeconds` is still the raw cue (`null` for trailing rows); only the internal range-matching uses the interpolated value.

`trackUrl` is the canonical 1001tracklists track page (good for opening track details / submitting a fix); `null` when there's no meta url on the row.

`setAppleLink` (top-level) is the Apple Music album/playlist URL for the entire DJ set when 1001tracklists has one — parallel to `videoUrl` for the YouTube source. `null` for sets with no Apple Music release.

`idStatus` (per-track) is `null` for fully-identified tracks. When 1001tracklists marks a row as a partial-ID variant of a known base track ("ID Remix", "ID Edit", "ID Bootleg", "ID Rework", etc.), `idStatus` carries that label, `isUnidentified` stays `false`, and `appleLink` / `youtubeLink` / `trackUrl` describe the **base track** — the actual playing variant may sound different. `isUnidentified: true` is reserved for fully-anonymous tracks (e.g. `"Cave Studio - ID"`); those skip link resolution entirely.

`artworkUrl` is the album art URL, normalized server-side to a square **300×300** for both supported CDNs (Beatport's `image_size/300x300/…` and SoundCloud's `t300x300`). `null` when only 1001tracklists' placeholder was embedded — clients should render their own no-art indicator. Unknown CDNs are passed through unchanged so something is always surfaced when the page has a non-placeholder image.

`durationSeconds` / `durationTime` is the **length the track occupies in this set** (not the studio length): `nextGroupStart − thisGroupStart` for non-last groups, or `videoDurationSeconds − thisGroupStart` for the last group when the caller sent `videoDurationSeconds`. Mashup-linked siblings share the group's window. `null` (and `""` for `durationTime`) when neither input is known or the cue is missing.

When the upstream rate-limits us (1001tracklists per-IP captcha gate), the response is `status: "upstream_error"` with `message: "1001 search: ip_blocked (<ip>)"` (or `1001 scrape: …`) — both the home-IP direct-fetch path and the BrightData unlocker path detect the unblock-form page and surface it cleanly rather than silently degrading to `no_tracklist`.

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

1. **YouTube resolve** — `search.list` (100 quota units) for the title; `videos.list` (1 unit) for durations; pick the result with the smallest abs delta from the provided duration (max 90s tolerance). Cached 30 days.
2. **1001tracklists search** — POST to `/search/result.php` with the YouTube URL and a media-source filter pinned to YouTube. Result is the canonical tracklist URL or null. Cached 2 hours.
3. **Anti-bot challenges** — two independent gates from 1001tracklists. (a) The original JS interstitial: a `var <token>='<value>';` plus a form that POSTs back with `bChk = Java String.hashCode(<value>)`. The Worker re-implements `chop()` (Java's hash) and POSTs through the challenge. (b) The per-IP rate-limit page (`/info/unblock_ip.html` form, served as a 200 from `search/result.php` and tracklist GETs once an IP trips its quota). The Worker detects this on both direct-fetch and BrightData-unlocker paths and throws a typed `IPBlockedError`, surfaced as `upstream_error: "1001 search/scrape: ip_blocked (<ip>)"`. From Cloudflare egress IPs (production) the JS interstitial upgrades to a graphical captcha the solver can't clear, so the tracklist GET routes through Bright Data Web Unlocker — which in turn occasionally lands on a residential IP that's *also* rate-limited, and we surface that the same way.
4. **Tracklist scrape** — `node-html-parser` over the (un-gated) tracklist HTML. Each `div.tlpItem` contributes one row. Cue seconds come from the JS-emitted `cueValueData` map (keyed by each row's inner `tlp{N}_content` id) — using the hidden form input directly is wrong because it defaults to `"0"` for uncued rows (mashup-linked siblings, trailing untimed extras), which would pollute every selection at probe=0. Title/artist from `meta[itemprop="name|byArtist"]`; mashup-linked status from the `con` class on the row. Cached 2 hours (skipped when the parse returns 0 tracks — that's almost always a transient captcha we want to retry, not a real zero-track tracklist).
5. **Current-track selection** — group `w/` siblings, find the group whose `[startSeconds, nextGroupStart)` window contains `currentSeconds`, then always include the previous group (if any) and the next group (if any) so the caller has one-tap context. When `currentSeconds` is before any cued track, return only the first cued group with `isCurrent: false`.
6. **Per-track Apple/YouTube links** — first try 1001tracklists' first-party AJAX `get_medialink.php?idObject=5&idItem=<n>` and parse the Apple Music embed iframe URL out of the response; fall back to the iTunes Search API for an Apple link if 1001tl has none. No per-track YouTube search (YouTube Data API quota is precious).

## Files

```
src/
  index.ts                  OpenAPIHono app + /openapi.json
  routes/now-playing.ts     pipeline orchestrator
  routes/subscriptions.ts   DJ subscriptions mini-app (HTML + JSON API)
  middleware/auth.ts        bearer token (timing-safe)
  middleware/cf-access.ts   Cloudflare Access JWT verification (RS256 + JWKS)
  schemas.ts                zod request/response (also drives OpenAPI)
  types.ts
  lib/
    timestamp.ts            cue parsing + current-track selection
    tracklists1001.ts       search, scrape, medialink (homeProxy → unlocker → direct)
    subscriptions.ts        DJ slug parser + KV CRUD for the mini-app
    google-oauth.ts         Google OAuth 2.0 flow + token refresh + revoke
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
  cf-access.test.ts
  google-oauth.test.ts
docs/tasker-setup.md
```
