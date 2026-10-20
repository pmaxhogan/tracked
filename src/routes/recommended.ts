// Recommended sets (lib/track-sets.ts): the page and its read-only API over
// D1. Mounted inside subscriptionsApp, so behind its cfAccess gate and the
// /ui/api/* same-origin guard. Nothing here fetches 1001tracklists.
//   GET /ui/recommended                       the page
//   GET /ui/api/recommended                   data table (TKTable 'rs') + { progress }
//   GET /ui/api/recommended/:setId/tracks     { tracks }: the crawled tracks that list the set
import { Hono } from "hono";
import type { Env } from "../types";
import { tableResponse } from "../lib/table-query";
import { RECOMMENDED_TABLE, recommendedSetTracks, trackSetsSummary } from "../lib/track-sets";
import { servePage } from "../ui/pages";
import { RECOMMENDED_PAGE } from "../ui/pages/recommended";

export const recommendedApp = new Hono<{ Bindings: Env; Variables: { cfAccessEmail: string } }>();

recommendedApp.get(RECOMMENDED_PAGE.path, (c) => servePage(c, RECOMMENDED_PAGE.html));

recommendedApp.get("/api/recommended", (c) =>
  tableResponse(c, RECOMMENDED_TABLE, c.env.DB, {
    extra: async () => ({ progress: await trackSetsSummary(c.env) }),
  }),
);

recommendedApp.get("/api/recommended/:setId/tracks", async (c) => {
  const setId = c.req.param("setId");
  if (!/^[a-z0-9]{1,32}$/i.test(setId))
    return c.json({ error: "bad_set_id", message: "Not a tracklist id." }, 400);
  return c.json({ tracks: await recommendedSetTracks(c.env, setId) });
});
