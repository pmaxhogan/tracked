/**
 * Shared admin-page UI for the 1001tracklists IP-ban state: the big red
 * banner (all three admin pages), the alerts row + ban history section
 * (main page only), the client JS that drives them, and the service worker
 * that turns a Web Push into a Notification.
 *
 * Everything is inline (no bundler, no static assets — same as the pages
 * themselves). The pages interpolate these constants; `BAN_JS` reads
 * `document.body.dataset.banPage` to know which optional elements exist.
 */

export const UNBLOCK_URL = 'https://www.1001tracklists.com/info/unblock_ip.html'

export const BAN_CSS = /* css */ `
  /* ── IP-ban banner (lib/ban-state.ts) ── */
  .ban-alert { display: block; margin: 0 0 1.25rem; padding: 0.9rem 1rem 0.8rem; border-radius: 8px; background: #b91c1c; color: #fff; border: 2px solid #ef4444; box-shadow: 0 6px 24px rgba(185, 28, 28, 0.35); }
  .ban-alert[hidden] { display: none !important; }
  .ban-alert.paused { background: #7f1d1d; border-color: #b91c1c; }
  .ban-alert.simulated { border-style: dashed; }
  .ban-alert a { color: #fff; }
  .ban-head { display: flex; align-items: flex-start; gap: 0.7rem; }
  .ban-icon { font-size: 1.6rem; line-height: 1; margin-top: 0.05rem; }
  .ban-title { font-size: 1.15rem; font-weight: 800; letter-spacing: 0.01em; line-height: 1.25; }
  .ban-title .ban-badge { display: inline-block; margin-left: 0.5rem; padding: 0.1rem 0.45rem; font-size: 0.7rem; font-weight: 700; vertical-align: middle; border-radius: 999px; background: rgba(255,255,255,0.22); text-transform: uppercase; }
  .ban-sub { margin-top: 0.3rem; font-size: 0.9rem; line-height: 1.45; opacity: 0.95; }
  .ban-sub code { background: rgba(0,0,0,0.25); padding: 0 0.3rem; border-radius: 3px; font-size: 0.85em; }
  .ban-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.75rem; }
  .ban-btn { display: inline-block; padding: 0.5rem 0.8rem; font: inherit; font-size: 0.9rem; font-weight: 600; border-radius: 6px; border: 1px solid rgba(255,255,255,0.7); background: transparent; color: #fff; cursor: pointer; text-decoration: none; }
  .ban-btn.primary { background: #fff; color: #991b1b; border-color: #fff; }
  .ban-btn.subtle { opacity: 0.8; font-weight: 500; }
  .ban-btn:disabled { opacity: 0.5; cursor: progress; }
  .ban-btn[hidden] { display: none !important; }
  .ban-foot { margin-top: 0.6rem; font-size: 0.78rem; opacity: 0.85; min-height: 1em; }
  /* ── alerts row (main page) ── */
  .alerts-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 0.75rem; margin: -0.75rem 0 1.25rem; font-size: 0.85rem; color: var(--muted); }
  .alerts-row .alerts-label { font-weight: 600; color: var(--fg); }
  .alerts-row .alerts-state.on { color: #16a34a; }
  .alerts-row .alerts-state.off, .alerts-row .alerts-state.err { color: var(--danger); }
  .alerts-row button { padding: 0.25rem 0.55rem; font-size: 0.8rem; }
  .alerts-msg { font-size: 0.8rem; }
  /* ── ban history (main page) ── */
  section#banhist { margin-top: 2.25rem; }
  .ban-route { border: 1px solid var(--border); border-radius: 6px; background: var(--card); padding: 0.6rem 0.8rem; font-size: 0.85rem; line-height: 1.55; margin-bottom: 0.5rem; }
  .ban-route .ok { color: #16a34a; font-weight: 600; }
  .ban-route .bad { color: var(--danger); font-weight: 600; }
  .ban-route .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem; }
  .ban-eps { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  .ban-eps th, .ban-eps td { text-align: left; padding: 0.35rem 0.5rem; border-bottom: 1px solid var(--border); vertical-align: top; }
  .ban-eps th { color: var(--muted); font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.03em; }
  .ban-eps td.open { color: var(--danger); font-weight: 600; }
  .ban-eps .muted { color: var(--muted); }
  .ban-debug { margin-top: 0.6rem; font-size: 0.78rem; color: var(--muted); }
  .ban-debug a { color: var(--muted); }
`

export const BAN_BANNER_HTML = /* html */ `
  <div id="ban-banner" class="ban-alert" role="alert" hidden>
    <div class="ban-head">
      <div class="ban-icon" id="ban-icon">🚫</div>
      <div class="ban-text">
        <div class="ban-title" id="ban-title">1001tracklists has temp-banned your home IP</div>
        <div class="ban-sub" id="ban-sub"></div>
      </div>
    </div>
    <div class="ban-actions">
      <a id="ban-captcha" class="ban-btn primary" href="${UNBLOCK_URL}" target="_blank" rel="noopener noreferrer">Open the captcha ↗</a>
      <button id="ban-probe" class="ban-btn" type="button">I solved it — re-probe now</button>
      <button id="ban-enable" class="ban-btn" type="button" hidden>Enable notifications</button>
      <button id="ban-dismiss" class="ban-btn subtle" type="button" hidden>Dismiss</button>
    </div>
    <div class="ban-foot" id="ban-foot"></div>
  </div>`

/** Main page only: the always-visible notifications control. */
export const ALERTS_ROW_HTML = /* html */ `
  <div id="alerts-row" class="alerts-row">
    <span class="alerts-label">🔔 IP-ban alerts</span>
    <span id="alerts-state" class="alerts-state">checking…</span>
    <button id="alerts-enable" class="ghost" type="button" hidden>Enable on this device</button>
    <button id="alerts-test" class="ghost" type="button">Send test notification</button>
    <span id="alerts-msg" class="alerts-msg"></span>
  </div>`

/** Main page only: live route status + episode history. */
export const BAN_HISTORY_HTML = /* html */ `
  <section id="banhist">
    <div class="audit-head">
      <h2>IP-ban history</h2>
      <div class="audit-actions">
        <button id="ban-refresh" class="ghost" type="button">Refresh</button>
      </div>
    </div>
    <div id="ban-route" class="ban-route"><span class="muted">loading…</span></div>
    <div id="ban-devices" class="ban-route" hidden></div>
    <div id="ban-episodes"></div>
    <div class="ban-debug">Test the whole alert path without a real ban: <a href="#" id="ban-simulate">simulate a ban</a> (banner + push; dismiss from the banner).</div>
  </section>`

export const BAN_JS = /* js */ `
(() => {
  const page = document.body.dataset.banPage || 'other';
  const $ = (id) => document.getElementById(id);
  const $banner = $('ban-banner'), $title = $('ban-title'), $sub = $('ban-sub'), $foot = $('ban-foot'), $icon = $('ban-icon');
  const $probe = $('ban-probe'), $enable = $('ban-enable'), $dismiss = $('ban-dismiss');
  const $aState = $('alerts-state'), $aEnable = $('alerts-enable'), $aTest = $('alerts-test'), $aMsg = $('alerts-msg');
  const $route = $('ban-route'), $devices = $('ban-devices'), $eps = $('ban-episodes'), $refresh = $('ban-refresh'), $simulate = $('ban-simulate');
  const UNBLOCK_URL = ${JSON.stringify(UNBLOCK_URL)};

  const api = (path, init) => fetch('/subscriptions' + path, { credentials: 'same-origin', ...(init || {}) });
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmtTime = (iso) => { if (!iso) return '—'; const d = new Date(iso); const sameDay = d.toDateString() === new Date().toDateString(); return sameDay ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  const fmtDur = (ms) => { if (ms == null) return '—'; const m = Math.round(ms / 60000); if (m < 60) return m + ' min'; const h = Math.floor(m / 60); return h + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : ''); };
  const ago = (iso) => fmtDur(Date.now() - Date.parse(iso)) + ' ago';

  // ── banner ──────────────────────────────────────────────────────────────
  let lastStatus = null;
  function renderBanner(s) {
    if (!$banner) return;
    const home = s.home, pause = s.pause;
    if (!home && !pause) { $banner.hidden = true; return; }
    const simulated = !!(home && home.simulated);
    $banner.classList.toggle('paused', !!pause);
    $banner.classList.toggle('simulated', simulated);
    const ip = home && home.ip ? ' <code>' + esc(home.ip) + '</code>' : '';
    if (pause) {
      $icon.textContent = '⛔';
      $title.innerHTML = 'Every 1001tracklists route is blocked — fetching is paused' + (simulated ? '<span class="ban-badge">simulated</span>' : '');
      $sub.innerHTML = 'Your home IP' + ip + ' and every fallback bucket returned the block page. The sync stops hitting 1001tracklists until <b>' + esc(fmtTime(pause.until)) + '</b>, then tries once more. BrightData used today: <b>' + s.brightdata.used + '/' + s.brightdata.cap + '</b>. Solve the captcha from your home network, then press re-probe to resume immediately.';
    } else {
      $icon.textContent = '🚫';
      $title.innerHTML = '1001tracklists has temp-banned your home IP' + ip + (simulated ? '<span class="ban-badge">simulated</span>' : '');
      const pool = home.poolTotal ? ' Fetches are running through the fallback pool (<b>' + home.poolHealthy + '/' + home.poolTotal + '</b> buckets healthy) so nothing is lost, but the ban only lifts when a human solves the captcha.' : ' No fallback pool is configured, so fetches are failing.';
      const next = home.until ? ' The proxy re-tries your home IP hourly (next around <b>' + esc(fmtTime(home.until)) + '</b>).' : '';
      $sub.innerHTML = 'Blocked since <b>' + esc(fmtTime(home.since)) + '</b> (' + esc(ago(home.since)) + ').' + pool + next + ' <b>Open the captcha from this network</b>, solve it, then press re-probe.';
    }
    $dismiss.hidden = !simulated;
    $dismiss.textContent = simulated ? 'Dismiss simulated ban' : 'Dismiss';
    $banner.hidden = false;
  }

  async function refresh(live) {
    try {
      const r = await api('/api/ban/status' + (live ? '?live=1' : ''));
      if (!r.ok) return null;
      const s = await r.json();
      lastStatus = s;
      renderBanner(s);
      if (page === 'main') { renderRoute(s); renderEpisodes(s); renderDevices(s); }
      return s;
    } catch { return null; }
  }

  if ($probe) $probe.addEventListener('click', async () => {
    $probe.disabled = true; const orig = $probe.textContent; $probe.textContent = 'Probing your home IP…'; $foot.textContent = '';
    try {
      const r = await api('/api/ban/probe', { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { $foot.textContent = 'Probe failed: ' + (d.error || r.status) + (d.message ? ' — ' + d.message : ''); return; }
      if (d.cleared) { $foot.textContent = '✅ Home IP works again — ban cleared.'; }
      else if (d.probe === 'ip_blocked') { $foot.textContent = '❌ Still blocked (' + (d.blockedIp || 'home IP') + '). Did the captcha page confirm the unblock? It must be solved from the same network as the proxy.'; }
      else if (d.probe === 'ok') { $foot.textContent = '✅ Direct route is fine.'; }
      else { $foot.textContent = 'Probe result: ' + (d.probe || 'unknown') + (d.error ? ' — ' + d.error : ''); }
      await refresh(page === 'main');
    } catch (e) { $foot.textContent = 'Probe failed: ' + (e && e.message || e); }
    finally { $probe.disabled = false; $probe.textContent = orig; }
  });

  if ($dismiss) $dismiss.addEventListener('click', async () => {
    $dismiss.disabled = true;
    try { await api('/api/ban/clear', { method: 'POST' }); await refresh(page === 'main'); } finally { $dismiss.disabled = false; }
  });

  // ── Web Push ────────────────────────────────────────────────────────────
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;
  let pushConfig = null; // { configured, publicKey }
  let swReg = null;

  function b64ToBytes(b64) { const pad = '='.repeat((4 - (b64.length % 4)) % 4); const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/')); const out = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i); return out; }
  async function getConfig() { if (pushConfig) return pushConfig; const r = await api('/api/push/config'); pushConfig = r.ok ? await r.json() : { configured: false }; return pushConfig; }
  async function getReg() { if (swReg) return swReg; swReg = await navigator.serviceWorker.register('/subscriptions/sw.js', { scope: '/subscriptions/' }); return swReg; }

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
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { setAlertsUI(await pushState(), perm === 'denied' ? 'Permission denied — allow notifications for this site in the browser.' : ''); return; }
    const reg = await getReg();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(cfg.publicKey) });
    await sendSubscription(sub);
    setAlertsUI(await pushState(), 'Subscribed. Press "Send test notification" to check delivery.');
    if (page === 'main') refresh(true);
  }

  async function syncPush() {
    try {
      const st = await pushState();
      setAlertsUI(st);
      if (st.sub) await sendSubscription(st.sub); // keep the server copy fresh (endpoint rotation)
      // Auto-prompt on the main page: first visit asks right away.
      if (page === 'main' && st.showEnable && Notification.permission === 'default' && !sessionStorage.getItem('ban-push-prompted')) {
        sessionStorage.setItem('ban-push-prompted', '1');
        await enablePush();
      }
    } catch (e) { setAlertsUI({ text: 'error', cls: 'err', showEnable: true }, (e && e.message) || String(e)); }
  }

  for (const btn of [$aEnable, $enable]) if (btn) btn.addEventListener('click', () => { enablePush().catch((e) => setAlertsUI({ text: 'error', cls: 'err', showEnable: true }, (e && e.message) || String(e))); });
  if ($aTest) $aTest.addEventListener('click', async () => {
    $aTest.disabled = true; if ($aMsg) $aMsg.textContent = 'sending…';
    try {
      const r = await api('/api/push/test', { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { if ($aMsg) $aMsg.textContent = 'test failed: ' + (d.error || r.status); return; }
      if ($aMsg) $aMsg.textContent = d.total === 0 ? 'no devices subscribed yet' : 'sent to ' + d.sent + '/' + d.total + ' device' + (d.total === 1 ? '' : 's') + (d.removed ? ' (' + d.removed + ' stale removed)' : '') + (d.failed ? ' (' + d.failed + ' failed)' : '');
      if (page === 'main') refresh(true);
    } catch (e) { if ($aMsg) $aMsg.textContent = 'test failed: ' + ((e && e.message) || e); }
    finally { $aTest.disabled = false; }
  });

  // ── main page: live route + history ─────────────────────────────────────
  function renderRoute(s) {
    if (!$route) return;
    const p = s.proxy;
    const parts = [];
    if (!s.homeProxyConfigured) parts.push('<span class="bad">Home proxy not configured</span> (HOME_PROXY_URL / HOME_PROXY_TOKEN).');
    else if (!p) parts.push('Home proxy: <span class="bad">unreachable</span>' + (s.proxyError ? ' <span class="mono">' + esc(s.proxyError) + '</span>' : '') + '.');
    else {
      parts.push('Home proxy v' + esc(p.version || '?') + ': direct route ' + (p.direct && p.direct.blocked ? '<span class="bad">BLOCKED</span> until ' + esc(fmtTime(p.direct.blockedUntil)) : '<span class="ok">ok</span>') + ', pool <b>' + p.poolHealthy + '/' + p.poolTotal + '</b> healthy' + (p.counters ? ' · served direct ' + p.counters.directOk + ', pool ' + p.counters.poolOk + ', blocked direct ' + p.counters.directBlocked + ' / pool ' + p.counters.poolBlocked + ' since restart' : '') + '.');
      const blockedMembers = (p.pool || []).filter((m) => m.blocked).map((m) => m.label);
      if (blockedMembers.length) parts.push('Blocked buckets: <span class="mono">' + esc(blockedMembers.join(', ')) + '</span>.');
    }
    parts.push('BrightData today: <b>' + s.brightdata.used + '/' + s.brightdata.cap + '</b> calls' + (s.brightdata.used >= s.brightdata.cap ? ' <span class="bad">(budget spent)</span>' : '') + '.');
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
    $devices.innerHTML = 'Push devices (' + subs.length + '): ' + subs.map((d) => '<span title="' + esc(d.ua || '') + '">' + esc(uaShort(d.ua)) + '</span>' + (d.lastError ? ' <span class="bad" title="' + esc(d.lastError) + '">⚠</span>' : d.lastOkAt ? ' <span class="ok" title="last delivered ' + esc(fmtTime(d.lastOkAt)) + '">✓</span>' : '')).join(' · ');
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
        '<td' + (open ? ' class="open"' : '') + '>' + esc(fmtTime(e.startedAt)) + (open ? ' <b>(open)</b>' : '') + (e.simulated ? ' <span class="muted">sim</span>' : '') + '</td>' +
        '<td>' + esc(dur) + '</td>' +
        '<td class="mono">' + esc(e.ip || '—') + '</td>' +
        '<td>' + esc(e.source) + (e.clearedBy ? ' → ' + esc(e.clearedBy) : '') + '</td>' +
        '<td>' + e.poolRequests + ' / ' + e.brightdataRequests + (e.allBlockedHits ? ' <span class="bad" title="times every route was blocked">' + e.allBlockedHits + '⛔</span>' : '') + '</td>' +
        '<td class="muted">' + esc(push) + '</td>' +
        '</tr>';
    }).join('');
    $eps.innerHTML = '<table class="ban-eps"><thead><tr><th>Started</th><th>Lasted</th><th>IP</th><th>Seen by / cleared</th><th>Pool / BrightData req</th><th>Push start · clear</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  if ($refresh) $refresh.addEventListener('click', () => refresh(true));
  if ($simulate) $simulate.addEventListener('click', async (ev) => {
    ev.preventDefault();
    if (lastStatus && (lastStatus.home || lastStatus.pause)) { alert('A ban is already active.'); return; }
    await api('/api/ban/simulate', { method: 'POST' });
    await refresh(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // ── boot ────────────────────────────────────────────────────────────────
  refresh(page === 'main');
  syncPush();
  setInterval(() => refresh(page === 'main'), 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(page === 'main'); });
})();
`

/** Served at /subscriptions/sw.js. Turns a push into a Notification; tap opens the payload URL. */
export const SW_JS = /* js */ `
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
    requireInteraction: data.kind === 'ban_start',
    timestamp: data.ts ? Date.parse(data.ts) : Date.now(),
    data: { url: data.url || '/subscriptions', kind: data.kind || null },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/subscriptions';
  event.waitUntil((async () => {
    const target = new URL(url, self.location.origin).href;
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if (c.url === target && 'focus' in c) return c.focus(); }
    return self.clients.openWindow(target);
  })());
});
`
