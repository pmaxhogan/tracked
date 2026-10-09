// Stats: every count the app keeps, as a dense grid of cards and charts
// (GET /ui/api/stats, lib/stats.ts). Charts are hand-drawn SVG sized to their
// card (redrawn on resize); every chart has a hover tooltip and its numbers in
// a "Data" table. Colors: the validated categorical palette (dataviz skill),
// dark steps by default, light steps under the light theme; text never wears
// a series color.
//
// Page scripts are template literals: no backticks and no dollar-brace inside,
// and every regex backslash is doubled. Upstream text only through TK.esc.
import { shell } from '../shell'
import { tipAttr } from '../tip'
import type { UiPage } from './index'

const CSS = /* css */ `
  .st-root {
    --c1: #3987e5; --c2: #d95926; --c3: #199e70; --c4: #c98500; --c-rest: var(--line-strong);
  }
  @media (prefers-color-scheme: light) { :root:where(:not([data-theme="dark"])) .st-root { --c1: #2a78d6; --c2: #eb6834; --c3: #1baf7a; --c4: #eda100; } }
  :root[data-theme="light"] .st-root { --c1: #2a78d6; --c2: #eb6834; --c3: #1baf7a; --c4: #eda100; }
  .st-bar { display: flex; align-items: center; gap: var(--sp-3); margin-bottom: var(--sp-3); color: var(--muted); font-size: var(--fs-sm); flex-wrap: wrap; }
  .st-bar .grow { flex: 1; }
  /* One dense grid per section, so a tile never fills a hole in another section. */
  .st-grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); grid-auto-flow: row dense; margin-bottom: var(--sp-4); }
  .st-sec { margin: 0 0 var(--sp-2); font-size: var(--fs-xs); font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--subtle); }
  .st-card { background: var(--card); border: 1px solid var(--line); border-radius: var(--r-card); padding: 12px 14px; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
  .st-card.s2 { grid-column: span 2; } .st-card.s3 { grid-column: span 3; } .st-card.s4 { grid-column: span 4; }
  @media (max-width: 760px) { .st-card.s3, .st-card.s4 { grid-column: 1 / -1; } }
  @media (max-width: 380px) { .st-card.s2 { grid-column: 1 / -1; } }
  .st-h { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .st-t { font-size: var(--fs-xs); font-weight: 600; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .st-tot { font-size: var(--fs-xs); color: var(--subtle); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .st-big { font-size: var(--fs-2xl); font-weight: 700; color: var(--fg); line-height: 1.1; font-variant-numeric: tabular-nums; }
  .st-sub { font-size: var(--fs-xs); color: var(--muted); }
  .st-chart { position: relative; min-height: 40px; }
  .st-chart svg { display: block; width: 100%; overflow: visible; }
  .st-axis { fill: var(--subtle); font-size: 10px; font-variant-numeric: tabular-nums; }
  .st-grid-line { stroke: var(--line); stroke-width: 1; }
  .st-guide { stroke: var(--muted); stroke-width: 1; visibility: hidden; }
  .st-chart:hover .st-guide.on { visibility: visible; }
  .st-legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: var(--fs-xs); color: var(--muted); }
  .st-legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 5px; vertical-align: -1px; }
  .st-seg { display: flex; gap: 2px; height: 14px; border-radius: 4px; overflow: hidden; }
  .st-seg span { display: block; min-width: 2px; }
  .st-hb { display: grid; grid-template-columns: minmax(0, 40%) 1fr auto; gap: 4px 8px; align-items: center; font-size: var(--fs-xs); }
  .st-hb .l { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .st-hb .b { height: 10px; background: var(--elev); border-radius: 0 4px 4px 0; overflow: hidden; display: flex; gap: 2px; }
  .st-hb .b span { display: block; height: 100%; }
  .st-hb .b span:last-child { border-radius: 0 4px 4px 0; }
  .st-hb .v { color: var(--fg); font-variant-numeric: tabular-nums; text-align: right; }
  .st-data summary { font-size: var(--fs-xs); color: var(--subtle); cursor: pointer; width: fit-content; }
  .st-data table { width: 100%; font-size: var(--fs-xs); border-collapse: collapse; margin-top: 4px; }
  .st-data td, .st-data th { padding: 2px 6px; border-bottom: 1px solid var(--line); text-align: left; font-variant-numeric: tabular-nums; }
  .st-data .scroll { max-height: 220px; overflow: auto; }
  .st-list { margin: 0; padding: 0; list-style: none; font-size: var(--fs-sm); display: grid; gap: 4px; }
  .st-list li { display: flex; gap: 8px; align-items: baseline; min-width: 0; }
  .st-list .n { font-weight: 700; font-variant-numeric: tabular-nums; min-width: 3.5em; text-align: right; color: var(--fg); }
  .st-list .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); }
  .st-list a { color: inherit; text-decoration: none; } .st-list a:hover { text-decoration: underline; }
  .st-none { color: var(--subtle); font-size: var(--fs-xs); }
  #st-tip { position: fixed; z-index: 50; pointer-events: none; background: var(--elev); color: var(--fg); border: 1px solid var(--line-strong); border-radius: 6px; padding: 4px 8px; font-size: var(--fs-xs); box-shadow: var(--shadow-float); white-space: pre; font-variant-numeric: tabular-nums; }
`

const BODY = /* html */ `
<div class="st-root">
  <div class="st-bar"><span id="st-when" class="grow" role="status">Loading…</span><button type="button" id="st-refresh" class="btn small"${tipAttr('Recompute now (the numbers are otherwise up to 5 minutes old).')}>Refresh</button></div>
  <div id="st-grid" aria-live="polite"></div>
  <div id="st-tip" hidden></div>
</div>
`

const JS = /* js */ `
(() => {
  const $ = TK.$, esc = TK.esc;
  const $grid = $('st-grid'), $when = $('st-when'), $tip = $('st-tip');
  let data = null;
  const C = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)'];
  const REST = 'var(--c-rest)';
  const nf = (n) => (n == null ? '\\u2013' : Number(n).toLocaleString());
  const cf = (n) => { if (n == null) return '\\u2013'; const a = Math.abs(n); return a >= 1e6 ? (n / 1e6).toFixed(1).replace(/[.]0$/, '') + 'M' : a >= 1e4 ? Math.round(n / 1e3) + 'k' : a >= 1e3 ? (n / 1e3).toFixed(1).replace(/[.]0$/, '') + 'k' : String(Math.round(n)); };
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '\\u2013');
  const sum = (xs) => xs.reduce((n, x) => n + (Number(x) || 0), 0);
  const short = (d) => { const p = String(d).split('-'); return p.length === 3 ? Number(p[1]) + '/' + Number(p[2]) : String(d); };
  const niceMax = (v) => { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); const f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };
  const tipAttrOf = (s) => ' data-t="' + esc(s) + '"';

  // ── panels ──
  // Every panel is { cls, title, total, body(width) -> html, table: [head, rows] }.
  const panels = [];
  const sec = (title) => panels.push({ sec: title });
  const tile = (title, value, sub, o) => panels.push(Object.assign({ cls: '', title, tile: true, value, sub }, o || {}));
  const chart = (cls, title, total, body, table, legend) => panels.push({ cls, title, total, body, table, legend });

  function legendHtml(items) { return '<div class="st-legend">' + items.map((it, i) => '<span><i style="background:' + (it.color || C[i]) + '"></i>' + esc(it.label) + '</span>').join('') + '</div>'; }
  function tableHtml(t) {
    if (!t) return '';
    return '<details class="st-data"><summary>Data</summary><div class="scroll"><table><thead><tr>' + t[0].map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' +
      t[1].map((r) => '<tr>' + r.map((c) => '<td>' + esc(typeof c === 'number' ? nf(c) : String(c == null ? '' : c)) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div></details>';
  }

  // Vertical bars over days (stacked when several series). series: [{ label, values: [[day, n]] }]
  function bars(series, w, o) {
    o = o || {};
    const H = o.h || 110, padL = 30, padB = 16, top = 6;
    const n = series[0].values.length;
    const totals = series[0].values.map((_, i) => sum(series.map((s) => s.values[i][1])));
    const max = niceMax(Math.max.apply(null, totals.concat([1])));
    const iw = Math.max(10, w - padL), bw = iw / n, gap = bw > 6 ? 2 : bw > 3 ? 1 : 0;
    const y = (v) => top + (H - top - padB) * (1 - v / max);
    let s = '<svg viewBox="0 0 ' + w + ' ' + H + '" height="' + H + '" role="img">';
    for (const g of [0, 0.5, 1]) s += '<line class="st-grid-line" x1="' + padL + '" x2="' + w + '" y1="' + y(max * g) + '" y2="' + y(max * g) + '"/><text class="st-axis" x="' + (padL - 4) + '" y="' + (y(max * g) + 3) + '" text-anchor="end">' + cf(max * g) + '</text>';
    for (let i = 0; i < n; i++) {
      const x = padL + i * bw;
      let base = 0;
      const lines = [series[0].values[i][0]];
      series.forEach((sr, k) => {
        const v = sr.values[i][1];
        if (series.length > 1) lines.push(sr.label + ': ' + nf(v));
        if (v > 0) {
          const y0 = y(base), y1 = y(base + v);
          const hgt = Math.max(1, y0 - y1 - (base > 0 ? 2 : 0));
          s += '<rect x="' + (x + gap / 2) + '" y="' + y1 + '" width="' + Math.max(1, bw - gap) + '" height="' + hgt + '" rx="' + (bw > 8 ? 2 : 0) + '" fill="' + (sr.color || C[k]) + '"/>';
        }
        base += v;
      });
      if (series.length === 1) lines[0] += ': ' + nf(totals[i]);
      else lines.push('total: ' + nf(totals[i]));
      s += '<rect x="' + x + '" y="0" width="' + bw + '" height="' + (H - padB) + '" fill="transparent"' + tipAttrOf(lines.join('\\n')) + '/>';
    }
    const ticks = o.labels || [0, Math.floor(n / 2), n - 1];
    for (const i of ticks) s += '<text class="st-axis" x="' + (padL + i * bw + bw / 2) + '" y="' + (H - 3) + '" text-anchor="middle">' + esc(o.fmtX ? o.fmtX(series[0].values[i][0]) : short(series[0].values[i][0])) + '</text>';
    return s + '</svg>';
  }

  // Lines on one axis. series: [{ label, points: [[x(label), n]] }], all the same x.
  function lines(series, w, o) {
    o = o || {};
    const H = o.h || 130, padL = 34, padB = 16, top = 8;
    const n = series[0].points.length;
    if (n < 2) return '<p class="st-none">Not enough history yet: a point is kept every hour.</p>';
    const all = [].concat.apply([], series.map((s) => s.points.map((p) => p[1])));
    const max = niceMax(Math.max.apply(null, all.concat([1])));
    const min = o.zero === false ? Math.min.apply(null, all) : 0;
    const iw = Math.max(10, w - padL);
    const x = (i) => padL + (iw * i) / (n - 1);
    const y = (v) => top + (H - top - padB) * (1 - (v - min) / Math.max(1, max - min));
    let s = '<svg viewBox="0 0 ' + w + ' ' + H + '" height="' + H + '" role="img">';
    for (const g of [0, 0.5, 1]) { const v = min + (max - min) * g; s += '<line class="st-grid-line" x1="' + padL + '" x2="' + w + '" y1="' + y(v) + '" y2="' + y(v) + '"/><text class="st-axis" x="' + (padL - 4) + '" y="' + (y(v) + 3) + '" text-anchor="end">' + cf(v) + '</text>'; }
    series.forEach((sr, k) => {
      const d = sr.points.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p[1]).toFixed(1)).join(' ');
      if (series.length === 1 && o.area !== false) s += '<path d="' + d + ' L' + x(n - 1) + ' ' + y(min) + ' L' + x(0) + ' ' + y(min) + ' Z" fill="' + (sr.color || C[k]) + '" opacity=".14"/>';
      s += '<path d="' + d + '" fill="none" stroke="' + (sr.color || C[k]) + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
    });
    s += '<line class="st-guide" y1="' + top + '" y2="' + (H - padB) + '"/>';
    const cw = iw / Math.max(1, n - 1);
    for (let i = 0; i < n; i++) {
      const txt = [o.fmtX ? o.fmtX(series[0].points[i][0]) : series[0].points[i][0]].concat(series.map((sr) => (series.length > 1 ? sr.label + ': ' : '') + nf(sr.points[i][1]))).join('\\n');
      s += '<rect x="' + (x(i) - cw / 2) + '" y="0" width="' + cw + '" height="' + (H - padB) + '" fill="transparent" data-gx="' + x(i) + '"' + tipAttrOf(txt) + '/>';
    }
    for (const i of [0, n - 1]) s += '<text class="st-axis" x="' + x(i) + '" y="' + (H - 3) + '" text-anchor="' + (i ? 'end' : 'start') + '">' + esc(o.fmtX ? o.fmtX(series[0].points[i][0]) : short(series[0].points[i][0])) + '</text>';
    return s + '</svg>';
  }

  // One whole split into parts (a single stacked bar), with a legend.
  function seg(parts) {
    const total = sum(parts.map((p) => p.value));
    if (!total) return '<p class="st-none">Nothing yet.</p>';
    return '<div class="st-seg">' + parts.filter((p) => p.value > 0).map((p, i) => '<span style="flex:' + p.value + ';background:' + (p.color || C[parts.indexOf(p)] || REST) + '"' + tipAttrOf(p.label + ': ' + nf(p.value) + ' (' + pct(p.value, total) + ')') + '></span>').join('') + '</div>' +
      legendHtml(parts.map((p, i) => ({ label: p.label + ' ' + cf(p.value) + ' \\u00b7 ' + pct(p.value, total), color: p.color || C[i] || REST })));
  }

  // Horizontal bars: rows [{ label, value, parts?: [{ value, color, label }] }].
  function hbars(rows, o) {
    o = o || {};
    rows = rows.slice(0, o.max || 12);
    if (!rows.length) return '<p class="st-none">Nothing yet.</p>';
    const max = Math.max.apply(null, rows.map((r) => r.value).concat([1]));
    return '<div class="st-hb">' + rows.map((r) => {
      const parts = r.parts || [{ value: r.value, color: o.color || C[0], label: r.label }];
      const tip = r.tip || (r.label + ': ' + nf(r.value));
      return '<span class="l"' + tipAttrOf(r.label) + '>' + esc(r.label) + '</span><span class="b"' + tipAttrOf(tip) + '>' +
        parts.filter((p) => p.value > 0).map((p) => '<span style="width:' + ((p.value / max) * 100).toFixed(2) + '%;background:' + p.color + '"></span>').join('') +
        '</span><span class="v">' + esc(o.fmtV ? o.fmtV(r) : nf(r.value)) + '</span>';
    }).join('') + '</div>';
  }

  const daysTable = (series) => [['Day'].concat(series.map((s) => s.label)), series[0].values.map((v, i) => [v[0]].concat(series.map((s) => s.values[i][1]))).reverse()];
  const listTable = (l, a, b) => [[a || 'Kind', b || 'Count'], l.map((x) => [x.label, x.value])];
  const last = (sr, n) => sum(sr.slice(-n).map((x) => x[1]));
  const dailyChart = (cls, title, series, totalLabel) => chart(cls, title, totalLabel, (w) => bars(series, w), daysTable(series), series.length > 1 ? series.map((s, i) => ({ label: s.label, color: s.color || C[i] })) : null);

  function build(d) {
    panels.length = 0;
    const c = d.cards, b = d.breakdowns, dl = d.daily;
    const snaps = d.snapshots || [];
    const snapSeries = (key) => snaps.filter((s) => s.data[key] != null).map((s) => [s.at, s.data[key]]);
    const atLabel = (at) => new Date(at * 1000).toISOString().slice(5, 13).replace('T', ' ') + 'h';

    sec('Overview');
    tile('DJs followed', c.djs, null, { spark: d.djsOverTime.map((x) => x[1]) });
    tile('Sets known', c.sets, nf(c.setsProcessed) + ' synced');
    tile('Sets with a video', c.setsWithVideo, pct(c.setsWithVideo, c.sets) + ' of sets');
    tile('Verified track lists', c.setsVerified, nf(c.setsPending) + ' waiting for a 2nd fetch');
    tile('Searchable sets', c.searchSets, pct(c.searchSets, c.sets) + ' of sets');
    tile('Searchable tracks', c.searchTracks, nf(c.searchTracksYoutube) + ' with a YouTube link');
    tile('Videos in playlists', c.playlistVideos, nf(c.playlists) + ' playlists');
    tile('mkvid uploads', c.mkvidDone, nf(c.mkvidPending) + ' queued');
    tile('Pre-saves watching', c.presavesWatching, nf(c.presavesFound + c.presavesUploaded) + ' on YouTube');
    tile('Pre-save candidates', c.candidates, nf(c.candidatePresaves) + ' Spotify pre-saves');
    tile('Fetching accounts', c.poolAccounts, d.pool.ok ? 'tlpool' : 'tlpool: ' + (d.pool.error || 'unavailable'));
    tile('Page views today', c.poolRequestsToday, c.poolBudgetToday != null ? 'of ' + nf(c.poolBudgetToday) + ' budget (' + pct(c.poolRequestsToday, c.poolBudgetToday) + ')' : '');

    sec('Library');
    const cov = [['Sets known', 'sets'], ['With a video', 'setsWithVideo'], ['Verified', 'setsVerified'], ['Searchable', 'searchSets']].map((p, i) => ({ label: p[0], points: snapSeries(p[1]) }));
    chart('s4', 'Coverage over time', snaps.length ? snaps.length + ' hourly points' : 'starts now', (w) => cov[0].points.length >= 2 ? lines(cov, w, { fmtX: atLabel, area: false }) : '<p class="st-none">Not enough history yet: a point is kept every hour, so this fills in over the next hours.</p>',
      [['Hour'].concat(cov.map((s) => s.label)), cov[0].points.map((p, i) => [atLabel(p[0])].concat(cov.map((s) => (s.points[i] ? s.points[i][1] : '')))).reverse()], cov.map((s, i) => ({ label: s.label, color: C[i] })));
    chart('s2', 'Where set videos come from', nf(c.sets) + ' sets', () => seg(b.videoSources.map((p, i) => ({ label: p.label, value: p.value, color: i < 3 ? C[i] : REST }))), listTable(b.videoSources, 'Source'));
    chart('s2', 'Track list verification', null, () => seg(b.verification.concat([{ label: 'never verified', value: Math.max(0, c.sets - sum(b.verification.map((x) => x.value))) }]).map((p, i) => ({ label: p.label, value: p.value, color: i < 2 ? C[i] : REST }))), listTable(b.verification, 'State'));
    dailyChart('s2', 'Sets found per day', [{ label: 'Sets', values: dl.discovered }], nf(last(dl.discovered, 7)) + ' in 7 days');
    dailyChart('s2', 'Track lists verified per day', [{ label: 'Verified', values: dl.verified }], nf(last(dl.verified, 7)) + ' in 7 days');
    chart('s2', 'DJs followed over time', nf(c.djs) + ' DJs', (w) => lines([{ label: 'DJs', points: d.djsOverTime }], w, { h: 110 }), [['Day', 'DJs'], d.djsOverTime.slice().reverse()]);
    const years = b.setYears.filter((y) => /^[0-9]{4}$/.test(y.label));
    chart('s2', 'Sets by year played', null, (w) => years.length ? bars([{ label: 'Sets', values: years.map((y) => [y.label, y.value]) }], w, { fmtX: (x) => x, labels: [0, Math.floor((years.length - 1) / 2), years.length - 1] }) : '<p class="st-none">Nothing yet.</p>', listTable(b.setYears, 'Year'));
    const djRows = b.setsPerDj.map((r) => ({ label: r.name, value: r.sets, parts: [{ value: r.searchable, color: C[0] }, { value: Math.max(0, r.sets - r.searchable), color: REST }], tip: r.name + ': ' + nf(r.sets) + ' sets\\nsearchable ' + nf(r.searchable) + ' (' + pct(r.searchable, r.sets) + ')\\nwith a video ' + nf(r.withVideo) }));
    chart('s4', 'Sets per DJ', b.setsPerDj.length + ' DJs', () => hbars(djRows, { max: 30, fmtV: (r) => nf(r.value) + ' \\u00b7 ' + pct(r.parts[0].value, r.value) }),
      [['DJ', 'Sets', 'Searchable', 'With a video'], b.setsPerDj.map((r) => [r.name, r.sets, r.searchable, r.withVideo])], [{ label: 'searchable', color: C[0] }, { label: 'not yet', color: REST }]);

    sec('Search index');
    tile('Track \\u2194 set links', c.searchLinks, 'every track in every indexed set');
    tile('Vocabulary terms', c.searchVocab, 'for typo correction');
    tile('Thumbnails known', c.searchImages, 'artwork and set images');
    tile('Tracks with YouTube', c.searchTracksYoutube, pct(c.searchTracksYoutube, c.searchTracks) + ' of searchable tracks');
    dailyChart('s2', 'Sets indexed per day', [{ label: 'Indexed', values: dl.indexed }], nf(last(dl.indexed, 7)) + ' in 7 days');
    chart('s2', 'Index source', null, () => seg(b.searchSources.map((p, i) => ({ label: p.label === 'page' ? 'set page' : p.label === 'mkvid' ? 'mkvid list' : p.label, value: p.value, color: C[i] }))), listTable(b.searchSources, 'Source'));
    const lowest = b.setsPerDj.filter((r) => r.sets >= 5).map((r) => ({ label: r.name, value: r.sets ? Math.round((r.searchable / r.sets) * 100) : 0, tip: r.name + ': ' + nf(r.searchable) + ' of ' + nf(r.sets) + ' searchable' })).sort((a, b2) => a.value - b2.value);
    chart('s2', 'Least searchable DJs', 'share of their sets', () => hbars(lowest, { max: 10, fmtV: (r) => r.value + '%' }), [['DJ', '% searchable'], lowest.map((r) => [r.label, r.value + '%'])]);

    sec('Playlists');
    tile('Playlists', c.playlists, 'one per DJ');
    tile('Removed videos', c.removedVideos, 'taken out of playlists');
    dailyChart('s2', 'Videos added to playlists per day', [{ label: 'Added', values: dl.playlistAdds }], nf(last(dl.playlistAdds, 7)) + ' in 7 days');
    dailyChart('s2', 'Videos removed from playlists per day', [{ label: 'Removed', values: dl.playlistRemovals }], nf(last(dl.playlistRemovals, 7)) + ' in 7 days');
    chart('s2', 'Playlist insert outcomes', 'last ' + d.days + ' days', () => hbars(b.playlistAdds.map((x) => ({ label: x.label, value: x.value }))), listTable(b.playlistAdds, 'Outcome'));
    chart('s2', 'Why videos were removed', null, () => hbars(b.removedReasons.map((x) => ({ label: x.label.replace(/_/g, ' '), value: x.value }))), listTable(b.removedReasons, 'Reason'));

    sec('mkvid');
    tile('Uploaded', c.mkvidDone, nf(last(dl.mkvidDone, 7)) + ' in 7 days');
    tile('Queued', c.mkvidPending, 'waiting or rendering');
    tile('Failed', c.mkvidFailed, 'can be retried');
    tile('Banned', c.mkvidBanned, 'sources refused');
    dailyChart('s3', 'mkvid results per day', [{ label: 'Uploaded', values: dl.mkvidDone }, { label: 'Failed', values: dl.mkvidFailed }], nf(last(dl.mkvidDone, 7)) + ' uploaded in 7 days');
    dailyChart('s2', 'Sets queued for mkvid per day', [{ label: 'Queued', values: dl.mkvidQueued }], nf(last(dl.mkvidQueued, 7)) + ' in 7 days');
    chart('s1', 'Uploads by account', null, () => seg(b.mkvidAccount.map((p, i) => ({ label: p.label, value: p.value, color: C[i] }))), listTable(b.mkvidAccount, 'Account'));
    chart('s2', 'Uploads by audio source', null, () => hbars(b.mkvidSource.map((x) => ({ label: x.label, value: x.value }))), listTable(b.mkvidSource, 'Source'));
    chart('s2', 'All requests by status', null, () => hbars(b.mkvidStatus.map((x) => ({ label: x.label, value: x.value }))), listTable(b.mkvidStatus, 'Status'));

    sec('Pre-saves');
    tile('Found on YouTube', c.presavesFound, 'by 1001tracklists');
    tile('Ripped by mkvid', c.presavesUploaded, nf(c.trackUploadsPending) + ' track uploads queued');
    tile('Top candidate', c.candidateTop, 'Spotify pre-saves on one track');
    tile('ID candidates', c.candidateIds, 'unidentified rows with pre-saves');
    dailyChart('s2', 'Pre-saves per day', [{ label: 'Added', values: dl.presavesAdded }, { label: 'Found', values: dl.presavesFound }], nf(last(dl.presavesAdded, 7)) + ' added in 7 days');
    dailyChart('s2', 'New candidates per day', [{ label: 'First seen', values: dl.candidatesSeen }], nf(last(dl.candidatesSeen, 7)) + ' in 7 days');
    chart('s2', 'Most pre-saved candidates', 'Spotify pre-saves', () => d.topCandidates.length ? '<ol class="st-list">' + d.topCandidates.slice(0, 8).map((t) => {
      const nm = t.isId && !t.title ? 'ID' : (t.artist || 'ID') + ' \\u2013 ' + (t.title || 'ID');
      const href = t.presaveId ? '/ui/presave?id=' + t.presaveId : '/ui/presaves?view=candidates';
      return '<li><span class="n">' + cf(t.count) + '</span><a class="nm" href="' + esc(href) + '"' + tipAttrOf(nm) + '>' + esc(nm) + '</a></li>';
    }).join('') + '</ol>' : '<p class="st-none">No candidates yet: they appear as verified sets are rechecked.</p>',
      [['Track', 'Pre-saves'], d.topCandidates.map((t) => [(t.artist || 'ID') + ' \\u2013 ' + (t.title || 'ID'), t.count])]);
    chart('s2', 'Pre-saves by stage', null, () => hbars(b.presaveStages.map((x) => ({ label: x.label, value: x.value }))), listTable(b.presaveStages, 'Stage'));
    chart('s2', 'Watched tracks are linked on', 'while waiting for YouTube', () => hbars(b.presaveLinkSources.map((x) => ({ label: x.label, value: x.value }))), listTable(b.presaveLinkSources, 'Site'));
    chart('s1', 'Track uploads', null, () => hbars(b.trackUploads.map((x) => ({ label: x.label, value: x.value }))), listTable(b.trackUploads, 'Status'));

    sec('Pool and scheduler');
    const kindTotals = {};
    for (const h of d.hourly) for (const k in h.kinds) kindTotals[k] = (kindTotals[k] || 0) + h.kinds[k];
    const topKinds = Object.keys(kindTotals).sort((a, b2) => kindTotals[b2] - kindTotals[a]).slice(0, 3);
    const hourSeries = topKinds.map((k) => ({ label: k.replace(/_/g, ' '), values: d.hourly.map((h) => [h.hour, h.kinds[k] || 0]) }))
      .concat([{ label: 'other', color: REST, values: d.hourly.map((h) => [h.hour, sum(Object.keys(h.kinds).filter((k) => topKinds.indexOf(k) < 0).map((k) => h.kinds[k]))]) }]);
    const hourFmt = (h) => String(h).slice(11, 13) + 'h';
    chart('s4', 'Scheduler fetches per hour (48 h)', nf(sum(d.hourly.map((h) => sum(Object.values(h.kinds))))) + ' run \\u00b7 ' + nf(sum(d.hourly.map((h) => h.stopped))) + ' refused',
      (w) => bars(hourSeries, w, { fmtX: hourFmt, labels: [0, 12, 24, 36, 47] }), daysTable(hourSeries), hourSeries.map((s, i) => ({ label: s.label, color: s.color || C[i] })));
    dailyChart('s2', 'Refused fetches per hour (48 h)', [{ label: 'Refused', values: d.hourly.map((h) => [h.hour, h.stopped]), color: C[1] }], null);
    panels[panels.length - 1].body = (w) => bars([{ label: 'Refused', values: d.hourly.map((h) => [h.hour, h.stopped]), color: C[1] }], w, { fmtX: hourFmt, labels: [0, 24, 47] });
    chart('s2', 'Account states', d.pool.ok ? null : 'tlpool unavailable', () => (d.pool.ok ? seg(b.poolStates.map((p, i) => ({ label: p.label, value: p.value, color: p.label === 'active' ? C[0] : p.label === 'warming' ? C[2] : REST }))) : '<p class="st-none">' + esc(d.pool.error || 'tlpool did not answer') + '</p>'), listTable(b.poolStates, 'State'));
    chart('s2', 'Page views today by priority', null, () => hbars(b.poolByPriority.map((x) => ({ label: x.label, value: x.value }))), listTable(b.poolByPriority, 'Priority'));
    dailyChart('s2', 'Pool events per day', [{ label: 'Events', values: dl.poolEvents }], nf(last(dl.poolEvents, 7)) + ' in 7 days');
    dailyChart('s2', 'Now-playing lookups per day', [{ label: 'Lookups', values: dl.nowPlaying }], nf(last(dl.nowPlaying, 7)) + ' in 7 days');
    chart('s2', 'Now-playing outcomes', 'last ' + d.days + ' days', () => hbars(b.nowPlaying.map((x) => ({ label: x.label.replace(/_/g, ' '), value: x.value }))), listTable(b.nowPlaying, 'Outcome'));
  }

  function spark(vals, w) {
    if (!vals || vals.length < 2) return '';
    const H = 26, max = Math.max.apply(null, vals), min = Math.min.apply(null, vals);
    const x = (i) => (w * i) / (vals.length - 1), y = (v) => 2 + (H - 4) * (1 - (v - min) / Math.max(1, max - min));
    return '<svg viewBox="0 0 ' + w + ' ' + H + '" height="' + H + '" aria-hidden="true"><path d="' + vals.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ') + '" fill="none" stroke="var(--c1)" stroke-width="2" stroke-linejoin="round"/></svg>';
  }

  function render() {
    if (!data || !$grid) return;
    build(data);
    // Pass 1: the cards with empty chart areas, to measure their widths.
    let open = false;
    $grid.innerHTML = panels.map((p, i) => {
      if (p.sec) { const h = (open ? '</div>' : '') + '<h2 class="st-sec">' + esc(p.sec) + '</h2><div class="st-grid">'; open = true; return h; }
      if (p.tile) return '<section class="st-card ' + p.cls + '" aria-label="' + esc(p.title) + '"><div class="st-h"><span class="st-t">' + esc(p.title) + '</span></div><div class="st-big">' + esc(p.value == null ? '\\u2013' : nf(p.value)) + '</div>' +
        (p.sub ? '<div class="st-sub">' + esc(p.sub) + '</div>' : '') + (p.spark ? '<div class="st-chart" id="st-c' + i + '"></div>' : '') + '</section>';
      return '<section class="st-card ' + p.cls + '" aria-label="' + esc(p.title) + '"><div class="st-h"><span class="st-t">' + esc(p.title) + '</span>' + (p.total ? '<span class="st-tot">' + esc(p.total) + '</span>' : '') + '</div>' +
        (p.legend ? legendHtml(p.legend) : '') + '<div class="st-chart" id="st-c' + i + '"></div>' + tableHtml(p.table) + '</section>';
    }).join('') + (open ? '</div>' : '');
    panels.forEach((p, i) => {
      if (p.sec || (p.tile && !p.spark)) return;
      const el = $('st-c' + i);
      if (!el) return;
      const w = Math.max(120, Math.floor(el.clientWidth || 300));
      try { el.innerHTML = p.tile ? spark(p.spark, w) : p.body(w); } catch (e) { el.innerHTML = '<p class="st-none" data-err="' + esc(String(e && e.message || e)) + '">Could not draw this.</p>'; }
    });
  }

  // ── tooltip and crosshair (one for the page) ──
  function hideTip() { if ($tip) $tip.hidden = true; }
  if ($grid && typeof $grid.addEventListener === 'function') {
    $grid.addEventListener('pointermove', (e) => {
      const t = e.target && e.target.closest ? e.target.closest('[data-t]') : null;
      const svg = e.target && e.target.closest ? e.target.closest('svg') : null;
      const guide = svg && svg.querySelector ? svg.querySelector('.st-guide') : null;
      if (guide) { const gx = t && t.getAttribute('data-gx'); if (gx) { guide.setAttribute('x1', gx); guide.setAttribute('x2', gx); guide.classList.add('on'); } else guide.classList.remove('on'); }
      if (!t || !$tip) return hideTip();
      $tip.textContent = t.getAttribute('data-t');
      $tip.hidden = false;
      const r = $tip.getBoundingClientRect ? $tip.getBoundingClientRect() : { width: 0, height: 0 };
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1000;
      $tip.style.left = Math.min(vw - r.width - 8, e.clientX + 12) + 'px';
      $tip.style.top = Math.max(8, e.clientY - r.height - 10) + 'px';
    });
    $grid.addEventListener('pointerleave', hideTip);
  }

  async function load(fresh) {
    if ($when) $when.textContent = fresh ? 'Recomputing\\u2026' : 'Loading\\u2026';
    const res = await TK.api.get('/ui/api/stats' + (fresh ? '?fresh=1' : ''));
    if (!res.ok || !res.data || !res.data.cards) { if ($when) $when.textContent = TK.errText(res, 'Could not load the stats (' + res.status + ').'); return; }
    data = res.data;
    if ($when) $when.textContent = 'As of ' + new Date(data.generatedAt).toLocaleString() + ' \\u00b7 daily charts cover the last ' + data.days + ' days (UTC)';
    render();
  }
  const $refresh = $('st-refresh');
  if ($refresh && typeof $refresh.addEventListener === 'function') $refresh.addEventListener('click', () => TK.busy($refresh, 'Refreshing\\u2026', () => load(true)));
  let rt = null, lastW = 0;
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { const w = $grid ? $grid.clientWidth : 0; if (w !== lastW) { lastW = w; render(); } }, 150);
  });
  load(false);
})();
`

export const STATS_PAGE: UiPage = {
  path: '/stats',
  html: shell({
    nav: 'stats',
    title: 'Stats',
    description: 'Every count the app keeps: the library, the search index, playlists, mkvid, pre-saves and the account pool, with their history.',
    body: BODY,
    css: CSS,
    js: JS,
  }),
}
