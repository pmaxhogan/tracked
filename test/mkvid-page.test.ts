// The /ui/mkvid page script in a stub DOM: the header, the three tables
// (Queue and Finished are server-side TKTables, Old videos local), the
// reorder/ban buttons, the drawer's actions, the Delete-and-recreate confirm
// and the inline error line.
import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { MKVID_PAGE_HTML } from "../src/ui/pages/mkvid";

const RECREATE_ASK =
  "Delete and recreate this video? The set is rendered again at the back of the queue; the current video stays up until the new one is in the playlists, then it is deleted from YouTube.";

const scripts = [...MKVID_PAGE_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

const NOW = Math.floor(Date.now() / 1000);
const DONE = {
  id: "r2",
  slug: "some-dj",
  setUrl: "https://www.1001tracklists.com/tracklist/x/some-set.html",
  setTitle: "Some Set",
  setDate: "2026-09-01",
  source: "soundcloud",
  sourceLabel: "SoundCloud",
  sourceUrl: "https://soundcloud.com/x/y",
  status: "done",
  account: "primary",
  attempts: 1,
  notBefore: null,
  createdAt: NOW,
  updatedAt: NOW,
  skipIdWait: false,
  style: "scene",
  replacesVideoId: null,
  videoId: "abcdefghijk",
  readiness: null,
};
const WAITING = (id: string, position: number, extra: Record<string, unknown> = {}) => ({
  ...DONE,
  id,
  status: "pending",
  videoId: null,
  style: null,
  position,
  setTitle: "Waiting <b>" + id + "</b>",
  readiness: { state: "waiting_ids", until: NOW + 86400 * 3, idRows: 2 },
  ...extra,
});

function header(extra: Record<string, unknown> = {}) {
  return {
    enabled: true,
    dailyClaimCap: 30,
    dailyClaims: 3,
    now: NOW,
    quotaResetsAt: NOW + 3600,
    counts: { pending: 2, claimed: 1, done: 1, failed: 0, superseded: 0, banned: 0 },
    accounts: [{ account: "primary", label: "primary", cap: 24, used: 3 }],
    lastPoll: { at: NOW, outcome: "ok", accounts: ["primary"] },
    oldStyleCount: 0,
    oldVideos: [
      {
        videoId: "oldvid00001",
        setUrl: DONE.setUrl,
        replacedBy: "abcdefghijk",
        state: "pending",
        attempts: 1,
        nextTryAt: NOW + 600,
        lastError: "quota",
        createdAt: NOW,
      },
    ],
    djs: [{ slug: "some-dj", label: "Some DJ", count: 3 }],
    rendering: [{ ...DONE, id: "r9", status: "claimed", setTitle: "Rendering Set", videoId: null }],
    ...extra,
  };
}
const tableOf = (rows: unknown[]) => ({
  rows,
  total: rows.length,
  page: 1,
  size: 25,
  pageCount: 1,
  sort: [],
  filters: [],
  q: "",
});
/** The page's GETs: the header, the two tables, the progress (unavailable). */
function answers(url: string): Response {
  if (url.startsWith("/ui/api/mkvid/finished?")) return Response.json(tableOf([DONE]));
  if (url.startsWith("/ui/api/mkvid/queue?"))
    return Response.json(
      tableOf([
        WAITING("r3", 7, {
          timedPct: 89,
          timedRows: 43,
          baseRows: 48,
          appleCues: 42,
          listCheckedAt: NOW - 3600,
          idsPct: 89,
          listRows: 48,
          listIdRows: 5,
        }),
        WAITING("r4", 8),
      ]),
    );
  if (url === "/ui/api/mkvid") return Response.json(header());
  return Response.json({ error: "mkvid_unavailable" }, { status: 503 });
}

/** A stub DOM that keeps each element's listeners, so clicks can be driven. */
function page(answer: (url: string, init?: RequestInit) => Response, search = "") {
  const location = { search, pathname: "/ui/mkvid", hash: "" };
  const el = (): any => {
    const n: any = {
      open: false,
      innerHTML: "",
      textContent: "",
      value: "",
      hidden: false,
      checked: false,
      disabled: false,
      className: "",
      src: "",
      dataset: {},
      style: {},
      options: [],
      on: {} as Record<string, (e: any) => unknown>,
      addEventListener(type: string, fn: (e: any) => unknown) {
        n.on[type] = fn;
      },
      focus() {},
      add() {},
      remove() {},
      showModal() {
        n.open = true;
      },
      close() {
        n.open = false;
        if (n.onclose) n.onclose();
      },
      setAttribute() {},
      removeAttribute() {},
      getAttribute: () => null,
      querySelector: (sel: string) => (sel === "[data-derr]" ? (n.derr ?? (n.derr = el())) : null),
      querySelectorAll: () => [],
      closest: () => null,
    };
    return n;
  };
  const els = new Map<string, any>();
  const get = (id: string) => (els.has(id) ? els.get(id) : (els.set(id, el()), els.get(id)));
  const document = {
    hidden: false,
    getElementById: get,
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
    createElement: () => el(),
  };
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
    return answer(url, init);
  };
  const ctx = vm.createContext({
    document,
    fetch,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    console,
    Date,
    URLSearchParams,
    JSON,
    URL,
    location,
    history: {
      state: null,
      replaceState(_s: unknown, _t: string, u: string) {
        const i = u.indexOf("?");
        location.search = i < 0 ? "" : u.slice(i);
      },
    },
    Option: function (t: string, v: string) {
      return { text: t, value: v };
    },
  });
  for (const s of scripts) vm.runInContext(s, ctx);
  return { get, calls, location };
}

/** A click on table row i (TKTable delegates through closest('tr[data-tkt-row]')). */
const rowClick = (i: number) => {
  const tr = { getAttribute: (k: string) => (k === "data-tkt-row" ? String(i) : null) };
  return {
    target: {
      getAttribute: () => null,
      closest: (sel: string) => (sel === "tr[data-tkt-row]" ? tr : null),
    },
  };
};
/** A click on a data-act button in table row i. */
const actClick = (i: number, act: string) => {
  const tr = {
    getAttribute: (k: string) => (k === "data-tkt-row" ? String(i) : null),
    querySelectorAll: () => [],
  };
  const btn: any = {
    getAttribute: (k: string) => (k === "data-act" ? act : null),
    disabled: false,
    textContent: "",
    closest: (sel: string) => (sel === "tr" ? tr : null),
  };
  return {
    target: {
      getAttribute: () => null,
      closest: (sel: string) =>
        sel === "[data-act]" ? btn : sel === "tr[data-tkt-row]" ? tr : null,
    },
  };
};
const ctlClick = (attrs: Record<string, string>) => {
  const t: any = { getAttribute: (k: string) => (k in attrs ? attrs[k] : null), disabled: false };
  t.closest = (sel: string) => (sel === "[data-tkt]" && "data-tkt" in attrs ? t : null);
  return { target: t };
};
const gets = (calls: Array<{ method: string; url: string }>) =>
  calls.filter((c) => c.method === "GET").map((c) => decodeURIComponent(c.url));
const doClick = (what: string) => {
  const btn = { dataset: { do: what }, textContent: "x", disabled: false };
  return { target: { closest: (sel: string) => (sel === "button[data-do]" ? btn : null) } };
};
const posts = (calls: Array<{ method: string; url: string }>) =>
  calls.filter((c) => c.method === "POST");

describe("mkvid page drawer", () => {
  it("Delete and recreate asks first: yes sends POST /ui/api/mkvid/recreate/{id}, no sends nothing", async () => {
    const { get, calls } = page((url, init) =>
      init?.method === "POST" ? Response.json({ ok: true }) : answers(url),
    );
    await settle();
    get("mk-settled").on.click(rowClick(0));
    const body = get("tk-drawer-body");
    expect(get("tk-drawer").open).toBe(true);
    expect(body.innerHTML).toContain("Delete and recreate");

    // Cancel: no request.
    let p = body.onclick(doClick("recreate"));
    await settle();
    expect(get("tk-confirm-text").textContent).toBe(RECREATE_ASK);
    expect(get("tk-confirm").open).toBe(true);
    get("tk-confirm-no").onclick();
    await p;
    expect(posts(calls)).toEqual([]);
    expect(get("tk-drawer").open).toBe(true);

    // Confirm: one POST, then the drawer closes and the header and both tables reload.
    const before = calls.length;
    p = body.onclick(doClick("recreate"));
    await settle();
    get("tk-confirm-yes").onclick();
    await p;
    await settle();
    expect(posts(calls)).toMatchObject([{ url: "/ui/api/mkvid/recreate/r2", body: "{}" }]);
    expect(get("tk-drawer").open).toBe(false);
    expect(
      gets(calls.slice(before)).filter(
        (u) =>
          u === "/ui/api/mkvid" ||
          u.startsWith("/ui/api/mkvid/queue?") ||
          u.startsWith("/ui/api/mkvid/finished?"),
      ),
    ).toHaveLength(3);
  });

  it("a failed request (any kind) offers Ban next to Retry: POST /ui/api/mkvid/ban/{id}; a partial recording is info", async () => {
    const FAILED = {
      ...DONE,
      id: "r5",
      status: "failed",
      videoId: null,
      error: "yt-dlp exit 1: \n\nERROR: Did not get any data blocks\n",
    };
    const PARTIAL = { ...DONE, id: "r6", partialNote: "~20 s missing at 20:49" };
    const { get, calls } = page((url, init) =>
      init?.method === "POST"
        ? Response.json({ ok: true })
        : url.startsWith("/ui/api/mkvid/finished?")
          ? Response.json(tableOf([FAILED, PARTIAL, { ...DONE, id: "r7", status: "banned" }]))
          : answers(url),
    );
    await settle();
    get("mk-settled").on.click(rowClick(0));
    const body = get("tk-drawer-body");
    expect(body.innerHTML).toContain('data-do="retry"');
    expect(body.innerHTML).toContain('data-do="ban"');
    await body.onclick(doClick("ban"));
    await settle();
    expect(posts(calls)).toMatchObject([{ url: "/ui/api/mkvid/ban/r5", body: "{}" }]);
    // Done (with its partial note, shown neutral) and banned: no Ban.
    get("mk-settled").on.click(rowClick(1));
    expect(get("tk-drawer-body").innerHTML).not.toContain('data-do="ban"');
    expect(get("tk-drawer-body").innerHTML).toContain("partial recording: ~20 s missing at 20:49");
    expect(get("tk-drawer-body").innerHTML).not.toContain("mk-err");
    get("mk-settled").on.click(rowClick(2));
    expect(get("tk-drawer-body").innerHTML).not.toContain('data-do="ban"');
  });

  it("a failed action keeps the drawer open with the reason inline and reloads", async () => {
    const { get, calls } = page((url, init) =>
      init?.method === "POST"
        ? Response.json({ error: "not_found", message: "no such request" }, { status: 404 })
        : answers(url),
    );
    await settle();
    get("mk-settled").on.click(rowClick(0));
    const body = get("tk-drawer-body");
    const before = calls.length;
    await body.onclick(doClick("retry"));
    await settle();
    expect(posts(calls)).toMatchObject([{ url: "/ui/api/mkvid/retry/r2" }]);
    expect(get("tk-drawer").open).toBe(true);
    const line = body.querySelector("[data-derr]");
    expect(line.hidden).toBe(false);
    expect(line.textContent).toBe("retry failed (404): no such request");
    expect(gets(calls.slice(before))).toContain("/ui/api/mkvid");
  });
});

describe("mkvid page tables", () => {
  it("paints the header, rendering now, the queue in claim order with positions and moves, and the finished table", async () => {
    const { get, calls } = page((url) => answers(url));
    await settle();
    expect(
      gets(calls)
        .filter((u) => u.startsWith("/ui/api/mkvid") && !u.includes("/progress"))
        .sort(),
    ).toEqual([
      "/ui/api/mkvid",
      "/ui/api/mkvid/finished?page=1&size=25&sort=-updatedAt",
      "/ui/api/mkvid/queue?page=1&size=25&sort=position",
    ]);
    expect(get("mk-state").innerHTML).toContain("Rendering 1 set now");
    expect(get("mk-rendering").innerHTML).toContain("Rendering Set");
    const q = get("q-body").innerHTML as string;
    expect(q).toContain("#7");
    expect(q).toContain("waiting for IDs until");
    expect(q).toContain("Waiting &lt;b&gt;r3");
    expect(q).not.toContain("<b>r3");
    for (const a of ["top", "up", "down", "bottom", "ban"]) expect(q).toContain(`data-act="${a}"`);
    // The Timed column: the list's share with cue times, the counts in its tooltip; no list reads "-".
    expect(get("q-head").innerHTML).toContain("Timed");
    expect(q).toContain(">89%</span>");
    expect(q).toContain(
      'data-tip="43 of 48 tracks have a cue time (42 from Apple Music), checked ',
    );
    expect(get("fin-head").innerHTML).not.toContain("Timed");
    // The IDs column: the list's identified share, the counts in its tooltip.
    expect(get("q-head").innerHTML).toContain(">IDs<");
    expect(q).toContain('data-tip="43 of 48 tracks are identified, 5 still ID, checked ');
    expect(get("fin-head").innerHTML).not.toContain(">IDs<");
    expect(get("fin-body").innerHTML).toContain('href="https://youtu.be/abcdefghijk"');
    expect(get("old-body").innerHTML).toContain("oldvid00001");
    expect(get("mk-n-queue").textContent).toBe("3");
    expect(get("mk-dj").innerHTML).toContain('<option value="some-dj">Some DJ (3)</option>');
  });

  it("moves post the whole-queue move and reload; sorted by another column only ban is offered", async () => {
    const { get, calls } = page((url, init) =>
      init?.method === "POST" ? Response.json({ ok: true }) : answers(url),
    );
    await settle();
    get("mk-queue").on.click(actClick(1, "up"));
    await settle();
    expect(calls.filter((c) => c.method === "POST")).toMatchObject([
      { url: "/ui/api/mkvid/move/r4", body: '{"to":"up"}' },
    ]);
    get("mk-queue").on.click(ctlClick({ "data-tkt": "sort", "data-col": "setDate" }));
    await settle();
    expect(gets(calls).at(-1)).toBe("/ui/api/mkvid/queue?page=1&size=25&sort=setDate");
    const q = get("q-body").innerHTML as string;
    expect(q).not.toContain('data-act="up"');
    expect(q).toContain('data-act="ban"');
    get("mk-queue").on.click(actClick(0, "ban"));
    await settle();
    expect(calls.filter((c) => c.method === "POST").at(-1)).toMatchObject({
      url: "/ui/api/mkvid/ban/r3",
    });
  });

  it("the DJ select and chips filter on the server; old ?status=&tab= links become table filters", async () => {
    const { get, calls } = page((url) => answers(url));
    await settle();
    get("mk-dj").value = "some-dj";
    get("mk-dj").on.change({});
    await settle();
    expect(gets(calls)).toContain(
      "/ui/api/mkvid/queue?page=1&size=25&sort=position&f.dj=eq:some-dj",
    );
    expect(gets(calls)).toContain(
      "/ui/api/mkvid/finished?page=1&size=25&sort=-updatedAt&f.dj=eq:some-dj",
    );
    get("mk-settled").on.click(ctlClick({ "data-tkt": "chip", "data-chip": "problems" }));
    await settle();
    expect(gets(calls).at(-1)).toBe(
      "/ui/api/mkvid/finished?page=1&size=25&sort=-updatedAt&f.status=in:failed|removed_unconfirmed|banned&f.dj=eq:some-dj",
    );

    const old = page(
      (url) => answers(url),
      "?status=failed,banned&tab=settled&source=hearthis&q=palmer",
    );
    await settle();
    expect(gets(old.calls)).toContain(
      "/ui/api/mkvid/finished?page=1&size=25&sort=-updatedAt&q=palmer&f.source=in:hearthis&f.status=in:failed|banned",
    );
    expect(gets(old.calls)).toContain(
      "/ui/api/mkvid/queue?page=1&size=25&sort=position&q=palmer&f.source=in:hearthis",
    );
    expect(old.location.search).not.toMatch(/[?&](status|source|q)=/);
    expect(old.get("mk-p-settled").hidden).toBe(false);
    expect(old.get("mk-p-queue").hidden).toBe(true);
    // An old ?status=superseded still means every superseded request, now three outcomes.
    const sup = page((url) => answers(url), "?status=superseded&tab=settled");
    await settle();
    expect(gets(sup.calls)).toContain(
      "/ui/api/mkvid/finished?page=1&size=25&sort=-updatedAt&f.status=in:superseded|has_recording|duplicate",
    );
  });

  it("a set without a usable recording reads neutral and in plain words, and is not counted as failed; a real failure stays red", async () => {
    const said =
      "probe: yt-dlp exit 1: ERROR: [soundcloud] 77: Unable to download JSON metadata: HTTP Error 404: Not Found";
    const line = 'The recording is gone from SoundCloud (the link answers "not found").';
    const GONE = {
      ...DONE,
      id: "g1",
      setTitle: "Gone Set",
      status: "failed",
      videoId: null,
      error: said,
      outcome: "recording_removed",
      outcomeLine: line,
      outcomeDetail: line + " No video can be made without it. Nothing to do.",
    };
    const BROKEN = {
      ...DONE,
      id: "f1",
      setTitle: "Broken Set",
      status: "failed",
      videoId: null,
      error: "too many attempts",
      outcome: "failed",
      outcomeLine: null,
      outcomeDetail: null,
    };
    const DUP = {
      ...DONE,
      id: "x1",
      setTitle: "Dup Set",
      status: "superseded",
      videoId: null,
      error: "duplicate of the same 1001tracklists id under another URL",
      outcome: "duplicate",
      outcomeLine: null,
      outcomeDetail: null,
    };
    const counts = {
      done: 0,
      failed: 1,
      recording_removed: 1,
      recording_short: 0,
      has_recording: 0,
      duplicate: 1,
      superseded: 0,
      banned: 0,
    };
    const { get, calls } = page((url) => {
      if (url.startsWith("/ui/api/mkvid/finished?"))
        return Response.json({ ...tableOf([GONE, BROKEN, DUP]), counts });
      if (url === "/ui/api/mkvid")
        return Response.json(
          header({
            counts: { pending: 2, claimed: 1, done: 1, failed: 2, superseded: 1, banned: 0 },
            outcomes: counts,
          }),
        );
      return answers(url);
    });
    await settle();
    const fin = get("fin-body").innerHTML as string;
    expect(fin).toContain(
      '<span class="badge neutral" data-tip="' +
        line.replace(/"/g, "&quot;") +
        ' No video can be made without it. Nothing to do.">recording removed</span>',
    );
    expect(fin).toContain(">duplicate</span>");
    // One red badge, one red row, one red error text: the real failure only.
    expect(fin.match(/class="badge bad"/g)).toHaveLength(1);
    expect(fin.match(/mk-failed/g)).toHaveLength(1);
    expect(fin.match(/class="flag"/g)).toHaveLength(1);
    expect(fin).toContain('<span class="flag">too many attempts</span>');
    expect(fin).toContain(">" + line.replace(/"/g, "&quot;") + "</span>");
    expect(fin).toContain("mkvid said: probe: yt-dlp exit 1");
    // The header counts real failures only.
    expect(get("mk-tiles").innerHTML).toContain('<div class="s">1 failed</div>');
    const summary = get("mk-summary").innerHTML as string;
    expect(summary).toContain('<span class="warn">1 failed</span>');
    expect(summary).toContain(">1 without a usable recording</span>");
    // A chip per outcome, with the whole list's count; it filters on the server.
    const chips = get("fin-chips").innerHTML as string;
    expect(chips).toMatch(/data-chip="removed"[^>]*>Recording removed<span class="tkt-count">1</);
    expect(chips).toMatch(/data-chip="failed"[^>]*>Failed<span class="tkt-count">1</);
    expect(chips).toMatch(/data-chip="short"[^>]*>Recording too short<span class="tkt-count">0</);
    get("mk-settled").on.click(ctlClick({ "data-tkt": "chip", "data-chip": "removed" }));
    await settle();
    expect(gets(calls).at(-1)).toBe(
      "/ui/api/mkvid/finished?page=1&size=25&sort=-updatedAt&f.status=in:recording_removed",
    );
    get("mk-settled").on.click(ctlClick({ "data-tkt": "chip", "data-chip": "superseded" }));
    await settle();
    expect(gets(calls).at(-1)).toBe(
      "/ui/api/mkvid/finished?page=1&size=25&sort=-updatedAt&f.status=in:has_recording|duplicate|superseded",
    );
    // The details say it in plain words and keep mkvid's own text.
    get("mk-settled").on.click(rowClick(0));
    const body = get("tk-drawer-body").innerHTML as string;
    expect(body).toContain(">recording removed</span> " + line.replace(/"/g, "&quot;"));
    expect(body).toContain('<dt>mkvid said</dt><dd><span class="when">probe: yt-dlp exit 1');
    expect(body).toContain("It only helps if the recording is back.");
  });

  it("several removals within a day are red, under a banner with the two answers", async () => {
    const said =
      "probe: yt-dlp exit 1: ERROR: [soundcloud] 77: Unable to download JSON metadata: HTTP Error 404: Not Found";
    const line =
      'The recording looks gone from SoundCloud (the link answers "not found"), but so did several others within a day.';
    const UNSURE = (id: string) => ({
      ...DONE,
      id,
      setTitle: "Unsure " + id,
      status: "failed",
      videoId: null,
      error: said,
      outcome: "removed_unconfirmed",
      outcomeLine: line,
      outcomeDetail: line + " Choose on the mkvid page.",
    });
    const counts = {
      done: 0,
      failed: 0,
      removed_unconfirmed: 3,
      recording_removed: 1,
      recording_short: 0,
      has_recording: 0,
      duplicate: 0,
      superseded: 0,
      banned: 0,
    };
    let burst: unknown = { since: NOW - 7200, count: 3, sources: { soundcloud: 3 }, threshold: 3 };
    const { get, calls } = page((url, init) => {
      if (init?.method === "POST") {
        burst = null;
        return Response.json({ ok: true });
      }
      if (url.startsWith("/ui/api/mkvid/finished?"))
        return Response.json({ ...tableOf([UNSURE("u1"), UNSURE("u2"), UNSURE("u3")]), counts });
      if (url === "/ui/api/mkvid")
        return Response.json(
          header({
            counts: { pending: 2, claimed: 1, done: 1, failed: 4, superseded: 0, banned: 0 },
            outcomes: counts,
            removedBurst: burst,
          }),
        );
      return answers(url);
    });
    await settle();
    const banner = get("mk-burst");
    expect(banner.hidden).toBe(false);
    expect(banner.innerHTML).toContain(
      "<strong>3 recordings are marked removed, unconfirmed.</strong>",
    );
    expect(banner.innerHTML).toContain(
      '3 or more came back "not found" within a day (the first 2h ago).',
    );
    expect(banner.innerHTML).toContain(
      "may mean SoundCloud or the downloader is broken, not that they were deleted",
    );
    expect(banner.innerHTML).toMatch(/data-burst="retry"[^>]*>Try them again</);
    expect(banner.innerHTML).toMatch(/data-burst="confirm"[^>]*>They are really gone</);
    // Red rows, red badges, the plain line in red; counted in the header and in the Problems chip.
    const fin = get("fin-body").innerHTML as string;
    expect(fin.match(/class="badge bad"/g)).toHaveLength(3);
    expect(fin.match(/mk-failed/g)).toHaveLength(3);
    expect(fin).toContain(">removed, unconfirmed</span>");
    expect(fin).toContain(">" + line.replace(/"/g, "&quot;") + "</span>");
    expect(get("mk-tiles").innerHTML).toContain('<div class="s">3 unconfirmed</div>');
    expect(get("mk-summary").innerHTML).toMatch(
      /<span class="warn"[^>]*>3 removed, unconfirmed<\/span>/,
    );
    expect(get("mk-summary").innerHTML).toContain(">1 without a usable recording</span>");
    const chips = get("fin-chips").innerHTML as string;
    expect(chips).toMatch(/data-chip="problems"[^>]*>Problems<span class="tkt-count">3</);
    expect(chips).toMatch(
      /data-chip="unconfirmed"[^>]*>Removed, unconfirmed<span class="tkt-count">3</,
    );
    expect(chips).toMatch(/data-chip="removed"[^>]*>Recording removed<span class="tkt-count">1</);

    const press = (what: string) => {
      const btn = {
        getAttribute: (k: string) => (k === "data-burst" ? what : null),
        textContent: "x",
        disabled: false,
      };
      return { target: { closest: (sel: string) => (sel === "button[data-burst]" ? btn : null) } };
    };
    // "Show them" filters the Finished tab; it changes nothing.
    await banner.on.click(press("show"));
    await settle();
    expect(gets(calls).at(-1)).toBe(
      "/ui/api/mkvid/finished?page=1&size=25&sort=-updatedAt&f.status=in:removed_unconfirmed",
    );
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    // "They are really gone" posts the answer and reloads: the banner is gone.
    await banner.on.click(press("confirm"));
    await settle();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([
      "/ui/api/mkvid/removed-burst/confirm",
    ]);
    expect(banner.hidden).toBe(true);
    expect(banner.innerHTML).toBe("");

    // "Try them again" posts the other answer. A page without a burst shows no banner.
    burst = { since: NOW - 7200, count: 1, sources: { soundcloud: 1, hearthis: 0 }, threshold: 3 };
    const again = page((url, init) => {
      if (init?.method === "POST") return Response.json({ ok: true });
      if (url === "/ui/api/mkvid") return Response.json(header({ removedBurst: burst }));
      return answers(url);
    });
    await settle();
    expect(again.get("mk-burst").innerHTML).toContain(
      "<strong>1 recording is marked removed, unconfirmed.</strong>",
    );
    await again.get("mk-burst").on.click(press("retry"));
    await settle();
    expect(again.calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([
      "/ui/api/mkvid/removed-burst/retry",
    ]);
    const none = page((url) => answers(url));
    await settle();
    expect(none.get("mk-burst").hidden).toBe(true);
  });

  it("the queue has a Status column and a chip per waiting state, filtered on the server", async () => {
    const counts = { unverified: 4, untimed: 1, waiting_ids: 2, backoff: 0, ready: 3 };
    const { get, calls } = page((url) =>
      url.startsWith("/ui/api/mkvid/queue?")
        ? Response.json({
            ...tableOf([
              WAITING("r3", 7),
              WAITING("r4", 8, { readiness: { state: "unverified" }, error: "yt-dlp exit 1" }),
            ]),
            counts,
          })
        : answers(url),
    );
    await settle();
    expect(get("q-head").innerHTML).toContain("Status");
    const q = get("q-body").innerHTML as string;
    expect(q).toContain("waiting for IDs until");
    expect(q).toContain(">not verified</span>");
    // Amber with its age: a waiting request's last error is retried by itself, not something to act on.
    expect(q).toMatch(/<span class="retry">last attempt( \([^)]*\))?: yt-dlp exit 1<\/span>/);
    expect(q).not.toContain('<span class="flag">last attempt');
    const chips = get("q-chips").innerHTML as string;
    expect(chips).toMatch(/data-chip="all"[^>]*>All<span class="tkt-count">10</);
    expect(chips).toMatch(/data-chip="unverified"[^>]*>Not verified<span class="tkt-count">4</);
    expect(chips).toMatch(/data-chip="ids"[^>]*>Waiting for IDs<span class="tkt-count">2</);
    get("mk-queue").on.click(ctlClick({ "data-tkt": "chip", "data-chip": "ids" }));
    await settle();
    expect(gets(calls).at(-1)).toBe(
      "/ui/api/mkvid/queue?page=1&size=25&sort=position&f.status=in:waiting_ids",
    );
  });
});

describe("mkvid page: a filter that empties one tab", () => {
  it("says how many sets match in the other tab and opens it with the same filters and search", async () => {
    const pre2020 = { ...DONE, id: "r7", setTitle: "FISHER @ neonGARDEN", setDate: "2019-05-17" };
    const { get, calls } = page((url) => {
      if (url.startsWith("/ui/api/mkvid/queue?") && url.includes("f.setDate"))
        return Response.json(tableOf([]));
      if (url.startsWith("/ui/api/mkvid/finished?") && url.includes("f.setDate"))
        return Response.json(tableOf([pre2020]));
      return answers(url);
    }, "?q.f.setDate=before%3A2020-01-01");
    await settle();
    expect(gets(calls)).toContain("/ui/api/mkvid/finished?size=10&f.setDate=before:2020-01-01");
    expect(get("q-empty").innerHTML).toContain("1 finished set matches in the Finished tab.");
    const btn = { getAttribute: (k: string) => (k === "data-mk-cross" ? "queue" : null) };
    get("mk-p-queue").on.click({
      preventDefault() {},
      target: { closest: (sel: string) => (sel === "[data-mk-cross]" ? btn : null) },
    });
    await settle();
    expect(get("mk-p-settled").hidden).toBe(false);
    expect(gets(calls).at(-1)).toBe(
      "/ui/api/mkvid/finished?page=1&size=25&sort=-updatedAt&f.setDate=before:2020-01-01",
    );
    expect(get("fin-body").innerHTML).toContain("FISHER @ neonGARDEN");
  });

  it("no hint without a filter or search", async () => {
    const { get, calls } = page((url) =>
      url.startsWith("/ui/api/mkvid/queue?") ? Response.json(tableOf([])) : answers(url),
    );
    await settle();
    expect(gets(calls).some((u) => u.includes("size=10"))).toBe(false);
    expect(get("q-empty").innerHTML).not.toContain("mk-cross");
  });
});
