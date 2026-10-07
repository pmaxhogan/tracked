// Playlists: the YouTube connection, the combined "all tracked artists" playlist
// (with Backfill now), one playlist row per DJ, and the hygiene strip. Data:
// GET /ui/api/youtube/status, /ui/api/combined, /ui/api/list + /ui/api/state/:slug
// per row (four at a time) and one GET /ui/api/removals.
import { skelHtml } from '../skeleton'
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
<div class="tk-card">
  <div class="pl-head"><h2><span class="tip-term"${tipAttr('Each subscribed DJ has its own YouTube playlist, filled with one video per set.')}>DJ playlists</span></h2></div>
  <div id="error" class="err-state" role="alert" hidden></div>
  <div id="wrap" class="tk-table-wrap" hidden>
    <table class="tk-table">
      <thead><tr><th>Playlist</th><th>DJ</th><th class="num">Videos</th><th>Last run</th><th class="num"><span class="tip-term"${tipAttr('Videos in this playlist that mkvid rendered from a set\'s audio because the set had no recording.')}>mkvid videos</span></th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
  <div id="pl-skel">${skelHtml(6, 'row')}</div>
  <div id="empty" class="empty" hidden></div>
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
  .skel.w { width: 5rem; display: inline-block; }
  .tk-table td.num, .tk-table th.num { text-align: right; white-space: nowrap; }
  .pl-sub { display: block; color: var(--muted); font-size: var(--fs-xs); }
${YOUTUBE_CARD_CSS}
${DJ_ACTIONS_CSS}`

const JS = /* js */ `
(() => {
${DJ_ACTIONS_JS}
${YOUTUBE_CARD_JS}
  const $ = TK.$, esc = TK.esc;
  const $cmbBody = $('cmb-body'), $cmbBackfill = $('cmb-backfill'), $cmbRefresh = $('cmb-refresh'), $cmbMeter = $('cmb-meter'), $cmbFill = $('cmb-fill');
  const $rows = $('rows'), $wrap = $('wrap'), $empty = $('empty'), $error = $('error'), $hygiene = $('hygiene'), $fix = $('fix-titles');

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

  // ── per-DJ playlists ──
  let rows = [];
  const SKEL = '<span class="skel w"></span>';
  function rowHtml(r) {
    const st = r.state, sum = DJA.summarize(st);
    const name = esc((st && st.artistName) || r.slug);
    const href = DJA.playlistHref(st);
    const title = href ? link(href, ((st && st.artistName) || r.slug) + ' (1001tklists)') : '<span class="muted">' + name + ' · not created yet</span>';
    const dj = '<a href="/ui/dj/' + esc(encodeURIComponent(r.slug)) + '">' + esc(r.slug) + '</a>';
    let videos, last, mk;
    if (r.state === undefined) { videos = last = mk = SKEL; }
    else if (r.failed) { videos = last = mk = '<span class="muted">unavailable</span>'; }
    else if (!st) { videos = '—'; last = '<span class="muted">never synced</span>'; mk = '—'; }
    else {
      videos = String(sum.videos);
      const when = DJA.lastRun(st);
      const added = st.lastRunStats ? st.lastRunStats.videoIdsAdded || 0 : 0;
      last = when ? esc(when) + (added ? ' <span class="muted">· +' + added + '</span>' : '') : '<span class="muted">never</span>';
      mk = sum.mkvid ? String(sum.mkvid) : '—';
    }
    return '<tr><td data-label="Playlist">' + title + '</td><td data-label="DJ">' + dj + '</td><td data-label="Videos" class="num">' + videos +
      '</td><td data-label="Last run">' + last + '</td><td data-label="mkvid videos" class="num">' + mk + '</td></tr>';
  }
  function render() {
    $wrap.hidden = !rows.length;
    $rows.innerHTML = rows.map(rowHtml).join('');
    $empty.textContent = 'No subscriptions yet.';
    $empty.hidden = !!rows.length;
  }
  function showError(msg) {
    $error.textContent = '';
    if (!msg) { $error.hidden = true; return; }
    $error.innerHTML = '<span class="grow">' + esc(msg) + '</span><button type="button" class="btn small" id="retry">Retry</button>';
    $error.hidden = false;
    $('retry').addEventListener('click', loadRows);
  }
  async function loadRows() {
    showError('');
    // The list and each row's state stored at the last view paint at once; the live ones replace them.
    await TK.api.swr('/ui/api/list', async (res) => {
      $('pl-skel').hidden = true;
      if (!res.ok) {
        showError(TK.errText(res, 'failed to load (' + res.status + ')'));
        if (!rows.length) { $empty.textContent = 'Nothing to show.'; $empty.hidden = false; }
        return;
      }
      showError('');
      const prev = new Map(rows.map((r) => [r.slug, r]));
      rows = ((res.data && res.data.subscriptions) || []).map((s) => {
        const old = prev.get(s.slug);
        return old || { slug: s.slug, state: res.stale ? DJA.storedState(s.slug) : undefined, failed: false };
      });
      render();
      if (res.stale) return;
      await DJA.pool(rows, 4, async (r) => {
        const s = await DJA.loadState(r.slug);
        if (s.failed) { r.state = null; r.failed = true; } else { r.state = s.state; r.failed = false; }
        render();
      });
    });
  }

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
  loadHygiene();
  loadRows();
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
