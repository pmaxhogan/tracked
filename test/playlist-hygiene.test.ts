import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeD1 } from "./helpers/fake-d1";
import { fakeKV } from "./helpers/fake-kv";
import type { Env } from "../src/types";
import { makeLogger } from "../src/lib/log";
import type { VideoMeta } from "../src/lib/video-meta";

vi.mock("../src/lib/youtube-playlists", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/youtube-playlists")>(
    "../src/lib/youtube-playlists",
  );
  return {
    ...actual,
    listPlaylistItems: vi.fn(),
    removeVideoFromPlaylist: vi.fn(),
    addVideoToPlaylist: vi.fn(),
    deletePlaylistItem: vi.fn(),
  };
});
vi.mock("../src/lib/video-meta", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/video-meta")>("../src/lib/video-meta");
  return { ...actual, getVideoMeta: vi.fn() };
});
vi.mock("../src/lib/google-oauth", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/google-oauth")>("../src/lib/google-oauth");
  return { ...actual, getAccessToken: vi.fn(async () => ({ accessToken: "tok", tokens: {} })) };
});

import {
  addVideoToPlaylist,
  deletePlaylistItem,
  listPlaylistItems,
  removeVideoFromPlaylist,
  YouTubeApiError,
} from "../src/lib/youtube-playlists";
import { getQuotaOut } from "../src/lib/youtube-quota";
import { getVideoMeta } from "../src/lib/video-meta";
import { getAccessToken } from "../src/lib/google-oauth";
import {
  approveDeadHold,
  listDeadHolds,
  comparePlaylists,
  extractSetFacts,
  hasGoodVideo,
  isMassRemoval,
  listHolds,
  playlistHoldNotifier,
  playlistHoldPayload,
  mkvidReplacedIds,
  approveHold,
  pickSetVideo,
  planDuplicateDeletes,
  removeAndReplace,
  requestSweepSoon,
  runPlaylistHygiene,
  runRemovalSweep,
  saveSetFacts,
  sweepDeletesUsed,
  sweepSettings,
  undoRemoval,
  type SetFacts,
} from "../src/lib/playlist-hygiene";
import { savePushSubscription } from "../src/lib/web-push";
import { pushSubscription, vapid } from "./helpers/web-push";
import {
  blockedIds,
  combinedRefuses,
  combinedSkipIds,
  confirmedMembership,
  isBlocked,
  markInPlaylist,
  markOutOfPlaylist,
  recordRemoved,
  savePlaylistMembers,
  setOverride,
} from "../src/lib/playlist-blocklist";
import { getMkvidRequestForSet } from "../src/lib/mkvid";
import { saveVideoChannels } from "../src/lib/video-meta";
import { channelStrikes, decideBan, processBanQueue } from "../src/lib/channel-bans";

const log = makeLogger({ task: "test" });
const fixture = (name: string) =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", name), "utf8");

function makeEnv(extra: Partial<Env> = {}): Env {
  return {
    CACHE: fakeKV(),
    SUBS: fakeKV(),
    DB: fakeD1(),
    API_TOKEN: "t",
    YOUTUBE_API_KEY: "k",
    DEV_BYPASS_CF_ACCESS: "1",
    ...extra,
  } as Env;
}

const SLUG = "dj";
const PL = "PLartist";
const PLC = "PLcombined";
const setUrl = (n: number | string) =>
  `https://www.1001tracklists.com/tracklist/${n}/dj-set-2026-09-0${Number(n) % 9 || 1}.html`;

async function seedSub(env: Env, slug = SLUG, playlistId = PL) {
  await env.DB.prepare("INSERT INTO sub_sync (slug, playlist_id, artist_name) VALUES (?, ?, ?)")
    .bind(slug, playlistId, "DJ")
    .run();
}
/**
 * A processed set. Its video counts as confirmed in the DJ's playlist (the
 * sync's insert succeeded) unless `confirmed: false`.
 */
async function seedSet(
  env: Env,
  url: string,
  videoId: string | null,
  opts: {
    slug?: string;
    source?: string;
    pos?: number;
    confirmed?: boolean;
    playlistId?: string;
  } = {},
) {
  await env.DB.prepare(
    "INSERT INTO tracklists (slug, url, position, discovered_at, processed, video_known, video_id, video_source, checked_at) VALUES (?, ?, ?, 0, 1, 1, ?, ?, ?)",
  )
    .bind(
      opts.slug ?? SLUG,
      url,
      opts.pos ?? 0,
      videoId,
      videoId ? (opts.source ?? "1001tl") : null,
      1_900_000_000,
    )
    .run();
  if (videoId && opts.confirmed !== false)
    await markInPlaylist(env, opts.playlistId ?? PL, videoId, "sync", 1);
}
async function seedCombined(env: Env, extra: Record<string, unknown> = {}) {
  await env.SUBS.put("subs:combined", JSON.stringify({ playlistId: PLC, ...extra }));
}
async function row(env: Env, url: string) {
  return env.DB.prepare("SELECT * FROM tracklists WHERE url = ?").bind(url).first<{
    video_id: string | null;
    video_known: number;
    checked_at: number;
    video_source: string | null;
  }>();
}
async function removals(env: Env) {
  return (
    await env.DB.prepare("SELECT * FROM playlist_removals ORDER BY id").all<Record<string, any>>()
  ).results;
}

function meta(id: string, m: Partial<VideoMeta> = {}): VideoMeta {
  return {
    videoId: id,
    durationSeconds: 3600,
    embedWidth: 1280,
    embedHeight: 720,
    privacy: "public",
    uploadStatus: "processed",
    alive: true,
    fetchedAt: 0,
    ...m,
  };
}
function metaAnswer(metas: Record<string, Partial<VideoMeta>>) {
  (getVideoMeta as ReturnType<typeof vi.fn>).mockImplementation(
    async (_env: Env, ids: string[]) => new Map(ids.map((id) => [id, meta(id, metas[id] ?? {})])),
  );
}
function facts(url: string, f: Partial<SetFacts> = {}): SetFacts {
  return {
    setUrl: url,
    slug: SLUG,
    videoId: null,
    noFullNotice: false,
    lastCueSeconds: null,
    audioMaxSeconds: null,
    audioKind: null,
    audioUrl: null,
    setTitle: null,
    setDate: null,
    trackCount: 10,
    idedCount: 10,
    fetchedAt: 1,
    ...f,
  };
}
/**
 * listPlaylistItems answers from a playlistId -> video ids map. `as` gives a
 * video the item YouTube lists for it (see `SHAPES`); the others are the bare
 * items these tests always used, or a "Deleted video" with `deadTitles`.
 */
type Shape = "private" | "deleted" | "ownPrivate" | "unlistedNamedPrivate" | "public";
const SHAPES: Record<Shape, (id: string) => Record<string, unknown>> = {
  // Somebody else's video, made private: what production lists for HYQzhr5AXTA in the FISHER playlist.
  private: (id) => ({
    snippet: {
      title: "Private video",
      description: "This video is private.",
      resourceId: { videoId: id },
    },
    contentDetails: { videoId: id },
    status: { privacyStatus: "private" },
  }),
  deleted: (id) => ({
    snippet: {
      title: "Deleted video",
      description: "This video is unavailable.",
      resourceId: { videoId: id },
    },
    contentDetails: { videoId: id },
    status: { privacyStatus: "privacyStatusUnspecified" },
  }),
  // The owner's own private upload lists with its real channel, whatever it is called.
  ownPrivate: (id) => ({
    snippet: {
      title: "Private video",
      videoOwnerChannelId: "UCowner",
      videoOwnerChannelTitle: "Owner",
      resourceId: { videoId: id },
    },
    contentDetails: { videoId: id, videoPublishedAt: "2026-01-01T00:00:00Z" },
    status: { privacyStatus: "private" },
  }),
  unlistedNamedPrivate: (id) => ({
    snippet: { title: "Private video", resourceId: { videoId: id } },
    contentDetails: { videoId: id },
    status: { privacyStatus: "unlisted" },
  }),
  public: (id) => ({
    snippet: {
      title: `Set ${id}`,
      videoOwnerChannelId: "UCdj",
      videoOwnerChannelTitle: "DJ",
      resourceId: { videoId: id },
    },
    contentDetails: { videoId: id, videoPublishedAt: "2026-01-01T00:00:00Z" },
    status: { privacyStatus: "public" },
  }),
};
function listing(
  map: Record<string, string[]>,
  opts: {
    incomplete?: string[];
    throws?: string[];
    deadTitles?: string[];
    as?: Record<string, Shape>;
  } = {},
) {
  (listPlaylistItems as ReturnType<typeof vi.fn>).mockImplementation(async (playlistId: string) => {
    if ((opts.throws ?? []).includes(playlistId)) throw new Error("youtube playlistItems.list 500");
    const items = (map[playlistId] ?? []).map((id) => ({
      id: `item-${id}`,
      snippet: {
        title: (opts.deadTitles ?? []).includes(id) ? "Deleted video" : `Set ${id}`,
        resourceId: { videoId: id },
      },
      contentDetails: { videoId: id },
      ...(opts.as?.[id] ? SHAPES[opts.as[id]!](id) : {}),
    }));
    return {
      items,
      nextPageToken: (opts.incomplete ?? []).includes(playlistId) ? "NEXT" : null,
      pages: 1,
    };
  });
}

beforeEach(() => {
  vi.mocked(listPlaylistItems).mockReset();
  vi.mocked(removeVideoFromPlaylist).mockReset().mockResolvedValue(1);
  vi.mocked(addVideoToPlaylist).mockReset().mockResolvedValue(undefined);
  vi.mocked(deletePlaylistItem).mockReset().mockResolvedValue(undefined);
  vi.mocked(getVideoMeta)
    .mockReset()
    .mockImplementation(
      async (_env: Env, ids: string[]) => new Map(ids.map((id) => [id, meta(id)])),
    );
  vi.mocked(getAccessToken).mockClear();
});

describe("sweepSettings", () => {
  it("is a dry run unless PLAYLIST_SWEEP_DRY_RUN says otherwise", () => {
    expect(sweepSettings({}).dryRun).toBe(true);
    expect(sweepSettings({ PLAYLIST_SWEEP_DRY_RUN: "" }).dryRun).toBe(true);
    expect(sweepSettings({ PLAYLIST_SWEEP_DRY_RUN: "true" }).dryRun).toBe(true);
    expect(sweepSettings({ PLAYLIST_SWEEP_DRY_RUN: "yes please" }).dryRun).toBe(true);
    for (const off of ["false", "0", "no", "OFF"])
      expect(sweepSettings({ PLAYLIST_SWEEP_DRY_RUN: off }).dryRun).toBe(false);
  });

  it("allows 40 removals a day unless configured", () => {
    expect(sweepSettings({}).dailyRemovals).toBe(40);
    expect(sweepSettings({ PLAYLIST_SWEEP_DAILY_REMOVALS: "5" }).dailyRemovals).toBe(5);
    expect(sweepSettings({ PLAYLIST_SWEEP_DAILY_REMOVALS: "0" }).dailyRemovals).toBe(0);
    expect(sweepSettings({ PLAYLIST_SWEEP_DAILY_REMOVALS: "lots" }).dailyRemovals).toBe(40);
  });
});

describe("extractSetFacts", () => {
  it("reads the notice, cues, rows and audio source from a saved page", () => {
    const f = extractSetFacts(
      SLUG,
      "https://www.1001tracklists.com/tracklist/l3uw499/matroda.html",
      fixture("tracklist-matroda.html"),
      "79n8BaQAL2Q",
    );
    expect(f.noFullNotice).toBe(true);
    expect(f.videoId).toBe("79n8BaQAL2Q");
    expect(f.lastCueSeconds).toBeGreaterThan(0);
    expect(f.trackCount).toBeGreaterThan(0);
    const m = extractSetFacts(
      SLUG,
      "https://www.1001tracklists.com/tracklist/1pmwyfn1/max-styler.html",
      fixture("tracklist-maxstyler.html"),
      "N40pkDgwNfg",
    );
    expect(m.noFullNotice).toBe(false);
    expect(m.audioMaxSeconds).toBe(4569);
    expect(m.audioKind).toBe("soundcloud");
    expect(m.trackCount).toBeGreaterThanOrEqual(28);
  });
});

describe("pickSetVideo (the sync gate)", () => {
  const html = "<html>plain page</html>";

  it("passes a full recording and stores the page facts", async () => {
    const env = makeEnv();
    const r = await pickSetVideo(env, {
      slug: SLUG,
      setUrl: setUrl(1),
      html,
      rawVideoId: "good0000001",
      playlistId: PL,
      accessToken: "tok",
      log,
    });
    expect(r).toEqual({ videoId: "good0000001", rejected: null });
    const stored = await env.DB.prepare("SELECT video_id FROM set_media_facts WHERE set_url = ?")
      .bind(setUrl(1))
      .first<{ video_id: string }>();
    expect(stored!.video_id).toBe("good0000001");
  });

  it("turns down a video on a page with the no-full-recording notice", async () => {
    const env = makeEnv();
    const r = await pickSetVideo(env, {
      slug: SLUG,
      setUrl: setUrl(1),
      html: fixture("tracklist-matroda.html"),
      rawVideoId: "79n8BaQAL2Q",
      playlistId: PL,
      accessToken: "tok",
      log,
    });
    expect(r.videoId).toBeNull();
    expect(r.rejected).toMatchObject({ videoId: "79n8BaQAL2Q", reason: "notice" });
  });

  it("leaves a vertical-looking video alone when REJECT_VERTICAL is turned off (it is on by default)", async () => {
    const env = makeEnv({ REJECT_VERTICAL: "0" });
    metaAnswer({ vert0000001: { embedWidth: 720, embedHeight: 1280 } });
    expect(
      (
        await pickSetVideo(env, {
          slug: SLUG,
          setUrl: setUrl(1),
          html,
          rawVideoId: "vert0000001",
          playlistId: PL,
          accessToken: "tok",
          log,
        })
      ).rejected,
    ).toBeNull();
  });

  it("turns down a vertical video (REJECT_VERTICAL=1) and one much shorter than the audio", async () => {
    const env = makeEnv({ REJECT_VERTICAL: "1" });
    metaAnswer({
      vert0000001: { embedWidth: 720, embedHeight: 1280 },
      clip0000001: { durationSeconds: 600 },
    });
    expect(
      (
        await pickSetVideo(env, {
          slug: SLUG,
          setUrl: setUrl(1),
          html,
          rawVideoId: "vert0000001",
          playlistId: PL,
          accessToken: "tok",
          log,
        })
      ).rejected,
    ).toMatchObject({ reason: "vertical" });
    const withAudio =
      'new AudioPlayerSC("scWidget_1", { idPlayer: "1", type: "soundcloud", source: "x", duration: "3600" })';
    expect(
      (
        await pickSetVideo(env, {
          slug: SLUG,
          setUrl: setUrl(2),
          html: withAudio,
          rawVideoId: "clip0000001",
          playlistId: PL,
          accessToken: "tok",
          log,
        })
      ).rejected,
    ).toMatchObject({ reason: "audio_longer" });
  });

  it("turns down a video removed from the artist playlist before, and a dead one", async () => {
    const env = makeEnv();
    await recordRemoved(env, {
      playlistId: PL,
      videoId: "gone0000001",
      slug: SLUG,
      setUrl: setUrl(1),
      reason: "owner",
    });
    const r = await pickSetVideo(env, {
      slug: SLUG,
      setUrl: setUrl(1),
      html,
      rawVideoId: "gone0000001",
      playlistId: PL,
      accessToken: "tok",
      log,
    });
    expect(r).toMatchObject({ videoId: null, rejected: { reason: "blocked" } });
    metaAnswer({ dead0000001: { alive: false } });
    expect(
      (
        await pickSetVideo(env, {
          slug: SLUG,
          setUrl: setUrl(2),
          html,
          rawVideoId: "dead0000001",
          playlistId: PL,
          accessToken: "tok",
          log,
        })
      ).rejected,
    ).toMatchObject({ reason: "dead" });
  });

  it("lets an owner-overridden video through, and fails open when the lookup fails", async () => {
    const env = makeEnv();
    await setOverride(env, "79n8BaQAL2Q");
    expect(
      (
        await pickSetVideo(env, {
          slug: SLUG,
          setUrl: setUrl(1),
          html: fixture("tracklist-matroda.html"),
          rawVideoId: "79n8BaQAL2Q",
          playlistId: PL,
          accessToken: "tok",
          log,
        })
      ).videoId,
    ).toBe("79n8BaQAL2Q");
    vi.mocked(getVideoMeta).mockRejectedValue(new Error("videos.list 500"));
    expect(
      (
        await pickSetVideo(env, {
          slug: SLUG,
          setUrl: setUrl(2),
          html,
          rawVideoId: "unkn0000001",
          playlistId: PL,
          accessToken: "tok",
          log,
        })
      ).videoId,
    ).toBe("unkn0000001");
  });

  it("no page video: nothing to vet", async () => {
    const env = makeEnv();
    expect(
      await pickSetVideo(env, {
        slug: SLUG,
        setUrl: setUrl(1),
        html,
        rawVideoId: null,
        playlistId: PL,
        accessToken: "tok",
        log,
      }),
    ).toEqual({ videoId: null, rejected: null });
    expect(getVideoMeta).not.toHaveBeenCalled();
  });
});

describe("hasGoodVideo (for the mkvid eligibility check)", () => {
  it("false without a video, when blocked, or when cached facts reject it; true otherwise", async () => {
    const env = makeEnv();
    await seedSub(env);
    expect(await hasGoodVideo(env, { slug: SLUG, setUrl: setUrl(1), videoId: null })).toBe(false);
    expect(await hasGoodVideo(env, { slug: SLUG, setUrl: setUrl(1), videoId: "good0000001" })).toBe(
      true,
    );
    await saveSetFacts(env, facts(setUrl(2), { noFullNotice: true }));
    expect(await hasGoodVideo(env, { slug: SLUG, setUrl: setUrl(2), videoId: "bad00000001" })).toBe(
      false,
    );
    await recordRemoved(env, {
      playlistId: PL,
      videoId: "own00000001",
      slug: SLUG,
      setUrl: setUrl(3),
      reason: "owner",
    });
    expect(await hasGoodVideo(env, { slug: SLUG, setUrl: setUrl(3), videoId: "own00000001" })).toBe(
      false,
    );
    await setOverride(env, "bad00000001");
    expect(await hasGoodVideo(env, { slug: SLUG, setUrl: setUrl(2), videoId: "bad00000001" })).toBe(
      true,
    );
  });
});

describe("runRemovalSweep", () => {
  async function seedMix(env: Env) {
    await seedSub(env);
    await seedCombined(env);
    await seedSet(env, setUrl(1), "good0000001", { pos: 0 });
    await seedSet(env, setUrl(2), "notc0000001", { pos: 1 });
    await seedSet(env, setUrl(3), "vert0000001", { pos: 2 });
    await seedSet(env, setUrl(4), "mkvd0000001", { pos: 3, source: "mkvid" });
    await saveSetFacts(env, facts(setUrl(2), { noFullNotice: true }));
    await saveSetFacts(env, facts(setUrl(4), { noFullNotice: true }));
    metaAnswer({ vert0000001: { embedWidth: 720, embedHeight: 1280 } });
  }

  it("a set whose insert waits for YouTube quota (unprocessed, video on its row) is not swept and not expected in a playlist", async () => {
    const env = makeEnv();
    await seedSub(env);
    await seedCombined(env);
    await seedSet(env, setUrl(1), "good0000001");
    // As lib/sync.ts leaves a deferred set: not processed, its picked video kept, never inserted. Its page says "no full recording".
    await env.DB.prepare(
      "INSERT INTO tracklists (slug, url, position, discovered_at, processed, video_known, video_id, video_source, checked_at) VALUES (?, ?, 1, 0, 0, 1, 'wait0000001', '1001tl', 1900000000)",
    )
      .bind(SLUG, setUrl(2))
      .run();
    await saveSetFacts(env, facts(setUrl(2), { noFullNotice: true }));
    metaAnswer({});
    const r = await runRemovalSweep(env, "tok", {
      log,
      settings: { dryRun: false, dailyRemovals: 40 },
    });
    expect(r).toMatchObject({ candidates: 1, rejected: 0, deletes: 0 });
    expect(vi.mocked(getVideoMeta).mock.calls.flatMap((c) => c[1])).toEqual(["good0000001"]);
    expect(await removals(env)).toEqual([]);
    expect((await row(env, setUrl(2)))!.video_id).toBe("wait0000001");
    // The comparison does not look for it in the playlist either.
    listing({ [PL]: ["good0000001"], [PLC]: ["good0000001"] });
    const [c] = await comparePlaylists(env, "tok", { log });
    expect(c).toMatchObject({ missing: 0 });
    expect(await removals(env)).toEqual([]);
    expect((await row(env, setUrl(2)))!.video_id).toBe("wait0000001");
  });

  it("dry run (the default) only reports, from facts and video meta, and never deletes", async () => {
    const env = makeEnv({ REJECT_VERTICAL: "1" });
    await seedMix(env);
    const r = await runRemovalSweep(env, "tok", { log });
    expect(r).toMatchObject({ dryRun: true, candidates: 3, rejected: 2, reported: 2, deletes: 0 });
    expect(removeVideoFromPlaylist).not.toHaveBeenCalled();
    const rows = await removals(env);
    expect(rows.map((x) => [x.video_id, x.playlist_kind, x.status, x.reason])).toEqual([
      ["notc0000001", "artist", "would_remove", "notice"],
      ["notc0000001", "combined", "would_remove", "notice"],
      ["vert0000001", "artist", "would_remove", "vertical"],
      ["vert0000001", "combined", "would_remove", "vertical"],
    ]);
    expect((await row(env, setUrl(2)))!.video_id).toBe("notc0000001");
    // A second dry run does not duplicate the report.
    await runRemovalSweep(env, "tok", { log });
    expect(await removals(env)).toHaveLength(4);
  });

  it("live: removes from both playlists, logs, clears the set so the recheck queues mkvid", async () => {
    const env = makeEnv({ REJECT_VERTICAL: "1" });
    await seedMix(env);
    const r = await runRemovalSweep(env, "tok", {
      log,
      settings: { dryRun: false, dailyRemovals: 40 },
    });
    expect(r).toMatchObject({ dryRun: false, rejected: 2, removedVideos: 2, deletes: 4 });
    expect(vi.mocked(removeVideoFromPlaylist).mock.calls.map((c) => [c[0], c[1]])).toEqual([
      [PL, "notc0000001"],
      [PLC, "notc0000001"],
      [PL, "vert0000001"],
      [PLC, "vert0000001"],
    ]);
    expect(await row(env, setUrl(2))).toMatchObject({
      video_id: null,
      video_known: 1,
      checked_at: 0,
    });
    expect((await row(env, setUrl(1)))!.video_id).toBe("good0000001");
    expect((await row(env, setUrl(4)))!.video_id).toBe("mkvd0000001");
    expect((await removals(env)).every((x) => x.status === "removed")).toBe(true);
    expect(await sweepDeletesUsed(env)).toBe(4);
  });

  it("stops at the daily delete budget and carries on the next day", async () => {
    const env = makeEnv({ REJECT_VERTICAL: "1" });
    await seedMix(env);
    const day1 = Date.parse("2026-10-01T12:00:00Z");
    const r1 = await runRemovalSweep(env, "tok", {
      log,
      settings: { dryRun: false, dailyRemovals: 3 },
      nowMs: day1,
    });
    expect(r1).toMatchObject({ removedVideos: 1, deletes: 2, stoppedBy: "budget" });
    const r2 = await runRemovalSweep(env, "tok", {
      log,
      settings: { dryRun: false, dailyRemovals: 3 },
      nowMs: day1 + 3600_000,
    });
    expect(r2).toMatchObject({ removedVideos: 0, stoppedBy: "budget", budgetLeft: 1 });
    const r3 = await runRemovalSweep(env, "tok", {
      log,
      settings: { dryRun: false, dailyRemovals: 3 },
      nowMs: day1 + 86400_000,
    });
    expect(r3).toMatchObject({ removedVideos: 1, deletes: 2, stoppedBy: null });
  });

  it("stops on a quota error without clearing the set", async () => {
    const env = makeEnv({ REJECT_VERTICAL: "1" });
    await seedMix(env);
    vi.mocked(removeVideoFromPlaylist).mockRejectedValue(
      new YouTubeApiError("playlistItems.delete", 403, "quotaExceeded", "{}"),
    );
    const r = await runRemovalSweep(env, "tok", {
      log,
      settings: { dryRun: false, dailyRemovals: 40 },
    });
    expect(r).toMatchObject({ stoppedBy: "quota", removedVideos: 0, failed: 1 });
    expect((await row(env, setUrl(2)))!.video_id).toBe("notc0000001");
    expect((await removals(env))[0]).toMatchObject({ status: "failed" });
  });

  it("skips overridden videos and leaves a shared video in the combined playlist", async () => {
    const env = makeEnv({ REJECT_VERTICAL: "1" });
    await seedMix(env);
    await setOverride(env, "vert0000001");
    // Another DJ's set (fine, no facts) resolves to the rejected video too.
    await seedSub(env, "other", "PLother");
    await seedSet(env, "https://www.1001tracklists.com/tracklist/9/other.html", "notc0000001", {
      slug: "other",
    });
    const r = await runRemovalSweep(env, "tok", {
      log,
      settings: { dryRun: false, dailyRemovals: 40 },
    });
    expect(r.rejected).toBe(1);
    expect(vi.mocked(removeVideoFromPlaylist).mock.calls.map((c) => c[0])).toEqual([PL]);
  });

  it("does not delete dead videos (the comparison records those)", async () => {
    const env = makeEnv({ REJECT_VERTICAL: "1" });
    await seedSub(env);
    await seedSet(env, setUrl(1), "dead0000001");
    metaAnswer({ dead0000001: { alive: false } });
    const r = await runRemovalSweep(env, "tok", {
      log,
      settings: { dryRun: false, dailyRemovals: 40 },
    });
    expect(r.rejected).toBe(0);
    expect(removeVideoFromPlaylist).not.toHaveBeenCalled();
  });
});

async function seedFive(env: Env) {
  await seedSub(env);
  for (let i = 1; i <= 10; i++)
    await seedSet(env, setUrl(i), `vid${String(i).padStart(8, "0")}`, { pos: i });
}
const ids = (n: number[]) => n.map((i) => `vid${String(i).padStart(8, "0")}`);

describe("comparePlaylists", () => {
  it("records a video missing from the artist playlist as owner-removed, clears its set and never re-adds it", async () => {
    const env = makeEnv();
    await seedFive(env);
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6, 7, 8, 9]) });
    const [r] = await comparePlaylists(env, "tok", { log });
    expect(r).toMatchObject({
      kind: "artist",
      status: "ok",
      expected: 10,
      missing: 1,
      owner: 1,
      dead: 0,
    });
    expect(await isBlocked(env, PL, "vid00000010")).toBe(true);
    expect(await row(env, setUrl(10))).toMatchObject({
      video_id: null,
      video_known: 1,
      checked_at: 0,
    });
    expect((await removals(env))[0]).toMatchObject({
      source: "owner",
      status: "recorded",
      video_id: "vid00000010",
    });
    // Next run: nothing new.
    const [again] = await comparePlaylists(env, "tok", { log });
    expect(again).toMatchObject({ missing: 0, owner: 0 });
  });

  it('labels a missing video that is gone from YouTube as dead, and a present "Deleted video" item too', async () => {
    const env = makeEnv();
    await seedFive(env);
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6, 7, 8, 9]) }, { deadTitles: ["vid00000001"] });
    metaAnswer({ vid00000010: { alive: false } });
    const [r] = await comparePlaylists(env, "tok", { log });
    expect(r).toMatchObject({ missing: 1, owner: 0, dead: 2 });
    expect(vi.mocked(getVideoMeta).mock.calls[0]![3]).toMatchObject({ maxAgeSeconds: 0 });
    expect((await blockedIds(env, PL)).size).toBe(2);
  });

  it("treats removals made before it existed the same way on its first run", async () => {
    const env = makeEnv();
    await seedFive(env);
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6, 7, 8]) });
    const [r] = await comparePlaylists(env, "tok", { log });
    expect(r).toMatchObject({ status: "ok", owner: 2 });
  });

  it("never reads an incomplete or failed listing as removals", async () => {
    const env = makeEnv();
    await seedFive(env);
    listing({ [PL]: [] }, { incomplete: [PL] });
    expect((await comparePlaylists(env, "tok", { log }))[0]).toMatchObject({
      status: "incomplete",
    });
    listing({}, { throws: [PL] });
    expect((await comparePlaylists(env, "tok", { log }))[0]).toMatchObject({
      status: "incomplete",
    });
    expect(await removals(env)).toHaveLength(0);
    expect((await row(env, setUrl(1)))!.video_id).toBe("vid00000001");
  });

  it("holds a playlist that seems to have lost more than 30%, pushes once, and applies after approval", async () => {
    const env = makeEnv();
    await seedFive(env);
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6]) });
    const notify = vi.fn(async () => {});
    expect((await comparePlaylists(env, "tok", { log, notify }))[0]).toMatchObject({
      status: "held",
      missing: 4,
    });
    expect((await comparePlaylists(env, "tok", { log, notify }))[0]).toMatchObject({
      status: "held",
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(await removals(env)).toHaveLength(0);
    expect(await listHolds(env)).toMatchObject([
      { playlistId: PL, missing: 4, expected: 10, notified: true },
    ]);
    expect(await approveHold(env, PL)).toBe(true);
    expect((await comparePlaylists(env, "tok", { log, notify }))[0]).toMatchObject({
      status: "ok",
      owner: 4,
    });
    expect(await listHolds(env)).toEqual([]);
    expect(await approveHold(env, PL)).toBe(false);
  });

  it("holds above 30% or above 5 missing, whatever the playlist size (M3)", async () => {
    expect(isMassRemoval(0, 10)).toBe(false);
    expect(isMassRemoval(3, 10)).toBe(false);
    expect(isMassRemoval(4, 10)).toBe(true);
    expect(isMassRemoval(1, 10)).toBe(false);
    expect(isMassRemoval(2, 2)).toBe(true); // small playlists no longer slip under a minimum
    expect(isMassRemoval(1, 1)).toBe(true);
    expect(isMassRemoval(5, 100)).toBe(false);
    expect(isMassRemoval(6, 100)).toBe(true);
  });

  it("combined: first run only snapshots; later a missing member is recorded for the combined playlist only", async () => {
    const env = makeEnv();
    await seedFive(env);
    await seedCombined(env);
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), [PLC]: ids([1, 2, 3, 4, 5]) });
    const first = await comparePlaylists(env, "tok", { log });
    expect(first[1]).toMatchObject({ kind: "combined", status: "first_snapshot" });
    // The backfill lag (6-10 absent) is not a removal. The owner then removes 5.
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), [PLC]: ids([1, 2, 3, 4, 6]) });
    const second = await comparePlaylists(env, "tok", { log });
    expect(second[1]).toMatchObject({ kind: "combined", status: "ok", missing: 1, owner: 1 });
    expect(await isBlocked(env, PLC, "vid00000005")).toBe(true);
    expect(await isBlocked(env, PL, "vid00000005")).toBe(false);
    // Combined-only removal leaves the set's video alone.
    expect((await row(env, setUrl(5)))!.video_id).toBe("vid00000005");
  });
});

describe("dead videos still in a playlist (deleted, or made private by their uploader)", () => {
  const LIVE = { PLAYLIST_SWEEP_DRY_RUN: "0" };
  const GONE = "gone0000001";
  const DAYS = 86400;
  const T = Math.floor(Date.parse("2026-10-01T12:00:00Z") / 1000);
  const TEN = ids([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const deleted = () => vi.mocked(deletePlaylistItem).mock.calls.map((c) => c[0]);
  const seen = async (env: Env) =>
    ((await env.SUBS.get("hygiene:dead:seen", "json")) ?? {}) as Record<string, number>;
  /** These videos were first seen dead long ago and have stayed so: their wait is over. */
  const waited = (env: Env, videoIds: string[], playlists = [PL]) =>
    env.SUBS.put(
      "hygiene:dead:seen",
      JSON.stringify(
        Object.fromEntries(playlists.flatMap((pl) => videoIds.map((id) => [`${pl} ${id}`, 1]))),
      ),
    );

  describe("the wait: a video must stay dead for three days before it is taken out", () => {
    it("live: a private video nobody added through tracked waits, shown once as waiting, and is taken out after three days", async () => {
      const env = makeEnv(LIVE);
      await seedFive(env);
      // The FISHER case: in the playlist, in no table of tracked's.
      listing({ [PL]: [...TEN, GONE] }, { as: { [GONE]: "private" } });
      metaAnswer({ [GONE]: { alive: false } });
      const [r] = await comparePlaylists(env, "tok", { log, now: T });
      expect(r).toMatchObject({
        status: "ok",
        missing: 0,
        owner: 0,
        dead: 0,
        deadReported: 1,
        deadRemoved: 0,
      });
      expect(deletePlaylistItem).not.toHaveBeenCalled();
      expect(await removals(env)).toMatchObject([
        {
          source: "dead",
          status: "would_remove",
          reason: "dead",
          slug: SLUG,
          set_url: null,
          video_id: GONE,
          playlist_id: PL,
          playlist_kind: "artist",
          at: T,
          detail:
            "looks deleted or private since 2026-10-01; removed after 3 days if it stays that way",
        },
      ]);
      expect(await isBlocked(env, PL, GONE)).toBe(false);
      expect(await seen(env)).toEqual({ [`${PL} ${GONE}`]: T });
      // Every later comparison inside the wait: nothing deleted, and the row keeps the time it was first seen.
      for (const later of [6 * 3600, DAYS, 3 * DAYS - 60]) {
        expect((await comparePlaylists(env, "tok", { log, now: T + later }))[0]).toMatchObject({
          deadReported: 1,
          deadRemoved: 0,
        });
        expect(deletePlaylistItem).not.toHaveBeenCalled();
        expect(await removals(env)).toMatchObject([{ status: "would_remove", at: T }]);
      }
      // Three days on, still dead.
      expect((await comparePlaylists(env, "tok", { log, now: T + 3 * DAYS }))[0]).toMatchObject({
        deadRemoved: 1,
        deadReported: 0,
      });
      expect(deleted()).toEqual([`item-${GONE}`]);
      expect(await removals(env)).toMatchObject([
        {
          source: "dead",
          status: "removed",
          video_id: GONE,
          at: T + 3 * DAYS,
          detail: "deleted or private since 2026-10-01; taken out of the playlist",
        },
      ]);
      expect(await isBlocked(env, PL, GONE)).toBe(true);
      expect(await seen(env)).toEqual({});
    });

    it("a video that is back restarts the wait: its waiting row goes, and dying again later starts from that day", async () => {
      const env = makeEnv(LIVE);
      await seedFive(env);
      listing({ [PL]: [...TEN, GONE] }, { as: { [GONE]: "private" } });
      metaAnswer({ [GONE]: { alive: false } });
      await comparePlaylists(env, "tok", { log, now: T });
      expect(await removals(env)).toHaveLength(1);
      // Two days later the uploader has made it public again.
      listing({ [PL]: [...TEN, GONE] }, { as: { [GONE]: "public" } });
      metaAnswer({});
      await comparePlaylists(env, "tok", { log, now: T + 2 * DAYS });
      expect(await removals(env)).toEqual([]);
      expect(await seen(env)).toEqual({});
      // Private again on day 4: four days after the first sighting, but only now dead again.
      listing({ [PL]: [...TEN, GONE] }, { as: { [GONE]: "private" } });
      metaAnswer({ [GONE]: { alive: false } });
      await comparePlaylists(env, "tok", { log, now: T + 4 * DAYS });
      expect(deletePlaylistItem).not.toHaveBeenCalled();
      expect(await removals(env)).toMatchObject([{ status: "would_remove", at: T + 4 * DAYS }]);
      await comparePlaylists(env, "tok", { log, now: T + 6 * DAYS });
      expect(deletePlaylistItem).not.toHaveBeenCalled();
      await comparePlaylists(env, "tok", { log, now: T + 7 * DAYS });
      expect(deleted()).toEqual([`item-${GONE}`]);
    });

    it("the wait also restarts when videos.list returns the video again, or the owner takes it out of the playlist", async () => {
      const env = makeEnv(LIVE);
      await seedFive(env);
      listing(
        { [PL]: [...TEN, "gone000000a", "gone000000b"] },
        { as: { gone000000a: "private", gone000000b: "private" } },
      );
      metaAnswer({ gone000000a: { alive: false }, gone000000b: { alive: false } });
      await comparePlaylists(env, "tok", { log, now: T });
      expect(Object.keys(await seen(env))).toHaveLength(2);
      // a: the listing still calls it private, videos.list returns it. b: gone from the playlist.
      listing({ [PL]: [...TEN, "gone000000a"] }, { as: { gone000000a: "private" } });
      metaAnswer({});
      await comparePlaylists(env, "tok", { log, now: T + DAYS });
      expect(await seen(env)).toEqual({});
      expect(await removals(env)).toEqual([]);
      expect(deletePlaylistItem).not.toHaveBeenCalled();
    });

    it("a comparison that learns nothing (lookup failed, incomplete or held listing, quota out) neither starts nor ends a wait", async () => {
      const env = makeEnv(LIVE);
      await seedFive(env);
      listing({ [PL]: [...TEN, GONE] }, { as: { [GONE]: "private" } });
      metaAnswer({ [GONE]: { alive: false } });
      await comparePlaylists(env, "tok", { log, now: T });
      const before = await seen(env);
      vi.mocked(getVideoMeta).mockRejectedValue(new Error("youtube videos.list 500"));
      await comparePlaylists(env, "tok", { log, now: T + DAYS });
      metaAnswer({ [GONE]: { alive: false } });
      listing({ [PL]: TEN }, { incomplete: [PL] });
      await comparePlaylists(env, "tok", { log, now: T + DAYS });
      listing({ [PL]: ids([1, 2, 3, 4, 5, 6]) });
      expect((await comparePlaylists(env, "tok", { log, now: T + DAYS }))[0]).toMatchObject({
        status: "held",
      });
      expect(await seen(env)).toEqual(before);
      expect(await removals(env)).toMatchObject([{ status: "would_remove", at: T }]);
    });

    it("dry run: reported once as staying, nothing deleted however long it is dead; going live later takes it out, the days already counted", async () => {
      const env = makeEnv();
      await seedFive(env);
      listing({ [PL]: [...TEN, GONE] }, { as: { [GONE]: "private" } });
      metaAnswer({ [GONE]: { alive: false } });
      for (const later of [0, 4 * DAYS, 30 * DAYS]) {
        expect((await comparePlaylists(env, "tok", { log, now: T + later }))[0]).toMatchObject({
          deadReported: 1,
          deadRemoved: 0,
        });
      }
      expect(deletePlaylistItem).not.toHaveBeenCalled();
      expect(await removals(env)).toMatchObject([
        {
          source: "dead",
          status: "would_remove",
          at: T,
          detail: "looks deleted or private since 2026-10-01; dry run: it stays in the playlist",
        },
      ]);
      expect(await sweepDeletesUsed(env, (T + 30 * DAYS) * 1000)).toBe(0);
      env.PLAYLIST_SWEEP_DRY_RUN = "0";
      expect((await comparePlaylists(env, "tok", { log, now: T + 31 * DAYS }))[0]).toMatchObject({
        deadRemoved: 1,
      });
      expect(deleted()).toEqual([`item-${GONE}`]);
    });

    it("a row the comparison already recorded for a dead video is left as it is while it waits (no burst of re-dated rows), then becomes removed", async () => {
      const env = makeEnv(LIVE);
      await seedFive(env);
      listing({ [PL]: TEN }, { as: { vid00000003: "deleted" } });
      metaAnswer({ vid00000003: { alive: false } });
      const [r] = await comparePlaylists(env, "tok", { log, now: T });
      expect(r).toMatchObject({ dead: 1, deadReported: 1, deadRemoved: 0 });
      const first = await removals(env);
      expect(first).toMatchObject([
        { source: "dead", status: "recorded", video_id: "vid00000003" },
      ]);
      await comparePlaylists(env, "tok", { log, now: T + DAYS });
      expect(await removals(env)).toEqual(first);
      await comparePlaylists(env, "tok", { log, now: T + 3 * DAYS });
      expect(await removals(env)).toMatchObject([
        { source: "dead", status: "removed", video_id: "vid00000003", at: T + 3 * DAYS },
      ]);
    });
  });

  it("live: takes it out by the item id of the listing, logs it as removed, never re-adds it, and counts the delete against the sweep budget", async () => {
    const env = makeEnv(LIVE);
    await seedFive(env);
    await waited(env, [GONE]);
    listing({ [PL]: [...TEN, GONE] }, { as: { [GONE]: "private" } });
    metaAnswer({ [GONE]: { alive: false } });
    const [r] = await comparePlaylists(env, "tok", { log });
    expect(r).toMatchObject({ status: "ok", missing: 0, deadRemoved: 1, deadReported: 0 });
    expect(deleted()).toEqual([`item-${GONE}`]);
    // Not the lookup by video id: YouTube answers videoNotFound to that for exactly these videos.
    expect(removeVideoFromPlaylist).not.toHaveBeenCalled();
    // Asked a second time, fresh, before it is believed.
    expect(vi.mocked(getVideoMeta).mock.calls.at(-1)![1]).toEqual([GONE]);
    expect(vi.mocked(getVideoMeta).mock.calls.at(-1)![3]).toMatchObject({ maxAgeSeconds: 0 });
    expect(await removals(env)).toMatchObject([
      {
        source: "dead",
        status: "removed",
        reason: "dead",
        video_id: GONE,
        playlist_id: PL,
        set_url: null,
      },
    ]);
    expect(await isBlocked(env, PL, GONE)).toBe(true);
    expect((await confirmedMembership(env, PL)).get(GONE)).toBe("out");
    expect(await sweepDeletesUsed(env)).toBe(1);
    // No set lost anything.
    for (let i = 1; i <= 10; i++) expect((await row(env, setUrl(i)))!.video_id).toBe(ids([i])[0]);
    // Gone from the playlist: the next comparison has nothing to say about it.
    listing({ [PL]: TEN });
    expect((await comparePlaylists(env, "tok", { log }))[0]).toMatchObject({
      status: "ok",
      missing: 0,
      owner: 0,
      dead: 0,
    });
    expect(deleted()).toHaveLength(1);
  });

  it("live: a dead video the sync added leaves both playlists, and its set is cleared and due (the recheck queues mkvid)", async () => {
    const env = makeEnv(LIVE);
    await seedFive(env);
    await seedCombined(env);
    await savePlaylistMembers(env, PLC, new Set(TEN), 1);
    await waited(env, ["vid00000003"], [PL, PLC]);
    listing({ [PL]: TEN, [PLC]: TEN }, { as: { vid00000003: "deleted" } });
    metaAnswer({ vid00000003: { alive: false } });
    const r = await comparePlaylists(env, "tok", { log });
    expect(r[0]).toMatchObject({ kind: "artist", status: "ok", dead: 1, deadRemoved: 1 });
    expect(r[1]).toMatchObject({ kind: "combined", status: "ok", dead: 1, deadRemoved: 1 });
    expect(deleted()).toEqual(["item-vid00000003", "item-vid00000003"]);
    expect(await row(env, setUrl(3))).toMatchObject({
      video_id: null,
      video_known: 1,
      checked_at: 0,
    });
    // One row per playlist: the comparison's "recorded" became "removed".
    expect(await removals(env)).toMatchObject([
      {
        source: "dead",
        status: "removed",
        video_id: "vid00000003",
        playlist_id: PL,
        playlist_kind: "artist",
        set_url: setUrl(3),
      },
      {
        source: "dead",
        status: "removed",
        video_id: "vid00000003",
        playlist_id: PLC,
        playlist_kind: "combined",
      },
    ]);
    expect(await sweepDeletesUsed(env)).toBe(2);
    // Its absence afterwards is tracked's own doing, never the owner's.
    listing({
      [PL]: TEN.filter((id) => id !== "vid00000003"),
      [PLC]: TEN.filter((id) => id !== "vid00000003"),
    });
    const again = await comparePlaylists(env, "tok", { log });
    expect(again[0]).toMatchObject({ missing: 0, owner: 0, dead: 0 });
    expect(again[1]).toMatchObject({ missing: 0, owner: 0, dead: 0 });
    expect((await removals(env)).filter((x) => x.source === "owner")).toEqual([]);
  });

  it("never takes out a video that is public or unlisted, the owner's own private upload, or one videos.list still returns", async () => {
    const env = makeEnv(LIVE);
    await seedFive(env);
    await waited(env, ["vid00000001", "own00000001", "unl00000001", "back0000001"]);
    listing(
      { [PL]: [...TEN, "own00000001", "unl00000001", "back0000001"] },
      {
        as: {
          vid00000001: "public",
          own00000001: "ownPrivate",
          unl00000001: "unlistedNamedPrivate",
          back0000001: "private",
        },
      },
    );
    // `back...` lists as private and videos.list returns it: the two do not agree, so it stays.
    metaAnswer({});
    const [r] = await comparePlaylists(env, "tok", { log });
    expect(r).toMatchObject({ status: "ok", dead: 0 });
    expect(r!.deadRemoved ?? 0).toBe(0);
    expect(deletePlaylistItem).not.toHaveBeenCalled();
    expect(await removals(env)).toEqual([]);
  });

  it("removes nothing when the second look fails, and nothing from an incomplete, failed or held listing", async () => {
    const env = makeEnv(LIVE);
    await seedFive(env);
    await waited(env, [GONE]);
    const withGone = [...TEN, GONE];
    listing({ [PL]: withGone }, { as: { [GONE]: "private" } });
    vi.mocked(getVideoMeta).mockRejectedValue(new Error("youtube videos.list 500"));
    await comparePlaylists(env, "tok", { log });
    metaAnswer({ [GONE]: { alive: false } });
    listing({ [PL]: withGone }, { as: { [GONE]: "private" }, incomplete: [PL] });
    expect((await comparePlaylists(env, "tok", { log }))[0]).toMatchObject({
      status: "incomplete",
    });
    listing({ [PL]: withGone }, { as: { [GONE]: "private" }, throws: [PL] });
    expect((await comparePlaylists(env, "tok", { log }))[0]).toMatchObject({
      status: "incomplete",
    });
    // Four of the DJ's ten videos missing: the playlist is held, and a held playlist is not touched at all.
    listing({ [PL]: [...ids([1, 2, 3, 4, 5, 6]), GONE] }, { as: { [GONE]: "private" } });
    expect((await comparePlaylists(env, "tok", { log }))[0]).toMatchObject({ status: "held" });
    expect(deletePlaylistItem).not.toHaveBeenCalled();
    expect(await removals(env)).toEqual([]);
  });

  describe("many dead at once", () => {
    const many = ["a", "b", "c", "d", "e"].map((x) => `gone000000${x}`);
    const allPrivate = Object.fromEntries(many.map((id) => [id, "private" as const]));
    const allDead = Object.fromEntries(many.map((id) => [id, { alive: false }]));

    it("five or more that are over 30% of a playlist are not taken out: the playlist is held, shown on the Removed page, until the owner approves those videos", async () => {
      const env = makeEnv(LIVE);
      await seedSub(env);
      await waited(env, many);
      listing({ [PL]: [...ids([1, 2, 3, 4, 5]), ...many] }, { as: allPrivate });
      metaAnswer(allDead);
      expect((await comparePlaylists(env, "tok", { log, now: T }))[0]).toMatchObject({
        deadRemoved: 0,
        deadReported: 5,
      });
      expect(deletePlaylistItem).not.toHaveBeenCalled();
      expect(await listDeadHolds(env)).toEqual([
        {
          playlistId: PL,
          kind: "artist",
          slug: SLUG,
          items: 10,
          dead: 5,
          deadIds: [...many].sort(),
          at: T,
        },
      ]);
      // Held again six hours on: the same hold, not a new one.
      await comparePlaylists(env, "tok", { log, now: T + 6 * 3600 });
      expect(await listDeadHolds(env)).toMatchObject([{ at: T }]);
      // The page gets it, and its button approves it.
      const { app } = await import("../src/index");
      const before = await app.request("http://x/ui/api/removals", {}, env);
      expect(((await before.json()) as any).deadHolds).toMatchObject([
        { playlistId: PL, dead: 5, items: 10 },
      ]);
      const approve = () =>
        app.request(
          `http://x/ui/api/removals/dead-holds/${PL}/approve`,
          {
            method: "POST",
            headers: { origin: "http://x", "content-type": "application/json" },
            body: "{}",
          },
          env,
        );
      expect((await approve()).status).toBe(200);
      expect((await approve()).status).toBe(404);
      expect(await listDeadHolds(env)).toEqual([]);
      expect((await comparePlaylists(env, "tok", { log, now: T + 12 * 3600 }))[0]).toMatchObject({
        deadRemoved: 5,
      });
      expect(deleted()).toEqual(many.map((id) => `item-${id}`));
      expect(await listDeadHolds(env)).toEqual([]);
    });

    it("an approval covers the videos it showed, some or all of them, and no others", async () => {
      const env = makeEnv({ ...LIVE, PLAYLIST_SWEEP_DAILY_REMOVALS: "2" });
      await seedSub(env);
      const more = [...many, "gone000000f"];
      await waited(env, more);
      listing({ [PL]: [...ids([1, 2, 3, 4, 5]), ...many] }, { as: allPrivate });
      metaAnswer({ ...allDead, gone000000f: { alive: false } });
      await comparePlaylists(env, "tok", { log, now: T });
      expect(await approveDeadHold(env, PL, T)).toBe(true);
      // The budget lets two go today; the three left are still covered tomorrow, though they are no longer five.
      expect((await comparePlaylists(env, "tok", { log, now: T + 3600 }))[0]).toMatchObject({
        deadRemoved: 2,
      });
      // A sixth dead video that the owner never saw: held again, nothing more goes.
      listing(
        {
          [PL]: [
            ...ids([1, 2, 3, 4, 5]),
            ...many.slice(2),
            "gone000000f",
            "gone000000g",
            "gone000000h",
          ],
        },
        {
          as: {
            ...allPrivate,
            gone000000f: "private",
            gone000000g: "private",
            gone000000h: "private",
          },
        },
      );
      metaAnswer({
        ...allDead,
        gone000000f: { alive: false },
        gone000000g: { alive: false },
        gone000000h: { alive: false },
      });
      expect(
        (await comparePlaylists(env, "tok", { log, now: T + DAYS }))[0]!.deadRemoved ?? 0,
      ).toBe(0);
      expect(await listDeadHolds(env)).toMatchObject([{ dead: 6 }]);
      expect(deleted()).toHaveLength(2);
    });

    it("five of twenty are believed, and so are two of three: a small playlist is not stuck with its husks", async () => {
      const env = makeEnv(LIVE);
      await seedSub(env);
      await waited(env, [...many, "gone000000x", "gone000000y"]);
      listing(
        { [PL]: [...ids([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]), ...many] },
        { as: allPrivate },
      );
      metaAnswer(allDead);
      expect((await comparePlaylists(env, "tok", { log }))[0]).toMatchObject({ deadRemoved: 5 });
      expect(await listDeadHolds(env)).toEqual([]);
      vi.mocked(deletePlaylistItem).mockClear();
      await waited(env, ["gone000000x", "gone000000y"]);
      listing(
        { [PL]: ["vid00000001", "gone000000x", "gone000000y"] },
        { as: { gone000000x: "deleted", gone000000y: "private" } },
      );
      metaAnswer({ gone000000x: { alive: false }, gone000000y: { alive: false } });
      expect((await comparePlaylists(env, "tok", { log }))[0]).toMatchObject({ deadRemoved: 2 });
      expect(deleted()).toEqual(["item-gone000000x", "item-gone000000y"]);
    });
  });

  describe("the daily budget", () => {
    const two = ["gone000000a", "gone000000b"];
    const twoDead = { gone000000a: { alive: false }, gone000000b: { alive: false } };

    it("stops at the sweep's daily budget, which the sweep in the same tick shares, and carries on the next day", async () => {
      const env = makeEnv({ ...LIVE, PLAYLIST_SWEEP_DAILY_REMOVALS: "1" });
      await seedFive(env);
      await waited(env, two);
      listing(
        { [PL]: [...TEN, ...two] },
        { as: { gone000000a: "private", gone000000b: "deleted" } },
      );
      metaAnswer(twoDead);
      expect((await comparePlaylists(env, "tok", { log, now: T }))[0]).toMatchObject({
        deadRemoved: 1,
      });
      expect(deleted()).toEqual(["item-gone000000a"]);
      expect(await sweepDeletesUsed(env, T * 1000)).toBe(1);
      // The sweep that follows finds the day's budget spent.
      expect(await runRemovalSweep(env, "tok", { log, nowMs: T * 1000 })).toMatchObject({
        dryRun: false,
        budget: 1,
        budgetLeft: 0,
      });
      listing({ [PL]: [...TEN, "gone000000b"] }, { as: { gone000000b: "deleted" } });
      expect(
        (await comparePlaylists(env, "tok", { log, now: T + 6 * 3600 }))[0]!.deadRemoved ?? 0,
      ).toBe(0);
      expect((await comparePlaylists(env, "tok", { log, now: T + DAYS }))[0]).toMatchObject({
        deadRemoved: 1,
      });
      expect(deleted()).toEqual(["item-gone000000a", "item-gone000000b"]);
    });

    it("is charged once, before the first delete, for everything the run takes out: one write to the counter, not one per delete", async () => {
      const env = makeEnv(LIVE);
      await seedFive(env);
      await waited(env, two);
      listing(
        { [PL]: [...TEN, ...two] },
        { as: { gone000000a: "private", gone000000b: "private" } },
      );
      metaAnswer(twoDead);
      const put = vi.spyOn(env.CACHE, "put");
      const order: string[] = [];
      put.mockImplementation(
        async (key: string) =>
          void order.push(`put ${key.startsWith("hygiene:sweep:deletes:") ? "counter" : "other"}`),
      );
      vi.mocked(deletePlaylistItem).mockImplementation(
        async (itemId: string) => void order.push(`delete ${itemId}`),
      );
      expect((await comparePlaylists(env, "tok", { log, now: T }))[0]).toMatchObject({
        deadRemoved: 2,
      });
      expect(order.filter((x) => x !== "put other")).toEqual([
        "put counter",
        "delete item-gone000000a",
        "delete item-gone000000b",
      ]);
    });

    it("when the counter cannot be written nothing is deleted: the budget is never overspent", async () => {
      const env = makeEnv(LIVE);
      await seedFive(env);
      await waited(env, two);
      listing(
        { [PL]: [...TEN, ...two] },
        { as: { gone000000a: "private", gone000000b: "private" } },
      );
      metaAnswer(twoDead);
      const realPut = env.CACHE.put.bind(env.CACHE);
      vi.spyOn(env.CACHE, "put").mockImplementation(async (key: string, ...rest: any[]) => {
        if (key.startsWith("hygiene:sweep:deletes:"))
          throw new Error("KV PUT failed: 429 Too Many Requests");
        return (realPut as any)(key, ...rest);
      });
      expect((await comparePlaylists(env, "tok", { log, now: T }))[0]!.deadRemoved ?? 0).toBe(0);
      expect(deletePlaylistItem).not.toHaveBeenCalled();
      expect((await removals(env)).filter((x) => x.status === "removed")).toEqual([]);
      // Still waiting, with their days: the next comparison takes them.
      expect(Object.keys(await seen(env))).toHaveLength(2);
    });

    it("a KV write that throws after YouTube deleted (the refund of a delete that did not happen) costs no bookkeeping: what was deleted is recorded in full", async () => {
      const env = makeEnv(LIVE);
      await seedFive(env);
      await waited(env, ["vid00000003", "gone000000b"]);
      listing(
        { [PL]: [...TEN, "gone000000b"] },
        { as: { vid00000003: "deleted", gone000000b: "private" } },
      );
      metaAnswer({ vid00000003: { alive: false }, gone000000b: { alive: false } });
      // The first delete works, the second is refused; then KV refuses the second write to the counter key (the refund).
      vi.mocked(deletePlaylistItem)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new YouTubeApiError("playlistItems.delete", 500, null, "oops"));
      const realPut = env.CACHE.put.bind(env.CACHE);
      let counterWrites = 0;
      vi.spyOn(env.CACHE, "put").mockImplementation(async (key: string, ...rest: any[]) => {
        if (key.startsWith("hygiene:sweep:deletes:") && ++counterWrites > 1)
          throw new Error("KV PUT failed: 429 Too Many Requests");
        return (realPut as any)(key, ...rest);
      });
      expect((await comparePlaylists(env, "tok", { log, now: T }))[0]).toMatchObject({
        deadRemoved: 1,
      });
      expect(counterWrites).toBe(2);
      expect((await removals(env)).map((x) => [x.video_id, x.status])).toEqual([
        ["vid00000003", "removed"],
      ]);
      expect(await isBlocked(env, PL, "vid00000003")).toBe(true);
      expect((await confirmedMembership(env, PL)).get("vid00000003")).toBe("out");
      expect(await row(env, setUrl(3))).toMatchObject({ video_id: null, checked_at: 0 });
      // The counter stays at what was charged (2), one more than was deleted: short, never over.
      expect(await sweepDeletesUsed(env, T * 1000)).toBe(2);
      // The refused one still waits and goes at the next comparison.
      expect(await seen(env)).toEqual({ [`${PL} gone000000b`]: 1 });
    });

    it("one step of the bookkeeping failing does not cost the others", async () => {
      const env = makeEnv(LIVE);
      await seedFive(env);
      listing({ [PL]: TEN }, { as: { vid00000003: "deleted" } });
      metaAnswer({ vid00000003: { alive: false } });
      // The comparison's own record of it comes first (it blocks the video and clears the set); the block is then lost,
      // so the removal has to write it again, and that write fails.
      await comparePlaylists(env, "tok", { log, now: T - DAYS });
      await env.DB.prepare("DELETE FROM removed_videos").run();
      await env.SUBS.put("hygiene:dead:seen", JSON.stringify({ [`${PL} vid00000003`]: 1 }));
      const realPrepare = env.DB.prepare.bind(env.DB);
      const spy = vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
        if (/INSERT INTO removed_videos/.test(sql)) throw new Error("D1_ERROR: boom");
        return realPrepare(sql);
      });
      expect((await comparePlaylists(env, "tok", { log, now: T }))[0]).toMatchObject({
        deadRemoved: 1,
      });
      spy.mockRestore();
      expect(deleted()).toEqual(["item-vid00000003"]);
      expect(await isBlocked(env, PL, "vid00000003")).toBe(false);
      // The steps after the one that failed were still made.
      expect(await removals(env)).toMatchObject([
        { source: "dead", status: "removed", video_id: "vid00000003", at: T },
      ]);
      expect((await confirmedMembership(env, PL)).get("vid00000003")).toBe("out");
    });
  });

  it("asks and deletes nothing while the quota is out, and a daily-quota reply to a delete sets the hold", async () => {
    const env = makeEnv(LIVE);
    await seedFive(env);
    await waited(env, [GONE]);
    listing({ [PL]: [...TEN, GONE] }, { as: { [GONE]: "private" } });
    metaAnswer({ [GONE]: { alive: false } });
    const nowS = Math.floor(Date.now() / 1000);
    await env.CACHE.put("yt:quota:out", JSON.stringify({ since: nowS, until: nowS + 3600 }));
    await comparePlaylists(env, "tok", { log });
    expect(getVideoMeta).not.toHaveBeenCalled();
    expect(deletePlaylistItem).not.toHaveBeenCalled();
    await env.CACHE.delete("yt:quota:out");
    vi.mocked(deletePlaylistItem).mockRejectedValue(
      new YouTubeApiError("playlistItems.delete", 403, "quotaExceeded", "{}"),
    );
    expect((await comparePlaylists(env, "tok", { log }))[0]!.deadRemoved ?? 0).toBe(0);
    expect(await getQuotaOut(env)).not.toBeNull();
    // A refused delete is not logged as removed or failed: the video is still there, and the next comparison tries again.
    expect((await removals(env)).filter((x) => x.status !== "would_remove")).toEqual([]);
    expect(await isBlocked(env, PL, GONE)).toBe(false);
    // What was charged ahead for it was given back.
    expect(await sweepDeletesUsed(env)).toBe(0);
  });

  it("a delete YouTube refuses for another reason is tried again at the next comparison, and the others go on", async () => {
    const env = makeEnv(LIVE);
    await seedFive(env);
    await waited(env, ["gone000000a", "gone000000b"]);
    listing(
      { [PL]: [...TEN, "gone000000a", "gone000000b"] },
      { as: { gone000000a: "private", gone000000b: "private" } },
    );
    metaAnswer({ gone000000a: { alive: false }, gone000000b: { alive: false } });
    vi.mocked(deletePlaylistItem).mockRejectedValueOnce(
      new YouTubeApiError("playlistItems.delete", 500, null, "oops"),
    );
    expect((await comparePlaylists(env, "tok", { log }))[0]).toMatchObject({ deadRemoved: 1 });
    expect((await removals(env)).map((x) => [x.video_id, x.status])).toEqual([
      ["gone000000b", "removed"],
    ]);
    listing({ [PL]: [...TEN, "gone000000a"] }, { as: { gone000000a: "private" } });
    expect((await comparePlaylists(env, "tok", { log }))[0]).toMatchObject({ deadRemoved: 1 });
    expect((await removals(env)).map((x) => [x.video_id, x.status])).toEqual([
      ["gone000000b", "removed"],
      ["gone000000a", "removed"],
    ]);
  });

  it("leaves mkvid's own uploads to its gone check", async () => {
    const env = makeEnv(LIVE);
    await seedSub(env);
    await seedSet(env, setUrl(1), "mkUp0000001", { source: "mkvid" });
    await env.DB.prepare(
      "INSERT INTO mkvid_requests (id, slug, set_url, source, source_url, status, video_id, created_at, updated_at) VALUES ('r1', ?, ?, 'soundcloud', 'u', 'done', 'mkUp0000001', 0, 0)",
    )
      .bind(SLUG, setUrl(1))
      .run();
    await waited(env, ["mkUp0000001"]);
    listing({ [PL]: ["mkUp0000001"] }, { as: { mkUp0000001: "deleted" } });
    metaAnswer({ mkUp0000001: { alive: false } });
    await comparePlaylists(env, "tok", { log });
    expect(deletePlaylistItem).not.toHaveBeenCalled();
    expect(
      (await removals(env)).filter((x) => x.status === "removed" || x.status === "would_remove"),
    ).toEqual([]);
  });

  describe('a failure of the dead-video pass never stops the comparison and is never read as "no waits"', () => {
    it("when its setup cannot be read, dead videos are left alone and the comparison itself carries on: findings recorded, holds written, pushes sent", async () => {
      const env = makeEnv(LIVE);
      await seedFive(env);
      await seedSub(env, "dj2", "PLtwo");
      for (let i = 1; i <= 10; i++)
        await seedSet(
          env,
          `https://www.1001tracklists.com/tracklist/9${i}/dj2-set-2026-09-01.html`,
          `two${String(i).padStart(8, "0")}`,
          { slug: "dj2", pos: i, playlistId: "PLtwo" },
        );
      await waited(env, [GONE]);
      const stored = await env.SUBS.get("hygiene:dead:seen");
      // dj: one missing video and a dead one whose wait is over. dj2: lost four of ten, which is a hold.
      listing(
        {
          [PL]: [...ids([1, 2, 3, 4, 5, 6, 7, 8, 9]), GONE],
          PLtwo: [1, 2, 3, 4, 5, 6].map((i) => `two${String(i).padStart(8, "0")}`),
        },
        { as: { [GONE]: "private" } },
      );
      metaAnswer({ [GONE]: { alive: false } });
      const realGet = env.SUBS.get.bind(env.SUBS);
      vi.spyOn(env.SUBS, "get").mockImplementation((async (key: string, ...rest: any[]) => {
        if (key === "hygiene:dead:seen") throw new Error("KV GET failed: 500");
        return (realGet as any)(key, ...rest);
      }) as any);
      const notify = vi.fn(async () => {});
      const r = await comparePlaylists(env, "tok", { log, notify, now: T });
      expect(r[0]).toMatchObject({ slug: SLUG, status: "ok", missing: 1, owner: 1 });
      expect(r[1]).toMatchObject({ slug: "dj2", status: "held", missing: 4 });
      expect(await listHolds(env)).toMatchObject([
        { playlistId: "PLtwo", missing: 4, notified: true },
      ]);
      expect(notify).toHaveBeenCalledTimes(1);
      // Nothing about dead videos: no delete, no row, and the stored waits are exactly what they were.
      expect(deletePlaylistItem).not.toHaveBeenCalled();
      expect((await removals(env)).filter((x) => x.source === "dead")).toEqual([]);
      vi.restoreAllMocks();
      expect(await env.SUBS.get("hygiene:dead:seen")).toBe(stored);
    });

    it("a throw later in the comparison does not lose a wait that started earlier in it", async () => {
      const env = makeEnv(LIVE);
      await seedFive(env);
      await seedSub(env, "dj2", "PLtwo");
      for (let i = 1; i <= 10; i++)
        await seedSet(
          env,
          `https://www.1001tracklists.com/tracklist/9${i}/dj2-set-2026-09-01.html`,
          `two${String(i).padStart(8, "0")}`,
          { slug: "dj2", pos: i, playlistId: "PLtwo" },
        );
      // dj: a dead video seen for the first time. dj2: one video missing, and recording that throws.
      listing(
        {
          [PL]: [...TEN, GONE],
          PLtwo: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => `two${String(i).padStart(8, "0")}`),
        },
        { as: { [GONE]: "private" } },
      );
      metaAnswer({ [GONE]: { alive: false } });
      const realPrepare = env.DB.prepare.bind(env.DB);
      const spy = vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
        if (/INSERT INTO removed_videos/.test(sql)) throw new Error("D1_ERROR: boom");
        return realPrepare(sql);
      });
      await expect(comparePlaylists(env, "tok", { log, now: T })).rejects.toThrow("boom");
      spy.mockRestore();
      expect(await seen(env)).toEqual({ [`${PL} ${GONE}`]: T });
      // So the next comparison counts its days from T, not from itself.
      listing(
        {
          [PL]: [...TEN, GONE],
          PLtwo: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => `two${String(i).padStart(8, "0")}`),
        },
        { as: { [GONE]: "private" } },
      );
      expect((await comparePlaylists(env, "tok", { log, now: T + 3 * DAYS }))[0]).toMatchObject({
        deadRemoved: 1,
      });
    });

    it("a stored first-seen time that is not a past time (null, 0, negative, in the future, not a number) is no elapsed wait: that video starts over from now", async () => {
      const env = makeEnv(LIVE);
      await seedFive(env);
      const odd = {
        gone000000a: null,
        gone000000b: 0,
        gone000000c: -5,
        gone000000d: T + 86400,
        gone000000e: "yesterday",
        gone000000f: 1,
      };
      await env.SUBS.put(
        "hygiene:dead:seen",
        JSON.stringify(
          Object.fromEntries(Object.entries(odd).map(([id, at]) => [`${PL} ${id}`, at])),
        ),
      );
      // Six dead of 26: under the many-at-once guard.
      const filler = Array.from({ length: 10 }, (_, i) => `fill${String(i).padStart(7, "0")}`);
      listing(
        { [PL]: [...TEN, ...filler, ...Object.keys(odd)] },
        { as: Object.fromEntries(Object.keys(odd).map((id) => [id, "private" as const])) },
      );
      metaAnswer(Object.fromEntries(Object.keys(odd).map((id) => [id, { alive: false }])));
      expect((await comparePlaylists(env, "tok", { log, now: T }))[0]).toMatchObject({
        deadRemoved: 1,
        deadReported: 5,
      });
      // Only the one with a real past time went.
      expect(deleted()).toEqual(["item-gone000000f"]);
      expect(await seen(env)).toEqual(
        Object.fromEntries(["a", "b", "c", "d", "e"].map((x) => [`${PL} gone000000${x}`, T])),
      );
      expect(
        (await removals(env)).filter((x) => x.status === "would_remove").map((x) => x.at),
      ).toEqual([T, T, T, T, T]);
      // And they then wait their three days like any other.
      listing(
        { [PL]: [...TEN, ...filler, ...Object.keys(odd).slice(0, 5)] },
        { as: Object.fromEntries(Object.keys(odd).map((id) => [id, "private" as const])) },
      );
      await approveDeadHold(env, PL, T);
      expect(
        (await comparePlaylists(env, "tok", { log, now: T + 2 * DAYS }))[0]!.deadRemoved ?? 0,
      ).toBe(0);
      expect(deleted()).toHaveLength(1);
    });

    it("a stored value that is no map at all restarts every wait rather than deleting anything", async () => {
      const env = makeEnv(LIVE);
      await seedFive(env);
      await env.SUBS.put("hygiene:dead:seen", JSON.stringify([1, 2, 3]));
      listing({ [PL]: [...TEN, GONE] }, { as: { [GONE]: "private" } });
      metaAnswer({ [GONE]: { alive: false } });
      await comparePlaylists(env, "tok", { log, now: T });
      expect(deletePlaylistItem).not.toHaveBeenCalled();
      expect(await seen(env)).toEqual({ [`${PL} ${GONE}`]: T });
    });
  });

  describe("the delete count is handed on in memory: a KV read that lags a write cannot lose it", () => {
    /** Every read of the day's counter answers "nothing yet", as KV may for a key written seconds ago. The real value is `stored()`. */
    function laggingCounter(env: Env) {
      const realGet = env.CACHE.get.bind(env.CACHE);
      vi.spyOn(env.CACHE, "get").mockImplementation((async (key: string, ...rest: any[]) =>
        key.startsWith("hygiene:sweep:deletes:") ? null : (realGet as any)(key, ...rest)) as any);
      return async (nowS: number) =>
        Number(
          (await (realGet as any)(
            `hygiene:sweep:deletes:${new Date(nowS * 1000).toISOString().slice(0, 10)}`,
          )) ?? 0,
        );
    }

    it("the sweep of the same tick gets the count from the comparison, not from KV: the daily budget is not spent twice", async () => {
      const env = makeEnv({ ...LIVE, PLAYLIST_SWEEP_DAILY_REMOVALS: "2" });
      await seedFive(env);
      // The sweep would take vid...1 out (its page says it is no full recording); the comparison has two dead videos due.
      await saveSetFacts(env, facts(setUrl(1), { noFullNotice: true }));
      await waited(env, ["gone000000a", "gone000000b"]);
      listing(
        { [PL]: [...TEN, "gone000000a", "gone000000b"] },
        { as: { gone000000a: "private", gone000000b: "private" } },
      );
      metaAnswer({ gone000000a: { alive: false }, gone000000b: { alive: false } });
      const stored = laggingCounter(env);
      const r = await runPlaylistHygiene(env, log, { accessToken: "tok", nowMs: T * 1000 });
      expect(r.compare![0]).toMatchObject({ deadRemoved: 2 });
      expect(deleted()).toHaveLength(2);
      // The budget of 2 is spent; the sweep knows, although every read of the counter said 0.
      expect(r.sweep).toMatchObject({
        dryRun: false,
        rejected: 1,
        budget: 2,
        budgetLeft: 0,
        deletes: 0,
        stoppedBy: "budget",
      });
      expect(removeVideoFromPlaylist).not.toHaveBeenCalled();
      expect(await stored(T)).toBe(2);
    });

    it('the refund is the known "before plus deleted", never a re-read minus the unused: it cannot wipe the charge', async () => {
      const env = makeEnv(LIVE);
      await seedFive(env);
      await waited(env, ["gone000000a", "gone000000b", "gone000000c"]);
      listing(
        { [PL]: [...TEN, "gone000000a", "gone000000b", "gone000000c"] },
        { as: { gone000000a: "private", gone000000b: "private", gone000000c: "private" } },
      );
      metaAnswer({
        gone000000a: { alive: false },
        gone000000b: { alive: false },
        gone000000c: { alive: false },
      });
      // Five deletes were already made today, and KV shows them when the run starts; from then on its reads lag.
      await env.CACHE.put(
        `hygiene:sweep:deletes:${new Date(T * 1000).toISOString().slice(0, 10)}`,
        "5",
      );
      const realGet = env.CACHE.get.bind(env.CACHE);
      let reads = 0;
      vi.spyOn(env.CACHE, "get").mockImplementation((async (key: string, ...rest: any[]) =>
        key.startsWith("hygiene:sweep:deletes:") && ++reads > 1
          ? null
          : (realGet as any)(key, ...rest)) as any);
      const writes: string[] = [];
      const realPut = env.CACHE.put.bind(env.CACHE);
      vi.spyOn(env.CACHE, "put").mockImplementation((async (
        key: string,
        value: string,
        ...rest: any[]
      ) => {
        if (key.startsWith("hygiene:sweep:deletes:")) writes.push(value);
        return (realPut as any)(key, value, ...rest);
      }) as any);
      // The second of the three deletes is refused.
      vi.mocked(deletePlaylistItem)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new YouTubeApiError("playlistItems.delete", 500, null, "oops"))
        .mockResolvedValueOnce(undefined);
      const spend = { used: null as number | null };
      expect((await comparePlaylists(env, "tok", { log, now: T, spend }))[0]).toMatchObject({
        deadRemoved: 2,
      });
      // Charged 5 + 3 ahead, then set to 5 + 2: never below what was spent.
      expect(writes).toEqual(["8", "7"]);
      expect(spend.used).toBe(7);
    });

    it("the sweep's own deletes are counted on top of what it knows, not on a read that lags", async () => {
      const env = makeEnv({ REJECT_VERTICAL: "1" });
      await seedSub(env);
      await seedCombined(env);
      await seedSet(env, setUrl(2), "notc0000001", { pos: 1 });
      await seedSet(env, setUrl(3), "notc0000002", { pos: 2 });
      await saveSetFacts(env, facts(setUrl(2), { noFullNotice: true }));
      await saveSetFacts(env, facts(setUrl(3), { noFullNotice: true }));
      const stored = laggingCounter(env);
      const r = await runRemovalSweep(env, "tok", {
        log,
        settings: { dryRun: false, dailyRemovals: 40 },
        nowMs: T * 1000,
        usedAtLeast: 3,
      });
      expect(r).toMatchObject({ deletes: 4, budgetLeft: 33 });
      expect(await stored(T)).toBe(7);
    });
  });

  describe("a delete YouTube keeps refusing", () => {
    it("is left alone for a week after three refusals, says so on its row as plain information, and is then tried afresh", async () => {
      const env = makeEnv(LIVE);
      await seedFive(env);
      await waited(env, [GONE]);
      listing({ [PL]: [...TEN, GONE] }, { as: { [GONE]: "private" } });
      metaAnswer({ [GONE]: { alive: false } });
      vi.mocked(deletePlaylistItem).mockRejectedValue(
        new YouTubeApiError("playlistItems.delete", 403, "playlistItemsNotAccessible", "{}"),
      );
      const H6 = 6 * 3600;
      for (const at of [T, T + H6, T + 2 * H6])
        expect((await comparePlaylists(env, "tok", { log, now: at }))[0]!.deadRemoved ?? 0).toBe(0);
      expect(deletePlaylistItem).toHaveBeenCalledTimes(3);
      // Nothing was spent on them.
      expect(await sweepDeletesUsed(env, T * 1000)).toBe(0);
      // From the fourth comparison on it is not asked for, and the row says why and until when.
      for (const at of [T + 3 * H6, T + 4 * DAYS, T + 2 * H6 + 7 * DAYS - 60]) {
        expect((await comparePlaylists(env, "tok", { log, now: at }))[0]).toMatchObject({
          deadReported: 1,
        });
      }
      expect(deletePlaylistItem).toHaveBeenCalledTimes(3);
      const until = new Date((T + 2 * H6 + 7 * DAYS) * 1000).toISOString().slice(0, 10);
      expect(await removals(env)).toMatchObject([
        {
          source: "dead",
          status: "would_remove",
          video_id: GONE,
          detail: `looks deleted or private since 1970-01-01; YouTube refused to take it out 3 times, tried again after ${until}`,
        },
      ]);
      expect((await removals(env)).some((x) => x.status === "failed")).toBe(false);
      // A week after the last refusal: tried again, and this time YouTube does it.
      vi.mocked(deletePlaylistItem).mockReset().mockResolvedValue(undefined);
      expect(
        (await comparePlaylists(env, "tok", { log, now: T + 2 * H6 + 7 * DAYS }))[0],
      ).toMatchObject({ deadRemoved: 1 });
      expect(await removals(env)).toMatchObject([{ status: "removed", video_id: GONE }]);
      expect(await env.SUBS.get("hygiene:dead:refused", "json")).toEqual({});
    });

    it("a quota reply is not a refusal, and a video that is back forgets its refusals", async () => {
      const env = makeEnv(LIVE);
      await seedFive(env);
      await waited(env, [GONE]);
      listing({ [PL]: [...TEN, GONE] }, { as: { [GONE]: "private" } });
      metaAnswer({ [GONE]: { alive: false } });
      vi.mocked(deletePlaylistItem).mockRejectedValue(
        new YouTubeApiError("playlistItems.delete", 403, "quotaExceeded", "{}"),
      );
      await comparePlaylists(env, "tok", { log, now: T });
      expect(await env.SUBS.get("hygiene:dead:refused", "json")).toBeNull();
      await env.CACHE.delete("yt:quota:out");
      vi.mocked(deletePlaylistItem).mockRejectedValue(
        new YouTubeApiError("playlistItems.delete", 500, null, "oops"),
      );
      await comparePlaylists(env, "tok", { log, now: T + 3600 });
      expect(await env.SUBS.get("hygiene:dead:refused", "json")).toEqual({
        [`${PL} ${GONE}`]: { n: 1, at: T + 3600 },
      });
      listing({ [PL]: [...TEN, GONE] }, { as: { [GONE]: "public" } });
      metaAnswer({});
      await comparePlaylists(env, "tok", { log, now: T + 7200 });
      expect(await env.SUBS.get("hygiene:dead:refused", "json")).toEqual({});
    });
  });

  describe("the owner can undo", () => {
    it("Allow again on a recorded dead video while it waits sticks: the husk still goes after three days, but it is not put back on the never-add list", async () => {
      const env = makeEnv(LIVE);
      await seedFive(env);
      listing({ [PL]: TEN }, { as: { vid00000003: "deleted" } });
      metaAnswer({ vid00000003: { alive: false } });
      await comparePlaylists(env, "tok", { log, now: T });
      const [rec] = await removals(env);
      expect(rec).toMatchObject({ source: "dead", status: "recorded" });
      expect(await isBlocked(env, PL, "vid00000003")).toBe(true);
      expect(await undoRemoval(env, "tok", rec!.id, log)).toEqual({ ok: true, readded: false });
      expect(await isBlocked(env, PL, "vid00000003")).toBe(false);
      // While it waits the row stays as the owner left it: not turned back into a waiting row, not blocked again.
      await comparePlaylists(env, "tok", { log, now: T + DAYS });
      expect(await removals(env)).toMatchObject([{ id: rec!.id, status: "undone" }]);
      expect(await isBlocked(env, PL, "vid00000003")).toBe(false);
      expect(deletePlaylistItem).not.toHaveBeenCalled();
      // Day 3: the item is deleted, and the owner's choice holds.
      expect((await comparePlaylists(env, "tok", { log, now: T + 3 * DAYS }))[0]).toMatchObject({
        deadRemoved: 1,
      });
      expect(deleted()).toEqual(["item-vid00000003"]);
      expect(await isBlocked(env, PL, "vid00000003")).toBe(false);
      expect(await removals(env)).toMatchObject([
        {
          status: "removed",
          detail:
            "deleted or private since 2026-10-01; taken out of the playlist; may be added again if it comes back (you allowed it)",
        },
      ]);
      expect((await confirmedMembership(env, PL)).get("vid00000003")).toBe("out");
      // Back on YouTube later: the sync's gate lets it through.
      metaAnswer({});
      const pick = await pickSetVideo(env, {
        slug: SLUG,
        setUrl: setUrl(3),
        html: "<html></html>",
        rawVideoId: "vid00000003",
        playlistId: PL,
        accessToken: "tok",
        log,
      });
      expect(pick.videoId).toBe("vid00000003");
    });

    it("Keep it on a waiting video: it is never taken out, however long it stays dead", async () => {
      const env = makeEnv(LIVE);
      await seedFive(env);
      listing({ [PL]: [...TEN, GONE] }, { as: { [GONE]: "private" } });
      metaAnswer({ [GONE]: { alive: false } });
      await comparePlaylists(env, "tok", { log, now: T });
      const [waiting] = await removals(env);
      expect(await undoRemoval(env, "tok", waiting!.id, log)).toEqual({ ok: true, readded: false });
      expect(addVideoToPlaylist).not.toHaveBeenCalled();
      expect((await removals(env))[0]).toMatchObject({ status: "undone" });
      for (const later of [DAYS, 5 * DAYS, 40 * DAYS])
        expect(
          (await comparePlaylists(env, "tok", { log, now: T + later }))[0]!.deadRemoved ?? 0,
        ).toBe(0);
      expect(deletePlaylistItem).not.toHaveBeenCalled();
      expect(await removals(env)).toMatchObject([{ status: "undone" }]);
      expect(await seen(env)).toEqual({});
    });

    it("a removed dead video can be allowed again: it leaves the never-add list, nothing is inserted now, and the sync may add it if it comes back", async () => {
      const env = makeEnv(LIVE);
      await seedFive(env);
      await waited(env, ["vid00000003"]);
      listing({ [PL]: TEN }, { as: { vid00000003: "deleted" } });
      metaAnswer({ vid00000003: { alive: false } });
      await comparePlaylists(env, "tok", { log, now: T });
      const [removedRow] = await removals(env);
      expect(removedRow).toMatchObject({ source: "dead", status: "removed" });
      expect(await isBlocked(env, PL, "vid00000003")).toBe(true);
      expect(await undoRemoval(env, "tok", removedRow!.id, log)).toEqual({
        ok: true,
        readded: false,
      });
      // A dead video cannot be inserted, so none is tried; and it gets no exemption that would let the sync try it while dead.
      expect(addVideoToPlaylist).not.toHaveBeenCalled();
      expect(await isBlocked(env, PL, "vid00000003")).toBe(false);
      expect(await env.DB.prepare("SELECT * FROM video_overrides").all()).toMatchObject({
        results: [],
      });
      expect((await removals(env))[0]).toMatchObject({ status: "undone" });
      // Back on YouTube: the sync's gate lets it through again.
      metaAnswer({});
      const pick = await pickSetVideo(env, {
        slug: SLUG,
        setUrl: setUrl(3),
        html: "<html></html>",
        rawVideoId: "vid00000003",
        playlistId: PL,
        accessToken: "tok",
        log,
      });
      expect(pick.videoId).toBe("vid00000003");
      // A second press does nothing.
      expect(await undoRemoval(env, "tok", removedRow!.id, log)).toEqual({
        ok: false,
        error: "not_undoable",
      });
    });
  });
});

describe("combined playlist never gets back what was taken out", () => {
  it("skips blocked ids and ids that left since the last complete listing", async () => {
    const env = makeEnv();
    await savePlaylistMembers(env, PLC, new Set(["a0000000001", "b0000000001"]));
    await recordRemoved(env, {
      playlistId: PLC,
      videoId: "c0000000001",
      slug: null,
      setUrl: null,
      reason: "owner",
    });
    const current = new Set(["a0000000001"]);
    expect([...(await combinedSkipIds(env, PLC, current))].sort()).toEqual([
      "b0000000001",
      "c0000000001",
    ]);
    expect(await combinedRefuses(env, PLC, "b0000000001", current)).toBe(true);
    expect(await combinedRefuses(env, PLC, "c0000000001", current)).toBe(true);
    expect(await combinedRefuses(env, PLC, "new00000001", current)).toBe(false);
    expect(await combinedRefuses(env, PLC, "a0000000001", current)).toBe(false);
  });
});

describe("removeAndReplace", () => {
  it("removes from both playlists, blocks the video, clears the set and queues mkvid from stored facts", async () => {
    const env = makeEnv({ MKVID_TOKEN: "m" });
    await seedSub(env);
    await seedCombined(env);
    await seedSet(env, setUrl(1), "bad00000001");
    await saveSetFacts(
      env,
      facts(setUrl(1), {
        audioKind: "soundcloud",
        audioUrl: "https://api.soundcloud.com/tracks/1",
        lastCueSeconds: 3000,
        setTitle: "DJ @ Club",
      }),
    );
    const r = await removeAndReplace(env, "tok", { slug: SLUG, setUrl: setUrl(1), log });
    expect(r).toMatchObject({
      ok: true,
      videoId: "bad00000001",
      mkvid: "queued for mkvid (soundcloud)",
    });
    expect(vi.mocked(removeVideoFromPlaylist).mock.calls.map((c) => c[0])).toEqual([PL, PLC]);
    expect(await isBlocked(env, PL, "bad00000001")).toBe(true);
    expect(await isBlocked(env, PLC, "bad00000001")).toBe(true);
    expect(await row(env, setUrl(1))).toMatchObject({ video_id: null, checked_at: 0 });
    expect(await getMkvidRequestForSet(env, setUrl(1))).toMatchObject({
      status: "pending",
      source: "soundcloud",
    });
  });

  it("answers no_video / not_found without touching YouTube", async () => {
    const env = makeEnv();
    await seedSet(env, setUrl(1), null);
    expect(await removeAndReplace(env, "tok", { slug: SLUG, setUrl: setUrl(1), log })).toEqual({
      ok: false,
      error: "no_video",
    });
    expect(await removeAndReplace(env, "tok", { slug: SLUG, setUrl: setUrl(2), log })).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(removeVideoFromPlaylist).not.toHaveBeenCalled();
  });
});

describe("undoRemoval", () => {
  it("re-adds a removed video, unblocks it, restores the set and exempts it from the rule", async () => {
    const env = makeEnv();
    await seedFive(env);
    listing({ [PL]: ids([2, 3, 4, 5, 6, 7, 8, 9, 10]) });
    await comparePlaylists(env, "tok", { log });
    const [rec] = await removals(env);
    const r = await undoRemoval(env, "tok", rec!.id, log);
    expect(r).toEqual({ ok: true, readded: true });
    // Back in front: its set (09-01) is earlier than the nine still in the playlist.
    expect(addVideoToPlaylist).toHaveBeenCalledWith(PL, "vid00000001", "tok", undefined, {
      position: 0,
    });
    expect(await isBlocked(env, PL, "vid00000001")).toBe(false);
    expect((await row(env, setUrl(1)))!.video_id).toBe("vid00000001");
    expect((await removals(env))[0]!.status).toBe("undone");
    expect(await undoRemoval(env, "tok", rec!.id, log)).toEqual({
      ok: false,
      error: "not_undoable",
    });
  });

  it("a dry-run row is kept by override alone; a recorded dead row is undone by lifting its block, with no re-add", async () => {
    const env = makeEnv();
    await seedSub(env);
    await seedSet(env, setUrl(1), "notc0000001");
    await saveSetFacts(env, facts(setUrl(1), { noFullNotice: true }));
    await runRemovalSweep(env, "tok", { log });
    const [rec] = await removals(env);
    expect(await undoRemoval(env, "tok", rec!.id, log)).toEqual({ ok: true, readded: false });
    expect(addVideoToPlaylist).not.toHaveBeenCalled();
    expect((await runRemovalSweep(env, "tok", { log })).candidates).toBe(0);

    await seedSet(env, setUrl(2), "dead0000001", { pos: 1 });
    listing({ [PL]: ["notc0000001"] });
    metaAnswer({ dead0000001: { alive: false } });
    // 1 of 2 missing is held (>30%); the owner approves exactly that id.
    expect((await comparePlaylists(env, "tok", { log }))[0]).toMatchObject({ status: "held" });
    expect(await approveHold(env, PL)).toBe(true);
    await comparePlaylists(env, "tok", { log });
    const dead = (await removals(env)).find((x) => x.source === "dead")!;
    expect(await isBlocked(env, PL, "dead0000001")).toBe(true);
    expect(await undoRemoval(env, "tok", dead.id, log)).toEqual({ ok: true, readded: false });
    expect(addVideoToPlaylist).not.toHaveBeenCalled();
    expect(await isBlocked(env, PL, "dead0000001")).toBe(false);
    expect(await undoRemoval(env, "tok", 9999, log)).toEqual({ ok: false, error: "not_found" });
  });
});

describe("runPlaylistHygiene (cron entry)", () => {
  it("compares and sweeps when due, then waits 6 hours", async () => {
    const env = makeEnv();
    await seedSub(env);
    listing({ [PL]: [] });
    const t0 = Date.parse("2026-10-01T00:00:00Z");
    const r1 = await runPlaylistHygiene(env, log, { nowMs: t0 });
    expect(r1.compare).toHaveLength(1);
    expect(r1.sweep).toMatchObject({ dryRun: true });
    expect(await runPlaylistHygiene(env, log, { nowMs: t0 + 5 * 60_000 })).toEqual({
      skipped: "not_due",
    });
    const r3 = await runPlaylistHygiene(env, log, { nowMs: t0 + 6 * 3600_000 });
    expect(r3.compare).toBeDefined();
  });

  it("skips without a YouTube connection and never throws", async () => {
    const env = makeEnv();
    vi.mocked(getAccessToken).mockResolvedValueOnce(null);
    expect(await runPlaylistHygiene(env, log)).toEqual({ skipped: "youtube_not_connected" });
    const broken = makeEnv({ DB: undefined as unknown as D1Database });
    expect(await runPlaylistHygiene(broken, log, { accessToken: "tok" })).toEqual({
      skipped: "error",
    });
  });
});

describe("routes", () => {
  it("serve the removed page and API behind Cloudflare Access", async () => {
    const { app } = await import("../src/index");
    const locked = makeEnv({
      DEV_BYPASS_CF_ACCESS: undefined,
      CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      CF_ACCESS_AUD: "aud",
      CF_ACCESS_ALLOWED_EMAILS: "owner@example.com",
    });
    for (const [method, path] of [
      ["GET", "/ui/removed"],
      ["GET", "/ui/api/removals"],
      ["POST", "/ui/api/set/remove-replace"],
      ["POST", "/ui/api/removals/1/undo"],
      ["POST", "/ui/api/hygiene/run?what=sweep"],
    ] as const) {
      const r = await app.request(`http://x${path}`, { method }, locked);
      expect([401, 403], path).toContain(r.status);
    }
    expect(removeVideoFromPlaylist).not.toHaveBeenCalled();
    const env = makeEnv();
    const page = await app.request("http://x/ui/removed", {}, env);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Removed videos");
    const api = await app.request("http://x/ui/api/removals", {}, env);
    expect(await api.json()).toMatchObject({
      rows: [],
      settings: { dryRun: true, dailyRemovals: 40 },
      holds: [],
    });
  });

  it("GET /ui/api/removals is a data table: sort, filters, search and pages over every row, extras kept", async () => {
    const { app } = await import("../src/index");
    const env = makeEnv();
    const ins = env.DB.prepare(
      "INSERT INTO playlist_removals (at, source, status, slug, set_url, video_id, playlist_id, playlist_kind, reason, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const rows: unknown[][] = [];
    for (let i = 0; i < 30; i++)
      rows.push([
        1_790_000_000 + i,
        i % 3 === 0 ? "owner" : "sweep",
        i % 2 ? "removed" : "would_remove",
        i < 25 ? "dj-a" : "dj-b",
        `https://www.1001tracklists.com/tracklist/${i}/set-${i}.html`,
        `vid${String(i).padStart(8, "0")}`,
        "PL1",
        "artist",
        i % 3 === 0 ? "owner" : "short",
        i === 7 ? "cut at 41 min" : null,
      ]);
    await env.DB.batch(rows.map((r) => ins.bind(...r)));
    const get = async (qs: string) => {
      const r = await app.request(`http://x/ui/api/removals${qs}`, {}, env);
      expect(r.status, qs).toBe(200);
      return (await r.json()) as {
        rows: Array<Record<string, any>>;
        total: number;
        page: number;
        pageCount: number;
        counts: Record<string, number>;
        djs: string[];
        holds: unknown[];
        settings: unknown;
        reasonLabels: Record<string, string>;
      };
    };
    const d = await get("?size=10");
    expect([d.total, d.pageCount, d.rows.length, d.rows[0]!.at]).toEqual([
      30, 3, 10, 1_790_000_029,
    ]);
    expect(d.counts).toEqual({ removed: 15, would_remove: 15 });
    expect(d.djs).toEqual(["dj-a", "dj-b"]);
    expect(d.holds).toEqual([]);
    expect(d.reasonLabels.owner).toBe("removed from the playlist by the owner");
    expect((await get("?size=10&page=3")).rows.map((r) => r.at)[9]).toBe(1_790_000_000);
    expect((await get("?sort=at&size=10")).rows[0]!.at).toBe(1_790_000_000);
    // Filters work across every row, not just one page.
    expect((await get("?f.source=in:owner")).total).toBe(10);
    expect((await get("?f.slug=eq:dj-b")).total).toBe(5);
    expect((await get("?f.status=in:removed&f.slug=eq:dj-b")).rows.map((r) => r.at)).toEqual([
      1_790_000_029, 1_790_000_027, 1_790_000_025,
    ]);
    expect((await get(`?f.at=lt:${1_790_000_003 * 1000}`)).total).toBe(3);
    expect((await get("?q=41 min")).rows.map((r) => r.video_id)).toEqual(["vid00000007"]);
    // Home and Playlists still send ?limit=1 and read only the extras.
    expect((await get("?limit=1")).settings).toMatchObject({ dryRun: true });
    expect((await app.request("http://x/ui/api/removals?f.status=in:nope", {}, env)).status).toBe(
      400,
    );
  });

  it("remove-replace validates input and reports a set without a video", async () => {
    const { app } = await import("../src/index");
    const env = makeEnv();
    const post = (body: unknown) =>
      app.request(
        "http://x/ui/api/set/remove-replace",
        {
          method: "POST",
          headers: { Origin: "http://x", "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        env,
      );
    expect((await post({ slug: "dj" })).status).toBe(400);
    await seedSet(env, setUrl(1), null);
    expect((await post({ slug: SLUG, url: setUrl(1) })).status).toBe(409);
    expect((await post({ slug: SLUG, url: setUrl(2) })).status).toBe(404);
  });
});

describe('a cleared set loads as "no video", due now (the seam to the recheck and mkvid)', () => {
  it("after the live sweep and after the comparison", async () => {
    const { loadSubState, dueRechecks } = await import("../src/lib/sync");
    const env = makeEnv();
    await seedSub(env);
    await seedSet(env, setUrl(1), "notc0000001", { pos: 0 });
    await seedSet(env, setUrl(2), "ownr0000001", { pos: 1 });
    await seedSet(env, setUrl(3), "keep0000001", { pos: 2 });
    await saveSetFacts(env, facts(setUrl(1), { noFullNotice: true }));
    await runRemovalSweep(env, "tok", { log, settings: { dryRun: false, dailyRemovals: 40 } });
    listing({ [PL]: ["keep0000001"] });
    expect((await comparePlaylists(env, "tok", { log }))[0]).toMatchObject({ status: "held" }); // 1 of 2 missing
    await approveHold(env, PL);
    await comparePlaylists(env, "tok", { log });

    const state = (await loadSubState(env, SLUG))!;
    expect(state.tracklistVideos![setUrl(1)]!.videoId).toBeNull();
    expect(state.tracklistVideos![setUrl(2)]!.videoId).toBeNull();
    expect(state.tracklistVideos![setUrl(3)]!.videoId).toBe("keep0000001");
    expect(dueRechecks(state).sort()).toEqual([setUrl(1), setUrl(2)].sort());
  });
});

describe("mkvid's own videos (W7 interface)", () => {
  it("the sweep never judges a video mkvid uploaded, whatever the row says", async () => {
    const env = makeEnv();
    await seedSub(env);
    await seedSet(env, setUrl(1), "mkUp0000001");
    await saveSetFacts(env, facts(setUrl(1), { noFullNotice: true }));
    await env.DB.prepare(
      "INSERT INTO mkvid_requests (id, slug, set_url, source, source_url, status, video_id, created_at, updated_at) VALUES ('r1', ?, ?, 'soundcloud', 'u', 'done', 'mkUp0000001', 0, 0)",
    )
      .bind(SLUG, setUrl(1))
      .run();
    const r = await runRemovalSweep(env, "tok", {
      log,
      settings: { dryRun: false, dailyRemovals: 40 },
    });
    expect(r.candidates).toBe(0);
    expect(removeVideoFromPlaylist).not.toHaveBeenCalled();
  });

  it("the comparison does not count a video replaced by delete-and-recreate as an owner removal (and copes without the table)", async () => {
    const env = makeEnv();
    await seedSub(env);
    await seedSet(env, setUrl(1), "oldR0000001");
    listing({ [PL]: [] });
    // The row W7's retireReplacedVideo writes (migration 0009 schema; the column is video_id on both sides).
    await env.DB.prepare(
      `INSERT INTO mkvid_old_videos (video_id, request_id, slug, set_url, style, replaced_by, state, attempts, next_try_at, created_at, updated_at)
       VALUES (?, 'req-1', 'dj', ?, NULL, 'newR0000001', 'pending', 0, 0, 1, 1)`,
    )
      .bind("oldR0000001", setUrl(1))
      .run();
    expect(await mkvidReplacedIds(env, log)).toEqual(new Set(["oldR0000001"]));
    const [r] = await comparePlaylists(env, "tok", { log });
    expect(r).toMatchObject({ status: "ok", expected: 0, missing: 0 });
    expect(await removals(env)).toHaveLength(0);
    expect((await row(env, setUrl(1)))!.video_id).toBe("oldR0000001");
    // A database without migration 0009 yet: no table, no throw, nothing skipped.
    await env.DB.exec("DROP TABLE mkvid_old_videos");
    expect(await mkvidReplacedIds(env, log)).toEqual(new Set());
  });
});

describe("held comparison push (cron wiring)", () => {
  // 2026-09-29 is CDT: 15:00Z = 10:00 Chicago, 06:00Z = 01:00.
  const DAY = new Date("2026-09-29T15:00:00Z");
  const NIGHT = new Date("2026-09-29T06:00:00Z");
  async function pushEnv() {
    const env = makeEnv(await vapid());
    await savePushSubscription(
      env,
      await pushSubscription("https://push.example/device-1"),
      "phone",
    );
    return env;
  }
  afterEach(() => vi.useRealTimers());

  it("the payload is a playlist_hold push that opens /ui/removed", () => {
    expect(playlistHoldPayload("Playlist check held", "x", DAY)).toEqual({
      kind: "playlist_hold",
      title: "Playlist check held",
      body: "x",
      url: "/ui/removed",
      tag: "playlist-hold",
      ts: DAY.toISOString(),
    });
  });

  it("pushes a held playlist once, at any hour (no quiet hours)", async () => {
    const sent: string[] = [];
    const pushFetch = (async (input: RequestInfo | URL) => (
      sent.push(String(input)),
      new Response(null, { status: 201 })
    )) as unknown as typeof fetch;
    const env = await pushEnv();
    await seedFive(env);
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6]) });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NIGHT);
    const notify = playlistHoldNotifier(env, log, pushFetch);
    expect((await comparePlaylists(env, "tok", { log, notify }))[0]).toMatchObject({
      status: "held",
    });
    expect(sent).toEqual(["https://push.example/device-1"]);
    expect(await listHolds(env)).toMatchObject([{ notified: true }]);
    vi.setSystemTime(DAY);
    await comparePlaylists(env, "tok", { log, notify });
    expect(sent).toHaveLength(1);
  });

  it("without push configured nothing is sent and the hold is not marked notified", async () => {
    const env = makeEnv();
    await seedFive(env);
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6]) });
    await comparePlaylists(env, "tok", { log, notify: playlistHoldNotifier(env, log) });
    expect(await listHolds(env)).toMatchObject([{ notified: false }]);
  });
});

// --- W6 review fixes --------------------------------------------------------

describe("review B1: the sweep never takes out a video another set of the DJ still uses", () => {
  it("two sets of one DJ share a video; one is rejected: nothing is deleted, only that set is cleared, and no ban follows", async () => {
    const env = makeEnv();
    await seedSub(env);
    await seedCombined(env);
    await seedSet(env, setUrl(1), "shrd0000001", { pos: 0 });
    await seedSet(env, setUrl(2), "shrd0000001", { pos: 1 });
    await saveSetFacts(env, facts(setUrl(1), { noFullNotice: true }));
    const r = await runRemovalSweep(env, "tok", {
      log,
      settings: { dryRun: false, dailyRemovals: 40 },
    });
    expect(r).toMatchObject({ rejected: 1, keptShared: 1, deletes: 0 });
    expect(removeVideoFromPlaylist).not.toHaveBeenCalled();
    expect((await row(env, setUrl(1)))!.video_id).toBeNull();
    expect((await row(env, setUrl(2)))!.video_id).toBe("shrd0000001");
    expect((await blockedIds(env, PL)).size).toBe(0);
    // The comparison afterwards sees it present: nothing recorded.
    listing({ [PL]: ["shrd0000001"], [PLC]: ["shrd0000001"] });
    expect((await comparePlaylists(env, "tok", { log }))[0]).toMatchObject({
      status: "ok",
      missing: 0,
      owner: 0,
    });
    expect(await removals(env)).toHaveLength(0);
  });

  it("a dry run does not report a shared video either", async () => {
    const env = makeEnv();
    await seedSub(env);
    await seedSet(env, setUrl(1), "shrd0000001", { pos: 0 });
    await seedSet(env, setUrl(2), "shrd0000001", { pos: 1 });
    await saveSetFacts(env, facts(setUrl(1), { noFullNotice: true }));
    expect(await runRemovalSweep(env, "tok", { log })).toMatchObject({
      dryRun: true,
      reported: 0,
      keptShared: 1,
    });
    expect(await removals(env)).toHaveLength(0);
  });

  it("when every set of the DJ that uses it is rejected, it is removed once and both sets are cleared; never blocklisted", async () => {
    const env = makeEnv();
    await seedSub(env);
    await seedSet(env, setUrl(1), "shrd0000001", { pos: 0 });
    await seedSet(env, setUrl(2), "shrd0000001", { pos: 1 });
    await saveSetFacts(env, facts(setUrl(1), { noFullNotice: true }));
    await saveSetFacts(env, facts(setUrl(2), { noFullNotice: true }));
    await runRemovalSweep(env, "tok", { log, settings: { dryRun: false, dailyRemovals: 40 } });
    expect(vi.mocked(removeVideoFromPlaylist).mock.calls.map((c) => [c[0], c[1]])).toEqual([
      [PL, "shrd0000001"],
    ]);
    expect((await row(env, setUrl(1)))!.video_id).toBeNull();
    expect((await row(env, setUrl(2)))!.video_id).toBeNull();
    expect((await blockedIds(env, PL)).size).toBe(0);
    expect((await confirmedMembership(env, PL)).get("shrd0000001")).toBe("out");
  });
});

describe("review M1: only videos tracked confirmed inserting are expected", () => {
  async function seedNine(env: Env) {
    await seedSub(env);
    for (let i = 1; i <= 9; i++)
      await seedSet(env, setUrl(i), `vid${String(i).padStart(8, "0")}`, { pos: i });
  }
  async function audit(env: Env, videoId: string, status = "added") {
    await env.DB.prepare(
      "INSERT INTO playlist_additions (t, ts, status, slug, set_url, video_id, summary, record) VALUES ('2026-01-01T00:00:00Z', 1, ?, ?, ?, ?, '{}', '{}')",
    )
      .bind(status, SLUG, setUrl(10), videoId)
      .run();
  }

  it("a row whose insert never succeeded (no confirmation, no audit) is ignored when it is missing", async () => {
    const env = makeEnv();
    await seedNine(env);
    await seedSet(env, setUrl(10), "never000001", { pos: 10, confirmed: false });
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6, 7, 8, 9]) });
    expect((await comparePlaylists(env, "tok", { log }))[0]).toMatchObject({
      status: "ok",
      expected: 9,
      missing: 0,
    });
    expect(await removals(env)).toHaveLength(0);
    expect((await row(env, setUrl(10)))!.video_id).toBe("never000001");
  });

  it('past removals: an audited successful insert that is gone is owner-removed on the first run; "duplicate" and "failed" rows are not evidence', async () => {
    const env = makeEnv();
    await seedNine(env);
    await seedSet(env, setUrl(10), "past0000001", { pos: 10, confirmed: false });
    await audit(env, "past0000001", "added");
    await seedSet(env, setUrl(11), "dupl0000001", { pos: 11, confirmed: false });
    await audit(env, "dupl0000001", "duplicate");
    await seedSet(env, setUrl(12), "fail0000001", { pos: 12, confirmed: false });
    await audit(env, "fail0000001", "failed");
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6, 7, 8, 9]) });
    expect((await comparePlaylists(env, "tok", { log }))[0]).toMatchObject({
      status: "ok",
      expected: 10,
      missing: 1,
      owner: 1,
    });
    expect(await isBlocked(env, PL, "past0000001")).toBe(true);
    expect(await isBlocked(env, PL, "dupl0000001")).toBe(false);
    expect(await isBlocked(env, PL, "fail0000001")).toBe(false);
  });

  it("an audited insert that tracked later took out itself (swap, sweep) is not the owner", async () => {
    const env = makeEnv();
    await seedNine(env);
    await seedSet(env, setUrl(10), "swap0000001", { pos: 10, confirmed: false });
    await audit(env, "swap0000001", "added");
    await markOutOfPlaylist(env, PL, "swap0000001", "swap");
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6, 7, 8, 9]) });
    expect((await comparePlaylists(env, "tok", { log }))[0]).toMatchObject({
      status: "ok",
      missing: 0,
    });
    expect(await removals(env)).toHaveLength(0);
  });

  it("snapshot: an unconfirmed video seen in a complete listing becomes expected, and its later removal is found from the second run on", async () => {
    const env = makeEnv();
    await seedNine(env);
    await seedSet(env, setUrl(10), "snap0000001", { pos: 10, confirmed: false });
    listing({ [PL]: [...ids([1, 2, 3, 4, 5, 6, 7, 8, 9]), "snap0000001"] });
    expect((await comparePlaylists(env, "tok", { log }))[0]).toMatchObject({
      expected: 9,
      missing: 0,
    });
    expect((await confirmedMembership(env, PL)).get("snap0000001")).toBe("in");
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6, 7, 8, 9]) });
    expect((await comparePlaylists(env, "tok", { log }))[0]).toMatchObject({
      status: "ok",
      expected: 10,
      missing: 1,
      owner: 1,
    });
  });
});

describe("review M2: an approval covers one hold, its exact ids, for 24 hours", () => {
  it("a hold cleared in between takes its approval with it", async () => {
    const env = makeEnv();
    await seedFive(env);
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6]) });
    await comparePlaylists(env, "tok", { log });
    await approveHold(env, PL);
    // The anomaly clears: nothing missing, hold and approval both gone.
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) });
    await comparePlaylists(env, "tok", { log });
    expect(await env.SUBS.get(`hygiene:approve:${PL}`)).toBeNull();
    // Later, the same four go missing again: held, not auto-approved.
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6]) });
    expect((await comparePlaylists(env, "tok", { log }))[0]).toMatchObject({ status: "held" });
    expect(await removals(env)).toHaveLength(0);
  });

  it("an approval does not cover a different set of missing ids", async () => {
    const env = makeEnv();
    await seedFive(env);
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6]) });
    await comparePlaylists(env, "tok", { log });
    await approveHold(env, PL);
    listing({ [PL]: ids([1, 2, 3, 4, 5]) }); // now five missing
    expect((await comparePlaylists(env, "tok", { log }))[0]).toMatchObject({
      status: "held",
      missing: 5,
    });
    expect(await removals(env)).toHaveLength(0);
  });

  it("an approval older than 24 hours no longer applies", async () => {
    const env = makeEnv();
    await seedFive(env);
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6]) });
    const t0 = 1_900_000_000;
    await comparePlaylists(env, "tok", { log, now: t0 });
    await approveHold(env, PL, t0);
    expect((await comparePlaylists(env, "tok", { log, now: t0 + 25 * 3600 }))[0]).toMatchObject({
      status: "held",
    });
    expect((await comparePlaylists(env, "tok", { log, now: t0 + 3600 }))[0]).toMatchObject({
      status: "ok",
      owner: 4,
    });
  });
});

describe("review M3: guards", () => {
  it("more than 15 missing across the run holds every playlist with a missing video and pushes once", async () => {
    const env = makeEnv();
    const listed: Record<string, string[]> = {};
    for (const dj of ["a", "b", "c", "d"]) {
      await seedSub(env, dj, `PL${dj}`);
      const vids = Array.from({ length: 20 }, (_, i) => `${dj}vid${String(i).padStart(7, "0")}`);
      for (const [i, v] of vids.entries())
        await seedSet(env, `https://www.1001tracklists.com/tracklist/${dj}${i}/x.html`, v, {
          slug: dj,
          pos: i,
          playlistId: `PL${dj}`,
        });
      listed[`PL${dj}`] = vids.slice(4); // 4 of 20 missing: 20%, not a mass removal on its own
    }
    listing(listed);
    const notify = vi.fn(async () => true);
    const res = await comparePlaylists(env, "tok", { log, notify });
    expect(res.map((r) => r.status)).toEqual(["held", "held", "held", "held"]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(await removals(env)).toHaveLength(0);
    expect((await listHolds(env)).every((h) => h.runWide && h.notified)).toBe(true);
  });

  it("a listing item without a video id makes the listing incomplete: nothing inferred", async () => {
    const env = makeEnv();
    await seedFive(env);
    vi.mocked(listPlaylistItems).mockResolvedValue({
      items: [{ id: "item-x", snippet: { title: "Set" } }],
      nextPageToken: null,
      pages: 1,
    } as never);
    expect((await comparePlaylists(env, "tok", { log }))[0]).toMatchObject({
      status: "incomplete",
    });
    expect(await removals(env)).toHaveLength(0);
  });

  it("m5: already-blocked videos do not dilute the 30% guard", async () => {
    const env = makeEnv();
    await seedFive(env);
    for (const id of ids([6, 7, 8, 9, 10]))
      await recordRemoved(env, {
        playlistId: PL,
        videoId: id,
        slug: SLUG,
        setUrl: null,
        reason: "owner",
      });
    listing({ [PL]: ids([1, 2, 3]) }); // 4, 5 missing of the 5 still expected: 40%
    expect((await comparePlaylists(env, "tok", { log }))[0]).toMatchObject({
      status: "held",
      expected: 5,
      missing: 2,
    });
  });
});

describe("review minors", () => {
  it("m3: each delete is counted as it happens", async () => {
    const env = makeEnv();
    await seedSub(env);
    await seedCombined(env);
    await seedSet(env, setUrl(1), "notc0000001");
    await saveSetFacts(env, facts(setUrl(1), { noFullNotice: true }));
    const seen: number[] = [];
    vi.mocked(removeVideoFromPlaylist).mockImplementation(async () => {
      seen.push(await sweepDeletesUsed(env));
      return 1;
    });
    await runRemovalSweep(env, "tok", { log, settings: { dryRun: false, dailyRemovals: 40 } });
    expect(seen).toEqual([0, 1]); // the artist delete was on the books before the combined one started
  });

  it("m4: a quota stop on the combined step after the artist delete still clears the set and marks it out, so no owner record follows", async () => {
    const env = makeEnv();
    await seedSub(env);
    await seedCombined(env);
    for (let i = 2; i <= 10; i++)
      await seedSet(env, setUrl(i), `vid${String(i).padStart(8, "0")}`, { pos: i });
    await seedSet(env, setUrl(1), "notc0000001");
    await saveSetFacts(env, facts(setUrl(1), { noFullNotice: true }));
    vi.mocked(removeVideoFromPlaylist)
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(
        new YouTubeApiError("playlistItems.delete", 403, "quotaExceeded", "{}"),
      );
    const r = await runRemovalSweep(env, "tok", {
      log,
      settings: { dryRun: false, dailyRemovals: 40 },
    });
    expect(r).toMatchObject({ stoppedBy: "quota" });
    expect((await row(env, setUrl(1)))!.video_id).toBeNull();
    listing({ [PL]: ids([2, 3, 4, 5, 6, 7, 8, 9, 10]), [PLC]: [] });
    expect((await comparePlaylists(env, "tok", { log }))[0]).toMatchObject({
      status: "ok",
      missing: 0,
      owner: 0,
    });
    expect(await isBlocked(env, PL, "notc0000001")).toBe(false);
  });

  it("m2: undo is claimed once (double click), re-adds before unblocking, and a failed re-add keeps the block", async () => {
    const env = makeEnv();
    await seedFive(env);
    listing({ [PL]: ids([2, 3, 4, 5, 6, 7, 8, 9, 10]) });
    await comparePlaylists(env, "tok", { log });
    const [rec] = await removals(env);
    vi.mocked(addVideoToPlaylist).mockRejectedValueOnce(new Error("youtube 500"));
    await expect(undoRemoval(env, "tok", rec!.id, log)).rejects.toThrow("youtube 500");
    expect(await isBlocked(env, PL, "vid00000001")).toBe(true);
    expect((await removals(env))[0]!.status).toBe("recorded");
    const both = await Promise.all([
      undoRemoval(env, "tok", rec!.id, log),
      undoRemoval(env, "tok", rec!.id, log),
    ]);
    expect(both.filter((x) => x.ok)).toHaveLength(1);
    expect(vi.mocked(addVideoToPlaylist)).toHaveBeenCalledTimes(2); // the failed try + one real re-add
    expect((await confirmedMembership(env, PL)).get("vid00000001")).toBe("in");
  });

  it("m2: undo restores every set of the DJ that lost the video and supersedes an mkvid request queued since", async () => {
    const env = makeEnv({ MKVID_TOKEN: "mk" });
    await seedFive(env);
    await seedSet(env, setUrl(11), "vid00000001", { pos: 11 });
    await saveSetFacts(env, facts(setUrl(11), { videoId: "vid00000001" }));
    listing({ [PL]: ids([2, 3, 4, 5, 6, 7, 8, 9, 10]) });
    await comparePlaylists(env, "tok", { log });
    expect((await row(env, setUrl(11)))!.video_id).toBeNull();
    const { enqueueMkvidRequest } = await import("../src/lib/mkvid");
    await enqueueMkvidRequest(env, {
      slug: SLUG,
      setUrl: setUrl(11),
      artistName: "DJ",
      setTitle: "x",
      setDate: null,
      source: { kind: "soundcloud", url: "https://api.soundcloud.com/tracks/1" },
      lastCueSeconds: 1,
      trackCount: 1,
      idedCount: 1,
    });
    const [rec] = await removals(env);
    expect(await undoRemoval(env, "tok", rec!.id, log)).toEqual({ ok: true, readded: true });
    expect((await row(env, setUrl(1)))!.video_id).toBe("vid00000001");
    expect((await row(env, setUrl(11)))!.video_id).toBe("vid00000001");
    expect((await getMkvidRequestForSet(env, setUrl(11)))!.status).toBe("superseded");
  });

  it("m6: when the video lookup fails, a video the sweep removed before is not taken again", async () => {
    const env = makeEnv();
    await env.DB.prepare(
      "INSERT INTO playlist_removals (at, source, status, slug, set_url, video_id, playlist_id, playlist_kind, reason, detail) VALUES (1, 'sweep', 'removed', ?, ?, 'swpt0000001', ?, 'artist', 'short', NULL)",
    )
      .bind(SLUG, setUrl(1), PL)
      .run();
    vi.mocked(getVideoMeta).mockRejectedValue(new Error("videos.list 500"));
    const r = await pickSetVideo(env, {
      slug: SLUG,
      setUrl: setUrl(1),
      html: "<html></html>",
      rawVideoId: "swpt0000001",
      playlistId: PL,
      accessToken: "tok",
      log,
    });
    expect(r.videoId).toBeNull();
    const other = await pickSetVideo(env, {
      slug: SLUG,
      setUrl: setUrl(2),
      html: "<html></html>",
      rawVideoId: "othr0000001",
      playlistId: PL,
      accessToken: "tok",
      log,
    });
    expect(other.videoId).toBe("othr0000001");
  });

  it("m10: remove-and-replace refuses an mkvid render", async () => {
    const env = makeEnv();
    await seedSub(env);
    await seedSet(env, setUrl(1), "mkUp0000001", { source: "mkvid" });
    expect(await removeAndReplace(env, "tok", { slug: SLUG, setUrl: setUrl(1), log })).toEqual({
      ok: false,
      error: "mkvid_video",
    });
    expect(removeVideoFromPlaylist).not.toHaveBeenCalled();
    expect((await row(env, setUrl(1)))!.video_id).toBe("mkUp0000001");
  });
});

describe("channel bans and strikes (lib/channel-bans.ts)", () => {
  const html = "<html>plain page</html>";
  const pick = (env: Env, ids: string[]) =>
    pickSetVideo(env, {
      slug: SLUG,
      setUrl: setUrl(1),
      html,
      rawVideoId: ids[0] ?? null,
      candidates: ids,
      playlistId: PL,
      accessToken: "tok",
      log,
    });
  /** `n` owner removals of videos by `channel` (a strike each). */
  async function strikes(env: Env, channel: string, n: number) {
    for (let i = 0; i < n; i++)
      await recordRemoved(env, {
        playlistId: "PLelse",
        videoId: `${channel.slice(2, 6)}${String(i).padStart(7, "0")}`,
        slug: "other",
        setUrl: null,
        reason: "owner",
        channelId: channel,
        channelTitle: channel,
      });
  }

  it("the sync takes the page's second player when the first is turned down", async () => {
    const env = makeEnv();
    await seedSub(env);
    metaAnswer({ clip0000001: { durationSeconds: 600 }, full0000001: {} });
    await saveSetFacts(env, facts(setUrl(1), { lastCueSeconds: 3600 }));
    const r = await pickSetVideo(env, {
      slug: SLUG,
      setUrl: setUrl(1),
      html: null,
      rawVideoId: "clip0000001",
      candidates: ["clip0000001", "full0000001"],
      playlistId: PL,
      accessToken: "tok",
      log,
    });
    expect(r.videoId).toBe("full0000001");
    expect(r.rejected).toMatchObject({ videoId: "clip0000001", reason: "short" });
    // One videos.list call for both players.
    expect(vi.mocked(getVideoMeta)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getVideoMeta).mock.calls[0]![1]).toEqual(["clip0000001", "full0000001"]);
  });

  it("skips a channel the owner removed videos of when another player passes; uses it when it is the only one", async () => {
    const env = makeEnv();
    await seedSub(env);
    await strikes(env, "UCfanA", 1);
    metaAnswer({
      fanA0000001: { channelId: "UCfanA" },
      labl0000001: { channelId: "UClabel" },
    });
    expect(await pick(env, ["fanA0000001", "labl0000001"])).toMatchObject({
      videoId: "labl0000001",
      rejected: { videoId: "fanA0000001", reason: "struck_channel" },
    });
    expect((await pick(env, ["fanA0000001"])).videoId).toBe("fanA0000001");
  });

  it("when only struck channels pass, the one with the fewest strikes wins, then page order", async () => {
    const env = makeEnv();
    await seedSub(env);
    await strikes(env, "UCfanA", 3);
    await strikes(env, "UCfanB", 1);
    await strikes(env, "UCfanC", 1);
    metaAnswer({
      fanA0000001: { channelId: "UCfanA" },
      fanB0000001: { channelId: "UCfanB" },
      fanC0000001: { channelId: "UCfanC" },
    });
    expect((await pick(env, ["fanA0000001", "fanC0000001", "fanB0000001"])).videoId).toBe(
      "fanC0000001",
    );
  });

  it("a banned channel's video is never picked, and hasGoodVideo says no for it", async () => {
    const env = makeEnv();
    await seedSub(env);
    await strikes(env, "UCfanA", 1);
    await processBanQueue(env, { log });
    await decideBan(env, "UCfanA", "ban");
    metaAnswer({ fanA0000001: { channelId: "UCfanA", channelTitle: "Fan A" } });
    expect(await pick(env, ["fanA0000001"])).toEqual({
      videoId: null,
      rejected: {
        videoId: "fanA0000001",
        reason: "banned_channel",
        detail: "uploaded by Fan A, a channel you banned",
      },
    });
    await seedSet(env, setUrl(2), "fanA0000001");
    await saveVideoChannels(env, [
      { videoId: "fanA0000001", channelId: "UCfanA", channelTitle: "Fan A" },
    ]);
    expect(await hasGoodVideo(env, { slug: SLUG, setUrl: setUrl(2), videoId: "fanA0000001" })).toBe(
      false,
    );
  });

  it("the owner's kept video passes over strikes", async () => {
    const env = makeEnv();
    await seedSub(env);
    await strikes(env, "UCfanA", 2);
    await setOverride(env, "fanA0000002");
    metaAnswer({
      fanA0000002: { channelId: "UCfanA" },
      labl0000001: { channelId: "UClabel" },
    });
    expect((await pick(env, ["labl0000001", "fanA0000002"])).videoId).toBe("labl0000001");
    expect((await pick(env, ["fanA0000002", "labl0000001"])).videoId).toBe("fanA0000002");
  });

  it("the comparison stores each item's channel from its listing and records it on an owner removal, which opens a question and pushes", async () => {
    const env = makeEnv();
    await seedFive(env);
    listing({ [PL]: ids([1, 2, 3, 4, 5, 6, 7, 8, 9]) }, { as: { vid00000001: "public" } });
    // vid00000010 was seen in an earlier listing with its channel.
    await saveVideoChannels(env, [
      { videoId: "vid00000010", channelId: "UCfan", channelTitle: "Fan Cam" },
    ]);
    const sent: unknown[] = [];
    const r = await runPlaylistHygiene(env, log, {
      force: "compare",
      banNotify: async (p) => {
        sent.push(p);
        return true;
      },
    });
    expect(r.compare![0]).toMatchObject({ owner: 1 });
    expect(r.bans).toMatchObject({ asked: 1, notified: true });
    const rem = await env.DB.prepare(
      "SELECT channel_id, channel_title, ban_noted FROM removed_videos WHERE video_id = 'vid00000010'",
    ).first();
    expect(rem).toEqual({ channel_id: "UCfan", channel_title: "Fan Cam", ban_noted: 1 });
    const fromListing = await env.DB.prepare(
      "SELECT channel_id, fetched_at FROM video_meta WHERE video_id = 'vid00000001'",
    ).first();
    expect(fromListing).toEqual({ channel_id: "UCdj", fetched_at: 0 });
    expect(sent).toMatchObject([{ kind: "channel_ban", title: "Ban Fan Cam?" }]);
  });

  it("Remove & replace records the uploader, looking the video up when its channel is not known", async () => {
    const env = makeEnv();
    await seedSub(env);
    await seedCombined(env);
    await seedSet(env, setUrl(1), "bad00000001");
    metaAnswer({ bad00000001: { channelId: "UCbad", channelTitle: "Bad" } });
    const r = await removeAndReplace(env, "tok", { slug: SLUG, setUrl: setUrl(1), log });
    expect(r.ok).toBe(true);
    const rows = (
      await env.DB.prepare(
        "SELECT playlist_id, reason, channel_id FROM removed_videos ORDER BY playlist_id",
      ).all()
    ).results;
    expect(rows).toEqual([
      { playlist_id: PL, reason: "button", channel_id: "UCbad" },
      { playlist_id: PLC, reason: "button", channel_id: "UCbad" },
    ]);
    expect((await processBanQueue(env, { log })).asked).toBe(1);
    expect((await channelStrikes(env, ["UCbad"])).get("UCbad")).toBe(1);
  });

  it("the live sweep takes a banned channel's videos out of the artist and combined playlists", async () => {
    const env = makeEnv();
    await seedSub(env);
    await seedCombined(env);
    await seedSet(env, setUrl(1), "fanA0000001", { pos: 0 });
    await seedSet(env, setUrl(2), "good0000001", { pos: 1 });
    await strikes(env, "UCfanA", 1);
    await processBanQueue(env, { log });
    await decideBan(env, "UCfanA", "ban");
    metaAnswer({ fanA0000001: { channelId: "UCfanA" }, good0000001: { channelId: "UClabel" } });
    const r = await runRemovalSweep(env, "tok", {
      log,
      settings: { dryRun: false, dailyRemovals: 40 },
    });
    expect(r).toMatchObject({ rejected: 1, removedVideos: 1 });
    expect(vi.mocked(removeVideoFromPlaylist).mock.calls.map((c) => [c[0], c[1]])).toEqual([
      [PL, "fanA0000001"],
      [PLC, "fanA0000001"],
    ]);
    expect((await removals(env)).map((x) => [x.playlist_kind, x.reason, x.status])).toEqual([
      ["artist", "banned_channel", "removed"],
      ["combined", "banned_channel", "removed"],
    ]);
    // The set is due again: its recheck picks the next player on the page, or none (mkvid).
    expect(await row(env, setUrl(1))).toMatchObject({ video_id: null, checked_at: 0 });
  });

  it("the sweep judges combined-playlist videos no set resolves to by the rules that need no page: vertical and a banned channel", async () => {
    const env = makeEnv();
    await seedSub(env);
    await seedCombined(env);
    await seedSet(env, setUrl(1), "good0000001");
    await strikes(env, "UCfanA", 1);
    await processBanQueue(env, { log });
    await decideBan(env, "UCfanA", "ban");
    await setOverride(env, "kept0000001");
    // The combined playlist's last listing: one tracked video, then orphans.
    await savePlaylistMembers(
      env,
      PLC,
      new Set(["good0000001", "vert0000001", "fanA0000009", "land0000001", "kept0000001"]),
    );
    metaAnswer({
      vert0000001: { embedWidth: 1280, embedHeight: 2276 },
      fanA0000009: { channelId: "UCfanA" },
      kept0000001: { embedWidth: 1280, embedHeight: 2276 },
    });
    const dry = await runRemovalSweep(env, "tok", {
      log,
      settings: { dryRun: true, dailyRemovals: 40 },
    });
    expect(dry).toMatchObject({ orphans: 3, rejected: 2, reported: 2, deletes: 0 });
    expect(removeVideoFromPlaylist).not.toHaveBeenCalled();
    expect(
      (await removals(env)).map((x) => [x.video_id, x.status, x.reason, x.playlist_kind]),
    ).toEqual([
      ["fanA0000009", "would_remove", "banned_channel", "combined"],
      ["vert0000001", "would_remove", "vertical", "combined"],
    ]);
    const live = await runRemovalSweep(env, "tok", {
      log,
      settings: { dryRun: false, dailyRemovals: 1 },
    });
    expect(live).toMatchObject({ removedVideos: 1, deletes: 1, stoppedBy: "budget" });
    expect(vi.mocked(removeVideoFromPlaylist).mock.calls.map((c) => [c[0], c[1]])).toEqual([
      [PLC, "fanA0000009"],
    ]);
    expect((await removals(env)).find((x) => x.video_id === "fanA0000009")).toMatchObject({
      status: "removed",
      detail: "uploaded by UCfanA, a channel you banned; in the combined playlist only",
    });
    // The next day's budget takes the vertical one.
    await runRemovalSweep(env, "tok", {
      log,
      settings: { dryRun: false, dailyRemovals: 1 },
      nowMs: Date.now() + 86_400_000,
    });
    expect((await removals(env)).find((x) => x.video_id === "vert0000001")).toMatchObject({
      status: "removed",
      detail: "embed 1280x2276; in the combined playlist only",
    });
  });

  it("requestSweepSoon makes the sweep due at the next tick", async () => {
    const env = makeEnv();
    await seedSub(env);
    listing({ [PL]: [] });
    const t0 = Date.parse("2026-10-01T00:00:00Z");
    await runPlaylistHygiene(env, log, { nowMs: t0 });
    expect((await runPlaylistHygiene(env, log, { nowMs: t0 + 300_000 })).skipped).toBe("not_due");
    await requestSweepSoon(env);
    const r = await runPlaylistHygiene(env, log, { nowMs: t0 + 600_000 });
    expect(r.sweep).toBeDefined();
    expect(r.compare).toBeUndefined();
  });
});

describe("duplicate copies of a video in a playlist", () => {
  const LIVE = { PLAYLIST_SWEEP_DRY_RUN: "0" };
  const T = Math.floor(Date.parse("2026-10-23T12:00:00Z") / 1000);
  /**
   * listPlaylistItems answers with one item per entry, in order: a video named
   * twice gets two items (`item-<id>-<n>`), each with its position and the
   * time it was added.
   */
  function copies(map: Record<string, string[]>, opts: { dead?: string[] } = {}) {
    vi.mocked(listPlaylistItems).mockImplementation(async (playlistId: string) => {
      const seen = new Map<string, number>();
      const items = (map[playlistId] ?? []).map((id, position) => {
        const n = (seen.get(id) ?? 0) + 1;
        seen.set(id, n);
        return {
          id: `item-${id}-${n}`,
          snippet: {
            title: (opts.dead ?? []).includes(id) ? "Deleted video" : `Set ${id}`,
            position,
            publishedAt: `2026-10-${String(10 + position).padStart(2, "0")}T05:00:29Z`,
            resourceId: { videoId: id },
          },
          contentDetails: { videoId: id },
        };
      });
      return { items, nextPageToken: null, pages: 1 };
    });
  }
  const deleted = () => vi.mocked(deletePlaylistItem).mock.calls.map((c) => c[0]);
  const TEN = ids([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const V3 = "vid00000003";
  const V10 = "vid00000010";

  it("live: deletes the later copy and keeps the first, without blocking, unmarking or clearing the set", async () => {
    const env = makeEnv(LIVE);
    await seedFive(env);
    // vid3 inserted twice at its place (the mkvid double completion), vid10 appended a second time.
    copies({ [PL]: [...TEN.slice(0, 3), V3, ...TEN.slice(3), V10] });
    const [r] = await comparePlaylists(env, "tok", { log, now: T });
    expect(r).toMatchObject({
      status: "ok",
      missing: 0,
      owner: 0,
      duplicates: 2,
      duplicatesRemoved: 2,
    });
    expect(deleted().sort()).toEqual([`item-${V3}-2`, `item-${V10}-2`]);
    const rows = await removals(env);
    expect(rows).toHaveLength(2);
    expect(rows.find((x) => x.video_id === V3)).toMatchObject({
      source: "duplicate",
      status: "removed",
      reason: "duplicate",
      slug: SLUG,
      set_url: setUrl(3),
      playlist_id: PL,
      playlist_kind: "artist",
      at: T,
      detail:
        "in the playlist 2 times; the extra copy deleted (added 2026-10-13 05:00:29); the copy at position 3 (added 2026-10-12 05:00:29) stays",
    });
    // Still in the playlist once: nothing about it changes.
    expect(await isBlocked(env, PL, V3)).toBe(false);
    expect((await confirmedMembership(env, PL)).get(V3)).toBe("in");
    expect((await row(env, setUrl(3)))!.video_id).toBe(V3);
    // Counted against the day's removal budget, like any delete of the hygiene.
    expect(await sweepDeletesUsed(env, T * 1000)).toBe(2);
    // The next comparison finds it clean.
    copies({ [PL]: TEN });
    vi.mocked(deletePlaylistItem).mockClear();
    const [again] = await comparePlaylists(env, "tok", { log, now: T + 6 * 3600 });
    expect(again!.duplicates).toBeUndefined();
    expect(deletePlaylistItem).not.toHaveBeenCalled();
  });

  it("dry run (the default): only says what it would delete", async () => {
    const env = makeEnv();
    await seedFive(env);
    copies({ [PL]: [...TEN, V3] });
    const [r] = await comparePlaylists(env, "tok", { log, now: T });
    expect(r).toMatchObject({ duplicates: 1, duplicatesRemoved: 0 });
    expect(deletePlaylistItem).not.toHaveBeenCalled();
    expect(await removals(env)).toMatchObject([
      {
        source: "duplicate",
        status: "would_remove",
        video_id: V3,
        detail:
          "in the playlist 2 times; the extra copy would be deleted (dry run) (added 2026-10-20 05:00:29); the copy at position 3 (added 2026-10-12 05:00:29) stays",
      },
    ]);
    expect(await sweepDeletesUsed(env, T * 1000)).toBe(0);
  });

  it("the combined playlist is de-duplicated too, and a dead video's copies are left to the dead pass", async () => {
    const env = makeEnv(LIVE);
    await seedFive(env);
    await seedCombined(env);
    await savePlaylistMembers(env, PLC, new Set(TEN), 1);
    copies(
      { [PL]: TEN, [PLC]: [V10, ...TEN, "gone0000001", "gone0000001"] },
      { dead: ["gone0000001"] },
    );
    const results = await comparePlaylists(env, "tok", { log, now: T });
    expect(results.find((x) => x.kind === "combined")).toMatchObject({
      duplicates: 1,
      duplicatesRemoved: 1,
    });
    // The copy added first (position 0) stays in the unordered combined playlist.
    expect(deleted()).toEqual([`item-${V10}-2`]);
    expect(await removals(env)).toMatchObject(
      expect.arrayContaining([
        expect.objectContaining({ source: "duplicate", playlist_kind: "combined", video_id: V10 }),
      ]),
    );
  });

  it("a genre playlist (not compared) is listed for duplicates only, through the same delete path", async () => {
    const env = makeEnv(LIVE);
    await seedFive(env);
    await env.DB.prepare(
      "INSERT INTO genre_playlists (genre_key, genre_name, enabled, playlist_id, updated_at) VALUES ('techno', 'Techno', 1, 'PLgenre', 1)",
    ).run();
    copies({ [PL]: TEN, PLgenre: [V3, "vidOnlyHere", V3] });
    const results = await comparePlaylists(env, "tok", { log, now: T });
    // Not a compared playlist: no result row, nothing recorded as missing for it.
    expect(results.map((r) => r.playlistId)).toEqual([PL]);
    expect(deleted()).toEqual([`item-${V3}-2`]);
    expect(await removals(env)).toMatchObject([
      {
        source: "duplicate",
        status: "removed",
        video_id: V3,
        playlist_id: "PLgenre",
        playlist_kind: "genre",
        slug: null,
        set_url: null,
      },
    ]);
    expect(await sweepDeletesUsed(env, T * 1000)).toBe(1);
  });

  it("stays inside the day's removal budget", async () => {
    const env = makeEnv(LIVE);
    await seedFive(env);
    await env.CACHE.put("hygiene:sweep:deletes:2026-10-23", "39");
    copies({ [PL]: [...TEN, V3, V10] });
    const [r] = await comparePlaylists(env, "tok", { log, now: T });
    expect(r).toMatchObject({ duplicates: 2, duplicatesRemoved: 1 });
    expect(deleted()).toHaveLength(1);
    expect(await sweepDeletesUsed(env, T * 1000)).toBe(40);
  });

  it("a quota reply stops the deletes; another refusal is logged failed and tried again next time", async () => {
    const env = makeEnv(LIVE);
    await seedFive(env);
    copies({ [PL]: [...TEN, V3, V10] });
    vi.mocked(deletePlaylistItem).mockRejectedValueOnce(
      new YouTubeApiError("playlistItems.delete", 500, null, "oops"),
    );
    const [r] = await comparePlaylists(env, "tok", { log, now: T });
    expect(r).toMatchObject({ duplicates: 2, duplicatesRemoved: 1 });
    const rows = await removals(env);
    expect(rows.map((x) => x.status).sort()).toEqual(["failed", "removed"]);
    // The failed delete was given back to the budget.
    expect(await sweepDeletesUsed(env, T * 1000)).toBe(1);

    const env2 = makeEnv(LIVE);
    await seedFive(env2);
    copies({ [PL]: [...TEN, V3, V10] });
    vi.mocked(deletePlaylistItem)
      .mockReset()
      .mockRejectedValue(new YouTubeApiError("playlistItems.delete", 403, "quotaExceeded", "{}"));
    const [q] = await comparePlaylists(env2, "tok", { log, now: T });
    expect(q).toMatchObject({ duplicates: 2, duplicatesRemoved: 0 });
    expect(deletePlaylistItem).toHaveBeenCalledTimes(1);
    expect(await getQuotaOut(env2)).not.toBeNull();
    expect(await sweepDeletesUsed(env2, T * 1000)).toBe(0);
  });

  it("a duplicate's row cannot be undone (it would only make the copy again)", async () => {
    const env = makeEnv(LIVE);
    await seedFive(env);
    copies({ [PL]: [...TEN, V3] });
    await comparePlaylists(env, "tok", { log, now: T });
    const [dup] = await removals(env);
    expect(await undoRemoval(env, "tok", dup!.id, log)).toEqual({
      ok: false,
      error: "not_undoable",
    });
    expect(addVideoToPlaylist).not.toHaveBeenCalled();
  });

  it("planDuplicateDeletes keeps the lowest position, the earlier added on a tie, and skips what it is told to", () => {
    const c = (itemId: string, position: number, addedAt: string | null = null) => ({
      itemId,
      position,
      addedAt,
    });
    const plan = planDuplicateDeletes(
      new Map([
        ["a", [c("a2", 7), c("a1", 2), c("a3", 9)]],
        ["b", [c("b2", 4, "2026-10-02"), c("b1", 4, "2026-10-01")]],
        ["dead", [c("d1", 0), c("d2", 1)]],
        ["single", [c("s1", 3)]],
      ]),
      new Set(["dead"]),
    );
    expect(plan).toEqual([
      { videoId: "a", keep: c("a1", 2), extras: [c("a2", 7), c("a3", 9)] },
      { videoId: "b", keep: c("b1", 4, "2026-10-01"), extras: [c("b2", 4, "2026-10-02")] },
    ]);
  });
});
