import { OpenAPIHono } from "@hono/zod-openapi";
import { nowPlayingRoute, nowPlayingHandler } from "./routes/now-playing";
import { tracklistRoute, tracklistHandler } from "./routes/tracklist";
import { tracklistPurgeRoute, tracklistPurgeHandler } from "./routes/tracklist-purge";
import { likesRoute, likesHandler } from "./routes/likes";
import {
  presaveRoute,
  presaveHandler,
  presaveStatusRoute,
  presaveStatusHandler,
  presaveLikeBackfillRoute,
  presaveLikeBackfillHandler,
} from "./routes/presave";
import { drainPresaveLikes, retryDuePresaveLikes } from "./lib/presave-like";
import { retryDuePresavePlaylist } from "./lib/presave-playlist";
import { retryDueTrackPlaylistInserts } from "./lib/track-uploads";
import { retryDueSetPlaylistInserts } from "./lib/mkvid-playlist";
import { likedSongsRoute, likedSongsHandler } from "./routes/liked-songs";
import { HOME_HTML, subscriptionsApp } from "./routes/subscriptions";
import { servePage } from "./ui/pages";
import { legacyApp } from "./routes/legacy";
import { cfAccess } from "./middleware/cf-access";
import { noFraming, sameOriginJson } from "./middleware/same-origin";
import { mkvidApp } from "./routes/mkvid";
import { mkvidTrackApp, MkvidTrackClaimBody, MkvidTrackClaimResponse } from "./routes/mkvid-track";
import { mkvidPresaveApp } from "./routes/mkvid-presave";
import { mkvidAudioApp } from "./routes/mkvid-audio";
import { poolUiApp } from "./routes/pool-ui";
import { MkvidClaimBody, MkvidClaimResponse } from "./schemas";
import { bearerAuth } from "./middleware/auth";
import type { Env } from "./types";
import { backfillCombined } from "./lib/sync";
import { setMetaPagesStep } from "./lib/set-meta";
import { genrePlaylistsCronStep } from "./lib/genre-playlists";
import { getQuotaOut } from "./lib/youtube-quota";
import { runOrderPass } from "./lib/playlist-reorder";
import { runSchedulerTick } from "./lib/fetch-scheduler";
import { poolEventsApp } from "./routes/pool-api";
import { runKvMigrationTickSafely } from "./lib/kv-import";
import { pruneNowPlayingAudit } from "./lib/now-playing-audit";
import { prunePlaylistAdditions } from "./lib/playlist-audit";
import { pruneClaims } from "./lib/insert-claims";
import { makeLogger, errorFields } from "./lib/log";
import { drainPageCaptures } from "./lib/page-store";
import { drainSearchIndex } from "./lib/search/index";
import { poolPagesApp } from "./routes/pool-pages";
import { mkvidOpsApp } from "./routes/mkvid-ops";
import { prunePoolEvents, retryFailedPoolPushes } from "./lib/pool-events";
import { continueAppleBackstop } from "./lib/apple-backstop";
import { pruneSchedulerTicks, recordSchedulerTick } from "./lib/tick-history";
import { playlistHoldNotifier, runPlaylistHygiene } from "./lib/playlist-hygiene";
import { channelBanNotifier } from "./lib/channel-bans";
import { checkDeletedMkvidVideos, retryDueOldVideoDeletions } from "./lib/mkvid-recreate";
import { drainYoutubeLedger, youtubePoolHooks, youtubeTokenRefresher } from "./lib/google-oauth";
import { maybeSnapshotStats } from "./lib/stats";
import { setAccessTokenRefresher, setQuotaConsumer, setYoutubePool } from "./lib/youtube-playlists";
import { OWNER, type QuotaConsumerKey } from "./lib/quota-priority";
import { drainLinkPrewarm } from "./lib/link-prewarm";
import { drainTrackSets } from "./lib/track-sets";
import { graphPagesStep } from "./lib/graph/backfill";
import { getAppSettings } from "./lib/app-settings";

// Validation failures (zod) default to `{ success:false, error:<ZodError> }`,
// which is not the `{ error, message }` shape every route documents. Normalise
// so clients (the Tasker toasts in particular) can always read `.message`.
const app = new OpenAPIHono<{ Bindings: Env }>({
  defaultHook: (result, c) => {
    if (result.success) return;
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`);
    return c.json({ error: "invalid_request", message: issues.join("; ") }, 400);
  },
});

// A YouTube 401 retries once with a force-refreshed token (lib/youtube-playlists.ts
// authedFetch), and every call draws from the quota pool (lib/youtube-pool.ts):
// counted on its project, moved to the next one after a daily-quota reply.
// Set once per env (in production one env serves the whole isolate).
let tokenRefresherEnv: Env | null = null;
function ensureTokenRefresher(env: Env): void {
  if (tokenRefresherEnv === env) return;
  const log = makeLogger({ task: "youtube.auth" });
  setAccessTokenRefresher(youtubeTokenRefresher(env, log), { log });
  setYoutubePool(youtubePoolHooks(env));
  tokenRefresherEnv = env;
}

app.use("*", async (c, next) => {
  ensureTokenRefresher(c.env);
  // The quota ledger's consumer (lib/quota-priority.ts): the admin UI is the owner's; anything else starts
  // unnamed and each gated consumer names itself, so a previous request's consumer never carries over.
  const path = new URL(c.req.url).pathname;
  setQuotaConsumer(
    path === "/ui" || path.startsWith("/ui/") || path.startsWith("/api/") ? OWNER : null,
  );
  await next();
});

// Stored pages (lib/page-store.ts), search index writes (lib/search/index.ts), pre-save likes (lib/presave-like.ts) and YouTube quota ledger rows run in the background; hand them to waitUntil once the response is built.
app.use("*", async (c, next) => {
  await next();
  try {
    c.executionCtx.waitUntil(
      Promise.all([
        drainPageCaptures(),
        drainSearchIndex(),
        // Likes spend quota too: the ledger is written after them.
        drainPresaveLikes().then(() => drainYoutubeLedger()),
      ]),
    );
  } catch {
    /* no executionCtx (tests): captures still run */
  }
});

app.openapi(nowPlayingRoute, nowPlayingHandler);
app.openapi(tracklistRoute, tracklistHandler);
app.openapi(tracklistPurgeRoute, tracklistPurgeHandler);
app.openapi(likesRoute, likesHandler);
// Pre-save a track (routes/presave.ts), same Tasker bearer.
app.openapi(presaveRoute, presaveHandler);
app.openapi(presaveStatusRoute, presaveStatusHandler);
app.openapi(presaveLikeBackfillRoute, presaveLikeBackfillHandler);
// Gated by its own LIKED_SONGS_TOKEN. Must stay above the API_TOKEN wildcard
// gate below - a route registered first, with route-level middleware, answers
// before that gate ever runs.
app.openapi(likedSongsRoute, likedSongsHandler);

// Public root: send a browser to the admin UI (Access-gated there). Anything
// else outside the Access and own-token surfaces requires the bearer token.
app.get("/", (c) => c.redirect("/ui/", 302));

// Browsers auto-request /favicon.ico for every page; serve a tiny 204 so it
// doesn't fall through to the bearer-token gate and show up as 401 noise in
// logs.
app.get("/favicon.ico", (c) => c.body(null, 204));

// Admin UI (DJ subscriptions, pool, playlists, mkvid). Gated by Cloudflare Access
// (verified inside the sub-apps' middleware), NOT by the Tasker bearer token.
// CSRF guard for every state-changing admin API call (middleware/same-origin.ts).
// Registered before the sub-apps so it runs ahead of their handlers.
app.use("/ui/api/*", sameOriginJson);
app.use("/ui/oauth/disconnect", sameOriginJson);
// Admin pages may not be framed by another site (the captcha page frames its own live view).
app.use("/ui", noFraming);
app.use("/ui/*", noFraming);
app.route("/ui", poolUiApp); // ahead of subscriptionsApp so its '*' gate doesn't run twice
app.route("/ui", subscriptionsApp);
// Routing is strict: the sub-apps' get('/') answers /ui but not /ui/, so the
// trailing-slash home is registered here, behind the same Access gate.
app.use("/ui/", cfAccess);
app.get("/ui/", (c) => servePage(c, HOME_HTML));
// Old prefix: 301 for pages, 410 for API / OAuth / sw.js (routes/legacy.ts). No content, no Access needed.
app.route("/subscriptions", legacyApp);

// Work queue for mkvid (the NAS render/upload service). Gated by its own
// MKVID_TOKEN inside the sub-app, so like /ui it must be skipped by
// the API_TOKEN wildcard gate below.
app.route("/mkvid/audio", mkvidAudioApp); // audio cue estimation for held sets (routes/mkvid-audio.ts), same MKVID_TOKEN; ahead of /mkvid
app.route("/mkvid/presave", mkvidPresaveApp); // pre-save match searches (routes/mkvid-presave.ts), same MKVID_TOKEN; ahead of /mkvid
app.route("/mkvid/track", mkvidTrackApp); // mkvid's track-upload queue (routes/mkvid-track.ts), same MKVID_TOKEN; ahead of /mkvid
app.route("/mkvid", mkvidApp);

// tlpool's webhook (POST /pool/events), gated by TLPOOL_TOKEN inside the
// sub-app - skipped by the API_TOKEN wildcard gate below, like /mkvid.
app.route("/pool", poolPagesApp); // GET /pool/pages*, bearer API_TOKEN, gated per path; before poolEventsApp's '*' gate
app.route("/pool", poolEventsApp);
// Operator actions on mkvid requests, bearer API_TOKEN inside the sub-app (routes/mkvid-ops.ts).
app.route("/ops", mkvidOpsApp);
// Documented here only (the sub-app is plain Hono), so mkvid's side has a
// published contract for the claim, track list included.
app.openAPIRegistry.registerPath({
  method: "post",
  path: "/mkvid/claim",
  summary: "Claim the next set for mkvid to render and upload (bearer MKVID_TOKEN)",
  request: {
    body: {
      required: false,
      content: { "application/json": { schema: MkvidClaimBody } },
    },
  },
  responses: {
    200: {
      description: "The claimed request with its track list, or null.",
      content: { "application/json": { schema: MkvidClaimResponse } },
    },
  },
});
app.openAPIRegistry.registerPath({
  method: "post",
  path: "/mkvid/track/claim",
  summary:
    "Claim the next pre-saved track for mkvid to rip, render and upload (bearer MKVID_TOKEN; job/complete/fail in routes/mkvid-track.ts)",
  request: {
    body: { required: false, content: { "application/json": { schema: MkvidTrackClaimBody } } },
  },
  responses: {
    200: {
      description: "The claimed track request, or null.",
      content: { "application/json": { schema: MkvidTrackClaimResponse } },
    },
  },
});

// Bearer-gate everything else, including /openapi.json and /doc. Skip
// / (a redirect), /ui/* (Access), /subscriptions/* (legacy answers, no
// content), /mkvid/* and /pool/* - a naive wildcard would double-gate those
// surfaces, since Hono runs parent middleware after a mounted sub-app's
// handlers; their own gate would pass but then bearerAuth would 401 the
// token it doesn't recognise.
app.use("*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === "/") return next();
  if (path === "/ui" || path.startsWith("/ui/")) return next();
  if (path === "/subscriptions" || path.startsWith("/subscriptions/")) return next();
  if (path === "/mkvid" || path.startsWith("/mkvid/")) return next();
  if (path === "/pool" || path.startsWith("/pool/")) return next();
  if (path === "/ops" || path.startsWith("/ops/")) return next();
  return bearerAuth(c, next);
});

app.doc("/openapi.json", {
  openapi: "3.0.0",
  info: {
    title: "tracked",
    version: "0.0.1",
    description: "Resolve currently-playing track in a YouTube DJ set via 1001tracklists.",
  },
});

/**
 * Cron trigger handler. Configured in wrangler.jsonc -> `triggers.crons`:
 *   - `*\/5 * * * *`  heartbeat - one scheduler tick (lib/fetch-scheduler.ts):
 *                     a small random number of due 1001tracklists fetches
 *                     (DJ discovery, new sets, verification second fetches,
 *                     rechecks by set age, DJ backfill), highest priority
 *                     first, stopping at the pool's first refusal. tlpool owns
 *                     budget and pacing; nothing here bursts. Then a few
 *                     per-track link lookups the sync queued (lib/link-prewarm.ts,
 *                     linkPrewarm.maxPerTick at priority backfill), so a phone
 *                     tap finds every track's links cached. Then a few page
 *                     views of the track-page crawl (lib/track-sets.ts,
 *                     trackSets.viewsPerTick at priority backfill) for the
 *                     Recommended sets page.
 *   - `0 6 * * *`    daily housekeeping only (audit pruning). It no longer
 *                     crawls every DJ at once: discovery is spread around the
 *                     clock by the scheduler.
 *
 * Both finish by reconciling the combined "all tracked artists" playlist
 * and a few moves towards set-date order (lib/playlist-reorder.ts)
 * (YouTube only, no 1001tracklists traffic).
 *
 * `ctx.waitUntil` keeps the worker alive past `scheduled` returning.
 */
async function scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
  ensureTokenRefresher(env);
  const isDaily = event.cron === "0 6 * * *";
  const log = makeLogger({
    task: isDaily ? "cron.daily" : "cron.tick",
    cron: event.cron,
    ts: event.scheduledTime,
  });
  log.info("cron.start");
  /** Each cron step starts with its own ledger consumer, so one step's calls are never charged to the step before. */
  const step = (key: QuotaConsumerKey | null) => setQuotaConsumer(key);
  ctx.waitUntil(
    (async () => {
      try {
        const trigger = isDaily ? "cron.daily" : "cron.tick";
        // One-time KV -> D1 import, a bounded slice per tick until it reports
        // done (then a cheap flag check).
        await runKvMigrationTickSafely(env, log);
        // Old mkvid videos a recreation replaced: retry the YouTube deletes that are due (never throws).
        if (env.MKVID_TOKEN) {
          step("mkvid_recreate");
          const d = await retryDueOldVideoDeletions(env, log);
          if (d.tried) log.info("cron.mkvid_old_video_deletes", d);
          // Delivered videos deleted on YouTube: out of the playlists, rendered again (self-paced, never throws).
          step("mkvid_recreate");
          if (!isDaily) await checkDeletedMkvidVideos(env, log);
        }
        if (isDaily) {
          // D1 has no TTLs: keep the audit trails at the 90-day horizon (scheduler tick history: 14 days).
          try {
            log.info("cron.audit_pruned", {
              nowPlaying: await pruneNowPlayingAudit(env),
              playlistAdditions: await prunePlaylistAdditions(env),
              poolEvents: await prunePoolEvents(env),
              schedulerTicks: await pruneSchedulerTicks(env),
              insertClaims: await pruneClaims(env),
            });
          } catch (e) {
            log.warn("cron.audit_prune_threw", errorFields(e));
          }
        } else {
          try {
            const at = Math.floor(Date.now() / 1000);
            const t0 = Date.now();
            try {
              // A real timer: the tick spreads its fetches over tick.spreadSeconds (waiting costs no CPU).
              step("dj_playlists");
              const r = await runSchedulerTick(env, {
                log,
                sleep: (ms) => new Promise<void>((res) => setTimeout(res, ms)),
              });
              log.info("cron.done", {
                skipped: r.skipped ?? null,
                drawn: r.drawn,
                ran: r.items.length,
                stoppedBy: r.stoppedBy ?? null,
              });
              await recordSchedulerTick(env, at, Date.now() - t0, r);
            } catch (e) {
              await recordSchedulerTick(
                env,
                at,
                Date.now() - t0,
                null,
                e instanceof Error ? `${e.name}: ${e.message}` : String(e),
              );
              throw e;
            }
          } catch (e) {
            log.error("cron.threw", errorFields(e));
          }
          // Per-track links of the sets the sync read, a few a tick at pool priority backfill, after the tick's own fetches (lib/link-prewarm.ts; never throws).
          step(null);
          const w = await drainLinkPrewarm(env, log);
          if (w.read > 0 || w.stoppedBy) log.info("cron.link_prewarm", w);
          // The sets each followed set's track was played in, a few page views a tick at pool priority backfill (lib/track-sets.ts; never throws).
          const ts = await drainTrackSets(env, log);
          if (ts.views > 0 || ts.seeded > 0 || ts.stoppedBy) log.info("cron.track_sets", ts);
          // The Graph tab's sources and credits from stored set pages, a few a tick; no pool fetch (lib/graph/backfill.ts; never throws).
          const gs = (await getAppSettings(env)).graph;
          if (gs.pagesPerTick > 0) {
            const g = await graphPagesStep(env, { limit: gs.pagesPerTick, log });
            if (g.read > 0) log.info("cron.graph_pages", g);
          }
          // Genres and the rest of the page from stored set pages, a few a tick; no pool fetch (lib/set-meta.ts; never throws).
          const mp = (await getAppSettings(env)).genres.metaPagesPerTick;
          if (mp > 0) {
            const m = await setMetaPagesStep(env, { limit: mp, log });
            if (m.read > 0) log.info("cron.set_meta_pages", m);
          }
        }
        // The Stats page's hourly snapshot (lib/stats.ts; never throws, at most once an hour).
        if (!isDaily && (await maybeSnapshotStats(env, log))) log.info("cron.stats_snapshot");
        try {
          await retryFailedPoolPushes(env, { log });
        } catch (e) {
          log.warn("cron.push_retries_threw", errorFields(e));
        }
        // An unfinished Apple Music backstop run goes on by one batch a tick (lib/apple-backstop.ts).
        if (!isDaily)
          await continueAppleBackstop(env, log).catch((e) =>
            log.warn("cron.apple_backstop_threw", errorFields(e)),
          );
        // Separate try/catch: a failed tick shouldn't stop the combined
        // playlist from catching up on everything that *did* land.
        // It waits its turn at the quota like every consumer (lib/quota-priority.ts, inside backfillCombined).
        // Genre playlists: after mkvid's recreate check and before the combined playlist (lib/genre-playlists.ts; never throws).
        step("genre_playlists");
        {
          const gr = await genrePlaylistsCronStep(env, log, trigger);
          if (!gr.ok || gr.inserted > 0 || gr.failed > 0 || gr.pruned > 0)
            log.info("cron.genre_playlists", gr);
        }
        try {
          step("combined");
          log.info(
            "cron.combined_backfill",
            (await getQuotaOut(env))
              ? { skipped: "youtube_quota_out" }
              : await backfillCombined(env, { log, trigger }),
          );
        } catch (e) {
          log.error("cron.combined_backfill_threw", errorFields(e));
        }
        // Pre-saved tracks whose like is due (lib/presave-like.ts), after the playlists had their turn at the quota; one indexed query when none, never throws.
        if (!isDaily) {
          step("likes");
          const l = await retryDuePresaveLikes(env, log);
          if (l.tried || l.stoppedBy) log.info("cron.presave_likes", l);
          // Pre-saves with a video that are not in the Pre-saves playlist yet (lib/presave-playlist.ts; never throws).
          step("presave_playlists");
          const pp = await retryDuePresavePlaylist(env, log);
          if (pp.added || pp.failed) log.info("cron.presave_playlist", pp);
          // Set uploads whose playlist insert waits (quota, rate limit, 5xx) and is due again (lib/mkvid-playlist.ts; never throws).
          step("dj_playlists");
          const sp = await retryDueSetPlaylistInserts(env, log);
          if (sp.tried || sp.stoppedBy) log.info("cron.set_playlist_inserts", sp);
          // Track uploads whose playlist insert failed (quota, rate limit, 5xx) and is due again (lib/track-uploads.ts; never throws).
          step("presave_playlists");
          const t = await retryDueTrackPlaylistInserts(env, log);
          if (t.tried || t.stoppedBy) log.info("cron.track_playlist_inserts", t);
        }
        // Playlists in set-date order: a few moves within the day's unit budget (lib/playlist-reorder.ts).
        try {
          step("ordering");
          const o = await runOrderPass(env, { log, trigger });
          if (o.read > 0 || o.stoppedBy === "quota" || o.stoppedBy === "held")
            log.info("cron.playlist_order", o);
        } catch (e) {
          log.warn("cron.playlist_order_threw", errorFields(e));
        }
        // 6-hourly playlist comparison + full-recording sweep; self-paced, never throws.
        step("hygiene");
        await runPlaylistHygiene(env, log, {
          notify: playlistHoldNotifier(env, log),
          banNotify: channelBanNotifier(env, log),
        });
      } finally {
        // Stored pages finish even when the tick threw.
        await drainPageCaptures();
        // Likes a scheduled check started (they swallow their own errors).
        await drainPresaveLikes();
        // The quota ledger rows of this tick's YouTube calls, after the likes (which spend quota too).
        await drainYoutubeLedger();
        // Search index writes started by this tick's verified fetches, likewise (they swallow their own errors).
        try {
          await drainSearchIndex();
        } catch (e) {
          log.warn("cron.search_drain_threw", errorFields(e));
        }
      }
    })(),
  );
}

/** Exported for route-level tests (app.request). */
export { app };

export default {
  fetch: app.fetch.bind(app),
  scheduled,
};
