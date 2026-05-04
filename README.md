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

`trackUrl` is the canonical 1001tracklists track page (good for opening track details / submitting a fix); `null` when there's no meta url on the row.

`setAppleLink` (top-level) is the Apple Music album/playlist URL for the entire DJ set when 1001tracklists has one — parallel to `videoUrl` for the YouTube source. `null` for sets with no Apple Music release.

`idStatus` (per-track) is `null` for fully-identified tracks. When 1001tracklists marks a row as a partial-ID variant of a known base track ("ID Remix", "ID Edit", "ID Bootleg", "ID Rework", etc.), `idStatus` carries that label, `isUnidentified` stays `false`, and `appleLink` / `youtubeLink` / `trackUrl` describe the **base track** — the actual playing variant may sound different. `isUnidentified: true` is reserved for fully-anonymous tracks (e.g. `"Cave Studio - ID"`); those skip link resolution entirely.

`artworkUrl` is the album art URL, normalized server-side to a square **300×300** for both supported CDNs (Beatport's `image_size/300x300/…` and SoundCloud's `t300x300`). `null` when only 1001tracklists' placeholder was embedded — clients should render their own no-art indicator. Unknown CDNs are passed through unchanged so something is always surfaced when the page has a non-placeholder image.

OpenAPI spec: `GET /openapi.json` (bearer-gated).

## Logs

Worker observability is on (`observability.enabled: true` in `wrangler.jsonc`). Every request emits a stream of structured JSON log lines correlated by `reqId` (the Cloudflare `cf-ray` header). Each phase logs full input/output bodies and timing; every error path logs full error context (name, message, stack, upstream status/error code).

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
npm test           # vitest, 27+ assertions across timestamp + scraper logic
npm run typecheck
```

To exercise the full flow from the phone, expose dev over a tunnel:

```bash
npm run tunnel     # cloudflared tunnel --url http://localhost:8787
```

Point Tasker at the resulting `https://*.trycloudflare.com` URL.

## Deploy

```bash
# 1. Create the KV namespace and paste both ids into wrangler.jsonc
npx wrangler kv namespace create CACHE
npx wrangler kv namespace create CACHE --preview

# 2. Set secrets
echo $API_TOKEN          | npx wrangler secret put API_TOKEN
echo $YOUTUBE_API_KEY    | npx wrangler secret put YOUTUBE_API_KEY
echo $BRIGHTDATA_API_KEY | npx wrangler secret put BRIGHTDATA_API_KEY

# 3. Deploy
npx wrangler deploy
```

## Network strategy

1001tracklists treats Cloudflare Workers' egress IPs as bots and serves a captcha interstitial on tracklist *page* GETs (the search endpoint, oddly, comes through fine). To bypass that without having to babysit CAPTCHAs, the tracklist page GET routes through **Bright Data Web Unlocker** when `BRIGHTDATA_API_KEY` is set.

| upstream                              | how we fetch it                                          |
| ------------------------------------- | -------------------------------------------------------- |
| YouTube Data API                       | direct `fetch()`                                          |
| iTunes Search API                      | direct `fetch()`                                          |
| 1001tracklists `/search/result.php`    | direct `fetch()` (works from Worker IPs)                 |
| 1001tracklists tracklist page          | Bright Data Web Unlocker if key set, else direct (dev)    |
| 1001tracklists `get_medialink.php` AJAX| direct `fetch()` (no captcha there)                       |

When the key is unset (local dev from a residential IP) we fall back to the home-grown JS-challenge solver in `src/lib/fetch.ts`.

**Cost**: at ~$3/1,000 successful requests with Web Unlocker and KV caching the search mapping + parsed tracklist for 2 hours each (short on purpose — new tracklists and newly-IDed tracks should show up quickly), ~20–40 lookups/month works out to under $0.50/month. Medialink (per-track Apple/YT) and Apple-Music fallback lookups have separate, much longer TTLs since track ↔ deep-link mapping is essentially immutable.

## How it works

1. **YouTube resolve** — `search.list` (100 quota units) for the title; `videos.list` (1 unit) for durations; pick the result with the smallest abs delta from the provided duration (max 90s tolerance). Cached 30 days.
2. **1001tracklists search** — POST to `/search/result.php` with the YouTube URL and a media-source filter pinned to YouTube. Result is the canonical tracklist URL or null. Cached 2 hours.
3. **Anti-bot challenge** — 1001tracklists serves a JS interstitial on first contact: a `var <token>='<value>';` plus a form that POSTs back with `bChk = Java String.hashCode(<value>)`. The Worker re-implements `chop()` (Java's hash) and POSTs through the challenge. From Cloudflare egress IPs the page upgrades to a captcha that the JS solver can't clear — those requests route through Bright Data Web Unlocker instead.
4. **Tracklist scrape** — `node-html-parser` over the (un-gated) tracklist HTML. Each `div.tlpItem` contributes one row: cue seconds come from a hidden `input[id$="_cue_seconds"]`, title/artist from `meta[itemprop="name|byArtist"]`, mashup-linked status from a `con` class on the row plus a `w/` track number. Cached 2 hours (and never cached when the parse comes back empty — that's almost always a captcha-gated response we want to retry, not a real zero-track tracklist).
5. **Current-track selection** — group `w/` siblings, find the group whose `[startSeconds, nextGroupStart)` window contains `currentSeconds`, then always include the previous group (if any) and the next group (if any) so the caller has one-tap context. When `currentSeconds` is before any cued track, return only the first cued group with `isCurrent: false`.
6. **Per-track Apple/YouTube links** — first try 1001tracklists' first-party AJAX `get_medialink.php?idObject=5&idItem=<n>` and parse the Apple Music embed iframe URL out of the response; fall back to the iTunes Search API for an Apple link if 1001tl has none. No per-track YouTube search (YouTube Data API quota is precious).

## Files

```
src/
  index.ts                  OpenAPIHono app + /openapi.json
  routes/now-playing.ts     pipeline orchestrator
  middleware/auth.ts        bearer token (timing-safe)
  schemas.ts                zod request/response (also drives OpenAPI)
  types.ts
  lib/
    timestamp.ts            cue parsing + current-track selection
    tracklists1001.ts       search, scrape, medialink
    fetch.ts                challenge solver + cookie jar
    youtube.ts              YouTube Data API v3 client
    itunes.ts               Apple Music fallback search
    cache.ts                KV helpers + sha1 + TTLs
test/
  fixtures/                 saved 1001tracklists HTML and JSON
  timestamp.test.ts
  tracklists1001.test.ts
docs/tasker-setup.md
```
