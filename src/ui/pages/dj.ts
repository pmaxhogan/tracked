// DJ profile: every tracklist we know about for one DJ, as expandable set cards
// next to a sticky summary column. The slug is read client-side from the path
// (/ui/dj/<slug>); nothing user-controlled is templated into the markup.
import { shell } from '../shell'
import type { UiPage } from './index'
import { TRACK_ROW_CSS, TRACK_ROW_JS } from './track-row'
import { DJ_ACTIONS_CSS, DJ_ACTIONS_JS } from './dj-actions'

const BODY = /* html */ `
<div class="dj-layout">
  <aside class="tk-card dj-side">
    <div class="tk-row"><span id="dj-sub" class="badge ok" hidden>subscribed</span></div>
    <p class="mono dj-slug"><span id="dj-slug"></span></p>
    <p id="counts" class="muted sub"><span class="skel" style="width:70%"></span></p>
    <p id="dj-playlist" class="sub" hidden></p>
    <p id="dj-last" class="sub" hidden></p>
    <p class="sub"><a id="dj-1001" target="_blank" rel="noreferrer noopener">1001tracklists ↗</a> · <a href="/ui/djs">All DJs</a></p>
    <div class="dj-actions">
      <button id="sync" type="button" class="btn primary" hidden>Sync</button>
      <button id="resync" type="button" class="btn danger" hidden title="Forget the cached video for every set and re-check them all">Invalidate &amp; resync</button>
      <button id="refresh" type="button" class="btn">Refresh from 1001tracklists</button>
    </div>
  </aside>
  <section class="dj-main">
    <div id="chips" class="chips" role="group" aria-label="Filter sets">
      <button type="button" class="chip on" data-f="all" aria-pressed="true">all</button>
      <button type="button" class="chip" data-f="video" aria-pressed="false">with video</button>
      <button type="button" class="chip" data-f="novideo" aria-pressed="false">no video</button>
      <button type="button" class="chip" data-f="partial" aria-pressed="false">partial ID</button>
    </div>
    <p id="filter-note" class="muted sub" hidden></p>
    <div id="error" class="err-state" role="alert" hidden></div>
    <div id="sets" class="dj-sets"></div>
    <div id="sets-skel" hidden></div>
    <div id="empty" class="empty" hidden></div>
  </section>
</div>
`

const CSS = /* css */ `
  .dj-layout { display: grid; gap: var(--sp-4); align-items: start; }
  .dj-main { min-width: 0; }
  .dj-side .sub, .dj-side p { margin: var(--sp-2) 0; font-size: var(--fs-sm); }
  .dj-slug { font-size: var(--fs-md); }
  .dj-actions { display: grid; gap: var(--sp-2); margin-top: var(--sp-3); }
  .dj-sets { display: grid; gap: var(--sp-2); align-items: start; }
  .dj-sets .set-card { margin-bottom: 0; min-width: 0; }
  .set-card > .head:hover { background: var(--elev); }
  .set-card .chev { color: var(--muted); width: 1em; transition: transform .15s; }
  .set-card.open .chev { transform: rotate(90deg); }
  .set-card .badge { text-transform: none; }
  .set-card > .body { padding-top: var(--sp-3); }
  .set-meta { color: var(--muted); font-size: var(--fs-sm); display: flex; flex-wrap: wrap; gap: 4px var(--sp-3); margin-bottom: var(--sp-3); }
  .set-links { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-3); }
  .set-card.unloaded { opacity: .75; }
  .set-card .badge.neutral { text-transform: none; }
  .retry { margin-left: var(--sp-2); }
  .warn-text { color: var(--danger); font-size: var(--fs-sm); overflow-wrap: anywhere; }
  @media (min-width: 900px) {
    .dj-layout { grid-template-columns: minmax(15rem, 19rem) minmax(0, 1fr); }
    .dj-side { position: sticky; top: var(--sp-4); }
  }
  @media (min-width: 1300px) {
    .dj-sets { grid-template-columns: 1fr 1fr; }
  }
${TRACK_ROW_CSS}
${DJ_ACTIONS_CSS}`

const JS = /* js */ `
(() => {
${TRACK_ROW_JS}
${DJ_ACTIONS_JS}
  const $ = TK.$;
  // The slug comes from the path (/ui/dj/<slug>).
  let slug = '', badSlug = false;
  try { slug = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || ''); } catch (e) { badSlug = true; }

  const $name = $('dj-name'), $sub = $('dj-sub'), $slug = $('dj-slug'), $link1001 = $('dj-1001'), $counts = $('counts');
  const $refresh = $('refresh'), $sync = $('sync'), $resync = $('resync');
  const $playlist = $('dj-playlist'), $last = $('dj-last');
  const $error = $('error'), $sets = $('sets'), $empty = $('empty'), $skel = $('sets-skel'), $chips = $('chips'), $note = $('filter-note');
  let filter = 'all';
  let subscribed = false;

  function setTitle(name) {
    if (!name) return;
    $name.textContent = name;
    const top = document.querySelector('.tk-top-title');
    if (top) top.textContent = name;
    document.title = name + ' · tracked';
  }

  // ── filter chips (client-side, over the cards that have been opened) ──
  function matches(card) {
    if (filter === 'all') return true;
    if (card.dataset.loaded !== '1') return true; // unopened cards stay visible
    if (filter === 'video') return card.dataset.video === '1';
    if (filter === 'novideo') return card.dataset.video === '0';
    return card.dataset.partial === '1';
  }
  function applyFilter() {
    let shown = 0, unloaded = 0;
    for (const card of $sets.children) {
      if (card.dataset.loaded !== '1') unloaded++;
      const ok = matches(card);
      card.hidden = !ok;
      card.classList.toggle('unloaded', card.dataset.loaded !== '1');
      if (ok) shown++;
    }
    if (filter === 'all' || !$sets.children.length) { $note.hidden = true; return; }
    $note.hidden = false;
    const hit = shown - unloaded;
    $note.textContent = hit + ' opened set' + (hit === 1 ? '' : 's') + ' match' + (hit === 1 ? 'es' : '') + (unloaded ? ' · ' + unloaded + ' not loaded yet (open a set to classify it)' : '');
  }
  $chips.addEventListener('click', (ev) => {
    const b = ev.target && ev.target.closest ? ev.target.closest('button[data-f]') : null;
    if (!b) return;
    filter = b.dataset.f;
    for (const c of $chips.querySelectorAll('button[data-f]')) {
      const on = c.dataset.f === filter;
      c.classList.toggle('on', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    applyFilter();
  });

  // ── set cards ──
  function renderSetBody(card, body, head, set, data) {
    body.textContent = '';
    const tracks = data.tracks || [];
    // "Full tracklist" = every row resolves to a known track. Rows with an
    // idStatus ("ID Remix" etc.) still point at a known base track, so only
    // fully-anonymous rows count against completeness.
    const total = tracks.length;
    const ided = tracks.filter((t) => !t.isUnidentified).length;
    const cued = tracks.filter((t) => t.startSeconds != null).length;
    const partialIds = tracks.filter((t) => t.idStatus).length;
    const full = total > 0 && ided === total;
    card.dataset.loaded = '1';
    card.dataset.video = data.setYoutubeLink ? '1' : '0';
    card.dataset.partial = full ? '0' : '1';

    // The completeness badge lives in the card head so it stays visible when collapsed.
    const old = head.querySelector('.badge'); if (old) old.remove();
    const badge = document.createElement('span');
    badge.className = 'badge ' + (full ? 'ok' : 'warn');
    badge.textContent = full ? 'full tracklist' : 'partial';
    head.insertBefore(badge, head.querySelector('.date'));

    const meta = document.createElement('div');
    meta.className = 'set-meta';
    const bits = [total + ' track' + (total === 1 ? '' : 's'), ided + '/' + total + ' IDed', cued + ' cued'];
    if (partialIds) bits.push(partialIds + ' partial ID' + (partialIds === 1 ? '' : 's'));
    for (const b of bits) { const s = document.createElement('span'); s.textContent = b; meta.appendChild(s); }
    body.appendChild(meta);

    const links = document.createElement('div');
    links.className = 'set-links';
    const l1001 = pill(set.url, '1001tracklists ↗'); if (l1001) links.appendChild(l1001);
    const lyt = pill(data.setYoutubeLink, 'YouTube', 'Watch the set on YouTube'); if (lyt) links.appendChild(lyt);
    const lsc = pill(data.setSoundcloudLink, 'SoundCloud', 'Listen to the set on SoundCloud'); if (lsc) links.appendChild(lsc);
    const lap = pill(data.setAppleLink, 'Apple Music', 'Full set on Apple Music'); if (lap) links.appendChild(lap);
    const viewer = document.createElement('a');
    viewer.className = 'pill';
    viewer.href = '/ui/set?url=' + encodeURIComponent(set.url);
    viewer.textContent = 'Open set page';
    links.appendChild(viewer);
    // Remove and replace (routes/playlist-hygiene.ts): out of both playlists now, never re-added, queued for mkvid.
    const rr = document.createElement('button');
    rr.type = 'button'; rr.className = 'btn small'; rr.textContent = 'Remove & replace video';
    rr.title = "Take this set's video out of the playlists for good and render one from its audio instead";
    rr.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!(await TK.ask("Remove this set's video from the playlists and never re-add it?", { yes: 'Remove', danger: true }))) return;
      rr.disabled = true;
      const res = await TK.api.post('/ui/api/set/remove-replace', { slug, url: set.url });
      if (!res.ok) { rr.textContent = 'Remove failed: ' + TK.errText(res, 'failed (' + res.status + ')'); rr.disabled = false; return; }
      const d = res.data || {};
      rr.textContent = 'Removed ' + d.videoId + ' — ' + d.mkvid;
    });
    links.appendChild(rr);
    const ll = document.createElement('button');
    ll.type = 'button'; ll.className = 'btn small'; ll.textContent = 'Load links';
    ll.title = 'Look up Apple Music / YouTube links for every identified track (one page view per track not cached yet)';
    const llStatus = document.createElement('span'); llStatus.className = 'muted sub';
    links.appendChild(ll); links.appendChild(llStatus);
    body.appendChild(links);

    const list = document.createElement('div');
    for (const t of tracks) list.appendChild(trackRow(t));
    body.appendChild(list);
    ll.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      ll.disabled = true;
      try { await loadAllLinks(list, llStatus); } catch (e) { llStatus.textContent = 'Links failed: ' + (e && e.message ? e.message : e); }
      finally { ll.disabled = false; }
    });
    applyFilter();
  }

  async function loadSetInto(card, body, head, set) {
    body.textContent = '';
    body.innerHTML = TK.skel(5, 'row');
    const res = await TK.api.post('/ui/api/tracklist', { url: set.url });
    if (res.ok) { renderSetBody(card, body, head, set, res.data || {}); return true; }
    body.textContent = '';
    const w = document.createElement('span');
    w.className = 'warn-text';
    w.textContent = 'failed to load: ' + TK.errText(res, 'failed (' + res.status + ')');
    body.appendChild(w);
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn small retry'; btn.textContent = 'Retry';
    btn.addEventListener('click', () => loadSetInto(card, body, head, set));
    body.appendChild(btn);
    return false;
  }

  function renderSets(sets) {
    $sets.textContent = '';
    if (!sets.length) { $empty.textContent = 'No sets found for this DJ.'; $empty.hidden = false; applyFilter(); return; }
    $empty.hidden = true;
    for (const set of sets) {
      const card = document.createElement('div');
      card.className = 'set-card';
      const head = document.createElement('div');
      head.className = 'head';
      head.tabIndex = 0;
      head.setAttribute('role', 'button');
      const chev = document.createElement('span'); chev.className = 'chev'; chev.textContent = '▸'; head.appendChild(chev);
      const title = document.createElement('span'); title.className = 'title'; title.textContent = set.title; head.appendChild(title);
      const nl = document.createElement('span'); nl.className = 'badge neutral nl'; nl.textContent = 'not loaded'; head.appendChild(nl);
      const date = document.createElement('span'); date.className = 'date'; date.textContent = set.date || ''; head.appendChild(date);
      card.appendChild(head);
      const body = document.createElement('div');
      body.className = 'body';
      body.hidden = true;
      card.appendChild(body);
      let loading = false;
      const toggle = async () => {
        body.hidden = !body.hidden;
        card.classList.toggle('open', !body.hidden);
        head.setAttribute('aria-expanded', body.hidden ? 'false' : 'true');
        if (body.hidden || card.dataset.loaded === '1' || loading) return;
        loading = true;
        await loadSetInto(card, body, head, set);
        loading = false;
      };
      head.addEventListener('click', toggle);
      head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      $sets.appendChild(card);
    }
    applyFilter();
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
          const b = document.createElement('span'); b.className = 'badge bad'; b.textContent = 'error'; b.title = String(st.lastError);
          $last.appendChild(b);
        }
        $last.hidden = false;
      }
      if (st.artistName && $name.textContent === slug) setTitle(st.artistName);
    } catch (e) { /* the page works without it */ }
  }

  async function load(refresh) {
    showError('');
    const run = async () => {
      // Skeleton cards until the first list arrives (a refresh with sets on screen keeps them).
      if (!$sets.children.length) { $empty.hidden = true; $skel.innerHTML = TK.skel(6, 'card'); $skel.hidden = false; }
      const res = await TK.api.get('/ui/api/dj/' + encodeURIComponent(slug) + (refresh ? '?refresh=1' : ''));
      $skel.hidden = true; $skel.textContent = '';
      const data = res.data || {};
      if (!res.ok) {
        showError(TK.errText(res, 'failed (' + res.status + ')'));
        $counts.textContent = $sets.children.length ? $counts.textContent : 'Could not load the sets.';
        if (!$sets.children.length) { $empty.textContent = 'Nothing to show.'; $empty.hidden = false; }
        return;
      }
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
      const partial = data.listingComplete === false ? ' found so far — listing may be incomplete (older sets are backfilled 10 a day)' : '';
      const n = (data.sets || []).length;
      $counts.textContent = n + ' set' + (n === 1 ? '' : 's') + partial + ' · ' + src;
      renderSets(data.sets || []);
    };
    if (refresh) await TK.busy($refresh, 'Refreshing…', run); else await run();
  }

  // ── Sync / Invalidate & resync: the same calls and wording as the DJs page (dj-actions) ──
  $sync.addEventListener('click', async () => { const out = await DJA.syncSlug(slug, $sync); if (out && out.ok) loadState(); });
  $resync.addEventListener('click', async () => { const out = await DJA.syncSlug(slug, $resync, { resync: true }); if (out && out.ok) loadState(); });
  $refresh.addEventListener('click', () => load(true));

  if (badSlug) {
    $counts.textContent = 'Not a valid DJ address.';
    $empty.textContent = 'Not a valid DJ address.'; $empty.hidden = false;
    $chips.hidden = true;
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
