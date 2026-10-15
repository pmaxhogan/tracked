// Graph: the library as an interactive directed graph (spec:
// docs/superpowers/specs/2026-10-14-graph-tab-design.md). DJs and artists ->
// sets, sources -> sets, sets -> tracks, base tracks -> remixes, artists ->
// tracks. Data from /ui/api/graph/* (routes/graph.ts), cached data only.
//
// Rendering: Sigma.js (WebGL) on a graphology graph, ForceAtlas2 in a web
// worker (graphology-library's FA2Layout). These three are the only external
// scripts in tracked: jsdelivr, exact versions, SRI hashes, this page only.
// Node sizes are in graph units (itemSizesReference "positions"), so nodes
// grow and shrink with the zoom like the distances between them; labels are
// drawn inside the nodes on the canvas layer and only when a node is big
// enough on screen to hold readable text. Pure helpers: graph-helpers.ts.
//
// Layout: the FA2 supervisor copies the graph's positions back into its
// matrices every tick only when it has an outputReducer, so the page always
// passes one: a dragged or pinned node is held where the pointer put it while
// the layout runs, and links to pinned nodes weigh more (getEdgeWeight), so
// neighbours gather around a pinned node.
//
// Page scripts are template literals: no backticks and no dollar-brace inside,
// and every regex backslash is doubled. Upstream text only through TK.esc.
import { shell } from "../shell";
import { tipAttr } from "../tip";
import { GRAPH_HELPERS_JS } from "./graph-helpers";
import type { UiPage } from "./index";

/** The graph libraries, pinned (README: External scripts). */
export const GRAPH_LIBS = [
  {
    src: "https://cdn.jsdelivr.net/npm/graphology@0.26.0/dist/graphology.umd.min.js",
    integrity: "sha384-YdXPUVLFDJ3oITK7LFAPRyzkOcDK06bb7KRaE8GiQyGLsrvHaLS9Ej/lELMC7aCE",
  },
  {
    src: "https://cdn.jsdelivr.net/npm/graphology-library@0.8.0/dist/graphology-library.min.js",
    integrity: "sha384-JfW8ehTxF6vKpm17Oz+cpaluYzFMvm6YfXgwbw5Hxzrn0rR6WR+0DDDWPEIv9CtK",
  },
  {
    src: "https://cdn.jsdelivr.net/npm/sigma@3.0.3/dist/sigma.min.js",
    integrity: "sha384-2BM4IWUXdUSofkFc94Y1PY8U+cZYLJjB+EqQAoA2vfFGBvZK8aVaxEhICqCY4rlq",
  },
] as const;

const CSS = /* css */ `
  .gr-root {
    --g-dj: #3987e5; --g-artist: #8a7fd6; --g-set: #d95926; --g-source: #c98500; --g-track: #199e70; --g-remix: #d6458e;
    display: flex; flex-direction: column; gap: var(--sp-2);
  }
  @media (prefers-color-scheme: light) { :root:where(:not([data-theme="dark"])) .gr-root { --g-dj: #2a78d6; --g-artist: #6f5fd0; --g-set: #eb6834; --g-source: #b07400; --g-track: #1baf7a; --g-remix: #c73a80; } }
  :root[data-theme="light"] .gr-root { --g-dj: #2a78d6; --g-artist: #6f5fd0; --g-set: #eb6834; --g-source: #b07400; --g-track: #1baf7a; --g-remix: #c73a80; }
  .gr-bar { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; }
  .gr-find { position: relative; flex: 1 1 260px; min-width: 0; }
  .gr-find input { width: 100%; box-sizing: border-box; }
  .gr-hits { position: absolute; z-index: 30; left: 0; right: 0; top: calc(100% + 4px); background: var(--elev); border: 1px solid var(--line-strong); border-radius: var(--r-ctl); box-shadow: var(--shadow-float); max-height: 50vh; overflow: auto; }
  .gr-hits button { display: flex; gap: 8px; align-items: baseline; width: 100%; text-align: left; background: none; border: 0; padding: 7px 10px; color: var(--fg); font: inherit; font-size: var(--fs-sm); cursor: pointer; }
  .gr-hits button:hover, .gr-hits button.on { background: var(--accent-soft); }
  .gr-hits .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .gr-hits .sub, .gr-none { color: var(--muted); font-size: var(--fs-xs); }
  .gr-none { padding: 8px 10px; }
  .gr-depth { display: inline-flex; gap: 6px; align-items: center; color: var(--muted); font-size: var(--fs-sm); }
  .gr-legend { display: flex; flex-wrap: wrap; gap: 6px; }
  .gr-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border: 1px solid var(--line-strong); border-radius: 999px; background: var(--card); color: var(--fg); font: inherit; font-size: var(--fs-xs); cursor: pointer; }
  .gr-chip i { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }
  .gr-chip i.ring { box-shadow: 0 0 0 2px var(--card), 0 0 0 3px var(--fg); }
  .gr-chip .n { color: var(--muted); font-variant-numeric: tabular-nums; }
  .gr-chip[aria-pressed="false"] { opacity: .45; text-decoration: line-through; }
  .gr-edges { display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--muted); font-size: var(--fs-xs); }
  .gr-edges span::before { content: ""; display: inline-block; width: 16px; height: 0; border-top: 2px solid var(--c); margin-right: 5px; vertical-align: middle; }
  .gr-status { color: var(--muted); font-size: var(--fs-sm); min-height: 1.2em; }
  .gr-status.warn { color: var(--warn); }
  .gr-main { display: flex; gap: var(--sp-3); align-items: stretch; }
  .gr-canvas { position: relative; flex: 1; min-width: 0; height: calc(100vh - 260px); min-height: 360px; background: var(--card); border: 1px solid var(--line); border-radius: var(--r-card); overflow: hidden; touch-action: none; }
  .gr-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: var(--sp-4); color: var(--muted); font-size: var(--fs-sm); pointer-events: none; }
  .gr-panel { flex: 0 0 320px; max-width: 320px; background: var(--card); border: 1px solid var(--line); border-radius: var(--r-card); padding: 12px 14px; overflow: auto; height: calc(100vh - 260px); min-height: 360px; box-sizing: border-box; }
  .gr-panel h2 { margin: 0 0 4px; font-size: var(--fs-md); overflow-wrap: anywhere; }
  .gr-panel .by { color: var(--muted); font-size: var(--fs-sm); overflow-wrap: anywhere; }
  .gr-panel .cat { font-size: var(--fs-xs); color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
  .gr-panel dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; margin: 10px 0; font-size: var(--fs-sm); }
  .gr-panel dt { color: var(--muted); }
  .gr-panel dd { margin: 0; overflow-wrap: anywhere; }
  .gr-panel ul { list-style: none; padding: 0; margin: 6px 0 10px; display: grid; gap: 4px; font-size: var(--fs-sm); }
  .gr-panel .rel button { background: none; border: 0; padding: 0; color: var(--accent); font: inherit; cursor: pointer; text-align: left; }
  .gr-panel .rel .note { color: var(--muted); font-size: var(--fs-xs); margin-left: 6px; }
  .gr-panel .acts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .gr-panel-head { display: flex; justify-content: space-between; align-items: start; gap: 8px; }
  .gr-sub { margin: 10px 0 2px; font-size: var(--fs-xs); font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--subtle); }
  .gr-drawer { background: var(--card); border: 1px solid var(--line); border-radius: var(--r-card); padding: 10px 12px; font-size: var(--fs-sm); accent-color: var(--accent); }
  .gr-drawer-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 6px; }
  .gr-drawer-head h2 { margin: 0; font-size: var(--fs-xs); font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--subtle); flex: 1; }
  .gr-disp { display: grid; grid-template-columns: auto minmax(70px, 1fr) auto auto minmax(110px, 2fr) 3.2em; gap: 6px 10px; align-items: center; max-width: 760px; }
  .gr-disp .hd { color: var(--subtle); font-size: var(--fs-xs); }
  .gr-disp input[type="color"] { width: 26px; height: 22px; padding: 0; border: 1px solid var(--line-strong); border-radius: 4px; background: none; cursor: pointer; }
  .gr-disp input[type="range"], .gr-forces input[type="range"] { width: 100%; min-width: 0; }
  .gr-disp .v, .gr-forces .v { font-variant-numeric: tabular-nums; color: var(--muted); font-size: var(--fs-xs); text-align: right; }
  .gr-disp label, .gr-forces label { display: inline-flex; align-items: center; gap: 4px; }
  .gr-forces { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 6px 18px; }
  .gr-forces .f { display: grid; grid-template-columns: 8.5em 1fr 3.4em; gap: 8px; align-items: center; min-width: 0; }
  .gr-flags { display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: center; margin-top: 8px; }
  .gr-forces .nm { color: var(--muted); }
  @media (max-width: 760px) {
    .gr-canvas { height: calc(100vh - 300px); min-height: 300px; }
    /* A bottom sheet above the phone tab bar (fixed at the bottom, z-index 40). */
    .gr-panel { position: fixed; z-index: 39; left: 0; right: 0; bottom: calc(58px + env(safe-area-inset-bottom)); max-width: none; height: auto; max-height: 50vh; min-height: 0; border-radius: var(--r-card) var(--r-card) 0 0; box-shadow: var(--shadow-float); }
    /* Display rows wrap: name and switches on one line, color and size on the next. */
    .gr-disp { grid-template-columns: auto 1fr auto auto; }
    .gr-disp .hd.sz, .gr-disp .hd.vv { display: none; }
    .gr-disp .sz { grid-column: 2 / 4; }
    .gr-forces .f { grid-template-columns: 7.5em 1fr 3.2em; }
  }
`;

const scriptTags = GRAPH_LIBS.map(
  (l) => `<script src="${l.src}" integrity="${l.integrity}" crossorigin="anonymous"></script>`,
).join("\n");

const BODY = /* html */ `
${scriptTags}
<div class="gr-root">
  <div class="gr-bar">
    <div class="gr-find">
      <input id="gr-q" type="search" placeholder="Find a DJ, artist, source, set or track" autocomplete="off" spellcheck="false" aria-label="Find a node to start from" aria-controls="gr-hits">
      <div id="gr-hits" class="gr-hits" role="listbox" hidden></div>
    </div>
    <label class="gr-depth"${tipAttr("How far out from the node you start from: 1 = its neighbours, 2 = their neighbours too.")}>Depth <select id="gr-depth"><option value="1">1</option><option value="2" selected>2</option></select></label>
    <button type="button" id="gr-library" class="btn"${tipAttr("Draw the whole library, up to the node limit in Settings.")}>Whole library</button>
    <button type="button" id="gr-fit" class="btn"${tipAttr("Zoom to show every node.")}>Fit</button>
    <button type="button" id="gr-layout" class="btn"${tipAttr("Start or stop the automatic layout. It stops by itself once the graph settles.")}>Run layout</button>
    <button type="button" id="gr-labels" class="btn" aria-pressed="true"${tipAttr("Show or hide the names inside the nodes. Zoom in when a node is too small to hold its name.")}>Labels</button>
    <button type="button" id="gr-display-btn" class="btn" aria-expanded="false" aria-controls="gr-display"${tipAttr("Per category: show or hide, size, label and color.")}>Display</button>
    <button type="button" id="gr-forces-btn" class="btn" aria-expanded="false" aria-controls="gr-forces"${tipAttr("The layout's forces (ForceAtlas2). Changes apply while it runs.")}>Forces</button>
    <button type="button" id="gr-unpin" class="btn" hidden${tipAttr("Let every pinned node move with the layout again.")}>Release pins</button>
    <button type="button" id="gr-clear" class="btn ghost">Clear</button>
  </div>
  <section id="gr-display" class="gr-drawer" aria-label="Display settings" hidden>
    <div class="gr-drawer-head"><h2>Display</h2><button type="button" id="gr-display-reset" class="btn ghost">Reset display</button></div>
    <div id="gr-display-rows" class="gr-disp"></div>
  </section>
  <section id="gr-forces" class="gr-drawer" aria-label="Layout forces" hidden>
    <div class="gr-drawer-head"><h2>Forces</h2><button type="button" id="gr-rerun" class="btn"${tipAttr("Scatter the unpinned nodes and lay the graph out again from scratch.")}>Re-run layout</button><button type="button" id="gr-forces-reset" class="btn ghost">Reset to defaults</button></div>
    <div id="gr-forces-rows"></div>
  </section>
  <div id="gr-legend" class="gr-legend" aria-label="Node categories: press one to hide or show it"></div>
  <div class="gr-edges" aria-hidden="true">
    <span style="--c: var(--gu-dj, var(--g-dj))">plays a set</span><span style="--c: var(--gu-source, var(--g-source))">source of a set</span><span style="--c: var(--gu-set, var(--g-set))">set has a track</span><span style="--c: var(--gu-artist, var(--g-artist))">artist of a track</span><span style="--c: var(--gu-remix, var(--g-remix))">remix / rework of a track</span>
  </div>
  <div id="gr-status" class="gr-status" role="status">Loading the graph libraries…</div>
  <div class="gr-main">
    <div id="gr-canvas" class="gr-canvas"><div id="gr-empty" class="gr-empty">Find a DJ, artist, source, set or track above to start from, or draw the whole library.</div></div>
    <aside id="gr-panel" class="gr-panel" aria-live="polite" hidden>
      <div class="gr-panel-head"><div id="gr-info-head"></div><button type="button" id="gr-close" class="btn icon ghost" aria-label="Close the panel">×</button></div>
      <div id="gr-info"></div>
    </aside>
  </div>
</div>
`;

const JS =
  GRAPH_HELPERS_JS +
  /* js */ `
(() => {
  const $ = TK.$, esc = TK.esc;
  const $status = $('gr-status'), $q = $('gr-q'), $hits = $('gr-hits'), $legend = $('gr-legend');
  const $canvas = $('gr-canvas'), $empty = $('gr-empty'), $panel = $('gr-panel'), $info = $('gr-info'), $head = $('gr-info-head');
  const say = (text, warn) => { if (!$status) return; $status.textContent = text; $status.className = 'gr-status' + (warn ? ' warn' : ''); };
  const W = typeof window !== 'undefined' ? window : {};
  if (!W.graphology || !W.Sigma || !W.graphologyLibrary || !$canvas) {
    say('The graph libraries did not load (they come from cdn.jsdelivr.net). Check the connection or a content blocker, then reload.', true);
    return;
  }

  // Base radius per category in graph units; the Display size multiplies it.
  const CATS = [
    { key: 'dj', label: 'DJs', one: 'DJ', base: 36 },
    { key: 'artist', label: 'Artists', one: 'Artist', base: 21 },
    { key: 'source', label: 'Sources', one: 'Source', base: 30 },
    { key: 'set', label: 'Sets', one: 'Set', base: 27 },
    { key: 'track', label: 'Tracks', one: 'Track', base: 19 },
    { key: 'remix', label: 'Remixes', one: 'Remix', base: 19 },
  ];
  const CAT_NAME = { dj: 'Subscribed DJ', artist: 'Artist', source: 'Source', set: 'Set', track: 'Track', remix: 'Remix' };
  const EDGE_NAME = { plays: 'plays', source: 'is the source of', has: 'has the track', by: 'is the artist of', feat: 'is featured on', remixer: 'remixed', remix: 'was remixed as', rework: 'was reworked as' };
  // Each link kind wears the color of a category, and a width in graph units.
  const EDGE = { plays: ['dj', 1.4], source: ['source', 1.4], has: ['set', 0.7], by: ['artist', 0.9], feat: ['artist', 0.6], remixer: ['remix', 0.9], remix: ['remix', 1.2], rework: ['remix', 1.2] };
  const css = (name, fallback) => {
    try { const v = getComputedStyle(document.querySelector('.gr-root')).getPropertyValue(name).trim(); return v || fallback; } catch (e) { return fallback; }
  };
  let THEME = {}, LABEL = '#999', DIM = '#bbb', ELEV = '#222', LINE = '#444', MUTED = '#999', FONT = 'sans-serif';
  function readColors() {
    DIM = css('--line-strong', '#bbb');
    THEME = { dj: css('--g-dj', '#3987e5'), artist: css('--g-artist', '#8a7fd6'), set: css('--g-set', '#d95926'), source: css('--g-source', '#c98500'), track: css('--g-track', '#199e70'), remix: css('--g-remix', '#d6458e') };
    LABEL = css('--fg', '#999'); ELEV = css('--elev', '#222'); LINE = css('--line-strong', '#444'); MUTED = css('--muted', '#999');
    try { FONT = getComputedStyle(document.body).fontFamily || FONT; } catch (e) {}
  }
  readColors();

  const store = {
    get(k) { try { return localStorage.getItem('tk-graph:' + k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem('tk-graph:' + k, v); } catch (e) {} },
  };
  let display = GRK.readDisplay(store.get('display'), store.get('hidden'));
  let layout = GRK.readLayout(store.get('layout'));
  let labelsOn = store.get('labels') !== 'off';
  const saveDisplay = () => store.set('display', JSON.stringify(display));
  const saveLayout = () => store.set('layout', JSON.stringify(layout));
  const colorOf = (cat) => (display[cat] && display[cat].color) || THEME[cat] || '#888888';
  let limits = { nodeCap: 5000, confirmOver: 300 };
  const expanded = new Set();
  let selected = null;
  // Pinned nodes: id -> position. A dragged node is pinned while it moves and stays pinned.
  const pins = new Map();

  const graph = new W.graphology.MultiDirectedGraph();
  const R = W.Sigma.rendering || {};
  const programs = {};
  try { if (R.createNodeBorderProgram) programs.border = R.createNodeBorderProgram({ borders: [{ size: { value: 0.12 }, color: { attribute: 'borderColor' } }, { size: { fill: true }, color: { attribute: 'color' } }] }); } catch (e) {}

  // -- labels inside the nodes (canvas layer) --
  const widths = new Map();
  let measureCtx = null;
  const measure = (text, px) => {
    const k = px + '|' + text;
    let w = widths.get(k);
    if (w === undefined) {
      if (widths.size > 30000) widths.clear();
      measureCtx.font = '600 ' + px + 'px ' + FONT;
      w = measureCtx.measureText(text).width;
      widths.set(k, w);
    }
    return w;
  };
  const textColors = new Map();
  const textOn = (c) => { let t = textColors.get(c); if (!t) { t = GRK.textOn(c); textColors.set(c, t); } return t; };
  function drawPin(ctx, d) {
    ctx.save();
    ctx.strokeStyle = LABEL; ctx.globalAlpha = 0.75; ctx.lineWidth = 1.5;
    if (ctx.setLineDash) ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.arc(d.x, d.y, d.size + 3, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
  function drawInside(ctx, d) {
    if (!d.label || d.noLabel) return;
    measureCtx = ctx;
    const fit = GRK.fitLabel(measure, GRK.labelLines(d.cat, d.label, d.sub), d.size);
    if (!fit) return;
    ctx.save();
    ctx.fillStyle = textOn(d.color);
    if (d.dim) ctx.globalAlpha = 0.6;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const l of fit) { ctx.font = (l.main ? '600 ' : '400 ') + l.px + 'px ' + FONT; ctx.fillText(l.text, d.x, d.y + l.y); }
    ctx.restore();
  }
  function drawLabel(ctx, d) {
    if (d.pinned) drawPin(ctx, d);
    drawInside(ctx, d);
  }
  // Hover: a halo, the inside label again (the hovered node is redrawn on top) and the full name in a box below.
  function drawHover(ctx, d) {
    ctx.save();
    ctx.strokeStyle = LABEL; ctx.lineWidth = 2; ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.arc(d.x, d.y, d.size + 2, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    drawInside(ctx, d);
    const lines = GRK.labelLines(d.cat, d.label, d.sub).filter(Boolean);
    if (!lines.length) return;
    ctx.save();
    const px1 = 13, px2 = 12, pad = 6;
    ctx.font = '600 ' + px1 + 'px ' + FONT;
    let w = ctx.measureText(lines[0]).width;
    if (lines[1]) { ctx.font = '400 ' + px2 + 'px ' + FONT; w = Math.max(w, ctx.measureText(lines[1]).width); }
    const bw = Math.min(w, 360) + pad * 2, bh = px1 + (lines[1] ? px2 + 4 : 0) + pad * 2;
    let dims = { width: 1e4 };
    try { dims = renderer.getDimensions(); } catch (e) {}
    const bx = Math.max(4, Math.min(dims.width - bw - 4, d.x - bw / 2)), by = d.y + d.size + 8;
    ctx.fillStyle = ELEV; ctx.strokeStyle = LINE; ctx.lineWidth = 1; ctx.shadowColor = 'rgba(0,0,0,.3)'; ctx.shadowBlur = 8;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 6); else ctx.rect(bx, by, bw, bh);
    ctx.fill(); ctx.shadowBlur = 0; ctx.stroke();
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillStyle = LABEL; ctx.font = '600 ' + px1 + 'px ' + FONT;
    measureCtx = ctx;
    ctx.fillText(GRK.truncate((t, p) => { ctx.font = '600 ' + p + 'px ' + FONT; return ctx.measureText(t).width; }, lines[0], px1, 360), bx + pad, by + pad);
    if (lines[1]) { ctx.fillStyle = MUTED; ctx.font = '400 ' + px2 + 'px ' + FONT; ctx.fillText(GRK.truncate((t, p) => { ctx.font = '400 ' + p + 'px ' + FONT; return ctx.measureText(t).width; }, lines[1], px2, 360), bx + pad, by + pad + px1 + 4); }
    ctx.restore();
  }

  let renderer;
  try {
    renderer = new W.Sigma(graph, $canvas, {
      renderEdgeLabels: false,
      defaultEdgeType: 'arrow',
      enableEdgeEvents: true,
      itemSizesReference: 'positions',
      zoomToSizeRatioFunction: (r) => r,
      defaultDrawNodeLabel: drawLabel,
      defaultDrawNodeHover: drawHover,
      labelRenderedSizeThreshold: 0,
      minEdgeThickness: 1,
      zIndex: true,
      minCameraRatio: 0.01,
      maxCameraRatio: 20,
      nodeProgramClasses: programs,
      nodeReducer: (node, d) => {
        const r = Object.assign({}, d);
        const ds = display[d.cat] || {};
        if (ds.show === false) { r.hidden = true; return r; }
        r.color = colorOf(d.cat);
        if (d.cat === 'dj') r.borderColor = LABEL;
        // Every visible node goes to drawLabel; it decides from the size on screen.
        r.forceLabel = true;
        r.noLabel = !labelsOn || ds.label === false;
        r.pinned = pins.has(node);
        if (selected) {
          if (node === selected) { r.highlighted = true; r.zIndex = 2; }
          else if (graph.areNeighbors(node, selected)) { r.zIndex = 1; }
          else { r.color = DIM; r.borderColor = DIM; r.dim = true; r.zIndex = 0; }
        }
        return r;
      },
      edgeReducer: (edge, d) => {
        const r = Object.assign({}, d);
        const s = graph.source(edge), t = graph.target(edge);
        const sc = graph.getNodeAttribute(s, 'cat'), tc = graph.getNodeAttribute(t, 'cat');
        if ((display[sc] && display[sc].show === false) || (display[tc] && display[tc].show === false)) { r.hidden = true; return r; }
        const k = EDGE[d.kind] || EDGE.has;
        r.color = selected && s !== selected && t !== selected ? DIM : colorOf(k[0]);
        return r;
      },
    });
  } catch (e) {
    say('The graph could not start: this browser has no WebGL.', true);
    return;
  }
  // The hover canvas goes above the hovered-node layer, so a hovered node keeps its inside label.
  try { const cv = renderer.getCanvases(); if (cv.hovers && cv.mouse && cv.mouse.parentNode) cv.mouse.parentNode.insertBefore(cv.hovers, cv.mouse); } catch (e) {}
  function retheme() { readColors(); textColors.clear(); applyUserColors(); renderer.refresh(); legend(); paintDisplay(); }
  if (W.matchMedia) {
    try { W.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', retheme); } catch (e) {}
  }
  // The theme switch in the shell sets data-theme on <html>.
  try { new MutationObserver(retheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] }); } catch (e) {}
  // A user color shows in the legend and the link key through --gu-<cat>.
  function applyUserColors() {
    const root = document.querySelector('.gr-root');
    if (!root || !root.style) return;
    for (const c of CATS) { if (display[c.key].color) root.style.setProperty('--gu-' + c.key, display[c.key].color); else root.style.removeProperty('--gu-' + c.key); }
  }
  applyUserColors();
  // While a node is dragged the frame stays put (sigma re-fits to the graph's box otherwise); Fit and new data let it go.
  const freezeFrame = () => { try { if (!renderer.getCustomBBox()) renderer.setCustomBBox(renderer.getBBox()); } catch (e) {} };
  const releaseFrame = () => { try { renderer.setCustomBBox(null); } catch (e) {} };

  // -- layout (ForceAtlas2, in a worker when the browser has one) --
  let fa2 = null, running = false, userPaused = false, stopTimer = null, phase = 'main';
  const settle = GRK.makeSettle();
  const $layout = $('gr-layout');
  let tickMoving = 0, tickN = 0, minX = 0, maxX = 0, minY = 0, maxY = 0, moveThr = 0;
  const isPinned = (n) => pins.has(n);
  const edgeWeight = (e, a, s, t) => GRK.edgeWeight(isPinned, (n) => graph.degree(n), layout.pinPull, s, t);
  // Runs on every node after each worker tick: pinned nodes are put back, and the move is measured for the settle test.
  function outputReducer(node, attr) {
    const p = pins.get(node);
    if (p) { attr.x = p.x; attr.y = p.y; }
    else if (attr.lx !== undefined && Math.abs(attr.x - attr.lx) + Math.abs(attr.y - attr.ly) > moveThr) tickMoving++;
    attr.lx = attr.x; attr.ly = attr.y;
    if (tickN === 0) { minX = maxX = attr.x; minY = maxY = attr.y; }
    else { if (attr.x < minX) minX = attr.x; if (attr.x > maxX) maxX = attr.x; if (attr.y < minY) minY = attr.y; if (attr.y > maxY) maxY = attr.y; }
    tickN++;
    return attr;
  }
  // graphology fires this once per worker tick (after the reducer has seen every node).
  graph.on('eachNodeAttributesUpdated', () => {
    if (!running || !tickN) return;
    const moving = tickMoving, total = tickN;
    moveThr = settle.eps * Math.max(1, maxX - minX, maxY - minY);
    tickN = 0; tickMoving = 0;
    if (dragged) { settle.reset(); return; }
    if (!settle.step(moving, total)) return;
    // Settled: finish with the no-overlap pass when it is on, then stop.
    if (phase === 'main' && layout.adjustSizes && fa2) { setPhase('overlap'); return; }
    stopLayout(false);
  });
  function paintLayout() { if ($layout) { $layout.textContent = running ? 'Stop layout' : 'Run layout'; $layout.setAttribute('aria-pressed', running ? 'true' : 'false'); } }
  function killWorker() { if (fa2) { try { fa2.kill(); } catch (e) {} fa2 = null; } }
  function stopLayout(byUser) {
    clearTimeout(stopTimer);
    killWorker();
    running = false;
    if (byUser) userPaused = true;
    paintLayout();
  }
  // (Re)starts the worker from the graph's current positions, pins and settings.
  function startLayout() {
    clearTimeout(stopTimer);
    killWorker();
    userPaused = false;
    if (graph.order < 2) { running = false; paintLayout(); return; }
    settle.reset(); tickN = 0; tickMoving = 0; moveThr = 0;
    phase = 'main';
    const settings = GRK.fa2Settings(layout, graph.order, phase);
    try {
      if (typeof Worker === 'undefined' || !W.graphologyLibrary.FA2Layout) throw new Error('no worker');
      fa2 = new W.graphologyLibrary.FA2Layout(graph, { settings: settings, getEdgeWeight: edgeWeight, outputReducer: outputReducer });
      fa2.start();
      running = true;
      // A ceiling in case the graph never settles (a big hairball keeps jittering).
      stopTimer = setTimeout(() => stopLayout(false), Math.max(20000, Math.min(120000, graph.order * 40)));
    } catch (e) {
      fa2 = null; running = false;
      try {
        W.graphologyLibrary.layoutForceAtlas2.assign(graph, { iterations: graph.order > 2000 ? 60 : 150, settings: settings, getEdgeWeight: edgeWeight });
        pins.forEach((p, n) => { if (graph.hasNode(n)) graph.mergeNodeAttributes(n, { x: p.x, y: p.y }); });
      } catch (e2) {}
    }
    paintLayout();
  }
  function setPhase(p) {
    phase = p;
    settle.reset();
    if (fa2 && fa2.settings) Object.assign(fa2.settings, GRK.fa2Settings(layout, graph.order, phase));
  }
  // Live settings: the supervisor sends its settings object with every tick.
  function applyLayoutSettings(restart) {
    if (!running || restart) { startLayout(); return; }
    if (fa2 && fa2.settings) Object.assign(fa2.settings, GRK.fa2Settings(layout, graph.order, phase));
    settle.reset();
  }
  if ($layout) $layout.addEventListener('click', () => { if (running) stopLayout(true); else startLayout(); });

  // -- sizes --
  const baseOf = (cat) => { const c = CATS.find((x) => x.key === cat); return c ? c.base : 14; };
  const sizeOf = (cat, w) => (baseOf(cat) + Math.min(12, Math.log2(1 + (w || 0)) * 2.4)) * GRK.sizeMult(display[cat] ? display[cat].size : 0);
  function resize() {
    graph.updateEachNodeAttributes((n, a) => { a.size = sizeOf(a.cat, a.weight); return a; }, { attributes: ['size'] });
    // FA2 reads sizes when it starts; only "No overlap" uses them.
    if (running && layout.adjustSizes && phase === 'overlap') startLayout();
  }

  // -- adding data --
  function nodeAttrs(n) {
    const a = { label: n[2], cat: n[1], weight: n[3] || 0, size: sizeOf(n[1], n[3]), color: colorOf(n[1]) };
    if (n[4]) a.sub = n[4];
    if (n[1] === 'dj' && programs.border) { a.type = 'border'; a.borderColor = LABEL; }
    return a;
  }
  async function add(data, anchor, opts) {
    opts = opts || {};
    if (data.limits) limits = data.limits;
    const fresh = data.nodes.filter((n) => !graph.hasNode(n[0]));
    if (!opts.noConfirm && fresh.length > limits.confirmOver) {
      const ok = await TK.ask('This adds ' + fresh.length.toLocaleString() + ' nodes to the graph (' + graph.order.toLocaleString() + ' now). Large graphs get slow to draw. Add them?', { yes: 'Add them' });
      if (!ok) { say('Nothing added.'); return -1; }
    }
    const room = Math.max(0, limits.nodeCap - graph.order);
    const take = fresh.slice(0, room);
    const cut = fresh.length - take.length;
    const base = anchor && graph.hasNode(anchor) ? graph.getNodeAttributes(anchor) : { x: 0, y: 0 };
    const spread = 40 + Math.sqrt(take.length) * 25;
    for (const n of data.nodes) if (graph.hasNode(n[0])) { graph.mergeNodeAttributes(n[0], { label: n[2], cat: n[1], weight: n[3] || 0, sub: n[4] || undefined }); }
    take.forEach((n, i) => {
      const ang = (i / Math.max(1, take.length)) * Math.PI * 2;
      const r = spread * (0.5 + Math.random() * 0.5);
      graph.addNode(n[0], Object.assign(nodeAttrs(n), { x: base.x + Math.cos(ang) * r, y: base.y + Math.sin(ang) * r }));
    });
    let edges = 0;
    for (const e of data.edges) {
      const key = e[0] + '|' + e[1] + '|' + e[2];
      if (graph.hasEdge(key) || !graph.hasNode(e[0]) || !graph.hasNode(e[1])) continue;
      const k = EDGE[e[2]] || EDGE.has;
      graph.addDirectedEdgeWithKey(key, e[0], e[1], { kind: e[2], color: colorOf(k[0]), size: k[1] });
      edges++;
    }
    if ($empty) $empty.hidden = graph.order > 0;
    legend();
    const msg = [];
    msg.push(graph.order.toLocaleString() + ' nodes, ' + graph.size.toLocaleString() + ' edges on the graph.');
    if (cut > 0 || data.truncated) msg.push('Some nodes were left out: the graph holds ' + limits.nodeCap.toLocaleString() + ' at most (Settings, Graph).');
    say(msg.join(' '), cut > 0 || data.truncated);
    if (take.length || edges) { releaseFrame(); startLayout(); }
    return take.length;
  }

  async function fetchJson(path) {
    const res = await TK.api.get(path);
    if (!res.ok || !res.data) { say(TK.errText(res, 'The graph could not be read (' + res.status + ').'), true); return null; }
    return res.data;
  }
  async function expand(id) {
    say('Reading the neighbours\\u2026');
    const d = await fetchJson('/ui/api/graph/expand?depth=1&id=' + encodeURIComponent(id));
    if (!d) return;
    // Declined (-1): not expanded, so Expand and a click still offer it.
    const n = await add(d, id);
    if (n < 0) return;
    expanded.add(id);
    if (n === 0 && d.nodes.length <= 1) say('No more neighbours here.');
  }
  async function focus(id) {
    const depth = ($('gr-depth') && $('gr-depth').value) || '2';
    say('Reading the graph\\u2026');
    const d = await fetchJson('/ui/api/graph/expand?depth=' + encodeURIComponent(depth) + '&id=' + encodeURIComponent(id));
    if (!d) return;
    if (d.limits) limits = d.limits;
    // Asked before the current graph is cleared, so a "no" keeps it.
    if (d.nodes.length > limits.confirmOver) {
      const ok = await TK.ask('Starting here draws ' + d.nodes.length.toLocaleString() + ' nodes. Large graphs get slow to draw. Draw them? (Depth 1 draws fewer.)', { yes: 'Draw them' });
      if (!ok) { say('Nothing changed.'); return; }
    }
    clearGraph();
    expanded.add(id);
    await add(d, null, { noConfirm: true });
    try { TK.qs.set({ focus: id }); } catch (e) {}
    if (graph.hasNode(id)) select(id);
    setTimeout(() => { try { renderer.getCamera().animatedReset(); } catch (e) {} }, 600);
  }
  function clearGraph() {
    stopLayout(false);
    graph.clear();
    expanded.clear();
    pins.clear();
    paintPins();
    selected = null;
    closePanel();
    releaseFrame();
    if ($empty) $empty.hidden = false;
    legend();
  }

  // -- legend: one chip per category, pressing it hides or shows the category --
  function legend() {
    if (!$legend) return;
    const counts = {};
    graph.forEachNode((n, a) => { counts[a.cat] = (counts[a.cat] || 0) + 1; });
    $legend.innerHTML = CATS.map((c) => '<button type="button" class="gr-chip" data-cat="' + c.key + '" aria-pressed="' + (display[c.key].show ? 'true' : 'false') + '"><i' + (c.key === 'dj' ? ' class="ring"' : '') + ' style="background:' + esc(colorOf(c.key)) + '"></i>' + esc(c.label) + ' <span class="n">' + (counts[c.key] || 0).toLocaleString() + '</span></button>').join('');
  }
  if ($legend) $legend.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('[data-cat]') : null;
    if (!b) return;
    const c = b.getAttribute('data-cat');
    if (!display[c]) return;
    display[c].show = !display[c].show;
    saveDisplay();
    legend(); paintDisplay();
    renderer.refresh();
  });

  // -- Display drawer: per category show, label, size and color --
  const $dispRows = $('gr-display-rows');
  function paintDisplay() {
    if (!$dispRows) return;
    let h = '<span class="hd">Color</span><span class="hd">Category</span><span class="hd">Show</span><span class="hd">Label</span><span class="hd sz">Size</span><span class="hd vv"></span>';
    for (const c of CATS) {
      const d = display[c.key];
      h += '<input type="color" data-k="color" data-cat="' + c.key + '" value="' + esc(colorOf(c.key)) + '" aria-label="' + esc(c.one) + ' color">' +
        '<span>' + esc(c.label) + '</span>' +
        '<label><input type="checkbox" data-k="show" data-cat="' + c.key + '"' + (d.show ? ' checked' : '') + ' aria-label="Show ' + esc(c.label) + '"></label>' +
        '<label><input type="checkbox" data-k="label" data-cat="' + c.key + '"' + (d.label ? ' checked' : '') + ' aria-label="Label ' + esc(c.label) + '"></label>' +
        '<input class="sz" type="range" min="-' + GRK.SIZE_STEPS + '" max="' + GRK.SIZE_STEPS + '" step="1" value="' + d.size + '" data-k="size" data-cat="' + c.key + '" aria-label="' + esc(c.one) + ' size">' +
        '<span class="v" data-v="' + c.key + '">' + GRK.multLabel(d.size) + '</span>';
    }
    $dispRows.innerHTML = h;
  }
  function onDisplayInput(e) {
    const t = e.target;
    const cat = t && t.getAttribute ? t.getAttribute('data-cat') : null, k = t && t.getAttribute ? t.getAttribute('data-k') : null;
    if (!cat || !k || !display[cat]) return;
    if (k === 'show' || k === 'label') { display[cat][k] = !!t.checked; if (k === 'show') legend(); }
    else if (k === 'size') {
      display[cat].size = Number(t.value) || 0;
      const v = $dispRows.querySelector('[data-v="' + cat + '"]');
      if (v) v.textContent = GRK.multLabel(display[cat].size);
      resize();
    } else if (k === 'color') {
      display[cat].color = /^#[0-9a-f]{6}$/i.test(t.value) && t.value.toLowerCase() !== String(THEME[cat]).toLowerCase() ? t.value.toLowerCase() : '';
      applyUserColors(); legend();
    }
    saveDisplay();
    renderer.refresh();
  }
  if ($dispRows) { $dispRows.addEventListener('input', onDisplayInput); $dispRows.addEventListener('change', onDisplayInput); }
  const $dispReset = $('gr-display-reset');
  if ($dispReset) $dispReset.addEventListener('click', () => { display = GRK.displayDefault(); saveDisplay(); applyUserColors(); paintDisplay(); legend(); resize(); renderer.refresh(); });

  // -- Forces drawer: the ForceAtlas2 knobs, live --
  const $forceRows = $('gr-forces-rows');
  const fmt = (f, v) => (f.step >= 1 ? String(v) : Number(v).toFixed(f.step < 0.1 ? 2 : (f.step < 1 ? (String(f.step).split('.')[1] || '').length : 0)));
  function paintForces() {
    if (!$forceRows) return;
    // Sliders in a grid, then the switches and the Barnes-Hut choice on one wrapping row.
    const sliders = GRK.LAYOUT_FIELDS.filter((f) => !f.bool && !f.choice).map((f) => {
      const v = layout[f.key];
      return '<div class="f"><span class="nm"' + TK.tip(f.tip) + '>' + esc(f.label) + '</span><input type="range" data-f="' + f.key + '" min="' + f.min + '" max="' + f.max + '" step="' + f.step + '" value="' + v + '" aria-label="' + esc(f.label) + '"><span class="v" data-fv="' + f.key + '">' + fmt(f, v) + '</span></div>';
    }).join('');
    const flags = GRK.LAYOUT_FIELDS.filter((f) => f.bool || f.choice).map((f) => {
      const v = layout[f.key];
      if (f.bool) return '<label' + TK.tip(f.tip) + '><input type="checkbox" data-f="' + f.key + '"' + (v ? ' checked' : '') + '> ' + esc(f.label) + '</label>';
      return '<label' + TK.tip(f.tip) + '>' + esc(f.label) + ' <select data-f="' + f.key + '">' + f.choice.map((c) => '<option value="' + c + '"' + (c === v ? ' selected' : '') + '>' + c + '</option>').join('') + '</select></label>';
    }).join('');
    $forceRows.innerHTML = '<div class="gr-forces">' + sliders + '</div><div class="gr-flags">' + flags + '</div>';
  }
  function onForceInput(e) {
    const t = e.target, key = t && t.getAttribute ? t.getAttribute('data-f') : null;
    const f = GRK.LAYOUT_FIELDS.find((x) => x.key === key);
    if (!f) return;
    if (f.bool) layout[key] = !!t.checked;
    else if (f.choice) layout[key] = t.value;
    else {
      layout[key] = Number(t.value);
      const v = $forceRows.querySelector('[data-fv="' + key + '"]');
      if (v) v.textContent = fmt(f, layout[key]);
    }
    saveLayout();
    // Pin pull changes link weights and "No overlap" needs sizes: both are read when the worker starts.
    applyLayoutSettings(key === 'pinPull');
  }
  if ($forceRows) { $forceRows.addEventListener('input', onForceInput); $forceRows.addEventListener('change', (e) => { const t = e.target; if (t && (t.type === 'checkbox' || t.tagName === 'SELECT')) onForceInput(e); }); }
  const $forcesReset = $('gr-forces-reset');
  if ($forcesReset) $forcesReset.addEventListener('click', () => { layout = GRK.layoutDefault(); saveLayout(); paintForces(); applyLayoutSettings(true); });
  const $rerun = $('gr-rerun');
  if ($rerun) $rerun.addEventListener('click', () => {
    if (graph.order < 2) return;
    const r = 40 + Math.sqrt(graph.order) * 30;
    graph.updateEachNodeAttributes((n, a) => { if (!pins.has(n)) { a.x = (Math.random() - 0.5) * 2 * r; a.y = (Math.random() - 0.5) * 2 * r; } return a; }, { attributes: ['x', 'y'] });
    releaseFrame();
    startLayout();
    setTimeout(() => { try { renderer.getCamera().animatedReset(); } catch (e) {} }, 300);
  });
  function drawerToggle(btnId, boxId) {
    const b = $(btnId), box = $(boxId);
    if (!b || !box) return;
    b.addEventListener('click', () => { box.hidden = !box.hidden; b.setAttribute('aria-expanded', box.hidden ? 'false' : 'true'); });
  }
  drawerToggle('gr-display-btn', 'gr-display');
  drawerToggle('gr-forces-btn', 'gr-forces');

  // -- pins --
  const $unpin = $('gr-unpin');
  function paintPins() { if ($unpin) { $unpin.hidden = pins.size === 0; $unpin.textContent = 'Release pins (' + pins.size + ')'; } }
  function unpin(id) {
    if (id) pins.delete(id); else pins.clear();
    paintPins();
    renderer.refresh();
    // The neighbours were held by the pin's heavier links: let the layout settle without them.
    if (running || !userPaused) startLayout();
  }
  if ($unpin) $unpin.addEventListener('click', () => unpin(null));

  // -- info panel --
  function closePanel() { if ($panel) $panel.hidden = true; }
  const $close = $('gr-close');
  if ($close) $close.addEventListener('click', () => { selected = null; closePanel(); renderer.refresh(); });
  const nameOf = (n) => { const a = graph.getNodeAttributes(n); return a.sub ? a.label + ' \\u00b7 ' + a.sub : a.label; };
  function linkHtml(l) {
    const href = l.external ? TK.safeHref(l.href) : (/^\\/ui\\//.test(String(l.href)) ? String(l.href) : null);
    if (!href) return '';
    return '<li><a href="' + esc(href) + '"' + (l.external ? ' target="_blank" rel="noopener noreferrer"' : '') + '>' + esc(l.label) + (l.external ? ' \\u2197' : '') + '</a></li>';
  }
  function actions(id) {
    return '<div class="acts">' + (expanded.has(id) ? '' : '<button type="button" class="btn" data-act="expand">Expand</button>') +
      '<button type="button" class="btn" data-act="focus">Start from here</button>' +
      (pins.has(id) ? '<button type="button" class="btn" data-act="unpin">Unpin</button>' : '<button type="button" class="btn" data-act="pin">Pin</button>') +
      '<button type="button" class="btn ghost" data-act="remove">Remove</button></div>';
  }
  function headHtml(cat, title, by) {
    return '<div class="cat">' + esc(CAT_NAME[cat] || '') + '</div><h2>' + esc(title) + '</h2>' + (by ? '<div class="by">' + esc(by) + '</div>' : '');
  }
  async function showInfo(id) {
    if (!$panel || !$info) return;
    $panel.hidden = false;
    const a = graph.hasNode(id) ? graph.getNodeAttributes(id) : null;
    if ($head) $head.innerHTML = headHtml(a ? a.cat : '', a ? a.label : id, a ? a.sub : '');
    $info.innerHTML = '<p class="gr-none">Loading\\u2026</p>';
    const res = await TK.api.get('/ui/api/graph/info?id=' + encodeURIComponent(id));
    if (selected !== id) return;
    if (!res.ok || !res.data) { $info.innerHTML = '<p class="gr-none">' + esc(TK.errText(res, 'No details for this node.')) + '</p>' + actions(id); bindActs(id); return; }
    const d = res.data;
    // Tracks keep the title and the artist apart, as on the node.
    if ($head) $head.innerHTML = a && a.sub ? headHtml(d.cat, a.label, a.sub) : headHtml(d.cat, d.title, '');
    let h = '<dl>' + (d.facts || []).map((f) => '<dt>' + esc(f[0]) + '</dt><dd>' + esc(f[1]) + '</dd>').join('') + '</dl>';
    const links = (d.links || []).map(linkHtml).join('');
    if (links) h += '<div class="gr-sub">Links</div><ul>' + links + '</ul>';
    if (d.related && d.related.length) h += '<div class="gr-sub">Related</div><ul class="rel">' + d.related.map((r) => '<li><button type="button" data-id="' + esc(r.id) + '">' + esc(r.label) + '</button><span class="note">' + esc(r.note) + '</span></li>').join('') + '</ul>';
    $info.innerHTML = h + actions(id);
    bindActs(id);
  }
  function edgeInfo(edge) {
    if (!$panel || !$info) return;
    const a = graph.getEdgeAttributes(edge), s = graph.source(edge), t = graph.target(edge);
    $panel.hidden = false;
    if ($head) $head.innerHTML = '<div class="cat">Link</div><h2>' + esc(EDGE_NAME[a.kind] || a.kind) + '</h2>';
    $info.innerHTML = '<ul class="rel"><li><button type="button" data-id="' + esc(s) + '">' + esc(nameOf(s)) + '</button><span class="note">' + esc(CAT_NAME[graph.getNodeAttribute(s, 'cat')] || '') + '</span></li>' +
      '<li class="gr-none">' + esc(EDGE_NAME[a.kind] || a.kind) + '</li>' +
      '<li><button type="button" data-id="' + esc(t) + '">' + esc(nameOf(t)) + '</button><span class="note">' + esc(CAT_NAME[graph.getNodeAttribute(t, 'cat')] || '') + '</span></li></ul>';
    bindActs(null);
  }
  function bindActs(id) {
    if (!$info) return;
    $info.onclick = async (e) => {
      const b = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      const rel = b.getAttribute('data-id');
      if (rel) {
        if (!graph.hasNode(rel) && id) { await expand(id); }
        if (graph.hasNode(rel)) { select(rel); center(rel); }
        return;
      }
      const act = b.getAttribute('data-act');
      if (act === 'expand' && id) await TK.busy(b, 'Expanding\\u2026', () => expand(id).then(() => showInfo(id)));
      else if (act === 'focus' && id) await focus(id);
      else if (act === 'pin' && id && graph.hasNode(id)) { const p = graph.getNodeAttributes(id); pins.set(id, { x: p.x, y: p.y }); paintPins(); renderer.refresh(); if (running) startLayout(); showInfo(id); }
      else if (act === 'unpin' && id) { unpin(id); showInfo(id); }
      else if (act === 'remove' && id && graph.hasNode(id)) { pins.delete(id); paintPins(); graph.dropNode(id); selected = null; closePanel(); legend(); renderer.refresh(); }
    };
  }
  function select(id) {
    selected = id;
    renderer.refresh();
    showInfo(id);
  }
  function center(id) {
    try {
      const p = renderer.getNodeDisplayData(id);
      if (p) renderer.getCamera().animate({ x: p.x, y: p.y, ratio: Math.min(renderer.getCamera().ratio, 0.6) }, { duration: 400 });
    } catch (e) {}
  }

  // -- pointer: click selects and expands, double click starts from the node,
  // drag moves the node (also while the layout runs) and pins it there --
  let dragged = null, moved = false;
  renderer.on('downNode', (e) => { dragged = e.node; moved = false; });
  function dragTo(pos) {
    if (!dragged) return;
    if (!moved) {
      moved = true;
      freezeFrame();
      const was = pins.has(dragged);
      pins.set(dragged, { x: pos.x, y: pos.y });
      paintPins();
      // A new pin changes link weights, read when the worker starts. A layout that
      // settled by itself wakes up so the neighbours follow; a paused one stays paused.
      if (running ? !was : !userPaused) startLayout();
      else if (running && phase !== 'main') setPhase('main');
    }
    pins.set(dragged, { x: pos.x, y: pos.y });
    graph.mergeNodeAttributes(dragged, { x: pos.x, y: pos.y });
  }
  function dragEnd() { dragged = null; }
  const mouse = renderer.getMouseCaptor();
  mouse.on('mousemovebody', (e) => {
    if (!dragged) return;
    dragTo(renderer.viewportToGraph(e));
    e.preventSigmaDefault();
    if (e.original) { e.original.preventDefault(); e.original.stopPropagation(); }
  });
  mouse.on('mouseup', dragEnd);
  try {
    const touch = renderer.getTouchCaptor();
    touch.on('touchmove', (e) => {
      if (!dragged || !e.touches || e.touches.length !== 1) return;
      dragTo(renderer.viewportToGraph(e.touches[0]));
      e.preventSigmaDefault();
      if (e.original) e.original.preventDefault();
    });
    touch.on('touchup', dragEnd);
  } catch (e) {}
  renderer.on('clickNode', (e) => {
    if (moved) { moved = false; return; }
    select(e.node);
    if (!expanded.has(e.node)) expand(e.node);
  });
  renderer.on('doubleClickNode', (e) => { e.preventSigmaDefault(); focus(e.node); });
  renderer.on('clickEdge', (e) => { selected = null; renderer.refresh(); edgeInfo(e.edge); });
  renderer.on('clickStage', () => { if (selected) { selected = null; renderer.refresh(); } closePanel(); });

  // -- toolbar --
  const $fit = $('gr-fit');
  if ($fit) $fit.addEventListener('click', () => { releaseFrame(); try { renderer.getCamera().animatedReset(); } catch (e) {} });
  const $labels = $('gr-labels');
  const paintLabels = () => { if ($labels) $labels.setAttribute('aria-pressed', labelsOn ? 'true' : 'false'); };
  paintLabels();
  if ($labels) $labels.addEventListener('click', () => { labelsOn = !labelsOn; store.set('labels', labelsOn ? 'on' : 'off'); paintLabels(); renderer.refresh(); });
  const $clear = $('gr-clear');
  if ($clear) $clear.addEventListener('click', () => { clearGraph(); try { TK.qs.set({}); } catch (e) {} say('Cleared.'); });
  const $lib = $('gr-library');
  if ($lib) $lib.addEventListener('click', async () => {
    const ok = await TK.ask('Draw the whole library? Up to ' + limits.nodeCap.toLocaleString() + ' nodes (the limit in Settings, Graph): DJs, sources and sets first, then the most played tracks and the most credited artists. A large graph is slow to draw and to lay out.', { yes: 'Draw it' });
    if (!ok) return;
    await TK.busy($lib, 'Reading\\u2026', async () => {
      const d = await fetchJson('/ui/api/graph/library');
      if (!d) return;
      clearGraph();
      await add(d, null, { noConfirm: true });
      try { TK.qs.set({}); } catch (e) {}
    });
  });

  // -- find --
  let findTimer = null, findSeq = 0, hits = [], hitOn = -1;
  function paintHits() {
    if (!$hits) return;
    if (!hits.length) { $hits.innerHTML = '<div class="gr-none">Nothing found in the cached library.</div>'; $hits.hidden = false; return; }
    $hits.innerHTML = hits.map((h, i) => '<button type="button" role="option" data-i="' + i + '"' + (i === hitOn ? ' class="on"' : '') + '><i class="gr-dot" style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' + esc(colorOf(h.cat)) + '"></i><span class="nm">' + esc(h.label) + '</span><span class="sub">' + esc(h.sub || CAT_NAME[h.cat] || '') + '</span></button>').join('');
    $hits.hidden = false;
  }
  async function find(q) {
    const seq = ++findSeq;
    const res = await TK.api.get('/ui/api/graph/find?q=' + encodeURIComponent(q));
    if (seq !== findSeq) return;
    if (!res.ok || !res.data) { say(TK.errText(res, 'Search failed (' + res.status + ').'), true); return; }
    hits = res.data.hits || [];
    hitOn = hits.length ? 0 : -1;
    paintHits();
  }
  const pick = (i) => { const h = hits[i]; if (!h) return; if ($hits) $hits.hidden = true; if ($q) $q.value = h.label; focus(h.id); };
  if ($q) {
    $q.addEventListener('input', () => {
      clearTimeout(findTimer);
      const q = $q.value.trim();
      if (q.length < 2) { if ($hits) $hits.hidden = true; return; }
      findTimer = setTimeout(() => find(q), 200);
    });
    $q.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { if ($hits) $hits.hidden = true; return; }
      if (!hits.length || !$hits || $hits.hidden) return;
      if (e.key === 'ArrowDown') { hitOn = Math.min(hits.length - 1, hitOn + 1); paintHits(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { hitOn = Math.max(0, hitOn - 1); paintHits(); e.preventDefault(); }
      else if (e.key === 'Enter') { pick(Math.max(0, hitOn)); e.preventDefault(); }
    });
  }
  if ($hits) $hits.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('[data-i]') : null;
    if (b) pick(Number(b.getAttribute('data-i')));
  });
  document.addEventListener('click', (e) => { if ($hits && !$hits.hidden && e.target !== $q && !(e.target && e.target.closest && e.target.closest('#gr-hits'))) $hits.hidden = true; });

  // A read-only handle for debugging in the console (and the browser checks).
  W.tkGraph = { graph: graph, renderer: renderer, pins: pins, running: () => running, settings: () => (fa2 ? fa2.settings : null) };

  // -- start --
  legend();
  paintDisplay();
  paintForces();
  paintLayout();
  paintPins();
  (async () => {
    const res = await TK.api.get('/ui/api/graph/status');
    if (res.ok && res.data) {
      const d = res.data;
      if (d.limits) limits = d.limits;
      say((d.parsed || 0).toLocaleString() + ' of ' + (d.sets || 0).toLocaleString() + ' indexed sets have their sources and credits so far; ' + (d.sources || 0).toLocaleString() + ' sources, ' + (d.artists || 0).toLocaleString() + ' artists. The rest fill in as sets are read again.');
    } else say(TK.errText(res, 'The graph data could not be read (' + res.status + ').'), true);
    const start = TK.qs.get('focus');
    if (start) focus(start);
  })();
})();
`;

export const GRAPH_PAGE: UiPage = {
  path: "/graph",
  html: shell({
    nav: "graph",
    title: "Graph",
    description:
      "DJs, artists, sets, sources, tracks and remixes as one graph, drawn from the cached library. Click a node to see it and its neighbours, drag one to pin it.",
    body: BODY,
    css: CSS,
    js: JS,
  }),
};
