/**
 * The combined playlist: one YouTube playlist that holds **every** video from
 * **every** tracked artist, alongside the per-artist playlists the sync
 * already maintains.
 *
 * Two paths keep it filled, and they cover different halves of the problem:
 *
 *   1. **Live mirror** (lib/sync.ts) — whenever the sync resolves a set to a
 *      video id it mirrors that video into the combined playlist in the same
 *      pass. This is what keeps newly-published sets flowing in.
 *   2. **Backfill** (`mergeIntoCombinedPlaylist` here) — the combined playlist
 *      is defined as the union of every artist playlist, so this walks those
 *      playlists and inserts whatever the combined one is missing. That is the
 *      only path that can cover:
 *        - sets added to artist playlists *before* this feature existed (the
 *          sync never revisits a tracklist it has already processed, so the
 *          live mirror alone would never see them), and
 *        - a **newly added artist**, whose own backfill fills its artist
 *          playlist over several cron ticks — every one of those videos flows
 *          into the combined playlist from here.
 *      It also self-heals anything the live mirror dropped (quota blip, an
 *      insert that failed mid-run), which is why the live mirror is allowed to
 *      fail without failing its sync.
 *
 * **Quota contract.** `playlistItems.insert` costs 50 units against a 10 000
 * unit/day project quota — 200 inserts/day, total, for the whole worker. The
 * per-artist sync already spends most of that on new sets, so the backfill
 * takes a bounded slice: at most `MAX_INSERTS_PER_RUN` per run, and it stops
 * once the day's combined-playlist inserts reach `COMBINED_DAILY_INSERT_CAP`
 * (counted in KV, UTC days). A first backfill of a few hundred videos
 * therefore spreads over a few days of cron ticks rather than burning the
 * day's quota in one sweep and starving the per-artist sync.
 *
 * The live mirror is deliberately *not* capped — new sets are few, and getting
 * them in immediately is the point — but its inserts count against the same
 * daily total, so the backfill yields to them rather than competing.
 */

import type { Env } from '../types'
import { getCachedPlaylistVideoIds, cachePlaylistVideoIds, findOrCreatePlaylist } from './playlist-cache'
import { addVideoToPlaylist, PlaylistNotFoundError } from './youtube-playlists'
import { errorFields, type Logger } from './log'

export const COMBINED_PLAYLIST_TITLE = 'All tracked artists (1001tklists)'
export const COMBINED_PLAYLIST_DESCRIPTION =
  'Every set with a YouTube recording on 1001tracklists, across every DJ tracked by this app. Updated automatically.'

/** Durable pointer to the playlist, in SUBS (no TTL) next to the per-sub state. */
const COMBINED_STATE_KEY = 'subs:combined'
/** Per-UTC-day insert counter, in CACHE (TTL'd — it's a rolling budget, not state). */
const DAILY_INSERTS_PREFIX = 'yt:combined:inserts:'
const DAILY_INSERTS_TTL = 60 * 60 * 48

/**
 * Max combined-playlist inserts per UTC day, across every trigger. 80 × 50
 * units = 4 000 of the 10 000/day project quota, leaving the per-artist sync
 * the 6 000 it was already sized against (30 sets × 4 subs).
 */
export const COMBINED_DAILY_INSERT_CAP = 80
/**
 * Max inserts in a single backfill run. Keeps one cron tick's wall clock and
 * quota bounded; the every-5-min cron picks the rest up on the next tick.
 */
const MAX_INSERTS_PER_RUN = 20
/** Wall-clock ceiling for a backfill run, on top of whatever the sync spent. */
const BACKFILL_DEADLINE_MS = 10_000

export type CombinedState = {
  playlistId?: string
  /** Unix seconds of the last backfill run that got as far as resolving the playlist. */
  lastBackfillAt?: number
  lastBackfillStats?: {
    sourcesRead: number
    missingTotal: number
    inserted: number
    failed: number
    pending: number
    cappedBy: CappedBy
  }
}

/** Why a backfill stopped inserting. `null` = it drained everything it found. */
export type CappedBy = 'run' | 'daily' | 'deadline' | null

/** One artist playlist feeding the combined one. */
export type PlaylistSource = {
  slug: string
  artistName: string | null
  playlistId: string
}

/**
 * An open combined playlist: its id plus the video ids currently in it.
 * Mutable — inserts update `videoIds`, and stale-playlist recovery swaps
 * `playlistId` mid-run — so a caller holding one across many inserts keeps
 * seeing the truth. Flush it with `flushCombined` when the run is done.
 */
export type CombinedHandle = {
  playlistId: string
  videoIds: Set<string>
  /** Inserts performed against this handle since it was opened. */
  inserted: number
}

export async function loadCombinedState(env: Env): Promise<CombinedState> {
  return ((await env.SUBS.get(COMBINED_STATE_KEY, 'json')) as CombinedState | null) ?? {}
}

export async function saveCombinedState(env: Env, state: CombinedState): Promise<void> {
  await env.SUBS.put(COMBINED_STATE_KEY, JSON.stringify(state))
}

/**
 * Resolve the combined playlist and load its current contents.
 *
 * Mirrors the per-artist cascade in lib/sync.ts: cached id from state → lookup
 * by title → create. Returns null only when `create: false` and no playlist
 * with that title exists yet (the read-only status path).
 */
export async function openCombinedPlaylist(
  env: Env,
  accessToken: string,
  log: Logger,
  opts: { create?: boolean } = {},
): Promise<CombinedHandle | null> {
  const state = await loadCombinedState(env)
  let playlistId = state.playlistId
  let justCreated = false
  if (!playlistId) {
    const r = await resolveCombinedPlaylist(accessToken, log, opts.create)
    if (!r) return null
    playlistId = r.id
    justCreated = r.justCreated
    await saveCombinedState(env, { ...state, playlistId })
  }

  if (justCreated) {
    // Freshly created → known empty, and YouTube's read API can't see it yet.
    const videoIds = new Set<string>()
    await cachePlaylistVideoIds(env, playlistId, videoIds)
    return { playlistId, videoIds, inserted: 0 }
  }
  try {
    return { playlistId, videoIds: await getCachedPlaylistVideoIds(env, playlistId, accessToken, log), inserted: 0 }
  } catch (e) {
    if (!(e instanceof PlaylistNotFoundError)) throw e
    // The user deleted the playlist after we cached its id. Re-resolve.
    log.warn('combined.playlist_stale', { stalePlaylistId: playlistId })
    const r = await resolveCombinedPlaylist(accessToken, log, opts.create)
    if (!r) return null
    await saveCombinedState(env, { ...state, playlistId: r.id })
    const videoIds = r.justCreated ? new Set<string>() : await getCachedPlaylistVideoIds(env, r.id, accessToken, log)
    if (r.justCreated) await cachePlaylistVideoIds(env, r.id, videoIds)
    return { playlistId: r.id, videoIds, inserted: 0 }
  }
}

function resolveCombinedPlaylist(accessToken: string, log: Logger, create?: boolean) {
  return findOrCreatePlaylist(
    {
      title: COMBINED_PLAYLIST_TITLE,
      description: COMBINED_PLAYLIST_DESCRIPTION,
      create,
      logCtx: { combined: true },
    },
    accessToken,
    log,
  )
}

/** What happened to one video on its way into the combined playlist. */
export type CombinedAdditionStatus = 'added' | 'duplicate' | 'failed' | 'unavailable'

/**
 * Insert one video, unless the playlist already has it. Throws on a YouTube
 * error the caller should see; recovers once from a playlist deleted mid-run
 * (same contract as the per-artist insert in lib/sync.ts).
 */
export async function addToCombined(
  env: Env,
  handle: CombinedHandle,
  videoId: string,
  accessToken: string,
  log: Logger,
): Promise<'added' | 'duplicate'> {
  if (handle.videoIds.has(videoId)) return 'duplicate'
  try {
    await addVideoToPlaylist(handle.playlistId, videoId, accessToken)
  } catch (e) {
    if (!(e instanceof PlaylistNotFoundError)) throw e
    log.warn('combined.playlist_stale_midrun', { stalePlaylistId: handle.playlistId })
    const fresh = await openCombinedPlaylist(env, accessToken, log)
    if (!fresh) throw e
    handle.playlistId = fresh.playlistId
    handle.videoIds = fresh.videoIds
    if (handle.videoIds.has(videoId)) return 'duplicate'
    await addVideoToPlaylist(handle.playlistId, videoId, accessToken)
  }
  handle.videoIds.add(videoId)
  handle.inserted += 1
  return 'added'
}

/**
 * Persist a run's effect: write the post-insert video set back to the cache so
 * the next tick doesn't pay quota to re-list it, and charge the inserts
 * against today's budget. No-op when the run inserted nothing — a read-only
 * run shouldn't re-extend a TTL or move the counter.
 */
export async function flushCombined(env: Env, handle: CombinedHandle, log: Logger): Promise<void> {
  if (handle.inserted === 0) return
  try {
    await cachePlaylistVideoIds(env, handle.playlistId, handle.videoIds)
    await bumpDailyInserts(env, handle.inserted)
  } catch (e) {
    // Losing the cache write costs one re-list; losing the counter bump costs
    // a slightly generous budget. Neither is worth failing a sync over.
    log.warn('combined.flush_failed', { playlistId: handle.playlistId, inserted: handle.inserted, ...errorFields(e) })
  }
}

function dailyKey(now = Date.now()): string {
  return `${DAILY_INSERTS_PREFIX}${new Date(now).toISOString().slice(0, 10)}`
}

export async function dailyInsertsUsed(env: Env): Promise<number> {
  const raw = await env.CACHE.get(dailyKey())
  const n = raw ? Number.parseInt(raw, 10) : 0
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * Read-modify-write, which can lose a concurrent increment. Acceptable: this
 * is a single-user app whose two crons don't overlap, and the consequence of a
 * lost bump is at most a few extra inserts against a 200/day ceiling.
 */
async function bumpDailyInserts(env: Env, n: number): Promise<void> {
  const key = dailyKey()
  const current = await dailyInsertsUsed(env)
  await env.CACHE.put(key, String(current + n), { expirationTtl: DAILY_INSERTS_TTL })
}

export type CombinedMergeResult = {
  playlistId: string
  playlistTitle: string
  /** Videos in the combined playlist after this run. */
  videoCount: number
  /** Artist playlists successfully read this run. */
  sourcesRead: number
  /** Artist playlists we couldn't read (deleted playlist, API error). */
  sourcesFailed: number
  /** Videos found in artist playlists but absent from the combined one. */
  missingTotal: number
  inserted: number
  failed: number
  /** Still missing after this run — the next tick picks these up. */
  pending: number
  cappedBy: CappedBy
  dailyInsertsUsed: number
  dailyInsertCap: number
}

/**
 * Fill the combined playlist from the artist playlists: union them, subtract
 * what's already in the combined playlist, insert the difference up to the
 * per-run / per-day / deadline caps.
 *
 * Idempotent and resumable — progress lives entirely in the playlists
 * themselves, so a run killed halfway just means the next one finds fewer
 * missing videos.
 */
export async function mergeIntoCombinedPlaylist(
  env: Env,
  accessToken: string,
  sources: PlaylistSource[],
  opts: { log: Logger; maxInsertsPerRun?: number; deadlineMs?: number; trigger?: string },
): Promise<CombinedMergeResult> {
  const log = opts.log
  const handle = await openCombinedPlaylist(env, accessToken, log)
  // Unreachable — `create` defaults to true, so the resolver either finds or
  // creates. Typed as nullable only for the read-only status path.
  if (!handle) throw new Error('combined playlist could not be resolved')
  const used = await dailyInsertsUsed(env)
  const budget = Math.max(0, COMBINED_DAILY_INSERT_CAP - used)
  const perRun = opts.maxInsertsPerRun ?? MAX_INSERTS_PER_RUN
  const deadline = Date.now() + (opts.deadlineMs ?? BACKFILL_DEADLINE_MS)

  const { missing, sourcesRead, sourcesFailed } = await collectMissing(env, handle, sources, accessToken, log)
  log.info('combined.backfill.start', {
    trigger: opts.trigger ?? null,
    playlistId: handle.playlistId,
    inPlaylist: handle.videoIds.size,
    sourcesRead,
    sourcesFailed,
    missingTotal: missing.length,
    dailyInsertsUsed: used,
    budget,
  })

  let failed = 0
  let cappedBy: CappedBy = null
  for (const m of missing) {
    if (handle.inserted >= perRun) {
      cappedBy = 'run'
      break
    }
    if (handle.inserted >= budget) {
      cappedBy = 'daily'
      break
    }
    if (Date.now() >= deadline) {
      cappedBy = 'deadline'
      break
    }
    try {
      await addToCombined(env, handle, m.videoId, accessToken, log)
      log.info('combined.backfill.added', { videoId: m.videoId, fromSlug: m.slug, playlistId: handle.playlistId })
    } catch (e) {
      failed += 1
      log.warn('combined.backfill.insert_failed', { videoId: m.videoId, fromSlug: m.slug, ...errorFields(e) })
    }
  }
  await flushCombined(env, handle, log)

  const result: CombinedMergeResult = {
    playlistId: handle.playlistId,
    playlistTitle: COMBINED_PLAYLIST_TITLE,
    videoCount: handle.videoIds.size,
    sourcesRead,
    sourcesFailed,
    missingTotal: missing.length,
    inserted: handle.inserted,
    failed,
    pending: Math.max(0, missing.length - handle.inserted),
    cappedBy,
    dailyInsertsUsed: used + handle.inserted,
    dailyInsertCap: COMBINED_DAILY_INSERT_CAP,
  }
  await saveCombinedState(env, {
    ...(await loadCombinedState(env)),
    playlistId: handle.playlistId,
    lastBackfillAt: Math.floor(Date.now() / 1000),
    lastBackfillStats: {
      sourcesRead,
      missingTotal: result.missingTotal,
      inserted: result.inserted,
      failed: result.failed,
      pending: result.pending,
      cappedBy,
    },
  })
  log.info('combined.backfill.done', result as unknown as Record<string, unknown>)
  return result
}

export type CombinedStatus = {
  title: string
  /** null until the first sync or backfill creates the playlist. */
  playlistId: string | null
  playlistUrl: string | null
  videoCount: number
  missingTotal: number
  lastBackfillAt: number | null
  lastBackfillStats: CombinedState['lastBackfillStats'] | null
  dailyInsertsUsed: number
  dailyInsertCap: number
  sources: Array<{ slug: string; artistName: string | null; playlistId: string; videoCount: number | null }>
}

/**
 * Read-only counterpart of the backfill, for the admin panel. Never creates
 * the playlist and never inserts — it only answers "what's in it, and how much
 * is still missing?".
 */
export async function readCombinedStatus(
  env: Env,
  accessToken: string,
  sources: PlaylistSource[],
  log: Logger,
): Promise<CombinedStatus> {
  const state = await loadCombinedState(env)
  const handle = await openCombinedPlaylist(env, accessToken, log, { create: false })
  const base = {
    title: COMBINED_PLAYLIST_TITLE,
    lastBackfillAt: state.lastBackfillAt ?? null,
    lastBackfillStats: state.lastBackfillStats ?? null,
    dailyInsertsUsed: await dailyInsertsUsed(env),
    dailyInsertCap: COMBINED_DAILY_INSERT_CAP,
  }
  // With no playlist yet, everything in every artist playlist is "missing" —
  // that's the number the panel should show before the first backfill.
  const probe: CombinedHandle = handle ?? { playlistId: '', videoIds: new Set(), inserted: 0 }
  const { missing, perSource } = await collectMissing(env, probe, sources, accessToken, log)
  return {
    ...base,
    playlistId: handle?.playlistId ?? null,
    playlistUrl: handle ? playlistUrl(handle.playlistId) : null,
    videoCount: handle?.videoIds.size ?? 0,
    missingTotal: missing.length,
    sources: sources.map((s) => ({
      slug: s.slug,
      artistName: s.artistName,
      playlistId: s.playlistId,
      videoCount: perSource.get(s.slug) ?? null,
    })),
  }
}

export function playlistUrl(playlistId: string): string {
  return `https://www.youtube.com/playlist?list=${playlistId}`
}

/**
 * Union every source playlist and subtract what the combined playlist already
 * has. Source order is preserved so a capped backfill makes deterministic
 * progress rather than re-shuffling the queue each run.
 *
 * A source we can't read (deleted playlist, transient API error) is counted
 * and skipped, never fatal: dropping one artist from this run just means its
 * videos are picked up on the next one.
 */
async function collectMissing(
  env: Env,
  handle: CombinedHandle,
  sources: PlaylistSource[],
  accessToken: string,
  log: Logger,
): Promise<{
  missing: Array<{ videoId: string; slug: string }>
  sourcesRead: number
  sourcesFailed: number
  perSource: Map<string, number>
}> {
  const missing: Array<{ videoId: string; slug: string }> = []
  const queued = new Set<string>()
  const perSource = new Map<string, number>()
  let sourcesRead = 0
  let sourcesFailed = 0
  for (const src of sources) {
    if (src.playlistId === handle.playlistId) continue
    let ids: Set<string>
    try {
      ids = await getCachedPlaylistVideoIds(env, src.playlistId, accessToken, log)
    } catch (e) {
      sourcesFailed += 1
      log.warn('combined.source_unreadable', { slug: src.slug, playlistId: src.playlistId, ...errorFields(e) })
      continue
    }
    sourcesRead += 1
    perSource.set(src.slug, ids.size)
    for (const id of ids) {
      if (handle.videoIds.has(id) || queued.has(id)) continue
      queued.add(id)
      missing.push({ videoId: id, slug: src.slug })
    }
  }
  return { missing, sourcesRead, sourcesFailed, perSource }
}
