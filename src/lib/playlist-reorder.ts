/**
 * The reorder pass: puts every artist playlist in the order
 * lib/playlist-order.ts defines, a few moves at a time. The combined playlist
 * is not ordered, by the owner's decision (it is the one for shuffling and
 * would be half of all the moves): this file never reads, plans or moves it. It is both the one-off backfill of playlists filled before ordering
 * existed and the upkeep afterwards (an insert that had to be appended, a
 * video the owner dragged).
 *
 * **It ships paused.** `playlists.orderDailyUnits` defaults to 0, and at 0 the
 * cron pass returns before any YouTube call, any listing included. The owner
 * starts it by saving a budget on /ui/settings after looking at the dry run.
 * New videos are inserted at their place either way (lib/playlist-order-store.ts).
 *
 * **Why a cron pass and not a script.** A move is `playlistItems.update`, 50
 * units, and the roughly 1 000 moves the first backfill needs are five times a
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
 * **Self-checking.** The plan rests on what a move does: the item ends up at
 * index `position` of the playlist and everything between its old and new
 * place shifts by one. Google documents `snippet.position` as the zero-based
 * place of the item and nothing more, so the pass checks instead of trusting:
 *   - the first move of a run on a playlist is compared with where YouTube
 *     says the item now is (the update's own reply, else one 1-unit lookup of
 *     that item). A different index stops that playlist (`unexpected_position`);
 *   - a run that made 3 or more moves must leave the playlist needing fewer
 *     moves at the next reading than before it. If it does not, the moves are
 *     not doing what the plan thinks and the playlist stops (`no_progress`).
 * Both are shown on the card and tried again a day later, so a wrong
 * assumption costs a handful of moves, not the backfill.
 *
 * **Limits.** `playlists.orderDailyUnits` is everything the pass may spend in
 * a quota day (midnight Pacific), listings included and failed moves too
 * (YouTube charges for those). `playlists.orderMovesPerRun` (default 10) and
 * a wall-clock ceiling bound one run. A daily-quota reply stops the pass
 * until the quota day rolls over; a per-minute rate limit ends the run only.
 * See `quotaStop` and `youtubeQuotaOut` below.
 *
 * **Order of work.** Playlists never read first (reading is what the dry run
 * needs), then playlists with moves left, fewest first, so whole playlists
 * finish early, then playlists due their daily look.
 *
 * The dry run is `orderReport(env, { fresh: true })`: it reads and plans
 * exactly as a run does and moves nothing. It works while the pass is paused.
 */

import type { Env } from '../types'
import { getAppSettings } from './app-settings'
import { dbOf } from './db'
import { getAccessToken } from './google-oauth'
import { errorFields, type Logger } from './log'
import { quotaDayEnd, quotaDayStart } from './mkvid'
import { estimateDays, listUnits, planMoves, UNDATED, UNITS_PER_MOVE, type Move, type OrderKey, type OrderNeed } from './playlist-order'
import { loadOrderKeys, type OrderKeys } from './playlist-order-store'
import { getPlaylistItemPosition, isQuotaError, listPlaylistItems, movePlaylistItem, PlaylistNotFoundError, YouTubeApiError } from './youtube-playlists'

// ─── quota: the two places to reconcile with lib/youtube-error.ts / lib/youtube-quota.ts ───

/**
 * What a failed YouTube call says about quota:
 *   - `daily`  the day's quota is spent (`quotaExceeded`, `dailyLimitExceeded`):
 *              nothing succeeds until midnight Pacific.
 *   - `rate`   a per-minute limit (`rateLimitExceeded`, `userRateLimitExceeded`):
 *              this run ends, the next tick may try again.
 *   - null     not about quota.
 * The only place this file classifies a reply.
 * MERGE: once lib/youtube-error.ts exists this is `quotaKind(e.reason)`
 * ('quota' → 'daily', 'rate_limit' → 'rate') behind the same `isQuotaError` test.
 */
export function quotaStop(e: unknown): 'daily' | 'rate' | null {
  if (!isQuotaError(e)) return null
  const reason = e instanceof YouTubeApiError ? e.reason : null
  return reason === 'quotaExceeded' || reason === 'dailyLimitExceeded' ? 'daily' : 'rate'
}

/**
 * "Is YouTube's daily quota out?" The one call site the pass and the report
 * ask. Today it is this pass's own memory of a daily-quota reply.
 * MERGE: lib/youtube-quota.ts keeps `yt:quota:out` for every writer, set on
 * any daily-quota reply and expiring at `quotaDayEnd()`; read that flag here
 * (and set it in `noteQuotaOut`) and `OrderState.quotaStoppedAt` can go.
 */
async function youtubeQuotaOut(_env: Env, state: OrderState): Promise<boolean> {
  return !!state.quotaStoppedAt && state.quotaStoppedAt >= quotaDayStart()
}

function noteQuotaOut(state: OrderState, now: number): void {
  state.quotaStoppedAt = now
}

// ─── state ──────────────────────────────────────────────────────────────────

/** Durable, in SUBS next to the combined playlist's pointer. */
const ORDER_STATE_KEY = 'subs:playlist-order'
/** Units spent per quota day, in CACHE (a rolling budget, not state). */
const DAILY_UNITS_PREFIX = 'yt:order:units:'
const DAILY_UNITS_TTL = 60 * 60 * 48
/** A playlist with nothing left to move is looked at again this often; so is one that stopped for a reason someone has to look at. */
const RECHECK_SECONDS = 24 * 60 * 60
/** A playlist that could not be read, or refused a move, is left alone this long (a refused move costs 50 units). */
const PROBLEM_RETRY_SECONDS = 60 * 60
/** Wall-clock ceiling of one cron pass, on top of whatever the tick already spent. */
const PASS_DEADLINE_MS = 10_000
/** Playlists read in one cron pass at most (each is one listing; the moves are bounded separately). */
const MAX_PLAYLISTS_PER_PASS = 6
/** A run of at least this many moves must have lowered what the playlist needs by the next reading. */
const PROGRESS_CHECK_MIN_MOVES = 3
/** Budgets the report gives a duration for, so a paused pass still says what each would mean. */
const SAMPLE_DAILY_UNITS = [1000, 2000, 4000]

const nowSeconds = () => Math.floor(Date.now() / 1000)

export type ManagedPlaylist = { playlistId: string; slug: string; title: string }

/**
 * Why a playlist is not being worked on:
 *   - `manual_sort`          YouTube refuses positions: the playlist is set to
 *                            sort by date or popularity. Only the owner can change that.
 *   - `unexpected_position`  a move did not land on the index the plan gave it.
 *   - `no_progress`          a run of moves left the playlist needing no fewer.
 *   - `unreadable`           the playlist is gone or could not be listed; the
 *                            sync re-resolves it, nothing for the owner to do.
 *   - `move_failed`          a move was refused for another reason; tried again.
 * The first three stop the playlist for a day and are the ones to look at.
 */
export type OrderProblem = 'manual_sort' | 'unexpected_position' | 'no_progress' | 'unreadable' | 'move_failed'
const STOPPING: readonly OrderProblem[] = ['manual_sort', 'unexpected_position', 'no_progress']

export type OrderPlaylistState = ManagedPlaylist &
  OrderNeed & {
    /** Unix seconds of the reading these numbers are from. */
    checkedAt: number
    /** Moves made on this playlist since ordering began. */
    moved: number
    problem?: OrderProblem | null
    detail?: string | null
    /** The last run that moved something: what the playlist needed before it and how many moves it made (the progress check). */
    lastRun?: { needed: number; applied: number } | null
  }

export type OrderStop = 'paused' | 'not_connected' | 'quota' | 'rate_limit' | 'budget' | 'run' | 'deadline' | null

export type OrderState = {
  playlists: Record<string, OrderPlaylistState>
  /** Unix seconds of the daily-quota reply that stopped the pass (see `youtubeQuotaOut`). */
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

/** The playlists that are ordered: one per DJ (`sub_sync`, unsubscribed DJs included, their playlist stays). Not the combined one. */
export async function managedPlaylists(env: Env): Promise<ManagedPlaylist[]> {
  const res = await dbOf(env)
    .prepare('SELECT slug, playlist_id, artist_name FROM sub_sync WHERE playlist_id IS NOT NULL ORDER BY slug')
    .all<{ slug: string; playlist_id: string; artist_name: string | null }>()
  return res.results.map((r) => ({ playlistId: r.playlist_id, slug: r.slug, title: `${r.artist_name ?? r.slug} (1001tklists)` }))
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
    // A playlist with a problem waits (a day when someone has to look at it), it is not tried every tick.
    if (s.problem) return (STOPPING.includes(s.problem) ? stale : now - s.checkedAt >= PROBLEM_RETRY_SECONDS) ? [2, s.checkedAt] : null
    if (s.moves > 0) return [1, s.moves]
    return stale ? [2, s.checkedAt] : null
  }
  return playlists
    .map((p) => ({ p, r: rank(p) }))
    .filter((x): x is { p: ManagedPlaylist; r: [number, number] } => x.r !== null)
    .sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || (a.p.playlistId < b.p.playlistId ? -1 : 1))
    .map((x) => x.p)
}

/**
 * Where YouTube says a moved item is now: the update's own reply when it
 * carries a position, else one lookup of that item (`units` = what the lookup
 * cost). Null when neither says.
 */
async function landedAt(
  replied: number | null,
  item: { itemId: string; playlistId: string; videoId: string },
  accessToken: string,
  fetcher?: typeof fetch,
): Promise<{ position: number | null; units: number }> {
  if (replied !== null) return { position: replied, units: 0 }
  try {
    return { position: await getPlaylistItemPosition(item.playlistId, item.videoId, item.itemId, accessToken, fetcher), units: 1 }
  } catch {
    return { position: null, units: 1 }
  }
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
 * daily-quota reply ends it and is remembered for the rest of the quota day.
 * Paused (budget 0) it returns before any YouTube call.
 */
export async function runOrderPass(
  env: Env,
  opts: { log: Logger; trigger?: string; fetcher?: typeof fetch; deadlineMs?: number; accessToken?: string },
): Promise<OrderPassResult> {
  const log = opts.log
  const settings = (await getAppSettings(env)).playlists
  const dailyUnits = settings.orderDailyUnits
  if (dailyUnits <= 0) return { ok: true, read: 0, moved: 0, units: 0, stoppedBy: 'paused', unitsUsedToday: 0, dailyUnits: 0 }
  const used = await orderUnitsUsedToday(env)
  const done = (stoppedBy: OrderStop, read = 0, moved = 0, units = 0): OrderPassResult => ({ ok: true, read, moved, units, stoppedBy, unitsUsedToday: used + units, dailyUnits })
  const state = await loadOrderState(env)
  if (await youtubeQuotaOut(env, state)) return done('quota')
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
  /** A quota reply ends the pass: for the day, or for this run. */
  const passStop = (e: unknown): OrderStop => {
    const q = quotaStop(e)
    return q === 'daily' ? 'quota' : q === 'rate' ? 'rate_limit' : null
  }

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
      stoppedBy = passStop(e)
      if (stoppedBy) break
      state.playlists[p.playlistId] = {
        ...p, items: before?.items ?? 0, undated: before?.undated ?? 0, moves: before?.moves ?? 0, units: before?.units ?? 0, checkedAt: now, moved: before?.moved ?? 0, lastRun: before?.lastRun ?? null,
        problem: 'unreadable',
        detail: e instanceof PlaylistNotFoundError ? 'playlist not found on YouTube' : (errorFields(e).errorMessage as string | undefined) ?? String(e),
      }
      log.warn('playlist_order.unreadable', { playlistId: p.playlistId, slug: p.slug, ...errorFields(e) })
      continue
    }
    const plan = planMoves(entries)
    const next: OrderPlaylistState = { ...p, ...needOf(entries, plan.moves), checkedAt: now, moved: before?.moved ?? 0, problem: null, detail: null, lastRun: null }
    state.playlists[p.playlistId] = next
    // The last run moved videos here and the playlist needs no fewer moves than before it: the moves are not doing what the plan thinks.
    const last = before?.lastRun
    if (last && last.applied >= PROGRESS_CHECK_MIN_MOVES && plan.moves.length >= last.needed) {
      next.problem = 'no_progress'
      next.detail = `${last.applied} moves were made and the playlist still needs ${plan.moves.length} (it needed ${last.needed} before them)`
      log.warn('playlist_order.no_progress', { playlistId: p.playlistId, slug: p.slug, applied: last.applied, neededBefore: last.needed, neededNow: plan.moves.length })
      continue
    }
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
      const item = { itemId: m.id, playlistId: p.playlistId, videoId: videoOf.get(m.id)! }
      // Charged before the call: a move YouTube refuses costs the same 50 units.
      units += UNITS_PER_MOVE
      let replied: number | null
      try {
        replied = await movePlaylistItem(item, m.position, accessToken, opts.fetcher)
      } catch (e) {
        stoppedBy = passStop(e)
        if (stoppedBy) break
        // Every later move of the plan assumed this one happened: the next run plans afresh.
        const manual = e instanceof YouTubeApiError && e.status === 400 && e.reason === 'manualSortRequired'
        next.problem = manual ? 'manual_sort' : 'move_failed'
        next.detail = manual ? 'the playlist is not on manual order' : (errorFields(e).errorMessage as string | undefined) ?? String(e)
        log.warn('playlist_order.move_failed', { playlistId: p.playlistId, slug: p.slug, itemId: m.id, position: m.position, ...errorFields(e) })
        break
      }
      applied += 1
      moved += 1
      if (applied === 1) {
        // The first move of the run is checked against where YouTube says the item is before any more are spent.
        const at = await landedAt(replied, item, accessToken, opts.fetcher)
        units += at.units
        if (at.position !== null && at.position !== m.position) {
          next.problem = 'unexpected_position'
          next.detail = `a video moved to index ${m.position} is at index ${at.position}`
          log.warn('playlist_order.unexpected_position', { playlistId: p.playlistId, slug: p.slug, itemId: m.id, asked: m.position, got: at.position })
          break
        }
      }
    }
    next.moves = plan.moves.length - applied
    next.units = next.moves * UNITS_PER_MOVE
    next.moved += applied
    if (applied > 0) {
      next.lastRun = { needed: plan.moves.length, applied }
      log.info('playlist_order.moved', { playlistId: p.playlistId, slug: p.slug, moved: applied, left: next.moves })
    }
    if (stoppedBy) break
  }

  if (stoppedBy === 'quota') noteQuotaOut(state, now)
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

export type OrderReportRow = OrderPlaylistState | (ManagedPlaylist & { checkedAt: null })

export type OrderReport = {
  connected: boolean
  /** True when every number below was read from YouTube just now (`fresh`); else each row says when it was read. */
  fresh: boolean
  /** Units the fresh reading itself spent (listings only; a dry run never moves). */
  unitsSpent: number
  playlists: OrderReportRow[]
  /** Every artist playlist read, whether or not it is stopped. The combined playlist is not in here: it is not ordered. */
  totals: OrderNeed & { playlists: number; unread: number }
  /** 0 = paused: the pass makes no YouTube call until a budget is saved. */
  dailyUnits: number
  movesPerRun: number
  unitsUsedToday: number
  /**
   * What the pass still has to do: the moves of the playlists it works on (not
   * one stopped for a reason someone has to look at), the units with the
   * listings of the runs, and the days at `dailyUnits` (null while paused).
   */
  estimate: { moves: number; units: number; days: number | null }
  /** The same work at a few budgets, so a paused pass says what each would mean. */
  daysAt: Array<{ dailyUnits: number; days: number }>
  /** Set while the daily quota holds the pass back: unix seconds the quota day ends. */
  quotaStoppedUntil: number | null
  lastRun: OrderState['lastRun']
}

/**
 * Per playlist: entries, entries with no date, moves needed, units needed;
 * totals; and the days left at the current budget. With `fresh` every playlist
 * is read from YouTube now (about 35 units for 1 100 entries in 25 playlists) and the stored
 * numbers are replaced; nothing is moved either way, and it does not depend
 * on the budget. A fresh reading stops at a quota reply and reports what it has.
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
      // A reading does not clear a stop someone has to look at: only the pass finds out whether it still holds.
      const kept = before?.problem && STOPPING.includes(before.problem) ? { problem: before.problem, detail: before.detail ?? null } : { problem: null, detail: null }
      const next: OrderPlaylistState = { ...p, items: before?.items ?? 0, undated: before?.undated ?? 0, moves: before?.moves ?? 0, units: before?.units ?? 0, checkedAt: now, moved: before?.moved ?? 0, lastRun: before?.lastRun ?? null, ...kept }
      try {
        const r = await readPlaylistOrder(p.playlistId, keys, accessToken, opts.fetcher)
        unitsSpent += r.pages
        Object.assign(next, needOf(r.entries, planMoves(r.entries).moves))
      } catch (e) {
        unitsSpent += 1
        const q = quotaStop(e)
        if (q) {
          if (q === 'daily') noteQuotaOut(state, now)
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
  const rows: OrderReportRow[] = managed.map((p) => state.playlists[p.playlistId] ?? { ...p, checkedAt: null })
  const read = rows.filter((r): r is OrderPlaylistState => r.checkedAt !== null)
  const sum = (xs: OrderPlaylistState[], f: (r: OrderPlaylistState) => number) => xs.reduce((a, r) => a + f(r), 0)
  // Moves the pass will not make are not days it will take.
  const todo = read.filter((r) => !(r.problem && STOPPING.includes(r.problem)))
  const est = estimateDays(todo, settings.orderDailyUnits, settings.orderMovesPerRun)
  return {
    connected: !!accessToken,
    fresh,
    unitsSpent,
    playlists: rows,
    totals: { playlists: rows.length, unread: rows.length - read.length, items: sum(read, (r) => r.items), undated: sum(read, (r) => r.undated), moves: sum(read, (r) => r.moves), units: sum(read, (r) => r.units) },
    dailyUnits: settings.orderDailyUnits,
    movesPerRun: settings.orderMovesPerRun,
    unitsUsedToday: await orderUnitsUsedToday(env),
    estimate: { moves: sum(todo, (r) => r.moves), units: est.units, days: Number.isFinite(est.days) ? est.days : null },
    daysAt: SAMPLE_DAILY_UNITS.map((u) => ({ dailyUnits: u, days: estimateDays(todo, u, settings.orderMovesPerRun).days })),
    quotaStoppedUntil: (await youtubeQuotaOut(env, state)) ? quotaDayEnd() : null,
    lastRun: state.lastRun ?? null,
  }
}
