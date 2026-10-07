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
 *   done ──panel "Delete and recreate"──▶ pending (back of the queue; lib/mkvid-recreate.ts)
 *
 * A pending request is only claimable once its track list is verified, at
 * least 90 % timed, and any wait for IDs is over (lib/mkvid-readiness.ts); until then the claim
 * passes over it without using an attempt. mkvid refusing a list as
 * `unverified_tracklist` puts it back the same way.
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
import { addToCombined, flushCombined, openCombinedPlaylist, type CombinedAdditionStatus, type CombinedHandle } from './combined-playlist'
import { cachePlaylistVideoIds, findOrCreatePlaylist, getCachedPlaylistVideoIds } from './playlist-cache'
import { addVideoToPlaylist, PlaylistNotFoundError } from './youtube-playlists'
import { getTracklistRow, setTracklistVideo } from './sync-store'
import { isVerified, tracklistFingerprint, verifiedFingerprint } from './verification'
import { markInPlaylist } from './playlist-blocklist'
import { CLAIM_READY_SQL, ID_WAIT_SECONDS, pullInHeldRecheck, timedRowCounts } from './mkvid-readiness'
import { isOldStyle, queueBannedUploadForDelete, queueSupersededOldVideo, RECREATE_STYLE, retireReplacedVideo, retireSupersededOldVideo } from './mkvid-recreate'
import { decodeEntities } from './html-entities'
import { DEFAULT_APP_SETTINGS, getAppSettings, type AppSettings } from './app-settings'

export type MkvidSourceKind = 'soundcloud' | 'hearthis'
export const MKVID_SOURCES: readonly MkvidSourceKind[] = ['soundcloud', 'hearthis']
export type MkvidSource = { kind: MkvidSourceKind; url: string }
/** `banned`: never upload this set via mkvid — the row stays so the sync cannot queue it again; the panel can lift it. */
export type MkvidStatus = 'pending' | 'claimed' | 'done' | 'failed' | 'superseded' | 'banned'
export const MKVID_STATUSES: readonly MkvidStatus[] = ['pending', 'claimed', 'done', 'failed', 'superseded', 'banned']

// Defaults: the live values are app settings `mkvid` (lib/app-settings.ts, /ui/settings):
// maxAttempts; retryBackoffHours (a retryable failure waits this × attempts);
// unverifiedRetryMinutes (mkvid refused a list as unverified; no attempt used).
export const MKVID_MAX_ATTEMPTS = DEFAULT_APP_SETTINGS.mkvid.maxAttempts
export const DEFAULT_CLAIM_TTL_SECONDS = 3 * 60 * 60
/**
 * mkvid uploads through two Google Cloud projects. Since September 2026 (checked
 * with gcloud on both) YouTube meters uploads apart from everything else: each
 * project gets 100 `videos.insert` calls a day in their own bucket, and an
 * upload no longer spends any of the 10 000-unit general pool. So the upload
 * itself is cheap; what an mkvid video still costs is the two playlist inserts
 * the Worker makes on `completeMkvidRequest` (artist + combined, 50 units each)
 * — and those are always billed to the sync's project, tracked-youtube, because
 * they use the Worker's own OAuth token, whichever account uploaded.
 *   - `primary` — mkvid's own project (mkvid-uploads). Nothing else spends
 *     there; 24 of its 100 uploads a day.
 *   - `shared` — the sync's project (tracked-youtube). 6 of its 100 uploads,
 *     taken only once the primary is full or disconnected, so a lost primary
 *     client still leaves the queue moving.
 * 30 videos a day = ~3 000 general-pool units on tracked-youtube. Measured
 * there over 8 days before the raise: 1 053–1 559 units/day, ~900 of them for
 * the 9 videos then allowed, so the sync itself is ~150–650 — the total lands
 * near 3 200–3 700, and even the combined backfill's own ceiling (80 inserts,
 * 4 000 units, lib/combined-playlist.ts) on top stays under 8 000 of 10 000.
 * A claim fills the primary account first and spills to the shared one.
 */
export type MkvidAccount = 'primary' | 'shared'
export const MKVID_ACCOUNTS: readonly MkvidAccount[] = ['primary', 'shared']
/** The Google Cloud project behind each account — what the panel shows. */
export const MKVID_ACCOUNT_LABELS: Record<MkvidAccount, string> = { primary: 'mkvid-uploads', shared: 'tracked-youtube' }
export const DEFAULT_DAILY_CLAIM_CAP = 24
export const DEFAULT_SHARED_DAILY_CLAIM_CAP = 6
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
export function dailyClaimCap(env: Env, account: MkvidAccount = 'primary', app?: AppSettings): number {
  const saved = app ? (account === 'shared' ? app.mkvid.sharedDailyClaimCap : app.mkvid.dailyClaimCap) : null
  if (saved !== null) return saved
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
    .prepare('SELECT COUNT(*) AS n FROM mkvid_claims WHERE claimed_at >= ? AND account = ? AND refunded_at IS NULL')
    .bind(quotaDayStart(), account)
    .first<{ n: number }>()
  return Number(r?.n ?? 0)
}

export type MkvidAccountUsage = { account: MkvidAccount; label: string; used: number; cap: number }

/** Today's claims against each account's cap, in fill order. */
export async function mkvidAccountUsage(env: Env): Promise<MkvidAccountUsage[]> {
  const app = await getAppSettings(env)
  return Promise.all(MKVID_ACCOUNTS.map(async (account) => ({ account, label: MKVID_ACCOUNT_LABELS[account], used: await dailyClaimsUsed(env, account), cap: dailyClaimCap(env, account, app) })))
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


/** Largest cue on the tracklist (seconds), or null when nothing is cued. */
export function lastCueSeconds(tracks: ReadonlyArray<Pick<ParsedTrack, 'startSeconds'>>): number | null {
  let max: number | null = null
  for (const t of tracks) {
    if (t.startSeconds !== null && (max === null || t.startSeconds > max)) max = t.startSeconds
  }
  return max
}

// ─── track list handed to mkvid ─────────────────────────────────────────────

/**
 * One tracklist row as `/mkvid/claim` sends it, for mkvid to draw per-track
 * titles and artwork. `artist`/`title` are null for an anonymous ("ID") part
 * and for every row of an untrusted list; `isId` = the playing track itself is
 * unidentified. `layered` = a 1001tl "w/" row: plays on top of the row before
 * it rather than replacing it; its `cueSeconds` is its own printed cue, or null
 * when it has none (mkvid then starts it with its base). Never true on row 0.
 */
export type MkvidTrack = { cueSeconds: number | null; artist: string | null; title: string | null; artworkUrl: string | null; isId: boolean; layered: boolean }
export type MkvidTrackList = { tracks: MkvidTrack[]; tracksTrusted: boolean }
/** Sets run to ~150 rows; anything past this is not a set, and keeps a claim response bounded (~60 KB). */
export const MKVID_MAX_TRACKS = 300

/**
 * Whether the names on a parsed page can be shown. Since ~2026-09-22
 * 1001tracklists serves our accounts decoy pages: real cues, ids and artwork,
 * randomized names (see DecoySignal in lib/tracklists1001.ts). Two gates:
 *   - the list must be VERIFIED (lib/verification.ts, quest decision 2: a
 *     second fetch >= 2 h later by a different pool account agreed on every
 *     row) — `verified`, and
 *   - the page itself must pass the strict in-page check: at least three rows
 *     compared and not one of them contradicting itself (stricter than
 *     `looksLikeDecoy`, which needs a majority to *refuse* a page).
 *     `mismatched` counts far mismatches only; benign near ones
 *     (`nearMismatched`) never count.
 */
export function mkvidTracksTrusted(d: { named: number; mismatched: number; suspected: boolean }, verified = false): boolean {
  return verified && !d.suspected && d.named >= 3 && d.mismatched === 0
}

const nameOrNull = (s: string | null | undefined): string | null => {
  const t = (s ?? '').trim()
  return t && t !== 'ID' ? t : null
}

/** Parsed rows → the wire format. Names only survive on a trusted list; cues and artwork are real even on a decoy page. */
export function toMkvidTracks(tracks: ReadonlyArray<ParsedTrack & { anonymous?: boolean }>, trusted: boolean): MkvidTrack[] {
  return tracks.slice(0, MKVID_MAX_TRACKS).map((t, i) => {
    const layered = i > 0 && t.isMashupLinked
    return {
      // A "w/" row's startSeconds is its base's cue; send only a cue of its own.
      cueSeconds: layered ? (t.ownStartSeconds ?? null) : t.startSeconds,
      // An anonymous "ID - ID" row has nothing to show but "ID" (mkvid draws it with the set art).
      artist: trusted && !t.anonymous ? nameOrNull(t.artist) : null,
      title: trusted && !t.anonymous ? nameOrNull(t.title) : null,
      artworkUrl: t.anonymous ? null : t.artworkUrl,
      isId: t.anonymous || t.isUnidentified,
      layered,
    }
  })
}

/**
 * Store the track list of a queued set's page (sync: first queueing and every
 * recheck). Keyed by the request, so a set that is not queued stores nothing.
 * Trusted = these rows ARE the verified list (their fingerprint equals
 * set_verification.fingerprint of a verified set) and the page passes the
 * strict decoy check (mkvidTracksTrusted). The sync records the fetch in
 * lib/verification.ts before calling this, so the fetch that verifies a list
 * is the one that upgrades the stored copy; a list that differs from the
 * verified one, or whose match cannot be read, is stored untrusted.
 * A trusted list is never replaced by an untrusted one — the next fetch may
 * well be a decoy — but an untrusted one is upgraded as soon as a clean page
 * turns up, and a trusted one refreshed (1001tl users add IDs over time).
 */
export async function saveMkvidTracks(
  env: Env,
  setUrl: string,
  // `rows`, not `tracks`: every page row, anonymous "ID - ID" rows included (ScrapedTracklist.rows).
  parsed: { rows: ReadonlyArray<ParsedTrack & { anonymous?: boolean }>; decoy: { named: number; mismatched: number; suspected: boolean } },
): Promise<'saved' | 'kept' | 'no_request' | 'empty'> {
  if (parsed.rows.length === 0) return 'empty'
  const db = dbOf(env)
  const req = await db.prepare('SELECT id FROM mkvid_requests WHERE set_url = ?').bind(setUrl).first<{ id: string }>()
  if (!req) return 'no_request'
  // N2: verified is not enough — THESE rows must be the list that was verified.
  // A fetch that skipped verification (no account id, or a D1 error inside
  // noteSetFetch, which recordSetFetch swallows) must not upgrade a different
  // list to trusted. Any error here fails closed: the list is stored untrusted.
  let matchesVerified = false
  try {
    const verifiedFp = await verifiedFingerprint(env, setUrl)
    matchesVerified = verifiedFp !== null && verifiedFp === (await tracklistFingerprint(parsed))
  } catch {
    matchesVerified = false
  }
  const trusted = mkvidTracksTrusted(parsed.decoy, matchesVerified)
  const tracks = toMkvidTracks(parsed.rows, trusted)
  // ID rows of the list mkvid would draw — what the 7-day ID wait looks at (lib/mkvid-readiness.ts).
  const idRows = tracks.filter((t) => t.isId).length
  // How much of the list has cue times — what the 90 % timed gate looks at (lib/mkvid-readiness.ts).
  const { baseRows, timedRows } = timedRowCounts(tracks)
  const r = await db
    .prepare(
      `INSERT INTO mkvid_request_tracks (request_id, tracks, track_count, trusted, named, mismatched, scraped_at, id_rows, base_rows, timed_rows)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(request_id) DO UPDATE SET
         tracks = excluded.tracks, track_count = excluded.track_count, trusted = excluded.trusted,
         named = excluded.named, mismatched = excluded.mismatched, scraped_at = excluded.scraped_at, id_rows = excluded.id_rows,
         base_rows = excluded.base_rows, timed_rows = excluded.timed_rows
       WHERE excluded.trusted >= mkvid_request_tracks.trusted`,
    )
    .bind(req.id, JSON.stringify(tracks), tracks.length, trusted ? 1 : 0, parsed.decoy.named, parsed.decoy.mismatched, nowSeconds(), idRows, baseRows, timedRows)
    .run()
  // A held (under 90 % timed) list keeps its set due within a week, whichever list was kept.
  await pullInHeldRecheck(env, setUrl)
  if ((r.meta.changes ?? 0) === 0) return 'kept'
  // The request's counts follow the stored list: every row, anonymous "ID - ID" ones included.
  await db.prepare('UPDATE mkvid_requests SET track_count = ?, ided_count = ? WHERE id = ?').bind(tracks.length, tracks.length - idRows, req.id).run()
  return 'saved'
}

/** Page rows → the request's counts: every row, and the identified ones (anonymous "ID - ID" rows are neither named nor identified). */
export function mkvidRowCounts(rows: ReadonlyArray<ParsedTrack & { anonymous?: boolean }>): { trackCount: number; idedCount: number } {
  return { trackCount: rows.length, idedCount: rows.filter((t) => !t.anonymous && !t.isUnidentified).length }
}

/**
 * The stored list for a request; empty and untrusted when there is none or it
 * cannot be read — including before migration 0006 is applied, so a claim
 * never fails over the list.
 */
export async function getMkvidTracks(env: Env, requestId: string, opts: { setUrl?: string } = {}): Promise<MkvidTrackList> {
  let row: { tracks: string; trusted: number } | null
  try {
    row = await dbOf(env)
      .prepare('SELECT tracks, trusted FROM mkvid_request_tracks WHERE request_id = ?')
      .bind(requestId)
      .first<{ tracks: string; trusted: number }>()
  } catch {
    return { tracks: [], tracksTrusted: false }
  }
  const tracks = parseJson<MkvidTrack[] | null>(row?.tracks ?? null, null)
  if (!row || !Array.isArray(tracks)) return { tracks: [], tracksTrusted: false }
  // The stored flag alone is not enough: the set must be verified now too.
  const setUrl = opts.setUrl ?? (await dbOf(env).prepare('SELECT set_url FROM mkvid_requests WHERE id = ?').bind(requestId).first<{ set_url: string }>())?.set_url
  const verified = setUrl ? await isVerified(env, setUrl) : false
  return { tracks, tracksTrusted: Number(row.trusted) === 1 && verified && tracks.length > 0 }
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
  /** "Render now": skip the 7-day wait for IDs (a verified list is still required). */
  skipIdWait: boolean
  /** The visual style mkvid made the current video with; null = unknown (an old-style video). */
  style: string | null
  /** Mid "Delete and recreate": the video being replaced (still up until the new one is delivered). */
  replacesVideoId: string | null
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
  skip_id_wait?: number | null
  style?: string | null
  replaces_video_id?: string | null
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
    skipIdWait: Number(r.skip_id_wait ?? 0) === 1,
    style: r.style ?? null,
    replacesVideoId: r.replaces_video_id ?? null,
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
 * The set's 1001tracklists id (`/tracklist/<id>/<name>.html`), stored as
 * mkvid_requests.tl_id (migration 0014 backfills it the same way). 1001tl
 * renames a set's <name> part, and a DJ page can list the old and the new URL
 * side by side; both are one set. Null when the URL has no id.
 */
export function tracklistIdOf(setUrl: string): string | null {
  return setUrl.match(/\/tracklist\/([^/?#]+)\//)?.[1] ?? null
}

/** Twin statuses that stand for the set: queued, rendering, has its video, or banned (a ban is for the set, not its URL name). A failed or superseded twin does not block the other URL. */
const LIVE_TWIN_STATUSES = "('pending', 'claimed', 'done', 'banned')"

/**
 * Queue a set, unless it already has a request (any status — a `done` or
 * `failed` request is final for that set until someone retries it from the
 * panel), or a live one (LIVE_TWIN_STATUSES) under another URL of the same
 * tracklist id. Returns whether a row was created.
 */
export async function enqueueMkvidRequest(env: Env, input: EnqueueInput): Promise<'queued' | 'exists'> {
  const now = nowSeconds()
  const r = await dbOf(env)
    .prepare(
      `INSERT OR IGNORE INTO mkvid_requests
         (id, slug, set_url, artist_name, set_title, set_date, sort_key, source, source_url, last_cue_seconds, track_count, ided_count,
          status, attempts, created_at, updated_at, tl_id)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, COALESCE(julianday(?7), 0), ?8, ?9, ?10, ?11, ?12, 'pending', 0, ?13, ?14, ?15
       WHERE ?15 IS NULL OR NOT EXISTS (SELECT 1 FROM mkvid_requests WHERE tl_id = ?15 AND status IN ${LIVE_TWIN_STATUSES})`,
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
      tracklistIdOf(input.setUrl),
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

// ─── panel listing: filter + keyset pagination ──────────────────────────────

/**
 * What the panel can narrow either list by — every part optional, an empty
 * filter means the whole table. `q` is a case-insensitive substring over the
 * set title, the DJ (stored name or slug) and the set URL.
 */
export type MkvidFilter = {
  /** Statuses to include; empty or absent = all of them. */
  statuses?: readonly MkvidStatus[]
  source?: MkvidSourceKind | null
  account?: MkvidAccount | null
  slug?: string | null
  q?: string | null
}

export type MkvidPage<T> = {
  records: T[]
  /** Pass back as this section's cursor for the next (older / further down) page; null when this was the last. */
  cursor: string | null
  /** Rows matching the filter in this section, not just the ones on this page. */
  total: number
}

/**
 * A waiting-line row carries its true 1-based place in the *unfiltered* queue,
 * so ⤒ ↑ ↓ ⤓ still mean something on a filtered or paged view.
 */
export type MkvidQueueRow = MkvidRequest & { position: number }

const DEFAULT_PAGE = 50
const MAX_PAGE = 200

function pageLimit(limit: number | undefined): number {
  const n = Math.floor(Number(limit ?? DEFAULT_PAGE))
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), MAX_PAGE) : DEFAULT_PAGE
}

/** `%`, `_` and `\` are LIKE wildcards: a search for `100%` must not match everything. */
function likeTerm(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
}

type Clause = { sql: string; binds: (string | number)[] }

function filterClause(f: MkvidFilter, statuses: readonly MkvidStatus[]): Clause {
  const sql = [`status IN (${statuses.map(() => '?').join(', ')})`]
  const binds: (string | number)[] = [...statuses]
  if (f.source) {
    sql.push('source = ?')
    binds.push(f.source)
  }
  if (f.account) {
    sql.push('account = ?')
    binds.push(f.account)
  }
  if (f.slug) {
    sql.push('slug = ?')
    binds.push(f.slug)
  }
  const q = f.q?.trim()
  if (q) {
    sql.push("(COALESCE(set_title, '') LIKE ? ESCAPE '\\' OR COALESCE(artist_name, '') LIKE ? ESCAPE '\\' OR slug LIKE ? ESCAPE '\\' OR set_url LIKE ? ESCAPE '\\')")
    const t = likeTerm(q)
    binds.push(t, t, t, t)
  }
  return { sql: sql.join(' AND '), binds }
}

/** The statuses of `f` that live in this section: the waiting line is `pending`, everything else has left it. */
function sectionStatuses(f: MkvidFilter, pending: boolean): MkvidStatus[] {
  const here = MKVID_STATUSES.filter((s) => (s === 'pending') === pending)
  const want = f.statuses?.length ? f.statuses : here
  return here.filter((s) => want.includes(s))
}

/**
 * Keyset cursor — the last row of the page handed back, as its three sort
 * columns: `<sort key or rendering flag>|<timestamp>|<rowid>`. Keyset, not
 * OFFSET, so a claim, a retry or a reorder between two pages cannot make a row
 * skip a page or show up on both.
 */
const CURSOR_RE = /^(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\|(\d+)\|(\d+)$/

function encodeMkvidCursor(a: number, b: number, row: number): string {
  return `${a}|${b}|${row}`
}

function decodeMkvidCursor(cursor: string | null | undefined): { a: number; b: number; row: number } | null {
  const m = cursor ? CURSOR_RE.exec(cursor) : null
  return m ? { a: Number(m[1]), b: Number(m[2]), row: Number(m[3]) } : null
}

async function countMatching(env: Env, where: Clause): Promise<number> {
  const row = await dbOf(env)
    .prepare(`SELECT COUNT(*) AS n FROM mkvid_requests WHERE ${where.sql}`)
    .bind(...where.binds)
    .all<{ n: number }>()
  return Number(row.results[0]?.n ?? 0)
}

export type MkvidListOptions = MkvidFilter & { limit?: number; cursor?: string | null }

/**
 * A page of the waiting line, in the order it will be served; a request in
 * retry backoff keeps its place but is skipped until `not_before`. Each row
 * knows its position in the whole queue, which the filter does not shift.
 */
export async function listMkvidQueuePage(env: Env, opts: MkvidListOptions = {}): Promise<MkvidPage<MkvidQueueRow>> {
  const statuses = sectionStatuses(opts, true)
  if (!statuses.length) return { records: [], cursor: null, total: 0 }
  const limit = pageLimit(opts.limit)
  const where = filterClause(opts, statuses)
  const cur = decodeMkvidCursor(opts.cursor)
  const keyset = cur ? ' AND (sort_key < ? OR (sort_key = ? AND (created_at < ? OR (created_at = ? AND rid > ?))))' : ''
  const keysetBinds = cur ? [cur.a, cur.a, cur.b, cur.b, cur.row] : []
  const [res, total] = await Promise.all([
    dbOf(env)
      .prepare(
        `SELECT * FROM (SELECT *, rowid AS rid, ROW_NUMBER() OVER (${QUEUE_ORDER}) AS position FROM mkvid_requests WHERE status = 'pending')
          WHERE ${where.sql}${keyset} ${QUEUE_PAGE_ORDER} LIMIT ?`,
      )
      .bind(...where.binds, ...keysetBinds, limit + 1)
      .all<Row & { rid: number; position: number }>(),
    countMatching(env, where),
  ])
  const page = res.results.slice(0, limit)
  const last = page[page.length - 1]
  return {
    records: page.map((r) => ({ ...rowToRequest(r), position: Number(r.position) })),
    cursor: res.results.length > limit && last ? encodeMkvidCursor(Number(last.sort_key ?? 0), Number(last.created_at), Number(last.rid)) : null,
    total,
  }
}

/** Sorts `claimed` (rendering now) ahead of everything else; shared by the ordering and its cursor. */
const RENDERING = "(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END)"
const SETTLED_ORDER = `ORDER BY ${RENDERING} DESC, updated_at DESC, rowid ASC`

/**
 * A page of everything that has left the waiting line — rendering, done,
 * failed, superseded, banned — rendering first, then newest activity first.
 * The panel shows this apart from the (long) pending queue, which would
 * otherwise bury it.
 */
export async function listMkvidSettledPage(env: Env, opts: MkvidListOptions = {}): Promise<MkvidPage<MkvidRequest>> {
  const statuses = sectionStatuses(opts, false)
  if (!statuses.length) return { records: [], cursor: null, total: 0 }
  const limit = pageLimit(opts.limit)
  const where = filterClause(opts, statuses)
  const cur = decodeMkvidCursor(opts.cursor)
  const keyset = cur ? ` AND (${RENDERING} < ? OR (${RENDERING} = ? AND (updated_at < ? OR (updated_at = ? AND rowid > ?))))` : ''
  const keysetBinds = cur ? [cur.a, cur.a, cur.b, cur.b, cur.row] : []
  const [res, total] = await Promise.all([
    dbOf(env)
      .prepare(`SELECT *, rowid AS rid FROM mkvid_requests WHERE ${where.sql}${keyset} ${SETTLED_ORDER} LIMIT ?`)
      .bind(...where.binds, ...keysetBinds, limit + 1)
      .all<Row & { rid: number }>(),
    countMatching(env, where),
  ])
  const page = res.results.slice(0, limit)
  const last = page[page.length - 1]
  return {
    records: page.map(rowToRequest),
    cursor: res.results.length > limit && last ? encodeMkvidCursor(last.status === 'claimed' ? 1 : 0, Number(last.updated_at), Number(last.rid)) : null,
    total,
  }
}

/** The DJs the queue has ever held, most requests first — the panel's "every DJ" filter. */
export type MkvidDj = { slug: string; label: string; count: number }

export async function listMkvidDjs(env: Env): Promise<MkvidDj[]> {
  const res = await dbOf(env)
    .prepare('SELECT slug, MAX(artist_name) AS artist_name, COUNT(*) AS n FROM mkvid_requests GROUP BY slug ORDER BY n DESC, slug LIMIT 200')
    .all<{ slug: string; artist_name: string | null; n: number }>()
  return res.results.map((r) => ({ slug: r.slug, label: artistLabel(r.artist_name, r.slug), count: Number(r.n) }))
}

/** First page of each list, unfiltered — the shape the rest of the code (and the tests) still want. */
export async function listSettledMkvidRequests(env: Env, limit = 50): Promise<MkvidRequest[]> {
  return (await listMkvidSettledPage(env, { limit })).records
}

export async function listPendingMkvidRequests(env: Env, limit = 50): Promise<MkvidQueueRow[]> {
  return (await listMkvidQueuePage(env, { limit })).records
}

/**
 * Queue order: by `sort_key` — the set date as a Julian day (undated = 0), so
 * newest set first and undated last — ties by most recently queued. The panel
 * moves a row by rewriting its key (moveMkvidRequest). Shared by the claim,
 * the panel's waiting line and the "next up" preview.
 */
const CLAIMABLE_WHERE = `(status = 'pending' AND (not_before IS NULL OR not_before <= ?))
            OR (status = 'claimed' AND claimed_at IS NOT NULL AND claimed_at < ?)`
const QUEUE_ORDER = 'ORDER BY sort_key DESC, created_at DESC, rowid ASC'

/** 1-based place of a pending request in the whole queue (claim order); null when it is not pending. */
export async function mkvidQueuePosition(env: Env, id: string): Promise<number | null> {
  const row = await dbOf(env)
    .prepare(`SELECT position FROM (SELECT id, ROW_NUMBER() OVER (${QUEUE_ORDER}) AS position FROM mkvid_requests WHERE status = 'pending') WHERE id = ?`)
    .bind(id)
    .first<{ position: number }>()
  return row ? Number(row.position) : null
}

/** QUEUE_ORDER over the paged panel query, whose subquery exposes `rowid` as `rid`. */
const QUEUE_PAGE_ORDER = 'ORDER BY sort_key DESC, created_at DESC, rid ASC'
/** CLAIMABLE_WHERE and QUEUE_ORDER over `mkvid_requests r` joined to its track list. */
const CLAIMABLE_WHERE_R = `(r.status = 'pending' AND (r.not_before IS NULL OR r.not_before <= ?))
            OR (r.status = 'claimed' AND r.claimed_at IS NOT NULL AND r.claimed_at < ?)`
const QUEUE_ORDER_R = 'ORDER BY r.sort_key DESC, r.created_at DESC, r.rowid ASC'

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

/** The head of the queue in claim order — only what a claim would take (verified, ID wait over) — without claiming anything. */
export async function nextMkvidRequests(env: Env, limit = 5): Promise<MkvidRequest[]> {
  const now = nowSeconds()
  const res = await dbOf(env)
    .prepare(
      `SELECT r.* FROM mkvid_requests r JOIN mkvid_request_tracks t ON t.request_id = r.id
        WHERE (${CLAIMABLE_WHERE_R}) AND ${CLAIM_READY_SQL} ${QUEUE_ORDER_R} LIMIT ?`,
    )
    .bind(now, now - claimTtl(env, await getAppSettings(env)), now - ID_WAIT_SECONDS, Math.min(Math.max(limit, 1), 50))
    .all<Row>()
  return res.results.map(rowToRequest)
}

export async function countMkvidRequests(env: Env): Promise<Record<MkvidStatus, number>> {
  const res = await dbOf(env).prepare('SELECT status, COUNT(*) AS n FROM mkvid_requests GROUP BY status').all<{ status: string; n: number }>()
  const out: Record<MkvidStatus, number> = { pending: 0, claimed: 0, done: 0, failed: 0, superseded: 0, banned: 0 }
  for (const r of res.results) if (r.status in out) out[r.status as MkvidStatus] = Number(r.n)
  return out
}

/** Claim TTL in seconds: app setting mkvid.claimTtlMinutes, else MKVID_CLAIM_TTL_SECONDS, else 3 h. */
export function claimTtl(env: Env, app?: AppSettings): number {
  if (app && app.mkvid.claimTtlMinutes !== null) return app.mkvid.claimTtlMinutes * 60
  const n = Number(env.MKVID_CLAIM_TTL_SECONDS)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CLAIM_TTL_SECONDS
}

/**
 * Hand the next claimable request to mkvid — newest set first: `pending` past
 * its backoff, or `claimed` for longer than the claim TTL (mkvid died mid-job). A request
 * whose set has meanwhile gained a video on 1001tracklists is marked
 * `superseded` and skipped. Returns null when there is nothing to do.
 */
export async function claimMkvidRequest(
  env: Env,
  log: Logger,
  accounts: readonly MkvidAccount[] = ['primary'],
  /** The style mkvid renders tracked jobs with. Recreations are only handed to a `scene` mkvid. */
  style: string | null = null,
): Promise<MkvidClaim | null> {
  const { request, outcome } = await claimNext(env, log, accounts, style === RECREATE_STYLE)
  await recordMkvidPoll(env, outcome, accounts)
  if (!request) return null
  return { ...request, ...(await getMkvidTracks(env, request.id)) }
}

/** What `/mkvid/claim` hands out: the request plus its track list (empty + untrusted when none is stored). */
export type MkvidClaim = MkvidRequest & MkvidTrackList

/**
 * `accounts` is what mkvid can upload with right now (a configured client
 * with a connected YouTube account); the first of them with claims left today
 * gets the request, so the primary project fills before the shared one.
 */
async function claimNext(env: Env, log: Logger, accounts: readonly MkvidAccount[], allowRecreate: boolean): Promise<{ request: MkvidRequest | null; outcome: MkvidPollOutcome }> {
  const db = dbOf(env)
  const now = nowSeconds()
  const stale = now - claimTtl(env, await getAppSettings(env))
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
  // Only requests whose list is verified and whose ID wait is over (or
  // skipped) are candidates (lib/mkvid-readiness.ts); the rest stay pending,
  // untouched, in their place. Each row is looked at once per claim.
  // A recreation is only worth rendering in the current style: an mkvid that
  // does not say `scene` never gets one (it stays pending, no attempt, no slot).
  const recreateGate = allowRecreate ? '' : 'AND r.replaces_video_id IS NULL'
  const seen = new Set<string>()
  for (let round = 0; round < 4; round++) {
    // Rows already looked at this claim are excluded, so a page of rows the
    // fetch layer does not call verified cannot hide the ones behind it.
    const skip = [...seen]
    const batch = await db
      .prepare(
        `SELECT r.* FROM mkvid_requests r JOIN mkvid_request_tracks t ON t.request_id = r.id
          WHERE (${CLAIMABLE_WHERE_R}) AND ${CLAIM_READY_SQL} ${recreateGate}
            ${skip.length ? `AND r.id NOT IN (${skip.map(() => '?').join(', ')})` : ''}
          ${QUEUE_ORDER_R} LIMIT 25`,
      )
      .bind(now, stale, now - ID_WAIT_SECONDS, ...skip)
      .all<Row>()
    const fresh = batch.results.filter((row) => !seen.has(row.id))
    if (!fresh.length) return { request: null, outcome: 'empty' }
    for (const row of fresh) {
      seen.add(row.id)
      const r = await tryClaimRow(env, log, row, { account, used, cap, now })
      if (r) return { request: r, outcome: 'claimed' }
    }
  }
  return { request: null, outcome: 'empty' }
}

/** Claim one candidate row, or settle it (superseded / failed / not verified after all) and return null. */
async function tryClaimRow(
  env: Env,
  log: Logger,
  row: Row,
  a: { account: MkvidAccount; used: number; cap: number; now: number },
): Promise<MkvidRequest | null> {
  const db = dbOf(env)
  const { account, used, cap, now } = a
  {
    const tl = await getTracklistRow(env, row.slug, row.set_url)
    // A recreation's set still resolves to the mkvid video being replaced: that is not a real recording.
    if (tl?.video_id && !(tl.video_source === 'mkvid' && tl.video_id === row.replaces_video_id)) {
      await db
        .prepare("UPDATE mkvid_requests SET status = 'superseded', error = ?, updated_at = ? WHERE id = ?")
        .bind(`set already resolves to ${tl.video_id} (${tl.video_source ?? '1001tl'})`, now, row.id)
        .run()
      if (row.replaces_video_id) await queueSupersededOldVideo(env, row.id, tl.video_id)
      log.info('mkvid.claim_superseded', { id: row.id, setUrl: row.set_url, videoId: tl.video_id })
      return null
    }
    // The same tracklist under an older/newer URL (1001tl renamed the set)
    // has its mkvid video, or is rendering it: rendering this one too would
    // upload a duplicate. A recreation is left alone — it replaces its own
    // video (playlists, tracklists row) through the normal completion, which
    // superseding here would skip.
    const tlId = row.replaces_video_id ? null : tracklistIdOf(row.set_url)
    const twin = tlId
      ? await db
          .prepare(
            `SELECT set_url, status, video_id FROM mkvid_requests
              WHERE tl_id = ? AND id != ? AND ((status = 'done' AND video_id IS NOT NULL) OR status = 'claimed')
              ORDER BY status = 'done' DESC LIMIT 1`,
          )
          .bind(tlId, row.id)
          .first<{ set_url: string; status: 'done' | 'claimed'; video_id: string | null }>()
      : null
    if (twin?.status === 'claimed') {
      // Not settled yet: if it fails, this one may still be needed.
      log.info('mkvid.claim_skip_twin_rendering', { id: row.id, setUrl: row.set_url, twinSetUrl: twin.set_url })
      return null
    }
    if (twin?.video_id) {
      await db
        .prepare("UPDATE mkvid_requests SET status = 'superseded', error = ?, updated_at = ? WHERE id = ?")
        .bind(`same tracklist as ${twin.set_url}, already rendered as ${twin.video_id}`, now, row.id)
        .run()
      log.info('mkvid.claim_superseded_twin', { id: row.id, setUrl: row.set_url, twinSetUrl: twin.set_url, videoId: twin.video_id })
      return null
    }
  }
  if (row.attempts >= (await getAppSettings(env)).mkvid.maxAttempts) {
    await db
      .prepare("UPDATE mkvid_requests SET status = 'failed', error = COALESCE(error, 'too many attempts'), updated_at = ? WHERE id = ?")
      .bind(now, row.id)
      .run()
    return null
  }
  // The SQL gate reads the stored `trusted` flag; the fetch layer's verdict is the one that counts.
  if (!(await isVerified(env, row.set_url))) {
    log.info('mkvid.claim_skip_unverified', { id: row.id, setUrl: row.set_url })
    return null
  }
  const r = await db
    .prepare(
      `UPDATE mkvid_requests SET status = 'claimed', account = ?, claimed_at = ?, attempts = attempts + 1, job_id = NULL, updated_at = ?
       WHERE id = ? AND status = ? AND attempts = ?`,
    )
    .bind(account, now, now, row.id, row.status, row.attempts)
    .run()
  // Lost a race with another claimer (two mkvid instances) — pick again.
  if ((r.meta.changes ?? 0) === 0) return null
  // The day's usage is this append-only log (migration 0010), never the rows' state.
  await db
    .prepare('INSERT INTO mkvid_claims (request_id, account, claimed_at, recreate) VALUES (?, ?, ?, ?)')
    .bind(row.id, account, now, row.replaces_video_id ? 1 : 0)
    .run()
  const claimed = await getMkvidRequest(env, row.id)
  log.info('mkvid.claimed', { id: row.id, slug: row.slug, setUrl: row.set_url, source: row.source, attempt: claimed?.attempts ?? 0, account, dailyClaims: used + 1, cap, recreate: !!row.replaces_video_id })
  return claimed
}

/** mkvid tells us which of its jobs is handling a claimed request (purely informational). */
/**
 * `POST /mkvid/job`: mkvid names the job working on a claimed request, right
 * after the claim and again on every poll while the job is queued or running
 * there. Each call renews the claim (`claimed_at`): mkvid runs two jobs at
 * once, and one waiting for the render slot must not outlive the claim TTL and
 * be handed out again. Only a request still claimed, for no job or this one,
 * is touched (a request since retried, finished or claimed for another job is
 * left alone). `updated_at` only moves when the job id changes: the lists page
 * by it, and a row that moves every minute would skip or repeat across pages.
 */
export async function attachMkvidJob(env: Env, id: string, jobId: string): Promise<void> {
  const now = nowSeconds()
  await dbOf(env)
    .prepare(
      `UPDATE mkvid_requests SET claimed_at = ?, job_id = ?, updated_at = CASE WHEN job_id IS ? THEN updated_at ELSE ? END
       WHERE id = ? AND status = 'claimed' AND (job_id IS NULL OR job_id = ?)`,
    )
    .bind(now, jobId, jobId, now, id, jobId)
    .run()
}

export type CompleteInput = {
  id: string
  videoId: string
  videoUrl?: string | null
  privacy?: string | null
  jobId?: string | null
  /** The visual style mkvid rendered with ('static' | 'waves' | 'scene'); absent from older mkvids = unknown. */
  style?: string | null
}

export type CompleteResult =
  | {
      status: 'done'
      videoId: string
      playlistId: string
      playlistStatus: 'added' | 'duplicate'
      combinedStatus: CombinedAdditionStatus
      /** A recreation: the old video, now out of the playlists and queued for deletion from YouTube. */
      replacedVideoId?: string
    }
  | { status: 'superseded'; videoId: string; existingVideoId: string }
  /** Banned while it rendered: the upload is kept out of the playlists and queued for deletion. */
  | { status: 'banned'; videoId: string }
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
  // Banned from the panel while mkvid rendered it (2026-10-01): the ban wins.
  if (req.status === 'banned') {
    await queueBannedUploadForDelete(env, { requestId: req.id, slug: req.slug, setUrl: req.setUrl, videoId: input.videoId, style: input.style ?? null })
    await dbOf(env).prepare('UPDATE mkvid_requests SET job_id = COALESCE(?, job_id), updated_at = ? WHERE id = ?').bind(v(input.jobId), now, req.id).run()
    log.warn('mkvid.complete_banned', { id: req.id, slug: req.slug, setUrl: req.setUrl, videoId: input.videoId })
    return { status: 'banned', videoId: input.videoId }
  }
  // The same upload redelivered after an unban (mkvid never saw the banned
  // answer), or after "Delete video" took it down (the request is pending
  // again): it is already queued for deletion, so it never goes live.
  const doomed = await db.prepare("SELECT 1 AS x FROM mkvid_old_videos WHERE video_id = ? AND replaced_by IN ('banned', 'unpublished')").bind(input.videoId).first()
  if (doomed) return { status: 'banned', videoId: input.videoId }

  const tl = await getTracklistRow(env, req.slug, req.setUrl)
  // A recreation: the set still resolving to the mkvid video being replaced is expected, not a real recording.
  const oldVideoId = req.replacesVideoId && req.replacesVideoId !== input.videoId ? req.replacesVideoId : null
  const replacing = !!oldVideoId && tl?.video_source === 'mkvid' && tl.video_id === oldVideoId
  if (tl?.video_id && tl.video_id !== input.videoId && !replacing) {
    // A recreation superseded by an official recording: the old mkvid video
    // still goes (out of both playlists if the sync left it there, then
    // deleted from YouTube). The new upload is kept on record in video_id.
    if (oldVideoId) await retireSupersededOldVideo(env, { requestId: req.id, slug: req.slug, setUrl: req.setUrl, oldVideoId, replacedBy: tl.video_id, accessToken, log })
    await db
      .prepare(
        "UPDATE mkvid_requests SET status = 'superseded', video_id = ?, video_url = ?, privacy = ?, style = ?, replaces_video_id = NULL, job_id = COALESCE(?, job_id), error = ?, updated_at = ? WHERE id = ?",
      )
      .bind(input.videoId, v(input.videoUrl), v(input.privacy), v(input.style), v(input.jobId), `set gained ${tl.video_id} before the upload finished`, now, req.id)
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
    await markInPlaylist(env, playlistId!, input.videoId, 'mkvid')
    playlistStatus = 'added'
  }

  // Combined playlist mirror — best-effort, like the sync's.
  let combinedStatus: CombinedAdditionStatus = 'unavailable'
  let combined: CombinedHandle | null = null
  try {
    combined = await openCombinedPlaylist(env, accessToken, log)
    if (combined) combinedStatus = await addToCombined(env, combined, input.videoId, accessToken, log)
  } catch (e) {
    combinedStatus = 'failed'
    log.warn('mkvid.combined_add_failed', { id: req.id, videoId: input.videoId, ...errorFields(e) })
  }

  // A recreation: the new video is in; now the old one comes out of both
  // playlists and is queued for deletion from YouTube (lib/mkvid-recreate.ts).
  if (oldVideoId && !replacing) {
    // A recreation whose set no longer resolves to the old video (the owner or
    // the dead-video pass took it out meanwhile): it still gets deleted.
    await retireSupersededOldVideo(env, { requestId: req.id, slug: req.slug, setUrl: req.setUrl, oldVideoId, replacedBy: input.videoId, accessToken, log, combined })
  }
  if (replacing && oldVideoId) {
    await retireReplacedVideo(env, {
      requestId: req.id,
      slug: req.slug,
      setUrl: req.setUrl,
      oldVideoId,
      oldStyle: req.style,
      newVideoId: input.videoId,
      playlistId: playlistId!,
      playlistVideoIds: existing,
      combined,
      combinedOk: combinedStatus !== 'failed' && combinedStatus !== 'unavailable',
      accessToken,
      log,
    })
  }
  if (combined) {
    try {
      await flushCombined(env, combined, log)
    } catch (e) {
      log.warn('mkvid.combined_flush_failed', { id: req.id, ...errorFields(e) })
    }
  }

  await setTracklistVideo(env, req.slug, req.setUrl, { videoId: input.videoId, source: 'mkvid', checkedAt: now })
  await db
    .prepare(
      "UPDATE mkvid_requests SET status = 'done', video_id = ?, video_url = ?, privacy = ?, style = ?, replaces_video_id = NULL, job_id = COALESCE(?, job_id), error = NULL, updated_at = ? WHERE id = ?",
    )
    .bind(input.videoId, v(input.videoUrl), v(input.privacy), v(input.style), v(input.jobId), now, req.id)
    .run()

  const record: PlaylistAdditionRecord = {
    t: new Date().toISOString(),
    // A recreation is a swap, like a recheck that finds a better recording: the old id rides along.
    status: replacing ? 'replaced' : 'added',
    ...(replacing ? { previousVideoId: oldVideoId } : {}),
    slug: req.slug,
    artistName: req.artistName,
    setUrl: req.setUrl,
    videoId: input.videoId,
    videoUrl: input.videoUrl ?? `https://www.youtube.com/watch?v=${input.videoId}`,
    playlistId: playlistId!,
    playlistTitle,
    combinedStatus,
    via: 'mkvid',
    trigger: replacing ? 'mkvid.recreate' : 'mkvid',
    message:
      `rendered by mkvid from ${req.source} (${input.privacy ?? 'unlisted'}${input.style ? `, ${input.style}` : ''})${playlistStatus === 'duplicate' ? ' — already in the playlist' : ''}` +
      (replacing ? ` — recreated: ${oldVideoId} removed from the playlists, deletion from YouTube requested` : ''),
    failureCount: null,
    meta: { ms: null },
  }
  await flushPlaylistAdditions(env, [record], log)
  log.info('mkvid.completed', { id: req.id, slug: req.slug, setUrl: req.setUrl, videoId: input.videoId, playlistId, playlistStatus, combinedStatus, privacy: input.privacy ?? null, style: input.style ?? null, replacedVideoId: replacing ? oldVideoId : null })
  return { status: 'done', videoId: input.videoId, playlistId: playlistId!, playlistStatus, combinedStatus, ...(replacing && oldVideoId ? { replacedVideoId: oldVideoId } : {}) }
}

export type FailInput = { id: string; error: string; permanent?: boolean; jobId?: string | null }

/**
 * mkvid could not deliver. A permanent failure (the recording is a clip, the
 * source is gone) parks the request as `failed`; anything else goes back to
 * `pending` with a backoff, until MAX_ATTEMPTS claims have been used.
 */
/**
 * Failure reasons this Worker accepts as final without a second look: the
 * incomplete recording and the source-gone answers (the families mkvid's own
 * isPermanentFailure uses). Anything else that would park a request gets
 * UNKNOWN_FAILURE_GRACE retries first.
 */
export const KNOWN_PERMANENT_RE = /incomplete_recording|unsupported url|not available|is private|private (?:track|video)|removed|does not exist|\b404\b|geo[- ]?restricted|no video formats/i
export const UNKNOWN_FAILURE_GRACE = 3

/** mkvid gave a claim back (nothing uploaded): its latest log row stops counting. */
async function refundLatestClaim(env: Env, requestId: string, now: number): Promise<void> {
  await dbOf(env)
    .prepare('UPDATE mkvid_claims SET refunded_at = ? WHERE id = (SELECT MAX(id) FROM mkvid_claims WHERE request_id = ? AND refunded_at IS NULL)')
    .bind(now, requestId)
    .run()
}

export async function failMkvidRequest(env: Env, input: FailInput, log: Logger): Promise<{ status: MkvidStatus; attempts: number } | null> {
  const req = await getMkvidRequest(env, input.id)
  if (!req) return null
  if (req.status === 'done' || req.status === 'superseded') return { status: req.status, attempts: req.attempts }
  // A late report for a job the request has moved on from (its video was
  // unpublished, which leaves job_id = 'unpublished'): nothing to refund or
  // count. A NULL job_id (mkvid had not said its job yet) is not "moved on".
  if (req.status === 'pending' && input.jobId && req.jobId !== null && req.jobId !== input.jobId) return { status: req.status, attempts: req.attempts }
  const now = nowSeconds()
  // Banned while it rendered: a failure report never lifts the ban.
  if (req.status === 'banned') {
    await refundLatestClaim(env, req.id, now)
    return { status: 'banned', attempts: req.attempts }
  }
  // mkvid refused before downloading because the list it was handed is not
  // verified (a race with a re-fetch, or tracked and mkvid disagreeing): back
  // to pending without using an attempt; the claim gate decides when it is ready.
  const app = (await getAppSettings(env)).mkvid
  if (/^unverified_tracklist\b/.test(input.error)) {
    await dbOf(env)
      .prepare(
        "UPDATE mkvid_requests SET status = 'pending', attempts = MAX(0, attempts - 1), claimed_at = NULL, not_before = ?, error = ?, job_id = COALESCE(?, job_id), updated_at = ? WHERE id = ?",
      )
      .bind(now + app.unverifiedRetryMinutes * 60, input.error.slice(0, 500), v(input.jobId), now, req.id)
      .run()
    await refundLatestClaim(env, req.id, now)
    log.warn('mkvid.refused_unverified', { id: req.id, slug: req.slug, setUrl: req.setUrl, error: input.error.slice(0, 200) })
    return { status: 'pending', attempts: Math.max(0, req.attempts - 1) }
  }
  // Nothing was uploaded: the claim stops counting against today's cap.
  await refundLatestClaim(env, req.id, now)
  // A failure that would park the request (permanent, or out of attempts) for
  // a reason this Worker does not recognise as final (a newer mkvid, a new
  // error text) is not believed at once: back to pending with a backoff and
  // no attempt used, the first UNKNOWN_FAILURE_GRACE times.
  const wouldPark = !!input.permanent || req.attempts >= app.maxAttempts
  const unknownFailures = Number(
    (await dbOf(env).prepare('SELECT unknown_failures AS n FROM mkvid_requests WHERE id = ?').bind(req.id).first<{ n: number }>())?.n ?? 0,
  )
  if (wouldPark && !KNOWN_PERMANENT_RE.test(input.error) && unknownFailures < UNKNOWN_FAILURE_GRACE) {
    const notBefore = now + Math.round(app.retryBackoffHours * 3600) * (unknownFailures + 1)
    await dbOf(env)
      .prepare(
        "UPDATE mkvid_requests SET status = 'pending', attempts = MAX(0, attempts - 1), unknown_failures = unknown_failures + 1, claimed_at = NULL, not_before = ?, error = ?, job_id = COALESCE(?, job_id), updated_at = ? WHERE id = ?",
      )
      .bind(notBefore, input.error.slice(0, 500), v(input.jobId), now, req.id)
      .run()
    log.warn('mkvid.failed_unknown_reason', { id: req.id, slug: req.slug, setUrl: req.setUrl, unknownFailures: unknownFailures + 1, permanent: !!input.permanent, error: input.error.slice(0, 200) })
    return { status: 'pending', attempts: Math.max(0, req.attempts - 1) }
  }
  const exhausted = req.attempts >= app.maxAttempts
  const status: MkvidStatus = input.permanent || exhausted ? 'failed' : 'pending'
  const notBefore = status === 'pending' ? now + Math.round(app.retryBackoffHours * 3600) * Math.max(1, req.attempts) : null
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
  const db = dbOf(env)
  const before = await db.prepare("SELECT id, replaces_video_id FROM mkvid_requests WHERE set_url = ? AND status IN ('pending', 'claimed')").bind(setUrl).first<{ id: string; replaces_video_id: string | null }>()
  const r = await db
    .prepare("UPDATE mkvid_requests SET status = 'superseded', error = ?, updated_at = ? WHERE set_url = ? AND status IN ('pending', 'claimed')")
    .bind(`1001tracklists now has ${videoId}`, nowSeconds(), setUrl)
    .run()
  // A recreation under way: the old mkvid video (the sync's swap took it out of the playlists) still gets deleted.
  if ((r.meta.changes ?? 0) > 0 && before?.replaces_video_id) await queueSupersededOldVideo(env, before.id, videoId)
  return (r.meta.changes ?? 0) > 0
}

/**
 * Display only: the stored name carries 1001tracklists' "Tracklists By" H1
 * prefix, and the artist playlists are titled (and found again) by it.
 */
function artistLabel(artistName: string | null, slug: string): string {
  return (artistName ?? slug).replace(/^Tracklists By\s+/i, '')
}

/** Read the JSON `summary`-like fields the panel needs without the full row noise. */
export function requestSummary(r: MkvidRequest): Record<string, unknown> {
  return {
    ...r,
    sourceLabel: r.source === 'soundcloud' ? 'SoundCloud' : 'hearthis.at',
    artistLabel: artistLabel(r.artistName, r.slug),
    accountLabel: MKVID_ACCOUNT_LABELS[r.account],
    /** A video made with a style other than the current one (unknown counts): "Recreate all old-style videos" takes it. */
    oldStyle: !!r.videoId && isOldStyle(r.style),
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
  const raw = title.trim()
  if (!raw) return null
  // Uploads made before 2026-10-01 carry raw entities in their YouTube title
  // ("Gek&auml;"), cut at 100 characters of the RAW text; set_title is stored
  // decoded ("Gekä") since then. Compare decoded text, and when the raw title
  // is at YouTube's 100-character cut, as a prefix (a cut can split an entity:
  // drop that tail).
  const cut = raw.length >= 95 && raw.length <= 100 // at the cut (a trailing space there is trimmed); YouTube titles never exceed 100
  const needle = decodeEntities(cut ? raw.replace(/&[#a-z0-9]*$/i, '') : raw).trim()
  if (!needle) return null
  const like = needle.replace(/[\\%_]/g, (c) => '\\' + c) + '%'
  const row = await dbOf(env)
    .prepare(
      `SELECT slug, set_url, set_title, video_id FROM mkvid_requests
       WHERE video_id IS NOT NULL AND set_title IS NOT NULL AND (status IN ('done', 'superseded') OR replaces_video_id IS NOT NULL)
         AND (lower(substr(trim(set_title), 1, 100)) = lower(?1) OR lower(substr(trim(set_title), 1, 100)) = lower(?4)
              OR (?2 = 1 AND trim(set_title) LIKE ?3 ESCAPE '\\'))
       ORDER BY (lower(substr(trim(set_title), 1, 100)) IN (lower(?1), lower(?4))) DESC, updated_at DESC LIMIT 1`,
    )
    .bind(needle, cut ? 1 : 0, like, raw)
    .first<{ slug: string; set_url: string; set_title: string; video_id: string }>()
  return row ? { videoId: row.video_id, setUrl: row.set_url, setTitle: row.set_title, slug: row.slug } : null
}
