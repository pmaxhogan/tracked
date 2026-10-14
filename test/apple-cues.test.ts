import { describe, expect, it } from "vitest";
import {
  matchRows,
  nameSimilarity,
  nameTokens,
  planAppleCues,
  withoutAppleCues,
  type AppleTrack,
  type CueRow,
} from "../src/lib/apple-cues";

const row = (
  title: string | null,
  cueSeconds: number | null,
  extra: Partial<CueRow> = {},
): CueRow => ({
  cueSeconds,
  artist: "Someone",
  title,
  isId: title === null,
  layered: false,
  ...extra,
});
const at = (name: string, seconds: number): AppleTrack => ({ name, artist: null, seconds });
const NAMES = [
  "Opus",
  "Sirens",
  "Losing It",
  "Cola",
  "Pjanoo",
  "Strobe",
  "Cafe Del Mar",
  "Silence",
  "Insomnia",
  "Children",
];
const OPTS = { minMatchShare: 0.7, tolerancePct: 3, toleranceSeconds: 120, sourceSeconds: null };

describe("nameTokens / nameSimilarity", () => {
  it("normalises accents, case, feat. clauses, mix brackets and punctuation", () => {
    expect(nameTokens("Café Del Mar (feat. Someone) [Mixed]")).toEqual(["cafe", "del", "mar"]);
    expect(nameTokens("Glow (Original Mix)")).toEqual(["glow"]);
    expect(nameTokens("Glow ft. X Y")).toEqual(["glow"]);
    expect(nameTokens("Rock & Roll!")).toEqual(["rock", "roll"]);
  });
  it("keeps remix credits so different remixes differ", () => {
    expect(nameSimilarity("Song (Eli Brown Remix)", "Song (Eli Brown Remix) [Mixed]")).toBe(1);
    expect(nameSimilarity("Song (Eli Brown Remix)", "Song (Other Remix) (Mixed)")).toBeLessThan(
      0.7,
    );
  });
  it("matches either half of an Apple mashup", () => {
    expect(nameSimilarity("So Get Up", "Glow / So Get Up (Mixed)")).toBe(1);
    expect(nameSimilarity("Glow", "Glow / So Get Up (Mixed)")).toBe(1);
  });
});

describe("matchRows", () => {
  it("is order-aware and skips ID rows, layered rows, reordered and missing rows", () => {
    const rows = [
      row("Alpha", 0),
      row(null, null), // ID
      row("Beta", null),
      row("Gamma Layer", null, { layered: true }),
      row("Delta", null),
      row("Missing On Apple", null),
      row("Epsilon", null),
    ];
    const apple = [
      at("Alpha (Mixed)", 100),
      at("Unknown ID Track", 50),
      at("Beta", 100),
      at("Epsilon", 100),
      at("Delta", 100),
    ];
    const m = matchRows(rows, apple);
    expect(m.get(0)).toBe(0);
    expect(m.get(1)).toBeUndefined();
    expect(m.get(2)).toBe(2);
    expect(m.has(3)).toBe(false);
    expect(m.has(5)).toBe(false);
    // Delta and Epsilon are swapped on Apple: only one of them can be kept in order.
    expect([m.has(4), m.has(6)].filter(Boolean)).toHaveLength(1);
  });
  it("treats a title of just ID as unmatchable", () => {
    expect(matchRows([row("ID", 0, { isId: false })], [at("ID", 10)]).size).toBe(0);
  });
  it("matches an Apple name that carries the artist too", () => {
    const rows = [row("Opus", 0, { artist: "Eric Prydz" })];
    expect(matchRows(rows, [at("Eric Prydz - Opus (Mixed)", 10)]).get(0)).toBe(0);
    expect(
      matchRows(rows, [{ name: "Opus (Mixed)", artist: "Eric Prydz", seconds: 10 }]).get(0),
    ).toBe(0);
  });
});

describe("planAppleCues bounds", () => {
  it("never places a cue at or past the end of a recording of known length", () => {
    const names = [
      "Opus",
      "Sirens",
      "Losing It",
      "Cola",
      "Pjanoo",
      "Strobe",
      "Cafe Del Mar",
      "Silence",
      "Insomnia",
      "Children",
    ];
    const rows = names.map((n, i) => row(n, i === 0 ? 0 : i === 5 ? 1700 : null));
    const apple = names.map((n) => at(n, 300));
    const p = planAppleCues(rows, apple, {
      minMatchShare: 0.7,
      tolerancePct: 3,
      toleranceSeconds: 120,
      sourceSeconds: 2900,
    });
    expect(p.tracks[8]!.cueSeconds).toBe(2600);
    expect(p.tracks[9]!.cueSeconds).toBeNull();
  });
});

describe("planAppleCues", () => {
  // Ten tracks of 300 s on Apple; the set ran 2 % slow in its first half.
  const apple = Array.from({ length: 10 }, (_, i) => at(NAMES[i]!, 300));
  const rows = () => Array.from({ length: 10 }, (_, i) => row(NAMES[i]!, null));

  it("fills only uncued rows, aligned between the real cues around each gap", () => {
    const r = rows();
    r[0]!.cueSeconds = 0;
    r[5]!.cueSeconds = 1530; // Apple says 1500: 2 % slower
    const p = planAppleCues(r, apple, { ...OPTS, sourceSeconds: 3000 });
    expect(p.used).toBe(true);
    expect(p.filled).toBe(8);
    expect(p.tracks[0]!.cueSeconds).toBe(0);
    expect(p.tracks[5]!.cueSeconds).toBe(1530);
    expect(p.tracks[5]!.cueFrom).toBeUndefined();
    // Between 0 and 1530: scaled by 1530/1500.
    expect(p.tracks[1]).toMatchObject({ cueSeconds: 306, cueFrom: "apple" });
    expect(p.tracks[4]!.cueSeconds).toBe(1224);
    // After the last anchor: plain Apple durations from 1530, no drift carried in.
    expect(p.tracks[6]!.cueSeconds).toBe(1830);
    expect(p.tracks[9]!.cueSeconds).toBe(2730);
    expect(p.note).toBe("8 cues from Apple Music (10 of 10 tracks matched, album 50:00)");
  });

  it("never overwrites a real cue and keeps fills between the real cues around them", () => {
    const r = rows();
    r[3]!.cueSeconds = 500; // an unmatched row with a real cue: fills before it must stay below it
    r[3]!.title = "Unrelated";
    const p = planAppleCues(r, apple, { ...OPTS, sourceSeconds: 3000 });
    expect(p.tracks[3]!.cueSeconds).toBe(500);
    expect(p.tracks[1]!.cueSeconds).toBe(300);
    // 600 would pass the real cue 500 on row 3: left untimed; row 4 (1200) is past it.
    expect(p.tracks[2]!.cueSeconds).toBeNull();
  });

  it("does not use the album below the match threshold, and the threshold is tunable", () => {
    const r = rows();
    for (let i = 3; i < 10; i++) r[i]!.title = `Other ${i}`; // 3 of 10 match
    expect(planAppleCues(r, apple, { ...OPTS, sourceSeconds: 3000 })).toMatchObject({
      used: false,
      matched: 3,
      note: "weak match: 3 of 10 tracks matched the Apple Music album (70% needed)",
    });
    const r7 = rows();
    for (let i = 7; i < 10; i++) r7[i]!.title = `Other ${i}`; // exactly 70 %
    expect(planAppleCues(r7, apple, { ...OPTS, sourceSeconds: 3000 }).used).toBe(true);
    expect(
      planAppleCues(r7, apple, { ...OPTS, minMatchShare: 0.8, sourceSeconds: 3000 }).used,
    ).toBe(false);
    expect(planAppleCues(r, apple, { ...OPTS, minMatchShare: 0.3, sourceSeconds: 3000 }).used).toBe(
      true,
    );
  });

  it("counts ID rows in the denominator", () => {
    const r = rows();
    for (let i = 6; i < 10; i++) r[i] = row(null, null);
    expect(planAppleCues(r, apple, { ...OPTS, sourceSeconds: 3000 }).note).toMatch(
      /^weak match: 6 of 10/,
    );
  });

  it("skips an album whose length does not match the source", () => {
    const p = planAppleCues(rows(), apple, { ...OPTS, sourceSeconds: 3765 });
    expect(p).toMatchObject({
      used: false,
      note: "length mismatch: album 50:00 vs source 1:02:45",
    });
    // 3 % of 3000 is 90 s, so the 2 min floor decides: 115 s off is fine.
    expect(planAppleCues(rows(), apple, { ...OPTS, sourceSeconds: 3115 }).used).toBe(true);
    expect(planAppleCues(rows(), apple, { ...OPTS, sourceSeconds: 3125 }).used).toBe(false);
  });

  it("with an unknown source length, uses the album only when the real cues agree with it", () => {
    const none = planAppleCues(rows(), apple, OPTS);
    expect(none).toMatchObject({
      used: false,
      note: "source length unknown and no cue time confirms the Apple Music album",
    });
    const agree = rows();
    agree[5]!.cueSeconds = 1530;
    expect(planAppleCues(agree, apple, OPTS).used).toBe(true);
    const drift = rows();
    drift[5]!.cueSeconds = 1900; // 400 s off over 1500 s: a studio edit
    expect(planAppleCues(drift, apple, OPTS)).toMatchObject({
      used: false,
      note: "source length unknown and the cue times do not agree with the Apple Music album",
    });
    const shorter = rows();
    shorter[5]!.cueSeconds = 1500;
    shorter[9]!.cueSeconds = 3100; // last cue past the album end
    shorter[9]!.title = "Not On Apple";
    expect(planAppleCues(shorter, apple, OPTS).note).toBe(
      "album 50:00 is shorter than the last cue 51:40",
    );
  });

  it("withoutAppleCues resets only filled cues, so a re-run is idempotent", () => {
    const r = rows();
    r[5]!.cueSeconds = 1530;
    const first = planAppleCues(r, apple, { ...OPTS, sourceSeconds: 3000 });
    const again = planAppleCues(withoutAppleCues(first.tracks), apple, {
      ...OPTS,
      sourceSeconds: 3000,
    });
    expect(again.tracks).toEqual(first.tracks);
    expect(withoutAppleCues(first.tracks)[1]).toEqual(r[1]);
  });
});
