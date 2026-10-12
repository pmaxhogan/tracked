/**
 * Several recordings "removed" within a day: a burst the owner has to rule on.
 *
 * A request whose recording is gone from its source ends as a quiet, neutral
 * `recording_removed` (lib/mkvid-outcome.ts). That is right for one deleted
 * upload, and wrong when SoundCloud or yt-dlp breaks and every probe answers
 * "not found": all of them would park quietly with nothing red anywhere. So:
 *
 *   - The rule. `mkvid.removedBurstCount` (default 3, 0 = never) removals that
 *     failed less than 24 hours apart, among the removals the owner has not
 *     ruled on yet, open a burst. It starts at the first of them (`since`), and
 *     every removal from then on is in it, the later ones included. The count
 *     is over every source together: a broken downloader hits all of them, the
 *     owner's rule ("several in a day") names none, and one alert with one
 *     answer is easier to act on than one per site. The 24 hours are between
 *     the removals, not back from now, so a burst nobody looked at for a day
 *     is still found, whenever the first read after it happens.
 *   - Red. A removal in the open burst reads `removed_unconfirmed`: a problem
 *     wherever a failure is one (the mkvid page, Home, Activity, Stats).
 *   - Frozen. Nothing changes such a request by itself: the sync does not
 *     queue it again with a new source (enqueueMkvidRequest), and a repeated
 *     failure report does not rewrite it (failMkvidRequest). The owner's own
 *     actions on one request (Retry, ban) still work.
 *   - The end. The owner chooses on the mkvid page: "Try them again"
 *     (retryRemovedBurst: back in the queue, attempts reset; the ones still
 *     gone fail again and are counted afresh) or "They are really gone"
 *     (confirmRemovedBurst: plain `recording_removed` from then on, never
 *     counted again). It also ends when no request is left in it, because
 *     each was retried or banned by hand.
 *
 * Stored: one small document in SUBS, `{ ackAt, since }`. `ackAt` is when the
 * last removal settled by a "really gone" failed (removals up to it are
 * settled, later ones are not); `since` is the open burst's
 * start, kept so that acting on some of its requests does not quietly dissolve
 * it for the rest. Which requests are in it is never stored: it is read from
 * mkvid_requests (status, error, updated_at) every time, so there is no
 * migration and the freeze does not depend on KV being current.
 *
 * `updated_at` stands for "when it failed": nothing but an owner action writes
 * a failed row after its failure.
 */
import type { Env } from '../types'
import { getAppSettings } from './app-settings'
import { dbOf } from './db'
import { mkvidRemovedSql } from './mkvid-outcome'

export const REMOVED_BURST_KEY = 'mkvid:removed-burst'
export const REMOVED_BURST_WINDOW_SECONDS = 24 * 60 * 60
/** Unsettled removals read at most (oldest first). Far more than a burst the owner would leave open. */
const SCAN = 1000

type State = { ackAt: number; since: number | null }

export type RemovedBurst = {
  /** Unix seconds: when the first request in it failed. */
  since: number
  /** The requests in it now. */
  count: number
  /** The same, by source (`soundcloud`, `hearthis`). */
  sources: Record<string, number>
  /** `mkvid.removedBurstCount` when this was read. */
  threshold: number
}

type BurstEnv = Pick<Env, 'DB'> & Partial<Pick<Env, 'SUBS'>>

async function loadState(env: BurstEnv): Promise<State> {
  const s = env.SUBS ? ((await env.SUBS.get(REMOVED_BURST_KEY, 'json')) as Partial<State> | null) : null
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null)
  return { ackAt: num(s?.ackAt) ?? 0, since: num(s?.since) }
}

async function saveState(env: BurstEnv, state: State): Promise<void> {
  if (env.SUBS) await env.SUBS.put(REMOVED_BURST_KEY, JSON.stringify(state))
}

/**
 * Where a burst starts in `times` (unix seconds, ascending): the first of the
 * earliest `n` that lie less than `window` apart, or null.
 */
export function removedBurstStart(times: readonly number[], n: number, window = REMOVED_BURST_WINDOW_SECONDS): number | null {
  if (n < 1) return null
  for (let i = 0; i + n - 1 < times.length; i++) if (times[i + n - 1]! - times[i]! < window) return times[i]!
  return null
}

const REMOVED_WHERE = `status = 'failed' AND ${mkvidRemovedSql('error')}`

/** `last`: when the newest unsettled removal failed (what a "really gone" settles up to). */
async function read(env: BurstEnv): Promise<{ state: State; burst: RemovedBurst | null; last: number }> {
  const state = await loadState(env)
  const threshold = (await getAppSettings(env)).mkvid.removedBurstCount
  if (threshold <= 0) return { state, burst: null, last: state.ackAt }
  const res = await dbOf(env as Env)
    .prepare(`SELECT updated_at AS at, source FROM mkvid_requests WHERE ${REMOVED_WHERE} AND updated_at > ? ORDER BY updated_at ASC LIMIT ${SCAN}`)
    .bind(state.ackAt)
    .all<{ at: number; source: string | null }>()
  const rows = res.results.map((r) => ({ at: Number(r.at), source: r.source ?? '' }))
  const last = rows.length ? rows[rows.length - 1]!.at : state.ackAt
  let since = state.since
  // Every request in it was retried or banned by hand: it is over.
  if (since !== null && !rows.some((r) => r.at >= since!)) since = null
  if (since === null) since = removedBurstStart(rows.map((r) => r.at), threshold)
  if (since !== state.since) {
    state.since = since
    await saveState(env, state)
  }
  if (since === null) return { state, burst: null, last }
  const sources: Record<string, number> = {}
  let count = 0
  for (const r of rows) {
    if (r.at < since) continue
    count++
    sources[r.source] = (sources[r.source] ?? 0) + 1
  }
  return { state, burst: { since, count, sources, threshold }, last }
}

/** The open burst, or null. Opens one (and remembers it) when the stored removals now make one. */
export async function getRemovedBurst(env: BurstEnv): Promise<RemovedBurst | null> {
  return (await read(env)).burst
}

/** The open burst's start: what lib/mkvid-outcome.ts takes as `since`. Null when none is open. */
export async function removedBurstSince(env: BurstEnv): Promise<number | null> {
  return (await read(env)).burst?.since ?? null
}

/**
 * Owner: "They are really gone". The requests in the burst become ordinary
 * `recording_removed` (queued again by themselves if the page links another
 * recording) and are never counted again; later removals start a new count.
 * Null when no burst is open.
 */
export async function confirmRemovedBurst(env: BurstEnv): Promise<RemovedBurst | null> {
  const { burst, last } = await read(env)
  if (!burst) return null
  await saveState(env, { ackAt: last, since: null })
  return burst
}

/**
 * Owner: "Try them again". Every request in the burst goes back in the queue
 * with a fresh start, as the panel's Retry does for one. One that is still
 * gone fails again and is counted afresh. Null when no burst is open.
 */
export async function retryRemovedBurst(env: BurstEnv, now = Math.floor(Date.now() / 1000)): Promise<{ burst: RemovedBurst; requeued: number } | null> {
  const { state, burst } = await read(env)
  if (!burst) return null
  const r = await dbOf(env as Env)
    .prepare(
      `UPDATE mkvid_requests SET status = 'pending', attempts = 0, not_before = NULL, claimed_at = NULL, error = NULL, updated_at = ?
       WHERE ${REMOVED_WHERE} AND updated_at >= ?`,
    )
    .bind(now, burst.since)
    .run()
  await saveState(env, { ackAt: state.ackAt, since: null })
  return { burst, requeued: r.meta.changes ?? 0 }
}
