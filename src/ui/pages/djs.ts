// DJs: every subscribed 1001tracklists DJ with its sync state. Add, remove, sync
// one or all (serially), Invalidate & resync one or all (all is ONE request),
// and the "fix titles" dialog. Data: GET /ui/api/list, then one
// GET /ui/api/state/:slug per row, four at a time.
import { shell } from '../shell'
import type { UiPage } from './index'
import { DJ_ACTIONS_CSS, DJ_ACTIONS_JS, FIX_DIALOG_HTML, FIX_TITLES_TITLE } from './dj-actions'

const ACTIONS = /* html */ `
<form id="add-form" class="dj-add">
  <input id="url" type="url" placeholder="1001tracklists DJ URL" aria-label="1001tracklists DJ URL" required />
  <button id="add-btn" type="submit" class="btn primary">Add DJ</button>
</form>
<button id="sync-all" type="button" class="btn" hidden>Sync all</button>
<button id="resync-all" type="button" class="btn danger" hidden title="Forget what the sync trusts about every DJ's sets and re-fetch them all: swapped recordings get replaced. Drains over a few cron ticks.">Invalidate &amp; resync all</button>
<button id="fix-titles" type="button" class="btn" title="${FIX_TITLES_TITLE}">Fix titles</button>`

const BODY = /* html */ `
<div id="filters" class="dj-filters" hidden>
  <div class="field"><label for="f-text">Filter</label><input id="f-text" type="search" placeholder="Filter DJs by name" /></div>
  <div class="field check"><input id="f-err" type="checkbox" /><label for="f-err">with errors</label></div>
  <span id="f-count" class="muted sub"></span>
</div>
<div id="error" class="err-state" role="alert" hidden></div>
<div id="wrap" class="tk-card tk-table-wrap" hidden>
  <table class="tk-table">
    <thead><tr><th>DJ</th><th>Sets</th><th>Last sync</th><th>Playlist</th><th>Actions</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
</div>
<div id="empty" class="empty">Loading DJs…</div>
${FIX_DIALOG_HTML}
`

const CSS = /* css */ `
  .dj-add { display: flex; gap: var(--sp-2); flex: 1 1 22rem; min-width: 0; }
  .dj-add input { flex: 1; min-width: 0; font: inherit; color: var(--fg); background: var(--page); border: 1px solid var(--line-strong); border-radius: var(--r-ctl); padding: 8px 10px; }
  .dj-filters { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--sp-3); margin-bottom: var(--sp-3); }
  .dj-filters .field input[type=search] { min-width: 14rem; }
  .dj-filters .field.check { align-self: flex-end; padding-bottom: 8px; }
  .dj-name { font-weight: 600; }
  .dj-sub { display: block; color: var(--muted); font-size: var(--fs-xs); }
  .dj-actions { display: flex; flex-wrap: wrap; gap: var(--sp-1); justify-content: flex-end; }
  .dj-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); justify-content: flex-end; }
  .skel.w { width: 5rem; display: inline-block; }
  .tk-table td.num { white-space: nowrap; }
  #error { margin-bottom: var(--sp-3); }
${DJ_ACTIONS_CSS}`

const JS = /* js */ `
(() => {
${DJ_ACTIONS_JS}
  const $ = TK.$, esc = TK.esc;
  const $rows = $('rows'), $wrap = $('wrap'), $empty = $('empty'), $error = $('error'), $filters = $('filters');
  const $text = $('f-text'), $errOnly = $('f-err'), $count = $('f-count');
  const $syncAll = $('sync-all'), $resyncAll = $('resync-all'), $fix = $('fix-titles');
  const $form = $('add-form'), $url = $('url'), $addBtn = $('add-btn');

  // One entry per subscription: { slug, sourceUrl, addedAt, state, busy, confirming }.
  // state: undefined = loading (skeleton), null = no sync state yet, object = loaded; failed = state call failed.
  let rows = [];
  let bulk = null; // 'sync' | 'resync' while a bulk action runs
  let focused = false;
  $text.value = TK.qs.get('q') || '';
  $errOnly.checked = TK.qs.get('errors') === '1';

  function hasError(r) { return !!(r.state && r.state.lastError); }
  function visible() {
    const q = ($text.value || '').trim().toLowerCase();
    return rows.filter((r) => {
      if ($errOnly.checked && !hasError(r)) return false;
      if (!q) return true;
      return r.slug.toLowerCase().includes(q) || String((r.state && r.state.artistName) || '').toLowerCase().includes(q);
    });
  }

  const SKEL = '<span class="skel w"></span>';
  function rowHtml(r) {
    const slug = esc(r.slug), enc = esc(encodeURIComponent(r.slug));
    const st = r.state, sum = DJA.summarize(st);
    const name = esc((st && st.artistName) || r.slug);
    const open = TK.safeHref(r.sourceUrl);
    const added = TK.fmt.date(r.addedAt);
    const who = '<a class="dj-name" href="/ui/dj/' + enc + '">' + name + '</a>' +
      '<span class="dj-sub">' + (name !== slug ? slug + ' · ' : '') + (open ? '<a href="' + esc(open) + '" target="_blank" rel="noreferrer noopener">1001tracklists ↗</a>' : '') + (added ? ' · added ' + esc(added) : '') + '</span>';
    let sets, last, playlist;
    if (r.state === undefined) { sets = last = playlist = SKEL; }
    else if (r.failed) { sets = last = playlist = '<span class="muted">state unavailable</span>'; }
    else if (!st) { sets = '—'; last = '<span class="muted">never synced</span>'; playlist = '—'; }
    else {
      sets = esc(sum.processed + ' of ' + sum.known) + (sum.pending ? ' <span class="badge info">' + sum.pending + ' pending</span>' : '');
      const when = DJA.lastRun(st);
      last = (when ? esc(when) : '<span class="muted">never</span>') + (st.lastError ? ' <span class="badge bad" title="' + esc(st.lastError) + '">error</span>' : '');
      const href = DJA.playlistHref(st);
      playlist = href ? '<a href="' + esc(href) + '" target="_blank" rel="noreferrer noopener">Playlist ↗</a> <span class="muted">' + sum.videos + ' video' + (sum.videos === 1 ? '' : 's') + '</span>' : '—';
    }
    let actions;
    if (r.confirming) {
      actions = '<span class="dj-confirm"><span>Remove ' + slug + '?</span>' +
        '<button type="button" class="btn small danger" data-act="remove-yes" data-slug="' + slug + '">Yes, remove</button>' +
        '<button type="button" class="btn small" data-act="remove-no" data-slug="' + slug + '">Cancel</button></span>';
    } else {
      const dis = r.busy || bulk ? ' disabled' : '';
      actions = '<span class="dj-actions">' +
        '<button type="button" class="btn small" data-act="sync" data-slug="' + slug + '"' + dis + '>' + (r.busy === 'sync' ? 'Syncing…' : 'Sync') + '</button>' +
        '<button type="button" class="btn small" data-act="resync" data-slug="' + slug + '"' + dis + ' title="Forget the cached video for every set and re-check them all">' + (r.busy === 'resync' ? 'Resyncing…' : 'Invalidate &amp; resync') + '</button>' +
        '<button type="button" class="btn small danger" data-act="remove" data-slug="' + slug + '"' + dis + '>Remove</button></span>';
    }
    return '<tr><td data-label="DJ">' + who + '</td><td data-label="Sets" class="num">' + sets + '</td><td data-label="Last sync">' + last +
      '</td><td data-label="Playlist">' + playlist + '</td><td data-label="Actions">' + actions + '</td></tr>';
  }

  function render() {
    const list = visible();
    $filters.hidden = !rows.length;
    $syncAll.hidden = !rows.length;
    $resyncAll.hidden = !rows.length;
    // One bulk action at a time: the other bulk button waits (the pressed one is TK.busy's).
    if (bulk !== 'sync') $syncAll.disabled = !!bulk;
    if (bulk !== 'resync') $resyncAll.disabled = !!bulk;
    $fix.disabled = !!bulk;
    $wrap.hidden = !list.length;
    $rows.innerHTML = list.map(rowHtml).join('');
    if (!rows.length) { $empty.textContent = 'No subscriptions yet.'; $empty.hidden = false; }
    else if (!list.length) { $empty.textContent = 'No DJs match the filter.'; $empty.hidden = false; }
    else $empty.hidden = true;
    $count.textContent = rows.length ? (list.length === rows.length ? rows.length + ' DJ' + (rows.length === 1 ? '' : 's') : list.length + ' of ' + rows.length + ' DJs') : '';
  }

  function showError(msg) {
    $error.textContent = '';
    if (!msg) { $error.hidden = true; return; }
    $error.innerHTML = '<span class="grow">' + esc(msg) + '</span><button type="button" class="btn small" id="retry">Retry</button>';
    $error.hidden = false;
    $('retry').addEventListener('click', () => load());
  }

  async function loadRowState(r) {
    const s = await DJA.loadState(r.slug);
    if (s.failed) { r.state = null; r.failed = true; }
    else { r.state = s.state; r.failed = false; }
    render();
  }

  async function load() {
    showError('');
    const res = await TK.api.get('/ui/api/list');
    if (!res.ok) {
      if (!rows.length) { $empty.textContent = 'Nothing to show.'; $empty.hidden = false; }
      showError(TK.errText(res, 'failed to load (' + res.status + ')'));
      return;
    }
    const prev = new Map(rows.map((r) => [r.slug, r]));
    rows = ((res.data && res.data.subscriptions) || []).map((s) => {
      const old = prev.get(s.slug);
      return { slug: s.slug, sourceUrl: s.sourceUrl, addedAt: s.addedAt, state: old ? old.state : undefined, failed: old ? old.failed : false, busy: old ? old.busy : null, confirming: false };
    });
    render();
    // ?focus=filter: the filter row is only shown once there are rows to filter.
    if (!focused && rows.length && TK.qs.get('focus') === 'filter') { focused = true; $text.focus(); }
    // At most four state calls at a time; each row shows a skeleton until its own arrives.
    await DJA.pool(rows.filter((r) => r.state === undefined), 4, loadRowState);
  }

  const find = (slug) => rows.find((r) => r.slug === slug);

  async function syncRow(r, resync) {
    r.busy = resync ? 'resync' : 'sync';
    render();
    const out = await DJA.syncSlug(r.slug, null, { resync });
    r.busy = null;
    await loadRowState(r);
    return out;
  }

  async function removeRow(r) {
    r.busy = 'remove'; r.confirming = false; render();
    const res = await TK.api.post('/ui/api/remove', { slug: r.slug });
    r.busy = null;
    if (!res.ok) { TK.toast(TK.errText(res, 'remove failed (' + res.status + ')'), 'bad'); render(); return; }
    rows = rows.filter((x) => x !== r);
    render();
  }

  $rows.addEventListener('click', (ev) => {
    const b = ev.target && ev.target.closest ? ev.target.closest('button[data-act]') : null;
    if (!b) return;
    const r = find(b.dataset.slug);
    if (!r || r.busy || bulk) return;
    const act = b.dataset.act;
    if (act === 'sync' || act === 'resync') syncRow(r, act === 'resync');
    else if (act === 'remove') { r.confirming = true; render(); }
    else if (act === 'remove-no') { r.confirming = false; render(); }
    else if (act === 'remove-yes') removeRow(r);
  });

  // Serial, never parallel: it keeps us under YouTube quota and the 1001tracklists rate limits.
  $syncAll.addEventListener('click', () => {
    if (bulk) return;
    bulk = 'sync';
    render();
    return TK.busy($syncAll, 'Syncing all…', async () => {
      try {
        for (const r of rows.slice()) {
          if (r.busy) continue;
          const out = await syncRow(r, false);
          if (out && out.reauth) break;
        }
      } finally { bulk = null; render(); }
    });
  });

  $resyncAll.addEventListener('click', async () => {
    if (bulk) return;
    bulk = 'resync';
    render();
    let out = null;
    try { out = await DJA.resyncAll($resyncAll, rows.length); } finally { bulk = null; render(); }
    if (out && out.ok) { for (const r of rows) r.state = undefined; render(); await DJA.pool(rows, 4, loadRowState); }
  });

  $fix.addEventListener('click', () => DJA.fixTitles($fix));

  $form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = ($url.value || '').trim();
    if (!url) return;
    await TK.busy($addBtn, 'Adding…', async () => {
      const res = await TK.api.post('/ui/api/add', { url });
      if (!res.ok) { TK.toast(TK.errText(res, 'add failed (' + res.status + ')'), 'bad'); return; }
      const d = res.data || {};
      const slug = d.subscription && d.subscription.slug ? d.subscription.slug : '';
      TK.toast(d.added === false ? (slug || 'that DJ') + ' is already subscribed' : 'added ' + slug, 'ok');
      $url.value = '';
      await load();
    });
  });

  function mirror() { TK.qs.set({ q: ($text.value || '').trim(), errors: $errOnly.checked ? '1' : '' }); render(); }
  $text.addEventListener('input', mirror);
  $errOnly.addEventListener('change', mirror);

  load();
})();
`

export const DJS_PAGE: UiPage = {
  path: '/djs',
  html: shell({
    nav: 'djs',
    title: 'DJs',
    description: 'Subscribed 1001tracklists DJs and the state of each one\'s playlist.',
    actions: ACTIONS,
    body: BODY,
    css: CSS,
    js: JS,
  }),
}
