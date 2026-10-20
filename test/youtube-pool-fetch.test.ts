import { describe, it, expect, afterEach, vi } from "vitest";
import type { Env } from "../src/types";
import { fakeKV } from "./helpers/fake-kv";
import { fakeD1 } from "./helpers/fake-d1";
import { OWN_PROJECT, recordUnits, storePushedTokens } from "../src/lib/youtube-pool";
import {
  drainYoutubeLedger,
  getAccessToken,
  saveTokens,
  youtubePoolHooks,
  youtubeTokenRefresher,
  type StoredTokens,
} from "../src/lib/google-oauth";
import {
  addVideoToPlaylist,
  authedFetch,
  setAccessTokenRefresher,
  setYoutubePool,
} from "../src/lib/youtube-playlists";

const CH = "UC_own";
const API = "https://www.googleapis.com/youtube/v3";

type TestEnv = Env & { CACHE: ReturnType<typeof fakeKV>; SUBS: ReturnType<typeof fakeKV> };

async function makeEnv(): Promise<TestEnv> {
  const env = {
    CACHE: fakeKV(),
    DB: fakeD1(),
    SUBS: fakeKV(),
    GOOGLE_OAUTH_CLIENT_ID: "cid",
    GOOGLE_OAUTH_CLIENT_SECRET: "secret",
  } as unknown as TestEnv;
  const now = Math.floor(Date.now() / 1000);
  const own: StoredTokens = {
    accessToken: "own-at",
    refreshToken: "own-rt",
    expiresAt: now + 3000,
    scope: "youtube",
    channelId: CH,
    channelTitle: "Own",
    connectedAt: now - 1000,
  };
  await saveTokens(env, own);
  await storePushedTokens(
    env,
    [
      {
        account: "upload2",
        label: "upload2",
        channelId: CH,
        accessToken: "at-upload2",
        expiresAt: now + 3000,
        unitsToday: null,
      },
    ],
    CH,
  );
  setYoutubePool(youtubePoolHooks(env));
  setAccessTokenRefresher(youtubeTokenRefresher(env, { warn: () => {} }), { delaysMs: [0, 0] });
  return env;
}

async function ledger(env: Env): Promise<Record<string, number>> {
  await drainYoutubeLedger();
  const { results } = await env.DB.prepare(
    "SELECT project, SUM(units) AS n FROM youtube_quota_ledger GROUP BY project",
  ).all<{ project: string; n: number }>();
  return Object.fromEntries(results.map((r) => [r.project, Number(r.n)]));
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const quotaReply = () =>
  json(403, {
    error: { code: 403, message: "quota", errors: [{ reason: "quotaExceeded" }] },
  });
const bearer = (init?: RequestInit) =>
  new Headers(init?.headers ?? {}).get("Authorization")?.replace("Bearer ", "");

type Call = { method: string; url: string; token: string | undefined };

function stub(answer: (c: Call) => Response) {
  const calls: Call[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const c = { method: init?.method ?? "GET", url: String(input), token: bearer(init) };
    calls.push(c);
    return answer(c);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

afterEach(() => {
  setYoutubePool(null);
  setAccessTokenRefresher(null);
});

describe("authedFetch and the quota pool", () => {
  it("records a 200 insert's 50 units on the own project", async () => {
    const env = await makeEnv();
    const { fetcher } = stub(() => json(200, { id: "item1" }));
    await addVideoToPlaylist("PL1", "vid1", "own-at", fetcher);
    expect(await ledger(env)).toEqual({ [OWN_PROJECT]: 50 });
  });

  it("spills a quota-refused insert to the next project after checking for the video", async () => {
    const env = await makeEnv();
    const { fetcher, calls } = stub((c) => {
      if (c.method === "POST" && c.token === "own-at") return quotaReply();
      if (c.method === "GET") return json(200, { items: [] });
      return json(200, { id: "item2" });
    });
    await addVideoToPlaylist("PL1", "vid1", "own-at", fetcher);
    expect(await env.CACHE.get("yt:quota:out:shared")).not.toBeNull();
    expect(calls.map((c) => [c.method, c.token])).toEqual([
      ["POST", "own-at"],
      ["GET", "at-upload2"],
      ["POST", "at-upload2"],
    ]);
    const check = new URL(calls[1]!.url);
    expect(check.pathname).toBe("/youtube/v3/playlistItems");
    expect(check.searchParams.get("playlistId")).toBe("PL1");
    expect(check.searchParams.get("videoId")).toBe("vid1");
    // The insert's 50 plus the check's 1.
    expect(await ledger(env)).toEqual({ upload2: 51 });

    // A later call still holding the own token goes straight to upload2.
    calls.length = 0;
    await addVideoToPlaylist("PL1", "vid2", "own-at", fetcher);
    expect(calls.map((c) => [c.method, c.token])).toEqual([["POST", "at-upload2"]]);
  });

  it("does not insert again when the check finds the video", async () => {
    const env = await makeEnv();
    const { fetcher, calls } = stub((c) => {
      if (c.method === "POST") return quotaReply();
      return json(200, { items: [{ kind: "youtube#playlistItem", id: "existing" }] });
    });
    const res = await authedFetch(
      `${API}/playlistItems?part=snippet`,
      "own-at",
      {
        method: "POST",
        body: JSON.stringify({
          snippet: { playlistId: "PL1", resourceId: { kind: "youtube#video", videoId: "vid1" } },
        }),
      },
      fetcher,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe("existing");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(await ledger(env)).toEqual({ upload2: 1 });
  });

  it("returns a non-quota 403 as it is, without a retry", async () => {
    const env = await makeEnv();
    const { fetcher, calls } = stub(() =>
      json(403, { error: { code: 403, errors: [{ reason: "forbidden" }] } }),
    );
    const res = await authedFetch(`${API}/playlistItems?part=snippet`, "own-at", {}, fetcher);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(403);
    expect(calls).toHaveLength(1);
    expect(await env.CACHE.get("yt:quota:out:shared")).toBeNull();
  });

  it("drops a pushed token YouTube refuses with a 401 and goes on with the own one", async () => {
    const env = await makeEnv();
    await recordUnits(env, OWN_PROJECT, "sync", 9900);
    const first = await getAccessToken(env);
    expect(first?.accessToken).toBe("at-upload2");
    const { fetcher, calls } = stub((c) =>
      c.token === "at-upload2" ? json(401, { error: { code: 401 } }) : json(200, { items: [] }),
    );
    const res = await authedFetch(`${API}/playlists?mine=true`, first!.accessToken, {}, fetcher);
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.token)).toEqual(["at-upload2", "own-at"]);
    expect(await env.CACHE.get("yt:pool:token:upload2")).toBeNull();
    expect((await getAccessToken(env))?.accessToken).toBe("own-at");
    // tracked's own tokens are untouched.
    expect(((await env.SUBS.get("oauth:google", "json")) as StoredTokens).accessToken).toBe(
      "own-at",
    );
  });
});

describe("getAccessToken and the pool", () => {
  it("hands out the project with the most left and keeps the own token set", async () => {
    const env = await makeEnv();
    await recordUnits(env, OWN_PROJECT, "sync", 9900);
    const r = await getAccessToken(env);
    expect(r?.accessToken).toBe("at-upload2");
    expect(r?.tokens.channelId).toBe(CH);
    expect(r?.tokens.accessToken).toBe("own-at");
  });

  it("returns the own token when the pool is out", async () => {
    const env = await makeEnv();
    await recordUnits(env, OWN_PROJECT, "sync", 9900);
    await recordUnits(env, "upload2", "sync", 9900);
    expect((await getAccessToken(env))?.accessToken).toBe("own-at");
  });
});
