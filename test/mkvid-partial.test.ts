import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";
import { fakeKV } from "./helpers/fake-kv";
import { fakeD1 } from "./helpers/fake-d1";
import {
  claimMkvidRequest,
  completeMkvidRequest,
  enqueueMkvidRequest as enqueueRaw,
  extractSetAudioSources,
  failMkvidRequest,
  getMkvidRequest,
  parseMkvidSources,
  partialNote,
  replaceMkvidSource,
  retryMkvidRequest,
  type MkvidSource,
} from "../src/lib/mkvid";
import { extractSetFacts, saveSetFacts } from "../src/lib/playlist-hygiene";
import { MkvidClaimResponse } from "../src/schemas";
import { saveSubState } from "../src/lib/sync-store";
import { makeLogger } from "../src/lib/log";
import { storeVerifiedList } from "./helpers/mkvid-lists";

vi.mock("../src/lib/youtube-playlists", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/youtube-playlists")>(
    "../src/lib/youtube-playlists",
  );
  return {
    ...actual,
    findPlaylistByTitle: vi.fn(),
    createPlaylist: vi.fn(),
    listPlaylistVideoIds: vi.fn(),
    addVideoToPlaylist: vi.fn(),
    removeVideoFromPlaylist: vi.fn(),
  };
});
import { findPlaylistByTitle, listPlaylistVideoIds } from "../src/lib/youtube-playlists";

const log = makeLogger({ task: "test" });
const NOW = Math.floor(Date.now() / 1000);

function makeEnv(): Env {
  return {
    CACHE: fakeKV(),
    DB: fakeD1(),
    SUBS: fakeKV(),
    API_TOKEN: "t",
    YOUTUBE_API_KEY: "k",
    MKVID_TOKEN: "mk",
  } as Env;
}

const SC = (id: number): MkvidSource => ({
  kind: "soundcloud",
  url: `https://api.soundcloud.com/tracks/${id}`,
});
const input = {
  slug: "isoknock",
  setUrl:
    "https://www.1001tracklists.com/tracklist/18hmm5w9/isoknock-night-1-shrine-expo-hall-los-angeles-united-states-2023-11-18.html",
  artistName: "ISOKNOCK",
  setTitle: "ISOKNOCK @ Night 1, Shrine Expo Hall LA 2023-11-18",
  setDate: "2023-11-18",
  source: SC(1669080213),
  lastCueSeconds: 1630,
  trackCount: 20,
  idedCount: 20,
};
const PARTIAL = "partial_source: 2 of 187 fragments came back empty (~20 s missing at 20:49)";

async function queued(env: Env) {
  expect(await enqueueRaw(env, input)).toBe("queued");
  await storeVerifiedList(env, input.setUrl);
  return (await claimMkvidRequest(env, log))!;
}
/** The set page as the sync last read it: these recordings on it. */
async function pageHas(env: Env, sources: MkvidSource[] | null) {
  await saveSetFacts(env, {
    ...extractSetFacts(input.slug, input.setUrl, "<html></html>", null, NOW),
    audioSources: sources,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  (listPlaylistVideoIds as ReturnType<typeof vi.fn>).mockImplementation(
    async () => new Set<string>(),
  );
});

describe("extractSetAudioSources", () => {
  const player = (id: string, seconds: number) =>
    `new AudioPlayerSC("scWidget_${id}", { idPlayer: "${id}", source: "x", duration: "${seconds}" });`;
  it("ISOKNOCK's page: one SoundCloud player, nothing else", () => {
    expect(extractSetAudioSources(`<script>${player("1669080213", 1869)}</script>`, 1630)).toEqual([
      SC(1669080213),
    ]);
  });
  it("the pick first, then the other players that reach the last cue, then hearthis", () => {
    const html =
      `<script>${player("1", 600)}${player("2", 3700)}${player("3", 3550)}</script>` +
      '<iframe src="https://app.hearthis.at/embed/77/transparent_black/"></iframe>' +
      '<a href="https://hearthis.at/dj/the-set/">same track</a>';
    expect(extractSetAudioSources(html, 3600)).toEqual([
      SC(2),
      SC(3),
      { kind: "hearthis", url: "https://hearthis.at/embed/77/" },
    ]);
    // Last cue unknown: every player, page order (the first is the pick).
    expect(
      extractSetAudioSources(`<script>${player("1", 600)}${player("2", 3700)}</script>`),
    ).toEqual([SC(1), SC(2)]);
  });
  it("hearthis track pages when there is no embed; nothing on a page without recordings", () => {
    expect(
      extractSetAudioSources(
        '<a href="https://hearthis.at/dj/a/">a</a> <a href="https://hearthis.at/dj/b/">b</a>',
      ),
    ).toEqual([
      { kind: "hearthis", url: "https://hearthis.at/dj/a/" },
      { kind: "hearthis", url: "https://hearthis.at/dj/b/" },
    ]);
    expect(extractSetAudioSources("<html></html>")).toEqual([]);
  });
  it("the page facts keep the list; a fetch that read none keeps the stored one", async () => {
    const env = makeEnv();
    await saveSetFacts(
      env,
      extractSetFacts(input.slug, input.setUrl, `<script>${player("9", 4000)}</script>`, null, NOW),
    );
    const row = await env.DB.prepare("SELECT audio_sources FROM set_media_facts WHERE set_url = ?")
      .bind(input.setUrl)
      .first<{ audio_sources: string }>();
    expect(parseMkvidSources(row!.audio_sources)).toEqual([SC(9)]);
    await saveSetFacts(env, {
      ...extractSetFacts(input.slug, input.setUrl, "", null, NOW),
      audioSources: null,
    });
    const again = await env.DB.prepare(
      "SELECT audio_sources FROM set_media_facts WHERE set_url = ?",
    )
      .bind(input.setUrl)
      .first<{ audio_sources: string }>();
    expect(parseMkvidSources(again!.audio_sources)).toEqual([SC(9)]);
  });
  it("parseMkvidSources drops junk", () => {
    expect(
      parseMkvidSources('[{"kind":"soundcloud","url":"u"},{"kind":"mixcloud","url":"m"},null,3]'),
    ).toEqual([{ kind: "soundcloud", url: "u" }]);
    expect(parseMkvidSources("nope")).toEqual([]);
    expect(parseMkvidSources(null)).toEqual([]);
  });
});

describe("partial_source: another recording first, the partial one when none is left", () => {
  it("no other recording on the page (ISOKNOCK): back to pending with allowPartial, no attempt used", async () => {
    const env = makeEnv();
    await pageHas(env, [input.source]);
    const req = await queued(env);
    expect(req.allowPartial).toBe(false);
    expect(MkvidClaimResponse.parse({ request: req }).request!.allowPartial).toBe(false);
    expect(await failMkvidRequest(env, { id: req.id, error: PARTIAL, jobId: "j1" }, log)).toEqual({
      status: "pending",
      attempts: 0,
    });
    expect((await getMkvidRequest(env, req.id))!).toMatchObject({
      status: "pending",
      allowPartial: true,
      sourceUrl: input.source.url,
      notBefore: null,
      error: PARTIAL,
    });
    // Handed out again at once, now allowed.
    const again = (await claimMkvidRequest(env, log))!;
    expect(again).toMatchObject({ id: req.id, allowPartial: true, attempts: 1 });
    // Said again although allowed (an older mkvid): an ordinary failure, with an attempt.
    expect(await failMkvidRequest(env, { id: req.id, error: PARTIAL }, log)).toMatchObject({
      status: "pending",
      attempts: 1,
    });
  });

  it("a page not read since the column existed counts as no other recording", async () => {
    const env = makeEnv();
    const req = await queued(env);
    await failMkvidRequest(env, { id: req.id, error: PARTIAL }, log);
    expect((await getMkvidRequest(env, req.id))!.allowPartial).toBe(true);
  });

  it("another recording on the page is tried first; when it too is partial, the first one is used", async () => {
    const env = makeEnv();
    await pageHas(env, [input.source, SC(2), SC(3)]);
    const req = await queued(env);
    await failMkvidRequest(env, { id: req.id, error: PARTIAL }, log);
    expect((await getMkvidRequest(env, req.id))!).toMatchObject({
      allowPartial: false,
      sourceUrl: SC(2).url,
    });
    await claimMkvidRequest(env, log);
    await failMkvidRequest(env, { id: req.id, error: PARTIAL }, log);
    expect((await getMkvidRequest(env, req.id))!).toMatchObject({
      allowPartial: false,
      sourceUrl: SC(3).url,
    });
    await claimMkvidRequest(env, log);
    await failMkvidRequest(env, { id: req.id, error: PARTIAL }, log);
    expect((await getMkvidRequest(env, req.id))!).toMatchObject({
      status: "pending",
      allowPartial: true,
      sourceUrl: input.source.url,
      attempts: 0,
    });
  });

  it("an alternative that fails for good falls back to the partial recording", async () => {
    const env = makeEnv();
    await pageHas(env, [input.source, SC(2)]);
    const req = await queued(env);
    await failMkvidRequest(env, { id: req.id, error: PARTIAL }, log);
    await claimMkvidRequest(env, log);
    const short = "incomplete_recording: source is 600s but the tracklist's last cue is at 1630s";
    expect(await failMkvidRequest(env, { id: req.id, error: short, permanent: true }, log)).toEqual(
      {
        status: "pending",
        attempts: 0,
      },
    );
    expect((await getMkvidRequest(env, req.id))!).toMatchObject({
      status: "pending",
      allowPartial: true,
      sourceUrl: input.source.url,
      error: short,
    });
    // Once allowed, a failure for good is final as always.
    await claimMkvidRequest(env, log);
    expect(
      await failMkvidRequest(env, { id: req.id, error: short, permanent: true }, log),
    ).toMatchObject({
      status: "failed",
    });
  });

  it("Retry keeps what was learnt; a new recording (sync or operator) starts over", async () => {
    const env = makeEnv();
    const req = await queued(env);
    await failMkvidRequest(env, { id: req.id, error: PARTIAL }, log);
    await env.DB.prepare("UPDATE mkvid_requests SET status = 'failed' WHERE id = ?")
      .bind(req.id)
      .run();
    expect(await retryMkvidRequest(env, req.id)).toBe(true);
    expect((await getMkvidRequest(env, req.id))!.allowPartial).toBe(true);
    expect((await replaceMkvidSource(env, req.id, SC(5).url)).ok).toBe(true);
    const row = await env.DB.prepare(
      "SELECT allow_partial, partial_tried FROM mkvid_requests WHERE id = ?",
    )
      .bind(req.id)
      .first<{ allow_partial: number; partial_tried: string | null }>();
    expect(row).toEqual({ allow_partial: 0, partial_tried: null });
  });
});

describe("a video made from a partial recording", () => {
  it("partialNote: the gap in a line, several stretches listed", () => {
    expect(partialNote({ missingSeconds: 20, ranges: [{ start: 1249, end: 1269 }] })).toBe(
      "~20 s missing at 20:49",
    );
    expect(
      partialNote({
        missingSeconds: 30.4,
        ranges: [
          { start: 5, end: 15 },
          { start: 3725, end: 3745 },
        ],
      }),
    ).toBe("~30 s missing at 0:05, 1:02:05");
    const many = Array.from({ length: 7 }, (_, i) => ({ start: i * 60, end: i * 60 + 10 }));
    expect(partialNote({ missingSeconds: 70, ranges: many })).toBe(
      "~70 s missing at 0:00, 1:00, 2:00, 3:00, 4:00, ...",
    );
    expect(partialNote(null)).toBeNull();
    expect(partialNote({ missingSeconds: 0, ranges: [] })).toBeNull();
  });

  it("the upload stores the note", async () => {
    const env = makeEnv();
    await saveSubState(env, input.slug, {
      playlistId: "PLartist",
      artistName: input.artistName,
      processedTracklistUrls: [input.setUrl],
      tracklistVideos: { [input.setUrl]: { videoId: null, checkedAt: NOW - 100 } },
    });
    (findPlaylistByTitle as ReturnType<typeof vi.fn>).mockImplementation(async (title: string) =>
      title.startsWith("All tracked artists") ? { id: "PLc", title } : { id: "PLartist", title },
    );
    const req = await queued(env);
    const r = await completeMkvidRequest(
      env,
      {
        id: req.id,
        videoId: "upload12345",
        partial: {
          missingSeconds: 20,
          ranges: [{ start: 1249, end: 1269 }],
          fragments: [126, 127],
          totalFragments: 187,
        },
      },
      "tok",
      log,
    );
    expect(r.status).toBe("done");
    expect((await getMkvidRequest(env, req.id))!).toMatchObject({
      status: "done",
      partialNote: "~20 s missing at 20:49",
    });
  });
});
