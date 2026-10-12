/**
 * The reorder pass: puts every managed playlist (each artist playlist and the
 * combined one) in the order lib/playlist-order.ts defines, a few moves at a
 * time. It is both the one-off backfill of playlists filled before ordering
 * existed and the upkeep afterwards (an insert that had to be appended, a
 * video the owner dragged).
 *
 * **Why a cron pass and not a script.** A move is `playlistItems.update`, 50
 * units, and the roughly 2 000 moves the first backfill needs are ten times a
 * whole day's quota: the job has to run for weeks next to the sync, the
 * combined backfill and mkvid's deliveries, all on the same 10 000 units. The
 * OAuth client secret and the refresh token only exist in the Worker, and so
 * does the knowledge of what else spent quota today. So it rides the 5-minute
 * cron like the combined backfill, with its own daily unit budget.
 *
 * **Resumable and idempotent.** Nothing about progress is trusted from one
 * run to the next. A run reads the playlist's actual order from YouTube
 * (1 unit per 50 entries), plans the fewest moves from that (`planMoves`),
 * applies as many as its limits allow, in plan order, and stops. A plan cut
 * short leaves a playlist that needs exactly the remaining moves, so a run
 * killed anywhere, a day's budget running out, or the owner reordering by
 * hand in between only changes what the next run finds. A sorted playlist
 * plans zero moves: running it again does nothing.
 *
 * **Limits.** `playlists.orderDailyUnits` (default 2 000, 0 = paused) is
 * everything the pass may spend in a quota day (midnight Pacific), listings
 * included and failed moves too (YouTube charges for those).
 * `playlists.orderMovesPerRun` (default 10) and a wall-clock ceiling bound
 * one run. A quota reply stops the pass until the quota day rolls over: it is
 * the one helper `stoppedByQuota` below.
 *
 * **Order of work.** Playlists never read first (reading is what the dry run
 * needs), then artist playlists with moves left, fewest first, so whole
 * playlists finish early, then artist playlists due their daily look, and the
 * combined playlist last: it is the one for shuffling and half of all the moves.
 *
 * The dry run is `orderReport(env, { fresh: true })`: it reads and plans
 * exactly as a run does and moves nothing.
 */

import type { Env } from '../types'
import { getAppSettings } from './app-settings'
import { loadCombinedState, COMBINED_PLAYLIST_TITLE } from './combined-playlist'
import { dbOf } from './db'
import { getAccessToken } from './google-oauth'
import { errorFields, type Logger } from './log'
import { quotaDayEnd, quotaDayStart } from './mkvid'
import { estimateDays, listUnits, planMoves, UNDATED, UNITS_PER_MOVE, type Move, type OrderKey, type OrderNeed } from './playlist-order'
import { loadOrderKeys, type OrderKeys } from './playlist-order-store'
import { isQuotaError, listPlaylistItems, movePlaylistItem, PlaylistNotFoundError, YouTubeApiError } from './youtube-playlists'

/**
 * A quota-exceeded reply (403 `quotaExceeded` and its siblings): nothing else
 * will succeed today. The only place this file decides that, so a change to
 * how YouTube errors are represented is reconciled here.
 */
export function stoppedByQuota(e: unknown): boolean {
  return isQuotaError(e)
}

/** Durable, in SUBS next to the combined playlist's pointer. */
const ORDER_STATE_KEY = 'subs:playlist-order'
/** Units spent per quota day, in CACHE (a rolling budget, not state). */
const DAILY_UNITS_PREFIX = 'yt:order:units:'
const DAILY_UNITS_TTL = 60 * 60 * 48
/** A playlist with nothing left to move is looked at again this often; so is one only the owner can fix. */
const RECHECK_SECONDS = 24 * 60 * 60
/** A playlist that could not be read, or refused a move, is left alone this long (a refused move costs 50 units). */
const PROBLEM_RETRY_SECONDS = 60 * 60
/** Wall-clock ceiling of one cron pass, on top of whatever the tick already spent. */
const PASS_DEADLINE_MS = 10_000
/** Playlists read in one cron pass at most (each is one listing; the moves are bounded separately). */
const MAX_PLAYLISTS_PER_PASS = 6

const nowSeconds = () => Math.floor(Date.now() / 1000)

export type ManagedPlaylist = { playlistId: string; kind: 'artist' | 'combined'; slug: string | null; title: string }

/**
 * What the last reading of a playlist found. `problem`:
 *   - `manual_sort`  YouTube refuses positions: the playlist is set to sort by
 *                    date or popularity. Only the owner can change that.
 *   - `unreadable`   the playlist is gone or could not be listed; the sync
 *                    re-resolves it, nothing for the owner to do.
 *   - `move_failed`  a move was refused for another reason; tried again next run.
 */
export type OrderPlaylistState = ManagedPlaylist &
  OrderNeed & {
    /** Unix seconds of the reading these numbers are from. */
    checkedAt: number
    /** Moves made on this playlist since ordering began. */
    moved: number
    problem?: 'manual_sort' | 'unreadable' | 'move_failed' | null
    detail?: string | null
  }

export type OrderStop = 'paused' | 'not_connected' | 'quota' | 'budget' | 'run' | 'deadline' | null

export type OrderState = {
  playlists: Record<string, OrderPlaylistState>
  /** Unix seconds of the quota reply that stopped the pass; nothing is tried again before that quota day ends. */
  quotaStoppedAt?: number | null
  lastRun?: { at: number; trigger: string | null; read: number; moved: number; units: number; stoppedBy: OrderStop } | null
}

export async function loadOrderState(env: Env): Promise<OrderState> {
  const s = (await env.SUBS.get(ORDER_STATE_KEY, 'json')) as OrderState | null
  return s && typeof s === 'object' && s.playlists ? s : { playlists: {} }
}

async function saveOrderState(env: Env, state: OrderState): Promise<void> {
  await env.SUBS.put(ORDER_STATE_KEY, JSON.stringify(state))
}

function dailyKey(nowMs = Date.now()): string {
  return `${DAILY_UNITS_PREFIX}${quotaDayStart(nowMs)}`
}

export async function orderUnitsUsedToday(env: Env): Promise<number> {
  const n = Number.parseInt((await env.CACHE.get(dailyKey())) ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Read-modify-write like the combined playlist's counter: the crons do not overlap, and a lost bump is a few units. */
async function chargeUnits(env: Env, units: number): Promise<void> {
  if (units <= 0) return
  await env.CACHE.put(dailyKey(), String((await orderUnitsUsedToday(env)) + units), { expirationTtl: DAILY_UNITS_TTL })
}

/** Every playlist tracked fills with sets: one per DJ (`sub_sync`, unsubscribed DJs included, their playlist stays) and the combined one. */
export async function managedPlaylists(env: Env): Promise<ManagedPlaylist[]> {
  const res = await dbOf(env)
    .prepare('SELECT slug, playlist_id, artist_name FROM sub_sync WHERE playlist_id IS NOT NULL ORDER BY slug')
    .all<{ slug: string; playlist_id: string; artist_name: string | null }>()
  const out: ManagedPlaylist[] = res.results.map((r) => ({ playlistId: r.playlist_id, kind: 'artist', slug: r.slug, title: `${r.artist_name ?? r.slug} (1001tklists)` }))
  const combined = (await loadCombinedState(env)).playlistId
  if (combined && !out.some((p) => p.playlistId === combined)) out.push({ playlistId: combined, kind: 'combined', slug: null, title: COMBINED_PLAYLIST_TITLE })
  return out
}

type Entry = { id: string; videoId: string; key: OrderKey }

/**
 * The playlist's entries in the order YouTube has them (by `snippet.position`,
 * not by the order of the response). An entry without an item id or a video
 * id cannot be moved and makes every index uncertain, so the reading is refused.
 */
export async function readPlaylistOrder(
  playlistId: string,
  keys: OrderKeys,
  accessToken: string,
  fetcher?: typeof fetch,
): Promise<{ entries: Entry[]; pages: number }> {
  const r = await listPlaylistItems(playlistId, accessToken, {}, fetcher)
  const raw = r.items.map((it, i) => ({
    id: it.id,
    videoId: it.contentDetails?.videoId || it.snippet?.resourceId?.videoId,
    position: typeof (it.snippet as { position?: unknown } | undefined)?.position === 'number' ? ((it.snippet as { position: number }).position) : i,
    i,
  }))
  if (raw.some((e) => !e.id || !e.videoId)) throw new Error('listing has an entry without an id')
  raw.sort((a, b) => a.position - b.position || a.i - b.i)
  return { entries: raw.map((e) => ({ id: e.id!, videoId: e.videoId!, key: keys.get(e.videoId!) ?? UNDATED })), pages: r.pages }
}

function needOf(entries: Entry[], moves: Move[]): OrderNeed {
  return { items: entries.length, undated: entries.filter((e) => e.key.date === null).length, moves: moves.length, units: moves.length * UNITS_PER_MOVE }
}

/** Which playlists a pass looks at, in order (see the file comment). */
export function orderQueue(playlists: ManagedPlaylist[], state: OrderState, now: number): ManagedPlaylist[] {
  const rank = (p: ManagedPlaylist): [number, number] | null => {
    const s = state.playlists[p.playlistId]
    if (!s) return [0, 0]
    const stale = now - s.checkedAt >= RECHECK_SECONDS
    // A playlist with a problem waits (a day when only the owner can fix it), it is not tried every tick.
    if (s.problem) return (s.problem === 'manual_sort' ? stale : now - s.checkedAt >= PROBLEM_RETRY_SECONDS) ? [p.kind === 'artist' ? 2 : 3, s.checkedAt] : null
    if (s.moves > 0) return p.kind === 'artist' ? [1, s.moves] : [3, s.checkedAt]
    return stale ? [p.kind === 'artist' ? 2 : 3, s.checkedAt] : null
  }
  return playlists
    .map((p) => ({ p, r: rank(p) }))
    .filter((x): x is { p: ManagedPlaylist; r: [number, number] } => x.r !== null)
    .sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || (a.p.playlistId < b.p.playlistId ? -1 : 1))
    .map((x) => x.p)
}

export type OrderPassResult = {
  ok: true
  /** Playlists read this run. */
  read: number
  moved: number
  /** Units this run spent: listings and moves. */
  units: number
  stoppedBy: OrderStop
  unitsUsedToday: number
  dailyUnits: number
}

/**
 * One bounded pass. Never throws for a YouTube or D1 failure it can name; a
 * quota reply ends it and is remembered for the rest of the quota day.
 */
export async function runOrderPass(
  env: Env,
  opts: { log: Logger; trigger?: string; fetcher?: typeof fetch; deadlineMs?: number; accessToken?: string },
): Promise<OrderPassResult> {
  const log = opts.log
  const settings = (await getAppSettings(env)).playlists
  const dailyUnits = settings.orderDailyUnits
  const used = await orderUnitsUsedToday(env)
  const done = (stoppedBy: OrderStop, read = 0, moved = 0, units = 0): OrderPassResult => ({ ok: true, read, moved, units, stoppedBy, unitsUsedToday: used + units, dailyUnits })
  if (dailyUnits <= 0) return done('paused')
  const state = await loadOrderState(env)
  if (state.quotaStoppedAt && state.quotaStoppedAt >= quotaDayStart()) return done('quota')
  // Not worth a listing when what is left cannot pay for one move.
  if (dailyUnits - used < UNITS_PER_MOVE + 1) return done('budget')

  const now = nowSeconds()
  const queue = orderQueue(await managedPlaylists(env), state, now)
  if (queue.length === 0) return done(null)
  const accessToken = opts.accessToken ?? (await getAccessToken(env))?.accessToken
  if (!accessToken) return done('not_connected')

  const deadline = Date.now() + (opts.deadlineMs ?? PASS_DEADLINE_MS)
  let units = 0
  let moved = 0
  let read = 0
  let stoppedBy: OrderStop = null
  let keys: OrderKeys | null = null
  const left = () => dailyUnits - used - units

  for (const p of queue) {
    if (read >= MAX_PLAYLISTS_PER_PASS) break
    if (Date.now() >= deadline) {
      stoppedBy = 'deadline'
      break
    }
    const before = state.playlists[p.playlistId]
    // A listing of the size last seen, and at least one move after it, must fit in what is left.
    if (left() < listUnits(before?.items ?? 0) + (before && before.moves === 0 ? 0 : UNITS_PER_MOVE)) {
      stoppedBy = 'budget'
      break
    }
    const next: OrderPlaylistState = { ...p, items: before?.items ?? 0, undated: before?.undated ?? 0, moves: before?.moves ?? 0, units: before?.units ?? 0, checkedAt: now, moved: before?.moved ?? 0, problem: null, detail: null }
    state.playlists[p.playlistId] = next
    let entries: Entry[]
    try {
      keys ??= await loadOrderKeys(env)
      const r = await readPlaylistOrder(p.playlistId, keys, accessToken, opts.fetcher)
      entries = r.entries
      units += r.pages
      read += 1
    } catch (e) {
      // A listing that failed part-way still cost its first page.
      units += 1
      if (stoppedByQuota(e)) {
        stoppedBy = 'quota'
        break
      }
      next.problem = 'unreadable'
      next.detail = e instanceof PlaylistNotFoundError ? 'playlist not found on YouTube' : (errorFields(e).errorMessage as string | undefined) ?? String(e)
      log.warn('playlist_order.unreadable', { playlistId: p.playlistId, slug: p.slug, ...errorFields(e) })
      continue
    }
    const plan = planMoves(entries)
    Object.assign(next, needOf(entries, plan.moves))
    const videoOf = new Map(entries.map((e) => [e.id, e.videoId]))
    let applied = 0
    for (const m of plan.moves) {
      if (moved >= settings.orderMovesPerRun) {
        stoppedBy = 'run'
        break
      }
      if (left() < UNITS_PER_MOVE) {
        stoppedBy = 'budget'
        break
      }
      if (Date.now() >= deadline) {
        stoppedBy = 'deadline'
        break
      }
      // Charged before the call: a move YouTube refuses costs the same 50 units.
      units += UNITS_PER_MOVE
      try {
        await movePlaylistItem({ itemId: m.id, playlistId: p.playlistId, videoId: videoOf.get(m.id)! }, m.position, accessToken, opts.fetcher)
      } catch (e) {
        if (stoppedByQuota(e)) {
          stoppedBy = 'quota'
          break
        }
        // Every later move of the plan assumed this one happened: the next run plans afresh.
        const manual = e instanceof YouTubeApiError && e.status === 400 && e.reason === 'manualSortRequired'
        next.problem = manual ? 'manual_sort' : 'move_failed'
        next.detail = manual ? 'the playlist is not on manual order' : (errorFields(e).errorMessage as string | undefined) ?? String(e)
        log.warn('playlist_order.move_failed', { playlistId: p.playlistId, slug: p.slug, itemId: m.id, position: m.position, ...errorFields(e) })
        break
      }
      applied += 1
      moved += 1
    }
    next.moves = plan.moves.length - applied
    next.units = next.moves * UNITS_PER_MOVE
    next.moved += applied
    if (applied > 0) log.info('playlist_order.moved', { playlistId: p.playlistId, slug: p.slug, moved: applied, left: next.moves })
    if (stoppedBy) break
  }

  if (stoppedBy === 'quota') state.quotaStoppedAt = now
  state.lastRun = { at: now, trigger: opts.trigger ?? null, read, moved, units, stoppedBy }
  try {
    await chargeUnits(env, units)
    await saveOrderState(env, state)
  } catch (e) {
    // The playlists themselves hold the progress; a lost write costs a re-read.
    log.warn('playlist_order.state_write_failed', errorFields(e))
  }
  return done(stoppedBy, read, moved, units)
}

// ─── the dry run / status ───────────────────────────────────────────────────

export type OrderReport = {
  connected: boolean
  /** True when every number below was read from YouTube just now (`fresh`); else each row says when it was read. */
  fresh: boolean
  /** Units the fresh reading itself spent (listings only; a dry run never moves). */
  unitsSpent: number
  playlists: Array<OrderPlaylistState | (ManagedPlaylist & { checkedAt: null })>
  totals: OrderNeed & { playlists: number; unread: number }
  dailyUnits: number
  movesPerRun: number
  unitsUsedToday: number
  /** Units still to spend, listings of the runs included, and the days that takes at `dailyUnits` (null = paused or never). */
  estimate: { units: number; days: number | null }
  /** Set while a quota reply holds the pass back: unix seconds the quota day ends. */
  quotaStoppedUntil: number | null
  lastRun: OrderState['lastRun']
}

/**
 * Per playlist: entries, entries with no date, moves needed, units needed;
 * totals; and the days left at the current budget. With `fresh` every playlist
 * is read from YouTube now (about 50 units for 2 200 entries) and the stored
 * numbers are replaced; nothing is moved either way. A fresh reading stops at
 * a quota reply and reports what it has.
 */
export async function orderReport(env: Env, opts: { log: Logger; fresh?: boolean; fetcher?: typeof fetch; accessToken?: string }): Promise<OrderReport> {
  const settings = (await getAppSettings(env)).playlists
  const state = await loadOrderState(env)
  const managed = await managedPlaylists(env)
  const accessToken = opts.accessToken ?? (await getAccessToken(env))?.accessToken ?? null
  let unitsSpent = 0
  let fresh = false
  if (opts.fresh && accessToken) {
    fresh = true
    const now = nowSeconds()
    const keys = await loadOrderKeys(env)
    for (const p of managed) {
      const before = state.playlists[p.playlistId]
      const next: OrderPlaylistState = { ...p, items: before?.items ?? 0, undated: before?.undated ?? 0, moves: before?.moves ?? 0, units: before?.units ?? 0, checkedAt: now, moved: before?.moved ?? 0, problem: before?.problem === 'manual_sort' ? 'manual_sort' : null, detail: before?.problem === 'manual_sort' ? before.detail : null }
      try {
        const r = await readPlaylistOrder(p.playlistId, keys, accessToken, opts.fetcher)
        unitsSpent += r.pages
        Object.assign(next, needOf(r.entries, planMoves(r.entries).moves))
      } catch (e) {
        unitsSpent += 1
        if (stoppedByQuota(e)) {
          state.quotaStoppedAt = now
          fresh = false
          break
        }
        next.problem = 'unreadable'
        next.detail = e instanceof PlaylistNotFoundError ? 'playlist not found on YouTube' : (errorFields(e).errorMessage as string | undefined) ?? String(e)
      }
      state.playlists[p.playlistId] = next
    }
    try {
      await chargeUnits(env, unitsSpent)
      await saveOrderState(env, state)
    } catch (e) {
      opts.log.warn('playlist_order.state_write_failed', errorFields(e))
    }
  }
  const rows = managed.map((p) => state.playlists[p.playlistId] ?? { ...p, checkedAt: null })
  const read = rows.filter((r): r is OrderPlaylistState => r.checkedAt !== null)
  const sum = (f: (r: OrderPlaylistState) => number) => read.reduce((a, r) => a + f(r), 0)
  const est = estimateDays(read, settings.orderDailyUnits, settings.orderMovesPerRun)
  const quotaHeld = !!state.quotaStoppedAt && state.quotaStoppedAt >= quotaDayStart()
  return {
    connected: !!accessToken,
    fresh,
    unitsSpent,
    playlists: rows,
    totals: { playlists: rows.length, unread: rows.length - read.length, items: sum((r) => r.items), undated: sum((r) => r.undated), moves: sum((r) => r.moves), units: sum((r) => r.units) },
    dailyUnits: settings.orderDailyUnits,
    movesPerRun: settings.orderMovesPerRun,
    unitsUsedToday: await orderUnitsUsedToday(env),
    estimate: { units: est.units, days: Number.isFinite(est.days) ? est.days : null },
    quotaStoppedUntil: quotaHeld ? quotaDayEnd() : null,
    lastRun: state.lastRun ?? null,
  }
}
