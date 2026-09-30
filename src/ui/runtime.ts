// Shared inline client scripts for the admin UI shell. Every rebuilt page
// embeds both as bare <script> tags, THEME_BOOT_JS first (in <head>, so a
// stored manual theme applies before first paint), then RUNTIME_JS.
//
// These run on the pool pages too, whose tests execute them in a stub DOM
// with no window, navigator, localStorage, location, history, matchMedia,
// document.body, document.documentElement or querySelectorAll. So every such
// access is guarded, nothing runs at load beyond defining TK (no timers, no
// fetches), and the only top-level name is `var TK` (the pool pages declare
// their own $, esc, api, jsonInit, poller and errText at top level).
//
// This is a template literal: any backslash that must reach the browser
// (regexes) is doubled here.

/** Applies a stored manual theme ('dark' | 'light'); 'system' is left to the media query. */
export const THEME_BOOT_JS = `(function(){try{var t=localStorage.getItem('tk-theme');if(t==='dark'||t==='light')document.documentElement.dataset.theme=t}catch(e){}})();`

/** Defines the one shared global, TK. */
export const RUNTIME_JS = /* js */ `
var TK = (() => {
  const $ = (id) => document.getElementById(id);

  // Values include third-party titles and URLs: untrusted. esc() is used in
  // both text and attribute contexts, so it escapes quotes too.
  function esc(s) {
    return (s == null ? '' : String(s))
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const safeHref = (u) => (/^https?:\\/\\//i.test(String(u || '')) ? String(u) : null);

  // ── API ──
  // The senders are literal object literals, method first, then the JSON
  // content type, then credentials: the same-origin guard requires both.
  async function send(path, init) {
    let r;
    try { r = await fetch(path, init); } catch (e) { return { ok: false, status: 0, data: { error: 'network' }, raw: '' }; }
    const raw = await r.text().catch(() => '');
    let data = null; try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
    return { ok: r.ok, status: r.status, data, raw };
  }
  const body = (b) => JSON.stringify(b === undefined ? {} : b);
  const api = {
    get: (path) => send(path, { credentials: 'same-origin' }),
    post: (path, b) => send(path, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: body(b) }),
    put: (path, b) => send(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: body(b) }),
    del: (path, b) => send(path, { method: 'DELETE', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: body(b) }),
  };

  const KNOWN_CODES = {
    youtube_not_connected: 'YouTube is not connected. Connect it on the Playlists page.',
    youtube_reauth_required: 'YouTube token rejected by Google (refresh token expired or revoked). Reconnect to continue syncing.',
    network: 'Could not reach tracked. Check the connection and try again.',
    unauthorized: 'Your Cloudflare Access login has expired. Reload the page to sign in again.',
    internal: 'Something went wrong in the Worker.',
    json_required: 'The page sent a request the Worker refuses. Reload the page.',
    cross_origin: 'The Worker refused a request from another site.',
  };
  function errText(res, fallback) {
    const d = res && res.data && typeof res.data === 'object' ? res.data : null;
    if (!d) return fallback;
    if (d.message) return String(d.message);
    if (d.error && Object.prototype.hasOwnProperty.call(KNOWN_CODES, d.error)) return KNOWN_CODES[d.error];
    return d.error ? String(d.error) : fallback;
  }

  // ── feedback ──
  function toast(msg, kind, detail) {
    kind = kind === 'bad' ? 'bad' : 'ok';
    const box = $('tk-toasts');
    if (!box) return;
    if (typeof document.createElement !== 'function') { box.textContent = String(msg == null ? '' : msg); return; }
    const t = document.createElement('div');
    t.className = 'toast ' + kind;
    if (kind === 'bad' && typeof t.setAttribute === 'function') t.setAttribute('role', 'alert');
    const text = document.createElement('div');
    text.textContent = String(msg == null ? '' : msg);
    t.appendChild(text);
    if (detail) {
      const pre = document.createElement('pre');
      pre.textContent = String(detail);
      t.appendChild(pre);
    }
    const remove = () => { if (t.parentNode) t.parentNode.removeChild(t); };
    if (kind === 'ok') {
      setTimeout(remove, 6000);
    } else {
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'btn ghost sm';
      x.textContent = 'Close';
      x.onclick = remove;
      t.appendChild(x);
    }
    box.appendChild(t);
  }

  function ask(text, opts) {
    opts = opts || {};
    const dlg = $('tk-confirm'), msg = $('tk-confirm-text'), yes = $('tk-confirm-yes'), no = $('tk-confirm-no');
    if (!dlg || typeof dlg.showModal !== 'function' || !yes || !no) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        yes.onclick = null; no.onclick = null; dlg.onclose = null; dlg.oncancel = null;
        if (dlg.open && typeof dlg.close === 'function') dlg.close();
        resolve(v);
      };
      if (msg) msg.textContent = String(text == null ? '' : text);
      yes.textContent = opts.yes || 'Yes';
      no.textContent = opts.no || 'Cancel';
      yes.className = opts.danger ? 'btn danger' : 'btn primary';
      yes.onclick = () => done(true);
      no.onclick = () => done(false);
      dlg.onclose = () => done(false);
      dlg.oncancel = () => done(false);
      try { dlg.showModal(); } catch (e) { done(false); }
    });
  }

  const drawer = {
    open(title, html) {
      const dlg = $('tk-drawer'), t = $('tk-drawer-title'), b = $('tk-drawer-body'), x = $('tk-drawer-close');
      if (t) t.textContent = String(title == null ? '' : title);
      if (b) b.innerHTML = html == null ? '' : String(html);
      if (x) x.onclick = () => drawer.close();
      if (dlg) {
        dlg.onkeydown = (e) => { if (e && e.key === 'Escape') drawer.close(); };
        if (!dlg.open && typeof dlg.showModal === 'function') { try { dlg.showModal(); } catch (e) {} }
      }
      return b;
    },
    close() {
      const dlg = $('tk-drawer');
      if (dlg && dlg.open && typeof dlg.close === 'function') dlg.close();
    },
  };

  async function busy(btn, label, fn) {
    if (!btn) return fn();
    const text = btn.textContent, disabled = btn.disabled;
    btn.disabled = true;
    btn.textContent = label;
    if (btn.dataset) btn.dataset.busy = '1';
    if (typeof btn.setAttribute === 'function') btn.setAttribute('aria-busy', 'true');
    try { return await fn(); }
    finally {
      btn.textContent = text;
      btn.disabled = disabled;
      if (btn.dataset) delete btn.dataset.busy;
      if (typeof btn.removeAttribute === 'function') btn.removeAttribute('aria-busy');
    }
  }

  // ── polling ──
  // Every polling loop goes through poll(): it pauses while the tab is hidden
  // (and runs once when it comes back), backs off on errors (doubling, up to a
  // minute), stops for good on 401/403 (the Access login expired:
  // hooks.onAuth), and stops after 15 minutes whatever happens
  // (hooks.onTimeout). fn returns { status } (an api() result is fine).
  const POLL_HARD_STOP_MS = 15 * 60000;
  function poll(fn, everyMs, hooks) {
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

  // ── formatting (verbatim from the old pages) ──
  const fmtTime = (iso) => { if (!iso) return '—'; const d = new Date(iso); const sameDay = d.toDateString() === new Date().toDateString(); return sameDay ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  const fmtDur = (ms) => { if (ms == null) return '—'; const m = Math.round(ms / 60000); if (m < 60) return m + ' min'; const h = Math.floor(m / 60); return h + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : ''); };
  const ago = (iso) => fmtDur(Date.now() - Date.parse(iso)) + ' ago';
  function clock(s) {
    if (s == null || isNaN(s)) return '—';
    s = Math.round(s);
    const neg = s < 0; s = Math.abs(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (neg ? '-' : '') + (h ? h + ':' : '') + mm + ':' + String(sec).padStart(2, '0');
  }
  function relTime(iso) {
    const t = Date.parse(iso); if (isNaN(t)) return '';
    const d = Math.round((Date.now() - t) / 1000);
    if (d < 60) return d + 's ago';
    if (d < 3600) return Math.floor(d / 60) + 'm ago';
    if (d < 86400) return Math.floor(d / 3600) + 'h ago';
    return Math.floor(d / 86400) + 'd ago';
  }
  function untilTime(sec) {
    const m = Math.max(1, Math.round((sec - Date.now() / 1000) / 60));
    if (m < 60) return 'in ' + m + 'm';
    return 'in ' + Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }
  function fmtDate(epoch) {
    if (!epoch) return '';
    try { return new Date(epoch * 1000).toLocaleDateString(); } catch { return ''; }
  }
  // ".../tracklist/2mx9k/lilly-palmer-tomorrowland-2024.html" ->
  // "lilly palmer tomorrowland 2024". Untrusted input: only ever rendered
  // through esc().
  function setLabel(u) {
    if (!u) return '(unknown set)';
    try {
      const seg = new URL(u).pathname.split('/').filter(Boolean).pop() || '';
      const name = seg.replace(/\\.html?$/i, '').replace(/[-_]+/g, ' ').trim();
      return name || u;
    } catch { return u; }
  }

  // ── query string ──
  const qs = {
    get(name) { return typeof location === 'undefined' ? null : new URLSearchParams(location.search).get(name); },
    set(obj) {
      if (typeof location === 'undefined' || typeof history === 'undefined' || typeof URLSearchParams === 'undefined') return;
      const p = new URLSearchParams();
      for (const k of Object.keys(obj || {})) {
        const v = obj[k];
        if (v === undefined || v === null || v === '') continue;
        p.set(k, String(v));
      }
      const q = p.toString();
      try { history.replaceState(null, '', location.pathname + (q ? '?' + q : '')); } catch (e) {}
    },
  };

  function navCount(n) {
    for (const id of ['nav-count-captcha', 'tab-count-captcha']) {
      const el = $(id);
      if (!el) continue;
      el.textContent = String(n || 0);
      el.hidden = !n;
    }
  }

  // ── theme ──
  const THEME_KEY = 'tk-theme';
  const theme = {
    get() {
      try { const t = localStorage.getItem(THEME_KEY); if (t === 'dark' || t === 'light' || t === 'system') return t; } catch (e) {}
      return 'system';
    },
    set(v) {
      try { localStorage.setItem(THEME_KEY, v); } catch (e) {}
      const root = typeof document !== 'undefined' ? document.documentElement : null;
      if (!root || !root.dataset) return;
      if (v === 'dark' || v === 'light') root.dataset.theme = v;
      else delete root.dataset.theme;
    },
  };

  return {
    $, esc, safeHref, api, errText, toast, ask, drawer, busy, poll, qs, navCount, theme,
    fmt: { time: fmtTime, dur: fmtDur, ago, rel: relTime, clock, until: untilTime, date: fmtDate, setLabel },
  };
})();
`
