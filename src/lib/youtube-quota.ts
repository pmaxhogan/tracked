// "YouTube quota is out until midnight Pacific": one KV flag, set when any
// YouTube write gets a daily-quota reply. While it is set the sync (lib/sync.ts
// syncOne) asks YouTube nothing: set pages are still fetched, cached, verified
// and scheduled, a set with no recording still goes to mkvid, and only a
// playlist write waits, charged nothing. A first-time set keeps its video on
// its row, so the insert is made later without a second pool fetch, and the
// scheduler leaves such a set out until the quota is back.
//
//   - Set by `noteQuotaOut(env, e)` from every place that already tests
//     `isQuotaError` (sync inserts and rechecks, combined playlist, hygiene sweep,
//     mkvid recreate / gone check, track uploads).
//   - It expires by itself at the next midnight America/Los_Angeles (the KV
//     expiry, DST handled by the zone), and the owner can clear it early
//     (Scheduler page: they may have raised the quota).
//   - Only the daily reasons (quotaExceeded / dailyLimitExceeded) set it. A
//     per-minute rate limit (rateLimitExceeded / userRateLimitExceeded) sets
//     nothing: the run that got it stops its writes, and the next tick in a few
//     minutes simply tries again.
import type { Env } from "../types";
import { errorFields, type Logger } from "./log";
import { quotaKind } from "./youtube-error";
import { YouTubeApiError } from "./youtube-playlists";
// The quota day's end is mkvid.ts's (not reimplemented here), so the hold expires exactly when the daily claims reset.
import { quotaDayEnd } from "./mkvid";
import { markProjectOut, OWN_PROJECT, poolOut } from "./youtube-pool";

export const QUOTA_OUT_KEY = "yt:quota:out";

export type QuotaOut = { since: number; until: number };

/** The flag while it holds and the whole pool is out (lib/youtube-pool.ts), else null. A flag set while another project can still take the work is moved to the own project's flag. */
export async function getQuotaOut(env: Env, nowMs = Date.now()): Promise<QuotaOut | null> {
  try {
    // poolOut reads the pool, which also converts the legacy flag when another project can take over.
    if (!(await poolOut(env, nowMs))) return null;
    const v = await env.CACHE.get<QuotaOut>(QUOTA_OUT_KEY, "json");
    return v && typeof v.until === "number" && v.until * 1000 > nowMs ? v : null;
  } catch {
    return null;
  }
}

/** Marks quota as used up until the next midnight Pacific when `e` is a daily-quota reply; any other error is ignored. Never throws. */
export async function noteQuotaOut(
  env: Env,
  e: unknown,
  log?: Logger,
  nowMs = Date.now(),
): Promise<void> {
  try {
    if (!(e instanceof YouTubeApiError) || e.status !== 403 || quotaKind(e.reason) !== "quota")
      return;
    if (await getQuotaOut(env, nowMs)) return;
    const until = quotaDayEnd(nowMs);
    const since = Math.floor(nowMs / 1000);
    // The reply is about tracked's own project here; the global flag is only for a pool with nothing left.
    await markProjectOut(env, OWN_PROJECT, nowMs);
    if (!(await poolOut(env, nowMs))) return;
    await env.CACHE.put(QUOTA_OUT_KEY, JSON.stringify({ since, until } satisfies QuotaOut), {
      expirationTtl: Math.max(60, until - since),
    });
    log?.warn("youtube.quota_out", { until: new Date(until * 1000).toISOString() });
  } catch (err) {
    log?.warn("youtube.quota_out_note_failed", errorFields(err));
  }
}

/** The owner's early clear (they may have raised the quota). */
export async function clearQuotaOut(env: Env): Promise<void> {
  await env.CACHE.delete(QUOTA_OUT_KEY);
}
