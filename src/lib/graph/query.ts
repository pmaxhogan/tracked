/**
 * Graph reads for the Graph tab (docs/superpowers/specs/2026-10-14-graph-tab-design.md).
 * Cached data only: SEARCH_DB (sets, tracks, credits, sources) and the main
 * DB's subscriptions, DJ names and pre-saves. Nothing here fetches upstream.
 *
 * Node ids:  a:<artist key>  s:<set url>  src:<source id>
 *            t:<track page id>  k:<search track_key> (a played track with no page link)
 * Edges are [from, to, kind], directed:
 *   plays   artist -> set        source  source -> set      has     set -> track
 *   by / feat / remixer  artist -> track                    remix / rework  base -> track
 *
 * Every relation is read for a whole group of nodes at once (one statement
 * per relation over a `json_each` bind), so a depth-2 expansion costs a fixed
 * handful of queries, not one per node.
 */
import type { Env } from "../../types";
import { dbOf } from "../db";
import { prettifySlug } from "../prettify-slug";
import { searchDbOf } from "../search/db";
import { nameSlug } from "../tracklist-credits";

export const NODE_CATS = ["dj", "artist", "set", "source", "track", "remix"] as const;
export type NodeCat = (typeof NODE_CATS)[number];
export const EDGE_KINDS = [
  "plays",
  "source",
  "has",
  "by",
  "feat",
  "remixer",
  "remix",
  "rework",
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/** [id, category, label, weight]; weight is a size hint (sets played, tracks in a set). */
export type GNode = [string, NodeCat, string, number];
export type GEdge = [string, string, EdgeKind];
export type Subgraph = {
  nodes: GNode[];
  edges: GEdge[];
  /** Nodes left out to stay under the cap. */
  truncated: boolean;
};

export const MAX_DEPTH = 2;

const ROLE_EDGE: Record<string, EdgeKind> = { main: "by", featured: "feat", remixer: "remixer" };

type Ids = { a: Set<string>; s: Set<string>; src: Set<string>; t: Set<string>; k: Set<string> };
const emptyIds = (): Ids => ({
  a: new Set(),
  s: new Set(),
  src: new Set(),
  t: new Set(),
  k: new Set(),
});

/** The prefix and value of a node id; null when it is not one. */
export function parseNodeId(id: string): { kind: keyof Ids; value: string } | null {
  const m = /^(a|s|src|t|k):(.+)$/s.exec(id);
  if (!m || m[2]!.length > 2000) return null;
  return { kind: m[1] as keyof Ids, value: m[2]! };
}

function groupIds(ids: Iterable<string>): Ids {
  const g = emptyIds();
  for (const id of ids) {
    const p = parseNodeId(id);
    if (p) g[p.kind].add(p.value);
  }
  return g;
}

const j = (s: Iterable<string>) => JSON.stringify([...s]);
const trackNodeId = (pageId: string | null, trackKey: string) =>
  pageId ? `t:${pageId}` : `k:${trackKey}`;

/** Subscribed DJs and the artist key each one is drawn as. */
export type DjContext = {
  /** subscribed DJ slug -> artist key */
  keyBySlug: Map<string, string>;
  /** artist key -> subscribed DJ slugs */
  slugsByKey: Map<string, string[]>;
  /** subscribed DJ slug -> display name */
  nameBySlug: Map<string, string>;
};

/**
 * A subscribed DJ is the artist row whose heading link gave its DJ slug, else
 * the artist keyed by a slug of its name.
 */
export async function djContext(env: Env): Promise<DjContext> {
  const subs = (
    await dbOf(env)
      .prepare(
        "SELECT s.slug AS slug, ss.artist_name AS name FROM subscriptions s LEFT JOIN sub_sync ss ON ss.slug = s.slug",
      )
      .all<{ slug: string; name: string | null }>()
  ).results;
  const linked = (
    await searchDbOf(env)
      .prepare("SELECT key, dj_slug FROM search_artists WHERE dj_slug IS NOT NULL")
      .all<{ key: string; dj_slug: string }>()
  ).results;
  const linkedKey = new Map(linked.map((r) => [r.dj_slug, r.key]));
  const keyBySlug = new Map<string, string>();
  const slugsByKey = new Map<string, string[]>();
  const nameBySlug = new Map<string, string>();
  for (const s of subs) {
    const name = s.name ?? prettifySlug(s.slug);
    const key = linkedKey.get(s.slug) ?? (nameSlug(name) || s.slug);
    keyBySlug.set(s.slug, key);
    nameBySlug.set(s.slug, name);
    slugsByKey.set(key, [...(slugsByKey.get(key) ?? []), s.slug]);
  }
  return { keyBySlug, slugsByKey, nameBySlug };
}

/** Every edge touching one of `ids` (the relations listed in the header). */
export async function edgesOf(env: Env, dj: DjContext, ids: Iterable<string>): Promise<GEdge[]> {
  const g = groupIds(ids);
  const sdb = searchDbOf(env);
  const out: GEdge[] = [];
  const q = async <T>(sql: string, ...binds: unknown[]) =>
    (
      await sdb
        .prepare(sql)
        .bind(...binds)
        .all<T>()
    ).results;
  const djEdge = (slug: string, setUrl: string) => {
    const key = dj.keyBySlug.get(slug);
    if (key) out.push([`a:${key}`, `s:${setUrl}`, "plays"]);
  };

  if (g.a.size) {
    for (const r of await q<{ set_url: string; artist_key: string }>(
      "SELECT set_url, artist_key FROM search_set_artists WHERE artist_key IN (SELECT value FROM json_each(?))",
      j(g.a),
    ))
      out.push([`a:${r.artist_key}`, `s:${r.set_url}`, "plays"]);
    const slugs = [...g.a].flatMap((k) => dj.slugsByKey.get(k) ?? []);
    if (slugs.length)
      for (const r of await q<{ set_url: string; dj_slug: string }>(
        "SELECT set_url, dj_slug FROM search_sets WHERE dj_slug IN (SELECT value FROM json_each(?))",
        j(slugs),
      ))
        djEdge(r.dj_slug, r.set_url);
    for (const r of await q<{ page_id: string; artist_key: string; role: string }>(
      "SELECT page_id, artist_key, role FROM search_track_artists WHERE artist_key IN (SELECT value FROM json_each(?))",
      j(g.a),
    ))
      out.push([`a:${r.artist_key}`, `t:${r.page_id}`, ROLE_EDGE[r.role] ?? "by"]);
  }
  if (g.s.size) {
    for (const r of await q<{ set_url: string; artist_key: string }>(
      "SELECT set_url, artist_key FROM search_set_artists WHERE set_url IN (SELECT value FROM json_each(?))",
      j(g.s),
    ))
      out.push([`a:${r.artist_key}`, `s:${r.set_url}`, "plays"]);
    for (const r of await q<{ set_url: string; dj_slug: string }>(
      "SELECT set_url, dj_slug FROM search_sets WHERE set_url IN (SELECT value FROM json_each(?))",
      j(g.s),
    ))
      djEdge(r.dj_slug, r.set_url);
    for (const r of await q<{ set_url: string; source_id: string }>(
      "SELECT set_url, source_id FROM search_set_sources WHERE set_url IN (SELECT value FROM json_each(?))",
      j(g.s),
    ))
      out.push([`src:${r.source_id}`, `s:${r.set_url}`, "source"]);
    for (const r of await q<{ set_url: string; page_id: string | null; track_key: string }>(
      `SELECT ts.set_url AS set_url, t.page_id AS page_id, t.track_key AS track_key
         FROM search_track_sets ts JOIN search_tracks t ON t.track_key = ts.track_key
        WHERE ts.set_url IN (SELECT value FROM json_each(?)) ORDER BY ts.set_url, ts.pos`,
      j(g.s),
    ))
      out.push([`s:${r.set_url}`, trackNodeId(r.page_id, r.track_key), "has"]);
  }
  if (g.src.size)
    for (const r of await q<{ set_url: string; source_id: string }>(
      "SELECT set_url, source_id FROM search_set_sources WHERE source_id IN (SELECT value FROM json_each(?))",
      j(g.src),
    ))
      out.push([`src:${r.source_id}`, `s:${r.set_url}`, "source"]);
  if (g.t.size) {
    for (const r of await q<{ set_url: string; page_id: string }>(
      `SELECT ts.set_url AS set_url, t.page_id AS page_id FROM search_tracks t JOIN search_track_sets ts ON ts.track_key = t.track_key
        WHERE t.page_id IN (SELECT value FROM json_each(?))`,
      j(g.t),
    ))
      out.push([`s:${r.set_url}`, `t:${r.page_id}`, "has"]);
    for (const r of await q<{ page_id: string; artist_key: string; role: string }>(
      "SELECT page_id, artist_key, role FROM search_track_artists WHERE page_id IN (SELECT value FROM json_each(?))",
      j(g.t),
    ))
      out.push([`a:${r.artist_key}`, `t:${r.page_id}`, ROLE_EDGE[r.role] ?? "by"]);
    for (const r of await q<{ page_id: string; base_id: string; kind: string }>(
      `SELECT page_id, base_id, kind FROM search_track_bases
        WHERE page_id IN (SELECT value FROM json_each(?1)) OR base_id IN (SELECT value FROM json_each(?1))`,
      j(g.t),
    ))
      out.push([`t:${r.base_id}`, `t:${r.page_id}`, r.kind === "rework" ? "rework" : "remix"]);
  }
  if (g.k.size)
    for (const r of await q<{ set_url: string; track_key: string }>(
      "SELECT set_url, track_key FROM search_track_sets WHERE track_key IN (SELECT value FROM json_each(?))",
      j(g.k),
    ))
      out.push([`s:${r.set_url}`, `k:${r.track_key}`, "has"]);

  // One edge per (from, to, kind).
  const seen = new Set<string>();
  return out.filter((e) => {
    const key = e.join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Category, label and weight of each node id (unknown ids get their raw value as the label). */
export async function describeNodes(
  env: Env,
  dj: DjContext,
  ids: Iterable<string>,
): Promise<GNode[]> {
  const g = groupIds(ids);
  const sdb = searchDbOf(env);
  const q = async <T>(sql: string, bind: string) =>
    (await sdb.prepare(sql).bind(bind).all<T>()).results;
  const out: GNode[] = [];

  if (g.a.size) {
    const rows = await q<{ key: string; name: string }>(
      "SELECT key, name FROM search_artists WHERE key IN (SELECT value FROM json_each(?))",
      j(g.a),
    );
    const name = new Map(rows.map((r) => [r.key, r.name]));
    for (const key of g.a) {
      const slugs = dj.slugsByKey.get(key);
      const label = name.get(key) ?? (slugs ? dj.nameBySlug.get(slugs[0]!) : null) ?? key;
      out.push([`a:${key}`, slugs ? "dj" : "artist", label, 0]);
    }
  }
  if (g.s.size) {
    const rows = await q<{ set_url: string; title: string; track_count: number }>(
      "SELECT set_url, title, track_count FROM search_sets WHERE set_url IN (SELECT value FROM json_each(?))",
      j(g.s),
    );
    const by = new Map(rows.map((r) => [r.set_url, r]));
    for (const url of g.s) {
      const r = by.get(url);
      out.push([`s:${url}`, "set", r?.title ?? url, r?.track_count ?? 0]);
    }
  }
  if (g.src.size) {
    const rows = await q<{ id: string; name: string }>(
      "SELECT id, name FROM search_sources WHERE id IN (SELECT value FROM json_each(?))",
      j(g.src),
    );
    const by = new Map(rows.map((r) => [r.id, r.name]));
    for (const id of g.src) out.push([`src:${id}`, "source", by.get(id) ?? id, 0]);
  }
  if (g.t.size) {
    const meta = await q<{ page_id: string; artist: string | null; title: string | null }>(
      "SELECT page_id, artist, title FROM search_graph_tracks WHERE page_id IN (SELECT value FROM json_each(?))",
      j(g.t),
    );
    const played = await q<{ page_id: string; artist: string; title: string; sets_count: number }>(
      "SELECT page_id, artist, title, sets_count FROM search_tracks WHERE page_id IN (SELECT value FROM json_each(?))",
      j(g.t),
    );
    const remixes = new Set(
      (
        await q<{ page_id: string }>(
          "SELECT DISTINCT page_id FROM search_track_bases WHERE page_id IN (SELECT value FROM json_each(?))",
          j(g.t),
        )
      ).map((r) => r.page_id),
    );
    const m = new Map(meta.map((r) => [r.page_id, r]));
    const p = new Map<string, (typeof played)[number]>();
    for (const r of played) {
      const cur = p.get(r.page_id);
      if (!cur || r.sets_count > cur.sets_count) p.set(r.page_id, r);
    }
    for (const id of g.t) {
      const a = m.get(id)?.artist ?? p.get(id)?.artist ?? null;
      const t = m.get(id)?.title ?? p.get(id)?.title ?? null;
      const label = a && t ? `${a} - ${t}` : (t ?? a ?? id);
      out.push([`t:${id}`, remixes.has(id) ? "remix" : "track", label, p.get(id)?.sets_count ?? 0]);
    }
  }
  if (g.k.size) {
    const rows = await q<{ track_key: string; artist: string; title: string; sets_count: number }>(
      "SELECT track_key, artist, title, sets_count FROM search_tracks WHERE track_key IN (SELECT value FROM json_each(?))",
      j(g.k),
    );
    const by = new Map(rows.map((r) => [r.track_key, r]));
    for (const key of g.k) {
      const r = by.get(key);
      out.push([`k:${key}`, "track", r ? `${r.artist} - ${r.title}` : key, r?.sets_count ?? 0]);
    }
  }
  return out;
}

/**
 * A node and its neighbours `depth` steps out (1 or 2), at most `cap` nodes:
 * the focus first, then nearer nodes first, in edge order. Edges are those
 * between the nodes returned.
 */
export async function expandNode(
  env: Env,
  id: string,
  opts: { depth: number; cap: number },
): Promise<Subgraph> {
  const dj = await djContext(env);
  const depth = Math.max(1, Math.min(MAX_DEPTH, Math.floor(opts.depth)));
  const cap = Math.max(1, Math.floor(opts.cap));
  const keep = new Set<string>([id]);
  const edges: GEdge[] = [];
  let truncated = false;
  let frontier = [id];
  for (let d = 0; d < depth && frontier.length && !truncated; d++) {
    const next: string[] = [];
    for (const e of await edgesOf(env, dj, frontier)) {
      edges.push(e);
      for (const n of [e[0], e[1]]) {
        if (keep.has(n)) continue;
        if (keep.size >= cap) {
          truncated = true;
          continue;
        }
        keep.add(n);
        next.push(n);
      }
    }
    frontier = next;
  }
  return finish(env, dj, keep, edges, truncated);
}

async function finish(
  env: Env,
  dj: DjContext,
  keep: Set<string>,
  edges: GEdge[],
  truncated: boolean,
): Promise<Subgraph> {
  const seen = new Set<string>();
  const inside = edges.filter((e) => {
    if (!keep.has(e[0]) || !keep.has(e[1])) return false;
    const k = e.join("\u0000");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { nodes: await describeNodes(env, dj, keep), edges: inside, truncated };
}

/**
 * The whole library, at most `cap` nodes: subscribed DJs, sources and sets
 * (newest first), then tracks by how many sets play them, then the other
 * artists by how many tracks they are credited on.
 */
export async function wholeLibrary(env: Env, cap: number): Promise<Subgraph> {
  const dj = await djContext(env);
  const sdb = searchDbOf(env);
  const col = async (sql: string) =>
    (await sdb.prepare(sql).bind(cap).all<{ id: string }>()).results.map((r) => r.id);
  const keep = new Set<string>();
  let truncated = false;
  const add = (ids: string[]) => {
    for (const id of ids) {
      if (keep.has(id)) continue;
      if (keep.size >= cap) {
        truncated = true;
        return;
      }
      keep.add(id);
    }
  };
  add([...new Set(dj.keyBySlug.values())].map((k) => `a:${k}`));
  add(await col("SELECT 'src:' || id AS id FROM search_sources ORDER BY name LIMIT ?"));
  add(
    await col(
      "SELECT 's:' || set_url AS id FROM search_sets ORDER BY set_date IS NULL, set_date DESC, set_url LIMIT ?",
    ),
  );
  if (!truncated)
    add(
      await col(
        `SELECT CASE WHEN page_id IS NOT NULL THEN 't:' || page_id ELSE 'k:' || track_key END AS id
           FROM search_tracks WHERE sets_count > 0 ORDER BY sets_count DESC, id LIMIT ?`,
      ),
    );
  if (!truncated)
    add(
      await col(
        "SELECT 'a:' || artist_key AS id FROM search_track_artists GROUP BY artist_key ORDER BY COUNT(*) DESC, artist_key LIMIT ?",
      ),
    );
  // Edges among the kept nodes: every relation of the sets and tracks covers them all.
  const edges = await edgesOf(
    env,
    dj,
    [...keep].filter((id) => /^(s|t|src):/.test(id)),
  );
  return finish(env, dj, keep, edges, truncated);
}

export type FindHit = { id: string; cat: NodeCat; label: string; sub: string | null };

/** Focus candidates for a typed name: DJs, artists, sources, sets and tracks, a few of each. */
export async function findNodes(env: Env, text: string, per = 6): Promise<FindHit[]> {
  const t = text.trim().slice(0, 100);
  if (t.length < 2) return [];
  const like = `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const dj = await djContext(env);
  const sdb = searchDbOf(env);
  const out: FindHit[] = [];
  const lower = t.toLowerCase();
  const djKeys = new Set<string>();
  for (const [slug, name] of dj.nameBySlug)
    if (name.toLowerCase().includes(lower) || slug.includes(lower)) {
      const key = dj.keyBySlug.get(slug)!;
      if (djKeys.has(key)) continue;
      djKeys.add(key);
      out.push({ id: `a:${key}`, cat: "dj", label: name, sub: "Subscribed DJ" });
    }
  const all = async <T>(sql: string) => (await sdb.prepare(sql).bind(like, per).all<T>()).results;
  for (const r of await all<{ key: string; name: string }>(
    "SELECT key, name FROM search_artists WHERE name LIKE ? ESCAPE '\\' ORDER BY length(name), name LIMIT ?",
  ))
    if (!djKeys.has(r.key)) out.push({ id: `a:${r.key}`, cat: "artist", label: r.name, sub: null });
  for (const r of await all<{ id: string; name: string }>(
    "SELECT id, name FROM search_sources WHERE name LIKE ? ESCAPE '\\' ORDER BY length(name), name LIMIT ?",
  ))
    out.push({ id: `src:${r.id}`, cat: "source", label: r.name, sub: "Source" });
  for (const r of await all<{ set_url: string; title: string; set_date: string | null }>(
    "SELECT set_url, title, set_date FROM search_sets WHERE title LIKE ? ESCAPE '\\' ORDER BY set_date DESC LIMIT ?",
  ))
    out.push({ id: `s:${r.set_url}`, cat: "set", label: r.title, sub: r.set_date });
  for (const r of await all<{
    track_key: string;
    page_id: string | null;
    artist: string;
    title: string;
    sets_count: number;
  }>(
    `SELECT track_key, page_id, artist, title, sets_count FROM search_tracks
      WHERE sets_count > 0 AND (artist || ' - ' || title) LIKE ? ESCAPE '\\' ORDER BY sets_count DESC LIMIT ?`,
  ))
    out.push({
      id: trackNodeId(r.page_id, r.track_key),
      cat: "track",
      label: `${r.artist} - ${r.title}`,
      sub: `${r.sets_count} set${r.sets_count === 1 ? "" : "s"}`,
    });
  return out;
}
