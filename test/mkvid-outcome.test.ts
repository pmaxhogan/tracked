// Why an mkvid request ended (lib/mkvid-outcome.ts): the function, its SQL twin
// (run on the real schema's SQLite), and the plain-words lines.
import { describe, it, expect } from "vitest";
import { fakeD1 } from "./helpers/fake-d1";
import {
  MKVID_OUTCOMES,
  MKVID_OUTCOME_LABELS,
  isNoRecording,
  mkvidFailureKind,
  mkvidFailureKindSql,
  mkvidNoRecordingSql,
  mkvidOutcome,
  mkvidOutcomeDetail,
  mkvidOutcomeLine,
  mkvidOutcomeSql,
} from "../src/lib/mkvid-outcome";
import { KNOWN_PERMANENT_RE } from "../src/lib/mkvid";

// The five requests that read "failed" on 2026-10-12, as mkvid reported them.
const GONE_404 =
  "probe: yt-dlp exit 1: ERROR: [soundcloud] 2175021006: Unable to download JSON metadata: HTTP Error 404: Not Found (caused by <HTTPError 404: Not Found>)";
const SHORT_SC = "incomplete_recording: source is 1824s but the tracklist's last cue is at 7009s";
const SHORT_HT = "incomplete_recording: source is 3947s but the tracklist's last cue is at 8730s";

/** [status, error, the outcome expected]. */
const CASES: Array<[string, string | null, string | null]> = [
  ["failed", GONE_404, "recording_removed"],
  ["failed", SHORT_SC, "recording_short"],
  ["failed", SHORT_HT, "recording_short"],
  ["failed", "incomplete_recording", "recording_short"],
  ["failed", "INCOMPLETE_RECORDING: clip", "recording_short"],
  // The other source-gone answers, from mkvid's two checks before a download.
  [
    "failed",
    "probe: yt-dlp exit 1: ERROR: [soundcloud] 99: This track is private",
    "recording_removed",
  ],
  [
    "failed",
    "probe: yt-dlp exit 1: ERROR: [HearThisAt] x: This track was removed by the uploader",
    "recording_removed",
  ],
  ["failed", "probe: yt-dlp exit 1: ERROR: The track does not exist", "recording_removed"],
  [
    "failed",
    "probe: yt-dlp exit 1: ERROR: This track is not available in your country",
    "recording_removed",
  ],
  ["failed", "probe: yt-dlp exit 1: ERROR: geo-restricted", "recording_removed"],
  ["failed", "source: hearthis embed 13036034: HTTP 404", "recording_removed"],
  // Real failures: no text, an unknown text, a parked retry, a fault that may be ours.
  ["failed", null, "failed"],
  ["failed", "", "failed"],
  ["failed", "too many attempts", "failed"],
  ["failed", "something nobody has seen before", "failed"],
  [
    "failed",
    "Request had invalid authentication credentials. Expected OAuth 2 access token",
    "failed",
  ],
  ["failed", "source: hearthis embed 13036034: no track page link found", "failed"],
  [
    "failed",
    "probe: yt-dlp exit 1: ERROR: [HearThisAt] 13036034: Unable to download webpage: HTTP Error 403: Forbidden",
    "failed",
  ],
  [
    "failed",
    "probe: yt-dlp exit 1: ERROR: Unsupported URL: https://hearthis.at/embed/1/",
    "failed",
  ],
  [
    "failed",
    "probe: yt-dlp exit 1: ERROR: Requested format is not available. Use --list-formats",
    "failed",
  ],
  // A 404 inside a track id is not a missing recording.
  [
    "failed",
    "probe: yt-dlp exit 1: ERROR: [soundcloud] 214048835: Unable to extract data",
    "failed",
  ],
  // The same words outside the two source checks are about something else (a render, an upload).
  ["failed", "yt-dlp exit 1: ERROR: HTTP Error 404: Not Found", "failed"],
  ["failed", "upload: the video was removed by YouTube", "failed"],
  [
    "failed",
    "uploaded file is missing (removed or lost on restart) - re-upload and retry",
    "failed",
  ],
  // Other statuses.
  ["done", null, "done"],
  ["done", GONE_404, "done"],
  ["banned", "banned from the panel", "banned"],
  ["superseded", "1001tracklists now has abcdefghijk", "has_recording"],
  ["superseded", "set already resolves to abcdefghijk (1001tl)", "has_recording"],
  ["superseded", "set already resolves to abcdefghijk (mkvid)", "superseded"],
  [
    "superseded",
    "same tracklist as https://x/tracklist/1/a.html, already rendered as abcdefghijk",
    "duplicate",
  ],
  [
    "superseded",
    "duplicate of the same 1001tracklists id under another URL (removed by hand)",
    "duplicate",
  ],
  ["superseded", null, "superseded"],
  ["superseded", SHORT_SC, "superseded"],
  ["pending", GONE_404, null],
  ["claimed", null, null],
];

describe("mkvidOutcome", () => {
  it("splits failed into the two no-recording kinds and real failures, and superseded by its cause", () => {
    for (const [status, error, want] of CASES)
      expect([status, error, mkvidOutcome({ status, error })]).toEqual([status, error, want]);
    expect(mkvidFailureKind(GONE_404)).toBe("recording_removed");
    expect(mkvidFailureKind(undefined)).toBe("failed");
    expect([
      isNoRecording("recording_removed"),
      isNoRecording("recording_short"),
      isNoRecording("failed"),
      isNoRecording(null),
    ]).toEqual([true, true, false, false]);
    expect(Object.keys(MKVID_OUTCOME_LABELS).sort()).toEqual([...MKVID_OUTCOMES].sort());
    // Every no-recording text is one the Worker already accepts as final (failMkvidRequest).
    for (const [status, error, want] of CASES)
      if (status === "failed" && isNoRecording(want))
        expect([error, KNOWN_PERMANENT_RE.test(error!)]).toEqual([error, true]);
  });

  it("the SQL expressions agree with the function on every case", async () => {
    const db = fakeD1();
    const one = async (expr: string, status: string, error: string | null) =>
      (await db
        .prepare(`SELECT ${expr} AS v FROM (SELECT ? AS status, ? AS error)`)
        .bind(status, error)
        .first<{ v: string | number | null }>())!.v;
    for (const [status, error] of CASES) {
      const outcome = mkvidOutcome({ status, error });
      expect([status, error, await one(mkvidOutcomeSql("status", "error"), status, error)]).toEqual(
        [status, error, outcome],
      );
      expect([
        status,
        error,
        await one(mkvidFailureKindSql("status", "error"), status, error),
      ]).toEqual([status, error, status === "failed" ? outcome : status]);
      expect([error, await one(mkvidNoRecordingSql("error"), status, error)]).toEqual([
        error,
        isNoRecording(mkvidFailureKind(error)) ? 1 : 0,
      ]);
    }
  });

  it("says a no-recording outcome in plain words, with the durations or what the source answered", () => {
    expect(mkvidOutcomeLine({ status: "failed", error: SHORT_SC, source: "soundcloud" })).toBe(
      "The recording is 30:24 long, but the last track starts at 1:56:49.",
    );
    expect(mkvidOutcomeLine({ status: "failed", error: SHORT_HT, source: "hearthis" })).toBe(
      "The recording is 1:05:47 long, but the last track starts at 2:25:30.",
    );
    expect(
      mkvidOutcomeLine({ status: "failed", error: "incomplete_recording", source: "soundcloud" }),
    ).toBe("The recording ends before the tracklist does.");
    expect(mkvidOutcomeLine({ status: "failed", error: GONE_404, source: "soundcloud" })).toBe(
      'The recording is gone from SoundCloud (the link answers "not found").',
    );
    expect(
      mkvidOutcomeLine({
        status: "failed",
        error: "probe: yt-dlp exit 1: ERROR: This track is private",
        source: "hearthis",
      }),
    ).toBe("The recording is gone from hearthis.at (it is private now).");
    expect(
      mkvidOutcomeLine({
        status: "failed",
        error: "probe: yt-dlp exit 1: ERROR: This track is not available",
        source: null,
      }),
    ).toBe("The recording is gone from its source (it is not available).");
    const detail = mkvidOutcomeDetail({ status: "failed", error: GONE_404, source: "soundcloud" })!;
    expect(detail).toContain("The recording is gone from SoundCloud");
    expect(detail).toContain("Nothing to do");
    expect(mkvidOutcomeDetail({ status: "failed", error: SHORT_SC })).toContain(
      "a part of the set",
    );
    // Nothing for a real failure, or for a request that did not fail.
    for (const r of [
      { status: "failed", error: "too many attempts" },
      { status: "done", error: null },
      { status: "pending", error: GONE_404 },
    ]) {
      expect(mkvidOutcomeLine(r)).toBeNull();
      expect(mkvidOutcomeDetail(r)).toBeNull();
    }
  });
});
