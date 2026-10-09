/**
 * Pre-saved tracks (D1 `presaves` + `presave_checks`, migration 0016): a
 * track 1001tracklists has no YouTube link for yet, watched until it gets one.
 *
 * Identity is what was known when it was saved:
 *   - a numeric medialink `track_id` (stage `links`): rechecked with one
 *     uncached medialink lookup that reads every source;
 *   - only a track page URL whose medialink id could not be read (stage
 *     `identify`, keyed by `track_url`): the track page is fetched again;
 *   - a set row with no id at all, anonymous "ID - ID" or "Artist - ID"
 *     (stage `identify`, keyed by `set_url` + `row_index`, with `cue_seconds`
 *     and the identified neighbours as anchors): the set page is read again,
 *     the cached list when it is newer than the last check, else one fetch.
 * An identified row takes the row's track id and moves on to `links` in the
 * same call. A YouTube link moves it to `found` and pushes to every device;
 * none hands it to mkvid's track uploads (lib/track-uploads.ts), which decides
 * by itself whether it is due.
 *
 * Every check appends a `presave_checks` row. A pool refusal changes nothing
 * but the failure count and the next check time, and the scheduler reads it
 * as a refusal (the tick stops). Times are unix ms throughout this module.
 */

import type { Env } from '../types'
import { dbOf, parseJson } from './db'
import { errorFields, makeLogger, type Logger } from './log'
import { getAppSettings, type AppSettings } from './app-settings'
import type { PoolFaultCode, PoolPriority } from './pool'
import {
  fetchAllMediaLinks,
  fetchTrackPageMediaId,
  linkNames,
  maxDuration,
  normalizeTrackUrl,
  youtubeIdOf,
  type LinkEntry,
} from './medialinks-all'
import { fetchTracklist, normalizeTracklistUrl, type PageRow, type ScrapedTracklist } from './tracklists1001'
import { cacheParsedTracklist, readCachedTracklist, tracklistSlug } from './tracklist-cache'
import { recordPageFacts } from './playlist-hygiene'
import { fetchOptsFromEnv, UpstreamPausedError, UpstreamUnavailableError } from './upstream1001'
import { IPBlockedError } from './fetch'
import { poolCodeOf } from './pool'
import { presaveFoundPayload, sendPushToAll } from './web-push'
import { labelFromSetUrl } from './activity'
import { maybeQueueTrackUpload, supersedeTrackUploadsForPresave } from './track-uploads'

const HOUR_MS = 3600_000
const DAY_MS = 24 * HOUR_MS
/** A cue this close (seconds) to the saved one is the same row. */
const CUE_TOLERANCE = 2

export const PRESAVE_STAGES = ['identify', 'links', 'found', 'uploaded', 'dismissed'] as const
export type PresaveStage = (typeof PRESAVE_STAGES)[number]
export const PRESAVE_TRIGGERS = ['scheduled', 'manual', 'add', 'set_fetch', 'upload'] as const
export type PresaveTrigger = (typeof PRESAVE_TRIGGERS)[number]
export const PRESAVE_RESULTS = ['found', 'no_youtube', 'identified', 'still_id', 'row_missing', 'uploaded', 'pool_refused', 'error', 'added', 'gave_up'] as const
export type PresaveResult = (typeof PRESAVE_RESULTS)[number]
export const PRESAVE_SOURCES = ['ui', 'tasker', 'api'] as const
export type PresaveSource = (typeof PRESAVE_SOURCES)[number]
/** The link names the UI filters on (`none` = no links at all). */
export const PRESAVE_LINK_SOURCES = ['spotify', 'apple', 'soundcloud', 'beatport', 'traxsource', 'youtube', 'bandcamp', 'hearthis', 'mixcloud', 'deezer', 'tidal', 'amazon', 'audiomack', 'none'] as const

/** A `presaves` row as D1 returns it. */
export type PresaveRow = {
  id: number
  track_id: string | null
  track_url: string | null
  set_url: string | null
  row_index: number | null
  cue_seconds: number | null
  prev_track_id: string | null
  next_track_id: string | null
  artist: string | null
  title: string | null
  artwork_url: string | null
  label: string | null
  dj_slug: string | null
  stage: PresaveStage
  links: string | null
  link_sources: string | null
  link_count: number
  duration_seconds: number | null
  youtube_video_id: string | null
  source: string
  created_at: number
  updated_at: number
  last_checked_at: number | null
  next_check_at: number | null
  check_count: number
  fail_count: number
  last_result: string | null
  last_error: string | null
  identified_at: number | null
  found_at: number | null
  notified_at: number | null
  dismissed_at: number | null
}

export type PresaveCheckRow = {
  id: number
  presave_id: number
  at: number
  trigger: string
  result: string
  stage_before: string | null
  stage_after: string | null
  link_count: number | null
  link_sources: string | null
  youtube_video_id: string | null
  error: string | null
  ms: number | null
  detail: string | null
}

export type PresaveOut = {
  id: number
  trackId: string | null
  trackUrl: string | null
  setUrl: string | null
  rowIndex: number | null
  cueSeconds: number | null
  artist: string | null
  title: string | null
  artworkUrl: string | null
  label: string | null
  djSlug: string | null
  stage: PresaveStage
  links: LinkEntry[]
  linkSources: string[]
  linkCount: number
  durationSeconds: number | null
  youtubeVideoId: string | null
  youtubeUrl: string | null
  youtubeMusicUrl: string | null
  source: string
  createdAt: number
  updatedAt: number
  lastCheckedAt: number | null
  nextCheckAt: number | null
  checkCount: number
  failCount: number
  lastResult: string | null
  lastError: string | null
  identifiedAt: number | null
  foundAt: number | null
  notifiedAt: number | null
  dismissedAt: number | null
  /** createdAt + trackUploads.minWatchDays: when mkvid may rip it. */
  uploadEligibleAt: number
}

export type PresaveCheckOut = {
  id: number
  presaveId: number
  at: number
  trigger: string
  result: string
  stageBefore: string | null
  stageAfter: string | null
  linkCount: number | null
  linkSources: string[]
  youtubeVideoId: string | null
  error: string | null
  ms: number | null
  detail: unknown
}

/** `,a,b,` → ['a','b']. */
export function splitSources(s: string | null | undefined): string[] {
  return (s ?? '').split(',').filter(Boolean)
}

/** ['a','b'] → `,a,b,` (null when empty). */
function joinSources(names: readonly string[]): string | null {
  return names.length ? `,${names.join(',')},` : null
}

export const youtubeUrlOf = (id: string | null): string | null => (id ? `https://www.youtube.com/watch?v=${id}` : null)
export const youtubeMusicUrlOf = (id: string | null): string | null => (id ? `https://music.youtube.com/watch?v=${id}` : null)

export function presaveOut(r: PresaveRow, settings: Pick<AppSettings, 'trackUploads'>): PresaveOut {
  return {
    id: r.id,
    trackId: r.track_id,
    trackUrl: r.track_url,
    setUrl: r.set_url,
    rowIndex: r.row_index,
    cueSeconds: r.cue_seconds,
    artist: r.artist,
    title: r.title,
    artworkUrl: r.artwork_url,
    label: r.label,
    djSlug: r.dj_slug,
    stage: r.stage,
    links: parseJson<LinkEntry[]>(r.links, []),
    linkSources: splitSources(r.link_sources),
    linkCount: Number(r.link_count) || 0,
    durationSeconds: r.duration_seconds,
    youtubeVideoId: r.youtube_video_id,
    youtubeUrl: youtubeUrlOf(r.youtube_video_id),
    youtubeMusicUrl: youtubeMusicUrlOf(r.youtube_video_id),
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastCheckedAt: r.last_checked_at,
    nextCheckAt: r.next_check_at,
    checkCount: Number(r.check_count) || 0,
    failCount: Number(r.fail_count) || 0,
    lastResult: r.last_result,
    lastError: r.last_error,
    identifiedAt: r.identified_at,
    foundAt: r.found_at,
    notifiedAt: r.notified_at,
    dismissedAt: r.dismissed_at,
    uploadEligibleAt: r.created_at + Math.round(settings.trackUploads.minWatchDays * DAY_MS),
  }
}

export function presaveCheckOut(c: PresaveCheckRow): PresaveCheckOut {
  return {
    id: c.id,
    presaveId: c.presave_id,
    at: c.at,
    trigger: c.trigger,
    result: c.result,
    stageBefore: c.stage_before,
    stageAfter: c.stage_after,
    linkCount: c.link_count,
    linkSources: splitSources(c.link_sources),
    youtubeVideoId: c.youtube_video_id,
    error: c.error,
    ms: c.ms,
    detail: parseJson<unknown>(c.detail, null),
  }
}

/** Bad input to addPresave (the routes answer 400 with `message`). */
export class PresaveInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PresaveInputError'
  }
}

export type PresaveInput = {
  trackId?: string | number | null
  trackUrl?: string | null
  setUrl?: string | null
  rowIndex?: number | null
  cueSeconds?: number | null
  artist?: string | null
  title?: string | null
  artworkUrl?: string | null
  label?: string | null
  djSlug?: string | null
}

type Opts = { log?: Logger; now?: number; random?: () => number }

export async function getPresaveRow(env: Env, id: number): Promise<PresaveRow | null> {
  return dbOf(env).prepare('SELECT * FROM presaves WHERE id = ?').bind(id).first<PresaveRow>()
}

export async function listPresaveChecks(env: Env, presaveId: number, limit = 200): Promise<PresaveCheckRow[]> {
  return (await dbOf(env).prepare('SELECT * FROM presave_checks WHERE presave_id = ? ORDER BY at DESC, id DESC LIMIT ?').bind(presaveId, limit).all<PresaveCheckRow>()).results
}

/** Next scheduled check: now + interval × (1 ± jitter). */
export function nextCheckAt(settings: Pick<AppSettings, 'presave'>, now: number, random: () => number = Math.random): number {
  const interval = settings.presave.recheckIntervalHours * HOUR_MS
  const j = settings.presave.jitterFraction
  return Math.round(now + interval * (1 + (random() * 2 - 1) * j))
}

/**
 * The row's cue: a "w/" row's printed time, else the cue it shares (a "w/"
 * row with no time of its own shares its base row's, which is also what the
 * phone sends as cueSeconds for it).
 */
export const cueOf = (r: Pick<PageRow, 'ownStartSeconds' | 'startSeconds'>): number | null => r.ownStartSeconds ?? r.startSeconds ?? null

/**
 * The row's medialink id, or null. `mediaId` undefined is a list cached before
 * the field existed: its `trackId` may be a page position (a row's data-id),
 * which is no track at all, so it counts as no id.
 */
export const rowMediaId = (r: Pick<PageRow, 'anonymous' | 'mediaId'>): string | null =>
  !r.anonymous && typeof r.mediaId === 'string' && /^\d+$/.test(r.mediaId) ? r.mediaId : null

/** A row 1001tracklists has identified: named, not "ID", with a numeric medialink id. */
export function rowIdentified(r: PageRow): boolean {
  return !r.isUnidentified && rowMediaId(r) !== null
}

/** The identified neighbours of row `i` (their medialink ids): the anchors when rows shift. */
function anchorsOf(rows: readonly PageRow[], i: number): { prev: string | null; next: string | null } {
  let prev: string | null = null
  let next: string | null = null
  for (let k = i - 1; k >= 0; k--) if (rowIdentified(rows[k]!)) { prev = rowMediaId(rows[k]!); break }
  for (let k = i + 1; k < rows.length; k++) if (rowIdentified(rows[k]!)) { next = rowMediaId(rows[k]!); break }
  return { prev, next }
}

/**
 * Where a saved row is on a (re)read page: its track URL (a track-URL save),
 * then the same cue (± 2 s), then the anchors (right after the previous
 * identified track, right before the next), then its old index.
 *
 * Every caller looks for a row saved while it had no id (identify stage, or a
 * save by cue alone), and a "w/" row with no printed time shares its base
 * row's cue, so a cue can match the base row too. Among the cue matches:
 *   - a row that IS one of the anchors (the identified neighbours recorded at
 *     save time) is never the saved row;
 *   - unidentified rows come before identified ones (the saved row was
 *     unidentified, and usually still is);
 *   - within that set, the nearest to the old index; then a row whose own
 *     printed cue matches before one that only shares it; then the first.
 */
export function findPresaveRow(
  rows: readonly PageRow[],
  p: Pick<PresaveRow, 'track_url' | 'cue_seconds' | 'prev_track_id' | 'next_track_id' | 'row_index'>,
): { index: number; how: 'track_url' | 'cue' | 'prev_anchor' | 'next_anchor' | 'row_index' } | null {
  if (rows.length === 0) return null
  if (p.track_url) {
    const i = rows.findIndex((r) => r.trackUrl && normalizeTrackUrl(r.trackUrl) === p.track_url)
    if (i >= 0) return { index: i, how: 'track_url' }
  }
  if (p.cue_seconds !== null && p.cue_seconds !== undefined) {
    const cue = p.cue_seconds
    const anchors = new Set([p.prev_track_id, p.next_track_id].filter((x): x is string => !!x))
    const matches: number[] = []
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!
      const c = cueOf(r)
      if (c === null || Math.abs(c - cue) > CUE_TOLERANCE) continue
      const id = rowMediaId(r)
      if (id !== null && anchors.has(id)) continue
      matches.push(i)
    }
    const unidentified = matches.filter((i) => !rowIdentified(rows[i]!))
    const pool = unidentified.length ? unidentified : matches
    const ownCue = (i: number) => {
      const o = rows[i]!.ownStartSeconds
      return o !== null && o !== undefined && Math.abs(o - cue) <= CUE_TOLERANCE ? 0 : 1
    }
    const dist = (i: number) => (p.row_index !== null && p.row_index !== undefined ? Math.abs(i - p.row_index) : 0)
    const best = [...pool].sort((a, b) => dist(a) - dist(b) || ownCue(a) - ownCue(b) || a - b)[0]
    if (best !== undefined) return { index: best, how: 'cue' }
  }
  if (p.prev_track_id) {
    const i = rows.findIndex((r) => rowMediaId(r) === p.prev_track_id)
    if (i >= 0 && i + 1 < rows.length) return { index: i + 1, how: 'prev_anchor' }
  }
  if (p.next_track_id) {
    const i = rows.findIndex((r) => rowMediaId(r) === p.next_track_id)
    if (i > 0) return { index: i - 1, how: 'next_anchor' }
  }
  if (p.row_index !== null && p.row_index >= 0 && p.row_index < rows.length) return { index: p.row_index, how: 'row_index' }
  return null
}

/** H:MM:SS / M:SS. */
function clock(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const ss = String(sec % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** "Artist – Title", "Artist – ID", or "the unidentified track at 1:02:03 in <set>" (never "ID – ID"). */
function displayName(r: Pick<PresaveRow, 'artist' | 'title' | 'cue_seconds' | 'set_url' | 'track_id'>): string {
  const a = r.artist && r.artist !== 'ID' ? r.artist : null
  const t = r.title && r.title !== 'ID' ? r.title : null
  if (a && t) return `${a} – ${t}`
  if (a) return `${a} – ID`
  if (t) return t
  if (r.track_id) return `track ${r.track_id}`
  const at = r.cue_seconds !== null && r.cue_seconds !== undefined ? ` at ${clock(r.cue_seconds)}` : ''
  const set = r.set_url ? ` in ${labelFromSetUrl(r.set_url)}` : ''
  return `the unidentified track${at}${set}`
}

// ─── checks ────────────────────────────────────────────────────────────────

type CheckFields = {
  trigger: PresaveTrigger
  result: PresaveResult
  error?: string | null
  ms?: number | null
  detail?: unknown
  links?: LinkEntry[] | null
}

type CheckWrite = {
  presave: PresaveRow
  check: PresaveCheckRow
  /**
   * false: the presave's stage changed after `before` was read (an upload
   * completed, an owner dismissed it, a concurrent check moved it on), so the
   * patch was NOT applied. The check row is still written (stage_after = the
   * current stage, detail.concurrentChange) but the caller must not push,
   * queue an upload or supersede anything on the strength of it.
   */
  applied: boolean
}

/**
 * Update the presave (`patch`, plus the check bookkeeping unless the result
 * is `added`) and append its check row. Only the patched columns are written,
 * and only while the stage is still `before.stage` (a slow lookup never
 * overwrites what happened meanwhile). Returns both rows, re-read.
 */
async function writeCheck(env: Env, before: PresaveRow, patch: Partial<PresaveRow>, check: CheckFields, now: number): Promise<CheckWrite> {
  const db = dbOf(env)
  const counted = check.result !== 'added'
  const fields: Partial<PresaveRow> = {
    ...patch,
    updated_at: now,
    ...(counted ? { last_checked_at: now, last_result: check.result, last_error: check.error ?? null } : {}),
  }
  delete fields.id
  delete fields.check_count
  const cols = Object.keys(fields) as Array<keyof PresaveRow>
  const set = [...cols.map((k) => `${k} = ?`), ...(counted ? ['check_count = check_count + 1'] : [])].join(', ')
  const upd = await db
    .prepare(`UPDATE presaves SET ${set} WHERE id = ? AND stage = ?`)
    .bind(...cols.map((k) => (fields[k] === undefined ? null : (fields[k] as string | number | null))), before.id, before.stage)
    .run()
  const applied = (upd.meta.changes ?? 0) > 0
  const current = await getPresaveRow(env, before.id)
  const links = check.links ?? (patch.links !== undefined ? parseJson<LinkEntry[]>(patch.links, []) : null)
  const names = links ? linkNames(links) : null
  const stageAfter = applied ? (patch.stage ?? before.stage) : (current?.stage ?? before.stage)
  const videoAfter = applied ? (patch.youtube_video_id !== undefined ? patch.youtube_video_id : before.youtube_video_id) : (current?.youtube_video_id ?? null)
  let detail = check.detail
  if (!applied) {
    const note = { concurrentChange: `the presave became ${current ? current.stage : 'deleted'} during this check; nothing was changed` }
    detail = detail && typeof detail === 'object' && !Array.isArray(detail) ? { ...(detail as object), ...note } : detail === undefined || detail === null ? note : { detail, ...note }
  }
  if (current) {
    await db
      .prepare(
        `INSERT INTO presave_checks (presave_id, at, trigger, result, stage_before, stage_after, link_count, link_sources, youtube_video_id, error, ms, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        before.id,
        now,
        check.trigger,
        check.result,
        before.stage,
        stageAfter,
        links ? links.length : null,
        names ? joinSources(names) : null,
        (check.result === 'found' || check.result === 'uploaded') && applied ? videoAfter : null,
        check.error ? String(check.error).slice(0, 500) : null,
        check.ms ?? null,
        detail === undefined || detail === null ? null : JSON.stringify(detail),
      )
      .run()
  }
  const presave = (await getPresaveRow(env, before.id)) ?? current ?? { ...before, ...patch }
  const row = await db.prepare('SELECT * FROM presave_checks WHERE presave_id = ? ORDER BY id DESC LIMIT 1').bind(before.id).first<PresaveCheckRow>()
  return { presave, check: row!, applied }
}

/** Stop watching a track watched longer than giveUpDays (0 = never). */
function gaveUp(settings: AppSettings, p: PresaveRow, now: number): boolean {
  const days = settings.presave.giveUpDays
  return days > 0 && now - p.created_at >= days * DAY_MS
}

export type PresaveRefusal = { poolCode: PoolFaultCode | null; retryAfterSeconds: number | null; message: string }

export type RecheckResult = {
  presave: PresaveRow
  /** The last check row written (null when nothing was checked: found, uploaded, dismissed). */
  check: PresaveCheckRow | null
  /** Set when the pool refused: nothing was learnt; a scheduled run stops the tick. */
  refused?: PresaveRefusal
}

const priorityFor = (settings: AppSettings, trigger: PresaveTrigger): PoolPriority => (trigger === 'scheduled' ? settings.presave.priority : 'phone')

/**
 * When a failed check is retried. A plain error backs off exponentially on the
 * failure count — retryMinutes × 2^(failures − 1) — capped at the recheck
 * interval, so a track whose lookup keeps failing is not hammered every
 * retryMinutes forever. A pool refusal or a decoy page says nothing about the
 * track (the pool or the page was the problem, and the scheduler already
 * backs the whole tick off for a refusal): it is retried after retryMinutes
 * with no further growth, and never counts toward giving up.
 */
export function failRetryAt(settings: Pick<AppSettings, 'presave'>, failCount: number, kind: 'error' | 'refused' | 'decoy', now: number): number {
  const retry = settings.presave.retryMinutes * 60_000
  if (kind !== 'error') return now + retry
  const cap = Math.max(retry, settings.presave.recheckIntervalHours * HOUR_MS)
  const exp = Math.min(Math.max(0, failCount - 1), 30)
  return now + Math.min(retry * 2 ** exp, cap)
}

/** A failed lookup: nothing changes but the failure count and the retry time (or the give-up, for a plain error). */
async function failCheck(
  env: Env,
  p: PresaveRow,
  settings: AppSettings,
  trigger: PresaveTrigger,
  f: { error: string; refused: boolean; decoy?: boolean; poolCode?: PoolFaultCode | null; retryAfterSeconds?: number | null; ms: number; detail?: unknown },
  now: number,
): Promise<RecheckResult> {
  const kind = f.refused ? 'refused' : f.decoy ? 'decoy' : 'error'
  const failCount = (Number(p.fail_count) || 0) + 1
  const detail = f.detail ?? (f.poolCode ? { poolCode: f.poolCode } : f.decoy ? { decoy: true } : undefined)
  if (kind === 'error' && gaveUp(settings, p, now)) {
    const w = await writeCheck(
      env,
      p,
      { fail_count: failCount, stage: 'dismissed', dismissed_at: now, next_check_at: null },
      { trigger, result: 'gave_up', error: f.error, ms: f.ms, detail: { wouldBe: 'error', giveUpDays: settings.presave.giveUpDays } },
      now,
    )
    if (w.applied) {
      try {
        await supersedeTrackUploadsForPresave(env, p.id, 'gave up')
      } catch {
        // logged by track-uploads
      }
    }
    return w
  }
  const w = await writeCheck(
    env,
    p,
    { fail_count: failCount, next_check_at: failRetryAt(settings, failCount, kind, now) },
    { trigger, result: f.refused ? 'pool_refused' : 'error', error: f.error, ms: f.ms, detail },
    now,
  )
  return {
    ...w,
    ...(f.refused ? { refused: { poolCode: f.poolCode ?? null, retryAfterSeconds: f.retryAfterSeconds ?? null, message: f.error } } : {}),
  }
}

/** Stage `links`: one uncached lookup of every source. */
async function checkLinks(env: Env, p: PresaveRow, trigger: PresaveTrigger, settings: AppSettings, log: Logger, now: number, random: () => number): Promise<RecheckResult> {
  const r = await fetchAllMediaLinks(env, p.track_id!, { priority: priorityFor(settings, trigger), log })
  if (!r.ok) {
    return failCheck(env, p, settings, trigger, { error: r.error, refused: !!r.poolError, poolCode: r.poolCode ?? null, retryAfterSeconds: r.retryAfterSeconds ?? null, ms: r.ms }, now)
  }
  const names = linkNames(r.links)
  const base: Partial<PresaveRow> = {
    links: JSON.stringify(r.links),
    link_sources: joinSources(names),
    link_count: r.links.length,
    duration_seconds: maxDuration(r.links) ?? p.duration_seconds,
    fail_count: 0,
  }
  const videoId = youtubeIdOf(r.links)
  if (videoId) {
    let w = await writeCheck(
      env,
      p,
      { ...base, stage: 'found', youtube_video_id: videoId, found_at: now, next_check_at: null },
      { trigger, result: 'found', ms: r.ms, links: r.links, detail: { accountId: r.accountId } },
      now,
    )
    // Changed meanwhile (uploaded, dismissed, or a concurrent check already found it): no second push.
    if (!w.applied) {
      log.info('presave.found_concurrent', { id: p.id, videoId, stageNow: w.presave.stage, trigger })
      return w
    }
    log.info('presave.found', { id: p.id, trackId: p.track_id, videoId, trigger })
    try {
      await supersedeTrackUploadsForPresave(env, p.id, 'found on 1001tracklists')
    } catch (e) {
      log.warn('presave.supersede_failed', { id: p.id, ...errorFields(e) })
    }
    if (settings.presave.notifyFound) {
      const sent = await sendPushToAll(env, presaveFoundPayload({ id: p.id, artist: w.presave.artist, title: w.presave.title, videoId }), log).catch(() => null)
      if (sent && sent.sent > 0) {
        await dbOf(env).prepare('UPDATE presaves SET notified_at = ? WHERE id = ?').bind(now, p.id).run()
        w = { ...w, presave: { ...w.presave, notified_at: now } }
      }
    }
    return w
  }
  if (gaveUp(settings, p, now)) {
    const w = await writeCheck(
      env,
      p,
      { ...base, stage: 'dismissed', dismissed_at: now, next_check_at: null },
      { trigger, result: 'gave_up', ms: r.ms, links: r.links, detail: { wouldBe: 'no_youtube', giveUpDays: settings.presave.giveUpDays } },
      now,
    )
    if (w.applied) {
      try {
        await supersedeTrackUploadsForPresave(env, p.id, 'gave up')
      } catch {
        // logged by track-uploads
      }
    }
    return w
  }
  const w = await writeCheck(env, p, { ...base, next_check_at: nextCheckAt(settings, now, random) }, { trigger, result: 'no_youtube', ms: r.ms, links: r.links, detail: { accountId: r.accountId } }, now)
  // Uploaded or dismissed while the lookup ran: nothing to queue.
  if (!w.applied) return w
  try {
    const q = await maybeQueueTrackUpload(env, w.presave)
    if (q?.queued) log.info('presave.upload_queued', { id: p.id, reason: q.reason })
  } catch (e) {
    log.warn('presave.queue_upload_failed', { id: p.id, ...errorFields(e) })
  }
  return w
}

type IdentifyOutcome = { kind: 'identified'; w: { presave: PresaveRow; check: PresaveCheckRow } } | { kind: 'other'; w: { presave: PresaveRow; check: PresaveCheckRow } }

/**
 * Stage `identify` against a page's rows. Identified: the presave takes the
 * row's id, names and art and moves to `links` (due now when `dueNow`). A
 * track already pre-saved under that id keeps the watch: this one is
 * dismissed and points at it.
 */
async function identifyFromRows(
  env: Env,
  p: PresaveRow,
  rows: readonly PageRow[],
  trigger: PresaveTrigger,
  settings: AppSettings,
  now: number,
  random: () => number,
  extra: { ms?: number; source: 'cache' | 'fetch' | 'set_fetch'; dueNow: boolean },
): Promise<IdentifyOutcome> {
  const hit = findPresaveRow(rows, p)
  const finalNext = (): Partial<PresaveRow> =>
    gaveUp(settings, p, now) ? { stage: 'dismissed', dismissed_at: now, next_check_at: null } : { next_check_at: nextCheckAt(settings, now, random) }
  if (!hit) {
    const patch = finalNext()
    return { kind: 'other', w: await writeCheck(env, p, { ...patch, fail_count: 0 }, { trigger, result: patch.stage === 'dismissed' ? 'gave_up' : 'row_missing', ms: extra.ms, detail: { rows: rows.length, from: extra.source } }, now) }
  }
  const row = rows[hit.index]!
  if (!rowIdentified(row)) {
    const patch = finalNext()
    const known = (s: string | null | undefined) => (s && s.toUpperCase() !== 'ID' ? s : null)
    const named = !row.anonymous ? { artist: p.artist ?? known(row.artist), title: p.title ?? known(row.title) } : {}
    return {
      kind: 'other',
      w: await writeCheck(env, p, { ...patch, ...named, fail_count: 0 }, { trigger, result: patch.stage === 'dismissed' ? 'gave_up' : 'still_id', ms: extra.ms, detail: { rowIndex: hit.index, how: hit.how, from: extra.source } }, now),
    }
  }
  const trackId = rowMediaId(row)!
  const other = await dbOf(env).prepare('SELECT id, stage FROM presaves WHERE track_id = ? AND id != ?').bind(trackId, p.id).first<{ id: number; stage: string }>()
  if (other) {
    // The track stays watched: a dismissed twin is watched again (this save asked for it).
    if (other.stage === 'dismissed') {
      await dbOf(env).prepare("UPDATE presaves SET stage = CASE WHEN youtube_video_id IS NULL THEN 'links' ELSE stage END, dismissed_at = NULL, next_check_at = ?, updated_at = ? WHERE id = ? AND youtube_video_id IS NULL").bind(now, now, other.id).run()
    }
    return {
      kind: 'other',
      w: await writeCheck(
        env,
        p,
        { stage: 'dismissed', dismissed_at: now, next_check_at: null, artist: row.artist, title: row.title },
        { trigger, result: 'identified', ms: extra.ms, detail: { rowIndex: hit.index, how: hit.how, trackId, duplicateOf: other.id, from: extra.source } },
        now,
      ),
    }
  }
  const w = await writeCheck(
    env,
    p,
    {
      track_id: trackId,
      artist: row.artist,
      title: row.title,
      track_url: row.trackUrl ? normalizeTrackUrl(row.trackUrl) : p.track_url,
      artwork_url: row.artworkUrl ?? p.artwork_url,
      label: row.label ?? p.label,
      row_index: hit.index,
      cue_seconds: cueOf(row) ?? p.cue_seconds,
      stage: 'links',
      identified_at: now,
      fail_count: 0,
      next_check_at: extra.dueNow ? now : nextCheckAt(settings, now, random),
    },
    { trigger, result: 'identified', ms: extra.ms, detail: { rowIndex: hit.index, how: hit.how, trackId, from: extra.source } },
    now,
  )
  return { kind: w.applied ? 'identified' : 'other', w }
}

/** Refusal fields of a thrown fetch error, or null when it is not a refusal. */
function refusalOf(e: unknown): { poolCode: PoolFaultCode | null; retryAfterSeconds: number | null } | null {
  if (!(e instanceof UpstreamPausedError || e instanceof UpstreamUnavailableError || e instanceof IPBlockedError)) return null
  const r = (e as { retryAfterSeconds?: unknown }).retryAfterSeconds
  return { poolCode: poolCodeOf(e), retryAfterSeconds: typeof r === 'number' && Number.isFinite(r) ? r : null }
}

/** Stage `identify`: re-read the set page (or the track page) and look for the row. */
async function checkIdentify(env: Env, p: PresaveRow, trigger: PresaveTrigger, settings: AppSettings, log: Logger, now: number, random: () => number): Promise<RecheckResult> {
  const t0 = Date.now()
  if (!p.set_url) {
    // A track-URL save: the track page again.
    if (!p.track_url) return failCheck(env, p, settings, trigger, { error: 'nothing to identify the track by', refused: false, ms: 0 }, now)
    const r = await fetchTrackPageMediaId(env, p.track_url, { priority: priorityFor(settings, trigger), log })
    if (!r.ok) return failCheck(env, p, settings, trigger, { error: r.error, refused: !!r.poolError, poolCode: r.poolCode ?? null, retryAfterSeconds: r.retryAfterSeconds ?? null, ms: Date.now() - t0 }, now)
    if (!r.trackId) {
      const patch = gaveUp(settings, p, now) ? { stage: 'dismissed' as const, dismissed_at: now, next_check_at: null } : { next_check_at: nextCheckAt(settings, now, random) }
      return writeCheck(env, p, { ...patch, fail_count: 0 }, { trigger, result: patch.stage === 'dismissed' ? 'gave_up' : 'still_id', ms: Date.now() - t0, detail: { from: 'track_page' } }, now)
    }
    const other = await dbOf(env).prepare('SELECT id FROM presaves WHERE track_id = ? AND id != ?').bind(r.trackId, p.id).first<{ id: number }>()
    if (other) {
      return writeCheck(env, p, { stage: 'dismissed', dismissed_at: now, next_check_at: null }, { trigger, result: 'identified', ms: Date.now() - t0, detail: { trackId: r.trackId, duplicateOf: other.id, via: r.via } }, now)
    }
    const w = await writeCheck(
      env,
      p,
      { track_id: r.trackId, stage: 'links', identified_at: now, fail_count: 0, next_check_at: now, ...(r.name && !p.artist ? { artist: r.name.artist } : {}), ...(r.name && !p.title ? { title: r.name.title } : {}) },
      { trigger, result: 'identified', ms: Date.now() - t0, detail: { trackId: r.trackId, via: r.via, from: 'track_page' } },
      now,
    )
    return trigger === 'set_fetch' || !w.applied ? w : checkLinks(env, w.presave, trigger, settings, log, Date.now(), random)
  }

  // A set row: the cached list when it was fetched after the last check, else one fetch.
  // A list cached before rows carried `mediaId` cannot tell a medialink id from a page
  // position, so it identifies nothing: the page is fetched instead.
  let rows: PageRow[] | null = null
  let source: 'cache' | 'fetch' = 'cache'
  const cached = await readCachedTracklist(env, tracklistSlug(p.set_url)).catch(() => undefined)
  const cachedAt = cached?.fetchedAt ? Date.parse(cached.fetchedAt) : NaN
  const cachedHasMediaIds = !!cached?.rows?.some((r) => r.mediaId !== undefined)
  if (cached?.rows && cached.rows.length > 0 && cachedHasMediaIds && Number.isFinite(cachedAt) && (p.last_checked_at === null || cachedAt > p.last_checked_at)) {
    rows = cached.rows
  } else {
    source = 'fetch'
    let scraped: ScrapedTracklist
    try {
      const f = await fetchTracklist(p.set_url, fetchOptsFromEnv(env, log, { priority: priorityFor(settings, trigger) }))
      scraped = f.result
      await recordPageFacts(env, p.set_url, f.html, log)
      await cacheParsedTracklist(env, p.set_url, scraped, log, { source: 'presave', html: f.html }).catch(() => null)
    } catch (e) {
      const ref = refusalOf(e)
      return failCheck(env, p, settings, trigger, { error: e instanceof Error ? e.message : String(e), refused: !!ref, poolCode: ref?.poolCode ?? null, retryAfterSeconds: ref?.retryAfterSeconds ?? null, ms: Date.now() - t0 }, now)
    }
    if (scraped.decoy.suspected) {
      return failCheck(env, p, settings, trigger, { error: `decoy page (${scraped.decoy.mismatched} of ${scraped.decoy.named} rows contradict themselves)`, refused: false, decoy: true, ms: Date.now() - t0 }, now)
    }
    if (scraped.rows.length === 0) return failCheck(env, p, settings, trigger, { error: 'the set page parsed to no rows', refused: false, ms: Date.now() - t0 }, now)
    rows = scraped.rows
    // Every page is used fully, once: the other rows saved from this set learn from it too.
    await presaveOnSetParsed(env, p.set_url, scraped, log, { excludeId: p.id })
  }
  const out = await identifyFromRows(env, p, rows, trigger, settings, now, random, { ms: Date.now() - t0, source, dueNow: true })
  if (out.kind === 'identified' && trigger !== 'set_fetch') return checkLinks(env, out.w.presave, trigger, settings, log, Date.now(), random)
  return out.w
}

/**
 * Check one presave now. `scheduled` looks up at settings.presave.priority,
 * `manual` and `add` at phone priority. Found / uploaded / dismissed
 * presaves are returned as they are (check null). Never throws for a pool
 * refusal: that is `refused`. Returns null for an unknown id.
 */
export async function recheckPresave(env: Env, id: number, trigger: PresaveTrigger, opts: Opts = {}): Promise<RecheckResult | null> {
  const log = opts.log ?? makeLogger({ task: 'presave.check', id })
  const now = opts.now ?? Date.now()
  const random = opts.random ?? Math.random
  const p = await getPresaveRow(env, id)
  if (!p) return null
  if (p.stage !== 'identify' && p.stage !== 'links') return { presave: p, check: null }
  const settings = await getAppSettings(env)
  try {
    if (p.stage === 'links' && p.track_id) return await checkLinks(env, p, trigger, settings, log, now, random)
    return await checkIdentify(env, p, trigger, settings, log, now, random)
  } catch (e) {
    // A D1 or parse problem: recorded as an error check, retried later.
    log.error('presave.check_threw', { id, trigger, ...errorFields(e) })
    return failCheck(env, p, settings, trigger, { error: e instanceof Error ? e.message : String(e), refused: false, ms: Date.now() - now }, now)
  }
}

// ─── saving ────────────────────────────────────────────────────────────────

export type AddPresaveResult = {
  created: boolean
  /** It was dismissed and is watched again. */
  restored: boolean
  presave: PresaveRow
  check: PresaveCheckRow | null
  /** The immediate check met a pool refusal (the save stands). */
  refused?: PresaveRefusal
  /** One line for a Tasker flash. */
  message: string
}

function intOrNull(x: unknown, name: string): number | null {
  if (x === undefined || x === null || x === '') return null
  const n = typeof x === 'number' ? x : Number(x)
  if (!Number.isInteger(n) || n < 0) throw new PresaveInputError(`${name} must be a whole number of 0 or more`)
  return n
}

function messageFor(r: { created: boolean; restored: boolean; presave: PresaveRow }): string {
  const p = r.presave
  const name = displayName(p)
  if (p.stage === 'found' || (p.stage === 'uploaded' && p.youtube_video_id)) return `Already on YouTube: ${name}`
  if (p.stage === 'dismissed') return r.created ? `Saved but not watched: ${name} (already pre-saved under another entry)` : `Pre-save dismissed: ${name}`
  const what = p.stage === 'identify' ? 'watching for it to be identified' : 'watching for a YouTube link'
  // "Pre-saved the unidentified track at 1:02:03 in <set>", "Pre-saved: Artist – Title".
  const sep = name.startsWith('the unidentified') ? ' ' : ': '
  if (r.created) return `Pre-saved${sep}${name} (${what})`
  if (r.restored) return `Pre-saved again${sep}${name} (${what})`
  return `Already pre-saved${sep}${name} (${what})`
}

/** Watch a dismissed presave again: back to the stage its data allows, due now. */
async function restoreRow(env: Env, p: PresaveRow, now: number): Promise<PresaveRow> {
  const stage: PresaveStage = p.youtube_video_id ? (p.found_at ? 'found' : 'uploaded') : p.track_id ? 'links' : 'identify'
  const next = stage === 'links' || stage === 'identify' ? now : null
  await dbOf(env).prepare('UPDATE presaves SET stage = ?, dismissed_at = NULL, next_check_at = ?, fail_count = 0, updated_at = ? WHERE id = ?').bind(stage, next, now, p.id).run()
  return (await getPresaveRow(env, p.id))!
}

/**
 * Save a track to watch. Idempotent: an already saved track comes back with
 * `created: false` (restored if it was dismissed). Unless `check: false`, an
 * immediate check runs (trigger `add`); a pool refusal there is recorded as
 * `pool_refused` and never fails the save. Throws PresaveInputError on bad input.
 */
export async function addPresave(env: Env, input: PresaveInput, source: PresaveSource, opts: Opts & { check?: boolean } = {}): Promise<AddPresaveResult> {
  const log = opts.log ?? makeLogger({ task: 'presave.add' })
  const now = opts.now ?? Date.now()
  const db = dbOf(env)

  const setUrl = input.setUrl ? normalizeTracklistUrl(String(input.setUrl)) : null
  if (input.setUrl && !setUrl) throw new PresaveInputError('setUrl is not a 1001tracklists tracklist URL')
  let trackUrl = input.trackUrl ? normalizeTrackUrl(String(input.trackUrl)) : null
  if (input.trackUrl && !trackUrl) throw new PresaveInputError('trackUrl is not a 1001tracklists track URL')
  const rawId = input.trackId === undefined || input.trackId === null ? '' : String(input.trackId).trim()
  if (rawId && !/^\d+$/.test(rawId)) throw new PresaveInputError('trackId must be the numeric 1001tracklists track id')
  let trackId: string | null = rawId || null
  let rowIndex = intOrNull(input.rowIndex, 'rowIndex')
  let cue = intOrNull(input.cueSeconds, 'cueSeconds')
  if (!trackId && !trackUrl && !(setUrl && (rowIndex !== null || cue !== null))) {
    throw new PresaveInputError('give a trackId, a trackUrl, or a set URL with rowIndex or cueSeconds')
  }
  const clean = (s: unknown, max = 300): string | null => (typeof s === 'string' && s.trim() ? s.trim().slice(0, max) : null)
  // An ID row's "ID" artist / title is no name at all.
  const name = (s: unknown): string | null => {
    const c = clean(s)
    return c && c.toUpperCase() !== 'ID' ? c : null
  }
  let artist = name(input.artist)
  let title = name(input.title)
  let artworkUrl = clean(input.artworkUrl, 1000)
  let label = clean(input.label)
  let djSlug = clean(input.djSlug, 120)
  let prev: string | null = null
  let next: string | null = null

  // The cached list of the set, when warm: fills the row's context for free.
  if (setUrl) {
    const cached = await readCachedTracklist(env, tracklistSlug(setUrl)).catch(() => undefined)
    const rows = cached?.rows ?? null
    if (rows && rows.length) {
      let i = -1
      if (rowIndex !== null && rows[rowIndex] && (!trackId || rows[rowIndex]!.anonymous || rows[rowIndex]!.trackId === trackId)) i = rowIndex
      else if (trackId) i = rows.findIndex((r) => !r.anonymous && r.trackId === trackId)
      else if (trackUrl) i = rows.findIndex((r) => r.trackUrl && normalizeTrackUrl(r.trackUrl) === trackUrl)
      else if (cue !== null) i = findPresaveRow(rows, { track_url: null, cue_seconds: cue, prev_track_id: null, next_track_id: null, row_index: null })?.index ?? -1
      if (i >= 0) {
        const r = rows[i]!
        rowIndex = i
        cue = cue ?? cueOf(r)
        // An anonymous row's data-id is its position on the page, never a medialink id.
        // So is a named row's with no media id (mediaId null): it is identified once it gets one.
        // On a list cached before mediaId existed (undefined) the two cannot be told apart: no id either.
        if (rowMediaId(r) === null && trackId === r.trackId) trackId = null
        if (!trackId && rowIdentified(r)) trackId = rowMediaId(r)
        if (!r.anonymous) {
          artist = artist ?? name(r.artist)
          title = title ?? name(r.title)
          trackUrl = trackUrl ?? (r.trackUrl ? normalizeTrackUrl(r.trackUrl) : null)
          artworkUrl = artworkUrl ?? r.artworkUrl
          label = label ?? r.label
        }
        const a = anchorsOf(rows, i)
        prev = a.prev
        next = a.next
      }
    }
    if (!djSlug) djSlug = (await db.prepare('SELECT MIN(slug) AS slug FROM tracklists WHERE url = ?').bind(setUrl).first<{ slug: string | null }>())?.slug ?? null
  }

  const done = async (p: PresaveRow, created: boolean, restored: boolean, check: PresaveCheckRow | null = null, refused?: PresaveRefusal): Promise<AddPresaveResult> => {
    const r = { created, restored, presave: p, check, ...(refused ? { refused } : {}) }
    return { ...r, message: messageFor(r) }
  }
  const existingFound = async (p: PresaveRow): Promise<AddPresaveResult> => {
    if (p.stage === 'dismissed') return done(await restoreRow(env, p, now), false, true)
    return done(p, false, false)
  }

  // A track-URL save with no id: try the track page for the medialink id (unless asked not to check).
  // That fetch IS the save's check when it finds no id: its result is recorded as the `add` check
  // below instead of fetching the same page again (two phone-priority pool views for one answer).
  let trackPageRefused: PresaveRefusal | undefined
  let trackPageResult: { kind: 'no_id'; ms: number; via?: string | null } | { kind: 'error'; ms: number; error: string } | undefined
  if (!trackId && trackUrl) {
    const byUrl = await db.prepare('SELECT * FROM presaves WHERE track_url = ? ORDER BY id LIMIT 1').bind(trackUrl).first<PresaveRow>()
    if (byUrl) return existingFound(byUrl)
    if (opts.check !== false && !(setUrl && rowIndex !== null)) {
      const t0 = Date.now()
      const r = await fetchTrackPageMediaId(env, trackUrl, { priority: 'phone', log })
      if (r.ok && r.trackId) {
        trackId = r.trackId
        artist = artist ?? r.name?.artist ?? null
        title = title ?? r.name?.title ?? null
      } else if (r.ok) {
        trackPageResult = { kind: 'no_id', ms: Date.now() - t0 }
        artist = artist ?? r.name?.artist ?? null
        title = title ?? r.name?.title ?? null
      } else if (r.poolError) {
        trackPageRefused = { poolCode: r.poolCode ?? null, retryAfterSeconds: r.retryAfterSeconds ?? null, message: r.error }
      } else {
        trackPageResult = { kind: 'error', ms: Date.now() - t0, error: r.error }
      }
    }
  }

  if (trackId) {
    const byId = await db.prepare('SELECT * FROM presaves WHERE track_id = ?').bind(trackId).first<PresaveRow>()
    if (byId) return existingFound(byId)
    // A row saved earlier by its track URL or set row that this id now names: it moves on to links.
    const byKey = trackUrl
      ? await db.prepare('SELECT * FROM presaves WHERE track_id IS NULL AND track_url = ? ORDER BY id LIMIT 1').bind(trackUrl).first<PresaveRow>()
      : setUrl && rowIndex !== null
        ? await db.prepare('SELECT * FROM presaves WHERE track_id IS NULL AND set_url = ? AND row_index = ?').bind(setUrl, rowIndex).first<PresaveRow>()
        : null
    if (byKey) {
      await db
        .prepare(`UPDATE presaves SET track_id = ?, stage = CASE WHEN stage = 'dismissed' THEN stage ELSE 'links' END, identified_at = ?, next_check_at = ?, artist = COALESCE(?, artist), title = COALESCE(?, title), updated_at = ? WHERE id = ?`)
        .bind(trackId, now, now, artist, title, now, byKey.id)
        .run()
      return existingFound((await getPresaveRow(env, byKey.id))!)
    }
  } else if (!trackUrl || (setUrl && rowIndex !== null)) {
    const byRow =
      rowIndex !== null
        ? await db.prepare('SELECT * FROM presaves WHERE track_id IS NULL AND set_url = ? AND row_index = ?').bind(setUrl, rowIndex).first<PresaveRow>()
        : await db.prepare('SELECT * FROM presaves WHERE track_id IS NULL AND set_url = ? AND cue_seconds = ? ORDER BY id LIMIT 1').bind(setUrl, cue).first<PresaveRow>()
    if (byRow) return existingFound(byRow)
  }

  const stage: PresaveStage = trackId ? 'links' : 'identify'
  let ins: D1Result
  try {
    ins = await db
      .prepare(
        `INSERT INTO presaves (track_id, track_url, set_url, row_index, cue_seconds, prev_track_id, next_track_id, artist, title, artwork_url, label, dj_slug,
                               stage, source, created_at, updated_at, next_check_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(trackId, trackUrl, setUrl, rowIndex, cue, prev, next, artist, title, artworkUrl, label, djSlug, stage, source, now, now, now)
      .run()
  } catch (e) {
    // A concurrent save of the same track won the race (presaves_track / presaves_row): that one is it.
    if (!/UNIQUE/i.test(String((e as Error)?.message ?? e))) throw e
    const winner = trackId
      ? await db.prepare('SELECT * FROM presaves WHERE track_id = ?').bind(trackId).first<PresaveRow>()
      : setUrl && rowIndex !== null
        ? await db.prepare('SELECT * FROM presaves WHERE track_id IS NULL AND set_url = ? AND row_index = ?').bind(setUrl, rowIndex).first<PresaveRow>()
        : null
    if (!winner) throw e
    log.info('presave.add_raced', { id: winner.id, trackId, setUrl, rowIndex })
    return existingFound(winner)
  }
  const id = Number(ins.meta.last_row_id)
  let p = (await getPresaveRow(env, id))!
  const added = await writeCheck(env, p, {}, { trigger: 'add', result: 'added', detail: { source, stage } }, now)
  p = added.presave
  log.info('presave.added', { id, trackId, trackUrl, setUrl, rowIndex, cue, stage, source })
  if (trackPageRefused) {
    const f = await failCheck(env, p, await getAppSettings(env), 'add', { error: trackPageRefused.message, refused: true, poolCode: trackPageRefused.poolCode, retryAfterSeconds: trackPageRefused.retryAfterSeconds, ms: 0 }, now)
    return done(f.presave, true, false, f.check, f.refused)
  }
  if (opts.check === false) return done(p, true, false, added.check)
  if (trackPageResult) {
    const settings = await getAppSettings(env)
    if (trackPageResult.kind === 'error') {
      const f = await failCheck(env, p, settings, 'add', { error: trackPageResult.error, refused: false, ms: trackPageResult.ms }, now)
      return done(f.presave, true, false, f.check)
    }
    const w = await writeCheck(env, p, { fail_count: 0, next_check_at: nextCheckAt(settings, now, opts.random) }, { trigger: 'add', result: 'still_id', ms: trackPageResult.ms, detail: { from: 'track_page' } }, now)
    return done(w.presave, true, false, w.check)
  }
  const r = await recheckPresave(env, id, 'add', { log, now, random: opts.random })
  return done(r?.presave ?? p, true, false, r?.check ?? added.check, r?.refused)
}

// ─── the set-fetch hook ────────────────────────────────────────────────────

/**
 * A set page was fetched and parsed (sync, verification, viewer, phone):
 * every identify-stage presave of that set looks for its row on it. Costs one
 * indexed D1 query when there is none. An identified row is due for its links
 * check right away (the scheduler's next tick runs it); nothing is fetched
 * here. Never throws. Decoy pages are skipped.
 */
export async function presaveOnSetParsed(
  env: Env,
  setUrl: string,
  scraped: Pick<ScrapedTracklist, 'rows'> & { decoy?: { suspected: boolean } },
  log?: Logger,
  opts: { excludeId?: number; now?: number; random?: () => number } = {},
): Promise<number> {
  try {
    if (!env.DB || !scraped?.rows?.length || scraped.decoy?.suspected) return 0
    const url = normalizeTracklistUrl(setUrl) ?? setUrl
    const pending = (await dbOf(env).prepare("SELECT * FROM presaves WHERE set_url = ? AND stage = 'identify'").bind(url).all<PresaveRow>()).results.filter((p) => p.id !== opts.excludeId)
    if (pending.length === 0) return 0
    const settings = await getAppSettings(env)
    if (!settings.presave.useSetFetches) return 0
    const now = opts.now ?? Date.now()
    let identified = 0
    for (const p of pending) {
      try {
        const out = await identifyFromRows(env, p, scraped.rows, 'set_fetch', settings, now, opts.random ?? Math.random, { source: 'set_fetch', dueNow: true })
        if (out.kind === 'identified') identified++
      } catch (e) {
        log?.warn('presave.set_fetch_row_failed', { id: p.id, setUrl: url, ...errorFields(e) })
      }
    }
    log?.info('presave.set_fetch', { setUrl: url, pending: pending.length, identified })
    return pending.length
  } catch (e) {
    log?.warn('presave.set_fetch_failed', { setUrl, ...errorFields(e) })
    return 0
  }
}

// ─── the scheduler's part ──────────────────────────────────────────────────

/** Presaves due for their scheduled check, oldest due first (empty while presave.enabled is off). */
export async function duePresaves(env: Env, nowMs: number, limit: number): Promise<Array<Pick<PresaveRow, 'id' | 'dj_slug' | 'set_url' | 'track_url'>>> {
  if (limit <= 0) return []
  const settings = await getAppSettings(env)
  if (!settings.presave.enabled) return []
  const n = Math.min(limit, settings.presave.maxPerTick)
  if (n <= 0) return []
  return (
    await dbOf(env)
      .prepare("SELECT id, dj_slug, set_url, track_url FROM presaves WHERE next_check_at IS NOT NULL AND next_check_at <= ? AND stage IN ('identify', 'links') ORDER BY next_check_at, id LIMIT ?")
      .bind(nowMs, n)
      .all<Pick<PresaveRow, 'id' | 'dj_slug' | 'set_url' | 'track_url'>>()
  ).results
}

export type ScheduledPresaveOutcome = { outcome: string; stopReason?: string; poolCode?: PoolFaultCode | null; retryAfterSeconds?: number | null }

/**
 * One scheduled check for the tick: claimed first (its next check moves out by
 * retryMinutes, atomically, so an overlapping tick skips it), then checked.
 * A pool refusal comes back as outcome `stopped` with the pool's code.
 */
export async function runScheduledPresave(env: Env, id: number, log: Logger, nowMs = Date.now()): Promise<ScheduledPresaveOutcome> {
  const settings = await getAppSettings(env)
  const claim = await dbOf(env)
    .prepare("UPDATE presaves SET next_check_at = ? WHERE id = ? AND next_check_at IS NOT NULL AND next_check_at <= ? AND stage IN ('identify', 'links')")
    .bind(nowMs + settings.presave.retryMinutes * 60_000, id, nowMs)
    .run()
  if ((claim.meta.changes ?? 0) === 0) return { outcome: 'skipped' }
  const r = await recheckPresave(env, id, 'scheduled', { log, now: nowMs })
  if (!r) return { outcome: 'skipped' }
  if (r.refused) return { outcome: 'stopped', stopReason: r.refused.message, poolCode: r.refused.poolCode, retryAfterSeconds: r.refused.retryAfterSeconds }
  return { outcome: r.check?.result === 'error' ? 'failed' : 'ok' }
}

// ─── owner actions ─────────────────────────────────────────────────────────

export async function dismissPresave(env: Env, id: number, now = Date.now()): Promise<PresaveRow | null> {
  const p = await getPresaveRow(env, id)
  if (!p) return null
  if (p.stage === 'dismissed') return p
  await dbOf(env).prepare("UPDATE presaves SET stage = 'dismissed', dismissed_at = ?, next_check_at = NULL, updated_at = ? WHERE id = ?").bind(now, now, id).run()
  try {
    await supersedeTrackUploadsForPresave(env, id, 'dismissed')
  } catch {
    // logged by track-uploads
  }
  return getPresaveRow(env, id)
}

export async function restorePresave(env: Env, id: number, now = Date.now()): Promise<PresaveRow | null> {
  const p = await getPresaveRow(env, id)
  if (!p) return null
  if (p.stage !== 'dismissed') return p
  return restoreRow(env, p, now)
}

export async function deletePresave(env: Env, id: number): Promise<boolean> {
  const p = await getPresaveRow(env, id)
  if (!p) return false
  try {
    await supersedeTrackUploadsForPresave(env, id, 'deleted')
  } catch {
    // logged by track-uploads
  }
  const db = dbOf(env)
  await db.batch([db.prepare('DELETE FROM presave_checks WHERE presave_id = ?').bind(id), db.prepare('DELETE FROM presaves WHERE id = ?').bind(id)])
  return true
}

/**
 * mkvid ripped and uploaded the track (TRACKUP's /mkvid/track/complete):
 * stage `uploaded` with the video, no more checks. A presave 1001tracklists
 * found meanwhile keeps `found`; the upload is still recorded in its history.
 */
export async function markPresaveUploaded(env: Env, presaveId: number, videoId: string, detail?: unknown, now = Date.now()): Promise<PresaveRow | null> {
  const p = await getPresaveRow(env, presaveId)
  if (!p) return null
  const patch: Partial<PresaveRow> = p.stage === 'found' ? {} : { stage: 'uploaded', youtube_video_id: videoId, next_check_at: null }
  const w = await writeCheck(env, p, patch, { trigger: 'upload', result: 'uploaded', detail: { videoId, ...(detail && typeof detail === 'object' ? (detail as object) : detail !== undefined ? { detail } : {}) } }, now)
  if (p.stage === 'found') {
    await dbOf(env).prepare('UPDATE presave_checks SET youtube_video_id = ? WHERE id = ?').bind(videoId, w.check.id).run()
  }
  return w.presave
}

/** "Pre-saved" state for track rows: by medialink id, and by row of one set (rows saved without an id). */
export async function lookupPresaves(
  env: Env,
  q: { trackIds?: readonly string[]; setUrl?: string | null },
): Promise<{ byTrackId: Record<string, { id: number; stage: string }>; byRow: Record<string, { id: number; stage: string }> }> {
  const db = dbOf(env)
  const byTrackId: Record<string, { id: number; stage: string }> = {}
  const byRow: Record<string, { id: number; stage: string }> = {}
  const ids = [...new Set((q.trackIds ?? []).map((x) => String(x)).filter((x) => /^\d+$/.test(x)))].slice(0, 500)
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90)
    const res = await db.prepare(`SELECT id, track_id, stage FROM presaves WHERE track_id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all<{ id: number; track_id: string; stage: string }>()
    for (const r of res.results) byTrackId[r.track_id] = { id: r.id, stage: r.stage }
  }
  const setUrl = q.setUrl ? normalizeTracklistUrl(q.setUrl) : null
  if (setUrl) {
    const res = await db.prepare('SELECT id, row_index, stage FROM presaves WHERE set_url = ? AND track_id IS NULL AND row_index IS NOT NULL').bind(setUrl).all<{ id: number; row_index: number; stage: string }>()
    for (const r of res.results) byRow[String(r.row_index)] = { id: r.id, stage: r.stage }
  }
  return { byTrackId, byRow }
}

/** Presaves per stage, for the page's chips. */
export async function presaveStageCounts(env: Env): Promise<Record<PresaveStage, number>> {
  const out = Object.fromEntries(PRESAVE_STAGES.map((s) => [s, 0])) as Record<PresaveStage, number>
  const res = await dbOf(env).prepare('SELECT stage, COUNT(*) AS n FROM presaves GROUP BY stage').all<{ stage: string; n: number }>()
  for (const r of res.results) if (r.stage in out) out[r.stage as PresaveStage] = Number(r.n) || 0
  return out
}

/** The presave a status lookup names: by medialink id, else by track URL. */
export async function findPresave(env: Env, q: { trackId?: string | null; trackUrl?: string | null }): Promise<PresaveRow | null> {
  const db = dbOf(env)
  if (q.trackId && /^\d+$/.test(q.trackId)) {
    const r = await db.prepare('SELECT * FROM presaves WHERE track_id = ?').bind(q.trackId).first<PresaveRow>()
    if (r) return r
  }
  const url = q.trackUrl ? normalizeTrackUrl(q.trackUrl) : null
  if (url) return db.prepare('SELECT * FROM presaves WHERE track_url = ? ORDER BY id LIMIT 1').bind(url).first<PresaveRow>()
  return null
}
