/**
 * Per-video facts from the YouTube Data API, cached in D1 (`video_meta`):
 * duration (contentDetails), orientation (player embed size, requested with
 * `maxWidth` so YouTube scales it to the video's aspect ratio), liveness
 * (status, or the id missing from the answer) and the uploader channel
 * (snippet). One `videos.list` call per 50 ids, 1 quota unit each, whatever
 * the parts. A playlist listing also names each item's channel
 * (`snippet.videoOwnerChannelId`), which `saveVideoChannels` stores without a
 * lookup.
 *
 * Called with the owner's OAuth token, so the owner's own private uploads
 * (mkvid renders YouTube forced private) come back as alive; somebody else's
 * private or deleted video is simply absent, which is what "dead" means here.
 */

import type { Env } from "../types";
import { batchChunked, dbOf } from "./db";
import { authedFetch, expectOk, parseIsoDuration } from "./youtube-playlists";

const API = "https://www.googleapis.com/youtube/v3";
/** Width asked for; only the ratio of the answer matters. */
const EMBED_MAX_WIDTH = 1280;
/** Duration and orientation never change; re-read once a month anyway. */
export const VIDEO_META_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export type VideoMeta = {
  videoId: string;
  durationSeconds: number | null;
  embedWidth: number | null;
  embedHeight: number | null;
  privacy: string | null;
  uploadStatus: string | null;
  alive: boolean;
  fetchedAt: number;
  /** Uploader channel (snippet.channelId / channelTitle); null when unknown. */
  channelId?: string | null;
  channelTitle?: string | null;
  /** The row came from a lookup that asked for the snippet (false: an older row, or one written from a listing). */
  channelChecked?: boolean;
};

type ApiItem = {
  id?: string;
  contentDetails?: { duration?: string };
  player?: { embedWidth?: string | number; embedHeight?: string | number };
  status?: { privacyStatus?: string; uploadStatus?: string };
  snippet?: { channelId?: string; channelTitle?: string };
};

const num = (x: unknown): number | null => {
  const n = typeof x === "string" ? Number(x) : typeof x === "number" ? x : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Upload states that mean the video will never play. */
const DEAD_UPLOAD = /^(deleted|failed|rejected)$/;

/** One or more videos.list calls. Ids the API does not echo back come out as `alive: false`. */
export async function fetchVideoMeta(
  videoIds: string[],
  accessToken: string,
  fetcher: typeof fetch = fetch,
  now = Math.floor(Date.now() / 1000),
): Promise<Map<string, VideoMeta>> {
  const out = new Map<string, VideoMeta>();
  const ids = [...new Set(videoIds)];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const params = new URLSearchParams({
      part: "contentDetails,player,status,snippet",
      id: chunk.join(","),
      maxResults: "50",
      maxWidth: String(EMBED_MAX_WIDTH),
    });
    const res = await authedFetch(`${API}/videos?${params}`, accessToken, {}, fetcher);
    await expectOk(res, "videos.list");
    const data = (await res.json()) as { items?: ApiItem[] };
    for (const it of data.items ?? []) {
      if (!it.id) continue;
      const uploadStatus = it.status?.uploadStatus ?? null;
      out.set(it.id, {
        videoId: it.id,
        durationSeconds: parseIsoDuration(it.contentDetails?.duration),
        embedWidth: num(it.player?.embedWidth),
        embedHeight: num(it.player?.embedHeight),
        privacy: it.status?.privacyStatus ?? null,
        uploadStatus,
        alive: !(uploadStatus && DEAD_UPLOAD.test(uploadStatus)),
        fetchedAt: now,
        channelId: it.snippet?.channelId || null,
        channelTitle: it.snippet?.channelTitle || null,
        channelChecked: true,
      });
    }
    for (const id of chunk) {
      if (!out.has(id)) {
        out.set(id, {
          videoId: id,
          durationSeconds: null,
          embedWidth: null,
          embedHeight: null,
          privacy: null,
          uploadStatus: null,
          alive: false,
          fetchedAt: now,
          channelId: null,
          channelTitle: null,
          channelChecked: true,
        });
      }
    }
  }
  return out;
}

type Row = {
  video_id: string;
  duration_seconds: number | null;
  embed_width: number | null;
  embed_height: number | null;
  privacy: string | null;
  upload_status: string | null;
  alive: number;
  fetched_at: number;
  channel_id?: string | null;
  channel_title?: string | null;
  channel_checked?: number | null;
};

const fromRow = (r: Row): VideoMeta => ({
  videoId: r.video_id,
  durationSeconds: r.duration_seconds === null ? null : Number(r.duration_seconds),
  embedWidth: r.embed_width === null ? null : Number(r.embed_width),
  embedHeight: r.embed_height === null ? null : Number(r.embed_height),
  privacy: r.privacy,
  uploadStatus: r.upload_status,
  alive: Number(r.alive) === 1,
  fetchedAt: Number(r.fetched_at),
  channelId: r.channel_id ?? null,
  channelTitle: r.channel_title ?? null,
  channelChecked: Number(r.channel_checked ?? 0) === 1,
});

/** Cached rows for `videoIds` (any age). */
export async function readCachedVideoMeta(
  env: Env,
  videoIds: string[],
): Promise<Map<string, VideoMeta>> {
  const out = new Map<string, VideoMeta>();
  const ids = [...new Set(videoIds)];
  const db = dbOf(env);
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const res = await db
      .prepare(`SELECT * FROM video_meta WHERE video_id IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .all<Row>();
    for (const r of res.results) out.set(r.video_id, fromRow(r));
  }
  return out;
}

export async function saveVideoMeta(env: Env, metas: Iterable<VideoMeta>): Promise<void> {
  const db = dbOf(env);
  const stmts = [...metas].map((m) =>
    db
      .prepare(
        // A dead video's answer has no snippet: the channel already known is kept.
        `INSERT INTO video_meta (video_id, duration_seconds, embed_width, embed_height, privacy, upload_status, alive, fetched_at,
           channel_id, channel_title, channel_checked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(video_id) DO UPDATE SET duration_seconds = excluded.duration_seconds, embed_width = excluded.embed_width,
           embed_height = excluded.embed_height, privacy = excluded.privacy, upload_status = excluded.upload_status,
           alive = excluded.alive, fetched_at = excluded.fetched_at,
           channel_id = COALESCE(excluded.channel_id, video_meta.channel_id),
           channel_title = COALESCE(excluded.channel_title, video_meta.channel_title),
           channel_checked = MAX(excluded.channel_checked, video_meta.channel_checked)`,
      )
      .bind(
        m.videoId,
        m.durationSeconds,
        m.embedWidth,
        m.embedHeight,
        m.privacy,
        m.uploadStatus,
        m.alive ? 1 : 0,
        m.fetchedAt,
        m.channelId ?? null,
        m.channelTitle ?? null,
        m.channelChecked ? 1 : 0,
      ),
  );
  await batchChunked(db, stmts);
}

export type VideoChannel = {
  videoId: string;
  channelId: string | null;
  channelTitle: string | null;
};

/**
 * Store uploader channels seen without a lookup (a playlist listing's
 * snippet.videoOwnerChannelId/Title). Only the channel columns are written; a
 * video with no row gets one with `fetched_at = 0` and nothing else known, so
 * any reader that needs its duration or orientation still looks it up. An
 * entry without a channel id is skipped, and a row that already says the same
 * is not written again.
 */
export async function saveVideoChannels(env: Env, list: Iterable<VideoChannel>): Promise<void> {
  const db = dbOf(env);
  const want = new Map<string, VideoChannel>();
  for (const c of list) if (c.videoId && c.channelId) want.set(c.videoId, c);
  if (want.size === 0) return;
  const have = await channelsOf(env, [...want.keys()]);
  const stmts: D1PreparedStatement[] = [];
  for (const c of want.values()) {
    const h = have.get(c.videoId);
    if (h && h.channelId === c.channelId && (h.channelTitle === c.channelTitle || !c.channelTitle))
      continue;
    stmts.push(
      db
        .prepare(
          `INSERT INTO video_meta (video_id, alive, fetched_at, channel_id, channel_title) VALUES (?, 1, 0, ?, ?)
           ON CONFLICT(video_id) DO UPDATE SET channel_id = excluded.channel_id,
             channel_title = COALESCE(excluded.channel_title, video_meta.channel_title)`,
        )
        .bind(c.videoId, c.channelId, c.channelTitle ?? null),
    );
  }
  await batchChunked(db, stmts);
}

/** Uploader channel per video id, from `video_meta` (only ids whose channel is known). */
export async function channelsOf(
  env: Env,
  videoIds: string[],
): Promise<Map<string, { channelId: string; channelTitle: string | null }>> {
  const out = new Map<string, { channelId: string; channelTitle: string | null }>();
  const ids = [...new Set(videoIds.filter(Boolean))];
  const db = dbOf(env);
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const res = await db
      .prepare(
        `SELECT video_id, channel_id, channel_title FROM video_meta WHERE channel_id IS NOT NULL AND video_id IN (${chunk.map(() => "?").join(",")})`,
      )
      .bind(...chunk)
      .all<{ video_id: string; channel_id: string; channel_title: string | null }>();
    for (const r of res.results)
      out.set(r.video_id, { channelId: r.channel_id, channelTitle: r.channel_title });
  }
  return out;
}

/**
 * Meta for every id: from the cache when younger than `maxAgeSeconds`,
 * otherwise from the API (and written back). `maxAgeSeconds: 0` forces a
 * fresh read - the liveness check wants that. Dead entries are re-read after
 * a day even under the default age, so a video that was only briefly
 * unavailable is not written off for a month. An alive row without its
 * uploader channel, from before the snippet was asked for, counts as stale
 * once: the next lookup fills it (the playlist listings fill most first).
 */
export async function getVideoMeta(
  env: Env,
  videoIds: string[],
  accessToken: string,
  opts: { maxAgeSeconds?: number; fetcher?: typeof fetch; now?: number } = {},
): Promise<Map<string, VideoMeta>> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const maxAge = opts.maxAgeSeconds ?? VIDEO_META_MAX_AGE_SECONDS;
  const ids = [...new Set(videoIds.filter(Boolean))];
  const cached = maxAge > 0 ? await readCachedVideoMeta(env, ids) : new Map<string, VideoMeta>();
  const out = new Map<string, VideoMeta>();
  const stale: string[] = [];
  for (const id of ids) {
    const c = cached.get(id);
    const age = c ? now - c.fetchedAt : Infinity;
    const noChannel = !!c && c.alive && !c.channelId && !c.channelChecked;
    if (c && age < maxAge && (c.alive || age < 24 * 60 * 60) && !noChannel) out.set(id, c);
    else stale.push(id);
  }
  if (stale.length > 0) {
    const fetched = await fetchVideoMeta(stale, accessToken, opts.fetcher, now);
    await saveVideoMeta(env, fetched.values());
    // The answer for a dead video names no channel; the one stored before is still its uploader.
    const known = await channelsOf(
      env,
      [...fetched.values()].filter((m) => !m.channelId).map((m) => m.videoId),
    );
    for (const [id, m] of fetched) {
      const k = known.get(id);
      out.set(id, k ? { ...m, channelId: k.channelId, channelTitle: k.channelTitle } : m);
    }
  }
  return out;
}
