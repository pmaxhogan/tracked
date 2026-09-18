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
 *   pending ──panel ✕──▶ banned ──panel Unban──▶ pending
 *
 * Each claim names the `account` (Google Cloud project) mkvid should upload
 * through — see MKVID_ACCOUNTS below.
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
/** `banned`: never upload this set via mkvid — the row stays so the sync cannot queue it again; the panel can lift it. */
export type MkvidStatus = 'pending' | 'claimed' | 'done' | 'failed' | 'superseded' | 'banned'

export const MKVID_MAX_ATTEMPTS = 3
export const DEFAULT_CLAIM_TTL_SECONDS = 3 * 60 * 60
/** A retryable failure waits this long × attempts before it can be claimed again. */
const RETRY_BACKOFF_SECONDS = 6 * 60 * 60
/**
 * mkvid uploads through two Google Cloud projects, each with its own 10 000-unit
 * YouTube quota day, and a `videos.insert` costs 1 600 of them:
 *   - `primary` — mkvid's own project (mkvid-uploads). Nothing else spends
 *     there, so six uploads (9 600) fit.
 *   - `shared` — the sync's project (tracked-youtube), which also pays for
 *     every playlist insert (50 each, ~2 000/day in steady state, far more
 *     while a backfill runs). Off unless MKVID_SHARED_DAILY_CLAIM_CAP says
 *     otherwise; three is the most it can carry without starving the sync.
 * A claim fills the primary account first and spills to the shared one.
 */
export type MkvidAccount = 'primary' | 'shared'
export const MKVID_ACCOUNTS: readonly MkvidAccount[] = ['primary', 'shared']
/** The Google Cloud project behind each account — what the panel shows. */
export const MKVID_ACCOUNT_LABELS: Record<MkvidAccount, string> = { primary: 'mkvid-uploads', shared: 'tracked-youtube' }
export const DEFAULT_DAILY_CLAIM_CAP = 6
export const DEFAULT_SHARED_DAILY_CLAIM_CAP = 0
/** The YouTube Data API quota resets at midnight Pacific, not UTC. */
const QUOTA_TZ = 'America/Los_Angeles'

const nowSeconds = () => Math.floor(Date.now() / 1000)

/** Unix seconds of the most recent midnight in the quota's time zone (DST handled by the zone). */
export function quotaDayStart(nowMs = Date.now()): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: QUOTA_TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(nowMs))
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  return Math.floor(nowMs / 1000) - (get('hour') * 3600 + get('minute') * 60 + get('second'))
}

/**
 * `0` pauses the queue, and it has to be spelled out: `Number('')` is 0 too, so
 * a blank secret (`echo $UNSET | wrangler secret put …`) would otherwise stop
 * every upload without anyone having asked for that.
 */
export function dailyClaimCap(env: Env, account: MkvidAccount = 'primary'): number {
  const fallback = account === 'shared' ? DEFAULT_SHARED_DAILY_CLAIM_CAP : DEFAULT_DAILY_CLAIM_CAP
  const raw = ((account === 'shared' ? env.MKVID_SHARED_DAILY_CLAIM_CAP : env.MKVID_DAILY_CLAIM_CAP) ?? '').trim()
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

/** Unix seconds at which the quota day rolls over and the daily claims start from zero again. */
export function quotaDayEnd(nowMs = Date.now()): number {
  // 26 h past local midnight is always inside the next local day, DST shift or not.
  return quotaDayStart((quotaDayStart(nowMs) + 26 * 3600) * 1000)
}

// ─── poll heartbeat ─────────────────────────────────────────────────────────

/** What the last `/mkvid/claim` poll got: a request, nothing queued, the daily cap, no connected YouTube account on mkvid's side, or a Worker-side error. */
export type MkvidPollOutcome = 'claimed' | 'empty' | 'capped' | 'not_connected' | 'error'
/** `accounts` = what mkvid said it could upload with on that poll, so the panel can tell "cap reached on the accounts mkvid has" from "ready". */
export type MkvidLastPoll = { at: number; outcome: MkvidPollOutcome; accounts?: MkvidAccount[] }

const LAST_POLL_KEY = 'mkvid:last_poll'
/** mkvid polls every minute; the heartbeat is only rewritten this often (or when the outcome changes) to spare KV writes. */
export const LAST_POLL_REFRESH_SECONDS = 10 * 60

/**
 * Remember that mkvid polled, so the panel can tell "mkvid is down / cannot
 * reach the Worker" from "mkvid is polling and is being told no". Best-effort.
 */
export async function recordMkvidPoll(env: Env, outcome: MkvidPollOutcome, accounts: readonly MkvidAccount[] = ['primary']): Promise<void> {
  try {
    const now = nowSeconds()
    const prev = await getMkvidLastPoll(env)
    const same = prev && prev.outcome === outcome && (prev.accounts ?? ['primary']).join() === accounts.join()
    if (same && now - prev.at < LAST_POLL_REFRESH_SECONDS) return
    await env.CACHE.put(LAST_POLL_KEY, JSON.stringify({ at: now, outcome, accounts: [...accounts] } satisfies MkvidLastPoll))
  } catch {
    // a heartbeat must never fail a claim
  }
}

export async function getMkvidLastPoll(env: Env): Promise<MkvidLastPoll | null> {
  const p = parseJson<MkvidLastPoll | null>(await env.CACHE.get(LAST_POLL_KEY), null)
  return p && typeof p.at === 'number' ? p : null
}

/**
 * Requests handed out since the quota day began — counted from D1, so a deploy
 * cannot reset it. Only claims that (may) have cost an upload count: one that
 * was refused before rendering (`failed`) or went back to `pending` spent nothing.
 */
export async function dailyClaimsUsed(env: Env, account: MkvidAccount = 'primary'): Promise<number> {
  const r = await dbOf(env)
    .prepare("SELECT COUNT(*) AS n FROM mkvid_requests WHERE status IN ('claimed', 'done') AND claimed_at IS NOT NULL AND claimed_at >= ? AND account = ?")
    .bind(quotaDayStart(), account)
    .first<{ n: number }>()
  return Number(r?.n ?? 0)
}

export type MkvidAccountUsage = { account: MkvidAccount; label: string; used: number; cap: number }

/** Today's claims against each account's cap, in fill order. */
export async function mkvidAccountUsage(env: Env): Promise<MkvidAccountUsage[]> {
  return Promise.all(MKVID_ACCOUNTS.map(async (account) => ({ account, label: MKVID_ACCOUNT_LABELS[account], used: await dailyClaimsUsed(env, account), cap: dailyClaimCap(env, account) })))
}

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

const ISO_DATE = /(\d{4}-\d{2}-\d{2})/
const URL_DATE_RE = /-(\d{4}-\d{2}-\d{2})\.html(?:[?#]|$)/
const META_DATE_RE = /itemprop="datePublished"\s+content="(\d{4}-\d{2}-\d{2})"/

/**
 * The set's date as ISO YYYY-MM-DD: the 1001tracklists URL slug ends in it,
 * failing that the page's date-only `datePublished` meta (the page-publication
 * one carries a full timestamp and is skipped), failing that the `<title>`.
 * Null when none of them has one — such a request is served last.
 */
export function extractSetDate(setUrl: string, html: string): string | null {
  const fromUrl = setUrl.match(URL_DATE_RE)?.[1]
  if (fromUrl && isPlausibleDate(fromUrl)) return fromUrl
  const fromMeta = html.match(META_DATE_RE)?.[1]
  if (fromMeta && isPlausibleDate(fromMeta)) return fromMeta
  const title = extractSetTitle(html)
  const fromTitle = title?.match(ISO_DATE)?.[1]
  return fromTitle && isPlausibleDate(fromTitle) ? fromTitle : null
}

function isPlausibleDate(d: string): boolean {
  const t = Date.parse(`${d}T00:00:00Z`)
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d && t > Date.UTC(1990, 0, 1) && t < Date.now() + 366 * 86400 * 1000
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
  /** ISO YYYY-MM-DD; the queue is served newest set first, undated last. */
  setDate: string | null
  /** Queue position key (higher = sooner): the set date as a Julian day unless the panel moved it. */
  sortKey: number
  source: MkvidSourceKind
  sourceUrl: string
  lastCueSeconds: number | null
  trackCount: number | null
  idedCount: number | null
  status: MkvidStatus
  /** Which Google project mkvid should upload this one through. */
  account: MkvidAccount
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
  set_date: string | null
  sort_key: number
  source: string
  source_url: string
  last_cue_seconds: number | null
  track_count: number | null
  ided_count: number | null
  status: string
  account: string
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
    setDate: r.set_date ?? null,
    sortKey: Number(r.sort_key ?? 0),
    source: r.source as MkvidSourceKind,
    sourceUrl: r.source_url,
    lastCueSeconds: r.last_cue_seconds,
    trackCount: r.track_count,
    idedCount: r.ided_count,
    status: r.status as MkvidStatus,
    account: r.account === 'shared' ? 'shared' : 'primary',
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
  setDate: string | null
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
         (id, slug, set_url, artist_name, set_title, set_date, sort_key, source, source_url, last_cue_seconds, track_count, ided_count,
          status, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, COALESCE(julianday(?), 0), ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      input.slug,
      input.setUrl,
      v(input.artistName),
      v(input.setTitle),
      v(input.setDate),
      v(input.setDate),
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

/** Newest activity first, for the admin panel. */
export async function listMkvidRequests(env: Env, limit = 100): Promise<MkvidRequest[]> {
  const res = await dbOf(env)
    .prepare('SELECT * FROM mkvid_requests ORDER BY updated_at DESC, created_at DESC LIMIT ?')
    .bind(Math.min(Math.max(limit, 1), 500))
    .all<Row>()
  return res.results.map(rowToRequest)
}

/**
 * Everything that has left the waiting line — rendering, done, failed,
 * superseded — rendering first, then newest activity first. The panel shows
 * this apart from the (long) pending queue, which would otherwise bury it.
 */
export async function listSettledMkvidRequests(env: Env, limit = 50): Promise<MkvidRequest[]> {
  const res = await dbOf(env)
    .prepare("SELECT * FROM mkvid_requests WHERE status != 'pending' ORDER BY (status = 'claimed') DESC, updated_at DESC, created_at DESC LIMIT ?")
    .bind(Math.min(Math.max(limit, 1), 500))
    .all<Row>()
  return res.results.map(rowToRequest)
}

/** The waiting line in the order it will be served; a request in retry backoff keeps its place but is skipped until `not_before`. */
export async function listPendingMkvidRequests(env: Env, limit = 50): Promise<MkvidRequest[]> {
  const res = await dbOf(env)
    .prepare(`SELECT * FROM mkvid_requests WHERE status = 'pending' ${QUEUE_ORDER} LIMIT ?`)
    .bind(Math.min(Math.max(limit, 1), 500))
    .all<Row>()
  return res.results.map(rowToRequest)
}

/**
 * Queue order: by `sort_key` — the set date as a Julian day (undated = 0), so
 * newest set first and undated last — ties by most recently queued. The panel
 * moves a row by rewriting its key (moveMkvidRequest). Shared by the claim,
 * the panel's waiting line and the "next up" preview.
 */
const CLAIMABLE_WHERE = `(status = 'pending' AND (not_before IS NULL OR not_before <= ?))
            OR (status = 'claimed' AND claimed_at IS NOT NULL AND claimed_at < ?)`
const QUEUE_ORDER = 'ORDER BY sort_key DESC, created_at DESC'

export type MkvidMove = 'top' | 'up' | 'down' | 'bottom'
export const MKVID_MOVES: readonly MkvidMove[] = ['top', 'up', 'down', 'bottom']

/** Today as a Julian day — what a set dated today gets as its sort key. */
const julianNow = () => Date.now() / 86_400_000 + 2_440_587.5

/**
 * Panel action: move a pending request within the waiting line. `up`/`down`
 * swap with exactly one neighbour; `top` goes ahead of everything queued (and
 * of anything dated up to today, so tomorrow's sync does not overtake it);
 * `bottom` goes behind everything. Only the moved row's key is rewritten,
 * unless its new neighbours tie (same set date) — then that tie block is
 * re-spaced so the move is still one step and never jumps a whole same-day
 * group. Returns the new 1-based position, or null if the request is not
 * pending.
 */
export async function moveMkvidRequest(env: Env, id: string, to: MkvidMove): Promise<{ position: number; rekeyed: number } | null> {
  const db = dbOf(env)
  const res = await db.prepare(`SELECT id, sort_key FROM mkvid_requests WHERE status = 'pending' ${QUEUE_ORDER}`).all<{ id: string; sort_key: number }>()
  const seq = res.results.map((r) => ({ id: r.id, key: Number(r.sort_key) }))
  const i = seq.findIndex((r) => r.id === id)
  if (i < 0) return null
  const last = seq.length - 1
  const j = to === 'top' ? 0 : to === 'bottom' ? last : to === 'up' ? Math.max(0, i - 1) : Math.min(last, i + 1)
  if (i === j) return { position: i + 1, rekeyed: 0 }
  const s2 = seq.slice()
  const [x] = s2.splice(i, 1)
  s2.splice(j, 0, x!)

  // The smallest window around the new position whose outside neighbours
  // strictly bracket it; a tie on either side pulls the whole tie block in.
  const keyAt = (k: number) => (k < 0 ? Infinity : k >= s2.length ? -Infinity : s2[k]!.key)
  let a = j
  let b = j
  while (keyAt(a - 1) <= keyAt(b + 1)) {
    const upper = keyAt(a - 1)
    const lower = keyAt(b + 1)
    while (keyAt(a - 1) === upper) a--
    while (keyAt(b + 1) === lower) b++
  }
  const upper = keyAt(a - 1)
  const lower = keyAt(b + 1)
  const n = b - a + 1
  const keys: number[] = []
  if (Number.isFinite(upper) && Number.isFinite(lower)) {
    const step = (upper - lower) / (n + 1)
    for (let k = 0; k < n; k++) keys.push(upper - step * (k + 1))
  } else if (Number.isFinite(lower)) {
    // Ahead of everything: a day per row above the newest, and above today.
    const base = Math.max(lower, julianNow())
    for (let k = 0; k < n; k++) keys.push(base + (n - k))
  } else if (Number.isFinite(upper)) {
    for (let k = 0; k < n; k++) keys.push(upper - (k + 1))
  } else {
    // The whole queue is one tie: keep everyone's key where it was, spaced by a hair.
    const base = Math.max(...s2.slice(a, b + 1).map((r) => r.key))
    for (let k = 0; k < n; k++) keys.push(base + (n - 1 - k) * 1e-6)
  }
  const now = nowSeconds()
  const stmts = []
  for (let k = 0; k < n; k++) {
    const row = s2[a + k]!
    if (row.key !== keys[k]) stmts.push(db.prepare('UPDATE mkvid_requests SET sort_key = ?, updated_at = ? WHERE id = ?').bind(keys[k], now, row.id))
  }
  if (stmts.length) await db.batch(stmts)
  return { position: j + 1, rekeyed: stmts.length }
}

/** Panel action: never upload this set via mkvid. The row stays, so the sync's INSERT OR IGNORE cannot queue it again; Retry (Unban) lifts it. */
export async function banMkvidRequest(env: Env, id: string): Promise<boolean> {
  const r = await dbOf(env)
    .prepare("UPDATE mkvid_requests SET status = 'banned', error = 'banned from the panel', not_before = NULL, updated_at = ? WHERE id = ? AND status IN ('pending', 'failed', 'superseded')")
    .bind(nowSeconds(), id)
    .run()
  return (r.meta.changes ?? 0) > 0
}

/** The head of the queue in claim order, without claiming anything. */
export async function nextMkvidRequests(env: Env, limit = 5): Promise<MkvidRequest[]> {
  const now = nowSeconds()
  const res = await dbOf(env)
    .prepare(`SELECT * FROM mkvid_requests WHERE ${CLAIMABLE_WHERE} ${QUEUE_ORDER} LIMIT ?`)
    .bind(now, now - claimTtl(env), Math.min(Math.max(limit, 1), 50))
    .all<Row>()
  return res.results.map(rowToRequest)
}

export async function countMkvidRequests(env: Env): Promise<Record<MkvidStatus, number>> {
  const res = await dbOf(env).prepare('SELECT status, COUNT(*) AS n FROM mkvid_requests GROUP BY status').all<{ status: string; n: number }>()
  const out: Record<MkvidStatus, number> = { pending: 0, claimed: 0, done: 0, failed: 0, superseded: 0, banned: 0 }
  for (const r of res.results) if (r.status in out) out[r.status as MkvidStatus] = Number(r.n)
  return out
}

function claimTtl(env: Env): number {
  const n = Number(env.MKVID_CLAIM_TTL_SECONDS)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CLAIM_TTL_SECONDS
}

/**
 * Hand the next claimable request to mkvid — newest set first: `pending` past
 * its backoff, or `claimed` for longer than the claim TTL (mkvid died mid-job). A request
 * whose set has meanwhile gained a video on 1001tracklists is marked
 * `superseded` and skipped. Returns null when there is nothing to do.
 */
export async function claimMkvidRequest(env: Env, log: Logger, accounts: readonly MkvidAccount[] = ['primary']): Promise<MkvidRequest | null> {
  const { request, outcome } = await claimNext(env, log, accounts)
  await recordMkvidPoll(env, outcome, accounts)
  return request
}

/**
 * `accounts` is what mkvid can upload with right now (a configured client
 * with a connected YouTube account); the first of them with claims left today
 * gets the request, so the primary project fills before the shared one.
 */
async function claimNext(env: Env, log: Logger, accounts: readonly MkvidAccount[]): Promise<{ request: MkvidRequest | null; outcome: MkvidPollOutcome }> {
  const db = dbOf(env)
  const now = nowSeconds()
  const stale = now - claimTtl(env)
  if (accounts.length === 0) {
    log.info('mkvid.claim_not_connected')
    return { request: null, outcome: 'not_connected' }
  }
  const usage = (await mkvidAccountUsage(env)).filter((u) => accounts.includes(u.account))
  const slot = usage.find((u) => u.used < u.cap)
  if (!slot) {
    log.info('mkvid.claim_capped', { accounts: usage.map((u) => `${u.account} ${u.used}/${u.cap}`) })
    return { request: null, outcome: 'capped' }
  }
  const { account, used, cap } = slot
  for (let i = 0; i < 20; i++) {
    const row = await db
      .prepare(
        `SELECT * FROM mkvid_requests WHERE ${CLAIMABLE_WHERE} ${QUEUE_ORDER} LIMIT 1`,
      )
      .bind(now, stale)
      .first<Row>()
    if (!row) return { request: null, outcome: 'empty' }
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
        `UPDATE mkvid_requests SET status = 'claimed', account = ?, claimed_at = ?, attempts = attempts + 1, job_id = NULL, updated_at = ?
         WHERE id = ? AND status = ? AND attempts = ?`,
      )
      .bind(account, now, now, row.id, row.status, row.attempts)
      .run()
    // Lost a race with another claimer (two mkvid instances) — pick again.
    if ((r.meta.changes ?? 0) === 0) continue
    const claimed = await getMkvidRequest(env, row.id)
    log.info('mkvid.claimed', { id: row.id, slug: row.slug, setUrl: row.set_url, source: row.source, attempt: claimed?.attempts ?? 0, account, dailyClaims: used + 1, cap })
    return { request: claimed, outcome: 'claimed' }
  }
  return { request: null, outcome: 'empty' }
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

/** Panel action: give a failed / superseded / stuck / banned request a fresh start (it keeps its place in the queue). */
export async function retryMkvidRequest(env: Env, id: string): Promise<boolean> {
  const r = await dbOf(env)
    .prepare(
      `UPDATE mkvid_requests SET status = 'pending', attempts = 0, not_before = NULL, claimed_at = NULL, error = NULL, updated_at = ?
       WHERE id = ? AND status IN ('failed', 'superseded', 'claimed', 'banned')`,
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
  return {
    ...r,
    sourceLabel: r.source === 'soundcloud' ? 'SoundCloud' : 'hearthis.at',
    // Display only: the stored name carries 1001tracklists' "Tracklists By" H1
    // prefix, and the artist playlists are titled (and found again) by it.
    artistLabel: (r.artistName ?? r.slug).replace(/^Tracklists By\s+/i, ''),
    accountLabel: MKVID_ACCOUNT_LABELS[r.account],
  }
}

export { parseJson }

/** What /now-playing needs to know about a set mkvid uploaded: the video and the tracklist it was rendered from. */
export type MkvidUploadMatch = { videoId: string; setUrl: string; setTitle: string; slug: string }

/**
 * The finished mkvid upload whose YouTube title is `title`, or null.
 *
 * mkvid uploads unlisted, and the YouTube Data API's `search.list` never
 * returns unlisted videos — so when Tasker posts the title of one of these
 * sets, the key-only YouTube search that /now-playing normally runs comes
 * back empty every time, and 1001tracklists cannot know the video's URL
 * either. Both are pointless for a set we uploaded ourselves: the request
 * row already holds the video id *and* the tracklist URL.
 *
 * Matching mirrors what mkvid sent to YouTube: `set_title` cut to YouTube's
 * 100-character title limit (lib/youtube.ts on the mkvid side slices before
 * `videos.insert`), compared case-insensitively and whitespace-trimmed on
 * both sides in SQL. A `superseded` row still has its `video_id` when the
 * upload finished before the set gained a 1001tl recording — that unlisted
 * video is still watchable, so it still counts.
 */
export async function findMkvidUploadByTitle(env: Env, title: string): Promise<MkvidUploadMatch | null> {
  const needle = title.trim()
  if (!needle) return null
  const row = await dbOf(env)
    .prepare(
      `SELECT slug, set_url, set_title, video_id FROM mkvid_requests
       WHERE video_id IS NOT NULL AND set_title IS NOT NULL AND status IN ('done', 'superseded')
         AND lower(substr(trim(set_title), 1, 100)) = lower(?)
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .bind(needle)
    .first<{ slug: string; set_url: string; set_title: string; video_id: string }>()
  return row ? { videoId: row.video_id, setUrl: row.set_url, setTitle: row.set_title, slug: row.slug } : null
}
