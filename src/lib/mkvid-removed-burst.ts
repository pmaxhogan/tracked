/**
 * Several recordings "removed" within a day: a burst the owner has to rule on.
 *
 * A request whose recording is gone from its source ends as a quiet, neutral
 * `recording_removed` (lib/mkvid-outcome.ts). That is right for one deleted
 * upload, and wrong when SoundCloud or yt-dlp breaks and every probe answers
 * "not found": all of them would park quietly with nothing red anywhere. So:
 *
 *   - The rule. `mkvid.removedBurstCount` (default 3; 0 = never, else 2 to 50) removals that
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
 * Stored: two small documents in SUBS, so that the owner's answer and the
 * bookkeeping never write the same key.
 *
 *   - `mkvid:removed-burst-ack` `{ ackAt }`: when the last removal settled by
 *     a "really gone" failed (removals up to it are settled, later ones are
 *     not). Written by that answer only, and never lowered.
 *   - `mkvid:removed-burst` `{ since }`: the open burst's start, kept so that
 *     acting on some of its requests does not quietly dissolve it for the
 *     rest. Written by whoever reads a burst opening or ending, best effort:
 *     a write KV refuses (two reads in one second) is tried again by every
 *     later read, for as long as the stored requests still make the same
 *     burst. Accepted: if the opening write never lands and the owner then
 *     retries or bans requests by hand until fewer than the count are left,
 *     nothing remembers the burst and the rest read as ordinary removals.
 *     A start at or before `ackAt` is a leftover from before the answer and
 *     is ignored, so no late or stale write of it can undo "really gone".
 *     Cleared when the setting is 0, so switching it on again starts afresh.
 *
 * Which requests are in it is never stored: it is read from mkvid_requests
 * (status, error, updated_at) every time, so there is no migration and the
 * freeze does not depend on KV being current. When KV cannot be read at all,
 * neither what was settled nor a burst kept open below the count is known, so
 * every removal there is counts as unconfirmed for that read, however few:
 * nothing is written, the pages still render, and red and frozen is the safe
 * side to be wrong on.
 *
 * `updated_at` stands for "when it failed": nothing but an owner action writes
 * a failed row after its failure.
 */
import type { Env } from "../types";
import { getAppSettings } from "./app-settings";
import { dbOf } from "./db";
import { mkvidRemovedSql } from "./mkvid-outcome";

/** `{ since }`: the open burst's start. */
export const REMOVED_BURST_KEY = "mkvid:removed-burst";
/** `{ ackAt }`: the owner's last "really gone". */
export const REMOVED_BURST_ACK_KEY = "mkvid:removed-burst-ack";
export const REMOVED_BURST_WINDOW_SECONDS = 24 * 60 * 60;
/** Unsettled removals read at most (oldest first). Far more than a burst the owner would leave open. */
const SCAN = 1000;
/** KV takes one write a second per key: how long the answer waits before its one second try. */
const ACK_RETRY_MS = 1100;

/** `known` is false when KV could not be read: `ackAt` and `since` are then guesses, and nothing may be written. */
type State = {
  ackAt: number;
  since: number | null;
  known: boolean;
  /** The start as it is stored, a settled leftover included. */ stored: number | null;
};

export type RemovedBurst = {
  /** Unix seconds: when the first request in it failed. */
  since: number;
  /** The requests in it now. */
  count: number;
  /** The same, by source (`soundcloud`, `hearthis`). */
  sources: Record<string, number>;
  /** `mkvid.removedBurstCount` when this was read. */
  threshold: number;
};

/** The burst's state could not be read from KV, or the answer could not be stored there: an answer cannot be taken now. */
export class RemovedBurstUnavailable extends Error {
  constructor(message = "The removed-recordings state could not be read. Try again in a moment.") {
    super(message);
  }
}

type BurstEnv = Pick<Env, "DB"> & Partial<Pick<Env, "SUBS">>;

const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);

async function loadState(env: BurstEnv): Promise<State> {
  if (!env.SUBS) return { ackAt: 0, since: null, known: true, stored: null };
  try {
    const [ack, open] = (await Promise.all([
      env.SUBS.get(REMOVED_BURST_ACK_KEY, "json"),
      env.SUBS.get(REMOVED_BURST_KEY, "json"),
    ])) as Array<{ ackAt?: unknown; since?: unknown } | null>;
    const ackAt = num(ack?.ackAt) ?? 0;
    const stored = num(open?.since);
    // A start from before the last "really gone" is settled with it.
    return { ackAt, since: stored !== null && stored > ackAt ? stored : null, known: true, stored };
  } catch {
    return { ackAt: 0, since: null, known: false, stored: null };
  }
}

/** Remember the open burst's start (or that there is none). Best effort: the next read redoes a write that failed. */
async function saveSince(env: BurstEnv, since: number | null): Promise<void> {
  if (!env.SUBS) return;
  try {
    await env.SUBS.put(REMOVED_BURST_KEY, JSON.stringify({ since }));
  } catch {
    // KV refused (two writes to the key within a second) or is down: which requests are in the burst is read from D1 anyway.
  }
}

/**
 * Where a burst starts in `times` (unix seconds, ascending): the first of the
 * earliest `n` that lie less than `window` apart, or null.
 */
export function removedBurstStart(
  times: readonly number[],
  n: number,
  window = REMOVED_BURST_WINDOW_SECONDS,
): number | null {
  if (n < 1) return null;
  for (let i = 0; i + n - 1 < times.length; i++)
    if (times[i + n - 1]! - times[i]! < window) return times[i]!;
  return null;
}

const REMOVED_WHERE = `status = 'failed' AND ${mkvidRemovedSql("error")}`;

/** `last`: when the newest unsettled removal failed (what a "really gone" settles up to). */
async function read(
  env: BurstEnv,
  remember = true,
): Promise<{ state: State; burst: RemovedBurst | null; last: number }> {
  const state = await loadState(env);
  const threshold = (await getAppSettings(env)).mkvid.removedBurstCount;
  if (threshold <= 0) {
    // Switched off: forget an open burst's start, or switching it on again would resume it and take in every removal since.
    if (state.stored !== null && state.known && remember) await saveSince(env, null);
    return { state, burst: null, last: state.ackAt };
  }
  const res = await dbOf(env as Env)
    .prepare(
      `SELECT updated_at AS at, source FROM mkvid_requests WHERE ${REMOVED_WHERE} AND updated_at > ? ORDER BY updated_at ASC LIMIT ${SCAN}`,
    )
    .bind(state.ackAt)
    .all<{ at: number; source: string | null }>();
  const rows = res.results.map((r) => ({ at: Number(r.at), source: r.source ?? "" }));
  const last = rows.length ? rows[rows.length - 1]!.at : state.ackAt;
  let since = state.since;
  // Every request in it was retried or banned by hand: it is over.
  if (since !== null && !rows.some((r) => r.at >= since!)) since = null;
  if (since === null)
    since = removedBurstStart(
      rows.map((r) => r.at),
      threshold,
    );
  // KV could not be read: a burst kept open below the count would be missed, so every removal there is counts, however few.
  if (!state.known) since = rows.length ? rows[0]!.at : null;
  // `remember` is off for the two answers, which write for themselves: one write a call.
  if (since !== state.stored && state.known && remember) await saveSince(env, since);
  if (since === null) return { state, burst: null, last };
  const sources: Record<string, number> = {};
  let count = 0;
  for (const r of rows) {
    if (r.at < since) continue;
    count++;
    sources[r.source] = (sources[r.source] ?? 0) + 1;
  }
  return { state, burst: { since, count, sources, threshold }, last };
}

/** The open burst, or null. Opens one (and remembers it) when the stored removals now make one. */
export async function getRemovedBurst(env: BurstEnv): Promise<RemovedBurst | null> {
  return (await read(env)).burst;
}

/** The open burst's start: what lib/mkvid-outcome.ts takes as `since`. Null when none is open. */
export async function removedBurstSince(env: BurstEnv): Promise<number | null> {
  return (await read(env)).burst?.since ?? null;
}

/**
 * Owner: "They are really gone". The requests in the burst become ordinary
 * `recording_removed` (queued again by themselves if the page links another
 * recording) and are never counted again; later removals start a new count.
 * Null when no burst is open. Throws RemovedBurstUnavailable when KV cannot
 * be read, or when the answer cannot be stored.
 *
 * Only `ackAt` is written (at most twice, a second apart), and only upward.
 * The stored start is left behind: it is at or before `ackAt` now, so every
 * read ignores it, and the next one clears it.
 */
export async function confirmRemovedBurst(env: BurstEnv): Promise<RemovedBurst | null> {
  const { state, burst, last } = await read(env, false);
  if (!state.known) throw new RemovedBurstUnavailable();
  if (!burst) return null;
  if (env.SUBS) {
    const body = JSON.stringify({ ackAt: Math.max(state.ackAt, last) });
    try {
      await env.SUBS.put(REMOVED_BURST_ACK_KEY, body);
    } catch {
      await new Promise((r) => setTimeout(r, ACK_RETRY_MS));
      try {
        await env.SUBS.put(REMOVED_BURST_ACK_KEY, body);
      } catch {
        throw new RemovedBurstUnavailable("The answer could not be stored. Try again in a moment.");
      }
    }
  }
  return burst;
}

/**
 * Owner: "Try them again". Every request in the burst goes back in the queue
 * with a fresh start, as the panel's Retry does for one. One that is still
 * gone fails again and is counted afresh. Null when no burst is open. Throws
 * RemovedBurstUnavailable when KV cannot be read.
 */
export async function retryRemovedBurst(
  env: BurstEnv,
  now = Math.floor(Date.now() / 1000),
): Promise<{ burst: RemovedBurst; requeued: number } | null> {
  const { state, burst } = await read(env, false);
  if (!state.known) throw new RemovedBurstUnavailable();
  if (!burst) return null;
  const r = await dbOf(env as Env)
    .prepare(
      `UPDATE mkvid_requests SET status = 'pending', attempts = 0, not_before = NULL, claimed_at = NULL, error = NULL, updated_at = ?
       WHERE ${REMOVED_WHERE} AND updated_at >= ?`,
    )
    .bind(now, burst.since)
    .run();
  // The requests are back in the queue whatever KV says: forgetting the start is bookkeeping the next read redoes.
  await saveSince(env, null);
  return { burst, requeued: r.meta.changes ?? 0 };
}
