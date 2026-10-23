/**
 * YouTube subscriptions (src/lib/youtube-subscriptions.ts): which channel is
 * the DJ's, the resolver's storage, a run (backfill, the owner's own
 * subscriptions, unfollows, YouTube errors, the gate, the switch), the quota
 * rank of the new consumer, its waiting count, and the pages' API.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import { fakeD1 } from "./helpers/fake-d1";
import { fakeKV } from "./helpers/fake-kv";
import { makeLogger } from "../src/lib/log";

vi.mock("../src/lib/google-oauth", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/google-oauth")>("../src/lib/google-oauth");
  return { ...actual, getAccessToken: vi.fn(async () => ({ accessToken: "tok", tokens: {} })) };
});
vi.mock("../src/lib/quota-priority", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/quota-priority")>(
    "../src/lib/quota-priority",
  );
  return { ...actual, quotaGate: vi.fn(async () => ({ ok: true })) };
});

import { getAccessToken, GoogleOAuthRefreshFailed } from "../src/lib/google-oauth";
import { quotaGate } from "../src/lib/quota-priority";
import {
  channelIdOf,
  djYtSub,
  LAST_RUN_KEY,
  MAX_ATTEMPTS,
  nameKey,
  pickChannel,
  resolveDjChannel,
  resolveDue,
  runYtSubs,
  ytSubsCronStep,
  ytSubsSummary,
} from "../src/lib/youtube-subscriptions";
import { ytSubsPendingCount } from "../src/lib/youtube-subs-plan";
import { waitingDemand } from "../src/lib/quota-waiting";
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_YT_SUBS_DAILY_UNITS,
  getAppSettings,
  updateAppSettings,
} from "../src/lib/app-settings";
import { DJS_TABLE } from "../src/lib/dj-table";
import { parseTableQuery, runTableQuery } from "../src/lib/table-query";
import { app } from "../src/index";

const log = makeLogger({ task: "test" });
const mk = <T>(f: unknown) => f as ReturnType<typeof vi.fn> & T;

const CH = (n: number) => `UC${String(n).padStart(22, "a")}`;
const ytLink = (id: string) => ({
  label: "YouTube",
  href: `https://www.youtube.com/channel/${id}`,
});

function makeEnv(): Env {
  return {
    CACHE: fakeKV(),
    SUBS: fakeKV(),
    DB: fakeD1(),
    API_TOKEN: "t",
    YOUTUBE_API_KEY: "k",
  } as Env;
}

let setN = 0;
/** Follow `slug` (artist name `name`) with one set page whose boxes are `boxes`. */
async function follow(
  env: Env,
  slug: string,
  name: string | null,
  boxes: unknown[] | null,
  position = 0,
) {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO subscriptions (slug, source_url, added_at, position) VALUES (?, ?, 0, ?)",
  )
    .bind(slug, `https://www.1001tracklists.com/dj/${slug}/`, position)
    .run();
  if (name)
    await env.DB.prepare("INSERT OR IGNORE INTO sub_sync (slug, artist_name) VALUES (?, ?)")
      .bind(slug, name)
      .run();
  if (!boxes) return;
  const url = `https://www.1001tracklists.com/tracklist/s${++setN}/x.html`;
  await env.DB.prepare(
    "INSERT INTO tracklists (slug, url, position, discovered_at) VALUES (?, ?, ?, 0)",
  )
    .bind(slug, url, setN)
    .run();
  await env.DB.prepare(
    "INSERT INTO set_meta (set_url, meta, format, source, fetched_at, updated_at) VALUES (?, ?, 1, 'sync', ?, ?)",
  )
    .bind(url, JSON.stringify({ boxes }), setN, setN)
    .run();
}

const artistBox = (title: string, slug: string, links: Array<{ label: string; href: string }>) => ({
  title,
  path: `/artist/${slug}/tracklists.html`,
  country: null,
  links,
  object: 2,
  item: "1",
});

/** A fake YouTube: subscriptions the account has, by channel; records every call. */
function fakeYouTube(opts: {
  have?: Record<string, string>;
  insert?: (channelId: string) => Response | null;
  del?: (id: string) => Response | null;
  list?: () => Response | null;
}) {
  const have = new Map(Object.entries(opts.have ?? {}));
  const calls: string[] = [];
  let next = 1;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push(`${method} ${u.pathname.split("/").pop()}`);
    if (method === "GET") {
      const r = opts.list?.();
      if (r) return r;
      const ids = (u.searchParams.get("forChannelId") ?? "").split(",");
      return json({
        items: ids
          .filter((id) => have.has(id))
          .map((id) => ({ id: have.get(id), snippet: { resourceId: { channelId: id } } })),
      });
    }
    if (method === "POST") {
      const body = JSON.parse(String(init?.body)) as {
        snippet: { resourceId: { channelId: string } };
      };
      const ch = body.snippet.resourceId.channelId;
      const r = opts.insert?.(ch);
      if (r) return r;
      const id = `sub${next++}`;
      have.set(ch, id);
      return json({ id });
    }
    const id = u.searchParams.get("id")!;
    const r = opts.del?.(id);
    if (r) return r;
    for (const [k, v] of have) if (v === id) have.delete(k);
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return { fetcher, calls, have, json };
}

const ytError = (status: number, reason: string) =>
  new Response(JSON.stringify({ error: { code: status, message: reason, errors: [{ reason }] } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function row(env: Env, channelId: string) {
  return env.DB.prepare("SELECT * FROM youtube_channel_subs WHERE channel_id = ?")
    .bind(channelId)
    .first<{
      origin: string;
      state: string;
      subscription_id: string | null;
      attempts: number;
      next_at: number | null;
      error: string | null;
    }>();
}

beforeEach(() => {
  mk(quotaGate).mockReset();
  mk(quotaGate).mockResolvedValue({ ok: true });
  mk(getAccessToken).mockReset();
  mk(getAccessToken).mockResolvedValue({ accessToken: "tok", tokens: {} });
});

describe("which channel is the DJ's", () => {
  it("normalises names to one key", () => {
    expect(nameKey("Lilly Palmer")).toBe("lillypalmer");
    expect(nameKey("lilly-palmer")).toBe("lillypalmer");
    expect(nameKey("HI-LO")).toBe("hilo");
    expect(nameKey(null)).toBe("");
  });

  it("reads a channel id from /channel/ and bare /UC paths only", () => {
    const id = CH(1);
    expect(channelIdOf(`https://www.youtube.com/channel/${id}`)).toBe(id);
    expect(channelIdOf(`https://www.youtube.com/${id}`)).toBe(id);
    expect(channelIdOf(`https://youtube.com/channel/${id}/videos`)).toBe(id);
    expect(channelIdOf("https://www.youtube.com/channel/ravinggeorgemusic")).toBeNull();
    expect(channelIdOf("https://www.youtube.com/@somebody")).toBeNull();
    expect(channelIdOf(`https://evil.example/channel/${id}`)).toBeNull();
    expect(channelIdOf("not a url")).toBeNull();
    expect(channelIdOf(null)).toBeNull();
  });

  it("takes the DJ's own box, never a B2B partner's or a venue's, and its first channel", () => {
    const boxes = [
      artistBox("Solardo", "solardo", [ytLink(CH(9))]),
      {
        title: "Cow Palace",
        path: "/source/x/cow-palace/index.html",
        links: [ytLink(CH(8))],
        object: 3,
      },
      artistBox("Dom Dolla", "dom-dolla", [
        { label: "Spotify", href: "https://open.spotify.com/artist/x" },
        ytLink(CH(1)),
        ytLink(CH(2)),
      ]),
    ];
    expect(pickChannel(boxes, ["Dom Dolla", "dom-dolla"], true)).toEqual({
      channelId: CH(1),
      candidates: [CH(1), CH(2)],
      artistPath: "/artist/dom-dolla/tracklists.html",
    });
  });

  it("matches by the slug when the artist name is unknown, and by the box path", () => {
    expect(
      pickChannel([artistBox("LP", "lilly-palmer", [ytLink(CH(3))])], [null, "lillypalmer"], true),
    ).toMatchObject({ channelId: CH(3) });
  });

  it("says why there is none", () => {
    expect(pickChannel([], ["x"], false)).toEqual({ channelId: null, reason: "no_set_meta" });
    expect(pickChannel([artistBox("Other", "other", [ytLink(CH(1))])], ["DJ"], true)).toEqual({
      channelId: null,
      reason: "no_artist_box",
    });
    expect(
      pickChannel(
        [artistBox("DJ", "dj", [{ label: "YouTube", href: "https://youtube.com/@dj" }])],
        ["DJ"],
        true,
      ),
    ).toEqual({ channelId: null, reason: "no_youtube_link" });
  });
});

describe("the resolver", () => {
  it("stores the channel, keeps it when a later look finds none, and replaces it only with another", async () => {
    const env = makeEnv();
    await follow(env, "dj", "DJ", [artistBox("DJ", "dj", [ytLink(CH(1))])]);
    expect(await resolveDjChannel(env, "dj", "DJ", 100)).toMatchObject({ channelId: CH(1) });
    // The pages are gone: the channel stays.
    await env.DB.prepare("DELETE FROM set_meta").run();
    expect(await resolveDjChannel(env, "dj", "DJ", 200)).toMatchObject({ reason: "no_set_meta" });
    let r = await env.DB.prepare("SELECT * FROM dj_youtube_channels WHERE slug = 'dj'").first<{
      channel_id: string;
      reason: string | null;
      checked_at: number;
      updated_at: number;
    }>();
    expect(r).toMatchObject({ channel_id: CH(1), reason: null, checked_at: 200, updated_at: 100 });
    // A newer page links another channel: it replaces the old one.
    await follow(env, "dj", "DJ", [artistBox("DJ", "dj", [ytLink(CH(2))])]);
    await resolveDjChannel(env, "dj", "DJ", 300);
    r = await env.DB.prepare("SELECT * FROM dj_youtube_channels WHERE slug = 'dj'").first();
    expect(r).toMatchObject({ channel_id: CH(2), updated_at: 300 });
  });

  it("records why a DJ has no channel", async () => {
    const env = makeEnv();
    await follow(env, "a", "A", null);
    await follow(env, "b", "B", [artistBox("B", "b", [])]);
    await follow(env, "c", "C", [artistBox("Partner", "partner", [ytLink(CH(1))])]);
    expect(await resolveDue(env, 1000)).toBe(3);
    const { results } = await env.DB.prepare(
      "SELECT slug, channel_id, reason FROM dj_youtube_channels ORDER BY slug",
    ).all();
    expect(results).toEqual([
      { slug: "a", channel_id: null, reason: "no_set_meta" },
      { slug: "b", channel_id: null, reason: "no_youtube_link" },
      { slug: "c", channel_id: null, reason: "no_artist_box" },
    ]);
  });

  it("looks again hourly at a DJ without a channel and daily at one with", async () => {
    const env = makeEnv();
    await follow(env, "none", "None", null);
    await follow(env, "has", "Has", [artistBox("Has", "has", [ytLink(CH(1))])]);
    expect(await resolveDue(env, 10_000)).toBe(2);
    expect(await resolveDue(env, 10_000 + 1800)).toBe(0);
    expect(await resolveDue(env, 10_000 + 3600)).toBe(1);
    expect(await resolveDue(env, 10_000 + 86_400)).toBe(2);
  });
});

describe("a run", () => {
  it("backfills every followed DJ: subscribes in follow order, the owner's own are recorded and never touched", async () => {
    const env = makeEnv();
    await follow(env, "one", "One", [artistBox("One", "one", [ytLink(CH(1))])], 0);
    await follow(env, "two", "Two", [artistBox("Two", "two", [ytLink(CH(2))])], 1);
    await follow(env, "own", "Own", [artistBox("Own", "own", [ytLink(CH(3))])], 2);
    const yt = fakeYouTube({ have: { [CH(3)]: "mine" } });
    const r = await runYtSubs(env, { log, fetcher: yt.fetcher, nowSec: 1000 });
    expect(r).toMatchObject({ ok: true, subscribed: 2, owner: 1, unsubscribed: 0, pending: 0 });
    expect(yt.calls).toEqual(["GET subscriptions", "POST subscriptions", "POST subscriptions"]);
    expect(await row(env, CH(1))).toMatchObject({
      origin: "tracked",
      state: "subscribed",
      subscription_id: "sub1",
    });
    expect(await row(env, CH(3))).toMatchObject({
      origin: "owner",
      state: "subscribed",
      subscription_id: "mine",
    });
    // The gate was asked once for the whole plan as the new consumer.
    expect(mk(quotaGate)).toHaveBeenCalledTimes(1);
    expect(mk(quotaGate).mock.calls[0]![1]).toBe("yt_subscriptions");
    expect(mk(quotaGate).mock.calls[0]![2]).toBe(151);
    // Nothing left: the next run makes no call.
    const again = await runYtSubs(env, { log, fetcher: yt.fetcher, nowSec: 1001 });
    expect(again).toMatchObject({ ok: true, stoppedBy: "nothing" });
    expect(yt.calls).toHaveLength(3);
  });

  it("unsubscribes on unfollow only what tracked made; the owner's stays", async () => {
    const env = makeEnv();
    await follow(env, "keep", "Keep", [artistBox("Keep", "keep", [ytLink(CH(9))])]);
    await follow(env, "mine", "Mine", [artistBox("Mine", "mine", [ytLink(CH(1))])]);
    await follow(env, "theirs", "Theirs", [artistBox("Theirs", "theirs", [ytLink(CH(2))])]);
    const yt = fakeYouTube({ have: { [CH(2)]: "owner-sub" } });
    await runYtSubs(env, { log, fetcher: yt.fetcher, nowSec: 1000 });
    await env.DB.prepare("DELETE FROM subscriptions WHERE slug IN ('mine', 'theirs')").run();
    expect(await ytSubsPendingCount(env, 1001)).toBe(1);
    const r = await runYtSubs(env, { log, fetcher: yt.fetcher, nowSec: 1001 });
    expect(r).toMatchObject({ ok: true, unsubscribed: 1 });
    expect(await row(env, CH(1))).toMatchObject({
      origin: "tracked",
      state: "unsubscribed",
      subscription_id: null,
    });
    expect(await row(env, CH(2))).toMatchObject({ origin: "owner", state: "subscribed" });
    expect(yt.have.has(CH(2))).toBe(true);
    expect(yt.have.has(CH(1))).toBe(false);
    // Followed again: subscribed again.
    await follow(env, "mine", "Mine", null);
    const back = await runYtSubs(env, { log, fetcher: yt.fetcher, nowSec: 1002 });
    expect(back).toMatchObject({ subscribed: 1 });
    expect(await row(env, CH(1))).toMatchObject({ origin: "tracked", state: "subscribed" });
  });

  it("never unsubscribes everything when no DJ is followed", async () => {
    const env = makeEnv();
    await follow(env, "a", "A", [artistBox("A", "a", [ytLink(CH(1))])]);
    const yt = fakeYouTube({});
    await runYtSubs(env, { log, fetcher: yt.fetcher, nowSec: 1000 });
    await env.DB.prepare("DELETE FROM subscriptions").run();
    const r = await runYtSubs(env, { log, fetcher: yt.fetcher, nowSec: 1001 });
    expect(r).toMatchObject({ stoppedBy: "nothing" });
    expect(await row(env, CH(1))).toMatchObject({ state: "subscribed" });
  });

  it("keeps a channel two DJs share while one of them is followed", async () => {
    const env = makeEnv();
    await follow(env, "a", "A", [artistBox("A", "a", [ytLink(CH(1))])]);
    await follow(env, "b", "B", [artistBox("B", "b", [ytLink(CH(1))])]);
    const yt = fakeYouTube({});
    const r = await runYtSubs(env, { log, fetcher: yt.fetcher, nowSec: 1000 });
    expect(r).toMatchObject({ subscribed: 1 });
    await env.DB.prepare("DELETE FROM subscriptions WHERE slug = 'a'").run();
    expect(await runYtSubs(env, { log, fetcher: yt.fetcher, nowSec: 1001 })).toMatchObject({
      stoppedBy: "nothing",
    });
  });

  it("takes a duplicate insert for the owner's, a 404 for a channel gone (weekly), anything else for a retry", async () => {
    const env = makeEnv();
    await follow(env, "dup", "Dup", [artistBox("Dup", "dup", [ytLink(CH(1))])], 0);
    await follow(env, "gone", "Gone", [artistBox("Gone", "gone", [ytLink(CH(2))])], 1);
    await follow(env, "flaky", "Flaky", [artistBox("Flaky", "flaky", [ytLink(CH(3))])], 2);
    const yt = fakeYouTube({
      insert: (ch) =>
        ch === CH(1)
          ? ytError(400, "subscriptionDuplicate")
          : ch === CH(2)
            ? ytError(404, "publisherNotFound")
            : ch === CH(3)
              ? ytError(500, "backendError")
              : null,
    });
    const r = await runYtSubs(env, { log, fetcher: yt.fetcher, nowSec: 1000 });
    expect(r).toMatchObject({ owner: 1, notFound: 1, failed: 1, subscribed: 0 });
    expect(await row(env, CH(1))).toMatchObject({ origin: "owner", state: "subscribed" });
    expect(await row(env, CH(2))).toMatchObject({ state: "not_found", next_at: 1000 + 7 * 86_400 });
    expect(await row(env, CH(3))).toMatchObject({
      state: "failed",
      attempts: 1,
      next_at: 1000 + 3600,
    });
    // Not due yet: nothing.
    expect(await ytSubsPendingCount(env, 1001)).toBe(0);
    // Failing until MAX_ATTEMPTS, then left alone.
    let t = 1000;
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      t += 3600 * i;
      await runYtSubs(env, { log, fetcher: yt.fetcher, nowSec: t });
    }
    expect(await row(env, CH(3))).toMatchObject({
      state: "failed",
      attempts: MAX_ATTEMPTS,
      next_at: null,
    });
    expect((await djYtSub(env, "flaky")).status).toBe("failed");
  });

  it("stops at a daily quota reply and leaves the rest queued", async () => {
    const env = makeEnv();
    await follow(env, "a", "A", [artistBox("A", "a", [ytLink(CH(1))])], 0);
    await follow(env, "b", "B", [artistBox("B", "b", [ytLink(CH(2))])], 1);
    const yt = fakeYouTube({ insert: () => ytError(403, "quotaExceeded") });
    const r = await runYtSubs(env, { log, fetcher: yt.fetcher, nowSec: 1000 });
    expect(r).toMatchObject({ ok: true, stoppedBy: "quota", subscribed: 0, pending: 2 });
    expect(yt.calls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
    expect(await row(env, CH(1))).toBeNull();
    expect(await ytSubsPendingCount(env, 1001)).toBe(2);
  });

  it("an unsubscribe that is already gone is done; one that fails is tried again", async () => {
    const env = makeEnv();
    await follow(env, "a", "A", [artistBox("A", "a", [ytLink(CH(1))])], 0);
    await follow(env, "b", "B", [artistBox("B", "b", [ytLink(CH(2))])], 1);
    await follow(env, "c", "C", null, 2);
    const yt = fakeYouTube({
      del: (id) =>
        id === "sub1" ? ytError(404, "subscriptionNotFound") : ytError(503, "backendError"),
    });
    await runYtSubs(env, { log, fetcher: yt.fetcher, nowSec: 1000 });
    await env.DB.prepare("DELETE FROM subscriptions WHERE slug IN ('a', 'b')").run();
    const r = await runYtSubs(env, { log, fetcher: yt.fetcher, nowSec: 1001 });
    expect(r).toMatchObject({ unsubscribed: 1, failed: 1 });
    expect(await row(env, CH(1))).toMatchObject({ state: "unsubscribed" });
    expect(await row(env, CH(2))).toMatchObject({
      origin: "tracked",
      state: "subscribed",
      attempts: 1,
    });
    expect(await ytSubsPendingCount(env, 1002)).toBe(0);
    expect(await ytSubsPendingCount(env, 1001 + 3600)).toBe(1);
  });

  it("holds to the per-run cap, unsubscribes first", async () => {
    const env = makeEnv();
    await updateAppSettings(env, { ytSubs: { maxChangesPerRun: 2 } });
    for (let i = 1; i <= 4; i++)
      await follow(env, `d${i}`, `D${i}`, [artistBox(`D${i}`, `d${i}`, [ytLink(CH(i))])], i);
    const yt = fakeYouTube({});
    expect(await runYtSubs(env, { log, fetcher: yt.fetcher, nowSec: 1000 })).toMatchObject({
      subscribed: 2,
      stoppedBy: "run",
      pending: 2,
    });
    expect(mk(quotaGate).mock.calls[0]![2]).toBe(101);
    await env.DB.prepare("DELETE FROM subscriptions WHERE slug = 'd1'").run();
    const r = await runYtSubs(env, { log, fetcher: yt.fetcher, nowSec: 1001 });
    expect(r).toMatchObject({ unsubscribed: 1, subscribed: 1 });
  });

  it("waits for the gate, records not connected and a refused grant", async () => {
    const env = makeEnv();
    await follow(env, "a", "A", [artistBox("A", "a", [ytLink(CH(1))])]);
    const yt = fakeYouTube({});
    mk(quotaGate).mockResolvedValueOnce({ ok: false, reason: "held" });
    expect(await runYtSubs(env, { log, fetcher: yt.fetcher })).toMatchObject({
      stoppedBy: "held",
      held: "held",
    });
    expect(yt.calls).toEqual([]);
    expect((await ytSubsSummary(env)).needsReconnect).toBe(false);

    mk(getAccessToken).mockResolvedValueOnce(null);
    expect(await runYtSubs(env, { log, fetcher: yt.fetcher })).toMatchObject({
      stoppedBy: "not_connected",
    });
    expect((await ytSubsSummary(env)).needsReconnect).toBe(true);

    mk(getAccessToken).mockRejectedValueOnce(
      new GoogleOAuthRefreshFailed(400, JSON.stringify({ error: "invalid_grant" })),
    );
    expect(await runYtSubs(env, { log, fetcher: yt.fetcher })).toMatchObject({ stoppedBy: "auth" });
    expect((await ytSubsSummary(env)).needsReconnect).toBe(true);

    // A 401 that outlived the retries is tried again, not red.
    const flaky = fakeYouTube({ list: () => ytError(401, "authError") });
    expect(await runYtSubs(env, { log, fetcher: flaky.fetcher })).toMatchObject({
      stoppedBy: "auth",
    });
    expect((await ytSubsSummary(env)).needsReconnect).toBe(false);
  });

  it("does nothing on YouTube while switched off", async () => {
    const env = makeEnv();
    await updateAppSettings(env, { ytSubs: { enabled: false } });
    await follow(env, "a", "A", [artistBox("A", "a", [ytLink(CH(1))])]);
    const yt = fakeYouTube({});
    expect(await runYtSubs(env, { log, fetcher: yt.fetcher })).toMatchObject({ stoppedBy: "off" });
    expect(yt.calls).toEqual([]);
    expect((await djYtSub(env, "a")).status).toBe("off");
    expect((await waitingDemand(env)).yt_subscriptions).toBe(0);
  });

  it("one run at a time; the cron step skips an empty pool and survives a throw", async () => {
    const env = makeEnv();
    await env.CACHE.put("ytsubs:lock", "other");
    expect(await runYtSubs(env, { log })).toEqual({ ok: false, reason: "busy" });
    await env.CACHE.delete("ytsubs:lock");
    await env.CACHE.put("yt:quota:out", JSON.stringify({ since: 0, until: 9e12 }));
    expect(await ytSubsCronStep(env, log, "test")).toEqual({
      ok: false,
      reason: "youtube_quota_out",
    });
    const broken = {
      ...makeEnv(),
      DB: {
        prepare: () => {
          throw new Error("d1 down");
        },
      },
    } as unknown as Env;
    expect(await ytSubsCronStep(broken, log, "test")).toEqual({ ok: false, reason: "threw" });
  });

  it("saves how it ended for the pages", async () => {
    const env = makeEnv();
    await follow(env, "a", "A", [artistBox("A", "a", [ytLink(CH(1))])]);
    await runYtSubs(env, { log, fetcher: fakeYouTube({}).fetcher, trigger: "cron.tick" });
    expect(await env.CACHE.get(LAST_RUN_KEY, "json")).toMatchObject({
      trigger: "cron.tick",
      subscribed: 1,
      stoppedBy: null,
    });
  });
});

describe("the quota consumer", () => {
  it("ranks second by default and lands second in a stored order that lacks it", async () => {
    expect(DEFAULT_APP_SETTINGS.quota.order.indexOf("yt_subscriptions")).toBe(1);
    const SUBS = fakeKV({
      "app:settings": JSON.stringify({
        quota: {
          order: [
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
          ],
        },
      }),
    });
    const s = await getAppSettings({ SUBS });
    expect(s.quota.order.slice(0, 3)).toEqual(["likes", "yt_subscriptions", "presave_playlists"]);
    expect(s.quota.consumers.yt_subscriptions).toEqual({
      min: null,
      max: DEFAULT_YT_SUBS_DAILY_UNITS,
      enabled: true,
    });
    expect(s.ytSubs).toEqual({ enabled: true, maxChangesPerRun: 10 });
  });

  it("counts what waits at 50 units a change", async () => {
    const env = makeEnv();
    await follow(env, "a", "A", [artistBox("A", "a", [ytLink(CH(1))])]);
    await follow(env, "b", "B", [artistBox("B", "b", [ytLink(CH(2))])]);
    await resolveDue(env);
    expect((await waitingDemand(env)).yt_subscriptions).toBe(100);
  });
});

describe("the pages", () => {
  const req = (env: Env, path: string) =>
    app.request(`https://tracked.example${path}`, undefined, {
      ...env,
      DEV_BYPASS_CF_ACCESS: "1",
    } as Env);

  it("the DJs table has each DJ's subscription status, and the payload the feature's state", async () => {
    const env = makeEnv();
    await follow(env, "subd", "Subd", [artistBox("Subd", "subd", [ytLink(CH(1))])], 0);
    await follow(env, "own", "Own", [artistBox("Own", "own", [ytLink(CH(2))])], 1);
    await follow(env, "none", "None", [artistBox("None", "none", [])], 2);
    await follow(env, "new", "New", null, 3);
    await runYtSubs(env, { log, fetcher: fakeYouTube({ have: { [CH(2)]: "x" } }).fetcher });
    await env.DB.prepare("DELETE FROM dj_youtube_channels WHERE slug = 'new'").run();
    await follow(env, "later", "Later", [artistBox("Later", "later", [ytLink(CH(3))])], 4);
    await resolveDjChannel(env, "later", "Later");
    const res = await runTableQuery(
      env.DB,
      DJS_TABLE,
      parseTableQuery(new URLSearchParams(), DJS_TABLE),
    );
    const by = Object.fromEntries(res.rows.map((r) => [r.slug, r]));
    expect(by.subd).toMatchObject({
      ytSub: "subscribed",
      ytChannelUrl: `https://www.youtube.com/channel/${CH(1)}`,
    });
    expect(by.own!.ytSub).toBe("owner");
    expect(by.none).toMatchObject({ ytSub: "no_channel", ytReason: "no_youtube_link" });
    expect(by.new!.ytSub).toBe("looking");
    expect(by.later!.ytSub).toBe("pending");
    const filtered = await runTableQuery(
      env.DB,
      DJS_TABLE,
      parseTableQuery(new URLSearchParams({ sort: "ytSub" }), DJS_TABLE),
    );
    expect(filtered.rows).toHaveLength(5);

    const api = await req(env, "/ui/api/djs");
    expect(api.status).toBe(200);
    const body = (await api.json()) as { ytSubs: { enabled: boolean; needsReconnect: boolean } };
    expect(body.ytSubs).toMatchObject({ enabled: true, needsReconnect: false });
  });

  it("the DJ page's endpoint answers one DJ", async () => {
    const env = makeEnv();
    await follow(env, "dj", "DJ", [artistBox("DJ", "dj", [ytLink(CH(1)), ytLink(CH(2))])]);
    await resolveDue(env);
    const res = await req(env, "/ui/api/dj/dj/youtube-sub");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "pending",
      channelId: CH(1),
      candidates: [CH(1), CH(2)],
      enabled: true,
      needsReconnect: false,
    });
    expect((await req(env, "/ui/api/dj/bad%20slug!/youtube-sub")).status).toBe(400);
  });

  it("the pages carry the badge and the Settings toggle", async () => {
    const env = makeEnv();
    const djs = await (await req(env, "/ui/djs")).text();
    expect(djs).toContain("YTS.badge");
    const dj = await (await req(env, "/ui/dj/x")).text();
    expect(dj).toContain("dj-ytsub");
    const settings = await (await req(env, "/ui/settings")).text();
    expect(settings).toContain("ytSubs.enabled");
  });
});
