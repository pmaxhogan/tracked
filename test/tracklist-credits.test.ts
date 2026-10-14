/**
 * Set-page graph data (src/lib/tracklist-credits.ts): sources and heading
 * artists from `#pageTitle`, credits and base tracks from the row links.
 * The decoy fixture's names are randomized by design, so it is only used for
 * page structure (the `h1#pageTitle` layout, artist link forms), never names.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  artistSlugOf,
  nameSlug,
  parseIsoDuration,
  parseSetGraph,
  trackIdOf,
} from "../src/lib/tracklist-credits";

const fixture = (name: string) =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", name), "utf8");

describe("helpers", () => {
  it("reads artist slugs from every link form", () => {
    expect(artistSlugOf("/artist/joris-voorn/tracks.html")).toBe("joris-voorn");
    expect(artistSlugOf("/artist/6lwh0mw/cloonee/index.html")).toBe("cloonee");
    expect(artistSlugOf("/artist/adam-beyer/tracklists.html")).toBe("adam-beyer");
    expect(artistSlugOf("/track/x/y/index.html")).toBeNull();
  });
  it("reads track page ids, ISO durations and name slugs", () => {
    expect(trackIdOf("/track/kt2xfq25/cloonee-sippin-yak-jstjr-remix/index.html")).toBe("kt2xfq25");
    expect(trackIdOf("/artist/x/")).toBeNull();
    expect(parseIsoDuration("PT7M51S")).toBe(471);
    expect(parseIsoDuration("PT1H2M3S")).toBe(3723);
    expect(parseIsoDuration("PT")).toBeNull();
    expect(parseIsoDuration(null)).toBeNull();
    expect(nameSlug("Clüb De Combat")).toBe("club-de-combat");
    expect(nameSlug("Beroshima & Frank Muller")).toBe("beroshima-frank-muller");
  });
});

describe("parseSetGraph: the synthetic page (the row structure 1001tracklists serves)", () => {
  const g = parseSetGraph(fixture("tracklist-credits-synthetic.html"));

  it("takes sources and artists from the heading only, not the Hot Events modal", () => {
    expect(g.sources).toEqual([
      { id: "48jnw3", slug: "lollapalooza-united-states", name: "Lollapalooza United States" },
    ]);
    expect(g.artists).toEqual([
      { key: "synthetic-dj", name: "Synthetic DJ", path: null, djSlug: "syntheticdj" },
      {
        key: "other-act",
        name: "Other Act",
        path: "/artist/other-act/tracklists.html",
        djSlug: null,
      },
    ]);
  });

  it("reads a remix row: main, featured and remixer credits, the base track, label, genre, duration", () => {
    const r = g.rows.find((x) => x.pageId === "r3m1x00")!;
    expect(r).toMatchObject({
      artist: "Metro Boomin & Travis Scott",
      title: "Superhero (Joris Voorn Remix)",
      path: "/track/r3m1x00/metro-boomin-superhero-joris-voorn-remix/index.html",
      label: "SPINNIN",
      labelPath: "/label/abc12/spinnin-records/index.html",
      genre: "Techno",
      durationSeconds: 471,
      version: "Remix",
    });
    expect(r.credits).toEqual([
      {
        key: "metro-boomin",
        name: "Metro Boomin",
        path: "/artist/metro-boomin/tracks.html",
        role: "main",
      },
      {
        key: "travis-scott",
        name: "Travis Scott",
        path: "/artist/2x9k1/travis-scott/tracks.html",
        role: "main",
      },
      { key: "future", name: "Future", path: null, role: "featured" },
      {
        key: "joris-voorn",
        name: "Joris Voorn",
        path: "/artist/joris-voorn/tracks.html",
        role: "remixer",
      },
    ]);
    expect(r.base).toEqual({
      pageId: "b4s3000",
      kind: "remix",
      path: "/track/b4s3000/metro-boomin-superhero/index.html",
      artist: "Metro Boomin & Travis Scott",
      title: "Superhero",
    });
  });

  it("a plain row has one track link and no base; an anonymous row is left out", () => {
    const r = g.rows.find((x) => x.pageId === "r1ng000")!;
    expect(r.base).toBeNull();
    expect(r.version).toBeNull();
    expect(r.credits.map((c) => [c.role, c.key])).toEqual([["main", "joris-voorn"]]);
    expect(g.rows).toHaveLength(2);
  });
});

describe("parseSetGraph: captured pages", () => {
  it("habstrakt: two sources, two DJs, a remix with its remixer and base, a rework", () => {
    const g = parseSetGraph(fixture("tracklist-habstrakt.html"));
    expect(g.sources.map((s) => s.id)).toEqual(["5f5dpnv", "f4lzj3"]);
    expect(g.sources[1]!.name).toBe("Amsterdam Dance Event");
    expect(g.artists.map((a) => [a.key, a.djSlug])).toEqual([
      ["habstrakt", "habstrakt"],
      ["jstjr", "jstjr"],
    ]);
    const remix = g.rows.find((r) => r.pageId === "kt2xfq25")!;
    expect(remix.title).toBe("Sippin' Yak (JSTJR Remix)");
    expect(remix.credits.map((c) => [c.role, c.key, c.path])).toEqual([
      ["main", "cloonee", "/artist/6lwh0mw/cloonee/index.html"],
      ["remixer", "jstjr", "/artist/92g899d/jstjr/index.html"],
    ]);
    expect(remix.base).toMatchObject({ pageId: "1dpy4tqp", kind: "remix", title: "Sippin' Yak" });
    expect(remix.label).toBe("HELLBENT");
    const rework = g.rows.find((r) => r.pageId === "8h1rbhyp")!;
    expect(rework.base).toEqual({
      pageId: "n3wydx",
      kind: "rework",
      path: "/track/n3wydx/black-eyed-peas-pump-it/index.html",
      artist: "Black Eyed Peas",
      title: "Pump It",
    });
    // A featured artist is plain text on the row.
    const ft = g.rows.find((r) => r.pageId === "28knskyf")!;
    expect(ft.credits.map((c) => [c.role, c.key])).toEqual([
      ["main", "odd-mob"],
      ["featured", "basura-boyz"],
    ]);
  });

  it("matroda and maxstyler: one source each; the DJ page slug can differ from the name slug", () => {
    const m = parseSetGraph(fixture("tracklist-matroda.html"));
    expect(m.sources).toEqual([
      { id: "hk9t6v", slug: "club-space-miami", name: "Club Space Miami" },
    ]);
    const metro = m.rows.find((r) => r.pageId === "wtg4fpf")!;
    expect(metro.credits.map((c) => `${c.role}:${c.key}`)).toEqual([
      "main:metro-boomin",
      "featured:future",
      "featured:chris-brown",
      "remixer:matroda",
    ]);
    const x = parseSetGraph(fixture("tracklist-maxstyler.html"));
    expect(x.artists).toEqual([
      { key: "max-styler", name: "Max Styler", path: null, djSlug: "maxstyler" },
    ]);
    expect(x.sources.map((s) => s.slug)).toEqual(["edc-las-vegas"]);
    // "ID ID" is no credit.
    expect(x.rows.find((r) => r.pageId === "9xpdym9x")!.credits).toEqual([]);
  });

  it("decoy page structure: the h1#pageTitle layout, artist-page heading links, nested remixer links", () => {
    const g = parseSetGraph(fixture("tracklist-decoy-dcr839.html"));
    expect(g.sources.map((s) => s.id)).toEqual(["3xlhtm", "v088zc", "6wcblm"]);
    expect(g.artists.map((a) => a.path)).toEqual([
      "/artist/adam-beyer/tracklists.html",
      "/artist/ilario-alicante/tracklists.html",
    ]);
    const r = g.rows.find((x) => x.pageId === "w8hh3zxf")!;
    expect(r.credits.map((c) => c.role)).toEqual(["main", "featured", "remixer", "remixer"]);
    expect(r.base?.pageId).toBe("19htcmfp");
  });

  it("a page without a heading or rows gives nothing", () => {
    expect(parseSetGraph(fixture("tracklist-neptune.html"))).toEqual({
      sources: [],
      artists: [],
      rows: [],
    });
  });
});
