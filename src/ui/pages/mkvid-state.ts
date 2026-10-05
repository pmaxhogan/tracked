// The mkvid status helpers, as client JS: untilTime, mkWhy, mkEffective and
// mkState (behaviour contract section 3). The mkvid page concatenates this
// string inside its IIFE, and so will the Home page's mkvid tile, so it
// declares nothing global and uses only TK (TK.esc, TK.fmt.rel).
//
// Strings are verbatim from the old main page, curly apostrophes (U+2019) included.
export const MKVID_STATE_JS = /* js */ `
  // "in 5m" / "in 3h 20m" until a unix time (at least a minute).
  function untilTime(sec) {
    const m = Math.max(1, Math.round((sec - Date.now() / 1000) / 60));
    if (m < 60) return 'in ' + m + 'm';
    return 'in ' + Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }

  // Why one waiting set is (not) next, as HTML. Capped only matters for a set
  // that is otherwise ready; the caller says whether today's caps are used.
  function mkWhy(rd, short, capped) {
    if (!rd) return '';
    const day = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
    if (rd.state === 'unverified') return '<span class="why">not verified' + (short ? '' : ' — the track list needs a second matching fetch before anything is rendered') + '</span>';
    if (rd.state === 'untimed') return '<span class="why">too few cue times' + (short ? '' : ' (' + TK.esc(rd.timedRows) + ' of ' + TK.esc(rd.baseRows) + ' tracks timed, 90% needed; rechecked weekly)') + '</span>';
    if (rd.state === 'waiting_ids') return '<span class="why">waiting for IDs until ' + TK.esc(day(rd.until)) + (short ? '' : ' (' + TK.esc(rd.idRows) + ' ID row' + (rd.idRows === 1 ? '' : 's') + '; Render now skips the wait)') + '</span>';
    if (rd.state === 'backoff') return '<span class="why">retry ' + untilTime(rd.until) + '</span>';
    if (capped) return '<span class="why">capped — today’s uploads are used</span>';
    return '<span class="why ready">ready</span>';
  }

  // The caps that actually apply: only the accounts mkvid offered on its last
  // poll can be claimed against. (A heartbeat from before accounts existed
  // names none — treat that as all of them.)
  function mkEffective(d) {
    const all = d.accounts || [];
    const offered = d.lastPoll && d.lastPoll.accounts ? all.filter((a) => d.lastPoll.accounts.includes(a.account)) : all;
    const sum = (xs, k) => xs.reduce((n, a) => n + (a[k] || 0), 0);
    return { cap: sum(offered, 'cap'), used: sum(offered, 'used'), idle: all.filter((a) => a.cap > a.used && !offered.includes(a)) };
  }

  // The one line that answers "why is nothing uploading?" — first match wins.
  // Returns [cls ('ok' | 'wait' | 'bad'), title, sub], all plain text.
  function mkState(d) {
    const c = d.counts || {};
    const cap = d.dailyClaimCap, used = d.dailyClaims || 0;
    const poll = d.lastPoll;
    const eff = mkEffective(d);
    // An account with slots left that mkvid is not offering: it has no YouTube token for it.
    const idleNote = eff.idle.length ? ' ' + eff.idle.map((a) => a.label + ' has ' + (a.cap - a.used) + ' more, but mkvid has not connected that account.').join(' ') : '';
    // The heartbeat is rewritten at most every 10 min, so only a longer silence means anything.
    const silent = !poll || (d.now || Date.now() / 1000) - poll.at > 25 * 60;
    if (!d.enabled) return ['bad', 'Off — MKVID_TOKEN is not set', 'Nothing is queued and mkvid cannot claim.'];
    if (cap === 0) return ['bad', 'Paused — every daily cap is 0', 'MKVID_DAILY_CLAIM_CAP (and MKVID_SHARED_DAILY_CLAIM_CAP) refuse every claim. Set MKVID_DAILY_CLAIM_CAP to 24 (or delete the secret) to resume.'];
    // mkvid only polls while its render slot is free, so a long render is silence too — not an outage.
    // mkvid works on up to two at once, only one of them rendering.
    if (c.claimed) return ['ok', (c.claimed === 1 ? 'Rendering 1 set' : 'Working on ' + c.claimed + ' sets') + ' now', used + '/' + cap + ' of today’s uploads used.'];
    if (silent) return ['bad', poll ? 'mkvid last polled ' + TK.fmt.rel(new Date(poll.at * 1000).toISOString()) : 'mkvid has not polled yet', 'It normally polls every minute. Check the mkvid container on the NAS and that it can reach this Worker (TRACKED_URL / TRACKED_TOKEN).'];
    if (poll.outcome === 'error') return ['bad', 'The last claim failed on the Worker side', 'Usually a transient D1 error; mkvid retries every minute.'];
    if (poll.outcome === 'not_connected') return ['bad', 'mkvid has no YouTube account connected', 'Its token expired or was revoked. Open mkvid.maxhogan.dev and connect YouTube again.'];
    if (!c.pending) return ['ok', 'Queue empty', 'Nothing is waiting for mkvid.'];
    if (eff.used >= eff.cap || poll.outcome === 'capped') return ['wait', 'Today’s ' + eff.cap + ' upload' + (eff.cap === 1 ? ' is' : 's are') + ' used — next one ' + untilTime(d.quotaResetsAt), 'The caps reset at midnight Pacific with the YouTube quota (each project allows 100 uploads a day; the caps here keep it to 30 in total).' + idleNote];
    return ['ok', 'Ready — mkvid takes the next set on its next poll', used + '/' + cap + ' of today’s uploads used.' + idleNote];
  }
`
