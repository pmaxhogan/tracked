// mkvid: sets with no YouTube recording but a SoundCloud / hearthis.at one,
// handed to mkvid (the NAS render/upload service) to turn into a video
// (privacy: app setting mkvid.privacy). mkvid polls the Worker; this page shows where each request stands
// (behaviour contract section 3). Data: the Access-gated GET /ui/api/mkvid
// (the header: status line, caps, counts, DJs, rendering now, old videos) and
// three TKTables: Queue (GET /ui/api/mkvid/queue, server-side, claim order by
// default, with the whole-queue position and the reorder/ban buttons), Finished
// (GET /ui/api/mkvid/finished, server-side) and Old videos (local, over the
// header's list). Actions are the POST /ui/api/mkvid/* routes.
//
// Both request tables have a Status column filtered on the server: why a
// waiting set is or is not next (Queue), how a request ended (Finished). Red is
// for a real failure only: a set whose recording was removed or is too short
// (lib/mkvid-outcome.ts) is neutral and not counted as failed. The exception is
// several recordings "removed" within a day (lib/mkvid-removed-burst.ts): those
// are red ("removed, unconfirmed") under a banner with the two answers, Try
// them again and They are really gone (POST /ui/api/mkvid/removed-burst/*).
import { shell } from "../shell";
import { MKVID_OUTCOMES, MKVID_OUTCOME_LABELS } from "../../lib/mkvid-outcome";
import { tipAttr, tipTerm } from "../tip";
import { MKVID_STATE_JS } from "./mkvid-state";

const BODY = /* html */ `
  <div id="mk-state" class="mk-state" role="status"><span class="skel" style="width: 18rem"></span></div>
  <div id="mk-run" hidden></div>
  <div id="mk-tiles" class="tk-tiles"></div>
  <div id="mk-summary" class="mk-summary">loading…</div>
  <div id="mk-error" class="err-state" role="alert" hidden><span id="mk-error-text" class="grow"></span><button type="button" id="mk-error-retry" class="btn"${tipAttr("Asks for the mkvid status again.")}>Retry</button></div>
  <div id="mk-burst" class="err-state mk-burst" role="alert" hidden></div>
  <div class="mk-filters">
    <label class="mk-djf">DJ <select id="mk-dj" aria-label="DJ"><option value="">any DJ</option></select></label>
  </div>
  <div id="mk-tabs" class="tk-tabbar" role="tablist" aria-label="mkvid lists"></div>
  <div id="mk-p-queue" role="tabpanel" aria-labelledby="mk-tab-queue"><div id="mk-rendering"></div><div id="mk-queue"></div></div>
  <div id="mk-p-settled" role="tabpanel" aria-labelledby="mk-tab-settled" hidden><div id="mk-settled"></div></div>
  <div id="mk-p-old" role="tabpanel" aria-labelledby="mk-tab-old" hidden><div id="mk-old"></div></div>
`;

const CSS = /* css */ `
  .mk-state { background: var(--card); border: 1px solid var(--line); border-left-width: 3px; border-radius: var(--r-tile); padding: 10px var(--sp-3); margin-bottom: var(--sp-3); line-height: 1.4; }
  .mk-state.ok { border-left-color: var(--ok); }
  .mk-state.wait { border-left-color: var(--warn); }
  .mk-state.bad { border-left-color: var(--danger); }
  .mk-state .sub { display: block; color: var(--muted); font-size: var(--fs-sm); margin-top: 2px; }
  .mk-summary { color: var(--muted); font-size: var(--fs-sm); margin-bottom: var(--sp-3); }
  .mk-summary .warn { color: var(--danger); }
  .mk-summary strong { color: var(--fg); }
  #mk-error, .mk-burst { margin-bottom: var(--sp-3); }
  .mk-burst .grow { flex-basis: 24rem; line-height: 1.4; }
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
  .mk-cell-sub .retry, .mk-meta .retry { color: var(--warn); white-space: normal; }
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
  .mk-cross { margin: var(--sp-2) 0 0; color: var(--muted); }
  .mk-cross .btn { margin-left: 6px; }
  .mk-pos { font-family: var(--mono); font-size: var(--fs-sm); color: var(--subtle); min-width: 3.2em; text-align: right; flex: none; font-variant-numeric: tabular-nums; }
  .mk-main { flex: 1; min-width: 0; }
  .mk-title { display: block; font: inherit; font-weight: 600; color: var(--fg); background: none; border: 0; padding: 0; text-align: left; cursor: pointer; overflow-wrap: anywhere; max-width: 100%; }
  .mk-title:hover { color: var(--accent); }
  .mk-meta { color: var(--muted); font-size: var(--fs-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mk-meta .why, .mk-dl .why { color: var(--warn); }
  .mk-meta .why.ready, .mk-dl .why.ready { color: var(--ok); }
  .mk-meta .why.audio, .mk-dl .why.audio { color: var(--info); }
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
`;

const JS = /* js */ `
(() => {
${MKVID_STATE_JS}
  const $ = TK.$, esc = TK.esc;
  const $state = $('mk-state'), $tiles = $('mk-tiles'), $summary = $('mk-summary');
  const $err = $('mk-error'), $errText = $('mk-error-text'), $errRetry = $('mk-error-retry');
  const $dj = $('mk-dj'), $rendering = $('mk-rendering'), $burst = $('mk-burst');
  const $tabs = $('mk-tabs'), $refresh = $('mk-refresh'), $recreateOld = $('mk-recreate-old');
  const $panels = { queue: $('mk-p-queue'), settled: $('mk-p-settled'), old: $('mk-p-old') };

  const TABS = [['queue', 'Queue'], ['settled', 'Finished'], ['old', 'Old videos']];
  const TAB_TIPS = { queue: 'Sets waiting for mkvid, in the order it will take them, and the ones it is working on.', settled: 'Requests that are over: uploaded, failed, without a usable recording, superseded or banned.', old: 'Videos that a recreation replaced and that still have to be deleted from YouTube.' };
  // A request's state: how it ended once it has left the queue (outcome), else its stored status.
  const stateOf = (r) => r.outcome || r.status;
  const noRecording = (r) => r.outcome === 'recording_removed' || r.outcome === 'recording_short';
  // A removal the owner has not ruled on yet: one of several within a day (lib/mkvid-removed-burst.ts).
  const unconfirmed = (r) => r.outcome === 'removed_unconfirmed';
  // What the page paints red: a real failure, and an unconfirmed removal.
  const isProblem = (r) => stateOf(r) === 'failed' || unconfirmed(r);
  const BADGE = { pending: 'info', claimed: 'warn', done: 'ok', failed: 'bad', removed_unconfirmed: 'bad', recording_removed: 'neutral', recording_short: 'neutral', has_recording: 'neutral', duplicate: 'neutral', superseded: 'neutral', banned: 'bad' };
  const STATUS_WORDS = Object.assign({ pending: 'waiting', claimed: 'rendering' }, ${JSON.stringify(MKVID_OUTCOME_LABELS)});

  // Old links (?status=failed&tab=settled, ?source=, ?account=, ?dj=, ?q=) become the tables' filters.
  (function legacy() {
    const g = (k) => TK.qs.get(k) || '';
    const status = g('status'), source = g('source'), account = g('account'), dj = g('dj'), q = g('q').slice(0, 120);
    if (!status && !source && !account && !dj && !q) return;
    const sts = status.split(',').filter((x) => STATUS_WORDS[x] && x !== 'pending' && x !== 'claimed');
    // An old ?status=superseded meant every superseded request, whatever its cause.
    if (sts.indexOf('superseded') >= 0) for (const x of ['has_recording', 'duplicate']) if (sts.indexOf(x) < 0) sts.push(x);
    const m = { status: null, source: null, account: null, dj: null, q: null };
    for (const t of ['q', 'fin']) {
      if (/^(soundcloud|hearthis)$/.test(source)) m[t + '.f.source'] = 'in:' + source;
      if (/^[a-z][a-z0-9_]{0,31}$/.test(account)) m[t + '.f.account'] = 'in:' + account;
      if (dj) m[t + '.f.dj'] = 'eq:' + dj;
      if (q) m[t + '.q'] = q;
    }
    if (sts.length) { m['fin.f.status'] = 'in:' + sts.join('|'); if (!g('tab')) m.tab = 'settled'; }
    TKTable.qs.merge(m);
  })();
  let tab = ['queue', 'settled', 'old'].indexOf(TK.qs.get('tab') || '') >= 0 ? TK.qs.get('tab') : 'queue';

  let header = null, capped = false;
  // The upload projects (the Project filter's options), refreshed from the header's accounts: primary, mkvid's extras, shared.
  const ACCOUNTS = [{ value: 'primary', label: 'mkvid-uploads' }, { value: 'shared', label: 'tracked-youtube' }];
  const projectLabel = (r) => { const a = ACCOUNTS.find((x) => x.value === r.account); return a ? a.label : (r.accountLabel || r.account); };

  // -- the sets mkvid is working on now (GET /ui/api/mkvid/progress, every 15 s while visible) --
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
    if (!h) return u ? esc(u) : '-';
    return '<a' + (cls ? ' class="' + cls + '"' : '') + ' href="' + esc(h) + '" target="_blank" rel="noreferrer noopener"' + TK.tip(tip) + '>' + esc(label || u) + '</a>';
  }
  const isoOf = (sec) => { try { return new Date(sec * 1000).toISOString(); } catch (e) { return ''; } };
  const rel = (sec) => TK.fmt.rel(isoOf(sec));
  const titleOf = (r) => r.setTitle || TK.fmt.setLabel(r.setUrl);
  const videoHref = (r) => r.videoUrl || ('https://youtu.be/' + r.videoId);

  // -- header: status line, caps, summary --
  function renderHeader() {
    const d = header;
    if (!d) return;
    const c = d.counts || {};
    const st = mkState(d);
    const eff = mkEffective(d);
    capped = eff.cap === 0 || eff.used >= eff.cap || !!(d.lastPoll && d.lastPoll.outcome === 'capped');
    $state.className = 'mk-state ' + st[0];
    $state.innerHTML = '<strong>' + esc(st[1]) + '</strong><span class="sub">' + esc(st[2]) + '</span>';
    if (Array.isArray(d.accounts) && d.accounts.length) ACCOUNTS.splice(0, ACCOUNTS.length, ...d.accounts.map((a) => ({ value: a.account, label: a.label })));

    const tiles = (d.accounts || []).map((a) => {
      const pct = a.cap > 0 ? Math.min(100, Math.round((a.used / a.cap) * 100)) : 100;
      return '<div class="tk-tile"' + TK.tip('Uploads through the ' + a.label + ' Google project today, out of its daily cap. Each project has its own YouTube upload limit, reset at midnight Pacific.') + '><div class="k">' + esc(a.label) + '</div><div class="v">' + esc(a.used) + ' / ' + esc(a.cap) + '</div>' +
        '<div class="s">uploads today</div><div class="tk-meter"><i style="width: ' + pct + '%"></i></div></div>';
    });
    const perDay = eff.cap || d.dailyClaimCap;
    tiles.push('<div class="tk-tile"' + TK.tip('Sets queued for mkvid. The backlog estimate divides them by the uploads allowed per day.') + '><div class="k">Waiting</div><div class="v">' + esc(c.pending || 0) + '</div><div class="s">' +
      (perDay > 0 && c.pending ? 'backlog ~ ' + esc(Math.ceil(c.pending / perDay)) + ' day' + (c.pending > perDay ? 's' : '') : 'nothing queued') + '</div></div>');
    // Failed = real failures only; a set without a usable recording is not one.
    const o = d.outcomes || { failed: c.failed || 0 };
    const noRec = (o.recording_removed || 0) + (o.recording_short || 0);
    const unconf = o.removed_unconfirmed || 0;
    tiles.push('<div class="tk-tile"' + TK.tip('Videos mkvid has rendered and uploaded, and put in the playlists.') + '><div class="k">Uploaded</div><div class="v">' + esc(c.done || 0) + '</div><div class="s">' + ([o.failed ? esc(o.failed) + ' failed' : '', unconf ? esc(unconf) + ' unconfirmed' : ''].filter(Boolean).join(' · ') || 'none failed') + '</div></div>');
    $tiles.innerHTML = tiles.join('');

    const bits = [esc(c.done || 0) + ' uploaded', esc(c.pending || 0) + ' waiting'];
    if (o.failed) bits.push('<span class="warn">' + esc(o.failed) + ' failed</span>');
    if (unconf) bits.push('<span class="warn"' + TK.tip(STATUS_TIPS.removed_unconfirmed) + '>' + esc(unconf) + ' removed, unconfirmed</span>');
    if (noRec) bits.push('<span' + TK.tip('Sets whose recording was removed from its source, or is shorter than the tracklist. No video can be made from them, and there is nothing to do.') + '>' + esc(noRec) + ' without a usable recording</span>');
    if (c.superseded) bits.push(esc(c.superseded) + ' superseded');
    if (c.banned) bits.push(esc(c.banned) + ' banned');
    for (const a of d.accounts || []) bits.push('<span' + TK.tip('Uploads through the ' + a.label + ' Google project today, out of its daily cap.') + '>' + esc(a.label) + ' ' + esc(a.used) + '/' + esc(a.cap) + '</span>');
    if (perDay > 0 && c.pending) bits.push('<span' + TK.tip(c.pending + ' waiting sets at ' + perDay + ' uploads a day.') + '>backlog ~ ' + Math.ceil(c.pending / perDay) + ' day' + (c.pending > perDay ? 's' : '') + ' at ' + esc(perDay) + '/day</span>');
    if (d.lastPoll) bits.push('<span' + TK.tip('The last time mkvid asked for work. This is only recorded every 10 minutes.') + '>mkvid seen ' + esc(rel(d.lastPoll.at)) + '</span>');
    const olds = d.oldVideos || [];
    if (olds.length) bits.push('<span class="warn">' + olds.length + ' replaced video' + (olds.length === 1 ? '' : 's') + ' not deleted yet</span>');
    $summary.innerHTML = bits.join(' · ');

    $recreateOld.hidden = !(d.oldStyleCount > 0);
    $recreateOld.textContent = 'Recreate all old-style videos (' + (d.oldStyleCount || 0) + ')';
  }

  // -- removals the owner has to rule on: the banner and its two answers --
  const SOURCE_NAMES = { soundcloud: 'SoundCloud', hearthis: 'hearthis.at' };
  function renderBurst() {
    const b = header && header.removedBurst;
    if (!b || !b.count) { $burst.hidden = true; $burst.innerHTML = ''; return; }
    const n = b.count;
    const names = Object.keys(b.sources || {}).map((k) => SOURCE_NAMES[k] || k);
    const who = names.length === 1 ? names[0] : 'the source';
    $burst.innerHTML = '<span class="grow"><strong>' + esc(n) + (n === 1 ? ' recording is' : ' recordings are') + ' marked removed, unconfirmed.</strong> ' +
      esc(b.threshold) + ' or more came back "not found" within a day (the first ' + esc(rel(b.since)) + '). That many at once may mean ' + esc(who) + ' or the downloader is broken, not that they were deleted. ' +
      'Nothing changes them by itself until you choose.</span>' +
      '<button type="button" class="btn" data-burst="show"' + TK.tip('Shows these requests in the Finished tab.') + '>Show them</button>' +
      '<button type="button" class="btn" data-burst="retry"' + TK.tip('Puts ' + (n === 1 ? 'it' : 'all ' + n) + ' back in the queue with a fresh start. A recording that is really gone fails again, and this comes back if several do.') + '>Try them again</button>' +
      '<button type="button" class="btn" data-burst="confirm"' + TK.tip('Marks them as removed recordings: neutral, nothing to do, and queued again by themselves if the tracklist page later links a different recording. Later removals are counted from zero.') + '>They are really gone</button>';
    $burst.hidden = false;
  }
  $burst.addEventListener('click', async (e) => {
    const b = e.target && e.target.closest ? e.target.closest('button[data-burst]') : null;
    if (!b) return;
    const what = b.getAttribute('data-burst');
    if (what === 'show') { selectTab('settled', false); finTable.apply({ filters: [{ col: 'status', op: 'in', value: 'removed_unconfirmed' }], q: '' }); return; }
    await TK.busy(b, 'Working…', () => post('/ui/api/mkvid/removed-burst/' + what, {}, what === 'retry' ? 'try again' : 'confirm'));
    await reloadAll();
  });

  // -- rows --
  // Reorder / ban controls on a waiting row. The list reloads after each, so
  // positions stay honest.
  const ACTS = [['top', '⤒', 'Move to the top'], ['up', '↑', 'Move up one'], ['down', '↓', 'Move down one'], ['bottom', '⤓', 'Move to the bottom'], ['ban', '✕', 'Never upload this set via mkvid']];
  const ACT_TIPS = { top: 'Moves this set to the front of the queue, ahead of everything dated up to today.', up: 'Moves this set up one place.', down: 'Moves this set down one place.', bottom: 'Moves this set to the back of the queue.', ban: 'Bans this set: it is never rendered by mkvid and the sync cannot queue it again. Unban it from its details.' };
  const STATUS_TIPS = { pending: 'Waiting in the queue for its turn.', claimed: 'mkvid took this set and is rendering and uploading it.', done: 'Uploaded and added to the playlists.', failed: 'Rendering or uploading failed. Retry it from its details.',
    removed_unconfirmed: 'The recording came back "not found", and so did several others within a day. That may mean the source or the downloader is broken, not that they were deleted. Choose at the top of this page: Try them again, or They are really gone.',
    recording_removed: 'The recording is gone from its source, so no video can be made. Nothing to do.', recording_short: 'The recording ends before the tracklist does, so no video is made. Nothing to do.',
    has_recording: 'The set gained a real recording on 1001tracklists, so no render is needed.', duplicate: 'The same tracklist is listed under another URL, and that one has the video.',
    superseded: 'The set gained a real recording, or the video was replaced, so no render is needed.', banned: 'Never rendered. Unban it from its details.' };
  // A waiting or running request keeps the error its last attempt ended with: say so and when, or it
  // reads as the current state (a 401 from a token incident days ago looked like uploads were broken).
  function retrying(r) { return r.status === 'pending' || r.status === 'claimed'; }
  function errorLabel(r) {
    return retrying(r) ? 'last attempt' + (r.updatedAt ? ' (' + rel(r.updatedAt) + ')' : '') + ': ' + r.error : r.error;
  }
  // A no-recording outcome comes with its own explanation (the durations, what the source answered).
  function statusTip(r) {
    return r.outcomeDetail || STATUS_TIPS[stateOf(r)];
  }
  function badgeHtml(r) {
    const st = stateOf(r);
    return '<span class="badge ' + (BADGE[st] || 'neutral') + '"' + TK.tip(statusTip(r)) + '>' + esc(STATUS_WORDS[st] || st) + '</span>';
  }
  // The stored error under a row. Red is for a failure and for a last attempt's error; a no-recording
  // outcome reads in plain words (mkvid's own text in the tip), and a superseded or banned note is plain.
  function errorHtml(r) {
    if (!r.error) return '';
    if (unconfirmed(r)) return '<span class="flag"' + TK.tip('mkvid said: ' + r.error) + '>' + esc(r.outcomeLine || r.error) + '</span>';
    if (noRecording(r)) return '<span' + TK.tip('mkvid said: ' + r.error) + '>' + esc(r.outcomeLine || r.error) + '</span>';
    if (r.status === 'superseded' || r.status === 'banned') return esc(r.error);
    // Amber, not red: it is tried again by itself, nothing for the owner to do.
    if (retrying(r)) return '<span class="retry">' + esc(errorLabel(r)) + '</span>';
    return '<span class="flag">' + esc(errorLabel(r)) + '</span>';
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
    if (r.error && (r.status !== 'pending' || backoff)) meta.push(errorHtml(r));
    const lead = withPos && r.position != null
      ? '<span class="mk-pos"' + TK.tip('Place in the whole queue: the newest set goes first, undated sets last.') + '>#' + esc(r.position) + '</span>'
      : badgeHtml(r);
    return '<div class="mk-row' + (isProblem(r) ? ' err' : '') + '" data-id="' + esc(r.id) + '">' + lead +
      '<div class="mk-main"><button type="button" class="mk-title" data-open="' + esc(r.id) + '">' + esc(titleOf(r)) + '</button>' +
      '<div class="mk-meta">' + meta.join(' · ') + '</div></div>' +
      (r.videoId ? link(videoHref(r), 'watch', 'mk-watch', 'Opens the uploaded video on YouTube.') : '') +
      '</div>';
  }

  // -- the requests mkvid is rendering now (from the header), above the queue --
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

  // -- the three tables --
  const SOURCES = [{ value: 'soundcloud', label: 'SoundCloud' }, { value: 'hearthis', label: 'hearthis.at' }];
  const when = (sec) => (sec ? '<span class="tkt-when"' + TK.tip(TK.fmt.time(isoOf(sec))) + '>' + esc(rel(sec)) + '</span>' : '<span class="tkt-nil">-</span>');
  const nil = '<span class="tkt-nil">-</span>';
  function titleCell(r, sub) {
    return '<span class="mk-cell"><span class="mk-cell-title">' + esc(titleOf(r)) + '</span>' + (sub ? '<span class="mk-cell-sub">' + sub + '</span>' : '') + '</span>';
  }
  const djCell = (r) => (r.slug ? '<a href="/ui/dj/' + encodeURIComponent(r.slug) + '">' + esc(r.artistLabel || r.artistName || r.slug) + '</a>' : nil);
  const common = {
    setDate: { key: 'setDate', label: 'Set date', type: 'date', tip: 'The date of the set. The queue serves the newest set first; undated sets go last.' },
    // Sorted and filtered by slug (the DJ select sets eq:<slug>); shows the DJ's name.
    dj: { key: 'dj', label: 'DJ', type: 'text', value: (r) => r.slug, render: djCell },
    source: { key: 'source', label: 'Source', type: 'enum', options: SOURCES, hideOn: 'phone', render: (r) => r.sourceUrl ? link(r.sourceUrl, r.sourceLabel || r.source, '', 'Opens the recording mkvid renders from.') : esc(r.sourceLabel || r.source) },
    account: { key: 'account', label: 'Project', type: 'enum', options: ACCOUNTS, hideOn: 'phone', tip: 'The Google project the video is uploaded through.', render: (r) => esc(projectLabel(r)) },
    attempts: { key: 'attempts', label: 'Tries', type: 'number', hideOn: 'phone', tip: 'Render attempts so far.' },
  };

  // The Queue's Status cell: why this set is or is not next (mkWhy), as the server's readiness says.
  const Q_STATES = [{ value: 'ready', label: 'ready' }, { value: 'unverified', label: 'not verified' }, { value: 'untimed', label: 'too few cue times' }, { value: 'waiting_ids', label: 'waiting for IDs' }, { value: 'backoff', label: 'retrying' }];
  function queueState(r) {
    if (r.readiness) return mkWhy(r.readiness, true, capped);
    return r.notBefore && r.notBefore > Date.now() / 1000 ? 'retry ' + untilTime(r.notBefore) : nil;
  }
  // The Queue's Timed cell: the share of tracks with a cue time in the list from the set page's last check.
  function timedCell(r) {
    if (r.timedPct == null) return nil;
    const from = [r.appleCues > 0 ? r.appleCues + ' from Apple Music' : '', r.audioCues > 0 ? r.audioCues + ' estimated from audio' : ''].filter(Boolean);
    const apple = from.length ? ' (' + from.join(', ') + ')' : '';
    const tip = r.timedRows + ' of ' + r.baseRows + ' tracks have a cue time' + apple + (r.listCheckedAt ? ', checked ' + rel(r.listCheckedAt) : '') + '.';
    return '<span' + TK.tip(tip) + '>' + esc(r.timedPct) + '%</span>';
  }
  // The Queue's IDs cell: the share of identified tracks (not "ID") in the list from the set page's last check.
  function idsCell(r) {
    if (r.idsPct == null) return nil;
    const tip = (r.listRows - r.listIdRows) + ' of ' + r.listRows + ' tracks are identified, ' + r.listIdRows + ' still ID' + (r.listCheckedAt ? ', checked ' + rel(r.listCheckedAt) : '') + '.';
    return '<span' + TK.tip(tip) + '>' + esc(r.idsPct) + '%</span>';
  }
  function queueMeta(r) {
    const bits = [];
    if (r.replacesVideoId) bits.push('<span class="why"' + TK.tip('This set is being rendered again. The current video stays up until the new one is in the playlists, then it is deleted from YouTube.') + '>recreating</span>');
    if (r.error) bits.push(errorHtml(r));
    return bits.join(' · ');
  }
  // A chip's number: the whole list by Status (the answer's counts), whatever else is filtered.
  const countOf = (keys) => (resp) => (resp && resp.counts ? keys.reduce((n, k) => n + (Number(resp.counts[k]) || 0), 0) : null);
  const queueSorted = () => {
    const s = queueTable ? queueTable.state().effectiveSort : [];
    return s.length === 1 && s[0].col === 'position' && s[0].dir === 'asc';
  };
  let queueTable = null, finTable = null, oldTable = null;
  // A filter or search that empties one list may match sets in the other (a set
  // that already finished is not in the queue): the empty message says how many
  // and offers to open the other tab with the same filters and search.
  const CROSS = { queue: { other: 'settled', url: '/ui/api/mkvid/finished', words: ['finished set', 'finished sets'] }, settled: { other: 'queue', url: '/ui/api/mkvid/queue', words: ['queued set', 'queued sets'] } };
  const crossSeq = { queue: 0, settled: 0 };
  async function crossHint(from, resp) {
    const t = from === 'queue' ? queueTable : finTable;
    if (!t || !resp || resp.total !== 0) return;
    const st = t.state();
    const filters = st.filters.filter((f) => f.col !== 'position' && f.col !== 'status');
    if (!filters.length && !st.q) return;
    const c = CROSS[from], seq = ++crossSeq[from];
    let url = c.url + '?size=10' + filters.map((f) => '&f.' + encodeURIComponent(f.col) + '=' + encodeURIComponent(f.op + ':' + f.value)).join('') + (st.q ? '&q=' + encodeURIComponent(st.q) : '');
    const res = await TK.api.get(url);
    const n = res && res.ok && res.data ? Number(res.data.total) || 0 : 0;
    const em = $(t.id + '-empty');
    if (!n || !em || seq !== crossSeq[from]) return;
    em.innerHTML += '<p class="mk-cross">' + esc(n + ' ' + c.words[n === 1 ? 0 : 1]) + (n === 1 ? ' matches' : ' match') + ' in the ' + (c.other === 'settled' ? 'Finished' : 'Queue') + ' tab. ' +
      '<button type="button" class="btn" data-mk-cross="' + from + '">Show ' + (n === 1 ? 'it' : 'them') + '</button></p>';
  }
  function crossGo(from) {
    const t = from === 'queue' ? queueTable : finTable, o = from === 'queue' ? finTable : queueTable;
    if (!t || !o) return;
    const st = t.state();
    selectTab(CROSS[from].other, false);
    o.apply({ filters: st.filters.filter((f) => f.col !== 'position' && f.col !== 'status'), q: st.q });
  }
  // On the tab panels, not the table hosts: the tables own their hosts' click handling.
  for (const host of [$panels.queue, $panels.settled]) {
    if (host && typeof host.addEventListener === 'function') host.addEventListener('click', (e) => {
      const b = e.target && e.target.closest ? e.target.closest('[data-mk-cross]') : null;
      if (b) { e.preventDefault(); crossGo(b.getAttribute('data-mk-cross')); }
    });
  }
  queueTable = TKTable.create($('mk-queue'), {
    id: 'q',
    source: { url: '/ui/api/mkvid/queue' },
    onData: (resp) => { crossHint('queue', resp); },
    defaultSort: 'position',
    pageSize: 25,
    pageSizes: [10, 25, 50, 100, 200],
    search: 'Search set, DJ or URL',
    empty: 'No sets queued for mkvid.',
    rowKey: 'id',
    columns: [
      { key: 'position', label: '#', type: 'number', width: '4.5em', tip: 'Place in the whole queue (claim order): the newest set goes first, undated sets last. No filter or sort changes it. Sort by # to reorder.', render: (r) => '<span class="mk-pos">#' + esc(r.position) + '</span>' },
      { key: 'setTitle', label: 'Set', type: 'text', render: (r) => titleCell(r, queueMeta(r)) },
      { key: 'status', label: 'Status', type: 'enum', options: Q_STATES, tip: 'Why this set is or is not next: ready, not verified yet, waiting for track IDs, too few cue times, or pausing before another try.', render: queueState },
      { key: 'timedPct', label: 'Timed', type: 'number', width: '5em', tip: 'Share of the tracks with a cue time, in the track list from the last check of the set page (Apple Music cues included). A set needs 90%, or 75% if it is at least 5 months old.', render: timedCell },
      { key: 'idsPct', label: 'IDs', type: 'number', width: '5em', tip: 'Share of the tracks that are identified (not ID), in the track list from the last check of the set page. A set with ID rows waits up to 7 days for them to be identified.', render: idsCell },
      common.dj,
      common.setDate,
      common.source,
      common.account,
      common.attempts,
      { key: 'createdAt', label: 'Queued', type: 'datetime', storage: 's', hideOn: 'phone', render: (r) => when(r.createdAt) },
    ],
    chips: [
      { id: 'all', label: 'All', group: 'q', on: true, count: countOf(Q_STATES.map((s) => s.value)) },
      { id: 'ready', label: 'Ready', group: 'q', filters: [{ col: 'status', op: 'in', value: 'ready' }], count: countOf(['ready']), tip: 'Verified and allowed to render: mkvid takes them in order, as the daily caps allow.' },
      { id: 'unverified', label: 'Not verified', group: 'q', filters: [{ col: 'status', op: 'in', value: 'unverified' }], count: countOf(['unverified']), tip: 'Sets whose track list still needs a second matching fetch.' },
      { id: 'ids', label: 'Waiting for IDs', group: 'q', filters: [{ col: 'status', op: 'in', value: 'waiting_ids' }], count: countOf(['waiting_ids']), tip: 'Sets with unidentified tracks, held until they are 7 days old.' },
      { id: 'untimed', label: 'Too few cue times', group: 'q', filters: [{ col: 'status', op: 'in', value: 'untimed' }], count: countOf(['untimed']), tip: 'Sets with under 90% of their tracks timed, or under 75% for a set at least 5 months old. Rechecked weekly.' },
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

  const FIN_STATUSES = ${JSON.stringify(MKVID_OUTCOMES)}.map((v) => ({ value: v, label: STATUS_WORDS[v] }));
  function finishedMeta(r) {
    return r.error ? errorHtml(r) : (r.status === 'done' && r.oldStyle ? 'old style' : '');
  }
  finTable = TKTable.create($('mk-settled'), {
    id: 'fin',
    source: { url: '/ui/api/mkvid/finished' },
    onData: (resp) => { crossHint('settled', resp); },
    defaultSort: '-updatedAt',
    pageSize: 25,
    search: 'Search set, DJ, URL or error',
    empty: 'Nothing has finished yet.',
    rowKey: 'id',
    columns: [
      { key: 'status', label: 'Status', type: 'enum', options: FIN_STATUSES, tip: 'How the request ended. Failed is a real failure; a set whose recording was removed or is too short is its own status, and nothing to act on. Removed, unconfirmed is several removals within a day, which wait for your answer at the top of the page.', render: badgeHtml },
      { key: 'setTitle', label: 'Set', type: 'text', render: (r) => titleCell(r, finishedMeta(r)) },
      common.dj,
      common.setDate,
      common.source,
      common.account,
      { key: 'style', label: 'Style', type: 'enum', options: ['scene', 'waves', 'static'], hideOn: 'phone', render: (r) => r.videoId ? (r.style ? esc(r.style) : '<span' + TK.tip('Made before styles were recorded: an old-style video that can be recreated.') + '>old</span>') : nil },
      { key: 'videoId', label: 'Video', type: 'text', render: (r) => r.videoId ? link(videoHref(r), 'watch', 'mk-watch', 'Opens the uploaded video on YouTube.') + (r.privacy === 'private' ? ' <span class="mk-cell-sub"' + TK.tip('The privacy YouTube applied. An unverified OAuth app forces private whatever was requested.') + '>private</span>' : '') : nil },
      { key: 'updatedAt', label: 'Finished', type: 'datetime', storage: 's', tip: 'When the request last changed: the upload, the failure, the ban.', render: (r) => when(r.updatedAt) },
      common.attempts,
    ],
    chips: [
      { id: 'all', label: 'All', group: 'st', on: true, count: countOf(FIN_STATUSES.map((s) => s.value)) },
      { id: 'done', label: 'Uploaded', group: 'st', filters: [{ col: 'status', op: 'in', value: 'done' }], count: countOf(['done']) },
      { id: 'problems', label: 'Problems', group: 'st', filters: [{ col: 'status', op: 'in', value: 'failed|removed_unconfirmed|banned' }], count: countOf(['failed', 'removed_unconfirmed', 'banned']), tip: 'Failed or banned requests, and removals that wait for your answer. A set without a usable recording is not one.' },
      { id: 'failed', label: 'Failed', group: 'st', filters: [{ col: 'status', op: 'in', value: 'failed' }], count: countOf(['failed']), tip: 'Rendering or uploading failed: these can be retried.' },
      { id: 'unconfirmed', label: 'Removed, unconfirmed', group: 'st', filters: [{ col: 'status', op: 'in', value: 'removed_unconfirmed' }], count: countOf(['removed_unconfirmed']), tip: 'Several recordings came back "not found" within a day, which may mean the source or the downloader is broken. They wait for your answer at the top of the page.' },
      { id: 'removed', label: 'Recording removed', group: 'st', filters: [{ col: 'status', op: 'in', value: 'recording_removed' }], count: countOf(['recording_removed']), tip: 'The recording is gone from SoundCloud or hearthis.at (deleted, private or blocked). Nothing to do.' },
      { id: 'short', label: 'Recording too short', group: 'st', filters: [{ col: 'status', op: 'in', value: 'recording_short' }], count: countOf(['recording_short']), tip: 'The recording ends before the tracklist does: a part of the set. Nothing to do.' },
      { id: 'superseded', label: 'Superseded', group: 'st', filters: [{ col: 'status', op: 'in', value: 'has_recording|duplicate|superseded' }], count: countOf(['has_recording', 'duplicate', 'superseded']), tip: 'No render needed: the set gained a real recording, or it is a duplicate of another URL. The Status filter tells them apart.' },
      { id: 'banned', label: 'Banned', group: 'st', filters: [{ col: 'status', op: 'in', value: 'banned' }], count: countOf(['banned']) },
    ],
    rowAttrs: (r) => (isProblem(r) ? { class: 'mk-failed' } : null),
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
      { key: 'replacedBy', label: 'Replaced by', type: 'text', hideOn: 'phone', render: (o) => o.replacedBy === 'banned' ? 'banned while it rendered' : o.replacedBy === 'gone' ? 'deleted on YouTube' : '<span class="mono">' + esc(o.replacedBy) + '</span>' },
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

  // -- the DJ select: one filter on both request tables --
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

  // -- loading: the header (GET /ui/api/mkvid), then the tables reload themselves --
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
    renderBurst();
    renderRendering();
    djOptions();
    const c = header.counts || {};
    renderTabs(false, { queue: (c.pending || 0) + (c.claimed || 0), settled: (c.done || 0) + (c.failed || 0) + (c.superseded || 0) + (c.banned || 0), old: (header.oldVideos || []).length });
    oldTable.reload();
  }
  function reloadAll() { return Promise.all([loadHeader(), queueTable.reload(), finTable.reload()]); }

  // -- tabs (role=tablist, arrow keys) --
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

  // -- detail drawer --
  function dl(pairs) {
    return '<dl class="mk-dl">' + pairs.filter(Boolean).map((p) => '<dt>' + esc(p[0]) + '</dt><dd>' + p[1] + '</dd>').join('') + '</dl>';
  }
  function detailHtml(r) {
    const out = [];
    out.push('<div class="mk-dgrp">Set</div>');
    out.push(dl([
      ['tracklist', link(r.setUrl, TK.fmt.setLabel(r.setUrl))],
      ['title', r.setTitle ? esc(r.setTitle) : '-'],
      ['set date', r.setDate ? esc(r.setDate) : '- <span class="when">(undated sets are queued last)</span>'],
      ['DJ', esc(r.artistLabel || r.artistName || r.slug) + (r.slug ? ' <span class="when">(' + esc(r.slug) + ')</span>' : '')],
      ['source', esc(r.sourceLabel || r.source) + ' ' + link(r.sourceUrl, 'open')],
      r.trackCount != null ? ['tracklist', esc(r.idedCount) + '/' + esc(r.trackCount) + ' IDed' + (r.lastCueSeconds != null ? ' · last cue ' + esc(TK.fmt.clock(r.lastCueSeconds)) : '')] : null,
    ]));
    out.push('<div class="mk-dgrp">Upload</div>');
    out.push(dl([
      ['status', badgeHtml(r) + (r.outcomeDetail ? ' ' + esc(r.outcomeDetail) : r.error ? (r.status === 'superseded' || r.status === 'banned' ? ' <span class="when">' + esc(r.error) + '</span>' : ' <span class="warn">' + esc(errorLabel(r)) + '</span>') : '')],
      r.outcomeDetail && r.error ? ['mkvid said', '<span class="when">' + esc(r.error) + '</span>'] : null,
      ['video', r.videoId ? '<span class="mono">' + esc(r.videoId) + '</span> ' + link(videoHref(r), 'open') : '-'],
      r.privacy ? ['privacy', esc(r.privacy) + (r.privacy === 'private' ? ' <span class="warn">(an unverified OAuth app forces private whatever was requested)</span>' : '')] : null,
      ['attempts', esc(r.attempts) + (r.notBefore ? ' · next try ' + esc(rel(r.notBefore)) : '')],
      r.status !== 'pending' ? ['project', esc(projectLabel(r))] : null,
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
      btns.push('<button type="button" class="btn" data-do="retry"' + TK.tip(r.status === 'banned' ? 'Lifts the ban: the set goes back in the queue.' : unconfirmed(r) ? 'Tries this one recording again now, whatever you choose for the others.' : noRecording(r) ? 'Tries the same recording again. It only helps if the recording is back.' : r.status === 'claimed' ? 'Gives the job back, whatever mkvid is doing with it, so it can be claimed again. Use it when mkvid died mid-job.' : 'Puts the request back in the queue with a fresh start.') + '>' + (r.status === 'claimed' ? 'Release &amp; retry' : r.status === 'banned' ? 'Unban' : 'Retry') + '</button>');
    }
    if (r.readiness && r.readiness.state === 'waiting_ids' && !r.skipIdWait) {
      btns.push('<button type="button" class="btn" data-do="render-now"' + TK.tip('Renders now with ID shown for the unidentified tracks, instead of waiting until the set is 7 days old. The track list must still be verified.') + '>Render now</button>');
    }
    if (r.status === 'pending' && r.readiness && r.readiness.state === 'untimed') {
      btns.push('<button type="button" class="btn" data-do="recheck-now"' + TK.tip(RECHECK_TIP) + '>Queue for re-check now</button>');
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

  const RECHECK_TIP = 'Fills the missing cue times from the Apple Music album of the set now, if it has a matching one, and fetches the 1001tracklists page again soon (within the pool budget).';
  const UNPUBLISH_ASK ='Delete this video now? It comes out of the playlists and is deleted from YouTube right away. The set goes back in the queue and renders again once it is ready.';
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
      const url = what === 'retry' ? '/ui/api/mkvid/retry/' + id : what === 'render-now' ? '/ui/api/mkvid/render-now/' + id : what === 'recheck-now' ? '/ui/api/mkvid/recheck-now/' + id : what === 'unpublish' ? '/ui/api/mkvid/unpublish/' + id : '/ui/api/mkvid/recreate/' + id;
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

  // -- header actions --
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
      if (!res.ok) TK.toast(res.status === 409 ? 'the number of old-style videos changed - try again' : 'recreate failed (' + res.status + ')', 'bad');
      return true;
    });
    if (reload) await reloadAll();
  });
  $errRetry.addEventListener('click', () => TK.busy($errRetry, 'Retrying…', () => reloadAll()));

  renderTabs(false);
  loadHeader();
  startRun();
})();
`;

export const MKVID_PAGE_HTML = shell({
  nav: "mkvid",
  title: "mkvid",
  description: `Sets with no YouTube recording, ${tipTerm("rendered into a video by mkvid", "Sets that have no YouTube recording but a SoundCloud or hearthis.at one are handed to mkvid, a service on the NAS that renders a video from the audio and uploads it (privacy: Settings, mkvid uploads).")}. Where each request stands and why nothing is uploading.`,
  actions: `<button type="button" id="mk-recreate-old" class="btn" hidden${tipAttr("Renders every finished video made in a style other than scene again, at the back of the queue. They count against the daily cap, and each old video is deleted once its replacement is in the playlists.")}>Recreate all old-style videos</button><button type="button" id="mk-refresh" class="btn"${tipAttr("Reloads the queue and the progress bar.")}>Refresh</button>`,
  body: BODY,
  css: CSS,
  js: JS,
});
