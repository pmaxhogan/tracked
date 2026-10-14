// Several recordings "removed" within a day (lib/mkvid-removed-burst.ts): when
// a burst opens, what is in it, that it is red wherever a failure is, that
// nothing changes its requests by itself, and the owner's two answers.
import { describe, it, expect } from "vitest";
import { app } from "../src/index";
import type { Env } from "../src/types";
import { fakeKV } from "./helpers/fake-kv";
import { fakeD1 } from "./helpers/fake-d1";
import { makeLogger } from "../src/lib/log";
import { updateAppSettings } from "../src/lib/app-settings";
import {
  banMkvidRequest,
  countMkvidOutcomes,
  enqueueMkvidRequest,
  failMkvidRequest,
  getMkvidRequest,
  retryMkvidRequest,
} from "../src/lib/mkvid";
import { computeStats } from "../src/lib/stats";
import { setDiagnostics } from "../src/lib/set-diagnostics";
import {
  MKVID_OUTCOMES,
  isNoRecording,
  mkvidFailureKindSql,
  mkvidNoRecordingSql,
  mkvidOutcome,
  mkvidOutcomeDetail,
  mkvidOutcomeLine,
  mkvidOutcomeSql,
  mkvidRemovedSql,
  mkvidUnconfirmedSql,
} from "../src/lib/mkvid-outcome";
import {
  REMOVED_BURST_ACK_KEY,
  REMOVED_BURST_KEY,
  REMOVED_BURST_WINDOW_SECONDS,
  confirmRemovedBurst,
  getRemovedBurst,
  removedBurstSince,
  removedBurstStart,
} from "../src/lib/mkvid-removed-burst";

const log = makeLogger({ task: "test" });
const DAY = REMOVED_BURST_WINDOW_SECONDS;
/** Well in the past, so every time below is before the real clock (the routes and failMkvidRequest use it). */
const T = Math.floor(Date.now() / 1000) - 30 * DAY;

const GONE =
  "probe: yt-dlp exit 1: ERROR: [soundcloud] 2175021006: Unable to download JSON metadata: HTTP Error 404: Not Found (caused by <HTTPError 404: Not Found>)";
const GONE_HT = "source: hearthis embed 13036034: HTTP 404";
const SHORT = "incomplete_recording: source is 1824s but the tracklist's last cue is at 7009s";

const makeEnv = (): Env =>
  ({
    CACHE: fakeKV(),
    SUBS: fakeKV(),
    DB: fakeD1(),
    SEARCH_DB: fakeD1({ migrations: "search" }),
    API_TOKEN: "t",
    YOUTUBE_API_KEY: "k",
    MKVID_TOKEN: "mk",
    DEV_BYPASS_CF_ACCESS: "1",
  }) as unknown as Env;

const setUrl = (id: string) => `https://www.1001tracklists.com/tracklist/${id}/x.html`;
const oldSource = (id: string) => `https://api.soundcloud.com/tracks/${id}`;

/** A finished request as it is stored: failed with `error` at `at`, unless said otherwise. */
async function row(
  env: Env,
  id: string,
  at: number,
  o: { status?: string; error?: string | null; source?: string; attempts?: number } = {},
) {
  await env.DB.prepare(
    "INSERT INTO mkvid_requests (id, slug, set_url, set_title, source, source_url, status, error, attempts, created_at, updated_at) VALUES (?, 'dj', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      setUrl(id),
      `Set ${id}`,
      o.source ?? "soundcloud",
      oldSource(id),
      o.status ?? "failed",
      o.error === undefined ? GONE : o.error,
      o.attempts ?? 1,
      at - 100,
      at,
    )
    .run();
}
const enqueueOtherSource = (env: Env, id: string) =>
  enqueueMkvidRequest(env, {
    slug: "dj",
    setUrl: setUrl(id),
    artistName: "DJ",
    setTitle: `Set ${id}`,
    setDate: "2026-09-01",
    source: { kind: "hearthis", url: `https://hearthis.at/dj/${id}/` },
    lastCueSeconds: 100,
    trackCount: 3,
    idedCount: 3,
  });
const stored = async (env: Env, id: string) =>
  (await env.DB.prepare(
    "SELECT status, error, attempts, source, updated_at FROM mkvid_requests WHERE id = ?",
  )
    .bind(id)
    .first<{
      status: string;
      error: string | null;
      attempts: number;
      source: string;
      updated_at: number;
    }>())!;
const post = (env: Env, path: string, origin: string | null = "http://x") =>
  app.request(
    `http://x${path}`,
    {
      method: "POST",
      headers: { ...(origin ? { Origin: origin } : {}), "Content-Type": "application/json" },
      body: "{}",
    },
    env,
  );
const getJson = async <X>(env: Env, path: string) => {
  const r = await app.request(`http://x${path}`, {}, env);
  expect(r.status, path).toBe(200);
  return (await r.json()) as X;
};
type FinRow = {
  id: string;
  status: string;
  outcome: string | null;
  outcomeLine: string | null;
  outcomeDetail: string | null;
};
type Fin = { rows: FinRow[]; total: number; counts: Record<string, number> };
type Header = {
  counts: Record<string, number>;
  outcomes: Record<string, number>;
  removedBurst: {
    since: number;
    count: number;
    sources: Record<string, number>;
    threshold: number;
  } | null;
};
const ids = (x: Fin) => x.rows.map((r) => r.id).sort();

describe("removedBurstStart", () => {
  it("needs n removals less than a day apart, and starts at the first of the earliest such n", () => {
    expect(removedBurstStart([], 3)).toBeNull();
    expect(removedBurstStart([T, T + 60], 3)).toBeNull();
    expect(removedBurstStart([T, T + 60, T + 120], 3)).toBe(T);
    // The window is between the removals: a second short of a day is in, a full day is out.
    expect(removedBurstStart([T, T + 5, T + DAY - 1], 3)).toBe(T);
    expect(removedBurstStart([T, T + 5, T + DAY], 3)).toBeNull();
    // An old lone removal is not the start: the three that are close together are.
    expect(removedBurstStart([T - 9 * DAY, T, T + 60, T + 120], 3)).toBe(T);
    // Rolling: none of the first three windows holds three, the last does.
    expect(removedBurstStart([T, T + DAY, T + 2 * DAY, T + 2 * DAY + 5, T + 2 * DAY + 9], 3)).toBe(
      T + 2 * DAY,
    );
    expect(removedBurstStart([T, T + 60], 2)).toBe(T);
    expect(removedBurstStart([T], 1)).toBe(T);
    expect(removedBurstStart([T, T + 1, T + 2], 0)).toBeNull();
  });
});

describe("removed_unconfirmed: the function and its SQL twin", () => {
  /** [status, error, updatedAt]. */
  const CASES: Array<[string, string | null, number]> = [];
  for (const status of ["failed", "done", "banned", "superseded", "pending", "claimed"]) {
    for (const error of [
      GONE,
      GONE_HT,
      SHORT,
      "too many attempts",
      "probe: yt-dlp exit 1: ERROR: Requested format is not available",
      null,
    ]) {
      for (const at of [T - 1, T, T + 1]) CASES.push([status, error, at]);
    }
  }

  it("only a failed request whose recording is gone, from the burst start on, is unconfirmed", () => {
    expect(mkvidOutcome({ status: "failed", error: GONE, updatedAt: T }, T)).toBe(
      "removed_unconfirmed",
    );
    expect(mkvidOutcome({ status: "failed", error: GONE, updatedAt: T + 5 }, T)).toBe(
      "removed_unconfirmed",
    );
    expect(mkvidOutcome({ status: "failed", error: GONE, updatedAt: T - 1 }, T)).toBe(
      "recording_removed",
    );
    // No burst open, or no time to compare: an ordinary removal.
    expect(mkvidOutcome({ status: "failed", error: GONE, updatedAt: T }, null)).toBe(
      "recording_removed",
    );
    expect(mkvidOutcome({ status: "failed", error: GONE, updatedAt: T })).toBe("recording_removed");
    expect(mkvidOutcome({ status: "failed", error: GONE }, T)).toBe("recording_removed");
    // A short recording and a real failure are never part of it.
    expect(mkvidOutcome({ status: "failed", error: SHORT, updatedAt: T }, T)).toBe(
      "recording_short",
    );
    expect(mkvidOutcome({ status: "failed", error: "too many attempts", updatedAt: T }, T)).toBe(
      "failed",
    );
    expect(mkvidOutcome({ status: "pending", error: GONE, updatedAt: T }, T)).toBeNull();
    expect(MKVID_OUTCOMES).toContain("removed_unconfirmed");
    expect(isNoRecording("removed_unconfirmed")).toBe(false);
  });

  it("the SQL expressions agree with the function on every case, with a burst open and without", async () => {
    const db = fakeD1();
    const one = async (expr: string, status: string, error: string | null, at: number) =>
      (await db
        .prepare(`SELECT ${expr} AS v FROM (SELECT ? AS status, ? AS error, ? AS updated_at)`)
        .bind(status, error, at)
        .first<{ v: string | number | null }>())!.v;
    for (const since of [T, null]) {
      const b = { since };
      for (const [status, error, at] of CASES) {
        const outcome = mkvidOutcome({ status, error, updatedAt: at }, since);
        const tag = [since, status, error, at];
        expect([
          ...tag,
          await one(mkvidOutcomeSql("status", "error", b), status, error, at),
        ]).toEqual([...tag, outcome]);
        expect([
          ...tag,
          await one(mkvidFailureKindSql("status", "error", b), status, error, at),
        ]).toEqual([...tag, status === "failed" ? outcome : status]);
        // The three conditions read the error (and the time) only: compare them as a failed request.
        const asFailed = mkvidOutcome({ status: "failed", error, updatedAt: at }, since);
        expect([...tag, await one(mkvidUnconfirmedSql("error", b), status, error, at)]).toEqual([
          ...tag,
          asFailed === "removed_unconfirmed" ? 1 : 0,
        ]);
        expect([...tag, await one(mkvidNoRecordingSql("error", b), status, error, at)]).toEqual([
          ...tag,
          isNoRecording(asFailed) ? 1 : 0,
        ]);
        expect([...tag, await one(mkvidRemovedSql("error"), status, error, at)]).toEqual([
          ...tag,
          asFailed === "removed_unconfirmed" || asFailed === "recording_removed" ? 1 : 0,
        ]);
      }
    }
    // Another column for the time, and a start that is not a whole number.
    expect(
      await db
        .prepare(
          `SELECT ${mkvidOutcomeSql("s", "e", { since: T + 0.9, updatedAt: "u" })} AS v FROM (SELECT 'failed' AS s, ? AS e, ? AS u)`,
        )
        .bind(GONE, T)
        .first(),
    ).toEqual({ v: "removed_unconfirmed" });
    // Without a burst the SQL is what it was before bursts existed.
    expect(mkvidOutcomeSql("status", "error", { since: null })).toBe(
      mkvidOutcomeSql("status", "error"),
    );
    expect(mkvidNoRecordingSql("error", { since: null })).toBe(mkvidNoRecordingSql("error"));
    expect(mkvidOutcomeSql("status", "error")).not.toContain("removed_unconfirmed");
  });

  it("says it in plain words, with what to do", () => {
    const r = { status: "failed", error: GONE, source: "soundcloud", updatedAt: T };
    expect(mkvidOutcomeLine(r, T)).toBe(
      'The recording looks gone from SoundCloud (the link answers "not found"), but so did several others within a day.',
    );
    const detail = mkvidOutcomeDetail(r, T)!;
    expect(detail).toContain("may mean the source or the downloader is broken");
    expect(detail).toContain("Try them again, or They are really gone");
    expect(detail).not.toContain("Nothing to do");
    // The same request once the burst is over.
    expect(mkvidOutcomeLine(r, null)).toBe(
      'The recording is gone from SoundCloud (the link answers "not found").',
    );
    expect(mkvidOutcomeDetail(r, null)).toContain("Nothing to do");
  });
});

describe("when a burst opens", () => {
  it("two removals in a day are ordinary; the third opens it, and all three are in it", async () => {
    const env = makeEnv();
    await row(env, "a", T);
    await row(env, "b", T + 60);
    expect(await getRemovedBurst(env)).toBeNull();
    expect(await countMkvidOutcomes(env, await removedBurstSince(env))).toMatchObject({
      recording_removed: 2,
      removed_unconfirmed: 0,
    });
    await row(env, "c", T + 120);
    expect(await getRemovedBurst(env)).toEqual({
      since: T,
      count: 3,
      sources: { soundcloud: 3 },
      threshold: 3,
    });
    expect(await countMkvidOutcomes(env, await removedBurstSince(env))).toMatchObject({
      recording_removed: 0,
      removed_unconfirmed: 3,
    });
  });

  it("the day is between the removals: a second short of 24 hours opens it, 24 hours does not", async () => {
    const inside = makeEnv();
    for (const [id, at] of [
      ["a", T],
      ["b", T + 10],
      ["c", T + DAY - 1],
    ] as const)
      await row(inside, id, at);
    expect((await getRemovedBurst(inside))?.since).toBe(T);
    const outside = makeEnv();
    for (const [id, at] of [
      ["a", T],
      ["b", T + 10],
      ["c", T + DAY],
    ] as const)
      await row(outside, id, at);
    expect(await getRemovedBurst(outside)).toBeNull();
    // One a day, for a week: never a burst.
    const spread = makeEnv();
    for (let i = 0; i < 7; i++) await row(spread, `s${i}`, T + i * DAY);
    expect(await getRemovedBurst(spread)).toBeNull();
  });

  it("counts removals only: a short recording, a real failure and a request that is not failed do not count", async () => {
    const env = makeEnv();
    await row(env, "a", T);
    await row(env, "b", T + 1);
    await row(env, "s", T + 2, { error: SHORT });
    await row(env, "f", T + 3, { error: "too many attempts" });
    await row(env, "p", T + 4, { status: "pending" });
    await row(env, "x", T + 5, { status: "banned" });
    await row(env, "d", T + 6, { status: "done", error: null });
    expect(await getRemovedBurst(env)).toBeNull();
  });

  it("counts every source together: two from SoundCloud and one from hearthis.at are three", async () => {
    const env = makeEnv();
    await row(env, "a", T);
    await row(env, "b", T + 60);
    await row(env, "h", T + 120, { source: "hearthis", error: GONE_HT });
    expect(await getRemovedBurst(env)).toEqual({
      since: T,
      count: 3,
      sources: { soundcloud: 2, hearthis: 1 },
      threshold: 3,
    });
  });

  it("the count is the setting mkvid.removedBurstCount; 0 never opens one", async () => {
    const env = makeEnv();
    for (const [id, at] of [
      ["a", T],
      ["b", T + 60],
      ["c", T + 120],
      ["d", T + 180],
    ] as const)
      await row(env, id, at);
    expect((await updateAppSettings(env, { mkvid: { removedBurstCount: 5 } })).ok).toBe(true);
    expect(await getRemovedBurst(env)).toBeNull();
    expect((await updateAppSettings(env, { mkvid: { removedBurstCount: 0 } })).ok).toBe(true);
    expect(await getRemovedBurst(env)).toBeNull();
    expect((await updateAppSettings(env, { mkvid: { removedBurstCount: 2 } })).ok).toBe(true);
    expect(await getRemovedBurst(env)).toMatchObject({ since: T, count: 4, threshold: 2 });
    // Switched off while one is open: nothing is red or frozen.
    expect((await updateAppSettings(env, { mkvid: { removedBurstCount: 0 } })).ok).toBe(true);
    expect(await removedBurstSince(env)).toBeNull();
    expect(await enqueueOtherSource(env, "a")).toBe("requeued");
    expect((await updateAppSettings(env, { mkvid: { removedBurstCount: 51 } })).ok).toBe(false);
  });

  it("the setting is 0 (never) or 2 to 50: one removal is not several", async () => {
    const env = makeEnv();
    const one = await updateAppSettings(env, { mkvid: { removedBurstCount: 1 } });
    expect(one).toEqual({ ok: false, issues: ["mkvid.removedBurstCount: 0 (never) or 2 to 50"] });
    for (const n of [-1, 2.5, 51])
      expect(
        (await updateAppSettings(env, { mkvid: { removedBurstCount: n } })).ok,
        String(n),
      ).toBe(false);
    for (const n of [0, 2, 3, 50])
      expect(
        (await updateAppSettings(env, { mkvid: { removedBurstCount: n } })).ok,
        String(n),
      ).toBe(true);
    // Through the Settings route too.
    const put = (n: number) =>
      app.request(
        "http://x/ui/api/settings",
        {
          method: "PUT",
          headers: { Origin: "http://x", "Content-Type": "application/json" },
          body: JSON.stringify({ mkvid: { removedBurstCount: n } }),
        },
        env,
      );
    expect((await put(1)).status).toBe(400);
    expect((await put(2)).status).toBe(200);
  });

  it("a later removal joins the open burst; an earlier lone one stays an ordinary removal", async () => {
    const env = makeEnv();
    await row(env, "old", T - 9 * DAY);
    for (const [id, at] of [
      ["a", T],
      ["b", T + 60],
      ["c", T + 120],
    ] as const)
      await row(env, id, at);
    expect(await getRemovedBurst(env)).toMatchObject({ since: T, count: 3 });
    await row(env, "late", T + 5 * DAY);
    expect(await getRemovedBurst(env)).toMatchObject({ since: T, count: 4 });
    const fin = await getJson<Fin>(env, "/ui/api/mkvid/finished?f.status=in:removed_unconfirmed");
    expect(ids(fin)).toEqual(["a", "b", "c", "late"]);
    expect(
      ids(await getJson<Fin>(env, "/ui/api/mkvid/finished?f.status=in:recording_removed")),
    ).toEqual(["old"]);
  });
});

describe("while a burst is open, its requests are red and frozen", () => {
  async function open(env: Env) {
    for (const [id, at] of [
      ["a", T],
      ["b", T + 60],
      ["c", T + 120],
    ] as const)
      await row(env, id, at);
    expect(await removedBurstSince(env)).toBe(T);
  }

  it("the finished list, its counts and the header show them as removed, unconfirmed", async () => {
    const env = makeEnv();
    await row(env, "s", T - 5, { error: SHORT });
    await row(env, "f", T - 4, { error: "too many attempts" });
    await row(env, "old", T - 9 * DAY);
    await open(env);
    const counts = {
      done: 0,
      failed: 1,
      removed_unconfirmed: 3,
      recording_removed: 1,
      recording_short: 1,
      has_recording: 0,
      duplicate: 0,
      superseded: 0,
      banned: 0,
    };
    const fin = await getJson<Fin>(env, "/ui/api/mkvid/finished?size=50");
    expect(fin.counts).toEqual(counts);
    expect(Object.fromEntries(fin.rows.map((r) => [r.id, r.outcome]))).toEqual({
      a: "removed_unconfirmed",
      b: "removed_unconfirmed",
      c: "removed_unconfirmed",
      old: "recording_removed",
      s: "recording_short",
      f: "failed",
    });
    const red = await getJson<Fin>(env, "/ui/api/mkvid/finished?f.status=in:removed_unconfirmed");
    expect([red.total, ids(red)]).toEqual([3, ["a", "b", "c"]]);
    expect(red.rows[0]).toMatchObject({
      status: "failed",
      outcomeLine:
        'The recording looks gone from SoundCloud (the link answers "not found"), but so did several others within a day.',
    });
    expect(red.rows[0]!.outcomeDetail).toContain("They are really gone");
    // The page's Problems chip: real failures, unconfirmed removals, bans.
    expect(
      ids(
        await getJson<Fin>(
          env,
          "/ui/api/mkvid/finished?f.status=in:failed|removed_unconfirmed|banned",
        ),
      ),
    ).toEqual(["a", "b", "c", "f"]);
    expect(
      (await getJson<Fin>(env, "/ui/api/mkvid/finished?size=50&sort=status")).rows
        .map((r) => r.outcome)
        .filter((o, i, all) => o !== all[i - 1]),
    ).toEqual(["failed", "recording_removed", "recording_short", "removed_unconfirmed"]);
    const h = await getJson<Header>(env, "/ui/api/mkvid");
    expect(h.outcomes).toEqual(counts);
    expect(h.counts).toMatchObject({ failed: 6 });
    expect(h.removedBurst).toEqual({
      since: T,
      count: 3,
      sources: { soundcloud: 3 },
      threshold: 3,
    });
  });

  it("Activity, Stats and the set page count them as problems", async () => {
    const env = makeEnv();
    await row(env, "old", T - 9 * DAY);
    await open(env);
    type Act = {
      rows: Array<{
        ref: { key: string };
        status: string;
        problem: boolean;
        detail: string | null;
      }>;
    };
    const act = await getJson<Act>(env, "/ui/api/activity?f.kind=in:mkvid");
    expect(Object.fromEntries(act.rows.map((r) => [r.ref.key, [r.status, r.problem]]))).toEqual({
      a: ["removed_unconfirmed", true],
      b: ["removed_unconfirmed", true],
      c: ["removed_unconfirmed", true],
      old: ["recording_removed", false],
    });
    expect(act.rows.find((r) => r.ref.key === "a")!.detail).toBe(
      'The recording looks gone from SoundCloud (the link answers "not found"), but so did several others within a day.',
    );
    expect(
      (await getJson<Act>(env, "/ui/api/activity?f.problem=eq:1")).rows
        .map((r) => r.ref.key)
        .sort(),
    ).toEqual(["a", "b", "c"]);
    expect(
      (await getJson<Act>(env, "/ui/api/activity?f.status=in:removed_unconfirmed")).rows,
    ).toHaveLength(3);

    const stats = await computeStats(env, T + DAY);
    expect(stats.cards).toMatchObject({ mkvidFailed: 3, mkvidNoRecording: 1 });
    expect(Object.fromEntries(stats.breakdowns.mkvidStatus.map((x) => [x.label, x.value]))).toEqual(
      { removed_unconfirmed: 3, recording_removed: 1 },
    );
    expect(stats.daily.mkvidFailed!.reduce((n, d) => n + d[1], 0)).toBe(3);

    expect((await setDiagnostics(env, setUrl("a"))).mkvid).toMatchObject({
      status: "failed",
      outcome: "removed_unconfirmed",
    });
    expect((await setDiagnostics(env, setUrl("old"))).mkvid).toMatchObject({
      status: "failed",
      outcome: "recording_removed",
    });

    // Answered: none of them is a problem any more.
    expect(await confirmRemovedBurst(env)).toMatchObject({ count: 3 });
    expect((await getJson<Act>(env, "/ui/api/activity?f.problem=eq:1")).rows).toHaveLength(0);
    expect((await computeStats(env, T + DAY)).cards).toMatchObject({
      mkvidFailed: 0,
      mkvidNoRecording: 4,
    });
    expect((await setDiagnostics(env, setUrl("a"))).mkvid).toMatchObject({
      outcome: "recording_removed",
    });
  });

  it("the sync does not queue one again with a new source until the owner says they are really gone", async () => {
    const env = makeEnv();
    await row(env, "old", T - 9 * DAY);
    await open(env);
    expect(await enqueueOtherSource(env, "a")).toBe("exists");
    expect(await stored(env, "a")).toMatchObject({
      status: "failed",
      error: GONE,
      source: "soundcloud",
      updated_at: T,
    });
    // A removal that is not in the burst is revived as before.
    expect(await enqueueOtherSource(env, "old")).toBe("requeued");
    // Still frozen, whatever is in KV: the burst is read from the stored requests.
    await env.SUBS.delete(REMOVED_BURST_KEY);
    expect(await enqueueOtherSource(env, "b")).toBe("exists");

    expect(await confirmRemovedBurst(env)).toMatchObject({ since: T, count: 3 });
    expect(await enqueueOtherSource(env, "a")).toBe("requeued");
    expect(await stored(env, "a")).toMatchObject({
      status: "pending",
      error: null,
      source: "hearthis",
      attempts: 0,
    });
  });

  it("a repeated failure report from mkvid changes nothing", async () => {
    const env = makeEnv();
    await open(env);
    expect(
      await failMkvidRequest(
        env,
        { id: "a", error: "render: ffmpeg exit 1", permanent: false },
        log,
      ),
    ).toEqual({ status: "failed", attempts: 1 });
    expect(await stored(env, "a")).toMatchObject({ status: "failed", error: GONE, updated_at: T });
    expect(await getRemovedBurst(env)).toMatchObject({ since: T, count: 3 });
  });

  it("the owner's own actions on one request still work, and the rest stays open until none is left", async () => {
    const env = makeEnv();
    await open(env);
    expect(await banMkvidRequest(env, "a")).toBe(true);
    expect((await getMkvidRequest(env, "a"))!.status).toBe("banned");
    // Two left, fewer than the count that opened it: still open, still frozen.
    expect(await getRemovedBurst(env)).toMatchObject({ since: T, count: 2 });
    expect(await enqueueOtherSource(env, "b")).toBe("exists");
    expect(await retryMkvidRequest(env, "b")).toBe(true);
    expect((await getMkvidRequest(env, "b"))!).toMatchObject({
      status: "pending",
      attempts: 0,
      error: null,
    });
    expect(await getRemovedBurst(env)).toMatchObject({ since: T, count: 1 });
    expect(await retryMkvidRequest(env, "c")).toBe(true);
    // Each was acted on by hand: it is over without an answer.
    expect(await getRemovedBurst(env)).toBeNull();
    expect(await env.SUBS.get(REMOVED_BURST_KEY, "json")).toEqual({ since: null });
    expect(await env.SUBS.get(REMOVED_BURST_ACK_KEY)).toBeNull();
  });
});

describe("the owner's two answers", () => {
  it('"They are really gone": ordinary removals from then on, never counted again; later removals start from zero', async () => {
    const env = makeEnv();
    for (const [id, at] of [
      ["a", T],
      ["b", T + 60],
      ["c", T + 120],
    ] as const)
      await row(env, id, at);
    const res = await post(env, "/ui/api/mkvid/removed-burst/confirm");
    expect([res.status, await res.json()]).toEqual([200, { ok: true, confirmed: 3, since: T }]);
    expect(await getRemovedBurst(env)).toBeNull();
    const h = await getJson<Header>(env, "/ui/api/mkvid");
    expect(h.removedBurst).toBeNull();
    expect(h.outcomes).toMatchObject({ recording_removed: 3, removed_unconfirmed: 0 });
    expect(await stored(env, "a")).toMatchObject({ status: "failed", error: GONE, updated_at: T });
    // Nothing to answer twice.
    expect((await post(env, "/ui/api/mkvid/removed-burst/confirm")).status).toBe(409);

    // Two more, close to the confirmed three: five removals in a day, but only two that are new.
    await row(env, "d", T + 200);
    await row(env, "e", T + 260);
    expect(await getRemovedBurst(env)).toBeNull();
    await row(env, "f", T + 320);
    expect(await getRemovedBurst(env)).toEqual({
      since: T + 200,
      count: 3,
      sources: { soundcloud: 3 },
      threshold: 3,
    });
    expect(
      ids(await getJson<Fin>(env, "/ui/api/mkvid/finished?f.status=in:removed_unconfirmed")),
    ).toEqual(["d", "e", "f"]);
    expect(
      ids(await getJson<Fin>(env, "/ui/api/mkvid/finished?f.status=in:recording_removed")),
    ).toEqual(["a", "b", "c"]);
  });

  it('"Try them again": every request in it goes back in the queue with a fresh start', async () => {
    const env = makeEnv();
    await row(env, "old", T - 9 * DAY);
    await row(env, "s", T + 30, { error: SHORT });
    for (const [id, at] of [
      ["a", T],
      ["b", T + 60],
      ["c", T + 120],
    ] as const)
      await row(env, id, at, { attempts: 3 });
    const res = await post(env, "/ui/api/mkvid/removed-burst/retry");
    expect([res.status, await res.json()]).toEqual([200, { ok: true, requeued: 3, since: T }]);
    for (const id of ["a", "b", "c"])
      expect(await stored(env, id)).toMatchObject({ status: "pending", attempts: 0, error: null });
    // The removal before the burst and the short recording are left alone.
    expect(await stored(env, "old")).toMatchObject({ status: "failed", error: GONE });
    expect(await stored(env, "s")).toMatchObject({ status: "failed", error: SHORT });
    expect(await getRemovedBurst(env)).toBeNull();
    expect((await post(env, "/ui/api/mkvid/removed-burst/retry")).status).toBe(409);
    expect((await getJson<Header>(env, "/ui/api/mkvid")).counts).toMatchObject({
      pending: 3,
      failed: 2,
    });

    // Still gone: mkvid fails them again, and the third failure opens a new burst.
    await env.DB.prepare(
      "UPDATE mkvid_requests SET status = 'claimed', attempts = 1 WHERE id IN ('a', 'b', 'c')",
    ).run();
    expect(
      await failMkvidRequest(env, { id: "a", error: GONE, permanent: true }, log),
    ).toMatchObject({ status: "failed" });
    expect(
      await failMkvidRequest(env, { id: "b", error: GONE, permanent: true }, log),
    ).toMatchObject({ status: "failed" });
    expect(await getRemovedBurst(env)).toBeNull();
    expect(
      await failMkvidRequest(env, { id: "c", error: GONE, permanent: true }, log),
    ).toMatchObject({ status: "failed" });
    expect(await getRemovedBurst(env)).toMatchObject({ count: 3, sources: { soundcloud: 3 } });
  });

  it("both answers are behind Cloudflare Access and the same-origin guard", async () => {
    const gated = { ...makeEnv(), DEV_BYPASS_CF_ACCESS: undefined } as unknown as Env;
    for (const [id, at] of [
      ["a", T],
      ["b", T + 60],
      ["c", T + 120],
    ] as const)
      await row(gated, id, at);
    // No Access configuration and no dev bypass: the gate refuses (it fails closed) before either route runs.
    for (const what of ["retry", "confirm"])
      expect(
        (await post(gated, `/ui/api/mkvid/removed-burst/${what}`)).status,
      ).toBeGreaterThanOrEqual(400);
    expect(await getRemovedBurst(gated)).toMatchObject({ count: 3 });
    const env = makeEnv();
    for (const [id, at] of [
      ["a", T],
      ["b", T + 60],
      ["c", T + 120],
    ] as const)
      await row(env, id, at);
    for (const what of ["retry", "confirm"]) {
      expect(
        (await post(env, `/ui/api/mkvid/removed-burst/${what}`, "https://evil.example")).status,
      ).toBe(403);
      expect((await post(env, `/ui/api/mkvid/removed-burst/${what}`, null)).status).toBe(403);
    }
    expect(await getRemovedBurst(env)).toMatchObject({ count: 3 });
    expect(await stored(env, "a")).toMatchObject({ status: "failed" });
  });
});

describe("the first read after this ships", () => {
  it("production on 2026-10-12: four removals, three of them within five minutes, and nothing stored yet", async () => {
    const env = makeEnv();
    // Read days later: the day is between the removals, not back from now.
    const first = T - 3 * DAY;
    await row(env, "older", first - 6 * DAY);
    await row(env, "g1", first);
    await row(env, "g2", first + 140);
    await row(env, "g3", first + 290);
    expect([
      await env.SUBS.get(REMOVED_BURST_KEY),
      await env.SUBS.get(REMOVED_BURST_ACK_KEY),
    ]).toEqual([null, null]);

    const h = await getJson<Header>(env, "/ui/api/mkvid");
    expect(h.removedBurst).toEqual({
      since: first,
      count: 3,
      sources: { soundcloud: 3 },
      threshold: 3,
    });
    expect(h.outcomes).toMatchObject({ removed_unconfirmed: 3, recording_removed: 1, failed: 0 });
    expect(await env.SUBS.get(REMOVED_BURST_KEY, "json")).toEqual({ since: first });
    // The owner checked them by hand: one press, and it is as it was before.
    expect((await post(env, "/ui/api/mkvid/removed-burst/confirm")).status).toBe(200);
    const after = await getJson<Header>(env, "/ui/api/mkvid");
    expect(after.removedBurst).toBeNull();
    expect(after.outcomes).toMatchObject({
      removed_unconfirmed: 0,
      recording_removed: 4,
      failed: 0,
    });
    expect(await env.SUBS.get(REMOVED_BURST_ACK_KEY, "json")).toEqual({ ackAt: first + 290 });
    expect(await env.SUBS.get(REMOVED_BURST_KEY, "json")).toEqual({ since: null });
    expect(await enqueueOtherSource(env, "g1")).toBe("requeued");
  });

  it("a lone older removal next to nothing else stays quiet", async () => {
    const env = makeEnv();
    await row(env, "older", T - 9 * DAY);
    await row(env, "g1", T);
    const h = await getJson<Header>(env, "/ui/api/mkvid");
    expect(h.removedBurst).toBeNull();
    expect(h.outcomes).toMatchObject({ removed_unconfirmed: 0, recording_removed: 2 });
  });
});

describe("KV trouble never breaks a page or thaws a request", () => {
  const BURST_KEYS = [REMOVED_BURST_KEY, REMOVED_BURST_ACK_KEY];
  /** An env whose SUBS misbehaves for the burst's two keys only; `puts` lists the writes to them that were tried. */
  function flaky(o: {
    get?: (key: string) => boolean;
    put?: (key: string, nth: number) => boolean;
  }) {
    const env = makeEnv();
    const kv = env.SUBS;
    const puts: string[] = [];
    const get = kv.get.bind(kv) as (key: string, type?: unknown) => Promise<unknown>;
    const put = kv.put.bind(kv) as (key: string, value: string) => Promise<void>;
    (kv as unknown as { get: unknown }).get = async (key: string, type?: unknown) => {
      if (BURST_KEYS.includes(key) && o.get?.(key))
        throw new Error("KV GET failed: 500 Internal Server Error");
      return get(key, type);
    };
    (kv as unknown as { put: unknown }).put = async (key: string, value: string) => {
      if (BURST_KEYS.includes(key)) {
        puts.push(key);
        if (o.put?.(key, puts.filter((k) => k === key).length))
          throw new Error("KV PUT failed: 429 Too Many Requests");
      }
      return put(key, value);
    };
    return { env, puts, raw: { get, put } };
  }
  const three = async (env: Env) => {
    for (const [id, at] of [
      ["a", T],
      ["b", T + 60],
      ["c", T + 120],
    ] as const)
      await row(env, id, at);
  };

  it("a KV write that is refused (two reads in one second) still answers 200 with the burst", async () => {
    const { env, puts } = flaky({ put: () => true });
    await three(env);
    // The mkvid page's three requests and Home's, all at once.
    const res = await Promise.all(
      [
        "/ui/api/mkvid",
        "/ui/api/mkvid/finished",
        "/ui/api/mkvid/queue",
        "/ui/api/activity",
        "/ui/api/mkvid?limit=1",
      ].map((path) => app.request(`http://x${path}`, {}, env)),
    );
    expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(((await res[0]!.json()) as Header).removedBurst).toEqual({
      since: T,
      count: 3,
      sources: { soundcloud: 3 },
      threshold: 3,
    });
    expect(((await res[1]!.json()) as Fin).counts).toMatchObject({ removed_unconfirmed: 3 });
    expect(puts.length).toBeGreaterThan(0);
    expect(puts.every((k) => k === REMOVED_BURST_KEY)).toBe(true);
    // Nothing was remembered, and nothing depends on it: still open, still frozen.
    expect(await env.SUBS.get(REMOVED_BURST_KEY)).toBeNull();
    expect(await enqueueOtherSource(env, "a")).toBe("exists");
  });

  it("a KV read that fails still renders every page, keeps the requests frozen and writes nothing", async () => {
    const { env, puts, raw } = flaky({ get: () => true });
    await three(env);
    // Settled earlier, which cannot be read now: these come back red rather than risk a thaw.
    await raw.put(REMOVED_BURST_ACK_KEY, JSON.stringify({ ackAt: T + 120 }));
    const h = await getJson<Header>(env, "/ui/api/mkvid");
    expect(h.removedBurst).toEqual({
      since: T,
      count: 3,
      sources: { soundcloud: 3 },
      threshold: 3,
    });
    expect((await getJson<Fin>(env, "/ui/api/mkvid/finished")).counts).toMatchObject({
      removed_unconfirmed: 3,
      recording_removed: 0,
    });
    expect(
      (await getJson<{ rows: unknown[] }>(env, "/ui/api/activity?f.status=in:removed_unconfirmed"))
        .rows,
    ).toHaveLength(3);
    expect(
      (
        await getJson<{ mkvid: { outcome: string } }>(
          env,
          `/ui/api/set?url=${encodeURIComponent(setUrl("a"))}`,
        )
      ).mkvid.outcome,
    ).toBe("removed_unconfirmed");
    expect((await computeStats(env, T + DAY)).cards).toMatchObject({ mkvidFailed: 3 });
    expect(await enqueueOtherSource(env, "a")).toBe("exists");
    expect(
      await failMkvidRequest(
        env,
        { id: "b", error: "render: ffmpeg exit 1", permanent: false },
        log,
      ),
    ).toEqual({ status: "failed", attempts: 1 });
    // An answer cannot be taken on state nobody could read: refused, nothing changed.
    for (const what of ["retry", "confirm"]) {
      const res = await post(env, `/ui/api/mkvid/removed-burst/${what}`);
      expect([what, res.status, ((await res.json()) as { error: string }).error]).toEqual([
        what,
        503,
        "state_unavailable",
      ]);
    }
    expect(await stored(env, "a")).toMatchObject({ status: "failed", error: GONE, updated_at: T });
    expect(puts).toEqual([]);
    expect(await raw.get(REMOVED_BURST_ACK_KEY, "json")).toEqual({ ackAt: T + 120 });
  });

  it("a burst kept open below the count stays frozen when KV cannot be read", async () => {
    let down = false;
    const { env, puts } = flaky({ get: () => down });
    await three(env);
    expect(await getRemovedBurst(env)).toMatchObject({ since: T, count: 3 });
    // The owner retried two by hand: one is left, held only by the remembered start.
    expect(await retryMkvidRequest(env, "a")).toBe(true);
    expect(await retryMkvidRequest(env, "b")).toBe(true);
    expect(await getRemovedBurst(env)).toMatchObject({ since: T, count: 1 });
    const before = puts.length;
    down = true;
    expect(await getRemovedBurst(env)).toEqual({
      since: T + 120,
      count: 1,
      sources: { soundcloud: 1 },
      threshold: 3,
    });
    expect(
      (await getJson<Fin>(env, "/ui/api/mkvid/finished?f.status=in:removed_unconfirmed")).rows.map(
        (r) => [r.id, r.outcome],
      ),
    ).toEqual([["c", "removed_unconfirmed"]]);
    expect(await enqueueOtherSource(env, "c")).toBe("exists");
    expect(
      await failMkvidRequest(
        env,
        { id: "c", error: "render: ffmpeg exit 1", permanent: false },
        log,
      ),
    ).toEqual({ status: "failed", attempts: 1 });
    expect(await stored(env, "c")).toMatchObject({
      status: "failed",
      error: GONE,
      source: "soundcloud",
      updated_at: T + 120,
    });
    expect(puts.length).toBe(before);
    // KV is back: the same burst as before, from its remembered start.
    down = false;
    expect(await getRemovedBurst(env)).toMatchObject({ since: T, count: 1 });
    expect(await enqueueOtherSource(env, "c")).toBe("exists");
  });

  it("switching the setting off forgets an open burst: switching it on again does not resume it", async () => {
    const env = makeEnv();
    await three(env);
    expect(await getRemovedBurst(env)).toMatchObject({ since: T, count: 3 });
    expect(await retryMkvidRequest(env, "a")).toBe(true);
    expect(await retryMkvidRequest(env, "b")).toBe(true);
    expect((await updateAppSettings(env, { mkvid: { removedBurstCount: 0 } })).ok).toBe(true);
    expect(await getRemovedBurst(env)).toBeNull();
    expect(await env.SUBS.get(REMOVED_BURST_KEY, "json")).toEqual({ since: null });
    expect((await updateAppSettings(env, { mkvid: { removedBurstCount: 3 } })).ok).toBe(true);
    // One removal left from before, one new one: two, not a burst of three.
    await row(env, "d", T + 5 * DAY);
    expect(await getRemovedBurst(env)).toBeNull();
    expect(await enqueueOtherSource(env, "d")).toBe("requeued");
  });

  it("an error that is not KV is not reported as a storage failure", async () => {
    const env = makeEnv();
    await three(env);
    const broken = {
      ...env,
      DB: {
        prepare: () => {
          throw new Error("D1_ERROR: no such table");
        },
      },
    } as unknown as Env;
    for (const what of ["retry", "confirm"]) {
      const res = await post(broken, `/ui/api/mkvid/removed-burst/${what}`);
      expect([what, res.status]).toEqual([what, 500]);
      expect(await res.text()).not.toContain("state_unavailable");
    }
  });

  it('each answer writes KV once, and "They are really gone" tries once more when its write is refused', async () => {
    const once = flaky({ put: (key, nth) => key === REMOVED_BURST_ACK_KEY && nth === 1 });
    await three(once.env);
    const res = await post(once.env, "/ui/api/mkvid/removed-burst/confirm");
    expect([res.status, await res.json()]).toEqual([200, { ok: true, confirmed: 3, since: T }]);
    // No write of its own read before it: the refused one and the second try, nothing else.
    expect(once.puts).toEqual([REMOVED_BURST_ACK_KEY, REMOVED_BURST_ACK_KEY]);
    expect(await once.env.SUBS.get(REMOVED_BURST_ACK_KEY, "json")).toEqual({ ackAt: T + 120 });
    expect(await getRemovedBurst(once.env)).toBeNull();

    const never = flaky({ put: (key) => key === REMOVED_BURST_ACK_KEY });
    await three(never.env);
    const refused = await post(never.env, "/ui/api/mkvid/removed-burst/confirm");
    expect([refused.status, ((await refused.json()) as { error: string }).error]).toEqual([
      503,
      "state_unavailable",
    ]);
    expect(await getRemovedBurst(never.env)).toMatchObject({ count: 3 });

    // "Try them again": the requests go back whatever KV does with the one write after it.
    const retry = flaky({ put: () => true });
    await three(retry.env);
    const back = await post(retry.env, "/ui/api/mkvid/removed-burst/retry");
    expect([back.status, await back.json()]).toEqual([200, { ok: true, requeued: 3, since: T }]);
    expect(retry.puts).toEqual([REMOVED_BURST_KEY]);
    expect(await stored(retry.env, "a")).toMatchObject({ status: "pending", attempts: 0 });
    expect(await getRemovedBurst(retry.env)).toBeNull();
  });

  it('a stale read somewhere else cannot undo "They are really gone"', async () => {
    const env = makeEnv();
    await three(env);
    // Another location, a moment after the answer: it still reads KV as it was before, and sees the burst.
    const stale = { ...env, SUBS: fakeKV() } as Env;
    const realPut = env.SUBS.put.bind(env.SUBS);
    (stale.SUBS as unknown as { put: unknown }).put = realPut;
    expect((await post(env, "/ui/api/mkvid/removed-burst/confirm")).status).toBe(200);
    expect(await env.SUBS.get(REMOVED_BURST_ACK_KEY, "json")).toEqual({ ackAt: T + 120 });
    // Its read works the burst out again and remembers the start: the only thing it can write.
    expect(await getRemovedBurst(stale)).toMatchObject({ since: T, count: 3 });
    expect(await env.SUBS.get(REMOVED_BURST_KEY, "json")).toEqual({ since: T });
    expect(await env.SUBS.get(REMOVED_BURST_ACK_KEY, "json")).toEqual({ ackAt: T + 120 });
    // With current KV the answer stands: no burst, ordinary removals, revivable.
    expect(await getRemovedBurst(env)).toBeNull();
    expect((await getJson<Header>(env, "/ui/api/mkvid")).outcomes).toMatchObject({
      removed_unconfirmed: 0,
      recording_removed: 3,
    });
    // The leftover start does not pull a later lone removal into a burst.
    await env.SUBS.put(REMOVED_BURST_KEY, JSON.stringify({ since: T }));
    await row(env, "d", T + 500);
    expect(await getRemovedBurst(env)).toBeNull();
    expect(await enqueueOtherSource(env, "a")).toBe("requeued");
    // The same answer given again from the stale place settles up to the same removal, or a later one: never an earlier one.
    await row(env, "e", T + 560);
    await row(env, "f", T + 620);
    expect(await getRemovedBurst(env)).toMatchObject({ since: T + 500, count: 3 });
    expect(await confirmRemovedBurst(stale)).not.toBeNull();
    expect(((await env.SUBS.get(REMOVED_BURST_ACK_KEY, "json")) as { ackAt: number }).ackAt).toBe(
      T + 620,
    );
    expect(await getRemovedBurst(env)).toBeNull();
  });
});
