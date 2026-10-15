/**
 * The Graph page script (src/ui/pages/graph.ts) against fakes of graphology,
 * Sigma and the ForceAtlas2 worker supervisor: labels drawn inside the nodes,
 * two-line track labels, drag while the layout runs (pinned and held through
 * the supervisor's outputReducer), heavier links to pinned nodes, Release pins,
 * live layout knobs and the per-category Display settings, persisted per viewer.
 */
import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { app } from "../src/index";
import { fakeKV } from "./helpers/fake-kv";
import { fakeD1 } from "./helpers/fake-d1";
import type { Env } from "../src/types";

const env = () =>
  ({
    CACHE: fakeKV(),
    SUBS: fakeKV(),
    DB: fakeD1(),
    API_TOKEN: "t",
    YOUTUBE_API_KEY: "k",
    DEV_BYPASS_CF_ACCESS: "1",
  }) as unknown as Env;
const scriptsOf = (html: string) =>
  [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);

/** A small graphology stand-in: the calls the page makes. */
class FakeGraph {
  nodes = new Map<string, any>();
  edges = new Map<string, { s: string; t: string; a: any }>();
  handlers: Record<string, Array<() => void>> = {};
  get order() {
    return this.nodes.size;
  }
  get size() {
    return this.edges.size;
  }
  on(ev: string, fn: () => void) {
    (this.handlers[ev] ||= []).push(fn);
  }
  emit(ev: string) {
    for (const fn of this.handlers[ev] || []) fn();
  }
  hasNode(n: string) {
    return this.nodes.has(n);
  }
  addNode(n: string, a: any) {
    this.nodes.set(n, { ...a });
  }
  dropNode(n: string) {
    this.nodes.delete(n);
    for (const [k, e] of this.edges) if (e.s === n || e.t === n) this.edges.delete(k);
  }
  clear() {
    this.nodes.clear();
    this.edges.clear();
  }
  mergeNodeAttributes(n: string, a: any) {
    Object.assign(this.nodes.get(n), a);
  }
  setNodeAttribute(n: string, k: string, v: any) {
    this.nodes.get(n)[k] = v;
  }
  getNodeAttributes(n: string) {
    return this.nodes.get(n);
  }
  getNodeAttribute(n: string, k: string) {
    return this.nodes.get(n)?.[k];
  }
  forEachNode(fn: (n: string, a: any) => void) {
    for (const [n, a] of this.nodes) fn(n, a);
  }
  findNode(fn: (n: string, a: any) => boolean) {
    for (const [n, a] of this.nodes) if (fn(n, a)) return n;
    return undefined;
  }
  updateEachNodeAttributes(fn: (n: string, a: any) => any) {
    for (const [n, a] of this.nodes) this.nodes.set(n, fn(n, a));
    this.emit("eachNodeAttributesUpdated");
  }
  hasEdge(k: string) {
    return this.edges.has(k);
  }
  addDirectedEdgeWithKey(k: string, s: string, t: string, a: any) {
    this.edges.set(k, { s, t, a: { ...a } });
  }
  source(k: string) {
    return this.edges.get(k)!.s;
  }
  target(k: string) {
    return this.edges.get(k)!.t;
  }
  getEdgeAttributes(k: string) {
    return this.edges.get(k)!.a;
  }
  degree(n: string) {
    let d = 0;
    for (const e of this.edges.values()) if (e.s === n || e.t === n) d++;
    return d;
  }
  areNeighbors(a: string, b: string) {
    for (const e of this.edges.values())
      if ((e.s === a && e.t === b) || (e.s === b && e.t === a)) return true;
    return false;
  }
}

function emitter() {
  const h: Record<string, Array<(e: any) => void>> = {};
  return {
    on(ev: string, fn: (e: any) => void) {
      (h[ev] ||= []).push(fn);
    },
    fire(ev: string, e: any = {}) {
      for (const fn of h[ev] || []) fn(e);
    },
  };
}

/** Elements with listeners, attributes and the few query calls the page makes. */
function stubDom() {
  const mk = (id = ""): any => {
    const listeners: Record<string, Array<(e: any) => void>> = {};
    const attrs: Record<string, string> = {};
    const e: any = {
      id,
      innerHTML: "",
      textContent: "",
      value: "",
      hidden: id === "gr-display" || id === "gr-forces" || id === "gr-panel",
      checked: false,
      style: { setProperty() {}, removeProperty() {} },
      addEventListener(t: string, fn: (e: any) => void) {
        (listeners[t] ||= []).push(fn);
      },
      fire(t: string, ev: any = {}) {
        for (const fn of listeners[t] || []) fn({ target: e, preventDefault() {}, ...ev });
      },
      setAttribute(k: string, v: string) {
        attrs[k] = String(v);
      },
      getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
      removeAttribute(k: string) {
        delete attrs[k];
      },
      querySelector: () => mk(),
      querySelectorAll: () => [],
      closest: () => null,
    };
    return e;
  };
  const els = new Map<string, any>();
  const document = {
    hidden: false,
    getElementById: (id: string) =>
      els.has(id) ? els.get(id) : (els.set(id, mk(id)), els.get(id)),
    querySelector: () => null,
    addEventListener() {},
    createElement: () => mk(),
    documentElement: mk("html"),
  };
  return { document, els, mk };
}

function canvasCtx() {
  const calls: Array<[string, ...any[]]> = [];
  const ctx: any = {
    calls,
    font: "",
    save() {},
    restore() {},
    beginPath() {},
    arc() {},
    stroke() {},
    fill() {},
    rect() {},
    setLineDash() {},
    measureText: (t: string) => ({
      width: t.length * (parseFloat(String(ctx.font).split(" ")[1]!) || 10) * 0.6,
    }),
    fillText: (t: string, x: number, y: number) => calls.push(["fillText", t, x, y, ctx.font]),
  };
  return ctx;
}

async function boot(
  opts: { search?: string; storage?: Record<string, string>; noverlap?: any } = {},
) {
  const graph = new FakeGraph();
  // Timers run only when a test flushes them (flush(): the zero-delay ones, repeatedly).
  let timerId = 0;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const flush = (all = false) => {
    for (let guard = 0; guard < 500; guard++) {
      const due = [...timers].find(([, t]) => all || !t.ms);
      if (!due) return;
      timers.delete(due[0]);
      due[1].fn();
    }
  };
  const storage = new Map(Object.entries(opts.storage || {}));
  const fa2s: any[] = [];
  const sigmas: any[] = [];
  const mouse = emitter();
  const touch = emitter();
  class Sigma {
    settings: any;
    handlers = emitter();
    refreshes = 0;
    camera = { ratio: 1, animatedReset() {}, animate() {} };
    constructor(_g: unknown, _c: unknown, s: any) {
      this.settings = s;
      sigmas.push(this);
    }
    on(ev: string, fn: (e: any) => void) {
      this.handlers.on(ev, fn);
    }
    getMouseCaptor() {
      return mouse;
    }
    getTouchCaptor() {
      return touch;
    }
    getCanvases() {
      return {};
    }
    getCamera() {
      return this.camera;
    }
    refresh() {
      this.refreshes++;
    }
    setSetting(k: string, v: any) {
      this.settings[k] = v;
    }
    getCustomBBox() {
      return null;
    }
    setCustomBBox() {}
    getBBox() {
      return { x: [0, 1], y: [0, 1] };
    }
    getDimensions() {
      return { width: 800, height: 600 };
    }
    viewportToGraph(e: any) {
      return { x: e.x * 10, y: e.y * 10 };
    }
    getNodeDisplayData() {
      return { x: 0, y: 0 };
    }
  }
  // Like graphology's FA2LayoutSupervisor: a tick writes positions through the
  // outputReducer (updateEachNodeAttributes), then stores the matrix; kill() nulls it.
  class FA2Layout {
    params: any;
    settings: any;
    killed = false;
    started = false;
    running = false;
    matrices: any = null;
    constructor(_g: unknown, params: any) {
      this.params = params;
      this.settings = { ...params.settings };
      fa2s.push(this);
    }
    start() {
      this.started = true;
      this.running = true;
      this.matrices = { nodes: null };
    }
    kill() {
      this.killed = true;
      this.running = false;
      this.matrices = null;
    }
    tick() {
      if (!this.running) return;
      graph.updateEachNodeAttributes((n: string, a: any) => this.params.outputReducer(n, a));
      this.matrices.nodes = "next";
    }
  }
  const { document, els } = stubDom();
  const fetches: string[] = [];
  const answers: Record<string, unknown> = {
    "/ui/api/graph/status": {
      sets: 2,
      parsed: 2,
      sources: 1,
      artists: 2,
      limits: { nodeCap: 5000, confirmOver: 300 },
    },
    "/ui/api/graph/expand": {
      nodes: [
        ["a:dj", "dj", "Max Styler", 0],
        ["s:1", "set", "Max Styler @ Tomorrowland 2026-07-19", 12],
        ["s:2", "set", "Max Styler @ EDC 2026-05-16", 9],
        ["t:1", "track", "Sippin' Yak", 3, "Cloonee"],
      ],
      edges: [
        ["a:dj", "s:1", "plays"],
        ["a:dj", "s:2", "plays"],
        ["s:1", "t:1", "has"],
        ["s:2", "t:1", "has"],
      ],
      truncated: false,
      limits: { nodeCap: 5000, confirmOver: 300 },
    },
    "/ui/api/graph/info": {
      cat: "track",
      title: "Cloonee - Sippin' Yak",
      facts: [],
      links: [],
      related: [],
    },
  };
  const win: any = {
    graphology: {
      MultiDirectedGraph: function () {
        return graph;
      },
    },
    Sigma: Object.assign(Sigma, { rendering: {} }),
    graphologyLibrary: {
      FA2Layout,
      layoutForceAtlas2: { assign() {} },
      ...(opts.noverlap ? { layoutNoverlap: opts.noverlap } : {}),
    },
  };
  const ctx = vm.createContext({
    window: win,
    document,
    fetch: async (u: string) => {
      fetches.push(u);
      const path = u.split("?")[0]!;
      return path in answers ? Response.json(answers[path]) : new Response("{}", { status: 404 });
    },
    localStorage: {
      getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
      setItem: (k: string, v: string) => void storage.set(k, String(v)),
      removeItem: (k: string) => void storage.delete(k),
    },
    Worker: function () {},
    setTimeout: (fn: () => void, ms?: number) => (
      timers.set(++timerId, { fn, ms: ms || 0 }),
      timerId
    ),
    clearTimeout: (id: number) => void timers.delete(id),
    setInterval: () => 0,
    clearInterval() {},
    console,
    Date,
    Math,
    JSON,
    URLSearchParams,
    location: { search: opts.search ?? "?focus=a%3Adj", pathname: "/ui/graph" },
    history: { replaceState() {} },
  });
  const r = await app.request("https://tracked.example/ui/graph", {}, env());
  for (const s of scriptsOf(await r.text())) vm.runInContext(s, ctx);
  for (let i = 0; i < 20; i++) await new Promise((res) => setTimeout(res, 0));
  return { graph, sigma: sigmas[0], fa2s, mouse, els, storage, fetches, win, flush, timers };
}

/** One sigma frame: drawLabel queues the nodes, afterRender places and paints the labels. */
function frame(sigma: any, ctx: any, nodes: any[]) {
  sigma.handlers.fire("beforeRender");
  for (const d of nodes) sigma.settings.defaultDrawNodeLabel(ctx, d, sigma.settings);
  sigma.handlers.fire("afterRender");
}

describe("Graph page script", () => {
  it("sizes nodes in graph units and draws labels inside them: a track is its title over its artist", async () => {
    const { graph, sigma } = await boot();
    expect(graph.order).toBe(4);
    expect(graph.getNodeAttributes("t:1")).toMatchObject({
      label: "Sippin' Yak",
      sub: "Cloonee",
      cat: "track",
    });
    expect(sigma.settings.itemSizesReference).toBe("positions");
    expect(sigma.settings.zoomToSizeRatioFunction(0.5)).toBe(0.5);
    const node = (id: string, size: number) => ({
      key: id,
      ...sigma.settings.nodeReducer(id, { ...graph.getNodeAttributes(id), size }),
    });
    // Big on screen: two lines, centred on the node, title above the artist, never "Title - Artist".
    const c = canvasCtx();
    frame(sigma, c, [{ ...node("t:1", 60), x: 100, y: 100 }]);
    const texts = c.calls.map((x: any[]) => x[1]);
    expect(texts).toEqual(["Sippin' Yak", "Cloonee"]);
    expect(c.calls[0]![3]).toBeLessThan(100);
    expect(c.calls[1]![3]).toBeGreaterThan(100);
    expect(texts.join(" ")).not.toContain(" - ");
    // A set: the event over its date (the DJ is the neighbour node).
    const s = canvasCtx();
    frame(sigma, s, [{ ...node("s:1", 90), x: 0, y: 0 }]);
    expect(s.calls.map((x: any[]) => x[1])).toEqual(["Tomorrowland", "2026-07-19"]);
    // Zoomed out: the node is too small on screen, nothing is drawn (no text spilling out).
    const tiny = canvasCtx();
    frame(sigma, tiny, [{ ...node("t:1", 6), x: 0, y: 0 }]);
    expect(tiny.calls).toEqual([]);
    // A long title is cut with an ellipsis and stays inside the circle.
    graph.mergeNodeAttributes("t:1", {
      label: "A Very Long Track Title That Will Not Fit (Extended Mix)",
    });
    const cut = canvasCtx();
    frame(sigma, cut, [{ ...node("t:1", 30), x: 0, y: 0 }]);
    expect(String(cut.calls[0]![1]).endsWith("…")).toBe(true);
  });

  it("drag while the layout runs: the node follows the pointer, is pinned and held, and its links weigh more", async () => {
    const { graph, sigma, fa2s, mouse, els } = await boot();
    expect(fa2s.length).toBe(1);
    expect(fa2s[0].started).toBe(true);
    // The supervisor only copies graph positions back into its matrices with an outputReducer.
    expect(typeof fa2s[0].params.outputReducer).toBe("function");
    expect(typeof fa2s[0].params.getEdgeWeight).toBe("function");
    expect(fa2s[0].params.getEdgeWeight("e", {}, "a:dj", "s:1")).toBe(1);
    sigma.handlers.fire("downNode", { node: "a:dj" });
    let prevented = false;
    mouse.fire("mousemovebody", { x: 50, y: 20, preventSigmaDefault: () => (prevented = true) });
    expect(prevented).toBe(true);
    expect(graph.getNodeAttributes("a:dj")).toMatchObject({ x: 500, y: 200 });
    // A new pin restarts the worker (link weights are read at start); the old one is killed.
    expect(fa2s.length).toBe(2);
    expect(fa2s[0].killed).toBe(true);
    const fa2 = fa2s[1];
    // s:1 has 2 links: the pinned link weighs 1 + pinPull * (2 - 1).
    expect(fa2.params.getEdgeWeight("e", {}, "a:dj", "s:1")).toBe(2);
    expect(fa2.params.getEdgeWeight("e", {}, "s:1", "t:1")).toBe(1);
    // A worker tick moves the dragged node: the reducer puts it back under the pointer.
    mouse.fire("mousemovebody", { x: 60, y: 30, preventSigmaDefault() {} });
    expect(fa2.params.outputReducer("a:dj", { x: 1, y: 1 })).toMatchObject({ x: 600, y: 300 });
    expect(fa2.params.outputReducer("s:1", { x: 7, y: 8 })).toMatchObject({ x: 7, y: 8 });
    // Released: still pinned there, shown with a ring, and Release pins lets it go.
    mouse.fire("mouseup");
    expect(fa2.params.outputReducer("a:dj", { x: 1, y: 1 })).toMatchObject({ x: 600, y: 300 });
    expect(sigma.settings.nodeReducer("a:dj", graph.getNodeAttributes("a:dj")).pinned).toBe(true);
    expect(els.get("gr-unpin").hidden).toBe(false);
    expect(els.get("gr-unpin").textContent).toBe("Release pins (1)");
    // A click right after the drag does not select or expand.
    sigma.handlers.fire("clickNode", { node: "a:dj" });
    els.get("gr-unpin").fire("click");
    expect(els.get("gr-unpin").hidden).toBe(true);
    const last = fa2s[fa2s.length - 1];
    expect(last.params.outputReducer("a:dj", { x: 1, y: 1 })).toMatchObject({ x: 1, y: 1 });
  });

  it("pause, drag, resume: the paused layout stays paused, and resuming starts from the pinned position", async () => {
    const { sigma, fa2s, mouse, els } = await boot();
    els.get("gr-layout").fire("click");
    expect(fa2s[0].killed).toBe(true);
    expect(els.get("gr-layout").textContent).toBe("Run layout");
    sigma.handlers.fire("downNode", { node: "s:2" });
    mouse.fire("mousemovebody", { x: 3, y: 4, preventSigmaDefault() {} });
    mouse.fire("mouseup");
    expect(fa2s.length).toBe(1);
    els.get("gr-layout").fire("click");
    expect(fa2s.length).toBe(2);
    expect(els.get("gr-layout").textContent).toBe("Stop layout");
    expect(fa2s[1].params.outputReducer("s:2", { x: 0, y: 0 })).toMatchObject({ x: 30, y: 40 });
    expect(fa2s[1].params.getEdgeWeight("e", {}, "a:dj", "s:2")).toBe(2);
  });

  it("layout knobs apply live to the running worker and persist; Reset to defaults restores them", async () => {
    const { fa2s, els, storage } = await boot({
      storage: { "tk-graph:layout": JSON.stringify({ gravity: 0.5, slowDown: 6 }) },
    });
    const fa2 = fa2s[0];
    expect(fa2.params.settings).toMatchObject({
      gravity: 0.5,
      slowDown: 6,
      adjustSizes: false,
      outboundAttractionDistribution: false,
    });
    const rows = els.get("gr-forces-rows");
    expect(rows.innerHTML).toContain('data-f="gravity"');
    expect(rows.innerHTML).toContain('data-f="barnesHutTheta"');
    expect(rows.innerHTML).toContain('data-f="strongGravityMode"');
    const knob = (key: string, value: string, type = "range") => ({
      getAttribute: (k: string) => (k === "data-f" ? key : null),
      value,
      type,
      checked: value === "true",
    });
    rows.fire("input", { target: knob("gravity", "1.5") });
    expect(fa2s.length).toBe(1);
    expect(fa2.settings.gravity).toBe(1.5);
    rows.fire("input", { target: knob("linLogMode", "true", "checkbox") });
    expect(fa2.settings.linLogMode).toBe(true);
    expect(JSON.parse(storage.get("tk-graph:layout")!)).toMatchObject({
      gravity: 1.5,
      linLogMode: true,
      slowDown: 6,
    });
    // Pin pull changes link weights: read at start, so the worker restarts.
    rows.fire("input", { target: knob("pinPull", "2") });
    expect(fa2s.length).toBe(2);
    els.get("gr-forces-reset").fire("click");
    expect(JSON.parse(storage.get("tk-graph:layout")!)).toMatchObject({
      gravity: 0.05,
      slowDown: 2,
      pinPull: 1,
      linLogMode: false,
    });
    expect(fa2s[fa2s.length - 1].params.settings.gravity).toBe(0.05);
  });

  it("Display: per category show, label, size and color, kept per viewer", async () => {
    const { graph, sigma, els, storage, fa2s } = await boot({
      storage: { "tk-graph:hidden": "remix" },
    });
    const rows = els.get("gr-display-rows");
    for (const k of ["dj", "artist", "source", "set", "track", "remix"])
      expect(rows.innerHTML).toContain('data-cat="' + k + '"');
    const field = (cat: string, k: string, value: string, checked = false) => ({
      getAttribute: (a: string) => (a === "data-cat" ? cat : a === "data-k" ? k : null),
      value,
      checked,
    });
    const base = graph.getNodeAttribute("t:1", "size");
    const workers = fa2s.length;
    rows.fire("input", { target: field("track", "size", "8") });
    // FA2 does not use sizes (the no-overlap pass reads them when it runs): no worker restart.
    expect(fa2s.length).toBe(workers);
    expect(graph.getNodeAttribute("t:1", "size")).toBeCloseTo(base * 4);
    rows.fire("input", { target: field("track", "size", "-8") });
    expect(graph.getNodeAttribute("t:1", "size")).toBeCloseTo(base / 4);
    rows.fire("change", { target: field("track", "label", "", false) });
    expect(sigma.settings.nodeReducer("t:1", graph.getNodeAttributes("t:1")).noLabel).toBe(true);
    rows.fire("change", { target: field("set", "show", "", false) });
    expect(sigma.settings.nodeReducer("s:1", graph.getNodeAttributes("s:1")).hidden).toBe(true);
    rows.fire("input", { target: field("dj", "color", "#123456") });
    expect(sigma.settings.nodeReducer("a:dj", graph.getNodeAttributes("a:dj")).color).toBe(
      "#123456",
    );
    const saved = JSON.parse(storage.get("tk-graph:display")!);
    expect(saved.track).toEqual({ show: true, label: false, size: -8, color: "" });
    expect(saved.set.show).toBe(false);
    expect(saved.dj.color).toBe("#123456");
    // The older hidden list carried over.
    expect(saved.remix.show).toBe(false);
    els.get("gr-display-reset").fire("click");
    expect(JSON.parse(storage.get("tk-graph:display")!).track).toEqual({
      show: true,
      label: true,
      size: 0,
      color: "",
    });
    expect(graph.getNodeAttribute("t:1", "size")).toBeCloseTo(base);
  });

  it("settling stops the worker outside its message handler: no 'Cannot set properties of null'", async () => {
    // Every tick moves nothing, so the layout settles after the minimum number of ticks.
    const { fa2s, flush, els } = await boot();
    const fa2 = fa2s[0];
    expect(() => {
      for (let i = 0; i < 200; i++) fa2.tick();
    }).not.toThrow();
    // Still alive inside the handler; the stop comes on the next turn.
    expect(fa2.killed).toBe(false);
    flush();
    expect(fa2.killed).toBe(true);
    // Without a noverlap layout the no-overlap pass is skipped and the layout stops.
    expect(els.get("gr-layout").textContent).toBe("Run layout");
    // A tick that was already queued when the worker died is ignored.
    expect(() => fa2.tick()).not.toThrow();
  });

  it("the no-overlap pass shrinks a crowded graph, then runs noverlap rounds until nothing moves", async () => {
    const rounds: number[] = [];
    let n = 0;
    // Pushes s:2 away twice, then reports nothing left to move.
    const noverlap = (g: FakeGraph, p: any) => {
      rounds.push(p.maxIterations);
      n++;
      const out: Record<string, { x: number; y: number }> = {};
      g.forEachNode(
        (k: string, a: any) => (out[k] = { x: a.x + (k === "s:2" && n <= 2 ? 50 : 0), y: a.y }),
      );
      return out;
    };
    const { graph, fa2s, flush, els } = await boot({ noverlap });
    // Everything on one spot: as crowded as it gets.
    graph.updateEachNodeAttributes((k: string, a: any) => ({ ...a, x: 0, y: 0 }));
    const before = graph.getNodeAttribute("t:1", "size");
    for (let i = 0; i < 200; i++) fa2s[0].tick();
    flush();
    expect(graph.getNodeAttribute("t:1", "size")).toBeCloseTo(before * 0.3);
    expect(rounds.length).toBe(3);
    expect(graph.getNodeAttribute("s:2", "x")).toBe(100);
    expect(els.get("gr-layout").textContent).toBe("Run layout");
  });

  it("labels never overprint: overlapping nodes lose theirs, and the more important label wins a clash", async () => {
    const { graph, sigma } = await boot();
    const node = (id: string, size: number, x: number, y: number) => ({
      key: id,
      ...sigma.settings.nodeReducer(id, { ...graph.getNodeAttributes(id), size }),
      x,
      y,
    });
    const texts = (c: any) => c.calls.map((x: any[]) => x[1]);
    // Far apart: both labelled.
    const apart = canvasCtx();
    frame(sigma, apart, [node("s:1", 60, 100, 100), node("t:1", 60, 400, 100)]);
    expect(texts(apart)).toEqual(["Tomorrowland", "2026-07-19", "Sippin' Yak", "Cloonee"]);
    // Overlapping discs: neither label is drawn over the other node.
    const piled = canvasCtx();
    frame(sigma, piled, [node("s:1", 60, 100, 100), node("t:1", 60, 130, 100)]);
    expect(texts(piled)).toEqual([]);
    // Dimmed nodes (not neighbours of the selection) come last.
    const order = [
      { key: "t", cat: "track", deg: 9 },
      { key: "d", cat: "dj", dim: true },
      { key: "s", cat: "set", deg: 2 },
      { key: "dj", cat: "dj", deg: 1 },
      { key: "sel", cat: "track", sel: true },
    ];
    const ctx = vm.createContext({});
    const { GRAPH_HELPERS_JS } = await import("../src/ui/pages/graph-helpers");
    const GRK: any = vm.runInContext(GRAPH_HELPERS_JS + "\nGRK;", ctx);
    expect(order.sort(GRK.labelOrder).map((x) => x.key)).toEqual(["sel", "dj", "s", "t", "d"]);
  });

  it("a bigger category does not shrink the others: the room check ignores the Display sizes", async () => {
    const noverlap = (g: FakeGraph) => {
      const out: Record<string, { x: number; y: number }> = {};
      g.forEachNode((k: string, a: any) => (out[k] = { x: a.x, y: a.y }));
      return out;
    };
    const { graph, fa2s, flush, els } = await boot({ noverlap });
    // Room for every node at plain size (120 apart), none for a 4x track.
    let i = 0;
    graph.updateEachNodeAttributes((k: string, a: any) => ({ ...a, x: i++ * 120, y: 0 }));
    for (let t = 0; t < 200; t++) fa2s[0].tick();
    flush();
    const dj = graph.getNodeAttribute("a:dj", "size");
    const track = graph.getNodeAttribute("t:1", "size");
    const field = {
      getAttribute: (a: string) => (a === "data-cat" ? "track" : a === "data-k" ? "size" : null),
      value: "8",
    };
    els.get("gr-display-rows").fire("input", { target: field });
    flush(true);
    expect(graph.getNodeAttribute("t:1", "size")).toBeCloseTo(track * 4);
    expect(graph.getNodeAttribute("a:dj", "size")).toBeCloseTo(dj);
  });

  it("works without storage, and says so when the libraries did not load", async () => {
    const { graph } = await boot({
      storage: { "tk-graph:display": "{broken", "tk-graph:layout": "[]" },
    });
    expect(graph.order).toBe(4);
    const { document, els } = stubDom();
    const ctx = vm.createContext({
      window: {},
      document,
      setTimeout: () => 0,
      clearTimeout() {},
      console,
      fetch: async () => new Response("{}", { status: 404 }),
      location: { search: "", pathname: "/ui/graph" },
      URLSearchParams,
    });
    const r = await app.request("https://tracked.example/ui/graph", {}, env());
    for (const s of scriptsOf(await r.text())) vm.runInContext(s, ctx);
    expect(els.get("gr-status").textContent).toContain("did not load");
  });
});
