import { describe, it, expect, vi } from "vitest";
import { fakeD1 } from "./helpers/fake-d1";
import { fakeKV } from "./helpers/fake-kv";
import type { Env } from "../src/types";
import {
  fetchVideoMeta,
  getVideoMeta,
  readCachedVideoMeta,
  saveVideoChannels,
  saveVideoMeta,
} from "../src/lib/video-meta";

function makeEnv(): Env {
  return {
    CACHE: fakeKV(),
    SUBS: fakeKV(),
    DB: fakeD1(),
    API_TOKEN: "t",
    YOUTUBE_API_KEY: "k",
  } as Env;
}

/** Fake videos.list: every requested id comes back unless listed in `missing`. */
function videosFetcher(
  opts: { missing?: string[]; vertical?: string[]; channels?: Record<string, string> } = {},
) {
  const calls: URL[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url);
    const ids = (url.searchParams.get("id") ?? "").split(",").filter(Boolean);
    const items = ids
      .filter((id) => !(opts.missing ?? []).includes(id))
      .map((id) => ({
        id,
        contentDetails: { duration: "PT1H2M3S" },
        player: (opts.vertical ?? []).includes(id)
          ? { embedWidth: "1280", embedHeight: "2276" }
          : { embedWidth: "1280", embedHeight: "720" },
        status: { privacyStatus: "public", uploadStatus: "processed" },
        snippet: {
          channelId: opts.channels?.[id] ?? "UCchan",
          channelTitle: `title of ${opts.channels?.[id] ?? "UCchan"}`,
        },
      }));
    return new Response(JSON.stringify({ items }), { status: 200 });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe("fetchVideoMeta", () => {
  it("asks for contentDetails, player, status and snippet with maxWidth, 50 ids per call", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `vid${String(i).padStart(8, "0")}`);
    const f = videosFetcher();
    const out = await fetchVideoMeta(ids, "tok", f.fn);
    expect(f.calls).toHaveLength(3);
    expect(f.calls[0]!.searchParams.get("part")).toBe("contentDetails,player,status,snippet");
    expect(f.calls[0]!.searchParams.get("maxWidth")).toBe("1280");
    expect(f.calls.map((u) => u.searchParams.get("id")!.split(",").length)).toEqual([50, 50, 20]);
    expect(out.get(ids[0]!)).toMatchObject({
      durationSeconds: 3723,
      embedWidth: 1280,
      embedHeight: 720,
      alive: true,
      channelId: "UCchan",
      channelTitle: "title of UCchan",
    });
  });

  it("marks ids the API does not return, and rejected/deleted uploads, as dead", async () => {
    const f = videosFetcher({ missing: ["gone0000001"] });
    const out = await fetchVideoMeta(["gone0000001", "here0000001"], "tok", f.fn);
    expect(out.get("gone0000001")).toMatchObject({ alive: false, durationSeconds: null });
    expect(out.get("here0000001")!.alive).toBe(true);

    const rejected = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            items: [
              {
                id: "rej00000001",
                contentDetails: { duration: "PT1M" },
                status: { uploadStatus: "rejected" },
              },
            ],
          }),
        ),
    ) as unknown as typeof fetch;
    expect((await fetchVideoMeta(["rej00000001"], "tok", rejected)).get("rej00000001")!.alive).toBe(
      false,
    );
  });

  it("throws on an API error instead of reporting everything dead", async () => {
    const quota = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { errors: [{ reason: "quotaExceeded" }] } }), {
          status: 403,
        }),
    ) as unknown as typeof fetch;
    await expect(fetchVideoMeta(["a0000000001"], "tok", quota)).rejects.toThrow(/videos.list 403/);
  });
});

describe("getVideoMeta (D1 cache)", () => {
  it("serves cached rows without a call, and re-reads when forced or stale", async () => {
    const env = makeEnv();
    const f = videosFetcher({ vertical: ["v0000000001"] });
    const now = 1_800_000_000;
    const first = await getVideoMeta(env, ["v0000000001", "h0000000001"], "tok", {
      fetcher: f.fn,
      now,
    });
    expect(first.get("v0000000001")).toMatchObject({ embedHeight: 2276 });
    expect(f.calls).toHaveLength(1);
    expect((await readCachedVideoMeta(env, ["v0000000001"])).get("v0000000001")!.embedHeight).toBe(
      2276,
    );

    await getVideoMeta(env, ["v0000000001", "h0000000001"], "tok", {
      fetcher: f.fn,
      now: now + 60,
    });
    expect(f.calls).toHaveLength(1);

    await getVideoMeta(env, ["v0000000001"], "tok", {
      fetcher: f.fn,
      now: now + 60,
      maxAgeSeconds: 0,
    });
    expect(f.calls).toHaveLength(2);

    await getVideoMeta(env, ["h0000000001"], "tok", { fetcher: f.fn, now: now + 31 * 86400 });
    expect(f.calls).toHaveLength(3);
  });

  it("re-reads a dead entry after a day, not a month", async () => {
    const env = makeEnv();
    const now = 1_800_000_000;
    const gone = videosFetcher({ missing: ["d0000000001"] });
    await getVideoMeta(env, ["d0000000001"], "tok", { fetcher: gone.fn, now });
    await getVideoMeta(env, ["d0000000001"], "tok", { fetcher: gone.fn, now: now + 3600 });
    expect(gone.calls).toHaveLength(1);
    const back = videosFetcher();
    const m = await getVideoMeta(env, ["d0000000001"], "tok", {
      fetcher: back.fn,
      now: now + 86400 + 1,
    });
    expect(back.calls).toHaveLength(1);
    expect(m.get("d0000000001")!.alive).toBe(true);
  });
});

describe("uploader channels", () => {
  it("a later answer without a channel (dead video) keeps the channel already known", async () => {
    const env = makeEnv();
    const now = 1_800_000_000;
    await getVideoMeta(env, ["c0000000001"], "tok", {
      fetcher: videosFetcher({ channels: { c0000000001: "UCfan" } }).fn,
      now,
    });
    await getVideoMeta(env, ["c0000000001"], "tok", {
      fetcher: videosFetcher({ missing: ["c0000000001"] }).fn,
      now: now + 10,
      maxAgeSeconds: 0,
    });
    const m = (await readCachedVideoMeta(env, ["c0000000001"])).get("c0000000001")!;
    expect(m.alive).toBe(false);
    expect(m.channelId).toBe("UCfan");
    expect(m.channelTitle).toBe("title of UCfan");
  });

  it("saveVideoChannels writes only the channel: a new row is stale for duration readers, an existing row keeps its meta", async () => {
    const env = makeEnv();
    const now = 1_800_000_000;
    await getVideoMeta(env, ["k0000000001"], "tok", { fetcher: videosFetcher().fn, now });
    await saveVideoChannels(env, [
      { videoId: "k0000000001", channelId: "UCnew", channelTitle: "New" },
      { videoId: "n0000000001", channelId: "UClist", channelTitle: "Listed" },
      { videoId: "x0000000001", channelId: null, channelTitle: null },
    ]);
    const cached = await readCachedVideoMeta(env, ["k0000000001", "n0000000001", "x0000000001"]);
    expect(cached.get("k0000000001")).toMatchObject({
      durationSeconds: 3723,
      channelId: "UCnew",
      fetchedAt: now,
    });
    expect(cached.get("n0000000001")).toMatchObject({
      durationSeconds: null,
      channelId: "UClist",
      fetchedAt: 0,
      alive: true,
    });
    expect(cached.has("x0000000001")).toBe(false);
    // The listing-only row is looked up by the next reader that needs its duration.
    const f = videosFetcher();
    await getVideoMeta(env, ["n0000000001"], "tok", { fetcher: f.fn, now: now + 5 });
    expect(f.calls).toHaveLength(1);
  });

  it("a cached alive row from before channels were asked for is read again once; a listing's channel is enough", async () => {
    const env = makeEnv();
    const now = 1_800_000_000;
    const old = {
      durationSeconds: 3600,
      embedWidth: 1280,
      embedHeight: 720,
      privacy: "public",
      uploadStatus: "processed",
      alive: true,
      fetchedAt: now,
      channelId: null,
      channelTitle: null,
      channelChecked: false,
    };
    await saveVideoMeta(env, [
      { ...old, videoId: "o0000000001" },
      { ...old, videoId: "o0000000002" },
    ]);
    await saveVideoChannels(env, [
      { videoId: "o0000000002", channelId: "UClisted", channelTitle: "L" },
    ]);
    const f = videosFetcher();
    await getVideoMeta(env, ["o0000000001", "o0000000002"], "tok", {
      fetcher: f.fn,
      now: now + 60,
    });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.searchParams.get("id")).toBe("o0000000001");
    await getVideoMeta(env, ["o0000000001", "o0000000002"], "tok", {
      fetcher: f.fn,
      now: now + 120,
    });
    expect(f.calls).toHaveLength(1);
  });
});
