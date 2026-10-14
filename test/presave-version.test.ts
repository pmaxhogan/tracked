// Version credits in titles (lib/presave-version.ts), on the titles of the
// 2026-10-14 live review queue: presave 6 (ATC - Around The World ... Odd Mob
// Remix) and 8 (50 Cent - Candy Shop (Odd Mob Remix)) got only other remixes,
// presave 7 (Odd Mob Loves California Edit) got the right one.
import { describe, it, expect } from "vitest";
import { compareVersions, parseVersion, sameCredit } from "../src/lib/presave-version";

const ATW = "Around The World (La La La La La) (Odd Mob Remix)";
const CANDY = "Candy Shop (Odd Mob Remix)";
const HOW = "This Is How We Do It (Odd Mob Loves California Edit)";

describe("parseVersion", () => {
  it("reads the remixer out of the credit", () => {
    expect(parseVersion(ATW).credited.map((p) => p.credit)).toEqual([["odd", "mob"]]);
    expect(parseVersion(HOW).credited.map((p) => p.credit)).toEqual([["odd", "mob", "california"]]);
    expect(parseVersion("Around The World (Dj Ithal Remix 2025)").credited[0]!.credit).toEqual([
      "ithal",
    ]);
  });
  it("lengths and labels of the same version are not credits", () => {
    for (const t of [
      "Damager",
      "JAWNS - Damager (Official Audio)",
      "Damager (Extended Mix)",
      "Damager (Original Mix)",
      "Damager (Radio Edit)",
      "Damager (feat. Someone)",
      "Damager (Remastered 2011)",
    ])
      expect(parseVersion(t).original).toBe(true);
  });
  it("alterations and mashups", () => {
    expect([...parseVersion("Around The World (Slowed & Reverb) Dethron Remix").altered]).toEqual([
      "slowed",
      "reverb",
    ]);
    expect(parseVersion("JAWNS - Damager [Bass Boosted]").altered.has("bass boosted")).toBe(true);
    expect(parseVersion("Candy Shop vs. In Da Club (Megamix)").mashup).toBe(true);
    expect(parseVersion("Candy Shop x Low (Alexander Vija Edit)").mashup).toBe(true);
    // " x " between artists before the dash is a collaboration, not a mashup.
    expect(parseVersion("Odd Mob x Omnom - Losing Control").mashup).toBe(false);
  });
  it("credits compare tolerantly", () => {
    expect(sameCredit(["odd", "mob"], ["odd", "mob", "california"])).toBe(true);
    expect(sameCredit(["odd", "mob"], ["edmood"])).toBe(false);
  });
});

describe("compareVersions: the presave 6 queue", () => {
  it.each([
    ["Around The World (La La La La La) (Edmood Remix)", "Edmood Remix"],
    ["ATC - Around The World (La La La La La) (Orlina Remix)", "Orlina Remix"],
    ["Around the World (La La La La La) [FiLo Project Techno Remix]", "FiLo Project Techno Remix"],
    ["Around The World (La La La La La) (Dj Ithal Remix 2025)", "Dj Ithal Remix 2025"],
    ["Around The World (La La La La La) (Slowed & Reverb) Dethron Remix", "slowed & reverb"],
    ["Around The World (La La La La La) - Omen's Free / DJ Nico Remix", "DJ Nico Remix"],
  ])("%s is another version", (cand, named) => {
    const v = compareVersions(ATW, cand);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.kind).toBe("different");
    expect(v.reason).toContain(named);
    expect(v.reason).toContain("wanted Odd Mob Remix");
  });
  it("the Odd Mob remix itself (any length) is it; the original is only by audio", () => {
    expect(compareVersions(ATW, "Around The World (La La La La La) (Odd Mob Remix)").ok).toBe(true);
    expect(compareVersions(ATW, "ATC - Around The World [Odd Mob Extended Remix]").ok).toBe(true);
    expect(compareVersions(ATW, "Around The World (La La La La La)")).toMatchObject({
      ok: false,
      kind: "original",
    });
  });
});

describe("compareVersions: presave 8 and 7", () => {
  it.each([
    "Candy Shop (Onderkoffer Remix)",
    "Candy Shop (Bobjim Remix)",
    "Candy Shop (Afro House Remix)",
    "Candy Shop (Omada Remix)",
  ])("%s is another version", (cand) => {
    expect(compareVersions(CANDY, cand)).toMatchObject({ ok: false, kind: "different" });
  });
  it("mashups and edits by someone else are out", () => {
    expect(compareVersions(CANDY, "Candy Shop x Low (Alexander Vija Edit)")).toMatchObject({
      ok: false,
      kind: "mashup",
    });
    expect(compareVersions(CANDY, "Candy Shop (Alexander Vija Edit)").ok).toBe(false);
  });
  it("Odd Mob Loves California Edit counts as Odd Mob", () => {
    expect(
      compareVersions(HOW, "Montell Jordan - This Is How We Do It (Odd Mob Loves California Edit)")
        .ok,
    ).toBe(true);
    expect(compareVersions(HOW, "This Is How We Do It (Odd Mob Edit)").ok).toBe(true);
  });
  it("an original pre-save: a remix or an alteration is another version, a length is not", () => {
    expect(compareVersions("Damager", "JAWNS - Damager (Official Audio)").ok).toBe(true);
    expect(compareVersions("Damager", "Damager (Extended Mix)").ok).toBe(true);
    expect(compareVersions("Damager", "JAWNS - Damager [Bass Boosted]").ok).toBe(false);
    expect(compareVersions("Levels", "Levels (Skrillex Remix)")).toMatchObject({
      ok: false,
      reason: "different version: Skrillex Remix, wanted the original",
    });
  });
});
