import { describe, it, expect, vi } from "vitest";
import { fakeD1 } from "./helpers/fake-d1";
import { fakeKV } from "./helpers/fake-kv";
import type { Env } from "../src/types";
import { makeLogger } from "../src/lib/log";
import {
  bannedChannelIds,
  channelBanPayload,
  channelStrikes,
  decideBan,
  listBanQueue,
  pendingBanCount,
  processBanQueue,
} from "../src/lib/channel-bans";
import { recordRemoved } from "../src/lib/playlist-blocklist";
import { saveVideoChannels } from "../src/lib/video-meta";
import type { PushPayload } from "../src/lib/web-push";

const log = makeLogger({ task: "test" });
const NOW = 1_800_000_000;
const PL = "PLartist";
const PLC = "PLcombined";

function makeEnv(): Env {
  return { CACHE: fakeKV(), SUBS: fakeKV(), DB: fakeD1(), API_TOKEN: "t" } as unknown as Env;
}

/** An owner removal of `videoId` (uploaded by `channel`, when given) at `at`. */
async function removed(
  env: Env,
  videoId: string,
  opts: { channel?: string; at?: number; reason?: "owner" | "button" | "dead"; pl?: string } = {},
) {
  await recordRemoved(env, {
    playlistId: opts.pl ?? PL,
    videoId,
    slug: "dj",
    setUrl: `https://www.1001tracklists.com/tracklist/${videoId}/x.html`,
    reason: opts.reason ?? "owner",
    at: opts.at ?? NOW - 100,
    channelId: opts.channel ?? null,
    channelTitle: opts.channel ? `Title ${opts.channel}` : null,
  });
}

async function state(env: Env, channelId: string) {
  return env.DB.prepare("SELECT * FROM channel_bans WHERE channel_id = ?")
    .bind(channelId)
    .first<Record<string, any>>();
}

function notifier(answer = true) {
  const sent: PushPayload[] = [];
  return {
    sent,
    fn: vi.fn(async (p: PushPayload) => {
      sent.push(p);
      return answer;
    }),
  };
}

describe("processBanQueue", () => {
  it("an owner removal opens one question per channel, counted in distinct videos, pushed once", async () => {
    const env = makeEnv();
    await removed(env, "fan00000001", { channel: "UCfan" });
    // The same video out of the combined playlist too: still one strike.
    await removed(env, "fan00000001", { channel: "UCfan", pl: PLC });
    const n = notifier();
    const r = await processBanQueue(env, { log, notify: n.fn, now: NOW });
    expect(r).toMatchObject({ asked: 1, updated: 0, notified: true });
    expect(await state(env, "UCfan")).toMatchObject({
      state: "pending",
      strikes: 1,
      channel_title: "Title UCfan",
      last_video_id: "fan00000001",
      asked_at: NOW,
      notified: 1,
    });
    expect(n.sent[0]).toMatchObject({
      kind: "channel_ban",
      title: "Ban Title UCfan?",
      url: "/ui/bans",
      icon: "https://i.ytimg.com/vi/fan00000001/hqdefault.jpg",
    });
    expect(n.sent[0]!.body).toContain("1 video removed");
    // Nothing new: no second push, no second question.
    const again = await processBanQueue(env, { log, notify: n.fn, now: NOW + 60 });
    expect(again).toMatchObject({ asked: 0, updated: 0, notified: null });
    expect(n.fn).toHaveBeenCalledTimes(1);
    expect(await pendingBanCount(env)).toBe(1);
  });

  it("a push no device took is tried again on the next run", async () => {
    const env = makeEnv();
    await removed(env, "fan00000001", { channel: "UCfan" });
    await processBanQueue(env, { log, notify: notifier(false).fn, now: NOW });
    expect((await state(env, "UCfan"))!.notified).toBe(0);
    const ok = notifier(true);
    expect((await processBanQueue(env, { log, notify: ok.fn, now: NOW + 1 })).notified).toBe(true);
    expect((await state(env, "UCfan"))!.notified).toBe(1);
  });

  it("a further removal while the question is open updates its strikes and is not pushed again", async () => {
    const env = makeEnv();
    const n = notifier();
    await removed(env, "fan00000001", { channel: "UCfan", at: NOW - 200 });
    await processBanQueue(env, { log, notify: n.fn, now: NOW });
    await removed(env, "fan00000002", { channel: "UCfan", at: NOW + 10 });
    const r = await processBanQueue(env, { log, notify: n.fn, now: NOW + 20 });
    expect(r).toMatchObject({ asked: 0, updated: 1 });
    expect(await state(env, "UCfan")).toMatchObject({
      strikes: 2,
      last_video_id: "fan00000002",
      notified: 1,
    });
    expect(n.fn).toHaveBeenCalledTimes(1);
  });

  it("Not banned is not asked again until a removal after the answer, which asks with the strike count", async () => {
    const env = makeEnv();
    await removed(env, "fan00000001", { channel: "UCfan", at: NOW - 200 });
    await processBanQueue(env, { log, now: NOW });
    expect(await decideBan(env, "UCfan", "decline", NOW + 5)).toEqual({
      ok: true,
      state: "declined",
    });
    // An older removal whose channel only became known now does not reopen it.
    await removed(env, "fan00000003", { at: NOW - 50 });
    await saveVideoChannels(env, [
      { videoId: "fan00000003", channelId: "UCfan", channelTitle: "Fan" },
    ]);
    expect((await processBanQueue(env, { log, now: NOW + 6 })).asked).toBe(0);
    expect((await state(env, "UCfan"))!.state).toBe("declined");

    await removed(env, "fan00000002", { channel: "UCfan", at: NOW + 100 });
    const n = notifier();
    expect((await processBanQueue(env, { log, notify: n.fn, now: NOW + 200 })).asked).toBe(1);
    expect(await state(env, "UCfan")).toMatchObject({
      state: "pending",
      strikes: 3,
      asked_at: NOW + 200,
    });
    expect(n.sent[0]!.body).toContain("3 videos removed");
  });

  it("never asks about a banned channel, a dead video, or one of mkvid's own renders", async () => {
    const env = makeEnv();
    await removed(env, "fan00000001", { channel: "UCfan" });
    await processBanQueue(env, { log, now: NOW });
    await decideBan(env, "UCfan", "ban", NOW + 1);
    await removed(env, "fan00000002", { channel: "UCfan", at: NOW + 5 });
    await removed(env, "dead0000001", { channel: "UCdead", reason: "dead" });
    await env.DB.prepare(
      "INSERT INTO mkvid_requests (set_url, slug, artist_name, source, source_url, status, created_at, updated_at, video_id) VALUES ('u', 'dj', 'DJ', 'soundcloud', 's', 'done', 0, 0, 'mine0000001')",
    ).run();
    await removed(env, "mine0000001", { channel: "UCowner" });
    const r = await processBanQueue(env, { log, now: NOW + 10 });
    expect(r.asked).toBe(0);
    expect((await state(env, "UCfan"))!.state).toBe("banned");
    expect(await state(env, "UCdead")).toBeNull();
    expect(await state(env, "UCowner")).toBeNull();
    const left = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM removed_videos WHERE ban_noted = 0",
    ).first<{ n: number }>();
    expect(left!.n).toBe(0);
  });

  it("past removals get their channel from video_meta, or one videos.list call for at most 50 of them", async () => {
    const env = makeEnv();
    await removed(env, "old00000001");
    await removed(env, "old00000002");
    await saveVideoChannels(env, [{ videoId: "old00000001", channelId: "UCa", channelTitle: "A" }]);
    const calls: URL[] = [];
    const fetcher = vi.fn(async (u: RequestInfo | URL) => {
      const url = new URL(String(u));
      calls.push(url);
      const ids = url.searchParams.get("id")!.split(",");
      return Response.json({
        items: ids.map((id) => ({
          id,
          contentDetails: { duration: "PT1H" },
          player: { embedWidth: 1280, embedHeight: 720 },
          status: { uploadStatus: "processed" },
          snippet: { channelId: "UCb", channelTitle: "B" },
        })),
      });
    }) as unknown as typeof fetch;
    const r = await processBanQueue(env, { log, accessToken: "tok", fetcher, now: NOW });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.searchParams.get("id")).toBe("old00000002");
    expect(r).toMatchObject({ lookedUp: 1, asked: 2 });
    expect((await state(env, "UCa"))!.state).toBe("pending");
    expect((await state(env, "UCb"))!.state).toBe("pending");
    // Looked up already: not again.
    await processBanQueue(env, { log, accessToken: "tok", fetcher, now: NOW + 60 });
    expect(calls).toHaveLength(1);
  });

  it("a removed video YouTube no longer returns is not looked up again for a week", async () => {
    const env = makeEnv();
    await removed(env, "gone0000001");
    const fetcher = vi.fn(async () => Response.json({ items: [] })) as unknown as typeof fetch;
    await processBanQueue(env, { log, accessToken: "tok", fetcher, now: NOW });
    await processBanQueue(env, { log, accessToken: "tok", fetcher, now: NOW + 86400 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await processBanQueue(env, { log, accessToken: "tok", fetcher, now: NOW + 8 * 86400 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("decideBan", () => {
  it("bans from pending, declined or lifted; lifts only a ban; declines only a question", async () => {
    const env = makeEnv();
    expect(await decideBan(env, "UCnone", "ban")).toEqual({ ok: false, error: "not_found" });
    await removed(env, "fan00000001", { channel: "UCfan" });
    await processBanQueue(env, { log, now: NOW });
    expect(await decideBan(env, "UCfan", "lift")).toEqual({ ok: false, error: "invalid_state" });
    expect(await decideBan(env, "UCfan", "ban", NOW + 1)).toEqual({ ok: true, state: "banned" });
    expect(await bannedChannelIds(env)).toEqual(new Set(["UCfan"]));
    expect(await decideBan(env, "UCfan", "ban")).toEqual({ ok: true, state: "banned" });
    expect(await decideBan(env, "UCfan", "decline")).toEqual({
      ok: false,
      error: "invalid_state",
    });
    expect(await decideBan(env, "UCfan", "lift", NOW + 2)).toEqual({ ok: true, state: "lifted" });
    expect(await bannedChannelIds(env)).toEqual(new Set());
    expect(await decideBan(env, "UCfan", "ban", NOW + 3)).toEqual({ ok: true, state: "banned" });
    expect((await state(env, "UCfan"))!.decided_at).toBe(NOW + 3);
  });
});

describe("channelStrikes", () => {
  it("counts distinct owner and button removals; dead ones and other channels do not count", async () => {
    const env = makeEnv();
    await removed(env, "a0000000001", { channel: "UCx" });
    await removed(env, "a0000000001", { channel: "UCx", pl: PLC });
    await removed(env, "a0000000002", { channel: "UCx", reason: "button" });
    await removed(env, "a0000000003", { channel: "UCx", reason: "dead" });
    await removed(env, "a0000000004", { channel: "UCy" });
    expect(await channelStrikes(env, ["UCx", "UCy", "UCz"])).toEqual(
      new Map([
        ["UCx", 2],
        ["UCy", 1],
      ]),
    );
  });
});

describe("listBanQueue", () => {
  it("lists open questions with what was removed and the channel's videos still in the playlists, then decided channels", async () => {
    const env = makeEnv();
    await env.DB.prepare(
      "INSERT INTO sub_sync (slug, playlist_id, artist_name) VALUES ('dj', ?, 'DJ')",
    )
      .bind(PL)
      .run();
    await env.DB.prepare(
      "INSERT INTO tracklists (slug, url, position, discovered_at, processed, video_known, video_id, video_source, checked_at) VALUES ('dj', 'https://www.1001tracklists.com/tracklist/k/x.html', 0, 0, 1, 1, 'fan00000009', '1001tl', 1)",
    ).run();
    await saveVideoChannels(env, [
      { videoId: "fan00000009", channelId: "UCfan", channelTitle: "Fan" },
    ]);
    await removed(env, "fan00000001", { channel: "UCfan" });
    await removed(env, "oth00000001", { channel: "UCother" });
    await processBanQueue(env, { log, now: NOW });
    await decideBan(env, "UCother", "decline", NOW + 1);
    const q = await listBanQueue(env);
    expect(q.pending.map((p) => p.channelId)).toEqual(["UCfan"]);
    expect(q.pending[0]).toMatchObject({
      channelTitle: "Title UCfan",
      strikes: 1,
      removed: [{ videoId: "fan00000001", slug: "dj" }],
      inPlaylists: [
        {
          videoId: "fan00000009",
          slug: "dj",
          setUrl: "https://www.1001tracklists.com/tracklist/k/x.html",
          playlistId: PL,
        },
      ],
    });
    expect(q.decided).toMatchObject([
      { channelId: "UCother", state: "declined", decidedAt: NOW + 1 },
    ]);
  });
});

describe("channelBanPayload", () => {
  it("names one channel, or lists several in one push", () => {
    const one = channelBanPayload(
      [{ channel_id: "UC1", channel_title: "Fan Cam", strikes: 2, last_video_id: null }],
      new Date(0),
    );
    expect(one).toMatchObject({ title: "Ban Fan Cam?", tag: "channel-ban" });
    expect(one.body).toBe(
      "You removed a video by Fan Cam (2 videos removed so far). Ban the channel, or keep it?",
    );
    expect(one.icon).toBeUndefined();
    const many = channelBanPayload(
      Array.from({ length: 7 }, (_, i) => ({
        channel_id: `UC${i}`,
        channel_title: i === 0 ? null : `C${i}`,
        strikes: 1,
        last_video_id: "v0000000001",
      })),
    );
    expect(many.title).toBe("Ban 7 channels?");
    expect(many.body).toBe(
      "UC0 (1 video removed), C1 (1 video removed), C2 (1 video removed), C3 (1 video removed), C4 (1 video removed), and 2 more",
    );
  });
});
