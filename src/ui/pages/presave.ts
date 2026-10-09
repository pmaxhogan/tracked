// One pre-saved track (/ui/presave?id=<id>): the push's fallback target when
// a found track has no YouTube Music URL, and the drill-down from the
// Pre-saves list. Big artwork, the one-click YouTube Music button, every
// linked site, the timeline, the track upload when mkvid has one, and the
// check history (a TKTable over GET /ui/api/presaves/:id/checks).
// Data: GET /ui/api/presaves/:id → { presave, upload }.
import { shell } from '../shell'
import { tipAttr } from '../tip'
import type { UiPage } from './index'
import { PRESAVE_SETTINGS_HREF, PRESAVE_UI_CSS, PRESAVE_UI_JS } from './presaves'

const BODY = /* html */ `
  <div id="pv-root"><div class="tk-card"><span class="skel" style="width: 16rem"></span></div></div>
  <section id="pv-checks-card" class="tk-card pv-checks" hidden>
    <h2>Check history</h2>
    <div id="pc-table"></div>
  </section>
`

const CSS = /* css */ `
  ${PRESAVE_UI_CSS}
  .pv-hero { display: grid; grid-template-columns: minmax(0, 220px) minmax(0, 1fr); gap: var(--sp-4) var(--sp-5); align-items: start; }
  .pv-cover { width: 100%; aspect-ratio: 1; height: auto; border-radius: var(--r-card); }
  .pv-cover.ph { font-size: 2.4rem; }
  .pv-main { min-width: 0; display: grid; gap: var(--sp-2); align-content: start; }
  .pv-artist { font-size: var(--fs-lg, 1.1rem); color: var(--muted); font-weight: 600; overflow-wrap: anywhere; }
  .pv-title { font-size: 1.7rem; line-height: 1.15; font-weight: 700; margin: 0; overflow-wrap: anywhere; }
  .pv-ctx { color: var(--muted); font-size: var(--fs-sm); overflow-wrap: anywhere; }
  .pv-ctx a { color: var(--accent); }
  .pv-cta { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin-top: var(--sp-2); }
  .pv-cta .btn.ytm { font-size: 1rem; padding: 13px 20px; }
  .pv-wait { border: 1px dashed var(--line-strong); border-radius: var(--r-tile); padding: 10px var(--sp-3); color: var(--muted); font-size: var(--fs-sm); }
  .pv-wait strong { color: var(--fg); }
  .pv-acts { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin-top: var(--sp-1); }
  .pv-acts .btn { padding: 7px 12px; font-size: var(--fs-sm); }
  .pv-grid { margin-top: var(--sp-4); }
  .pv-grid h2, .pv-checks h2, .pv-up h2 { font-size: var(--fs-md, 1rem); margin: 0 0 var(--sp-3); }
  .pv-links { display: grid; gap: 2px; }
  .pv-link { display: flex; align-items: center; gap: var(--sp-2); padding: 7px 0; border-bottom: 1px solid var(--line); min-width: 0; }
  .pv-link:last-child { border-bottom: 0; }
  .pv-link .ps-chip { flex: none; }
  .pv-link .u { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: var(--fs-xs); font-family: var(--mono); }
  .pv-link .u a { color: inherit; text-decoration: none; }
  .pv-link .u a:hover { color: var(--accent); text-decoration: underline; }
  .pv-link .dur { flex: none; font-variant-numeric: tabular-nums; color: var(--muted); font-size: var(--fs-sm); }
  .pv-link .btn { flex: none; padding: 3px 8px; font-size: var(--fs-xs); }
  .pv-dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px var(--sp-3); margin: 0; font-size: var(--fs-sm); }
  .pv-dl dt { color: var(--muted); }
  .pv-dl dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .pv-dl .sub { color: var(--subtle); }
  .pv-dl .bad { color: var(--danger); }
  .pv-up { margin-top: var(--sp-4); }
  .pv-up-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-3); }
  .pv-up-head h2 { margin: 0 auto 0 0; }
  .pv-checks { margin-top: var(--sp-4); }
  .pv-arrow { color: var(--subtle); margin: 0 4px; }
  .pv-err { color: var(--danger); font-size: var(--fs-xs); overflow-wrap: anywhere; }
  @media (max-width: 699px) {
    .pv-hero { grid-template-columns: 1fr; }
    .pv-cover { max-width: 260px; justify-self: center; }
    .pv-title { font-size: 1.4rem; }
    .pv-cta .btn { flex: 1 1 100%; }
  }
`

const JS = /* js */ `
(() => {
${PRESAVE_UI_JS}
  const $ = TK.$, esc = TK.esc;
  const $root = $('pv-root'), $checksCard = $('pv-checks-card');
  const id = String(TK.qs.get('id') || '').trim();
  const RIP_SOURCES = { soundcloud: 1, bandcamp: 1, hearthis: 1, mixcloud: 1 };
  const UP_BADGE = { pending: ['Waiting for mkvid', 'info'], claimed: ['mkvid is on it', 'warn'], done: ['Uploaded', 'ok'], failed: ['Failed', 'bad'], banned: ['Source banned', 'bad'], superseded: ['Not needed', 'neutral'] };
  let cur = null, checks = null;

  function state(html) { if ($root) $root.innerHTML = '<div class="empty">' + html + '</div>'; }
  if (!/^[0-9]+$/.test(id)) { state('No pre-saved track picked. <a href="/ui/presaves">See every pre-save</a>.'); return; }

  function cta(p) {
    const ytm = TK.safeHref(p.youtubeMusicUrl), yt = TK.safeHref(p.youtubeUrl);
    if (ytm) return '<div class="pv-cta"><a class="btn ytm" href="' + esc(ytm) + '" target="_blank" rel="noreferrer noopener">Open in YouTube Music</a>' +
      (yt ? '<a class="btn" href="' + esc(yt) + '" target="_blank" rel="noreferrer noopener">YouTube</a>' : '') + '</div>';
    if (p.stage === 'dismissed') return '<div class="pv-wait">Dismissed ' + esc(rel(p.dismissedAt)) + '. Restore it to watch for a YouTube link again.</div>';
    const next = p.nextCheckAt ? 'Next check <strong' + TK.tip(when(p.nextCheckAt)) + '>' + esc(rel(p.nextCheckAt)) + '</strong>.' : 'No check scheduled.';
    const what = p.stage === 'identify' ? 'Not identified yet: its set is read again until this row has a track.' : 'No YouTube link on 1001tracklists yet.';
    return '<div class="pv-wait">' + esc(what) + ' ' + next + '</div>';
  }

  function hero(p) {
    const ctx = [];
    if (p.setUrl) ctx.push((p.cueSeconds != null ? 'At ' + esc(fmtCue(p.cueSeconds)) + ' in ' : 'From ') + '<a href="' + esc(setHref(p.setUrl)) + '">' + esc(TK.fmt.setLabel(p.setUrl)) + '</a>');
    if (p.djSlug) ctx.push('DJ <a href="' + esc(djHref(p.djSlug)) + '">' + esc(p.djSlug) + '</a>');
    if (p.label) ctx.push(esc(p.label));
    if (p.durationSeconds) ctx.push(esc(TK.fmt.clock(p.durationSeconds)));
    const acts = [];
    if (p.stage === 'identify' || p.stage === 'links') acts.push('<button type="button" class="btn" data-do="recheck"' + TK.tip('Look it up on 1001tracklists now (one pool fetch).') + '>Recheck now</button>');
    else if (p.stage !== 'dismissed') acts.push('<button type="button" class="btn" data-do="recheck"' + TK.tip('Look it up again now (one pool fetch).') + '>Recheck</button>');
    if (p.stage === 'dismissed') acts.push('<button type="button" class="btn" data-do="restore"' + TK.tip('Watch it again.') + '>Restore</button>');
    else if (p.stage === 'identify' || p.stage === 'links') acts.push('<button type="button" class="btn ghost" data-do="dismiss"' + TK.tip('Stop watching it.') + '>Dismiss</button>');
    acts.push('<button type="button" class="btn danger" data-do="delete"' + TK.tip('Forget it and its check history.') + '>Delete</button>');
    return '<section class="tk-card pv-hero">' + artHtml(p.artworkUrl, 'pv-cover') +
      '<div class="pv-main"><div>' + stageBadge(p.stage) + '</div>' +
      '<div class="pv-artist">' + (isId(p.artist) ? '<span class="ps-id">ID</span>' : esc(p.artist)) + '</div>' +
      '<h2 class="pv-title">' + (isId(p.title) ? '<span class="ps-id">ID</span>' : esc(p.title)) + '</h2>' +
      (ctx.length ? '<div class="pv-ctx">' + ctx.join(' \\u00b7 ') + '</div>' : '') +
      cta(p) + '<div class="pv-acts">' + acts.join('') + '</div></div></section>';
  }

  function linksCard(p, up) {
    const rows = [];
    const banned = up && up.sourceBanned ? up.sourceUrl : null;
    for (const l of p.links || []) {
      if (!l) continue;
      const href = TK.safeHref(l.url);
      const chip = '<span class="ps-chip" data-site="' + esc(l.name) + '">' + esc(siteName(l.name)) + '</span>';
      const ban = href && RIP_SOURCES[l.name] && href !== banned && !(up && up.sourceUrl === href)
        ? '<button type="button" class="btn ghost" data-do="banurl" data-url="' + esc(href) + '"' + TK.tip('Never let mkvid rip this URL (a wrong track, a preview).') + '>Ban for ripping</button>' : '';
      rows.push('<div class="pv-link">' + chip + '<span class="u">' + (href ? '<a href="' + esc(href) + '" target="_blank" rel="noreferrer noopener">' + esc(href.replace(/^https?:[/][/](www[.])?/, '')) + '</a>' : 'no public link') + '</span>' +
        (l.duration ? '<span class="dur"' + TK.tip('Length on ' + siteName(l.name)) + '>' + esc(TK.fmt.clock(l.duration)) + '</span>' : '') + ban + '</div>');
    }
    const tl = TK.safeHref(p.trackUrl);
    if (tl) rows.push('<div class="pv-link"><span class="ps-chip" data-site="tl">1001tracklists</span><span class="u"><a href="' + esc(tl) + '" target="_blank" rel="noreferrer noopener">track page</a></span></div>');
    if (p.setUrl) rows.push('<div class="pv-link"><span class="ps-chip" data-site="tl">Set</span><span class="u"><a href="' + esc(setHref(p.setUrl)) + '">' + esc(TK.fmt.setLabel(p.setUrl)) + '</a></span>' +
      (TK.safeHref(p.setUrl) ? '<a class="btn ghost" href="' + esc(TK.safeHref(p.setUrl)) + '" target="_blank" rel="noreferrer noopener"' + TK.tip('The set on 1001tracklists') + '>1001tl</a>' : '') + '</div>');
    return '<section class="tk-card"><h2>Linked on</h2>' + (rows.length ? '<div class="pv-links">' + rows.join('') + '</div>' : '<p class="ps-none">No links yet. 1001tracklists has none for this track.</p>') + '</section>';
  }

  function dt(k, v, sub) { return v ? '<dt>' + esc(k) + '</dt><dd>' + v + (sub ? ' <span class="sub">' + sub + '</span>' : '') + '</dd>' : ''; }
  const at = (ms) => (ms == null ? '' : '<span' + TK.tip(when(ms)) + '>' + esc(rel(ms)) + '</span>');
  function timeline(p, up) {
    let h = '';
    h += dt('Pre-saved', at(p.createdAt), esc('from ' + (p.source === 'tasker' ? 'Tasker' : p.source === 'ui' ? 'the web' : p.source)));
    h += dt('Identified', at(p.identifiedAt));
    h += dt('On YouTube', at(p.foundAt), p.notifiedAt ? 'pushed ' + esc(rel(p.notifiedAt)) : '');
    if (up && up.completedAt && up.status === 'done') h += dt('Uploaded', at(up.completedAt), 'by mkvid');
    h += dt('Dismissed', at(p.dismissedAt));
    h += dt('Last check', p.lastCheckedAt ? at(p.lastCheckedAt) + ' <span class="ps-res ' + resultCls(p.lastResult) + '" style="display:inline">' + esc(resultText(p.lastResult)) + '</span>' : '<span class="sub">never</span>');
    if (p.lastError) h += dt('Last error', '<span class="bad">' + esc(p.lastError) + '</span>');
    if (p.stage === 'identify' || p.stage === 'links') h += dt('Next check', p.nextCheckAt ? at(p.nextCheckAt) : '<span class="sub">not scheduled</span>');
    h += dt('Checks', esc(String(p.checkCount)), p.failCount ? esc(p.failCount + ' failed in a row') : '');
    if (p.stage === 'links' && !up) h += dt('mkvid may rip it', at(p.uploadEligibleAt), p.uploadEligibleAt > Date.now() ? 'if YouTube still has nothing' : 'when a check finds a source it can use');
    return '<section class="tk-card"><h2>Timeline</h2><dl class="pv-dl">' + h + '</dl></section>';
  }

  function uploadCard(up) {
    if (!up) return '';
    const b = UP_BADGE[up.status] || [up.status, 'neutral'];
    const src = TK.safeHref(up.sourceUrl);
    const vid = TK.safeHref(up.youtubeMusicUrl);
    let h = '';
    h += dt('Source', esc(siteName(up.sourceName)) + (src ? ' <a href="' + esc(src) + '" target="_blank" rel="noreferrer noopener">' + esc(src.replace(/^https?:[/][/](www[.])?/, '')) + '</a>' : ''), up.sourceBanned ? '<span class="bad">banned</span>' : '');
    h += dt('Attempts', esc(String(up.attempts)));
    h += dt('Queued', at(up.createdAt));
    h += dt('Claimed', at(up.claimedAt), up.account ? esc('project ' + up.account) : '');
    h += dt('Finished', at(up.completedAt));
    if (up.notBefore && up.status === 'pending' && up.notBefore > Date.now()) h += dt('Retry', at(up.notBefore));
    if (vid) h += dt('Video', '<a href="' + esc(vid) + '" target="_blank" rel="noreferrer noopener">YouTube Music</a>');
    if (up.error) h += dt('Error', '<span class="bad">' + esc(up.error) + '</span>');
    const ban = !up.sourceBanned && up.status !== 'banned' && up.status !== 'superseded'
      ? '<button type="button" class="btn danger" data-do="banlink"' + TK.tip('Ban this source URL: mkvid never rips it again, and the next allowed source is queued.') + '>Ban this source URL</button>' : '';
    return '<section class="tk-card pv-up"><div class="pv-up-head"><h2>Track upload</h2><span class="badge ' + b[1] + '">' + esc(b[0]) + '</span>' +
      '<a class="btn ghost" href="/ui/track-uploads">Track uploads</a>' + ban + '</div><dl class="pv-dl">' + h + '</dl></section>';
  }

  function render(p, up) {
    cur = { p, up };
    if (!$root) return;
    $root.innerHTML = hero(p) + '<div class="tk-grid two pv-grid">' + linksCard(p, up) + timeline(p, up) + '</div>' + uploadCard(up);
  }

  async function load() {
    const res = await TK.api.get('/ui/api/presaves/' + encodeURIComponent(id));
    const d = res.data && typeof res.data === 'object' ? res.data : null;
    if (res.status === 404) { state('This pre-save does not exist any more. <a href="/ui/presaves">See every pre-save</a>.'); if ($checksCard) $checksCard.hidden = true; return res; }
    if (!res.ok || !d || !d.presave) { if (!cur) state(esc(TK.errText(res, 'Could not load it (' + res.status + ').')) + ' <a href="">Try again</a>.'); else TK.toast(TK.errText(res, 'Could not refresh it.'), 'bad'); return res; }
    render(d.presave, d.upload || null);
    if ($checksCard) $checksCard.hidden = false;
    if (!checks) checks = TKTable.create($('pc-table'), {
      id: 'pc',
      source: { url: '/ui/api/presaves/' + encodeURIComponent(id) + '/checks' },
      columns: [
        { key: 'at', label: 'Time', type: 'datetime', render: (c) => whenCell(c.at) },
        { key: 'trigger', label: 'Trigger', type: 'enum', options: [{ value: 'scheduled', label: 'Scheduled' }, { value: 'manual', label: 'Recheck now' }, { value: 'add', label: 'When saved' }, { value: 'set_fetch', label: 'Set fetch' }, { value: 'upload', label: 'mkvid upload' }] },
        { key: 'result', label: 'Result', type: 'enum', options: RESULT_OPTS, render: (c) => '<span class="ps-res ' + resultCls(c.result) + '" style="display:inline">' + esc(resultText(c.result)) + '</span>' },
        { key: 'stageAfter', label: 'Stage', type: 'enum', options: STAGE_OPTS, hideOn: 'phone', render: (c) => (c.stageBefore && c.stageBefore !== c.stageAfter ? esc((STAGE[c.stageBefore] || [c.stageBefore])[0]) + '<span class="pv-arrow">\\u2192</span>' : '') + esc(c.stageAfter ? (STAGE[c.stageAfter] || [c.stageAfter])[0] : '') },
        { key: 'linkCount', label: 'Links', type: 'number', render: (c) => (c.linkCount == null ? '<span class="tkt-nil">\\u2013</span>' : '<div>' + esc(String(c.linkCount)) + ((c.linkSources || []).filter((n) => n !== 'none').length ? ' <span class="ps-sub" style="display:inline">' + esc(c.linkSources.filter((n) => n !== 'none').map(siteName).join(', ')) + '</span>' : '') + '</div>') },
        { key: 'youtubeVideoId', label: 'YouTube', type: 'text', hideOn: 'phone', render: (c) => (c.youtubeVideoId ? '<a href="https://music.youtube.com/watch?v=' + encodeURIComponent(c.youtubeVideoId) + '" target="_blank" rel="noreferrer noopener">' + esc(c.youtubeVideoId) + '</a>' : '<span class="tkt-nil">\\u2013</span>') },
        { key: 'error', label: 'Error', type: 'text', hideOn: 'phone', render: (c) => (c.error ? '<span class="pv-err">' + esc(c.error) + '</span>' : '<span class="tkt-nil">\\u2013</span>') },
        { key: 'ms', label: 'Took', type: 'number', hideOn: 'phone', render: (c) => (c.ms == null ? '<span class="tkt-nil">\\u2013</span>' : esc(c.ms < 1000 ? c.ms + ' ms' : (c.ms / 1000).toFixed(1) + ' s')) },
      ],
      defaultSort: '-at',
      pageSize: 25,
      search: false,
      rowKey: 'id',
      empty: 'No checks yet.',
    });
    else checks.reload();
    return res;
  }

  async function act(what, btn) {
    const p = cur && cur.p, up = cur && cur.up;
    if (!p) return;
    if (what === 'recheck') return TK.busy(btn, 'Checking\\u2026', async () => { await recheckPresave(p.id); await load(); });
    if (what === 'dismiss' || what === 'restore') return TK.busy(btn, what === 'dismiss' ? 'Dismissing\\u2026' : 'Restoring\\u2026', async () => {
      const res = await TK.api.post('/ui/api/presaves/' + p.id + '/' + what);
      if (res.ok) TK.toast(what === 'dismiss' ? 'Dismissed. It is no longer looked up.' : 'Watching it again.');
      else TK.toast(TK.errText(res, what + ' failed (' + res.status + ')'), 'bad');
      await load();
    });
    if (what === 'delete') {
      if (!(await TK.ask('Delete this pre-save and its check history? It is not looked up again unless you pre-save it again.', { yes: 'Delete', danger: true }))) return;
      return TK.busy(btn, 'Deleting\\u2026', async () => {
        const res = await TK.api.del('/ui/api/presaves/' + p.id);
        if (res.ok) { TK.toast('Deleted.'); go('/ui/presaves'); }
        else TK.toast(TK.errText(res, 'Delete failed (' + res.status + ')'), 'bad');
      });
    }
    if (what === 'banlink' && up) {
      if (!(await TK.ask('Ban ' + up.sourceUrl + ' for ripping? mkvid never rips it again, and the next allowed source (if any) is queued.', { yes: 'Ban', danger: true }))) return;
      return TK.busy(btn, 'Banning\\u2026', async () => {
        const res = await TK.api.post('/ui/api/track-uploads/' + up.id + '/ban-link', {});
        const d = res.data || {};
        if (res.ok) TK.toast('Banned. ' + (d.next && d.next.queued ? 'Queued the next source: ' + siteName(d.next.sourceName) + '.' : 'Nothing else queued: ' + queueWhy(d.next && d.next.reason) + '.'));
        else TK.toast(TK.errText(res, 'Ban failed (' + res.status + ')'), 'bad');
        await load();
      });
    }
    if (what === 'banurl') {
      const url = btn && btn.getAttribute ? btn.getAttribute('data-url') : null;
      if (!url) return;
      if (!(await TK.ask('Ban ' + url + ' for ripping? mkvid never rips it.', { yes: 'Ban', danger: true }))) return;
      return TK.busy(btn, 'Banning\\u2026', async () => {
        const res = await TK.api.post('/ui/api/track-uploads/ban-url', { url });
        const d = res.data || {};
        if (res.ok) TK.toast('Banned for ripping.' + (d.requeued && d.requeued.some((r) => r.queued) ? ' Another source was queued.' : ''));
        else TK.toast(TK.errText(res, 'Ban failed (' + res.status + ')'), 'bad');
        await load();
      });
    }
  }
  if ($root && typeof $root.addEventListener === 'function') $root.addEventListener('click', (e) => {
    const b = e && e.target && e.target.closest ? e.target.closest('button[data-do]') : null;
    if (b) act(b.getAttribute('data-do'), b);
  });

  load();
})();
`

export const PRESAVE_PAGE: UiPage = {
  path: '/presave',
  html: shell({
    nav: 'presaves',
    title: 'Pre-saved track',
    actions: `<a class="btn" href="/ui/presaves"${tipAttr('Every pre-saved track.')}>All pre-saves</a><a class="btn ghost" href="${PRESAVE_SETTINGS_HREF}"${tipAttr('How often tracks are looked up, pushes, giving up.')}>Settings</a>`,
    body: BODY,
    css: CSS,
    js: JS,
  }),
}
