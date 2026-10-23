import { describe, it, expect } from "vitest";
import { app } from "../src/index";
import type { Env } from "../src/types";
import { fakeKV } from "./helpers/fake-kv";
import { fakeD1 } from "./helpers/fake-d1";
import { enqueueMkvidRequest, getMkvidRequestForSet, replaceMkvidSource } from "../src/lib/mkvid";

function makeEnv(): Env {
  return {
    CACHE: fakeKV(),
    DB: fakeD1(),
    SUBS: fakeKV(),
    API_TOKEN: "tasker",
    YOUTUBE_API_KEY: "k",
    MKVID_TOKEN: "mk-secret",
  } as Env;
}

const SET_URL = "https://www.1001tracklists.com/tracklist/qwzr63k/mau-p-apex-stage.html";
const DEAD = "https://hearthis.at/embed/12631904/";
const LIVE = "https://hearthis.at/edmliveset/mau-p-live-at-creamfields-2025-friday-apex/";

async function queueGone(env: Env): Promise<string> {
  await enqueueMkvidRequest(env, {
    slug: "maup",
    setUrl: SET_URL,
    artistName: "Mau P",
    setTitle: "Mau P @ APEX Stage",
    setDate: "2025-08-22",
    source: { kind: "hearthis", url: DEAD },
    lastCueSeconds: 0,
    trackCount: 29,
    idedCount: 27,
  });
  const id = (await getMkvidRequestForSet(env, SET_URL))!.id;
  await env.DB.prepare(
    "UPDATE mkvid_requests SET status = 'failed', attempts = 3, error = ? WHERE id = ?",
  )
    .bind(
      "source: hearthis embed 12631904: this track or mix is not available (removed or private)",
      id,
    )
    .run();
  return id;
}

const post = (env: Env, path: string, body?: unknown, auth = true) =>
  app.request(
    `http://x${path}`,
    {
      method: "POST",
      headers: {
        ...(auth ? { Authorization: "Bearer tasker" } : {}),
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );

describe("replaceMkvidSource", () => {
  it("points a gone request at another upload and queues it with a fresh start", async () => {
    const env = makeEnv();
    const id = await queueGone(env);
    expect((await getMkvidRequestForSet(env, SET_URL))!.status).toBe("failed");
    const r = await replaceMkvidSource(env, id, `  ${LIVE}  `);
    expect(r).toEqual({
      ok: true,
      id,
      from: { kind: "hearthis", url: DEAD },
      to: { kind: "hearthis", url: LIVE },
    });
    const req = (await getMkvidRequestForSet(env, SET_URL))!;
    expect(req.status).toBe("pending");
    expect(req.sourceUrl).toBe(LIVE);
    expect(req.attempts).toBe(0);
    expect(req.error).toBeNull();
  });

  it("reads embeds and SoundCloud API URLs like a set page, and refuses anything else", async () => {
    const env = makeEnv();
    const id = await queueGone(env);
    expect(await replaceMkvidSource(env, id, "https://example.com/x/")).toMatchObject({
      ok: false,
      error: "invalid_url",
    });
    expect(await replaceMkvidSource(env, id, "https://hearthis.at/embed/999/")).toMatchObject({
      ok: true,
      to: { kind: "hearthis", url: "https://hearthis.at/embed/999/" },
    });
    expect(await replaceMkvidSource(env, id, "https://api.soundcloud.com/tracks/42")).toMatchObject(
      { ok: true, to: { kind: "soundcloud", url: "https://api.soundcloud.com/tracks/42" } },
    );
    expect(await replaceMkvidSource(env, "nope", LIVE)).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });

  it("leaves a request that is being rendered, done or banned alone", async () => {
    const env = makeEnv();
    const id = await queueGone(env);
    for (const status of ["claimed", "done", "banned"]) {
      await env.DB.prepare("UPDATE mkvid_requests SET status = ? WHERE id = ?")
        .bind(status, id)
        .run();
      expect(await replaceMkvidSource(env, id, LIVE)).toEqual({
        ok: false,
        id,
        error: "wrong_status",
        status,
      });
      expect((await getMkvidRequestForSet(env, SET_URL))!.sourceUrl).toBe(DEAD);
    }
  });

  it("is not undone by a recheck that still finds the page's gone recording", async () => {
    const env = makeEnv();
    const id = await queueGone(env);
    await replaceMkvidSource(env, id, LIVE);
    const again = await enqueueMkvidRequest(env, {
      slug: "maup",
      setUrl: SET_URL,
      artistName: "Mau P",
      setTitle: "Mau P @ APEX Stage",
      setDate: "2025-08-22",
      source: { kind: "hearthis", url: DEAD },
      lastCueSeconds: 0,
      trackCount: 29,
      idedCount: 27,
    });
    expect(again).toBe("exists");
    expect((await getMkvidRequestForSet(env, SET_URL))!.sourceUrl).toBe(LIVE);
  });
});

describe("POST /ops/mkvid/source/:id and /ops/mkvid/recheck-set/:id", () => {
  it("needs the bearer token", async () => {
    const env = makeEnv();
    const id = await queueGone(env);
    expect((await post(env, `/ops/mkvid/source/${id}`, { url: LIVE }, false)).status).toBe(401);
    expect((await post(env, `/ops/mkvid/recheck-set/${id}`, undefined, false)).status).toBe(401);
  });

  it("replaces the source and answers each refusal with its status", async () => {
    const env = makeEnv();
    const id = await queueGone(env);
    expect((await post(env, `/ops/mkvid/source/${id}`, { url: "nope" })).status).toBe(400);
    expect((await post(env, `/ops/mkvid/source/${id}`)).status).toBe(400);
    expect((await post(env, "/ops/mkvid/source/missing", { url: LIVE })).status).toBe(404);
    const r = await post(env, `/ops/mkvid/source/${id}`, { url: LIVE });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, to: { url: LIVE } });
    await env.DB.prepare("UPDATE mkvid_requests SET status = 'done' WHERE id = ?").bind(id).run();
    const busy = await post(env, `/ops/mkvid/source/${id}`, { url: LIVE });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ error: "wrong_status", status: "done" });
  });

  it("marks the request's set page due now", async () => {
    const env = makeEnv();
    const id = await queueGone(env);
    const before = Math.floor(Date.now() / 1000);
    const r = await post(env, `/ops/mkvid/recheck-set/${id}`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, id, setUrl: SET_URL });
    const row = await env.DB.prepare("SELECT next_due_at FROM set_schedule WHERE url = ?")
      .bind(SET_URL)
      .first<{ next_due_at: number }>();
    expect(row!.next_due_at).toBeGreaterThanOrEqual(before);
    expect(row!.next_due_at).toBeLessThanOrEqual(before + 5);
    expect((await post(env, "/ops/mkvid/recheck-set/missing")).status).toBe(404);
  });
});
