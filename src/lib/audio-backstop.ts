/**
 * Audio cue estimation, the D1 side (the pure part is lib/audio-cues.ts, the
 * routes routes/mkvid-audio.ts, the work mkvid's lib/audio-cues.ts).
 *
 *   claimAudioJob       hand mkvid the next eligible held set: its recording
 *                       and its rows. Eligible (AUDIO_ELIGIBLE_SQL): pending,
 *                       verified, held for too few cue times after the Apple
 *                       Music backstop had its pass, at least 90 % of its
 *                       base rows identified, and at least 4 weeks past its
 *                       set date (else its discovery, the 5-month rule's
 *                       basis). Queue order, one claim per set at a time
 *                       (renewed by progress, AUDIO_CLAIM_TTL_SECONDS).
 *   completeAudioJob    gate mkvid's per-row estimates (AUDIO_GATE), store
 *                       the gated ones and fill the list from them.
 *   failAudioJob        a run that could not finish (recording or track
 *                       downloads failing, YouTube throttling): back off and
 *                       try the set again later. A set is never given up.
 *   applyAudioCuesToRequest / audioFill
 *                       put the stored estimates into the stored list, also on
 *                       every save of the list (the Apple pass calls audioFill),
 *                       so a recheck keeps them; they never overwrite a 1001tl
 *                       or Apple cue, and they are dropped once the 1001tl cues
 *                       alone reach 90 %.
 *
 * Filled rows count in `timed_rows` like any other cue, so the existing timed
 * gate (90 %, 75 % for a set 5 months old) releases a set they complete.
 */

import type { Env } from "../types";
import { dbOf, parseJson } from "./db";
import type { Logger } from "./log";
import { withoutAppleCues, type CueRow } from "./apple-cues";
import {
  AUDIO_CLAIM_TTL_SECONDS,
  AUDIO_DROPPED_NOTE,
  gateAudioReports,
  overlayAudioCues,
  parseAudioEstimates,
  withoutAudioCues,
  type AudioRowReport,
} from "./audio-cues";
import {
  DISCOVERED_SQL,
  isOldSet,
  isTimedEnough,
  SET_AGE_REFERENCE_SQL,
  setAgeReference,
  timedRowCounts,
  timedSql,
} from "./mkvid-readiness";

/** A set is estimated only once it is this far past its date (else its discovery). */
export const AUDIO_MIN_AGE_SECONDS = 28 * 86400;
/** ...and only when at least this share of its base rows is identified. */
export const AUDIO_MIN_IDENTIFIED_SHARE = 0.9;
/** After a run with every track's audio found, the set is not tried again for this long... */
export const AUDIO_REDO_SECONDS = 30 * 86400;
/** ...and after a run that missed some tracks' audio, this long (it may turn up). */
export const AUDIO_PARTIAL_REDO_SECONDS = 7 * 86400;
/** A failed run is retried after this, doubling per failure in a row, up to AUDIO_RETRY_MAX_SECONDS. */
export const AUDIO_RETRY_MIN_SECONDS = 30 * 60;
export const AUDIO_RETRY_MAX_SECONDS = 24 * 3600;
/** Recording sources a job can be handed out for (mkvid says which it can fetch right now). */
export const AUDIO_SOURCES = ["soundcloud", "hearthis"] as const;
export type AudioSource = (typeof AUDIO_SOURCES)[number];

/** Identified base rows of the stored list `t` (no "w/" row, not ID). */
const IDENTIFIED_BASE_SQL = `(SELECT COUNT(*) FROM json_each(t.tracks)
  WHERE COALESCE(json_extract(value, '$.layered'), 0) != 1 AND COALESCE(json_extract(value, '$.isId'), 0) != 1)`;

/**
 * SQL condition over `mkvid_requests r JOIN mkvid_request_tracks t`: the set
 * may be estimated (whether it is due is AUDIO_DUE_SQL). `now` is written in
 * as a whole number.
 */
export function audioEligibleSql(now: number): string {
  const n = Math.floor(now);
  return `(r.status = 'pending' AND t.trusted = 1 AND t.track_count > 0
    AND NOT COALESCE(${timedSql({ now: String(n) })}, 0)
    AND (t.apple_note IS NOT NULL OR t.apple_cues > 0)
    AND ${IDENTIFIED_BASE_SQL} * 10 >= t.base_rows * ${Math.round(AUDIO_MIN_IDENTIFIED_SHARE * 10)}
    AND ${SET_AGE_REFERENCE_SQL} <= ${n - AUDIO_MIN_AGE_SECONDS})`;
}

/** Not running (or its claim lapsed) and past its retry / redo time. */
export function audioDueSql(now: number): string {
  const n = Math.floor(now);
  return `((t.audio_next_at IS NULL OR t.audio_next_at <= ${n})
    AND (t.audio_claimed_at IS NULL OR t.audio_claimed_at <= ${n - AUDIO_CLAIM_TTL_SECONDS}))`;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

export { AUDIO_CLAIM_TTL_SECONDS, AUDIO_DROPPED_NOTE };

/** One row as a job carries it. */
export type AudioJobRow = {
  index: number;
  artist: string | null;
  title: string | null;
  isId: boolean;
  layered: boolean;
  cueSeconds: number | null;
};

/** What /mkvid/audio/claim hands out. */
export type AudioJob = {
  requestId: string;
  setUrl: string;
  setTitle: string | null;
  source: string;
  sourceUrl: string;
  /** Length of the recording when tracked knows it (the video this replaces, else the set page's player). */
  sourceSeconds: number | null;
  attempts: number;
  rows: AudioJobRow[];
};

/** The run's stats as mkvid reports them, plus what tracked made of them. */
export type AudioStats = {
  /** Rows that could be estimated (base, identified, past row 0). */
  rows: number;
  /** Of those, rows whose track audio was found. */
  withAudio: number;
  /** Rows whose estimate passed the gate (stored). */
  gated: number;
  /** Rows the run could not find audio for. */
  missing: number;
  /** Track audio by where it came from (youtube, soundcloud, soulseek, cache). */
  sources: Record<string, number>;
  /** Length of the recording mkvid matched against, seconds. */
  setSeconds: number | null;
};

type TrackRow = {
  id: string;
  set_url: string;
  set_date: string | null;
  discovered: number;
  tracks: string;
  scraped_at: number;
  audio_estimates: string | null;
  audio_stats: string | null;
  replaced_seconds: number | null;
  audio_max_seconds: number | null;
};

const TRACK_ROW_SQL = `SELECT r.id AS id, r.set_url AS set_url, r.set_date AS set_date, ${DISCOVERED_SQL} AS discovered,
    t.tracks AS tracks, t.scraped_at AS scraped_at, t.audio_estimates AS audio_estimates, t.audio_stats AS audio_stats,
    (SELECT vm.duration_seconds FROM video_meta vm WHERE vm.video_id = r.replaces_video_id) AS replaced_seconds,
    (SELECT f.audio_max_seconds FROM set_media_facts f WHERE f.set_url = r.set_url) AS audio_max_seconds
  FROM mkvid_requests r JOIN mkvid_request_tracks t ON t.request_id = r.id WHERE r.id = ?`;

/** The recording's length: what mkvid matched against, else what tracked knows. */
function recordingSeconds(
  statsJson: string | null,
  fallback: { replaced_seconds: number | null; audio_max_seconds: number | null },
): number | null {
  const s = parseJson<Partial<AudioStats> | null>(statsJson, null);
  const n =
    Number(s?.setSeconds ?? 0) ||
    Number(fallback.replaced_seconds ?? 0) ||
    Number(fallback.audio_max_seconds ?? 0);
  return n > 0 ? n : null;
}

/**
 * The audio estimates' part of a pass over a stored list. `rows` must be free
 * of audio cues (withoutAudioCues) and carry the 1001tl and Apple cues it
 * keeps. When the 1001tl cues alone are timed-enough at 90 % the estimates are
 * not used and `drop` says to delete them; otherwise they fill what they can.
 */
export function audioFill<T extends CueRow>(
  rows: readonly T[],
  stored: {
    audio_estimates: string | null;
    audio_stats: string | null;
    replaced_seconds: number | null;
    audio_max_seconds: number | null;
  },
): { tracks: T[]; filled: number; drop: boolean } {
  const estimates = parseAudioEstimates(stored.audio_estimates);
  const own = timedRowCounts(withoutAppleCues(rows));
  if (isTimedEnough(own.baseRows, own.timedRows))
    return { tracks: [...rows], filled: 0, drop: estimates.length > 0 };
  if (!estimates.length) return { tracks: [...rows], filled: 0, drop: false };
  const r = overlayAudioCues(rows, estimates, {
    sourceSeconds: recordingSeconds(stored.audio_stats, stored),
  });
  return { ...r, drop: false };
}

/**
 * Put the stored estimates into the stored list (Apple cues kept), over the
 * list it read only (a save in between wins). Returns how many rows they
 * filled and whether the list is timed-enough now, or null without a list.
 */
export async function applyAudioCuesToRequest(
  env: Env,
  requestId: string,
): Promise<{ filled: number; timedEnough: boolean } | null> {
  const db = dbOf(env);
  const r = await db.prepare(TRACK_ROW_SQL).bind(requestId).first<TrackRow>();
  if (!r) return null;
  const stored = parseJson<CueRow[] | null>(r.tracks, null);
  if (!Array.isArray(stored) || !stored.length) return null;
  const fill = audioFill(withoutAudioCues(stored), r);
  const { baseRows, timedRows } = timedRowCounts(fill.tracks);
  const json = JSON.stringify(fill.tracks);
  await db
    .prepare(
      `UPDATE mkvid_request_tracks SET tracks = ?, base_rows = ?, timed_rows = ?, audio_cues = ?,
              audio_estimates = CASE WHEN ? = 1 THEN NULL ELSE audio_estimates END,
              audio_note = CASE WHEN ? = 1 THEN ? ELSE audio_note END
        WHERE request_id = ? AND scraped_at = ? AND tracks = ?`,
    )
    .bind(
      json,
      baseRows,
      timedRows,
      fill.filled,
      fill.drop ? 1 : 0,
      fill.drop ? 1 : 0,
      AUDIO_DROPPED_NOTE,
      requestId,
      r.scraped_at,
      r.tracks,
    )
    .run();
  const oldSet = isOldSet(setAgeReference(r.set_date, Number(r.discovered)));
  return { filled: fill.filled, timedEnough: isTimedEnough(baseRows, timedRows, oldSet) };
}

/** Hand out the next eligible, due set whose recording mkvid can fetch now (`sources`), or null. */
export async function claimAudioJob(
  env: Env,
  sources: readonly string[],
  opts: { now?: number; log?: Logger } = {},
): Promise<AudioJob | null> {
  const now = opts.now ?? nowSeconds();
  const kinds = sources.filter((s): s is AudioSource =>
    (AUDIO_SOURCES as readonly string[]).includes(s),
  );
  if (!kinds.length) return null;
  const db = dbOf(env);
  const row = await db
    .prepare(
      `SELECT r.id AS id, r.set_url AS set_url, r.set_title AS set_title, r.source AS source, r.source_url AS source_url,
              t.tracks AS tracks, t.audio_attempts AS attempts,
              (SELECT vm.duration_seconds FROM video_meta vm WHERE vm.video_id = r.replaces_video_id) AS replaced_seconds,
              (SELECT f.audio_max_seconds FROM set_media_facts f WHERE f.set_url = r.set_url) AS audio_max_seconds
         FROM mkvid_requests r JOIN mkvid_request_tracks t ON t.request_id = r.id
        WHERE ${audioEligibleSql(now)} AND ${audioDueSql(now)}
          AND r.source IN (${kinds.map(() => "?").join(", ")})
        ORDER BY r.sort_key DESC, r.created_at DESC, r.rowid ASC LIMIT 1`,
    )
    .bind(...kinds)
    .first<{
      id: string;
      set_url: string;
      set_title: string | null;
      source: string;
      source_url: string;
      tracks: string;
      attempts: number;
      replaced_seconds: number | null;
      audio_max_seconds: number | null;
    }>();
  if (!row) return null;
  const claimed = await db
    .prepare(
      `UPDATE mkvid_request_tracks SET audio_claimed_at = ?, audio_note = ?
        WHERE request_id = ? AND (audio_claimed_at IS NULL OR audio_claimed_at <= ?)`,
    )
    .bind(now, "estimating cue times from audio: started", row.id, now - AUDIO_CLAIM_TTL_SECONDS)
    .run();
  if ((claimed.meta.changes ?? 0) === 0) return null;
  const tracks = parseJson<CueRow[] | null>(row.tracks, null) ?? [];
  const seconds = Number(row.replaced_seconds ?? 0) || Number(row.audio_max_seconds ?? 0);
  opts.log?.info("audio_cues.claimed", {
    requestId: row.id,
    setUrl: row.set_url,
    rows: tracks.length,
  });
  return {
    requestId: row.id,
    setUrl: row.set_url,
    setTitle: row.set_title,
    source: row.source,
    sourceUrl: row.source_url,
    sourceSeconds: seconds > 0 ? seconds : null,
    attempts: Number(row.attempts ?? 0),
    rows: withoutAudioCues(tracks).map((t, index) => ({
      index,
      artist: t.artist ?? null,
      title: t.title ?? null,
      isId: !!t.isId,
      layered: !!t.layered,
      cueSeconds: typeof t.cueSeconds === "number" ? t.cueSeconds : null,
    })),
  };
}

/** Renew a running job's claim and record its progress. False when the set is not claimed (any more). */
export async function progressAudioJob(
  env: Env,
  b: { requestId: string; note?: string | null },
  now = nowSeconds(),
): Promise<boolean> {
  const r = await dbOf(env)
    .prepare(
      `UPDATE mkvid_request_tracks SET audio_claimed_at = ?, audio_note = COALESCE(?, audio_note)
        WHERE request_id = ? AND audio_claimed_at IS NOT NULL`,
    )
    .bind(
      now,
      b.note ? `estimating cue times from audio: ${b.note}`.slice(0, 300) : null,
      b.requestId,
    )
    .run();
  return (r.meta.changes ?? 0) > 0;
}

export type AudioCompleteBody = {
  requestId: string;
  /** Length of the recording mkvid matched against, seconds. */
  setSeconds?: number | null;
  rows: AudioRowReport[];
  stats?: { withAudio?: number; missing?: number; sources?: Record<string, number> };
};

export type AudioCompleteResult =
  | { status: "not_found" }
  | {
      status: "done";
      rows: number;
      gated: number;
      filled: number;
      timedEnough: boolean;
      nextAt: number;
    };

/** Gate and store a finished run, fill the list from it, and schedule the next look. */
export async function completeAudioJob(
  env: Env,
  body: AudioCompleteBody,
  opts: { now?: number; log?: Logger } = {},
): Promise<AudioCompleteResult> {
  const now = opts.now ?? nowSeconds();
  const db = dbOf(env);
  const r = await db.prepare(TRACK_ROW_SQL).bind(body.requestId).first<TrackRow>();
  if (!r) return { status: "not_found" };
  const rows = withoutAudioCues(parseJson<CueRow[] | null>(r.tracks, null) ?? []);
  const estimates = gateAudioReports(rows, body.rows);
  // Rows an estimate could fill: identified base rows past row 0 with no real (1001tl) cue.
  const estimable = rows.filter(
    (row, i) =>
      i > 0 &&
      !row.layered &&
      !row.isId &&
      !!row.title &&
      !(row.cueFrom === undefined && typeof row.cueSeconds === "number"),
  ).length;
  const missing = Math.max(0, Math.floor(body.stats?.missing ?? 0));
  const stats: AudioStats = {
    rows: estimable,
    withAudio: Math.max(0, Math.floor(body.stats?.withAudio ?? 0)),
    gated: estimates.length,
    missing,
    sources: body.stats?.sources ?? {},
    setSeconds: body.setSeconds != null && body.setSeconds > 0 ? Math.round(body.setSeconds) : null,
  };
  const nextAt = now + (missing > 0 ? AUDIO_PARTIAL_REDO_SECONDS : AUDIO_REDO_SECONDS);
  const note = `${estimates.length} of ${estimable} untimed track${estimable === 1 ? "" : "s"} placed from audio (${stats.withAudio} had audio found)`;
  await db
    .prepare(
      `UPDATE mkvid_request_tracks SET audio_estimates = ?, audio_stats = ?, audio_note = ?, audio_claimed_at = NULL,
              audio_attempts = 0, audio_ran_at = ?, audio_next_at = ?
        WHERE request_id = ?`,
    )
    .bind(JSON.stringify(estimates), JSON.stringify(stats), note, now, nextAt, body.requestId)
    .run();
  const applied = await applyAudioCuesToRequest(env, body.requestId);
  const out = {
    status: "done" as const,
    rows: estimable,
    gated: estimates.length,
    filled: applied?.filled ?? 0,
    timedEnough: applied?.timedEnough ?? false,
    nextAt,
  };
  opts.log?.info("audio_cues.completed", {
    requestId: body.requestId,
    ...out,
    withAudio: stats.withAudio,
    missing,
  });
  return out;
}

/** The wait before trying a failed set again: what mkvid asked, at least the doubling backoff, at most a day. */
export function audioRetryDelay(attempts: number, retryAfterSeconds?: number | null): number {
  const backoff = AUDIO_RETRY_MIN_SECONDS * 2 ** Math.max(0, Math.min(attempts - 1, 10));
  return Math.min(AUDIO_RETRY_MAX_SECONDS, Math.max(backoff, Math.floor(retryAfterSeconds ?? 0)));
}

/** A run that could not finish: free the claim and try the set again later (never given up). */
export async function failAudioJob(
  env: Env,
  b: { requestId: string; error: string; retryAfterSeconds?: number | null },
  opts: { now?: number; log?: Logger } = {},
): Promise<{ status: "not_found" } | { status: "retry"; attempts: number; nextAt: number }> {
  const now = opts.now ?? nowSeconds();
  const db = dbOf(env);
  const cur = await db
    .prepare("SELECT audio_attempts AS attempts FROM mkvid_request_tracks WHERE request_id = ?")
    .bind(b.requestId)
    .first<{ attempts: number }>();
  if (!cur) return { status: "not_found" };
  const attempts = Number(cur.attempts ?? 0) + 1;
  const nextAt = now + audioRetryDelay(attempts, b.retryAfterSeconds);
  await db
    .prepare(
      `UPDATE mkvid_request_tracks SET audio_claimed_at = NULL, audio_attempts = ?, audio_next_at = ?, audio_note = ?
        WHERE request_id = ?`,
    )
    .bind(attempts, nextAt, `retrying later: ${b.error}`.slice(0, 300), b.requestId)
    .run();
  opts.log?.warn("audio_cues.failed", {
    requestId: b.requestId,
    attempts,
    nextAt,
    error: b.error.slice(0, 300),
  });
  return { status: "retry", attempts, nextAt };
}

/** Counts for /mkvid/audio/status: eligible held sets, how many are due, running, have estimates. */
export async function audioCueCounts(
  env: Env,
  now = nowSeconds(),
): Promise<{
  eligible: number;
  due: number;
  running: number;
  withEstimates: number;
  ranAndReleased: number;
}> {
  const db = dbOf(env);
  const n = Math.floor(now);
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS eligible,
              SUM(CASE WHEN ${audioDueSql(n)} THEN 1 ELSE 0 END) AS due,
              SUM(CASE WHEN t.audio_claimed_at > ${n - AUDIO_CLAIM_TTL_SECONDS} THEN 1 ELSE 0 END) AS running,
              SUM(CASE WHEN t.audio_cues > 0 THEN 1 ELSE 0 END) AS with_estimates
         FROM mkvid_requests r JOIN mkvid_request_tracks t ON t.request_id = r.id
        WHERE ${audioEligibleSql(n)}`,
    )
    .first<{
      eligible: number;
      due: number | null;
      running: number | null;
      with_estimates: number | null;
    }>();
  const released = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM mkvid_requests r JOIN mkvid_request_tracks t ON t.request_id = r.id
        WHERE t.audio_cues > 0 AND COALESCE(${timedSql({ now: String(n) })}, 0)`,
    )
    .first<{ n: number }>();
  return {
    eligible: Number(row?.eligible ?? 0),
    due: Number(row?.due ?? 0),
    running: Number(row?.running ?? 0),
    withEstimates: Number(row?.with_estimates ?? 0),
    ranAndReleased: Number(released?.n ?? 0),
  };
}
