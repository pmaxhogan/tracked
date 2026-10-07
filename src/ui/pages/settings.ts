// Settings: the YouTube connection, this device's notifications, the theme, the
// integrations in use and the ban episodes. BAN_JS (banPage 'settings') fills the
// alerts-*, ban-route, ban-devices and ban-episodes elements by id.
import { shell } from '../shell'
import type { UiPage } from './index'
import { YOUTUBE_CARD_CSS, YOUTUBE_CARD_HTML, YOUTUBE_CARD_JS } from './youtube-card'
import { SETTINGS_FORM_CSS, SETTINGS_FORM_JS, type FormGroup } from './settings-form'

// App settings (lib/app-settings.ts, GET/PUT /ui/api/settings). A blank
// env-backed field saves null: the env var, else the old default (shown as
// the placeholder).
const APP_GROUPS: FormGroup[] = [
  {
    id: 'sf-mkvid',
    title: 'mkvid uploads',
    intro: 'Blank = the env var or secret, else the default (shown greyed).',
    fields: [
      { path: 'mkvid.dailyClaimCap', label: 'Uploads a day, mkvid project', help: 'mkvid-uploads. 0 pauses the queue.', min: 0, max: 100, step: 1, nullable: true },
      { path: 'mkvid.sharedDailyClaimCap', label: 'Uploads a day, shared project', help: 'tracked-youtube, once the first is full.', min: 0, max: 100, step: 1, nullable: true },
      { path: 'mkvid.claimTtlMinutes', label: 'Hand a stuck claim out again after', help: 'mkvid died mid-job.', unit: 'min', min: 10, max: 1440, step: 1, nullable: true },
      { path: 'mkvid.maxAttempts', label: 'Attempts before a request fails', help: 'Default 3.', min: 1, max: 10, step: 1 },
      { path: 'mkvid.retryBackoffHours', label: 'Retry a failed render after', help: 'Times the attempts so far. Default 6.', unit: 'h', min: 0.25, max: 168 },
      { path: 'mkvid.unverifiedRetryMinutes', label: 'List not verified: look again after', help: 'No attempt used. Default 60.', unit: 'min', min: 5, max: 1440, step: 1 },
    ],
  },
  {
    id: 'sf-playlists',
    title: 'Playlists',
    fields: [
      { path: 'playlists.sweepDryRun', label: 'Removal sweep only reports', help: 'Blank = PLAYLIST_SWEEP_DRY_RUN (unset = on).', kind: 'bool', nullable: true },
      { path: 'playlists.sweepDailyRemovals', label: 'Sweep removals a day', help: '50 quota units each. Blank = env, else 40.', min: 0, max: 500, step: 1, nullable: true },
      { path: 'playlists.rejectVertical', label: 'Turn down vertical videos', help: 'Shorts. Blank = REJECT_VERTICAL (unset = off).', kind: 'bool', nullable: true },
      { path: 'playlists.shortToleranceMinutes', label: 'Video shorter than the last cue by', help: 'More than this is not the full set. Default 5.', unit: 'min', min: 0, max: 60 },
      { path: 'playlists.audioToleranceMinutes', label: 'Audio longer than the video by', help: 'More than this means the video is a cut. Default 10.', unit: 'min', min: 0, max: 120 },
      { path: 'playlists.massRemovalMax', label: 'Hold a playlist when missing more than', help: 'Videos at once, instead of removing. Default 5.', min: 0, max: 100, step: 1 },
      { path: 'playlists.massRemovalRatio', label: 'Or more than this share of it', help: 'Default 0.3.', min: 0, max: 1, step: 0.05 },
      { path: 'playlists.runRemovalMax', label: 'Hold every playlist when one run misses more than', help: 'Across all playlists. Default 15.', min: 0, max: 500, step: 1 },
      { path: 'playlists.combinedDailyInsertCap', label: 'Combined playlist inserts a day', help: '50 quota units each. Default 80.', min: 0, max: 190, step: 1 },
      { path: 'playlists.combinedMaxInsertsPerRun', label: 'Combined playlist inserts per run', help: 'Default 20.', min: 0, max: 100, step: 1 },
    ],
  },
  {
    id: 'sf-retention',
    title: 'Retention',
    fields: [
      { path: 'retention.auditDays', label: 'Keep now-playing and playlist audit', help: 'Default 90.', unit: 'days', min: 1, max: 3650, step: 1 },
      { path: 'retention.tickHistoryDays', label: 'Keep scheduler tick history', help: 'Default 14.', unit: 'days', min: 1, max: 365, step: 1 },
    ],
  },
]

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
<div id="sf-app"></div>
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
${YOUTUBE_CARD_CSS}
${SETTINGS_FORM_CSS}`

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

  // ── app settings: field-table cards (ui/pages/settings-form.ts) ──
${SETTINGS_FORM_JS}
  const APP_GROUPS = ${JSON.stringify(APP_GROUPS)};
  async function loadApp() {
    const r = await fetch('/ui/api/settings', { credentials: 'same-origin' }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    if (r && r.ok && d.settings) SF.fill(APP_GROUPS, d.settings, Object.assign({}, d.defaults, { mkvid: Object.assign({}, d.defaults.mkvid, d.effective.mkvid), playlists: Object.assign({}, d.defaults.playlists, d.effective.playlists) }));
  }
  const $app = $('sf-app');
  if ($app) {
    SF.mount($app, APP_GROUPS, async (patch) => {
      const r = await fetch('/ui/api/settings', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }).catch(() => null);
      const d = r ? await r.json().catch(() => ({})) : {};
      if (!r || !r.ok) return { ok: false, issues: d.issues || [], message: d.issues ? '' : 'Could not save (HTTP ' + (r ? r.status : 0) + ').' };
      loadApp();
      return { ok: true };
    });
    loadApp();
  }

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
    description: 'The YouTube connection, notifications, theme, integrations, mkvid uploads, playlists and retention.',
    body: BODY,
    css: CSS,
    js: JS,
    banPage: 'settings',
  }),
}
