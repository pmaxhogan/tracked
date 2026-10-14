# Pre-save matches: finding a pre-saved track's audio outside 1001tracklists

Date: 2026-10-14. Repos: tracked (this one) and mkvid. Status: design settled
from the owner's locked interview answers (the owner was not available for
the brainstorming gates; every gate below was answered from those answers and
is listed as a judgment call in the final report).

## 1. Intent

A pre-saved track (lib/presave.ts, stage `links`) often already IS on
YouTube - typically as a YouTube Music "Topic" art track - but 1001tracklists
never linked it. Example: JAWNS - Damager (1001tl track xtn6qnf) has Spotify
and Apple links on 1001tl, no YouTube link, while
`https://music.youtube.com/watch?v=Lnpw0PbJYWM` (an ATV / Topic upload) exists.
Other times the audio exists only somewhere tracked cannot rip today
(Soulseek, Spotify).

Success:

- A pre-save with no YouTube link is searched on YouTube Music without
  spending YouTube Data API search quota, and the right upload is found.
- Each candidate is compared by audio against short official previews
  (Apple first) so that wrong versions (remixes, bass-boosted re-uploads,
  extended mixes) are not accepted automatically.
- Clear matches are accepted automatically, clear non-matches are rejected
  automatically and never analysed again, and everything else lands on one
  approval page where the owner can listen to every source side by side
  without leaving the UI and approve or reject.
- An accepted Topic / comments-off upload is the presave's video (same as a
  1001tl YouTube link: stage `found`, like, push). Any other accepted
  candidate is ripped and uploaded by mkvid into the Track uploads playlist.

Hard rules carried in: audio comparison is ONLY for pre-save candidate
matching (never to identify tracks in sets; never trackid.net or set79). No
YouTube `search.list` (100 units); `videos.list` (1 unit per 50 ids) is fine.
Unofficial APIs break: breakage is logged and backed off, never red in the UI.

## 2. Approaches considered

1. **mkvid gathers facts, tracked decides (chosen).** mkvid pulls search jobs,
   runs the innertube search, downloads previews and candidate audio,
   fingerprints them and posts every candidate with its facts and per
   reference audio scores. tracked's pure `decideMatch()` turns facts +
   Settings into a decision. Thresholds change in Settings without an mkvid
   deploy; the decision is unit-testable without audio.
2. mkvid decides and posts verdicts. Simpler payload, but every threshold
   change is an image rebuild and the owner's Settings page would lie.
3. tracked searches YouTube Music itself (Worker fetch to innertube) and mkvid
   only compares audio. Splits one job across two pulls and puts an
   unofficial API on the Worker's IPs; no gain.

Matcher options:

1. **Band-energy-difference binary fingerprint (Haitsma-Kalker / Philips
   style) in TypeScript on ffmpeg PCM, with an offset search (chosen).**
   No new binary (fpcalc is neither in the mkvid image nor on the dev box),
   robust to codecs, bitrate and loudness, and sensitive to production
   differences (a remix or a bass-boosted re-upload changes the band energy
   pattern even when melody and key are the same). Offset search finds the
   30 s preview inside the full candidate.
2. Chromaprint (`fpcalc -raw`) + bit error correlation. Proven, but adds a
   binary to the image and to local tests/CI.
3. Chroma / MFCC cross-correlation. Chroma is key/melody based, so a remix in
   the same key scores high: exactly the confusion we must avoid.

## 3. Flow

```
presave (stage links, no YouTube, watched >= presaveMatch.searchDelayHours)
  -> mkvid claims a search job        POST /mkvid/presave/search/claim
       YT Music innertube search (songs + videos filters), name + length prefilter
       references: Apple preview (lookup by ?i= id, else iTunes search),
                   Deezer preview, Spotify preview (client credentials, optional),
                   Beatport sample, SoundCloud (first 60 s via yt-dlp)
       candidate audio via yt-dlp, fingerprints, best-offset score per reference
       reference clips (and non-YouTube candidate clips) uploaded for playback
                                       POST /mkvid/presave/clip
  -> mkvid posts the result            POST /mkvid/presave/search/complete
       tracked: videos.list facts (channel, Topic, comments, duration)
       decideMatch() per candidate:
         auto_found  -> presave found (like, push "on YouTube")
         auto_rip    -> track upload queued (source youtube)
         review      -> approval queue, one push "possible match"
         auto_reject -> stored, never analysed again
  -> owner on /ui/presave-matches: approve -> found | rip ; reject -> stored
```

## 4. Decision rules (`decideMatch`, tracked lib/presave-match.ts)

Inputs: candidate facts (source, durationSeconds, title/artist text,
per reference scores), the presave (artist, title, duration_seconds), the
videos.list facts, Settings `presaveMatch`.

- `nameScore`: token-set similarity (0..1) of normalised "artist title" of the
  candidate vs the presave; feat./remix/mix words kept (a remix's title says
  so). Version words in the candidate that the presave lacks (remix, bass
  boosted, sped up, slowed, nightcore, extended, edit, live, cover, 8d,
  reverb) cap the name score at 0.5.
- `audioScore`: best score over references (0..1, see section 6), null when no
  reference could be scored.
- AUTO-APPROVE: source `ytm`, `audioScore >= autoApproveScore`, presave
  duration known and `|candidate - presave| <= durationToleranceSeconds` (5),
  `nameScore >= minNameScore`.
- AUTO-REJECT: at least one reference scored and every score
  `< autoRejectScore` (clearly different from every reference).
- Soulseek and Spotify candidates: never auto-approved and never auto-rejected
  (approve or reject only); the score is shown as a hint.
- Everything else: `review`.

Approved (auto or owner) YouTube candidate -> found ONLY IF the video is a
Topic upload (`snippet.channelTitle` ends with " - Topic", or innertube said
`MUSIC_VIDEO_TYPE_ATV` when videos.list is unavailable) OR comments are off
(`statistics.commentCount` absent). Otherwise a track upload is queued with
`source_name = 'youtube'`. Approved Soulseek / Spotify -> always a track
upload.

## 5. Data (migration `0022_presave_matches.sql`)

- `presave_match_searches`: one row per presave and kind (`ytm`, `slsk`):
  status (`claimed`, `done`, `failed`), attempts, claimed_at, next_at,
  last_error, searches, candidates_seen, refs (JSON: the references the last
  search used, with clip keys), created_at/updated_at. Due = presave stage
  `links`, no video, watched >= delay, and no row or `next_at <= now` and not
  claimed within the claim TTL. After a search: next_at = now +
  researchDays; after maxSearches searches it stops (`next_at` NULL).
- `presave_matches`: one row per candidate, UNIQUE (presave_id, source,
  external_id) - this is what "never re-analysed" rests on: every claim
  sends the presave's known external ids and mkvid skips them.
  Columns: source (`ytm`, `slsk`, `spotify`), external_id (video id; Soulseek
  `user\u0000path` hash; Spotify track id), url, title, artist, album,
  channel_title, video_type, is_topic, comments_off, duration_seconds,
  name_score, audio_score, scores (JSON per reference), extra (JSON: Soulseek
  username, filename, size, bitrate, length), clip_key, decision
  (`review`, `approved`, `rejected`, `auto_approved`, `auto_rejected`,
  `superseded`), decided_by (`auto`, `owner`), outcome (`found`,
  `rip_queued`, `rip_failed_to_queue`), track_upload_id, created/updated/
  decided_at.
- `track_uploads ADD COLUMN match_id` (the candidate a rip came from).

Times: unix ms in both new tables (like `presaves`).

## 6. Matcher (mkvid src/lib/fingerprint.ts)

- Decode with ffmpeg to mono 5512 Hz f32 (reusing analysis.ts' decode style).
- Frames of 2048 samples (0.37 s), hop 128 samples (23 ms), Hann window, FFT
  (the Fft class from viz/analysis.ts, exported).
- 33 log-spaced bands 300-2000 Hz; energy E(n, m). Bit
  F(n, m) = 1 when (E(n,m) - E(n,m+1)) - (E(n-1,m) - E(n-1,m+1)) > 0;
  32 bits per frame.
- Compare: the reference (trimmed 1.5 s each end for fades) slid over the
  candidate at every frame offset; BER = mismatched bits / compared bits;
  best (lowest) BER wins. score = clamp((0.5 - BER) / 0.5, 0, 1). Unrelated
  audio sits near BER 0.5 (score ~0); the same master at BER 0.05-0.30.
  Overlap of at least 10 s required (else no score).
- Coarse-to-fine: the offset search is done every 4th offset, then refined
  +-4 around the best, so a 5 min candidate costs well under a second.
- Tuned on a labelled set (scripts/tune-matcher.ts, local only, no audio
  committed): true matches (Apple preview vs the Topic upload), other versions
  of the same title (remix, extended, bass boosted, sped up), unrelated
  tracks. Unit tests use small synthetic signals with ffmpeg transforms.

## 7. Endpoints

tracked, bearer MKVID_TOKEN (routes/mkvid-presave.ts, mounted at
/mkvid/presave ahead of /mkvid):

- `POST /search/claim { kinds?: ['ytm'|'slsk'] }` -> `{ job | null }` with
  `{ searchId, kind, presaveId, artist, title, durationSeconds, trackUrl,
  references: [{ kind, url }], known: [externalId], maxCandidates,
  durationToleranceSeconds, allowSpotifyRip }`.
- `POST /search/complete { searchId, references: [{ kind, url, ok,
  durationSeconds?, clipKey?, error? }], candidates: [...] }` -> per candidate
  decisions.
- `POST /search/fail { searchId, error, retryAfterSeconds? }` -> backoff, no
  red state (an innertube breakage is a warning on the page).
- `POST /clip?key=` (audio/mpeg body, <= 1.5 MB) -> stored in R2 IMAGES under
  `presave-clips/`.
- `/mkvid/health` adds `presaveSearch: true`; mkvid gates on it (10 min TTL)
  and treats 404 as idle, so either deploy order works.
- Track claims: body gains `sources?: string[]`; rows with source
  `soulseek` / `spotify` are only handed to an mkvid that lists them.

UI (CF Access, routes/presave-match-ui.ts):

- `GET /ui/api/presave-matches?decision=review|decided` -> grouped by presave.
- `POST /ui/api/presave-matches/:id/approve`, `/:id/reject`.
- `POST /ui/api/presave-matches/search-now { presaveId }` (due now).
- `GET /ui/api/presave-matches/clip/:key` -> the R2 clip.

## 8. Approval page `/ui/presave-matches`

Nav highlight `presaves` (no new nav item; linked from the Pre-saves header
and the pre-saved track page). One card per presave in review: track header,
a references row (an `<audio controls>` per reference: Apple / Deezer /
Spotify URLs directly, clips through the clip route), and a candidates row
(YouTube iframe embed `youtube-nocookie.com/embed/<id>?enablejsapi=1` for
YouTube candidates, `<audio>` for clips), each with scores, length delta,
Topic / comments badges and Approve / Reject buttons. "Play all" starts every
audio element and every YouTube player (IFrame API postMessage) in one click;
"Stop all" pauses them. A Decided tab lists the history. Errors are
info/warn; red is reserved for nothing here except a failed action toast.

## 9. Soulseek (phase B)

slskd in its own gluetun (AirVPN WireGuard, like PIONEER) on the NAS; mkvid
reaches it as `http://gluetun-slskd:5030` with an API key; slskd downloads
into `/mnt/alpha/apps/slskd/downloads`, bind-mounted into mkvid read-only at
`/slskd`. mkvid searches (`POST /api/v0/searches`), keeps audio files whose
name fuzzy-matches artist + title and whose length is within the tolerance,
ranks (lossless > 320 > others, free slot, speed), posts the top few as
`slsk` candidates. Approve -> track upload `source_name = 'soulseek'`,
`source_url = 'slsk://<user>/<path>'`; mkvid enqueues the download
(`POST /api/v0/transfers/downloads/<user>`), waits for it, and renders from
the file. Disabled until `SLSKD_URL` + `SLSKD_API_KEY` are set on mkvid and
`presaveMatch.soulseek` is on in tracked.

## 10. Spotify rip (phase C, built disabled)

Only when a search found no YouTube and no Soulseek candidate and
`presaveMatch.spotifyRip` is on: the claim says `allowSpotifyRip`, mkvid posts
one `spotify` candidate (the 1001tl Spotify link) for review. Approve ->
track upload `source_name = 'spotify'`; mkvid rips with zotify using a burner
Premium account (`SPOTIFY_RIP_USERNAME` / `SPOTIFY_RIP_CREDENTIALS_FILE`),
only when those are set; otherwise the rip fails permanently with
`spotify_rip_disabled`.

## 11. Settings `presaveMatch`

enabled (true), searchDelayHours (48), researchDays (7), maxSearches (4),
dailySearchCap (40; claims are also paced by mkvid: one at a time, at most
one per `PRESAVE_SEARCH_SECONDS`), maxCandidates (6), autoApproveScore (tuned),
autoRejectScore (tuned), durationToleranceSeconds (5), minNameScore (0.6),
notifyReview (true), soulseek (false), spotifyRip (false).

## 12. Errors and testing

- Innertube parse/HTTP failure: mkvid logs `presave_search.ytm_failed`,
  reports `/search/fail` with a retryAfter (doubling, 30 min to 24 h); tracked
  records it as a warning; the page shows it amber.
- A reference that cannot be fetched is skipped; no references at all = no
  audio score = review (never auto-reject on missing data).
- tracked tests: decideMatch table, claim due-ness, complete (decisions,
  found path, rip path, idempotent re-post), fail backoff, UI API approve /
  reject, migration applies, page test in test/ui-pages.test.ts.
- mkvid tests: innertube parse on a recorded trimmed fixture, fingerprint +
  compare on synthetic audio (same, transcoded, offset, different), the
  poller with a fake client, slskd client with a fake fetch.
