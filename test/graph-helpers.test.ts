/**
 * The Graph page's pure helpers (src/ui/pages/graph-helpers.ts), run the way the
 * page runs them: the script string evaluated in a context, then GRK called.
 */
import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { GRAPH_HELPERS_JS } from "../src/ui/pages/graph-helpers";

const GRK: any = vm.runInNewContext(GRAPH_HELPERS_JS + "\nGRK;", {});
// A monospace stand-in for canvas measureText: every letter is 0.6em wide.
const mono = (text: string, px: number) => text.length * px * 0.6;

describe("labelLines", () => {
  it("tracks and remixes: the title, then the artist on its own line", () => {
    expect(GRK.labelLines("track", "Sippin' Yak", "Cloonee")).toEqual(["Sippin' Yak", "Cloonee"]);
    expect(GRK.labelLines("remix", "Sippin' Yak (JSTJR Remix)", "Cloonee")).toEqual([
      "Sippin' Yak (JSTJR Remix)",
      "Cloonee",
    ]);
    expect(GRK.labelLines("track", "Untitled", undefined)).toEqual(["Untitled"]);
  });
  it("never joins title and artist with a dash", () => {
    const lines: string[] = GRK.labelLines("track", "Title", "Artist");
    expect(lines.some((l) => l.includes(" - "))).toBe(false);
  });
  it("a set 'DJ @ Event' shows the event, then the DJ; other names stay whole", () => {
    expect(GRK.labelLines("set", "Matroda @ Tomorrowland 2026-07-19", undefined)).toEqual([
      "Tomorrowland 2026-07-19",
      "Matroda",
    ]);
    expect(GRK.labelLines("set", "Essential Mix", undefined)).toEqual(["Essential Mix"]);
    expect(GRK.labelLines("dj", "Max Styler", undefined)).toEqual(["Max Styler"]);
    expect(GRK.labelLines("source", "BBC Radio 1", "x")).toEqual(["BBC Radio 1"]);
  });
});

describe("truncate", () => {
  it("keeps text that fits and cuts the rest with an ellipsis", () => {
    expect(GRK.truncate(mono, "Gold", 10, 100)).toBe("Gold");
    const cut: string = GRK.truncate(mono, "Midnight Pressure", 10, 50);
    expect(cut.endsWith("…")).toBe(true);
    expect(mono(cut, 10)).toBeLessThanOrEqual(50);
    expect(cut).toBe("Midnigh…");
  });
  it("trims a space before the ellipsis, and gives up when no letter fits", () => {
    expect(GRK.truncate(mono, "Fire Groove", 10, 36)).toBe("Fire…");
    expect(GRK.truncate(mono, "Fire", 10, 5)).toBe("");
  });
});

describe("fitLabel", () => {
  it("draws nothing in a node too small on screen", () => {
    expect(GRK.fitLabel(mono, ["Gold", "Dom"], 6)).toBeNull();
    expect(GRK.fitLabel(mono, [""], 40)).toBeNull();
  });
  it("two lines inside a big node: the title above, the artist below in smaller text", () => {
    const fit = GRK.fitLabel(mono, ["Gold", "Dom Dolla"], 40);
    expect(fit).toHaveLength(2);
    expect(fit[0]).toMatchObject({ text: "Gold", main: true });
    expect(fit[1]).toMatchObject({ text: "Dom Dolla", main: false });
    expect(fit[1].px).toBeLessThan(fit[0].px);
    expect(fit[0].y).toBeLessThan(0);
    expect(fit[1].y).toBeGreaterThan(0);
  });
  it("every line stays inside the circle: shrunk a little, then cut", () => {
    for (const r of [12, 18, 25, 40, 80]) {
      const fit = GRK.fitLabel(
        mono,
        ["A very long track title (Extended Mix)", "Some Artist Name"],
        r,
      );
      if (!fit) continue;
      for (const l of fit) {
        const far = Math.abs(l.y) + l.px / 2;
        expect(far).toBeLessThan(r);
        expect(mono(l.text, l.px)).toBeLessThanOrEqual(2 * Math.sqrt(r * r - far * far));
      }
    }
    const fit = GRK.fitLabel(mono, ["A very long track title (Extended Mix)"], 30);
    expect(fit[0].text.endsWith("…")).toBe(true);
  });
  it("a small node keeps only the title", () => {
    const fit = GRK.fitLabel(mono, ["Gold", "Dom"], 12);
    expect(fit).toHaveLength(1);
    expect(fit[0].text).toBe("Gold");
  });
  it("no label when the title would be cut to two letters", () => {
    expect(GRK.fitLabel(mono, ["Wwwwwwwwwwwwwwwwww"], 10)).toBeNull();
  });
});

describe("textOn", () => {
  it("dark text on light fills, white on dark ones", () => {
    expect(GRK.textOn("#ffffff")).toBe("#111111");
    expect(GRK.textOn("#c9cbd9")).toBe("#111111");
    expect(GRK.textOn("#1f2330")).toBe("#ffffff");
    expect(GRK.textOn("#2a78d6")).toBe("#ffffff");
    expect(GRK.textOn("not a color")).toBe("#ffffff");
  });
});

describe("display settings", () => {
  it("size steps map to 0.25x .. 4x on a log scale, 1x in the middle", () => {
    expect(GRK.sizeMult(0)).toBe(1);
    expect(GRK.sizeMult(-8)).toBe(0.25);
    expect(GRK.sizeMult(8)).toBe(4);
    expect(GRK.sizeMult(4)).toBe(2);
    expect(GRK.sizeMult(-4)).toBe(0.5);
    expect(GRK.sizeMult(99)).toBe(4);
    expect(GRK.sizeMult("x")).toBe(1);
    expect(GRK.multLabel(0)).toBe("1x");
    expect(GRK.multLabel(4)).toBe("2x");
    expect(GRK.multLabel(-8)).toBe("0.25x");
    expect(GRK.multLabel(-4)).toBe("0.5x");
    expect(GRK.multLabel(1)).toBe("1.19x");
  });
  it("defaults: every category shown and labelled at 1x in the theme color", () => {
    const d = GRK.readDisplay(null, null);
    expect(Object.keys(d)).toEqual(["dj", "artist", "source", "set", "track", "remix"]);
    expect(d.track).toEqual({ show: true, label: true, size: 0, color: "" });
  });
  it("reads what was stored, clamps it and drops what is not valid", () => {
    const d = GRK.readDisplay(
      JSON.stringify({
        track: { show: false, label: false, size: 40, color: "#ABCDEF" },
        dj: { size: -3.4, color: "red", show: "no" },
        bogus: { show: false },
      }),
      "",
    );
    expect(d.track).toEqual({ show: false, label: false, size: 8, color: "#abcdef" });
    expect(d.dj).toEqual({ show: true, label: true, size: -3, color: "" });
    expect(d.bogus).toBeUndefined();
  });
  it("the older hidden list seeds 'show' only while nothing is stored", () => {
    expect(GRK.readDisplay(null, "track,remix,nope").track.show).toBe(false);
    expect(GRK.readDisplay(null, "track,remix").remix.show).toBe(false);
    expect(GRK.readDisplay(JSON.stringify({}), "track").track.show).toBe(true);
    expect(GRK.readDisplay("{not json", "set").set.show).toBe(false);
  });
});

describe("layout settings", () => {
  it("defaults: the tuned ForceAtlas2 values", () => {
    expect(GRK.layoutDefault()).toEqual({
      gravity: 1,
      strongGravityMode: false,
      scalingRatio: 10,
      slowDown: 2,
      linLogMode: false,
      outboundAttractionDistribution: false,
      adjustSizes: true,
      barnesHut: "auto",
      barnesHutTheta: 0.6,
      edgeWeightInfluence: 1,
      pinPull: 1,
    });
  });
  it("reads stored values within each knob's range and ignores the rest", () => {
    const l = GRK.readLayout(
      JSON.stringify({
        gravity: 99,
        slowDown: 0,
        linLogMode: true,
        barnesHut: "maybe",
        scalingRatio: "x",
      }),
    );
    expect(l.gravity).toBe(5);
    expect(l.slowDown).toBe(1);
    expect(l.linLogMode).toBe(true);
    expect(l.barnesHut).toBe("auto");
    expect(l.scalingRatio).toBe(10);
    expect(GRK.readLayout("nope")).toEqual(GRK.layoutDefault());
  });
  it("FA2 settings: Barnes-Hut by graph size on auto, no-overlap only in the finishing phase", () => {
    const d = GRK.layoutDefault();
    expect(GRK.fa2Settings(d, 499, "main").barnesHutOptimize).toBe(false);
    expect(GRK.fa2Settings(d, 500, "main").barnesHutOptimize).toBe(true);
    expect(GRK.fa2Settings({ ...d, barnesHut: "off" }, 5000, "main").barnesHutOptimize).toBe(false);
    expect(GRK.fa2Settings({ ...d, barnesHut: "on" }, 10, "main").barnesHutOptimize).toBe(true);
    expect(GRK.fa2Settings(d, 10, "main").adjustSizes).toBe(false);
    expect(GRK.fa2Settings(d, 10, "overlap").adjustSizes).toBe(true);
    expect(GRK.fa2Settings({ ...d, adjustSizes: false }, 10, "overlap").adjustSizes).toBe(false);
    const s = GRK.fa2Settings(d, 10, "main");
    expect(Object.keys(s).sort()).toEqual(
      [
        "adjustSizes",
        "barnesHutOptimize",
        "barnesHutTheta",
        "edgeWeightInfluence",
        "gravity",
        "linLogMode",
        "outboundAttractionDistribution",
        "scalingRatio",
        "slowDown",
        "strongGravityMode",
      ].sort(),
    );
  });
});

describe("pins", () => {
  const pinned = new Set(["a:dj"]);
  const deg: Record<string, number> = { "a:dj": 8, "s:set": 25, "t:x": 3, "t:y": 1 };
  const w = (s: string, t: string, pull = 1) =>
    GRK.edgeWeight(
      (n: string) => pinned.has(n),
      (n: string) => deg[n],
      pull,
      s,
      t,
    );
  it("a link to a pinned node weighs as much as the other node's other links together", () => {
    expect(w("a:dj", "s:set")).toBe(25);
    expect(w("s:set", "a:dj")).toBe(25);
    expect(w("a:dj", "s:set", 2)).toBe(49);
    expect(w("a:dj", "s:set", 0)).toBe(1);
  });
  it("other links weigh 1, and a lone neighbour of a pin gets no extra weight", () => {
    expect(w("s:set", "t:x")).toBe(1);
    expect(GRK.pinWeight(1, 1)).toBe(1);
    pinned.add("s:set");
    expect(w("a:dj", "s:set")).toBe(1);
  });
});

describe("makeSettle", () => {
  it("settles after enough calm ticks, never before the minimum", () => {
    const s = GRK.makeSettle({ ticks: 3, minTicks: 5, share: 0.01 });
    const results = [0, 0, 0, 0, 0].map(() => s.step(0, 1000));
    expect(results).toEqual([false, false, false, false, true]);
  });
  it("a few jittering nodes do not keep it running; a gathering cluster does", () => {
    const s = GRK.makeSettle({ ticks: 2, minTicks: 1, share: 0.01 });
    expect(s.step(5, 1000)).toBe(false);
    expect(s.step(5, 1000)).toBe(true);
    s.reset();
    expect(s.step(200, 1000)).toBe(false);
    expect(s.step(0, 1000)).toBe(false);
    expect(s.step(200, 1000)).toBe(false);
    expect(s.step(0, 1000)).toBe(false);
    expect(s.step(0, 1000)).toBe(true);
  });
});
