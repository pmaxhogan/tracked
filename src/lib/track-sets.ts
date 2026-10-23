/**
 * Track-page set lists: every set a track's 1001tracklists page says the
 * track was played in, for the tracks of the followed DJs' sets. The
 * Recommended sets page ranks the sets of other DJs by how many of those
 * tracks they play.
 *
 * A track page (`/track/<page id>/<slug>/index.html`) lists the 15 newest
 * sets in `div#sDivTracklists` (`data-type="track"`, `data-id="<page id>"`)
 * and loads older ones as the visitor scrolls, through the same
 * `/ajax/get_data.php` request as a DJ page (lib/dj-index.ts
 * `fetchScrollChunk`). Each row is
 *
 *   <div class="bItm action oItm" data-id="<set id>" ...>
 *     <div class="bTitle"><a href="/tracklist/<set id>/<slug>.html#tr_<page id>">DJ - Title</a></div>
 *     <div class="mediaRow iRow">
 *       <div class="badge views" title="tracklist views" data-count="28">...28</div>
 *       <div title="tracklist date">...2026-10-16</div>
 *       <div class="tlUser" title="creator">...<a href="/user/<name>/index.html">...</a></div>
 *       <div class="likes" title="likes">...2</div>   ("likes hidden", no number, at 0)
 *       <div title="musicstyle(s)">...Tech House, Techno</div>
 *       <div title="IDed tracks / total tracks">...15/16</div>   ("<span>all</span>/28" when every row is IDed)
 *
 * newest first. Seen live 2026-10-20; the scroll request honours `count`
 * (500 rows came back in one request), so a walk asks for
 * `trackSets.stepCount` rows a step instead of the browser's 10.
 *
 * Three parts:
 *   - `storeTrackSetRows`: D1 `track_sets` (track x set) and
 *     `track_set_lists` (one row per set, with how many tracks list it and
 *     whether it is a followed DJ's set). Any fetch of a track page stores
 *     its first 15 (`recordTrackPageHtml`, the pre-save lookup too).
 *   - `seedTrackSets`: the crawl queue `track_set_crawl` takes the search
 *     index's tracks (the tracks of the followed DJs' verified sets), a few
 *     hundred a tick by id, so new tracks join as the sync indexes them.
 *   - `drainTrackSets`: the 5-minute cron (src/index.ts) walks queued tracks,
 *     for `trackSets.tickSeconds` (or `viewsPerTick` page views) a tick at pool priority
 *     backfill: page 1, then scroll requests from the stored cursor until the
 *     list ends, a set from `stopYear` or earlier shows up (`busyStopYear`
 *     once the walk has seen `busyRows` sets: a track played very often), or
 *     `maxSteps`.
 *     One track is walked to its end before the next starts (its scroll
 *     requests go out from the page tlpool's browser is on). A finished
 *     track is walked again after `recrawlDays`, down to the first set it
 *     already has. A pool refusal ends the tick and charges the row nothing.
 */

import type { Env } from "../types";
import { getAppSettings, type AppSettings } from "./app-settings";
import { isPaused } from "./ban-state";
import { BATCH_CHUNK } from "./db";
import { fetchScrollChunk, oItmIds, parseScrollKeys, type ScrollKeys } from "./dj-index";
import { IPBlockedError } from "./fetch";
import { budgetHoldKey, TICK_BACKOFF_KEY } from "./fetch-scheduler";
import { decodeEntities } from "./html-entities";
import { errorFields, type Logger } from "./log";
import { poolCodeOf, poolConfigFromEnv } from "./pool";
import { getPoolSettings } from "./pool-settings";
import { createPoolAdminClient } from "./pool-admin-client";
import type { TableDef } from "./table-query";
import {
  fetch1001,
  UpstreamPausedError,
  UpstreamUnavailableError,
  type Fetch1001Opts,
} from "./upstream1001";

const ORIGIN = "https://www.1001tracklists.com";

/** A failed step (not a refusal) waits this x attempts. */
export const FAIL_BACKOFF_SECONDS = 6 * 3600;
/** Failed steps in a row before a walk is given up until the next recrawl. */
export const MAX_ATTEMPTS = 3;
/** A drain holds a row this long while it walks it (an overlapping cron leaves it alone). */
const CLAIM_SECONDS = 15 * 60;
/** Longest a step waits for a free browser: nobody is waiting on it. */
const POOL_WAIT_SECONDS = 60;
/** Search-index tracks queued per tick. */
const SEED_BATCH = 500;
/** CACHE KV: the last search_tracks id queued. */
export const SEED_CURSOR_KEY = "track_sets:seed_after";
/** CACHE KV: the UTC day the followed flags were last refreshed. */
const FOLLOWED_REFRESH_KEY = "track_sets:followed_day";
/** Page 1 shows 15 sets; fewer than this means the list has no more. */
const PAGE1_FULL = 10;
/** CACHE KV: the crawl's own requests per UTC hour, `{ "<hour>": { p, x } }`, the last 24 kept. */
export const USAGE_KEY = "track_sets:usage";
/** CACHE KV: the pool's backfill allowance (pages / XHRs a day), read at most every ALLOWANCE_TTL. */
export const ALLOWANCE_KEY = "track_sets:allowance";
const ALLOWANCE_TTL = 600;
/** CACHE KV: unix s until which the crawl waits after the pool refused it for budget (its own: other backfill jobs go on). */
export const HOLD_KEY = "track_sets:hold_until";
const DAY = 86400;

const nowSeconds = () => Math.floor(Date.now() / 1000);

// --- parsing -----------------------------------------------------------------

export type TrackSetRow = {
  /** The tracklist id (`/tracklist/<id>/`). */
  setId: string;
  /** `https://www.1001tracklists.com/tracklist/<id>/<slug>.html` */
  url: string;
  title: string;
  /** `YYYY-MM-DD`, or null when the row shows none. */
  date: string | null;
  /** The 1001tracklists user who made the list. */
  creator: string | null;
  /** The list's view count (the views badge's data-count), null when the row has none. */
  views: number | null;
  /** Its likes (0 when the likes badge is hidden), null when the row has no likes badge. */
  likes: number | null;
  /** Its music styles as the row writes them ("Tech House, Techno"), null when it shows none. */
  genres: string | null;
  /** Rows in the list (the "IDed / total" badge's total), null when the row shows none. */
  totalTracks: number | null;
};

const OITM_TAG_RE = /<div\b[^>]*\bclass="[^"]*\boItm\b[^"]*"[^>]*>/g;

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The set rows of a track page (only its `#sDivTracklists` list) or of a
 * scroll chunk (`data` of a get_data.php answer), in page order. A row
 * without a `/tracklist/` link is skipped.
 */
export function parseTrackSetRows(html: string): TrackSetRow[] {
  let body = html;
  const at = html.search(/<div\b[^>]*\bid="sDivTracklists"/);
  if (at >= 0) {
    const open = html.indexOf(">", at) + 1;
    const next = html.slice(open).search(/<div\b[^>]*\bclass="[^"]*\bsDiv\b/);
    body = next >= 0 ? html.slice(open, open + next) : html.slice(open);
  }
  const starts = [...body.matchAll(OITM_TAG_RE)].map((m) => m.index!);
  const rows: TrackSetRow[] = [];
  const seen = new Set<string>();
  starts.forEach((start, i) => {
    const block = body.slice(start, starts[i + 1] ?? body.length);
    const href = block.match(/href="(\/tracklist\/([a-z0-9]+)\/[^"#?]*)/i);
    if (!href) return;
    const setId = href[2]!;
    if (seen.has(setId)) return;
    seen.add(setId);
    const titleHtml =
      block.match(/class="bTitle"[^>]*>\s*<a\b[^>]*>([\s\S]*?)<\/a>/)?.[1] ??
      block.match(/<a\b[^>]*href="\/tracklist\/[^"]*"[^>]*>([\s\S]*?)<\/a>/)?.[1] ??
      "";
    const dateHtml = block.match(/title="tracklist date"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";
    const creator = block.match(/href="\/user\/([^/"?#]+)\//)?.[1] ?? null;
    const viewsAttr = block.match(/class="[^"]*\bviews\b[^"]*"[^>]*\bdata-count="(\d+)"/)?.[1];
    const likesTag = block.match(/<div\b([^>]*\btitle="likes"[^>]*)>([\s\S]*?)<\/div>/);
    const likesNum = likesTag ? stripTags(likesTag[2]!).match(/\d+/)?.[0] : undefined;
    const total = stripTags(
      block.match(/title="IDed tracks \/ total tracks"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "",
    ).match(/\/\s*(\d+)/)?.[1];
    const genres = stripTags(
      block.match(/title="musicstyle\(s\)"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "",
    );
    rows.push({
      setId,
      url: ORIGIN + href[1]!,
      title: stripTags(titleHtml) || setId,
      date: stripTags(dateHtml).match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1] ?? null,
      creator: creator ? decodeURIComponent(creator) : null,
      views: viewsAttr !== undefined ? Number(viewsAttr) : null,
      likes: likesTag ? (likesNum !== undefined ? Number(likesNum) : 0) : null,
      genres: genres || null,
      totalTracks: total !== undefined ? Number(total) : null,
    });
  });
  return rows;
}

/** The page id of a `/track/<id>/...` URL, or null. */
export function trackPageIdOf(url: string | null | undefined): string | null {
  return (url ?? "").match(/\/track\/([a-z0-9]+)\//i)?.[1] ?? null;
}

/**
 * The DJ names a set title starts with: the part before " @ " or " - ",
 * whole and split on "&", ",", "b2b" and "vs" ("Meduza & Greggio - Aeterna
 * Radio 018" -> meduza & greggio, meduza, greggio). Lowercased.
 */
/** The DJ part of a set title: before " @ " or " - " ("Meduza & Greggio - Aeterna Radio 018" -> "Meduza & Greggio"). */
export function titleDjPart(title: string): string {
  return title.split(/\s+[@\u2013-]\s+/)[0]!.trim();
}

export function titleDjNames(title: string): string[] {
  const head = titleDjPart(title).toLowerCase();
  if (!head) return [];
  const parts = head
    .split(/\s*(?:&|,|\bb2b\b|\bvs\.?(?=\s))\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);
  return [...new Set([head, ...parts])];
}

// --- storage -----------------------------------------------------------------

/** The followed DJs' names (sub_sync.artist_name), lowercased. */
export async function followedDjNames(env: Env): Promise<Set<string>> {
  const { results } = await env.DB.prepare(
    `SELECT y.artist_name AS name FROM subscriptions s JOIN sub_sync y ON y.slug = s.slug
      WHERE y.artist_name IS NOT NULL AND y.artist_name <> ''`,
  ).all<{ name: string }>();
  return new Set(results.map((r) => r.name.trim().toLowerCase()).filter(Boolean));
}

// A tracklists row by set id; the expression matches the index in migration 0028.
const FOLLOWED_BY_ID_SQL =
  "EXISTS (SELECT 1 FROM tracklists t WHERE substr(t.url, 42, instr(substr(t.url, 42), '/') - 1) = ?1)";

/**
 * Store the rows one track page (or scroll step) listed. Returns how many
 * were new for the track and how many it already had. One D1 batch per
 * BATCH_CHUNK statements.
 */
export async function storeTrackSetRows(
  env: Env,
  trackPageId: string,
  rows: readonly TrackSetRow[],
  followed: ReadonlySet<string>,
  nowSec = nowSeconds(),
): Promise<{ added: number; known: number }> {
  if (rows.length === 0) return { added: 0, known: 0 };
  const db = env.DB;
  const ins = db.prepare(
    "INSERT OR IGNORE INTO track_sets (track_page_id, set_id, seen_at) VALUES (?, ?, ?)",
  );
  let added = 0;
  for (let i = 0; i < rows.length; i += BATCH_CHUNK) {
    const res = await db.batch(
      rows.slice(i, i + BATCH_CHUNK).map((r) => ins.bind(trackPageId, r.setId, nowSec)),
    );
    for (const r of res) added += Number(r.meta?.changes ?? 0);
  }
  const up = db.prepare(
    `INSERT INTO track_set_lists (set_id, set_url, title, set_date, creator, track_count, followed, first_seen_at, updated_at, views, likes, genres, total_tracks, djs)
     VALUES (?1, ?2, ?3, ?4, ?5, (SELECT COUNT(*) FROM track_sets WHERE set_id = ?1),
             CASE WHEN ?6 = 1 OR ${FOLLOWED_BY_ID_SQL} THEN 1 ELSE 0 END, ?7, ?7, ?8, ?9, ?10, ?11, ?12)
     ON CONFLICT(set_id) DO UPDATE SET
       set_url = excluded.set_url, title = excluded.title,
       set_date = COALESCE(excluded.set_date, set_date), creator = COALESCE(excluded.creator, creator),
       track_count = excluded.track_count, followed = excluded.followed, updated_at = excluded.updated_at,
       views = COALESCE(excluded.views, views), likes = COALESCE(excluded.likes, likes),
       genres = COALESCE(excluded.genres, genres), total_tracks = COALESCE(excluded.total_tracks, total_tracks),
       djs = excluded.djs`,
  );
  for (let i = 0; i < rows.length; i += BATCH_CHUNK)
    await db.batch(
      rows
        .slice(i, i + BATCH_CHUNK)
        .map((r) =>
          up.bind(
            r.setId,
            r.url,
            r.title,
            r.date,
            r.creator,
            titleDjNames(r.title).some((n) => followed.has(n)) ? 1 : 0,
            nowSec,
            r.views,
            r.likes,
            r.genres,
            r.totalTracks,
            titleDjPart(r.title) || null,
          ),
        ),
    );
  return { added, known: rows.length - added };
}

/**
 * A fetched track page's first sets, stored (the pre-save track-URL lookup
 * calls this: the page is paid for already). Never throws.
 */
export async function recordTrackPageHtml(
  env: Env,
  trackUrl: string,
  html: string,
  log?: Logger,
): Promise<number> {
  try {
    if (!env.DB) return 0;
    const id = trackPageIdOf(trackUrl);
    if (!id) return 0;
    const rows = parseTrackSetRows(html);
    if (rows.length === 0) return 0;
    const r = await storeTrackSetRows(env, id, rows, await followedDjNames(env));
    log?.info("track_sets.page_recorded", { trackUrl, rows: rows.length, added: r.added });
    return rows.length;
  } catch (e) {
    log?.warn("track_sets.record_failed", { trackUrl, ...errorFields(e) });
    return 0;
  }
}

// --- queue -------------------------------------------------------------------

/**
 * Queue the search index's tracks not queued yet (by search_tracks id, from
 * the stored cursor): the tracks of the followed DJs' verified sets. Returns
 * how many rows it read. Never throws.
 */
export async function seedTrackSets(env: Env, log: Logger, nowSec = nowSeconds()): Promise<number> {
  try {
    if (!env.SEARCH_DB || !env.DB) return 0;
    const after = Number(await env.CACHE.get(SEED_CURSOR_KEY)) || 0;
    const { results } = await env.SEARCH_DB.prepare(
      `SELECT id, page_id, track_url, sets_count FROM search_tracks
        WHERE id > ? AND page_id IS NOT NULL AND page_id <> '' AND track_url IS NOT NULL AND sets_count > 0
        ORDER BY id LIMIT ?`,
    )
      .bind(after, SEED_BATCH)
      .all<{ id: number; page_id: string; track_url: string; sets_count: number }>();
    if (results.length === 0) return 0;
    const stmt = env.DB.prepare(
      `INSERT INTO track_set_crawl (track_page_id, track_url, weight, queued_at, next_at) VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(track_page_id) DO UPDATE SET weight = MAX(weight, excluded.weight)`,
    );
    for (let i = 0; i < results.length; i += BATCH_CHUNK)
      await env.DB.batch(
        results
          .slice(i, i + BATCH_CHUNK)
          .map((r) => stmt.bind(r.page_id, r.track_url, Number(r.sets_count) || 0, nowSec)),
      );
    await env.CACHE.put(SEED_CURSOR_KEY, String(results[results.length - 1]!.id));
    log.info("track_sets.seeded", { tracks: results.length, after });
    return results.length;
  } catch (e) {
    log.warn("track_sets.seed_failed", errorFields(e));
    return 0;
  }
}

/** Once a UTC day: sets that became a followed DJ's (a new subscription's index) leave the page. */
async function refreshFollowed(env: Env, log: Logger, nowSec: number): Promise<void> {
  const day = new Date(nowSec * 1000).toISOString().slice(0, 10);
  if ((await env.CACHE.get(FOLLOWED_REFRESH_KEY)) === day) return;
  const r = await env.DB.prepare(
    `UPDATE track_set_lists SET followed = 1
      WHERE followed = 0 AND ${FOLLOWED_BY_ID_SQL.replace("?1", "track_set_lists.set_id")}`,
  ).run();
  await env.CACHE.put(FOLLOWED_REFRESH_KEY, day, { expirationTtl: 2 * DAY });
  if (r.meta.changes) log.info("track_sets.followed_refreshed", { changed: r.meta.changes });
}

type CrawlRow = {
  track_page_id: string;
  track_url: string;
  next_at: number;
  cursor_pos: number | null;
  cursor_id: string | null;
  steps: number;
  walks: number;
  oldest_date: string | null;
  attempts: number;
};

const CRAWL_COLS =
  "track_page_id, track_url, next_at, cursor_pos, cursor_id, steps, walks, oldest_date, attempts";

/** The next track to walk: an unfinished walk, then never-walked tracks (most-played first), then recrawls. */
async function pickDue(db: D1Database, nowSec: number): Promise<CrawlRow | null> {
  return (
    (await db
      .prepare(
        `SELECT ${CRAWL_COLS} FROM track_set_crawl WHERE cursor_id IS NOT NULL AND next_at <= ? ORDER BY next_at LIMIT 1`,
      )
      .bind(nowSec)
      .first<CrawlRow>()) ??
    (await db
      .prepare(
        `SELECT ${CRAWL_COLS} FROM track_set_crawl WHERE walks = 0 AND next_at <= ? ORDER BY weight DESC, queued_at LIMIT 1`,
      )
      .bind(nowSec)
      .first<CrawlRow>()) ??
    (await db
      .prepare(
        `SELECT ${CRAWL_COLS} FROM track_set_crawl WHERE walks > 0 AND next_at <= ? ORDER BY next_at LIMIT 1`,
      )
      .bind(nowSec)
      .first<CrawlRow>())
  );
}

// --- drain -------------------------------------------------------------------

export type TrackSetsStop = "end" | "year" | "known" | "max_steps" | "no_list" | "failed";

export type TrackSetsDrain = {
  skipped?:
    | "off"
    | "no_db"
    | "pool_not_configured"
    | "paused"
    | "backoff"
    | "budget_hold"
    | "share_spent"
    | "nothing_due";
  /** Search-index tracks offered to the queue this tick. */
  seeded: number;
  /** Page views spent (page 1s and scroll requests). */
  views: number;
  /** Tracks whose walk ended this tick. */
  finished: number;
  /** Sets new to a track. */
  added: number;
  /** Steps that failed (backed off). */
  failed: number;
  /** The pool refusal that ended the drain. */
  stoppedBy?: string;
  /** The crawl's share: the pool's backfill allowance a day (null: unknown), its own use over 24 h, what was left at the start. */
  share?: {
    allowance: { pages: number; xhr: number } | null;
    used: { p: number; x: number };
    pagesLeft: number;
    xhrLeft: number;
  };
};

type WalkOutcome = {
  views: number;
  added: number;
  failed: number;
  finished?: TrackSetsStop;
  refusal?: { error: string; poolCode: string | null; retryAfterSeconds: number | null };
};

function isRefusal(e: unknown): boolean {
  return (
    e instanceof UpstreamPausedError ||
    e instanceof UpstreamUnavailableError ||
    e instanceof IPBlockedError
  );
}

/** What a tick may still spend: views (the tick's cap), page loads and scroll XHRs (the crawl's share). */
type Quota = { views: number; pages: number; xhr: number };

/**
 * Walk one claimed track: page 1 when it has no cursor, then scroll steps,
 * within `quota` and before `deadlineMs` (wall clock); each step spends from
 * it. Saves where it got to after every step.
 */
async function walkTrack(
  env: Env,
  row: CrawlRow,
  quota: Quota,
  deadlineMs: number,
  s: AppSettings["trackSets"],
  followed: ReadonlySet<string>,
  log: Logger,
  nowSec: number,
): Promise<WalkOutcome> {
  const db = env.DB;
  const out: WalkOutcome = { views: 0, added: 0, failed: 0 };
  const opts: Fetch1001Opts = {
    pool: poolConfigFromEnv(env),
    cacheKv: env.CACHE,
    log,
    kind: "dj",
    priority: "backfill",
    maxWaitSeconds: POOL_WAIT_SECONDS,
  };
  let keys: ScrollKeys = {
    type: "track",
    idScrollObject: row.track_page_id,
    subtype: "tracklists",
  };
  let cursor = row.cursor_id ? { pos: Number(row.cursor_pos) || 0, id: row.cursor_id } : null;
  let steps = Number(row.steps) || 0;
  let oldest = row.oldest_date;
  // A track played in very many sets (the walk has seen busyRows) stops at a later year.
  const stopBefore = (seen: number) =>
    `${(seen >= s.busyRows ? Math.max(s.stopYear, s.busyStopYear) : s.stopYear) + 1}-01-01`;

  const finish = async (reason: TrackSetsStop, error: string | null = null) => {
    await db
      .prepare(
        `UPDATE track_set_crawl SET cursor_pos = NULL, cursor_id = NULL, steps = 0, walks = walks + 1, attempts = 0,
           stop_reason = ?, last_error = ?, oldest_date = ?, crawled_at = ?, next_at = ?,
           sets_seen = (SELECT COUNT(*) FROM track_sets WHERE track_page_id = ?)
         WHERE track_page_id = ?`,
      )
      .bind(
        reason,
        error,
        oldest,
        nowSec,
        nowSec + Math.round(s.recrawlDays * DAY),
        row.track_page_id,
        row.track_page_id,
      )
      .run();
    out.finished = reason;
    log.info("track_sets.walk_done", {
      track: row.track_page_id,
      reason,
      steps,
      oldest,
      recrawl: row.walks > 0,
    });
  };

  for (;;) {
    const need = cursor ? "xhr" : "pages";
    if (quota.views <= 0 || quota[need] <= 0 || Date.now() >= deadlineMs) {
      // Out of views, share or time this tick: due again at once, and picked first next tick.
      await db
        .prepare(
          "UPDATE track_set_crawl SET cursor_pos = ?, cursor_id = ?, steps = ?, oldest_date = ?, next_at = ? WHERE track_page_id = ?",
        )
        .bind(cursor?.pos ?? null, cursor?.id ?? null, steps, oldest, nowSec, row.track_page_id)
        .run();
      return out;
    }
    let rows: TrackSetRow[];
    let end: boolean;
    let rowCount: number;
    let lastId: string | null;
    try {
      if (!cursor) {
        const r = await fetch1001(row.track_url, opts);
        out.views++;
        quota.views--;
        quota.pages--;
        rows = parseTrackSetRows(r.html);
        if (!/\bid="sDivTracklists"/.test(r.html)) {
          await finish("no_list");
          return out;
        }
        keys = parseScrollKeys(r.html) ?? keys;
        // A row's data-id is its set id: the cursor the browser sends is the last row's.
        rowCount = rows.length;
        lastId = rows[rows.length - 1]?.setId ?? null;
        end = rows.length < PAGE1_FULL;
      } else {
        const chunk = await fetchScrollChunk(
          {
            ...keys,
            pos: cursor.pos,
            dataId: cursor.id,
            referer: row.track_url,
            count: s.stepCount,
          },
          opts,
        );
        out.views++;
        quota.views--;
        quota.xhr--;
        steps++;
        if (!chunk.ok) throw new Error("scroll step answered no list");
        rows = parseTrackSetRows(chunk.dataHtml);
        const ids = oItmIds(chunk.dataHtml);
        rowCount = ids.length;
        lastId = ids[ids.length - 1] ?? null;
        end = chunk.end || ids.length === 0;
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      if (isRefusal(e)) {
        // Nothing learnt, nothing charged: the row is due again as it was.
        await db
          .prepare(
            "UPDATE track_set_crawl SET cursor_pos = ?, cursor_id = ?, steps = ?, oldest_date = ?, next_at = ? WHERE track_page_id = ?",
          )
          .bind(
            cursor?.pos ?? null,
            cursor?.id ?? null,
            steps,
            oldest,
            row.next_at,
            row.track_page_id,
          )
          .run();
        const retry = (e as { retryAfterSeconds?: unknown }).retryAfterSeconds;
        out.refusal = {
          error,
          poolCode: poolCodeOf(e),
          retryAfterSeconds: typeof retry === "number" && Number.isFinite(retry) ? retry : null,
        };
        return out;
      }
      out.failed++;
      const attempts = (Number(row.attempts) || 0) + 1;
      log.warn("track_sets.step_failed", { track: row.track_page_id, attempts, error });
      if (attempts >= MAX_ATTEMPTS) {
        await finish("failed", error.slice(0, 300));
        return out;
      }
      await db
        .prepare(
          "UPDATE track_set_crawl SET cursor_pos = ?, cursor_id = ?, steps = ?, oldest_date = ?, attempts = ?, last_error = ?, next_at = ? WHERE track_page_id = ?",
        )
        .bind(
          cursor?.pos ?? null,
          cursor?.id ?? null,
          steps,
          oldest,
          attempts,
          error.slice(0, 300),
          nowSec + FAIL_BACKOFF_SECONDS * attempts,
          row.track_page_id,
        )
        .run();
      return out;
    }
    row.attempts = 0;
    const stored = await storeTrackSetRows(env, row.track_page_id, rows, followed, nowSec);
    out.added += stored.added;
    for (const r of rows) if (r.date && (!oldest || r.date < oldest)) oldest = r.date;
    log.info("track_sets.step", {
      track: row.track_page_id,
      page: cursor ? "scroll" : "page1",
      rows: rows.length,
      added: stored.added,
      oldest,
    });
    const stop: TrackSetsStop | null = end
      ? "end"
      : rows.some((r) => r.date !== null && r.date < stopBefore((cursor?.pos ?? 0) + rowCount))
        ? "year"
        : row.walks > 0 && stored.known > 0
          ? "known"
          : steps >= s.maxSteps || !lastId
            ? "max_steps"
            : null;
    if (stop || !lastId) {
      await finish(stop ?? "max_steps");
      return out;
    }
    const next = { pos: (cursor?.pos ?? 0) + rowCount, id: lastId };
    cursor = next;
    await db
      .prepare(
        "UPDATE track_set_crawl SET cursor_pos = ?, cursor_id = ?, steps = ?, oldest_date = ?, attempts = 0 WHERE track_page_id = ?",
      )
      .bind(next.pos, next.id, steps, oldest, row.track_page_id)
      .run();
  }
}

type Usage = Record<string, { p: number; x: number }>;

/** The crawl's page loads (p) and scroll XHRs (x) over the last 24 hours. */
export async function crawlUsage(env: Env, nowSec: number): Promise<{ p: number; x: number }> {
  const u = ((await env.CACHE.get(USAGE_KEY, "json")) as Usage | null) ?? {};
  const from = Math.floor(nowSec / 3600) - 23;
  let p = 0;
  let x = 0;
  for (const [h, v] of Object.entries(u))
    if (Number(h) >= from) {
      p += Number(v?.p) || 0;
      x += Number(v?.x) || 0;
    }
  return { p, x };
}

async function addUsage(env: Env, nowSec: number, p: number, x: number): Promise<void> {
  if (p <= 0 && x <= 0) return;
  const u = ((await env.CACHE.get(USAGE_KEY, "json")) as Usage | null) ?? {};
  const hour = Math.floor(nowSec / 3600);
  const cur = u[hour] ?? { p: 0, x: 0 };
  u[hour] = { p: cur.p + p, x: cur.x + x };
  for (const h of Object.keys(u)) if (Number(h) < hour - 23) delete u[h];
  await env.CACHE.put(USAGE_KEY, JSON.stringify(u), { expirationTtl: 2 * DAY });
}

/**
 * What pool priority backfill may spend a day across the fleet: each
 * fetching account's page budget (tlpool `budgetToday`, summed) and its XHR
 * budget, times the backfill ceiling (and short of the phone reserve) - the
 * same arithmetic as tlpool's `usable_budget`. Null when the pool cannot say
 * (then only the pool's own refusals limit the crawl).
 */
export async function backfillAllowance(
  env: Env,
  log?: Logger,
): Promise<{ pages: number; xhr: number } | null> {
  const hit = (await env.CACHE.get(ALLOWANCE_KEY, "json")) as { pages: number; xhr: number } | null;
  if (hit) return hit;
  try {
    const client = createPoolAdminClient(env);
    if (!client.configured) return null;
    const [st, ps] = await Promise.all([client.status(), client.getSettings()]);
    if (st.budgetToday === null || ps.xhrBudgetPerDay === null) return null;
    const factor = Math.min(1 - (ps.reservedPhoneShare ?? 0), ps.priorityCeilings?.backfill ?? 1);
    const fetching = st.accounts.filter(
      (a) => !a.passive && (a.state === "active" || a.state === "warming"),
    ).length;
    const a = {
      pages: Math.floor(st.budgetToday * factor),
      xhr: Math.floor(fetching * ps.xhrBudgetPerDay * factor),
    };
    await env.CACHE.put(ALLOWANCE_KEY, JSON.stringify(a), { expirationTtl: ALLOWANCE_TTL });
    return a;
  } catch (e) {
    log?.warn("track_sets.allowance_failed", errorFields(e));
    return null;
  }
}

/**
 * One cron tick's crawl: seed the queue, then walk due tracks for
 * `trackSets.tickSeconds` (wall clock) or `viewsPerTick` page views, whichever
 * ends first, and within `maxShare` of the pool's backfill allowance over the
 * last 24 hours (page loads and scroll XHRs counted apart): the other
 * backfill jobs (link pre-warm, DJ history, index catch-up) keep the rest.
 * A pool refusal for budget holds the crawl alone (HOLD_KEY) until the pool
 * says. Never throws.
 */
export async function drainTrackSets(
  env: Env,
  log: Logger,
  nowSec = nowSeconds(),
): Promise<TrackSetsDrain> {
  const out: TrackSetsDrain = { seeded: 0, views: 0, finished: 0, added: 0, failed: 0 };
  try {
    const settings = (await getAppSettings(env)).trackSets;
    const cap = settings.enabled ? settings.viewsPerTick : 0;
    if (cap <= 0) return { ...out, skipped: "off" };
    if (!env.DB) return { ...out, skipped: "no_db" };
    out.seeded = await seedTrackSets(env, log, nowSec);
    await refreshFollowed(env, log, nowSec).catch((e) =>
      log.warn("track_sets.followed_refresh_failed", errorFields(e)),
    );
    if (!poolConfigFromEnv(env)) return { ...out, skipped: "pool_not_configured" };
    // The scheduler's own holds: the pool asked us to wait, or the backfill share is spent.
    if (await isPaused(env)) return { ...out, skipped: "paused" };
    if ((Number(await env.CACHE.get(TICK_BACKOFF_KEY)) || 0) > nowSec)
      return { ...out, skipped: "backoff" };
    if ((Number(await env.CACHE.get(budgetHoldKey("backfill"))) || 0) > nowSec)
      return { ...out, skipped: "budget_hold" };
    if ((Number(await env.CACHE.get(HOLD_KEY)) || 0) > nowSec)
      return { ...out, skipped: "budget_hold" };
    const allowance = await backfillAllowance(env, log);
    const used = await crawlUsage(env, nowSec);
    const quota: Quota = {
      views: cap,
      pages: allowance ? Math.floor(allowance.pages * settings.maxShare) - used.p : cap,
      xhr: allowance ? Math.floor(allowance.xhr * settings.maxShare) - used.x : cap,
    };
    out.share = { allowance, used, pagesLeft: quota.pages, xhrLeft: quota.xhr };
    if (quota.pages <= 0 && quota.xhr <= 0) return { ...out, skipped: "share_spent" };
    const db = env.DB;
    const followed = await followedDjNames(env);
    const deadlineMs = Date.now() + settings.tickSeconds * 1000;
    const start = { pages: quota.pages, xhr: quota.xhr };
    while (quota.views > 0 && (quota.pages > 0 || quota.xhr > 0) && Date.now() < deadlineMs) {
      const row = await pickDue(db, nowSec);
      if (!row) {
        if (out.views === 0) out.skipped = "nothing_due";
        break;
      }
      // Claim it: a drain from an overlapping cron that read the same row leaves it.
      const claim = await db
        .prepare("UPDATE track_set_crawl SET next_at = ? WHERE track_page_id = ? AND next_at = ?")
        .bind(nowSec + CLAIM_SECONDS, row.track_page_id, row.next_at)
        .run();
      if (!claim.meta.changes) continue;
      const w = await walkTrack(env, row, quota, deadlineMs, settings, followed, log, nowSec);
      out.views += w.views;
      out.added += w.added;
      out.failed += w.failed;
      if (w.finished) out.finished++;
      if (w.refusal) {
        out.stoppedBy = w.refusal.error;
        if (w.refusal.poolCode === "budget_exhausted") {
          // The pool's backfill share (most likely the XHR share, which the crawl spends most) is out: the crawl
          // waits until the pool says, alone - the shared hold would stop the page-based backfill jobs too.
          const pool = await getPoolSettings(env);
          const until =
            nowSec +
            Math.min(
              pool.retry.poolBackoffMaxHours * 3600,
              Math.max(60, Math.ceil(w.refusal.retryAfterSeconds ?? 600)),
            );
          await env.CACHE.put(HOLD_KEY, String(until), {
            expirationTtl: Math.max(60, until - nowSec + 60),
          });
        }
        log.info("track_sets.stopped", { track: row.track_page_id, ...w.refusal });
        break;
      }
      // A failed step ends this track's turn; a walk with views left goes on to the next track.
      if (w.views === 0) break;
    }
    await addUsage(env, nowSec, start.pages - quota.pages, start.xhr - quota.xhr);
    return out;
  } catch (e) {
    log.warn("track_sets.drain_threw", errorFields(e));
    return { ...out, stoppedBy: out.stoppedBy ?? "threw" };
  }
}

// --- reporting ---------------------------------------------------------------

export type TrackSetsSummary = {
  /** Tracks in the crawl queue. */
  queued: number;
  /** Tracks walked at least once. */
  walked: number;
  /** Tracks mid-walk. */
  walking: number;
  /** Sets stored that are not a followed DJ's. */
  sets: number;
  /** Walks that ended in the last 24 hours (the crawl's rate, tracks a day). */
  read24h: number;
  /** Days until every queued track is walked once at the last 24 hours' rate; null when nothing ended in them. */
  etaDays: number | null;
  /** The crawl's page loads over the last 24 hours (one per track: page loads are what pace it). */
  pages24h: number;
  /** Page loads a day the crawl may spend (`maxShare` of the pool's backfill allowance); null when the pool has not said lately. */
  pageShare: number | null;
};

/** The crawl's progress (the Recommended sets page and the Scheduler page), null when D1 cannot say. */
export async function trackSetsSummary(
  env: Env,
  nowSec = nowSeconds(),
): Promise<TrackSetsSummary | null> {
  try {
    if (!env.DB) return null;
    const q = await env.DB.prepare(
      `SELECT COUNT(*) AS queued, COALESCE(SUM(walks > 0), 0) AS walked, COALESCE(SUM(cursor_id IS NOT NULL), 0) AS walking,
              COALESCE(SUM(crawled_at >= ?), 0) AS day
         FROM track_set_crawl`,
    )
      .bind(nowSec - DAY)
      .first<{ queued: number; walked: number; walking: number; day: number }>();
    const l = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM track_set_lists WHERE followed = 0",
    ).first<{ n: number }>();
    const queued = Number(q?.queued ?? 0);
    const walked = Number(q?.walked ?? 0);
    const read24h = Number(q?.day ?? 0);
    const left = Math.max(0, queued - walked);
    // Only the allowance the crawl cached (it refreshes it every tick): a page view never calls the pool.
    const allowance = (await env.CACHE.get(ALLOWANCE_KEY, "json").catch(() => null)) as {
      pages: number;
    } | null;
    const share = (await getAppSettings(env)).trackSets.maxShare;
    return {
      queued,
      walked,
      walking: Number(q?.walking ?? 0),
      sets: Number(l?.n ?? 0),
      read24h,
      etaDays: left === 0 ? 0 : read24h > 0 ? Math.round((left / read24h) * 10) / 10 : null,
      pages24h: await crawlUsage(env, nowSec).then(
        (u) => u.p,
        () => 0,
      ),
      pageShare:
        allowance && Number.isFinite(Number(allowance.pages))
          ? Math.floor(Number(allowance.pages) * share)
          : null,
    };
  } catch {
    return null;
  }
}

type RecommendedRow = {
  set_id: string;
  set_url: string;
  title: string;
  set_date: string | null;
  creator: string | null;
  track_count: number;
  views: number | null;
  likes: number | null;
  genres: string | null;
  total_tracks: number | null;
  share: number | null;
  djs: string | null;
  first_seen_at: number;
};

/** The Recommended sets table: other DJs' sets, by how many crawled tracks list them. */
export const RECOMMENDED_TABLE: TableDef<RecommendedRow> = {
  from: "track_set_lists",
  select:
    "set_id, set_url, title, set_date, creator, track_count, views, likes, genres, total_tracks, djs, first_seen_at, MIN(1.0, CAST(track_count AS REAL) / NULLIF(total_tracks, 0)) AS share",
  where: "followed = 0",
  primaryKey: "set_id",
  defaultSort: "-track_count",
  columns: {
    set_id: { sql: "set_id", type: "text", filterable: false },
    set_url: { sql: "set_url", type: "text", sortable: false, filterable: false },
    title: { sql: "title", type: "text", searchable: true },
    set_date: { sql: "set_date", type: "date" },
    creator: { sql: "creator", type: "text", searchable: true },
    track_count: { sql: "track_count", type: "number" },
    views: { sql: "views", type: "number" },
    likes: { sql: "likes", type: "number" },
    genres: { sql: "genres", type: "text", searchable: true, sortable: false },
    total_tracks: { sql: "total_tracks", type: "number" },
    // The share of the set the followed tracks make up: a long countdown ranks by its length otherwise.
    // At most 1: a mashup row lists the mashup and each track in it (each one's track page lists the set) while
    // total_tracks counts rows, so a short list of mashups has more followed tracks than rows (seen: 12 of 5).
    share: { sql: "MIN(1.0, CAST(track_count AS REAL) / NULLIF(total_tracks, 0))", type: "number" },
    djs: { sql: "djs", type: "text", searchable: true },
    first_seen_at: { sql: "first_seen_at", type: "datetime", storage: "s" },
  },
};

export type RecommendedSetTrack = {
  trackUrl: string | null;
  trackPageId: string;
  artist: string | null;
  title: string | null;
  seenAt: number;
};

/** The crawled tracks that list one set, with their names from the search index when it has them. */
export async function recommendedSetTracks(
  env: Env,
  setId: string,
  limit = 200,
): Promise<RecommendedSetTrack[]> {
  const { results } = await env.DB.prepare(
    `SELECT ts.track_page_id AS id, ts.seen_at AS seenAt, c.track_url AS url
       FROM track_sets ts LEFT JOIN track_set_crawl c ON c.track_page_id = ts.track_page_id
      WHERE ts.set_id = ? ORDER BY ts.seen_at, ts.track_page_id LIMIT ?`,
  )
    .bind(setId, limit)
    .all<{ id: string; seenAt: number; url: string | null }>();
  const names = new Map<string, { artist: string; title: string }>();
  if (env.SEARCH_DB && results.length > 0) {
    const ids = results.map((r) => r.id);
    for (let i = 0; i < ids.length; i += 90) {
      const part = ids.slice(i, i + 90);
      const { results: found } = await env.SEARCH_DB.prepare(
        `SELECT page_id, artist, title FROM search_tracks WHERE page_id IN (${part.map(() => "?").join(", ")})`,
      )
        .bind(...part)
        .all<{ page_id: string; artist: string; title: string }>();
      for (const f of found) names.set(f.page_id, { artist: f.artist, title: f.title });
    }
  }
  return results.map((r) => ({
    trackUrl: r.url,
    trackPageId: r.id,
    artist: names.get(r.id)?.artist ?? null,
    title: names.get(r.id)?.title ?? null,
    seenAt: Number(r.seenAt) || 0,
  }));
}
