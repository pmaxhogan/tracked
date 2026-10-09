// Removed videos: what the playlist sweep removed (or, in a dry run, would
// remove), videos found missing from the playlists, and comparisons held back
// for approval. Data comes from the Access-gated GET /ui/api/removals, a
// data-table endpoint (TKTable id 'rm', lib/table-query.ts): every row is
// sorted, filtered, searched and paged on the server; the source chips and the
// DJ select are table filters over all rows. The same answer carries the
// status counts, settings, deletes today, held playlists and the DJ list.
import { shell } from '../shell'
import { tipAttr, tipTerm } from '../tip'
import { REASON_LABELS } from '../../lib/playlist-hygiene'

const BODY = /* html */ `
  <div id="bar" class="tk-row rm-bar"></div>
  <div id="holds"></div>
  <div id="error" class="error" role="alert"></div>
  <div class="rm-filters">
    <div class="field rm-dj"><label for="dj">DJ</label><select id="dj"><option value="">All DJs</option></select></div>
  </div>
  <div id="rm-table"></div>
`

const CSS = /* css */ `
  .rm-bar { flex-wrap: wrap; gap: var(--sp-2); margin-bottom: var(--sp-3); }
  .rm-holds { margin-bottom: var(--sp-3); border-color: var(--danger); }
  .rm-hold { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin: var(--sp-2) 0 0; }
  .rm-filters { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--sp-3); margin-bottom: var(--sp-2); }
  .rm-dj { min-width: 12rem; margin: 0; }
  .rm-stack { display: inline-flex; flex-direction: column; min-width: 0; overflow-wrap: anywhere; }
  @media (max-width: 699px) { .rm-stack { align-items: flex-end; text-align: right; } }
  .rm-detail { display: block; color: var(--muted); font-size: var(--fs-xs); }
  #error:empty { display: none; }
`

// The reason labels (the Why column) are known when the page is built, so the
// first paint already has them; the API sends the same map as reasonLabels.
const JS = (labels: Record<string, string>) => /* js */ `
(() => {
  const $ = TK.$, esc = TK.esc;
  const $bar = $('bar'), $holds = $('holds'), $err = $('error'), $dj = $('dj');
  const LABELS = ${JSON.stringify(labels).replace(/</g, '\\u003c')};

  const STATUS_TIPS = {
    would_remove: 'Dry run: the sweep would remove this video, but nothing was deleted.',
    removed: 'The video was taken out of the playlists.',
    recorded: 'The video was found missing from a playlist. tracked noted it and will never add it back.',
    failed: 'YouTube refused the removal. It is tried again on a later sweep.',
    undone: 'You undid this: the video was put back (or will never be judged again).',
  };
  const SOURCE_TIPS = {
    sweep: 'The automatic sweep: the video is not a full recording of the set.',
    owner: 'You removed it from the playlist by hand on YouTube.',
    dead: 'The video was deleted or made private on YouTube.',
    button: 'You used Remove & replace on the set.',
  };
  const SOURCES = [{ value: 'sweep', label: 'Sweep' }, { value: 'owner', label: 'Owner' }, { value: 'dead', label: 'Dead video' }, { value: 'button', label: 'Replace' }];
  const STATUSES = [{ value: 'would_remove', label: 'would remove' }, { value: 'removed', label: 'removed' }, { value: 'recorded', label: 'recorded' }, { value: 'failed', label: 'failed' }, { value: 'undone', label: 'undone' }];
  const REASONS = Object.keys(LABELS).map((k) => ({ value: k, label: LABELS[k] }));
  const isoOf = (s) => { try { return new Date(s * 1000).toISOString(); } catch (e) { return ''; } };
  const ext = (href, text, tip) => { const h = TK.safeHref(href); return h ? '<a href="' + esc(h) + '" target="_blank" rel="noreferrer noopener"' + TK.tip(tip) + '>' + esc(text) + '</a>' : esc(text); };
  const badge = (cls, text, tip) => '<span class="badge ' + cls + '"' + TK.tip(tip) + '>' + esc(text) + '</span>';
  const nil = '<span class="tkt-nil">–</span>';
  function fail(res, fallback) { $err.textContent = TK.errText(res, fallback); }

  // Old links (?source=sweep&dj=x) become the table's chip and DJ filter.
  const OLD_SOURCE = { sweep: 'sweep', owner: 'owner', replace: 'button', dead: 'dead' };
  const oldSource = OLD_SOURCE[TK.qs.get('source') || ''], oldDj = TK.qs.get('dj');
  if (oldSource || oldDj) TKTable.qs.merge({ source: null, dj: null, 'rm.chip': oldSource || null, 'rm.f.slug': oldDj ? 'eq:' + oldDj : null });

  function renderBar(d) {
    const s = d.settings || {};
    let h = badge(s.dryRun ? 'warn' : 'bad', s.dryRun ? 'DRY RUN: nothing is removed' : 'LIVE: removals are applied',
      s.dryRun ? 'The sweep only reports which videos it would remove; it deletes nothing from YouTube until it is switched to live.' : 'The sweep really removes videos that fail the full-recording check from the artist and combined playlists.');
    h += badge('neutral', 'deletes today ' + (d.deletesUsedToday || 0) + ' / ' + (s.dailyRemovals || 0), 'Videos the sweep has removed today, out of its daily limit. Each removal costs 50 YouTube quota units.');
    for (const k of Object.keys(d.counts || {})) h += badge('neutral', k.replace('_', ' ') + ': ' + d.counts[k], STATUS_TIPS[k] || 'Rows with this status.');
    $bar.innerHTML = h;
  }

  let holds = [];
  function renderHolds() {
    if (!holds.length) { $holds.innerHTML = ''; return; }
    $holds.innerHTML = '<div class="tk-card rm-holds"><strong>Held: these playlists seem to have lost too much at once. Nothing was recorded for them.</strong>' +
      holds.map((h, i) => '<p class="rm-hold">' + esc((h.kind === 'combined' ? 'Combined playlist' : (h.slug || h.playlistId)) + ': ' + h.missing + ' of ' + h.expected + ' missing (since ' + TK.fmt.time(isoOf(h.at)) + ')') +
        ' <button type="button" class="btn" data-hold="' + i + '"' + TK.tip('Confirms that you removed these videos on purpose. They are recorded as removed once, at the next comparison, and not re-added. Valid for 24 hours.') + '>They really are removed: apply once</button></p>').join('') + '</div>';
  }
  $holds.addEventListener('click', async (e) => {
    const b = e.target && e.target.closest ? e.target.closest('button[data-hold]') : null;
    const h = b && holds[Number(b.getAttribute('data-hold'))];
    if (!h) return;
    b.disabled = true;
    const res = await TK.api.post('/ui/api/removals/holds/' + encodeURIComponent(h.playlistId) + '/approve', {});
    if (res.ok) b.textContent = 'Approved: applies at the next comparison';
    else { fail(res, 'failed (' + res.status + ')'); b.disabled = false; }
  });

  // The DJ select mirrors the table's DJ filter (slug eq); one filtered on that has no rows stays listed.
  let table = null;
  function renderDjs(list) {
    const cur = table ? table.state().filters.find((f) => f.col === 'slug' && f.op === 'eq') : null;
    const keep = cur ? cur.value : '';
    const all = (list || []).slice();
    if (keep && all.indexOf(keep) < 0) all.push(keep);
    $dj.innerHTML = '<option value="">All DJs</option>' + all.map((s) => '<option value="' + esc(s) + '">' + esc(s) + '</option>').join('');
    $dj.value = keep;
  }
  $dj.addEventListener('change', () => { if (table) table.setFilter('slug', $dj.value ? 'eq' : null, $dj.value); });

  const undoable = (r) => r.source !== 'dead' && (r.status === 'removed' || r.status === 'recorded' || r.status === 'would_remove');
  table = TKTable.create($('rm-table'), {
    id: 'rm',
    source: { url: '/ui/api/removals' },
    swr: true,
    defaultSort: '-at',
    search: 'Search DJ, set, video or detail',
    empty: 'Nothing removed yet.',
    rowKey: 'id',
    columns: [
      { key: 'at', label: 'When', type: 'datetime', storage: 's' },
      { key: 'source', label: 'Source', type: 'enum', options: SOURCES, tip: 'What removed the video: the sweep, you on YouTube, a dead video, or the Remove & replace button.',
        render: (r) => '<span' + TK.tip(SOURCE_TIPS[r.source] || 'What removed the video.') + '>' + esc((SOURCES.find((o) => o.value === r.source) || { label: r.source }).label) + '</span>' },
      { key: 'status', label: 'Status', type: 'enum', options: STATUSES, tip: 'Whether the removal happened (removed), only would happen (would remove), was only noted (recorded), failed, or was undone.',
        render: (r) => badge(r.status === 'would_remove' ? 'warn' : r.status === 'undone' ? 'neutral' : 'bad', String(r.status).replace('_', ' '), STATUS_TIPS[r.status] || 'The state of this removal.') },
      { key: 'slug', label: 'DJ', type: 'text', render: (r) => r.slug ? '<a href="/ui/dj/' + encodeURIComponent(r.slug) + '">' + esc(r.slug) + '</a>' : nil },
      { key: 'set_url', label: 'Set', type: 'text', render: (r) => r.set_url ? '<span class="rm-stack"><a href="/ui/set?url=' + encodeURIComponent(r.set_url) + '">' + esc(TK.fmt.setLabel(r.set_url)) + '</a></span>' : nil },
      { key: 'video_id', label: 'Video', type: 'text', render: (r) => ext('https://www.youtube.com/watch?v=' + encodeURIComponent(r.video_id), r.video_id, 'Opens the video on YouTube.') },
      { key: 'playlist_kind', label: 'Playlist', type: 'enum', options: ['artist', 'combined'], hideOn: 'phone',
        render: (r) => ext('https://www.youtube.com/playlist?list=' + encodeURIComponent(r.playlist_id), r.playlist_kind, 'Opens the playlist on YouTube.') },
      { key: 'reason', label: 'Why', type: 'enum', options: REASONS,
        render: (r) => '<span class="rm-stack"><span>' + esc(LABELS[r.reason] || r.reason) + '</span>' + (r.detail ? '<span class="rm-detail">' + esc(r.detail) + '</span>' : '') + '</span>' },
    ],
    chips: [
      { id: 'all', label: 'All', group: 'source', on: true },
      { id: 'sweep', label: 'Sweep', group: 'source', filters: [{ col: 'source', op: 'in', value: 'sweep' }], tip: SOURCE_TIPS.sweep },
      { id: 'owner', label: 'Owner', group: 'source', filters: [{ col: 'source', op: 'in', value: 'owner' }], tip: SOURCE_TIPS.owner },
      { id: 'dead', label: 'Dead', group: 'source', filters: [{ col: 'source', op: 'in', value: 'dead' }], tip: SOURCE_TIPS.dead },
      { id: 'button', label: 'Replace', group: 'source', filters: [{ col: 'source', op: 'in', value: 'button' }], tip: SOURCE_TIPS.button },
    ],
    actions: (r) => undoable(r)
      ? '<button type="button" class="btn sm" data-act="undo"' + TK.tip(r.status === 'would_remove' ? 'Marks this video as an exception so the sweep never removes it.' : 'Puts the video back in the playlist and never judges it again. Costs 50 YouTube quota units.') + '>' + (r.status === 'would_remove' ? 'Keep it' : 'Undo (re-add)') + '</button>'
      : '',
    onAction: (act, r, btn) => {
      if (act !== 'undo') return;
      $err.textContent = '';
      return TK.busy(btn, 'Working…', async () => {
        const res = await TK.api.post('/ui/api/removals/' + r.id + '/undo', {});
        if (!res.ok) { fail(res, 'failed (' + res.status + ')'); return; }
        await table.reload();
      });
    },
    onData: (d) => {
      renderBar(d);
      holds = Array.isArray(d.holds) ? d.holds : [];
      renderHolds();
      renderDjs(d.djs);
    },
  });

  for (const pair of [['compare', 'btn-compare', 'Comparing…'], ['sweep', 'btn-sweep', 'Sweeping…']]) {
    const b = $(pair[1]);
    b.addEventListener('click', () => TK.busy(b, pair[2], async () => {
      $err.textContent = '';
      const res = await TK.api.post('/ui/api/hygiene/run?what=' + pair[0], {});
      if (!res.ok) { fail(res, 'failed (' + res.status + ')'); return; }
      await table.reload();
    }));
  }
})();
`

export const REMOVED_PAGE_HTML = shell({
  nav: 'removed',
  title: 'Removed videos',
  description: `Videos taken out of the playlists, and ${tipTerm('videos found missing', 'Videos you removed from a playlist by hand, or that died on YouTube. The sync notes them and never adds them back.')} that the sync will not re-add.`,
  actions: `<button type="button" id="btn-compare" class="btn"${tipAttr('Lists every playlist on YouTube now and compares it with what tracked added, to notice videos removed by hand. A playlist that lost too many videos is held for your approval.')}>Compare playlists now</button><button type="button" id="btn-sweep" class="btn"${tipAttr('Judges every video the sync added against the full-recording rule now. In a dry run it only reports; when live it removes the failures, within the daily limit.')}>Run sweep now</button>`,
  body: BODY,
  css: CSS,
  js: JS(REASON_LABELS),
})
