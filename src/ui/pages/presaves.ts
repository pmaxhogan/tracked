// Pre-saves: tracks 1001tracklists has identified (or not yet) but has no
// YouTube video for, watched until it gets one (lib/presave.ts). This module
// holds the list page (/ui/presaves) and the shared client helpers the track
// page (presave.ts) and the Track uploads page (track-uploads.ts) paste into
// their own IIFE. Data: GET /ui/api/presaves (a data-table endpoint, see
// src/lib/table-query.ts) plus the POST /ui/api/presaves* actions.
//
// Page scripts are template literals: no backticks and no dollar-brace inside,
// and every regex backslash is doubled. Upstream text (artist, title, URLs) is
// only placed through TK.esc, hrefs only through TK.safeHref.
import { shell } from '../shell'
import { tipAttr } from '../tip'
import type { UiPage } from './index'

/** Where the presave and track-upload settings groups live (src/ui/pages/settings.ts form ids). */
export const PRESAVE_SETTINGS_HREF = '/ui/settings#sf-presave'
export const TRACK_UPLOADS_SETTINGS_HREF = '/ui/settings#sf-track-uploads'

/** CSS shared by the three pages: track cells, artwork, stage badges, link chips. */
export const PRESAVE_UI_CSS = /* css */ `
  .ps-track { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .ps-art { width: 40px; height: 40px; border-radius: 6px; object-fit: cover; flex: none; background: var(--elev); border: 1px solid var(--line); }
  .ps-art.ph { display: inline-flex; align-items: center; justify-content: center; color: var(--subtle); font-size: .68rem; font-weight: 700; letter-spacing: .04em; }
  .ps-tt { min-width: 0; }
  .ps-name { font-weight: 600; color: var(--fg); overflow-wrap: anywhere; line-height: 1.3; }
  .ps-name a { color: inherit; text-decoration: none; }
  .ps-name a:hover { text-decoration: underline; }
  .ps-sub { font-size: var(--fs-xs); color: var(--muted); overflow-wrap: anywhere; margin-top: 1px; }
  .ps-sub a { color: inherit; text-decoration: none; }
  .ps-sub a:hover { color: var(--accent); text-decoration: underline; }
  @media (min-width: 700px) { .ps-track .ps-tt { min-width: 12rem; } }
  .ps-dj { color: var(--fg); text-decoration: none; white-space: nowrap; }
  .ps-dj:hover { color: var(--accent); text-decoration: underline; }
  .ps-id { display: inline-block; font-size: .64rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; padding: 1px 6px; border-radius: 999px; background: var(--warn-bg); color: var(--warn); vertical-align: 1px; }
  .ps-chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .ps-chip { display: inline-flex; align-items: center; gap: 5px; font-size: .72rem; font-weight: 600; line-height: 1.5; padding: 1px 8px; border: 1px solid var(--line-strong); border-radius: 999px; color: var(--fg); text-decoration: none; white-space: nowrap; background: var(--card); }
  .ps-chip::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--subtle); flex: none; }
  a.ps-chip:hover { border-color: var(--accent); color: var(--accent); }
  .ps-chip .d { color: var(--subtle); font-weight: 500; font-variant-numeric: tabular-nums; }
  .ps-chip[data-site=spotify]::before { background: #1db954; }
  .ps-chip[data-site=apple]::before { background: #fa2d48; }
  .ps-chip[data-site=soundcloud]::before { background: #ff5500; }
  .ps-chip[data-site=youtube]::before { background: #ff0033; }
  .ps-chip[data-site=beatport]::before { background: #01c38d; }
  .ps-chip[data-site=traxsource]::before { background: #3fa9f5; }
  .ps-chip[data-site=bandcamp]::before { background: #629aa9; }
  .ps-chip[data-site=tl]::before { background: var(--accent); }
  .ps-none { color: var(--subtle); font-size: var(--fs-xs); }
  .ps-when { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .ps-res { display: block; font-size: var(--fs-xs); color: var(--muted); white-space: nowrap; }
  .ps-res.bad { color: var(--danger); }
  .ps-res.good { color: var(--ok); }
  .btn.ytm { background: var(--accent-fill); border-color: var(--accent-fill); color: var(--on-accent); }
  .ps-headline { display: flex; flex-wrap: wrap; align-items: center; gap: 6px var(--sp-3); color: var(--muted); font-size: var(--fs-sm); margin-bottom: var(--sp-3); }
  .ps-headline strong { color: var(--fg); font-variant-numeric: tabular-nums; }
  .ps-headline a { color: var(--accent); }
  @media (max-width: 699px) {
    .tkt-table td.ps-lead, .tkt-table td:has(> .ps-track) { justify-content: flex-start; text-align: left; }
    .tkt-table td.ps-lead::before, .tkt-table td:has(> .ps-track)::before { content: none; }
    .tkt-table td:has(> .ps-track) { padding-bottom: 8px; border-bottom: 1px solid var(--line); margin-bottom: 2px; }
    .tkt-table .ps-chips { justify-content: flex-end; }
  }
`

/**
 * Helpers for the page IIFEs (needs TK). Declares: STAGE, STAGE_OPTS, RESULT,
 * RESULT_OPTS, SITE, LINK_OPTS, isId, trackLabel, stageBadge, resultText,
 * resultCls, artHtml, trackCell, linkChips, siteName, rel, when, whenCell,
 * fmtCue, go, djHref, setHref.
 */
export const PRESAVE_UI_JS = /* js */ `
  const STAGE = {
    identify: ['Waiting for ID', 'warn', 'Not identified on 1001tracklists yet. Its set is read again until the row has a track.'],
    links: ['Watching', 'info', 'Identified, with no YouTube link yet. Looked up again on a schedule.'],
    found: ['On YouTube', 'ok', '1001tracklists has a YouTube link for it now.'],
    uploaded: ['Ripped & uploaded', 'ok', 'mkvid ripped it from another site and uploaded it to the Track uploads playlist.'],
    dismissed: ['Dismissed', 'neutral', 'No longer watched. Restore it to watch it again.'],
  };
  const STAGE_OPTS = ['identify', 'links', 'found', 'uploaded', 'dismissed'].map((v) => ({ value: v, label: STAGE[v][0] }));
  const RESULT = {
    found: ['YouTube link found', 'good'],
    no_youtube: ['No YouTube link yet', ''],
    identified: ['Identified', 'good'],
    still_id: ['Still an ID', ''],
    row_missing: ['Row not found in the set', 'bad'],
    uploaded: ['Ripped and uploaded', 'good'],
    pool_refused: ['Pool busy, try later', 'bad'],
    error: ['Error', 'bad'],
    added: ['Added', ''],
    gave_up: ['Gave up', 'bad'],
  };
  const RESULT_OPTS = Object.keys(RESULT).map((v) => ({ value: v, label: RESULT[v][0] }));
  const SITE = { spotify: 'Spotify', apple: 'Apple Music', soundcloud: 'SoundCloud', beatport: 'Beatport', traxsource: 'Traxsource', youtube: 'YouTube', bandcamp: 'Bandcamp', hearthis: 'hearthis.at', mixcloud: 'Mixcloud', none: 'No links' };
  const LINK_OPTS = ['spotify', 'apple', 'soundcloud', 'beatport', 'traxsource', 'youtube', 'none'].map((v) => ({ value: v, label: SITE[v] }));
  // Why maybeQueueTrackUpload did not queue (lib/track-uploads.ts QueueReason).
  const QUEUE_WHY = { disabled: 'track uploads are off', not_found: 'the pre-save is gone', stage: 'the track is not being watched', has_youtube: 'it has a YouTube link now', too_new: 'it has not been watched long enough yet', already_live: 'another request for it is live', no_source: 'no other allowed source that is not banned', error: 'an error', already_uploaded: 'it was already ripped and uploaded' };
  const queueWhy = (r) => QUEUE_WHY[r] || String(r || 'unknown');
  const siteName = (n) => SITE[n] || String(n || '').replace(/^src/, 'source ');
  const isId = (s) => s == null || String(s).trim() === '' || String(s).trim().toUpperCase() === 'ID';
  const trackLabel = (p) => (isId(p.artist) ? 'ID' : String(p.artist)) + ' \\u2013 ' + (isId(p.title) ? 'ID' : String(p.title));
  const stageBadge = (s) => { const x = STAGE[s] || [String(s || '?'), 'neutral', '']; return '<span class="badge ' + x[1] + '"' + TK.tip(x[2]) + '>' + TK.esc(x[0]) + '</span>'; };
  const resultText = (r) => (RESULT[r] ? RESULT[r][0] : String(r || ''));
  const resultCls = (r) => (RESULT[r] ? RESULT[r][1] : '');
  function fmtCue(s) { return s == null || isNaN(s) ? '' : TK.fmt.clock(Number(s)); }
  function when(ms) { if (ms == null) return ''; try { return new Date(ms).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return String(ms); } }
  function rel(ms) {
    if (ms == null) return '';
    const d = ms - Date.now(), m = Math.round(Math.abs(d) / 60000);
    if (m < 1) return d >= 0 ? 'any moment' : 'just now';
    const s = m < 60 ? m + ' min' : m < 2880 ? Math.round(m / 60) + ' h' : Math.round(m / 1440) + ' d';
    return d >= 0 ? 'in ' + s : s + ' ago';
  }
  const whenCell = (ms, empty) => (ms == null ? '<span class="tkt-nil">' + TK.esc(empty || '\\u2013') + '</span>' : '<span class="ps-when"' + TK.tip(when(ms)) + '>' + TK.esc(rel(ms)) + '</span>');
  const djHref = (slug) => '/ui/dj/' + encodeURIComponent(slug);
  const setHref = (url) => '/ui/set?url=' + encodeURIComponent(url);
  function go(href) { if (typeof location !== 'undefined') location.href = href; }
  function artHtml(url, cls) {
    const src = TK.safeHref(url);
    const c = 'ps-art' + (cls ? ' ' + cls : '');
    return src ? '<img class="' + c + '" src="' + TK.esc(src) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : '<span class="' + c + ' ph" aria-hidden="true">ID</span>';
  }
  // A broken cover becomes the placeholder (error events do not bubble: capture).
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('error', (e) => {
      const t = e && e.target;
      if (!t || t.tagName !== 'IMG' || !t.classList || !t.classList.contains('ps-art') || typeof document.createElement !== 'function') return;
      const ph = document.createElement('span');
      ph.className = t.className + ' ph'; ph.textContent = 'ID';
      if (t.replaceWith) t.replaceWith(ph);
    }, true);
  }
  // Artwork, "Artist \\u2013 Title" (an unknown part reads ID) and one line of context.
  // opts.href links the name; opts.noSet leaves the set out of the context line.
  function trackCell(p, opts) {
    opts = opts || {};
    const unk = isId(p.artist) && isId(p.title);
    const name = unk ? '<span class="ps-id">ID</span>' : TK.esc(isId(p.artist) ? 'ID' : p.artist) + ' \\u2013 ' + (isId(p.title) ? '<span class="ps-id">ID</span>' : TK.esc(p.title));
    const sub = [];
    if (p.label) sub.push(TK.esc(p.label));
    const setName = p.setUrl ? TK.esc(TK.fmt.setLabel(p.setUrl)) : '';
    if (p.setUrl && !opts.noSet) sub.push((p.cueSeconds != null ? 'at ' + TK.esc(fmtCue(p.cueSeconds)) + ' in ' : '') + (opts.setLink ? '<a href="' + TK.esc(setHref(p.setUrl)) + '">' + setName + '</a>' : setName));
    else if (p.cueSeconds != null && unk) sub.push('at ' + TK.esc(fmtCue(p.cueSeconds)));
    return '<div class="ps-track">' + artHtml(p.artworkUrl) + '<div class="ps-tt"><div class="ps-name">' + (opts.href ? '<a href="' + TK.esc(opts.href) + '">' + name + '</a>' : name) + '</div>' +
      (sub.length ? '<div class="ps-sub">' + sub.join(' \\u00b7 ') + '</div>' : '') + '</div></div>';
  }
  // One pill per linked site (the first entry of each), linking out. opts.dur adds the length; opts.tl adds 1001tracklists.
  function linkChips(p, opts) {
    opts = opts || {};
    const seen = {}, out = [];
    for (const l of p.links || []) {
      if (!l || !l.name || seen[l.name]) continue;
      seen[l.name] = 1;
      const href = TK.safeHref(l.url);
      const dur = opts.dur && l.duration ? ' <span class="d">' + TK.esc(TK.fmt.clock(l.duration)) + '</span>' : '';
      const inner = TK.esc(siteName(l.name)) + dur;
      out.push(href ? '<a class="ps-chip" data-site="' + TK.esc(l.name) + '" href="' + TK.esc(href) + '" target="_blank" rel="noreferrer noopener"' + TK.tip('Open it on ' + siteName(l.name)) + '>' + inner + '</a>'
        : '<span class="ps-chip" data-site="' + TK.esc(l.name) + '">' + inner + '</span>');
    }
    if (!out.length) for (const n of p.linkSources || []) if (n !== 'none' && !seen[n]) { seen[n] = 1; out.push('<span class="ps-chip" data-site="' + TK.esc(n) + '">' + TK.esc(siteName(n)) + '</span>'); }
    if (opts.tl) { const tl = TK.safeHref(p.trackUrl); if (tl) out.push('<a class="ps-chip" data-site="tl" href="' + TK.esc(tl) + '" target="_blank" rel="noreferrer noopener"' + TK.tip('The track page on 1001tracklists') + '>1001tracklists</a>'); }
    return out.length ? '<div class="ps-chips">' + out.join('') + '</div>' : '<span class="ps-none">no links yet</span>';
  }
  // One sentence for a check, for a toast.
  function checkSentence(check, p) {
    if (!check) return 'Checked.';
    let s = resultText(check.result);
    if (check.result === 'no_youtube' && check.linkCount) s += ': ' + check.linkCount + ' other link' + (check.linkCount === 1 ? '' : 's') + ' (' + (check.linkSources || []).map(siteName).join(', ') + ')';
    if (check.error) s += ': ' + check.error;
    if (p && p.nextCheckAt && (p.stage === 'identify' || p.stage === 'links')) s += '. Next check ' + rel(p.nextCheckAt) + '.';
    return s;
  }
  // POST recheck; a toast with the result (503 pool_busy still recorded a check). Returns the answer.
  async function recheckPresave(id) {
    const res = await TK.api.post('/ui/api/presaves/' + encodeURIComponent(id) + '/recheck');
    const d = res.data && typeof res.data === 'object' ? res.data : {};
    if (res.ok) {
      const p = d.presave || {};
      TK.toast(checkSentence(d.check, p), 'ok', null, p.youtubeMusicUrl ? { href: p.youtubeMusicUrl, text: 'Open in YouTube Music' } : null);
    } else TK.toast(TK.errText(res, 'Recheck failed (' + res.status + ')'), 'bad');
    return res;
  }
`

const BODY = /* html */ `
  <form id="ps-add" class="tk-card ps-add" autocomplete="off" novalidate>
    <div class="ps-add-row">
      <label class="ps-add-url"><span class="lbl">Pre-save a track</span><input id="ps-add-url" type="text" inputmode="url" placeholder="1001tracklists track URL, or a set URL with a cue" aria-label="1001tracklists track or set URL"></label>
      <label class="ps-add-cue"><span class="lbl">Cue</span><input id="ps-add-cue" type="text" placeholder="1:02:30" aria-label="Cue in the set (for a set URL)"></label>
      <button type="submit" id="ps-add-go" class="btn primary"${tipAttr('Saves it and looks it up right away (one 1001tracklists lookup).')}>Pre-save</button>
    </div>
    <p id="ps-add-msg" class="ps-add-msg" role="status"></p>
  </form>
  <div id="ps-views" class="chips ps-views" role="group" aria-label="List">
    <button type="button" class="chip on" data-view="saved" aria-pressed="true"${tipAttr('Tracks you pre-saved: watched until YouTube has them.')}>Pre-saved</button>
    <button type="button" class="chip" data-view="candidates" aria-pressed="false"${tipAttr('Tracks people pre-saved on Spotify that have no YouTube or Spotify link yet, read off your verified sets every time one is rechecked.')}>Candidates</button>
  </div>
  <div id="ps-table"></div>
  <div id="ps-cand" hidden></div>
`

const CSS = /* css */ `
  ${PRESAVE_UI_CSS}
  .ps-add { margin-bottom: var(--sp-4); padding: var(--sp-3) var(--sp-4); }
  .ps-add-row { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--sp-2) var(--sp-3); }
  .ps-add label { display: grid; gap: 4px; min-width: 0; }
  .ps-add .lbl { font-size: var(--fs-xs); font-weight: 600; color: var(--muted); }
  .ps-add input { font: inherit; font-size: var(--fs-sm); color: var(--fg); background: var(--page); border: 1px solid var(--line-strong); border-radius: var(--r-ctl); padding: 8px 10px; min-width: 0; width: 100%; }
  .ps-add-url { flex: 1 1 22rem; }
  .ps-add-cue { flex: 0 0 7.5rem; }
  .ps-add-msg { margin: var(--sp-2) 0 0; font-size: var(--fs-sm); color: var(--muted); }
  .ps-add-msg:empty { display: none; }
  .ps-views { margin-bottom: var(--sp-3); }
  .ps-count { font-weight: 700; font-variant-numeric: tabular-nums; color: var(--fg); white-space: nowrap; }
  .ps-count .u { font-weight: 500; color: var(--muted); font-size: var(--fs-xs); margin-left: 3px; }
  .ps-add-msg.bad { color: var(--danger); }
  .ps-add-msg a { color: var(--accent); }
  @media (max-width: 699px) { .ps-add-cue { flex: 1 1 6rem; } .ps-add-row .btn { flex: 1 1 8rem; } }
`

const JS = /* js */ `
(() => {
${PRESAVE_UI_JS}
  const $ = TK.$, esc = TK.esc;
  const sum = (c, keys) => (c ? keys.reduce((n, k) => n + (Number(c[k]) || 0), 0) : 0);
  const counts = (keys) => (resp) => sum(resp && resp.counts, keys);

  const table = TKTable.create($('ps-table'), {
    id: 'ps',
    source: { url: '/ui/api/presaves' },
    columns: [
      { key: 'title', label: 'Track', type: 'text', render: (p) => trackCell(p, { href: '/ui/presave?id=' + p.id, setLink: true }) },
      { key: 'stage', label: 'Stage', type: 'enum', options: STAGE_OPTS, render: (p) => stageBadge(p.stage) },
      { key: 'linkSources', label: 'Linked on', type: 'enum', multi: true, sortable: false, options: LINK_OPTS, render: (p) => linkChips(p), tip: 'Every site 1001tracklists links this track on.' },
      { key: 'djSlug', label: 'DJ', type: 'text', hideOn: 'phone', render: (p) => (p.djSlug ? '<a class="ps-dj" href="' + esc(djHref(p.djSlug)) + '">' + esc(p.djSlug) + '</a>' : '<span class="tkt-nil">\\u2013</span>') },
      { key: 'createdAt', label: 'Added', type: 'datetime', hideOn: 'phone', render: (p) => whenCell(p.createdAt) },
      { key: 'lastCheckedAt', label: 'Last check', type: 'datetime', render: (p) => '<div>' + whenCell(p.lastCheckedAt, 'never') + (p.lastResult ? '<span class="ps-res ' + resultCls(p.lastResult) + '"' + TK.tip(p.lastError || '') + '>' + esc(resultText(p.lastResult)) + '</span>' : '') + '</div>' },
      { key: 'nextCheckAt', label: 'Next check', type: 'datetime', hideOn: 'phone', render: (p) => '<div>' + whenCell(p.nextCheckAt, p.stage === 'found' || p.stage === 'uploaded' ? 'done' : 'not scheduled') +
          '<span class="ps-res">' + esc(p.checkCount + (p.checkCount === 1 ? ' check' : ' checks')) + '</span></div>' },
    ],
    defaultSort: '-createdAt',
    search: 'Search artist, title, DJ or set',
    chips: [
      { id: 'watching', label: 'Watching', group: 'stage', on: true, filters: [{ col: 'stage', op: 'in', value: 'identify|links' }], count: counts(['identify', 'links']), tip: 'Waiting for an ID or for a YouTube link.' },
      { id: 'onyt', label: 'On YouTube', group: 'stage', filters: [{ col: 'stage', op: 'in', value: 'found|uploaded' }], sort: '-foundAt,-createdAt', count: counts(['found', 'uploaded']) },
      { id: 'id', label: 'Waiting for ID', group: 'stage', filters: [{ col: 'stage', op: 'in', value: 'identify' }], count: counts(['identify']) },
      { id: 'ripped', label: 'Ripped', group: 'stage', filters: [{ col: 'stage', op: 'in', value: 'uploaded' }], count: counts(['uploaded']), tip: 'Ripped from another site and uploaded by mkvid.' },
      { id: 'dismissed', label: 'Dismissed', group: 'stage', filters: [{ col: 'stage', op: 'in', value: 'dismissed' }], count: counts(['dismissed']) },
      { id: 'all', label: 'All', group: 'stage', count: counts(['identify', 'links', 'found', 'uploaded', 'dismissed']) },
    ],
    rowKey: 'id',
    rowAttrs: (p) => ({ 'data-stage': p.stage }),
    empty: 'Nothing pre-saved here. Pre-save a track from a set, a DJ profile, Tasker or the box above.',
    onRowClick: (p) => go('/ui/presave?id=' + p.id),
    actions: (p) => {
      let h = '';
      const ytm = TK.safeHref(p.youtubeMusicUrl);
      if (ytm) h += '<a class="btn ytm" href="' + esc(ytm) + '" target="_blank" rel="noreferrer noopener"' + TK.tip('Open it in YouTube Music') + '>YouTube Music</a>';
      if (p.stage === 'identify' || p.stage === 'links') {
        h += '<button type="button" class="btn" data-act="recheck"' + TK.tip('Recheck now: look it up on 1001tracklists (one pool fetch).') + '>Recheck</button>';
        h += '<button type="button" class="btn ghost" data-act="dismiss"' + TK.tip('Stop watching it.') + '>Dismiss</button>';
      }
      if (p.stage === 'dismissed') h += '<button type="button" class="btn" data-act="restore"' + TK.tip('Watch it again.') + '>Restore</button>';
      return h;
    },
    onAction: (act, p, btn) => {
      if (act === 'recheck') return TK.busy(btn, 'Checking\\u2026', async () => { await recheckPresave(p.id); table.reload(); });
      if (act === 'dismiss' || act === 'restore') return TK.busy(btn, act === 'dismiss' ? 'Dismissing\\u2026' : 'Restoring\\u2026', async () => {
        const res = await TK.api.post('/ui/api/presaves/' + p.id + '/' + act);
        if (res.ok) TK.toast((act === 'dismiss' ? 'Dismissed: ' : 'Watching again: ') + trackLabel(p));
        else TK.toast(TK.errText(res, act + ' failed (' + res.status + ')'), 'bad');
        table.reload();
      });
    },
  });

  // ── candidates: tracks people pre-saved on Spotify, no YouTube or Spotify link yet ──
  // Made the first time the tab is shown: the default view costs no extra request.
  let candTable = null;
  const candOpts = {
    id: 'pc',
    source: { url: '/ui/api/presaves/candidates' },
    columns: [
      { key: 'title', label: 'Track', type: 'text', render: (c) => trackCell(c, { href: c.presaveId ? '/ui/presave?id=' + c.presaveId : (TK.safeHref(c.trackUrl) || null), setLink: true }) },
      { key: 'presaveCount', label: 'Spotify pre-saves', type: 'number', render: (c) => '<span class="ps-count">' + esc(String(c.presaveCount)) + '<span class="u">' + (c.presaveCount === 1 ? 'person' : 'people') + '</span></span>', tip: 'People who pre-saved the Spotify release on 1001tracklists, as of the last time the set was fetched.' },
      { key: 'presaved', label: 'Stage', type: 'bool', render: (c) => (c.presaveId ? stageBadge(c.presaveStage) : '<span class="badge neutral"' + TK.tip('Not pre-saved yet.') + '>Candidate</span>') },
      { key: 'isId', label: 'Kind', type: 'bool', hideOn: 'phone', render: (c) => (c.isId ? '<span class="badge warn"' + TK.tip('Not identified yet: pre-saving it watches the row until it is.') + '>ID</span>' : 'Track') },
      { key: 'djSlug', label: 'DJ', type: 'text', hideOn: 'phone', render: (c) => (c.djSlug ? '<a class="ps-dj" href="' + esc(djHref(c.djSlug)) + '">' + esc(c.djSlug) + '</a>' : '<span class="tkt-nil">–</span>') },
      { key: 'firstSeenAt', label: 'First seen', type: 'datetime', hideOn: 'phone', render: (c) => whenCell(c.firstSeenAt) },
      { key: 'updatedAt', label: 'Count from', type: 'datetime', render: (c) => whenCell(c.updatedAt), tip: 'When the set this count was read from was last fetched.' },
    ],
    defaultSort: '-presaveCount',
    search: 'Search artist, title, label, DJ or set',
    chips: [
      { id: 'new', label: 'Not pre-saved', group: 'p', on: true, filters: [{ col: 'presaved', op: 'eq', value: '0' }] },
      { id: 'saved', label: 'Pre-saved', group: 'p', filters: [{ col: 'presaved', op: 'eq', value: '1' }] },
      { id: 'all', label: 'All', group: 'p' },
      { id: 'named', label: 'Identified only', filters: [{ col: 'isId', op: 'eq', value: '0' }] },
    ],
    rowKey: 'key',
    empty: 'No candidates yet. They are read off verified set pages, so the list fills as sets are rechecked.',
    actions: (c) => (c.presaveId
      ? '<a class="btn" href="/ui/presave?id=' + esc(String(c.presaveId)) + '">Open</a>'
      : '<button type="button" class="btn primary" data-act="presave"' + TK.tip('Pre-save it: watched until YouTube has it.') + '>Pre-save</button>'),
    onAction: (act, c, btn) => {
      if (act !== 'presave') return;
      const body = c.trackId
        ? { trackId: c.trackId, trackUrl: c.trackUrl, artist: c.artist, title: c.title, artworkUrl: c.artworkUrl, setUrl: c.setUrl, label: c.label, djSlug: c.djSlug }
        : { tracklistUrl: c.setUrl, rowIndex: c.rowIndex, cueSeconds: c.cueSeconds, artist: c.artist, title: c.title, artworkUrl: c.artworkUrl, setUrl: c.setUrl, label: c.label, djSlug: c.djSlug };
      return TK.busy(btn, 'Saving…', async () => {
        const res = await TK.api.post('/ui/api/presaves', body);
        const d = res.data && typeof res.data === 'object' ? res.data : {};
        if (res.ok && d.presave) TK.toast(d.message || 'Pre-saved.', 'ok', null, { href: '/ui/presave?id=' + d.presave.id, text: 'Open it' });
        else TK.toast(TK.errText(res, 'Could not pre-save it (' + res.status + ').'), 'bad');
        if (candTable) candTable.reload();
        table.reload();
      });
    },
  };

  // ── which list: ?view=candidates ──
  const $views = $('ps-views');
  function setView(v) {
    const cand = v === 'candidates';
    const t = $('ps-table'), k = $('ps-cand');
    if (t) t.hidden = cand;
    if (k) k.hidden = !cand;
    if (cand && !candTable) candTable = TKTable.create(k, candOpts);
    if ($views) for (const b of $views.querySelectorAll('[data-view]')) { const on = b.dataset.view === (cand ? 'candidates' : 'saved'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
    TKTable.qs.merge({ view: cand ? 'candidates' : '' });
  }
  if ($views && typeof $views.addEventListener === 'function') $views.addEventListener('click', (e) => { const b = e.target && e.target.closest ? e.target.closest('[data-view]') : null; if (b) setView(b.dataset.view); });
  setView(TK.qs.get('view') === 'candidates' ? 'candidates' : 'saved');

  // ── add from the web ──
  const $form = $('ps-add'), $url = $('ps-add-url'), $cue = $('ps-add-cue'), $go = $('ps-add-go'), $msg = $('ps-add-msg');
  // "1:02:30", "62:30" or plain seconds; null when it is not a time.
  function parseCue(s) {
    const t = String(s || '').trim();
    if (!t) return null;
    if (!/^[0-9]+(:[0-9]{1,2}){0,2}$/.test(t)) return NaN;
    return t.split(':').reduce((n, x) => n * 60 + Number(x), 0);
  }
  function bodyFor(raw, cueRaw) {
    const v = String(raw || '').trim();
    if (!v) return { error: 'Paste a 1001tracklists track or set URL.' };
    if (/^[0-9]+$/.test(v)) return { body: { trackId: v } };
    if (!/^https?:[/][/]([a-z0-9-]+[.])*1001tracklists[.]com[/]/i.test(v)) return { error: 'That is not a 1001tracklists URL.' };
    if (/[/]track[/]/i.test(v)) return { body: { trackUrl: v } };
    if (/[/]tracklist[/]/i.test(v)) {
      const cue = parseCue(cueRaw);
      if (cue == null) return { error: 'For a set URL, add the cue of the track in the set (for example 1:02:30).' };
      if (isNaN(cue)) return { error: 'The cue reads like 1:02:30, 62:30 or a number of seconds.' };
      return { body: { tracklistUrl: v, cueSeconds: cue } };
    }
    return { error: 'Paste a /track/ or a /tracklist/ URL from 1001tracklists.' };
  }
  function say(text, bad, link) {
    if (!$msg) return;
    $msg.className = 'ps-add-msg' + (bad ? ' bad' : '');
    $msg.innerHTML = esc(text) + (link ? ' <a href="' + esc(link.href) + '">' + esc(link.text) + '</a>' : '');
  }
  async function add() {
    const b = bodyFor($url && $url.value, $cue && $cue.value);
    if (b.error) { say(b.error, true); return; }
    await TK.busy($go, 'Saving\\u2026', async () => {
      const res = await TK.api.post('/ui/api/presaves', b.body);
      const d = res.data && typeof res.data === 'object' ? res.data : {};
      if (!res.ok || !d.presave) { say(TK.errText(res, 'Could not pre-save it (' + res.status + ').'), true); return; }
      say(d.message || 'Pre-saved.', false, { href: '/ui/presave?id=' + d.presave.id, text: 'Open it' });
      if ($url) $url.value = '';
      if ($cue) $cue.value = '';
      table.reload();
    });
  }
  if ($form && typeof $form.addEventListener === 'function') $form.addEventListener('submit', (e) => { if (e && e.preventDefault) e.preventDefault(); add(); });
})();
`

export const PRESAVES_PAGE: UiPage = {
  path: '/presaves',
  html: shell({
    nav: 'presaves',
    title: 'Pre-saves',
    description: 'Tracks with no YouTube video yet, looked up again until 1001tracklists links one. Found ones push to every device.',
    actions: `<a class="btn" href="/ui/track-uploads"${tipAttr('Tracks mkvid rips from another site when YouTube never gets one.')}>Track uploads</a><a class="btn ghost" href="${PRESAVE_SETTINGS_HREF}"${tipAttr('How often tracks are looked up, pushes, giving up.')}>Settings</a>`,
    body: BODY,
    css: CSS,
    js: JS,
  }),
}
