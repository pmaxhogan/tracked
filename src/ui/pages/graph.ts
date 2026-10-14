// Graph: the library as an interactive directed graph (spec:
// docs/superpowers/specs/2026-10-14-graph-tab-design.md). DJs and artists ->
// sets, sources -> sets, sets -> tracks, base tracks -> remixes, artists ->
// tracks. Data from /ui/api/graph/* (routes/graph.ts), cached data only.
//
// Rendering: Sigma.js (WebGL) on a graphology graph, ForceAtlas2 in a web
// worker (graphology-library's FA2Layout). These three are the only external
// scripts in tracked: jsdelivr, exact versions, SRI hashes, this page only.
//
// Page scripts are template literals: no backticks and no dollar-brace inside,
// and every regex backslash is doubled. Upstream text only through TK.esc.
import { shell } from "../shell";
import { tipAttr } from "../tip";
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
  @media (max-width: 760px) {
    .gr-canvas { height: calc(100vh - 300px); min-height: 300px; }
    /* A bottom sheet above the phone tab bar (fixed at the bottom, z-index 40). */
    .gr-panel { position: fixed; z-index: 39; left: 0; right: 0; bottom: calc(58px + env(safe-area-inset-bottom)); max-width: none; height: auto; max-height: 50vh; min-height: 0; border-radius: var(--r-card) var(--r-card) 0 0; box-shadow: var(--shadow-float); }
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
    <button type="button" id="gr-layout" class="btn"${tipAttr("Start or stop the automatic layout.")}>Layout</button>
    <button type="button" id="gr-labels" class="btn" aria-pressed="true"${tipAttr("Label every node, or only the ones there is room for.")}>All labels</button>
    <button type="button" id="gr-clear" class="btn ghost">Clear</button>
  </div>
  <div id="gr-legend" class="gr-legend" aria-label="Node categories: press one to hide or show it"></div>
  <div class="gr-edges" aria-hidden="true">
    <span style="--c: var(--g-dj)">plays a set</span><span style="--c: var(--g-source)">source of a set</span><span style="--c: var(--g-set)">set has a track</span><span style="--c: var(--g-artist)">artist of a track</span><span style="--c: var(--g-remix)">remix / rework of a track</span>
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

const JS = /* js */ `
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

  const CATS = [
    { key: 'dj', label: 'DJs', base: 11 },
    { key: 'artist', label: 'Artists', base: 5 },
    { key: 'source', label: 'Sources', base: 9 },
    { key: 'set', label: 'Sets', base: 7 },
    { key: 'track', label: 'Tracks', base: 4 },
    { key: 'remix', label: 'Remixes', base: 4 },
  ];
  const CAT_NAME = { dj: 'Subscribed DJ', artist: 'Artist', source: 'Source', set: 'Set', track: 'Track', remix: 'Remix' };
  const EDGE_NAME = { plays: 'plays', source: 'is the source of', has: 'has the track', by: 'is the artist of', feat: 'is featured on', remixer: 'remixed', remix: 'was remixed as', rework: 'was reworked as' };
  const css = (name, fallback) => {
    try { const v = getComputedStyle(document.querySelector('.gr-root')).getPropertyValue(name).trim(); return v || fallback; } catch (e) { return fallback; }
  };
  let COLOR = {}, EDGE = {}, LABEL = '#999', DIM = '#bbb';
  function readColors() {
    DIM = css('--line-strong', '#bbb');
    COLOR = { dj: css('--g-dj', '#3987e5'), artist: css('--g-artist', '#8a7fd6'), set: css('--g-set', '#d95926'), source: css('--g-source', '#c98500'), track: css('--g-track', '#199e70'), remix: css('--g-remix', '#d6458e') };
    LABEL = css('--fg', '#999');
    EDGE = {
      plays: { color: COLOR.dj, size: 1.6 }, source: { color: COLOR.source, size: 1.6 }, has: { color: COLOR.set, size: 0.8 },
      by: { color: COLOR.artist, size: 1 }, feat: { color: COLOR.artist, size: 0.7 }, remixer: { color: COLOR.remix, size: 1 },
      remix: { color: COLOR.remix, size: 1.4 }, rework: { color: COLOR.remix, size: 1.4 },
    };
  }
  readColors();

  const store = {
    get(k) { try { return localStorage.getItem('tk-graph:' + k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem('tk-graph:' + k, v); } catch (e) {} },
  };
  const hidden = new Set(((store.get('hidden') || '').split(',')).filter(Boolean));
  let allLabels = store.get('labels') !== 'few';
  let limits = { nodeCap: 5000, confirmOver: 300 };
  const expanded = new Set();
  let selected = null;

  const graph = new W.graphology.MultiDirectedGraph();
  const R = W.Sigma.rendering || {};
  const programs = {};
  try { if (R.createNodeBorderProgram) programs.border = R.createNodeBorderProgram({ borders: [{ size: { value: 0.28 }, color: { attribute: 'borderColor' } }, { size: { fill: true }, color: { attribute: 'color' } }] }); } catch (e) {}
  let renderer;
  try {
    renderer = new W.Sigma(graph, $canvas, {
      renderEdgeLabels: false,
      defaultEdgeType: 'arrow',
      enableEdgeEvents: true,
      labelColor: { color: LABEL },
      labelSize: 12,
      labelRenderedSizeThreshold: 0,
      labelDensity: allLabels ? 50 : 0.5,
      labelGridCellSize: 60,
      zIndex: true,
      minCameraRatio: 0.02,
      maxCameraRatio: 20,
      nodeProgramClasses: programs,
      nodeReducer: (node, d) => {
        const r = Object.assign({}, d);
        if (hidden.has(d.cat)) { r.hidden = true; return r; }
        if (allLabels && graph.order <= 1500) r.forceLabel = true;
        if (selected) {
          if (node === selected) { r.highlighted = true; r.zIndex = 2; r.forceLabel = true; }
          else if (graph.areNeighbors(node, selected)) { r.zIndex = 1; r.forceLabel = true; }
          else { r.color = DIM; r.borderColor = DIM; r.label = allLabels && graph.order <= 300 ? d.label : ''; r.zIndex = 0; }
        }
        return r;
      },
      edgeReducer: (edge, d) => {
        const r = Object.assign({}, d);
        const s = graph.source(edge), t = graph.target(edge);
        if (hidden.has(graph.getNodeAttribute(s, 'cat')) || hidden.has(graph.getNodeAttribute(t, 'cat'))) { r.hidden = true; return r; }
        if (selected && s !== selected && t !== selected) r.color = DIM;
        return r;
      },
    });
  } catch (e) {
    say('The graph could not start: this browser has no WebGL.', true);
    return;
  }
  if (W.matchMedia) {
    try { W.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readColors(); recolor(); }); } catch (e) {}
  }
  // The theme switch in the shell sets data-theme on <html>.
  try { new MutationObserver(() => { readColors(); recolor(); legend(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] }); } catch (e) {}
  function recolor() {
    graph.forEachNode((n, a) => { graph.setNodeAttribute(n, 'color', COLOR[a.cat] || '#888'); if (a.cat === 'dj') graph.setNodeAttribute(n, 'borderColor', LABEL); });
    graph.forEachEdge((e, a) => { const s = EDGE[a.kind] || EDGE.has; graph.setEdgeAttribute(e, 'color', s.color); });
    renderer.setSetting('labelColor', { color: LABEL });
  }

  // -- layout (ForceAtlas2, in a worker when the browser has one) --
  let fa2 = null, stopTimer = null;
  const $layout = $('gr-layout');
  function fa2Settings() {
    const L = W.graphologyLibrary.layoutForceAtlas2;
    const s = L && L.inferSettings ? L.inferSettings(graph) : {};
    s.barnesHutOptimize = graph.order > 300;
    s.slowDown = 4;
    s.adjustSizes = false;
    return s;
  }
  function stopLayout() {
    clearTimeout(stopTimer);
    if (fa2) { try { fa2.kill(); } catch (e) {} fa2 = null; }
    if ($layout) $layout.textContent = 'Layout';
  }
  function runLayout(ms) {
    stopLayout();
    if (graph.order < 2) return;
    try {
      if (typeof Worker === 'undefined' || !W.graphologyLibrary.FA2Layout) throw new Error('no worker');
      fa2 = new W.graphologyLibrary.FA2Layout(graph, { settings: fa2Settings() });
      fa2.start();
      if ($layout) $layout.textContent = 'Stop layout';
      stopTimer = setTimeout(stopLayout, ms || Math.min(9000, 2000 + graph.order * 3));
    } catch (e) {
      fa2 = null;
      try { W.graphologyLibrary.layoutForceAtlas2.assign(graph, { iterations: graph.order > 2000 ? 60 : 150, settings: fa2Settings() }); } catch (e2) {}
    }
  }
  if ($layout) $layout.addEventListener('click', () => { if (fa2) stopLayout(); else runLayout(15000); });

  // -- adding data --
  const sizeOf = (cat, w) => { const c = CATS.find((x) => x.key === cat); return (c ? c.base : 5) + Math.min(8, Math.log2(1 + (w || 0)) * 1.4); };
  function nodeAttrs(n) {
    const a = { label: n[2], cat: n[1], weight: n[3] || 0, size: sizeOf(n[1], n[3]), color: COLOR[n[1]] || '#888' };
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
    const spread = 10 + Math.sqrt(take.length) * 6;
    for (const n of data.nodes) if (graph.hasNode(n[0])) { graph.mergeNodeAttributes(n[0], { label: n[2], cat: n[1], weight: n[3] || 0 }); }
    take.forEach((n, i) => {
      const ang = (i / Math.max(1, take.length)) * Math.PI * 2;
      const r = spread * (0.5 + Math.random() * 0.5);
      graph.addNode(n[0], Object.assign(nodeAttrs(n), { x: base.x + Math.cos(ang) * r, y: base.y + Math.sin(ang) * r }));
    });
    let edges = 0;
    for (const e of data.edges) {
      const key = e[0] + '|' + e[1] + '|' + e[2];
      if (graph.hasEdge(key) || !graph.hasNode(e[0]) || !graph.hasNode(e[1])) continue;
      const s = EDGE[e[2]] || EDGE.has;
      graph.addDirectedEdgeWithKey(key, e[0], e[1], { kind: e[2], color: s.color, size: s.size });
      edges++;
    }
    if ($empty) $empty.hidden = graph.order > 0;
    legend();
    const msg = [];
    msg.push(graph.order.toLocaleString() + ' nodes, ' + graph.size.toLocaleString() + ' edges on the graph.');
    if (cut > 0 || data.truncated) msg.push('Some nodes were left out: the graph holds ' + limits.nodeCap.toLocaleString() + ' at most (Settings, Graph).');
    say(msg.join(' '), cut > 0 || data.truncated);
    if (take.length || edges) runLayout();
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
    stopLayout();
    graph.clear();
    expanded.clear();
    selected = null;
    closePanel();
    if ($empty) $empty.hidden = false;
    legend();
  }

  // -- legend: one chip per category, pressing it hides or shows the category --
  function legend() {
    if (!$legend) return;
    const counts = {};
    graph.forEachNode((n, a) => { counts[a.cat] = (counts[a.cat] || 0) + 1; });
    $legend.innerHTML = CATS.map((c) => '<button type="button" class="gr-chip" data-cat="' + c.key + '" aria-pressed="' + (hidden.has(c.key) ? 'false' : 'true') + '"><i' + (c.key === 'dj' ? ' class="ring"' : '') + ' style="background:' + esc(COLOR[c.key]) + '"></i>' + esc(c.label) + ' <span class="n">' + (counts[c.key] || 0).toLocaleString() + '</span></button>').join('');
  }
  if ($legend) $legend.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('[data-cat]') : null;
    if (!b) return;
    const c = b.getAttribute('data-cat');
    if (hidden.has(c)) hidden.delete(c); else hidden.add(c);
    store.set('hidden', [...hidden].join(','));
    legend();
    renderer.refresh();
  });

  // -- info panel --
  function closePanel() { if ($panel) $panel.hidden = true; }
  const $close = $('gr-close');
  if ($close) $close.addEventListener('click', () => { selected = null; closePanel(); renderer.refresh(); });
  function linkHtml(l) {
    const href = l.external ? TK.safeHref(l.href) : (/^\\/ui\\//.test(String(l.href)) ? String(l.href) : null);
    if (!href) return '';
    return '<li><a href="' + esc(href) + '"' + (l.external ? ' target="_blank" rel="noopener noreferrer"' : '') + '>' + esc(l.label) + (l.external ? ' \\u2197' : '') + '</a></li>';
  }
  function actions(id) {
    return '<div class="acts">' + (expanded.has(id) ? '' : '<button type="button" class="btn" data-act="expand">Expand</button>') +
      '<button type="button" class="btn" data-act="focus">Start from here</button><button type="button" class="btn ghost" data-act="remove">Remove</button></div>';
  }
  async function showInfo(id) {
    if (!$panel || !$info) return;
    $panel.hidden = false;
    const a = graph.hasNode(id) ? graph.getNodeAttributes(id) : null;
    if ($head) $head.innerHTML = '<div class="cat">' + esc(CAT_NAME[a ? a.cat : ''] || '') + '</div><h2>' + esc(a ? a.label : id) + '</h2>';
    $info.innerHTML = '<p class="gr-none">Loading\\u2026</p>';
    const res = await TK.api.get('/ui/api/graph/info?id=' + encodeURIComponent(id));
    if (selected !== id) return;
    if (!res.ok || !res.data) { $info.innerHTML = '<p class="gr-none">' + esc(TK.errText(res, 'No details for this node.')) + '</p>' + actions(id); bindActs(id); return; }
    const d = res.data;
    if ($head) $head.innerHTML = '<div class="cat">' + esc(CAT_NAME[d.cat] || '') + '</div><h2>' + esc(d.title) + '</h2>';
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
    $info.innerHTML = '<ul class="rel"><li><button type="button" data-id="' + esc(s) + '">' + esc(graph.getNodeAttribute(s, 'label')) + '</button><span class="note">' + esc(CAT_NAME[graph.getNodeAttribute(s, 'cat')] || '') + '</span></li>' +
      '<li class="gr-none">' + esc(EDGE_NAME[a.kind] || a.kind) + '</li>' +
      '<li><button type="button" data-id="' + esc(t) + '">' + esc(graph.getNodeAttribute(t, 'label')) + '</button><span class="note">' + esc(CAT_NAME[graph.getNodeAttribute(t, 'cat')] || '') + '</span></li></ul>';
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
      else if (act === 'remove' && id && graph.hasNode(id)) { graph.dropNode(id); selected = null; closePanel(); legend(); renderer.refresh(); }
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

  // -- pointer: click selects and expands, double click starts from the node, drag pins it --
  let dragged = null, moved = false;
  renderer.on('downNode', (e) => {
    dragged = e.node; moved = false;
    // Keep the frame still while a node moves (sigma re-fits to the bounding box otherwise).
    try { if (!renderer.getCustomBBox()) renderer.setCustomBBox(renderer.getBBox()); } catch (err) {}
  });
  const mouse = renderer.getMouseCaptor();
  mouse.on('mousemovebody', (e) => {
    if (!dragged) return;
    const pos = renderer.viewportToGraph(e);
    graph.mergeNodeAttributes(dragged, { x: pos.x, y: pos.y, fixed: true });
    moved = true;
    e.preventSigmaDefault();
    if (e.original) { e.original.preventDefault(); e.original.stopPropagation(); }
  });
  mouse.on('mouseup', () => { dragged = null; });
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
  if ($fit) $fit.addEventListener('click', () => { try { renderer.getCamera().animatedReset(); } catch (e) {} });
  const $labels = $('gr-labels');
  const paintLabels = () => {
    if ($labels) { $labels.setAttribute('aria-pressed', allLabels ? 'true' : 'false'); $labels.textContent = allLabels ? 'All labels' : 'Fewer labels'; }
    renderer.setSetting('labelDensity', allLabels ? 50 : 0.5);
  };
  paintLabels();
  if ($labels) $labels.addEventListener('click', () => { allLabels = !allLabels; store.set('labels', allLabels ? 'all' : 'few'); paintLabels(); });
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
    $hits.innerHTML = hits.map((h, i) => '<button type="button" role="option" data-i="' + i + '"' + (i === hitOn ? ' class="on"' : '') + '><i class="gr-dot" style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' + esc(COLOR[h.cat] || '#888') + '"></i><span class="nm">' + esc(h.label) + '</span><span class="sub">' + esc(h.sub || CAT_NAME[h.cat] || '') + '</span></button>').join('');
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

  // -- start --
  legend();
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
      "DJs, artists, sets, sources, tracks and remixes as one graph, drawn from the cached library. Click a node to see it and its neighbours.",
    body: BODY,
    css: CSS,
    js: JS,
  }),
};
