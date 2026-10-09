// DJs: every subscribed 1001tracklists DJ with its sync state, as a data table
// (TKTable) served by GET /ui/api/djs (lib/dj-table.ts: one D1 query, sorted,
// filtered, searched and paged on the server). Add, remove, sync one or all
// (serially), Invalidate & resync one or all (all is ONE request), and the
// "fix titles" dialog.
import { shell } from '../shell'
import type { UiPage } from './index'
import { tipAttr } from '../tip'
import { DJ_ACTIONS_CSS, DJ_ACTIONS_JS, FIX_DIALOG_HTML, FIX_TITLES_TITLE } from './dj-actions'

const ACTIONS = /* html */ `
<form id="add-form" class="dj-add">
  <input id="url" type="url" placeholder="1001tracklists DJ URL" aria-label="1001tracklists DJ URL" required />
  <button id="add-btn" type="submit" class="btn primary"${tipAttr("Subscribes to this DJ. Their sets are found over the next scheduler ticks and each one gets a video added to the DJ's YouTube playlist.")}>Add DJ</button>
</form>
<button id="sync-all" type="button" class="btn" hidden${tipAttr('Syncs every DJ one after another: looks for new sets and adds their videos. Each DJ is limited to a few fetches per press.')}>Sync all</button>
<button id="resync-all" type="button" class="btn danger" hidden${tipAttr('Marks every set of every DJ as due for a re-check and re-reads the playlists from YouTube, so swapped recordings get replaced. One shared budget of 10 fetches per press; the scheduler drains the rest over the next few ticks.')}>Invalidate &amp; resync all</button>
<button id="fix-titles" type="button" class="btn"${tipAttr(FIX_TITLES_TITLE)}>Fix titles</button>`

const BODY = /* html */ `
<div id="djs"></div>
${FIX_DIALOG_HTML}
`

const CSS = /* css */ `
  .dj-add { display: flex; gap: var(--sp-2); flex: 1 1 22rem; min-width: 0; }
  .dj-add input { flex: 1; min-width: 0; font: inherit; color: var(--fg); background: var(--page); border: 1px solid var(--line-strong); border-radius: var(--r-ctl); padding: 8px 10px; }
  .dj-who { display: block; min-width: 11rem; }
  .dj-name { font-weight: 600; }
  .dj-sub { display: block; color: var(--muted); font-size: var(--fs-xs); }
  .dj-actions { display: inline-flex; gap: var(--sp-1); justify-content: flex-end; }
  .dj-pl { white-space: nowrap; }
  .dj-confirm { display: inline-flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); justify-content: flex-end; }
  .tkt-table td .badge { text-transform: none; }
${DJ_ACTIONS_CSS}`

const JS = /* js */ `
(() => {
${DJ_ACTIONS_JS}
  const $ = TK.$, esc = TK.esc;
  const $syncAll = $('sync-all'), $resyncAll = $('resync-all'), $fix = $('fix-titles');
  const $form = $('add-form'), $url = $('url'), $addBtn = $('add-btn');

  // Per-row UI state the server does not know: busy ('sync' | 'resync' | 'remove') and the remove confirm.
  const busy = new Map(), confirming = new Set();
  let bulk = null; // 'sync' | 'resync' while a bulk action runs
  let total = 0, focused = false;

  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  function nameHtml(r) {
    const enc = esc(encodeURIComponent(r.slug));
    const open = TK.safeHref(r.sourceUrl);
    return '<span class="dj-who"><a class="dj-name" href="/ui/dj/' + enc + '">' + esc(r.name) + '</a>' +
      '<span class="dj-sub">' + (r.name !== r.slug ? esc(r.slug) + ' · ' : '') + (open ? '<a href="' + esc(open) + '" target="_blank" rel="noreferrer noopener"' + TK.tip('This DJ on 1001tracklists') + '>1001tl ↗</a>' : '') + '</span></span>';
  }
  function setsHtml(r) {
    if (!r.sets) return '<span class="tkt-nil">–</span>';
    return esc(r.processed + ' of ' + r.sets);
  }
  function pendingHtml(r) {
    if (!r.pending) return '<span class="tkt-nil">0</span>';
    return '<span class="badge info"' + TK.tip(plural(r.pending, 'set') + (r.pending === 1 ? ' is' : ' are') + ' found on the DJ page but not processed yet. The scheduler works through them a few at a time.') + '>' + r.pending + ' pending</span>';
  }
  function lastHtml(r) {
    const when = r.lastRunAt ? '<span class="tkt-when">' + esc(TK.fmt.rel(new Date(r.lastRunAt).toISOString())) + '</span>' : '<span class="muted">never synced</span>';
    return when + (r.hasError ? ' <span class="badge bad"' + TK.tip('The last sync failed: ' + r.lastError + ' (retried on a later scheduler tick)') + '>error</span>' : '');
  }
  function playlistHtml(r) {
    const href = TK.safeHref(r.playlistUrl);
    if (!href) return '<span class="tkt-nil">–</span>';
    return '<span class="dj-pl"><a href="' + esc(href) + '" target="_blank" rel="noreferrer noopener">Playlist ↗</a> <span class="muted">' + esc(plural(r.videos, 'video')) + '</span></span>';
  }
  function actionsHtml(r) {
    const slug = esc(r.slug);
    if (confirming.has(r.slug)) {
      return '<span class="dj-confirm"><span>Remove ' + slug + '?</span>' +
        '<button type="button" class="btn small danger" data-act="remove-yes">Yes, remove</button>' +
        '<button type="button" class="btn small" data-act="remove-no">Cancel</button></span>';
    }
    const b = busy.get(r.slug);
    const dis = b || bulk ? ' disabled' : '';
    return '<span class="dj-actions">' +
      '<button type="button" class="btn small" data-act="sync"' + dis + TK.tip('Looks for new sets from this DJ and adds their videos to the playlist. Limited to a few fetches per press.') + '>' + (b === 'sync' ? 'Syncing…' : 'Sync') + '</button>' +
      '<button type="button" class="btn small" data-act="resync"' + dis + TK.tip('Invalidate & resync: marks every processed set of this DJ as due for a re-check and re-reads its playlists from YouTube, so swapped recordings are replaced. Costs up to 10 fetches per press; the scheduler does the rest over later ticks.') + ' aria-label="Invalidate and resync ' + slug + '">' + (b === 'resync' ? 'Resyncing…' : 'Resync') + '</button>' +
      '<button type="button" class="btn small danger" data-act="remove"' + dis + TK.tip('Unsubscribes from this DJ. Their YouTube playlist and videos stay as they are.') + '>Remove</button></span>';
  }

  const table = TKTable.create($('djs'), {
    id: 'djs',
    source: { url: '/ui/api/djs' },
    swr: true,
    columns: [
      { key: 'name', label: 'DJ', type: 'text', render: nameHtml },
      { key: 'sets', label: 'Sets', type: 'number', render: setsHtml, tip: 'Sets processed (given a video, or found to have none) out of every set found on the DJ page.' },
      { key: 'pending', label: 'Pending', type: 'number', render: pendingHtml, tip: 'Sets found on the DJ page that the sync has not processed yet.' },
      { key: 'lastRunAt', label: 'Last sync', type: 'datetime', render: lastHtml, tip: 'When the sync last ran for this DJ, and whether it ended in an error (the Errors chip lists those).' },
      { key: 'videos', label: 'Playlist', type: 'number', render: playlistHtml, tip: 'The DJ playlist on YouTube and how many sets have a video in it.' },
      { key: 'mkvid', label: 'mkvid', type: 'number', hideOn: 'phone', tip: 'Videos mkvid rendered from a set audio because the set had no recording.' },
      { key: 'addedAt', label: 'Added', type: 'datetime', hideOn: 'phone', render: (r) => '<span class="tkt-when">' + esc(TK.fmt.date(r.addedAt / 1000)) + '</span>', tip: 'When you subscribed.' },
    ],
    defaultSort: 'name',
    search: 'Search DJs, slugs, errors',
    chips: [
      { id: 'all', label: 'All', group: 'f', on: true, count: (d) => d.counts && d.counts.total },
      { id: 'errors', label: 'Errors', group: 'f', filters: [{ col: 'hasError', op: 'eq', value: '1' }], count: (d) => d.counts && d.counts.errors, tip: 'DJs whose last sync ended in an error.' },
      { id: 'pending', label: 'Pending sets', group: 'f', filters: [{ col: 'pending', op: 'gt', value: '0' }], sort: '-pending', count: (d) => d.counts && d.counts.pending, tip: 'DJs with sets found but not processed yet.' },
      { id: 'never', label: 'Never synced', group: 'f', filters: [{ col: 'lastRunAt', op: 'empty', value: '' }], count: (d) => d.counts && d.counts.neverSynced, tip: 'DJs the sync has not run for yet.' },
    ],
    rowKey: 'slug',
    actions: actionsHtml,
    onAction: (act, r) => {
      if (busy.get(r.slug) || bulk) return;
      if (act === 'sync' || act === 'resync') syncRow(r.slug, act === 'resync');
      else if (act === 'remove') { confirming.add(r.slug); table.reload(); }
      else if (act === 'remove-no') { confirming.delete(r.slug); table.reload(); }
      else if (act === 'remove-yes') removeRow(r.slug);
    },
    onData: (d) => {
      total = d && d.counts ? d.counts.total : (d && d.total) || 0;
      paintBulk();
      // ?focus=filter: the search box is only worth focusing once there are DJs.
      if (!focused && total && TK.qs.get('focus') === 'filter') { focused = true; const q = $('djs-q'); if (q && q.focus) q.focus(); }
    },
    empty: 'No subscriptions yet.',
  });

  function paintBulk() {
    $syncAll.hidden = !total;
    $resyncAll.hidden = !total;
    // One bulk action at a time: the other bulk button waits (the pressed one is TK.busy's).
    if (bulk !== 'sync') $syncAll.disabled = !!bulk;
    if (bulk !== 'resync') $resyncAll.disabled = !!bulk;
    $fix.disabled = !!bulk;
  }

  async function syncRow(slug, resync) {
    busy.set(slug, resync ? 'resync' : 'sync');
    table.reload();
    let out = null;
    try { out = await DJA.syncSlug(slug, null, { resync }); }
    finally { busy.delete(slug); await table.reload(); }
    return out;
  }

  async function removeRow(slug) {
    confirming.delete(slug);
    busy.set(slug, 'remove');
    table.reload();
    const res = await TK.api.post('/ui/api/remove', { slug });
    busy.delete(slug);
    if (!res.ok) TK.toast(TK.errText(res, 'remove failed (' + res.status + ')'), 'bad');
    await table.reload();
  }

  // Every subscribed slug (not just this page of the table), in the order they were added.
  async function allSlugs() {
    const res = await TK.api.get('/ui/api/list');
    if (!res.ok) { TK.toast(TK.errText(res, 'could not list the DJs (' + res.status + ')'), 'bad'); return []; }
    return ((res.data && res.data.subscriptions) || []).map((s) => s.slug);
  }

  // Serial, never parallel: it keeps us under YouTube quota and the 1001tracklists rate limits.
  $syncAll.addEventListener('click', () => {
    if (bulk) return;
    bulk = 'sync';
    paintBulk();
    table.reload();
    return TK.busy($syncAll, 'Syncing all…', async () => {
      try {
        for (const slug of await allSlugs()) {
          if (busy.get(slug)) continue;
          const out = await syncRow(slug, false);
          if (out && out.reauth) break;
        }
      } finally { bulk = null; paintBulk(); table.reload(); }
    });
  });

  $resyncAll.addEventListener('click', async () => {
    if (bulk) return;
    bulk = 'resync';
    paintBulk();
    table.reload();
    try { await DJA.resyncAll($resyncAll, total); } finally { bulk = null; paintBulk(); table.reload(); }
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
      await table.reload();
    });
  });
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
