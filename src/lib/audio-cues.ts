/**
 * Audio cue estimation, the pure part (the D1 side is lib/audio-backstop.ts,
 * mkvid's side is its lib/audio-cues.ts + audio/match.py).
 *
 * A held mkvid list (too few cue times, after the Apple Music backstop) may
 * get cue times estimated from audio: mkvid fingerprints each identified
 * track's audio (found by name on YouTube, else Soulseek) against the set's
 * recording with landmark (peak-pair) hashes, then places the rows in their
 * known order. It reports, per row, the estimated cue and three confidence
 * measures:
 *   share  of the track's matched audio, the part within -15 s .. +4 min of the cue
 *   onset  the onset score at the cue (presence after it minus before it)
 *   votes  the track's best offset alignment (hash matches on one time line)
 * Only a row that passes all three (AUDIO_GATE) is stored, and it only ever
 * fills a row with no 1001tl or Apple cue, strictly between the cues around
 * it. On 8 fully timed sets the gated rows had a median error of 11 s, 85 %
 * within 30 s and 97 % within 60 s.
 */

import type { CueRow } from "./apple-cues";

/** The confidence gate a row must pass to be stored (approved 2026-10-18). */
export const AUDIO_GATE = { minShare: 0.5, minOnset: 0.3, minVotes: 100 } as const;

/** One row's estimate as mkvid reports it. `index` is the row's place in the stored list. */
export type AudioRowReport = {
  index: number;
  cueSeconds: number;
  share: number;
  onset: number;
  votes: number;
  /** Where the track's audio came from: youtube, soundcloud, soulseek (or a cache hit of one). */
  source?: string | null;
};

/** A stored (gated) estimate: the report plus the row's name key, so a changed list cannot misplace it. */
export type AudioEstimate = AudioRowReport & { key: string };

/** The row's name as a match key: "artist - title", lower case, accents and punctuation gone. */
export function audioKey(
  artist: string | null | undefined,
  title: string | null | undefined,
): string {
  const norm = (s: string | null | undefined) =>
    (s ?? "")
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  return `${norm(artist)} - ${norm(title)}`;
}

/** Whether a reported row passes AUDIO_GATE. */
export function passesAudioGate(r: Pick<AudioRowReport, "share" | "onset" | "votes">): boolean {
  return (
    Number.isFinite(r.share) &&
    Number.isFinite(r.onset) &&
    Number.isFinite(r.votes) &&
    r.share >= AUDIO_GATE.minShare &&
    r.onset >= AUDIO_GATE.minOnset &&
    r.votes >= AUDIO_GATE.minVotes
  );
}

/** A row the estimate may fill: a base row past row 0, identified, named. */
function estimable(r: CueRow, i: number): boolean {
  return i > 0 && !r.layered && !r.isId && !!r.title;
}

/**
 * The reports that pass the gate, as estimates to store: only rows the list
 * has, that may be estimated, with no real (1001tl) cue, one per row. `rows`
 * must be free of audio cues; a row with an Apple cue keeps its estimate
 * stored behind that cue (overlayAudioCues never overwrites it).
 */
export function gateAudioReports<T extends CueRow>(
  rows: readonly T[],
  reports: readonly AudioRowReport[],
): AudioEstimate[] {
  const seen = new Set<number>();
  const out: AudioEstimate[] = [];
  for (const r of reports) {
    const row = rows[r.index];
    if (!row || seen.has(r.index) || !estimable(row, r.index)) continue;
    if (row.cueFrom === undefined && typeof row.cueSeconds === "number") continue;
    if (!Number.isFinite(r.cueSeconds) || r.cueSeconds <= 0) continue;
    if (!passesAudioGate(r)) continue;
    seen.add(r.index);
    out.push({
      index: r.index,
      key: audioKey(row.artist, row.title),
      cueSeconds: Math.round(r.cueSeconds),
      share: Math.round(r.share * 1000) / 1000,
      onset: Math.round(r.onset * 1000) / 1000,
      votes: Math.round(r.votes),
      source: r.source ?? null,
    });
  }
  return out.sort((a, b) => a.index - b.index);
}

/** The rows with any audio-estimated cue taken out again. */
export function withoutAudioCues<T extends CueRow>(rows: readonly T[]): T[] {
  return rows.map((r) => {
    if (r.cueFrom !== "audio") return r;
    const { cueFrom: _drop, cueConfidence: _conf, ...rest } = r;
    return { ...rest, cueSeconds: null } as T;
  });
}

/** The cue of a row that bounds an estimate: any cue that is not itself an audio estimate (row 0 is 0 when it has none). */
function boundCue(r: CueRow, i: number): number | null {
  if (r.cueFrom === "audio") return null;
  if (typeof r.cueSeconds === "number" && Number.isFinite(r.cueSeconds)) return r.cueSeconds;
  return i === 0 ? 0 : null;
}

/** The row an estimate belongs to: its own index when the name still matches, else the one row with that name. */
function rowFor(rows: readonly CueRow[], e: AudioEstimate): number | null {
  const at = rows[e.index];
  if (at && estimable(at, e.index) && audioKey(at.artist, at.title) === e.key) return e.index;
  const same = rows
    .map((r, i) => (estimable(r, i) && audioKey(r.artist, r.title) === e.key ? i : -1))
    .filter((i) => i >= 0);
  return same.length === 1 ? same[0]! : null;
}

/**
 * Fill rows from stored estimates. `rows` must be free of audio cues
 * (withoutAudioCues) and may carry 1001tl and Apple cues, which are never
 * overwritten. An estimate is used only when its row (matched by index and
 * name) has no cue, the estimate passes the gate, and it falls strictly
 * between the nearest non-estimated cues before and after the row and before
 * the end of the recording when its length is known.
 */
export function overlayAudioCues<T extends CueRow>(
  rows: readonly T[],
  estimates: readonly AudioEstimate[],
  opts: { sourceSeconds?: number | null } = {},
): { tracks: T[]; filled: number } {
  const out = [...rows];
  let filled = 0;
  const end = opts.sourceSeconds != null && opts.sourceSeconds > 0 ? opts.sourceSeconds : Infinity;
  const used = new Set<number>();
  for (const e of estimates) {
    if (!passesAudioGate(e) || !Number.isFinite(e.cueSeconds)) continue;
    const i = rowFor(rows, e);
    if (i === null || used.has(i)) continue;
    const row = rows[i]!;
    if (typeof row.cueSeconds === "number" && Number.isFinite(row.cueSeconds)) continue;
    let lo = -1;
    let hi = end;
    rows.forEach((r, j) => {
      if (r.layered && j > 0) return;
      const c = boundCue(r, j);
      if (c === null) return;
      if (j < i) lo = Math.max(lo, c);
      else if (j > i) hi = Math.min(hi, c);
    });
    const cue = Math.round(e.cueSeconds);
    if (!(cue > lo && cue < hi)) continue;
    used.add(i);
    out[i] = { ...row, cueSeconds: cue, cueFrom: "audio", cueConfidence: e.share };
    filled++;
  }
  return { tracks: out, filled };
}

/** Parse stored estimates (mkvid_request_tracks.audio_estimates), dropping anything malformed. */
export function parseAudioEstimates(json: string | null | undefined): AudioEstimate[] {
  if (!json) return [];
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  return v.filter(
    (e): e is AudioEstimate =>
      !!e &&
      typeof e === "object" &&
      Number.isInteger((e as AudioEstimate).index) &&
      typeof (e as AudioEstimate).key === "string" &&
      typeof (e as AudioEstimate).cueSeconds === "number" &&
      typeof (e as AudioEstimate).share === "number" &&
      typeof (e as AudioEstimate).onset === "number" &&
      typeof (e as AudioEstimate).votes === "number",
  );
}

/**
 * A claim not renewed (progress) for this long is handed out again
 * (lib/audio-backstop.ts). mkvid renews every 10 minutes while it runs, so a
 * run that died with its container (a redeploy, a crash) frees its set
 * within this, after four missed renewals.
 */
export const AUDIO_CLAIM_TTL_SECONDS = 40 * 60;

/** The note left when the 1001tl cues alone reach 90 % and the estimates are dropped. */
export const AUDIO_DROPPED_NOTE = "estimates dropped: 1001tracklists has the cue times now";

/**
 * The note on a set whose audio run found its recording gone from its source
 * (lib/audio-backstop.ts failAudioJob): the request is parked as
 * recording_removed and the set is not tried again.
 */
export const AUDIO_REMOVED_NOTE_PREFIX = "recording removed: ";

/** The audio estimate's state for the panel (readinessFor), or null when it never ran for the set. */
export type AudioCueView = {
  cues: number;
  state: "running" | "retrying" | "done" | "dropped" | "removed";
  note: string | null;
  nextAt: number | null;
  ranAt: number | null;
};

export function audioCueView(
  x: {
    audio_cues?: number | null;
    audio_note?: string | null;
    audio_claimed_at?: number | null;
    audio_next_at?: number | null;
    audio_attempts?: number | null;
    audio_ran_at?: number | null;
  },
  now = Math.floor(Date.now() / 1000),
): AudioCueView | null {
  const cues = Number(x.audio_cues ?? 0);
  const claimed =
    x.audio_claimed_at != null && Number(x.audio_claimed_at) > now - AUDIO_CLAIM_TTL_SECONDS;
  const attempts = Number(x.audio_attempts ?? 0);
  const ranAt = x.audio_ran_at == null ? null : Number(x.audio_ran_at);
  const removed = !claimed && !!x.audio_note?.startsWith(AUDIO_REMOVED_NOTE_PREFIX);
  if (!claimed && !attempts && ranAt === null && cues === 0 && !removed) return null;
  const state = claimed
    ? "running"
    : removed
      ? "removed"
      : attempts > 0
        ? "retrying"
        : x.audio_note === AUDIO_DROPPED_NOTE
          ? "dropped"
          : "done";
  return {
    cues,
    state,
    note: x.audio_note ?? null,
    nextAt: x.audio_next_at == null ? null : Number(x.audio_next_at),
    ranAt,
  };
}
