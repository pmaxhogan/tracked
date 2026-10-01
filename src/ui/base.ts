// Shell and component CSS for the admin UI. Pair with TOKENS_CSS.
// Class names are the contract for every page. No gradients; shadows only
// on the drawer, dialogs and toasts.
export const BASE_CSS = /* css */ `
/* ── reset ── */
*, *::before, *::after { box-sizing: border-box; }
input[type=checkbox], input[type=radio] { accent-color: var(--accent-fill); }
body { margin: 0; background: var(--page); color: var(--fg); font: 15px/1.5 var(--sans); }
[hidden] { display: none !important; }
a { color: var(--accent); }
code, .mono { font-family: var(--mono); font-size: .88em; overflow-wrap: anywhere; }
code { background: var(--elev); padding: .1em .35em; border-radius: 4px; }
table { font-variant-numeric: tabular-nums; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
h1, h2, h3 { line-height: 1.25; }
h2 { font-size: var(--fs-lg); margin: 0 0 var(--sp-3); }
h3 { font-size: var(--fs-md); margin: 0 0 var(--sp-2); }
.muted { color: var(--muted); }
.subtle { color: var(--subtle); }
.ok-text { color: var(--ok); }
.error { color: var(--danger); font-size: var(--fs-sm); min-height: 1.2em; }
.error:empty { min-height: 0; }

/* ── shell: sidebar + main ── */
.tk-shell { display: grid; grid-template-columns: 15rem minmax(0, 1fr); min-height: 100vh; min-height: 100dvh; }
.tk-side { position: sticky; top: 0; height: 100vh; height: 100dvh; overflow-y: auto; background: var(--elev); border-right: 1px solid var(--line); display: flex; flex-direction: column; padding: var(--sp-3); gap: var(--sp-2); }
.tk-brand { display: flex; align-items: center; gap: var(--sp-2); font-weight: 700; font-size: var(--fs-lg); padding: var(--sp-2); color: var(--fg); text-decoration: none; }
.tk-nav { display: flex; flex-direction: column; gap: 2px; flex: 1; }
.tk-nav .grp { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .08em; color: var(--subtle); font-weight: 600; padding: var(--sp-3) var(--sp-2) var(--sp-1); }
.tk-nav a { position: relative; display: flex; align-items: center; gap: var(--sp-3); padding: 7px var(--sp-2); border-radius: var(--r-ctl); color: var(--muted); text-decoration: none; font-size: var(--fs-md); }
.tk-nav a:hover { background: var(--line); color: var(--fg); }
.tk-nav a.on { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.tk-nav svg { width: 18px; height: 18px; flex: none; }
.tk-nav .count { margin-left: auto; min-width: 1.4em; text-align: center; font-size: var(--fs-xs); font-weight: 700; padding: 0 6px; border-radius: 999px; background: var(--accent-fill); color: var(--on-accent); }
.tk-side-foot { border-top: 1px solid var(--line); padding-top: var(--sp-3); display: grid; gap: var(--sp-2); font-size: var(--fs-xs); color: var(--subtle); }
.tk-side-foot select { font: inherit; font-size: var(--fs-sm); color: var(--fg); background: var(--page); border: 1px solid var(--line-strong); border-radius: var(--r-ctl); padding: 4px 6px; }
.tk-main { max-width: 1400px; width: 100%; padding: var(--sp-5) var(--sp-6) 48px; min-width: 0; }
.tk-main.narrow { max-width: 560px; margin-inline: auto; }
.tk-top, .tk-tabs { display: none; }
.tk-search { margin: 0 0 var(--sp-3); }
.tk-search input { appearance: none; font: inherit; color: var(--fg); background: var(--page); border: 1px solid var(--line-strong); border-radius: var(--r-ctl); padding: 8px 10px; width: 100%; max-width: 22rem; min-width: 0; }
.tk-search input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* ── page header ── */
.tk-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: var(--sp-3) var(--sp-4); margin-bottom: var(--sp-4); }
.tk-head h1 { font-size: var(--fs-2xl); margin: 0; letter-spacing: -.01em; }
.tk-head p { margin: var(--sp-1) 0 0; color: var(--muted); }
.tk-head .actions { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; }

/* ── surfaces and layout ── */
.tk-card { background: var(--card); border: 1px solid var(--line); border-radius: var(--r-card); padding: var(--sp-4); min-width: 0; }
.tk-card + .tk-card { margin-top: var(--sp-4); }
.tk-grid { display: grid; gap: var(--sp-4); align-items: start; }
.tk-grid > .tk-card + .tk-card { margin-top: 0; }
.tk-grid.two { grid-template-columns: repeat(auto-fit, minmax(min(100%, 24rem), 1fr)); }
.tk-grid.three { grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr)); }
.tk-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr)); gap: 10px; margin-bottom: var(--sp-4); }
.tk-tile { background: var(--elev); border: 1px solid var(--line); border-radius: var(--r-tile); padding: 10px var(--sp-3); min-width: 0; text-decoration: none; color: inherit; display: block; }
.tk-tile .k { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .06em; color: var(--subtle); font-weight: 600; }
.tk-tile .v { font-size: var(--fs-xl); font-weight: 650; font-variant-numeric: tabular-nums; line-height: 1.2; margin-top: 2px; overflow-wrap: anywhere; }
.tk-tile .s { font-size: var(--fs-sm); color: var(--muted); }
.tk-meter { height: 6px; border-radius: 3px; background: var(--line); overflow: hidden; margin-top: 6px; }
.tk-meter > i { display: block; height: 100%; background: var(--accent-fill); }
.tk-row { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; }

/* ── buttons ── */
.btn { font: 600 .86rem/1 var(--sans); padding: 9px var(--sp-3); border-radius: var(--r-ctl); border: 1px solid var(--line-strong); background: var(--elev); color: var(--fg); cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
.btn:hover:not(:disabled) { border-color: var(--accent); }
.btn.primary { background: var(--accent-fill); border-color: var(--accent-fill); color: var(--on-accent); }
.btn.danger { color: var(--danger); border-color: var(--danger); background: transparent; }
.btn.ghost { background: transparent; border-color: transparent; color: var(--accent); }
.btn.icon { width: 32px; height: 32px; padding: 0; }
.btn svg { width: 16px; height: 16px; }
.btn[aria-busy=true] { cursor: progress; opacity: .6; pointer-events: none; }
.btn:disabled { opacity: .5; cursor: not-allowed; }

/* ── badges, chips, fields ── */
.badge { display: inline-flex; align-items: center; gap: 5px; font-size: .74rem; font-weight: 600; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
.badge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.badge.ok { color: var(--ok); background: var(--ok-bg); }
.badge.warn { color: var(--warn); background: var(--warn-bg); }
.badge.bad { color: var(--danger); background: var(--danger-bg); }
.badge.info { color: var(--info); background: var(--info-bg); }
.badge.neutral { color: var(--muted); background: var(--elev); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: var(--sp-3); }
.chip { font: inherit; font-size: var(--fs-sm); padding: 4px 10px; border-radius: 999px; border: 1px solid var(--line-strong); background: transparent; color: var(--muted); cursor: pointer; }
.chip.on { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
.field { display: grid; gap: 4px; font-size: var(--fs-sm); min-width: 0; }
.field label { color: var(--muted); font-weight: 600; }
.field input:not([type=checkbox]):not([type=radio]), .field select, .field textarea { font: inherit; color: var(--fg); background: var(--page); border: 1px solid var(--line-strong); border-radius: var(--r-ctl); padding: 8px 10px; width: 100%; min-width: 0; }
.field.check { display: flex; align-items: center; gap: var(--sp-2); }
.field.check label { color: var(--fg); font-weight: 500; }
.field.check input { width: auto; margin: 0; }
.field .hint { color: var(--subtle); font-size: var(--fs-xs); }

/* ── tables ── */
.tk-table-wrap { overflow-x: auto; }
.tk-table { border-collapse: collapse; width: 100%; font-size: var(--fs-sm); }
.tk-table th, .tk-table td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
.tk-table th { color: var(--muted); font-weight: 600; font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .04em; white-space: nowrap; }
.tk-table td.num, .tk-table th.num { text-align: right; }
.tk-table tbody tr:hover { background: var(--elev); }

/* ── tabs ── */
.tk-tabbar { display: flex; gap: var(--sp-1); border-bottom: 1px solid var(--line); margin-bottom: var(--sp-4); overflow-x: auto; }
.tk-tabbar [role=tab] { font: inherit; font-weight: 600; color: var(--muted); background: none; border: 0; border-bottom: 2px solid transparent; padding: 8px 12px; cursor: pointer; white-space: nowrap; }
.tk-tabbar [role=tab][aria-selected=true] { color: var(--accent); border-bottom-color: var(--accent); }

/* ── drawer and dialogs (native dialog) ── */
.tk-drawer, .tk-dialog { background: var(--card); color: var(--fg); border: 1px solid var(--line-strong); padding: var(--sp-4); box-shadow: var(--shadow-float); overflow-y: auto; max-width: 100%; }
.tk-drawer::backdrop, .tk-dialog::backdrop, .tk-menu::backdrop { background: rgba(0,0,0,.45); }
.tk-drawer { margin: 0 0 0 auto; width: 28rem; height: 100vh; height: 100dvh; max-height: 100vh; max-height: 100dvh; border-radius: var(--r-tile) 0 0 var(--r-tile); }
.tk-dialog { width: min(32rem, calc(100% - 2rem)); border-radius: var(--r-card); }
.tk-dialog h2, .tk-drawer h2 { margin-top: 0; }
.tk-dialog .actions, .tk-drawer .actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--sp-2); margin-top: var(--sp-4); }

/* ── toasts ── */
.tk-toasts { position: fixed; right: var(--sp-4); bottom: var(--sp-4); z-index: 60; display: grid; gap: var(--sp-2); max-width: min(24rem, calc(100vw - 2rem)); pointer-events: none; }
.toast { pointer-events: auto; background: var(--elev); border: 1px solid var(--line-strong); border-radius: var(--r-tile); padding: 10px var(--sp-3); box-shadow: var(--shadow-float); font-size: var(--fs-sm); overflow-wrap: anywhere; }
.toast.ok { border-color: var(--ok); }
.toast.bad { border-color: var(--danger); color: var(--danger); }

/* ── empty, error and loading states ── */
.empty { text-align: center; color: var(--muted); padding: var(--sp-5) var(--sp-4); border: 1px dashed var(--line-strong); border-radius: var(--r-card); }
.err-state { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-3); padding: var(--sp-3) var(--sp-4); border: 1px solid var(--danger); background: var(--danger-bg); color: var(--danger); border-radius: var(--r-tile); }
.err-state .grow { flex: 1 1 12rem; min-width: 0; overflow-wrap: anywhere; }
.skel { display: block; height: 1em; border-radius: 4px; background: var(--line); animation: tk-pulse 1.4s ease-in-out infinite; }
@keyframes tk-pulse { 50% { opacity: .45; } }
@media (prefers-reduced-motion: reduce) { .skel { animation: none; } }

/* ── track row and set card ── */
.trk { display: grid; grid-template-columns: 52px 36px 1fr auto; gap: 10px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--line); font-size: .86rem; }
.trk .cue { font-family: var(--mono); color: var(--subtle); font-size: .78rem; text-align: right; }
.trk .art { width: 36px; height: 36px; border-radius: 4px; background: var(--elev); object-fit: cover; }
.trk .txt { min-width: 0; overflow-wrap: anywhere; }
.trk .links { display: flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end; }
.trk .links a, .trk .links span { font-size: .7rem; border: 1px solid var(--line-strong); border-radius: 4px; padding: 1px 6px; color: var(--muted); text-decoration: none; }
.set-card { background: var(--card); border: 1px solid var(--line); border-radius: var(--r-card); margin-bottom: var(--sp-2); }
.set-card > .head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); padding: 10px var(--sp-4); cursor: pointer; }
.set-card .title { font-weight: 600; flex: 1 1 14rem; min-width: 0; overflow-wrap: anywhere; }
.set-card .date { color: var(--subtle); font-size: var(--fs-sm); }
.set-card > .body { padding: 0 var(--sp-4) var(--sp-3); border-top: 1px solid var(--line); }

/* ── IP-ban banner, alerts row, ban history (class names toggled by BAN_JS) ── */
.ban-alert { display: block; margin: 0 0 var(--sp-4); padding: 14px var(--sp-4); border-radius: var(--r-tile); background: var(--danger-bg); color: var(--fg); border: 1px solid var(--danger); }
.ban-alert[hidden] { display: none !important; }
.ban-alert.paused { border-width: 2px; }
.ban-alert.simulated { border-style: dashed; }
.ban-alert a { color: var(--danger); }
.ban-head { display: flex; align-items: flex-start; gap: var(--sp-3); }
.ban-icon { font-size: 1.4rem; line-height: 1; }
.ban-title { font-size: var(--fs-lg); font-weight: 700; line-height: 1.25; color: var(--danger); }
.ban-title .ban-badge { display: inline-block; margin-left: 8px; padding: 1px 7px; font-size: .7rem; font-weight: 700; vertical-align: middle; border-radius: 999px; background: var(--danger); color: var(--page); text-transform: uppercase; }
.ban-sub { margin-top: 4px; font-size: var(--fs-sm); line-height: 1.45; color: var(--fg); }
.ban-sub code { background: rgba(0,0,0,.2); }
.ban-actions { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin-top: var(--sp-3); }
.ban-btn { display: inline-block; padding: 8px 12px; font: inherit; font-size: var(--fs-sm); font-weight: 600; border-radius: var(--r-ctl); border: 1px solid var(--danger); background: transparent; color: var(--danger); cursor: pointer; text-decoration: none; }
.ban-btn.primary { background: var(--accent-fill); border-color: var(--accent-fill); color: var(--on-accent); }
.ban-btn.subtle { opacity: .8; font-weight: 500; }
.ban-btn:disabled { opacity: .5; cursor: progress; }
.ban-btn[hidden] { display: none !important; }
.ban-foot { margin-top: var(--sp-2); font-size: var(--fs-xs); color: var(--muted); min-height: 1em; }
.alerts-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 0 0 var(--sp-4); font-size: var(--fs-sm); color: var(--muted); }
.alerts-row .alerts-label { font-weight: 600; color: var(--fg); }
.alerts-state.on { color: var(--ok); }
.alerts-state.off, .alerts-state.err { color: var(--danger); }
.alerts-msg { font-size: var(--fs-xs); }
.ban-route { border: 1px solid var(--line); border-radius: var(--r-ctl); background: var(--card); padding: 10px var(--sp-3); font-size: var(--fs-sm); line-height: 1.55; margin-bottom: var(--sp-2); }
.ban-route .ok { color: var(--ok); font-weight: 600; }
.ban-route .bad { color: var(--danger); font-weight: 600; }
.ban-eps { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
.ban-eps th, .ban-eps td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
.ban-eps th { color: var(--muted); font-weight: 600; font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .03em; }
.ban-eps .mono { overflow-wrap: anywhere; }
.ban-eps td.open { color: var(--danger); font-weight: 600; }
.ban-debug { margin-top: var(--sp-2); font-size: var(--fs-xs); color: var(--muted); }
.ban-debug a { color: var(--muted); }

/* ── phone chrome: top bar, bottom tab bar, menu sheet ── */
.tk-top { align-items: center; justify-content: space-between; gap: var(--sp-3); position: sticky; top: 0; z-index: 30; background: var(--elev); border-bottom: 1px solid var(--line); padding: 10px var(--sp-4); padding-top: calc(10px + env(safe-area-inset-top)); font-weight: 650; }
.tk-tabs { position: fixed; left: 0; right: 0; bottom: 0; z-index: 40; grid-template-columns: repeat(5, 1fr); background: var(--elev); border-top: 1px solid var(--line); padding-bottom: env(safe-area-inset-bottom); }
.tk-tabs a { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 8px 2px; font-size: .68rem; color: var(--muted); text-decoration: none; }
.tk-tabs a.on { color: var(--accent); font-weight: 700; }
.tk-tabs svg { width: 20px; height: 20px; }
.tk-tabs a { position: relative; }
.tk-tabs .count { position: absolute; top: 3px; left: calc(50% + 5px); min-width: 1.3em; text-align: center; font-size: .62rem; font-weight: 700; line-height: 1.3; padding: 0 4px; border-radius: 999px; background: var(--accent-fill); color: var(--on-accent); }
.tk-menu { background: var(--card); color: var(--fg); border: 1px solid var(--line-strong); padding: var(--sp-3) var(--sp-4); padding-bottom: calc(var(--sp-3) + env(safe-area-inset-bottom)); box-shadow: var(--shadow-float); }
.tk-menu a { display: block; padding: 10px 4px; color: var(--fg); text-decoration: none; border-bottom: 1px solid var(--line); }
.tk-menu .grp { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .08em; color: var(--subtle); font-weight: 600; padding: var(--sp-3) 4px var(--sp-1); }
.tk-menu .grp:empty { padding: var(--sp-2) 0 0; }
.tk-drawer-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); margin-bottom: var(--sp-3); }
.tk-drawer-head h2 { margin: 0; font-size: var(--fs-lg); min-width: 0; overflow-wrap: anywhere; }
.tk-top-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ── breakpoints ── */
@media (max-width: 1099px) {
  .tk-shell { grid-template-columns: 4rem minmax(0, 1fr); }
  .tk-side { padding: var(--sp-3) var(--sp-2); align-items: center; }
  .tk-nav .lbl, .tk-nav .grp, .tk-brand .lbl, .tk-side-foot .lbl { display: none; }
  .tk-side-foot { overflow: hidden; justify-items: center; }
  .tk-side-foot > :not(.badge) { display: none; }
  .tk-side-foot .badge { font-size: 0; padding: 4px; gap: 0; }
  .tk-nav { align-items: center; }
  .tk-nav a { justify-content: center; padding: 9px; }
  .tk-nav .count { position: absolute; top: 0; right: 0; margin: 0; }
  .tk-main { padding: var(--sp-5) var(--sp-4) 48px; }
}
@media (max-width: 799px) {
  .tk-shell { display: block; }
  .tk-side { display: none; }
  .tk-top { display: flex; }
  .tk-search { display: none; }
  .tk-tabs { display: grid; }
  .tk-main { padding: 12px var(--sp-4) calc(72px + env(safe-area-inset-bottom)); }
  .tk-head { flex-direction: column; }
  .tk-head h1 { font-size: var(--fs-xl); overflow-wrap: anywhere; position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; margin: 0; }
  .tk-head .actions { width: 100%; }
  .tk-head { gap: 0; margin-bottom: 0; }
  .tk-head:has(.desc), .tk-head:has(.actions > *) { gap: var(--sp-3); margin-bottom: var(--sp-4); }
  .tk-grid.two, .tk-grid.three { grid-template-columns: 1fr; }
  .tk-drawer, .tk-dialog, .tk-menu { margin: auto 0 0; width: 100%; max-width: 100%; max-height: 85vh; max-height: 85dvh; border-radius: var(--r-card) var(--r-card) 0 0; padding-bottom: calc(var(--sp-4) + env(safe-area-inset-bottom)); }
  .tk-drawer { height: auto; }
  .tk-toasts { left: var(--sp-4); right: var(--sp-4); max-width: none; bottom: calc(64px + var(--sp-2) + env(safe-area-inset-bottom)); }
}
@media (max-width: 699px) {
  .tk-table-wrap { overflow-x: visible; }
  .tk-table, .tk-table tbody, .ban-eps, .ban-eps tbody { display: block; }
  .tk-table thead, .ban-eps thead { display: none; }
  .tk-table tr, .ban-eps tr { display: block; border: 1px solid var(--line); border-radius: var(--r-card); margin-bottom: 8px; padding: 4px 10px; background: var(--card); }
  .tk-table td, .ban-eps td { display: flex; justify-content: space-between; gap: 8px; border-bottom: 0; padding: 5px 0; text-align: right; overflow-wrap: anywhere; }
  .tk-table td::before, .ban-eps td::before { content: attr(data-label); color: var(--subtle); text-align: left; flex: none; }
  .trk { grid-template-columns: 44px 36px 1fr; }
  .trk .links { grid-column: 2 / -1; justify-content: flex-start; }
}
`
