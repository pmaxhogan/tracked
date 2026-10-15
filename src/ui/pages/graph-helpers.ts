// Graph page helpers: the pure pieces of the page script (label lines and the
// fit inside a node, per-category display settings, ForceAtlas2 settings, pin
// weights, the settle test), kept apart so vitest can run them in a vm context
// (test/graph-helpers.test.ts). The string is concatenated into the page script
// (src/ui/pages/graph.ts) and defines one global, GRK.
//
// Same rules as every page script: no backticks and no dollar-brace inside,
// every regex backslash doubled.

export const GRAPH_HELPERS_JS = /* js */ `
const GRK = (() => {
  const ELLIPSIS = '\\u2026';
  const CATS = ['dj', 'artist', 'source', 'set', 'track', 'remix'];
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  const parse = (raw) => { if (!raw) return null; try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : null; } catch (e) { return null; } };

  // -- labels --
  // The lines drawn inside a node: tracks and remixes are title then artist,
  // a set "DJ @ Event" is the event then the DJ, everything else its name.
  function labelLines(cat, label, sub) {
    const main = String(label == null ? '' : label).trim();
    const second = sub == null ? '' : String(sub).trim();
    if (cat === 'track' || cat === 'remix') return second ? [main, second] : [main];
    if (cat === 'set') {
      const at = main.indexOf(' @ ');
      if (at > 0 && at < main.length - 3) return [main.slice(at + 3).trim(), main.slice(0, at).trim()];
    }
    return [main];
  }
  // The longest prefix of text that fits maxW at px, with an ellipsis; '' when not even one letter fits.
  function truncate(measure, text, px, maxW) {
    if (measure(text, px) <= maxW) return text;
    let lo = 0, hi = text.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (measure(text.slice(0, mid).trimEnd() + ELLIPSIS, px) <= maxW) lo = mid; else hi = mid - 1;
    }
    return lo > 0 ? text.slice(0, lo).trimEnd() + ELLIPSIS : '';
  }
  const MIN_R = 10, MIN_PX = 7;
  // Lays the lines out inside a circle of radius r (screen pixels): each line is
  // shrunk a little to fit, then cut with an ellipsis. Null when the node is too
  // small to hold readable text (zoomed out): the label is not drawn at all.
  // measure(text, px) is the text width at that font size.
  function fitLabel(measure, lines, r) {
    if (!(r >= MIN_R) || !lines || !lines[0]) return null;
    const two = lines.length > 1 && lines[1];
    let px1 = clamp(Math.round(r * (two ? 0.36 : 0.42)), MIN_PX, 15);
    let px2 = Math.round(px1 * 0.82);
    const useSub = two && px2 >= MIN_PX - 1 && r >= MIN_R * 1.6;
    const gap = Math.max(1, Math.round(px1 * 0.15));
    const h = useSub ? px1 + gap + px2 : px1;
    const rows = useSub ? [{ text: lines[0], px: px1, y: -h / 2 + px1 / 2, main: true }, { text: lines[1], px: px2, y: h / 2 - px2 / 2, main: false }] : [{ text: lines[0], px: px1, y: 0, main: true }];
    const out = [];
    for (const row of rows) {
      const far = Math.abs(row.y) + row.px / 2;
      if (far >= r) return out.length ? out : null;
      const maxW = 2 * Math.sqrt(r * r - far * far) * 0.9 - 2;
      let px = row.px, text = row.text;
      const w = measure(text, px);
      if (w > maxW) {
        const scaled = Math.floor((px * maxW) / w);
        if (scaled >= Math.max(MIN_PX - (row.main ? 0 : 1), px * 0.75)) px = scaled;
        else { px = Math.max(MIN_PX - (row.main ? 0 : 1), Math.round(px * 0.85)); text = truncate(measure, text, px, maxW); }
      }
      // A main line cut to two letters or fewer says nothing: no label.
      if (!text || (row.main && text.length <= 3 && text !== row.text)) { if (row.main) return null; continue; }
      out.push({ text: text, px: px, y: row.y, main: row.main });
    }
    return out.length ? out : null;
  }
  // Text color on a node: near-black on light fills, white on dark ones.
  function textOn(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
    if (!m) return '#ffffff';
    const lin = (c) => { const v = parseInt(c, 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const L = 0.2126 * lin(m[1]) + 0.7152 * lin(m[2]) + 0.0722 * lin(m[3]);
    return L > 0.36 ? '#111111' : '#ffffff';
  }

  // -- display: per category visible, label, size and color --
  const SIZE_STEPS = 8;
  // Slider step (-8..8) to a size multiplier: 0.25x .. 4x, 1x in the middle, even steps on a log scale.
  const sizeMult = (step) => Math.pow(2, clamp(Math.round(num(Number(step), 0)), -SIZE_STEPS, SIZE_STEPS) / 4);
  const multLabel = (step) => { const m = sizeMult(step); return (m >= 1 ? m.toFixed(m % 1 ? 2 : 0) : m.toFixed(2)).replace(/\\.?0+$/, '') + 'x'; };
  const displayDefault = () => { const o = {}; for (const c of CATS) o[c] = { show: true, label: true, size: 0, color: '' }; return o; };
  // The stored display settings, sanitized; the older hidden list (tk-graph:hidden) seeds "show" when nothing is stored yet.
  function readDisplay(raw, legacyHidden) {
    const d = displayDefault();
    const v = parse(raw);
    if (!v) {
      for (const c of String(legacyHidden || '').split(',')) if (d[c]) d[c].show = false;
      return d;
    }
    for (const c of CATS) {
      const x = v[c];
      if (!x || typeof x !== 'object') continue;
      if (typeof x.show === 'boolean') d[c].show = x.show;
      if (typeof x.label === 'boolean') d[c].label = x.label;
      if (typeof x.size === 'number' && isFinite(x.size)) d[c].size = clamp(Math.round(x.size), -SIZE_STEPS, SIZE_STEPS);
      if (typeof x.color === 'string' && /^#[0-9a-f]{6}$/i.test(x.color)) d[c].color = x.color.toLowerCase();
    }
    return d;
  }

  // -- layout: ForceAtlas2 knobs --
  // Defaults tuned on seeded libraries of 1,000 and 3,000 nodes (DJs -> sets -> tracks):
  // strong gravity, weak (plain gravity lets small loose components drift so far
  // that Fit shrinks the main cluster to a dot), no outbound attraction
  // distribution (it divides a pinned node's pull by its mass), a pinned node
  // pulls its neighbours as hard as all their other links together (pinPull 1),
  // and spread 10 with the no-overlap finish so the names inside nodes stay
  // readable.
  const LAYOUT_FIELDS = [
    { key: 'gravity', label: 'Gravity', min: 0, max: 2, step: 0.01, def: 0.05, tip: 'Pull toward the middle. Higher keeps loose parts close and the graph rounder.' },
    { key: 'strongGravityMode', label: 'Strong gravity', bool: true, def: true, tip: 'Gravity grows with distance, so small loose parts stay near the rest instead of drifting off.' },
    { key: 'scalingRatio', label: 'Spread', min: 0.5, max: 50, step: 0.5, def: 10, tip: 'How hard nodes push each other apart (scalingRatio). Higher spreads the graph out.' },
    { key: 'slowDown', label: 'Slow down', min: 1, max: 30, step: 0.5, def: 2, tip: 'Damping. Higher moves calmer but settles later.' },
    { key: 'linLogMode', label: 'LinLog', bool: true, def: false, tip: 'Logarithmic attraction: tighter clusters, more space between them.' },
    { key: 'outboundAttractionDistribution', label: 'Spread hubs', bool: true, def: false, tip: 'Hubs (DJs, big sets) attract less, so they move to the edge of their cluster (outboundAttractionDistribution). Also weakens the pull of pinned nodes.' },
    { key: 'adjustSizes', label: 'No overlap', bool: true, def: true, tip: 'Once the layout settles, a last pass pushes overlapping nodes apart (adjustSizes), so the names inside them stay readable.' },
    { key: 'barnesHut', label: 'Barnes-Hut', choice: ['auto', 'on', 'off'], def: 'auto', tip: 'Approximate far repulsion: much faster on big graphs. Auto turns it on from 500 nodes.' },
    { key: 'barnesHutTheta', label: 'Barnes-Hut theta', min: 0.1, max: 1.5, step: 0.05, def: 0.6, tip: 'Approximation level: higher is faster and rougher.' },
    { key: 'edgeWeightInfluence', label: 'Edge weight', min: 0, max: 2, step: 0.1, def: 1, tip: 'How much link weight counts (pinned links are heavier).' },
    { key: 'pinPull', label: 'Pin pull', min: 0, max: 3, step: 0.25, def: 1, tip: 'How hard a pinned node pulls its neighbours: 1 is as hard as all their other links together, 0 is a plain link.' },
  ];
  const layoutDefault = () => { const o = {}; for (const f of LAYOUT_FIELDS) o[f.key] = f.def; return o; };
  function readLayout(raw) {
    const d = layoutDefault();
    const v = parse(raw);
    if (!v) return d;
    for (const f of LAYOUT_FIELDS) {
      const x = v[f.key];
      if (f.bool) { if (typeof x === 'boolean') d[f.key] = x; }
      else if (f.choice) { if (f.choice.indexOf(x) >= 0) d[f.key] = x; }
      else if (typeof x === 'number' && isFinite(x)) d[f.key] = clamp(x, f.min, f.max);
    }
    return d;
  }
  // The settings object FA2 takes, from the page's layout settings, the graph size
  // and the phase. "No overlap" (adjustSizes) is a finishing phase: FA2's
  // anti-collision mode caps every step, so running it from the start leaves a
  // dragged node's neighbours crawling. The page lays out in the 'main' phase,
  // then switches to 'overlap' once that settles (a live switch, no restart).
  function fa2Settings(l, order, phase) {
    return {
      gravity: l.gravity,
      strongGravityMode: !!l.strongGravityMode,
      scalingRatio: l.scalingRatio,
      slowDown: l.slowDown,
      linLogMode: !!l.linLogMode,
      outboundAttractionDistribution: !!l.outboundAttractionDistribution,
      adjustSizes: !!l.adjustSizes && phase === 'overlap',
      barnesHutOptimize: l.barnesHut === 'on' || (l.barnesHut === 'auto' && order >= 500),
      barnesHutTheta: l.barnesHutTheta,
      edgeWeightInfluence: l.edgeWeightInfluence,
    };
  }

  // -- pins --
  // A link to a pinned node weighs as much as the other node's other links
  // together (times pinPull), so a pinned node visibly gathers its neighbours
  // even when they are hubs held by many links. Other links weigh 1.
  const pinWeight = (pull, otherDegree) => 1 + Math.max(0, num(pull, 1)) * Math.max(0, otherDegree - 1);
  function edgeWeight(isPinned, degree, pull, s, t) {
    const ps = isPinned(s), pt = isPinned(t);
    if (ps === pt) return 1;
    return pinWeight(pull, degree(ps ? t : s));
  }

  // -- settle: the layout stops by itself once nodes barely move --
  // A node is moving when its last step was over eps of the graph's extent.
  // step(moving, total) is true after 'ticks' ticks in a row with at most
  // 'share' of the nodes moving, and never before 'minTicks' ticks: a few
  // jittering hubs do not keep a settled graph running, while neighbours still
  // gathering around a dragged node do.
  function makeSettle(opts) {
    const o = Object.assign({ eps: 0.002, share: 0.05, ticks: 30, minTicks: 60 }, opts || {});
    let calm = 0, n = 0;
    return {
      eps: o.eps,
      step(moving, total) { n++; if (moving <= o.share * Math.max(1, total)) calm++; else calm = 0; return n >= o.minTicks && calm >= o.ticks; },
      reset() { calm = 0; n = 0; },
    };
  }

  return { CATS, ELLIPSIS, labelLines, truncate, fitLabel, textOn, SIZE_STEPS, sizeMult, multLabel, displayDefault, readDisplay, LAYOUT_FIELDS, layoutDefault, readLayout, fa2Settings, pinWeight, edgeWeight, makeSettle };
})();
`;
