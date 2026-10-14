// The Graph tab (docs/superpowers/specs/2026-10-14-graph-tab-design.md):
// the page and its read-only API over cached data (SEARCH_DB and the main
// DB). Mounted inside subscriptionsApp, so behind its cfAccess gate and the
// /ui/api/* same-origin guard. Nothing here fetches 1001tracklists.
import { Hono } from "hono";
import type { Env } from "../types";
import { getAppSettings } from "../lib/app-settings";
import { errorFields, makeLogger } from "../lib/log";
import { graphPagesStep, pagesPassDone, resetPagesPass } from "../lib/graph/backfill";
import { nodeInfo } from "../lib/graph/info";
import { expandNode, findNodes, MAX_DEPTH, parseNodeId, wholeLibrary } from "../lib/graph/query";
import { searchDbOf } from "../lib/search/db";
import { servePage } from "../ui/pages";
import { GRAPH_PAGE } from "../ui/pages/graph";

export const graphApp = new Hono<{ Bindings: Env; Variables: { cfAccessEmail: string } }>();

const UNBOUND = {
  error: "graph_unavailable",
  message: "The search index (the graph's data) is not bound to this Worker.",
} as const;

graphApp.get(GRAPH_PAGE.path, (c) => servePage(c, GRAPH_PAGE.html));

const limitsOf = async (env: Env) => {
  const g = (await getAppSettings(env)).graph;
  return { nodeCap: g.nodeCap, confirmOver: g.confirmOver };
};

const failed = (route: string, e: unknown) => {
  makeLogger({ route }).warn("graph.query_failed", errorFields(e));
  return { error: "graph_failed", message: "The graph could not be read." } as const;
};

// Counts and limits for the page header.
graphApp.get("/api/graph/status", async (c) => {
  if (!c.env.SEARCH_DB) return c.json(UNBOUND, 503);
  try {
    const r = await searchDbOf(c.env)
      .prepare(
        `SELECT (SELECT COUNT(*) FROM search_sets) AS sets, (SELECT COUNT(*) FROM search_graph_sets) AS parsed,
                (SELECT COUNT(*) FROM search_sources) AS sources, (SELECT COUNT(*) FROM search_artists) AS artists`,
      )
      .first<{ sets: number; parsed: number; sources: number; artists: number }>();
    return c.json({
      ...r,
      pagesPassDone: await pagesPassDone(c.env),
      limits: await limitsOf(c.env),
    });
  } catch (e) {
    return c.json(failed("graph.status", e), 500);
  }
});

graphApp.get("/api/graph/find", async (c) => {
  if (!c.env.SEARCH_DB) return c.json(UNBOUND, 503);
  try {
    return c.json({ hits: await findNodes(c.env, c.req.query("q") ?? "") });
  } catch (e) {
    return c.json(failed("graph.find", e), 500);
  }
});

graphApp.get("/api/graph/expand", async (c) => {
  if (!c.env.SEARCH_DB) return c.json(UNBOUND, 503);
  const id = c.req.query("id") ?? "";
  if (!parseNodeId(id))
    return c.json({ error: "invalid_request", message: "id: expected a node id" }, 400);
  const depth = Number(c.req.query("depth") ?? 1);
  if (!Number.isInteger(depth) || depth < 1 || depth > MAX_DEPTH)
    return c.json({ error: "invalid_request", message: `depth: 1 to ${MAX_DEPTH}` }, 400);
  try {
    const limits = await limitsOf(c.env);
    const g = await expandNode(c.env, id, { depth, cap: limits.nodeCap });
    return c.json({ ...g, limits });
  } catch (e) {
    return c.json(failed("graph.expand", e), 500);
  }
});

graphApp.get("/api/graph/library", async (c) => {
  if (!c.env.SEARCH_DB) return c.json(UNBOUND, 503);
  try {
    const limits = await limitsOf(c.env);
    return c.json({ ...(await wholeLibrary(c.env, limits.nodeCap)), limits });
  } catch (e) {
    return c.json(failed("graph.library", e), 500);
  }
});

graphApp.get("/api/graph/info", async (c) => {
  if (!c.env.SEARCH_DB) return c.json(UNBOUND, 503);
  const id = c.req.query("id") ?? "";
  if (!parseNodeId(id))
    return c.json({ error: "invalid_request", message: "id: expected a node id" }, 400);
  try {
    const info = await nodeInfo(c.env, id);
    if (!info) return c.json({ error: "not_found", message: "No such node." }, 404);
    return c.json(info);
  } catch (e) {
    return c.json(failed("graph.info", e), 500);
  }
});

// One manual step of the stored-pages backfill (the cron runs it too). No pool fetch.
graphApp.post("/api/graph/backfill/pages", async (c) => {
  if (!c.env.SEARCH_DB) return c.json(UNBOUND, 503);
  if (!c.env.PAGES) return c.json({ error: "pages_not_configured" }, 503);
  const body = (await c.req.json().catch(() => null)) as {
    limit?: unknown;
    reset?: unknown;
  } | null;
  const limit = body?.limit ?? 25;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 200)
    return c.json({ error: "invalid_request", message: "limit: 1 to 200" }, 400);
  const log = makeLogger({ route: "graph.backfill_pages", by: c.get("cfAccessEmail") });
  // `reset: true` starts the pass over from the first stored page (sets already parsed are skipped).
  if (body?.reset === true) await resetPagesPass(c.env);
  return c.json(await graphPagesStep(c.env, { limit, log }));
});
