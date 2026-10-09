// Search (phase 3): one box over every verified track list. Data: GET
// /ui/api/search (src/routes/search.ts) as you type. "All" is one list: DJs
// first, then tracks and sets interleaved by relevance (`score`), the best 20
// of each. The Tracks, Sets and DJs tabs ask for the best 200 of their kind
// and show them as a data table (TKTable, src/ui/data-table.ts, local mode:
// relevance needs the whole candidate set, so sorting, filtering and paging
// run in the browser over that window), relevance first by default, every
// other column sortable and filterable from its header. Every row has a square
// thumbnail (/ui/img/<key>, an R2 copy) over a lettered placeholder. q and
// kind live in the query string (TKTable.qs.merge keeps the tables' own
// state); the shell's top box submits here with ?q=.
//
// Results are rendered through innerHTML and clicks are delegated (the tests
// run this script in a stub DOM). Every upstream string goes through esc, every
// external href through safeHref, and highlight() escapes the original text
// piece by piece, so no markup can come from data.
import { shell } from '../shell'
import { tipAttr } from '../tip'
import type { UiPage } from './index'
import { TRACK_ROW_CSS, TRACK_ROW_JS } from './track-row'

const TABS: Array<[string, string]> = [['all', 'All'], ['tracks', 'Tracks'], ['sets', 'Sets'], ['djs', 'DJs']]
const TAB_TIPS: Record<string, string> = {
  all: 'DJs first, then tracks and sets ranked together by relevance.',
  tracks: 'Individual tracks, with the sets they were played in. Up to 200, as a table you can sort and filter.',
  sets: 'Whole DJ sets, by title or by a track played in them. Up to 200, as a table you can sort and filter.',
  djs: 'DJs, subscribed or not, that appear in the searched track lists.',
}
/** Results per kind on a single-kind tab (the API's maximum). */
const TAB_LIMIT = 200

const BODY = /* html */ `
<div class="sq-bar"><input id="sq" type="search" autofocus autocomplete="off" aria-label="Search tracks, sets, DJs" placeholder="Track, set or DJ" role="combobox" aria-controls="sq-results" aria-expanded="true"></div>
<div id="sq-tabs" class="chips" role="group" aria-label="Result type">${TABS.map(([k, l]) => `<button type="button" class="chip${k === 'all' ? ' on' : ''}" data-kind="${k}" aria-pressed="${k === 'all'}"${tipAttr(TAB_TIPS[k])}>${l}</button>`).join('')}</div>
<div id="sq-corrected" class="sq-corrected" role="status" hidden></div>
<div id="sq-results" role="listbox" aria-label="Search results"></div>
<div id="sq-tables" class="sq-tables" role="listbox" aria-label="Search results">
  <div id="sq-t-tracks" class="sq-table" hidden></div>
  <div id="sq-t-sets" class="sq-table" hidden></div>
  <div id="sq-t-djs" class="sq-table" hidden></div>
  <p id="sq-cap" class="muted sq-cap" hidden></p>
</div>
<div id="sq-empty" class="empty" role="status">Search every verified track list: tracks, sets and DJs.</div>
`

export const SEARCH_CSS = /* css */ `
  mark { background: var(--accent-soft); color: inherit; border-radius: 2px; }
  .tk-search { display: none; }
  .sq-bar { margin-bottom: var(--sp-3); }
  .sq-bar input { appearance: none; font: inherit; font-size: var(--fs-md, 1rem); color: var(--fg); background: var(--page); border: 1px solid var(--line-strong); border-radius: var(--r-ctl); padding: 10px 12px; width: 100%; min-width: 0; }
  .sq-bar input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .sq-corrected { margin: 0 0 var(--sp-3); font-size: var(--fs-sm); display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); min-width: 0; }
  .sq-corrected[hidden] { display: none; }
  .sq-row { background: var(--card); border: 1px solid var(--line); border-radius: var(--r-card); padding: var(--sp-3) var(--sp-4); margin-bottom: var(--sp-2); min-width: 0; display: flex; align-items: flex-start; gap: var(--sp-3); }
  .sq-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
  .sq-thumb { position: relative; flex: 0 0 56px; width: 56px; height: 56px; border-radius: 6px; overflow: hidden; background: var(--elev); }
  .sq-thumb.dj { border-radius: 50%; }
  .sq-thumb img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
  .sq-ph { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: 1.15rem; color: var(--muted); text-transform: uppercase; }
  .sq-kind { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: var(--subtle); }
  @media (max-width: 800px) { .sq-thumb { flex-basis: 44px; width: 44px; height: 44px; } .sq-row { padding: var(--sp-3); } }
  .sq-row.on { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
  .sq-main { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px var(--sp-2); min-width: 0; }
  .sq-ttl { font-weight: 600; overflow-wrap: anywhere; min-width: 0; }
  .sq-ttl a { color: inherit; text-decoration: none; }
  .sq-ttl a:hover { text-decoration: underline; }
  .sq-meta, .sq-acts { display: flex; flex-wrap: wrap; align-items: center; gap: 6px var(--sp-3); color: var(--muted); font-size: var(--fs-sm); min-width: 0; }
  .sq-meta a, .sq-sets a { color: var(--accent); }
  .sq-acts .pill, .sq-acts .btn { font-size: .78rem; }
  .sq-sets { list-style: none; margin: 4px 0 0; padding: 6px 0 0; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 6px; font-size: var(--fs-sm); }
  .sq-sets li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px var(--sp-3); min-width: 0; overflow-wrap: anywhere; }
  .sq-cue { font-family: var(--mono); color: var(--muted); }
  #sq-empty[hidden] { display: none; }
  /* The single-kind tabs: a table whose first cell is the result (thumbnail, title, links). */
  .sq-table .tkt-table td { vertical-align: middle; }
  .sq-cell { display: flex; align-items: center; gap: var(--sp-3); min-width: 14rem; }
  .sq-cell .sq-thumb { flex-basis: 44px; width: 44px; height: 44px; }
  .sq-cell .sq-body { gap: 4px; }
  .sq-table tr.on > td { background: var(--accent-soft); }
  .sq-match { display: inline-block; min-width: 3ch; font-variant-numeric: tabular-nums; color: var(--muted); }
  .sq-cap { font-size: var(--fs-sm); margin: var(--sp-2) 0 0; }
  @media (max-width: 699px) {
    .sq-table .tkt-table td:first-child { display: block; text-align: left; }
    .sq-table .tkt-table td:first-child::before { content: none; }
    .sq-cell { min-width: 0; }
  }
  ${TRACK_ROW_CSS}
`

const JS = /* js */ `
(() => {
  const $ = TK.$, esc = TK.esc;
${TRACK_ROW_JS}
  const TABS = ${JSON.stringify(TABS)};
  const TAB_TIPS = ${JSON.stringify(TAB_TIPS)};
  const TAB_LIMIT = ${TAB_LIMIT};
  const EXT_TIPS = { '1001tl': 'Opens this on 1001tracklists.', YouTube: 'Plays this track on YouTube.', SoundCloud: 'Plays this track on SoundCloud (free, with ads).', 'Apple Music': 'Opens this track in Apple Music.' };
  const $sq = $('sq'), $tabs = $('sq-tabs'), $note = $('sq-corrected'), $res = $('sq-results'), $tables = $('sq-tables'), $empty = $('sq-empty'), $cap = $('sq-cap');
  const EMPTY_HINT = 'Search every verified track list: tracks, sets and DJs.';

  // ── state: q and kind are mirrored to the query string ──
  const known = TABS.map((t) => t[0]);
  let kind = known.indexOf(TK.qs.get('kind') || '') >= 0 ? TK.qs.get('kind') : 'all';
  let exact = false, seq = 0, ctl = null, timer = 0, data = null, tokens = [], active = -1;
  // nav: the results in display order, [{ id, href }]: what the arrow keys walk and Enter opens.
  let nav = [];
  const expanded = new Set(), linkState = {};

  // ── text matching: case-, diacritic- and apostrophe-insensitive ──
  function fold(ch) { return (ch.normalize ? ch.normalize('NFKD') : ch).replace(/\\p{M}+/gu, '').toLowerCase().replace(/['’‘\`´]/g, ''); }
  function wordsOf(s) { return [...String(s == null ? '' : s)].map(fold).join('').split(/[^\\p{L}\\p{N}]+/u).filter(Boolean); }
  // highlight(text, tokens): the text escaped, with the start of every word that
  // begins with a token wrapped in <mark>. Matching runs on a folded copy, the
  // hits are mapped back to the original characters, and each run is escaped on
  // its own, so the only markup in the result is the <mark> tags added here.
  function highlight(text, toks) {
    text = text == null ? '' : String(text);
    if (!toks || !toks.length || !text) return esc(text);
    const chars = [...text];
    let folded = '';
    const map = [];
    chars.forEach((c, i) => { const f = fold(c); for (let k = 0; k < f.length; k++) map.push(i); folded += f; });
    const hit = chars.map(() => false);
    for (const t of toks) {
      if (!t) continue;
      let at = folded.indexOf(t);
      while (at >= 0) {
        if (at === 0 || !/[\\p{L}\\p{N}]/u.test(folded[at - 1])) for (let k = at; k < at + t.length; k++) hit[map[k]] = true;
        at = folded.indexOf(t, at + 1);
      }
    }
    // A dropped character (an apostrophe) between two hits belongs to the hit: don't for dont.
    for (let i = 1; i + 1 < chars.length; i++) if (!hit[i] && hit[i - 1] && hit[i + 1] && !fold(chars[i])) hit[i] = true;
    let out = '', run = '', on = false;
    chars.forEach((c, i) => {
      if (hit[i] !== on) { out += on ? '<mark>' + esc(run) + '</mark>' : esc(run); run = ''; on = hit[i]; }
      run += c;
    });
    return out + (on ? '<mark>' + esc(run) + '</mark>' : esc(run));
  }
  function searchUrl(q, k, ex) {
    return '/ui/api/search?q=' + encodeURIComponent(q) + '&kind=' + encodeURIComponent(k) + '&limit=' + (k === 'all' ? 20 : TAB_LIMIT) + (ex ? '&exact=1' : '');
  }

  // ── rendering ──
  const setHref = (url) => '/ui/set?url=' + encodeURIComponent(url);
  const ext = (url, label, cls) => { const h = TK.safeHref(url); return h ? '<a class="' + (cls || 'pill') + '" href="' + esc(h) + '" target="_blank" rel="noreferrer noopener"' + TK.tip(EXT_TIPS[label]) + '>' + esc(label) + '</a>' : ''; };
  const hl = (s) => highlight(s, tokens);
  const IMG_RE = /^\\/ui\\/img\\/[0-9a-f]{32}$/;
  // The thumbnail: the image over a lettered placeholder (a failed image is removed, see the error listener).
  function thumb(src, label, k) {
    const ch = [...String(label || '').trim()][0] || '?';
    return '<div class="sq-thumb' + (k === 'djs' ? ' dj' : '') + '" aria-hidden="true"><span class="sq-ph">' + esc(ch) + '</span>' +
      (typeof src === 'string' && IMG_RE.test(src) ? '<img src="' + esc(src) + '" alt="" loading="lazy" width="56" height="56">' : '') + '</div>';
  }
  const KIND_TAG = { tracks: 'Track', sets: 'Set', djs: 'DJ' };
  let tagKinds = false;
  const tag = (k) => (tagKinds ? '<span class="sq-kind">' + KIND_TAG[k] + '</span>' : '');
  // A result row of the All list: thumbnail, then the body (closed by rowClose).
  function rowOpen(n, extra, img, label, k) {
    return '<div class="sq-row" id="sq-r' + n + '" role="option" aria-selected="false" data-n="' + n + '"' + (extra ? ' ' + extra : '') + '>' + thumb(img, label, k) + '<div class="sq-body">';
  }
  const rowClose = '</div></div>';

  function trackLinks(t) {
    let h = ext(t.trackUrl, '1001tl') + ext(t.youtubeLink, 'YouTube') + ext(t.soundcloudLink, 'SoundCloud') + ext(t.appleLink, 'Apple Music');
    const st = linkState[t.trackKey];
    if (!t.youtubeLink && !t.soundcloudLink && !t.appleLink && t.trackId && /^\\d+$/.test(t.trackId)) {
      if (st === 'none') h += '<span class="muted">no links</span>';
      else h += '<button type="button" class="btn small links-btn" data-links="' + esc(t.trackKey) + '"' + (st === 'loading' ? ' disabled' : '') +
        TK.tip(st && st.indexOf('err:') === 0 ? 'Lookup failed: ' + st.slice(4) + ' Press to try again.' : 'Looks up Apple Music and YouTube links for this track. Costs one 1001tracklists page view; the result is cached for 30 days.') + '>' + (st === 'loading' ? '…' : 'links') + '</button>';
    }
    return h;
  }
  function newestSet(t) {
    let best = null;
    for (const s of t.sets || []) if (!best || String(s.date || '') > String(best.date || '')) best = s;
    return best;
  }
  const trackHref = (t) => { const best = newestSet(t); return best ? setHref(best.url) : (TK.safeHref(t.trackUrl) || ''); };
  const setsButton = (t) => {
    const sets = t.sets || [], open = expanded.has(t.trackKey);
    return sets.length ? '<button type="button" class="btn small" data-exp="' + esc(t.trackKey) + '" aria-expanded="' + open + '"' + TK.tip(open ? 'Hides the sets this track was played in.' : 'Shows the sets this track was played in, with the time it was cued.') + '>' + sets.length + (sets.length === 1 ? ' set' : ' sets') + '</button>' : '';
  };
  function trackSetsHtml(t) {
    if (!expanded.has(t.trackKey)) return '';
    return '<ul class="sq-sets">' + (t.sets || []).map((s) =>
      '<li><a href="/ui/dj/' + encodeURIComponent(s.djSlug) + '">' + esc(s.djName) + '</a>' +
      (s.date ? '<span class="muted">' + esc(s.date) + '</span>' : '') +
      (s.cueSeconds != null ? '<span class="sq-cue">' + esc(TK.fmt.clock(s.cueSeconds)) + '</span>' : '') +
      '<a href="' + esc(setHref(s.url)) + '">Set page</a>' + ext(s.url, '1001tl', 'sq-ext') + '</li>').join('') + '</ul>';
  }
  // The table has its own Label column, so its Track cell leaves the label out (noLabel).
  const trackTitle = (t, noLabel) => '<span class="sq-ttl">' + hl(t.artist) + ' – ' + hl(t.title) + '</span>' +
    (t.label && !noLabel ? '<span class="badge neutral"' + TK.tip('The record label of this track.') + '>' + hl(t.label) + '</span>' : '');
  function trackRowHtml(t, n) {
    nav[n] = { id: 'sq-r' + n, href: trackHref(t) };
    return rowOpen(n, '', t.image, t.artist, 'tracks') +
      '<div class="sq-main">' + tag('tracks') + trackTitle(t) + '</div>' +
      '<div class="sq-acts">' + trackLinks(t) + setsButton(t) + '</div>' + trackSetsHtml(t) + rowClose;
  }
  const idsText = (s) => esc(s.idedCount) + '/' + esc(s.trackCount) + ' IDs';
  const videoBadge = (s) => (s.videoId ? '<span class="badge ok"' + TK.tip('The set has a video in the playlists.') + '>video</span>' : '<span class="badge warn"' + TK.tip('The set has no video in the playlists yet: it has no usable recording, or it has not been processed.') + '>no video</span>');
  function setRowHtml(s, n) {
    nav[n] = { id: 'sq-r' + n, href: setHref(s.url) };
    return rowOpen(n, 'data-set-row', s.image, s.djName || s.title, 'sets') +
      '<div class="sq-main">' + tag('sets') + '<span class="sq-ttl"><a href="' + esc(setHref(s.url)) + '">' + hl(s.title) + '</a></span></div>' +
      '<div class="sq-meta"><a href="/ui/dj/' + encodeURIComponent(s.djSlug) + '">' + hl(s.djName) + '</a>' +
        (s.date ? '<span>' + esc(s.date) + '</span>' : '') +
        '<span' + TK.tip('Tracks identified out of all tracks in the set.') + '>' + idsText(s) + '</span>' + videoBadge(s) + '</div>' +
      '<div class="sq-acts"><a class="pill" href="' + esc(setHref(s.url)) + '">Set page</a>' + ext(s.url, '1001tl') + '</div>' + rowClose;
  }
  const djHref = (d) => '/ui/dj/' + encodeURIComponent(d.slug);
  const subBadge = (d) => (d.subscribed ? '<span class="badge ok"' + TK.tip('You are subscribed to this DJ.') + '>subscribed</span>' : '');
  function djRowHtml(d, n) {
    nav[n] = { id: 'sq-r' + n, href: djHref(d) };
    return rowOpen(n, '', d.image, d.name, 'djs') +
      '<div class="sq-main">' + tag('djs') + '<span class="sq-ttl"><a href="' + esc(djHref(d)) + '">' + hl(d.name) + '</a></span>' + subBadge(d) + '</div>' +
      '<div class="sq-meta"><span>' + esc(d.sets) + (d.sets === 1 ? ' set' : ' sets') + '</span></div>' +
      '<div class="sq-acts"><a class="pill" href="' + esc(djHref(d)) + '">Profile</a></div>' + rowClose;
  }
  const RENDER = { tracks: trackRowHtml, sets: setRowHtml, djs: djRowHtml };
  const score = (x) => (x && typeof x.score === 'number' ? x.score : 0);
  // All: DJs first (best first), then tracks and sets merged by score; on a
  // tie the one ranked higher in its own list goes first, a set before a track.
  function allOrder(d) {
    const list = (k) => (d && Array.isArray(d[k]) ? d[k] : []).map((x, i) => ({ k, x, i }));
    const rest = list('tracks').concat(list('sets'));
    rest.sort((a, b) => score(b.x) - score(a.x) || a.i - b.i || (a.k === b.k ? 0 : a.k === 'sets' ? -1 : 1));
    return list('djs').concat(rest);
  }

  // ── the single-kind tables ──
  // Each result gets _n (its relevance rank) once per response: the row's id is sq-<kind>-<_n>.
  const MATCH_TIP = 'Relevance: 100 is every word matching exactly; a recent set, a video or a subscribed DJ adds a little.';
  const match = (r) => '<span class="sq-match"' + TK.tip(MATCH_TIP) + '>' + Math.round(score(r) * 100) + '</span>';
  const cell = (img, label, k, body) => '<div class="sq-cell">' + thumb(img, label, k) + '<div class="sq-body">' + body + '</div></div>';
  const djNames = (t) => { const seen = []; for (const s of t.sets || []) if (s.djName && seen.indexOf(s.djName) < 0) seen.push(s.djName); return seen; };
  const COLS = {
    tracks: [
      { key: 'title', label: 'Track', type: 'text', value: (t) => t.artist + ' – ' + t.title,
        render: (t) => cell(t.image, t.artist, 'tracks', '<div class="sq-main">' + trackTitle(t, true) + '</div><div class="sq-acts">' + trackLinks(t) + '</div>' + trackSetsHtml(t)) },
      { key: 'artist', label: 'Artist', type: 'text', hideOn: 'phone', render: (t) => hl(t.artist) },
      { key: 'label', label: 'Label', type: 'text', hideOn: 'phone', render: (t) => (t.label ? hl(t.label) : '<span class="tkt-nil">–</span>') },
      { key: 'djs', label: 'Played by', type: 'text', hideOn: 'phone', value: (t) => djNames(t).join(', ') || null,
        render: (t) => { const n = djNames(t); return n.length ? n.slice(0, 2).map(hl).join(', ') + (n.length > 2 ? ' <span class="muted">+' + (n.length - 2) + '</span>' : '') : '<span class="tkt-nil">–</span>'; } },
      { key: 'setCount', label: 'Sets', type: 'number', value: (t) => (t.sets || []).length, render: setsButton, tip: 'Sets this track was played in. Press to list them.' },
      { key: 'date', label: 'Last played', type: 'date', value: (t) => { const b = newestSet(t); return b && b.date ? String(b.date).slice(0, 10) : null; } },
      { key: 'score', label: 'Match', type: 'number', render: match, tip: MATCH_TIP },
    ],
    sets: [
      { key: 'title', label: 'Set', type: 'text',
        render: (s) => cell(s.image, s.djName || s.title, 'sets', '<div class="sq-main"><span class="sq-ttl"><a href="' + esc(setHref(s.url)) + '">' + hl(s.title) + '</a></span></div><div class="sq-acts">' + ext(s.url, '1001tl') + '</div>') },
      { key: 'djName', label: 'DJ', type: 'text', render: (s) => '<a href="/ui/dj/' + encodeURIComponent(s.djSlug) + '">' + hl(s.djName) + '</a>' },
      { key: 'date', label: 'Date', type: 'date', value: (s) => (s.date ? String(s.date).slice(0, 10) : null) },
      { key: 'idedCount', label: 'IDs', type: 'number', render: (s) => '<span' + TK.tip('Tracks identified out of all tracks in the set.') + '>' + idsText(s) + '</span>', tip: 'Tracks identified out of all tracks in the set.' },
      { key: 'hasVideo', label: 'Video', type: 'bool', value: (s) => !!s.videoId, render: videoBadge },
      { key: 'score', label: 'Match', type: 'number', render: match, tip: MATCH_TIP },
    ],
    djs: [
      { key: 'name', label: 'DJ', type: 'text', render: (d) => cell(d.image, d.name, 'djs', '<div class="sq-main"><span class="sq-ttl"><a href="' + esc(djHref(d)) + '">' + hl(d.name) + '</a></span>' + subBadge(d) + '</div>') },
      { key: 'sets', label: 'Sets', type: 'number' },
      { key: 'subscribed', label: 'Subscribed', type: 'bool', render: (d) => (d.subscribed ? 'yes' : '<span class="muted">no</span>') },
      { key: 'score', label: 'Match', type: 'number', render: match, tip: MATCH_TIP },
    ],
  };
  const HREF = { tracks: trackHref, sets: (s) => setHref(s.url), djs: djHref };
  const rowId = (k, r) => 'sq-' + k + '-' + r._n;
  const tables = {};
  const listOf = (k) => (data && Array.isArray(data[k]) ? data[k] : []);
  function tableFor(k) {
    if (tables[k] || typeof TKTable === 'undefined') return tables[k] || null;
    tables[k] = TKTable.create($('sq-t-' + k), {
      id: 'sq' + k[0],
      source: { rows: () => listOf(k) },
      columns: COLS[k],
      defaultSort: '-score',
      search: false,
      // The relevance rank (negated: the tiebreak follows the first sort key, and the default sort is -score).
      rowKey: (r) => -r._n,
      rowAttrs: (r) => ({ id: rowId(k, r), role: 'option', 'aria-selected': 'false' }),
      empty: 'Nothing found.',
      onData: (resp) => {
        nav = (resp.rows || []).map((r) => ({ id: rowId(k, r), href: HREF[k](r) }));
        setActive(active < nav.length ? active : -1, true);
      },
    });
    return tables[k];
  }

  function renderTabs() {
    $tabs.innerHTML = TABS.map((t) => '<button type="button" class="chip' + (t[0] === kind ? ' on' : '') + '" data-kind="' + t[0] + '" aria-pressed="' + (t[0] === kind) + '"' + TK.tip(TAB_TIPS[t[0]]) + '>' + t[1] + '</button>').join('');
  }
  function setActive(n, repaint) {
    const old = active >= 0 && nav[active] ? $(nav[active].id) : null;
    if (old && old.classList && (active !== n || repaint)) { old.classList.remove('on'); old.setAttribute('aria-selected', 'false'); }
    active = n;
    const el = n >= 0 && nav[n] ? $(nav[n].id) : null;
    if (el && el.classList) { el.classList.add('on'); el.setAttribute('aria-selected', 'true'); if (!repaint && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' }); }
    if (typeof $sq.setAttribute === 'function') { if (n >= 0 && nav[n]) $sq.setAttribute('aria-activedescendant', nav[n].id); else if (typeof $sq.removeAttribute === 'function') $sq.removeAttribute('aria-activedescendant'); }
  }
  // Draws the current response: All as one interleaved list with a kind tag on
  // each row; a single tab as its table (the others hidden). fresh: a new
  // response, so the table goes back to its first page.
  function paint(fresh) {
    const single = kind !== 'all';
    for (const k of ['tracks', 'sets', 'djs']) { const el = $('sq-t-' + k); if (el) el.hidden = !(single && data && k === kind && listOf(k).length); }
    if (!single) {
      nav = [];
      let n = 0;
      tagKinds = true;
      $res.innerHTML = data ? allOrder(data).map((it) => RENDER[it.k](it.x, n++)).join('') : '';
      $res.hidden = false;
      $cap.hidden = true;
      setActive(active < nav.length ? active : -1, true);
      return;
    }
    tagKinds = false;
    $res.innerHTML = ''; $res.hidden = true;
    const list = listOf(kind);
    $cap.hidden = list.length < TAB_LIMIT;
    $cap.textContent = list.length >= TAB_LIMIT ? 'Showing the best ' + TAB_LIMIT + ' matches. Add words to narrow the search.' : '';
    if (!data || !list.length) { nav = []; setActive(-1); return; }
    const t = tableFor(kind);
    if (t) { if (fresh) t.setPage(1); else t.reload(); }
  }
  function showEmpty(text) { $empty.hidden = false; $empty.textContent = text; }
  function showNote(q) {
    const c = !exact && data && Array.isArray(data.corrected) ? data.corrected : [];
    if (!c.length) { $note.hidden = true; $note.innerHTML = ''; return; }
    const to = {};
    for (const x of c) to[x.from] = x.to;
    const shown = wordsOf(q).map((w) => (Object.prototype.hasOwnProperty.call(to, w) ? to[w] : w)).join(' ');
    $note.innerHTML = '<span>Showing results for <strong>' + esc(shown) + '</strong>.</span> <button type="button" id="sq-exact" class="btn small"' + TK.tip('Searches for what you typed, without the spelling correction.') + '>Search exactly for ' + esc(q) + '</button>';
    $note.hidden = false;
  }

  // ── searching: one request in flight, the newest wins ──
  function sync(q) { TKTable.qs.merge({ q, kind: kind === 'all' ? '' : kind }); }
  function clearOut() { data = null; active = -1; nav = []; paint(); }
  async function run() {
    const q = ($sq.value || '').trim();
    const my = ++seq;
    if (ctl) { try { ctl.abort(); } catch (e) {} ctl = null; }
    sync(q);
    // The previous results stay (and stay usable: expand, links) until the reply lands.
    if (!q) { clearOut(); $note.hidden = true; showEmpty(EMPTY_HINT); return; }
    if (typeof AbortController !== 'undefined') ctl = new AbortController();
    const res = await TK.api.get(searchUrl(q, kind, exact), ctl ? { signal: ctl.signal } : undefined);
    if (my !== seq || res.aborted) return;
    ctl = null;
    const d = res.ok && res.data && Array.isArray(res.data.tracks) ? res.data : null;
    active = -1; nav = [];
    if (!d) {
      clearOut(); $note.hidden = true;
      showEmpty(res.status === 503 ? 'The search index is not set up on this Worker.' : TK.errText(res, 'Search failed (' + (res.status || 'offline') + ')'));
      return;
    }
    for (const k of ['tracks', 'sets', 'djs']) (Array.isArray(d[k]) ? d[k] : []).forEach((x, i) => { if (x && typeof x === 'object') x._n = i; });
    data = d;
    tokens = wordsOf(q);
    if (!exact && Array.isArray(d.corrected)) for (const c of d.corrected) tokens = tokens.concat(wordsOf(c.to));
    showNote(q);
    paint(true);
    const count = (kind === 'all' || kind === 'tracks' ? d.tracks.length : 0) + (kind === 'all' || kind === 'sets' ? (d.sets || []).length : 0) + (kind === 'all' || kind === 'djs' ? (d.djs || []).length : 0);
    if (count) $empty.hidden = true; else showEmpty('Nothing found for “' + q + '”.');
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(run, 150); }
  function setKind(k) { if (k === kind || known.indexOf(k) < 0) return; kind = k; renderTabs(); clearTimeout(timer); run(); }

  // ── events ──
  $sq.addEventListener('input', () => { exact = false; schedule(); });
  $sq.addEventListener('keydown', (ev) => {
    const key = ev && ev.key;
    const stop = () => { if (ev.preventDefault) ev.preventDefault(); };
    if (key === 'ArrowDown' && nav.length) { stop(); setActive(active + 1 < nav.length ? active + 1 : 0); }
    else if (key === 'ArrowUp' && nav.length) { stop(); setActive(active > 0 ? active - 1 : nav.length - 1); }
    else if (key === 'Enter') {
      stop();
      if (active >= 0 && nav[active] && nav[active].href) { if (typeof location !== 'undefined') location.href = nav[active].href; }
      else { clearTimeout(timer); run(); }
    } else if (key === 'Escape') { stop(); $sq.value = ''; exact = false; clearTimeout(timer); run(); }
  });
  $tabs.addEventListener('click', (ev) => {
    const b = ev.target && ev.target.closest ? ev.target.closest('[data-kind]') : null;
    if (b && b.dataset) setKind(b.dataset.kind);
  });
  $note.addEventListener('click', (ev) => {
    const b = ev.target && ev.target.closest ? ev.target.closest('#sq-exact') : null;
    if (b) { exact = true; clearTimeout(timer); run(); }
  });
  async function lookupLinks(key) {
    const t = data && data.tracks.find((x) => x.trackKey === key);
    if (!t || linkState[key] === 'loading') return;
    linkState[key] = 'loading'; paint();
    try {
      const r = await fetchLinks([t.trackId]);
      const ml = r.links[t.trackId];
      if (ml && (ml.youtubeLink || ml.soundcloudLink || ml.appleLink)) { Object.assign(t, ml); delete linkState[key]; }
      else if (r.error) linkState[key] = 'err:' + r.error;
      else linkState[key] = 'none';
    } catch (e) { linkState[key] = 'err:' + (e && e.message ? e.message : e); }
    paint();
  }
  // One delegated handler for the All list and the tables (a table's own handler ignores these buttons).
  function onResultsClick(ev) {
    const t = ev.target;
    if (!t || !t.closest) return;
    const lb = t.closest('[data-links]');
    if (lb && lb.dataset) { lookupLinks(lb.dataset.links); return; }
    const eb = t.closest('[data-exp]');
    if (eb && eb.dataset) { if (expanded.has(eb.dataset.exp)) expanded.delete(eb.dataset.exp); else expanded.add(eb.dataset.exp); paint(); return; }
    const kb = t.closest('[data-kind]');
    if (kb && kb.dataset) { setKind(kb.dataset.kind); return; }
    const row = t.closest('[role="option"]');
    if (row && row.id) { const i = nav.findIndex((x) => x.id === row.id); if (i >= 0) setActive(i); }
  }
  $res.addEventListener('click', onResultsClick);
  $tables.addEventListener('click', onResultsClick);

  // A thumbnail that fails to load is removed, leaving its placeholder (error events do not bubble: capture).
  const dropImg = (ev) => { const t = ev && ev.target; if (t && t.tagName === 'IMG' && typeof t.remove === 'function') t.remove(); };
  $res.addEventListener('error', dropImg, true);
  $tables.addEventListener('error', dropImg, true);

  // ── start ──
  renderTabs();
  $sq.value = TK.qs.get('q') || '';
  if ($sq.value.trim()) run(); else showEmpty(EMPTY_HINT);
})();
`

export const SEARCH_PAGE: UiPage = {
  path: '/search',
  html: shell({
    nav: 'search',
    title: 'Search',
    description: 'Tracks, sets and DJs from every verified track list.',
    body: BODY,
    css: SEARCH_CSS,
    js: JS,
  }),
}
