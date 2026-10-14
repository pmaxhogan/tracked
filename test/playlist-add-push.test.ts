import { describe, it, expect, vi } from "vitest";
import { fakeKV } from "./helpers/fake-kv";
import { fakeD1 } from "./helpers/fake-d1";
import type { Env } from "../src/types";
import { makeLogger } from "../src/lib/log";
import {
  notifyPlaylistAdd,
  playlistAddPayload,
  setNameFromUrl,
} from "../src/lib/playlist-add-push";
import { presaveFoundPayload, trackUploadedPayload } from "../src/lib/web-push";

const SET_URL =
  "https://www.1001tracklists.com/tracklist/140g9hz9/eli-brown-steel-yard-creamfields-united-kingdom-2026-08-29.html";
const log = makeLogger({ test: true });

describe("playlist addition push", () => {
  it("opens /ui/set for the tracklist and is tagged per set", () => {
    const p = playlistAddPayload(
      {
        setUrl: SET_URL,
        setTitle: "Eli Brown @ Steel Yard, Creamfields 2026",
        playlistTitle: "Eli Brown (1001tklists)",
        via: "sync",
        videoId: "9Z8W5-47Ym0",
      },
      new Date("2026-10-14T12:00:00Z"),
    );
    expect(p).toEqual({
      kind: "playlist_add",
      title: "Added to Eli Brown (1001tklists)",
      body: "Eli Brown @ Steel Yard, Creamfields 2026",
      url: `/ui/set?url=${encodeURIComponent(SET_URL)}`,
      tag: "tracked-pladd-140g9hz9",
      ts: "2026-10-14T12:00:00.000Z",
      icon: "https://i.ytimg.com/vi/9Z8W5-47Ym0/hqdefault.jpg",
      image: "https://i.ytimg.com/vi/9Z8W5-47Ym0/hqdefault.jpg",
    });
  });

  it("names an mkvid upload and falls back to the URL when there is no title", () => {
    const p = playlistAddPayload({
      setUrl: SET_URL,
      setTitle: null,
      playlistTitle: "Eli Brown (1001tklists)",
      via: "mkvid",
      videoId: "x",
    });
    expect(p.title).toBe("Added to Eli Brown (1001tklists) (mkvid upload)");
    expect(p.body).toBe("Eli Brown Steel Yard Creamfields United Kingdom 2026 08 29");
    expect(setNameFromUrl("not a url")).toBe("not a url");
  });

  it("reads the title from the set page facts and never throws", async () => {
    const env = {
      CACHE: fakeKV(),
      SUBS: fakeKV(),
      DB: fakeD1(),
      VAPID_PUBLIC_KEY: "p",
      VAPID_PRIVATE_KEY: "k",
      VAPID_SUBJECT: "mailto:x@y.z",
    } as unknown as Env;
    await env.DB.prepare(
      "INSERT INTO set_media_facts (set_url, slug, set_title, fetched_at) VALUES (?, 'elibrown', 'Eli Brown @ Creamfields', 1)",
    )
      .bind(SET_URL)
      .run();
    const info = vi.spyOn(log, "info");
    await notifyPlaylistAdd(
      env,
      {
        setUrl: SET_URL,
        videoId: "9Z8W5-47Ym0",
        playlistTitle: "Eli Brown (1001tklists)",
        via: "sync",
      },
      log,
    );
    // No subscriptions: nothing sent, but the attempt is logged.
    expect(info).toHaveBeenCalledWith(
      "push.playlist_add",
      expect.objectContaining({ sent: 0, failed: 0 }),
    );
    const broken = {
      ...env,
      DB: {
        prepare: () => {
          throw new Error("D1 down");
        },
      },
    } as unknown as Env;
    await expect(
      notifyPlaylistAdd(
        broken,
        { setUrl: SET_URL, videoId: "x", playlistTitle: "P", via: "sync" },
        log,
      ),
    ).resolves.toBeUndefined();
  });

  it("does nothing when push is not configured", async () => {
    const env = {
      CACHE: fakeKV(),
      SUBS: fakeKV(),
      DB: {
        prepare: () => {
          throw new Error("should not be read");
        },
      },
    } as unknown as Env;
    await expect(
      notifyPlaylistAdd(
        env,
        { setUrl: SET_URL, videoId: "x", playlistTitle: "P", via: "sync" },
        log,
      ),
    ).resolves.toBeUndefined();
  });

  it("pre-save pushes carry the album art as the icon and the video thumbnail as the picture", () => {
    const art = "https://geo-media.beatport.com/image_size/300x300/x.jpg";
    const found = presaveFoundPayload({
      id: 1,
      artist: "A",
      title: "T",
      videoId: "abcdefghijk",
      artworkUrl: art,
    });
    expect(found.icon).toBe(art);
    expect(found.image).toBe("https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg");
    // No (or no usable) artwork: the thumbnail stands in.
    expect(
      presaveFoundPayload({
        id: 1,
        artist: "A",
        title: "T",
        videoId: "abcdefghijk",
        artworkUrl: null,
      }).icon,
    ).toBe("https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg");
    expect(
      presaveFoundPayload({
        id: 1,
        artist: "A",
        title: "T",
        videoId: "abcdefghijk",
        artworkUrl: "javascript:x",
      }).icon,
    ).toBe("https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg");
    const up = trackUploadedPayload({
      uploadId: 2,
      artist: "A",
      title: "T",
      sourceName: "soundcloud",
      videoId: "abcdefghijk",
      playlistTitle: "P",
      artworkUrl: art,
    });
    expect(up.icon).toBe(art);
    expect(up.image).toBe("https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg");
  });
});
