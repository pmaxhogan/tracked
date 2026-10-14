/**
 * Operator routes for mkvid requests, bearer API_TOKEN (the panel's own
 * buttons go through /ui/api/*, behind Access, and share the handlers):
 *   POST /ops/mkvid/unpublish/<request id>   take a delivered video down and requeue the set
 *   GET  /ops/scheduler/ticks?limit=&before=  scheduler tick history, newest first (lib/tick-history.ts)
 *   POST /ops/mkvid/apple-backstop?limit=&restart=1  Apple Music cues for every held set, one batch a call
 */

import { Hono, type Context } from "hono";
import type { Env } from "../types";
import { bearerAuthFor } from "../middleware/auth";
import { getAccessToken } from "../lib/google-oauth";
import { makeLogger, type Logger } from "../lib/log";
import { deleteOldVideo, unpublishMkvidRequest } from "../lib/mkvid-recreate";
import { listSchedulerTicks } from "../lib/tick-history";
import { appleBackstopBatch } from "../lib/apple-backstop";

export const mkvidOpsApp = new Hono<{ Bindings: Env }>();
mkvidOpsApp.use("*", bearerAuthFor("API_TOKEN"));

/** Unpublish one request, then ask mkvid to delete the video now (the cron retries a failure). */
export async function unpublishResponse(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- shared by two apps with different Variables
  c: Context<any>,
  id: string,
  log: Logger,
): Promise<Response> {
  const env = c.env as Env;
  const token = await getAccessToken(env).catch(() => null);
  const r = await unpublishMkvidRequest(env, id, log, token?.accessToken ?? null);
  if (!r.ok)
    return c.json(
      { ...r, id },
      r.error === "not_found" ? 404 : r.error === "not_connected" ? 503 : 409,
    );
  const deleted = await deleteOldVideo(env, r.videoId, log).catch(() => null);
  return c.json({ ...r, deleteState: deleted?.state ?? null });
}

mkvidOpsApp.post("/mkvid/unpublish/:id", async (c) => {
  const log = makeLogger({
    reqId: c.req.raw.headers.get("cf-ray") ?? "local",
    route: "ops.mkvid_unpublish",
  });
  return unpublishResponse(c, c.req.param("id"), log);
});

/**
 * The Apple Music backstop one-off (lib/apple-backstop.ts): one batch over the
 * held sets per call (`?limit=`, default 20, max 50), resuming where the last
 * call or cron tick stopped; `?restart=1` starts over (harmless). The cron
 * carries an unfinished run on by itself. Answers the batch and running totals.
 */
mkvidOpsApp.post("/mkvid/apple-backstop", async (c) => {
  const log = makeLogger({
    reqId: c.req.raw.headers.get("cf-ray") ?? "local",
    route: "ops.mkvid_apple_backstop",
  });
  const limit = Number(c.req.query("limit"));
  const r = await appleBackstopBatch(c.env, {
    limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    restart: c.req.query("restart") === "1",
    log,
  });
  return c.json({ ...r, done: r.totals.done });
});

mkvidOpsApp.get("/scheduler/ticks", async (c) => {
  const num = (k: string) => {
    const v = Number(c.req.query(k));
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };
  return c.json({
    ticks: await listSchedulerTicks(c.env, { limit: num("limit"), before: num("before") ?? null }),
  });
});
