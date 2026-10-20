/**
 * What waits on the YouTube quota, by consumer. The owner's order puts the DJ
 * playlist inserts above the combined playlist and set-date ordering, so the
 * cron lets those two sit out a tick while any insert is waiting.
 */
import type { Env } from "../types";

/**
 * DJ-playlist inserts waiting for quota: sets of a followed DJ with a video the
 * sync has not put in the playlist yet, plus set uploads whose insert is
 * pending. Never throws: on any error 0, so the guard does not block.
 */
export async function djInsertsWaiting(env: Env): Promise<number> {
  try {
    const row = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM tracklists t
           WHERE t.processed = 0 AND t.abandoned = 0 AND t.video_id IS NOT NULL
             AND t.slug IN (SELECT slug FROM subscriptions))
         + (SELECT COUNT(*) FROM mkvid_requests WHERE playlist_status = 'pending') AS n`,
    ).first<{ n: number }>();
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}
