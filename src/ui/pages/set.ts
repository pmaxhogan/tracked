// Set page: paste a 1001tracklists tracklist URL (or arrive with ?url=) and get
// a clean per-song list. Data comes from the Access-gated POST /ui/api/tracklist.
// Beside it (above it on narrow screens) the diagnostics column says why the
// set is or is not in the playlists, from GET /ui/api/set (set-diag.ts); the
// two calls run in parallel and either renders without the other.
import { shell } from "../shell";
import { tipAttr } from "../tip";
import type { UiPage } from "./index";
import { TRACK_ROW_CSS, TRACK_ROW_JS } from "./track-row";
import { SET_DIAG_CSS, SET_DIAG_JS } from "./set-diag";

const BODY = /* html */ `
  <form id="load-form" class="tk-card set-form">
    <div class="field grow"><label for="url">Tracklist URL</label><input id="url" type="url" placeholder="https://www.1001tracklists.com/tracklist/.../....html" required autofocus /></div>
    <button id="load-btn" type="submit" class="btn primary"${tipAttr("Fetches the tracklist (from cache when recent; otherwise one 1001tracklists page view) and shows why it is or is not in your playlists.")}>Load</button>
  </form>
  <div id="ytm-slot" class="set-ytm" hidden></div>
  <div class="set-layout">
  <aside id="diag" class="tk-card set-diag" aria-label="Diagnostics" hidden></aside>
  <div class="set-main">
  <div id="error" class="error" role="alert"></div>
  <div id="setmeta" class="tk-row muted set-meta" hidden></div>
  <div id="setinfo" class="tk-card set-info" hidden></div>
  <div id="cachebar" class="tk-row cachebar" hidden>
    <span id="cache-age" class="muted"></span>
    <button type="button" id="refresh" class="btn small"${tipAttr("Throws away the cached track list and fetches the page again. Costs one 1001tracklists page view and is limited per set and per day.")}>Refresh track list</button>
    <button type="button" id="load-links" class="btn small"${tipAttr("Looks up Apple Music and YouTube links for every identified track. Costs one 1001tracklists page view per track not already cached (cached for 30 days).")}>Load links</button>
    <span id="refresh-result" class="result muted" role="status"></span>
  </div>
  <div id="tracks-skel" class="tk-card" hidden></div>
  <div id="tracks" class="tk-card" hidden></div>
  <div id="empty" class="empty" hidden></div>
  </div>
  </div>
`;

const CSS = /* css */ `
  .set-form { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--sp-3); margin-bottom: var(--sp-3); }
  .set-form .grow { flex: 1 1 18rem; }
  .set-meta { font-size: var(--fs-sm); margin-bottom: var(--sp-3); }
  .cachebar { font-size: var(--fs-sm); margin-bottom: var(--sp-3); }
  .btn.small { padding: 5px 10px; font-size: var(--fs-sm); }
  .set-ytm { margin-bottom: var(--sp-3); }
  .set-info { margin-bottom: var(--sp-3); font-size: var(--fs-sm); }
  .set-info .si-genres { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; }
  .set-info .si-genres a.badge { text-decoration: none; }
  .set-info .si-facts { color: var(--muted); margin-top: var(--sp-2); overflow-wrap: anywhere; }
  .set-info details { margin-top: var(--sp-2); }
  .set-info summary { cursor: pointer; color: var(--muted); }
  .set-info dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px var(--sp-3); margin: var(--sp-2) 0 0; }
  .set-info dt { color: var(--muted); }
  .set-info dd { margin: 0; overflow-wrap: anywhere; }
  .set-ytm .ytm { text-decoration: none; }
${TRACK_ROW_CSS}
${SET_DIAG_CSS}`;

// Where a genre badge goes, and what its tooltip says.
const GENRE_JS = /* js */ `
  const GENRE_HREF = (g) => 'https://www.1001tracklists.com/genre/' + encodeURIComponent(g.key) + '/index.html';
  const GENRE_TIP = 'The genre 1001tracklists gives this set. Opens its genre page there.';
`;

const JS = /* js */ `
(() => {
${GENRE_JS}
${TRACK_ROW_JS}
${SET_DIAG_JS}
  const $ = TK.$;
  const $form = $('load-form'), $url = $('url'), $btn = $('load-btn'), $error = $('error'), $setmeta = $('setmeta');
  const $tracks = $('tracks'), $empty = $('empty'), $cachebar = $('cachebar'), $cacheAge = $('cache-age');
  const $setinfo = $('setinfo');
  // Genres and the rest of the set page (stored on every fetch, lib/set-meta.ts), from the diagnostics.
  function genreHref(g) { return GENRE_HREF(g); }
  function renderSetInfo(sm) {
    const m = sm && sm.meta;
    if (!sm || (!m && !(sm.genres || []).length)) { $setinfo.hidden = true; $setinfo.innerHTML = ''; return; }
    const esc = TK.esc;
    const genres = sm.genres || [];
    let html = '<div class="si-genres"><strong>Genres</strong>' + (genres.length
      ? genres.map((g) => '<a class="badge info" href="' + esc(genreHref(g)) + '"' + TK.tip(GENRE_TIP) + '>' + esc(g.name) + '</a>').join('')
      : '<span class="muted">none given</span>') + '</div>';
    if (m) {
      const bits = [];
      if (m.views != null) bits.push(m.views + ' views');
      if (m.likes != null) bits.push(m.likes + ' likes');
      if (m.total != null) bits.push((m.ided != null ? m.ided : '?') + '/' + m.total + ' IDed');
      if (m.durationSeconds) bits.push(TK.fmt.clock(m.durationSeconds) + ' long');
      if (m.postedBy) bits.push('list by ' + m.postedBy.name);
      const places = (m.boxes || []).filter((b) => b.object === 3).map((b) => b.title + (b.country ? ' (' + b.country + ')' : ''));
      if (places.length) bits.push(places.join(', '));
      if (bits.length) html += '<div class="si-facts">' + esc(bits.join(' · ')) + '</div>';
      const rows = [];
      const add = (k, v) => { if (v != null && v !== '') rows.push('<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>'); };
      add('Set date', m.date);
      add('Posted', m.postedAt);
      add('Updated', m.updatedAt);
      add('Live set', m.isLive == null ? null : m.isLive ? 'yes' : 'no');
      add('Tracks (page)', m.numTracks);
      for (const b of m.boxes || []) add(b.object === 2 ? 'Artist' : 'Source', b.title + (b.country ? ', ' + b.country : '') + (b.links && b.links.length ? ' (' + b.links.map((l) => l.label).join(', ') + ')' : ''));
      for (const x of m.media || []) add('Player', (x.sourceName || ('source ' + x.source)) + (x.label ? ' ' + x.label : '') + (x.externalId ? ' [' + x.externalId + ']' : ''));
      add('Notice', m.notice);
      add('Short link', m.shortLink);
      add('Stored', TK.fmt.rel(new Date(sm.fetchedAt * 1000).toISOString()) + ' (' + sm.source + ')');
      if (rows.length) html += '<details><summary>Everything stored about this set</summary><dl>' + rows.join('') + '</dl></details>';
    }
    $setinfo.innerHTML = html;
    $setinfo.hidden = false;
  }
  const $refresh = $('refresh'), $loadLinks = $('load-links'), $result = $('refresh-result'), $diag = $('diag'), $skel = $('tracks-skel');
  let currentUrl = null, seq = 0;
  // The set's YouTube video, for the YouTube Music button: the diagnostics'
  // video (the synced row's, else the set page's, else the mkvid upload's),
  // else the set page's own YouTube link. The two calls answer in either order.
  // For an mkvid upload the synced row's video is the upload (the upload writes
  // it there). The button has its own slot above the diagnostics, so on a phone
  // it is on screen first, and it shows as soon as the D1-only diagnostics
  // answer, even while the 1001tracklists fetch is slow or fails.
  let ytFromDiag = null, ytFromPage = null;
  const $ytmSlot = $('ytm-slot');
  function videoIdOf(url) {
    const m = String(url || '').match(/(?:[?&]v=|youtu\\.be\\/|\\/(?:embed|shorts|live)\\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
  }
  function diagVideoId(d) {
    return d && d.video && typeof d.video.id === 'string' ? d.video.id : null;
  }
  function renderYtm() {
    $ytmSlot.textContent = '';
    const id = ytFromDiag || ytFromPage;
    $ytmSlot.hidden = !id;
    if (!id) return;
    const a = document.createElement('a');
    a.id = 'ytm';
    a.className = 'btn primary ytm';
    a.href = 'https://music.youtube.com/watch?v=' + encodeURIComponent(id);
    a.target = '_blank'; a.rel = 'noreferrer noopener';
    a.textContent = 'Open in YouTube Music ↗';
    a.setAttribute('data-tip', 'Plays this set in YouTube Music, in a new tab.');
    $ytmSlot.appendChild(a);
  }
  // The track table (track-row.ts): created on the first list, fed new lists after.
  let tt = null;

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
    $setmeta.textContent = '';
    const count = document.createElement('span');
    const extra = Array.isArray(data.rows) && data.rows.length > (data.trackCount || 0) ? ' · ' + (data.rows.length - (data.trackCount || 0)) + ' unnamed ID rows' : '';
    count.textContent = (data.trackCount || 0) + ' track' + (data.trackCount === 1 ? '' : 's') + extra;
    $setmeta.appendChild(count);
    const src = pill(data.tracklistUrl, '1001tracklists page ↗', 'Opens this set on 1001tracklists.');
    if (src) $setmeta.appendChild(src);
    ytFromPage = videoIdOf(data.setYoutubeLink);
    const al = pill(data.setAppleLink, 'Apple Music (full set) ↗', 'The whole set on Apple Music.');
    if (al) $setmeta.appendChild(al);
    $setmeta.hidden = false;
    renderYtm();
    $cacheAge.textContent = fmtAge(data.cacheAgeSeconds);
    $cachebar.hidden = false;
    $skel.hidden = true; $skel.innerHTML = '';
    $tracks.hidden = false;
    if (!tt) tt = TRK.create($tracks, { id: 'trk', setUrl: data.tracklistUrl || currentUrl, data });
    else tt.setData(data, data.tracklistUrl || currentUrl);
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
    ytFromDiag = diagVideoId(res.data);
    renderYtm();
    renderSetInfo(res.data.setMeta);
    $diag.innerHTML = renderDiag(res.data);
    $diag.hidden = false;
  }

  // "Queue for re-check now" in the mkvid row: Apple Music pass now, refetch soon; then the diagnostics again.
  $diag.addEventListener('click', async (ev) => {
    const b = ev.target && ev.target.closest ? ev.target.closest('button[data-recheck-now]') : null;
    if (!b) return;
    const res = await TK.busy(b, 'Working...', () => TK.api.post('/ui/api/mkvid/recheck-now/' + encodeURIComponent(b.dataset.recheckNow), {}));
    if (!res || !res.ok) TK.toast('Re-check failed: ' + TK.errText(res, 'failed (' + (res ? res.status : 0) + ')'), 'bad');
    else TK.toast(res.data && res.data.readiness && res.data.readiness.state !== 'untimed' ? 'Enough cue times now: the set can render.' : 'Queued: the set page is fetched again soon.', 'ok');
    await loadDiag(currentUrl, seq);
  });

  // The track list and the diagnostics load in parallel and independently; a
  // newer load drops an older one's responses.
  async function load(url) {
    currentUrl = url;
    const my = ++seq;
    // Never leave another set's button on screen while this one loads.
    ytFromDiag = null; ytFromPage = null;
    renderYtm();
    renderSetInfo(null);
    $error.textContent = '';
    $empty.hidden = true;
    // Never leave another set's diagnostics on screen while this one loads.
    $diag.innerHTML = TK.skel(7, 'row');
    $diag.hidden = false;
    loadDiag(url, my).catch((e) => {
      if (my !== seq) return;
      $diag.innerHTML = '<p class="diag-err">Diagnostics unavailable: ' + TK.esc(e && e.message ? e.message : e) + '</p>';
      $diag.hidden = false;
    });
    // Skeleton rows until the list arrives (an uncached set is a live 1001tracklists fetch).
    $skel.innerHTML = TK.skel(8, 'row');
    $skel.hidden = false;
    $tracks.hidden = true;
    $setmeta.hidden = true;
    await TK.busy($btn, 'Loading…', async () => {
      const res = await TK.api.post('/ui/api/tracklist', { url });
      if (my !== seq) return;
      const data = res.data || {};
      $skel.hidden = true; $skel.innerHTML = '';
      if (!res.ok) {
        $tracks.hidden = true;
        $setmeta.hidden = true;
        $cachebar.hidden = !currentUrl;
        $cacheAge.textContent = '';
        $error.textContent = TK.errText(res, 'failed (' + res.status + ')');
        return;
      }
      if ((!data.tracks || data.tracks.length === 0) && (!data.rows || data.rows.length === 0)) {
        $tracks.hidden = true;
        $setmeta.hidden = true;
        $empty.textContent = 'No tracks found.';
        $empty.hidden = false;
        return;
      }
      render(data);
      // A fresh fetch has just stored the page's genres: read them again.
      if (data.cacheAgeSeconds != null && data.cacheAgeSeconds < 90) loadDiag(url, my).catch(() => {});
    });
  }

  $form.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $url.value.trim();
    if (!url) return;
    setResult('', false);
    // Reflect the loaded set in the address bar so it can be shared or bookmarked.
    TKTable.qs.merge({ url });
    load(url);
  });

  $loadLinks.addEventListener('click', async () => {
    $loadLinks.disabled = true;
    setResult('', false);
    try { if (tt) await tt.loadAllLinks($result); }
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
        setResult('Refresh failed: ' + TK.errText(res, 'HTTP ' + res.status) + (d.stale ? ' - still showing the list ' + fmtAge(d.fetchedAt ? Math.round((Date.now() - Date.parse(d.fetchedAt)) / 1000) : null) : ''), true);
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
`;

export const SET_PAGE: UiPage = {
  path: "/set",
  html: shell({
    nav: null,
    title: "Set",
    description:
      "Paste a 1001tracklists tracklist URL to see its tracks, links and why it is or is not in your playlists.",
    body: BODY,
    css: CSS,
    js: JS,
  }),
};
