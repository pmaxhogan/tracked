// Home: four status tiles (Fetching, YouTube, mkvid, Challenges), what needs
// the owner's attention (each row links to its fix), the last twelve events of
// the Activity log, and the quick actions (Sync all, Backfill combined, Run
// hygiene compare). Every source loads in parallel and fails on its own.
// Data: GET /ui/api/ban/status, /ui/api/pool/status, /ui/api/pool/challenges,
// /ui/api/youtube/status, /ui/api/combined, /ui/api/mkvid?limit=1,
// /ui/api/removals?limit=1, /ui/api/list + /ui/api/state/:slug (four at a
// time) and /ui/api/activity?limit=12; the detail drawers (shared with the
// Activity page) use /ui/api/audit-detail and /ui/api/playlist-addition-detail.
//
// Everything renders through innerHTML strings with delegated clicks (the
// tests run this script in a stub DOM without appendChild), and every
// upstream value goes through TK.esc.
import { skelHtml } from '../skeleton'
import { shell } from '../shell'
import { tipAttr } from '../tip'
import type { UiPage } from './index'
import { MKVID_STATE_JS } from './mkvid-state'
import { DJ_ACTIONS_CSS, DJ_ACTIONS_JS } from './dj-actions'
import { ACTIVITY_DETAIL_CSS, ACTIVITY_DETAIL_JS } from './activity-detail'
import { ACTIVITY_DRAWER_JS, ACTIVITY_ROW_CSS, ACTIVITY_ROW_JS } from './activity'

const ACTIONS = /* html */ `
<button id="h-sync-all" type="button" class="btn"${tipAttr('Syncs every DJ one after another: looks for new sets and adds their videos. Each DJ is limited to a few fetches per press.')}>Sync all</button>
<button id="h-backfill" type="button" class="btn"${tipAttr('Adds videos missing from the combined playlist (every artist playlist in one), up to the daily YouTube insert cap. This also happens by itself on every scheduler tick.')}>Backfill combined</button>
<button id="h-compare" type="button" class="btn"${tipAttr('Lists every playlist on YouTube now and compares it with what tracked put there, to notice videos you removed by hand. A playlist that lost too many videos is held for your approval. Normally runs every 6 hours.')}>Run hygiene compare</button>`

const tile = (id: string, href: string, label: string, tip: string) => /* html */ `
  <a class="tk-tile h-tile" href="${href}"${tipAttr(tip)}><div class="k">${label}</div><div id="${id}"><div class="v"><span class="skel w"></span></div><div class="s">&nbsp;</div></div></a>`

const BODY = /* html */ `
<div class="tk-tiles h-tiles">
  ${tile('t-fetch', '/ui/pool', 'Fetching', 'Whether fetching from 1001tracklists is running, and how many of today\'s page views the pool of accounts has used.')}
  ${tile('t-yt', '/ui/playlists', 'YouTube', 'The connected YouTube channel and how many of today\'s combined-playlist inserts are used.')}
  ${tile('t-mk', '/ui/mkvid', 'mkvid', 'The mkvid renderer, which makes videos for sets that have no recording, and how much of each Google project\'s daily upload cap is used.')}
  ${tile('t-chal', '/ui/captcha', 'Challenges', 'Captchas that a pool account ran into and that need a person to solve them. Unsolved ones expire.')}
</div>
<div class="tk-card h-attn-card">
  <h2><span class="tip-term"${tipAttr('Problems found by the checks below. A red "fix" is broken or blocking something; an amber "check" is worth a look but nothing is blocked.')}>Needs attention</span></h2>
  <ul id="attn" class="h-attn"></ul>
  <div id="attn-empty" class="muted">Checking…</div>
  <div id="attn-err" class="error" hidden></div>
</div>
<div class="tk-card h-recent">
  <div class="h-recent-head">
    <h2>Recent activity</h2>
    <span class="h-recent-links"><a href="/ui/activity"${tipAttr('The full log of syncs, additions and other events.')}>View all</a><a href="/ui/activity?problems=1"${tipAttr('Only the events that failed or were abandoned.')}>Problems</a></span>
  </div>
  <div id="act-list" class="a-list" role="list"></div>
  <div id="act-skel">${skelHtml(6, 'row')}</div>
  <div id="act-empty" class="muted" hidden></div>
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
  .h-recent-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-2); }
  .h-recent-links { display: flex; gap: var(--sp-3); font-size: var(--fs-sm); }
  .h-recent-links a { color: var(--accent); }
  #act-empty .error { color: var(--danger); }
${ACTIVITY_ROW_CSS}
${ACTIVITY_DETAIL_CSS}
${DJ_ACTIONS_CSS}`

const JS = /* js */ `
(() => {
${MKVID_STATE_JS}
${DJ_ACTIONS_JS}
  const $ = TK.$, esc = TK.esc;
${ACTIVITY_DETAIL_JS}
${ACTIVITY_ROW_JS}
${ACTIVITY_DRAWER_JS}
  const isoOf = (sec) => { try { return new Date(sec * 1000).toISOString(); } catch (e) { return ''; } };
  const meter = (used, cap) => cap > 0 ? '<div class="tk-meter"><i style="width:' + Math.min(100, Math.round((used / cap) * 100)) + '%"></i></div>' : '';
  const failText = (res) => TK.errText(res, 'unavailable (' + (res.status || 'offline') + ')');
  function tileHtml(id, v, s, opts) {
    opts = opts || {};
    const el = $(id);
    if (!el) return;
    el.innerHTML = '<div class="v' + (opts.vcls ? ' ' + opts.vcls : '') + '">' + v + '</div><div class="s' + (opts.scls ? ' ' + opts.scls : '') + '">' + (s || '&nbsp;') + '</div>' + (opts.meter || '');
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
    $('attn').innerHTML = items.map((it) => '<li><a href="' + esc(it.href) + '"><span class="badge ' + esc(it.kind) + '"' + TK.tip(it.kind === 'bad' ? 'Something is broken or blocked and needs you.' : 'Worth a look, but nothing is blocked.') + '>' + (it.kind === 'bad' ? 'fix' : 'check') + '</span>' +
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
    await TK.api.swr('/ui/api/youtube/status', (res) => {
      if (!res.ok || !res.data || typeof res.data !== 'object') { ytS = null; ytErr = failText(res); } else ytS = res.data;
      renderYt();
    });
  }
  async function loadCombined() {
    await TK.api.swr('/ui/api/combined', (res) => {
      if (!res.ok || !res.data || typeof res.data !== 'object') { cmbS = null; cmbErr = failText(res); } else cmbS = res.data;
      renderYt();
    });
  }

  // ── mkvid tile ──
  async function loadMkvid() {
    await TK.api.swr('/ui/api/mkvid?limit=1', (res) => {
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
    });
  }

  // ── held playlists ──
  async function loadHolds() {
    await TK.api.swr('/ui/api/removals?limit=1', (res) => {
      const holds = res.ok && res.data && res.data.holds;
      if (!Array.isArray(holds)) { setAttn('holds', { error: failText(res) }); return; }
      setAttn('holds', { items: holds.map((h) => item('/ui/removed', 'bad',
        (h.kind === 'combined' ? 'Combined playlist' : (h.slug || h.playlistId || 'A playlist')) + ' is held',
        (h.missing || 0) + ' of ' + (h.expected || 0) + ' missing' + (h.at ? ' since ' + TK.fmt.time(isoOf(h.at)) : ''), 'Removed videos')) });
    });
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

  // ── recent activity: the newest twelve rows of the Activity log ──
  // Tiles, attention items and activity paint from the responses this browser
  // stored at the last view (TK.api.swr), then correct themselves from the live ones.
  let actRows = [];
  async function loadActivity() {
    const $list = $('act-list'), $empty = $('act-empty');
    await TK.api.swr('/ui/api/activity?limit=12', (res) => {
      $('act-skel').hidden = true;
      const rows = res.ok && res.data && Array.isArray(res.data.rows) ? res.data.rows : null;
      if (!rows) { $empty.hidden = false; $empty.innerHTML = '<span class="error">' + esc(failText(res)) + '</span>'; return; }
      actRows = rows.slice(0, 12);
      $list.innerHTML = actRows.map((r, i) => activityRowHtml(r, i)).join('');
      $empty.hidden = actRows.length > 0;
      $empty.textContent = 'No activity recorded yet.';
    });
  }
  $('act-list').addEventListener('click', (ev) => {
    const b = ev.target && ev.target.closest ? ev.target.closest('[data-i]') : null;
    if (b) openActivityRow(actRows[Number(b.dataset.i)]);
  });

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
  loadActivity();
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
