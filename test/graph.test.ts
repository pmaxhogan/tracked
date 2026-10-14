/**
 * The Graph tab's data (src/lib/graph/*): written from verified set pages by
 * the search indexer, read as subgraphs (focus, depth, caps), the whole
 * library, find, the info panel, the stored-pages backfill and the routes.
 * Both databases are the real migrations on sqlite-wasm.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "../src/types";
import { fakeD1 } from "./helpers/fake-d1";
import { fakeKV } from "./helpers/fake-kv";
import { fakeR2 } from "./helpers/fake-r2";
import { parseTracklist, type ScrapedTracklist } from "../src/lib/tracklists1001";
import { tracklistFingerprint } from "../src/lib/verification";
import { indexVerifiedFetch } from "../src/lib/search/index";
import { parseSetGraph } from "../src/lib/tracklist-credits";
import { hasCurrentGraph, pagesGraphUrls, writeSetGraph } from "../src/lib/graph/store";
import {
  djContext,
  expandNode,
  findNodes,
  parseNodeId,
  wholeLibrary,
  type GEdge,
  type GNode,
} from "../src/lib/graph/query";
import { nodeInfo } from "../src/lib/graph/info";
import { graphPagesStep, PAGES_DONE_KEY, resetPagesPass } from "../src/lib/graph/backfill";
import { DEFAULT_APP_SETTINGS, updateAppSettings } from "../src/lib/app-settings";
import { app } from "../src/index";
import { GRAPH_LIBS } from "../src/ui/pages/graph";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(resolve(here, "fixtures", name), "utf8");
const HAB_URL =
  "https://www.1001tracklists.com/tracklist/2xyz1/habstrakt-jstjr-waterways-amsterdam-dance-event-2024-11-11.html";
const MAX_URL =
  "https://www.1001tracklists.com/tracklist/1abc2/max-styler-circuitgrounds-edc-las-vegas-2025-05-16.html";
const HAB_HTML = fixture("tracklist-habstrakt.html");
const MAX_HTML = fixture("tracklist-maxstyler.html");
const NOW = Math.floor(Date.now() / 1000);

function makeEnv(over: Partial<Env> = {}): Env {
  return {
    CACHE: fakeKV(),
    SUBS: fakeKV(),
    DB: fakeD1(),
    SEARCH_DB: fakeD1({ migrations: "search" }),
    API_TOKEN: "t",
    YOUTUBE_API_KEY: "k",
    ...over,
  } as Env;
}

async function seedDj(env: Env, slug: string, name: string) {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO subscriptions (slug, source_url, added_at, position) VALUES (?, ?, 0, 0)",
  )
    .bind(slug, `https://www.1001tracklists.com/dj/${slug}/`)
    .run();
  await env.DB.prepare("INSERT OR IGNORE INTO sub_sync (slug, artist_name) VALUES (?, ?)")
    .bind(slug, name)
    .run();
}

/** A processed, verified set of `slug` whose verified list is `parsed`. */
async function seedVerified(env: Env, url: string, slug: string, parsed: ScrapedTracklist) {
  await env.DB.prepare(
    "INSERT INTO tracklists (slug, url, position, discovered_at, processed) VALUES (?, ?, 0, 0, 1)",
  )
    .bind(slug, url)
    .run();
  await env.DB.prepare(
    `INSERT INTO set_verification (url, state, fingerprint, row_count, first_account, first_fetched_at, second_account, second_fetched_at, verified_at, updated_at)
     VALUES (?, 'verified', ?, ?, 'a1', ?, 'a2', ?, ?, ?)`,
  )
    .bind(
      url,
      await tracklistFingerprint(parsed),
      parsed.rows.length,
      NOW - 7200,
      NOW - 3600,
      NOW - 3600,
      NOW,
    )
    .run();
}

/** Habstrakt (and JSTJR) and Max Styler subscribed, both sets indexed from verified fetches. */
async function seeded(): Promise<Env> {
  const env = makeEnv();
  await seedDj(env, "habstrakt", "Habstrakt");
  await seedDj(env, "jstjr", "JSTJR");
  await seedDj(env, "maxstyler", "Max Styler");
  for (const [url, slug, html] of [
    [HAB_URL, "habstrakt", HAB_HTML],
    [MAX_URL, "maxstyler", MAX_HTML],
  ] as const) {
    const parsed = parseTracklist(url, html);
    await seedVerified(env, url, slug, parsed);
    expect(
      await indexVerifiedFetch(env, { setUrl: url, html, parsed, videoId: null, nowSec: NOW }),
    ).toBe("indexed");
  }
  return env;
}

const ids = (nodes: GNode[]) => nodes.map((n) => n[0]);
const cat = (nodes: GNode[], id: string) => nodes.find((n) => n[0] === id)?.[1];
const hasEdge = (edges: GEdge[], from: string, to: string, kind: string) =>
  edges.some((e) => e[0] === from && e[1] === to && e[2] === kind);
const rows = async (env: Env, sql: string, ...b: unknown[]) =>
  (
    await env
      .SEARCH_DB!.prepare(sql)
      .bind(...b)
      .all<Record<string, unknown>>()
  ).results;

describe("graph writes from a verified fetch", () => {
  it("stores the set's sources, heading artists, credits and remix bases; page_id on indexed tracks", async () => {
    const env = await seeded();
    expect(await hasCurrentGraph(env, HAB_URL)).toBe(true);
    expect(
      await rows(
        env,
        "SELECT source_id FROM search_set_sources WHERE set_url = ? ORDER BY pos",
        HAB_URL,
      ),
    ).toEqual([{ source_id: "5f5dpnv" }, { source_id: "f4lzj3" }]);
    expect(
      await rows(
        env,
        "SELECT artist_key FROM search_set_artists WHERE set_url = ? ORDER BY pos",
        HAB_URL,
      ),
    ).toEqual([{ artist_key: "habstrakt" }, { artist_key: "jstjr" }]);
    expect(await rows(env, "SELECT dj_slug FROM search_artists WHERE key = 'max-styler'")).toEqual([
      { dj_slug: "maxstyler" },
    ]);
    expect(
      await rows(
        env,
        "SELECT artist_key, role FROM search_track_artists WHERE page_id = 'kt2xfq25' ORDER BY pos",
      ),
    ).toEqual([
      { artist_key: "cloonee", role: "main" },
      { artist_key: "jstjr", role: "remixer" },
    ]);
    expect(
      await rows(env, "SELECT base_id, kind FROM search_track_bases WHERE page_id = 'kt2xfq25'"),
    ).toEqual([{ base_id: "1dpy4tqp", kind: "remix" }]);
    // The base was never played: a stub named from the row.
    expect(
      await rows(
        env,
        "SELECT artist, title, label FROM search_graph_tracks WHERE page_id = '1dpy4tqp'",
      ),
    ).toEqual([{ artist: "Cloonee", title: "Sippin' Yak", label: null }]);
    expect(
      await rows(env, "SELECT page_id FROM search_tracks WHERE track_url LIKE '%/kt2xfq25/%'"),
    ).toEqual([{ page_id: "kt2xfq25" }]);
  });

  it("a re-write of the same page changes nothing, and a stub never overwrites a played track", async () => {
    const env = await seeded();
    const count = async () =>
      (
        await rows(
          env,
          "SELECT (SELECT COUNT(*) FROM search_track_artists) AS c, (SELECT COUNT(*) FROM search_track_bases) AS b, (SELECT COUNT(*) FROM search_graph_tracks) AS t",
        )
      )[0];
    const before = await count();
    await writeSetGraph(env, HAB_URL, parseSetGraph(HAB_HTML), NOW + 10, "fetch");
    expect(await count()).toEqual(before);
    // A page that has the played track kt2xfq25 as a base: the stub keeps the played data.
    await writeSetGraph(
      env,
      "https://www.1001tracklists.com/tracklist/x/y.html",
      {
        sources: [],
        artists: [],
        rows: [
          {
            pageId: "zz1",
            path: "/track/zz1/x/index.html",
            artist: "Someone",
            title: "Sippin' Yak (Bootleg)",
            label: null,
            labelPath: null,
            genre: null,
            durationSeconds: null,
            version: "Bootleg",
            credits: [],
            base: {
              pageId: "kt2xfq25",
              kind: "remix",
              path: "/track/kt2xfq25/x/",
              artist: "Wrong",
              title: "Wrong",
            },
          },
        ],
      },
      NOW + 20,
      "fetch",
    );
    expect(
      await rows(env, "SELECT artist, label FROM search_graph_tracks WHERE page_id = 'kt2xfq25'"),
    ).toEqual([{ artist: "Cloonee", label: "HELLBENT" }]);
  });

  it("an already-indexed set gets its graph once when the index skip rule holds", async () => {
    const env = await seeded();
    await env.SEARCH_DB!.prepare("DELETE FROM search_graph_sets").run();
    await env.SEARCH_DB!.prepare("DELETE FROM search_set_sources").run();
    const parsed = parseTracklist(HAB_URL, HAB_HTML);
    expect(
      await indexVerifiedFetch(env, {
        setUrl: HAB_URL,
        html: HAB_HTML,
        parsed,
        videoId: null,
        nowSec: NOW + 60,
      }),
    ).toBe("skipped");
    expect(await hasCurrentGraph(env, HAB_URL)).toBe(true);
    // Only the fetched set's sources came back.
    expect((await rows(env, "SELECT COUNT(*) AS n FROM search_set_sources"))[0]).toEqual({ n: 2 });
  });
});

describe("graph reads", () => {
  it("parses node ids", () => {
    expect(parseNodeId("a:max-styler")).toEqual({ kind: "a", value: "max-styler" });
    expect(parseNodeId("s:https://x/y")).toEqual({ kind: "s", value: "https://x/y" });
    expect(parseNodeId("src:48jnw3")).toEqual({ kind: "src", value: "48jnw3" });
    expect(parseNodeId("zz:1")).toBeNull();
    expect(parseNodeId("t:")).toBeNull();
  });

  it("matches a subscribed DJ to its artist through the heading's DJ link (maxstyler -> max-styler)", async () => {
    const env = await seeded();
    const dj = await djContext(env);
    expect(dj.keyBySlug.get("maxstyler")).toBe("max-styler");
    expect(dj.keyBySlug.get("habstrakt")).toBe("habstrakt");
    expect(dj.slugsByKey.get("max-styler")).toEqual(["maxstyler"]);
  });

  it("depth 1 from a DJ: its sets and the tracks it is credited on; depth 2 adds the sets' tracks and sources", async () => {
    const env = await seeded();
    const one = await expandNode(env, "a:max-styler", { depth: 1, cap: 5000 });
    expect(cat(one.nodes, "a:max-styler")).toBe("dj");
    expect(hasEdge(one.edges, "a:max-styler", `s:${MAX_URL}`, "plays")).toBe(true);
    expect(hasEdge(one.edges, "a:max-styler", "t:g9c4gj7p", "by")).toBe(true);
    expect(hasEdge(one.edges, "a:max-styler", "t:wv0z2wd5", "remixer")).toBe(true);
    expect(ids(one.nodes)).not.toContain("src:unkguv");
    expect(one.truncated).toBe(false);
    const two = await expandNode(env, "a:max-styler", { depth: 2, cap: 5000 });
    expect(hasEdge(two.edges, "src:unkguv", `s:${MAX_URL}`, "source")).toBe(true);
    expect(hasEdge(two.edges, `s:${MAX_URL}`, "t:2y4umltp", "has")).toBe(true);
    // Remix base: the remix is drawn as such, its base track hangs off it.
    expect(cat(two.nodes, "t:wv0z2wd5")).toBe("remix");
    expect(hasEdge(two.edges, "t:hrxk82zx", "t:wv0z2wd5", "remix")).toBe(true);
    expect(two.nodes.find((n) => n[0] === `s:${MAX_URL}`)![2]).toContain("Max Styler");
  });

  it("from a track: its sets, credits, base; from a source: its sets; from a set: its DJs", async () => {
    const env = await seeded();
    const t = await expandNode(env, "t:kt2xfq25", { depth: 1, cap: 5000 });
    expect(hasEdge(t.edges, `s:${HAB_URL}`, "t:kt2xfq25", "has")).toBe(true);
    expect(hasEdge(t.edges, "a:jstjr", "t:kt2xfq25", "remixer")).toBe(true);
    expect(hasEdge(t.edges, "t:1dpy4tqp", "t:kt2xfq25", "remix")).toBe(true);
    expect(cat(t.nodes, "t:1dpy4tqp")).toBe("track");
    expect(t.nodes.find((n) => n[0] === "t:1dpy4tqp")![2]).toBe("Cloonee - Sippin' Yak");
    const src = await expandNode(env, "src:f4lzj3", { depth: 1, cap: 5000 });
    expect(ids(src.nodes).sort()).toEqual([`s:${HAB_URL}`, "src:f4lzj3"].sort());
    const s = await expandNode(env, `s:${HAB_URL}`, { depth: 1, cap: 5000 });
    expect(hasEdge(s.edges, "a:habstrakt", `s:${HAB_URL}`, "plays")).toBe(true);
    expect(hasEdge(s.edges, "a:jstjr", `s:${HAB_URL}`, "plays")).toBe(true);
    expect(cat(s.nodes, "a:jstjr")).toBe("dj");
  });

  it("caps the nodes, keeps the focus, and returns only edges between returned nodes", async () => {
    const env = await seeded();
    const g = await expandNode(env, "a:max-styler", { depth: 2, cap: 5 });
    expect(g.nodes).toHaveLength(5);
    expect(g.truncated).toBe(true);
    expect(ids(g.nodes)).toContain("a:max-styler");
    const keep = new Set(ids(g.nodes));
    for (const e of g.edges) expect(keep.has(e[0]) && keep.has(e[1])).toBe(true);
  });

  it("whole library: DJs, sources and sets first, then tracks and artists, under the cap", async () => {
    const env = await seeded();
    const all = await wholeLibrary(env, 5000);
    expect(all.truncated).toBe(false);
    expect(ids(all.nodes)).toEqual(
      expect.arrayContaining([
        "a:habstrakt",
        "a:max-styler",
        `s:${HAB_URL}`,
        "src:unkguv",
        "t:kt2xfq25",
      ]),
    );
    expect(hasEdge(all.edges, `s:${HAB_URL}`, "t:kt2xfq25", "has")).toBe(true);
    const few = await wholeLibrary(env, 6);
    expect(few.truncated).toBe(true);
    expect(few.nodes).toHaveLength(6);
    expect(
      few.nodes.map((n) => n[1]).every((c) => c === "dj" || c === "source" || c === "set"),
    ).toBe(true);
  });

  it("find: DJs first, then artists, sources, sets and tracks", async () => {
    const env = await seeded();
    const hits = await findNodes(env, "max styl");
    expect(hits[0]).toMatchObject({ id: "a:max-styler", cat: "dj" });
    expect(hits.filter((h) => h.id === "a:max-styler")).toHaveLength(1);
    expect((await findNodes(env, "amsterdam")).map((h) => h.id)).toContain("src:f4lzj3");
    expect((await findNodes(env, "Sippin")).some((h) => h.id === "t:kt2xfq25")).toBe(true);
    expect(await findNodes(env, "x")).toEqual([]);
    // LIKE wildcards in the text are literal.
    expect(await findNodes(env, "%%")).toEqual([]);
  });
});

describe("info panel", () => {
  it("a set: DJs, sources, our set page and the 1001tl page", async () => {
    const env = await seeded();
    const i = (await nodeInfo(env, `s:${HAB_URL}`))!;
    expect(i.cat).toBe("set");
    expect(i.facts).toEqual(expect.arrayContaining([["DJ", "Habstrakt, JSTJR"]]));
    expect(i.facts.find((f) => f[0] === "Source")![1]).toContain("Amsterdam Dance Event");
    expect(i.links[0]).toEqual({
      label: "Set page",
      href: `/ui/set?url=${encodeURIComponent(HAB_URL)}`,
      external: false,
    });
    expect(i.related.map((r) => r.id)).toEqual([
      "a:habstrakt",
      "a:jstjr",
      "src:5f5dpnv",
      "src:f4lzj3",
    ]);
  });

  it("a remix: credits, its original, label, played count, pre-save link, 1001tl track and label pages", async () => {
    const env = await seeded();
    await env.DB.prepare(
      "INSERT INTO presaves (track_url, artist, title, stage, created_at, updated_at) VALUES (?, 'Cloonee', 'Sippin', 'links', 1, 1)",
    )
      .bind(
        "https://www.1001tracklists.com/track/kt2xfq25/cloonee-sippin-yak-jstjr-remix/index.html",
      )
      .run();
    const i = (await nodeInfo(env, "t:kt2xfq25"))!;
    expect(i.cat).toBe("remix");
    expect(i.facts).toEqual(
      expect.arrayContaining([
        ["Label", "HELLBENT"],
        ["Remix of", "Cloonee - Sippin' Yak"],
        ["Played in", "1 set"],
        ["Pre-save", "links"],
      ]),
    );
    expect(i.related).toEqual(
      expect.arrayContaining([
        { id: "a:jstjr", label: "JSTJR", note: "Remixer" },
        { id: "t:1dpy4tqp", label: "Cloonee - Sippin' Yak", note: "Original" },
      ]),
    );
    expect(i.links.map((l) => l.label)).toEqual(
      expect.arrayContaining([
        "Pre-save page",
        "1001tracklists track page",
        "1001tracklists label page",
      ]),
    );
    // The original lists the remix.
    const o = (await nodeInfo(env, "t:1dpy4tqp"))!;
    expect(o.related).toEqual([
      { id: "t:kt2xfq25", label: "Cloonee - Sippin' Yak (JSTJR Remix)", note: "Remix" },
    ]);
  });

  it("a DJ, an artist, a source; unknown ids are null", async () => {
    const env = await seeded();
    const d = (await nodeInfo(env, "a:max-styler"))!;
    expect(d.cat).toBe("dj");
    expect(d.links[0]).toEqual({ label: "DJ page", href: "/ui/dj/maxstyler", external: false });
    expect(d.facts).toEqual(expect.arrayContaining([["Sets", "1 set"]]));
    const a = (await nodeInfo(env, "a:cloonee"))!;
    expect(a.cat).toBe("artist");
    expect(a.links).toEqual([
      {
        label: "1001tracklists artist page",
        href: "https://www.1001tracklists.com/artist/6lwh0mw/cloonee/index.html",
        external: true,
      },
    ]);
    const s = (await nodeInfo(env, "src:unkguv"))!;
    expect(s.links[0]!.href).toBe(
      "https://www.1001tracklists.com/source/unkguv/edc-las-vegas/index.html",
    );
    expect(await nodeInfo(env, "src:nope")).toBeNull();
    expect(await nodeInfo(env, "bad")).toBeNull();
  });
});

describe("stored-pages backfill", () => {
  async function gz(text: string): Promise<Uint8Array> {
    const s = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }

  it("writes the graph of an indexed set from its stored page only when it is the verified list", async () => {
    const env = await seeded();
    const pages = fakeR2();
    env.PAGES = pages;
    await env.SEARCH_DB!.prepare("DELETE FROM search_graph_sets").run();
    const put = async (key: string, url: string, html: string) =>
      pages.put(key, await gz(html), { customMetadata: { url, kind: "set" } });
    await put(`clean/2026-10-01/set/2xyz1/1-a1.html`, HAB_URL, HAB_HTML);
    // Not the verified list (another set's rows): refused.
    await put(`clean/2026-10-01/set/1abc2/1-a1.html`, MAX_URL, HAB_HTML);
    // Not a set page, and a flagged page: never read.
    await put(`clean/2026-10-01/dj/maxstyler/1-a1.html`, "https://x/dj", "<html></html>");
    await put(`flagged/2026-10-01/set/1abc2/1-a1.html`, MAX_URL, MAX_HTML);
    // Keys sort dj/ < set/1abc2 < set/2xyz1: the refused page is read first.
    const r = await graphPagesStep(env, { limit: 1, nowSec: NOW });
    expect(r).toMatchObject({ read: 1, written: 0, rejected: 1, done: false });
    const r2 = await graphPagesStep(env, { limit: 10, nowSec: NOW });
    expect(r2).toMatchObject({ read: 1, written: 1, rejected: 0, done: true });
    expect(await hasCurrentGraph(env, HAB_URL)).toBe(true);
    expect(await hasCurrentGraph(env, MAX_URL)).toBe(false);
    expect(await pagesGraphUrls(env)).toEqual([HAB_URL]);
    expect(await env.CACHE.get(PAGES_DONE_KEY)).toBe(String(NOW));
    expect(await graphPagesStep(env, { limit: 10 })).toMatchObject({ read: 0, done: true });
    // A reset starts over; the set already parsed is not read again, the refused one is.
    await resetPagesPass(env);
    expect(await graphPagesStep(env, { limit: 10, nowSec: NOW })).toMatchObject({
      read: 1,
      written: 0,
      done: true,
    });
  });

  it("does nothing without a PAGES bucket", async () => {
    const env = await seeded();
    expect(await graphPagesStep(env, { limit: 5 })).toMatchObject({ read: 0, done: true });
  });
});

describe("routes", () => {
  const req = (env: Env, path: string, init?: RequestInit) =>
    app.request(`https://tracked.example${path}`, init, {
      ...env,
      DEV_BYPASS_CF_ACCESS: "1",
    } as Env);

  it("expand: compact nodes and edges plus the limits from Settings; bad ids and depths are 400", async () => {
    const env = await seeded();
    await updateAppSettings(env, { graph: { nodeCap: 400, confirmOver: 50 } });
    const r = await req(
      env,
      `/ui/api/graph/expand?depth=1&id=${encodeURIComponent("a:max-styler")}`,
    );
    expect(r.status).toBe(200);
    const d = (await r.json()) as { nodes: GNode[]; edges: GEdge[]; limits: unknown };
    expect(d.limits).toEqual({ nodeCap: 400, confirmOver: 50 });
    expect(d.nodes[0]).toEqual(["a:max-styler", "dj", "Max Styler", 0]);
    expect((await req(env, "/ui/api/graph/expand?id=nope")).status).toBe(400);
    expect((await req(env, "/ui/api/graph/expand?id=a:x&depth=3")).status).toBe(400);
  });

  it("info, find, library and status answer; info of an unknown node is 404", async () => {
    const env = await seeded();
    expect(
      (await req(env, `/ui/api/graph/info?id=${encodeURIComponent("t:kt2xfq25")}`)).status,
    ).toBe(200);
    expect((await req(env, "/ui/api/graph/info?id=src:none")).status).toBe(404);
    const f = (await (await req(env, "/ui/api/graph/find?q=habstrakt")).json()) as {
      hits: unknown[];
    };
    expect(f.hits.length).toBeGreaterThan(0);
    const lib = (await (await req(env, "/ui/api/graph/library")).json()) as {
      nodes: unknown[];
      truncated: boolean;
    };
    expect(lib.nodes.length).toBeGreaterThan(10);
    const st = (await (await req(env, "/ui/api/graph/status")).json()) as Record<string, unknown>;
    expect(st).toMatchObject({
      sets: 2,
      parsed: 2,
      pagesPassDone: true,
      limits: { nodeCap: 5000, confirmOver: 300 },
    });
  });

  it("503 without the search database", async () => {
    const env = makeEnv({ SEARCH_DB: undefined });
    for (const p of [
      "/ui/api/graph/status",
      "/ui/api/graph/expand?id=a:x",
      "/ui/api/graph/library",
      "/ui/api/graph/find?q=ab",
    ])
      expect((await req(env, p)).status).toBe(503);
  });

  it("the page loads the three pinned libraries with SRI, and only from jsdelivr", async () => {
    const html = await (await req(makeEnv(), "/ui/graph")).text();
    const srcs = [
      ...html.matchAll(
        /<script src="([^"]+)" integrity="sha384-[A-Za-z0-9+/=]+" crossorigin="anonymous"><\/script>/g,
      ),
    ].map((m) => m[1]);
    expect(srcs).toEqual(GRAPH_LIBS.map((l) => l.src));
    for (const s of srcs)
      expect(s).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/npm\/[a-z-]+@\d+\.\d+\.\d+\//);
    expect(html.match(/<script src=/g)).toHaveLength(3);
  });
});

describe("graph settings", () => {
  it("defaults: 5,000 nodes, confirm over 300, backfill on, 10 pages a tick; validated", async () => {
    expect(DEFAULT_APP_SETTINGS.graph).toEqual({
      nodeCap: 5000,
      confirmOver: 300,
      backfill: true,
      pagesPerTick: 10,
    });
    const env = makeEnv();
    expect(await updateAppSettings(env, { graph: { nodeCap: 250000 } })).toMatchObject({
      ok: true,
    });
    expect(await updateAppSettings(env, { graph: { nodeCap: 10 } })).toMatchObject({ ok: false });
    expect(await updateAppSettings(env, { graph: { pagesPerTick: 1000 } })).toMatchObject({
      ok: false,
    });
  });
});
