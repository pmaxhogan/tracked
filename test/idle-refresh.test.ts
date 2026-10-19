import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeD1 } from "./helpers/fake-d1";
import { fakeKV } from "./helpers/fake-kv";
import type { Env } from "../src/types";
import {
  DEFAULT_POOL_SETTINGS,
  getPoolSettings,
  updatePoolSettings,
} from "../src/lib/pool-settings";
import {
  budgetHoldKey,
  ENSURE_STAMP_KEY,
  INFLIGHT_KEY,
  pickRefreshItems,
  refreshAllowance,
  refreshCandidates,
  REFRESH_EMPTY_KEY,
  runSchedulerTick,
  TICK_BACKOFF_KEY,
  type TickItem,
} from "../src/lib/fetch-scheduler";
import { PoolPausedError } from "../src/lib/pool";
import { INDEX_FORMAT_SINCE } from "../src/lib/search/index";
import { saveSubState, loadSubState } from "../src/lib/sync-store";
import { _resetTallyForTests } from "../src/lib/ban-state";
import { UpstreamHttpError } from "../src/lib/upstream-errors";

// The idle refresh (lib/fetch-scheduler.ts pickRefreshItems). Network edges
// stubbed; the scheduler, syncOne, D1 and verification run for real.
vi.mock("../src/lib/dj-index", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/dj-index")>("../src/lib/dj-index");
  return {
    ...actual,
    fetch1001Html: vi.fn(),
    crawlDjIndex: vi.fn(),
    djScrollStep: vi.fn(),
    parseSetYouTubeId: vi.fn(),
  };
});
vi.mock("../src/lib/youtube-playlists", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/youtube-playlists")>(
    "../src/lib/youtube-playlists",
  );
  return {
    ...actual,
    findPlaylistByTitle: vi.fn(),
    createPlaylist: vi.fn(),
    listPlaylistVideoIds: vi.fn(),
    addVideoToPlaylist: vi.fn(),
    removeVideoFromPlaylist: vi.fn(),
  };
});
vi.mock("../src/lib/video-meta", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/video-meta")>("../src/lib/video-meta");
  return { ...actual, getVideoMeta: vi.fn(async () => new Map()) };
});
import { fetch1001Html, parseSetYouTubeId } from "../src/lib/dj-index";
import { findPlaylistByTitle, listPlaylistVideoIds } from "../src/lib/youtube-playlists";

const H = 3600;
const D = 24 * H;
const NOON = Math.floor(Date.now() / 1000 / D) * D + 12 * H;
const BEFORE = INDEX_FORMAT_SINCE - 5 * D;
const day = (daysAgo: number) => new Date((NOON - daysAgo * D) * 1000).toISOString().slice(0, 10);
const setUrl = (id: string, daysAgo: number) =>
  `https://www.1001tracklists.com/tracklist/${id}/dj-set-${day(daysAgo)}.html`;
const mocked = (f: unknown) => f as ReturnType<typeof vi.fn>;
const always = (x: number) => () => x;
const MATRODA = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "tracklist-matroda.html"),
  "utf8",
);
const S = DEFAULT_POOL_SETTINGS;

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

/** Subscribes the DJs, with nothing due for them, and the index catch-up off (only the refresh fills free slots). */
async function subscribe(env: Env, ...slugs: string[]) {
  let i = 0;
  for (const slug of slugs) {
    await env.DB.prepare(
      "INSERT INTO subscriptions (slug, source_url, added_at, position) VALUES (?, ?, ?, ?)",
    )
      .bind(slug, `https://www.1001tracklists.com/dj/${slug}/`, 0, i++)
      .run();
    await env.DB.prepare(
      "INSERT OR REPLACE INTO dj_schedule (slug, next_discovery_at, next_backfill_at, updated_at) VALUES (?, ?, ?, ?)",
    )
      .bind(slug, NOON + 300 * D, NOON + 300 * D, NOON)
      .run();
  }
  await env.SUBS.put("subs:migrated", "{}");
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

/** A processed set with a video, last fetched at `fetchedAt`, next due `dueAt` (default: in 100 days). */
async function syncedSet(
  env: Env,
  id: string,
  o: { daysAgo?: number; slug?: string; fetchedAt?: number | null; dueAt?: number | null } = {},
): Promise<string> {
  const slug = o.slug ?? "dj";
  const daysAgo = o.daysAgo ?? 200;
  const u = setUrl(id, daysAgo);
  const st = (await loadSubState(env, slug)) ?? {
    discoveredTracklistUrls: [],
    processedTracklistUrls: [],
    tracklistVideos: {},
  };
  await saveSubState(env, slug, {
    ...st,
    playlistId: "PL",
    artistName: "A",
    discoveredTracklistUrls: [...(st.discoveredTracklistUrls ?? []), u],
    processedTracklistUrls: [...(st.processedTracklistUrls ?? []), u],
    tracklistVideos: {
      ...(st.tracklistVideos ?? {}),
      [u]: { videoId: "vid" + id, checkedAt: BEFORE },
    },
  });
  await env.DB.prepare(
    "INSERT INTO set_schedule (url, set_date, next_due_at, last_fetched_at, has_id_rows, no_good_video, updated_at) VALUES (?, ?, ?, ?, 0, 0, ?)",
  )
    .bind(
      u,
      day(daysAgo),
      o.dueAt === undefined ? NOON + 100 * D : o.dueAt,
      o.fetchedAt === undefined ? BEFORE : o.fetchedAt,
      BEFORE,
    )
    .run();
  return u;
}

async function mkvidRequest(env: Env, u: string, status = "pending") {
  await env.DB.prepare(
    "INSERT INTO mkvid_requests (id, slug, set_url, set_title, source, source_url, status, created_at, updated_at) VALUES (?, 'dj', ?, 'A set', 'soundcloud', 'https://soundcloud.com/x/y', ?, 1, 1)",
  )
    .bind("req-" + u, u, status)
    .run();
}

const cands = async (env: Env, now = NOON) =>
  (await refreshCandidates(env, S, now, 100)).map((c) => c.url);
const urls = (xs: TickItem[]) => xs.map((i) => ("url" in i ? i.url : ""));

beforeEach(() => {
  vi.resetAllMocks();
  _resetTallyForTests();
  mocked(fetch1001Html).mockResolvedValue({
    html: MATRODA,
    via: "pool",
    state: { cookie: "" },
    accountId: "acct-1",
    fetchedAt: new Date(NOON * 1000).toISOString(),
  });
  mocked(listPlaylistVideoIds).mockImplementation(async () => new Set<string>());
  mocked(findPlaylistByTitle).mockResolvedValue({ id: "PL", title: "x" });
  mocked(parseSetYouTubeId).mockReturnValue(null);
});

describe("idle refresh: which sets", () => {
  it("sets mkvid waits on first, then the stalest; never-due sets count, recently fetched ones wait", async () => {
    const env = makeEnv();
    await subscribe(env, "dj");
    const stale = await syncedSet(env, "stale", { fetchedAt: NOON - 20 * D });
    const staler = await syncedSet(env, "staler", { fetchedAt: NOON - 25 * D, dueAt: null });
    const recent = await syncedSet(env, "recent", { fetchedAt: NOON - 2 * D });
    await syncedSet(env, "fresh", { fetchedAt: NOON - H });
    // mkvid waits on it: fetched again after a day, not three.
    const held = await syncedSet(env, "held", { fetchedAt: NOON - 2 * D });
    await mkvidRequest(env, held);
    // A done request waits on nothing.
    const done = await syncedSet(env, "done", { fetchedAt: NOON - 2 * D });
    await mkvidRequest(env, done, "done");
    const heldFresh = await syncedSet(env, "heldfresh", { fetchedAt: NOON - H });
    await mkvidRequest(env, heldFresh);
    expect(await cands(env)).toEqual([held, staler, stale]);
    expect(await cands(env, NOON + 2 * D)).toEqual([held, heldFresh, staler, stale, done, recent]);
  });

  it("leaves out sets due as a recheck, marked for a resync, waiting on a verification, of unsubscribed DJs, the render feeder cools down, and waiting out an attempt", async () => {
    const env = makeEnv();
    await subscribe(env, "dj");
    const old = NOON - 20 * D;
    const keep = await syncedSet(env, "keep", { fetchedAt: old });
    await syncedSet(env, "due", { dueAt: NOON - 60, fetchedAt: old });
    const resync = await syncedSet(env, "resync", { fetchedAt: old });
    await env.DB.prepare("UPDATE tracklists SET checked_at = 0 WHERE url = ?").bind(resync).run();
    await syncedSet(env, "other", { slug: "gone", fetchedAt: old });
    const pending = await syncedSet(env, "pending", { fetchedAt: old });
    await env.DB.prepare(
      `INSERT INTO set_verification (url, state, fingerprint, row_count, first_account, first_fetched_at, verify_due_at, updated_at)
       VALUES (?, 'pending', 'f', 1, 'a', ?, ?, ?)`,
    )
      .bind(pending, NOON - D, NOON + D, NOON - D)
      .run();
    const cooling = await syncedSet(env, "cooling", { fetchedAt: old });
    await env.DB.prepare(
      "INSERT INTO render_feed (url, attempts, failures, last_attempt_at, next_feed_at, gave_up, updated_at) VALUES (?, 1, 1, ?, ?, 0, ?)",
    )
      .bind(cooling, NOON, NOON + D, NOON)
      .run();
    const tried = await syncedSet(env, "tried", { fetchedAt: old });
    await env.DB.prepare("UPDATE set_schedule SET retry_at = ? WHERE url = ?")
      .bind(NOON + H, tried)
      .run();
    expect(await cands(env)).toEqual([keep]);
  });

  it("allowance: perTick, what is left of perDay, and 0 when off", async () => {
    const env = makeEnv();
    expect(await refreshAllowance(env, S, NOON)).toBe(S.refresh.perTick);
    expect(await refreshAllowance(env, { ...S, refresh: { ...S.refresh, perDay: 0 } }, NOON)).toBe(
      0,
    );
    expect(await refreshAllowance(env, { ...S, refresh: { ...S.refresh, perTick: 0 } }, NOON)).toBe(
      0,
    );
  });

  it("only the tick's free slots, never a URL already picked or in flight", async () => {
    const env = makeEnv();
    await subscribe(env, "dj");
    const a = await syncedSet(env, "a", { fetchedAt: NOON - 30 * D });
    const b = await syncedSet(env, "b", { fetchedAt: NOON - 20 * D });
    const c = await syncedSet(env, "c", { fetchedAt: NOON - 10 * D });
    const slugs = new Set(["dj"]);
    const picked: TickItem[] = [{ cls: "recheck", kind: "recheck", slug: "dj", url: a }];
    // Drew 3, picked 1: two free slots (perTick 2), the picked URL left out.
    expect(urls(await pickRefreshItems(env, S, 3, picked, slugs, NOON))).toEqual([b, c]);
    // Drew 1 and picked 1: no free slot.
    expect(await pickRefreshItems(env, S, 1, picked, slugs, NOON)).toEqual([]);
    // A zero draw still gets one slot.
    expect(urls(await pickRefreshItems(env, S, 0, [], slugs, NOON))).toEqual([a]);
    await env.CACHE.put(INFLIGHT_KEY, JSON.stringify([a]));
    expect(urls(await pickRefreshItems(env, S, 0, [], slugs, NOON))).toEqual([b]);
    // An unsubscribed DJ's set is not picked.
    expect(await pickRefreshItems(env, S, 3, [], new Set(["x"]), NOON)).toEqual([]);
  });
});

describe("idle refresh: in the tick", () => {
  it("nothing due: free slots fetch the stalest sets again (not 'nothing_due'), counted toward the day", async () => {
    const env = makeEnv();
    await subscribe(env, "dj");
    const a = await syncedSet(env, "a", { fetchedAt: NOON - 30 * D });
    const b = await syncedSet(env, "b", { fetchedAt: NOON - 20 * D });
    await syncedSet(env, "c", { fetchedAt: NOON - 10 * D });
    const r = await runSchedulerTick(env, { random: always(0.99), now: NOON });
    expect(r.skipped).toBeUndefined();
    expect(r.items.map((i) => [i.item.kind, "url" in i.item && i.item.url, i.outcome])).toEqual([
      ["refresh", a, "ok"],
      ["refresh", b, "ok"],
    ]);
    const s = await getPoolSettings(env);
    expect(await refreshAllowance(env, { ...s, refresh: { ...s.refresh, perDay: 3 } }, NOON)).toBe(
      1,
    );
  });

  it("a zero draw runs one refresh item instead of nothing; with nothing left it stays 'zero_draw' and the query rests", async () => {
    const env = makeEnv();
    await subscribe(env, "dj");
    const a = await syncedSet(env, "a", { fetchedAt: NOON - 30 * D });
    const r = await runSchedulerTick(env, { random: always(0), now: NOON });
    expect(r.drawn).toBe(0);
    expect(r.skipped).toBeUndefined();
    expect(r.items.map((i) => [i.item.kind, "url" in i.item && i.item.url, i.outcome])).toEqual([
      ["refresh", a, "ok"],
    ]);
    const r2 = await runSchedulerTick(env, { random: always(0), now: NOON + 60 });
    expect(r2.skipped).toBe("zero_draw");
    expect(r2.items).toEqual([]);
    expect(Number(await env.CACHE.get(REFRESH_EMPTY_KEY))).toBeGreaterThan(NOON + 60);
  });

  it("off (perDay 0): a tick with nothing due does nothing, as before", async () => {
    const env = makeEnv();
    await subscribe(env, "dj");
    await syncedSet(env, "a", { fetchedAt: NOON - 30 * D });
    await updatePoolSettings(env, { refresh: { perDay: 0 } });
    const r = await runSchedulerTick(env, { random: always(0.99), now: NOON });
    expect(r.skipped).toBe("nothing_due");
    expect(r.items).toEqual([]);
  });

  it("a set that fails to fetch waits the whole cooldown, not the attempt backoff", async () => {
    const env = makeEnv();
    await subscribe(env, "dj");
    const u = await syncedSet(env, "dead", { fetchedAt: NOON - 30 * D });
    mocked(fetch1001Html).mockRejectedValue(new UpstreamHttpError(404, u));
    const r = await runSchedulerTick(env, { random: always(0), now: NOON });
    expect(r.items.map((i) => [i.item.kind, i.outcome])).toEqual([["refresh", "failed"]]);
    expect(await cands(env, NOON + 6 * H)).toEqual([]);
    expect(await cands(env, NOON + S.refresh.cooldownHours * H + 60)).toEqual([u]);
  });

  it("budget_exhausted holds backfill: no tick backoff, and no refresh until the hold ends", async () => {
    const env = makeEnv();
    await subscribe(env, "dj");
    await syncedSet(env, "a", { fetchedAt: NOON - 30 * D });
    await syncedSet(env, "b", { fetchedAt: NOON - 20 * D });
    mocked(fetch1001Html).mockRejectedValue(new PoolPausedError("budget_exhausted", 1800));
    const r = await runSchedulerTick(env, { random: always(0.99), now: NOON });
    expect(r.items.map((i) => [i.item.kind, i.outcome])).toEqual([["refresh", "stopped"]]);
    expect(r.stoppedBy).toBeUndefined();
    expect(await env.CACHE.get(TICK_BACKOFF_KEY)).toBeNull();
    expect(Number(await env.CACHE.get(budgetHoldKey("backfill")))).toBe(NOON + 1800);
    const s = await getPoolSettings(env);
    expect(await pickRefreshItems(env, s, 3, [], new Set(["dj"]), NOON + 300)).toEqual([]);
    expect(await pickRefreshItems(env, s, 3, [], new Set(["dj"]), NOON + 1900)).toHaveLength(2);
  });
});
