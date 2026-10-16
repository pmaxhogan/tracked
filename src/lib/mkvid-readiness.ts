/**
 * When a queued mkvid request may be rendered (spec decisions 1-4).
 *
 *   - Never for a set whose track list is not verified: the request stays
 *     `pending`, and the claim passes over it without touching it (no attempt
 *     used, no backoff).
 *   - A verified list that still has unidentified (ID) rows waits until the
 *     set is 7 days old - by its set date, else the day the sync discovered
 *     it - so 1001tracklists users have time to fill the IDs in; then it
 *     renders with "ID" shown. The panel's "Render now" sets `skip_id_wait`
 *     on the request, which skips that wait (never the verification).
 *   - A verified list whose base rows (every row but a "w/" one) are under
 *     90 % timed is held: mkvid spreads untimed rows evenly between timed
 *     neighbours, which is only a fair guess when they are few. A set at
 *     least 5 months old (by its date, else its discovery, as above) needs
 *     75 % only: 1001tracklists users rarely add cue times to an old set, so
 *     holding it for 90 % mostly holds it forever. The set is
 *     rechecked at least weekly (pullInHeldRecheck) and renders once
 *     1001tracklists has the times. Render now does not
 *     skip this.
 *   - Anything else that is pending and past its retry backoff is ready; the
 *     daily cap then decides whether it goes today.
 *
 * Verification itself belongs to the fetch layer (lib/verification.ts): a
 * list is verified when a second fetch by a different pool account agrees on
 * every row. `mkvid_request_tracks.trusted` (what the claim's `tracksTrusted`
 * is read from) is 1 only for a list saved while its set was verified, and is
 * reset to 0 whenever verification starts over; the claim checks both.
 */

import type { Env } from "../types";
import { dbOf } from "./db";
import { isVerified } from "./verification";
import { setDateFromUrl } from "./pool-settings";

/** A verified list with ID rows is held until the set is this old. */
export const ID_WAIT_SECONDS = 7 * 86400;

/** A list renders only when at least this share of its base rows has a cue time. */
export const MIN_TIMED_SHARE = 0.9;

/** The share an old set (OLD_SET_SECONDS or more, by setAgeReference) needs instead. */
export const MIN_TIMED_SHARE_OLD = 0.75;

/** A set this old (about 5 months) is old for the timed gate: its cue times are unlikely to grow. */
export const OLD_SET_SECONDS = 150 * 86400;

/** Whether the set (age counted from `ageReference`, see setAgeReference) is old for the timed gate. */
export function isOldSet(ageReference: number, now = Math.floor(Date.now() / 1000)): boolean {
  return now - ageReference >= OLD_SET_SECONDS;
}

/** The share of base rows that must be timed, in whole percent: 90, or 75 for an old set. */
export function minTimedPct(oldSet: boolean): number {
  return Math.round((oldSet ? MIN_TIMED_SHARE_OLD : MIN_TIMED_SHARE) * 100);
}

/** Base rows (every row but a "w/" one) and how many of them are timed; row 0 is always timed (mkvid starts it at 0). */
export function timedRowCounts(
  tracks: ReadonlyArray<{ cueSeconds: number | null; layered: boolean }>,
): { baseRows: number; timedRows: number } {
  let baseRows = 0;
  let timedRows = 0;
  tracks.forEach((t, i) => {
    if (t.layered) return;
    baseRows++;
    if (i === 0 || (typeof t.cueSeconds === "number" && Number.isFinite(t.cueSeconds))) timedRows++;
  });
  return { baseRows, timedRows };
}

/** MIN_TIMED_SHARE (MIN_TIMED_SHARE_OLD for an old set) in integers, the same test as timedSql. */
export function isTimedEnough(baseRows: number, timedRows: number, oldSet = false): boolean {
  return (
    baseRows > 0 && (timedRows * 10 >= baseRows * 9 || (oldSet && timedRows * 4 >= baseRows * 3))
  );
}

/** SQL for the set's discovery time: the earliest tracklists row for the URL, else the request's own creation. */
export const DISCOVERED_SQL =
  "(COALESCE((SELECT MIN(tl.discovered_at) FROM tracklists tl WHERE tl.url = r.set_url), r.created_at))";

/** SQL for the request's set date as unix seconds (NULL when it has none). */
const SET_DAY_SQL =
  "(CASE WHEN r.set_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' THEN CAST(strftime('%s', r.set_date) AS INTEGER) END)";

/** setAgeReference in SQL over `mkvid_requests r`: the set date, else its discovery. */
export const SET_AGE_REFERENCE_SQL = `COALESCE(${SET_DAY_SQL}, ${DISCOVERED_SQL})`;

/**
 * isTimedEnough over the stored list `t` (an alias of mkvid_request_tracks)
 * of the request `r`, the set's age taken at `now` (an SQL expression; the
 * database clock by default). A list stored before migration 0013 has no
 * counts and counts as untimed until saved again.
 */
export function timedSql(opts: { t?: string; now?: string } = {}): string {
  const t = opts.t ?? "t";
  const now = opts.now ?? "CAST(strftime('%s', 'now') AS INTEGER)";
  return `(${t}.base_rows > 0 AND (${t}.timed_rows * 10 >= ${t}.base_rows * 9
    OR (${t}.timed_rows * 4 >= ${t}.base_rows * 3 AND ${SET_AGE_REFERENCE_SQL} <= ${now} - ${OLD_SET_SECONDS})))`;
}

/** timedSql() over `mkvid_request_tracks t` of `mkvid_requests r`, at the database clock. */
export const TIMED_SQL = timedSql();

/** A held set is due for a recheck at most this long from when its list was last saved or its request reopened. */
export const HELD_UNTIMED_RECHECK_SECONDS = 7 * 86400;

/** A pending request for the set whose stored list is held as untimed (TIMED_SQL negated; NULL counts = untimed). */
export const HELD_UNTIMED_SQL = `SELECT 1 FROM mkvid_requests r JOIN mkvid_request_tracks t ON t.request_id = r.id
  WHERE r.set_url = ? AND r.status = 'pending' AND NOT COALESCE(${TIMED_SQL}, 0) LIMIT 1`;

/**
 * Keep a held set due within HELD_UNTIMED_RECHECK_SECONDS: pulls its
 * set_schedule due time in (never pushes it out), creating the row if needed.
 * Called wherever a held state can begin or continue - every save of a
 * request's list (the sync, after the fetch's own scheduling, which may have
 * set 30 / 90 days or never) and every reopening of a done request - so it
 * needs no knowledge of which fetch came first. Returns whether the set is held.
 */
export async function pullInHeldRecheck(
  env: Env,
  setUrl: string,
  now = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const db = dbOf(env);
  if (!(await db.prepare(HELD_UNTIMED_SQL).bind(setUrl).first())) return false;
  await db
    .prepare(
      `INSERT INTO set_schedule (url, set_date, next_due_at, last_fetched_at, has_id_rows, no_good_video, updated_at)
       VALUES (?, ?, ?, NULL, 0, 0, ?)
       ON CONFLICT(url) DO UPDATE SET next_due_at = excluded.next_due_at, updated_at = excluded.updated_at
         WHERE set_schedule.next_due_at IS NULL OR set_schedule.next_due_at > excluded.next_due_at`,
    )
    .bind(setUrl, setDateFromUrl(setUrl), now + HELD_UNTIMED_RECHECK_SECONDS, now)
    .run();
  return true;
}

/** The fetch layer's verdict (lib/verification.ts), re-exported for the panel and tests. */
export { isVerified };

export type MkvidReadiness =
  | { state: "ready" }
  /** No verified track list yet: nothing is rendered until there is one. */
  | { state: "unverified" }
  /** Too few rows have cue times (under `minPct`, see minTimedPct): held until a recheck finds them. */
  | { state: "untimed"; timedRows: number; baseRows: number; minPct: number }
  /** Verified, but `idRows` rows are still ID: held until `until` (unix seconds) unless Render now is pressed. */
  | { state: "waiting_ids"; until: number; idRows: number }
  /** A failed attempt's retry backoff. */
  | { state: "backoff"; until: number };

/** Readiness as the panel shows it: plus the Apple Music backstop's hint (lib/apple-backstop.ts) when it ran. */
export type MkvidReadinessView = MkvidReadiness & {
  apple?: { cues: number; note: string | null };
};

/** What readiness is computed from: the request plus its stored list's summary. */
export type ReadinessInput = {
  status: string;
  notBefore: number | null;
  setDate: string | null;
  /** tracklists.discovered_at of the set (earliest across DJs), else the request's created_at. */
  discoveredAt: number;
  skipIdWait: boolean;
  verified: boolean;
  /** Rows in the stored list; 0 = none stored. */
  listRows: number;
  /** ID rows in the stored list. */
  idRows: number;
  /** Base rows of the stored list and how many of them are timed (timedRowCounts). */
  baseRows: number;
  timedRows: number;
};

/** Unix seconds the set's age is counted from: its date, else when it was discovered. */
export function setAgeReference(setDate: string | null, discoveredAt: number): number {
  if (setDate && /^\d{4}-\d{2}-\d{2}$/.test(setDate)) {
    const t = Date.parse(`${setDate}T00:00:00Z`);
    if (Number.isFinite(t)) return Math.floor(t / 1000);
  }
  return discoveredAt;
}

export function mkvidReadiness(
  r: ReadinessInput,
  now = Math.floor(Date.now() / 1000),
): MkvidReadiness {
  if (!r.verified || r.listRows <= 0) return { state: "unverified" };
  const oldSet = isOldSet(setAgeReference(r.setDate, r.discoveredAt), now);
  if (!isTimedEnough(r.baseRows, r.timedRows, oldSet))
    return {
      state: "untimed",
      timedRows: r.timedRows,
      baseRows: r.baseRows,
      minPct: minTimedPct(oldSet),
    };
  if (r.idRows > 0 && !r.skipIdWait) {
    const until = setAgeReference(r.setDate, r.discoveredAt) + ID_WAIT_SECONDS;
    if (now < until) return { state: "waiting_ids", until, idRows: r.idRows };
  }
  if (r.status === "pending" && r.notBefore !== null && r.notBefore > now)
    return { state: "backoff", until: r.notBefore };
  return { state: "ready" };
}

/**
 * SQL condition (over `mkvid_requests r JOIN mkvid_request_tracks t`) for the
 * parts of readiness that live in D1: a stored, non-empty, trusted (=
 * verified, see above), timed-enough list whose ID wait is over or skipped. Binds one
 * value: the cut-off `now - ID_WAIT_SECONDS`.
 */
export const CLAIM_READY_SQL = `t.track_count > 0 AND t.trusted = 1 AND ${TIMED_SQL}
  AND (COALESCE(t.id_rows, 1) = 0 OR r.skip_id_wait = 1
       OR (CASE WHEN r.set_date IS NOT NULL AND r.set_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                THEN CAST(strftime('%s', r.set_date) AS INTEGER) ELSE ${DISCOVERED_SQL} END) <= ?)`;

/** The states mkvidReadiness answers, in the order it tests them. */
export const MKVID_READINESS_STATES: ReadonlyArray<MkvidReadiness["state"]> = [
  "unverified",
  "untimed",
  "waiting_ids",
  "backoff",
  "ready",
];

/**
 * mkvidReadiness's state as an SQL expression over `mkvid_requests r LEFT JOIN
 * mkvid_request_tracks t` (the same inputs readinessFor reads), so the panel's
 * queue can filter, sort and count by it across all its pages. `now` is
 * written into the SQL as a whole number.
 */
export function readinessStateSql(now: number): string {
  const n = Math.floor(now);
  return `(CASE
    WHEN COALESCE(t.trusted, 0) != 1 OR COALESCE(t.track_count, 0) <= 0 THEN 'unverified'
    WHEN NOT COALESCE(${timedSql({ now: String(n) })}, 0) THEN 'untimed'
    WHEN COALESCE(t.id_rows, 1) > 0 AND COALESCE(r.skip_id_wait, 0) != 1 AND ${n} < ${SET_AGE_REFERENCE_SQL} + ${ID_WAIT_SECONDS} THEN 'waiting_ids'
    WHEN r.status = 'pending' AND r.not_before IS NOT NULL AND r.not_before > ${n} THEN 'backoff'
    ELSE 'ready' END)`;
}

/**
 * Panel "Render now": this request skips the wait for IDs (it still needs a
 * verified list, and keeps its place in the queue). Any request that has not
 * been rendered yet - or is being recreated - can take it.
 */
export async function setSkipIdWait(env: Env, id: string): Promise<boolean> {
  const r = await dbOf(env)
    .prepare(
      "UPDATE mkvid_requests SET skip_id_wait = 1, updated_at = ? WHERE id = ? AND status IN ('pending', 'claimed', 'failed', 'banned')",
    )
    .bind(Math.floor(Date.now() / 1000), id)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/** Readiness of a page of requests for the panel, in one query. Requests with no stored list are `unverified`. */
export async function readinessFor(
  env: Env,
  requests: ReadonlyArray<{
    id: string;
    status: string;
    notBefore: number | null;
    setDate: string | null;
    skipIdWait: boolean;
  }>,
  now = Math.floor(Date.now() / 1000),
): Promise<Map<string, MkvidReadinessView>> {
  const out = new Map<string, MkvidReadinessView>();
  if (!requests.length) return out;
  const res = await dbOf(env)
    .prepare(
      `SELECT r.id AS id, ${DISCOVERED_SQL} AS discovered, t.trusted AS trusted, t.track_count AS n, t.id_rows AS id_rows,
              t.base_rows AS base_rows, t.timed_rows AS timed_rows, t.apple_cues AS apple_cues, t.apple_note AS apple_note
         FROM mkvid_requests r LEFT JOIN mkvid_request_tracks t ON t.request_id = r.id
        WHERE r.id IN (${requests.map(() => "?").join(", ")})`,
    )
    .bind(...requests.map((r) => r.id))
    .all<{
      id: string;
      discovered: number;
      trusted: number | null;
      n: number | null;
      id_rows: number | null;
      base_rows: number | null;
      timed_rows: number | null;
      apple_cues: number | null;
      apple_note: string | null;
    }>();
  const byId = new Map(res.results.map((x) => [x.id, x]));
  for (const r of requests) {
    const x = byId.get(r.id);
    const apple =
      Number(x?.apple_cues ?? 0) > 0 || x?.apple_note
        ? { apple: { cues: Number(x?.apple_cues ?? 0), note: x?.apple_note ?? null } }
        : {};
    out.set(r.id, {
      ...mkvidReadiness(
        {
          status: r.status,
          notBefore: r.notBefore,
          setDate: r.setDate,
          discoveredAt: Number(x?.discovered ?? now),
          skipIdWait: r.skipIdWait,
          verified: Number(x?.trusted ?? 0) === 1,
          listRows: Number(x?.n ?? 0),
          // Not counted yet (a list stored before migration 0009): assume IDs, the claim does the same.
          idRows: x?.id_rows == null ? (Number(x?.n ?? 0) > 0 ? 1 : 0) : Number(x.id_rows),
          baseRows: Number(x?.base_rows ?? 0),
          timedRows: Number(x?.timed_rows ?? 0),
        },
        now,
      ),
      ...apple,
    });
  }
  return out;
}
