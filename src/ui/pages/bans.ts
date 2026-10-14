// Bans: the channel-ban questions (lib/channel-bans.ts). Each time the owner
// removes a video from a managed playlist (by hand on YouTube, or with Remove
// & replace), its uploader channel is asked about once: ban it (its videos are
// never picked again and the sweep takes the ones in the playlists out) or
// not (asked again only after a further removal). Below the questions, every
// channel already answered, with Lift ban / Ban.
//
// Data: GET /ui/api/bans; answers POST /ui/api/bans/:channelId/ban|decline|lift.
// Everything renders through innerHTML strings with delegated clicks, and
// every upstream value goes through TK.esc.
import { shell } from "../shell";
import { tipTerm } from "../tip";

const BODY = /* html */ `
  <div id="bn-status" class="muted bn-status" role="status"></div>
  <div id="error" class="error" role="alert"></div>
  <h2 class="bn-h">Waiting for your answer</h2>
  <div id="pending"><div class="muted">Loading...</div></div>
  <h2 class="bn-h">Answered</h2>
  <div id="decided"><div class="muted">Loading...</div></div>
`;

const CSS = /* css */ `
  .bn-h { margin: var(--sp-4) 0 var(--sp-2); font-size: var(--fs-md); }
  .bn-q { margin-bottom: var(--sp-3); }
  .bn-q-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-2); }
  .bn-q-head strong { overflow-wrap: anywhere; }
  .bn-q ul { margin: var(--sp-1) 0 0; padding-left: 1.2rem; }
  .bn-q li { overflow-wrap: anywhere; }
  .bn-sub { margin: var(--sp-2) 0 0; color: var(--muted); font-size: var(--fs-sm); }
  .bn-acts { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin-top: var(--sp-3); }
  .bn-status:empty, #error:empty { display: none; }
  .bn-status { margin-bottom: var(--sp-2); }
`;

const JS = /* js */ `
(() => {
  const $ = TK.$, esc = TK.esc;
  const $pending = $('pending'), $decided = $('decided'), $err = $('error'), $status = $('bn-status');
  const isoOf = (s) => { try { return new Date(s * 1000).toISOString(); } catch (e) { return ''; } };
  const ext = (href, text, tip) => { const h = TK.safeHref(href); return h ? '<a href="' + esc(h) + '" target="_blank" rel="noreferrer noopener"' + TK.tip(tip) + '>' + esc(text) + '</a>' : esc(text); };
  const channelLink = (q) => ext('https://www.youtube.com/channel/' + encodeURIComponent(q.channelId), q.channelTitle || q.channelId, 'Opens the channel on YouTube.');
  const videoLink = (id) => ext('https://www.youtube.com/watch?v=' + encodeURIComponent(id), id, 'Opens the video on YouTube.');
  const setLink = (url) => url ? '<a href="/ui/set?url=' + encodeURIComponent(url) + '">' + esc(TK.fmt.setLabel(url)) + '</a>' : '';
  const djLink = (slug) => slug ? '<a href="/ui/dj/' + encodeURIComponent(slug) + '">' + esc(slug) + '</a>' : '';
  const strikes = (n) => n + ' video' + (n === 1 ? '' : 's') + ' removed';
  const STRIKE_TIP = 'Videos of this channel you removed from a playlist (by hand, or with Remove & replace). The sync passes over a channel with removals when the set page has another recording.';
  const STATE = {
    banned: { cls: 'neutral', text: 'banned', tip: 'Its videos are never added. Any still in the playlists are taken out by the sweep, within its daily limit; undo one on the Removed videos page.' },
    declined: { cls: 'neutral', text: 'not banned', tip: 'You chose not to ban it. You are asked again if you remove another of its videos.' },
    lifted: { cls: 'neutral', text: 'ban lifted', tip: 'You lifted the ban. Its videos may be added again; you are asked again if you remove another one.' },
  };
  const badge = (cls, text, tip) => '<span class="badge ' + cls + '"' + TK.tip(tip) + '>' + esc(text) + '</span>';
  let data = { pending: [], decided: [] };

  function videoItem(v) {
    const where = [djLink(v.slug), setLink(v.setUrl)].filter(Boolean).join(': ');
    return '<li>' + videoLink(v.videoId) + (where ? ' (' + where + ')' : '') + '</li>';
  }

  function renderPending() {
    const list = data.pending || [];
    if (!list.length) { $pending.innerHTML = '<div class="muted">Nothing to decide. You are asked here (and by a notification) when you remove a video from a playlist.</div>'; return; }
    $pending.innerHTML = list.map((q, i) => {
      const removed = (q.removed || []).slice(0, 10);
      const inPl = q.inPlaylists || [];
      return '<div class="tk-card bn-q">' +
        '<div class="bn-q-head"><strong>' + channelLink(q) + '</strong>' + badge('warn', strikes(q.strikes), STRIKE_TIP) + '</div>' +
        '<p class="bn-sub">You removed' + (q.lastRemovalAt ? ' (' + esc(TK.fmt.time(isoOf(q.lastRemovalAt))) + ')' : '') + ':</p>' +
        '<ul>' + removed.map(videoItem).join('') + '</ul>' +
        '<p class="bn-sub">' + (inPl.length ? 'Its other videos in your playlists (' + inPl.length + '):' : 'None of its other videos is in your playlists now.') + '</p>' +
        (inPl.length ? '<ul>' + inPl.map(videoItem).join('') + '</ul>' : '') +
        '<div class="bn-acts">' +
          '<button type="button" class="btn" data-act="ban" data-i="' + i + '"' + TK.tip('Never add this channel\\'s videos again. The ones in your playlists are swapped for another recording of the set, or removed when there is none, by the sweep within its daily limit. Each can be undone on the Removed videos page.') + '>Ban channel</button>' +
          '<button type="button" class="btn" data-act="decline" data-i="' + i + '"' + TK.tip('Keep adding this channel\\'s videos. You are asked again only if you remove another one.') + '>Not banned</button>' +
        '</div></div>';
    }).join('');
  }

  function renderDecided() {
    const list = data.decided || [];
    if (!list.length) { $decided.innerHTML = '<div class="muted">No channel answered yet.</div>'; return; }
    $decided.innerHTML = '<div class="tk-table-wrap"><table class="tk-table"><thead><tr><th>Channel</th><th>Answer</th><th>Removed</th><th>When</th><th>In playlists</th><th></th></tr></thead><tbody>' +
      list.map((q, i) => {
        const s = STATE[q.state] || { cls: 'neutral', text: q.state, tip: 'Your answer for this channel.' };
        const act = q.state === 'banned'
          ? '<button type="button" class="btn sm" data-act="lift" data-j="' + i + '"' + TK.tip('Lets the sync add this channel\\'s videos again. Videos already taken out are not put back; undo them on the Removed videos page.') + '>Lift ban</button>'
          : '<button type="button" class="btn sm" data-act="ban" data-j="' + i + '"' + TK.tip('Ban the channel now: its videos are never added again and the sweep takes the ones in your playlists out.') + '>Ban</button>';
        return '<tr><td>' + channelLink(q) + '</td><td>' + badge(s.cls, s.text, s.tip) + '</td><td>' + esc(strikes(q.strikes)) + '</td>' +
          '<td>' + (q.decidedAt ? esc(TK.fmt.time(isoOf(q.decidedAt))) : '') + '</td><td>' + (q.inPlaylists || []).length + '</td><td>' + act + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  async function load() {
    const res = await TK.api.get('/ui/api/bans');
    if (!res.ok || !res.data) { $err.textContent = TK.errText(res, 'could not load the bans (' + res.status + ')'); return; }
    $err.textContent = '';
    data = res.data;
    renderPending();
    renderDecided();
  }

  async function answer(q, act, btn) {
    $err.textContent = '';
    await TK.busy(btn, 'Saving...', async () => {
      const res = await TK.api.post('/ui/api/bans/' + encodeURIComponent(q.channelId) + '/' + act, {});
      if (!res.ok) { $err.textContent = TK.errText(res, 'failed (' + res.status + ')'); return; }
      const name = q.channelTitle || q.channelId;
      const dry = res.data && res.data.dryRun;
      $status.textContent = act === 'ban'
        ? name + ' is banned. ' + (dry ? 'The sweep is a dry run: it lists its videos on the Removed videos page and takes none out.' : 'The sweep takes its videos out of your playlists within a few minutes, within its daily limit.')
        : act === 'lift' ? 'The ban on ' + name + ' is lifted.' : name + ' is not banned. You are asked again if you remove another of its videos.';
      await load();
    });
  }

  for (const [el, attr, key] of [[$pending, 'data-i', 'pending'], [$decided, 'data-j', 'decided']]) {
    el.addEventListener('click', (e) => {
      const b = e.target && e.target.closest ? e.target.closest('button[data-act]') : null;
      if (!b) return;
      const q = (data[key] || [])[Number(b.getAttribute(attr))];
      if (q) answer(q, b.getAttribute('data-act'), b);
    });
  }
  load();
})();
`;

export const BANS_PAGE_HTML = shell({
  nav: "bans",
  title: "Bans",
  description: `Channels to ban: asked each time you ${tipTerm("remove a video", "From a playlist by hand on YouTube (noticed by the 6-hourly check), or with Remove & replace on a set.")} from a playlist. A banned channel's videos are never added again.`,
  body: BODY,
  css: CSS,
  js: JS,
});
