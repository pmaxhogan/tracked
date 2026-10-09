// DJ profile: every tracklist we know about for one DJ, as a data table (TKTable,
// local mode over GET /ui/api/dj/:slug, whose sets carry what D1 knows: video,
// track and ID counts) next to a sticky summary column. A row expands into the
// set's links and its track list (track-row.ts, with Pre-save). The slug is
// read client-side from the path (/ui/dj/<slug>); nothing user-controlled is
// templated into the markup.
import { shell } from '../shell'
import { tipAttr } from '../tip'
import type { UiPage } from './index'
import { TRACK_ROW_CSS, TRACK_ROW_JS } from './track-row'
import { DJ_ACTIONS_CSS, DJ_ACTIONS_JS } from './dj-actions'

const BODY = /* html */ `
<div class="dj-layout">
  <aside class="tk-card dj-side">
    <div class="tk-row"><span id="dj-sub" class="badge ok" hidden${tipAttr('You are subscribed: the sync keeps this DJ\'s playlist up to date with their sets.')}>subscribed</span></div>
    <p class="mono dj-slug"><span id="dj-slug"></span></p>
    <p id="counts" class="muted sub"><span class="skel" style="width:70%"></span></p>
    <p id="dj-playlist" class="sub" hidden></p>
    <p id="dj-last" class="sub" hidden></p>
    <p class="sub"><a id="dj-1001" target="_blank" rel="noreferrer noopener">1001tracklists ↗</a> · <a href="/ui/djs">All DJs</a></p>
    <div class="dj-actions">
      <button id="sync" type="button" class="btn primary" hidden${tipAttr('Looks for new sets from this DJ and adds their videos to the playlist. Limited to a few fetches per press.')}>Sync</button>
      <button id="resync" type="button" class="btn danger" hidden${tipAttr('Marks every processed set of this DJ as due for a re-check and re-reads its playlists from YouTube, so swapped recordings are replaced. Costs up to 10 fetches per press; the scheduler does the rest over later ticks.')}>Invalidate &amp; resync</button>
      <button id="refresh" type="button" class="btn"${tipAttr('Crawls this DJ\'s page on 1001tracklists again to list the newest sets. Does not change the playlist.')}>Refresh from 1001tracklists</button>
    </div>
  </aside>
  <section class="dj-main">
    <div id="error" class="err-state" role="alert" hidden></div>
    <div id="sets-skel" hidden></div>
    <div id="sets" class="dj-sets-t"></div>
  </section>
</div>
`

const CSS = /* css */ `
  .dj-layout { display: grid; gap: var(--sp-4); align-items: start; }
  .dj-main { min-width: 0; }
  .dj-side .sub, .dj-side p { margin: var(--sp-2) 0; font-size: var(--fs-sm); }
  .dj-slug { font-size: var(--fs-md); }
  .dj-actions { display: grid; gap: var(--sp-2); margin-top: var(--sp-3); }
  .dj-sets-t .tkt-acts .btn { white-space: nowrap; }
  .dj-set-title { font-weight: 600; overflow-wrap: anywhere; }
  .dj-set-sub { display: block; color: var(--subtle); font-size: var(--fs-xs); }
  .dj-detail > td { padding: var(--sp-3) var(--sp-3) var(--sp-4); background: color-mix(in srgb, var(--elev) 35%, transparent); }
  tr[data-open] > td { border-bottom-color: transparent; }
  .set-meta { color: var(--muted); font-size: var(--fs-sm); display: flex; flex-wrap: wrap; gap: 4px var(--sp-3); margin-bottom: var(--sp-3); }
  .set-links { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-3); }
  .retry { margin-left: var(--sp-2); }
  .warn-text { color: var(--danger); font-size: var(--fs-sm); overflow-wrap: anywhere; }
  @media (max-width: 699px) {
    .dj-detail { display: block; }
    .dj-detail > td { display: block; padding: var(--sp-2) 0; background: none; }
    .dj-detail > td::before { content: none; }
  }
  @media (min-width: 900px) {
    .dj-layout { grid-template-columns: minmax(15rem, 19rem) minmax(0, 1fr); }
    .dj-side { position: sticky; top: var(--sp-4); }
  }
${TRACK_ROW_CSS}
${DJ_ACTIONS_CSS}`

const JS = /* js */ `
(() => {
${TRACK_ROW_JS}
${DJ_ACTIONS_JS}
  const $ = TK.$, esc = TK.esc;
  // The slug comes from the path (/ui/dj/<slug>).
  let slug = '', badSlug = false;
  try { slug = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || ''); } catch (e) { badSlug = true; }

  const $name = $('dj-name'), $sub = $('dj-sub'), $slug = $('dj-slug'), $link1001 = $('dj-1001'), $counts = $('counts');
  const $refresh = $('refresh'), $sync = $('sync'), $resync = $('resync');
  const $playlist = $('dj-playlist'), $last = $('dj-last');
  const $error = $('error'), $setsHost = $('sets'), $skel = $('sets-skel');
  let subscribed = false;

  function setTitle(name) {
    if (!name) return;
    $name.textContent = name;
    const top = document.querySelector('.tk-top-title');
    if (top) top.textContent = name;
    document.title = name + ' · tracked';
  }

  // ── the set table (TKTable, local mode over the merged crawl + sync list) ──
  // One row per set: { url, title, date, video, trackCount, idedCount, complete, sync }. video and the
  // counts come from D1 (the sync's last page fetch) and are replaced by the live list once a set is opened.
  let sets = [];
  const open = new Set();      // urls of expanded rows
  const details = new Map();   // url -> { tr, td, loaded, loading }
  let nested = 0;
  function completeOf(total, ided) { return total > 0 ? (ided >= total ? 'full' : 'partial') : null; }
  function rowOf(s) {
    const f = s.facts || {};
    const total = f.trackCount != null ? f.trackCount : null, ided = f.idedCount != null ? f.idedCount : null;
    return {
      url: s.url, title: s.title || s.url, date: s.date || null, tlSlug: s.tlSlug || null,
      video: f.video || null, videoId: f.videoId || null,
      trackCount: total, idedCount: ided, complete: total != null && ided != null ? completeOf(total, ided) : null,
      sync: f.tracked ? (f.abandoned ? 'abandoned' : f.processed ? 'done' : 'pending') : null,
    };
  }
  const VIDEO = [{ value: 'page', label: 'Video' }, { value: 'mkvid', label: 'mkvid' }, { value: 'none', label: 'No video' }];
  const COMPLETE = [{ value: 'full', label: 'Full' }, { value: 'partial', label: 'Partial' }];
  const SYNC = [{ value: 'done', label: 'Processed' }, { value: 'pending', label: 'Pending' }, { value: 'abandoned', label: 'Abandoned' }];
  function videoHtml(r) {
    if (r.video === 'page') return '<span class="badge ok"' + TK.tip('1001tracklists links a YouTube recording of this set.') + '>video</span>';
    if (r.video === 'mkvid') return '<span class="badge info"' + TK.tip('No recording on 1001tracklists: mkvid rendered a video from the set audio.') + '>mkvid</span>';
    if (r.video === 'none') return '<span class="badge neutral"' + TK.tip('1001tracklists had no YouTube recording when the set page was last read.') + '>no video</span>';
    return '<span class="tkt-nil"' + TK.tip('Not known yet: the set page has not been read. Open the set to load it.') + '>?</span>';
  }
  function completeHtml(r) {
    if (r.complete == null) return '<span class="tkt-nil">–</span>';
    const full = r.complete === 'full';
    return '<span class="badge ' + (full ? 'ok' : 'warn') + '"' + TK.tip(full ? 'Every track in this set is identified.' : 'Some tracks in this set are still unidentified (' + (r.trackCount - r.idedCount) + ' of ' + r.trackCount + ').') + '>' + (full ? 'full' : 'partial') + '</span>';
  }
  const COLS = [
    { key: 'date', label: 'Date', type: 'date', width: '7.5rem' },
    { key: 'title', label: 'Set', type: 'text', render: (r) => '<span class="dj-set-title">' + esc(r.title) + '</span>' + (r.tlSlug ? '<span class="dj-set-sub mono">' + esc(r.tlSlug) + '</span>' : '') },
    { key: 'video', label: 'Video', type: 'enum', options: VIDEO, render: videoHtml, tip: 'Whether the set has a YouTube video: linked on 1001tracklists, or rendered by mkvid.' },
    { key: 'trackCount', label: 'Tracks', type: 'number', render: (r) => r.trackCount == null ? '<span class="tkt-nil">–</span>' : esc((r.idedCount != null ? r.idedCount + '/' : '') + r.trackCount), tip: 'Identified tracks out of all rows, from the last time the set page was read.' },
    { key: 'complete', label: 'IDs', type: 'enum', options: COMPLETE, render: completeHtml, tip: 'Full: every track identified. Partial: some rows are still ID.' },
    { key: 'sync', label: 'Sync', type: 'enum', options: SYNC, hideOn: 'phone', tip: 'Where the set is in the sync: processed (resolved, with or without a video), pending, or abandoned after repeated failures. Empty: the sync does not track it.' },
  ];
  let table = null;
  function makeTable() {
    table = TKTable.create($setsHost, {
      id: 'st',
      source: { rows: () => sets },
      columns: COLS,
      defaultSort: '-date',
      search: 'Search sets',
      chips: [
        { id: 'all', label: 'All', group: 'v', on: true, tip: 'Every set.' },
        { id: 'video', label: 'With video', group: 'v', filters: [{ col: 'video', op: 'in', value: 'page|mkvid' }], count: () => sets.filter((r) => r.video === 'page' || r.video === 'mkvid').length, tip: 'Sets with a YouTube video: linked on 1001tracklists or rendered by mkvid.' },
        { id: 'novideo', label: 'No video', group: 'v', filters: [{ col: 'video', op: 'in', value: 'none' }], count: () => sets.filter((r) => r.video === 'none').length, tip: 'Sets whose page had no YouTube recording when last read.' },
        { id: 'partial', label: 'Partial ID', group: 'v', filters: [{ col: 'complete', op: 'in', value: 'partial' }], count: () => sets.filter((r) => r.complete === 'partial').length, tip: 'Sets where at least one track is still unidentified.' },
        { id: 'unknown', label: 'Not read yet', group: 'v', filters: [{ col: 'video', op: 'empty', value: '' }], count: () => sets.filter((r) => !r.video).length, tip: 'Sets whose page has not been read yet: open one to load it.' },
      ],
      rowKey: 'url',
      rowAttrs: (r) => (open.has(r.url) ? { 'data-open': '1', 'aria-expanded': 'true' } : { 'aria-expanded': 'false' }),
      onRowClick: (r) => toggle(r),
      actions: (r) => '<button type="button" class="btn small" data-act="toggle"' + TK.tip('Shows this set: its links and track list (loaded from cache, or one 1001tracklists page view).') + '>' + (open.has(r.url) ? 'Hide' : 'Tracks') + '</button>',
      onAction: (act, r) => { if (act === 'toggle') toggle(r); },
      onData: () => placeDetails(),
      empty: 'No sets found for this DJ.',
    });
  }

  // ── expanded rows: a detail row after the set's row, kept across repaints ──
  const findRow = (url) => {
    const body = $('st-body');
    if (!body || !body.children) return null;
    for (const tr of body.children) if (tr.getAttribute && tr.getAttribute('data-key') === url) return tr;
    return null;
  };
  function placeDetails() {
    for (const url of open) {
      const d = details.get(url);
      const tr = findRow(url);
      if (!d || !tr || typeof tr.after !== 'function') continue;
      d.td.colSpan = COLS.length + 1;
      tr.after(d.tr);
    }
  }
  function detailFor(r) {
    let d = details.get(r.url);
    if (d) return d;
    const tr = document.createElement('tr');
    tr.className = 'dj-detail';
    const td = document.createElement('td');
    td.colSpan = COLS.length + 1;
    tr.appendChild(td);
    // The nested track table's own clicks must not reach the set table around it.
    for (const t of ['click', 'input', 'change', 'keydown']) td.addEventListener(t, (ev) => { if (ev.stopPropagation) ev.stopPropagation(); });
    d = { tr, td, loaded: false, loading: false, tt: null };
    details.set(r.url, d);
    return d;
  }
  async function toggle(r) {
    if (open.has(r.url)) {
      open.delete(r.url);
      const d = details.get(r.url);
      if (d && d.tr.remove) d.tr.remove();
      table.reload();
      return;
    }
    open.add(r.url);
    const d = detailFor(r);
    table.reload();
    if (!d.loaded && !d.loading) await loadSetInto(r, d);
  }

  function updateFromList(r, data) {
    const rows = TRK.rowsOf(data);
    const total = rows.length;
    const ided = rows.filter((x) => !x.anonymous && !x.isUnidentified).length;
    r.trackCount = total; r.idedCount = ided; r.complete = completeOf(total, ided);
    if (data.setYoutubeLink) r.video = 'page';
    else if (r.video !== 'mkvid') r.video = 'none';
    return { total, ided, cued: rows.filter((x) => x.cueSeconds != null).length, partialIds: rows.filter((x) => x.idStatus).length };
  }

  function renderSetBody(r, d, data) {
    const body = d.td;
    body.textContent = '';
    const n = updateFromList(r, data);
    const meta = document.createElement('div');
    meta.className = 'set-meta';
    const bits = [n.total + ' track' + (n.total === 1 ? '' : 's'), n.ided + '/' + n.total + ' IDed', n.cued + ' cued'];
    if (n.partialIds) bits.push(n.partialIds + ' partial ID' + (n.partialIds === 1 ? '' : 's'));
    for (const b of bits) { const s = document.createElement('span'); s.textContent = b; meta.appendChild(s); }
    body.appendChild(meta);

    const links = document.createElement('div');
    links.className = 'set-links';
    const l1001 = pill(r.url, '1001tracklists ↗'); if (l1001) links.appendChild(l1001);
    const lyt = pill(data.setYoutubeLink, 'YouTube', 'Watch the whole set on YouTube'); if (lyt) links.appendChild(lyt);
    const lsc = pill(data.setSoundcloudLink, 'SoundCloud', 'Listen to the whole set on SoundCloud'); if (lsc) links.appendChild(lsc);
    const lap = pill(data.setAppleLink, 'Apple Music', 'The whole set on Apple Music'); if (lap) links.appendChild(lap);
    const viewer = document.createElement('a');
    viewer.className = 'pill';
    viewer.href = '/ui/set?url=' + encodeURIComponent(r.url);
    viewer.textContent = 'Open set page';
    viewer.setAttribute('data-tip', 'Opens this set in the tracked viewer, with its track list and diagnostics.');
    links.appendChild(viewer);
    // Remove and replace (routes/playlist-hygiene.ts): out of both playlists now, never re-added, queued for mkvid.
    const rr = document.createElement('button');
    rr.type = 'button'; rr.className = 'btn small'; rr.textContent = 'Remove & replace video';
    rr.setAttribute('data-tip', 'Takes this set\\'s video out of the artist and combined playlists for good (it is never re-added) and queues the set for an mkvid render from its audio instead.');
    rr.addEventListener('click', async () => {
      if (!(await TK.ask("Remove this set's video from the playlists and never re-add it?", { yes: 'Remove', danger: true }))) return;
      rr.disabled = true;
      const res = await TK.api.post('/ui/api/set/remove-replace', { slug, url: r.url });
      if (!res.ok) { rr.textContent = 'Remove failed: ' + TK.errText(res, 'failed (' + res.status + ')'); rr.disabled = false; return; }
      const dd = res.data || {};
      rr.textContent = 'Removed ' + dd.videoId + ' · ' + dd.mkvid;
    });
    links.appendChild(rr);
    const ll = document.createElement('button');
    ll.type = 'button'; ll.className = 'btn small'; ll.textContent = 'Load links';
    ll.setAttribute('data-tip', 'Looks up Apple Music and YouTube links for every identified track. Costs one 1001tracklists page view per track not already cached (cached for 30 days).');
    const llStatus = document.createElement('span'); llStatus.className = 'muted sub';
    links.appendChild(ll); links.appendChild(llStatus);
    body.appendChild(links);

    const host = document.createElement('div');
    host.className = 'trt';
    body.appendChild(host);
    d.tt = TRK.create(host, { id: 'dt' + (++nested), urlState: false, setUrl: data.tracklistUrl || r.url, djSlug: slug, data });
    ll.addEventListener('click', async () => {
      ll.disabled = true;
      try { await d.tt.loadAllLinks(llStatus); } catch (e) { llStatus.textContent = 'Links failed: ' + (e && e.message ? e.message : e); }
      finally { ll.disabled = false; }
    });
    d.loaded = true;
    table.reload();
  }

  async function loadSetInto(r, d) {
    d.loading = true;
    d.td.innerHTML = TK.skel(5, 'row');
    const res = await TK.api.post('/ui/api/tracklist', { url: r.url });
    d.loading = false;
    if (res.ok) { renderSetBody(r, d, res.data || {}); return true; }
    d.td.textContent = '';
    const w = document.createElement('span');
    w.className = 'warn-text';
    w.textContent = 'failed to load: ' + TK.errText(res, 'failed (' + res.status + ')');
    d.td.appendChild(w);
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn small retry'; btn.textContent = 'Retry';
    btn.addEventListener('click', () => loadSetInto(r, d));
    d.td.appendChild(btn);
    return false;
  }

  function fmtWhen(epoch) {
    if (!epoch) return '';
    try { return new Date(epoch * 1000).toLocaleString(); } catch (e) { return ''; }
  }

  function showError(msg) {
    $error.textContent = '';
    if (!msg) { $error.hidden = true; return; }
    const g = document.createElement('span'); g.className = 'grow'; g.textContent = msg; $error.appendChild(g);
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn small'; b.textContent = 'Retry';
    b.addEventListener('click', () => load(false));
    $error.appendChild(b);
    $error.hidden = false;
  }

  // Playlist link and last sync from the sync state. Independent of the crawl: a failure leaves the lines hidden.
  async function loadState() {
    try {
      const res = await TK.api.get('/ui/api/state/' + encodeURIComponent(slug));
      const st = res.ok && res.data ? res.data.state : null;
      if (!st) return;
      const href = st.playlistId ? TK.safeHref('https://www.youtube.com/playlist?list=' + encodeURIComponent(st.playlistId)) : null;
      if (href) {
        $playlist.textContent = '';
        const a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noreferrer noopener'; a.textContent = 'Playlist on YouTube ↗';
        $playlist.appendChild(a);
        $playlist.hidden = false;
      }
      if (st.lastRunAt) {
        $last.textContent = 'Last sync ' + TK.fmt.rel(new Date(st.lastRunAt * 1000).toISOString()) + ' ';
        if (st.lastError) {
          const b = document.createElement('span'); b.className = 'badge bad'; b.textContent = 'error'; b.setAttribute('data-tip', 'The last sync failed: ' + String(st.lastError) + ' (retried on a later scheduler tick)');
          $last.appendChild(b);
        }
        $last.hidden = false;
      }
      if (st.artistName && $name.textContent === slug) setTitle(st.artistName);
    } catch (e) { /* the page works without it */ }
  }

  // A revalidated answer keeps what the page learned from sets opened meanwhile.
  function applySets(res) {
    $skel.hidden = true; $skel.textContent = '';
    const data = res.data || {};
    if (!res.ok) {
      showError(TK.errText(res, 'failed (' + res.status + ')'));
      if (!sets.length) $counts.textContent = 'Could not load the sets.';
      if (!table) makeTable();
      return;
    }
    showError('');
    setTitle(data.artistName || slug);
    subscribed = !!data.subscribed;
    $sub.hidden = !subscribed;
    $sync.hidden = !subscribed;
    $resync.hidden = !subscribed;
    // 'refreshing': the server answered from the sync state and is crawling in the background (next view has it).
    const src = data.source === 'state'
      ? (data.stopReason === 'refreshing' ? 'from sync state · refreshing from 1001tracklists' : 'from sync state (crawl unavailable)')
      : 'crawled ' + fmtWhen(data.crawledAt);
    // Until the daily backfill reaches the end of the DJ's list, the count is
    // "sets found so far", not the DJ's total on 1001tracklists.
    const partial = data.listingComplete === false ? ' found so far · listing may be incomplete (older sets are backfilled 10 a day)' : '';
    const list = Array.isArray(data.sets) ? data.sets : [];
    $counts.textContent = list.length + ' set' + (list.length === 1 ? '' : 's') + partial + ' · ' + src;
    const prev = new Map(sets.map((r) => [r.url, r]));
    sets = list.map((s) => {
      const r = rowOf(s), old = prev.get(s.url), d = details.get(s.url);
      // A set opened on this page view knows its live list: keep that over the stored facts.
      if (old && d && d.loaded) { r.video = old.video; r.trackCount = old.trackCount; r.idedCount = old.idedCount; r.complete = old.complete; }
      return r;
    });
    if (!table) makeTable(); else table.reload();
  }

  async function load(refresh) {
    showError('');
    const path = '/ui/api/dj/' + encodeURIComponent(slug);
    // Skeleton rows until the first list arrives (a refresh with sets on screen keeps them).
    const skel = () => { if (!sets.length) { $skel.innerHTML = TK.skel(6, 'row'); $skel.hidden = false; } };
    if (refresh) {
      await TK.busy($refresh, 'Refreshing…', async () => { skel(); applySets(await TK.api.get(path + '?refresh=1')); });
      return;
    }
    skel();
    // The list this browser saw last paints at once; the live one replaces it.
    await TK.api.swr(path, applySets);
  }

  // ── Sync / Invalidate & resync: the same calls and wording as the DJs page (dj-actions) ──
  $sync.addEventListener('click', async () => { const out = await DJA.syncSlug(slug, $sync); if (out && out.ok) loadState(); });
  $resync.addEventListener('click', async () => { const out = await DJA.syncSlug(slug, $resync, { resync: true }); if (out && out.ok) loadState(); });
  $refresh.addEventListener('click', () => load(true));

  if (badSlug) {
    $counts.textContent = 'Not a valid DJ address.';
    $setsHost.innerHTML = '<div class="empty">Not a valid DJ address.</div>';
    return;
  }
  $slug.textContent = slug;
  $link1001.href = 'https://www.1001tracklists.com/dj/' + encodeURIComponent(slug) + '/index.html';
  $name.textContent = slug;
  loadState();
  load(false);
})();
`

export const DJ_PAGE: UiPage = {
  path: '/dj/:slug',
  html: shell({
    nav: 'djs',
    title: 'DJ',
    h1Id: 'dj-name',
    body: BODY,
    css: CSS,
    js: JS,
  }),
}
