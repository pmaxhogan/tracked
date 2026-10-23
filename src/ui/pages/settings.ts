// Settings: the YouTube connection, this device's notifications, the theme, the
// integrations in use and the ban episodes. BAN_JS (banPage 'settings') fills the
// alerts-*, ban-route, ban-devices and ban-episodes elements by id.
import { shell } from "../shell";
import { tipAttr } from "../tip";
import type { UiPage } from "./index";
import { YOUTUBE_CARD_CSS, YOUTUBE_CARD_HTML, YOUTUBE_CARD_JS } from "./youtube-card";
import { SETTINGS_FORM_CSS, SETTINGS_FORM_JS, type FormGroup } from "./settings-form";
import { DEFAULT_PROJECT_DAILY_CLAIM_CAP } from "../../lib/mkvid";

// App settings (lib/app-settings.ts, GET/PUT /ui/api/settings). A blank
// env-backed field saves null: the env var, else the old default (shown as
// the placeholder).
const APP_GROUPS: FormGroup[] = [
  {
    id: "sf-mkvid",
    title: "mkvid uploads",
    intro: "Blank = the env var or secret, else the default (shown greyed).",
    fields: [
      {
        path: "mkvid.dailyClaimCap",
        label: "Uploads a day, mkvid project",
        help: "mkvid-uploads. 0 pauses the queue.",
        min: 0,
        max: 100,
        step: 1,
        nullable: true,
      },
      {
        path: "mkvid.sharedDailyClaimCap",
        label: "Uploads a day, shared project",
        help: "tracked-youtube, last, once the others are full.",
        min: 0,
        max: 100,
        step: 1,
        nullable: true,
      },
      {
        path: "mkvid.claimTtlMinutes",
        label: "Hand a stuck claim out again after",
        help: "mkvid died mid-job.",
        unit: "min",
        min: 10,
        max: 1440,
        step: 1,
        nullable: true,
      },
      {
        path: "mkvid.hearthisDownloadsPerHour",
        label: "hearthis.at downloads an hour",
        help: "Rolling hour, sets and audio cue jobs together (an audio cue job needs 2 free). A hearthis set over it waits in the queue, no attempt used. 0 pauses hearthis.at. Blank = mkvid's HEARTHIS_DOWNLOADS_PER_HOUR, else 3.",
        min: 0,
        max: 100,
        step: 1,
        nullable: true,
      },
      {
        path: "mkvid.hearthisPagesPerHour",
        label: "hearthis.at page fetches an hour",
        help: "Rolling hour: embed and track pages and yt-dlp's lookups, sets and audio cue jobs together. A set needs 3 free (an audio cue job 4), so 1 and 2 are not allowed; a hearthis set over it waits in the queue, no attempt used. 0 pauses hearthis.at. Blank = mkvid's HEARTHIS_PAGES_PER_HOUR, else 20.",
        min: 0,
        max: 200,
        step: 1,
        nullable: true,
      },
      {
        path: "mkvid.maxAttempts",
        label: "Attempts before a request fails",
        help: "Default 3.",
        min: 1,
        max: 10,
        step: 1,
      },
      {
        path: "mkvid.retryBackoffHours",
        label: "Retry a failed render after",
        help: "Times the attempts so far. Default 6.",
        unit: "h",
        min: 0.25,
        max: 168,
      },
      {
        path: "mkvid.unverifiedRetryMinutes",
        label: "List not verified: look again after",
        help: "No attempt used. Default 60.",
        unit: "min",
        min: 5,
        max: 1440,
        step: 1,
      },
      {
        path: "mkvid.privacy",
        label: "Upload privacy",
        help: "Of set videos. Default unlisted.",
        kind: "select",
        options: [
          { value: "public", label: "public" },
          { value: "unlisted", label: "unlisted" },
          { value: "private", label: "private" },
        ],
      },
      {
        path: "mkvid.goneCheckHours",
        label: "Look for deleted videos every",
        help: "One gone from YouTube leaves the playlists and is rendered again. 0 = never. Default 6.",
        unit: "h",
        min: 0,
        max: 168,
      },
      {
        path: "mkvid.removedBurstCount",
        label: "Recordings removed within a day before it is flagged",
        help: "That many at once may mean the source or the downloader is broken: they turn red and stay as they are until you choose on the mkvid page. 0 = never, otherwise 2 to 50. Default 3.",
        min: 0,
        max: 50,
        step: 1,
      },
    ],
  },
  {
    id: "sf-playlists",
    title: "Playlists",
    link: { href: "/ui/quota", text: "YouTube quota" },
    intro:
      "How many sweep removals, combined inserts and ordering moves a day, and who goes first, is set on the YouTube quota page.",
    fields: [
      {
        path: "playlists.sweepDryRun",
        label: "Removal sweep only reports",
        help: "On: videos that are not full recordings, and deleted or private videos still in a playlist, are only listed on the Removed page. Off: they are taken out. Blank = PLAYLIST_SWEEP_DRY_RUN (unset = on).",
        kind: "bool",
        nullable: true,
      },
      {
        path: "playlists.rejectVertical",
        label: "Turn down vertical videos",
        help: "Shorts and portrait phone recordings. Blank = REJECT_VERTICAL (unset = on).",
        kind: "bool",
        nullable: true,
      },
      {
        path: "playlists.shortToleranceMinutes",
        label: "Video shorter than the last cue by",
        help: "More than this is not the full set. Default 5.",
        unit: "min",
        min: 0,
        max: 60,
      },
      {
        path: "playlists.audioToleranceMinutes",
        label: "Audio longer than the video by",
        help: "More than this means the video is a cut. Default 10.",
        unit: "min",
        min: 0,
        max: 120,
      },
      {
        path: "playlists.massRemovalMax",
        label: "Hold a playlist when missing more than",
        help: "Videos at once, instead of removing. Default 5.",
        min: 0,
        max: 100,
        step: 1,
      },
      {
        path: "playlists.massRemovalRatio",
        label: "Or more than this share of it",
        help: "Default 0.3.",
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        path: "playlists.runRemovalMax",
        label: "Hold every playlist when one run misses more than",
        help: "Across all playlists. Default 15.",
        min: 0,
        max: 500,
        step: 1,
      },
      {
        path: "playlists.combinedMaxInsertsPerRun",
        label: "Combined playlist inserts per run",
        help: "Default 20.",
        min: 0,
        max: 100,
        step: 1,
      },
      {
        path: "playlists.orderMovesPerRun",
        label: "Playlist moves per run",
        help: "Default 10. Set 1 for the first day, to watch single moves land.",
        min: 1,
        max: 100,
        step: 1,
      },
    ],
  },
  {
    id: "sf-presave",
    title: "Pre-saves",
    link: { href: "/ui/quota", text: "YouTube quota" },
    intro:
      "Pre-saved tracks are looked up again until 1001tracklists has a YouTube link. Recheck on a track always works.",
    fields: [
      {
        path: "presave.enabled",
        label: "Scheduled rechecks",
        help: "Off stops the twice-a-day lookups.",
        kind: "bool",
      },
      {
        path: "presave.recheckIntervalHours",
        label: "Look a track up again every",
        help: "Default 12: twice a day.",
        unit: "h",
        min: 1,
        max: 720,
      },
      {
        path: "presave.jitterFraction",
        label: "Spread each interval by",
        help: "Plus or minus this share. Default 0.15.",
        min: 0,
        max: 0.5,
        step: 0.05,
      },
      {
        path: "presave.maxPerTick",
        label: "Rechecks a scheduler tick",
        help: "On top of its other fetches. Default 1.",
        min: 0,
        max: 10,
        step: 1,
      },
      {
        path: "presave.priority",
        label: "Pool priority of a recheck",
        help: "Manual rechecks go at phone priority.",
        kind: "select",
        options: [
          { value: "new", label: "new" },
          { value: "verify", label: "verify" },
          { value: "recheck", label: "recheck (default)" },
          { value: "backfill", label: "backfill" },
        ],
      },
      {
        path: "presave.retryMinutes",
        label: "Retry a failed lookup after",
        help: "Pool refused or a page error. Default 60.",
        unit: "min",
        min: 5,
        max: 1440,
        step: 1,
      },
      {
        path: "presave.notifyFound",
        label: "Push when one is on YouTube",
        help: "To every device. Tapping opens YouTube Music.",
        kind: "bool",
      },
      {
        path: "presave.likeOnYouTube",
        label: "Like it on YouTube",
        help: "Once it has a video (found or uploaded), so it is in your liked music. One you disliked is left alone.",
        kind: "bool",
      },
      {
        path: "presave.playlistTitle",
        label: "Playlist",
        help: "Every pre-save with a video goes into it, newest last. Created when missing; a pre-save dismissed later stays in it. Default Pre-saves.",
        kind: "text",
        maxLength: 150,
      },
      {
        path: "presave.playlistPrivacy",
        label: "Playlist privacy",
        help: "When it is created. Default unlisted.",
        kind: "select",
        options: [
          { value: "public", label: "public" },
          { value: "unlisted", label: "unlisted" },
          { value: "private", label: "private" },
        ],
      },
      {
        path: "presave.useSetFetches",
        label: "Learn from set fetches",
        help: "A set page fetched for any reason updates the ID rows saved from it. Free.",
        kind: "bool",
      },
      {
        path: "presave.giveUpDays",
        label: "Stop watching after",
        help: "Days without a link. 0 = never.",
        unit: "days",
        min: 0,
        max: 3650,
        step: 1,
      },
    ],
  },
  {
    id: "sf-track-uploads",
    title: "Track uploads",
    intro:
      "A pre-saved track with no YouTube link but a link mkvid can rip is uploaded by mkvid into one playlist.",
    fields: [
      {
        path: "trackUploads.enabled",
        label: "Queue tracks for mkvid",
        help: "Off stops new track uploads.",
        kind: "bool",
      },
      {
        path: "trackUploads.minWatchDays",
        label: "Watch a track first for",
        help: "Before it is queued. Default 5.",
        unit: "days",
        min: 0,
        max: 365,
      },
      {
        path: "trackUploads.allowedSources",
        label: "Sources mkvid may rip",
        help: "In order of preference, comma separated.",
        kind: "list",
        max: 20,
        maxLength: 40,
      },
      {
        path: "trackUploads.dailyCap",
        label: "Track uploads a day",
        help: "Shares the mkvid caps. 0 pauses. Default 4.",
        min: 0,
        max: 100,
        step: 1,
      },
      {
        path: "trackUploads.playlistTitle",
        label: "Playlist",
        help: "Created when missing. Default Track uploads.",
        kind: "text",
        maxLength: 150,
      },
      {
        path: "trackUploads.privacy",
        label: "Upload privacy",
        help: "Default unlisted.",
        kind: "select",
        options: [
          { value: "public", label: "public" },
          { value: "unlisted", label: "unlisted" },
          { value: "private", label: "private" },
        ],
      },
      {
        path: "trackUploads.notifyUploaded",
        label: "Push when one is uploaded",
        help: "To every device.",
        kind: "bool",
      },
      {
        path: "trackUploads.maxAttempts",
        label: "Attempts before a track fails",
        help: "Default 3.",
        min: 1,
        max: 10,
        step: 1,
      },
      {
        path: "trackUploads.retryBackoffHours",
        label: "Retry a failed rip after",
        help: "Times the attempts so far. Default 6.",
        unit: "h",
        min: 0.25,
        max: 168,
      },
      {
        path: "trackUploads.minDurationRatio",
        label: "Refuse a rip shorter than",
        help: "This share of the expected length: a preview. Default 0.85.",
        min: 0,
        max: 1,
        step: 0.05,
      },
    ],
  },
  {
    id: "sf-presave-match",
    title: "Pre-save matches",
    intro:
      "mkvid searches YouTube Music (and Soulseek) for a pre-saved track 1001tracklists has no YouTube link for, and compares each candidate's audio with the track's previews. Clear matches are approved, clear misses rejected, the rest wait on the Pre-save matches page.",
    fields: [
      {
        path: "presaveMatch.enabled",
        label: "Search for matches",
        help: "Off: mkvid gets no search jobs.",
        kind: "bool",
      },
      {
        path: "presaveMatch.searchDelayHours",
        label: "First search after",
        help: "Of watching. Default 48.",
        unit: "h",
        min: 0,
        max: 8760,
      },
      {
        path: "presaveMatch.researchDays",
        label: "Search again every",
        help: "Default 7.",
        unit: "days",
        min: 0.5,
        max: 365,
      },
      {
        path: "presaveMatch.maxSearches",
        label: "Searches per track at most",
        help: "Default 4.",
        min: 1,
        max: 50,
        step: 1,
      },
      {
        path: "presaveMatch.dailySearchCap",
        label: "Searches a day at most",
        help: "Default 40. 0 pauses.",
        min: 0,
        max: 1000,
        step: 1,
      },
      {
        path: "presaveMatch.maxCandidates",
        label: "Candidates per search",
        help: "Default 6.",
        min: 1,
        max: 20,
        step: 1,
      },
      {
        path: "presaveMatch.autoApproveScore",
        label: "Auto-approve at audio score",
        help: "0 to 1 against a preview. Default 0.7 (the same recording scores about 0.8 to 0.93).",
        min: 0,
        max: 1,
        step: 0.01,
      },
      {
        path: "presaveMatch.autoRejectScore",
        label: "Auto-reject below audio score",
        help: "Against every preview. Default 0.2 (unrelated audio scores about 0.05).",
        min: 0,
        max: 1,
        step: 0.01,
      },
      {
        path: "presaveMatch.durationToleranceSeconds",
        label: "Auto-approve length within",
        help: "Of the track's length. Default 5.",
        unit: "s",
        min: 0,
        max: 120,
      },
      {
        path: "presaveMatch.minNameScore",
        label: "Auto-approve name match at least",
        help: "Artist and title, 0 to 1. Default 0.6.",
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        path: "presaveMatch.notifyReview",
        label: "Push when matches need approval",
        help: "One push per search.",
        kind: "bool",
      },
      {
        path: "presaveMatch.soulseek",
        label: "Search Soulseek too",
        help: "Needs slskd on mkvid. Soulseek files are never auto-approved.",
        kind: "bool",
      },
      {
        path: "presaveMatch.spotifyRip",
        label: "Offer a Spotify rip",
        help: "When nothing else was found; always behind approval. Needs the burner account on mkvid.",
        kind: "bool",
      },
    ],
  },
  {
    id: "sf-link-prewarm",
    title: "Link pre-warm",
    intro:
      "A set the sync reads queues its tracks' Apple Music and YouTube links, and the cron looks a few up, so What's playing finds them cached.",
    fields: [
      {
        path: "linkPrewarm.enabled",
        label: "Pre-warm track links",
        help: "Off stops queueing and lookups.",
        kind: "bool",
      },
      {
        path: "linkPrewarm.maxPerTick",
        label: "Lookups a cron tick",
        help: "Every 5 minutes, at pool priority backfill; one page view each, cached tracks cost none. Default 3.",
        min: 0,
        max: 20,
        step: 1,
      },
    ],
  },
  {
    id: "sf-track-sets",
    title: "Recommended sets crawl",
    intro:
      "The cron opens the 1001tracklists page of each track in the followed DJs' sets and stores every set it was played in, newest first, back to the stop year. Recommended sets ranks them.",
    fields: [
      {
        path: "trackSets.enabled",
        label: "Crawl track pages",
        help: "Off stops fetching; what was stored stays.",
        kind: "bool",
      },
      {
        path: "trackSets.viewsPerTick",
        label: "Page views a cron tick",
        help: "A safety cap. Every 5 minutes, at pool priority backfill; a track page is one view, each scroll request another. The crawl stops earlier when the time below is up or the pool's backfill share is spent. Default 200.",
        min: 0,
        max: 1000,
        step: 1,
      },
      {
        path: "trackSets.maxShare",
        label: "Share of the backfill budget",
        help: "0 to 1, over 24 hours, page loads and scroll requests counted apart. The link pre-warm, DJ history and index catch-up keep the rest. A track costs one page load, so this share is what paces the crawl. Default 0.75.",
        min: 0.05,
        max: 1,
        step: 0.05,
      },
      {
        path: "trackSets.tickSeconds",
        label: "Seconds a cron tick crawls",
        help: "Wall clock; a view takes about 3 s. Default 200.",
        min: 10,
        max: 280,
        step: 10,
      },
      {
        path: "trackSets.stepCount",
        label: "Sets per scroll request",
        help: "The browser asks for 10; more means fewer requests per track. Default 100.",
        min: 10,
        max: 500,
        step: 10,
      },
      {
        path: "trackSets.stopYear",
        label: "Stop at sets from",
        help: "A walk ends at the first set from this year or earlier. Default 2020.",
        min: 2000,
        max: 2100,
        step: 1,
      },
      {
        path: "trackSets.busyRows",
        label: "Busy track after (sets)",
        help: "A track whose walk has seen this many sets counts as played very often. Default 300.",
        min: 15,
        max: 10000,
        step: 5,
      },
      {
        path: "trackSets.busyStopYear",
        label: "Busy tracks stop at sets from",
        help: "Used instead of the year above once a track is busy. Default 2022.",
        min: 2000,
        max: 2100,
        step: 1,
      },
      {
        path: "trackSets.maxSteps",
        label: "Scroll requests a walk",
        help: "After the track page itself. Default 20.",
        min: 0,
        max: 200,
        step: 1,
      },
      {
        path: "trackSets.recrawlDays",
        label: "Read a track again after (days)",
        help: "Down to the first set it already has. Default 30.",
        min: 1,
        max: 3650,
        step: 1,
      },
    ],
  },
  {
    id: "sf-apple-cues",
    title: "Cue times from Apple Music",
    intro:
      "A set held for too few cue times can take the missing ones from its Apple Music DJ mix album. The 1001tracklists cues stay; only rows without one are filled.",
    fields: [
      {
        path: "appleCues.enabled",
        label: "Fill cue times from Apple Music",
        help: "Off leaves held sets as 1001tracklists has them.",
        kind: "bool",
      },
      {
        path: "appleCues.minMatchShare",
        label: "Tracks that must match the album",
        help: "Share of the track list, 0.1 to 1. Below it the album is not used at all. Default 0.7.",
        min: 0.1,
        max: 1,
        step: 0.05,
      },
      {
        path: "appleCues.lengthTolerancePct",
        label: "Album length may differ from the recording by",
        help: "Percent of the recording, or the minutes below if that is more. A studio edit is shorter and is skipped. Default 3.",
        unit: "%",
        min: 0,
        max: 50,
      },
      {
        path: "appleCues.lengthToleranceMinutes",
        label: "Or by at least",
        help: "Default 2.",
        unit: "min",
        min: 0,
        max: 60,
      },
    ],
  },
  {
    id: "sf-graph",
    title: "Graph",
    intro:
      "The Graph page draws the library from cached data. Sources and track credits of sets read before it existed are filled in from stored pages and, once each, by a low-priority refetch.",
    fields: [
      {
        path: "graph.nodeCap",
        label: "Most nodes on the graph",
        help: "One answer and the whole-library view hold at most this many. Large graphs get slow to draw. Default 5,000.",
        min: 100,
        max: 1000000,
        step: 100,
      },
      {
        path: "graph.confirmOver",
        label: "Ask before adding more than",
        help: "An expansion that adds more new nodes than this asks first. Default 300.",
        unit: "nodes",
        min: 10,
        max: 1000000,
        step: 10,
      },
      {
        path: "graph.backfill",
        label: "Refetch old sets for the graph",
        help: "Through the search index catch-up: pool priority backfill, its per-tick and per-day caps (Pool settings). Off stops it.",
        kind: "bool",
      },
      {
        path: "graph.pagesPerTick",
        label: "Stored pages read a cron tick",
        help: "Set pages kept in R2, read for their sources and credits; no pool fetch. Default 10. 0 = none.",
        min: 0,
        max: 100,
        step: 1,
      },
    ],
  },
  {
    id: "sf-genres",
    title: "Set metadata and genres",
    intro:
      "Every set and track page the app reads is kept with its genres, labels, links and counts. Sets read before that are filled in from stored pages.",
    fields: [
      {
        path: "genres.metaPagesPerTick",
        label: "Stored pages read a cron tick",
        help: "Set pages kept in R2, read for their genres and the rest of the page; no pool fetch. Default 20. 0 = none.",
        min: 0,
        max: 100,
        step: 1,
      },
    ],
  },
  {
    id: "sf-retention",
    title: "Retention",
    fields: [
      {
        path: "retention.auditDays",
        label: "Keep now-playing and playlist audit",
        help: "Default 90.",
        unit: "days",
        min: 1,
        max: 3650,
        step: 1,
      },
      {
        path: "retention.tickHistoryDays",
        label: "Keep scheduler tick history",
        help: "Default 14.",
        unit: "days",
        min: 1,
        max: 365,
        step: 1,
      },
    ],
  },
];

const BODY = /* html */ `
${YOUTUBE_CARD_HTML}
<div class="tk-card">
  <h2>Notifications</h2>
  <div id="alerts-row" class="tk-row st-alerts">
    <span class="muted"><span class="tip-term"${tipAttr("Pushes sent when 1001tracklists blocks tracked, a captcha needs solving, or a playlist is held.")}>IP-ban alerts</span> on this device:</span>
    <span id="alerts-state" class="alerts-state">checking…</span>
    <button id="alerts-enable" type="button" class="btn small" hidden${tipAttr("Asks this browser for permission to push ban, captcha and held-playlist alerts to this device.")}>Enable on this device</button>
    <button id="alerts-test" type="button" class="btn small"${tipAttr("Sends a test push to every subscribed device, to check delivery works.")}>Send test notification</button>
    <span id="alerts-msg" class="alerts-msg muted" role="status"></span>
  </div>
  <div id="ban-devices" class="ban-route" hidden></div>
</div>
<div class="tk-card">
  <h2>Theme</h2>
  <div class="tk-row st-theme" role="radiogroup" aria-label="Theme">
    <label class="st-opt"><input id="st-theme-system" type="radio" name="st-theme" value="system" /> System</label>
    <label class="st-opt"><input id="st-theme-dark" type="radio" name="st-theme" value="dark" /> Dark</label>
    <label class="st-opt"><input id="st-theme-light" type="radio" name="st-theme" value="light" /> Light</label>
  </div>
</div>
<div class="tk-card">
  <h2>Integrations</h2>
  <ul class="st-list">
    <li><span><span class="tip-term"${tipAttr("The pool of logged-in browsers on the NAS that does every 1001tracklists fetch. Without it nothing is fetched.")}>tlpool</span> (1001tracklists browser pool)</span><span id="int-pool" class="badge neutral">checking…</span></li>
    <li><span><span class="tip-term"${tipAttr("The keys that let the Worker send push notifications to your devices.")}>Web Push</span> (VAPID keys)</span><span id="int-push" class="badge neutral">checking…</span></li>
    <li><span><span class="tip-term"${tipAttr("The shared secret mkvid uses to claim render jobs. Without it no video is queued.")}>mkvid token</span></span><span id="int-mkvid" class="badge neutral">checking…</span></li>
  </ul>
</div>
<div id="sf-app"></div>
<div class="tk-card">
  <div class="st-head">
    <h2><span class="tip-term"${tipAttr("Each time 1001tracklists blocked tracked: when it started, how long it lasted and how many requests went through each route.")}>Ban episodes</span></h2>
    <button id="ban-refresh" type="button" class="btn small"${tipAttr("Reloads the status checks and the ban history.")}>Refresh</button>
  </div>
  <div id="ban-route" class="ban-route"><span class="muted">loading…</span></div>
  <div id="ban-episodes"></div>
</div>
`;

const CSS = /* css */ `
  .btn.small { padding: 5px 10px; font-size: var(--fs-sm); }
  .st-alerts { font-size: var(--fs-sm); }
  .alerts-state.on { color: var(--ok); font-weight: 600; }
  .alerts-state.off { color: var(--muted); font-weight: 600; }
  .alerts-state.err { color: var(--danger); font-weight: 600; }
  #ban-devices { margin-top: var(--sp-3); margin-bottom: 0; }
  .st-theme { gap: var(--sp-4); }
  .st-opt { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
  .st-list { list-style: none; margin: 0; padding: 0; }
  .st-list li { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); padding: 8px 0; border-bottom: 1px solid var(--line); }
  .st-list li:last-child { border-bottom: 0; }
  .st-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); margin-bottom: var(--sp-3); }
  .st-head h2 { margin: 0; }
  .ban-eps td.open { color: var(--danger); font-weight: 600; }
  .ban-eps .muted { color: var(--muted); }
${YOUTUBE_CARD_CSS}
${SETTINGS_FORM_CSS}`;

const JS = /* js */ `
(() => {
${YOUTUBE_CARD_JS}
  const $ = TK.$;

  // -- theme: radios <-> TK.theme <-> the sidebar select --
  const radios = ['system', 'dark', 'light'].map((v) => $('st-theme-' + v)).filter(Boolean);
  const $sel = $('tk-theme');
  function syncTheme() {
    const t = TK.theme.get();
    radios.forEach((r) => { r.checked = r.value === t; });
    if ($sel) $sel.value = t;
  }
  radios.forEach((r) => r.addEventListener('change', () => { if (r.checked) { TK.theme.set(r.value); syncTheme(); } }));
  if ($sel) $sel.addEventListener('change', syncTheme);
  syncTheme();

  // -- integrations --
  function badge(id, on, onText, offText) {
    const el = $(id);
    if (!el) return;
    el.textContent = on === null ? 'unavailable' : on ? onText : offText;
    el.className = 'badge ' + (on === null ? 'neutral' : on ? 'ok' : 'warn');
  }
  async function loadIntegrations() {
    const [st, mk] = await Promise.all([TK.api.get('/ui/api/ban/status'), TK.api.get('/ui/api/mkvid?limit=1')]);
    const s = st.ok && st.data && typeof st.data === 'object' ? st.data : null;
    badge('int-pool', s ? !!s.poolConfigured : null, 'configured', 'not configured');
    badge('int-push', s ? !!s.pushConfigured : null, 'configured', 'not configured');
    const m = mk.ok && mk.data && typeof mk.data === 'object' ? mk.data : null;
    badge('int-mkvid', m ? !!m.enabled : null, 'configured', 'not configured');
  }
  const refreshBtn = $('ban-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', loadIntegrations);

  // -- app settings: field-table cards (ui/pages/settings-form.ts) --
${SETTINGS_FORM_JS}
  const APP_GROUPS = ${JSON.stringify(APP_GROUPS)};
  const $app = $('sf-app');
  // mkvid's extra upload projects (GET mkvidProjects) each get a cap row
  // between the mkvid one and the shared one (the fill order); the cards are
  // mounted again when that list changes.
  let projectSig = '';
  function projectFields(extra) {
    const g = APP_GROUPS.find((x) => x.id === 'sf-mkvid');
    if (!g) return;
    g.fields = g.fields.filter((f) => f.path.indexOf('mkvid.projectCaps.') !== 0);
    const at = g.fields.findIndex((f) => f.path === 'mkvid.sharedDailyClaimCap');
    g.fields.splice(at < 0 ? g.fields.length : at, 0, ...extra.map((p) => ({
      path: 'mkvid.projectCaps.' + p.key,
      label: 'Uploads a day, ' + p.label + ' project',
      help: 'Upload project ' + p.key + ' of mkvid, before the shared one. Blank = ' + ${DEFAULT_PROJECT_DAILY_CLAIM_CAP} + '. 0 pauses it.',
      min: 0, max: 100, step: 1, nullable: true,
    })));
  }
  async function saveApp(patch) {
    const r = await fetch('/ui/api/settings', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    if (!r || !r.ok) return { ok: false, issues: d.issues || [], message: d.issues ? '' : 'Could not save (HTTP ' + (r ? r.status : 0) + ').' };
    loadApp();
    return { ok: true };
  }
  async function loadApp() {
    const r = await fetch('/ui/api/settings', { credentials: 'same-origin' }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    if (!(r && r.ok && d.settings)) return;
    const extra = Array.isArray(d.mkvidProjects) ? d.mkvidProjects : [];
    const sig = extra.map((p) => p.key + '=' + p.label).join(',');
    if (sig !== projectSig && $app) {
      projectSig = sig;
      projectFields(extra);
      SF.mount($app, APP_GROUPS, saveApp);
    }
    const projectCaps = {};
    for (const p of extra) projectCaps[p.key] = ${DEFAULT_PROJECT_DAILY_CLAIM_CAP};
    SF.fill(APP_GROUPS, d.settings, Object.assign({}, d.defaults, { mkvid: Object.assign({}, d.defaults.mkvid, d.effective.mkvid, { projectCaps }), playlists: Object.assign({}, d.defaults.playlists, d.effective.playlists) }));
  }
  if ($app) {
    SF.mount($app, APP_GROUPS, saveApp);
    loadApp();
  }

  YT.handleReturn();
  YT.load();
  loadIntegrations();
})();
`;

export const SETTINGS_PAGE: UiPage = {
  path: "/settings",
  html: shell({
    nav: "settings",
    title: "Settings",
    description:
      "The YouTube connection, notifications, theme, integrations, mkvid uploads, playlists, pre-saves, track uploads and retention.",
    body: BODY,
    css: CSS,
    js: JS,
    banPage: "settings",
  }),
};
