/**
 * Channel bans (migrations/0022, docs/superpowers/specs/2026-10-14-bad-videos-design.md).
 *
 * When the owner removes a video from a managed playlist (found by the
 * 6-hourly comparison, reason `owner`) or uses Remove & replace (`button`),
 * the video's uploader channel gets a pending question: ban this channel? It
 * is asked, never decided here:
 *
 *   - Ban       the sync never picks the channel's videos again
 *               (lib/playlist-hygiene.ts judgeVideo, reason `banned_channel`),
 *               and the sweep takes the ones already in the playlists out.
 *   - Not banned  recorded (`declined`); asked again only after a further
 *               removal from that channel, with the strike count.
 *   - Lift ban  back to `lifted`, which behaves like `declined`.
 *
 * A strike is one distinct video of the channel the owner removed (owner or
 * button; a dead video or the sweep's own removal never counts). Strikes also
 * steer the sync's choice between a page's players even for channels that
 * were never banned (`channelStrikes`).
 *
 * Only depends on D1, the video cache and Web Push, so lib/playlist-hygiene.ts
 * can import it without a cycle.
 */

import type { Env } from "../types";
import { batchChunked, dbOf } from "./db";
import { errorFields, type Logger } from "./log";
import { getVideoMeta } from "./video-meta";
import { pushConfigured, sendPushToAll, youtubeThumbnail, type PushPayload } from "./web-push";

export type BanState = "pending" | "banned" | "declined" | "lifted";

export type ChannelBanRow = {
  channel_id: string;
  channel_title: string | null;
  state: BanState;
  strikes: number;
  last_video_id: string | null;
  last_playlist_id: string | null;
  last_slug: string | null;
  last_set_url: string | null;
  last_removal_at: number | null;
  asked_at: number | null;
  decided_at: number | null;
  notified: number;
};

const nowSeconds = () => Math.floor(Date.now() / 1000);
const DAY = 24 * 60 * 60;
/** Removal reasons that are the owner's own judgement of a video. */
const OWNER_REASONS = "('owner', 'button')";
/** A removed video looked up for its channel and not found is not looked up again for this long. */
export const CHANNEL_LOOKUP_RETRY_SECONDS = 7 * DAY;
/** videos.list takes 50 ids per unit: the queue looks up at most this many past removals per run. */
const LOOKUP_MAX = 50;

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",");

/** Channels the owner banned. A missing table (migration not applied) reads as none. */
export async function bannedChannelIds(env: Env): Promise<Set<string>> {
  try {
    const res = await dbOf(env)
      .prepare("SELECT channel_id FROM channel_bans WHERE state = 'banned'")
      .all<{ channel_id: string }>();
    return new Set(res.results.map((r) => r.channel_id));
  } catch {
    return new Set();
  }
}

/** Strikes per channel: distinct videos of it the owner removed. Channels with none are absent. Never throws. */
export async function channelStrikes(env: Env, channelIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = [...new Set(channelIds.filter(Boolean))];
  try {
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      const res = await dbOf(env)
        .prepare(
          `SELECT channel_id, COUNT(DISTINCT video_id) AS n FROM removed_videos
           WHERE reason IN ${OWNER_REASONS} AND channel_id IN (${placeholders(chunk.length)}) GROUP BY channel_id`,
        )
        .bind(...chunk)
        .all<{ channel_id: string; n: number }>();
      for (const r of res.results) out.set(r.channel_id, Number(r.n));
    }
  } catch {
    /* no channel column yet: no strikes */
  }
  return out;
}

/** Copy known channels from `video_meta` onto removals that lack one. */
async function fillRemovalChannels(env: Env): Promise<number> {
  const r = await dbOf(env)
    .prepare(
      `UPDATE removed_videos SET
         channel_id = (SELECT m.channel_id FROM video_meta m WHERE m.video_id = removed_videos.video_id),
         channel_title = (SELECT m.channel_title FROM video_meta m WHERE m.video_id = removed_videos.video_id)
       WHERE channel_id IS NULL AND EXISTS (
         SELECT 1 FROM video_meta m WHERE m.video_id = removed_videos.video_id AND m.channel_id IS NOT NULL)`,
    )
    .run();
  return r.meta.changes ?? 0;
}

/** The owner's removals whose channel is unknown and that were not looked up lately. */
async function removalsToLookUp(env: Env, now: number): Promise<string[]> {
  const res = await dbOf(env)
    .prepare(
      `SELECT DISTINCT r.video_id FROM removed_videos r LEFT JOIN video_meta m ON m.video_id = r.video_id
       WHERE r.channel_id IS NULL AND r.reason IN ${OWNER_REASONS}
         AND (m.video_id IS NULL OR (m.channel_id IS NULL AND (m.channel_checked = 0 OR m.fetched_at < ?)))
       LIMIT ${LOOKUP_MAX}`,
    )
    .bind(now - CHANNEL_LOOKUP_RETRY_SECONDS)
    .all<{ video_id: string }>();
  return res.results.map((r) => r.video_id);
}

type NoteRow = {
  playlist_id: string;
  video_id: string;
  slug: string | null;
  set_url: string | null;
  at: number;
  channel_id: string;
  channel_title: string | null;
};

export type BanQueueResult = {
  /** Removals that got their channel this run. */
  filled: number;
  /** Removed videos looked up on YouTube for their channel. */
  lookedUp: number;
  /** Questions opened (new, or asked again after Not banned / Lift ban). */
  asked: number;
  /** Open questions that got a further strike. */
  updated: number;
  /** A push was sent (true), not delivered (false), or not needed / not possible (null). */
  notified: boolean | null;
};

/** Tells the owner about open questions; resolves false when no device took it (tried again next run). */
export type BanNotifier = (payload: PushPayload) => Promise<boolean>;

/**
 * Turn the owner's new removals into ban questions, and push the ones not yet
 * pushed. Run after every comparison and after Remove & replace. Idempotent:
 * each removal is looked at once (`removed_videos.ban_noted`).
 *
 *   1. Removals get their channel from `video_meta`; with a token, up to 50
 *      removals whose channel is still unknown are looked up (1 unit), unless
 *      they were looked up in the last 7 days (a dead video names none).
 *   2. Per channel with new removals: banned -> nothing; pending -> strikes and
 *      newest removal updated; no question yet, or Not banned / lifted before
 *      the newest removal -> a pending question. A removal of mkvid's own
 *      render never asks (that channel is the owner's).
 *   3. Questions never pushed are pushed together, once a device takes it.
 */
export async function processBanQueue(
  env: Env,
  opts: {
    log: Logger;
    accessToken?: string;
    fetcher?: typeof fetch;
    notify?: BanNotifier;
    now?: number;
  },
): Promise<BanQueueResult> {
  const { log } = opts;
  const now = opts.now ?? nowSeconds();
  const db = dbOf(env);
  const out: BanQueueResult = { filled: 0, lookedUp: 0, asked: 0, updated: 0, notified: null };

  out.filled = await fillRemovalChannels(env);
  if (opts.accessToken) {
    const ids = await removalsToLookUp(env, now);
    if (ids.length > 0) {
      try {
        await getVideoMeta(env, ids, opts.accessToken, {
          maxAgeSeconds: 0,
          fetcher: opts.fetcher,
          now,
        });
        out.lookedUp = ids.length;
        out.filled += await fillRemovalChannels(env);
      } catch (e) {
        log.warn("bans.lookup_failed", { count: ids.length, ...errorFields(e) });
      }
    }
  }

  const rows = (
    await db
      .prepare(
        `SELECT playlist_id, video_id, slug, set_url, at, channel_id, channel_title, reason FROM removed_videos
         WHERE ban_noted = 0 AND channel_id IS NOT NULL ORDER BY at, video_id`,
      )
      .all<NoteRow & { reason: string }>()
  ).results;
  if (rows.length > 0) {
    const mkvidOwn = new Set(
      (
        await db
          .prepare("SELECT video_id FROM mkvid_requests WHERE video_id IS NOT NULL")
          .all<{ video_id: string }>()
      ).results.map((r) => r.video_id),
    );
    const byChannel = new Map<string, NoteRow[]>();
    for (const r of rows) {
      if (r.reason !== "owner" && r.reason !== "button") continue;
      if (mkvidOwn.has(r.video_id)) continue;
      byChannel.set(r.channel_id, [...(byChannel.get(r.channel_id) ?? []), r]);
    }
    const strikes = await channelStrikes(env, [...byChannel.keys()]);
    const stmts: D1PreparedStatement[] = [];
    for (const [channelId, list] of byChannel) {
      const newest = list[list.length - 1]!;
      const prev = await db
        .prepare("SELECT * FROM channel_bans WHERE channel_id = ?")
        .bind(channelId)
        .first<ChannelBanRow>();
      const n = strikes.get(channelId) ?? list.length;
      const title = newest.channel_title ?? prev?.channel_title ?? null;
      if (prev?.state === "banned") continue;
      if (prev?.state === "pending") {
        stmts.push(
          db
            .prepare(
              `UPDATE channel_bans SET strikes = ?, channel_title = ?, last_video_id = ?, last_playlist_id = ?, last_slug = ?,
                 last_set_url = ?, last_removal_at = ? WHERE channel_id = ? AND state = 'pending'`,
            )
            .bind(
              n,
              title,
              newest.video_id,
              newest.playlist_id,
              newest.slug,
              newest.set_url,
              newest.at,
              channelId,
            ),
        );
        out.updated++;
        continue;
      }
      // Not banned or lifted: only a removal made after that answer asks again.
      if (prev && newest.at <= (prev.decided_at ?? 0)) continue;
      stmts.push(
        db
          .prepare(
            `INSERT INTO channel_bans (channel_id, channel_title, state, strikes, last_video_id, last_playlist_id, last_slug,
               last_set_url, last_removal_at, asked_at, decided_at, notified)
             VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, NULL, 0)
             ON CONFLICT(channel_id) DO UPDATE SET channel_title = excluded.channel_title, state = 'pending',
               strikes = excluded.strikes, last_video_id = excluded.last_video_id, last_playlist_id = excluded.last_playlist_id,
               last_slug = excluded.last_slug, last_set_url = excluded.last_set_url, last_removal_at = excluded.last_removal_at,
               asked_at = excluded.asked_at, notified = 0`,
          )
          .bind(
            channelId,
            title,
            n,
            newest.video_id,
            newest.playlist_id,
            newest.slug,
            newest.set_url,
            newest.at,
            now,
          ),
      );
      out.asked++;
      log.info("bans.asked", { channelId, title, strikes: n, videoId: newest.video_id });
    }
    // Every row read here has been looked at, asked about or not (dead, mkvid, already banned).
    for (const r of rows)
      stmts.push(
        db
          .prepare(
            "UPDATE removed_videos SET ban_noted = 1 WHERE playlist_id = ? AND video_id = ? AND ban_noted = 0",
          )
          .bind(r.playlist_id, r.video_id),
      );
    await batchChunked(db, stmts);
  }

  const unpushed = (
    await db
      .prepare(
        "SELECT * FROM channel_bans WHERE state = 'pending' AND notified = 0 ORDER BY asked_at, channel_id",
      )
      .all<ChannelBanRow>()
  ).results;
  if (unpushed.length > 0 && opts.notify) {
    try {
      out.notified = await opts.notify(channelBanPayload(unpushed, new Date(now * 1000)));
    } catch (e) {
      out.notified = false;
      log.warn("bans.notify_failed", errorFields(e));
    }
    if (out.notified)
      await batchChunked(
        db,
        unpushed.map((u) =>
          db
            .prepare(
              "UPDATE channel_bans SET notified = 1 WHERE channel_id = ? AND state = 'pending' AND asked_at = ?",
            )
            .bind(u.channel_id, u.asked_at),
        ),
      );
  }
  if (out.asked || out.updated || out.filled || out.lookedUp) log.info("bans.queue", { ...out });
  return out;
}

/** The cron's notifier: a Web Push to every subscribed device; false when push is not set up or no device took it. */
export function channelBanNotifier(env: Env, log?: Logger, fetchImpl?: typeof fetch): BanNotifier {
  return async (payload) => {
    if (!pushConfigured(env)) return false;
    const r = await sendPushToAll(env, payload, log, fetchImpl ?? fetch);
    return r.sent > 0;
  };
}

const strikeText = (n: number) => `${n} video${n === 1 ? "" : "s"} removed`;

/** One push for every open question not pushed yet. Opens the Bans tab. */
export function channelBanPayload(
  pending: Array<Pick<ChannelBanRow, "channel_id" | "channel_title" | "strikes" | "last_video_id">>,
  now: Date = new Date(),
): PushPayload {
  const first = pending[0]!;
  const name = first.channel_title || first.channel_id;
  const one = pending.length === 1;
  return {
    kind: "channel_ban",
    title: one ? `Ban ${name}?` : `Ban ${pending.length} channels?`,
    body: one
      ? `You removed a video by ${name} (${strikeText(first.strikes)} so far). Ban the channel, or keep it?`
      : pending
          .slice(0, 5)
          .map((p) => `${p.channel_title || p.channel_id} (${strikeText(p.strikes)})`)
          .join(", ") + (pending.length > 5 ? `, and ${pending.length - 5} more` : ""),
    url: "/ui/bans",
    tag: "channel-ban",
    ts: now.toISOString(),
    ...(first.last_video_id ? { icon: youtubeThumbnail(first.last_video_id) } : {}),
  };
}

// --- the Bans tab -----------------------------------------------------------

export type ChannelVideo = {
  videoId: string;
  slug: string | null;
  setUrl: string | null;
  playlistId: string | null;
};

export type BanQuestion = {
  channelId: string;
  channelTitle: string | null;
  state: BanState;
  strikes: number;
  askedAt: number | null;
  decidedAt: number | null;
  lastVideoId: string | null;
  lastSlug: string | null;
  lastSetUrl: string | null;
  lastRemovalAt: number | null;
  /** Videos of the channel the owner removed (newest first). */
  removed: Array<{ videoId: string; slug: string | null; setUrl: string | null; at: number }>;
  /** Videos of the channel tracked has in the managed playlists now. */
  inPlaylists: ChannelVideo[];
};

const OTHERS_MAX = 50;

async function channelVideosInPlaylists(env: Env, channelId: string): Promise<ChannelVideo[]> {
  const res = await dbOf(env)
    .prepare(
      `SELECT t.video_id, t.slug, t.url, s.playlist_id FROM tracklists t
       JOIN video_meta m ON m.video_id = t.video_id
       LEFT JOIN sub_sync s ON s.slug = t.slug
       WHERE m.channel_id = ? AND t.processed = 1 ORDER BY t.slug, t.position LIMIT ${OTHERS_MAX}`,
    )
    .bind(channelId)
    .all<{ video_id: string; slug: string; url: string; playlist_id: string | null }>();
  return res.results.map((r) => ({
    videoId: r.video_id,
    slug: r.slug,
    setUrl: r.url,
    playlistId: r.playlist_id,
  }));
}

async function removedOfChannel(env: Env, channelId: string): Promise<BanQuestion["removed"]> {
  const res = await dbOf(env)
    .prepare(
      `SELECT video_id, MAX(slug) AS slug, MAX(set_url) AS set_url, MAX(at) AS at FROM removed_videos
       WHERE channel_id = ? AND reason IN ${OWNER_REASONS} GROUP BY video_id ORDER BY at DESC LIMIT ${OTHERS_MAX}`,
    )
    .bind(channelId)
    .all<{ video_id: string; slug: string | null; set_url: string | null; at: number }>();
  return res.results.map((r) => ({
    videoId: r.video_id,
    slug: r.slug,
    setUrl: r.set_url,
    at: Number(r.at),
  }));
}

/** Everything the Bans tab shows: open questions first (oldest first), then every decided channel (newest decision first). */
export async function listBanQueue(
  env: Env,
): Promise<{ pending: BanQuestion[]; decided: BanQuestion[] }> {
  const rows = (
    await dbOf(env)
      .prepare(
        `SELECT * FROM channel_bans ORDER BY CASE state WHEN 'pending' THEN 0 ELSE 1 END,
           CASE state WHEN 'pending' THEN asked_at ELSE -COALESCE(decided_at, 0) END, channel_id LIMIT 500`,
      )
      .all<ChannelBanRow>()
  ).results;
  const strikes = await channelStrikes(
    env,
    rows.map((r) => r.channel_id),
  );
  const pending: BanQuestion[] = [];
  const decided: BanQuestion[] = [];
  for (const r of rows) {
    const q: BanQuestion = {
      channelId: r.channel_id,
      channelTitle: r.channel_title,
      state: r.state,
      strikes: strikes.get(r.channel_id) ?? Number(r.strikes),
      askedAt: r.asked_at,
      decidedAt: r.decided_at,
      lastVideoId: r.last_video_id,
      lastSlug: r.last_slug,
      lastSetUrl: r.last_set_url,
      lastRemovalAt: r.last_removal_at,
      removed: await removedOfChannel(env, r.channel_id),
      inPlaylists: await channelVideosInPlaylists(env, r.channel_id),
    };
    (r.state === "pending" ? pending : decided).push(q);
  }
  return { pending, decided };
}

export async function pendingBanCount(env: Env): Promise<number> {
  try {
    const r = await dbOf(env)
      .prepare("SELECT COUNT(*) AS n FROM channel_bans WHERE state = 'pending'")
      .first<{ n: number }>();
    return Number(r?.n ?? 0);
  } catch {
    return 0;
  }
}

export type BanAction = "ban" | "decline" | "lift";

export type DecideResult =
  { ok: true; state: BanState } | { ok: false; error: "not_found" | "invalid_state" };

/** Which states each answer may be given from. Banning again is a no-op success. */
const ALLOWED: Record<BanAction, BanState[]> = {
  ban: ["pending", "declined", "lifted", "banned"],
  decline: ["pending"],
  lift: ["banned"],
};
const TO: Record<BanAction, BanState> = { ban: "banned", decline: "declined", lift: "lifted" };

/** The owner's answer to a question (or a lift of an earlier ban). */
export async function decideBan(
  env: Env,
  channelId: string,
  action: BanAction,
  now = nowSeconds(),
): Promise<DecideResult> {
  const db = dbOf(env);
  const row = await db
    .prepare("SELECT state FROM channel_bans WHERE channel_id = ?")
    .bind(channelId)
    .first<{ state: BanState }>();
  if (!row) return { ok: false, error: "not_found" };
  if (!ALLOWED[action].includes(row.state)) return { ok: false, error: "invalid_state" };
  if (action === "ban" && row.state === "banned") return { ok: true, state: "banned" };
  const n = (await channelStrikes(env, [channelId])).get(channelId);
  await db
    .prepare(
      "UPDATE channel_bans SET state = ?, decided_at = ?, strikes = COALESCE(?, strikes) WHERE channel_id = ? AND state = ?",
    )
    .bind(TO[action], now, n ?? null, channelId, row.state)
    .run();
  return { ok: true, state: TO[action] };
}
