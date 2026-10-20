/**
 * The Pre-saves playlist: every pre-save that has a YouTube video (found on
 * 1001tracklists, or ripped and uploaded by mkvid) goes into one playlist, named
 * by presave.playlistTitle, so the owner has them all in one place.
 *
 * Getting a video only queues it (`queuePresavePlaylist`, from
 * onPresaveResolved: status `pending`, due now). The insert is the cron's,
 * `retryDuePresavePlaylist`, a few a tick, oldest pre-save first, so the existing
 * pre-saves (migration 0032 marks them pending) trickle in without starving
 * the playlists that rank higher. A run lists the playlist once and marks the
 * videos already in it `added` without an insert. A video is never removed:
 * dismissing a pre-save or replacing its video leaves what was added.
 *
 * Quota: playlistItems.insert 50 units, playlistItems.list 1 per page. A quota
 * reply holds the rest of the pre-saves until the next quota day; any other
 * failure waits 1 h x the tries so far and is `failed` after 5.
 *
 * Imports neither lib/presave nor lib/presave-like (the latter imports this).
 */

import type { Env } from "../types";
import { dbOf, parseJson } from "./db";
import { errorFields, type Logger } from "./log";
import { getAppSettings } from "./app-settings";
import { getAccessToken } from "./google-oauth";
import { quotaDayEnd } from "./mkvid";
import { cachePlaylistVideoIds, findOrCreatePlaylist } from "./playlist-cache";
import {
  addVideoToPlaylist,
  isPermanentInsertError,
  isQuotaError,
  YouTubeApiError,
  listPlaylistVideoIds,
  PlaylistNotFoundError,
} from "./youtube-playlists";
import { getQuotaOut, noteQuotaOut } from "./youtube-quota";
import { quotaGate } from "./quota-priority";

/** KV (SUBS): the playlist's id and the title it was found under. */
export const PRESAVE_PLAYLIST_KEY = "presave:playlist_id";
export const PRESAVE_PLAYLIST_DESCRIPTION =
  "Every pre-saved track that has a YouTube video. Updated automatically.";
const DEFAULT_LIMIT = 10;
const MAX_ATTEMPTS = 5;
const BACKOFF_MS = 3_600_000;
/** A row is claimed for this long while it is inserted, so an overlapping run does not insert it twice. */
const CLAIM_MS = 10 * 60_000;

/**
 * A pre-save just got its video: queue it for the playlist (due now). A video
 * already added stays added unless `replaced` (the pre-save got another video).
 * Never throws.
 */
export async function queuePresavePlaylist(
  env: Env,
  presaveId: number,
  now = Date.now(),
  replaced = false,
): Promise<void> {
  try {
    await dbOf(env)
      .prepare(
        `UPDATE presaves SET presave_playlist_status = 'pending', presave_playlist_next_at = ?,
           presave_playlist_attempts = 0, presave_playlist_error = NULL
         WHERE id = ? AND youtube_video_id IS NOT NULL
           AND (? = 1 OR presave_playlist_status IS NULL OR presave_playlist_status != 'added')`,
      )
      .bind(now, presaveId, replaced ? 1 : 0)
      .run();
  } catch {
    // Best effort: migration 0032 not applied yet must not break the pre-save.
  }
}

type StoredPlaylist = { playlistId: string; title: string };

/** Find the playlist by title (settings), else create it; the id is kept in SUBS. */
async function resolvePlaylist(
  env: Env,
  accessToken: string,
  log: Logger,
  fresh = false,
): Promise<{ id: string; justCreated: boolean }> {
  const s = (await getAppSettings(env)).presave;
  const stored = fresh
    ? null
    : parseJson<StoredPlaylist | null>(await env.SUBS.get(PRESAVE_PLAYLIST_KEY), null);
  if (stored && typeof stored.playlistId === "string" && stored.title === s.playlistTitle) {
    return { id: stored.playlistId, justCreated: false };
  }
  const r = await findOrCreatePlaylist(
    {
      title: s.playlistTitle,
      description: PRESAVE_PLAYLIST_DESCRIPTION,
      privacyStatus: s.playlistPrivacy,
      logCtx: { presavePlaylist: true },
    },
    accessToken,
    log,
  );
  if (!r) throw new Error(`playlist ${JSON.stringify(s.playlistTitle)} could not be resolved`);
  await env.SUBS.put(
    PRESAVE_PLAYLIST_KEY,
    JSON.stringify({ playlistId: r.id, title: s.playlistTitle } satisfies StoredPlaylist),
  );
  return r;
}

/** A refusal retrying cannot fix; a 403 rate limit is not one. */
function isPermanent(e: unknown): boolean {
  return (
    isPermanentInsertError(e) &&
    !(e instanceof YouTubeApiError && /rate|limit/i.test(e.reason ?? ""))
  );
}

type DueRow = { id: number; youtube_video_id: string; presave_playlist_attempts: number };

/**
 * The cron step: inserts the due pre-saves' videos into the playlist, oldest
 * first, `limit` (default 10) a run. Nothing is asked of YouTube while the
 * quota hold is set or when nothing is due. Never throws.
 */
export async function retryDuePresavePlaylist(
  env: Env,
  log: Logger,
  opts: { limit?: number; nowMs?: number } = {},
): Promise<{ added: number; skipped: number; failed: number }> {
  const out = { added: 0, skipped: 0, failed: 0 };
  try {
    if (!env.DB) return out;
    const now = opts.nowMs ?? Date.now();
    const db = dbOf(env);
    const due = (
      await db
        .prepare(
          `SELECT id, youtube_video_id, presave_playlist_attempts FROM presaves
           WHERE presave_playlist_status = 'pending' AND youtube_video_id IS NOT NULL
             AND COALESCE(presave_playlist_next_at, 0) <= ?
           ORDER BY created_at, id LIMIT ?`,
        )
        .bind(now, opts.limit ?? DEFAULT_LIMIT)
        .all<DueRow>()
    ).results;
    if (due.length === 0) return out;
    if (await getQuotaOut(env, now)) return out;
    // Its turn at the quota (lib/quota-priority.ts), asked once for the run: held, the rows stay due as they are.
    const gate = await quotaGate(env, "presave_playlists", 50, now);
    if (!gate.ok) {
      log.info("presave.playlist_held", { due: due.length, reason: gate.reason });
      return out;
    }
    const tok = await getAccessToken(env).catch(() => null);
    if (!tok) return out;
    const token = tok.accessToken;

    let pl = await resolvePlaylist(env, token, log);
    // The playlist's videos, listed once per run (a new playlist is known empty).
    let existing: Set<string> | null = pl.justCreated ? new Set() : null;
    const listed = async (): Promise<Set<string>> =>
      (existing ??= await listPlaylistVideoIds(pl.id, token));

    for (const row of due) {
      const videoId = row.youtube_video_id;
      // Taken for this run first, so an overlapping run does not insert it twice.
      const taken = await db
        .prepare(
          `UPDATE presaves SET presave_playlist_next_at = ?
           WHERE id = ? AND presave_playlist_status = 'pending' AND youtube_video_id = ?
             AND COALESCE(presave_playlist_next_at, 0) <= ?`,
        )
        .bind(now + CLAIM_MS, row.id, videoId, now)
        .run();
      if ((taken.meta.changes ?? 0) === 0) continue;
      try {
        // Another pre-save with this video was added already (a re-ripped or shared video).
        const sibling = await db
          .prepare(
            "SELECT 1 AS x FROM presaves WHERE youtube_video_id = ? AND presave_playlist_status = 'added' AND id != ?",
          )
          .bind(videoId, row.id)
          .first();
        if (sibling) {
          await markAdded(env, row.id);
          out.skipped++;
          continue;
        }
        let result: "added" | "skipped" | null = null;
        for (let tries = 0; result === null; tries++) {
          try {
            result = (await listed()).has(videoId) ? "skipped" : "added";
            if (result === "added") await addVideoToPlaylist(pl.id, videoId, token);
          } catch (e) {
            // Deleted on YouTube (a stale id): find it again by title or create it, and go again once; not a failed try.
            if (!(e instanceof PlaylistNotFoundError) || tries > 0) throw e;
            log.warn("presave.playlist_stale", { stalePlaylistId: pl.id });
            result = null;
            pl = await resolvePlaylist(env, token, log, true);
            existing = pl.justCreated ? new Set() : null;
          }
        }
        if (result === "added") {
          (await listed()).add(videoId);
          out.added++;
        } else out.skipped++;
        await markAdded(env, row.id);
      } catch (e) {
        const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
        if (isQuotaError(e)) {
          // Not the video's fault: it waits for the next quota day, no try counted.
          await noteQuotaOut(env, e, log);
          await db
            .prepare(
              "UPDATE presaves SET presave_playlist_next_at = ?, presave_playlist_error = ? WHERE id = ?",
            )
            .bind(quotaDayEnd(now) * 1000, `quota: ${msg}`, row.id)
            .run();
          log.warn("presave.playlist_quota", { id: row.id, videoId });
          break;
        }
        const attempts = row.presave_playlist_attempts + 1;
        // YouTube refused this video for good (deleted, private, ...): no point in four more tries.
        const giveUp = attempts >= MAX_ATTEMPTS || isPermanent(e);
        await db
          .prepare(
            `UPDATE presaves SET presave_playlist_status = ?, presave_playlist_attempts = ?,
               presave_playlist_next_at = ?, presave_playlist_error = ? WHERE id = ?`,
          )
          .bind(
            giveUp ? "failed" : "pending",
            attempts,
            giveUp ? null : now + attempts * BACKOFF_MS,
            msg,
            row.id,
          )
          .run();
        if (giveUp) out.failed++;
        log.warn("presave.playlist_insert_failed", {
          id: row.id,
          videoId,
          attempts,
          ...errorFields(e),
        });
      }
    }
    // What the artist / combined playlists' cache holds for this playlist stays true to what was just listed.
    if (existing) await cachePlaylistVideoIds(env, pl.id, existing).catch(() => undefined);
  } catch (e) {
    log.warn("presave.playlist_threw", errorFields(e));
  }
  return out;
}

async function markAdded(env: Env, id: number): Promise<void> {
  await dbOf(env)
    .prepare(
      `UPDATE presaves SET presave_playlist_status = 'added', presave_playlist_next_at = NULL,
         presave_playlist_error = NULL, presave_playlist_attempts = 0 WHERE id = ?`,
    )
    .bind(id)
    .run();
}
