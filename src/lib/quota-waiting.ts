/**
 * What waits on the YouTube quota, by consumer. The owner's order puts the DJ
 * playlist inserts above the combined playlist and set-date ordering, so the
 * cron lets those two sit out a tick while any insert is waiting.
 */
import type { Env } from "../types";
import { attemptOkSql, utcDay } from "./fetch-scheduler";
import { DUE_SQL } from "./mkvid-playlist";
import { getPoolSettings } from "./pool-settings";

/**
 * DJ-playlist inserts the cron would try now: sets of a followed DJ with a
 * video the sync has not put in the playlist yet, that are not waiting out a
 * backoff or past the day's attempt cap (the scheduler's own attemptOkSql), plus
 * set uploads whose pending insert is due (mkvid-playlist's DUE_SQL). A row that
 * cannot be tried now does not count, or it would hold the others back for good.
 * Never throws: on any error 0, so the guard does not block.
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
