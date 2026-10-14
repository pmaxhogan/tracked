/**
 * The Pre-save matches page's API (lib/presave-match.ts). Mounted inside
 * subscriptionsApp, behind its Cloudflare Access gate (and its same-origin
 * check on writes).
 *
 *   GET  /api/presave-matches?view=review|decided&presave=<id>  -> { groups, counts }
 *   POST /api/presave-matches/:id/approve    -> { ok, outcome, message, trackUploadId } (409 when it could not be applied)
 *   POST /api/presave-matches/:id/reject     -> { ok, match }
 *   POST /api/presave-matches/search-now     { presaveId } -> { ok }
 *   GET  /api/presave-matches/clip/:key      -> the audio clip mkvid made (R2)
 *   GET  /api/presave-matches/presave/:id    -> { searches, counts } for the pre-saved track page
 */

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { makeLogger } from "../lib/log";
import {
  applyApproval,
  getClip,
  getMatchRow,
  listMatchGroups,
  matchCounts,
  rejectMatch,
  searchNow,
  searchStateOf,
  matchOut,
} from "../lib/presave-match";

export const presaveMatchUiApp = new Hono<{
  Bindings: Env;
  Variables: { cfAccessEmail: string };
}>();

const log = (c: { req: { raw: Request }; get(k: "cfAccessEmail"): string }, route: string) =>
  makeLogger({
    reqId: c.req.raw.headers.get("cf-ray") ?? "local",
    route,
    by: c.get("cfAccessEmail"),
  });

const idParam = (s: string | undefined): number | null => {
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
};

presaveMatchUiApp.get("/api/presave-matches", async (c) => {
  const view = c.req.query("view") === "decided" ? "decided" : "review";
  const presaveId = idParam(c.req.query("presave"));
  const [groups, counts] = await Promise.all([
    listMatchGroups(c.env, { view, presaveId }),
    matchCounts(c.env),
  ]);
  return c.json({ view, groups, counts });
});

presaveMatchUiApp.post("/api/presave-matches/search-now", async (c) => {
  const parsed = z
    .object({ presaveId: z.number().int().positive() })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json({ error: "invalid_request", message: "presaveId is required" }, 400);
  const ok = await searchNow(c.env, parsed.data.presaveId);
  if (!ok)
    return c.json(
      {
        error: "not_waiting",
        message: "Only a pre-save waiting for a YouTube link can be searched.",
      },
      409,
    );
  return c.json({ ok: true });
});

presaveMatchUiApp.get("/api/presave-matches/presave/:id", async (c) => {
  const id = idParam(c.req.param("id"));
  if (id === null) return c.json({ error: "invalid_request" }, 400);
  const [searches, groups] = await Promise.all([
    searchStateOf(c.env, id),
    listMatchGroups(c.env, { view: "review", presaveId: id }),
  ]);
  return c.json({
    searches: searches.map((s) => ({
      kind: s.kind,
      status: s.status,
      searches: s.searches,
      nextAt: s.next_at,
      lastAt: s.last_at,
      lastError: s.last_error,
      candidatesSeen: s.candidates_seen,
    })),
    review: groups[0]?.candidates.length ?? 0,
  });
});

presaveMatchUiApp.post("/api/presave-matches/:id/approve", async (c) => {
  const id = idParam(c.req.param("id"));
  if (id === null) return c.json({ error: "invalid_request", message: "bad id" }, 400);
  const r = await applyApproval(c.env, id, "owner", log(c, "presave_match.approve"));
  if (r.ok) return c.json(r);
  if (r.message === "no such candidate") return c.json({ error: "not_found", ...r }, 404);
  return c.json({ error: "not_applied", ...r }, 409);
});

presaveMatchUiApp.post("/api/presave-matches/:id/reject", async (c) => {
  const id = idParam(c.req.param("id"));
  if (id === null) return c.json({ error: "invalid_request", message: "bad id" }, 400);
  const m = await rejectMatch(c.env, id);
  if (!m) return c.json({ error: "not_found", message: "No such candidate." }, 404);
  const p = await getMatchRow(c.env, id);
  return c.json({ ok: true, match: p ? matchOut(p, null) : null });
});

presaveMatchUiApp.get("/api/presave-matches/clip/:key", async (c) => {
  const obj = await getClip(c.env, c.req.param("key"));
  if (!obj) return c.json({ error: "not_found" }, 404);
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType ?? "audio/mpeg",
      "cache-control": "private, max-age=86400",
    },
  });
});
