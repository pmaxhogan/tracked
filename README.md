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
  "currentSeconds": 4595,
  "transitionWindowSeconds": 15
}
```

`transitionWindowSeconds` is optional (default 15). `videoDurationSeconds` is optional but recommended — it disambiguates between multiple uploads of the same DJ set.

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
  "videoUrl":     "https://www.youtube.com/watch?v=79n8BaQAL2Q",
  "tracklistUrl": "https://www.1001tracklists.com/tracklist/l3uw499/...",
  "tracks": [
    {
      "title": "LEFT TO RIGHT (Aidan Rudd Remix)",
      "artist": "Odd Mob",
      "startTime": "1:16:30",
      "startSeconds": 4590,
      "isCurrent": true,
      "isUnidentified": false,
      "appleLink": "https://music.apple.com/...",
      "youtubeLink": null
    }
  ]
}
```

Tracks within the ±transition window are returned with `isCurrent: false`. Mashup-linked siblings (1001tracklists `w/`) are grouped together and all share the parent's `isCurrent` flag.

OpenAPI spec: `GET /openapi.json`.

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
5. **Current-track selection** — group `w/` siblings, find the group with `startSeconds <= now < nextGroupStart`, then optionally include the previous group (if we just transitioned within `transitionWindowSeconds`) and/or the next group (if it's about to start within the same window).
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
