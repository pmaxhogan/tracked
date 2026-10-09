/**
 * mkvid track uploads: a pre-saved track (lib/presave.ts, table `presaves`)
 * watched for `trackUploads.minWatchDays` that still has no YouTube link on
 * 1001tracklists, but has one on a site yt-dlp can download in full
 * (`trackUploads.allowedSources`, in order of preference), is handed to mkvid,
 * which rips it, renders it with the `track` visualizer and uploads it. The
 * Worker then puts the video into the one **Track uploads** playlist, marks the
 * presave `uploaded` and pushes "Track ripped and uploaded".
 *
 * Same pull model as the set queue (lib/mkvid.ts), in its own table
 * (`track_uploads`, migration 0017) and under its own endpoints
 * (routes/mkvid-track.ts, `/mkvid/track/*`, bearer MKVID_TOKEN):
 *
 *   pending ──claim──▶ claimed ──complete──▶ done
 *                        │ fail (retryable) ──▶ pending (not_before = now + retryBackoffHours × attempts)
 *                        │ fail (permanent, or attempts used up) ──▶ failed
 *   pending | claimed ──1001tl got a YouTube link / presave dismissed──▶ superseded
 *   any but done ──owner bans the source URL──▶ banned (the next allowed source is queued)
 *
 * Caps: a claim needs room under `trackUploads.dailyCap` (track claims this
 * quota day) AND under mkvid's per-project caps — each track claim appends an
 * `mkvid_claims` row with `request_id = 'track:<id>'`, so set and track
 * uploads share one per-project count. A failure report refunds that row, like
 * `/mkvid/fail`. A claim not reported on within mkvid's claim TTL is handed
 * out again.
 *
 * Times in `track_uploads` / `track_upload_bans` / `mkvid_claims` are unix
 * SECONDS; `presaves` / `presave_checks` use unix MILLISECONDS.
 */

import type { Env } from '../types'
import { dbOf, parseJson, v } from './db'
import { errorFields, type Logger } from './log'
import { getAppSettings, type AppSettings } from './app-settings'
import { claimTtl, mkvidAccountUsage, quotaDayStart, type MkvidAccount } from './mkvid'
import { cachePlaylistVideoIds, findOrCreatePlaylist, getCachedPlaylistVideoIds } from './playlist-cache'
import { addVideoToPlaylist, isPermanentInsertError, isQuotaError, PlaylistNotFoundError } from './youtube-playlists'
import { sendPushToAll, trackUploadedPayload } from './web-push'
import { markPresaveUploaded } from './presave'

export type TrackUploadStatus = 'pending' | 'claimed' | 'done' | 'failed' | 'banned' | 'superseded'
export const TRACK_UPLOAD_STATUSES: readonly TrackUploadStatus[] = ['pending', 'claimed', 'done', 'failed', 'banned', 'superseded']
export type TrackPlaylistStatus = 'added' | 'duplicate' | 'failed'

/** SUBS KV: `{ playlistId, title }` of the Track uploads playlist. */
export const TRACK_PLAYLIST_KEY = 'trackuploads:playlist'
export const TRACK_PLAYLIST_DESCRIPTION = 'Pre-saved tracks with no YouTube upload of their own, ripped and uploaded by mkvid. Updated automatically.'
/** `mkvid_claims.request_id` of a track claim. */
export const trackClaimId = (id: number) => `track:${id}`

const nowSeconds = () => Math.floor(Date.now() / 1000)
const DAY_MS = 86_400_000

/**
 * The only hosts a source URL may point at, per source name, before it is
 * handed to yt-dlp. A source name not listed here is never eligible, whatever
 * `trackUploads.allowedSources` says.
 */
export const TRACK_SOURCE_HOSTS: Readonly<Record<string, RegExp>> = {
  soundcloud: /(^|\.)soundcloud\.com$/,
  bandcamp: /(^|\.)bandcamp\.com$/,
  hearthis: /(^|\.)hearthis\.at$/,
  mixcloud: /(^|\.)mixcloud\.com$/,
}

/** `url` normalised (`URL.href`) when it is https: on a host allowlisted for `sourceName`, else null. */
export function safeSourceUrl(sourceName: string, url: unknown): string | null {
  const hosts = TRACK_SOURCE_HOSTS[sourceName.toLowerCase()]
  if (!hosts || typeof url !== 'string' || !url) return null
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.username || u.password || !hosts.test(u.hostname.toLowerCase())) return null
  return u.href
}

/** The source name whose allowlist `url` matches (and its normalised form), for a ban without a request. */
export function sourceOfUrl(url: string): { sourceName: string; url: string } | null {
  for (const name of Object.keys(TRACK_SOURCE_HOSTS)) {
    const href = safeSourceUrl(name, url)
    if (href) return { sourceName: name, url: href }
  }
  return null
}

// ─── rows ───────────────────────────────────────────────────────────────────

export type TrackUploadRow = {
  id: number
  presave_id: number
  track_id: string | null
  artist: string | null
  title: string | null
  artwork_url: string | null
  track_url: string | null
  source_name: string
  source_url: string
  expected_duration_seconds: number | null
  status: TrackUploadStatus
  attempts: number
  not_before: number | null
  claimed_at: number | null
  account: string | null
  job_id: string | null
  video_id: string | null
  privacy: string | null
  playlist_item_id: string | null
  playlist_status: TrackPlaylistStatus | null
  error: string | null
  created_at: number
  updated_at: number
  completed_at: number | null
  notified_at: number | null
}

/** What the UI (and the presave page) gets for one request. Times are unix ms. */
export type TrackUploadOut = {
  id: number
  presaveId: number
  trackId: string | null
  artist: string | null
  title: string | null
  artworkUrl: string | null
  trackUrl: string | null
  sourceName: string
  sourceUrl: string
  sourceBanned: boolean
  expectedDurationSeconds: number | null
  status: TrackUploadStatus
  attempts: number
  notBefore: number | null
  claimedAt: number | null
  account: string | null
  jobId: string | null
  videoId: string | null
  youtubeUrl: string | null
  youtubeMusicUrl: string | null
  privacy: string | null
  playlistStatus: TrackPlaylistStatus | null
  error: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
  notifiedAt: number | null
}

const ms = (s: number | null | undefined) => (s === null || s === undefined ? null : Number(s) * 1000)

export function trackUploadOut(r: TrackUploadRow & { source_banned?: number | null }): TrackUploadOut {
  return {
    id: Number(r.id),
    presaveId: Number(r.presave_id),
    trackId: r.track_id,
    artist: r.artist,
    title: r.title,
    artworkUrl: r.artwork_url,
    trackUrl: r.track_url,
    sourceName: r.source_name,
    sourceUrl: r.source_url,
    sourceBanned: !!r.source_banned,
    expectedDurationSeconds: r.expected_duration_seconds,
    status: r.status,
    attempts: Number(r.attempts),
    notBefore: ms(r.not_before),
    claimedAt: ms(r.claimed_at),
    account: r.account,
    jobId: r.job_id,
    videoId: r.video_id,
    youtubeUrl: r.video_id ? `https://www.youtube.com/watch?v=${r.video_id}` : null,
    youtubeMusicUrl: r.video_id ? `https://music.youtube.com/watch?v=${r.video_id}` : null,
    privacy: r.privacy,
    playlistStatus: r.playlist_status,
    error: r.error,
    createdAt: Number(r.created_at) * 1000,
    updatedAt: Number(r.updated_at) * 1000,
    completedAt: ms(r.completed_at),
    notifiedAt: ms(r.notified_at),
  }
}

/** The SELECT list every reader uses: the row plus whether its source URL is banned. */
export const TRACK_UPLOAD_COLUMNS = 'u.*, EXISTS (SELECT 1 FROM track_upload_bans b WHERE b.url = u.source_url) AS source_banned'

export async function getTrackUploadRow(env: Env, id: number): Promise<TrackUploadRow | null> {
  return dbOf(env).prepare('SELECT * FROM track_uploads WHERE id = ?').bind(id).first<TrackUploadRow>()
}

export async function getTrackUpload(env: Env, id: number): Promise<TrackUploadOut | null> {
  const r = await dbOf(env).prepare(`SELECT ${TRACK_UPLOAD_COLUMNS} FROM track_uploads u WHERE u.id = ?`).bind(id).first<TrackUploadRow & { source_banned: number }>()
  return r ? trackUploadOut(r) : null
}

/** The newest request for a presave (live or not), for the presave page. */
export async function getTrackUploadForPresave(env: Env, presaveId: number): Promise<TrackUploadOut | null> {
  const r = await dbOf(env)
    .prepare(`SELECT ${TRACK_UPLOAD_COLUMNS} FROM track_uploads u WHERE u.presave_id = ? ORDER BY u.id DESC LIMIT 1`)
    .bind(presaveId)
    .first<TrackUploadRow & { source_banned: number }>()
  return r ? trackUploadOut(r) : null
}

export async function countTrackUploads(env: Env): Promise<Record<TrackUploadStatus, number>> {
  const res = await dbOf(env).prepare('SELECT status, COUNT(*) AS n FROM track_uploads GROUP BY status').all<{ status: string; n: number }>()
  const out: Record<TrackUploadStatus, number> = { pending: 0, claimed: 0, done: 0, failed: 0, banned: 0, superseded: 0 }
  for (const r of res.results) if (r.status in out) out[r.status as TrackUploadStatus] = Number(r.n)
  return out
}

/** Track claims handed out since the quota day began (refunded ones excluded). */
export async function trackClaimsToday(env: Env): Promise<number> {
  const r = await dbOf(env)
    .prepare("SELECT COUNT(*) AS n FROM mkvid_claims WHERE request_id LIKE 'track:%' AND claimed_at >= ? AND refunded_at IS NULL")
    .bind(quotaDayStart())
    .first<{ n: number }>()
  return Number(r?.n ?? 0)
}

// ─── the presave side ───────────────────────────────────────────────────────

/** The presave columns this module reads (`presaves`, migration 0016; times in ms). */
type PresaveLite = {
  id: number
  track_id: string | null
  track_url: string | null
  artist: string | null
  title: string | null
  artwork_url: string | null
  stage: string
  links: string | null
  link_count: number | null
  link_sources: string | null
  duration_seconds: number | null
  created_at: number
}

/** The link entries 1001tracklists lists for a track (spec "Shared vocabulary": LinkEntry). */
type LinkEntryLite = { source?: string; name?: string; url?: string | null; duration?: number | null }

async function getPresaveLite(env: Env, id: number): Promise<PresaveLite | null> {
  return dbOf(env)
    .prepare('SELECT id, track_id, track_url, artist, title, artwork_url, stage, links, link_count, link_sources, duration_seconds, created_at FROM presaves WHERE id = ?')
    .bind(id)
    .first<PresaveLite>()
}

// ─── queueing ───────────────────────────────────────────────────────────────

export type QueueReason =
  | 'queued'
  | 'disabled'
  | 'not_found'
  | 'stage'
  | 'has_youtube'
  | 'too_new'
  | 'already_live'
  /** A request for this presave is already `done`: the track is on YouTube, never uploaded twice. */
  | 'already_uploaded'
  | 'no_source'
  | 'error'

export type QueueResult = { queued: boolean; reason: QueueReason; uploadId?: number; sourceName?: string; sourceUrl?: string }

/**
 * Called by lib/presave.ts after every check that ends without a YouTube link
 * (and by ban-link to queue the next source). Reads the presave's STORED row —
 * call it after the check's links are written. Queues one `pending` request when:
 * `trackUploads.enabled`; stage `links`; watched ≥ `minWatchDays`; no live
 * (pending / claimed) request for this presave; and an allowed source: walk
 * `allowedSources` in order, take the first link entry whose `name` matches
 * and whose `url` is neither banned nor already failed/banned for this presave.
 * Never throws.
 */
export async function maybeQueueTrackUpload(env: Env, presave: number | { id: number | string }, log?: Logger): Promise<QueueResult> {
  const presaveId = typeof presave === 'number' ? presave : Number(presave.id)
  try {
    const app = (await getAppSettings(env)).trackUploads
    if (!app.enabled) return { queued: false, reason: 'disabled' }
    const p = await getPresaveLite(env, presaveId)
    if (!p) return { queued: false, reason: 'not_found' }
    if (p.stage !== 'links') return { queued: false, reason: 'stage' }
    if (Date.now() - Number(p.created_at) < app.minWatchDays * DAY_MS) return { queued: false, reason: 'too_new' }
    const db = dbOf(env)
    const live = await db.prepare("SELECT id FROM track_uploads WHERE presave_id = ? AND status IN ('pending', 'claimed') LIMIT 1").bind(p.id).first<{ id: number }>()
    if (live) return { queued: false, reason: 'already_live', uploadId: Number(live.id) }
    // Uploaded already (even if the presave's stage was lost to a race): never a second upload.
    const done = await db.prepare("SELECT id FROM track_uploads WHERE presave_id = ? AND status = 'done' LIMIT 1").bind(p.id).first<{ id: number }>()
    if (done) return { queued: false, reason: 'already_uploaded', uploadId: Number(done.id) }
    const links = parseJson<LinkEntryLite[]>(p.links, [])
    if (!Array.isArray(links)) return { queued: false, reason: 'no_source' }
    if (links.some((l) => (l.name ?? '').toLowerCase() === 'youtube' && l.url)) return { queued: false, reason: 'has_youtube' }
    const banned = new Set(
      (await db.prepare('SELECT url FROM track_upload_bans').all<{ url: string }>()).results.map((r) => r.url),
    )
    // A source that already failed (or was banned) for this track is not tried again: the next one is.
    const spent = new Set(
      (await db.prepare("SELECT source_url FROM track_uploads WHERE presave_id = ? AND status IN ('failed', 'banned')").bind(p.id).all<{ source_url: string }>()).results.map((r) => r.source_url),
    )
    // Only an https: URL on the host allowlisted for its source name (TRACK_SOURCE_HOSTS), normalised.
    let pick: { name: string; url: string; duration: number | null | undefined } | null = null
    for (const name of app.allowedSources) {
      for (const l of links) {
        if ((l.name ?? '').toLowerCase() !== name.toLowerCase()) continue
        const href = safeSourceUrl(name, l.url)
        if (!href) {
          if (l.url) log?.warn('track_upload.source_url_rejected', { presaveId: p.id, sourceName: name, url: String(l.url).slice(0, 300) })
          continue
        }
        if (banned.has(href) || spent.has(href)) continue
        pick = { name: name.toLowerCase(), url: href, duration: l.duration }
        break
      }
      if (pick) break
    }
    if (!pick) return { queued: false, reason: 'no_source' }
    const durations = [pick.duration, p.duration_seconds].map((d) => (typeof d === 'number' && d > 0 ? Math.round(d) : null))
    const expected = durations[0] ?? durations[1] ?? null
    const now = nowSeconds()
    let res: D1Result
    try {
      res = await db
        .prepare(
          `INSERT INTO track_uploads (presave_id, track_id, artist, title, artwork_url, track_url, source_name, source_url, expected_duration_seconds, status, attempts, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
        )
        .bind(p.id, v(p.track_id), v(p.artist), v(p.title), v(p.artwork_url), v(p.track_url), pick.name, pick.url, v(expected), now, now)
        .run()
    } catch (e) {
      // The partial unique index (one live request per presave): a concurrent queue won.
      if (/UNIQUE/i.test(String((e as Error)?.message ?? e))) return { queued: false, reason: 'already_live' }
      throw e
    }
    const uploadId = Number(res.meta.last_row_id)
    log?.info('track_upload.queued', { uploadId, presaveId: p.id, trackId: p.track_id, artist: p.artist, title: p.title, sourceName: pick.name, sourceUrl: pick.url, expectedDurationSeconds: expected })
    return { queued: true, reason: 'queued', uploadId, sourceName: pick.name, sourceUrl: pick.url }
  } catch (e) {
    log?.warn('track_upload.queue_threw', { presaveId, ...errorFields(e) })
    return { queued: false, reason: 'error' }
  }
}

/** 1001tracklists got a YouTube link, or the presave was dismissed: live requests → `superseded`. Returns how many. Never throws. */
export async function supersedeTrackUploadsForPresave(env: Env, presaveId: number, why: string, log?: Logger): Promise<number> {
  try {
    const r = await dbOf(env)
      .prepare("UPDATE track_uploads SET status = 'superseded', error = ?, not_before = NULL, updated_at = ? WHERE presave_id = ? AND status IN ('pending', 'claimed')")
      .bind(why.slice(0, 500), nowSeconds(), presaveId)
      .run()
    const n = r.meta.changes ?? 0
    if (n) log?.info('track_upload.superseded', { presaveId, why, n })
    return n
  } catch (e) {
    log?.warn('track_upload.supersede_threw', { presaveId, ...errorFields(e) })
    return 0
  }
}

// ─── claim ──────────────────────────────────────────────────────────────────

/** What `POST /mkvid/track/claim` hands mkvid. */
export type TrackRequest = {
  id: number
  presaveId: number
  artist: string | null
  title: string | null
  artworkUrl: string | null
  trackUrl: string | null
  sourceName: string
  sourceUrl: string
  expectedDurationSeconds: number | null
  minDurationRatio: number
  privacy: 'public' | 'unlisted' | 'private'
  account: MkvidAccount
  attempts: number
}

export type TrackClaimOutcome = 'claimed' | 'empty' | 'capped' | 'paused' | 'not_connected'

const CLAIMABLE_WHERE = "(status = 'pending' AND (not_before IS NULL OR not_before <= ?)) OR (status = 'claimed' AND claimed_at < ?)"

/**
 * Claim the oldest claimable request (pending past its backoff, or claimed
 * longer than mkvid's claim TTL) for the first offered account with room
 * under its per-project cap, while today's track claims are under
 * `trackUploads.dailyCap`. Does not touch the set queue's poll heartbeat.
 */
export async function claimTrackUpload(env: Env, log: Logger, accounts: readonly MkvidAccount[] = ['primary']): Promise<{ request: TrackRequest | null; outcome: TrackClaimOutcome }> {
  const settings = await getAppSettings(env)
  const app = settings.trackUploads
  if (!app.enabled || app.dailyCap <= 0) return { request: null, outcome: 'paused' }
  if (accounts.length === 0) return { request: null, outcome: 'not_connected' }
  const today = await trackClaimsToday(env)
  if (today >= app.dailyCap) {
    log.info('track_upload.claim_capped', { trackClaims: today, cap: app.dailyCap })
    return { request: null, outcome: 'capped' }
  }
  const usage = (await mkvidAccountUsage(env)).filter((u) => accounts.includes(u.account))
  const slot = usage.find((u) => u.used < u.cap)
  if (!slot) {
    log.info('track_upload.claim_capped', { accounts: usage.map((u) => `${u.account} ${u.used}/${u.cap}`), trackClaims: today, cap: app.dailyCap })
    return { request: null, outcome: 'capped' }
  }
  const db = dbOf(env)
  const now = nowSeconds()
  const stale = now - claimTtl(env, settings)
  const seen = new Set<number>()
  for (let round = 0; round < 4; round++) {
    const skip = [...seen]
    const batch = await db
      .prepare(
        `SELECT * FROM track_uploads WHERE (${CLAIMABLE_WHERE})
          ${skip.length ? `AND id NOT IN (${skip.map(() => '?').join(', ')})` : ''}
          ORDER BY created_at ASC, id ASC LIMIT 25`,
      )
      .bind(now, stale, ...skip)
      .all<TrackUploadRow>()
    if (!batch.results.length) return { request: null, outcome: 'empty' }
    for (const row of batch.results) {
      seen.add(Number(row.id))
      const r = await tryClaimTrackRow(env, log, row, { account: slot.account, used: slot.used, cap: slot.cap, now, settings, today })
      if (r) return { request: r, outcome: 'claimed' }
    }
  }
  return { request: null, outcome: 'empty' }
}

async function tryClaimTrackRow(
  env: Env,
  log: Logger,
  row: TrackUploadRow,
  a: { account: MkvidAccount; used: number; cap: number; now: number; settings: AppSettings; today: number },
): Promise<TrackRequest | null> {
  const db = dbOf(env)
  const { account, now } = a
  const app = a.settings.trackUploads
  const p = await getPresaveLite(env, Number(row.presave_id))
  if (!p || p.stage !== 'links') {
    await db
      .prepare("UPDATE track_uploads SET status = 'superseded', error = ?, updated_at = ? WHERE id = ? AND status = ?")
      .bind(p ? `presave is ${p.stage}` : 'presave deleted', now, row.id, row.status)
      .run()
    log.info('track_upload.claim_superseded', { id: row.id, presaveId: row.presave_id, stage: p?.stage ?? null })
    return null
  }
  const banned = await db.prepare('SELECT 1 AS x FROM track_upload_bans WHERE url = ?').bind(row.source_url).first()
  if (banned) {
    await db.prepare("UPDATE track_uploads SET status = 'banned', error = 'source URL banned', updated_at = ? WHERE id = ? AND status = ?").bind(now, row.id, row.status).run()
    return null
  }
  // Checked again on the way out to yt-dlp (a row written before the allowlist, or edited by hand).
  const sourceUrl = safeSourceUrl(row.source_name, row.source_url)
  if (!sourceUrl) {
    await db
      .prepare("UPDATE track_uploads SET status = 'failed', error = 'source URL not allowed (https on the source''s own host only)', updated_at = ? WHERE id = ? AND status = ?")
      .bind(now, row.id, row.status)
      .run()
    log.warn('track_upload.claim_unsafe_source', { id: row.id, sourceName: row.source_name, sourceUrl: row.source_url.slice(0, 300) })
    return null
  }
  if (row.attempts >= app.maxAttempts) {
    await db
      .prepare("UPDATE track_uploads SET status = 'failed', error = COALESCE(error, 'too many attempts'), updated_at = ? WHERE id = ? AND status = ?")
      .bind(now, row.id, row.status)
      .run()
    return null
  }
  const r = await db
    .prepare(
      `UPDATE track_uploads SET status = 'claimed', account = ?, claimed_at = ?, attempts = attempts + 1, job_id = NULL, privacy = ?, updated_at = ?
       WHERE id = ? AND status = ? AND attempts = ?`,
    )
    .bind(account, now, app.privacy, now, row.id, row.status, row.attempts)
    .run()
  // Lost a race with another claimer — pick again.
  if ((r.meta.changes ?? 0) === 0) return null
  // A stale claim handed out again: the earlier claim's mkvid_claims row stops counting
  // (otherwise one request would count twice against the per-project and track caps).
  if (row.status === 'claimed') await refundTrackClaim(env, Number(row.id), now)
  // Shares mkvid's per-project count (lib/mkvid.ts dailyClaimsUsed reads this log).
  await db.prepare('INSERT INTO mkvid_claims (request_id, account, claimed_at, recreate) VALUES (?, ?, ?, 0)').bind(trackClaimId(Number(row.id)), account, now).run()
  log.info('track_upload.claimed', {
    id: row.id,
    presaveId: row.presave_id,
    sourceName: row.source_name,
    sourceUrl: row.source_url,
    attempt: row.attempts + 1,
    account,
    accountClaims: a.used + 1,
    accountCap: a.cap,
    trackClaims: a.today + 1,
    trackCap: app.dailyCap,
  })
  return {
    id: Number(row.id),
    presaveId: Number(row.presave_id),
    artist: row.artist,
    title: row.title,
    artworkUrl: row.artwork_url,
    trackUrl: row.track_url,
    sourceName: row.source_name,
    sourceUrl,
    expectedDurationSeconds: row.expected_duration_seconds,
    minDurationRatio: app.minDurationRatio,
    privacy: app.privacy,
    account,
    attempts: row.attempts + 1,
  }
}

/** `POST /mkvid/track/job`: mkvid names its job; renews the claim (only a request still claimed, for no job or this one). */
export async function attachTrackJob(env: Env, id: number, jobId: string): Promise<boolean> {
  const now = nowSeconds()
  const r = await dbOf(env)
    .prepare(
      `UPDATE track_uploads SET claimed_at = ?, job_id = ?, updated_at = CASE WHEN job_id IS ? THEN updated_at ELSE ? END
       WHERE id = ? AND status = 'claimed' AND (job_id IS NULL OR job_id = ?)`,
    )
    .bind(now, jobId, jobId, now, id, jobId)
    .run()
  return (r.meta.changes ?? 0) > 0
}

// ─── the Track uploads playlist ─────────────────────────────────────────────

type StoredTrackPlaylist = { playlistId: string; title: string }

export async function getStoredTrackPlaylist(env: Env): Promise<StoredTrackPlaylist | null> {
  const s = parseJson<StoredTrackPlaylist | null>(await env.SUBS.get(TRACK_PLAYLIST_KEY), null)
  return s && typeof s.playlistId === 'string' ? s : null
}

/** Find the playlist by its exact title (settings), else create it (public, like the artist playlists); the id is kept in SUBS. */
async function resolveTrackPlaylist(env: Env, title: string, accessToken: string, log: Logger, fresh = false): Promise<{ id: string; justCreated: boolean }> {
  const stored = fresh ? null : await getStoredTrackPlaylist(env)
  if (stored && stored.title === title) return { id: stored.playlistId, justCreated: false }
  const r = await findOrCreatePlaylist({ title, description: TRACK_PLAYLIST_DESCRIPTION, logCtx: { trackUploads: true } }, accessToken, log)
  if (!r) throw new Error(`playlist ${JSON.stringify(title)} could not be resolved`)
  await env.SUBS.put(TRACK_PLAYLIST_KEY, JSON.stringify({ playlistId: r.id, title } satisfies StoredTrackPlaylist))
  if (r.justCreated) await cachePlaylistVideoIds(env, r.id, new Set())
  return r
}

/** Insert `videoId` into the Track uploads playlist unless it is there; a playlist deleted on YouTube is found again by title or recreated. */
export async function addToTrackPlaylist(env: Env, videoId: string, accessToken: string, log: Logger): Promise<{ playlistId: string; status: 'added' | 'duplicate' }> {
  const title = (await getAppSettings(env)).trackUploads.playlistTitle
  let pl = await resolveTrackPlaylist(env, title, accessToken, log)
  let existing: Set<string>
  try {
    existing = pl.justCreated ? new Set() : await getCachedPlaylistVideoIds(env, pl.id, accessToken, log)
  } catch (e) {
    if (!(e instanceof PlaylistNotFoundError)) throw e
    log.warn('track_upload.playlist_stale', { stalePlaylistId: pl.id })
    pl = await resolveTrackPlaylist(env, title, accessToken, log, true)
    existing = pl.justCreated ? new Set() : await getCachedPlaylistVideoIds(env, pl.id, accessToken, log)
  }
  if (existing.has(videoId)) return { playlistId: pl.id, status: 'duplicate' }
  try {
    await addVideoToPlaylist(pl.id, videoId, accessToken)
  } catch (e) {
    if (!(e instanceof PlaylistNotFoundError)) throw e
    log.warn('track_upload.playlist_stale_insert', { stalePlaylistId: pl.id })
    pl = await resolveTrackPlaylist(env, title, accessToken, log, true)
    existing = pl.justCreated ? new Set() : await getCachedPlaylistVideoIds(env, pl.id, accessToken, log)
    if (existing.has(videoId)) return { playlistId: pl.id, status: 'duplicate' }
    await addVideoToPlaylist(pl.id, videoId, accessToken)
  }
  existing.add(videoId)
  await cachePlaylistVideoIds(env, pl.id, existing)
  return { playlistId: pl.id, status: 'added' }
}

/** Insert with the failure classified: quota / permanent / transient errors become `failed` (the request is still done; Retry in the UI re-runs the insert). */
async function insertSafely(env: Env, uploadId: number, videoId: string, accessToken: string, log: Logger): Promise<{ playlistId: string | null; status: TrackPlaylistStatus; error: string | null }> {
  try {
    const r = await addToTrackPlaylist(env, videoId, accessToken, log)
    return { playlistId: r.playlistId, status: r.status, error: null }
  } catch (e) {
    const kind = isQuotaError(e) ? 'quota' : isPermanentInsertError(e) ? 'permanent' : 'transient'
    log.warn('track_upload.playlist_insert_failed', { id: uploadId, videoId, kind, ...errorFields(e) })
    return { playlistId: (await getStoredTrackPlaylist(env))?.playlistId ?? null, status: 'failed', error: `playlist insert failed (${kind}): ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}` }
  }
}

// ─── complete / fail ────────────────────────────────────────────────────────

export type TrackCompleteInput = { id: number; videoId: string; videoUrl?: string | null; privacy?: string | null; jobId?: string | null }

export type TrackCompleteResult =
  | { status: 'done'; videoId: string; presaveId: number; playlistId: string | null; playlistStatus: TrackPlaylistStatus; notified: boolean }
  /** 1001tracklists got a YouTube link (or the presave was dismissed / deleted) meanwhile: the video is recorded, nothing else. */
  | { status: 'superseded'; videoId: string; reason: string }
  /** The owner banned the source while mkvid worked: the video is recorded, kept out of the playlist. */
  | { status: 'banned'; videoId: string }
  | { status: 'not_found' }
  | { status: 'invalid_state'; current: TrackUploadStatus }

/**
 * mkvid uploaded a track. Inserts it into the Track uploads playlist, marks the
 * request `done`, the presave `uploaded` (a `presave_checks` row, trigger
 * `upload`) and pushes `track_uploaded` when `notifyUploaded`. A playlist
 * insert that fails (quota, …) leaves `playlist_status = 'failed'` and the
 * rest still happens: the video exists, so mkvid must not upload it again.
 */
export async function completeTrackUpload(env: Env, input: TrackCompleteInput, accessToken: string, log: Logger, fetchImpl: typeof fetch = fetch): Promise<TrackCompleteResult> {
  const db = dbOf(env)
  const row = await getTrackUploadRow(env, input.id)
  if (!row) return { status: 'not_found' }
  if (row.status === 'done' || row.status === 'superseded') return { status: 'invalid_state', current: row.status }
  // A job whose claim lapsed and was handed to another job: its report is not this request's.
  if (jobMismatch(row, input.jobId)) {
    log.warn('track_upload.complete_wrong_job', { id: row.id, jobId: input.jobId, currentJobId: row.job_id, videoId: input.videoId })
    return { status: 'invalid_state', current: row.status }
  }
  const now = nowSeconds()
  if (row.status === 'banned') {
    await db
      .prepare('UPDATE track_uploads SET video_id = ?, privacy = COALESCE(?, privacy), job_id = COALESCE(?, job_id), completed_at = ?, updated_at = ? WHERE id = ?')
      .bind(input.videoId, v(input.privacy), v(input.jobId), now, now, row.id)
      .run()
    log.warn('track_upload.complete_banned', { id: row.id, videoId: input.videoId, sourceUrl: row.source_url })
    return { status: 'banned', videoId: input.videoId }
  }
  const p = await getPresaveLite(env, Number(row.presave_id))
  if (!p || p.stage !== 'links') {
    const reason = !p ? 'presave deleted' : p.stage === 'found' ? '1001tracklists got a YouTube link meanwhile' : `presave is ${p.stage}`
    await db
      .prepare("UPDATE track_uploads SET status = 'superseded', video_id = ?, privacy = COALESCE(?, privacy), job_id = COALESCE(?, job_id), error = ?, completed_at = ?, updated_at = ? WHERE id = ?")
      .bind(input.videoId, v(input.privacy), v(input.jobId), reason, now, now, row.id)
      .run()
    log.info('track_upload.complete_superseded', { id: row.id, presaveId: row.presave_id, videoId: input.videoId, reason })
    return { status: 'superseded', videoId: input.videoId, reason }
  }

  const app = (await getAppSettings(env)).trackUploads
  const pl = await insertSafely(env, Number(row.id), input.videoId, accessToken, log)
  await db
    .prepare(
      `UPDATE track_uploads SET status = 'done', video_id = ?, privacy = COALESCE(?, privacy), job_id = COALESCE(?, job_id), playlist_status = ?, error = ?, not_before = NULL, completed_at = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(input.videoId, v(input.privacy), v(input.jobId), pl.status, pl.error, now, now, row.id)
    .run()
  await markPresaveUploaded(env, p.id, input.videoId, { uploadId: Number(row.id), sourceName: row.source_name, sourceUrl: row.source_url, playlistId: pl.playlistId, playlistStatus: pl.status, privacy: input.privacy ?? null })

  let notified = false
  if (app.notifyUploaded) {
    try {
      const sent = await sendPushToAll(
        env,
        trackUploadedPayload({ uploadId: Number(row.id), artist: row.artist, title: row.title, sourceName: row.source_name, videoId: input.videoId, playlistTitle: app.playlistTitle }),
        log,
        fetchImpl,
      )
      notified = sent.sent > 0
      if (notified) await db.prepare('UPDATE track_uploads SET notified_at = ? WHERE id = ?').bind(now, row.id).run()
    } catch (e) {
      log.warn('track_upload.push_threw', { id: row.id, ...errorFields(e) })
    }
  }
  log.info('track_upload.completed', { id: row.id, presaveId: row.presave_id, videoId: input.videoId, playlistId: pl.playlistId, playlistStatus: pl.status, sourceName: row.source_name, privacy: input.privacy ?? null, notified })
  return { status: 'done', videoId: input.videoId, presaveId: Number(row.presave_id), playlistId: pl.playlistId, playlistStatus: pl.status, notified }
}

export type TrackFailInput = { id: number; error: string; permanent?: boolean; jobId?: string | null }
export type TrackFailResult = { status: TrackUploadStatus; attempts: number; notBefore: number | null }
/** The report names another job than the one the request is claimed by now (the route answers 409). */
export type TrackFailWrongJob = { status: 'invalid_state'; current: TrackUploadStatus }

/** The row is claimed by a named job and the report names a different one. */
function jobMismatch(row: Pick<TrackUploadRow, 'job_id'>, jobId: string | null | undefined): boolean {
  return !!jobId && !!row.job_id && row.job_id !== jobId
}

/** mkvid gave a claim back (nothing uploaded): its latest `mkvid_claims` row stops counting. */
async function refundTrackClaim(env: Env, id: number, now: number): Promise<void> {
  await dbOf(env)
    .prepare('UPDATE mkvid_claims SET refunded_at = ? WHERE id = (SELECT MAX(id) FROM mkvid_claims WHERE request_id = ? AND refunded_at IS NULL)')
    .bind(now, trackClaimId(id))
    .run()
}

/**
 * mkvid could not deliver. Refunds the claim; a permanent failure (or the
 * last attempt) parks the request as `failed`, anything else goes back to
 * `pending` after `retryBackoffHours × attempts`. A report for a request that
 * is no longer claimed (retried, finished, superseded) changes nothing but the
 * refund of a banned one. Null = unknown id.
 */
export async function failTrackUpload(env: Env, input: TrackFailInput, log: Logger): Promise<TrackFailResult | TrackFailWrongJob | null> {
  const row = await getTrackUploadRow(env, input.id)
  if (!row) return null
  const now = nowSeconds()
  if (row.status === 'banned') {
    await refundTrackClaim(env, row.id, now)
    return { status: 'banned', attempts: row.attempts, notBefore: null }
  }
  if (row.status === 'claimed' && jobMismatch(row, input.jobId)) {
    log.warn('track_upload.fail_wrong_job', { id: row.id, jobId: input.jobId, currentJobId: row.job_id })
    return { status: 'invalid_state', current: row.status }
  }
  if (row.status !== 'claimed') {
    return { status: row.status, attempts: row.attempts, notBefore: ms(row.not_before) }
  }
  await refundTrackClaim(env, row.id, now)
  const app = (await getAppSettings(env)).trackUploads
  const exhausted = row.attempts >= app.maxAttempts
  const status: TrackUploadStatus = input.permanent || exhausted ? 'failed' : 'pending'
  const notBefore = status === 'pending' ? now + Math.round(app.retryBackoffHours * 3600) * Math.max(1, row.attempts) : null
  await dbOf(env)
    .prepare('UPDATE track_uploads SET status = ?, not_before = ?, claimed_at = NULL, error = ?, job_id = COALESCE(?, job_id), updated_at = ? WHERE id = ?')
    .bind(status, notBefore, input.error.slice(0, 500), v(input.jobId), now, row.id)
    .run()
  log.warn('track_upload.failed', { id: row.id, presaveId: row.presave_id, sourceUrl: row.source_url, attempts: row.attempts, status, permanent: !!input.permanent, error: input.error.slice(0, 200) })
  // A source that failed for good: the next allowed source of the same track gets its turn.
  if (status === 'failed') {
    const next = await maybeQueueTrackUpload(env, Number(row.presave_id), log)
    if (next.queued) log.info('track_upload.next_source_queued', { id: row.id, nextId: next.uploadId, sourceName: next.sourceName })
  }
  return { status, attempts: row.attempts, notBefore: ms(notBefore) }
}

// ─── owner actions (UI) ─────────────────────────────────────────────────────

export type RetryResult =
  | { ok: true; upload: TrackUploadOut; playlistRetried?: boolean }
  | { ok: false; error: 'not_found' | 'invalid_state' | 'live_request_exists' | 'source_banned' | 'youtube_not_connected'; message: string }

/**
 * Give a failed / superseded / banned / stuck request a fresh start (pending,
 * attempts 0). A `done` request whose playlist insert failed instead retries
 * just the insert (`accessToken` needed).
 */
export async function retryTrackUpload(env: Env, id: number, log: Logger, accessToken?: () => Promise<string | null>): Promise<RetryResult> {
  const db = dbOf(env)
  const row = await getTrackUploadRow(env, id)
  if (!row) return { ok: false, error: 'not_found', message: `no track upload ${id}` }
  const now = nowSeconds()
  if (row.status === 'done') {
    if (row.playlist_status !== 'failed' || !row.video_id) return { ok: false, error: 'invalid_state', message: 'already uploaded and in the playlist' }
    const tok = accessToken ? await accessToken() : null
    if (!tok) return { ok: false, error: 'youtube_not_connected', message: 'connect a YouTube account first' }
    const pl = await insertSafely(env, row.id, row.video_id, tok, log)
    await db.prepare('UPDATE track_uploads SET playlist_status = ?, error = ?, updated_at = ? WHERE id = ?').bind(pl.status, pl.error, now, row.id).run()
    return { ok: true, upload: (await getTrackUpload(env, id))!, playlistRetried: true }
  }
  if (row.status === 'pending') return { ok: false, error: 'invalid_state', message: 'already waiting' }
  if (await db.prepare('SELECT 1 AS x FROM track_upload_bans WHERE url = ?').bind(row.source_url).first()) {
    return { ok: false, error: 'source_banned', message: 'its source URL is banned: unban it first' }
  }
  try {
    await db
      .prepare("UPDATE track_uploads SET status = 'pending', attempts = 0, not_before = NULL, claimed_at = NULL, error = NULL, updated_at = ? WHERE id = ?")
      .bind(now, row.id)
      .run()
  } catch (e) {
    if (/UNIQUE/i.test(String((e as Error)?.message ?? e))) return { ok: false, error: 'live_request_exists', message: 'another request for this track is already waiting or running' }
    throw e
  }
  log.info('track_upload.retried', { id: row.id, from: row.status })
  return { ok: true, upload: (await getTrackUpload(env, id))! }
}

export type BanResult = { banned: true; url: string; affected: number[]; requeued: (QueueResult & { presaveId: number })[] }

/**
 * Ban a source URL for every presave. Requests using it that are not done
 * become `banned` (a claimed one's claim is refunded: whatever mkvid delivers
 * for it is kept out of the playlist), and each affected presave gets its next
 * allowed source queued.
 */
export async function banTrackSourceUrl(
  env: Env,
  url: string,
  opts: { reason?: string | null; uploadId?: number | null; sourceName?: string | null; presaveId?: number | null },
  log: Logger,
): Promise<BanResult> {
  const db = dbOf(env)
  const now = nowSeconds()
  const sample = await db.prepare('SELECT id, presave_id, source_name FROM track_uploads WHERE source_url = ? ORDER BY id DESC LIMIT 1').bind(url).first<{ id: number; presave_id: number; source_name: string }>()
  await db
    .prepare(
      `INSERT INTO track_upload_bans (url, source_name, reason, upload_id, presave_id, banned_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET reason = COALESCE(excluded.reason, reason)`,
    )
    .bind(url, v(opts.sourceName ?? sample?.source_name ?? null), v(opts.reason ?? null), v(opts.uploadId ?? sample?.id ?? null), v(opts.presaveId ?? sample?.presave_id ?? null), now)
    .run()
  const hit = (await db.prepare("SELECT id, presave_id, status FROM track_uploads WHERE source_url = ? AND status IN ('pending', 'claimed', 'failed', 'superseded')").bind(url).all<{ id: number; presave_id: number; status: TrackUploadStatus }>()).results
  const affected: number[] = []
  const presaves = new Set<number>()
  for (const h of hit) {
    const r = await db
      .prepare("UPDATE track_uploads SET status = 'banned', error = ?, not_before = NULL, updated_at = ? WHERE id = ? AND status = ?")
      .bind(`source banned${opts.reason ? `: ${opts.reason.slice(0, 300)}` : ''}`, now, h.id, h.status)
      .run()
    if ((r.meta.changes ?? 0) === 0) continue
    if (h.status === 'claimed') await refundTrackClaim(env, h.id, now)
    affected.push(Number(h.id))
    presaves.add(Number(h.presave_id))
  }
  const requeued: BanResult['requeued'] = []
  for (const pid of presaves) requeued.push({ presaveId: pid, ...(await maybeQueueTrackUpload(env, pid, log)) })
  log.info('track_upload.source_banned', { url, reason: opts.reason ?? null, affected, requeued: requeued.map((q) => q.reason) })
  return { banned: true, url, affected, requeued }
}

/** Ban a request's source URL (and so the request), then queue the presave's next allowed source. */
export async function banTrackUploadLink(env: Env, id: number, reason: string | null, log: Logger): Promise<(BanResult & { upload: TrackUploadOut; next: QueueResult }) | null> {
  const row = await getTrackUploadRow(env, id)
  if (!row) return null
  const r = await banTrackSourceUrl(env, row.source_url, { reason, uploadId: row.id, sourceName: row.source_name, presaveId: row.presave_id }, log)
  // When this request was not live (done), nothing was requeued above for its presave: maybeQueue decides.
  const next = r.requeued.find((q) => q.presaveId === Number(row.presave_id)) ?? (await maybeQueueTrackUpload(env, Number(row.presave_id), log))
  return { ...r, upload: (await getTrackUpload(env, id))!, next }
}

export async function unbanTrackSourceUrl(env: Env, url: string, log: Logger): Promise<boolean> {
  const r = await dbOf(env).prepare('DELETE FROM track_upload_bans WHERE url = ?').bind(url).run()
  const ok = (r.meta.changes ?? 0) > 0
  if (ok) log.info('track_upload.source_unbanned', { url })
  return ok
}
