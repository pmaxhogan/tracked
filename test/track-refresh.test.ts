import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeD1 } from "./helpers/fake-d1";
import { fakeKV } from "./helpers/fake-kv";
import type { Env } from "../src/types";
import {
  DEFAULT_POOL_SETTINGS,
  getPoolSettings,
  POOL_SETTINGS_KEY,
  updatePoolSettings,
} from "../src/lib/pool-settings";
import {
  budgetHoldKey,
  ENSURE_STAMP_KEY,
  INFLIGHT_KEY,
  mixRefresh,
  pickRefreshItems,
  REFRESH_EMPTY_KEY,
  refreshAllowance,
  runSchedulerTick,
  trackRefreshAllowance,
  type RefreshSet,
  type TickItem,
} from "../src/lib/fetch-scheduler";
import {
  runTrackRefresh,
  trackRefreshCandidates,
  type TrackRefreshCandidate,
} from "../src/lib/track-refresh";
import { labelFromTrackUrl, tickViewFromDb } from "../src/lib/scheduler-report";
import { PoolPausedError } from "../src/lib/pool";
import { _resetTallyForTests } from "../src/lib/ban-state";
import { makeLogger } from "../src/lib/log";
import type { LinkEntry } from "../src/lib/medialinks-all";

// The idle refresh's track lookups (lib/track-refresh.ts). The medialink
// lookup is stubbed; the scheduler and D1 run for real.
vi.mock("../src/lib/medialinks-all", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/medialinks-all")>(
    "../src/lib/medialinks-all",
  );
  return { ...actual, fetchAllMediaLinks: vi.fn() };
});
import { fetchAllMediaLinks } from "../src/lib/medialinks-all";

const H = 3600;
const D = 24 * H;
const NOON = Math.floor(Date.now() / 1000 / D) * D + 12 * H;
const MS = (sec: number) => sec * 1000;
const S = DEFAULT_POOL_SETTINGS;
const mocked = (f: unknown) => f as ReturnType<typeof vi.fn>;
const always = (x: number) => () => x;
const trackUrl = (id: string) =>
  `https://www.1001tracklists.com/track/x${id}/artist-track-${id}/index.html`;

function makeEnv(): Env {
  return {
    CACHE: fakeKV(),
    DB: fakeD1(),
    SUBS: fakeKV(),
    API_TOKEN: "t",
    YOUTUBE_API_KEY: "k",
    TLPOOL_URL: "https://tlpool.example",
    TLPOOL_TOKEN: "pt",
  } as Env;
}

/** One DJ with nothing due, the index catch-up off; YouTube connected unless `youtube` is false. */
async function setup(env: Env, youtube = true) {
  await env.DB.prepare(
    "INSERT INTO subscriptions (slug, source_url, added_at, position) VALUES ('dj', 'https://www.1001tracklists.com/dj/dj/', 0, 0)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO dj_schedule (slug, next_discovery_at, next_backfill_at, updated_at) VALUES ('dj', ?, ?, ?)",
  )
    .bind(NOON + 300 * D, NOON + 300 * D, NOON)
    .run();
  await env.SUBS.put("subs:migrated", "{}");
  if (youtube)
    await env.SUBS.put(
      "oauth:google",
      JSON.stringify({
        accessToken: "tok",
        refreshToken: "r",
        expiresAt: NOON + 400 * D,
        scope: "s",
        channelId: null,
        channelTitle: null,
        connectedAt: 0,
      }),
    );
  await env.CACHE.put(ENSURE_STAMP_KEY, String(NOON + 400 * D));
  await updatePoolSettings(env, { indexCatchUp: { perDay: 0 } });
}

/** A pre-save candidate track, seen by a set fetch `seenDaysAgo` days ago. */
async function candidate(
  env: Env,
  id: string,
  o: {
    seenDaysAgo?: number;
    checkedAt?: number | null;
    isId?: boolean;
    trackId?: string | null;
  } = {},
) {
  await env.DB.prepare(
    `INSERT INTO presave_candidates (key, track_id, track_url, artist, title, is_id, presave_count, set_url, dj_slug, first_seen_at, updated_at, links_checked_at)
     VALUES (?, ?, ?, 'A', 'T', ?, 3, 'https://www.1001tracklists.com/tracklist/s/set.html', 'dj', 0, ?, ?)`,
  )
    .bind(
      `track:${id}`,
      o.trackId === undefined ? id : o.trackId,
      trackUrl(id),
      o.isId ? 1 : 0,
      MS(NOON - (o.seenDaysAgo ?? 30) * D),
      o.checkedAt ?? null,
    )
    .run();
}

const checkedAt = async (env: Env, id: string) =>
  (
    await env.DB.prepare("SELECT links_checked_at AS at FROM presave_candidates WHERE track_id = ?")
      .bind(id)
      .first<{ at: number | null }>()
  )?.at;

const link = (name: string, source: string): LinkEntry => ({
  source,
  name,
  url: null,
  playerId: name === "youtube" ? "abcdefghijk" : "p",
  duration: null,
});

function lookupGives(links: LinkEntry[]) {
  mocked(fetchAllMediaLinks).mockResolvedValue({
    ok: true,
    links,
    classic: { appleLink: null, youtubeLink: null, soundcloudLink: null },
    success: true,
    accountId: "acct-1",
    ms: 5,
  });
}

const ids = async (env: Env, now = NOON) =>
  (await trackRefreshCandidates(env, S.refresh.trackCooldownHours, MS(now), 100)).map(
    (c) => c.trackId,
  );

beforeEach(() => {
  vi.resetAllMocks();
  _resetTallyForTests();
  lookupGives([link("soundcloud", "10")]);
});

describe("track refresh: which tracks", () => {
  it("stalest first by the later of the last set fetch and the last lookup; recently looked at ones wait", async () => {
    const env = makeEnv();
    await candidate(env, "1", { seenDaysAgo: 20 });
    await candidate(env, "2", { seenDaysAgo: 30 });
    // Seen 40 days ago by a set fetch, looked up 10 days ago: 10 days stale.
    await candidate(env, "3", { seenDaysAgo: 40, checkedAt: MS(NOON - 10 * D) });
    await candidate(env, "4", { seenDaysAgo: 2 });
    await candidate(env, "5", { seenDaysAgo: 40, checkedAt: MS(NOON - D) });
    expect(await ids(env)).toEqual(["2", "1", "3"]);
    expect(await ids(env, NOON + 6 * D)).toEqual(["2", "1", "3", "4", "5"]);
  });

  it("leaves out ID rows, presaved tracks and tracks still queued for their first link pre-warm", async () => {
    const env = makeEnv();
    await candidate(env, "keep");
    await candidate(env, "idrow", { isId: true });
    await candidate(env, "noid", { trackId: null });
    await candidate(env, "saved");
    await env.DB.prepare(
      "INSERT INTO presaves (track_id, stage, created_at, updated_at) VALUES ('saved', 'links', 0, 0)",
    ).run();
    await candidate(env, "queued");
    await env.DB.prepare(
      "INSERT INTO link_prewarm (track_id, set_url, queued_at, next_at) VALUES ('queued', 's', 0, 0)",
    ).run();
    expect(await ids(env)).toEqual(["keep"]);
  });

  it("allowance: what is left of tracksPerDay, within the refresh allowance; 0 = sets only", async () => {
    const env = makeEnv();
    expect(await trackRefreshAllowance(env, S, NOON)).toBe(S.refresh.perTick);
    const off = { ...S, refresh: { ...S.refresh, tracksPerDay: 0 } };
    expect(await trackRefreshAllowance(env, off, NOON)).toBe(0);
    const noRefresh = { ...S, refresh: { ...S.refresh, perDay: 0 } };
    expect(await trackRefreshAllowance(env, noRefresh, NOON)).toBe(0);
  });
});

describe("track refresh: the mix", () => {
  const set = (n: string, fetched: number, waiting = false): RefreshSet => ({
    url: "set-" + n,
    slug: "dj",
    waiting,
    fetched,
  });
  const track = (n: string, seenSec: number): TrackRefreshCandidate => ({
    trackId: n,
    url: "track-" + n,
    slug: "dj",
    seenAt: MS(seenSec),
  });
  const order = (xs: TickItem[]) => xs.map((i) => ("url" in i ? i.url : ""));

  it("sets mkvid waits on first, then sets and tracks in turn, the staler first", () => {
    const sets = [set("held", 50, true), set("a", 100), set("b", 300)];
    const tracks = [track("x", 200), track("y", 400)];
    expect(order(mixRefresh(sets, tracks, 5, 5))).toEqual([
      "set-held",
      "set-a",
      "track-x",
      "set-b",
      "track-y",
    ]);
    // A staler track goes first once the held sets are done.
    expect(order(mixRefresh([set("a", 500)], tracks, 3, 3))).toEqual([
      "track-x",
      "set-a",
      "track-y",
    ]);
  });

  it("held sets can take every slot; trackSlots caps the tracks; one kind fills the rest when the other runs out", () => {
    const tracks = [track("x", 1), track("y", 2), track("z", 3)];
    expect(order(mixRefresh([set("h1", 9, true), set("h2", 9, true)], tracks, 2, 2))).toEqual([
      "set-h1",
      "set-h2",
    ]);
    expect(order(mixRefresh([set("a", 9)], tracks, 4, 1))).toEqual(["track-x", "set-a"]);
    expect(order(mixRefresh([], tracks, 2, 2))).toEqual(["track-x", "track-y"]);
    expect(order(mixRefresh([set("a", 9), set("b", 10)], [], 2, 2))).toEqual(["set-a", "set-b"]);
    const item = mixRefresh([], [track("x", 1)], 1, 1)[0];
    expect(item).toEqual({
      cls: "recheck",
      kind: "track_refresh",
      slug: "dj",
      url: "track-x",
      trackId: "x",
    });
  });

  it("pickRefreshItems: tracks fill the free slots, never one in flight, none with tracksPerDay 0; the queries rest only when both are empty", async () => {
    const env = makeEnv();
    await candidate(env, "1", { seenDaysAgo: 30 });
    await candidate(env, "2", { seenDaysAgo: 20 });
    const slugs = new Set(["dj"]);
    const got = await pickRefreshItems(env, S, 3, [], slugs, NOON);
    expect(got.map((i) => i.kind)).toEqual(["track_refresh", "track_refresh"]);
    await env.CACHE.put(INFLIGHT_KEY, JSON.stringify([trackUrl("1")]));
    expect(order(await pickRefreshItems(env, S, 3, [], slugs, NOON))).toEqual([trackUrl("2")]);
    const off = { ...S, refresh: { ...S.refresh, tracksPerDay: 0 } };
    expect(await pickRefreshItems(env, off, 3, [], slugs, NOON)).toEqual([]);
    expect(await env.CACHE.get(REFRESH_EMPTY_KEY)).not.toBeNull();
  });
});

describe("track refresh: before migration 0027", () => {
  it("a failing track query costs the sets nothing and does not rest the refresh", async () => {
    const env = makeEnv();
    await candidate(env, "1");
    await env.DB.prepare("ALTER TABLE presave_candidates DROP COLUMN links_checked_at").run();
    const log = makeLogger({ task: "test" });
    const warn = vi.spyOn(log, "warn");
    expect(await pickRefreshItems(env, S, 3, [], new Set(["dj"]), NOON, log)).toEqual([]);
    expect(warn).toHaveBeenCalledWith("scheduler.track_refresh_pick_failed", expect.anything());
    expect(await env.CACHE.get(REFRESH_EMPTY_KEY)).toBeNull();
  });
});

describe("track refresh: in the tick", () => {
  it("nothing due: a free slot looks a candidate's links up at priority backfill, stamps it and counts it", async () => {
    const env = makeEnv();
    await setup(env);
    await candidate(env, "1");
    const r = await runSchedulerTick(env, { random: always(0.99), now: NOON });
    expect(r.skipped).toBeUndefined();
    expect(r.items.map((i) => [i.item.kind, "url" in i.item && i.item.url, i.outcome])).toEqual([
      ["track_refresh", trackUrl("1"), "ok"],
    ]);
    expect(mocked(fetchAllMediaLinks)).toHaveBeenCalledWith(
      env,
      "1",
      expect.objectContaining({ priority: "backfill" }),
    );
    expect(await checkedAt(env, "1")).toBe(MS(NOON));
    const s = await getPoolSettings(env);
    expect(await refreshAllowance(env, { ...s, refresh: { ...s.refresh, perDay: 2 } }, NOON)).toBe(
      1,
    );
    const capped = { ...s, refresh: { ...s.refresh, tracksPerDay: 1 } };
    expect(await trackRefreshAllowance(env, capped, NOON)).toBe(0);
    // Looked at: not picked again before the cooldown.
    expect(await ids(env, NOON + D)).toEqual([]);
  });

  it("a YouTube or Spotify link now: the track is no candidate any more", async () => {
    const env = makeEnv();
    await setup(env);
    await candidate(env, "yt");
    lookupGives([link("youtube", "13")]);
    await runSchedulerTick(env, { random: always(0), now: NOON });
    await candidate(env, "sp");
    lookupGives([link("spotify", "36"), link("apple", "2")]);
    await runSchedulerTick(env, { random: always(0), now: NOON + 300 });
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM presave_candidates").first<{
      n: number;
    }>();
    expect(left?.n).toBe(0);
  });

  it("a failed lookup is stamped (waits the whole cooldown) and counted", async () => {
    const env = makeEnv();
    await setup(env);
    await candidate(env, "1");
    mocked(fetchAllMediaLinks).mockResolvedValue({ ok: false, error: "not JSON", ms: 3 });
    const r = await runSchedulerTick(env, { random: always(0), now: NOON });
    expect(r.items.map((i) => [i.item.kind, i.outcome])).toEqual([["track_refresh", "failed"]]);
    expect(await checkedAt(env, "1")).toBe(MS(NOON));
    expect(await ids(env, NOON + 6 * D)).toEqual([]);
    expect(await ids(env, NOON + 7 * D + 60)).toEqual(["1"]);
  });

  it("budget_exhausted: the claim is undone, nothing counted, the backfill share held", async () => {
    const env = makeEnv();
    await setup(env);
    await candidate(env, "1", { checkedAt: MS(NOON - 9 * D) });
    await candidate(env, "2");
    mocked(fetchAllMediaLinks).mockResolvedValue({
      ok: false,
      error: "pool paused: budget_exhausted",
      poolError: new PoolPausedError("budget_exhausted", 1800),
      poolCode: "budget_exhausted",
      retryAfterSeconds: 1800,
      ms: 3,
    });
    const r = await runSchedulerTick(env, { random: always(0.99), now: NOON });
    // The second item is held with the backfill share, not asked.
    expect(r.items.map((i) => [i.item.kind, i.outcome])).toEqual([["track_refresh", "stopped"]]);
    expect(r.stoppedBy).toBeUndefined();
    expect(mocked(fetchAllMediaLinks)).toHaveBeenCalledTimes(1);
    expect(await checkedAt(env, "1")).toBe(MS(NOON - 9 * D));
    expect(await checkedAt(env, "2")).toBeNull();
    expect(Number(await env.CACHE.get(budgetHoldKey("backfill")))).toBe(NOON + 1800);
    expect(await trackRefreshAllowance(env, await getPoolSettings(env), NOON)).toBe(
      S.refresh.perTick,
    );
  });

  it("needs no YouTube token: track lookups run while YouTube is not connected", async () => {
    const env = makeEnv();
    await setup(env, false);
    await candidate(env, "1");
    const r = await runSchedulerTick(env, { random: always(0), now: NOON });
    expect(r.items.map((i) => [i.item.kind, i.outcome])).toEqual([["track_refresh", "ok"]]);
  });

  it("a candidate an overlapping tick already claimed is skipped, not looked up", async () => {
    const env = makeEnv();
    await setup(env);
    await candidate(env, "1");
    const picked = await pickRefreshItems(env, S, 0, [], new Set(["dj"]), NOON);
    expect(picked).toHaveLength(1);
    // Another tick claims it between this one's pick and its lookup.
    await env.DB.prepare("UPDATE presave_candidates SET links_checked_at = ?")
      .bind(MS(NOON - 60))
      .run();
    const out = await runTrackRefresh(
      env,
      { trackId: "1", url: trackUrl("1") },
      { cooldownHours: S.refresh.trackCooldownHours, nowMs: MS(NOON), log: makeLogger() },
    );
    expect(out).toEqual({ outcome: "skipped", counted: false });
    expect(await checkedAt(env, "1")).toBe(MS(NOON - 60));
    // And the next tick does not pick it at all.
    const r = await runSchedulerTick(env, { random: always(0), now: NOON });
    expect(r.skipped).toBe("zero_draw");
    expect(mocked(fetchAllMediaLinks)).not.toHaveBeenCalled();
  });
});

describe("track refresh: settings and the report", () => {
  it("a stored refresh document from before the track settings still loads, with the track defaults", async () => {
    const env = makeEnv();
    await env.SUBS.put(
      POOL_SETTINGS_KEY,
      JSON.stringify({
        tick: { minItems: 1, maxItems: 4 },
        refresh: { perDay: 600, perTick: 3, cooldownHours: 48, mkvidCooldownHours: 12 },
      }),
    );
    const s = await getPoolSettings(env);
    expect(s.tick.maxItems).toBe(4);
    expect(s.refresh).toEqual({
      perDay: 600,
      perTick: 3,
      cooldownHours: 48,
      mkvidCooldownHours: 12,
      tracksPerDay: 150,
      trackCooldownHours: 168,
    });
    const u = await updatePoolSettings(env, { refresh: { tracksPerDay: 20 } });
    expect(u.ok && u.settings.refresh.perDay).toBe(600);
    expect(u.ok && u.settings.refresh.tracksPerDay).toBe(20);
    expect((await updatePoolSettings(env, { refresh: { trackCooldownHours: 0 } })).ok).toBe(false);
  });

  it("labels a track item by its track page's name", () => {
    expect(labelFromTrackUrl(trackUrl("7"))).toBe("artist track 7");
    expect(labelFromTrackUrl("not a url")).toBe("not a url");
    const v = tickViewFromDb({
      id: 1,
      at: NOON,
      ms: 10,
      skipped: null,
      drawn: 0,
      ran: 1,
      stopped_by: null,
      due: null,
      items: JSON.stringify([
        { kind: "track_refresh", cls: "recheck", slug: "dj", url: trackUrl("7"), outcome: "ok" },
      ]),
      error: null,
    });
    expect(v.items[0]).toMatchObject({ kind: "track_refresh", label: "artist track 7" });
  });
});
