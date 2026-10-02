// Search (phase 3): one box over every verified track list. Data: GET
// /ui/api/search (src/routes/search.ts) as you type. "All" is one list: DJs
// first, then tracks and sets interleaved by relevance (`score`); the other
// tabs show one kind. Every row has a square thumbnail (/ui/img/<key>, an R2
// copy) over a lettered placeholder. q and kind live in the query string; the
// shell's top box submits here with ?q=.
//
// Results are rendered through innerHTML and clicks are delegated (the tests
// run this script in a stub DOM). Every upstream string goes through esc, every
// external href through safeHref, and highlight() escapes the original text
// piece by piece, so no markup can come from data.
import { shell } from '../shell'
import type { UiPage } from './index'
import { TRACK_ROW_CSS, TRACK_ROW_JS } from './track-row'

const TABS: Array<[string, string]> = [['all', 'All'], ['tracks', 'Tracks'], ['sets', 'Sets'], ['djs', 'DJs']]

const BODY = /* html */ `
<div class="sq-bar"><input id="sq" type="search" autofocus autocomplete="off" aria-label="Search tracks, sets, DJs" placeholder="Track, set or DJ" role="combobox" aria-controls="sq-results" aria-expanded="true"></div>
<div id="sq-tabs" class="chips" role="group" aria-label="Result type">${TABS.map(([k, l]) => `<button type="button" class="chip${k === 'all' ? ' on' : ''}" data-kind="${k}" aria-pressed="${k === 'all'}">${l}</button>`).join('')}</div>
<div id="sq-corrected" class="sq-corrected" role="status" hidden></div>
<div id="sq-results" role="listbox" aria-label="Search results"></div>
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
  .sq-sec { margin-bottom: var(--sp-4); min-width: 0; }
  .sq-sec h2 { font-size: var(--fs-sm); color: var(--muted); text-transform: uppercase; letter-spacing: .04em; margin: 0 0 var(--sp-2); }
  .sq-sec h2 .n { font-weight: 400; }
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
  .sq-more { margin: 0 0 var(--sp-2); }
  #sq-empty[hidden] { display: none; }
  ${TRACK_ROW_CSS}
`

const JS = /* js */ `
(() => {
  const $ = TK.$, esc = TK.esc;
${TRACK_ROW_JS}
  const TABS = ${JSON.stringify(TABS)};
  const $sq = $('sq'), $tabs = $('sq-tabs'), $note = $('sq-corrected'), $res = $('sq-results'), $empty = $('sq-empty');
  const EMPTY_HINT = 'Search every verified track list: tracks, sets and DJs.';

  // ── state: q and kind are mirrored to the query string ──
  const known = TABS.map((t) => t[0]);
  let kind = known.indexOf(TK.qs.get('kind') || '') >= 0 ? TK.qs.get('kind') : 'all';
  let exact = false, seq = 0, ctl = null, timer = 0, data = null, tokens = [], active = -1;
  let primaries = [];
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
    return '/ui/api/search?q=' + encodeURIComponent(q) + '&kind=' + encodeURIComponent(k) + '&limit=20' + (ex ? '&exact=1' : '');
  }

  // ── rendering ──
  const setHref = (url) => '/ui/set?url=' + encodeURIComponent(url);
  const ext = (url, label, cls) => { const h = TK.safeHref(url); return h ? '<a class="' + (cls || 'pill') + '" href="' + esc(h) + '" target="_blank" rel="noreferrer noopener">' + esc(label) + '</a>' : ''; };
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
  // A result row: thumbnail, then the body (closed by rowClose).
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
        ' title="' + esc(st && st.indexOf('err:') === 0 ? 'failed: ' + st.slice(4) : 'Look up Apple Music / YouTube links (one 1001tracklists page view, cached 30 days)') + '">' + (st === 'loading' ? '…' : 'links') + '</button>';
    }
    return h;
  }
  function newestSet(t) {
    let best = null;
    for (const s of t.sets || []) if (!best || String(s.date || '') > String(best.date || '')) best = s;
    return best;
  }
  function trackRowHtml(t, n) {
    const best = newestSet(t);
    primaries[n] = best ? setHref(best.url) : (TK.safeHref(t.trackUrl) || '');
    const sets = t.sets || [];
    const open = expanded.has(t.trackKey);
    const lines = open ? '<ul class="sq-sets">' + sets.map((s) =>
      '<li><a href="/ui/dj/' + encodeURIComponent(s.djSlug) + '">' + esc(s.djName) + '</a>' +
      (s.date ? '<span class="muted">' + esc(s.date) + '</span>' : '') +
      (s.cueSeconds != null ? '<span class="sq-cue">' + esc(TK.fmt.clock(s.cueSeconds)) + '</span>' : '') +
      '<a href="' + esc(setHref(s.url)) + '">Set page</a>' + ext(s.url, '1001tl', 'sq-ext') + '</li>').join('') + '</ul>' : '';
    return rowOpen(n, '', t.image, t.artist, 'tracks') +
      '<div class="sq-main">' + tag('tracks') + '<span class="sq-ttl">' + hl(t.artist) + ' – ' + hl(t.title) + '</span>' +
        (t.label ? '<span class="badge neutral">' + hl(t.label) + '</span>' : '') + '</div>' +
      '<div class="sq-acts">' + trackLinks(t) +
        (sets.length ? '<button type="button" class="btn small" data-exp="' + esc(t.trackKey) + '" aria-expanded="' + open + '">' + sets.length + (sets.length === 1 ? ' set' : ' sets') + '</button>' : '') +
      '</div>' + lines + rowClose;
  }
  function setRowHtml(s, n) {
    primaries[n] = setHref(s.url);
    return rowOpen(n, 'data-set-row', s.image, s.djName || s.title, 'sets') +
      '<div class="sq-main">' + tag('sets') + '<span class="sq-ttl"><a href="' + esc(setHref(s.url)) + '">' + hl(s.title) + '</a></span></div>' +
      '<div class="sq-meta"><a href="/ui/dj/' + encodeURIComponent(s.djSlug) + '">' + hl(s.djName) + '</a>' +
        (s.date ? '<span>' + esc(s.date) + '</span>' : '') +
        '<span>' + esc(s.idedCount) + '/' + esc(s.trackCount) + ' IDs</span>' +
        (s.videoId ? '<span class="badge ok">video</span>' : '<span class="badge warn">no video</span>') + '</div>' +
      '<div class="sq-acts"><a class="pill" href="' + esc(setHref(s.url)) + '">Set page</a>' + ext(s.url, '1001tl') + '</div>' + rowClose;
  }
  function djRowHtml(d, n) {
    primaries[n] = '/ui/dj/' + encodeURIComponent(d.slug);
    return rowOpen(n, '', d.image, d.name, 'djs') +
      '<div class="sq-main">' + tag('djs') + '<span class="sq-ttl"><a href="' + esc(primaries[n]) + '">' + hl(d.name) + '</a></span>' +
        (d.subscribed ? '<span class="badge ok">subscribed</span>' : '') + '</div>' +
      '<div class="sq-meta"><span>' + esc(d.sets) + (d.sets === 1 ? ' set' : ' sets') + '</span></div>' +
      '<div class="sq-acts"><a class="pill" href="' + esc(primaries[n]) + '">Profile</a></div>' + rowClose;
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
  // One response: All as one interleaved list with a kind tag on each row; a
  // single tab as its own list under a heading.
  function renderResults(d, groupKind) {
    primaries = [];
    let n = 0;
    if (groupKind === 'all') {
      tagKinds = true;
      return allOrder(d).map((it) => RENDER[it.k](it.x, n++)).join('');
    }
    tagKinds = false;
    const label = { tracks: 'Tracks', sets: 'Sets', djs: 'DJs' }[groupKind];
    const list = d && Array.isArray(d[groupKind]) ? d[groupKind] : [];
    if (!list.length || !label) return '';
    return '<section class="sq-sec" role="presentation"><h2 role="presentation">' + label + ' <span class="n">' + list.length + '</span></h2>' +
      list.map((x) => RENDER[groupKind](x, n++)).join('') + '</section>';
  }

  function renderTabs() {
    $tabs.innerHTML = TABS.map((t) => '<button type="button" class="chip' + (t[0] === kind ? ' on' : '') + '" data-kind="' + t[0] + '" aria-pressed="' + (t[0] === kind) + '">' + t[1] + '</button>').join('');
  }
  function setActive(n) {
    const old = $('sq-r' + active);
    if (old && old.classList && active !== n) { old.classList.remove('on'); old.setAttribute('aria-selected', 'false'); }
    active = n;
    const el = n >= 0 ? $('sq-r' + n) : null;
    if (el && el.classList) { el.classList.add('on'); el.setAttribute('aria-selected', 'true'); if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' }); }
    if (typeof $sq.setAttribute === 'function') { if (n >= 0) $sq.setAttribute('aria-activedescendant', 'sq-r' + n); else if (typeof $sq.removeAttribute === 'function') $sq.removeAttribute('aria-activedescendant'); }
  }
  function paint() {
    $res.innerHTML = data ? renderResults(data, kind) : '';
    setActive(active < primaries.length ? active : -1);
  }
  function showEmpty(text) { $empty.hidden = false; $empty.textContent = text; }
  function showNote(q) {
    const c = !exact && data && Array.isArray(data.corrected) ? data.corrected : [];
    if (!c.length) { $note.hidden = true; $note.innerHTML = ''; return; }
    const to = {};
    for (const x of c) to[x.from] = x.to;
    const shown = wordsOf(q).map((w) => (Object.prototype.hasOwnProperty.call(to, w) ? to[w] : w)).join(' ');
    $note.innerHTML = '<span>Showing results for <strong>' + esc(shown) + '</strong>.</span> <button type="button" id="sq-exact" class="btn small">Search exactly for ' + esc(q) + '</button>';
    $note.hidden = false;
  }

  // ── searching: one request in flight, the newest wins ──
  function sync(q) { TK.qs.set({ q, kind: kind === 'all' ? '' : kind }); }
  async function run() {
    const q = ($sq.value || '').trim();
    const my = ++seq;
    if (ctl) { try { ctl.abort(); } catch (e) {} ctl = null; }
    sync(q);
    // The previous results stay (and stay usable: expand, links) until the reply lands.
    if (!q) { data = null; active = -1; primaries = []; $res.innerHTML = ''; $note.hidden = true; showEmpty(EMPTY_HINT); return; }
    if (typeof AbortController !== 'undefined') ctl = new AbortController();
    const res = await TK.api.get(searchUrl(q, kind, exact), ctl ? { signal: ctl.signal } : undefined);
    if (my !== seq || res.aborted) return;
    ctl = null;
    const d = res.ok && res.data && Array.isArray(res.data.tracks) ? res.data : null;
    active = -1; primaries = [];
    if (!d) {
      data = null; $res.innerHTML = ''; $note.hidden = true;
      showEmpty(res.status === 503 ? 'The search index is not set up on this Worker.' : TK.errText(res, 'Search failed (' + (res.status || 'offline') + ')'));
      return;
    }
    data = d;
    tokens = wordsOf(q);
    if (!exact && Array.isArray(d.corrected)) for (const c of d.corrected) tokens = tokens.concat(wordsOf(c.to));
    showNote(q);
    paint();
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
    if (key === 'ArrowDown' && primaries.length) { stop(); setActive(active + 1 < primaries.length ? active + 1 : 0); }
    else if (key === 'ArrowUp' && primaries.length) { stop(); setActive(active > 0 ? active - 1 : primaries.length - 1); }
    else if (key === 'Enter') {
      stop();
      if (active >= 0 && primaries[active]) { if (typeof location !== 'undefined') location.href = primaries[active]; }
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
  $res.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!t || !t.closest) return;
    const lb = t.closest('[data-links]');
    if (lb && lb.dataset) { lookupLinks(lb.dataset.links); return; }
    const eb = t.closest('[data-exp]');
    if (eb && eb.dataset) { if (expanded.has(eb.dataset.exp)) expanded.delete(eb.dataset.exp); else expanded.add(eb.dataset.exp); paint(); return; }
    const kb = t.closest('[data-kind]');
    if (kb && kb.dataset) { setKind(kb.dataset.kind); return; }
    const row = t.closest('[data-n]');
    if (row && row.dataset) setActive(Number(row.dataset.n));
  });

  // A thumbnail that fails to load is removed, leaving its placeholder (error events do not bubble: capture).
  $res.addEventListener('error', (ev) => { const t = ev && ev.target; if (t && t.tagName === 'IMG' && typeof t.remove === 'function') t.remove(); }, true);

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
