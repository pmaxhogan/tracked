import { describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import type { Env } from "../src/types";
import { fakeKV } from "./helpers/fake-kv";
import { fakeD1 } from "./helpers/fake-d1";
import { storeVerifiedList } from "./helpers/mkvid-lists";
import {
  enqueueMkvidRequest,
  getMkvidRequestForSet,
  getMkvidTracks,
  saveMkvidTracks,
} from "../src/lib/mkvid";
import { readinessFor } from "../src/lib/mkvid-readiness";
import {
  APPLE_BACKSTOP_KEY,
  appleBackstopBatch,
  applyAppleCuesToRequest,
  BACKSTOP_FIRST_DUE_SECONDS,
  BACKSTOP_SPACING_SECONDS,
} from "../src/lib/apple-backstop";
import { APPLE_ALBUM_KEY } from "../src/lib/apple-album";
import { updateAppSettings } from "../src/lib/app-settings";

const ALBUM_URL = "https://music.apple.com/us/album/some-dj-mix/42";

function makeEnv(): Env {
  return {
    CACHE: fakeKV({
      // Ten one-minute tracks named like storeVerifiedList's rows ("Title i").
      [APPLE_ALBUM_KEY("42")]: JSON.stringify({
        album: {
          id: "42",
          source: "jsonld",
          tracks: Array.from({ length: 10 }, (_, i) => ({
            name: `Title ${i} (Mixed)`,
            artist: null,
            seconds: 60,
          })),
        },
      }),
    }),
    DB: fakeD1(),
    SUBS: fakeKV(),
    API_TOKEN: "tasker",
    MKVID_TOKEN: "mk",
    DEV_BYPASS_CF_ACCESS: "1",
  } as unknown as Env;
}

const NOW = Math.floor(Date.now() / 1000);

/** A pending request whose verified list of 10 rows has its last 5 untimed (held), with the album link and the source length. */
async function heldSet(
  env: Env,
  n: string,
  opts: { album?: boolean; sourceSeconds?: number | null } = {},
) {
  const setUrl = `https://www.1001tracklists.com/tracklist/${n}/x.html`;
  await enqueueMkvidRequest(env, {
    slug: "dj",
    setUrl,
    artistName: "DJ",
    setTitle: `set ${n}`,
    setDate: "2020-01-01",
    source: { kind: "soundcloud", url: `https://api.soundcloud.com/tracks/${n}` },
    lastCueSeconds: 240,
    trackCount: 10,
    idedCount: 10,
  });
  await storeVerifiedList(env, setUrl, { rows: 10, untimedRows: 5 });
  const id = (await getMkvidRequestForSet(env, setUrl))!.id;
  if (opts.album !== false)
    await env.DB.prepare("UPDATE mkvid_request_tracks SET apple_album_url = ? WHERE request_id = ?")
      .bind(ALBUM_URL, id)
      .run();
  if (opts.sourceSeconds !== null)
    await env.DB.prepare(
      "INSERT INTO set_media_facts (set_url, slug, audio_max_seconds, fetched_at) VALUES (?, 'dj', ?, ?)",
    )
      .bind(setUrl, opts.sourceSeconds ?? 600, NOW)
      .run();
  return { id, setUrl };
}

const readiness = async (env: Env, id: string) =>
  (
    await readinessFor(env, [
      { id, status: "pending", notBefore: null, setDate: "2020-01-01", skipIdWait: false },
    ])
  ).get(id)!;

describe("applyAppleCuesToRequest", () => {
  it("fills the untimed rows from the album, unblocks the set, and keeps the wire format plain", async () => {
    const env = makeEnv();
    const { id } = await heldSet(env, "a");
    expect((await readiness(env, id)).state).toBe("untimed");
    const r = await applyAppleCuesToRequest(env, id);
    expect(r).toMatchObject({ outcome: "applied", filled: 5, timedEnough: true, hadAlbum: true });
    const rd = await readiness(env, id);
    expect(rd.state).not.toBe("untimed");
    expect(rd.apple).toEqual({
      cues: 5,
      note: "5 cues from Apple Music (10 of 10 tracks matched, album 10:00)",
    });
    const wire = await getMkvidTracks(env, id);
    expect(wire.tracks.map((t) => t.cueSeconds)).toEqual([
      0, 60, 120, 180, 240, 300, 360, 420, 480, 540,
    ]);
    expect(wire.tracks.some((t) => "cueFrom" in t)).toBe(false);
    // Idempotent.
    expect(await applyAppleCuesToRequest(env, id)).toMatchObject({ outcome: "applied", filled: 5 });
  });

  it("records why a length-mismatched album was skipped, and the set stays held", async () => {
    const env = makeEnv();
    const { id } = await heldSet(env, "b", { sourceSeconds: 3765 });
    expect(await applyAppleCuesToRequest(env, id)).toMatchObject({
      outcome: "skipped",
      filled: 0,
      timedEnough: false,
    });
    const rd = await readiness(env, id);
    expect(rd.state).toBe("untimed");
    expect(rd.apple).toEqual({ cues: 0, note: "length mismatch: album 10:00 vs source 1:02:45" });
  });

  it("uses the album when the source length is unknown but the real cues agree with it", async () => {
    const env = makeEnv();
    const { id } = await heldSet(env, "c", { sourceSeconds: null });
    expect(await applyAppleCuesToRequest(env, id)).toMatchObject({ outcome: "applied", filled: 5 });
  });

  it("follows the match-share setting", async () => {
    const env = makeEnv();
    expect((await updateAppSettings(env, { appleCues: { minMatchShare: 1 } })).ok).toBe(true);
    const { id } = await heldSet(env, "d");
    await env.DB.prepare(
      "UPDATE mkvid_request_tracks SET tracks = REPLACE(tracks, 'Title 9', 'Something Else') WHERE request_id = ?",
    )
      .bind(id)
      .run();
    expect(await applyAppleCuesToRequest(env, id)).toMatchObject({
      outcome: "skipped",
      note: "weak match: 9 of 10 tracks matched the Apple Music album (100% needed)",
    });
  });

  it("falls back to the parsed-page cache for the album link, and says so when there is none", async () => {
    const env = makeEnv();
    const { id } = await heldSet(env, "e", { album: false });
    expect(await applyAppleCuesToRequest(env, id)).toMatchObject({
      outcome: "no_album",
      note: "no Apple Music album known for this set",
    });
    await env.CACHE.put(
      "tl:v4:e",
      JSON.stringify({
        tracks: [],
        setAppleLink: ALBUM_URL,
        setYoutubeLink: null,
        setSoundcloudLink: null,
      }),
    );
    expect(await applyAppleCuesToRequest(env, id)).toMatchObject({ outcome: "applied" });
    const row = await env.DB.prepare(
      "SELECT apple_album_url FROM mkvid_request_tracks WHERE request_id = ?",
    )
      .bind(id)
      .first();
    expect(row).toEqual({ apple_album_url: ALBUM_URL });
  });

  it("runs on every save of the list for mkvid", async () => {
    const env = makeEnv();
    const { id, setUrl } = await heldSet(env, "f");
    // An untrusted page cannot replace the trusted list, but the save still runs the pass over the stored one.
    const r = await saveMkvidTracks(env, setUrl, {
      rows: [
        {
          artist: "A",
          title: "B",
          startSeconds: 0,
          isUnidentified: false,
          isMashupLinked: false,
          artworkUrl: null,
        } as never,
      ],
      decoy: { named: 0, mismatched: 0, suspected: false },
      setAppleLink: ALBUM_URL,
    });
    expect(r).toBe("kept");
    expect((await readiness(env, id)).apple?.cues).toBe(5);
  });
});

describe("POST /ui/api/mkvid/recheck-now/:id", () => {
  it("runs the Apple pass, queues a refetch, and answers the new readiness", async () => {
    const env = makeEnv();
    const { id, setUrl } = await heldSet(env, "g");
    const res = await app.request(
      `http://x/ui/api/mkvid/recheck-now/${id}`,
      {
        method: "POST",
        headers: { Origin: "http://x", "Content-Type": "application/json" },
        body: "{}",
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      refetchQueued: boolean;
      readiness: { state: string; apple: unknown };
    };
    expect(body).toMatchObject({ ok: true, refetchQueued: true });
    expect(body.readiness.state).not.toBe("untimed");
    expect(body.readiness.apple).toMatchObject({ cues: 5 });
    const s = await env.DB.prepare("SELECT next_due_at FROM set_schedule WHERE url = ?")
      .bind(setUrl)
      .first<{ next_due_at: number }>();
    expect(s!.next_due_at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });

  it("answers 404 for an unknown request", async () => {
    const res = await app.request(
      "http://x/ui/api/mkvid/recheck-now/nope",
      {
        method: "POST",
        headers: { Origin: "http://x", "Content-Type": "application/json" },
        body: "{}",
      },
      makeEnv(),
    );
    expect(res.status).toBe(404);
  });
});

describe("the one-off (POST /ops/mkvid/apple-backstop)", () => {
  it("evaluates every held set in batches, pulls the still-held rechecks in, and is idempotent", async () => {
    const env = makeEnv();
    const ok = await heldSet(env, "h1");
    const bad = await heldSet(env, "h2", { sourceSeconds: 3765 });
    const noAlbum = await heldSet(env, "h3", { album: false });
    // Someone's recheck is already due sooner than the slot it would get: never pushed out.
    await env.DB.prepare("INSERT INTO set_schedule (url, next_due_at, updated_at) VALUES (?, ?, ?)")
      .bind(noAlbum.setUrl, NOW + 1, NOW)
      .run();

    const call = (qs = "") =>
      app.request(
        `http://x/ops/mkvid/apple-backstop${qs}`,
        { method: "POST", headers: { Authorization: "Bearer tasker" } },
        env,
      );
    expect(
      (await app.request("http://x/ops/mkvid/apple-backstop", { method: "POST" }, env)).status,
    ).toBe(401);

    const first = (await (await call("?limit=2")).json()) as {
      done: boolean;
      batch: Record<string, number>;
    };
    expect(first.done).toBe(false);
    expect(first.batch).toMatchObject({
      evaluated: 2,
      withAlbum: 2,
      unblocked: 1,
      stillHeld: 1,
      pulledIn: 1,
    });
    const second = (await (await call("?limit=2")).json()) as {
      done: boolean;
      totals: Record<string, number>;
    };
    expect(second.done).toBe(true);
    expect(second.totals).toMatchObject({
      evaluated: 3,
      withAlbum: 2,
      unblocked: 1,
      stillHeld: 2,
      pulledIn: 1,
    });

    const due = async (u: string) =>
      (await env.DB.prepare("SELECT next_due_at FROM set_schedule WHERE url = ?")
        .bind(u)
        .first<{ next_due_at: number }>())!.next_due_at;
    const started = (
      JSON.parse(
        (env.CACHE as ReturnType<typeof fakeKV>)._store.get(APPLE_BACKSTOP_KEY)!.value,
      ) as { startedAt: number }
    ).startedAt;
    // The skipped set gets the first slot; the one already due sooner keeps its time.
    expect(await due(bad.setUrl)).toBeLessThanOrEqual(
      started + BACKSTOP_FIRST_DUE_SECONDS + BACKSTOP_SPACING_SECONDS,
    );
    expect(await due(noAlbum.setUrl)).toBe(NOW + 1);
    expect((await readiness(env, ok.id)).state).not.toBe("untimed");

    // Done: another call changes nothing; restart starts over harmlessly.
    const again = (await (await call()).json()) as { batch: Record<string, number> };
    expect(again.batch.evaluated).toBe(0);
    const restart = (await (await call("?restart=1")).json()) as { batch: Record<string, number> };
    expect(restart.batch).toMatchObject({ evaluated: 2, unblocked: 0, stillHeld: 2 });
  });

  it("the cron carries an unfinished run on", async () => {
    const env = makeEnv();
    await heldSet(env, "k1");
    await heldSet(env, "k2");
    await appleBackstopBatch(env, { limit: 1 });
    const { continueAppleBackstop } = await import("../src/lib/apple-backstop");
    expect(await continueAppleBackstop(env)).toBe(true);
    expect(await continueAppleBackstop(env)).toBe(false);
    const t = JSON.parse(
      (env.CACHE as ReturnType<typeof fakeKV>)._store.get(APPLE_BACKSTOP_KEY)!.value,
    );
    expect(t).toMatchObject({ evaluated: 2, unblocked: 2, done: true });
  });
});

vi.stubGlobal(
  "fetch",
  vi.fn(async () => new Response("unexpected network", { status: 599 })),
);
