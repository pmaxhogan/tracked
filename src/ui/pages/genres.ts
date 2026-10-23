// Genres: one YouTube playlist per 1001tracklists genre (lib/genre-playlists.ts).
//   /ui/genres        every genre of the followed DJs' sets, a TKTable over
//                     GET /ui/api/genres (local rows), each row links to its page.
//   /ui/genres/<key>  one genre: its playlist (YouTube and YouTube Music), status,
//                     Backfill now / on / off / automatic / Refresh, and its sets.
// The key is read client-side from the path; nothing user-controlled is
// templated into the markup.
import { shell } from "../shell";
import { tipTerm } from "../tip";
import type { UiPage } from "./index";

/** Shared by both pages: status badges (red only when the owner must act: connect YouTube). */
const COMMON_JS = /* js */ `
  const GN_TONE = { synced: 'ok', pending: 'info', not_created: 'info', held: 'warn', below_min: 'neutral', off: 'neutral', not_connected: 'bad' };
  const GN_LABEL = { synced: 'synced', pending: 'pending', not_created: 'not created yet', held: 'quota held', below_min: 'below minimum', off: 'off', not_connected: 'not connected' };
  function gnBadge(r) {
    return '<span class="badge ' + (GN_TONE[r.status] || 'neutral') + '"' + TK.tip(r.statusText || '') + '>' + TK.esc(GN_LABEL[r.status] || r.status) + '</span>';
  }
  function gnExt(href, text, tip) {
    const h = TK.safeHref(href);
    return h ? '<a href="' + TK.esc(h) + '" target="_blank" rel="noreferrer noopener"' + (tip ? TK.tip(tip) : '') + '>' + TK.esc(text) + '</a>' : '';
  }
  function gnLinks(r) {
    if (!r.playlistId) return '<span class="tkt-nil">-</span>';
    return gnExt(r.playlistUrl, 'YouTube', 'Opens the playlist on YouTube.') + ' \\u00b7 ' + gnExt(r.musicUrl, 'YouTube Music', 'Opens the playlist in YouTube Music.');
  }
`;

const LIST_BODY = /* html */ `
  <div id="gn-bar" class="tk-row gn-bar"></div>
  <div id="error" class="error" role="alert"></div>
  <div id="gn-table"></div>
`;

const CSS = /* css */ `
  .gn-bar { flex-wrap: wrap; gap: var(--sp-2); margin-bottom: var(--sp-3); font-size: var(--fs-sm); }
  #error:empty { display: none; }
  .gn-name { font-weight: 600; }
  .gn-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); }
  .gn-head h2 { margin: 0; }
  .gn-facts { color: var(--muted); font-size: var(--fs-sm); margin-top: var(--sp-2); overflow-wrap: anywhere; }
  .gn-actions { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin-top: var(--sp-3); }
  .gn-card { margin-bottom: var(--sp-3); }
  .gn-err { display: block; color: var(--muted); font-size: var(--fs-xs); overflow-wrap: anywhere; }
`;

const LIST_JS = /* js */ `
(() => {
${COMMON_JS}
  const $ = TK.$, esc = TK.esc;
  const $bar = $('gn-bar'), $err = $('error');
  let rows = [];
  let table = null;

  function renderBar(d) {
    const s = d.settings || {};
    const withPl = rows.filter((r) => r.playlistId).length;
    const pending = rows.reduce((n, r) => n + (r.enabled ? r.pending : 0), 0);
    $bar.innerHTML =
      '<span class="badge neutral"' + TK.tip('Genres the followed DJs\\' sets carry on 1001tracklists.') + '>' + rows.length + ' genres</span>' +
      '<span class="badge ' + (withPl ? 'ok' : 'neutral') + '"' + TK.tip('Genres with their own YouTube playlist.') + '>' + withPl + ' playlists</span>' +
      (pending ? '<span class="badge info"' + TK.tip('Videos still to add across the genre playlists that are on; a few go in every scheduler tick, within the Genre playlists quota.') + '>' + pending + ' to add</span>' : '') +
      (d.connected === false ? '<span class="badge bad"' + TK.tip('Connect a YouTube account on the Playlists page.') + '>YouTube not connected</span>' : '') +
      '<span class="muted">' + (s.auto ? 'A genre gets its playlist at ' + esc(s.minSets) + ' sets with a video.' : 'Automatic genre playlists are off: switch genres on one by one.') + ' <a href="/ui/settings#sf-genres">Settings</a> \\u00b7 <a href="/ui/quota">Quota</a></span>';
  }

  async function load() {
    const res = await TK.api.get('/ui/api/genres');
    if (!res.ok) { $err.textContent = TK.errText(res, 'failed (' + res.status + ')'); return; }
    $err.textContent = '';
    rows = (res.data && res.data.rows) || [];
    renderBar(res.data || {});
    if (table) { table.setRows(rows); return; }
    table = TKTable.create($('gn-table'), {
      id: 'gn',
      source: { rows: () => rows },
      defaultSort: '-videos',
      search: 'Search genres',
      rowKey: 'key',
      empty: 'No genres yet. They fill in as set pages are read.',
      chips: [
        { id: 'all', label: 'All', group: 's', on: true },
        { id: 'pl', label: 'With playlist', group: 's', filters: [{ col: 'enabled', op: 'eq', value: '1' }], count: () => rows.filter((r) => r.enabled).length, tip: 'Genres whose playlist is kept filled.' },
        { id: 'below', label: 'Below minimum', group: 's', filters: [{ col: 'status', op: 'in', value: 'below_min' }], count: () => rows.filter((r) => r.status === 'below_min').length, tip: 'Genres with too few sets for a playlist of their own yet.' },
        { id: 'off', label: 'Off', group: 's', filters: [{ col: 'status', op: 'in', value: 'off' }], count: () => rows.filter((r) => r.status === 'off').length, tip: 'Genres you switched off.' },
      ],
      columns: [
        { key: 'name', label: 'Genre', type: 'text',
          render: (r) => '<a class="gn-name" href="/ui/genres/' + encodeURIComponent(r.key) + '">' + esc(r.name) + '</a>' },
        { key: 'status', label: 'Status', type: 'enum', width: '9rem',
          options: Object.keys(GN_LABEL).map((k) => ({ value: k, label: GN_LABEL[k] })),
          render: (r) => gnBadge(r) },
        { key: 'enabled', label: 'On', type: 'bool', width: '4rem', hideOn: 'phone',
          render: (r) => esc(r.enabled ? (r.choice === null ? 'auto' : 'on') : (r.choice === false ? 'off' : '-')),
          tip: 'Whether the genre has a playlist that is kept filled: auto (by the minimum), on or off (your choice).' },
        { key: 'videos', label: 'Sets', type: 'number', width: '5rem',
          tip: 'Sets of this genre with a video in a DJ playlist: what the genre playlist holds when full.' },
        { key: 'inPlaylist', label: 'In playlist', type: 'number', width: '6rem' },
        { key: 'pending', label: 'To add', type: 'number', width: '5rem' },
        { key: 'sets', label: 'All sets', type: 'number', width: '5rem', hideOn: 'phone',
          tip: 'Every followed set with this genre, with a video or not.' },
        { key: 'links', label: 'Playlist', type: 'text', sortable: false, filterable: false, searchable: false, hideOn: 'phone',
          render: (r) => gnLinks(r) },
      ],
    });
  }
  load();
})();
`;

const GENRE_BODY = /* html */ `
  <div id="error" class="error" role="alert"></div>
  <div id="gn-card" class="tk-card gn-card"><span class="muted">Loading...</span></div>
  <div id="gn-sets"></div>
`;

const GENRE_JS = /* js */ `
(() => {
${COMMON_JS}
  const $ = TK.$, esc = TK.esc;
  const $err = $('error'), $card = $('gn-card');
  const key = decodeURIComponent((location.pathname.split('/')[3] || ''));
  let sets = [];
  let table = null;
  const STATE = {
    in: ['ok', 'in playlist'], pending: ['info', 'to add'], leaving: ['info', 'to take out'], failed: ['warn', 'insert failed'],
    unavailable: ['neutral', 'unavailable'], removed: ['neutral', 'removed by you'],
    not_in_dj_playlist: ['neutral', 'not in a DJ playlist'], no_video: ['neutral', 'no video'],
  };
  const STATE_TIP = {
    in: 'The video is in this genre playlist.',
    pending: 'Goes in on a coming run (a few every scheduler tick).',
    leaving: 'In the playlist, but its video is no longer in a DJ playlist: taken out on a coming run, and put back if it returns there.',
    failed: 'An insert failed three times; it is left alone.',
    unavailable: 'YouTube refuses to insert the video (deleted or private).',
    removed: 'It was in the playlist and you took it out on YouTube: never put back.',
    not_in_dj_playlist: 'The set has a video, but it is not in a DJ playlist (yet), so it is not added here.',
    no_video: 'The set has no YouTube video.',
  };

  function render(d) {
    const g = d.genre;
    document.title = g.name + ' - Genres - tracked';
    const facts = [
      g.videos + ' sets with a video',
      g.inPlaylist + ' in the playlist',
      g.pending + ' to add',
      g.sets + ' followed sets in all',
    ];
    if (g.unavailable) facts.push(g.unavailable + ' unavailable');
    if (g.removed) facts.push(g.removed + ' removed by you');
    if (g.leaving) facts.push(g.leaving + ' to take out');
    if (g.pruned) facts.push(g.pruned + ' taken out (left their DJ playlist)');
    if (g.lastRunAt) facts.push('last run ' + TK.fmt.rel(new Date(g.lastRunAt * 1000).toISOString()));
    const choice = g.choice === null ? 'automatic' : g.choice ? 'on' : 'off';
    let html = '<div class="gn-head"><h2>' + esc(g.name) + '</h2>' + gnBadge(g) + '<span class="muted">' + esc(g.statusText) + '</span></div>' +
      '<div class="gn-facts">' + esc(facts.join(' \\u00b7 ')) + '</div>' +
      '<div class="gn-facts">Playlist: ' + gnLinks(g) + ' \\u00b7 ' + gnExt('https://www.1001tracklists.com/genre/' + encodeURIComponent(g.key) + '/index.html', '1001tracklists genre page', 'The genre on 1001tracklists.') + ' \\u00b7 <a href="/ui/genres">All genres</a></div>' +
      '<div class="gn-actions">' +
      '<button type="button" class="btn primary" data-act="backfill"' + (g.enabled ? '' : ' disabled') + TK.tip('Adds what the playlist is missing now (creating it first if needed), up to one run of inserts, spent as your own action. It also runs by itself every scheduler tick.') + '>Backfill now</button>' +
      (g.choice !== true ? '<button type="button" class="btn" data-act="on"' + TK.tip('Keep a playlist for this genre whatever its number of sets.') + '>Switch on</button>' : '') +
      (g.choice !== false ? '<button type="button" class="btn" data-act="off"' + TK.tip('No playlist work for this genre. A playlist already made stays on YouTube as it is.') + '>Switch off</button>' : '') +
      (g.choice !== null ? '<button type="button" class="btn" data-act="auto"' + TK.tip('Back to the automatic rule: a playlist once the genre has enough sets with a video.') + '>Automatic</button>' : '') +
      '<button type="button" class="btn" data-act="refresh"' + (g.playlistId ? '' : ' disabled') + TK.tip('Reads the playlist from YouTube again on its next run (after you edited it by hand). Costs 1 quota unit per 50 videos.') + '>Refresh from YouTube</button>' +
      '<span class="muted">Now: ' + esc(choice) + '. Order: kept in set-date order with the DJ playlists (<a href="/ui/playlists">Playlists</a>).</span>' +
      '</div>';
    $card.innerHTML = html;
  }

  $card.addEventListener('click', async (ev) => {
    const b = ev.target && ev.target.closest ? ev.target.closest('button[data-act]') : null;
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'backfill') {
      const res = await TK.busy(b, 'Backfilling...', () => TK.api.post('/ui/api/genres/' + encodeURIComponent(key) + '/backfill', {}));
      const d = (res && res.data) || {};
      if (!res || !res.ok) TK.toast(TK.errText(res, 'backfill failed'), 'bad');
      else if (d.ok === false) TK.toast(d.reason === 'quota_held' ? 'waits for the YouTube quota (' + d.held + ')' : d.reason === 'youtube_not_connected' ? 'connect YouTube on the Playlists page first' : d.reason === 'busy' ? 'a run is already working on the genre playlists; try again in a minute' : 'not run: ' + d.reason, d.reason === 'youtube_not_connected' ? 'bad' : 'warn');
      else TK.toast('added ' + (d.inserted || 0) + ' video' + (d.inserted === 1 ? '' : 's') + (d.pending ? ' \\u00b7 ' + d.pending + ' still to add' : ''), 'ok');
    } else if (act === 'refresh') {
      const res = await TK.busy(b, 'Working...', () => TK.api.post('/ui/api/genres/' + encodeURIComponent(key) + '/refresh', {}));
      TK.toast(res && res.ok ? 'read again on the next run' : TK.errText(res, 'failed'), res && res.ok ? 'ok' : 'bad');
    } else {
      const enabled = act === 'on' ? true : act === 'off' ? false : null;
      const res = await TK.busy(b, 'Saving...', () => TK.api.post('/ui/api/genres/' + encodeURIComponent(key) + '/enabled', { enabled }));
      if (!res || !res.ok) TK.toast(TK.errText(res, 'failed'), 'bad');
    }
    await load();
  });

  async function load() {
    const res = await TK.api.get('/ui/api/genres/' + encodeURIComponent(key));
    if (!res.ok) { $err.textContent = TK.errText(res, 'failed (' + res.status + ')'); $card.hidden = true; return; }
    $err.textContent = '';
    $card.hidden = false;
    render(res.data);
    sets = res.data.sets || [];
    if (table) { table.setRows(sets); return; }
    table = TKTable.create($('gn-sets'), {
      id: 'gs',
      source: { rows: () => sets },
      defaultSort: '-setDate',
      search: 'Search sets or DJs',
      rowKey: 'setUrl',
      empty: 'No followed set has this genre yet.',
      chips: [
        { id: 'all', label: 'All', group: 's', on: true },
        { id: 'in', label: 'In playlist', group: 's', filters: [{ col: 'state', op: 'in', value: 'in' }], count: () => sets.filter((r) => r.state === 'in').length },
        { id: 'pending', label: 'To add', group: 's', filters: [{ col: 'state', op: 'in', value: 'pending' }], count: () => sets.filter((r) => r.state === 'pending').length },
        { id: 'other', label: 'Not added', group: 's', filters: [{ col: 'state', op: 'in', value: 'failed|unavailable|removed|not_in_dj_playlist|no_video' }], count: () => sets.filter((r) => !['in', 'pending', 'leaving'].includes(r.state)).length },
      ],
      columns: [
        { key: 'title', label: 'Set', type: 'text',
          render: (r) => '<a href="/ui/set?url=' + encodeURIComponent(r.setUrl) + '">' + esc(r.title || r.setUrl) + '</a>' + (r.error ? '<span class="gn-err">' + esc(r.error) + '</span>' : '') },
        { key: 'djs', label: 'DJ', type: 'text', hideOn: 'phone' },
        { key: 'setDate', label: 'Date', type: 'date', width: '7.5rem' },
        { key: 'state', label: 'Playlist', type: 'enum', width: '10rem',
          options: Object.keys(STATE).map((k) => ({ value: k, label: STATE[k][1] })),
          render: (r) => { const s = STATE[r.state] || ['neutral', r.state]; return '<span class="badge ' + s[0] + '"' + TK.tip(STATE_TIP[r.state] || '') + '>' + esc(s[1]) + '</span>'; } },
        { key: 'videoId', label: 'Video', type: 'text', sortable: false, hideOn: 'phone',
          render: (r) => r.videoId ? gnExt('https://www.youtube.com/watch?v=' + encodeURIComponent(r.videoId), 'YouTube', 'Opens the video on YouTube.') : '<span class="tkt-nil">-</span>' },
      ],
    });
  }
  load();
})();
`;

export const GENRES_PAGE: UiPage = {
  path: "/genres",
  html: shell({
    nav: "genres",
    title: "Genres",
    description: `One YouTube playlist per genre, filled with the ${tipTerm("followed sets", "Sets of the DJs you follow whose video is in their DJ playlist.")} of that genre, in set-date order.`,
    body: LIST_BODY,
    css: CSS,
    js: LIST_JS,
  }),
};

export const GENRE_PAGE: UiPage = {
  path: "/genres/:key",
  html: shell({
    nav: "genres",
    title: "Genre",
    description: "A genre's playlist, its status and its sets.",
    body: GENRE_BODY,
    css: CSS,
    js: GENRE_JS,
  }),
};
