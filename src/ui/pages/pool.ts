// Pool accounts page: stats, pending challenges, accounts table and the Add account dialog.
import { shell } from '../shell'
import { POOL_CSS, COMMON_JS, CAPTCHA_JS } from './pool-common'

const BODY = /* html */ `
  <div id="err" class="banner bad" hidden></div>
  <div id="stats" class="tk-tiles"></div>
  <div id="prio" class="tk-card" hidden></div>
  <h2 class="pool-h2">Pending challenges</h2>
  <div id="chals"><div class="empty">loading…</div></div>
  <h2 class="pool-h2">Accounts</h2>
  <div id="accts"><div class="empty">loading…</div></div>
  <p class="muted stat-note">Accounts are shown by their opaque id only. Usernames, emails and passwords stay on the NAS.</p>

<dialog id="add-dlg" class="tk-dialog" aria-labelledby="add-title">
  <div class="row"><h2 id="add-title" style="margin:0">Add account</h2><span class="spacer"></span><button id="add-close" type="button" class="btn small">Close</button></div>
  <div id="add-form">
    <p class="muted sub">The pool picks a free exit IP, generates the username and password, fills the signup form and confirms the email on its own. You only solve the captcha.</p>
    <div class="field"><label for="add-exit">Exit type</label><select id="add-exit"><option value="auto" selected>Auto (default)</option><option value="own">Own IP</option><option value="mullvad">Mullvad</option><option value="airvpn">AirVPN</option></select><span class="hint">Where the new account's traffic leaves from. Auto lets the pool pick a free exit of any kind.</span></div>
    <label class="switch"><input id="add-passive" type="checkbox" /><span><b>Passive</b> (control group, never used for fetching)<br><span class="muted sub">Pinned to its own exit and logged in, but never fetches. It shows whether flags come from use or from simply existing.</span></span></label>
    <div class="row" style="margin-top:var(--sp-4)"><span class="spacer"></span><button id="add-create" type="button" class="btn primary">Create</button></div>
  </div>
  <div id="add-progress" hidden>
    <ol id="add-steps" class="steps"></ol>
    <div id="add-captcha" class="tk-card" hidden></div>
    <div id="add-msg"></div>
    <div class="row" style="margin-top:var(--sp-3)"><span class="spacer"></span><button id="add-retry" type="button" class="btn" hidden>Try again</button></div>
  </div>
</dialog>
`

const JS = /* js */ `
(() => {
${COMMON_JS}
${CAPTCHA_JS}
  // ── overview ───────────────────────────────────────────────────────────
  const stateBadge = (a) => {
    const s = String(a.state || 'unknown');
    // tlpool states: new (signing up), warming (ramp days 1-2), active, passive, resting, retired.
    const cls = a.flagged || s === 'flagged' ? 'bad' : s === 'retired' ? '' : s === 'resting' || s === 'new' || s === 'creating' ? 'warn' : s === 'warming' || s === 'ramping' ? 'info' : s === 'active' || s === 'ok' || s === 'healthy' ? 'ok' : 'info';
    return '<span class="badge ' + cls + '">' + esc(s) + '</span>';
  };
  const confirmWords = { rest: 'Rest it for 72 hours?', retest: 'Retest it with one known set?', retire: 'Retire it for good? Its exit stays unused for 30 days.' };
  let lastStatus = null;

  function renderStats(st, chals) {
    const accts = st.accounts || [];
    const live = accts.filter((a) => a.state !== 'retired');
    const fetching = live.filter((a) => !a.passive && !a.flagged && (a.state === 'active' || a.state === 'warming' || a.state === 'ok' || a.state === 'healthy' || a.state === 'ramping'));
    const budget = fetching.reduce((s, a) => s + (a.budget || 0), 0);
    const used = fetching.reduce((s, a) => s + (a.usedToday || 0), 0);
    const tile = (v, k) => '<div class="tk-tile"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div></div>';
    $('stats').innerHTML =
      tile(st.requestsToday ?? '—', 'page views today') +
      tile(used + ' / ' + budget, 'used / budget (fetching accounts)') +
      tile(st.queueDepth ?? '—', 'queued fetches') +
      tile(fetching.length + ' / ' + live.length, 'fetching / live accounts') +
      tile(chals.length, 'pending challenges');
    const chips = (m) => Object.keys(m).map((k) => '<span class="chip">' + esc(k) + ' <b>' + esc(m[k]) + '</b></span>').join('');
    const bp = st.requestsByPriority || {}, qp = st.queueByPriority || {};
    const parts = [];
    if (Object.keys(bp).length) parts.push('<div class="muted sub">Requests today by priority</div><div class="chips">' + chips(bp) + '</div>');
    if (Object.keys(qp).length) parts.push('<div class="muted sub" style="margin-top:var(--sp-3)">Queue by priority</div><div class="chips">' + chips(qp) + '</div>');
    $('prio').hidden = !parts.length;
    $('prio').innerHTML = parts.join('');
  }

  function renderChallenges(chals, errCode) {
    if (errCode) { $('chals').innerHTML = '<div class="empty error">' + esc(errText({ error: errCode })) + '</div>'; return; }
    const open = chals.filter((c) => c.state === 'pending' && c.ready !== false);
    if (!open.length) { $('chals').innerHTML = '<div class="empty">None. Nothing is waiting for you.</div>'; return; }
    $('chals').innerHTML = '<ul class="plain">' + open.map((c) => {
      const l = leftText(c.expiresAt);
      return '<li><div class="row"><a href="/ui/captcha/' + encodeURIComponent(c.id) + '"><b>Solve ' + esc(typeText(c.type)) + '</b></a><span class="spacer"></span><span class="left' + (l.soon ? ' soon' : '') + '">' + esc(l.text) + '</span></div>' +
        '<div class="muted sub">' + esc(c.accountId || 'no account yet') + ' · ' + esc(reasonText(c.reason)) + ' · since ' + esc(fmtTime(c.createdAt)) + '</div></li>';
    }).join('') + '</ul>';
  }

  function renderAccounts(accts) {
    if (!accts.length) { $('accts').innerHTML = '<div class="empty">No accounts yet. Press + Add account.</div>'; return; }
    const rows = accts.map((a) => {
      const flag = a.flagged ? '<span class="badge bad">flagged</span>' + (a.flagReason ? ' <span class="muted">' + esc(a.flagReason.replace(/_/g, ' ')) + '</span>' : '') : '<span class="muted">no</span>';
      const acts = a.state === 'retired' ? '<span class="muted">retired</span>' :
        ['rest', 'retest', 'retire'].map((act) => '<button type="button" class="btn small" data-act="' + act + '" data-id="' + esc(a.id) + '">' + act[0].toUpperCase() + act.slice(1) + '</button>').join('');
      return '<tr>' +
        '<td data-label="Account"><b class="mono">' + esc(a.id) + '</b> ' + (a.passive ? '<span class="badge info">passive</span>' : '') + '</td>' +
        '<td data-label="State">' + stateBadge(a) + (a.restUntil ? ' <span class="muted">until ' + esc(fmtTime(a.restUntil)) + '</span>' : '') + '</td>' +
        '<td data-label="Exit"><span class="mono">' + esc(a.exitLabel || '—') + '</span>' + (a.exitKind ? ' <span class="badge neutral">' + esc(a.exitKind) + '</span>' : '') + '</td>' +
        '<td data-label="Today" class="num">' + esc(a.usedToday ?? '—') + ' / ' + esc(a.budget ?? '—') + '</td>' +
        '<td data-label="Ramp day" class="num">' + esc(a.rampDay ?? '—') + '</td>' +
        '<td data-label="Last success">' + esc(ago(a.lastOkAt)) + '</td>' +
        '<td data-label="Last challenge">' + esc(ago(a.lastChallengeAt)) + '</td>' +
        '<td data-label="Flagged">' + flag + '</td>' +
        '<td class="acts-cell"><div class="acts" data-acts="' + esc(a.id) + '">' + acts + '</div></td>' +
        '</tr>';
    }).join('');
    $('accts').innerHTML = '<div class="tk-table-wrap"><table class="tk-table"><thead><tr><th>Account</th><th>State</th><th>Exit</th><th>Today</th><th>Ramp</th><th>Last ok</th><th>Last challenge</th><th>Flagged</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  // In-page confirmation (no confirm()): the buttons of that row turn into a question.
  $('accts').addEventListener('click', async (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    const box = b.closest('[data-acts]');
    const id = box && box.dataset.acts;
    if (b.dataset.act) {
      const act = b.dataset.act;
      box.innerHTML = '<div class="confirm"><span>' + esc(id) + ': ' + esc(confirmWords[act]) + '</span>' +
        '<button type="button" class="btn small ' + (act === 'retire' ? 'danger' : 'primary') + '" data-yes="' + act + '">Yes, ' + act + '</button>' +
        '<button type="button" class="btn small" data-no="1">Cancel</button></div>';
      return;
    }
    if (b.dataset.no) { load(); return; }
    if (b.dataset.yes) {
      const act = b.dataset.yes;
      b.disabled = true; b.textContent = 'Working…';
      const r = await api('/accounts/' + encodeURIComponent(id) + '/' + act, jsonInit('POST', {}));
      if (!r.ok && (r.status === 401 || r.status === 403)) { box.innerHTML = '<span class="error">' + esc(SIGN_IN_AGAIN) + '</span>'; return; }
      if (!r.ok) { box.innerHTML = '<span class="error">' + esc(errText(r.data, r.status)) + '</span> <button type="button" class="btn small" data-no="1">OK</button>'; return; }
      load();
    }
  });

  async function load() {
    const r = await api('/status');
    if (!r.ok) {
      $('err').hidden = false; $('err').textContent = r.status === 401 || r.status === 403 ? SIGN_IN_AGAIN : errText(r.data, r.status);
      if (!lastStatus) { $('accts').innerHTML = ''; $('chals').innerHTML = ''; }
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
  let flow = null; // { challengeId, accountId, stepIdx, lastChange, poller, captchaShown, captchaSeen, widget }

  function stepIndex(step) { const s = STEP_ALIASES[step] || step; return STEPS.findIndex((x) => x[0] === s); }
  // The captcha step is optional: tlpool's real signup form usually has none,
  // and then goes from form_opened straight to submitted. A step this page
  // never saw is shown as skipped only for that optional step.
  const OPTIONAL_STEP = 'awaiting_captcha';
  function renderSteps(idx, failed) {
    const skipCaptcha = flow && !flow.captchaSeen && idx > stepIndex(OPTIONAL_STEP);
    $('add-steps').innerHTML = STEPS.map((s, i) => {
      if (s[0] === OPTIONAL_STEP && skipCaptcha) return '<li class="skip"><span class="dot">–</span>' + esc('No captcha needed') + '</li>';
      const cls = failed && i === idx ? 'fail' : i < idx || (i === idx && s[0] === 'done') ? 'done' : i === idx ? 'cur' : '';
      const dot = cls === 'done' ? '✓' : cls === 'cur' ? '●' : cls === 'fail' ? '✗' : '○';
      return '<li class="' + cls + '"><span class="dot">' + dot + '</span>' + esc(s[1]) + '</li>';
    }).join('');
  }
  function stopFlow() { if (flow) { if (flow.poller) flow.poller.stop(); flow.active = false; } }
  function failFlow(text) {
    stopFlow();
    renderSteps(flow ? Math.max(flow.stepIdx, 0) : 0, true);
    $('add-captcha').hidden = true;
    $('add-msg').innerHTML = '<div class="banner bad">' + esc(text) + '</div>';
    $('add-retry').hidden = false;
  }
  function resetDialog() {
    stopFlow(); flow = null;
    $('add-form').hidden = false; $('add-progress').hidden = true; $('add-retry').hidden = true;
    $('add-captcha').hidden = true; $('add-captcha').innerHTML = ''; $('add-msg').innerHTML = '';
    $('add-create').disabled = false;
  }

  const stalled = () => flow && Date.now() - flow.lastChange > NO_PROGRESS_MS;
  async function poll() {
    if (!flow) return;
    // The stall guard runs before any early return, errors included.
    if (stalled()) { failFlow('No progress for 10 minutes. The flow may be stuck on the NAS.'); return; }
    const r = await api('/challenges/' + encodeURIComponent(flow.challengeId));
    let ch = r.ok ? r.data.challenge : null;
    if (!r.ok && r.status === 404 && flow.stepIdx >= stepIndex('submitted') && flow.accountId) {
      // The solved challenge may be gone already; follow the account instead.
      const a = await api('/accounts');
      const acct = a.ok ? (a.data.accounts || []).find((x) => x.id === flow.accountId) : null;
      if (acct && !/^(creating|signup|pending|new)$/.test(acct.state)) { ch = { state: 'solved', step: 'done' }; }
      else return a.ok ? r : a;
    } else if (!r.ok) {
      if (r.status === 401 || r.status === 403) return r; // the poller stops and says sign in again
      // tlpool may only create the challenge record once the form is open: a
      // 404 in the first 90 s (before any step was seen) means "still starting".
      if (r.status === 404 && flow.stepIdx < 0 && Date.now() - flow.startedAt < 90000) { $('add-msg').innerHTML = '<div class="muted">Starting…</div>'; return r; }
      if (r.status === 404) { failFlow('The pool lost track of this signup. Check the accounts table, then try again.'); return r; }
      $('add-msg').innerHTML = '<div class="muted">' + esc(errText(r.data, r.status)) + ' Still trying…</div>';
      return r;
    }
    // Steps come from tlpool as it reports them; an unknown or missing step keeps the last one.
    let idx = ch.step ? stepIndex(ch.step) : -1;
    if (idx < 0) idx = flow.stepIdx;
    if (idx !== flow.stepIdx) { flow.stepIdx = idx; flow.lastChange = Date.now(); }
    if (ch.state === 'failed') { failFlow('The signup failed' + (ch.error ? ': ' + ch.error : '.')); return r; }
    if (ch.state === 'expired') { failFlow(errText({ error: 'captcha_expired' })); return r; }
    // Only a challenge tlpool marks ready has a captcha to answer (the form showed one).
    const needCaptcha = ch.state === 'pending' && ch.ready !== false;
    if (needCaptcha) flow.captchaSeen = true;
    renderSteps(idx, false);
    if (needCaptcha && !flow.captchaShown && ch.type) {
      flow.captchaShown = true;
      $('add-captcha').hidden = false;
      flow.widget = mountCaptcha($('add-captcha'), ch, {});
    }
    if (!needCaptcha && flow.captchaShown) { $('add-captcha').hidden = true; }
    if (STEPS[idx] && STEPS[idx][0] === 'done') {
      stopFlow();
      $('add-msg').innerHTML = '<div class="banner ok">Account ' + esc(flow.accountId || '') + ' is ready.</div>';
      load();
      return r;
    }
    $('add-msg').innerHTML = '';
    return r;
  }
  function watchFlow() {
    flow.poller = poller(poll, 2500, {
      onAuth: () => { $('add-msg').innerHTML = '<div class="banner bad">' + esc(SIGN_IN_AGAIN) + '</div>'; },
      onTimeout: () => { $('add-msg').innerHTML = '<div class="banner info">Stopped watching after 15 minutes. The signup carries on in the pool; close and reopen this dialog to look again.</div>'; },
    });
  }

  function exitBody(passive, exit) {
    return exit && exit !== 'auto' ? { passive, exitKind: exit } : { passive };
  }

  async function create() {
    $('add-create').disabled = true;
    $('add-form').hidden = true; $('add-progress').hidden = false; $('add-retry').hidden = true;
    $('add-msg').innerHTML = '<div class="muted">Starting…</div>';
    renderSteps(-1, false);
    const r = await api('/accounts', jsonInit('POST', exitBody($('add-passive').checked, $('add-exit') && $('add-exit').value)));
    if (!r.ok) { flow = { stepIdx: 0 }; failFlow(errText(r.data, r.status)); return; }
    flow = { challengeId: r.data.challengeId, accountId: r.data.accountId, stepIdx: -1, lastChange: Date.now(), startedAt: Date.now(), poller: null, captchaShown: false, captchaSeen: false, active: true };
    poll();
    watchFlow();
  }

  // Closing the dialog stops watching (the signup itself carries on in the
  // pool); reopening resumes watching it.
  $('add-btn').addEventListener('click', () => {
    if (!flow || !flow.active) resetDialog();
    else if (flow.poller && flow.poller.isStopped()) { flow.lastChange = Date.now(); poll(); watchFlow(); }
    dlg.showModal();
  });
  $('add-close').addEventListener('click', () => dlg.close());
  $('add-create').addEventListener('click', create);
  $('add-retry').addEventListener('click', () => { resetDialog(); });
  dlg.addEventListener('close', () => { if (flow && flow.active && flow.poller) flow.poller.stop(); load(); });
})();
`

export const POOL_PAGE_HTML = shell({
  nav: 'pool',
  title: 'Pool accounts',
  actions: '<button id="add-btn" type="button" class="btn primary">+ Add account</button>',
  body: BODY,
  css: POOL_CSS,
  js: JS,
  ownNavCount: true,
})
