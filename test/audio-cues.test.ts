import { describe, expect, it } from "vitest";
import {
  AUDIO_DROPPED_NOTE,
  AUDIO_GATE,
  audioCueView,
  audioKey,
  gateAudioReports,
  overlayAudioCues,
  parseAudioEstimates,
  passesAudioGate,
  withoutAudioCues,
  type AudioEstimate,
} from "../src/lib/audio-cues";
import type { CueRow } from "../src/lib/apple-cues";

const row = (cueSeconds: number | null, i: number, over: Partial<CueRow> = {}): CueRow => ({
  cueSeconds,
  artist: `Artist ${i}`,
  title: `Title ${i}`,
  isId: false,
  layered: false,
  ...over,
});

/** Ten rows, the first five timed a minute apart, the last five untimed. */
const list = () => Array.from({ length: 10 }, (_, i) => row(i < 5 ? i * 60 : null, i));

const good = { share: 0.9, onset: 0.6, votes: 400 };
const est = (
  index: number,
  cueSeconds: number,
  over: Partial<AudioEstimate> = {},
): AudioEstimate => ({
  index,
  key: audioKey(`Artist ${index}`, `Title ${index}`),
  cueSeconds,
  ...good,
  ...over,
});

describe("audioKey", () => {
  it("ignores case, accents and punctuation", () => {
    expect(audioKey("Tiesto & KSHMR", "Secrets (Original Mix)")).toBe(
      audioKey("TIESTO  & kshmr", "secrets [original mix]"),
    );
    expect(audioKey("Beyonc\u00e9", "Halo")).toBe(audioKey("Beyonce", "Halo"));
    expect(audioKey(null, "X")).toBe(" - x");
  });
});

describe("passesAudioGate", () => {
  it("needs share >= 0.5, onset >= 0.3 and votes >= 100, each on its own", () => {
    expect(AUDIO_GATE).toEqual({ minShare: 0.5, minOnset: 0.3, minVotes: 100 });
    expect(passesAudioGate({ share: 0.5, onset: 0.3, votes: 100 })).toBe(true);
    expect(passesAudioGate({ share: 0.49, onset: 0.9, votes: 900 })).toBe(false);
    expect(passesAudioGate({ share: 0.9, onset: 0.29, votes: 900 })).toBe(false);
    expect(passesAudioGate({ share: 0.9, onset: 0.9, votes: 99 })).toBe(false);
    expect(passesAudioGate({ share: Number.NaN, onset: 0.9, votes: 900 })).toBe(false);
  });
});

describe("gateAudioReports", () => {
  it("keeps only gated rows the list can take, one per row, rounded, keyed by name", () => {
    const rows = list();
    rows[7] = { ...rows[7]!, layered: true };
    rows[8] = { ...rows[8]!, isId: true, artist: null, title: null };
    const out = gateAudioReports(rows, [
      { index: 6, cueSeconds: 330.4, share: 0.81234, onset: 0.5, votes: 250.2, source: "youtube" },
      { index: 6, cueSeconds: 999, ...good }, // a second report for the same row
      { index: 5, cueSeconds: 300, share: 0.4, onset: 0.9, votes: 900 }, // fails the share
      { index: 9, cueSeconds: 560, share: 0.9, onset: 0.2, votes: 900 }, // fails the onset
      { index: 0, cueSeconds: 10, ...good }, // row 0 starts at 0 anyway
      { index: 2, cueSeconds: 125, ...good }, // has a real cue
      { index: 7, cueSeconds: 420, ...good }, // a "w/" row
      { index: 8, cueSeconds: 480, ...good }, // an ID row
      { index: 42, cueSeconds: 600, ...good }, // not in the list
      { index: 9, cueSeconds: 0, ...good }, // no cue
    ]);
    expect(out).toEqual([
      {
        index: 6,
        key: audioKey("Artist 6", "Title 6"),
        cueSeconds: 330,
        share: 0.812,
        onset: 0.5,
        votes: 250,
        source: "youtube",
      },
    ]);
  });

  it("keeps a gated estimate behind an Apple cue", () => {
    const rows = list();
    rows[5] = { ...rows[5]!, cueSeconds: 301, cueFrom: "apple" };
    expect(gateAudioReports(rows, [{ index: 5, cueSeconds: 305, ...good }])).toHaveLength(1);
  });
});

describe("withoutAudioCues", () => {
  it("takes audio cues and their confidence out, leaving 1001tl and Apple cues", () => {
    const rows: CueRow[] = [
      row(0, 0),
      row(61, 1, { cueFrom: "apple" }),
      row(130, 2, { cueFrom: "audio", cueConfidence: 0.8 }),
    ];
    expect(withoutAudioCues(rows)).toEqual([
      row(0, 0),
      row(61, 1, { cueFrom: "apple" }),
      row(null, 2),
    ]);
  });
});

describe("overlayAudioCues", () => {
  it("fills untimed rows, marked with the source and confidence", () => {
    const r = overlayAudioCues(list(), [est(5, 300.4), est(6, 360, { share: 0.7 })]);
    expect(r.filled).toBe(2);
    expect(r.tracks[5]).toMatchObject({ cueSeconds: 300, cueFrom: "audio", cueConfidence: 0.9 });
    expect(r.tracks[6]).toMatchObject({ cueSeconds: 360, cueFrom: "audio", cueConfidence: 0.7 });
    expect(r.tracks[7]!.cueSeconds).toBeNull();
  });

  it("never overwrites a 1001tl or an Apple cue", () => {
    const rows = list();
    rows[5] = { ...rows[5]!, cueSeconds: 290, cueFrom: "apple" };
    const r = overlayAudioCues(rows, [est(3, 170), est(5, 300)]);
    expect(r.filled).toBe(0);
    expect(r.tracks[3]!.cueSeconds).toBe(180);
    expect(r.tracks[5]).toMatchObject({ cueSeconds: 290, cueFrom: "apple" });
  });

  it("only places a row strictly between the cues around it and before the end of the recording", () => {
    const rows = list();
    rows[8] = { ...rows[8]!, cueSeconds: 500 }; // a real cue after the gap
    const r = overlayAudioCues(
      rows,
      [
        est(5, 200), // before row 4's 240
        est(6, 400),
        est(7, 520), // after row 8's 500
        est(9, 700), // past the end
      ],
      { sourceSeconds: 650 },
    );
    expect(r.tracks.map((t) => t.cueSeconds)).toEqual([
      0,
      60,
      120,
      180,
      240,
      null,
      400,
      null,
      500,
      null,
    ]);
    expect(r.filled).toBe(1);
  });

  it("follows a row that moved, and skips an estimate whose row is gone or ambiguous", () => {
    const rows = list();
    // A row was inserted at 5: Artist 5 is now at index 6.
    rows.splice(5, 0, row(null, 99));
    const r = overlayAudioCues(rows, [est(5, 300)]);
    expect(r.tracks[6]).toMatchObject({ cueSeconds: 300, cueFrom: "audio" });
    expect(r.tracks[5]!.cueSeconds).toBeNull();
    // Two rows with the name: no guess.
    const twice = list();
    twice[5] = row(null, 98);
    twice[7] = { ...twice[7]!, artist: "Artist 5", title: "Title 5" };
    twice[8] = { ...twice[8]!, artist: "Artist 5", title: "Title 5" };
    expect(overlayAudioCues(twice, [est(5, 300)]).filled).toBe(0);
  });

  it("ignores estimates that do not pass the gate", () => {
    expect(overlayAudioCues(list(), [est(5, 300, { votes: 50 })]).filled).toBe(0);
  });
});

describe("parseAudioEstimates", () => {
  it("reads stored JSON and drops what is malformed", () => {
    expect(parseAudioEstimates(null)).toEqual([]);
    expect(parseAudioEstimates("not json")).toEqual([]);
    expect(parseAudioEstimates('{"a":1}')).toEqual([]);
    expect(parseAudioEstimates(JSON.stringify([est(5, 300), { index: "x" }, null]))).toEqual([
      est(5, 300),
    ]);
  });
});

describe("audioCueView", () => {
  const NOW = 1_000_000;
  it("is null when the estimate never ran", () => {
    expect(audioCueView({}, NOW)).toBeNull();
  });
  it("says running, retrying, done or dropped", () => {
    expect(audioCueView({ audio_claimed_at: NOW - 60, audio_note: "n" }, NOW)).toMatchObject({
      state: "running",
      note: "n",
    });
    // A lapsed claim with no run is not running.
    expect(audioCueView({ audio_claimed_at: NOW - 7 * 3600 }, NOW)).toBeNull();
    expect(audioCueView({ audio_attempts: 2, audio_next_at: NOW + 60 }, NOW)).toMatchObject({
      state: "retrying",
      nextAt: NOW + 60,
    });
    expect(audioCueView({ audio_ran_at: NOW - 5, audio_cues: 4 }, NOW)).toEqual({
      cues: 4,
      state: "done",
      note: null,
      nextAt: null,
      ranAt: NOW - 5,
    });
    expect(
      audioCueView({ audio_ran_at: NOW - 5, audio_note: AUDIO_DROPPED_NOTE }, NOW),
    ).toMatchObject({
      state: "dropped",
    });
  });
});
