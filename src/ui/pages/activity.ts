// Activity: one newest-first log of everything tracked did (spec "Activity
// (phase 2)"): requests, playlist additions, hygiene, mkvid, pool, sync and
// IP blocks, as a data table (TKTable, src/ui/data-table.ts) over GET
// /ui/api/activity (src/lib/activity.ts: the table contract, paged on the
// server with a real total). Kind, range and "Problems only" are preset chips;
// the Kind, Status, DJ and When columns filter from their header (several
// kinds from the Kind filter); the DJ select sets the DJ filter. The drawer
// fetches /ui/api/audit-detail or /ui/api/playlist-addition-detail for
// requests and additions and shows the row's own fields for everything else.
//
// Table state lives in the query string under `a.` (a.page, a.chip, a.f.kind,
// ...). The old links (?kind=, ?problems=1, ?dj=, ?range=) are read once and
// turned into table state. Every upstream value goes through esc.
import { shell } from '../shell'
import { tipAttr } from '../tip'
import { icon } from '../icons'
import type { UiPage } from './index'
import { ACTIVITY_DETAIL_CSS, ACTIVITY_DETAIL_JS } from './activity-detail'

const KINDS: Array<[string, string]> = [
  ['request', 'Requests'], ['playlist', 'Playlist'], ['hygiene', 'Hygiene'], ['mkvid', 'mkvid'],
  ['pool', 'Pool'], ['sync', 'Sync'], ['ban', 'IP blocks'],
]
const KIND_TIPS: Record<string, string> = {
  request: 'Now-playing lookups from your phone: which set and track it found.',
  playlist: 'Videos added to, replaced in or skipped for a playlist by the sync.',
  hygiene: 'Videos removed from playlists, or found missing from them.',
  mkvid: 'Sets queued for, rendered by and uploaded through mkvid.',
  pool: 'Events from the account pool: accounts created, flagged or retired, and captchas.',
  sync: 'DJs whose last sync ended in an error.',
  ban: 'Times 1001tracklists blocked tracked.',
}
const RANGE_TIPS: Record<string, string> = { '24h': 'The last 24 hours.', '7d': 'The last 7 days.', '30d': 'The last 30 days.', '90d': 'The last 90 days (the longest the logs are kept).' }

const KIND_ICON: Record<string, string> = {
  request: icon('play', { size: 16 }), playlist: icon('playlist', { size: 16 }), hygiene: icon('removed', { size: 16 }),
  mkvid: icon('mkvid', { size: 16 }), pool: icon('pool', { size: 16 }), sync: icon('refresh', { size: 16 }), ban: icon('ban', { size: 16 }),
}

/**
 * The activity table's columns and cells, shared by the Activity page and
 * Home: activityColumns(compact) gives the TKTable columns (When, Kind,
 * Status, Event, DJ). Assumes only TK and esc in scope.
 */
export const ACTIVITY_ROW_JS = /* js */ `
  const KIND_ICON = ${JSON.stringify(KIND_ICON)};
  const ACTIVITY_KIND_LIST = ${JSON.stringify(KINDS)};
  const ACTIVITY_OK = new Set(['ok', 'added', 'done', 'claimed', 'verified', 'challenge.solved', 'account.created', 'ended']);
  const STATUS_TIPS = {
    ok: 'It worked.', added: 'The video was added to the playlist.', duplicate: 'The video was already in the playlist.',
    replaced: 'A recheck found the set recording swapped: the old video was replaced.', no_youtube: 'The set page had no YouTube recording to add.',
    failed: 'It failed and will be tried again.', abandoned: 'Given up after repeated failures.', error: 'The last sync of this DJ ended in an error.',
    claimed: 'mkvid took this job.', done: 'Finished.', verified: 'Two fetches by different accounts agreed on the track list.',
    open: 'The block is still active.', ended: 'The block is over.', refunded: 'mkvid gave the job back without uploading, so it does not count against the daily cap.',
    pending: 'Waiting its turn.', banned: 'Excluded from mkvid.', removed: 'Taken out of the playlists.', would_remove: 'Dry run: would be removed, nothing was deleted.', recorded: 'Found missing from a playlist and noted; it is never re-added.', undone: 'You undid this.',
  };
  // The statuses the Status filter offers (the server takes any).
  const ACTIVITY_STATUSES = ['ok', 'no_video', 'no_tracklist', 'upstream_error', 'added', 'duplicate', 'replaced', 'no_youtube', 'failed', 'abandoned', 'removed', 'would_remove', 'recorded', 'undone',
    'done', 'banned', 'superseded', 'claimed', 'refunded', 'challenge.created', 'challenge.solved', 'challenge.expired', 'account.created', 'account.flagged', 'account.rested', 'account.retired', 'error', 'open', 'ended'];
  const activityTip = (r) => STATUS_TIPS[r.status] || (r.problem ? 'This event is flagged as a problem.' : '');
  function activityIso(ts) { try { return new Date(ts).toISOString(); } catch (e) { return ''; } }
  function activityStatusHtml(r) {
    const cls = r.problem ? 'bad' : ACTIVITY_OK.has(r.status) ? 'ok' : 'neutral';
    return '<span class="badge ' + cls + '"' + TK.tip(activityTip(r)) + '>' + esc(r.status || '?') + '</span>';
  }
  function activityEventHtml(r) {
    return '<span class="a-ev"><span class="a-title">' + esc(r.title || '(untitled)') + '</span>' + (r.detail ? '<span class="a-detail muted">' + esc(r.detail) + '</span>' : '') + '</span>';
  }
  function activityLinksHtml(r) {
    const links = (r.dj ? '<a class="a-link" href="/ui/dj/' + encodeURIComponent(r.dj) + '">' + esc(r.dj) + '</a>' : '') +
      (r.setUrl ? '<a class="a-link" href="/ui/set?url=' + encodeURIComponent(r.setUrl) + '">set</a>' : '');
    return links ? '<span class="a-links">' + links + '</span>' : '<span class="tkt-nil">–</span>';
  }
  function activityKindHtml(r) {
    let label = r.kind;
    for (const k of ACTIVITY_KIND_LIST) if (k[0] === r.kind) label = k[1];
    return '<span class="a-kind"><span class="a-ico">' + (KIND_ICON[r.kind] || '') + '</span><span class="a-kl">' + esc(label) + '</span></span>';
  }
  function activityWhenHtml(r) {
    const iso = activityIso(r.ts);
    return '<span class="a-when"' + TK.tip(iso) + '>' + esc(TK.fmt.rel(iso)) + '</span>';
  }
  function activityColumns(compact) {
    return [
      { key: 'ts', label: 'When', type: 'datetime', render: activityWhenHtml, width: compact ? '6.5rem' : '8rem', tip: 'When it happened. Hover a time for the exact moment.' },
      { key: 'kind', label: 'Kind', type: 'enum', options: ACTIVITY_KIND_LIST.map((k) => ({ value: k[0], label: k[1] })), render: activityKindHtml, tip: 'Where the event comes from. Filter several kinds at once from here.' },
      { key: 'status', label: 'Status', type: 'enum', options: ACTIVITY_STATUSES, render: activityStatusHtml },
      { key: 'title', label: 'Event', sortable: false, filterable: false, render: activityEventHtml },
      { key: 'dj', label: 'DJ', type: 'text', render: activityLinksHtml, hideOn: compact ? 'phone' : undefined },
    ];
  }
  const activityRowAttrs = (r) => (r.problem ? { 'data-problem': '1' } : null);
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

/** Cell styles of the activity table (Activity and Home). */
export const ACTIVITY_ROW_CSS = /* css */ `
  .a-table .tkt-table td { vertical-align: middle; }
  .a-table .tkt-table tr[data-problem] > td:first-child { box-shadow: inset 3px 0 0 var(--danger); }
  .a-kind { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); white-space: nowrap; }
  .a-ico { display: inline-flex; flex: none; }
  .a-ev { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .a-title { font-size: var(--fs-sm); overflow-wrap: break-word; }
  .a-detail { font-size: var(--fs-xs); overflow-wrap: break-word; }
  .a-when { color: var(--muted); font-size: var(--fs-xs); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .a-links { display: inline-flex; flex-wrap: wrap; gap: 4px var(--sp-2); font-size: var(--fs-xs); }
  .a-link { color: var(--accent); }
  /* Phone: each row is a card. The event takes the full width, left-aligned,
     under its label; break-word only splits a word too long for a line (an
     id, a URL), never a normal word. */
  @media (max-width: 699px) {
    .a-table .tkt-table tr[data-problem] { box-shadow: inset 3px 0 0 var(--danger); }
    .a-table .tkt-table tr[data-problem] > td:first-child { box-shadow: none; }
    .a-table .tkt-table td[data-label="Event"] { flex-direction: column; text-align: left; }
    .a-table .tkt-table td[data-label="Event"]::before { content: none; }
  }
`

const BODY = /* html */ `
<div class="a-djbar"><label for="a-dj" class="muted">DJ</label><select id="a-dj" aria-label="DJ"><option value="">All DJs</option></select></div>
<div id="a-table" class="a-table"></div>
`

export const ACTIVITY_PAGE_CSS = /* css */ `
  .a-djbar { display: flex; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-2); font-size: var(--fs-sm); min-width: 0; }
  #a-dj { font: inherit; font-size: var(--fs-sm); color: var(--fg); background: var(--page); border: 1px solid var(--line-strong); border-radius: var(--r-ctl); padding: 5px 8px; min-width: 0; max-width: 100%; }
  .a-table .tkt-presets { flex-wrap: wrap; }
${ACTIVITY_ROW_CSS}
${ACTIVITY_DETAIL_CSS}`

const JS = /* js */ `
(() => {
  const $ = TK.$, esc = TK.esc;
${ACTIVITY_DETAIL_JS}
${ACTIVITY_ROW_JS}
${ACTIVITY_DRAWER_JS}
  const KIND_TIPS = ${JSON.stringify(KIND_TIPS)};
  const RANGE_TIPS = ${JSON.stringify(RANGE_TIPS)};
  const RANGE_MS = { '24h': 86400000, '7d': 7 * 86400000, '30d': 30 * 86400000, '90d': 90 * 86400000 };
  const $dj = $('a-dj'), $refresh = $('a-refresh');
  // Range starts are rounded down to 10 minutes, so the request URL (and the
  // copy of the first page this browser stored for it) holds still for a while.
  const since = (ms) => String(Math.floor((Date.now() - ms) / 600000) * 600000);
  const known = new Set(ACTIVITY_KIND_LIST.map((k) => k[0]));

  // ── old links (?kind=, ?problems=1, ?dj=, ?range=) become table state ──
  const legacy = ['kind', 'problems', 'dj', 'range'].filter((k) => TK.qs.get(k) != null);
  if (legacy.length) {
    const kinds = (TK.qs.get('kind') || '').split(',').filter((k) => known.has(k));
    const range = Object.prototype.hasOwnProperty.call(RANGE_MS, TK.qs.get('range') || '') ? TK.qs.get('range') : '7d';
    const chips = [range].concat([kinds.length === 1 ? 'k-' + kinds[0] : 'k-all']).concat(TK.qs.get('problems') === '1' ? ['problems'] : []);
    const dj = TK.qs.get('dj') || '';
    TKTable.qs.merge({ kind: null, problems: null, dj: null, range: null, 'a.chip': chips.join(','), 'a.f.kind': kinds.length > 1 ? 'in:' + kinds.join('|') : null, 'a.f.dj': dj ? 'eq:' + dj : null });
  }

  const chips = [{ id: 'k-all', label: 'All', group: 'kind', on: true, tip: 'Every kind of event.' }]
    .concat(ACTIVITY_KIND_LIST.map((k) => ({ id: 'k-' + k[0], label: k[1], group: 'kind', tip: KIND_TIPS[k[0]], filters: [{ col: 'kind', op: 'in', value: k[0] }] })))
    .concat([{ id: 'problems', label: 'Problems only', tip: 'Only events that failed or were flagged.', filters: [{ col: 'problem', op: 'eq', value: '1' }] }])
    .concat(Object.keys(RANGE_MS).map((r) => ({ id: r, label: r, group: 'range', on: r === '7d', tip: RANGE_TIPS[r], filters: [{ col: 'ts', op: 'gte', value: since(RANGE_MS[r]) }] })));

  // The DJ select follows the table's DJ filter (set here, from a chip or from the DJ column).
  const djFilter = () => { const f = table ? table.state().filters.find((x) => x.col === 'dj' && x.op === 'eq') : null; return f ? f.value : ''; };
  const djOption = (v) => '<option value="' + esc(v) + '">' + esc(v) + '</option>';
  function syncDj() {
    const v = djFilter();
    if (v && String($dj.innerHTML || '').indexOf(djOption(v)) < 0) $dj.innerHTML += djOption(v);
    $dj.value = v;
  }
  let table = null;
  table = TKTable.create($('a-table'), {
    id: 'a',
    source: { url: '/ui/api/activity' },
    columns: activityColumns(false),
    defaultSort: '-ts',
    search: 'Search events, details, DJs',
    chips,
    rowKey: 'id',
    rowAttrs: activityRowAttrs,
    onRowClick: (r) => openActivityRow(r),
    swr: true,
    empty: 'Nothing in this range.',
    onData: () => syncDj(),
  });

  $dj.addEventListener('change', () => { const v = $dj.value || ''; table.setFilter('dj', v ? 'eq' : null, v); });
  if ($refresh) $refresh.addEventListener('click', () => TK.busy($refresh, 'Refreshing…', () => table.reload()));

  // ── the DJ select's options; a failure leaves "All DJs" ──
  async function loadDjs() {
    const res = await TK.api.get('/ui/api/list');
    const subs = res.ok && res.data && res.data.subscriptions;
    if (!Array.isArray(subs)) return;
    const slugs = subs.map((s) => s && s.slug).filter(Boolean).sort();
    const cur = djFilter();
    if (cur && slugs.indexOf(cur) < 0) slugs.unshift(cur);
    $dj.innerHTML = '<option value="">All DJs</option>' + slugs.map(djOption).join('');
    $dj.value = cur;
  }
  loadDjs();
})();
`

export const ACTIVITY_PAGE: UiPage = {
  path: '/activity',
  html: shell({
    nav: 'activity',
    title: 'Activity',
    description: 'Everything tracked did, newest first: requests, playlist additions, hygiene, mkvid, pool, sync and IP blocks.',
    actions: `<button id="a-refresh" type="button" class="btn"${tipAttr('Reloads this page of events.')}>Refresh</button>`,
    body: BODY,
    css: ACTIVITY_PAGE_CSS,
    js: JS,
  }),
}
