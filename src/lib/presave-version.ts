/**
 * Version credits in track titles, for pre-save matching (lib/presave-match.ts):
 * "Around The World (La La La La La) (Odd Mob Remix)" is the Odd Mob remix,
 * and an upload titled "(Edmood Remix)", "(Slowed & Reverb)" or with no credit
 * at all (the original) is another recording, whatever the rest of the name
 * says. Pure functions; no I/O.
 *
 * A title is cut into pieces at brackets and " - "; the first piece is the
 * song (or the uploader's "Artist - " prefix) and is never a credit. A later
 * piece is a version credit when it holds a version word (remix, edit, vip,
 * bootleg, rework, flip, mix, dub, refix...) or an alteration (slowed, reverb,
 * sped up, nightcore, bass boosted, 8d). What is left of the piece after the
 * version words and filler ("loves", "x", "feat", years) is the credit: the
 * remixer / editor. A piece whose only words are variant words ("Original
 * Mix", "Extended Mix", "Radio Edit", "Club Mix") is the same version in
 * another length, not another version.
 */

const KIND_WORDS = new Set([
  "remix",
  "rmx",
  "edit",
  "reedit",
  "vip",
  "bootleg",
  "rework",
  "flip",
  "mix",
  "dub",
  "refix",
  "remake",
  "version",
  "remaster",
  "remastered",
  "cover",
]);
/** Alterations of a recording: never the same version unless the pre-save says so too. */
const ALTERED = new Map<string, string>([
  ["slowed", "slowed"],
  ["reverb", "reverb"],
  ["sped", "sped up"],
  ["speed", "sped up"],
  ["nightcore", "nightcore"],
  ["boosted", "bass boosted"],
  ["8d", "8d"],
  ["daycore", "daycore"],
]);
/** Words that only say which length / cut of the same version it is. */
const VARIANT_WORDS = new Set([
  "original",
  "extended",
  "radio",
  "club",
  "mix",
  "edit",
  "version",
  "clean",
  "explicit",
  "short",
  "long",
  "full",
  "remaster",
  "remastered",
  "official",
  "audio",
  "video",
  "lyric",
  "lyrics",
  "visualizer",
  "hd",
  "hq",
]);
/** Filler inside a credit. */
const FILLER = new Set([
  "loves",
  "x",
  "and",
  "feat",
  "ft",
  "featuring",
  "the",
  "pres",
  "presents",
  "s",
  "up",
  "bass",
  "free",
  "re",
  "dj",
  "official",
  "audio",
  "video",
  "extended",
  "radio",
  "club",
  "original",
]);
const MASHUP = new Set(["mashup", "megamix", "medley", "megamashup"]);

const words = (s: string): string[] =>
  s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/re-edit/g, "reedit")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

export type VersionPiece = {
  /** The piece as written ("Odd Mob Remix"). */
  raw: string;
  /** The remixer / editor words ("odd", "mob"); empty for a plain variant or alteration. */
  credit: string[];
  /** Alterations it names ("slowed", "reverb"). */
  altered: string[];
};

export type Version = {
  /** Pieces that credit someone (a remix, an edit, a bootleg...). */
  credited: VersionPiece[];
  /** Every alteration named anywhere after the song piece. */
  altered: Set<string>;
  /** No credit and no alteration: the original (any length of it). */
  original: boolean;
  /** A megamix / mashup / medley ("vs." or "mashup" in a credit piece). */
  mashup: boolean;
};

/** Pieces after the first: bracket contents, the text between and after brackets, and " - " parts. */
export function titlePieces(title: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of title) {
    if (ch === "(" || ch === "[" || ch === "{") {
      if (depth === 0) {
        out.push(cur);
        cur = "";
      } else cur += " ";
      depth++;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        out.push(cur);
        cur = "";
      } else cur += " ";
    } else cur += ch;
  }
  out.push(cur);
  const pieces = out
    .flatMap((p) => p.split(/\s+[-\u2013\u2014|]\s+|\s+\/\s+/))
    .map((p) => p.trim());
  return pieces.filter(Boolean).slice(1);
}

/** The song part of a title: before any bracket, after an uploader's "Artist - " prefix. */
function songPart(title: string): string {
  const head = title.split(/[([{]/)[0] ?? "";
  const parts = head.split(/\s+[-\u2013\u2014|]\s+/);
  return parts[parts.length - 1] ?? "";
}

export function parseVersion(title: string | null | undefined): Version {
  const v: Version = { credited: [], altered: new Set(), original: true, mashup: false };
  const t = title ?? "";
  // "A vs. B", "mashup" / "megamix" anywhere, or two songs joined by " x " in the song part.
  if (/\bvs\.?\s/i.test(t) || words(t).some((w) => MASHUP.has(w)) || /\s[xX]\s/.test(songPart(t)))
    v.mashup = true;
  for (const raw of titlePieces(t)) {
    const ws = words(raw);
    if (!ws.length) continue;
    const altered = ws.map((w) => ALTERED.get(w)).filter((x): x is string => !!x);
    const hasKind = ws.some((w) => KIND_WORDS.has(w));
    for (const a of altered) v.altered.add(a);
    if (!hasKind && !altered.length) continue;
    const credit = ws.filter(
      (w) =>
        !KIND_WORDS.has(w) &&
        !VARIANT_WORDS.has(w) &&
        !FILLER.has(w) &&
        !ALTERED.has(w) &&
        !/^(19|20)\d\d$/.test(w) &&
        w !== "remixed",
    );
    if (hasKind && credit.length) v.credited.push({ raw: raw.trim(), credit, altered });
  }
  v.original = v.credited.length === 0 && v.altered.size === 0;
  return v;
}

/** Same remixer: most of the shorter credit's words are in the other ("Odd Mob" ~ "Odd Mob Loves California"). */
export function sameCredit(a: readonly string[], b: readonly string[]): boolean {
  if (!a.length || !b.length) return false;
  const B = new Set(b);
  const shared = a.filter((w) => B.has(w)).length;
  return shared >= 1 && shared / Math.min(a.length, b.length) >= 0.6;
}

const describe = (v: Version): string =>
  v.credited.length
    ? v.credited.map((p) => p.raw).join(" / ")
    : v.altered.size
      ? [...v.altered].join(" & ")
      : "the original";

export type VersionVerdict =
  | { ok: true }
  /** The candidate has no credit while the pre-save is a remix / edit: only audio can say it is the one. */
  | { ok: false; kind: "original"; reason: string }
  | { ok: false; kind: "different" | "mashup"; reason: string };

/** Is `cand` the version `want` names? */
export function compareVersions(
  wantTitle: string | null | undefined,
  candTitle: string | null | undefined,
): VersionVerdict {
  const want = parseVersion(wantTitle);
  const have = parseVersion(candTitle);
  if (have.mashup && !want.mashup)
    return { ok: false, kind: "mashup", reason: `a mashup / megamix, wanted ${describe(want)}` };
  const extraAltered = [...have.altered].filter((a) => !want.altered.has(a));
  if (extraAltered.length)
    return {
      ok: false,
      kind: "different",
      reason: `different version: ${have.credited.length ? describe(have) + " " : ""}${extraAltered.join(" & ")}, wanted ${describe(want)}`,
    };
  if (want.credited.length) {
    if (!have.credited.length)
      return {
        ok: false,
        kind: "original",
        reason: `no version credit (the original?), wanted ${describe(want)}`,
      };
    const match = want.credited.some((w) =>
      have.credited.some((h) => sameCredit(w.credit, h.credit)),
    );
    if (!match)
      return {
        ok: false,
        kind: "different",
        reason: `different version: ${describe(have)}, wanted ${describe(want)}`,
      };
    return { ok: true };
  }
  if (have.credited.length)
    return {
      ok: false,
      kind: "different",
      reason: `different version: ${describe(have)}, wanted the original`,
    };
  return { ok: true };
}
