// Pool accounts page: stats, pending challenges, accounts table and the Add account dialog.
import { shell } from '../shell'
import { tipAttr } from '../tip'
import { POOL_CSS, COMMON_JS, CAPTCHA_JS } from './pool-common'

const BODY = /* html */ `
  <div id="err" class="banner bad" hidden></div>
  <div id="stats" class="tk-tiles"></div>
  <div id="prio" class="tk-card" hidden></div>
  <h2 class="pool-h2"><span class="tip-term"${tipAttr('Captchas that a pool account ran into and that wait for a person. An unanswered one expires, and its account rests for 6 hours.')}>Pending challenges</span></h2>
  <div id="chals"><div id="chals-msg"><div class="empty">loading…</div></div><div id="pc"></div></div>
  <h2 class="pool-h2"><span class="tip-term"${tipAttr('The logged-in 1001tracklists accounts the pool fetches with. Each has its own exit IP and daily page budget.')}>Accounts</span></h2>
  <div id="accts"><div id="accts-msg"><div class="empty">loading…</div></div><div id="pa"></div></div>
  <p class="muted stat-note">Accounts are shown by their opaque id only. Usernames, emails and passwords stay on the NAS.</p>

<dialog id="add-dlg" class="tk-dialog" aria-labelledby="add-title">
  <div class="row"><h2 id="add-title" style="margin:0">Add account</h2><span class="spacer"></span><button id="add-close" type="button" class="btn small">Close</button></div>
  <div id="add-form">
    <p class="muted sub">The pool picks a free exit IP, generates the username and password, fills the signup form and confirms the email on its own. You only solve the captcha.</p>
    <div class="field"><label for="add-exit">Exit type</label><select id="add-exit"><option value="auto" selected>Auto (default)</option><option value="own">Own IP</option><option value="mullvad">Mullvad</option><option value="airvpn">AirVPN</option></select><span class="hint">Where the new account's traffic leaves from. Auto lets the pool pick a free exit of any kind.</span></div>
    <div class="field"><label for="add-when">Create at (optional)</label><input id="add-when" type="datetime-local" /><span class="hint">Leave empty to start now. Pick a date and time (your local time, up to 90 days ahead) and the pool creates the account then, on its own; you only solve a captcha if one shows up. It waits in the table as "queued" until then.</span></div>
    <label class="switch"><input id="add-passive" type="checkbox" /><span><b>Passive</b> (control group, never used for fetching)<br><span class="muted sub">Pinned to its own exit and logged in, but never fetches. It shows whether flags come from use or from simply existing.</span></span></label>
    <div id="add-form-msg"></div>
    <div class="row" style="margin-top:var(--sp-4)"><span class="spacer"></span><button id="add-create" type="button" class="btn primary">Create</button></div>
    <div id="add-active" hidden></div>
  </div>
  <div id="add-progress" hidden>
    <ol id="add-steps" class="steps"></ol>
    <div id="add-captcha" class="tk-card" hidden></div>
    <div id="add-msg"></div>
    <div class="row" style="margin-top:var(--sp-3)"><button id="add-back" type="button" class="btn">Back</button><span class="spacer"></span><button id="add-retry" type="button" class="btn" hidden>Try again</button></div>
  </div>
</dialog>
`

const JS = /* js */ `
(() => {
${COMMON_JS}
${CAPTCHA_JS}
  // ── overview ───────────────────────────────────────────────────────────
  // Account states that mean "still being created" (tlpool: new; older shapes: the rest).
  const IN_CREATION = /^(creating|signup|pending|new)$/;
  const stateBadge = (a) => {
    const s = String(a.state || 'unknown');
    // A scheduled creation is not an account yet: no details drawer, no signup progress, just the chip.
    if (a.queued || s === 'queued') return '<span class="badge queued"' + tipA('Scheduled: tlpool creates this account at its start time, with the options chosen when it was added.') + '>queued</span>';
    // tlpool states: new (signing up), warming (ramp days 1-2), active, passive, resting, retired.
    const cls = a.flagged || s === 'flagged' ? 'bad' : s === 'retired' ? '' : s === 'resting' || s === 'new' || s === 'creating' ? 'warn' : s === 'warming' || s === 'ramping' ? 'info' : s === 'active' || s === 'ok' || s === 'healthy' ? 'ok' : 'info';
    // An account still signing up whose signup challenge tlpool names: the badge
    // is a button that reopens the Add account progress view for that signup.
    if (IN_CREATION.test(s) && a.signupChallengeId) {
      return '<button type="button" class="badge badge-btn ' + cls + '" data-signup="' + esc(a.signupChallengeId) + '" data-acct="' + esc(a.id) + '" aria-haspopup="dialog" aria-label="' + esc(a.id + ' is ' + s + ': show its signup progress') + '"' + tipA('Being created. Opens the signup progress: the exit, the form, the confirmation email and the first login.') + '>' + esc(s) + '</button>';
    }
    // Every other state: the badge opens the state details drawer for that account.
    return '<button type="button" class="badge badge-btn ' + cls + '" data-state-acct="' + esc(a.id) + '" aria-haspopup="dialog" aria-label="' + esc(a.id + ' is ' + s + ': show what that means and what happens next') + '"' + tipA(stateTip(s) + ' Press for details.') + '>' + esc(s) + '</button>';
  };
  const badgeClass = (a) => { const m = /class="badge (?:badge-btn )?([a-z]*)"/.exec(stateBadge(a)); return m ? m[1] : ''; };

  // ── state details (drawer) ─────────────────────────────────────────────
  // What a state means, why the account is in it and what happens next, from
  // tlpool's /status fields, plus that account's stored pool events. Account
  // ids only; free text holding an '@' is never shown.
  const tkEsc = (s) => (typeof TK !== 'undefined' && TK.esc ? TK.esc : esc)(s);
  const STATE_ALIASES = { creating: 'new', signup: 'new', pending: 'new', ramping: 'warming', ok: 'active', healthy: 'active' };
  const STATE_MEANS = {
    new: 'Being created. The pool is signing it up on its own exit: the register form, the confirmation email, the first login. It fetches nothing yet.',
    warming: 'Signed up and on the ramp. It fetches, but its daily page budget is cut down for its first days so a new account does not look busy.',
    active: 'Ramped up. It fetches with the full daily page budget whenever the pool picks it.',
    passive: 'Control group. It is logged in on its own exit but never fetches, which shows whether flags come from use or from simply existing.',
    resting: 'Out of rotation for a while: after an unanswered captcha, a flag, a failed login or a requested retest. It fetches nothing until the rest ends.',
    retired: 'Out for good. It is never used again, and its exit is kept from new accounts for 30 days so a fresh account does not inherit its record.',
    signup_failed: 'Its signup submitted the register form but was never confirmed. It fetches nothing; its exit counts as burned for 30 days from the submit.',
    flagged: '1001tracklists flagged it (decoy track names, a block). It rests 72 hours, then gets one retest with a known set.',
  };
  const REASON_WORDS = {
    challenge_expired: 'nobody answered its captcha in time', challenge_lost_on_restart: 'a captcha was open when the pool restarted',
    walls_in_a_row: 'it hit captcha walls several times in a row', login_failed: 'it could not log in', decoy: 'the site served it decoy track names',
    decoy_names: 'the site served it decoy track names', rate_block: 'the site rate-blocked it', consent: 'the site showed a consent wall',
    retest: 'a retest was asked for', retest_inconclusive: 'its retest was inconclusive', retest_failed: 'it failed its retest',
    signup_failed: 'its signup failed', signup_stalled: 'its signup stalled before the register form was sent',
    signup_failed_expired: 'its failed signup reached the end of its 30-day exit burn', requested: 'by hand', manual: 'by hand',
  };
  const safeText = (t) => (typeof t === 'string' && t && t.indexOf('@') < 0 && t.indexOf('[redacted]') < 0 ? t : null);
  function reasonWords(r) {
    r = safeText(r);
    if (!r) return null;
    const i = r.indexOf(':');
    const head = (i < 0 ? r : r.slice(0, i)).trim(), tail = i < 0 ? '' : r.slice(i + 1).trim();
    const word = (w) => REASON_WORDS[w] || w.replace(/_/g, ' ');
    return word(head) + (tail ? ' (' + word(tail) + ')' : '');
  }
  const EVENT_WORDS = {
    'challenge.created': 'Captcha raised', 'challenge.solved': 'Captcha solved', 'challenge.expired': 'Captcha expired',
    'account.created': 'Account created', 'account.flagged': 'Flagged', 'account.rested': 'Rested', 'account.retired': 'Retired',
  };
  const DAY_MS = 86400000;
  const plusMs = (iso, ms) => (iso && Number.isFinite(Date.parse(iso)) ? new Date(Date.parse(iso) + ms).toISOString() : null);
  function when(iso) {
    if (!iso || !Number.isFinite(Date.parse(iso))) return '—';
    const d = Date.parse(iso) - Date.now();
    return fmtTime(iso) + ' (' + (d >= 0 ? 'in ' + fmtDur(d) : fmtDur(-d) + ' ago') + ')';
  }
  // The newest event of one of these types, or null.
  const lastEvent = (events, types) => (events || []).find((e) => types.indexOf(e.type) >= 0) || null;

  let details = { seq: 0, id: null, events: null, eventsErr: null, rampLen: null };

  function detailsHtml(a, d) {
    const raw = String(a.state || 'unknown');
    const s = STATE_ALIASES[raw] || raw;
    const li = (t) => '<li>' + t + '</li>';
    const evs = d.events;
    const why = [], next = [];
    const flagged = a.flagged || s === 'flagged';

    // How it got here.
    if (a.stateChangedAt) why.push(li('In this state since <b>' + tkEsc(when(a.stateChangedAt)) + '</b>.'));
    else if (s === 'new' && a.createdAt) why.push(li('Created <b>' + tkEsc(when(a.createdAt)) + '</b>.'));
    else if ((s === 'warming' || s === 'active' || s === 'passive') && a.activatedAt) why.push(li('Finished signing up <b>' + tkEsc(when(a.activatedAt)) + '</b>.'));
    else if (s === 'retired' && a.retiredAt) why.push(li('Retired <b>' + tkEsc(when(a.retiredAt)) + '</b>.'));
    else if (s === 'signup_failed' && a.submittedAt) why.push(li('Sent the register form <b>' + tkEsc(when(a.submittedAt)) + '</b>; no confirmation followed.'));
    const entry = s === 'resting' || s === 'flagged' ? lastEvent(evs, ['account.rested', 'account.flagged']) : s === 'retired' ? lastEvent(evs, ['account.retired']) : s === 'new' ? lastEvent(evs, ['account.created']) : null;
    if (entry && !a.stateChangedAt) why.push(li('The pool reported it ' + tkEsc((EVENT_WORDS[entry.type] || entry.type).toLowerCase()) + ' <b>' + tkEsc(when(entry.at)) + '</b>.'));
    const restWhy = reasonWords(a.restReason) || (a.flagReason ? reasonWords(a.flagReason) : null);
    if ((s === 'resting' || flagged) && restWhy) why.push(li('Why: ' + tkEsc(restWhy) + '.'));
    const evWhy = entry ? reasonWords(entry.reason) : null;
    if (evWhy && evWhy !== restWhy) why.push(li('The pool said: ' + tkEsc(evWhy) + '.'));
    if (flagged && s !== 'flagged') why.push(li('Flagged by the site' + (a.flagReason ? ' (' + tkEsc(reasonWords(a.flagReason)) + ')' : '') + '.'));
    if (a.retestPending) why.push(li('A retest is pending.'));
    const lastErr = safeText(a.lastError);
    if (lastErr) why.push(li('Last error: ' + tkEsc(lastErr)));
    if (a.exitKind || a.exitLabel) why.push(li('Exit: <span class="mono">' + tkEsc(a.exitLabel || '—') + '</span>' + (a.exitKind ? ' (' + tkEsc(a.exitKind) + ')' : '') + '.'));
    if (!why.length) why.push(li('<span class="muted">The pool does not say when or why it entered this state.</span>'));

    // What happens next.
    if (s === 'new') {
      if (a.busy === 'signup') next.push(li('Signing up right now.'));
      const stale = plusMs(a.createdAt, 6 * 3600000);
      if (stale) next.push(li('If the signup has not finished by <b>' + tkEsc(when(stale)) + '</b>, the pool gives up: signup failed when the form was sent, retired when it never was.'));
      if (a.canRetrySignup) next.push(li('Its signup ended without finishing; the pool accepts a retry (from the NAS, this page has no retry button).'));
    } else if (s === 'warming') {
      // tlpool counts ramp days from activation, or from creation when that is missing (pacing.py).
      const from = a.activatedAt || a.createdAt;
      const day = from && !isNaN(Date.parse(from)) ? Math.max(0, Math.floor((Date.now() - Date.parse(from)) / DAY_MS)) : null;
      const len = d.rampLen;
      if (day !== null) next.push(li('Ramp day <b>' + tkEsc(day + 1) + (len ? ' of ' + len : '') + '</b>' + (len ? '' : ' (the ramp length comes from the pool settings, which did not load)') + '.'));
      if (a.budget !== null && a.budget !== undefined) next.push(li('Today: <b>' + tkEsc((a.usedToday ?? 0) + ' / ' + a.budget) + '</b> pages in the last 24 h.'));
      const done = len && a.activatedAt ? plusMs(a.activatedAt, len * DAY_MS) : null;
      if (done) next.push(li('Becomes active with the full budget around <b>' + tkEsc(when(done)) + '</b>.'));
    } else if (s === 'active') {
      if (a.budget !== null && a.budget !== undefined) next.push(li('Today: <b>' + tkEsc((a.usedToday ?? 0) + ' / ' + a.budget) + '</b> pages' + (a.xhrBudget ? ', ' + tkEsc((a.xhrUsedToday ?? 0) + ' / ' + a.xhrBudget) + ' in-page lookups' : '') + ' in the last 24 h.'));
      if (a.budget && (a.usedToday ?? 0) >= a.budget) next.push(li('Its budget is spent: it is picked again as page views from the last 24 h age out.'));
      next.push(li('After each page view it waits a random gap (tens of seconds or more) before the next. The pool does not report the exact next time.'));
    } else if (s === 'passive') {
      next.push(li('Nothing: it stays logged in and never fetches, until it is retired.'));
    } else if (s === 'resting' || s === 'flagged') {
      if (a.restUntil) next.push(li('Rests until <b>' + tkEsc(when(a.restUntil)) + '</b>.'));
      // A passive account goes back to passive, and tlpool never retests one.
      const back = a.passive ? 'passive' : 'warming or active';
      if (a.retestPending && !a.passive) next.push(li('Then one retest with a known set: a pass puts it back to ' + back + ', a fail retires it, an inconclusive one rests it again.'));
      else next.push(li('Then it goes back to ' + back + ' on its own (the pool checks every 15 to 40 seconds).'));
    } else if (s === 'retired') {
      next.push(li('It is never used again.'));
      const ev = lastEvent(evs, ['account.retired']);
      const q = ev && ev.exitQuarantinedUntil ? ev.exitQuarantinedUntil : a.submittedAt ? plusMs(a.retiredAt, 30 * DAY_MS) : null;
      if (q) next.push(li((Date.parse(q) > Date.now() ? 'Its exit is kept from new accounts until <b>' : 'Its exit quarantine ended <b>') + tkEsc(when(q)) + '</b>.'));
      else if (a.retiredAt && !a.submittedAt) next.push(li('The pool has no record of it sending the register form, so its exit is likely free already; otherwise it is kept from new accounts until <b>' + tkEsc(when(plusMs(a.retiredAt, 30 * DAY_MS))) + '</b>.'));
    } else if (s === 'signup_failed') {
      const end = plusMs(a.submittedAt, 30 * DAY_MS);
      if (end) next.push(li('Retired on its own <b>' + tkEsc(when(end)) + '</b>, when its exit\\'s 30-day burn ends.'));
      if (a.canRetrySignup) next.push(li('The pool accepts a signup retry (from the NAS; this page has no retry button).'));
    }
    if (a.busy && a.busy !== 'signup') next.push(li('Busy now: ' + tkEsc(a.busy.replace(':', ', ').replace(/_/g, ' ')) + '.'));
    const exitProblem = safeText(a.exitProblem);
    if (exitProblem) next.push(li('It cannot open a browser now: ' + tkEsc(exitProblem) + '.'));
    if (a.pendingChallengeId) next.push(li('A captcha is waiting for it: <a href="/ui/captcha/' + tkEsc(encodeURIComponent(a.pendingChallengeId)) + '">solve it</a>.'));
    if (!next.length) next.push(li('<span class="muted">Nothing is scheduled for this state.</span>'));

    // Recent pool events.
    let evHtml;
    if (d.eventsErr) evHtml = '<div class="empty error">' + tkEsc(d.eventsErr) + '</div>';
    else if (!evs) evHtml = '<div class="empty">Loading…</div>';
    else if (!evs.length) evHtml = '<div class="empty">No pool events stored for ' + tkEsc(a.id) + ' (the Worker keeps 90 days).</div>';
    else evHtml = '<ul class="sd-events">' + evs.map((e) => {
      const r = reasonWords(e.reason);
      const bits = [];
      if (e.challengeType) bits.push(e.challengeType === 'checkbox' ? 'checkbox wall' : 'image captcha');
      if (e.phoneInitiated) bits.push('phone lookup');
      if (r) bits.push(r);
      if (e.type === 'account.retired' && e.exitQuarantinedUntil) bits.push('exit kept until ' + fmtTime(e.exitQuarantinedUntil));
      return '<li><b>' + tkEsc(EVENT_WORDS[e.type] || e.type) + '</b> <span class="muted">' + tkEsc(when(e.at)) + '</span>' + (bits.length ? '<div class="muted sub">' + tkEsc(bits.join(' · ')) + '</div>' : '') + '</li>';
    }).join('') + '</ul>';

    return '<div class="sd" data-sd-acct="' + tkEsc(a.id) + '">' +
      '<p><span class="badge ' + tkEsc(badgeClass(a)) + '">' + tkEsc(raw) + '</span>' + (a.passive && s !== 'passive' ? ' <span class="badge info">passive</span>' : '') + '</p>' +
      '<h3>What it means</h3><p>' + tkEsc(STATE_MEANS[s] || 'A state this page does not know yet (the pool may be newer than this page).') + '</p>' +
      '<h3>How it got here</h3><ul class="sd-list">' + why.join('') + '</ul>' +
      '<h3>What happens next</h3><ul class="sd-list">' + next.join('') + '</ul>' +
      '<h3>Recent pool events</h3>' + evHtml +
      '</div>';
  }

  // Opens the drawer on one account, then fills in its events (and the ramp
  // length for a warming account). A reply that lands after the drawer moved
  // to another account, or was closed, is dropped.
  async function openDetails(id) {
    if (typeof TK === 'undefined' || !TK.drawer) return;
    const find = () => ((lastStatus && lastStatus.accounts) || []).find((x) => x.id === id) || null;
    const a = find();
    const seq = ++details.seq;
    details = { seq, id, events: null, eventsErr: null, rampLen: details.rampLen };
    if (!a) { TK.drawer.open(id, '<div class="empty">' + tkEsc(id) + ' is no longer in the pool\\'s list.</div>'); return; }
    TK.drawer.open(id + ' · ' + String(a.state || 'unknown'), detailsHtml(a, details));
    const st = STATE_ALIASES[a.state] || a.state;
    const [ev, lim] = await Promise.all([
      api('/accounts/' + encodeURIComponent(id) + '/events'),
      st === 'warming' && details.rampLen === null ? api('/limits') : Promise.resolve(null),
    ]);
    if (details.seq !== seq) return;
    if (ev.ok) details.events = Array.isArray(ev.data.events) ? ev.data.events : [];
    else details.eventsErr = ev.status === 401 || ev.status === 403 ? SIGN_IN_AGAIN : errText(ev.data, ev.status);
    if (lim && lim.ok && lim.data.settings && Array.isArray(lim.data.settings.ramp)) details.rampLen = lim.data.settings.ramp.length;
    const body = $('tk-drawer-body');
    if (body) body.innerHTML = detailsHtml(find() || a, details);
  }
  // Closing the drawer drops whatever reply is still on its way.
  // The table may have been redrawn while it was open: give keyboard focus back to the account's badge in the current table.
  if ($('tk-drawer')) $('tk-drawer').addEventListener('close', () => {
    details.seq++;
    const b = details.id && document.querySelector ? document.querySelector('[data-state-acct="' + details.id + '"]') : null;
    if (b && b.focus) b.focus();
  });
  // The first sentence of what a state means, for the badge tooltip.
  function stateTip(s) {
    const m = STATE_MEANS[STATE_ALIASES[s] || s];
    return m ? m.split('. ')[0].replace(/\\.$/, '') + '.' : 'A state this page does not know yet.';
  }
  const ACT_TIPS = { cancel: 'Drops this scheduled account before it is created. Nothing was created yet.', rest: 'Takes the account out of rotation for 72 hours. It goes back by itself afterwards.', retest: 'Fetches one known set with this account to check whether the site still trusts it. A pass puts it back, a fail retires it.', retire: 'Takes the account out for good. Its exit stays unused for 30 days.' };
  const confirmWords = { cancel: 'Cancel this scheduled account?', rest: 'Rest it for 72 hours?', retest: 'Retest it with one known set?', retire: 'Retire it for good? Its exit stays unused for 30 days.' };
  let lastStatus = null;

  function renderStats(st, chals) {
    // Scheduled creations ("queued") are not accounts: never in the totals, shown as their own tile.
    const accts = (st.accounts || []).filter((a) => !a.queued && a.state !== 'queued');
    const queuedN = (st.accounts || []).length - accts.length;
    const live = accts.filter((a) => a.state !== 'retired');
    const fetching = live.filter((a) => !a.passive && !a.flagged && (a.state === 'active' || a.state === 'warming' || a.state === 'ok' || a.state === 'healthy' || a.state === 'ramping'));
    const budget = fetching.reduce((s, a) => s + (a.budget || 0), 0);
    const used = fetching.reduce((s, a) => s + (a.usedToday || 0), 0);
    const tile = (v, k, tip) => '<div class="tk-tile"><div class="k"><span class="tip-term"' + tipA(tip) + '>' + esc(k) + '</span></div><div class="v">' + esc(v) + '</div></div>';
    $('stats').innerHTML =
      tile(st.requestsToday ?? '—', 'page views today', '1001tracklists pages the pool has loaded today, for every account and every kind of work.') +
      tile(used + ' / ' + budget, 'used / budget (fetching accounts)', 'Page views of the last 24 hours out of the combined daily budget of the accounts that fetch. Passive, flagged and retired accounts are not counted.') +
      tile(st.queueDepth ?? '—', 'queued fetches', 'Fetches waiting for a free account. They run in priority order, and pause when budgets are spent.') +
      tile(fetching.length + ' / ' + live.length, 'fetching / live accounts', 'Accounts that fetch right now (active or warming) out of all accounts that are not retired. Resting, passive and flagged ones are live but do not fetch.') +
      tile(chals.length, 'pending challenges', 'Captchas waiting for you. Solve them under Challenges before they expire.') +
      (queuedN ? tile(queuedN, 'queued accounts (scheduled)', 'Accounts scheduled to be created later. tlpool creates each one at its time, or as soon as it is back up if it was down then.') : '');
    const PRIO_TIPS = { phone: 'The phone now-playing button. Never made to wait.', new: 'Sets just discovered, fetched for the first time.', verify: 'The second fetch, by another account, that confirms a track list.', recheck: 'Processed sets fetched again by their age, to catch swapped recordings.', backfill: 'Older sets of a DJ, a few at a time.', medialink: 'Track link lookups.' };
    const chips = (m) => Object.keys(m).map((k) => '<span class="chip"' + tipA(PRIO_TIPS[k]) + '>' + esc(k) + ' <b>' + esc(m[k]) + '</b></span>').join('');
    const bp = st.requestsByPriority || {}, qp = st.queueByPriority || {};
    const parts = [];
    if (Object.keys(bp).length) parts.push('<div class="muted sub"><span class="tip-term"' + tipA('Every fetch has a priority; when the budget is short the higher ones go first.') + '>Requests today by priority</span></div><div class="chips">' + chips(bp) + '</div>');
    if (Object.keys(qp).length) parts.push('<div class="muted sub" style="margin-top:var(--sp-3)"><span class="tip-term"' + tipA('Fetches waiting for a free account, by priority.') + '>Queue by priority</span></div><div class="chips">' + chips(qp) + '</div>');
    $('prio').hidden = !parts.length;
    $('prio').innerHTML = parts.join('');
  }

  // ── the two tables (TKTable, local mode: tlpool's lists are small and come whole) ──
  // Both are created on the first good status, inside #chals and #accts, so a
  // pool that is down from the start leaves those empty. Every poll hands the
  // tables the new rows (setRows), keeping their sort, filters and page.
  const hasTable = () => typeof TKTable !== 'undefined';
  const isQueued = (a) => !!(a.queued || a.state === 'queued');
  const FETCHING = ['active', 'warming', 'ok', 'healthy', 'ramping'];
  const STATE_OPTS = [
    { value: 'new', label: 'new' }, { value: 'warming', label: 'warming' }, { value: 'active', label: 'active' }, { value: 'passive', label: 'passive' },
    { value: 'resting', label: 'resting' }, { value: 'flagged', label: 'flagged' }, { value: 'signup_failed', label: 'signup failed' }, { value: 'retired', label: 'retired' }, { value: 'queued', label: 'queued' },
  ];
  let acctRows = [], chalRows = [], acctTable = null, chalTable = null;
  const countOf = (pred) => () => acctRows.filter(pred).length;

  function chalCells() {
    return [
      { key: 'type', label: 'Challenge', type: 'enum', options: [{ value: 'image', label: 'image captcha' }, { value: 'checkbox', label: 'checkbox (live view)' }],
        render: (c) => '<a href="/ui/captcha/' + encodeURIComponent(c.id) + '"><b>Solve ' + esc(typeText(c.type)) + '</b></a>' },
      { key: 'accountId', label: 'Account', type: 'text', render: (c) => '<span class="mono">' + esc(c.accountId || 'no account yet') + '</span>' },
      { key: 'reason', label: 'Why', type: 'text', value: (c) => reasonText(c.reason), render: (c) => esc(reasonText(c.reason)), hideOn: 'phone' },
      { key: 'createdAt', label: 'Since', type: 'datetime', storage: 'iso', render: (c) => esc(fmtTime(c.createdAt)), hideOn: 'phone' },
      { key: 'expiresAt', label: 'Left', type: 'datetime', storage: 'iso', tip: 'Time left to answer it. An unanswered captcha expires, and its account rests for 6 hours.',
        render: (c) => { const l = leftText(c.expiresAt); return '<span class="left' + (l.soon ? ' soon' : '') + '">' + esc(l.text) + '</span>'; } },
    ];
  }
  function renderChallenges(chals, errCode) {
    $('chals-msg').hidden = !errCode;
    $('chals-msg').innerHTML = errCode ? '<div class="empty error">' + esc(errText({ error: errCode })) + '</div>' : '';
    chalRows = errCode ? [] : chals.filter((c) => c.state === 'pending' && c.ready !== false);
    if (!hasTable()) return;
    if (chalTable) { chalTable.setRows(chalRows); return; }
    chalTable = TKTable.create($('pc'), {
      id: 'pc', compact: true, urlState: false, pageSize: 50,
      source: { rows: () => chalRows },
      columns: chalCells(),
      defaultSort: 'expiresAt',
      empty: 'None. Nothing is waiting for you.',
    });
  }

  function acctCells() {
    return [
      { key: 'id', label: 'Account', type: 'text', value: (a) => a.id,
        render: (a) => '<b class="mono">' + esc(a.id) + '</b> ' + (a.passive ? '<span class="badge info"' + tipA('A control account: logged in on its own exit but never used for fetching.') + '>passive</span>' : '') },
      { key: 'state', label: 'State', type: 'enum', options: STATE_OPTS, value: (a) => (isQueued(a) ? 'queued' : String(a.state || 'unknown')),
        tip: 'Where the account is in its life: new, warming, active, passive, resting or retired. Press a state badge for details.',
        render: (a) => {
          if (isQueued(a)) {
            const left = Date.parse(a.scheduledAt) - Date.now();
            const due = Number.isFinite(left) ? (left > 0 ? 'in ' + fmtDur(left) : 'due now') : '';
            const tries = a.attempts ? '<div class="sub error">' + esc(a.attempts === 1 ? 'Tried once, failed' : 'Tried ' + a.attempts + ' times, failed') + (a.lastError ? ': ' + esc(a.lastError) : '') + '. Trying again every 30 min.</div>' : a.lastError ? '<div class="sub error">' + esc(a.lastError) + '</div>' : '';
            return stateBadge(a) + '<div class="muted sub"' + tipA('Your local time') + '>creates ' + esc(fmtDateTime(a.scheduledAt)) + (due ? ' (' + esc(due) + ')' : '') + '</div>' + tries;
          }
          return stateBadge(a) + (a.restUntil ? ' <span class="muted">until ' + esc(fmtTime(a.restUntil)) + '</span>' : '');
        } },
      { key: 'exit', label: 'Exit', type: 'text', value: (a) => a.exitLabel || a.exitKind || null, tip: 'The IP address route this account is pinned to. Each account keeps one exit for good.',
        render: (a) => isQueued(a)
          ? (a.exitKind ? '<span class="badge neutral">' + esc(a.exitKind) + '</span>' : '<span class="muted">auto</span>')
          : '<span class="mono">' + esc(a.exitLabel || '—') + '</span>' + (a.exitKind ? ' <span class="badge neutral"' + tipA('Where the traffic of this account leaves from: your own IP, Mullvad or AirVPN.') + '>' + esc(a.exitKind) + '</span>' : '') },
      { key: 'usedToday', label: 'Today', type: 'number', value: (a) => (isQueued(a) ? null : a.usedToday), tip: 'Page views in the last 24 hours out of the account daily budget. Sorts by page views.',
        render: (a) => (isQueued(a) ? '—' : esc(a.usedToday ?? '—') + ' / ' + esc(a.budget ?? '—')) },
      { key: 'rampDay', label: 'Ramp', type: 'number', value: (a) => (isQueued(a) ? null : a.rampDay), tip: 'Which day of its ramp a new account is on. New accounts get a smaller budget for their first days.', hideOn: 'phone',
        render: (a) => (isQueued(a) ? '—' : esc(a.rampDay ?? '—')) },
      { key: 'lastOkAt', label: 'Last ok', type: 'datetime', storage: 'iso', tip: 'When this account last loaded a page successfully.', render: (a) => (isQueued(a) ? '—' : esc(ago(a.lastOkAt))) },
      { key: 'lastChallengeAt', label: 'Last challenge', type: 'datetime', storage: 'iso', tip: 'When this account last hit a captcha.', hideOn: 'phone', render: (a) => (isQueued(a) ? '—' : esc(ago(a.lastChallengeAt))) },
      { key: 'flagged', label: 'Flagged', type: 'bool', value: (a) => !!a.flagged, tip: 'Whether 1001tracklists flagged the account as suspicious.',
        render: (a) => (a.flagged ? '<span class="badge bad"' + tipA('1001tracklists flagged this account (for instance it served decoy track names). It rests 72 hours, then gets one retest.') + '>flagged</span>' + (a.flagReason ? ' <span class="muted">' + esc(a.flagReason.replace(/_/g, ' ')) + '</span>' : '') : '<span class="muted">no</span>') },
    ];
  }
  // A row's action buttons (also what "No" puts back).
  function actsInner(a) {
    if (isQueued(a)) return '<button type="button" class="btn small" data-act="cancel" data-id="' + esc(a.id) + '"' + tipA(ACT_TIPS.cancel) + '>Cancel</button>';
    if (a.state === 'retired') return '<span class="muted">retired</span>';
    return ['rest', 'retest', 'retire'].map((act) => '<button type="button" class="btn small" data-act="' + act + '" data-id="' + esc(a.id) + '"' + tipA(ACT_TIPS[act]) + '>' + act[0].toUpperCase() + act.slice(1) + '</button>').join('');
  }
  const acctNum = (id) => { const m = /(\\d+)$/.exec(String(id)); return m ? Number(m[1]) : 0; };
  function renderAccounts(accts) {
    accts = accts || [];
    // The default order: real accounts by number, then the scheduled creations (soonest first).
    const queued = accts.filter(isQueued).sort((x, y) => String(x.scheduledAt || '').localeCompare(String(y.scheduledAt || '')));
    const real = accts.filter((a) => !isQueued(a)).sort((x, y) => acctNum(x.id) - acctNum(y.id) || String(x.id).localeCompare(String(y.id)));
    acctRows = real.concat(queued).map((a, i) => Object.assign({}, a, { _i: i }));
    $('accts-msg').hidden = acctRows.length > 0;
    $('accts-msg').innerHTML = acctRows.length ? '' : '<div class="empty">No accounts yet. Press + Add account.</div>';
    if (!hasTable()) return;
    if (acctTable) { acctTable.setRows(acctRows); return; }
    acctTable = TKTable.create($('pa'), {
      id: 'pa',
      source: { rows: () => acctRows },
      columns: acctCells(),
      rowKey: '_i',
      search: 'Search accounts and exits',
      rowAttrs: (a) => (isQueued(a) ? { 'data-queued': '1' } : null),
      chips: [
        { id: 'all', label: 'All', group: 'state', on: true, count: countOf(() => true) },
        { id: 'fetching', label: 'Fetching', group: 'state', tip: 'Active or warming accounts that are not passive or flagged.', filters: [{ col: 'state', op: 'in', value: FETCHING.join('|') }, { col: 'flagged', op: 'eq', value: '0' }], count: countOf((a) => !isQueued(a) && FETCHING.indexOf(a.state) >= 0 && !a.flagged && !a.passive) },
        { id: 'new', label: 'New', group: 'state', filters: [{ col: 'state', op: 'in', value: 'new|creating|signup|pending' }], count: countOf((a) => !isQueued(a) && IN_CREATION.test(String(a.state))) },
        { id: 'resting', label: 'Resting', group: 'state', filters: [{ col: 'state', op: 'in', value: 'resting' }], count: countOf((a) => a.state === 'resting') },
        { id: 'flagged', label: 'Flagged', group: 'state', filters: [{ col: 'flagged', op: 'eq', value: '1' }], count: countOf((a) => !!a.flagged) },
        { id: 'passive', label: 'Passive', group: 'state', filters: [{ col: 'state', op: 'in', value: 'passive' }], count: countOf((a) => a.state === 'passive') },
        { id: 'retired', label: 'Retired', group: 'state', filters: [{ col: 'state', op: 'in', value: 'retired|signup_failed' }], count: countOf((a) => a.state === 'retired' || a.state === 'signup_failed') },
        { id: 'queued', label: 'Queued', group: 'state', tip: 'Accounts scheduled to be created later.', filters: [{ col: 'state', op: 'in', value: 'queued' }], count: countOf(isQueued) },
      ],
      actions: (a) => '<div class="acts" data-acts="' + esc(a.id) + '">' + actsInner(a) + '</div>',
      empty: 'No accounts yet. Press + Add account.',
    });
  }

  // In-page confirmation (no confirm()): the buttons of that row turn into a question.
  $('accts').addEventListener('click', async (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.signup) { openFlow(b.dataset.signup, b.dataset.acct || null); return; }
    if (b.dataset.stateAcct) { openDetails(b.dataset.stateAcct); return; }
    const box = b.closest('[data-acts]');
    const id = box && box.dataset.acts;
    if (b.dataset.act) {
      const act = b.dataset.act;
      box.innerHTML = '<div class="confirm"><span>' + esc(id) + ': ' + esc(confirmWords[act]) + '</span>' +
        '<button type="button" class="btn small ' + (act === 'retire' ? 'danger' : 'primary') + '" data-yes="' + act + '">Yes, ' + (act === 'cancel' ? 'cancel it' : act) + '</button>' +
        '<button type="button" class="btn small" data-no="1">No</button></div>';
      return;
    }
    if (b.dataset.no) { const a = acctRows.find((x) => x.id === id); if (a) box.innerHTML = actsInner(a); else load(); return; }
    if (b.dataset.yes) {
      const act = b.dataset.yes;
      b.disabled = true; b.textContent = 'Working…';
      const r = await api('/accounts/' + encodeURIComponent(id) + '/' + act, jsonInit('POST', {}));
      if (!r.ok && (r.status === 401 || r.status === 403)) { box.innerHTML = '<span class="error">' + esc(SIGN_IN_AGAIN) + '</span>'; return; }
      if (!r.ok) { box.innerHTML = '<span class="error">' + esc(errText(r.data, r.status)) + '</span> <button type="button" class="btn small" data-no="1">OK</button>'; return; }
      box.innerHTML = '';
      load();
    }
  });

  async function load() {
    const r = await api('/status');
    if (!r.ok) {
      $('err').hidden = false; $('err').textContent = r.status === 401 || r.status === 403 ? SIGN_IN_AGAIN : errText(r.data, r.status);
      if (!lastStatus) { $('accts-msg').innerHTML = ''; $('chals-msg').innerHTML = ''; }
      return r;
    }
    $('err').hidden = true;
    lastStatus = r.data.status;
    renderStats(r.data.status, r.data.challenges || []);
    renderChallenges(r.data.challenges || [], r.data.challengesError);
    if (!r.data.challengesError && typeof TK !== 'undefined') TK.navCount((r.data.challenges || []).filter((c) => c.state === 'pending' && c.ready !== false).length);
    // Don't clobber a row that is mid-confirmation.
    if (!document.querySelector('#accts .confirm')) renderAccounts(r.data.status.accounts || []);
    return r;
  }
  load();
  const showBanner = (t) => { $('err').hidden = false; $('err').textContent = t; };
  poller(load, 20000, { onAuth: () => showBanner(SIGN_IN_AGAIN), onTimeout: () => showBanner('Auto-refresh stopped after 15 minutes. Reload the page to see fresh numbers.') });

  // ── Add account ────────────────────────────────────────────────────────
  const STEPS = [
    ['exit_assigned', 'Exit assigned'],
    ['form_opened', 'Signup form opened'],
    ['awaiting_captcha', 'Waiting for your captcha'],
    ['submitted', 'Submitted'],
    ['awaiting_email', 'Waiting for the confirmation email'],
    ['confirmed', 'Email confirmed'],
    ['logged_in', 'Logged in'],
    ['done', 'Done'],
  ];
  const STEP_ALIASES = { exit: 'exit_assigned', form: 'form_opened', captcha: 'awaiting_captcha', waiting_captcha: 'awaiting_captcha', captcha_pending: 'awaiting_captcha', waiting_email: 'awaiting_email', email: 'awaiting_email', email_confirmed: 'confirmed', login: 'logged_in', created: 'done', complete: 'done', completed: 'done' };
  // Below the pollers' 15-minute hard stop, so a stuck signup is called stuck before watching ends.
  const NO_PROGRESS_MS = 10 * 60000;
  const dlg = $('add-dlg');

  // Every creation the page follows is its own flow object, kept here: { key, challengeId, accountId, stepIdx,
  // lastChange, startedAt, poller, captchaSeen, needCaptcha, ch, msg, active, failed, done }. The dialog shows at
  // most one of them (shown) or the form; the others keep their own state, and every write to the dialog goes
  // through paint(f), which draws only the one on screen. So "+ Add account" always opens a fresh form, however many
  // creations are running, and each one can be reopened from the list under the form or from its "new" badge.
  const flows = new Map();
  let shown = null;
  let flowSeq = 0;
  let captchaOwner = null; // the flow whose captcha widget is in #add-captcha

  const newFlow = () => ({ key: 'f' + (++flowSeq), challengeId: null, accountId: null, stepIdx: -1, lastChange: Date.now(), startedAt: Date.now(), poller: null, captchaSeen: false, needCaptcha: false, ch: null, msg: '', active: true, failed: false, done: false });
  const findFlow = (challengeId) => { for (const f of flows.values()) if (f.challengeId === challengeId) return f; return null; };

  function stepIndex(step) { const s = STEP_ALIASES[step] || step; return STEPS.findIndex((x) => x[0] === s); }
  // The captcha step is optional: tlpool's real signup form usually has none,
  // and then goes from form_opened straight to submitted. A step this page
  // never saw is shown as skipped only for that optional step.
  const OPTIONAL_STEP = 'awaiting_captcha';
  function renderSteps(f, idx, failed) {
    const skipCaptcha = !f.captchaSeen && idx > stepIndex(OPTIONAL_STEP);
    $('add-steps').innerHTML = STEPS.map((s, i) => {
      if (s[0] === OPTIONAL_STEP && skipCaptcha) return '<li class="skip"><span class="dot">–</span>' + esc('No captcha needed') + '</li>';
      const cls = failed && i === idx ? 'fail' : i < idx || (i === idx && s[0] === 'done') ? 'done' : i === idx ? 'cur' : '';
      const dot = cls === 'done' ? '✓' : cls === 'cur' ? '●' : cls === 'fail' ? '✗' : '○';
      return '<li class="' + cls + '"><span class="dot">' + dot + '</span>' + esc(s[1]) + '</li>';
    }).join('');
  }

  // Draws one flow into the dialog, if it is the one on screen.
  function paint(f) {
    if (shown !== f) return;
    $('add-form').hidden = true; $('add-progress').hidden = false;
    renderSteps(f, f.failed ? Math.max(f.stepIdx, 0) : f.stepIdx, f.failed);
    $('add-msg').innerHTML = f.msg || '';
    $('add-retry').hidden = !f.failed;
    const wantCaptcha = !f.failed && f.needCaptcha && f.ch && f.ch.type;
    if (wantCaptcha) {
      if (captchaOwner !== f) { $('add-captcha').hidden = false; mountCaptcha($('add-captcha'), f.ch, {}); captchaOwner = f; }
    } else {
      $('add-captcha').hidden = true;
      if (captchaOwner) { $('add-captcha').innerHTML = ''; captchaOwner = null; }
    }
  }
  function stopFlow(f) { if (f.poller) f.poller.stop(); f.active = false; }
  function failFlow(f, text) {
    stopFlow(f);
    f.failed = true;
    f.msg = '<div class="banner bad">' + esc(text) + '</div>';
    paint(f);
    renderActive();
  }
  function flowStatus(f) {
    if (f.failed) return 'failed';
    if (f.needCaptcha) return 'waiting for your captcha';
    return f.stepIdx >= 0 && STEPS[f.stepIdx] ? STEPS[f.stepIdx][1] : 'starting';
  }
  // The creations still running (or failed, until dismissed) that are not on screen: the ones this page started, and
  // accounts the pool is still signing up that this page has not opened yet.
  function renderActive() {
    const items = [];
    for (const f of flows.values()) if (!f.done) items.push('<li><div class="row"><b class="mono">' + esc(f.accountId || 'new account') + '</b><span class="muted sub">' + esc(flowStatus(f)) + '</span><span class="spacer"></span><button type="button" class="btn small" data-flow="' + esc(f.key) + '">Show progress</button></div></li>');
    for (const a of ((lastStatus && lastStatus.accounts) || [])) {
      if (IN_CREATION.test(String(a.state)) && a.signupChallengeId && !findFlow(a.signupChallengeId)) items.push('<li><div class="row"><b class="mono">' + esc(a.id) + '</b><span class="muted sub">being created</span><span class="spacer"></span><button type="button" class="btn small" data-signup="' + esc(a.signupChallengeId) + '" data-acct="' + esc(a.id) + '">Show progress</button></div></li>');
    }
    $('add-active').hidden = !items.length;
    $('add-active').innerHTML = items.length ? '<h3 class="pool-h2" style="margin-top:var(--sp-4)">Creations in progress</h3><ul class="plain">' + items.join('') + '</ul>' : '';
  }
  const pad2 = (n) => String(n).padStart(2, '0');
  // The value format of <input type="datetime-local">: local time, minutes.
  const localInput = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  // A fresh form: nothing of any running creation on screen (they carry on in their own flow objects).
  function resetDialog() {
    shown = null; captchaOwner = null;
    $('add-form').hidden = false; $('add-progress').hidden = true; $('add-retry').hidden = true;
    $('add-captcha').hidden = true; $('add-captcha').innerHTML = ''; $('add-msg').innerHTML = '';
    $('add-form-msg').innerHTML = '';
    $('add-create').disabled = false;
    const now = new Date();
    $('add-when').min = localInput(now);
    $('add-when').max = localInput(new Date(now.getTime() + 90 * DAY_MS));
    renderActive();
  }

  const stalled = (f) => Date.now() - f.lastChange > NO_PROGRESS_MS;
  async function poll(f) {
    if (!flows.has(f.key)) return;
    // The stall guard runs before any early return, errors included.
    if (stalled(f)) { failFlow(f, 'No progress for 10 minutes. The flow may be stuck on the NAS.'); return; }
    const r = await api('/challenges/' + encodeURIComponent(f.challengeId));
    // A reply that lands after this creation was dismissed is dropped.
    if (!flows.has(f.key) || f.failed || f.done) return r;
    let ch = r.ok ? r.data.challenge : null;
    if (!r.ok && r.status === 404 && f.stepIdx >= stepIndex('submitted') && f.accountId) {
      // The solved challenge may be gone already; follow the account instead.
      const a = await api('/accounts');
      if (!flows.has(f.key)) return a;
      const acct = a.ok ? (a.data.accounts || []).find((x) => x.id === f.accountId) : null;
      if (acct && !IN_CREATION.test(acct.state)) { ch = { state: 'solved', step: 'done' }; }
      else return a.ok ? r : a;
    } else if (!r.ok) {
      if (r.status === 401 || r.status === 403) return r; // the poller stops and says sign in again
      // tlpool may only create the challenge record once the form is open: a
      // 404 in the first 90 s (before any step was seen) means "still starting".
      if (r.status === 404 && f.stepIdx < 0 && Date.now() - f.startedAt < 90000) { f.msg = '<div class="muted">Starting…</div>'; paint(f); return r; }
      if (r.status === 404) { failFlow(f, 'The pool lost track of this signup. Check the accounts table, then try again.'); return r; }
      f.msg = '<div class="muted">' + esc(errText(r.data, r.status)) + ' Still trying…</div>'; paint(f);
      return r;
    }
    // Steps come from tlpool as it reports them; an unknown or missing step keeps the last one.
    let idx = ch.step ? stepIndex(ch.step) : -1;
    if (idx < 0) idx = f.stepIdx;
    if (idx !== f.stepIdx) { f.stepIdx = idx; f.lastChange = Date.now(); }
    if (ch.state === 'failed') { failFlow(f, 'The signup failed' + (ch.error ? ': ' + ch.error : '.')); return r; }
    if (ch.state === 'expired') { failFlow(f, errText({ error: 'captcha_expired' })); return r; }
    // Only a challenge tlpool marks ready has a captcha to answer (the form showed one).
    f.needCaptcha = ch.state === 'pending' && ch.ready !== false;
    if (f.needCaptcha) { f.captchaSeen = true; f.ch = ch; }
    if (STEPS[idx] && STEPS[idx][0] === 'done') {
      stopFlow(f);
      f.done = true; f.needCaptcha = false;
      f.msg = '<div class="banner ok">Account ' + esc(f.accountId || '') + ' is ready.</div>';
      paint(f); renderActive();
      load();
      return r;
    }
    f.msg = '';
    paint(f); renderActive();
    return r;
  }
  function watchFlow(f) {
    f.poller = poller(() => poll(f), 2500, {
      onAuth: () => { f.msg = '<div class="banner bad">' + esc(SIGN_IN_AGAIN) + '</div>'; paint(f); },
      onTimeout: () => { f.msg = '<div class="banner info">Stopped watching after 15 minutes. The signup carries on in the pool; close and reopen this dialog to look again.</div>'; paint(f); },
    });
  }
  // Start (or restart, after the dialog was closed) watching every creation still running.
  function resumeFlow(f) {
    if (!f.active || !f.challengeId || (f.poller && !f.poller.isStopped())) return;
    f.lastChange = Date.now();
    poll(f);
    watchFlow(f);
  }

  function exitBody(passive, exit, scheduledAt) {
    const b = exit && exit !== 'auto' ? { passive, exitKind: exit } : { passive };
    if (scheduledAt) b.scheduledAt = scheduledAt;
    return b;
  }
  // The "create at" box: '' (now), or the picked local time as an ISO UTC string. null: not usable (message shown).
  function pickedTime() {
    const v = $('add-when') && $('add-when').value;
    if (!v) return '';
    const t = new Date(v);
    const bad = (m) => { $('add-form-msg').innerHTML = '<div class="banner bad">' + esc(m) + '</div>'; return null; };
    if (!Number.isFinite(t.getTime())) return bad('That date and time was not understood.');
    if (t.getTime() < Date.now() - 60000) return bad('Pick a time in the future, or clear the box to start now.');
    if (t.getTime() > Date.now() + 90 * DAY_MS) return bad('The pool queues an account at most 90 days ahead.');
    return t.toISOString();
  }
  const fmtDateTime = (iso) => (!iso || !Number.isFinite(Date.parse(iso)) ? '—' : new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));

  async function create() {
    $('add-form-msg').innerHTML = '';
    const scheduledAt = pickedTime();
    if (scheduledAt === null) return;
    const body = exitBody($('add-passive').checked, $('add-exit') && $('add-exit').value, scheduledAt);
    $('add-create').disabled = true;
    if (scheduledAt) {
      // Scheduled: nothing starts now, so there is no progress to show. tlpool queues it; the table lists it.
      const r = await api('/accounts', jsonInit('POST', body));
      $('add-create').disabled = false;
      if (!r.ok) { $('add-form-msg').innerHTML = '<div class="banner bad">' + esc(r.status === 401 || r.status === 403 ? SIGN_IN_AGAIN : errText(r.data, r.status)) + '</div>'; return; }
      if (r.data.queued) {
        $('add-when').value = '';
        dlg.close();
        if (typeof TK !== 'undefined' && TK.toast) TK.toast('Queued: will be created around ' + fmtDateTime(r.data.scheduledAt || scheduledAt), 'ok');
        load();
        return;
      }
      // tlpool started it right away (the time was too close to now): follow it like any other creation.
      begin(r.data);
      return;
    }
    const f = newFlow();
    flows.set(f.key, f);
    shown = f;
    f.msg = '<div class="muted">Starting…</div>';
    paint(f);
    const r = await api('/accounts', jsonInit('POST', body));
    if (!r.ok) { f.stepIdx = 0; failFlow(f, errText(r.data, r.status)); return; }
    attach(f, r.data);
  }
  // A creation tlpool just started with no flow made for it yet (the scheduled path).
  function begin(data) {
    const f = newFlow();
    flows.set(f.key, f);
    shown = f;
    attach(f, data);
  }
  function attach(f, data) {
    f.challengeId = data.challengeId; f.accountId = data.accountId;
    f.startedAt = Date.now(); f.lastChange = Date.now();
    paint(f);
    // The dialog was closed while the request ran: watching starts when it is opened again.
    if (dlg.open !== false) resumeFlow(f);
  }

  // Show one creation's progress: from the list under the form or from the "new" badge of its row.
  function showFlow(f) {
    shown = f;
    resumeFlow(f);
    paint(f);
    if (!dlg.open) dlg.showModal();
  }
  // Reopen the progress view for an account that is still being created (its
  // "new" badge): follow its signup challenge exactly as create() does.
  function openFlow(challengeId, accountId) {
    let f = findFlow(challengeId);
    if (!f) {
      f = newFlow();
      f.challengeId = challengeId; f.accountId = accountId;
      f.startedAt = 0; // the challenge already exists in tlpool, so a 404 is not "still starting"
      f.msg = '<div class="muted">Loading…</div>';
      flows.set(f.key, f);
    }
    showFlow(f);
  }

  // "+ Add account" always opens a fresh form. Closing the dialog stops the pollers (the signups themselves carry on
  // in the pool); opening it again picks them up.
  $('add-btn').addEventListener('click', () => {
    resetDialog();
    for (const f of flows.values()) resumeFlow(f);
    dlg.showModal();
  });
  $('add-close').addEventListener('click', () => dlg.close());
  $('add-create').addEventListener('click', create);
  // Dismiss the failed creation on screen and go back to the form.
  $('add-retry').addEventListener('click', () => { if (shown) flows.delete(shown.key); resetDialog(); });
  $('add-back').addEventListener('click', () => { resetDialog(); });
  $('add-active').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.flow) { const f = flows.get(b.dataset.flow); if (f) showFlow(f); return; }
    if (b.dataset.signup) openFlow(b.dataset.signup, b.dataset.acct || null);
  });
  dlg.addEventListener('close', () => { for (const f of flows.values()) if (f.poller) f.poller.stop(); load(); });
})();
`

/** The state details drawer (TK.drawer). */
const DETAILS_CSS = /* css */ `
  .badge.queued { color: var(--accent); background: var(--elev); box-shadow: inset 0 0 0 1px var(--accent); }
  .tk-table tr[data-queued] td { background: color-mix(in srgb, var(--elev) 40%, transparent); }
  #chals-msg:empty, #accts-msg:empty { display: none; }
  #pc .tkt-table thead th { white-space: nowrap; }
  @media (min-width: 700px) { #pa .tkt-table td.tkt-acts .acts { flex-wrap: nowrap; justify-content: flex-end; } }
  #add-form input[type=datetime-local] { max-width: 100%; }
  .sd h3 { font-size: var(--fs-sm); margin: var(--sp-4) 0 var(--sp-2); color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .sd p { margin: 0 0 var(--sp-2); }
  .sd ul.sd-list { margin: 0; padding-left: 1.2rem; display: grid; gap: var(--sp-1); }
  .sd ul.sd-events { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--sp-2); }
  .sd ul.sd-events li { border-left: 2px solid var(--line-strong); padding-left: var(--sp-3); }
`

export const POOL_PAGE_HTML = shell({
  nav: 'pool',
  title: 'Pool accounts',
  actions: '<button id="add-btn" type="button" class="btn primary">+ Add account</button>',
  body: BODY,
  css: POOL_CSS + DETAILS_CSS,
  js: JS,
  ownNavCount: true,
})
