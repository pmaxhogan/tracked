/**
 * Playlist hygiene (spec decisions 21-24): what the sync is allowed to add,
 * what it takes back out, and what it learns from the owner's own edits.
 *
 *  1. **Vetting** (`pickSetVideo`, called by lib/sync.ts where a set page is
 *     parsed): the page's YouTube video only counts when it is a full
 *     recording (lib/full-recording.ts), is alive, and was not removed from
 *     the artist playlist before. Otherwise the set is treated as having no
 *     video, which is what makes it eligible for mkvid. Every page fetch also
 *     stores the page's facts (`set_media_facts`) for the sweep.
 *  2. **Sweep** (`runRemovalSweep`): every video the sync has added is judged
 *     by the same rule from stored facts + cached video meta; rejected ones
 *     are removed from the artist and combined playlists, paced by a daily
 *     delete budget, logged in `playlist_removals`. Dry run by default
 *     (`PLAYLIST_SWEEP_DRY_RUN` unset = true): the first production run only
 *     reports.
 *  3. **Comparison** (`comparePlaylists`, every 6 hours): each managed
 *     playlist is listed in full and compared with what the sync added. A
 *     video that is gone was removed by the owner (or died): it is never
 *     re-added there, and its set becomes due for a recheck, which queues it
 *     for mkvid. A partial or failed listing is never read as removals, and a
 *     playlist that seems to have lost more than 30% is held and reported.
 *     The same listing shows the videos that are still in a playlist but
 *     gone from YouTube (deleted, or made private by their uploader). Those
 *     are taken out of it once they have stayed dead for three days
 *     (`judgeDeadVideos`, `deleteDeadVideos`), whoever put them there, under
 *     the sweep's dry-run setting and daily delete budget.
 *  4. **Remove and replace** (`removeAndReplace`): the per-set button.
 *
 * Everything here talks to YouTube only; none of it fetches 1001tracklists.
 */

import type { Env } from "../types";
import { dbOf, batchChunked } from "./db";
import { errorFields, type Logger } from "./log";
import { getQuotaOut, noteQuotaOut } from "./youtube-quota";
import {
  decideFullRecording,
  hasNoFullRecordingNotice,
  maxAudioSeconds,
  REJECT_REASON_LABELS,
  type RejectReason,
} from "./full-recording";
import type { TableDef } from "./table-query";
import {
  channelsOf,
  getVideoMeta,
  readCachedVideoMeta,
  saveVideoChannels,
  type VideoChannel,
  type VideoMeta,
} from "./video-meta";
import {
  bannedChannelIds,
  channelStrikes,
  processBanQueue,
  type BanNotifier,
  type BanQueueResult,
} from "./channel-bans";
import {
  blockedIds,
  isBlocked,
  isOverridden,
  overriddenIds,
  playlistMembers,
  confirmedMembership,
  markInPlaylist,
  markOutOfPlaylist,
  recordRemoved,
  savePlaylistMembers,
  setOverride,
  unblock,
} from "./playlist-blocklist";
import {
  addVideoToPlaylist,
  deletePlaylistItem,
  isQuotaError,
  isUnavailableItem,
  listPlaylistItems,
  removeVideoFromPlaylist,
  type RawPlaylistItem,
} from "./youtube-playlists";
import {
  cachePlaylistVideoIds,
  invalidatePlaylistVideoIds,
  peekCachedPlaylistVideoIds,
} from "./playlist-cache";
import { insertInOrder } from "./playlist-order-store";
import { loadCombinedState } from "./combined-playlist";
import { getAccessToken } from "./google-oauth";
import { parseCueValueData } from "./tracklists1001";
import { parseSetYouTubeId } from "./dj-index";
import { pushConfigured, sendPushToAll, type PushPayload } from "./web-push";
import { getAppSettings, type AppSettings } from "./app-settings";
import { errorOneLine } from "./youtube-error";
import {
  enqueueMkvidRequest,
  extractSetAudioSource,
  extractSetDate,
  extractSetTitle,
  getMkvidRequestForSet,
  retryMkvidRequest,
  supersedeMkvidRequestForSet,
  type MkvidSourceKind,
} from "./mkvid";

const nowSeconds = () => Math.floor(Date.now() / 1000);
const DAY = 24 * 60 * 60;

// --- settings ---------------------------------------------------------------

export const DEFAULT_SWEEP_DAILY_REMOVALS = 40;
/** Comparison cadence (decision 24). */
export const COMPARE_INTERVAL_SECONDS = 6 * 60 * 60;
/** The sweep re-evaluates on the same cadence; its deletes are budgeted per UTC day. */
export const SWEEP_INTERVAL_SECONDS = 6 * 60 * 60;
/** Page cap for one playlist listing: 200 pages = 10 000 items, far above any real playlist. */
const LIST_MAX_PAGES = 200;

export type SweepSettings = { dryRun: boolean; dailyRemovals: number };

/**
 * `PLAYLIST_SWEEP_DRY_RUN` is TRUE unless explicitly set to 0/false/no/off -
 * the opposite default of every other flag in this repo, on purpose: the
 * first production sweep only reports. `PLAYLIST_SWEEP_DAILY_REMOVALS`
 * (default 40) caps playlistItems.delete calls per UTC day (50 units each).
 */
export function sweepSettings(
  env: Pick<Env, "PLAYLIST_SWEEP_DRY_RUN" | "PLAYLIST_SWEEP_DAILY_REMOVALS">,
  app?: AppSettings,
): SweepSettings {
  const fromEnv = sweepSettingsFromEnv(env);
  if (!app) return fromEnv;
  return {
    dryRun: app.playlists.sweepDryRun ?? fromEnv.dryRun,
    dailyRemovals: app.playlists.sweepDailyRemovals ?? fromEnv.dailyRemovals,
  };
}

function sweepSettingsFromEnv(
  env: Pick<Env, "PLAYLIST_SWEEP_DRY_RUN" | "PLAYLIST_SWEEP_DAILY_REMOVALS">,
): SweepSettings {
  const dryRun = !/^\s*(0|false|no|off)\s*$/i.test(env.PLAYLIST_SWEEP_DRY_RUN ?? "");
  const n = Number(env.PLAYLIST_SWEEP_DAILY_REMOVALS);
  const dailyRemovals =
    env.PLAYLIST_SWEEP_DAILY_REMOVALS !== undefined &&
    env.PLAYLIST_SWEEP_DAILY_REMOVALS !== "" &&
    Number.isFinite(n) &&
    n >= 0
      ? Math.floor(n)
      : DEFAULT_SWEEP_DAILY_REMOVALS;
  return { dryRun, dailyRemovals };
}

// --- set facts --------------------------------------------------------------

export type SetFacts = {
  setUrl: string;
  slug: string;
  videoId: string | null;
  noFullNotice: boolean;
  lastCueSeconds: number | null;
  audioMaxSeconds: number | null;
  audioKind: MkvidSourceKind | null;
  audioUrl: string | null;
  setTitle: string | null;
  setDate: string | null;
  trackCount: number | null;
  idedCount: number | null;
  fetchedAt: number;
};

/** Everything the rule needs from one set page, read from HTML the sync already has. */
export function extractSetFacts(
  slug: string,
  setUrl: string,
  html: string,
  videoId: string | null,
  now = nowSeconds(),
): SetFacts {
  // Read with the light helpers, not parseTracklist: this runs on every page
  // fetch and needs only the cue map and the row flags.
  let cue: number | null = null;
  for (const s of parseCueValueData(html).values()) if (cue === null || s > cue) cue = s;
  let trackCount = 0;
  let idedCount = 0;
  TRACK_ROW_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TRACK_ROW_RE.exec(html))) {
    trackCount++;
    if (m[1] === "true") idedCount++;
  }
  const source = extractSetAudioSource(html, cue);
  return {
    setUrl,
    slug,
    videoId,
    noFullNotice: hasNoFullRecordingNotice(html),
    lastCueSeconds: cue,
    audioMaxSeconds: maxAudioSeconds(html),
    audioKind: source?.kind ?? null,
    audioUrl: source?.url ?? null,
    setTitle: extractSetTitle(html),
    setDate: extractSetDate(setUrl, html),
    trackCount: trackCount || null,
    idedCount: trackCount ? idedCount : null,
    fetchedAt: now,
  };
}

/** A tracklist row: `<div ... class="tlpTog bItm tlpItem trRow1" data-trno="0" data-id="..." data-isided="true"`. */
const TRACK_ROW_RE = /class="[^"]*\btlpItem\b[^"]*"[^>]*?\bdata-isided="(true|false)"/g;

/**
 * Page facts for a set page fetched OUTSIDE the sync (phone, the tracklist
 * viewer, a purge refetch - lib/tracklist-resolve.ts). The sync's own fetches
 * (new, recheck, verification) store them through pickSetVideo. The facts are
 * real even on a decoy page (only names are randomized), so this runs before
 * any decoy refusal. `slug` is the DJ the set is synced under, else the one
 * already on record, else '' until a sync fetch fills it. Never throws.
 */
export async function recordPageFacts(
  env: Env,
  setUrl: string,
  html: string,
  log?: Logger,
): Promise<void> {
  if (!/\/tracklist\/[^/]+\//.test(setUrl)) return;
  try {
    const db = dbOf(env);
    const tl = await db
      .prepare("SELECT MIN(slug) AS slug FROM tracklists WHERE url = ?")
      .bind(setUrl)
      .first<{ slug: string | null }>();
    const prev = tl?.slug
      ? null
      : await db
          .prepare("SELECT slug FROM set_media_facts WHERE set_url = ?")
          .bind(setUrl)
          .first<{ slug: string }>();
    await saveSetFacts(
      env,
      extractSetFacts(tl?.slug ?? prev?.slug ?? "", setUrl, html, parseSetYouTubeId(html)),
    );
  } catch (e) {
    log?.warn("hygiene.page_facts_failed", { setUrl, ...errorFields(e) });
  }
}

export async function saveSetFacts(env: Env, f: SetFacts): Promise<void> {
  await dbOf(env)
    .prepare(
      `INSERT INTO set_media_facts (set_url, slug, video_id, no_full_notice, last_cue_seconds, audio_max_seconds, audio_kind, audio_url, set_title, set_date, last_cue_known, track_count, ided_count, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(set_url) DO UPDATE SET slug = excluded.slug, video_id = excluded.video_id, no_full_notice = excluded.no_full_notice,
         last_cue_seconds = excluded.last_cue_seconds, audio_max_seconds = excluded.audio_max_seconds, audio_kind = excluded.audio_kind,
         audio_url = excluded.audio_url, set_title = excluded.set_title, set_date = excluded.set_date, last_cue_known = excluded.last_cue_known,
         track_count = excluded.track_count, ided_count = excluded.ided_count, fetched_at = excluded.fetched_at`,
    )
    .bind(
      f.setUrl,
      f.slug,
      f.videoId,
      f.noFullNotice ? 1 : 0,
      f.lastCueSeconds,
      f.audioMaxSeconds,
      f.audioKind,
      f.audioUrl,
      f.setTitle,
      f.setDate,
      f.lastCueSeconds === null ? 0 : 1,
      f.trackCount,
      f.idedCount,
      f.fetchedAt,
    )
    .run();
}

type FactsRow = {
  set_url: string;
  slug: string;
  video_id: string | null;
  no_full_notice: number;
  last_cue_seconds: number | null;
  audio_max_seconds: number | null;
  audio_kind: string | null;
  audio_url: string | null;
  set_title: string | null;
  set_date: string | null;
  track_count: number | null;
  ided_count: number | null;
  fetched_at: number;
};

const factsFromRow = (r: FactsRow): SetFacts => ({
  setUrl: r.set_url,
  slug: r.slug,
  videoId: r.video_id,
  noFullNotice: Number(r.no_full_notice) === 1,
  lastCueSeconds: r.last_cue_seconds === null ? null : Number(r.last_cue_seconds),
  audioMaxSeconds: r.audio_max_seconds === null ? null : Number(r.audio_max_seconds),
  audioKind: (r.audio_kind as MkvidSourceKind | null) ?? null,
  audioUrl: r.audio_url,
  setTitle: r.set_title,
  setDate: r.set_date,
  trackCount: r.track_count === null ? null : Number(r.track_count),
  idedCount: r.ided_count === null ? null : Number(r.ided_count),
  fetchedAt: Number(r.fetched_at),
});

export async function loadSetFacts(env: Env, setUrls: string[]): Promise<Map<string, SetFacts>> {
  const out = new Map<string, SetFacts>();
  const urls = [...new Set(setUrls)];
  const db = dbOf(env);
  for (let i = 0; i < urls.length; i += 90) {
    const chunk = urls.slice(i, i + 90);
    const res = await db
      .prepare(`SELECT * FROM set_media_facts WHERE set_url IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .all<FactsRow>();
    for (const r of res.results) out.set(r.set_url, factsFromRow(r));
  }
  return out;
}

// --- the rule, applied ------------------------------------------------------

export type VideoVerdict =
  { ok: true } | { ok: false; reason: RejectReason | "dead" | "banned_channel"; detail: string };

/**
 * `REJECT_VERTICAL` (default ON since 2026-10-14): the vertical rule (d) reads
 * videos.list embed sizes. Verified live that day: Shorts come back
 * 1280x2276 (9:16), 16:9 videos 1280x720, and portrait phone recordings of
 * whole sets 1280x2276 too; oEmbed answers 200x113 for all of them, so it is
 * no signal. Only an explicit 0/false/no/off turns the rule off; the app
 * setting `playlists.rejectVertical`, when not null, wins over the env.
 */
export function rejectVerticalEnabled(
  env: Pick<Env, "REJECT_VERTICAL">,
  app?: AppSettings,
): boolean {
  if (app && app.playlists.rejectVertical !== null) return app.playlists.rejectVertical;
  return !/^\s*(0|false|no|off)\s*$/i.test(env.REJECT_VERTICAL ?? "");
}

export type JudgeOptions = {
  rejectVertical?: boolean;
  shortToleranceSeconds?: number;
  audioToleranceSeconds?: number;
  /** Channels the owner banned (lib/channel-bans.ts): their videos are never kept. */
  bannedChannels?: ReadonlySet<string>;
};

/** judgeVideo's options from the app settings (playlists.rejectVertical, the two tolerances), REJECT_VERTICAL and the banned channels. */
export async function judgeOptions(env: Env): Promise<JudgeOptions> {
  const app = await getAppSettings(env);
  return {
    rejectVertical: rejectVerticalEnabled(env, app),
    shortToleranceSeconds: app.playlists.shortToleranceMinutes * 60,
    audioToleranceSeconds: app.playlists.audioToleranceMinutes * 60,
    bannedChannels: await bannedChannelIds(env),
  };
}

/** The rule for one video, from whatever is known: facts may be missing, meta may be missing. */
export function judgeVideo(
  facts: SetFacts | null | undefined,
  meta: VideoMeta | null | undefined,
  opts: JudgeOptions = {},
): VideoVerdict {
  if (meta && !meta.alive)
    return { ok: false, reason: "dead", detail: "videos.list: deleted or private" };
  if (meta?.channelId && opts.bannedChannels?.has(meta.channelId))
    return {
      ok: false,
      reason: "banned_channel",
      detail: `uploaded by ${meta.channelTitle ?? meta.channelId}, a channel you banned`,
    };
  const d = decideFullRecording({
    notice: facts ? facts.noFullNotice : null,
    lastCueSeconds: facts?.lastCueSeconds ?? null,
    audioMaxSeconds: facts?.audioMaxSeconds ?? null,
    videoSeconds: meta?.durationSeconds ?? null,
    embedWidth: meta?.embedWidth ?? null,
    embedHeight: meta?.embedHeight ?? null,
    rejectVertical: opts.rejectVertical === true,
    shortToleranceSeconds: opts.shortToleranceSeconds,
    audioToleranceSeconds: opts.audioToleranceSeconds,
  });
  return d.ok ? d : { ok: false, reason: d.reason, detail: d.detail };
}

export const REASON_LABELS: Record<string, string> = {
  ...REJECT_REASON_LABELS,
  dead: "video deleted or private",
  blocked: "removed from this playlist before",
  owner: "removed from the playlist by the owner",
  button: '"remove and replace" on the set',
  banned_channel: "uploaded by a channel you banned",
  struck_channel: "uploaded by a channel you removed videos of before",
};

export type PickRejectReason =
  RejectReason | "dead" | "blocked" | "banned_channel" | "struck_channel";

export type SetVideoPick = {
  /** The video the sync may use for this set; null = treat the set as having none. */
  videoId: string | null;
  /** Set when the page's primary video was turned down (or passed over for another of its players). */
  rejected: { videoId: string; reason: PickRejectReason; detail: string } | null;
};

type Candidate = {
  videoId: string;
  /** Position on the page (0 = the primary video). */
  index: number;
  verdict: { ok: true } | { ok: false; reason: PickRejectReason; detail: string };
  /** The owner's "keep it" (video_overrides): passes every rule and every strike. */
  kept: boolean;
  channelId: string | null;
  channelTitle: string | null;
  strikes: number;
};

/**
 * Pure: which candidate a set gets. Passing candidates of channels without
 * strikes come first, in page order; when only struck channels pass, the one
 * with the fewest strikes wins, then page order. A video the owner kept counts
 * as passing with no strikes.
 */
export function chooseCandidate(candidates: Candidate[]): Candidate | null {
  const passing = candidates.filter((c) => c.verdict.ok);
  if (passing.length === 0) return null;
  const strikesOf = (c: Candidate) => (c.kept ? 0 : c.strikes);
  return [...passing].sort((a, b) => strikesOf(a) - strikesOf(b) || a.index - b.index)[0]!;
}

/**
 * The sync's gate, called right after it parses a set page. Stores the page's
 * facts, then vets the page's videos: the primary one and, when the page has
 * more than one player (`candidates`, lib/dj-index.ts parseSetYouTubeIds),
 * the others, all with one videos.list call. The set gets the first one that
 * passes every rule from a channel the owner never removed a video of; a
 * channel with strikes is used only when nothing else passes
 * (`chooseCandidate`). Never throws: a failure to look the videos up means
 * the rules needing duration/orientation/channel are skipped (the sweep
 * re-judges later with the meta it gets then).
 */
export async function pickSetVideo(
  env: Env,
  ctx: {
    slug: string;
    setUrl: string;
    /** The fetched page; null = judge from the facts an earlier fetch of this set stored (an insert that waited for quota, lib/sync.ts). */
    html: string | null;
    rawVideoId: string | null;
    playlistId: string | null;
    accessToken: string;
    log: Logger;
    fetcher?: typeof fetch;
    /** YouTube is not asked (its quota is out): the video's cached record is used, if there is one. */
    noLookup?: boolean;
    /** Every player on the page (parseSetYouTubeIds), primary first; absent = only `rawVideoId`. */
    candidates?: string[];
  },
): Promise<SetVideoPick> {
  const { log } = ctx;
  let facts: SetFacts | null = null;
  try {
    if (ctx.html === null) facts = (await loadSetFacts(env, [ctx.setUrl])).get(ctx.setUrl) ?? null;
    else {
      facts = extractSetFacts(ctx.slug, ctx.setUrl, ctx.html, ctx.rawVideoId);
      await saveSetFacts(env, facts);
    }
  } catch (e) {
    log.warn("hygiene.facts_failed", { slug: ctx.slug, setUrl: ctx.setUrl, ...errorFields(e) });
  }
  const ids = [
    ...new Set([ctx.rawVideoId, ...(ctx.candidates ?? [])].filter((x): x is string => !!x)),
  ];
  if (ids.length === 0) return { videoId: null, rejected: null };
  const where = { slug: ctx.slug, setUrl: ctx.setUrl };
  const cands: Candidate[] = ids.map((videoId, index) => ({
    videoId,
    index,
    verdict: { ok: true },
    kept: false,
    channelId: null,
    channelTitle: null,
    strikes: 0,
  }));
  const reject = (c: Candidate, reason: PickRejectReason, detail: string) => {
    c.verdict = { ok: false, reason, detail };
  };
  try {
    const blocked = ctx.playlistId ? await blockedIds(env, ctx.playlistId) : new Set<string>();
    const kept = await overriddenIds(env);
    for (const c of cands) {
      if (blocked.has(c.videoId)) {
        log.info("hygiene.video_blocked", { ...where, videoId: c.videoId });
        reject(c, "blocked", REASON_LABELS.blocked!);
      } else if (kept.has(c.videoId)) c.kept = true;
    }
  } catch (e) {
    log.warn("hygiene.blocklist_failed", { ...where, videoId: ids[0], ...errorFields(e) });
  }
  // The primary video the owner kept is used as it is, as before (no lookup).
  if (cands[0]!.kept) return { videoId: cands[0]!.videoId, rejected: null };
  const toJudge = cands.filter((c) => c.verdict.ok && !c.kept);
  let metas = new Map<string, VideoMeta>();
  let lookupFailed = false;
  try {
    const want = toJudge.map((c) => c.videoId);
    if (want.length > 0)
      metas =
        (ctx.noLookup
          ? await readCachedVideoMeta(env, want)
          : await getVideoMeta(env, want, ctx.accessToken, { fetcher: ctx.fetcher })) ??
        new Map<string, VideoMeta>();
  } catch (e) {
    lookupFailed = true;
    log.warn("hygiene.video_meta_failed", { ...where, videoId: ids[0], ...errorFields(e) });
  }
  if (lookupFailed) {
    // m6: without a lookup the duration rules cannot run. A video the sweep
    // already took out is not put back on that basis (it would come out again).
    for (const c of toJudge) {
      const swept = await dbOf(env)
        .prepare(
          "SELECT 1 AS x FROM playlist_removals WHERE video_id = ? AND source = 'sweep' AND status = 'removed' LIMIT 1",
        )
        .bind(c.videoId)
        .first<{ x: number }>()
        .catch(() => null);
      if (swept) reject(c, "blocked", "the sweep removed it before; video lookup failed");
    }
  }
  const opts = await judgeOptions(env);
  for (const c of toJudge) {
    if (!c.verdict.ok) continue;
    const meta = metas.get(c.videoId) ?? null;
    c.channelId = meta?.channelId ?? null;
    c.channelTitle = meta?.channelTitle ?? null;
    const v = judgeVideo(facts, meta, opts);
    if (!v.ok) {
      log.info("hygiene.video_rejected", {
        ...where,
        videoId: c.videoId,
        reason: v.reason,
        detail: v.detail,
      });
      reject(c, v.reason, v.detail);
    }
  }
  const strikes = await channelStrikes(
    env,
    cands.filter((c) => c.verdict.ok && c.channelId).map((c) => c.channelId!),
  );
  for (const c of cands) if (c.channelId) c.strikes = strikes.get(c.channelId) ?? 0;
  const pick = chooseCandidate(cands);
  const primary = cands[0]!;
  if (pick && pick.strikes > 0 && !pick.kept)
    log.info("hygiene.video_struck_used", {
      ...where,
      videoId: pick.videoId,
      channelId: pick.channelId,
      strikes: pick.strikes,
    });
  if (pick === primary) return { videoId: primary.videoId, rejected: null };
  // The primary was turned down, or passed over for a player from a channel with fewer strikes.
  const pv = primary.verdict;
  const rejected: NonNullable<SetVideoPick["rejected"]> = pv.ok
    ? {
        videoId: primary.videoId,
        reason: "struck_channel",
        detail: `${primary.channelTitle ?? primary.channelId}: ${primary.strikes} video(s) removed before`,
      }
    : { videoId: primary.videoId, reason: pv.reason, detail: pv.detail };
  if (pick)
    log.info("hygiene.video_alternate", {
      ...where,
      videoId: pick.videoId,
      instead: primary.videoId,
      reason: rejected.reason,
    });
  return { videoId: pick?.videoId ?? null, rejected };
}

/** Audit-row note for a rejected page video. */
export function rejectionNote(r: NonNullable<SetVideoPick["rejected"]>): string {
  return `not added: ${r.videoId} ${REASON_LABELS[r.reason] ?? r.reason} (${r.detail})`;
}

/**
 * For the mkvid eligibility check (W7): does this set have a usable YouTube
 * video? False when it has none, the one it has was removed from its artist
 * playlist (owner, dead, button), or cached facts/meta show it is not a full
 * recording. D1 only - no network - so it can sit on any hot path.
 */
export async function hasGoodVideo(
  env: Env,
  set: { slug: string; setUrl: string; videoId: string | null },
): Promise<boolean> {
  if (!set.videoId) return false;
  if (await isOverridden(env, set.videoId)) return true;
  const pl = await dbOf(env)
    .prepare("SELECT playlist_id FROM sub_sync WHERE slug = ?")
    .bind(set.slug)
    .first<{ playlist_id: string | null }>();
  if (pl?.playlist_id && (await isBlocked(env, pl.playlist_id, set.videoId))) return false;
  const facts = (await loadSetFacts(env, [set.setUrl])).get(set.setUrl);
  const meta = (await readCachedVideoMeta(env, [set.videoId])).get(set.videoId);
  return judgeVideo(facts, meta, await judgeOptions(env)).ok;
}

// --- removal log ------------------------------------------------------------

export type RemovalSource = "sweep" | "owner" | "dead" | "button";
export type RemovalStatus = "would_remove" | "removed" | "failed" | "undone" | "recorded";

export type RemovalRow = {
  id: number;
  at: number;
  source: RemovalSource;
  status: RemovalStatus;
  slug: string | null;
  set_url: string | null;
  video_id: string;
  playlist_id: string;
  playlist_kind: "artist" | "combined";
  reason: string;
  detail: string | null;
};

async function logRemoval(
  env: Env,
  r: Omit<RemovalRow, "id" | "at"> & { at?: number },
): Promise<void> {
  await dbOf(env)
    .prepare(
      `INSERT INTO playlist_removals (at, source, status, slug, set_url, video_id, playlist_id, playlist_kind, reason, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, video_id, playlist_id) DO UPDATE SET at = excluded.at, status = excluded.status, slug = excluded.slug,
         set_url = excluded.set_url, playlist_kind = excluded.playlist_kind, reason = excluded.reason, detail = excluded.detail`,
    )
    .bind(
      r.at ?? nowSeconds(),
      r.source,
      r.status,
      r.slug,
      r.set_url,
      r.video_id,
      r.playlist_id,
      r.playlist_kind,
      r.reason,
      r.detail,
    )
    .run();
}

/**
 * The Removed videos table (GET /ui/api/removals, the data-table contract in
 * lib/table-query.ts): every row of `playlist_removals`, newest first by default.
 * `at` is stored in unix seconds; filters on it take unix ms like every datetime.
 */
export const REMOVALS_TABLE: TableDef<RemovalRow> = {
  from: "playlist_removals",
  primaryKey: "id",
  defaultSort: "-at",
  columns: {
    id: { type: "number", filterable: false },
    at: { type: "datetime", storage: "s" },
    source: { type: "enum", options: ["sweep", "owner", "dead", "button"] },
    status: { type: "enum", options: ["would_remove", "removed", "recorded", "failed", "undone"] },
    slug: { type: "text", searchable: true },
    set_url: { type: "text", searchable: true },
    video_id: { type: "text", searchable: true },
    playlist_kind: { type: "enum", options: ["artist", "combined"] },
    playlist_id: { type: "text", sortable: false },
    reason: { type: "enum" },
    detail: { type: "text", sortable: false, searchable: true },
  },
  // A failed removal's detail is the stored YouTube error: shown as one readable line.
  mapRow: (r) =>
    r.status === "failed" && r.detail ? { ...r, detail: errorOneLine(r.detail, r.status) } : r,
};

/** DJs that have at least one removal (the DJ filter's options), by slug. */
export async function removalDjs(env: Env): Promise<string[]> {
  const res = await dbOf(env)
    .prepare(
      "SELECT DISTINCT slug FROM playlist_removals WHERE slug IS NOT NULL ORDER BY slug LIMIT 500",
    )
    .all<{ slug: string }>();
  return res.results.map((r) => r.slug);
}

export async function removalCounts(env: Env): Promise<Record<string, number>> {
  const res = await dbOf(env)
    .prepare("SELECT status, COUNT(*) AS n FROM playlist_removals GROUP BY status")
    .all<{ status: string; n: number }>();
  return Object.fromEntries(res.results.map((r) => [r.status, Number(r.n)]));
}

/** Null a set's video (keeping the baseline known) and make it due now: the next recheck sees "no video" and queues mkvid. */
function clearSetVideoStmt(
  db: D1Database,
  slug: string,
  videoId: string,
  setUrl?: string | null,
): D1PreparedStatement {
  return setUrl
    ? db
        .prepare(
          "UPDATE tracklists SET video_id = NULL, video_source = NULL, video_known = 1, checked_at = 0 WHERE slug = ? AND url = ? AND video_id = ?",
        )
        .bind(slug, setUrl, videoId)
    : db
        .prepare(
          "UPDATE tracklists SET video_id = NULL, video_source = NULL, video_known = 1, checked_at = 0 WHERE slug = ? AND video_id = ?",
        )
        .bind(slug, videoId);
}

// --- mkvid's own videos -----------------------------------------------------

/**
 * Videos W7's "delete and recreate" replaced and took out of the playlists
 * itself (table `mkvid_old_videos`, migration 0009, keyed by `video_id`). Their
 * absence is not an owner removal. Guarded: the table may not exist yet.
 */
export async function mkvidReplacedIds(env: Env, log?: Logger): Promise<Set<string>> {
  try {
    const res = await dbOf(env)
      .prepare("SELECT video_id FROM mkvid_old_videos")
      .all<{ video_id: string }>();
    return new Set(res.results.map((r) => r.video_id).filter(Boolean));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/no such table/i.test(msg))
      log?.warn("hygiene.mkvid_old_videos_unreadable", errorFields(e));
    return new Set();
  }
}

/** Every video mkvid uploaded (current, superseded or replaced): full renders by construction, never swept. */
export async function mkvidUploadedIds(env: Env, log?: Logger): Promise<Set<string>> {
  const res = await dbOf(env)
    .prepare("SELECT video_id FROM mkvid_requests WHERE video_id IS NOT NULL")
    .all<{ video_id: string }>();
  const out = new Set(res.results.map((r) => r.video_id));
  for (const id of await mkvidReplacedIds(env, log)) out.add(id);
  return out;
}

// --- sweep ------------------------------------------------------------------

const SWEEP_DELETES_PREFIX = "hygiene:sweep:deletes:";
const dayKey = (nowMs: number) => new Date(nowMs).toISOString().slice(0, 10);

export async function sweepDeletesUsed(env: Env, nowMs = Date.now()): Promise<number> {
  const raw = await env.CACHE.get(SWEEP_DELETES_PREFIX + dayKey(nowMs));
  const n = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function writeSweepDeletes(env: Env, value: number, nowMs: number): Promise<void> {
  await env.CACHE.put(
    SWEEP_DELETES_PREFIX + dayKey(nowMs),
    String(Math.max(0, Math.floor(value))),
    { expirationTtl: 2 * DAY },
  );
}

/**
 * Count `n` more deletes and return the day's new count. `known` is what the
 * caller already knows the count to be (its own earlier writes, or the pass
 * before it in the same tick): a KV read may lag a write made seconds ago, so
 * the count is never written lower than that plus `n`.
 */
async function bumpSweepDeletes(
  env: Env,
  n: number,
  nowMs = Date.now(),
  known = 0,
): Promise<number> {
  const used = Math.max(await sweepDeletesUsed(env, nowMs), known);
  if (n <= 0) return used;
  await writeSweepDeletes(env, used + n, nowMs);
  return used + n;
}

export type SweepResult = {
  dryRun: boolean;
  candidates: number;
  judged: number;
  rejected: number;
  /** Dry run: rejected videos logged as would_remove. */
  reported: number;
  removedVideos: number;
  deletes: number;
  failed: number;
  budget: number;
  budgetLeft: number;
  stoppedBy: "budget" | "quota" | null;
  metaFailed: boolean;
  /** Rejected for one set, but another accepted set of the DJ uses the same video: kept, nothing deleted. */
  keptShared: number;
  /** Videos in the combined playlist that no set resolves to, judged by the rules that need no set page (`sweepCombinedOrphans`). */
  orphans?: number;
};

type AddedRow = { slug: string; url: string; video_id: string; playlist_id: string | null };

type SweepOpts = {
  log: Logger;
  settings?: SweepSettings;
  fetcher?: typeof fetch;
  nowMs?: number;
  /** Deletes the comparison of this same tick knows the day stands at (its dead videos): KV may not show them yet. */
  usedAtLeast?: number;
};

/**
 * Judge every video the sync has put in an artist playlist (tracklists rows
 * with a 1001tl video; mkvid's own renders are not judged - they are the
 * replacement) and remove the rejected ones, or in a dry run only log them.
 * Then the combined playlist's orphans (`sweepCombinedOrphans`), on what is
 * left of the same budget.
 */
export async function runRemovalSweep(
  env: Env,
  accessToken: string,
  opts: SweepOpts,
): Promise<SweepResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const settings = opts.settings ?? sweepSettings(env, await getAppSettings(env));
  const usedStart = Math.max(await sweepDeletesUsed(env, nowMs), opts.usedAtLeast ?? 0);
  const r = await sweepTrackedVideos(env, accessToken, { ...opts, settings, nowMs });
  if (r.stoppedBy) return r;
  try {
    const o = await sweepCombinedOrphans(env, accessToken, {
      log: opts.log,
      settings,
      fetcher: opts.fetcher,
      nowMs,
      known: usedStart + r.deletes,
      budgetLeft: r.budgetLeft,
    });
    r.orphans = o.judged;
    r.rejected += o.rejected;
    r.reported += o.reported;
    r.removedVideos += o.removed;
    r.deletes += o.deletes;
    r.failed += o.failed;
    r.budgetLeft = o.budgetLeft;
    r.stoppedBy = o.stoppedBy;
  } catch (e) {
    opts.log.warn("hygiene.sweep.orphans_failed", errorFields(e));
  }
  return r;
}

/**
 * Videos in the combined playlist that no set resolves to any more (in its
 * last complete listing, `playlist_members`): an owner removal from the
 * artist playlist only (removals are per playlist), or a sweep removal whose
 * combined delete failed after the artist one cleared the set. Nothing else
 * ever looks at them again. With no set page, only the rules that need none
 * apply: vertical, and a banned uploader channel (a dead one is the
 * comparison's). Never mkvid's own renders or a video the owner kept. Same
 * rails as the sweep: dry run, daily budget, logged as `sweep` rows of the
 * combined playlist (undo puts the video back).
 */
async function sweepCombinedOrphans(
  env: Env,
  accessToken: string,
  o: {
    log: Logger;
    settings: SweepSettings;
    fetcher?: typeof fetch;
    nowMs: number;
    known: number;
    budgetLeft: number;
  },
): Promise<{
  judged: number;
  rejected: number;
  reported: number;
  removed: number;
  deletes: number;
  failed: number;
  budgetLeft: number;
  stoppedBy: "budget" | "quota" | null;
}> {
  const out = {
    judged: 0,
    rejected: 0,
    reported: 0,
    removed: 0,
    deletes: 0,
    failed: 0,
    budgetLeft: o.budgetLeft,
    stoppedBy: null as "budget" | "quota" | null,
  };
  const combinedId = (await loadCombinedState(env)).playlistId ?? null;
  if (!combinedId) return out;
  const referenced = new Set(
    (
      await dbOf(env)
        .prepare("SELECT DISTINCT video_id FROM tracklists WHERE video_id IS NOT NULL")
        .all<{ video_id: string }>()
    ).results.map((r) => r.video_id),
  );
  const kept = await overriddenIds(env);
  const mkvidOwn = await mkvidUploadedIds(env, o.log);
  // Taken out by tracked since that listing ('out'): not judged again before the next listing drops it.
  const membership = await confirmedMembership(env, combinedId);
  const orphans = [...(await playlistMembers(env, combinedId))]
    .filter(
      (id) =>
        !referenced.has(id) && !kept.has(id) && !mkvidOwn.has(id) && membership.get(id) !== "out",
    )
    .sort();
  if (orphans.length === 0) return out;
  let metas: Map<string, VideoMeta>;
  try {
    metas = await getVideoMeta(env, orphans, accessToken, {
      fetcher: o.fetcher,
      now: Math.floor(o.nowMs / 1000),
    });
  } catch (e) {
    o.log.warn("hygiene.sweep.orphans_meta_failed", { count: orphans.length, ...errorFields(e) });
    if (isQuotaError(e)) {
      await noteQuotaOut(env, e, o.log);
      return { ...out, stoppedBy: "quota" };
    }
    metas = await readCachedVideoMeta(env, orphans);
  }
  const judgeOpts = await judgeOptions(env);
  const rejected: Array<{ videoId: string; reason: string; detail: string }> = [];
  for (const id of orphans) {
    out.judged++;
    const v = judgeVideo(null, metas.get(id), judgeOpts);
    if (!v.ok && v.reason !== "dead") rejected.push({ videoId: id, ...v });
  }
  out.rejected = rejected.length;
  const row = (r: (typeof rejected)[number], status: RemovalStatus, detail: string) =>
    logRemoval(env, {
      source: "sweep",
      status,
      slug: null,
      set_url: null,
      video_id: r.videoId,
      playlist_id: combinedId,
      playlist_kind: "combined",
      reason: r.reason,
      detail,
    });
  const note = (r: (typeof rejected)[number]) => `${r.detail}; in the combined playlist only`;
  if (o.settings.dryRun) {
    for (const r of rejected) await row(r, "would_remove", note(r));
    out.reported = rejected.length;
    if (rejected.length) o.log.info("hygiene.sweep.orphans_dry_run", { ...out });
    return out;
  }
  let known = o.known;
  let touched = false;
  for (const r of rejected) {
    if (out.budgetLeft < 1) {
      out.stoppedBy = "budget";
      break;
    }
    try {
      const n = await removeVideoFromPlaylist(combinedId, r.videoId, accessToken, o.fetcher);
      out.deletes += n;
      out.budgetLeft -= n;
      known = await bumpSweepDeletes(env, n, o.nowMs, known);
      touched = true;
      await markOutOfPlaylist(env, combinedId, r.videoId, "sweep");
      await row(r, "removed", n === 0 ? `${note(r)}; was not in the playlist` : note(r));
      out.removed++;
    } catch (e) {
      out.failed++;
      o.log.warn("hygiene.sweep.orphan_remove_failed", {
        videoId: r.videoId,
        playlistId: combinedId,
        ...errorFields(e),
      });
      await row(r, "failed", (e instanceof Error ? e.message : String(e)).slice(0, 300));
      if (isQuotaError(e)) {
        await noteQuotaOut(env, e, o.log);
        out.stoppedBy = "quota";
        break;
      }
    }
  }
  if (touched) await invalidatePlaylistVideoIds(env, combinedId);
  o.log.info("hygiene.sweep.orphans_done", { ...out });
  return out;
}

async function sweepTrackedVideos(
  env: Env,
  accessToken: string,
  opts: SweepOpts,
): Promise<SweepResult> {
  const { log } = opts;
  const nowMs = opts.nowMs ?? Date.now();
  const settings = opts.settings ?? sweepSettings(env, await getAppSettings(env));
  const db = dbOf(env);
  const rows = (
    await db
      .prepare(
        // processed = 1: an unprocessed set with a video is one whose insert waits for YouTube's quota
        // (lib/sync.ts). It was never in a playlist, so there is nothing to sweep, and clearing its video
        // here would cost the page fetch the wait was meant to save.
        `SELECT t.slug, t.url, t.video_id, s.playlist_id FROM tracklists t LEFT JOIN sub_sync s ON s.slug = t.slug
         WHERE t.video_id IS NOT NULL AND t.processed = 1 AND COALESCE(t.video_source, '1001tl') != 'mkvid'
         ORDER BY t.slug, t.position`,
      )
      .all<AddedRow>()
  ).results;
  const overrides = await overriddenIds(env);
  const mkvidOwn = await mkvidUploadedIds(env, log);
  const candidates = rows.filter((r) => !overrides.has(r.video_id) && !mkvidOwn.has(r.video_id));
  const used = Math.max(await sweepDeletesUsed(env, nowMs), opts.usedAtLeast ?? 0);
  /** The day's count as this run knows it; each delete is written on top of it, never on a read that lags. */
  let known = used;
  const result: SweepResult = {
    dryRun: settings.dryRun,
    candidates: candidates.length,
    judged: 0,
    rejected: 0,
    reported: 0,
    removedVideos: 0,
    deletes: 0,
    failed: 0,
    budget: settings.dailyRemovals,
    budgetLeft: Math.max(0, settings.dailyRemovals - used),
    stoppedBy: null,
    metaFailed: false,
    keptShared: 0,
  };
  if (candidates.length === 0) return result;

  let metas: Map<string, VideoMeta>;
  try {
    metas = await getVideoMeta(
      env,
      candidates.map((r) => r.video_id),
      accessToken,
      { fetcher: opts.fetcher, now: Math.floor(nowMs / 1000) },
    );
  } catch (e) {
    // Judge from facts alone; the next sweep retries the lookup.
    result.metaFailed = true;
    log.warn("hygiene.sweep.meta_failed", { candidates: candidates.length, ...errorFields(e) });
    if (isQuotaError(e)) {
      await noteQuotaOut(env, e, log);
      return { ...result, stoppedBy: "quota" };
    }
    metas = await readCachedVideoMeta(
      env,
      candidates.map((r) => r.video_id),
    );
  }
  const facts = await loadSetFacts(
    env,
    candidates.map((r) => r.url),
  );
  const judgeOpts = await judgeOptions(env);
  const rejected: Array<AddedRow & { verdict: Extract<VideoVerdict, { ok: false }> }> = [];
  for (const r of candidates) {
    result.judged++;
    const verdict = judgeVideo(facts.get(r.url), metas.get(r.video_id), judgeOpts);
    // Dead videos are the comparison's business (recorded, never re-added,
    // set made mkvid-eligible) - deleting their husk would only spend budget.
    if (!verdict.ok && verdict.reason !== "dead") rejected.push({ ...r, verdict });
  }
  result.rejected = rejected.length;
  const combinedId = (await loadCombinedState(env)).playlistId ?? null;

  // B1: a video is taken out of a DJ's playlist only when EVERY set of that DJ
  // that resolves to it is rejected. Any accepted set of the DJ keeps it there
  // (and keeps it in the combined playlist); any accepted set anywhere keeps
  // it in the combined playlist. The sweep never blocklists anything.
  const rejectedKeys = new Set(rejected.map((r) => `${r.slug}\n${r.url}`));
  const acceptedBySlug = new Map<string, Set<string>>();
  const acceptedAnywhere = new Set<string>();
  for (const r of rows) {
    if (rejectedKeys.has(`${r.slug}\n${r.url}`)) continue;
    if (!acceptedBySlug.has(r.slug)) acceptedBySlug.set(r.slug, new Set());
    acceptedBySlug.get(r.slug)!.add(r.video_id);
    acceptedAnywhere.add(r.video_id);
  }
  const planFor = (r: AddedRow): Array<[string, "artist" | "combined"]> =>
    targets(r.playlist_id, combinedId).filter(([, kind]) =>
      kind === "artist"
        ? !acceptedBySlug.get(r.slug)?.has(r.video_id)
        : !acceptedAnywhere.has(r.video_id),
    );

  if (settings.dryRun) {
    for (const r of rejected) {
      const plan = planFor(r);
      if (plan.length === 0) {
        result.keptShared++;
        continue;
      }
      for (const [pl, kind] of plan) {
        await logRemoval(env, {
          source: "sweep",
          status: "would_remove",
          slug: r.slug,
          set_url: r.url,
          video_id: r.video_id,
          playlist_id: pl,
          playlist_kind: kind,
          reason: r.verdict.reason,
          detail: r.verdict.detail,
        });
      }
      result.reported++;
    }
    log.info("hygiene.sweep.dry_run", { ...result });
    return result;
  }

  let budgetLeft = result.budgetLeft;
  const touched = new Set<string>();
  // The same video in two rejected rows of one DJ: remove once, clear both rows.
  const done = new Set<string>();
  for (const r of rejected) {
    const plan = planFor(r).filter(([pl]) => !done.has(`${pl}\n${r.video_id}`));
    if (plan.length === 0) {
      // Still used by an accepted set (or already taken out for a sibling row):
      // nothing is deleted; only this set loses the video it cannot use.
      await clearSetVideoStmt(db, r.slug, r.video_id, r.url).run();
      if (!planFor(r).length) {
        result.keptShared++;
        log.info("hygiene.sweep.kept_shared", {
          slug: r.slug,
          setUrl: r.url,
          videoId: r.video_id,
          reason: r.verdict.reason,
        });
      }
      continue;
    }
    if (budgetLeft < plan.length) {
      result.stoppedBy = "budget";
      break;
    }
    let quota = false;
    let allOk = true;
    let deletesHere = 0;
    for (const [pl, kind] of plan) {
      try {
        const n = await removeVideoFromPlaylist(pl, r.video_id, accessToken, opts.fetcher);
        done.add(`${pl}\n${r.video_id}`);
        deletesHere += n;
        budgetLeft -= n;
        // Counted per delete (m3): a throw or a killed run later on cannot leave deletes uncounted.
        known = await bumpSweepDeletes(env, n, nowMs, known);
        touched.add(pl);
        // Taken out by tracked itself: the comparison must never read its absence as the owner's doing.
        await markOutOfPlaylist(env, pl, r.video_id, "sweep");
        await logRemoval(env, {
          source: "sweep",
          status: "removed",
          slug: r.slug,
          set_url: r.url,
          video_id: r.video_id,
          playlist_id: pl,
          playlist_kind: kind,
          reason: r.verdict.reason,
          detail: n === 0 ? `${r.verdict.detail}; was not in the playlist` : r.verdict.detail,
        });
        // Out of the artist playlist: the set has no video from now on (m4: before the combined step can fail).
        if (kind === "artist") await clearSetVideoStmt(db, r.slug, r.video_id, r.url).run();
      } catch (e) {
        result.failed++;
        allOk = false;
        log.warn("hygiene.sweep.remove_failed", {
          slug: r.slug,
          setUrl: r.url,
          videoId: r.video_id,
          playlistId: pl,
          ...errorFields(e),
        });
        await logRemoval(env, {
          source: "sweep",
          status: "failed",
          slug: r.slug,
          set_url: r.url,
          video_id: r.video_id,
          playlist_id: pl,
          playlist_kind: kind,
          reason: r.verdict.reason,
          detail: (e instanceof Error ? e.message : String(e)).slice(0, 300),
        });
        if (isQuotaError(e)) {
          await noteQuotaOut(env, e, log);
          quota = true;
          break;
        }
      }
    }
    result.deletes += deletesHere;
    if (!plan.some(([, kind]) => kind === "artist")) {
      // Only the combined playlist was in the plan: the DJ has no artist playlist, the set still loses its video.
      await clearSetVideoStmt(db, r.slug, r.video_id, r.url).run();
    }
    if (allOk) result.removedVideos++;
    log.info("hygiene.sweep.removed", {
      slug: r.slug,
      setUrl: r.url,
      videoId: r.video_id,
      reason: r.verdict.reason,
      deletes: deletesHere,
    });
    if (quota) {
      result.stoppedBy = "quota";
      break;
    }
  }
  for (const pl of touched) await invalidatePlaylistVideoIds(env, pl);
  result.budgetLeft = Math.max(0, budgetLeft);
  log.info("hygiene.sweep.done", { ...result });
  return result;
}

function targets(
  artistId: string | null,
  combinedId: string | null,
): Array<[string, "artist" | "combined"]> {
  const out: Array<[string, "artist" | "combined"]> = [];
  if (artistId) out.push([artistId, "artist"]);
  if (combinedId && combinedId !== artistId) out.push([combinedId, "combined"]);
  return out;
}

// --- comparison -------------------------------------------------------------

function itemVideoId(it: RawPlaylistItem): string | null {
  return it.contentDetails?.videoId ?? it.snippet?.resourceId?.videoId ?? null;
}

type Listing = {
  present: Set<string>;
  /** Videos whose item is the husk of a deleted or private video (`isUnavailableItem`). */
  deadPresent: Set<string>;
  /** The playlist item ids of each of those, for taking them out without another lookup. */
  deadItems: Map<string, string[]>;
  /** Items in the playlist. */
  items: number;
  /** Each item's uploader channel (snippet.videoOwnerChannelId/Title), where the listing names one. */
  channels: VideoChannel[];
};

/** A playlist's contents, or null when the listing was not complete and successful. */
async function completeListing(
  playlistId: string,
  accessToken: string,
  log: Logger,
  fetcher?: typeof fetch,
): Promise<Listing | null> {
  try {
    const r = await listPlaylistItems(
      playlistId,
      accessToken,
      { maxPages: LIST_MAX_PAGES },
      fetcher,
    );
    if (r.nextPageToken) {
      log.warn("hygiene.compare.listing_incomplete", { playlistId, pages: r.pages });
      return null;
    }
    const present = new Set<string>();
    const deadPresent = new Set<string>();
    const deadItems = new Map<string, string[]>();
    const channels: VideoChannel[] = [];
    for (const it of r.items) {
      const id = itemVideoId(it);
      if (!id) {
        // A part/format change or a partial body: nothing may be inferred from this listing.
        log.warn("hygiene.compare.item_without_video_id", { playlistId });
        return null;
      }
      present.add(id);
      const sn = it.snippet as
        { videoOwnerChannelId?: unknown; videoOwnerChannelTitle?: unknown } | undefined;
      if (typeof sn?.videoOwnerChannelId === "string" && sn.videoOwnerChannelId)
        channels.push({
          videoId: id,
          channelId: sn.videoOwnerChannelId,
          channelTitle:
            typeof sn.videoOwnerChannelTitle === "string" ? sn.videoOwnerChannelTitle : null,
        });
      if (isUnavailableItem(it)) {
        deadPresent.add(id);
        if (it.id) deadItems.set(id, [...(deadItems.get(id) ?? []), it.id]);
      }
    }
    return { present, deadPresent, deadItems, items: r.items.length, channels };
  } catch (e) {
    log.warn("hygiene.compare.listing_failed", { playlistId, ...errorFields(e) });
    return null;
  }
}

/** The listing's uploader channels into `video_meta` (no extra call). Best effort: never fails the comparison. */
async function rememberChannels(env: Env, listing: Listing, log: Logger): Promise<void> {
  try {
    await saveVideoChannels(env, listing.channels);
  } catch (e) {
    log.warn("hygiene.compare.channels_failed", errorFields(e));
  }
}

/** A held playlist: what the comparison would have recorded, waiting for the owner. */
export type PlaylistHold = {
  playlistId: string;
  kind: "artist" | "combined";
  slug: string | null;
  expected: number;
  missing: number;
  /** The exact ids that looked removed (sorted); an approval covers exactly these. */
  missingIds: string[];
  /** Held by the run-wide breaker rather than this playlist's own guard. */
  runWide: boolean;
  at: number;
  notified: boolean;
};

const HOLD_PREFIX = "hygiene:hold:";
const APPROVE_PREFIX = "hygiene:approve:";
/** An approval answers one hold: its exact ids, for this long. */
export const HOLD_APPROVAL_TTL_SECONDS = 24 * 60 * 60;

type HoldApproval = { missingIds: string[]; at: number };

export async function listHolds(env: Env): Promise<PlaylistHold[]> {
  const out: PlaylistHold[] = [];
  const r = await env.SUBS.list({ prefix: HOLD_PREFIX });
  for (const k of r.keys) {
    const h = (await env.SUBS.get(k.name, "json")) as PlaylistHold | null;
    if (h) out.push({ ...h, missingIds: h.missingIds ?? [], runWide: h.runWide ?? false });
  }
  return out;
}

/**
 * Owner looked at a held playlist and says the removals are real. The
 * approval covers exactly the ids that hold showed, for 24 hours: a later,
 * different set of missing videos is held again.
 */
export async function approveHold(
  env: Env,
  playlistId: string,
  now = nowSeconds(),
): Promise<boolean> {
  const h = (await env.SUBS.get(HOLD_PREFIX + playlistId, "json")) as PlaylistHold | null;
  if (!h) return false;
  const approval: HoldApproval = { missingIds: [...(h.missingIds ?? [])].sort(), at: now };
  await env.SUBS.put(APPROVE_PREFIX + playlistId, JSON.stringify(approval), {
    expirationTtl: HOLD_APPROVAL_TTL_SECONDS,
  });
  return true;
}

async function approvalCovers(
  env: Env,
  playlistId: string,
  missingIds: string[],
  now: number,
): Promise<boolean> {
  const a = (await env.SUBS.get(APPROVE_PREFIX + playlistId, "json").catch(
    () => null,
  )) as HoldApproval | null;
  if (!a || !Array.isArray(a.missingIds) || typeof a.at !== "number") return false;
  if (now - a.at > HOLD_APPROVAL_TTL_SECONDS) return false;
  const want = [...missingIds].sort();
  return want.length === a.missingIds.length && want.every((id, i) => id === a.missingIds[i]);
}

async function clearHold(env: Env, playlistId: string): Promise<void> {
  await env.SUBS.delete(HOLD_PREFIX + playlistId);
  await env.SUBS.delete(APPROVE_PREFIX + playlistId);
}

/** Defaults of app settings playlists.massRemoval* / runRemovalMax. Hold a playlist when more than this share of what tracked put there seems gone... */
export const MASS_REMOVAL_RATIO = 0.3;
/** ...or more than this many videos. */
export const MASS_REMOVAL_MAX = 5;
/** More than this many videos missing across every playlist in one run: hold them all and push once. */
export const RUN_REMOVAL_MAX = 15;

/** Per-playlist guard against a partial view being read as a mass removal. Pure. */
export function isMassRemoval(
  missing: number,
  expected: number,
  limits: { max: number; ratio: number } = { max: MASS_REMOVAL_MAX, ratio: MASS_REMOVAL_RATIO },
): boolean {
  if (missing <= 0) return false;
  return missing > limits.max || (expected > 0 && missing / expected > limits.ratio);
}

/** Tells the owner. Resolves false when nothing was sent (push not set up, no device took it): the hold then notifies again next time. */
export type Notifier = (title: string, body: string) => Promise<boolean | void>;

/**
 * The cron's notifier for a held comparison: a Web Push (kind `playlist_hold`)
 * to every subscribed device, opening /ui/removed, at any hour.
 * Returns false when nothing was delivered, so the hold stays un-notified
 * and the next 6-hourly comparison tries again.
 */
export function playlistHoldPayload(
  title: string,
  body: string,
  now: Date = new Date(),
): PushPayload {
  return {
    kind: "playlist_hold",
    title,
    body,
    url: "/ui/removed",
    tag: "playlist-hold",
    ts: now.toISOString(),
  };
}

export function playlistHoldNotifier(env: Env, log?: Logger, fetchImpl?: typeof fetch): Notifier {
  return async (title, body) => {
    if (!pushConfigured(env)) return false;
    const r = await sendPushToAll(env, playlistHoldPayload(title, body), log, fetchImpl ?? fetch);
    return r.sent > 0;
  };
}

export type ComparePlaylistResult = {
  playlistId: string;
  kind: "artist" | "combined";
  slug: string | null;
  status: "ok" | "incomplete" | "held" | "first_snapshot";
  expected: number;
  missing: number;
  owner: number;
  dead: number;
  /** Dead videos taken out of the playlist by this run (`deleteDeadVideos`). */
  deadRemoved?: number;
  /** Dead videos still in it that are waiting: for their days to pass, for the owner (a hold), or because the sweep is a dry run. */
  deadReported?: number;
};

type RemovalFinding = { videoId: string; reason: "owner" | "dead"; setUrls: string[] };

async function classify(
  env: Env,
  ids: string[],
  deadPresent: ReadonlySet<string>,
  accessToken: string,
  log: Logger,
  fetcher?: typeof fetch,
): Promise<Map<string, "owner" | "dead">> {
  const out = new Map<string, "owner" | "dead">();
  const needLookup = ids.filter((id) => !deadPresent.has(id));
  let metas = new Map<string, VideoMeta>();
  if (needLookup.length > 0) {
    try {
      metas = await getVideoMeta(env, needLookup, accessToken, { maxAgeSeconds: 0, fetcher });
    } catch (e) {
      // Both labels get the same treatment; without the lookup it is "owner".
      log.warn("hygiene.compare.liveness_failed", { count: needLookup.length, ...errorFields(e) });
    }
  }
  for (const id of ids)
    out.set(id, deadPresent.has(id) || metas.get(id)?.alive === false ? "dead" : "owner");
  return out;
}

async function applyFindings(
  env: Env,
  findings: RemovalFinding[],
  ctx: { playlistId: string; kind: "artist" | "combined"; slug: string | null },
): Promise<void> {
  const db = dbOf(env);
  const stmts: D1PreparedStatement[] = [];
  // The uploader, from an earlier listing or the liveness lookup just made: what a ban question is about.
  const channels = await channelsOf(
    env,
    findings.map((f) => f.videoId),
  ).catch(() => new Map<string, { channelId: string; channelTitle: string | null }>());
  for (const f of findings) {
    const setUrl = f.setUrls[0] ?? null;
    const ch = channels.get(f.videoId);
    await recordRemoved(env, {
      playlistId: ctx.playlistId,
      videoId: f.videoId,
      slug: ctx.slug,
      setUrl,
      reason: f.reason,
      channelId: ch?.channelId ?? null,
      channelTitle: ch?.channelTitle ?? null,
    });
    await logRemoval(env, {
      source: f.reason,
      status: "recorded",
      slug: ctx.slug,
      set_url: setUrl,
      video_id: f.videoId,
      playlist_id: ctx.playlistId,
      playlist_kind: ctx.kind,
      reason: f.reason,
      detail:
        f.reason === "dead"
          ? "gone from YouTube; never re-added here"
          : "missing from the playlist, still on YouTube; never re-added here",
    });
    // Artist playlist: the set no longer has a video - due for recheck, and mkvid-eligible from it.
    if (ctx.kind === "artist" && ctx.slug) stmts.push(clearSetVideoStmt(db, ctx.slug, f.videoId));
  }
  await batchChunked(db, stmts);
}

/** Videos the audit trail shows the sync (or mkvid delivery) successfully inserted for a DJ. */
async function auditedInserts(env: Env, slug: string): Promise<Set<string>> {
  const res = await dbOf(env)
    .prepare(
      "SELECT DISTINCT video_id FROM playlist_additions WHERE slug = ? AND status IN ('added', 'replaced') AND video_id IS NOT NULL",
    )
    .bind(slug)
    .all<{ video_id: string }>();
  return new Set(res.results.map((r) => r.video_id));
}

type Pending = {
  /** Index of this playlist's entry in the results (listing order). */
  slot: number;
  ctx: { playlistId: string; kind: "artist" | "combined"; slug: string | null };
  expected: number;
  missing: string[];
  deadHere: string[];
  deadPresent: ReadonlySet<string>;
  /** Every dead video in the playlist with its item ids, expected or not, and the size of the playlist. */
  deadItems: ReadonlyMap<string, string[]>;
  items: number;
  setUrlsOf: (id: string) => string[];
  /** Run after findings are applied (the combined playlist saves its snapshot). */
  after?: () => Promise<void>;
};

// --- dead videos still in a playlist ----------------------------------------

/** This many dead videos or more in one playlist, and more than DEAD_MAX_RATIO of it, is not believed: the wrong account or an API fault, not deletions (as in lib/mkvid-recreate.ts). It is held for the owner (`DeadHold`). */
export const DEAD_ALL_MIN = 5;
export const DEAD_MAX_RATIO = 0.3;
/**
 * A video is taken out only after every comparison for this long has found it
 * dead. An uploader who makes a set private for a weekend, or a channel that
 * is suspended and reinstated, must not cost the owner a video for good; three
 * days is past either, and a husk nobody can play costs nothing meanwhile. A
 * constant, not a setting: nothing about one playlist or another changes it.
 */
export const DEAD_GRACE_DAYS = 3;

/** When each dead video was first seen dead and has stayed so since: `<playlistId> <videoId>` -> unix seconds. In SUBS; the log row is only what the owner reads. */
const DEAD_SEEN_KEY = "hygiene:dead:seen";
type DeadSeen = Record<string, number>;
const seenKey = (playlistId: string, videoId: string) => `${playlistId} ${videoId}`;

/**
 * The stored waits. A read that fails throws (the caller then does nothing
 * about dead videos this time): it is never taken for "no waits". A time that
 * is not a past unix time (null, 0, negative, in the future, not a number)
 * would read as "waited long enough", so it is replaced by `now`: that video's
 * wait starts over, and it is said once.
 */
async function loadDeadSeen(
  env: Env,
  now: number,
  log: Logger,
): Promise<{ seen: DeadSeen; repaired: boolean }> {
  const v = (await env.SUBS.get(DEAD_SEEN_KEY, "json")) as unknown;
  if (v === null || v === undefined) return { seen: {}, repaired: false };
  if (typeof v !== "object" || Array.isArray(v)) {
    log.error("hygiene.dead.seen_unreadable", { type: Array.isArray(v) ? "array" : typeof v });
    return { seen: {}, repaired: true };
  }
  const seen: DeadSeen = {};
  const bad: string[] = [];
  for (const [key, at] of Object.entries(v as Record<string, unknown>)) {
    const ok = typeof at === "number" && Number.isFinite(at) && at > 0 && at <= now;
    seen[key] = ok ? (at as number) : now;
    if (!ok) bad.push(key);
  }
  if (bad.length > 0)
    log.error("hygiene.dead.seen_repaired", { count: bad.length, keys: bad.slice(0, 20) });
  return { seen, repaired: bad.length > 0 };
}

/** A delete YouTube refuses this many times in a row (for a reason that is not quota) is left alone for DEAD_REFUSAL_PAUSE_DAYS, then tried afresh. */
export const DEAD_REFUSALS_MAX = 3;
export const DEAD_REFUSAL_PAUSE_DAYS = 7;

/** Refused deletes: `<playlistId> <videoId>` -> how many in a row, and when the last one was. In SUBS, next to the waits. */
const DEAD_REFUSED_KEY = "hygiene:dead:refused";
type DeadRefused = Record<string, { n: number; at: number }>;

async function loadDeadRefused(env: Env): Promise<DeadRefused> {
  const v = (await env.SUBS.get(DEAD_REFUSED_KEY, "json")) as unknown;
  const out: DeadRefused = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [key, r] of Object.entries(
    v as Record<string, { n?: unknown; at?: unknown } | null>,
  )) {
    if (
      r &&
      typeof r.n === "number" &&
      r.n > 0 &&
      typeof r.at === "number" &&
      Number.isFinite(r.at)
    )
      out[key] = { n: r.n, at: r.at };
  }
  return out;
}

/** Unix seconds until which a video's delete is not tried again, or null when it may be tried. */
function refusedUntil(r: { n: number; at: number } | undefined, now: number): number | null {
  if (!r || r.n < DEAD_REFUSALS_MAX) return null;
  const until = r.at + DEAD_REFUSAL_PAUSE_DAYS * DAY;
  // A time in the future is no reason to wait longer than the pause itself.
  return now < until && r.at <= now ? until : null;
}

/** Writes back what a run changed of the waits and the refusals. Never throws. */
async function saveDeadState(env: Env, run: DeadRun, log: Logger): Promise<void> {
  if (run.seenChanged)
    await env.SUBS.put(DEAD_SEEN_KEY, JSON.stringify(run.seen)).catch((e) =>
      log.warn("hygiene.dead.seen_write_failed", errorFields(e)),
    );
  if (run.refusedChanged)
    await env.SUBS.put(DEAD_REFUSED_KEY, JSON.stringify(run.refused)).catch((e) =>
      log.warn("hygiene.dead.refused_write_failed", errorFields(e)),
    );
}

/** A playlist whose listing called implausibly many videos dead: nothing is taken out of it until the owner says they are. */
export type DeadHold = {
  playlistId: string;
  kind: "artist" | "combined";
  slug: string | null;
  /** Items in the playlist, and how many of its videos looked dead. */
  items: number;
  dead: number;
  /** The exact ids (sorted); an approval covers these and no others. */
  deadIds: string[];
  at: number;
};

const DEAD_HOLD_PREFIX = "hygiene:deadhold:";
const DEAD_APPROVE_PREFIX = "hygiene:deadapprove:";
/** An approval outlasts the wait and a few days of the delete budget, then lapses. */
export const DEAD_APPROVAL_TTL_SECONDS = 14 * DAY;

export async function listDeadHolds(env: Env): Promise<DeadHold[]> {
  const out: DeadHold[] = [];
  const r = await env.SUBS.list({ prefix: DEAD_HOLD_PREFIX });
  for (const k of r.keys) {
    const h = (await env.SUBS.get(k.name, "json")) as DeadHold | null;
    if (h) out.push({ ...h, deadIds: h.deadIds ?? [] });
  }
  return out;
}

/**
 * The owner looked at a held playlist and says those videos really are gone.
 * Covers the ids that hold showed (and any part of them, as they leave over
 * the following days); a dead video that was not among them holds it again.
 */
export async function approveDeadHold(
  env: Env,
  playlistId: string,
  now = nowSeconds(),
): Promise<boolean> {
  const h = (await env.SUBS.get(DEAD_HOLD_PREFIX + playlistId, "json")) as DeadHold | null;
  if (!h) return false;
  await env.SUBS.put(
    DEAD_APPROVE_PREFIX + playlistId,
    JSON.stringify({ missingIds: [...(h.deadIds ?? [])], at: now } satisfies HoldApproval),
    { expirationTtl: DEAD_APPROVAL_TTL_SECONDS },
  );
  await env.SUBS.delete(DEAD_HOLD_PREFIX + playlistId);
  return true;
}

async function deadApprovalCovers(
  env: Env,
  playlistId: string,
  ids: string[],
  now: number,
): Promise<boolean> {
  const a = (await env.SUBS.get(DEAD_APPROVE_PREFIX + playlistId, "json").catch(
    () => null,
  )) as HoldApproval | null;
  if (
    !a ||
    !Array.isArray(a.missingIds) ||
    typeof a.at !== "number" ||
    now - a.at > DEAD_APPROVAL_TTL_SECONDS
  )
    return false;
  const ok = new Set(a.missingIds);
  return ids.every((id) => ok.has(id));
}

/** What one comparison run shares between its playlists. */
type DeadRun = {
  dryRun: boolean;
  budgetLeft: number;
  nowMs: number;
  /** mkvid's own uploads: its gone check takes those out and renders them again (lib/mkvid-recreate.ts). */
  mkvidOwn: Set<string>;
  /** Videos the owner said to keep (`video_overrides`, the Keep it button). */
  kept: Set<string>;
  seen: DeadSeen;
  seenChanged: boolean;
  refused: DeadRefused;
  refusedChanged: boolean;
  /** Dead for the whole wait, in playlists that are not held: what `deleteDeadVideos` takes out. */
  due: Array<{ p: Pending; videoId: string; itemIds: string[] }>;
  stoppedBy: "budget" | "quota" | "counter" | null;
  /** The day's delete count as read when the run began. */
  used: number;
  /** What this run knows the count to be after its own deletes; null until it wrote the counter. Handed to the sweep of the same tick. */
  usedNow: number | null;
};

/** Throws when any of what it reads cannot be read: the caller then leaves dead videos alone for this comparison. */
async function startDeadRun(env: Env, nowMs: number, log: Logger): Promise<DeadRun> {
  const settings = sweepSettings(env, await getAppSettings(env));
  const used = await sweepDeletesUsed(env, nowMs);
  const { seen, repaired } = await loadDeadSeen(env, Math.floor(nowMs / 1000), log);
  return {
    dryRun: settings.dryRun,
    budgetLeft: Math.max(0, settings.dailyRemovals - used),
    used,
    usedNow: null,
    nowMs,
    mkvidOwn: await mkvidUploadedIds(env, log),
    kept: await overriddenIds(env),
    seen,
    seenChanged: repaired,
    refused: await loadDeadRefused(env),
    refusedChanged: false,
    due: [],
    // Nothing is asked or written while the day's quota is out.
    stoppedBy: (await getQuotaOut(env, nowMs)) ? "quota" : null,
  };
}

const day = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);

/** The line a waiting row carries; it says what will happen, which depends on whether the sweep is live and on whether YouTube keeps refusing the delete. */
function waitingDetail(since: number, dryRun: boolean, pausedUntil: number | null = null): string {
  if (pausedUntil !== null && !dryRun)
    return `looks deleted or private since ${day(since)}; YouTube refused to take it out ${DEAD_REFUSALS_MAX} times, tried again after ${day(pausedUntil)}`;
  return dryRun
    ? `looks deleted or private since ${day(since)}; dry run: it stays in the playlist`
    : `looks deleted or private since ${day(since)}; removed after ${DEAD_GRACE_DAYS} days if it stays that way`;
}

/**
 * Look at the dead videos of one playlist: items the complete listing shows
 * as the husk of a deleted or foreign private video (`isUnavailableItem`),
 * whether or not the sync put them there. An owner-added video that died is
 * in no table of tracked's, so nothing else ever removes it. Nothing is
 * deleted here; what is due goes on `run.due` for `deleteDeadVideos`.
 *
 * **Believed only when YouTube says it twice**: the listing, and a fresh
 * videos.list (1 unit per 50) that does not return the video either. A lookup
 * that fails decides nothing.
 *
 * **And only after `DEAD_GRACE_DAYS`.** The first time a video is seen dead
 * is remembered (`DEAD_SEEN_KEY`) and it shows on the Removed page as waiting
 * (a `would_remove` row dated then, written once and not refreshed). A later
 * comparison that finds it alive, or gone from the playlist, forgets it and
 * drops the waiting row, so the wait starts over should it die again. A row
 * the comparison already wrote for the video (`recorded`) is left as it is.
 *
 * **Never** mkvid's own uploads (its gone check has them) and never a video
 * the owner chose to keep (`video_overrides`, Keep it on the waiting row).
 *
 * **Held** when `DEAD_ALL_MIN` or more of a playlist, and over
 * `DEAD_MAX_RATIO` of it, look dead: shown on the Removed page (`DeadHold`)
 * until the owner approves those ids. The wait runs meanwhile.
 */
async function judgeDeadVideos(
  env: Env,
  accessToken: string,
  p: Pending,
  run: DeadRun,
  opts: { log: Logger; fetcher?: typeof fetch },
): Promise<{ reported: number }> {
  const { log } = opts;
  const { ctx } = p;
  const out = { reported: 0 };
  if (run.stoppedBy === "quota") return out;
  const db = dbOf(env);
  const now = Math.floor(run.nowMs / 1000);
  const prefix = `${ctx.playlistId} `;
  /** The video is alive again, left the playlist, or is to be kept: the wait is over and so is its row. */
  const forget = async (id: string) => {
    if (run.refused[seenKey(ctx.playlistId, id)]) {
      delete run.refused[seenKey(ctx.playlistId, id)];
      run.refusedChanged = true;
    }
    if (run.seen[seenKey(ctx.playlistId, id)] === undefined) return;
    delete run.seen[seenKey(ctx.playlistId, id)];
    run.seenChanged = true;
    await db
      .prepare(
        "DELETE FROM playlist_removals WHERE source = 'dead' AND status = 'would_remove' AND video_id = ? AND playlist_id = ?",
      )
      .bind(id, ctx.playlistId)
      .run();
  };
  const candidates = [...p.deadItems.keys()].filter(
    (id) => !run.mkvidOwn.has(id) && !run.kept.has(id),
  );
  let metas = new Map<string, VideoMeta>();
  if (candidates.length > 0) {
    try {
      metas = await getVideoMeta(env, candidates, accessToken, {
        maxAgeSeconds: 0,
        fetcher: opts.fetcher,
      });
    } catch (e) {
      log.warn("hygiene.dead.liveness_failed", {
        ...ctx,
        count: candidates.length,
        ...errorFields(e),
      });
      if (isQuotaError(e)) {
        await noteQuotaOut(env, e, log);
        run.stoppedBy = "quota";
      }
      // Nothing is known: no wait starts and none ends.
      return out;
    }
  }
  // The listing calls it dead and videos.list still returns it: not believed.
  const dead = candidates.filter((id) => metas.get(id)?.alive === false);
  const isDead = new Set(dead);
  for (const key of Object.keys(run.seen))
    if (key.startsWith(prefix) && !isDead.has(key.slice(prefix.length)))
      await forget(key.slice(prefix.length));

  let held = false;
  if (
    dead.length >= DEAD_ALL_MIN &&
    dead.length > p.items * DEAD_MAX_RATIO &&
    !(await deadApprovalCovers(env, ctx.playlistId, dead, now))
  ) {
    held = true;
    const deadIds = [...dead].sort().slice(0, 500);
    const prev = (await env.SUBS.get(DEAD_HOLD_PREFIX + ctx.playlistId, "json")) as DeadHold | null;
    const same = !!prev && JSON.stringify(prev.deadIds ?? []) === JSON.stringify(deadIds);
    if (!same) {
      await env.SUBS.put(
        DEAD_HOLD_PREFIX + ctx.playlistId,
        JSON.stringify({
          ...ctx,
          items: p.items,
          dead: dead.length,
          deadIds,
          at: now,
        } satisfies DeadHold),
      );
      log.warn("hygiene.dead.held", { ...ctx, items: p.items, dead: dead.length });
    }
  } else await env.SUBS.delete(DEAD_HOLD_PREFIX + ctx.playlistId);

  for (const id of dead) {
    const key = seenKey(ctx.playlistId, id);
    if (run.seen[key] === undefined) {
      run.seen[key] = now;
      run.seenChanged = true;
    }
    const since = run.seen[key]!;
    const waited = now - since >= DEAD_GRACE_DAYS * DAY;
    // Refused DEAD_REFUSALS_MAX times in a row: left alone for the pause, then the count starts afresh.
    const pausedUntil = refusedUntil(run.refused[key], now);
    if (pausedUntil === null && (run.refused[key]?.n ?? 0) >= DEAD_REFUSALS_MAX) {
      delete run.refused[key];
      run.refusedChanged = true;
    }
    if (!run.dryRun && !held && waited && pausedUntil === null) {
      run.due.push({ p, videoId: id, itemIds: p.deadItems.get(id) ?? [] });
      continue;
    }
    // Shown as waiting. The row is dated when the video was first seen dead and is not written again;
    // only its line follows the dry-run setting and a pause. One the comparison recorded, or the owner
    // undid ("Allow again"), keeps that row and its date; a recorded one says when it is paused.
    const detail = waitingDetail(since, run.dryRun, pausedUntil);
    const had = await db
      .prepare(
        "SELECT status, detail FROM playlist_removals WHERE source = 'dead' AND video_id = ? AND playlist_id = ?",
      )
      .bind(id, ctx.playlistId)
      .first<{ status: string; detail: string | null }>();
    if (!had || !["would_remove", "recorded", "undone"].includes(had.status)) {
      await logRemoval(env, {
        at: since,
        source: "dead",
        status: "would_remove",
        slug: ctx.slug,
        set_url: p.setUrlsOf(id)[0] ?? null,
        video_id: id,
        playlist_id: ctx.playlistId,
        playlist_kind: ctx.kind,
        reason: "dead",
        detail,
      });
    } else if (
      (had.status === "would_remove" || (had.status === "recorded" && pausedUntil !== null)) &&
      had.detail !== detail
    ) {
      await db
        .prepare(
          "UPDATE playlist_removals SET detail = ? WHERE source = 'dead' AND status = ? AND video_id = ? AND playlist_id = ?",
        )
        .bind(detail, had.status, id, ctx.playlistId)
        .run();
    }
    out.reported++;
  }
  return out;
}

/**
 * Take out what `judgeDeadVideos` found due, across every playlist of the run.
 *
 * The sweep's rails apply: never in a dry run (`playlists.sweepDryRun`), and
 * every delete counts against the sweep's daily budget
 * (`playlists.sweepDailyRemovals`; the sweep that follows in the same tick
 * gets what is left). The budget is charged ONCE, before the first delete,
 * for everything this run is about to take out: KV refuses a second write to
 * a key within about a second, so a counter bumped per delete could fail
 * after YouTube had already deleted. If that one write fails nothing is
 * deleted (never an overspend); deletes that then do not happen are given
 * back at the end, best effort (a failed refund only leaves the day's budget
 * a little short). KV reads can lag a write made seconds earlier, so no count
 * is ever taken from a re-read alone: the charge is written on top of the
 * higher of the run's first read and the current one, the refund is the
 * known "before + deleted", and that number goes to the sweep of the same
 * tick in memory (`spend`, `usedAtLeast`).
 *
 * A delete YouTube refuses for a reason that is not quota is counted. After
 * `DEAD_REFUSALS_MAX` in a row the video is left alone for
 * `DEAD_REFUSAL_PAUSE_DAYS` (its row says so), then tried afresh.
 *
 * The item id comes from the listing, so a removal is one
 * playlistItems.delete (50 units) and no lookup: a lookup by video id is what
 * YouTube answers `videoNotFound` to for exactly these videos. Once an item
 * is deleted its bookkeeping is done whatever else fails: logged like the
 * sweep's (`playlist_removals`, source `dead`), never re-added
 * (`removed_videos`; the owner can lift that on the Removed page), marked as
 * taken out by tracked. In an artist playlist the DJ's sets that resolve to
 * it lose it and become due, which is what queues them for mkvid
 * (`clearSetVideoStmt`, as for any dead or owner-removed video); a video no
 * set resolves to is just removed. A delete YouTube refuses is tried again at
 * the next comparison; a daily-quota reply stops the run and sets the hold.
 */
async function deleteDeadVideos(
  env: Env,
  accessToken: string,
  run: DeadRun,
  opts: { log: Logger; fetcher?: typeof fetch },
): Promise<Map<string, number>> {
  const { log } = opts;
  const removed = new Map<string, number>();
  if (run.dryRun || run.stoppedBy || run.due.length === 0) return removed;
  const db = dbOf(env);
  const todo: DeadRun["due"] = [];
  let reserved = 0;
  for (const d of run.due) {
    if (reserved + d.itemIds.length > run.budgetLeft) {
      run.stoppedBy = "budget";
      break;
    }
    reserved += d.itemIds.length;
    todo.push(d);
  }
  /** The day's count before this run's deletes: the higher of what the run read at its start and what KV says now. */
  let before = run.used;
  if (todo.length > 0) {
    try {
      before = (await bumpSweepDeletes(env, reserved, run.nowMs, run.used)) - reserved;
      run.usedNow = before + reserved;
    } catch (e) {
      // The day's count could not be written: deleting now could overspend it, so nothing is deleted this run.
      run.stoppedBy = "counter";
      log.warn("hygiene.dead.budget_write_failed", { reserved, ...errorFields(e) });
      return removed;
    }
  }
  let deleted = 0;
  const touched = new Set<string>();
  for (const d of todo) {
    const { ctx } = d.p;
    let gone = 0;
    let quota = false;
    try {
      for (const itemId of d.itemIds) {
        await deletePlaylistItem(itemId, accessToken, opts.fetcher);
        gone++;
      }
    } catch (e) {
      log.warn("hygiene.dead.remove_failed", { ...ctx, videoId: d.videoId, ...errorFields(e) });
      if (isQuotaError(e)) {
        await noteQuotaOut(env, e, log);
        quota = true;
      } else {
        // Not quota: counted, so a delete YouTube will never make is not asked for every six hours for ever.
        const key = seenKey(ctx.playlistId, d.videoId);
        run.refused[key] = { n: (run.refused[key]?.n ?? 0) + 1, at: Math.floor(run.nowMs / 1000) };
        run.refusedChanged = true;
      }
    }
    deleted += gone;
    if (gone > 0) touched.add(ctx.playlistId);
    // Every item of the video is out: the bookkeeping, each step on its own so one failing does not cost the others.
    if (gone === d.itemIds.length) {
      const setUrl = d.p.setUrlsOf(d.videoId)[0] ?? null;
      const since = day(
        run.seen[seenKey(ctx.playlistId, d.videoId)] ?? Math.floor(run.nowMs / 1000),
      );
      // The owner pressed "Allow again" on its row while it waited: it still goes (nobody can play it), but it is
      // not put back on the never-add list, so the sync adds it again should it come back.
      const allowed = await db
        .prepare(
          "SELECT 1 AS x FROM playlist_removals WHERE source = 'dead' AND status = 'undone' AND video_id = ? AND playlist_id = ?",
        )
        .bind(d.videoId, ctx.playlistId)
        .first<{ x: number }>()
        .then((r) => !!r)
        // Not known: the usual, safer bookkeeping (blocked; the owner can lift it again).
        .catch(() => false);
      const steps: Array<[string, () => Promise<unknown>]> = [
        ["mark_out", () => markOutOfPlaylist(env, ctx.playlistId, d.videoId, "dead")],
        ...(allowed
          ? []
          : [
              [
                "block",
                () =>
                  recordRemoved(env, {
                    playlistId: ctx.playlistId,
                    videoId: d.videoId,
                    slug: ctx.slug,
                    setUrl,
                    reason: "dead",
                  }),
              ] as [string, () => Promise<unknown>],
            ]),
        [
          "log",
          () =>
            logRemoval(env, {
              at: Math.floor(run.nowMs / 1000),
              source: "dead",
              status: "removed",
              slug: ctx.slug,
              set_url: setUrl,
              video_id: d.videoId,
              playlist_id: ctx.playlistId,
              playlist_kind: ctx.kind,
              reason: "dead",
              detail: `deleted or private since ${since}; taken out of the playlist${allowed ? "; may be added again if it comes back (you allowed it)" : ""}`,
            }),
        ],
      ];
      if (ctx.kind === "artist" && ctx.slug && d.p.setUrlsOf(d.videoId).length > 0)
        steps.push(["clear_set", () => clearSetVideoStmt(db, ctx.slug!, d.videoId).run()]);
      for (const [step, fn] of steps) {
        try {
          await fn();
        } catch (e) {
          log.error("hygiene.dead.bookkeeping_failed", {
            ...ctx,
            videoId: d.videoId,
            step,
            ...errorFields(e),
          });
        }
      }
      delete run.seen[seenKey(ctx.playlistId, d.videoId)];
      run.seenChanged = true;
      if (run.refused[seenKey(ctx.playlistId, d.videoId)]) {
        delete run.refused[seenKey(ctx.playlistId, d.videoId)];
        run.refusedChanged = true;
      }
      removed.set(ctx.playlistId, (removed.get(ctx.playlistId) ?? 0) + 1);
    }
    if (quota) {
      run.stoppedBy = "quota";
      break;
    }
  }
  for (const pl of touched) await invalidatePlaylistVideoIds(env, pl).catch(() => {});
  // Deletes charged and not made are given back: the count is set to what this run KNOWS was spent (never a
  // re-read, which may lag the charge and would wipe it). A refused write leaves the day a little short.
  if (todo.length > 0 && deleted < reserved) {
    try {
      await writeSweepDeletes(env, before + deleted, run.nowMs);
      run.usedNow = before + deleted;
    } catch (e) {
      log.warn("hygiene.dead.budget_refund_failed", {
        unused: reserved - deleted,
        ...errorFields(e),
      });
    }
  }
  run.budgetLeft -= deleted;
  log.info("hygiene.dead.done", {
    due: run.due.length,
    deleted,
    videos: [...removed.values()].reduce((a, b) => a + b, 0),
    budgetLeft: run.budgetLeft,
    stoppedBy: run.stoppedBy,
  });
  return removed;
}

/**
 * List every managed playlist in full and compare it with what tracked put
 * there. Evidence that a video belongs in a playlist (anything else is never
 * read as removed):
 *   - artist playlists: a confirmed insert or a sighting in an earlier
 *     complete listing (`playlist_confirmed` state `in`), or - so removals
 *     made before this existed are still found - an `added`/`replaced` audit
 *     row for the DJ that tracked never took back out (`out`). The video must
 *     also still be what one of the DJ's sets resolves to.
 *   - the combined playlist: its own last complete listing (first run only
 *     records one).
 * Guards: a playlist with more than 30% or more than 5 of its videos missing
 * is held; more than 15 missing across the whole run holds every playlist
 * with a missing video and pushes once. A hold is applied only after the
 * owner approves exactly those ids (valid 24 h).
 */
export async function comparePlaylists(
  env: Env,
  accessToken: string,
  opts: {
    log: Logger;
    notify?: Notifier;
    fetcher?: typeof fetch;
    now?: number;
    /** Filled in with the day's delete count as this run knows it after taking out dead videos, for the sweep that follows (`usedAtLeast`). */
    spend?: { used: number | null };
  },
): Promise<ComparePlaylistResult[]> {
  const { log } = opts;
  const now = opts.now ?? nowSeconds();
  const db = dbOf(env);
  const subs = (
    await db
      .prepare("SELECT slug, playlist_id FROM sub_sync WHERE playlist_id IS NOT NULL")
      .all<{ slug: string; playlist_id: string }>()
  ).results;
  // processed = 1: a video still waiting for its insert (YouTube's quota, lib/sync.ts) is not expected in any playlist yet.
  const rows = (
    await db
      .prepare(
        "SELECT slug, url, video_id FROM tracklists WHERE video_id IS NOT NULL AND processed = 1",
      )
      .all<{ slug: string; url: string; video_id: string }>()
  ).results;
  // Taken out by mkvid's delete-and-recreate itself: not the owner's doing.
  const replaced = await mkvidReplacedIds(env, log);
  const bySlug = new Map<string, Map<string, string[]>>();
  const allExpected = new Map<string, string[]>();
  for (const r of rows) {
    if (replaced.has(r.video_id)) continue;
    if (!bySlug.has(r.slug)) bySlug.set(r.slug, new Map());
    const m = bySlug.get(r.slug)!;
    m.set(r.video_id, [...(m.get(r.video_id) ?? []), r.url]);
    allExpected.set(r.video_id, [...(allExpected.get(r.video_id) ?? []), r.url]);
  }
  const results: ComparePlaylistResult[] = [];
  const pending: Pending[] = [];

  // -- phase 1: list everything, work out what looks removed ----------------
  for (const s of subs) {
    const ctx = { playlistId: s.playlist_id, kind: "artist" as const, slug: s.slug };
    const referenced = bySlug.get(s.slug) ?? new Map<string, string[]>();
    const listing = await completeListing(s.playlist_id, accessToken, log, opts.fetcher);
    if (!listing) {
      results.push({ ...ctx, status: "incomplete", expected: 0, missing: 0, owner: 0, dead: 0 });
      continue;
    }
    await cachePlaylistVideoIds(env, s.playlist_id, listing.present);
    await rememberChannels(env, listing, log);
    const blocked = await blockedIds(env, s.playlist_id);
    const membership = await confirmedMembership(env, s.playlist_id);
    const audited = await auditedInserts(env, s.slug);
    const expected = [...referenced.keys()].filter(
      (id) =>
        !blocked.has(id) &&
        (membership.get(id) === "in" || (membership.get(id) !== "out" && audited.has(id))),
    );
    // Snapshot: what a complete listing shows of the DJ's own videos counts as confirmed from now on.
    for (const id of referenced.keys())
      if (listing.present.has(id) && membership.get(id) !== "in")
        await markInPlaylist(env, s.playlist_id, id, "listing", now);
    pending.push({
      slot: results.push({ ...ctx, status: "ok", expected: 0, missing: 0, owner: 0, dead: 0 }) - 1,
      ctx,
      expected: expected.length,
      missing: expected.filter((id) => !listing.present.has(id)),
      deadHere: expected.filter((id) => listing.deadPresent.has(id)),
      deadPresent: listing.deadPresent,
      deadItems: listing.deadItems,
      items: listing.items,
      setUrlsOf: (id) => referenced.get(id) ?? [],
    });
  }

  const combined = await loadCombinedState(env);
  if (combined.playlistId) {
    const combinedId = combined.playlistId;
    const ctx = { playlistId: combinedId, kind: "combined" as const, slug: null };
    const listing = await completeListing(combinedId, accessToken, log, opts.fetcher);
    if (!listing) {
      results.push({ ...ctx, status: "incomplete", expected: 0, missing: 0, owner: 0, dead: 0 });
    } else {
      await cachePlaylistVideoIds(env, combinedId, listing.present);
      await rememberChannels(env, listing, log);
      const members = await playlistMembers(env, combinedId);
      if (members.size === 0) {
        await savePlaylistMembers(env, combinedId, listing.present, now);
        results.push({
          ...ctx,
          status: "first_snapshot",
          expected: 0,
          missing: 0,
          owner: 0,
          dead: 0,
        });
      } else {
        const unavailable = new Set(combined.unavailableVideoIds ?? []);
        const blocked = await blockedIds(env, combinedId);
        const expected = [...members].filter(
          (id) => allExpected.has(id) && !unavailable.has(id) && !blocked.has(id),
        );
        pending.push({
          slot:
            results.push({ ...ctx, status: "ok", expected: 0, missing: 0, owner: 0, dead: 0 }) - 1,
          ctx,
          expected: expected.length,
          missing: expected.filter((id) => !listing.present.has(id)),
          deadHere: expected.filter((id) => listing.deadPresent.has(id)),
          deadPresent: listing.deadPresent,
          deadItems: listing.deadItems,
          items: listing.items,
          setUrlsOf: (id) => allExpected.get(id) ?? [],
          // Saved only when applied: a held playlist keeps its old snapshot, so the backfill keeps skipping the held ids.
          after: () => savePlaylistMembers(env, combinedId, listing.present, now),
        });
      }
    }
  }

  // -- phase 2: guards ------------------------------------------------------
  const approved = new Set<string>();
  for (const p of pending)
    if (p.missing.length > 0 && (await approvalCovers(env, p.ctx.playlistId, p.missing, now)))
      approved.add(p.ctx.playlistId);
  const runMissing = pending
    .filter((p) => !approved.has(p.ctx.playlistId))
    .reduce((n, p) => n + p.missing.length, 0);
  const guard = (await getAppSettings(env)).playlists; // app settings: massRemovalMax / massRemovalRatio / runRemovalMax
  const massLimits = { max: guard.massRemovalMax, ratio: guard.massRemovalRatio };
  const breaker = runMissing > guard.runRemovalMax;
  if (breaker)
    log.error("hygiene.compare.run_breaker", {
      runMissing,
      playlists: pending.filter((p) => p.missing.length > 0).length,
    });
  const newHolds: PlaylistHold[] = [];
  /** Set up at the first playlist that has a dead video in it; most runs have none. */
  let deadRun: DeadRun | null = null;
  /** Its setup failed: dead videos are left alone for this comparison. */
  let deadOff = false;

  // The dead-video pass rides this loop but is not the comparison: whatever fails in it (its setup, one
  // playlist, the deletes), the comparison goes on, and what it learned about waits is saved in the `finally`.
  try {
    for (const p of pending) {
      const { ctx } = p;
      let hold = false;
      if (p.missing.length === 0) await clearHold(env, ctx.playlistId);
      else if (approved.has(ctx.playlistId)) {
        await clearHold(env, ctx.playlistId);
        log.warn("hygiene.compare.hold_approved", {
          ...ctx,
          expected: p.expected,
          missing: p.missing.length,
        });
      } else if (breaker || isMassRemoval(p.missing.length, p.expected, massLimits)) hold = true;
      else await clearHold(env, ctx.playlistId);

      if (hold) {
        const prev = (await env.SUBS.get(
          HOLD_PREFIX + ctx.playlistId,
          "json",
        )) as PlaylistHold | null;
        const missingIds = [...p.missing].sort().slice(0, 500);
        const sameIds =
          !!prev && JSON.stringify(prev.missingIds ?? []) === JSON.stringify(missingIds);
        const h: PlaylistHold = {
          ...ctx,
          expected: p.expected,
          missing: p.missing.length,
          missingIds,
          runWide: breaker && !isMassRemoval(p.missing.length, p.expected, massLimits),
          at: sameIds ? prev!.at : now,
          notified: sameIds ? prev!.notified : false,
        };
        log.error("hygiene.compare.held", { ...h, missingIds: missingIds.slice(0, 20) });
        newHolds.push(h);
        results[p.slot] = {
          ...ctx,
          status: "held",
          expected: p.expected,
          missing: p.missing.length,
          owner: 0,
          dead: 0,
        };
        continue;
      }
      const ids = [...new Set([...p.missing, ...p.deadHere])];
      const labels = await classify(env, ids, p.deadPresent, accessToken, log, opts.fetcher);
      const findings = ids.map((id) => ({
        videoId: id,
        reason: labels.get(id)!,
        setUrls: p.setUrlsOf(id),
      }));
      await applyFindings(env, findings, ctx);
      if (p.after) await p.after();
      const owner = findings.filter((f) => f.reason === "owner").length;
      results[p.slot] = {
        ...ctx,
        status: "ok",
        expected: p.expected,
        missing: p.missing.length,
        owner,
        dead: findings.length - owner,
      };
      if (findings.length > 0)
        log.warn("hygiene.compare.removals_recorded", {
          ...ctx,
          owner,
          dead: findings.length - owner,
          videoIds: ids.slice(0, 50),
        });
      // Dead videos still in the playlist, and the ones that were waiting and are back or gone (see judgeDeadVideos).
      if (!deadRun && !deadOff) {
        try {
          deadRun = await startDeadRun(env, now * 1000, log);
        } catch (e) {
          // Its settings, budget or waits could not be read. Nothing is known, so nothing is judged, started, ended or deleted this time.
          deadOff = true;
          log.error("hygiene.dead.start_failed", errorFields(e));
        }
      }
      if (
        deadRun &&
        (p.deadItems.size > 0 ||
          Object.keys(deadRun.seen).some((k) => k.startsWith(`${ctx.playlistId} `)))
      ) {
        try {
          const d = await judgeDeadVideos(env, accessToken, p, deadRun, {
            log,
            fetcher: opts.fetcher,
          });
          if (d.reported > 0)
            results[p.slot] = { ...results[p.slot]!, deadRemoved: 0, deadReported: d.reported };
        } catch (e) {
          // This playlist's dead videos wait for the next comparison; the others, and the comparison itself, go on.
          log.warn("hygiene.dead.judge_failed", { ...ctx, ...errorFields(e) });
        }
      }
    }
    // After every playlist's findings are applied: a dead video the sync added is on the blocklist, and its set cleared, before its item goes.
    if (deadRun) {
      try {
        const removed = await deleteDeadVideos(env, accessToken, deadRun, {
          log,
          fetcher: opts.fetcher,
        });
        for (const p of pending) {
          const n = removed.get(p.ctx.playlistId);
          if (n)
            results[p.slot] = {
              ...results[p.slot]!,
              deadRemoved: n,
              deadReported: results[p.slot]!.deadReported ?? 0,
            };
        }
      } catch (e) {
        log.error("hygiene.dead.threw", errorFields(e));
      }
    }
  } finally {
    // Waits that started or ended, and refused deletes, are remembered whatever threw above. A lost write only makes a wait start again.
    if (deadRun) {
      await saveDeadState(env, deadRun, log);
      // What the day's delete budget stands at now, for the sweep that follows in the same tick.
      if (opts.spend && deadRun.usedNow !== null) opts.spend.used = deadRun.usedNow;
    }
  }

  // -- notify: one push per new hold, or one for the whole run when the breaker tripped --
  const unnotified = newHolds.filter((h) => !h.notified);
  if (unnotified.length > 0 && opts.notify) {
    const title = breaker ? "Playlist check held: too many removals" : "Playlist check held";
    const messages = breaker
      ? [
          `${runMissing} videos across ${newHolds.length} playlists seem to be gone in one check. Nothing was recorded; review at /ui/removed.`,
        ]
      : unnotified.map(
          (h) =>
            `${h.kind === "combined" ? "The combined playlist" : `${h.slug}'s playlist`} seems to have lost ${h.missing} of ${h.expected} videos. Nothing was recorded; review at /ui/removed.`,
        );
    let allSent = true;
    for (const body of messages) {
      try {
        if ((await opts.notify(title, body)) === false) allSent = false;
      } catch (e) {
        allSent = false;
        log.warn("hygiene.compare.notify_failed", errorFields(e));
      }
    }
    if (allSent) for (const h of unnotified) h.notified = true;
  }
  for (const h of newHolds) await env.SUBS.put(HOLD_PREFIX + h.playlistId, JSON.stringify(h));

  log.info("hygiene.compare.done", {
    playlists: results.length,
    held: newHolds.length,
    breaker,
    incomplete: results.filter((r) => r.status === "incomplete").length,
  });
  return results;
}

// --- remove and replace -----------------------------------------------------

export type RemoveReplaceResult =
  | { ok: false; error: "not_found" | "no_video" | "mkvid_video" }
  | {
      ok: true;
      videoId: string;
      removedFrom: Array<{ playlistId: string; kind: "artist" | "combined"; deleted: number }>;
      mkvid: string;
    };

/**
 * The set page's "remove and replace": take the set's video out of its
 * artist playlist and the combined one now, record it as owner-removed for
 * both (never re-added), and queue the set for mkvid when its page had an
 * audio source. Owner action: not charged to the sweep's daily budget.
 * Refused for an mkvid render (m10): "delete and recreate" is the path there.
 */
export async function removeAndReplace(
  env: Env,
  accessToken: string,
  input: { slug: string; setUrl: string; log: Logger; fetcher?: typeof fetch },
): Promise<RemoveReplaceResult> {
  const { log } = input;
  const db = dbOf(env);
  const row = await db
    .prepare("SELECT video_id, video_source FROM tracklists WHERE slug = ? AND url = ?")
    .bind(input.slug, input.setUrl)
    .first<{ video_id: string | null; video_source: string | null }>();
  if (!row) return { ok: false, error: "not_found" };
  if (!row.video_id) return { ok: false, error: "no_video" };
  if (row.video_source === "mkvid" || (await mkvidUploadedIds(env, log)).has(row.video_id))
    return { ok: false, error: "mkvid_video" };
  const videoId = row.video_id;
  const artist =
    (
      await db
        .prepare("SELECT playlist_id FROM sub_sync WHERE slug = ?")
        .bind(input.slug)
        .first<{ playlist_id: string | null }>()
    )?.playlist_id ?? null;
  const combinedId = (await loadCombinedState(env)).playlistId ?? null;
  const removedFrom: Array<{ playlistId: string; kind: "artist" | "combined"; deleted: number }> =
    [];
  const channel = await removedVideoChannel(env, videoId, accessToken, log, input.fetcher);
  for (const [pl, kind] of targets(artist, combinedId)) {
    const deleted = await removeVideoFromPlaylist(pl, videoId, accessToken, input.fetcher);
    removedFrom.push({ playlistId: pl, kind, deleted });
    await markOutOfPlaylist(env, pl, videoId, "button");
    await recordRemoved(env, {
      playlistId: pl,
      videoId,
      slug: input.slug,
      setUrl: input.setUrl,
      reason: "button",
      channelId: channel?.channelId ?? null,
      channelTitle: channel?.channelTitle ?? null,
    });
    await logRemoval(env, {
      source: "button",
      status: "removed",
      slug: input.slug,
      set_url: input.setUrl,
      video_id: videoId,
      playlist_id: pl,
      playlist_kind: kind,
      reason: "button",
      detail: `deleted ${deleted} item(s)`,
    });
    await invalidatePlaylistVideoIds(env, pl);
  }
  await clearSetVideoStmt(db, input.slug, videoId, input.setUrl).run();
  const mkvid = await queueForMkvid(env, input.slug, input.setUrl, log);
  log.info("hygiene.remove_replace", {
    slug: input.slug,
    setUrl: input.setUrl,
    videoId,
    removedFrom,
    mkvid,
  });
  return { ok: true, videoId, removedFrom, mkvid };
}

/** The uploader of a video the owner is removing: from the cache, else one videos.list call (1 unit). Never throws. */
async function removedVideoChannel(
  env: Env,
  videoId: string,
  accessToken: string,
  log: Logger,
  fetcher?: typeof fetch,
): Promise<{ channelId: string; channelTitle: string | null } | null> {
  try {
    const known = (await channelsOf(env, [videoId])).get(videoId);
    if (known) return known;
    const m = (await getVideoMeta(env, [videoId], accessToken, { fetcher })).get(videoId);
    return m?.channelId ? { channelId: m.channelId, channelTitle: m.channelTitle ?? null } : null;
  } catch (e) {
    log.warn("hygiene.remove_replace.channel_failed", { videoId, ...errorFields(e) });
    return null;
  }
}

/** Queue a set for mkvid from its stored page facts (no 1001tracklists fetch). */
async function queueForMkvid(env: Env, slug: string, setUrl: string, log: Logger): Promise<string> {
  if (!env.MKVID_TOKEN) return "mkvid not configured";
  const f = (await loadSetFacts(env, [setUrl])).get(setUrl);
  if (!f?.audioKind || !f.audioUrl)
    return f
      ? "no audio source on the set page"
      : "set page not seen since this feature shipped; the next recheck decides";
  try {
    const artistName =
      (
        await dbOf(env)
          .prepare("SELECT artist_name FROM sub_sync WHERE slug = ?")
          .bind(slug)
          .first<{ artist_name: string | null }>()
      )?.artist_name ?? slug;
    const r = await enqueueMkvidRequest(env, {
      slug,
      setUrl,
      artistName,
      setTitle: f.setTitle,
      setDate: f.setDate,
      source: { kind: f.audioKind, url: f.audioUrl },
      lastCueSeconds: f.lastCueSeconds,
      trackCount: f.trackCount ?? 0,
      idedCount: f.idedCount ?? 0,
    });
    if (r === "queued") return `queued for mkvid (${f.audioKind})`;
    const existing = await getMkvidRequestForSet(env, setUrl);
    if (existing && existing.status === "superseded" && (await retryMkvidRequest(env, existing.id)))
      return `mkvid request reopened (${f.audioKind})`;
    return `mkvid request already exists (${existing?.status ?? "unknown"})`;
  } catch (e) {
    log.warn("hygiene.mkvid_queue_failed", { slug, setUrl, ...errorFields(e) });
    return "mkvid queueing failed";
  }
}

// --- undo -------------------------------------------------------------------

export type UndoResult =
  { ok: true; readded: boolean } | { ok: false; error: "not_found" | "not_undoable" };

/**
 * Undo one logged removal: the video goes back into that playlist (unless it
 * was only a dry-run report), leaves the blocklist, and the full-recording
 * rule stops applying to it so the next sweep does not take it out again.
 *   - The row is claimed first (`undoing`), so a double click re-adds once.
 *   - The video is re-inserted BEFORE it leaves the blocklist: a failed
 *     insert keeps it blocked (and the row back in its old state), so the
 *     next comparison cannot record it a second time.
 *   - Every set of the DJ that lost this video gets it back (only where
 *     nothing replaced it meanwhile), and an mkvid request queued for those
 *     sets since the removal is superseded, so no render replaces it later.
 *
 * A dead video's rows (source `dead`) differ, because a dead video cannot be
 * re-inserted: undoing one that was removed or recorded only takes it off the
 * never-add list (the sync adds it again if it comes back on YouTube), and
 * "Keep it" on one that is waiting marks it as kept, so the comparison never
 * takes it out (`judgeDeadVideos`).
 */
export async function undoRemoval(
  env: Env,
  accessToken: string,
  id: number,
  log: Logger,
  fetcher?: typeof fetch,
): Promise<UndoResult> {
  const db = dbOf(env);
  const row = await db
    .prepare("SELECT * FROM playlist_removals WHERE id = ?")
    .bind(id)
    .first<RemovalRow>();
  if (!row) return { ok: false, error: "not_found" };
  if (!["would_remove", "removed", "recorded"].includes(row.status))
    return { ok: false, error: "not_undoable" };
  const claimed = await db
    .prepare("UPDATE playlist_removals SET status = 'undoing' WHERE id = ? AND status = ?")
    .bind(id, row.status)
    .run();
  if ((claimed.meta.changes ?? 0) === 0) return { ok: false, error: "not_undoable" };
  let readded = false;
  try {
    if (row.source === "dead" && row.status !== "would_remove") {
      // A dead video cannot be put back (YouTube refuses the insert). It only leaves the never-add list, so the
      // sync adds it again should it come back; and no override, which would let the sync try it while it is dead.
      await unblock(env, row.playlist_id, row.video_id);
      await db
        .prepare("UPDATE playlist_removals SET status = 'undone' WHERE id = ?")
        .bind(id)
        .run();
      log.info("hygiene.undo", {
        id,
        videoId: row.video_id,
        playlistId: row.playlist_id,
        readded,
        dead: true,
      });
      return { ok: true, readded };
    }
    if (row.status !== "would_remove") {
      // An artist playlist gets it back at the place its set's date gives it when the playlist's
      // snapshot is at hand; without one it is appended and the reorder pass moves it
      // (lib/playlist-reorder.ts). The combined playlist is not ordered: always appended.
      const inPlaylist =
        row.playlist_kind === "artist"
          ? await peekCachedPlaylistVideoIds(env, row.playlist_id)
          : null;
      if (inPlaylist)
        await insertInOrder(env, {
          playlistId: row.playlist_id,
          videoId: row.video_id,
          existing: inPlaylist,
          accessToken,
          log,
          setUrl: row.set_url,
          fetcher,
        });
      else await addVideoToPlaylist(row.playlist_id, row.video_id, accessToken, fetcher);
      readded = true;
      await markInPlaylist(env, row.playlist_id, row.video_id, "undo");
      await unblock(env, row.playlist_id, row.video_id);
      await invalidatePlaylistVideoIds(env, row.playlist_id);
      if (row.playlist_kind === "artist" && row.slug) {
        // The rows this removal cleared: the logged set, and any other set of the DJ whose page links this video.
        const urls = new Set<string>(row.set_url ? [row.set_url] : []);
        const facts = await db
          .prepare("SELECT set_url FROM set_media_facts WHERE slug = ? AND video_id = ?")
          .bind(row.slug, row.video_id)
          .all<{ set_url: string }>();
        for (const f of facts.results) urls.add(f.set_url);
        for (const url of urls) {
          const r = await db
            .prepare(
              "UPDATE tracklists SET video_id = ?, video_source = '1001tl', video_known = 1 WHERE slug = ? AND url = ? AND video_id IS NULL",
            )
            .bind(row.video_id, row.slug, url)
            .run();
          if (
            (r.meta.changes ?? 0) > 0 &&
            (await supersedeMkvidRequestForSet(env, url, row.video_id))
          )
            log.info("hygiene.undo.mkvid_superseded", { setUrl: url, videoId: row.video_id });
        }
      }
    }
    await setOverride(env, row.video_id);
  } catch (e) {
    await db
      .prepare("UPDATE playlist_removals SET status = ? WHERE id = ? AND status = 'undoing'")
      .bind(row.status, id)
      .run();
    throw e;
  }
  await db.prepare("UPDATE playlist_removals SET status = 'undone' WHERE id = ?").bind(id).run();
  log.info("hygiene.undo", { id, videoId: row.video_id, playlistId: row.playlist_id, readded });
  return { ok: true, readded };
}

// --- cron entry -------------------------------------------------------------

const LAST_COMPARE_KEY = "hygiene:last_compare";
const LAST_SWEEP_KEY = "hygiene:last_sweep";

/** Make the sweep due at the next cron tick (a channel was just banned: its videos should not wait up to 6 hours). */
export async function requestSweepSoon(env: Env): Promise<void> {
  await env.SUBS.delete(LAST_SWEEP_KEY);
}

async function due(env: Env, key: string, interval: number, now: number): Promise<boolean> {
  const raw = await env.SUBS.get(key);
  const last = raw ? Number(raw) : 0;
  return !Number.isFinite(last) || now - last >= interval;
}

/**
 * Called from every cron tick; does work only when a cadence is due: the
 * comparison every 6 hours, then the sweep. Never throws. Runs whether or not
 * 1001tracklists fetching is paused - it only touches YouTube.
 */
export async function runPlaylistHygiene(
  env: Env,
  log: Logger,
  opts: {
    accessToken?: string;
    notify?: Notifier;
    /** Pushes new channel-ban questions (lib/channel-bans.ts); absent = asked, not pushed (the next comparison pushes). */
    banNotify?: BanNotifier;
    force?: "compare" | "sweep";
    fetcher?: typeof fetch;
    nowMs?: number;
  } = {},
): Promise<{
  compare?: ComparePlaylistResult[];
  sweep?: SweepResult;
  bans?: BanQueueResult;
  skipped?: string;
}> {
  const nowMs = opts.nowMs ?? Date.now();
  const now = Math.floor(nowMs / 1000);
  try {
    const wantCompare = opts.force
      ? opts.force === "compare"
      : await due(env, LAST_COMPARE_KEY, COMPARE_INTERVAL_SECONDS, now);
    const wantSweep = opts.force
      ? opts.force === "sweep"
      : await due(env, LAST_SWEEP_KEY, SWEEP_INTERVAL_SECONDS, now);
    if (!wantCompare && !wantSweep) return { skipped: "not_due" };
    const token = opts.accessToken ?? (await getAccessToken(env))?.accessToken;
    if (!token) return { skipped: "youtube_not_connected" };
    const out: { compare?: ComparePlaylistResult[]; sweep?: SweepResult; bans?: BanQueueResult } =
      {};
    // The comparison's dead-video deletes and the sweep draw on one daily budget, seconds apart: the count is handed
    // over in memory, since a KV read that soon after the write may not show it.
    const spend: { used: number | null } = { used: null };
    if (wantCompare) {
      await env.SUBS.put(LAST_COMPARE_KEY, String(now));
      out.compare = await comparePlaylists(env, token, {
        log,
        notify: opts.notify,
        fetcher: opts.fetcher,
        now,
        spend,
      });
      // The owner's removals it just found become ban questions (and past ones whose channel is now known).
      try {
        out.bans = await processBanQueue(env, {
          log,
          accessToken: token,
          fetcher: opts.fetcher,
          notify: opts.banNotify,
          now,
        });
      } catch (e) {
        log.error("bans.queue_threw", errorFields(e));
      }
    }
    if (wantSweep) {
      await env.SUBS.put(LAST_SWEEP_KEY, String(now));
      out.sweep = await runRemovalSweep(env, token, {
        log,
        fetcher: opts.fetcher,
        nowMs,
        usedAtLeast: spend.used ?? undefined,
      });
    }
    return out;
  } catch (e) {
    log.error("hygiene.threw", errorFields(e));
    return { skipped: "error" };
  }
}
