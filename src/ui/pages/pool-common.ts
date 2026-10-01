// Shared pieces of the four pool pages: their CSS, the helper script every
// page shares (COMMON_JS) and the captcha widget (CAPTCHA_JS).

/** Page CSS for the pool pages. Colours come from the tokens; layout from the shell. */
export const POOL_CSS = /* css */ `
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
  .spacer { flex: 1; }
  .mono { font-family: var(--mono); }
  .btn.small { padding: 5px 10px; font-size: var(--fs-sm); min-height: 2rem; }
  .btn:disabled { cursor: progress; }
  .tk-card input:not([type=checkbox]):not([type=radio]), .tk-card select, dialog input:not([type=checkbox]):not([type=radio]), dialog select { font: inherit; color: var(--fg); background: var(--page); border: 1px solid var(--line-strong); border-radius: var(--r-ctl); padding: 6px 8px; }
  .tk-card input:focus, .tk-card select:focus, dialog select:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  .stat-note { font-size: var(--fs-xs); margin: var(--sp-4) 0 0; }
  .sub { font-size: var(--fs-sm); }
  #stats .tk-tile { cursor: default; }
  #prio .chips { margin-bottom: 0; }
  #prio .chip { cursor: default; }
  #prio .chip b { color: var(--fg); }
  .badge { text-transform: none; }
  ul.plain { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--sp-2); }
  ul.plain li { border: 1px solid var(--line); border-radius: var(--r-card); background: var(--card); padding: var(--sp-3) var(--sp-4); }
  ul.plain li a.open { display: block; text-decoration: none; color: inherit; }
  ul.plain li a.open .go { margin-top: var(--sp-2); color: var(--accent); font-weight: 600; }
  .pool-h2 { margin: var(--sp-5) 0 var(--sp-3); }
  .tk-table td.num { white-space: nowrap; }
  @media (min-width: 700px) { .tk-table td.acts-cell { white-space: nowrap; } .tk-table td.acts-cell .acts { flex-wrap: nowrap; } }
  .tk-table td:not([data-label])::before { content: none; }
  .acts { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
  .confirm { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); }
  @media (max-width: 700px) {
    .tk-table td.acts-cell { justify-content: flex-start; text-align: left; }
  }
  @media (min-width: 800px) { dialog#add-dlg { width: min(34rem, calc(100% - 2rem)); } }
  .switch { display: flex; align-items: flex-start; gap: var(--sp-3); padding: var(--sp-3); border: 1px solid var(--line-strong); border-radius: var(--r-tile); cursor: pointer; }
  .switch input { width: 1.5rem; height: 1.5rem; margin: 2px 0 0; flex-shrink: 0; }
  #add-form .field { margin: var(--sp-3) 0; }
  #add-captcha { margin-top: var(--sp-3); }
  ol.steps { list-style: none; margin: var(--sp-3) 0; padding: 0; }
  ol.steps li { display: flex; gap: var(--sp-3); align-items: center; padding: var(--sp-1) 0; color: var(--muted); }
  ol.steps li .dot { width: 1.3rem; text-align: center; }
  ol.steps li.done { color: var(--fg); }
  ol.steps li.done .dot { color: var(--ok); }
  ol.steps li.cur { color: var(--fg); font-weight: 600; }
  ol.steps li.fail { color: var(--danger); font-weight: 600; }
  ol.steps li.skip { color: var(--muted); font-style: italic; }
  /* Captcha widget: big touch targets, a phone is the main client. */
  .cap-img { display: block; width: 100%; max-width: 100%; min-height: 4rem; border: 1px solid var(--line-strong); border-radius: var(--r-tile); background: #fff; image-rendering: auto; }
  .cap-form { display: flex; flex-direction: column; gap: var(--sp-3); margin-top: var(--sp-3); }
  .cap-form input:not([type=checkbox]):not([type=radio]), .tk-card .cap-form input:not([type=checkbox]):not([type=radio]), dialog .cap-form input:not([type=checkbox]):not([type=radio]) { font: inherit; color: var(--fg); background: var(--page); border: 1px solid var(--line-strong); border-radius: var(--r-ctl); font-size: 1.6rem; padding: 0.7rem 0.8rem; min-height: 3.4rem; width: 100%; letter-spacing: 0.08em; text-align: center; }
  .cap-form input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  .cap-form .btn { font-size: 1.15rem; min-height: 3.2rem; }
  .cap-tools { display: flex; gap: var(--sp-2); margin-top: var(--sp-2); }
  .cap-live { margin-top: var(--sp-1); }
  .cap-tools .btn { flex: 1; min-height: 2.5rem; }
  .cap-msg { min-height: 1.4em; margin-top: var(--sp-3); font-weight: 600; }
  .cap-msg.ok { color: var(--ok); }
  .cap-msg.bad { color: var(--danger); }
  .cap-live { width: 100%; height: min(42dvh, 520px); min-height: 280px; border: 1px solid var(--line-strong); border-radius: var(--r-tile); background: #000; }
  .left { font-variant-numeric: tabular-nums; }
  .left.soon { color: var(--danger); font-weight: 700; }
  .banner { border-radius: var(--r-tile); padding: var(--sp-3) var(--sp-4); margin: var(--sp-3) 0; font-weight: 600; }
  .banner.ok { background: var(--ok-bg); color: var(--ok); border: 1px solid var(--ok); }
  .banner.bad { background: var(--danger-bg); color: var(--danger); border: 1px solid var(--danger); }
  .banner.info { background: var(--info-bg); color: var(--info); border: 1px solid var(--info); }
  #head, #state, #widget { margin-bottom: var(--sp-3); }
  #head:empty { display: none; }
  .tk-card .field { margin-bottom: var(--sp-3); }
  .tk-card .field input[type=number]:not([type=checkbox]):not([type=radio]) { width: 7rem; }
  .tk-card .field .row input { width: 5.5rem; }
  .tk-card h2 { margin-top: 0; }
  .tk-card h2.next { margin-top: var(--sp-4); }
  table.sched { border-collapse: collapse; font-size: var(--fs-sm); width: 100%; }
  table.sched td, table.sched th { padding: 6px 6px; border-bottom: 1px solid var(--line); text-align: left; }
  table.sched th { color: var(--muted); font-size: var(--fs-xs); font-weight: 600; }
  table.sched input { width: 5.5rem; }
  .prio { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1) var(--sp-2); padding: 6px 0; border-bottom: 1px solid var(--line); }
  .prio .n { color: var(--muted); }
  .prio .name { font-weight: 600; }
  .prio .muted { flex: 1 1 12rem; font-size: var(--fs-sm); }
  .prio .btn { margin-left: auto; }
  .prio .btn + .btn { margin-left: 0; }
`

/** Shared helpers for every pool page. */
export const COMMON_JS = /* js */ `
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  async function api(path, init) {
    let r;
    try { r = await fetch('/ui/api/pool' + path, { credentials: 'same-origin', ...(init || {}) }); }
    catch (e) { return { ok: false, status: 0, data: { error: 'network' } }; }
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  }
  const jsonInit = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  // Every polling loop on these pages goes through poller(): it pauses while
  // the tab is hidden (and runs once when it comes back), backs off on errors
  // (doubling, up to a minute), stops for good on 401/403 (the Access login
  // expired: hooks.onAuth), and stops after 15 minutes whatever happens
  // (hooks.onTimeout). fn returns { status } (the api() result is fine).
  const POLL_HARD_STOP_MS = 15 * 60000;
  function poller(fn, everyMs, hooks) {
    hooks = hooks || {};
    const started = Date.now();
    let stopped = false, timer = null, running = false, fails = 0;
    function stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; }
    function later(ms) { if (!stopped) timer = setTimeout(run, ms); }
    async function run() {
      timer = null;
      if (stopped || running) return;
      if (Date.now() - started > POLL_HARD_STOP_MS) { stop(); if (hooks.onTimeout) hooks.onTimeout(); return; }
      if (document.hidden) return; // resumed by visibilitychange
      running = true;
      let status = 200;
      try { const r = await fn(); if (r && typeof r.status === 'number') status = r.status; } catch (e) { status = 0; }
      running = false;
      if (stopped) return;
      if (status === 401 || status === 403) { stop(); if (hooks.onAuth) hooks.onAuth(); return; }
      if (status === 0 || status >= 500) fails++; else fails = 0;
      later(fails ? Math.min(everyMs * Math.pow(2, fails), 60000) : everyMs);
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !stopped && !timer && !running) run(); });
    later(everyMs);
    return { stop, isStopped: () => stopped, now: () => { if (stopped) return; if (timer) clearTimeout(timer); timer = null; run(); } };
  }
  const SIGN_IN_AGAIN = 'Your Cloudflare Access login has expired. Reload the page to sign in again.';
  const STOPPED_15 = 'Stopped checking after 15 minutes. Reload the page to check again.';
  const ERRORS = {
    network: 'Your phone could not reach the tracked site. Check the connection and try again.',
    unauthorized: 'Your Cloudflare Access login has expired. Reload the page to sign in again.',
    forbidden: 'This Cloudflare Access login is not allowed here.',
    pool_not_configured: 'The pool service is not set up on the Worker yet (TLPOOL_URL and TLPOOL_TOKEN are missing).',
    pool_unreachable: 'The pool service on the NAS did not answer. Is tlpool running and the tunnel up?',
    pool_auth_failed: 'The pool service refused the Worker\\'s token. The two tokens do not match.',
    pool_error: 'The pool service hit an error on its side.',
    bad_response: 'The pool service answered something this page does not understand.',
    not_found: 'Not found. It may have been closed or finished already.',
    conflict: 'The pool is already busy doing that.',
    expired: 'This has expired.',
    invalid: 'That was not accepted.',
    too_many: 'Too many at once. Wait a moment and try again.',
    internal: 'Something went wrong in the Worker.',
    no_free_exit: 'There is no free exit of that type to pin a new account to. Pick another exit type, or free one up.',
    email_timeout: 'The confirmation email never arrived.',
    signup_rejected: '1001tracklists refused the signup form.',
    login_failed: 'The new account could not log in.',
    captcha_expired: 'Nobody answered the captcha in time.',
    username_taken: 'The generated username was taken.',
    no_exit_available: 'There is no free exit IP to pin a new account to.',
    no_mail_domain: 'No mail domain is set up for confirmation emails.',
    not_ready: 'There is nothing to answer yet. The captcha has not appeared.',
    challenge_closed: 'This challenge is already closed.',
    json_required: 'The page sent a request the Worker refuses. Reload the page.',
    cross_origin: 'The Worker refused a request from another site.',
  };
  function errText(d, status) {
    const code = d && d.error;
    // tlpool's own code (detail) says more than our status-level one when we know it.
    const known = d && d.detail && ERRORS[d.detail];
    const base = known || ERRORS[code] || (code ? 'Error: ' + String(code).replace(/_/g, ' ') + '.' : 'Unexpected answer (HTTP ' + status + ').');
    const det = d && d.detail && !known ? ' (' + String(d.detail).replace(/_/g, ' ') + ')' : '';
    const msg = d && d.message ? ' ' + String(d.message) : '';
    return base + det + msg;
  }
  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function fmtDur(ms) {
    const m = Math.max(0, Math.round(ms / 60000));
    if (m < 60) return m + ' min';
    const h = Math.floor(m / 60);
    if (h < 48) return h + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
    return Math.round(h / 24) + ' d';
  }
  const ago = (iso) => iso ? fmtDur(Date.now() - Date.parse(iso)) + ' ago' : '—';
  function leftText(expiresAt) {
    if (!expiresAt) return { text: 'no expiry known', soon: false };
    const ms = Date.parse(expiresAt) - Date.now();
    if (ms <= 0) return { text: 'expired', soon: true };
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return { text: (h ? h + ' h ' : '') + (h || m ? m + ' min' : sec + ' s') + ' left', soon: ms < 10 * 60000 };
  }
  const REASONS = {
    signup: 'Creating a new account', login: 'Logging in', fetch: 'While fetching a page', retest: 'Retesting a flagged account', verify: 'While fetching a page',
  };
  const reasonText = (r) => r ? (REASONS[r] || String(r).replace(/_/g, ' ')) : 'The site asked for a human check';
  const typeText = (t) => t === 'checkbox' ? 'checkbox (live view)' : 'image captcha';
`

/**
 * The captcha widget, used by the captcha page and by the Add-account dialog.
 * mountCaptcha(root, challenge, { onOutcome }) renders either the image +
 * answer box, or the live view for the checkbox wall.
 */
export const CAPTCHA_JS = /* js */ `
  function mountCaptcha(root, ch, hooks) {
    hooks = hooks || {};
    const base = '/ui/api/pool/challenges/' + encodeURIComponent(ch.id);
    if (ch.type === 'checkbox') {
      // tlpool's live page takes only ?path= (the websocket path under our proxy).
      const livePath = base.slice(1) + '/live/websockify';
      const src = base + '/live/?path=' + encodeURIComponent(livePath);
      root.innerHTML =
        '<p><b>Tap the checkbox</b> in the view below. It is the real browser on the NAS. This page checks every few seconds; if it has not noticed, press <b>Done, I clicked it</b>.</p>' +
        '<iframe class="cap-live" data-r="live" title="Live view of the pool browser" src="' + esc(src) + '" allow="clipboard-read; clipboard-write"></iframe>' +
        '<div class="cap-form"><button type="button" class="btn primary" data-r="done">Done, I clicked it</button></div>' +
        '<div class="cap-tools"><a class="btn" href="' + esc(src) + '" target="_blank" rel="noopener">Open the live view full screen ↗</a><button type="button" class="btn" data-r="reload">↻ Reload the view</button></div>' +
        '<div class="cap-msg" data-r="msg"></div>';
      const msg = root.querySelector('[data-r=msg]'), doneBtn = root.querySelector('[data-r=done]'), live = root.querySelector('[data-r=live]');
      const setMsg = (t, cls) => { msg.textContent = t; msg.className = 'cap-msg ' + (cls || ''); };
      let finished = false;
      const disable = () => { finished = true; doneBtn.disabled = true; };
      root.querySelector('[data-r=reload]').addEventListener('click', () => { live.src = src + '&r=' + Date.now(); });
      doneBtn.addEventListener('click', async () => {
        if (finished) return;
        doneBtn.disabled = true; doneBtn.textContent = 'Checking…'; setMsg('');
        const r = await api('/challenges/' + encodeURIComponent(ch.id) + '/answer', jsonInit('POST', { done: true }));
        doneBtn.disabled = false; doneBtn.textContent = 'Done, I clicked it';
        if (!r.ok) { setMsg(r.status === 401 || r.status === 403 ? SIGN_IN_AGAIN : errText(r.data, r.status), 'bad'); return; }
        const o = r.data.outcome;
        if (o === 'solved') { disable(); setMsg('✓ Through. The pool browser carries on.', 'ok'); }
        else if (o === 'pending' || o === 'wrong') setMsg('Not through yet. Click the box again, then press Done.', 'bad');
        else if (o === 'expired') { disable(); setMsg('This challenge has expired.', 'bad'); }
        else setMsg('Sent. Checking whether it passed…', '');
        if (hooks.onOutcome) hooks.onOutcome(o);
      });
      return { setMsg, disable };
    }
    root.innerHTML =
      '<img class="cap-img" data-r="img" alt="Captcha image from the pool browser" />' +
      '<div class="cap-tools"><button type="button" class="btn" data-r="refresh">↻ New screenshot</button></div>' +
      '<form class="cap-form" data-r="form" autocomplete="off">' +
      '<input data-r="text" type="text" autofocus inputmode="text" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" enterkeyhint="send" aria-label="Captcha answer" placeholder="Type what you see" required maxlength="64" />' +
      '<button type="submit" class="btn primary" data-r="submit">Submit answer</button>' +
      '</form>' +
      '<div class="cap-msg" data-r="msg"></div>';
    const img = root.querySelector('[data-r=img]'), form = root.querySelector('[data-r=form]'), input = root.querySelector('[data-r=text]');
    const submit = root.querySelector('[data-r=submit]'), refresh = root.querySelector('[data-r=refresh]'), msg = root.querySelector('[data-r=msg]');
    const setMsg = (t, cls) => { msg.textContent = t; msg.className = 'cap-msg ' + (cls || ''); };
    const load = (fresh) => { img.src = base + '/image?t=' + Date.now() + (fresh ? '&refresh=1' : ''); };
    img.addEventListener('error', () => setMsg('The captcha image could not be loaded. Try a new screenshot.', 'bad'));
    load(false);
    input.focus();
    refresh.addEventListener('click', () => { setMsg(''); load(true); input.focus(); });
    let done = false;
    const disable = () => { done = true; input.disabled = true; submit.disabled = true; refresh.disabled = true; };
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (done) return;
      const text = input.value.trim();
      if (!text) { input.focus(); return; }
      submit.disabled = true; submit.textContent = 'Sending…'; setMsg('');
      const r = await api('/challenges/' + encodeURIComponent(ch.id) + '/answer', jsonInit('POST', { text }));
      submit.disabled = false; submit.textContent = 'Submit answer';
      if (!r.ok) { setMsg(r.status === 401 || r.status === 403 ? SIGN_IN_AGAIN : errText(r.data, r.status), 'bad'); return; }
      const o = r.data.outcome;
      if (o === 'solved') { disable(); setMsg('✓ Solved. The pool browser carries on.', 'ok'); }
      else if (o === 'wrong') { setMsg('✗ Wrong, try again with the new image.', 'bad'); input.value = ''; load(true); input.focus(); }
      else if (o === 'expired') { disable(); setMsg('This challenge has expired.', 'bad'); }
      else { setMsg('Sent. Checking whether it passed…', ''); }
      if (hooks.onOutcome) hooks.onOutcome(o);
    });
    return { setMsg, disable };
  }
`
