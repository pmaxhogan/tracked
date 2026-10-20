/**
 * What waits on the YouTube quota (lib/quota-waiting.ts): the DJ-playlist
 * inserts that rank above the combined playlist and set-date ordering.
 */
import { describe, it, expect } from "vitest";
import type { Env } from "../src/types";
import { fakeKV } from "./helpers/fake-kv";
import { fakeD1 } from "./helpers/fake-d1";
import { djInsertsWaiting } from "../src/lib/quota-waiting";

function makeEnv(): Env {
  return { CACHE: fakeKV(), SUBS: fakeKV(), DB: fakeD1(), API_TOKEN: "t" } as unknown as Env;
}

async function sub(env: Env, slug: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO subscriptions (slug, source_url, added_at, position) VALUES (?, ?, 0, 0)",
  )
    .bind(slug, `https://www.1001tracklists.com/dj/${slug}/index.html`)
    .run();
}

async function tracklist(
  env: Env,
  slug: string,
  n: number,
  f: { processed?: number; abandoned?: number; videoId?: string | null },
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO tracklists (slug, url, position, discovered_at, processed, abandoned, video_known, video_id) VALUES (?, ?, ?, 0, ?, ?, 1, ?)",
  )
    .bind(
      slug,
      `https://www.1001tracklists.com/tracklist/${slug}-${n}/x.html`,
      n,
      f.processed ?? 0,
      f.abandoned ?? 0,
      f.videoId === undefined ? `vid${n}` : f.videoId,
    )
    .run();
}

async function mkvid(env: Env, n: number, playlistStatus: string | null): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO mkvid_requests (set_url, slug, artist_name, source, source_url, status, created_at, updated_at, playlist_status) VALUES (?, 'dj-one', 'DJ', 'soundcloud', 's', 'done', 0, 0, ?)",
  )
    .bind(`u${n}`, playlistStatus)
    .run();
}

describe("djInsertsWaiting", () => {
  it("is 0 with nothing waiting", async () => {
    expect(await djInsertsWaiting(makeEnv())).toBe(0);
  });

  it("counts unprocessed sets with a video of a followed DJ plus pending set uploads", async () => {
    const env = makeEnv();
    await sub(env, "dj-one");
    await tracklist(env, "dj-one", 1, {});
    await tracklist(env, "dj-one", 2, {});
    await mkvid(env, 1, "pending");
    expect(await djInsertsWaiting(env)).toBe(3);
  });

  it("leaves out abandoned, processed, video-less, unsubscribed and non-pending rows", async () => {
    const env = makeEnv();
    await sub(env, "dj-one");
    await tracklist(env, "dj-one", 1, { abandoned: 1 });
    await tracklist(env, "dj-one", 2, { processed: 1 });
    await tracklist(env, "dj-one", 3, { videoId: null });
    await tracklist(env, "dj-gone", 4, {});
    await mkvid(env, 1, "added");
    await mkvid(env, 2, null);
    expect(await djInsertsWaiting(env)).toBe(0);
  });

  it("is 0 rather than throwing when the database fails", async () => {
    const env = { DB: {} } as unknown as Env;
    expect(await djInsertsWaiting(env)).toBe(0);
  });
});
