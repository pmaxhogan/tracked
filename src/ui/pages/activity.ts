// Activity: one newest-first log of everything tracked did (spec "Activity
// (phase 2)"): requests, playlist additions, hygiene, mkvid, pool, sync and
// IP blocks. Data: GET /ui/api/activity (keyset-paged, "Load older"), the DJ
// filter's options from GET /ui/api/list; the drawer fetches
// /ui/api/audit-detail or /ui/api/playlist-addition-detail for requests and
// additions and shows the row's own fields for everything else.
//
// Filter state lives in the script (and the query string); the chips are
// re-rendered through innerHTML and clicks are delegated (the tests run this
// script in a stub DOM without setAttribute or appendChild). Every upstream
// value goes through esc.
import { skelHtml } from '../skeleton'
import { shell } from '../shell'
import { icon } from '../icons'
import type { UiPage } from './index'
import { ACTIVITY_DETAIL_CSS, ACTIVITY_DETAIL_JS } from './activity-detail'

const KINDS: Array<[string, string]> = [
  ['request', 'Requests'], ['playlist', 'Playlist'], ['hygiene', 'Hygiene'], ['mkvid', 'mkvid'],
  ['pool', 'Pool'], ['sync', 'Sync'], ['ban', 'IP blocks'],
]
const RANGES = ['24h', '7d', '30d', '90d']
const DEFAULT_RANGE = '7d'

const KIND_ICON: Record<string, string> = {
  request: icon('play', { size: 16 }), playlist: icon('playlist', { size: 16 }), hygiene: icon('removed', { size: 16 }),
  mkvid: icon('mkvid', { size: 16 }), pool: icon('pool', { size: 16 }), sync: icon('refresh', { size: 16 }), ban: icon('ban', { size: 16 }),
}

/**
 * activityRowHtml(r, i): one row of GET /ui/api/activity as a list item. The
 * drawer opener is the <button data-i>; the DJ and set links sit beside it in
 * the .a-item wrapper, so following them never opens the drawer. Assumes only
 * TK and esc in scope (Home reuses it in phase 2's Task 5).
 */
export const ACTIVITY_ROW_JS = /* js */ `
  const KIND_ICON = ${JSON.stringify(KIND_ICON)};
  const ACTIVITY_OK = new Set(['ok', 'added', 'done', 'claimed', 'verified', 'challenge.solved', 'account.created', 'ended']);
  function activityIso(ts) { try { return new Date(ts).toISOString(); } catch (e) { return ''; } }
  function activityRowHtml(r, i) {
    const cls = r.problem ? 'bad' : ACTIVITY_OK.has(r.status) ? 'ok' : 'neutral';
    const iso = activityIso(r.ts);
    const links = (r.dj ? '<a class="a-link" href="/ui/dj/' + encodeURIComponent(r.dj) + '">' + esc(r.dj) + '</a>' : '') +
      (r.setUrl ? '<a class="a-link" href="/ui/set?url=' + encodeURIComponent(r.setUrl) + '">set</a>' : '');
    return '<div class="a-item" role="listitem">' +
      '<button type="button" class="a-row' + (r.problem ? ' err' : '') + '" data-i="' + i + '">' +
        '<span class="a-ico">' + (KIND_ICON[r.kind] || '') + '</span>' +
        '<span class="badge ' + cls + '">' + esc(r.status || '?') + '</span>' +
        '<span class="a-main"><span class="a-title">' + esc(r.title || '(untitled)') + '</span>' +
          (r.detail ? '<span class="a-detail muted">' + esc(r.detail) + '</span>' : '') + '</span>' +
        '<span class="a-when" title="' + esc(iso) + '">' + esc(TK.fmt.rel(iso)) + '</span>' +
      '</button>' +
      (links ? '<span class="a-links">' + links + '</span>' : '') +
    '</div>';
  }
`

/**
 * The drawer for an activity row, shared by the Activity page and Home: audit
 * and addition rows fetch their detail, every other row shows its own fields.
 * Needs ACTIVITY_DETAIL_JS and ACTIVITY_ROW_JS in scope; call openActivityRow(row).
 */
export const ACTIVITY_DRAWER_JS = /* js */ `
  let drawerSeq = 0;
  async function openFetched(title, path, renderer) {
    const my = ++drawerSeq;
    const body = TK.drawer.open(title, '<span class="muted">loading…</span>');
    const res = await TK.api.get(path);
    if (my !== drawerSeq || !body) return;
    if (!res.ok && res.status !== 404) { body.innerHTML = '<span class="warn">failed to load detail</span>'; return; }
    const rec = res.data && res.data.record;
    body.innerHTML = '<div class="h-detail">' + (rec ? renderer(rec) : '<span class="warn">detail not found</span>') + '</div>';
  }
  function ownDetailHtml(r) {
    const iso = activityIso(r.ts);
    return dl([
      ['When', esc(iso) + (iso ? ' <span class="when">(' + esc(TK.fmt.rel(iso)) + ')</span>' : '')],
      ['Kind', esc(r.kind)],
      ['Status', '<span class="' + (r.problem ? 'warn' : '') + '">' + esc(r.status || '—') + '</span>'],
      ['Title', esc(r.title || '—')],
      r.detail ? ['Detail', esc(r.detail)] : null,
      r.dj ? ['DJ', '<a href="/ui/dj/' + encodeURIComponent(r.dj) + '">' + esc(r.dj) + '</a>'] : null,
      r.setUrl ? ['Set', '<a href="/ui/set?url=' + encodeURIComponent(r.setUrl) + '">' + esc(setLabel(r.setUrl)) + '</a> ' + link(r.setUrl, '1001tracklists')] : null,
      r.videoId ? ['Video', '<span class="mono">' + esc(r.videoId) + '</span> ' + link('https://youtu.be/' + encodeURIComponent(r.videoId), 'open')] : null,
    ]);
  }
  function openActivityRow(r) {
    if (!r) return;
    const ref = r.ref || {};
    if (ref.kind === 'audit') openFetched(r.title || 'Request', '/ui/api/audit-detail?key=' + encodeURIComponent(ref.key), auditDetailHtml);
    else if (ref.kind === 'addition') openFetched(r.title || 'Playlist addition', '/ui/api/playlist-addition-detail?key=' + encodeURIComponent(ref.key), plDetailHtml);
    else { ++drawerSeq; TK.drawer.open(r.title || 'Activity', '<div class="h-detail">' + ownDetailHtml(r) + '</div>'); }
  }
`

export const ACTIVITY_ROW_CSS = /* css */ `
  .a-item { display: flex; align-items: center; gap: var(--sp-2); border-bottom: 1px solid var(--line); min-width: 0; }
  .a-item:last-child { border-bottom: 0; }
  .a-item:hover { background: var(--elev); }
  .a-row { flex: 1; display: flex; align-items: center; gap: var(--sp-2); min-width: 0; font: inherit; color: var(--fg); background: none; border: 0; padding: 8px 4px 8px 8px; text-align: left; cursor: pointer; }
  .a-row.err { box-shadow: inset 3px 0 0 var(--danger); }
  .a-ico { color: var(--muted); display: inline-flex; flex: none; }
  .a-row .badge { flex: none; }
  .a-main { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: var(--sp-2); }
  .a-title { font-size: var(--fs-sm); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .a-detail { font-size: var(--fs-xs); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 8rem; }
  .a-when { color: var(--muted); font-size: var(--fs-xs); white-space: nowrap; flex: none; }
  .a-links { display: flex; gap: var(--sp-2); padding-right: 8px; flex: none; font-size: var(--fs-xs); white-space: nowrap; }
  /* Phone: stack the row. Line 1 is icon, badge and time; then the title, the
     detail, and the DJ/set links, each on the full width. break-word only
     splits a word too long for a line (an id, a URL), never a normal word. */
  @media (max-width: 799px) {
    .a-item { flex-direction: column; align-items: stretch; gap: 0; }
    .a-row { flex-wrap: wrap; row-gap: 4px; }
    .a-main { order: 1; flex-basis: 100%; flex-direction: column; align-items: flex-start; gap: 2px; }
    .a-title, .a-detail { white-space: normal; overflow: visible; text-overflow: clip; overflow-wrap: break-word; max-width: 100%; }
    .a-detail { flex: none; }
    .a-when { margin-left: auto; }
    .a-links { flex-basis: 100%; flex-wrap: wrap; padding: 0 8px 8px 8px; }
  }
`

const chip = (attr: string, value: string, label: string, on: boolean) =>
  `<button type="button" class="chip${on ? ' on' : ''}" data-${attr}="${value}" aria-pressed="${on}">${label}</button>`

const BODY = /* html */ `
<div class="tk-filters" id="a-filters">
  <div id="a-kinds" class="chips a-chips" role="group" aria-label="Kinds">${KINDS.map(([k, l]) => chip('kind', k, l, false)).join('')}</div>
  <div class="a-ctl">
    <span id="a-toggle" class="chips a-chips"><button id="a-problems" type="button" class="chip" aria-pressed="false">Problems only</button></span>
    <select id="a-dj" aria-label="DJ"><option value="">All DJs</option></select>
    <div id="a-ranges" class="chips a-chips" role="group" aria-label="Range">${RANGES.map((r) => chip('range', r, r, r === DEFAULT_RANGE)).join('')}</div>
  </div>
</div>
<div id="a-list" class="tk-card a-list" role="list" hidden></div>
<div id="a-skel">${skelHtml(8, 'card')}</div>
<div id="a-empty" class="empty" hidden></div>
<p class="a-foot"><button id="a-more" type="button" class="btn" hidden>Load older</button></p>
`

export const ACTIVITY_PAGE_CSS = /* css */ `
  .tk-filters { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); margin-bottom: var(--sp-3); min-width: 0; }
  .a-ctl { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); min-width: 0; }
  .tk-filters .chips { margin-bottom: 0; }
  .chip[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
  #a-dj { font: inherit; font-size: var(--fs-sm); color: var(--fg); background: var(--page); border: 1px solid var(--line-strong); border-radius: var(--r-ctl); padding: 5px 8px; min-width: 0; max-width: 100%; }
  .a-list { padding: 0; overflow: hidden; transition: opacity .15s; }
  .a-list.busy { opacity: .5; }
  .a-link { color: var(--accent); }
  .a-foot { margin: var(--sp-3) 0 0; }
  .a-foot .btn { width: 100%; }
  #a-empty .error { color: var(--danger); }
  #a-empty .btn { margin-left: var(--sp-2); }
  @media (max-width: 799px) {
    .tk-filters, .a-ctl { flex-direction: column; align-items: stretch; flex-wrap: nowrap; }
    .tk-filters .a-chips { flex-wrap: wrap; max-width: 100%; }
    .tk-filters .chip { white-space: nowrap; flex: none; }
  }
${ACTIVITY_ROW_CSS}
${ACTIVITY_DETAIL_CSS}`

const JS = /* js */ `
(() => {
  const $ = TK.$, esc = TK.esc;
${ACTIVITY_DETAIL_JS}
${ACTIVITY_ROW_JS}
${ACTIVITY_DRAWER_JS}
  const KINDS = ${JSON.stringify(KINDS)};
  const RANGE_MS = { '24h': 86400000, '7d': 7 * 86400000, '30d': 30 * 86400000, '90d': 90 * 86400000 };
  const $filters = $('a-filters'), $kinds = $('a-kinds'), $toggle = $('a-toggle'), $ranges = $('a-ranges'), $dj = $('a-dj');
  const $list = $('a-list'), $empty = $('a-empty'), $skel = $('a-skel'), $more = $('a-more'), $refresh = $('a-refresh');

  // ── filter state: the query string is the source, unknown kinds and ranges are dropped ──
  const known = new Set(KINDS.map((k) => k[0]));
  const kinds = new Set((TK.qs.get('kind') || '').split(',').filter((k) => known.has(k)));
  let problems = TK.qs.get('problems') === '1';
  let dj = TK.qs.get('dj') || '';
  let range = Object.prototype.hasOwnProperty.call(RANGE_MS, TK.qs.get('range') || '') ? TK.qs.get('range') : '${DEFAULT_RANGE}';
  const kindList = () => KINDS.map((k) => k[0]).filter((k) => kinds.has(k));
  const filtered = () => kinds.size > 0 || problems || !!dj;

  const chip = (attr, value, label, on) => '<button type="button" class="chip' + (on ? ' on' : '') + '" data-' + attr + '="' + value + '" aria-pressed="' + on + '">' + esc(label) + '</button>';
  function renderFilters() {
    $kinds.innerHTML = KINDS.map((k) => chip('kind', k[0], k[1], kinds.has(k[0]))).join('');
    $toggle.innerHTML = '<button id="a-problems" type="button" class="chip' + (problems ? ' on' : '') + '" aria-pressed="' + problems + '">Problems only</button>';
    $ranges.innerHTML = Object.keys(RANGE_MS).map((r) => chip('range', r, r, r === range)).join('');
  }
  function sync() { TK.qs.set({ kind: kindList().join(','), problems: problems ? '1' : '', dj, range }); }

  function apiUrl(cursor) {
    const ks = kindList();
    return '/ui/api/activity?' + (ks.length ? 'kind=' + encodeURIComponent(ks.join(',')) : '') +
      (problems ? '&problems=1' : '') + (dj ? '&dj=' + encodeURIComponent(dj) : '') +
      '&since=' + (Date.now() - RANGE_MS[range]) + '&limit=50' +
      (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
  }

  // ── the list ──
  let rows = [], cursor = null, seq = 0, lastMore = false;
  function render() {
    $list.innerHTML = rows.map((r, i) => activityRowHtml(r, i)).join('');
    $list.hidden = !rows.length;
    $more.hidden = !cursor;
    $empty.hidden = rows.length > 0;
    $empty.textContent = filtered() ? 'Nothing matches these filters in this range.' : 'Nothing in this range.';
  }
  // A new filter or Refresh replaces the list; Load older appends. A response
  // to a request that a newer one has overtaken is dropped. While a replace
  // is in flight the list is marked busy and there is no cursor, so Load
  // older cannot page the old filter's rows with the new filter.
  function setBusy(on) {
    $list.className = 'tk-card a-list' + (on ? ' busy' : '');
    if (typeof $list.setAttribute === 'function') { if (on) $list.setAttribute('aria-busy', 'true'); else $list.removeAttribute('aria-busy'); }
  }
  async function load(more) {
    if (more && !cursor) return;
    const my = ++seq;
    lastMore = !!more;
    const from = more ? cursor : null;
    if (!more) { cursor = null; $more.hidden = true; setBusy(true); }
    const res = await TK.api.get(apiUrl(from));
    if (my !== seq) return;
    $skel.hidden = true;
    setBusy(false);
    const d = res.ok && res.data && Array.isArray(res.data.rows) ? res.data : null;
    if (!d) {
      if (!more) { rows = []; $list.innerHTML = ''; $list.hidden = true; }
      $empty.hidden = false;
      $empty.innerHTML = '<span class="error">' + esc(TK.errText(res, 'Could not load activity (' + (res.status || 'offline') + ')')) + '</span><button type="button" id="a-retry" class="btn">Retry</button>';
      return;
    }
    rows = more ? rows.concat(d.rows) : d.rows.slice();
    cursor = d.cursor || null;
    render();
  }
  function changed() { renderFilters(); sync(); load(false); }

  $filters.addEventListener('click', (ev) => {
    const b = ev.target && ev.target.closest ? ev.target.closest('button') : null;
    if (!b) return;
    const ds = b.dataset || {};
    if (ds.kind && known.has(ds.kind)) { if (kinds.has(ds.kind)) kinds.delete(ds.kind); else kinds.add(ds.kind); }
    else if (ds.range && RANGE_MS[ds.range]) { if (range === ds.range) return; range = ds.range; }
    else if (b.id === 'a-problems') problems = !problems;
    else return;
    changed();
  });
  $dj.addEventListener('change', () => { dj = $dj.value || ''; sync(); load(false); });
  if ($refresh) $refresh.addEventListener('click', () => TK.busy($refresh, 'Refreshing…', () => load(false)));
  $more.addEventListener('click', () => TK.busy($more, 'Loading…', () => load(true)));
  $empty.addEventListener('click', (ev) => {
    const b = ev.target && ev.target.closest ? ev.target.closest('#a-retry') : null;
    if (b) TK.busy(b, 'Retrying…', () => load(lastMore && rows.length > 0 && !!cursor));
  });

  // ── the drawer (ACTIVITY_DRAWER_JS) ──
  $list.addEventListener('click', (ev) => {
    const b = ev.target && ev.target.closest ? ev.target.closest('[data-i]') : null;
    if (!b) return;
    openActivityRow(rows[Number(b.dataset.i)]);
  });

  // ── the DJ filter's options: after the first page; a failure leaves "All DJs" ──
  async function loadDjs() {
    const res = await TK.api.get('/ui/api/list');
    const subs = res.ok && res.data && res.data.subscriptions;
    if (!Array.isArray(subs)) return;
    const slugs = subs.map((s) => s && s.slug).filter(Boolean).sort();
    if (dj && slugs.indexOf(dj) < 0) slugs.unshift(dj);
    $dj.innerHTML = '<option value="">All DJs</option>' + slugs.map((s) => '<option value="' + esc(s) + '">' + esc(s) + '</option>').join('');
    $dj.value = dj;
  }

  renderFilters();
  // The DJ options load after the first page, whatever happened to it.
  load(false).catch(() => {}).then(loadDjs);
})();
`

export const ACTIVITY_PAGE: UiPage = {
  path: '/activity',
  html: shell({
    nav: 'activity',
    title: 'Activity',
    description: 'Everything tracked did, newest first: requests, playlist additions, hygiene, mkvid, pool, sync and IP blocks.',
    actions: '<button id="a-refresh" type="button" class="btn">Refresh</button>',
    body: BODY,
    css: ACTIVITY_PAGE_CSS,
    js: JS,
  }),
}
