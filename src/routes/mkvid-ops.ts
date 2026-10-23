/**
 * Operator routes for mkvid requests, bearer API_TOKEN (the panel's own
 * buttons go through /ui/api/*, behind Access, and share the handlers):
 *   POST /ops/mkvid/unpublish/<request id>   take a delivered video down and requeue the set
 *   POST /ops/mkvid/source/<request id>      { url } point the request at another recording of the set and queue it again
 *   POST /ops/mkvid/recheck-set/<request id> fetch the request's set page again on the next tick (any status)
 *   GET  /ops/scheduler/ticks?limit=&before=  scheduler tick history, newest first (lib/tick-history.ts)
 *   POST /ops/mkvid/apple-backstop?limit=&restart=1  Apple Music cues for every held set, one batch a call
 *   POST /ops/presave-matches/redecide       decide the pending pre-save match reviews again with the current rules (idempotent)
 */

import { Hono, type Context } from "hono";
import type { Env } from "../types";
import { bearerAuthFor } from "../middleware/auth";
import { getAccessToken } from "../lib/google-oauth";
import { makeLogger, type Logger } from "../lib/log";
import { deleteOldVideo, unpublishMkvidRequest } from "../lib/mkvid-recreate";
import { replaceMkvidSource } from "../lib/mkvid";
import { dbOf } from "../lib/db";
import { markSetDue } from "../lib/fetch-scheduler";
import { listSchedulerTicks } from "../lib/tick-history";
import { appleBackstopBatch } from "../lib/apple-backstop";
import { redecideReviews } from "../lib/presave-match";

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
 * Replace a request's recording (lib/mkvid.ts replaceMkvidSource): 400 for a
 * URL that is no SoundCloud or hearthis recording, 404 for an unknown id, 409
 * for a request being rendered, done or banned.
 */
mkvidOpsApp.post("/mkvid/source/:id", async (c) => {
  const log = makeLogger({
    reqId: c.req.raw.headers.get("cf-ray") ?? "local",
    route: "ops.mkvid_source",
  });
  const body = (await c.req.json().catch(() => null)) as { url?: unknown } | null;
  const url = typeof body?.url === "string" ? body.url : "";
  const r = await replaceMkvidSource(c.env, c.req.param("id"), url);
  if (!r.ok) {
    log.warn("ops.mkvid_source_refused", { id: r.id, error: r.error, status: r.status });
    return c.json(r, r.error === "invalid_url" ? 400 : r.error === "not_found" ? 404 : 409);
  }
  log.info("ops.mkvid_source_replaced", { id: r.id, from: r.from.url, to: r.to.url });
  return c.json(r);
});

/**
 * Mark the request's set page due now (lib/fetch-scheduler.ts markSetDue): the
 * next tick fetches it as a recheck, which queues a failed request again when
 * the page now links a different recording. One page, at the scheduler's pace.
 */
mkvidOpsApp.post("/mkvid/recheck-set/:id", async (c) => {
  const id = c.req.param("id");
  const row = await dbOf(c.env)
    .prepare("SELECT set_url FROM mkvid_requests WHERE id = ?")
    .bind(id)
    .first<{ set_url: string }>();
  if (!row) return c.json({ ok: false, id, error: "not_found" }, 404);
  await markSetDue(c.env, row.set_url);
  makeLogger({
    reqId: c.req.raw.headers.get("cf-ray") ?? "local",
    route: "ops.mkvid_recheck_set",
  }).info("ops.mkvid_recheck_set", { id, setUrl: row.set_url });
  return c.json({ ok: true, id, setUrl: row.set_url });
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

mkvidOpsApp.post("/presave-matches/redecide", async (c) => {
  const log = makeLogger({
    reqId: c.req.raw.headers.get("cf-ray") ?? "local",
    route: "ops.presave_matches_redecide",
  });
  return c.json(await redecideReviews(c.env, log));
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
