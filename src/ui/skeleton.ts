// Loading placeholders: n cards (two lines each) or n rows (one line), with
// fixed widths so nothing data-dependent is ever inserted. `skelHtml` renders
// them server-side into a page's first paint; the runtime's TK.skel(n, kind)
// builds the same markup client-side from SKEL_ITEMS.
export type SkelKind = 'card' | 'row'

const WIDTHS = [72, 58, 85, 64, 77, 50, 68, 81]

function item(i: number, kind: SkelKind): string {
  const w = WIDTHS[i % WIDTHS.length]!
  return kind === 'card'
    ? `<div class="skel-card"><span class="skel" style="width:${w}%"></span><span class="skel sm" style="width:${w - 25}%"></span></div>`
    : `<div class="skel-row"><span class="skel" style="width:${w}%"></span></div>`
}

/** One full cycle of items per kind, for the runtime to repeat. */
export const SKEL_ITEMS: Record<SkelKind, string[]> = {
  card: WIDTHS.map((_, i) => item(i, 'card')),
  row: WIDTHS.map((_, i) => item(i, 'row')),
}

export function skelHtml(n: number, kind: SkelKind): string {
  let h = '<div class="skel-list" role="status" aria-label="Loading">'
  for (let i = 0; i < n; i++) h += item(i, kind)
  return h + '</div>'
}
