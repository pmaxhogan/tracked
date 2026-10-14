/**
 * Set-page graph data for the Graph tab (docs/superpowers/specs/2026-10-14-graph-tab-design.md):
 * the set's sources and heading artists, and per track row its credits
 * (main / featured / remixer artists), label, genre, duration and the base
 * track a remix or rework was made from.
 *
 * Everything comes from links and spans, never from title heuristics:
 *   - sources and heading artists: the links inside `#pageTitle` only (either
 *     `<div id="pageTitle"><h1>` or `<h1 id="pageTitle">`); the page's Hot
 *     Shows / Hot Events modals carry many other `/source/` links.
 *   - a row's credits: the children of `span.trackValue`. Main artists come
 *     before the " - " span, each a `span.notranslate` with its own
 *     `/artist/...` link, split by `span.spLR`; featured artists are the plain
 *     " ft. A & B" text (no link); remixers are the names inside the "(...)"
 *     group, before `span.remixValue` (the version word, "Remix", "Edit").
 *     A remixer's link is either nested in its name span or the next sibling
 *     ("open remixer artist page").
 *   - the base track: the `/track/` link inside the title span when it is not
 *     the row's own id (a remix), or the `fa-recycle` "rework of track A - B"
 *     link after the track value (a rework).
 *
 * The row's own id is the 1001tracklists track PAGE id (`/track/<id>/...`),
 * not the medialink id the rest of the app keys tracks by.
 */
import { parse, type HTMLElement } from "node-html-parser";
import { decodeEntities } from "./html-entities";

export type CreditRole = "main" | "featured" | "remixer";

export type GraphArtistRef = {
  /** Artist key: a slug of the display name (nameSlug). */
  key: string;
  name: string;
  /** The 1001tl artist page path, when the credit links one. */
  path: string | null;
};

export type GraphCredit = GraphArtistRef & { role: CreditRole };

export type GraphBase = {
  pageId: string;
  kind: "remix" | "rework";
  path: string;
  artist: string | null;
  title: string | null;
};

export type GraphRow = {
  pageId: string;
  path: string;
  artist: string;
  title: string;
  label: string | null;
  labelPath: string | null;
  genre: string | null;
  durationSeconds: number | null;
  /** The version word of a "(... Remix)" group: "Remix", "Edit", "Bootleg"; null when none. */
  version: string | null;
  credits: GraphCredit[];
  base: GraphBase | null;
};

export type GraphSource = { id: string; slug: string; name: string };

export type GraphHeadingArtist = GraphArtistRef & {
  /** The DJ page slug (`/dj/<slug>/`) when the heading links one. */
  djSlug: string | null;
};

export type SetGraph = {
  sources: GraphSource[];
  artists: GraphHeadingArtist[];
  rows: GraphRow[];
};

/** A slug of a display name: lowercase, accents folded, runs of other characters to one '-'. */
export function nameSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

const clean = (s: string) => decodeEntities(s).replace(/\s+/g, " ").trim();

/**
 * The artist slug of an `/artist/...` link: `/artist/<slug>/tracks.html`,
 * `/artist/<id>/<slug>/index.html` or `/artist/<slug>/tracklists.html`.
 */
export function artistSlugOf(href: string): string | null {
  const m = /\/artist\/([^?#]+)/.exec(href);
  if (!m) return null;
  const segs = m[1]!.split("/").filter(Boolean);
  if (segs.length >= 2 && /\.(html|php)$/i.test(segs[segs.length - 1]!)) segs.pop();
  const slug = segs[segs.length - 1];
  return slug ? decodeEntities(slug).toLowerCase() : null;
}

/** The page id of a `/track/<id>/<slug>/index.html` link. */
export function trackIdOf(href: string): string | null {
  const m = /\/track\/([A-Za-z0-9]+)\//.exec(href);
  return m ? m[1]! : null;
}

const pathOf = (href: string): string => {
  try {
    return new URL(href, "https://www.1001tracklists.com").pathname;
  } catch {
    return href;
  }
};

/** "PT7M51S" / "PT1H2M3S" in seconds; null when absent or unreadable. */
export function parseIsoDuration(s: string | null | undefined): number | null {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec((s ?? "").trim());
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/** "ID", "ID ID": an unidentified artist, not a credit. */
const isIdName = (n: string) => /^(?:ID\s*)+$/.test(n);

/**
 * An artist credit. Keyed by a slug of the name, not the link: 1001tl links
 * a credit to a combined page now and then ("Lydon" to
 * `/artist/mgnky4/leftfield-&-lydon/`, "Bauchamp" to
 * `round-table-knights-bauchamp`), while the name is what the row shows.
 */
function artistRef(name: string, href: string | null): GraphArtistRef | null {
  const n = clean(name);
  if (!n || isIdName(n)) return null;
  const key = nameSlug(n);
  if (!key) return null;
  return { key, name: n, path: href && artistSlugOf(href) ? pathOf(href) : null };
}

const hasClass = (el: HTMLElement, c: string) =>
  ` ${el.getAttribute("class") ?? ""} `.includes(` ${c} `);

/** The first `/artist/` link inside el, as an href. */
const artistLinkIn = (el: HTMLElement): string | null =>
  el
    .querySelectorAll("a")
    .find((a) => /\/artist\//.test(a.getAttribute("href") ?? ""))
    ?.getAttribute("href") ?? null;

/** The visible text of an element without its link-only children (they hold only an icon). */
const ownText = (el: HTMLElement): string => clean(el.text);

/** "ft. A & B", "feat. A, B and C" -> ["A", "B", "C"]. */
function featuredNames(text: string): string[] {
  const m = /^(?:ft|feat|featuring)\.?\s+(.+)$/i.exec(clean(text));
  if (!m) return [];
  return m[1]!
    .split(/\s*(?:&|,|\band\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Names (each with its link) in a run of elements: a name span carries its
 * link nested or as the next sibling link span; `span.spLR` separates.
 */
function namesIn(els: HTMLElement[]): GraphArtistRef[] {
  const out: Array<{ name: string; href: string | null }> = [];
  for (const el of els) {
    if (el.tagName !== "SPAN") continue;
    if (hasClass(el, "spLR") || hasClass(el, "remixValue")) continue;
    const text = ownText(el);
    const href = artistLinkIn(el);
    if (!text) {
      // A link-only span ("open remixer artist page") belongs to the name before it.
      const last = out[out.length - 1];
      if (href && last && !last.href) last.href = href;
      continue;
    }
    if (featuredNames(text).length) continue;
    out.push({ name: text, href });
  }
  return out.map((n) => artistRef(n.name, n.href)).filter((r): r is GraphArtistRef => !!r);
}

function parseTrackValue(tv: HTMLElement): {
  main: GraphArtistRef[];
  featured: GraphArtistRef[];
  remixers: GraphArtistRef[];
  titleLinkId: string | null;
  titleText: string | null;
  version: string | null;
  lastTrackId: string | null;
} {
  const kids = tv.children;
  const dash = kids.findIndex((k) => k.tagName === "SPAN" && clean(k.text) === "-");
  const before = dash >= 0 ? kids.slice(0, dash) : [];
  const after = dash >= 0 ? kids.slice(dash + 1) : kids;
  const featured: GraphArtistRef[] = [];
  for (const k of before)
    for (const n of featuredNames(ownText(k))) {
      const r = artistRef(n, null);
      if (r) featured.push(r);
    }
  const main = namesIn(before);
  const titleSpan = after[0] ?? null;
  const titleLink = titleSpan
    ?.querySelectorAll("a")
    .map((a) => a.getAttribute("href") ?? "")
    .find((h) => /\/track\//.test(h));
  let version: string | null = null;
  const remixers: GraphArtistRef[] = [];
  for (const g of after.slice(1)) {
    const rv = g.querySelector("span.remixValue");
    if (!rv) continue;
    version = clean(rv.text) || null;
    remixers.push(...namesIn(g.children));
    break;
  }
  const trackLinks = tv
    .querySelectorAll("a")
    .map((a) => a.getAttribute("href") ?? "")
    .filter((h) => /\/track\//.test(h));
  const titleInner = titleSpan?.querySelector("span.notranslate") ?? titleSpan;
  return {
    main,
    featured,
    remixers,
    titleLinkId: titleLink ? trackIdOf(titleLink) : null,
    titleText: titleInner ? clean(titleInner.text) || null : null,
    version,
    lastTrackId: trackLinks.length ? trackIdOf(trackLinks[trackLinks.length - 1]!) : null,
  };
}

function rowLabel(row: HTMLElement): { label: string | null; path: string | null } {
  const pub = row.querySelector('meta[itemprop="publisher"]')?.getAttribute("content");
  const root = pub ? parse(decodeEntities(pub)) : row;
  const names: string[] = [];
  let path: string | null = null;
  for (const l of root.querySelectorAll(".trackLabel")) {
    const n = clean(l.text);
    if (!n || /^not on label$/i.test(n)) continue;
    names.push(n);
    const href = l
      .querySelectorAll("a")
      .find((a) => /\/label\//.test(a.getAttribute("href") ?? ""));
    if (!path && href) path = pathOf(href.getAttribute("href")!);
  }
  return { label: names.length ? names.join(" / ") : null, path };
}

function parseGraphRow(row: HTMLElement): GraphRow | null {
  const fullName = clean(row.querySelector('meta[itemprop="name"]')?.getAttribute("content") ?? "");
  if (!fullName) return null;
  const tv = row.querySelector("span.trackValue");
  const parts = tv ? parseTrackValue(tv) : null;
  const urlMeta = row.querySelector('meta[itemprop="url"]')?.getAttribute("content") ?? "";
  const pageId = trackIdOf(urlMeta) ?? parts?.lastTrackId ?? null;
  if (!pageId) return null;
  const byArtist = clean(
    row.querySelector('meta[itemprop="byArtist"]')?.getAttribute("content") ?? "",
  );
  const dash = fullName.indexOf(" - ");
  const artist = byArtist || (dash >= 0 ? fullName.slice(0, dash).trim() : "");
  const title = dash >= 0 ? fullName.slice(dash + 3).trim() : fullName;

  let base: GraphBase | null = null;
  if (parts?.titleLinkId && parts.titleLinkId !== pageId) {
    const href = tv!
      .querySelectorAll("a")
      .map((a) => a.getAttribute("href") ?? "")
      .find((h) => trackIdOf(h) === parts.titleLinkId)!;
    base = {
      pageId: parts.titleLinkId,
      kind: "remix",
      path: pathOf(href),
      artist: artist || null,
      title: parts.titleText,
    };
  } else {
    const rw = row
      .querySelectorAll("a")
      .find((a) => /^rework of track\b/i.test(a.getAttribute("title") ?? ""));
    const href = rw?.getAttribute("href") ?? "";
    const id = trackIdOf(href);
    if (rw && id && id !== pageId) {
      const name = clean((rw.getAttribute("title") ?? "").replace(/^rework of track\s*/i, ""));
      const d = name.indexOf(" - ");
      base = {
        pageId: id,
        kind: "rework",
        path: pathOf(href),
        artist: d >= 0 ? name.slice(0, d).trim() : null,
        title: d >= 0 ? name.slice(d + 3).trim() : name || null,
      };
    }
  }

  const credits: GraphCredit[] = [];
  const seen = new Set<string>();
  const add = (refs: GraphArtistRef[], role: CreditRole) => {
    for (const r of refs) {
      if (seen.has(`${role}:${r.key}`)) continue;
      seen.add(`${role}:${r.key}`);
      credits.push({ ...r, role });
    }
  };
  if (parts) {
    add(parts.main, "main");
    add(parts.featured, "featured");
    add(parts.remixers, "remixer");
  }
  const { label, path: labelPath } = rowLabel(row);
  return {
    pageId,
    path: pathOf(urlMeta || `/track/${pageId}/`),
    artist,
    title,
    label,
    labelPath,
    genre:
      clean(row.querySelector('meta[itemprop="genre"]')?.getAttribute("content") ?? "") || null,
    durationSeconds: parseIsoDuration(
      row.querySelector('meta[itemprop="duration"]')?.getAttribute("content"),
    ),
    version: parts?.version ?? null,
    credits,
    base,
  };
}

/** The set heading: its sources and its artists (DJ page or artist page links). */
function parseHeading(root: HTMLElement): Pick<SetGraph, "sources" | "artists"> {
  const heading = root.querySelector("#pageTitle");
  const sources: GraphSource[] = [];
  const artists: GraphHeadingArtist[] = [];
  if (!heading) return { sources, artists };
  for (const a of heading.querySelectorAll("a")) {
    const href = a.getAttribute("href") ?? "";
    const name = clean(a.text);
    const src = /\/source\/([A-Za-z0-9]+)\/([^/]+)\//.exec(href);
    if (src) {
      if (name && !sources.some((s) => s.id === src[1]))
        sources.push({ id: src[1]!, slug: src[2]!, name });
      continue;
    }
    const dj = /\/dj\/([^/]+)\//.exec(href);
    if (dj) {
      const r = artistRef(name, null);
      if (r && !artists.some((x) => x.key === r.key)) artists.push({ ...r, djSlug: dj[1]! });
      continue;
    }
    if (/\/artist\//.test(href)) {
      const r = artistRef(name, href);
      if (r && !artists.some((x) => x.key === r.key)) artists.push({ ...r, djSlug: null });
    }
  }
  return { sources, artists };
}

/** Everything the graph keeps from one set page. Rows without a track page id are left out. */
export function parseSetGraph(html: string): SetGraph {
  const root = parse(html);
  const { sources, artists } = parseHeading(root);
  const rows: GraphRow[] = [];
  const seen = new Set<string>();
  for (const row of root.querySelectorAll("div.tlpItem")) {
    const r = parseGraphRow(row);
    if (!r || seen.has(r.pageId)) continue;
    seen.add(r.pageId);
    rows.push(r);
  }
  return { sources, artists, rows };
}
