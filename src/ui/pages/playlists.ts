// Playlists: the YouTube connection, the combined "all tracked artists" playlist
// (with Backfill now), one playlist row per DJ, and the hygiene strip. Data:
// GET /ui/api/youtube/status, /ui/api/combined, /ui/api/playlist-order, the DJ table GET /ui/api/djs
// (lib/dj-table.ts, server-sorted and paged; TKTable) and one GET /ui/api/removals.
import { shell } from '../shell'
import { tipAttr } from '../tip'
import type { UiPage } from './index'
import { DJ_ACTIONS_CSS, DJ_ACTIONS_JS, FIX_DIALOG_HTML, FIX_TITLES_TITLE } from './dj-actions'
import { YOUTUBE_CARD_CSS, YOUTUBE_CARD_HTML, YOUTUBE_CARD_JS } from './youtube-card'

const ACTIONS = /* html */ `<button id="fix-titles" type="button" class="btn"${tipAttr(FIX_TITLES_TITLE)}>Fix titles</button>`

const BODY = /* html */ `
${YOUTUBE_CARD_HTML}
<div id="hygiene" class="tk-card pl-hygiene" hidden></div>
<div id="cmb-card" class="tk-card">
  <div class="pl-head">
    <h2><span class="tip-term"${tipAttr('One YouTube playlist holding every video from every artist playlist. New videos are added by the sync and a backfill fills in the rest, within the daily insert cap.')}>Combined playlist</span></h2>
    <div class="tk-row">
      <button id="cmb-backfill" type="button" class="btn small" disabled${tipAttr('Adds videos that are missing from the combined playlist right now, up to the daily insert cap. It also runs by itself on every scheduler tick.')}>Backfill now</button>
      <button id="cmb-refresh" type="button" class="btn small"${tipAttr('Reads the playlist from YouTube again to update these numbers.')}>Refresh</button>
    </div>
  </div>
  <div id="cmb-body"><span class="muted">Loading…</span></div>
  <div id="cmb-meter" class="tk-meter" hidden><i id="cmb-fill"></i></div>
</div>
<div id="ord-card" class="tk-card">
  <div class="pl-head">
    <h2><span class="tip-term"${tipAttr('Each DJ playlist is kept in the order the sets took place, earliest first. A new video is inserted at its place. Videos added before this existed are moved there a few a day once you set a daily budget, because each move costs 50 YouTube quota units. The combined playlist is not ordered.')}>Set-date order</span></h2>
    <div class="tk-row">
      <button id="ord-check" type="button" class="btn small"${tipAttr('Dry run: reads the order of every DJ playlist from YouTube now (1 quota unit per 50 videos) and counts the moves still needed. Moves nothing, and works while moving is paused.')}>Check now</button>
      <button id="ord-run" type="button" class="btn small" disabled${tipAttr('Makes the next few moves now, within the same daily unit budget the scheduler uses.')}>Move now</button>
    </div>
  </div>
  <div id="ord-body"><span class="muted">Loading…</span></div>
  <details id="ord-details" hidden><summary>Per playlist</summary><div id="ord-table"></div></details>
</div>
<div class="tk-card">
  <div class="pl-head"><h2><span class="tip-term"${tipAttr('Each subscribed DJ has its own YouTube playlist, filled with one video per set.')}>DJ playlists</span></h2></div>
  <div id="pl"></div>
</div>
${FIX_DIALOG_HTML}
`

const CSS = /* css */ `
  .pl-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-2) var(--sp-3); margin-bottom: var(--sp-3); }
  .pl-head h2 { margin: 0; }
  .pl-hygiene { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); padding: var(--sp-3) var(--sp-4); }
  #cmb-body .headline { font-weight: 600; }
  #cmb-body .bits { color: var(--muted); font-size: var(--fs-sm); margin-top: 2px; }
  #cmb-body .warn { color: var(--danger); }
  #cmb-meter { margin-top: var(--sp-3); }
  .pl-sub { display: block; color: var(--muted); font-size: var(--fs-xs); }
  #ord-body .headline { font-weight: 600; }
  #ord-body .bits { color: var(--muted); font-size: var(--fs-sm); margin-top: 2px; }
  #ord-details { margin-top: var(--sp-3); }
  #ord-details summary { cursor: pointer; color: var(--muted); font-size: var(--fs-sm); }
  #ord-table table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); margin-top: var(--sp-2); }
  #ord-table th, #ord-table td { text-align: right; padding: 2px var(--sp-2); }
  #ord-table th:first-child, #ord-table td:first-child { text-align: left; }
  #ord-table th { color: var(--muted); font-weight: 500; }
${YOUTUBE_CARD_CSS}
${DJ_ACTIONS_CSS}`

const JS = /* js */ `
(() => {
${DJ_ACTIONS_JS}
${YOUTUBE_CARD_JS}
  const $ = TK.$, esc = TK.esc;
  const $cmbBody = $('cmb-body'), $cmbBackfill = $('cmb-backfill'), $cmbRefresh = $('cmb-refresh'), $cmbMeter = $('cmb-meter'), $cmbFill = $('cmb-fill');
  const $hygiene = $('hygiene'), $fix = $('fix-titles');

  function link(href, text) {
    const h = TK.safeHref(href);
    return h ? '<a href="' + esc(h) + '" target="_blank" rel="noreferrer noopener">' + esc(text) + '</a>' : esc(text);
  }

  // ── combined playlist ──
  function renderCombined(d) {
    if (!d || d.connected === false) {
      $cmbBody.textContent = 'Connect a YouTube account to build the combined playlist.';
      $cmbBackfill.disabled = true;
      $cmbMeter.hidden = true;
      return;
    }
    $cmbBackfill.disabled = false;
    const missing = d.missingTotal || 0;
    const sources = d.sources || [];
    const cap = d.dailyInsertCap || 0;
    const used = d.dailyInsertsUsed || 0;
    const left = Math.max(0, cap - used);
    const head = d.playlistId
      ? link(d.playlistUrl, d.title) + ' <span class="muted">· ' + (d.videoCount || 0) + ' videos</span>'
      : esc(d.title) + ' <span class="muted">· not created yet</span>';
    const bits = [
      missing > 0 ? '<span class="warn">' + missing + ' still to add</span>' : 'up to date with every artist playlist',
      sources.length + ' artist playlist' + (sources.length === 1 ? '' : 's'),
      left + '/' + cap + ' inserts left today',
    ];
    if (d.unavailableTotal) bits.push(d.unavailableTotal + ' unavailable skipped');
    if (d.lastBackfillAt) bits.push('last backfill ' + esc(TK.fmt.rel(new Date(d.lastBackfillAt * 1000).toISOString())));
    let html = '<div class="headline">' + head + '</div><div class="bits">' + bits.join(' · ') + '</div>';
    if (missing > 0) html += '<div class="bits">Backfilling automatically on every cron tick, up to ' + cap + ' videos/day (YouTube quota).</div>';
    $cmbBody.innerHTML = html;
    // Inserts used of the daily cap.
    $cmbMeter.hidden = !cap;
    $cmbFill.style.width = cap ? Math.min(100, Math.round(used / cap * 100)) + '%' : '0%';
  }

  // A page view paints the status this browser stored last, then the live one
  // (one YouTube read); Refresh and Backfill ask for the live one only.
  async function loadCombined(fromMemory) {
    if (fromMemory === true) { await TK.api.swr('/ui/api/combined', applyCombined); return; }
    applyCombined(await TK.api.get('/ui/api/combined'));
  }
  function applyCombined(res) {
    if (!res.ok) {
      $cmbBody.textContent = res.status === 412 ? TK.errText(res, 'status unavailable') : 'status unavailable (' + (res.status || 'offline') + ')';
      $cmbBackfill.disabled = true;
      $cmbMeter.hidden = true;
      return;
    }
    renderCombined(res.data);
  }

  $cmbRefresh.addEventListener('click', () => loadCombined());
  $cmbBackfill.addEventListener('click', () => TK.busy($cmbBackfill, 'Backfilling…', async () => {
    const res = await TK.api.post('/ui/api/combined/backfill', {});
    const data = res.data && typeof res.data === 'object' ? res.data : {};
    if (!res.ok) {
      if (res.status === 412 && data.error === 'youtube_reauth_required') { DJA.reauthToast(); YT.load(); return; }
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

  // ── set-date order: the stored numbers on load, a YouTube reading only on Check now ──
  const $ordBody = $('ord-body'), $ordCheck = $('ord-check'), $ordRun = $('ord-run'), $ordDetails = $('ord-details'), $ordTable = $('ord-table');
  function renderOrder(d) {
    if (!d || !d.connected) {
      $ordBody.textContent = 'Connect a YouTube account to order the playlists.';
      $ordRun.disabled = true; $ordDetails.hidden = true;
      return;
    }
    const t = d.totals || {};
    const paused = !d.dailyUnits;
    $ordRun.disabled = paused || !t.moves;
    let head;
    if (t.unread === t.playlists) head = 'Not read yet <span class="muted">· Check now counts the moves needed</span>';
    else if (!t.moves) head = 'Every playlist is in set-date order' + (t.unread ? ' <span class="muted">· ' + t.unread + ' not read yet</span>' : '');
    else head = t.moves + ' video' + (t.moves === 1 ? '' : 's') + ' still to move <span class="muted">· ' + (t.units || 0).toLocaleString() + ' quota units' +
      (paused ? '' : d.estimate && d.estimate.days ? ' · about ' + d.estimate.days + ' day' + (d.estimate.days === 1 ? '' : 's') + ' at this budget' : '') + '</span>';
    const bits = [
      paused ? '<span class="badge neutral"' + TK.tip('Nothing is moved and the scheduler makes no YouTube call for this. New videos are still inserted at their place.') + '>moving is paused</span>'
        : (d.unitsUsedToday || 0) + ' / ' + d.dailyUnits + ' units used today',
      (t.items || 0) + ' videos in ' + (t.playlists || 0) + ' DJ playlists',
      '<span' + TK.tip('The combined playlist is the one for shuffling: its videos stay in the order they were added and none of these numbers count it.') + '>combined playlist not ordered</span>',
    ];
    if (t.undated) bits.push('<span' + TK.tip('Videos no tracked set resolves to (added by hand, for instance). They stay after the dated sets, in the order they have.') + '>' + t.undated + ' with no set date</span>');
    if (d.quotaStoppedUntil) bits.push('<span class="badge info"' + TK.tip('YouTube answered that the quota of today is used. Moving continues by itself after the quota resets at midnight Pacific.') + '>waiting for quota · ' + esc(TK.fmt.rel(new Date(d.quotaStoppedUntil * 1000).toISOString())) + '</span>');
    if (d.lastRun && d.lastRun.moved) bits.push('last moved ' + d.lastRun.moved + ' ' + esc(TK.fmt.rel(new Date(d.lastRun.at * 1000).toISOString())));
    if (d.fresh) bits.push('read from YouTube just now (' + d.unitsSpent + ' units)');
    const manual = (d.playlists || []).filter((p) => p.problem === 'manual_sort');
    const stopped = (d.playlists || []).filter((p) => p.problem === 'unexpected_position' || p.problem === 'no_progress');
    let html = '<div class="headline">' + head + '</div><div class="bits">' + bits.join(' · ') + '</div>';
    // Paused is the owner's own setting, not a fault: say how to start, and what a budget means once the moves are counted.
    if (paused) html += '<div class="bits">To start, set <a href="/ui/settings#sf-playlists">Quota units a day for ordering playlists</a> in Settings.' +
      (t.unread === t.playlists ? ' Check now first counts the moves.' : d.estimate && d.estimate.moves ? ' ' + (d.daysAt || []).map((x) => x.dailyUnits.toLocaleString() + ' a day: about ' + x.days + ' day' + (x.days === 1 ? '' : 's')).join(' · ') + '.' : '') + '</div>';
    // A move that did not land where planned stops that playlist before more quota is spent: someone has to look.
    if (stopped.length) html += '<div class="bits"><span class="badge bad">' + stopped.length + ' stopped</span> ' + stopped.map((p) => esc(p.title) + ' (' + esc(p.detail || p.problem) + ')').join(', ') +
      ': YouTube did not move a video the way the plan expects, so no more quota is spent there. It is tried once a day.</div>';
    // The one state that needs the owner: YouTube refuses positions on a playlist that sorts itself.
    if (manual.length) html += '<div class="bits"><span class="badge bad">' + manual.length + ' cannot be ordered</span> ' + manual.map((p) => esc(p.title)).join(', ') +
      ': set the sort order of the playlist to Manual on YouTube.</div>';
    $ordBody.innerHTML = html;
    const rows = (d.playlists || []).filter((p) => p.checkedAt);
    $ordDetails.hidden = !rows.length;
    $ordTable.innerHTML = '<table><thead><tr><th>Playlist</th><th>Videos</th><th>No date</th><th>To move</th><th>Units</th><th>Read</th></tr></thead><tbody>' +
      rows.map((p) => '<tr><td>' + link('https://www.youtube.com/playlist?list=' + encodeURIComponent(p.playlistId), p.title) +
        (p.problem === 'manual_sort' ? ' <span class="badge bad">not on manual order</span>' : p.problem === 'unexpected_position' || p.problem === 'no_progress' ? ' <span class="badge bad"' + TK.tip(p.detail || '') + '>stopped</span>' : p.problem ? ' <span class="badge info"' + TK.tip(p.detail || '') + '>' + (p.problem === 'unreadable' ? 'not read' : 'retrying') + '</span>' : '') +
        '</td><td>' + esc(p.items) + '</td><td>' + esc(p.undated || '') + '</td><td>' + esc(p.moves || '') + '</td><td>' + (p.units ? p.units.toLocaleString() : '') + '</td><td>' + esc(TK.fmt.rel(new Date(p.checkedAt * 1000).toISOString())) + '</td></tr>').join('') +
      '</tbody></table>';
  }
  function applyOrder(res) {
    if (!res.ok) { $ordBody.textContent = res.status === 412 ? TK.errText(res, 'status unavailable') : 'status unavailable (' + (res.status || 'offline') + ')'; $ordRun.disabled = true; return; }
    renderOrder(res.data);
  }
  $ordCheck.addEventListener('click', () => TK.busy($ordCheck, 'Reading…', async () => applyOrder(await TK.api.get('/ui/api/playlist-order?fresh=1'))));
  $ordRun.addEventListener('click', () => TK.busy($ordRun, 'Moving…', async () => {
    const res = await TK.api.post('/ui/api/playlist-order/run', {});
    const data = res.data && typeof res.data === 'object' ? res.data : {};
    if (!res.ok) {
      if (res.status === 412 && data.error === 'youtube_reauth_required') { DJA.reauthToast(); YT.load(); return; }
      TK.toast(data.errorMessage || TK.errText(res, 'moving failed (' + res.status + ')'), 'bad');
      return;
    }
    const why = { quota: 'YouTube quota is used for today', rate_limit: 'YouTube is rate limiting, it goes on at the next tick', budget: 'the unit budget of today is used', paused: 'paused in Settings', not_connected: 'YouTube is not connected' }[data.stoppedBy];
    // Out of quota or budget is a wait, not a failure: it continues by itself.
    TK.toast('playlist order: moved ' + (data.moved || 0) + ' video' + (data.moved === 1 ? '' : 's') + (why ? ' · ' + why : ''), data.moved || !why ? 'ok' : 'warn');
    applyOrder(await TK.api.get('/ui/api/playlist-order'));
  }));

  // ── per-DJ playlists: one row per subscription from GET /ui/api/djs ──
  TKTable.create($('pl'), {
    id: 'pl',
    source: { url: '/ui/api/djs' },
    swr: true,
    columns: [
      { key: 'name', label: 'Playlist', type: 'text', render: (r) => r.playlistUrl ? link(r.playlistUrl, r.name + ' (1001tklists)') : '<span class="muted">' + esc(r.name) + ' · not created yet</span>' },
      { key: 'slug', label: 'DJ', type: 'text', render: (r) => '<a href="/ui/dj/' + esc(encodeURIComponent(r.slug)) + '">' + esc(r.slug) + '</a>' },
      { key: 'videos', label: 'Videos', type: 'number', tip: 'Sets with a video in this playlist.' },
      { key: 'lastRunAt', label: 'Last run', type: 'datetime', render: (r) => r.lastRunAt ? esc(TK.fmt.rel(new Date(r.lastRunAt).toISOString())) + (r.lastAdded ? ' <span class="muted">· +' + esc(r.lastAdded) + '</span>' : '') : '<span class="muted">never</span>', tip: 'When the sync last ran for this DJ, and how many videos it added.' },
      { key: 'mkvid', label: 'mkvid videos', type: 'number', tip: 'Videos in this playlist that mkvid rendered from a set audio because the set had no recording.' },
    ],
    defaultSort: 'name',
    search: 'Search playlists',
    chips: [
      { id: 'all', label: 'All', group: 'f', on: true, count: (d) => d.counts && d.counts.total },
      { id: 'made', label: 'Created', group: 'f', filters: [{ col: 'hasPlaylist', op: 'eq', value: '1' }], tip: 'DJs whose playlist exists on YouTube.' },
      { id: 'none', label: 'Not created yet', group: 'f', filters: [{ col: 'hasPlaylist', op: 'eq', value: '0' }], count: (d) => d.counts && d.counts.noPlaylist, tip: 'DJs the sync has not made a playlist for yet.' },
      { id: 'mkvid', label: 'With mkvid videos', group: 'f', filters: [{ col: 'mkvid', op: 'gt', value: '0' }], sort: '-mkvid', count: (d) => d.counts && d.counts.mkvid, tip: 'Playlists holding videos mkvid rendered.' },
    ],
    rowKey: 'slug',
    empty: 'No subscriptions yet.',
  });

  // ── hygiene strip ──
  async function loadHygiene() {
    await TK.api.swr('/ui/api/removals?limit=1', applyHygiene);
  }
  function applyHygiene(res) {
    const d = res.ok && res.data && typeof res.data === 'object' ? res.data : null;
    $hygiene.hidden = false;
    if (!d) { $hygiene.innerHTML = '<span class="muted">Hygiene status unavailable.</span> <a href="/ui/removed">Removed videos →</a>'; return; }
    const s = d.settings || {};
    const held = (d.holds || []).length;
    $hygiene.innerHTML = '<span class="badge ' + (s.dryRun ? 'warn' : 'bad') + '"' + TK.tip(s.dryRun ? 'The sweep only reports which videos it would remove (videos that are not a full recording, for instance); it deletes nothing yet.' : 'The sweep really removes videos that fail the full-recording check, from the artist and combined playlists.') + '>' + (s.dryRun ? 'DRY RUN' : 'LIVE') + '</span>' +
      '<span class="badge neutral"' + TK.tip('Videos the sweep has removed from playlists today, out of its daily limit.') + '>deletes today ' + (d.deletesUsedToday || 0) + ' / ' + (s.dailyRemovals || 0) + '</span>' +
      '<span class="badge ' + (held ? 'bad' : 'neutral') + '"' + TK.tip(held ? 'Playlists that lost many videos at once and are waiting for you to approve or undo on the Removed videos page.' : 'No playlist is waiting for your approval.') + '>' + held + ' held</span>' +
      '<a href="/ui/removed">Removed videos →</a>';
  }

  $fix.addEventListener('click', () => DJA.fixTitles($fix));

  YT.handleReturn();
  YT.load();
  loadCombined(true);
  TK.api.swr('/ui/api/playlist-order', applyOrder);
  loadHygiene();
})();
`

export const PLAYLISTS_PAGE: UiPage = {
  path: '/playlists',
  html: shell({
    nav: 'playlists',
    title: 'Playlists',
    description: 'The YouTube connection, the combined playlist and each DJ\'s playlist.',
    actions: ACTIONS,
    body: BODY,
    css: CSS,
    js: JS,
  }),
}
