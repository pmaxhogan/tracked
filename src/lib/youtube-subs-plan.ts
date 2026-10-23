/**
 * What the YouTube subscriptions run (lib/youtube-subscriptions.ts) has to do,
 * as SQL over `subscriptions` (the followed DJs), `dj_youtube_channels` and
 * `youtube_channel_subs` (migration 0037). Its own module so the quota's
 * waiting count (lib/quota-waiting.ts) can read it without importing the run,
 * which imports the quota gate.
 *
 *   - wanted: every channel a followed DJ resolves to (two DJs can share one);
 *   - to subscribe: a wanted channel with no row, one tracked unsubscribed
 *     earlier, or a failed / not found one whose retry is due;
 *   - to unsubscribe: a subscription tracked made (origin `tracked`, with the
 *     id YouTube gave it) whose channel no followed DJ wants any more. An
 *     `owner` row is never in it.
 */
import type { Env } from "../types";

/** Every channel a followed DJ resolves to. */
export const WANTED_SQL = `SELECT c.channel_id FROM subscriptions s JOIN dj_youtube_channels c ON c.slug = s.slug
  WHERE c.channel_id IS NOT NULL`;

/** ?1 = now (unix seconds). One row per channel: the first followed DJ that wants it. */
export const TO_SUBSCRIBE_SQL = `SELECT c.channel_id AS channel_id, MIN(s.slug) AS slug, MIN(s.position) AS pos
  FROM subscriptions s JOIN dj_youtube_channels c ON c.slug = s.slug
  LEFT JOIN youtube_channel_subs y ON y.channel_id = c.channel_id
  WHERE c.channel_id IS NOT NULL
    AND (y.channel_id IS NULL OR y.state = 'unsubscribed'
      OR (y.state IN ('failed', 'not_found') AND y.next_at IS NOT NULL AND y.next_at <= ?1))
  GROUP BY c.channel_id`;

/** ?1 = now (unix seconds). Only while some DJ is followed: an empty list is never read as "unfollow everything". */
export const TO_UNSUBSCRIBE_SQL = `SELECT channel_id, subscription_id, slug FROM youtube_channel_subs
  WHERE origin = 'tracked' AND state = 'subscribed' AND subscription_id IS NOT NULL
    AND (next_at IS NULL OR next_at <= ?1)
    AND channel_id NOT IN (${WANTED_SQL})
    AND EXISTS (SELECT 1 FROM subscriptions)`;

/** Subscribes plus unsubscribes due now. Never throws: 0 on any error. */
export async function ytSubsPendingCount(env: Env, nowSec: number): Promise<number> {
  try {
    const row = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM (${TO_SUBSCRIBE_SQL})) + (SELECT COUNT(*) FROM (${TO_UNSUBSCRIBE_SQL})) AS n`,
    )
      .bind(nowSec)
      .first<{ n: number }>();
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  }
}
