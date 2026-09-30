// Design tokens for the admin UI (spec section 7). Dark first; light applies
// under the OS preference unless the page pins dark, and when pinned light.
export const TOKENS_CSS = /* css */ `
:root {
  color-scheme: dark;
  --page: #101219;
  --card: #171a23;
  --elev: #1f2330;
  --line: #2a2f3d;
  --line-strong: #3a4052;
  --fg: #e8e9f0;
  --muted: #a3a7b8;
  --subtle: #737889;
  --accent: #a597ff;
  --accent-fill: #7b6cf6;
  --on-accent: #ffffff;
  --accent-soft: rgba(123,108,246,.16);
  --ok: #3fb950; --ok-bg: #12261a;
  --warn: #d29922; --warn-bg: #2a2110;
  --danger: #f85149; --danger-bg: #2d1516;
  --info: #58a6ff; --info-bg: #13202e;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, "Cascadia Mono", "SFMono-Regular", Menlo, monospace;
  --r-ctl: 6px; --r-tile: 8px; --r-card: 10px;
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 24px; --sp-6: 32px;
  --fs-xs: .75rem; --fs-sm: .85rem; --fs-md: .95rem; --fs-lg: 1.05rem; --fs-xl: 1.35rem; --fs-2xl: 1.7rem;
  --shadow-float: 0 12px 32px rgba(0,0,0,.35);
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    color-scheme: light;
    --page: #f6f6fa; --card: #ffffff; --elev: #eeeef5; --line: #e2e3ec; --line-strong: #c9cbd9;
    --fg: #171a23; --muted: #4a4e5e; --subtle: #6b6f80;
    --accent: #5b4bd6; --accent-fill: var(--accent); --on-accent: #ffffff; --accent-soft: rgba(91,75,214,.12);
    --ok: #1a7f37; --ok-bg: #e6f4ea; --warn: #9a6700; --warn-bg: #fbf1d6;
    --danger: #cf222e; --danger-bg: #fbe9e9; --info: #0969da; --info-bg: #e5f0fb;
    --shadow-float: 0 12px 32px rgba(0,0,0,.18);
  }
}
:root[data-theme="light"] {
  color-scheme: light;
  --page: #f6f6fa; --card: #ffffff; --elev: #eeeef5; --line: #e2e3ec; --line-strong: #c9cbd9;
  --fg: #171a23; --muted: #4a4e5e; --subtle: #6b6f80;
  --accent: #5b4bd6; --accent-fill: var(--accent); --on-accent: #ffffff; --accent-soft: rgba(91,75,214,.12);
  --ok: #1a7f37; --ok-bg: #e6f4ea; --warn: #9a6700; --warn-bg: #fbf1d6;
  --danger: #cf222e; --danger-bg: #fbe9e9; --info: #0969da; --info-bg: #e5f0fb;
  --shadow-float: 0 12px 32px rgba(0,0,0,.18);
}
`
