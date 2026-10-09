// mkvid: sets with no YouTube recording but a SoundCloud / hearthis.at one,
// handed to mkvid (the NAS render/upload service) to turn into an unlisted
// video. mkvid polls the Worker; this page shows where each request stands
// (behaviour contract section 3). Data: the Access-gated GET /ui/api/mkvid
// (the header: status line, caps, counts, DJs, rendering now, old videos) and
// three TKTables: Queue (GET /ui/api/mkvid/queue, server-side, claim order by
// default, with the whole-queue position and the reorder/ban buttons), Finished
// (GET /ui/api/mkvid/finished, server-side) and Old videos (local, over the
// header's list). Actions are the POST /ui/api/mkvid/* routes.
import { shell } from '../shell'
import { tipAttr, tipTerm } from '../tip'
import { MKVID_STATE_JS } from './mkvid-state'

const BODY = /* html */ `
  <div id="mk-state" class="mk-state" role="status"><span class="skel" style="width: 18rem"></span></div>
  <div id="mk-run" hidden></div>
  <div id="mk-tiles" class="tk-tiles"></div>
  <div id="mk-summary" class="mk-summary">loading…</div>
  <div id="mk-error" class="err-state" role="alert" hidden><span id="mk-error-text" class="grow"></span><button type="button" id="mk-error-retry" class="btn"${tipAttr('Asks for the mkvid status again.')}>Retry</button></div>
  <div class="mk-filters">
    <label class="mk-djf">DJ <select id="mk-dj" aria-label="DJ"><option value="">any DJ</option></select></label>
  </div>
  <div id="mk-tabs" class="tk-tabbar" role="tablist" aria-label="mkvid lists"></div>
  <div id="mk-p-queue" role="tabpanel" aria-labelledby="mk-tab-queue"><div id="mk-rendering"></div><div id="mk-queue"></div></div>
  <div id="mk-p-settled" role="tabpanel" aria-labelledby="mk-tab-settled" hidden><div id="mk-settled"></div></div>
  <div id="mk-p-old" role="tabpanel" aria-labelledby="mk-tab-old" hidden><div id="mk-old"></div></div>
`

const CSS = /* css */ `
  .mk-state { background: var(--card); border: 1px solid var(--line); border-left-width: 3px; border-radius: var(--r-tile); padding: 10px var(--sp-3); margin-bottom: var(--sp-3); line-height: 1.4; }
  .mk-state.ok { border-left-color: var(--ok); }
  .mk-state.wait { border-left-color: var(--warn); }
  .mk-state.bad { border-left-color: var(--danger); }
  .mk-state .sub { display: block; color: var(--muted); font-size: var(--fs-sm); margin-top: 2px; }
  .mk-summary { color: var(--muted); font-size: var(--fs-sm); margin-bottom: var(--sp-3); }
  .mk-summary .warn { color: var(--danger); }
  .mk-summary strong { color: var(--fg); }
  #mk-error { margin-bottom: var(--sp-3); }
  .mk-filters { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-3); }
  .mk-filters select { font: inherit; font-size: var(--fs-sm); color: var(--fg); background: var(--page); border: 1px solid var(--line-strong); border-radius: var(--r-ctl); padding: 7px 9px; min-width: 0; max-width: 100%; }
  .mk-djf { display: inline-flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--muted); }
  .mk-rendering { margin-bottom: var(--sp-3); }
  .mk-cell { display: inline-flex; flex-direction: column; min-width: 0; }
  @media (max-width: 699px) { .mk-cell { align-items: flex-end; text-align: right; } }
  .mk-cell-title { font-weight: 600; overflow-wrap: anywhere; }
  .mk-cell-sub { display: block; color: var(--muted); font-size: var(--fs-xs); }
  .mk-cell-sub .why, .mk-cell-sub .flag { white-space: normal; }
  .mk-cell-sub .flag, .mk-err { color: var(--danger); }
  .mk-err { font-size: var(--fs-xs); overflow-wrap: anywhere; }
  .tkt-table tr.mk-failed > td:first-child { box-shadow: inset 3px 0 0 var(--danger); }
  .tk-tabbar .n { color: var(--subtle); font-weight: 500; margin-left: 4px; font-variant-numeric: tabular-nums; }
  .tk-tabbar .n:empty { display: none; }
  .mk-derr { margin-top: var(--sp-3); }
  /* Each set mkvid is working on (up to two): one rail, a tie at every stage boundary, section widths ~ each stage's share of the job. */
  .mk-run { background: var(--card); border: 1px solid var(--line); border-radius: var(--r-tile); padding: 10px var(--sp-3) 6px; margin-bottom: var(--sp-3); }
  .mk-run-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px var(--sp-2); }
  .mk-run-head .k { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .06em; color: var(--subtle); font-weight: 600; }
  .mk-run.waiting .mk-run-head .k { color: var(--warn); }
  .mk-run-head .t { font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
  .mk-run-head .pct { margin-left: auto; font-weight: 700; font-variant-numeric: tabular-nums; }
  .mk-run .sub { color: var(--muted); font-size: var(--fs-sm); margin-top: 2px; }
  .mk-rail { position: relative; height: 10px; margin: 16px 1px 0; }
  .mk-rail .bar { display: flex; height: 100%; border-radius: 3px; overflow: hidden; background: var(--line); }
  .mk-rail .sec { height: 100%; min-width: 0; }
  .mk-rail .fill { height: 100%; background: var(--accent-fill); transition: width .6s ease; }
  .mk-rail .sec.indet .fill { width: 100%; background: repeating-linear-gradient(-45deg, var(--accent-soft) 0 6px, transparent 6px 12px); background-size: 17px 17px; animation: mk-rail-slide 1s linear infinite; }
  @keyframes mk-rail-slide { to { background-position: 17px 0; } }
  .mk-rail .tie { position: absolute; top: -6px; bottom: -6px; width: 2px; margin-left: -1px; border-radius: 1px; background: var(--line-strong); }
  .mk-rail .tie.past { background: var(--accent-fill); }
  .mk-stations { position: relative; height: 2.7em; margin-top: 8px; font-size: var(--fs-xs); color: var(--subtle); }
  .mk-stations span { position: absolute; top: 0; white-space: nowrap; transform: translateX(-50%); }
  .mk-stations span.row2 { top: 1.35em; }
  .mk-stations span.l { transform: none; }
  .mk-stations span.r { transform: translateX(-100%); }
  .mk-stations span.on { color: var(--fg); font-weight: 600; }
  @media (max-width: 640px) { .mk-stations span.narrow:not(.on) { display: none; } }
  @media (prefers-reduced-motion: reduce) { .mk-rail .sec.indet .fill { animation: none; } .mk-rail .fill { transition: none; } }
  .mk-grp { color: var(--subtle); font-size: var(--fs-xs); font-weight: 600; text-transform: uppercase; letter-spacing: .06em; margin: var(--sp-4) 0 var(--sp-2); }
  .mk-grp:first-child { margin-top: 0; }
  .mk-list { padding: 0; overflow: hidden; }
  .mk-row { display: flex; align-items: center; gap: var(--sp-3); padding: 10px var(--sp-3); border-bottom: 1px solid var(--line); cursor: pointer; min-width: 0; }
  .mk-row:last-child { border-bottom: 0; }
  .mk-row:hover { background: var(--elev); }
  .mk-row.err { box-shadow: inset 3px 0 0 var(--danger); }
  .mk-row.old { cursor: default; }
  .mk-pos { font-family: var(--mono); font-size: var(--fs-sm); color: var(--subtle); min-width: 3.2em; text-align: right; flex: none; font-variant-numeric: tabular-nums; }
  .mk-main { flex: 1; min-width: 0; }
  .mk-title { display: block; font: inherit; font-weight: 600; color: var(--fg); background: none; border: 0; padding: 0; text-align: left; cursor: pointer; overflow-wrap: anywhere; max-width: 100%; }
  .mk-title:hover { color: var(--accent); }
  .mk-meta { color: var(--muted); font-size: var(--fs-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mk-meta .why, .mk-dl .why { color: var(--warn); }
  .mk-meta .why.ready, .mk-dl .why.ready { color: var(--ok); }
  .mk-meta .flag { color: var(--danger); }
  .mk-watch { font-size: var(--fs-sm); white-space: nowrap; flex: none; }
  .mk-acts { display: flex; gap: 2px; flex: none; }
  .mk-act { font: inherit; font-size: var(--fs-sm); line-height: 1.3; background: transparent; color: var(--muted); border: 1px solid var(--line-strong); border-radius: 4px; padding: 2px 7px; cursor: pointer; }
  .mk-act:hover:not(:disabled) { color: var(--fg); border-color: var(--accent); }
  .mk-act.ban { color: var(--danger); }
  .mk-act:disabled { opacity: .4; cursor: default; }
  .mk-more { width: 100%; margin-top: var(--sp-2); }
  .btn.small { padding: 5px 10px; font-size: var(--fs-sm); }
  .mk-dgrp { color: var(--subtle); font-size: var(--fs-xs); font-weight: 600; text-transform: uppercase; letter-spacing: .06em; margin: var(--sp-3) 0 var(--sp-2); }
  .mk-dgrp:first-child { margin-top: 0; }
  .mk-dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px var(--sp-3); margin: 0; font-size: var(--fs-sm); }
  .mk-dl dt { color: var(--muted); }
  .mk-dl dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .mk-dl .when { color: var(--subtle); }
  .mk-dl .warn { color: var(--danger); }
  @media (max-width: 599px) {
    .mk-row { flex-wrap: wrap; }
    .mk-meta { white-space: normal; }
    .mk-acts { flex-basis: 100%; justify-content: flex-end; }
  }
`

const JS = /* js */ `
(() => {
${MKVID_STATE_JS}
  const $ = TK.$, esc = TK.esc;
  const $state = $('mk-state'), $tiles = $('mk-tiles'), $summary = $('mk-summary');
  const $err = $('mk-error'), $errText = $('mk-error-text'), $errRetry = $('mk-error-retry');
  const $dj = $('mk-dj'), $rendering = $('mk-rendering');
  const $tabs = $('mk-tabs'), $refresh = $('mk-refresh'), $recreateOld = $('mk-recreate-old');
  const $panels = { queue: $('mk-p-queue'), settled: $('mk-p-settled'), old: $('mk-p-old') };

  const TABS = [['queue', 'Queue'], ['settled', 'Finished'], ['old', 'Old videos']];
  const TAB_TIPS = { queue: 'Sets waiting for mkvid, in the order it will take them, and the ones it is working on.', settled: 'Requests that are over: uploaded, failed, superseded or banned.', old: 'Videos that a recreation replaced and that still have to be deleted from YouTube.' };
  const BADGE = { pending: 'info', claimed: 'warn', done: 'ok', failed: 'bad', superseded: 'neutral', banned: 'bad' };
  const STATUS_WORDS = { pending: 'waiting', claimed: 'rendering', done: 'uploaded', failed: 'failed', superseded: 'superseded', banned: 'banned' };

  // Old links (?status=failed&tab=settled, ?source=, ?account=, ?dj=, ?q=) become the tables' filters.
  (function legacy() {
    const g = (k) => TK.qs.get(k) || '';
    const status = g('status'), source = g('source'), account = g('account'), dj = g('dj'), q = g('q').slice(0, 120);
    if (!status && !source && !account && !dj && !q) return;
    const sts = status.split(',').filter((x) => STATUS_WORDS[x] && x !== 'pending' && x !== 'claimed');
    const m = { status: null, source: null, account: null, dj: null, q: null };
    for (const t of ['q', 'fin']) {
      if (/^(soundcloud|hearthis)$/.test(source)) m[t + '.f.source'] = 'in:' + source;
      if (/^(primary|shared)$/.test(account)) m[t + '.f.account'] = 'in:' + account;
      if (dj) m[t + '.f.dj'] = 'eq:' + dj;
      if (q) m[t + '.q'] = q;
    }
    if (sts.length) { m['fin.f.status'] = 'in:' + sts.join('|'); if (!g('tab')) m.tab = 'settled'; }
    TKTable.qs.merge(m);
  })();
  let tab = ['queue', 'settled', 'old'].indexOf(TK.qs.get('tab') || '') >= 0 ? TK.qs.get('tab') : 'queue';

  let header = null, capped = false;

  // ── the sets mkvid is working on now (GET /ui/api/mkvid/progress, every 15 s while visible) ──
  // Up to two at once, never in the same stage: one queued for the stage the other holds is waiting.
  const $run = $('mk-run');
  const RUN_MIN_SHARE = 6; // narrow stages (download ~2% of a job) still get a visible section
  const RUN_SUB = {
    download: 'Downloading the audio',
    analyse: 'Fetching artwork and analysing the audio',
    render: 'Rendering the video',
    assemble: 'Joining the segments and adding the audio',
    upload: 'Uploading to YouTube',
  };
  const RUN_K = { download: 'Downloading', analyse: 'Analysing', render: 'Rendering now', assemble: 'Assembling', upload: 'Uploading' };
  const RUN_DOING = { download: 'downloading', analyse: 'analysing', render: 'rendering', assemble: 'assembling', upload: 'uploading' };
  /** One set's card. */
  function renderRun(p) {
    const st = p.stages;
    const vis = st.map((s) => Math.max(Number(s.weight) || 0, RUN_MIN_SHARE));
    const tot = vis.reduce((n, w) => n + w, 0);
    let acc = 0;
    const pos = vis.map((w) => { const left = (acc / tot) * 100; acc += w; return { left, width: (w / tot) * 100 }; });
    const ai = st.findIndex((s) => s.state === 'active');
    const pct = Math.round((Number(p.fraction) || 0) * 100);
    const secs = st.map((s, i) => {
      const w = s.state === 'done' ? 100 : s.state === 'active' && s.progress != null ? Math.round(s.progress * 1000) / 10 : 0;
      const indet = s.state === 'active' && s.progress == null;
      return '<div class="sec ' + esc(s.state) + (indet ? ' indet' : '') + '" style="flex: 0 0 ' + pos[i].width.toFixed(3) + '%"' + TK.tip(s.label + (s.state === 'active' && !indet ? ' ' + Math.round(w) + '%' : s.state === 'done' ? ' (done)' : '')) + '><div class="fill" style="width: ' + w + '%"></div></div>';
    }).join('');
    const ties = st.map((_, i) => pos[i].left).concat([100]).map((left, i) =>
      '<span class="tie' + (i <= ai ? ' past' : '') + '" style="left: ' + left.toFixed(3) + '%"></span>').join('');
    // Wide stages label the first row; narrow ones drop to the second, except right after another
    // narrow one (download, analyse), which takes the first row so the two never overlap.
    let prevLow = false;
    const stations = st.map((s, i) => {
      const c = pos[i].left + pos[i].width / 2;
      const narrow = pos[i].width < 12;
      const low = narrow && !prevLow;
      prevLow = low;
      const cls = (narrow ? 'narrow' : '') + (low ? ' row2' : '') + (i === ai ? ' on' : '') + (c < 6 ? ' l' : c > 94 ? ' r' : '');
      const at = c < 6 ? pos[i].left : c > 94 ? pos[i].left + pos[i].width : c;
      return '<span class="' + cls.trim() + '" style="left: ' + at.toFixed(3) + '%">' + esc(s.label) + '</span>';
    }).join('');
    const cur = st[ai] || null;
    const waiting = !!p.waiting;
    const bits = [waiting
      ? 'Waiting for the other set to finish ' + (RUN_DOING[p.stage] || 'its ' + (cur ? cur.label.toLowerCase() : 'stage'))
      : RUN_SUB[p.stage] || (cur ? cur.label : '')];
    if (!waiting && p.stage === 'render' && p.segments) bits.push('segment ' + p.segments.done + ' of ' + p.segments.total);
    if (!waiting && p.stage === 'render' && p.renderMinutesLeft != null) bits.push('~' + p.renderMinutesLeft + ' min left in the render');
    if (!waiting && p.stage !== 'render' && cur && cur.progress != null) bits.push(Math.round(cur.progress * 100) + '%');
    if (p.startedAt) bits.push('started ' + TK.fmt.rel(new Date(p.startedAt * 1000).toISOString()));
    // A track upload (kind 'track') links to the Track uploads page; a set (or an older mkvid's job, kind null) to its set.
    const title = p.kind === 'track'
      ? '<a class="t" href="/ui/track-uploads">' + esc('Track: ' + (p.title || 'a pre-saved track')) + '</a>'
      : p.setUrl
        ? '<a class="t" href="/ui/set?url=' + encodeURIComponent(p.setUrl) + '">' + esc(p.title || TK.fmt.setLabel(p.setUrl)) + '</a>'
        : '<span class="t">' + esc(p.title || 'a set') + '</span>';
    const k = waiting ? 'Up next' : RUN_K[p.stage] || 'In progress';
    return '<div class="mk-run' + (waiting ? ' waiting' : '') + '">' +
      '<div class="mk-run-head"><span class="k">' + esc(k) + '</span>' + title + '<span class="pct">' + pct + '%</span></div>' +
      '<div class="sub">' + bits.filter(Boolean).map(esc).join(' · ') + '</div>' +
      '<div class="mk-rail" role="progressbar" aria-label="Render progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '" aria-valuetext="' + esc(pct + '%, ' + (cur ? cur.label : '') + (waiting ? ', waiting' : '')) + '">' +
        '<div class="bar">' + secs + '</div>' + ties + '</div>' +
      '<div class="mk-stations" aria-hidden="true">' + stations + '</div></div>';
  }
  async function loadRun() {
    const res = await TK.api.get('/ui/api/mkvid/progress');
    const d = res.ok && res.data;
    // A Worker from before two jobs answers running only.
    const list = (d && (Array.isArray(d.jobs) ? d.jobs : d.running ? [d.running] : [])) || [];
    const shown = list.filter((p) => p && Array.isArray(p.stages) && p.stages.length);
    if (!shown.length) { $run.hidden = true; $run.innerHTML = ''; }
    else { $run.innerHTML = shown.map(renderRun).join(''); $run.hidden = false; }
    return res;
  }
  // TK.poll: pauses while hidden, backs off on errors, stops on 401/403 and after 15 min (Refresh restarts it).
  let runPoll = null;
  function startRun() {
    if (runPoll) runPoll.stop();
    loadRun();
    // After TK.poll's 15-minute hard stop the bar would freeze mid-render: say so instead.
    runPoll = TK.poll(loadRun, 15000, {
      onAuth: () => { $run.hidden = true; },
      onTimeout: () => { if (!$run.hidden) $run.innerHTML += '<p class="muted sub">Live updates paused. Press Refresh to resume.</p>'; },
    });
  }
  function link(u, label, cls, tip) {
    const h = TK.safeHref(u);
    if (!h) return u ? esc(u) : '—';
    return '<a' + (cls ? ' class="' + cls + '"' : '') + ' href="' + esc(h) + '" target="_blank" rel="noreferrer noopener"' + TK.tip(tip) + '>' + esc(label || u) + '</a>';
  }
  const isoOf = (sec) => { try { return new Date(sec * 1000).toISOString(); } catch (e) { return ''; } };
  const rel = (sec) => TK.fmt.rel(isoOf(sec));
  const titleOf = (r) => r.setTitle || TK.fmt.setLabel(r.setUrl);
  const videoHref = (r) => r.videoUrl || ('https://youtu.be/' + r.videoId);

  // ── header: status line, caps, summary ──
  function renderHeader() {
    const d = header;
    if (!d) return;
    const c = d.counts || {};
    const st = mkState(d);
    const eff = mkEffective(d);
    capped = eff.cap === 0 || eff.used >= eff.cap || !!(d.lastPoll && d.lastPoll.outcome === 'capped');
    $state.className = 'mk-state ' + st[0];
    $state.innerHTML = '<strong>' + esc(st[1]) + '</strong><span class="sub">' + esc(st[2]) + '</span>';

    const tiles = (d.accounts || []).map((a) => {
      const pct = a.cap > 0 ? Math.min(100, Math.round((a.used / a.cap) * 100)) : 100;
      return '<div class="tk-tile"' + TK.tip('Uploads through the ' + a.label + ' Google project today, out of its daily cap. Each project has its own YouTube upload limit, reset at midnight Pacific.') + '><div class="k">' + esc(a.label) + '</div><div class="v">' + esc(a.used) + ' / ' + esc(a.cap) + '</div>' +
        '<div class="s">uploads today</div><div class="tk-meter"><i style="width: ' + pct + '%"></i></div></div>';
    });
    const perDay = eff.cap || d.dailyClaimCap;
    tiles.push('<div class="tk-tile"' + TK.tip('Sets queued for mkvid. The backlog estimate divides them by the uploads allowed per day.') + '><div class="k">Waiting</div><div class="v">' + esc(c.pending || 0) + '</div><div class="s">' +
      (perDay > 0 && c.pending ? 'backlog ≈ ' + esc(Math.ceil(c.pending / perDay)) + ' day' + (c.pending > perDay ? 's' : '') : 'nothing queued') + '</div></div>');
    tiles.push('<div class="tk-tile"' + TK.tip('Videos mkvid has rendered and uploaded, and put in the playlists.') + '><div class="k">Uploaded</div><div class="v">' + esc(c.done || 0) + '</div><div class="s">' + (c.failed ? esc(c.failed) + ' failed' : 'none failed') + '</div></div>');
    $tiles.innerHTML = tiles.join('');

    const bits = [esc(c.done || 0) + ' uploaded', esc(c.pending || 0) + ' waiting'];
    if (c.failed) bits.push('<span class="warn">' + esc(c.failed) + ' failed</span>');
    if (c.superseded) bits.push(esc(c.superseded) + ' superseded');
    if (c.banned) bits.push(esc(c.banned) + ' banned');
    for (const a of d.accounts || []) bits.push('<span' + TK.tip('Uploads through the ' + a.label + ' Google project today, out of its daily cap.') + '>' + esc(a.label) + ' ' + esc(a.used) + '/' + esc(a.cap) + '</span>');
    if (perDay > 0 && c.pending) bits.push('<span' + TK.tip(c.pending + ' waiting sets at ' + perDay + ' uploads a day.') + '>backlog ≈ ' + Math.ceil(c.pending / perDay) + ' day' + (c.pending > perDay ? 's' : '') + ' at ' + esc(perDay) + '/day</span>');
    if (d.lastPoll) bits.push('<span' + TK.tip('The last time mkvid asked for work. This is only recorded every 10 minutes.') + '>mkvid seen ' + esc(rel(d.lastPoll.at)) + '</span>');
    const olds = d.oldVideos || [];
    if (olds.length) bits.push('<span class="warn">' + olds.length + ' replaced video' + (olds.length === 1 ? '' : 's') + ' not deleted yet</span>');
    $summary.innerHTML = bits.join(' · ');

    $recreateOld.hidden = !(d.oldStyleCount > 0);
    $recreateOld.textContent = 'Recreate all old-style videos (' + (d.oldStyleCount || 0) + ')';
  }

  // ── rows ──
  // Reorder / ban controls on a waiting row. The list reloads after each, so
  // positions stay honest.
  const ACTS = [['top', '⤒', 'Move to the top'], ['up', '↑', 'Move up one'], ['down', '↓', 'Move down one'], ['bottom', '⤓', 'Move to the bottom'], ['ban', '✕', 'Never upload this set via mkvid']];
  const ACT_TIPS = { top: 'Moves this set to the front of the queue, ahead of everything dated up to today.', up: 'Moves this set up one place.', down: 'Moves this set down one place.', bottom: 'Moves this set to the back of the queue.', ban: 'Bans this set: it is never rendered by mkvid and the sync cannot queue it again. Unban it from its details.' };
  const STATUS_TIPS = { pending: 'Waiting in the queue for its turn.', claimed: 'mkvid took this set and is rendering and uploading it.', done: 'Uploaded and added to the playlists.', failed: 'Rendering or uploading failed. Retry it from its details.', superseded: 'The set gained a real recording, or the video was replaced, so no render is needed.', banned: 'Never rendered. Unban it from its details.' };
  // A waiting or running request keeps the error its last attempt ended with: say so, or it reads as the current state.
  function errorLabel(r) {
    return r.status === 'pending' || r.status === 'claimed' ? 'last attempt: ' + r.error : r.error;
  }
  // A refusal made before any render (the recording is gone, or ends before the tracklist does) will fail again on Retry.
  function statusTip(r) {
    if (r.status !== 'failed') return STATUS_TIPS[r.status];
    if (/^incomplete_recording/.test(r.error || '')) return 'The recording ends before the tracklist does, so mkvid refused it. Retry fails the same way; a recheck that finds a longer recording on the page queues it again by itself.';
    if (/^probe:/.test(r.error || '')) return 'mkvid could not open the recording (deleted or private), so nothing was rendered. Retry only helps if the recording comes back.';
    return STATUS_TIPS.failed;
  }
  // The moves act on whole-queue positions, so they are offered only while the
  // table shows the queue in claim order (sorted by #, ascending); ban always.
  function actsHtml(moves) {
    return '<span class="mk-acts">' + ACTS.filter((a) => moves || a[0] === 'ban').map((a) => '<button type="button" class="mk-act' + (a[0] === 'ban' ? ' ban' : '') + '" data-act="' + a[0] + '"' + TK.tip(ACT_TIPS[a[0]]) + ' aria-label="' + a[2] + '">' + a[1] + '</button>').join('') + '</span>';
  }

  function rowHtml(r, withPos) {
    const backoff = r.status === 'pending' && r.notBefore && r.notBefore > Date.now() / 1000;
    const meta = [r.setDate, r.artistLabel || r.artistName || r.slug, r.sourceLabel || r.source].filter(Boolean).map(esc);
    if (r.status === 'pending' && r.readiness) meta.push(mkWhy(r.readiness, true, capped));
    else if (backoff) meta.push('retry ' + untilTime(r.notBefore));
    else if (r.status !== 'pending') meta.push(esc(rel(r.updatedAt)));
    if (r.replacesVideoId) meta.push('<span class="why"' + TK.tip('This set is being rendered again. The current video stays up until the new one is in the playlists, then it is deleted from YouTube.') + '>recreating</span>');
    if (r.status === 'done' && r.oldStyle) meta.push('<span' + TK.tip('Rendered in an older visual style than the current scene style. It can be recreated.') + '>old style</span>');
    if (r.error && (r.status !== 'pending' || backoff)) meta.push('<span class="flag">' + esc(errorLabel(r)) + '</span>');
    const lead = withPos && r.position != null
      ? '<span class="mk-pos"' + TK.tip('Place in the whole queue: the newest set goes first, undated sets last.') + '>#' + esc(r.position) + '</span>'
      : '<span class="badge ' + (BADGE[r.status] || 'neutral') + '"' + TK.tip(statusTip(r)) + '>' + esc(r.status === 'claimed' ? 'rendering' : r.status) + '</span>';
    return '<div class="mk-row' + (r.status === 'failed' ? ' err' : '') + '" data-id="' + esc(r.id) + '">' + lead +
      '<div class="mk-main"><button type="button" class="mk-title" data-open="' + esc(r.id) + '">' + esc(titleOf(r)) + '</button>' +
      '<div class="mk-meta">' + meta.join(' · ') + '</div></div>' +
      (r.videoId ? link(videoHref(r), 'watch', 'mk-watch', 'Opens the uploaded video on YouTube.') : '') +
      '</div>';
  }

  // ── the requests mkvid is rendering now (from the header), above the queue ──
  let rendering = [];
  function renderRendering() {
    rendering = (header && header.rendering) || [];
    $rendering.innerHTML = rendering.length
      ? '<div class="mk-grp">Rendering now</div><div class="tk-card mk-list mk-rendering">' + rendering.map((r) => rowHtml(r, false)).join('') + '</div><div class="mk-grp">Up next</div>'
      : '';
  }
  $rendering.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest || t.closest('a')) return;
    const row = t.closest('.mk-row[data-id]');
    const r = row && rendering.find((x) => x.id === row.getAttribute('data-id'));
    if (r) openDetail(r);
  });

  // ── the three tables ──
  const SOURCES = [{ value: 'soundcloud', label: 'SoundCloud' }, { value: 'hearthis', label: 'hearthis.at' }];
  const ACCOUNTS = [{ value: 'primary', label: 'primary' }, { value: 'shared', label: 'shared' }];
  const when = (sec) => (sec ? '<span class="tkt-when"' + TK.tip(TK.fmt.time(isoOf(sec))) + '>' + esc(rel(sec)) + '</span>' : '<span class="tkt-nil">–</span>');
  const nil = '<span class="tkt-nil">–</span>';
  function titleCell(r, sub) {
    return '<span class="mk-cell"><span class="mk-cell-title">' + esc(titleOf(r)) + '</span>' + (sub ? '<span class="mk-cell-sub">' + sub + '</span>' : '') + '</span>';
  }
  const djCell = (r) => (r.slug ? '<a href="/ui/dj/' + encodeURIComponent(r.slug) + '">' + esc(r.artistLabel || r.artistName || r.slug) + '</a>' : nil);
  const common = {
    setDate: { key: 'setDate', label: 'Set date', type: 'date', tip: 'The date of the set. The queue serves the newest set first; undated sets go last.' },
    // Sorted and filtered by slug (the DJ select sets eq:<slug>); shows the DJ's name.
    dj: { key: 'dj', label: 'DJ', type: 'text', value: (r) => r.slug, render: djCell },
    source: { key: 'source', label: 'Source', type: 'enum', options: SOURCES, hideOn: 'phone', render: (r) => r.sourceUrl ? link(r.sourceUrl, r.sourceLabel || r.source, '', 'Opens the recording mkvid renders from.') : esc(r.sourceLabel || r.source) },
    account: { key: 'account', label: 'Project', type: 'enum', options: ACCOUNTS, hideOn: 'phone', tip: 'The Google project the video is uploaded through.', render: (r) => esc(r.accountLabel || r.account) },
    attempts: { key: 'attempts', label: 'Tries', type: 'number', hideOn: 'phone', tip: 'Render attempts so far.' },
  };

  function queueMeta(r) {
    const backoff = r.notBefore && r.notBefore > Date.now() / 1000;
    const bits = [];
    if (r.readiness) bits.push(mkWhy(r.readiness, true, capped));
    else if (backoff) bits.push('retry ' + untilTime(r.notBefore));
    if (r.replacesVideoId) bits.push('<span class="why"' + TK.tip('This set is being rendered again. The current video stays up until the new one is in the playlists, then it is deleted from YouTube.') + '>recreating</span>');
    if (r.error) bits.push('<span class="flag">' + esc(errorLabel(r)) + '</span>');
    return bits.join(' · ');
  }
  const queueSorted = () => {
    const s = queueTable ? queueTable.state().effectiveSort : [];
    return s.length === 1 && s[0].col === 'position' && s[0].dir === 'asc';
  };
  let queueTable = null, finTable = null, oldTable = null;
  queueTable = TKTable.create($('mk-queue'), {
    id: 'q',
    source: { url: '/ui/api/mkvid/queue' },
    defaultSort: 'position',
    pageSize: 25,
    pageSizes: [10, 25, 50, 100, 200],
    search: 'Search set, DJ or URL',
    empty: 'No sets queued for mkvid.',
    rowKey: 'id',
    columns: [
      { key: 'position', label: '#', type: 'number', width: '4.5em', tip: 'Place in the whole queue (claim order): the newest set goes first, undated sets last. No filter or sort changes it. Sort by # to reorder.', render: (r) => '<span class="mk-pos">#' + esc(r.position) + '</span>' },
      { key: 'setTitle', label: 'Set', type: 'text', render: (r) => titleCell(r, queueMeta(r)) },
      common.dj,
      common.setDate,
      common.source,
      common.account,
      common.attempts,
      { key: 'createdAt', label: 'Queued', type: 'datetime', storage: 's', hideOn: 'phone', render: (r) => when(r.createdAt) },
    ],
    chips: [
      { id: 'all', label: 'All', group: 'q', on: true },
      { id: 'retry', label: 'Retrying', group: 'q', filters: [{ col: 'error', op: 'nempty', value: '' }], tip: 'Sets whose last attempt failed and that are waiting to be tried again.' },
      { id: 'undated', label: 'Undated', group: 'q', filters: [{ col: 'setDate', op: 'empty', value: '' }], tip: 'Sets without a date: they wait at the back of the queue.' },
    ],
    actions: (r) => actsHtml(queueSorted()),
    onAction: async (act, r, btn) => {
      const row = btn && btn.closest ? btn.closest('tr') : null;
      const btns = row && row.querySelectorAll ? row.querySelectorAll('button[data-act]') : [btn];
      for (const b of btns) b.disabled = true;
      try {
        const id = encodeURIComponent(r.id);
        if (act === 'ban') await post('/ui/api/mkvid/ban/' + id, {}, 'ban');
        else await post('/ui/api/mkvid/move/' + id, { to: act }, 'move');
        await reloadAll();
      } finally { for (const b of btns) b.disabled = false; }
    },
    onRowClick: (r) => openDetail(r),
  });

  const FIN_STATUSES = ['done', 'failed', 'superseded', 'banned'].map((v) => ({ value: v, label: STATUS_WORDS[v] }));
  finTable = TKTable.create($('mk-settled'), {
    id: 'fin',
    source: { url: '/ui/api/mkvid/finished' },
    defaultSort: '-updatedAt',
    pageSize: 25,
    search: 'Search set, DJ, URL or error',
    empty: 'Nothing has finished yet.',
    rowKey: 'id',
    columns: [
      { key: 'status', label: 'Status', type: 'enum', options: FIN_STATUSES, render: (r) => '<span class="badge ' + (BADGE[r.status] || 'neutral') + '"' + TK.tip(statusTip(r)) + '>' + esc(STATUS_WORDS[r.status] || r.status) + '</span>' },
      { key: 'setTitle', label: 'Set', type: 'text', render: (r) => titleCell(r, r.error ? '<span class="flag">' + esc(errorLabel(r)) + '</span>' : (r.status === 'done' && r.oldStyle ? 'old style' : '')) },
      common.dj,
      common.setDate,
      common.source,
      common.account,
      { key: 'style', label: 'Style', type: 'enum', options: ['scene', 'waves', 'static'], hideOn: 'phone', render: (r) => r.videoId ? (r.style ? esc(r.style) : '<span' + TK.tip('Made before styles were recorded: an old-style video that can be recreated.') + '>old</span>') : nil },
      { key: 'videoId', label: 'Video', type: 'text', render: (r) => r.videoId ? link(videoHref(r), 'watch', 'mk-watch', 'Opens the uploaded video on YouTube.') + (r.privacy && r.privacy !== 'unlisted' ? ' <span class="mk-cell-sub"' + TK.tip('unlisted was requested: an unverified OAuth app forces private.') + '>' + esc(r.privacy) + '</span>' : '') : nil },
      { key: 'updatedAt', label: 'Finished', type: 'datetime', storage: 's', tip: 'When the request last changed: the upload, the failure, the ban.', render: (r) => when(r.updatedAt) },
      common.attempts,
    ],
    chips: [
      { id: 'all', label: 'All', group: 'st', on: true },
      { id: 'done', label: 'Uploaded', group: 'st', filters: [{ col: 'status', op: 'in', value: 'done' }] },
      { id: 'problems', label: 'Problems', group: 'st', filters: [{ col: 'status', op: 'in', value: 'failed|banned' }], tip: 'Failed or banned requests.' },
      { id: 'failed', label: 'Failed', group: 'st', filters: [{ col: 'status', op: 'in', value: 'failed' }] },
      { id: 'superseded', label: 'Superseded', group: 'st', filters: [{ col: 'status', op: 'in', value: 'superseded' }] },
      { id: 'banned', label: 'Banned', group: 'st', filters: [{ col: 'status', op: 'in', value: 'banned' }] },
    ],
    rowAttrs: (r) => (r.status === 'failed' ? { class: 'mk-failed' } : null),
    onRowClick: (r) => openDetail(r),
  });

  // A video a recreation replaced: out of the playlists, waiting for mkvid to delete it (the cron retries).
  oldTable = TKTable.create($('mk-old'), {
    id: 'old',
    source: { rows: () => (header && header.oldVideos) || [] },
    rowKey: 'videoId',
    defaultSort: '-createdAt',
    search: 'Search video or set',
    empty: 'No replaced videos are waiting to be deleted.',
    columns: [
      { key: 'state', label: 'State', type: 'enum', options: ['pending', 'refused'], render: (o) => '<span class="badge ' + (o.state === 'refused' ? 'bad' : 'info') + '"' + TK.tip(o.state === 'refused' ? 'mkvid refused to delete this video from YouTube. See the reason beside it.' : 'Out of the playlists, waiting for mkvid to delete it from YouTube. The delete is retried on a schedule.') + '>' + esc(o.state) + '</span>' },
      { key: 'videoId', label: 'Video', type: 'text', render: (o) => '<span class="mono">' + esc(o.videoId) + '</span> ' + link('https://youtu.be/' + encodeURIComponent(o.videoId), 'watch', 'mk-watch', 'Opens the old video on YouTube.') },
      { key: 'setUrl', label: 'Set', type: 'text', render: (o) => o.setUrl ? '<a href="/ui/set?url=' + encodeURIComponent(o.setUrl) + '">' + esc(TK.fmt.setLabel(o.setUrl)) + '</a>' : nil },
      { key: 'replacedBy', label: 'Replaced by', type: 'text', hideOn: 'phone', render: (o) => o.replacedBy === 'banned' ? 'banned while it rendered' : '<span class="mono">' + esc(o.replacedBy) + '</span>' },
      { key: 'attempts', label: 'Tries', type: 'number', hideOn: 'phone' },
      { key: 'nextTryAt', label: 'Next try', type: 'datetime', storage: 's', hideOn: 'phone', render: (o) => o.state === 'refused' || !o.nextTryAt ? nil : esc(untilTime(o.nextTryAt)) },
      { key: 'lastError', label: 'Error', type: 'text', render: (o) => o.lastError ? '<span class="mk-err">' + esc((o.state === 'refused' ? 'mkvid refused: ' : '') + o.lastError) + '</span>' : (o.state === 'refused' ? nil : 'deleting') },
    ],
    actions: (o) => '<button type="button" class="btn sm" data-act="retry"' + TK.tip('Asks mkvid to delete this replaced video from YouTube again now, instead of waiting for the next scheduled try.') + '>Retry now</button>',
    onAction: (act, o, btn) => TK.busy(btn, 'Retrying…', async () => {
      await post('/ui/api/mkvid/old-videos/' + encodeURIComponent(o.videoId) + '/retry', {}, 'delete retry');
      await reloadAll();
    }),
  });

  function findRow(id) {
    const all = rendering.concat(queueTable.rows(), finTable.rows());
    for (const r of all) if (r.id === id) return r;
    return null;
  }

  // ── the DJ select: one filter on both request tables ──
  function djFilterOf(t) { const f = t.state().filters.find((x) => x.col === 'dj' && x.op === 'eq'); return f ? f.value : ''; }
  function djOptions() {
    const keep = djFilterOf(queueTable) || djFilterOf(finTable);
    const list = (header && header.djs) || [];
    let html = '<option value="">any DJ</option>' + list.map((d) => '<option value="' + esc(d.slug) + '">' + esc(d.label) + ' (' + esc(d.count) + ')</option>').join('');
    if (keep && !list.some((d) => d.slug === keep)) html += '<option value="' + esc(keep) + '">' + esc(keep) + '</option>';
    $dj.innerHTML = html;
    $dj.value = keep;
  }
  $dj.addEventListener('change', () => {
    const v = $dj.value || '';
    for (const t of [queueTable, finTable]) t.setFilter('dj', v ? 'eq' : null, v);
  });

  // ── loading: the header (GET /ui/api/mkvid), then the tables reload themselves ──
  let headSeq = 0;
  async function loadHeader() {
    const my = ++headSeq;
    const res = await TK.api.get('/ui/api/mkvid');
    if (my !== headSeq) return;
    if (!res.ok || !res.data) {
      $errText.textContent = 'mkvid status unavailable: ' + TK.errText(res, 'failed (' + res.status + ')');
      $err.hidden = false; $summary.textContent = '';
      return;
    }
    $err.hidden = true;
    header = res.data;
    renderHeader();
    renderRendering();
    djOptions();
    const c = header.counts || {};
    renderTabs(false, { queue: (c.pending || 0) + (c.claimed || 0), settled: (c.done || 0) + (c.failed || 0) + (c.superseded || 0) + (c.banned || 0), old: (header.oldVideos || []).length });
    oldTable.reload();
  }
  function reloadAll() { return Promise.all([loadHeader(), queueTable.reload(), finTable.reload()]); }

  // ── tabs (role=tablist, arrow keys) ──
  // Built once, then updated in place, so a finished load never takes focus off a tab.
  let tabCounts = { queue: null, settled: null, old: null };
  let tabsBuilt = false;
  function renderTabs(focus, counts) {
    if (counts) tabCounts = counts;
    if (!tabsBuilt) {
      $tabs.innerHTML = TABS.map((t) => '<button type="button" role="tab" id="mk-tab-' + t[0] + '" data-tab="' + t[0] + '" aria-controls="mk-p-' + t[0] + '" aria-selected="' + (tab === t[0]) + '" tabindex="' + (tab === t[0] ? '0' : '-1') + '"' + TK.tip(TAB_TIPS[t[0]]) + '>' +
        t[1] + '<span class="n" id="mk-n-' + t[0] + '"></span></button>').join('');
      tabsBuilt = true;
    }
    for (const t of TABS) {
      const on = tab === t[0];
      const b = $('mk-tab-' + t[0]);
      if (b && typeof b.setAttribute === 'function') { b.setAttribute('aria-selected', String(on)); b.setAttribute('tabindex', on ? '0' : '-1'); }
      const n = $('mk-n-' + t[0]);
      if (n) n.textContent = tabCounts[t[0]] != null ? String(tabCounts[t[0]]) : '';
      $panels[t[0]].hidden = !on;
    }
    if (focus) { const b = $('mk-tab-' + tab); if (b && typeof b.focus === 'function') b.focus(); }
  }
  function selectTab(name, focus) { tab = name; TKTable.qs.merge({ tab: name === 'queue' ? null : name }); renderTabs(focus); }
  $tabs.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('[data-tab]') : null;
    if (b) selectTab(b.dataset.tab, false);
  });
  $tabs.addEventListener('keydown', (e) => {
    const i = TABS.findIndex((t) => t[0] === tab);
    let j = -1;
    if (e.key === 'ArrowRight') j = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') j = (i + TABS.length - 1) % TABS.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = TABS.length - 1;
    if (j < 0) return;
    e.preventDefault();
    selectTab(TABS[j][0], true);
  });

  async function post(url, body, what) {
    const res = await TK.api.post(url, body);
    if (!res.ok) TK.toast(what + ' failed (' + res.status + ')', 'bad', TK.errText(res, ''));
    return res;
  }

  // ── detail drawer ──
  function dl(pairs) {
    return '<dl class="mk-dl">' + pairs.filter(Boolean).map((p) => '<dt>' + esc(p[0]) + '</dt><dd>' + p[1] + '</dd>').join('') + '</dl>';
  }
  function detailHtml(r) {
    const out = [];
    out.push('<div class="mk-dgrp">Set</div>');
    out.push(dl([
      ['tracklist', link(r.setUrl, TK.fmt.setLabel(r.setUrl))],
      ['title', r.setTitle ? esc(r.setTitle) : '—'],
      ['set date', r.setDate ? esc(r.setDate) : '— <span class="when">(undated sets are queued last)</span>'],
      ['DJ', esc(r.artistLabel || r.artistName || r.slug) + (r.slug ? ' <span class="when">(' + esc(r.slug) + ')</span>' : '')],
      ['source', esc(r.sourceLabel || r.source) + ' ' + link(r.sourceUrl, 'open')],
      r.trackCount != null ? ['tracklist', esc(r.idedCount) + '/' + esc(r.trackCount) + ' IDed' + (r.lastCueSeconds != null ? ' · last cue ' + esc(TK.fmt.clock(r.lastCueSeconds)) : '')] : null,
    ]));
    out.push('<div class="mk-dgrp">Upload</div>');
    out.push(dl([
      ['status', '<span class="badge ' + (BADGE[r.status] || 'neutral') + '"' + TK.tip(STATUS_TIPS[r.status]) + '>' + esc(r.status) + '</span>' + (r.error ? ' <span class="warn">' + esc(errorLabel(r)) + '</span>' : '')],
      ['video', r.videoId ? '<span class="mono">' + esc(r.videoId) + '</span> ' + link(videoHref(r), 'open') : '—'],
      r.privacy ? ['privacy', esc(r.privacy) + (r.privacy !== 'unlisted' ? ' <span class="warn">(unlisted was requested — an unverified OAuth app forces private)</span>' : '')] : null,
      ['attempts', esc(r.attempts) + (r.notBefore ? ' · next try ' + esc(rel(r.notBefore)) : '')],
      r.status !== 'pending' ? ['project', esc(r.accountLabel || r.account)] : null,
      r.videoId ? ['style', r.style ? esc(r.style) : '<span class="warn">unknown (old style)</span>'] : null,
      r.replacesVideoId ? ['recreating', 'replaces <span class="mono">' + esc(r.replacesVideoId) + '</span> ' + link('https://youtu.be/' + encodeURIComponent(r.replacesVideoId), 'open') + ' <span class="when">(stays up until the new video is in the playlists, then is deleted)</span>'] : null,
      r.readiness ? ['waiting', mkWhy(r.readiness, false, capped)] : null,
      r.skipIdWait ? ['ID wait', 'skipped (Render now)'] : null,
      r.jobId ? ['mkvid job', '<span class="mono">' + esc(r.jobId) + '</span>'] : null,
      ['queued', esc(TK.fmt.time(isoOf(r.createdAt))) + ' <span class="when">(' + esc(rel(r.createdAt)) + ')</span>'],
      ['updated', esc(TK.fmt.time(isoOf(r.updatedAt))) + ' <span class="when">(' + esc(rel(r.updatedAt)) + ')</span>'],
    ]));
    const btns = [];
    if (r.status === 'failed' || r.status === 'superseded' || r.status === 'claimed' || r.status === 'banned') {
      btns.push('<button type="button" class="btn" data-do="retry"' + TK.tip(r.status === 'banned' ? 'Lifts the ban: the set goes back in the queue.' : r.status === 'claimed' ? 'Gives the job back, whatever mkvid is doing with it, so it can be claimed again. Use it when mkvid died mid-job.' : 'Puts the request back in the queue with a fresh start.') + '>' + (r.status === 'claimed' ? 'Release &amp; retry' : r.status === 'banned' ? 'Unban' : 'Retry') + '</button>');
    }
    if (r.readiness && r.readiness.state === 'waiting_ids' && !r.skipIdWait) {
      btns.push('<button type="button" class="btn" data-do="render-now"' + TK.tip('Renders now with ID shown for the unidentified tracks, instead of waiting until the set is 7 days old. The track list must still be verified.') + '>Render now</button>');
    }
    if (r.status === 'done' && r.videoId && !r.replacesVideoId) {
      btns.push('<button type="button" class="btn danger" data-do="recreate"' + TK.tip('Renders the set again at the back of the queue (it counts against the daily upload cap). The old video stays up until the new one is in the playlists, then it is deleted.') + '>Delete and recreate</button>');
      btns.push('<button type="button" class="btn danger" data-do="unpublish"' + TK.tip('Takes the video out of the playlists and deletes it from YouTube right now. The set goes back in the queue and renders again when it is ready.') + '>Delete video</button>');
    }
    btns.push('<a class="btn" href="/ui/set?url=' + encodeURIComponent(r.setUrl || '') + '"' + TK.tip('Opens this set in the tracked viewer, with its track list and diagnostics.') + '>Open set page</a>');
    // A failed action's reason, shown here: a toast would sit under the modal drawer.
    out.push('<div class="err-state mk-derr" role="alert" data-derr hidden></div>');
    out.push('<div class="actions">' + btns.join('') + '</div>');
    return out.join('');
  }

  const UNPUBLISH_ASK = 'Delete this video now? It comes out of the playlists and is deleted from YouTube right away. The set goes back in the queue and renders again once it is ready.';
  const RECREATE_ASK = 'Delete and recreate this video? The set is rendered again at the back of the queue; the current video stays up until the new one is in the playlists, then it is deleted from YouTube.';
  // errMsg: the reason the last action on this request failed, shown in the drawer.
  let drawerFor = null;
  function openDetail(r, errMsg) {
    drawerFor = r.id;
    const body = TK.drawer.open(titleOf(r), detailHtml(r));
    if (!body) return;
    const errLine = typeof body.querySelector === 'function' ? body.querySelector('[data-derr]') : null;
    if (errLine && errMsg) { errLine.textContent = errMsg; errLine.hidden = false; }
    body.onclick = async (e) => {
      const b = e.target && e.target.closest ? e.target.closest('button[data-do]') : null;
      if (!b) return;
      const id = encodeURIComponent(r.id);
      const what = b.dataset.do;
      if (what === 'recreate' && !(await TK.ask(RECREATE_ASK, { yes: 'Delete and recreate', danger: true }))) return;
      if (what === 'unpublish' && !(await TK.ask(UNPUBLISH_ASK, { yes: 'Delete video', danger: true }))) return;
      const url = what === 'retry' ? '/ui/api/mkvid/retry/' + id : what === 'render-now' ? '/ui/api/mkvid/render-now/' + id : what === 'unpublish' ? '/ui/api/mkvid/unpublish/' + id : '/ui/api/mkvid/recreate/' + id;
      if (errLine) errLine.hidden = true;
      const res = await TK.busy(b, 'Working…', () => TK.api.post(url, {}));
      if (res && res.ok) { TK.drawer.close(); await reloadAll(); return; }
      // Failed: say why in the drawer, which stays open, and reload, as the old
      // panel did; the drawer then shows the request as it is now.
      const why = TK.errText(res, '');
      const msg = (what === 'render-now' ? 'render now' : what === 'unpublish' ? 'delete video' : what) + ' failed (' + (res ? res.status : 0) + ')' + (why ? ': ' + why : '');
      if (errLine) { errLine.textContent = msg; errLine.hidden = false; }
      await reloadAll();
      const dlg = $('tk-drawer');
      if (dlg && dlg.open && drawerFor === r.id) openDetail(findRow(r.id) || r, msg);
    };
  }

  // ── header actions ──
  $refresh.addEventListener('click', () => { startRun(); TK.busy($refresh, 'Refreshing…', () => reloadAll()); });
  // Bulk recreate: confirm with the live count, and send it back so a count that changed meanwhile is refused.
  // The reload runs after busy has put its saved label back, so the button
  // ends up with the new count (or hidden at 0).
  $recreateOld.addEventListener('click', async () => {
    const reload = await TK.busy($recreateOld, 'Checking…', async () => {
      const c = await TK.api.get('/ui/api/mkvid/recreate-old-style');
      if (!c.ok) { TK.toast('recreate failed (' + c.status + ')', 'bad', TK.errText(c, '')); return false; }
      const count = (c.data && c.data.count) || 0;
      if (!count) { TK.toast('no old-style videos to recreate', 'bad'); return true; }
      const text = 'Recreate ' + count + ' old-style video' + (count === 1 ? '' : 's') + '? Each set is rendered again at the back of the queue (they count against the daily cap); every old video stays up until its new one is in the playlists, then it is deleted from YouTube.';
      if (!(await TK.ask(text, { yes: 'Recreate', danger: true }))) return false;
      const res = await TK.api.post('/ui/api/mkvid/recreate-old-style', { expect: count });
      if (!res.ok) TK.toast(res.status === 409 ? 'the number of old-style videos changed — try again' : 'recreate failed (' + res.status + ')', 'bad');
      return true;
    });
    if (reload) await reloadAll();
  });
  $errRetry.addEventListener('click', () => TK.busy($errRetry, 'Retrying…', () => reloadAll()));

  renderTabs(false);
  loadHeader();
  startRun();
})();
`

export const MKVID_PAGE_HTML = shell({
  nav: 'mkvid',
  title: 'mkvid',
  description: `Sets with no YouTube recording, ${tipTerm('rendered into a video by mkvid', 'Sets that have no YouTube recording but a SoundCloud or hearthis.at one are handed to mkvid, a service on the NAS that renders a video from the audio and uploads it as unlisted.')}. Where each request stands and why nothing is uploading.`,
  actions: `<button type="button" id="mk-recreate-old" class="btn" hidden${tipAttr('Renders every finished video made in a style other than scene again, at the back of the queue. They count against the daily cap, and each old video is deleted once its replacement is in the playlists.')}>Recreate all old-style videos</button><button type="button" id="mk-refresh" class="btn"${tipAttr('Reloads the queue and the progress bar.')}>Refresh</button>`,
  body: BODY,
  css: CSS,
  js: JS,
})
