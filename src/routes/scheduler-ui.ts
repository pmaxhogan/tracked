// The Scheduler page and its read-only endpoints. Mounted inside
// subscriptionsApp, so behind its cfAccess gate and the /ui/api/* same-origin
// guard (never the bearer token: GET /ops/scheduler/ticks is the bearer twin).
//
//   GET /scheduler                      the page (ui/pages/scheduler.ts)
//   GET /api/scheduler                  { summary, djs }: the last 24 h of ticks and the DJ due times
//   POST /api/scheduler/quota-clear     clears the "YouTube quota is out" flag early
//   GET /api/scheduler/ticks            the tick list: a data-table endpoint (lib/table-query.ts:
//                                       page, size, sort, q, f.<col>), newest first by default
//
// The DJ due times stay in /api/scheduler (one row per subscription, the overdue
// math is done there) and the page shows them in a local TKTable.
import { Hono } from "hono";
import type { Env } from "../types";
import { djStarvation, schedulerSummary, TICKS_TABLE } from "../lib/scheduler-report";
import { tableResponse } from "../lib/table-query";
import { clearQuotaOut, getQuotaOut } from "../lib/youtube-quota";
import { makeLogger } from "../lib/log";
import { servePage } from "../ui/pages";
import { SCHEDULER_PAGE } from "../ui/pages/scheduler";

export const schedulerUiApp = new Hono<{ Bindings: Env; Variables: { cfAccessEmail: string } }>();

schedulerUiApp.get(SCHEDULER_PAGE.path, (c) => servePage(c, SCHEDULER_PAGE.html));

schedulerUiApp.get("/api/scheduler", async (c) => {
  const now = Math.floor(Date.now() / 1000);
  const [summary, djs] = await Promise.all([
    schedulerSummary(c.env, now),
    djStarvation(c.env, now),
  ]);
  // quotaOut: YouTube's daily quota is used up until `until` (unix s); playlist writes wait meanwhile, everything else goes on.
  return c.json({ summary, djs, quotaOut: await getQuotaOut(c.env) });
});

/** Clears the quota flag early (the quota may have been raised); the next tick works as usual and sets it again if YouTube still refuses. */
schedulerUiApp.post("/api/scheduler/quota-clear", async (c) => {
  await clearQuotaOut(c.env);
  makeLogger({
    reqId: c.req.raw.headers.get("cf-ray") ?? "local",
    route: "scheduler.quota_clear",
    by: c.get("cfAccessEmail"),
  }).info("scheduler.quota_clear", {});
  return c.json({ ok: true });
});

schedulerUiApp.get("/api/scheduler/ticks", (c) => tableResponse(c, TICKS_TABLE, c.env.DB));
