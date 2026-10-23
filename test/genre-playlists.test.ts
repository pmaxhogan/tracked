/**
 * Genre playlists (src/lib/genre-playlists.ts, routes/genres.ts): the overview
 * and its policy, a run (create, insert in order, caps, the gate, YouTube
 * errors, the owner's removals), the ordering pass's playlist list, the quota
 * rank of the new consumer and the pages' API.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import { fakeD1 } from "./helpers/fake-d1";
import { fakeKV } from "./helpers/fake-kv";
import { makeLogger } from "../src/lib/log";

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
    listPlaylistItems: vi.fn(),
    deletePlaylistItem: vi.fn(),
  };
});
vi.mock("../src/lib/google-oauth", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/google-oauth")>("../src/lib/google-oauth");
  return {
    ...actual,
    getAccessToken: vi.fn(async () => ({ accessToken: "tok", tokens: {} })),
    loadTokens: vi.fn(async () => ({ refresh_token: "r" })),
  };
});
vi.mock("../src/lib/quota-priority", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/quota-priority")>(
    "../src/lib/quota-priority",
  );
  return { ...actual, quotaGate: vi.fn(async () => ({ ok: true })) };
});

import {
  addVideoToPlaylist,
  createPlaylist,
  deletePlaylistItem,
  findPlaylistByTitle,
  listPlaylistItems,
  listPlaylistVideoIds,
  PlaylistNotFoundError,
  YouTubeApiError,
} from "../src/lib/youtube-playlists";
import { getAccessToken, loadTokens } from "../src/lib/google-oauth";
import { quotaGate } from "../src/lib/quota-priority";
import {
  genreOverview,
  genrePlaylistsCronStep,
  genreSets,
  LAST_RUN_KEY,
  MAX_ATTEMPTS,
  PRUNE_HOLD_SECONDS,
  runGenrePlaylists,
  setGenreChoice,
} from "../src/lib/genre-playlists";
import { managedPlaylists } from "../src/lib/playlist-reorder";
import {
  DEFAULT_APP_SETTINGS,
  getAppSettings,
  normaliseStoredQuota,
  updateAppSettings,
} from "../src/lib/app-settings";
import { app } from "../src/index";

const log = makeLogger({ task: "test" });
const mk = <T>(f: unknown) => f as ReturnType<typeof vi.fn> & T;
const url = (n: number) =>
  `https://www.1001tracklists.com/tracklist/s${n}/dj-set-2026-0${(n % 9) + 1}-1${n % 10}.html`;

function makeEnv(): Env {
  return {
    CACHE: fakeKV(),
    SUBS: fakeKV(),
    DB: fakeD1(),
    API_TOKEN: "t",
    YOUTUBE_API_KEY: "k",
  } as Env;
}

/** `n` sets of DJ `slug`, each with a video in the DJ playlist, tagged with `genres`. */
async function seed(env: Env, n: number, genres: Array<[string, string]>, from = 0, slug = "dj") {
  const db = env.DB;
  await db
    .prepare(
      "INSERT OR IGNORE INTO subscriptions (slug, source_url, added_at, position) VALUES (?, ?, 0, 0)",
    )
    .bind(slug, `https://www.1001tracklists.com/dj/${slug}/`)
    .run();
  await db
    .prepare("INSERT OR IGNORE INTO sub_sync (slug, artist_name, playlist_id) VALUES (?, ?, ?)")
    .bind(slug, slug.toUpperCase(), `PL${slug}`)
    .run();
  for (let i = from; i < from + n; i++) {
    const v = `vid${String(i).padStart(8, "0")}`;
    await db
      .prepare(
        "INSERT INTO tracklists (slug, url, position, discovered_at, processed, video_known, video_id) VALUES (?, ?, ?, 0, 1, 1, ?)",
      )
      .bind(slug, url(i), i, v)
      .run();
    await db
      .prepare(
        "INSERT INTO playlist_confirmed (playlist_id, video_id, state, source, at) VALUES (?, ?, 'in', 'sync', 0)",
      )
      .bind(`PL${slug}`, v)
      .run();
    for (const [k, name] of genres)
      await db
        .prepare(
          "INSERT INTO set_genres (set_url, genre_key, genre_name, position, at) VALUES (?, ?, ?, 0, 0)",
        )
        .bind(url(i), k, name)
        .run();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mk(findPlaylistByTitle).mockResolvedValue(null);
  mk(createPlaylist).mockImplementation(async (o: { title: string }) => ({
    id: "PL" + o.title.split(" ")[0]!.toLowerCase(),
    title: o.title,
  }));
  mk(listPlaylistVideoIds).mockResolvedValue(new Set<string>());
  mk(addVideoToPlaylist).mockResolvedValue(undefined);
  mk(listPlaylistItems).mockResolvedValue({ items: [], nextPageToken: null, pages: 1 });
  mk(deletePlaylistItem).mockResolvedValue(undefined);
  mk(quotaGate).mockResolvedValue({ ok: true });
  mk(getAccessToken).mockResolvedValue({ accessToken: "tok", tokens: {} });
  mk(loadTokens).mockResolvedValue({ refresh_token: "r" });
});

describe("genreOverview: the policy", () => {
  it("a genre with enough sets gets a playlist; fewer waits; the owner's choice wins", async () => {
    const env = makeEnv();
    await seed(env, 10, [["house", "House"]]);
    await seed(env, 3, [["techno", "Techno"]], 10);
    // A set whose video is not in a DJ playlist counts as a set, not as a video.
    await env.DB.prepare("DELETE FROM playlist_confirmed WHERE video_id = ?")
      .bind("vid00000012")
      .run();
    let rows = await genreOverview(env);
    expect(rows.map((r) => [r.key, r.sets, r.videos, r.enabled, r.status])).toEqual([
      ["house", 10, 10, true, "not_created"],
      ["techno", 3, 2, false, "below_min"],
    ]);
    expect(rows[1]!.statusText).toMatch(/at 10 sets/);
    await setGenreChoice(env, "techno", "Techno", true);
    await setGenreChoice(env, "house", "House", false);
    rows = await genreOverview(env);
    expect(rows.map((r) => [r.key, r.choice, r.enabled, r.status])).toEqual([
      ["house", false, false, "off"],
      ["techno", true, true, "not_created"],
    ]);
    await updateAppSettings(env, { genres: { auto: false } });
    await setGenreChoice(env, "house", "House", null);
    rows = await genreOverview(env, { key: "house" });
    expect(rows[0]).toMatchObject({ status: "below_min", enabled: false });
    expect(rows[0]!.statusText).toMatch(/automatic playlists are off/);
    expect((await genreOverview(env, { key: "techno", connected: false }))[0]!.status).toBe(
      "not_connected",
    );
  });

  it("answers no genres when the tables are missing", async () => {
    const env = makeEnv();
    await env.DB.prepare("DROP TABLE genre_playlist_items").run();
    expect(await genreOverview(env)).toEqual([]);
  });
});

describe("runGenrePlaylists", () => {
  it("creates the playlist, inserts every video once, positioned by set date, and is then synced", async () => {
    const env = makeEnv();
    await seed(env, 12, [["house", "House"]]);
    const r = await runGenrePlaylists(env, { log, trigger: "cron.tick" });
    expect(r).toMatchObject({ ok: true, inserted: 12, created: 1, genres: 1, pending: 0 });
    expect(createPlaylist).toHaveBeenCalledWith(
      expect.objectContaining({ title: "House sets (1001tklists)" }),
      "tok",
    );
    expect(quotaGate).toHaveBeenCalledWith(env, "genre_playlists", 12 * 50);
    expect(mk(addVideoToPlaylist).mock.calls.every((c) => c[0] === "PLhouse")).toBe(true);
    const [row] = await genreOverview(env);
    expect(row).toMatchObject({
      playlistId: "PLhouse",
      inPlaylist: 12,
      pending: 0,
      status: "synced",
    });
    expect(row!.musicUrl).toBe("https://music.youtube.com/playlist?list=PLhouse");
    // Nothing left: no gate, no YouTube call.
    mk(quotaGate).mockClear();
    expect(await runGenrePlaylists(env, { log })).toMatchObject({ ok: true, stoppedBy: "nothing" });
    expect(quotaGate).not.toHaveBeenCalled();
    // Ordering pass sees it.
    expect((await managedPlaylists(env)).map((p) => [p.playlistId, p.slug, p.title])).toEqual([
      ["PLdj", "dj", "DJ (1001tklists)"],
      ["PLhouse", "genre:house", "House sets (1001tklists)"],
    ]);
    const sets = await genreSets(env, "house");
    expect(sets).toHaveLength(12);
    expect(sets.every((s) => s.state === "in")).toBe(true);
  });

  it("stops at the per-run cap, least complete genre first; a manual run spends as the owner", async () => {
    const env = makeEnv();
    await seed(env, 12, [["house", "House"]]);
    await seed(env, 11, [["techno", "Techno"]], 20);
    let r = await runGenrePlaylists(env, { log, maxInserts: 5 });
    expect(r).toMatchObject({ ok: true, inserted: 5, stoppedBy: "run" });
    // House is bigger, so it went first; now Techno is the least complete.
    r = await runGenrePlaylists(env, { log, maxInserts: 3 });
    expect(r).toMatchObject({ inserted: 3 });
    const rows = await genreOverview(env);
    expect(rows.map((x) => [x.key, x.inPlaylist])).toEqual([
      ["house", 5],
      ["techno", 3],
    ]);
    expect(rows[0]!.status).toBe("pending");
    await runGenrePlaylists(env, { log, trigger: "manual.genre", only: "techno", maxInserts: 2 });
    expect(quotaGate).toHaveBeenLastCalledWith(env, "owner", 100);
    expect((await genreOverview(env, { key: "techno" }))[0]!.inPlaylist).toBe(5);
    expect(await runGenrePlaylists(env, { log, only: "nope" })).toEqual({
      ok: false,
      reason: "unknown_genre",
    });
    await setGenreChoice(env, "techno", "Techno", false);
    expect(await runGenrePlaylists(env, { log, only: "techno" })).toEqual({
      ok: false,
      reason: "off",
    });
  });

  it("a held gate inserts nothing and the status says held; no token says not connected", async () => {
    const env = makeEnv();
    await seed(env, 10, [["house", "House"]]);
    mk(quotaGate).mockResolvedValueOnce({ ok: false, reason: "held" });
    expect(await runGenrePlaylists(env, { log })).toEqual({
      ok: false,
      reason: "quota_held",
      held: "held",
    });
    expect(addVideoToPlaylist).not.toHaveBeenCalled();
    const [row] = await genreOverview(env);
    expect(row).toMatchObject({ status: "held" });
    expect(row!.statusText).toMatch(/held for higher priority/);
    mk(getAccessToken).mockResolvedValueOnce(null);
    expect(await runGenrePlaylists(env, { log })).toEqual({
      ok: false,
      reason: "youtube_not_connected",
    });
    expect((await env.CACHE.get<{ stoppedBy: string }>(LAST_RUN_KEY, "json"))!.stoppedBy).toBe(
      "not_connected",
    );
  });

  it("a daily quota reply stops the run; a gone video is unavailable; a 5xx is retried, then left", async () => {
    const env = makeEnv();
    await seed(env, 10, [["house", "House"]]);
    mk(addVideoToPlaylist)
      .mockRejectedValueOnce(new YouTubeApiError("playlistItems.insert", 404, "videoNotFound", ""))
      .mockRejectedValueOnce(new YouTubeApiError("playlistItems.insert", 500, null, ""))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new YouTubeApiError("playlistItems.insert", 403, "quotaExceeded", ""));
    const r = await runGenrePlaylists(env, { log });
    expect(r).toMatchObject({ ok: true, inserted: 1, failed: 3, stoppedBy: "quota" });
    let [row] = await genreOverview(env);
    expect(row).toMatchObject({ inPlaylist: 1, unavailable: 1, failed: 1, status: "held" });
    // The 5xx video is tried again until MAX_ATTEMPTS, then left alone.
    mk(addVideoToPlaylist).mockRejectedValue(
      new YouTubeApiError("playlistItems.insert", 500, null, ""),
    );
    for (let i = 0; i < MAX_ATTEMPTS; i++) await runGenrePlaylists(env, { log, maxInserts: 1 });
    const failed = (await genreSets(env, "house")).filter((s) => s.state === "failed");
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(failed[0]!.error).toMatch(/500/);
    [row] = await genreOverview(env);
    expect(row!.pending).toBeLessThan(8);
  });

  it("one run at a time: a second one while the lock is held does nothing", async () => {
    const env = makeEnv();
    await seed(env, 10, [["house", "House"]]);
    await env.CACHE.put("genres:lock", "other");
    expect(await runGenrePlaylists(env, { log })).toEqual({ ok: false, reason: "busy" });
    expect(createPlaylist).not.toHaveBeenCalled();
    await env.CACHE.delete("genres:lock");
    expect(await runGenrePlaylists(env, { log })).toMatchObject({ ok: true, inserted: 10 });
    expect(await env.CACHE.get("genres:lock")).toBeNull();
  });

  it("a rate limit ends the run only", async () => {
    const env = makeEnv();
    await seed(env, 10, [["house", "House"]]);
    mk(addVideoToPlaylist).mockRejectedValueOnce(
      new YouTubeApiError("playlistItems.insert", 403, "rateLimitExceeded", ""),
    );
    expect(await runGenrePlaylists(env, { log })).toMatchObject({
      stoppedBy: "rate_limit",
      inserted: 0,
    });
  });

  it("finds a playlist with its title, takes the videos already in it, and records the owner's removals", async () => {
    const env = makeEnv();
    await seed(env, 10, [["house", "House"]]);
    mk(findPlaylistByTitle).mockResolvedValue({ id: "PLfound", title: "House sets (1001tklists)" });
    mk(listPlaylistVideoIds).mockResolvedValue(new Set(["vid00000000", "vid00000001"]));
    let r = await runGenrePlaylists(env, { log });
    expect(r).toMatchObject({ inserted: 8, created: 0 });
    // A day later the owner removed one: it is never put back.
    await env.DB.prepare("UPDATE genre_playlist_items SET at = 0").run();
    await env.CACHE.delete("yt:plvids:PLfound");
    mk(listPlaylistVideoIds).mockResolvedValue(
      new Set(Array.from({ length: 9 }, (_, i) => `vid${String(i + 1).padStart(8, "0")}`)),
    );
    // One more set so the run has something to do.
    await seed(env, 1, [["house", "House"]], 30);
    r = await runGenrePlaylists(env, { log });
    expect(r).toMatchObject({ inserted: 1 });
    const sets = await genreSets(env, "house");
    expect(sets.find((s) => s.videoId === "vid00000000")!.state).toBe("removed");
    expect(mk(addVideoToPlaylist).mock.calls.some((c) => c[1] === "vid00000000")).toBe(false);
  });

  it("a playlist deleted on YouTube is forgotten and made again next run", async () => {
    const env = makeEnv();
    await seed(env, 10, [["house", "House"]]);
    await runGenrePlaylists(env, { log, maxInserts: 2 });
    await env.CACHE.delete("yt:plvids:PLhouse");
    mk(listPlaylistVideoIds).mockRejectedValueOnce(new PlaylistNotFoundError("list", "PLhouse"));
    expect(await runGenrePlaylists(env, { log })).toMatchObject({ inserted: 0 });
    expect((await genreOverview(env))[0]).toMatchObject({ playlistId: null, inPlaylist: 0 });
    mk(createPlaylist).mockResolvedValueOnce({ id: "PLhouse2", title: "x" });
    expect(await runGenrePlaylists(env, { log })).toMatchObject({ inserted: 10 });
  });

  it("the cron step skips while the pool is out and never throws", async () => {
    const env = makeEnv();
    await env.CACHE.put("yt:quota:out", JSON.stringify({ since: 0, until: 4_000_000_000 }));
    expect(await genrePlaylistsCronStep(env, log, "cron.tick")).toEqual({
      ok: false,
      reason: "youtube_quota_out",
    });
    const broken = {
      ...makeEnv(),
      DB: {
        prepare: () => {
          throw new Error("d1");
        },
      },
    } as unknown as Env;
    expect(await genrePlaylistsCronStep(broken, log, "cron.tick")).toMatchObject({
      ok: true,
      stoppedBy: "nothing",
    });
  });
});

const vid = (i: number) => `vid${String(i).padStart(8, "0")}`;
/** A complete listing holding `ids`, item id `it-<videoId>`. */
const listing = (ids: string[]) => ({
  items: ids.map((v) => ({ id: `it-${v}`, contentDetails: { videoId: v } })),
  nextPageToken: null,
  pages: 1,
});
const stateOf = async (env: Env, key: string, videoId: string) =>
  (
    await env.DB.prepare(
      "SELECT state, error FROM genre_playlist_items WHERE genre_key = ? AND video_id = ?",
    )
      .bind(key, videoId)
      .first<{ state: string; error: string | null }>()
  )?.state ?? null;
const leaveDj = (env: Env, videoId: string) =>
  env.DB.prepare("UPDATE playlist_confirmed SET state = 'out' WHERE video_id = ?")
    .bind(videoId)
    .run();

describe("genre playlists follow the DJ playlists", () => {
  it("a video that leaves its DJ playlist is taken out, and put back when it returns", async () => {
    const env = makeEnv();
    await seed(env, 12, [["house", "House"]]);
    await runGenrePlaylists(env, { log });
    await leaveDj(env, vid(3));
    let [row] = await genreOverview(env);
    expect(row).toMatchObject({ leaving: 1, pending: 0, status: "pending" });
    expect(row!.statusText).toBe("1 to take out, a few every scheduler tick");
    expect((await genreSets(env, "house")).find((x) => x.videoId === vid(3))!.state).toBe(
      "leaving",
    );
    mk(listPlaylistItems).mockResolvedValue(listing(Array.from({ length: 12 }, (_, i) => vid(i))));
    mk(quotaGate).mockClear();
    mk(addVideoToPlaylist).mockClear();
    const r = await runGenrePlaylists(env, { log });
    expect(r).toMatchObject({ ok: true, pruned: 1, inserted: 0 });
    expect(quotaGate).toHaveBeenCalledWith(env, "genre_playlists", 51);
    expect(deletePlaylistItem).toHaveBeenCalledTimes(1);
    expect(deletePlaylistItem).toHaveBeenCalledWith(`it-${vid(3)}`, "tok");
    expect(addVideoToPlaylist).not.toHaveBeenCalled();
    expect(await stateOf(env, "house", vid(3))).toBe("pruned");
    [row] = await genreOverview(env);
    expect(row).toMatchObject({ leaving: 0, pruned: 1, inPlaylist: 11, status: "synced" });
    expect((await genreSets(env, "house")).find((x) => x.videoId === vid(3))!.state).toBe(
      "not_in_dj_playlist",
    );
    // The KV snapshot no longer has it.
    expect(
      (await env.CACHE.get<{ videoIds: string[] }>("yt:plvids:PLhouse", "json"))!.videoIds,
    ).not.toContain(vid(3));
    // Back in its DJ playlist: it qualifies again and goes back in.
    await env.DB.prepare("UPDATE playlist_confirmed SET state = 'in' WHERE video_id = ?")
      .bind(vid(3))
      .run();
    expect((await genreOverview(env))[0]).toMatchObject({ pending: 1 });
    expect(await runGenrePlaylists(env, { log })).toMatchObject({ inserted: 1, pruned: 0 });
    expect(await stateOf(env, "house", vid(3))).toBe("in");
  });

  it("a set whose video is replaced: the old one comes out, then the new one goes in, in one run", async () => {
    const env = makeEnv();
    await seed(env, 10, [["house", "House"]]);
    await runGenrePlaylists(env, { log });
    // The sync swapped the set's video, and the new one is in the DJ playlist.
    await env.DB.prepare("UPDATE tracklists SET video_id = 'newvideo0001' WHERE url = ?")
      .bind(url(5))
      .run();
    await leaveDj(env, vid(5));
    await env.DB.prepare(
      "INSERT INTO playlist_confirmed (playlist_id, video_id, state, source, at) VALUES ('PLdj', 'newvideo0001', 'in', 'sync', 0)",
    ).run();
    mk(listPlaylistItems).mockResolvedValue(listing([vid(5), vid(5), vid(6)]));
    const order: string[] = [];
    mk(deletePlaylistItem).mockImplementation(async (id: string) => void order.push(`del ${id}`));
    mk(addVideoToPlaylist).mockImplementation(async (_p: string, v: string) => {
      order.push(`add ${v}`);
    });
    mk(quotaGate).mockClear();
    const r = await runGenrePlaylists(env, { log });
    expect(r).toMatchObject({ pruned: 1, inserted: 1 });
    expect(quotaGate).toHaveBeenCalledWith(env, "genre_playlists", 51 + 50);
    // Both copies of the old one go, before the new one is inserted.
    expect(order).toEqual([`del it-${vid(5)}`, `del it-${vid(5)}`, "add newvideo0001"]);
    expect(await stateOf(env, "house", vid(5))).toBe("pruned");
    expect(await stateOf(env, "house", "newvideo0001")).toBe("in");
  });

  it("one already gone from a complete listing is marked without a call; an incomplete listing marks nothing it did not delete", async () => {
    const env = makeEnv();
    await seed(env, 10, [["house", "House"]]);
    await runGenrePlaylists(env, { log });
    await leaveDj(env, vid(1));
    await leaveDj(env, vid(2));
    mk(listPlaylistItems).mockResolvedValueOnce({
      ...listing([vid(2)]),
      nextPageToken: "more",
    });
    expect(await runGenrePlaylists(env, { log })).toMatchObject({ pruned: 1 });
    expect(await stateOf(env, "house", vid(1))).toBe("in");
    expect(await stateOf(env, "house", vid(2))).toBe("pruned");
    mk(deletePlaylistItem).mockClear();
    mk(listPlaylistItems).mockResolvedValueOnce(listing([vid(0)]));
    expect(await runGenrePlaylists(env, { log })).toMatchObject({ pruned: 1 });
    expect(deletePlaylistItem).not.toHaveBeenCalled();
    expect(await stateOf(env, "house", vid(1))).toBe("pruned");
  });

  it("a video the owner took out of the genre playlist stays removed, even once it stops qualifying", async () => {
    const env = makeEnv();
    await seed(env, 10, [["house", "House"]]);
    await runGenrePlaylists(env, { log });
    await env.DB.prepare("UPDATE genre_playlist_items SET at = 0").run();
    await env.CACHE.delete("yt:plvids:PLhouse");
    mk(listPlaylistVideoIds).mockResolvedValue(
      new Set(Array.from({ length: 9 }, (_, i) => vid(i + 1))),
    );
    await leaveDj(env, vid(0));
    expect(await runGenrePlaylists(env, { log })).toMatchObject({ pruned: 0 });
    expect(await stateOf(env, "house", vid(0))).toBe("removed");
    expect(deletePlaylistItem).not.toHaveBeenCalled();
    // Back in the DJ playlist: still never put back.
    await env.DB.prepare("UPDATE playlist_confirmed SET state = 'in' WHERE video_id = ?")
      .bind(vid(0))
      .run();
    expect((await genreOverview(env))[0]).toMatchObject({ pending: 0, removed: 1 });
  });

  it("a mass take-out is held for a day, then goes ahead; a switched-off genre is left alone", async () => {
    const env = makeEnv();
    await seed(env, 10, [["house", "House"]]);
    await runGenrePlaylists(env, { log });
    for (let i = 0; i < 6; i++) await leaveDj(env, vid(i));
    mk(listPlaylistItems).mockResolvedValue(listing(Array.from({ length: 10 }, (_, i) => vid(i))));
    expect(await runGenrePlaylists(env, { log })).toMatchObject({ pruned: 0 });
    expect(deletePlaylistItem).not.toHaveBeenCalled();
    const since = Number(await env.CACHE.get("genres:prunehold:house"));
    expect(since).toBeGreaterThan(0);
    // Still within the day.
    expect(await runGenrePlaylists(env, { log })).toMatchObject({ pruned: 0 });
    await env.CACHE.put("genres:prunehold:house", String(since - PRUNE_HOLD_SECONDS));
    // Off: nothing is touched.
    await setGenreChoice(env, "house", "House", false);
    expect(await runGenrePlaylists(env, { log })).toMatchObject({ stoppedBy: "nothing" });
    // Back to automatic: below genres.minSets now (4 videos), so nothing goes in, but what left still comes out.
    await setGenreChoice(env, "house", "House", null);
    expect((await genreOverview(env))[0]).toMatchObject({ enabled: false, leaving: 6 });
    expect(await runGenrePlaylists(env, { log })).toMatchObject({ pruned: 6 });
    expect(deletePlaylistItem).toHaveBeenCalledTimes(6);
    // Under the guard again: the hold is forgotten.
    await leaveDj(env, vid(6));
    expect(await runGenrePlaylists(env, { log })).toMatchObject({ pruned: 1 });
    expect(await env.CACHE.get("genres:prunehold:house")).toBeNull();
  });

  it("take-outs share the per-run cap; a quota reply stops the run and keeps what was done", async () => {
    const env = makeEnv();
    await seed(env, 10, [["house", "House"]]);
    await runGenrePlaylists(env, { log });
    await leaveDj(env, vid(1));
    await leaveDj(env, vid(2));
    mk(listPlaylistItems).mockResolvedValue(listing(Array.from({ length: 10 }, (_, i) => vid(i))));
    mk(quotaGate).mockClear();
    expect(await runGenrePlaylists(env, { log, maxInserts: 1 })).toMatchObject({
      pruned: 1,
      stoppedBy: null,
    });
    expect(quotaGate).toHaveBeenCalledWith(env, "genre_playlists", 51);
    expect(await stateOf(env, "house", vid(1))).toBe("pruned");
    expect(await stateOf(env, "house", vid(2))).toBe("in");
    await leaveDj(env, vid(3));
    mk(deletePlaylistItem)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new YouTubeApiError("playlistItems.delete", 403, "quotaExceeded", ""));
    expect(await runGenrePlaylists(env, { log })).toMatchObject({ pruned: 1, stoppedBy: "quota" });
    expect(await stateOf(env, "house", vid(2))).toBe("pruned");
    expect(await stateOf(env, "house", vid(3))).toBe("in");
    // A delete refused for another reason is tried again later; a failed listing does nothing.
    await env.CACHE.delete("yt:quota:out");
    mk(deletePlaylistItem).mockRejectedValueOnce(
      new YouTubeApiError("playlistItems.delete", 500, null, ""),
    );
    expect(await runGenrePlaylists(env, { log })).toMatchObject({ pruned: 0 });
    mk(listPlaylistItems).mockRejectedValueOnce(
      new YouTubeApiError("playlistItems.list", 500, null, ""),
    );
    expect(await runGenrePlaylists(env, { log })).toMatchObject({ pruned: 0 });
    mk(listPlaylistItems).mockRejectedValueOnce(
      new YouTubeApiError("playlistItems.list", 403, "quotaExceeded", ""),
    );
    expect(await runGenrePlaylists(env, { log })).toMatchObject({ stoppedBy: "quota" });
    expect(await stateOf(env, "house", vid(3))).toBe("in");
    expect(await runGenrePlaylists(env, { log })).toMatchObject({ pruned: 1 });
    expect(await stateOf(env, "house", vid(3))).toBe("pruned");
  });
});

describe("quota rank", () => {
  it("sits after mkvid recreate and before combined, also in an order stored before it existed", async () => {
    const o = DEFAULT_APP_SETTINGS.quota.order;
    expect(o.indexOf("genre_playlists")).toBe(o.indexOf("mkvid_recreate") + 1);
    expect(o.indexOf("combined")).toBe(o.indexOf("genre_playlists") + 1);
    // The order the owner saved before genre playlists existed: it lands between the same two.
    const before = { quota: { order: o.filter((k) => k !== "genre_playlists") } };
    expect((normaliseStoredQuota(before) as typeof before).quota.order).toEqual(o);
    // A reordered one: right after mkvid recreate, wherever the owner put that.
    const stored = { quota: { order: o.filter((k) => k !== "genre_playlists").reverse() } };
    const order = (normaliseStoredQuota(stored) as typeof stored).quota.order;
    expect(order.indexOf("genre_playlists")).toBe(order.indexOf("mkvid_recreate") + 1);
    expect(order.length).toBe(o.length);
    const env = makeEnv();
    expect((await getAppSettings(env)).quota.consumers.genre_playlists).toEqual({
      min: null,
      max: 5000,
      enabled: true,
    });
  });
});

describe("routes", () => {
  const req = (env: Env, path: string, init?: RequestInit) =>
    app.request(`https://tracked.example${path}`, init, {
      ...env,
      DEV_BYPASS_CF_ACCESS: "1",
    } as Env);
  const post = (env: Env, path: string, body: unknown) =>
    req(env, path, {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("lists genres, shows one, switches it, backfills and refreshes it", async () => {
    const env = makeEnv();
    await seed(env, 10, [["house", "House"]]);
    const page = await req(env, "/ui/genres");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("gn-table");
    expect((await req(env, "/ui/genres/house")).status).toBe(200);
    const list = (await (await req(env, "/ui/api/genres")).json()) as {
      rows: Array<{ key: string }>;
      connected: boolean;
    };
    expect(list.connected).toBe(true);
    expect(list.rows.map((r) => r.key)).toEqual(["house"]);
    const one = (await (await req(env, "/ui/api/genres/house")).json()) as { sets: unknown[] };
    expect(one.sets).toHaveLength(10);
    expect((await req(env, "/ui/api/genres/nope")).status).toBe(404);
    expect((await req(env, "/ui/api/genres/BAD%20KEY")).status).toBe(400);
    expect((await post(env, "/ui/api/genres/house/enabled", { enabled: "yes" })).status).toBe(400);
    const off = (await (
      await post(env, "/ui/api/genres/house/enabled", { enabled: false })
    ).json()) as {
      genre: { status: string };
    };
    expect(off.genre.status).toBe("off");
    await post(env, "/ui/api/genres/house/enabled", { enabled: null });
    const run = (await (await post(env, "/ui/api/genres/house/backfill", {})).json()) as {
      inserted: number;
    };
    expect(run.inserted).toBe(10);
    const ref = (await (await post(env, "/ui/api/genres/house/refresh", {})).json()) as {
      refreshed: boolean;
    };
    expect(ref.refreshed).toBe(true);
    expect(
      (
        (await (await post(env, "/ui/api/genres/techno/refresh", {})).json()) as {
          refreshed: boolean;
        }
      ).refreshed,
    ).toBe(false);
    expect((await post(env, "/ui/api/genres/nope/enabled", { enabled: true })).status).toBe(404);
  });
});
