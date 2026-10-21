/**
 * The reorder pass: puts every artist playlist in the order
 * lib/playlist-order.ts defines, a few moves at a time. The combined playlist
 * is not ordered, by the owner's decision (it is the one for shuffling and
 * would be half of all the moves): this file never reads, plans or moves it.
 * The pass is both the one-off backfill of playlists filled before ordering
 * existed and the upkeep afterwards (an insert that had to be appended, a
 * video the owner dragged).
 *
 * **It ships paused.** `playlists.orderDailyUnits` defaults to 0, so the
 * ordering quota consumer starts switched off (settings.quota.consumers,
 * migrated from it), and switched off the cron pass returns before any YouTube call, any listing included. The owner
 * starts it by saving a budget on /ui/settings after looking at the dry run.
 * New videos are inserted at their place either way (lib/playlist-order-store.ts).
 *
 * **Why a cron pass and not a script.** A move is `playlistItems.update`, 50
 * units, and the roughly 1 000 moves the first backfill needs are five times a
 * whole day's quota: the job has to run for weeks next to the sync, the
 * combined backfill and mkvid's deliveries, all on the same 10 000 units. The
 * OAuth client secret and the refresh token only exist in the Worker, and so
 * does the knowledge of what else spent quota today. So it rides the 5-minute
 * cron like the combined backfill, with its own daily unit budget.
 *
 * **Resumable and idempotent.** Nothing about progress is trusted from one
 * run to the next. A run reads the playlist's actual order from YouTube
 * (1 unit per 50 entries), plans the fewest moves from that (`planMoves`),
 * applies as many as its limits allow, in plan order, and stops. A plan cut
 * short leaves a playlist that needs exactly the remaining moves, so a run
 * killed anywhere, a day's budget running out, or the owner reordering by
 * hand in between only changes what the next run finds. A sorted playlist
 * plans zero moves: running it again does nothing.
 *
 * **Self-checking.** The plan rests on what a move does: the item ends up at
 * index `position` of the playlist and everything between its old and new
 * place shifts by one. Google documents `snippet.position` as the zero-based
 * place of the item and nothing more, so the pass checks instead of trusting:
 *   - after the first move of a run on a playlist it READS BACK, with two
 *     1-unit lookups, where the moved item is and where the item the plan
 *     puts next to it is. The update's own reply is not used for this: it may
 *     only repeat the request. Both must be at the index the plan gives them;
 *     the neighbour is what tells "taken out, put back at that index" from
 *     any other way of shifting. A read that disagrees is repeated after a
 *     short wait, twice (YouTube's reads can lag its writes). One that still
 *     finds a video where neither the plan nor the order before the move puts
 *     it stops the playlist (`unexpected_position`);
 *   - a read that still shows the order from BEFORE the move is YouTube's
 *     lag, not a wrong move: the playlist is not stopped, only left for this
 *     run, and the move counts as unconfirmed. Taking that lag for a wrong
 *     move is what used to stop playlists for a day, over and over: at one
 *     move per run every move is read back. The next reading settles it;
 *   - a run that made 3 or more moves, or whose move was unconfirmed, must
 *     leave the playlist needing fewer moves at the next reading than before
 *     it. If it does not, the moves are not doing what the plan thinks and the
 *     playlist stops (`no_progress`).
 * A stopped playlist is tried again an hour later by itself, or at once with
 * Retry now on the card, so a wrong assumption costs a move or two an hour,
 * not the backfill, and nothing has to be cleared by hand.
 *
 * **Videos that are gone.** A playlist keeps the item of a video that was
 * deleted or made private by its uploader, and YouTube answers 404
 * `videoNotFound` to anything that names such a video: the `videoId` lookup
 * the read-back uses, and possibly the move itself. Nobody can play it and it
 * is on its way out of the playlist (lib/playlist-hygiene.ts), so it has no
 * place worth 50 units:
 *   - an entry the listing shows as gone (`isUnavailableItem`) is never moved.
 *     The plan sorts the others around it (`fixed` in `planMoves`) and a
 *     playlist whose only disorder is such a video needs no moves;
 *   - a move YouTube refuses with `videoNotFound` although the listing showed
 *     the video as there is remembered on the playlist (`unmovable`) and
 *     planned around from then on, instead of being paid for again every hour.
 *     The Playlists page says how many. It is forgotten after a week, so the
 *     move is tried once more (the video may be back), or at once by Retry now;
 *   - the read-back never asks about a gone video by its id. When the
 *     neighbour it checks is one, or a lookup answers `videoNotFound` anyway,
 *     it reads the same two positions from a listing of the playlist (1 unit
 *     per 50 entries), which shows every item. What is checked is the same.
 *
 * **Limits.** The ordering consumer's max (settings.quota, lib/quota-priority.ts
 * dailyMaxUnits; it took over `playlists.orderDailyUnits`), and its turn at the
 * quota, asked once per pass, is everything the pass may spend in
 * a quota day (midnight Pacific), listings and lookups included and failed
 * moves too (YouTube charges for those). `playlists.orderMovesPerRun`
 * (default 10) and a wall-clock ceiling bound one run. A daily-quota reply,
 * to this pass or to any other YouTube writer (lib/youtube-quota.ts), stops
 * the pass until the quota day rolls over; a per-minute rate limit ends the
 * run only. See `quotaStop` and `youtubeQuotaOut` below.
 *
 * **One at a time.** The cron pass, Move now and a fresh dry run read the same
 * playlists, so each holds a short lock (`yt:order:lock`) while it works;
 * whoever comes second skips and says so. A run therefore never plans from a
 * listing taken before another run's moves. The lock is only taken once there
 * is something to read (an enabled pass with nothing due writes nothing), it
 * names its holder, and a run writes back only the playlists it read, so
 * Retry now needs no lock (see `takeLock`, `saveTouched`).
 *
 * **Order of work.** Playlists never read first (reading is what the dry run
 * needs), then playlists with moves left, fewest first, so whole playlists
 * finish early, then playlists due their daily look.
 *
 * The dry run is `orderReport(env, { fresh: true })`: it reads and plans
 * exactly as a run does and moves nothing. It works while the pass is paused.
 */

import type { Env } from "../types";
import { getAppSettings } from "./app-settings";
import { dailyMaxUnits, OWNER, quotaGate, type GateRefusal } from "./quota-priority";
import { loadCombinedState } from "./combined-playlist";
import { dbOf } from "./db";
import { getAccessToken } from "./google-oauth";
import { errorFields, type Logger } from "./log";
import { quotaDayStart } from "./mkvid";
import {
  applyMoves,
  estimateDays,
  listUnits,
  planMoves,
  UNDATED,
  UNITS_PER_MOVE,
  type Move,
  type OrderKey,
  type OrderNeed,
} from "./playlist-order";
import {
  clearNotManual,
  loadOrderKeys,
  noteNotManual,
  type OrderKeys,
} from "./playlist-order-store";
import { quotaKind } from "./youtube-error";
import { getQuotaOut, noteQuotaOut } from "./youtube-quota";
import {
  getPlaylistItemPosition,
  isQuotaError,
  isUnavailableItem,
  listPlaylistItems,
  movePlaylistItem,
  PlaylistNotFoundError,
  YouTubeApiError,
} from "./youtube-playlists";

// --- quota: the two places this file asks about it --------------------------

/**
 * What a failed YouTube call says about quota (lib/youtube-error.ts decides):
 *   - `daily`  the day's quota is spent (`quotaExceeded`, `dailyLimitExceeded`):
 *              nothing succeeds until midnight Pacific.
 *   - `rate`   a per-minute limit (`rateLimitExceeded`, `userRateLimitExceeded`):
 *              this run ends, the next tick may try again.
 *   - null     not about quota.
 * The only place this file classifies a reply.
 */
export function quotaStop(e: unknown): "daily" | "rate" | null {
  if (!isQuotaError(e)) return null;
  return quotaKind((e as YouTubeApiError).reason) === "quota" ? "daily" : "rate";
}

/**
 * "Is YouTube's daily quota out?" The one call site the pass and the report
 * ask: the flag every YouTube writer shares (`yt:quota:out`,
 * lib/youtube-quota.ts), set on any daily-quota reply, this pass's included,
 * and gone at midnight Pacific. Returns the unix seconds it holds until, or null.
 */
async function youtubeQuotaOut(env: Env): Promise<number | null> {
  return (await getQuotaOut(env))?.until ?? null;
}

// --- state ------------------------------------------------------------------

/** Durable, in SUBS next to the combined playlist's pointer. */
const ORDER_STATE_KEY = "subs:playlist-order";
/** Units spent per quota day, in CACHE (a rolling budget, not state). */
const DAILY_UNITS_PREFIX = "yt:order:units:";
const DAILY_UNITS_TTL = 60 * 60 * 48;
/** Held by whoever is reading or moving (see "One at a time"). KV's shortest expiry; a run is bounded well below it. */
const LOCK_KEY = "yt:order:lock";
const LOCK_TTL = 60;
/** A fresh dry run reads every playlist; it stops here and reports what it has, so it ends inside the lock's time. */
const REPORT_DEADLINE_MS = 40_000;
/** A YouTube playlist id as a route may hand it over (the real ones are `PL` + 16 to 32 of these). */
const PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{2,64}$/;
/** A playlist with nothing left to move is looked at again this often; so is one not on manual order (only the owner can change that, and each try is a refused 50-unit move). */
const RECHECK_SECONDS = 24 * 60 * 60;
/** A playlist its own checks stopped (`unexpected_position`, `no_progress`) is tried again after this long, by itself. */
const STOP_RETRY_SECONDS = 60 * 60;
/** A playlist that could not be read, or refused a move, is left alone this long (a refused move costs 50 units). */
const PROBLEM_RETRY_SECONDS = 60 * 60;
/** An item a move was refused for (`videoNotFound`) is planned around this long, then its move is tried once more. */
const UNMOVABLE_SECONDS = 7 * 24 * 60 * 60;
/** Wall-clock ceiling of one cron pass, on top of whatever the tick already spent. */
const PASS_DEADLINE_MS = 10_000;
/** Playlists read in one cron pass at most (each is one listing; the moves are bounded separately). */
const MAX_PLAYLISTS_PER_PASS = 6;
/** A run of at least this many moves must have lowered what the playlist needs by the next reading. */
const PROGRESS_CHECK_MIN_MOVES = 3;
/** The read-back of a first move that disagrees is repeated after each of these waits (read-after-write lag). */
const CONFIRM_RETRY_MS = [1500, 4000];
const CONFIRM_LOOKS = CONFIRM_RETRY_MS.length + 1;
/**
 * Units the read-back of a first move may cost in a playlist of `items`
 * entries: two lookups per look. When a video it asks about turns out to be
 * gone a listing takes over for that look and every later one, so the worst is
 * two lookups per look plus one listing at the last, or two lookups and then a
 * listing per look.
 */
const confirmUnits = (items: number) =>
  Math.max(2 * CONFIRM_LOOKS + listUnits(items), 2 + CONFIRM_LOOKS * listUnits(items));
/** Budgets the report gives a duration for, so a paused pass still says what each would mean. */
const SAMPLE_DAILY_UNITS = [1000, 2000, 4000];

const nowSeconds = () => Math.floor(Date.now() / 1000);

export type ManagedPlaylist = { playlistId: string; slug: string; title: string };

/**
 * Why a playlist is not being worked on:
 *   - `manual_sort`          YouTube refuses positions: the playlist is set to
 *                            sort by date or popularity. Only the owner can
 *                            change that (the one state shown in red).
 *   - `unexpected_position`  the read-back of a move did not find the videos
 *                            where the plan puts them.
 *   - `no_progress`          a run of moves left the playlist needing no fewer.
 *   - `unreadable`           the playlist is gone, could not be listed, or its
 *                            listing's positions are not 0..n-1; nothing for
 *                            the owner to do.
 *   - `move_failed`          a move was refused for another reason, or could
 *                            not be read back; tried again. Never because a
 *                            video is gone (see the file comment).
 * The first three stop the playlist (`STOPPING`): `manual_sort` for a day,
 * the other two for an hour; the last two keep it waiting an hour too. The
 * pass tries each again by itself then, or at once after Retry now.
 */
export type OrderProblem =
  "manual_sort" | "unexpected_position" | "no_progress" | "unreadable" | "move_failed";
const STOPPING: readonly OrderProblem[] = ["manual_sort", "unexpected_position", "no_progress"];
/** How long a problem keeps the pass away from its playlist, counted from when the pass ran into it. */
const problemWaitSeconds = (p: OrderProblem): number =>
  p === "manual_sort"
    ? RECHECK_SECONDS
    : STOPPING.includes(p)
      ? STOP_RETRY_SECONDS
      : PROBLEM_RETRY_SECONDS;

export type OrderPlaylistState = ManagedPlaylist &
  OrderNeed & {
    /** Unix seconds of the reading these numbers are from. */
    checkedAt: number;
    /** Moves made on this playlist since ordering began. */
    moved: number;
    problem?: OrderProblem | null;
    detail?: string | null;
    /** Unix seconds the pass ran into `problem`; its retry is timed from here, so a dry run in between does not put it off. */
    problemAt?: number | null;
    /**
     * The last run that moved something: what the playlist needed before it and
     * how many moves it made (the progress check). `unconfirmed` = its read-back
     * only found the order from before the move (YouTube's lag).
     */
    lastRun?: { needed: number; applied: number; unconfirmed?: boolean } | null;
    /** Items a move was refused for with `videoNotFound`, and when: planned around while they are in the playlist, for a week or until Retry now. */
    unmovable?: Array<{ id: string; at: number }>;
  };

export type OrderStop =
  | "paused"
  | "not_connected"
  | "quota"
  | "rate_limit"
  | "budget"
  /** The priority rule (lib/quota-priority.ts) holds the pass for higher-ranked work. */
  | "held"
  | "run"
  | "deadline"
  | "busy"
  | "no_keys"
  | null;

export type OrderState = {
  playlists: Record<string, OrderPlaylistState>;
  lastRun?: {
    at: number;
    trigger: string | null;
    read: number;
    moved: number;
    units: number;
    stoppedBy: OrderStop;
  } | null;
};

export async function loadOrderState(env: Env): Promise<OrderState> {
  const s = (await env.SUBS.get(ORDER_STATE_KEY, "json")) as OrderState | null;
  return s && typeof s === "object" && s.playlists ? s : { playlists: {} };
}

async function saveOrderState(env: Env, state: OrderState): Promise<void> {
  await env.SUBS.put(ORDER_STATE_KEY, JSON.stringify(state));
}

/** A playlist's entry, as an own key only (`constructor` is no playlist). */
const own = (state: OrderState, playlistId: string): OrderPlaylistState | undefined =>
  Object.prototype.hasOwnProperty.call(state.playlists, playlistId)
    ? state.playlists[playlistId]
    : undefined;

/**
 * Write back what this run read, and nothing else: the playlists in `touched`
 * and `lastRun`, over the state as it is now. Retry now changes the state
 * without the lock, so a run must not put back the whole document it loaded
 * when it started. `carried` = playlists whose stop this run only copied from
 * that earlier load (the dry run): one Retry now cleared meanwhile stays cleared.
 */
async function saveTouched(
  env: Env,
  state: OrderState,
  touched: Iterable<string>,
  carried?: ReadonlySet<string>,
): Promise<void> {
  const latest = await loadOrderState(env);
  for (const id of touched) {
    const mine = own(state, id);
    if (!mine) continue;
    const theirs = own(latest, id);
    const cleared = !!carried?.has(id) && !!theirs && !theirs.problem;
    latest.playlists[id] = cleared
      ? {
          ...mine,
          problem: null,
          detail: null,
          problemAt: null,
          lastRun: null,
          unmovable: undefined,
          checkedAt: mine.moves > 0 ? mine.checkedAt : 0,
        }
      : mine;
  }
  if (state.lastRun !== undefined) latest.lastRun = state.lastRun;
  await saveOrderState(env, latest);
}

type Lock = { token: string; at: number };

function parseLock(raw: string): Lock | null {
  try {
    const v = JSON.parse(raw) as Partial<Lock> | null;
    return v && typeof v.token === "string" && typeof v.at === "number"
      ? { token: v.token, at: v.at }
      : null;
  } catch {
    return null;
  }
}

/**
 * Take the lock, or learn that someone holds it: the holder's token, or null.
 * Get-then-put like the DJ set-list refresh lock (lib/dj-sets.ts): KV has no
 * compare-and-set, and the two callers here are a 5-minute cron and one
 * person's button. The value names its holder and when it was taken, so
 * `releaseLock` deletes only its own lock, and a lock older than its time
 * (KV is late expiring a key now and then) is seen as lapsed, said so, and
 * replaced; its former holder then finds out in `lockTakenOver`.
 */
async function takeLock(env: Env, log?: Logger): Promise<string | null> {
  const raw = await env.CACHE.get(LOCK_KEY);
  if (raw) {
    const held = parseLock(raw);
    // A value this code did not write counts as held until KV expires it.
    if (!held || Date.now() - held.at < LOCK_TTL * 1000) return null;
    log?.warn("playlist_order.lock_lapsed", { heldForMs: Date.now() - held.at });
  }
  const token = crypto.randomUUID();
  await env.CACHE.put(LOCK_KEY, JSON.stringify({ token, at: Date.now() } satisfies Lock), {
    expirationTtl: LOCK_TTL,
  });
  return token;
}

/**
 * Has another run taken the lock from this one? Only a read that returns a
 * DIFFERENT holder says so. "Not set" says nothing: `takeLock` read the key as
 * absent a moment before writing it, and KV may go on answering that for a
 * key it was just asked about. The run took the lock and keeps its token in
 * memory; taking a missing key for a lost lock would make an enabled pass skip
 * its state save every time, so a stop (`unexpected_position`) would never be
 * remembered and the same move would be paid for on every tick.
 */
async function lockTakenOver(env: Env, token: string): Promise<boolean> {
  const raw = await env.CACHE.get(LOCK_KEY);
  return !!raw && parseLock(raw)?.token !== token;
}

/** Deletes the lock unless another run is seen to hold it: one that lapsed and was taken over is theirs. */
async function releaseLock(env: Env, token: string): Promise<void> {
  try {
    if (!(await lockTakenOver(env, token))) await env.CACHE.delete(LOCK_KEY);
  } catch {
    // It expires by itself.
  }
}

function dailyKey(nowMs = Date.now()): string {
  return `${DAILY_UNITS_PREFIX}${quotaDayStart(nowMs)}`;
}

export async function orderUnitsUsedToday(env: Env): Promise<number> {
  const n = Number.parseInt((await env.CACHE.get(dailyKey())) ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Read-modify-write like the combined playlist's counter: runs do not overlap (the lock), and a lost bump is a few units. */
async function chargeUnits(env: Env, units: number): Promise<void> {
  if (units <= 0) return;
  await env.CACHE.put(dailyKey(), String((await orderUnitsUsedToday(env)) + units), {
    expirationTtl: DAILY_UNITS_TTL,
  });
}

/**
 * The playlists that are ordered: one per DJ (`sub_sync`, unsubscribed DJs
 * included, their playlist stays). Never the combined one, by id, whatever
 * `sub_sync` says.
 */
export async function managedPlaylists(env: Env): Promise<ManagedPlaylist[]> {
  const res = await dbOf(env)
    .prepare(
      "SELECT slug, playlist_id, artist_name FROM sub_sync WHERE playlist_id IS NOT NULL ORDER BY slug",
    )
    .all<{ slug: string; playlist_id: string; artist_name: string | null }>();
  const combined = (await loadCombinedState(env)).playlistId ?? null;
  return res.results
    .filter((r) => r.playlist_id !== combined)
    .map((r) => ({
      playlistId: r.playlist_id,
      slug: r.slug,
      title: `${r.artist_name ?? r.slug} (1001tklists)`,
    }));
}

/** `fixed` = never moved and never looked up by its video id: the video is gone from YouTube (see the file comment). */
type Entry = { id: string; videoId: string; key: OrderKey; fixed: boolean };

/**
 * The playlist's entries in the order YouTube has them, by `snippet.position`
 * (not by the order of the response). Every index the plan uses comes from
 * this, so the listing is refused unless every entry has an item id, a video
 * id and a position, and the positions are exactly 0..n-1, each once.
 * `unmovable` = item ids an earlier move was refused for (`videoNotFound`);
 * they are `fixed` like the entries the listing itself shows as gone.
 */
export async function readPlaylistOrder(
  playlistId: string,
  keys: OrderKeys,
  accessToken: string,
  fetcher?: typeof fetch,
  unmovable?: ReadonlySet<string>,
): Promise<{ entries: Entry[]; pages: number }> {
  const r = await listPlaylistItems(playlistId, accessToken, {}, fetcher);
  const raw = r.items.map((it) => ({
    id: it.id,
    videoId: it.contentDetails?.videoId || it.snippet?.resourceId?.videoId,
    position: (it.snippet as { position?: unknown } | undefined)?.position,
    fixed: isUnavailableItem(it) || (!!it.id && !!unmovable?.has(it.id)),
  }));
  if (raw.some((e) => !e.id || !e.videoId)) throw new Error("listing has an entry without an id");
  if (raw.some((e) => typeof e.position !== "number"))
    throw new Error("listing has an entry without a position");
  const sorted = raw.sort((a, b) => (a.position as number) - (b.position as number));
  if (sorted.some((e, i) => e.position !== i))
    throw new Error("listing positions are not 0..n-1 (a gap or a duplicate)");
  return {
    entries: sorted.map((e) => ({
      id: e.id!,
      videoId: e.videoId!,
      key: keys.get(e.videoId!) ?? UNDATED,
      fixed: e.fixed,
    })),
    pages: r.pages,
  };
}

/** A reply that says the video named in the request is gone from YouTube. Not the playlist's fault, and asking again changes nothing. */
function isVideoGone(e: unknown): boolean {
  return e instanceof YouTubeApiError && e.status === 404 && e.reason === "videoNotFound";
}

/** The `unmovable` items still remembered at `now`: after UNMOVABLE_SECONDS one is forgotten, so its move is tried once more (the video may be back). */
function unmovableNow(
  before: OrderPlaylistState | undefined,
  now: number,
): Array<{ id: string; at: number }> {
  return (before?.unmovable ?? []).filter(
    (u) => u && typeof u.id === "string" && now - u.at < UNMOVABLE_SECONDS,
  );
}

/** Those of them that are still in the playlist (one that left needs no remembering). */
function unmovableOf(
  before: OrderPlaylistState | undefined,
  entries: Entry[],
  now: number,
): Array<{ id: string; at: number }> | undefined {
  const still = unmovableNow(before, now).filter((u) => entries.some((e) => e.id === u.id));
  return still.length > 0 ? still : undefined;
}

function needOf(entries: Entry[], moves: Move[]): OrderNeed {
  return {
    items: entries.length,
    undated: entries.filter((e) => e.key.date === null).length,
    moves: moves.length,
    units: moves.length * UNITS_PER_MOVE,
  };
}

/** Which playlists a pass looks at, in order (see the file comment). */
export function orderQueue(
  playlists: ManagedPlaylist[],
  state: OrderState,
  now: number,
): ManagedPlaylist[] {
  const rank = (p: ManagedPlaylist): [number, number] | null => {
    const s = own(state, p.playlistId);
    if (!s) return [0, 0];
    // A playlist with a problem waits (`problemWaitSeconds`), timed from when the pass ran into it, not from the last dry run.
    if (s.problem) {
      const since = s.problemAt ?? s.checkedAt;
      return now - since >= problemWaitSeconds(s.problem) ? [2, since] : null;
    }
    if (s.moves > 0) return [1, s.moves];
    return now - s.checkedAt >= RECHECK_SECONDS ? [2, s.checkedAt] : null;
  };
  return playlists
    .map((p) => ({ p, r: rank(p) }))
    .filter((x): x is { p: ManagedPlaylist; r: [number, number] } => x.r !== null)
    .sort(
      (a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || (a.p.playlistId < b.p.playlistId ? -1 : 1),
    )
    .map((x) => x.p);
}

/**
 * `lagging` = the last look found every video either where the plan puts it or
 * where it was before the move, at least one of them before: YouTube had not
 * caught up with its own write yet, which says nothing against the plan.
 */
type Confirmed = { ok: true } | { ok: false; lagging: boolean; detail: string };

/**
 * Read back the first move of a run: is the moved item at the index it was
 * sent to, and is the item the plan puts beside it (after it, or before it
 * when it went last) where the plan has it? Two lookups, 1 unit each, looked
 * at again after each of `CONFIRM_RETRY_MS` (`sleep`) while they disagree.
 * Throws what a lookup throws; `spent.units` counts every lookup made, the one
 * that threw included.
 *
 * A lookup names the video, and YouTube answers `videoNotFound` for one that
 * is gone. So when the neighbour is such a video (`fixed`), or a lookup gets
 * that answer, the two positions are read from a listing of the playlist
 * instead, from then on: it shows every item, and it is the same two indexes
 * that are checked.
 */
async function confirmMove(a: {
  playlistId: string;
  before: Entry[];
  move: Move;
  accessToken: string;
  fetcher?: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  spent: { units: number };
}): Promise<Confirmed> {
  const expected = applyMoves(
    a.before.map((e) => e.id),
    [a.move],
  );
  const byId = new Map(a.before.map((e) => [e.id, e]));
  const neighbourAt =
    a.move.position + 1 < expected.length ? a.move.position + 1 : a.move.position - 1;
  const wasAt = new Map(a.before.map((e, i) => [e.id, i]));
  const checks = [
    { id: a.move.id, at: a.move.position, was: wasAt.get(a.move.id)!, what: "the moved video" },
  ];
  if (neighbourAt >= 0)
    checks.push({
      id: expected[neighbourAt]!,
      at: neighbourAt,
      was: wasAt.get(expected[neighbourAt]!)!,
      what: neighbourAt > a.move.position ? "the video after it" : "the video before it",
    });
  /** Item id -> index, from one listing of the playlist. One that fails is charged its first page, like any other. */
  const listed = async (): Promise<Map<string, number>> => {
    let pages = 1;
    try {
      const r = await listPlaylistItems(a.playlistId, a.accessToken, {}, a.fetcher);
      pages = r.pages;
      const out = new Map<string, number>();
      for (const it of r.items) {
        const position = (it.snippet as { position?: unknown } | undefined)?.position;
        if (it.id && typeof position === "number") out.set(it.id, position);
      }
      return out;
    } finally {
      a.spent.units += pages;
    }
  };
  let byListing = checks.some((c) => byId.get(c.id)!.fixed);
  let detail = "";
  let lagging = false;
  for (let attempt = 0; attempt < CONFIRM_LOOKS; attempt++) {
    if (attempt > 0) await a.sleep(CONFIRM_RETRY_MS[attempt - 1]!);
    detail = "";
    let positions = byListing ? await listed() : null;
    for (const c of checks) {
      let got: number | null = null;
      if (!positions) {
        a.spent.units += 1;
        try {
          got = await getPlaylistItemPosition(
            a.playlistId,
            byId.get(c.id)!.videoId,
            c.id,
            a.accessToken,
            a.fetcher,
          );
        } catch (e) {
          if (!isVideoGone(e)) throw e;
          byListing = true;
          positions = await listed();
        }
      }
      if (positions) got = positions.get(c.id) ?? null;
      if (got !== c.at) {
        // Still where it was before the move (the moved video is checked first): the write has not shown yet.
        lagging = got === c.was;
        detail = `${c.what} should be at index ${c.at} after a move to index ${a.move.position} and is ${got === null ? "not found" : `at index ${got}`}${lagging ? " (where it was before the move)" : ""}`;
        break;
      }
    }
    if (!detail) return { ok: true };
  }
  return { ok: false, lagging, detail };
}

export type OrderPassResult = {
  ok: true;
  /** Playlists read this run. */
  read: number;
  moved: number;
  /** Units this run spent: listings, moves and lookups. */
  units: number;
  stoppedBy: OrderStop;
  unitsUsedToday: number;
  dailyUnits: number;
};

type PassOpts = {
  log: Logger;
  trigger?: string;
  fetcher?: typeof fetch;
  deadlineMs?: number;
  accessToken?: string;
  sleep?: (ms: number) => Promise<void>;
};

/** How a refusal of the priority rule reads as a stop. */
const GATE_STOP: Record<GateRefusal, OrderStop> = {
  held: "held",
  max: "budget",
  off: "paused",
  pool_out: "quota",
};

/**
 * One bounded pass. Never throws for a YouTube or D1 failure it can name; a
 * daily-quota reply ends it and is remembered for the rest of the quota day.
 * Paused (budget 0) it returns before any YouTube call and any KV write.
 * `busy` = another run holds the lock; nothing was read or moved. The queue is
 * worked out before the lock is taken (reads only), so a pass with nothing due
 * writes nothing either; the pass itself reads the state again under the lock.
 */
export async function runOrderPass(env: Env, opts: PassOpts): Promise<OrderPassResult> {
  const app = await getAppSettings(env);
  const settings = app.playlists;
  // The ordering consumer's max (settings.quota; it took over orderDailyUnits); switched off = paused.
  const dailyUnits = dailyMaxUnits(app, "ordering");
  if (dailyUnits <= 0)
    return {
      ok: true,
      read: 0,
      moved: 0,
      units: 0,
      stoppedBy: "paused",
      unitsUsedToday: 0,
      dailyUnits: 0,
    };
  const used = await orderUnitsUsedToday(env);
  const skipped = (stoppedBy: OrderStop): OrderPassResult => ({
    ok: true,
    read: 0,
    moved: 0,
    units: 0,
    stoppedBy,
    unitsUsedToday: used,
    dailyUnits,
  });
  if (await youtubeQuotaOut(env)) return skipped("quota");
  // Not worth a listing when what is left cannot pay for one move.
  if (dailyUnits - used < UNITS_PER_MOVE + 1) return skipped("budget");
  if (orderQueue(await managedPlaylists(env), await loadOrderState(env), nowSeconds()).length === 0)
    return skipped(null);
  // Its turn at the quota (the Playlists page's Run button is the owner's), for the moves this run may
  // make and a listing: a run let through on one move could spend into what a higher rank keeps.
  const moves = Math.max(
    1,
    Math.min(settings.orderMovesPerRun, Math.floor((dailyUnits - used - 1) / UNITS_PER_MOVE)),
  );
  const units = moves * UNITS_PER_MOVE + 1;
  const gate = await quotaGate(
    env,
    opts.trigger?.startsWith("manual.") ? OWNER : "ordering",
    units,
  );
  if (!gate.ok) {
    opts.log.info("playlist_order.quota_gate_held", { reason: gate.reason, units });
    return skipped(GATE_STOP[gate.reason]);
  }
  const accessToken = opts.accessToken ?? (await getAccessToken(env))?.accessToken;
  if (!accessToken) return skipped("not_connected");
  const token = await takeLock(env, opts.log);
  if (!token) return skipped("busy");
  try {
    return await passLocked(
      env,
      { ...opts, accessToken },
      { dailyUnits, movesPerRun: settings.orderMovesPerRun, used, token },
    );
  } finally {
    await releaseLock(env, token);
  }
}

/** The pass itself; the caller holds the lock, so the state read here is the one this run writes back. */
async function passLocked(
  env: Env,
  opts: PassOpts & { accessToken: string },
  lim: { dailyUnits: number; movesPerRun: number; used: number; token: string },
): Promise<OrderPassResult> {
  const log = opts.log;
  const { dailyUnits, used } = lim;
  const done = (stoppedBy: OrderStop, read = 0, moved = 0, units = 0): OrderPassResult => ({
    ok: true,
    read,
    moved,
    units,
    stoppedBy,
    unitsUsedToday: used + units,
    dailyUnits,
  });
  const state = await loadOrderState(env);
  const now = nowSeconds();
  const queue = orderQueue(await managedPlaylists(env), state, now);
  if (queue.length === 0) return done(null);
  const accessToken = opts.accessToken;
  /** Playlists this run read: the only ones it writes back (`saveTouched`). */
  const touched = new Set<string>();
  // Without the set dates nothing can be planned. That is D1's failure, not a playlist's: nothing is read, nothing is spent.
  let keys: OrderKeys;
  try {
    keys = await loadOrderKeys(env);
  } catch (e) {
    log.warn("playlist_order.keys_unreadable", errorFields(e));
    return done("no_keys");
  }

  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (opts.deadlineMs ?? PASS_DEADLINE_MS);
  let units = 0;
  let moved = 0;
  let read = 0;
  let stoppedBy: OrderStop = null;
  const left = () => dailyUnits - used - units;
  /** A quota reply ends the pass: for the day (every YouTube writer is told), or for this run. */
  const passStop = async (e: unknown): Promise<OrderStop> => {
    const q = quotaStop(e);
    if (q === "daily") await noteQuotaOut(env, e, log);
    return q === "daily" ? "quota" : q === "rate" ? "rate_limit" : null;
  };
  const messageOf = (e: unknown) =>
    (errorFields(e).errorMessage as string | undefined) ?? String(e);

  for (const p of queue) {
    if (read >= MAX_PLAYLISTS_PER_PASS) break;
    if (Date.now() >= deadline) {
      stoppedBy = "deadline";
      break;
    }
    const before = own(state, p.playlistId);
    // A listing of the size last seen, and at least one move after it, must fit in what is left.
    if (
      left() <
      listUnits(before?.items ?? 0) + (before && before.moves === 0 ? 0 : UNITS_PER_MOVE)
    ) {
      stoppedBy = "budget";
      break;
    }
    let entries: Entry[];
    try {
      const r = await readPlaylistOrder(
        p.playlistId,
        keys,
        accessToken,
        opts.fetcher,
        new Set(unmovableNow(before, now).map((u) => u.id)),
      );
      entries = r.entries;
      units += r.pages;
      read += 1;
    } catch (e) {
      // A listing that failed part-way still cost its first page.
      units += 1;
      stoppedBy = await passStop(e);
      if (stoppedBy) break;
      touched.add(p.playlistId);
      state.playlists[p.playlistId] = {
        ...p,
        items: before?.items ?? 0,
        undated: before?.undated ?? 0,
        moves: before?.moves ?? 0,
        units: before?.units ?? 0,
        checkedAt: now,
        moved: before?.moved ?? 0,
        lastRun: before?.lastRun ?? null,
        unmovable: before?.unmovable,
        problem: "unreadable",
        problemAt: now,
        detail: e instanceof PlaylistNotFoundError ? "playlist not found on YouTube" : messageOf(e),
      };
      log.warn("playlist_order.unreadable", {
        playlistId: p.playlistId,
        slug: p.slug,
        ...errorFields(e),
      });
      continue;
    }
    const plan = planMoves(entries);
    const next: OrderPlaylistState = {
      ...p,
      ...needOf(entries, plan.moves),
      checkedAt: now,
      moved: before?.moved ?? 0,
      problem: null,
      detail: null,
      problemAt: null,
      lastRun: null,
      unmovable: unmovableOf(before, entries, now),
    };
    state.playlists[p.playlistId] = next;
    touched.add(p.playlistId);
    const stop = (problem: OrderProblem, detail: string) => {
      next.problem = problem;
      next.detail = detail;
      next.problemAt = now;
    };
    // The last run moved videos here (or one it could not see land) and the playlist needs no fewer moves than before it: the moves are not doing what the plan thinks.
    const last = before?.lastRun;
    if (
      last &&
      (last.applied >= PROGRESS_CHECK_MIN_MOVES || last.unconfirmed) &&
      plan.moves.length >= last.needed
    ) {
      stop(
        "no_progress",
        `${last.applied} ${last.applied === 1 ? "move was" : "moves were"} made${last.unconfirmed ? " (not seen to land)" : ""} and the playlist still needs ${plan.moves.length} (it needed ${last.needed} before)`,
      );
      log.warn("playlist_order.no_progress", {
        playlistId: p.playlistId,
        slug: p.slug,
        applied: last.applied,
        neededBefore: last.needed,
        neededNow: plan.moves.length,
      });
      continue;
    }
    const videoOf = new Map(entries.map((e) => [e.id, e.videoId]));
    let applied = 0;
    /** A move of the plan that will never be made: its video turned out to be gone. */
    let dropped = 0;
    /** The first move's read-back only found the order from before it (`confirmMove`'s `lagging`). */
    let unconfirmed = false;
    for (const m of plan.moves) {
      if (moved >= lim.movesPerRun) {
        stoppedBy = "run";
        break;
      }
      // The first move of a run brings its read-back with it.
      if (left() < UNITS_PER_MOVE + (applied === 0 ? confirmUnits(entries.length) : 0)) {
        stoppedBy = "budget";
        break;
      }
      if (Date.now() >= deadline) {
        stoppedBy = "deadline";
        break;
      }
      // Charged before the call: a move YouTube refuses costs the same 50 units.
      units += UNITS_PER_MOVE;
      try {
        await movePlaylistItem(
          { itemId: m.id, playlistId: p.playlistId, videoId: videoOf.get(m.id)! },
          m.position,
          accessToken,
          opts.fetcher,
        );
      } catch (e) {
        stoppedBy = await passStop(e);
        if (stoppedBy) break;
        // Every later move of the plan assumed this one happened: the next run plans afresh.
        if (isVideoGone(e)) {
          // Gone though the listing did not show it: no stop and nothing to retry, the next plan goes around it.
          next.unmovable = [...(next.unmovable ?? []), { id: m.id, at: now }];
          dropped = 1;
          log.info("playlist_order.video_gone", {
            playlistId: p.playlistId,
            slug: p.slug,
            itemId: m.id,
            videoId: videoOf.get(m.id),
          });
          break;
        }
        const manual =
          e instanceof YouTubeApiError && e.status === 400 && e.reason === "manualSortRequired";
        stop(
          manual ? "manual_sort" : "move_failed",
          manual ? "the playlist is not on manual order" : messageOf(e),
        );
        // Inserts into it stop trying a position too (lib/playlist-order-store.ts).
        if (manual) await noteNotManual(env, p.playlistId).catch(() => {});
        log.warn("playlist_order.move_failed", {
          playlistId: p.playlistId,
          slug: p.slug,
          itemId: m.id,
          position: m.position,
          ...errorFields(e),
        });
        break;
      }
      applied += 1;
      moved += 1;
      if (applied === 1) {
        // Read back before any more quota goes into this playlist.
        const spent = { units: 0 };
        try {
          const c = await confirmMove({
            playlistId: p.playlistId,
            before: entries,
            move: m,
            accessToken,
            fetcher: opts.fetcher,
            sleep,
            spent,
          });
          units += spent.units;
          if (!c.ok && c.lagging) {
            // YouTube has not caught up: no stop. Nothing more is moved here this run, and the next reading's progress check settles it.
            unconfirmed = true;
            log.info("playlist_order.move_unconfirmed", {
              playlistId: p.playlistId,
              slug: p.slug,
              itemId: m.id,
              position: m.position,
              detail: c.detail,
            });
            break;
          }
          if (!c.ok) {
            stop("unexpected_position", c.detail);
            log.warn("playlist_order.unexpected_position", {
              playlistId: p.playlistId,
              slug: p.slug,
              itemId: m.id,
              position: m.position,
              detail: c.detail,
            });
            break;
          }
          log.info("playlist_order.first_move_confirmed", {
            playlistId: p.playlistId,
            slug: p.slug,
            itemId: m.id,
            position: m.position,
          });
        } catch (e) {
          // Every lookup made is charged, the ones before the one that threw too (up to 3 after a second look).
          units += spent.units;
          stoppedBy = await passStop(e);
          if (stoppedBy) break;
          // Not known to be wrong, only not confirmed: nothing more is moved now, and it is tried again within the hour.
          stop("move_failed", `a move could not be read back: ${messageOf(e)}`);
          log.warn("playlist_order.confirm_failed", {
            playlistId: p.playlistId,
            slug: p.slug,
            itemId: m.id,
            ...errorFields(e),
          });
          break;
        }
      }
    }
    next.moves = plan.moves.length - applied - dropped;
    next.units = next.moves * UNITS_PER_MOVE;
    next.moved += applied;
    if (applied > 0) {
      next.lastRun = unconfirmed
        ? { needed: plan.moves.length, applied, unconfirmed }
        : { needed: plan.moves.length, applied };
      log.info("playlist_order.moved", {
        playlistId: p.playlistId,
        slug: p.slug,
        moved: applied,
        left: next.moves,
      });
    }
    if (stoppedBy) break;
  }

  state.lastRun = { at: now, trigger: opts.trigger ?? null, read, moved, units, stoppedBy };
  try {
    await chargeUnits(env, units);
    // The lock lapsed and another run took it: its reading is the newer one, so this run's is not written over it.
    if (await lockTakenOver(env, lim.token))
      log.warn("playlist_order.lock_lost", { read, moved, units });
    else await saveTouched(env, state, touched);
  } catch (e) {
    // The playlists themselves hold the progress; a lost write costs a re-read.
    log.warn("playlist_order.state_write_failed", errorFields(e));
  }
  return done(stoppedBy, read, moved, units);
}

/**
 * The owner's "try this one again now" for a playlist that stopped: the stop
 * is cleared (and the "positions refused" memory with it, for one the owner
 * has switched back to Manual), so the next run reads and plans it afresh and
 * its first move is read back like any other. Nothing is moved here.
 *
 * It takes no lock. A run holding the lock writes back only the playlists it
 * read, over the state as it is then (`saveTouched`), so this change is not
 * lost to one; and a lock taken and released within a second would stay held
 * for its whole minute (KV refuses a second write to a key that soon), making
 * the Move now that follows say a run is in progress. What is left is the
 * moment between a run's last read of the state and its write.
 *
 * `not_found`: not the id of a playlist that is ordered and has been read
 * (checked as own keys, so `constructor` is no playlist).
 */
export async function retryOrderPlaylist(
  env: Env,
  playlistId: string,
): Promise<{ ok: true } | { ok: false; reason: "not_found" }> {
  if (!PLAYLIST_ID_RE.test(playlistId)) return { ok: false, reason: "not_found" };
  if (!(await managedPlaylists(env)).some((p) => p.playlistId === playlistId))
    return { ok: false, reason: "not_found" };
  const state = await loadOrderState(env);
  const s = own(state, playlistId);
  if (!s) return { ok: false, reason: "not_found" };
  // Without a stop and without the last run's numbers it is an ordinary playlist with moves left (or one due a look).
  // An item a move was refused for is forgotten too (the owner asked for another try), and the playlist is then due a reading.
  state.playlists[playlistId] = {
    ...s,
    problem: null,
    detail: null,
    problemAt: null,
    lastRun: null,
    unmovable: undefined,
    checkedAt: s.moves > 0 && !s.unmovable?.length ? s.checkedAt : 0,
  };
  await saveOrderState(env, state);
  await clearNotManual(env, playlistId).catch(() => {});
  return { ok: true };
}

// --- the dry run / status ---------------------------------------------------

export type OrderReportRow = OrderPlaylistState | (ManagedPlaylist & { checkedAt: null });

export type OrderReport = {
  connected: boolean;
  /** True when every number below was read from YouTube just now (`fresh`); else each row says when it was read. */
  fresh: boolean;
  /** A fresh reading was asked for while a run held the lock: these are the stored numbers. */
  busy: boolean;
  /** A fresh reading ran out of time before the last playlist: the ones it reached are new, the rest are the stored numbers. */
  partial: boolean;
  /** Units the fresh reading itself spent (listings only; a dry run never moves). */
  unitsSpent: number;
  playlists: OrderReportRow[];
  /** Every artist playlist read, whether or not it is stopped. The combined playlist is not in here: it is not ordered. */
  totals: OrderNeed & {
    playlists: number;
    unread: number;
    /** Videos a move was refused for because YouTube no longer finds them: left where they are (`unmovable`). */
    unmovable: number;
  };
  /** 0 = paused: the pass makes no YouTube call until a budget is saved. */
  dailyUnits: number;
  movesPerRun: number;
  unitsUsedToday: number;
  /**
   * What the pass still has to do: the moves of the playlists it works on (not
   * one stopped for a reason someone has to look at), the units with the
   * listings of the runs, and the days at `dailyUnits` (null while paused).
   */
  estimate: { moves: number; units: number; days: number | null };
  /** The same work at a few budgets, so a paused pass says what each would mean. */
  daysAt: Array<{ dailyUnits: number; days: number }>;
  /** Set while the daily quota holds the pass back: unix seconds the quota day ends. */
  quotaStoppedUntil: number | null;
  lastRun: OrderState["lastRun"];
};

/**
 * Per playlist: entries, entries with no date, moves needed, units needed;
 * totals; and the days left at the current budget. With `fresh` every playlist
 * is read from YouTube now (about 35 units for 1 100 entries in 25 playlists)
 * and the stored numbers are replaced; nothing is moved either way, and it does
 * not depend on the budget. A fresh reading stops at a quota reply and reports
 * what it has, and so it does after `deadlineMs` (REPORT_DEADLINE_MS, inside
 * the lock's minute): `partial`. It leaves a stop and its retry time as they
 * are, and forgets "positions refused" so the next insert finds out again.
 */
export async function orderReport(
  env: Env,
  opts: {
    log: Logger;
    fresh?: boolean;
    fetcher?: typeof fetch;
    accessToken?: string;
    deadlineMs?: number;
  },
): Promise<OrderReport> {
  const app = await getAppSettings(env);
  const settings = app.playlists;
  const dailyUnits = dailyMaxUnits(app, "ordering");
  const accessToken = opts.accessToken ?? (await getAccessToken(env))?.accessToken ?? null;
  let unitsSpent = 0;
  let fresh = false;
  let busy = false;
  let partial = false;
  if (opts.fresh && accessToken) {
    const token = await takeLock(env, opts.log);
    if (!token) busy = true;
    else {
      try {
        const deadline = Date.now() + (opts.deadlineMs ?? REPORT_DEADLINE_MS);
        const state = await loadOrderState(env);
        const now = nowSeconds();
        const keys = await loadOrderKeys(env);
        const touched = new Set<string>();
        /** Playlists whose stop was copied from the state loaded above, not found by this reading. */
        const carried = new Set<string>();
        fresh = true;
        for (const p of await managedPlaylists(env)) {
          // Out of time: what was read is kept and the rest keep their earlier numbers, rather than outliving the lock.
          if (Date.now() >= deadline) {
            fresh = false;
            partial = true;
            opts.log.info("playlist_order.dry_run_partial", { read: touched.size });
            break;
          }
          const before = own(state, p.playlistId);
          // A reading does not clear a stop: only the pass finds out whether it still holds, at the time it would have anyway.
          const kept =
            before?.problem && STOPPING.includes(before.problem)
              ? {
                  problem: before.problem,
                  detail: before.detail ?? null,
                  problemAt: before.problemAt ?? before.checkedAt,
                }
              : { problem: null, detail: null, problemAt: null };
          const next: OrderPlaylistState = {
            ...p,
            items: before?.items ?? 0,
            undated: before?.undated ?? 0,
            moves: before?.moves ?? 0,
            units: before?.units ?? 0,
            checkedAt: now,
            moved: before?.moved ?? 0,
            lastRun: before?.lastRun ?? null,
            unmovable: before?.unmovable,
            ...kept,
          };
          try {
            const r = await readPlaylistOrder(
              p.playlistId,
              keys,
              accessToken,
              opts.fetcher,
              new Set(unmovableNow(before, now).map((u) => u.id)),
            );
            next.unmovable = unmovableOf(before, r.entries, now);
            unitsSpent += r.pages;
            Object.assign(next, needOf(r.entries, planMoves(r.entries).moves));
            await clearNotManual(env, p.playlistId).catch(() => {});
          } catch (e) {
            unitsSpent += 1;
            const q = quotaStop(e);
            if (q) {
              if (q === "daily") await noteQuotaOut(env, e, opts.log);
              fresh = false;
              break;
            }
            next.problem = "unreadable";
            next.problemAt = now;
            next.detail =
              e instanceof PlaylistNotFoundError
                ? "playlist not found on YouTube"
                : ((errorFields(e).errorMessage as string | undefined) ?? String(e));
          }
          state.playlists[p.playlistId] = next;
          touched.add(p.playlistId);
          if (kept.problem && next.problem === kept.problem) carried.add(p.playlistId);
        }
        await chargeUnits(env, unitsSpent);
        if (await lockTakenOver(env, token))
          opts.log.warn("playlist_order.lock_lost", { read: touched.size, units: unitsSpent });
        else await saveTouched(env, state, touched, carried);
      } catch (e) {
        fresh = false;
        opts.log.warn("playlist_order.dry_run_failed", errorFields(e));
      } finally {
        await releaseLock(env, token);
      }
    }
  }
  const state = await loadOrderState(env);
  const reportNow = nowSeconds();
  // A remembered refusal that has lapsed is not shown: the next reading tries that move again.
  const shown = (s: OrderPlaylistState): OrderPlaylistState =>
    s.unmovable ? { ...s, unmovable: unmovableNow(s, reportNow) } : s;
  const rows: OrderReportRow[] = (await managedPlaylists(env)).map((p) => {
    const s = own(state, p.playlistId);
    return s ? shown(s) : { ...p, checkedAt: null };
  });
  const read = rows.filter((r): r is OrderPlaylistState => r.checkedAt !== null);
  const sum = (xs: OrderPlaylistState[], f: (r: OrderPlaylistState) => number) =>
    xs.reduce((a, r) => a + f(r), 0);
  // Moves the pass will not make are not days it will take.
  const todo = read.filter((r) => !(r.problem && STOPPING.includes(r.problem)));
  const est = estimateDays(todo, dailyUnits, settings.orderMovesPerRun);
  return {
    connected: !!accessToken,
    fresh,
    busy,
    partial,
    unitsSpent,
    playlists: rows,
    totals: {
      playlists: rows.length,
      unread: rows.length - read.length,
      items: sum(read, (r) => r.items),
      undated: sum(read, (r) => r.undated),
      moves: sum(read, (r) => r.moves),
      units: sum(read, (r) => r.units),
      unmovable: sum(read, (r) => unmovableNow(r, nowSeconds()).length),
    },
    dailyUnits,
    movesPerRun: settings.orderMovesPerRun,
    unitsUsedToday: await orderUnitsUsedToday(env),
    estimate: {
      moves: sum(todo, (r) => r.moves),
      units: est.units,
      days: Number.isFinite(est.days) ? est.days : null,
    },
    daysAt: SAMPLE_DAILY_UNITS.map((u) => ({
      dailyUnits: u,
      days: estimateDays(todo, u, settings.orderMovesPerRun).days,
    })),
    quotaStoppedUntil: await youtubeQuotaOut(env),
    lastRun: state.lastRun ?? null,
  };
}
