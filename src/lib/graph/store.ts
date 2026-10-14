/**
 * Graph writes (migrations-search/0003_graph.sql): one SEARCH_DB batch per
 * set page, a fixed number of statements over `json_each` JSON binds (the
 * search indexer's style, src/lib/search/index.ts), whatever the page length.
 *
 *   - The set's sources and heading artists are replaced.
 *   - A played track's row and credits are replaced by the latest page that
 *     lists it (credits are the same on every page that plays the track).
 *   - A base track only seen as a base is a stub: its name and path fill in
 *     what is missing and never overwrite a played track's own data.
 *   - Artists: the name is the latest seen; a 1001tl artist path or DJ slug,
 *     once known, is kept.
 *
 * Callers only hand in pages that verified (the indexer's rule: a decoy page
 * must never write here). Throws on DB errors; callers swallow them.
 */
import type { Env } from "../../types";
import { searchDbOf } from "../search/db";
import type { SetGraph } from "../tracklist-credits";

/** Bumped when what a graph parse stores changes: a set parsed at an older format is parsed again. */
export const GRAPH_FORMAT = 1;

/**
 * Unix seconds when graph parsing started (2026-10-14 12:00 UTC). A set last
 * fetched before it is a candidate for the graph backfill (fetch-scheduler's
 * index catch-up), unless the page store already gave its graph.
 */
export const GRAPH_FORMAT_SINCE = 1791979200;

export type GraphOrigin = "fetch" | "pages";

/** How many rows a graph write touched (for logs and tests). */
export type GraphWriteResult = { sources: number; artists: number; tracks: number };

export async function writeSetGraph(
  env: Env,
  setUrl: string,
  g: SetGraph,
  nowSec: number,
  origin: GraphOrigin,
): Promise<GraphWriteResult> {
  const sdb = searchDbOf(env);

  // Artists: heading + every credit, one row per key (a path or DJ slug from any mention).
  const artists = new Map<string, [string, string, string | null, string | null]>();
  const addArtist = (key: string, name: string, path: string | null, djSlug: string | null) => {
    const cur = artists.get(key);
    if (!cur) artists.set(key, [key, name, path, djSlug]);
    else artists.set(key, [key, cur[1], cur[2] ?? path, cur[3] ?? djSlug]);
  };
  for (const a of g.artists) addArtist(a.key, a.name, a.path, a.djSlug);
  for (const r of g.rows) for (const c of r.credits) addArtist(c.key, c.name, c.path, null);

  const sources = JSON.stringify(g.sources.map((s) => [s.id, s.slug, s.name]));
  const setSources = JSON.stringify(g.sources.map((s, i) => [s.id, i]));
  const setArtists = JSON.stringify(g.artists.map((a, i) => [a.key, i]));
  const artistRows = JSON.stringify([...artists.values()]);
  const played = JSON.stringify(
    g.rows.map((r) => [
      r.pageId,
      r.artist,
      r.title,
      r.path,
      r.label,
      r.labelPath,
      r.genre,
      r.durationSeconds,
      r.version,
    ]),
  );
  const playedIds = new Set(g.rows.map((r) => r.pageId));
  const stubs = JSON.stringify(
    g.rows
      .filter((r) => r.base && !playedIds.has(r.base.pageId))
      .map((r) => [r.base!.pageId, r.base!.artist, r.base!.title, r.base!.path]),
  );
  const credits = JSON.stringify(
    g.rows.flatMap((r) => r.credits.map((c, i) => [r.pageId, c.key, c.role, i])),
  );
  const creditIds = JSON.stringify(g.rows.map((r) => r.pageId));
  const bases = JSON.stringify(
    g.rows.filter((r) => r.base).map((r) => [r.pageId, r.base!.pageId, r.base!.kind]),
  );

  await sdb.batch([
    // 1. Sources. `WHERE true` keeps ON CONFLICT from parsing as a join constraint.
    sdb
      .prepare(
        `INSERT INTO search_sources (id, slug, name, updated_at)
         SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), ?1 FROM json_each(?2) WHERE true
         ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, name = excluded.name, updated_at = excluded.updated_at`,
      )
      .bind(nowSec, sources),
    // 2-3. The set's sources, replaced.
    sdb.prepare("DELETE FROM search_set_sources WHERE set_url = ?").bind(setUrl),
    sdb
      .prepare(
        `INSERT OR IGNORE INTO search_set_sources (set_url, source_id, pos)
         SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?2)`,
      )
      .bind(setUrl, setSources),
    // 4. Artists.
    sdb
      .prepare(
        `INSERT INTO search_artists (key, name, tl_path, dj_slug, updated_at)
         SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), ?1
           FROM json_each(?2) WHERE true
         ON CONFLICT(key) DO UPDATE SET name = excluded.name, tl_path = COALESCE(excluded.tl_path, tl_path),
           dj_slug = COALESCE(excluded.dj_slug, dj_slug), updated_at = excluded.updated_at`,
      )
      .bind(nowSec, artistRows),
    // 5-6. The set's heading artists, replaced.
    sdb.prepare("DELETE FROM search_set_artists WHERE set_url = ?").bind(setUrl),
    sdb
      .prepare(
        `INSERT OR IGNORE INTO search_set_artists (set_url, artist_key, pos)
         SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?2)`,
      )
      .bind(setUrl, setArtists),
    // 7. Played tracks: this page's data, keeping a stored value the page lacks.
    sdb
      .prepare(
        `INSERT INTO search_graph_tracks (page_id, artist, title, tl_path, label, label_path, genre, duration_s, version, updated_at)
         SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'),
                json_extract(value, '$[4]'), json_extract(value, '$[5]'), json_extract(value, '$[6]'), json_extract(value, '$[7]'),
                json_extract(value, '$[8]'), ?1
           FROM json_each(?2) WHERE true
         ON CONFLICT(page_id) DO UPDATE SET artist = excluded.artist, title = excluded.title,
           tl_path = COALESCE(excluded.tl_path, tl_path), label = COALESCE(excluded.label, label),
           label_path = COALESCE(excluded.label_path, label_path), genre = COALESCE(excluded.genre, genre),
           duration_s = COALESCE(excluded.duration_s, duration_s), version = excluded.version, updated_at = excluded.updated_at`,
      )
      .bind(nowSec, played),
    // 8. Base stubs: fill in only what is missing.
    sdb
      .prepare(
        `INSERT INTO search_graph_tracks (page_id, artist, title, tl_path, updated_at)
         SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), ?1
           FROM json_each(?2) WHERE true
         ON CONFLICT(page_id) DO UPDATE SET artist = COALESCE(artist, excluded.artist), title = COALESCE(title, excluded.title),
           tl_path = COALESCE(tl_path, excluded.tl_path)`,
      )
      .bind(nowSec, stubs),
    // 9-10. Credits of the played tracks, replaced.
    sdb
      .prepare("DELETE FROM search_track_artists WHERE page_id IN (SELECT value FROM json_each(?))")
      .bind(creditIds),
    sdb
      .prepare(
        `INSERT OR IGNORE INTO search_track_artists (page_id, artist_key, role, pos)
         SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]') FROM json_each(?)`,
      )
      .bind(credits),
    // 11. Remix / rework bases.
    sdb
      .prepare(
        `INSERT OR REPLACE INTO search_track_bases (page_id, base_id, kind)
         SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?)`,
      )
      .bind(bases),
    // 12. The set is parsed.
    sdb
      .prepare(
        `INSERT INTO search_graph_sets (set_url, format, parsed_at, origin) VALUES (?, ?, ?, ?)
         ON CONFLICT(set_url) DO UPDATE SET format = excluded.format, parsed_at = excluded.parsed_at, origin = excluded.origin`,
      )
      .bind(setUrl, GRAPH_FORMAT, nowSec, origin),
  ]);
  return { sources: g.sources.length, artists: artists.size, tracks: g.rows.length };
}

/** Whether a set's graph is stored at the current format. */
export async function hasCurrentGraph(env: Env, setUrl: string): Promise<boolean> {
  const r = await searchDbOf(env)
    .prepare("SELECT 1 AS x FROM search_graph_sets WHERE set_url = ? AND format >= ?")
    .bind(setUrl, GRAPH_FORMAT)
    .first<{ x: number }>();
  return !!r;
}

/** Of `urls`, the ones whose graph is stored at the current format. */
export async function setsWithGraph(env: Env, urls: readonly string[]): Promise<Set<string>> {
  if (urls.length === 0) return new Set();
  const res = await searchDbOf(env)
    .prepare(
      "SELECT set_url FROM search_graph_sets WHERE format >= ? AND set_url IN (SELECT value FROM json_each(?))",
    )
    .bind(GRAPH_FORMAT, JSON.stringify(urls))
    .all<{ set_url: string }>();
  return new Set(res.results.map((r) => r.set_url));
}

/**
 * Sets whose current graph came from a stored page (lib/graph/backfill.ts):
 * the refetch half of the backfill leaves them out. Empty when SEARCH_DB is
 * unbound or the read fails (the refetch then simply includes them).
 */
export async function pagesGraphUrls(env: Env): Promise<string[]> {
  if (!env.SEARCH_DB) return [];
  try {
    const res = await env.SEARCH_DB.prepare(
      "SELECT set_url FROM search_graph_sets WHERE origin = 'pages' AND format >= ?",
    )
      .bind(GRAPH_FORMAT)
      .all<{ set_url: string }>();
    return res.results.map((r) => r.set_url);
  } catch {
    return [];
  }
}
