/**
 * What waits on the YouTube quota, by consumer: the work queued right now, in
 * units, which lower ranks hold back for (lib/quota-priority.ts). Only what
 * is countable up front with a cheap COUNT; the rest is 0.
 */
import type { Env } from "../types";
import { getAppSettings } from "./app-settings";
import { attemptOkSql, utcDay } from "./fetch-scheduler";
import { DUE_SQL } from "./mkvid-playlist";
import { getPoolSettings } from "./pool-settings";
import { RESOLVED_UNLIKED_SQL } from "./presave-like";
import { QUOTA_CONSUMERS } from "./quota-consumers";
import { PLAYLIST_DUE_SQL } from "./track-uploads";

/** CACHE key of the last waitingDemand, kept WAITING_CACHE_SECONDS. */
export const WAITING_CACHE_KEY = "quota:waiting";
const WAITING_CACHE_SECONDS = 240;

/**
 * DJ-playlist inserts the cron would try now: sets of a followed DJ with a
 * video the sync has not put in the playlist yet, that are not waiting out a
 * backoff or past the day's attempt cap (the scheduler's own attemptOkSql), plus
 * set uploads whose pending insert is due (mkvid-playlist's DUE_SQL). A row that
 * cannot be tried now does not count, or it would hold the others back for good.
 * Never throws: on any error 0, so nothing is held back for it.
 */
export async function djInsertsWaiting(env: Env): Promise<number> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const settings = await getPoolSettings(env);
    const row = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM tracklists t LEFT JOIN set_schedule s ON s.url = t.url
           WHERE t.processed = 0 AND t.abandoned = 0 AND t.video_id IS NOT NULL
             AND t.slug IN (SELECT slug FROM subscriptions)
             AND ${attemptOkSql(settings.retry.maxSetAttemptsPerDay)})
         + (SELECT COUNT(*) FROM mkvid_requests WHERE ${DUE_SQL}) AS n`,
    )
      .bind(now, utcDay(now), now)
      .first<{ n: number }>();
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

/** Pre-save likes due now (each a getRating 1 + rate 50); 0 while likes are off. */
async function likesDue(env: Env, nowMs: number): Promise<number> {
  if (!(await getAppSettings(env)).presave.likeOnYouTube) return 0;
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM presaves WHERE like_next_at IS NOT NULL AND like_next_at <= ? AND ${RESOLVED_UNLIKED_SQL}`,
  )
    .bind(nowMs)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Pre-saves due into the Pre-saves playlist plus track uploads whose playlist insert is due. */
async function presaveInsertsDue(env: Env, nowMs: number): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM presaves WHERE presave_playlist_status = 'pending' AND youtube_video_id IS NOT NULL
          AND COALESCE(presave_playlist_next_at, 0) <= ?)
       + (SELECT COUNT(*) FROM track_uploads WHERE ${PLAYLIST_DUE_SQL}) AS n`,
  )
    .bind(nowMs, Math.floor(nowMs / 1000))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Units waiting per consumer key: likes x 51, Pre-saves and track-upload
 * playlist inserts x 50, DJ inserts (djInsertsWaiting) x 50, every other
 * consumer 0. Cached in CACHE for WAITING_CACHE_SECONDS, so the gate costs a
 * KV read on most calls. Never throws: a count that fails is 0.
 */
export async function waitingDemand(env: Env, nowMs = Date.now()): Promise<Record<string, number>> {
  try {
    const hit = await env.CACHE.get<Record<string, number>>(WAITING_CACHE_KEY, "json");
    if (hit && typeof hit === "object") return hit;
  } catch {
    // Counted again below.
  }
  const out: Record<string, number> = Object.fromEntries(QUOTA_CONSUMERS.map((c) => [c.key, 0]));
  out.likes = 51 * (await likesDue(env, nowMs).catch(() => 0));
  out.presave_playlists = 50 * (await presaveInsertsDue(env, nowMs).catch(() => 0));
  out.dj_playlists = 50 * (await djInsertsWaiting(env));
  try {
    await env.CACHE.put(WAITING_CACHE_KEY, JSON.stringify(out), {
      expirationTtl: WAITING_CACHE_SECONDS,
    });
  } catch {
    // Counted again next time.
  }
  return out;
}
