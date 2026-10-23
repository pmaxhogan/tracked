// Genre playlists (lib/genre-playlists.ts): the Genres pages and their API.
// Mounted inside subscriptionsApp, so behind its cfAccess gate and the
// /ui/api/* same-origin guard. Nothing here fetches 1001tracklists.
//   GET  /ui/genres                        the list (TKTable 'gn', local rows)
//   GET  /ui/genres/:key                   one genre: its playlist, status, actions and sets
//   GET  /ui/api/genres                    { connected, rows: GenreRow[], settings }
//   GET  /ui/api/genres/:key               { connected, genre: GenreRow, sets: GenreSetRow[] }
//   POST /ui/api/genres/:key/backfill      Backfill now: one run for this genre, spent as the owner
//   POST /ui/api/genres/:key/enabled       { enabled: true | false | null } (null = automatic)
//   POST /ui/api/genres/:key/refresh       read the playlist from YouTube again on its next run
import { Hono } from "hono";
import type { Env } from "../types";
import { getAppSettings } from "../lib/app-settings";
import {
  genreOverview,
  genreSets,
  refreshGenrePlaylist,
  runGenrePlaylists,
  setGenreChoice,
} from "../lib/genre-playlists";
import { loadTokens } from "../lib/google-oauth";
import { makeLogger } from "../lib/log";
import { servePage } from "../ui/pages";
import { GENRE_PAGE, GENRES_PAGE } from "../ui/pages/genres";

export const genresApp = new Hono<{ Bindings: Env; Variables: { cfAccessEmail: string } }>();

const KEY_RE = /^[a-z0-9][a-z0-9'&.-]{0,79}$/;
const badKey = { error: "bad_genre", message: "Not a genre key." } as const;

async function connected(env: Env): Promise<boolean> {
  try {
    return (await loadTokens(env)) !== null;
  } catch {
    return false;
  }
}

genresApp.get(GENRES_PAGE.path, (c) => servePage(c, GENRES_PAGE.html));
genresApp.get("/genres/:key", (c) => servePage(c, GENRE_PAGE.html));

genresApp.get("/api/genres", async (c) => {
  const settings = await getAppSettings(c.env);
  const isConnected = await connected(c.env);
  return c.json({
    connected: isConnected,
    rows: await genreOverview(c.env, { connected: isConnected, settings }),
    settings: settings.genres,
  });
});

genresApp.get("/api/genres/:key", async (c) => {
  const key = c.req.param("key");
  if (!KEY_RE.test(key)) return c.json(badKey, 400);
  const isConnected = await connected(c.env);
  const [genre] = await genreOverview(c.env, { key, connected: isConnected });
  if (!genre)
    return c.json({ error: "not_found", message: "No followed set has this genre." }, 404);
  return c.json({
    connected: isConnected,
    genre,
    sets: await genreSets(c.env, key),
    settings: (await getAppSettings(c.env)).genres,
  });
});

genresApp.post("/api/genres/:key/backfill", async (c) => {
  const key = c.req.param("key");
  if (!KEY_RE.test(key)) return c.json(badKey, 400);
  const log = makeLogger({ task: "ui.genre_backfill", genre: key });
  return c.json(await runGenrePlaylists(c.env, { log, trigger: "manual.genre", only: key }));
});

genresApp.post("/api/genres/:key/enabled", async (c) => {
  const key = c.req.param("key");
  if (!KEY_RE.test(key)) return c.json(badKey, 400);
  const body = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null;
  const enabled = body?.enabled;
  if (!(enabled === true || enabled === false || enabled === null))
    return c.json({ error: "invalid_request", message: "enabled: true, false or null" }, 400);
  const [genre] = await genreOverview(c.env, { key });
  if (!genre)
    return c.json({ error: "not_found", message: "No followed set has this genre." }, 404);
  await setGenreChoice(c.env, key, genre.name, enabled);
  const [after] = await genreOverview(c.env, { key, connected: await connected(c.env) });
  return c.json({ ok: true, genre: after });
});

genresApp.post("/api/genres/:key/refresh", async (c) => {
  const key = c.req.param("key");
  if (!KEY_RE.test(key)) return c.json(badKey, 400);
  return c.json({ ok: true, refreshed: await refreshGenrePlaylist(c.env, key) });
});
