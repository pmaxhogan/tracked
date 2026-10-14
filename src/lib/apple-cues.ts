/**
 * Apple Music timing backstop, the pure part (spec
 * docs/superpowers/specs/2026-10-14-apple-timing-backstop-design.md).
 *
 * A held mkvid list (under 90 % of its base rows timed, lib/mkvid-readiness.ts)
 * may have an Apple Music "DJ mix" album whose track durations give start
 * offsets. This file matches the list's base rows to the album's tracks
 * (order-aware, fuzzy on names), checks the album is the recording (its total
 * length against the source audio, or the 1001tl cues themselves), and fills
 * ONLY rows with no cue, aligning the Apple offsets to the nearest real cues
 * before and after each gap so drift never accumulates. 1001tl cues stay the
 * truth; unmatched rows stay untimed.
 */

import { formatTime } from "./timestamp";

/** One Apple album track: its name, artist when the source names one, and its length. */
export type AppleTrack = { name: string; artist: string | null; seconds: number };

/** The fields of a stored mkvid row the pass reads (MkvidTrack). `cueFrom` marks a cue this pass filled. */
export type CueRow = {
  cueSeconds: number | null;
  artist: string | null;
  title: string | null;
  isId: boolean;
  layered: boolean;
  cueFrom?: "apple";
};

export type AppleCueOptions = {
  /** Share of base rows that must match an Apple track (settings appleCues.minMatchShare). */
  minMatchShare: number;
  /** Length tolerance: the larger of this percent of the length and `toleranceSeconds`. */
  tolerancePct: number;
  toleranceSeconds: number;
  /** Length of the audio mkvid renders from, when known. */
  sourceSeconds: number | null;
};

export type AppleCuePlan<T extends CueRow> = {
  /** True when at least one cue was filled. */
  used: boolean;
  /** The rows, with filled cues marked `cueFrom: "apple"` (unchanged when not used). */
  tracks: T[];
  filled: number;
  matched: number;
  baseRows: number;
  albumSeconds: number;
  /** Plain words: why the album was or was not used. */
  note: string;
};

const DROP_BRACKET =
  /^(?:mixed|mix|original|original mix|extended|extended mix|extended version|edit|radio edit|club mix|club edit|album version|original version|clean|explicit|vip|intro|outro)$/;
const STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "of",
  "mixed",
  "vs",
  "x",
  "feat",
  "ft",
  "featuring",
]);

const stripAccents = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "");

/** Name tokens for matching: accents, case, feat. clauses, mix-word brackets and punctuation gone; remixer words kept. */
export function nameTokens(s: string | null | undefined): string[] {
  if (!s) return [];
  let t = stripAccents(s).toLowerCase().replace(/&/g, " and ");
  // feat. clauses, in or out of brackets, up to the bracket or the end.
  t = t.replace(/\b(?:feat\.?|ft\.?|featuring)\s+[^()[\]]*/g, " ");
  // Bracketed parts: drop the pure mix words, keep remix credits.
  t = t.replace(/[([]([^()[\]]*)[)\]]/g, (_m, inner: string) => {
    const w = inner
      .replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return DROP_BRACKET.test(w) ? " " : ` ${w} `;
  });
  return t
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w))
    .filter((w, i, a) => a.indexOf(w) === i);
}

function dice(a: readonly string[], b: readonly string[]): number {
  if (!a.length || !b.length) return 0;
  const sb = new Set(b);
  const common = a.filter((w) => sb.has(w)).length;
  return (2 * common) / (a.length + b.length);
}

/** A row that never matches: an ID, no title, or a title that is only "ID". */
export function isUnmatchable(r: Pick<CueRow, "isId" | "title">): boolean {
  if (r.isId || !r.title) return true;
  const t = nameTokens(r.title);
  return t.length === 0 || (t.length === 1 && t[0] === "id");
}

/** Similarity of a 1001tl title to an Apple track name, 0..1; a mashup "A / B" matches either half. */
export function nameSimilarity(title: string, appleName: string): number {
  const a = nameTokens(title);
  const parts = [appleName, ...appleName.split(/\s+\/\s+/)].map(nameTokens);
  let best = 0;
  for (const p of parts) best = Math.max(best, dice(a, p));
  return best;
}

/** A pair counts as a candidate match at this similarity or more. */
export const MATCH_SIMILARITY = 0.6;

/**
 * Order-aware matching: for each base row index (into `rows`), the Apple track
 * index it matched, by a monotone alignment that maximises total similarity
 * (reordered or missing rows just stay unmatched).
 */
export function matchRows(
  rows: readonly CueRow[],
  apple: readonly AppleTrack[],
): Map<number, number> {
  const base = rows.map((r, i) => ({ r, i })).filter((x) => !x.r.layered && !isUnmatchable(x.r));
  const n = base.length;
  const m = apple.length;
  const out = new Map<number, number>();
  if (!n || !m) return out;
  const sim = (bi: number, aj: number) => {
    const s = nameSimilarity(base[bi]!.r.title!, apple[aj]!.name);
    return s >= MATCH_SIMILARITY ? s : 0;
  };
  const W = m + 1;
  const dp = new Float64Array((n + 1) * W);
  const sims = new Float64Array(n * m);
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) {
      const s = sim(i - 1, j - 1);
      sims[(i - 1) * m + (j - 1)] = s;
      const diag = s > 0 ? dp[(i - 1) * W + (j - 1)]! + s : -1;
      dp[i * W + j] = Math.max(dp[(i - 1) * W + j]!, dp[i * W + (j - 1)]!, diag);
    }
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const s = sims[(i - 1) * m + (j - 1)]!;
    if (s > 0 && dp[i * W + j] === dp[(i - 1) * W + (j - 1)]! + s) {
      out.set(base[i - 1]!.i, j - 1);
      i--;
      j--;
    } else if (dp[(i - 1) * W + j] === dp[i * W + j]) i--;
    else j--;
  }
  return out;
}

/** The larger of `pct` percent of `seconds` and `minSeconds`. */
export function tolerance(seconds: number, pct: number, minSeconds: number): number {
  return Math.max((Math.abs(seconds) * pct) / 100, minSeconds);
}

const realCue = (r: CueRow): number | null =>
  r.cueFrom !== "apple" && typeof r.cueSeconds === "number" && Number.isFinite(r.cueSeconds)
    ? r.cueSeconds
    : null;

/** The rows with any earlier Apple-filled cue taken out again. */
export function withoutAppleCues<T extends CueRow>(rows: readonly T[]): T[] {
  return rows.map((r) => {
    if (r.cueFrom !== "apple") return r;
    const { cueFrom: _drop, ...rest } = r;
    return { ...rest, cueSeconds: null } as T;
  });
}

/**
 * Decide and fill. `rows` must already be free of Apple cues (withoutAppleCues).
 * Returns the rows unchanged with a note when the album is not used.
 */
export function planAppleCues<T extends CueRow>(
  rows: readonly T[],
  apple: readonly AppleTrack[],
  opts: AppleCueOptions,
): AppleCuePlan<T> {
  const albumSeconds = apple.reduce((s, t) => s + t.seconds, 0);
  const baseIdx = rows.map((r, i) => (r.layered && i > 0 ? -1 : i)).filter((i) => i >= 0);
  const baseRows = baseIdx.length;
  const keep = (note: string, matched = 0): AppleCuePlan<T> => ({
    used: false,
    tracks: [...rows],
    filled: 0,
    matched,
    baseRows,
    albumSeconds,
    note,
  });
  if (!apple.length || !baseRows) return keep("the Apple Music album has no tracks");
  const match = matchRows(rows, apple);
  const matched = match.size;
  const needPct = Math.round(opts.minMatchShare * 100);
  if (matched * 100 < needPct * baseRows)
    return keep(
      `weak match: ${matched} of ${baseRows} tracks matched the Apple Music album (${needPct}% needed)`,
      matched,
    );

  const offsets: number[] = [];
  apple.reduce((s, t) => (offsets.push(s), s + t.seconds), 0);
  const tol = (x: number) => tolerance(x, opts.tolerancePct, opts.toleranceSeconds);

  // Anchors: matched base rows with a real cue, in row order; row 0 always (cue 0, or its own).
  type Anchor = { row: number; cue: number; offset: number };
  const anchors: Anchor[] = [];
  const row0Match = match.get(0);
  anchors.push({
    row: 0,
    cue: realCue(rows[0]!) ?? 0,
    offset: row0Match != null ? offsets[row0Match]! : 0,
  });
  for (const i of baseIdx) {
    if (i === 0) continue;
    const c = realCue(rows[i]!);
    const k = match.get(i);
    if (c !== null && k != null) anchors.push({ row: i, cue: c, offset: offsets[k]! });
  }

  // Is the album the recording?
  if (opts.sourceSeconds != null && opts.sourceSeconds > 0) {
    if (Math.abs(albumSeconds - opts.sourceSeconds) > tol(opts.sourceSeconds))
      return keep(
        `length mismatch: album ${formatTime(albumSeconds)} vs source ${formatTime(opts.sourceSeconds)}`,
        matched,
      );
  } else {
    const lastReal = Math.max(0, ...baseIdx.map((i) => realCue(rows[i]!) ?? 0));
    const gapsAgree = anchors
      .slice(1)
      .every(
        (b, x) =>
          Math.abs(b.cue - anchors[x]!.cue - (b.offset - anchors[x]!.offset)) <=
          tol(b.cue - anchors[x]!.cue),
      );
    if (anchors.length < 2 || albumSeconds < lastReal || !gapsAgree)
      return keep(
        anchors.length < 2
          ? "source length unknown and no cue time confirms the Apple Music album"
          : albumSeconds < lastReal
            ? `album ${formatTime(albumSeconds)} is shorter than the last cue ${formatTime(lastReal)}`
            : "source length unknown and the cue times do not agree with the Apple Music album",
        matched,
      );
  }

  // Fill: each uncued matched base row from the anchors around it.
  const out = [...rows];
  let filled = 0;
  for (const i of baseIdx) {
    if (i === 0 || realCue(rows[i]!) !== null) continue;
    const k = match.get(i);
    if (k == null) continue;
    const o = offsets[k]!;
    let a: Anchor | undefined;
    let b: Anchor | undefined;
    for (const an of anchors) {
      if (an.row < i) a = an;
      else if (an.row > i) {
        b = an;
        break;
      }
    }
    if (!a) continue;
    let cue: number;
    if (b && b.offset > a.offset && b.cue > a.cue)
      cue = a.cue + ((o - a.offset) * (b.cue - a.cue)) / (b.offset - a.offset);
    else if (!b) cue = a.cue + (o - a.offset);
    else continue;
    cue = Math.round(cue);
    // Strictly between the nearest real cues around it (matched or not).
    let lo = -1;
    let hi = Infinity;
    for (const j of baseIdx) {
      const c = j === 0 ? (realCue(rows[0]!) ?? 0) : realCue(rows[j]!);
      if (c === null) continue;
      if (j < i) lo = Math.max(lo, c);
      else if (j > i) hi = Math.min(hi, c);
    }
    if (!(cue > lo && cue < hi)) continue;
    out[i] = { ...rows[i]!, cueSeconds: cue, cueFrom: "apple" };
    filled++;
  }
  if (!filled)
    return keep("the Apple Music album matched, but no untimed track could be placed", matched);
  return {
    used: true,
    tracks: out,
    filled,
    matched,
    baseRows,
    albumSeconds,
    note: `${filled} cue${filled === 1 ? "" : "s"} from Apple Music (${matched} of ${baseRows} tracks matched, album ${formatTime(albumSeconds)})`,
  };
}
