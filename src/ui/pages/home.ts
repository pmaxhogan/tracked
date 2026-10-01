// Home: four status tiles (Fetching, YouTube, mkvid, Challenges), what needs
// the owner's attention (each row links to its fix), the last six requests and
// the last six playlist additions side by side, and the quick actions (Sync
// all, Backfill combined, Run hygiene compare). Every source loads in parallel
// and fails on its own. Data: GET /ui/api/ban/status, /ui/api/pool/status,
// /ui/api/pool/challenges, /ui/api/youtube/status, /ui/api/combined,
// /ui/api/mkvid?limit=1, /ui/api/removals?limit=1, /ui/api/list +
// /ui/api/state/:slug (four at a time), /ui/api/audit?limit=6 and
// /ui/api/playlist-additions?limit=6; the detail drawers use
// /ui/api/audit-detail and /ui/api/playlist-addition-detail.
//
// Everything renders through innerHTML strings with delegated clicks (the
// tests run this script in a stub DOM without appendChild), and every
// upstream value goes through TK.esc.
import { shell } from '../shell'
import type { UiPage } from './index'
import { MKVID_STATE_JS } from './mkvid-state'
import { DJ_ACTIONS_CSS, DJ_ACTIONS_JS } from './dj-actions'

const ACTIONS = /* html */ `
<button id="h-sync-all" type="button" class="btn">Sync all</button>
<button id="h-backfill" type="button" class="btn">Backfill combined</button>
<button id="h-compare" type="button" class="btn" title="Compare every playlist with its last snapshot now (playlist hygiene)">Run hygiene compare</button>`

const tile = (id: string, href: string, label: string) => /* html */ `
  <a class="tk-tile h-tile" href="${href}"><div class="k">${label}</div><div id="${id}"><div class="v"><span class="skel w"></span></div><div class="s">&nbsp;</div></div></a>`

const BODY = /* html */ `
<div class="tk-tiles h-tiles">
  ${tile('t-fetch', '/ui/pool', 'Fetching')}
  ${tile('t-yt', '/ui/playlists', 'YouTube')}
  ${tile('t-mk', '/ui/mkvid', 'mkvid')}
  ${tile('t-chal', '/ui/captcha', 'Challenges')}
</div>
<div class="tk-card h-attn-card">
  <h2>Needs attention</h2>
  <ul id="attn" class="h-attn"></ul>
  <div id="attn-empty" class="muted">Checking…</div>
  <div id="attn-err" class="error" hidden></div>
</div>
<div class="tk-grid two h-recent">
  <div class="tk-card">
    <h2>Recent requests</h2>
    <div id="req-list" class="h-list"></div>
    <div id="req-empty" class="muted">Loading…</div>
  </div>
  <div class="tk-card">
    <h2>Recent playlist additions</h2>
    <div id="pl-list" class="h-list"></div>
    <div id="pl-empty" class="muted">Loading…</div>
  </div>
</div>
`

const CSS = /* css */ `
  .h-tiles { grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr)); }
  .h-tile:hover { border-color: var(--accent); }
  .h-tile .v.small { font-size: var(--fs-md); }
  .h-tile .s.bad, .h-tile .v.bad { color: var(--danger); }
  .h-tile .v.ok { color: var(--ok); }
  .h-tile .v.wait { color: var(--warn); }
  .skel.w { width: 5rem; display: inline-block; }
  .h-attn-card { margin-bottom: var(--sp-4); }
  .h-attn { list-style: none; margin: 0; padding: 0; }
  .h-attn li + li { border-top: 1px solid var(--line); }
  .h-attn a { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px var(--sp-2); padding: 8px 4px; color: var(--fg); text-decoration: none; }
  .h-attn a:hover { background: var(--elev); }
  .h-attn .txt { font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
  .h-attn .sub { color: var(--muted); font-size: var(--fs-sm); min-width: 0; overflow-wrap: anywhere; flex: 1 1 12rem; }
  .h-attn .go { margin-left: auto; color: var(--accent); font-size: var(--fs-sm); white-space: nowrap; }
  #attn-err { margin-top: var(--sp-2); }
  .h-list { display: grid; }
  .h-row { display: flex; align-items: center; gap: var(--sp-2); width: 100%; font: inherit; color: var(--fg); background: none; border: 0; border-bottom: 1px solid var(--line); padding: 8px 4px; text-align: left; cursor: pointer; min-width: 0; }
  .h-row:last-child { border-bottom: 0; }
  .h-row:hover { background: var(--elev); }
  .h-row.err { box-shadow: inset 3px 0 0 var(--danger); }
  .h-row .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-sm); }
  .h-row .via, .h-row .when, .h-row .pos, .h-row .vid { color: var(--muted); font-size: var(--fs-xs); white-space: nowrap; }
  .h-row .vid { font-family: var(--mono); }
  .h-row .pos { font-variant-numeric: tabular-nums; }
  .h-row .flag { color: var(--danger); font-weight: 700; }
  .h-grp { color: var(--subtle); font-size: var(--fs-xs); font-weight: 600; text-transform: uppercase; letter-spacing: .06em; margin: var(--sp-3) 0 var(--sp-2); }
  .h-grp:first-child { margin-top: 0; }
  .h-dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px var(--sp-3); margin: 0; font-size: var(--fs-sm); }
  .h-dl dt { color: var(--muted); }
  .h-dl dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .h-dl ol { margin: 0; padding-left: 1.1rem; }
  .h-dl .warn, .h-detail .warn { color: var(--danger); }
  .h-dl .when { color: var(--subtle); }
  @media (max-width: 599px) {
    .h-row { flex-wrap: wrap; }
    .h-row .title { flex-basis: 60%; }
  }
${DJ_ACTIONS_CSS}`

const JS = /* js */ `
(() => {
${MKVID_STATE_JS}
${DJ_ACTIONS_JS}
  const $ = TK.$, esc = TK.esc, clock = TK.fmt.clock, setLabel = TK.fmt.setLabel;
  const isoOf = (sec) => { try { return new Date(sec * 1000).toISOString(); } catch (e) { return ''; } };
  const meter = (used, cap) => cap > 0 ? '<div class="tk-meter"><i style="width:' + Math.min(100, Math.round((used / cap) * 100)) + '%"></i></div>' : '';
  const failText = (res) => TK.errText(res, 'unavailable (' + (res.status || 'offline') + ')');
  function tileHtml(id, v, s, opts) {
    opts = opts || {};
    const el = $(id);
    if (!el) return;
    el.innerHTML = '<div class="v' + (opts.vcls ? ' ' + opts.vcls : '') + '">' + v + '</div><div class="s' + (opts.scls ? ' ' + opts.scls : '') + '">' + (s || '&nbsp;') + '</div>' + (opts.meter || '');
  }
  function link(u, label) {
    // Only http(s) becomes a link; anything else renders as escaped text.
    if (!u) return '—';
    const h = TK.safeHref(u);
    if (!h) return esc(u);
    return '<a href="' + esc(h) + '" target="_blank" rel="noreferrer noopener">' + esc(label || u) + '</a>';
  }

  // ── needs attention ──
  // One entry per source: undefined while loading, { items } or { error }.
  const ORDER = ['ban', 'challenges', 'accounts', 'holds', 'mkvid', 'djs'];
  const NAMES = { ban: 'fetch status', challenges: 'challenges', accounts: 'pool accounts', holds: 'held playlists', mkvid: 'mkvid', djs: 'DJ syncs' };
  const attn = {};
  function setAttn(key, val) { attn[key] = val; renderAttn(); }
  function item(href, kind, text, sub, go) { return { href, kind, text, sub, go }; }
  function renderAttn() {
    const items = [], failed = [];
    let pending = false;
    for (const k of ORDER) {
      const a = attn[k];
      if (a === undefined) { pending = true; continue; }
      if (a.error) { failed.push(NAMES[k] + ' (' + a.error + ')'); continue; }
      for (const it of a.items) items.push(it);
    }
    $('attn').innerHTML = items.map((it) => '<li><a href="' + esc(it.href) + '"><span class="badge ' + esc(it.kind) + '">' + (it.kind === 'bad' ? 'fix' : 'check') + '</span>' +
      '<span class="txt">' + esc(it.text) + '</span>' + (it.sub ? '<span class="sub">' + esc(it.sub) + '</span>' : '') +
      '<span class="go">' + esc(it.go || 'Open') + ' →</span></a></li>').join('');
    const $empty = $('attn-empty'), $err = $('attn-err');
    $empty.hidden = items.length > 0;
    $empty.textContent = pending ? 'Checking…' : failed.length ? 'Nothing found in the checks that loaded.' : 'Nothing needs you right now.';
    $err.hidden = !failed.length;
    $err.textContent = failed.length ? 'Could not check: ' + failed.join(', ') + '.' : '';
  }

  // ── Fetching tile: ban status + pool budget ──
  let banS, poolS; // undefined = loading, null = failed (with banErr / poolErr), object = loaded
  let banErr = '', poolErr = '';
  function renderFetch() {
    if (banS === undefined && poolS === undefined) return;
    let v, vcls = '', s = [];
    if (banS) {
      if (banS.pause) { v = 'Paused'; vcls = 'bad'; s.push('until ' + esc(TK.fmt.time(banS.pause.until)) + (banS.pause.reason ? ' (' + esc(banS.pause.reason) + ')' : '')); }
      else if (banS.home) { v = 'Blocked'; vcls = 'bad'; s.push('since ' + esc(TK.fmt.time(banS.home.since))); }
      else if (banS.poolConfigured === false) { v = 'Pool offline'; vcls = 'wait'; }
      else { v = 'Active'; vcls = 'ok'; }
    } else if (banS === null) { v = 'Unknown'; s.push('<span class="bad">status ' + esc(banErr) + '</span>'); }
    else v = '<span class="skel w"></span>';
    let m = '';
    if (poolS) {
      const accts = (poolS.accounts || []).filter((a) => a.state !== 'retired');
      const fetching = accts.filter((a) => !a.passive && !a.flagged && (a.state === 'active' || a.state === 'warming' || a.state === 'ok' || a.state === 'healthy' || a.state === 'ramping'));
      const budget = fetching.reduce((n, a) => n + (Number(a.budget) || 0), 0);
      const used = fetching.reduce((n, a) => n + (Number(a.usedToday) || 0), 0);
      s.push(used + ' / ' + budget + ' pages today');
      m = meter(used, budget);
    } else if (poolS === null) s.push('<span class="bad">pool ' + esc(poolErr) + '</span>');
    tileHtml('t-fetch', v, s.join(' · '), { vcls, meter: m });
  }

  async function loadBan() {
    const res = await TK.api.get('/ui/api/ban/status');
    if (!res.ok || !res.data || typeof res.data !== 'object') { banS = null; banErr = failText(res); renderFetch(); setAttn('ban', { error: banErr }); return; }
    banS = res.data;
    renderFetch();
    const items = [];
    if (banS.pause) items.push(item('/ui/settings', 'bad', 'Fetching from 1001tracklists is paused', 'until ' + TK.fmt.time(banS.pause.until) + (banS.pause.reason ? ' (' + banS.pause.reason + ')' : ''), 'Settings'));
    if (banS.home) items.push(item('/ui/settings', 'bad', '1001tracklists is blocking the tracked sessions' + (banS.home.simulated ? ' (simulated)' : ''), 'since ' + TK.fmt.time(banS.home.since) + ' (' + TK.fmt.ago(banS.home.since) + ')', 'Settings'));
    setAttn('ban', { items });
  }

  async function loadPool() {
    const res = await TK.api.get('/ui/api/pool/status');
    const st = res.ok && res.data && res.data.status;
    if (!st) { poolS = null; poolErr = failText(res); renderFetch(); setAttn('accounts', { error: poolErr }); return; }
    poolS = st;
    renderFetch();
    const items = (st.accounts || []).filter((a) => a.flagged && a.state !== 'retired').map((a) =>
      item('/ui/pool', 'bad', String(a.id) + ' is flagged', a.flagReason ? String(a.flagReason).replace(/_/g, ' ') : '', 'Pool'));
    setAttn('accounts', { items });
  }

  // ── Challenges tile ──
  async function loadChallenges() {
    const res = await TK.api.get('/ui/api/pool/challenges');
    const list = res.ok && res.data && res.data.challenges;
    if (!Array.isArray(list)) { const e = failText(res); tileHtml('t-chal', '—', esc(e), { scls: 'bad' }); setAttn('challenges', { error: e }); return; }
    const open = list.filter((c) => c && c.state === 'pending' && c.ready !== false);
    TK.navCount(open.length);
    const left = (iso) => { const t = Date.parse(iso); if (isNaN(t)) return ''; return t <= Date.now() ? 'expired' : TK.fmt.until(t / 1000).replace(/^in /, '') + ' left'; };
    const exp = open.map((c) => Date.parse(c.expiresAt)).filter((t) => !isNaN(t)).sort((a, b) => a - b);
    const oldest = exp.length ? 'oldest: ' + left(new Date(exp[0]).toISOString()) : open.length ? 'no expiry known' : 'nothing waiting';
    tileHtml('t-chal', String(open.length) + ' open', esc(oldest), { vcls: open.length ? 'bad' : '' });
    setAttn('challenges', { items: open.map((c) => item('/ui/captcha/' + encodeURIComponent(c.id), 'bad',
      'Solve ' + (c.type === 'checkbox' ? 'a checkbox challenge' : 'an image captcha'),
      [c.accountId || 'no account yet', c.expiresAt ? left(c.expiresAt) : ''].filter(Boolean).join(' · '), 'Solve')) });
  }

  // ── YouTube tile: channel + combined inserts ──
  let ytS, cmbS, ytErr = '', cmbErr = '';
  function renderYt() {
    if (ytS === undefined && cmbS === undefined) return;
    let v, vcls = '';
    if (ytS) v = ytS.connected ? esc(ytS.channelTitle || 'connected') : 'Not connected';
    else if (ytS === null) v = 'Unknown';
    else v = '<span class="skel w"></span>';
    if (ytS && !ytS.connected) vcls = 'bad';
    const s = [];
    if (ytS === null) s.push('<span class="bad">' + esc(ytErr) + '</span>');
    let m = '';
    if (cmbS && cmbS.connected !== false) {
      const cap = Number(cmbS.dailyInsertCap) || 0, used = Number(cmbS.dailyInsertsUsed) || 0;
      s.push(used + ' / ' + cap + ' combined inserts today' + (Number(cmbS.missingTotal) ? ' · ' + Number(cmbS.missingTotal) + ' still to add' : ''));
      m = meter(used, cap);
    } else if (cmbS === null) s.push('<span class="bad">combined ' + esc(cmbErr) + '</span>');
    tileHtml('t-yt', v, s.join(' · '), { vcls: vcls + (ytS && ytS.connected ? ' small' : ''), meter: m });
  }
  async function loadYt() {
    const res = await TK.api.get('/ui/api/youtube/status');
    if (!res.ok || !res.data || typeof res.data !== 'object') { ytS = null; ytErr = failText(res); } else ytS = res.data;
    renderYt();
  }
  async function loadCombined() {
    const res = await TK.api.get('/ui/api/combined');
    if (!res.ok || !res.data || typeof res.data !== 'object') { cmbS = null; cmbErr = failText(res); } else cmbS = res.data;
    renderYt();
  }

  // ── mkvid tile ──
  async function loadMkvid() {
    const res = await TK.api.get('/ui/api/mkvid?limit=1');
    const d = res.ok && res.data && typeof res.data === 'object' ? res.data : null;
    if (!d) { const e = failText(res); tileHtml('t-mk', '—', esc(e), { scls: 'bad' }); setAttn('mkvid', { error: e }); return; }
    const st = mkState(d), eff = mkEffective(d);
    const caps = (d.accounts || []).map((a) => esc(a.label || a.account) + ' ' + esc(a.used) + ' / ' + esc(a.cap)).join(' · ');
    tileHtml('t-mk', esc(st[1]), caps || esc(st[2]), { vcls: 'small ' + st[0], meter: meter(eff.used, eff.cap) });
    const items = [];
    const c = d.counts || {};
    if (c.failed) items.push(item('/ui/mkvid?status=failed&tab=settled', 'bad', c.failed + ' mkvid request' + (c.failed === 1 ? '' : 's') + ' failed', 'Retry or ban them on the mkvid page', 'mkvid'));
    const olds = d.oldVideos || [];
    if (olds.length) items.push(item('/ui/mkvid?tab=old', 'warn', olds.length + ' old video' + (olds.length === 1 ? ' is' : 's are') + ' not deleted from YouTube yet', 'A recreation replaced ' + (olds.length === 1 ? 'it' : 'them'), 'Old videos'));
    if (st[0] === 'bad') items.push(item('/ui/mkvid', 'bad', 'mkvid: ' + st[1], st[2], 'mkvid'));
    setAttn('mkvid', { items });
  }

  // ── held playlists ──
  async function loadHolds() {
    const res = await TK.api.get('/ui/api/removals?limit=1');
    const holds = res.ok && res.data && res.data.holds;
    if (!Array.isArray(holds)) { setAttn('holds', { error: failText(res) }); return; }
    setAttn('holds', { items: holds.map((h) => item('/ui/removed', 'bad',
      (h.kind === 'combined' ? 'Combined playlist' : (h.slug || h.playlistId || 'A playlist')) + ' is held',
      (h.missing || 0) + ' of ' + (h.expected || 0) + ' missing' + (h.at ? ' since ' + TK.fmt.time(isoOf(h.at)) : ''), 'Removed videos')) });
  }

  // ── DJs whose last sync errored ──
  let djSlugs = null;
  async function loadDjs() {
    const res = await TK.api.get('/ui/api/list');
    const subs = res.ok && res.data && res.data.subscriptions;
    if (!Array.isArray(subs)) { setAttn('djs', { error: failText(res) }); return; }
    djSlugs = subs.map((s) => s.slug);
    const errs = [];
    let failedStates = 0;
    await DJA.pool(djSlugs, 4, async (slug) => {
      const s = await DJA.loadState(slug);
      if (s.failed) { failedStates++; return; }
      if (s.state && s.state.lastError) errs.push(item('/ui/dj/' + encodeURIComponent(slug), 'bad', (s.state.artistName || slug) + ': last sync failed', String(s.state.lastError), 'DJ'));
    });
    errs.sort((a, b) => (a.href < b.href ? -1 : 1));
    setAttn('djs', failedStates && !errs.length ? { error: failedStates + ' sync state' + (failedStates === 1 ? '' : 's') + ' unavailable' } : { items: errs });
  }

  // ── recent activity ──
  const PROBLEM = new Set(['no_video', 'no_tracklist', 'upstream_error']);
  const PL_PROBLEM = new Set(['failed', 'abandoned']);
  const BIG_SKEW = 600; // |pos − track start| over 10 min → flag as suspicious
  const BADGE = { ok: 'ok', unidentified: 'warn', no_video: 'bad', no_tracklist: 'bad', upstream_error: 'bad',
    added: 'ok', duplicate: 'neutral', replaced: 'info', no_youtube: 'warn', failed: 'bad', abandoned: 'bad' };
  const badge = (st) => '<span class="badge ' + (BADGE[st] || 'neutral') + '">' + esc(st || '?') + '</span>';
  let reqRecords = [], plRecords = [];

  function dl(pairs) {
    return '<dl class="h-dl">' + pairs.filter(Boolean).map((p) => '<dt>' + esc(p[0]) + '</dt><dd>' + p[1] + '</dd>').join('') + '</dl>';
  }

  function renderReq() {
    $('req-list').innerHTML = reqRecords.map((r, i) => {
      const skewBad = r.skew != null && Math.abs(r.skew) > BIG_SKEW;
      return '<button type="button" class="h-row' + (PROBLEM.has(r.status) || r.impossible ? ' err' : '') + '" data-i="' + i + '">' + badge(r.status) +
        '<span class="title">' + esc(r.title || '(no title)') + '</span>' +
        (r.via ? '<span class="via">via ' + esc(r.via) + '</span>' : '') +
        '<span class="pos">' + clock(r.cs) + (r.dur ? ' / ' + clock(r.dur) : '') +
          (r.impossible ? ' <span class="flag" title="reported position is past the end of the video">!</span>' : '') +
          (skewBad ? ' <span class="flag" title="large gap between reported position and selected track start">Δ' + clock(r.skew) + '</span>' : '') +
        '</span>' +
        '<span class="when" title="' + esc(r.t) + '">' + esc(TK.fmt.rel(r.t)) + '</span></button>';
    }).join('');
  }

  function auditDetailHtml(r) {
    // Legacy records (pre-metadata) stored fields flat; lift them into the
    // nested shape the renderer expects so old history still displays.
    if (!r.input) {
      r = {
        t: r.t, reqId: r.reqId, status: r.status, message: r.message,
        input: { videoTitle: r.videoTitle, videoUrl: r.videoUrl, currentSeconds: r.currentSeconds, videoDurationSeconds: r.videoDurationSeconds },
        impossibleTimestamp: r.impossibleTimestamp,
        youtube: r.youtube || { videoId: null, videoUrl: r.videoUrl, matchTitle: null, error: null },
        search: r.search || { attempts: [], via: r.tracklistVia || null, tracklistUrl: r.tracklistUrl || null },
        select: r.select || ((r.currentStartSeconds != null || r.currentTracks) ? {
          currentStartSeconds: r.currentStartSeconds != null ? r.currentStartSeconds : null,
          currentSkewSeconds: (r.currentStartSeconds != null && r.currentSeconds != null) ? r.currentSeconds - r.currentStartSeconds : null,
          trackCount: null, unidentifiedCount: null, currentTracks: r.currentTracks || [],
        } : null),
        meta: r.meta || {},
      };
    }
    const inp = r.input || {}, yt = r.youtube || {}, se = r.search || {}, sel = r.select, meta = r.meta || {};
    const out = [];

    out.push('<div class="h-grp">Input</div>');
    out.push(dl([
      ['title', esc(inp.videoTitle) || '—'],
      inp.videoUrl ? ['videoUrl', link(inp.videoUrl)] : null,
      ['position', clock(inp.currentSeconds) + (inp.videoDurationSeconds ? ' / ' + clock(inp.videoDurationSeconds) : '') +
        (r.impossibleTimestamp ? ' <span class="warn">— past end of video (client bug?)</span>' : '')],
    ]));

    out.push('<div class="h-grp">YouTube match</div>');
    out.push(dl([
      ['videoId', yt.videoId ? '<span class="mono">' + esc(yt.videoId) + '</span> ' + link('https://youtu.be/' + yt.videoId, 'open') : '<span class="warn">no match</span>'],
      yt.matchTitle ? ['matched title', esc(yt.matchTitle)] : null,
      yt.error ? ['error', '<span class="warn">' + esc(yt.error) + '</span>'] : null,
    ]));

    out.push('<div class="h-grp">Tracklist search</div>');
    const attempts = (se.attempts && se.attempts.length)
      ? '<ol>' + se.attempts.map((a) => '<li>' + esc(a.via) + ': <span class="mono">' + esc(a.query) + '</span>' + (a.via === se.via ? ' ✓' : '') + '</li>').join('') + '</ol>'
      : '—';
    out.push(dl([
      ['attempts', attempts],
      ['matched via', se.via ? esc(se.via) : '<span class="warn">no tracklist found</span>'],
      se.tracklistUrl ? ['tracklist', link(se.tracklistUrl, 'open')] : null,
    ]));

    if (sel) {
      out.push('<div class="h-grp">Selection</div>');
      const skewBad = sel.currentSkewSeconds != null && Math.abs(sel.currentSkewSeconds) > BIG_SKEW;
      const cur = (sel.currentTracks || []).map((t) => '<li>' + esc(t.startTime) + ' — ' + esc(t.artist) + ' – ' + esc(t.title) + '</li>').join('');
      out.push(dl([
        ['current track start', clock(sel.currentStartSeconds)],
        ['skew (pos − start)', '<span class="' + (skewBad ? 'warn' : '') + '">' + clock(sel.currentSkewSeconds) + '</span>'],
        ['tracks in set', (sel.trackCount != null ? esc(sel.trackCount) : '—') + (sel.unidentifiedCount ? ' (' + esc(sel.unidentifiedCount) + ' unidentified)' : '')],
        ['now playing', cur ? '<ol>' + cur + '</ol>' : '—'],
      ]));
    }

    out.push('<div class="h-grp">Meta</div>');
    out.push(dl([
      ['status', esc(r.status) + (r.message ? ' — ' + esc(r.message) : '')],
      ['when', esc(r.t)],
      ['edge', esc([meta.colo, meta.country].filter(Boolean).join(' · ')) || '—'],
      ['took', meta.totalMs != null ? esc(meta.totalMs) + ' ms' : '—'],
      ['reqId', '<span class="mono">' + esc(r.reqId) + '</span>'],
    ]));
    return out.join('');
  }

  function renderPl() {
    $('pl-list').innerHTML = plRecords.map((r, i) =>
      '<button type="button" class="h-row' + (PL_PROBLEM.has(r.status) ? ' err' : '') + '" data-i="' + i + '">' + badge(r.status) +
      '<span class="title">' + esc(setLabel(r.set)) + '</span>' +
      (r.artist || r.slug ? '<span class="via">' + esc(r.artist || r.slug) + '</span>' : '') +
      (r.vid ? '<span class="vid">' + (r.prev ? esc(r.prev) + ' → ' : '') + esc(r.vid) + '</span>' : '') +
      '<span class="when" title="' + esc(r.t) + '">' + esc(TK.fmt.rel(r.t)) + '</span></button>').join('');
  }

  function plDetailHtml(r) {
    const out = [];
    out.push('<div class="h-grp">Set</div>');
    out.push(dl([
      ['tracklist', link(r.setUrl, setLabel(r.setUrl))],
      ['DJ', esc(r.artistName || r.slug || '—') + (r.slug ? ' <span class="when">(' + esc(r.slug) + ')</span>' : '')],
      ['scraped via', r.via ? esc(r.via) : '—'],
    ]));

    out.push('<div class="h-grp">Playlist</div>');
    out.push(dl([
      ['video', r.videoId
        ? '<span class="mono">' + esc(r.videoId) + '</span> ' + link(r.videoUrl || ('https://youtu.be/' + r.videoId), 'open')
        : (r.status === 'failed' || r.status === 'abandoned')
          ? '<span class="warn">unknown — the set failed before a video was recorded</span>'
          : '<span class="warn">no YouTube recording on the set page</span>'],
      // A recheck found the set's recording swapped on 1001tracklists: this
      // is the one that came out of the playlists.
      r.previousVideoId
        ? ['replaced', '<span class="mono">' + esc(r.previousVideoId) + '</span> ' + link('https://youtu.be/' + r.previousVideoId, 'open')]
        : null,
      ['playlist', r.playlistId
        ? link('https://www.youtube.com/playlist?list=' + encodeURIComponent(r.playlistId), r.playlistTitle || r.playlistId)
        : '—'],
      // How the same video fared in the combined all-artists playlist. A miss
      // here isn't a set failure — the combined backfill re-derives it.
      ['combined', r.combinedStatus
        ? '<span class="' + (r.combinedStatus === 'failed' || r.combinedStatus === 'unavailable' ? 'warn' : '') + '">' + esc(r.combinedStatus) + '</span>'
        : '—'],
    ]));

    out.push('<div class="h-grp">Meta</div>');
    out.push(dl([
      ['status', esc(r.status) + (r.message ? ' — <span class="warn">' + esc(r.message) + '</span>' : '')],
      r.failureCount != null ? ['failures so far', esc(r.failureCount)] : null,
      ['trigger', r.trigger ? esc(r.trigger) : '—'],
      ['when', esc(r.t)],
      ['took', r.meta && r.meta.ms != null ? esc(r.meta.ms) + ' ms' : '—'],
    ]));
    return out.join('');
  }

  async function loadRecent(path, emptyText, onRecords, $empty) {
    const res = await TK.api.get(path);
    const recs = res.ok && res.data && res.data.records;
    if (!Array.isArray(recs)) { $empty.hidden = false; $empty.innerHTML = '<span class="error">' + esc(failText(res)) + '</span>'; return; }
    onRecords(recs.slice(0, 6));
    $empty.hidden = recs.length > 0;
    $empty.textContent = emptyText;
  }
  const loadReq = () => loadRecent('/ui/api/audit?limit=6', 'No requests recorded yet.', (r) => { reqRecords = r; renderReq(); }, $('req-empty'));
  const loadPl = () => loadRecent('/ui/api/playlist-additions?limit=6', 'No playlist additions recorded yet.', (r) => { plRecords = r; renderPl(); }, $('pl-empty'));

  // A row opens the drawer; the detail is fetched on every open, so a failed load retries on reopen.
  let drawerSeq = 0;
  async function openDetail(title, path, render) {
    const seq = ++drawerSeq;
    const body = TK.drawer.open(title, '<span class="muted">loading…</span>');
    const res = await TK.api.get(path);
    if (seq !== drawerSeq || !body) return;
    if (!res.ok && res.status !== 404) { body.innerHTML = '<span class="warn">failed to load detail</span>'; return; }
    const rec = res.data && res.data.record;
    body.innerHTML = '<div class="h-detail">' + (rec ? render(rec) : '<span class="warn">detail not found</span>') + '</div>';
  }
  function rowClicks(listId, records, pathOf, titleOf, render) {
    $(listId).addEventListener('click', (ev) => {
      const b = ev.target && ev.target.closest ? ev.target.closest('[data-i]') : null;
      if (!b) return;
      const r = records()[Number(b.dataset.i)];
      if (r) openDetail(titleOf(r), pathOf(r), render);
    });
  }
  rowClicks('req-list', () => reqRecords, (r) => '/ui/api/audit-detail?key=' + encodeURIComponent(r.key), (r) => r.title || 'Request', auditDetailHtml);
  rowClicks('pl-list', () => plRecords, (r) => '/ui/api/playlist-addition-detail?key=' + encodeURIComponent(r.key), (r) => setLabel(r.set), plDetailHtml);

  // ── quick actions ──
  const $syncAll = $('h-sync-all'), $backfill = $('h-backfill'), $compare = $('h-compare');

  // Serial, never parallel: it keeps us under YouTube quota and the 1001tracklists rate limits.
  $syncAll.addEventListener('click', () => TK.busy($syncAll, 'Syncing all…', async () => {
    const res = await TK.api.get('/ui/api/list');
    const subs = res.ok && res.data && res.data.subscriptions;
    if (!Array.isArray(subs)) { TK.toast(TK.errText(res, 'failed to load (' + res.status + ')'), 'bad'); return; }
    if (!subs.length) { TK.toast('No subscriptions yet.', 'bad'); return; }
    for (const s of subs) {
      const out = await DJA.syncSlug(s.slug, null);
      if (out && out.reauth) { loadYt(); break; }
    }
    loadCombined();
    loadDjs();
  }));

  $backfill.addEventListener('click', () => TK.busy($backfill, 'Backfilling…', async () => {
    const res = await TK.api.post('/ui/api/combined/backfill', {});
    const data = res.data && typeof res.data === 'object' ? res.data : {};
    if (!res.ok) {
      if (res.status === 412 && data.error === 'youtube_reauth_required') { DJA.reauthToast(); loadYt(); return; }
      TK.toast(data.errorMessage || TK.errText(res, 'backfill failed (' + res.status + ')'), 'bad');
      return;
    }
    if (data.ok === false) {
      TK.toast(data.reason === 'no_sources' ? 'nothing to backfill yet — sync a DJ first' : 'backfill skipped: ' + data.reason, 'bad');
    } else {
      TK.toast('combined playlist: added ' + (data.inserted || 0) + ' video' + (data.inserted === 1 ? '' : 's') +
        (data.pending ? ' · ' + data.pending + ' still pending (' + (data.cappedBy || 'capped') + ')' : ''), 'ok');
    }
    await loadCombined();
  }));

  $compare.addEventListener('click', () => TK.busy($compare, 'Comparing…', async () => {
    const res = await TK.api.post('/ui/api/hygiene/run?what=compare', {});
    const data = res.data && typeof res.data === 'object' ? res.data : {};
    if (!res.ok) { TK.toast('hygiene compare: ' + TK.errText(res, 'failed (' + res.status + ')'), 'bad'); return; }
    if (data.skipped) { TK.toast('hygiene compare skipped: ' + TK.errText({ data: { error: data.skipped } }, data.skipped), 'bad'); return; }
    const results = Array.isArray(data.compare) ? data.compare : [];
    const held = results.filter((r) => r && r.status === 'held').length;
    TK.toast('hygiene compare: checked ' + results.length + ' playlist' + (results.length === 1 ? '' : 's') + (held ? ' · ' + held + ' held' : ''),
      held ? 'bad' : 'ok', null, held ? { href: '/ui/removed', text: 'Removed videos' } : null);
    await loadHolds();
  }));

  renderAttn();
  loadBan();
  loadPool();
  loadChallenges();
  loadYt();
  loadCombined();
  loadMkvid();
  loadHolds();
  loadDjs();
  loadReq();
  loadPl();
})();
`

export const HOME_PAGE: UiPage = {
  path: '/',
  html: shell({
    nav: 'home',
    title: 'Home',
    description: 'What is running, what needs you, and what happened last.',
    actions: ACTIONS,
    body: BODY,
    css: CSS,
    js: JS,
    banPage: 'home',
    ownNavCount: true,
  }),
}
