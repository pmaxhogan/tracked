/**
 * Likes for pre-saved tracks (lib/presave-like.ts): the hook on each of the
 * three ways a pre-save gets its video (and on a restore), that nobody waits
 * for it, that the rating is read first and a like is made once, what a like
 * that is not made leaves behind and when it is tried again, the daily
 * budget, and the backfill's selection, dry run and live page. tlpool and YouTube are a stubbed global
 * fetch; D1 and KV are the in-memory fakes with the real migrations.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { fakeKV } from "./helpers/fake-kv";
import { fakeD1 } from "./helpers/fake-d1";
import type { Env } from "../src/types";
import {
  addPresave,
  dismissPresave,
  getPresaveRow,
  markPresaveUploaded,
  presaveOut,
  recheckPresave,
  restorePresave,
  runScheduledPresave,
} from "../src/lib/presave";
import {
  backfillPresaveLikes,
  drainPresaveLikes,
  likeErrorLine,
  likeFailKind,
  likePresaveVideo,
  likeRetryAt,
  likeUnitsSpent,
  retryDuePresaveLikes,
} from "../src/lib/presave-like";
import { YouTubeApiError } from "../src/lib/youtube-playlists";
import { clearQuotaOut, getQuotaOut, QUOTA_OUT_KEY } from "../src/lib/youtube-quota";
import { quotaDayEnd } from "../src/lib/mkvid";
import { DEFAULT_APP_SETTINGS, updateAppSettings } from "../src/lib/app-settings";
import { makeLogger } from "../src/lib/log";
import { app } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const POOL = "https://tlpool.example";
const ML_FOUND = readFileSync(resolve(here, "fixtures", "medialink-909720.json"), "utf8");
const ML_NO_YT = JSON.stringify({ ...JSON.parse(ML_FOUND), more: [] });
const VIDEO = "h8CtvP1rEy8";
const NOW = Date.UTC(2026, 9, 11, 18, 0, 0);
const log = makeLogger({ test: "presave-like" });

async function makeEnv(opts: { connected?: boolean } = {}): Promise<Env> {
  const env = {
    CACHE: fakeKV(),
    DB: fakeD1(),
    SUBS: fakeKV(),
    API_TOKEN: "t",
    YOUTUBE_API_KEY: "k",
    TLPOOL_URL: POOL,
    TLPOOL_TOKEN: "pt",
    DEV_BYPASS_CF_ACCESS: "1",
  } as unknown as Env;
  if (opts.connected !== false) {
    await env.SUBS.put(
      "oauth:google",
      JSON.stringify({
        accessToken: "tok",
        refreshToken: "r",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        scope: "https://www.googleapis.com/auth/youtube",
        channelId: null,
        channelTitle: null,
        connectedAt: 0,
      }),
    );
  }
  return env;
}

/** A YouTube error reply as Google sends it: a message (with markup, for the quota one) and the reason. */
const ytError = (
  status: number,
  reason: string,
  message = reason === "quotaExceeded"
    ? 'The request cannot be completed because you have exceeded your <a href="/youtube/v3/getting-started#quota">quota</a>.'
    : `Refused <b>because</b> of ${reason}.`,
) =>
  new Response(
    JSON.stringify({
      error: { code: status, message, errors: [{ message, domain: "youtube.video", reason }] },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );

type Yt = { rate: string[]; getRating: string[][] };
/**
 * tlpool answers every lookup with `medialink()`; YouTube's videos.rate with
 * `rate(videoId)` (default 204) and videos.getRating with `ratings`.
 */
function stub(
  o: {
    medialink?: () => string;
    rate?: (id: string) => Response;
    ratings?: Record<string, string> | (() => Response);
  } = {},
): Yt {
  const yt: Yt = { rate: [], getRating: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${POOL}/fetch`) {
        const body = JSON.parse(String(init!.body)) as { url: string };
        const html = (o.medialink ?? (() => ML_FOUND))();
        return Response.json({
          status: 200,
          finalUrl: body.url,
          html,
          accountId: "acct-1",
          exitLabel: "exit-a",
          fetchedAt: new Date().toISOString(),
          bytes: html.length,
        });
      }
      const u = new URL(url);
      if (u.pathname === "/youtube/v3/videos/rate") {
        expect(init?.method).toBe("POST");
        expect(u.searchParams.get("rating")).toBe("like");
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer tok");
        const id = u.searchParams.get("id")!;
        yt.rate.push(id);
        return o.rate ? o.rate(id) : new Response(null, { status: 204 });
      }
      if (u.pathname === "/youtube/v3/videos/getRating") {
        const ids = u.searchParams.get("id")!.split(",");
        yt.getRating.push(ids);
        if (typeof o.ratings === "function") return o.ratings();
        const r = o.ratings ?? {};
        return Response.json({
          items: ids.filter((id) => r[id]).map((id) => ({ videoId: id, rating: r[id] })),
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
  return yt;
}

/** A pre-save that already has its video, as one resolved before the likes existed. */
async function seedResolved(
  env: Env,
  trackId: string,
  videoId: string,
  stage: "found" | "uploaded" | "dismissed" = "found",
): Promise<number> {
  const r = await env.DB.prepare(
    "INSERT INTO presaves (track_id, artist, title, stage, youtube_video_id, created_at, updated_at) VALUES (?, 'A', ?, ?, ?, 1, 1)",
  )
    .bind(trackId, `T${trackId}`, stage, videoId)
    .run();
  return Number(r.meta.last_row_id);
}
const likeCols = async (env: Env, id: number) =>
  (await env.DB.prepare(
    "SELECT liked_at, like_attempts, like_error, like_next_at, like_claimed_at FROM presaves WHERE id = ?",
  )
    .bind(id)
    .first<Record<string, unknown>>())!;

afterEach(async () => {
  await drainPresaveLikes();
  vi.unstubAllGlobals();
});

describe("the hook: a pre-save that gets its video is liked, in the background", () => {
  it("found at once, by the check that runs on save: the like is due when the save answers and made once drained", async () => {
    const env = await makeEnv();
    const yt = stub();
    const r = await addPresave(env, { trackId: "909720" }, "tasker", { now: NOW });
    expect(r.presave).toMatchObject({
      stage: "found",
      youtube_video_id: VIDEO,
      liked_at: null,
      like_next_at: NOW,
    });
    expect(presaveOut(r.presave, DEFAULT_APP_SETTINGS)).toMatchObject({
      likedAt: null,
      likeError: null,
      likeNextAt: NOW,
    });
    await drainPresaveLikes();
    expect(await likeCols(env, r.presave.id)).toEqual({
      liked_at: NOW,
      like_attempts: 1,
      like_error: null,
      like_next_at: null,
      like_claimed_at: null,
    });
    expect(yt.getRating).toEqual([[VIDEO]]);
    expect(yt.rate).toEqual([VIDEO]);
    expect(await likeUnitsSpent(env, NOW)).toBe(51);
  });

  it("the save does not wait for YouTube", async () => {
    const env = await makeEnv();
    const yt = stub();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (i: RequestInfo | URL, init?: RequestInit) => {
        if (String(i).includes("googleapis.com")) await gate;
        return real(i, init);
      }),
    );
    const r = await addPresave(env, { trackId: "909720" }, "tasker", { now: NOW });
    expect(r.presave).toMatchObject({ stage: "found", liked_at: null });
    expect(yt.rate).toEqual([]);
    release();
    await drainPresaveLikes();
    expect(yt.rate).toEqual([VIDEO]);
  });

  it("found later, by a scheduled check", async () => {
    const env = await makeEnv();
    let found = false;
    const yt = stub({ medialink: () => (found ? ML_FOUND : ML_NO_YT) });
    const added = await addPresave(env, { trackId: "909720" }, "ui", { now: NOW });
    await drainPresaveLikes();
    expect(added.presave).toMatchObject({
      stage: "links",
      liked_at: null,
      like_attempts: 0,
      like_next_at: null,
    });
    expect(yt.rate).toEqual([]);
    found = true;
    const later = added.presave.next_check_at! + 1;
    expect(await runScheduledPresave(env, added.presave.id, log, later)).toEqual({ outcome: "ok" });
    await drainPresaveLikes();
    expect(await getPresaveRow(env, added.presave.id)).toMatchObject({
      stage: "found",
      youtube_video_id: VIDEO,
      liked_at: later,
    });
    expect(yt.rate).toEqual([VIDEO]);
  });

  it("uploaded by mkvid: the upload is the video that is liked", async () => {
    const env = await makeEnv();
    const yt = stub({ medialink: () => ML_NO_YT });
    const added = await addPresave(env, { trackId: "909720" }, "ui", { now: NOW });
    const p = await markPresaveUploaded(
      env,
      added.presave.id,
      "UPLOADED001",
      { uploadId: 1 },
      NOW + 5,
    );
    expect(p).toMatchObject({
      stage: "uploaded",
      youtube_video_id: "UPLOADED001",
      like_next_at: NOW + 5,
    });
    await drainPresaveLikes();
    expect(await likeCols(env, added.presave.id)).toMatchObject({ liked_at: NOW + 5 });
    expect(yt.rate).toEqual(["UPLOADED001"]);
  });

  it("an upload that lands on a pre-save 1001tracklists already found likes nothing more", async () => {
    const env = await makeEnv();
    const yt = stub();
    const added = await addPresave(env, { trackId: "909720" }, "ui", { now: NOW });
    await drainPresaveLikes();
    const p = await markPresaveUploaded(env, added.presave.id, "UPLOADED001", undefined, NOW + 5);
    await drainPresaveLikes();
    expect(p).toMatchObject({ stage: "found", youtube_video_id: VIDEO, liked_at: NOW });
    expect(yt.rate).toEqual([VIDEO]);
  });

  it("a pre-save whose video changes is liked again for the new one; the old like is not taken back", async () => {
    const env = await makeEnv();
    const id = await seedResolved(env, "1", "VIDEOOLDDD1", "uploaded");
    await env.DB.prepare("UPDATE presaves SET liked_at = 5, like_attempts = 1 WHERE id = ?")
      .bind(id)
      .run();
    const yt = stub();
    const p = await markPresaveUploaded(env, id, "VIDEONEWWW2", undefined, NOW);
    expect(p).toMatchObject({
      youtube_video_id: "VIDEONEWWW2",
      liked_at: null,
      like_attempts: 0,
      like_next_at: NOW,
    });
    await drainPresaveLikes();
    expect(await likeCols(env, id)).toMatchObject({ liked_at: NOW, like_attempts: 1 });
    expect(yt.rate).toEqual(["VIDEONEWWW2"]);
  });

  it("restoring a dismissed pre-save that has its video makes the like due", async () => {
    const env = await makeEnv();
    const id = await seedResolved(env, "1", "VIDEOAAAAA1", "dismissed");
    await env.DB.prepare("UPDATE presaves SET found_at = 2, dismissed_at = 3 WHERE id = ?")
      .bind(id)
      .run();
    const yt = stub();
    expect(await restorePresave(env, id, NOW)).toMatchObject({
      stage: "found",
      liked_at: null,
      like_next_at: NOW,
    });
    await drainPresaveLikes();
    expect(await likeCols(env, id)).toMatchObject({ liked_at: NOW });
    expect(yt.rate).toEqual(["VIDEOAAAAA1"]);
  });

  it("likes once: a second call, and a recheck or another save of a found pre-save, rate nothing", async () => {
    const env = await makeEnv();
    const yt = stub();
    const { presave } = await addPresave(env, { trackId: "909720" }, "ui", { now: NOW });
    await drainPresaveLikes();
    expect(await likePresaveVideo(env, presave.id, { now: NOW + 1 })).toMatchObject({
      outcome: "skipped",
      videoId: VIDEO,
    });
    await recheckPresave(env, presave.id, "manual", { now: NOW + 2 });
    await addPresave(env, { trackId: "909720" }, "tasker", { now: NOW + 3 });
    await drainPresaveLikes();
    expect(yt.rate).toEqual([VIDEO]);
    expect(yt.getRating).toHaveLength(1);
    expect(await likeCols(env, presave.id)).toMatchObject({ liked_at: NOW, like_attempts: 1 });
  });

  it("a try another run holds is not made twice, by a retry or by the backfill; a stale hold is taken over", async () => {
    const env = await makeEnv();
    const id = await seedResolved(env, "1", "VIDEOAAAAA1");
    await env.DB.prepare(
      "UPDATE presaves SET like_attempts = 1, like_next_at = ?, like_claimed_at = ? WHERE id = ?",
    )
      .bind(NOW - 5, NOW - 1000, id)
      .run();
    const yt = stub();
    expect(await likePresaveVideo(env, id, { now: NOW })).toMatchObject({ outcome: "skipped" });
    expect(await retryDuePresaveLikes(env, log, { now: NOW })).toEqual({
      tried: 0,
      liked: 0,
      stoppedBy: null,
    });
    expect(await backfillPresaveLikes(env, { dryRun: false }, { now: NOW })).toMatchObject({
      liked: 0,
      failed: 0,
      units: { rate: 0 },
      items: [{ id, action: "not_tried" }],
    });
    expect(yt.rate).toEqual([]);
    // 10 minutes on, the run that held it is gone.
    expect(await retryDuePresaveLikes(env, log, { now: NOW + 10 * 60_000 })).toEqual({
      tried: 1,
      liked: 1,
      stoppedBy: null,
    });
    expect(yt.rate).toEqual(["VIDEOAAAAA1"]);
  });

  it("a pre-save dismissed between the read and the claim is not liked", async () => {
    const env = await makeEnv();
    const id = await seedResolved(env, "1", "VIDEOAAAAA1");
    const yt = stub();
    // The budget lookup sits between the two: the owner dismisses it right then.
    const get = env.CACHE.get.bind(env.CACHE);
    (env.CACHE as unknown as { get: unknown }).get = async (...a: unknown[]) => {
      await env.DB.prepare("UPDATE presaves SET stage = 'dismissed' WHERE id = ?").bind(id).run();
      return (get as (...x: unknown[]) => unknown)(...a);
    };
    expect(await likePresaveVideo(env, id, { now: NOW, budgeted: true })).toMatchObject({
      outcome: "skipped",
    });
    expect(yt.getRating).toEqual([]);
    expect(yt.rate).toEqual([]);
    expect(await likeCols(env, id)).toMatchObject({ liked_at: null, like_attempts: 0 });
  });

  it("presave.likeOnYouTube off: found, not liked, nothing due", async () => {
    const env = await makeEnv();
    await updateAppSettings(env, { presave: { likeOnYouTube: false } });
    const yt = stub();
    const r = await addPresave(env, { trackId: "909720" }, "ui", { now: NOW });
    await drainPresaveLikes();
    expect(r.presave).toMatchObject({
      stage: "found",
      liked_at: null,
      like_attempts: 0,
      like_next_at: null,
    });
    expect(yt.rate).toEqual([]);
  });
});

describe("restoring a pre-save whose like ended for good", () => {
  const ended = async (env: Env, trackId: string, videoId: string, likeError: string) => {
    const id = await seedResolved(env, trackId, videoId, "dismissed");
    await env.DB.prepare(
      "UPDATE presaves SET found_at = 2, dismissed_at = 3, like_attempts = 3, like_error = ?, like_next_at = NULL WHERE id = ?",
    )
      .bind(likeError, id)
      .run();
    return id;
  };

  it("does not ask again about a video that was gone, has ratings disabled, needs a purchase or was rejected", async () => {
    const env = await makeEnv();
    const yt = stub();
    for (const [i, kind] of [
      "gone",
      "rating_disabled",
      "purchase_required",
      "rejected",
    ].entries()) {
      const id = await ended(
        env,
        String(i + 1),
        `VIDEOAAAAA${i}`,
        `${kind}: youtube videos.rate said so`,
      );
      expect(await restorePresave(env, id, NOW)).toMatchObject({
        stage: "found",
        liked_at: null,
        like_next_at: null,
        like_attempts: 3,
      });
      await drainPresaveLikes();
      expect((await likeCols(env, id)).like_error).toBe(`${kind}: youtube videos.rate said so`);
    }
    expect(await retryDuePresaveLikes(env, log, { now: NOW + 86400_000 })).toMatchObject({
      tried: 0,
    });
    expect(yt.getRating).toEqual([]);
    expect(yt.rate).toEqual([]);
  });

  it("reads a disliked one again: still disliked is left alone, a dislike taken back is liked", async () => {
    const env = await makeEnv();
    let yt = stub({ ratings: { VIDEOAAAAA1: "dislike" } });
    const id = await ended(env, "1", "VIDEOAAAAA1", "disliked: disliked on YouTube; left alone");
    expect(await restorePresave(env, id, NOW)).toMatchObject({ like_next_at: NOW });
    await drainPresaveLikes();
    expect(await likeCols(env, id)).toMatchObject({ liked_at: null, like_next_at: null });
    expect(yt.getRating).toHaveLength(1);
    expect(yt.rate).toEqual([]);
    await dismissPresave(env, id, NOW + 1);
    yt = stub({ ratings: { VIDEOAAAAA1: "none" } });
    await restorePresave(env, id, NOW + 2);
    await drainPresaveLikes();
    expect(await likeCols(env, id)).toMatchObject({ liked_at: NOW + 2, like_error: null });
    expect(yt.rate).toEqual(["VIDEOAAAAA1"]);
  });

  it("asks again about what the owner fixes on the account, and about a like that was only waiting", async () => {
    const env = await makeEnv();
    const yt = stub();
    const forbidden = await ended(env, "1", "VIDEOAAAAA1", "forbidden: youtube videos.rate 403");
    const waiting = await seedResolved(env, "2", "VIDEOBBBBB2", "dismissed");
    await env.DB.prepare(
      "UPDATE presaves SET found_at = 2, dismissed_at = 3, like_attempts = 2, like_error = 'gone: x', like_next_at = ? WHERE id = ?",
    )
      .bind(NOW + 60_000, waiting)
      .run();
    await restorePresave(env, forbidden, NOW);
    await restorePresave(env, waiting, NOW);
    await drainPresaveLikes();
    expect(await likeCols(env, forbidden)).toMatchObject({ liked_at: NOW });
    expect(await likeCols(env, waiting)).toMatchObject({ liked_at: NOW });
    expect(yt.rate.sort()).toEqual(["VIDEOAAAAA1", "VIDEOBBBBB2"]);
  });

  it("a video that was gone is asked about again once the pre-save has another video", async () => {
    const env = await makeEnv();
    const yt = stub({ medialink: () => ML_NO_YT });
    const added = await addPresave(env, { trackId: "909720" }, "ui", { now: NOW });
    await markPresaveUploaded(env, added.presave.id, "UPLOADED001", undefined, NOW);
    await drainPresaveLikes();
    await env.DB.prepare(
      "UPDATE presaves SET liked_at = NULL, like_attempts = 3, like_error = 'gone: x', like_next_at = NULL WHERE id = ?",
    )
      .bind(added.presave.id)
      .run();
    yt.rate.length = 0;
    await markPresaveUploaded(env, added.presave.id, "UPLOADED002", undefined, NOW + 1);
    await drainPresaveLikes();
    expect(await likeCols(env, added.presave.id)).toMatchObject({
      liked_at: NOW + 1,
      like_error: null,
    });
    expect(yt.rate).toEqual(["UPLOADED002"]);
  });
});

describe("the drain is bounded", () => {
  it("gives up on a like that never settles and drops it, so the next drain does not wait on it", async () => {
    const env = await makeEnv();
    // YouTube never answers, and the call is never cut off (a request ended in the middle of it).
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === `${POOL}/fetch`)
          return Response.json({
            status: 200,
            finalUrl: (JSON.parse(String(init!.body)) as { url: string }).url,
            html: ML_FOUND,
            accountId: "acct-1",
            exitLabel: "exit-a",
            fetchedAt: new Date().toISOString(),
            bytes: ML_FOUND.length,
          });
        return new Promise<Response>(() => {});
      }),
    );
    const r = await addPresave(env, { trackId: "909720" }, "tasker", { now: NOW });
    expect(r.presave).toMatchObject({ stage: "found", like_next_at: NOW });
    const t0 = Date.now();
    await drainPresaveLikes(40);
    expect(Date.now() - t0).toBeLessThan(5000);
    // Dropped: this one has nothing to wait for, whatever its limit.
    const t1 = Date.now();
    await drainPresaveLikes();
    expect(Date.now() - t1).toBeLessThan(1000);
    // The row is as the claim left it: stale after 10 minutes, then the cron's.
    expect(await likeCols(env, r.presave.id)).toMatchObject({
      liked_at: null,
      like_attempts: 1,
      like_claimed_at: NOW,
      like_next_at: NOW,
    });
    stub();
    expect(await retryDuePresaveLikes(env, log, { now: NOW + 5 * 60_000 })).toMatchObject({
      tried: 0,
    });
    expect(await retryDuePresaveLikes(env, log, { now: NOW + 11 * 60_000 })).toMatchObject({
      tried: 1,
      liked: 1,
    });
  });
});

describe("the rating is read first", () => {
  it("already liked: recorded, not rated again (1 unit)", async () => {
    const env = await makeEnv();
    const yt = stub({ ratings: { [VIDEO]: "like" } });
    const r = await addPresave(env, { trackId: "909720" }, "ui", { now: NOW });
    await drainPresaveLikes();
    expect(await likeCols(env, r.presave.id)).toMatchObject({
      liked_at: NOW,
      like_error: null,
      like_next_at: null,
    });
    expect(yt.rate).toEqual([]);
    expect(await likeUnitsSpent(env, NOW)).toBe(1);
  });

  it("disliked: left alone for good, the dislike is never flipped", async () => {
    const env = await makeEnv();
    const yt = stub({ ratings: { [VIDEO]: "dislike" } });
    const r = await addPresave(env, { trackId: "909720" }, "ui", { now: NOW });
    await drainPresaveLikes();
    expect(await likeCols(env, r.presave.id)).toEqual({
      liked_at: null,
      like_attempts: 1,
      like_error: "disliked: disliked on YouTube; left alone",
      like_next_at: null,
      like_claimed_at: null,
    });
    expect(await getPresaveRow(env, r.presave.id)).toMatchObject({
      stage: "found",
      last_error: null,
    });
    expect(await retryDuePresaveLikes(env, log, { now: NOW + 365 * 86400_000 })).toMatchObject({
      tried: 0,
    });
    expect(yt.rate).toEqual([]);
  });

  it('not rated ("none"): liked', async () => {
    const env = await makeEnv();
    const yt = stub({ ratings: { [VIDEO]: "none" } });
    const r = await addPresave(env, { trackId: "909720" }, "ui", { now: NOW });
    await drainPresaveLikes();
    expect(await likeCols(env, r.presave.id)).toMatchObject({ liked_at: NOW });
    expect(yt.rate).toEqual([VIDEO]);
  });

  it("a rating that cannot be read likes nothing (a dislike could not be told) and is tried again", async () => {
    const env = await makeEnv();
    const yt = stub({ ratings: () => new Response("boom", { status: 503 }) });
    const r = await addPresave(env, { trackId: "909720" }, "ui", { now: NOW });
    await drainPresaveLikes();
    expect(await likeCols(env, r.presave.id)).toMatchObject({
      liked_at: null,
      like_attempts: 1,
      like_next_at: NOW + 15 * 60_000,
    });
    expect(yt.rate).toEqual([]);
  });
});

describe("a like that fails does not touch the pre-save", () => {
  const waiting = async (env: Env, trackId: string, videoId: string, nextAt: number) => {
    const id = await seedResolved(env, trackId, videoId);
    await env.DB.prepare(
      "UPDATE presaves SET like_attempts = 1, like_error = 'transient: x', like_next_at = ? WHERE id = ?",
    )
      .bind(nextAt, id)
      .run();
    return id;
  };

  it("out of the day's quota: still found, the shared quota hold is set, and the like stays due behind it until the hold expires", async () => {
    const env = await makeEnv();
    const other = await waiting(env, "2", "VIDEOBBBBB2", NOW + 60_000);
    let yt = stub({ rate: () => ytError(403, "quotaExceeded") });
    const r = await addPresave(env, { trackId: "909720" }, "tasker", { now: NOW });
    await drainPresaveLikes();
    const dayEnd = quotaDayEnd(NOW) * 1000;
    expect(await getPresaveRow(env, r.presave.id)).toMatchObject({
      stage: "found",
      youtube_video_id: VIDEO,
      next_check_at: null,
      last_result: "found",
      last_error: null,
      liked_at: null,
      like_attempts: 0,
      like_next_at: NOW,
    });
    expect((await likeCols(env, r.presave.id)).like_error).toMatch(/^quota: /);
    expect(await getQuotaOut(env, NOW)).toEqual({ since: NOW / 1000, until: dayEnd / 1000 });
    // The other waiting like keeps its own time: the hold, not a pushed-out retry, is what stops it.
    expect(await likeCols(env, other)).toMatchObject({ like_next_at: NOW + 60_000 });
    expect(yt.rate).toEqual([VIDEO]);
    // The rating was read (1 unit); the refused videos.rate is not counted.
    expect(await likeUnitsSpent(env, NOW)).toBe(1);

    // While the hold is set the cron asks YouTube nothing, however due the likes are.
    yt = stub();
    expect(await retryDuePresaveLikes(env, log, { now: dayEnd - 1 })).toEqual({
      tried: 0,
      liked: 0,
      stoppedBy: "quota",
    });
    expect(yt.getRating).toEqual([]);
    expect(yt.rate).toEqual([]);
    // It expired at midnight Pacific: both go.
    expect(await retryDuePresaveLikes(env, log, { now: dayEnd + 1 })).toEqual({
      tried: 2,
      liked: 2,
      stoppedBy: null,
    });
    expect(await likeCols(env, r.presave.id)).toMatchObject({
      liked_at: dayEnd + 1,
      like_attempts: 1,
      like_error: null,
      like_next_at: null,
    });
  });

  it("a try refused for quota is not counted: a 404 after it still has its three tries, and a 5xx its shortest wait", async () => {
    const env = await makeEnv();
    const gone = await seedResolved(env, "1", "VIDEOAAAAA1");
    const flaky = await seedResolved(env, "2", "VIDEOBBBBB2");
    await env.DB.prepare("UPDATE presaves SET like_next_at = ? WHERE id IN (?, ?)")
      .bind(NOW, gone, flaky)
      .run();
    // Three ticks in a row are told the quota is used (the owner clears the hold each time).
    for (let i = 0; i < 3; i++) {
      stub({ rate: () => ytError(403, "quotaExceeded") });
      expect(await retryDuePresaveLikes(env, log, { now: NOW + i })).toEqual({
        tried: 1,
        liked: 0,
        stoppedBy: "quota",
      });
      await clearQuotaOut(env);
    }
    expect(await likeCols(env, gone)).toMatchObject({ like_attempts: 0, like_claimed_at: null });
    expect(await likeCols(env, flaky)).toMatchObject({ like_attempts: 0, like_claimed_at: null });
    stub({
      rate: (id) =>
        id === "VIDEOAAAAA1"
          ? ytError(404, "videoNotFound")
          : new Response("boom", { status: 503 }),
    });
    expect(await retryDuePresaveLikes(env, log, { now: NOW + 10 })).toEqual({
      tried: 2,
      liked: 0,
      stoppedBy: null,
    });
    // Not final on first sight, and the first backoff, not the fourth.
    const g = await likeCols(env, gone);
    expect(g).toMatchObject({ like_attempts: 1, like_next_at: NOW + 10 + 15 * 60_000 });
    expect(g.like_error).toMatch(/^gone: /);
    expect(await likeCols(env, flaky)).toMatchObject({
      like_attempts: 1,
      like_next_at: NOW + 10 + 15 * 60_000,
    });
  });

  it("a hold the owner clears early lets the likes go at the next tick, not at midnight", async () => {
    const env = await makeEnv();
    const a = await waiting(env, "1", "VIDEOAAAAA1", NOW - 1);
    const b = await waiting(env, "2", "VIDEOBBBBB2", NOW - 1);
    let yt = stub({ rate: () => ytError(403, "dailyLimitExceeded") });
    // The first reply stops the sweep and sets the hold; the second like is not tried.
    expect(await retryDuePresaveLikes(env, log, { now: NOW })).toEqual({
      tried: 1,
      liked: 0,
      stoppedBy: "quota",
    });
    expect(yt.rate).toEqual(["VIDEOAAAAA1"]);
    expect(await getQuotaOut(env, NOW)).not.toBeNull();
    expect(await likeCols(env, a)).toMatchObject({ like_next_at: NOW });
    expect(await likeCols(env, b)).toMatchObject({ like_next_at: NOW - 1, like_attempts: 1 });
    yt = stub();
    expect(await retryDuePresaveLikes(env, log, { now: NOW + 5 * 60_000 })).toEqual({
      tried: 0,
      liked: 0,
      stoppedBy: "quota",
    });
    expect(yt.getRating).toEqual([]);
    await clearQuotaOut(env);
    expect(await retryDuePresaveLikes(env, log, { now: NOW + 10 * 60_000 })).toEqual({
      tried: 2,
      liked: 2,
      stoppedBy: null,
    });
    expect(yt.rate.sort()).toEqual(["VIDEOAAAAA1", "VIDEOBBBBB2"]);
  });

  it("a pre-save found while the hold is set asks YouTube nothing; its like is due and says why it waits", async () => {
    const env = await makeEnv();
    await env.CACHE.put(
      QUOTA_OUT_KEY,
      JSON.stringify({ since: NOW / 1000 - 60, until: quotaDayEnd(NOW) }),
    );
    const yt = stub();
    const r = await addPresave(env, { trackId: "909720" }, "tasker", { now: NOW });
    await drainPresaveLikes();
    expect(await getPresaveRow(env, r.presave.id)).toMatchObject({
      stage: "found",
      liked_at: null,
      like_attempts: 0,
      like_next_at: NOW,
      like_error: "quota: YouTube's daily quota is used up; waiting for it",
    });
    expect(yt.getRating).toEqual([]);
    expect(yt.rate).toEqual([]);
    await clearQuotaOut(env);
    expect(await retryDuePresaveLikes(env, log, { now: NOW + 5 * 60_000 })).toEqual({
      tried: 1,
      liked: 1,
      stoppedBy: null,
    });
    expect(await likeCols(env, r.presave.id)).toMatchObject({
      liked_at: NOW + 5 * 60_000,
      like_error: null,
    });
  });

  it("a per-minute limit backs off that one like for a short while and parks nothing else", async () => {
    const env = await makeEnv();
    const a = await waiting(env, "1", "VIDEOAAAAA1", NOW - 2);
    const b = await waiting(env, "2", "VIDEOBBBBB2", NOW - 1);
    const yt = stub({ rate: () => ytError(403, "rateLimitExceeded") });
    expect(await retryDuePresaveLikes(env, log, { now: NOW })).toEqual({
      tried: 1,
      liked: 0,
      stoppedBy: "rate_limit",
    });
    expect(yt.rate).toEqual(["VIDEOAAAAA1"]);
    const la = await likeCols(env, a);
    expect(la).toMatchObject({ like_attempts: 2, like_next_at: NOW + 30 * 60_000 });
    expect(la.like_error).toMatch(/^rate_limit: /);
    expect(await likeCols(env, b)).toMatchObject({ like_attempts: 1, like_next_at: NOW - 1 });
    // A per-minute limit is no reason for the quota hold.
    expect(await getQuotaOut(env, NOW)).toBeNull();
  });

  it("what is stored and shown: the kind, then YouTube's reply; one readable line for the page", async () => {
    const env = await makeEnv();
    stub({
      rate: () =>
        ytError(403, "videoRatingDisabled", "The owner of the video has <b>disabled</b> ratings."),
    });
    const r = await addPresave(env, { trackId: "909720" }, "ui", { now: NOW });
    await drainPresaveLikes();
    const p = (await getPresaveRow(env, r.presave.id))!;
    expect(p.like_error).toMatch(
      /^rating_disabled: youtube videos\.rate 403 videoRatingDisabled: /,
    );
    const out = presaveOut(p, DEFAULT_APP_SETTINGS);
    expect(out.likeError).toBe(p.like_error);
    // Markup dropped, raw body left out; the page escapes it (TK.tip).
    expect(out.likeErrorText).toBe(
      "videos.rate 403 videoRatingDisabled: The owner of the video has disabled ratings.",
    );
    expect(
      likeErrorLine(
        'quota: youtube videos.rate 403 quotaExceeded: The request cannot be completed because you have exceeded your quota.\n{"error":{}}',
      ),
    ).toBe(
      "YouTube's daily quota is used up. It resets at midnight Pacific time, and tracked will try again.",
    );
    expect(likeErrorLine("not_connected: no YouTube account is connected")).toBe(
      "no YouTube account is connected",
    );
    expect(likeErrorLine("disliked: disliked on YouTube; left alone")).toBe(
      "disliked on YouTube; left alone",
    );
    expect(likeErrorLine(null)).toBeNull();
  });

  it("the daily budget: once the likes consumer's max is used the rest wait for the next quota day, without a call", async () => {
    const env = await makeEnv();
    await updateAppSettings(env, {
      quota: { consumers: { likes: { min: null, max: 60, enabled: true } } },
    });
    const a = await waiting(env, "1", "VIDEOAAAAA1", NOW - 3);
    const b = await waiting(env, "2", "VIDEOBBBBB2", NOW - 2);
    const c = await waiting(env, "3", "VIDEOCCCCC3", NOW - 1);
    const yt = stub();
    const dayEnd = quotaDayEnd(NOW) * 1000;
    expect(await retryDuePresaveLikes(env, log, { now: NOW, limit: 3 })).toEqual({
      tried: 1,
      liked: 1,
      stoppedBy: "budget",
    });
    expect(yt.rate).toEqual(["VIDEOAAAAA1"]);
    expect(await likeUnitsSpent(env, NOW)).toBe(51);
    expect(await likeCols(env, a)).toMatchObject({ liked_at: NOW });
    expect(await likeCols(env, b)).toMatchObject({
      liked_at: null,
      like_attempts: 1,
      like_error: "budget: the 60 units a day for likes are used",
      like_next_at: dayEnd,
    });
    // The sweep stopped there: the third keeps its own time and is parked, by name, when its turn comes.
    expect(await likeCols(env, c)).toMatchObject({
      liked_at: null,
      like_next_at: NOW - 1,
      like_error: "transient: x",
    });
    expect(await retryDuePresaveLikes(env, log, { now: NOW + 1, limit: 3 })).toEqual({
      tried: 0,
      liked: 0,
      stoppedBy: "budget",
    });
    expect(await likeCols(env, c)).toMatchObject({
      liked_at: null,
      like_attempts: 1,
      like_error: "budget: the 60 units a day for likes are used",
      like_next_at: dayEnd,
    });
    expect(yt.rate).toEqual(["VIDEOAAAAA1"]);
    // The next quota day has its own count.
    expect(await retryDuePresaveLikes(env, log, { now: dayEnd + 1, limit: 3 })).toEqual({
      tried: 1,
      liked: 1,
      stoppedBy: "budget",
    });
    expect(yt.rate).toEqual(["VIDEOAAAAA1", "VIDEOBBBBB2"]);
    // The owner's backfill is not held by it.
    expect(await backfillPresaveLikes(env, { dryRun: false }, { now: dayEnd + 2 })).toMatchObject({
      liked: 1,
    });
  });

  it("raising the likes consumer's max mid-day lets the likes parked for it go at the next tick, not at midnight", async () => {
    const env = await makeEnv();
    await updateAppSettings(env, {
      quota: { consumers: { likes: { min: null, max: 60, enabled: true } } },
    });
    const a = await waiting(env, "1", "VIDEOAAAAA1", NOW - 3);
    const b = await waiting(env, "2", "VIDEOBBBBB2", NOW - 2);
    // One waiting for another reason, later today: the cap has nothing to do with its time.
    const later = await waiting(env, "3", "VIDEOCCCCC3", NOW + 3600_000);
    const yt = stub();
    const dayEnd = quotaDayEnd(NOW) * 1000;
    expect(await retryDuePresaveLikes(env, log, { now: NOW })).toEqual({
      tried: 1,
      liked: 1,
      stoppedBy: "budget",
    });
    expect(await likeCols(env, b)).toMatchObject({ liked_at: null, like_next_at: dayEnd });
    // Still capped: nothing moves, nothing is asked.
    expect(await retryDuePresaveLikes(env, log, { now: NOW + 5 * 60_000 })).toEqual({
      tried: 0,
      liked: 0,
      stoppedBy: null,
    });
    expect(await likeCols(env, b)).toMatchObject({ like_next_at: dayEnd });
    await updateAppSettings(env, {
      quota: { consumers: { likes: { min: null, max: 1000, enabled: true } } },
    });
    expect(await retryDuePresaveLikes(env, log, { now: NOW + 10 * 60_000 })).toEqual({
      tried: 1,
      liked: 1,
      stoppedBy: null,
    });
    expect(await likeCols(env, a)).toMatchObject({ liked_at: NOW });
    expect(await likeCols(env, b)).toMatchObject({ liked_at: NOW + 10 * 60_000, like_error: null });
    expect(await likeCols(env, later)).toMatchObject({
      liked_at: null,
      like_next_at: NOW + 3600_000,
    });
    expect(yt.rate).toEqual(["VIDEOAAAAA1", "VIDEOBBBBB2"]);
  });

  it("a 5xx backs off (15 min, doubling, a day at most) and is retried by the cron", async () => {
    const env = await makeEnv();
    const yt = stub({ rate: () => new Response("boom", { status: 503 }) });
    const r = await addPresave(env, { trackId: "909720" }, "ui", { now: NOW });
    await drainPresaveLikes();
    const l = await likeCols(env, r.presave.id);
    expect(l).toMatchObject({
      liked_at: null,
      like_attempts: 1,
      like_next_at: NOW + 15 * 60_000,
      like_claimed_at: null,
    });
    expect(l.like_error).toMatch(/^transient: /);
    expect(await getPresaveRow(env, r.presave.id)).toMatchObject({ stage: "found" });
    expect(await retryDuePresaveLikes(env, log, { now: NOW + 15 * 60_000 })).toEqual({
      tried: 1,
      liked: 0,
      stoppedBy: null,
    });
    expect(await likeCols(env, r.presave.id)).toMatchObject({
      like_attempts: 2,
      like_next_at: NOW + 15 * 60_000 + 30 * 60_000,
    });
    expect(yt.rate).toEqual([VIDEO, VIDEO]);
    expect(likeRetryAt("transient", 30, 0)).toBe(24 * 3600_000);
  });

  it("a 404 right after an upload gets two more tries before it is final", async () => {
    const env = await makeEnv();
    const yt = stub({ medialink: () => ML_NO_YT, rate: () => ytError(404, "videoNotFound") });
    const added = await addPresave(env, { trackId: "909720" }, "ui", { now: NOW });
    await markPresaveUploaded(env, added.presave.id, "UPLOADED001", undefined, NOW);
    await drainPresaveLikes();
    const id = added.presave.id;
    expect(await likeCols(env, id)).toMatchObject({
      like_attempts: 1,
      like_next_at: NOW + 15 * 60_000,
    });
    expect(await retryDuePresaveLikes(env, log, { now: NOW + 15 * 60_000 })).toMatchObject({
      tried: 1,
      liked: 0,
    });
    expect(await likeCols(env, id)).toMatchObject({
      like_attempts: 2,
      like_next_at: NOW + 45 * 60_000,
    });
    expect(await retryDuePresaveLikes(env, log, { now: NOW + 45 * 60_000 })).toMatchObject({
      tried: 1,
      liked: 0,
    });
    const l = await likeCols(env, id);
    expect(l).toMatchObject({ liked_at: null, like_attempts: 3, like_next_at: null });
    expect(l.like_error).toMatch(/^gone: /);
    expect(await retryDuePresaveLikes(env, log, { now: NOW + 365 * 86400_000 })).toMatchObject({
      tried: 0,
    });
    expect(yt.rate).toHaveLength(3);
  });

  it("reads YouTube's reason before its status", async () => {
    const kind = (status: number, reason: string | null) =>
      likeFailKind(new YouTubeApiError("videos.rate", status, reason, ""));
    expect(kind(404, "videoNotFound")).toBe("gone");
    expect(kind(400, "emailNotVerified")).toBe("email_not_verified");
    expect(kind(400, "videoPurchaseRequired")).toBe("purchase_required");
    expect(kind(403, "videoRatingDisabled")).toBe("rating_disabled");
    expect(kind(400, "invalidRating")).toBe("rejected");
    expect(kind(400, null)).toBe("rejected");
    expect(kind(403, "forbidden")).toBe("forbidden");
    expect(kind(403, "rateLimitExceeded")).toBe("rate_limit");
    expect(kind(403, "quotaExceeded")).toBe("quota");
    expect(kind(401, "authError")).toBe("transient");
    expect(kind(500, null)).toBe("transient");
    expect(likeFailKind(new Error("fetch timed out"))).toBe("transient");
    for (const k of [
      "rating_disabled",
      "purchase_required",
      "email_not_verified",
      "forbidden",
      "rejected",
      "disliked",
    ] as const)
      expect(likeRetryAt(k, 1, NOW)).toBeNull();
    expect(likeRetryAt("gone", 2, NOW)).toBe(NOW + 30 * 60_000);
    expect(likeRetryAt("gone", 3, NOW)).toBeNull();
    expect(likeRetryAt("budget", 0, NOW)).toBe(quotaDayEnd(NOW) * 1000);

    // A terminal one end to end: ratings are off for the video.
    const env = await makeEnv();
    stub({ rate: () => ytError(403, "videoRatingDisabled") });
    const r = await addPresave(env, { trackId: "909720" }, "ui", { now: NOW });
    await drainPresaveLikes();
    const l = await likeCols(env, r.presave.id);
    expect(l).toMatchObject({ liked_at: null, like_attempts: 1, like_next_at: null });
    expect(l.like_error).toMatch(/^rating_disabled: /);
  });

  it("no YouTube account connected: the pre-save is found all the same, the like waits", async () => {
    const env = await makeEnv({ connected: false });
    const yt = stub();
    const r = await addPresave(env, { trackId: "909720" }, "ui", { now: NOW });
    await drainPresaveLikes();
    expect(await getPresaveRow(env, r.presave.id)).toMatchObject({
      stage: "found",
      liked_at: null,
      like_error: "not_connected: no YouTube account is connected",
      like_next_at: NOW + 15 * 60_000,
    });
    expect(yt.rate).toEqual([]);
  });

  it("a database without migration 0020 still finds the pre-save, and the backfill route says what is missing", async () => {
    const env = await makeEnv();
    await env.DB.prepare("DROP INDEX presaves_like_due").run();
    for (const c of ["liked_at", "like_attempts", "like_error", "like_next_at", "like_claimed_at"])
      await env.DB.prepare(`ALTER TABLE presaves DROP COLUMN ${c}`).run();
    const yt = stub();
    const r = await addPresave(env, { trackId: "909720" }, "ui", { now: NOW });
    await drainPresaveLikes();
    expect(r.presave).toMatchObject({ stage: "found", youtube_video_id: VIDEO });
    expect(yt.rate).toEqual([]);
    expect(await retryDuePresaveLikes(env, log, { now: NOW })).toEqual({
      tried: 0,
      liked: 0,
      stoppedBy: null,
    });
    const res = await app.request(
      "/presave/like-backfill",
      {
        method: "POST",
        headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
        body: "{}",
      },
      env,
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      error: "migration_missing",
      message: expect.stringContaining("migration 0020"),
    });
  });
});

describe("the cron runs only likes that are due", () => {
  it("a pre-save resolved before the likes existed is left to the backfill", async () => {
    const env = await makeEnv();
    await seedResolved(env, "1", "VIDEOAAAAA1");
    const yt = stub();
    expect(await retryDuePresaveLikes(env, log, { now: NOW })).toEqual({
      tried: 0,
      liked: 0,
      stoppedBy: null,
    });
    expect(yt.rate).toEqual([]);
  });

  it("a like the hook started and nothing finished is the cron's", async () => {
    const env = await makeEnv();
    const id = await seedResolved(env, "1", "VIDEOAAAAA1");
    await env.DB.prepare("UPDATE presaves SET like_next_at = ? WHERE id = ?").bind(NOW, id).run();
    const yt = stub();
    expect(await retryDuePresaveLikes(env, log, { now: NOW + 5 * 60_000 })).toEqual({
      tried: 1,
      liked: 1,
      stoppedBy: null,
    });
    expect(yt.rate).toEqual(["VIDEOAAAAA1"]);
  });
});

describe("the backfill", () => {
  async function seedMany(env: Env) {
    const ids = {
      found: await seedResolved(env, "1", "VIDEOAAAAA1"),
      uploaded: await seedResolved(env, "2", "VIDEOBBBBB2", "uploaded"),
      alreadyOnYt: await seedResolved(env, "3", "VIDEOCCCCC3"),
      disliked: await seedResolved(env, "4", "VIDEODDDDD4"),
      dismissed: await seedResolved(env, "5", "VIDEOEEEEE5", "dismissed"),
      liked: await seedResolved(env, "6", "VIDEOFFFFF6"),
      gone: await seedResolved(env, "7", "VIDEOGGGGG7"),
    };
    await env.DB.prepare("UPDATE presaves SET liked_at = 5 WHERE id = ?").bind(ids.liked).run();
    await env.DB.prepare(
      "UPDATE presaves SET like_attempts = 1, like_error = 'gone: x' WHERE id = ?",
    )
      .bind(ids.gone)
      .run();
    await env.DB.prepare(
      "INSERT INTO presaves (track_id, stage, created_at, updated_at) VALUES ('8', 'links', 1, 1)",
    ).run();
    return ids;
  }
  const RATINGS = {
    VIDEOAAAAA1: "none",
    VIDEOBBBBB2: "none",
    VIDEOCCCCC3: "like",
    VIDEODDDDD4: "dislike",
  };

  it("dry run (the default): lists what it would like and the cost, writes and likes nothing", async () => {
    const env = await makeEnv();
    const ids = await seedMany(env);
    const yt = stub({ ratings: RATINGS });
    const r = await backfillPresaveLikes(env, {}, { now: NOW });
    expect(r).toMatchObject({
      dryRun: true,
      total: 4,
      wouldLike: 2,
      alreadyLiked: 1,
      liked: 0,
      failed: 0,
      units: { getRating: 1, rate: 100 },
      stoppedBy: null,
      nextAfterId: null,
    });
    expect(r.items.map((i) => [i.id, i.action, i.rating])).toEqual([
      [ids.found, "would_like", "none"],
      [ids.uploaded, "would_like", "none"],
      [ids.alreadyOnYt, "already_liked", "like"],
      [ids.disliked, "left_disliked", "dislike"],
    ]);
    expect(yt.getRating).toEqual([["VIDEOAAAAA1", "VIDEOBBBBB2", "VIDEOCCCCC3", "VIDEODDDDD4"]]);
    expect(yt.rate).toEqual([]);
    expect(
      (await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM presaves WHERE liked_at IS NOT NULL OR like_next_at IS NOT NULL",
      ).first<{ n: number }>())!.n,
    ).toBe(1);
    // includeStopped also names the one given up on.
    expect(
      (await backfillPresaveLikes(env, { includeStopped: true }, { now: NOW })).items.map(
        (i) => i.id,
      ),
    ).toContain(ids.gone);
  });

  it("live: likes the unliked, marks the already liked without rating it, leaves a disliked one, and is rerunnable", async () => {
    const env = await makeEnv();
    const ids = await seedMany(env);
    const yt = stub({ ratings: RATINGS });
    const r = await backfillPresaveLikes(env, { dryRun: false }, { now: NOW });
    expect(r).toMatchObject({
      dryRun: false,
      total: 4,
      liked: 2,
      alreadyLiked: 1,
      failed: 0,
      units: { getRating: 1, rate: 100 },
      stoppedBy: null,
      nextAfterId: null,
    });
    expect(yt.rate).toEqual(["VIDEOAAAAA1", "VIDEOBBBBB2"]);
    for (const id of [ids.found, ids.uploaded, ids.alreadyOnYt])
      expect(await likeCols(env, id)).toMatchObject({
        liked_at: NOW,
        like_error: null,
        like_next_at: null,
      });
    expect(await likeCols(env, ids.disliked)).toMatchObject({
      liked_at: null,
      like_error: "disliked: disliked on YouTube; left alone",
      like_next_at: null,
    });
    expect(await likeCols(env, ids.dismissed)).toMatchObject({ liked_at: null, like_attempts: 0 });
    // Again: nothing left, no YouTube call at all.
    const again = await backfillPresaveLikes(env, { dryRun: false }, { now: NOW + 1 });
    expect(again).toMatchObject({ total: 0, items: [], units: { getRating: 0, rate: 0 } });
    expect(yt.rate).toHaveLength(2);
    expect(yt.getRating).toHaveLength(1);
  });

  it("live: `limit` bounds the likes of one request and nextAfterId carries on", async () => {
    const env = await makeEnv();
    const a = await seedResolved(env, "1", "VIDEOAAAAA1");
    const b = await seedResolved(env, "2", "VIDEOBBBBB2");
    const yt = stub();
    const first = await backfillPresaveLikes(env, { dryRun: false, limit: 1 }, { now: NOW });
    expect(first).toMatchObject({ liked: 1, nextAfterId: a, units: { getRating: 1, rate: 50 } });
    const second = await backfillPresaveLikes(
      env,
      { dryRun: false, limit: 1, afterId: a },
      { now: NOW },
    );
    expect(second).toMatchObject({ liked: 1, nextAfterId: null });
    expect(second.items.map((i) => i.id)).toEqual([b]);
    expect(yt.rate).toEqual(["VIDEOAAAAA1", "VIDEOBBBBB2"]);
  });

  it("live: out of quota stops the page and sets the quota hold; a live rerun is refused while it is set, a dry run is not", async () => {
    const env = await makeEnv();
    const a = await seedResolved(env, "1", "VIDEOAAAAA1");
    const b = await seedResolved(env, "2", "VIDEOBBBBB2");
    const c = await seedResolved(env, "3", "VIDEOCCCCC3");
    const yt = stub({
      rate: (id) =>
        id === "VIDEOAAAAA1" ? new Response(null, { status: 204 }) : ytError(403, "quotaExceeded"),
    });
    const r = await backfillPresaveLikes(env, { dryRun: false }, { now: NOW });
    expect(r).toMatchObject({
      liked: 1,
      failed: 1,
      stoppedBy: "quota",
      nextAfterId: null,
      units: { getRating: 1, rate: 50 },
    });
    expect(yt.rate).toEqual(["VIDEOAAAAA1", "VIDEOBBBBB2"]);
    expect(await likeCols(env, a)).toMatchObject({ liked_at: NOW });
    expect(await likeCols(env, b)).toMatchObject({ liked_at: null, like_next_at: NOW });
    expect(await likeCols(env, c)).toMatchObject({ liked_at: null, like_attempts: 0 });
    expect(await getQuotaOut(env, NOW)).not.toBeNull();
    // Live while the hold is set: refused before any call, and it says how to go on.
    const yt2 = stub({ ratings: { VIDEOBBBBB2: "none", VIDEOCCCCC3: "none" } });
    const held = await backfillPresaveLikes(env, { dryRun: false }, { now: NOW + 1 });
    expect(held).toMatchObject({
      total: 2,
      liked: 0,
      failed: 0,
      stoppedBy: "quota",
      units: { getRating: 0, rate: 0 },
      items: [
        { id: b, action: "not_tried" },
        { id: c, action: "not_tried" },
      ],
    });
    expect(held.message).toMatch(/Scheduler page/);
    expect(yt2.getRating).toEqual([]);
    // A dry run still lists them.
    expect(await backfillPresaveLikes(env, {}, { now: NOW + 1 })).toMatchObject({
      dryRun: true,
      wouldLike: 2,
      stoppedBy: null,
      units: { getRating: 1, rate: 100 },
    });
    expect(yt2.rate).toEqual([]);
    await clearQuotaOut(env);
    expect(await backfillPresaveLikes(env, { dryRun: false }, { now: NOW + 2 })).toMatchObject({
      total: 2,
      liked: 2,
      stoppedBy: null,
    });
  });

  it("out of quota already at videos.getRating: a live run likes nothing, a dry run lists everything as not liked yet", async () => {
    const env = await makeEnv();
    await seedResolved(env, "1", "VIDEOAAAAA1");
    const yt = stub({ ratings: () => ytError(403, "quotaExceeded") });
    expect(await backfillPresaveLikes(env, { dryRun: false }, { now: NOW })).toMatchObject({
      liked: 0,
      stoppedBy: "quota",
      units: { getRating: 0, rate: 0 },
      items: [{ action: "not_tried", rating: "unknown" }],
    });
    // The hold is set from here too, as the hook and the cron set it: the next live run is refused before any call.
    expect(await getQuotaOut(env, NOW)).toEqual({ since: NOW / 1000, until: quotaDayEnd(NOW) });
    expect(
      (await backfillPresaveLikes(env, { dryRun: false }, { now: NOW + 1000 })).message,
    ).toMatch(/held until/);
    expect(yt.getRating).toHaveLength(1);
    expect(await backfillPresaveLikes(env, {}, { now: NOW })).toMatchObject({
      wouldLike: 1,
      stoppedBy: "quota",
      units: { getRating: 0, rate: 50 },
      items: [{ action: "would_like", rating: "unknown" }],
    });
    expect(yt.rate).toEqual([]);
  });

  it("a video getRating does not name (deleted, private) is tried, and a 404 is recorded as the hook records it", async () => {
    const env = await makeEnv();
    const a = await seedResolved(env, "1", "VIDEOAAAAA1");
    stub({ ratings: {}, rate: () => ytError(404, "videoNotFound") });
    const r = await backfillPresaveLikes(env, { dryRun: false }, { now: NOW });
    expect(r).toMatchObject({
      liked: 0,
      failed: 1,
      stoppedBy: null,
      items: [{ id: a, rating: "unknown", action: "failed" }],
    });
    const l = await likeCols(env, a);
    expect(l).toMatchObject({ liked_at: null, like_attempts: 1, like_next_at: NOW + 15 * 60_000 });
    expect(l.like_error).toMatch(/^gone: /);
  });

  it("a dismissed pre-save is never liked", async () => {
    const env = await makeEnv();
    const yt = stub();
    const { presave } = await addPresave(env, { trackId: "909720" }, "ui", {
      now: NOW,
      check: false,
    });
    await env.DB.prepare(
      "UPDATE presaves SET youtube_video_id = 'VIDEOAAAAA1', stage = 'found' WHERE id = ?",
    )
      .bind(presave.id)
      .run();
    await dismissPresave(env, presave.id, NOW);
    expect(await likePresaveVideo(env, presave.id, { now: NOW })).toMatchObject({
      outcome: "skipped",
    });
    expect(await backfillPresaveLikes(env, { dryRun: false }, { now: NOW })).toMatchObject({
      total: 0,
    });
    expect(yt.rate).toEqual([]);
  });

  it("POST /presave/like-backfill: the Tasker bearer, dry run unless told otherwise", async () => {
    const env = await makeEnv();
    const id = await seedResolved(env, "1", "VIDEOAAAAA1");
    const yt = stub({ ratings: { VIDEOAAAAA1: "none" } });
    const post = (body: unknown, token = "t") =>
      app.request(
        "/presave/like-backfill",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        env,
      );
    expect((await post({}, "wrong")).status).toBe(401);
    expect((await post({ limit: 500 })).status).toBe(400);
    const dry = await post({});
    expect(dry.status).toBe(200);
    expect(await dry.json()).toMatchObject({
      dryRun: true,
      total: 1,
      wouldLike: 1,
      units: { getRating: 1, rate: 50 },
      items: [{ id, videoId: "VIDEOAAAAA1", action: "would_like" }],
    });
    expect(yt.rate).toEqual([]);
    expect(await (await post({ dryRun: false })).json()).toMatchObject({
      dryRun: false,
      liked: 1,
      items: [{ id, action: "liked" }],
    });
    expect(yt.rate).toEqual(["VIDEOAAAAA1"]);
    expect(await likeCols(env, id)).toMatchObject({ like_attempts: 1 });
  });
});
