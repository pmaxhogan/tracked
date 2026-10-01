// The detail renderers for a request (now_playing_audit) and a playlist
// addition, shared by Home and Activity: dl(pairs), auditDetailHtml(r),
// plDetailHtml(r) and the helpers they need (link, clock, setLabel,
// BIG_SKEW). ACTIVITY_DETAIL_JS is spliced into a page's IIFE and assumes only
// TK and esc (= TK.esc) in scope; every upstream value goes through esc and
// every external link through TK.safeHref.
//
// Home relies on this string for clock, setLabel and BIG_SKEW (its request
// and addition rows use them) and declares none of them itself; a page that
// splices this in must not declare those names (or link, dl) again.

export const ACTIVITY_DETAIL_CSS = /* css */ `
  .h-grp { color: var(--subtle); font-size: var(--fs-xs); font-weight: 600; text-transform: uppercase; letter-spacing: .06em; margin: var(--sp-3) 0 var(--sp-2); }
  .h-grp:first-child { margin-top: 0; }
  .h-dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px var(--sp-3); margin: 0; font-size: var(--fs-sm); }
  .h-dl dt { color: var(--muted); }
  .h-dl dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .h-dl ol { margin: 0; padding-left: 1.1rem; }
  .h-dl .warn, .h-detail .warn { color: var(--danger); }
  .h-dl .when { color: var(--subtle); }
`

export const ACTIVITY_DETAIL_JS = /* js */ `
  const clock = TK.fmt.clock, setLabel = TK.fmt.setLabel;
  const BIG_SKEW = 600; // |pos − track start| over 10 min → flag as suspicious
  function link(u, label) {
    // Only http(s) becomes a link; anything else renders as escaped text.
    if (!u) return '—';
    const h = TK.safeHref(u);
    if (!h) return esc(u);
    return '<a href="' + esc(h) + '" target="_blank" rel="noreferrer noopener">' + esc(label || u) + '</a>';
  }

  function dl(pairs) {
    return '<dl class="h-dl">' + pairs.filter(Boolean).map((p) => '<dt>' + esc(p[0]) + '</dt><dd>' + p[1] + '</dd>').join('') + '</dl>';
  }

  function auditDetailHtml(r) {
    // Legacy records (pre-metadata) stored fields flat; lift them into the
    // nested shape the renderer expects so old history still displays.
    if (!r.input) {
      r = {
        t: r.t, reqId: r.reqId, status: r.status, message: r.message,
        input: { videoTitle: r.videoTitle, videoUrl: r.videoUrl, currentSeconds: r.currentSeconds, videoDurationSeconds: r.videoDurationSeconds },
        impossibleTimestamp: r.impossibleTimestamp,
        youtube: r.youtube || { videoId: null, videoUrl: r.videoUrl, matchTitle: null, error: null },
        search: r.search || { attempts: [], via: r.tracklistVia || null, tracklistUrl: r.tracklistUrl || null },
        select: r.select || ((r.currentStartSeconds != null || r.currentTracks) ? {
          currentStartSeconds: r.currentStartSeconds != null ? r.currentStartSeconds : null,
          currentSkewSeconds: (r.currentStartSeconds != null && r.currentSeconds != null) ? r.currentSeconds - r.currentStartSeconds : null,
          trackCount: null, unidentifiedCount: null, currentTracks: r.currentTracks || [],
        } : null),
        meta: r.meta || {},
      };
    }
    const inp = r.input || {}, yt = r.youtube || {}, se = r.search || {}, sel = r.select, meta = r.meta || {};
    const out = [];

    out.push('<div class="h-grp">Input</div>');
    out.push(dl([
      ['title', esc(inp.videoTitle) || '—'],
      inp.videoUrl ? ['videoUrl', link(inp.videoUrl)] : null,
      ['position', clock(inp.currentSeconds) + (inp.videoDurationSeconds ? ' / ' + clock(inp.videoDurationSeconds) : '') +
        (r.impossibleTimestamp ? ' <span class="warn">— past end of video (client bug?)</span>' : '')],
    ]));

    out.push('<div class="h-grp">YouTube match</div>');
    out.push(dl([
      ['videoId', yt.videoId ? '<span class="mono">' + esc(yt.videoId) + '</span> ' + link('https://youtu.be/' + yt.videoId, 'open') : '<span class="warn">no match</span>'],
      yt.matchTitle ? ['matched title', esc(yt.matchTitle)] : null,
      yt.error ? ['error', '<span class="warn">' + esc(yt.error) + '</span>'] : null,
    ]));

    out.push('<div class="h-grp">Tracklist search</div>');
    const attempts = (se.attempts && se.attempts.length)
      ? '<ol>' + se.attempts.map((a) => '<li>' + esc(a.via) + ': <span class="mono">' + esc(a.query) + '</span>' + (a.via === se.via ? ' ✓' : '') + '</li>').join('') + '</ol>'
      : '—';
    out.push(dl([
      ['attempts', attempts],
      ['matched via', se.via ? esc(se.via) : '<span class="warn">no tracklist found</span>'],
      se.tracklistUrl ? ['tracklist', link(se.tracklistUrl, 'open')] : null,
    ]));

    if (sel) {
      out.push('<div class="h-grp">Selection</div>');
      const skewBad = sel.currentSkewSeconds != null && Math.abs(sel.currentSkewSeconds) > BIG_SKEW;
      const cur = (sel.currentTracks || []).map((t) => '<li>' + esc(t.startTime) + ' — ' + esc(t.artist) + ' – ' + esc(t.title) + '</li>').join('');
      out.push(dl([
        ['current track start', clock(sel.currentStartSeconds)],
        ['skew (pos − start)', '<span class="' + (skewBad ? 'warn' : '') + '">' + clock(sel.currentSkewSeconds) + '</span>'],
        ['tracks in set', (sel.trackCount != null ? esc(sel.trackCount) : '—') + (sel.unidentifiedCount ? ' (' + esc(sel.unidentifiedCount) + ' unidentified)' : '')],
        ['now playing', cur ? '<ol>' + cur + '</ol>' : '—'],
      ]));
    }

    out.push('<div class="h-grp">Meta</div>');
    out.push(dl([
      ['status', esc(r.status) + (r.message ? ' — ' + esc(r.message) : '')],
      ['when', esc(r.t)],
      ['edge', esc([meta.colo, meta.country].filter(Boolean).join(' · ')) || '—'],
      ['took', meta.totalMs != null ? esc(meta.totalMs) + ' ms' : '—'],
      ['reqId', '<span class="mono">' + esc(r.reqId) + '</span>'],
    ]));
    return out.join('');
  }

  function plDetailHtml(r) {
    const out = [];
    out.push('<div class="h-grp">Set</div>');
    out.push(dl([
      ['tracklist', link(r.setUrl, setLabel(r.setUrl))],
      ['DJ', esc(r.artistName || r.slug || '—') + (r.slug ? ' <span class="when">(' + esc(r.slug) + ')</span>' : '')],
      ['scraped via', r.via ? esc(r.via) : '—'],
    ]));

    out.push('<div class="h-grp">Playlist</div>');
    out.push(dl([
      ['video', r.videoId
        ? '<span class="mono">' + esc(r.videoId) + '</span> ' + link(r.videoUrl || ('https://youtu.be/' + r.videoId), 'open')
        : (r.status === 'failed' || r.status === 'abandoned')
          ? '<span class="warn">unknown — the set failed before a video was recorded</span>'
          : '<span class="warn">no YouTube recording on the set page</span>'],
      // A recheck found the set's recording swapped on 1001tracklists: this
      // is the one that came out of the playlists.
      r.previousVideoId
        ? ['replaced', '<span class="mono">' + esc(r.previousVideoId) + '</span> ' + link('https://youtu.be/' + r.previousVideoId, 'open')]
        : null,
      ['playlist', r.playlistId
        ? link('https://www.youtube.com/playlist?list=' + encodeURIComponent(r.playlistId), r.playlistTitle || r.playlistId)
        : '—'],
      // How the same video fared in the combined all-artists playlist. A miss
      // here isn't a set failure — the combined backfill re-derives it.
      ['combined', r.combinedStatus
        ? '<span class="' + (r.combinedStatus === 'failed' || r.combinedStatus === 'unavailable' ? 'warn' : '') + '">' + esc(r.combinedStatus) + '</span>'
        : '—'],
    ]));

    out.push('<div class="h-grp">Meta</div>');
    out.push(dl([
      ['status', esc(r.status) + (r.message ? ' — <span class="warn">' + esc(r.message) + '</span>' : '')],
      r.failureCount != null ? ['failures so far', esc(r.failureCount)] : null,
      ['trigger', r.trigger ? esc(r.trigger) : '—'],
      ['when', esc(r.t)],
      ['took', r.meta && r.meta.ms != null ? esc(r.meta.ms) + ' ms' : '—'],
    ]));
    return out.join('');
  }
`
