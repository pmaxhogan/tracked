// Client code shared by the DJs page, the Playlists page and the DJ profile:
// the sync / resync calls with the contract's status text, the YouTube
// reconnect toast, the "fix titles" dialog, the per-DJ sync-state reader and
// a small concurrency pool. DJ_ACTIONS_JS is a fragment embedded inside a
// page's own IIFE (it declares `const DJA`, nothing at top level and no
// global); DJ_ACTIONS_CSS and FIX_DIALOG_HTML go in the page's CSS and body.

/** The dialog the "Fix titles" button opens: one page-level <dialog>. */
export const FIX_DIALOG_HTML = /* html */ `
<dialog id="fix-dialog" class="tk-dialog" aria-labelledby="fix-title">
  <h2 id="fix-title">Fix playlist titles</h2>
  <div id="fix-body" class="fix-body"></div>
  <div class="actions"><button id="fix-close" type="button" class="btn">Close</button></div>
</dialog>`

/** Tooltip text for the Fix titles button (use with tipAttr). */
export const FIX_TITLES_TITLE = 'Renames DJ playlists still titled "Tracklists By ..." to the artist name. Shows the list first and asks before changing anything on YouTube.'

export const DJ_ACTIONS_CSS = /* css */ `
  .btn.small { padding: 5px 10px; font-size: var(--fs-sm); }
  .toast a { font-weight: 600; margin-left: var(--sp-2); }
  .fix-body ul { margin: var(--sp-2) 0 0; padding-left: 1.1rem; }
  .fix-body li { overflow-wrap: anywhere; }
`

export const DJ_ACTIONS_JS = /* js */ `
  const DJA = (() => {
    const esc = TK.esc;
    const REAUTH_TEXT = TK.errText({ data: { error: 'youtube_reauth_required' } }, '');

    // The server cleared the stored tokens: say so, with a way back to the sign-in.
    function reauthToast() {
      TK.toast(REAUTH_TEXT, 'bad', null, { href: '/ui/oauth/start', text: 'Reconnect YouTube' });
    }

    // Sync or Invalidate & resync one DJ. btn is optional (rows that track their own busy state pass null).
    // Resolves { ok, reauth?, data? }; the toast says what happened.
    async function syncSlug(slug, btn, opts) {
      const resync = !!(opts && opts.resync);
      return TK.busy(btn, resync ? 'Resyncing…' : 'Syncing…', async () => {
        const res = await TK.api.post('/ui/api/' + (resync ? 'resync' : 'sync') + '/' + encodeURIComponent(slug), {});
        const data = res.data && typeof res.data === 'object' ? res.data : {};
        if (!res.ok) {
          if (res.status === 412 && data.error === 'youtube_reauth_required') { reauthToast(); return { ok: false, reauth: true }; }
          const msg = data.errorMessage || TK.errText(res, 'sync failed (' + res.status + ')');
          const detail = data.errorStack
            || (data.errorName && data.errorName !== 'Error' ? data.errorName : null)
            || (res.raw && res.raw !== msg ? res.raw : null);
          TK.toast('sync failed: ' + msg, 'bad', detail);
          return { ok: false };
        }
        const stats = data.stats || {};
        const pending = stats.tracklistsPending || 0;
        const rechecksPending = stats.rechecksPending || 0;
        const continuing = [];
        if (pending > 0) continuing.push(pending + ' new pending');
        if (rechecksPending > 0) continuing.push(rechecksPending + ' recheck' + (rechecksPending === 1 ? '' : 's') + ' pending');
        const more = continuing.length ? ' · ' + continuing.join(', ') + ' — auto-continuing every 5 min' : '';
        const combined = stats.combinedVideoIdsAdded ? ' · ' + stats.combinedVideoIdsAdded + ' into the combined playlist' : '';
        const rechecked = stats.tracklistsRechecked ? ' · rechecked ' + stats.tracklistsRechecked + ', replaced ' + (stats.videosReplaced || 0) : '';
        const inv = data.invalidated ? ' (invalidated ' + (data.invalidated.tracklistsMarked || 0) + ' cached videos)' : '';
        TK.toast((resync ? 'resynced ' : 'synced ') + slug + inv + ' — ' + (stats.videoIdsAdded || 0) + ' new of ' +
          (stats.tracklistsProcessed || 0) + ' set' + (stats.tracklistsProcessed === 1 ? '' : 's') +
          ' processed (' + (stats.tracklistsSeen || 0) + ' total on the DJ page)' + rechecked + combined + more, 'ok');
        return { ok: true, data };
      });
    }

    // Invalidate & resync all: ONE request, one server-side pass on one shared fetch
    // budget. Never a request per DJ: that loop got the 1001tracklists accounts banned twice.
    // total = how many DJs are listed. Resolves null when the owner declines.
    async function resyncAll(btn, total) {
      const yes = await TK.ask('Re-fetch every set of every DJ? Swapped recordings get replaced in the playlists. This drains over the next few cron ticks.', { yes: 'Resync all', danger: true });
      if (!yes) return null;
      return TK.busy(btn, 'Resyncing all…', async () => {
        const res = await TK.api.post('/ui/api/resync', {});
        const data = res.data && typeof res.data === 'object' ? res.data : {};
        if (!res.ok) {
          if (res.status === 412 && data.error === 'youtube_reauth_required') { reauthToast(); return { ok: false, reauth: true }; }
          TK.toast('resync all failed: ' + (data.errorMessage || TK.errText(res, 'resync failed (' + res.status + ')')), 'bad', data.errorStack || null);
          return { ok: false };
        }
        if (data.paused) {
          TK.toast('resync all: 1001tracklists fetching is paused (see the banner); nothing was fetched.', 'bad');
          return { ok: false, paused: true };
        }
        const results = data.results || [];
        const sum = (f) => results.reduce((a, x) => a + (f(x.stats || {}) || 0), 0);
        const invalidated = (data.invalidated || []).reduce((a, x) => a + (x.tracklistsMarked || 0), 0);
        const pending = sum((s) => (s.rechecksPending || 0) + (s.tracklistsPending || 0));
        const failed = results.filter((x) => x.ok === false).map((x) => x.slug);
        TK.toast('resynced ' + results.length + ' of ' + total + ' DJs this pass (invalidated ' + invalidated + ' cached videos) — rechecked ' + sum((s) => s.tracklistsRechecked) +
          ', replaced ' + sum((s) => s.videosReplaced) + ', ' + sum((s) => s.videoIdsAdded) + ' new' +
          (pending ? ' · ' + pending + ' still pending — auto-continuing every 5 min' : '') +
          (failed.length ? ' · failed: ' + failed.join(', ') : ''), 'ok');
        return { ok: true, data };
      });
    }

    // ── fix titles: a dry run in a dialog first, then the rename after a confirm ──
    function showFixes(d) {
      const body = TK.$('fix-body');
      const fixes = Array.isArray(d.fixes) ? d.fixes : [];
      if (!body) return;
      if (!fixes.length) { body.textContent = 'All ' + (d.checked || 0) + ' DJ playlist titles are fine.'; return; }
      body.innerHTML = '<ul>' + fixes.map((f) => '<li>' + esc(f.oldTitle) + ' → ' + esc(f.newTitle) +
        (f.status === 'failed' ? ' (failed: ' + esc(f.error || '') + ')' : f.status === 'renamed' ? ' (renamed)' : '') + '</li>').join('') + '</ul>';
    }
    function openFix() {
      const dlg = TK.$('fix-dialog'), close = TK.$('fix-close');
      if (close) close.onclick = () => { if (dlg && typeof dlg.close === 'function') dlg.close(); };
      if (dlg && !dlg.open && typeof dlg.showModal === 'function') { try { dlg.showModal(); } catch (e) {} }
    }
    async function fixTitles(btn) {
      await TK.busy(btn, 'Checking…', async () => {
        const preview = await TK.api.post('/ui/api/playlists/fix-titles', { dryRun: true });
        if (!preview.ok) { TK.toast('fix playlist titles: ' + TK.errText(preview, 'failed (' + preview.status + ')'), 'bad'); return; }
        const pd = preview.data || {};
        const n = Array.isArray(pd.fixes) ? pd.fixes.length : 0;
        showFixes(pd);
        openFix();
        if (!n) return;
        if (!(await TK.ask('Rename ' + n + ' playlist' + (n === 1 ? '' : 's') + ' on YouTube (50 quota units each)?', { yes: 'Rename' }))) return;
        const real = await TK.api.post('/ui/api/playlists/fix-titles', { dryRun: false });
        if (!real.ok) { TK.toast('fix playlist titles: ' + TK.errText(real, 'failed (' + real.status + ')'), 'bad'); return; }
        showFixes(real.data || {});
      });
    }

    // ── per-DJ sync state (GET /ui/api/state/:slug -> { state }) ──
    function summarize(st) {
      if (!st) return null;
      const processed = new Set(st.processedTracklistUrls || []);
      const known = new Set(st.discoveredTracklistUrls || []);
      for (const u of processed) known.add(u);
      let pending = 0;
      for (const u of known) if (!processed.has(u)) pending++;
      const vids = st.tracklistVideos || {};
      let videos = 0, mkvid = 0;
      for (const k of Object.keys(vids)) {
        const v = vids[k];
        if (v && v.videoId) { videos++; if (v.source === 'mkvid') mkvid++; }
      }
      return { processed: processed.size, known: known.size, pending, videos, mkvid };
    }
    function playlistHref(st) {
      return st && st.playlistId ? TK.safeHref('https://www.youtube.com/playlist?list=' + encodeURIComponent(st.playlistId)) : null;
    }
    function lastRun(st) {
      if (!st || !st.lastRunAt) return '';
      try { return TK.fmt.rel(new Date(st.lastRunAt * 1000).toISOString()); } catch (e) { return ''; }
    }
    // Resolves { state } (null when the DJ has none yet) or { failed: true }.
    // Live state for one DJ. Goes through TK.api.swr so the answer is also
    // stored for the next page view (storedState reads it back); the stored
    // copy itself is not delivered here.
    async function loadState(slug) {
      let out = { failed: true };
      await TK.api.swr(statePath(slug), (res) => { if (res.stale) return; out = !res.ok || !res.data ? { failed: true } : { state: res.data.state || null }; });
      return out;
    }
    const statePath = (slug) => '/ui/api/state/' + encodeURIComponent(slug);
    // The state this browser stored at the last view, or undefined: a row can paint from it before its live load.
    function storedState(slug) {
      const d = TK.api.stored(statePath(slug));
      return d && d.state !== undefined ? d.state : undefined;
    }
    // Runs fn over items, at most limit at a time. fn failures never stop the rest.
    async function pool(items, limit, fn) {
      let i = 0;
      const worker = async () => {
        while (i < items.length) {
          const item = items[i++];
          try { await fn(item); } catch (e) { /* the row keeps its skeleton-free empty state */ }
        }
      };
      await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    }

    return { syncSlug, resyncAll, fixTitles, reauthToast, summarize, playlistHref, lastRun, loadState, storedState, pool };
  })();
`
