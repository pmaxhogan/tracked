/**
 * Everything else a 1001tracklists set page or track page says, kept "in case
 * it ends up useful later" (disk is cheap). Two halves:
 *
 *   - Parsers, pure: `parseSetMeta` (a `/tracklist/` page) and
 *     `parseTrackMeta` (a `/track/` page). The structured part the app
 *     queries (a set's genres) comes out typed; the rest goes into a JSON
 *     document whose shape may grow without a migration (`META_FORMAT`).
 *   - Storage (migration 0033): `set_meta` (one row per set URL: genres as a
 *     JSON array of names, the JSON document), `set_genres` (set x genre, the
 *     index the genre playlists and the Genres page read) and `track_meta`
 *     (one row per track page id).
 *
 * Where the data comes from, without one extra 1001tracklists request:
 *   - every set page the app fetches (sync, rechecks, verification, the
 *     catch-ups, the phone, the Set page, a purge, a pre-save check) goes
 *     through `saveSetFacts` / `recordPageFacts` (lib/playlist-hygiene.ts),
 *     which call `recordSetMeta` beside them;
 *   - every track page the app fetches (the pre-save track lookup, the
 *     Recommended sets crawl's page 1) calls `recordTrackMeta`;
 *   - sets fetched before this existed: the stored pages in R2
 *     (lib/page-store.ts; `clean/` keeps 30 days and every set was fetched in
 *     the 30 days before this shipped) are read a few per cron tick by
 *     `setMetaPagesStep`, no pool fetch; the rest fill in on their next
 *     normal fetch.
 *
 * Set-level facts are real on a decoy page too (1001tracklists randomizes
 * track names only, the page chrome is real), so they are stored whatever the
 * verdict. The per-row part (`rows`: credits, labels, genres, lengths) is
 * stored only from a page whose rows all agree with themselves.
 */
import { parse, type HTMLElement } from "node-html-parser";
import type { Env } from "../types";
import { decodeEntities } from "./html-entities";
import { errorFields, type Logger } from "./log";
import { gunzipToText, SCRUB_NOTE } from "./page-store";
import { isNearMismatch } from "./tracklists1001";
import { nameSlug, parseIsoDuration, parseSetGraph, type GraphRow } from "./tracklist-credits";

/** Bump when the document gains a field worth re-reading stored pages for. */
export const META_FORMAT = 1;

const ORIGIN = "https://www.1001tracklists.com";

const clean = (s: string | null | undefined) =>
  decodeEntities(s ?? "")
    .replace(/\s+/g, " ")
    .trim();

const cleanOrNull = (s: string | null | undefined): string | null => clean(s) || null;

const num = (s: string | null | undefined): number | null => {
  const m = /-?\d[\d,.]*/.exec(s ?? "");
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

/** "50 minutes 41 seconds", "1 hour 2 minutes" in seconds; null when unreadable. */
export function parseWordsDuration(s: string | null | undefined): number | null {
  const t = (s ?? "").toLowerCase();
  let total = 0;
  let seen = false;
  for (const [re, mul] of [
    [/(\d+)\s*h(?:ours?|rs?)?\b/, 3600],
    [/(\d+)\s*m(?:in(?:utes?|s)?)?\b/, 60],
    [/(\d+)\s*s(?:ec(?:onds?|s)?)?\b/, 1],
  ] as const) {
    const m = re.exec(t);
    if (m) {
      total += Number(m[1]) * mul;
      seen = true;
    }
  }
  return seen ? total : null;
}

/** "[50:41]" / "[1:02:03]" in seconds. */
function bracketSeconds(s: string): number | null {
  const m = /\[(\d+(?::\d{2}){1,2})\]/.exec(s);
  if (!m) return null;
  return m[1]!.split(":").reduce((a, p) => a * 60 + Number(p), 0);
}

const pathOf = (href: string | null | undefined): string | null => {
  if (!href) return null;
  try {
    const u = new URL(decodeEntities(href), ORIGIN);
    return u.origin === ORIGIN ? u.pathname : u.toString();
  } catch {
    return null;
  }
};

export type Genre = { name: string; key: string };

export type LinkRef = { label: string; href: string };

export type MediaLink = {
  /** 1001tracklists' media id (`data-idmedia`). */
  id: string;
  /** Its source id (`data-idsource`): 13 YouTube, 10 SoundCloud, 1 Beatport, 2 Apple, 36 Spotify, 4 Traxsource, ... */
  source: string;
  /** The tab's name ("YouTube", "SoundCloud"). */
  sourceName: string | null;
  /** The player tab's label ("Player 1 [50:41]"). */
  label: string | null;
  seconds: number | null;
  official: boolean;
  /** The id the site's player uses (YouTube video id, SoundCloud track id, Beatport id, ...). */
  externalId: string | null;
  /** The player iframe's URL. */
  src: string | null;
};

export type InfoBox = {
  title: string;
  /** Path of the box heading's link (an artist page), when it has one. */
  path: string | null;
  country: string | null;
  links: LinkRef[];
  /** `StatisticUpdater` object / item ids (2 = artist, 3 = source). */
  object: number | null;
  item: string | null;
};

export type VideoMeta = {
  durationSeconds: number | null;
  description: string | null;
  uploadDate: string | null;
  embedUrl: string | null;
  thumbnailUrl: string | null;
};

export type SetMetaDoc = {
  format: number;
  /** The tracklist id (`/tracklist/<id>/`). */
  tlId: string | null;
  /** The site's numeric item id for the list. */
  itemId: string | null;
  name: string | null;
  /** The set's date (microdata datePublished: when it was played). */
  date: string | null;
  numTracks: number | null;
  /** Microdata author: the set's main artist. */
  author: string | null;
  isLive: boolean | null;
  genres: Genre[];
  /** The page title's links. */
  headingArtists: Array<LinkRef & { djSlug: string | null }>;
  headingSources: Array<LinkRef & { id: string }>;
  /** The General Information table as the page writes it (label -> text). */
  info: Record<string, string>;
  postedBy: { name: string; path: string | null; score: string | null } | null;
  postedAt: string | null;
  updatedAt: string | null;
  views: number | null;
  likes: number | null;
  ided: number | null;
  total: number | null;
  durationSeconds: number | null;
  shortLink: string | null;
  /** The boxes under the actions: the artists (country, contact links) and the sources (event, venue). */
  boxes: InfoBox[];
  media: MediaLink[];
  video: VideoMeta | null;
  /** The note above the list ("Currently no (full) recording available ..."). */
  notice: string | null;
  description: string | null;
  image: string | null;
  /** Per-row data (credits, label, genre, length), only from a page that passed the decoy check. */
  rows?: GraphRow[];
};

export type TrackMetaDoc = {
  format: number;
  pageId: string | null;
  /** The site's numeric track id (Save to Spotify / media submitter). */
  itemId: string | null;
  name: string | null;
  artist: string | null;
  title: string | null;
  /** "(Danny Howard Re-Edit)": who and what kind of version, from the heading. */
  version: string | null;
  headingArtists: LinkRef[];
  label: { name: string; path: string | null; country: string | null; links: LinkRef[] } | null;
  labels: LinkRef[];
  genre: string | null;
  durationSeconds: number | null;
  bpm: number | null;
  releaseYear: number | null;
  artwork: string | null;
  remixOf: (LinkRef & { pageId: string | null }) | null;
  /** "Total Tracklist Plays: 61x". */
  plays: number | null;
  /** The number badge next to the title (how many tracklists list it). */
  tracklists: number | null;
  firstPlayed: { title: string; path: string; date: string | null } | null;
  lastPlayed: { title: string; path: string; date: string | null } | null;
  djSupport: number | null;
  supporters: LinkRef[];
  credits: Array<LinkRef & { country: string | null }>;
  media: MediaLink[];
  video: VideoMeta | null;
  songstats: string | null;
  shortLink: string | null;
  description: string | null;
};

// --- shared pieces -------------------------------------------------------------

function metaContent(root: HTMLElement, sel: string): string | null {
  return cleanOrNull(root.querySelector(sel)?.getAttribute("content"));
}

/** Genre display name -> its /genre/<slug>/ key, from the page's own genre menu. */
function genreKeys(root: HTMLElement): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of root.querySelectorAll('a[href^="/genre/"]')) {
    const m = /^\/genre\/([^/]+)\//.exec(a.getAttribute("href") ?? "");
    const name = clean(a.text);
    if (m && name) out.set(name.toLowerCase(), decodeEntities(m[1]!).toLowerCase());
  }
  return out;
}

/** A genre's key: the site's own slug when the page names it, else a slug of the name. */
export function genreKeyOf(name: string, known?: Map<string, string>): string {
  return known?.get(name.toLowerCase()) ?? nameSlug(name.replace(/'/g, ""));
}

function mediaLinks(root: HTMLElement): MediaLink[] {
  const tabNames = new Map<string, string>();
  for (const t of root.querySelectorAll("div.tBtn.mediaTab")) {
    const m = /'mediaTab(\d+)'\)/.exec(t.getAttribute("onclick") ?? "");
    const name = clean(t.querySelector(".mediaTabTxt")?.text);
    if (m && name) tabNames.set(m[1]!, name);
  }
  const out: MediaLink[] = [];
  for (const d of root.querySelectorAll("div.mediaLink[data-idmedia]")) {
    const id = d.getAttribute("data-idmedia") ?? "";
    if (!id) continue;
    const source = d.getAttribute("data-idsource") ?? "";
    const btn = root.querySelector(`#mediaLinkBtn${id}`);
    const label = cleanOrNull(btn?.text);
    const ext = /\bmediaItem(\S+)/.exec(d.getAttribute("class") ?? "")?.[1] ?? null;
    const src = d.querySelector("iframe")?.getAttribute("src") ?? null;
    out.push({
      id,
      source,
      sourceName: tabNames.get(source) ?? null,
      label,
      seconds: label ? bracketSeconds(label) : null,
      official: !!btn?.querySelector('i[title="official link"]'),
      externalId: ext,
      src: src ? decodeEntities(src) : null,
    });
  }
  return out;
}

function videoMeta(root: HTMLElement): VideoMeta | null {
  const v = root.querySelector('[itemtype="https://schema.org/VideoObject"]');
  if (!v) return null;
  return {
    durationSeconds: parseIsoDuration(metaContent(v, 'meta[itemprop="duration"]')),
    description: metaContent(v, 'meta[itemprop="description"]'),
    uploadDate: metaContent(v, 'meta[itemprop="uploadDate"]'),
    embedUrl: metaContent(v, 'meta[itemprop="embedUrl"]'),
    thumbnailUrl: metaContent(v, 'meta[itemprop="thumbnailUrl"]'),
  };
}

/** The "X Link" anchors of a box (contact links). */
function contactLinks(el: HTMLElement): LinkRef[] {
  const out: LinkRef[] = [];
  for (const a of el.querySelectorAll("a[title]")) {
    const t = a.getAttribute("title") ?? "";
    const href = a.getAttribute("href") ?? "";
    if (!/ Link$/i.test(t) || !/^https?:/i.test(href)) continue;
    out.push({ label: clean(t.replace(/ Link$/i, "")), href: decodeEntities(href).trim() });
  }
  return out;
}

const flagOf = (el: HTMLElement | null | undefined): string | null => {
  const img = el?.querySelector("img.flag");
  if (!img) return null;
  return cleanOrNull(
    (img.getAttribute("title") ?? img.getAttribute("alt") ?? "").replace(/^Home Country\s+/i, ""),
  );
};

/** The first `idItem: '123'` / `idItem: 123` of an onclick on the page. */
function itemIdOf(html: string, object: string): string | null {
  const re = new RegExp(`idObject:\\s*'?${object}'?,\\s*idItem:\\s*'?(\\d+)'?`);
  return re.exec(html)?.[1] ?? null;
}

// --- set pages -----------------------------------------------------------------

/** The `meta[itemprop=prop]` children of `el` itself (not of its rows), in order. */
function ownMetas(el: HTMLElement | null, prop: string): string[] {
  const out: string[] = [];
  for (const n of el?.childNodes ?? []) {
    const m = n as HTMLElement;
    if (m.tagName !== "META" || m.getAttribute?.("itemprop") !== prop) continue;
    const v = clean(m.getAttribute("content"));
    if (v) out.push(v);
  }
  return out;
}

const ownMeta = (el: HTMLElement | null, prop: string): string | null =>
  ownMetas(el, prop)[0] ?? null;

/** The set-level genres: the `meta[itemprop=genre]` that are children of #tlTab (each row has its own), else the Genre(s) box. */
function setGenres(root: HTMLElement): Genre[] {
  const known = genreKeys(root);
  const names = ownMetas(root.querySelector("#tlTab"), "genre").filter(
    (g) => g.toLowerCase() !== "tracklist",
  );
  if (names.length === 0) {
    const box = clean(root.querySelector("#tl_music_styles")?.text);
    if (box) names.push(...box.split(/\s*,\s*/).filter(Boolean));
  }
  const out: Genre[] = [];
  for (const name of names) {
    const key = genreKeyOf(name, known);
    if (key && !out.some((g) => g.key === key)) out.push({ name, key });
  }
  return out;
}

function generalInfo(root: HTMLElement): {
  info: Record<string, string>;
  values: Map<string, HTMLElement>;
} {
  const info: Record<string, string> = {};
  const values = new Map<string, HTMLElement>();
  const tab = root.querySelectorAll("#csLeft div.sTab")[0];
  if (!tab) return { info, values };
  const kids = tab.children;
  for (let i = 0; i + 1 < kids.length; i += 2) {
    const k = clean(kids[i]!.text);
    if (!k) continue;
    info[k] = clean(kids[i + 1]!.text);
    values.set(k.toLowerCase(), kids[i + 1]!);
  }
  return { info, values };
}

function infoBoxes(root: HTMLElement, skipFirst: boolean): InfoBox[] {
  const out: InfoBox[] = [];
  const tabs = root.querySelectorAll("#csLeft > div.fTab");
  for (const [i, t] of tabs.entries()) {
    if (skipFirst && i === 0) continue;
    const h = t.querySelector("div.h");
    if (!h) continue;
    const title = clean(h.text);
    if (!title) continue;
    const su = /idObject:(\d+),idItem:(\d+)/.exec(
      t.querySelector("summary[onclick]")?.getAttribute("onclick") ?? "",
    );
    out.push({
      title,
      path: pathOf(h.querySelector("a")?.getAttribute("href")),
      country: flagOf(h),
      links: contactLinks(t),
      object: su ? Number(su[1]) : null,
      item: su?.[2] ?? null,
    });
  }
  return out;
}

/** Everything a set page says beyond what the app already keeps. Pure; never throws on odd markup. */
export function parseSetMeta(
  url: string,
  html: string,
  opts: { rows?: boolean | "trusted" } = {},
): SetMetaDoc {
  const root = parse(html);
  const tab = root.querySelector("#tlTab");
  const { info, values } = generalInfo(root);
  const val = (k: string) => values.get(k.toLowerCase()) ?? null;
  const posted = val("Posted by");
  const postedLink = posted?.querySelector("a");
  const ided = /(\d+|all)\s*\/\s*(\d+)/i.exec(info["IDed"] ?? "");
  const total = ided ? Number(ided[2]) : null;
  const headingArtists: SetMetaDoc["headingArtists"] = [];
  const headingSources: SetMetaDoc["headingSources"] = [];
  for (const a of root.querySelector("#pageTitle")?.querySelectorAll("a") ?? []) {
    const href = a.getAttribute("href") ?? "";
    const label = clean(a.text);
    if (!label) continue;
    const src = /\/source\/([A-Za-z0-9]+)\//.exec(href);
    if (src) headingSources.push({ label, href: pathOf(href) ?? href, id: src[1]! });
    else if (/\/(artist|dj)\//.test(href))
      headingArtists.push({
        label,
        href: pathOf(href) ?? href,
        djSlug: /\/dj\/([^/]+)\//.exec(href)?.[1] ?? null,
      });
  }
  const doc: SetMetaDoc = {
    format: META_FORMAT,
    tlId: tab?.getAttribute("data-id") ?? /\/tracklist\/([a-z0-9]+)\//i.exec(url)?.[1] ?? null,
    itemId: /idObject:\s*'1',\s*idItem:\s*'(\d+)'/.exec(html)?.[1] ?? null,
    name: ownMeta(tab, "name"),
    date: ownMeta(tab, "datePublished"),
    numTracks: num(ownMeta(tab, "numTracks")),
    author: ownMeta(tab, "author"),
    isLive: tab?.getAttribute("data-islive") ? tab.getAttribute("data-islive") === "true" : null,
    genres: setGenres(root),
    headingArtists,
    headingSources,
    info,
    postedBy: postedLink
      ? {
          name: clean(postedLink.text),
          path: pathOf(postedLink.getAttribute("href")),
          score: cleanOrNull(posted?.querySelector("span")?.text)?.replace(/[()]/g, "") ?? null,
        }
      : null,
    postedAt: cleanOrNull(val("Posted at")?.querySelector("time")?.getAttribute("datetime")),
    updatedAt: cleanOrNull(val("Last update")?.querySelector("time")?.getAttribute("datetime")),
    views: num(info["Views"]),
    likes: num(info["Likes"]),
    ided: ided ? (ided[1]!.toLowerCase() === "all" ? total : Number(ided[1])) : null,
    total,
    durationSeconds: parseWordsDuration(info["Duration"]),
    shortLink: cleanOrNull(val("Short link")?.querySelector("a")?.getAttribute("href")),
    boxes: infoBoxes(root, true),
    media: mediaLinks(root),
    video: videoMeta(root),
    notice: cleanOrNull(root.querySelector("#tlTab div.bItmH")?.text),
    description: metaContent(root, 'meta[name="description"]'),
    image: metaContent(root, 'meta[property="og:image"]'),
  };
  if (opts.rows === true || (opts.rows === "trusted" && rowsTrusted(root)))
    doc.rows = parseSetGraph(html).rows;
  return doc;
}

const normName = (s: string) => clean(s).toLowerCase();

/**
 * Whether a page's rows can be kept: no row whose microdata name and visible
 * text disagree in substance (the decoy check of lib/tracklists1001.ts, made
 * here on the same parse instead of parsing the page a second time).
 */
export function rowsTrusted(root: HTMLElement): boolean {
  for (const row of root.querySelectorAll("div.tlpItem")) {
    const meta = normName(
      row.querySelector('meta[itemprop="name"]')?.getAttribute("content") ?? "",
    );
    const visible = normName(row.querySelector("span.trackValue")?.text ?? "");
    if (meta && visible && meta !== visible && !isNearMismatch(meta, visible)) return false;
  }
  return true;
}

// --- track pages ---------------------------------------------------------------

/** The `.h` heading -> the element after it, for the track page's left column. */
function sections(root: HTMLElement): Map<string, HTMLElement> {
  const out = new Map<string, HTMLElement>();
  for (const h of root.querySelectorAll("#csLeft div.h")) {
    const k = clean(h.text).toLowerCase();
    const next = h.nextElementSibling;
    if (k && next && !out.has(k)) out.set(k, next);
  }
  return out;
}

function playedRow(el: HTMLElement | undefined): TrackMetaDoc["firstPlayed"] {
  const a = el?.querySelector('a[href*="/tracklist/"]');
  if (!a) return null;
  return {
    title: clean(a.text),
    path: pathOf(a.getAttribute("href")) ?? "",
    date:
      /\d{4}-\d{2}-\d{2}/.exec(clean(el?.querySelector('[title="tracklist date"]')?.text))?.[0] ??
      null,
  };
}

/** Everything a track page says. Pure; never throws on odd markup. */
export function parseTrackMeta(url: string, html: string): TrackMetaDoc {
  const root = parse(html);
  const rec = root.querySelector('[itemtype="http://schema.org/MusicRecording"]') ?? root;
  const heading = root.querySelector("#pageTitle");
  const sec = sections(root);
  const desc = metaContent(root, 'meta[property="og:description"]');
  const headingArtists: LinkRef[] = [];
  const labels: LinkRef[] = [];
  let titleLink: string | null = null;
  for (const a of heading?.querySelectorAll("a") ?? []) {
    const href = a.getAttribute("href") ?? "";
    if (/\/artist\//.test(href))
      headingArtists.push({ label: clean(a.text), href: pathOf(href) ?? href });
    else if (/\/label\//.test(href))
      labels.push({ label: clean(a.text), href: pathOf(href) ?? href });
    else if (/\/track\//.test(href) && !titleLink) titleLink = href;
  }
  const headText = clean(heading?.text);
  const name = metaContent(rec, 'meta[itemprop="name"]') ?? (headText || null);
  const dash = name ? name.indexOf(" - ") : -1;
  const labelHead = root.querySelectorAll("#csLeft div.h").find((h) => clean(h.text) === "Label");
  const labelEl = labelHead?.nextElementSibling ?? null;
  const labelA = labelEl?.querySelector('a[href*="/label/"]');
  let labelLinks: LinkRef[] = [];
  for (
    let n = labelEl?.nextElementSibling;
    n && !n.classList?.contains("h");
    n = n.nextElementSibling
  )
    labelLinks = labelLinks.concat(contactLinks(n));
  const remix = sec.get("remix of")?.querySelector('a[href*="/track/"]');
  const statsText = clean(sec.get("statistics")?.text);
  const supportHead = root
    .querySelectorAll("#csLeft div.h")
    .find((h) => /DJ support/i.test(clean(h.text)));
  const supportEl = supportHead?.nextElementSibling;
  const firstHead = root
    .querySelectorAll("#csLeft div.h")
    .find((h) => clean(h.text) === "First Played");
  const lastHead = root
    .querySelectorAll("#csLeft div.h")
    .find((h) => clean(h.text) === "Last Played");
  const credits: TrackMetaDoc["credits"] = [];
  for (const b of root.querySelectorAll("#csLeft div.tB")) {
    const a = b.querySelector("div.hl a");
    if (a)
      credits.push({
        label: clean(a.text),
        href: pathOf(a.getAttribute("href")) ?? "",
        country: flagOf(b.querySelector("div.hl")),
      });
  }
  let bare = headText;
  for (const l of labels)
    if (l.label && bare.endsWith(l.label)) bare = bare.slice(0, -l.label.length).trim();
  const versionMatch = /\(([^()]*)\)$/.exec(bare);
  return {
    format: META_FORMAT,
    pageId: /\/track\/([a-z0-9]+)\//i.exec(url)?.[1] ?? null,
    itemId: itemIdOf(html, "5") ?? /idTrack:\s*(\d+)/.exec(html)?.[1] ?? null,
    name,
    artist: name && dash > 0 ? name.slice(0, dash) : null,
    title: name && dash > 0 ? name.slice(dash + 3) : null,
    version: versionMatch ? clean(versionMatch[1]) || null : null,
    headingArtists,
    label: labelA
      ? {
          name: clean(labelA.text),
          path: pathOf(labelA.getAttribute("href")),
          country: flagOf(labelEl),
          links: labelLinks,
        }
      : null,
    labels,
    genre: metaContent(rec, 'meta[itemprop="genre"]') ?? cleanOrNull(sec.get("genre")?.text),
    durationSeconds: parseIsoDuration(metaContent(rec, 'meta[itemprop="duration"]')),
    bpm: num(/(\d+)\s*BPM/i.exec(desc ?? "")?.[1]),
    releaseYear: num(/released\s+(\d{4})/i.exec(desc ?? "")?.[1]),
    artwork: metaContent(root, 'meta[property="og:image"]'),
    remixOf: remix
      ? {
          label: clean(remix.text),
          href: pathOf(remix.getAttribute("href")) ?? "",
          pageId: /\/track\/([a-z0-9]+)\//i.exec(remix.getAttribute("href") ?? "")?.[1] ?? null,
        }
      : null,
    plays: num(/Plays:\s*([\d,]+)/i.exec(statsText)?.[1]),
    tracklists: num(root.querySelector('#csLeft span.badge[title="number of tracklists"]')?.text),
    firstPlayed: playedRow(firstHead?.nextElementSibling ?? undefined),
    lastPlayed: playedRow(lastHead?.nextElementSibling ?? undefined),
    djSupport: num(supportHead?.querySelector("span.badge")?.text),
    supporters: (supportEl?.querySelectorAll('a[href*="/artist/"]') ?? []).map((a) => ({
      label: clean(a.text),
      href: pathOf(a.getAttribute("href")) ?? "",
    })),
    credits,
    media: mediaLinks(root),
    video: videoMeta(root),
    songstats:
      root.querySelector('a[href*="songstats.com/"]')?.getAttribute("href")?.split("?")[0] ?? null,
    shortLink: cleanOrNull(
      root.querySelector('#csLeft a[href^="https://1001.tl/"]')?.getAttribute("href"),
    ),
    description: desc,
  };
}

// --- storage -------------------------------------------------------------------

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Store one set page's document and genres. Throws on a D1 error (callers swallow). */
export async function saveSetMeta(
  env: Env,
  setUrl: string,
  doc: SetMetaDoc,
  source: string,
  nowSec = nowSeconds(),
): Promise<void> {
  const db = env.DB;
  const genres = doc.genres;
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO set_meta (set_url, tl_id, genres, meta, format, source, fetched_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
         ON CONFLICT(set_url) DO UPDATE SET tl_id = excluded.tl_id, genres = excluded.genres,
           meta = CASE WHEN excluded.meta LIKE '%"rows":%' OR set_meta.meta NOT LIKE '%"rows":%' THEN excluded.meta
                       ELSE json_set(excluded.meta, '$.rows', json_extract(set_meta.meta, '$.rows')) END,
           format = excluded.format, source = excluded.source, fetched_at = excluded.fetched_at, updated_at = excluded.updated_at
         WHERE excluded.fetched_at >= set_meta.fetched_at`,
      )
      .bind(
        setUrl,
        doc.tlId,
        JSON.stringify(genres.map((g) => g.name)),
        JSON.stringify(doc),
        doc.format,
        source,
        nowSec,
      ),
  ];
  // An empty genre list keeps what an earlier fetch found (a page that lost its chrome says nothing).
  if (genres.length > 0) {
    stmts.push(
      db
        .prepare(
          "DELETE FROM set_genres WHERE set_url = ? AND genre_key NOT IN (SELECT value FROM json_each(?))",
        )
        .bind(setUrl, JSON.stringify(genres.map((g) => g.key))),
    );
    for (const [i, g] of genres.entries())
      stmts.push(
        db
          .prepare(
            `INSERT INTO set_genres (set_url, genre_key, genre_name, position, at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(set_url, genre_key) DO UPDATE SET genre_name = excluded.genre_name, position = excluded.position`,
          )
          .bind(setUrl, g.key, g.name, i, nowSec),
      );
  }
  await db.batch(stmts);
}

/**
 * Parse and store one fetched set page. Never throws. `source` says which
 * path it came through (sync, page, pages).
 */
export async function recordSetMeta(
  env: Env,
  setUrl: string,
  html: string,
  source: string,
  log?: Logger,
  nowSec = nowSeconds(),
): Promise<SetMetaDoc | null> {
  try {
    if (!env.DB || !/\/tracklist\/[^/]+\//.test(setUrl) || !html || html.startsWith(SCRUB_NOTE))
      return null;
    if (!html.includes('id="tlTab"') && !html.includes("tl_music_styles")) return null;
    const doc = parseSetMeta(setUrl, html, { rows: "trusted" });
    await saveSetMeta(env, setUrl, doc, source, nowSec);
    return doc;
  } catch (e) {
    log?.warn("set_meta.record_failed", { setUrl, ...errorFields(e) });
    return null;
  }
}

/** Parse and store one fetched track page. Never throws. */
export async function recordTrackMeta(
  env: Env,
  trackUrl: string,
  html: string,
  log?: Logger,
  nowSec = nowSeconds(),
): Promise<TrackMetaDoc | null> {
  try {
    const id = /\/track\/([a-z0-9]+)\//i.exec(trackUrl)?.[1];
    if (!env.DB || !id || !html || !html.includes('id="pageTitle"')) return null;
    const doc = parseTrackMeta(trackUrl, html);
    await env.DB.prepare(
      `INSERT INTO track_meta (track_page_id, track_url, genre, meta, format, fetched_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(track_page_id) DO UPDATE SET track_url = excluded.track_url, genre = excluded.genre,
         meta = excluded.meta, format = excluded.format, fetched_at = excluded.fetched_at`,
    )
      .bind(id, trackUrl, doc.genre, JSON.stringify(doc), doc.format, nowSec)
      .run();
    return doc;
  } catch (e) {
    log?.warn("track_meta.record_failed", { trackUrl, ...errorFields(e) });
    return null;
  }
}

export type StoredSetMeta = {
  genres: Genre[];
  meta: SetMetaDoc | null;
  fetchedAt: number;
  source: string;
};

/** What is stored for one set, null when nothing is. The per-row part only with `rows`. */
export async function loadSetMeta(
  env: Env,
  setUrl: string,
  opts: { rows?: boolean } = {},
): Promise<StoredSetMeta | null> {
  const row = await env.DB.prepare(
    "SELECT meta, source, fetched_at FROM set_meta WHERE set_url = ?",
  )
    .bind(setUrl)
    .first<{ meta: string; source: string; fetched_at: number }>();
  if (!row) return null;
  const { results } = await env.DB.prepare(
    "SELECT genre_key, genre_name FROM set_genres WHERE set_url = ? ORDER BY position, genre_key",
  )
    .bind(setUrl)
    .all<{ genre_key: string; genre_name: string }>();
  let meta: SetMetaDoc | null;
  try {
    meta = JSON.parse(row.meta) as SetMetaDoc;
    if (!opts.rows && meta) delete meta.rows;
  } catch {
    meta = null;
  }
  return {
    genres: results.map((r) => ({ key: r.genre_key, name: r.genre_name })),
    meta,
    fetchedAt: Number(row.fetched_at) || 0,
    source: row.source,
  };
}

// --- stored-pages backfill -----------------------------------------------------

/** CACHE KV: the last R2 key the pass looked at, and when it finished (both carry META_FORMAT). */
export const META_PAGES_CURSOR_KEY = `set_meta:pages_after:v${META_FORMAT}`;
export const META_PAGES_DONE_KEY = `set_meta:pages_done:v${META_FORMAT}`;
const LIST_LIMIT = 200;

export type MetaPagesStepResult = { listed: number; read: number; written: number; done: boolean };

/**
 * One step of the stored-pages backfill: list `clean/` and `flagged/` set
 * pages in R2 from the saved position, read at most `limit` of the ones whose
 * set has no stored document (or an older format) and is one the app syncs,
 * store them. No pool fetch. Never throws.
 */
export async function setMetaPagesStep(
  env: Env,
  opts: { limit: number; log?: Logger; nowSec?: number },
): Promise<MetaPagesStepResult> {
  const res: MetaPagesStepResult = { listed: 0, read: 0, written: 0, done: false };
  if (!env.PAGES || !env.DB || opts.limit <= 0) return { ...res, done: !env.PAGES };
  if ((await env.CACHE.get(META_PAGES_DONE_KEY)) !== null) return { ...res, done: true };
  try {
    const raw = (await env.CACHE.get(META_PAGES_CURSOR_KEY)) ?? "";
    // The cursor walks clean/ first, then flagged/ (a decoy page's set-level facts are real).
    const prefix = raw.startsWith("flagged/") ? "flagged/" : "clean/";
    const after = raw.startsWith(prefix) ? raw : undefined;
    const list = await env.PAGES.list({
      prefix,
      limit: LIST_LIMIT,
      include: ["customMetadata"],
      ...(after ? { startAfter: after } : {}),
    } as R2ListOptions);
    res.listed = list.objects.length;
    const sets = list.objects
      .map((o) => ({
        key: o.key,
        url: o.customMetadata?.url ?? "",
        fetchedAt: o.customMetadata?.fetchedAt ?? "",
      }))
      .filter((o) => /^(clean|flagged)\/[^/]+\/set\//.test(o.key) && /\/tracklist\//.test(o.url));
    const urls = [...new Set(sets.map((s) => s.url))];
    const known = new Set<string>();
    const have = new Map<string, { format: number; fetchedAt: number }>();
    if (urls.length) {
      const { results: k } = await env.DB.prepare(
        "SELECT DISTINCT url FROM tracklists WHERE url IN (SELECT value FROM json_each(?))",
      )
        .bind(JSON.stringify(urls))
        .all<{ url: string }>();
      for (const r of k) known.add(r.url);
      const { results: h } = await env.DB.prepare(
        "SELECT set_url, format, fetched_at FROM set_meta WHERE set_url IN (SELECT value FROM json_each(?))",
      )
        .bind(JSON.stringify(urls))
        .all<{ set_url: string; format: number; fetched_at: number }>();
      for (const r of h)
        have.set(r.set_url, {
          format: Number(r.format) || 0,
          fetchedAt: Number(r.fetched_at) || 0,
        });
    }
    let last: string | null = null;
    let stoppedEarly = false;
    for (const o of list.objects) {
      const s = sets.find((x) => x.key === o.key);
      const fetchedSec = s ? Math.floor(Date.parse(s.fetchedAt) / 1000) || 0 : 0;
      const h = s ? have.get(s.url) : undefined;
      const wanted =
        !!s && known.has(s.url) && (!h || h.format < META_FORMAT || h.fetchedAt < fetchedSec);
      if (s && wanted) {
        if (res.read >= opts.limit) {
          stoppedEarly = true;
          break;
        }
        res.read++;
        const obj = await env.PAGES.get(s.key);
        const html = obj ? await gunzipToText(await obj.arrayBuffer()) : "";
        const doc = html
          ? await recordSetMeta(env, s.url, html, "pages", opts.log, fetchedSec || opts.nowSec)
          : null;
        if (doc) {
          res.written++;
          have.set(s.url, { format: META_FORMAT, fetchedAt: fetchedSec });
        }
      }
      last = o.key;
    }
    if (last) await env.CACHE.put(META_PAGES_CURSOR_KEY, last);
    if (!stoppedEarly && !list.truncated) {
      if (prefix === "clean/") await env.CACHE.put(META_PAGES_CURSOR_KEY, "flagged/");
      else {
        await env.CACHE.put(META_PAGES_DONE_KEY, String(opts.nowSec ?? nowSeconds()));
        res.done = true;
      }
    }
  } catch (e) {
    opts.log?.warn("set_meta.pages_step_failed", errorFields(e));
  }
  return res;
}
