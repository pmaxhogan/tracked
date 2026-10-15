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
  it("a set 'DJ @ Event date' shows the event, then the date (else the DJ); other names stay whole", () => {
    expect(GRK.labelLines("set", "Matroda @ Tomorrowland 2026-07-19", undefined)).toEqual([
      "Tomorrowland",
      "2026-07-19",
    ]);
    expect(GRK.labelLines("set", "Matroda @ Tomorrowland, Boom", undefined)).toEqual([
      "Tomorrowland, Boom",
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
      gravity: 0.05,
      strongGravityMode: true,
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
    expect(l.gravity).toBe(2);
    expect(l.slowDown).toBe(1);
    expect(l.linLogMode).toBe(true);
    expect(l.barnesHut).toBe("auto");
    expect(l.scalingRatio).toBe(10);
    expect(GRK.readLayout("nope")).toEqual(GRK.layoutDefault());
  });
  it("FA2 settings: Barnes-Hut by graph size on auto, FA2's own anti-collision off, spread grown with size", () => {
    const d = GRK.layoutDefault();
    expect(GRK.fa2Settings(d, 499).barnesHutOptimize).toBe(false);
    expect(GRK.fa2Settings(d, 500).barnesHutOptimize).toBe(true);
    expect(GRK.fa2Settings({ ...d, barnesHut: "off" }, 5000).barnesHutOptimize).toBe(false);
    expect(GRK.fa2Settings({ ...d, barnesHut: "on" }, 10).barnesHutOptimize).toBe(true);
    expect(GRK.fa2Settings(d, 10).adjustSizes).toBe(false);
    expect(GRK.fa2Settings(d, 10).scalingRatio).toBe(10);
    expect(GRK.fa2Settings(d, 1500).scalingRatio).toBe(50);
    expect(GRK.fa2Settings(d, 100000).scalingRatio).toBe(80);
    expect(GRK.spreadScale(300)).toBe(1);
    expect(GRK.spreadScale(600)).toBe(2);
    const s = GRK.fa2Settings(d, 10);
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

describe("making room", () => {
  it("spacing: the nearest-neighbour distance over the room two nodes need, as a quantile", () => {
    // Three nodes of radius 10 in a row, 30 apart (room needed: 10 + 10 + margin 10 = 30).
    const row = [0, 30, 60].map((x) => ({ x, y: 0, r: 10 }));
    expect(GRK.spacing(row, 10, 0.5)).toBeCloseTo(1);
    const tight = [0, 15, 30].map((x) => ({ x, y: 0, r: 10 }));
    expect(GRK.spacing(tight, 10, 0.25)).toBeCloseTo(0.5);
    expect(GRK.spacing([{ x: 0, y: 0, r: 1 }], 0, 0.5)).toBe(Infinity);
  });
  it("fitShrink only ever shrinks, down to 0.3", () => {
    expect(GRK.fitShrink(1.4)).toBe(1);
    expect(GRK.fitShrink(0.5)).toBe(0.5);
    expect(GRK.fitShrink(0.1)).toBe(0.3);
    expect(GRK.fitShrink(0)).toBe(0.3);
    expect(GRK.fitShrink(Infinity)).toBe(1);
    expect(GRK.fitShrink(NaN)).toBe(1);
  });
  it("maxMove: the largest move between two position maps", () => {
    expect(
      GRK.maxMove(
        { a: { x: 0, y: 0 }, b: { x: 5, y: 5 } },
        { a: { x: 3, y: 4 }, b: { x: 5, y: 5 } },
      ),
    ).toBe(7);
    expect(GRK.maxMove({}, { a: { x: 1, y: 1 } })).toBe(0);
  });
  it("childOffset: children spiral out around their parent, never on top of it or of each other", () => {
    const pts = Array.from({ length: 400 }, (_, c) => GRK.childOffset(36, 27, c, 0));
    for (const p of pts) expect(Math.hypot(p.x, p.y)).toBeGreaterThan(36 + 27);
    let closest = Infinity;
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++)
        closest = Math.min(closest, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
    // Not a clump: neighbours on the spiral keep most of a node's width apart.
    expect(closest).toBeGreaterThan(27);
  });
});

describe("placeLabels", () => {
  const box = (x: number, y: number, w = 20, h = 10) => ({
    x0: x - w / 2,
    x1: x + w / 2,
    y0: y - h / 2,
    y1: y + h / 2,
  });
  const item = (
    key: string,
    x: number,
    y: number,
    r: number,
    extra: Record<string, unknown> = {},
  ) => ({
    key,
    x,
    y,
    r,
    box: box(x, y),
    cat: "track",
    deg: 1,
    ...extra,
  });
  it("labels every node that has room", () => {
    expect(
      GRK.placeLabels([item("a", 0, 0, 20), item("b", 100, 0, 20), item("c", 0, 100, 20)]),
    ).toEqual(["a", "b", "c"]);
  });
  it("no label where another node's disc covers it, in either direction", () => {
    expect(GRK.placeLabels([item("a", 0, 0, 20), item("b", 12, 0, 20)])).toEqual([]);
    // A small node sitting on a big one's label blocks it; the small one keeps its own when clear.
    const big = item("big", 0, 0, 40, { box: box(0, 0, 50, 12) });
    const small = item("small", 20, 0, 4, { box: null });
    expect(GRK.placeLabels([big, small])).toEqual([]);
  });
  it("label boxes never overlap: the more important one wins", () => {
    // Two nodes too small for their label boxes (r 2), boxes overlapping.
    const set = item("set", 0, 0, 2, { cat: "set", box: box(0, 0, 40, 10) });
    const track = item("track", 30, 0, 2, { cat: "track", deg: 50, box: box(30, 0, 40, 10) });
    expect(GRK.placeLabels([track, set])).toEqual(["set"]);
    const dimSet = { ...set, dim: true };
    expect(GRK.placeLabels([track, dimSet])).toEqual(["track"]);
  });
  it("nodes without a label are still obstacles, and a node never blocks its own label", () => {
    expect(GRK.placeLabels([item("a", 0, 0, 30)])).toEqual(["a"]);
    expect(GRK.placeLabels([item("a", 0, 0, 30), item("dot", 3, 0, 2, { box: null })])).toEqual([]);
  });
});
