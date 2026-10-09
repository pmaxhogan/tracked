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

import { z } from 'zod'
import type { Env } from '../types'
import { mergeSettings } from './pool-settings'

export const APP_SETTINGS_KEY = 'app:settings'
const MEMO_MS = 30_000

export const AppSettingsSchema = z.object({
  mkvid: z.object({
    /** Uploads a quota day through mkvid's own project; null = MKVID_DAILY_CLAIM_CAP, else 24. 0 pauses. */
    dailyClaimCap: z.number().int().min(0).max(100).nullable(),
    /** Uploads a quota day through the sync's project once the first is full; null = MKVID_SHARED_DAILY_CLAIM_CAP, else 6. */
    sharedDailyClaimCap: z.number().int().min(0).max(100).nullable(),
    /** A claim mkvid has not finished is handed out again after this; null = MKVID_CLAIM_TTL_SECONDS, else 180 min. */
    claimTtlMinutes: z.number().int().min(10).max(24 * 60).nullable(),
    /** Failed attempts before a request is parked as failed (default 3). */
    maxAttempts: z.number().int().min(1).max(10),
    /** A retryable failure waits this × attempts before the next claim (default 6 h). */
    retryBackoffHours: z.number().min(0.25).max(24 * 7),
    /** mkvid refused a list as unverified: look again after this, no attempt used (default 60 min). */
    unverifiedRetryMinutes: z.number().int().min(5).max(24 * 60),
  }),
  playlists: z.object({
    /** The daily playlist sweep only reports; null = PLAYLIST_SWEEP_DRY_RUN (unset = true). */
    sweepDryRun: z.boolean().nullable(),
    /** Removals a sweep may make per UTC day; null = PLAYLIST_SWEEP_DAILY_REMOVALS, else 40. */
    sweepDailyRemovals: z.number().int().min(0).max(500).nullable(),
    /** Turn down vertical videos (Shorts); null = REJECT_VERTICAL (unset = off). */
    rejectVertical: z.boolean().nullable(),
    /** A video this much shorter than the last cue is not the full set (default 5 min). */
    shortToleranceMinutes: z.number().min(0).max(60),
    /** An audio player this much longer than the video means the video is a cut (default 10 min). */
    audioToleranceMinutes: z.number().min(0).max(120),
    /** Hold a playlist instead of removing when more than this many of its videos went missing at once (default 5)… */
    massRemovalMax: z.number().int().min(0).max(100),
    /** …or more than this share of it (default 0.3). */
    massRemovalRatio: z.number().min(0).max(1),
    /** Hold every playlist when one run finds more than this many missing in all (default 15). */
    runRemovalMax: z.number().int().min(0).max(500),
    /** Combined-playlist inserts a quota day at most, 50 units each (default 80). */
    combinedDailyInsertCap: z.number().int().min(0).max(190),
    /** Combined-playlist inserts per run at most (default 20). */
    combinedMaxInsertsPerRun: z.number().int().min(0).max(100),
  }),
  /** Pre-saved tracks (lib/presave.ts): watched until 1001tracklists has a YouTube link. */
  presave: z.object({
    /** The scheduled recheck runs at all (manual rechecks always work). */
    enabled: z.boolean(),
    /** A watched track is looked up again this often (default 12 h: twice a day). */
    recheckIntervalHours: z.number().min(1).max(24 * 30),
    /** Every interval × (1 ± this), so rechecks spread out (default 0.15). */
    jitterFraction: z.number().min(0).max(0.5),
    /** Rechecks one scheduler tick may run, on top of its other items (default 1). */
    maxPerTick: z.number().int().min(0).max(10),
    /** Pool priority of a scheduled recheck (manual ones go at phone priority). */
    priority: z.enum(['new', 'verify', 'recheck', 'backfill']),
    /** A failed check (pool refused, page error) is tried again after this (default 60 min). */
    retryMinutes: z.number().int().min(5).max(24 * 60),
    /** Push to every device when a pre-saved track gets a YouTube link. */
    notifyFound: z.boolean(),
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
    privacy: z.enum(['public', 'unlisted', 'private']),
    /** Push to every device when a track was ripped and uploaded. */
    notifyUploaded: z.boolean(),
    /** Failed attempts before a request is parked as failed (default 3). */
    maxAttempts: z.number().int().min(1).max(10),
    /** A retryable failure waits this × attempts (default 6 h). */
    retryBackoffHours: z.number().min(0.25).max(24 * 7),
    /** mkvid refuses a rip shorter than this share of the expected length (a preview clip; default 0.85). */
    minDurationRatio: z.number().min(0).max(1),
  }),
  retention: z.object({
    /** Now-playing and playlist-addition audit rows are kept this many days (default 90). */
    auditDays: z.number().int().min(1).max(3650),
    /** Scheduler tick history is kept this many days (default 14). */
    tickHistoryDays: z.number().int().min(1).max(365),
  }),
})

export type AppSettings = z.infer<typeof AppSettingsSchema>

export const DEFAULT_APP_SETTINGS: AppSettings = {
  mkvid: { dailyClaimCap: null, sharedDailyClaimCap: null, claimTtlMinutes: null, maxAttempts: 3, retryBackoffHours: 6, unverifiedRetryMinutes: 60 },
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
  },
  presave: {
    enabled: true,
    recheckIntervalHours: 12,
    jitterFraction: 0.15,
    maxPerTick: 1,
    priority: 'recheck',
    retryMinutes: 60,
    notifyFound: true,
    useSetFetches: true,
    giveUpDays: 0,
  },
  trackUploads: {
    enabled: true,
    minWatchDays: 5,
    allowedSources: ['soundcloud', 'bandcamp', 'hearthis', 'mixcloud'],
    dailyCap: 4,
    playlistTitle: 'Track uploads',
    privacy: 'unlisted',
    notifyUploaded: true,
    maxAttempts: 3,
    retryBackoffHours: 6,
    minDurationRatio: 0.85,
  },
  retention: { auditDays: 90, tickHistoryDays: 14 },
}

const memo = new WeakMap<object, { at: number; value: AppSettings }>()

/** Current settings: the stored document over the defaults (memoised MEMO_MS). One that no longer validates is ignored. */
export async function getAppSettings(env: Partial<Pick<Env, 'SUBS'>>): Promise<AppSettings> {
  const kv = env.SUBS
  if (!kv) return DEFAULT_APP_SETTINGS
  const hit = memo.get(kv)
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.value
  let stored: unknown = null
  try {
    stored = await kv.get(APP_SETTINGS_KEY, 'json')
  } catch {
    stored = null
  }
  const parsed = stored ? AppSettingsSchema.safeParse(mergeSettings(DEFAULT_APP_SETTINGS, stored)) : null
  const value = parsed?.success ? parsed.data : DEFAULT_APP_SETTINGS
  memo.set(kv, { at: Date.now(), value })
  return value
}

export type AppSettingsUpdate = { ok: true; settings: AppSettings } | { ok: false; issues: string[] }

/** Apply a partial update (deep-merged over the current settings), validate, store. `null` resets an env-backed field. */
export async function updateAppSettings(env: Pick<Env, 'SUBS'>, patch: unknown): Promise<AppSettingsUpdate> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, issues: ['body: expected a JSON object'] }
  memo.delete(env.SUBS)
  const current = await getAppSettings(env)
  const parsed = AppSettingsSchema.safeParse(mergeSettings(current, patch))
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) }
  await env.SUBS.put(APP_SETTINGS_KEY, JSON.stringify(parsed.data))
  memo.set(env.SUBS, { at: Date.now(), value: parsed.data })
  return { ok: true, settings: parsed.data }
}
