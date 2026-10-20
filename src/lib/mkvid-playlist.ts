/**
 * A set upload on its way into the playlists: the artist playlist (in set-date
 * order), the combined mirror, the retirement of the video a recreation
 * replaces, and the `added` audit row. Shared by `/mkvid/complete`
 * (lib/mkvid.ts completeMkvidRequest) and the cron's retry of a failed insert.
 *
 * The upload is already on YouTube when mkvid reports it, so a playlist insert
 * YouTube refuses never fails the completion: the request is `done` with
 * `playlist_status = 'pending'` and `not_before` = when the cron tries the
 * insert again (`retryDueSetPlaylistInserts`): the next quota day for a
 * daily-quota reply, 10 min for a rate limit, a growing backoff for a 5xx or a
 * network error. Only a permanent refusal (the video is gone) stops, as
 * `failed`. A recreation's old video stays in the playlists (and on YouTube)
 * until the new one is in; `replaces_video_id` holds it meanwhile.
 *
 * Idempotent: a redelivered completion of a `done` request is refused before
 * anything here runs (mkvid treats the 409 as delivered), and a retry finds an
 * insert that did land in the cached listing (`duplicate`).
 */
import type { Env } from "../types";
import { dbOf } from "./db";
import { errorFields, type Logger } from "./log";
import { notifyPlaylistAdd } from "./playlist-add-push";
import { flushPlaylistAdditions, type PlaylistAdditionRecord } from "./playlist-audit";
import {
  addToCombined,
  flushCombined,
  openCombinedPlaylist,
  type CombinedAdditionStatus,
  type CombinedHandle,
} from "./combined-playlist";
import {
  cachePlaylistVideoIds,
  findOrCreatePlaylist,
  getCachedPlaylistVideoIds,
} from "./playlist-cache";
import {
  isPermanentInsertError,
  isQuotaError,
  PlaylistNotFoundError,
  type YouTubeApiError,
} from "./youtube-playlists";
import { quotaKind } from "./youtube-error";
import { getQuotaOut, noteQuotaOut } from "./youtube-quota";
import { getAccessToken } from "./google-oauth";
import { insertInOrder } from "./playlist-order-store";
import { markInPlaylist } from "./playlist-blocklist";
import { getTracklistRow } from "./sync-store";
import { retireReplacedVideo, retireSupersededOldVideo } from "./mkvid-recreate";
import { quotaDayEnd } from "./mkvid";

/** What a set upload's playlist step needs, from the completion or the stored request. */
export type SetPlaylistTarget = {
  requestId: string;
  slug: string;
  setUrl: string;
  artistName: string | null;
  setTitle: string | null;
  source: string;
  videoId: string;
  videoUrl: string | null;
  privacy: string | null;
  style: string | null;
  /** A recreation: the old video, retired once the new one is in. */
  replaces: { videoId: string; oldStyle: string | null } | null;
};

export type PlaylistFailureKind = "quota" | "rate_limit" | "transient" | "permanent";

export type SetPlaylistOutcome =
  | {
      ok: true;
      playlistId: string;
      playlistStatus: "added" | "duplicate";
      combinedStatus: CombinedAdditionStatus;
      replacedVideoId: string | null;
    }
  | {
      ok: false;
      kind: PlaylistFailureKind;
      /** The stored, readable note (the request's `error`). */
      error: string;
      /** When the cron tries again (unix s); null for a permanent refusal. */
      retryAt: number | null;
    };

/** A failed transient insert waits this long after its first failure, doubling per failure ... */
const RETRY_MIN_SECONDS = 600;
/** ... up to this. */
const RETRY_MAX_SECONDS = 6 * 3600;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** The failure class of a caught error: a 403 quota / rate-limit reply, a permanent refusal, or anything else (5xx, network). */
export function playlistFailureKind(e: unknown): PlaylistFailureKind {
  if (isQuotaError(e)) return quotaKind((e as YouTubeApiError).reason) ?? "quota";
  return isPermanentInsertError(e) ? "permanent" : "transient";
}

/** When the cron tries again (unix s) after the `tries`-th failure of this kind; null = never by itself. */
export function setPlaylistRetryAt(
  kind: PlaylistFailureKind,
  tries: number,
  now: number,
): number | null {
  if (kind === "permanent") return null;
  if (kind === "quota") return quotaDayEnd(now * 1000);
  if (kind === "rate_limit") return now + RETRY_MIN_SECONDS;
  const wait = RETRY_MIN_SECONDS * 2 ** Math.max(0, Math.min(10, tries - 1));
  return now + Math.min(RETRY_MAX_SECONDS, wait);
}

/** The stored note: says the insert waits and is tried again by itself, or that YouTube refused it for good. */
export function playlistNote(kind: PlaylistFailureKind, e: unknown): string {
  if (kind === "quota")
    return "playlist insert waits: YouTube's daily quota is used up; it resets at midnight Pacific time and the insert is tried again by itself";
  if (kind === "rate_limit")
    return "playlist insert waits: YouTube is limiting requests; the insert is tried again by itself in a few minutes";
  const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 200);
  return kind === "permanent"
    ? `playlist insert refused by YouTube: ${msg}`
    : `playlist insert failed (${msg}); it is tried again by itself`;
}

/**
 * The artist playlist insert and everything after it. Throws only on the
 * artist playlist (resolve, list, insert); the combined mirror is best-effort
 * like the sync's (its backfill catches up).
 */
async function addToPlaylists(
  env: Env,
  t: SetPlaylistTarget,
  accessToken: string,
  log: Logger,
): Promise<Extract<SetPlaylistOutcome, { ok: true }>> {
  const db = dbOf(env);
  // Artist playlist: reuse the sync's, or resolve/create it the same way the sync would.
  const artistName = t.artistName ?? t.slug;
  const playlistTitle = `${artistName} (1001tklists)`;
  const syncRow = await db
    .prepare("SELECT playlist_id FROM sub_sync WHERE slug = ?")
    .bind(t.slug)
    .first<{ playlist_id: string | null }>();
  let playlistId = syncRow?.playlist_id ?? null;
  let justCreated = false;
  const resolvePlaylist = async () => {
    const r = await findOrCreatePlaylist(
      {
        title: playlistTitle,
        description: `Every set ${artistName} has a YouTube recording for on 1001tracklists.`,
        logCtx: { slug: t.slug, mkvid: true },
      },
      accessToken,
      log,
    );
    if (!r) throw new Error(`playlist ${JSON.stringify(playlistTitle)} could not be resolved`);
    playlistId = r.id;
    justCreated = r.justCreated;
    await db
      .prepare(
        "INSERT INTO sub_sync (slug, playlist_id, artist_name) VALUES (?, ?, ?) ON CONFLICT(slug) DO UPDATE SET playlist_id = excluded.playlist_id",
      )
      .bind(t.slug, r.id, t.artistName)
      .run();
  };
  if (!playlistId) await resolvePlaylist();

  let existing: Set<string>;
  if (justCreated) existing = new Set();
  else {
    try {
      existing = await getCachedPlaylistVideoIds(env, playlistId!, accessToken, log);
    } catch (e) {
      if (!(e instanceof PlaylistNotFoundError)) throw e;
      await resolvePlaylist();
      existing = justCreated
        ? new Set()
        : await getCachedPlaylistVideoIds(env, playlistId!, accessToken, log);
    }
  }
  let playlistStatus: "added" | "duplicate" = "duplicate";
  if (!existing.has(t.videoId)) {
    // At the place the set's date gives it (lib/playlist-order.ts), like the sync's inserts.
    await insertInOrder(env, {
      playlistId: playlistId!,
      videoId: t.videoId,
      existing,
      accessToken,
      log,
      setUrl: t.setUrl,
    });
    existing.add(t.videoId);
    await cachePlaylistVideoIds(env, playlistId!, existing);
    await markInPlaylist(env, playlistId!, t.videoId, "mkvid");
    await notifyPlaylistAdd(
      env,
      {
        setUrl: t.setUrl,
        videoId: t.videoId,
        playlistTitle,
        via: "mkvid",
        setTitle: t.setTitle,
      },
      log,
    );
    playlistStatus = "added";
  }

  // Combined playlist mirror - best-effort, like the sync's.
  let combinedStatus: CombinedAdditionStatus = "unavailable";
  let combined: CombinedHandle | null = null;
  try {
    combined = await openCombinedPlaylist(env, accessToken, log);
    if (combined) combinedStatus = await addToCombined(env, combined, t.videoId, accessToken, log);
  } catch (e) {
    combinedStatus = "failed";
    log.warn("mkvid.combined_add_failed", {
      id: t.requestId,
      videoId: t.videoId,
      ...errorFields(e),
    });
  }

  // A recreation: the new video is in; now the old one comes out of both
  // playlists and is queued for deletion from YouTube (lib/mkvid-recreate.ts).
  if (t.replaces) {
    await retireReplacedVideo(env, {
      requestId: t.requestId,
      slug: t.slug,
      setUrl: t.setUrl,
      oldVideoId: t.replaces.videoId,
      oldStyle: t.replaces.oldStyle,
      newVideoId: t.videoId,
      playlistId: playlistId!,
      playlistVideoIds: existing,
      combined,
      combinedOk: combinedStatus !== "failed" && combinedStatus !== "unavailable",
      accessToken,
      log,
    });
  }
  if (combined) {
    try {
      await flushCombined(env, combined, log);
    } catch (e) {
      log.warn("mkvid.combined_flush_failed", { id: t.requestId, ...errorFields(e) });
    }
  }

  const replacedVideoId = t.replaces?.videoId ?? null;
  const record: PlaylistAdditionRecord = {
    t: new Date().toISOString(),
    // A recreation is a swap, like a recheck that finds a better recording: the old id rides along.
    status: replacedVideoId ? "replaced" : "added",
    ...(replacedVideoId ? { previousVideoId: replacedVideoId } : {}),
    slug: t.slug,
    artistName: t.artistName,
    setUrl: t.setUrl,
    videoId: t.videoId,
    videoUrl: t.videoUrl ?? `https://www.youtube.com/watch?v=${t.videoId}`,
    playlistId: playlistId!,
    playlistTitle,
    combinedStatus,
    via: "mkvid",
    trigger: replacedVideoId ? "mkvid.recreate" : "mkvid",
    message:
      `rendered by mkvid from ${t.source} (${t.privacy ?? "privacy unknown"}${t.style ? `, ${t.style}` : ""})${playlistStatus === "duplicate" ? " - already in the playlist" : ""}` +
      (replacedVideoId
        ? ` - recreated: ${replacedVideoId} removed from the playlists, deletion from YouTube requested`
        : ""),
    failureCount: null,
    meta: { ms: null },
  };
  await flushPlaylistAdditions(env, [record], log);
  return { ok: true, playlistId: playlistId!, playlistStatus, combinedStatus, replacedVideoId };
}

/**
 * `addToPlaylists` with YouTube's refusals classified instead of thrown (a
 * quota reply also sets the quota hold). While the hold is set YouTube is not
 * asked at all. `tries` = failed inserts before this one. Never throws for a
 * failure on the way to YouTube.
 */
export async function addSetToPlaylists(
  env: Env,
  t: SetPlaylistTarget,
  accessToken: string,
  log: Logger,
  tries = 0,
): Promise<SetPlaylistOutcome> {
  const now = nowSeconds();
  const hold = await getQuotaOut(env, now * 1000);
  if (hold)
    return {
      ok: false,
      kind: "quota",
      error: playlistNote("quota", null),
      retryAt: Math.max(hold.until, now + RETRY_MIN_SECONDS),
    };
  try {
    return await addToPlaylists(env, t, accessToken, log);
  } catch (e) {
    // Any failure on the way (a YouTube reply, a fetch that got none, a playlist that could not be resolved) is tried again.
    const kind = playlistFailureKind(e);
    if (kind === "quota") await noteQuotaOut(env, e, log);
    log.warn("mkvid.playlist_insert_failed", {
      id: t.requestId,
      videoId: t.videoId,
      kind,
      tries: tries + 1,
      ...errorFields(e),
    });
    return {
      ok: false,
      kind,
      error: playlistNote(kind, e),
      retryAt: setPlaylistRetryAt(kind, tries + 1, now),
    };
  }
}

// --- the cron's retry -------------------------------------------------------

type DueRow = {
  id: string;
  slug: string;
  set_url: string;
  artist_name: string | null;
  set_title: string | null;
  source: string;
  video_id: string;
  video_url: string | null;
  privacy: string | null;
  style: string | null;
  replaces_video_id: string | null;
  playlist_tries: number | null;
};

/** The style of a recreation's old video, on record since the recreate (the request's `style` is the new video's by now). */
async function awaitingStyle(env: Env, videoId: string): Promise<string | null> {
  const r = await dbOf(env)
    .prepare("SELECT style FROM mkvid_old_videos WHERE video_id = ?")
    .bind(videoId)
    .first<{ style: string | null }>();
  return r?.style ?? null;
}

/** `done` requests whose playlist insert waits and is due. */
export const DUE_SQL = `status = 'done' AND playlist_status = 'pending' AND video_id IS NOT NULL
  AND (not_before IS NULL OR not_before <= ?)`;
const RETRIES_PER_TICK = 5;

export type SetPlaylistRetryStop = "quota" | "rate_limit" | "not_connected";

/** Store a playlist outcome on a `done` request. */
export async function storeSetPlaylistOutcome(
  env: Env,
  requestId: string,
  pl: SetPlaylistOutcome,
  now: number,
): Promise<void> {
  const db = dbOf(env);
  if (pl.ok) {
    await db
      .prepare(
        "UPDATE mkvid_requests SET playlist_status = ?, error = NULL, not_before = NULL, replaces_video_id = NULL, updated_at = ? WHERE id = ?",
      )
      .bind(pl.playlistStatus, now, requestId)
      .run();
    return;
  }
  // A permanent refusal keeps the old video of a recreation where it is: the new one cannot replace it.
  await db
    .prepare(
      `UPDATE mkvid_requests SET playlist_status = ?, playlist_tries = playlist_tries + 1, error = ?, not_before = ?,
         replaces_video_id = CASE WHEN ? = 'failed' THEN NULL ELSE replaces_video_id END, updated_at = ? WHERE id = ?`,
    )
    .bind(
      pl.kind === "permanent" ? "failed" : "pending",
      pl.error,
      pl.retryAt,
      pl.kind === "permanent" ? "failed" : "pending",
      now,
      requestId,
    )
    .run();
}

/**
 * The cron step: tries the waiting playlist inserts of set uploads again once
 * they are due, a few a tick. Nothing is asked of YouTube while the quota hold
 * is set; a quota or rate-limit reply stops the step. A set that resolves to
 * another video by now (a real recording turned up) drops its insert. One
 * indexed query when none is due; never throws.
 */
export async function retryDueSetPlaylistInserts(
  env: Env,
  log: Logger,
  opts: { now?: number; limit?: number; fetcher?: typeof fetch } = {},
): Promise<{ tried: number; added: number; stoppedBy: SetPlaylistRetryStop | null }> {
  const out = { tried: 0, added: 0, stoppedBy: null as SetPlaylistRetryStop | null };
  try {
    if (!env.DB) return out;
    const now = opts.now ?? nowSeconds();
    const db = dbOf(env);
    const due = (
      await db
        .prepare(
          `SELECT id, slug, set_url, artist_name, set_title, source, video_id, video_url, privacy, style, replaces_video_id, playlist_tries
             FROM mkvid_requests WHERE ${DUE_SQL} ORDER BY COALESCE(not_before, 0), id LIMIT ?`,
        )
        .bind(now, opts.limit ?? RETRIES_PER_TICK)
        .all<DueRow>()
    ).results;
    if (due.length === 0) return out;
    // The hold is read at the real time, like the insert itself does.
    if (await getQuotaOut(env)) return { ...out, stoppedBy: "quota" };
    const tok = await getAccessToken(env, opts.fetcher).catch(() => null);
    if (!tok) return { ...out, stoppedBy: "not_connected" };
    for (const row of due) {
      // Taken for this tick first, so an overlapping tick does not insert it twice.
      const taken = await db
        .prepare(`UPDATE mkvid_requests SET not_before = ? WHERE id = ? AND ${DUE_SQL}`)
        .bind(now + RETRY_MIN_SECONDS, row.id, now)
        .run();
      if ((taken.meta.changes ?? 0) === 0) continue;
      const tl = await getTracklistRow(env, row.slug, row.set_url);
      if (tl?.video_id && tl.video_id !== row.video_id) {
        // A real recording (or another upload) took the set over meanwhile: this video is not wanted in the playlists.
        if (row.replaces_video_id && row.replaces_video_id !== tl.video_id)
          await retireSupersededOldVideo(env, {
            requestId: row.id,
            slug: row.slug,
            setUrl: row.set_url,
            oldVideoId: row.replaces_video_id,
            replacedBy: tl.video_id,
            accessToken: tok.accessToken,
            log,
          });
        await db
          .prepare(
            "UPDATE mkvid_requests SET playlist_status = NULL, replaces_video_id = NULL, not_before = NULL, error = ?, updated_at = ? WHERE id = ?",
          )
          .bind(`set now resolves to ${tl.video_id}: the playlist insert was dropped`, now, row.id)
          .run();
        log.info("mkvid.playlist_retry_dropped", {
          id: row.id,
          videoId: row.video_id,
          now: tl.video_id,
        });
        continue;
      }
      out.tried++;
      const pl = await addSetToPlaylists(
        env,
        {
          requestId: row.id,
          slug: row.slug,
          setUrl: row.set_url,
          artistName: row.artist_name,
          setTitle: row.set_title,
          source: row.source,
          videoId: row.video_id,
          videoUrl: row.video_url,
          privacy: row.privacy,
          style: row.style,
          replaces: row.replaces_video_id
            ? {
                videoId: row.replaces_video_id,
                oldStyle: await awaitingStyle(env, row.replaces_video_id),
              }
            : null,
        },
        tok.accessToken,
        log,
        Number(row.playlist_tries ?? 0),
      );
      await storeSetPlaylistOutcome(env, row.id, pl, nowSeconds());
      log.info("mkvid.playlist_retried", {
        id: row.id,
        videoId: row.video_id,
        playlistStatus: pl.ok ? pl.playlistStatus : pl.kind,
        retryAt: pl.ok ? null : pl.retryAt,
      });
      if (pl.ok) {
        out.added++;
        continue;
      }
      if (pl.kind === "quota" || pl.kind === "rate_limit") {
        out.stoppedBy = pl.kind;
        break;
      }
    }
  } catch (e) {
    log.warn("mkvid.playlist_retries_threw", errorFields(e));
  }
  return out;
}
