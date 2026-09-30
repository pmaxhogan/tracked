/**
 * Playlist hygiene (spec decisions 21-24): what the sync is allowed to add,
 * what it takes back out, and what it learns from the owner's own edits.
 *
 *  1. **Vetting** (`pickSetVideo`, called by lib/sync.ts where a set page is
 *     parsed): the page's YouTube video only counts when it is a full
 *     recording (lib/full-recording.ts), is alive, and was not removed from
 *     the artist playlist before. Otherwise the set is treated as having no
 *     video, which is what makes it eligible for mkvid. Every page fetch also
 *     stores the page's facts (`set_media_facts`) for the sweep.
 *  2. **Sweep** (`runRemovalSweep`): every video the sync has added is judged
 *     by the same rule from stored facts + cached video meta; rejected ones
 *     are removed from the artist and combined playlists, paced by a daily
 *     delete budget, logged in `playlist_removals`. Dry run by default
 *     (`PLAYLIST_SWEEP_DRY_RUN` unset = true): the first production run only
 *     reports.
 *  3. **Comparison** (`comparePlaylists`, every 6 hours): each managed
 *     playlist is listed in full and compared with what the sync added. A
 *     video that is gone was removed by the owner (or died): it is never
 *     re-added there, and its set becomes due for a recheck, which queues it
 *     for mkvid. A partial or failed listing is never read as removals, and a
 *     playlist that seems to have lost more than 30% is held and reported.
 *  4. **Remove and replace** (`removeAndReplace`): the per-set button.
 *
 * Everything here talks to YouTube only; none of it fetches 1001tracklists.
 */

import type { Env } from '../types'
import { dbOf, batchChunked } from './db'
import { errorFields, type Logger } from './log'
import { decideFullRecording, hasNoFullRecordingNotice, maxAudioSeconds, REJECT_REASON_LABELS, type RejectReason } from './full-recording'
import { getVideoMeta, readCachedVideoMeta, type VideoMeta } from './video-meta'
import {
  blockedIds,
  isBlocked,
  isOverridden,
  overriddenIds,
  playlistMembers,
  confirmedMembership,
  markInPlaylist,
  markOutOfPlaylist,
  recordRemoved,
  savePlaylistMembers,
  setOverride,
  unblock,
  type RemovedReason,
} from './playlist-blocklist'
import {
  addVideoToPlaylist,
  isQuotaError,
  listPlaylistItems,
  removeVideoFromPlaylist,
  type RawPlaylistItem,
} from './youtube-playlists'
import { cachePlaylistVideoIds, invalidatePlaylistVideoIds } from './playlist-cache'
import { loadCombinedState } from './combined-playlist'
import { getAccessToken } from './google-oauth'
import { parseCueValueData } from './tracklists1001'
import { parseSetYouTubeId } from './dj-index'
import { pushConfigured, sendPushToAll, type PushPayload } from './web-push'
import {
  enqueueMkvidRequest,
  extractSetAudioSource,
  extractSetDate,
  extractSetTitle,
  getMkvidRequestForSet,
  retryMkvidRequest,
  supersedeMkvidRequestForSet,
  type MkvidSourceKind,
} from './mkvid'

const nowSeconds = () => Math.floor(Date.now() / 1000)
const DAY = 24 * 60 * 60

// ─── settings ───────────────────────────────────────────────────────────────

export const DEFAULT_SWEEP_DAILY_REMOVALS = 40
/** Comparison cadence (decision 24). */
export const COMPARE_INTERVAL_SECONDS = 6 * 60 * 60
/** The sweep re-evaluates on the same cadence; its deletes are budgeted per UTC day. */
export const SWEEP_INTERVAL_SECONDS = 6 * 60 * 60
/** Page cap for one playlist listing: 200 pages = 10 000 items, far above any real playlist. */
const LIST_MAX_PAGES = 200

export type SweepSettings = { dryRun: boolean; dailyRemovals: number }

/**
 * `PLAYLIST_SWEEP_DRY_RUN` is TRUE unless explicitly set to 0/false/no/off —
 * the opposite default of every other flag in this repo, on purpose: the
 * first production sweep only reports. `PLAYLIST_SWEEP_DAILY_REMOVALS`
 * (default 40) caps playlistItems.delete calls per UTC day (50 units each).
 */
export function sweepSettings(env: Pick<Env, 'PLAYLIST_SWEEP_DRY_RUN' | 'PLAYLIST_SWEEP_DAILY_REMOVALS'>): SweepSettings {
  const dryRun = !/^\s*(0|false|no|off)\s*$/i.test(env.PLAYLIST_SWEEP_DRY_RUN ?? '')
  const n = Number(env.PLAYLIST_SWEEP_DAILY_REMOVALS)
  const dailyRemovals = env.PLAYLIST_SWEEP_DAILY_REMOVALS !== undefined && env.PLAYLIST_SWEEP_DAILY_REMOVALS !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_SWEEP_DAILY_REMOVALS
  return { dryRun, dailyRemovals }
}

// ─── set facts ──────────────────────────────────────────────────────────────

export type SetFacts = {
  setUrl: string
  slug: string
  videoId: string | null
  noFullNotice: boolean
  lastCueSeconds: number | null
  audioMaxSeconds: number | null
  audioKind: MkvidSourceKind | null
  audioUrl: string | null
  setTitle: string | null
  setDate: string | null
  trackCount: number | null
  idedCount: number | null
  fetchedAt: number
}

/** Everything the rule needs from one set page, read from HTML the sync already has. */
export function extractSetFacts(slug: string, setUrl: string, html: string, videoId: string | null, now = nowSeconds()): SetFacts {
  // Read with the light helpers, not parseTracklist: this runs on every page
  // fetch and needs only the cue map and the row flags.
  let cue: number | null = null
  for (const s of parseCueValueData(html).values()) if (cue === null || s > cue) cue = s
  let trackCount = 0
  let idedCount = 0
  TRACK_ROW_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TRACK_ROW_RE.exec(html))) {
    trackCount++
    if (m[1] === 'true') idedCount++
  }
  const source = extractSetAudioSource(html)
  return {
    setUrl,
    slug,
    videoId,
    noFullNotice: hasNoFullRecordingNotice(html),
    lastCueSeconds: cue,
    audioMaxSeconds: maxAudioSeconds(html),
    audioKind: source?.kind ?? null,
    audioUrl: source?.url ?? null,
    setTitle: extractSetTitle(html),
    setDate: extractSetDate(setUrl, html),
    trackCount: trackCount || null,
    idedCount: trackCount ? idedCount : null,
    fetchedAt: now,
  }
}

/** A tracklist row: `<div … class="tlpTog bItm tlpItem trRow1" data-trno="0" data-id="…" data-isided="true"`. */
const TRACK_ROW_RE = /class="[^"]*\btlpItem\b[^"]*"[^>]*?\bdata-isided="(true|false)"/g

/**
 * Page facts for a set page fetched OUTSIDE the sync (phone, the tracklist
 * viewer, a purge refetch — lib/tracklist-resolve.ts). The sync's own fetches
 * (new, recheck, verification) store them through pickSetVideo. The facts are
 * real even on a decoy page (only names are randomized), so this runs before
 * any decoy refusal. `slug` is the DJ the set is synced under, else the one
 * already on record, else '' until a sync fetch fills it. Never throws.
 */
export async function recordPageFacts(env: Env, setUrl: string, html: string, log?: Logger): Promise<void> {
  if (!/\/tracklist\/[^/]+\//.test(setUrl)) return
  try {
    const db = dbOf(env)
    const tl = await db.prepare('SELECT MIN(slug) AS slug FROM tracklists WHERE url = ?').bind(setUrl).first<{ slug: string | null }>()
    const prev = tl?.slug ? null : await db.prepare('SELECT slug FROM set_media_facts WHERE set_url = ?').bind(setUrl).first<{ slug: string }>()
    await saveSetFacts(env, extractSetFacts(tl?.slug ?? prev?.slug ?? '', setUrl, html, parseSetYouTubeId(html)))
  } catch (e) {
    log?.warn('hygiene.page_facts_failed', { setUrl, ...errorFields(e) })
  }
}

export async function saveSetFacts(env: Env, f: SetFacts): Promise<void> {
  await dbOf(env)
    .prepare(
      `INSERT INTO set_media_facts (set_url, slug, video_id, no_full_notice, last_cue_seconds, audio_max_seconds, audio_kind, audio_url, set_title, set_date, last_cue_known, track_count, ided_count, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(set_url) DO UPDATE SET slug = excluded.slug, video_id = excluded.video_id, no_full_notice = excluded.no_full_notice,
         last_cue_seconds = excluded.last_cue_seconds, audio_max_seconds = excluded.audio_max_seconds, audio_kind = excluded.audio_kind,
         audio_url = excluded.audio_url, set_title = excluded.set_title, set_date = excluded.set_date, last_cue_known = excluded.last_cue_known,
         track_count = excluded.track_count, ided_count = excluded.ided_count, fetched_at = excluded.fetched_at`,
    )
    .bind(
      f.setUrl, f.slug, f.videoId, f.noFullNotice ? 1 : 0, f.lastCueSeconds, f.audioMaxSeconds, f.audioKind, f.audioUrl,
      f.setTitle, f.setDate, f.lastCueSeconds === null ? 0 : 1, f.trackCount, f.idedCount, f.fetchedAt,
    )
    .run()
}

type FactsRow = {
  set_url: string
  slug: string
  video_id: string | null
  no_full_notice: number
  last_cue_seconds: number | null
  audio_max_seconds: number | null
  audio_kind: string | null
  audio_url: string | null
  set_title: string | null
  set_date: string | null
  track_count: number | null
  ided_count: number | null
  fetched_at: number
}

const factsFromRow = (r: FactsRow): SetFacts => ({
  setUrl: r.set_url,
  slug: r.slug,
  videoId: r.video_id,
  noFullNotice: Number(r.no_full_notice) === 1,
  lastCueSeconds: r.last_cue_seconds === null ? null : Number(r.last_cue_seconds),
  audioMaxSeconds: r.audio_max_seconds === null ? null : Number(r.audio_max_seconds),
  audioKind: (r.audio_kind as MkvidSourceKind | null) ?? null,
  audioUrl: r.audio_url,
  setTitle: r.set_title,
  setDate: r.set_date,
  trackCount: r.track_count === null ? null : Number(r.track_count),
  idedCount: r.ided_count === null ? null : Number(r.ided_count),
  fetchedAt: Number(r.fetched_at),
})

export async function loadSetFacts(env: Env, setUrls: string[]): Promise<Map<string, SetFacts>> {
  const out = new Map<string, SetFacts>()
  const urls = [...new Set(setUrls)]
  const db = dbOf(env)
  for (let i = 0; i < urls.length; i += 90) {
    const chunk = urls.slice(i, i + 90)
    const res = await db.prepare(`SELECT * FROM set_media_facts WHERE set_url IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all<FactsRow>()
    for (const r of res.results) out.set(r.set_url, factsFromRow(r))
  }
  return out
}

// ─── the rule, applied ──────────────────────────────────────────────────────

export type VideoVerdict = { ok: true } | { ok: false; reason: RejectReason | 'dead'; detail: string }

/** The rule for one video, from whatever is known: facts may be missing, meta may be missing. */
/**
 * `REJECT_VERTICAL` (default OFF): the vertical rule (d) reads videos.list
 * embed sizes, which have not been verified live to follow a Short's aspect
 * ratio. Until the orchestrator checks a known Short and a known 16:9 video
 * with read-only calls, a vertical-looking video is NOT rejected.
 */
export function rejectVerticalEnabled(env: Pick<Env, 'REJECT_VERTICAL'>): boolean {
  return /^\s*(1|true|yes|on)\s*$/i.test(env.REJECT_VERTICAL ?? '')
}

export function judgeVideo(facts: SetFacts | null | undefined, meta: VideoMeta | null | undefined, opts: { rejectVertical?: boolean } = {}): VideoVerdict {
  if (meta && !meta.alive) return { ok: false, reason: 'dead', detail: 'videos.list: deleted or private' }
  const d = decideFullRecording({
    notice: facts ? facts.noFullNotice : null,
    lastCueSeconds: facts?.lastCueSeconds ?? null,
    audioMaxSeconds: facts?.audioMaxSeconds ?? null,
    videoSeconds: meta?.durationSeconds ?? null,
    embedWidth: meta?.embedWidth ?? null,
    embedHeight: meta?.embedHeight ?? null,
    rejectVertical: opts.rejectVertical === true,
  })
  return d.ok ? d : { ok: false, reason: d.reason, detail: d.detail }
}

export const REASON_LABELS: Record<string, string> = {
  ...REJECT_REASON_LABELS,
  dead: 'video deleted or private',
  blocked: 'removed from this playlist before',
  owner: 'removed from the playlist by the owner',
  button: '"remove and replace" on the set',
}

export type SetVideoPick = {
  /** The video the sync may use for this set; null = treat the set as having none. */
  videoId: string | null
  /** Set when the page had a video that was turned down. */
  rejected: { videoId: string; reason: RejectReason | 'dead' | 'blocked'; detail: string } | null
}

/**
 * The sync's gate, called right after it parses a set page. Stores the page's
 * facts, then vets the page's video. Never throws: a failure to look the
 * video up means the rules needing its duration/orientation are skipped (the
 * sweep re-judges it later with the meta it gets then).
 */
export async function pickSetVideo(
  env: Env,
  ctx: { slug: string; setUrl: string; html: string; rawVideoId: string | null; playlistId: string | null; accessToken: string; log: Logger; fetcher?: typeof fetch },
): Promise<SetVideoPick> {
  const { log } = ctx
  let facts: SetFacts | null = null
  try {
    facts = extractSetFacts(ctx.slug, ctx.setUrl, ctx.html, ctx.rawVideoId)
    await saveSetFacts(env, facts)
  } catch (e) {
    log.warn('hygiene.facts_failed', { slug: ctx.slug, setUrl: ctx.setUrl, ...errorFields(e) })
  }
  const videoId = ctx.rawVideoId
  if (!videoId) return { videoId: null, rejected: null }
  try {
    if (ctx.playlistId && (await isBlocked(env, ctx.playlistId, videoId))) {
      log.info('hygiene.video_blocked', { slug: ctx.slug, setUrl: ctx.setUrl, videoId })
      return { videoId: null, rejected: { videoId, reason: 'blocked', detail: REASON_LABELS.blocked! } }
    }
    if (await isOverridden(env, videoId)) return { videoId, rejected: null }
  } catch (e) {
    log.warn('hygiene.blocklist_failed', { slug: ctx.slug, setUrl: ctx.setUrl, videoId, ...errorFields(e) })
  }
  let meta: VideoMeta | null = null
  try {
    meta = (await getVideoMeta(env, [videoId], ctx.accessToken, { fetcher: ctx.fetcher })).get(videoId) ?? null
  } catch (e) {
    log.warn('hygiene.video_meta_failed', { slug: ctx.slug, setUrl: ctx.setUrl, videoId, ...errorFields(e) })
    // m6: without a lookup the duration rules cannot run. A video the sweep
    // already took out is not put back on that basis (it would come out again).
    const swept = await dbOf(env)
      .prepare("SELECT 1 AS x FROM playlist_removals WHERE video_id = ? AND source = 'sweep' AND status = 'removed' LIMIT 1")
      .bind(videoId)
      .first<{ x: number }>()
      .catch(() => null)
    if (swept) return { videoId: null, rejected: { videoId, reason: 'blocked', detail: 'the sweep removed it before; video lookup failed' } }
  }
  const verdict = judgeVideo(facts, meta, { rejectVertical: rejectVerticalEnabled(env) })
  if (verdict.ok) return { videoId, rejected: null }
  log.info('hygiene.video_rejected', { slug: ctx.slug, setUrl: ctx.setUrl, videoId, reason: verdict.reason, detail: verdict.detail })
  return { videoId: null, rejected: { videoId, reason: verdict.reason, detail: verdict.detail } }
}

/** Audit-row note for a rejected page video. */
export function rejectionNote(r: NonNullable<SetVideoPick['rejected']>): string {
  return `not added: ${r.videoId} ${REASON_LABELS[r.reason] ?? r.reason} (${r.detail})`
}

/**
 * For the mkvid eligibility check (W7): does this set have a usable YouTube
 * video? False when it has none, the one it has was removed from its artist
 * playlist (owner, dead, button), or cached facts/meta show it is not a full
 * recording. D1 only — no network — so it can sit on any hot path.
 */
export async function hasGoodVideo(env: Env, set: { slug: string; setUrl: string; videoId: string | null }): Promise<boolean> {
  if (!set.videoId) return false
  if (await isOverridden(env, set.videoId)) return true
  const pl = await dbOf(env).prepare('SELECT playlist_id FROM sub_sync WHERE slug = ?').bind(set.slug).first<{ playlist_id: string | null }>()
  if (pl?.playlist_id && (await isBlocked(env, pl.playlist_id, set.videoId))) return false
  const facts = (await loadSetFacts(env, [set.setUrl])).get(set.setUrl)
  const meta = (await readCachedVideoMeta(env, [set.videoId])).get(set.videoId)
  return judgeVideo(facts, meta, { rejectVertical: rejectVerticalEnabled(env) }).ok
}

// ─── removal log ────────────────────────────────────────────────────────────

export type RemovalSource = 'sweep' | 'owner' | 'dead' | 'button'
export type RemovalStatus = 'would_remove' | 'removed' | 'failed' | 'undone' | 'recorded'

export type RemovalRow = {
  id: number
  at: number
  source: RemovalSource
  status: RemovalStatus
  slug: string | null
  set_url: string | null
  video_id: string
  playlist_id: string
  playlist_kind: 'artist' | 'combined'
  reason: string
  detail: string | null
}

async function logRemoval(
  env: Env,
  r: Omit<RemovalRow, 'id' | 'at'> & { at?: number },
): Promise<void> {
  await dbOf(env)
    .prepare(
      `INSERT INTO playlist_removals (at, source, status, slug, set_url, video_id, playlist_id, playlist_kind, reason, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, video_id, playlist_id) DO UPDATE SET at = excluded.at, status = excluded.status, slug = excluded.slug,
         set_url = excluded.set_url, playlist_kind = excluded.playlist_kind, reason = excluded.reason, detail = excluded.detail`,
    )
    .bind(r.at ?? nowSeconds(), r.source, r.status, r.slug, r.set_url, r.video_id, r.playlist_id, r.playlist_kind, r.reason, r.detail)
    .run()
}

export async function listRemovals(env: Env, opts: { limit?: number; before?: number | null } = {}): Promise<{ rows: RemovalRow[]; next: number | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
  const stmt = opts.before
    ? dbOf(env).prepare('SELECT * FROM playlist_removals WHERE id < ? ORDER BY id DESC LIMIT ?').bind(opts.before, limit + 1)
    : dbOf(env).prepare('SELECT * FROM playlist_removals ORDER BY id DESC LIMIT ?').bind(limit + 1)
  const rows = (await stmt.all<RemovalRow>()).results
  const page = rows.slice(0, limit)
  return { rows: page, next: rows.length > limit ? page[page.length - 1]!.id : null }
}

export async function removalCounts(env: Env): Promise<Record<string, number>> {
  const res = await dbOf(env).prepare('SELECT status, COUNT(*) AS n FROM playlist_removals GROUP BY status').all<{ status: string; n: number }>()
  return Object.fromEntries(res.results.map((r) => [r.status, Number(r.n)]))
}

/** Null a set's video (keeping the baseline known) and make it due now: the next recheck sees "no video" and queues mkvid. */
function clearSetVideoStmt(db: D1Database, slug: string, videoId: string, setUrl?: string | null): D1PreparedStatement {
  return setUrl
    ? db.prepare('UPDATE tracklists SET video_id = NULL, video_source = NULL, video_known = 1, checked_at = 0 WHERE slug = ? AND url = ? AND video_id = ?').bind(slug, setUrl, videoId)
    : db.prepare('UPDATE tracklists SET video_id = NULL, video_source = NULL, video_known = 1, checked_at = 0 WHERE slug = ? AND video_id = ?').bind(slug, videoId)
}

// ─── mkvid's own videos ─────────────────────────────────────────────────────

/**
 * Videos W7's "delete and recreate" replaced and took out of the playlists
 * itself (table `mkvid_old_videos`, migration 0009, keyed by `video_id`). Their
 * absence is not an owner removal. Guarded: the table may not exist yet.
 */
export async function mkvidReplacedIds(env: Env, log?: Logger): Promise<Set<string>> {
  try {
    const res = await dbOf(env).prepare('SELECT video_id FROM mkvid_old_videos').all<{ video_id: string }>()
    return new Set(res.results.map((r) => r.video_id).filter(Boolean))
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!/no such table/i.test(msg)) log?.warn('hygiene.mkvid_old_videos_unreadable', errorFields(e))
    return new Set()
  }
}

/** Every video mkvid uploaded (current, superseded or replaced): full renders by construction, never swept. */
export async function mkvidUploadedIds(env: Env, log?: Logger): Promise<Set<string>> {
  const res = await dbOf(env).prepare('SELECT video_id FROM mkvid_requests WHERE video_id IS NOT NULL').all<{ video_id: string }>()
  const out = new Set(res.results.map((r) => r.video_id))
  for (const id of await mkvidReplacedIds(env, log)) out.add(id)
  return out
}

// ─── sweep ──────────────────────────────────────────────────────────────────

const SWEEP_DELETES_PREFIX = 'hygiene:sweep:deletes:'
const dayKey = (nowMs: number) => new Date(nowMs).toISOString().slice(0, 10)

export async function sweepDeletesUsed(env: Env, nowMs = Date.now()): Promise<number> {
  const raw = await env.CACHE.get(SWEEP_DELETES_PREFIX + dayKey(nowMs))
  const n = raw ? Number.parseInt(raw, 10) : 0
  return Number.isFinite(n) && n > 0 ? n : 0
}

async function bumpSweepDeletes(env: Env, n: number, nowMs = Date.now()): Promise<void> {
  if (n <= 0) return
  const used = await sweepDeletesUsed(env, nowMs)
  await env.CACHE.put(SWEEP_DELETES_PREFIX + dayKey(nowMs), String(used + n), { expirationTtl: 2 * DAY })
}

export type SweepResult = {
  dryRun: boolean
  candidates: number
  judged: number
  rejected: number
  /** Dry run: rejected videos logged as would_remove. */
  reported: number
  removedVideos: number
  deletes: number
  failed: number
  budget: number
  budgetLeft: number
  stoppedBy: 'budget' | 'quota' | null
  metaFailed: boolean
  /** Rejected for one set, but another accepted set of the DJ uses the same video: kept, nothing deleted. */
  keptShared: number
}

type AddedRow = { slug: string; url: string; video_id: string; playlist_id: string | null }

/**
 * Judge every video the sync has put in an artist playlist (tracklists rows
 * with a 1001tl video; mkvid's own renders are not judged — they are the
 * replacement) and remove the rejected ones, or in a dry run only log them.
 */
export async function runRemovalSweep(
  env: Env,
  accessToken: string,
  opts: { log: Logger; settings?: SweepSettings; fetcher?: typeof fetch; nowMs?: number },
): Promise<SweepResult> {
  const { log } = opts
  const nowMs = opts.nowMs ?? Date.now()
  const settings = opts.settings ?? sweepSettings(env)
  const db = dbOf(env)
  const rows = (
    await db
      .prepare(
        `SELECT t.slug, t.url, t.video_id, s.playlist_id FROM tracklists t LEFT JOIN sub_sync s ON s.slug = t.slug
         WHERE t.video_id IS NOT NULL AND COALESCE(t.video_source, '1001tl') != 'mkvid'
         ORDER BY t.slug, t.position`,
      )
      .all<AddedRow>()
  ).results
  const overrides = await overriddenIds(env)
  const mkvidOwn = await mkvidUploadedIds(env, log)
  const candidates = rows.filter((r) => !overrides.has(r.video_id) && !mkvidOwn.has(r.video_id))
  const used = await sweepDeletesUsed(env, nowMs)
  const result: SweepResult = {
    dryRun: settings.dryRun,
    candidates: candidates.length,
    judged: 0,
    rejected: 0,
    reported: 0,
    removedVideos: 0,
    deletes: 0,
    failed: 0,
    budget: settings.dailyRemovals,
    budgetLeft: Math.max(0, settings.dailyRemovals - used),
    stoppedBy: null,
    metaFailed: false,
    keptShared: 0,
  }
  if (candidates.length === 0) return result

  let metas = new Map<string, VideoMeta>()
  try {
    metas = await getVideoMeta(env, candidates.map((r) => r.video_id), accessToken, { fetcher: opts.fetcher, now: Math.floor(nowMs / 1000) })
  } catch (e) {
    // Judge from facts alone; the next sweep retries the lookup.
    result.metaFailed = true
    log.warn('hygiene.sweep.meta_failed', { candidates: candidates.length, ...errorFields(e) })
    if (isQuotaError(e)) return { ...result, stoppedBy: 'quota' }
    metas = await readCachedVideoMeta(env, candidates.map((r) => r.video_id))
  }
  const facts = await loadSetFacts(env, candidates.map((r) => r.url))
  const vertical = rejectVerticalEnabled(env)
  const rejected: Array<AddedRow & { verdict: Extract<VideoVerdict, { ok: false }> }> = []
  for (const r of candidates) {
    result.judged++
    const verdict = judgeVideo(facts.get(r.url), metas.get(r.video_id), { rejectVertical: vertical })
    // Dead videos are the comparison's business (recorded, never re-added,
    // set made mkvid-eligible) — deleting their husk would only spend budget.
    if (!verdict.ok && verdict.reason !== 'dead') rejected.push({ ...r, verdict })
  }
  result.rejected = rejected.length
  const combinedId = (await loadCombinedState(env)).playlistId ?? null

  // B1: a video is taken out of a DJ's playlist only when EVERY set of that DJ
  // that resolves to it is rejected. Any accepted set of the DJ keeps it there
  // (and keeps it in the combined playlist); any accepted set anywhere keeps
  // it in the combined playlist. The sweep never blocklists anything.
  const rejectedKeys = new Set(rejected.map((r) => `${r.slug}\n${r.url}`))
  const acceptedBySlug = new Map<string, Set<string>>()
  const acceptedAnywhere = new Set<string>()
  for (const r of rows) {
    if (rejectedKeys.has(`${r.slug}\n${r.url}`)) continue
    if (!acceptedBySlug.has(r.slug)) acceptedBySlug.set(r.slug, new Set())
    acceptedBySlug.get(r.slug)!.add(r.video_id)
    acceptedAnywhere.add(r.video_id)
  }
  const planFor = (r: AddedRow): Array<[string, 'artist' | 'combined']> =>
    targets(r.playlist_id, combinedId).filter(([, kind]) => (kind === 'artist' ? !acceptedBySlug.get(r.slug)?.has(r.video_id) : !acceptedAnywhere.has(r.video_id)))

  if (settings.dryRun) {
    for (const r of rejected) {
      const plan = planFor(r)
      if (plan.length === 0) {
        result.keptShared++
        continue
      }
      for (const [pl, kind] of plan) {
        await logRemoval(env, { source: 'sweep', status: 'would_remove', slug: r.slug, set_url: r.url, video_id: r.video_id, playlist_id: pl, playlist_kind: kind, reason: r.verdict.reason, detail: r.verdict.detail })
      }
      result.reported++
    }
    log.info('hygiene.sweep.dry_run', { ...result })
    return result
  }

  let budgetLeft = result.budgetLeft
  const touched = new Set<string>()
  // The same video in two rejected rows of one DJ: remove once, clear both rows.
  const done = new Set<string>()
  for (const r of rejected) {
    const plan = planFor(r).filter(([pl]) => !done.has(`${pl}\n${r.video_id}`))
    if (plan.length === 0) {
      // Still used by an accepted set (or already taken out for a sibling row):
      // nothing is deleted; only this set loses the video it cannot use.
      await clearSetVideoStmt(db, r.slug, r.video_id, r.url).run()
      if (!planFor(r).length) {
        result.keptShared++
        log.info('hygiene.sweep.kept_shared', { slug: r.slug, setUrl: r.url, videoId: r.video_id, reason: r.verdict.reason })
      }
      continue
    }
    if (budgetLeft < plan.length) {
      result.stoppedBy = 'budget'
      break
    }
    let quota = false
    let allOk = true
    let deletesHere = 0
    for (const [pl, kind] of plan) {
      try {
        const n = await removeVideoFromPlaylist(pl, r.video_id, accessToken, opts.fetcher)
        done.add(`${pl}\n${r.video_id}`)
        deletesHere += n
        budgetLeft -= n
        // Counted per delete (m3): a throw or a killed run later on cannot leave deletes uncounted.
        await bumpSweepDeletes(env, n, nowMs)
        touched.add(pl)
        // Taken out by tracked itself: the comparison must never read its absence as the owner's doing.
        await markOutOfPlaylist(env, pl, r.video_id, 'sweep')
        await logRemoval(env, { source: 'sweep', status: 'removed', slug: r.slug, set_url: r.url, video_id: r.video_id, playlist_id: pl, playlist_kind: kind, reason: r.verdict.reason, detail: n === 0 ? `${r.verdict.detail}; was not in the playlist` : r.verdict.detail })
        // Out of the artist playlist: the set has no video from now on (m4: before the combined step can fail).
        if (kind === 'artist') await clearSetVideoStmt(db, r.slug, r.video_id, r.url).run()
      } catch (e) {
        result.failed++
        allOk = false
        log.warn('hygiene.sweep.remove_failed', { slug: r.slug, setUrl: r.url, videoId: r.video_id, playlistId: pl, ...errorFields(e) })
        await logRemoval(env, { source: 'sweep', status: 'failed', slug: r.slug, set_url: r.url, video_id: r.video_id, playlist_id: pl, playlist_kind: kind, reason: r.verdict.reason, detail: (e instanceof Error ? e.message : String(e)).slice(0, 300) })
        if (isQuotaError(e)) {
          quota = true
          break
        }
      }
    }
    result.deletes += deletesHere
    if (!plan.some(([, kind]) => kind === 'artist')) {
      // Only the combined playlist was in the plan: the DJ has no artist playlist, the set still loses its video.
      await clearSetVideoStmt(db, r.slug, r.video_id, r.url).run()
    }
    if (allOk) result.removedVideos++
    log.info('hygiene.sweep.removed', { slug: r.slug, setUrl: r.url, videoId: r.video_id, reason: r.verdict.reason, deletes: deletesHere })
    if (quota) {
      result.stoppedBy = 'quota'
      break
    }
  }
  for (const pl of touched) await invalidatePlaylistVideoIds(env, pl)
  result.budgetLeft = Math.max(0, budgetLeft)
  log.info('hygiene.sweep.done', { ...result })
  return result
}

function targets(artistId: string | null, combinedId: string | null): Array<[string, 'artist' | 'combined']> {
  const out: Array<[string, 'artist' | 'combined']> = []
  if (artistId) out.push([artistId, 'artist'])
  if (combinedId && combinedId !== artistId) out.push([combinedId, 'combined'])
  return out
}

// ─── comparison ─────────────────────────────────────────────────────────────

/** YouTube's placeholder titles for items whose video is gone. */
const DEAD_ITEM_TITLES = new Set(['Deleted video', 'Private video'])

function itemVideoId(it: RawPlaylistItem): string | null {
  return it.contentDetails?.videoId ?? it.snippet?.resourceId?.videoId ?? null
}

function itemTitle(it: RawPlaylistItem): string | null {
  const t = (it.snippet as { title?: unknown } | undefined)?.title
  return typeof t === 'string' ? t : null
}

/** A playlist's contents, or null when the listing was not complete and successful. */
async function completeListing(
  playlistId: string,
  accessToken: string,
  log: Logger,
  fetcher?: typeof fetch,
): Promise<{ present: Set<string>; deadPresent: Set<string> } | null> {
  try {
    const r = await listPlaylistItems(playlistId, accessToken, { maxPages: LIST_MAX_PAGES }, fetcher)
    if (r.nextPageToken) {
      log.warn('hygiene.compare.listing_incomplete', { playlistId, pages: r.pages })
      return null
    }
    const present = new Set<string>()
    const deadPresent = new Set<string>()
    for (const it of r.items) {
      const id = itemVideoId(it)
      if (!id) {
        // A part/format change or a partial body: nothing may be inferred from this listing.
        log.warn('hygiene.compare.item_without_video_id', { playlistId })
        return null
      }
      present.add(id)
      const title = itemTitle(it)
      if (title && DEAD_ITEM_TITLES.has(title)) deadPresent.add(id)
    }
    return { present, deadPresent }
  } catch (e) {
    log.warn('hygiene.compare.listing_failed', { playlistId, ...errorFields(e) })
    return null
  }
}

/** A held playlist: what the comparison would have recorded, waiting for the owner. */
export type PlaylistHold = {
  playlistId: string
  kind: 'artist' | 'combined'
  slug: string | null
  expected: number
  missing: number
  /** The exact ids that looked removed (sorted); an approval covers exactly these. */
  missingIds: string[]
  /** Held by the run-wide breaker rather than this playlist's own guard. */
  runWide: boolean
  at: number
  notified: boolean
}

const HOLD_PREFIX = 'hygiene:hold:'
const APPROVE_PREFIX = 'hygiene:approve:'
/** An approval answers one hold: its exact ids, for this long. */
export const HOLD_APPROVAL_TTL_SECONDS = 24 * 60 * 60

type HoldApproval = { missingIds: string[]; at: number }

export async function listHolds(env: Env): Promise<PlaylistHold[]> {
  const out: PlaylistHold[] = []
  const r = await env.SUBS.list({ prefix: HOLD_PREFIX })
  for (const k of r.keys) {
    const h = (await env.SUBS.get(k.name, 'json')) as PlaylistHold | null
    if (h) out.push({ ...h, missingIds: h.missingIds ?? [], runWide: h.runWide ?? false })
  }
  return out
}

/**
 * Owner looked at a held playlist and says the removals are real. The
 * approval covers exactly the ids that hold showed, for 24 hours: a later,
 * different set of missing videos is held again.
 */
export async function approveHold(env: Env, playlistId: string, now = nowSeconds()): Promise<boolean> {
  const h = (await env.SUBS.get(HOLD_PREFIX + playlistId, 'json')) as PlaylistHold | null
  if (!h) return false
  const approval: HoldApproval = { missingIds: [...(h.missingIds ?? [])].sort(), at: now }
  await env.SUBS.put(APPROVE_PREFIX + playlistId, JSON.stringify(approval), { expirationTtl: HOLD_APPROVAL_TTL_SECONDS })
  return true
}

async function approvalCovers(env: Env, playlistId: string, missingIds: string[], now: number): Promise<boolean> {
  const a = (await env.SUBS.get(APPROVE_PREFIX + playlistId, 'json').catch(() => null)) as HoldApproval | null
  if (!a || !Array.isArray(a.missingIds) || typeof a.at !== 'number') return false
  if (now - a.at > HOLD_APPROVAL_TTL_SECONDS) return false
  const want = [...missingIds].sort()
  return want.length === a.missingIds.length && want.every((id, i) => id === a.missingIds[i])
}

async function clearHold(env: Env, playlistId: string): Promise<void> {
  await env.SUBS.delete(HOLD_PREFIX + playlistId)
  await env.SUBS.delete(APPROVE_PREFIX + playlistId)
}

/** Hold a playlist when more than this share of what tracked put there seems gone... */
export const MASS_REMOVAL_RATIO = 0.3
/** ...or more than this many videos. */
export const MASS_REMOVAL_MAX = 5
/** More than this many videos missing across every playlist in one run: hold them all and push once. */
export const RUN_REMOVAL_MAX = 15

/** Per-playlist guard against a partial view being read as a mass removal. Pure. */
export function isMassRemoval(missing: number, expected: number): boolean {
  if (missing <= 0) return false
  return missing > MASS_REMOVAL_MAX || (expected > 0 && missing / expected > MASS_REMOVAL_RATIO)
}

/** Tells the owner. Resolves false when nothing was sent (push not set up, no device took it): the hold then notifies again next time. */
export type Notifier = (title: string, body: string) => Promise<boolean | void>

/**
 * The cron's notifier for a held comparison: a Web Push (kind `playlist_hold`)
 * to every subscribed device, opening /subscriptions/removed, at any hour.
 * Returns false when nothing was delivered, so the hold stays un-notified
 * and the next 6-hourly comparison tries again.
 */
export function playlistHoldPayload(title: string, body: string, now: Date = new Date()): PushPayload {
  return { kind: 'playlist_hold', title, body, url: '/subscriptions/removed', tag: 'playlist-hold', ts: now.toISOString() }
}

export function playlistHoldNotifier(env: Env, log?: Logger, fetchImpl?: typeof fetch): Notifier {
  return async (title, body) => {
    if (!pushConfigured(env)) return false
    const r = await sendPushToAll(env, playlistHoldPayload(title, body), log, fetchImpl ?? fetch)
    return r.sent > 0
  }
}

export type ComparePlaylistResult = {
  playlistId: string
  kind: 'artist' | 'combined'
  slug: string | null
  status: 'ok' | 'incomplete' | 'held' | 'first_snapshot'
  expected: number
  missing: number
  owner: number
  dead: number
}

type RemovalFinding = { videoId: string; reason: 'owner' | 'dead'; setUrls: string[] }

async function classify(
  env: Env,
  ids: string[],
  deadPresent: ReadonlySet<string>,
  accessToken: string,
  log: Logger,
  fetcher?: typeof fetch,
): Promise<Map<string, 'owner' | 'dead'>> {
  const out = new Map<string, 'owner' | 'dead'>()
  const needLookup = ids.filter((id) => !deadPresent.has(id))
  let metas = new Map<string, VideoMeta>()
  if (needLookup.length > 0) {
    try {
      metas = await getVideoMeta(env, needLookup, accessToken, { maxAgeSeconds: 0, fetcher })
    } catch (e) {
      // Both labels get the same treatment; without the lookup it is "owner".
      log.warn('hygiene.compare.liveness_failed', { count: needLookup.length, ...errorFields(e) })
    }
  }
  for (const id of ids) out.set(id, deadPresent.has(id) || metas.get(id)?.alive === false ? 'dead' : 'owner')
  return out
}

async function applyFindings(
  env: Env,
  findings: RemovalFinding[],
  ctx: { playlistId: string; kind: 'artist' | 'combined'; slug: string | null },
): Promise<void> {
  const db = dbOf(env)
  const stmts: D1PreparedStatement[] = []
  for (const f of findings) {
    const setUrl = f.setUrls[0] ?? null
    await recordRemoved(env, { playlistId: ctx.playlistId, videoId: f.videoId, slug: ctx.slug, setUrl, reason: f.reason })
    await logRemoval(env, {
      source: f.reason,
      status: 'recorded',
      slug: ctx.slug,
      set_url: setUrl,
      video_id: f.videoId,
      playlist_id: ctx.playlistId,
      playlist_kind: ctx.kind,
      reason: f.reason,
      detail: f.reason === 'dead' ? 'gone from YouTube; never re-added here' : 'missing from the playlist, still on YouTube; never re-added here',
    })
    // Artist playlist: the set no longer has a video — due for recheck, and mkvid-eligible from it.
    if (ctx.kind === 'artist' && ctx.slug) stmts.push(clearSetVideoStmt(db, ctx.slug, f.videoId))
  }
  await batchChunked(db, stmts)
}

/** Videos the audit trail shows the sync (or mkvid delivery) successfully inserted for a DJ. */
async function auditedInserts(env: Env, slug: string): Promise<Set<string>> {
  const res = await dbOf(env)
    .prepare("SELECT DISTINCT video_id FROM playlist_additions WHERE slug = ? AND status IN ('added', 'replaced') AND video_id IS NOT NULL")
    .bind(slug)
    .all<{ video_id: string }>()
  return new Set(res.results.map((r) => r.video_id))
}

type Pending = {
  /** Index of this playlist's entry in the results (listing order). */
  slot: number
  ctx: { playlistId: string; kind: 'artist' | 'combined'; slug: string | null }
  expected: number
  missing: string[]
  deadHere: string[]
  deadPresent: ReadonlySet<string>
  setUrlsOf: (id: string) => string[]
  /** Run after findings are applied (the combined playlist saves its snapshot). */
  after?: () => Promise<void>
}

/**
 * List every managed playlist in full and compare it with what tracked put
 * there. Evidence that a video belongs in a playlist (anything else is never
 * read as removed):
 *   - artist playlists: a confirmed insert or a sighting in an earlier
 *     complete listing (`playlist_confirmed` state `in`), or — so removals
 *     made before this existed are still found — an `added`/`replaced` audit
 *     row for the DJ that tracked never took back out (`out`). The video must
 *     also still be what one of the DJ's sets resolves to.
 *   - the combined playlist: its own last complete listing (first run only
 *     records one).
 * Guards: a playlist with more than 30% or more than 5 of its videos missing
 * is held; more than 15 missing across the whole run holds every playlist
 * with a missing video and pushes once. A hold is applied only after the
 * owner approves exactly those ids (valid 24 h).
 */
export async function comparePlaylists(
  env: Env,
  accessToken: string,
  opts: { log: Logger; notify?: Notifier; fetcher?: typeof fetch; now?: number },
): Promise<ComparePlaylistResult[]> {
  const { log } = opts
  const now = opts.now ?? nowSeconds()
  const db = dbOf(env)
  const subs = (await db.prepare('SELECT slug, playlist_id FROM sub_sync WHERE playlist_id IS NOT NULL').all<{ slug: string; playlist_id: string }>()).results
  const rows = (await db.prepare('SELECT slug, url, video_id FROM tracklists WHERE video_id IS NOT NULL').all<{ slug: string; url: string; video_id: string }>()).results
  // Taken out by mkvid's delete-and-recreate itself: not the owner's doing.
  const replaced = await mkvidReplacedIds(env, log)
  const bySlug = new Map<string, Map<string, string[]>>()
  const allExpected = new Map<string, string[]>()
  for (const r of rows) {
    if (replaced.has(r.video_id)) continue
    if (!bySlug.has(r.slug)) bySlug.set(r.slug, new Map())
    const m = bySlug.get(r.slug)!
    m.set(r.video_id, [...(m.get(r.video_id) ?? []), r.url])
    allExpected.set(r.video_id, [...(allExpected.get(r.video_id) ?? []), r.url])
  }
  const results: ComparePlaylistResult[] = []
  const pending: Pending[] = []

  // ── phase 1: list everything, work out what looks removed ────────────────
  for (const s of subs) {
    const ctx = { playlistId: s.playlist_id, kind: 'artist' as const, slug: s.slug }
    const referenced = bySlug.get(s.slug) ?? new Map<string, string[]>()
    const listing = await completeListing(s.playlist_id, accessToken, log, opts.fetcher)
    if (!listing) {
      results.push({ ...ctx, status: 'incomplete', expected: 0, missing: 0, owner: 0, dead: 0 })
      continue
    }
    await cachePlaylistVideoIds(env, s.playlist_id, listing.present)
    const blocked = await blockedIds(env, s.playlist_id)
    const membership = await confirmedMembership(env, s.playlist_id)
    const audited = await auditedInserts(env, s.slug)
    const expected = [...referenced.keys()].filter((id) => !blocked.has(id) && (membership.get(id) === 'in' || (membership.get(id) !== 'out' && audited.has(id))))
    // Snapshot: what a complete listing shows of the DJ's own videos counts as confirmed from now on.
    for (const id of referenced.keys()) if (listing.present.has(id) && membership.get(id) !== 'in') await markInPlaylist(env, s.playlist_id, id, 'listing', now)
    pending.push({
      slot: results.push({ ...ctx, status: 'ok', expected: 0, missing: 0, owner: 0, dead: 0 }) - 1,
      ctx,
      expected: expected.length,
      missing: expected.filter((id) => !listing.present.has(id)),
      deadHere: expected.filter((id) => listing.deadPresent.has(id)),
      deadPresent: listing.deadPresent,
      setUrlsOf: (id) => referenced.get(id) ?? [],
    })
  }

  const combined = await loadCombinedState(env)
  if (combined.playlistId) {
    const combinedId = combined.playlistId
    const ctx = { playlistId: combinedId, kind: 'combined' as const, slug: null }
    const listing = await completeListing(combinedId, accessToken, log, opts.fetcher)
    if (!listing) {
      results.push({ ...ctx, status: 'incomplete', expected: 0, missing: 0, owner: 0, dead: 0 })
    } else {
      await cachePlaylistVideoIds(env, combinedId, listing.present)
      const members = await playlistMembers(env, combinedId)
      if (members.size === 0) {
        await savePlaylistMembers(env, combinedId, listing.present, now)
        results.push({ ...ctx, status: 'first_snapshot', expected: 0, missing: 0, owner: 0, dead: 0 })
      } else {
        const unavailable = new Set(combined.unavailableVideoIds ?? [])
        const blocked = await blockedIds(env, combinedId)
        const expected = [...members].filter((id) => allExpected.has(id) && !unavailable.has(id) && !blocked.has(id))
        pending.push({
          slot: results.push({ ...ctx, status: 'ok', expected: 0, missing: 0, owner: 0, dead: 0 }) - 1,
          ctx,
          expected: expected.length,
          missing: expected.filter((id) => !listing.present.has(id)),
          deadHere: expected.filter((id) => listing.deadPresent.has(id)),
          deadPresent: listing.deadPresent,
          setUrlsOf: (id) => allExpected.get(id) ?? [],
          // Saved only when applied: a held playlist keeps its old snapshot, so the backfill keeps skipping the held ids.
          after: () => savePlaylistMembers(env, combinedId, listing.present, now),
        })
      }
    }
  }

  // ── phase 2: guards ──────────────────────────────────────────────────────
  const approved = new Set<string>()
  for (const p of pending) if (p.missing.length > 0 && (await approvalCovers(env, p.ctx.playlistId, p.missing, now))) approved.add(p.ctx.playlistId)
  const runMissing = pending.filter((p) => !approved.has(p.ctx.playlistId)).reduce((n, p) => n + p.missing.length, 0)
  const breaker = runMissing > RUN_REMOVAL_MAX
  if (breaker) log.error('hygiene.compare.run_breaker', { runMissing, playlists: pending.filter((p) => p.missing.length > 0).length })
  const newHolds: PlaylistHold[] = []

  for (const p of pending) {
    const { ctx } = p
    let hold = false
    if (p.missing.length === 0) await clearHold(env, ctx.playlistId)
    else if (approved.has(ctx.playlistId)) {
      await clearHold(env, ctx.playlistId)
      log.warn('hygiene.compare.hold_approved', { ...ctx, expected: p.expected, missing: p.missing.length })
    } else if (breaker || isMassRemoval(p.missing.length, p.expected)) hold = true
    else await clearHold(env, ctx.playlistId)

    if (hold) {
      const prev = (await env.SUBS.get(HOLD_PREFIX + ctx.playlistId, 'json')) as PlaylistHold | null
      const missingIds = [...p.missing].sort().slice(0, 500)
      const sameIds = !!prev && JSON.stringify(prev.missingIds ?? []) === JSON.stringify(missingIds)
      const h: PlaylistHold = { ...ctx, expected: p.expected, missing: p.missing.length, missingIds, runWide: breaker && !isMassRemoval(p.missing.length, p.expected), at: sameIds ? prev!.at : now, notified: sameIds ? prev!.notified : false }
      log.error('hygiene.compare.held', { ...h, missingIds: missingIds.slice(0, 20) })
      newHolds.push(h)
      results[p.slot] = { ...ctx, status: 'held', expected: p.expected, missing: p.missing.length, owner: 0, dead: 0 }
      continue
    }
    const ids = [...new Set([...p.missing, ...p.deadHere])]
    const labels = await classify(env, ids, p.deadPresent, accessToken, log, opts.fetcher)
    const findings = ids.map((id) => ({ videoId: id, reason: labels.get(id)!, setUrls: p.setUrlsOf(id) }))
    await applyFindings(env, findings, ctx)
    if (p.after) await p.after()
    const owner = findings.filter((f) => f.reason === 'owner').length
    results[p.slot] = { ...ctx, status: 'ok', expected: p.expected, missing: p.missing.length, owner, dead: findings.length - owner }
    if (findings.length > 0) log.warn('hygiene.compare.removals_recorded', { ...ctx, owner, dead: findings.length - owner, videoIds: ids.slice(0, 50) })
  }

  // ── notify: one push per new hold, or one for the whole run when the breaker tripped ──
  const unnotified = newHolds.filter((h) => !h.notified)
  if (unnotified.length > 0 && opts.notify) {
    const title = breaker ? 'Playlist check held: too many removals' : 'Playlist check held'
    const messages = breaker
      ? [`${runMissing} videos across ${newHolds.length} playlists seem to be gone in one check. Nothing was recorded; review at /subscriptions/removed.`]
      : unnotified.map((h) => `${h.kind === 'combined' ? 'The combined playlist' : `${h.slug}'s playlist`} seems to have lost ${h.missing} of ${h.expected} videos. Nothing was recorded; review at /subscriptions/removed.`)
    let allSent = true
    for (const body of messages) {
      try {
        if ((await opts.notify(title, body)) === false) allSent = false
      } catch (e) {
        allSent = false
        log.warn('hygiene.compare.notify_failed', errorFields(e))
      }
    }
    if (allSent) for (const h of unnotified) h.notified = true
  }
  for (const h of newHolds) await env.SUBS.put(HOLD_PREFIX + h.playlistId, JSON.stringify(h))

  log.info('hygiene.compare.done', { playlists: results.length, held: newHolds.length, breaker, incomplete: results.filter((r) => r.status === 'incomplete').length })
  return results
}

// ─── remove and replace ─────────────────────────────────────────────────────

export type RemoveReplaceResult =
  | { ok: false; error: 'not_found' | 'no_video' | 'mkvid_video' }
  | { ok: true; videoId: string; removedFrom: Array<{ playlistId: string; kind: 'artist' | 'combined'; deleted: number }>; mkvid: string }

/**
 * The set page's "remove and replace": take the set's video out of its
 * artist playlist and the combined one now, record it as owner-removed for
 * both (never re-added), and queue the set for mkvid when its page had an
 * audio source. Owner action: not charged to the sweep's daily budget.
 * Refused for an mkvid render (m10): "delete and recreate" is the path there.
 */
export async function removeAndReplace(
  env: Env,
  accessToken: string,
  input: { slug: string; setUrl: string; log: Logger; fetcher?: typeof fetch },
): Promise<RemoveReplaceResult> {
  const { log } = input
  const db = dbOf(env)
  const row = await db.prepare('SELECT video_id, video_source FROM tracklists WHERE slug = ? AND url = ?').bind(input.slug, input.setUrl).first<{ video_id: string | null; video_source: string | null }>()
  if (!row) return { ok: false, error: 'not_found' }
  if (!row.video_id) return { ok: false, error: 'no_video' }
  if (row.video_source === 'mkvid' || (await mkvidUploadedIds(env, log)).has(row.video_id)) return { ok: false, error: 'mkvid_video' }
  const videoId = row.video_id
  const artist = (await db.prepare('SELECT playlist_id FROM sub_sync WHERE slug = ?').bind(input.slug).first<{ playlist_id: string | null }>())?.playlist_id ?? null
  const combinedId = (await loadCombinedState(env)).playlistId ?? null
  const removedFrom: Array<{ playlistId: string; kind: 'artist' | 'combined'; deleted: number }> = []
  for (const [pl, kind] of targets(artist, combinedId)) {
    const deleted = await removeVideoFromPlaylist(pl, videoId, accessToken, input.fetcher)
    removedFrom.push({ playlistId: pl, kind, deleted })
    await markOutOfPlaylist(env, pl, videoId, 'button')
    await recordRemoved(env, { playlistId: pl, videoId, slug: input.slug, setUrl: input.setUrl, reason: 'button' })
    await logRemoval(env, { source: 'button', status: 'removed', slug: input.slug, set_url: input.setUrl, video_id: videoId, playlist_id: pl, playlist_kind: kind, reason: 'button', detail: `deleted ${deleted} item(s)` })
    await invalidatePlaylistVideoIds(env, pl)
  }
  await clearSetVideoStmt(db, input.slug, videoId, input.setUrl).run()
  const mkvid = await queueForMkvid(env, input.slug, input.setUrl, log)
  log.info('hygiene.remove_replace', { slug: input.slug, setUrl: input.setUrl, videoId, removedFrom, mkvid })
  return { ok: true, videoId, removedFrom, mkvid }
}

/** Queue a set for mkvid from its stored page facts (no 1001tracklists fetch). */
async function queueForMkvid(env: Env, slug: string, setUrl: string, log: Logger): Promise<string> {
  if (!env.MKVID_TOKEN) return 'mkvid not configured'
  const f = (await loadSetFacts(env, [setUrl])).get(setUrl)
  if (!f?.audioKind || !f.audioUrl) return f ? 'no audio source on the set page' : 'set page not seen since this feature shipped; the next recheck decides'
  try {
    const artistName = (await dbOf(env).prepare('SELECT artist_name FROM sub_sync WHERE slug = ?').bind(slug).first<{ artist_name: string | null }>())?.artist_name ?? slug
    const r = await enqueueMkvidRequest(env, {
      slug,
      setUrl,
      artistName,
      setTitle: f.setTitle,
      setDate: f.setDate,
      source: { kind: f.audioKind, url: f.audioUrl },
      lastCueSeconds: f.lastCueSeconds,
      trackCount: f.trackCount ?? 0,
      idedCount: f.idedCount ?? 0,
    })
    if (r === 'queued') return `queued for mkvid (${f.audioKind})`
    const existing = await getMkvidRequestForSet(env, setUrl)
    if (existing && existing.status === 'superseded' && (await retryMkvidRequest(env, existing.id))) return `mkvid request reopened (${f.audioKind})`
    return `mkvid request already exists (${existing?.status ?? 'unknown'})`
  } catch (e) {
    log.warn('hygiene.mkvid_queue_failed', { slug, setUrl, ...errorFields(e) })
    return 'mkvid queueing failed'
  }
}

// ─── undo ───────────────────────────────────────────────────────────────────

export type UndoResult = { ok: true; readded: boolean } | { ok: false; error: 'not_found' | 'not_undoable' }

/**
 * Undo one logged removal: the video goes back into that playlist (unless it
 * was only a dry-run report), leaves the blocklist, and the full-recording
 * rule stops applying to it so the next sweep does not take it out again.
 *   - The row is claimed first (`undoing`), so a double click re-adds once.
 *   - The video is re-inserted BEFORE it leaves the blocklist: a failed
 *     insert keeps it blocked (and the row back in its old state), so the
 *     next comparison cannot record it a second time.
 *   - Every set of the DJ that lost this video gets it back (only where
 *     nothing replaced it meanwhile), and an mkvid request queued for those
 *     sets since the removal is superseded, so no render replaces it later.
 */
export async function undoRemoval(env: Env, accessToken: string, id: number, log: Logger, fetcher?: typeof fetch): Promise<UndoResult> {
  const db = dbOf(env)
  const row = await db.prepare('SELECT * FROM playlist_removals WHERE id = ?').bind(id).first<RemovalRow>()
  if (!row) return { ok: false, error: 'not_found' }
  if (row.source === 'dead' || !['would_remove', 'removed', 'recorded'].includes(row.status)) return { ok: false, error: 'not_undoable' }
  const claimed = await db.prepare("UPDATE playlist_removals SET status = 'undoing' WHERE id = ? AND status = ?").bind(id, row.status).run()
  if ((claimed.meta.changes ?? 0) === 0) return { ok: false, error: 'not_undoable' }
  let readded = false
  try {
    if (row.status !== 'would_remove') {
      await addVideoToPlaylist(row.playlist_id, row.video_id, accessToken, fetcher)
      readded = true
      await markInPlaylist(env, row.playlist_id, row.video_id, 'undo')
      await unblock(env, row.playlist_id, row.video_id)
      await invalidatePlaylistVideoIds(env, row.playlist_id)
      if (row.playlist_kind === 'artist' && row.slug) {
        // The rows this removal cleared: the logged set, and any other set of the DJ whose page links this video.
        const urls = new Set<string>(row.set_url ? [row.set_url] : [])
        const facts = await db.prepare('SELECT set_url FROM set_media_facts WHERE slug = ? AND video_id = ?').bind(row.slug, row.video_id).all<{ set_url: string }>()
        for (const f of facts.results) urls.add(f.set_url)
        for (const url of urls) {
          const r = await db
            .prepare("UPDATE tracklists SET video_id = ?, video_source = '1001tl', video_known = 1 WHERE slug = ? AND url = ? AND video_id IS NULL")
            .bind(row.video_id, row.slug, url)
            .run()
          if ((r.meta.changes ?? 0) > 0 && (await supersedeMkvidRequestForSet(env, url, row.video_id))) log.info('hygiene.undo.mkvid_superseded', { setUrl: url, videoId: row.video_id })
        }
      }
    }
    await setOverride(env, row.video_id)
  } catch (e) {
    await db.prepare("UPDATE playlist_removals SET status = ? WHERE id = ? AND status = 'undoing'").bind(row.status, id).run()
    throw e
  }
  await db.prepare("UPDATE playlist_removals SET status = 'undone' WHERE id = ?").bind(id).run()
  log.info('hygiene.undo', { id, videoId: row.video_id, playlistId: row.playlist_id, readded })
  return { ok: true, readded }
}

// ─── cron entry ─────────────────────────────────────────────────────────────

const LAST_COMPARE_KEY = 'hygiene:last_compare'
const LAST_SWEEP_KEY = 'hygiene:last_sweep'

async function due(env: Env, key: string, interval: number, now: number): Promise<boolean> {
  const raw = await env.SUBS.get(key)
  const last = raw ? Number(raw) : 0
  return !Number.isFinite(last) || now - last >= interval
}

/**
 * Called from every cron tick; does work only when a cadence is due: the
 * comparison every 6 hours, then the sweep. Never throws. Runs whether or not
 * 1001tracklists fetching is paused — it only touches YouTube.
 */
export async function runPlaylistHygiene(
  env: Env,
  log: Logger,
  opts: { accessToken?: string; notify?: Notifier; force?: 'compare' | 'sweep'; fetcher?: typeof fetch; nowMs?: number } = {},
): Promise<{ compare?: ComparePlaylistResult[]; sweep?: SweepResult; skipped?: string }> {
  const nowMs = opts.nowMs ?? Date.now()
  const now = Math.floor(nowMs / 1000)
  try {
    const wantCompare = opts.force ? opts.force === 'compare' : await due(env, LAST_COMPARE_KEY, COMPARE_INTERVAL_SECONDS, now)
    const wantSweep = opts.force ? opts.force === 'sweep' : await due(env, LAST_SWEEP_KEY, SWEEP_INTERVAL_SECONDS, now)
    if (!wantCompare && !wantSweep) return { skipped: 'not_due' }
    const token = opts.accessToken ?? (await getAccessToken(env))?.accessToken
    if (!token) return { skipped: 'youtube_not_connected' }
    const out: { compare?: ComparePlaylistResult[]; sweep?: SweepResult } = {}
    if (wantCompare) {
      await env.SUBS.put(LAST_COMPARE_KEY, String(now))
      out.compare = await comparePlaylists(env, token, { log, notify: opts.notify, fetcher: opts.fetcher, now })
    }
    if (wantSweep) {
      await env.SUBS.put(LAST_SWEEP_KEY, String(now))
      out.sweep = await runRemovalSweep(env, token, { log, fetcher: opts.fetcher, nowMs })
    }
    return out
  } catch (e) {
    log.error('hygiene.threw', errorFields(e))
    return { skipped: 'error' }
  }
}
