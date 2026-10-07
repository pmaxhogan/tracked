/**
 * Shared admin-page UI for the 1001tracklists IP-ban state: the banner (the
 * shell puts it on every page), the client JS that drives it and the Settings
 * page's alerts and history panels, and the service worker that turns a Web
 * Push into a Notification. The styles live in the shell CSS (src/ui/base.ts).
 *
 * Everything is inline (no bundler, no static assets — same as the pages
 * themselves). The shell interpolates these constants; `BAN_JS` reads
 * `document.body.dataset.banPage` to know what to do:
 *   main      history + auto-prompt (no page emits it since Home replaced the old main page; kept for the tests)
 *   settings  route, devices and episode history (live status)
 *   home      auto-prompt for notifications once per session
 *   other     banner only (the default, and the pool pages' stub DOM)
 * BAN_JS runs in the pool tests' stub DOM too (no body, window, navigator,
 * classList), so those accesses are guarded.
 */

export const UNBLOCK_URL = 'https://www.1001tracklists.com/info/unblock_ip.html'

export const BAN_BANNER_HTML = /* html */ `
  <div id="ban-banner" class="ban-alert" role="alert" hidden>
    <div class="ban-head">
      <div class="ban-icon" id="ban-icon">🚫</div>
      <div class="ban-text">
        <div class="ban-title" id="ban-title">1001tracklists is blocking the tracked sessions</div>
        <div class="ban-sub" id="ban-sub"></div>
      </div>
    </div>
    <div class="ban-actions">
      <a id="ban-captcha" class="ban-btn primary" href="${UNBLOCK_URL}" target="_blank" rel="noopener noreferrer" data-tip="Opens the 1001tracklists unblock form in a new tab.">Open the captcha ↗</a>
      <button id="ban-enable" class="ban-btn" type="button" hidden data-tip="Asks this browser for permission to push ban and captcha alerts to this device.">Enable notifications</button>
      <button id="ban-dismiss" class="ban-btn subtle" type="button" hidden data-tip="Hides this banner. It does not lift a fetching pause or change the ban record.">Dismiss</button>
    </div>
    <div class="ban-foot" id="ban-foot"></div>
  </div>`

export const BAN_JS = /* js */ `
(() => {
  const page = (document.body && document.body.dataset && document.body.dataset.banPage) || 'other';
  // history: route, devices and episodes, live status. prompts: auto-prompt for notifications once per session.
  const history = page === 'main' || page === 'settings';
  const prompts = page === 'main' || page === 'home';
  const $ = (id) => document.getElementById(id);
  const $banner = $('ban-banner'), $title = $('ban-title'), $sub = $('ban-sub'), $foot = $('ban-foot'), $icon = $('ban-icon');
  const $enable = $('ban-enable'), $dismiss = $('ban-dismiss');
  const $aState = $('alerts-state'), $aEnable = $('alerts-enable'), $aTest = $('alerts-test'), $aMsg = $('alerts-msg');
  const $route = $('ban-route'), $devices = $('ban-devices'), $eps = $('ban-episodes'), $refresh = $('ban-refresh'), $simulate = $('ban-simulate');
  const UNBLOCK_URL = ${JSON.stringify(UNBLOCK_URL)};

  const api = (path, init) => fetch('/ui' + path, { credentials: 'same-origin', ...(init || {}) });
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmtTime = (iso) => { if (!iso) return '—'; const d = new Date(iso); const sameDay = d.toDateString() === new Date().toDateString(); return sameDay ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  const fmtDur = (ms) => { if (ms == null) return '—'; const m = Math.round(ms / 60000); if (m < 60) return m + ' min'; const h = Math.floor(m / 60); return h + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : ''); };
  const ago = (iso) => fmtDur(Date.now() - Date.parse(iso)) + ' ago';

  // ── banner ──────────────────────────────────────────────────────────────
  let lastStatus = null;
  function renderBanner(s) {
    if (!$banner) return;
    const home = s.home;
    // A dismissed pause keeps fetching paused (only the operator lifts it) but no longer shows the banner.
    const pause = s.pause && !s.pauseDismissed ? s.pause : null;
    if (!home && !pause) { $banner.hidden = true; return; }
    const simulated = !!(home && home.simulated);
    if ($banner.classList) {
      $banner.classList.toggle('paused', !!pause);
      $banner.classList.toggle('simulated', simulated);
    } else {
      $banner.className = 'ban-alert' + (pause ? ' paused' : '') + (simulated ? ' simulated' : '');
    }
    const ip = home && home.ip ? ' <code>' + esc(home.ip) + '</code>' : '';
    if (pause) {
      $icon.textContent = '⛔';
      $title.innerHTML = '1001tracklists is blocking every tracked account — fetching is paused' + (simulated ? '<span class="ban-badge">simulated</span>' : '');
      $sub.innerHTML = 'Nothing is fetched from 1001tracklists until <b>' + esc(fmtTime(pause.until)) + '</b> (' + esc(pause.reason) + '). The pool (tlpool) owns accounts, budgets and captchas; this switch stops the Worker from asking it at all. The operator lifts it (Dismiss only hides this banner).';
    } else {
      $icon.textContent = '🚫';
      $title.innerHTML = '1001tracklists is blocking the tracked sessions' + (ip ? ' (last shown IP' + ip + ')' : '') + (simulated ? '<span class="ban-badge">simulated</span>' : '');
      $sub.innerHTML = 'Opened ' + esc(fmtTime(home.since)) + ' (' + esc(ago(home.since)) + '). Account health, captchas and budgets live in the pool now; dismiss this once it is handled.';
    }
    $dismiss.hidden = false;
    $dismiss.textContent = simulated ? 'Dismiss simulated ban' : 'Dismiss';
    $banner.hidden = false;
  }

  let lastHttp = 200;
  async function refresh(live) {
    try {
      const r = await api('/api/ban/status' + (live ? '?live=1' : ''));
      lastHttp = r.status;
      if (!r.ok) return null;
      const s = await r.json();
      lastStatus = s;
      renderBanner(s);
      if (history) { renderRoute(s); renderEpisodes(s); renderDevices(s); }
      return s;
    } catch { lastHttp = 0; return null; }
  }

  if ($dismiss) $dismiss.addEventListener('click', async () => {
    $dismiss.disabled = true;
    try { await api('/api/ban/clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); await refresh(history); } finally { $dismiss.disabled = false; }
  });

  // ── Web Push ────────────────────────────────────────────────────────────
  const pushSupported = typeof navigator !== 'undefined' && typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;
  let pushConfig = null; // { configured, publicKey }
  let regPromise = null;

  function b64ToBytes(b64) { const pad = '='.repeat((4 - (b64.length % 4)) % 4); const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/')); const out = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i); return out; }
  async function getConfig() { if (pushConfig) return pushConfig; const r = await api('/api/push/config'); pushConfig = r.ok ? await r.json() : { configured: false }; return pushConfig; }
  // Before the /ui move the worker lived at /subscriptions/sw.js. Its registrations are
  // listed first and only dropped (dropOldRegistrations) once the /ui/ subscription is on
  // the server, so a failed re-subscribe leaves the old one delivering.
  async function oldRegistrations() {
    if (!navigator.serviceWorker.getRegistrations) return [];
    try { return (await navigator.serviceWorker.getRegistrations()).filter((reg) => /\\/subscriptions\\/$/.test((reg && reg.scope) || '')); } catch { return []; }
  }
  async function dropOldRegistrations(olds) {
    for (const reg of olds) {
      try {
        const old = reg.pushManager && (await reg.pushManager.getSubscription());
        if (old) {
          await api('/api/push/unsubscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ endpoint: old.endpoint }) }).catch(() => {});
          await old.unsubscribe().catch(() => {});
        }
      } catch {}
      await reg.unregister().catch(() => {});
    }
  }
  // pushManager.subscribe rejects until the registration has an active worker, and
  // register() resolves while the worker is still installing. Wait on the worker's own
  // statechange: navigator.serviceWorker.ready never resolves on /ui (outside scope /ui/).
  function whenActive(reg) {
    if (reg.active) return Promise.resolve(reg);
    const w = reg.installing || reg.waiting;
    if (!w || typeof w.addEventListener !== 'function') return Promise.resolve(reg); // let subscribe report it
    return new Promise((resolve, reject) => {
      // A worker stuck in 'installing' must not stall Enable forever (kept under the 15 s banner poll).
      const timer = setTimeout(() => { done(); reject(new Error('the notification service worker did not activate in time')); }, 10000);
      const done = () => { clearTimeout(timer); if (typeof w.removeEventListener === 'function') w.removeEventListener('statechange', check); };
      const check = () => {
        if (w.state === 'activated') { done(); resolve(reg); }
        else if (w.state === 'redundant') { done(); reject(new Error('the notification service worker failed to install')); }
      };
      w.addEventListener('statechange', check);
      check();
    });
  }
  function getReg() {
    if (!regPromise) {
      regPromise = navigator.serviceWorker.register('/ui/sw.js', { scope: '/ui/' }).then(whenActive);
      regPromise.catch(() => { regPromise = null; }); // a failed install is retried on the next call
    }
    return regPromise;
  }

  function setAlertsUI(state, msg) {
    if ($aState) { $aState.textContent = state.text; $aState.className = 'alerts-state ' + state.cls; }
    if ($aEnable) $aEnable.hidden = !state.showEnable;
    if ($enable) $enable.hidden = !state.showEnable;
    if ($aMsg && msg !== undefined) $aMsg.textContent = msg || '';
  }

  async function pushState() {
    if (!pushSupported) return { text: 'not supported in this browser', cls: 'off', showEnable: false };
    const cfg = await getConfig();
    if (!cfg.configured) return { text: 'server has no VAPID keys', cls: 'err', showEnable: false };
    const perm = Notification.permission;
    if (perm === 'denied') return { text: 'blocked in browser settings', cls: 'err', showEnable: false };
    if (perm === 'default') return { text: 'off', cls: 'off', showEnable: true };
    const reg = await getReg();
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return { text: 'permission granted, not subscribed', cls: 'off', showEnable: true };
    return { text: 'on (this device)', cls: 'on', showEnable: false, sub };
  }

  async function sendSubscription(sub) {
    const r = await api('/api/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON(), ua: navigator.userAgent }) });
    if (!r.ok) throw new Error('subscribe failed (' + r.status + ')');
  }

  async function enablePush() {
    if (!pushSupported) return;
    const cfg = await getConfig();
    if (!cfg.configured) { setAlertsUI(await pushState(), 'Set VAPID_* secrets on the Worker first.'); return; }
    // Already granted (the recovery in syncPush below): no prompt, so no request.
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (perm !== 'granted') { setAlertsUI(await pushState(), perm === 'denied' ? 'Permission denied — allow notifications for this site in the browser.' : ''); return; }
    const reg = await getReg();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(cfg.publicKey) });
    await sendSubscription(sub);
    setAlertsUI(await pushState(), 'Subscribed. Press "Send test notification" to check delivery.');
    if (history) refresh(true);
    return sub;
  }

  // The re-POST resets the device's failure state in KV, so it runs once per browser session.
  function pushSynced() { try { return typeof sessionStorage !== 'undefined' && sessionStorage.getItem('ban-push-synced') === '1'; } catch (e) { return false; } }
  function markPushSynced() { try { if (typeof sessionStorage !== 'undefined') sessionStorage.setItem('ban-push-synced', '1'); } catch (e) {} }

  async function syncPush() {
    try {
      const olds = pushSupported ? await oldRegistrations() : [];
      const st = await pushState();
      let sub = st.sub || null;
      if (!sub && st.showEnable && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        // Granted but no /ui/ subscription: the /subscriptions/ worker's migration, or a
        // subscription lost some other way (the UI has no off switch). Re-subscribe without a prompt.
        sub = await enablePush();
      } else {
        setAlertsUI(st);
        if (sub && !pushSynced()) { await sendSubscription(sub); markPushSynced(); } // keep the server copy fresh (endpoint rotation), once per session
        // Auto-prompt (main and home pages): first visit asks right away.
        if (prompts && st.showEnable && Notification.permission === 'default' && !sessionStorage.getItem('ban-push-prompted')) {
          sessionStorage.setItem('ban-push-prompted', '1');
          sub = await enablePush();
        }
      }
      // The /ui/ subscription is on the server: only now drop the old worker and its subscription.
      if (sub && olds.length) await dropOldRegistrations(olds);
    } catch (e) { setAlertsUI({ text: 'error', cls: 'err', showEnable: true }, (e && e.message) || String(e)); }
  }

  for (const btn of [$aEnable, $enable]) if (btn) btn.addEventListener('click', () => { enablePush().catch((e) => setAlertsUI({ text: 'error', cls: 'err', showEnable: true }, (e && e.message) || String(e))); });
  if ($aTest) $aTest.addEventListener('click', async () => {
    $aTest.disabled = true; if ($aMsg) $aMsg.textContent = 'sending…';
    try {
      const r = await api('/api/push/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { if ($aMsg) $aMsg.textContent = 'test failed: ' + (d.error || r.status); return; }
      if ($aMsg) $aMsg.textContent = d.total === 0 ? 'no devices subscribed yet' : 'sent to ' + d.sent + '/' + d.total + ' device' + (d.total === 1 ? '' : 's') + (d.removed ? ' (' + d.removed + ' stale removed)' : '') + (d.failed ? ' (' + d.failed + ' failed)' : '');
      if (history) refresh(true);
    } catch (e) { if ($aMsg) $aMsg.textContent = 'test failed: ' + ((e && e.message) || e); }
    finally { $aTest.disabled = false; }
  });

  // ── main page: live route + history ─────────────────────────────────────
  function renderRoute(s) {
    if (!$route) return;
    const parts = [];
    parts.push(s.poolConfigured ? 'Route: <span class="ok">tlpool</span> (the NAS browser pool).' : '<span class="bad">tlpool not configured</span> (TLPOOL_URL / TLPOOL_TOKEN): nothing can be fetched from 1001tracklists.');
    if (s.pause) parts.push('<span class="bad">Paused</span> until ' + esc(fmtTime(s.pause.until)) + ' (' + esc(s.pause.reason) + ').');
    $route.innerHTML = parts.join(' ');
  }

  function renderDevices(s) {
    if (!$devices) return;
    const subs = s.pushSubscriptions || [];
    if (!s.pushConfigured) { $devices.hidden = false; $devices.innerHTML = '<span class="bad">Web Push not configured</span> — set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT (node scripts/gen-vapid-keys.mjs).'; return; }
    if (!subs.length) { $devices.hidden = false; $devices.innerHTML = 'Push devices: <span class="muted">none yet — enable notifications on your phone and desktop.</span>'; return; }
    const uaShort = (ua) => { if (!ua) return 'unknown device'; const m = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'device'; const b = /Edg\\//.test(ua) ? 'Edge' : /Chrome\\//.test(ua) ? 'Chrome' : /Firefox\\//.test(ua) ? 'Firefox' : /Safari\\//.test(ua) ? 'Safari' : ''; return (b ? b + ' on ' : '') + m; };
    $devices.hidden = false;
    $devices.innerHTML = 'Push devices (' + subs.length + '): ' + subs.map((d) => '<span data-tip="' + esc(d.ua || 'Unknown browser') + '">' + esc(uaShort(d.ua)) + '</span>' + (d.lastError ? ' <span class="bad" data-tip="' + esc('Last delivery failed: ' + d.lastError) + '">⚠</span>' : d.lastOkAt ? ' <span class="ok" data-tip="' + esc('Last delivered ' + fmtTime(d.lastOkAt)) + '">✓</span>' : '')).join(' · ');
  }

  function renderEpisodes(s) {
    if (!$eps) return;
    const eps = s.episodes || [];
    if (!eps.length) { $eps.innerHTML = '<div class="empty">No ban episodes recorded.</div>'; return; }
    const rows = eps.map((e) => {
      const open = !e.endedAt;
      const dur = open ? fmtDur(Date.now() - Date.parse(e.startedAt)) + '…' : fmtDur(e.blockedForMs);
      const push = (e.pushStart ? e.pushStart.sent + '/' + e.pushStart.total : '—') + (e.pushClear ? ' · ' + e.pushClear.sent + '/' + e.pushClear.total : '');
      return '<tr>' +
        '<td data-label="Started"' + (open ? ' class="open"' : '') + '>' + esc(fmtTime(e.startedAt)) + (open ? ' <b>(open)</b>' : '') + (e.simulated ? ' <span class="muted">sim</span>' : '') + '</td>' +
        '<td data-label="Lasted">' + esc(dur) + '</td>' +
        '<td data-label="IP" class="mono">' + esc(e.ip || '—') + '</td>' +
        '<td data-label="Seen by / cleared">' + esc(e.source) + (e.clearedBy ? ' → ' + esc(e.clearedBy) : '') + '</td>' +
        '<td data-label="Pool / BrightData req">' + e.poolRequests + ' / ' + e.brightdataRequests + (e.allBlockedHits ? ' <span class="bad" data-tip="Times every route was blocked during this episode.">' + e.allBlockedHits + '⛔</span>' : '') + '</td>' +
        '<td data-label="Push start · clear" class="muted">' + esc(push) + '</td>' +
        '</tr>';
    }).join('');
    $eps.innerHTML = '<table class="ban-eps"><thead><tr><th>Started</th><th>Lasted</th><th><span class="tip-term" data-tip="The address 1001tracklists blocked, when it was known.">IP</span></th><th><span class="tip-term" data-tip="What noticed the block, and what cleared it.">Seen by / cleared</span></th><th><span class="tip-term" data-tip="Requests sent through the browser pool and through BrightData during the episode.">Pool / BrightData req</span></th><th><span class="tip-term" data-tip="Push notifications delivered when the ban started, and when it ended (sent out of devices).">Push start · clear</span></th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  if ($refresh) $refresh.addEventListener('click', () => refresh(true));
  if ($simulate) $simulate.addEventListener('click', async (ev) => {
    ev.preventDefault();
    if (lastStatus && (lastStatus.home || lastStatus.pause)) { alert('A ban is already active.'); return; }
    await api('/api/ban/simulate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await refresh(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // ── boot ────────────────────────────────────────────────────────────────
  refresh(history);
  syncPush();
  // Status poll: every 15 s while the tab is visible, doubling (to 60 s) on
  // errors, stopped on 401/403 (Access login expired) and after 15 minutes.
  const POLL_STARTED = Date.now();
  let pollTimer = null, pollStopped = false, pollFails = 0, polling = false;
  function stopPoll(note) { pollStopped = true; if (pollTimer) clearTimeout(pollTimer); pollTimer = null; if (note && $aMsg) $aMsg.textContent = note; }
  async function pollOnce() {
    pollTimer = null;
    if (pollStopped || polling) return;
    if (Date.now() - POLL_STARTED > 15 * 60000) { stopPoll(history ? 'Status refresh stopped after 15 minutes. Reload the page to check again.' : ''); return; }
    if (document.hidden) return;
    polling = true;
    await refresh(history);
    polling = false;
    if (lastHttp === 401 || lastHttp === 403) { stopPoll('Your Cloudflare Access login has expired. Reload the page to sign in again.'); return; }
    pollFails = lastHttp === 0 || lastHttp >= 500 ? pollFails + 1 : 0;
    pollTimer = setTimeout(pollOnce, pollFails ? Math.min(15000 * Math.pow(2, pollFails), 60000) : 15000);
  }
  pollTimer = setTimeout(pollOnce, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !pollStopped && !pollTimer && !polling) pollOnce(); });
})();
`

/** Served at /ui/sw.js. Turns a push into a Notification; tap opens the payload URL. */
export const SW_JS = /* js */ `
const STICKY_KINDS = ['ban_start', 'pool_challenge', 'pool_account', 'playlist_hold'];
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'tracked', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'tracked';
  const options = {
    body: data.body || '',
    tag: data.tag || 'tracked',
    renotify: true,
    // Pushes that need the owner stay on screen until tapped: a ban, a captcha
    // waiting (pool_challenge), a flagged account, a held playlist check.
    requireInteraction: data.requireInteraction === true || STICKY_KINDS.includes(data.kind) || /challenge/.test(data.kind || ''),
    timestamp: data.ts ? Date.parse(data.ts) : Date.now(),
    data: { url: data.url || '/ui/', kind: data.kind || null },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/ui/';
  event.waitUntil((async () => {
    const target = new URL(url, self.location.origin).href;
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if (c.url === target && 'focus' in c) return c.focus(); }
    return self.clients.openWindow(target);
  })());
});
`
