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

import { SKEL_ITEMS } from './skeleton'

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
    const aborted = () => !!(init && init.signal && init.signal.aborted);
    try { r = await fetch(path, init); } catch (e) {
      if (aborted() || (e && e.name === 'AbortError')) return { ok: false, status: 0, aborted: true, data: null, raw: '' };
      return { ok: false, status: 0, data: { error: 'network' }, raw: '' };
    }
    const raw = await r.text().catch(() => '');
    if (aborted()) return { ok: false, status: 0, aborted: true, data: null, raw: '' };
    let data = null; try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
    return { ok: r.ok, status: r.status, data, raw };
  }
  const body = (b) => JSON.stringify(b === undefined ? {} : b);
  const api = {
    // opts.signal (an AbortSignal) cancels the request: it then resolves to { ok: false, status: 0, aborted: true }, no toast, never a throw.
    get: (path, opts) => send(path, opts && opts.signal ? { credentials: 'same-origin', signal: opts.signal } : { credentials: 'same-origin' }),
    post: (path, b) => send(path, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: body(b) }),
    put: (path, b) => send(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: body(b) }),
    del: (path, b) => send(path, { method: 'DELETE', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: body(b) }),
    swr,
    // The stored copy swr would paint first, or null: for rendering many rows from memory at once.
    stored: (path, maxAgeMs) => { const hit = swrRead(path, maxAgeMs || 86400000); return hit ? hit.data : null; },
  };

  // ── stale-while-revalidate GETs ──
  // TK.api.swr(path, handle, opts): the last good response this browser saw
  // for path (at most opts.maxAgeMs old, default a day) goes to
  // handle({ ok: true, status: 200, data, stale: true, storedAt }) at once,
  // then the live response goes to handle(res) as TK.api.get returns it, so
  // a page paints from memory and corrects itself a moment later. Returns the
  // live response. Per-browser only: localStorage, every access guarded (it
  // can be missing or throw), never shared; a stored copy whose handler
  // throws is dropped.
  const SWR_PREFIX = 'tk-swr:1:';
  const SWR_MAX_CHARS = 200000;
  function swrRead(path, maxAgeMs) {
    try {
      const v = JSON.parse(localStorage.getItem(SWR_PREFIX + path) || 'null');
      return v && typeof v.at === 'number' && Date.now() - v.at <= maxAgeMs ? v : null;
    } catch (e) { return null; }
  }
  function swrDrop(path) { try { localStorage.removeItem(SWR_PREFIX + path); } catch (e) {} }
  function swrWrite(path, data) {
    let s;
    try { s = JSON.stringify({ at: Date.now(), data }); } catch (e) { return; }
    if (s.length > SWR_MAX_CHARS) { swrDrop(path); return; }
    try { localStorage.setItem(SWR_PREFIX + path, s); }
    catch (e) {
      // Full: forget every stored response (they are only a head start), then try once more.
      try {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.indexOf(SWR_PREFIX) === 0) keys.push(k); }
        for (const k of keys) localStorage.removeItem(k);
        localStorage.setItem(SWR_PREFIX + path, s);
      } catch (e2) {}
    }
  }
  // opts.key stores under another name than the path, for a path that carries a moving value (a since= time).
  async function swr(path, handle, opts) {
    const key = (opts && opts.key) || path;
    const hit = swrRead(key, (opts && opts.maxAgeMs) || 86400000);
    if (hit) {
      try { await handle({ ok: true, status: 200, data: hit.data, raw: '', stale: true, storedAt: hit.at }); }
      catch (e) { swrDrop(key); }
    }
    const res = await api.get(path, opts && opts.signal ? { signal: opts.signal } : undefined);
    if (res.ok && res.data !== null && res.data !== undefined) swrWrite(key, res.data);
    if (!res.aborted) await handle(res);
    return res;
  }

  const KNOWN_CODES = {
    youtube_not_connected: 'YouTube is not connected. Connect it on the Playlists page.',
    youtube_reauth_required: 'YouTube token rejected by Google (refresh token expired or revoked). Reconnect to continue syncing.',
    network: 'Could not reach tracked. Check the connection and try again.',
    unauthorized: 'Your Cloudflare Access login has expired. Reload the page to sign in again.',
    forbidden: 'This Cloudflare Access login is not allowed here.',
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
  // The topmost open <dialog>, if any. A modal dialog (the drawer, a confirm)
  // sits in the top layer and makes everything outside it inert, so a toast
  // shown in #tk-toasts would be hidden behind it.
  function openDialog() {
    try {
      if (typeof document.querySelectorAll === 'function') {
        const all = document.querySelectorAll('dialog[open]');
        return all && all.length ? all[all.length - 1] : null;
      }
      return typeof document.querySelector === 'function' ? document.querySelector('dialog[open]') : null;
    } catch (e) { return null; }
  }
  // Where a new toast goes: a toast region inside the open dialog (added once),
  // else the shell's #tk-toasts.
  function toastBox() {
    const dlg = openDialog();
    if (dlg && typeof dlg.appendChild === 'function') {
      let box = typeof dlg.querySelector === 'function' ? dlg.querySelector('[data-tk-toasts]') : null;
      if (!box) {
        box = document.createElement('div');
        box.className = 'tk-toasts';
        if (typeof box.setAttribute === 'function') { box.setAttribute('data-tk-toasts', ''); box.setAttribute('aria-live', 'polite'); }
        dlg.appendChild(box);
      }
      if (box && typeof box.appendChild === 'function') return box;
    }
    return $('tk-toasts');
  }

  // link: optional { href, text } rendered as an anchor under the message (href must pass safeHref).
  function toast(msg, kind, detail, link) {
    kind = kind === 'bad' ? 'bad' : 'ok';
    if (typeof document.createElement !== 'function') {
      const plain = $('tk-toasts');
      if (plain) plain.textContent = String(msg == null ? '' : msg);
      return;
    }
    const box = toastBox();
    if (!box) return;
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
    const href = link ? safeHref(link.href) || (typeof link.href === 'string' && /^\\/(?![\\/\\\\])[^\\\\\\x00-\\x1f\\x7f]*$/.test(link.href) ? link.href : null) : null;
    if (href) {
      const a = document.createElement('a');
      a.href = href;
      a.textContent = String(link.text == null ? href : link.text);
      t.appendChild(a);
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
        // Toasts left over from the last time the drawer was open belong to another item.
        const stale = typeof dlg.querySelector === 'function' ? dlg.querySelector('[data-tk-toasts]') : null;
        if (stale) stale.innerHTML = '';
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

  // ── skeletons ── (markup from src/ui/skeleton.ts)
  const SKEL_ITEMS = ${JSON.stringify(SKEL_ITEMS)};
  function skel(n, kind) {
    const items = SKEL_ITEMS[kind === 'card' ? 'card' : 'row'];
    let h = '<div class="skel-list" role="status" aria-label="Loading">';
    for (let i = 0; i < n; i++) h += items[i % items.length];
    return h + '</div>';
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
    $, esc, safeHref, api, errText, toast, ask, drawer, busy, poll, qs, navCount, theme, skel,
    fmt: { time: fmtTime, dur: fmtDur, ago, rel: relTime, clock, until: untilTime, date: fmtDate, setLabel },
  };
})();
`
