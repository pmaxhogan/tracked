import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeD1 } from "./helpers/fake-d1";
import { fakeKV } from "./helpers/fake-kv";
import type { Env } from "../src/types";
import { makeLogger } from "../src/lib/log";

vi.mock("../src/lib/youtube-playlists", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/youtube-playlists")>(
    "../src/lib/youtube-playlists",
  );
  return { ...actual, addVideoToPlaylist: vi.fn() };
});
import { addVideoToPlaylist, YouTubeApiError } from "../src/lib/youtube-playlists";
import {
  dropClaim,
  INSERT_CLAIM_SECONDS,
  playlistInsertKey,
  pruneClaims,
  releaseClaim,
  takeClaim,
} from "../src/lib/insert-claims";
import { insertInOrder } from "../src/lib/playlist-order-store";
import { isConfirmedIn, markInPlaylist, markOutOfPlaylist } from "../src/lib/playlist-blocklist";
import { addToCombined, type CombinedHandle } from "../src/lib/combined-playlist";

const log = makeLogger({ task: "test" });
const add = vi.mocked(addVideoToPlaylist);

function makeEnv(): Env {
  return { CACHE: fakeKV(), SUBS: fakeKV(), DB: fakeD1() } as unknown as Env;
}

beforeEach(() => {
  add.mockReset().mockResolvedValue(undefined);
});

describe("takeClaim", () => {
  it("one holder at a time; free again after the window or once released", async () => {
    const env = makeEnv();
    const t = 1_800_000_000;
    const first = await takeClaim(env, "k", 60, t);
    expect(first).toEqual({ key: "k", at: t });
    expect(await takeClaim(env, "k", 60, t + 59)).toBeNull();
    expect(await takeClaim(env, "other", 60, t + 1)).not.toBeNull();
    // Past the window a crashed holder no longer counts.
    const later = await takeClaim(env, "k", 60, t + 60);
    expect(later).toEqual({ key: "k", at: t + 60 });
    // Releasing the old claim does not free the new holder's.
    await releaseClaim(env, first);
    expect(await takeClaim(env, "k", 60, t + 61)).toBeNull();
    await releaseClaim(env, later);
    expect(await takeClaim(env, "k", 60, t + 62)).not.toBeNull();
    await dropClaim(env, "k");
    expect(await takeClaim(env, "k", 60, t + 63)).not.toBeNull();
    await releaseClaim(env, null);
  });

  it("fails open when D1 cannot be asked, and prunes old rows", async () => {
    const broken = {
      DB: {
        prepare: () => {
          throw new Error("D1 down");
        },
      },
    } as unknown as Env;
    expect(await takeClaim(broken, "k")).not.toBeNull();
    await releaseClaim(broken, { key: "k", at: 1 });
    await dropClaim(broken, "k");
    expect(await pruneClaims(broken)).toBe(0);
    const env = makeEnv();
    await takeClaim(env, "old", 60, 1);
    await takeClaim(env, "new", 60);
    expect(await pruneClaims(env)).toBe(1);
    expect(await takeClaim(env, "new", 60)).toBeNull();
  });
});

describe("insertInOrder never makes a second copy", () => {
  const base = (_env?: Env) => ({
    playlistId: "PL",
    videoId: "vid",
    existing: new Set<string>(),
    accessToken: "tok",
    log,
  });

  it("two runs at once: one inserts, the other is told it is claimed", async () => {
    const env = makeEnv();
    const [a, b] = await Promise.all([
      insertInOrder(env, base(env)),
      insertInOrder(env, base(env)),
    ]);
    expect([a.skipped, b.skipped].sort()).toEqual(["claimed", undefined]);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("a video tracked put in and has not taken out is not inserted, whatever the snapshot says", async () => {
    const env = makeEnv();
    await markInPlaylist(env, "PL", "vid", "sync");
    expect(await insertInOrder(env, base(env))).toEqual({
      position: null,
      attempts: 0,
      skipped: "confirmed",
    });
    expect(add).not.toHaveBeenCalled();
    // The owner's undo puts it back.
    expect((await insertInOrder(env, { ...base(env), trustConfirmed: false })).skipped).toBe(
      undefined,
    );
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("a failed insert gives its claim back, and taking the video out frees it for a real re-add", async () => {
    const env = makeEnv();
    add.mockRejectedValueOnce(new YouTubeApiError("playlistItems.insert", 500, null, "oops"));
    await expect(insertInOrder(env, base(env))).rejects.toThrow(/500/);
    expect((await insertInOrder(env, base(env))).skipped).toBeUndefined();
    expect(add).toHaveBeenCalledTimes(2);
    // In now (claimed for the window): a stale snapshot right after does not insert it again.
    expect((await insertInOrder(env, base(env))).skipped).toBe("claimed");
    await markOutOfPlaylist(env, "PL", "vid", "sweep");
    expect(await isConfirmedIn(env, "PL", "vid")).toBe(false);
    expect((await insertInOrder(env, base(env))).skipped).toBeUndefined();
    expect(add).toHaveBeenCalledTimes(3);
    expect(await takeClaim(env, playlistInsertKey("PL", "vid"))).toBeNull();
    expect(INSERT_CLAIM_SECONDS).toBeGreaterThanOrEqual(600);
  });
});

describe("addToCombined", () => {
  it("leaves an insert another run is making right now to that run", async () => {
    const env = makeEnv();
    const handle = (): CombinedHandle =>
      ({ playlistId: "PLC", videoIds: new Set<string>(), attempts: 0, inserted: 0 }) as never;
    const h1 = handle();
    const h2 = handle();
    const [a, b] = await Promise.all([
      addToCombined(env, h1, "vid", "tok", log),
      addToCombined(env, h2, "vid", "tok", log),
    ]);
    expect([a, b].sort()).toEqual(["added", "duplicate"]);
    expect(add).toHaveBeenCalledTimes(1);
    // A refused insert gives the claim back.
    add.mockRejectedValueOnce(new YouTubeApiError("playlistItems.insert", 500, null, "oops"));
    await expect(addToCombined(env, handle(), "vid2", "tok", log)).rejects.toThrow(/500/);
    expect(await addToCombined(env, handle(), "vid2", "tok", log)).toBe("added");
  });
});
