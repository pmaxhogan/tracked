// Track uploads (/ui/track-uploads): pre-saved tracks YouTube never got, that
// mkvid rips from another site (SoundCloud, Bandcamp, ...) and uploads into
// the "Track uploads" playlist (lib/track-uploads.ts). Two tabs: the requests
// (a TKTable over GET /ui/api/track-uploads, with counts and today's claims)
// and the banned source URLs (GET /ui/api/track-uploads/bans).
import { shell } from '../shell'
import { tipAttr } from '../tip'
import type { UiPage } from './index'
import { PRESAVE_UI_CSS, PRESAVE_UI_JS, TRACK_UPLOADS_SETTINGS_HREF } from './presaves'

const BODY = /* html */ `
  <div id="tu-sum" class="ps-headline" role="status"><span class="skel" style="width: 14rem"></span></div>
  <div id="tu-tabs" class="tk-tabbar" role="tablist" aria-label="Track upload lists">
    <button type="button" role="tab" id="tu-tab-up" data-tab="up" aria-selected="true" aria-controls="tu-p-up">Uploads</button>
    <button type="button" role="tab" id="tu-tab-bans" data-tab="bans" aria-selected="false" aria-controls="tu-p-bans">Banned links</button>
  </div>
  <div id="tu-p-up" role="tabpanel" aria-labelledby="tu-tab-up"><div id="tu-table"></div></div>
  <div id="tu-p-bans" role="tabpanel" aria-labelledby="tu-tab-bans" hidden>
    <form id="tu-ban" class="tk-card tu-ban" autocomplete="off" novalidate>
      <label class="tu-ban-url"><span class="lbl">Ban a source URL</span><input id="tu-ban-url" type="text" inputmode="url" placeholder="https://soundcloud.com/artist/track" aria-label="Source URL to ban"></label>
      <label class="tu-ban-why"><span class="lbl">Reason (optional)</span><input id="tu-ban-why" type="text" maxlength="500" placeholder="preview clip, wrong track" aria-label="Why it is banned"></label>
      <button type="submit" id="tu-ban-go" class="btn danger"${tipAttr('mkvid never rips this URL. Requests waiting on it are banned and the next allowed source is queued.')}>Ban</button>
      <p id="tu-ban-msg" class="tu-ban-msg" role="status"></p>
    </form>
    <div id="tb-table"></div>
  </div>
`

const CSS = /* css */ `
  ${PRESAVE_UI_CSS}
  .tu-src { min-width: 0; }
  .tu-src .u { display: block; font-size: var(--fs-xs); font-family: var(--mono); color: var(--muted); max-width: 11rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tu-src .u a { color: inherit; text-decoration: none; }
  .tu-src .u a:hover { color: var(--accent); text-decoration: underline; }
  .tkt-table td .btn.ytm { padding: 5px 10px; font-size: var(--fs-xs); white-space: nowrap; }
  .tu-tries { font-size: var(--fs-xs); color: var(--muted); white-space: nowrap; }
  .tu-err { display: block; color: var(--danger); font-size: var(--fs-xs); max-width: 11rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tu-ban { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--sp-2) var(--sp-3); margin-bottom: var(--sp-4); padding: var(--sp-3) var(--sp-4); }
  .tu-ban label { display: grid; gap: 4px; min-width: 0; }
  .tu-ban .lbl { font-size: var(--fs-xs); font-weight: 600; color: var(--muted); }
  .tu-ban input { font: inherit; font-size: var(--fs-sm); color: var(--fg); background: var(--page); border: 1px solid var(--line-strong); border-radius: var(--r-ctl); padding: 8px 10px; min-width: 0; width: 100%; }
  .tu-ban-url { flex: 2 1 20rem; }
  .tu-ban-why { flex: 1 1 12rem; }
  .tu-ban-msg { flex-basis: 100%; margin: 0; font-size: var(--fs-sm); color: var(--muted); }
  .tu-ban-msg:empty { display: none; }
  .tu-ban-msg.bad { color: var(--danger); }
  .tu-dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px var(--sp-3); margin: var(--sp-3) 0; font-size: var(--fs-sm); }
  .tu-dl dt { color: var(--muted); }
  .tu-dl dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .tu-dl .bad { color: var(--danger); }
  .tu-dact { display: grid; gap: var(--sp-2); margin-top: var(--sp-3); }
  .tu-dact label { display: grid; gap: 4px; font-size: var(--fs-xs); font-weight: 600; color: var(--muted); }
  .tu-dact input { font: inherit; font-size: var(--fs-sm); color: var(--fg); background: var(--page); border: 1px solid var(--line-strong); border-radius: var(--r-ctl); padding: 8px 10px; }
  .tu-dact .tk-row .btn { flex: 1 1 auto; }
  .tu-dact .bad { color: var(--danger); font-size: var(--fs-sm); }
`

const JS = /* js */ `
(() => {
${PRESAVE_UI_JS}
  const $ = TK.$, esc = TK.esc;
  const STATUS = {
    pending: ['Waiting', 'info', 'Waiting for mkvid to claim it (or for its retry time).'],
    claimed: ['Ripping', 'warn', 'mkvid claimed it and is ripping, rendering or uploading it.'],
    done: ['Uploaded', 'ok', 'On YouTube, in the Track uploads playlist.'],
    failed: ['Failed', 'bad', 'Gave up after its attempts, or a permanent error.'],
    banned: ['Banned', 'bad', 'Its source URL is banned.'],
    superseded: ['Not needed', 'neutral', '1001tracklists got a YouTube link first, or the pre-save went away.'],
  };
  const STATUS_OPTS = Object.keys(STATUS).map((v) => ({ value: v, label: STATUS[v][0] }));
  const SOURCE_OPTS = ['soundcloud', 'bandcamp', 'hearthis', 'mixcloud'].map((v) => ({ value: v, label: siteName(v) }));
  const badge = (s) => { const x = STATUS[s] || [String(s), 'neutral', '']; return '<span class="badge ' + x[1] + '"' + TK.tip(x[2]) + '>' + esc(x[0]) + '</span>'; };
  const short = (u) => String(u || '').replace(/^https?:[/][/](www[.])?/, '');
  const nil = '<span class="tkt-nil">\\u2013</span>';
  const count = (k) => (resp) => (resp && resp.counts ? Number(resp.counts[k]) || 0 : 0);
  const canBan = (u) => !u.sourceBanned && u.status !== 'banned' && u.status !== 'superseded' && u.status !== 'done';

  // ── header: today's claims, the playlist, the settings ──
  const $head = $('tu-sum');
  let today = null, playlist = null;
  function paintHead() {
    if (!$head) return;
    const parts = [];
    if (today) parts.push('Today <strong>' + esc(String(today.claims)) + ' / ' + esc(String(today.cap)) + '</strong> track uploads claimed' + (today.cap === 0 ? ' (cap 0: paused)' : ''));
    if (playlist) {
      const href = TK.safeHref(playlist.url);
      parts.push(href ? 'Playlist <a href="' + esc(href) + '" target="_blank" rel="noreferrer noopener">' + esc(playlist.title) + '</a>' : 'Playlist ' + esc(playlist.title) + ' (created with the first upload)');
    }
    parts.push('<a href="${TRACK_UPLOADS_SETTINGS_HREF}">Track upload settings</a>');
    $head.innerHTML = parts.join('<span aria-hidden="true">\\u00b7</span>');
  }
  TK.api.get('/ui/api/track-uploads/playlist').then((r) => { if (r && r.ok && r.data) { playlist = r.data; paintHead(); } }).catch(() => {});

  // ── uploads ──
  const uploads = TKTable.create($('tu-table'), {
    id: 'tu',
    source: { url: '/ui/api/track-uploads' },
    columns: [
      { key: 'title', label: 'Track', type: 'text', render: (u) => trackCell({ artist: u.artist, title: u.title, artworkUrl: u.artworkUrl }, { href: '/ui/presave?id=' + u.presaveId }) },
      { key: 'sourceName', label: 'Source', type: 'enum', options: SOURCE_OPTS, render: (u) => {
        const href = TK.safeHref(u.sourceUrl);
        return '<div class="tu-src"><span class="ps-chip" data-site="' + esc(u.sourceName) + '">' + esc(siteName(u.sourceName)) + '</span>' + (u.sourceBanned ? ' <span class="badge bad">banned</span>' : '') +
          (href ? '<span class="u"><a href="' + esc(href) + '" target="_blank" rel="noreferrer noopener"' + TK.tip(href) + '>' + esc(short(href)) + '</a></span>' : '') + '</div>';
      } },
      { key: 'status', label: 'Status', type: 'enum', options: STATUS_OPTS, render: (u) => '<div>' + badge(u.status) + (u.attempts ? ' <span class="tu-tries"' + TK.tip(u.attempts + ' attempt' + (u.attempts === 1 ? '' : 's') + (u.claimedAt ? ', last claimed ' + when(u.claimedAt) + (u.account ? ' on ' + u.account : '') : '')) + '>' + esc(u.attempts + (u.attempts === 1 ? ' try' : ' tries')) + '</span>' : '') + (u.error ? '<span class="tu-err"' + TK.tip(u.error) + '>' + esc(u.error) + '</span>' : '') + '</div>' },
      { key: 'createdAt', label: 'Queued', type: 'datetime', hideOn: 'phone', render: (u) => whenCell(u.createdAt) },
      { key: 'completedAt', label: 'Finished', type: 'datetime', render: (u) => whenCell(u.completedAt) },
      { key: 'videoId', label: 'Video', type: 'text', filterable: false, sortable: false, render: (u) => { const h = TK.safeHref(u.youtubeMusicUrl); return h ? '<a class="btn ytm" href="' + esc(h) + '" target="_blank" rel="noreferrer noopener"' + TK.tip('Open ' + u.videoId + ' in YouTube Music') + '>YouTube Music</a>' : nil; } },
    ],
    defaultSort: '-createdAt',
    search: 'Search artist, title, source URL or video',
    chips: [
      { id: 'all', label: 'All', group: 'status', on: true, count: (r) => (r && r.counts ? Object.keys(r.counts).reduce((n, k) => n + (Number(r.counts[k]) || 0), 0) : 0) },
      { id: 'pending', label: 'Waiting', group: 'status', filters: [{ col: 'status', op: 'in', value: 'pending' }], count: count('pending') },
      { id: 'claimed', label: 'Ripping', group: 'status', filters: [{ col: 'status', op: 'in', value: 'claimed' }], count: count('claimed') },
      { id: 'done', label: 'Uploaded', group: 'status', filters: [{ col: 'status', op: 'in', value: 'done' }], sort: '-completedAt', count: count('done') },
      { id: 'failed', label: 'Failed', group: 'status', filters: [{ col: 'status', op: 'in', value: 'failed' }], count: count('failed') },
      { id: 'banned', label: 'Banned', group: 'status', filters: [{ col: 'status', op: 'in', value: 'banned' }], count: count('banned') },
      { id: 'superseded', label: 'Not needed', group: 'status', filters: [{ col: 'status', op: 'in', value: 'superseded' }], count: count('superseded') },
    ],
    rowKey: 'id',
    empty: 'No track uploads. A pre-saved track is queued here once it has been watched long enough and a check finds a source mkvid can rip.',
    onRowClick: (u) => openUpload(u),
    onData: (resp) => { if (resp && resp.today) { today = resp.today; paintHead(); } },
    actions: (u) => {
      let h = '';
      if (u.status === 'failed') h += '<button type="button" class="btn" data-act="retry"' + TK.tip('Queue it again now.') + '>Retry</button>';
      if (canBan(u)) h += '<button type="button" class="btn ghost" data-act="ban"' + TK.tip('Ban this link: mkvid never rips this source URL again, and the next allowed source is queued.') + '>Ban link</button>';
      return h;
    },
    onAction: (act, u, btn) => {
      if (act === 'retry') return TK.busy(btn, 'Retrying\\u2026', () => retry(u));
      if (act === 'ban') return banLink(u, null, btn, true);
    },
  });

  // closeDrawer: a success closes the drawer first, so the toast lands on the page and not in the closing dialog.
  async function retry(u, closeDrawer) {
    const res = await TK.api.post('/ui/api/track-uploads/' + u.id + '/retry');
    if (res.ok && closeDrawer) TK.drawer.close();
    if (res.ok) TK.toast('Queued again: ' + trackLabel(u) + '.');
    else TK.toast(TK.errText(res, 'Retry failed (' + res.status + ')'), 'bad');
    uploads.reload();
    return res;
  }
  // What a ban did, in one line: the requests it hit and what was queued next.
  function banSentence(d) {
    let s = 'Banned ' + short(d.url) + '.';
    const n = Array.isArray(d.affected) ? d.affected.length : 0;
    if (n > 1) s += ' ' + n + ' requests used it.';
    const q = (d.requeued || []).filter((r) => r && r.queued);
    if (d.next) s += d.next.queued ? ' Queued the next source: ' + siteName(d.next.sourceName) + ' ' + short(d.next.sourceUrl) + '.' : ' Nothing else queued: ' + queueWhy(d.next.reason) + '.';
    else if (q.length) s += ' Queued ' + q.length + ' other source' + (q.length === 1 ? '' : 's') + '.';
    return s;
  }
  async function banLink(u, reason, btn, confirm, closeDrawer) {
    if (confirm && !(await TK.ask('Ban ' + u.sourceUrl + '? mkvid never rips it again, this request is marked banned and the next allowed source (if any) is queued.', { yes: 'Ban', danger: true }))) return;
    return TK.busy(btn, 'Banning\\u2026', async () => {
      const res = await TK.api.post('/ui/api/track-uploads/' + u.id + '/ban-link', reason ? { reason } : {});
      if (res.ok && closeDrawer) TK.drawer.close();
      if (res.ok && res.data) TK.toast(banSentence(res.data));
      else TK.toast(TK.errText(res, 'Ban failed (' + res.status + ')'), 'bad');
      uploads.reload();
      if (bans) bans.reload();
      return res;
    });
  }

  // ── one request in the drawer ──
  function openUpload(u) {
    const src = TK.safeHref(u.sourceUrl), v = TK.safeHref(u.youtubeMusicUrl);
    const dt = (k, val) => (val ? '<dt>' + esc(k) + '</dt><dd>' + val + '</dd>' : '');
    const at = (ms) => (ms == null ? '' : esc(when(ms)) + ' <span class="ps-res" style="display:inline">' + esc(rel(ms)) + '</span>');
    let h = trackCell({ artist: u.artist, title: u.title, artworkUrl: u.artworkUrl }, { href: '/ui/presave?id=' + u.presaveId });
    h += '<dl class="tu-dl">';
    h += dt('Status', badge(u.status));
    h += dt('Source', esc(siteName(u.sourceName)) + (src ? ' <a href="' + esc(src) + '" target="_blank" rel="noreferrer noopener">' + esc(short(src)) + '</a>' : '') + (u.sourceBanned ? ' <span class="bad">banned</span>' : ''));
    if (u.expectedDurationSeconds) h += dt('Expected length', esc(TK.fmt.clock(u.expectedDurationSeconds)));
    h += dt('Attempts', esc(String(u.attempts)));
    h += dt('Queued', at(u.createdAt));
    h += dt('Retry after', u.status === 'pending' && u.notBefore && u.notBefore > Date.now() ? at(u.notBefore) : '');
    h += dt('Claimed', at(u.claimedAt));
    h += dt('Project', u.account ? esc(u.account) : '');
    h += dt('mkvid job', u.jobId ? esc(u.jobId) : '');
    h += dt('Finished', at(u.completedAt));
    h += dt('Video', v ? '<a href="' + esc(v) + '" target="_blank" rel="noreferrer noopener">' + esc(u.videoId) + '</a>' + (u.privacy ? ' <span class="ps-res" style="display:inline">' + esc(u.privacy) + '</span>' : '') : '');
    h += dt('Playlist', u.playlistStatus ? esc(u.playlistStatus) : '');
    h += dt('Error', u.error ? '<span class="bad">' + esc(u.error) + '</span>' : '');
    h += '</dl><div class="tu-dact">';
    if (canBan(u)) h += '<label>Reason for the ban (optional)<input id="tu-d-why" type="text" maxlength="500" placeholder="preview clip, wrong track"></label>';
    h += '<div class="tk-row">' + (v ? '<a class="btn ytm" href="' + esc(v) + '" target="_blank" rel="noreferrer noopener">Open in YouTube Music</a>' : '') +
      (u.status === 'failed' ? '<button type="button" class="btn" data-do="retry">Retry</button>' : '') +
      (canBan(u) ? '<button type="button" class="btn danger" data-do="ban">Ban this link</button>' : '') +
      '<a class="btn ghost" href="/ui/presave?id=' + encodeURIComponent(u.presaveId) + '">Pre-save page</a></div></div>';
    const body = TK.drawer.open(trackLabel(u), h);
    if (body) body.onclick = async (e) => {
      const b = e && e.target && e.target.closest ? e.target.closest('button[data-do]') : null;
      if (!b) return;
      const what = b.getAttribute('data-do');
      if (what === 'retry') { await TK.busy(b, 'Retrying\\u2026', () => retry(u, true)); }
      if (what === 'ban') {
        const why = $('tu-d-why');
        await banLink(u, why && why.value ? String(why.value).trim() : null, b, false, true);
      }
    };
  }

  // ── banned links ──
  let bans = null;
  function makeBans() {
    if (bans) return bans;
    bans = TKTable.create($('tb-table'), {
      id: 'tb',
      source: { url: '/ui/api/track-uploads/bans' },
      columns: [
        { key: 'url', label: 'URL', type: 'text', render: (b) => { const h = TK.safeHref(b.url); return h ? '<a href="' + esc(h) + '" target="_blank" rel="noreferrer noopener">' + esc(short(h)) + '</a>' : esc(b.url); } },
        { key: 'sourceName', label: 'Source', type: 'enum', options: SOURCE_OPTS, render: (b) => (b.sourceName ? '<span class="ps-chip" data-site="' + esc(b.sourceName) + '">' + esc(siteName(b.sourceName)) + '</span>' : nil) },
        { key: 'reason', label: 'Reason', type: 'text', render: (b) => '<div>' + (b.reason ? esc(b.reason) : nil) + (b.presaveId ? '<div class="ps-sub"><a href="/ui/presave?id=' + encodeURIComponent(b.presaveId) + '">pre-save</a></div>' : '') + '</div>' },
        { key: 'bannedAt', label: 'Banned', type: 'datetime', render: (b) => whenCell(b.bannedAt) },
      ],
      defaultSort: '-bannedAt',
      search: 'Search URL or reason',
      rowKey: 'url',
      empty: 'No banned links.',
      actions: () => '<button type="button" class="btn" data-act="unban"' + TK.tip('mkvid may rip this URL again (nothing is queued until the next check).') + '>Unban</button>',
      onAction: (act, b, btn) => {
        if (act !== 'unban') return;
        return TK.busy(btn, 'Unbanning\\u2026', async () => {
          const res = await TK.api.post('/ui/api/track-uploads/bans/unban', { url: b.url });
          if (res.ok) TK.toast(res.data && res.data.unbanned ? 'Unbanned ' + short(b.url) + '.' : 'It was not banned.');
          else TK.toast(TK.errText(res, 'Unban failed (' + res.status + ')'), 'bad');
          bans.reload();
          uploads.reload();
        });
      },
    });
    return bans;
  }
  const $banForm = $('tu-ban'), $banUrl = $('tu-ban-url'), $banWhy = $('tu-ban-why'), $banGo = $('tu-ban-go'), $banMsg = $('tu-ban-msg');
  function banSay(text, bad) { if ($banMsg) { $banMsg.className = 'tu-ban-msg' + (bad ? ' bad' : ''); $banMsg.textContent = text; } }
  if ($banForm && typeof $banForm.addEventListener === 'function') $banForm.addEventListener('submit', async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    const url = String(($banUrl && $banUrl.value) || '').trim();
    if (!TK.safeHref(url)) { banSay('Paste the https URL of the source (SoundCloud, Bandcamp, hearthis.at or Mixcloud).', true); return; }
    const reason = String(($banWhy && $banWhy.value) || '').trim();
    await TK.busy($banGo, 'Banning\\u2026', async () => {
      const res = await TK.api.post('/ui/api/track-uploads/ban-url', reason ? { url, reason } : { url });
      if (!res.ok || !res.data) { banSay(TK.errText(res, 'Ban failed (' + res.status + ').'), true); return; }
      banSay(banSentence(res.data), false);
      if ($banUrl) $banUrl.value = '';
      if ($banWhy) $banWhy.value = '';
      makeBans().reload();
      uploads.reload();
    });
  });

  // ── tabs ──
  const TABS = ['up', 'bans'];
  function showTab(t, save) {
    for (const k of TABS) {
      const tab = $('tu-tab-' + k), panel = $('tu-p-' + k);
      if (tab && tab.setAttribute) tab.setAttribute('aria-selected', k === t ? 'true' : 'false');
      if (panel) panel.hidden = k !== t;
    }
    if (t === 'bans') makeBans();
    if (save) TKTable.qs.merge({ tab: t === 'up' ? null : t });
  }
  const $tabs = $('tu-tabs');
  if ($tabs && typeof $tabs.addEventListener === 'function') $tabs.addEventListener('click', (e) => {
    const b = e && e.target && e.target.closest ? e.target.closest('[data-tab]') : null;
    if (b) showTab(b.getAttribute('data-tab'), true);
  });
  showTab(TKTable.qs.get('tab') === 'bans' ? 'bans' : 'up', false);
  paintHead();
})();
`

export const TRACK_UPLOADS_PAGE: UiPage = {
  path: '/track-uploads',
  html: shell({
    nav: 'track-uploads',
    title: 'Track uploads',
    description: 'Pre-saved tracks YouTube never got, ripped by mkvid from another site and uploaded into one playlist.',
    actions: `<a class="btn" href="/ui/presaves"${tipAttr('Every pre-saved track.')}>Pre-saves</a><a class="btn ghost" href="${TRACK_UPLOADS_SETTINGS_HREF}"${tipAttr('Daily cap, sources, playlist, retries.')}>Settings</a>`,
    body: BODY,
    css: CSS,
    js: JS,
  }),
}
