/**
 * App settings: the Worker's own knobs that are not about the fetch pool
 * (those are lib/pool-settings.ts). One JSON document in SUBS KV
 * (`app:settings`), merged over the defaults on every read, edited on
 * /ui/settings through `GET/PUT /ui/api/settings` (routes/app-settings.ts).
 *
 * Every default is the value the code used before these became settings, so
 * nothing changes until a field is saved. A field that used to be an env var
 * or secret is `null` by default and means "the env var, else the old
 * default" (precedence: saved value > env var > code default); the consumer
 * keeps its env parsing, so a deploy that sets the var behaves as before.
 *
 * Reads are memoised per isolate for MEMO_MS, keyed by the KV binding, so a
 * hot path (a claim, a sweep, a prune) adds at most one KV read a half-minute.
 */

import { z } from "zod";
import type { Env } from "../types";
import { mergeSettings } from "./pool-settings";
import { QUOTA_CONSUMERS } from "./quota-consumers";

export const APP_SETTINGS_KEY = "app:settings";
const MEMO_MS = 30_000;

/** The least a day's reorder budget can usefully be: two moves (50 each) and the listings around them. Below it nothing would ever move. */
export const ORDER_MIN_DAILY_UNITS = 110;

/** mkvid's own default for hearthis.at downloads an hour (its lib/hearthis.ts), when neither the setting nor its env var is set. */
export const DEFAULT_HEARTHIS_DOWNLOADS_PER_HOUR = 3;

/** mkvid's own default for hearthis.at page fetches an hour (its lib/hearthis.ts), when neither the setting nor its env var is set. */
export const DEFAULT_HEARTHIS_PAGES_PER_HOUR = 20;

const QUOTA_KEYS = QUOTA_CONSUMERS.map((c) => c.key);

export const AppSettingsSchema = z.object({
  mkvid: z.object({
    /** Uploads a quota day through mkvid's own project; null = MKVID_DAILY_CLAIM_CAP, else 24. 0 pauses. */
    dailyClaimCap: z.number().int().min(0).max(100).nullable(),
    /** Uploads a quota day through the sync's project once the first is full; null = MKVID_SHARED_DAILY_CLAIM_CAP, else 6. */
    sharedDailyClaimCap: z.number().int().min(0).max(100).nullable(),
    /**
     * Uploads a quota day through each extra upload project mkvid reported
     * (key = its project key, e.g. `upload2`); absent or null = 6. 0 pauses
     * that project. Filled between the first and the shared one (lib/mkvid.ts).
     */
    projectCaps: z.record(
      z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
      z.number().int().min(0).max(100).nullable(),
    ),
    /** A claim mkvid has not finished is handed out again after this; null = MKVID_CLAIM_TTL_SECONDS, else 180 min. */
    claimTtlMinutes: z
      .number()
      .int()
      .min(10)
      .max(24 * 60)
      .nullable(),
    /** Failed attempts before a request is parked as failed (default 3). */
    maxAttempts: z.number().int().min(1).max(10),
    /** A retryable failure waits this x attempts before the next claim (default 6 h). */
    retryBackoffHours: z
      .number()
      .min(0.25)
      .max(24 * 7),
    /** mkvid refused a list as unverified: look again after this, no attempt used (default 60 min). */
    unverifiedRetryMinutes: z
      .number()
      .int()
      .min(5)
      .max(24 * 60),
    /** Privacy mkvid uploads a set with (sent on every claim; an mkvid from before this uses its TRACKED_PRIVACY). */
    privacy: z.enum(["public", "unlisted", "private"]),
    /** Every this many hours, delivered videos that are gone from YouTube leave the playlists and are rendered again (default 6). 0 = never. */
    goneCheckHours: z
      .number()
      .min(0)
      .max(24 * 7),
    /** This many recordings "removed" within a day are not believed until the owner confirms (lib/mkvid-removed-burst.ts; default 3). 0 = never; 1 is not "several". */
    removedBurstCount: z
      .number()
      .int()
      .min(0)
      .max(50)
      .refine((n) => n !== 1, { message: "0 (never) or 2 to 50" }),
    /**
     * hearthis.at downloads mkvid makes per rolling hour (sets and audio cue
     * jobs); sent on /mkvid/health, which mkvid reads every poll. null =
     * mkvid's HEARTHIS_DOWNLOADS_PER_HOUR, else 3. 0 pauses hearthis.at.
     */
    hearthisDownloadsPerHour: z.number().int().min(0).max(100).nullable(),
    /**
     * hearthis.at page fetches (embed and track pages, yt-dlp's lookups) mkvid
     * makes per rolling hour; sent on /mkvid/health like the downloads one.
     * null = mkvid's HEARTHIS_PAGES_PER_HOUR, else 20. A set needs 3 free (an
     * audio cue job 4), so 1 and 2 are refused; 0 pauses hearthis.at.
     */
    hearthisPagesPerHour: z
      .number()
      .int()
      .min(0)
      .max(200)
      .refine((n) => n === 0 || n >= 3, { message: "0 (pauses) or 3 to 200" })
      .nullable(),
  }),
  playlists: z.object({
    /** The daily playlist sweep only reports; null = PLAYLIST_SWEEP_DRY_RUN (unset = true). */
    sweepDryRun: z.boolean().nullable(),
    /** Removals a sweep may make per UTC day; null = PLAYLIST_SWEEP_DAILY_REMOVALS, else 40. */
    sweepDailyRemovals: z.number().int().min(0).max(500).nullable(),
    /** Turn down vertical videos (Shorts, portrait phone recordings); null = REJECT_VERTICAL (unset = on). */
    rejectVertical: z.boolean().nullable(),
    /** A video this much shorter than the last cue is not the full set (default 5 min). */
    shortToleranceMinutes: z.number().min(0).max(60),
    /** An audio player this much longer than the video means the video is a cut (default 10 min). */
    audioToleranceMinutes: z.number().min(0).max(120),
    /** Hold a playlist instead of removing when more than this many of its videos went missing at once (default 5)... */
    massRemovalMax: z.number().int().min(0).max(100),
    /** ...or more than this share of it (default 0.3). */
    massRemovalRatio: z.number().min(0).max(1),
    /** Hold every playlist when one run finds more than this many missing in all (default 15). */
    runRemovalMax: z.number().int().min(0).max(500),
    /** Combined-playlist inserts a quota day at most, 50 units each (default 80). */
    combinedDailyInsertCap: z.number().int().min(0).max(190),
    /** Combined-playlist inserts per run at most (default 20). */
    combinedMaxInsertsPerRun: z.number().int().min(0).max(100),
    /** Quota units a quota day the reorder pass may spend moving videos already in the artist playlists into set-date order, listings included (a move is 50). Default 0: paused, no YouTube call at all, until the owner picks a budget. */
    orderDailyUnits: z
      .number()
      .int()
      .min(0)
      .max(10000)
      .refine((n) => n === 0 || n >= ORDER_MIN_DAILY_UNITS, {
        message: `0 (paused) or at least ${ORDER_MIN_DAILY_UNITS}: less cannot pay for reading a playlist and moving one video`,
      }),
    /** Moves one reorder run makes at most (default 10). */
    orderMovesPerRun: z.number().int().min(1).max(100),
  }),
  /** Pre-saved tracks (lib/presave.ts): watched until 1001tracklists has a YouTube link. */
  presave: z.object({
    /** The scheduled recheck runs at all (manual rechecks always work). */
    enabled: z.boolean(),
    /** A watched track is looked up again this often (default 12 h: twice a day). */
    recheckIntervalHours: z
      .number()
      .min(1)
      .max(24 * 30),
    /** Every interval x (1 +/- this), so rechecks spread out (default 0.15). */
    jitterFraction: z.number().min(0).max(0.5),
    /** Rechecks one scheduler tick may run, on top of its other items (default 1). */
    maxPerTick: z.number().int().min(0).max(10),
    /** Pool priority of a scheduled recheck (manual ones go at phone priority). */
    priority: z.enum(["new", "verify", "recheck", "backfill"]),
    /** A failed check (pool refused, page error) is tried again after this (default 60 min). */
    retryMinutes: z
      .number()
      .int()
      .min(5)
      .max(24 * 60),
    /** Push to every device when a pre-saved track gets a YouTube link. */
    notifyFound: z.boolean(),
    /** Like a pre-saved track's video on the connected YouTube account once it has one (lib/presave-like.ts; 50 units each). */
    likeOnYouTube: z.boolean(),
    /** Quota units a quota day the automatic likes may spend (51 each; default 1000). The backfill script is not counted. 0 = none. */
    likeDailyUnitCap: z.number().int().min(0).max(10000),
    /** The YouTube playlist every pre-save with a video goes into (lib/presave-playlist.ts; created when missing). */
    playlistTitle: z.string().trim().min(1).max(150),
    /** Privacy of that playlist when it is created. */
    playlistPrivacy: z.enum(["public", "unlisted", "private"]),
    /** A set page fetched for any reason updates the pre-saved rows of that set (free). */
    useSetFetches: z.boolean(),
    /** Stop watching a track after this many days without a link (0 = never). */
    giveUpDays: z.number().int().min(0).max(3650),
  }),
  /** mkvid track uploads (lib/track-uploads.ts): rip a watched track that only has a non-YouTube link. */
  trackUploads: z.object({
    /** Queue tracks for mkvid at all. */
    enabled: z.boolean(),
    /** A pre-saved track is queued only after it has been watched this long (default 5 days). */
    minWatchDays: z.number().min(0).max(365),
    /** Link sources mkvid may rip (yt-dlp extractors that give the full track), in order of preference. */
    allowedSources: z.array(z.string().min(1).max(40)).max(20),
    /** Track uploads handed out per quota day (they share mkvid's per-project caps; default 4). 0 pauses. */
    dailyCap: z.number().int().min(0).max(100),
    /** The YouTube playlist every track upload goes into (created when missing). */
    playlistTitle: z.string().min(1).max(150),
    /** Privacy mkvid uploads a track with. */
    privacy: z.enum(["public", "unlisted", "private"]),
    /** Push to every device when a track was ripped and uploaded. */
    notifyUploaded: z.boolean(),
    /** Failed attempts before a request is parked as failed (default 3). */
    maxAttempts: z.number().int().min(1).max(10),
    /** A retryable failure waits this x attempts (default 6 h). */
    retryBackoffHours: z
      .number()
      .min(0.25)
      .max(24 * 7),
    /** mkvid refuses a rip shorter than this share of the expected length (a preview clip; default 0.85). */
    minDurationRatio: z.number().min(0).max(1),
  }),
  /** Pre-save matches (lib/presave-match.ts): mkvid searches YouTube Music (and Soulseek) for a pre-save with no YouTube link and compares the audio with its previews. */
  presaveMatch: z.object({
    /** Hand search jobs to mkvid at all. */
    enabled: z.boolean(),
    /** A pre-save is first searched once it has been watched this long (default 48 h: 1001tracklists often links it within a day or two). */
    searchDelayHours: z
      .number()
      .min(0)
      .max(24 * 365),
    /** Searched again this many days after the last search (default 7). */
    researchDays: z.number().min(0.5).max(365),
    /** Searches per pre-save and kind at most (default 4). */
    maxSearches: z.number().int().min(1).max(50),
    /** Search jobs handed out per day at most (default 40). 0 pauses. */
    dailySearchCap: z.number().int().min(0).max(1000),
    /** Candidates one search may post at most (default 6). */
    maxCandidates: z.number().int().min(1).max(20),
    /** Auto-approve: audio score (0..1) against a preview at least this (default 0.7; the same master scores 0.79-0.93, unrelated audio ~0.05). */
    autoApproveScore: z.number().min(0).max(1),
    /** Auto-reject: every preview scores below this (default 0.2). */
    autoRejectScore: z.number().min(0).max(1),
    /** Auto-approve: the candidate's length within this many seconds of the track's (default 5). */
    durationToleranceSeconds: z.number().min(0).max(120),
    /** Auto-approve: artist and title match at least this well (0..1, default 0.6). */
    minNameScore: z.number().min(0).max(1),
    /** Push to every device when candidates wait for approval. */
    notifyReview: z.boolean(),
    /** Search Soulseek too (needs slskd on mkvid). Soulseek files are never auto-approved. */
    soulseek: z.boolean(),
    /** Offer a Spotify rip (burner account on mkvid) when nothing else was found; always behind approval. */
    spotifyRip: z.boolean(),
  }),
  /** Per-track link pre-warm (lib/link-prewarm.ts): the sync queues a parsed set's tracks, the cron looks a few up. */
  linkPrewarm: z.object({
    /** Queue and look up at all (off: nothing is queued and the queue is left as it is). */
    enabled: z.boolean(),
    /** Lookups one 5-minute cron tick makes at most, at pool priority backfill (default 3: at most 864 a day). Cached ids cost none. */
    maxPerTick: z.number().int().min(0).max(20),
  }),
  /** Track-page set lists (lib/track-sets.ts): the cron reads which sets each followed set's track was played in (the Recommended sets page). */
  trackSets: z.object({
    /** Crawl at all (off: nothing is fetched; what was stored stays). */
    enabled: z.boolean(),
    /** Page views one 5-minute cron tick spends at most, at pool priority backfill (default 200: a safety cap; the time below and the pool's backfill share are what limit it). */
    viewsPerTick: z.number().int().min(0).max(1000),
    /** Wall-clock seconds one cron tick keeps crawling (default 200; a view takes ~3 s). */
    tickSeconds: z.number().int().min(10).max(280),
    /**
     * Share (0..1) of the pool's backfill allowance the crawl may spend over 24 h, page loads and scroll XHRs apart
     * (default 0.75): the other backfill jobs keep the rest. A track costs one page load, so this is what paces the
     * crawl; measured 2026-10-23 the other backfill jobs spent ~20% of the page allowance (DJ history set pages and
     * the pool's context pages for link lookups), so 0.75 leaves them that and a small margin.
     */
    maxShare: z.number().min(0.05).max(1),
    /** Sets one scroll request asks for (the browser asks for 10; default 100). */
    stepCount: z.number().int().min(10).max(500),
    /** A walk stops at the first set from this year or earlier (default 2020). */
    stopYear: z.number().int().min(2000).max(2100),
    /** A track played in very many sets: once a walk has seen this many (default 300)... */
    busyRows: z.number().int().min(15).max(10000),
    /** ...it stops at the first set from this year or earlier instead (default 2022). */
    busyStopYear: z.number().int().min(2000).max(2100),
    /** Scroll requests one walk makes at most, after page 1 (default 20). */
    maxSteps: z.number().int().min(0).max(200),
    /** A crawled track is read again after this many days, down to the first set it already has (default 30). */
    recrawlDays: z.number().min(1).max(3650),
  }),
  /** Apple Music timing backstop for held mkvid sets (lib/apple-cues.ts). */
  appleCues: z.object({
    /** Fill missing cue times of a held list from the set's Apple Music album at all. */
    enabled: z.boolean(),
    /** The album is used only when at least this share of the list's base rows matches one of its tracks (default 0.7). */
    minMatchShare: z.number().min(0.1).max(1),
    /** The album's length must be within the larger of this percent and the minutes below of the source audio (default 3 %). */
    lengthTolerancePct: z.number().min(0).max(50),
    lengthToleranceMinutes: z.number().min(0).max(60),
  }),
  /** The Graph tab (lib/graph/*): view limits and the backfill of sources and credits. */
  graph: z.object({
    /** Most nodes one graph answer or the whole-library view holds (default 5,000). */
    nodeCap: z.number().int().min(100).max(1_000_000),
    /** An expansion adding more new nodes than this asks first (default 300). */
    confirmOver: z.number().int().min(10).max(1_000_000),
    /** Refetch sets read before the graph existed, once each, through the search index catch-up (pool priority backfill, its perTick / perDay caps). */
    backfill: z.boolean(),
    /** Stored set pages (R2) the 5-minute cron reads for the graph a tick; no pool fetch (default 10). 0 = none. */
    pagesPerTick: z.number().int().min(0).max(100),
  }),
  /** Set and track page metadata (lib/set-meta.ts). */
  genres: z.object({
    /** Stored set pages (R2) the 5-minute cron reads a tick for their genres and the rest of the page; no pool fetch (default 20). 0 = none. */
    metaPagesPerTick: z.number().int().min(0).max(100),
  }),
  /** YouTube quota: who goes first when the pool runs short (lib/quota-consumers.ts has the catalogue). */
  quota: z.object({
    /** Consumer keys, highest rank first. Owner actions always go before all of them. */
    order: z
      .array(z.string())
      .refine((o) => o.length === QUOTA_KEYS.length && QUOTA_KEYS.every((k) => o.includes(k)), {
        message: "must list every quota consumer exactly once",
      }),
    /** Units always left in the pool for owner actions (default 300). */
    margin: z.number().int().min(0).max(5000),
    /** Units one Google project may spend a quota day (default 10,000). */
    projectBudget: z.number().int().min(1).max(1_000_000),
    /** Per consumer: keep at least `min` units for it, let it spend at most `max` a day (null = none), or switch it off. A missing entry is filled from the old caps on read (migrateQuotaConsumers). */
    consumers: z
      .record(
        z.string(),
        z.object({
          min: z.number().int().min(0).max(1_000_000).nullable(),
          max: z.number().int().min(0).max(1_000_000).nullable(),
          enabled: z.boolean(),
        }),
      )
      .refine((c) => Object.keys(c).every((k) => QUOTA_KEYS.includes(k)), {
        message: "unknown quota consumer",
      }),
  }),
  retention: z.object({
    /** Now-playing and playlist-addition audit rows are kept this many days (default 90). */
    auditDays: z.number().int().min(1).max(3650),
    /** Scheduler tick history is kept this many days (default 14). */
    tickHistoryDays: z.number().int().min(1).max(365),
  }),
});

export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const DEFAULT_APP_SETTINGS: AppSettings = {
  mkvid: {
    dailyClaimCap: null,
    sharedDailyClaimCap: null,
    projectCaps: {},
    claimTtlMinutes: null,
    maxAttempts: 3,
    retryBackoffHours: 6,
    unverifiedRetryMinutes: 60,
    privacy: "unlisted",
    goneCheckHours: 6,
    removedBurstCount: 3,
    hearthisDownloadsPerHour: null,
    hearthisPagesPerHour: null,
  },
  playlists: {
    sweepDryRun: null,
    sweepDailyRemovals: null,
    rejectVertical: null,
    shortToleranceMinutes: 5,
    audioToleranceMinutes: 10,
    massRemovalMax: 5,
    massRemovalRatio: 0.3,
    runRemovalMax: 15,
    combinedDailyInsertCap: 80,
    combinedMaxInsertsPerRun: 20,
    orderDailyUnits: 0,
    orderMovesPerRun: 10,
  },
  presave: {
    enabled: true,
    recheckIntervalHours: 12,
    jitterFraction: 0.15,
    maxPerTick: 1,
    priority: "recheck",
    retryMinutes: 60,
    notifyFound: true,
    likeOnYouTube: true,
    likeDailyUnitCap: 1000,
    playlistTitle: "Pre-saves",
    playlistPrivacy: "unlisted",
    useSetFetches: true,
    giveUpDays: 0,
  },
  trackUploads: {
    enabled: true,
    minWatchDays: 5,
    allowedSources: ["soundcloud", "bandcamp", "hearthis", "mixcloud"],
    dailyCap: 4,
    playlistTitle: "Track uploads",
    privacy: "unlisted",
    notifyUploaded: true,
    maxAttempts: 3,
    retryBackoffHours: 6,
    minDurationRatio: 0.85,
  },
  presaveMatch: {
    enabled: true,
    searchDelayHours: 48,
    researchDays: 7,
    maxSearches: 4,
    dailySearchCap: 40,
    maxCandidates: 6,
    autoApproveScore: 0.7,
    autoRejectScore: 0.2,
    durationToleranceSeconds: 5,
    minNameScore: 0.6,
    notifyReview: true,
    soulseek: false,
    spotifyRip: false,
  },
  linkPrewarm: { enabled: true, maxPerTick: 3 },
  trackSets: {
    enabled: true,
    viewsPerTick: 200,
    tickSeconds: 200,
    maxShare: 0.75,
    stepCount: 100,
    stopYear: 2020,
    busyRows: 300,
    busyStopYear: 2022,
    maxSteps: 20,
    recrawlDays: 30,
  },
  appleCues: {
    enabled: true,
    minMatchShare: 0.7,
    lengthTolerancePct: 3,
    lengthToleranceMinutes: 2,
  },
  graph: { nodeCap: 5000, confirmOver: 300, backfill: true, pagesPerTick: 10 },
  genres: { metaPagesPerTick: 20 },
  quota: {
    order: [
      "likes",
      "presave_playlists",
      "dj_playlists",
      "hygiene",
      "mkvid_uploads",
      "mkvid_recreate",
      "combined",
      "renames",
      "ordering",
    ],
    margin: 300,
    projectBudget: 10000,
    consumers: {},
  },
  retention: { auditDays: 90, tickHistoryDays: 14 },
};

/** Sweep removals a day when neither the setting nor PLAYLIST_SWEEP_DAILY_REMOVALS is set (as lib/playlist-hygiene.ts). */
/** Pinned to playlist-hygiene's DEFAULT_SWEEP_DAILY_REMOVALS by test/quota-settings.test.ts. */
export const DEFAULT_SWEEP_REMOVALS = 40;

function sweepRemovals(s: AppSettings, env: { PLAYLIST_SWEEP_DAILY_REMOVALS?: string }): number {
  if (s.playlists.sweepDailyRemovals !== null) return s.playlists.sweepDailyRemovals;
  const raw = env.PLAYLIST_SWEEP_DAILY_REMOVALS;
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(n) && n >= 0
    ? Math.floor(n)
    : DEFAULT_SWEEP_REMOVALS;
}

/**
 * Fill every quota consumer that has no entry yet from the old per-feature
 * caps (their live values), so the owner's current limits carry over. Pure:
 * nothing is written; an entry already present is never touched.
 */
export function migrateQuotaConsumers(
  s: AppSettings,
  env: { PLAYLIST_SWEEP_DAILY_REMOVALS?: string },
): AppSettings {
  const have = s.quota.consumers;
  const fill: AppSettings["quota"]["consumers"] = {};
  if (!have.ordering) {
    const units = s.playlists.orderDailyUnits;
    fill.ordering = { min: null, max: units, enabled: units > 0 };
  }
  if (!have.combined)
    fill.combined = { min: null, max: s.playlists.combinedDailyInsertCap * 50, enabled: true };
  if (!have.hygiene) fill.hygiene = { min: null, max: sweepRemovals(s, env) * 51, enabled: true };
  if (!have.likes) fill.likes = { min: null, max: s.presave.likeDailyUnitCap, enabled: true };
  if (Object.keys(fill).length === 0) return s;
  return { ...s, quota: { ...s.quota, consumers: { ...have, ...fill } } };
}

/**
 * A stored quota group made whole before it is validated: `order` keeps its
 * known keys once each, in its own order, then the missing ones in the
 * default order; an entry in `consumers` for a key no longer known is
 * dropped. Without it one stale key would send the WHOLE document back to
 * the defaults. Read path only: a PATCH is still held to the strict schema.
 */
export function normaliseStoredQuota(stored: unknown): unknown {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return stored;
  const quota = (stored as { quota?: unknown }).quota;
  if (!quota || typeof quota !== "object" || Array.isArray(quota)) return stored;
  const q = { ...(quota as Record<string, unknown>) };
  if (Array.isArray(q.order)) {
    const known = [...new Set(q.order.filter((k): k is string => QUOTA_KEYS.includes(k)))];
    q.order = [...known, ...DEFAULT_APP_SETTINGS.quota.order.filter((k) => !known.includes(k))];
  }
  if (q.consumers && typeof q.consumers === "object" && !Array.isArray(q.consumers))
    q.consumers = Object.fromEntries(
      Object.entries(q.consumers).filter(([k]) => QUOTA_KEYS.includes(k)),
    );
  return { ...(stored as Record<string, unknown>), quota: q };
}

const memo = new WeakMap<object, { at: number; value: AppSettings }>();

/** Current settings: the stored document over the defaults (memoised MEMO_MS). One that no longer validates is ignored. */
export async function getAppSettings(
  env: Partial<Pick<Env, "SUBS" | "PLAYLIST_SWEEP_DAILY_REMOVALS">>,
): Promise<AppSettings> {
  const kv = env.SUBS;
  if (!kv) return migrateQuotaConsumers(DEFAULT_APP_SETTINGS, env);
  const hit = memo.get(kv);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.value;
  let stored: unknown;
  try {
    stored = await kv.get(APP_SETTINGS_KEY, "json");
  } catch {
    stored = null;
  }
  const parsed = stored
    ? AppSettingsSchema.safeParse(mergeSettings(DEFAULT_APP_SETTINGS, normaliseStoredQuota(stored)))
    : null;
  const value = migrateQuotaConsumers(parsed?.success ? parsed.data : DEFAULT_APP_SETTINGS, env);
  memo.set(kv, { at: Date.now(), value });
  return value;
}

export type AppSettingsUpdate =
  { ok: true; settings: AppSettings } | { ok: false; issues: string[] };

/** Apply a partial update (deep-merged over the current settings), validate, store. `null` resets an env-backed field. */
export async function updateAppSettings(
  env: Pick<Env, "SUBS"> & Partial<Pick<Env, "PLAYLIST_SWEEP_DAILY_REMOVALS">>,
  patch: unknown,
): Promise<AppSettingsUpdate> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    return { ok: false, issues: ["body: expected a JSON object"] };
  memo.delete(env.SUBS);
  const current = await getAppSettings(env);
  const parsed = AppSettingsSchema.safeParse(mergeSettings(current, patch));
  if (!parsed.success)
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`),
    };
  await env.SUBS.put(APP_SETTINGS_KEY, JSON.stringify(parsed.data));
  memo.set(env.SUBS, { at: Date.now(), value: parsed.data });
  return { ok: true, settings: parsed.data };
}
