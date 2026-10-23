/**
 * YouTube subscriptions: the linked YouTube account subscribes to each
 * followed DJ's own channel, and unsubscribes when the DJ is removed - but
 * only from subscriptions tracked made itself.
 *
 * **Which channel is the DJ's.** Every set page names its artists in boxes
 * under the actions (lib/set-meta.ts `boxes`, object 2 = artist), each with
 * the contact links 1001tracklists keeps for that artist (Spotify, Instagram,
 * YouTube, ...). The DJ's own box is the one whose name is the DJ's
 * (sub_sync.artist_name, or the slug: "Lilly Palmer", "lillypalmer" and
 * /artist/lilly-palmer/ all normalise to one key), never a B2B partner's or a
 * venue's; its first YouTube link with a channel id (UC...) is the channel.
 * When the box links two (an artist channel and its VEVO), the first is the
 * artist's own; all of them are kept in `candidates`. Links without a
 * channel id (a /user/ or /@handle URL) are not used. No video uploader is
 * ever taken for the DJ: an upload of a set is usually someone else's.
 * The resolver reads D1 only (set_meta, no 1001tracklists or YouTube call),
 * `RESOLVE_PER_RUN` DJs a run: one never looked at first, then a DJ without
 * a channel hourly, one with a channel daily. A channel once found is kept
 * when a later look finds none (pages purged or not fetched since): only a
 * different channel replaces it.
 *
 * **State.** `dj_youtube_channels` (slug -> channel, or why none) and
 * `youtube_channel_subs` (channel -> subscription, `origin` tracked | owner),
 * migration 0037. Following or unfollowing a DJ changes `subscriptions` only;
 * what to do follows from the three tables (lib/youtube-subs-plan.ts), so the
 * backfill of every DJ followed before this existed is the same run.
 *
 * **A run** (the 5-minute cron, `ytSubsCronStep`): resolve a few DJs, then
 * within one quota gate answer (consumer `yt_subscriptions`, rank 2 by
 * default; settings.quota) and `ytSubs.maxChangesPerRun` (default 10):
 *   1. unsubscribe what tracked made and no followed DJ wants
 *      (subscriptions.delete 50; already gone = done);
 *   2. one subscriptions.list (mine, forChannelId, 1 unit) of the channels to
 *      subscribe: one already subscribed is the owner's (`owner`, never
 *      removed), whatever tracked did before;
 *   3. subscribe the rest (subscriptions.insert 50). 400 subscriptionDuplicate
 *      = the owner's; 404 = channel not found (tried again weekly); a daily
 *      quota reply stops the run (noteQuotaOut); any other failure is tried
 *      again later, MAX_ATTEMPTS times.
 * A run without a YouTube connection records `not_connected`, one whose
 * token is refused `auth`: no connection, or a grant Google refused
 * (invalid_grant), are the only states the pages show in red (the owner
 * reconnects on Settings); a 401 that outlives the retries is tried again. Switched off (`ytSubs.enabled`), nothing on
 * YouTube is touched in either direction.
 */
import type { Env } from "../types";
import { getAppSettings } from "./app-settings";
import { getAccessToken, GoogleOAuthRefreshFailed } from "./google-oauth";
import { errorFields, type Logger } from "./log";
import { quotaGate, type GateRefusal } from "./quota-priority";
import { quotaKind } from "./youtube-error";
import { authedFetch, expectOk, isQuotaError, YouTubeApiError } from "./youtube-playlists";
import { getQuotaOut, noteQuotaOut } from "./youtube-quota";
import { TO_SUBSCRIBE_SQL, TO_UNSUBSCRIBE_SQL } from "./youtube-subs-plan";
import type { InfoBox } from "./set-meta";

const API = "https://www.googleapis.com/youtube/v3";

/** DJs the resolver looks at a run. */
export const RESOLVE_PER_RUN = 10;
/** A DJ without a channel is looked at again after this. */
const RESOLVE_MISSING_SECONDS = 60 * 60;
/** A DJ with a channel is looked at again after this (its box may link another by now). */
const RESOLVE_FOUND_SECONDS = 24 * 60 * 60;
/** Artist boxes of the DJ's newest set pages the resolver reads. */
const RESOLVE_BOXES = 200;
/** Failed subscribes or unsubscribes of one channel before it is left alone. */
export const MAX_ATTEMPTS = 5;
/** A failed change is tried again after this x attempts. */
const RETRY_SECONDS = 60 * 60;
/** A channel YouTube does not know is tried again after this. */
const NOT_FOUND_RETRY_SECONDS = 7 * 24 * 60 * 60;
/** Channels one subscriptions.list may name (YouTube's maxResults). */
const LIST_MAX = 50;
/** Wall-clock ceiling of one run. */
const RUN_DEADLINE_MS = 10_000;
/** CACHE KV: how the last run ended (the pages' "held" / "reconnect" state). */
export const LAST_RUN_KEY = "ytsubs:last_run";
const LAST_RUN_TTL = 6 * 60 * 60;
/** CACHE KV: held while a run works, so two overlapping ticks never subscribe twice. */
const LOCK_KEY = "ytsubs:lock";
const LOCK_TTL = 120;

const nowSeconds = () => Math.floor(Date.now() / 1000);

// -- The DJ's channel ---------------------------------------------------------

/** "Lilly Palmer", "lillypalmer", "lilly-palmer" -> "lillypalmer". */
export function nameKey(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

const CHANNEL_ID_RE = /(?:^|\/)(UC[A-Za-z0-9_-]{22})(?=\/|$)/;

/** The channel id of a YouTube channel link (/channel/UC..., or a bare /UC... path); null for anything else. */
export function channelIdOf(href: string | null | undefined): string | null {
  if (!href) return null;
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (!/^((www|m|music)\.)?youtube\.com$/i.test(u.hostname)) return null;
  return CHANNEL_ID_RE.exec(u.pathname)?.[1] ?? null;
}

/** The artist slug of a box path (/artist/<slug>/tracklists.html). */
const artistSlugOf = (path: string | null | undefined) =>
  /^\/artist\/([^/]+)\//.exec(path ?? "")?.[1] ?? null;

/** Whether `box` is the artist box of the DJ known by `keys` (normalised names). */
export function isOwnBox(box: Partial<InfoBox>, keys: ReadonlySet<string>): boolean {
  if (box.object !== 2) return false;
  const t = nameKey(box.title);
  const p = nameKey(artistSlugOf(box.path));
  return (t !== "" && keys.has(t)) || (p !== "" && keys.has(p));
}

export type ChannelResolution =
  | { channelId: string; candidates: string[]; artistPath: string | null }
  | { channelId: null; reason: "no_set_meta" | "no_artist_box" | "no_youtube_link" };

/**
 * The DJ's channel from the artist boxes of their set pages (newest first):
 * the first own box (isOwnBox) that links a channel. Pure.
 */
export function pickChannel(
  boxes: Array<Partial<InfoBox>>,
  names: Array<string | null | undefined>,
  hadPages: boolean,
): ChannelResolution {
  if (!hadPages) return { channelId: null, reason: "no_set_meta" };
  const keys = new Set(names.map(nameKey).filter((k) => k !== ""));
  let own = false;
  for (const b of boxes) {
    if (!isOwnBox(b, keys)) continue;
    own = true;
    const ids: string[] = [];
    for (const l of b.links ?? []) {
      const id = channelIdOf(l.href);
      if (id && !ids.includes(id)) ids.push(id);
    }
    if (ids.length > 0) return { channelId: ids[0]!, candidates: ids, artistPath: b.path ?? null };
  }
  return { channelId: null, reason: own ? "no_youtube_link" : "no_artist_box" };
}

/** Look up one DJ's channel in D1 and store what was found. Returns the resolution. */
export async function resolveDjChannel(
  env: Env,
  slug: string,
  artistName: string | null,
  nowSec = nowSeconds(),
): Promise<ChannelResolution> {
  const { results } = await env.DB.prepare(
    `SELECT bx.value AS box FROM tracklists t JOIN set_meta m ON m.set_url = t.url, json_each(m.meta, '$.boxes') bx
     WHERE t.slug = ? AND json_extract(bx.value, '$.object') = 2
     ORDER BY m.fetched_at DESC LIMIT ?`,
  )
    .bind(slug, RESOLVE_BOXES)
    .all<{ box: string }>();
  let hadPages = results.length > 0;
  if (!hadPages) {
    const any = await env.DB.prepare(
      "SELECT 1 AS x FROM tracklists t JOIN set_meta m ON m.set_url = t.url WHERE t.slug = ? LIMIT 1",
    )
      .bind(slug)
      .first<{ x: number }>();
    hadPages = !!any;
  }
  const boxes: Array<Partial<InfoBox>> = [];
  for (const r of results) {
    try {
      boxes.push(JSON.parse(r.box) as Partial<InfoBox>);
    } catch {
      // A box that is not JSON is skipped.
    }
  }
  const res = pickChannel(boxes, [artistName, slug], hadPages);
  if (res.channelId !== null) {
    await env.DB.prepare(
      `INSERT INTO dj_youtube_channels (slug, channel_id, candidates, artist_path, reason, checked_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?5)
       ON CONFLICT(slug) DO UPDATE SET
         updated_at = CASE WHEN channel_id IS excluded.channel_id THEN updated_at ELSE excluded.updated_at END,
         channel_id = excluded.channel_id, candidates = excluded.candidates, artist_path = excluded.artist_path,
         reason = NULL, checked_at = excluded.checked_at`,
    )
      .bind(slug, res.channelId, JSON.stringify(res.candidates), res.artistPath, nowSec)
      .run();
  } else {
    // A channel found before stays: only a different channel replaces it (an unfollow is the only way out).
    await env.DB.prepare(
      `INSERT INTO dj_youtube_channels (slug, channel_id, candidates, artist_path, reason, checked_at, updated_at)
       VALUES (?1, NULL, '[]', NULL, ?2, ?3, ?3)
       ON CONFLICT(slug) DO UPDATE SET checked_at = excluded.checked_at,
         reason = CASE WHEN channel_id IS NULL THEN excluded.reason ELSE NULL END`,
    )
      .bind(slug, res.reason, nowSec)
      .run();
  }
  return res;
}

/** Resolve the followed DJs that are due (never looked at first). Returns how many were looked at. */
export async function resolveDue(
  env: Env,
  nowSec = nowSeconds(),
  limit = RESOLVE_PER_RUN,
): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT s.slug AS slug, y.artist_name AS artist_name FROM subscriptions s
     LEFT JOIN sub_sync y ON y.slug = s.slug LEFT JOIN dj_youtube_channels c ON c.slug = s.slug
     WHERE c.slug IS NULL OR c.checked_at <= CASE WHEN c.channel_id IS NULL THEN ?1 ELSE ?2 END
     ORDER BY COALESCE(c.checked_at, 0), s.position LIMIT ?3`,
  )
    .bind(nowSec - RESOLVE_MISSING_SECONDS, nowSec - RESOLVE_FOUND_SECONDS, limit)
    .all<{ slug: string; artist_name: string | null }>();
  for (const r of results) await resolveDjChannel(env, r.slug, r.artist_name, nowSec);
  return results.length;
}

// -- YouTube calls ------------------------------------------------------------

/** subscriptions.list (1 unit): which of `channelIds` the account is subscribed to, channel -> subscription id. */
export async function listSubscribed(
  channelIds: string[],
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (channelIds.length === 0) return out;
  const params = new URLSearchParams({
    part: "id,snippet",
    mine: "true",
    forChannelId: channelIds.slice(0, LIST_MAX).join(","),
    maxResults: String(LIST_MAX),
  });
  const res = await authedFetch(`${API}/subscriptions?${params}`, token, {}, fetcher);
  await expectOk(res, "subscriptions.list");
  const data = (await res.json()) as {
    items?: Array<{ id?: string; snippet?: { resourceId?: { channelId?: string } } }>;
  };
  for (const it of data.items ?? []) {
    const ch = it.snippet?.resourceId?.channelId;
    if (ch && it.id) out.set(ch, it.id);
  }
  return out;
}

/** subscriptions.insert (50 units): the new subscription's id. */
export async function insertSubscription(
  channelId: string,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const res = await authedFetch(
    `${API}/subscriptions?part=snippet`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ snippet: { resourceId: { kind: "youtube#channel", channelId } } }),
    },
    fetcher,
  );
  await expectOk(res, "subscriptions.insert");
  const data = (await res.json()) as { id?: string };
  if (!data.id) throw new YouTubeApiError("subscriptions.insert", 200, null, "no id in the reply");
  return data.id;
}

/** subscriptions.delete (50 units). A 404 is success: the subscription is already gone. */
export async function deleteSubscription(
  subscriptionId: string,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const params = new URLSearchParams({ id: subscriptionId });
  const res = await authedFetch(
    `${API}/subscriptions?${params}`,
    token,
    { method: "DELETE" },
    fetcher,
  );
  if (res.status === 404) return;
  await expectOk(res, "subscriptions.delete");
}

// -- A run --------------------------------------------------------------------

export type YtSubsStop =
  | null
  | "nothing"
  | "run"
  | "deadline"
  | "quota"
  | "rate_limit"
  | "held"
  | "not_connected"
  | "auth"
  | "off";

export type YtSubsLastRun = {
  at: number;
  trigger: string | null;
  subscribed: number;
  unsubscribed: number;
  owner: number;
  failed: number;
  notFound: number;
  stoppedBy: YtSubsStop;
  held?: GateRefusal;
  /** Why the token was refused, for the page (auth). */
  error?: string;
  /** Google refused the stored grant (invalid_grant): only a reconnect on Settings helps. */
  reconnect?: boolean;
};

export type YtSubsRunResult =
  | ({ ok: true; resolved: number; pending: number } & Omit<YtSubsLastRun, "at" | "trigger">)
  | { ok: false; reason: "busy" | "threw" | "youtube_quota_out" };

async function saveLastRun(env: Env, r: YtSubsLastRun): Promise<void> {
  try {
    await env.CACHE.put(LAST_RUN_KEY, JSON.stringify(r), { expirationTtl: LAST_RUN_TTL });
  } catch {
    // The page shows no last run.
  }
}

export async function getLastRun(env: Env): Promise<YtSubsLastRun | null> {
  try {
    return await env.CACHE.get<YtSubsLastRun>(LAST_RUN_KEY, "json");
  } catch {
    return null;
  }
}

type RunOpts = {
  log: Logger;
  trigger?: string;
  fetcher?: typeof fetch;
  deadlineMs?: number;
  nowSec?: number;
};

async function setRow(
  env: Env,
  channelId: string,
  f: {
    origin: "tracked" | "owner" | null;
    state: string;
    subscriptionId?: string | null;
    slug?: string | null;
    error?: string | null;
    nextAt?: number | null;
    failed?: boolean;
  },
  nowSec: number,
): Promise<void> {
  // origin NULL keeps the row's own (a failed change does not say who made it); a new row is tracked's.
  await env.DB.prepare(
    `INSERT INTO youtube_channel_subs (channel_id, origin, state, subscription_id, slug, attempts, error, next_at, at)
     VALUES (?1, COALESCE(?2, 'tracked'), ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(channel_id) DO UPDATE SET origin = COALESCE(?2, origin), state = excluded.state,
       subscription_id = CASE WHEN ?10 THEN excluded.subscription_id ELSE subscription_id END,
       slug = COALESCE(excluded.slug, slug),
       attempts = CASE WHEN ?6 = 1 THEN attempts + 1 ELSE 0 END,
       error = excluded.error, next_at = excluded.next_at, at = excluded.at`,
  )
    .bind(
      channelId,
      f.origin,
      f.state,
      f.subscriptionId ?? null,
      f.slug ?? null,
      f.failed ? 1 : 0,
      f.error ?? null,
      f.nextAt ?? null,
      nowSec,
      f.subscriptionId !== undefined ? 1 : 0,
    )
    .run();
}

async function attemptsOf(env: Env, channelId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT attempts FROM youtube_channel_subs WHERE channel_id = ?")
    .bind(channelId)
    .first<{ attempts: number }>();
  return Number(r?.attempts ?? 0);
}

const errLine = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0]! : String(e));

/** A refused token: the YouTube reply was 401 even after the refresh, or the refresh itself failed. */
const isAuthError = (e: unknown) =>
  (e instanceof YouTubeApiError && e.status === 401) || e instanceof GoogleOAuthRefreshFailed;

/**
 * One run: resolve due DJs, then unsubscribe and subscribe within one gate
 * answer and the per-run cap. Never throws for a YouTube error; a D1 error
 * propagates (ytSubsCronStep catches it).
 */
export async function runYtSubs(env: Env, opts: RunOpts): Promise<YtSubsRunResult> {
  const held = await env.CACHE.get(LOCK_KEY);
  if (held) {
    opts.log.info("ytsubs.busy", { trigger: opts.trigger ?? null });
    return { ok: false, reason: "busy" };
  }
  const lock = crypto.randomUUID();
  await env.CACHE.put(LOCK_KEY, lock, { expirationTtl: LOCK_TTL });
  try {
    return await runLocked(env, opts);
  } finally {
    try {
      if ((await env.CACHE.get(LOCK_KEY)) === lock) await env.CACHE.delete(LOCK_KEY);
    } catch {
      // It expires by itself.
    }
  }
}

async function runLocked(env: Env, opts: RunOpts): Promise<YtSubsRunResult> {
  const { log } = opts;
  const nowSec = opts.nowSec ?? nowSeconds();
  const fetcher = opts.fetcher ?? fetch;
  const settings = await getAppSettings(env);
  const counts = { subscribed: 0, unsubscribed: 0, owner: 0, failed: 0, notFound: 0 };
  const finish = async (
    stoppedBy: YtSubsStop,
    extra: {
      resolved: number;
      pending: number;
      held?: GateRefusal;
      error?: string;
      reconnect?: boolean;
    },
  ): Promise<YtSubsRunResult> => {
    const last: YtSubsLastRun = {
      at: nowSec,
      trigger: opts.trigger ?? null,
      ...counts,
      stoppedBy,
      ...(extra.held ? { held: extra.held } : {}),
      ...(extra.error ? { error: extra.error } : {}),
      ...(extra.reconnect ? { reconnect: true } : {}),
    };
    await saveLastRun(env, last);
    const result = { ok: true as const, ...counts, stoppedBy, ...extra };
    if (stoppedBy !== "nothing" && stoppedBy !== "off")
      log.info("ytsubs.run_done", { trigger: opts.trigger ?? null, ...result });
    return result;
  };
  if (!settings.ytSubs.enabled) return finish("off", { resolved: 0, pending: 0 });

  const resolved = await resolveDue(env, nowSec);
  const { results: unsubs } = await env.DB.prepare(`${TO_UNSUBSCRIBE_SQL} ORDER BY at`)
    .bind(nowSec)
    .all<{ channel_id: string; subscription_id: string; slug: string | null }>();
  const { results: subs } = await env.DB.prepare(`${TO_SUBSCRIBE_SQL} ORDER BY pos`)
    .bind(nowSec)
    .all<{ channel_id: string; slug: string }>();
  const pending = unsubs.length + subs.length;
  const perRun = settings.ytSubs.maxChangesPerRun;
  if (pending === 0 || perRun <= 0) return finish("nothing", { resolved, pending });

  let token: string;
  try {
    const t = await getAccessToken(env, fetcher);
    if (!t) return finish("not_connected", { resolved, pending });
    token = t.accessToken;
  } catch (e) {
    log.warn("ytsubs.token_failed", errorFields(e));
    const reconnect = e instanceof GoogleOAuthRefreshFailed && e.invalidGrant;
    return finish("auth", { resolved, pending, error: errLine(e), reconnect });
  }

  const delOps = Math.min(perRun, unsubs.length);
  const insOps = Math.min(perRun - delOps, subs.length);
  const units = Math.max(50, (delOps + insOps) * 50 + (insOps > 0 ? 1 : 0));
  const gate = await quotaGate(env, "yt_subscriptions", units);
  if (!gate.ok) {
    log.info("ytsubs.quota_gate_held", { reason: gate.reason, units });
    return finish(gate.reason === "pool_out" ? "quota" : "held", {
      resolved,
      pending,
      held: gate.reason,
    });
  }

  const deadline = Date.now() + (opts.deadlineMs ?? RUN_DEADLINE_MS);
  let changes = 0;
  /** Stops the run for a quota or auth reply; null for an error of this one channel. */
  const stopFor = async (e: unknown): Promise<YtSubsStop> => {
    if (isQuotaError(e)) {
      await noteQuotaOut(env, e, log);
      return quotaKind((e as YouTubeApiError).reason) === "quota" ? "quota" : "rate_limit";
    }
    if (isAuthError(e)) return "auth";
    return null;
  };
  const failLater = async (
    channelId: string,
    state: "subscribed" | "failed",
    e: unknown,
    slug: string | null,
  ) => {
    const n = (await attemptsOf(env, channelId)) + 1;
    await setRow(
      env,
      channelId,
      {
        origin: null,
        state,
        slug,
        error: errLine(e),
        nextAt: n >= MAX_ATTEMPTS ? null : nowSec + RETRY_SECONDS * n,
        failed: true,
      },
      nowSec,
    );
    counts.failed++;
  };

  // 1. What tracked made and no followed DJ wants any more.
  for (const u of unsubs) {
    if (changes >= perRun) return finish("run", { resolved, pending: pending - changes });
    if (Date.now() >= deadline) return finish("deadline", { resolved, pending: pending - changes });
    changes++;
    try {
      await deleteSubscription(u.subscription_id, token, fetcher);
      await setRow(
        env,
        u.channel_id,
        { origin: "tracked", state: "unsubscribed", subscriptionId: null },
        nowSec,
      );
      counts.unsubscribed++;
      log.info("ytsubs.unsubscribed", { channelId: u.channel_id, slug: u.slug });
    } catch (e) {
      const stop = await stopFor(e);
      if (stop) {
        log.warn("ytsubs.stopped", { op: "delete", stop, ...errorFields(e) });
        return finish(stop, {
          resolved,
          pending: pending - changes + 1,
          ...(stop === "auth" ? { error: errLine(e) } : {}),
        });
      }
      log.warn("ytsubs.unsubscribe_failed", { channelId: u.channel_id, ...errorFields(e) });
      await failLater(u.channel_id, "subscribed", e, null);
    }
  }

  // 2. Which of the rest the account is subscribed to already: the owner's.
  const batch = subs.slice(0, Math.max(0, perRun - changes));
  if (batch.length === 0)
    return finish(subs.length > 0 ? "run" : null, { resolved, pending: subs.length });
  let have: Map<string, string>;
  try {
    have = await listSubscribed(
      batch.map((s) => s.channel_id),
      token,
      fetcher,
    );
  } catch (e) {
    const stop = (await stopFor(e)) ?? "held";
    log.warn("ytsubs.list_failed", { stop, ...errorFields(e) });
    return finish(stop, {
      resolved,
      pending: pending - changes,
      ...(stop === "auth" ? { error: errLine(e) } : {}),
    });
  }

  // 3. Subscribe.
  for (const s of batch) {
    const existing = have.get(s.channel_id);
    if (existing) {
      await setRow(
        env,
        s.channel_id,
        { origin: "owner", state: "subscribed", subscriptionId: existing, slug: s.slug },
        nowSec,
      );
      counts.owner++;
      log.info("ytsubs.already_subscribed", { channelId: s.channel_id, slug: s.slug });
      continue;
    }
    if (Date.now() >= deadline) return finish("deadline", { resolved, pending: pending - changes });
    changes++;
    try {
      const id = await insertSubscription(s.channel_id, token, fetcher);
      await setRow(
        env,
        s.channel_id,
        { origin: "tracked", state: "subscribed", subscriptionId: id, slug: s.slug },
        nowSec,
      );
      counts.subscribed++;
      log.info("ytsubs.subscribed", { channelId: s.channel_id, slug: s.slug });
    } catch (e) {
      if (e instanceof YouTubeApiError && e.reason === "subscriptionDuplicate") {
        await setRow(
          env,
          s.channel_id,
          { origin: "owner", state: "subscribed", subscriptionId: null, slug: s.slug },
          nowSec,
        );
        counts.owner++;
        continue;
      }
      if (e instanceof YouTubeApiError && e.status === 404) {
        await setRow(
          env,
          s.channel_id,
          {
            origin: null,
            state: "not_found",
            slug: s.slug,
            error: errLine(e),
            nextAt: nowSec + NOT_FOUND_RETRY_SECONDS,
          },
          nowSec,
        );
        counts.notFound++;
        log.warn("ytsubs.channel_not_found", { channelId: s.channel_id, slug: s.slug });
        continue;
      }
      const stop = await stopFor(e);
      if (stop) {
        log.warn("ytsubs.stopped", { op: "insert", stop, ...errorFields(e) });
        return finish(stop, {
          resolved,
          pending: pending - changes + 1,
          ...(stop === "auth" ? { error: errLine(e) } : {}),
        });
      }
      log.warn("ytsubs.subscribe_failed", { channelId: s.channel_id, ...errorFields(e) });
      await failLater(s.channel_id, "failed", e, s.slug);
    }
  }
  const left = Math.max(0, pending - changes - counts.owner);
  return finish(left > 0 ? "run" : null, { resolved, pending: left });
}

/** The cron step: skipped while the whole pool is out. Never throws. */
export async function ytSubsCronStep(
  env: Env,
  log: Logger,
  trigger: string,
  fetcher?: typeof fetch,
): Promise<YtSubsRunResult> {
  try {
    if (await getQuotaOut(env)) return { ok: false, reason: "youtube_quota_out" };
    return await runYtSubs(env, { log, trigger, fetcher });
  } catch (e) {
    log.error("ytsubs.run_threw", errorFields(e));
    return { ok: false, reason: "threw" };
  }
}

// -- What the pages show ------------------------------------------------------

export type YtSubStatus =
  "off" | "looking" | "no_channel" | "pending" | "subscribed" | "owner" | "failed" | "not_found";

/**
 * One DJ's status from the joined rows (yc = dj_youtube_channels, ys =
 * youtube_channel_subs), as SQL for the DJs table. `off` is the page's
 * (the setting), not this.
 */
export const YT_SUB_STATUS_SQL = `CASE
    WHEN yc.slug IS NULL THEN 'looking'
    WHEN yc.channel_id IS NULL THEN 'no_channel'
    WHEN ys.channel_id IS NULL OR ys.state = 'unsubscribed' THEN 'pending'
    WHEN ys.state = 'subscribed' AND ys.origin = 'owner' THEN 'owner'
    WHEN ys.state = 'subscribed' THEN 'subscribed'
    WHEN ys.state = 'failed' AND ys.next_at IS NOT NULL THEN 'pending'
    ELSE ys.state END`;

export type DjYtSub = {
  status: YtSubStatus;
  channelId: string | null;
  channelUrl: string | null;
  /** Every channel the DJ's box links (the first is used). */
  candidates: string[];
  artistPath: string | null;
  /** Why no channel is known. */
  reason: string | null;
  origin: "tracked" | "owner" | null;
  error: string | null;
  attempts: number;
  /** Unix seconds. */
  checkedAt: number | null;
  at: number | null;
};

export const channelUrl = (id: string | null) =>
  id ? `https://www.youtube.com/channel/${encodeURIComponent(id)}` : null;

/** One DJ's subscription state for the DJ page. */
export async function djYtSub(env: Env, slug: string): Promise<DjYtSub> {
  const enabled = (await getAppSettings(env)).ytSubs.enabled;
  const r = await env.DB.prepare(
    `SELECT ${YT_SUB_STATUS_SQL} AS status, yc.channel_id AS channel_id, yc.candidates AS candidates,
       yc.artist_path AS artist_path, yc.reason AS reason, yc.checked_at AS checked_at,
       ys.origin AS origin, ys.error AS error, ys.attempts AS attempts, ys.at AS at
     FROM (SELECT ? AS slug) q LEFT JOIN dj_youtube_channels yc ON yc.slug = q.slug
       LEFT JOIN youtube_channel_subs ys ON ys.channel_id = yc.channel_id`,
  )
    .bind(slug)
    .first<{
      status: YtSubStatus;
      channel_id: string | null;
      candidates: string | null;
      artist_path: string | null;
      reason: string | null;
      checked_at: number | null;
      origin: "tracked" | "owner" | null;
      error: string | null;
      attempts: number | null;
      at: number | null;
    }>();
  let candidates: string[] = [];
  try {
    const c = JSON.parse(r?.candidates ?? "[]") as unknown;
    if (Array.isArray(c)) candidates = c.filter((x): x is string => typeof x === "string");
  } catch {
    // None shown.
  }
  const status = r?.status ?? "looking";
  return {
    // Off: what tracked made or found stays as it is, nothing new is done.
    status: !enabled && (status === "pending" || status === "looking") ? "off" : status,
    channelId: r?.channel_id ?? null,
    channelUrl: channelUrl(r?.channel_id ?? null),
    candidates,
    artistPath: r?.artist_path ?? null,
    reason: r?.reason ?? null,
    origin: r?.origin ?? null,
    error: r?.error ?? null,
    attempts: Number(r?.attempts ?? 0),
    checkedAt: r?.checked_at == null ? null : Number(r.checked_at),
    at: r?.at == null ? null : Number(r.at),
  };
}

/** The feature's state for the DJs pages: the setting and how the last run ended. */
export async function ytSubsSummary(
  env: Env,
): Promise<{ enabled: boolean; lastRun: YtSubsLastRun | null; needsReconnect: boolean }> {
  const enabled = (await getAppSettings(env)).ytSubs.enabled;
  const lastRun = await getLastRun(env);
  // A 401 that outlived the refresh and retries is most often Google's flake (it clears by itself); only no
  // connection at all, or a grant Google refused, needs the owner.
  const needsReconnect =
    enabled &&
    (lastRun?.stoppedBy === "not_connected" ||
      (lastRun?.stoppedBy === "auth" && lastRun.reconnect === true));
  return { enabled, lastRun, needsReconnect };
}
