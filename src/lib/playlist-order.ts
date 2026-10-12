/**
 * Playlist order: every managed playlist is ordered by the date its sets took
 * place, earliest first. This file is the pure half (no imports, so the
 * estimate script in scripts/ can load it as is):
 *
 *   - `setHappenedOn`   the date a set happened, from its 1001tracklists URL
 *   - `compareOrder`    the order two playlist entries go in
 *   - `insertPosition`  where a new video goes (lib/playlist-order-store.ts
 *                       feeds it; every `playlistItems.insert` uses it)
 *   - `planMoves`       the fewest `playlistItems.update` calls that sort an
 *                       existing playlist (lib/playlist-reorder.ts runs them)
 *
 * **The date.** A set URL ends in the date of the set. A radio show that airs
 * a festival set carries two (`…-ultra-music-festival-chile-2024-04-20-2024-05-22.html`:
 * played on the first, aired on the second), so the date is the EARLIEST of
 * the run of dates the slug ends in. `setDateFromUrl` (lib/pool-settings.ts)
 * and `set_date` in D1 keep the last one, which is what recheck ages and the
 * mkvid queue are built on; they are not changed.
 *
 * **The order.** Dated before undated; then by date; then by the set's slug
 * (its URL without the id, so two sets of one day go by name, which in the
 * combined playlist groups a festival day by artist); then by the whole URL.
 * Two entries that compare equal (the same set twice, or two undated videos)
 * keep the order they have: nothing is moved to settle a tie nobody can see.
 *
 * **No date.** Only a video no tracked set resolves to (one the owner added
 * by hand, or a set since swapped to another video) has no date. Those go
 * after every dated set, in the order they already have, and a new one is
 * appended, as before this existed.
 */

/** What a playlist entry is ordered by. `date` null = no set known for the video. */
export type OrderKey = { date: string | null; name: string; url: string }

export const UNDATED: OrderKey = { date: null, name: '', url: '' }

const DATE_RUN = /(?:-\d{4}-\d{2}-\d{2})+$/
const ONE_DATE = /\d{4}-\d{2}-\d{2}/g

function isRealDate(d: string): boolean {
  const t = Date.parse(`${d}T00:00:00Z`)
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d
}

/** The set's slug: the URL's last path segment, without `.html` and anything after it. */
function slugOf(url: string): string {
  const path = (url.split(/[?#]/)[0] ?? '').replace(/\/+$/, '')
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.html$/, '')
}

/** The date the set happened (YYYY-MM-DD): the earliest of the dates its URL slug ends in, or null. */
export function setHappenedOn(url: string): string | null {
  const run = slugOf(url).match(DATE_RUN)?.[0]
  if (!run) return null
  let best: string | null = null
  for (const d of run.match(ONE_DATE) ?? []) if (isRealDate(d) && (best === null || d < best)) best = d
  return best
}

export function orderKeyOfSet(url: string): OrderKey {
  return { date: setHappenedOn(url), name: slugOf(url), url }
}

/** Negative when `a` goes first, positive when `b` does, 0 when they keep the order they have. */
export function compareOrder(a: OrderKey, b: OrderKey): number {
  if (a.date === null || b.date === null) return a.date === b.date ? 0 : a.date === null ? 1 : -1
  if (a.date !== b.date) return a.date < b.date ? -1 : 1
  if (a.name !== b.name) return a.name < b.name ? -1 : 1
  return a.url === b.url ? 0 : a.url < b.url ? -1 : 1
}

/**
 * Video id → order key, from every (set URL, video id) pair tracked knows. A
 * video several sets resolve to (both halves of a b2b, a set listed under two
 * DJs) takes the key that goes first.
 */
export function orderKeysByVideo(rows: Iterable<{ url: string; videoId: string | null }>): Map<string, OrderKey> {
  const out = new Map<string, OrderKey>()
  for (const r of rows) {
    if (!r.videoId) continue
    const key = orderKeyOfSet(r.url)
    if (key.date === null) continue
    const had = out.get(r.videoId)
    if (!had || compareOrder(key, had) < 0) out.set(r.videoId, key)
  }
  return out
}

/**
 * The `snippet.position` a new entry is inserted at: after everything that
 * goes before it or ties with it, i.e. its place once the playlist is sorted.
 * Null = append (an undated entry, or one that belongs at the end), which is
 * an insert without a position. Counted from membership alone, so a playlist
 * that is not sorted yet gets the entry near its final place and the reorder
 * pass does the rest.
 */
export function insertPosition(existing: Iterable<OrderKey>, entry: OrderKey): number | null {
  if (entry.date === null) return null
  let before = 0
  let total = 0
  for (const k of existing) {
    total += 1
    if (compareOrder(k, entry) <= 0) before += 1
  }
  return before >= total ? null : before
}

/** One `playlistItems.update`: the item ends up at index `position` of the playlist as it is after the move. */
export type Move = { id: string; position: number }

export type MovePlan<T> = {
  /** The order the playlist ends in. */
  sorted: T[]
  /** The fewest moves that get there, to be applied in this order. */
  moves: Move[]
}

/**
 * The fewest moves that sort `items` (given in their current playlist order).
 * The longest run of entries already in order relative to each other stays
 * where it is; only the others move, so the count is `items.length` minus
 * that run and no smaller plan exists.
 *
 * YouTube applies a move as "take the item out, put it back at `position`",
 * shifting everything between the two places by one. Each move here is
 * computed against the list as the moves before it left it: an entry is
 * placed directly after the entry it follows in the sorted order, which is
 * either one that stays or one already moved. Applying a prefix of the plan
 * and planning again later only ever finds fewer moves left, which is what
 * makes a budgeted, interrupted backfill safe.
 */
export function planMoves<T extends { id: string; key: OrderKey }>(items: readonly T[]): MovePlan<T> {
  const n = items.length
  // Stable sort: entries that compare equal keep their current order.
  const sorted = items.map((it, i) => ({ it, i })).sort((a, b) => compareOrder(a.it.key, b.it.key) || a.i - b.i)
  const stays = longestOrderedRun(items)
  const current = items.map((it) => it.id)
  const moves: Move[] = []
  for (let t = 0; t < n; t++) {
    const { it, i } = sorted[t]!
    if (stays.has(i)) continue
    current.splice(current.indexOf(it.id), 1)
    const position = t === 0 ? 0 : current.indexOf(sorted[t - 1]!.it.id) + 1
    current.splice(position, 0, it.id)
    moves.push({ id: it.id, position })
  }
  return { sorted: sorted.map((s) => s.it), moves }
}

/** What YouTube does with a list of moves, for tests and the estimate: ids in the order they end in. */
export function applyMoves(ids: readonly string[], moves: readonly Move[]): string[] {
  const out = [...ids]
  for (const m of moves) {
    const from = out.indexOf(m.id)
    if (from < 0) continue
    out.splice(from, 1)
    out.splice(m.position, 0, m.id)
  }
  return out
}

/** Indexes of the longest subsequence of `items` that is already in order (patience sorting, O(n log n)). */
function longestOrderedRun(items: ReadonlyArray<{ key: OrderKey }>): Set<number> {
  /** tails[len - 1] = index of the entry that ends the best run of that length. */
  const tails: number[] = []
  const prev: number[] = new Array(items.length).fill(-1)
  for (let i = 0; i < items.length; i++) {
    // First run whose last entry must go AFTER this one: this entry replaces it (equal keys extend a run).
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (compareOrder(items[tails[mid]!]!.key, items[i]!.key) <= 0) lo = mid + 1
      else hi = mid
    }
    prev[i] = lo > 0 ? tails[lo - 1]! : -1
    tails[lo] = i
  }
  const out = new Set<number>()
  for (let i = tails.length > 0 ? tails[tails.length - 1]! : -1; i >= 0; i = prev[i]!) out.add(i)
  return out
}

// ─── quota ──────────────────────────────────────────────────────────────────

/** `playlistItems.update`, like an insert or a delete. */
export const UNITS_PER_MOVE = 50
/** `playlistItems.list` returns 50 entries for 1 unit. */
export const ITEMS_PER_LIST_PAGE = 50

/** Units one full reading of a playlist of `items` entries costs. */
export function listUnits(items: number): number {
  return Math.max(1, Math.ceil(items / ITEMS_PER_LIST_PAGE))
}

/** What a playlist still needs, as the dry run prints it. */
export type OrderNeed = { items: number; undated: number; moves: number; units: number }

/** `units` = the moves themselves; the listings a multi-day run adds are in `estimateDays`. */
export function orderNeed(items: ReadonlyArray<{ id: string; key: OrderKey }>): OrderNeed {
  const moves = planMoves(items).moves.length
  return { items: items.length, undated: items.filter((i) => i.key.date === null).length, moves, units: moves * UNITS_PER_MOVE }
}

/**
 * Days the backfill takes at `dailyUnits`, spending at most `movesPerRun`
 * moves on a playlist per reading of it (each run reads the playlist again:
 * that is what makes it safe to stop). Infinity when the budget cannot pay
 * for one reading and one move.
 */
export function estimateDays(needs: readonly OrderNeed[], dailyUnits: number, movesPerRun: number): { units: number; days: number } {
  let units = 0
  for (const n of needs) {
    if (n.moves === 0) continue
    units += n.moves * UNITS_PER_MOVE + Math.ceil(n.moves / Math.max(1, movesPerRun)) * listUnits(n.items)
  }
  if (units === 0) return { units: 0, days: 0 }
  return { units, days: dailyUnits >= UNITS_PER_MOVE + 1 ? Math.ceil(units / dailyUnits) : Infinity }
}
