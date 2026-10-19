/**
 * Idle refresh of tracks (lib/fetch-scheduler.ts pickRefreshItems): the
 * scheduler's free slots look a track's links up again, besides refetching
 * the stalest sets.
 *
 * A track recheck is the medialink XHR (`fetchAllMediaLinks`, pool kind
 * `medialink`, one budgeted view at priority backfill), keyed by the track's
 * medialink id (never the `/track/<id>/` URL id). The tracks are the pre-save
 * candidates (lib/presave-candidates.ts): tracks with a Spotify pre-save
 * badge and neither a YouTube nor a Spotify link, which only a fetch of a set
 * they are in updates otherwise. A lookup that finds a YouTube or Spotify
 * link deletes the candidate, as that set fetch would (`isCandidateRow`); one
 * that finds neither stamps `links_checked_at`. The viewers' `ml:v1:<id>`
 * cache is refreshed by the lookup itself.
 *
 * Left out: tracks with a presave (lib/presave.ts rechecks those on its own
 * schedule), tracks queued for their first lookup in `link_prewarm`, ID rows
 * (no medialink id), and candidates looked at (by a set fetch or a lookup)
 * less than `refresh.trackCooldownHours` ago.
 */

import type { Env } from "../types";
import { dbOf } from "./db";
import { errorFields, type Logger } from "./log";
import { fetchAllMediaLinks, linkNames } from "./medialinks-all";
import type { PoolFaultCode } from "./pool";

const HOUR_MS = 3600_000;

/** A candidate's last look, unix ms: the later of the last set fetch that saw it and the last lookup. */
const SEEN_SQL = "MAX(c.updated_at, COALESCE(c.links_checked_at, 0))";

export type TrackRefreshCandidate = {
  /** The medialink id. */
  trackId: string;
  /** The track page on 1001tracklists (the tick's item URL). */
  url: string;
  /** The DJ of the set it was last seen in, or ''. */
  slug: string;
  /** Last looked at, unix ms. */
  seenAt: number;
};

/** Pre-save candidate tracks due an idle-refresh lookup, stalest first. */
export async function trackRefreshCandidates(
  env: Env,
  cooldownHours: number,
  nowMs: number,
  limit: number,
): Promise<TrackRefreshCandidate[]> {
  if (limit <= 0) return [];
  const res = await dbOf(env)
    .prepare(
      `SELECT c.track_id AS trackId, c.track_url AS url, COALESCE(c.dj_slug, '') AS slug, ${SEEN_SQL} AS seenAt
         FROM presave_candidates c
        WHERE c.track_id IS NOT NULL AND c.track_url IS NOT NULL AND c.is_id = 0
          AND ${SEEN_SQL} <= ?
          AND NOT EXISTS (SELECT 1 FROM presaves p WHERE p.track_id = c.track_id)
          AND NOT EXISTS (SELECT 1 FROM link_prewarm lp WHERE lp.track_id = c.track_id)
        ORDER BY seenAt ASC, c.track_id LIMIT ?`,
    )
    .bind(nowMs - cooldownHours * HOUR_MS, limit)
    .all<TrackRefreshCandidate>();
  return res.results.map((r) => ({
    trackId: String(r.trackId),
    url: r.url,
    slug: r.slug ?? "",
    seenAt: Number(r.seenAt) || 0,
  }));
}

export type TrackRefreshOutcome = {
  /** ok (looked up), failed (the lookup failed: waits the cooldown), stopped (the pool refused), skipped (not claimed). */
  outcome: "ok" | "failed" | "stopped" | "skipped";
  /** ok only: 1001tracklists has a YouTube or Spotify link now, so it is no candidate any more. */
  resolved?: boolean;
  stopReason?: string;
  poolCode?: PoolFaultCode | null;
  retryAfterSeconds?: number | null;
  /** The lookup reached 1001tracklists (counted toward the day's refreshes). */
  counted: boolean;
};

/**
 * One idle-refresh lookup. Claimed first (`links_checked_at` = now, only
 * while the candidate is still past its cooldown), so an overlapping tick
 * skips it and a failed lookup waits the whole cooldown. A pool refusal
 * learnt nothing: the claim is undone and nothing is counted. Never throws
 * for a lookup; a D1 error does.
 */
export async function runTrackRefresh(
  env: Env,
  item: { trackId: string; url: string },
  o: { cooldownHours: number; nowMs: number; log: Logger },
): Promise<TrackRefreshOutcome> {
  const db = dbOf(env);
  const { trackId } = item;
  const prev = await db
    .prepare("SELECT links_checked_at AS at FROM presave_candidates WHERE track_id = ? LIMIT 1")
    .bind(trackId)
    .first<{ at: number | null }>();
  const claim = await db
    .prepare(
      `UPDATE presave_candidates SET links_checked_at = ? WHERE track_id = ? AND MAX(updated_at, COALESCE(links_checked_at, 0)) <= ?`,
    )
    .bind(o.nowMs, trackId, o.nowMs - o.cooldownHours * HOUR_MS)
    .run();
  if (!prev || (claim.meta.changes ?? 0) === 0) {
    o.log.info("track_refresh.not_claimed", { trackId });
    return { outcome: "skipped", counted: false };
  }
  const r = await fetchAllMediaLinks(env, trackId, { priority: "backfill", log: o.log });
  if (!r.ok && r.poolError) {
    try {
      await db
        .prepare(
          "UPDATE presave_candidates SET links_checked_at = ? WHERE track_id = ? AND links_checked_at = ?",
        )
        .bind(prev.at ?? null, trackId, o.nowMs)
        .run();
    } catch (e) {
      o.log.warn("track_refresh.unclaim_failed", { trackId, ...errorFields(e) });
    }
    return {
      outcome: "stopped",
      stopReason: r.error,
      poolCode: r.poolCode ?? null,
      retryAfterSeconds: r.retryAfterSeconds ?? null,
      counted: false,
    };
  }
  if (!r.ok) {
    o.log.warn("track_refresh.failed", { trackId, trackUrl: item.url, error: r.error });
    return { outcome: "failed", counted: true };
  }
  const names = linkNames(r.links);
  const resolved = names.includes("youtube") || names.includes("spotify");
  if (resolved)
    await db.prepare("DELETE FROM presave_candidates WHERE track_id = ?").bind(trackId).run();
  o.log.info("track_refresh.done", { trackId, trackUrl: item.url, names, resolved });
  return { outcome: "ok", resolved, counted: true };
}
