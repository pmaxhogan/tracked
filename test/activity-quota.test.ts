import { describe, it, expect } from "vitest";
import { app } from "../src/index";
import type { Env } from "../src/types";
import { fakeKV } from "./helpers/fake-kv";
import { fakeD1 } from "./helpers/fake-d1";

function makeEnv(): Env {
  return {
    CACHE: fakeKV(),
    DB: fakeD1(),
    SUBS: fakeKV(),
    API_TOKEN: "t",
    YOUTUBE_API_KEY: "k",
    DEV_BYPASS_CF_ACCESS: "1",
  } as Env;
}
const get = (env: Env, path: string) => app.request(`http://x${path}`, { method: "GET" }, env);
type Row = {
  status: string;
  problem: boolean;
  detail: string | null;
  ref: { kind: string; key: string };
};
async function page(env: Env, qs: string): Promise<Row[]> {
  const r = await get(env, `/ui/api/activity${qs}`);
  expect(r.status).toBe(200);
  return ((await r.json()) as { rows: Row[] }).rows;
}
const enc = encodeURIComponent;
const SET =
  "https://www.1001tracklists.com/tracklist/abc123/dj-one-live-at-somewhere-2026-09-01.html";

// The Adam Beyer row of 2026-10-11, as stored then (its message cut to 160 characters) and as it is written now.
const LEGACY_MSG =
  'youtube playlistItems.insert 403: { "error": { "code": 403, "message": "The request cannot be completed because you have exceeded your <a href=\\"';
const NEW_MSG =
  'youtube playlistItems.insert 403 quotaExceeded: The request cannot be completed because you have exceeded your quota.\n{ "error": { "code": 403 } }';
const WAIT =
  "YouTube's daily quota is used up. It resets at midnight Pacific time, and tracked will try again.";

async function failedAddition(env: Env, id: number, tsMs: number, msg: string, status = "failed") {
  const summary = {
    t: new Date(tsMs).toISOString(),
    status,
    slug: "adam-beyer",
    artist: "Adam Beyer",
    set: SET,
    vid: "4Tf2dNjuRLg",
    via: "pool",
    trg: "manual.one",
    msg: msg.slice(0, 160),
    ms: 18609,
    cmb: null,
  };
  await env.DB.prepare(
    "INSERT INTO playlist_additions (id, t, ts, status, slug, set_url, video_id, summary, record) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      summary.t,
      tsMs,
      status,
      "adam-beyer",
      SET,
      "4Tf2dNjuRLg",
      JSON.stringify(summary),
      JSON.stringify({ message: msg, status }),
    )
    .run();
}

describe("YouTube quota replies in the Activity feed", () => {
  it('reads a quota failure, old or new, as "quota": a wait with its explanation, not a problem', async () => {
    const env = makeEnv();
    await failedAddition(env, 1, 3000, LEGACY_MSG);
    await failedAddition(env, 2, 2000, NEW_MSG);
    await failedAddition(
      env,
      3,
      1000,
      "youtube playlistItems.insert 404 videoNotFound: Video not found.\n{}",
    );
    const rows = await page(env, "");
    expect(rows.map((r) => [r.status, r.problem, r.detail])).toEqual([
      ["quota", false, WAIT],
      ["quota", false, WAIT],
      ["failed", false, "playlistItems.insert 404 videoNotFound: Video not found."],
    ]);
    // Filterable like any status, and "Problems only" leaves them out.
    expect(await page(env, `?f.status=${enc("in:quota")}`)).toHaveLength(2);
    expect(await page(env, "?f.problem=eq:1")).toHaveLength(0);
  });

  it('a per-minute rate limit is "rate_limited", also a wait; an abandoned row stays abandoned', async () => {
    const env = makeEnv();
    await failedAddition(
      env,
      1,
      3000,
      "youtube playlistItems.insert 403 userRateLimitExceeded: Slow down.\n{}",
    );
    await failedAddition(env, 2, 2000, NEW_MSG, "abandoned");
    const rows = await page(env, "");
    expect(rows.map((r) => [r.status, r.problem])).toEqual([
      ["rate_limited", false],
      ["abandoned", true],
    ]);
  });

  it("a removal that hit quota is a wait too; any other failed owner removal is still a problem", async () => {
    const env = makeEnv();
    const ins = (id: number, source: string, detail: string | null) =>
      env.DB.prepare(
        "INSERT INTO playlist_removals (id, at, source, status, slug, set_url, video_id, playlist_id, playlist_kind, reason, detail) VALUES (?, ?, ?, 'failed', 'dj-one', ?, ?, 'PL1', 'artist', 'short', ?)",
      )
        .bind(id, 100 - id, source, SET, `vid${id}`, detail)
        .run();
    await ins(1, "owner", NEW_MSG);
    await ins(2, "owner", "youtube playlistItems.delete 500: boom");
    await ins(3, "owner", null);
    await ins(4, "sweep", LEGACY_MSG);
    const rows = await page(env, "?sort=ts");
    expect(rows.map((r) => [r.ref.key, r.status, r.problem])).toEqual([
      ["4", "quota", false],
      ["3", "failed", true],
      ["2", "failed", true],
      ["1", "quota", false],
    ]);
    expect(rows.find((r) => r.ref.key === "2")!.detail).toContain("playlistItems.delete 500");
  });

  it("an abandoned row with a quota error is described as given up, not as a wait to be retried", async () => {
    const env = makeEnv();
    await failedAddition(env, 1, 3000, NEW_MSG, "abandoned");
    await failedAddition(env, 2, 2000, LEGACY_MSG, "abandoned");
    const rows = await page(env, "");
    for (const r of rows) {
      expect(r.status).toBe("abandoned");
      expect(r.problem).toBe(true);
      expect(r.detail).toMatch(
        /^Given up after repeated failures; YouTube's daily quota was used up/,
      );
      expect(r.detail).not.toContain("try again");
    }
    const d = (await (await get(env, "/ui/api/playlist-addition-detail?key=1")).json()) as {
      record: { youtubeError: { wait: boolean; label: string | null; headline: string } };
    };
    expect(d.record.youtubeError).toMatchObject({ wait: false, label: null });
    expect(d.record.youtubeError.headline).toContain("Given up");
  });

  it("the addition detail adds the parsed reply: a wait for quota, nothing for a plain message", async () => {
    const env = makeEnv();
    await failedAddition(env, 1, 3000, NEW_MSG);
    await failedAddition(env, 2, 2000, "plain old failure");
    const q = (await (await get(env, "/ui/api/playlist-addition-detail?key=1")).json()) as {
      record: { youtubeError?: unknown };
    };
    expect(q.record.youtubeError).toMatchObject({
      kind: "quota",
      label: "quota exceeded",
      explanation: WAIT,
      raw: '{ "error": { "code": 403 } }',
    });
    const o = (await (await get(env, "/ui/api/playlist-addition-detail?key=2")).json()) as {
      record: { youtubeError?: unknown };
    };
    expect(o.record.youtubeError).toBeUndefined();
  });
});
