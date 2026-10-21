/**
 * A set upload whose playlist insert YouTube refuses (lib/mkvid-playlist.ts):
 * /mkvid/complete still answers done, so mkvid stops redelivering, and the
 * cron tries the insert again when it is due.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { app } from "../src/index";
import type { Env } from "../src/types";
import type { StoredTokens } from "../src/lib/google-oauth";
import { fakeKV } from "./helpers/fake-kv";
import { fakeD1 } from "./helpers/fake-d1";
import {
  claimMkvidRequest,
  enqueueMkvidRequest as enqueueRaw,
  getMkvidRequest,
  quotaDayEnd,
} from "../src/lib/mkvid";
import {
  playlistFailureKind,
  retryDueSetPlaylistInserts,
  setPlaylistRetryAt,
} from "../src/lib/mkvid-playlist";
import { recreateMkvidRequest } from "../src/lib/mkvid-recreate";
import { clearQuotaOut, QUOTA_OUT_KEY } from "../src/lib/youtube-quota";
import { saveSubState } from "../src/lib/sync-store";
import { makeLogger } from "../src/lib/log";
import { updateAppSettings } from "../src/lib/app-settings";
import { storeVerifiedList } from "./helpers/mkvid-lists";

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
import {
  addVideoToPlaylist,
  findPlaylistByTitle,
  listPlaylistVideoIds,
  removeVideoFromPlaylist,
  YouTubeApiError,
} from "../src/lib/youtube-playlists";

const log = makeLogger({ task: "test" });
const tokens: StoredTokens = {
  accessToken: "ya29",
  refreshToken: "r",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  scope: "https://www.googleapis.com/auth/youtube",
  channelId: null,
  channelTitle: null,
  connectedAt: 0,
};

function makeEnv(): Env {
  return {
    CACHE: fakeKV(),
    DB: fakeD1(),
    SUBS: fakeKV({ "oauth:google": JSON.stringify(tokens) }),
    API_TOKEN: "tasker",
    YOUTUBE_API_KEY: "k",
    MKVID_TOKEN: "mk-secret",
  } as Env;
}

const post = (env: Env, path: string, body: unknown) =>
  app.request(
    `http://x${path}`,
    {
      method: "POST",
      headers: { Authorization: "Bearer mk-secret", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );

const input = {
  slug: "lillypalmer",
  setUrl: "https://www.1001tracklists.com/tracklist/abc/lilly-palmer-x.html",
  artistName: "Lilly Palmer",
  setTitle: "Lilly Palmer @ X 2026-09-01",
  setDate: "2026-09-01",
  source: { kind: "soundcloud" as const, url: "https://api.soundcloud.com/tracks/123" },
  lastCueSeconds: 3600,
  trackCount: 20,
  idedCount: 18,
};

const quotaErr = () =>
  new YouTubeApiError("playlistItems.insert", 403, "quotaExceeded", '{"error":{}}');
const unavailableErr = () =>
  new YouTubeApiError("playlistItems.insert", 409, "SERVICE_UNAVAILABLE", '{"error":{}}');
const goneErr = () =>
  new YouTubeApiError("playlistItems.insert", 404, "videoNotFound", '{"error":{}}');

const nowS = () => Math.floor(Date.now() / 1000);
const fn = (f: unknown) => f as ReturnType<typeof vi.fn>;

async function claimed(env: Env) {
  await saveSubState(env, input.slug, {
    playlistId: "PLartist",
    artistName: input.artistName,
    processedTracklistUrls: [input.setUrl],
    tracklistVideos: { [input.setUrl]: { videoId: null, checkedAt: nowS() - 100 } },
  });
  expect(await enqueueRaw(env, input)).toBe("queued");
  await storeVerifiedList(env, input.setUrl);
  return (await claimMkvidRequest(env, log))!;
}

const audits = async (env: Env) =>
  (
    await env.DB.prepare("SELECT record FROM playlist_additions").all<{ record: string }>()
  ).results.map(
    (r) => JSON.parse(r.record) as { status: string; videoId: string; previousVideoId?: string },
  );

beforeEach(() => {
  vi.resetAllMocks();
  fn(listPlaylistVideoIds).mockImplementation(async () => new Set<string>());
  fn(findPlaylistByTitle).mockImplementation(async (title: string) =>
    title.startsWith("All tracked artists")
      ? { id: "PLcombined", title }
      : { id: "PLartist", title },
  );
});

describe("set completion with a refused playlist insert", () => {
  it("a quota reply: done, the insert waits for the next quota day, a redelivery is refused, the cron adds it once the quota is back", async () => {
    const env = makeEnv();
    const req = await claimed(env);
    fn(addVideoToPlaylist).mockRejectedValueOnce(quotaErr());

    const res = await post(env, "/mkvid/complete", {
      id: req.id,
      videoId: "upload12345",
      videoUrl: "https://youtu.be/upload12345",
      privacy: "unlisted",
      jobId: "1363fe56-50df-41c4-9b05-b0b68fd55c67",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "done",
      videoId: "upload12345",
      playlistStatus: "pending",
      playlistId: null,
    });
    const end = quotaDayEnd();
    expect(body.playlistRetryAt).toBe(end);
    // Only the artist insert was asked: the combined mirror waits too.
    expect(addVideoToPlaylist).toHaveBeenCalledTimes(1);
    expect(await getMkvidRequest(env, req.id)).toMatchObject({
      status: "done",
      videoId: "upload12345",
      playlistStatus: "pending",
      notBefore: end,
      error: expect.stringContaining("quota"),
    });
    expect(
      await env.DB.prepare("SELECT video_id, video_source FROM tracklists WHERE url = ?")
        .bind(input.setUrl)
        .first(),
    ).toEqual({ video_id: "upload12345", video_source: "mkvid" });
    expect(await env.CACHE.get(QUOTA_OUT_KEY)).not.toBeNull();
    expect(await audits(env)).toEqual([]);

    // mkvid redelivering (it never saw the answer): refused, nothing inserted twice.
    const again = await post(env, "/mkvid/complete", { id: req.id, videoId: "upload12345" });
    expect(again.status).toBe(409);
    expect(addVideoToPlaylist).toHaveBeenCalledTimes(1);

    // The cron: not due before the quota day ends, and nothing asked while the hold is set.
    expect(await retryDueSetPlaylistInserts(env, log, { now: end - 60 })).toEqual({
      tried: 0,
      added: 0,
      stoppedBy: null,
    });
    expect(await retryDueSetPlaylistInserts(env, log, { now: end })).toEqual({
      tried: 0,
      added: 0,
      stoppedBy: "quota",
    });
    // The quota is back: the hold and the own project's out flag both gone (the priority rule reads the pool).
    await clearQuotaOut(env);
    expect(await retryDueSetPlaylistInserts(env, log, { now: end })).toEqual({
      tried: 1,
      added: 1,
      stoppedBy: null,
    });
    expect(
      fn(addVideoToPlaylist)
        .mock.calls.slice(1)
        .map((c) => [c[0], c[1]]),
    ).toEqual([
      ["PLartist", "upload12345"],
      ["PLcombined", "upload12345"],
    ]);
    expect(await getMkvidRequest(env, req.id)).toMatchObject({
      status: "done",
      playlistStatus: "added",
      notBefore: null,
      error: null,
    });
    expect(await audits(env)).toMatchObject([{ status: "added", videoId: "upload12345" }]);
    // Nothing is due any more.
    expect((await retryDueSetPlaylistInserts(env, log, { now: end + 3600 })).tried).toBe(0);
  });

  it("a 5xx-like reply (409 SERVICE_UNAVAILABLE) is tried again after 10 min, then after a longer wait; a quota reply on a retry stops the step", async () => {
    const env = makeEnv();
    const req = await claimed(env);
    fn(addVideoToPlaylist).mockRejectedValueOnce(unavailableErr());
    const t0 = nowS();
    const res = await post(env, "/mkvid/complete", { id: req.id, videoId: "upload12345" });
    expect(res.status).toBe(200);
    const r1 = (await getMkvidRequest(env, req.id))!;
    expect(r1).toMatchObject({ status: "done", playlistStatus: "pending" });
    expect(r1.notBefore! - t0).toBeGreaterThanOrEqual(600);
    expect(r1.notBefore! - t0).toBeLessThan(700);
    expect(r1.error).toContain("tried again by itself");

    fn(addVideoToPlaylist).mockRejectedValueOnce(unavailableErr());
    const t1 = r1.notBefore!;
    expect(await retryDueSetPlaylistInserts(env, log, { now: t1 })).toMatchObject({
      tried: 1,
      added: 0,
      stoppedBy: null,
    });
    const r2 = (await getMkvidRequest(env, req.id))!;
    expect(r2.playlistStatus).toBe("pending");
    expect(r2.notBefore! - nowS()).toBeGreaterThanOrEqual(1200 - 5);

    fn(addVideoToPlaylist).mockRejectedValueOnce(quotaErr());
    expect(await retryDueSetPlaylistInserts(env, log, { now: r2.notBefore! })).toMatchObject({
      tried: 1,
      stoppedBy: "quota",
    });
    expect((await getMkvidRequest(env, req.id))!.notBefore).toBe(quotaDayEnd());
  });

  it("a permanent refusal is done with the insert failed for good, and the cron leaves it alone", async () => {
    const env = makeEnv();
    const req = await claimed(env);
    fn(addVideoToPlaylist).mockRejectedValueOnce(goneErr());
    const res = await post(env, "/mkvid/complete", { id: req.id, videoId: "upload12345" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ playlistStatus: "failed", playlistRetryAt: null });
    expect(await getMkvidRequest(env, req.id)).toMatchObject({
      status: "done",
      playlistStatus: "failed",
      notBefore: null,
      error: expect.stringContaining("refused"),
    });
    expect((await retryDueSetPlaylistInserts(env, log, { now: nowS() + 86400 })).tried).toBe(0);
  });

  it("a recreation keeps the old video in the playlists until the new one is in, then retires it", async () => {
    const env = makeEnv();
    const req = await claimed(env);
    const OLD = "oldVid12345";
    expect((await post(env, "/mkvid/complete", { id: req.id, videoId: OLD })).status).toBe(200);
    expect((await recreateMkvidRequest(env, req.id, log)).ok).toBe(true);
    const again = (await claimMkvidRequest(env, log, ["primary"], "scene"))!;
    expect(again.id).toBe(req.id);
    fn(listPlaylistVideoIds).mockImplementation(async () => new Set([OLD]));
    await env.CACHE.delete("yt:plvids:PLartist");
    fn(addVideoToPlaylist).mockRejectedValueOnce(quotaErr());

    const res = await post(env, "/mkvid/complete", { id: req.id, videoId: "newVid12345" });
    expect(res.status).toBe(200);
    expect(await getMkvidRequest(env, req.id)).toMatchObject({
      status: "done",
      videoId: "newVid12345",
      replacesVideoId: OLD,
      playlistStatus: "pending",
    });
    expect(removeVideoFromPlaylist).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare("SELECT state FROM mkvid_old_videos WHERE video_id = ?")
        .bind(OLD)
        .first(),
    ).toEqual({ state: "awaiting_replacement" });

    // The quota is back: the hold and the own project's out flag both gone (the priority rule reads the pool).
    await clearQuotaOut(env);
    fn(removeVideoFromPlaylist).mockResolvedValue(1);
    expect(await retryDueSetPlaylistInserts(env, log, { now: quotaDayEnd() })).toMatchObject({
      tried: 1,
      added: 1,
    });
    expect(fn(removeVideoFromPlaylist).mock.calls[0]!.slice(0, 2)).toEqual(["PLartist", OLD]);
    expect(await getMkvidRequest(env, req.id)).toMatchObject({
      playlistStatus: "added",
      replacesVideoId: null,
    });
    expect(
      await env.DB.prepare("SELECT replaced_by FROM mkvid_old_videos WHERE video_id = ?")
        .bind(OLD)
        .first(),
    ).toEqual({ replaced_by: "newVid12345" });
    expect((await audits(env)).at(-1)).toMatchObject({
      status: "replaced",
      videoId: "newVid12345",
      previousVideoId: OLD,
    });
  });

  it("a set that resolves to another video by the retry drops the insert", async () => {
    const env = makeEnv();
    const req = await claimed(env);
    fn(addVideoToPlaylist).mockRejectedValueOnce(unavailableErr());
    expect(
      (await post(env, "/mkvid/complete", { id: req.id, videoId: "upload12345" })).status,
    ).toBe(200);
    await saveSubState(env, input.slug, {
      playlistId: "PLartist",
      processedTracklistUrls: [input.setUrl],
      tracklistVideos: { [input.setUrl]: { videoId: "realVid1234", checkedAt: nowS() } },
    });
    expect(await retryDueSetPlaylistInserts(env, log, { now: nowS() + 3600 })).toMatchObject({
      tried: 0,
    });
    expect(addVideoToPlaylist).toHaveBeenCalledTimes(1);
    expect(await getMkvidRequest(env, req.id)).toMatchObject({
      status: "done",
      playlistStatus: null,
      notBefore: null,
      error: expect.stringContaining("realVid1234"),
    });
  });

  it("the cron says held, not quota, when the priority rule holds the insert", async () => {
    const env = makeEnv();
    const req = await claimed(env);
    fn(addVideoToPlaylist).mockRejectedValueOnce(unavailableErr());
    await post(env, "/mkvid/complete", { id: req.id, videoId: "upload12345" });
    // The DJ playlists' max is 0: the gate refuses, the quota itself is not out.
    await updateAppSettings(env as Env & { SUBS: KVNamespace }, {
      quota: { consumers: { dj_playlists: { min: null, max: 0, enabled: true } } },
    });
    expect(await retryDueSetPlaylistInserts(env, log, { now: nowS() + 3600 })).toMatchObject({
      added: 0,
      stoppedBy: "held",
    });
    expect(addVideoToPlaylist).toHaveBeenCalledTimes(1);
    expect(await env.CACHE.get(QUOTA_OUT_KEY)).toBeNull();
  });

  it("the cron stops when YouTube is not connected, and skips a request another tick took", async () => {
    const env = makeEnv();
    const req = await claimed(env);
    fn(addVideoToPlaylist).mockRejectedValueOnce(unavailableErr());
    await post(env, "/mkvid/complete", { id: req.id, videoId: "upload12345" });
    await env.SUBS.delete("oauth:google");
    expect(await retryDueSetPlaylistInserts(env, log, { now: nowS() + 3600 })).toMatchObject({
      tried: 0,
      stoppedBy: "not_connected",
    });
  });
});

describe("retry timing", () => {
  it("classifies and schedules", () => {
    expect(playlistFailureKind(quotaErr())).toBe("quota");
    expect(
      playlistFailureKind(
        new YouTubeApiError("playlistItems.insert", 403, "rateLimitExceeded", ""),
      ),
    ).toBe("rate_limit");
    expect(playlistFailureKind(unavailableErr())).toBe("transient");
    expect(playlistFailureKind(new TypeError("fetch failed"))).toBe("transient");
    expect(playlistFailureKind(goneErr())).toBe("permanent");
    const now = 1_800_000_000;
    expect(setPlaylistRetryAt("permanent", 1, now)).toBeNull();
    expect(setPlaylistRetryAt("quota", 1, now)).toBe(quotaDayEnd(now * 1000));
    expect(setPlaylistRetryAt("rate_limit", 3, now)).toBe(now + 600);
    expect(setPlaylistRetryAt("transient", 1, now)).toBe(now + 600);
    expect(setPlaylistRetryAt("transient", 2, now)).toBe(now + 1200);
    expect(setPlaylistRetryAt("transient", 50, now)).toBe(now + 6 * 3600);
  });
});
