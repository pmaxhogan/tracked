// The admin UI shell: one server-rendered document per page with the sidebar
// (desktop), the icon rail (tablet), the top bar and bottom tabs (phone), the
// shared dialogs, and the shared scripts in a fixed order: theme boot (head),
// runtime (TK), SHELL_JS, BAN_JS, then the page's own script.
//
// The pool pages run these scripts in a stub DOM (see src/ui/runtime.ts), and
// their tests scan the whole page: no shell <input>/<select> attribute may
// name credentials, and the scripts add no long timers and no tlpool calls.

import { TOKENS_CSS } from './tokens'
import { BASE_CSS } from './base'
import { icon, type IconName } from './icons'
import { THEME_BOOT_JS, RUNTIME_JS } from './runtime'
import { BAN_BANNER_HTML, BAN_JS } from '../routes/ban-ui'

export type NavKey = 'home' | 'djs' | 'search' | 'playlists' | 'removed' | 'mkvid' | 'activity'
  | 'pool' | 'captcha' | 'pool-settings' | 'settings' | 'tools'

export interface NavItem {
  key: NavKey
  label: string
  href: string
  icon: IconName
  /** Sidebar group heading; null for the ungrouped items. */
  group: string | null
  /** Label in the phone tab bar; absent when the item is not a tab. */
  tab?: string
  /** Extra markup after the label (the Challenges count). */
  extra?: string
}

/** Where "search" goes until the Search page ships (phase 3). */
export const SEARCH_HREF = '/ui/djs?focus=filter'

// Activity (/ui/activity) joins the Pipeline group in phase 2.
export const NAV: NavItem[] = [
  { key: 'home', label: 'Home', href: '/ui', icon: 'home', group: null, tab: 'Home' },
  { key: 'djs', label: 'DJs', href: '/ui/djs', icon: 'djs', group: 'Library', tab: 'DJs' },
  { key: 'search', label: 'Search', href: SEARCH_HREF, icon: 'search', group: 'Library', tab: 'Search' },
  { key: 'playlists', label: 'Playlists', href: '/ui/playlists', icon: 'playlist', group: 'Library' },
  { key: 'removed', label: 'Removed videos', href: '/ui/removed', icon: 'removed', group: 'Library' },
  { key: 'mkvid', label: 'mkvid', href: '/ui/mkvid', icon: 'mkvid', group: 'Pipeline', tab: 'mkvid' },
  { key: 'pool', label: 'Accounts', href: '/ui/pool', icon: 'pool', group: 'Pool', tab: 'Pool' },
  { key: 'captcha', label: 'Challenges', href: '/ui/captcha', icon: 'captcha', group: 'Pool', extra: '<span class="count" id="nav-count-captcha" hidden></span>' },
  { key: 'pool-settings', label: 'Pool settings', href: '/ui/pool/settings', icon: 'sliders', group: 'Pool' },
  { key: 'settings', label: 'Settings', href: '/ui/settings', icon: 'settings', group: null },
  { key: 'tools', label: 'Tools', href: '/ui/tools', icon: 'tools', group: null },
]

export interface ShellOptions {
  nav: NavKey | null        // active nav item; DJ profile uses 'djs', Set uses null
  title: string             // plain text: <title>, top-bar title and <h1>
  h1Id?: string             // DJ profile needs <h1 id="dj-name">
  description?: string      // raw HTML, one line under the h1
  actions?: string          // raw HTML for the header actions slot
  body: string              // raw HTML page content
  css?: string              // page CSS
  js?: string               // page script, emitted as its own bare <script>, after the shared ones
  banPage?: 'home' | 'settings' | 'other'   // <body data-ban-page>, default 'other'
  width?: 'wide' | 'narrow' // narrow = 560px centered column (captcha page)
  ownNavCount?: boolean     // page reports the Challenges count itself via TK.navCount(n)
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const current = (on: boolean) => (on ? ' class="on" aria-current="page"' : '')

/** The Pool tab stands for every Pool page. */
function tabIsOn(item: NavItem, nav: NavKey | null): boolean {
  if (item.key === 'pool') return nav === 'pool' || nav === 'captcha' || nav === 'pool-settings'
  return item.key === nav
}

function sideNav(nav: NavKey | null): string {
  let out = ''
  let group: string | null = null
  for (const item of NAV) {
    if (item.group !== group) {
      // Ungrouped items after a group get an empty heading as a spacer.
      out += item.group ? `<div class="grp">${esc(item.group)}</div>` : '<div class="grp" aria-hidden="true"></div>'
      group = item.group
    }
    out += `<a href="${esc(item.href)}" title="${esc(item.label)}"${current(item.key === nav)}>${icon(item.icon)}<span class="lbl">${esc(item.label)}</span>${item.extra ?? ''}</a>`
  }
  return out
}

function menuNav(nav: NavKey | null): string {
  let out = ''
  let group: string | null = null
  for (const item of NAV) {
    if (item.group !== group && item.group) out += `<div class="grp">${esc(item.group)}</div>`
    group = item.group
    out += `<a href="${esc(item.href)}"${current(item.key === nav)}>${esc(item.label)}</a>`
  }
  return out
}

function tabs(nav: NavKey | null): string {
  return NAV.filter((i) => i.tab).map((i) =>
    `<a href="${esc(i.href)}"${current(tabIsOn(i, nav))}>${icon(i.icon)}<span>${esc(i.tab!)}</span>${i.key === 'pool' ? '<span id="tab-count-captcha" class="count" hidden></span>' : ''}</a>`,
  ).join('')
}

/**
 * Shared behaviour for every shell page: the phone menu, the theme select, the
 * "/" shortcut, the fetch status pill and the Challenges count. An IIFE with
 * every lookup null-tolerant and every browser global guarded; no timers. No
 * fetch at all when document.body is missing (the pool tests' stub) or the
 * page reports its own count (the pool pages, whose tests count tlpool calls).
 */
export const SHELL_JS = /* js */ `
(() => {
  if (typeof document === 'undefined' || typeof TK === 'undefined') return;
  const $ = (id) => document.getElementById(id);
  const on = (el, type, fn) => { if (el && typeof el.addEventListener === 'function') el.addEventListener(type, fn); };

  // ── phone menu ──
  const menu = $('tk-menu');
  on($('tk-menu-btn'), 'click', () => { if (menu && !menu.open && typeof menu.showModal === 'function') { try { menu.showModal(); } catch (e) {} } });
  on($('tk-menu-close'), 'click', () => { if (menu && menu.open && typeof menu.close === 'function') menu.close(); });

  // ── theme ──
  const themeSel = $('tk-theme');
  if (themeSel) {
    themeSel.value = TK.theme.get();
    on(themeSel, 'change', () => TK.theme.set(themeSel.value));
  }

  // ── "/" focuses search ──
  on(document, 'keydown', (e) => {
    if (!e || e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))) return;
    const box = $('tk-search');
    if (box && typeof box.focus === 'function') { e.preventDefault(); box.focus(); return; }
    if (typeof location !== 'undefined') { e.preventDefault(); location.href = ${JSON.stringify(SEARCH_HREF)}; }
  });

  const body = document.body;
  if (!body || (body.dataset && body.dataset.ownCount)) return;

  // ── status pill ──
  const pill = $('tk-status');
  if (pill) TK.api.get('/ui/api/ban/status').then((r) => {
    const s = r && r.ok && r.data;
    if (!s) { pill.title = 'Fetch status unavailable'; return; }
    const st = s.pause ? ['Paused', 'bad'] : !s.poolConfigured ? ['Pool offline', 'warn'] : ['Active', 'ok'];
    pill.textContent = st[0];
    pill.className = 'badge ' + st[1];
    pill.title = 'Fetching from 1001tracklists: ' + st[0];
  }).catch(() => {});

  // ── Challenges count ──
  TK.api.get('/ui/api/pool/challenges').then((r) => {
    const list = r && r.ok && r.data && r.data.challenges;
    if (!Array.isArray(list)) return;
    TK.navCount(list.filter((c) => c && c.state === 'pending' && c.ready !== false).length);
  }).catch(() => {});
})();
`

export function shell(o: ShellOptions): string {
  const title = esc(o.title)
  const own = o.ownNavCount ? ' data-own-count="1"' : ''
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark light"><title>${title} · tracked</title>
<style>${TOKENS_CSS}${BASE_CSS}${o.css ?? ''}</style>
<script>${THEME_BOOT_JS}</script></head>
<body data-ban-page="${o.banPage ?? 'other'}"${own}>
<div class="tk-shell">
  <aside class="tk-side">
    <a class="tk-brand" href="/ui" title="tracked">${icon('playlist')}<span class="lbl">tracked</span></a>
    <nav class="tk-nav" aria-label="Pages">${sideNav(o.nav)}</nav>
    <div class="tk-side-foot">
      <span id="tk-status" class="badge neutral" title="Fetch status: checking">…</span>
      <label class="lbl">Theme <select id="tk-theme" aria-label="Theme"><option value="system">System</option><option value="dark">Dark</option><option value="light">Light</option></select></label>
      <span class="lbl">Signed in via Access</span>
    </div>
  </aside>
  <header class="tk-top"><button type="button" class="btn icon" id="tk-menu-btn" aria-label="Menu">${icon('menu')}</button><span class="tk-top-title">${title}</span></header>
  <main class="tk-main${o.width === 'narrow' ? ' narrow' : ''}" id="main">
    ${BAN_BANNER_HTML}
    <div class="tk-head"><div><h1${o.h1Id ? ` id="${esc(o.h1Id)}"` : ''}>${title}</h1>${o.description ? `<p class="desc">${o.description}</p>` : ''}</div><div class="actions">${o.actions ?? ''}</div></div>
    ${o.body}
  </main>
  <nav class="tk-tabs" aria-label="Main">${tabs(o.nav)}</nav>
</div>
<dialog id="tk-menu" class="tk-dialog tk-menu" aria-label="Menu"><div class="tk-drawer-head"><h2>Menu</h2><button type="button" id="tk-menu-close" class="btn icon" aria-label="Close">${icon('close')}</button></div><nav aria-label="All pages">${menuNav(o.nav)}</nav></dialog>
<dialog id="tk-confirm" class="tk-dialog"><p id="tk-confirm-text"></p><div class="actions"><button type="button" id="tk-confirm-no" class="btn">Cancel</button><button type="button" id="tk-confirm-yes" class="btn primary">Yes</button></div></dialog>
<dialog id="tk-drawer" class="tk-drawer"><div class="tk-drawer-head"><h2 id="tk-drawer-title"></h2><button type="button" id="tk-drawer-close" class="btn icon" aria-label="Close">${icon('close')}</button></div><div id="tk-drawer-body"></div></dialog>
<div id="tk-toasts" class="tk-toasts" aria-live="polite"></div>
<script>${RUNTIME_JS}</script><script>${SHELL_JS}</script><script>${BAN_JS}</script>${o.js ? `<script>${o.js}</script>` : ''}
</body></html>`
}
