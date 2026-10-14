/**
 * Pre-save matches (migration 0022; design docs/superpowers/specs/
 * 2026-10-14-presave-candidates-design.md): a pre-saved track still waiting
 * for a YouTube link (stage `links`) is searched for by mkvid - YouTube Music
 * through its innertube search (no Data API quota) and, when enabled, Soulseek
 * through slskd - and every candidate's audio is compared with the track's
 * official previews (Apple, Deezer, Spotify, Beatport, SoundCloud). Audio
 * comparison is used for this and nothing else.
 *
 * mkvid gathers facts, tracked decides (`decideMatch`, a pure function over
 * the facts and Settings `presaveMatch`):
 *
 *   auto_approved  YouTube Music, audio >= autoApproveScore against a preview,
 *                  length within durationToleranceSeconds, names match
 *   auto_rejected  every preview scored and all below autoRejectScore: kept,
 *                  never analysed again (every claim lists the known ids)
 *   review         anything else, and every Soulseek / Spotify candidate:
 *                  the approval page (/ui/presave-matches), one push per search
 *
 * Approving (auto or by the owner) a YouTube candidate makes it the presave's
 * video exactly like a 1001tracklists link (stage `found`, like, push) ONLY IF
 * it is a Topic upload or has comments off (videos.list, 1 unit per 50 ids);
 * otherwise, and for Soulseek / Spotify files always, mkvid rips and uploads
 * it (lib/track-uploads.ts queueMatchUpload).
 *
 * Search jobs are pulled like mkvid's other queues (routes/mkvid-presave.ts):
 * claim -> complete | fail. One `presave_match_searches` row per presave and
 * kind holds the schedule. Times are unix MS in both tables.
 */

import type { Env } from "../types";
import { dbOf, parseJson } from "./db";
import { errorFields, type Logger } from "./log";
import { getAppSettings, type AppSettings } from "./app-settings";
import { parseIsoDuration } from "./youtube-playlists";
import { presaveMatchReviewPayload, sendPushToAll } from "./web-push";
import { markPresaveFoundFromMatch } from "./presave";
import { queueMatchUpload, soulseekSourceUrl } from "./track-uploads";

export const SEARCH_KINDS = ["ytm", "slsk"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];
export const MATCH_SOURCES = ["ytm", "slsk", "spotify"] as const;
export type MatchSource = (typeof MATCH_SOURCES)[number];
export const MATCH_DECISIONS = [
  "review",
  "approved",
  "rejected",
  "auto_approved",
  "auto_rejected",
  "superseded",
] as const;
export type MatchDecision = (typeof MATCH_DECISIONS)[number];
/** Link names (lib/medialinks-all.ts) mkvid can take a reference preview from, in order of preference. */
export const REFERENCE_LINKS = ["apple", "deezer", "spotify", "beatport", "soundcloud"] as const;
/** References whose preview URL the browser can play for days: no clip needed. */
const STABLE_PREVIEWS = new Set(["apple", "spotify"]);
/** A claim mkvid has not completed or failed is handed out again after this. */
export const SEARCH_CLAIM_TTL_MS = 30 * 60_000;
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
export const CLIP_PREFIX = "presave-clips/";

type MatchSettings = AppSettings["presaveMatch"];

// --- names --------------------------------------------------------------------

/** Words that make an upload another version of a track (a cap on the name score unless the pre-save says so too). */
export const VERSION_WORDS = [
  "remix",
  "boosted",
  "sped",
  "speed",
  "slowed",
  "nightcore",
  "reverb",
  "8d",
  "extended",
  "edit",
  "live",
  "cover",
  "acoustic",
  "instrumental",
  "karaoke",
  "mashup",
  "bootleg",
  "flip",
  "vip",
  "rework",
  "remake",
  "tiktok",
  "loop",
  "dub",
] as const;
/** Words of upload titles that say nothing about the recording. */
const NOISE = new Set([
  "official",
  "audio",
  "video",
  "music",
  "lyric",
  "lyrics",
  "visualizer",
  "visualiser",
  "hd",
  "hq",
  "4k",
  "topic",
  "the",
  "feat",
  "ft",
  "featuring",
  "x",
  "and",
  "with",
  "original",
  "out",
  "now",
  "free",
  "download",
  "premiere",
  "a",
  "vs",
]);

/** Lowercase ASCII words of a name: accents dropped, `&` read as "and", punctuation gone. */
export function nameTokens(s: string | null | undefined): string[] {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/**
 * How well a candidate's names cover the pre-save's (0..1): the share of the
 * pre-save's artist + title words found in the candidate's artist + title
 * (noise words like "official audio" ignored). A version word in the candidate
 * that the pre-save lacks ("remix", "bass boosted", "sped up", "extended"...)
 * caps it at 0.5: a different version is never a name match.
 */
export function nameScore(
  presave: { artist: string | null; title: string | null },
  cand: { artist: string | null; title: string | null },
): number {
  const want = [...new Set([...nameTokens(presave.artist), ...nameTokens(presave.title)])].filter(
    (w) => !NOISE.has(w) && w !== "id",
  );
  const have = new Set(
    [...nameTokens(cand.artist?.replace(/\s+-\s+topic$/i, "")), ...nameTokens(cand.title)].filter(
      (w) => !NOISE.has(w),
    ),
  );
  if (want.length === 0) return 0;
  let hit = 0;
  for (const w of want) if (have.has(w)) hit++;
  let score = hit / want.length;
  const wanted = new Set(want);
  const extraVersion = VERSION_WORDS.some((v) => have.has(v) && !wanted.has(v));
  if (extraVersion) score = Math.min(score, 0.5);
  return Math.round(score * 1000) / 1000;
}

// --- the decision ------------------------------------------------------------

export type ReferenceScore = {
  /** The reference's kind (apple, deezer, spotify, beatport, soundcloud). */
  ref: string;
  /** 0..1 (lib/fingerprint.ts in mkvid); null when that reference could not be compared. */
  score: number | null;
  ber?: number | null;
  offsetSeconds?: number | null;
  overlapSeconds?: number | null;
};

export type MatchFacts = {
  source: MatchSource;
  durationSeconds: number | null;
  nameScore: number;
  scores: readonly ReferenceScore[];
};

export type MatchVerdict = {
  decision: "auto_approved" | "auto_rejected" | "review";
  audioScore: number | null;
  reason: string;
};

const fmt = (n: number) => n.toFixed(2);

/** The pure rule (see the module comment). `presaveDuration` null = unknown, which rules out auto-approval. */
export function decideMatch(
  c: MatchFacts,
  presaveDuration: number | null,
  s: Pick<
    MatchSettings,
    "autoApproveScore" | "autoRejectScore" | "durationToleranceSeconds" | "minNameScore"
  >,
): MatchVerdict {
  const scored = c.scores
    .map((x) => x.score)
    .filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  const audioScore = scored.length ? Math.max(...scored) : null;
  if (c.source !== "ytm")
    return {
      decision: "review",
      audioScore,
      reason: `${c.source === "slsk" ? "Soulseek" : "Spotify"} files are approved by hand`,
    };
  if (audioScore === null)
    return { decision: "review", audioScore, reason: "no preview could be compared" };
  if (audioScore < s.autoRejectScore)
    return {
      decision: "auto_rejected",
      audioScore,
      reason: `different audio: best ${fmt(audioScore)} < ${fmt(s.autoRejectScore)} against ${scored.length} preview${scored.length === 1 ? "" : "s"}`,
    };
  const delta =
    presaveDuration && c.durationSeconds ? Math.abs(c.durationSeconds - presaveDuration) : null;
  if (audioScore >= s.autoApproveScore) {
    if (delta === null)
      return {
        decision: "review",
        audioScore,
        reason: "audio matches; the track's length is unknown",
      };
    if (delta > s.durationToleranceSeconds)
      return {
        decision: "review",
        audioScore,
        reason: `audio matches but the length is ${Math.round(delta)} s off (another edit?)`,
      };
    if (c.nameScore < s.minNameScore)
      return {
        decision: "review",
        audioScore,
        reason: `audio matches but the names do not (${fmt(c.nameScore)})`,
      };
    return {
      decision: "auto_approved",
      audioScore,
      reason: `audio ${fmt(audioScore)}, length within ${Math.round(delta)} s, names ${fmt(c.nameScore)}`,
    };
  }
  return { decision: "review", audioScore, reason: `audio ${fmt(audioScore)} is unclear` };
}

// --- rows -------------------------------------------------------------------

export type MatchRow = {
  id: number;
  presave_id: number;
  source: MatchSource;
  external_id: string;
  url: string | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  channel_title: string | null;
  video_type: string | null;
  is_topic: number | null;
  comments_off: number | null;
  duration_seconds: number | null;
  name_score: number | null;
  audio_score: number | null;
  scores: string | null;
  extra: string | null;
  clip_key: string | null;
  decision: MatchDecision;
  decided_by: string | null;
  reason: string | null;
  outcome: string | null;
  track_upload_id: number | null;
  created_at: number;
  updated_at: number;
  decided_at: number | null;
};

export type SearchRow = {
  presave_id: number;
  kind: SearchKind;
  status: string;
  searches: number;
  attempts: number;
  claimed_at: number | null;
  next_at: number | null;
  last_error: string | null;
  last_at: number | null;
  candidates_seen: number;
  refs: string | null;
  created_at: number;
  updated_at: number;
};

export type StoredReference = {
  kind: string;
  /** The page / link the preview came from. */
  url: string | null;
  /** The audio file itself, when mkvid read one (Apple / Deezer / Spotify previews). */
  previewUrl: string | null;
  ok: boolean;
  durationSeconds: number | null;
  clipKey: string | null;
  error: string | null;
};

type PresaveLite = {
  id: number;
  track_id: string | null;
  track_url: string | null;
  artist: string | null;
  title: string | null;
  artwork_url: string | null;
  stage: string;
  links: string | null;
  duration_seconds: number | null;
  youtube_video_id: string | null;
  created_at: number;
};

const PRESAVE_COLS =
  "id, track_id, track_url, artist, title, artwork_url, stage, links, duration_seconds, youtube_video_id, created_at";

async function presaveLite(env: Env, id: number): Promise<PresaveLite | null> {
  return dbOf(env)
    .prepare(`SELECT ${PRESAVE_COLS} FROM presaves WHERE id = ?`)
    .bind(id)
    .first<PresaveLite>();
}

export const searchIdOf = (presaveId: number, kind: SearchKind) => `${presaveId}:${kind}`;
export function parseSearchId(id: string): { presaveId: number; kind: SearchKind } | null {
  const m = /^(\d{1,12}):(ytm|slsk)$/.exec(id);
  return m ? { presaveId: Number(m[1]), kind: m[2] as SearchKind } : null;
}

// --- claim --------------------------------------------------------------------

export type SearchReference = { kind: string; url: string };

export type SearchJob = {
  searchId: string;
  kind: SearchKind;
  presaveId: number;
  artist: string | null;
  title: string | null;
  durationSeconds: number | null;
  trackUrl: string | null;
  /** The pre-save's links mkvid may read a reference preview from (REFERENCE_LINKS order). */
  references: SearchReference[];
  /** External ids already posted for this presave and source: skip them (never analysed twice). */
  known: string[];
  maxCandidates: number;
  durationToleranceSeconds: number;
  /** Post the Spotify link as a `spotify` candidate when nothing else is found (Settings presaveMatch.spotifyRip). */
  allowSpotifyRip: boolean;
  /** Including this claim. */
  attempt: number;
};

export type SearchClaimOutcome = "claimed" | "disabled" | "capped" | "empty";

const utcDayStart = (now: number) => now - (now % DAY_MS);

/** The links mkvid may read a preview from: one per kind, in REFERENCE_LINKS order. */
export function referencesOf(linksJson: string | null): SearchReference[] {
  const links = parseJson<Array<{ name?: string; url?: string | null }>>(linksJson, []);
  if (!Array.isArray(links)) return [];
  const out: SearchReference[] = [];
  for (const kind of REFERENCE_LINKS) {
    const l = links.find(
      (x) =>
        (x?.name ?? "").toLowerCase() === kind &&
        typeof x.url === "string" &&
        /^https:\/\//.test(x.url),
    );
    if (l?.url) out.push({ kind, url: l.url });
  }
  return out;
}

/**
 * Claim the next due search for one of `kinds`: a presave in stage `links`
 * with no video, watched >= searchDelayHours, never searched for that kind or
 * due again (next_at), and not claimed by a search still within its TTL.
 * Oldest due first; under dailySearchCap claims a UTC day.
 */
export async function claimSearchJob(
  env: Env,
  kinds: readonly SearchKind[],
  log: Logger,
  now = Date.now(),
): Promise<{ job: SearchJob | null; outcome: SearchClaimOutcome }> {
  const s = (await getAppSettings(env)).presaveMatch;
  const allowed = kinds.filter((k) => k === "ytm" || (k === "slsk" && s.soulseek));
  if (!s.enabled || allowed.length === 0 || s.dailySearchCap <= 0)
    return { job: null, outcome: "disabled" };
  const db = dbOf(env);
  const today = await db
    .prepare("SELECT COUNT(*) AS n FROM presave_match_searches WHERE claimed_at >= ?")
    .bind(utcDayStart(now))
    .first<{ n: number }>();
  if (Number(today?.n ?? 0) >= s.dailySearchCap) return { job: null, outcome: "capped" };
  const stale = now - SEARCH_CLAIM_TTL_MS;
  const watchedBefore = now - s.searchDelayHours * HOUR_MS;
  for (const kind of allowed) {
    const due = await db
      .prepare(
        `SELECT p.id AS id, s.presave_id AS has_row, s.attempts AS attempts FROM presaves p
           LEFT JOIN presave_match_searches s ON s.presave_id = p.id AND s.kind = ?
          WHERE p.stage = 'links' AND p.youtube_video_id IS NULL
            -- watched long enough, or searched before / asked for by the owner (Search now)
            AND (p.created_at <= ? OR s.presave_id IS NOT NULL)
            AND (p.artist IS NOT NULL OR p.title IS NOT NULL)
            AND (s.presave_id IS NULL
                 OR (s.status != 'claimed' AND s.next_at IS NOT NULL AND s.next_at <= ?)
                 OR (s.status = 'claimed' AND s.claimed_at < ?))
          ORDER BY COALESCE(s.next_at, p.created_at) ASC, p.id ASC LIMIT 10`,
      )
      .bind(kind, watchedBefore, now, stale)
      .all<{ id: number; has_row: number | null; attempts: number | null }>();
    for (const row of due.results) {
      const presaveId = Number(row.id);
      let took: boolean;
      if (row.has_row === null) {
        const r = await db
          .prepare(
            `INSERT INTO presave_match_searches (presave_id, kind, status, claimed_at, next_at, created_at, updated_at)
             VALUES (?, ?, 'claimed', ?, ?, ?, ?) ON CONFLICT (presave_id, kind) DO NOTHING`,
          )
          .bind(presaveId, kind, now, now, now, now)
          .run();
        took = (r.meta.changes ?? 0) > 0;
      } else {
        const r = await db
          .prepare(
            `UPDATE presave_match_searches SET status = 'claimed', claimed_at = ?, updated_at = ?
              WHERE presave_id = ? AND kind = ?
                AND ((status != 'claimed' AND next_at IS NOT NULL AND next_at <= ?) OR (status = 'claimed' AND claimed_at < ?))`,
          )
          .bind(now, now, presaveId, kind, now, stale)
          .run();
        took = (r.meta.changes ?? 0) > 0;
      }
      if (!took) continue;
      const p = await presaveLite(env, presaveId);
      if (!p) continue;
      const sources: MatchSource[] = kind === "ytm" ? ["ytm", "spotify"] : ["slsk"];
      const known = await db
        .prepare(
          `SELECT external_id FROM presave_matches WHERE presave_id = ? AND source IN (${sources.map(() => "?").join(", ")})`,
        )
        .bind(presaveId, ...sources)
        .all<{ external_id: string }>();
      const references = referencesOf(p.links);
      const job: SearchJob = {
        searchId: searchIdOf(presaveId, kind),
        kind,
        presaveId,
        artist: p.artist,
        title: p.title,
        durationSeconds: p.duration_seconds,
        trackUrl: p.track_url,
        references,
        known: known.results.map((r) => r.external_id),
        maxCandidates: s.maxCandidates,
        durationToleranceSeconds: s.durationToleranceSeconds,
        allowSpotifyRip:
          kind === "ytm" && s.spotifyRip && references.some((r) => r.kind === "spotify"),
        attempt: Number(row.attempts ?? 0) + 1,
      };
      log.info("presave_match.claimed", {
        searchId: job.searchId,
        presaveId,
        kind,
        references: references.map((r) => r.kind),
        known: job.known.length,
      });
      return { job, outcome: "claimed" };
    }
  }
  return { job: null, outcome: "empty" };
}

// --- YouTube facts --------------------------------------------------------------

export type VideoFacts = {
  channelTitle: string | null;
  isTopic: boolean;
  /** statistics.commentCount is absent when comments are turned off. */
  commentsOff: boolean;
  durationSeconds: number | null;
};

/**
 * videos.list (snippet, statistics, contentDetails) for up to 50 ids a call,
 * 1 quota unit each, with the API key. Ids YouTube does not return are left
 * out. Throws on an HTTP error.
 */
export async function fetchVideoFacts(
  ids: readonly string[],
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<Map<string, VideoFacts>> {
  const out = new Map<string, VideoFacts>();
  const uniq = [...new Set(ids.filter((x) => /^[A-Za-z0-9_-]{11}$/.test(x)))];
  for (let i = 0; i < uniq.length; i += 50) {
    const chunk = uniq.slice(i, i + 50);
    const url =
      "https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails" +
      `&id=${chunk.join(",")}&maxResults=50&key=${encodeURIComponent(apiKey)}`;
    const res = await fetcher(url);
    if (!res.ok) throw new Error(`videos.list answered ${res.status}`);
    const data = (await res.json()) as {
      items?: Array<{
        id?: string;
        snippet?: { channelTitle?: string };
        statistics?: { commentCount?: string };
        contentDetails?: { duration?: string };
      }>;
    };
    for (const it of data.items ?? []) {
      if (!it.id) continue;
      const channelTitle = it.snippet?.channelTitle ?? null;
      out.set(it.id, {
        channelTitle,
        isTopic: !!channelTitle && /\s-\sTopic$/.test(channelTitle),
        commentsOff: !!it.statistics && it.statistics.commentCount === undefined,
        durationSeconds: parseIsoDuration(it.contentDetails?.duration),
      });
    }
  }
  return out;
}

// --- complete -----------------------------------------------------------------

export type PostedCandidate = {
  source: MatchSource;
  externalId: string;
  url?: string | null;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  channelTitle?: string | null;
  videoType?: string | null;
  durationSeconds?: number | null;
  scores?: ReferenceScore[];
  extra?: Record<string, unknown> | null;
};

export type PostedReference = {
  kind: string;
  url?: string | null;
  previewUrl?: string | null;
  ok: boolean;
  durationSeconds?: number | null;
  error?: string | null;
};

export type CompleteBody = {
  searchId: string;
  references: PostedReference[];
  candidates: PostedCandidate[];
};

export type CandidateOutcome = {
  externalId: string;
  id: number | null;
  decision: MatchDecision | "known";
  reason: string | null;
  outcome: string | null;
};

export type CompleteResult =
  | { status: "not_found" }
  | {
      status: "done";
      decisions: CandidateOutcome[];
      /** What mkvid should upload a clip of, for the approval page (POST /mkvid/presave/clip). */
      wantClips: { refs: string[]; matches: Array<{ id: number; externalId: string }> };
      nextAt: number | null;
    };

const str = (x: unknown, max = 500): string | null =>
  typeof x === "string" && x.trim() ? x.trim().slice(0, max) : null;
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

/** Topic / comments verdict for a YouTube candidate: videos.list when it answered, else innertube's art-track type. */
function youtubeVerdict(
  facts: VideoFacts | undefined,
  videoType: string | null,
): { isTopic: boolean | null; commentsOff: boolean | null } {
  if (facts) return { isTopic: facts.isTopic, commentsOff: facts.commentsOff };
  return { isTopic: videoType === "MUSIC_VIDEO_TYPE_ATV" ? true : null, commentsOff: null };
}

/**
 * mkvid's result for one search: every new candidate stored with its
 * decision; the best auto-approved one applied (found, or ripped); one push
 * when candidates wait for review. A candidate already known for this
 * presave is not stored again (`decision: 'known'`). Never re-decides a
 * stored candidate.
 */
export async function completeSearchJob(
  env: Env,
  body: CompleteBody,
  log: Logger,
  opts: { fetcher?: typeof fetch; now?: number } = {},
): Promise<CompleteResult> {
  const now = opts.now ?? Date.now();
  const id = parseSearchId(body.searchId);
  if (!id) return { status: "not_found" };
  const db = dbOf(env);
  const search = await db
    .prepare("SELECT * FROM presave_match_searches WHERE presave_id = ? AND kind = ?")
    .bind(id.presaveId, id.kind)
    .first<SearchRow>();
  const p = await presaveLite(env, id.presaveId);
  if (!search || !p) return { status: "not_found" };
  const settings = (await getAppSettings(env)).presaveMatch;
  const waiting = p.stage === "links" && !p.youtube_video_id;

  // The YouTube facts (channel, comments, length) for every YouTube candidate, in one call.
  const ytIds = body.candidates.filter((c) => c.source === "ytm").map((c) => c.externalId);
  let facts = new Map<string, VideoFacts>();
  if (ytIds.length && env.YOUTUBE_API_KEY) {
    try {
      facts = await fetchVideoFacts(ytIds, env.YOUTUBE_API_KEY, opts.fetcher);
    } catch (e) {
      log.warn("presave_match.video_facts_failed", { presaveId: p.id, ...errorFields(e) });
    }
  }

  const decisions: CandidateOutcome[] = [];
  const approvedIds: Array<{ id: number; audio: number }> = [];
  const reviewIds: number[] = [];
  for (const c of body.candidates) {
    const externalId = str(c.externalId, 1500);
    if (!externalId || !MATCH_SOURCES.includes(c.source)) continue;
    const f = c.source === "ytm" ? facts.get(externalId) : undefined;
    const duration = num(c.durationSeconds) ?? f?.durationSeconds ?? null;
    const ns = nameScore(
      { artist: p.artist, title: p.title },
      {
        artist: str(c.artist) ?? str(c.channelTitle) ?? f?.channelTitle ?? null,
        title: str(c.title),
      },
    );
    const scores = (Array.isArray(c.scores) ? c.scores : []).slice(0, 10).map((x) => ({
      ref: String(x?.ref ?? "").slice(0, 40),
      score: num(x?.score),
      ber: num(x?.ber),
      offsetSeconds: num(x?.offsetSeconds),
      overlapSeconds: num(x?.overlapSeconds),
    }));
    const verdict = decideMatch(
      { source: c.source, durationSeconds: duration, nameScore: ns, scores },
      p.duration_seconds,
      settings,
    );
    const yt = c.source === "ytm" ? youtubeVerdict(f, str(c.videoType, 60)) : null;
    const decision: MatchDecision = waiting ? verdict.decision : "superseded";
    const reason = waiting ? verdict.reason : `the pre-save is ${p.stage} already`;
    const ins = await db
      .prepare(
        `INSERT INTO presave_matches (presave_id, source, external_id, url, title, artist, album, channel_title, video_type, is_topic, comments_off,
           duration_seconds, name_score, audio_score, scores, extra, decision, decided_by, reason, created_at, updated_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (presave_id, source, external_id) DO NOTHING`,
      )
      .bind(
        p.id,
        c.source,
        externalId,
        str(c.url, 1500),
        str(c.title),
        str(c.artist),
        str(c.album),
        str(c.channelTitle) ?? f?.channelTitle ?? null,
        str(c.videoType, 60),
        yt?.isTopic === null || yt === null ? null : yt.isTopic ? 1 : 0,
        yt?.commentsOff === null || yt === null ? null : yt.commentsOff ? 1 : 0,
        duration,
        ns,
        verdict.audioScore,
        JSON.stringify(scores),
        c.extra && typeof c.extra === "object" ? JSON.stringify(c.extra).slice(0, 4000) : null,
        decision,
        decision === "review" ? null : "auto",
        reason,
        now,
        now,
        decision === "review" ? null : now,
      )
      .run();
    if ((ins.meta.changes ?? 0) === 0) {
      decisions.push({ externalId, id: null, decision: "known", reason: null, outcome: null });
      continue;
    }
    const rowId = Number(ins.meta.last_row_id);
    decisions.push({ externalId, id: rowId, decision, reason, outcome: null });
    if (decision === "auto_approved")
      approvedIds.push({ id: rowId, audio: verdict.audioScore ?? 0 });
    if (decision === "review") reviewIds.push(rowId);
  }

  // The best auto-approved candidate is applied; it supersedes the rest of the queue for this track.
  approvedIds.sort((a, b) => b.audio - a.audio);
  if (approvedIds.length) {
    const best = approvedIds[0]!;
    const r = await applyApproval(env, best.id, "auto", log, now);
    const d = decisions.find((x) => x.id === best.id);
    if (d) d.outcome = r.outcome;
    for (const other of approvedIds.slice(1)) {
      await db
        .prepare(
          "UPDATE presave_matches SET decision = 'superseded', reason = 'another candidate was approved', updated_at = ? WHERE id = ?",
        )
        .bind(now, other.id)
        .run();
      const od = decisions.find((x) => x.id === other.id);
      if (od) od.decision = "superseded";
    }
    if (r.ok) {
      for (const d2 of decisions)
        if (d2.id && reviewIds.includes(d2.id)) d2.decision = "superseded";
      reviewIds.length = 0;
    }
  }

  const references: StoredReference[] = (Array.isArray(body.references) ? body.references : [])
    .slice(0, 10)
    .map((r) => ({
      kind: String(r?.kind ?? "").slice(0, 40),
      url: str(r?.url, 1500),
      previewUrl: str(r?.previewUrl, 1500),
      ok: !!r?.ok,
      durationSeconds: num(r?.durationSeconds),
      clipKey: null,
      error: str(r?.error),
    }));
  const searches = Number(search.searches) + 1;
  const nextAt = searches >= settings.maxSearches ? null : now + settings.researchDays * DAY_MS;
  // Clips of the last search's references are replaced by this search's.
  await deleteClips(
    env,
    parseJson<StoredReference[]>(search.refs, []).map((r) => r?.clipKey),
  );
  await db
    .prepare(
      `UPDATE presave_match_searches SET status = 'done', searches = ?, attempts = 0, next_at = ?, last_error = NULL, last_at = ?,
         candidates_seen = candidates_seen + ?, refs = ?, updated_at = ? WHERE presave_id = ? AND kind = ?`,
    )
    .bind(
      searches,
      nextAt,
      now,
      decisions.filter((d) => d.id !== null).length,
      JSON.stringify(references),
      now,
      p.id,
      id.kind,
    )
    .run();

  if (reviewIds.length && settings.notifyReview) {
    const firstYt = body.candidates.find((c) => c.source === "ytm")?.externalId ?? null;
    await sendPushToAll(
      env,
      presaveMatchReviewPayload({
        presaveId: p.id,
        artist: p.artist,
        title: p.title,
        count: reviewIds.length,
        artworkUrl: p.artwork_url,
        videoId: firstYt,
      }),
      log,
    ).catch(() => null);
  }
  log.info("presave_match.completed", {
    searchId: body.searchId,
    presaveId: p.id,
    candidates: body.candidates.length,
    decisions: decisions.map((d) => `${d.externalId.slice(0, 40)}:${d.decision}`),
    nextAt,
  });
  const reviewMatches = decisions.filter((d) => d.id !== null && d.decision === "review");
  const needClip = reviewMatches
    .map((d) => body.candidates.find((c) => c.externalId === d.externalId))
    .filter((c) => c && c.source !== "ytm");
  return {
    status: "done",
    decisions,
    wantClips: {
      refs: reviewMatches.length
        ? references.filter((r) => r.ok && !STABLE_PREVIEWS.has(r.kind)).map((r) => r.kind)
        : [],
      matches: reviewMatches
        .filter((d) => needClip.some((c) => c?.externalId === d.externalId))
        .map((d) => ({ id: d.id!, externalId: d.externalId })),
    },
    nextAt,
  };
}

// --- fail -----------------------------------------------------------------------

/**
 * mkvid could not search (YouTube Music refused or changed its answer, slskd
 * is down): due again after retryAfterSeconds, or 30 min doubling per
 * consecutive failure up to a day. A warning, never an owner action.
 */
export async function failSearchJob(
  env: Env,
  b: { searchId: string; error: string; retryAfterSeconds?: number | null },
  log: Logger,
  now = Date.now(),
): Promise<{ status: "not_found" } | { status: "failed"; attempts: number; nextAt: number }> {
  const id = parseSearchId(b.searchId);
  if (!id) return { status: "not_found" };
  const db = dbOf(env);
  const row = await db
    .prepare("SELECT attempts FROM presave_match_searches WHERE presave_id = ? AND kind = ?")
    .bind(id.presaveId, id.kind)
    .first<{ attempts: number }>();
  if (!row) return { status: "not_found" };
  const attempts = Number(row.attempts) + 1;
  const backoff = Math.min(DAY_MS, 30 * 60_000 * 2 ** (attempts - 1));
  const asked =
    typeof b.retryAfterSeconds === "number" && b.retryAfterSeconds > 0
      ? Math.min(7 * DAY_MS, b.retryAfterSeconds * 1000)
      : 0;
  const nextAt = now + Math.max(backoff, asked);
  await db
    .prepare(
      `UPDATE presave_match_searches SET status = 'failed', attempts = ?, next_at = ?, last_error = ?, last_at = ?, updated_at = ?
        WHERE presave_id = ? AND kind = ?`,
    )
    .bind(attempts, nextAt, b.error.slice(0, 1000), now, now, id.presaveId, id.kind)
    .run();
  log.warn("presave_match.search_failed", {
    searchId: b.searchId,
    attempts,
    nextAt,
    error: b.error.slice(0, 300),
  });
  return { status: "failed", attempts, nextAt };
}

// --- approve / reject -----------------------------------------------------------------

export type ApplyResult = {
  ok: boolean;
  outcome: "found" | "rip_queued" | "rip_not_queued" | null;
  message: string;
  trackUploadId?: number | null;
};

export async function getMatchRow(env: Env, id: number): Promise<MatchRow | null> {
  return dbOf(env).prepare("SELECT * FROM presave_matches WHERE id = ?").bind(id).first<MatchRow>();
}

/**
 * Approve one candidate (the owner, or decideMatch). A YouTube candidate that
 * is a Topic upload or has comments off becomes the presave's video (found);
 * any other candidate is queued for mkvid to rip and upload. The presave's
 * other candidates still in review are superseded once that worked.
 */
export async function applyApproval(
  env: Env,
  id: number,
  by: "auto" | "owner",
  log: Logger,
  now = Date.now(),
  opts: { fetcher?: typeof fetch } = {},
): Promise<ApplyResult> {
  const db = dbOf(env);
  let m = await getMatchRow(env, id);
  if (!m) return { ok: false, outcome: null, message: "no such candidate" };
  if (m.outcome === "found" || m.outcome === "rip_queued")
    return {
      ok: true,
      outcome: m.outcome,
      message: "already approved",
      trackUploadId: m.track_upload_id,
    };
  const p = await presaveLite(env, m.presave_id);
  if (!p) return { ok: false, outcome: null, message: "the pre-save is gone" };
  if (p.stage !== "links" || p.youtube_video_id)
    return { ok: false, outcome: null, message: `the pre-save is ${p.stage} already` };

  let result: ApplyResult;
  if (m.source === "ytm") {
    // The Topic / comments verdict is what decides found vs rip: read it now if it is unknown.
    if ((m.is_topic === null || m.comments_off === null) && env.YOUTUBE_API_KEY) {
      try {
        const f = (await fetchVideoFacts([m.external_id], env.YOUTUBE_API_KEY, opts.fetcher)).get(
          m.external_id,
        );
        if (f) {
          await db
            .prepare(
              "UPDATE presave_matches SET is_topic = ?, comments_off = ?, channel_title = COALESCE(channel_title, ?), updated_at = ? WHERE id = ?",
            )
            .bind(f.isTopic ? 1 : 0, f.commentsOff ? 1 : 0, f.channelTitle, now, id)
            .run();
          m = (await getMatchRow(env, id))!;
        }
      } catch (e) {
        log.warn("presave_match.video_facts_failed", { matchId: id, ...errorFields(e) });
      }
    }
    if (m.is_topic === 1 || m.comments_off === 1) {
      const w = await markPresaveFoundFromMatch(
        env,
        p.id,
        m.external_id,
        {
          matchId: m.id,
          by,
          audioScore: m.audio_score,
          topic: m.is_topic === 1,
          commentsOff: m.comments_off === 1,
        },
        log,
        now,
      );
      result =
        w && w.applied
          ? { ok: true, outcome: "found", message: "it is the pre-save's video now" }
          : { ok: false, outcome: null, message: "the pre-save changed meanwhile" };
    } else {
      const q = await queueMatchUpload(
        env,
        {
          presaveId: p.id,
          matchId: m.id,
          sourceName: "youtube",
          sourceUrl: `https://www.youtube.com/watch?v=${m.external_id}`,
          expectedDurationSeconds: m.duration_seconds,
          artist: m.artist,
          title: m.title,
        },
        log,
      );
      result = q.queued
        ? {
            ok: true,
            outcome: "rip_queued",
            message: "queued for mkvid to rip and upload",
            trackUploadId: q.uploadId,
          }
        : {
            ok: false,
            outcome: "rip_not_queued",
            message: `not queued: ${q.reason}`,
            trackUploadId: q.uploadId ?? null,
          };
    }
  } else {
    const extra = parseJson<Record<string, unknown>>(m.extra, {});
    const sourceUrl =
      m.source === "slsk"
        ? typeof extra.username === "string" && typeof extra.filename === "string"
          ? soulseekSourceUrl(extra.username, extra.filename)
          : null
        : m.url;
    const q = sourceUrl
      ? await queueMatchUpload(
          env,
          {
            presaveId: p.id,
            matchId: m.id,
            sourceName: m.source === "slsk" ? "soulseek" : "spotify",
            sourceUrl,
            expectedDurationSeconds: m.duration_seconds,
            artist: m.artist,
            title: m.title,
          },
          log,
        )
      : { queued: false, reason: "unsafe_source" as const, uploadId: undefined };
    result = q.queued
      ? {
          ok: true,
          outcome: "rip_queued",
          message: "queued for mkvid to download and upload",
          trackUploadId: q.uploadId,
        }
      : {
          ok: false,
          outcome: "rip_not_queued",
          message: `not queued: ${q.reason}`,
          trackUploadId: q.uploadId ?? null,
        };
  }
  await db
    .prepare(
      `UPDATE presave_matches SET decision = ?, decided_by = ?, decided_at = ?, outcome = ?, track_upload_id = ?, updated_at = ?,
         reason = CASE WHEN ? = 'owner' THEN 'approved by the owner' ELSE reason END WHERE id = ?`,
    )
    .bind(
      by === "auto" ? "auto_approved" : "approved",
      by,
      now,
      result.outcome,
      result.trackUploadId ?? null,
      now,
      by,
      id,
    )
    .run();
  if (result.ok) {
    await db
      .prepare(
        "UPDATE presave_matches SET decision = 'superseded', reason = 'another candidate was approved', updated_at = ? WHERE presave_id = ? AND decision = 'review' AND id != ?",
      )
      .bind(now, p.id, id)
      .run();
    await releaseClipsIfDone(env, p.id);
  }
  log.info("presave_match.approved", { matchId: id, presaveId: p.id, by, ...result });
  return result;
}

/** The owner rejected a candidate: kept (never analysed again), out of the queue. */
export async function rejectMatch(
  env: Env,
  id: number,
  now = Date.now(),
): Promise<MatchRow | null> {
  const m = await getMatchRow(env, id);
  if (!m) return null;
  if (m.decision === "review" || m.decision === "auto_rejected" || m.decision === "superseded") {
    await dbOf(env)
      .prepare(
        "UPDATE presave_matches SET decision = 'rejected', decided_by = 'owner', decided_at = ?, reason = 'rejected by the owner', updated_at = ? WHERE id = ?",
      )
      .bind(now, now, id)
      .run();
    await releaseClipsIfDone(env, m.presave_id);
  }
  return getMatchRow(env, id);
}

/** Search a pre-save (both kinds when Soulseek is on) at the next claim, even past maxSearches. */
export async function searchNow(env: Env, presaveId: number, now = Date.now()): Promise<boolean> {
  const p = await presaveLite(env, presaveId);
  if (!p || p.stage !== "links" || p.youtube_video_id) return false;
  const s = (await getAppSettings(env)).presaveMatch;
  const kinds: SearchKind[] = s.soulseek ? ["ytm", "slsk"] : ["ytm"];
  const db = dbOf(env);
  for (const kind of kinds)
    await db
      .prepare(
        `INSERT INTO presave_match_searches (presave_id, kind, status, next_at, created_at, updated_at) VALUES (?, ?, 'done', ?, ?, ?)
         ON CONFLICT (presave_id, kind) DO UPDATE SET next_at = excluded.next_at, status = CASE WHEN status = 'claimed' THEN status ELSE 'done' END, updated_at = excluded.updated_at`,
      )
      .bind(presaveId, kind, now - 1, now, now)
      .run();
  return true;
}

// --- clips --------------------------------------------------------------------

const CLIP_KEY = /^[a-f0-9-]{36}$/;

/** Store one clip mkvid made for the approval page (R2 IMAGES, presave-clips/<uuid>); returns its key. */
export async function storeClip(
  env: Env,
  target: { searchId: string; ref?: string | null; matchId?: number | null },
  body: ArrayBuffer,
  contentType: string,
): Promise<{ key: string } | { error: "not_found" | "no_storage" | "bad_target" }> {
  if (!env.IMAGES) return { error: "no_storage" };
  const id = parseSearchId(target.searchId);
  if (!id) return { error: "not_found" };
  const db = dbOf(env);
  const key = crypto.randomUUID();
  if (target.matchId) {
    const m = await getMatchRow(env, target.matchId);
    if (!m || m.presave_id !== id.presaveId) return { error: "not_found" };
    await env.IMAGES.put(CLIP_PREFIX + key, body, { httpMetadata: { contentType } });
    await deleteClips(env, [m.clip_key]);
    await db
      .prepare("UPDATE presave_matches SET clip_key = ?, updated_at = ? WHERE id = ?")
      .bind(key, Date.now(), m.id)
      .run();
    return { key };
  }
  if (!target.ref) return { error: "bad_target" };
  const s = await db
    .prepare("SELECT refs FROM presave_match_searches WHERE presave_id = ? AND kind = ?")
    .bind(id.presaveId, id.kind)
    .first<{ refs: string | null }>();
  const refs = parseJson<StoredReference[]>(s?.refs ?? null, []);
  const ref = Array.isArray(refs) ? refs.find((r) => r.kind === target.ref) : undefined;
  if (!ref) return { error: "not_found" };
  await env.IMAGES.put(CLIP_PREFIX + key, body, { httpMetadata: { contentType } });
  await deleteClips(env, [ref.clipKey]);
  ref.clipKey = key;
  await db
    .prepare("UPDATE presave_match_searches SET refs = ? WHERE presave_id = ? AND kind = ?")
    .bind(JSON.stringify(refs), id.presaveId, id.kind)
    .run();
  return { key };
}

export async function getClip(env: Env, key: string): Promise<R2ObjectBody | null> {
  if (!env.IMAGES || !CLIP_KEY.test(key)) return null;
  return env.IMAGES.get(CLIP_PREFIX + key);
}

async function deleteClips(
  env: Env,
  keys: ReadonlyArray<string | null | undefined>,
): Promise<void> {
  const ok = keys.filter((k): k is string => typeof k === "string" && CLIP_KEY.test(k));
  if (!env.IMAGES || ok.length === 0) return;
  try {
    await env.IMAGES.delete(ok.map((k) => CLIP_PREFIX + k));
  } catch {
    // a leftover clip is only storage
  }
}

/** Nothing of this presave waits for review any more: its clips go. */
async function releaseClipsIfDone(env: Env, presaveId: number): Promise<void> {
  const db = dbOf(env);
  const left = await db
    .prepare(
      "SELECT 1 AS x FROM presave_matches WHERE presave_id = ? AND decision = 'review' LIMIT 1",
    )
    .bind(presaveId)
    .first();
  if (left) return;
  const clips = await db
    .prepare("SELECT clip_key FROM presave_matches WHERE presave_id = ? AND clip_key IS NOT NULL")
    .bind(presaveId)
    .all<{ clip_key: string }>();
  const searches = await db
    .prepare("SELECT kind, refs FROM presave_match_searches WHERE presave_id = ?")
    .bind(presaveId)
    .all<{ kind: string; refs: string | null }>();
  const refKeys: string[] = [];
  for (const s of searches.results) {
    const refs = parseJson<StoredReference[]>(s.refs, []);
    if (!Array.isArray(refs)) continue;
    for (const r of refs) if (r.clipKey) refKeys.push(r.clipKey);
    if (refs.some((r) => r.clipKey))
      await db
        .prepare("UPDATE presave_match_searches SET refs = ? WHERE presave_id = ? AND kind = ?")
        .bind(JSON.stringify(refs.map((r) => ({ ...r, clipKey: null }))), presaveId, s.kind)
        .run();
  }
  await deleteClips(env, [...clips.results.map((c) => c.clip_key), ...refKeys]);
  await db
    .prepare(
      "UPDATE presave_matches SET clip_key = NULL WHERE presave_id = ? AND clip_key IS NOT NULL",
    )
    .bind(presaveId)
    .run();
}

// --- the approval page ----------------------------------------------------------------

export type MatchOut = {
  id: number;
  presaveId: number;
  source: MatchSource;
  externalId: string;
  url: string | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  channelTitle: string | null;
  videoType: string | null;
  isTopic: boolean | null;
  commentsOff: boolean | null;
  /** YouTube candidates: the video to embed. */
  videoId: string | null;
  durationSeconds: number | null;
  /** Candidate length minus the track's (s), null when either is unknown. */
  durationDelta: number | null;
  nameScore: number | null;
  audioScore: number | null;
  scores: ReferenceScore[];
  extra: Record<string, unknown> | null;
  clipUrl: string | null;
  decision: MatchDecision;
  decidedBy: string | null;
  reason: string | null;
  outcome: string | null;
  trackUploadId: number | null;
  createdAt: number;
  decidedAt: number | null;
};

export type ReferenceOut = {
  kind: string;
  url: string | null;
  /** What the page plays: the clip, else the preview file itself. */
  playUrl: string | null;
  ok: boolean;
  durationSeconds: number | null;
  error: string | null;
};

export type MatchGroup = {
  presave: {
    id: number;
    artist: string | null;
    title: string | null;
    artworkUrl: string | null;
    durationSeconds: number | null;
    trackUrl: string | null;
    stage: string;
  };
  references: ReferenceOut[];
  /** The last search's warning (YouTube Music or slskd refused), when it failed. */
  searchError: string | null;
  candidates: MatchOut[];
};

export const clipUrlOf = (key: string | null) =>
  key ? `/ui/api/presave-matches/clip/${encodeURIComponent(key)}` : null;

export function matchOut(m: MatchRow, presaveDuration: number | null): MatchOut {
  const scores = parseJson<ReferenceScore[]>(m.scores, []);
  return {
    id: Number(m.id),
    presaveId: Number(m.presave_id),
    source: m.source,
    externalId: m.external_id,
    url: m.url,
    title: m.title,
    artist: m.artist,
    album: m.album,
    channelTitle: m.channel_title,
    videoType: m.video_type,
    isTopic: m.is_topic === null ? null : m.is_topic === 1,
    commentsOff: m.comments_off === null ? null : m.comments_off === 1,
    videoId: m.source === "ytm" && /^[A-Za-z0-9_-]{11}$/.test(m.external_id) ? m.external_id : null,
    durationSeconds: m.duration_seconds,
    durationDelta:
      m.duration_seconds !== null && presaveDuration
        ? Math.round((m.duration_seconds - presaveDuration) * 10) / 10
        : null,
    nameScore: m.name_score,
    audioScore: m.audio_score,
    scores: Array.isArray(scores) ? scores : [],
    extra: m.extra ? parseJson<Record<string, unknown> | null>(m.extra, null) : null,
    clipUrl: clipUrlOf(m.clip_key),
    decision: m.decision,
    decidedBy: m.decided_by,
    reason: m.reason,
    outcome: m.outcome,
    trackUploadId: m.track_upload_id,
    createdAt: Number(m.created_at),
    decidedAt: m.decided_at === null ? null : Number(m.decided_at),
  };
}

type JoinedRow = MatchRow & {
  p_artist: string | null;
  p_title: string | null;
  p_artwork_url: string | null;
  p_duration: number | null;
  p_track_url: string | null;
  p_stage: string;
};

/**
 * The approval page's data. `review`: every presave with candidates waiting,
 * oldest first, each with its references (the last search's, both kinds) and
 * candidates (best audio first). `decided`: the latest decided candidates,
 * one group per presave, newest first. `presaveId` narrows either to one.
 */
export async function listMatchGroups(
  env: Env,
  q: { view: "review" | "decided"; presaveId?: number | null; limit?: number },
): Promise<MatchGroup[]> {
  const db = dbOf(env);
  const limit = Math.max(1, Math.min(500, q.limit ?? 300));
  const where = q.view === "review" ? "m.decision = 'review'" : "m.decision != 'review'";
  const res = await db
    .prepare(
      `SELECT m.*, p.artist AS p_artist, p.title AS p_title, p.artwork_url AS p_artwork_url, p.duration_seconds AS p_duration,
              p.track_url AS p_track_url, p.stage AS p_stage
         FROM presave_matches m JOIN presaves p ON p.id = m.presave_id
        WHERE ${where} ${q.presaveId ? "AND m.presave_id = ?" : ""}
        ORDER BY ${q.view === "review" ? "m.created_at ASC, m.audio_score DESC" : "COALESCE(m.decided_at, m.updated_at) DESC"}, m.id ASC
        LIMIT ?`,
    )
    .bind(...(q.presaveId ? [q.presaveId] : []), limit)
    .all<JoinedRow>();
  const groups = new Map<number, MatchGroup>();
  for (const r of res.results) {
    const pid = Number(r.presave_id);
    let g = groups.get(pid);
    if (!g) {
      g = {
        presave: {
          id: pid,
          artist: r.p_artist,
          title: r.p_title,
          artworkUrl: r.p_artwork_url,
          durationSeconds: r.p_duration,
          trackUrl: r.p_track_url,
          stage: r.p_stage,
        },
        references: [],
        searchError: null,
        candidates: [],
      };
      groups.set(pid, g);
    }
    g.candidates.push(matchOut(r, r.p_duration));
  }
  if (q.view === "review")
    for (const g of groups.values())
      g.candidates.sort((a, b) => (b.audioScore ?? -1) - (a.audioScore ?? -1));
  const ids = [...groups.keys()];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const s = await db
      .prepare(
        `SELECT presave_id, kind, refs, status, last_error FROM presave_match_searches WHERE presave_id IN (${chunk.map(() => "?").join(",")})`,
      )
      .bind(...chunk)
      .all<{
        presave_id: number;
        kind: string;
        refs: string | null;
        status: string;
        last_error: string | null;
      }>();
    for (const row of s.results) {
      const g = groups.get(Number(row.presave_id));
      if (!g) continue;
      if (row.status === "failed" && row.last_error) g.searchError = row.last_error;
      const refs = parseJson<StoredReference[]>(row.refs, []);
      if (!Array.isArray(refs)) continue;
      for (const ref of refs) {
        if (g.references.some((x) => x.kind === ref.kind)) continue;
        g.references.push({
          kind: ref.kind,
          url: ref.url,
          playUrl:
            clipUrlOf(ref.clipKey) ??
            (ref.previewUrl && /^https:\/\//.test(ref.previewUrl) ? ref.previewUrl : null),
          ok: !!ref.ok,
          durationSeconds: ref.durationSeconds,
          error: ref.error,
        });
      }
    }
  }
  return [...groups.values()];
}

export async function matchCounts(
  env: Env,
): Promise<Record<MatchDecision, number> & { presavesInReview: number }> {
  const db = dbOf(env);
  const out = Object.fromEntries(MATCH_DECISIONS.map((d) => [d, 0])) as Record<
    MatchDecision,
    number
  >;
  const res = await db
    .prepare("SELECT decision, COUNT(*) AS n FROM presave_matches GROUP BY decision")
    .all<{ decision: string; n: number }>();
  for (const r of res.results)
    if (r.decision in out) out[r.decision as MatchDecision] = Number(r.n);
  const pr = await db
    .prepare(
      "SELECT COUNT(DISTINCT presave_id) AS n FROM presave_matches WHERE decision = 'review'",
    )
    .first<{ n: number }>();
  return { ...out, presavesInReview: Number(pr?.n ?? 0) };
}

/** Search state per kind for one presave (the pre-saved track page). */
export async function searchStateOf(env: Env, presaveId: number): Promise<SearchRow[]> {
  const r = await dbOf(env)
    .prepare("SELECT * FROM presave_match_searches WHERE presave_id = ? ORDER BY kind")
    .bind(presaveId)
    .all<SearchRow>();
  return r.results;
}
