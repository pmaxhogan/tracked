// Removed videos: what the playlist sweep removed (or, in a dry run, would
// remove), videos found missing from the playlists, and comparisons held back
// for approval. Data comes from the Access-gated GET /ui/api/removals.
import { shell } from '../shell'

const BODY = /* html */ `
  <div id="bar" class="tk-row rm-bar"></div>
  <div id="holds"></div>
  <div id="error" class="error" role="alert"></div>
  <div id="filters" class="rm-filters" hidden>
    <div id="chips" class="chips"></div>
    <div class="field rm-dj"><label for="dj">DJ</label><select id="dj"><option value="">All DJs</option></select></div>
  </div>
  <div id="wrap" class="tk-card tk-table-wrap" hidden>
    <table class="tk-table">
      <thead><tr><th>When</th><th>Source</th><th>Status</th><th>DJ / set</th><th>Video</th><th>Playlist</th><th>Why</th><th></th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
  <div id="empty" class="empty" hidden></div>
  <p><button id="more" type="button" class="btn" hidden>Older</button></p>
`

const CSS = /* css */ `
  .rm-bar { flex-wrap: wrap; gap: var(--sp-2); margin-bottom: var(--sp-3); }
  .rm-holds { margin-bottom: var(--sp-3); border-color: var(--danger); }
  .rm-hold { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin: var(--sp-2) 0 0; }
  .rm-filters { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--sp-3); margin-bottom: var(--sp-3); }
  .rm-filters .chips { margin-bottom: 0; }
  .rm-dj { min-width: 12rem; margin-left: auto; }
  .rm-when { color: var(--muted); font-variant-numeric: tabular-nums; }
  .rm-detail { display: block; color: var(--muted); font-size: var(--fs-xs); }
  .btn.small { padding: 5px 10px; font-size: var(--fs-sm); }
  #error:empty { display: none; }
`

const JS = /* js */ `
(() => {
  const $ = TK.$;
  const $bar = $('bar'), $holds = $('holds'), $err = $('error'), $rows = $('rows'), $wrap = $('wrap');
  const $empty = $('empty'), $more = $('more'), $filters = $('filters'), $chips = $('chips'), $dj = $('dj');
  const SOURCES = [['all', 'All'], ['sweep', 'Sweep'], ['owner', 'Owner'], ['replace', 'Replace']];
  // The data calls the owner's "remove and replace" button source 'button'.
  const SOURCE_OF = { sweep: 'sweep', owner: 'owner', replace: 'button' };
  let labels = {}, next = null, all = [];
  let source = TK.qs.get('source') || 'all';
  if (!SOURCE_OF[source]) source = 'all';
  let djSlug = TK.qs.get('dj') || '';

  function el(tag, text, cls) { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function link(href, text) {
    const a = el('a', text);
    const h = TK.safeHref(href);
    if (h) { a.href = h; a.target = '_blank'; a.rel = 'noreferrer noopener'; }
    return a;
  }
  function when(s) { try { return new Date(s * 1000).toLocaleString(); } catch (e) { return String(s); } }
  function fail(res, fallback) { $err.textContent = TK.errText(res, fallback); }

  function renderBar(d) {
    $bar.textContent = '';
    const s = d.settings || {};
    $bar.appendChild(el('span', s.dryRun ? 'DRY RUN — nothing is removed' : 'LIVE — removals are applied', 'badge ' + (s.dryRun ? 'warn' : 'bad')));
    $bar.appendChild(el('span', 'deletes today ' + (d.deletesUsedToday || 0) + ' / ' + s.dailyRemovals, 'badge neutral'));
    for (const k of Object.keys(d.counts || {})) $bar.appendChild(el('span', k.replace('_', ' ') + ': ' + d.counts[k], 'badge neutral'));
  }

  function renderHolds(holds) {
    $holds.textContent = '';
    if (!holds || !holds.length) return;
    const box = el('div', null, 'tk-card rm-holds');
    box.appendChild(el('strong', 'Held: these playlists seem to have lost too much at once. Nothing was recorded for them.'));
    for (const h of holds) {
      const p = el('p', (h.kind === 'combined' ? 'Combined playlist' : (h.slug || h.playlistId)) + ': ' + h.missing + ' of ' + h.expected + ' missing (since ' + when(h.at) + ')', 'rm-hold');
      const b = el('button', 'They really are removed — apply once', 'btn');
      b.type = 'button';
      b.addEventListener('click', async () => {
        b.disabled = true;
        const res = await TK.api.post('/ui/api/removals/holds/' + encodeURIComponent(h.playlistId) + '/approve', {});
        if (res.ok) b.textContent = 'Approved — applies at the next comparison';
        else { fail(res, 'failed (' + res.status + ')'); b.disabled = false; }
      });
      p.appendChild(b);
      box.appendChild(p);
    }
    $holds.appendChild(box);
  }

  function cell(label, cls) { const td = el('td', null, cls); td.setAttribute('data-label', label); return td; }

  function row(r) {
    const tr = document.createElement('tr');
    const w = cell('When', 'rm-when'); w.textContent = when(r.at); tr.appendChild(w);
    const src = cell('Source'); src.textContent = r.source; tr.appendChild(src);
    const st = cell('Status');
    const kind = r.status === 'would_remove' ? 'warn' : (r.status === 'undone' ? 'neutral' : 'bad');
    st.appendChild(el('span', String(r.status).replace('_', ' '), 'badge ' + kind));
    tr.appendChild(st);
    const set = cell('DJ / set');
    if (r.slug) { const a = el('a', r.slug); a.href = '/ui/dj/' + encodeURIComponent(r.slug); set.appendChild(a); }
    if (r.slug && r.set_url) set.appendChild(document.createElement('br'));
    if (r.set_url) set.appendChild(link(r.set_url, (String(r.set_url).split('/').pop() || r.set_url).replace(/\\.html$/, '')));
    tr.appendChild(set);
    const vid = cell('Video'); vid.appendChild(link('https://www.youtube.com/watch?v=' + encodeURIComponent(r.video_id), r.video_id)); tr.appendChild(vid);
    const pl = cell('Playlist'); pl.appendChild(link('https://www.youtube.com/playlist?list=' + encodeURIComponent(r.playlist_id), r.playlist_kind)); tr.appendChild(pl);
    const why = cell('Why'); why.appendChild(document.createTextNode(labels[r.reason] || r.reason));
    if (r.detail) why.appendChild(el('span', r.detail, 'rm-detail'));
    tr.appendChild(why);
    const act = cell('');
    if (r.source !== 'dead' && (r.status === 'removed' || r.status === 'recorded' || r.status === 'would_remove')) {
      const b = el('button', r.status === 'would_remove' ? 'Keep it' : 'Undo (re-add)', 'btn small');
      b.type = 'button';
      b.title = r.status === 'would_remove' ? 'Never remove this video' : 'Put the video back and never judge it again';
      b.addEventListener('click', async () => {
        b.disabled = true; $err.textContent = '';
        const res = await TK.api.post('/ui/api/removals/' + r.id + '/undo', {});
        if (res.ok) { r.status = 'undone'; render(); }
        else { fail(res, 'failed (' + res.status + ')'); b.disabled = false; }
      });
      act.appendChild(b);
    }
    tr.appendChild(act);
    return tr;
  }

  function renderChips() {
    $chips.textContent = '';
    for (const pair of SOURCES) {
      const c = el('button', pair[1], 'chip' + (source === pair[0] ? ' on' : ''));
      c.type = 'button';
      c.addEventListener('click', () => { source = pair[0]; sync(); render(); });
      $chips.appendChild(c);
    }
  }

  function renderDjs() {
    const slugs = [];
    for (const r of all) if (r.slug && slugs.indexOf(r.slug) < 0) slugs.push(r.slug);
    if (djSlug && slugs.indexOf(djSlug) < 0) slugs.push(djSlug);
    slugs.sort();
    $dj.textContent = '';
    const first = document.createElement('option'); first.value = ''; first.textContent = 'All DJs'; $dj.appendChild(first);
    for (const s of slugs) { const o = document.createElement('option'); o.value = s; o.textContent = s; $dj.appendChild(o); }
    $dj.value = djSlug;
  }

  function sync() { TK.qs.set({ source: source === 'all' ? '' : source, dj: djSlug }); }

  function render() {
    renderChips();
    $rows.textContent = '';
    const shown = all.filter((r) => (source === 'all' || r.source === SOURCE_OF[source]) && (!djSlug || r.slug === djSlug));
    for (const r of shown) $rows.appendChild(row(r));
    $wrap.hidden = !shown.length;
    $empty.hidden = !!shown.length;
    if (!shown.length) $empty.textContent = all.length ? 'Nothing matches this filter.' : 'Nothing removed yet.';
    $filters.hidden = !all.length;
  }

  async function load(more) {
    $err.textContent = '';
    const res = await TK.api.get('/ui/api/removals' + (more && next ? '?before=' + next : ''));
    if (!res.ok) { $err.textContent = 'failed to load: ' + TK.errText(res, 'failed (' + res.status + ')'); return; }
    const d = res.data || {};
    labels = d.reasonLabels || {};
    if (!more) { all = []; renderBar(d); renderHolds(d.holds); }
    all = all.concat(d.rows || []);
    next = d.next || null; $more.hidden = !next;
    renderDjs();
    render();
  }

  $dj.addEventListener('change', () => { djSlug = $dj.value; sync(); render(); });
  $more.addEventListener('click', () => TK.busy($more, 'Loading…', () => load(true)));
  for (const pair of [['compare', 'btn-compare', 'Comparing…'], ['sweep', 'btn-sweep', 'Sweeping…']]) {
    const b = $(pair[1]);
    b.addEventListener('click', () => TK.busy(b, pair[2], async () => {
      $err.textContent = '';
      const res = await TK.api.post('/ui/api/hygiene/run?what=' + pair[0], {});
      if (!res.ok) { fail(res, 'failed (' + res.status + ')'); return; }
      await load(false);
    }));
  }
  load(false);
})();
`

export const REMOVED_PAGE_HTML = shell({
  nav: 'removed',
  title: 'Removed videos',
  description: 'Videos the playlist sweep removed (or, in a dry run, would remove) for not being full recordings, and videos found missing from the playlists that the sync will never re-add.',
  actions: '<button type="button" id="btn-compare" class="btn">Compare playlists now</button><button type="button" id="btn-sweep" class="btn">Run sweep now</button>',
  body: BODY,
  css: CSS,
  js: JS,
})
