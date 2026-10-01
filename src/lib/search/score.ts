/**
 * Search scoring (spec §9): edit distance for query correction, per-field
 * token matching, and the final rank score the Worker re-ranks FTS recall by.
 * Pure functions over normalized tokens (src/lib/search/normalize.ts).
 */

/**
 * Optimal string alignment distance (Damerau-Levenshtein with adjacent
 * transpositions, no substring edited twice), by code point. Returns
 * `max + 1` as soon as the distance must exceed `max`.
 */
export function damerauLevenshtein(a: string, b: string, max: number): number {
  const s = [...a]
  const t = [...b]
  const n = s.length
  const m = t.length
  if (Math.abs(n - m) > max) return max + 1
  if (n === 0 || m === 0) return Math.max(n, m)
  let prev2 = new Array<number>(m + 1).fill(0)
  let prev = Array.from({ length: m + 1 }, (_, j) => j)
  let cur = new Array<number>(m + 1).fill(0)
  for (let i = 1; i <= n; i++) {
    cur[0] = i
    let rowMin = i
    for (let j = 1; j <= m; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1
      let d = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost)
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) d = Math.min(d, prev2[j - 2]! + 1)
      cur[j] = d
      if (d < rowMin) rowMin = d
    }
    // Every later cell is at least the smallest cell of this row or the one
    // before it (a transposition reaches back two rows), so once both exceed
    // max the distance must too.
    if (rowMin > max && Math.min(...prev) > max) return max + 1
    ;[prev2, prev, cur] = [prev, cur, prev2]
  }
  return prev[m]! > max ? max + 1 : prev[m]!
}

export type MatchKind = 'exact' | 'prefix' | 'corrected'

/** A normalized query word and the terms it may match: itself, itself as a prefix, and vocabulary corrections. */
export type QueryToken = { text: string; variants: Array<{ term: string; kind: MatchKind; distance: number }> }

const EXACT = 1.0
const PREFIX = 0.9
/** A corrected match: 0.7 at distance 1, 0.1 less per further edit. */
const corrected = (distance: number) => Math.max(0, 0.7 - 0.1 * (distance - 1))

/**
 * How well one query token matches a field's tokens: exact 1.0, prefix 0.9,
 * corrected `0.7 - 0.1 × (distance - 1)`; the best variant wins, 0 when none
 * matches.
 */
export function tokenFieldScore(token: QueryToken, fieldTokens: readonly string[]): number {
  let best = 0
  for (const v of token.variants) {
    const score = v.kind === 'exact' ? EXACT : v.kind === 'prefix' ? PREFIX : corrected(v.distance)
    if (score <= best) continue
    const hit = v.kind === 'prefix' ? fieldTokens.some((f) => f.startsWith(v.term)) : fieldTokens.includes(v.term)
    if (hit) best = score
  }
  return best
}

const DAY_HORIZON = 730

/**
 * The rank of one candidate:
 *   base = Σ over tokens of max over fields (tokenFieldScore × weight),
 *   × (matched tokens / tokens)²,
 *   × 1.05 with a YouTube video, × (1 + 0.1 × max(0, 1 - days / 730)) for
 *   recency, × 1.05 when subscribed.
 * A zero base stays zero. A future date counts as today.
 */
export function rankScore(
  tokens: QueryToken[],
  fields: Array<{ tokens: readonly string[]; weight: number }>,
  boosts: { youtube?: boolean; recencyDays?: number | null; subscribed?: boolean },
): number {
  if (tokens.length === 0) return 0
  let base = 0
  let matched = 0
  for (const tok of tokens) {
    let best = 0
    for (const f of fields) {
      const s = tokenFieldScore(tok, f.tokens) * f.weight
      if (s > best) best = s
    }
    if (best > 0) matched++
    base += best
  }
  if (base <= 0) return 0
  let score = base * (matched / tokens.length) ** 2
  if (boosts.youtube) score *= 1.05
  if (boosts.recencyDays != null && Number.isFinite(boosts.recencyDays)) score *= 1 + 0.1 * Math.max(0, 1 - Math.max(0, boosts.recencyDays) / DAY_HORIZON)
  if (boosts.subscribed) score *= 1.05
  return score
}

/** The largest factor the request-dependent boosts (recency, subscribed) can apply. */
export const MAX_LATE_BOOST = 1.1 * 1.05
