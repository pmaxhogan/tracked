// Version-aware decisions, the review cap, the re-decide ops route and Search
// now's place in the queue, on the 2026-10-14 live queue: presave 6 (ATC -
// Around The World (La La La La La) (Odd Mob Remix)) and 8 (50 Cent - Candy
// Shop (Odd Mob Remix)) got six wrong remixes each in review; presave 7
// (Montell Jordan - This Is How We Do It (Odd Mob Loves California Edit)) one right one.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { app } from "../src/index";
import type { Env } from "../src/types";
import { fakeKV } from "./helpers/fake-kv";
import { fakeD1 } from "./helpers/fake-d1";
import { fakeR2 } from "./helpers/fake-r2";
import { makeLogger } from "../src/lib/log";
import { DEFAULT_APP_SETTINGS } from "../src/lib/app-settings";
import {
  claimSearchJob,
  completeSearchJob,
  decideMatch,
  listMatchGroups,
  redecideReviews,
  rejectMatch,
  searchNow,
  type PostedCandidate,
} from "../src/lib/presave-match";

vi.mock("../src/lib/web-push", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/web-push")>("../src/lib/web-push");
  return { ...actual, sendPushToAll: vi.fn(async () => ({ sent: 1, failed: 0, removed: 0 })) };
});
import { sendPushToAll } from "../src/lib/web-push";

const log = makeLogger({ test: "presave-match-versions" });
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const S = DEFAULT_APP_SETTINGS.presaveMatch;

const makeEnv = (): Env =>
  ({
    CACHE: fakeKV(),
    DB: fakeD1(),
    SUBS: fakeKV(),
    IMAGES: fakeR2(),
    API_TOKEN: "tasker",
    YOUTUBE_API_KEY: "",
    MKVID_TOKEN: "mk",
    DEV_BYPASS_CF_ACCESS: "1",
  }) as unknown as Env;

async function addPresave(
  env: Env,
  artist: string,
  title: string,
  o: { duration?: number | null; created?: number; links?: string } = {},
) {
  const r = await env.DB.prepare(
    "INSERT INTO presaves (track_id, artist, title, stage, links, duration_seconds, created_at, updated_at) VALUES (?, ?, ?, 'links', ?, ?, ?, ?)",
  )
    .bind(
      String(Math.floor(Math.random() * 1e9)),
      artist,
      title,
      o.links ?? "[]",
      o.duration === undefined ? 200 : o.duration,
      o.created ?? NOW - 3 * DAY,
      NOW,
    )
    .run();
  return Number(r.meta.last_row_id);
}

let vid = 0;
const cand = (title: string, over: Partial<PostedCandidate> = {}): PostedCandidate => ({
  source: "ytm",
  externalId: `v${String(++vid).padStart(10, "0")}`,
  title,
  artist: "Someone",
  videoType: "MUSIC_VIDEO_TYPE_UGC",
  durationSeconds: 200,
  scores: [],
  ...over,
});

const ATW = ["ATC", "Around The World (La La La La La) (Odd Mob Remix)"] as const;
const ATW_QUEUE = [
  "Around The World (La La La La La) (Edmood Remix)",
  "Around The World (La La La La La) (Orlina Remix)",
  "Around The World (La La La La La) [FiLo Project Techno Remix]",
  "Around The World (La La La La La) (Dj Ithal Remix 2025)",
  "Around The World (La La La La La) (Slowed & Reverb) Dethron Remix",
  "Around The World (La La La La La) - Omen's Free / DJ Nico Remix",
];
const CANDY = ["50 Cent", "Candy Shop (Odd Mob Remix)"] as const;
const CANDY_QUEUE: Array<[string, number]> = [
  ["Candy Shop (Onderkoffer Remix)", 200],
  ["Candy Shop (Bobjim Remix)", 200],
  ["Candy Shop (Afro House Remix)", 200],
  ["Candy Shop (Omada Remix)", 200],
  ["50 Cent Megamix (Candy Shop, In Da Club, P.I.M.P.)", 740],
  ["Candy Shop x Low (Alexander Vija Edit)", 200],
];
const HOW = ["Montell Jordan", "This Is How We Do It (Odd Mob Loves California Edit)"] as const;
const HOW_OK = "Montell Jordan - This Is How We Do It (Odd Mob Loves California Edit)";

beforeEach(() => (sendPushToAll as unknown as ReturnType<typeof vi.fn>).mockClear());

const decide = (presaveTitle: string, candTitle: string, over: Record<string, unknown> = {}) =>
  decideMatch(
    { source: "ytm", durationSeconds: 200, nameScore: 0.71, scores: [], ...over },
    200,
    S,
    { presave: { title: presaveTitle }, cand: { title: candTitle } },
  );

describe("decideMatch with version credits", () => {
  it.each(ATW_QUEUE)("rejects %s for the Odd Mob remix, even with no preview", (t) => {
    const v = decide(ATW[1], t);
    expect(v.decision).toBe("auto_rejected");
    expect(v.reason).toMatch(/^different version: .*, wanted Odd Mob Remix$/);
  });
  it("names the remixes in the reason", () => {
    expect(decide(ATW[1], ATW_QUEUE[0]!).reason).toBe(
      "different version: Edmood Remix, wanted Odd Mob Remix",
    );
  });
  it("rejects every presave 8 candidate, the megamix by its length and the mashup by its x", () => {
    for (const [t, d] of CANDY_QUEUE)
      expect(decide(CANDY[1], t, { durationSeconds: d }).decision).toBe("auto_rejected");
    expect(decide(CANDY[1], "Candy Shop (Odd Mob Remix)", { durationSeconds: 740 }).reason).toMatch(
      /megamix/,
    );
  });
  it("keeps the right version for review (presave 7)", () => {
    expect(decide(HOW[1], HOW_OK, { nameScore: 1 }).decision).toBe("review");
  });
  it("the original for a remix pre-save: rejected unless the audio matches the remix's preview", () => {
    expect(decide(ATW[1], "Around The World (La La La La La)", { nameScore: 1 })).toMatchObject({
      decision: "auto_rejected",
      reason: "no version credit (the original?), wanted Odd Mob Remix",
    });
    expect(
      decide(ATW[1], "Around The World (La La La La La)", {
        nameScore: 1,
        scores: [{ ref: "apple", score: 0.85 }],
      }).decision,
    ).toBe("review");
  });
  it("with no preview, weak names are rejected and strong ones reviewed", () => {
    expect(decide("Damager", "Damager", { nameScore: 0.5 })).toMatchObject({
      decision: "auto_rejected",
      reason: "no preview could be compared and the names match only 0.50",
    });
    expect(decide("Damager", "Damager", { nameScore: 1 }).decision).toBe("review");
  });
  it("Soulseek files are version-checked too, never auto-approved", () => {
    expect(
      decide(ATW[1], "ATC - Around The World (Edmood Remix).flac", { source: "slsk" }).decision,
    ).toBe("auto_rejected");
    expect(
      decide(ATW[1], "ATC - Around The World (Odd Mob Remix).flac", {
        source: "slsk",
        nameScore: 1,
        scores: [{ ref: "apple", score: 0.95 }],
      }).decision,
    ).toBe("review");
  });
});

async function run(env: Env, presaveId: number, candidates: PostedCandidate[]) {
  await env.DB.prepare(
    "INSERT INTO presave_match_searches (presave_id, kind, status, claimed_at, next_at, created_at, updated_at) VALUES (?, 'ytm', 'claimed', ?, ?, ?, ?) ON CONFLICT DO NOTHING",
  )
    .bind(presaveId, NOW, NOW, NOW, NOW)
    .run();
  const r = await completeSearchJob(
    env,
    { searchId: `${presaveId}:ytm`, references: [], candidates },
    log,
    { now: NOW },
  );
  if (r.status !== "done") throw new Error("not done");
  return r;
}

describe("completeSearchJob on the live queue", () => {
  it("presave 6 and 8: nothing reaches review, nobody is pushed; presave 7 keeps its one", async () => {
    const env = makeEnv();
    const p6 = await addPresave(env, ...ATW);
    const p8 = await addPresave(env, ...CANDY);
    const p7 = await addPresave(env, ...HOW);
    const r6 = await run(
      env,
      p6,
      ATW_QUEUE.map((t) => cand(t, { artist: "ATC" })),
    );
    expect(r6.decisions.map((d) => d.decision)).toEqual(Array(6).fill("auto_rejected"));
    const r8 = await run(
      env,
      p8,
      CANDY_QUEUE.map(([t, d]) => cand(t, { artist: "50 Cent", durationSeconds: d })),
    );
    expect(r8.decisions.map((d) => d.decision)).toEqual(Array(6).fill("auto_rejected"));
    expect(sendPushToAll).not.toHaveBeenCalled();
    const r7 = await run(env, p7, [cand(HOW_OK, { artist: "Montell Jordan" })]);
    expect(r7.decisions.map((d) => d.decision)).toEqual(["review"]);
    expect(sendPushToAll).toHaveBeenCalledTimes(1);
    const groups = await listMatchGroups(env, { view: "review" });
    expect(groups.map((g) => g.presave.id)).toEqual([p7]);
  });

  it("at most 3 reach review, best first; a rejection shows the next one", async () => {
    const env = makeEnv();
    const p = await addPresave(env, "JAWNS", "Damager", { duration: 170 });
    const five = [0.5, 0.6, 0.4, 0.65, 0.3].map((score) =>
      cand("Damager", { artist: "JAWNS", durationSeconds: 170, scores: [{ ref: "apple", score }] }),
    );
    const r = await run(env, p, five);
    expect(r.decisions.map((d) => d.decision)).toEqual([
      "review",
      "review",
      "superseded",
      "review",
      "superseded",
    ]);
    const held = await env.DB.prepare(
      "SELECT reason FROM presave_matches WHERE decision = 'superseded' LIMIT 1",
    ).first<{ reason: string }>();
    expect(held!.reason).toBe("not shown: 3 better candidates wait for review");
    await rejectMatch(env, r.decisions[3]!.id!, NOW);
    const review = await env.DB.prepare(
      "SELECT audio_score FROM presave_matches WHERE decision = 'review' ORDER BY audio_score DESC",
    ).all<{ audio_score: number }>();
    expect(review.results.map((x) => x.audio_score)).toEqual([0.6, 0.5, 0.4]);
  });
});

describe("redecideReviews (POST /ops/presave-matches/redecide)", () => {
  it("clears the old presave 6 / 8 reviews, keeps presave 7's, and is idempotent", async () => {
    const env = makeEnv();
    const p6 = await addPresave(env, ...ATW);
    const p8 = await addPresave(env, ...CANDY);
    const p7 = await addPresave(env, ...HOW);
    // The rows as the first release stored them: everything in review.
    let n = 0;
    const put = (pid: number, title: string, d = 200) =>
      env.DB.prepare(
        "INSERT INTO presave_matches (presave_id, source, external_id, title, artist, duration_seconds, name_score, audio_score, scores, decision, reason, created_at, updated_at) VALUES (?, 'ytm', ?, ?, 'x', ?, 0.71, NULL, '[]', 'review', 'no preview could be compared', ?, ?)",
      )
        .bind(pid, `old${++n}`, title, d, NOW, NOW)
        .run();
    for (const t of ATW_QUEUE) await put(p6, t);
    for (const [t, d] of CANDY_QUEUE) await put(p8, t, d);
    await put(p7, HOW_OK);
    const res = await app.fetch(
      new Request("https://w.example/ops/presave-matches/redecide", {
        method: "POST",
        headers: { authorization: "Bearer tasker" },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ checked: 13, rejected: 12, heldBack: 0, kept: 1 });
    const groups = await listMatchGroups(env, { view: "review" });
    expect(groups.map((g) => [g.presave.id, g.candidates.length])).toEqual([[p7, 1]]);
    const again = await redecideReviews(env, log, NOW);
    expect(again).toMatchObject({ checked: 1, rejected: 0, heldBack: 0, kept: 1 });
    const why = await env.DB.prepare(
      "SELECT reason FROM presave_matches WHERE presave_id = ? AND title LIKE '%Edmood%'",
    )
      .bind(p6)
      .first<{ reason: string }>();
    expect(why!.reason).toBe("different version: Edmood Remix, wanted Odd Mob Remix");
    // Never offered again: the claim lists them as known.
    await env.DB.prepare(
      "INSERT INTO presave_match_searches (presave_id, kind, status, next_at, created_at, updated_at) VALUES (?, 'ytm', 'done', 0, 0, 0)",
    )
      .bind(p6)
      .run();
    const { job } = await claimSearchJob(env, ["ytm"], log, NOW);
    expect(job!.known).toHaveLength(6);
  });

  it("needs API_TOKEN", async () => {
    const res = await app.fetch(
      new Request("https://w.example/ops/presave-matches/redecide", { method: "POST" }),
      makeEnv(),
    );
    expect(res.status).toBe(401);
  });
});

describe("Search now", () => {
  it("jumps ahead of older never-searched pre-saves", async () => {
    const env = makeEnv();
    await addPresave(env, "A", "Old one", { created: NOW - 30 * DAY });
    await addPresave(env, "B", "Old two", { created: NOW - 20 * DAY });
    const asked = await addPresave(env, "JAWNS", "Damager", { created: NOW - 10 * DAY });
    expect(await searchNow(env, asked, NOW)).toBe(true);
    expect((await claimSearchJob(env, ["ytm"], log, NOW)).job?.presaveId).toBe(asked);
  });
  it("also for a row Search now wrote before this fix (next_at = now - 1, never searched)", async () => {
    const env = makeEnv();
    await addPresave(env, "A", "Old one", { created: NOW - 30 * DAY });
    const asked = await addPresave(env, "JAWNS", "Damager", { created: NOW - 10 * DAY });
    await env.DB.prepare(
      "INSERT INTO presave_match_searches (presave_id, kind, status, next_at, created_at, updated_at) VALUES (?, 'ytm', 'done', ?, ?, ?)",
    )
      .bind(asked, NOW - 60_000, NOW - 60_000, NOW - 60_000)
      .run();
    expect((await claimSearchJob(env, ["ytm"], log, NOW)).job?.presaveId).toBe(asked);
  });
});
