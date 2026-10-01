// mkvid: sets with no YouTube recording but a SoundCloud / hearthis.at one,
// handed to mkvid (the NAS render/upload service) to turn into an unlisted
// video. mkvid polls the Worker; this page shows where each request stands
// (behaviour contract section 3). Data: the Access-gated GET /ui/api/mkvid,
// keyset-paged per list; actions are the POST /ui/api/mkvid/* routes.
import { shell } from '../shell'
import { MKVID_STATE_JS } from './mkvid-state'

const BODY = /* html */ `
  <div id="mk-state" class="mk-state" role="status"><span class="skel" style="width: 18rem"></span></div>
  <div id="mk-run" class="mk-run" hidden></div>
  <div id="mk-tiles" class="tk-tiles"></div>
  <div id="mk-summary" class="mk-summary">loading…</div>
  <div id="mk-error" class="err-state" role="alert" hidden><span id="mk-error-text" class="grow"></span><button type="button" id="mk-error-retry" class="btn">Retry</button></div>
  <div class="mk-filters" role="search">
    <input id="mk-q" type="search" placeholder="search set, DJ or URL" aria-label="Search the mkvid queue" />
    <select id="mk-status" aria-label="Status">
      <option value="">any status</option>
      <option value="pending">waiting</option>
      <option value="claimed">rendering</option>
      <option value="done">uploaded</option>
      <option value="failed">failed</option>
      <option value="superseded">superseded</option>
      <option value="banned">banned</option>
      <option value="failed,banned">problems only</option>
    </select>
    <select id="mk-source" aria-label="Source">
      <option value="">any source</option>
      <option value="soundcloud">SoundCloud</option>
      <option value="hearthis">hearthis.at</option>
    </select>
    <select id="mk-account" aria-label="Google project">
      <option value="">any project</option>
      <option value="primary">primary</option>
      <option value="shared">shared</option>
    </select>
    <select id="mk-dj" aria-label="DJ"><option value="">any DJ</option></select>
    <button type="button" id="mk-clear" class="btn ghost" hidden>Clear</button>
  </div>
  <div id="mk-tabs" class="tk-tabbar" role="tablist" aria-label="mkvid lists"></div>
  <div id="mk-p-queue" role="tabpanel" aria-labelledby="mk-tab-queue"><div id="mk-queue"></div></div>
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
  .mk-filters input, .mk-filters select { font: inherit; font-size: var(--fs-sm); color: var(--fg); background: var(--page); border: 1px solid var(--line-strong); border-radius: var(--r-ctl); padding: 7px 9px; min-width: 0; max-width: 100%; }
  .mk-filters input { flex: 1 1 14rem; }
  .tk-tabbar .n { color: var(--subtle); font-weight: 500; margin-left: 4px; font-variant-numeric: tabular-nums; }
  .tk-tabbar .n:empty { display: none; }
  .mk-derr { margin-top: var(--sp-3); }
  /* The running render: one rail, a tie at every stage boundary, section widths ~ each stage's share of the job. */
  .mk-run { background: var(--card); border: 1px solid var(--line); border-radius: var(--r-tile); padding: 10px var(--sp-3) 6px; margin-bottom: var(--sp-3); }
  .mk-run-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px var(--sp-2); }
  .mk-run-head .k { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .06em; color: var(--subtle); font-weight: 600; }
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
  const $q = $('mk-q'), $status = $('mk-status'), $source = $('mk-source'), $account = $('mk-account'), $dj = $('mk-dj'), $clear = $('mk-clear');
  const $tabs = $('mk-tabs'), $refresh = $('mk-refresh'), $recreateOld = $('mk-recreate-old');
  const $lists = { queue: $('mk-queue'), settled: $('mk-settled'), old: $('mk-old') };
  const $panels = { queue: $('mk-p-queue'), settled: $('mk-p-settled'), old: $('mk-p-old') };

  const MK_PAGE = 25;
  const STATUSES = ['', 'pending', 'claimed', 'done', 'failed', 'superseded', 'banned', 'failed,banned'];
  const SOURCES = ['', 'soundcloud', 'hearthis'];
  const ACCOUNTS = ['', 'primary', 'shared'];
  const TABS = [['queue', 'Queue'], ['settled', 'Finished'], ['old', 'Old videos']];
  const BADGE = { pending: 'info', claimed: 'warn', done: 'ok', failed: 'bad', superseded: 'neutral', banned: 'bad' };

  // Filter state lives here (and in the query string); the controls mirror it.
  // Anything the API would refuse with a 400 is dropped on the way in.
  const pick = (v, allowed) => (allowed.indexOf(v || '') >= 0 ? (v || '') : '');
  const f = {
    q: (TK.qs.get('q') || '').slice(0, 120),
    status: pick(TK.qs.get('status'), STATUSES),
    source: pick(TK.qs.get('source'), SOURCES),
    account: pick(TK.qs.get('account'), ACCOUNTS),
    dj: TK.qs.get('dj') || '',
  };
  let tab = pick(TK.qs.get('tab'), ['queue', 'settled', 'old']) || 'queue';
  $q.value = f.q; $status.value = f.status; $source.value = f.source; $account.value = f.account; $dj.value = f.dj;

  let header = null, capped = false;

  // ── the render mkvid is working on now (GET /ui/api/mkvid/progress, every 15 s while visible) ──
  const $run = $('mk-run');
  const RUN_MIN_SHARE = 6; // narrow stages (download ~2% of a job) still get a visible section
  const RUN_SUB = {
    download: 'Downloading the audio',
    analyse: 'Fetching artwork and analysing the audio',
    render: 'Rendering the video',
    assemble: 'Joining the segments and adding the audio',
    upload: 'Uploading to YouTube',
  };
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
      return '<div class="sec ' + esc(s.state) + (indet ? ' indet' : '') + '" style="flex: 0 0 ' + pos[i].width.toFixed(3) + '%" title="' + esc(s.label) + (s.state === 'active' && !indet ? ' ' + Math.round(w) + '%' : '') + '"><div class="fill" style="width: ' + w + '%"></div></div>';
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
    const bits = [RUN_SUB[p.stage] || (cur ? cur.label : '')];
    if (p.stage === 'render' && p.segments) bits.push('segment ' + p.segments.done + ' of ' + p.segments.total);
    if (p.stage === 'render' && p.renderMinutesLeft != null) bits.push('~' + p.renderMinutesLeft + ' min left in the render');
    if (p.stage !== 'render' && cur && cur.progress != null) bits.push(Math.round(cur.progress * 100) + '%');
    if (p.startedAt) bits.push('started ' + TK.fmt.rel(new Date(p.startedAt * 1000).toISOString()));
    const title = p.setUrl
      ? '<a class="t" href="/ui/set?url=' + encodeURIComponent(p.setUrl) + '">' + esc(p.title || TK.fmt.setLabel(p.setUrl)) + '</a>'
      : '<span class="t">' + esc(p.title || 'a set') + '</span>';
    $run.innerHTML =
      '<div class="mk-run-head"><span class="k">Rendering now</span>' + title + '<span class="pct">' + pct + '%</span></div>' +
      '<div class="sub">' + bits.filter(Boolean).map(esc).join(' · ') + '</div>' +
      '<div class="mk-rail" role="progressbar" aria-label="Render progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '" aria-valuetext="' + esc(pct + '%, ' + (cur ? cur.label : '')) + '">' +
        '<div class="bar">' + secs + '</div>' + ties + '</div>' +
      '<div class="mk-stations" aria-hidden="true">' + stations + '</div>';
    $run.hidden = false;
  }
  async function loadRun() {
    const res = await TK.api.get('/ui/api/mkvid/progress');
    const p = res.ok && res.data && res.data.running;
    if (!p || !Array.isArray(p.stages) || !p.stages.length) { $run.hidden = true; $run.innerHTML = ''; }
    else renderRun(p);
    return res;
  }
  // TK.poll: pauses while hidden, backs off on errors, stops on 401/403 and after 15 min (Refresh restarts it).
  let runPoll = null;
  function startRun() {
    if (runPoll) runPoll.stop();
    loadRun();
    runPoll = TK.poll(loadRun, 15000, { onAuth: () => { $run.hidden = true; } });
  }
  // Overlapping loads (typing in the search box): only the newest renders.
  // A whole-view load supersedes everything before it; an append is dropped
  // while one is pending, or when one started after it (its cursor and filter
  // belong to the lists it was asked for).
  let allSeq = 0, allPending = false;
  const appendSeq = { queue: 0, settled: 0 };
  let queue = [], queueCursor = null, queueTotal = 0;
  let settled = [], settledCursor = null, settledTotal = 0;
  let byId = {};

  const filtered = () => !!(f.status || f.source || f.account || f.dj || f.q.trim());
  function sync() { TK.qs.set({ q: f.q.trim(), status: f.status, source: f.source, account: f.account, dj: f.dj, tab: tab === 'queue' ? '' : tab }); }

  function params(section) {
    const p = [['limit', String(MK_PAGE)], ['section', section]];
    if (f.status) p.push(['status', f.status]);
    if (f.source) p.push(['source', f.source]);
    if (f.account) p.push(['account', f.account]);
    if (f.dj) p.push(['dj', f.dj]);
    if (f.q.trim()) p.push(['q', f.q.trim()]);
    if (section === 'queue' && queueCursor) p.push(['queueCursor', queueCursor]);
    if (section === 'settled' && settledCursor) p.push(['settledCursor', settledCursor]);
    return p.map((kv) => kv[0] + '=' + encodeURIComponent(kv[1])).join('&');
  }

  function link(u, label, cls) {
    const h = TK.safeHref(u);
    if (!h) return u ? esc(u) : '—';
    return '<a' + (cls ? ' class="' + cls + '"' : '') + ' href="' + esc(h) + '" target="_blank" rel="noreferrer noopener">' + esc(label || u) + '</a>';
  }
  const isoOf = (sec) => { try { return new Date(sec * 1000).toISOString(); } catch (e) { return ''; } };
  const rel = (sec) => TK.fmt.rel(isoOf(sec));
  const titleOf = (r) => r.setTitle || TK.fmt.setLabel(r.setUrl);
  const videoHref = (r) => r.videoUrl || ('https://youtu.be/' + r.videoId);

  // ── filter options ──
  // Every DJ the queue has ever held. One being filtered on that no longer has
  // a row is kept as an option, so the filter does not silently turn itself off.
  function djOptions(djs) {
    const keep = f.dj;
    const list = djs || [];
    let html = '<option value="">any DJ</option>' + list.map((d) => '<option value="' + esc(d.slug) + '">' + esc(d.label) + ' (' + esc(d.count) + ')</option>').join('');
    if (keep && !list.some((d) => d.slug === keep)) html += '<option value="' + esc(keep) + '">' + esc(keep) + '</option>';
    $dj.innerHTML = html;
    $dj.value = keep;
  }
  function accountOptions(accounts) {
    const known = (accounts || []).filter((a) => ACCOUNTS.indexOf(a.account) > 0);
    if (!known.length) return;
    let html = '<option value="">any project</option>' + known.map((a) => '<option value="' + esc(a.account) + '">' + esc(a.label || a.account) + '</option>').join('');
    // Like the DJ select: keep the value being filtered on even when the API no longer lists it.
    if (f.account && !known.some((a) => a.account === f.account)) html += '<option value="' + esc(f.account) + '">' + esc(f.account) + '</option>';
    $account.innerHTML = html;
    $account.value = f.account;
  }

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
      return '<div class="tk-tile" title="uploads through the ' + esc(a.label) + ' Google project today"><div class="k">' + esc(a.label) + '</div><div class="v">' + esc(a.used) + ' / ' + esc(a.cap) + '</div>' +
        '<div class="s">uploads today</div><div class="tk-meter"><i style="width: ' + pct + '%"></i></div></div>';
    });
    const perDay = eff.cap || d.dailyClaimCap;
    tiles.push('<div class="tk-tile"><div class="k">Waiting</div><div class="v">' + esc(c.pending || 0) + '</div><div class="s">' +
      (perDay > 0 && c.pending ? 'backlog ≈ ' + esc(Math.ceil(c.pending / perDay)) + ' day' + (c.pending > perDay ? 's' : '') : 'nothing queued') + '</div></div>');
    tiles.push('<div class="tk-tile"><div class="k">Uploaded</div><div class="v">' + esc(c.done || 0) + '</div><div class="s">' + (c.failed ? esc(c.failed) + ' failed' : 'none failed') + '</div></div>');
    $tiles.innerHTML = tiles.join('');

    const bits = [esc(c.done || 0) + ' uploaded', esc(c.pending || 0) + ' waiting'];
    if (c.failed) bits.push('<span class="warn">' + esc(c.failed) + ' failed</span>');
    if (c.superseded) bits.push(esc(c.superseded) + ' superseded');
    if (c.banned) bits.push(esc(c.banned) + ' banned');
    for (const a of d.accounts || []) bits.push('<span title="uploads through the ' + esc(a.label) + ' Google project today">' + esc(a.label) + ' ' + esc(a.used) + '/' + esc(a.cap) + '</span>');
    if (perDay > 0 && c.pending) bits.push('<span title="' + esc(c.pending) + ' sets at ' + esc(perDay) + ' uploads a day">backlog ≈ ' + Math.ceil(c.pending / perDay) + ' day' + (c.pending > perDay ? 's' : '') + ' at ' + esc(perDay) + '/day</span>');
    if (d.lastPoll) bits.push('<span title="refreshed at most every 10 min">mkvid seen ' + esc(rel(d.lastPoll.at)) + '</span>');
    const olds = d.oldVideos || [];
    if (olds.length) bits.push('<span class="warn">' + olds.length + ' replaced video' + (olds.length === 1 ? '' : 's') + ' not deleted yet</span>');
    if (filtered()) bits.unshift('<strong>' + esc(queueTotal + settledTotal) + ' match this filter</strong>');
    $summary.innerHTML = bits.join(' · ');
    $clear.hidden = !filtered();

    $recreateOld.hidden = !(d.oldStyleCount > 0);
    $recreateOld.textContent = 'Recreate all old-style videos (' + (d.oldStyleCount || 0) + ')';
  }

  // ── rows ──
  // Reorder / ban controls on a waiting row. The list reloads after each, so
  // positions stay honest.
  const ACTS = [['top', '⤒', 'Move to the top'], ['up', '↑', 'Move up one'], ['down', '↓', 'Move down one'], ['bottom', '⤓', 'Move to the bottom'], ['ban', '✕', 'Never upload this set via mkvid']];
  function actsHtml(id) {
    return '<span class="mk-acts">' + ACTS.map((a) => '<button type="button" class="mk-act' + (a[0] === 'ban' ? ' ban' : '') + '" data-act="' + a[0] + '" data-id="' + esc(id) + '" title="' + a[2] + '" aria-label="' + a[2] + '">' + a[1] + '</button>').join('') + '</span>';
  }

  function rowHtml(r, withPos) {
    const backoff = r.status === 'pending' && r.notBefore && r.notBefore > Date.now() / 1000;
    const meta = [r.setDate, r.artistLabel || r.artistName || r.slug, r.sourceLabel || r.source].filter(Boolean).map(esc);
    if (r.status === 'pending' && r.readiness) meta.push(mkWhy(r.readiness, true, capped));
    else if (backoff) meta.push('retry ' + untilTime(r.notBefore));
    else if (r.status !== 'pending') meta.push(esc(rel(r.updatedAt)));
    if (r.replacesVideoId) meta.push('<span class="why">recreating</span>');
    if (r.status === 'done' && r.oldStyle) meta.push('old style');
    if (r.error && (r.status !== 'pending' || backoff)) meta.push('<span class="flag">' + esc(r.error) + '</span>');
    const lead = withPos && r.position != null
      ? '<span class="mk-pos">#' + esc(r.position) + '</span>'
      : '<span class="badge ' + (BADGE[r.status] || 'neutral') + '">' + esc(r.status === 'claimed' ? 'rendering' : r.status) + '</span>';
    return '<div class="mk-row' + (r.status === 'failed' ? ' err' : '') + '" data-id="' + esc(r.id) + '">' + lead +
      '<div class="mk-main"><button type="button" class="mk-title" data-open="' + esc(r.id) + '">' + esc(titleOf(r)) + '</button>' +
      '<div class="mk-meta">' + meta.join(' · ') + '</div></div>' +
      (r.videoId ? link(videoHref(r), 'watch', 'mk-watch') : '') +
      (withPos ? actsHtml(r.id) : '') + '</div>';
  }

  // A video a recreation replaced: out of the playlists, waiting for mkvid to delete it (the cron retries).
  function oldRowHtml(o) {
    const meta = [esc(TK.fmt.setLabel(o.setUrl)), o.replacedBy === 'banned' ? 'banned while it rendered' : 'replaced by <span class="mono">' + esc(o.replacedBy) + '</span>'];
    if (o.state === 'refused') meta.push('<span class="flag">mkvid refused: ' + esc(o.lastError || '') + '</span>');
    else if (o.lastError) meta.push('<span class="flag">' + esc(o.lastError) + '</span>', 'try ' + esc((o.attempts || 0) + 1) + ' ' + untilTime(o.nextTryAt));
    else meta.push('deleting');
    return '<div class="mk-row old' + (o.state === 'refused' || o.attempts > 0 ? ' err' : '') + '">' +
      '<span class="badge ' + (o.state === 'refused' ? 'bad' : 'info') + '">' + esc(o.state) + '</span>' +
      '<div class="mk-main"><span class="mono">' + esc(o.videoId) + '</span><div class="mk-meta">' + meta.join(' · ') + '</div></div>' +
      link('https://youtu.be/' + encodeURIComponent(o.videoId), 'watch', 'mk-watch') +
      ' <button type="button" class="btn small" data-old="' + esc(o.videoId) + '">Retry now</button></div>';
  }

  const showing = (shown, total) => (total > shown ? ' · showing ' + shown + ' of ' + total : '');
  function moreHtml(section, left) {
    return '<button type="button" class="btn mk-more" data-more="' + section + '">' + (left > 0 ? 'Load ' + Math.min(left, MK_PAGE) + ' more (' + left + ' left)' : 'Load more') + '</button>';
  }
  const card = (rows) => '<div class="tk-card mk-list">' + rows.join('') + '</div>';
  const emptyHtml = (text) => '<div class="empty">' + esc(text) + '</div>';

  function renderLists() {
    byId = {};
    for (const r of queue.concat(settled)) byId[r.id] = r;
    const active = settled.filter((r) => r.status === 'claimed');
    const finished = settled.filter((r) => r.status !== 'claimed');
    const olds = (header && header.oldVideos) || [];
    const none = filtered() ? 'No requests match this filter.' : 'No sets queued for mkvid yet.';

    const q = [];
    if (active.length) q.push('<div class="mk-grp">Rendering now</div>', card(active.map((r) => rowHtml(r, false))));
    if (queue.length) {
      // Positions come from the API: places in the whole queue, which neither
      // the filter nor the page boundary shifts.
      q.push('<div class="mk-grp">Up next · newest set first' + showing(queue.length, queueTotal) + '</div>', card(queue.map((r) => rowHtml(r, true))));
      if (queueCursor) q.push(moreHtml('queue', queueTotal - queue.length));
    }
    $lists.queue.innerHTML = q.length ? q.join('') : emptyHtml(finished.length && !filtered() ? 'Nothing is waiting for mkvid.' : none);

    const s = [];
    if (finished.length) {
      s.push('<div class="mk-grp">Finished' + showing(finished.length, settledTotal - active.length) + '</div>', card(finished.map((r) => rowHtml(r, false))));
      if (settledCursor) s.push(moreHtml('settled', settledTotal - settled.length));
    }
    $lists.settled.innerHTML = s.length ? s.join('') : emptyHtml(filtered() ? 'No requests match this filter.' : 'Nothing has finished yet.');

    $lists.old.innerHTML = olds.length
      ? '<div class="mk-grp">Replaced videos to delete from YouTube</div>' + card(olds.map(oldRowHtml))
      : emptyHtml('No replaced videos are waiting to be deleted.');

    renderTabs(false, { queue: queueTotal + active.length, settled: Math.max(0, settledTotal - active.length), old: olds.length });
  }

  // ── tabs (role=tablist, arrow keys) ──
  // Built once, then updated in place, so a finished load never takes focus off a tab.
  let tabCounts = { queue: null, settled: null, old: null };
  let tabsBuilt = false;
  function renderTabs(focus, counts) {
    if (counts) tabCounts = counts;
    if (!tabsBuilt) {
      $tabs.innerHTML = TABS.map((t) => '<button type="button" role="tab" id="mk-tab-' + t[0] + '" data-tab="' + t[0] + '" aria-controls="mk-p-' + t[0] + '" aria-selected="' + (tab === t[0]) + '" tabindex="' + (tab === t[0] ? '0' : '-1') + '">' +
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
  function selectTab(name, focus) { tab = name; sync(); renderTabs(focus); }
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

  // ── loading ──
  // section 'queue' / 'settled' appends that list's next page; anything else
  // (a refresh, a filter change, an action) reloads both lists and the header.
  async function load(section) {
    const sec = section === 'queue' || section === 'settled' ? section : 'all';
    let stale;
    if (sec === 'all') {
      const my = ++allSeq;
      allPending = true;
      stale = () => my !== allSeq;
    } else {
      if (allPending) return;
      const my = ++appendSeq[sec], at = allSeq;
      stale = () => my !== appendSeq[sec] || at !== allSeq;
    }
    const res = await TK.api.get('/ui/api/mkvid?' + params(sec));
    if (stale()) return;
    if (sec === 'all') allPending = false;
    if (!res.ok || !res.data) {
      const msg = 'mkvid status unavailable: ' + TK.errText(res, 'failed (' + res.status + ')');
      if (sec === 'all') { $errText.textContent = msg; $err.hidden = false; $summary.textContent = ''; }
      else TK.toast(msg, 'bad');
      return;
    }
    $err.hidden = true;
    const d = res.data;
    if (sec !== 'settled') {
      queue = sec === 'all' ? (d.queue || []) : queue.concat(d.queue || []);
      queueCursor = d.queueCursor || null;
      queueTotal = d.queueTotal || 0;
    }
    if (sec !== 'queue') {
      settled = sec === 'all' ? (d.settled || []) : settled.concat(d.settled || []);
      settledCursor = d.settledCursor || null;
      settledTotal = d.settledTotal || 0;
    }
    if (sec === 'all') { header = d; djOptions(d.djs); accountOptions(d.accounts); }
    renderHeader();
    renderLists();
  }

  async function post(url, body, what) {
    const res = await TK.api.post(url, body);
    if (!res.ok) TK.toast(what + ' failed (' + res.status + ')', 'bad', TK.errText(res, ''));
    return res;
  }

  // ── row clicks: move / ban, load more, Retry now, else the detail drawer ──
  async function onListClick(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    const act = t.closest('button[data-act]');
    if (act) {
      e.stopPropagation();
      const row = act.closest('.mk-row');
      const btns = row ? row.querySelectorAll('button[data-act]') : [act];
      for (const b of btns) b.disabled = true;
      try {
        const id = encodeURIComponent(act.dataset.id);
        if (act.dataset.act === 'ban') await post('/ui/api/mkvid/ban/' + id, {}, 'ban');
        else await post('/ui/api/mkvid/move/' + id, { to: act.dataset.act }, 'move');
        await load('all');
      } finally { for (const b of btns) b.disabled = false; }
      return;
    }
    const more = t.closest('button[data-more]');
    if (more) { e.stopPropagation(); TK.busy(more, 'Loading…', () => load(more.dataset.more)); return; }
    const old = t.closest('button[data-old]');
    if (old) {
      e.stopPropagation();
      TK.busy(old, 'Retrying…', async () => {
        await post('/ui/api/mkvid/old-videos/' + encodeURIComponent(old.dataset.old) + '/retry', {}, 'delete retry');
        await load('all');
      });
      return;
    }
    if (t.closest('a')) return;
    const row = t.closest('.mk-row[data-id]');
    if (row && byId[row.dataset.id]) openDetail(byId[row.dataset.id]);
  }
  for (const k of Object.keys($lists)) $lists[k].addEventListener('click', onListClick);

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
      ['status', '<span class="badge ' + (BADGE[r.status] || 'neutral') + '">' + esc(r.status) + '</span>' + (r.error ? ' <span class="warn">' + esc(r.error) + '</span>' : '')],
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
      btns.push('<button type="button" class="btn" data-do="retry">' + (r.status === 'claimed' ? 'Release &amp; retry' : r.status === 'banned' ? 'Unban' : 'Retry') + '</button>');
    }
    if (r.readiness && r.readiness.state === 'waiting_ids' && !r.skipIdWait) {
      btns.push('<button type="button" class="btn" data-do="render-now" title="Render with the IDs shown instead of waiting until the set is 7 days old">Render now</button>');
    }
    if (r.status === 'done' && r.videoId && !r.replacesVideoId) {
      btns.push('<button type="button" class="btn danger" data-do="recreate" title="Render the set again (back of the queue, counts against the daily cap); the old video is deleted once the new one is in the playlists">Delete and recreate</button>');
    }
    btns.push('<a class="btn" href="/ui/set?url=' + encodeURIComponent(r.setUrl || '') + '">Open set page</a>');
    // A failed action's reason, shown here: a toast would sit under the modal drawer.
    out.push('<div class="err-state mk-derr" role="alert" data-derr hidden></div>');
    out.push('<div class="actions">' + btns.join('') + '</div>');
    return out.join('');
  }

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
      const url = what === 'retry' ? '/ui/api/mkvid/retry/' + id : what === 'render-now' ? '/ui/api/mkvid/render-now/' + id : '/ui/api/mkvid/recreate/' + id;
      if (errLine) errLine.hidden = true;
      const res = await TK.busy(b, 'Working…', () => TK.api.post(url, {}));
      if (res && res.ok) { TK.drawer.close(); await load('all'); return; }
      // Failed: say why in the drawer, which stays open, and reload, as the old
      // panel did; the drawer then shows the request as it is now.
      const why = TK.errText(res, '');
      const msg = (what === 'render-now' ? 'render now' : what) + ' failed (' + (res ? res.status : 0) + ')' + (why ? ': ' + why : '');
      if (errLine) { errLine.textContent = msg; errLine.hidden = false; }
      await load('all');
      const dlg = $('tk-drawer');
      if (dlg && dlg.open && drawerFor === r.id) openDetail(byId[r.id] || r, msg);
    };
  }

  // ── header actions ──
  $refresh.addEventListener('click', () => { startRun(); TK.busy($refresh, 'Refreshing…', () => load('all')); });
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
    if (reload) await load('all');
  });
  $errRetry.addEventListener('click', () => TK.busy($errRetry, 'Retrying…', () => load('all')));

  // ── filters ──
  function changed() { sync(); load('all'); }
  $status.addEventListener('change', () => { f.status = pick($status.value, STATUSES); changed(); });
  $source.addEventListener('change', () => { f.source = pick($source.value, SOURCES); changed(); });
  $account.addEventListener('change', () => { f.account = pick($account.value, ACCOUNTS); changed(); });
  $dj.addEventListener('change', () => { f.dj = $dj.value || ''; changed(); });
  let qTimer = null;
  $q.addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => { f.q = String($q.value || '').slice(0, 120); changed(); }, 250); });
  $clear.addEventListener('click', () => {
    f.q = ''; f.status = ''; f.source = ''; f.account = ''; f.dj = '';
    $q.value = ''; $status.value = ''; $source.value = ''; $account.value = ''; $dj.value = '';
    changed();
  });

  renderTabs(false);
  load('all');
  startRun();
})();
`

export const MKVID_PAGE_HTML = shell({
  nav: 'mkvid',
  title: 'mkvid',
  description: 'Sets with no YouTube recording but a SoundCloud or hearthis.at one, rendered and uploaded by mkvid. Where each request stands and why nothing is uploading.',
  actions: '<button type="button" id="mk-recreate-old" class="btn" hidden title="Delete and recreate every done video made with a style other than scene">Recreate all old-style videos</button><button type="button" id="mk-refresh" class="btn">Refresh</button>',
  body: BODY,
  css: CSS,
  js: JS,
})
