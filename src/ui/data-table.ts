// The admin UI's data table: one client component (global TKTable) for every
// list, server-paged against the HTTP contract in src/lib/table-query.ts, or
// local (the same features over rows the page already has). The shell embeds
// DATA_TABLE_CSS and DATA_TABLE_JS on every page, after the runtime (TK) and
// before the page's own script.
//
// ── Usage ───────────────────────────────────────────────────────────────────
//
//   <div id="ps-table"></div>
//
//   const table = TKTable.create(TK.$('ps-table'), {
//     id: 'ps',                                  // URL state prefix: ps.page, ps.sort, ps.f.stage, ...
//     source: { url: '/ui/api/presaves', params: () => ({ dj: djSlug }) },
//     columns: [
//       { key: 'artist', label: 'Artist', type: 'text' },
//       { key: 'title', label: 'Title', type: 'text', render: (r) => '<b>' + TK.esc(r.title) + '</b>' },
//       { key: 'stage', label: 'Stage', type: 'enum', options: [{ value: 'links', label: 'Watching' }, 'found'] },
//       { key: 'linkSources', label: 'Links', type: 'enum', multi: true, sortable: false, options: ['spotify', 'apple'] },
//       { key: 'linkCount', label: 'Links', type: 'number', hideOn: 'phone' },
//       { key: 'createdAt', label: 'Saved', type: 'datetime', tip: 'When it was pre-saved.' },
//     ],
//     defaultSort: '-createdAt',
//     search: 'Search artist, title, DJ',      // placeholder; false = no search box
//     chips: [
//       { id: 'all', label: 'All', group: 'stage', on: true },
//       { id: 'watching', label: 'Watching', group: 'stage', filters: [{ col: 'stage', op: 'in', value: 'identify|links' }],
//         count: (resp) => resp.counts && resp.counts.links },
//       { id: 'found', label: 'Found', group: 'stage', filters: [{ col: 'stage', op: 'in', value: 'found' }], sort: '-foundAt' },
//     ],
//     rowKey: 'id',
//     onRowClick: (row, ev) => openDrawer(row),
//     actions: (row) => '<button type="button" class="btn sm" data-act="recheck">Recheck</button>',
//     onAction: (act, row, btn, ev) => { if (act === 'recheck') TK.busy(btn, 'Checking', () => recheck(row)) },
//     onData: (resp) => paintCounts(resp.counts),
//   })
//   table.reload()   // after an action changed the data (keeps page, sort and filters)
//
// ── Config (TKTable.create(el, config)) ─────────────────────────────────────
//
//   id          URL state prefix and element-id prefix (default 'tkt1', 'tkt2', ...).
//   urlState    false: keep state out of the URL (default true when id is given, false in compact).
//   source      { url, params?: () => obj }  server mode: GET url?page=&size=&sort=&q=&f.<col>=op:value
//                 plus params(); the answer is table-query's { rows, total, page, ... } plus any extras.
//               { rows: array | () => array | Promise<array> }  local mode: the same features in JS.
//   columns     [{ key, label, type, sortable, filterable, searchable, options, multi, storage, value,
//                 render, align, width, hideOn, tip }]
//                 type        'text' (default) | 'number' | 'datetime' (unix ms) | 'date' (YYYY-MM-DD) | 'enum' | 'bool'
//                 sortable    default true; filterable default true; searchable (local mode) default type === 'text'
//                 options     enum values: strings or { value, label } (filter checkboxes, chip and cell labels)
//                 multi       enum stored ',a,b,' (or an array in local rows): 'in' = has any, 'all' = has all
//                 storage     datetime in local rows: 'ms' (default) | 's' | 'iso'
//                 value(row)  the raw value for local filter/sort/search (default row[key])
//                 render(row) cell HTML (escape it yourself with TK.esc); default formats by type
//                 align       'right' | 'center' (numbers default right); width: CSS width of the column
//                 hideOn      'phone': hidden under 700px; tip: header tooltip text
//   defaultSort '-createdAt,title' (same syntax as the sort param); used when the user has not sorted
//   pageSize    50; pageSizes [10, 25, 50, 100, 200]
//   search      placeholder text, or false for no search box (default 'Search')
//   chips       preset filters [{ id, label, filters?: [{ col, op, value }], sort?, group?, on?, count?(resp), tip? }]
//                 chips in one group are exclusive; on: active by default; count(resp) adds a number;
//                 a chip's sort replaces defaultSort while it is on. Every active user filter also
//                 shows as a removable chip, with "Clear all".
//   rowKey      a key or row => key (default 'id'): the local tiebreak and the row's data-key
//   rowAttrs    row => ' data-x="1"' (a raw attribute string) or { attr: value } (escaped)
//   onRowClick  (row, ev): rows get a pointer, Enter opens them; clicks on links, buttons and inputs are ignored
//   actions     row => HTML for a last cell; buttons with data-act="..." call onAction(act, row, btn, ev)
//   group       { key(row), isChild(row) }: children render indented under their parent; in local mode
//                 a child stays right after its parent under any sort (the server does this in SQL)
//   empty       text when there are no rows (default 'Nothing here yet.')
//   swr         server mode: paint the stored copy of the first page first (TK.api.swr)
//   onData      (resp) after each answer (server JSON, or the local result), e.g. for counts
//   compact     no toolbar, no pager and no filter buttons (previews); shows pageSize rows
//
// ── Returned handle ─────────────────────────────────────────────────────────
//
//   reload()                    refetch (server) or recompute (local), keeping page/sort/filters
//   setFilter(col, op, value)   replace col's filters with one (op null = remove them); back to page 1
//   clearFilters()              drop every user filter and the search, chips back to their defaults
//   setRows(rows)               local mode: new rows
//   setSort('-a,b'), setPage(n), state(), rows(), response()
//
// ── URL state ───────────────────────────────────────────────────────────────
//
// <id>.page, <id>.size, <id>.sort, <id>.q, <id>.chip and <id>.f.<col> (repeatable) live in the page's
// query string next to the page's own params, which are kept (history.replaceState). Defaults are
// omitted. NOTE: TK.qs.set() rebuilds the whole query string and would drop table state; a page with a
// table sets its own params with TKTable.qs.merge({ name: value | null }) instead.
//
// ── Constraints ─────────────────────────────────────────────────────────────
//
// Define-only at load (the pool pages' stub DOM runs this): the only top-level name is `var TKTable`,
// no timers, fetches or DOM access until create(). Rendering is innerHTML strings into regions found
// by id (<id>-root, -bar, -q (search box), -chips, -psort (phone sort/filter selects), -active, -err, -skel,
// -wrap, -head, -body, -empty, -pager, -status; the filter popover is <id>-pop on document.body) and
// clicks are delegated with closest(), so it also runs in the page tests' richStub. This is a
// String.raw template: no backticks and no dollar-brace in the script.

export const DATA_TABLE_CSS = /* css */ `
/* ── data table (TKTable) ── */
.tkt { min-width: 0; }
.tkt-bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); margin-bottom: var(--sp-2); }
.tkt-bar:empty { display: none; }
.tkt-search { flex: 1 1 14rem; max-width: 22rem; min-width: 0; }
.tkt-q { appearance: none; font: inherit; font-size: var(--fs-sm); width: 100%; min-width: 0; color: var(--fg); background: var(--page); border: 1px solid var(--line-strong); border-radius: var(--r-ctl); padding: 7px 10px; }
.tkt-presets.chips { margin: 0; }
.tkt-presets .chip { display: inline-flex; align-items: center; gap: 6px; }
.tkt-count { font-variant-numeric: tabular-nums; font-size: var(--fs-xs); color: var(--subtle); }
.chip.on .tkt-count { color: inherit; }
.tkt-psort-w { display: none; gap: var(--sp-2); flex-wrap: wrap; }
.tkt-psort, .tkt-jump input, .tkt-size select { font: inherit; font-size: var(--fs-sm); color: var(--fg); background: var(--page); border: 1px solid var(--line-strong); border-radius: var(--r-ctl); padding: 5px 8px; min-width: 0; }
.tkt-active { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: var(--sp-2); }
.tkt-active:empty { display: none; }
.tkt-fchip { display: inline-flex; align-items: center; max-width: 100%; border: 1px solid var(--accent); background: var(--accent-soft); color: var(--accent); border-radius: 999px; font-size: var(--fs-xs); }
.tkt-fchip > button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
.tkt-fchip .tkt-fedit { padding: 3px 4px 3px 10px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tkt-fchip .tkt-x { padding: 3px 8px 3px 4px; font-size: 1rem; line-height: 1; }
.tkt-fchip .tkt-x:hover { color: var(--fg); }
.tkt-clear { font: inherit; font-size: var(--fs-xs); background: none; border: 0; color: var(--muted); text-decoration: underline; text-underline-offset: 2px; cursor: pointer; padding: 3px 4px; }
.tkt-clear:hover { color: var(--fg); }
.tkt-err { margin-bottom: var(--sp-2); }
.tkt-wrap { transition: opacity .15s ease; }
.tkt-wrap.tkt-loading { opacity: .5; }
@media (prefers-reduced-motion: reduce) { .tkt-wrap { transition: none; } }
.tkt-table th { padding: 0; vertical-align: bottom; }
.tkt-th-in { display: flex; align-items: center; gap: 2px; padding: 4px 4px 4px 10px; min-height: 34px; }
.tkt-table th.num .tkt-th-in { justify-content: flex-end; }
.tkt-table th.tkt-center .tkt-th-in { justify-content: center; }
.tkt-table td.tkt-center { text-align: center; }
.tkt-lbl { padding: 4px 0; }
.tkt-sort { font: inherit; color: inherit; text-transform: inherit; letter-spacing: inherit; background: none; border: 0; padding: 4px 0; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; border-radius: 4px; }
.tkt-sort:hover { color: var(--fg); }
.tkt-arrow { display: inline-block; width: .9em; text-align: center; color: var(--accent); }
.tkt-sort:not(.on) .tkt-arrow { visibility: hidden; color: var(--subtle); }
.tkt-sort:not(.on):hover .tkt-arrow, .tkt-sort:not(.on):focus-visible .tkt-arrow { visibility: visible; }
.tkt-th.is-default .tkt-arrow { color: var(--subtle); }
.tkt-prio { font-size: .66rem; min-width: 1.35em; line-height: 1.35em; text-align: center; border-radius: 999px; background: var(--accent-soft); color: var(--accent); letter-spacing: 0; }
.tkt-fbtn { flex: none; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 0; border-radius: var(--r-ctl); background: none; color: var(--subtle); cursor: pointer; opacity: .7; }
.tkt-fbtn:hover, .tkt-fbtn:focus-visible { opacity: 1; color: var(--fg); background: var(--elev); }
.tkt-fbtn.on { opacity: 1; color: var(--accent); background: var(--accent-soft); }
.tkt-fbtn svg { width: 12px; height: 12px; }
.tkt-table tbody tr.tkt-click { cursor: pointer; }
.tkt-table tbody tr.tkt-parent > td { border-bottom-color: transparent; }
.tkt-table tbody tr.tkt-child > td { background: color-mix(in srgb, var(--elev) 45%, transparent); }
.tkt-table tbody tr.tkt-child > td:first-child { position: relative; padding-left: 30px; }
.tkt-table tbody tr.tkt-child > td:first-child::after { content: ""; position: absolute; left: 14px; top: 0; width: 9px; height: 18px; border-left: 1px solid var(--line-strong); border-bottom: 1px solid var(--line-strong); border-bottom-left-radius: 5px; }
.tkt-table td.tkt-acts, .tkt-table th.tkt-acts { width: 1%; white-space: nowrap; text-align: right; }
.tkt-table td.tkt-acts .btn { padding: 5px 10px; font-size: var(--fs-xs); }
.tkt-tag { display: inline-block; font-size: .7rem; line-height: 1.5; border: 1px solid var(--line-strong); border-radius: 4px; padding: 0 6px; margin: 1px 3px 1px 0; color: var(--muted); white-space: nowrap; }
.tkt-nil { color: var(--subtle); }
.tkt-when { white-space: nowrap; font-variant-numeric: tabular-nums; }
.tkt-empty { margin-top: var(--sp-2); }
.tkt-empty .tkt-clear { margin-left: 6px; }
.tkt-pager { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); margin-top: var(--sp-3); font-size: var(--fs-sm); color: var(--muted); }
.tkt-pager:empty { display: none; }
.tkt-range { font-variant-numeric: tabular-nums; margin-right: auto; }
.tkt-pages { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; }
.tkt-pg { font: inherit; font-variant-numeric: tabular-nums; min-width: 32px; height: 32px; padding: 0 8px; border-radius: var(--r-ctl); border: 1px solid transparent; background: none; color: var(--fg); cursor: pointer; }
.tkt-pg:hover:not(:disabled) { border-color: var(--line-strong); }
.tkt-pg.on { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); font-weight: 650; }
.tkt-pg:disabled { opacity: .35; cursor: default; }
.tkt-ell { min-width: 20px; text-align: center; color: var(--subtle); }
.tkt-jump, .tkt-size { display: inline-flex; align-items: center; gap: 6px; }
.tkt-jump input { width: 4.5em; }
.tkt-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.tkt-pop { position: fixed; z-index: 70; margin: 0; width: min(20rem, calc(100vw - 16px)); max-height: min(30rem, calc(100vh - 16px)); overflow: auto; background: var(--card); color: var(--fg); border: 1px solid var(--line-strong); border-radius: var(--r-tile); box-shadow: var(--shadow-float); padding: var(--sp-3); font-size: var(--fs-sm); display: grid; gap: var(--sp-2); }
.tkt-pop[hidden] { display: none; }
.tkt-pop-h { font-weight: 650; font-size: var(--fs-sm); }
.tkt-pop label.tkt-f { display: grid; gap: 3px; color: var(--muted); font-size: var(--fs-xs); font-weight: 600; }
.tkt-pop select, .tkt-pop input:not([type=checkbox]):not([type=radio]) { font: inherit; font-size: var(--fs-sm); color: var(--fg); background: var(--page); border: 1px solid var(--line-strong); border-radius: var(--r-ctl); padding: 6px 8px; width: 100%; min-width: 0; }
.tkt-two { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-2); }
.tkt-quick { display: flex; flex-wrap: wrap; gap: 4px; }
.tkt-quick .chip { font-size: var(--fs-xs); padding: 2px 9px; }
.tkt-opts { display: grid; gap: 1px; max-height: 15rem; overflow: auto; }
.tkt-opts label, .tkt-pop label.tkt-check { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 4px; cursor: pointer; color: var(--fg); font-weight: 500; }
.tkt-opts label:hover { background: var(--elev); }
.tkt-pop-acts { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--sp-2); padding-top: var(--sp-1); }
.tkt-pop-acts .btn { padding: 7px 12px; font-size: var(--fs-sm); }
.tkt-pop-acts .btn.ghost { margin-right: auto; }
@media (max-width: 699px) {
  .tkt-hide-phone { display: none !important; }
  .tkt-psort-w { display: inline-flex; }
  .tkt-search { max-width: none; flex-basis: 100%; }
  .tkt-table tbody tr.tkt-child { margin-left: 18px; }
  .tkt-table tbody tr.tkt-child > td { background: none; }
  .tkt-table tbody tr.tkt-child > td:first-child { padding-left: 0; }
  .tkt-table tbody tr.tkt-child > td:first-child::after { display: none; }
  .tkt-table tbody tr.tkt-parent > td { border-bottom-color: transparent; }
  .tkt-table td.tkt-acts { width: auto; justify-content: flex-end; flex-wrap: wrap; }
  .tkt-table td.tkt-acts::before { content: none; }
  .tkt-table tbody tr.tkt-click:active { background: var(--elev); }
  .tkt-range { flex-basis: 100%; }
  .tkt-pop { left: 0 !important; right: 0; top: auto !important; bottom: 0; width: 100%; max-height: 85vh; max-height: 85dvh; border-radius: var(--r-card) var(--r-card) 0 0; padding-bottom: calc(var(--sp-3) + env(safe-area-inset-bottom)); }
}
`

export const DATA_TABLE_JS = String.raw`
var TKTable = (() => {
  let autoId = 0;
  const SIZES = [10, 25, 50, 100, 200];
  const FUNNEL = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M1.5 2.5h13l-5 6v5l-3-1.5V8.5z" fill="currentColor"/></svg>';

  // ── small helpers (TK is looked up lazily: nothing runs at load) ──
  const hasTK = () => typeof TK !== 'undefined' && TK;
  function esc(s) {
    if (hasTK()) return TK.esc(s);
    return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const tip = (t) => (hasTK() ? TK.tip(t) : '');
  const fmtNum = (n) => { const x = Number(n); if (!isFinite(x)) return String(n); try { return x.toLocaleString(); } catch (e) { return String(x); } };
  const fold = (s) => String(s).replace(/[A-Z]/g, (c) => c.toLowerCase());
  const pad = (n) => (n < 10 ? '0' : '') + n;
  const ymd = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const dayStart = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '')); return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : null; };
  const nextDay = (s) => { const t = dayStart(s); if (t == null) return null; const d = new Date(t); d.setDate(d.getDate() + 1); return d.getTime(); };
  const isMidnight = (ms) => { const d = new Date(ms); return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0; };
  const fmtDay = (ms) => { try { return new Date(ms).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }); } catch (e) { return ymd(ms); } };
  const fmtWhen = (ms) => { try { return new Date(ms).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return String(ms); } };
  const numOrNull = (v) => { const t = String(v == null ? '' : v).trim(); if (t === '' || !/^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null; const n = Number(t); return isFinite(n) ? n : null; };
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  // ── sort strings ──
  function parseSort(s, cols) {
    const out = [];
    if (Array.isArray(s)) { for (const x of s) if (x && cols[x.col] && !out.some((o) => o.col === x.col)) out.push({ col: x.col, dir: x.dir === 'desc' ? 'desc' : 'asc' }); return out; }
    for (const part of String(s || '').split(',')) {
      const t = part.trim(); if (!t) continue;
      const col = t.replace(/^[-+]/, '');
      if (!has(cols, col) || out.some((o) => o.col === col)) continue;
      out.push({ col, dir: t[0] === '-' ? 'desc' : 'asc' });
    }
    return out;
  }
  const sortStr = (list) => list.map((s) => (s.dir === 'desc' ? '-' : '') + s.col).join(',');

  // ── URL state, keeping the page's own params ──
  function readUrl() {
    try { if (typeof location === 'undefined' || typeof URLSearchParams === 'undefined') return null; return new URLSearchParams(location.search || ''); } catch (e) { return null; }
  }
  function writeUrl(mutate) {
    try {
      if (typeof location === 'undefined' || typeof history === 'undefined' || typeof URLSearchParams === 'undefined') return;
      const p = new URLSearchParams(location.search || '');
      mutate(p);
      const s = p.toString();
      history.replaceState(history.state === undefined ? null : history.state, '', (location.pathname || '') + (s ? '?' + s : '') + (location.hash || ''));
    } catch (e) {}
  }
  const qs = {
    // Sets (or with null/'' deletes) the given params and keeps every other one, table state included.
    merge(obj) { writeUrl((p) => { for (const k of Object.keys(obj || {})) { const v = obj[k]; if (v === undefined || v === null || v === '') p.delete(k); else p.set(k, String(v)); } }); },
    get(name) { const p = readUrl(); return p ? p.get(name) : null; },
  };

  // ── columns ──
  function normCols(list) {
    const cols = {}, order = [];
    for (const c0 of list || []) {
      if (!c0 || !c0.key) continue;
      const c = Object.assign({}, c0);
      c.type = c.type || 'text';
      c.label = c.label == null ? c.key : c.label;
      c.sortable = c.sortable !== false;
      c.filterable = c.filterable !== false;
      c.searchable = c.searchable === undefined ? c.type === 'text' : !!c.searchable;
      c.opts = (c.options || []).map((o) => (o && typeof o === 'object' ? { value: String(o.value), label: o.label == null ? String(o.value) : String(o.label) } : { value: String(o), label: String(o) }));
      cols[c.key] = c; order.push(c);
    }
    return { cols, order };
  }
  const optLabel = (c, v) => { for (const o of c.opts) if (o.value === String(v)) return o.label; return String(v); };
  function rawOf(c, row) { const v = c.value ? c.value(row) : row == null ? null : row[c.key]; return v === undefined ? null : v; }
  function toMs(v, storage) {
    if (v == null || v === '') return null;
    if (storage === 'iso') { const t = Date.parse(String(v)); return isNaN(t) ? null : t; }
    const n = Number(v); if (!isFinite(n)) return null;
    return storage === 's' ? n * 1000 : n;
  }
  const multiList = (v) => (v == null ? null : Array.isArray(v) ? v.map(String) : String(v).split(',').filter(Boolean));

  // ── local engine: the semantics of runLocalTable in src/lib/table-query.ts ──
  function cmpRaw(a, b) {
    const an = typeof a === 'number', bn = typeof b === 'number';
    if (an && bn) return a - b;
    if (an !== bn) return an ? -1 : 1;
    const as = String(a), bs = String(b);
    return as < bs ? -1 : as > bs ? 1 : 0;
  }
  function compile(c, f) {
    const op = f.op, v = f.value == null ? '' : String(f.value);
    if (op === 'empty' || op === 'nempty') return { kind: 'empty', neg: op === 'nempty' };
    const range = (conv) => { const i = v.indexOf('..'); if (i < 0) return null; const lo = conv(v.slice(0, i)), hi = conv(v.slice(i + 2)); return lo == null && hi == null ? null : { kind: 'range', lo, hi }; };
    if (c.type === 'number' || c.type === 'datetime') {
      if (op === 'between') return range(numOrNull);
      const n = numOrNull(v); return n == null ? null : { kind: 'cmp', op, v: n };
    }
    if (c.type === 'date') {
      const d = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(String(x).trim()) ? String(x).trim() : null);
      if (op === 'between') return range(d);
      const x = d(v); return x == null ? null : { kind: 'cmp', op: op === 'before' ? 'lt' : op === 'after' ? 'gt' : 'eq', v: x };
    }
    if (c.type === 'enum') {
      const list = []; for (const s of v.split('|')) { const t = s.trim(); if (t && list.indexOf(t) < 0) list.push(t); }
      return list.length ? { kind: 'in', op, list } : null;
    }
    if (c.type === 'bool') return { kind: 'bool', v: v === '1' || v === 'true' ? 1 : 0 };
    return v ? { kind: 'text', op, v } : null;
  }
  function matches(c, k, row) {
    const raw = rawOf(c, row);
    let v = raw;
    if (c.type === 'datetime') v = toMs(raw, c.storage);
    else if (c.type === 'number') v = raw == null || raw === '' ? null : Number(raw);
    if (k.kind === 'empty') {
      const e = v == null || ((c.type === 'text' || c.type === 'enum') && v === '') || (c.multi && Array.isArray(v) && !v.length);
      return k.neg ? !e : e;
    }
    if (k.kind === 'cmp') {
      if (v == null) return k.op === 'ne';
      const d = cmpRaw(v, k.v);
      return k.op === 'eq' ? d === 0 : k.op === 'ne' ? d !== 0 : k.op === 'gt' ? d > 0 : k.op === 'gte' ? d >= 0 : k.op === 'lt' ? d < 0 : k.op === 'lte' ? d <= 0 : false;
    }
    if (k.kind === 'range') return v != null && (k.lo == null || cmpRaw(v, k.lo) >= 0) && (k.hi == null || cmpRaw(v, k.hi) <= 0);
    if (k.kind === 'text') {
      if (v == null) return k.op === 'ne' || k.op === 'nhas';
      const s = fold(v), t = fold(k.v);
      return k.op === 'eq' ? s === t : k.op === 'ne' ? s !== t : k.op === 'has' ? s.indexOf(t) >= 0 : k.op === 'nhas' ? s.indexOf(t) < 0 : k.op === 'sw' ? s.indexOf(t) === 0 : k.op === 'ew' ? s.length >= t.length && s.slice(s.length - t.length) === t : false;
    }
    if (k.kind === 'in') {
      if (c.multi) {
        const list = multiList(raw);
        if (list == null) return k.op === 'nin';
        if (k.op === 'all') return k.list.every((x) => list.indexOf(x) >= 0);
        const any = k.list.some((x) => list.indexOf(x) >= 0);
        return k.op === 'nin' ? !any : any;
      }
      if (v == null) return k.op === 'nin';
      const hit = k.list.indexOf(String(v)) >= 0;
      return k.op === 'nin' ? !hit : hit;
    }
    if (k.kind === 'bool') { const t = !(v == null || v === 0 || v === false || v === '0' || v === ''); return k.v ? t : !t; }
    return true;
  }
  function sortVal(c, row) {
    const v = rawOf(c, row);
    if (v == null) return null;
    if (c.type === 'text') return fold(v);
    if (c.type === 'number') return v === '' ? null : Number(v);
    if (c.type === 'bool') return v === true ? 1 : v === false ? 0 : v;
    return v;
  }
  // opts: { sort: [{col,dir}], filters: [{col,op,value}], q, page, size, rowKey, group }
  function runLocal(rows, colsList, opts) {
    const n = normCols(colsList), cols = n.cols;
    opts = opts || {};
    const sort = (opts.sort || []).filter((s) => cols[s.col]);
    const comp = [];
    for (const f of opts.filters || []) { const c = cols[f.col]; if (!c) continue; const k = compile(c, f); if (k) comp.push([c, k]); }
    const q = String(opts.q || '').trim();
    const searchCols = n.order.filter((c) => c.searchable);
    const rk = opts.rowKey == null ? 'id' : opts.rowKey;
    const pkOf = (row, i) => { const v = typeof rk === 'function' ? rk(row) : row == null ? null : row[rk]; return v == null ? i : v; };
    const items = [];
    (rows || []).forEach((row, i) => {
      for (const ck of comp) if (!matches(ck[0], ck[1], row)) return;
      if (q && searchCols.length) {
        const t = fold(q);
        let hit = false;
        for (const c of searchCols) { const v = rawOf(c, row); if (v != null && fold(Array.isArray(v) ? ',' + v.join(',') + ',' : v).indexOf(t) >= 0) { hit = true; break; } }
        if (!hit) return;
      }
      const g = opts.group;
      items.push({ row, pk: pkOf(row, i), ic: g && g.isChild && g.isChild(row) ? 1 : 0, vals: sort.map((s) => sortVal(cols[s.col], row)), lead: null });
    });
    const g = opts.group;
    if (g && (g.key || g.isChild)) {
      const groups = new Map();
      for (const it of items) { const k0 = g.key ? g.key(it.row) : null; const k = k0 == null ? it.pk : k0; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it); }
      groups.forEach((list) => { let lead = list[0]; for (const it of list) if (it.ic < lead.ic || (it.ic === lead.ic && cmpRaw(it.pk, lead.pk) < 0)) lead = it; for (const it of list) it.lead = lead; });
    }
    const dir0 = sort[0] && sort[0].dir === 'desc' ? -1 : 1;
    items.sort((a, b) => {
      const la = a.lead || a, lb = b.lead || b;
      for (let i = 0; i < sort.length; i++) {
        const x = la.vals[i], y = lb.vals[i];
        if (x == null || y == null) { if (x == null && y == null) continue; return x == null ? 1 : -1; }
        const c = cmpRaw(x, y);
        if (c) return sort[i].dir === 'desc' ? -c : c;
      }
      const lp = cmpRaw(la.pk, lb.pk);
      if (lp) return lp * dir0;
      if (a.ic !== b.ic) return a.ic - b.ic;
      return cmpRaw(a.pk, b.pk);
    });
    const size = Math.max(1, Number(opts.size) || 50);
    const total = items.length;
    const pageCount = Math.max(1, Math.ceil(total / size));
    const page = Math.min(Math.max(1, Math.floor(Number(opts.page) || 1)), pageCount);
    const slice = items.slice((page - 1) * size, page * size).map((it) => it.row);
    return { rows: slice, total, page, size, pageCount, sort, filters: (opts.filters || []).slice(), q };
  }

  // ── filter text for chips ──
  const TEXT_OPS = [['has', 'contains'], ['eq', 'is'], ['ne', 'is not'], ['nhas', 'does not contain'], ['sw', 'starts with'], ['ew', 'ends with'], ['empty', 'is empty'], ['nempty', 'is not empty']];
  const NUM_OPS = [['between', 'between'], ['eq', '='], ['ne', '≠'], ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['empty', 'is empty'], ['nempty', 'is not empty']];
  const DAY_OPS = [['on', 'on'], ['before', 'before'], ['after', 'after'], ['between', 'between'], ['empty', 'is empty'], ['nempty', 'is not empty']];
  const opName = (list, op) => { for (const x of list) if (x[0] === op) return x[1]; return op; };
  function whenText(ms, end) { if (end && isMidnight(ms + 1)) return fmtDay(ms); return isMidnight(ms) ? fmtDay(ms) : fmtWhen(ms); }
  function filterText(c, f) {
    const v = f.value == null ? '' : String(f.value);
    const L = c.label;
    if (f.op === 'empty' || f.op === 'nempty') return L + ' ' + (f.op === 'empty' ? 'is empty' : 'is not empty');
    const parts = v.split('..');
    if (c.type === 'datetime') {
      const n = numOrNull(v);
      if (f.op === 'between') {
        const a = numOrNull(parts[0]), b = numOrNull(parts[1]);
        if (a != null && b != null && isMidnight(a) && isMidnight(b + 1) && ymd(a) === ymd(b)) return L + ' on ' + fmtDay(a);
        if (a != null && b != null) return L + ' ' + whenText(a) + ' – ' + whenText(b, true);
        return a != null ? L + ' since ' + whenText(a) : L + ' until ' + whenText(b, true);
      }
      if (n == null) return L + ' ' + f.op + ' ' + v;
      const word = { eq: 'at', ne: 'not at', gt: 'after', gte: 'since', lt: 'before', lte: 'until' }[f.op] || f.op;
      return L + ' ' + word + ' ' + (f.op === 'lte' ? whenText(n, true) : whenText(n));
    }
    if (c.type === 'date') {
      if (f.op === 'between') return parts[0] && parts[1] ? L + ' ' + parts[0] + ' – ' + parts[1] : parts[0] ? L + ' from ' + parts[0] : L + ' until ' + (parts[1] || '');
      return L + ' ' + opName(DAY_OPS, f.op === 'eq' ? 'on' : f.op) + ' ' + v;
    }
    if (c.type === 'number') {
      if (f.op === 'between') return parts[0] !== '' && parts[1] !== '' && parts[1] != null ? L + ' ' + fmtNum(parts[0]) + ' – ' + fmtNum(parts[1]) : parts[0] !== '' ? L + ' ≥ ' + fmtNum(parts[0]) : L + ' ≤ ' + fmtNum(parts[1]);
      return L + ' ' + opName(NUM_OPS, f.op) + ' ' + fmtNum(v);
    }
    if (c.type === 'enum') {
      const names = v.split('|').filter(Boolean).map((x) => optLabel(c, x)).join(', ');
      const word = f.op === 'nin' ? (c.multi ? 'has none of' : 'is not') : f.op === 'all' ? 'has all of' : c.multi ? 'has' : 'is';
      return L + ' ' + word + ' ' + names;
    }
    if (c.type === 'bool') return L + ': ' + (v === '1' || v === 'true' ? 'Yes' : 'No');
    return L + ' ' + opName(TEXT_OPS, f.op) + ' "' + v + '"';
  }

  // ── default cells ──
  function cellHtml(c, row) {
    if (c.render) { const h = c.render(row); return h == null ? '' : String(h); }
    const v = rawOf(c, row);
    if (v == null || v === '') return '<span class="tkt-nil">–</span>';
    if (c.type === 'number') return esc(fmtNum(v));
    if (c.type === 'datetime') { const ms = toMs(v, c.storage); return ms == null ? esc(v) : '<span class="tkt-when">' + esc(fmtWhen(ms)) + '</span>'; }
    if (c.type === 'bool') return v && v !== '0' ? 'Yes' : 'No';
    if (c.type === 'enum' && c.multi) return (multiList(v) || []).map((x) => '<span class="tkt-tag">' + esc(optLabel(c, x)) + '</span>').join('');
    if (c.type === 'enum') return esc(optLabel(c, v));
    return esc(v);
  }
  function attrsHtml(a) {
    if (!a) return '';
    if (typeof a === 'string') return ' ' + a.trim();
    let s = '';
    for (const k of Object.keys(a)) { if (!/^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/.test(k) || a[k] == null || a[k] === false) continue; s += ' ' + k + '="' + esc(a[k] === true ? '' : a[k]) + '"'; }
    return s;
  }

  // ── pager numbers: 1 … 4 5 6 … 20 ──
  function pageList(page, count) {
    if (count <= 7) { const a = []; for (let i = 1; i <= count; i++) a.push(i); return a; }
    const out = [1];
    const lo = Math.max(2, Math.min(page - 1, count - 4)), hi = Math.min(count - 1, Math.max(page + 1, 5));
    if (lo > 2) out.push(0);
    for (let i = lo; i <= hi; i++) out.push(i);
    if (hi < count - 1) out.push(0);
    out.push(count);
    return out;
  }

  function create(el, cfg) {
    cfg = cfg || {};
    const id = String(cfg.id || 'tkt' + (++autoId));
    const compact = !!cfg.compact;
    const useUrl = cfg.urlState === false ? false : cfg.urlState === true ? true : !!cfg.id && !compact;
    const P = id + '.';
    const N = normCols(cfg.columns), cols = N.cols, order = N.order;
    const local = !!(cfg.source && has(cfg.source, 'rows'));
    const sizes = Array.isArray(cfg.pageSizes) && cfg.pageSizes.length ? cfg.pageSizes.map(Number).filter((x) => x > 0) : SIZES;
    const defSize = Number(cfg.pageSize) > 0 ? Number(cfg.pageSize) : 50;
    const chips = (cfg.chips || []).filter((c) => c && c.id != null).map((c) => Object.assign({}, c, { id: String(c.id) }));
    const chipById = (cid) => { for (const c of chips) if (c.id === cid) return c; return null; };
    const defaultChips = chips.filter((c) => c.on).map((c) => c.id);
    const searchOn = !compact && cfg.search !== false;
    const group = cfg.group || null;

    const st = { page: 1, size: defSize, sort: [], filters: [], q: '', chips: defaultChips.slice() };
    if (useUrl) {
      const p = readUrl();
      if (p) {
        const pg = Number(p.get(P + 'page')); if (pg >= 1) st.page = Math.floor(pg);
        const sz = Number(p.get(P + 'size')); if (sz > 0 && sizes.indexOf(sz) >= 0) st.size = sz;
        if (p.has(P + 'sort')) st.sort = parseSort(p.get(P + 'sort'), cols).filter((s) => cols[s.col].sortable);
        if (p.has(P + 'q') && searchOn) st.q = String(p.get(P + 'q') || '');
        if (p.has(P + 'chip')) { const raw = String(p.get(P + 'chip') || ''); st.chips = raw === '-' ? [] : raw.split(',').filter((x) => chipById(x)); }
        p.forEach((v, k) => {
          if (k.indexOf(P + 'f.') !== 0) return;
          const col = k.slice(P.length + 2), i = String(v).indexOf(':');
          if (!cols[col] || !cols[col].filterable) return;
          st.filters.push({ col, op: i < 0 ? String(v) : String(v).slice(0, i), value: i < 0 ? '' : String(v).slice(i + 1) });
        });
      }
    }

    let seq = 0, ctrl = null, loaded = false, loading = false, lastResp = null, rowsNow = [], qTimer = null, err = '', pop = null, popState = null, popOff = null;

    // ── derived state ──
    const activeChips = () => st.chips.map(chipById).filter(Boolean);
    function effFilters() { const out = []; for (const c of activeChips()) for (const f of c.filters || []) out.push({ col: f.col, op: f.op, value: f.value == null ? '' : String(f.value) }); return out.concat(st.filters); }
    function baseSort() { for (const c of activeChips()) if (c.sort) return parseSort(c.sort, cols); return parseSort(cfg.defaultSort || '', cols); }
    const effSort = () => (st.sort.length ? st.sort : baseSort());
    const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

    function saveUrl() {
      if (!useUrl) return;
      writeUrl((p) => {
        const drop = []; p.forEach((v, k) => { if (k.indexOf(P) === 0) drop.push(k); });
        for (const k of drop) p.delete(k);
        if (st.page > 1) p.set(P + 'page', String(st.page));
        if (st.size !== defSize) p.set(P + 'size', String(st.size));
        if (st.sort.length) p.set(P + 'sort', sortStr(st.sort));
        if (st.q) p.set(P + 'q', st.q);
        if (!sameList(st.chips.slice().sort(), defaultChips.slice().sort())) p.set(P + 'chip', st.chips.length ? st.chips.join(',') : '-');
        for (const f of st.filters) p.append(P + 'f.' + f.col, f.op + (f.value !== '' ? ':' + f.value : ''));
      });
    }

    function requestUrl() {
      const src = cfg.source || {};
      const parts = [];
      const add = (k, v) => parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
      add('page', st.page);
      add('size', st.size);
      const s = effSort(); if (s.length) add('sort', sortStr(s));
      if (st.q) add('q', st.q);
      for (const f of effFilters()) add('f.' + f.col, f.op + (f.value !== '' ? ':' + f.value : ''));
      const extra = typeof src.params === 'function' ? src.params() : src.params;
      if (extra) for (const k of Object.keys(extra)) { const v = extra[k]; if (v === undefined || v === null || v === '') continue; if (Array.isArray(v)) { for (const x of v) add(k, x); } else add(k, v); }
      const url = String(src.url || '');
      return url + (url.indexOf('?') >= 0 ? '&' : '?') + parts.join('&');
    }

    // ── regions ──
    function part(name) {
      const pid = id + '-' + name;
      let n = null;
      try { n = document.getElementById(pid); } catch (e) {}
      if (!n && el && typeof el.querySelector === 'function') { try { n = el.querySelector('#' + pid); } catch (e) {} }
      return n;
    }
    function frame() {
      let h = '<div class="tkt' + (compact ? ' compact' : '') + '" id="' + id + '-root">';
      if (!compact) {
        h += '<div class="tkt-bar" id="' + id + '-bar">';
        if (searchOn) h += '<div class="tkt-search"><input type="search" class="tkt-q" id="' + id + '-q" data-tkt="q" autocomplete="off" placeholder="' + esc(typeof cfg.search === 'string' ? cfg.search : 'Search') + '" aria-label="' + esc(typeof cfg.search === 'string' ? cfg.search : 'Search') + '" value="' + esc(st.q) + '"></div>';
        if (chips.length) h += '<div class="chips tkt-presets" id="' + id + '-chips" role="group" aria-label="Presets"></div>';
        h += '<span class="tkt-psort-w" id="' + id + '-psort"></span>';
        h += '</div><div class="tkt-active" id="' + id + '-active"></div>';
      }
      h += '<div class="tkt-err" id="' + id + '-err" hidden></div>';
      h += '<div class="tkt-skel" id="' + id + '-skel"></div>';
      h += '<div class="tk-table-wrap tkt-wrap" id="' + id + '-wrap" hidden><table class="tk-table tkt-table"><thead id="' + id + '-head"></thead><tbody id="' + id + '-body"></tbody></table></div>';
      h += '<div class="empty tkt-empty" id="' + id + '-empty" hidden></div>';
      if (!compact) h += '<div class="tkt-pager" id="' + id + '-pager"></div>';
      h += '<span class="tkt-sr" id="' + id + '-status" role="status" aria-live="polite"></span></div>';
      return h;
    }

    function headHtml() {
      const s = effSort(), dflt = !st.sort.length;
      let h = '<tr>';
      for (const c of order) {
        const si = s.findIndex((x) => x.col === c.key), on = si >= 0 ? s[si] : null;
        const cls = ['tkt-th'];
        if (c.align === 'right' || (!c.align && c.type === 'number')) cls.push('num');
        if (c.align === 'center') cls.push('tkt-center');
        if (c.hideOn === 'phone') cls.push('tkt-hide-phone');
        if (on && dflt) cls.push('is-default');
        const aria = c.sortable ? ' aria-sort="' + (on ? (on.dir === 'asc' ? 'ascending' : 'descending') : 'none') + '"' : '';
        h += '<th scope="col" class="' + cls.join(' ') + '"' + aria + (c.width ? ' style="width:' + esc(c.width) + '"' : '') + '><div class="tkt-th-in">';
        if (c.sortable) {
          const arrow = on ? (on.dir === 'asc' ? '↑' : '↓') : '↕';
          h += '<button type="button" class="tkt-sort' + (on ? ' on' : '') + '" data-tkt="sort" data-col="' + esc(c.key) + '"' + tip(c.tip) + '>' + esc(c.label) + '<span class="tkt-arrow" aria-hidden="true">' + arrow + '</span>' + (on && s.length > 1 ? '<span class="tkt-prio" aria-label="sort priority ' + (si + 1) + '">' + (si + 1) + '</span>' : '') + '</button>';
        } else h += '<span class="tkt-lbl"' + tip(c.tip) + '>' + esc(c.label) + '</span>';
        if (c.filterable && !compact) {
          const act = st.filters.some((f) => f.col === c.key);
          h += '<button type="button" class="tkt-fbtn' + (act ? ' on' : '') + '" data-tkt="filter" data-col="' + esc(c.key) + '" aria-haspopup="dialog" aria-label="Filter ' + esc(c.label) + '">' + FUNNEL + '</button>';
        }
        h += '</div></th>';
      }
      if (cfg.actions) h += '<th class="tkt-acts"><span class="tkt-sr">Actions</span></th>';
      return h + '</tr>';
    }

    function bodyHtml(rows) {
      let h = '';
      const rk = cfg.rowKey == null ? 'id' : cfg.rowKey;
      rows.forEach((row, i) => {
        const cls = [];
        const child = !!(group && group.isChild && group.isChild(row));
        const next = rows[i + 1];
        if (child) cls.push('tkt-child');
        else if (group && group.isChild && next && group.isChild(next)) cls.push('tkt-parent');
        if (cfg.onRowClick) cls.push('tkt-click');
        const key = typeof rk === 'function' ? rk(row) : row == null ? null : row[rk];
        h += '<tr data-tkt-row="' + i + '"' + (key != null ? ' data-key="' + esc(key) + '"' : '') + (cls.length ? ' class="' + cls.join(' ') + '"' : '') + (cfg.onRowClick ? ' tabindex="0"' : '') + attrsHtml(cfg.rowAttrs ? cfg.rowAttrs(row) : null) + '>';
        for (const c of order) {
          const tc = [];
          if (c.align === 'right' || (!c.align && c.type === 'number')) tc.push('num');
          if (c.align === 'center') tc.push('tkt-center');
          if (c.hideOn === 'phone') tc.push('tkt-hide-phone');
          h += '<td data-label="' + esc(c.label) + '"' + (tc.length ? ' class="' + tc.join(' ') + '"' : '') + '>' + cellHtml(c, row) + '</td>';
        }
        if (cfg.actions) h += '<td class="tkt-acts" data-label="">' + (cfg.actions(row) || '') + '</td>';
        h += '</tr>';
      });
      return h;
    }

    function chipsHtml() {
      let h = '';
      for (const c of chips) {
        const on = st.chips.indexOf(c.id) >= 0;
        let n = null; if (typeof c.count === 'function' && lastResp) { try { n = c.count(lastResp); } catch (e) { n = null; } }
        h += '<button type="button" class="chip' + (on ? ' on' : '') + '" data-tkt="chip" data-chip="' + esc(c.id) + '" aria-pressed="' + on + '"' + tip(c.tip) + '>' + esc(c.label) + (n != null && n !== '' ? '<span class="tkt-count">' + esc(fmtNum(n)) + '</span>' : '') + '</button>';
      }
      return h;
    }
    function activeHtml() {
      let h = '';
      st.filters.forEach((f, i) => {
        const c = cols[f.col]; if (!c) return;
        const text = filterText(c, f);
        h += '<span class="tkt-fchip"><button type="button" class="tkt-fedit" data-tkt="editf" data-col="' + esc(f.col) + '" aria-label="Edit filter: ' + esc(text) + '">' + esc(text) + '</button><button type="button" class="tkt-x" data-tkt="unfilter" data-i="' + i + '" aria-label="Remove filter: ' + esc(text) + '">×</button></span>';
      });
      if (st.filters.length || st.q || !sameList(st.chips.slice().sort(), defaultChips.slice().sort())) h += '<button type="button" class="tkt-clear" data-tkt="clear">Clear all</button>';
      return h;
    }
    function psortHtml() {
      const s = effSort()[0], cur = s && st.sort.length ? s.col + ':' + s.dir : '';
      let h = '<select class="tkt-psort" data-tkt="psort" aria-label="Sort by"><option value=""' + (cur ? '' : ' selected') + '>Default order</option>';
      for (const c of order) {
        if (!c.sortable) continue;
        for (const d of ['asc', 'desc']) h += '<option value="' + esc(c.key + ':' + d) + '"' + (cur === c.key + ':' + d ? ' selected' : '') + '>' + esc(c.label) + (d === 'asc' ? ' ↑' : ' ↓') + '</option>';
      }
      h += '</select>';
      // Under 700px the header (and its filter buttons) is hidden: filters open from here.
      if (!compact && order.some((c) => c.filterable)) {
        h += '<select class="tkt-psort" data-tkt="pfilter" aria-label="Filter by column"><option value="" selected>Filter…</option>';
        for (const c of order) if (c.filterable) h += '<option value="' + esc(c.key) + '">' + esc(c.label) + '</option>';
        h += '</select>';
      }
      return h;
    }
    function pagerHtml(r) {
      if (!r || !r.total) return '';
      const first = (r.page - 1) * r.size + 1, last = Math.min(r.total, r.page * r.size);
      let h = '<span class="tkt-range">' + fmtNum(first) + '–' + fmtNum(last) + ' of ' + fmtNum(r.total) + '</span>';
      if (r.pageCount > 1) {
        const btn = (pg, label, aria, dis, on) => '<button type="button" class="tkt-pg' + (on ? ' on' : '') + '" data-tkt="page" data-page="' + pg + '" aria-label="' + aria + '"' + (on ? ' aria-current="page"' : '') + (dis ? ' disabled' : '') + '>' + label + '</button>';
        h += '<nav class="tkt-pages" aria-label="Pages">';
        h += btn(1, '«', 'First page', r.page <= 1) + btn(r.page - 1, '‹', 'Previous page', r.page <= 1);
        for (const n of pageList(r.page, r.pageCount)) h += n ? btn(n, fmtNum(n), 'Page ' + n, false, n === r.page) : '<span class="tkt-ell" aria-hidden="true">…</span>';
        h += btn(r.page + 1, '›', 'Next page', r.page >= r.pageCount) + btn(r.pageCount, '»', 'Last page', r.page >= r.pageCount);
        h += '</nav><label class="tkt-jump">Page <input type="number" inputmode="numeric" min="1" max="' + r.pageCount + '" value="' + r.page + '" data-tkt="jump" aria-label="Go to page"></label>';
      }
      h += '<label class="tkt-size">Rows <select data-tkt="size" aria-label="Rows per page">';
      const opts = sizes.indexOf(st.size) >= 0 ? sizes : sizes.concat([st.size]).sort((a, b) => a - b);
      for (const n of opts) h += '<option value="' + n + '"' + (n === st.size ? ' selected' : '') + '>' + n + '</option>';
      return h + '</select></label>';
    }

    function setHtml(name, html) { const n = part(name); if (n) n.innerHTML = html; return n; }
    function show(name, on) { const n = part(name); if (n) n.hidden = !on; return n; }
    function paintChrome() {
      if (compact) return;
      if (chips.length) setHtml('chips', chipsHtml());
      setHtml('active', activeHtml());
      setHtml('psort', psortHtml());
    }
    function paintLoading() {
      const w = part('wrap');
      if (w) { w.className = 'tk-table-wrap tkt-wrap' + (loading && loaded ? ' tkt-loading' : ''); if (typeof w.setAttribute === 'function') w.setAttribute('aria-busy', loading ? 'true' : 'false'); }
      if (!loaded) {
        setHtml('skel', loading && hasTK() && TK.skel ? TK.skel(Math.min(st.size, 6), 'row') : '');
        if (loading) setHtml('status', 'Loading');
      }
    }
    function paint(r) {
      lastResp = r;
      rowsNow = (r && Array.isArray(r.rows)) ? r.rows : [];
      setHtml('skel', '');
      setHtml('head', headHtml());
      setHtml('body', bodyHtml(rowsNow));
      const any = rowsNow.length > 0;
      // The header stays (its filter buttons are the way out of an over-filtered empty list).
      show('wrap', any || effFilters().length > 0 || !!st.q);
      const em = show('empty', !any);
      if (em && !any) {
        const filtered = st.filters.length > 0 || !!st.q;
        em.innerHTML = esc(filtered ? 'No rows match these filters.' : (cfg.empty || 'Nothing here yet.')) + (filtered ? '<button type="button" class="tkt-clear" data-tkt="clear">Clear filters</button>' : '');
      }
      if (!compact) setHtml('pager', pagerHtml(r));
      const total = r && typeof r.total === 'number' ? r.total : rowsNow.length;
      setHtml('status', total ? fmtNum((r.page - 1) * r.size + 1) + '–' + fmtNum(Math.min(total, r.page * r.size)) + ' of ' + fmtNum(total) + ' rows' : 'No rows');
      paintChrome();
      paintLoading();
    }
    function paintErr(msg) {
      err = msg || '';
      const n = show('err', !!err);
      if (n) n.innerHTML = err ? '<div class="err-state" role="alert"><span class="grow">' + esc(err) + '</span><button type="button" class="btn" data-tkt="retry">Retry</button></div>' : '';
    }

    // ── loading ──
    async function load() {
      if (local) {
        const src = cfg.source.rows;
        let all = typeof src === 'function' ? src() : src;
        if (all && typeof all.then === 'function') { loading = true; paintLoading(); all = await all; loading = false; }
        const r = runLocal(Array.isArray(all) ? all : [], cfg.columns, { sort: effSort(), filters: effFilters(), q: st.q, page: st.page, size: st.size, rowKey: cfg.rowKey, group });
        st.page = r.page;
        loaded = true;
        paintErr('');
        paint(r);
        if (cfg.onData) { try { cfg.onData(r); } catch (e) {} }
        return r;
      }
      const my = ++seq;
      if (ctrl) { try { ctrl.abort(); } catch (e) {} }
      ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const opts = ctrl ? { signal: ctrl.signal } : undefined;
      loading = true;
      paintLoading();
      const url = requestUrl();
      const handle = (res) => {
        if (my !== seq || !res || res.aborted) return;
        if (!res.stale) loading = false;
        if (!res.ok || !res.data || !Array.isArray(res.data.rows)) {
          paintErr(hasTK() && TK.errText ? TK.errText(res, 'Could not load this list.') : 'Could not load this list.');
          if (!loaded) setHtml('skel', '');
          paintLoading();
          return;
        }
        const d = res.data;
        if (typeof d.page === 'number' && d.page >= 1) st.page = d.page;
        loaded = true;
        paintErr('');
        paint(Object.assign({}, d, { page: st.page, size: Number(d.size) || st.size, total: Number(d.total) || 0, pageCount: Number(d.pageCount) || 1 }));
        if (!res.stale && cfg.onData) { try { cfg.onData(d); } catch (e) {} }
      };
      if (!hasTK()) return;
      if (cfg.swr && !loaded && TK.api.swr) await TK.api.swr(url, handle, opts);
      else handle(await TK.api.get(url, opts));
    }
    function changed(resetPage) { if (resetPage) st.page = 1; saveUrl(); paintChrome(); return load(); }

    // ── sort ──
    function cycleSort(col, multi) {
      const c = cols[col]; if (!c || !c.sortable) return;
      const base = st.sort.length ? st.sort : multi ? baseSort() : [];
      const cur = base.find((s) => s.col === col);
      const next = !cur ? 'asc' : cur.dir === 'asc' ? 'desc' : null;
      if (!multi) st.sort = next ? [{ col, dir: next }] : [];
      else {
        const out = base.map((s) => (s.col === col ? (next ? { col, dir: next } : null) : s)).filter(Boolean);
        if (!cur) out.push({ col, dir: 'asc' });
        st.sort = out;
      }
      changed(true);
    }

    // ── filters ──
    function setFilter(col, op, value) {
      if (!cols[col]) return;
      st.filters = st.filters.filter((f) => f.col !== col);
      if (op) st.filters.push({ col, op: String(op), value: value == null ? '' : String(value) });
      return changed(true);
    }
    function setColFilters(col, list) {
      st.filters = st.filters.filter((f) => f.col !== col).concat(list);
      return changed(true);
    }

    // ── filter popover ──
    function closePop(focusBack) {
      if (popOff) { try { popOff(); } catch (e) {} popOff = null; }
      if (pop) { pop.hidden = true; pop.innerHTML = ''; }
      const col = popState && popState.col;
      popState = null;
      if (focusBack && col) { const b = filterBtn(col); if (b && b.focus) { try { b.focus(); } catch (e) {} } }
    }
    function filterBtn(col) { try { return el && typeof el.querySelector === 'function' ? el.querySelector('[data-tkt="filter"][data-col="' + col + '"]') : null; } catch (e) { return null; } }
    function draftFrom(c) {
      const fs = st.filters.filter((f) => f.col === c.key);
      const f = fs[0];
      const d = { col: c.key, op: '', a: '', b: '', list: [], mode: 'in' };
      if (c.type === 'text') { d.op = f ? f.op : 'has'; d.a = f ? f.value : ''; }
      else if (c.type === 'number') {
        d.op = 'between';
        if (f) { if (f.op === 'between') { const p = f.value.split('..'); d.a = p[0] || ''; d.b = p[1] || ''; } else { d.op = f.op; d.a = f.value; } }
      } else if (c.type === 'datetime') {
        d.op = 'on';
        if (f) {
          const p = f.value.split('..'), a = numOrNull(p[0]), b = numOrNull(p[1]), n = numOrNull(f.value);
          if (f.op === 'empty' || f.op === 'nempty') d.op = f.op;
          else if (f.op === 'between') { d.op = a != null && b != null && ymd(a) === ymd(b) ? 'on' : 'between'; d.a = a != null ? ymd(a) : ''; d.b = b != null ? ymd(b) : ''; }
          else if (n != null && (f.op === 'lt' || f.op === 'lte')) { d.op = 'before'; d.a = ymd(f.op === 'lt' ? n : n + 1); }
          else if (n != null && (f.op === 'gt' || f.op === 'gte')) { d.op = 'after'; d.a = ymd(isMidnight(n) ? n - 1 : n); }
          else if (n != null) { d.op = 'on'; d.a = ymd(n); }
        }
      } else if (c.type === 'date') {
        d.op = 'on';
        if (f) { if (f.op === 'between') { const p = f.value.split('..'); d.op = 'between'; d.a = p[0] || ''; d.b = p[1] || ''; } else { d.op = f.op === 'eq' ? 'on' : f.op; d.a = f.value; } }
      } else if (c.type === 'enum') {
        if (f) { d.mode = f.op === 'nin' ? 'nin' : f.op === 'all' ? 'all' : 'in'; d.list = f.value.split('|').filter(Boolean); }
      } else if (c.type === 'bool') d.a = f ? (f.value === '1' || f.value === 'true' ? '1' : '0') : '';
      return d;
    }
    function popHtml(c, d) {
      const opSel = (list) => '<label class="tkt-f">Condition<select name="op" data-tkp="op">' + list.map((o) => '<option value="' + o[0] + '"' + (o[0] === d.op ? ' selected' : '') + '>' + esc(o[1].charAt(0).toUpperCase() + o[1].slice(1)) + '</option>').join('') + '</select></label>';
      const inp = (name, type, val, label) => '<label class="tkt-f">' + esc(label) + '<input name="' + name + '" type="' + type + '" value="' + esc(val) + '"' + (type === 'number' ? ' inputmode="decimal" step="any"' : '') + '></label>';
      let h = '<div class="tkt-pop-h">' + esc(c.label) + '</div>';
      const noVal = d.op === 'empty' || d.op === 'nempty';
      if (c.type === 'text') { h += opSel(TEXT_OPS); if (!noVal) h += inp('a', 'text', d.a, 'Value'); }
      else if (c.type === 'number') {
        h += opSel([['between', 'Range']].concat(NUM_OPS.slice(1)));
        if (d.op === 'between') h += '<div class="tkt-two">' + inp('a', 'number', d.a, 'Min') + inp('b', 'number', d.b, 'Max') + '</div>';
        else if (!noVal) h += inp('a', 'number', d.a, 'Value');
      } else if (c.type === 'datetime' || c.type === 'date') {
        h += opSel(DAY_OPS);
        if (d.op === 'between') h += '<div class="tkt-two">' + inp('a', 'date', d.a, 'From') + inp('b', 'date', d.b, 'To') + '</div>';
        else if (!noVal) h += inp('a', 'date', d.a, 'Day');
        h += '<div class="tkt-quick" role="group" aria-label="Quick ranges">' + (c.type === 'datetime' ? [['24h', 'Last 24 h'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days']] : [['today', 'Today'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days']]).map((q) => '<button type="button" class="chip" data-tkp="quick" data-q="' + q[0] + '">' + q[1] + '</button>').join('') + '</div>';
      } else if (c.type === 'enum') {
        h += '<div class="tkt-opts">';
        const opts = c.opts.length ? c.opts : d.list.map((v) => ({ value: v, label: v }));
        if (!opts.length) h += '<span class="muted">No values to pick.</span>';
        for (const o of opts) h += '<label><input type="checkbox" name="v" value="' + esc(o.value) + '"' + (d.list.indexOf(o.value) >= 0 ? ' checked' : '') + '>' + esc(o.label) + '</label>';
        h += '</div><label class="tkt-f">Match<select name="mode" data-tkp="mode"><option value="in"' + (d.mode === 'in' ? ' selected' : '') + '>' + (c.multi ? 'Has any of these' : 'Is one of these') + '</option>' + (c.multi ? '<option value="all"' + (d.mode === 'all' ? ' selected' : '') + '>Has all of these</option>' : '') + '<option value="nin"' + (d.mode === 'nin' ? ' selected' : '') + '>' + (c.multi ? 'Has none of these' : 'Is none of these') + '</option></select></label>';
      } else if (c.type === 'bool') {
        h += '<div class="tkt-opts" role="radiogroup">' + [['', 'Any'], ['1', 'Yes'], ['0', 'No']].map((o) => '<label class="tkt-check"><input type="radio" name="a" value="' + o[0] + '"' + (d.a === o[0] ? ' checked' : '') + '>' + o[1] + '</label>').join('') + '</div>';
      }
      h += '<div class="tkt-pop-acts"><button type="button" class="btn ghost" data-tkp="clear">Clear</button><button type="button" class="btn" data-tkp="cancel">Cancel</button><button type="button" class="btn primary" data-tkp="apply">Apply</button></div>';
      return h;
    }
    function readDraft() {
      const d = popState; if (!pop || !d) return d;
      const q = (sel) => { try { return pop.querySelector(sel); } catch (e) { return null; } };
      const all = (sel) => { try { return Array.prototype.slice.call(pop.querySelectorAll(sel) || []); } catch (e) { return []; } };
      const op = q('[name="op"]'); if (op) d.op = op.value;
      const a = q('input[name="a"]:not([type=radio])'); if (a) d.a = a.value;
      const b = q('input[name="b"]'); if (b) d.b = b.value;
      const mode = q('[name="mode"]'); if (mode) d.mode = mode.value;
      const radios = all('input[type=radio][name="a"]'); if (radios.length) { d.a = ''; for (const r of radios) if (r.checked) d.a = r.value; }
      const boxes = all('input[type=checkbox][name="v"]'); if (boxes.length) d.list = boxes.filter((x) => x.checked).map((x) => x.value);
      return d;
    }
    // The draft as filters for its column ([] = no filter).
    function draftFilters(c, d) {
      const col = c.key;
      if (d.op === 'empty' || d.op === 'nempty') return [{ col, op: d.op, value: '' }];
      if (c.type === 'text') return String(d.a).trim() === '' ? [] : [{ col, op: d.op, value: String(d.a).trim() }];
      if (c.type === 'number') {
        if (d.op === 'between') { const a = numOrNull(d.a), b = numOrNull(d.b); return a == null && b == null ? [] : [{ col, op: 'between', value: (a == null ? '' : a) + '..' + (b == null ? '' : b) }]; }
        const n = numOrNull(d.a); return n == null ? [] : [{ col, op: d.op, value: String(n) }];
      }
      if (c.type === 'datetime') {
        const a = dayStart(d.a), b = d.op === 'between' ? nextDay(d.b) : nextDay(d.a);
        if (d.op === 'on') return a == null ? [] : [{ col, op: 'between', value: a + '..' + (b - 1) }];
        if (d.op === 'before') return a == null ? [] : [{ col, op: 'lt', value: String(a) }];
        if (d.op === 'after') return b == null ? [] : [{ col, op: 'gte', value: String(b) }];
        if (d.op === 'between') return a == null && b == null ? [] : [{ col, op: 'between', value: (a == null ? '' : a) + '..' + (b == null ? '' : b - 1) }];
        return [];
      }
      if (c.type === 'date') {
        const ok = (x) => /^\d{4}-\d{2}-\d{2}$/.test(String(x || ''));
        if (d.op === 'between') return !ok(d.a) && !ok(d.b) ? [] : [{ col, op: 'between', value: (ok(d.a) ? d.a : '') + '..' + (ok(d.b) ? d.b : '') }];
        return ok(d.a) ? [{ col, op: d.op === 'on' ? 'eq' : d.op, value: d.a }] : [];
      }
      if (c.type === 'enum') return d.list.length ? [{ col, op: d.mode === 'all' && c.multi ? 'all' : d.mode === 'nin' ? 'nin' : 'in', value: d.list.join('|') }] : [];
      if (c.type === 'bool') return d.a === '1' || d.a === '0' ? [{ col, op: 'eq', value: d.a }] : [];
      return [];
    }
    function quickFilters(c, q) {
      const now = Date.now();
      if (c.type === 'datetime') { const h = { '24h': 24, '7d': 168, '30d': 720, '90d': 2160 }[q] || 24; return [{ col: c.key, op: 'gte', value: String(now - h * 3600000) }]; }
      const today = ymd(now), back = (n) => { const x = new Date(now); x.setDate(x.getDate() - n); return ymd(x.getTime()); };
      if (q === 'today') return [{ col: c.key, op: 'eq', value: today }];
      return [{ col: c.key, op: 'between', value: back(q === '30d' ? 29 : 6) + '..' + today }];
    }
    function openPop(col, anchor) {
      const c = cols[col]; if (!c || !c.filterable) return;
      if (popState && popState.col === col) { closePop(true); return; }
      closePop(false);
      if (typeof document === 'undefined' || !document.body || typeof document.createElement !== 'function') return;
      if (!pop) {
        pop = document.createElement('div');
        pop.className = 'tkt-pop';
        pop.id = id + '-pop';
        if (typeof pop.setAttribute === 'function') { pop.setAttribute('role', 'dialog'); }
        if (typeof pop.addEventListener === 'function') {
          pop.addEventListener('click', onPopClick);
          pop.addEventListener('change', (e) => { const t = e.target; if (t && t.getAttribute && (t.getAttribute('data-tkp') === 'op')) { readDraft(); renderPop(); } });
          pop.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.preventDefault(); closePop(true); }
            else if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT') { e.preventDefault(); applyPop(); }
          });
        }
        if (typeof document.body.appendChild === 'function') document.body.appendChild(pop);
      }
      popState = draftFrom(c);
      if (typeof pop.setAttribute === 'function') pop.setAttribute('aria-label', 'Filter ' + c.label);
      renderPop();
      pop.hidden = false;
      try {
        const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
        const vw = document.documentElement ? document.documentElement.clientWidth : 1024;
        const w = pop.offsetWidth || 320;
        if (r) { pop.style.top = Math.round(r.bottom + 6) + 'px'; pop.style.left = Math.round(Math.max(8, Math.min(vw - w - 8, r.right - w))) + 'px'; }
      } catch (e) {}
      try { const f = pop.querySelector('select, input'); if (f && f.focus) f.focus(); } catch (e) {}
      const outside = (e) => { const t = e.target; if (pop && t && pop.contains && pop.contains(t)) return; if (t && t.closest && t.closest('[data-tkt="filter"]')) return; closePop(false); };
      const onScroll = (e) => { if (pop && e && e.target && pop.contains && pop.contains(e.target)) return; closePop(false); };
      if (typeof document.addEventListener === 'function') document.addEventListener('pointerdown', outside, true);
      const win = typeof window !== 'undefined' ? window : null;
      if (win && win.addEventListener) { win.addEventListener('scroll', onScroll, true); win.addEventListener('resize', onScroll); }
      popOff = () => {
        if (typeof document.removeEventListener === 'function') document.removeEventListener('pointerdown', outside, true);
        if (win && win.removeEventListener) { win.removeEventListener('scroll', onScroll, true); win.removeEventListener('resize', onScroll); }
      };
    }
    function renderPop() { if (pop && popState) pop.innerHTML = popHtml(cols[popState.col], popState); }
    function applyPop() {
      const d = readDraft(); if (!d) return;
      const c = cols[d.col];
      const list = draftFilters(c, d);
      closePop(true);
      setColFilters(c.key, list);
    }
    function onPopClick(e) {
      const t = e.target && e.target.closest ? e.target.closest('[data-tkp]') : null;
      if (!t || !popState) return;
      const act = t.getAttribute('data-tkp');
      if (act === 'apply') applyPop();
      else if (act === 'cancel') closePop(true);
      else if (act === 'clear') { const col = popState.col; closePop(true); setColFilters(col, []); }
      else if (act === 'quick') { const col = popState.col; const list = quickFilters(cols[col], t.getAttribute('data-q')); closePop(true); setColFilters(col, list); }
    }

    // ── events (delegated on the root) ──
    function onClick(e) {
      const t = e && e.target;
      if (!t || typeof t.closest !== 'function') return;
      const ctl = t.closest('[data-tkt]');
      if (ctl) {
        const act = ctl.getAttribute('data-tkt'), col = ctl.getAttribute('data-col');
        if (act === 'sort') cycleSort(col, !!e.shiftKey);
        else if (act === 'filter' || act === 'editf') openPop(col, act === 'editf' ? filterBtn(col) || ctl : ctl);
        else if (act === 'unfilter') { const i = Number(ctl.getAttribute('data-i')); if (i >= 0 && i < st.filters.length) { st.filters.splice(i, 1); changed(true); } }
        else if (act === 'chip') {
          const c = chipById(ctl.getAttribute('data-chip')); if (!c) return;
          const on = st.chips.indexOf(c.id) >= 0;
          st.chips = on ? st.chips.filter((x) => x !== c.id) : st.chips.filter((x) => { const o = chipById(x); return !(c.group && o && o.group === c.group); }).concat([c.id]);
          if (c.sort) st.sort = [];
          changed(true);
        }
        else if (act === 'clear') clearFilters();
        else if (act === 'page') { const n = Number(ctl.getAttribute('data-page')); if (n >= 1 && !ctl.disabled) { st.page = n; changed(false); } }
        else if (act === 'retry') load();
        return;
      }
      const btn = t.closest('[data-act]');
      const tr = t.closest('tr[data-tkt-row]');
      if (btn && tr) { const row = rowsNow[Number(tr.getAttribute('data-tkt-row'))]; if (row && cfg.onAction) cfg.onAction(btn.getAttribute('data-act'), row, btn, e); return; }
      if (!tr || !cfg.onRowClick) return;
      if (t.closest('a, button, input, select, textarea, label, summary, details')) return;
      const row = rowsNow[Number(tr.getAttribute('data-tkt-row'))];
      if (row) cfg.onRowClick(row, e);
    }
    function onInput(e) {
      const t = e && e.target;
      if (!t || !t.getAttribute || t.getAttribute('data-tkt') !== 'q') return;
      if (qTimer) clearTimeout(qTimer);
      qTimer = setTimeout(() => { qTimer = null; const v = String(t.value || '').trim(); if (v === st.q) return; st.q = v; changed(true); }, 250);
    }
    function onChange(e) {
      const t = e && e.target;
      if (!t || !t.getAttribute) return;
      const act = t.getAttribute('data-tkt');
      if (act === 'size') { const n = Number(t.value); if (n > 0) { const first = (st.page - 1) * st.size; st.size = n; st.page = Math.floor(first / n) + 1; changed(false); } }
      else if (act === 'jump') goJump(t);
      else if (act === 'pfilter') { const col = String(t.value || ''); t.value = ''; if (cols[col]) openPop(col, t); }
      else if (act === 'psort') { const v = String(t.value || ''); const i = v.lastIndexOf(':'); st.sort = v && cols[v.slice(0, i)] ? [{ col: v.slice(0, i), dir: v.slice(i + 1) === 'desc' ? 'desc' : 'asc' }] : []; changed(true); }
    }
    function goJump(t) {
      const n = Math.floor(Number(t.value));
      const max = lastResp && lastResp.pageCount ? lastResp.pageCount : 1;
      if (!(n >= 1)) return;
      st.page = Math.min(n, max);
      changed(false);
    }
    function onKey(e) {
      const t = e && e.target;
      if (!t || e.key !== 'Enter') return;
      if (t.getAttribute && t.getAttribute('data-tkt') === 'jump') { e.preventDefault(); goJump(t); return; }
      if (t.getAttribute && t.getAttribute('data-tkt') === 'q') { e.preventDefault(); if (qTimer) { clearTimeout(qTimer); qTimer = null; } const v = String(t.value || '').trim(); if (v !== st.q) { st.q = v; changed(true); } return; }
      if (cfg.onRowClick && t.getAttribute && t.getAttribute('data-tkt-row') != null) { const row = rowsNow[Number(t.getAttribute('data-tkt-row'))]; if (row) { e.preventDefault(); cfg.onRowClick(row, e); } }
    }

    function clearFilters() {
      st.filters = []; st.q = ''; st.chips = defaultChips.slice();
      if (qTimer) { clearTimeout(qTimer); qTimer = null; }
      const qi = part('q'); if (qi) qi.value = '';
      return changed(true);
    }

    // ── mount ──
    if (el) {
      el.innerHTML = frame();
      if (typeof el.addEventListener === 'function') {
        el.addEventListener('click', onClick);
        el.addEventListener('input', onInput);
        el.addEventListener('change', onChange);
        el.addEventListener('keydown', onKey);
      }
    }
    paintChrome();
    load();

    return {
      id,
      reload: () => load(),
      setFilter,
      clearFilters,
      setSort(s) { st.sort = parseSort(s, cols).filter((x) => cols[x.col].sortable); return changed(true); },
      setPage(n) { st.page = Math.max(1, Math.floor(Number(n) || 1)); return changed(false); },
      setRows(rows) { if (local) { cfg.source.rows = rows; return load(); } },
      state: () => ({ page: st.page, size: st.size, sort: st.sort.slice(), effectiveSort: effSort(), filters: st.filters.slice(), effectiveFilters: effFilters(), q: st.q, chips: st.chips.slice() }),
      rows: () => rowsNow.slice(),
      response: () => lastResp,
      url: () => (local ? null : requestUrl()),
      _click: onClick, _input: onInput, _change: onChange, _key: onKey,
    };
  }

  return { create, runLocal, parseSort, qs, version: 1 };
})();
`
