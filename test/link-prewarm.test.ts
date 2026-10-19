/**
 * Per-track link pre-warm (lib/link-prewarm.ts): which ids a parsed set
 * queues, that a track on several sets is queued once, and the cron's drain
 * (cap, cached ids, priority backfill, a pool refusal ends it and charges
 * nothing, a failed lookup backs off and is dropped after MAX_ATTEMPTS),
 * the settings off-switch, and that queueing never throws. tlpool is a
 * stubbed global fetch; D1 and KV are the in-memory fakes with the real
 * migrations.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { fakeKV } from "./helpers/fake-kv";
import { fakeD1 } from "./helpers/fake-d1";
import type { Env } from "../src/types";
import {
  drainLinkPrewarm,
  enqueueLinkPrewarm,
  FAIL_BACKOFF_SECONDS,
  linkPrewarmPending,
  MAX_ATTEMPTS,
  prewarmIds,
} from "../src/lib/link-prewarm";
import { parseTracklist } from "../src/lib/tracklists1001";
import { medialinkReferer, mediaLinksCacheKey } from "../src/lib/medialinks-all";
import { budgetHoldKey, TICK_BACKOFF_KEY } from "../src/lib/fetch-scheduler";
import { DEFAULT_APP_SETTINGS, updateAppSettings } from "../src/lib/app-settings";
import { makeLogger } from "../src/lib/log";
import { schedulerSummary } from "../src/lib/scheduler-report";

const here = dirname(fileURLToPath(import.meta.url));
const POOL = "https://tlpool.example";
const ML_FOUND = readFileSync(resolve(here, "fixtures", "medialink-909720.json"), "utf8");
const SET = "https://www.1001tracklists.com/tracklist/2f4x9k7t/max-styler-edc.html";
const OTHER_SET = "https://www.1001tracklists.com/tracklist/1abc2def/other.html";
const page = parseTracklist(
  SET,
  readFileSync(resolve(here, "fixtures", "tracklist-maxstyler.html"), "utf8"),
);
const NOW = 1_800_000_000;
const log = makeLogger({ test: "link-prewarm" });

function makeEnv(): Env {
  return {
    CACHE: fakeKV(),
    DB: fakeD1(),
    SUBS: fakeKV(),
    API_TOKEN: "t",
    YOUTUBE_API_KEY: "k",
    TLPOOL_URL: POOL,
    TLPOOL_TOKEN: "pt",
  } as unknown as Env;
}

type Asked = Array<{ id: string; priority: string; maxWaitSeconds: number; referer?: string }>;
/** tlpool answers each medialink with `answer(id)`: a body string, or a contract error object. */
function stubPool(
  answer: (id: string) => string | { error: string; retryAfterSeconds?: number } = () => ML_FOUND,
): Asked {
  const asked: Asked = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url !== `${POOL}/fetch`) throw new Error(`unexpected fetch ${url}`);
      const body = JSON.parse(String(init!.body)) as {
        url: string;
        priority: string;
        maxWaitSeconds: number;
        headers?: Record<string, string>;
      };
      const id = new URL(body.url).searchParams.get("idItem")!;
      asked.push({
        id,
        priority: body.priority,
        maxWaitSeconds: body.maxWaitSeconds,
        referer: body.headers?.Referer,
      });
      const a = answer(id);
      if (typeof a !== "string") return Response.json(a);
      return Response.json({
        status: 200,
        finalUrl: body.url,
        html: a,
        accountId: "acct-1",
        exitLabel: "exit-a",
        fetchedAt: new Date().toISOString(),
        bytes: a.length,
      });
    }),
  );
  return asked;
}

async function queued(env: Env): Promise<
  Array<{
    track_id: string;
    set_url: string;
    attempts: number;
    next_at: number;
    last_error: string | null;
  }>
> {
  return (
    await env.DB.prepare(
      "SELECT track_id, set_url, attempts, next_at, last_error FROM link_prewarm ORDER BY queued_at, rowid",
    ).all<{
      track_id: string;
      set_url: string;
      attempts: number;
      next_at: number;
      last_error: string | null;
    }>()
  ).results;
}

async function enqueueIds(env: Env, ids: string[], nowSec = NOW): Promise<void> {
  const rows = ids.map((id) => ({
    ...page.rows[0]!,
    anonymous: false,
    isUnidentified: false,
    mediaId: id,
    trackId: id,
  }));
  await enqueueLinkPrewarm(env, SET, { tracks: [], rows }, log, nowSec);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("which tracks a parsed set queues", () => {
  it("named, identified rows with a numeric medialink id; never a row whose only id is its data-id (a page position)", () => {
    const ids = prewarmIds(page);
    const named = page.rows.filter((r) => !r.anonymous && !r.isUnidentified);
    expect(ids).toEqual([...new Set(named.filter((r) => r.mediaId).map((r) => r.mediaId!))]);
    // This page has two identified-looking rows with no media row: their trackId is a numeric data-id, and is not queued.
    const positions = page.rows
      .filter((r) => !r.anonymous && r.mediaId === null)
      .map((r) => r.trackId!);
    expect(positions.length).toBeGreaterThan(0);
    for (const p of positions) expect(/^\d+$/.test(p) && ids.includes(p)).toBe(false);
  });

  it("leaves out anonymous and unidentified rows, non-numeric ids, and a repeat of the same track", () => {
    const base = page.rows[0]!;
    const rows = [
      { ...base, anonymous: false, isUnidentified: false, mediaId: "11" },
      { ...base, anonymous: true, isUnidentified: true, mediaId: null, trackId: "12" },
      { ...base, anonymous: false, isUnidentified: true, mediaId: "13" },
      { ...base, anonymous: false, isUnidentified: false, mediaId: "abc" },
      { ...base, anonymous: false, isUnidentified: false, mediaId: "11" },
      // A list cached before mediaId existed: its trackId is what there is.
      { ...base, anonymous: false, isUnidentified: false, mediaId: undefined, trackId: "14" },
    ];
    expect(prewarmIds({ tracks: [], rows })).toEqual(["11", "14"]);
    // No rows at all (an old entry): the named tracks' numeric ids.
    expect(
      prewarmIds({
        tracks: [
          { ...base, trackId: "21" },
          { ...base, trackId: "x9" },
          { ...base, trackId: "22", isUnidentified: true },
        ],
        rows: [],
      }),
    ).toEqual(["21"]);
  });
});

describe("enqueueLinkPrewarm", () => {
  it("queues every eligible id once, and a track already queued from another set stays as it was", async () => {
    const env = makeEnv();
    expect(await enqueueLinkPrewarm(env, SET, page, log, NOW)).toBe(prewarmIds(page).length);
    const first = await queued(env);
    expect(first.map((r) => r.track_id)).toEqual(prewarmIds(page));
    expect(first.every((r) => r.set_url === SET && r.next_at === NOW && r.attempts === 0)).toBe(
      true,
    );
    // The same tracks on another set (and the same set read again): nothing new, nothing moved.
    await enqueueLinkPrewarm(env, OTHER_SET, page, log, NOW + 60);
    await enqueueLinkPrewarm(env, SET, page, log, NOW + 120);
    expect(await queued(env)).toEqual(first);
    expect(await linkPrewarmPending(env)).toBe(first.length);
    // The Scheduler page's count.
    expect((await schedulerSummary(env, NOW)).linkPrewarmPending).toBe(first.length);
  });

  it("queues nothing while linkPrewarm.enabled is off", async () => {
    const env = makeEnv();
    expect(await updateAppSettings(env, { linkPrewarm: { enabled: false } })).toMatchObject({
      ok: true,
    });
    expect(await enqueueLinkPrewarm(env, SET, page, log, NOW)).toBe(0);
    expect(await queued(env)).toEqual([]);
  });

  it("never throws: a D1 failure is logged and the caller carries on", async () => {
    const env = makeEnv();
    const db = env.DB;
    (env as { DB: unknown }).DB = {
      ...db,
      prepare: db.prepare.bind(db),
      batch: async () => {
        throw new Error("D1_ERROR: boom");
      },
    };
    await expect(enqueueLinkPrewarm(env, SET, page, log, NOW)).resolves.toBe(0);
    await expect(
      enqueueLinkPrewarm({ ...env, DB: undefined } as unknown as Env, SET, page, log, NOW),
    ).resolves.toBe(0);
  });

  it("defaults: on, 3 lookups a tick", () => {
    expect(DEFAULT_APP_SETTINGS.linkPrewarm).toEqual({ enabled: true, maxPerTick: 3 });
  });
});

describe("drainLinkPrewarm", () => {
  it("looks up at most maxPerTick uncached ids at priority backfill, caches them, and skips cached ids without a fetch", async () => {
    const env = makeEnv();
    await enqueueIds(env, ["1", "2", "3", "4", "5", "6"]);
    // 2 and 4 are already cached (a phone tap got there first).
    await env.CACHE.put(
      mediaLinksCacheKey("2"),
      JSON.stringify({ appleLink: null, youtubeLink: null, soundcloudLink: null }),
    );
    await env.CACHE.put(
      mediaLinksCacheKey("4"),
      JSON.stringify({ appleLink: null, youtubeLink: null, soundcloudLink: null }),
    );
    const asked = stubPool();
    const r = await drainLinkPrewarm(env, log, NOW);
    expect(r).toEqual({ read: 5, cached: 2, fetched: 3, failed: 0 });
    expect(asked.map((a) => a.id)).toEqual(["1", "3", "5"]);
    expect(asked.every((a) => a.priority === "backfill" && a.maxWaitSeconds === 60)).toBe(true);
    for (const id of ["1", "3", "5"])
      expect(await env.CACHE.get(mediaLinksCacheKey(id), "json")).toMatchObject({
        youtubeLink: expect.any(String),
      });
    // Fetched and cached ones left the queue; 6, past the cap, waits for the next tick.
    expect((await queued(env)).map((q) => q.track_id)).toEqual(["6"]);

    const r2 = await drainLinkPrewarm(env, log, NOW + 300);
    expect(r2).toEqual({ read: 1, cached: 0, fetched: 1, failed: 0 });
    expect(asked.map((a) => a.id)).toEqual(["1", "3", "5", "6"]);
    expect(await queued(env)).toEqual([]);
    expect(await drainLinkPrewarm(env, log, NOW + 600)).toEqual({
      read: 0,
      cached: 0,
      fetched: 0,
      failed: 0,
      skipped: "nothing_due",
    });
  });

  it("each lookup names the set page that queued it as its Referer (home when the row has none usable)", async () => {
    const env = makeEnv();
    await enqueueIds(env, ["1", "2"]);
    await env.DB.prepare(
      "INSERT INTO link_prewarm (track_id, set_url, queued_at, next_at) VALUES (?, ?, ?, ?)",
    )
      .bind("3", "https://evil.example/tracklist/x.html", NOW, NOW)
      .run();
    const asked = stubPool();
    expect(await drainLinkPrewarm(env, log, NOW)).toMatchObject({ fetched: 3 });
    expect(asked.map((a) => [a.id, a.referer])).toEqual([
      ["1", SET],
      ["2", SET],
      ["3", "https://www.1001tracklists.com/"],
    ]);
  });

  it("a pool refusal ends the drain, charges the row nothing and keeps the rest queued; budget_exhausted holds the backfill share", async () => {
    const env = makeEnv();
    await enqueueIds(env, ["1", "2", "3"]);
    const before = await queued(env);
    const asked = stubPool((id) =>
      id === "1" ? ML_FOUND : { error: "budget_exhausted", retryAfterSeconds: 900 },
    );
    const r = await drainLinkPrewarm(env, log, NOW);
    expect(r).toMatchObject({
      read: 2,
      fetched: 1,
      failed: 0,
      stoppedBy: expect.stringContaining("budget_exhausted"),
    });
    expect(asked.map((a) => a.id)).toEqual(["1", "2"]);
    // 2 is due again exactly as before (no attempt, no claim left behind), 3 untouched; 2 is not cached.
    expect(await queued(env)).toEqual(before.slice(1));
    expect(await env.CACHE.get(mediaLinksCacheKey("2"))).toBeNull();
    expect(Number(await env.CACHE.get(budgetHoldKey("backfill")))).toBe(NOW + 900);
    // While the hold lasts the next tick asks the pool nothing.
    expect(await drainLinkPrewarm(env, log, NOW + 300)).toMatchObject({
      skipped: "budget_hold",
      read: 0,
    });
    expect(asked).toHaveLength(2);
  });

  it("an unavailable pool ends the drain the same way, with no hold", async () => {
    const env = makeEnv();
    await enqueueIds(env, ["1", "2"]);
    const asked = stubPool(() => ({ error: "no_healthy_account" }));
    expect(await drainLinkPrewarm(env, log, NOW)).toMatchObject({
      read: 1,
      fetched: 0,
      failed: 0,
      stoppedBy: expect.any(String),
    });
    expect(asked).toHaveLength(1);
    expect((await queued(env)).map((q) => [q.track_id, q.attempts, q.next_at])).toEqual([
      ["1", 0, NOW],
      ["2", 0, NOW],
    ]);
    expect(await env.CACHE.get(budgetHoldKey("backfill"))).toBeNull();
  });

  it("waits out the scheduler's pool backoff and the backfill budget hold", async () => {
    const env = makeEnv();
    await enqueueIds(env, ["1"]);
    const asked = stubPool();
    await env.CACHE.put(TICK_BACKOFF_KEY, String(NOW + 60));
    expect(await drainLinkPrewarm(env, log, NOW)).toMatchObject({ skipped: "backoff" });
    await env.CACHE.delete(TICK_BACKOFF_KEY);
    await env.CACHE.put(budgetHoldKey("backfill"), String(NOW + 60));
    expect(await drainLinkPrewarm(env, log, NOW)).toMatchObject({ skipped: "budget_hold" });
    expect(asked).toHaveLength(0);
    expect(await drainLinkPrewarm(env, log, NOW + 61)).toMatchObject({ fetched: 1 });
  });

  it("a failed lookup is not cached, backs off FAIL_BACKOFF x attempts and is dropped after MAX_ATTEMPTS", async () => {
    const env = makeEnv();
    await enqueueIds(env, ["1", "2"]);
    const asked = stubPool((id) => (id === "1" ? "not json" : ML_FOUND));
    // The failure counts toward the cap like a fetch: a cap of 1 makes one lookup a tick.
    await updateAppSettings(env, { linkPrewarm: { maxPerTick: 1 } });
    expect(await drainLinkPrewarm(env, log, NOW)).toEqual({
      read: 1,
      cached: 0,
      fetched: 0,
      failed: 1,
    });
    expect(await env.CACHE.get(mediaLinksCacheKey("1"))).toBeNull();
    expect((await queued(env))[0]).toMatchObject({
      track_id: "1",
      attempts: 1,
      next_at: NOW + FAIL_BACKOFF_SECONDS,
      last_error: expect.stringContaining("not JSON"),
    });
    // Not retried in a hot loop: the next tick goes on to the next id.
    expect(await drainLinkPrewarm(env, log, NOW + 300)).toEqual({
      read: 1,
      cached: 0,
      fetched: 1,
      failed: 0,
    });
    expect(asked.map((a) => a.id)).toEqual(["1", "2"]);
    let t = NOW + FAIL_BACKOFF_SECONDS;
    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
      expect(await drainLinkPrewarm(env, log, t)).toMatchObject({ failed: 1 });
      t += FAIL_BACKOFF_SECONDS * attempt;
    }
    expect(await queued(env)).toEqual([]);
    expect(asked.filter((a) => a.id === "1")).toHaveLength(MAX_ATTEMPTS);
  });

  it("does nothing while off (enabled false, or a cap of 0), and leaves the queue as it is", async () => {
    const env = makeEnv();
    await enqueueIds(env, ["1"]);
    const asked = stubPool();
    await updateAppSettings(env, { linkPrewarm: { enabled: false } });
    expect(await drainLinkPrewarm(env, log, NOW)).toMatchObject({ skipped: "off" });
    await updateAppSettings(env, { linkPrewarm: { enabled: true, maxPerTick: 0 } });
    expect(await drainLinkPrewarm(env, log, NOW)).toMatchObject({ skipped: "off" });
    expect(asked).toHaveLength(0);
    expect(await linkPrewarmPending(env)).toBe(1);
  });

  it("leaves a row an overlapping drain has claimed", async () => {
    const env = makeEnv();
    await enqueueIds(env, ["1"]);
    const asked = stubPool();
    const db = env.DB;
    // The other drain claims the row between this one's read and its claim.
    const realPrepare = db.prepare.bind(db);
    let stolen = false;
    (env as { DB: unknown }).DB = {
      ...db,
      batch: db.batch.bind(db),
      prepare: (sql: string) => {
        if (
          !stolen &&
          sql.startsWith("UPDATE link_prewarm SET next_at = ? WHERE track_id = ? AND next_at = ?")
        ) {
          stolen = true;
          void realPrepare("UPDATE link_prewarm SET next_at = next_at + 600").run();
        }
        return realPrepare(sql);
      },
    };
    expect(await drainLinkPrewarm(env, log, NOW)).toMatchObject({ read: 1, fetched: 0 });
    expect(asked).toHaveLength(0);
  });
});

describe("medialinkReferer", () => {
  it("is the tracklist page on the site (no query or hash), else the home page", () => {
    expect(medialinkReferer(SET)).toBe(SET);
    expect(medialinkReferer(`${OTHER_SET}?x=1#y`)).toBe(OTHER_SET);
    for (const bad of [
      null,
      undefined,
      "",
      "not a url",
      "http://www.1001tracklists.com/tracklist/a/b.html",
      "https://1001tracklists.com.evil.example/tracklist/a/b.html",
      "https://www.1001tracklists.com/dj/someone/index.html",
    ])
      expect(medialinkReferer(bad)).toBe("https://www.1001tracklists.com/");
  });
});
