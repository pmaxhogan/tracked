/**
 * The mkvid bridge: sets that have no YouTube recording on 1001tracklists but
 * do have a SoundCloud / hearthis.at one get rendered to a waveform video and
 * uploaded (unlisted) by mkvid, the Node service on the NAS, and the resulting
 * video is added to the artist + combined playlists like any other.
 *
 * The Worker cannot reach the NAS (mkvid sits behind Cloudflare Access on a
 * cloudflared tunnel), so the flow is **pull**: the sync queues a row in
 * `mkvid_requests`, mkvid polls `POST /mkvid/claim` whenever its single
 * render slot is free, does the work, and reports back with `/mkvid/complete`
 * or `/mkvid/fail`. Everything here is the queue's lifecycle; the sync hook
 * that decides *when* to queue lives in lib/sync.ts (`maybeQueueForMkvid`),
 * the HTTP surface in routes/mkvid.ts.
 *
 * Lifecycle of a request:
 *   pending ──claim──▶ claimed ──complete──▶ done
 *                        │ fail (retryable)  ──▶ pending (after `not_before`, up to MAX_ATTEMPTS)
 *                        │ fail (permanent)  ──▶ failed
 *   any non-terminal ──the set gains a real YouTube video──▶ superseded
 *
 * "Complete recording" is checked on the mkvid side by comparing the source's
 * duration against `last_cue_seconds` (the tracklist's last cue): a SoundCloud
 * upload that stops before the last track started is a clip, not the set, and
 * is failed permanently as `incomplete_recording`.
 */

import type { Env, ParsedTrack } from '../types'
import { dbOf, parseJson, v } from './db'
import { errorFields, type Logger } from './log'
import { flushPlaylistAdditions, type PlaylistAdditionRecord } from './playlist-audit'
import { addToCombined, flushCombined, openCombinedPlaylist, type CombinedAdditionStatus } from './combined-playlist'
import { cachePlaylistVideoIds, findOrCreatePlaylist, getCachedPlaylistVideoIds } from './playlist-cache'
import { addVideoToPlaylist, PlaylistNotFoundError } from './youtube-playlists'
import { getTracklistRow, setTracklistVideo } from './sync-store'

export type MkvidSourceKind = 'soundcloud' | 'hearthis'
export type MkvidSource = { kind: MkvidSourceKind; url: string }
export type MkvidStatus = 'pending' | 'claimed' | 'done' | 'failed' | 'superseded'

export const MKVID_MAX_ATTEMPTS = 3
export const DEFAULT_CLAIM_TTL_SECONDS = 3 * 60 * 60
/** A retryable failure waits this long × attempts before it can be claimed again. */
const RETRY_BACKOFF_SECONDS = 6 * 60 * 60

const nowSeconds = () => Math.floor(Date.now() / 1000)

// ─── page parsing ───────────────────────────────────────────────────────────

const SOUNDCLOUD_RE = /api\.soundcloud\.com\/tracks\/(\d+)/
// hearthis.at players: 1001tl embeds an iframe whose src is the hearthis embed
// URL — `hearthis.at/embed/<id>/…` or `app.hearthis.at/embed/<id>/…` — and
// the set page may also link the plain track page `hearthis.at/<artist>/<slug>/`.
const HEARTHIS_EMBED_RE = /https?:\/\/(?:app\.|www\.)?hearthis\.at\/embed\/(\d+)\b/i
const HEARTHIS_PAGE_RE = /https?:\/\/(?:www\.)?hearthis\.at\/([a-z0-9][a-z0-9_-]*)\/([a-z0-9][a-z0-9_.-]*)\/?(?=["'\s<>?#]|$)/gi
// First path segments on hearthis.at that are not artist names.
const HEARTHIS_RESERVED = new Set([
  'embed', 'user', 'users', 'api', 'api-v2', 'search', 'tag', 'tags', 'genre', 'genres', 'categories', 'category',
  'feed', 'static', 's', 'set', 'sets', 'playlist', 'playlists', 'login', 'signup', 'register', 'pro', 'premium',
  'about', 'contact', 'imprint', 'privacy', 'terms', 'blog', 'help', 'faq', 'app', 'apps', 'img', 'images', 'css', 'js',
])

/**
 * The set's own audio source on a 1001tracklists set page, in the order the
 * site ranks them (SoundCloud first). Returns what mkvid should hand to
 * yt-dlp: the SoundCloud API track URL (yt-dlp resolves it without cookies),
 * or the hearthis embed URL (mkvid turns that into the track page yt-dlp
 * accepts) / track page.
 */
export function extractSetAudioSource(html: string): MkvidSource | null {
  const sc = html.match(SOUNDCLOUD_RE)
  if (sc) return { kind: 'soundcloud', url: `https://api.soundcloud.com/tracks/${sc[1]}` }
  const embed = html.match(HEARTHIS_EMBED_RE)
  if (embed) return { kind: 'hearthis', url: `https://hearthis.at/embed/${embed[1]}/` }
  HEARTHIS_PAGE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = HEARTHIS_PAGE_RE.exec(html))) {
    const artist = m[1]!.toLowerCase()
    if (HEARTHIS_RESERVED.has(artist)) continue
    return { kind: 'hearthis', url: `https://hearthis.at/${m[1]}/${m[2]}/` }
  }
  return null
}

/** The set page's `<title>`, entity-decoded, minus any site suffix. */
export function extractSetTitle(html: string): string | null {
  const m = html.match(/<title>([^<]{1,300})<\/title>/i)
  if (!m) return null
  const t = decodeEntities(m[1]!)
    .replace(/\s+/g, ' ')
    .replace(/\s*[|·⋅-]\s*1001\s*Tracklists\s*$/i, '')
    .trim()
  return t && !/^1001Tracklists\b/i.test(t) ? t : null
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&sdot;/g, '⋅')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
}

/** Largest cue on the tracklist (seconds), or null when nothing is cued. */
export function lastCueSeconds(tracks: ReadonlyArray<Pick<ParsedTrack, 'startSeconds'>>): number | null {
  let max: number | null = null
  for (const t of tracks) {
    if (t.startSeconds !== null && (max === null || t.startSeconds > max)) max = t.startSeconds
  }
  return max
}

// ─── queue rows ─────────────────────────────────────────────────────────────

export type MkvidRequest = {
  id: string
  slug: string
  setUrl: string
  artistName: string | null
  setTitle: string | null
  source: MkvidSourceKind
  sourceUrl: string
  lastCueSeconds: number | null
  trackCount: number | null
  idedCount: number | null
  status: MkvidStatus
  attempts: number
  notBefore: number | null
  claimedAt: number | null
  jobId: string | null
  videoId: string | null
  videoUrl: string | null
  privacy: string | null
  error: string | null
  createdAt: number
  updatedAt: number
}

type Row = {
  id: string
  slug: string
  set_url: string
  artist_name: string | null
  set_title: string | null
  source: string
  source_url: string
  last_cue_seconds: number | null
  track_count: number | null
  ided_count: number | null
  status: string
  attempts: number
  not_before: number | null
  claimed_at: number | null
  job_id: string | null
  video_id: string | null
  video_url: string | null
  privacy: string | null
  error: string | null
  created_at: number
  updated_at: number
}

function rowToRequest(r: Row): MkvidRequest {
  return {
    id: r.id,
    slug: r.slug,
    setUrl: r.set_url,
    artistName: r.artist_name,
    setTitle: r.set_title,
    source: r.source as MkvidSourceKind,
    sourceUrl: r.source_url,
    lastCueSeconds: r.last_cue_seconds,
    trackCount: r.track_count,
    idedCount: r.ided_count,
    status: r.status as MkvidStatus,
    attempts: Number(r.attempts),
    notBefore: r.not_before,
    claimedAt: r.claimed_at,
    jobId: r.job_id,
    videoId: r.video_id,
    videoUrl: r.video_url,
    privacy: r.privacy,
    error: r.error,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  }
}

export type EnqueueInput = {
  slug: string
  setUrl: string
  artistName: string | null
  setTitle: string | null
  source: MkvidSource
  lastCueSeconds: number | null
  trackCount: number | null
  idedCount: number | null
}

/**
 * Queue a set, unless it already has a request (any status — a `done` or
 * `failed` request is final for that set until someone retries it from the
 * panel). Returns whether a row was created.
 */
export async function enqueueMkvidRequest(env: Env, input: EnqueueInput): Promise<'queued' | 'exists'> {
  const now = nowSeconds()
  const r = await dbOf(env)
    .prepare(
      `INSERT OR IGNORE INTO mkvid_requests
         (id, slug, set_url, artist_name, set_title, source, source_url, last_cue_seconds, track_count, ided_count,
          status, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      input.slug,
      input.setUrl,
      v(input.artistName),
      v(input.setTitle),
      input.source.kind,
      input.source.url,
      v(input.lastCueSeconds),
      v(input.trackCount),
      v(input.idedCount),
      now,
      now,
    )
    .run()
  return (r.meta.changes ?? 0) > 0 ? 'queued' : 'exists'
}

export async function getMkvidRequest(env: Env, id: string): Promise<MkvidRequest | null> {
  const row = await dbOf(env).prepare('SELECT * FROM mkvid_requests WHERE id = ?').bind(id).first<Row>()
  return row ? rowToRequest(row) : null
}

export async function getMkvidRequestForSet(env: Env, setUrl: string): Promise<MkvidRequest | null> {
  const row = await dbOf(env).prepare('SELECT * FROM mkvid_requests WHERE set_url = ?').bind(setUrl).first<Row>()
  return row ? rowToRequest(row) : null
}

/** Newest first, for the admin panel. */
export async function listMkvidRequests(env: Env, limit = 100): Promise<MkvidRequest[]> {
  const res = await dbOf(env)
    .prepare('SELECT * FROM mkvid_requests ORDER BY updated_at DESC, created_at DESC LIMIT ?')
    .bind(Math.min(Math.max(limit, 1), 500))
    .all<Row>()
  return res.results.map(rowToRequest)
}

export async function countMkvidRequests(env: Env): Promise<Record<MkvidStatus, number>> {
  const res = await dbOf(env).prepare('SELECT status, COUNT(*) AS n FROM mkvid_requests GROUP BY status').all<{ status: string; n: number }>()
  const out: Record<MkvidStatus, number> = { pending: 0, claimed: 0, done: 0, failed: 0, superseded: 0 }
  for (const r of res.results) if (r.status in out) out[r.status as MkvidStatus] = Number(r.n)
  return out
}

function claimTtl(env: Env): number {
  const n = Number(env.MKVID_CLAIM_TTL_SECONDS)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CLAIM_TTL_SECONDS
}

/**
 * Hand the oldest claimable request to mkvid: `pending` past its backoff, or
 * `claimed` for longer than the claim TTL (mkvid died mid-job). A request
 * whose set has meanwhile gained a video on 1001tracklists is marked
 * `superseded` and skipped. Returns null when there is nothing to do.
 */
export async function claimMkvidRequest(env: Env, log: Logger): Promise<MkvidRequest | null> {
  const db = dbOf(env)
  const now = nowSeconds()
  const stale = now - claimTtl(env)
  for (let i = 0; i < 20; i++) {
    const row = await db
      .prepare(
        `SELECT * FROM mkvid_requests
         WHERE (status = 'pending' AND (not_before IS NULL OR not_before <= ?))
            OR (status = 'claimed' AND claimed_at IS NOT NULL AND claimed_at < ?)
         ORDER BY created_at ASC LIMIT 1`,
      )
      .bind(now, stale)
      .first<Row>()
    if (!row) return null
    const tl = await getTracklistRow(env, row.slug, row.set_url)
    if (tl?.video_id) {
      await db
        .prepare("UPDATE mkvid_requests SET status = 'superseded', error = ?, updated_at = ? WHERE id = ?")
        .bind(`set already resolves to ${tl.video_id} (${tl.video_source ?? '1001tl'})`, now, row.id)
        .run()
      log.info('mkvid.claim_superseded', { id: row.id, setUrl: row.set_url, videoId: tl.video_id })
      continue
    }
    if (row.attempts >= MKVID_MAX_ATTEMPTS) {
      await db
        .prepare("UPDATE mkvid_requests SET status = 'failed', error = COALESCE(error, 'too many attempts'), updated_at = ? WHERE id = ?")
        .bind(now, row.id)
        .run()
      continue
    }
    const r = await db
      .prepare(
        `UPDATE mkvid_requests SET status = 'claimed', claimed_at = ?, attempts = attempts + 1, job_id = NULL, updated_at = ?
         WHERE id = ? AND status = ? AND attempts = ?`,
      )
      .bind(now, now, row.id, row.status, row.attempts)
      .run()
    // Lost a race with another claimer (two mkvid instances) — pick again.
    if ((r.meta.changes ?? 0) === 0) continue
    const claimed = await getMkvidRequest(env, row.id)
    log.info('mkvid.claimed', { id: row.id, slug: row.slug, setUrl: row.set_url, source: row.source, attempt: (claimed?.attempts ?? 0) })
    return claimed
  }
  return null
}

/** mkvid tells us which of its jobs is handling a claimed request (purely informational). */
export async function attachMkvidJob(env: Env, id: string, jobId: string): Promise<void> {
  await dbOf(env).prepare('UPDATE mkvid_requests SET job_id = ?, updated_at = ? WHERE id = ?').bind(jobId, nowSeconds(), id).run()
}

export type CompleteInput = {
  id: string
  videoId: string
  videoUrl?: string | null
  privacy?: string | null
  jobId?: string | null
}

export type CompleteResult =
  | { status: 'done'; videoId: string; playlistId: string; playlistStatus: 'added' | 'duplicate'; combinedStatus: CombinedAdditionStatus }
  | { status: 'superseded'; videoId: string; existingVideoId: string }
  | { status: 'not_found' }
  | { status: 'invalid_state'; current: MkvidStatus }

/**
 * mkvid delivered a video: put it in the artist playlist and the combined
 * playlist, record it on the tracklist row as an mkvid video (so the 5-day
 * recheck keeps it, and swaps it out if 1001tracklists ever gets a real
 * recording), write an `added` audit row, and mark the request done.
 *
 * If the set gained a real recording while mkvid was rendering, the upload is
 * not added anywhere — the request becomes `superseded` (the video stays on
 * the channel; the panel shows it).
 */
export async function completeMkvidRequest(env: Env, input: CompleteInput, accessToken: string, log: Logger): Promise<CompleteResult> {
  const db = dbOf(env)
  const req = await getMkvidRequest(env, input.id)
  if (!req) return { status: 'not_found' }
  if (req.status === 'done' || req.status === 'superseded') return { status: 'invalid_state', current: req.status }
  const now = nowSeconds()

  const tl = await getTracklistRow(env, req.slug, req.setUrl)
  if (tl?.video_id && tl.video_id !== input.videoId) {
    await db
      .prepare("UPDATE mkvid_requests SET status = 'superseded', video_id = ?, video_url = ?, privacy = ?, job_id = COALESCE(?, job_id), error = ?, updated_at = ? WHERE id = ?")
      .bind(input.videoId, v(input.videoUrl), v(input.privacy), v(input.jobId), `set gained ${tl.video_id} before the upload finished`, now, req.id)
      .run()
    log.info('mkvid.complete_superseded', { id: req.id, setUrl: req.setUrl, uploaded: input.videoId, existing: tl.video_id })
    return { status: 'superseded', videoId: input.videoId, existingVideoId: tl.video_id }
  }

  // Artist playlist: reuse the sync's, or resolve/create it the same way the sync would.
  const artistName = req.artistName ?? req.slug
  const playlistTitle = `${artistName} (1001tklists)`
  const syncRow = await db.prepare('SELECT playlist_id FROM sub_sync WHERE slug = ?').bind(req.slug).first<{ playlist_id: string | null }>()
  let playlistId = syncRow?.playlist_id ?? null
  let justCreated = false
  const resolvePlaylist = async () => {
    const r = await findOrCreatePlaylist(
      { title: playlistTitle, description: `Every set ${artistName} has a YouTube recording for on 1001tracklists.`, logCtx: { slug: req.slug, mkvid: true } },
      accessToken,
      log,
    )
    if (!r) throw new Error(`playlist ${JSON.stringify(playlistTitle)} could not be resolved`)
    playlistId = r.id
    justCreated = r.justCreated
    await db
      .prepare('INSERT INTO sub_sync (slug, playlist_id, artist_name) VALUES (?, ?, ?) ON CONFLICT(slug) DO UPDATE SET playlist_id = excluded.playlist_id')
      .bind(req.slug, r.id, v(req.artistName))
      .run()
  }
  if (!playlistId) await resolvePlaylist()

  let existing: Set<string>
  if (justCreated) existing = new Set()
  else {
    try {
      existing = await getCachedPlaylistVideoIds(env, playlistId!, accessToken, log)
    } catch (e) {
      if (!(e instanceof PlaylistNotFoundError)) throw e
      await resolvePlaylist()
      existing = justCreated ? new Set() : await getCachedPlaylistVideoIds(env, playlistId!, accessToken, log)
    }
  }
  let playlistStatus: 'added' | 'duplicate' = 'duplicate'
  if (!existing.has(input.videoId)) {
    await addVideoToPlaylist(playlistId!, input.videoId, accessToken)
    existing.add(input.videoId)
    await cachePlaylistVideoIds(env, playlistId!, existing)
    playlistStatus = 'added'
  }

  // Combined playlist mirror — best-effort, like the sync's.
  let combinedStatus: CombinedAdditionStatus = 'unavailable'
  try {
    const handle = await openCombinedPlaylist(env, accessToken, log)
    if (handle) {
      combinedStatus = await addToCombined(env, handle, input.videoId, accessToken, log)
      await flushCombined(env, handle, log)
    }
  } catch (e) {
    combinedStatus = 'failed'
    log.warn('mkvid.combined_add_failed', { id: req.id, videoId: input.videoId, ...errorFields(e) })
  }

  await setTracklistVideo(env, req.slug, req.setUrl, { videoId: input.videoId, source: 'mkvid', checkedAt: now })
  await db
    .prepare("UPDATE mkvid_requests SET status = 'done', video_id = ?, video_url = ?, privacy = ?, job_id = COALESCE(?, job_id), error = NULL, updated_at = ? WHERE id = ?")
    .bind(input.videoId, v(input.videoUrl), v(input.privacy), v(input.jobId), now, req.id)
    .run()

  const record: PlaylistAdditionRecord = {
    t: new Date().toISOString(),
    status: 'added',
    slug: req.slug,
    artistName: req.artistName,
    setUrl: req.setUrl,
    videoId: input.videoId,
    videoUrl: input.videoUrl ?? `https://www.youtube.com/watch?v=${input.videoId}`,
    playlistId: playlistId!,
    playlistTitle,
    combinedStatus,
    via: 'mkvid',
    trigger: 'mkvid',
    message: `rendered by mkvid from ${req.source} (${input.privacy ?? 'unlisted'})${playlistStatus === 'duplicate' ? ' — already in the playlist' : ''}`,
    failureCount: null,
    meta: { ms: null },
  }
  await flushPlaylistAdditions(env, [record], log)
  log.info('mkvid.completed', { id: req.id, slug: req.slug, setUrl: req.setUrl, videoId: input.videoId, playlistId, playlistStatus, combinedStatus, privacy: input.privacy ?? null })
  return { status: 'done', videoId: input.videoId, playlistId: playlistId!, playlistStatus, combinedStatus }
}

export type FailInput = { id: string; error: string; permanent?: boolean; jobId?: string | null }

/**
 * mkvid could not deliver. A permanent failure (the recording is a clip, the
 * source is gone) parks the request as `failed`; anything else goes back to
 * `pending` with a backoff, until MAX_ATTEMPTS claims have been used.
 */
export async function failMkvidRequest(env: Env, input: FailInput, log: Logger): Promise<{ status: MkvidStatus; attempts: number } | null> {
  const req = await getMkvidRequest(env, input.id)
  if (!req) return null
  if (req.status === 'done' || req.status === 'superseded') return { status: req.status, attempts: req.attempts }
  const now = nowSeconds()
  const exhausted = req.attempts >= MKVID_MAX_ATTEMPTS
  const status: MkvidStatus = input.permanent || exhausted ? 'failed' : 'pending'
  const notBefore = status === 'pending' ? now + RETRY_BACKOFF_SECONDS * Math.max(1, req.attempts) : null
  await dbOf(env)
    .prepare('UPDATE mkvid_requests SET status = ?, not_before = ?, error = ?, job_id = COALESCE(?, job_id), updated_at = ? WHERE id = ?')
    .bind(status, notBefore, input.error.slice(0, 500), v(input.jobId), now, req.id)
    .run()
  log.warn('mkvid.failed', { id: req.id, slug: req.slug, setUrl: req.setUrl, attempts: req.attempts, status, permanent: !!input.permanent, error: input.error.slice(0, 200) })
  return { status, attempts: req.attempts }
}

/** Panel action: give a failed (or superseded) request a fresh start. */
export async function retryMkvidRequest(env: Env, id: string): Promise<boolean> {
  const r = await dbOf(env)
    .prepare(
      `UPDATE mkvid_requests SET status = 'pending', attempts = 0, not_before = NULL, claimed_at = NULL, error = NULL, updated_at = ?
       WHERE id = ? AND status IN ('failed', 'superseded', 'claimed')`,
    )
    .bind(nowSeconds(), id)
    .run()
  return (r.meta.changes ?? 0) > 0
}

/** The set gained a real recording on 1001tracklists: nothing left for mkvid to do. */
export async function supersedeMkvidRequestForSet(env: Env, setUrl: string, videoId: string): Promise<boolean> {
  const r = await dbOf(env)
    .prepare("UPDATE mkvid_requests SET status = 'superseded', error = ?, updated_at = ? WHERE set_url = ? AND status IN ('pending', 'claimed')")
    .bind(`1001tracklists now has ${videoId}`, nowSeconds(), setUrl)
    .run()
  return (r.meta.changes ?? 0) > 0
}

/** Read the JSON `summary`-like fields the panel needs without the full row noise. */
export function requestSummary(r: MkvidRequest): Record<string, unknown> {
  return { ...r, sourceLabel: r.source === 'soundcloud' ? 'SoundCloud' : 'hearthis.at' }
}

export { parseJson }
