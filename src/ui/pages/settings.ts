// Settings: the YouTube connection, this device's notifications, the theme, the
// integrations in use and the ban episodes. BAN_JS (banPage 'settings') fills the
// alerts-*, ban-route, ban-devices and ban-episodes elements by id.
import { shell } from '../shell'
import type { UiPage } from './index'
import { YOUTUBE_CARD_CSS, YOUTUBE_CARD_HTML, YOUTUBE_CARD_JS } from './youtube-card'

const BODY = /* html */ `
${YOUTUBE_CARD_HTML}
<div class="tk-card">
  <h2>Notifications</h2>
  <div id="alerts-row" class="tk-row st-alerts">
    <span class="muted">IP-ban alerts on this device:</span>
    <span id="alerts-state" class="alerts-state">checking…</span>
    <button id="alerts-enable" type="button" class="btn small" hidden>Enable on this device</button>
    <button id="alerts-test" type="button" class="btn small">Send test notification</button>
    <span id="alerts-msg" class="alerts-msg muted" role="status"></span>
  </div>
  <div id="ban-devices" class="ban-route" hidden></div>
</div>
<div class="tk-card">
  <h2>Theme</h2>
  <div class="tk-row st-theme" role="radiogroup" aria-label="Theme">
    <label class="st-opt"><input id="st-theme-system" type="radio" name="st-theme" value="system" /> System</label>
    <label class="st-opt"><input id="st-theme-dark" type="radio" name="st-theme" value="dark" /> Dark</label>
    <label class="st-opt"><input id="st-theme-light" type="radio" name="st-theme" value="light" /> Light</label>
  </div>
</div>
<div class="tk-card">
  <h2>Integrations</h2>
  <ul class="st-list">
    <li><span>tlpool (1001tracklists browser pool)</span><span id="int-pool" class="badge neutral">checking…</span></li>
    <li><span>Web Push (VAPID keys)</span><span id="int-push" class="badge neutral">checking…</span></li>
    <li><span>mkvid token</span><span id="int-mkvid" class="badge neutral">checking…</span></li>
  </ul>
</div>
<div class="tk-card">
  <div class="st-head">
    <h2>Ban episodes</h2>
    <button id="ban-refresh" type="button" class="btn small">Refresh</button>
  </div>
  <div id="ban-route" class="ban-route"><span class="muted">loading…</span></div>
  <div id="ban-episodes"></div>
</div>
`

const CSS = /* css */ `
  .btn.small { padding: 5px 10px; font-size: var(--fs-sm); }
  .st-alerts { font-size: var(--fs-sm); }
  .alerts-state.on { color: var(--ok); font-weight: 600; }
  .alerts-state.off { color: var(--muted); font-weight: 600; }
  .alerts-state.err { color: var(--danger); font-weight: 600; }
  #ban-devices { margin-top: var(--sp-3); margin-bottom: 0; }
  .st-theme { gap: var(--sp-4); }
  .st-opt { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
  .st-list { list-style: none; margin: 0; padding: 0; }
  .st-list li { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); padding: 8px 0; border-bottom: 1px solid var(--line); }
  .st-list li:last-child { border-bottom: 0; }
  .st-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); margin-bottom: var(--sp-3); }
  .st-head h2 { margin: 0; }
  .ban-eps td.open { color: var(--danger); font-weight: 600; }
  .ban-eps .muted { color: var(--muted); }
${YOUTUBE_CARD_CSS}`

const JS = /* js */ `
(() => {
${YOUTUBE_CARD_JS}
  const $ = TK.$;

  // ── theme: radios <-> TK.theme <-> the sidebar select ──
  const radios = ['system', 'dark', 'light'].map((v) => $('st-theme-' + v)).filter(Boolean);
  const $sel = $('tk-theme');
  function syncTheme() {
    const t = TK.theme.get();
    radios.forEach((r) => { r.checked = r.value === t; });
    if ($sel) $sel.value = t;
  }
  radios.forEach((r) => r.addEventListener('change', () => { if (r.checked) { TK.theme.set(r.value); syncTheme(); } }));
  if ($sel) $sel.addEventListener('change', syncTheme);
  syncTheme();

  // ── integrations ──
  function badge(id, on, onText, offText) {
    const el = $(id);
    if (!el) return;
    el.textContent = on === null ? 'unavailable' : on ? onText : offText;
    el.className = 'badge ' + (on === null ? 'neutral' : on ? 'ok' : 'warn');
  }
  async function loadIntegrations() {
    const [st, mk] = await Promise.all([TK.api.get('/ui/api/ban/status'), TK.api.get('/ui/api/mkvid?limit=1')]);
    const s = st.ok && st.data && typeof st.data === 'object' ? st.data : null;
    badge('int-pool', s ? !!s.poolConfigured : null, 'configured', 'not configured');
    badge('int-push', s ? !!s.pushConfigured : null, 'configured', 'not configured');
    const m = mk.ok && mk.data && typeof mk.data === 'object' ? mk.data : null;
    badge('int-mkvid', m ? !!m.enabled : null, 'configured', 'not configured');
  }
  const refreshBtn = $('ban-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', loadIntegrations);

  YT.handleReturn();
  YT.load();
  loadIntegrations();
})();
`

export const SETTINGS_PAGE: UiPage = {
  path: '/settings',
  html: shell({
    nav: 'settings',
    title: 'Settings',
    description: 'The YouTube connection, notifications, theme and integrations.',
    body: BODY,
    css: CSS,
    js: JS,
    banPage: 'settings',
  }),
}
