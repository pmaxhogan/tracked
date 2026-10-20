// Recommended sets: sets by DJs you do not follow, ranked by how many tracks
// of the followed DJs' sets they play. The crawl (lib/track-sets.ts) reads
// each such track's 1001tracklists page for the sets it was played in; this
// page reads the Access-gated GET /ui/api/recommended (a data-table endpoint,
// TKTable id 'rs'), whose answer also carries the crawl's progress. A row's
// Tracks button lists the followed tracks that put the set here.
import { shell } from "../shell";
import { tipTerm } from "../tip";
import type { UiPage } from ".";

const BODY = /* html */ `
  <div id="rs-bar" class="tk-row rs-bar"></div>
  <div id="error" class="error" role="alert"></div>
  <div id="rs-tracks"></div>
  <div id="rs-table"></div>
`;

const CSS = /* css */ `
  .rs-bar { flex-wrap: wrap; gap: var(--sp-2); margin-bottom: var(--sp-3); }
  .rs-tracks { margin-bottom: var(--sp-3); }
  .rs-tracks ol { margin: var(--sp-2) 0 0; padding-left: 1.4rem; }
  .rs-tracks li { overflow-wrap: anywhere; }
  .rs-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
  .rs-title { overflow-wrap: anywhere; }
  #error:empty { display: none; }
`;

const JS = /* js */ `
(() => {
  const $ = TK.$, esc = TK.esc;
  const $bar = $('rs-bar'), $err = $('error'), $tracks = $('rs-tracks');
  const nil = '<span class="tkt-nil">-</span>';
  const badge = (cls, text, tip) => '<span class="badge ' + cls + '"' + TK.tip(tip) + '>' + esc(text) + '</span>';
  const ext = (href, text, tip) => { const h = TK.safeHref(href); return h ? '<a href="' + esc(h) + '" target="_blank" rel="noreferrer noopener"' + TK.tip(tip) + '>' + esc(text) + '</a>' : esc(text); };
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);

  function renderBar(p) {
    if (!p) { $bar.innerHTML = ''; return; }
    $bar.innerHTML =
      badge('neutral', 'tracks read ' + num(p.walked) + ' / ' + num(p.queued), 'Tracks of the followed DJs whose 1001tracklists page has been read for the sets it lists, out of every track queued. A few page views each cron tick, at pool priority backfill.') +
      (num(p.walking) ? badge('info', 'reading ' + num(p.walking), 'Tracks part way through their list of sets: the next tick goes on where it stopped.') : '') +
      badge('neutral', num(p.sets) + ' sets', 'Sets by DJs you do not follow that at least one of those tracks was played in.');
  }

  function trackLabel(t) {
    if (t.artist && t.title) return t.artist + ' - ' + t.title;
    const m = String(t.trackUrl || '').match(/\\/track\\/[^/]+\\/([^/]+)\\//);
    return m ? m[1].replace(/-/g, ' ') : t.trackPageId;
  }

  async function showTracks(r) {
    $err.textContent = '';
    const res = await TK.api.get('/ui/api/recommended/' + encodeURIComponent(r.set_id) + '/tracks');
    if (!res.ok) { $err.textContent = TK.errText(res, 'failed (' + res.status + ')'); return; }
    const list = (res.data && res.data.tracks) || [];
    $tracks.innerHTML = '<div class="tk-card rs-tracks"><div class="rs-head"><strong class="rs-title">' + esc(list.length + ' followed tracks in ' + r.title) + '</strong>' +
      '<button type="button" class="btn sm" id="rs-tracks-close">Close</button></div><ol>' +
      list.map((t) => '<li>' + (t.trackUrl ? ext(t.trackUrl, trackLabel(t), 'Opens the track on 1001tracklists.') : esc(trackLabel(t))) + '</li>').join('') + '</ol></div>';
    $('rs-tracks-close').addEventListener('click', () => { $tracks.innerHTML = ''; });
    $tracks.scrollIntoView({ block: 'nearest' });
  }

  TKTable.create($('rs-table'), {
    id: 'rs',
    source: { url: '/ui/api/recommended' },
    swr: true,
    defaultSort: '-track_count',
    search: 'Search set, genre or list creator',
    empty: 'No sets yet. The crawl reads a few track pages every 5 minutes.',
    rowKey: 'set_id',
    columns: [
      { key: 'track_count', label: 'Tracks', type: 'number', width: '5rem',
        tip: 'How many tracks from the sets of the followed DJs this set plays, as far as the crawl has read.' },
      { key: 'title', label: 'Set', type: 'text',
        render: (r) => '<span class="rs-title">' + ext(r.set_url, r.title, 'Opens the set on 1001tracklists.') + '</span>' },
      { key: 'set_date', label: 'Date', type: 'date', width: '7.5rem' },
      { key: 'views', label: 'Views', type: 'number', width: '5rem',
        tip: 'Views of the list on 1001tracklists, as of the last track page that listed it.' },
      { key: 'likes', label: 'Likes', type: 'number', width: '5rem', hideOn: 'phone',
        tip: 'Likes of the list on 1001tracklists, as of the last track page that listed it.' },
      { key: 'genres', label: 'Genres', type: 'text', hideOn: 'phone',
        render: (r) => r.genres ? esc(r.genres) : nil,
        tip: 'The music styles 1001tracklists gives the set.' },
      { key: 'creator', label: 'List by', type: 'text', hideOn: 'phone',
        render: (r) => r.creator ? ext('https://www.1001tracklists.com/user/' + encodeURIComponent(r.creator) + '/index.html', r.creator, 'The 1001tracklists user who made the list.') : nil },
      { key: 'first_seen_at', label: 'Found', type: 'datetime', storage: 's', hideOn: 'phone',
        tip: 'When a track page first listed this set.' },
    ],
    actions: () => '<button type="button" class="btn sm" data-act="tracks"' + TK.tip('Lists the followed tracks this set plays.') + '>Tracks</button>',
    onAction: (act, r, btn) => {
      if (act !== 'tracks') return;
      return TK.busy(btn, 'Loading...', () => showTracks(r));
    },
    onData: (d) => renderBar(d.progress),
  });
})();
`;

export const RECOMMENDED_PAGE: UiPage = {
  path: "/recommended",
  html: shell({
    nav: "recommended",
    title: "Recommended sets",
    description: `Sets by DJs you do not follow, ranked by how many ${tipTerm("followed tracks", "Tracks of the sets of the DJs you follow. The crawl reads each one's 1001tracklists page for every set it was played in.")} they play.`,
    body: BODY,
    css: CSS,
    js: JS,
  }),
};
