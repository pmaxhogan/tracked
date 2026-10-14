/**
 * Per-track link pre-warm: a What's playing tap should find every track's
 * Apple Music / YouTube links already in the `ml:v1:<id>` cache. Measured
 * 2026-10-14, a cold tap spent ~18.7 s of its ~20 s looking links up through
 * the pool, one cold browser per track.
 *
 * Two halves:
 *   - `enqueueLinkPrewarm`: when the sync parses a set page (a new set or a
 *     recheck, lib/sync.ts), its identified tracks' medialink ids go into D1
 *     `link_prewarm` (migration 0021), one `INSERT OR IGNORE` batch: a track
 *     already queued from another set is not queued twice. No pool fetch, no
 *     KV read, and it never throws into the sync.
 *   - `drainLinkPrewarm`: the 5-minute cron (src/index.ts) looks up at most
 *     `linkPrewarm.maxPerTick` of them, one at a time, at pool priority
 *     `backfill` (the lowest: tlpool spends that share last and refuses it
 *     first). An id already cached is dropped without a fetch. A pool refusal
 *     ends the drain and charges the row nothing; a lookup that failed
 *     otherwise is not cached (fetchAllMediaLinks) and waits FAIL_BACKOFF x
 *     attempts, dropped after MAX_ATTEMPTS (the phone can still look it up).
 *
 * D1 rather than KV: the queue needs dedupe across sets, "due first" order
 * and a claim, which KV cannot give cheaply; every other work queue here
 * (presaves, set_schedule, track uploads) is D1 too.
 */

import type { Env } from "../types";
import { getAppSettings } from "./app-settings";
import { isPaused } from "./ban-state";
import { getJson } from "./cache";
import { BATCH_CHUNK } from "./db";
import { budgetHoldKey, TICK_BACKOFF_KEY } from "./fetch-scheduler";
import { errorFields, type Logger } from "./log";
import { fetchAllMediaLinks, mediaLinksCacheKey } from "./medialinks-all";
import { poolConfigFromEnv } from "./pool";
import { getPoolSettings } from "./pool-settings";
import type { MediaLinks, ScrapedTracklist } from "./tracklists1001";

/** A failed lookup (not a refusal) waits this x attempts. */
export const FAIL_BACKOFF_SECONDS = 6 * 3600;
/** Failed lookups before a track is dropped from the queue. */
export const MAX_ATTEMPTS = 3;
/** A drain holds a row this long while it looks it up (an overlapping cron leaves it alone). */
const CLAIM_SECONDS = 10 * 60;
/** Longest a pre-warm waits for a free browser: nobody is waiting on it, and the cron has more to do. */
const POOL_WAIT_SECONDS = 60;
/** Due rows one drain reads, cached ones included (they cost a KV read, no fetch). */
const SCAN_PER_CAP = 5;
const SCAN_MAX = 100;

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * The medialink ids of a parsed page worth looking up: named, identified rows
 * with a numeric medialink id (what /now-playing and /tracklist look up),
 * deduped, in page order. A row whose `mediaId` is null has no media links
 * (its `trackId` is the row's data-id, a page position) and is skipped; only
 * a list from before `mediaId` existed falls back to `trackId`.
 */
export function prewarmIds(parsed: Pick<ScrapedTracklist, "tracks" | "rows">): string[] {
  const ids: string[] = [];
  const add = (id: string | null | undefined) => {
    if (id && /^\d+$/.test(id) && !ids.includes(id)) ids.push(id);
  };
  if (parsed.rows && parsed.rows.length > 0) {
    for (const r of parsed.rows)
      if (!r.anonymous && !r.isUnidentified) add(r.mediaId !== undefined ? r.mediaId : r.trackId);
  } else {
    for (const t of parsed.tracks) if (!t.isUnidentified) add(t.trackId);
  }
  return ids;
}

/**
 * Queue a parsed set's tracks for a link lookup (one D1 batch per 100 ids).
 * Returns how many ids it offered (already-queued ones are ignored by the
 * table). Off while `linkPrewarm.enabled` is false. Never throws.
 */
export async function enqueueLinkPrewarm(
  env: Env,
  setUrl: string,
  parsed: Pick<ScrapedTracklist, "tracks" | "rows">,
  log: Logger,
  nowSec = nowSeconds(),
): Promise<number> {
  try {
    if (!env.DB) return 0;
    const settings = await getAppSettings(env);
    if (!settings.linkPrewarm.enabled) return 0;
    const ids = prewarmIds(parsed);
    if (ids.length === 0) return 0;
    const stmt = env.DB.prepare(
      "INSERT OR IGNORE INTO link_prewarm (track_id, set_url, queued_at, next_at) VALUES (?, ?, ?, ?)",
    );
    for (let i = 0; i < ids.length; i += BATCH_CHUNK)
      await env.DB.batch(
        ids.slice(i, i + BATCH_CHUNK).map((id) => stmt.bind(id, setUrl, nowSec, nowSec)),
      );
    log.info("link_prewarm.queued", { setUrl, ids: ids.length });
    return ids.length;
  } catch (e) {
    log.warn("link_prewarm.queue_failed", { setUrl, ...errorFields(e) });
    return 0;
  }
}

export type DrainResult = {
  /** Why nothing was looked up at all (off, pool held, nothing due...). */
  skipped?:
    "off" | "no_db" | "pool_not_configured" | "paused" | "backoff" | "budget_hold" | "nothing_due";
  /** Due rows read. */
  read: number;
  /** Already in the cache: dropped, no fetch. */
  cached: number;
  /** Looked up and cached. */
  fetched: number;
  /** Looked up and failed (backed off, or dropped after MAX_ATTEMPTS). */
  failed: number;
  /** The pool refusal that ended the drain (the rest stays queued, charged nothing). */
  stoppedBy?: string;
};

/**
 * One cron tick's pre-warm: up to `linkPrewarm.maxPerTick` uncached ids
 * looked up at priority backfill, oldest due first. Never throws.
 */
export async function drainLinkPrewarm(
  env: Env,
  log: Logger,
  nowSec = nowSeconds(),
): Promise<DrainResult> {
  const out: DrainResult = { read: 0, cached: 0, fetched: 0, failed: 0 };
  try {
    const settings = await getAppSettings(env);
    const cap = settings.linkPrewarm.enabled ? settings.linkPrewarm.maxPerTick : 0;
    if (cap <= 0) return { ...out, skipped: "off" };
    if (!env.DB) return { ...out, skipped: "no_db" };
    if (!poolConfigFromEnv(env)) return { ...out, skipped: "pool_not_configured" };
    // The scheduler's own holds: the pool asked us to wait, or the backfill share is spent.
    if (await isPaused(env)) return { ...out, skipped: "paused" };
    if ((Number(await env.CACHE.get(TICK_BACKOFF_KEY)) || 0) > nowSec)
      return { ...out, skipped: "backoff" };
    if ((Number(await env.CACHE.get(budgetHoldKey("backfill"))) || 0) > nowSec)
      return { ...out, skipped: "budget_hold" };
    const db = env.DB;
    const { results } = await db
      .prepare(
        "SELECT track_id, attempts, next_at FROM link_prewarm WHERE next_at <= ? ORDER BY next_at, queued_at LIMIT ?",
      )
      .bind(nowSec, Math.min(SCAN_MAX, cap * SCAN_PER_CAP))
      .all<{ track_id: string; attempts: number; next_at: number }>();
    if (results.length === 0) return { ...out, skipped: "nothing_due" };
    for (const row of results) {
      if (out.fetched + out.failed >= cap) break;
      out.read++;
      const id = row.track_id;
      if (await getJson<MediaLinks>(env.CACHE, mediaLinksCacheKey(id))) {
        await db.prepare("DELETE FROM link_prewarm WHERE track_id = ?").bind(id).run();
        out.cached++;
        continue;
      }
      // Claim it: a drain from an overlapping cron that read the same row leaves it.
      const claim = await db
        .prepare("UPDATE link_prewarm SET next_at = ? WHERE track_id = ? AND next_at = ?")
        .bind(nowSec + CLAIM_SECONDS, id, row.next_at)
        .run();
      if (!claim.meta.changes) continue;
      const r = await fetchAllMediaLinks(env, id, {
        priority: "backfill",
        log,
        maxWaitSeconds: POOL_WAIT_SECONDS,
      });
      if (r.ok) {
        await db.prepare("DELETE FROM link_prewarm WHERE track_id = ?").bind(id).run();
        out.fetched++;
        continue;
      }
      if (r.poolError) {
        // Nothing was learnt and nothing is charged: the row is due again as it was.
        await db
          .prepare("UPDATE link_prewarm SET next_at = ? WHERE track_id = ?")
          .bind(row.next_at, id)
          .run();
        out.stoppedBy = r.error;
        if (r.poolCode === "budget_exhausted") {
          // As the scheduler does: the backfill share is spent, so nothing of it is asked for until the pool says.
          const pool = await getPoolSettings(env);
          const until =
            nowSec +
            Math.min(
              pool.retry.poolBackoffMaxHours * 3600,
              Math.max(60, Math.ceil(r.retryAfterSeconds ?? 600)),
            );
          await env.CACHE.put(budgetHoldKey("backfill"), String(until), {
            expirationTtl: Math.max(60, until - nowSec + 60),
          });
        }
        log.info("link_prewarm.stopped", {
          trackId: id,
          poolCode: r.poolCode ?? null,
          retryAfterSeconds: r.retryAfterSeconds ?? null,
        });
        break;
      }
      out.failed++;
      const attempts = (Number(row.attempts) || 0) + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await db.prepare("DELETE FROM link_prewarm WHERE track_id = ?").bind(id).run();
        log.warn("link_prewarm.dropped", { trackId: id, attempts, error: r.error });
      } else {
        await db
          .prepare(
            "UPDATE link_prewarm SET attempts = ?, next_at = ?, last_error = ? WHERE track_id = ?",
          )
          .bind(attempts, nowSec + FAIL_BACKOFF_SECONDS * attempts, r.error.slice(0, 300), id)
          .run();
      }
    }
    return out;
  } catch (e) {
    log.warn("link_prewarm.drain_threw", errorFields(e));
    return { ...out, stoppedBy: out.stoppedBy ?? "threw" };
  }
}

/** Track ids waiting for a pre-warm lookup (the Scheduler page), null when D1 cannot say. */
export async function linkPrewarmPending(env: Env): Promise<number | null> {
  try {
    if (!env.DB) return null;
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM link_prewarm").first<{ n: number }>();
    return Number(r?.n ?? 0);
  } catch {
    return null;
  }
}
