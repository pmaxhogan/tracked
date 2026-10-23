/**
 * Track-page set lists (lib/track-sets.ts): parsing a track page's
 * "played in" list and its scroll chunks, storing them (per track and per
 * set, the followed flag), seeding the crawl queue from the search index,
 * the cron's walk (page 1, scroll steps from the cursor, the stop year, the
 * end of the list, maxSteps, the views cap carrying a walk over, a recrawl
 * stopping at a known set, a pool refusal charging nothing), and the
 * Recommended sets endpoint. tlpool is a stubbed global fetch; D1 and KV are
 * the in-memory fakes with the real migrations.
 */
import vm from "node:vm";
import { describe, it, expect, vi, afterEach } from "vitest";
import { fakeKV } from "./helpers/fake-kv";
import { fakeD1 } from "./helpers/fake-d1";
import type { Env } from "../src/types";
import {
  drainTrackSets,
  parseTrackSetRows,
  recommendedSetTracks,
  recordTrackPageHtml,
  SEED_CURSOR_KEY,
  storeTrackSetRows,
  titleDjNames,
  trackPageIdOf,
  trackSetsSummary,
} from "../src/lib/track-sets";
import { budgetHoldKey } from "../src/lib/fetch-scheduler";
import { ALLOWANCE_KEY, HOLD_KEY, USAGE_KEY } from "../src/lib/track-sets";
import { updateAppSettings } from "../src/lib/app-settings";
import { makeLogger } from "../src/lib/log";
import { app } from "../src/index";

const POOL = "https://tlpool.example";
const ORIGIN = "https://www.1001tracklists.com";
const NOW = 1_800_000_000;
const log = makeLogger({ test: "track-sets" });
const TRACK_ID = "vdju0xlp";
const TRACK_URL = `${ORIGIN}/track/${TRACK_ID}/genesi-essentia-franksy-just-like-that/index.html`;

/** One row as the track page renders it (captured 2026-10-20; image and onclick query strings dropped). */
function rowHtml(
  id: string,
  title: string,
  date: string,
  creator = "EvanPierini",
  extra: { likes?: number; genres?: string; ided?: string } = {},
): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return (
    `<div class="bItm action oItm" onclick="window.open('/tracklist/${id}/${slug}.html#tr_${TRACK_ID}', '_self');" data-id="${id}" id="${id}">` +
    `<img data-src="" src="" class="artM extImg lazy-loaded" width="100" height="100" alt="${title} Artwork">` +
    `<div class="bCont"><div class="bTitle" onclick="cancelBubble();"><a href="/tracklist/${id}/${slug}.html#tr_${TRACK_ID}" class="">${title}</a></div></div>` +
    `<div class="mediaRow iRow"><div class="badge views" title="tracklist views" data-count="28"><i class="fa fa-eye spR"></i>28</div>` +
    `<div title="tracklist date"><i class="fa fa-calendar fa-20 spR"></i>${date}</div>` +
    `<div class="tlUser" title="creator" onclick="cancelBubble();"><i class="fa fa-user fa-20 spR"></i><a href="/user/${creator}/index.html">${creator}</a><span class="noMob spL">(60)</span></div>` +
    `<div title="IDed tracks / total tracks"><i class="fa fa-check fa-20 spR"></i>${extra.ided ?? '<span class="greenTxt">all</span>/14'}</div>` +
    (extra.likes
      ? `<div class="likes" title="likes"><i class="fa fa-thumbs-up fa-20 spR"></i>${extra.likes}</div>`
      : `<div class="likes hidden" title="likes"><i class="fa fa-thumbs-up fa-20 spR"></i></div>`) +
    `<div title="musicstyle(s)"><i class="fa fa-music fa-20 spR"></i>${extra.genres ?? "Tech House"}</div></div></div>`
  );
}

type R = { id: string; title: string; date: string };
const rows = (prefix: string, n: number, date: (i: number) => string): R[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    title: `Some DJ ${prefix}${i} - Show ${i}`,
    date: date(i),
  }));

/** A track page: an unrelated list first, then #sDivTracklists. */
function trackPage(list: R[]): string {
  return (
    `<html><head><title>GENESI - Just Like That</title></head><body>` +
    `<div class="sDiv" id="sDivOther" data-type="other" data-id="zz">${rowHtml("other1", "Not Me - Elsewhere", "2026-01-01")}</div>` +
    `<div class="sDiv " id="sDivTracklists" data-type="track" data-id="${TRACK_ID}">` +
    list.map((r) => rowHtml(r.id, r.title, r.date)).join("") +
    `</div><div class="sDiv" id="sDivFooter"><div class="bItm oItm" data-id="foot"><a href="/tracklist/foot/x.html">Footer</a></div></div></body></html>`
  );
}

function makeEnv(extra: Partial<Env> = {}): Env {
  return {
    CACHE: fakeKV(),
    DB: fakeD1(),
    SEARCH_DB: fakeD1({ migrations: "search" }),
    SUBS: fakeKV(),
    API_TOKEN: "t",
    YOUTUBE_API_KEY: "k",
    TLPOOL_URL: POOL,
    TLPOOL_TOKEN: "pt",
    DEV_BYPASS_CF_ACCESS: "1",
    ...extra,
  } as unknown as Env;
}

type Asked = Array<{
  url: string;
  kind: string;
  priority: string;
  form?: Record<string, string>;
  referer?: string;
}>;

/** tlpool: a track page answers `pages(url)`; get_data.php answers `scroll(form)` (JSON) or a contract error. */
/** tlpool's /status and /settings as backfillAllowance reads them; null = the pool cannot say (404). */
let admin: { status: object; settings: object } | null = null;

function stubPool(
  pages: (url: string) => string,
  scroll: (form: Record<string, string>, referer?: string) => object = () => ({
    success: true,
    end: true,
    data: "",
  }),
): Asked {
  const asked: Asked = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${POOL}/status` || url === `${POOL}/settings`) {
        if (!admin) return new Response("no", { status: 404 });
        return Response.json(url.endsWith("/status") ? admin.status : admin.settings);
      }
      if (url !== `${POOL}/fetch`) throw new Error(`unexpected fetch ${url}`);
      const body = JSON.parse(String(init!.body)) as {
        url: string;
        kind: string;
        priority: string;
        form?: Record<string, string>;
        headers?: Record<string, string>;
      };
      asked.push({
        url: body.url,
        kind: body.kind,
        priority: body.priority,
        form: body.form,
        referer: body.headers?.Referer,
      });
      let html: string;
      if (body.url.endsWith("/ajax/get_data.php")) {
        const a = scroll(body.form ?? {}, body.headers?.Referer);
        if ("error" in a) return Response.json(a);
        html = JSON.stringify(a);
      } else html = pages(body.url);
      return Response.json({
        status: 200,
        finalUrl: body.url,
        html,
        accountId: "acct-1",
        exitLabel: "exit-a",
        fetchedAt: new Date().toISOString(),
        bytes: html.length,
      });
    }),
  );
  return asked;
}

async function queueTrack(env: Env, id = TRACK_ID, url = TRACK_URL, weight = 1): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO track_set_crawl (track_page_id, track_url, weight, queued_at, next_at) VALUES (?, ?, ?, ?, 0)",
  )
    .bind(id, url, weight, NOW - 100)
    .run();
}

async function crawlRow(env: Env, id = TRACK_ID) {
  return env.DB.prepare("SELECT * FROM track_set_crawl WHERE track_page_id = ?").bind(id).first<{
    next_at: number;
    cursor_pos: number | null;
    cursor_id: string | null;
    steps: number;
    walks: number;
    sets_seen: number;
    oldest_date: string | null;
    stop_reason: string | null;
    attempts: number;
  }>();
}

async function setIds(env: Env, track = TRACK_ID): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT set_id FROM track_sets WHERE track_page_id = ? ORDER BY set_id",
  )
    .bind(track)
    .all<{ set_id: string }>();
  return results.map((r) => r.set_id);
}

afterEach(() => {
  vi.unstubAllGlobals();
  admin = null;
});

describe("parseTrackSetRows", () => {
  it("reads only the #sDivTracklists rows of a track page, with url, title, date and creator", () => {
    const got = parseTrackSetRows(
      trackPage([
        { id: "2llvnbht", title: "Evan Pierini - The Transmission 004", date: "2026-10-16" },
        { id: "1sjc9yyk", title: "CamelPhat @ Metropolitano &amp; Friends", date: "2026-10-09" },
      ]),
    );
    expect(got).toEqual([
      {
        setId: "2llvnbht",
        url: `${ORIGIN}/tracklist/2llvnbht/evan-pierini-the-transmission-004.html`,
        title: "Evan Pierini - The Transmission 004",
        date: "2026-10-16",
        creator: "EvanPierini",
        views: 28,
        likes: 0,
        genres: "Tech House",
        totalTracks: 14,
      },
      {
        setId: "1sjc9yyk",
        url: `${ORIGIN}/tracklist/1sjc9yyk/camelphat-metropolitano-amp-friends.html`,
        title: "CamelPhat @ Metropolitano & Friends",
        date: "2026-10-09",
        creator: "EvanPierini",
        views: 28,
        likes: 0,
        genres: "Tech House",
        totalTracks: 14,
      },
    ]);
  });

  it("reads a row's likes and several genres, and leaves out what a row does not show", () => {
    const [liked] = parseTrackSetRows(
      rowHtml("l1", "A - One", "2025-01-02", "U", {
        likes: 12,
        genres: "Dance / Electro Pop, Tech House",
        ided: "15/16",
      }),
    );
    expect(liked).toMatchObject({
      likes: 12,
      genres: "Dance / Electro Pop, Tech House",
      totalTracks: 16,
    });
    const [bare] = parseTrackSetRows(
      `<div class="bItm action oItm" data-id="b1"><div class="bTitle"><a href="/tracklist/b1/x.html">B - Two</a></div></div>`,
    );
    expect(bare).toMatchObject({
      views: null,
      likes: null,
      genres: null,
      totalTracks: null,
      date: null,
      creator: null,
    });
  });

  it("reads a scroll chunk (no list wrapper) and skips a row without a tracklist link", () => {
    const chunk =
      rowHtml("a1", "A - One", "2025-01-02") +
      `<div class="bItm action oItm" data-id="nolink"><div class="bTitle">ID</div></div>` +
      rowHtml("a2", "B - Two", "2024-12-31");
    expect(parseTrackSetRows(chunk).map((r) => [r.setId, r.date])).toEqual([
      ["a1", "2025-01-02"],
      ["a2", "2024-12-31"],
    ]);
  });

  it("finds nothing on a page without the list", () => {
    expect(parseTrackSetRows("<html><body>nothing</body></html>")).toEqual([]);
  });
});

describe("helpers", () => {
  it("trackPageIdOf reads the page id of a track URL", () => {
    expect(trackPageIdOf(TRACK_URL)).toBe(TRACK_ID);
    expect(trackPageIdOf(`${ORIGIN}/tracklist/abc/x.html`)).toBeNull();
    expect(trackPageIdOf(null)).toBeNull();
  });

  it("titleDjNames takes the DJ part, whole and split", () => {
    expect(titleDjNames("Meduza & Greggio - Aeterna Radio 018")).toEqual([
      "meduza & greggio",
      "meduza",
      "greggio",
    ]);
    expect(titleDjNames("CamelPhat @ Metropolitano, Rosario, Argentina")).toEqual(["camelphat"]);
    expect(titleDjNames("Adam Beyer b2b Cirez D - Drumcode Radio")).toEqual([
      "adam beyer b2b cirez d",
      "adam beyer",
      "cirez d",
    ]);
  });
});

describe("storeTrackSetRows", () => {
  it("counts each set once per track, and the tracks that list it", async () => {
    const env = makeEnv();
    const list = parseTrackSetRows(
      rowHtml("s1", "X - One", "2026-01-01") +
        rowHtml("s2", "Y - Two", "2026-01-02", "EvanPierini", { likes: 4, genres: "Techno" }),
    );
    expect(await storeTrackSetRows(env, "t1", list, new Set(), NOW)).toEqual({
      added: 2,
      known: 0,
    });
    expect(await storeTrackSetRows(env, "t1", list, new Set(), NOW)).toEqual({
      added: 0,
      known: 2,
    });
    await storeTrackSetRows(env, "t2", list.slice(0, 1), new Set(), NOW);
    const { results } = await env.DB.prepare(
      "SELECT set_id, track_count, followed, title, set_date, creator, views, likes, genres FROM track_set_lists ORDER BY set_id",
    ).all();
    expect(results).toEqual([
      {
        set_id: "s1",
        track_count: 2,
        followed: 0,
        title: "X - One",
        set_date: "2026-01-01",
        creator: "EvanPierini",
        views: 28,
        likes: 0,
        genres: "Tech House",
      },
      {
        set_id: "s2",
        track_count: 1,
        followed: 0,
        title: "Y - Two",
        set_date: "2026-01-02",
        creator: "EvanPierini",
        views: 28,
        likes: 4,
        genres: "Techno",
      },
    ]);
  });

  it("flags a followed DJ's set by name and by its id in tracklists", async () => {
    const env = makeEnv();
    await env.DB.prepare(
      "INSERT INTO tracklists (slug, url, position, discovered_at) VALUES ('dj', ?, 0, 0)",
    )
      .bind(`${ORIGIN}/tracklist/byid/an-older-slug.html`)
      .run();
    const list = parseTrackSetRows(
      rowHtml("byid", "Someone - Show", "2026-01-01") +
        rowHtml("byname", "Meduza & Other - Show", "2026-01-01") +
        rowHtml("free", "Stranger - Show", "2026-01-01"),
    );
    await storeTrackSetRows(env, "t1", list, new Set(["meduza"]), NOW);
    const { results } = await env.DB.prepare(
      "SELECT set_id, followed FROM track_set_lists ORDER BY set_id",
    ).all();
    expect(results).toEqual([
      { set_id: "byid", followed: 1 },
      { set_id: "byname", followed: 1 },
      { set_id: "free", followed: 0 },
    ]);
  });

  it("recordTrackPageHtml stores a fetched page's first sets and never throws", async () => {
    const env = makeEnv();
    const page = trackPage(rows("p", 3, () => "2026-05-01"));
    expect(await recordTrackPageHtml(env, TRACK_URL, page, log)).toBe(3);
    expect(await setIds(env)).toEqual(["p0", "p1", "p2"]);
    expect(await recordTrackPageHtml(env, "not a track url", page, log)).toBe(0);
    expect(
      await recordTrackPageHtml({ ...env, DB: undefined } as unknown as Env, TRACK_URL, page),
    ).toBe(0);
  });
});

describe("drainTrackSets", () => {
  it("seeds the queue from the search index's tracks, by id from the stored cursor", async () => {
    const env = makeEnv();
    await updateAppSettings(env, { trackSets: { viewsPerTick: 0 } });
    // viewsPerTick 0 is "off": nothing is seeded either.
    expect((await drainTrackSets(env, log, NOW)).skipped).toBe("off");
    await updateAppSettings(env, { trackSets: { viewsPerTick: 1 } });
    const ins = env.SEARCH_DB!.prepare(
      "INSERT INTO search_tracks (id, track_key, page_id, track_url, artist, title, sets_count, updated_at) VALUES (?, ?, ?, ?, 'A', 'T', ?, 0)",
    );
    await env.SEARCH_DB!.batch([
      ins.bind(1, "t:1", "aa", `${ORIGIN}/track/aa/x/index.html`, 2),
      ins.bind(2, "t:2", null, null, 1),
      ins.bind(3, "t:3", "cc", `${ORIGIN}/track/cc/x/index.html`, 0),
      ins.bind(4, "t:4", "dd", `${ORIGIN}/track/dd/x/index.html`, 5),
    ]);
    const asked = stubPool(() => trackPage([]));
    const r = await drainTrackSets(env, log, NOW);
    expect(r.seeded).toBe(2);
    expect(await env.CACHE.get(SEED_CURSOR_KEY)).toBe("4");
    // The most-played track goes first.
    expect(asked.map((a) => a.url)).toEqual([`${ORIGIN}/track/dd/x/index.html`]);
    const { results } = await env.DB.prepare(
      "SELECT track_page_id, weight FROM track_set_crawl ORDER BY track_page_id",
    ).all();
    expect(results).toEqual([
      { track_page_id: "aa", weight: 2 },
      { track_page_id: "dd", weight: 5 },
    ]);
    expect((await drainTrackSets(env, log, NOW)).seeded).toBe(0);
  });

  it("walks page 1 then scroll steps at priority backfill, and stops at the first set from the stop year", async () => {
    const env = makeEnv();
    await updateAppSettings(env, { trackSets: { viewsPerTick: 10, stepCount: 50 } });
    await queueTrack(env);
    const page1 = rows("p", 15, (i) => `2026-10-${String(20 - i).padStart(2, "0")}`);
    const step1 = rows("s", 50, () => "2023-06-01");
    const step2 = [...rows("t", 3, () => "2021-02-01"), ...rows("u", 2, () => "2020-12-30")];
    const asked = stubPool(
      () => trackPage(page1),
      (form) => {
        const chunk = form.pos === "15" ? step1 : step2;
        return { success: true, data: chunk.map((r) => rowHtml(r.id, r.title, r.date)).join("") };
      },
    );
    const r = await drainTrackSets(env, log, NOW);
    expect(r).toMatchObject({ views: 3, finished: 1, added: 70, failed: 0 });
    expect(asked.map((a) => [a.kind, a.priority])).toEqual([
      ["dj", "backfill"],
      ["dj", "backfill"],
      ["dj", "backfill"],
    ]);
    expect(asked[0]!.url).toBe(TRACK_URL);
    expect(asked[1]!.form).toEqual({
      width: "1920",
      type: "track",
      idScrollObject: TRACK_ID,
      subtype: "tracklists",
      count: "50",
      pos: "15",
      id: "p14",
    });
    expect(asked[1]!.referer).toBe(TRACK_URL);
    expect(asked[2]!.form).toMatchObject({ pos: "65", id: "s49" });
    const c = await crawlRow(env);
    expect(c).toMatchObject({
      walks: 1,
      stop_reason: "year",
      cursor_id: null,
      steps: 0,
      sets_seen: 70,
      oldest_date: "2020-12-30",
      next_at: NOW + 30 * 86400,
    });
  });

  it("a busy track (busyRows sets seen) stops at busyStopYear instead of stopYear", async () => {
    const env = makeEnv();
    await updateAppSettings(env, {
      trackSets: { viewsPerTick: 10, stepCount: 100, busyRows: 100 },
    });
    await queueTrack(env, "busy", `${ORIGIN}/track/busy/x/index.html`, 9);
    await queueTrack(env, "quiet", `${ORIGIN}/track/quiet/x/index.html`, 1);
    // Both lists reach 2022 sets in their first scroll step; only the busy one has seen 100 sets by then.
    const asked = stubPool(
      (url) => trackPage(rows(url.includes("busy") ? "b" : "q", 15, () => "2026-01-01")),
      (form, referer) => {
        const busy = !!referer?.includes("/busy/");
        const n = busy ? 100 : 20;
        const chunk = [
          ...rows(`${busy ? "b" : "q"}s${form.pos}x`, n - 1, () => "2024-01-01"),
          ...rows(`${busy ? "b" : "q"}old${form.pos}x`, 1, () => "2022-06-01"),
        ];
        return { success: true, data: chunk.map((r) => rowHtml(r.id, r.title, r.date)).join("") };
      },
    );
    await drainTrackSets(env, log, NOW);
    expect(await crawlRow(env, "busy")).toMatchObject({ walks: 1, stop_reason: "year" });
    expect(asked.filter((a) => a.form && a.referer?.includes("/busy/"))).toHaveLength(1);
    // The quiet track's 2022 sets do not stop it while it has seen fewer than 100 (35, 55, 75, 95);
    // its fifth step reaches 115 and it stops there.
    expect(asked.filter((a) => a.form && a.referer?.includes("/quiet/"))).toHaveLength(5);
    expect(await crawlRow(env, "quiet")).toMatchObject({ walks: 1, stop_reason: "year" });
  });

  it("ends a short list at page 1 and a long one at the site's end", async () => {
    const env = makeEnv();
    await updateAppSettings(env, { trackSets: { viewsPerTick: 10 } });
    await queueTrack(env, "short", `${ORIGIN}/track/short/x/index.html`, 9);
    await queueTrack(env, "long", `${ORIGIN}/track/long/x/index.html`, 1);
    const asked = stubPool(
      (url) =>
        trackPage(
          rows(
            url.includes("short") ? "a" : "b",
            url.includes("short") ? 4 : 15,
            () => "2026-01-01",
          ),
        ),
      () => ({ success: true, end: true, data: rowHtml("last", "Z - Last", "2025-01-01") }),
    );
    const r = await drainTrackSets(env, log, NOW);
    expect(r).toMatchObject({ views: 3, finished: 2 });
    expect(asked.map((a) => a.url.replace(ORIGIN, ""))).toEqual([
      "/track/short/x/index.html",
      "/track/long/x/index.html",
      "/ajax/get_data.php",
    ]);
    expect((await crawlRow(env, "short"))!.stop_reason).toBe("end");
    expect((await crawlRow(env, "long"))!.stop_reason).toBe("end");
    expect(await setIds(env, "long")).toContain("last");
  });

  it("carries a walk over to the next tick when the views run out, and goes on from its cursor first", async () => {
    const env = makeEnv();
    await updateAppSettings(env, { trackSets: { viewsPerTick: 2, stepCount: 10 } });
    await queueTrack(env, TRACK_ID, TRACK_URL, 1);
    await queueTrack(env, "other", `${ORIGIN}/track/other/x/index.html`, 50);
    let n = 0;
    const asked = stubPool(
      (url) => trackPage(rows(url.includes("other") ? "o" : "p", 15, () => "2026-01-01")),
      () => {
        n++;
        return {
          success: true,
          data: rows(`s${n}x`, 10, () => "2025-01-01")
            .map((r) => rowHtml(r.id, r.title, r.date))
            .join(""),
        };
      },
    );
    await drainTrackSets(env, log, NOW);
    // The heavier track went first and used both views.
    expect(asked.map((a) => a.url.replace(ORIGIN, ""))).toEqual([
      "/track/other/x/index.html",
      "/ajax/get_data.php",
    ]);
    expect(await crawlRow(env, "other")).toMatchObject({
      cursor_pos: 25,
      cursor_id: "s1x9",
      steps: 1,
      walks: 0,
      next_at: NOW,
    });
    await drainTrackSets(env, log, NOW + 300);
    expect(asked[2]!.url).toBe(`${ORIGIN}/ajax/get_data.php`);
    expect(asked[2]!.form).toMatchObject({ idScrollObject: "other", pos: "25", id: "s1x9" });
  });

  it("stops starting steps when the tick's seconds are up, and saves the cursor", async () => {
    const env = makeEnv();
    await updateAppSettings(env, { trackSets: { tickSeconds: 10, stepCount: 10 } });
    await queueTrack(env);
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    let n = 0;
    const asked = stubPool(
      () => {
        clock += 4000;
        return trackPage(rows("p", 15, () => "2026-01-01"));
      },
      () => {
        clock += 4000;
        n++;
        return {
          success: true,
          data: rows(`s${n}x`, 10, () => "2025-01-01")
            .map((r) => rowHtml(r.id, r.title, r.date))
            .join(""),
        };
      },
    );
    const r = await drainTrackSets(env, log, NOW);
    // Page 1 at 4 s, steps at 8 s and 12 s; the 10 s are up after that.
    expect(r.views).toBe(3);
    expect(asked).toHaveLength(3);
    expect(await crawlRow(env)).toMatchObject({ walks: 0, cursor_pos: 35, cursor_id: "s2x9" });
    vi.restoreAllMocks();
  });

  it("spends at most maxShare of the pool's backfill allowance over 24 h, page loads and scroll XHRs apart", async () => {
    const env = makeEnv();
    await updateAppSettings(env, { trackSets: { stepCount: 10, maxShare: 0.5 } });
    // 2 fetching accounts (a passive and a retired one do not count): 2 x 60 XHRs, 70 pages; backfill ceiling 0.75.
    admin = {
      status: {
        accounts: [
          { id: "a1", state: "active" },
          { id: "a2", state: "warming" },
          { id: "a3", state: "passive", passive: true },
          { id: "a4", state: "retired" },
        ],
        totals: { usedToday: 10, budgetToday: 70 },
      },
      settings: {
        budgetPerDay: 35,
        xhrBudgetPerDay: 60,
        reservedPhoneShare: 0.2,
        priorityCeilings: { backfill: 0.75 },
      },
    };
    // Allowance: pages floor(70 x 0.75) = 52, XHRs floor(120 x 0.75) = 90; half: 26 pages, 45 XHRs.
    // The last 24 h already spent 26 pages and 43 XHRs (an hour older than that is not counted).
    const hour = Math.floor(NOW / 3600);
    await env.CACHE.put(
      USAGE_KEY,
      JSON.stringify({
        [hour]: { p: 20, x: 40 },
        [hour - 5]: { p: 6, x: 3 },
        [hour - 30]: { p: 99, x: 99 },
      }),
    );
    await queueTrack(env);
    await env.DB.prepare(
      "UPDATE track_set_crawl SET cursor_pos = 15, cursor_id = 'p14' WHERE track_page_id = ?",
    )
      .bind(TRACK_ID)
      .run();
    await queueTrack(env, "fresh", `${ORIGIN}/track/fresh/x/index.html`, 99);
    let n = 0;
    const asked = stubPool(
      () => trackPage(rows("p", 15, () => "2026-01-01")),
      () => {
        n++;
        return {
          success: true,
          data: rows(`s${n}x`, 10, () => "2025-01-01")
            .map((r) => rowHtml(r.id, r.title, r.date))
            .join(""),
        };
      },
    );
    const r = await drainTrackSets(env, log, NOW);
    // No page loads left: only the mid-walk track's scroll steps go, 2 of them.
    expect(r.share).toEqual({
      allowance: { pages: 52, xhr: 90 },
      used: { p: 26, x: 43 },
      pagesLeft: 0,
      xhrLeft: 2,
    });
    expect(asked.map((a) => a.url.replace(ORIGIN, ""))).toEqual([
      "/ajax/get_data.php",
      "/ajax/get_data.php",
    ]);
    expect(r.views).toBe(2);
    // The two are counted toward the next tick, which has nothing left.
    const usage = JSON.parse((await env.CACHE.get(USAGE_KEY))!) as Record<
      string,
      { p: number; x: number }
    >;
    expect(usage[hour]).toEqual({ p: 20, x: 42 });
    expect(usage[hour - 30]).toBeUndefined();
    expect((await drainTrackSets(env, log, NOW + 300)).skipped).toBe("share_spent");
  });

  it("stops a walk at maxSteps", async () => {
    const env = makeEnv();
    await updateAppSettings(env, { trackSets: { viewsPerTick: 10, maxSteps: 2, stepCount: 10 } });
    await queueTrack(env);
    let n = 0;
    stubPool(
      () => trackPage(rows("p", 15, () => "2026-01-01")),
      () => {
        n++;
        return {
          success: true,
          data: rows(`s${n}x`, 10, () => "2025-01-01")
            .map((r) => rowHtml(r.id, r.title, r.date))
            .join(""),
        };
      },
    );
    const r = await drainTrackSets(env, log, NOW);
    expect(r.views).toBe(3);
    expect((await crawlRow(env))!.stop_reason).toBe("max_steps");
  });

  it("a recrawl stops at the first set the track already has", async () => {
    const env = makeEnv();
    await updateAppSettings(env, { trackSets: { viewsPerTick: 10, recrawlDays: 1 } });
    await queueTrack(env);
    let list = rows("p", 4, () => "2026-01-01");
    stubPool(
      () => trackPage(list),
      () => {
        throw new Error("no scroll expected");
      },
    );
    await drainTrackSets(env, log, NOW);
    expect((await crawlRow(env))!.walks).toBe(1);
    // A day later the page shows 15: three new on top, then the known ones (and more below).
    list = [...rows("n", 3, () => "2026-02-01"), ...rows("p", 12, () => "2026-01-01")];
    const r = await drainTrackSets(env, log, NOW + 86400);
    expect(r).toMatchObject({ views: 1, finished: 1 });
    expect(await crawlRow(env)).toMatchObject({ walks: 2, stop_reason: "known" });
    expect((await setIds(env)).filter((id) => id.startsWith("n"))).toEqual(["n0", "n1", "n2"]);
  });

  it("a pool refusal ends the tick, charges the row nothing and holds the crawl alone on budget_exhausted", async () => {
    const env = makeEnv();
    await updateAppSettings(env, { trackSets: { viewsPerTick: 10, stepCount: 10 } });
    await queueTrack(env);
    stubPool(
      () => trackPage(rows("p", 15, () => "2026-01-01")),
      () => ({ error: "budget_exhausted", retryAfterSeconds: 1200 }),
    );
    const r = await drainTrackSets(env, log, NOW);
    expect(r.stoppedBy).toBeTruthy();
    expect(r.views).toBe(1);
    // Page 1 was stored and its cursor kept; the row is due as it was before the claim.
    expect(await crawlRow(env)).toMatchObject({
      cursor_pos: 15,
      cursor_id: "p14",
      next_at: 0,
      attempts: 0,
    });
    // The crawl holds itself only: the other backfill jobs (pre-warm, DJ history) go on.
    expect(Number(await env.CACHE.get(HOLD_KEY))).toBe(NOW + 1200);
    expect(await env.CACHE.get(budgetHoldKey("backfill"))).toBeNull();
    expect((await drainTrackSets(env, log, NOW + 60)).skipped).toBe("budget_hold");
  });

  it("a failed step backs off, and a page without the list ends the walk", async () => {
    const env = makeEnv();
    await updateAppSettings(env, { trackSets: { viewsPerTick: 10 } });
    await queueTrack(env);
    await queueTrack(env, "gone", `${ORIGIN}/track/gone/x/index.html`, 0);
    stubPool(
      (url) =>
        url.includes("gone")
          ? "<html><body>No such track</body></html>"
          : trackPage(rows("p", 15, () => "2026-01-01")),
      () => ({ success: false }),
    );
    const r = await drainTrackSets(env, log, NOW);
    expect(r.failed).toBe(1);
    expect(await crawlRow(env)).toMatchObject({
      attempts: 1,
      cursor_id: "p14",
      next_at: NOW + 6 * 3600,
      walks: 0,
    });
    expect(await crawlRow(env, "gone")).toMatchObject({ walks: 1, stop_reason: "no_list" });
  });

  it("is off when disabled, and never throws without a pool", async () => {
    const env = makeEnv();
    await updateAppSettings(env, { trackSets: { enabled: false } });
    expect((await drainTrackSets(env, log, NOW)).skipped).toBe("off");
    const bare = makeEnv({ TLPOOL_URL: undefined, TLPOOL_TOKEN: undefined } as Partial<Env>);
    expect((await drainTrackSets(bare, log, NOW)).skipped).toBe("pool_not_configured");
  });
});

describe("trackSetsSummary", () => {
  it("says the last 24 hours' rate, the days the queue has left at it, and the page share that paces it", async () => {
    const env = makeEnv();
    const ins = env.DB.prepare(
      "INSERT INTO track_set_crawl (track_page_id, track_url, queued_at, walks, crawled_at, cursor_id) VALUES (?, 'u', 0, ?, ?, ?)",
    );
    // Two walks ended in the last 24 h, one before; one track mid-walk, seven never walked.
    await ins.bind("a", 1, NOW - 3600, null).run();
    await ins.bind("b", 1, NOW - 23 * 3600, null).run();
    await ins.bind("c", 1, NOW - 25 * 3600, null).run();
    await ins.bind("d", 0, null, "x1").run();
    for (let i = 0; i < 6; i++) await ins.bind(`n${i}`, 0, null, null).run();
    const hour = Math.floor(NOW / 3600);
    await env.CACHE.put(
      USAGE_KEY,
      JSON.stringify({
        [hour]: { p: 40, x: 9 },
        [hour - 5]: { p: 2, x: 0 },
        [hour - 30]: { p: 99, x: 0 },
      }),
    );
    await env.CACHE.put(ALLOWANCE_KEY, JSON.stringify({ pages: 1000, xhr: 2000 }));
    expect(await trackSetsSummary(env, NOW)).toEqual({
      queued: 10,
      walked: 3,
      walking: 1,
      sets: 0,
      read24h: 2,
      etaDays: 3.5,
      pages24h: 42,
      // The default share (0.75) of the cached allowance.
      pageShare: 750,
    });
    await updateAppSettings(env, { trackSets: { maxShare: 0.5 } });
    expect((await trackSetsSummary(env, NOW))?.pageShare).toBe(500);
  });

  it("has no rate to go by when nothing ended in 24 h, and no share without a cached allowance", async () => {
    const env = makeEnv();
    await env.DB.prepare(
      "INSERT INTO track_set_crawl (track_page_id, track_url, queued_at, walks) VALUES ('a', 'u', 0, 0)",
    ).run();
    expect(await trackSetsSummary(env, NOW)).toMatchObject({
      queued: 1,
      walked: 0,
      read24h: 0,
      etaDays: null,
      pages24h: 0,
      pageShare: null,
    });
  });
});

describe("Recommended sets", () => {
  async function seeded(): Promise<Env> {
    const env = makeEnv();
    const a = parseTrackSetRows(
      rowHtml("top", "Stranger - Big Show", "2026-03-01") +
        rowHtml("mid", "Other - Small Show", "2026-02-01") +
        rowHtml("mine", "Followed DJ - My Show", "2026-01-01"),
    );
    const followed = new Set(["followed dj"]);
    await storeTrackSetRows(env, "t1", a, followed, NOW);
    await storeTrackSetRows(env, "t2", a.slice(0, 2), followed, NOW);
    await storeTrackSetRows(env, "t3", a.slice(0, 1), followed, NOW);
    await env.DB.prepare(
      "INSERT INTO track_set_crawl (track_page_id, track_url, queued_at, walks) VALUES ('t1', ?, 0, 1)",
    )
      .bind(`${ORIGIN}/track/t1/some-artist-some-title/index.html`)
      .run();
    await env
      .SEARCH_DB!.prepare(
        "INSERT INTO search_tracks (id, track_key, page_id, artist, title, sets_count, updated_at) VALUES (1, 't:1', 't2', 'Artist Two', 'Title Two', 1, 0)",
      )
      .run();
    return env;
  }

  it("ranks other DJs' sets by how many tracks list them, followed sets left out", async () => {
    const env = await seeded();
    const res = await app.request("/ui/api/recommended", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{
        set_id: string;
        track_count: number;
        title: string;
        set_url: string;
        share: number;
      }>;
      total: number;
      progress: unknown;
    };
    expect(body.rows.map((r) => [r.set_id, r.track_count])).toEqual([
      ["top", 3],
      ["mid", 2],
    ]);
    expect(body.total).toBe(2);
    expect(body.rows[0]).toMatchObject({
      views: 28,
      likes: 0,
      genres: "Tech House",
      total_tracks: 14,
      djs: "Stranger",
    });
    expect(body.rows[0]!.share).toBeCloseTo(3 / 14);
    expect(body.progress).toEqual({
      queued: 1,
      walked: 1,
      walking: 0,
      sets: 2,
      read24h: 0,
      etaDays: 0,
      pages24h: 0,
      pageShare: null,
    });
    expect(await trackSetsSummary(env)).toEqual(body.progress);
    // Sorting by views and filtering on a genre are table queries like any other.
    const byGenre = await app.request("/ui/api/recommended?f.genres=has:tech&sort=-views", {}, env);
    expect(byGenre.status).toBe(200);
    expect(((await byGenre.json()) as { total: number }).total).toBe(2);
  });

  it("ranks by the share of the set: a short set with fewer matches beats a long countdown", async () => {
    const env = makeEnv();
    const long = parseTrackSetRows(
      rowHtml("countdown", "AdamK & Camille - Top 1000", "2026-01-01", "U", { ided: "900/1000" }),
    );
    const short = parseTrackSetRows(
      rowHtml("tight", "Stranger @ Club", "2026-01-01", "U", { ided: "all/20" }),
    );
    for (let i = 0; i < 30; i++) await storeTrackSetRows(env, `t${i}`, long, new Set(), NOW);
    for (let i = 0; i < 10; i++) await storeTrackSetRows(env, `t${i}`, short, new Set(), NOW);
    const res = await app.request("/ui/api/recommended?sort=-share", {}, env);
    const rows = (
      (await res.json()) as { rows: Array<{ set_id: string; share: number; djs: string }> }
    ).rows;
    expect(rows.map((r) => [r.set_id, r.share, r.djs])).toEqual([
      ["tight", 0.5, "Stranger"],
      ["countdown", 0.03, "AdamK & Camille"],
    ]);
  });

  it("caps the share at 1: a short list of mashups has more followed tracks than rows", async () => {
    const env = makeEnv();
    // Two rows, each a mashup: the mashup's page and both originals' pages list the set (6 tracks, 2 rows).
    const mash = parseTrackSetRows(
      rowHtml("mashups", "Oliver Heldens @ Festival", "2024-06-02", "U", { ided: "all/2" }),
    );
    const half = parseTrackSetRows(
      rowHtml("half", "Stranger @ Club", "2026-01-01", "U", { ided: "all/4" }),
    );
    for (let i = 0; i < 6; i++) await storeTrackSetRows(env, `m${i}`, mash, new Set(), NOW);
    for (let i = 0; i < 2; i++) await storeTrackSetRows(env, `h${i}`, half, new Set(), NOW);
    const res = await app.request("/ui/api/recommended?sort=-share", {}, env);
    const rows = (
      (await res.json()) as { rows: Array<{ set_id: string; share: number; track_count: number }> }
    ).rows;
    expect(rows.map((r) => [r.set_id, r.share, r.track_count])).toEqual([
      ["mashups", 1, 6],
      ["half", 0.5, 2],
    ]);
  });

  it("lists the tracks that put a set there, named from the search index when it has them", async () => {
    const env = await seeded();
    expect(await recommendedSetTracks(env, "top")).toEqual([
      {
        trackPageId: "t1",
        trackUrl: `${ORIGIN}/track/t1/some-artist-some-title/index.html`,
        artist: null,
        title: null,
        seenAt: NOW,
      },
      { trackPageId: "t2", trackUrl: null, artist: "Artist Two", title: "Title Two", seenAt: NOW },
      { trackPageId: "t3", trackUrl: null, artist: null, title: null, seenAt: NOW },
    ]);
    const res = await app.request("/ui/api/recommended/top/tracks", {}, env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tracks: unknown[] }).tracks).toHaveLength(3);
    expect((await app.request("/ui/api/recommended/bad%20id/tracks", {}, env)).status).toBe(400);
  });

  it("serves the page with its nav entry", async () => {
    const res = await app.request("/ui/recommended", {}, makeEnv());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Recommended sets");
    expect(html).toContain("/ui/api/recommended");
    expect(html).toContain('href="/ui/recommended"');
    // The set title opens the set in tracked; 1001tracklists is a row button.
    expect(html).toContain("/ui/set?url=");
    expect(html).toContain(">1001tracklists</a>");
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
      (m) => m[1]!,
    );
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) expect(() => new vm.Script(s)).not.toThrow();
  });
});
