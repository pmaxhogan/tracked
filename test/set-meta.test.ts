/**
 * Set and track page metadata (src/lib/set-meta.ts): the parsers against real
 * pages (a festival set with a YouTube player, a radio show with a source, an
 * older Matroda page, a track page), the D1 store, the stored-pages backfill
 * and the Set page's diagnostics field.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "../src/types";
import { fakeD1 } from "./helpers/fake-d1";
import { fakeKV } from "./helpers/fake-kv";
import { fakeR2 } from "./helpers/fake-r2";
import {
  genreKeyOf,
  loadSetMeta,
  META_PAGES_CURSOR_KEY,
  META_PAGES_DONE_KEY,
  parseSetMeta,
  parseTrackMeta,
  parseWordsDuration,
  recordSetMeta,
  recordTrackMeta,
  setMetaPagesStep,
} from "../src/lib/set-meta";
import { recordTrackPageHtml } from "../src/lib/track-sets";
import { recordPageFacts } from "../src/lib/playlist-hygiene";
import { setDiagnostics } from "../src/lib/set-diagnostics";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(resolve(here, "fixtures", name), "utf8");
const FEST = fixture("tracklist-meta-festival.html");
const RADIO = fixture("tracklist-meta-radio.html");
const MATRODA = fixture("tracklist-matroda.html");
const DECOY = fixture("tracklist-decoy-dcr839.html");
const TRACK = fixture("track-page-reedit.html");
const FEST_URL =
  "https://www.1001tracklists.com/tracklist/117cj421/john-summit-seawheeze-sunset-festival-brockton-fields-vancouver-canada-2026-08-08.html";
const RADIO_URL =
  "https://www.1001tracklists.com/tracklist/107cd4y1/mau-p-xxx-radio-158-2025-10-17.html";
const TRACK_URL =
  "https://www.1001tracklists.com/track/19udfbup/adrian-hour-hear-what-they-hear-danny-howard-re-edit/index.html";
const NOW = 1_792_700_000;

function makeEnv(over: Partial<Env> = {}): Env {
  return { CACHE: fakeKV(), SUBS: fakeKV(), DB: fakeD1(), ...over } as Env;
}

async function seedSet(env: Env, url: string, slug = "john-summit") {
  await env.DB.prepare(
    "INSERT INTO tracklists (slug, url, position, discovered_at, processed) VALUES (?, ?, 0, 0, 1)",
  )
    .bind(slug, url)
    .run();
}

describe("parseSetMeta", () => {
  it("reads a festival set: genres with the site's keys, the info table, boxes, the YouTube player", () => {
    const d = parseSetMeta(FEST_URL, FEST);
    expect(d.genres).toEqual([
      { name: "Dance / Electro Pop", key: "dance-electro-pop" },
      { name: "Tech House", key: "tech-house" },
    ]);
    expect(d).toMatchObject({
      tlId: "117cj421",
      itemId: "680424",
      date: "2026-08-08",
      numTracks: 34,
      author: "John Summit",
      isLive: true,
      views: 86,
      likes: 2,
      ided: 25,
      total: 26,
      durationSeconds: 3041,
      shortLink: "https://1001.tl/117cj421",
      postedBy: { name: "Luigi.edm7", path: "/user/luigi.edm7/index.html", score: "423.4k" },
      postedAt: "2026-10-21 16:54:00",
    });
    expect(d.info["TL date"]).toBe("Sat, Aug 8 2026");
    expect(d.boxes.map((b) => [b.title, b.country, b.object])).toEqual([
      ["John Summit", "United States", 2],
      ["SeaWheeze Sunset Festival", null, 3],
      ["Brockton Fields Vancouver", null, 3],
    ]);
    expect(d.boxes[0]!.links.map((l) => l.label)).toContain("Spotify");
    expect(d.media).toEqual([
      expect.objectContaining({
        source: "13",
        sourceName: "YouTube",
        seconds: 3041,
        externalId: "mEREVV04unU",
      }),
    ]);
    expect(d.video?.uploadDate).toBe("2026-10-21T16:54:00+00:00");
    expect(d.notice).toMatch(/no \(full\) recording/);
    expect(d.rows).toBeUndefined();
    expect(parseSetMeta(FEST_URL, FEST, { rows: true }).rows!.length).toBeGreaterThan(20);
  });

  it("reads a radio show's source link and an all-IDed count; an older page too", () => {
    const r = parseSetMeta(RADIO_URL, RADIO);
    expect(r.headingSources).toEqual([
      { label: "XXX Radio", href: "/source/m1cbjm/xxx-radio/index.html", id: "m1cbjm" },
    ]);
    expect(r).toMatchObject({ ided: 13, total: 13, isLive: false, media: [], video: null });
    const m = parseSetMeta("https://www.1001tracklists.com/tracklist/l3uw499/x.html", MATRODA);
    expect(m.genres.map((g) => g.key)).toEqual(["house", "tech-house"]);
    expect(m).toMatchObject({ views: 6172, durationSeconds: 5286 });
    expect(m.headingArtists[0]).toMatchObject({ djSlug: "matroda" });
  });

  it("falls back to the genre box and to a slug of the name", () => {
    const html =
      '<div id="tlTab" data-id="x1"><meta itemprop="genre" content="tracklist"></div><div id="tl_music_styles">Drum &amp; Bass, Jackin\' House</div>';
    expect(parseSetMeta("u", html).genres).toEqual([
      { name: "Drum & Bass", key: "drum-bass" },
      { name: "Jackin' House", key: "jackin-house" },
    ]);
    expect(genreKeyOf("Tech House", new Map([["tech house", "th"]]))).toBe("th");
    expect(parseSetMeta("u", "<p>nothing</p>")).toMatchObject({
      genres: [],
      tlId: null,
      views: null,
    });
  });

  it("parses worded durations", () => {
    expect(parseWordsDuration("1 hour 2 minutes 3 seconds")).toBe(3723);
    expect(parseWordsDuration("57 minutes")).toBe(3420);
    expect(parseWordsDuration("")).toBeNull();
  });
});

describe("parseTrackMeta", () => {
  it("reads label, genre, BPM, year, remix base, plays, support and every player", () => {
    const t = parseTrackMeta(TRACK_URL, TRACK);
    expect(t).toMatchObject({
      pageId: "19udfbup",
      itemId: "908850",
      artist: "Adrian Hour",
      title: "Hear What They Hear (Danny Howard Re-Edit)",
      version: "Danny Howard Re-Edit",
      genre: "Tech House",
      durationSeconds: 436,
      bpm: 128,
      releaseYear: 2023,
      plays: 61,
      tracklists: 61,
      djSupport: 43,
      remixOf: { pageId: "28088bpf" },
      label: { name: "TOOLROOM", country: "United Kingdom" },
      firstPlayed: { date: "2016-10-03" },
      lastPlayed: { date: "2026-03-24" },
    });
    expect(t.supporters.length).toBe(43);
    expect(t.credits.map((c) => c.country)).toEqual(["Argentina", "United Kingdom"]);
    expect(t.media.map((m) => m.sourceName)).toEqual([
      "SoundCloud",
      "YouTube",
      "Beatport",
      "Apple Music",
      "Spotify",
      "Traxsource",
    ]);
    expect(t.media.every((m) => m.official)).toBe(true);
    expect(t.songstats).toBe("https://songstats.com/19udfbup");
  });
});

describe("storage", () => {
  it("stores a set's document and genres; a later fetch replaces them, an empty genre list keeps them", async () => {
    const env = makeEnv();
    const doc = await recordSetMeta(env, FEST_URL, FEST, "sync", undefined, NOW);
    expect(doc?.genres.length).toBe(2);
    let s = await loadSetMeta(env, FEST_URL);
    expect(s).toMatchObject({ source: "sync", fetchedAt: NOW });
    expect(s!.genres.map((g) => g.key)).toEqual(["dance-electro-pop", "tech-house"]);
    expect(s!.meta?.rows).toBeUndefined();
    expect((await loadSetMeta(env, FEST_URL, { rows: true }))!.meta!.rows!.length).toBeGreaterThan(
      20,
    );
    // A newer fetch with other genres.
    const html = FEST.replace(
      'content="Dance / Electro Pop"><meta itemprop="genre" content="Tech House">',
      'content="Techno">',
    );
    await recordSetMeta(env, FEST_URL, html, "page", undefined, NOW + 10);
    s = await loadSetMeta(env, FEST_URL);
    expect(s!.genres.map((g) => g.key)).toEqual(["techno"]);
    // An older page never overwrites a newer one.
    await recordSetMeta(env, FEST_URL, FEST, "pages", undefined, NOW - 10);
    expect((await loadSetMeta(env, FEST_URL))!.source).toBe("page");
    expect(await loadSetMeta(env, RADIO_URL)).toBeNull();
  });

  it("keeps the rows of a clean page when a decoy page of the same set comes in", async () => {
    const env = makeEnv();
    const url = "https://www.1001tracklists.com/tracklist/2kq9xxx/a.html";
    await recordSetMeta(env, url, MATRODA, "sync", undefined, NOW);
    await recordSetMeta(env, url, DECOY, "sync", undefined, NOW + 5);
    const s = await loadSetMeta(env, url, { rows: true });
    expect(s!.meta!.rows!.length).toBeGreaterThan(10);
    expect(s!.meta!.tlId).not.toBe("l3uw499");
  });

  it("refuses what is not a set page and never throws", async () => {
    const env = makeEnv();
    expect(await recordSetMeta(env, "https://x/dj/a/", FEST, "sync")).toBeNull();
    expect(await recordSetMeta(env, FEST_URL, "<html>captcha</html>", "sync")).toBeNull();
    const broken = makeEnv({
      DB: {
        prepare: () => {
          throw new Error("d1 down");
        },
      } as unknown as D1Database,
    });
    const warns: string[] = [];
    const log = { warn: (e: string) => warns.push(e), info() {}, error() {} } as never;
    expect(await recordSetMeta(broken, FEST_URL, FEST, "sync", log)).toBeNull();
    expect(warns).toEqual(["set_meta.record_failed"]);
    expect(await recordTrackMeta(broken, TRACK_URL, TRACK, log)).toBeNull();
  });

  it("stores a track page, through the pre-save lookup's hook too", async () => {
    const env = makeEnv();
    await recordTrackPageHtml(env, TRACK_URL, TRACK);
    const row = await env.DB.prepare("SELECT genre, meta FROM track_meta WHERE track_page_id = ?")
      .bind("19udfbup")
      .first<{ genre: string; meta: string }>();
    expect(row?.genre).toBe("Tech House");
    expect(JSON.parse(row!.meta).bpm).toBe(128);
    expect(await recordTrackMeta(env, "https://x/no-track", TRACK)).toBeNull();
  });

  it("a page fetched outside the sync stores its metadata beside its facts", async () => {
    const env = makeEnv();
    await seedSet(env, RADIO_URL, "maup");
    await recordPageFacts(env, RADIO_URL, RADIO);
    expect((await loadSetMeta(env, RADIO_URL))!.source).toBe("page");
    const d = await setDiagnostics(env, RADIO_URL);
    expect(d.setMeta!.genres.map((g) => g.name)).toEqual(["House", "Tech House"]);
    expect(d.setMeta!.meta!.rows).toBeUndefined();
  });
});

describe("stored-pages backfill", () => {
  async function gz(text: string): Promise<Uint8Array> {
    const s = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }

  it("reads clean then flagged set pages of known sets with nothing stored, then is done", async () => {
    const env = makeEnv();
    const pages = fakeR2();
    env.PAGES = pages;
    await seedSet(env, FEST_URL);
    await seedSet(env, RADIO_URL, "maup");
    const put = async (key: string, url: string, html: string, at = "2026-10-22T10:00:00.000Z") =>
      pages.put(key, await gz(html), { customMetadata: { url, kind: "set", fetchedAt: at } });
    await put("clean/2026-10-22/set/107cd4y1/1-a.html", RADIO_URL, RADIO);
    await put("clean/2026-10-22/set/117cj421/1-a.html", FEST_URL, FEST);
    // Not a set we track, and not a set page: skipped without a read.
    await put(
      "clean/2026-10-22/set/zzz/1-a.html",
      "https://www.1001tracklists.com/tracklist/zzz/x.html",
      FEST,
    );
    await put(
      "clean/2026-10-22/dj/maup/1-a.html",
      "https://www.1001tracklists.com/dj/maup/index.html",
      "<p/>",
    );
    await put(
      "flagged/2026-10-22/set/117cj421/2-a.html",
      FEST_URL,
      FEST,
      "2026-10-22T12:00:00.000Z",
    );
    let r = await setMetaPagesStep(env, { limit: 1, nowSec: NOW });
    expect(r).toMatchObject({ read: 1, written: 1, done: false });
    r = await setMetaPagesStep(env, { limit: 5, nowSec: NOW });
    expect(r).toMatchObject({ read: 1, written: 1, done: false });
    expect(await env.CACHE.get(META_PAGES_CURSOR_KEY)).toBe("flagged/");
    // The flagged page is newer than what was stored: read again.
    r = await setMetaPagesStep(env, { limit: 5, nowSec: NOW });
    expect(r).toMatchObject({ read: 1, written: 1, done: true });
    expect(await env.CACHE.get(META_PAGES_DONE_KEY)).toBe(String(NOW));
    expect((await loadSetMeta(env, FEST_URL))!.source).toBe("pages");
    expect(await setMetaPagesStep(env, { limit: 5 })).toMatchObject({ read: 0, done: true });
  });

  it("does nothing without a bucket or a limit", async () => {
    expect(await setMetaPagesStep(makeEnv(), { limit: 5 })).toMatchObject({ done: true });
    expect(await setMetaPagesStep(makeEnv({ PAGES: fakeR2() }), { limit: 0 })).toMatchObject({
      done: false,
      read: 0,
    });
  });
});
