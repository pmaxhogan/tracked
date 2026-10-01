// Set page diagnostics column: "why is or isn't this set in my playlists",
// from GET /ui/api/set (SetDiagnostics in src/lib/set-diagnostics.ts).
//
// setDiagRows(d) turns the response into seven plain-text rows (discovery,
// recording, verification, full-recording rule, playlist, hygiene, mkvid);
// renderDiag(d) renders them as <details> rows, escaping every value. Both
// assume only TK in scope. Times in the response are unix seconds, except
// playlist additions' ts (epoch milliseconds).

export const SET_DIAG_JS = /* js */ `
  function diagIso(ms) { try { return new Date(ms).toISOString(); } catch (e) { return ''; } }
  function diagRel(sec) { return sec ? TK.fmt.rel(diagIso(sec * 1000)) : 'never'; }
  // A future time as "in 3h 5m", a past one as "5m ago".
  function diagWhen(sec) { return sec * 1000 > Date.now() ? TK.fmt.until(sec) : diagRel(sec); }
  function diagClock(s) { return s == null ? '—' : TK.fmt.clock(s); }
  const diagYes = (b) => (b ? 'yes' : 'no');
  const DIAG_REMOVED = { owner: 'removed by you', dead: 'video died', button: 'remove and replace' };

  function diagDiscovered(d) {
    const ds = d.discovered || [];
    const facts = [];
    for (const x of ds) {
      facts.push(['DJ', x.slug]);
      facts.push(['Discovered', diagRel(x.discoveredAt)]);
      facts.push(['Processed', x.abandoned ? 'abandoned' : diagYes(x.processed)]);
      facts.push(['Checked', x.checkedAt == null ? 'never' : x.checkedAt === 0 ? 'due now' : diagRel(x.checkedAt)]);
    }
    const maxFails = (xs) => Math.max(0, ...xs.map((x) => x.failureCount || 0));
    const abandoned = ds.filter((x) => x.abandoned);
    let tone, finding;
    if (!ds.length) { tone = 'warn'; finding = 'No subscribed DJ lists this set.'; }
    else if (abandoned.length) { tone = 'bad'; finding = 'Given up after ' + maxFails(abandoned) + ' failed fetches.'; }
    else if (maxFails(ds) > 0) { tone = 'warn'; finding = maxFails(ds) + ' failed fetches so far.'; }
    else { tone = 'ok'; finding = 'Listed under ' + ds.map((x) => x.artistName || x.slug).join(', ') + '.'; }
    return { key: 'discovered', label: 'Discovered', tone, finding, facts };
  }

  function diagRecording(d) {
    const v = d.video, s = d.schedule;
    let tone, finding;
    if (v && v.from === 'mkvid') { tone = 'ok'; finding = 'YouTube ' + v.id + ', rendered by mkvid.'; }
    else if (v) { tone = 'ok'; finding = 'YouTube ' + v.id + ' from the set page.'; }
    else if ((d.discovered || []).some((x) => x.videoKnown)) { tone = 'warn'; finding = 'The set page had no YouTube recording.'; }
    else { tone = 'info'; finding = 'Set page not fetched yet.'; }
    const facts = s ? [
      ['Next due', s.nextDueAt == null ? 'never: old set, good video, no ID rows' : diagWhen(s.nextDueAt)],
      ['Last fetched', diagRel(s.lastFetchedAt)],
      ['Retry at', s.retryAt ? diagWhen(s.retryAt) : 'none'],
      ['Attempts today', (s.attemptsToday || 0) + ' of 3' + (s.attemptDay ? ' on ' + s.attemptDay : '')],
      ['Has ID rows', diagYes(s.hasIdRows)],
      ['No good video', diagYes(s.noGoodVideo)],
    ] : [['Schedule', 'not scheduled yet']];
    return { key: 'recording', label: 'Recording', tone, finding, facts };
  }

  function diagVerification(d) {
    const v = d.verification;
    if (!v) return { key: 'verification', label: 'Verification', tone: 'info', finding: 'Not fetched through the pool yet.', facts: [] };
    let tone, finding;
    if (v.state === 'verified') { tone = 'ok'; finding = 'Verified ' + diagRel(v.verifiedAt) + ' (' + v.rowCount + ' rows).'; }
    else {
      tone = 'warn';
      finding = 'First fetch by ' + (v.firstAccount || 'an account') + ', ' + (v.verifyDueAt ? 'second fetch due ' + diagWhen(v.verifyDueAt) : 'second fetch not scheduled') + '.';
    }
    if (v.mismatches > 0) finding += ' ' + v.mismatches + ' earlier pair(s) disagreed.';
    const facts = [
      ['First fetch', (v.firstAccount || 'unknown account') + ', ' + diagRel(v.firstFetchedAt)],
      ['Second fetch', v.secondFetchedAt ? (v.secondAccount || 'unknown account') + ', ' + diagRel(v.secondFetchedAt) : 'not yet'],
      ['Rows', String(v.rowCount)],
    ];
    return { key: 'verification', label: 'Verification', tone, finding, facts };
  }

  function diagRule(d) {
    const v = d.video, m = d.media, meta = v && v.meta;
    let tone, finding;
    if (!v) { tone = 'neutral'; finding = 'No video to judge.'; }
    else if (v.override) { tone = 'ok'; finding = 'Owner override: the rule is not applied to this video.'; }
    else if (!v.verdict) { tone = 'info'; finding = 'Not judged yet: the set page or the video facts have not been seen.'; }
    else if (v.verdict.ok) { tone = 'ok'; finding = 'Full recording.'; }
    else { tone = 'bad'; finding = v.verdict.label + ': ' + v.verdict.detail + '.'; }
    const facts = v ? [
      ['Video duration', diagClock(meta && meta.durationSeconds)],
      ['Last cue', diagClock(m && m.lastCueSeconds)],
      ['Longest audio', m && m.audioMaxSeconds != null ? diagClock(m.audioMaxSeconds) + (m.audioKind ? ' (' + m.audioKind + ')' : '') : '—'],
      ['Notice', m ? (m.noFullNotice ? 'says it is not the full set' : 'none') : '—'],
      ['Embed size', meta && meta.embedWidth && meta.embedHeight ? meta.embedWidth + '×' + meta.embedHeight : '—'],
      ['Alive', meta ? diagYes(meta.alive) : '—'],
    ] : [];
    return { key: 'rule', label: 'Full-recording rule', tone, finding, facts };
  }

  function diagPlaylist(d) {
    const p = d.playlist || {}, adds = p.additions || [], conf = p.confirmed || [];
    const last = adds[0];
    let tone, finding;
    if (!last) { tone = 'info'; finding = 'No playlist addition recorded (kept 90 days).'; }
    else if (['added', 'replaced', 'duplicate'].indexOf(last.status) >= 0) { tone = 'ok'; finding = last.status + ' ' + TK.fmt.rel(diagIso(last.ts)) + '.'; }
    else if (last.status === 'failed' || last.status === 'abandoned') { tone = 'bad'; finding = last.status + ': ' + (last.message || 'no message') + '.'; }
    else if (last.status === 'no_youtube') { tone = 'warn'; finding = 'No YouTube recording when last processed.'; }
    else { tone = 'info'; finding = last.status + ' ' + TK.fmt.rel(diagIso(last.ts)) + '.'; }
    const facts = adds.map((a) => [a.status, TK.fmt.rel(diagIso(a.ts)) + (a.message ? ': ' + a.message : '')])
      .concat(conf.map((c) => [c.state === 'in' ? 'In playlist' : 'Out of playlist', c.playlistId + ' (' + c.source + ', ' + diagRel(c.at) + ')']));
    return { key: 'playlist', label: 'Playlist', tone, finding, facts };
  }

  function diagHygiene(d) {
    const h = d.hygiene || {}, removed = h.removed || [], removals = h.removals || [];
    let tone, finding;
    const failed = removals.find((r) => r.status === 'failed');
    if (removed.length) {
      const reasons = removed.map((r) => DIAG_REMOVED[r.reason] || r.reason).filter((r, i, a) => a.indexOf(r) === i);
      tone = 'bad'; finding = 'Blocked from ' + removed.length + ' playlist(s): ' + reasons.join(', ') + '.';
    }
    else if (failed) { tone = 'bad'; finding = 'A removal failed: ' + (failed.detail || 'no detail') + '.'; }
    else if (removals.some((r) => r.status === 'would_remove')) { tone = 'warn'; finding = 'The sweep would remove it (dry run).'; }
    else { tone = 'ok'; finding = 'Nothing removed.'; }
    const facts = removed.map((r) => ['Blocked', r.playlistId + ' (' + (DIAG_REMOVED[r.reason] || r.reason) + ', ' + diagRel(r.at) + ')'])
      .concat(removals.map((r) => [r.source, r.status + ', ' + r.reason + ', ' + diagRel(r.at) + (r.detail ? ': ' + r.detail : '')]));
    return { key: 'hygiene', label: 'Hygiene', tone, finding, facts };
  }

  function diagMkvid(d) {
    const m = d.mkvid;
    if (!m) return { key: 'mkvid', label: 'mkvid', tone: 'neutral', finding: 'Not queued for mkvid.', facts: [] };
    const pos = '#' + (m.position == null ? '?' : m.position);
    const r = m.readiness;
    let tone, finding;
    if (m.status === 'pending') {
      if (!r) { tone = 'info'; finding = pos + ' in the queue.'; }
      else if (r.state === 'ready') { tone = 'ok'; finding = pos + ' in the queue, ready.'; }
      else if (r.state === 'unverified') { tone = 'warn'; finding = pos + ' in the queue; waits because the track list is not verified.'; }
      else if (r.state === 'waiting_ids') { tone = 'warn'; finding = pos + '; waits for IDs until ' + TK.fmt.until(r.until) + ' (' + r.idRows + ' ID rows).'; }
      else { tone = 'warn'; finding = pos + '; retry backoff until ' + TK.fmt.until(r.until) + '.'; }
    }
    else if (m.status === 'claimed') { tone = 'info'; finding = 'Rendering now.'; }
    else if (m.status === 'done') { tone = 'ok'; finding = 'Uploaded ' + (m.videoId || '(no video id)') + '.'; }
    else if (m.status === 'failed') { tone = 'bad'; finding = 'Failed: ' + (m.error || 'no error recorded') + '.'; }
    else if (m.status === 'banned') { tone = 'bad'; finding = 'Banned from mkvid.'; }
    else if (m.status === 'superseded') { tone = 'neutral'; finding = 'Superseded by an official recording.'; }
    else { tone = 'neutral'; finding = m.status + '.'; }
    const l = m.list;
    const facts = [
      ['Attempts', String(m.attempts)],
      ['Account', m.account || '—'],
      ['Style', m.style || 'default'],
      ['Skip ID wait', diagYes(m.skipIdWait)],
      ['Stored list', l ? l.trackCount + ' rows, ' + (l.idRows == null ? '?' : l.idRows) + ' ID rows, ' + (l.trusted ? 'trusted' : 'untrusted') + ', ' + l.named + ' named, ' + l.mismatched + ' mismatched, scraped ' + diagRel(l.scrapedAt) : 'none'],
    ];
    return { key: 'mkvid', label: 'mkvid', tone, finding, facts };
  }

  function setDiagRows(d) {
    return [diagDiscovered(d), diagRecording(d), diagVerification(d), diagRule(d), diagPlaylist(d), diagHygiene(d), diagMkvid(d)];
  }

  const DIAG_BADGE = { ok: 'ok', warn: 'check', bad: 'problem', info: 'info', neutral: 'n/a' };
  function renderDiag(d) {
    const e = TK.esc;
    const h = d.hygiene || {};
    const title = d.media && d.media.setTitle;
    return '<h2 class="diag-head">Diagnostics</h2>' + (title ? '<p class="diag-title muted">' + e(title) + '</p>' : '') +
      setDiagRows(d).map((r) => {
        const facts = r.facts.map((f) => '<dt>' + e(f[0]) + '</dt><dd>' +
          (r.key === 'discovered' && f[0] === 'DJ' ? '<a href="/ui/dj/' + encodeURIComponent(f[1]) + '">' + e(f[1]) + '</a>' : e(f[1])) + '</dd>').join('');
        let link = '';
        if (r.key === 'hygiene' && ((h.removed || []).length || (h.removals || []).length)) link = '<a href="/ui/removed">Removed videos</a>';
        if (r.key === 'mkvid' && d.mkvid) link = '<a href="/ui/mkvid">Open mkvid</a>';
        return '<details class="diag-row"' + (r.tone === 'bad' || r.tone === 'warn' ? ' open' : '') + '>' +
          '<summary><span class="diag-label">' + e(r.label) + '</span><span class="badge ' + r.tone + '">' + DIAG_BADGE[r.tone] + '</span>' +
          '<span class="diag-finding">' + e(r.finding) + '</span></summary>' +
          (facts ? '<dl class="diag-facts">' + facts + '</dl>' : '') +
          (link ? '<p class="diag-link">' + link + '</p>' : '') +
        '</details>';
      }).join('');
  }
`

export const SET_DIAG_CSS = /* css */ `
  .set-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--sp-4); align-items: start; }
  .set-main { min-width: 0; }
  @media (min-width: 1100px) {
    .set-layout { grid-template-columns: minmax(0, 1fr) 24rem; }
    .set-layout > .set-main { grid-column: 1; grid-row: 1; }
    .set-layout > .set-diag { grid-column: 2; grid-row: 1; position: sticky; top: var(--sp-4); max-height: calc(100vh - 2 * var(--sp-4)); overflow-y: auto; }
  }
  .set-diag { padding: var(--sp-3) var(--sp-4); min-width: 0; }
  .set-diag[hidden] { display: none; }
  .diag-head { font-size: var(--fs-sm); margin: 0 0 var(--sp-2); }
  .diag-title { font-size: var(--fs-sm); margin: 0 0 var(--sp-2); overflow-wrap: anywhere; }
  .diag-row { border-top: 1px solid var(--line); }
  .diag-row > summary { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px var(--sp-2); padding: 8px 0; cursor: pointer; }
  .diag-label { font-weight: 600; font-size: var(--fs-sm); }
  .diag-finding { flex-basis: 100%; font-size: var(--fs-sm); overflow-wrap: anywhere; }
  .diag-facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 2px var(--sp-3); margin: 0 0 var(--sp-2); font-size: var(--fs-xs); }
  .diag-facts dt { color: var(--muted); }
  .diag-facts dd { margin: 0; overflow-wrap: anywhere; }
  .diag-link { margin: 0 0 var(--sp-2); font-size: var(--fs-xs); }
  .diag-err { color: var(--danger); font-size: var(--fs-sm); margin: 0; }
`
