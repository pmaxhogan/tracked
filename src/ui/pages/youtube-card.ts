// The YouTube connection card: status, Sign in with YouTube, Disconnect, and the
// ?yt= / ?yt_error= notices after the OAuth round-trip. The Playlists page uses
// it now and the Settings page reuses it. YOUTUBE_CARD_JS is a fragment embedded
// inside a page IIFE (it declares `const YT` only); it needs TK.

export const YOUTUBE_CARD_HTML = /* html */ `
<div id="yt-card" class="tk-card">
  <div class="tk-row yt-row">
    <div class="yt-info">
      <div id="yt-title" class="yt-title">YouTube</div>
      <div id="yt-sub" class="muted sub">Loading…</div>
    </div>
    <a id="yt-signin" class="btn primary" href="/ui/oauth/start" hidden data-tip="Opens Google's consent screen so tracked can create and update playlists on your channel.">Sign in with YouTube</a>
    <button id="yt-action" type="button" class="btn" hidden></button>
  </div>
</div>`

export const YOUTUBE_CARD_CSS = /* css */ `
  .yt-row { flex-wrap: nowrap; justify-content: space-between; gap: var(--sp-3); }
  .yt-info { min-width: 0; flex: 1; }
  .yt-title { font-weight: 600; }
  .yt-info .sub { font-size: var(--fs-sm); overflow-wrap: anywhere; }
`

export const YOUTUBE_CARD_JS = /* js */ `
  const YT = (() => {
    const $title = TK.$('yt-title'), $sub = TK.$('yt-sub'), $signin = TK.$('yt-signin'), $action = TK.$('yt-action');

    function show(title, sub, signin, action) {
      $title.textContent = title;
      $sub.textContent = sub;
      $signin.hidden = !signin;
      $action.hidden = !action;
      if (action) { $action.textContent = action.label; $action.className = 'btn' + (action.danger ? ' danger' : ''); $action.onclick = action.run;
        if (action.tip) $action.setAttribute('data-tip', action.tip); else $action.removeAttribute('data-tip'); }
    }

    // Resolves the status object, or null when it could not be loaded (a network error included).
    async function load() {
      const res = await TK.api.get('/ui/api/youtube/status');
      const d = res.ok && res.data && typeof res.data === 'object' ? res.data : null;
      if (!d) {
        show('YouTube', 'Could not load the YouTube status: ' + TK.errText(res, 'failed (' + res.status + ')'), false, { label: 'Retry', run: load, tip: 'Asks for the YouTube status again.' });
        return null;
      }
      if (d.connected) show('YouTube · ' + (d.channelTitle || 'connected'), 'Granted: ' + (d.scope || '(unknown scope)'), false, { label: 'Disconnect', danger: true, run: disconnect, tip: 'Forgets the stored YouTube login. Syncing stops until you sign in again; existing playlists are untouched.' });
      else show('YouTube', 'Connect your account to let this app create and update playlists.', true, null);
      return d;
    }

    async function disconnect() {
      if (!(await TK.ask('Disconnect this app from your YouTube account?', { yes: 'Disconnect', danger: true }))) return;
      await TK.busy($action, 'Disconnecting…', async () => {
        const res = await TK.api.post('/ui/oauth/disconnect', {});
        if (!res.ok) TK.toast('disconnect failed (' + res.status + ')', 'bad');
      });
      await load();
    }

    // ?yt=connected or ?yt_error=... after the OAuth round-trip: say it once, then strip both.
    function handleReturn() {
      const err = TK.qs.get('yt_error'), ok = TK.qs.get('yt');
      if (err) TK.toast('YouTube connect failed: ' + err, 'bad');
      else if (ok === 'connected') TK.toast('YouTube connected', 'ok');
      if (!err && !ok) return;
      if (typeof location === 'undefined' || typeof history === 'undefined' || typeof URLSearchParams === 'undefined') return;
      try {
        const p = new URLSearchParams(location.search);
        p.delete('yt'); p.delete('yt_error');
        const q = p.toString();
        history.replaceState(null, '', location.pathname + (q ? '?' + q : ''));
      } catch (e) { /* the notice already showed */ }
    }

    return { load, handleReturn };
  })();
`
