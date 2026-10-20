/**
 * The Pre-saves playlist (lib/presave-playlist.ts): migration 0032's backfill,
 * the hook that only queues, and the cron step that creates the playlist once,
 * inserts the due videos oldest first, skips what is already in it, holds on a
 * quota reply and backs off on other failures. YouTube is a stubbed global
 * fetch; D1 and KV are the in-memory fakes with the real migrations.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { fakeKV } from "./helpers/fake-kv";
import { fakeD1 } from "./helpers/fake-d1";
import type { Env } from "../src/types";
import { retryDuePresavePlaylist, PRESAVE_PLAYLIST_KEY } from "../src/lib/presave-playlist";
import { drainPresaveLikes, onPresaveResolved } from "../src/lib/presave-like";
import { clearQuotaOut, getQuotaOut } from "../src/lib/youtube-quota";
import { quotaDayEnd } from "../src/lib/mkvid";
import { updateAppSettings } from "../src/lib/app-settings";
import { makeLogger } from "../src/lib/log";

const here = dirname(fileURLToPath(import.meta.url));
const NOW = Date.UTC(2026, 9, 20, 18, 0, 0);
const log = makeLogger({ test: "presave-playlist" });

function makeEnv(): Env {
  const env = {
    CACHE: fakeKV(),
    DB: fakeD1(),
    SUBS: fakeKV(),
    API_TOKEN: "t",
    YOUTUBE_API_KEY: "k",
  } as unknown as Env;
  return env;
}
async function connect(env: Env) {
  await env.SUBS.put(
    "oauth:google",
    JSON.stringify({
      accessToken: "tok",
      refreshToken: "r",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      scope: "https://www.googleapis.com/auth/youtube",
      channelId: null,
      channelTitle: null,
      connectedAt: 0,
    }),
  );
}

const ytError = (status: number, reason: string) =>
  new Response(
    JSON.stringify({
      error: { code: status, message: reason, errors: [{ message: reason, reason }] },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );

type Yt = { created: unknown[]; inserted: string[]; listed: number };
/** YouTube: no playlist named "Pre-saves" yet unless `existing`; `inGlobal` are the videos already in it. */
function stub(
  o: {
    existing?: { id: string; title: string };
    inPlaylist?: string[];
    insert?: (videoId: string) => Response;
    list?: (playlistId: string) => Response | undefined;
  } = {},
): Yt {
  const yt: Yt = { created: [], inserted: [], listed: 0 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(input));
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer tok");
      if (u.pathname === "/youtube/v3/playlists" && (init?.method ?? "GET") === "GET") {
        return Response.json({
          items: o.existing ? [{ id: o.existing.id, snippet: { title: o.existing.title } }] : [],
        });
      }
      if (u.pathname === "/youtube/v3/playlists" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        yt.created.push(body);
        return Response.json({ id: "PL_new", snippet: { title: body.snippet.title } });
      }
      if (u.pathname === "/youtube/v3/playlistItems" && (init?.method ?? "GET") === "GET") {
        yt.listed++;
        const l = o.list?.(u.searchParams.get("playlistId") ?? "");
        if (l) return l;
        return Response.json({
          items: (o.inPlaylist ?? []).map((videoId) => ({ contentDetails: { videoId } })),
        });
      }
      if (u.pathname === "/youtube/v3/playlistItems" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          snippet: { playlistId: string; resourceId: { videoId: string } };
        };
        const id = body.snippet.resourceId.videoId;
        const r = o.insert?.(id);
        if (r) return r;
        yt.inserted.push(`${body.snippet.playlistId}:${id}`);
        return Response.json({ id: `item-${id}` });
      }
      throw new Error(`unexpected fetch ${String(input)}`);
    }),
  );
  return yt;
}

async function seed(
  env: Env,
  trackId: string,
  videoId: string | null,
  createdAt: number,
): Promise<number> {
  const r = await env.DB.prepare(
    "INSERT INTO presaves (track_id, artist, title, stage, youtube_video_id, created_at, updated_at) VALUES (?, 'A', ?, 'found', ?, ?, 1)",
  )
    .bind(trackId, `T${trackId}`, videoId, createdAt)
    .run();
  return Number(r.meta.last_row_id);
}
const cols = async (env: Env, id: number) =>
  (await env.DB.prepare(
    "SELECT presave_playlist_status AS status, presave_playlist_next_at AS next_at, presave_playlist_attempts AS attempts, presave_playlist_error AS error FROM presaves WHERE id = ?",
  )
    .bind(id)
    .first<Record<string, unknown>>())!;

afterEach(async () => {
  await drainPresaveLikes();
  vi.unstubAllGlobals();
});

describe("migration 0032", () => {
  it("marks every existing pre-save with a video pending and leaves the rest alone", async () => {
    const sql = readFileSync(
      resolve(here, "..", "migrations", "0032_presave_playlist.sql"),
      "utf8",
    );
    const db = fakeD1();
    expect(sql).toMatch(/UPDATE presaves/);
    await db
      .prepare(
        "INSERT INTO presaves (track_id, artist, title, stage, youtube_video_id, created_at, updated_at) VALUES ('1','A','T','found','vid1',1,1),('2','A','T','found',NULL,1,1)",
      )
      .run();
    // Run the migration's own backfill statement against those rows.
    const backfill = sql.slice(sql.indexOf("UPDATE presaves"));
    await db.exec(backfill.replace(/\s+/g, " "));
    const rows = (
      await db
        .prepare(
          "SELECT youtube_video_id AS v, presave_playlist_status AS s, presave_playlist_next_at AS n FROM presaves ORDER BY id",
        )
        .all<{ v: string | null; s: string | null; n: number | null }>()
    ).results;
    expect(rows).toEqual([
      { v: "vid1", s: "pending", n: 0 },
      { v: null, s: null, n: null },
    ]);
  });
});

describe("the hook only queues", () => {
  it("a newly resolved pre-save is pending and due now, with no YouTube call, whatever the like setting", async () => {
    const env = makeEnv();
    await updateAppSettings(env, { presave: { likeOnYouTube: false } });
    const yt = stub();
    const id = await seed(env, "1", "vidA", 1);
    await onPresaveResolved(env, id, log, { now: NOW });
    expect(await cols(env, id)).toMatchObject({ status: "pending", next_at: NOW, attempts: 0 });
    expect(yt.inserted).toEqual([]);
    expect(yt.created).toEqual([]);
  });

  it("a video that was added stays added when the pre-save is restored, and a replaced one is queued again", async () => {
    const env = makeEnv();
    await updateAppSettings(env, { presave: { likeOnYouTube: false } });
    const id = await seed(env, "1", "vidA", 1);
    await env.DB.prepare("UPDATE presaves SET presave_playlist_status = 'added' WHERE id = ?")
      .bind(id)
      .run();
    await onPresaveResolved(env, id, log, { now: NOW, restored: true });
    expect((await cols(env, id)).status).toBe("added");
    await onPresaveResolved(env, id, log, { now: NOW, replacedVideoId: "old" });
    expect((await cols(env, id)).status).toBe("pending");
  });
});

describe("retryDuePresavePlaylist", () => {
  it("creates the Pre-saves playlist once (unlisted) and adds two due videos, oldest first", async () => {
    const env = makeEnv();
    await connect(env);
    const yt = stub();
    const newer = await seed(env, "2", "vidNew", 200);
    const older = await seed(env, "1", "vidOld", 100);
    for (const id of [newer, older]) await onPresaveResolved(env, id, log, { now: NOW });
    await updateAppSettings(env, { presave: { likeOnYouTube: false } });

    const r = await retryDuePresavePlaylist(env, log, { nowMs: NOW });
    expect(r).toEqual({ added: 2, skipped: 0, failed: 0 });
    expect(yt.created).toHaveLength(1);
    expect(yt.created[0]).toMatchObject({
      snippet: { title: "Pre-saves" },
      status: { privacyStatus: "unlisted" },
    });
    expect(yt.inserted).toEqual(["PL_new:vidOld", "PL_new:vidNew"]);
    expect((await cols(env, older)).status).toBe("added");
    expect(JSON.parse((await env.SUBS.get(PRESAVE_PLAYLIST_KEY))!)).toEqual({
      playlistId: "PL_new",
      title: "Pre-saves",
    });

    // A second run has nothing due and creates nothing.
    const again = await retryDuePresavePlaylist(env, log, { nowMs: NOW + 1 });
    expect(again).toEqual({ added: 0, skipped: 0, failed: 0 });
    expect(yt.created).toHaveLength(1);
  });

  it("finds an existing playlist by title instead of creating one, and lists it once for the run", async () => {
    const env = makeEnv();
    await connect(env);
    const yt = stub({ existing: { id: "PL_have", title: "Pre-saves" }, inPlaylist: ["other"] });
    await seed(env, "1", "vidA", 1);
    await seed(env, "2", "vidB", 2);
    await env.DB.prepare(
      "UPDATE presaves SET presave_playlist_status = 'pending', presave_playlist_next_at = 0",
    ).run();
    const r = await retryDuePresavePlaylist(env, log, { nowMs: NOW });
    expect(r.added).toBe(2);
    expect(yt.created).toEqual([]);
    expect(yt.listed).toBe(1);
    expect(yt.inserted).toEqual(["PL_have:vidA", "PL_have:vidB"]);
  });

  it("a video already in the playlist is marked added without an insert", async () => {
    const env = makeEnv();
    await connect(env);
    const yt = stub({ existing: { id: "PL_have", title: "Pre-saves" }, inPlaylist: ["vidA"] });
    const a = await seed(env, "1", "vidA", 1);
    const b = await seed(env, "2", "vidB", 2);
    await env.DB.prepare(
      "UPDATE presaves SET presave_playlist_status = 'pending', presave_playlist_next_at = 0",
    ).run();
    const r = await retryDuePresavePlaylist(env, log, { nowMs: NOW });
    expect(r).toEqual({ added: 1, skipped: 1, failed: 0 });
    expect(yt.inserted).toEqual(["PL_have:vidB"]);
    expect((await cols(env, a)).status).toBe("added");
    expect((await cols(env, b)).status).toBe("added");
  });

  it("a quota error pushes next_at to the end of the quota day and stops the run", async () => {
    const env = makeEnv();
    await connect(env);
    stub({
      existing: { id: "PL_have", title: "Pre-saves" },
      insert: () => ytError(403, "quotaExceeded"),
    });
    const a = await seed(env, "1", "vidA", 1);
    const b = await seed(env, "2", "vidB", 2);
    await env.DB.prepare(
      "UPDATE presaves SET presave_playlist_status = 'pending', presave_playlist_next_at = 0",
    ).run();
    const r = await retryDuePresavePlaylist(env, log, { nowMs: NOW });
    expect(r).toEqual({ added: 0, skipped: 0, failed: 0 });
    const ca = await cols(env, a);
    expect(ca).toMatchObject({ status: "pending", next_at: quotaDayEnd(NOW) * 1000, attempts: 0 });
    // The second one was never tried; the quota hold is set for the other consumers.
    expect((await cols(env, b)).next_at).toBe(0);
    expect(await getQuotaOut(env, NOW)).not.toBeNull();
    await clearQuotaOut(env);
  });

  it("another error backs off 1 h x the tries and is failed after 5", async () => {
    const env = makeEnv();
    await connect(env);
    stub({
      existing: { id: "PL_have", title: "Pre-saves" },
      insert: () => ytError(500, "backendError"),
    });
    const a = await seed(env, "1", "vidA", 1);
    await env.DB.prepare(
      "UPDATE presaves SET presave_playlist_status = 'pending', presave_playlist_next_at = 0",
    ).run();
    let now = NOW;
    for (let n = 1; n <= 4; n++) {
      const r = await retryDuePresavePlaylist(env, log, { nowMs: now });
      expect(r.failed).toBe(0);
      expect(await cols(env, a)).toMatchObject({
        status: "pending",
        attempts: n,
        next_at: now + n * 3_600_000,
      });
      now += n * 3_600_000;
    }
    const last = await retryDuePresavePlaylist(env, log, { nowMs: now });
    expect(last.failed).toBe(1);
    expect(await cols(env, a)).toMatchObject({ status: "failed", attempts: 5 });
  });

  it("respects limit", async () => {
    const env = makeEnv();
    await connect(env);
    const yt = stub({ existing: { id: "PL_have", title: "Pre-saves" } });
    for (let i = 1; i <= 4; i++) await seed(env, String(i), `vid${i}`, i);
    await env.DB.prepare(
      "UPDATE presaves SET presave_playlist_status = 'pending', presave_playlist_next_at = 0",
    ).run();
    const r = await retryDuePresavePlaylist(env, log, { nowMs: NOW, limit: 3 });
    expect(r.added).toBe(3);
    expect(yt.inserted).toEqual(["PL_have:vid1", "PL_have:vid2", "PL_have:vid3"]);
    const left = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM presaves WHERE presave_playlist_status = 'pending'",
    ).first<{ n: number }>();
    expect(left!.n).toBe(1);
  });

  it("asks YouTube nothing when none is due or the account is not connected", async () => {
    const env = makeEnv();
    const yt = stub();
    expect(await retryDuePresavePlaylist(env, log, { nowMs: NOW })).toEqual({
      added: 0,
      skipped: 0,
      failed: 0,
    });
    await seed(env, "1", "vidA", 1);
    await env.DB.prepare(
      "UPDATE presaves SET presave_playlist_status = 'pending', presave_playlist_next_at = 0",
    ).run();
    expect((await retryDuePresavePlaylist(env, log, { nowMs: NOW })).added).toBe(0);
    expect(yt.created).toEqual([]);
  });

  it("a playlist deleted on YouTube (stale id, list 404) is created again and the row is added, no try counted", async () => {
    const env = makeEnv();
    await connect(env);
    await env.SUBS.put(
      PRESAVE_PLAYLIST_KEY,
      JSON.stringify({ playlistId: "PL_stale", title: "Pre-saves" }),
    );
    const yt = stub({
      list: (id) => (id === "PL_stale" ? ytError(404, "playlistNotFound") : undefined),
    });
    const a = await seed(env, "1", "vidA", 1);
    await env.DB.prepare(
      "UPDATE presaves SET presave_playlist_status = 'pending', presave_playlist_next_at = 0",
    ).run();
    const r = await retryDuePresavePlaylist(env, log, { nowMs: NOW });
    expect(r).toEqual({ added: 1, skipped: 0, failed: 0 });
    expect(yt.created).toHaveLength(1);
    expect(yt.inserted).toEqual(["PL_new:vidA"]);
    expect(await cols(env, a)).toMatchObject({ status: "added", attempts: 0 });
    expect(JSON.parse((await env.SUBS.get(PRESAVE_PLAYLIST_KEY))!).playlistId).toBe("PL_new");
  });

  it("a due row whose video a sibling pre-save already added is marked added without an insert", async () => {
    const env = makeEnv();
    await connect(env);
    const yt = stub({ existing: { id: "PL_have", title: "Pre-saves" } });
    const a = await seed(env, "1", "vidA", 1);
    const b = await seed(env, "2", "vidA", 2);
    await env.DB.prepare("UPDATE presaves SET presave_playlist_status = 'added' WHERE id = ?")
      .bind(a)
      .run();
    await env.DB.prepare(
      "UPDATE presaves SET presave_playlist_status = 'pending', presave_playlist_next_at = 0 WHERE id = ?",
    )
      .bind(b)
      .run();
    const r = await retryDuePresavePlaylist(env, log, { nowMs: NOW });
    expect(r).toEqual({ added: 0, skipped: 1, failed: 0 });
    expect(yt.inserted).toEqual([]);
    expect((await cols(env, b)).status).toBe("added");
  });

  it("a permanent refusal (video gone) is failed at once, not retried", async () => {
    const env = makeEnv();
    await connect(env);
    stub({
      existing: { id: "PL_have", title: "Pre-saves" },
      insert: () => ytError(404, "videoNotFound"),
    });
    const a = await seed(env, "1", "vidA", 1);
    await env.DB.prepare(
      "UPDATE presaves SET presave_playlist_status = 'pending', presave_playlist_next_at = 0",
    ).run();
    const r = await retryDuePresavePlaylist(env, log, { nowMs: NOW });
    expect(r.failed).toBe(1);
    expect(await cols(env, a)).toMatchObject({ status: "failed", attempts: 1 });
  });
});

describe("presave.playlistTitle", () => {
  it("refuses a whitespace-only title and trims the rest", async () => {
    const env = makeEnv();
    const bad = await updateAppSettings(env, { presave: { playlistTitle: "   " } });
    expect(bad.ok).toBe(false);
    const ok = await updateAppSettings(env, { presave: { playlistTitle: "  Mine " } });
    expect(ok.ok && ok.settings.presave.playlistTitle).toBe("Mine");
  });
});
