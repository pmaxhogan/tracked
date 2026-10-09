// Shared client code for the Set page and the DJ profile: a set's track list as
// a data table (TKTable, local mode), the lazy per-track link lookups and the
// Pre-save button. Both pages paste TRACK_ROW_JS inside their own IIFE, so it
// declares no globals; it needs TK (the shared runtime) and TKTable. The Search
// page pastes it too and uses fetchLinks and pill. Upstream text (artist,
// title, URLs) is always escaped with TK.esc, and hrefs only pass through
// TK.safeHref (http and https).

/** Page CSS for the track table and the link pills. Colours come from the tokens. */
export const TRACK_ROW_CSS = /* css */ `
  .trk .txt .ttl { font-weight: 600; }
  .trk .txt .ttl a { color: inherit; text-decoration: none; }
  .trk .txt .ttl a:hover { text-decoration: underline; }
  .trk .sub { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--subtle); font-size: .76rem; }
  .trk .tag, .trt .tag { font-size: .66rem; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; padding: 1px 6px; border-radius: 999px; background: var(--warn-bg); color: var(--warn); white-space: nowrap; }
  .trt .tag.ok { background: var(--accent-soft); color: var(--accent); }
  .trt .tag.mx { background: var(--elev); color: var(--muted); }
  .trk .links .btn.small { padding: 1px 8px; font-size: .7rem; font-weight: 600; border-radius: 4px; }
  .pill { display: inline-flex; align-items: center; font-size: .78rem; font-weight: 600; padding: 4px 10px; border: 1px solid var(--line-strong); border-radius: 999px; color: var(--fg); text-decoration: none; white-space: nowrap; }
  .pill:hover { border-color: var(--accent); color: var(--accent); }
  .result.bad { color: var(--danger); }
  .trt .tkt-table td { vertical-align: middle; }
  .trt .trt-cue { font-family: var(--mono); color: var(--subtle); font-size: .78rem; white-space: nowrap; }
  .trt .trt-art { display: block; width: 36px; height: 36px; border-radius: 4px; background: var(--elev); object-fit: cover; }
  .trt .trt-artist { color: var(--muted); }
  .trt .trt-title { font-weight: 600; overflow-wrap: anywhere; }
  .trt .trt-title a { color: inherit; text-decoration: none; }
  .trt .trt-title a:hover { text-decoration: underline; }
  .trt .trt-links { display: flex; flex-wrap: wrap; gap: 4px; }
  .trt .trt-links .pill { font-size: .7rem; padding: 2px 8px; }
  .trt .trt-links .btn.small, .trt .tkt-acts .btn.small { padding: 2px 8px; font-size: .72rem; font-weight: 600; }
  .trt .trt-none { color: var(--subtle); font-size: .75rem; }
  .trt .btn.saved { border-color: var(--accent); color: var(--accent); text-decoration: none; }
  @media (max-width: 699px) {
    .trt .trt-art { width: 44px; height: 44px; }
  }
`

/**
 * Defines, inside the page IIFE: pill(url, label, tip) (an <a> element),
 * fetchLinks(ids), and TRK, the track table:
 *
 *   const tt = TRK.create(el, { id: 'trk', setUrl, djSlug?, data, urlState? })
 *   tt.setData(data)               // a new /ui/api/tracklist answer
 *   tt.loadAllLinks(statusEl)      // "Load links": every lookup-able row, 25 ids per request
 *   tt.rows()                      // every row (not just the page)
 *
 * Rows are the answer's `rows` (every page row, anonymous "ID - ID" rows
 * included) merged with `tracks` (by rowIndex), or `tracks` alone for an
 * older cache entry. A "w/" row stays right after its base row under any sort.
 * Each link lookup is one budgeted 1001tracklists page view (cached 30 days),
 * so nothing is looked up until a row's "links" button or "Load links" is
 * pressed. Pre-save: rows with no YouTube link get a button that POSTs
 * /ui/api/presaves; rows already saved (POST /ui/api/presaves/lookup on load)
 * link to /ui/presave?id=.
 */
export const TRACK_ROW_JS = /* js */ `
  function pill(url, label, tip) {
    const href = TK.safeHref(url);
    if (!href) return null;
    const a = document.createElement('a');
    a.className = 'pill';
    a.href = href; a.target = '_blank'; a.rel = 'noreferrer noopener';
    a.textContent = label;
    if (tip) a.setAttribute('data-tip', tip);
    return a;
  }
  async function fetchLinks(ids) {
    const res = await TK.api.post('/ui/api/tracklist/links', { trackIds: ids });
    const d = res.data && typeof res.data === 'object' ? res.data : {};
    const msg = TK.errText(res, 'failed (' + res.status + ')');
    if (!res.ok && !d.links) throw new Error(msg);
    return { links: d.links || {}, error: res.ok ? null : msg };
  }

  const TRK = (() => {
    const esc = TK.esc;
    const isId = (s) => !s || /^\\s*id\\s*$/i.test(String(s));
    const numericId = (r) => (!r.anonymous && r.trackId && /^\\d+$/.test(String(r.trackId)) ? String(r.trackId) : null);
    const LINKABLE = (r) => !!numericId(r) && !r.isUnidentified && !r.appleLink && !r.youtubeLink && !r.soundcloudLink && !r._lk;
    const pillHtml = (url, label, tip) => { const h = TK.safeHref(url); return h ? '<a class="pill" href="' + esc(h) + '" target="_blank" rel="noreferrer noopener"' + TK.tip(tip) + '>' + esc(label) + '</a>' : ''; };

    // Status and link sources as multi-valued enums (filterable), recomputed after a link lookup.
    function derive(r) {
      const st = [];
      if (r.idStatus) st.push('partial');
      else if (r.anonymous || r.isUnidentified) st.push('id');
      else st.push('known');
      if (r.isMashupLinked) st.push('mashup');
      r._st = st;
      const ln = [];
      if (r.youtubeLink) ln.push('youtube');
      if (r.soundcloudLink) ln.push('soundcloud');
      if (r.appleLink) ln.push('apple');
      if (r.trackUrl) ln.push('1001tl');
      r._ln = ln.length ? ln : ['none'];
      return r;
    }

    // rows (every page row) merged with tracks (named rows, with links) by rowIndex; tracks alone for an old cache entry.
    function rowsOf(data) {
      const tracks = Array.isArray(data && data.tracks) ? data.tracks : [];
      const rows = Array.isArray(data && data.rows) ? data.rows : [];
      let out;
      if (rows.length) {
        const byRow = new Map();
        for (const t of tracks) if (t && t.rowIndex != null) byRow.set(Number(t.rowIndex), t);
        out = rows.map((r) => {
          const t = byRow.get(Number(r.rowIndex)) || {};
          return Object.assign({}, t, r, {
            appleLink: t.appleLink || null, youtubeLink: t.youtubeLink || null, soundcloudLink: t.soundcloudLink || null,
            trackId: r.anonymous ? null : (r.trackId || t.trackId || null),
          });
        });
      } else {
        out = tracks.map((t, i) => Object.assign({}, t, { rowIndex: t.rowIndex != null ? t.rowIndex : (t.index != null ? t.index : i), cueSeconds: t.startSeconds != null ? t.startSeconds : null, anonymous: false }));
      }
      let base = null;
      out.forEach((r, i) => {
        r.n = i + 1;
        if (r.cueSeconds == null && r.startSeconds != null) r.cueSeconds = r.startSeconds;
        // A "w/" row belongs to the nearest row above it that is not one.
        if (!r.isMashupLinked || base == null) base = r.rowIndex;
        r._g = base;
        derive(r);
      });
      return out;
    }

    const STATUS = [{ value: 'known', label: 'Identified' }, { value: 'partial', label: 'Partial ID' }, { value: 'id', label: 'ID' }, { value: 'mashup', label: 'w/' }];
    const SOURCES = [{ value: 'youtube', label: 'YouTube' }, { value: 'soundcloud', label: 'SoundCloud' }, { value: 'apple', label: 'Apple Music' }, { value: '1001tl', label: '1001tracklists' }, { value: 'none', label: 'None' }];

    function statusHtml(r) {
      let h = '';
      if (r.idStatus) h += '<span class="tag"' + TK.tip('Only partly identified: 1001tracklists knows the base track but not the exact version (remix, edit or mashup).') + '>' + esc(r.idStatus) + '</span> ';
      else if (r.anonymous || r.isUnidentified) h += '<span class="tag"' + TK.tip('Not identified yet: nobody has told 1001tracklists what this track is.') + '>ID</span> ';
      if (r.isMashupLinked) h += '<span class="tag mx"' + TK.tip('Played together with the track above it (a mashup or layered over it), not after it.') + '>w/</span>';
      return h || '<span class="tkt-nil">–</span>';
    }
    function linksHtml(r) {
      let h = pillHtml(r.youtubeLink, 'YouTube', 'Play this track on YouTube') +
        pillHtml(r.soundcloudLink, 'SoundCloud', 'Play this track on SoundCloud (free, with ads)') +
        pillHtml(r.appleLink, 'Apple', 'Open this track in Apple Music') +
        pillHtml(r.trackUrl, '1001tl', 'This track on 1001tracklists');
      if (r._lk === 'busy') h += '<button type="button" class="btn small" disabled>…</button>';
      else if (LINKABLE(r)) h += '<button type="button" class="btn small links-btn" data-act="links"' + TK.tip(r._lkErr ? 'Lookup failed: ' + r._lkErr + ' Press to try again.' : 'Looks up Apple Music and YouTube links for this track. Costs one 1001tracklists page view; the result is cached for 30 days.') + '>links</button>';
      else if (r._lk === 'none') h += '<span class="trt-none">no links</span>';
      return '<span class="trt-links">' + h + '</span>';
    }
    const canPresave = (r, setUrl) => !r.youtubeLink && (!!numericId(r) || !!TK.safeHref(r.trackUrl) || (!!setUrl && r.rowIndex != null));
    function presaveHtml(r, setUrl) {
      if (r._ps) {
        const found = r._ps.stage === 'found' || r._ps.stage === 'uploaded';
        return '<a class="btn small saved" href="/ui/presave?id=' + esc(encodeURIComponent(String(r._ps.id))) + '"' + TK.tip(found ? 'Pre-saved and now on YouTube. Opens the pre-save.' : 'Pre-saved: rechecked twice a day until it has a YouTube link. Opens the pre-save.') + '>' + (found ? 'On YouTube ✓' : 'Pre-saved ✓') + '</a>';
      }
      if (!canPresave(r, setUrl)) return '';
      return '<button type="button" class="btn small" data-act="presave"' + (r._psBusy ? ' disabled' : '') + TK.tip('Watches this track for a YouTube link: rechecked twice a day, with a push when one appears.') + '>' + (r._psBusy ? 'Saving…' : 'Pre-save') + '</button>';
    }

    function create(el, opts) {
      opts = opts || {};
      let rows = rowsOf(opts.data || {});
      let setUrl = opts.setUrl || (opts.data && opts.data.tracklistUrl) || null;
      const columns = [
        { key: 'n', label: '#', type: 'number', width: '3rem', hideOn: 'phone', tip: 'The row on the 1001tracklists page.' },
        { key: 'cueSeconds', label: 'Cue', type: 'number', align: 'right', render: (r) => '<span class="trt-cue">' + esc(r.startTime || '') + '</span>', tip: 'When the track starts in the set.' },
        { key: 'art', label: 'Art', sortable: false, filterable: false, searchable: false, value: (r) => r.artworkUrl || null,
          render: (r) => { const h = TK.safeHref(r.artworkUrl); return h ? '<img class="trt-art" loading="lazy" alt="" src="' + esc(h) + '">' : '<span class="trt-art"></span>'; } },
        { key: 'artist', label: 'Artist', type: 'text', render: (r) => '<span class="trt-artist">' + esc(r.artist || 'ID') + '</span>' },
        { key: 'title', label: 'Title', type: 'text', render: (r) => { const h = TK.safeHref(r.trackUrl); const t = esc(r.title || 'ID'); return '<span class="trt-title">' + (h ? '<a href="' + esc(h) + '" target="_blank" rel="noreferrer noopener">' + t + '</a>' : t) + '</span>'; } },
        { key: 'status', label: 'Status', type: 'enum', multi: true, sortable: false, options: STATUS, value: (r) => r._st, render: statusHtml, tip: 'ID: not identified. Partial ID: the base track is known, not the version. w/: played together with the row above.' },
        { key: 'links', label: 'Links', type: 'enum', multi: true, sortable: false, options: SOURCES, value: (r) => r._ln, render: linksHtml, tip: 'Where the track can be played. Links are looked up on demand (one 1001tracklists page view each, cached 30 days).' },
      ];
      let table = null;
      // The track-table styles hang off .trt on the host.
      try { if (el.classList && el.classList.add) el.classList.add('trt'); else if (el && String(el.className || '').indexOf('trt') < 0) el.className = (el.className ? el.className + ' ' : '') + 'trt'; } catch (e) {}
      const tt = {
        rows: () => rows.slice(),
        reload: () => (table ? table.reload() : null),
      };
      table = TKTable.create(el, {
        id: opts.id || 'trk',
        urlState: opts.urlState,
        source: { rows: () => rows },
        columns,
        defaultSort: 'n',
        pageSize: 500,
        pageSizes: [50, 100, 200, 500],
        search: 'Search artist or title',
        chips: [
          { id: 'all', label: 'All', group: 'f', on: true },
          { id: 'ids', label: 'IDs', group: 'f', filters: [{ col: 'status', op: 'in', value: 'id|partial' }], tip: 'Rows not (fully) identified yet.', count: () => rows.filter((r) => r._st.indexOf('id') >= 0 || r._st.indexOf('partial') >= 0).length },
          { id: 'noyt', label: 'No YouTube', group: 'f', filters: [{ col: 'links', op: 'nin', value: 'youtube' }], tip: 'Rows with no YouTube link known (press Load links first to look them up).' },
          { id: 'mashups', label: 'w/', group: 'f', filters: [{ col: 'status', op: 'in', value: 'mashup' }], tip: 'Rows played together with the row above them.' },
        ],
        rowKey: 'rowIndex',
        group: { key: (r) => r._g, isChild: (r) => !!r.isMashupLinked && r._g !== r.rowIndex },
        actions: (r) => presaveHtml(r, setUrl),
        onAction: (act, r) => {
          if (act === 'links') return linkOne(r);
          if (act === 'presave') return presave(r);
        },
        empty: 'No tracks found.',
      });
      // A broken artwork URL shows the empty square instead of a broken image.
      if (el && typeof el.addEventListener === 'function') el.addEventListener('error', (ev) => {
        const t = ev.target;
        if (t && t.tagName === 'IMG' && t.classList && t.classList.contains('trt-art')) { try { const ph = document.createElement('span'); ph.className = 'trt-art'; t.replaceWith(ph); } catch (e) {} }
      }, true);

      function applyLinks(id, ml) {
        for (const r of rows) {
          if (numericId(r) !== id) continue;
          if (!ml) { r._lk = null; continue; }
          if (!ml.appleLink && !ml.youtubeLink && !ml.soundcloudLink) { r._lk = 'none'; continue; }
          Object.assign(r, { appleLink: ml.appleLink || null, youtubeLink: ml.youtubeLink || null, soundcloudLink: ml.soundcloudLink || null });
          r._lk = 'done';
          derive(r);
        }
      }
      async function linkOne(r) {
        const id = numericId(r);
        if (!id || r._lk === 'busy') return;
        r._lk = 'busy'; r._lkErr = null; table.reload();
        try {
          const out = await fetchLinks([id]);
          applyLinks(id, out.links[id]);
          if (!out.links[id]) { r._lk = null; r._lkErr = out.error || 'no answer.'; }
        } catch (e) { r._lk = null; r._lkErr = e && e.message ? e.message : String(e); }
        table.reload();
      }
      async function loadAllLinks(status) {
        const ids = [...new Set(rows.filter(LINKABLE).map(numericId))];
        let done = 0;
        for (let i = 0; i < ids.length; i += 25) {
          const chunk = ids.slice(i, i + 25);
          if (status) status.textContent = 'Loading links ' + done + ' / ' + ids.length + '…';
          const r = await fetchLinks(chunk);
          for (const id of chunk) if (r.links[id]) applyLinks(id, r.links[id]);
          done += Object.keys(r.links).length;
          table.reload();
          if (r.error) { if (status) status.textContent = 'Links stopped: ' + r.error; return; }
        }
        if (status) status.textContent = ids.length ? 'Links loaded for ' + ids.length + ' tracks.' : 'No tracks left to look up.';
      }

      async function presave(r) {
        if (r._psBusy || r._ps) return;
        const body = { tracklistUrl: setUrl || undefined, rowIndex: r.rowIndex != null ? r.rowIndex : undefined };
        const id = numericId(r);
        if (id) body.trackId = id;
        if (TK.safeHref(r.trackUrl)) body.trackUrl = r.trackUrl;
        if (r.cueSeconds != null && r.cueSeconds >= 0) body.cueSeconds = Math.round(r.cueSeconds);
        if (!isId(r.artist)) body.artist = r.artist;
        if (!isId(r.title)) body['title'] = r.title;
        if (TK.safeHref(r.artworkUrl)) body.artworkUrl = r.artworkUrl;
        if (opts.djSlug) body.djSlug = opts.djSlug;
        r._psBusy = true; table.reload();
        const res = await TK.api.post('/ui/api/presaves', body);
        r._psBusy = false;
        const d = res.data && typeof res.data === 'object' ? res.data : {};
        if (!res.ok || !d.presave) { TK.toast('Pre-save failed: ' + TK.errText(res, 'failed (' + res.status + ')'), 'bad'); table.reload(); return; }
        const ps = { id: d.presave.id, stage: d.presave.stage };
        // The same track elsewhere in the set is the same pre-save.
        for (const x of rows) if (x === r || (id && numericId(x) === id)) x._ps = ps;
        TK.toast(d.message || 'Pre-saved.', 'ok', null, { href: '/ui/presave?id=' + encodeURIComponent(String(ps.id)), text: 'Open pre-save' });
        table.reload();
      }

      // Rows already pre-saved: by medialink id, and ID rows of this set by row index.
      async function lookup() {
        const ids = [...new Set(rows.map(numericId).filter(Boolean))].slice(0, 500);
        if (!ids.length && !setUrl) return;
        const res = await TK.api.post('/ui/api/presaves/lookup', { trackIds: ids, setUrl: setUrl || undefined });
        if (!res.ok || !res.data) return;
        const byId = res.data.byTrackId || {}, byRow = res.data.byRow || {};
        let any = false;
        for (const r of rows) {
          const id = numericId(r);
          const hit = (id && byId[id]) || (!id && r.rowIndex != null && byRow[String(r.rowIndex)]) || null;
          if (hit) { r._ps = { id: hit.id, stage: hit.stage }; any = true; }
        }
        if (any) table.reload();
      }

      tt.setData = (data, url) => { rows = rowsOf(data || {}); setUrl = url || (data && data.tracklistUrl) || setUrl; table.reload(); lookup().catch(() => {}); };
      tt.loadAllLinks = loadAllLinks;
      tt.table = table;
      lookup().catch(() => {});
      return tt;
    }

    return { create, rowsOf };
  })();
`
