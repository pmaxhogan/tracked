// The YouTube quota page (ui/pages/quota.ts) and its API. Mounted inside
// subscriptionsApp, so behind its cfAccess gate and the /ui/api/* same-origin
// guard.
//   GET  /ui/quota                              the page
//   GET  /ui/api/quota                          pool, ranked consumers, outside-the-pool numbers
//   PUT  /ui/api/quota                          { order, margin, projectBudget, consumers } via updateAppSettings
//   POST /ui/api/quota/projects/:key/clear      clears one project's "out" flag early
import { Hono } from "hono";
import type { Env } from "../types";
import { makeLogger } from "../lib/log";
import { DEFAULT_SWEEP_REMOVALS, getAppSettings, updateAppSettings } from "../lib/app-settings";
import { mkvidAccountUsage, quotaDayEnd } from "../lib/mkvid";
import { consumerStatus } from "../lib/quota-priority";
import { QUOTA_CONSUMERS } from "../lib/quota-consumers";
import { clearProjectOut, poolProjects } from "../lib/youtube-pool";
import { servePage } from "../ui/pages";
import { QUOTA_PAGE } from "../ui/pages/quota";

export const quotaUiApp = new Hono<{ Bindings: Env; Variables: { cfAccessEmail: string } }>();

/** YouTube's cap on videos.insert uploads per project per day. */
const UPLOADS_PER_PROJECT_DAY = 100;
/** The key list the pool keeps of the projects mkvid has pushed a token for (lib/youtube-pool.ts). */
const ACCOUNTS_KEY = "yt:pool:accounts";
const SEEN_KEY = "yt:pool:seen";

async function lastPushAt(env: Env): Promise<number | null> {
  try {
    const n = Number(await env.CACHE.get(SEEN_KEY));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

async function indexedAccounts(env: Env): Promise<string[]> {
  try {
    const v = await env.CACHE.get<unknown>(ACCOUNTS_KEY, "json");
    return Array.isArray(v) ? v.filter((a): a is string => typeof a === "string") : [];
  } catch {
    return [];
  }
}

async function quotaPayload(env: Env) {
  const settings = await getAppSettings(env);
  const q = settings.quota;
  const pool = await poolProjects(env);
  const status = await consumerStatus(env);
  const uploads = await mkvidAccountUsage(env).catch(() => []);
  const seen = await lastPushAt(env);
  const labels = new Map(uploads.map((u) => [u.account as string, u.label]));
  const live = new Set(pool.map((p) => p.key));
  const notConnected = (await indexedAccounts(env))
    .filter((k) => !live.has(k))
    .map((k) => ({ key: k, label: labels.get(k) ?? k, since: seen }));

  const p = settings.playlists;
  const sweep = p.sweepDailyRemovals ?? DEFAULT_SWEEP_REMOVALS;
  // What each older cap said before it moved here (the old fields stay in the stored settings).
  const was: Record<string, string> = {
    ordering: `Quota units a day for ordering playlists: ${p.orderDailyUnits}`,
    combined: `Combined playlist inserts a day: ${p.combinedDailyInsertCap}`,
    hygiene: `Sweep removals a day: ${sweep}`,
    likes: `Likes may spend a day: ${settings.presave.likeDailyUnitCap}`,
  };
  const info = new Map(QUOTA_CONSUMERS.map((c) => [c.key, c]));
  const consumers = status.map((s) => {
    const c = info.get(s.key)!;
    const e = q.consumers[s.key] ?? { min: null, max: null, enabled: true };
    return {
      key: s.key,
      label: c.label,
      description: c.description,
      perAction: c.perAction,
      waitingCost: c.waitingCost,
      min: e.min,
      max: e.max,
      enabled: e.enabled,
      was: was[s.key] ?? null,
      status: s.status,
      spentToday: s.spentToday,
      waiting: s.waiting,
    };
  });
  return {
    pool,
    notConnected,
    resetsAt: quotaDayEnd(),
    margin: q.margin,
    projectBudget: q.projectBudget,
    consumers,
    outside: {
      uploads: uploads.map((u) => ({
        account: u.account,
        label: u.label,
        used: u.used,
        cap: u.cap,
        limit: UPLOADS_PER_PROJECT_DAY,
      })),
      apiKeyReads: { count: null, note: "their project is unknown" },
    },
    tokenSource: { lastPushAt: seen },
  };
}

quotaUiApp.get(QUOTA_PAGE.path, (c) => servePage(c, QUOTA_PAGE.html));

quotaUiApp.get("/api/quota", async (c) => c.json(await quotaPayload(c.env)));

quotaUiApp.put("/api/quota", async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body))
    return c.json({ error: "bad_body", issues: ["body: expected a JSON object"] }, 400);
  const b = body as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const k of ["order", "margin", "projectBudget", "consumers"]) if (k in b) patch[k] = b[k];
  const r = await updateAppSettings(c.env, { quota: patch });
  if (!r.ok) return c.json({ error: "invalid", issues: r.issues }, 400);
  makeLogger({
    reqId: c.req.raw.headers.get("cf-ray") ?? "local",
    route: "quota.save",
    by: c.get("cfAccessEmail"),
  }).info("quota.save", { keys: Object.keys(patch) });
  return c.json({ ok: true, ...(await quotaPayload(c.env)) });
});

quotaUiApp.post("/api/quota/projects/:key/clear", async (c) => {
  const key = c.req.param("key");
  const known = new Set((await poolProjects(c.env)).map((p) => p.key));
  for (const k of await indexedAccounts(c.env)) known.add(k);
  if (!known.has(key)) return c.json({ error: "unknown_project" }, 404);
  await clearProjectOut(c.env, key);
  makeLogger({
    reqId: c.req.raw.headers.get("cf-ray") ?? "local",
    route: "quota.clear",
    by: c.get("cfAccessEmail"),
  }).info("quota.clear", { project: key });
  return c.json({ ok: true });
});
