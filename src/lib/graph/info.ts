/**
 * The Graph tab's info panel for one node: a title, label/value facts, links
 * (our own page for that kind of node when there is one, and the
 * 1001tracklists page) and related nodes the panel lists. Cached data only.
 */
import type { Env } from "../../types";
import { dbOf } from "../db";
import { searchDbOf } from "../search/db";
import { djContext, parseNodeId, type NodeCat } from "./query";

const ORIGIN = "https://www.1001tracklists.com";

export type InfoLink = { label: string; href: string; external: boolean };
export type InfoRelated = { id: string; label: string; note: string };
export type NodeInfo = {
  id: string;
  cat: NodeCat;
  title: string;
  facts: Array<[string, string]>;
  links: InfoLink[];
  related: InfoRelated[];
};

const plural = (n: number, w: string) => `${n.toLocaleString("en-US")} ${w}${n === 1 ? "" : "s"}`;
const ext = (label: string, href: string): InfoLink => ({ label, href, external: true });
const own = (label: string, href: string): InfoLink => ({ label, href, external: false });

function duration(s: number | null): string | null {
  if (s == null) return null;
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

const ROLE_WORD: Record<string, string> = {
  main: "Artist",
  featured: "Featured",
  remixer: "Remixer",
};

/** The info panel for `id`; null when the node is unknown. */
export async function nodeInfo(env: Env, id: string): Promise<NodeInfo | null> {
  const p = parseNodeId(id);
  if (!p) return null;
  const sdb = searchDbOf(env);
  const one = <T>(sql: string, ...b: unknown[]) =>
    sdb
      .prepare(sql)
      .bind(...b)
      .first<T>();
  const all = async <T>(sql: string, ...b: unknown[]) =>
    (
      await sdb
        .prepare(sql)
        .bind(...b)
        .all<T>()
    ).results;

  if (p.kind === "a") {
    const dj = await djContext(env);
    const a = await one<{ name: string; tl_path: string | null; dj_slug: string | null }>(
      "SELECT name, tl_path, dj_slug FROM search_artists WHERE key = ?",
      p.value,
    );
    const slugs = dj.slugsByKey.get(p.value) ?? [];
    if (!a && slugs.length === 0) return null;
    const name = a?.name ?? dj.nameBySlug.get(slugs[0]!) ?? p.value;
    const roles = await all<{ role: string; n: number }>(
      "SELECT role, COUNT(*) AS n FROM search_track_artists WHERE artist_key = ? GROUP BY role",
      p.value,
    );
    const sets = await one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM (
         SELECT set_url FROM search_set_artists WHERE artist_key = ?1
         UNION SELECT set_url FROM search_sets WHERE dj_slug IN (SELECT value FROM json_each(?2)))`,
      p.value,
      JSON.stringify(slugs),
    );
    const n = (r: string) => roles.find((x) => x.role === r)?.n ?? 0;
    const facts: Array<[string, string]> = [
      ["Sets", plural(sets?.n ?? 0, "set")],
      ["Tracks", plural(n("main"), "track")],
    ];
    if (n("featured")) facts.push(["Featured on", plural(n("featured"), "track")]);
    if (n("remixer")) facts.push(["Remixes", plural(n("remixer"), "remix")]);
    const links: InfoLink[] = [];
    for (const s of slugs) links.push(own("DJ page", `/ui/dj/${encodeURIComponent(s)}`));
    if (a?.tl_path) links.push(ext("1001tracklists artist page", ORIGIN + a.tl_path));
    const djSlug = slugs[0] ?? a?.dj_slug;
    if (djSlug) links.push(ext("1001tracklists DJ page", `${ORIGIN}/dj/${djSlug}/index.html`));
    return {
      id,
      cat: slugs.length ? "dj" : "artist",
      title: name,
      facts: slugs.length ? [["Subscribed", "Yes"], ...facts] : facts,
      links,
      related: [],
    };
  }

  if (p.kind === "s") {
    const s = await one<{
      title: string;
      dj_name: string;
      set_date: string | null;
      video_id: string | null;
      track_count: number;
      ided_count: number;
    }>(
      "SELECT title, dj_name, set_date, video_id, track_count, ided_count FROM search_sets WHERE set_url = ?",
      p.value,
    );
    if (!s) return null;
    const sources = await all<{ id: string; name: string }>(
      `SELECT so.id AS id, so.name AS name FROM search_set_sources ss JOIN search_sources so ON so.id = ss.source_id
        WHERE ss.set_url = ? ORDER BY ss.pos`,
      p.value,
    );
    const artists = await all<{ key: string; name: string }>(
      `SELECT a.key AS key, a.name AS name FROM search_set_artists sa JOIN search_artists a ON a.key = sa.artist_key
        WHERE sa.set_url = ? ORDER BY sa.pos`,
      p.value,
    );
    const facts: Array<[string, string]> = [
      ["DJ", artists.length ? artists.map((a) => a.name).join(", ") : s.dj_name],
    ];
    if (s.set_date) facts.push(["Date", s.set_date]);
    facts.push(["Source", sources.length ? sources.map((x) => x.name).join(", ") : "None listed"]);
    facts.push(["Tracks", `${s.track_count} (${s.ided_count} identified)`]);
    const links: InfoLink[] = [own("Set page", `/ui/set?url=${encodeURIComponent(p.value)}`)];
    links.push(ext("1001tracklists page", p.value));
    if (s.video_id)
      links.push(ext("Video", `https://www.youtube.com/watch?v=${encodeURIComponent(s.video_id)}`));
    return {
      id,
      cat: "set",
      title: s.title,
      facts,
      links,
      related: [
        ...artists.map((a) => ({ id: `a:${a.key}`, label: a.name, note: "DJ" })),
        ...sources.map((x) => ({ id: `src:${x.id}`, label: x.name, note: "Source" })),
      ],
    };
  }

  if (p.kind === "src") {
    const s = await one<{ slug: string; name: string }>(
      "SELECT slug, name FROM search_sources WHERE id = ?",
      p.value,
    );
    if (!s) return null;
    const n = await one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM search_set_sources WHERE source_id = ?",
      p.value,
    );
    return {
      id,
      cat: "source",
      title: s.name,
      facts: [["Sets", plural(n?.n ?? 0, "set")]],
      links: [
        ext("1001tracklists source page", `${ORIGIN}/source/${p.value}/${s.slug}/index.html`),
      ],
      related: [],
    };
  }

  // Tracks: by page id (t:) or, for a played track without a page link, by search key (k:).
  type Played = {
    track_key: string;
    track_id: string | null;
    track_url: string | null;
    artist: string;
    title: string;
    label: string | null;
    youtube_link: string | null;
    sets_count: number;
  };
  const played =
    p.kind === "t"
      ? await all<Played>(
          "SELECT track_key, track_id, track_url, artist, title, label, youtube_link, sets_count FROM search_tracks WHERE page_id = ? ORDER BY sets_count DESC",
          p.value,
        )
      : await all<Played>(
          "SELECT track_key, track_id, track_url, artist, title, label, youtube_link, sets_count FROM search_tracks WHERE track_key = ?",
          p.value,
        );
  const meta =
    p.kind === "t"
      ? await one<{
          artist: string | null;
          title: string | null;
          tl_path: string | null;
          label: string | null;
          label_path: string | null;
          genre: string | null;
          duration_s: number | null;
          version: string | null;
        }>(
          "SELECT artist, title, tl_path, label, label_path, genre, duration_s, version FROM search_graph_tracks WHERE page_id = ?",
          p.value,
        )
      : null;
  const top = played[0];
  if (!meta && !top) return null;
  const artist = meta?.artist ?? top?.artist ?? "";
  const title = meta?.title ?? top?.title ?? "";
  const facts: Array<[string, string]> = [
    ["Artist", artist || "Unknown"],
    ["Title", title || "Unknown"],
  ];
  const label = meta?.label ?? top?.label;
  if (label) facts.push(["Label", label]);
  if (meta?.genre) facts.push(["Genre", meta.genre]);
  const d = duration(meta?.duration_s ?? null);
  if (d) facts.push(["Length", d]);
  const setsPlayed = played.reduce((n, r) => n + r.sets_count, 0);
  facts.push(["Played in", plural(setsPlayed, "set")]);

  const related: InfoRelated[] = [];
  const links: InfoLink[] = [];
  if (p.kind === "t") {
    const credits = await all<{ key: string; name: string; role: string }>(
      `SELECT a.key AS key, a.name AS name, ta.role AS role FROM search_track_artists ta JOIN search_artists a ON a.key = ta.artist_key
        WHERE ta.page_id = ? ORDER BY CASE ta.role WHEN 'main' THEN 0 WHEN 'featured' THEN 1 ELSE 2 END, ta.pos`,
      p.value,
    );
    for (const c of credits)
      related.push({ id: `a:${c.key}`, label: c.name, note: ROLE_WORD[c.role] ?? c.role });
    const bases = await all<{
      id: string;
      kind: string;
      artist: string | null;
      title: string | null;
    }>(
      `SELECT b.base_id AS id, b.kind AS kind, g.artist AS artist, g.title AS title
         FROM search_track_bases b LEFT JOIN search_graph_tracks g ON g.page_id = b.base_id WHERE b.page_id = ?`,
      p.value,
    );
    for (const b of bases) {
      facts.push([
        b.kind === "rework" ? "Rework of" : "Remix of",
        [b.artist, b.title].filter(Boolean).join(" - ") || b.id,
      ]);
      related.push({
        id: `t:${b.id}`,
        label: [b.artist, b.title].filter(Boolean).join(" - ") || b.id,
        note: "Original",
      });
    }
    if (meta?.version && bases.length) facts.push(["Version", meta.version]);
    const remixes = await all<{
      id: string;
      kind: string;
      artist: string | null;
      title: string | null;
    }>(
      `SELECT b.page_id AS id, b.kind AS kind, g.artist AS artist, g.title AS title
         FROM search_track_bases b LEFT JOIN search_graph_tracks g ON g.page_id = b.page_id WHERE b.base_id = ? LIMIT 50`,
      p.value,
    );
    if (remixes.length) facts.push(["Remixes known", String(remixes.length)]);
    for (const r of remixes)
      related.push({
        id: `t:${r.id}`,
        label: [r.artist, r.title].filter(Boolean).join(" - ") || r.id,
        note: r.kind === "rework" ? "Rework" : "Remix",
      });
  }
  const yt = played.find((r) => r.youtube_link)?.youtube_link;
  if (yt) links.push(ext("YouTube", yt));
  // Pre-save status (main DB): by the track page URL or the medialink id.
  const urls = played.map((r) => r.track_url).filter((u): u is string => !!u);
  const tids = played.map((r) => r.track_id).filter((u): u is string => !!u);
  if (urls.length || tids.length) {
    const ps = await dbOf(env)
      .prepare(
        `SELECT id, stage FROM presaves
          WHERE track_url IN (SELECT value FROM json_each(?1)) OR track_id IN (SELECT value FROM json_each(?2))
          ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(JSON.stringify(urls), JSON.stringify(tids))
      .first<{ id: number; stage: string }>();
    if (ps) {
      facts.push(["Pre-save", ps.stage]);
      links.push(own("Pre-save page", `/ui/presave?id=${ps.id}`));
    }
  }
  const tlPath =
    meta?.tl_path ?? (top?.track_url ? top.track_url.replace(/^https?:\/\/[^/]+/, "") : null);
  if (tlPath) links.push(ext("1001tracklists track page", ORIGIN + tlPath));
  if (meta?.label_path) links.push(ext("1001tracklists label page", ORIGIN + meta.label_path));
  const remix = p.kind === "t" && related.some((r) => r.note === "Original");
  return {
    id,
    cat: remix ? "remix" : "track",
    title: artist && title ? `${artist} - ${title}` : title || artist || p.value,
    facts,
    links,
    related,
  };
}
