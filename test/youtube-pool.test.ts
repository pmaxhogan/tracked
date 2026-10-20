import { describe, it, expect } from "vitest";
import type { Env } from "../src/types";
import { fakeKV } from "./helpers/fake-kv";
import { fakeD1 } from "./helpers/fake-d1";
import {
  markProjectOut,
  OWN_PROJECT,
  pickProject,
  poolOut,
  poolProjects,
  recordUnits,
  storePushedTokens,
  unitCost,
  type PushedToken,
} from "../src/lib/youtube-pool";
import { getQuotaOut, noteQuotaOut, QUOTA_OUT_KEY } from "../src/lib/youtube-quota";
import { quotaDayEnd } from "../src/lib/mkvid";
import { YouTubeApiError } from "../src/lib/youtube-playlists";

const NOW_MS = Date.parse("2026-10-20T18:00:00Z");
const NOW = NOW_MS / 1000;
const CH = "UC_own";

function makeEnv(): Env & { CACHE: ReturnType<typeof fakeKV> } {
  return { CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV() } as unknown as Env & {
    CACHE: ReturnType<typeof fakeKV>;
  };
}
const tok = (account: string, over: Partial<PushedToken> = {}): PushedToken => ({
  account,
  label: `proj-${account}`,
  channelId: CH,
  accessToken: `at-${account}`,
  expiresAt: NOW + 3000,
  unitsToday: null,
  ...over,
});

describe("unitCost", () => {
  const base = "https://www.googleapis.com/youtube/v3";
  it("charges writes 50, searches 100 and other reads 1", () => {
    expect(unitCost("POST", `${base}/playlistItems?part=snippet`)).toBe(50);
    expect(unitCost("GET", `${base}/playlistItems?part=snippet`)).toBe(1);
    expect(unitCost("GET", `${base}/search?q=x`)).toBe(100);
    expect(unitCost("POST", `${base}/videos/rate?id=x`)).toBe(50);
    expect(unitCost("DELETE", `${base}/playlistItems?id=x`)).toBe(50);
  });
});

describe("storePushedTokens", () => {
  it("accepts the channel's tokens and rejects the rest by reason", async () => {
    const env = makeEnv();
    const r = await storePushedTokens(
      env,
      [
        tok("upload2"),
        tok("other", { channelId: "UC_else" }),
        tok(OWN_PROJECT),
        tok("old", { expiresAt: NOW - 1 }),
        { account: "bad" } as PushedToken,
      ],
      CH,
      NOW,
    );
    expect(r.accepted).toEqual(["upload2"]);
    expect(r.rejected).toEqual([
      { account: "other", reason: "channel" },
      { account: OWN_PROJECT, reason: "own" },
      { account: "old", reason: "expired" },
      { account: "bad", reason: "invalid" },
    ]);
    expect(await env.CACHE.get("yt:pool:seen")).toBe(String(NOW));
    expect(await env.CACHE.get("yt:pool:accounts", "json")).toEqual(["upload2"]);
  });
});

describe("pickProject and the ledger", () => {
  it("prefers the project with the most left, falls back when out, and gives up when all are", async () => {
    const env = makeEnv();
    await storePushedTokens(env, [tok("upload2")], CH, NOW);
    await recordUnits(env, OWN_PROJECT, "sync", 9000, NOW_MS);
    expect(await pickProject(env, { nowMs: NOW_MS })).toEqual({
      key: "upload2",
      accessToken: "at-upload2",
    });
    await markProjectOut(env, "upload2", NOW_MS);
    expect(await pickProject(env, { nowMs: NOW_MS })).toEqual({
      key: OWN_PROJECT,
      accessToken: null,
    });
    await markProjectOut(env, OWN_PROJECT, NOW_MS);
    expect(await pickProject(env, { nowMs: NOW_MS })).toBeNull();
    expect(await poolOut(env, NOW_MS)).toBe(true);
  });

  it("gives ties to the own project and honours exclude", async () => {
    const env = makeEnv();
    await storePushedTokens(env, [tok("upload2")], CH, NOW);
    expect((await pickProject(env, { nowMs: NOW_MS }))?.key).toBe(OWN_PROJECT);
    expect((await pickProject(env, { nowMs: NOW_MS, exclude: [OWN_PROJECT] }))?.key).toBe(
      "upload2",
    );
  });

  it("counts mkvid's own units and the margin against a project", async () => {
    const env = makeEnv();
    await storePushedTokens(env, [tok("upload2", { unitsToday: 9800 })], CH, NOW);
    const p = (await poolProjects(env, NOW_MS)).find((x) => x.key === "upload2")!;
    expect(p).toMatchObject({ mkvidUnits: 9800, remaining: 200, label: "proj-upload2" });
    // 200 left is under the margin: only the own project can be picked.
    expect((await pickProject(env, { nowMs: NOW_MS }))?.key).toBe(OWN_PROJECT);
  });

  it("sums recordUnits per project in poolProjects", async () => {
    const env = makeEnv();
    await recordUnits(env, OWN_PROJECT, "sync", 50, NOW_MS);
    await recordUnits(env, OWN_PROJECT, "sync", 50, NOW_MS);
    await recordUnits(env, OWN_PROJECT, "hygiene", 1, NOW_MS);
    const own = (await poolProjects(env, NOW_MS))[0]!;
    expect(own).toMatchObject({ key: OWN_PROJECT, label: "tracked-youtube", spent: 101 });
  });

  it("never throws without a DB binding", async () => {
    const env = { CACHE: fakeKV() } as unknown as Env;
    expect((await poolProjects(env, NOW_MS))[0]?.spent).toBe(0);
    expect(await getQuotaOut(env, NOW_MS)).toBeNull();
  });
});

describe("the legacy global flag", () => {
  const flag = JSON.stringify({ since: NOW - 60, until: quotaDayEnd(NOW_MS) });

  it("moves to the own project's flag when another project can take over", async () => {
    const env = makeEnv();
    await env.CACHE.put(QUOTA_OUT_KEY, flag);
    await storePushedTokens(env, [tok("upload2")], CH, NOW);
    expect(await getQuotaOut(env, NOW_MS)).toBeNull();
    expect(await env.CACHE.get("yt:quota:out:shared")).toBe(flag);
    expect(await env.CACHE.get(QUOTA_OUT_KEY)).toBeNull();
  });

  it("still returns the flag with no pushed token", async () => {
    const env = makeEnv();
    await env.CACHE.put(QUOTA_OUT_KEY, flag);
    expect(await getQuotaOut(env, NOW_MS)).toEqual(JSON.parse(flag));
  });

  it("is set by noteQuotaOut only when the whole pool is out", async () => {
    const env = makeEnv();
    await storePushedTokens(env, [tok("upload2")], CH, NOW);
    const e = new YouTubeApiError("insert", 403, "quotaExceeded", "x");
    await noteQuotaOut(env, e, undefined, NOW_MS);
    expect(await env.CACHE.get(QUOTA_OUT_KEY)).toBeNull();
    expect(await env.CACHE.get("yt:quota:out:shared")).not.toBeNull();
    await markProjectOut(env, "upload2", NOW_MS);
    await noteQuotaOut(env, e, undefined, NOW_MS);
    expect(await env.CACHE.get(QUOTA_OUT_KEY)).not.toBeNull();
  });
});
