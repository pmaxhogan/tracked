/**
 * The YouTube quota priority rule (lib/quota-priority.ts): a consumer at rank
 * r may spend u units while the pool keeps what every higher rank waits for
 * (or its `min`, until spent) plus the margin, within its own `max`; owner
 * actions only wait for an empty pool.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";
import { fakeKV } from "./helpers/fake-kv";
import { fakeD1 } from "./helpers/fake-d1";
import { updateAppSettings } from "../src/lib/app-settings";
import { consumerStatus, quotaGate } from "../src/lib/quota-priority";
import { WAITING_CACHE_KEY, waitingDemand } from "../src/lib/quota-waiting";
import { markProjectOut, OWN_PROJECT, recordUnits } from "../src/lib/youtube-pool";
import { youtubePoolHooks } from "../src/lib/google-oauth";
import { quotaConsumer, setQuotaConsumer } from "../src/lib/youtube-playlists";
import { loadSubState, syncOne } from "../src/lib/sync";
import { runPlaylistHygiene } from "../src/lib/playlist-hygiene";
import { retryDuePresavePlaylist } from "../src/lib/presave-playlist";
import { quotaDayEnd, quotaDayStart } from "../src/lib/mkvid";
import { makeLogger } from "../src/lib/log";

vi.mock("../src/lib/dj-index", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/dj-index")>("../src/lib/dj-index");
  return {
    ...actual,
    fetch1001Html: vi.fn(),
    crawlDjIndex: vi.fn(),
    parseSetYouTubeId: vi.fn(),
    parseSetYouTubeIds: vi.fn(() => []),
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

import { crawlDjIndex, fetch1001Html, parseSetYouTubeId } from "../src/lib/dj-index";
import { addVideoToPlaylist, listPlaylistVideoIds } from "../src/lib/youtube-playlists";

function makeEnv(): Env {
  return {
    CACHE: fakeKV(),
    SUBS: fakeKV(),
    DB: fakeD1(),
    API_TOKEN: "t",
    YOUTUBE_API_KEY: "k",
  } as unknown as Env;
}

/** Units spent today on the own project (the only one without pushed tokens), by consumer. */
async function spend(env: Env, consumer: string, units: number): Promise<void> {
  await recordUnits(env, OWN_PROJECT, consumer, units);
}

async function subscribe(env: Env, slug: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO subscriptions (slug, source_url, added_at, position) VALUES (?, ?, 0, 0)",
  )
    .bind(slug, `https://www.1001tracklists.com/dj/${slug}/index.html`)
    .run();
}

/** `n` sets of `slug` whose video waits to be inserted (a DJ insert each). */
async function setsWaiting(env: Env, slug: string, n: number, from = 1): Promise<void> {
  for (let i = from; i < from + n; i++) {
    await env.DB.prepare(
      "INSERT INTO tracklists (slug, url, position, discovered_at, processed, abandoned, video_known, video_id) VALUES (?, ?, ?, 0, 0, 0, 1, ?)",
    )
      .bind(slug, `https://www.1001tracklists.com/tracklist/${slug}-${i}/x.html`, i, `vid${i}`)
      .run();
  }
}

async function consumers(
  env: Env,
  c: Record<string, { min?: number | null; max?: number | null; enabled?: boolean }>,
): Promise<void> {
  const full = Object.fromEntries(
    Object.entries(c).map(([k, v]) => [
      k,
      { min: v.min ?? null, max: v.max ?? null, enabled: v.enabled ?? true },
    ]),
  );
  const r = await updateAppSettings(env as Env & { SUBS: KVNamespace }, {
    quota: { consumers: full },
  });
  expect(r.ok).toBe(true);
}

beforeEach(() => {
  setQuotaConsumer(null);
});

describe("waitingDemand", () => {
  it("is the 12 sets of the spec's example as 600 units for dj_playlists, 0 for the rest", async () => {
    const env = makeEnv();
    await subscribe(env, "dj-one");
    await setsWaiting(env, "dj-one", 12);
    const w = await waitingDemand(env);
    expect(w.dj_playlists).toBe(600);
    expect(w.likes).toBe(0);
    expect(w.presave_playlists).toBe(0);
    expect(w.ordering).toBe(0);
    expect(w.combined).toBe(0);
  });

  it("is cached in CACHE for 240 s", async () => {
    const env = makeEnv();
    await subscribe(env, "dj-one");
    await setsWaiting(env, "dj-one", 2);
    const put = vi.spyOn(env.CACHE, "put");
    expect((await waitingDemand(env)).dj_playlists).toBe(100);
    expect(put).toHaveBeenCalledWith(WAITING_CACHE_KEY, expect.any(String), {
      expirationTtl: 240,
    });
    await setsWaiting(env, "dj-one", 2, 3);
    expect((await waitingDemand(env)).dj_playlists).toBe(100);
    await env.CACHE.delete(WAITING_CACHE_KEY);
    expect((await waitingDemand(env)).dj_playlists).toBe(200);
  });
});

describe("quotaGate", () => {
  it("holds ordering while the 12 waiting DJ inserts (600) do not fit remaining - margin, and lets it spend once they do", async () => {
    const env = makeEnv();
    await subscribe(env, "dj-one");
    await setsWaiting(env, "dj-one", 12);
    // Ordering ships switched off (orderDailyUnits 0); on, with no max.
    await consumers(env, { ordering: {} });
    // 1000 left in the pool.
    await spend(env, "unknown", 9000);
    // 1000 - 100 = 900 >= 600 + 300.
    expect(await quotaGate(env, "ordering", 100)).toEqual({ ok: true });
    // 1000 - 101 < 900.
    expect(await quotaGate(env, "ordering", 101)).toEqual({ ok: false, reason: "held" });
    // dj_playlists itself (rank 3) only keeps what likes and pre-saves wait for: nothing.
    expect(await quotaGate(env, "dj_playlists", 50)).toEqual({ ok: true });
  });

  it("lets ordering spend once the DJ inserts fit", async () => {
    const env = makeEnv();
    await subscribe(env, "dj-one");
    await setsWaiting(env, "dj-one", 5);
    await consumers(env, { ordering: {} });
    await spend(env, "unknown", 9000);
    // 1000 - 400 = 600 >= 250 + 300.
    expect(await quotaGate(env, "ordering", 400)).toEqual({ ok: true });
    expect(await quotaGate(env, "ordering", 451)).toEqual({ ok: false, reason: "held" });
  });

  it("counts a higher rank's min as waiting until it is spent", async () => {
    const env = makeEnv();
    await consumers(env, { likes: { min: 6000 } });
    await spend(env, "unknown", 6000);
    // 4000 left; likes keep 6000 they have not spent.
    expect(await quotaGate(env, "combined", 50)).toEqual({ ok: false, reason: "held" });

    const spent = makeEnv();
    await consumers(spent, { likes: { min: 6000 } });
    await spend(spent, "likes", 6000);
    // Still 4000 left, but the likes had their 6000.
    expect(await quotaGate(spent, "combined", 50)).toEqual({ ok: true });
  });

  it("refuses at the consumer's max, counting units not yet written to the ledger", async () => {
    const env = makeEnv();
    await consumers(env, { dj_playlists: { max: 200 } });
    await spend(env, "dj_playlists", 100);
    expect(await quotaGate(env, "dj_playlists", 100)).toEqual({ ok: true });
    expect(await quotaGate(env, "dj_playlists", 101)).toEqual({ ok: false, reason: "max" });
    // 50 more spent this invocation, still in memory: counted although the ledger read is memoised.
    setQuotaConsumer("dj_playlists");
    youtubePoolHooks(env).spent(OWN_PROJECT, 50);
    expect(await quotaGate(env, "dj_playlists", 51)).toEqual({ ok: false, reason: "max" });
  });

  it("leaves the max of likes, combined, hygiene and ordering to their own exact counters", async () => {
    const env = makeEnv();
    await consumers(env, {
      likes: { max: 100 },
      combined: { max: 100 },
      hygiene: { max: 102 },
      ordering: { max: 100 },
    });
    // Units the ledger charged to them (a like's consumer left set, a comparison's reads): no refusal.
    await spend(env, "likes", 500);
    await spend(env, "hygiene", 800);
    await spend(env, "combined", 500);
    await spend(env, "ordering", 500);
    expect(await quotaGate(env, "likes", 51)).toEqual({ ok: true });
    expect(await quotaGate(env, "hygiene", 51)).toEqual({ ok: true });
    expect(await quotaGate(env, "combined", 50)).toEqual({ ok: true });
    expect(await quotaGate(env, "ordering", 51)).toEqual({ ok: true });
  });

  it("holds back for a higher rank no more than its own max still allows it", async () => {
    // 3000 left; likes want to keep 5000 (their min).
    const capped = makeEnv();
    await consumers(capped, { likes: { min: 5000, max: 2000 } });
    await spend(capped, "unknown", 7000);
    // They may spend 2000 at most: 3000 - 50 >= 2000 + 300.
    expect(await quotaGate(capped, "combined", 50)).toEqual({ ok: true });
    const uncapped = makeEnv();
    await consumers(uncapped, { likes: { min: 5000 } });
    await spend(uncapped, "unknown", 7000);
    expect(await quotaGate(uncapped, "combined", 50)).toEqual({ ok: false, reason: "held" });
    const atMax = makeEnv();
    await consumers(atMax, { likes: { min: 5000, max: 2000 } });
    await spend(atMax, "unknown", 7000);
    await spend(atMax, "likes", 2000);
    // At their max the likes hold nothing back: 1000 - 50 >= 0 + 300.
    expect(await quotaGate(atMax, "combined", 50)).toEqual({ ok: true });
  });

  it("never holds anything back for mkvid_uploads, which spends the upload bucket", async () => {
    const env = makeEnv();
    await consumers(env, { mkvid_uploads: { min: 100000, max: 1 } });
    expect(await quotaGate(env, "mkvid_recreate", 51)).toEqual({ ok: true });
    expect(await quotaGate(env, "mkvid_uploads", 500)).toEqual({ ok: true });
  });

  it("reads the pool and the ledger once in its memo window, whatever the number of calls", async () => {
    const env = makeEnv();
    const prepare = vi.spyOn(env.DB, "prepare");
    const now = Date.now();
    for (let i = 0; i < 5; i++) await quotaGate(env, "dj_playlists", 50, now + i);
    const ledgerReads = () =>
      prepare.mock.calls.filter(([sql]) => String(sql).includes("youtube_quota_ledger"));
    // One by consumer (the rule) and one by project (the pool).
    expect(ledgerReads()).toHaveLength(2);
    await quotaGate(env, "dj_playlists", 50, now + 6000);
    expect(ledgerReads()).toHaveLength(4);
  });

  it("is out when what is left, less the units not yet written, is under the margin", async () => {
    const env = makeEnv();
    await spend(env, "unknown", 9600);
    expect(await quotaGate(env, "likes", 51)).toEqual({ ok: true });
    setQuotaConsumer("likes");
    youtubePoolHooks(env).spent(OWN_PROJECT, 200);
    // 400 - 200 = 200 left, under the 300 margin.
    expect(await quotaGate(env, "likes", 51)).toEqual({ ok: false, reason: "pool_out" });
  });

  it("refuses a consumer the owner switched off", async () => {
    const env = makeEnv();
    await consumers(env, { combined: { enabled: false } });
    expect(await quotaGate(env, "combined", 50)).toEqual({ ok: false, reason: "off" });
  });

  it("lets the owner through whatever waits, and stops it only when the pool is out", async () => {
    const env = makeEnv();
    await consumers(env, { likes: { min: 100000 } });
    await spend(env, "unknown", 9500);
    expect(await quotaGate(env, "owner", 50)).toEqual({ ok: true });
    expect(quotaConsumer()).toBe("owner");
    await markProjectOut(env, OWN_PROJECT);
    expect(await quotaGate(env, "owner", 50)).toEqual({ ok: false, reason: "pool_out" });
    expect(await quotaGate(env, "likes", 51)).toEqual({ ok: false, reason: "pool_out" });
  });

  it("names the consumer for the ledger when it lets one spend, and leaves it when it refuses", async () => {
    const env = makeEnv();
    expect(await quotaGate(env, "hygiene", 51)).toEqual({ ok: true });
    expect(quotaConsumer()).toBe("hygiene");
    await consumers(env, { ordering: { enabled: false } });
    await quotaGate(env, "ordering", 50);
    expect(quotaConsumer()).toBe("hygiene");
  });

  it("lets a consumer spend when the pool cannot be read", async () => {
    const env = { ...makeEnv(), DB: undefined } as unknown as Env;
    await consumers(env, { ordering: {} });
    expect(await quotaGate(env, "ordering", 50)).toEqual({ ok: true });
  });
});

describe("consumerStatus", () => {
  it("lists every ranked consumer with its state, today's units and what waits", async () => {
    const env = makeEnv();
    await subscribe(env, "dj-one");
    await setsWaiting(env, "dj-one", 12);
    await consumers(env, { combined: { enabled: false }, mkvid_recreate: { max: 100 } });
    await spend(env, "unknown", 9000);
    await spend(env, "mkvid_recreate", 100);
    const s = await consumerStatus(env);
    expect(s.map((r) => r.key)).toEqual([
      "likes",
      "presave_playlists",
      "dj_playlists",
      "hygiene",
      "mkvid_uploads",
      "mkvid_recreate",
      "genre_playlists",
      "combined",
      "renames",
      "ordering",
    ]);
    const by = Object.fromEntries(s.map((r) => [r.key, r]));
    expect(by.dj_playlists).toEqual({
      key: "dj_playlists",
      status: "running",
      spentToday: 0,
      waiting: 600,
    });
    expect(by.combined!.status).toBe("off");
    expect(by.mkvid_recreate).toMatchObject({ status: "max", spentToday: 100 });
    expect(by.mkvid_uploads!.status).toBe("outside");
    // 900 left: rank 6 keeps 600 + 300 for the DJ inserts.
    expect(by.renames!.status).toBe("held");
  });
});

describe("consumerStatus: the consumers with their own counters", () => {
  it("shows max when the consumer's own KV counter parked it, though the gate (and the ledger) would let it run", async () => {
    const env = makeEnv();
    await consumers(env, {
      likes: { max: 102 },
      combined: { max: 100 },
      hygiene: { max: 102 },
      ordering: { max: 100 },
    });
    const now = Date.now();
    const utc = new Date(now).toISOString().slice(0, 10);
    // Each at its max by its own counter; the ledger has nothing for them.
    await env.CACHE.put(`presave:like-units:${quotaDayStart(now)}`, "102");
    await env.CACHE.put(`yt:combined:inserts:${utc}`, "2");
    await env.CACHE.put(`hygiene:sweep:deletes:${utc}`, "2");
    await env.CACHE.put(`yt:order:units:${quotaDayStart(now)}`, "100");
    const by = Object.fromEntries((await consumerStatus(env, now)).map((r) => [r.key, r]));
    for (const k of ["likes", "combined", "hygiene", "ordering"]) {
      expect(by[k]!.status).toBe("max");
      expect(await quotaGate(env, k as never, 50, now)).toEqual({ ok: true });
    }
    // Under their max by their counters: running.
    const fresh = makeEnv();
    await consumers(fresh, { combined: { max: 100 }, ordering: { max: 100 } });
    await fresh.CACHE.put(`yt:combined:inserts:${utc}`, "1");
    const s = Object.fromEntries((await consumerStatus(fresh, now)).map((r) => [r.key, r]));
    expect(s.combined!.status).toBe("running");
    expect(s.ordering!.status).toBe("running");
  });
});

describe("a refused sync insert", () => {
  it("stays deferred: unprocessed, its video on record, nothing inserted", async () => {
    const env = makeEnv();
    // Pre-save likes (rank 1) keep everything that is left.
    await consumers(env, { likes: { min: 100000 } });
    const sub = {
      slug: "lillypalmer",
      sourceUrl: "https://www.1001tracklists.com/dj/lillypalmer/",
      addedAt: 0,
    };
    (crawlDjIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
      artistName: "Lilly Palmer",
      tracklistUrls: ["https://x/tracklist/a"],
      pagesWalked: 1,
      stopReason: "empty",
    });
    (fetch1001Html as ReturnType<typeof vi.fn>).mockResolvedValue({
      html: "<set/>",
      via: "direct",
      state: { cookie: "" },
    });
    (listPlaylistVideoIds as ReturnType<typeof vi.fn>).mockImplementation(async () => new Set());
    (parseSetYouTubeId as ReturnType<typeof vi.fn>).mockReturnValue("vidA1234567");
    await (
      await import("../src/lib/sync")
    ).saveSubState(env, sub.slug, {
      playlistId: "PLcached",
      artistName: "Lilly Palmer",
      processedTracklistUrls: [],
    });

    const r = await syncOne(env, sub, "tok", { trigger: "cron.pending" });

    expect(addVideoToPlaylist).not.toHaveBeenCalled();
    expect(r.quota).toEqual({
      out: false,
      hit: false,
      held: "held",
      deferred: ["https://x/tracklist/a"],
    });
    const state = (await loadSubState(env, sub.slug))!;
    expect(state.processedTracklistUrls).toEqual([]);
    expect(state.tracklistVideos!["https://x/tracklist/a"]!.videoId).toBe("vidA1234567");
  });
});

describe("the cron steps on a refusal", () => {
  const log = makeLogger({ task: "test" });

  it("hygiene: a comparison's reads charged to it do not count against its removal max", async () => {
    const env = makeEnv();
    await consumers(env, { hygiene: { max: 102 } });
    await spend(env, "hygiene", 5000);
    // Past the gate: it stops only for the missing YouTube connection.
    expect(await runPlaylistHygiene(env, log)).toEqual({ skipped: "youtube_not_connected" });
  });

  it("hygiene: held, it says so readably and marks nothing done", async () => {
    const env = makeEnv();
    await consumers(env, { hygiene: { enabled: false } });
    expect(await runPlaylistHygiene(env, log)).toEqual({
      skipped: "quota_off",
      message: "switched off",
    });
  });

  it("Pre-saves playlist: at its daily max the due rows wait for the quota day's end", async () => {
    const env = makeEnv();
    await consumers(env, { presave_playlists: { max: 100 } });
    await spend(env, "presave_playlists", 100);
    await env.DB.prepare(
      "INSERT INTO presaves (id, track_id, artist, title, stage, youtube_video_id, created_at, updated_at, presave_playlist_status, presave_playlist_next_at) VALUES (1, 't1', 'A', 'T', 'found', 'VIDEOAAAAA1', 0, 0, 'pending', 0)",
    ).run();
    const now = Date.now();
    expect(await retryDuePresavePlaylist(env, log, { nowMs: now })).toEqual({
      added: 0,
      skipped: 0,
      failed: 0,
    });
    const row = await env.DB.prepare(
      "SELECT presave_playlist_status AS s, presave_playlist_next_at AS n FROM presaves WHERE id = 1",
    ).first<{ s: string; n: number }>();
    expect(row).toEqual({ s: "pending", n: quotaDayEnd(now) * 1000 });
  });
});

describe("the ledger's consumer per request", () => {
  it("is the owner's for the admin UI and unnamed for anything else", async () => {
    const { app } = await import("../src/index");
    const env = { ...makeEnv(), DEV_BYPASS_CF_ACCESS: "1" } as unknown as Env;
    setQuotaConsumer("hygiene");
    await app.request("https://tracked.example/ui/api/youtube/status", {}, env);
    expect(quotaConsumer()).toBe("owner");
    await app.request("https://tracked.example/favicon.ico", {}, env);
    expect(quotaConsumer()).toBe("unknown");
  });
});
