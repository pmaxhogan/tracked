/**
 * An Apple Music album's track list and durations, for the timing backstop
 * (lib/apple-cues.ts). Source, in order:
 *   1. the public album page `music.apple.com/<cc>/album/<slug>/<id>` (browser
 *      UA). Only its `<script id=schema:music-album type="application/ld+json">`
 *      block is read (schema.org MusicAlbum: tracks[].name + ISO 8601
 *      duration); the page lists other albums' durations elsewhere.
 *   2. when that block is missing or unparseable: amp-api
 *      `/v1/catalog/<cc>/albums/<id>`, which needs the web player's developer
 *      token. It is read from the music.apple.com JS bundle and kept in KV
 *      until it expires. Any failure here gives up quietly with a log.
 * A parsed album is cached in KV (`apple:album:v1:<id>`) for TTL.APPLE; an
 * album that could not be read is remembered for a day.
 */

import { TTL } from "./cache";
import { fetchWithTimeout } from "./fetch";
import { errorFields, type Logger } from "./log";
import { parseIsoDuration } from "./youtube-playlists";
import type { AppleTrack } from "./apple-cues";

export type AppleAlbum = { id: string; tracks: AppleTrack[]; source: "jsonld" | "amp" };

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
export const APPLE_ALBUM_KEY = (id: string) => `apple:album:v1:${id}`;
export const APPLE_TOKEN_KEY = "apple:devtoken:v1";
const MISS_TTL = 86400;

/** Country and album id of a music.apple.com album link, else null. */
export function appleAlbumRef(
  url: string | null | undefined,
): { country: string; slug: string | null; id: string } | null {
  const m = (url ?? "").match(/music\.apple\.com\/([a-z]{2})\/album\/(?:([^/?#]+)\/)?(\d+)/i);
  return m ? { country: m[1]!.toLowerCase(), slug: m[2] ?? null, id: m[3]! } : null;
}

const names = (v: unknown): string | null => {
  const arr = Array.isArray(v) ? v : v ? [v] : [];
  const n = arr
    .map((a) => (a && typeof a === "object" ? (a as { name?: unknown }).name : null))
    .filter((x): x is string => typeof x === "string" && !!x.trim());
  return n.length ? n.join(", ") : null;
};

/** The album's tracks from its JSON-LD block, or null when the block is missing, unparseable or any track lacks a length. */
export function parseAlbumJsonLd(html: string): AppleTrack[] | null {
  const m = html.match(
    /<script\b[^>]*\bid\s*=\s*["']?schema:music-album["']?[^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!m) return null;
  let doc: { tracks?: unknown };
  try {
    doc = JSON.parse(m[1]!) as { tracks?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(doc.tracks) || !doc.tracks.length) return null;
  const out: AppleTrack[] = [];
  for (const t of doc.tracks as Array<{ name?: unknown; duration?: unknown; byArtist?: unknown }>) {
    const seconds = parseIsoDuration(typeof t?.duration === "string" ? t.duration : null);
    if (typeof t?.name !== "string" || !seconds) return null;
    out.push({ name: t.name, artist: names(t.byArtist), seconds });
  }
  return out;
}

/** The album's tracks from an amp-api catalog answer, or null. */
export function parseAmpAlbum(json: unknown): AppleTrack[] | null {
  const data = (json as { data?: Array<{ relationships?: { tracks?: { data?: unknown[] } } }> })
    ?.data;
  const tracks = data?.[0]?.relationships?.tracks?.data;
  if (!Array.isArray(tracks) || !tracks.length) return null;
  const out: AppleTrack[] = [];
  for (const t of tracks as Array<{
    attributes?: { name?: unknown; durationInMillis?: unknown; artistName?: unknown };
  }>) {
    const a = t?.attributes;
    const ms = Number(a?.durationInMillis);
    if (typeof a?.name !== "string" || !(ms > 0)) return null;
    out.push({
      name: a.name,
      artist: typeof a.artistName === "string" ? a.artistName : null,
      seconds: Math.round(ms / 1000),
    });
  }
  return out;
}

/** A developer token (JWT) found in the web player's JS, and its expiry (unix s), or null. */
export function findDeveloperToken(js: string): { token: string; exp: number } | null {
  const re = /eyJh[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g;
  for (const m of js.matchAll(re)) {
    try {
      const payload = JSON.parse(
        atob(m[0].split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")),
      ) as {
        exp?: unknown;
        iss?: unknown;
      };
      const exp = Number(payload.exp);
      if (exp > 0) return { token: m[0], exp };
    } catch {
      /* not a JWT */
    }
  }
  return null;
}

export type AppleFetchDeps = { fetch?: typeof fetch; log?: Logger; now?: () => number };

async function getText(
  f: typeof fetch,
  url: string,
  headers: Record<string, string> = {},
): Promise<string | null> {
  const res = await (f === fetch
    ? fetchWithTimeout(url, { timeoutMs: 10000, headers: { "user-agent": UA, ...headers } })
    : f(url, { headers: { "user-agent": UA, ...headers } }));
  return res.ok ? res.text() : null;
}

async function developerToken(
  env: { CACHE: KVNamespace },
  deps: Required<Pick<AppleFetchDeps, "fetch" | "now">>,
): Promise<string | null> {
  const nowSec = Math.floor(deps.now() / 1000);
  const hit = (await env.CACHE.get(APPLE_TOKEN_KEY, "json")) as {
    token: string;
    exp: number;
  } | null;
  if (hit && hit.exp > nowSec + 60) return hit.token;
  const html = await getText(deps.fetch, "https://music.apple.com/us/browse");
  if (!html) return null;
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="(\/assets\/[^"]+\.js)"/g)].map(
    (m) => m[1]!,
  );
  for (const src of scripts) {
    const js = await getText(deps.fetch, `https://music.apple.com${src}`);
    const t = js ? findDeveloperToken(js) : null;
    if (t && t.exp > nowSec + 60) {
      await env.CACHE.put(APPLE_TOKEN_KEY, JSON.stringify(t), {
        expirationTtl: Math.max(60, t.exp - nowSec),
      });
      return t.token;
    }
  }
  return null;
}

/**
 * The album behind an Apple Music link (cached), or null when it cannot be
 * read. Never throws.
 */
export async function fetchAppleAlbum(
  env: { CACHE: KVNamespace },
  url: string,
  deps: AppleFetchDeps = {},
): Promise<AppleAlbum | null> {
  const ref = appleAlbumRef(url);
  if (!ref) return null;
  const f = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const key = APPLE_ALBUM_KEY(ref.id);
  try {
    const hit = (await env.CACHE.get(key, "json")) as { album: AppleAlbum | null } | null;
    if (hit) return hit.album;
  } catch {
    /* read through */
  }
  let album: AppleAlbum | null = null;
  try {
    const html = await getText(
      f,
      `https://music.apple.com/${ref.country}/album/${ref.slug ? `${ref.slug}/` : ""}${ref.id}`,
    );
    const tracks = html ? parseAlbumJsonLd(html) : null;
    if (tracks) album = { id: ref.id, tracks, source: "jsonld" };
    else {
      deps.log?.info("apple.jsonld_missing", {
        id: ref.id,
        page: html ? "no block" : "fetch failed",
      });
      const token = await developerToken(env, { fetch: f, now });
      if (!token) deps.log?.warn("apple.no_token", { id: ref.id });
      else {
        const body = await getText(
          f,
          `https://amp-api.music.apple.com/v1/catalog/${ref.country}/albums/${ref.id}`,
          { authorization: `Bearer ${token}`, origin: "https://music.apple.com" },
        );
        const amp = body ? parseAmpAlbum(JSON.parse(body)) : null;
        if (amp) album = { id: ref.id, tracks: amp, source: "amp" };
        else deps.log?.warn("apple.amp_failed", { id: ref.id });
      }
    }
  } catch (e) {
    deps.log?.warn("apple.fetch_failed", { id: ref.id, ...errorFields(e) });
    return null; // a transport error is not remembered as a miss
  }
  try {
    await env.CACHE.put(key, JSON.stringify({ album }), {
      expirationTtl: album ? TTL.APPLE : MISS_TTL,
    });
  } catch {
    /* best effort */
  }
  return album;
}
