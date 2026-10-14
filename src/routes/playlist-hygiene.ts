/**
 * Playlist hygiene routes (lib/playlist-hygiene.ts), mounted inside the
 * /ui sub-app, so Cloudflare Access gates every one of them:
 *
 *   GET  /ui/removed                     what was (or in a dry run would be) removed, and why
 *   GET  /ui/api/removals                the rows behind it (a data-table endpoint, lib/table-query.ts:
 *                                        page/size/sort/q/f.<col>), plus counts, DJs, settings, holds
 *   POST /ui/api/removals/:id/undo       re-add (or, for a dry-run row, keep) one video
 *   POST /ui/api/removals/holds/:playlistId/approve   apply a held comparison once
 *   POST /ui/api/removals/dead-holds/:playlistId/approve   let a playlist's many dead videos be taken out
 *   POST /ui/api/hygiene/run?what=compare|sweep       run one step now
 *   POST /ui/api/set/remove-replace      the set card's "remove and replace" button
 *   GET  /ui/bans                        the channel-ban questions and answered channels
 *   GET  /ui/api/bans                    the rows behind it (lib/channel-bans.ts listBanQueue) + the sweep's dry-run flag
 *   POST /ui/api/bans/:channelId/ban|decline|lift   the owner's answer
 */

import { getAppSettings } from "../lib/app-settings";
import { Hono } from "hono";
import type { Env } from "../types";
import { getAccessToken } from "../lib/google-oauth";
import { errorFields, makeLogger } from "../lib/log";
import {
  approveDeadHold,
  approveHold,
  DEAD_GRACE_DAYS,
  listDeadHolds,
  listHolds,
  REMOVALS_TABLE,
  removalDjs,
  removalCounts,
  REASON_LABELS,
  removeAndReplace,
  requestSweepSoon,
  runPlaylistHygiene,
  sweepDeletesUsed,
  sweepSettings,
  undoRemoval,
} from "../lib/playlist-hygiene";
import { channelBanNotifier, decideBan, listBanQueue, processBanQueue } from "../lib/channel-bans";
import { BANS_PAGE_HTML } from "../ui/pages/bans";
import { parseDjSlug } from "../lib/subscriptions";
import { tableResponse } from "../lib/table-query";
import { normalizeTracklistUrl } from "../lib/tracklists1001";
import { servePage } from "../ui/pages";
import { REMOVED_PAGE_HTML } from "../ui/pages/removed";

export const hygieneApp = new Hono<{ Bindings: Env; Variables: { cfAccessEmail: string } }>();

const reqLog = (c: { req: { raw: Request }; get: (k: "cfAccessEmail") => string }, route: string) =>
  makeLogger({
    reqId: c.req.raw.headers.get("cf-ray") ?? "local",
    route,
    by: c.get("cfAccessEmail"),
  });

hygieneApp.get("/removed", (c) => servePage(c, REMOVED_PAGE_HTML));

// Home and Playlists read only the extras (holds, settings, deletes today); they
// still send their old `?limit=1`, which the table contract ignores.
hygieneApp.get("/api/removals", async (c) =>
  tableResponse(c, REMOVALS_TABLE, c.env.DB, {
    extra: async () => {
      const [counts, settings, deletesUsedToday, holds, deadHolds, djs] = await Promise.all([
        removalCounts(c.env),
        getAppSettings(c.env).then((app) => sweepSettings(c.env, app)),
        sweepDeletesUsed(c.env),
        listHolds(c.env),
        listDeadHolds(c.env),
        removalDjs(c.env),
      ]);
      return {
        counts,
        settings,
        deletesUsedToday,
        holds,
        deadHolds,
        deadGraceDays: DEAD_GRACE_DAYS,
        djs,
        reasonLabels: REASON_LABELS,
      };
    },
  }),
);

hygieneApp.post("/api/removals/:id/undo", async (c) => {
  const log = reqLog(c, "subs.hygiene.undo");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "invalid_id" }, 400);
  const token = await getAccessToken(c.env);
  if (!token) return c.json({ error: "youtube_not_connected" }, 409);
  const r = await undoRemoval(c.env, token.accessToken, id, log);
  if (!r.ok) return c.json({ error: r.error }, r.error === "not_found" ? 404 : 409);
  return c.json(r);
});

hygieneApp.post("/api/removals/holds/:playlistId/approve", async (c) => {
  const ok = await approveHold(c.env, c.req.param("playlistId"));
  return ok ? c.json({ ok: true }) : c.json({ error: "not_held" }, 404);
});

hygieneApp.post("/api/removals/dead-holds/:playlistId/approve", async (c) => {
  const ok = await approveDeadHold(c.env, c.req.param("playlistId"));
  return ok ? c.json({ ok: true }) : c.json({ error: "not_held" }, 404);
});

hygieneApp.post("/api/hygiene/run", async (c) => {
  const what = c.req.query("what");
  if (what !== "compare" && what !== "sweep")
    return c.json({ error: "invalid_request", message: "what=compare|sweep" }, 400);
  const log = reqLog(c, `subs.hygiene.run.${what}`);
  return c.json(await runPlaylistHygiene(c.env, log, { force: what }));
});

// --- channel bans (lib/channel-bans.ts) ---------------------------------------

hygieneApp.get("/bans", (c) => servePage(c, BANS_PAGE_HTML));

hygieneApp.get("/api/bans", async (c) => {
  const [queue, settings] = await Promise.all([
    listBanQueue(c.env),
    getAppSettings(c.env).then((app) => sweepSettings(c.env, app)),
  ]);
  c.header("Cache-Control", "no-store");
  return c.json({ ...queue, dryRun: settings.dryRun });
});

hygieneApp.post("/api/bans/:channelId/:action", async (c) => {
  const action = c.req.param("action");
  if (action !== "ban" && action !== "decline" && action !== "lift")
    return c.json({ error: "invalid_request", message: "action is ban, decline or lift" }, 400);
  const channelId = c.req.param("channelId");
  const r = await decideBan(c.env, channelId, action);
  if (!r.ok) return c.json({ error: r.error }, r.error === "not_found" ? 404 : 409);
  // Its videos in the playlists should not wait up to 6 hours for the sweep.
  if (action === "ban") await requestSweepSoon(c.env);
  reqLog(c, "subs.bans.decide").info("bans.decided", { channelId, action, state: r.state });
  const settings = sweepSettings(c.env, await getAppSettings(c.env));
  return c.json({ ok: true, state: r.state, dryRun: settings.dryRun });
});

hygieneApp.post("/api/set/remove-replace", async (c) => {
  const log = reqLog(c, "subs.hygiene.remove_replace");
  const body = (await c.req.json().catch(() => null)) as { slug?: unknown; url?: unknown } | null;
  const slug = typeof body?.slug === "string" ? parseDjSlug(body.slug) : null;
  const url = typeof body?.url === "string" ? normalizeTracklistUrl(body.url) : null;
  if (!slug || !url)
    return c.json(
      { error: "invalid_request", message: "slug and a 1001tracklists set url are required" },
      400,
    );
  const token = await getAccessToken(c.env);
  if (!token) return c.json({ error: "youtube_not_connected" }, 409);
  const r = await removeAndReplace(c.env, token.accessToken, { slug, setUrl: url, log });
  if (!r.ok) {
    const message =
      r.error === "no_video"
        ? "this set has no video in the playlists"
        : r.error === "mkvid_video"
          ? "the video is an mkvid render; use Delete and recreate instead"
          : "set not known to the sync";
    return c.json({ error: r.error, message }, r.error === "not_found" ? 404 : 409);
  }
  // The owner just judged this video: its channel gets a ban question (and a push) now, not at the next comparison.
  let banQuestion = false;
  try {
    const q = await processBanQueue(c.env, {
      log,
      accessToken: token.accessToken,
      notify: channelBanNotifier(c.env, log),
    });
    banQuestion = q.asked + q.updated > 0;
  } catch (e) {
    log.warn("bans.queue_failed", errorFields(e));
  }
  return c.json({ ...r, banQuestion });
});
