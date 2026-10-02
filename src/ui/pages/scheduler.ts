// Scheduler: where the fetch scheduler's slots go, and what is starving.
// Three parts, all read-only:
//   - the last 24 h of ticks (GET /ui/api/scheduler .summary): ticks run and
//     skipped by reason, items per class and kind, outcomes, stop reasons, and
//     when each class and kind last ran and last went well;
//   - what is waiting (.summary.latestDue and .djs): the newest due count per
//     class, and every subscribed DJ's next discovery and backfill, most
//     overdue first;
//   - the tick list (GET /ui/api/scheduler/ticks, "Load older" via ?before=).
// Every value from the API goes through esc; rows are rendered through
// innerHTML and clicks are delegated (the tests run this in a stub DOM).
import { skelHtml } from '../skeleton'
import { shell } from '../shell'
import type { UiPage } from './index'

const BODY = /* html */ `
<section class="tk-card" aria-labelledby="sc-h-day">
  <div class="sc-head"><h2 id="sc-h-day">Last 24 hours</h2><span id="sc-asof" class="muted sc-asof"></span></div>
  <div id="sc-err" class="error"></div>
  <div id="sc-tiles" class="tk-tiles">${skelHtml(1, 'row')}</div>
  <div class="tk-grid two">
    <div class="tk-table-wrap"><table class="tk-table sc-t"><thead><tr><th>Class</th><th class="num">Items</th><th class="num">Due now</th><th>Last picked</th><th>Last ok</th></tr></thead><tbody id="sc-classes"></tbody></table></div>
    <div class="tk-table-wrap"><table class="tk-table sc-t"><thead><tr><th>Kind</th><th class="num">Items</th><th>Outcomes</th><th>Last picked</th><th>Last ok</th></tr></thead><tbody id="sc-kinds"></tbody></table></div>
  </div>
  <div class="sc-reasons" id="sc-reasons"></div>
</section>

<section class="tk-card" aria-labelledby="sc-h-djs">
  <div class="sc-head"><h2 id="sc-h-djs">DJ due times</h2><span id="sc-djs-count" class="muted sc-asof"></span></div>
  <p class="muted sc-note">Discovery reads each DJ's listing page about once a day; backfill takes one "older sets" step at a time. Overdue means the time passed and no tick has picked it yet.</p>
  <div class="tk-table-wrap"><table class="tk-table sc-t"><thead><tr><th>DJ</th><th>Discovery</th><th>Backfill</th></tr></thead><tbody id="sc-djs"><tr><td colspan="3">${skelHtml(3, 'row')}</td></tr></tbody></table></div>
  <p class="sc-foot"><button id="sc-djs-all" type="button" class="btn" hidden>Show all DJs</button></p>
</section>

<section class="tk-card" aria-labelledby="sc-h-ticks">
  <div class="sc-head"><h2 id="sc-h-ticks">Ticks</h2><span class="muted sc-asof">newest first</span></div>
  <div id="sc-ticks-err" class="error"></div>
  <div class="tk-table-wrap"><table class="tk-table sc-t sc-ticks"><thead><tr><th>Time</th><th class="num">Took</th><th class="num">Drawn</th><th>Due n/v/r/b</th><th>Picked</th><th>Result</th></tr></thead><tbody id="sc-ticks"><tr><td colspan="6">${skelHtml(4, 'row')}</td></tr></tbody></table></div>
  <div id="sc-ticks-empty" class="empty" hidden>No ticks recorded yet.</div>
  <p class="sc-foot"><button id="sc-more" type="button" class="btn" hidden>Load older</button></p>
</section>
`

const CSS = /* css */ `
  .sc-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; margin-bottom: var(--sp-3); }
  .sc-head h2 { margin: 0; }
  .sc-asof { font-size: var(--fs-sm); }
  .sc-note { margin: 0 0 var(--sp-3); font-size: var(--fs-sm); }
  .sc-t td { font-variant-numeric: tabular-nums; }
  .sc-t tr.starve td:first-child { box-shadow: inset 3px 0 0 var(--warn); }
  .sc-t tr.late td:first-child { box-shadow: inset 3px 0 0 var(--danger); }
  .sc-t .sub { display: block; color: var(--muted); font-size: var(--fs-xs); }
  .sc-outs { display: flex; flex-wrap: wrap; gap: 4px; }
  .sc-reasons { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr)); gap: var(--sp-3) var(--sp-4); margin-top: var(--sp-3); font-size: var(--fs-sm); }
  .sc-reasons h3 { margin: 0 0 var(--sp-1); font-size: var(--fs-sm); color: var(--muted); }
  .sc-reasons ul { margin: 0; padding: 0; list-style: none; }
  .sc-reasons li { display: flex; justify-content: space-between; gap: var(--sp-2); padding: 2px 0; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
  .sc-reasons li:last-child { border-bottom: 0; }
  .sc-reasons .n { font-variant-numeric: tabular-nums; flex: none; }
  .sc-items { margin: 0; padding: 0; list-style: none; display: grid; gap: 3px; }
  .sc-items li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 6px; min-width: 0; }
  .sc-items .kind { font-family: var(--mono); font-size: var(--fs-xs); color: var(--muted); }
  .sc-items .lbl { overflow-wrap: anywhere; min-width: 0; }
  .sc-items .why { color: var(--muted); font-size: var(--fs-xs); overflow-wrap: anywhere; }
  .sc-ticks td.res { overflow-wrap: anywhere; }
  .sc-ticks td.res .error { display: block; }
  .sc-foot { margin: var(--sp-3) 0 0; }
  .sc-foot .btn { width: 100%; }
  .sc-foot:has(.btn[hidden]) { display: none; }
  .badge.sm { font-size: var(--fs-xs); }
  @media (max-width: 799px) {
    .sc-ticks td.items, .sc-ticks td.res { display: block; text-align: left; }
    .sc-ticks td.items::before, .sc-ticks td.res::before { display: block; margin-bottom: 2px; }
    .sc-t tr.starve, .sc-t tr.late { box-shadow: inset 3px 0 0 var(--warn); }
    .sc-t tr.late { box-shadow: inset 3px 0 0 var(--danger); }
    .sc-t tr.starve td:first-child, .sc-t tr.late td:first-child { box-shadow: none; }
  }
`

const JS = /* js */ `
(() => {
  const $ = TK.$, esc = TK.esc;
  const CLASSES = ['new', 'verify', 'recheck', 'backfill'];
  const KINDS = ['discovery', 'set', 'verify', 'render_feed', 'recheck', 'dj_backfill'];
  const KIND_WORDS = { discovery: 'DJ discovery', set: 'Set (first fetch)', verify: 'Verify (2nd fetch)', render_feed: 'Render feeder', recheck: 'Recheck', dj_backfill: 'DJ backfill' };
  const SKIP_WORDS = { paused: 'Paused (IP block)', backoff: 'Pool backoff', pool_not_configured: 'Pool not configured', youtube_not_connected: 'YouTube not connected', nothing_due: 'Nothing due', zero_draw: 'Drew zero' };
  const GOOD = new Set(['ok', 'stepped', 'done', 'no_cursor']);
  const OVERDUE_BAD = 6 * 3600;
  const DJ_ROWS = 25;

  // ── formatting ──
  const iso = (sec) => { try { return new Date(sec * 1000).toISOString(); } catch (e) { return ''; } };
  function span(sec) {
    sec = Math.abs(Math.round(sec));
    if (sec < 60) return sec + 's';
    if (sec < 3600) return Math.floor(sec / 60) + 'm';
    if (sec < 86400) { const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60); return h + 'h' + (m ? ' ' + m + 'm' : ''); }
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600); return d + 'd' + (h ? ' ' + h + 'h' : '');
  }
  const when = (sec) => sec ? '<span title="' + esc(iso(sec)) + '">' + esc(TK.fmt.rel(iso(sec)) || '—') + '</span>' : '<span class="muted">never</span>';
  const took = (ms) => ms == null ? '—' : ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s';
  const outCls = (o) => GOOD.has(o) ? 'ok' : o === 'stopped' || o === 'skipped' || o === 'soft_failed' ? 'warn' : 'bad';
  const badge = (cls, text, title) => '<span class="badge sm ' + cls + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(text) + '</span>';
  const djLink = (slug, name) => slug ? '<a href="/ui/dj/' + encodeURIComponent(slug) + '">' + esc(name || slug) + '</a>' : '';
  const n = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
  const entries = (m) => Object.keys(m || {}).map((k) => [k, n(m[k])]).filter((e) => e[1] > 0).sort((a, b) => b[1] - a[1]);

  // ── the 24 h summary ──
  function renderSummary(s) {
    const skippedTotal = n(s.skippedTicks);
    const goodItems = Object.keys(s.outcomes || {}).filter((o) => GOOD.has(o)).reduce((a, o) => a + n(s.outcomes[o]), 0);
    const tile = (k, v, sub, cls) => '<div class="tk-tile"><div class="k">' + esc(k) + '</div><div class="v' + (cls ? ' ' + cls : '') + '">' + esc(v) + '</div><div class="s">' + sub + '</div></div>';
    $('sc-tiles').innerHTML =
      tile('Ticks', String(n(s.ticks)), esc(n(s.ranTicks) + ' ran, ' + skippedTotal + ' skipped')) +
      tile('Items run', String(n(s.items)), esc(goodItems + ' ok of ' + n(s.drawn) + ' drawn')) +
      tile('Stopped early', String(Object.keys(s.stopReasons || {}).reduce((a, k) => a + n(s.stopReasons[k]), 0)), 'ticks cut short') +
      tile('Errors', String(n(s.errored)), n(s.errored) ? '<span class="error">ticks that threw</span>' : 'ticks that threw');
    $('sc-asof').textContent = s.oldestTickAt ? 'history since ' + (TK.fmt.time(iso(s.oldestTickAt)) || '') : 'no ticks recorded yet';

    const due = s.latestDue && s.latestDue.due ? s.latestDue.due : null;
    const last = (s.lastRun && s.lastRun.byClass) || {};
    $('sc-classes').innerHTML = CLASSES.map((c) => {
      const items = n(s.byClass && s.byClass[c]);
      const d = due ? n(due[c]) : null;
      const lr = last[c] || {};
      // Starving: work was due at the last count, yet nothing of this class ran all day.
      const starve = d && items === 0;
      return '<tr' + (starve ? ' class="starve"' : '') + '><td data-label="Class">' + esc(c) + (starve ? ' ' + badge('warn', 'starving') : '') + '</td>' +
        '<td data-label="Items" class="num">' + items + '</td>' +
        '<td data-label="Due now" class="num">' + (d == null ? '—' : esc(d)) + '</td>' +
        '<td data-label="Last picked">' + when(lr.picked) + '</td>' +
        '<td data-label="Last ok">' + when(lr.ok) + '</td></tr>';
    }).join('') + (s.latestDue ? '<tr><td colspan="5" class="muted" data-label="">Due counted ' + when(s.latestDue.at) + '; a floor, each class query has its own limit.</td></tr>' : '');

    const lastK = (s.lastRun && s.lastRun.byKind) || {};
    const kinds = KINDS.concat(Object.keys(s.byKind || {}).filter((k) => KINDS.indexOf(k) < 0));
    $('sc-kinds').innerHTML = kinds.map((k) => {
      const items = n(s.byKind && s.byKind[k]);
      const outs = entries(s.outcomesByKind && s.outcomesByKind[k]);
      const lr = lastK[k] || {};
      return '<tr><td data-label="Kind">' + esc(KIND_WORDS[k] || k) + '<span class="sub mono">' + esc(k) + '</span></td>' +
        '<td data-label="Items" class="num">' + items + '</td>' +
        '<td data-label="Outcomes"><span class="sc-outs">' + (outs.length ? outs.map((e) => badge(outCls(e[0]), e[0] + ' ' + e[1])).join('') : '<span class="muted">—</span>') + '</span></td>' +
        '<td data-label="Last picked">' + when(lr.picked) + '</td>' +
        '<td data-label="Last ok">' + when(lr.ok) + '</td></tr>';
    }).join('');

    const list = (title, m, words) => {
      const e = entries(m);
      return '<div><h3>' + esc(title) + '</h3>' + (e.length ? '<ul>' + e.map((x) => '<li><span>' + esc((words && words[x[0]]) || x[0]) + '</span><span class="n">' + x[1] + '</span></li>').join('') + '</ul>' : '<span class="muted">none</span>') + '</div>';
    };
    $('sc-reasons').innerHTML = list('Skipped ticks', s.skipped, SKIP_WORDS) + list('Stop reasons', s.stopReasons) + list('Outcomes', s.outcomes);
  }

  // ── DJ due times ──
  let djs = [], djsAll = false;
  function dueCell(at, over) {
    if (at == null || over == null) return '<span class="muted">not scheduled</span>';
    if (over > 0) return badge(over > OVERDUE_BAD ? 'bad' : 'warn', span(over) + ' overdue', iso(at));
    return '<span title="' + esc(iso(at)) + '">in ' + esc(span(-over)) + '</span>';
  }
  function renderDjs() {
    const late = djs.filter((d) => n(d.discoveryOverdue) > 0 || n(d.backfillOverdue) > 0).length;
    $('sc-djs-count').textContent = djs.length ? late + ' of ' + djs.length + ' overdue' : '';
    const shown = djsAll ? djs : djs.slice(0, DJ_ROWS);
    $('sc-djs').innerHTML = shown.length ? shown.map((d) => {
      const worst = Math.max(n(d.discoveryOverdue), n(d.backfillOverdue));
      const cls = worst > OVERDUE_BAD ? ' class="late"' : worst > 0 ? ' class="starve"' : '';
      return '<tr' + cls + '><td data-label="DJ">' + djLink(d.slug, d.name) + '</td>' +
        '<td data-label="Discovery">' + dueCell(d.nextDiscoveryAt, d.discoveryOverdue) + '</td>' +
        '<td data-label="Backfill">' + dueCell(d.nextBackfillAt, d.backfillOverdue) + '</td></tr>';
    }).join('') : '<tr><td colspan="3" class="muted" data-label="">No subscribed DJs.</td></tr>';
    $('sc-djs-all').hidden = djsAll || djs.length <= DJ_ROWS;
  }

  async function loadSummary() {
    await TK.api.swr('/ui/api/scheduler', (res) => {
      const d = res && res.ok && res.data && res.data.summary ? res.data : null;
      if (!d) { $('sc-err').textContent = TK.errText(res, 'Could not load the scheduler summary (' + ((res && res.status) || 'offline') + ')'); return; }
      $('sc-err').textContent = '';
      renderSummary(d.summary);
      djs = Array.isArray(d.djs) ? d.djs : [];
      renderDjs();
    });
  }

  // ── the tick list ──
  let ticks = [], nextBefore = null, seq = 0;
  function itemHtml(x) {
    const what = x.label
      ? '<a class="lbl" href="/ui/set?url=' + encodeURIComponent(x.url || '') + '">' + esc(x.label) + '</a>'
      : '<span class="lbl">' + djLink(x.slug, x.slug) + '</span>';
    return '<li>' + badge(outCls(x.outcome), x.outcome || '?') + '<span class="kind">' + esc(x.kind) + '</span>' +
      (x.label && x.slug ? '<span class="muted">' + djLink(x.slug, x.slug) + '</span>' : '') + what +
      (x.stopReason ? '<span class="why">' + esc(x.stopReason) + '</span>' : '') + '</li>';
  }
  function tickHtml(t) {
    const due = t.due ? CLASSES.map((c) => esc(n(t.due[c]))).join('/') : '—';
    const items = Array.isArray(t.items) ? t.items : [];
    let res = '';
    if (t.skipped) res += badge('neutral', SKIP_WORDS[t.skipped] || t.skipped);
    if (t.stoppedBy) res += badge('warn', 'stopped') + ' <span>' + esc(t.stoppedBy) + '</span>';
    if (t.error) res += '<span class="error">' + esc(t.error) + '</span>';
    if (!res) res = items.length ? badge('ok', 'done') : '<span class="muted">—</span>';
    return '<tr' + (t.error ? ' class="late"' : t.stoppedBy ? ' class="starve"' : '') + '>' +
      '<td data-label="Time"><span title="' + esc(iso(t.at)) + '">' + esc(TK.fmt.time(iso(t.at))) + '</span><span class="sub">' + esc(TK.fmt.rel(iso(t.at))) + '</span></td>' +
      '<td data-label="Took" class="num">' + esc(took(t.ms)) + '</td>' +
      '<td data-label="Drawn" class="num">' + esc(n(t.drawn)) + '</td>' +
      '<td data-label="Due n/v/r/b" class="mono">' + due + '</td>' +
      '<td data-label="Picked" class="items">' + (items.length ? '<ul class="sc-items">' + items.map(itemHtml).join('') + '</ul>' : '<span class="muted">nothing</span>') + '</td>' +
      '<td data-label="Result" class="res">' + res + '</td></tr>';
  }
  function renderTicks() {
    $('sc-ticks').innerHTML = ticks.map(tickHtml).join('');
    $('sc-ticks-empty').hidden = ticks.length > 0;
    $('sc-more').hidden = !nextBefore;
  }
  async function loadTicks(more) {
    if (more && !nextBefore) return;
    const my = ++seq;
    const apply = (res) => {
      if (my !== seq) return;
      const d = res && res.ok && res.data && Array.isArray(res.data.ticks) ? res.data : null;
      if (!d) { $('sc-ticks-err').textContent = TK.errText(res, 'Could not load ticks (' + ((res && res.status) || 'offline') + ')'); if (!more && !ticks.length) $('sc-ticks').innerHTML = ''; return; }
      $('sc-ticks-err').textContent = '';
      ticks = more ? ticks.concat(d.ticks) : d.ticks.slice();
      // A stored first page pages on only once the live one is in.
      nextBefore = res.stale ? null : (d.nextBefore || null);
      renderTicks();
    };
    if (more) apply(await TK.api.get('/ui/api/scheduler/ticks?limit=50&before=' + encodeURIComponent(nextBefore)));
    else await TK.api.swr('/ui/api/scheduler/ticks?limit=50', apply);
  }

  $('sc-more').addEventListener('click', () => TK.busy($('sc-more'), 'Loading…', () => loadTicks(true)));
  $('sc-djs-all').addEventListener('click', () => { djsAll = true; renderDjs(); });
  const $refresh = $('sc-refresh');
  if ($refresh) $refresh.addEventListener('click', () => TK.busy($refresh, 'Refreshing…', () => Promise.all([loadSummary(), loadTicks(false)])));

  loadSummary().catch(() => {});
  loadTicks(false).catch(() => {});
})();
`

export const SCHEDULER_PAGE: UiPage = {
  path: '/scheduler',
  html: shell({
    nav: 'scheduler',
    title: 'Scheduler',
    description: 'Where the fetch scheduler\'s slots go, and what is waiting. Its knobs (priority order, shares, recheck schedule) are on <a href="/ui/pool/settings">Pool settings</a>.',
    actions: '<button id="sc-refresh" type="button" class="btn">Refresh</button>',
    body: BODY,
    css: CSS,
    js: JS,
  }),
}
