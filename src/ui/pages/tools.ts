// Tools: the YouTube video JSON inspector, tracklist purge, ban simulation,
// requeue of ban victims and the migration status. BAN_JS (banPage 'other')
// handles #ban-simulate by id.
import { shell } from '../shell'
import type { UiPage } from './index'

const BODY = /* html */ `
<div class="tk-card">
  <div class="tl-head">
    <h2>YouTube video JSON</h2>
    <button id="ytjson-copy" type="button" class="btn small" hidden>Copy</button>
  </div>
  <form id="ytjson-form" class="tl-form">
    <div class="field grow"><label for="ytjson-url">Video URL or id</label><input id="ytjson-url" type="text" placeholder="https://www.youtube.com/watch?v=… (or a bare video id)" /></div>
    <button id="ytjson-go" type="submit" class="btn primary">Fetch</button>
  </form>
  <div id="ytjson-status" class="tl-status muted" role="status"></div>
  <pre id="ytjson-out" class="tl-pre" hidden></pre>
</div>
<div class="tk-card">
  <h2>Purge a tracklist</h2>
  <p class="muted tl-note">Drops the cached list and fetches it again now (costs one upstream fetch).</p>
  <form id="purge-form" class="tl-form">
    <div class="field grow"><label for="purge-url">Tracklist URL</label><input id="purge-url" type="url" placeholder="https://www.1001tracklists.com/tracklist/.../....html" /></div>
    <button id="purge-go" type="submit" class="btn primary">Purge and refetch</button>
  </form>
  <div id="purge-result" class="tl-status muted" role="status"></div>
</div>
<div class="tk-card">
  <h2>Simulate a ban</h2>
  <p class="muted tl-note">Test the whole alert path without a real ban: <a href="#" id="ban-simulate">simulate a ban</a> (banner and push; dismiss from the banner).</p>
</div>
<div class="tk-card">
  <h2>Requeue ban victims</h2>
  <p class="muted tl-note">Re-queues sets that were abandoned only because every fetch route was blocked.</p>
  <form id="rq-form" class="tl-form">
    <div class="field"><label for="rq-days">Days back</label><input id="rq-days" type="number" min="1" value="14" /></div>
    <label class="tl-check"><input id="rq-dry" type="checkbox" checked /> Dry run (preview only)</label>
    <button id="rq-go" type="submit" class="btn primary">Requeue</button>
  </form>
  <pre id="rq-out" class="tl-pre" hidden></pre>
</div>
<div class="tk-card">
  <div class="tl-head">
    <h2>Migration status</h2>
    <button id="mig-go" type="button" class="btn small">Check</button>
  </div>
  <pre id="mig-out" class="tl-pre" hidden></pre>
</div>
`

const CSS = /* css */ `
  .btn.small { padding: 5px 10px; font-size: var(--fs-sm); }
  .tl-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); margin-bottom: var(--sp-3); }
  .tl-head h2 { margin: 0; }
  .tl-note { margin: 0 0 var(--sp-3); font-size: var(--fs-sm); }
  .tl-form { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--sp-3); }
  .tl-form .grow { flex: 1 1 18rem; }
  .tl-check { display: inline-flex; align-items: center; gap: 6px; padding-bottom: 9px; }
  .tl-status { font-size: var(--fs-sm); min-height: 1.2em; margin-top: var(--sp-2); }
  .tl-status .bad { color: var(--danger); }
  .tl-status .mono { font-family: var(--mono); }
  .tl-pre { margin: var(--sp-3) 0 0; padding: var(--sp-3); max-height: 28rem; overflow: auto; font-family: var(--mono); font-size: var(--fs-xs); line-height: 1.45; background: var(--page); border: 1px solid var(--line); border-radius: var(--r-ctl); white-space: pre-wrap; overflow-wrap: anywhere; }
`

const JS = /* js */ `
(() => {
  const $ = TK.$, esc = TK.esc;

  function link(u, label) {
    const h = TK.safeHref(u);
    return h ? '<a href="' + esc(h) + '" target="_blank" rel="noreferrer noopener">' + esc(label || u) + '</a>' : esc(u);
  }

  // ── YouTube video JSON ──
  const $yjForm = $('ytjson-form'), $yjUrl = $('ytjson-url'), $yjGo = $('ytjson-go'), $yjStatus = $('ytjson-status'), $yjOut = $('ytjson-out'), $yjCopy = $('ytjson-copy');
  function yjStatus(html) { $yjStatus.innerHTML = html || ''; }
  function yjFail(msg) { $yjOut.hidden = true; $yjCopy.hidden = true; yjStatus('<span class="bad">' + esc(msg) + '</span>'); }

  async function fetchVideoJson(input) {
    yjStatus('fetching…');
    await TK.busy($yjGo, 'Fetching…', async () => {
      const res = await TK.api.get('/ui/api/youtube/video?url=' + encodeURIComponent(input));
      if (!res.ok) { yjFail(TK.errText(res, res.raw || 'failed (' + res.status + ')')); return; }
      const data = res.data;
      // textContent, never innerHTML: the payload is third-party text.
      $yjOut.textContent = JSON.stringify(data, null, 2);
      $yjOut.hidden = false;
      $yjCopy.hidden = false;
      const sn = (data && data.video && data.video.snippet) || {};
      yjStatus('<span class="mono">' + esc(data && data.videoId) + '</span> · ' + link(data && data.watchUrl, 'open on YouTube') + (sn.title ? ' · ' + esc(sn.title) : ''));
    });
  }
  $yjForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $yjUrl.value.trim();
    if (v) fetchVideoJson(v);
  });
  $yjCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($yjOut.textContent);
      const original = $yjCopy.textContent;
      $yjCopy.textContent = 'Copied';
      setTimeout(() => { $yjCopy.textContent = original; }, 1200);
    } catch (e) { yjStatus('<span class="bad">clipboard blocked — select the JSON and copy manually</span>'); }
  });

  // ── purge a tracklist ──
  const $pForm = $('purge-form'), $pUrl = $('purge-url'), $pGo = $('purge-go'), $pRes = $('purge-result');
  function pResult(msg, bad) { $pRes.className = 'tl-status ' + (bad ? 'bad' : 'muted'); $pRes.textContent = msg; }
  function fmtAge(sec) {
    if (sec == null) return 'cached list, age unknown';
    if (sec < 90) return 'fetched just now';
    const m = Math.round(sec / 60);
    if (m < 90) return 'fetched ' + m + ' min ago';
    const h = Math.round(sec / 3600);
    if (h < 48) return 'fetched ' + h + ' h ago';
    return 'fetched ' + Math.round(sec / 86400) + ' days ago';
  }
  $pForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $pUrl.value.trim();
    if (!url) return;
    pResult('Refreshing…', false);
    TK.busy($pGo, 'Refreshing…', async () => {
      const res = await TK.api.post('/ui/api/tracklist/purge', { url });
      const d = res.data && typeof res.data === 'object' ? res.data : {};
      if (!res.ok) {
        pResult('Refresh failed: ' + TK.errText(res, 'HTTP ' + res.status) + (d.stale ? ' — still showing the list ' + fmtAge(d.fetchedAt ? Math.round((Date.now() - Date.parse(d.fetchedAt)) / 1000) : null) : ''), true);
        return;
      }
      pResult(d.refreshed === false
        ? (d.dailyCapReached ? 'Not refetched: the daily limit of forced refreshes is used up; showing the cached list.' : 'Not refetched: this set was just refreshed; try again in ' + d.cooldownSeconds + ' s.')
        : 'Refreshed: ' + d.rowCount + ' rows, ' + d.identifiedCount + ' of ' + d.trackCount + ' identified', false);
    });
  });

  // ── requeue ban victims ──
  const $rqForm = $('rq-form'), $rqDays = $('rq-days'), $rqDry = $('rq-dry'), $rqGo = $('rq-go'), $rqOut = $('rq-out');
  $rqForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const days = Number($rqDays.value);
    const n = Number.isFinite(days) && days > 0 ? Math.floor(days) : 14;
    TK.busy($rqGo, 'Requeueing…', async () => {
      const res = await TK.api.post('/ui/api/ban/requeue-victims?days=' + n + ($rqDry.checked ? '&dry=1' : ''), {});
      $rqOut.textContent = res.ok ? JSON.stringify(res.data, null, 2) : TK.errText(res, 'failed (' + res.status + ')');
      $rqOut.hidden = false;
    });
  });

  // ── migration status ──
  const $migGo = $('mig-go'), $migOut = $('mig-out');
  async function loadMigration() {
    await TK.busy($migGo, 'Checking…', async () => {
      const res = await TK.api.get('/ui/api/migration');
      $migOut.textContent = res.ok ? JSON.stringify(res.data, null, 2) : TK.errText(res, 'failed (' + res.status + ')');
      $migOut.hidden = false;
    });
  }
  $migGo.addEventListener('click', loadMigration);
  loadMigration();
})();
`

export const TOOLS_PAGE: UiPage = {
  path: '/tools',
  html: shell({
    nav: 'tools',
    title: 'Tools',
    description: 'Inspect, purge and repair things by hand.',
    body: BODY,
    css: CSS,
    js: JS,
  }),
}
