/**
 * Apple Music timing backstop, the D1 / KV side (spec
 * docs/superpowers/specs/2026-10-14-apple-timing-backstop-design.md).
 *
 *   applyAppleCuesToRequest  run the pass (lib/apple-cues.ts) over one
 *                            request's stored list and store the result.
 *                            Called by saveMkvidTracks, the "Queue for
 *                            re-check now" button and the one-off.
 *   appleBackstopBatch       the one-off over every held set: the pass from
 *                            the stored list, then pull each still-held set's
 *                            recheck into the next few hours (never pushes
 *                            one out). Cursor + totals in KV, idempotent.
 *
 * Best effort throughout: a failure leaves the list as 1001tl made it.
 */

import type { Env } from "../types";
import { dbOf, parseJson } from "./db";
import { errorFields, type Logger } from "./log";
import { getAppSettings } from "./app-settings";
import { planAppleCues, withoutAppleCues, type CueRow } from "./apple-cues";
import { fetchAppleAlbum, type AppleFetchDeps } from "./apple-album";
import {
  DISCOVERED_SQL,
  isOldSet,
  isTimedEnough,
  setAgeReference,
  timedRowCounts,
  TIMED_SQL,
} from "./mkvid-readiness";
import { readCachedTracklistEntry, tracklistSlug } from "./tracklist-cache";
import { setDateFromUrl } from "./pool-settings";

export type AppleOutcome =
  | "applied" // cues filled from the album
  | "skipped" // album read but not used (note says why)
  | "timed" // the 1001tl cues alone are enough: nothing to do
  | "untrusted" // names are not trusted (nothing to match on)
  | "no_album" // no Apple Music album known for the set
  | "album_unavailable" // the album could not be read
  | "disabled"
  | "no_list";

export type AppleResult = {
  outcome: AppleOutcome;
  filled: number;
  /** Whether the stored list is timed-enough (the 90 % gate, 75 % for an old set) after the pass. */
  timedEnough: boolean;
  /** Whether an Apple album was known for the set (link found). */
  hadAlbum: boolean;
  note: string | null;
};

type StoredRow = {
  id: string;
  set_url: string;
  replaces_video_id: string | null;
  tracks: string;
  trusted: number;
  scraped_at: number;
  apple_album_url: string | null;
  apple_cues: number | null;
  apple_note: string | null;
  replaced_seconds: number | null;
  audio_max_seconds: number | null;
  set_date: string | null;
  discovered: number;
};

/** Length of the audio mkvid renders from, best known first: the video this request replaces, else the longest player on the set page. */
function sourceSecondsOf(r: StoredRow): number | null {
  const s = Number(r.replaced_seconds ?? 0) || Number(r.audio_max_seconds ?? 0);
  return s > 0 ? s : null;
}

export async function applyAppleCuesToRequest(
  env: Env,
  requestId: string,
  deps: AppleFetchDeps & { log?: Logger } = {},
): Promise<AppleResult> {
  const db = dbOf(env);
  const r = await db
    .prepare(
      `SELECT r.id AS id, r.set_url AS set_url, r.replaces_video_id AS replaces_video_id, t.tracks AS tracks, t.trusted AS trusted,
              r.set_date AS set_date, ${DISCOVERED_SQL} AS discovered,
              t.scraped_at AS scraped_at, t.apple_album_url AS apple_album_url, t.apple_cues AS apple_cues, t.apple_note AS apple_note,
              (SELECT vm.duration_seconds FROM video_meta vm WHERE vm.video_id = r.replaces_video_id) AS replaced_seconds,
              (SELECT f.audio_max_seconds FROM set_media_facts f WHERE f.set_url = r.set_url) AS audio_max_seconds
         FROM mkvid_requests r JOIN mkvid_request_tracks t ON t.request_id = r.id WHERE r.id = ?`,
    )
    .bind(requestId)
    .first<StoredRow>();
  const none = (outcome: AppleOutcome): AppleResult => ({
    outcome,
    filled: 0,
    timedEnough: false,
    hadAlbum: false,
    note: null,
  });
  if (!r) return none("no_list");
  const stored = parseJson<CueRow[] | null>(r.tracks, null);
  if (!Array.isArray(stored) || !stored.length) return none("no_list");
  const reset = withoutAppleCues(stored);
  const oldSet = isOldSet(setAgeReference(r.set_date, Number(r.discovered)));

  // Store a result, only over the list it was computed from (a save in between wins).
  const store = async (
    tracks: CueRow[],
    filled: number,
    note: string | null,
    albumUrl: string | null,
  ) => {
    const { baseRows, timedRows } = timedRowCounts(tracks);
    const changed =
      JSON.stringify(tracks) !== r.tracks ||
      Number(r.apple_cues ?? 0) !== filled ||
      (r.apple_note ?? null) !== note ||
      (albumUrl !== null && albumUrl !== r.apple_album_url);
    if (changed)
      await db
        .prepare(
          `UPDATE mkvid_request_tracks SET tracks = ?, base_rows = ?, timed_rows = ?, apple_cues = ?, apple_note = ?,
                  apple_album_url = COALESCE(?, apple_album_url)
            WHERE request_id = ? AND scraped_at = ? AND tracks = ?`,
        )
        .bind(
          JSON.stringify(tracks),
          baseRows,
          timedRows,
          filled,
          note,
          albumUrl,
          r.id,
          r.scraped_at,
          r.tracks,
        )
        .run();
    return isTimedEnough(baseRows, timedRows, oldSet);
  };

  const own = timedRowCounts(reset);
  // The 90 % test even for an old set: one that passes on 75 % still takes what the album can fill.
  if (isTimedEnough(own.baseRows, own.timedRows))
    return { ...none("timed"), timedEnough: await store(reset, 0, null, null) };
  const settings = (await getAppSettings(env)).appleCues;
  if (!settings.enabled)
    return { ...none("disabled"), timedEnough: await store(reset, 0, null, null) };
  if (Number(r.trusted) !== 1)
    return { ...none("untrusted"), timedEnough: await store(reset, 0, null, null) };

  let albumUrl = r.apple_album_url;
  let foundUrl: string | null = null;
  if (!albumUrl) {
    try {
      albumUrl =
        (await readCachedTracklistEntry(env, tracklistSlug(r.set_url)))?.value.setAppleLink ?? null;
      foundUrl = albumUrl;
    } catch {
      albumUrl = null;
    }
  }
  if (!albumUrl) {
    const note = "no Apple Music album known for this set";
    return { ...none("no_album"), note, timedEnough: await store(reset, 0, note, null) };
  }
  const album = await fetchAppleAlbum(env, albumUrl, deps);
  if (!album) {
    const note = "the Apple Music album could not be read";
    return {
      ...none("album_unavailable"),
      hadAlbum: true,
      note,
      timedEnough: await store(reset, 0, note, foundUrl),
    };
  }
  const plan = planAppleCues(reset, album.tracks, {
    minMatchShare: settings.minMatchShare,
    tolerancePct: settings.lengthTolerancePct,
    toleranceSeconds: settings.lengthToleranceMinutes * 60,
    sourceSeconds: sourceSecondsOf(r),
  });
  if (!plan.used)
    deps.log?.info("apple.album_skipped", { requestId, setUrl: r.set_url, note: plan.note });
  const timedEnough = await store(plan.tracks, plan.filled, plan.note, foundUrl);
  return {
    outcome: plan.used ? "applied" : "skipped",
    filled: plan.filled,
    timedEnough,
    hadAlbum: true,
    note: plan.note,
  };
}

/** Never throws: what the save path and the routes call. */
export async function tryApplyAppleCues(
  env: Env,
  requestId: string,
  deps: AppleFetchDeps & { log?: Logger } = {},
): Promise<AppleResult | null> {
  try {
    return await applyAppleCuesToRequest(env, requestId, deps);
  } catch (e) {
    deps.log?.warn("apple.pass_failed", { requestId, ...errorFields(e) });
    return null;
  }
}

// --- the one-off ---------------------------------------------------------------

export const APPLE_BACKSTOP_KEY = "apple:backstop:v1";
/** The first pulled-in recheck is due this long after the run starts, then one every SPACING. */
export const BACKSTOP_FIRST_DUE_SECONDS = 10 * 60;
export const BACKSTOP_SPACING_SECONDS = 60;

export type BackstopTotals = {
  startedAt: number;
  cursor: number;
  done: boolean;
  evaluated: number;
  withAlbum: number;
  unblocked: number;
  stillHeld: number;
  pulledIn: number;
  failed: number;
  updatedAt: number;
};

/** Held = a pending request whose stored list is not timed-enough (HELD_UNTIMED_SQL, every set). */
const HELD_SQL = `SELECT r.rowid AS rid, r.id AS id, r.set_url AS set_url FROM mkvid_requests r
  JOIN mkvid_request_tracks t ON t.request_id = r.id
  WHERE r.status = 'pending' AND NOT COALESCE(${TIMED_SQL}, 0) AND r.rowid > ? ORDER BY r.rowid LIMIT ?`;

/**
 * One batch of the one-off. `restart` starts over from the first held set
 * (harmless: the pass is idempotent and the pull-in never pushes a recheck out).
 */
export async function appleBackstopBatch(
  env: Env,
  opts: { limit?: number; restart?: boolean; now?: number; log?: Logger } & AppleFetchDeps = {},
): Promise<{
  batch: Omit<BackstopTotals, "startedAt" | "cursor" | "done" | "updatedAt">;
  totals: BackstopTotals;
}> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const limit = Math.max(1, Math.min(50, Math.floor(opts.limit ?? 20)));
  const prev = opts.restart
    ? null
    : ((await env.CACHE.get(APPLE_BACKSTOP_KEY, "json")) as BackstopTotals | null);
  const totals: BackstopTotals = prev ?? {
    startedAt: now,
    cursor: 0,
    done: false,
    evaluated: 0,
    withAlbum: 0,
    unblocked: 0,
    stillHeld: 0,
    pulledIn: 0,
    failed: 0,
    updatedAt: now,
  };
  const batch = { evaluated: 0, withAlbum: 0, unblocked: 0, stillHeld: 0, pulledIn: 0, failed: 0 };
  if (totals.done) return { batch, totals };
  const db = dbOf(env);
  const rows = (
    await db
      .prepare(HELD_SQL)
      .bind(totals.cursor, limit)
      .all<{ rid: number; id: string; set_url: string }>()
  ).results;
  for (const row of rows) {
    totals.cursor = Number(row.rid);
    const res = await tryApplyAppleCues(env, row.id, opts);
    batch.evaluated++;
    if (!res) batch.failed++;
    if (res?.hadAlbum) batch.withAlbum++;
    if (res?.timedEnough) {
      batch.unblocked++;
      continue;
    }
    batch.stillHeld++;
    // Its weekly recheck, pulled in to a slot of its own over the next hours (the scheduler's budget still decides).
    const due =
      totals.startedAt +
      BACKSTOP_FIRST_DUE_SECONDS +
      (totals.pulledIn + batch.pulledIn) * BACKSTOP_SPACING_SECONDS;
    const r = await db
      .prepare(
        `INSERT INTO set_schedule (url, set_date, next_due_at, last_fetched_at, has_id_rows, no_good_video, updated_at)
         VALUES (?, ?, ?, NULL, 0, 0, ?)
         ON CONFLICT(url) DO UPDATE SET next_due_at = excluded.next_due_at, updated_at = excluded.updated_at
           WHERE set_schedule.next_due_at IS NULL OR set_schedule.next_due_at > excluded.next_due_at`,
      )
      .bind(row.set_url, setDateFromUrl(row.set_url), due, now)
      .run();
    if ((r.meta.changes ?? 0) > 0) batch.pulledIn++;
  }
  for (const k of Object.keys(batch) as Array<keyof typeof batch>) totals[k] += batch[k];
  totals.done = rows.length < limit;
  totals.updatedAt = now;
  await env.CACHE.put(APPLE_BACKSTOP_KEY, JSON.stringify(totals), { expirationTtl: 30 * 86400 });
  opts.log?.info("apple.backstop_batch", { ...batch, cursor: totals.cursor, done: totals.done });
  return { batch, totals };
}

/** Cron: carry an unfinished one-off on by one batch a tick (so a single trigger finishes by itself). */
export async function continueAppleBackstop(env: Env, log?: Logger): Promise<boolean> {
  const t = (await env.CACHE.get(APPLE_BACKSTOP_KEY, "json")) as BackstopTotals | null;
  if (!t || t.done) return false;
  await appleBackstopBatch(env, { limit: 15, log });
  return true;
}
