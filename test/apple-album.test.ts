import { describe, expect, it, vi } from "vitest";
import {
  APPLE_ALBUM_KEY,
  appleAlbumRef,
  fetchAppleAlbum,
  findDeveloperToken,
  parseAlbumJsonLd,
  parseAmpAlbum,
} from "../src/lib/apple-album";
import { fakeKV } from "./helpers/fake-kv";

// Shaped like the live page (2026-10-14): unquoted id, a MusicAlbum with
// MusicRecording tracks, and another album's durations elsewhere on the page.
const ALBUM_PAGE = `<!DOCTYPE html><html><head>
<script type="application/ld+json">{"@type":"MusicAlbum","tracks":[{"name":"Decoy","duration":"PT59M"}]}</script>
<script id=schema:music-album type="application/ld+json">{"@context":"http://schema.org","@type":"MusicAlbum",
"name":"Eli Brown at Club Space, Miami, Jul 14, 2023 (DJ Mix)",
"tracks":[{"@type":"MusicRecording","name":"Glow / So Get Up (Mixed)","duration":"PT2M45S","audio":{"duration":"PT2M45S"}},
{"@type":"MusicRecording","name":"Eat Your Man (Mixed)","duration":"PT5M10S","byArtist":[{"@type":"MusicGroup","name":"Dom Dolla"}]},
{"@type":"MusicRecording","name":"Long One (Mixed)","duration":"PT1H2M3S"}],
"byArtist":[{"@type":"MusicGroup","name":"Eli Brown"}]}</script>
<div>Other album 4:05</div></head></html>`;
const ALBUM_URL =
  "https://music.apple.com/us/album/eli-brown-at-club-space-miami-jul-14-2023-dj-mix/1703868899";

const b64 = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const jwt = (exp: number) =>
  `${b64({ alg: "ES256", kid: "KEYID12345" })}.${b64({ iss: "TEAMID", iat: 1, exp })}.${"s".repeat(40)}`;

describe("apple album parsing", () => {
  it("reads the album link", () => {
    expect(appleAlbumRef(ALBUM_URL)).toEqual({
      country: "us",
      slug: "eli-brown-at-club-space-miami-jul-14-2023-dj-mix",
      id: "1703868899",
    });
    expect(appleAlbumRef("https://music.apple.com/gb/album/1703868899?i=1")).toMatchObject({
      country: "gb",
      id: "1703868899",
    });
    expect(appleAlbumRef("https://open.spotify.com/album/1")).toBeNull();
  });

  it("parses only the schema:music-album JSON-LD block", () => {
    expect(parseAlbumJsonLd(ALBUM_PAGE)).toEqual([
      { name: "Glow / So Get Up (Mixed)", artist: null, seconds: 165 },
      { name: "Eat Your Man (Mixed)", artist: "Dom Dolla", seconds: 310 },
      { name: "Long One (Mixed)", artist: null, seconds: 3723 },
    ]);
  });

  it("gives null for a missing, broken or incomplete block", () => {
    expect(parseAlbumJsonLd("<html></html>")).toBeNull();
    expect(
      parseAlbumJsonLd('<script id="schema:music-album" type="application/ld+json">{oops</script>'),
    ).toBeNull();
    expect(
      parseAlbumJsonLd(
        '<script id="schema:music-album">{"tracks":[{"name":"A","duration":"PT1M"},{"name":"B"}]}</script>',
      ),
    ).toBeNull();
  });

  it("parses an amp-api album", () => {
    const body = {
      data: [
        {
          relationships: {
            tracks: {
              data: [{ attributes: { name: "A", durationInMillis: 61400, artistName: "X" } }],
            },
          },
        },
      ],
    };
    expect(parseAmpAlbum(body)).toEqual([{ name: "A", artist: "X", seconds: 61 }]);
    expect(parseAmpAlbum({ data: [] })).toBeNull();
  });

  it("finds the developer token and its expiry in a JS bundle", () => {
    const t = jwt(2000000000);
    expect(findDeveloperToken(`var a="x";const devToken="${t}";`)).toEqual({
      token: t,
      exp: 2000000000,
    });
    expect(findDeveloperToken("no token here")).toBeNull();
  });
});

describe("fetchAppleAlbum", () => {
  it("fetches the page, caches the album, and serves the cache next time", async () => {
    const kv = fakeKV();
    const f = vi.fn(async () => new Response(ALBUM_PAGE, { status: 200 }));
    const a = await fetchAppleAlbum({ CACHE: kv }, ALBUM_URL, {
      fetch: f as unknown as typeof fetch,
    });
    expect(a).toMatchObject({ id: "1703868899", source: "jsonld" });
    expect(a!.tracks).toHaveLength(3);
    expect(f).toHaveBeenCalledWith(
      "https://music.apple.com/us/album/eli-brown-at-club-space-miami-jul-14-2023-dj-mix/1703868899",
      expect.anything(),
    );
    expect(kv._store.has(APPLE_ALBUM_KEY("1703868899"))).toBe(true);
    await fetchAppleAlbum({ CACHE: kv }, ALBUM_URL, { fetch: f as unknown as typeof fetch });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("falls back to amp-api with a scraped token when the JSON-LD is missing, caching the token", async () => {
    const kv = fakeKV();
    const token = jwt(Math.floor(Date.now() / 1000) + 86400);
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/album/")) return new Response("<html>no block</html>");
      if (url.endsWith("/browse"))
        return new Response('<script type="module" src="/assets/index~abc.js"></script>');
      if (url.endsWith("/assets/index~abc.js")) return new Response(`x="${token}"`);
      if (url.includes("amp-api")) {
        expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${token}`);
        return new Response(
          JSON.stringify({
            data: [
              {
                relationships: {
                  tracks: { data: [{ attributes: { name: "A", durationInMillis: 60000 } }] },
                },
              },
            ],
          }),
        );
      }
      return new Response("", { status: 404 });
    });
    const a = await fetchAppleAlbum({ CACHE: kv }, ALBUM_URL, {
      fetch: f as unknown as typeof fetch,
    });
    expect(a).toEqual({
      id: "1703868899",
      source: "amp",
      tracks: [{ name: "A", artist: null, seconds: 60 }],
    });
    expect(kv._store.has("apple:devtoken:v1")).toBe(true);
  });

  it("gives up quietly (null, remembered) when no token can be found", async () => {
    const kv = fakeKV();
    const f = vi.fn(async () => new Response("<html></html>"));
    expect(
      await fetchAppleAlbum({ CACHE: kv }, ALBUM_URL, { fetch: f as unknown as typeof fetch }),
    ).toBeNull();
    expect(JSON.parse(kv._store.get(APPLE_ALBUM_KEY("1703868899"))!.value)).toEqual({
      album: null,
    });
  });
});
