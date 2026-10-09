// Inline SVG icon set for the server-rendered admin shell. 24x24 grid,
// Lucide-style shapes: stroke 1.75, round caps and joins, no fill.

export const ICON_NAMES = [
  'home', 'djs', 'search', 'playlist', 'removed', 'mkvid', 'activity', 'pool',
  'captcha', 'settings', 'tools', 'sliders', 'menu', 'close', 'sun', 'moon',
  'monitor', 'external', 'refresh', 'play', 'bell', 'shield', 'up', 'down',
  'top', 'bottom', 'ban', 'check', 'warn', 'copy', 'link', 'clock',
  'bookmark', 'upload', 'chart',
] as const

export type IconName = (typeof ICON_NAMES)[number]

const BODY: Record<IconName, string> = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>',
  djs: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20v-1a5.5 5.5 0 0 1 5.5-5.5h2a5.5 5.5 0 0 1 5.5 5.5v1"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18.5 13.8A5.5 5.5 0 0 1 21.5 19v1"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.5-4.5"/>',
  playlist: '<path d="M3 6h12"/><path d="M3 12h12"/><path d="M3 18h7"/><path d="M19 15V4l-3 1"/><circle cx="17" cy="16.5" r="2.5"/>',
  removed: '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M5.5 6l1 14a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1l1-14"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  mkvid: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18"/><path d="M17 3v18"/><path d="M3 8h4"/><path d="M3 12h4"/><path d="M3 16h4"/><path d="M17 8h4"/><path d="M17 12h4"/><path d="M17 16h4"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  pool: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01"/><path d="M7 17.5h.01"/>',
  captcha: '<path d="M12 3 4 6v5.5c0 4.7 3.2 8.3 8 9.5 4.8-1.2 8-4.8 8-9.5V6z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  settings: '<path d="M9.8 4.7 L10.3 2.1 L13.7 2.1 L14.2 4.7 L15.5 5.3 L17.8 3.8 L20.2 6.2 L18.7 8.5 L19.3 9.8 L21.9 10.3 L21.9 13.7 L19.3 14.2 L18.7 15.5 L20.2 17.8 L17.8 20.2 L15.5 18.7 L14.2 19.3 L13.7 21.9 L10.3 21.9 L9.8 19.3 L8.5 18.7 L6.2 20.2 L3.8 17.8 L5.3 15.5 L4.7 14.2 L2.1 13.7 L2.1 10.3 L4.7 9.8 L5.3 8.5 L3.8 6.2 L6.2 3.8 L8.5 5.3 Z"/><circle cx="12" cy="12" r="3"/>',
  tools: '<path d="M14.7 6.3a4 4 0 0 0 5 5L21 12.6a1 1 0 0 1 0 1.4l-1 1-6-6 1-1a1 1 0 0 1 .7-.3z"/><path d="m14 9-10.5 10.5a1.8 1.8 0 0 0 2.5 2.5L16.5 11.5"/>',
  sliders: '<path d="M4 6h10"/><path d="M18 6h2"/><circle cx="16" cy="6" r="2"/><path d="M4 12h2"/><path d="M10 12h10"/><circle cx="8" cy="12" r="2"/><path d="M4 18h10"/><path d="M18 18h2"/><circle cx="16" cy="18" r="2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  menu: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2"/><path d="M12 19.5v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2.5 12h2"/><path d="M19.5 12h2"/><path d="m4.9 19.1 1.4-1.4"/><path d="m17.7 6.3 1.4-1.4"/>',
  moon: '<path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11z"/>',
  monitor: '<rect x="2.5" y="3.5" width="19" height="13" rx="2"/><path d="M8 21h8"/><path d="M12 16.5V21"/>',
  external: '<path d="M18 13.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5.5"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  play: '<path d="M7 4.5v15a.8.8 0 0 0 1.2.7l12-7.5a.8.8 0 0 0 0-1.4L8.2 3.8A.8.8 0 0 0 7 4.5z"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  shield: '<path d="M12 3 4 6v5.5c0 4.7 3.2 8.3 8 9.5 4.8-1.2 8-4.8 8-9.5V6z"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  top: '<path d="M5 3h14"/><path d="m6 14 6-6 6 6"/><path d="M12 8v13"/>',
  bottom: '<path d="M5 21h14"/><path d="m6 10 6 6 6-6"/><path d="M12 16V3"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
  check: '<path d="m4.5 12.5 5 5 10-11"/>',
  warn: '<path d="M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4.5"/><path d="M12 17.5h.01"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8.5a2 2 0 0 0 2 2h3.5"/>',
  link: '<path d="M10 13.5a4.5 4.5 0 0 0 6.4.4l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.7 1.7"/><path d="M14 10.5a4.5 4.5 0 0 0-6.4-.4l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.7-1.7"/>',
  chart: '<path d="M3 3v17a1 1 0 0 0 1 1h17"/><path d="M7 16v-4"/><path d="M11 16V8"/><path d="M15 16v-6"/><path d="M19 16V5"/>',
  bookmark: '<path d="M6.5 3h11a1 1 0 0 1 1 1v17l-6.5-4.5L5.5 21V4a1 1 0 0 1 1-1z"/>',
  upload: '<path d="M12 15V3.5"/><path d="m7 8.5 5-5 5 5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
}

function escAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function icon(name: IconName, opts: { size?: number; label?: string } = {}): string {
  const size = opts.size ?? 18
  const a11y = opts.label
    ? `role="img" aria-label="${escAttr(opts.label)}"`
    : 'aria-hidden="true"'
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" ${a11y}>${BODY[name]}</svg>`
}
