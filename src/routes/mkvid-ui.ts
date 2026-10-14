/**
 * The mkvid page's read endpoints (ui/pages/mkvid.ts). Mounted inside
 * subscriptionsApp, so behind its cfAccess gate and the /ui/api/* same-origin
 * guard. The actions (retry, move, ban, ...) stay in routes/subscriptions.ts.
 *
 *   GET /api/mkvid            the header: status line inputs, caps, counts (by stored status)
 *                             and `outcomes` (the finished requests by outcome), `removedBurst`
 *                             (removals the owner has to rule on, or null), last poll,
 *                             the DJ list, old-style count, replaced videos, and the
 *                             requests rendering now (`rendering`). Home and Settings read
 *                             it too (they send `?limit=1`, which is ignored).
 *   GET /api/mkvid/queue      the waiting line: a data-table endpoint (lib/table-query.ts:
 *                             page, size, sort, q, f.<col>) over the pending requests. Default
 *                             sort `position` = claim order; every row carries its 1-based
 *                             `position` in the whole queue, which no filter or sort shifts.
 *   GET /api/mkvid/finished   everything that left the line (done, failed, superseded,
 *                             banned), newest activity first by default.
 *
 * Every request row is `requestSummary` plus `readiness` (why a waiting set is or is
 * not next) and, in the queue, `position`. `q` matches the set title, the DJ (stored
 * name or slug), the set URL and the error.
 *
 * The `status` column of both tables is derived, not the stored status (which every
 * row still carries as `status`): in the queue it is the readiness state
 * (lib/mkvid-readiness.ts: ready, unverified, untimed, waiting_ids, backoff), in the
 * finished list the outcome (lib/mkvid-outcome.ts: `failed` split into real failures
 * and the two no-recording kinds, `superseded` by its cause, and `removed_unconfirmed`
 * for a removal in the open burst: lib/mkvid-removed-burst.ts). Both are SQL, so a
 * filter or sort on it covers every page; each answer adds `counts`, the whole
 * list by that column, whatever the filters.
 */
import { Hono, type Context } from "hono";
import type { Env } from "../types";
import {
  countMkvidOutcomes,
  countMkvidRequests,
  getMkvidLastPoll,
  listMkvidDjs,
  MKVID_ACCOUNTS,
  MKVID_FINISHED_SQL,
  MKVID_SOURCES,
  mkvidAccountUsage,
  quotaDayEnd,
  requestSummary,
  rowToRequest,
  type MkvidRequest,
  type MkvidRow,
} from "../lib/mkvid";
import { MKVID_READINESS_STATES, readinessFor, readinessStateSql } from "../lib/mkvid-readiness";
import { MKVID_OUTCOMES, mkvidOutcomeSql } from "../lib/mkvid-outcome";
import { getRemovedBurst, removedBurstSince } from "../lib/mkvid-removed-burst";
import { countOldStyleVideos, listUndeletedOldVideos } from "../lib/mkvid-recreate";
import {
  parseTableQuery,
  runTableQuery,
  tableErrorBody,
  TableQueryError,
  type TableColumn,
  type TableDef,
  type TableQuery,
} from "../lib/table-query";
import { dbOf } from "../lib/db";

export const mkvidUiApp = new Hono<{ Bindings: Env; Variables: { cfAccessEmail: string } }>();

type QueueDbRow = MkvidRow & { position?: number | null };

/** The columns both lists share (stored seconds; filters take unix ms like every datetime). Each list adds its own `status`. */
const COLUMNS: Record<string, TableColumn<QueueDbRow>> = {
  id: { type: "text", filterable: false },
  setDate: { sql: "set_date", type: "date" },
  setTitle: { sql: "COALESCE(set_title, '')", type: "text", searchable: true },
  setUrl: { sql: "set_url", type: "text", sortable: false, searchable: true },
  artistName: { sql: "COALESCE(artist_name, '')", type: "text", searchable: true, sortable: false },
  // The DJ, by slug: the DJ select filters `eq:<slug>`.
  dj: { sql: "slug", type: "text", searchable: true },
  source: { type: "enum", options: MKVID_SOURCES },
  account: { type: "enum", options: MKVID_ACCOUNTS },
  attempts: { type: "number" },
  createdAt: { sql: "created_at", type: "datetime", storage: "s" },
  updatedAt: { sql: "updated_at", type: "datetime", storage: "s" },
  notBefore: { sql: "not_before", type: "datetime", storage: "s" },
  videoId: { sql: "video_id", type: "text" },
  privacy: { type: "enum" },
  style: { type: "enum" },
  error: { type: "text", sortable: false, searchable: true },
};

/**
 * Claim order (lib/mkvid.ts QUEUE_ORDER): newest set first, undated last, ties by most recently queued.
 * Each row also gets its readiness state at `now` as `ready_state`: the list's `status` column.
 */
export function mkvidQueueTable(now: number): TableDef<QueueDbRow> {
  return {
    from: `(SELECT r.*, ROW_NUMBER() OVER (ORDER BY r.sort_key DESC, r.created_at DESC, r.rowid ASC) AS position, ${readinessStateSql(now)} AS ready_state
      FROM mkvid_requests r LEFT JOIN mkvid_request_tracks t ON t.request_id = r.id WHERE r.status = 'pending')`,
    primaryKey: "id",
    defaultSort: "position",
    columns: {
      ...COLUMNS,
      status: { sql: "ready_state", type: "enum", options: MKVID_READINESS_STATES },
      position: { type: "number" },
    },
  };
}

/** The finished list. `since` is the open removed-recordings burst's start (null = none): a removal from then on reads `removed_unconfirmed`. */
export function mkvidFinishedTable(since: number | null): TableDef<QueueDbRow> {
  return {
    from: "mkvid_requests",
    where: MKVID_FINISHED_SQL,
    primaryKey: "id",
    defaultSort: "-updatedAt",
    columns: {
      ...COLUMNS,
      status: {
        sql: mkvidOutcomeSql("status", "error", { since }),
        type: "enum",
        options: MKVID_OUTCOMES,
      },
    },
  };
}

type Ctx = Context<{ Bindings: Env; Variables: { cfAccessEmail: string } }>;

/** A table answer whose rows are requestSummary + readiness (+ position in the queue), plus `counts`. */
async function requestTable(
  c: Ctx,
  def: TableDef<QueueDbRow>,
  now: number,
  counts: () => Promise<Record<string, number>>,
  since: number | null = null,
): Promise<Response> {
  let query: TableQuery;
  try {
    query = parseTableQuery(new URL(c.req.url).searchParams, def);
  } catch (e) {
    if (e instanceof TableQueryError) return c.json(tableErrorBody(e), 400);
    throw e;
  }
  const result = await runTableQuery<QueueDbRow>(dbOf(c.env), def, query);
  const reqs = result.rows.map((r) => ({
    req: rowToRequest(r),
    position: r.position == null ? null : Number(r.position),
  }));
  const readiness = await readinessFor(
    c.env,
    reqs.map((x) => x.req).filter((r) => r.status !== "done" && r.status !== "superseded"),
    now,
  );
  return c.json({
    ...result,
    rows: reqs.map((x) => ({
      ...summaryOf(x.req, readiness.get(x.req.id) ?? null, since),
      ...(x.position != null ? { position: x.position } : {}),
    })),
    counts: await counts(),
  });
}

const summaryOf = (r: MkvidRequest, readiness: unknown, since: number | null = null) => ({
  ...requestSummary(r, since),
  readiness,
});

/** The whole queue by readiness state. */
async function countQueueStates(
  env: Env,
  def: TableDef<QueueDbRow>,
): Promise<Record<string, number>> {
  const res = await dbOf(env)
    .prepare(`SELECT ready_state AS k, COUNT(*) AS n FROM ${def.from} GROUP BY k`)
    .all<{ k: string; n: number }>();
  const out: Record<string, number> = Object.fromEntries(MKVID_READINESS_STATES.map((k) => [k, 0]));
  for (const r of res.results) if (r.k in out) out[r.k] = Number(r.n);
  return out;
}

mkvidUiApp.get("/api/mkvid/queue", (c) => {
  const now = Math.floor(Date.now() / 1000);
  const def = mkvidQueueTable(now);
  return requestTable(c, def, now, () => countQueueStates(c.env, def));
});
mkvidUiApp.get("/api/mkvid/finished", async (c) => {
  const since = await removedBurstSince(c.env);
  return requestTable(
    c,
    mkvidFinishedTable(since),
    Math.floor(Date.now() / 1000),
    () => countMkvidOutcomes(c.env, since),
    since,
  );
});

/**
 * The mkvid header: the three things that decide whether anything moves (the
 * daily caps, how much of them is used, when mkvid last polled), the counts,
 * and the requests rendering now. The lists are the two table endpoints above.
 */
mkvidUiApp.get("/api/mkvid", async (c) => {
  const removedBurst = await getRemovedBurst(c.env);
  const [counts, outcomes, accounts, lastPoll, djs, oldStyleCount, oldVideos, claimed] =
    await Promise.all([
      countMkvidRequests(c.env),
      countMkvidOutcomes(c.env, removedBurst?.since ?? null),
      mkvidAccountUsage(c.env),
      getMkvidLastPoll(c.env),
      listMkvidDjs(c.env),
      countOldStyleVideos(c.env),
      listUndeletedOldVideos(c.env),
      dbOf(c.env)
        .prepare(
          "SELECT * FROM mkvid_requests WHERE status = 'claimed' ORDER BY claimed_at ASC LIMIT 10",
        )
        .all<MkvidRow>(),
    ]);
  const rendering = claimed.results.map(rowToRequest);
  const readiness = await readinessFor(c.env, rendering);
  return c.json({
    enabled: !!c.env.MKVID_TOKEN,
    counts,
    /** The finished requests by outcome: `failed` is real failures only, the no-recording kinds are their own. */
    outcomes,
    /**
     * Removals the owner has to rule on (lib/mkvid-removed-burst.ts), or null: `{ since, count, sources, threshold }`.
     * They read `removed_unconfirmed` and stay as they are until POST /ui/api/mkvid/removed-burst/retry or /confirm.
     */
    removedBurst,
    /** Done videos made with a style other than scene (unknown counts): what "Recreate all old-style videos" would queue. */
    oldStyleCount,
    /** Videos a recreation replaced that are not deleted from YouTube yet (pending retry, or refused by mkvid). */
    oldVideos,
    /** Per Google project (fill order): today's claims vs cap. The totals below are their sums. */
    accounts,
    dailyClaims: accounts.reduce((n, a) => n + a.used, 0),
    dailyClaimCap: accounts.reduce((n, a) => n + a.cap, 0),
    /** Unix seconds when the quota day rolls over (midnight Pacific). */
    quotaResetsAt: quotaDayEnd(),
    /** mkvid's last `/mkvid/claim` poll; `at` is refreshed at most every 10 min while the outcome is unchanged. */
    lastPoll,
    now: Math.floor(Date.now() / 1000),
    /** Every DJ the queue has ever held, most requests first: the DJ filter's options. */
    djs,
    /** Requests mkvid has claimed and is working on (oldest claim first). */
    rendering: rendering.map((r) => summaryOf(r, readiness.get(r.id) ?? null)),
  });
});
