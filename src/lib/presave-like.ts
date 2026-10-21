/**
 * A pre-saved track that has a YouTube video is liked on the owner's account
 * (videos.rate, which is what puts it in YouTube Music's "Liked songs"), with
 * the same OAuth token the playlist sync and POST /likes use (D1 `presaves`
 * columns liked_at / like_attempts / like_error / like_next_at /
 * like_claimed_at, migration 0020).
 *
 * A pre-save gets its video in three ways, and all of them end in a call of
 * `onPresaveResolved` in lib/presave.ts:
 *   - found at once, by the check that runs on save       (checkLinks, trigger add)
 *   - found later, by a scheduled or manual check         (checkLinks)
 *   - ripped and uploaded by mkvid                        (markPresaveUploaded)
 * and so does restoring a dismissed pre-save that has one (restoreRow). The
 * video liked is always `presaves.youtube_video_id` as that transition wrote
 * it; nothing here matches a track to a video by any other id.
 *
 * Nobody waits for the like. The hook only marks it due (like_next_at = now)
 * and starts it in the background; index.ts hands `drainPresaveLikes()` to
 * ctx.waitUntil, like the stored pages. One that does not finish there is
 * still due, and the 5-minute cron runs it (`retryDuePresaveLikes`).
 *
 * The rating is read first (videos.getRating): a video already liked is only
 * recorded, and one the owner disliked is left alone, for good. A like that
 * fails never touches the pre-save itself: the failure is kept in like_error
 * as `<kind>: <detail>` (LikeFailKind) and tried again, or not, by its kind.
 *
 * Out of the day's quota is the shared hold's (lib/youtube-quota.ts, KV
 * `yt:quota:out`): a like that is told so sets it like any other YouTube
 * write, and while it is set the hook's like and the cron ask YouTube nothing;
 * the likes stay due and go as soon as it expires or the owner clears it.
 *
 * Quota: videos.getRating 1 unit, videos.rate 50. The hook and the cron spend
 * at most the likes quota consumer's max a quota day (settings.quota, which
 * took over presave.likeDailyUnitCap; a KV counter in CACHE, approximate by
 * design), and only when the priority rule lets them (lib/quota-priority.ts;
 * held, a like simply stays due); the backfill is the owner's own run and is
 * bounded by its `limit` instead.
 *
 * Imports neither lib/presave nor lib/track-uploads (both import this).
 */

import type { Env } from "../types";
import { dbOf } from "./db";
import { errorFields, makeLogger, type Logger } from "./log";
import { queuePresavePlaylist } from "./presave-playlist";
import { getAppSettings } from "./app-settings";
import { fetchWithTimeout } from "./fetch";
import { getAccessToken } from "./google-oauth";
import { getRatings, rateVideo, type Rating } from "./youtube-likes";
import { isQuotaError, YouTubeApiError } from "./youtube-playlists";
import { errorOneLine, quotaKind } from "./youtube-error";
import { getQuotaOut, noteQuotaOut } from "./youtube-quota";
import { quotaDayEnd, quotaDayStart } from "./mkvid";
import { dailyMaxUnits, quotaGate, REFUSAL_TEXT } from "./quota-priority";

/** One request to Google is cut off after this. Likes run in the background, so nothing a person waits for is behind it. */
const LIKE_TIMEOUT_MS = 8000;
const timedFetch: typeof fetch = (input, init) =>
  fetchWithTimeout(input as RequestInfo, { ...(init ?? {}), timeoutMs: LIKE_TIMEOUT_MS });

/** A try is claimed for this long, so an overlapping run does not rate the same video twice. */
const CLAIM_MS = 10 * 60_000;
/** A failure worth another try is tried again after RETRY_MS x 2^(tries - 1), at most a day. */
const RETRY_MS = 15 * 60_000;
const RETRY_MAX_MS = 24 * 3600_000;
/** A 404 is final from this try on (a video uploaded a moment ago may not be there yet). */
const GONE_TRIES = 3;
/** Likes the cron runs per tick. */
const RETRIES_PER_TICK = 2;
/** What one automatic like may cost: videos.getRating + videos.rate. */
const LIKE_UNITS = 51;
/**
 * `drainPresaveLikes` waits this long at most. A like cut off with its request
 * (a persisting 401 with its retries can outlast what waitUntil allows) leaves
 * a promise that never settles; without a limit the cron's `finally` and every
 * later request's waitUntil would wait on it to their own limit.
 */
const DRAIN_LIMIT_MS = 25_000;
/**
 * Final states that are about the video, not about the owner's account or
 * rating: restoring the pre-save does not ask again while it has that video.
 */
const VIDEO_FINAL_KINDS: readonly LikeFailKind[] = [
  "gone",
  "rating_disabled",
  "purchase_required",
  "rejected",
];
/** videos.rate calls one backfill request makes at most (a Worker's subrequests are limited). */
export const BACKFILL_MAX_LIKES = 20;
/** Pre-saves one backfill request reads: one videos.getRating call. */
const BACKFILL_PAGE = 50;

const RESOLVED_SQL = "stage IN ('found', 'uploaded') AND youtube_video_id IS NOT NULL";
/** Pre-saves the backfill covers: they have their video and no like yet. A dismissed one is left alone. */
export const RESOLVED_UNLIKED_SQL = `${RESOLVED_SQL} AND liked_at IS NULL`;
/** ...and were not given up on (tries made, none scheduled). */
const NOT_STOPPED_SQL = "(like_attempts = 0 OR like_next_at IS NOT NULL)";
/** No run holds the try (binds: now - CLAIM_MS). */
const UNCLAIMED_SQL = "(like_claimed_at IS NULL OR like_claimed_at <= ?)";

/**
 * Why a like was not made.
 *   tried again:  quota (the day's quota is used: it stays due and the quota hold, lib/youtube-quota.ts,
 *                        keeps every like from being tried until it expires or the owner clears it; not counted as a try)
 *                 budget (the likes consumer's max is used: at the quota day's roll-over, or as soon as the cap allows one again)
 *                 rate_limit, transient, not_connected (backoff, this row only)
 *                 gone (a 404: a few tries, then final)
 *   final:        rating_disabled, purchase_required, email_not_verified, forbidden, rejected, disliked
 * The owner has to act on not_connected, forbidden and email_not_verified (the UI shows those red).
 */
export type LikeFailKind =
  | "quota"
  | "budget"
  | "rate_limit"
  | "transient"
  | "not_connected"
  | "gone"
  | "rating_disabled"
  | "purchase_required"
  | "email_not_verified"
  | "forbidden"
  | "rejected"
  | "disliked";
export type LikeOutcome = "liked" | "already_liked" | "skipped" | LikeFailKind;

/** The like columns of a `presaves` row. */
export type PresaveLikeFields = {
  liked_at: number | null;
  like_attempts: number;
  like_error: string | null;
  like_next_at: number | null;
};

type LikeRow = PresaveLikeFields & { id: number; stage: string; youtube_video_id: string | null };

/** The shared decision (isQuotaError, youtube-error.ts quotaKind) for a caught error: the day's quota, a per-minute limit, or neither. */
const quotaKindOf = (e: unknown): "quota" | "rate_limit" | null =>
  isQuotaError(e) ? quotaKind((e as YouTubeApiError).reason) : null;

/** What a failed videos.rate / videos.getRating means, by the API's reason first. 5xx, a timeout and a persisting 401 are transient. */
export function likeFailKind(e: unknown): LikeFailKind {
  const q = quotaKindOf(e);
  if (q) return q;
  if (e instanceof YouTubeApiError) {
    const reason = e.reason ?? "";
    if (reason === "videoRatingDisabled") return "rating_disabled";
    if (reason === "videoPurchaseRequired") return "purchase_required";
    if (reason === "emailNotVerified") return "email_not_verified";
    if (reason === "videoNotFound" || e.status === 404) return "gone";
    if (e.status === 403) return "forbidden";
    if (e.status === 400) return "rejected";
  }
  return "transient";
}

/** When a like that was not made is tried again (unix ms); null = it is not. `attempts` counts this try. */
export function likeRetryAt(kind: LikeFailKind, attempts: number, now: number): number | null {
  // Out of the day's quota: it stays due. The quota hold (lib/youtube-quota.ts) is what keeps it from being
  // tried, so it goes again as soon as the hold expires or the owner clears it.
  if (kind === "quota") return now;
  if (kind === "budget") return quotaDayEnd(now) * 1000;
  const backoff =
    now + Math.min(RETRY_MS * 2 ** Math.min(Math.max(0, attempts - 1), 20), RETRY_MAX_MS);
  if (kind === "rate_limit" || kind === "transient" || kind === "not_connected") return backoff;
  if (kind === "gone") return attempts < GONE_TRIES ? backoff : null;
  return null;
}

const errText = (kind: LikeFailKind, detail: string): string => `${kind}: ${detail}`.slice(0, 500);

/**
 * A stored like_error's detail as one readable line, for display: a YouTube
 * API error by its shared reading (lib/youtube-error.ts: "videos.rate 403
 * videoRatingDisabled: ...", or the plain sentence for a quota wait), anything
 * else as it is. Not escaped: the page escapes it.
 */
export function likeErrorLine(likeError: string | null | undefined): string | null {
  if (!likeError) return null;
  return errorOneLine(likeError.replace(/^[a-z_]+: /, ""));
}

async function likeFields(env: Env, id: number): Promise<PresaveLikeFields | null> {
  return dbOf(env)
    .prepare("SELECT liked_at, like_attempts, like_error, like_next_at FROM presaves WHERE id = ?")
    .bind(id)
    .first<PresaveLikeFields>();
}

// --- the automatic path's daily budget -------------------------------------

const unitsKey = (now: number): string => `presave:like-units:${quotaDayStart(now)}`;

/** Quota units the hook and the cron spent on likes this quota day. */
export async function likeUnitsSpent(env: Env, now = Date.now()): Promise<number> {
  return Number(await env.CACHE.get(unitsKey(now))) || 0;
}

async function addLikeUnits(env: Env, now: number, units: number): Promise<void> {
  if (units <= 0) return;
  await env.CACHE.put(unitsKey(now), String((await likeUnitsSpent(env, now)) + units), {
    expirationTtl: 3 * 86400,
  });
}

// --- one like --------------------------------------------------------------

export type LikeResult = {
  outcome: LikeOutcome;
  videoId: string | null;
  error?: string;
  /** Quota units the calls made cost. */ units: number;
  /** With outcome `quota`: the priority rule held it (lib/quota-priority.ts), the quota itself is not out. */
  held?: true;
};
type LikeOpts = {
  log?: Logger;
  now?: number;
  fetcher?: typeof fetch;
  accessToken?: string;
  /** The backfill's: a retry that is not due yet is made anyway. A try another run holds is still left to it. */
  force?: boolean;
  /** The rating, when the caller has read it already (the backfill): videos.getRating is not asked again. */
  rating?: Rating | "unknown";
  /** The automatic path's: counted against the likes consumer's max, held by the priority rule, and not made once that is used. */
  budgeted?: boolean;
};

/**
 * Like one pre-save's video. Skipped when it has none, is not found / uploaded,
 * is liked already, is not due, or another run holds the try. The rating is
 * read first: already liked is only recorded, disliked is left alone. May
 * throw on a D1 error; the callers below catch.
 */
export async function likePresaveVideo(
  env: Env,
  presaveId: number,
  opts: LikeOpts = {},
): Promise<LikeResult> {
  const log = opts.log ?? makeLogger({ task: "presave.like", id: presaveId });
  const now = opts.now ?? Date.now();
  const fetcher = opts.fetcher ?? timedFetch;
  const db = dbOf(env);
  const p = await db
    .prepare(
      "SELECT id, stage, youtube_video_id, liked_at, like_attempts, like_error, like_next_at FROM presaves WHERE id = ?",
    )
    .bind(presaveId)
    .first<LikeRow>();
  if (
    !p ||
    !p.youtube_video_id ||
    p.liked_at !== null ||
    (p.stage !== "found" && p.stage !== "uploaded")
  )
    return { outcome: "skipped", videoId: p?.youtube_video_id ?? null, units: 0 };
  const videoId = p.youtube_video_id;
  const attempts = (Number(p.like_attempts) || 0) + 1;
  let units = 0;

  /** Not made: the reason and the next try, on this row while it still has this video and no like. */
  const park = async (kind: LikeFailKind, detail: string, claimed = true): Promise<LikeResult> => {
    // Told the day's quota is used: YouTube tried nothing, so the claim's count is taken back. Otherwise a
    // later 404 could be final on first sight, and a later transient failure would start at a long backoff.
    const uncount = claimed && kind === "quota";
    const tries = claimed && !uncount ? attempts : attempts - 1;
    const next = likeRetryAt(kind, tries, now);
    const error = errText(kind, detail);
    // Before the claim (the budget) another run's hold on the try is not this one's to release.
    await db
      .prepare(
        `UPDATE presaves SET like_error = ?, like_next_at = ?${claimed ? ", like_claimed_at = NULL" : ""}${uncount ? ", like_attempts = MAX(0, like_attempts - 1)" : ""} WHERE id = ? AND youtube_video_id = ? AND liked_at IS NULL`,
      )
      .bind(error, next, p.id, videoId)
      .run();
    log[kind === "budget" || kind === "disliked" ? "info" : "warn"]("presave.like_not_made", {
      id: p.id,
      videoId,
      kind,
      attempts: tries,
      retryAt: next,
      detail: detail.slice(0, 300),
    });
    return { outcome: kind, videoId, error, units };
  };
  const done = async (outcome: "liked" | "already_liked"): Promise<LikeResult> => {
    await db
      .prepare(
        "UPDATE presaves SET liked_at = ?, like_error = NULL, like_next_at = NULL, like_claimed_at = NULL WHERE id = ? AND youtube_video_id = ?",
      )
      .bind(now, p.id, videoId)
      .run();
    log.info("presave.liked", {
      id: p.id,
      videoId,
      attempts,
      already: outcome === "already_liked",
      units,
    });
    return { outcome, videoId, units };
  };

  /** YouTube answered: when it was the day's quota the shared hold is set, as every other YouTube write does. */
  const refused = async (e: unknown): Promise<LikeResult> => {
    const kind = likeFailKind(e);
    if (kind === "quota") await noteQuotaOut(env, e, log, now);
    return park(kind, e instanceof Error ? e.message : String(e));
  };

  if (opts.budgeted) {
    // The quota hold is set (a YouTube write was told the day's quota is used): no call at all. The like
    // stays due, so the first tick after the hold expires, or the owner clears it, makes it.
    const hold = await getQuotaOut(env, now);
    if (hold) {
      if (!p.like_error?.startsWith("quota:")) {
        await db
          .prepare(
            "UPDATE presaves SET like_error = ? WHERE id = ? AND youtube_video_id = ? AND liked_at IS NULL",
          )
          .bind(errText("quota", "YouTube's daily quota is used up; waiting for it"), p.id, videoId)
          .run();
      }
      return { outcome: "quota", videoId, units: 0 };
    }
    // The likes consumer's max (settings.quota) took over likeDailyUnitCap; the count is still this KV one.
    const cap = dailyMaxUnits(await getAppSettings(env), "likes");
    if ((await likeUnitsSpent(env, now)) + LIKE_UNITS > cap)
      return park("budget", `the ${cap} units a day for likes are used`, false);
    // Its turn at the quota (lib/quota-priority.ts).
    const gate = await quotaGate(env, "likes", LIKE_UNITS, now);
    if (!gate.ok) {
      if (gate.reason === "max")
        return park("budget", `the ${cap} units a day for likes are used`, false);
      // Held, switched off or the pool out: nothing asked, nothing charged, the like stays due as it is.
      log.info("presave.like_held", { id: p.id, videoId, reason: REFUSAL_TEXT[gate.reason] });
      return { outcome: "quota", videoId, units: 0, held: true };
    }
  }

  // Claimed first: the try is counted and held before YouTube is asked. Not a pre-save dismissed since it was read.
  const claim = await db
    .prepare(
      `UPDATE presaves SET like_attempts = like_attempts + 1, like_claimed_at = ? WHERE id = ? AND youtube_video_id = ? AND liked_at IS NULL AND stage IN ('found', 'uploaded') AND ${UNCLAIMED_SQL}${opts.force ? "" : " AND (like_next_at IS NULL OR like_next_at <= ?)"}`,
    )
    .bind(
      ...(opts.force
        ? [now, p.id, videoId, now - CLAIM_MS]
        : [now, p.id, videoId, now - CLAIM_MS, now]),
    )
    .run();
  if ((claim.meta.changes ?? 0) === 0) return { outcome: "skipped", videoId, units: 0 };

  try {
    let accessToken = opts.accessToken;
    if (!accessToken) {
      try {
        const tok = await getAccessToken(env, fetcher);
        if (!tok) return await park("not_connected", "no YouTube account is connected");
        accessToken = tok.accessToken;
      } catch (e) {
        return await park(
          "not_connected",
          `the YouTube token could not be refreshed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    // The owner's own rating first: a like is never made over a dislike, and never paid for twice.
    let rating = opts.rating;
    if (rating === undefined) {
      try {
        rating = (await getRatings([videoId], accessToken, fetcher)).get(videoId) ?? "unknown";
        units += 1;
      } catch (e) {
        return await refused(e);
      }
    }
    if (rating === "like") return await done("already_liked");
    if (rating === "dislike") return await park("disliked", "disliked on YouTube; left alone");
    try {
      await rateVideo(videoId, "like", accessToken, fetcher);
      units += 50;
    } catch (e) {
      // A call YouTube answered with an error other than its limits is counted as spent (the upper bound).
      if (!quotaKindOf(e)) units += 50;
      return await refused(e);
    }
    return await done("liked");
  } finally {
    if (opts.budgeted) await addLikeUnits(env, now, units).catch(() => undefined);
  }
}

// --- the transition hook ---------------------------------------------------

const pending = new Set<Promise<unknown>>();

/**
 * Resolves when every like started so far has finished (they swallow their own
 * errors), or after `limitMs`: the ones still running then are dropped from
 * the set, so no later drain waits on them. A dropped like's claim goes stale
 * after CLAIM_MS and the cron tries it again.
 */
export async function drainPresaveLikes(limitMs = DRAIN_LIMIT_MS): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (pending.size) {
    const batch = [...pending];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = await Promise.race([
      Promise.allSettled(batch).then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), Math.max(0, deadline - Date.now()));
      }),
    ]);
    clearTimeout(timer);
    if (late) {
      for (const p of batch) pending.delete(p);
      return;
    }
  }
}

/**
 * A pre-save just got its YouTube video (found on 1001tracklists, uploaded by
 * mkvid, or restored with one). Unless presave.likeOnYouTube is off, its like
 * is marked due and started in the background: the caller does not wait for
 * YouTube, and a like that does not finish is the cron's. `replacedVideoId`:
 * the video it had before, when that changed; a like recorded for the old one
 * does not count for the new (the old video is not un-liked).
 *
 * `restored`: a dismissed pre-save is watched again and still has its video.
 * A like that was never made or is still waiting is due again. One that ended
 * in a final state is asked again only when the answer may be different now
 * for the same video: the owner's own rating (`disliked`: they may have taken
 * it back) and what the owner fixes on the account (`forbidden`,
 * `email_not_verified`). What YouTube said about the video itself (`gone`,
 * `rating_disabled`, `purchase_required`, `rejected`: VIDEO_FINAL_KINDS) stays
 * final until the pre-save gets another video (`replacedVideoId`).
 *
 * Never throws and never changes anything but the like columns, which it
 * returns as they are once the like is due (null when nothing was read).
 */
export async function onPresaveResolved(
  env: Env,
  presaveId: number,
  log?: Logger,
  opts: {
    now?: number;
    fetcher?: typeof fetch;
    replacedVideoId?: string | null;
    restored?: boolean;
  } = {},
): Promise<PresaveLikeFields | null> {
  const lg = log ?? makeLogger({ task: "presave.like", id: presaveId });
  try {
    const now = opts.now ?? Date.now();
    const db = dbOf(env);
    await queuePresavePlaylist(env, presaveId, now, !!opts.replacedVideoId);
    if (!(await getAppSettings(env)).presave.likeOnYouTube) return null;
    if (opts.replacedVideoId) {
      await db
        .prepare(
          "UPDATE presaves SET liked_at = NULL, like_attempts = 0, like_error = NULL, like_next_at = NULL, like_claimed_at = NULL WHERE id = ? AND youtube_video_id IS NOT NULL AND youtube_video_id != ?",
        )
        .bind(presaveId, opts.replacedVideoId)
        .run();
    }
    const videoFinal = opts.restored
      ? ` AND NOT (like_next_at IS NULL AND like_attempts > 0 AND (${VIDEO_FINAL_KINDS.map((k) => `like_error LIKE '${k}:%'`).join(" OR ")}))`
      : "";
    const due = await db
      .prepare(
        `UPDATE presaves SET like_next_at = ? WHERE id = ? AND ${RESOLVED_UNLIKED_SQL}${videoFinal}`,
      )
      .bind(now, presaveId)
      .run();
    const fields = await likeFields(env, presaveId);
    if ((due.meta.changes ?? 0) > 0) {
      const p: Promise<unknown> = likePresaveVideo(env, presaveId, {
        log: lg,
        now,
        fetcher: opts.fetcher,
        budgeted: true,
      })
        .catch((e) => lg.warn("presave.like_threw", { id: presaveId, ...errorFields(e) }))
        .finally(() => pending.delete(p));
      pending.add(p);
    }
    return fields;
  } catch (e) {
    lg.warn("presave.like_threw", { id: presaveId, ...errorFields(e) });
    return null;
  }
}

/**
 * The cron's part: likes that are due (started by the hook and not finished,
 * or waiting for their retry), oldest first, a few per tick. Only pre-saves
 * the hook marked have a due time, so nothing that was resolved before this
 * existed is liked from here (that is the backfill's). Stops at the first
 * answer that says no more will go through now. Never throws.
 */
/** Why the likes' cron step stopped; `held` = the priority rule held it (track-uploads' PlaylistRetryStop says the same). */
export type LikeRetryStop = "quota" | "budget" | "rate_limit" | "held";

export async function retryDuePresaveLikes(
  env: Env,
  log: Logger,
  opts: { now?: number; fetcher?: typeof fetch; limit?: number } = {},
): Promise<{ tried: number; liked: number; stoppedBy: LikeRetryStop | null }> {
  const out = { tried: 0, liked: 0, stoppedBy: null as LikeRetryStop | null };
  try {
    if (!env.DB) return out;
    const now = opts.now ?? Date.now();
    // The quota hold: nothing is asked of YouTube, and the due likes stay due.
    if (await getQuotaOut(env, now)) return { ...out, stoppedBy: "quota" };
    const app = await getAppSettings(env);
    const settings = app.presave;
    // Likes parked for the day's budget wait for the roll-over; when the likes' max allows one before that (the
    // owner raised it), they are due now.
    if ((await likeUnitsSpent(env, now)) + LIKE_UNITS <= dailyMaxUnits(app, "likes")) {
      await dbOf(env)
        .prepare(
          `UPDATE presaves SET like_next_at = ? WHERE like_error LIKE 'budget:%' AND like_next_at > ? AND ${RESOLVED_UNLIKED_SQL}`,
        )
        .bind(now, now)
        .run();
    }
    const due = (
      await dbOf(env)
        .prepare(
          `SELECT id FROM presaves WHERE like_next_at IS NOT NULL AND like_next_at <= ? AND ${RESOLVED_UNLIKED_SQL} AND ${UNCLAIMED_SQL} ORDER BY like_next_at, id LIMIT ?`,
        )
        .bind(now, now - CLAIM_MS, opts.limit ?? RETRIES_PER_TICK)
        .all<{ id: number }>()
    ).results;
    if (due.length === 0 || !settings.likeOnYouTube) return out;
    for (const d of due) {
      const r = await likePresaveVideo(env, d.id, {
        log,
        now,
        fetcher: opts.fetcher,
        budgeted: true,
      });
      if (r.outcome === "skipped") continue;
      // Held, nothing was asked of YouTube: not a try.
      if (r.held) {
        out.stoppedBy = "held";
        break;
      }
      if (r.outcome !== "budget") out.tried++;
      if (r.outcome === "liked" || r.outcome === "already_liked") out.liked++;
      if (r.outcome === "quota" || r.outcome === "budget" || r.outcome === "rate_limit") {
        out.stoppedBy = r.outcome;
        break;
      }
    }
  } catch (e) {
    log.warn("presave.like_retries_threw", errorFields(e));
  }
  return out;
}

// --- the backfill (POST /presave/like-backfill, scripts/presave-like-backfill.mjs) ---

/** Migration 0020 is applied (the like columns exist). */
export async function likeColumnsExist(env: Env): Promise<boolean> {
  try {
    await dbOf(env)
      .prepare(
        "SELECT liked_at, like_attempts, like_error, like_next_at, like_claimed_at FROM presaves LIMIT 1",
      )
      .first();
    return true;
  } catch (e) {
    if (/no such column/i.test(e instanceof Error ? e.message : String(e))) return false;
    throw e;
  }
}

export type LikeBackfillItem = {
  id: number;
  artist: string | null;
  title: string | null;
  stage: string;
  videoId: string;
  /** videos.getRating's answer; `unknown` when it was not asked, failed, or did not name the video (deleted / private). */
  rating: Rating | "unknown";
  action: "would_like" | "liked" | "already_liked" | "left_disliked" | "failed" | "not_tried";
  error?: string;
};

export type LikeBackfillResult = {
  dryRun: boolean;
  /** Pre-saves with a video and no like, before this request. */
  total: number;
  items: LikeBackfillItem[];
  liked: number;
  alreadyLiked: number;
  wouldLike: number;
  failed: number;
  /** Quota units: `getRating` spent by this request (a dry run spends them too), `rate` spent (live) or needed (dry run). */
  units: { getRating: number; rate: number };
  /** quota: YouTube is out of quota, run again after midnight Pacific. rate_limit: run again in a few minutes. */
  stoppedBy: "quota" | "rate_limit" | "not_connected" | "error" | null;
  message?: string;
  /** Pass as `afterId` for the next page; null when this was the last one. */
  nextAfterId: number | null;
};

export type LikeBackfillInput = {
  dryRun?: boolean;
  limit?: number;
  afterId?: number;
  includeStopped?: boolean;
};

/**
 * One bounded page of the backfill: up to 50 resolved pre-saves with no like,
 * by id after `afterId`. Their ratings are read with one videos.getRating
 * call; one already liked is marked liked (live) at no further cost, one the
 * owner disliked is left alone, and the rest are liked, at most `limit`
 * (default and maximum 20) per request. A dry run (the default) writes nothing
 * and likes nothing. YouTube's limits stop the page; any other failed like is
 * recorded like the hook's and the page goes on. A like another run is making
 * at that moment is left to it (`not_tried`).
 */
export async function backfillPresaveLikes(
  env: Env,
  input: LikeBackfillInput = {},
  opts: { log?: Logger; now?: number; fetcher?: typeof fetch } = {},
): Promise<LikeBackfillResult> {
  const log = opts.log ?? makeLogger({ task: "presave.like_backfill" });
  const now = opts.now ?? Date.now();
  const fetcher = opts.fetcher ?? timedFetch;
  const dryRun = input.dryRun !== false;
  const limit = Math.min(
    Math.max(0, Math.floor(input.limit ?? BACKFILL_MAX_LIKES)),
    BACKFILL_MAX_LIKES,
  );
  const afterId = Math.max(0, Math.floor(input.afterId ?? 0));
  const where = `${RESOLVED_UNLIKED_SQL}${input.includeStopped ? "" : ` AND ${NOT_STOPPED_SQL}`}`;
  const db = dbOf(env);

  const total =
    Number(
      (await db.prepare(`SELECT COUNT(*) AS n FROM presaves WHERE ${where}`).first<{ n: number }>())
        ?.n,
    ) || 0;
  const rows = (
    await db
      .prepare(
        `SELECT id, artist, title, stage, youtube_video_id FROM presaves WHERE ${where} AND id > ? ORDER BY id LIMIT ?`,
      )
      .bind(afterId, BACKFILL_PAGE + 1)
      .all<{
        id: number;
        artist: string | null;
        title: string | null;
        stage: string;
        youtube_video_id: string;
      }>()
  ).results;
  const more = rows.length > BACKFILL_PAGE;
  const page = rows.slice(0, BACKFILL_PAGE);
  const out: LikeBackfillResult = {
    dryRun,
    total,
    items: [],
    liked: 0,
    alreadyLiked: 0,
    wouldLike: 0,
    failed: 0,
    units: { getRating: 0, rate: 0 },
    stoppedBy: null,
    nextAfterId: null,
  };
  const item = (
    r: (typeof page)[number],
    rating: LikeBackfillItem["rating"],
    action: LikeBackfillItem["action"],
    error?: string,
  ): LikeBackfillItem => ({
    id: r.id,
    artist: r.artist,
    title: r.title,
    stage: r.stage,
    videoId: r.youtube_video_id,
    rating,
    action,
    ...(error ? { error } : {}),
  });
  if (page.length === 0) return out;

  // Without the ratings nothing is liked (a dislike could not be told); a dry run still lists everything, as if none were liked yet.
  const blind = (
    stoppedBy: LikeBackfillResult["stoppedBy"],
    message: string,
  ): LikeBackfillResult => {
    out.stoppedBy = stoppedBy;
    out.message = message;
    out.items = page.map((r) => item(r, "unknown", dryRun ? "would_like" : "not_tried"));
    if (dryRun) {
      out.wouldLike = page.length;
      out.units.rate = 50 * page.length;
      out.nextAfterId = more ? page[page.length - 1]!.id : null;
    }
    return out;
  };

  // A live run while the quota hold is set would only be refused by YouTube: it is refused here, before any call.
  if (!dryRun) {
    const hold = await getQuotaOut(env, now);
    if (hold)
      return blind(
        "quota",
        `YouTube's daily quota is used up (held until ${new Date(hold.until * 1000).toISOString()}). Run it again after that, or clear the hold on the Scheduler page if the quota was raised.`,
      );
  }

  let accessToken: string;
  try {
    const tok = await getAccessToken(env, fetcher);
    if (!tok) return blind("not_connected", "no YouTube account is connected");
    accessToken = tok.accessToken;
  } catch (e) {
    return blind(
      "not_connected",
      `the YouTube token could not be refreshed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  let ratings: Map<string, Rating>;
  try {
    ratings = await getRatings(
      page.map((r) => r.youtube_video_id),
      accessToken,
      fetcher,
    );
    out.units.getRating = 1;
  } catch (e) {
    log.warn("presave.like_backfill_ratings_failed", { quota: quotaKindOf(e), ...errorFields(e) });
    // Out of the day's quota at the first call: the hold is set here too, as the hook and the cron do.
    if (quotaKindOf(e) === "quota") await noteQuotaOut(env, e, log, now);
    return blind(
      quotaKindOf(e) ?? "error",
      `videos.getRating failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`,
    );
  }

  let rated = 0;
  let last = afterId;
  let cut = false;
  for (const r of page) {
    const rating = ratings.get(r.youtube_video_id) ?? "unknown";
    if (rating === "like") {
      if (!dryRun)
        await db
          .prepare(
            "UPDATE presaves SET liked_at = ?, like_error = NULL, like_next_at = NULL, like_claimed_at = NULL WHERE id = ? AND youtube_video_id = ? AND liked_at IS NULL",
          )
          .bind(now, r.id, r.youtube_video_id)
          .run();
      out.alreadyLiked++;
      out.items.push(item(r, rating, "already_liked"));
    } else if (rating === "dislike") {
      // The owner's own verdict on that video: not overridden, and not asked about again.
      if (!dryRun) {
        await db
          .prepare(
            "UPDATE presaves SET like_error = ?, like_next_at = NULL, like_attempts = MAX(like_attempts, 1) WHERE id = ? AND youtube_video_id = ? AND liked_at IS NULL",
          )
          .bind(errText("disliked", "disliked on YouTube; left alone"), r.id, r.youtube_video_id)
          .run();
      }
      out.items.push(item(r, rating, "left_disliked"));
    } else if (dryRun) {
      out.wouldLike++;
      out.units.rate += 50;
      out.items.push(item(r, rating, "would_like"));
    } else {
      if (rated >= limit) {
        cut = true;
        break;
      }
      const res = await likePresaveVideo(env, r.id, {
        log,
        now,
        fetcher,
        accessToken,
        force: true,
        rating,
      });
      if (res.outcome === "skipped") {
        out.items.push(item(r, rating, "not_tried", "another run is liking it now"));
      } else {
        rated++;
        out.units.rate += res.units;
        if (res.outcome === "liked") out.liked++;
        else out.failed++;
        out.items.push(item(r, rating, res.outcome === "liked" ? "liked" : "failed", res.error));
        if (res.outcome === "quota" || res.outcome === "rate_limit") {
          out.stoppedBy = res.outcome;
          out.message = res.error;
          break;
        }
      }
    }
    last = r.id;
  }
  if (!out.stoppedBy) out.nextAfterId = cut || more ? last : null;
  log.info("presave.like_backfill", {
    dryRun,
    total,
    page: page.length,
    liked: out.liked,
    alreadyLiked: out.alreadyLiked,
    wouldLike: out.wouldLike,
    failed: out.failed,
    stoppedBy: out.stoppedBy,
    units: out.units,
  });
  return out;
}
