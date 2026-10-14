import { describe, it, expect } from "vitest";
import { app } from "../src/index";
import type { Env } from "../src/types";
import { fakeKV } from "./helpers/fake-kv";
import { fakeD1 } from "./helpers/fake-d1";
import { clearQuotaOut, getQuotaOut, noteQuotaOut, QUOTA_OUT_KEY } from "../src/lib/youtube-quota";
import { quotaDayEnd } from "../src/lib/mkvid";
import { YouTubeApiError } from "../src/lib/youtube-playlists";

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
const at = (iso: string) => Date.parse(iso);

describe("the quota day", () => {
  it("ends at the next midnight Pacific, also across the DST changes", () => {
    // Summer time (UTC-7), then the day clocks go forward (23 h long), then back (25 h long).
    expect(quotaDayEnd(at("2026-07-01T12:00:00Z"))).toBe(at("2026-07-02T07:00:00Z") / 1000);
    expect(quotaDayEnd(at("2026-03-08T12:00:00Z"))).toBe(at("2026-03-09T07:00:00Z") / 1000);
    expect(quotaDayEnd(at("2026-11-01T12:00:00Z"))).toBe(at("2026-11-02T08:00:00Z") / 1000);
    expect(quotaDayEnd(at("2026-01-15T07:59:59Z"))).toBe(at("2026-01-15T08:00:00Z") / 1000);
  });
});

describe('the "YouTube quota is out" flag', () => {
  const body = "{}";
  it("is set by a daily-quota reply until the next midnight Pacific, and ignored once that has passed", async () => {
    const env = makeEnv();
    const now = at("2026-10-11T23:55:00Z");
    await noteQuotaOut(
      env,
      new YouTubeApiError("playlistItems.insert", 403, "quotaExceeded", body),
      undefined,
      now,
    );
    expect(await getQuotaOut(env, now)).toEqual({
      since: now / 1000,
      until: at("2026-10-12T07:00:00Z") / 1000,
    });
    expect(await getQuotaOut(env, at("2026-10-12T07:00:01Z"))).toBeNull();
    await clearQuotaOut(env);
    expect(await env.CACHE.get(QUOTA_OUT_KEY)).toBeNull();
  });

  it("is not set by a per-minute rate limit, a 429, another 403 or a plain error", async () => {
    const env = makeEnv();
    for (const e of [
      new YouTubeApiError("playlistItems.insert", 403, "userRateLimitExceeded", body),
      new YouTubeApiError("playlistItems.insert", 403, "rateLimitExceeded", body),
      new YouTubeApiError("playlistItems.insert", 429, "quotaExceeded", body),
      new YouTubeApiError("playlistItems.insert", 403, "forbidden", body),
      new Error("boom"),
    ])
      await noteQuotaOut(env, e);
    expect(await getQuotaOut(env)).toBeNull();
  });

  it("Invalidate & resync for one DJ is not started while it is set: nothing is marked due, nothing fetched", async () => {
    const env = makeEnv();
    const url = "https://www.1001tracklists.com/tracklist/a1/dj-set-2026-10-01.html";
    await env.DB.prepare(
      "INSERT INTO subscriptions (slug, source_url, added_at, position) VALUES (?, ?, 0, 0)",
    )
      .bind("dj", "https://www.1001tracklists.com/dj/dj/")
      .run();
    await env.SUBS.put("subs:migrated", "{}");
    await env.SUBS.put(
      "oauth:google",
      JSON.stringify({
        accessToken: "tok",
        refreshToken: "r",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        scope: "s",
        channelId: null,
        channelTitle: null,
        connectedAt: 0,
      }),
    );
    await env.DB.prepare(
      "INSERT INTO tracklists (slug, url, position, discovered_at, processed, video_known, video_id, video_source, checked_at) VALUES ('dj', ?, 0, 0, 1, 1, 'vid00000001', '1001tl', 1900000000)",
    )
      .bind(url)
      .run();
    await env.CACHE.put("yt:plvids:PL", JSON.stringify({ videoIds: ["vid00000001"] }));
    await noteQuotaOut(
      env,
      new YouTubeApiError("playlistItems.insert", 403, "quotaExceeded", body),
    );
    const r = await app.request(
      "http://x/ui/api/resync/dj",
      {
        method: "POST",
        headers: { origin: "http://x", "content-type": "application/json" },
        body: "{}",
      },
      env,
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      slug: "dj",
      quotaHeld: { until: (await getQuotaOut(env))!.until },
    });
    expect(
      (await env.DB.prepare("SELECT checked_at FROM tracklists WHERE url = ?")
        .bind(url)
        .first<{ checked_at: number }>())!.checked_at,
    ).toBe(1900000000);
    expect(await env.CACHE.get("yt:plvids:PL")).not.toBeNull();
  });

  it("shows on the scheduler endpoint and the owner clears it early", async () => {
    const env = makeEnv();
    await noteQuotaOut(
      env,
      new YouTubeApiError("playlistItems.insert", 403, "dailyLimitExceeded", body),
    );
    const r = await app.request("http://x/ui/api/scheduler", {}, env);
    expect(
      ((await r.json()) as { quotaOut: { until: number } | null }).quotaOut!.until,
    ).toBeGreaterThan(Date.now() / 1000);
    const c = await app.request(
      "http://x/ui/api/scheduler/quota-clear",
      {
        method: "POST",
        headers: { origin: "http://x", "content-type": "application/json" },
        body: "{}",
      },
      env,
    );
    expect(c.status).toBe(200);
    expect(await getQuotaOut(env)).toBeNull();
    expect(
      (
        (await (await app.request("http://x/ui/api/scheduler", {}, env)).json()) as {
          quotaOut: unknown;
        }
      ).quotaOut,
    ).toBeNull();
  });
});
