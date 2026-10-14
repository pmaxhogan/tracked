// Pre-save matches (/ui/presave-matches): candidates mkvid found for pre-saved
// tracks 1001tracklists has no YouTube link for (lib/presave-match.ts), waiting
// for the owner's ear. One card per track: the official previews (Apple,
// Deezer, Spotify, Beatport, SoundCloud) and every candidate (a YouTube embed,
// or a clip for a Soulseek file) side by side, all playable here; "Play all"
// starts every one of them at once. Approve / Reject per candidate. A second
// tab lists what was decided (by the owner or automatically).
import { shell } from "../shell";
import { tipAttr } from "../tip";
import type { UiPage } from "./index";
import { PRESAVE_UI_CSS, PRESAVE_UI_JS } from "./presaves";

export const PRESAVE_MATCH_SETTINGS_HREF = "/ui/settings#sf-presave-match";

const BODY = /* html */ `
  <div id="pm-sum" class="ps-headline" role="status"><span class="skel" style="width: 14rem"></span></div>
  <div id="pm-tabs" class="tk-tabbar" role="tablist" aria-label="Pre-save match lists">
    <button type="button" role="tab" id="pm-tab-review" data-tab="review" aria-selected="true" aria-controls="pm-list">To approve</button>
    <button type="button" role="tab" id="pm-tab-decided" data-tab="decided" aria-selected="false" aria-controls="pm-list">Decided</button>
  </div>
  <div id="pm-list" role="tabpanel" aria-live="polite"></div>
`;

const CSS = /* css */ `
  ${PRESAVE_UI_CSS}
  .pm-card { display: grid; gap: var(--sp-3); margin-bottom: var(--sp-4); padding: var(--sp-3) var(--sp-4); }
  .pm-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-2) var(--sp-3); }
  .pm-head .tk-row { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
  .pm-meta { font-size: var(--fs-xs); color: var(--muted); }
  .pm-h { margin: 0; font-size: var(--fs-xs); font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .pm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 17rem), 1fr)); gap: var(--sp-3); }
  .pm-src, .pm-cand { margin: 0; display: grid; gap: 6px; align-content: start; min-width: 0; padding: var(--sp-2); border: 1px solid var(--line); border-radius: var(--r-ctl); background: var(--page); }
  .pm-src figcaption, .pm-cand figcaption { font-size: var(--fs-sm); min-width: 0; overflow-wrap: anywhere; }
  .pm-src audio, .pm-cand audio { width: 100%; }
  .pm-embed { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #000; border-radius: 4px; overflow: hidden; }
  .pm-embed iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
  .pm-facts { display: flex; flex-wrap: wrap; gap: 4px; font-size: var(--fs-xs); }
  .pm-why { font-size: var(--fs-xs); color: var(--muted); }
  .pm-acts { display: flex; gap: var(--sp-2); }
  .pm-acts .btn { flex: 1 1 auto; }
  .pm-none { color: var(--muted); font-size: var(--fs-sm); }
  .pm-warn { color: var(--warn); font-size: var(--fs-sm); }
`;

const JS = /* js */ `
(() => {
${PRESAVE_UI_JS}
  const $ = TK.$, esc = TK.esc;
  const REF = { apple: 'Apple Music preview', deezer: 'Deezer preview', spotify: 'Spotify preview', beatport: 'Beatport sample', soundcloud: 'SoundCloud' };
  const SRC = { ytm: 'YouTube Music', slsk: 'Soulseek', spotify: 'Spotify rip' };
  const DECISION = {
    review: ['Waiting', 'info', 'Waiting for you to listen.'],
    approved: ['Approved', 'ok', 'You approved it.'],
    rejected: ['Rejected', 'neutral', 'You rejected it; it is never analysed again.'],
    auto_approved: ['Auto-approved', 'ok', 'The audio, length and names matched clearly.'],
    auto_rejected: ['Auto-rejected', 'neutral', 'The audio was clearly different from every preview; it is never analysed again.'],
    superseded: ['Not needed', 'neutral', 'Another candidate was approved, or the track got its video meanwhile.'],
  };
  const OUTCOME = { found: 'It is the track\\u2019s video now (liked, pushed).', rip_queued: 'Queued for mkvid to rip and upload.', rip_not_queued: 'Could not be queued for a rip.' };
  const badge = (d) => { const x = DECISION[d] || [String(d), 'neutral', '']; return '<span class="badge ' + x[1] + '"' + TK.tip(x[2]) + '>' + esc(x[0]) + '</span>'; };
  // Scores are hints, never alarms: high is ok, middling warn, low plain.
  const scoreCls = (s) => (s == null ? 'neutral' : s >= 0.7 ? 'ok' : s >= 0.3 ? 'warn' : 'neutral');
  const fmt2 = (n) => (n == null ? '\\u2013' : Number(n).toFixed(2));
  const dur = (s) => (s == null ? '' : TK.fmt.clock(Math.round(Number(s))));
  const delta = (d) => (d == null ? '' : (d > 0 ? '+' : d < 0 ? '\\u2212' : '\\u00b1') + Math.abs(Math.round(d)) + ' s');

  // Clips are served by this app (same origin); everything else must be an http(s) URL.
  const playable = (u) => (/^[/]ui[/]api[/]presave-matches[/]clip[/][a-f0-9-]+$/.test(String(u || '')) ? String(u) : TK.safeHref(u));
  let view = TKTable.qs.get('view') === 'decided' ? 'decided' : 'review';
  const onlyPresave = Number(TKTable.qs.get('presave')) || null;
  let groups = [];

  function refHtml(r) {
    const name = REF[r.kind] || siteName(r.kind);
    const page = TK.safeHref(r.url);
    const play = playable(r.playUrl);
    const cap = page ? '<a href="' + esc(page) + '" target="_blank" rel="noreferrer noopener">' + esc(name) + '</a>' : esc(name);
    const body = play ? '<audio controls preload="none" src="' + esc(play) + '"></audio>'
      : '<span class="pm-none">' + esc(r.ok ? 'Compared, no clip to play here' : 'Not available' + (r.error ? ': ' + r.error : '')) + '</span>';
    return '<figure class="pm-src"><figcaption>' + cap + (r.durationSeconds ? ' <span class="pm-meta">' + esc(dur(r.durationSeconds)) + '</span>' : '') + '</figcaption>' + body + '</figure>';
  }

  function playerHtml(c) {
    if (c.videoId) return '<div class="pm-embed"><iframe src="https://www.youtube-nocookie.com/embed/' + encodeURIComponent(c.videoId) + '?enablejsapi=1&rel=0" allow="autoplay; encrypted-media" allowfullscreen loading="lazy" referrerpolicy="strict-origin-when-cross-origin" data-yt="1" aria-label="' + esc('Candidate video ' + (c.title || c.videoId)) + '"></iframe></div>';
    const clip = playable(c.clipUrl);
    if (clip) return '<audio controls preload="none" src="' + esc(clip) + '"></audio>';
    return '<span class="pm-none">No clip yet (mkvid uploads one after the search).</span>';
  }

  function candHtml(c, decided) {
    const facts = [];
    facts.push('<span class="ps-chip" data-site="' + esc(c.source) + '">' + esc(SRC[c.source] || c.source) + '</span>');
    if (c.isTopic) facts.push('<span class="badge ok"' + TK.tip('A Topic (art track) upload: approving makes it the track\\u2019s video.') + '>Topic</span>');
    if (c.commentsOff) facts.push('<span class="badge ok"' + TK.tip('Comments are off: approving makes it the track\\u2019s video.') + '>Comments off</span>');
    if (c.source === 'ytm' && c.isTopic === false && c.commentsOff === false) facts.push('<span class="badge neutral"' + TK.tip('Not a Topic upload and comments are on: approving has mkvid rip and upload it.') + '>Will be ripped</span>');
    facts.push('<span class="badge ' + scoreCls(c.audioScore) + '"' + TK.tip((c.scores || []).map((s) => (REF[s.ref] || s.ref) + ': ' + fmt2(s.score) + (s.offsetSeconds != null ? ' at ' + dur(Math.max(0, s.offsetSeconds)) : '')).join('; ') || 'No preview could be compared.') + '>Audio ' + esc(fmt2(c.audioScore)) + '</span>');
    if (c.durationSeconds != null) facts.push('<span class="badge neutral"' + TK.tip('Its length' + (c.durationDelta != null ? ', against the track\\u2019s' : '')) + '>' + esc(dur(c.durationSeconds) + (c.durationDelta != null ? ' (' + delta(c.durationDelta) + ')' : '')) + '</span>');
    if (c.nameScore != null) facts.push('<span class="badge neutral"' + TK.tip('How well artist and title match, 0 to 1.') + '>Names ' + esc(fmt2(c.nameScore)) + '</span>');
    const x = c.extra || {};
    if (c.source === 'slsk') facts.push('<span class="pm-meta">' + esc([x.username, x.bitRate ? x.bitRate + ' kbps' : '', x.size ? Math.round(Number(x.size) / 1e6) + ' MB' : ''].filter(Boolean).join(' \\u00b7 ')) + '</span>');
    const href = TK.safeHref(c.url);
    const name = esc(c.title || c.externalId) + (c.artist || c.channelTitle ? ' <span class="pm-meta">' + esc(c.artist || c.channelTitle) + '</span>' : '');
    const cap = href ? '<a href="' + esc(href) + '" target="_blank" rel="noreferrer noopener">' + name + '</a>' : name;
    const acts = decided ? '<div class="pm-facts">' + badge(c.decision) + (c.outcome ? ' <span class="pm-why">' + esc(OUTCOME[c.outcome] || c.outcome) + '</span>' : '') + '</div>'
      : '<div class="pm-acts"><button type="button" class="btn primary" data-act="approve" data-id="' + c.id + '"' + TK.tip('Approve: ' + (c.source === 'ytm' && (c.isTopic || c.commentsOff) ? 'it becomes the track\\u2019s video (liked, pushed).' : 'mkvid rips it and uploads it to the Track uploads playlist.')) + '>Approve</button>' +
        '<button type="button" class="btn ghost" data-act="reject" data-id="' + c.id + '"' + TK.tip('Reject: never offered or analysed again.') + '>Reject</button></div>';
    return '<figure class="pm-cand" data-match="' + c.id + '">' + playerHtml(c) + '<figcaption>' + cap + '</figcaption><div class="pm-facts">' + facts.join('') + '</div>' +
      (c.reason ? '<div class="pm-why">' + esc(c.reason) + '</div>' : '') + acts + '</figure>';
  }

  function cardHtml(g) {
    const p = g.presave;
    const decided = view === 'decided';
    const head = '<div class="pm-head">' + trackCell({ artist: p.artist, title: p.title, artworkUrl: p.artworkUrl }, { href: '/ui/presave?id=' + p.id }) +
      '<div class="tk-row"><span class="pm-meta">' + esc(p.durationSeconds ? 'Track length ' + dur(p.durationSeconds) : 'Track length unknown') + '</span>' +
      '<button type="button" class="btn" data-act="playall" data-presave="' + p.id + '"' + TK.tip('Start every preview and candidate on this card at once.') + '>Play all</button>' +
      '<button type="button" class="btn ghost" data-act="stopall" data-presave="' + p.id + '">Stop all</button></div></div>';
    const refs = g.references && g.references.length ? '<div class="pm-grid">' + g.references.map(refHtml).join('') + '</div>' : '<p class="pm-none">No official preview was found for this track.</p>';
    const warn = g.searchError ? '<p class="pm-warn"' + TK.tip('mkvid tries again by itself later.') + '>Last search did not finish: ' + esc(g.searchError) + '</p>' : '';
    return '<section class="tk-card pm-card" data-presave="' + p.id + '">' + head + warn +
      '<h3 class="pm-h">Previews</h3>' + refs +
      '<h3 class="pm-h">Candidates</h3><div class="pm-grid">' + g.candidates.map((c) => candHtml(c, decided)).join('') + '</div></section>';
  }

  const $list = $('pm-list'), $sum = $('pm-sum');
  function paintSum(counts) {
    if (!$sum) return;
    const n = counts ? Number(counts.presavesInReview) || 0 : 0;
    const parts = [view === 'review'
      ? (n ? '<strong>' + n + '</strong> track' + (n === 1 ? '' : 's') + ' with candidates to approve' : 'Nothing to approve')
      : 'Decided candidates, newest first'];
    if (counts) parts.push(esc(String(counts.auto_approved || 0)) + ' auto-approved, ' + esc(String(counts.auto_rejected || 0)) + ' auto-rejected');
    parts.push('<a href="${PRESAVE_MATCH_SETTINGS_HREF}">Match settings</a>');
    $sum.innerHTML = parts.join('<span aria-hidden="true">\\u00b7</span>');
  }
  async function load() {
    const q = '/ui/api/presave-matches?view=' + view + (onlyPresave ? '&presave=' + onlyPresave : '');
    const res = await TK.api.get(q);
    if (!res.ok) { if ($list) $list.innerHTML = '<p class="pm-none">' + esc(TK.errText(res, 'Could not load the matches (' + res.status + ')')) + '</p>'; return; }
    groups = (res.data && res.data.groups) || [];
    paintSum(res.data && res.data.counts);
    if (!$list) return;
    $list.innerHTML = groups.length ? groups.map(cardHtml).join('')
      : '<p class="pm-none">' + esc(view === 'review' ? 'No candidates wait for you. mkvid searches YouTube Music for pre-saved tracks without a YouTube link; what it cannot decide by itself shows up here.' : 'Nothing decided yet.') + '</p>';
  }

  function cardEls(presaveId) {
    const card = $list && $list.querySelector ? $list.querySelector('section[data-presave="' + presaveId + '"]') : null;
    return card ? { audios: [...card.querySelectorAll('audio')], frames: [...card.querySelectorAll('iframe[data-yt]')] } : { audios: [], frames: [] };
  }
  // The YouTube IFrame API listens for these commands once the embed has enablejsapi=1.
  function ytCommand(frame, func) {
    try { frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func: func, args: [] }), 'https://www.youtube-nocookie.com'); } catch (e) { /* not loaded yet */ }
  }
  function playAll(presaveId) {
    const e = cardEls(presaveId);
    for (const a of e.audios) { try { const p = a.play(); if (p && p.catch) p.catch(() => {}); } catch (err) { /* blocked */ } }
    for (const f of e.frames) ytCommand(f, 'playVideo');
  }
  function stopAll(presaveId) {
    const e = cardEls(presaveId);
    for (const a of e.audios) { try { a.pause(); } catch (err) { /* ignore */ } }
    for (const f of e.frames) ytCommand(f, 'pauseVideo');
  }

  async function decide(act, id, btn) {
    const res = await TK.api.post('/ui/api/presave-matches/' + encodeURIComponent(id) + '/' + act);
    if (res.ok) TK.toast(act === 'approve' ? (res.data && res.data.message ? 'Approved: ' + res.data.message + '.' : 'Approved.') : 'Rejected.', 'ok');
    else TK.toast(TK.errText(res, (act === 'approve' ? 'Approve' : 'Reject') + ' failed (' + res.status + ')'), 'bad');
    await load();
    return res;
  }

  if ($list && typeof $list.addEventListener === 'function') $list.addEventListener('click', (e) => {
    const b = e && e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!b) return;
    const act = b.getAttribute('data-act');
    if (act === 'playall') return playAll(b.getAttribute('data-presave'));
    if (act === 'stopall') return stopAll(b.getAttribute('data-presave'));
    if (act === 'approve' || act === 'reject') {
      const id = b.getAttribute('data-id');
      return TK.busy(b, act === 'approve' ? 'Approving\\u2026' : 'Rejecting\\u2026', () => decide(act, id, b));
    }
  });

  function showTab(t, save) {
    view = t;
    for (const k of ['review', 'decided']) {
      const tab = $('pm-tab-' + k);
      if (tab && tab.setAttribute) tab.setAttribute('aria-selected', k === t ? 'true' : 'false');
    }
    if (save) TKTable.qs.merge({ view: t === 'review' ? null : t });
    return load();
  }
  const $tabs = $('pm-tabs');
  if ($tabs && typeof $tabs.addEventListener === 'function') $tabs.addEventListener('click', (e) => {
    const b = e && e.target && e.target.closest ? e.target.closest('[data-tab]') : null;
    if (b) showTab(b.getAttribute('data-tab'), true);
  });
  showTab(view, false);
})();
`;

export const PRESAVE_MATCHES_PAGE: UiPage = {
  path: "/presave-matches",
  html: shell({
    nav: "presaves",
    title: "Pre-save matches",
    description:
      "Candidates mkvid found on YouTube Music (and Soulseek) for pre-saved tracks with no YouTube link: listen to the previews and the candidates side by side, then approve or reject.",
    actions: `<a class="btn" href="/ui/presaves"${tipAttr("Every pre-saved track.")}>Pre-saves</a><a class="btn ghost" href="${PRESAVE_MATCH_SETTINGS_HREF}"${tipAttr("Search delay, thresholds, Soulseek, pushes.")}>Settings</a>`,
    body: BODY,
    css: CSS,
    js: JS,
  }),
};
