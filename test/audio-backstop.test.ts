import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import type { Env, ParsedTrack } from "../src/types";
import { fakeKV } from "./helpers/fake-kv";
import { fakeD1 } from "./helpers/fake-d1";
import { storeVerifiedList } from "./helpers/mkvid-lists";
import {
  enqueueMkvidRequest,
  getMkvidRequestForSet,
  getMkvidTracks,
  saveMkvidTracks,
} from "../src/lib/mkvid";
import { readinessFor, TIMED_SQL } from "../src/lib/mkvid-readiness";
import {
  AUDIO_CLAIM_TTL_SECONDS,
  AUDIO_DROPPED_NOTE,
  AUDIO_PARTIAL_REDO_SECONDS,
  AUDIO_REDO_SECONDS,
  AUDIO_RETRY_MAX_SECONDS,
  AUDIO_RETRY_MIN_SECONDS,
  audioCueCounts,
  audioRetryDelay,
  claimAudioJob,
  completeAudioJob,
  failAudioJob,
  progressAudioJob,
} from "../src/lib/audio-backstop";
import { applyAppleCuesToRequest } from "../src/lib/apple-backstop";
import { tracklistFingerprint } from "../src/lib/verification";

function makeEnv(): Env {
  return {
    CACHE: fakeKV(),
    DB: fakeD1(),
    SUBS: fakeKV(),
    API_TOKEN: "tasker",
    MKVID_TOKEN: "mk",
    DEV_BYPASS_CF_ACCESS: "1",
  } as unknown as Env;
}

const NOW = Math.floor(Date.now() / 1000);
const daysAgo = (d: number) => new Date((NOW - d * 86400) * 1000).toISOString().slice(0, 10);

/**
 * A pending request with a verified list of 10 rows (cue i * 60), its last
 * `untimedRows` (5) untimed, the Apple pass recorded as run (no album).
 */
async function heldSet(
  env: Env,
  n: string,
  opts: {
    setDate?: string;
    untimedRows?: number;
    idRows?: number;
    appleRan?: boolean;
    source?: "soundcloud" | "hearthis";
  } = {},
) {
  const setUrl = `https://www.1001tracklists.com/tracklist/${n}/x.html`;
  await enqueueMkvidRequest(env, {
    slug: "dj",
    setUrl,
    artistName: "DJ",
    setTitle: `set ${n}`,
    setDate: opts.setDate ?? "2020-01-01",
    source:
      opts.source === "hearthis"
        ? { kind: "hearthis", url: `https://hearthis.at/embed/${n}/` }
        : { kind: "soundcloud", url: `https://api.soundcloud.com/tracks/${n}` },
    lastCueSeconds: 240,
    trackCount: 10,
    idedCount: 10,
  });
  await storeVerifiedList(env, setUrl, {
    rows: 10,
    untimedRows: opts.untimedRows ?? 5,
    idRows: opts.idRows ?? 0,
  });
  const id = (await getMkvidRequestForSet(env, setUrl))!.id;
  if (opts.appleRan !== false)
    await env.DB.prepare("UPDATE mkvid_request_tracks SET apple_note = ? WHERE request_id = ?")
      .bind("no Apple Music album known for this set", id)
      .run();
  return { id, setUrl };
}

const report = (index: number, cueSeconds: number, over: Record<string, unknown> = {}) => ({
  index,
  cueSeconds,
  share: 0.9,
  onset: 0.6,
  votes: 300,
  source: "youtube",
  ...over,
});

const stored = (env: Env, id: string) =>
  env.DB.prepare("SELECT * FROM mkvid_request_tracks WHERE request_id = ?")
    .bind(id)
    .first<Record<string, unknown>>();

const timed = async (env: Env, id: string) =>
  Number(
    (
      await env.DB.prepare(
        `SELECT COALESCE(${TIMED_SQL}, 0) AS ok FROM mkvid_requests r JOIN mkvid_request_tracks t ON t.request_id = r.id WHERE r.id = ?`,
      )
        .bind(id)
        .first<{ ok: number }>()
    )?.ok,
  ) === 1;

const readiness = async (env: Env, id: string, setDate = "2020-01-01") =>
  (
    await readinessFor(env, [
      { id, status: "pending", notBefore: null, setDate, skipIdWait: false },
    ])
  ).get(id)!;

describe("claimAudioJob eligibility", () => {
  it("hands out a held old set with its rows, once, and skips sets that do not qualify", async () => {
    const env = makeEnv();
    const { id, setUrl } = await heldSet(env, "ok");
    await heldSet(env, "young", { setDate: daysAgo(20) }); // under 4 weeks
    await heldSet(env, "ids", { idRows: 2 }); // 8 of 10 identified
    await heldSet(env, "noapple", { appleRan: false }); // the Apple pass has not run
    await heldSet(env, "timed", { untimedRows: 0 }); // not held
    const job = await claimAudioJob(env, ["soundcloud", "hearthis"], { now: NOW });
    expect(job).toMatchObject({
      requestId: id,
      setUrl,
      source: "soundcloud",
      sourceUrl: "https://api.soundcloud.com/tracks/ok",
      attempts: 0,
    });
    expect(job!.rows).toHaveLength(10);
    expect(job!.rows[7]).toEqual({
      index: 7,
      artist: "Artist 7",
      title: "Title 7",
      isId: false,
      layered: false,
      cueSeconds: null,
    });
    // Running now: nothing else qualifies.
    expect(await claimAudioJob(env, ["soundcloud", "hearthis"], { now: NOW })).toBeNull();
    expect((await audioCueCounts(env, NOW)).eligible).toBe(1);
  });

  it("counts 4 weeks from the set date and needs 90 % of the base rows identified", async () => {
    const env = makeEnv();
    const { id } = await heldSet(env, "d29", { setDate: daysAgo(29) });
    expect((await claimAudioJob(env, ["soundcloud"], { now: NOW }))?.requestId).toBe(id);
    const env2 = makeEnv();
    await heldSet(env2, "d27", { setDate: daysAgo(27) });
    expect(await claimAudioJob(env2, ["soundcloud"], { now: NOW })).toBeNull();
    const env3 = makeEnv();
    const { id: one } = await heldSet(env3, "oneid", { idRows: 1 }); // 9 of 10
    expect((await claimAudioJob(env3, ["soundcloud"], { now: NOW }))?.requestId).toBe(one);
  });

  it("offers only the recording sources mkvid can fetch now", async () => {
    const env = makeEnv();
    const { id } = await heldSet(env, "ht", { source: "hearthis" });
    expect(await claimAudioJob(env, ["soundcloud"], { now: NOW })).toBeNull();
    expect(await claimAudioJob(env, ["mixcloud"], { now: NOW })).toBeNull();
    expect((await claimAudioJob(env, ["hearthis"], { now: NOW }))?.requestId).toBe(id);
  });

  it("hands a set out again when its claim lapses, and progress renews the claim", async () => {
    const env = makeEnv();
    const { id } = await heldSet(env, "ttl");
    await claimAudioJob(env, ["soundcloud"], { now: NOW });
    expect(
      await progressAudioJob(env, { requestId: id, note: "12 of 30 tracks" }, NOW + 3600),
    ).toBe(true);
    expect((await stored(env, id))!.audio_note).toBe(
      "estimating cue times from audio: 12 of 30 tracks",
    );
    expect(
      await claimAudioJob(env, ["soundcloud"], { now: NOW + AUDIO_CLAIM_TTL_SECONDS + 60 }),
    ).toBeNull();
    expect(
      (await claimAudioJob(env, ["soundcloud"], { now: NOW + 3600 + AUDIO_CLAIM_TTL_SECONDS + 1 }))
        ?.requestId,
    ).toBe(id);
    const rd = await readiness(env, id);
    expect(rd.audio).toMatchObject({ state: "running", cues: 0 });
  });
});

describe("completeAudioJob", () => {
  it("stores only gated rows and fills the list from them; 70 % still holds an old set", async () => {
    const env = makeEnv();
    const { id } = await heldSet(env, "rel");
    await claimAudioJob(env, ["soundcloud"], { now: NOW });
    expect(await timed(env, id)).toBe(false);
    const r = await completeAudioJob(
      env,
      {
        requestId: id,
        setSeconds: 900,
        rows: [
          report(5, 300),
          report(6, 361),
          report(7, 420, { share: 0.3 }), // fails the gate
          report(8, 480, { onset: 0.1 }), // fails the gate
          report(2, 125), // has a real cue
        ],
        stats: { withAudio: 4, missing: 1, sources: { youtube: 3, soulseek: 1 } },
      },
      { now: NOW },
    );
    expect(r).toEqual({
      status: "done",
      rows: 5,
      gated: 2,
      filled: 2,
      timedEnough: false,
      nextAt: NOW + AUDIO_PARTIAL_REDO_SECONDS,
    });
    // Rows 0-4 timed by 1001tl plus 2 estimates: 7 of 10, under the 75 % an old set needs.
    const t = await stored(env, id);
    expect(t).toMatchObject({
      audio_cues: 2,
      timed_rows: 7,
      base_rows: 10,
      audio_claimed_at: null,
      audio_attempts: 0,
    });
    expect(t!.audio_note).toBe("2 of 5 untimed tracks placed from audio (4 had audio found)");
    expect(JSON.parse(String(t!.audio_stats))).toEqual({
      rows: 5,
      withAudio: 4,
      gated: 2,
      missing: 1,
      sources: { youtube: 3, soulseek: 1 },
      setSeconds: 900,
    });
    expect(await timed(env, id)).toBe(false);
  });

  it("releases an old set at 75 % and holds a newer one at 80 % (90 % needed)", async () => {
    const env = makeEnv();
    const { id: old } = await heldSet(env, "old");
    const { id: newer } = await heldSet(env, "newer", { setDate: daysAgo(60) });
    for (const id of [old, newer]) {
      const res = await completeAudioJob(
        env,
        {
          requestId: id,
          rows: [report(5, 300), report(6, 360), report(7, 420)],
          stats: { withAudio: 3 },
        },
        { now: NOW },
      );
      expect(res).toMatchObject({ status: "done", gated: 3, filled: 3 });
    }
    expect(await timed(env, old)).toBe(true);
    expect((await readiness(env, old)).state).toBe("ready");
    expect((await readiness(env, old)).audio).toMatchObject({ cues: 3, state: "done" });
    expect(await timed(env, newer)).toBe(false);
    expect((await readiness(env, newer, daysAgo(60))).state).toBe("untimed");
    expect((await audioCueCounts(env, NOW)).ranAndReleased).toBe(1);
  });

  it("hands mkvid the estimated cues in the plain wire format", async () => {
    const env = makeEnv();
    const { id } = await heldSet(env, "wire");
    await completeAudioJob(
      env,
      { requestId: id, rows: [report(5, 300), report(6, 360)] },
      { now: NOW },
    );
    const wire = await getMkvidTracks(env, id);
    expect(wire.tracks.map((t) => t.cueSeconds)).toEqual([
      0,
      60,
      120,
      180,
      240,
      300,
      360,
      null,
      null,
      null,
    ]);
    expect(wire.tracks.some((t) => "cueFrom" in t || "cueConfidence" in t)).toBe(false);
    const raw = JSON.parse(String((await stored(env, id))!.tracks));
    expect(raw[5]).toMatchObject({ cueFrom: "audio", cueConfidence: 0.9 });
  });

  it("schedules the next look 30 days out when every track had audio, and answers 404 for an unknown request", async () => {
    const env = makeEnv();
    const { id } = await heldSet(env, "full");
    expect(
      await completeAudioJob(
        env,
        { requestId: id, rows: [], stats: { withAudio: 5, missing: 0 } },
        { now: NOW },
      ),
    ).toMatchObject({ gated: 0, nextAt: NOW + AUDIO_REDO_SECONDS });
    expect(await claimAudioJob(env, ["soundcloud"], { now: NOW + 86400 })).toBeNull();
    expect(
      (await claimAudioJob(env, ["soundcloud"], { now: NOW + AUDIO_REDO_SECONDS }))?.requestId,
    ).toBe(id);
    expect(await completeAudioJob(env, { requestId: "nope", rows: [] })).toEqual({
      status: "not_found",
    });
  });
});

describe("estimates across rechecks", () => {
  const rowsOf = (cues: Array<number | null>): ParsedTrack[] =>
    cues.map(
      (c, i) =>
        ({
          artist: `Artist ${i}`,
          title: `Title ${i}`,
          startSeconds: c,
          ownStartSeconds: null,
          isUnidentified: false,
          isMashupLinked: false,
          artworkUrl: null,
          trackUrl: null,
          trackId: null,
        }) as unknown as ParsedTrack,
    );
  /** What the sync does on a recheck: a verified fetch of `cues`, then saveMkvidTracks. */
  const recheck = async (env: Env, setUrl: string, cues: Array<number | null>) => {
    const parsed = {
      rows: rowsOf(cues),
      decoy: { named: 10, mismatched: 0, suspected: false, far: [] as string[] },
    };
    await env.DB.prepare("UPDATE set_verification SET fingerprint = ? WHERE url = ?")
      .bind(await tracklistFingerprint(parsed), setUrl)
      .run();
    return saveMkvidTracks(env, setUrl, parsed);
  };

  it("keeps them when a recheck brings nothing new, uses a real cue over an estimate, and drops them at 90 %", async () => {
    const env = makeEnv();
    const { id, setUrl } = await heldSet(env, "rc");
    const untimed = [0, 60, 120, 180, 240, null, null, null, null, null];
    expect(await recheck(env, setUrl, untimed)).toBe("saved");
    await completeAudioJob(
      env,
      { requestId: id, rows: [report(5, 300), report(6, 360), report(7, 420), report(8, 480)] },
      { now: NOW },
    );
    expect((await stored(env, id))!.audio_cues).toBe(4);

    // The same list again: the estimates come back on the fresh copy.
    expect(await recheck(env, setUrl, untimed)).toBe("saved");
    let t = await stored(env, id);
    expect(t).toMatchObject({ audio_cues: 4, timed_rows: 9 });

    // The Apple pass on its own (the "re-check now" button) keeps them too.
    await applyAppleCuesToRequest(env, id);
    expect((await stored(env, id))!.audio_cues).toBe(4);

    // 1001tl now times rows 5 and 6 (differently): their real cues win, 7 and 8 stay estimated.
    expect(await recheck(env, setUrl, [0, 60, 120, 180, 240, 310, 370, null, null, null])).toBe(
      "saved",
    );
    t = await stored(env, id);
    const tracks = JSON.parse(String(t!.tracks));
    expect(tracks.map((x: { cueSeconds: number | null }) => x.cueSeconds)).toEqual([
      0,
      60,
      120,
      180,
      240,
      310,
      370,
      420,
      480,
      null,
    ]);
    expect(tracks[5].cueFrom).toBeUndefined();
    expect(t!.audio_cues).toBe(2);

    // 1001tl reaches 90 % on its own: the estimates are dropped.
    expect(await recheck(env, setUrl, [0, 60, 120, 180, 240, 310, 370, 430, 490, null])).toBe(
      "saved",
    );
    t = await stored(env, id);
    expect(t).toMatchObject({
      audio_cues: 0,
      audio_estimates: null,
      audio_note: AUDIO_DROPPED_NOTE,
    });
    expect(
      JSON.parse(String(t!.tracks)).some((x: { cueFrom?: string }) => x.cueFrom === "audio"),
    ).toBe(false);
  });
});

describe("failAudioJob", () => {
  it("backs off, doubling up to a day, and never gives a set up", async () => {
    expect(audioRetryDelay(1)).toBe(AUDIO_RETRY_MIN_SECONDS);
    expect(audioRetryDelay(2)).toBe(2 * AUDIO_RETRY_MIN_SECONDS);
    expect(audioRetryDelay(3, 7200)).toBe(7200);
    expect(audioRetryDelay(30)).toBe(AUDIO_RETRY_MAX_SECONDS);
    expect(audioRetryDelay(1, 10 * 86400)).toBe(AUDIO_RETRY_MAX_SECONDS);
    const env = makeEnv();
    const { id } = await heldSet(env, "f");
    await claimAudioJob(env, ["soundcloud"], { now: NOW });
    const r = await failAudioJob(
      env,
      { requestId: id, error: "youtube throttled", retryAfterSeconds: 3600 },
      { now: NOW },
    );
    expect(r).toEqual({ status: "retry", attempts: 1, nextAt: NOW + 3600 });
    expect(await claimAudioJob(env, ["soundcloud"], { now: NOW + 60 })).toBeNull();
    expect((await claimAudioJob(env, ["soundcloud"], { now: NOW + 3600 }))?.attempts).toBe(1);
    const rd = await readiness(env, id);
    expect(rd.audio).toMatchObject({ state: "running" });
    await failAudioJob(env, { requestId: id, error: "again" }, { now: NOW + 3600 });
    expect(
      (
        await readinessFor(
          env,
          [{ id, status: "pending", notBefore: null, setDate: "2020-01-01", skipIdWait: false }],
          NOW + 3700,
        )
      ).get(id)!.audio,
    ).toMatchObject({
      state: "retrying",
      note: "retrying later: again",
    });
    expect(await failAudioJob(env, { requestId: "nope", error: "x" })).toEqual({
      status: "not_found",
    });
  });
});

describe("/mkvid/audio routes", () => {
  const call = (env: Env, path: string, body?: unknown, token = "mk") =>
    app.request(
      `/mkvid/audio${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );

  it("needs the mkvid bearer", async () => {
    const env = makeEnv();
    expect((await call(env, "/claim", {}, "wrong")).status).toBe(401);
  });

  it("claim -> progress -> complete, and fail; bad bodies are 400, unknown requests 404", async () => {
    const env = makeEnv();
    const { id } = await heldSet(env, "rt");
    const claim = await call(env, "/claim", { sources: ["soundcloud"] });
    expect(claim.status).toBe(200);
    const job = ((await claim.json()) as { job: { requestId: string } }).job;
    expect(job.requestId).toBe(id);
    expect((await call(env, "/claim", {})).status).toBe(200);
    expect((await call(env, "/claim", { sources: "x" })).status).toBe(400);
    expect((await call(env, "/progress", { requestId: id, note: "set downloaded" })).status).toBe(
      200,
    );
    expect((await call(env, "/progress", { requestId: "nope" })).status).toBe(404);
    expect((await call(env, "/progress", {})).status).toBe(400);
    expect((await call(env, "/complete", { requestId: id })).status).toBe(400);
    expect((await call(env, "/complete", { requestId: "nope", rows: [] })).status).toBe(404);
    const done = await call(env, "/complete", {
      requestId: id,
      setSeconds: 700,
      rows: [report(5, 300), report(6, 360), report(7, 420)],
      stats: { withAudio: 3, missing: 2, sources: { youtube: 3 } },
    });
    expect(await done.json()).toMatchObject({
      status: "done",
      gated: 3,
      filled: 3,
      timedEnough: true,
    });
    expect((await call(env, "/fail", { requestId: id })).status).toBe(400);
    expect((await call(env, "/fail", { requestId: "nope", error: "x" })).status).toBe(404);
    expect(
      await (await call(env, "/fail", { requestId: id, error: "x", retryAfterSeconds: 60 })).json(),
    ).toMatchObject({
      status: "retry",
      attempts: 1,
    });
    expect(await (await call(env, "/status")).json()).toMatchObject({ ranAndReleased: 1 });
  });

  it("is advertised on /mkvid/health", async () => {
    const env = makeEnv();
    const res = await app.request(
      "/mkvid/health",
      { headers: { authorization: "Bearer mk" } },
      env,
    );
    expect(((await res.json()) as { audioCues?: boolean }).audioCues).toBe(true);
  });
});
