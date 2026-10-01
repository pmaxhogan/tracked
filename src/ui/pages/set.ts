// Set page: paste a 1001tracklists tracklist URL (or arrive with ?url=) and get
// a clean per-song list. Data comes from the Access-gated POST /ui/api/tracklist.
// Beside it (above it on narrow screens) the diagnostics column says why the
// set is or is not in the playlists, from GET /ui/api/set (set-diag.ts); the
// two calls run in parallel and either renders without the other.
import { shell } from '../shell'
import type { UiPage } from './index'
import { TRACK_ROW_CSS, TRACK_ROW_JS } from './track-row'
import { SET_DIAG_CSS, SET_DIAG_JS } from './set-diag'

const BODY = /* html */ `
  <form id="load-form" class="tk-card set-form">
    <div class="field grow"><label for="url">Tracklist URL</label><input id="url" type="url" placeholder="https://www.1001tracklists.com/tracklist/.../....html" required autofocus /></div>
    <button id="load-btn" type="submit" class="btn primary">Load</button>
  </form>
  <div class="set-layout">
  <aside id="diag" class="tk-card set-diag" aria-label="Diagnostics" hidden></aside>
  <div class="set-main">
  <div id="error" class="error" role="alert"></div>
  <div id="setmeta" class="tk-row muted set-meta" hidden></div>
  <div id="cachebar" class="tk-row cachebar" hidden>
    <span id="cache-age" class="muted"></span>
    <button type="button" id="refresh" class="btn small">Refresh track list</button>
    <button type="button" id="load-links" class="btn small" title="Look up Apple Music / YouTube links for every identified track (one page view per track not cached yet)">Load links</button>
    <span id="refresh-result" class="result muted" role="status"></span>
  </div>
  <div id="tracks" class="tk-card" hidden></div>
  <div id="empty" class="empty" hidden></div>
  </div>
  </div>
`

const CSS = /* css */ `
  .set-form { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--sp-3); margin-bottom: var(--sp-3); }
  .set-form .grow { flex: 1 1 18rem; }
  .set-meta { font-size: var(--fs-sm); margin-bottom: var(--sp-3); }
  .cachebar { font-size: var(--fs-sm); margin-bottom: var(--sp-3); }
  .btn.small { padding: 5px 10px; font-size: var(--fs-sm); }
  #tracks .trk:last-child { border-bottom: 0; }
${TRACK_ROW_CSS}
${SET_DIAG_CSS}`

const JS = /* js */ `
(() => {
${TRACK_ROW_JS}
${SET_DIAG_JS}
  const $ = TK.$;
  const $form = $('load-form'), $url = $('url'), $btn = $('load-btn'), $error = $('error'), $setmeta = $('setmeta');
  const $tracks = $('tracks'), $empty = $('empty'), $cachebar = $('cachebar'), $cacheAge = $('cache-age');
  const $refresh = $('refresh'), $loadLinks = $('load-links'), $result = $('refresh-result'), $diag = $('diag');
  let currentUrl = null, seq = 0;

  // One status line; a later success clears the failure colour.
  function setResult(msg, bad) { $result.className = 'result' + (bad ? ' bad' : ' muted'); $result.textContent = msg; }

  function fmtAge(sec) {
    if (sec == null) return 'cached list, age unknown';
    if (sec < 90) return 'fetched just now';
    const m = Math.round(sec / 60);
    if (m < 90) return 'fetched ' + m + ' min ago';
    const h = Math.round(sec / 3600);
    if (h < 48) return 'fetched ' + h + ' h ago';
    return 'fetched ' + Math.round(sec / 86400) + ' days ago';
  }

  function render(data) {
    $tracks.textContent = '';
    $setmeta.textContent = '';
    const count = document.createElement('span');
    count.textContent = (data.trackCount || 0) + ' track' + (data.trackCount === 1 ? '' : 's');
    $setmeta.appendChild(count);
    const src = pill(data.tracklistUrl, '1001tracklists page ↗');
    if (src) $setmeta.appendChild(src);
    const al = pill(data.setAppleLink, 'Apple Music (full set) ↗');
    if (al) $setmeta.appendChild(al);
    $setmeta.hidden = false;
    $cacheAge.textContent = fmtAge(data.cacheAgeSeconds);
    $cachebar.hidden = false;
    for (const t of (data.tracks || [])) $tracks.appendChild(trackRow(t));
    $tracks.hidden = false;
    $empty.hidden = true;
  }

  // Diagnostics: a 400 means "not a tracklist URL" and hides the column.
  async function loadDiag(url, my) {
    const res = await TK.api.get('/ui/api/set?url=' + encodeURIComponent(url));
    if (my !== seq) return;
    if (res.status === 400) { $diag.innerHTML = ''; $diag.hidden = true; return; }
    if (!res.ok || !res.data || typeof res.data !== 'object') {
      $diag.innerHTML = '<p class="diag-err">Diagnostics unavailable: ' + TK.esc(TK.errText(res, 'failed (' + (res.status || 'offline') + ')')) + '</p>';
      $diag.hidden = false;
      return;
    }
    $diag.innerHTML = renderDiag(res.data);
    $diag.hidden = false;
  }

  // The track list and the diagnostics load in parallel and independently; a
  // newer load drops an older one's responses.
  async function load(url) {
    currentUrl = url;
    const my = ++seq;
    $error.textContent = '';
    $empty.hidden = true;
    // Never leave another set's diagnostics on screen while this one loads.
    if (!$diag.hidden) $diag.innerHTML = '<p class="muted">Loading diagnostics…</p>';
    loadDiag(url, my).catch((e) => {
      if (my !== seq) return;
      $diag.innerHTML = '<p class="diag-err">Diagnostics unavailable: ' + TK.esc(e && e.message ? e.message : e) + '</p>';
      $diag.hidden = false;
    });
    await TK.busy($btn, 'Loading…', async () => {
      const res = await TK.api.post('/ui/api/tracklist', { url });
      if (my !== seq) return;
      const data = res.data || {};
      if (!res.ok) {
        $tracks.textContent = '';
        $tracks.hidden = true;
        $setmeta.hidden = true;
        $cachebar.hidden = !currentUrl;
        $cacheAge.textContent = '';
        $error.textContent = TK.errText(res, 'failed (' + res.status + ')');
        return;
      }
      if (!data.tracks || data.tracks.length === 0) {
        $tracks.textContent = '';
        $tracks.hidden = true;
        $setmeta.hidden = true;
        $empty.textContent = 'No tracks found.';
        $empty.hidden = false;
        return;
      }
      render(data);
    });
  }

  $form.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $url.value.trim();
    if (!url) return;
    setResult('', false);
    // Reflect the loaded set in the address bar so it can be shared or bookmarked.
    TK.qs.set({ url });
    load(url);
  });

  $loadLinks.addEventListener('click', async () => {
    $loadLinks.disabled = true;
    setResult('', false);
    try { await loadAllLinks($tracks, $result); }
    catch (e) { setResult('Links failed: ' + (e && e.message ? e.message : e), true); }
    finally { $loadLinks.disabled = false; }
  });

  // Purge the cached list and fetch it again now (costs one upstream fetch),
  // then reload the view from the fresh cache entry.
  $refresh.addEventListener('click', async () => {
    if (!currentUrl) return;
    setResult('Refreshing…', false);
    await TK.busy($refresh, 'Refreshing…', async () => {
      const res = await TK.api.post('/ui/api/tracklist/purge', { url: currentUrl });
      const d = res.data || {};
      if (!res.ok) {
        setResult('Refresh failed: ' + TK.errText(res, 'HTTP ' + res.status) + (d.stale ? ' — still showing the list ' + fmtAge(d.fetchedAt ? Math.round((Date.now() - Date.parse(d.fetchedAt)) / 1000) : null) : ''), true);
        return;
      }
      setResult(d.refreshed === false
        ? (d.dailyCapReached ? 'Not refetched: the daily limit of forced refreshes is used up; showing the cached list.' : 'Not refetched: this set was just refreshed; try again in ' + d.cooldownSeconds + ' s.')
        : 'Refreshed: ' + d.rowCount + ' rows, ' + d.identifiedCount + ' of ' + d.trackCount + ' identified', false);
      await load(currentUrl);
    });
  });

  // Deep link: /ui/set?url=... prefills and auto-loads.
  const pre = TK.qs.get('url');
  if (pre) { $url.value = pre; load(pre); }
})();
`

export const SET_PAGE: UiPage = {
  path: '/set',
  html: shell({
    nav: null,
    title: 'Set',
    description: 'Paste a 1001tracklists tracklist URL to see its tracks, links and why it is or is not in your playlists.',
    body: BODY,
    css: CSS,
    js: JS,
  }),
}
