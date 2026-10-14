import { describe, it, expect } from "vitest";
import type { Env } from "../src/types";
import { fakeKV } from "./helpers/fake-kv";
import { fakeD1 } from "./helpers/fake-d1";
import {
  claimMkvidRequest,
  dailyClaimCap,
  dailyClaimsUsed,
  DEFAULT_PROJECT_DAILY_CLAIM_CAP,
  enqueueMkvidRequest as enqueueRaw,
  failMkvidRequest,
  getMkvidProjectRegistry,
  getMkvidRequest,
  mkvidAccountUsage,
  mkvidProjects,
  recordMkvidProjects,
  requestSummary,
} from "../src/lib/mkvid";
import { DEFAULT_APP_SETTINGS, getAppSettings, updateAppSettings } from "../src/lib/app-settings";
import { makeLogger } from "../src/lib/log";
import { storeVerifiedList } from "./helpers/mkvid-lists";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    CACHE: fakeKV(),
    DB: fakeD1(),
    SUBS: fakeKV(),
    API_TOKEN: "t",
    YOUTUBE_API_KEY: "k",
    MKVID_TOKEN: "mk",
    ...overrides,
  } as Env;
}
const log = makeLogger({ task: "test" });

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

async function enqueue(env: Env, n: number) {
  for (let i = 1; i <= n; i++) {
    const setUrl = `https://x/tracklist/${i}`;
    // Newest set first: number 1 is claimed first.
    const day = String(28 - i).padStart(2, "0");
    if ((await enqueueRaw(env, { ...input, setUrl, setDate: `2026-09-${day}` })) === "queued")
      await storeVerifiedList(env, setUrl);
  }
}

const PROJECTS = [
  { key: "primary", label: "mkvid-uploads" },
  { key: "uploads2", label: "mkvid-uploads-2" },
  { key: "uploads3", label: null },
  { key: "shared", label: "tracked-youtube" },
];

describe("mkvid upload projects", () => {
  it("knows only primary and shared until mkvid reports more (back-compat)", async () => {
    const env = makeEnv();
    expect(await mkvidProjects(env)).toEqual([
      { key: "primary", label: "mkvid-uploads" },
      { key: "shared", label: "tracked-youtube" },
    ]);
    expect((await mkvidAccountUsage(env)).map((u) => u.account)).toEqual(["primary", "shared"]);
  });

  it("orders primary, the reported extras in mkvid's order, settings-only extras, shared last", async () => {
    const env = makeEnv();
    // mkvid listing shared before an extra does not move shared up.
    await recordMkvidProjects(env, [
      { key: "shared", label: "x" },
      { key: "uploads3", label: null },
      { key: "primary", label: "y" },
      { key: "uploads2", label: "mkvid-uploads-2" },
    ]);
    await updateAppSettings(env, { mkvid: { projectCaps: { zeta: 2 } } });
    expect(await mkvidProjects(env, await getAppSettings(env))).toEqual([
      { key: "primary", label: "mkvid-uploads" },
      { key: "uploads3", label: "uploads3" },
      { key: "uploads2", label: "mkvid-uploads-2" },
      { key: "zeta", label: "zeta" },
      { key: "shared", label: "tracked-youtube" },
    ]);
  });

  it("drops invalid keys and only rewrites the registry when it changes", async () => {
    const env = makeEnv();
    await recordMkvidProjects(env, [
      { key: "uploads2", label: "mkvid-uploads-2" },
      { key: "Bad Key!", label: "nope" },
      { key: "uploads2", label: "dupe" },
    ]);
    expect(await getMkvidProjectRegistry(env)).toEqual([
      { key: "uploads2", label: "mkvid-uploads-2" },
    ]);
    let puts = 0;
    const put = env.CACHE.put.bind(env.CACHE);
    env.CACHE.put = ((...a: Parameters<typeof put>) => {
      puts++;
      return put(...a);
    }) as typeof env.CACHE.put;
    await recordMkvidProjects(env, [{ key: "uploads2", label: "mkvid-uploads-2" }]);
    expect(puts).toBe(0);
    await recordMkvidProjects(env, [{ key: "uploads2", label: "renamed" }]);
    expect(puts).toBe(1);
  });

  it("caps: an extra project defaults to 6, settings override it, 0 pauses it; built-ins unchanged", async () => {
    const env = makeEnv({ MKVID_DAILY_CLAIM_CAP: "3", MKVID_SHARED_DAILY_CLAIM_CAP: "2" });
    expect(DEFAULT_PROJECT_DAILY_CLAIM_CAP).toBe(6);
    expect(dailyClaimCap(env, "uploads2", DEFAULT_APP_SETTINGS)).toBe(6);
    expect(dailyClaimCap(env, "uploads2")).toBe(6);
    expect(dailyClaimCap(env, "primary", DEFAULT_APP_SETTINGS)).toBe(3);
    expect(dailyClaimCap(env, "shared", DEFAULT_APP_SETTINGS)).toBe(2);
    await updateAppSettings(env, { mkvid: { projectCaps: { uploads2: 0, uploads3: 9 } } });
    const app = await getAppSettings(env);
    expect(dailyClaimCap(env, "uploads2", app)).toBe(0);
    expect(dailyClaimCap(env, "uploads3", app)).toBe(9);
    // null resets one to the default; the other is kept (deep merge).
    await updateAppSettings(env, { mkvid: { projectCaps: { uploads2: null } } });
    const back = await getAppSettings(env);
    expect(dailyClaimCap(env, "uploads2", back)).toBe(6);
    expect(dailyClaimCap(env, "uploads3", back)).toBe(9);
    // Keys must be project keys, caps 0..100.
    expect((await updateAppSettings(env, { mkvid: { projectCaps: { "Bad!": 1 } } })).ok).toBe(
      false,
    );
    expect((await updateAppSettings(env, { mkvid: { projectCaps: { ok: 101 } } })).ok).toBe(false);
  });

  it("claims fill primary, then the extras in order, then shared - whatever order mkvid offers them in", async () => {
    const env = makeEnv({ MKVID_DAILY_CLAIM_CAP: "1", MKVID_SHARED_DAILY_CLAIM_CAP: "1" });
    await recordMkvidProjects(env, PROJECTS);
    await updateAppSettings(env, { mkvid: { projectCaps: { uploads2: 2, uploads3: 1 } } });
    await enqueue(env, 7);
    const offered = ["shared", "uploads3", "uploads2", "primary"];
    const got: string[] = [];
    for (let i = 0; i < 5; i++) got.push((await claimMkvidRequest(env, log, offered))!.account);
    expect(got).toEqual(["primary", "uploads2", "uploads2", "uploads3", "shared"]);
    expect(await claimMkvidRequest(env, log, offered)).toBeNull();
    expect(await mkvidAccountUsage(env)).toEqual([
      { account: "primary", label: "mkvid-uploads", used: 1, cap: 1 },
      { account: "uploads2", label: "mkvid-uploads-2", used: 2, cap: 2 },
      { account: "uploads3", label: "uploads3", used: 1, cap: 1 },
      { account: "shared", label: "tracked-youtube", used: 1, cap: 1 },
    ]);
  });

  it("a paused (0) extra is skipped, one not offered is never used, an unknown offered key is ignored", async () => {
    const env = makeEnv({ MKVID_DAILY_CLAIM_CAP: "0", MKVID_SHARED_DAILY_CLAIM_CAP: "1" });
    await recordMkvidProjects(env, PROJECTS);
    await updateAppSettings(env, { mkvid: { projectCaps: { uploads2: 0 } } });
    await enqueue(env, 4);
    expect((await claimMkvidRequest(env, log, ["primary", "uploads2", "uploads3"]))!.account).toBe(
      "uploads3",
    );
    expect((await claimMkvidRequest(env, log, ["nobody", "shared"]))!.account).toBe("shared");
    expect(await claimMkvidRequest(env, log, ["nobody"])).toBeNull();
  });

  it("preferAccount may name an extra project", async () => {
    const env = makeEnv();
    await recordMkvidProjects(env, PROJECTS);
    await enqueue(env, 1);
    const r = (await claimMkvidRequest(env, log, ["primary", "uploads2"], null, "uploads2"))!;
    expect(r.account).toBe("uploads2");
    const row = (await getMkvidRequest(env, r.id))!;
    expect(row.account).toBe("uploads2");
    expect(requestSummary(row)).toMatchObject({ account: "uploads2", accountLabel: "uploads2" });
    expect(await dailyClaimsUsed(env, "uploads2")).toBe(1);
  });

  it("a youtube_quota failure goes back to pending at once: no attempt used, claim refunded", async () => {
    const env = makeEnv();
    await recordMkvidProjects(env, PROJECTS);
    await enqueue(env, 1);
    const r = (await claimMkvidRequest(env, log, ["uploads2"]))!;
    expect(await dailyClaimsUsed(env, "uploads2")).toBe(1);
    const out = await failMkvidRequest(
      env,
      {
        id: r.id,
        error:
          "youtube_quota: uploads2 project: The request cannot be completed because you have exceeded your quota.",
        jobId: "j1",
      },
      log,
    );
    expect(out).toEqual({ status: "pending", attempts: 0 });
    expect(await dailyClaimsUsed(env, "uploads2")).toBe(0);
    const row = (await getMkvidRequest(env, r.id))!;
    const now = Math.floor(Date.now() / 1000);
    expect(row.notBefore! - now).toBeGreaterThan(5 * 60);
    expect(row.notBefore! - now).toBeLessThanOrEqual(10 * 60 + 1);
  });
});
