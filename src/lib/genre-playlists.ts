/**
 * Genre playlists: one YouTube playlist per 1001tracklists genre, holding the
 * video of every followed DJ's set of that genre (sets, not tracks), in
 * set-date order like the DJ playlists.
 *
 * **What goes in.** A set's genres come from its page (lib/set-meta.ts,
 * `set_genres`). Its video goes into a genre playlist once it is in one of
 * the DJ playlists (`playlist_confirmed` state `in` for a `sub_sync`
 * playlist): the DJ playlist's vetting (the full-recording rule, the owner's
 * removals, channel bans) has passed it, so the genre playlist inherits that
 * judgement instead of repeating it.
 *
 * **Which genres get a playlist (the policy).** 1001tracklists has about 40
 * genres and most followed sets carry two, so a playlist for each would cost
 * quota for genres nobody listens to. A genre gets its playlist automatically
 * once it has `genres.minSets` (default 10) sets with a video, while
 * `genres.auto` is on (default); the owner can switch any genre on (whatever
 * its count) or off on /ui/genres, and that choice sticks
 * (`genre_playlists.enabled`, NULL = automatic).
 *
 * **Quota.** Inserts spend the pooled YouTube quota as the `genre_playlists`
 * consumer, ranked after "mkvid gone check and recreate" and before the
 * combined playlist (lib/quota-priority.ts). A run asks the gate once for its
 * whole plan (inserts x 50, at least one insert's worth), at most
 * `genres.maxInsertsPerRun` (default 20) inserts and a 10 s wall clock per
 * run, and the consumer's daily max (5,000 units by default, settings.quota)
 * bounds the day. Genres are worked least complete first, so a big backfill
 * spreads over every genre instead of filling one at a time. The owner's
 * Backfill now on a genre page spends as the owner.
 *
 * **Order.** Inserts go through `insertInOrder` (lib/playlist-order-store.ts)
 * at the place the set's date gives them, and the playlists are in the
 * set-date ordering pass (lib/playlist-reorder.ts managedPlaylists).
 *
 * **What is never put back.** A video that was in a genre playlist and is
 * gone from it (for more than a day, so a listing that lags an insert is not
 * taken for a removal) was removed by the owner: `removed`, never re-added.
 * One that cannot be inserted (deleted, private) is `unavailable`. A failed
 * insert is tried again on later runs, MAX_ATTEMPTS times.
 *
 * Not in scope (left to the DJ playlists): the 6-hourly comparison and the
 * full-recording sweep do not read genre playlists.
 */
import type { Env } from "../types";
import { getAppSettings, type AppSettings } from "./app-settings";
import { getAccessToken } from "./google-oauth";
import { errorFields, type Logger } from "./log";
import {
  cachePlaylistVideoIds,
  findOrCreatePlaylist,
  getCachedPlaylistVideoIds,
  invalidatePlaylistVideoIds,
} from "./playlist-cache";
import { insertInOrder, type OrderKeyCache } from "./playlist-order-store";
import { OWNER, quotaGate, REFUSAL_TEXT, type GateRefusal } from "./quota-priority";
import { quotaKind } from "./youtube-error";
import {
  isPermanentInsertError,
  isQuotaError,
  PlaylistNotFoundError,
  YouTubeApiError,
} from "./youtube-playlists";
import { getQuotaOut, noteQuotaOut } from "./youtube-quota";

export const genrePlaylistTitle = (name: string) => `${name} sets (1001tklists)`;
export const genrePlaylistDescription = (name: string) =>
  `Every set tagged ${name} on 1001tracklists, across every DJ tracked by this app, in the order they were played. Updated automatically.`;

/** Failed inserts of one video before it is left alone. */
export const MAX_ATTEMPTS = 3;
/** A video in the playlist this long before its absence from a listing counts as the owner's removal. */
const REMOVAL_GRACE_SECONDS = 24 * 60 * 60;
/** Wall-clock ceiling of one run. */
const RUN_DEADLINE_MS = 10_000;
/** CACHE KV: how the last run ended (its stop reason feeds the "held" status). */
export const LAST_RUN_KEY = "genres:last_run";
/** CACHE KV: held while a run works (KV's shortest expiry; a run ends well inside it). */
const LOCK_KEY = "genres:lock";
const LOCK_TTL = 120;
const LAST_RUN_TTL = 6 * 60 * 60;

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** A quota reply: the day's quota (`quota`) or a per-minute limit (`rate_limit`). */
const quotaStopOf = (e: unknown): GenreStop =>
  quotaKind((e as YouTubeApiError).reason) === "quota" ? "quota" : "rate_limit";

export type GenreStatus =
  "off" | "below_min" | "not_connected" | "not_created" | "pending" | "held" | "synced";

export type GenreRow = {
  key: string;
  name: string;
  /** Followed DJs' sets with this genre. */
  sets: number;
  /** Their videos that are in a DJ playlist: what the genre playlist should hold. */
  videos: number;
  /** Videos still to add (not in, not given up on, not removed by the owner). */
  pending: number;
  inPlaylist: number;
  failed: number;
  unavailable: number;
  removed: number;
  /** The owner's choice: null = automatic. */
  choice: boolean | null;
  /** Whether the genre has a playlist that is kept filled. */
  enabled: boolean;
  playlistId: string | null;
  playlistUrl: string | null;
  musicUrl: string | null;
  lastRunAt: number | null;
  status: GenreStatus;
  /** One line for the page. */
  statusText: string;
};

export type LastRun = {
  at: number;
  trigger: string | null;
  inserted: number;
  failed: number;
  stoppedBy: GenreStop;
  held?: GateRefusal | null;
};

export type GenreStop =
  null | "run" | "deadline" | "quota" | "rate_limit" | "held" | "not_connected" | "nothing";

const ELIGIBLE_SQL = `
  SELECT g.genre_key AS k, t.video_id AS v, MIN(t.url) AS set_url, MAX(COALESCE(s.set_date, '')) AS set_date
    FROM set_genres g JOIN tracklists t ON t.url = g.set_url
    LEFT JOIN set_schedule s ON s.url = t.url
   WHERE t.video_id IS NOT NULL AND t.abandoned = 0 AND t.slug IN (SELECT slug FROM subscriptions)
     AND EXISTS (SELECT 1 FROM playlist_confirmed c JOIN sub_sync y ON y.playlist_id = c.playlist_id
                  WHERE c.video_id = t.video_id AND c.state = 'in')`;

/** Not to be inserted now: in already, given up on, or the owner removed it. */
const SETTLED_SQL = `(i.state IN ('in', 'unavailable', 'removed') OR (i.state = 'failed' AND i.attempts >= ${MAX_ATTEMPTS}))`;

export const playlistUrlOf = (id: string) => `https://www.youtube.com/playlist?list=${id}`;
export const musicUrlOf = (id: string) => `https://music.youtube.com/playlist?list=${id}`;

async function loadLastRun(env: Env): Promise<LastRun | null> {
  try {
    return (await env.CACHE.get<LastRun>(LAST_RUN_KEY, "json")) ?? null;
  } catch {
    return null;
  }
}

async function saveLastRun(env: Env, r: LastRun): Promise<void> {
  try {
    await env.CACHE.put(LAST_RUN_KEY, JSON.stringify(r), { expirationTtl: LAST_RUN_TTL });
  } catch {
    // Only the status line reads it.
  }
}

type PlaylistRow = {
  genre_key: string;
  genre_name: string;
  enabled: number | null;
  playlist_id: string | null;
  last_run_at: number | null;
};

/**
 * Every genre the followed DJs' sets carry, with its counts, the owner's
 * choice, its playlist and a status. One genre with `key`. Never throws on a
 * missing table (an unapplied migration): no genres then.
 */
export async function genreOverview(
  env: Env,
  opts: { key?: string; connected?: boolean; settings?: AppSettings } = {},
): Promise<GenreRow[]> {
  const db = env.DB;
  const settings = opts.settings ?? (await getAppSettings(env));
  const one = opts.key ?? null;
  let sets: Array<{ k: string; name: string; sets: number }>;
  let vids: Array<{ k: string; videos: number; pending: number }>;
  let items: Array<{ k: string; state: string; n: number }>;
  let rows: PlaylistRow[];
  try {
    sets = (
      await db
        .prepare(
          `SELECT g.genre_key AS k, MIN(g.genre_name) AS name, COUNT(DISTINCT g.set_url) AS sets
             FROM set_genres g
            WHERE (?1 IS NULL OR g.genre_key = ?1)
              AND g.set_url IN (SELECT url FROM tracklists WHERE abandoned = 0 AND slug IN (SELECT slug FROM subscriptions))
            GROUP BY g.genre_key`,
        )
        .bind(one)
        .all<{ k: string; name: string; sets: number }>()
    ).results;
    vids = (
      await db
        .prepare(
          `WITH e AS (${ELIGIBLE_SQL} AND (?1 IS NULL OR g.genre_key = ?1) GROUP BY g.genre_key, t.video_id)
           SELECT e.k AS k, COUNT(*) AS videos,
                  SUM(CASE WHEN i.state IS NULL OR NOT ${SETTLED_SQL} THEN 1 ELSE 0 END) AS pending
             FROM e LEFT JOIN genre_playlist_items i ON i.genre_key = e.k AND i.video_id = e.v
            GROUP BY e.k`,
        )
        .bind(one)
        .all<{ k: string; videos: number; pending: number }>()
    ).results;
    items = (
      await db
        .prepare(
          `SELECT genre_key AS k, state, COUNT(*) AS n FROM genre_playlist_items
            WHERE (?1 IS NULL OR genre_key = ?1) GROUP BY genre_key, state`,
        )
        .bind(one)
        .all<{ k: string; state: string; n: number }>()
    ).results;
    rows = (
      await db
        .prepare(
          "SELECT genre_key, genre_name, enabled, playlist_id, last_run_at FROM genre_playlists WHERE (?1 IS NULL OR genre_key = ?1)",
        )
        .bind(one)
        .all<PlaylistRow>()
    ).results;
  } catch {
    return [];
  }
  const connected = opts.connected ?? true;
  const last = await loadLastRun(env);
  const g = settings.genres;
  const keys = new Set([...sets.map((s) => s.k), ...rows.map((r) => r.genre_key)]);
  const out: GenreRow[] = [];
  for (const key of keys) {
    const s = sets.find((x) => x.k === key);
    const v = vids.find((x) => x.k === key);
    const r = rows.find((x) => x.genre_key === key);
    const count = (state: string) =>
      Number(items.find((x) => x.k === key && x.state === state)?.n ?? 0);
    const videos = Number(v?.videos ?? 0);
    const pending = Number(v?.pending ?? 0);
    const choice = r?.enabled === null || r?.enabled === undefined ? null : Number(r.enabled) === 1;
    const enabled = choice ?? (g.auto && videos >= g.minSets);
    const playlistId = r?.playlist_id ?? null;
    let status: GenreStatus;
    let statusText: string;
    if (!enabled) {
      status = choice === false ? "off" : "below_min";
      statusText =
        choice === false
          ? "switched off"
          : g.auto
            ? `gets a playlist at ${g.minSets} sets with a video (${videos} now)`
            : "automatic playlists are off: switch it on to create one";
    } else if (!connected) {
      status = "not_connected";
      statusText = "connect a YouTube account on Playlists";
    } else if (pending > 0 && last && last.stoppedBy === "held" && last.held) {
      status = "held";
      statusText = `${pending} to add, ${REFUSAL_TEXT[last.held]}`;
    } else if (pending > 0 && last && last.stoppedBy === "quota") {
      status = "held";
      statusText = `${pending} to add, waiting for the quota reset (midnight Pacific)`;
    } else if (!playlistId) {
      status = "not_created";
      statusText =
        pending > 0
          ? `${pending} to add; the playlist is created on the next run`
          : "nothing to add yet";
    } else if (pending > 0) {
      status = "pending";
      statusText = `${pending} to add, a few every scheduler tick`;
    } else {
      status = "synced";
      statusText = "up to date";
    }
    out.push({
      key,
      name: s?.name ?? r?.genre_name ?? key,
      sets: Number(s?.sets ?? 0),
      videos,
      pending,
      inPlaylist: count("in"),
      failed: count("failed"),
      unavailable: count("unavailable"),
      removed: count("removed"),
      choice,
      enabled,
      playlistId,
      playlistUrl: playlistId ? playlistUrlOf(playlistId) : null,
      musicUrl: playlistId ? musicUrlOf(playlistId) : null,
      lastRunAt: r?.last_run_at ?? null,
      status,
      statusText,
    });
  }
  return out.sort((a, b) => b.videos - a.videos || a.name.localeCompare(b.name));
}

export type GenreSetRow = {
  setUrl: string;
  title: string | null;
  setDate: string | null;
  djs: string;
  videoId: string | null;
  /** in / pending / failed / unavailable / removed, or `not_in_dj_playlist` (no video in a DJ playlist yet). */
  state: string;
  attempts: number;
  error: string | null;
};

/** The followed sets of one genre, newest first, with what happened to each video in its playlist. */
export async function genreSets(env: Env, key: string): Promise<GenreSetRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT t.url AS set_url, MAX(f.set_title) AS title, MAX(COALESCE(s.set_date, f.set_date)) AS sdate,
            GROUP_CONCAT(DISTINCT COALESCE(y.artist_name, t.slug)) AS djs, MAX(t.video_id) AS video_id,
            MAX(CASE WHEN EXISTS (SELECT 1 FROM playlist_confirmed c JOIN sub_sync y2 ON y2.playlist_id = c.playlist_id
                                   WHERE c.video_id = t.video_id AND c.state = 'in') THEN 1 ELSE 0 END) AS eligible
       FROM set_genres g JOIN tracklists t ON t.url = g.set_url
       LEFT JOIN set_schedule s ON s.url = t.url
       LEFT JOIN set_media_facts f ON f.set_url = t.url
       LEFT JOIN sub_sync y ON y.slug = t.slug
      WHERE g.genre_key = ? AND t.abandoned = 0 AND t.slug IN (SELECT slug FROM subscriptions)
      GROUP BY t.url
      ORDER BY sdate IS NULL, sdate DESC, t.url
      LIMIT 2000`,
  )
    .bind(key)
    .all<{
      set_url: string;
      title: string | null;
      sdate: string | null;
      djs: string | null;
      video_id: string | null;
      eligible: number;
    }>();
  const items = new Map(
    (
      await env.DB.prepare(
        "SELECT video_id, state, attempts, error FROM genre_playlist_items WHERE genre_key = ?",
      )
        .bind(key)
        .all<{ video_id: string; state: string; attempts: number; error: string | null }>()
    ).results.map((r) => [r.video_id, r]),
  );
  return results.map((r) => {
    const it = r.video_id ? items.get(r.video_id) : undefined;
    const state = !r.video_id
      ? "no_video"
      : it
        ? it.state === "failed" && it.attempts < MAX_ATTEMPTS
          ? "pending"
          : it.state
        : Number(r.eligible) === 1
          ? "pending"
          : "not_in_dj_playlist";
    return {
      setUrl: r.set_url,
      title: r.title,
      setDate: r.sdate,
      djs: r.djs ?? "",
      videoId: r.video_id,
      state,
      attempts: Number(it?.attempts ?? 0),
      error: it?.error ?? null,
    };
  });
}

/** The owner's choice for a genre: true on, false off, null back to automatic. */
export async function setGenreChoice(
  env: Env,
  key: string,
  name: string,
  enabled: boolean | null,
  nowSec = nowSeconds(),
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO genre_playlists (genre_key, genre_name, enabled, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(genre_key) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
  )
    .bind(key, name, enabled === null ? null : enabled ? 1 : 0, nowSec)
    .run();
}

/** Read the genre's playlist from YouTube again on its next run (the owner edited it by hand). */
export async function refreshGenrePlaylist(env: Env, key: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT playlist_id FROM genre_playlists WHERE genre_key = ?")
    .bind(key)
    .first<{ playlist_id: string | null }>();
  if (!row?.playlist_id) return false;
  await invalidatePlaylistVideoIds(env, row.playlist_id);
  return true;
}

/** The genre playlists that exist, for the set-date ordering pass. Never throws. */
export async function genrePlaylistsForOrdering(
  env: Env,
): Promise<Array<{ playlistId: string; key: string; name: string }>> {
  try {
    const { results } = await env.DB.prepare(
      "SELECT genre_key, genre_name, playlist_id FROM genre_playlists WHERE playlist_id IS NOT NULL ORDER BY genre_key",
    ).all<{ genre_key: string; genre_name: string; playlist_id: string }>();
    return results.map((r) => ({
      playlistId: r.playlist_id,
      key: r.genre_key,
      name: r.genre_name,
    }));
  } catch {
    return [];
  }
}

export type GenreRunResult =
  | {
      ok: true;
      inserted: number;
      failed: number;
      created: number;
      genres: number;
      pending: number;
      stoppedBy: GenreStop;
    }
  | { ok: false; reason: "youtube_not_connected" | "off" | "unknown_genre" | "busy" }
  | { ok: false; reason: "quota_held"; held: GateRefusal };

async function upsertItem(
  env: Env,
  key: string,
  videoId: string,
  setUrl: string | null,
  state: string,
  error: string | null,
  nowSec: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO genre_playlist_items (genre_key, video_id, set_url, state, attempts, error, at)
     VALUES (?1, ?2, ?3, ?4, CASE WHEN ?4 = 'failed' THEN 1 ELSE 0 END, ?5, ?6)
     ON CONFLICT(genre_key, video_id) DO UPDATE SET state = excluded.state, set_url = COALESCE(excluded.set_url, set_url),
       attempts = CASE WHEN excluded.state = 'failed' THEN attempts + 1 ELSE attempts END,
       error = excluded.error, at = excluded.at`,
  )
    .bind(key, videoId, setUrl, state, error, nowSec)
    .run();
}

/**
 * Fill the genre playlists: create the ones that should exist, insert what
 * each is missing, within one gate answer, the per-run cap and the deadline.
 * `only` = one genre (the page's Backfill now). Idempotent: progress is in
 * the playlists and in `genre_playlist_items`. Never throws for a YouTube
 * error; a D1 error propagates (the cron catches it).
 */
export async function runGenrePlaylists(env: Env, opts: RunOpts): Promise<GenreRunResult> {
  // One run at a time: two overlapping cron ticks (or a tick and Backfill now)
  // would each create the same missing playlist. Get-then-put like the order
  // pass's lock (KV has no compare-and-set); the window is a few milliseconds.
  const held = await env.CACHE.get(LOCK_KEY);
  if (held) {
    opts.log.info("genres.busy", { trigger: opts.trigger ?? null });
    return { ok: false, reason: "busy" };
  }
  const token = crypto.randomUUID();
  await env.CACHE.put(LOCK_KEY, token, { expirationTtl: LOCK_TTL });
  try {
    return await runLocked(env, opts);
  } finally {
    try {
      if ((await env.CACHE.get(LOCK_KEY)) === token) await env.CACHE.delete(LOCK_KEY);
    } catch {
      // It expires by itself.
    }
  }
}

type RunOpts = {
  log: Logger;
  trigger?: string;
  only?: string;
  maxInserts?: number;
  deadlineMs?: number;
};

async function runLocked(env: Env, opts: RunOpts): Promise<GenreRunResult> {
  const log = opts.log;
  const settings = await getAppSettings(env);
  const nowSec = nowSeconds();
  const manual = opts.trigger?.startsWith("manual.") ?? false;
  const all = await genreOverview(env, { key: opts.only, settings });
  if (opts.only && all.length === 0) return { ok: false, reason: "unknown_genre" };
  if (opts.only && !all[0]!.enabled) return { ok: false, reason: "off" };
  const targets = all
    .filter((g) => g.enabled && g.pending > 0)
    .sort(
      (a, b) =>
        a.inPlaylist / Math.max(1, a.videos) - b.inPlaylist / Math.max(1, b.videos) ||
        b.videos - a.videos,
    );
  const perRun = opts.maxInserts ?? settings.genres.maxInsertsPerRun;
  const pendingTotal = targets.reduce((n, g) => n + g.pending, 0);
  if (targets.length === 0 || perRun <= 0) {
    return {
      ok: true,
      inserted: 0,
      failed: 0,
      created: 0,
      genres: 0,
      pending: 0,
      stoppedBy: "nothing",
    };
  }
  const tokenInfo = await getAccessToken(env);
  if (!tokenInfo) {
    await saveLastRun(env, {
      at: nowSec,
      trigger: opts.trigger ?? null,
      inserted: 0,
      failed: 0,
      stoppedBy: "not_connected",
    });
    return { ok: false, reason: "youtube_not_connected" };
  }
  const token = tokenInfo.accessToken;
  const consumer = manual ? OWNER : "genre_playlists";
  // The whole run's plan, as the combined playlist asks: never less than one insert's worth.
  const units = Math.max(1, Math.min(perRun, pendingTotal)) * 50;
  const gate = await quotaGate(env, consumer, units);
  if (!gate.ok) {
    log.info("genres.quota_gate_held", { consumer, reason: gate.reason, units });
    await saveLastRun(env, {
      at: nowSec,
      trigger: opts.trigger ?? null,
      inserted: 0,
      failed: 0,
      stoppedBy: gate.reason === "pool_out" ? "quota" : "held",
      held: gate.reason,
    });
    return { ok: false, reason: "quota_held", held: gate.reason };
  }
  const deadline = Date.now() + (opts.deadlineMs ?? RUN_DEADLINE_MS);
  const cache: OrderKeyCache = {};
  let attempts = 0;
  let inserted = 0;
  let failed = 0;
  let created = 0;
  let touched = 0;
  let stoppedBy: GenreStop = null;
  outer: for (const g of targets) {
    if (attempts >= perRun) {
      stoppedBy = "run";
      break;
    }
    if (Date.now() >= deadline) {
      stoppedBy = "deadline";
      break;
    }
    touched++;
    // The playlist: the stored id, else found by title, else created.
    let playlistId = g.playlistId;
    let existing: Set<string>;
    try {
      let justCreated = false;
      if (!playlistId) {
        const r = await findOrCreatePlaylist(
          {
            title: genrePlaylistTitle(g.name),
            description: genrePlaylistDescription(g.name),
            logCtx: { genre: g.key },
          },
          token,
          log,
        );
        if (!r) continue;
        playlistId = r.id;
        justCreated = r.justCreated;
        if (r.justCreated) created++;
        await env.DB.prepare(
          `INSERT INTO genre_playlists (genre_key, genre_name, enabled, playlist_id, created_at, updated_at)
           VALUES (?1, ?2, NULL, ?3, ?4, ?4)
           ON CONFLICT(genre_key) DO UPDATE SET playlist_id = excluded.playlist_id, genre_name = excluded.genre_name,
             created_at = excluded.created_at, updated_at = excluded.updated_at`,
        )
          .bind(g.key, g.name, playlistId, nowSec)
          .run();
      }
      if (justCreated) {
        existing = new Set();
        await cachePlaylistVideoIds(env, playlistId, existing);
      } else existing = await getCachedPlaylistVideoIds(env, playlistId, token, log);
    } catch (e) {
      if (e instanceof PlaylistNotFoundError && playlistId) {
        // Deleted on YouTube: forget it; the next run finds or creates it again.
        log.warn("genres.playlist_gone", { genre: g.key, playlistId });
        await env.DB.prepare(
          "UPDATE genre_playlists SET playlist_id = NULL, updated_at = ? WHERE genre_key = ?",
        )
          .bind(nowSec, g.key)
          .run();
        await env.DB.prepare(
          "DELETE FROM genre_playlist_items WHERE genre_key = ? AND state = 'in'",
        )
          .bind(g.key)
          .run();
        continue;
      }
      if (isQuotaError(e)) {
        await noteQuotaOut(env, e, log);
        stoppedBy = quotaStopOf(e);
        break;
      }
      log.warn("genres.open_failed", { genre: g.key, ...errorFields(e) });
      continue;
    }
    // In the playlist before and gone now: the owner took it out.
    const { results: ins } = await env.DB.prepare(
      "SELECT video_id FROM genre_playlist_items WHERE genre_key = ? AND state = 'in' AND at < ?",
    )
      .bind(g.key, nowSec - REMOVAL_GRACE_SECONDS)
      .all<{ video_id: string }>();
    for (const r of ins)
      if (!existing.has(r.video_id)) {
        await upsertItem(
          env,
          g.key,
          r.video_id,
          null,
          "removed",
          "removed from the playlist on YouTube",
          nowSec,
        );
        log.info("genres.owner_removed", { genre: g.key, videoId: r.video_id });
      }
    const { results: cands } = await env.DB.prepare(
      `WITH e AS (${ELIGIBLE_SQL} AND g.genre_key = ?1 GROUP BY g.genre_key, t.video_id)
       SELECT e.v AS video_id, e.set_url AS set_url FROM e
         LEFT JOIN genre_playlist_items i ON i.genre_key = e.k AND i.video_id = e.v
        WHERE i.state IS NULL OR NOT ${SETTLED_SQL}
        ORDER BY e.set_date DESC, e.v`,
    )
      .bind(g.key)
      .all<{ video_id: string; set_url: string }>();
    let changed = false;
    for (const c of cands) {
      if (existing.has(c.video_id)) {
        await upsertItem(env, g.key, c.video_id, c.set_url, "in", null, nowSec);
        continue;
      }
      if (attempts >= perRun) {
        stoppedBy = "run";
        break outer;
      }
      if (Date.now() >= deadline) {
        stoppedBy = "deadline";
        break outer;
      }
      try {
        const r = await insertInOrder(env, {
          playlistId,
          videoId: c.video_id,
          existing,
          accessToken: token,
          log,
          setUrl: c.set_url,
          cache,
        });
        // Another run is inserting it right now: left to that run (if it fails, a later run tries).
        if (r.skipped === "claimed") continue;
        attempts += r.attempts;
        existing.add(c.video_id);
        changed = true;
        if (!r.skipped) inserted++;
        await upsertItem(env, g.key, c.video_id, c.set_url, "in", null, nowSec);
      } catch (e) {
        attempts++;
        failed++;
        if (e instanceof PlaylistNotFoundError) {
          await env.DB.prepare(
            "UPDATE genre_playlists SET playlist_id = NULL, updated_at = ? WHERE genre_key = ?",
          )
            .bind(nowSec, g.key)
            .run();
          break;
        }
        if (isQuotaError(e)) {
          await noteQuotaOut(env, e, log);
          stoppedBy = quotaStopOf(e);
          if (changed) await cachePlaylistVideoIds(env, playlistId, existing);
          break outer;
        }
        const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
        await upsertItem(
          env,
          g.key,
          c.video_id,
          c.set_url,
          isPermanentInsertError(e) ? "unavailable" : "failed",
          msg,
          nowSec,
        );
        log.warn("genres.insert_failed", { genre: g.key, videoId: c.video_id, ...errorFields(e) });
      }
    }
    if (changed) await cachePlaylistVideoIds(env, playlistId, existing);
    await env.DB.prepare(
      "UPDATE genre_playlists SET last_run_at = ?, updated_at = ? WHERE genre_key = ?",
    )
      .bind(nowSec, nowSec, g.key)
      .run();
  }
  const result = {
    ok: true as const,
    inserted,
    failed,
    created,
    genres: touched,
    pending: Math.max(0, pendingTotal - inserted),
    stoppedBy,
  };
  await saveLastRun(env, {
    at: nowSec,
    trigger: opts.trigger ?? null,
    inserted,
    failed,
    stoppedBy,
  });
  log.info("genres.run_done", { trigger: opts.trigger ?? null, ...result });
  return result;
}

/** The cron step: skipped while the whole pool is out. Never throws. */
export async function genrePlaylistsCronStep(
  env: Env,
  log: Logger,
  trigger: string,
): Promise<GenreRunResult | { ok: false; reason: "youtube_quota_out" | "threw" }> {
  try {
    if (await getQuotaOut(env)) return { ok: false, reason: "youtube_quota_out" };
    return await runGenrePlaylists(env, { log, trigger });
  } catch (e) {
    log.error("genres.run_threw", errorFields(e));
    return { ok: false, reason: "threw" };
  }
}
