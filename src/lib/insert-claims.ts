/**
 * One-at-a-time claims in D1 (table `insert_claims`, migration 0035).
 *
 * Why: a playlist's membership is read from a KV snapshot (`yt:plvids:`) that
 * every writer reads at its start and writes back whole at its end, and two
 * writers can run at once (overlapping cron ticks, a sync next to an mkvid
 * completion, mkvid delivering the same completion from two loops). Both then
 * see the video missing and both insert it: YouTube keeps both items. The
 * claim is the one atomic step in front of the insert: the first writer of
 * the row wins, and for the claim's window everybody else treats the insert
 * as done by someone else.
 *
 * Fail-open: a D1 error is "claimed" (the insert goes ahead as it did before
 * claims existed); the playlist comparison removes a duplicate that slips
 * through (lib/playlist-hygiene.ts deleteDuplicateItems).
 */
import type { Env } from "../types";
import { dbOf } from "./db";

/** How long a playlist insert claim holds: well past any run, short enough that a crashed one frees itself. */
export const INSERT_CLAIM_SECONDS = 15 * 60;

const nowSeconds = () => Math.floor(Date.now() / 1000);

export type Claim = { key: string; at: number } | null;

/**
 * Take `key` unless somebody took it less than `windowSeconds` ago. Returns
 * the claim (pass it to `releaseClaim`), or null when it is held. Never throws.
 */
export async function takeClaim(
  env: Env,
  key: string,
  windowSeconds = INSERT_CLAIM_SECONDS,
  now = nowSeconds(),
): Promise<Claim> {
  try {
    const r = await dbOf(env)
      .prepare(
        `INSERT INTO insert_claims (k, at) VALUES (?, ?)
         ON CONFLICT(k) DO UPDATE SET at = excluded.at WHERE insert_claims.at <= ?`,
      )
      .bind(key, now, now - windowSeconds)
      .run();
    return (r.meta.changes ?? 0) > 0 ? { key, at: now } : null;
  } catch {
    return { key, at: now };
  }
}

/** Give a claim back (the work failed, or is finished and its own state guards it now). Only the holder's row goes. Never throws. */
export async function releaseClaim(env: Env, claim: Claim): Promise<void> {
  if (!claim) return;
  try {
    await dbOf(env)
      .prepare("DELETE FROM insert_claims WHERE k = ? AND at = ?")
      .bind(claim.key, claim.at)
      .run();
  } catch {
    // It lapses after its window.
  }
}

/** Drop `key` whoever holds it: the video was taken out again, so a new insert is a real one. Never throws. */
export async function dropClaim(env: Env, key: string): Promise<void> {
  try {
    await dbOf(env).prepare("DELETE FROM insert_claims WHERE k = ?").bind(key).run();
  } catch {
    // It lapses after its window.
  }
}

/** Claims past every window: the daily housekeeping drops them. Never throws. */
export async function pruneClaims(env: Env, olderThanSeconds = 24 * 3600): Promise<number> {
  try {
    const r = await dbOf(env)
      .prepare("DELETE FROM insert_claims WHERE at < ?")
      .bind(nowSeconds() - olderThanSeconds)
      .run();
    return r.meta.changes ?? 0;
  } catch {
    return 0;
  }
}

/** The claim key of one video's insert into one playlist. */
export const playlistInsertKey = (playlistId: string, videoId: string) =>
  `pl ${playlistId} ${videoId}`;
