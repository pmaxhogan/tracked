// Shared client code for the Set page and the DJ profile: one track row and the
// lazy per-track link lookups. Both pages paste TRACK_ROW_JS inside their own
// IIFE, so it declares no globals; it needs TK (the shared runtime). Upstream
// text (artist, title, URLs) is only ever placed with textContent, and hrefs
// only through TK.safeHref (http and https).

/** Page CSS for track rows and the link pills. Colours come from the tokens. */
export const TRACK_ROW_CSS = /* css */ `
  .trk .txt .ttl { font-weight: 600; }
  .trk .txt .ttl a { color: inherit; text-decoration: none; }
  .trk .txt .ttl a:hover { text-decoration: underline; }
  .trk .sub { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--subtle); font-size: .76rem; }
  .trk .tag { font-size: .66rem; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; padding: 1px 6px; border-radius: 999px; background: var(--warn-bg); color: var(--warn); }
  .trk .links .btn.small { padding: 1px 8px; font-size: .7rem; font-weight: 600; border-radius: 4px; }
  .pill { display: inline-flex; align-items: center; font-size: .78rem; font-weight: 600; padding: 4px 10px; border: 1px solid var(--line-strong); border-radius: 999px; color: var(--fg); text-decoration: none; white-space: nowrap; }
  .pill:hover { border-color: var(--accent); color: var(--accent); }
  .result.bad { color: var(--danger); }
`

/**
 * Defines, inside the page IIFE: LINKABLE, fetchLinks, applyLinks,
 * lazyLinkButton, loadAllLinks, pill, fillRowActions, trackRow.
 * Each link lookup is one budgeted 1001tracklists page view (cached 30 days),
 * so nothing is looked up until a row's "links" button or "Load links" is pressed.
 */
export const TRACK_ROW_JS = /* js */ `
  const linkRows = new WeakMap();
  const LINKABLE = (t) => !t.isUnidentified && t.trackId && /^\\d+$/.test(t.trackId) && !t.appleLink && !t.youtubeLink && !t.soundcloudLink;
  function pill(url, label, title) {
    const href = TK.safeHref(url);
    if (!href) return null;
    const a = document.createElement('a');
    a.className = 'pill';
    a.href = href; a.target = '_blank'; a.rel = 'noreferrer noopener';
    a.textContent = label;
    if (title) a.setAttribute('data-tip', title);
    return a;
  }
  async function fetchLinks(ids) {
    const res = await TK.api.post('/ui/api/tracklist/links', { trackIds: ids });
    const d = res.data && typeof res.data === 'object' ? res.data : {};
    const msg = TK.errText(res, 'failed (' + res.status + ')');
    if (!res.ok && !d.links) throw new Error(msg);
    return { links: d.links || {}, error: res.ok ? null : msg };
  }
  function applyLinks(b, ml) {
    const row = linkRows.get(b);
    if (!row || !ml) return;
    b.remove();
    if (!ml.appleLink && !ml.youtubeLink && !ml.soundcloudLink) { const s = document.createElement('span'); s.textContent = 'no links'; row.actions.appendChild(s); return; }
    Object.assign(row.t, ml);
    row.fill(row.actions, row.t);
  }
  function lazyLinkButton(t, actions, fill) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn small links-btn'; b.textContent = 'links';
    b.setAttribute('data-tip', 'Looks up Apple Music and YouTube links for this track. Costs one 1001tracklists page view; the result is cached for 30 days.');
    linkRows.set(b, { t, actions, fill });
    b.addEventListener('click', async (ev) => {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      b.disabled = true; b.textContent = '…';
      try { const r = await fetchLinks([t.trackId]); applyLinks(b, r.links[t.trackId]); if (r.error && !r.links[t.trackId]) throw new Error(r.error); }
      catch (e) { b.disabled = false; b.textContent = 'links'; b.setAttribute('data-tip', 'Lookup failed: ' + (e && e.message ? e.message : e) + ' Press to try again.'); }
    });
    return b;
  }
  async function loadAllLinks(root, status) {
    const buttons = [...root.querySelectorAll('button.links-btn')].filter((b) => linkRows.has(b));
    const byId = new Map();
    for (const b of buttons) { const id = linkRows.get(b).t.trackId; if (!byId.has(id)) byId.set(id, []); byId.get(id).push(b); }
    const ids = [...byId.keys()];
    let done = 0;
    for (let i = 0; i < ids.length; i += 25) {
      const chunk = ids.slice(i, i + 25);
      if (status) status.textContent = 'Loading links ' + done + ' / ' + ids.length + '…';
      const r = await fetchLinks(chunk);
      for (const id of chunk) for (const b of byId.get(id)) applyLinks(b, r.links[id]);
      done += Object.keys(r.links).length;
      if (r.error) { if (status) status.textContent = 'Links stopped: ' + r.error; return; }
    }
    if (status) status.textContent = ids.length ? 'Links loaded for ' + ids.length + ' tracks.' : 'No tracks left to look up.';
  }
  function fillRowActions(actions, t) {
    const yt = pill(t.youtubeLink, 'YouTube', 'Play this track on YouTube'); if (yt) actions.appendChild(yt);
    const sc = pill(t.soundcloudLink, 'SoundCloud', 'Play this track on SoundCloud (free, with ads)'); if (sc) actions.appendChild(sc);
    const ap = pill(t.appleLink, 'Apple Music', 'Open this track in Apple Music'); if (ap) actions.appendChild(ap);
  }
  function tagEl(text, tip) { const s = document.createElement('span'); s.className = 'tag'; s.textContent = text; if (tip) s.setAttribute('data-tip', tip); return s; }
  function trackRow(t) {
    const row = document.createElement('div');
    row.className = 'trk';
    const cue = document.createElement('div');
    cue.className = 'cue';
    cue.textContent = t.startTime || String((t.index ?? 0) + 1);
    row.appendChild(cue);
    if (t.artworkUrl) {
      const img = document.createElement('img');
      img.className = 'art'; img.loading = 'lazy'; img.alt = ''; img.src = t.artworkUrl;
      img.addEventListener('error', () => { const ph = document.createElement('div'); ph.className = 'art'; img.replaceWith(ph); });
      row.appendChild(img);
    } else {
      const ph = document.createElement('div'); ph.className = 'art'; row.appendChild(ph);
    }
    const txt = document.createElement('div');
    txt.className = 'txt';
    const ttl = document.createElement('div');
    ttl.className = 'ttl';
    const label = (t.artist ? t.artist + ' – ' : '') + (t.title || 'ID');
    const href = t.trackUrl ? TK.safeHref(t.trackUrl) : null;
    if (href) {
      const a = document.createElement('a');
      a.textContent = label; a.href = href; a.target = '_blank'; a.rel = 'noreferrer noopener';
      ttl.appendChild(a);
    } else { ttl.textContent = label; }
    txt.appendChild(ttl);
    const sub = document.createElement('div');
    sub.className = 'sub';
    if (t.startTime) { const n = document.createElement('span'); n.textContent = '#' + ((t.index ?? 0) + 1); sub.appendChild(n); }
    if (t.idStatus) sub.appendChild(tagEl(t.idStatus, 'Only partly identified: 1001tracklists knows the base track but not the exact version (remix, edit or mashup).'));
    else if (t.isUnidentified) sub.appendChild(tagEl('ID', 'Not identified yet: nobody has told 1001tracklists what this track is.'));
    if (t.isMashupLinked) sub.appendChild(tagEl('w/', 'Played together with the track above it (a mashup or layered over it), not after it.'));
    if (sub.childNodes.length) txt.appendChild(sub);
    row.appendChild(txt);
    const actions = document.createElement('div');
    actions.className = 'links';
    fillRowActions(actions, t);
    const tl = pill(t.trackUrl, '1001tl', 'This track on 1001tracklists'); if (tl) actions.appendChild(tl);
    if (LINKABLE(t)) actions.appendChild(lazyLinkButton(t, actions, fillRowActions));
    row.appendChild(actions);
    return row;
  }
`
