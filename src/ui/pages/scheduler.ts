// Scheduler: where the fetch scheduler's slots go, and what is starving.
// Three parts, all read-only:
//   - the last 24 h of ticks (GET /ui/api/scheduler .summary): ticks run and
//     skipped by reason, items per class and kind, outcomes, stop reasons, and
//     when each class and kind last ran and last went well;
//   - what is waiting (.summary.latestDue and .djs): the newest due count per
//     class, and every subscribed DJ's next discovery and backfill, most
//     overdue first, in a local TKTable (one row per subscription; the
//     overdue math is done by the Worker, so the list rides with the summary);
//   - the tick list: a server-side TKTable over GET /ui/api/scheduler/ticks
//     (sort, filter, search and page over every recorded tick); a row opens a
//     drawer with everything that tick picked.
// Every value from the API goes through esc; rows are rendered through
// innerHTML and clicks are delegated (the tests run this in a stub DOM).
import { skelHtml } from '../skeleton'
import { shell } from '../shell'
import { tipAttr } from '../tip'
import type { UiPage } from './index'

const BODY = /* html */ `
<section class="tk-card" aria-labelledby="sc-h-day">
  <div class="sc-head"><h2 id="sc-h-day"><span class="tip-term"${tipAttr('Every 5 minutes the scheduler wakes up (a tick), draws a few items from what is due and fetches them one at a time. This summarizes the ticks of the last day.')}>Last 24 hours</span></h2><span id="sc-asof" class="muted sc-asof"></span></div>
  <div id="sc-err" class="error"></div>
  <div id="sc-tiles" class="tk-tiles">${skelHtml(1, 'row')}</div>
  <div class="tk-grid two">
    <div class="tk-table-wrap"><table class="tk-table sc-t"><thead><tr><th><span class="tip-term"${tipAttr('The scheduler takes work in priority order (set in Pool settings). new: sets just discovered. verify: the second fetch that confirms a track list. recheck: sets due again by their age. backfill: older sets of a DJ.')}>Class</span></th><th class="num">Items</th><th class="num"><span class="tip-term"${tipAttr('How many items of this class were waiting at the last count. A floor: each class query has its own limit.')}>Due now</span></th><th>Last picked</th><th>Last ok</th></tr></thead><tbody id="sc-classes"></tbody></table></div>
    <div class="tk-table-wrap"><table class="tk-table sc-t"><thead><tr><th><span class="tip-term"${tipAttr('The kind of fetch an item was: a finer split than the class.')}>Kind</span></th><th class="num">Items</th><th><span class="tip-term"${tipAttr('How the items ended: ok, stopped by a refusal, skipped, or failed.')}>Outcomes</span></th><th>Last picked</th><th>Last ok</th></tr></thead><tbody id="sc-kinds"></tbody></table></div>
  </div>
  <div class="sc-reasons" id="sc-reasons"></div>
</section>

<section class="tk-card" aria-labelledby="sc-h-djs">
  <div class="sc-head"><h2 id="sc-h-djs"><span class="tip-term"${tipAttr('Discovery reads each DJ\'s listing page about once a day; backfill takes one "older sets" step at a time. Overdue means the time passed and no tick has picked it up yet.')}>DJ due times</span></h2><span id="sc-djs-count" class="muted sc-asof"></span></div>
  <div id="sc-djs"></div>
</section>

<section class="tk-card" aria-labelledby="sc-h-ticks">
  <div class="sc-head"><h2 id="sc-h-ticks"><span class="tip-term"${tipAttr('One row per scheduler wake-up: how many items it drew, what was due, what it picked and how it ended.')}>Ticks</span></h2><span class="muted sc-asof">click a row for what it picked</span></div>
  <div id="sc-ticks"></div>
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
  .sc-res { overflow-wrap: anywhere; }
  .sc-res .error { display: block; }
  .sc-pick { display: flex; flex-wrap: wrap; gap: 4px; align-items: baseline; }
  .sc-pick .lbl { color: var(--muted); font-size: var(--fs-xs); overflow-wrap: anywhere; }
  .tkt-table .sub { display: block; color: var(--muted); font-size: var(--fs-xs); }
  .sc-when { display: inline-flex; flex-direction: column; }
  @media (max-width: 699px) { .sc-when { align-items: flex-end; } }
  .tkt-table tr.late > td:first-child { box-shadow: inset 3px 0 0 var(--danger); }
  .tkt-table tr.starve > td:first-child { box-shadow: inset 3px 0 0 var(--warn); }
  .badge.sm { font-size: var(--fs-xs); }
  @media (max-width: 699px) {
    .sc-t tr.starve, .sc-t tr.late, .tkt-table tr.starve { box-shadow: inset 3px 0 0 var(--warn); }
    .sc-t tr.late, .tkt-table tr.late { box-shadow: inset 3px 0 0 var(--danger); }
    .sc-t tr.starve td:first-child, .sc-t tr.late td:first-child, .tkt-table tr.starve > td:first-child, .tkt-table tr.late > td:first-child { box-shadow: none; }
  }
`

const JS = /* js */ `
(() => {
  const $ = TK.$, esc = TK.esc;
  const CLASSES = ['new', 'verify', 'recheck', 'backfill'];
  const KINDS = ['discovery', 'set', 'verify', 'render_feed', 'recheck', 'dj_backfill', 'presave'];
  const KIND_WORDS = { discovery: 'DJ discovery', set: 'Set (first fetch)', verify: 'Verify (2nd fetch)', render_feed: 'Render feeder', recheck: 'Recheck', dj_backfill: 'DJ backfill', presave: 'Pre-save recheck' };
  const SKIP_WORDS = { paused: 'Paused (IP block)', backoff: 'Pool backoff', pool_not_configured: 'Pool not configured', youtube_not_connected: 'YouTube not connected', nothing_due: 'Nothing due', zero_draw: 'Drew zero' };
  const GOOD = new Set(['ok', 'stepped', 'done', 'no_cursor']);
  const OVERDUE_BAD = 6 * 3600;

  // ── formatting ──
  const iso = (sec) => { try { return new Date(sec * 1000).toISOString(); } catch (e) { return ''; } };
  function span(sec) {
    sec = Math.abs(Math.round(sec));
    if (sec < 60) return sec + 's';
    if (sec < 3600) return Math.floor(sec / 60) + 'm';
    if (sec < 86400) { const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60); return h + 'h' + (m ? ' ' + m + 'm' : ''); }
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600); return d + 'd' + (h ? ' ' + h + 'h' : '');
  }
  const when = (sec) => sec ? '<span' + TK.tip(iso(sec)) + '>' + esc(TK.fmt.rel(iso(sec)) || '—') + '</span>' : '<span class="muted">never</span>';
  const took = (ms) => ms == null ? '—' : ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s';
  const outCls = (o) => GOOD.has(o) ? 'ok' : o === 'stopped' || o === 'skipped' || o === 'soft_failed' ? 'warn' : 'bad';
  const badge = (cls, text, tip) => '<span class="badge sm ' + cls + '"' + TK.tip(tip) + '>' + esc(text) + '</span>';
  const OUT_TIPS = {
    ok: 'The fetch worked.',
    done: 'Finished: nothing more to do for this item.',
    stepped: 'A backfill step worked; more older sets remain.',
    no_cursor: 'The DJ had no backfill position to continue from.',
    stopped: 'Stopped by a refusal (paused, no healthy account, captcha, timeout); the tick ended there.',
    skipped: 'Left alone this time (for instance a cooldown).',
    soft_failed: 'Failed in a way that is retried later without counting against the item.',
    failed: 'The fetch failed and counts against the item (three strikes and it is abandoned).',
    threw: 'An unexpected error. See the tick row for the message.',
  };
  const SKIP_TIPS = {
    paused: 'Fetching is paused after an IP block.',
    backoff: 'The pool asked the scheduler to wait before the next tick.',
    pool_not_configured: 'No tlpool is set up, so nothing can be fetched.',
    youtube_not_connected: 'YouTube is not connected, so the sync cannot add videos.',
    nothing_due: 'Nothing was due at this tick.',
    zero_draw: 'The random draw picked zero items (the tick size allows 0).',
  };
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
    // A due count from a paused / backed-off stretch is stale: only one from the last hour can flag starving.
    const freshDue = !!due && (!s.now || s.now - s.latestDue.at <= 3600);
    const last = (s.lastRun && s.lastRun.byClass) || {};
    $('sc-classes').innerHTML = CLASSES.map((c) => {
      const items = n(s.byClass && s.byClass[c]);
      const d = due ? n(due[c]) : null;
      const lr = last[c] || {};
      // Starving: work was due at the last count, yet nothing of this class ran all day.
      const starve = freshDue && d && items === 0;
      return '<tr' + (starve ? ' class="starve"' : '') + '><td data-label="Class">' + esc(c) + (starve ? ' ' + badge('warn', 'starving', 'Work was due at the last count, yet no item of this class ran in the last 24 hours.') : '') + '</td>' +
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
        '<td data-label="Outcomes"><span class="sc-outs">' + (outs.length ? outs.map((e) => badge(outCls(e[0]), e[0] + ' ' + e[1], OUT_TIPS[e[0]])).join('') : '<span class="muted">—</span>') + '</span></td>' +
        '<td data-label="Last picked">' + when(lr.picked) + '</td>' +
        '<td data-label="Last ok">' + when(lr.ok) + '</td></tr>';
    }).join('');

    const list = (title, m, words) => {
      const e = entries(m);
      return '<div><h3>' + esc(title) + '</h3>' + (e.length ? '<ul>' + e.map((x) => '<li><span>' + esc((words && words[x[0]]) || x[0]) + '</span><span class="n">' + x[1] + '</span></li>').join('') + '</ul>' : '<span class="muted">none</span>') + '</div>';
    };
    $('sc-reasons').innerHTML = list('Skipped ticks', s.skipped, SKIP_WORDS) + list('Stop reasons', s.stopReasons) + list('Outcomes', s.outcomes);
  }

  // ── DJ due times (a local table over the summary's list) ──
  function dueCell(at, over) {
    if (at == null || over == null) return '<span class="muted">not scheduled</span>';
    if (over > 0) return badge(over > OVERDUE_BAD ? 'bad' : 'warn', span(over) + ' overdue', 'Was due ' + iso(at) + ' and no tick has picked it up yet.');
    return '<span' + TK.tip(iso(at)) + '>in ' + esc(span(-over)) + '</span>';
  }
  const worstOf = (d) => (d.discoveryOverdue == null && d.backfillOverdue == null ? null : Math.max(d.discoveryOverdue == null ? -Infinity : d.discoveryOverdue, d.backfillOverdue == null ? -Infinity : d.backfillOverdue));
  let djs = [];
  const djTable = TKTable.create($('sc-djs'), {
    id: 'djs',
    source: { rows: () => djs },
    rowKey: 'slug',
    defaultSort: '-worst',
    pageSize: 25,
    search: 'Search DJs',
    empty: 'No subscribed DJs.',
    columns: [
      { key: 'dj', label: 'DJ', type: 'text', value: (d) => d.name || d.slug, render: (d) => djLink(d.slug, d.name) },
      { key: 'discoveryOverdue', label: 'Discovery', type: 'number', align: 'left', tip: 'When the DJ page is read next (or how long it is overdue). Sorts by how overdue it is; the filter takes seconds overdue.', render: (d) => dueCell(d.nextDiscoveryAt, d.discoveryOverdue) },
      { key: 'backfillOverdue', label: 'Backfill', type: 'number', align: 'left', tip: 'When the next older-sets step is due (or how long it is overdue); the filter takes seconds overdue.', render: (d) => dueCell(d.nextBackfillAt, d.backfillOverdue) },
      { key: 'worst', label: 'Most overdue', type: 'number', hideOn: 'phone', tip: 'The later of the two: how long this DJ has waited past a due time (the filter takes seconds).', render: (d) => d.worst == null ? '<span class="muted">not scheduled</span>' : d.worst > 0 ? esc(span(d.worst)) : '<span class="muted">on time</span>' },
    ],
    chips: [
      { id: 'all', label: 'All', group: 'due', on: true },
      { id: 'over', label: 'Overdue', group: 'due', filters: [{ col: 'worst', op: 'gt', value: '0' }], tip: 'A discovery or backfill time has passed and no tick has picked it up yet.' },
      { id: 'late', label: 'Over 6 h', group: 'due', filters: [{ col: 'worst', op: 'gt', value: String(OVERDUE_BAD) }], tip: 'Overdue by more than six hours.' },
    ],
    rowAttrs: (d) => (d.worst > OVERDUE_BAD ? { class: 'late' } : d.worst > 0 ? { class: 'starve' } : null),
  });
  function renderDjs() {
    const late = djs.filter((d) => n(d.worst) > 0).length;
    $('sc-djs-count').textContent = djs.length ? late + ' of ' + djs.length + ' overdue' : '';
    djTable.setRows(djs);
  }

  async function loadSummary() {
    await TK.api.swr('/ui/api/scheduler', (res) => {
      const d = res && res.ok && res.data && res.data.summary ? res.data : null;
      if (!d) { $('sc-err').textContent = TK.errText(res, 'Could not load the scheduler summary (' + ((res && res.status) || 'offline') + ')'); return; }
      $('sc-err').textContent = '';
      renderSummary(d.summary);
      djs = (Array.isArray(d.djs) ? d.djs : []).map((x) => Object.assign({}, x, { worst: worstOf(x) }));
      renderDjs();
    });
  }

  // ── the tick list (server-side table) ──
  function itemHtml(x) {
    const what = x.label
      ? '<a class="lbl" href="/ui/set?url=' + encodeURIComponent(x.url || '') + '">' + esc(x.label) + '</a>'
      : '<span class="lbl">' + djLink(x.slug, x.slug) + '</span>';
    return '<li>' + badge(outCls(x.outcome), x.outcome || '?', OUT_TIPS[x.outcome] || 'How this item ended.') + '<span class="kind">' + esc(KIND_WORDS[x.kind] || x.kind) + '</span>' +
      (x.label && x.slug ? '<span class="muted">' + djLink(x.slug, x.slug) + '</span>' : '') + what +
      (x.stopReason ? '<span class="why">' + esc(x.stopReason) + '</span>' : '') + '</li>';
  }
  const dueOf = (t) => (t.due ? CLASSES.map((c) => esc(n(t.due[c]))).join('/') : '—');
  function resultHtml(t) {
    const items = Array.isArray(t.items) ? t.items : [];
    let res = '';
    if (t.skipped) res += badge('neutral', SKIP_WORDS[t.skipped] || t.skipped, SKIP_TIPS[t.skipped] || 'The tick did not run.');
    if (t.stoppedBy) res += badge('warn', 'stopped', 'The tick ended early because of this refusal; the items left are drawn again later.') + ' <span>' + esc(t.stoppedBy) + '</span>';
    if (t.error) res += '<span class="error">' + esc(t.error) + '</span>';
    if (!res) res = items.length ? badge('ok', 'done', 'Every drawn item ran.') : '<span class="muted">—</span>';
    return '<span class="sc-res">' + res + '</span>';
  }
  // The Picked column: outcome counts and the first item; the drawer has them all.
  function pickedHtml(t) {
    const items = Array.isArray(t.items) ? t.items : [];
    if (!items.length) return '<span class="muted">nothing</span>';
    const by = {};
    for (const x of items) by[x.outcome || '?'] = (by[x.outcome || '?'] || 0) + 1;
    const first = items[0];
    return '<span class="sc-pick">' + Object.keys(by).map((o) => badge(outCls(o), o + ' ' + by[o], OUT_TIPS[o] || 'How these items ended.')).join('') +
      '<span class="lbl">' + esc(first.label || first.slug || first.kind) + (items.length > 1 ? ' +' + (items.length - 1) : '') + '</span></span>';
  }
  function tickBody(t) {
    const items = Array.isArray(t.items) ? t.items : [];
    return '<p class="muted">' + esc(TK.fmt.time(iso(t.at))) + ' · took ' + esc(took(t.ms)) + ' · drew ' + esc(n(t.drawn)) + ' · due n/v/r/b ' + dueOf(t) + '</p>' +
      '<p>' + resultHtml(t) + '</p>' +
      (items.length ? '<ul class="sc-items">' + items.map(itemHtml).join('') + '</ul>' : '<p class="muted">This tick picked nothing.</p>');
  }
  const SKIPS = Object.keys(SKIP_WORDS).map((k) => ({ value: k, label: SKIP_WORDS[k] }));
  const dueCol = (key, cls, label, tip) => ({ key, label, type: 'number', hideOn: 'phone', tip, value: (t) => (t.due ? t.due[cls] : null), render: (t) => esc(t.due ? n(t.due[cls]) : '—') });
  const ticks = TKTable.create($('sc-ticks'), {
    id: 'ticks',
    source: { url: '/ui/api/scheduler/ticks' },
    swr: true,
    defaultSort: '-at',
    search: 'Search picked items (DJ, set URL)',
    empty: 'No ticks recorded yet.',
    columns: [
      { key: 'at', label: 'Time', type: 'datetime', storage: 's', render: (t) => '<span class="sc-when"><span' + TK.tip(iso(t.at)) + '>' + esc(TK.fmt.time(iso(t.at))) + '</span><span class="sub">' + esc(TK.fmt.rel(iso(t.at))) + '</span></span>' },
      { key: 'ms', label: 'Took', type: 'number', tip: 'How long the tick ran (the filter takes milliseconds).', render: (t) => esc(took(t.ms)) },
      { key: 'drawn', label: 'Drawn', type: 'number', tip: 'How many items this tick drew at random from what was due (the tick size is a setting).' },
      { key: 'ran', label: 'Ran', type: 'number', hideOn: 'phone', tip: 'How many items it actually ran.' },
      dueCol('dueNew', 'new', 'Due n', 'New sets due at the time of the tick (a floor: each class query has its own limit).'),
      dueCol('dueVerify', 'verify', 'v', 'Verify fetches due at the time of the tick.'),
      dueCol('dueRecheck', 'recheck', 'r', 'Rechecks due at the time of the tick.'),
      dueCol('dueBackfill', 'backfill', 'b', 'Backfill steps due at the time of the tick.'),
      { key: 'picked', label: 'Picked', sortable: false, filterable: false, render: pickedHtml },
      { key: 'skipped', label: 'Result', type: 'enum', options: SKIPS, sortable: false, tip: 'Skipped, stopped early, an error, or done. The filter picks skip reasons.', render: resultHtml },
    ],
    chips: [
      { id: 'all', label: 'All', group: 'kind', on: true },
      { id: 'ran', label: 'Ran items', group: 'kind', filters: [{ col: 'ran', op: 'gt', value: '0' }], tip: 'Ticks that ran at least one item.' },
      { id: 'errors', label: 'Errors', group: 'kind', filters: [{ col: 'error', op: 'nempty', value: '' }], tip: 'Ticks that threw.' },
      { id: 'skipped', label: 'Skipped', group: 'kind', filters: [{ col: 'skipped', op: 'nempty', value: '' }], tip: 'Ticks that did not run: paused, backoff, nothing due.' },
      { id: 'stopped', label: 'Stopped by pool', group: 'kind', filters: [{ col: 'stoppedBy', op: 'nempty', value: '' }], tip: 'Ticks cut short by a refusal: no healthy account, captcha, budget or timeout.' },
      { id: 'failed', label: 'Failed items', group: 'kind', filters: [{ col: 'failedItems', op: 'eq', value: '1' }], tip: 'Ticks where at least one item failed or threw.' },
    ],
    rowAttrs: (t) => (t.error ? { class: 'late' } : t.stoppedBy ? { class: 'starve' } : null),
    onRowClick: (t) => TK.drawer.open('Tick ' + (TK.fmt.time(iso(t.at)) || ''), tickBody(t)),
  });

  const $refresh = $('sc-refresh');
  if ($refresh) $refresh.addEventListener('click', () => TK.busy($refresh, 'Refreshing…', () => Promise.all([loadSummary(), ticks.reload()])));

  loadSummary().catch(() => {});
})();
`

export const SCHEDULER_PAGE: UiPage = {
  path: '/scheduler',
  html: shell({
    nav: 'scheduler',
    title: 'Scheduler',
    description: 'Where the fetch scheduler\'s slots go, and what is waiting. Tune it on <a href="/ui/pool/settings">Pool settings</a>.',
    actions: `<button id="sc-refresh" type="button" class="btn"${tipAttr('Reloads the summary and the tick list.')}>Refresh</button>`,
    body: BODY,
    css: CSS,
    js: JS,
  }),
}
