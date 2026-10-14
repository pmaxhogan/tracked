import { describe, it, expect, vi, beforeEach } from "vitest";
import { app } from "../src/index";
import type { Env } from "../src/types";
import { fakeKV } from "./helpers/fake-kv";
import { fakeD1 } from "./helpers/fake-d1";
import { fakeR2 } from "./helpers/fake-r2";
import { makeLogger } from "../src/lib/log";
import { updateAppSettings, DEFAULT_APP_SETTINGS } from "../src/lib/app-settings";
import {
  applyApproval,
  claimSearchJob,
  completeSearchJob,
  decideMatch,
  failSearchJob,
  fetchVideoFacts,
  listMatchGroups,
  nameScore,
  referencesOf,
  rejectMatch,
  searchNow,
  type PostedCandidate,
} from "../src/lib/presave-match";
import { claimTrackUpload, safeSourceUrl, soulseekSourceUrl } from "../src/lib/track-uploads";

vi.mock("../src/lib/web-push", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/web-push")>("../src/lib/web-push");
  return { ...actual, sendPushToAll: vi.fn(async () => ({ sent: 1, failed: 0, removed: 0 })) };
});
vi.mock("../src/lib/presave-like", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/presave-like")>("../src/lib/presave-like");
  return { ...actual, onPresaveResolved: vi.fn(async () => null) };
});
import { sendPushToAll } from "../src/lib/web-push";

const fn = (f: unknown) => f as ReturnType<typeof vi.fn>;
const log = makeLogger({ test: "presave-match" });
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const S = DEFAULT_APP_SETTINGS.presaveMatch;

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    CACHE: fakeKV(),
    DB: fakeD1(),
    SUBS: fakeKV(),
    IMAGES: fakeR2(),
    API_TOKEN: "tasker",
    YOUTUBE_API_KEY: "yt-key",
    MKVID_TOKEN: "mk-secret",
    DEV_BYPASS_CF_ACCESS: "1",
    ...overrides,
  } as Env;
}

const LINKS = JSON.stringify([
  {
    source: "36",
    name: "spotify",
    url: "https://open.spotify.com/track/abc",
    playerId: null,
    duration: 170,
  },
  {
    source: "2",
    name: "apple",
    url: "https://music.apple.com/us/album/damager/1733851216?i=1733851217",
    playerId: null,
    duration: 170,
  },
  {
    source: "x",
    name: "traxsource",
    url: "https://www.traxsource.com/track/1",
    playerId: null,
    duration: null,
  },
]);

async function addPresave(
  env: Env,
  p: Partial<{
    artist: string | null;
    title: string | null;
    stage: string;
    created_at: number;
    duration: number | null;
    links: string;
  }> = {},
): Promise<number> {
  const r = await env.DB.prepare(
    `INSERT INTO presaves (track_id, track_url, artist, title, stage, links, duration_seconds, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      String(Math.floor(Math.random() * 1e9)),
      "https://www.1001tracklists.com/track/xtn6qnf/jawns-damager/index.html",
      p.artist === undefined ? "JAWNS" : p.artist,
      p.title === undefined ? "Damager" : p.title,
      p.stage ?? "links",
      p.links ?? LINKS,
      p.duration === undefined ? 170 : p.duration,
      p.created_at ?? NOW - 3 * DAY,
      NOW,
    )
    .run();
  return Number(r.meta.last_row_id);
}

/** videos.list answers: id -> { channelTitle, comments (undefined = off) }. */
function ytFetcher(
  items: Record<string, { channelTitle: string; commentCount?: string; duration?: string }>,
) {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(String(url));
    const ids = new URL(String(url)).searchParams.get("id")!.split(",");
    return new Response(
      JSON.stringify({
        items: ids
          .filter((id) => items[id])
          .map((id) => ({
            id,
            snippet: { channelTitle: items[id]!.channelTitle },
            statistics:
              items[id]!.commentCount === undefined
                ? { viewCount: "1" }
                : { viewCount: "1", commentCount: items[id]!.commentCount },
            contentDetails: { duration: items[id]!.duration ?? "PT2M50S" },
          })),
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { f, calls };
}

const topic = (over: Partial<PostedCandidate> = {}): PostedCandidate => ({
  source: "ytm",
  externalId: "Lnpw0PbJYWM",
  url: "https://music.youtube.com/watch?v=Lnpw0PbJYWM",
  title: "Damager",
  artist: "JAWNS",
  videoType: "MUSIC_VIDEO_TYPE_ATV",
  durationSeconds: 170,
  scores: [{ ref: "apple", score: 0.889, ber: 0.056, offsetSeconds: 45, overlapSeconds: 27 }],
  ...over,
});

beforeEach(() => {
  fn(sendPushToAll).mockClear();
});

describe("nameScore", () => {
  it("is 1 for the same names, ignoring noise words and a Topic channel", () => {
    expect(
      nameScore(
        { artist: "JAWNS", title: "Damager" },
        { artist: "JAWNS - Topic", title: "Damager" },
      ),
    ).toBe(1);
    expect(
      nameScore(
        { artist: "JAWNS", title: "Damager" },
        { artist: "Sable Valley", title: "JAWNS - Damager (Official Audio)" },
      ),
    ).toBe(1);
  });
  it("caps another version at 0.5", () => {
    expect(
      nameScore(
        { artist: "JAWNS", title: "Damager" },
        { artist: "Bass Boost Everything", title: "JAWNS - Damager [Bass Boosted]" },
      ),
    ).toBe(0.5);
    expect(
      nameScore(
        { artist: "Avicii", title: "Levels" },
        { artist: "Avicii", title: "Levels (Skrillex Remix)" },
      ),
    ).toBe(0.5);
    // ...unless the pre-save is that version
    expect(
      nameScore(
        { artist: "Avicii", title: "Levels (Skrillex Remix)" },
        { artist: "Avicii", title: "Levels (Skrillex Remix)" },
      ),
    ).toBe(1);
  });
  it("is low for other tracks", () => {
    expect(
      nameScore(
        { artist: "JAWNS", title: "Damager" },
        { artist: "Shawny Binladen", title: "Damage" },
      ),
    ).toBe(0);
  });
});

describe("decideMatch", () => {
  const facts = (over: Partial<Parameters<typeof decideMatch>[0]> = {}) => ({
    source: "ytm" as const,
    durationSeconds: 170,
    nameScore: 1,
    scores: [{ ref: "apple", score: 0.89 }],
    ...over,
  });
  it("auto-approves clear audio + length + names", () => {
    expect(decideMatch(facts(), 170, S).decision).toBe("auto_approved");
    expect(decideMatch(facts({ durationSeconds: 174 }), 170, S).decision).toBe("auto_approved");
  });
  it("reviews a matching audio with the wrong length, unknown length or other names", () => {
    expect(decideMatch(facts({ durationSeconds: 240 }), 170, S)).toMatchObject({
      decision: "review",
      reason: expect.stringMatching(/70 s off/),
    });
    expect(decideMatch(facts(), null, S).decision).toBe("review");
    expect(decideMatch(facts({ nameScore: 0.5 }), 170, S).decision).toBe("review");
  });
  it("auto-rejects audio clearly different from every preview; best of several counts", () => {
    expect(
      decideMatch(
        facts({
          scores: [
            { ref: "apple", score: 0.04 },
            { ref: "deezer", score: 0.1 },
          ],
        }),
        170,
        S,
      ).decision,
    ).toBe("auto_rejected");
    expect(
      decideMatch(
        facts({
          scores: [
            { ref: "apple", score: 0.04 },
            { ref: "deezer", score: 0.8 },
          ],
        }),
        170,
        S,
      ).decision,
    ).toBe("auto_approved");
  });
  it("never decides without a scored preview, and never for Soulseek / Spotify", () => {
    expect(decideMatch(facts({ scores: [{ ref: "apple", score: null }] }), 170, S).decision).toBe(
      "review",
    );
    expect(decideMatch(facts({ scores: [] }), 170, S).decision).toBe("review");
    expect(decideMatch(facts({ source: "slsk" }), 170, S).decision).toBe("review");
    expect(
      decideMatch(facts({ source: "slsk", scores: [{ ref: "apple", score: 0.01 }] }), 170, S)
        .decision,
    ).toBe("review");
    expect(decideMatch(facts({ source: "spotify" }), 170, S).decision).toBe("review");
  });
  it("reviews the unclear middle", () => {
    expect(decideMatch(facts({ scores: [{ ref: "apple", score: 0.36 }] }), 170, S).decision).toBe(
      "review",
    );
  });
});

describe("referencesOf", () => {
  it("keeps one https link per reference kind, Apple first", () => {
    expect(referencesOf(LINKS).map((r) => r.kind)).toEqual(["apple", "spotify"]);
    expect(referencesOf(null)).toEqual([]);
  });
});

describe("fetchVideoFacts", () => {
  it("reads Topic channels and comments off (no commentCount)", async () => {
    const { f, calls } = ytFetcher({
      Lnpw0PbJYWM: { channelTitle: "JAWNS - Topic", commentCount: "0" },
      "2uOMi1coxZA": { channelTitle: "Sable Valley" },
      eTmdmS_BQMw: { channelTitle: "Bass Boost Everything", commentCount: "3" },
    });
    const m = await fetchVideoFacts(["Lnpw0PbJYWM", "2uOMi1coxZA", "eTmdmS_BQMw", "bad"], "k", f);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("part=snippet,statistics,contentDetails");
    expect(m.get("Lnpw0PbJYWM")).toEqual({
      channelTitle: "JAWNS - Topic",
      isTopic: true,
      commentsOff: false,
      durationSeconds: 170,
    });
    expect(m.get("2uOMi1coxZA")).toMatchObject({ isTopic: false, commentsOff: true });
    expect(m.get("eTmdmS_BQMw")).toMatchObject({ isTopic: false, commentsOff: false });
  });
});

describe("claimSearchJob", () => {
  it("hands out a presave watched long enough, with its references and known ids, once", async () => {
    const env = makeEnv();
    const young = await addPresave(env, { created_at: NOW - HOUR });
    const id = await addPresave(env);
    await addPresave(env, { stage: "found" });
    const r = await claimSearchJob(env, ["ytm"], log, NOW);
    expect(r.outcome).toBe("claimed");
    expect(r.job).toMatchObject({
      searchId: `${id}:ytm`,
      presaveId: id,
      artist: "JAWNS",
      title: "Damager",
      durationSeconds: 170,
      known: [],
      allowSpotifyRip: false,
      attempt: 1,
    });
    expect(r.job!.references.map((x) => x.kind)).toEqual(["apple", "spotify"]);
    // Claimed: not handed out again until the claim TTL passes.
    expect((await claimSearchJob(env, ["ytm"], log, NOW + 1000)).outcome).toBe("empty");
    expect((await claimSearchJob(env, ["ytm"], log, NOW + 31 * 60_000)).job?.presaveId).toBe(id);
    void young;
  });

  it("is off when disabled, when Soulseek is off for slsk, and at the daily cap", async () => {
    const env = makeEnv();
    await addPresave(env);
    await updateAppSettings(env, { presaveMatch: { enabled: false } });
    expect((await claimSearchJob(env, ["ytm"], log, NOW)).outcome).toBe("disabled");
    await updateAppSettings(env, { presaveMatch: { enabled: true, dailySearchCap: 1 } });
    expect((await claimSearchJob(env, ["slsk"], log, NOW)).outcome).toBe("disabled");
    expect((await claimSearchJob(env, ["ytm"], log, NOW)).outcome).toBe("claimed");
    await addPresave(env);
    expect((await claimSearchJob(env, ["ytm"], log, NOW)).outcome).toBe("capped");
  });
});

describe("completeSearchJob", () => {
  it("auto-approves the JAWNS Topic upload: the presave is found, the rest is superseded or rejected", async () => {
    const env = makeEnv();
    const id = await addPresave(env);
    const { job } = await claimSearchJob(env, ["ytm"], log, NOW);
    const { f } = ytFetcher({
      Lnpw0PbJYWM: { channelTitle: "JAWNS - Topic", commentCount: "2" },
      U7SsWFFYcwk: { channelTitle: "LionMusic", commentCount: "5" },
      eTmdmS_BQMw: {
        channelTitle: "Bass Boost Everything",
        commentCount: "3",
        duration: "PT2M51S",
      },
      "9rvikRTSe-Q": {
        channelTitle: "Shawny Binladen - Topic",
        commentCount: "0",
        duration: "PT1M38S",
      },
    });
    const r = await completeSearchJob(
      env,
      {
        searchId: job!.searchId,
        references: [
          {
            kind: "apple",
            url: "https://music.apple.com/x?i=1",
            previewUrl: "https://audio-ssl.itunes.apple.com/p.m4a",
            ok: true,
            durationSeconds: 30,
          },
        ],
        candidates: [
          topic(),
          // A re-upload scoring higher still loses to the Topic upload: that one needs no rip.
          topic({
            externalId: "U7SsWFFYcwk",
            title: "JAWNS - Damager",
            artist: "LionMusic",
            videoType: "MUSIC_VIDEO_TYPE_UGC",
            scores: [{ ref: "apple", score: 0.95 }],
          }),
          topic({
            externalId: "eTmdmS_BQMw",
            title: "JAWNS - Damager [Bass Boosted]",
            artist: "Bass Boost Everything",
            videoType: "MUSIC_VIDEO_TYPE_UGC",
            durationSeconds: 171,
            scores: [{ ref: "apple", score: 0.8 }],
          }),
          topic({
            externalId: "9rvikRTSe-Q",
            title: "Damage",
            artist: "Shawny Binladen",
            durationSeconds: 98,
            scores: [{ ref: "apple", score: 0.04 }],
          }),
        ],
      },
      log,
      { fetcher: f, now: NOW + 1000 },
    );
    expect(r.status).toBe("done");
    if (r.status !== "done") return;
    expect(r.decisions.map((d) => [d.externalId, d.decision, d.outcome])).toEqual([
      ["Lnpw0PbJYWM", "auto_approved", "found"],
      ["U7SsWFFYcwk", "superseded", null],
      ["eTmdmS_BQMw", "auto_rejected", null],
      ["9rvikRTSe-Q", "auto_rejected", null],
    ]);
    const p = await env.DB.prepare("SELECT stage, youtube_video_id FROM presaves WHERE id = ?")
      .bind(id)
      .first();
    expect(p).toEqual({ stage: "found", youtube_video_id: "Lnpw0PbJYWM" });
    const check = await env.DB.prepare(
      "SELECT trigger, result FROM presave_checks WHERE presave_id = ? ORDER BY id DESC",
    )
      .bind(id)
      .first();
    expect(check).toEqual({ trigger: "match", result: "found" });
    // The found push (presaveFoundPayload), no review push.
    expect(fn(sendPushToAll).mock.calls.map((c) => c[1].kind)).toEqual(["presave_found"]);
    expect(r.nextAt).toBe(NOW + 1000 + 7 * DAY);
  });

  it("puts the unclear ones in review, pushes once, asks for clips of non-YouTube ones, and never stores a candidate twice", async () => {
    const env = makeEnv();
    const id = await addPresave(env);
    const { job } = await claimSearchJob(env, ["ytm"], log, NOW);
    const { f } = ytFetcher({ Lnpw0PbJYWM: { channelTitle: "JAWNS - Topic", commentCount: "2" } });
    const body = {
      searchId: job!.searchId,
      references: [
        { kind: "apple", ok: true, previewUrl: "https://audio-ssl.itunes.apple.com/p.m4a" },
        { kind: "deezer", ok: true, previewUrl: "https://cdnt-preview.dzcdn.net/x.mp3?hdnea=1" },
      ],
      candidates: [topic({ scores: [{ ref: "apple", score: 0.5 }] })],
    };
    const r = await completeSearchJob(env, body, log, { fetcher: f, now: NOW + 1000 });
    expect(r.status === "done" && r.decisions[0]!.decision).toBe("review");
    expect(r.status === "done" && r.wantClips).toEqual({ refs: ["deezer"], matches: [] });
    expect(fn(sendPushToAll).mock.calls.map((c) => [c[1].kind, c[1].url])).toEqual([
      ["presave_match", `/ui/presave-matches?presave=${id}`],
    ]);
    // The same candidate again (a second search): known, not stored or decided again.
    await env.DB.prepare("UPDATE presave_match_searches SET next_at = ? WHERE presave_id = ?")
      .bind(NOW, id)
      .run();
    const again = await claimSearchJob(env, ["ytm"], log, NOW + 2000);
    expect(again.job!.known).toEqual(["Lnpw0PbJYWM"]);
    const r2 = await completeSearchJob(env, body, log, { fetcher: f, now: NOW + 3000 });
    expect(r2.status === "done" && r2.decisions[0]!.decision).toBe("known");
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM presave_matches").first<{
      n: number;
    }>();
    expect(n!.n).toBe(1);
    const groups = await listMatchGroups(env, { view: "review" });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.references.map((x) => [x.kind, x.playUrl])).toEqual([
      ["apple", "https://audio-ssl.itunes.apple.com/p.m4a"],
      ["deezer", "https://cdnt-preview.dzcdn.net/x.mp3?hdnea=1"],
    ]);
    expect(groups[0]!.candidates[0]).toMatchObject({
      videoId: "Lnpw0PbJYWM",
      isTopic: true,
      durationDelta: 0,
      decision: "review",
    });
  });

  it("stops after maxSearches and a presave found meanwhile only records candidates as superseded", async () => {
    const env = makeEnv();
    await updateAppSettings(env, { presaveMatch: { maxSearches: 1 } });
    const id = await addPresave(env);
    const { job } = await claimSearchJob(env, ["ytm"], log, NOW);
    await env.DB.prepare(
      "UPDATE presaves SET stage = 'found', youtube_video_id = 'aaaaaaaaaaa' WHERE id = ?",
    )
      .bind(id)
      .run();
    const r = await completeSearchJob(
      env,
      { searchId: job!.searchId, references: [], candidates: [topic()] },
      log,
      { fetcher: ytFetcher({}).f, now: NOW },
    );
    expect(r.status === "done" && r.decisions[0]!.decision).toBe("superseded");
    expect(r.status === "done" && r.nextAt).toBeNull();
  });
});

describe("failSearchJob", () => {
  it("backs off 30 min doubling, or what mkvid asked for", async () => {
    const env = makeEnv();
    await addPresave(env);
    const { job } = await claimSearchJob(env, ["ytm"], log, NOW);
    const a = await failSearchJob(
      env,
      { searchId: job!.searchId, error: "YouTube Music answered 429" },
      log,
      NOW,
    );
    expect(a).toEqual({ status: "failed", attempts: 1, nextAt: NOW + 30 * 60_000 });
    const b = await failSearchJob(env, { searchId: job!.searchId, error: "x" }, log, NOW);
    expect(b).toMatchObject({ attempts: 2, nextAt: NOW + 60 * 60_000 });
    const c = await failSearchJob(
      env,
      { searchId: job!.searchId, error: "x", retryAfterSeconds: 6 * 3600 },
      log,
      NOW,
    );
    expect(c).toMatchObject({ attempts: 3, nextAt: NOW + 6 * HOUR });
    expect(await failSearchJob(env, { searchId: "nope", error: "x" }, log, NOW)).toEqual({
      status: "not_found",
    });
  });
});

describe("approve / reject", () => {
  async function inReview(
    env: Env,
    c: PostedCandidate,
    facts: Parameters<typeof ytFetcher>[0] = {},
  ) {
    const id = await addPresave(env);
    const { job } = await claimSearchJob(env, ["ytm", "slsk"], log, NOW);
    const r = await completeSearchJob(
      env,
      { searchId: job!.searchId, references: [{ kind: "apple", ok: true }], candidates: [c] },
      log,
      { fetcher: ytFetcher(facts).f, now: NOW },
    );
    if (r.status !== "done") throw new Error("not done");
    return { presaveId: id, matchId: r.decisions[0]!.id! };
  }

  it("a YouTube upload with comments on is ripped, not made the video", async () => {
    const env = makeEnv();
    const { presaveId, matchId } = await inReview(
      env,
      topic({
        externalId: "2uOMi1coxZA",
        videoType: "MUSIC_VIDEO_TYPE_UGC",
        title: "JAWNS - Damager (Official Audio)",
        artist: "Sable Valley",
        scores: [{ ref: "apple", score: 0.5 }],
      }),
      { "2uOMi1coxZA": { channelTitle: "Sable Valley", commentCount: "4" } },
    );
    const r = await applyApproval(env, matchId, "owner", log, NOW);
    expect(r).toMatchObject({ ok: true, outcome: "rip_queued" });
    const u = await env.DB.prepare(
      "SELECT source_name, source_url, status, match_id, expected_duration_seconds FROM track_uploads WHERE presave_id = ?",
    )
      .bind(presaveId)
      .first();
    expect(u).toEqual({
      source_name: "youtube",
      source_url: "https://www.youtube.com/watch?v=2uOMi1coxZA",
      status: "pending",
      match_id: matchId,
      expected_duration_seconds: 170,
    });
    const p = await env.DB.prepare("SELECT stage FROM presaves WHERE id = ?")
      .bind(presaveId)
      .first();
    expect(p).toEqual({ stage: "links" });
    // Idempotent.
    expect((await applyApproval(env, matchId, "owner", log, NOW)).message).toBe("already approved");
  });

  it("a video with comments off is the track's video", async () => {
    const env = makeEnv();
    const { presaveId, matchId } = await inReview(
      env,
      topic({
        externalId: "2uOMi1coxZA",
        videoType: "MUSIC_VIDEO_TYPE_UGC",
        scores: [{ ref: "apple", score: 0.5 }],
      }),
      { "2uOMi1coxZA": { channelTitle: "Sable Valley" } },
    );
    expect((await applyApproval(env, matchId, "owner", log, NOW)).outcome).toBe("found");
    const p = await env.DB.prepare("SELECT stage, youtube_video_id FROM presaves WHERE id = ?")
      .bind(presaveId)
      .first();
    expect(p).toEqual({ stage: "found", youtube_video_id: "2uOMi1coxZA" });
  });

  it("a Soulseek file is queued with its slsk:// source and only an mkvid that lists soulseek gets it", async () => {
    const env = makeEnv();
    await updateAppSettings(env, { presaveMatch: { soulseek: true } });
    const { matchId } = await inReview(env, {
      source: "slsk",
      externalId: "user1\u0000Music\\JAWNS - Damager.flac",
      title: "JAWNS - Damager.flac",
      durationSeconds: 170,
      scores: [],
      extra: {
        username: "user1",
        filename: "Music\\JAWNS - Damager.flac",
        size: 20e6,
        bitRate: 1000,
      },
    });
    const r = await applyApproval(env, matchId, "owner", log, NOW);
    expect(r.outcome).toBe("rip_queued");
    const url = soulseekSourceUrl("user1", "Music\\JAWNS - Damager.flac");
    expect(safeSourceUrl("soulseek", url)).toBe(url);
    await env.DB.prepare(
      "INSERT INTO mkvid_claims (request_id, account, claimed_at, recreate) VALUES ('x', 'primary', 0, 0)",
    ).run();
    const old = await claimTrackUpload(env, log, ["primary"], []);
    expect(old.request).toBeNull();
    const now = await claimTrackUpload(env, log, ["primary"], ["soulseek"]);
    expect(now.request).toMatchObject({ sourceName: "soulseek", sourceUrl: url });
  });

  it("reject keeps the candidate out of the queue for good", async () => {
    const env = makeEnv();
    const { matchId } = await inReview(env, topic({ scores: [{ ref: "apple", score: 0.5 }] }), {
      Lnpw0PbJYWM: { channelTitle: "JAWNS - Topic", commentCount: "1" },
    });
    const m = await rejectMatch(env, matchId, NOW);
    expect(m!.decision).toBe("rejected");
    expect(await listMatchGroups(env, { view: "review" })).toEqual([]);
    expect((await listMatchGroups(env, { view: "decided" }))[0]!.candidates[0]!.decision).toBe(
      "rejected",
    );
  });

  it("search now makes a presave due at once, past the watch delay and maxSearches", async () => {
    const env = makeEnv();
    const id = await addPresave(env, { created_at: NOW - HOUR });
    expect((await claimSearchJob(env, ["ytm"], log, NOW)).outcome).toBe("empty");
    expect(await searchNow(env, id, NOW)).toBe(true);
    expect((await claimSearchJob(env, ["ytm"], log, NOW)).job?.presaveId).toBe(id);
  });
});

describe("routes", () => {
  const mk = (path: string, body: unknown, token = "mk-secret") =>
    new Request(`https://w.example${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("/mkvid/presave/* needs MKVID_TOKEN; health advertises presaveSearch", async () => {
    const env = makeEnv();
    expect((await app.fetch(mk("/mkvid/presave/search/claim", {}, "wrong"), env)).status).toBe(401);
    const h = await app.fetch(
      new Request("https://w.example/mkvid/health", {
        headers: { authorization: "Bearer mk-secret" },
      }),
      env,
    );
    expect(((await h.json()) as { presaveSearch: boolean }).presaveSearch).toBe(true);
  });

  it("claim -> complete -> clip -> approve through the API", async () => {
    const env = makeEnv({ YOUTUBE_API_KEY: "" });
    const id = await addPresave(env, { created_at: Date.now() - 3 * DAY });
    const c = await app.fetch(mk("/mkvid/presave/search/claim", { kinds: ["ytm"] }), env);
    const job = ((await c.json()) as { job: { searchId: string } }).job;
    expect(job.searchId).toBe(`${id}:ytm`);
    const done = await app.fetch(
      mk("/mkvid/presave/search/complete", {
        searchId: job.searchId,
        references: [
          { kind: "deezer", ok: true, previewUrl: "https://cdnt-preview.dzcdn.net/x.mp3" },
        ],
        candidates: [topic({ scores: [{ ref: "deezer", score: 0.5 }] })],
      }),
      env,
    );
    expect(done.status).toBe(200);
    const d = (await done.json()) as {
      decisions: Array<{ id: number; decision: string }>;
      wantClips: { refs: string[] };
    };
    expect(d.decisions[0]!.decision).toBe("review");
    expect(d.wantClips.refs).toEqual(["deezer"]);
    const clip = await app.fetch(
      new Request(
        `https://w.example/mkvid/presave/clip?searchId=${encodeURIComponent(job.searchId)}&ref=deezer`,
        {
          method: "POST",
          headers: { authorization: "Bearer mk-secret", "content-type": "audio/mpeg" },
          body: new Uint8Array([1, 2, 3]),
        },
      ),
      env,
    );
    expect(clip.status).toBe(200);
    const list = await app.fetch(
      new Request("https://w.example/ui/api/presave-matches?view=review"),
      env,
    );
    const groups = (
      (await list.json()) as {
        groups: Array<{
          references: Array<{ playUrl: string }>;
          candidates: Array<{ id: number }>;
        }>;
      }
    ).groups;
    const play = groups[0]!.references[0]!.playUrl;
    expect(play).toMatch(/^\/ui\/api\/presave-matches\/clip\//);
    const audio = await app.fetch(new Request(`https://w.example${play}`), env);
    expect(audio.headers.get("content-type")).toBe("audio/mpeg");
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    // No videos.list key: innertube's ATV type says Topic.
    const ok = await app.fetch(
      new Request(
        `https://w.example/ui/api/presave-matches/${groups[0]!.candidates[0]!.id}/approve`,
        {
          method: "POST",
          headers: { origin: "https://w.example", "content-type": "application/json" },
          body: "{}",
        },
      ),
      env,
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { outcome: string }).outcome).toBe("found");
    // The page's clips go once nothing waits for review.
    expect((await app.fetch(new Request(`https://w.example${play}`), env)).status).toBe(404);
  });

  it("fail with a bad id is 404, a malformed body 400", async () => {
    const env = makeEnv();
    expect(
      (await app.fetch(mk("/mkvid/presave/search/fail", { searchId: "9:ytm", error: "x" }), env))
        .status,
    ).toBe(404);
    expect((await app.fetch(mk("/mkvid/presave/search/complete", { nope: 1 }), env)).status).toBe(
      400,
    );
  });
});
